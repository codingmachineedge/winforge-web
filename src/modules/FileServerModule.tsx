import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { StatusDot } from './common';

// ============================================================================
// File Server (FTP/SFTP host) — module.fileserver
//
// Native port of WinForge's FileServerModule. The desktop original hosts one of
// your folders out over SFTP (atmoz/sftp) or FTP/FTPS (delfer/alpine-ftp-server)
// by driving Docker through the managed DockerService; each share runs on its
// own auto-picked host port so several can run at once, and passwords are
// DPAPI-protected on disk.
//
// In winforge-web the live path is the docker CLI (same local daemon every
// Docker Desktop / Engine install ships with), driven through the native
// backend. We reproduce the exact container recipes from FileServerService:
//   sftp: atmoz/sftp                 cmd `user:pass:1001`, folder → /home/<u>/share, port :22
//   ftp : delfer/alpine-ftp-server   USERS/ADDRESS/MIN_PORT/MAX_PORT env, folder → /ftp/<u>, port :21 + passive range
//
// Share DEFINITIONS (name/folder/protocol/user/port/passive base) persist in
// localStorage. Passwords are NEVER written to disk here (localStorage has no
// DPAPI); they are held in memory for the session and re-entered on next launch
// before starting — the safe web equivalent. Removing a share stops+deletes its
// container but never touches the hosted folder's contents. Remove is gated
// behind an explicit confirm and never auto-runs.
// ============================================================================

type Protocol = 'sftp' | 'ftp';

interface Share {
  id: string;
  name: string;
  folderPath: string;
  protocol: Protocol;
  username: string;
  port: number;
  pasvBase: number;
}

const STORE_KEY = 'winforge.fileserver.shares';

function projectName(s: Share): string {
  return `wf_fileshare_${s.id}`;
}

function loadShares(): Share[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Share =>
        !!s && typeof s === 'object' && 'id' in s && 'folderPath' in s,
    );
  } catch {
    return [];
  }
}

function saveShares(list: Share[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 8);
}

/** Run one `docker …` command; returns raw output (never throws). */
async function docker(args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const res = await runCommand('docker', args);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.success };
}

