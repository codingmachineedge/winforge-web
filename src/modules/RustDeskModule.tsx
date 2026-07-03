import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives the unmodified rustdesk.exe CLI (--get-id, --connect,
// --view-only, --password, --install-service, --uninstall-service) and reads/writes
// the RustDesk2.toml [options] table (custom-rendezvous-server / relay / api / key).
// Wraps the AGPL binary only; nothing bundled or derived. Live actions need the
// WinForge desktop shell (Tauri) for the config-file reads/writes.

interface RdPeer {
  id: string;
  viewOnly: boolean;
}

interface ServerCfg {
  idServer: string;
  relayServer: string;
  apiServer: string;
  key: string;
}

const EMPTY_CFG: ServerCfg = { idServer: '', relayServer: '', apiServer: '', key: '' };

// Keep only alphanumerics (mirrors RustDeskService.CleanId).
const cleanId = (raw: string): string => (raw || '').replace(/[^A-Za-z0-9]/g, '');

// Group a 9-digit id as "123 456 789" for readability.
function formatId(id: string): string {
  if (id.length === 9 && /^[0-9]+$/.test(id)) {
    return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6, 9)}`;
  }
  return id;
}

// Single-quote escape for PowerShell literals.
const psEsc = (s: string): string => s.replace(/'/g, "''");

export function RustDeskModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [localId, setLocalId] = useState('');
  const [pw, setPw] = useState('');
  const [peerId, setPeerId] = useState('');
  const [viewOnly, setViewOnly] = useState(false);
  const [peers, setPeers] = useState<RdPeer[]>([]);
  const [cfg, setCfg] = useState<ServerCfg>(EMPTY_CFG);
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const clear = () => {
    setOut('');
    setMsg('');
    setErr('');
  };

  // %AppData%\RustDesk\config path helpers, resolved inside PowerShell.
  const configDirPs = "(Join-Path $env:APPDATA 'RustDesk\\config')";
  const config2Ps = `(Join-Path ${configDirPs} 'RustDesk2.toml')`;
  const config1Ps = `(Join-Path ${configDirPs} 'RustDesk.toml')`;

  // ---- CLI: read this PC's ID (CLI first, TOML fallback) ----
  const refreshId = async (exe: string) => {
    clear();
    if (!desktop) {
      setErr(t('rustdesk.desktopOnly'));
      return;
    }
    setBusy('id');
    try {
      let id = '';
      try {
        const r = await runCommand(exe, ['--get-id']);
        id = cleanId(r.stdout || '');
      } catch {
        id = '';
      }
      if (!(id.length >= 6)) {
        // Fallback: read `id = "..."` from RustDesk.toml.
        try {
          const script =
            `if (Test-Path ${config1Ps}) { ` +
            `$m = Select-String -Path ${config1Ps} -Pattern '^\\s*id\\s*=' | Select-Object -First 1; ` +
            `if ($m) { ($m.Line -split '=',2)[1].Trim().Trim('\"').Trim(\"'\") } }`;
          const r = await runPowershell(script);
          id = cleanId(r.stdout || '');
        } catch {
          id = '';
        }
      }
      setLocalId(id);
      if (!id) setMsg(t('rustdesk.idUnknown'));
    } finally {
      setBusy('');
    }
  };

  const copyId = async () => {
    const id = cleanId(localId);
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      setMsg(t('rustdesk.idCopied') + ' ' + id);
    } catch {
      setMsg(id);
    }
  };

  const genPw = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 12; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPw(s);
  };

  // ---- CLI: set permanent password (needs service + elevation) ----
  const setPassword = async (exe: string) => {
    clear();
    if (!pw.trim()) {
      setErr(t('rustdesk.enterPw'));
      return;
    }
    if (!desktop) {
      setErr(t('rustdesk.desktopOnly'));
      return;
    }
    setBusy('pw');
    try {
      const r: CommandOutput = await runCommand(exe, ['--password', pw]);
      if (r.success) {
        setMsg(t('rustdesk.pwSet'));
        setPw('');
      } else {
        setErr(r.stderr.trim() || t('rustdesk.pwFailed'));
      }
      if (r.stdout.trim()) setOut(r.stdout.trim());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  // ---- CLI: connect to a peer by id ----
  const connect = async (exe: string, id: string, vo: boolean) => {
    clear();
    const clean = cleanId(id);
    if (!clean) {
      setErr(t('rustdesk.enterId'));
      return;
    }
    setBusy('connect');
    try {
      const args = vo ? ['--view-only', '--connect', clean] : ['--connect', clean];
      await runCommand(exe, args);
      setMsg(t('rustdesk.connecting') + ' ' + formatId(clean));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  const savePeer = () => {
    clear();
    const id = cleanId(peerId);
    if (!id) {
      setErr(t('rustdesk.enterId'));
      return;
    }
    if (peers.some((p) => p.id === id)) {
      setErr(t('rustdesk.alreadySaved'));
      return;
    }
    setPeers([...peers, { id, viewOnly }]);
    setMsg(t('rustdesk.peerSaved') + ' ' + id);
  };

  const deletePeer = (id: string) => {
    setPeers(peers.filter((p) => p.id !== id));
  };

  // ---- Server config: read RustDesk2.toml [options] ----
  const reloadServer = async () => {
    clear();
    if (!desktop) {
      setErr(t('rustdesk.desktopOnly'));
      return;
    }
    setBusy('reload');
    try {
      const keys = ['custom-rendezvous-server', 'relay-server', 'api-server', 'key'];
      const script =
        `if (Test-Path ${config2Ps}) { ` +
        `$lines = Get-Content ${config2Ps}; ` +
        `$inOpt = $false; $r = @{}; ` +
        `foreach ($raw in $lines) { $line = $raw.Trim(); ` +
        `if ($line.StartsWith('[')) { $inOpt = ($line -eq '[options]'); continue } ` +
        `if (-not $inOpt -or $line.Length -eq 0 -or $line.StartsWith('#')) { continue } ` +
        `$eq = $line.IndexOf('='); if ($eq -le 0) { continue } ` +
        `$k = $line.Substring(0,$eq).Trim(); ` +
        `$v = $line.Substring($eq+1).Trim().Trim('\"').Trim(\"'\"); ` +
        `$r[$k] = $v } ` +
        `${keys.map((k) => `('${k}=' + $r['${k}'])`).join('; ')} }`;
      const res = await runPowershell(script);
      const parsed: Record<string, string> = {};
      for (const raw of (res.stdout || '').split(/\r?\n/)) {
        const line = raw.trim();
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        parsed[line.slice(0, eq)] = line.slice(eq + 1);
      }
      setCfg({
        idServer: parsed['custom-rendezvous-server'] ?? '',
        relayServer: parsed['relay-server'] ?? '',
        apiServer: parsed['api-server'] ?? '',
        key: parsed['key'] ?? '',
      });
      setMsg(t('rustdesk.reloaded'));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  // ---- Server config: write RustDesk2.toml [options], merging keys ----
  const saveServer = async () => {
    clear();
    if (!desktop) {
      setErr(t('rustdesk.desktopOnly'));
      return;
    }
    setBusy('save');
    try {
      const updates: Record<string, string> = {
        'custom-rendezvous-server': cfg.idServer.trim(),
        'relay-server': cfg.relayServer.trim(),
        'api-server': cfg.apiServer.trim(),
        key: cfg.key.trim(),
      };
      // Build the PowerShell hashtable of updates.
      const pairs = Object.entries(updates)
        .map(([k, v]) => `'${k}' = '${psEsc(v)}'`)
        .join('; ');
      // Merge into the [options] table, preserving everything else; empty values drop the key.
      const script =
        `$path = ${config2Ps}; ` +
        `$dir = Split-Path -Parent $path; ` +
        `if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null } ` +
        `$updates = @{ ${pairs} }; ` +
        `$lines = if (Test-Path $path) { [System.Collections.ArrayList]@(Get-Content $path) } else { [System.Collections.ArrayList]@() }; ` +
        `$start = -1; $end = $lines.Count; ` +
        `for ($i=0; $i -lt $lines.Count; $i++) { $ti = $lines[$i].Trim(); ` +
        `if ($start -lt 0) { if ($ti -eq '[options]') { $start = $i } } ` +
        `elseif ($ti.StartsWith('[')) { $end = $i; break } } ` +
        `if ($start -lt 0) { ` +
        `if ($lines.Count -gt 0 -and $lines[$lines.Count-1].Trim().Length -gt 0) { [void]$lines.Add('') } ` +
        `[void]$lines.Add('[options]'); $start = $lines.Count - 1; $end = $lines.Count } ` +
        `$remaining = @{}; foreach ($k in $updates.Keys) { $remaining[$k] = $updates[$k] } ` +
        `for ($i=$start+1; $i -lt $end; $i++) { $ti = $lines[$i].Trim(); $eq = $ti.IndexOf('='); ` +
        `if ($eq -le 0) { continue } $k = $ti.Substring(0,$eq).Trim(); ` +
        `if (-not $remaining.ContainsKey($k)) { continue } $v = $remaining[$k]; ` +
        `if ($v.Length -eq 0) { $lines[$i] = ' ' } else { $lines[$i] = ($k + \" = '\" + $v + \"'\") } ` +
        `$remaining.Remove($k) } ` +
        `$append = @(); foreach ($k in $remaining.Keys) { $v = $remaining[$k]; ` +
        `if ($v.Length -gt 0) { $append += ($k + \" = '\" + $v + \"'\") } } ` +
        `if ($append.Count -gt 0) { $lines.InsertRange($end, [string[]]$append) } ` +
        `$clean = @($lines | Where-Object { $_ -ne ' ' }); ` +
        `Set-Content -Path $path -Value $clean -Encoding UTF8; 'OK'`;
      const res = await runPowershell(script);
      if (res.success) {
        setMsg(t('rustdesk.serverSaved'));
      } else {
        setErr(res.stderr.trim() || t('rustdesk.serverSaveFailed'));
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  const clearServer = () => {
    setCfg(EMPTY_CFG);
  };

  // ---- Service / launch ----
  const launch = async (exe: string) => {
    clear();
    setBusy('launch');
    try {
      await runCommand(exe, []);
      setMsg(t('rustdesk.launched'));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  const installSvc = async (exe: string) => {
    clear();
    setBusy('svc');
    try {
      const r = await runCommand(exe, ['--install-service']);
      setMsg(r.success ? t('rustdesk.svcInstalled') : t('rustdesk.svcFailed'));
      if (r.stdout.trim() || r.stderr.trim()) setOut((r.stdout || r.stderr).trim());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  const uninstallSvc = async (exe: string) => {
    clear();
    setBusy('svc');
    try {
      const r = await runCommand(exe, ['--uninstall-service']);
      setMsg(r.success ? t('rustdesk.svcRemoved') : t('rustdesk.svcFailed'));
      if (r.stdout.trim() || r.stderr.trim()) setOut((r.stdout || r.stderr).trim());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  const openConfig = async () => {
    clear();
    if (!desktop) {
      setErr(t('rustdesk.desktopOnly'));
      return;
    }
    setBusy('open');
    try {
      const script =
        `$dir = ${configDirPs}; ` +
        `if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null } ` +
        `Start-Process -FilePath $dir`;
      await runPowershell(script);
      setMsg(t('rustdesk.folderOpened'));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('rustdesk.desktopOnly')}
        </p>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('rustdesk.blurb')}
      </p>

      <DependencyGate tool="rustdesk" preferId="RustDesk.RustDesk" query="rustdesk">
        {(exe) => (
          <>
            {/* This PC */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('rustdesk.thisPc')}</h4>
              </div>
              <div className="kv-list">
                <div className="kv-row">
                  <span className="label">{t('rustdesk.id')}</span>
                  <span className="value" style={{ fontFamily: 'monospace' }}>
                    {localId ? formatId(localId) : '—'}
                  </span>
                </div>
              </div>
              <div className="mod-toolbar">
                <button className="mini" disabled={!!busy} onClick={() => refreshId(exe)}>
                  {busy === 'id' ? t('rustdesk.working') : t('rustdesk.refreshId')}
                </button>
                <button className="mini" disabled={!localId} onClick={copyId}>
                  {t('rustdesk.copyId')}
                </button>
              </div>
              <p className="count-note" style={{ marginTop: 8 }}>
                {t('rustdesk.pwHint')}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input
                  className="mod-search"
                  style={{ maxWidth: 220 }}
                  type="text"
                  placeholder={t('rustdesk.pwLabel')}
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
                <button className="mini" onClick={genPw}>
                  {t('rustdesk.genPw')}
                </button>
                <button className="mini primary" disabled={!!busy} onClick={() => setPassword(exe)}>
                  {busy === 'pw' ? t('rustdesk.working') : t('rustdesk.setPw')}
                </button>
              </div>
            </div>

            {/* Quick connect */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('rustdesk.quickConnect')}</h4>
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input
                  className="mod-search"
                  style={{ maxWidth: 220 }}
                  placeholder={t('rustdesk.peerIdPlaceholder')}
                  value={peerId}
                  onChange={(e) => setPeerId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connect(exe, peerId, viewOnly)}
                />
                <label className="chk">
                  <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
                  {t('rustdesk.viewOnly')}
                </label>
                <button className="mini primary" disabled={!!busy} onClick={() => connect(exe, peerId, viewOnly)}>
                  {busy === 'connect' ? t('rustdesk.working') : t('rustdesk.connect')}
                </button>
                <button className="mini" onClick={savePeer}>
                  {t('rustdesk.savePeer')}
                </button>
              </div>
            </div>

            {/* Saved peers */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('rustdesk.savedPeers')}</h4>
              </div>
              {peers.length === 0 ? (
                <p className="count-note">{t('rustdesk.peersEmpty')}</p>
              ) : (
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('rustdesk.id')}</th>
                      <th>{t('rustdesk.viewOnly')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {peers.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontFamily: 'monospace' }}>{formatId(p.id)}</td>
                        <td>{p.viewOnly ? t('rustdesk.yes') : t('rustdesk.no')}</td>
                        <td>
                          <button
                            className="mini primary"
                            disabled={!!busy}
                            onClick={() => connect(exe, p.id, p.viewOnly)}
                          >
                            {t('rustdesk.connect')}
                          </button>{' '}
                          <button className="mini" onClick={() => deletePeer(p.id)}>
                            {t('rustdesk.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Self-hosted server */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('rustdesk.serverTitle')}</h4>
              </div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('rustdesk.serverBlurb')}
              </p>
              <div className="io-grid">
                <label className="label">{t('rustdesk.idServer')}</label>
                <input
                  className="mod-search"
                  value={cfg.idServer}
                  onChange={(e) => setCfg({ ...cfg, idServer: e.target.value })}
                />
                <label className="label">{t('rustdesk.relayServer')}</label>
                <input
                  className="mod-search"
                  value={cfg.relayServer}
                  onChange={(e) => setCfg({ ...cfg, relayServer: e.target.value })}
                />
                <label className="label">{t('rustdesk.apiServer')}</label>
                <input
                  className="mod-search"
                  value={cfg.apiServer}
                  onChange={(e) => setCfg({ ...cfg, apiServer: e.target.value })}
                />
                <label className="label">{t('rustdesk.key')}</label>
                <input
                  className="mod-search"
                  value={cfg.key}
                  onChange={(e) => setCfg({ ...cfg, key: e.target.value })}
                />
              </div>
              <div className="mod-toolbar">
                <button className="mini primary" disabled={!!busy} onClick={saveServer}>
                  {busy === 'save' ? t('rustdesk.working') : t('rustdesk.saveServer')}
                </button>
                <button className="mini" disabled={!!busy} onClick={reloadServer}>
                  {busy === 'reload' ? t('rustdesk.working') : t('rustdesk.reloadServer')}
                </button>
                <button className="mini" onClick={clearServer}>
                  {t('rustdesk.clearServer')}
                </button>
              </div>
            </div>

            {/* Service & launch */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('rustdesk.serviceTitle')}</h4>
              </div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('rustdesk.serviceBlurb')}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini primary" disabled={!!busy} onClick={() => launch(exe)}>
                  {busy === 'launch' ? t('rustdesk.working') : t('rustdesk.launch')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => installSvc(exe)}>
                  {busy === 'svc' ? t('rustdesk.working') : t('rustdesk.installSvc')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => uninstallSvc(exe)}>
                  {busy === 'svc' ? t('rustdesk.working') : t('rustdesk.uninstallSvc')}
                </button>
                <button className="mini" disabled={!!busy} onClick={openConfig}>
                  {t('rustdesk.openConfig')}
                </button>
              </div>
            </div>

            {msg && <p className="dep-ok">{msg}</p>}
            {err && <pre className="cmd-out error">{err}</pre>}
            {out && <pre className="cmd-out">{out}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
