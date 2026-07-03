import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — wraps the ViaProxy Java jar (ViaVersion/ViaBackwards/ViaRewind) so one Minecraft
// client can join servers of (almost) any version, and vice-versa. Mirrors the C# ViaProxyService:
// the external tool is java.exe (gated via DependencyGate on "java"). We download the latest
// ViaProxy*.jar from GitHub releases into %LOCALAPPDATA%\WinForge\viaproxy, fill a run-config form,
// then launch the jar headless through its `cli` sub-command as a detached, tracked process whose
// stdout/stderr are tee'd to a log file we poll for the live log. Start/Stop track the process by
// its recorded PID. Live actions require the WinForge desktop app. Never throws — everything guarded.

// Curated common target versions (jar supports many more; AUTO auto-detects the server version).
const VERSIONS = [
  'AUTO',
  '1.21.4', '1.21.2', '1.21', '1.20.6', '1.20.5', '1.20.3', '1.20.2', '1.20',
  '1.19.4', '1.19.2', '1.19', '1.18.2', '1.18', '1.17.1', '1.17', '1.16.5',
  '1.16.4', '1.16.3', '1.16.1', '1.15.2', '1.14.4', '1.13.2', '1.12.2',
  '1.11.2', '1.10.2', '1.9.4', '1.8.x', '1.7.10', 'b1.8.1', 'c0.30',
] as const;