export function FileServerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // ── persisted share definitions + in-memory secrets ───────────────────────
  const [shares, setShares] = useState<Share[]>(() => loadShares());
  // id → password held only for this session (never persisted)
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // ids currently running (from docker ps)
  const [running, setRunning] = useState<Set<string>>(new Set());

  // environment
  const [lanIp, setLanIp] = useState('127.0.0.1');
  const [dockerOk, setDockerOk] = useState<boolean | null>(null);

  // new-share draft form
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('sftp');
  const [user, setUser] = useState('user');
  const [password, setPassword] = useState('');
  const [autoPort, setAutoPort] = useState(true);
  const [port, setPort] = useState('');

  // ui state
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [output, setOutput] = useState('');
  // id → password prompt when starting a share with no in-session secret
  const [pwPrompt, setPwPrompt] = useState<Record<string, string>>({});

  const persist = useCallback((list: Share[]) => {
    setShares(list);
    saveShares(list);
  }, []);

  const log = useCallback((line: string) => {
    setOutput((prev) => (prev ? `${prev}\n${line}` : line));
  }, []);

  // ── environment probes: LAN IPv4, docker reachability, running containers ──
  const probeEnv = useCallback(async () => {
    if (!desktop) {
      setDockerOk(false);
      return;
    }
    // LAN IPv4 — first Up, non-loopback IPv4 with a default gateway (mirrors LanIPv4).
    try {
      const res = await runPowershell(
        "$a=Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1 -ExpandProperty IPv4Address; if($a){$a.IPAddress}else{'127.0.0.1'}",
      );
      const ip = res.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (ip) setLanIp(ip);
    } catch {
      /* keep default */
    }
    // Docker reachable?
    try {
      const v = await docker(['version', '--format', '{{.Server.Version}}']);
      setDockerOk(v.ok && !!v.stdout.trim());
    } catch {
      setDockerOk(false);
    }
    // Which of our shares are running right now?
    try {
      const ps = await docker(['ps', '--filter', 'name=wf_fileshare_', '--format', '{{.Names}}']);
      const names = ps.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const live = new Set<string>();
      for (const s of loadShares()) {
        if (names.some((n) => n.includes(projectName(s)))) live.add(s.id);
      }
      setRunning(live);
    } catch {
      /* ignore */
    }
  }, [desktop]);

  useEffect(() => {
    void probeEnv();
  }, [probeEnv]);

  // ── free-port helper (PowerShell; mirrors FindFreePort) ────────────────────
  const findFreePort = useCallback(async (start: number): Promise<number> => {
    try {
      const res = await runPowershell(
        `$used=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort); for($p=${start}; $p -lt ${start + 2000}; $p++){ if($used -notcontains $p){ $p; break } }`,
      );
      const p = parseInt(res.stdout.trim(), 10);
      if (p > 0) return p;
    } catch {
      /* fall through */
    }
    // fallback: deterministic offset if PowerShell is unavailable
    return start + Math.floor(Math.random() * 200);
  }, []);

  // ── connection string (mirrors ConnectionString) ──────────────────────────
  const connString = useCallback(
    (s: Share): string =>
      s.protocol === 'ftp'
        ? `ftp://${s.username}@${lanIp}:${s.port}/`
        : `sftp://${s.username}@${lanIp}:${s.port}/`,
    [lanIp],
  );

  // ── add a share definition ─────────────────────────────────────────────────
  const addShare = async () => {
    if (!folder.trim()) {
      setMsg({ ok: false, text: t('fileserver.needFolder') });
      return;
    }
    if (!password) {
      setMsg({ ok: false, text: t('fileserver.needPassword') });
      return;
    }
    setBusy('add');
    setMsg(null);
    try {
      let chosen = autoPort ? 0 : parseInt(port, 10) || 0;
      if (chosen <= 0) chosen = await findFreePort(protocol === 'ftp' ? 2121 : 2222);
      const pasvBase = protocol === 'ftp' ? await findFreePort(21000) : 21000;
      const share: Share = {
        id: newId(),
        name: name.trim() || t('fileserver.defaultName'),
        folderPath: folder.trim(),
        protocol,
        username: user.trim() || 'user',
        port: chosen,
        pasvBase,
      };
      persist([...shares, share]);
      setSecrets((prev) => ({ ...prev, [share.id]: password }));
      setName('');
      setFolder('');
      setPassword('');
      setPort('');
      setMsg({ ok: true, text: t('fileserver.added', { name: share.name }) });
    } catch (e) {
      setMsg({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  };

  // ── build the `docker run` argv for a share (mirrors BuildProject) ─────────
  const runArgs = (s: Share, pwd: string): string[] => {
    const args = ['run', '-d', '--name', projectName(s), '--restart', 'unless-stopped'];
    if (s.protocol === 'ftp') {
      args.push(
        '-e', `USERS=${s.username}|${pwd}|/ftp/${s.username}|1000`,
        '-e', `ADDRESS=${lanIp}`,
        '-e', `MIN_PORT=${s.pasvBase}`,
        '-e', `MAX_PORT=${s.pasvBase + 10}`,
        '-v', `${s.folderPath}:/ftp/${s.username}`,
        '-p', `${s.port}:21`,
      );
      for (let p = s.pasvBase; p <= s.pasvBase + 10; p++) args.push('-p', `${p}:${p}`);
      args.push('delfer/alpine-ftp-server:latest');
    } else {
      args.push(
        '-v', `${s.folderPath}:/home/${s.username}/share`,
        '-p', `${s.port}:22`,
        'atmoz/sftp:latest',
        `${s.username}:${pwd}:1001`,
      );
    }
    return args;
  };

  // ── start / stop / remove ──────────────────────────────────────────────────
  const startShare = async (s: Share) => {
    if (!desktop) return;
    const pwd = secrets[s.id] ?? pwPrompt[s.id] ?? '';
    if (!pwd) {
      setMsg({ ok: false, text: t('fileserver.enterPwToStart') });
      return;
    }
    setBusy(`start:${s.id}`);
    setMsg(null);
    log(`$ docker run … ${projectName(s)}`);
    try {
      // clear any stale container with the same name, then run fresh
      await docker(['rm', '-f', projectName(s)]);
      const res = await docker(runArgs(s, pwd));
      if (!res.ok) throw new Error(res.stderr.trim() || t('fileserver.dockerFailed'));
      setSecrets((prev) => ({ ...prev, [s.id]: pwd }));
      setPwPrompt((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
      if (res.stdout.trim()) log(res.stdout.trim().slice(0, 12));
      setMsg({ ok: true, text: t('fileserver.started', { name: s.name, conn: connString(s) }) });
    } catch (e) {
      const text = String(e instanceof Error ? e.message : e);
      log(text);
      setMsg({ ok: false, text });
    } finally {
      setBusy(null);
      await probeEnv();
    }
  };

  const stopShare = async (s: Share) => {
    if (!desktop) return;
    setBusy(`stop:${s.id}`);
    setMsg(null);
    log(`$ docker stop ${projectName(s)}`);
    try {
      const res = await docker(['rm', '-f', projectName(s)]);
      if (!res.ok && !res.stderr.toLowerCase().includes('no such')) {
        throw new Error(res.stderr.trim() || t('fileserver.dockerFailed'));
      }
      setMsg({ ok: true, text: t('fileserver.stopped', { name: s.name }) });
    } catch (e) {
      const text = String(e instanceof Error ? e.message : e);
      log(text);
      setMsg({ ok: false, text });
    } finally {
      setBusy(null);
      await probeEnv();
    }
  };

  const removeShare = async (s: Share) => {
    if (!window.confirm(t('fileserver.confirmRemove', { name: s.name }))) return;
    setBusy(`remove:${s.id}`);
    setMsg(null);
    try {
      if (desktop) {
        log(`$ docker rm -f ${projectName(s)}`);
        await docker(['rm', '-f', projectName(s)]);
      }
      persist(shares.filter((x) => x.id !== s.id));
      setSecrets((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
      setMsg({ ok: true, text: t('fileserver.removed', { name: s.name }) });
    } catch (e) {
      setMsg({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
      await probeEnv();
    }
  };

  const copyConn = async (s: Share) => {
    const conn = connString(s);
    try {
      await navigator.clipboard.writeText(conn);
      setMsg({ ok: true, text: t('fileserver.copied', { conn }) });
    } catch {
      setMsg({ ok: true, text: conn });
    }
  };

  const runningCount = useMemo(() => running.size, [running]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('fileserver.blurb')}
      </p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('fileserver.desktopOnly')}
        </p>
      )}

      {desktop && dockerOk === false && (
        <pre className="cmd-out error">{t('fileserver.dockerDown')}</pre>
      )}

      {/* ── security notice (mirrors SecurityBar) ── */}
      <div className="panel">
        <strong>{t('fileserver.securityTitle')}</strong>
        <p className="count-note" style={{ marginTop: 4 }}>
          {t('fileserver.securityBody')}
        </p>
      </div>

      {/* ── new share form ── */}
      <div className="panel">
        <strong>{t('fileserver.newTitle')}</strong>
        <p className="count-note" style={{ marginTop: 4 }}>
          {t('fileserver.newDesc')}
        </p>
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('fileserver.nameLabel')}</span>
            <input
              className="mod-search"
              style={{ flex: 1 }}
              value={name}
              placeholder={t('fileserver.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="kv-row">
            <span className="label">{t('fileserver.folderLabel')}</span>
            <input
              className="mod-search"
              style={{ flex: 1 }}
              value={folder}
              placeholder="C:\\Users\\me\\Share"
              onChange={(e) => setFolder(e.target.value)}
            />
          </div>
          <div className="kv-row">
            <span className="label">{t('fileserver.protoLabel')}</span>
            <select
              className="mod-select"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value === 'ftp' ? 'ftp' : 'sftp')}
            >
              <option value="sftp">{t('fileserver.protoSftp')}</option>
              <option value="ftp">{t('fileserver.protoFtp')}</option>
            </select>
          </div>
          <div className="kv-row">
            <span className="label">{t('fileserver.loginLabel')}</span>
            <input
              className="mod-search"
              style={{ maxWidth: 160 }}
              value={user}
              placeholder={t('fileserver.userPlaceholder')}
              onChange={(e) => setUser(e.target.value)}
            />
            <input
              className="mod-search"
              type="password"
              style={{ flex: 1 }}
              value={password}
              placeholder={t('fileserver.pwPlaceholder')}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="kv-row">
            <span className="label">{t('fileserver.portLabel')}</span>
            <input
              className="mod-search"
              type="number"
              style={{ maxWidth: 140 }}
              value={port}
              disabled={autoPort}
              min={1}
              max={65535}
              onChange={(e) => setPort(e.target.value)}
            />
            <label
              className="count-note"
              style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}
            >
              <input
                type="checkbox"
                checked={autoPort}
                onChange={(e) => setAutoPort(e.target.checked)}
              />
              {t('fileserver.autoPort')}
            </label>
          </div>
        </div>
        <div className="mod-toolbar">
          <button
            className="mini primary"
            disabled={busy === 'add' || !folder.trim() || !password}
            onClick={addShare}
          >
            {busy === 'add' ? '…' : t('fileserver.addShare')}
          </button>
        </div>
      </div>

      {msg && (
        <p className="mod-msg" style={msg.ok ? undefined : { color: 'var(--danger)' }}>
          {msg.text}
        </p>
      )}

      {/* ── hosted shares ── */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <strong>{t('fileserver.sharesTitle')}</strong>
        <button className="mini" onClick={() => void probeEnv()}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {t('fileserver.count', { total: shares.length, running: runningCount })}
        </span>
      </div>

      {shares.length === 0 ? (
        <p className="count-note">{t('fileserver.empty')}</p>
      ) : (
        shares.map((s) => {
          const live = running.has(s.id);
          const b = (v: string) => busy === `${v}:${s.id}`;
          const needsPw = !secrets[s.id];
          return (
            <div className="panel" key={s.id} style={{ marginBottom: 10 }}>
              <div className="mod-toolbar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {s.name}{' '}
                    <span className="count-note" style={{ margin: 0 }}>
                      {s.protocol.toUpperCase()}
                    </span>
                  </div>
                  <div className="count-note" style={{ margin: 0 }}>
                    {s.folderPath}
                  </div>
                </div>
                <StatusDot
                  ok={live}
                  label={live ? t('fileserver.stRunning') : t('fileserver.stStopped')}
                />
              </div>

              <pre className="cmd-out" style={{ margin: '6px 0' }}>
                {connString(s)}
              </pre>

              {needsPw && !live && (
                <div className="kv-row" style={{ marginBottom: 6 }}>
                  <span className="label">{t('fileserver.pwPlaceholder')}</span>
                  <input
                    className="mod-search"
                    type="password"
                    style={{ flex: 1 }}
                    value={pwPrompt[s.id] ?? ''}
                    placeholder={t('fileserver.reenterPw')}
                    onChange={(e) =>
                      setPwPrompt((prev) => ({ ...prev, [s.id]: e.target.value }))
                    }
                  />
                </div>
              )}

              <span className="row-actions">
                {live ? (
                  <button className="mini" disabled={!desktop || !!busy} onClick={() => stopShare(s)}>
                    {b('stop') ? '…' : t('fileserver.stop')}
                  </button>
                ) : (
                  <button
                    className="mini primary"
                    disabled={!desktop || !!busy || (needsPw && !(pwPrompt[s.id] ?? '').trim())}
                    onClick={() => startShare(s)}
                  >
                    {b('start') ? '…' : t('fileserver.start')}
                  </button>
                )}
                <button className="mini" disabled={!!busy} onClick={() => copyConn(s)}>
                  {t('fileserver.copy')}
                </button>
                <button className="mini danger" disabled={!!busy} onClick={() => removeShare(s)}>
                  {b('remove') ? '…' : t('fileserver.remove')}
                </button>
              </span>
            </div>
          );
        })
      )}

      {/* ── output log (mirrors OutputText) ── */}
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
          <strong>{t('fileserver.outputTitle')}</strong>
          {output && (
            <button className="mini" onClick={() => setOutput('')}>
              {t('fileserver.clear')}
            </button>
          )}
        </div>
        <pre className="cmd-out" style={{ minHeight: 100, maxHeight: 220, overflow: 'auto' }}>
          {output || t('fileserver.outputHint')}
        </pre>
      </div>
    </div>
  );
}
