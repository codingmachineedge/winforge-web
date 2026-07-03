import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, type CommandOutput } from '../tauri/bridge';
// CommandOutput is used as the runRemote return type below.
import { Column, DataTable, StatusDot } from './common';
import { DependencyGate } from './DependencyGate';

// ============================================================================
// Docker over SSH (module.dockerssh) — native port of WinForge's DockerSshModule.
//
// The desktop original connected with SSH.NET and ran the docker CLI on the
// REMOTE host: list/start/stop/restart/pause/remove containers, view logs, and
// exec a command. There is nothing to install locally — docker runs remotely.
//
// On the web we drive the Windows OpenSSH client (ssh.exe, which ships with
// Windows 11) through the native backend, mirroring SshModule.tsx:
//   ssh -o BatchMode=yes user@host "<docker …>"
// Profiles (host / user / port / key) live in localStorage. Password auth needs
// a key or agent set up beforehand (BatchMode disables interactive prompts),
// exactly as SshModule does. Every action is guarded and never throws.
// ============================================================================

type AuthKind = 'password' | 'key';

interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthKind;
  keyPath: string;
}

interface Container {
  Id: string;
  Name: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
}

interface HostInfo {
  present: boolean;
  serverVersion: string;
  osArch: string;
  containers: number;
  running: number;
  rawError: string;
}

const STORE_KEY = 'winforge.dockerssh.profiles';
// ASCII unit separator — the stable column delimiter the C# service uses.
const DELIM = '';

function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is Profile => !!p && typeof p === 'object' && 'id' in p);
  } catch {
    return [];
  }
}

function saveProfiles(list: Profile[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

function newProfile(name: string): Profile {
  return {
    id: `d${Date.now()}${Math.floor(Math.random() * 1000)}`,
    name,
    host: '',
    port: 22,
    user: '',
    auth: 'password',
    keyPath: '',
  };
}

/** Build the ssh.exe argument list for a profile plus a remote command. */
function sshArgs(p: Profile, command: string): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(p.port > 0 ? p.port : 22),
  ];
  if (p.auth === 'key' && p.keyPath.trim()) {
    args.push('-i', p.keyPath.trim());
  }
  args.push(`${p.user}@${p.host}`, command);
  return args;
}