// PowerShell single-quote escape.
const psq = (s: string) => s.replace(/'/g, "''");

interface RunOptions {
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  targetVersion: string;
  authMethod: string; // none | account
  onlineMode: boolean;
  backendProxy: string;
  allowBetaPing: boolean;
  betacraft: boolean;
}

const DEFAULTS: RunOptions = {
  bindHost: '127.0.0.1',
  bindPort: 25568,
  targetHost: '',
  targetPort: 25565,
  targetVersion: 'AUTO',
  authMethod: 'none',
  onlineMode: false,
  backendProxy: '',
  allowBetaPing: false,
  betacraft: false,
};

// The app-data folder + log file the proxy runs from (matches the C# DataDir).
const DATA_DIR = '$env:LOCALAPPDATA\\WinForge\\viaproxy';
const LOG_FILE = `${DATA_DIR}\\viaproxy.log`;
const PID_FILE = `${DATA_DIR}\\viaproxy.pid`;

interface JarInfo { ok: boolean; jar: string; name: string }
interface StartInfo { ok: boolean; pid: number; error: string }
interface RunState { running: boolean; pid: number }

async function ps<T>(script: string): Promise<T | { ok: false; error: string }> {
  try {
    const res: CommandOutput = await runPowershell(script);
    const text = (res.stdout || '').trim();
    if (!text) return { ok: false, error: (res.stderr || `exit ${res.code}`).trim() };
    return JSON.parse(text) as T;
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

// Build the `java -jar ... cli` argument list from a run-config.
function buildArgs(jar: string, o: RunOptions): string[] {
  const bind = `${(o.bindHost.trim() || '127.0.0.1')}:${o.bindPort}`;
  const target = `${o.targetHost.trim()}:${o.targetPort}`;
  const args = [
    '-jar', jar, 'cli',
    '--bind-address', bind,
    '--target-address', target,
    '--target-version', o.targetVersion || 'AUTO',
    '--auth-method', o.authMethod || 'none',
  ];
  if (o.onlineMode) args.push('--proxy-online-mode', 'true');
  if (o.allowBetaPing) args.push('--allow-beta-pinging', 'true');
  if (o.betacraft) args.push('--betacraft-auth', 'true');
  if (o.backendProxy.trim()) args.push('--backend-proxy-url', o.backendProxy.trim());
  return args;
}

export function ViaProxyModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [opt, setOpt] = useState<RunOptions>(DEFAULTS);
  const [jar, setJar] = useState<string | null>(null);
  const [jarName, setJarName] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);

  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => setOpt((p) => ({ ...p, [k]: v }));
  const say = (kind: 'ok' | 'err' | 'info', msg: string) => setNote({ kind, msg });
  const localAddr = `${opt.bindHost.trim() || '127.0.0.1'}:${opt.bindPort}`;

  // ── Locate the newest ViaProxy*.jar in the data dir ──────────────────────
  const checkJar = async () => {
    if (!desktop) return;
    const script =
      `$ErrorActionPreference='Stop';$d="${DATA_DIR}";` +
      `try{ [void](New-Item -ItemType Directory -Force -Path $d);` +
      `$j=Get-ChildItem -Path $d -Filter 'ViaProxy*.jar' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1;` +
      `if($j){ [pscustomobject]@{ok=$true;jar=$j.FullName;name=$j.Name} | ConvertTo-Json -Compress }` +
      `else{ '{"ok":false,"jar":"","name":""}' } }` +
      `catch{ '{"ok":false,"jar":"","name":""}' }`;
    const r = await ps<JarInfo>(script);
    if ('ok' in r && r.ok && 'jar' in r) {
      setJar(r.jar);
      setJarName(r.name);
    } else {
      setJar(null);
      setJarName('');
    }
  };

  // ── Download the latest jar from GitHub releases ─────────────────────────
  const downloadJar = async () => {
    if (!desktop) return;
    setBusy('download');
    say('info', t('viaproxy.downloading'));
    const api = 'https://api.github.com/repos/ViaVersion/ViaProxy/releases/latest';
    const script =
      `$ErrorActionPreference='Stop';$d="${DATA_DIR}";` +
      `try{` +
      `[void](New-Item -ItemType Directory -Force -Path $d);` +
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;` +
      `$h=@{ 'User-Agent'='WinForge'; Accept='application/vnd.github+json' };` +
      `$rel=Invoke-RestMethod -Uri '${api}' -Headers $h -TimeoutSec 60;` +
      `$asset=$rel.assets | Where-Object { $_.name -like '*.jar' -and $_.name -like 'ViaProxy*' -and $_.name -notlike '*sources*' -and $_.name -notlike '*javadoc*' } | Select-Object -First 1;` +
      `if(-not $asset){ throw 'No ViaProxy*.jar asset in the latest release.' }` +
      `$dest=Join-Path $d $asset.name;` +
      `Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $h -TimeoutSec 300 -UseBasicParsing;` +
      `[pscustomobject]@{ok=$true;jar=$dest;name=$asset.name;tag=$rel.tag_name} | ConvertTo-Json -Compress` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<JarInfo & { tag: string }>(script);
    setBusy('');
    if ('ok' in r && r.ok && 'jar' in r) {
      setJar(r.jar);
      setJarName(r.name);
      say('ok', t('viaproxy.downloaded', { name: r.name }));
    } else {
      say('err', ('error' in r && r.error) || t('viaproxy.downloadFail'));
    }
  };

  // ── Start the proxy detached, tee'ing output to the log file ─────────────
  const start = async (javaPath: string) => {
    if (!desktop) return;
    if (!jar) { say('err', t('viaproxy.noJar')); return; }
    if (!opt.targetHost.trim()) { say('err', t('viaproxy.targetRequired')); return; }
    setBusy('start');
    const args = buildArgs(jar, opt);
    // Quote each argument for the PowerShell argument-list array.
    const argList = args.map((a) => `'${psq(a)}'`).join(',');
    const script =
      `$ErrorActionPreference='Stop';$d="${DATA_DIR}";$log="${LOG_FILE}";$pf="${PID_FILE}";` +
      `try{` +
      `[void](New-Item -ItemType Directory -Force -Path $d);` +
      `Set-Content -Path $log -Value '' -Encoding UTF8;` +
      // Redirect both streams to the log file; run detached with no window.
      `$p=Start-Process -FilePath '${psq(javaPath)}' -ArgumentList @(${argList}) -WorkingDirectory $d -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru;` +
      `Set-Content -Path $pf -Value $p.Id -Encoding ASCII;` +
      `[pscustomobject]@{ok=$true;pid=$p.Id;error=''} | ConvertTo-Json -Compress` +
      `}catch{ Write-Output ('{"ok":false,"pid":0,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<StartInfo>(script);
    setBusy('');
    if ('ok' in r && r.ok && 'pid' in r && r.pid > 0) {
      setRunning(true);
      say('ok', t('viaproxy.started', { addr: localAddr, target: `${opt.targetHost.trim()}:${opt.targetPort}`, ver: opt.targetVersion }));
      // Give the JVM a moment then pull the first log lines.
      setTimeout(() => { void refreshLog(); void refreshState(); }, 1200);
    } else {
      say('err', ('error' in r && r.error) || t('viaproxy.startFail'));
    }
  };

  // ── Stop the tracked proxy process by its recorded PID ───────────────────
  const stop = async () => {
    if (!desktop) return;
    setBusy('stop');
    const script =
      `$ErrorActionPreference='Stop';$pf="${PID_FILE}";` +
      `try{` +
      `if(Test-Path $pf){ $id=[int]((Get-Content $pf -Raw).Trim());` +
      `$p=Get-Process -Id $id -ErrorAction SilentlyContinue;` +
      `if($p){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue };` +
      `Remove-Item $pf -Force -ErrorAction SilentlyContinue }` +
      `'{"ok":true,"error":""}'` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    setRunning(false);
    if ('ok' in r && !r.ok) say('err', ('error' in r && r.error) || t('viaproxy.stopFail'));
    else say('info', t('viaproxy.stopped'));
    void refreshLog();
  };

  // ── Is the tracked PID still alive? ──────────────────────────────────────
  const refreshState = async () => {
    if (!desktop) return;
    const script =
      `$pf="${PID_FILE}";` +
      `try{ if(Test-Path $pf){ $id=[int]((Get-Content $pf -Raw).Trim());` +
      `$p=Get-Process -Id $id -ErrorAction SilentlyContinue;` +
      `if($p){ [pscustomobject]@{running=$true;pid=$id} | ConvertTo-Json -Compress } else { '{"running":false,"pid":0}' } }` +
      `else{ '{"running":false,"pid":0}' } }catch{ '{"running":false,"pid":0}' }`;
    const r = await ps<RunState>(script);
    if ('running' in r) setRunning(r.running);
  };

  // ── Pull the current contents of the log file ────────────────────────────
  const refreshLog = async () => {
    if (!desktop) return;
    setBusy('log');
    try {
      const res = await runPowershell(
        `$l="${LOG_FILE}";$e="${LOG_FILE}.err";$t='';` +
        `if(Test-Path $l){ $t=(Get-Content $l -Raw -ErrorAction SilentlyContinue) };` +
        `if(Test-Path $e){ $er=(Get-Content $e -Raw -ErrorAction SilentlyContinue); if($er){ $t=$t+[Environment]::NewLine+$er } };` +
        `$t`,
      );
      const text = (res.stdout || '').trimEnd();
      setLog(text || t('viaproxy.logEmpty'));
    } catch (e) {
      say('err', String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const copyAddr = async () => {
    if (!desktop) return;
    try {
      await runPowershell(`Set-Clipboard -Value '${psq(localAddr)}'`);
      say('ok', t('viaproxy.copied', { addr: localAddr }));
    } catch (e) {
      say('err', String(e instanceof Error ? e.message : e));
    }
  };

  const copySource = async () => {
    const url = 'https://github.com/ViaVersion/ViaProxy';
    if (desktop) {
      try { await runPowershell(`Set-Clipboard -Value '${url}'`); } catch { /* ignore */ }
    }
    say('info', t('viaproxy.sourceCopied', { url }));
  };

  const openDataDir = async () => {
    if (!desktop) return;
    try {
      await runCommand('cmd', ['/c', 'start', '', '%LOCALAPPDATA%\\WinForge\\viaproxy']);
    } catch (e) {
      say('err', String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('viaproxy.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('viaproxy.desktopOnly')}</p>
      )}

      <DependencyGate tool="java" preferId="Microsoft.OpenJDK.21" query="OpenJDK">
        {(javaPath) => (
          <>
            {/* Jar management */}
            <div className="panel">
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <span className={jar ? 'dep-ok' : 'dep-missing'}>
                  {jar ? `✓ ${jarName}` : t('viaproxy.noJarShort')}
                </span>
                <button className="mini primary" disabled={!desktop || busy === 'download'} onClick={downloadJar}>
                  {busy === 'download' ? t('viaproxy.downloadingBtn') : t('viaproxy.downloadJar')}
                </button>
                <button className="mini" disabled={!desktop} onClick={checkJar}>{t('viaproxy.checkJar')}</button>
                <button className="mini" disabled={!desktop} onClick={openDataDir}>{t('viaproxy.openFolder')}</button>
                <button className="mini" onClick={copySource}>{t('viaproxy.source')}</button>
              </div>
              <p className="count-note" style={{ marginTop: 4 }}>{t('viaproxy.jarNote')}</p>
            </div>

            {note && (
              <p className={note.kind === 'err' ? 'error' : note.kind === 'ok' ? 'dep-ok' : 'count-note'} style={{ marginTop: 8 }}>
                {note.msg}
              </p>
            )}

            {/* Target server config */}
            <div className="panel">
              <label className="label">{t('viaproxy.targetHeader')}</label>
              <div className="io-grid">
                <div className="kv-row">
                  <span className="label">{t('viaproxy.serverHost')}</span>
                  <input className="mod-search" value={opt.targetHost} placeholder="play.example.net" onChange={(e) => set('targetHost', e.target.value)} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('viaproxy.serverPort')}</span>
                  <input className="mod-search" type="number" min={1} max={65535} value={opt.targetPort} onChange={(e) => set('targetPort', Math.max(1, Math.min(65535, +e.target.value || 25565)))} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('viaproxy.targetVersion')}</span>
                  <select className="mod-select" value={opt.targetVersion} onChange={(e) => set('targetVersion', e.target.value)}>
                    {VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="kv-row">
                  <span className="label">{t('viaproxy.authMethod')}</span>
                  <select className="mod-select" value={opt.authMethod} onChange={(e) => set('authMethod', e.target.value)}>
                    <option value="none">{t('viaproxy.authNone')}</option>
                    <option value="account">{t('viaproxy.authAccount')}</option>
                  </select>
                </div>
              </div>
              <label className="chk" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={opt.onlineMode} onChange={(e) => set('onlineMode', e.target.checked)} />
                {t('viaproxy.onlineMode')}
              </label>
            </div>

            {/* Advanced */}
            <div className="panel">
              <label className="label">{t('viaproxy.advancedHeader')}</label>
              <div className="io-grid">
                <div className="kv-row">
                  <span className="label">{t('viaproxy.bindHost')}</span>
                  <input className="mod-search" value={opt.bindHost} onChange={(e) => set('bindHost', e.target.value)} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('viaproxy.bindPort')}</span>
                  <input className="mod-search" type="number" min={1} max={65535} value={opt.bindPort} onChange={(e) => set('bindPort', Math.max(1, Math.min(65535, +e.target.value || 25568)))} />
                </div>
              </div>
              <div className="kv-row" style={{ marginTop: 8 }}>
                <span className="label">{t('viaproxy.backendProxy')}</span>
                <input className="mod-search" value={opt.backendProxy} placeholder="socks5://user:pass@host:1080" onChange={(e) => set('backendProxy', e.target.value)} />
              </div>
              <label className="chk" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={opt.allowBetaPing} onChange={(e) => set('allowBetaPing', e.target.checked)} />
                {t('viaproxy.allowBetaPing')}
              </label>
              <label className="chk">
                <input type="checkbox" checked={opt.betacraft} onChange={(e) => set('betacraft', e.target.checked)} />
                {t('viaproxy.betacraft')}
              </label>
            </div>

            {/* Run controls */}
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <span className={running ? 'dep-ok' : 'count-note'}>
                {running ? `● ${t('viaproxy.running')}` : `○ ${t('viaproxy.stoppedState')}`}
              </span>
              <button className="mini primary" disabled={!desktop || !jar || running || busy === 'start'} onClick={() => start(javaPath)}>
                {busy === 'start' ? t('viaproxy.startingBtn') : t('viaproxy.startProxy')}
              </button>
              <button className="mini" disabled={!desktop || !running || busy === 'stop'} onClick={stop}>
                {t('viaproxy.stop')}
              </button>
              <button className="mini" disabled={!desktop} onClick={refreshState}>{t('viaproxy.checkState')}</button>
              <button className="mini" disabled={!desktop} onClick={copyAddr}>{t('viaproxy.copyAddr')}</button>
            </div>

            {running && (
              <p className="count-note">{t('viaproxy.hint', { addr: localAddr, target: `${opt.targetHost.trim()}:${opt.targetPort}`, ver: opt.targetVersion })}</p>
            )}

            {/* Live log */}
            <div className="panel">
              <div className="mod-toolbar">
                <label className="label" style={{ flex: 1 }}>{t('viaproxy.liveLog')}</label>
                <button className="mini" disabled={!desktop || busy === 'log'} onClick={refreshLog}>
                  {busy === 'log' ? t('viaproxy.refreshing') : t('viaproxy.refreshLog')}
                </button>
                <button className="mini" onClick={() => setLog('')}>{t('viaproxy.clearLog')}</button>
              </div>
              {log && <pre className="cmd-out">{log}</pre>}
              <p className="count-note" style={{ marginTop: 4 }}>{t('viaproxy.logNote')}</p>
            </div>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