/** Single-quote a token for the remote POSIX shell (matches DockerSshService.Q). */
function q(token: string): string {
  return "'" + (token ?? '').replace(/'/g, "'\\''") + "'";
}

function shortId(id: string): string {
  const t = (id ?? '').trim();
  return t.length > 12 ? t.slice(0, 12) : t;
}

export function DockerSshModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<Profile>(() => newProfile(''));
  const [remember, setRemember] = useState(false);

  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [rows, setRows] = useState<Container[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // detail / log pane
  const [selCid, setSelCid] = useState('');
  const [tail, setTail] = useState(200);
  const [execCmd, setExecCmd] = useState('');
  const [log, setLog] = useState('');

  const active: Profile | null = draft.host.trim() && draft.user.trim() ? draft : null;
  const selContainer = useMemo(() => rows.find((r) => r.Id === selCid) ?? null, [rows, selCid]);

  const persist = (list: Profile[]) => {
    setProfiles(list);
    saveProfiles(list);
  };

  const selectProfile = (p: Profile) => {
    setSelectedId(p.id);
    setDraft({ ...p });
    setErr('');
  };

  const startNew = () => {
    setSelectedId('');
    setDraft(newProfile(''));
    setErr('');
  };

  const removeProfile = () => {
    if (!selectedId) return;
    persist(profiles.filter((p) => p.id !== selectedId));
    startNew();
  };

  const saveProfileIfRemember = (p: Profile) => {
    if (!remember) return;
    const named: Profile = { ...p, name: p.name.trim() || `${p.user}@${p.host}` };
    const exists = profiles.some((x) => x.id === named.id);
    const list = exists ? profiles.map((x) => (x.id === named.id ? named : x)) : [...profiles, named];
    persist(list);
    setSelectedId(named.id);
    setDraft(named);
  };

  // ── run one remote docker command ─────────────────────────────────────────
  const runRemote = async (command: string): Promise<CommandOutput> => {
    if (!active) throw new Error(t('dockerssh.errHostUser'));
    return runCommand('ssh', sshArgs(active, command));
  };

  // ── connect / probe ───────────────────────────────────────────────────────
  const connect = async () => {
    if (!desktop) return;
    if (!active) {
      setErr(t('dockerssh.errHostUser'));
      return;
    }
    setErr('');
    setMsg('');
    setBusy('connect');
    try {
      saveProfileIfRemember(active);
      // Probe docker presence + a small header summary, matching ProbeAsync.
      const probe =
        "docker version --format '{{.Server.Version}}|{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null; " +
        "echo '###'; " +
        "docker info --format '{{.Containers}}|{{.ContainersRunning}}' 2>/dev/null; " +
        "echo '###'; command -v docker >/dev/null 2>&1 && echo HAVE || echo NONE";
      const res = await runRemote(probe);
      const parts = res.stdout.split('###');
      const verLine = (parts[0] ?? '').trim();
      const infoLine = (parts[1] ?? '').trim();
      const have = (parts[2] ?? '').trim();

      const vbits = verLine.split('|');
      const ver = (vbits[0] ?? '').trim();
      const osArch = (vbits[1] ?? '').trim();
      const ibits = infoLine.split('|');
      const containers = parseInt((ibits[0] ?? '').trim(), 10) || 0;
      const running = parseInt((ibits[1] ?? '').trim(), 10) || 0;

      const present = have.includes('HAVE') || ver.length > 0;
      const nextInfo: HostInfo = {
        present,
        serverVersion: ver,
        osArch,
        containers,
        running,
        rawError: ver ? '' : res.stderr.trim(),
      };
      setInfo(nextInfo);

      if (!present) {
        setConnected(false);
        setRows([]);
        setErr(
          nextInfo.rawError
            ? t('dockerssh.connectedNoDockerRaw', { error: nextInfo.rawError })
            : t('dockerssh.connectedNoDocker'),
        );
        return;
      }
      setConnected(true);
      setMsg(t('dockerssh.connected'));
      await refresh(true);
    } catch (e) {
      setConnected(false);
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const disconnect = () => {
    setConnected(false);
    setInfo(null);
    setRows([]);
    setSelCid('');
    setLog('');
    setMsg(t('dockerssh.disconnected'));
    setErr('');
  };

  // ── list containers ───────────────────────────────────────────────────────
  const refresh = async (quiet = false) => {
    if (!desktop || !active) return;
    if (!quiet) setBusy('refresh');
    try {
      const fmt =
        `{{.ID}}${DELIM}{{.Names}}${DELIM}{{.Image}}${DELIM}{{.State}}${DELIM}{{.Status}}${DELIM}{{.Ports}}`;
      const res = await runRemote(`docker ps -a --no-trunc --format ${q(fmt)}`);
      if (!res.success && !res.stdout.trim()) {
        setErr(t('dockerssh.listFailed', { error: res.stderr.trim() || `exit ${res.code}` }));
        return;
      }
      const parsed: Container[] = [];
      for (const raw of res.stdout.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        const f = line.split(DELIM);
        if (f.length < 6) continue;
        parsed.push({
          Id: shortId(f[0] ?? ''),
          Name: (f[1] ?? '').trim(),
          Image: (f[2] ?? '').trim(),
          State: (f[3] ?? '').trim(),
          Status: (f[4] ?? '').trim(),
          Ports: (f[5] ?? '').trim(),
        });
      }
      setRows(parsed);
      if (selCid && !parsed.some((r) => r.Id === selCid)) setSelCid('');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      if (!quiet) setBusy('');
    }
  };

  const isRunning = (c: Container) => c.State.toLowerCase() === 'running';
  const isPaused = (c: Container) => c.State.toLowerCase() === 'paused';

  // ── power actions ─────────────────────────────────────────────────────────
  const act = async (
    c: Container,
    verb: string,
    dockerCmd: string,
    labelKey: string,
  ) => {
    if (!desktop || !active) return;
    setBusy(`${verb}:${c.Id}`);
    setMsg('');
    setErr('');
    try {
      const res = await runRemote(`docker ${dockerCmd} ${q(c.Id)}`);
      if (!res.success) {
        setErr(t('dockerssh.actionFailed', { verb: t(labelKey), error: res.stderr.trim() || `exit ${res.code}` }));
      } else {
        setMsg(t('dockerssh.actionDone', { verb: t(labelKey) }));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
      await refresh(true);
    }
  };

  const removeContainer = async (c: Container) => {
    if (!confirm(t('dockerssh.removeConfirm', { name: c.Name || c.Id }))) return;
    await act(c, 'remove', 'rm -f', 'dockerssh.remove');
  };

  const pauseToggle = async (c: Container) => {
    if (isPaused(c)) await act(c, 'unpause', 'unpause', 'dockerssh.unpause');
    else await act(c, 'pause', 'pause', 'dockerssh.pause');
  };

  // ── logs / exec ───────────────────────────────────────────────────────────
  const loadLogs = async (c: Container) => {
    if (!desktop || !active) return;
    setSelCid(c.Id);
    setBusy('logs');
    setLog(t('dockerssh.loadingLogs'));
    try {
      const n = Math.max(10, tail || 200);
      const res = await runRemote(`docker logs --tail ${n} ${q(c.Id)} 2>&1`);
      const body = (res.stdout.trim() ? res.stdout : res.stderr).replace(/\r\n/g, '\n').trimEnd();
      setLog(body || t('dockerssh.noLogOutput'));
    } catch (e) {
      setLog(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const runExec = async () => {
    const c = selContainer;
    const command = execCmd.trim();
    if (!desktop || !active || !c || !command) return;
    setBusy('exec');
    setLog(`$ ${command}\n${t('dockerssh.running')}`);
    try {
      const inner = command.replace(/'/g, "'\\''");
      const res = await runRemote(`docker exec ${q(c.Id)} sh -c '${inner}' 2>&1`);
      const body = (res.stdout.trim() ? res.stdout : res.stderr).replace(/\r\n/g, '\n').trimEnd();
      setLog(`$ ${command}\n${body || t('dockerssh.noOutput')}`);
    } catch (e) {
      setLog(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ── derived rows ──────────────────────────────────────────────────────────
  const shownRows = useMemo(() => {
    const q2 = filter.trim().toLowerCase();
    const list = q2
      ? rows.filter((r) => `${r.Name} ${r.Image}`.toLowerCase().includes(q2))
      : rows;
    return list;
  }, [rows, filter]);

  const runningCount = rows.filter(isRunning).length;

  const stateLabel = (c: Container): string => {
    const key = c.State.toLowerCase();
    const map: Record<string, string> = {
      running: 'dockerssh.stRunning',
      exited: 'dockerssh.stExited',
      paused: 'dockerssh.stPaused',
      created: 'dockerssh.stCreated',
      restarting: 'dockerssh.stRestarting',
      dead: 'dockerssh.stDead',
    };
    const k = map[key];
    return k ? t(k) : c.State;
  };

  const columns: Column<Container>[] = [
    {
      key: 'State',
      header: t('dockerssh.colState'),
      width: 110,
      render: (c) => <StatusDot ok={isRunning(c)} label={stateLabel(c)} />,
    },
    {
      key: 'Name',
      header: t('dockerssh.colName'),
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{c.Name || '—'}</div>
          <div className="count-note" style={{ margin: 0 }}>
            {[c.Image, c.Id, c.Ports].filter(Boolean).join('   ·   ')}
          </div>
        </div>
      ),
    },
    { key: 'Status', header: t('dockerssh.colStatus'), width: 160 },
    {
      key: 'actions',
      header: '',
      width: 280,
      render: (c) => {
        const b = (v: string) => busy === `${v}:${c.Id}`;
        return (
          <span className="row-actions">
            {isRunning(c) ? (
              <>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => act(c, 'stop', 'stop', 'dockerssh.stop')}>
                  {b('stop') ? '…' : t('dockerssh.stop')}
                </button>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => act(c, 'restart', 'restart', 'dockerssh.restart')}>
                  {b('restart') ? '…' : t('dockerssh.restart')}
                </button>
              </>
            ) : (
              <button className="mini" disabled={!desktop || !!busy} onClick={() => act(c, 'start', 'start', 'dockerssh.start')}>
                {b('start') ? '…' : t('dockerssh.start')}
              </button>
            )}
            {(isRunning(c) || isPaused(c)) && (
              <button className="mini" disabled={!desktop || !!busy} onClick={() => pauseToggle(c)}>
                {isPaused(c) ? t('dockerssh.unpause') : t('dockerssh.pause')}
              </button>
            )}
            <button className="mini" disabled={!desktop || !!busy} onClick={() => loadLogs(c)}>
              {t('dockerssh.logs')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => removeContainer(c)}>
              {t('dockerssh.remove')}
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dockerssh.blurb')}
      </p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('dockerssh.desktopOnly')}
        </p>
      )}

      <DependencyGate tool="ssh" query="OpenSSH client">
        {() => (
          <>
            {/* ── Connection ── */}
            <div className="panel">
              <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
                <strong>{t('dockerssh.connection')}</strong>
                <StatusDot ok={connected} label={connected ? t('dockerssh.stConnected') : t('dockerssh.stNotConnected')} />
              </div>

              {profiles.length > 0 && (
                <div className="kv-row" style={{ marginBottom: 8 }}>
                  <span className="label">{t('dockerssh.savedProfile')}</span>
                  <select
                    className="mod-select"
                    value={selectedId}
                    onChange={(e) => {
                      const p = profiles.find((x) => x.id === e.target.value);
                      if (p) selectProfile(p);
                      else startNew();
                    }}
                  >
                    <option value="">{t('dockerssh.manualEntry')}</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || `${p.user}@${p.host}:${p.port}`}
                      </option>
                    ))}
                  </select>
                  <button className="mini" disabled={!selectedId} onClick={removeProfile}>
                    {t('dockerssh.deleteProfile')}
                  </button>
                </div>
              )}

              <div className="kv-list">
                <div className="kv-row">
                  <span className="label">{t('dockerssh.host')}</span>
                  <input className="mod-search" style={{ flex: 1 }} value={draft.host} placeholder="192.168.1.10 / docker.example.com" onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('dockerssh.port')}</span>
                  <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={draft.port} onChange={(e) => setDraft({ ...draft, port: +e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('dockerssh.user')}</span>
                  <input className="mod-search" value={draft.user} placeholder="root / ubuntu" onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('dockerssh.auth')}</span>
                  <select className="mod-select" value={draft.auth} onChange={(e) => setDraft({ ...draft, auth: e.target.value === 'key' ? 'key' : 'password' })}>
                    <option value="password">{t('dockerssh.authPassword')}</option>
                    <option value="key">{t('dockerssh.authKey')}</option>
                  </select>
                </div>
                {draft.auth === 'key' && (
                  <div className="kv-row">
                    <span className="label">{t('dockerssh.keyPath')}</span>
                    <input className="mod-search" style={{ flex: 1 }} value={draft.keyPath} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })} />
                  </div>
                )}
              </div>
              <p className="count-note">{t('dockerssh.authNote')}</p>
              <div className="mod-toolbar">
                <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  {t('dockerssh.saveProfile')}
                </label>
                <button className="mini primary" disabled={!desktop || !active || !!busy} onClick={connect}>
                  {busy === 'connect' ? t('dockerssh.connecting') : t('dockerssh.connect')}
                </button>
                <button className="mini" disabled={!connected} onClick={disconnect}>
                  {t('dockerssh.disconnect')}
                </button>
              </div>
            </div>

            {msg && <p className="mod-msg">{msg}</p>}
            {err && <pre className="cmd-out error">{err}</pre>}

            {info && info.present && (
              <p className="count-note">
                {t('dockerssh.footerVersion', { version: info.serverVersion || '?', osArch: info.osArch || '?' })}
              </p>
            )}

            {/* ── Toolbar ── */}
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <input
                className="mod-search"
                placeholder={t('dockerssh.filter')}
                value={filter}
                disabled={!connected}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button className="mini" disabled={!desktop || !connected || !!busy} onClick={() => refresh()}>
                ⟳ {busy === 'refresh' ? t('dockerssh.refreshing') : t('modules.refresh')}
              </button>
              <span className="count-note">
                {t('dockerssh.count', { shown: shownRows.length, running: runningCount })}
              </span>
            </div>

            {/* ── Container list + detail/log pane ── */}
            <div className="io-grid">
              <div className="panel">
                {!connected ? (
                  <p className="count-note">{t('dockerssh.emptyNotConnected')}</p>
                ) : (
                  <DataTable
                    columns={columns}
                    rows={shownRows}
                    rowKey={(c) => c.Id}
                    empty={t('dockerssh.emptyNoContainers')}
                  />
                )}
              </div>

              <div className="panel">
                <strong>{selContainer ? selContainer.Name || selContainer.Id : t('dockerssh.selectContainer')}</strong>
                {selContainer && (
                  <p className="count-note" style={{ marginTop: 4 }}>
                    {selContainer.Image}
                    <br />
                    {selContainer.Id} · {selContainer.Status}
                    {selContainer.Ports ? <><br />{selContainer.Ports}</> : null}
                  </p>
                )}
                <pre className="cmd-out" style={{ minHeight: 120, maxHeight: 320, overflow: 'auto' }}>
                  {log || t('dockerssh.logHint')}
                </pre>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <input
                    className="mod-search"
                    type="number"
                    style={{ maxWidth: 90 }}
                    title={t('dockerssh.tail')}
                    value={tail}
                    min={10}
                    max={5000}
                    onChange={(e) => setTail(+e.target.value)}
                  />
                  <button className="mini" disabled={!desktop || !selContainer || !!busy} onClick={() => selContainer && loadLogs(selContainer)}>
                    {t('dockerssh.logs')}
                  </button>
                  <input
                    className="mod-search"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder={t('dockerssh.execPlaceholder')}
                    value={execCmd}
                    disabled={!selContainer || !isRunning(selContainer)}
                    onChange={(e) => setExecCmd(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runExec()}
                  />
                  <button
                    className="mini primary"
                    disabled={!desktop || !selContainer || !isRunning(selContainer) || !execCmd.trim() || !!busy}
                    onClick={runExec}
                  >
                    {t('dockerssh.exec')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
