import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { ModuleToolbar, StatusDot } from './common';

// ============================================================================
// Minecraft Server · Minecraft 伺服器架設器 — module.minecraftserver
//
// Full-feature native web port of WinForge's Pages/MinecraftServerModule +
// Services/MinecraftServerService.cs. The desktop original wrapped a Java
// runtime to download a Paper build (PaperMC Fill v3 API), compile Spigot with
// BuildTools.jar, accept the EULA, edit server.properties, run the server with
// a live console + stdin command box, and build plugins from git (Maven/Gradle)
// into plugins/.
//
// Here we drive the same real workflows through the Tauri backend and, because
// the backend shells out to a fresh PowerShell per call (no persistent stdin to
// a detached java.exe), we deliver the equivalent live command channel over
// **RCON** — the standard Minecraft remote-console protocol — exactly the way a
// server operator would type `op` / `whitelist` / `ban` into the console.
//
//   • Server tab   — server folder, engine probe (Java / git / mvn / server.jar
//                    / EULA), Paper version list + download (Invoke-RestMethod),
//                    BuildTools download + Spigot build (java -jar BuildTools),
//                    EULA toggle (writes eula.txt).
//   • Properties   — server.properties key-field form, RCON settings, memory +
//                    start.bat generator, raw server.properties editor.
//   • Console      — start (spawns start.bat), stop / force-stop, live tail of
//                    logs/latest.log, live RCON command box + Send.
//   • World        — pick the world folder, zip a timestamped backup, list /
//                    restore-note / delete backups, open the backups folder.
//   • Players      — online players (RCON `list`), ops / whitelist / banned
//                    lists (read from the server's json files), add/remove each
//                    via RCON when running or by editing the json when stopped.
//   • Plugins      — popular-plugin presets + any git repo → plugins/
//                    (Maven/Gradle), installed jars list, build log.
//
// Everything is filesystem/process/network work done via PowerShell 5.1. Any
// mutation (EULA write, downloads, builds, start/stop, RCON command, property
// write, backup, delete, op/ban/whitelist edit) is an explicit button click;
// destructive ones (force-stop, delete backup, ban, deop, raw overwrite) get a
// confirm; plugin builds run untrusted build scripts and are always gated.
// ============================================================================

const DEFAULT_DIR = '%USERPROFILE%\\Documents\\MinecraftServer';

const TABS = ['server', 'props', 'console', 'world', 'players', 'plugins'] as const;
type Tab = (typeof TABS)[number];

const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;
const BUILD_SYS = ['auto', 'maven', 'gradle'] as const;
type BuildSys = (typeof BUILD_SYS)[number];

// Popular open-source plugins, buildable from git source (mirrors
// Catalog/MinecraftPluginCatalog.cs).
interface Preset {
  name: string;
  url: string;
  system: 'gradle' | 'maven';
  blurbKey: string;
}
const PRESETS: Preset[] = [
  { name: 'EssentialsX', url: 'https://github.com/EssentialsX/Essentials.git', system: 'gradle', blurbKey: 'essentialsx' },
  { name: 'LuckPerms', url: 'https://github.com/LuckPerms/LuckPerms.git', system: 'gradle', blurbKey: 'luckperms' },
  { name: 'ViaVersion', url: 'https://github.com/ViaVersion/ViaVersion.git', system: 'gradle', blurbKey: 'viaversion' },
  { name: 'WorldEdit', url: 'https://github.com/EngineHub/WorldEdit.git', system: 'gradle', blurbKey: 'worldedit' },
];

const AIKAR_FLAGS =
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 ' +
  '-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch ' +
  '-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M ' +
  '-XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 ' +
  '-XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 ' +
  '-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem ' +
  '-XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true';

// Single-quote a string for embedding inside a PowerShell single-quoted literal.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

// A player-name style token, stripped to what a Minecraft command accepts.
function safeName(s: string): string {
  return s.trim().replace(/[^0-9A-Za-z_.-]/g, '');
}

// ── Source-RCON helper (PowerShell 5.1, raw TcpClient) ───────────────────────
// Emits a here-string function `Send-Rcon $host $port $password $command` that
// speaks the Source RCON wire protocol: AUTH packet then EXEC_COMMAND, returning
// the concatenated server response text. Kept as one reusable snippet so every
// live-command action (console send, op, ban, whitelist, list) uses the same
// vetted implementation. Never logs the password.
const RCON_FN = `
function Send-Rcon([string]$rhost,[int]$rport,[string]$rpass,[string]$cmd){
  $enc = [System.Text.Encoding]::UTF8
  $client = New-Object System.Net.Sockets.TcpClient
  $iar = $client.BeginConnect($rhost,$rport,$null,$null)
  if(-not $iar.AsyncWaitHandle.WaitOne(4000)){ $client.Close(); throw 'RCON connect timed out (is the server running with enable-rcon=true?).' }
  $client.EndConnect($iar)
  $stream = $client.GetStream(); $stream.ReadTimeout = 6000
  function _pkt([int]$id,[int]$type,[string]$body){
    $b = $enc.GetBytes($body)
    $len = 4 + 4 + $b.Length + 2
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([int]$len); $bw.Write([int]$id); $bw.Write([int]$type)
    if($b.Length -gt 0){ $bw.Write($b) }
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Flush()
    return $ms.ToArray()
  }
  function _readInt(){ $buf = New-Object byte[] 4; $n=0; while($n -lt 4){ $r=$stream.Read($buf,$n,4-$n); if($r -le 0){ throw 'RCON stream closed.' }; $n+=$r }; return [System.BitConverter]::ToInt32($buf,0) }
  function _readPkt(){
    $len = _readInt
    $buf = New-Object byte[] $len; $n=0; while($n -lt $len){ $r=$stream.Read($buf,$n,$len-$n); if($r -le 0){ throw 'RCON stream closed.' }; $n+=$r }
    $id = [System.BitConverter]::ToInt32($buf,0)
    $body = if($len -gt 10){ $enc.GetString($buf,8,$len-10) } else { '' }
    return @{ id=$id; body=$body }
  }
  try {
    $auth = _pkt 1 3 $rpass; $stream.Write($auth,0,$auth.Length); $stream.Flush()
    $ar = _readPkt
    if($ar.id -eq -1){ throw 'RCON authentication failed — wrong password.' }
    $exec = _pkt 2 2 $cmd; $stream.Write($exec,0,$exec.Length); $stream.Flush()
    $resp = _readPkt
    return $resp.body
  } finally { $stream.Close(); $client.Close() }
}`;

interface EngineInfo {
  java: string;
  hasJava: boolean;
  git: boolean;
  maven: boolean;
  serverJar: boolean;
  eula: boolean;
  resolvedDir: string;
}

// RCON connection settings, read from server.properties on the Properties tab
// and threaded to the Console/Players tabs so their live commands can connect.
interface RconInfo {
  enabled: boolean;
  port: string;
  password: string;
}
const DEFAULT_RCON: RconInfo = { enabled: false, port: '25575', password: '' };

export function MinecraftServerModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [tab, setTab] = useState<Tab>('server');
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [rcon, setRcon] = useState<RconInfo>(DEFAULT_RCON);

  // ── engine probe (Java / git / mvn / server.jar / eula / resolved dir) ─────
  const probe = useCallback(async (): Promise<EngineInfo> => {
    if (!live) {
      return { java: '', hasJava: false, git: false, maven: false, serverJar: false, eula: false, resolvedDir: '' };
    }
    const script = `
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
function Find($names){ foreach($n in $names){ $c = Get-Command $n -ErrorAction SilentlyContinue; if($c){ return $c.Source } }; return '' }
$java = Find @('java.exe','java')
$git  = Find @('git.exe','git')
$mvn  = Find @('mvn.cmd','mvn.bat','mvn.exe','mvn')
$jar  = Test-Path (Join-Path $d 'server.jar')
$eula = $false
$ep = Join-Path $d 'eula.txt'
if(Test-Path $ep){ $eula = ((Get-Content $ep -Raw) -replace '\\s','') -match 'eula=true' }
[pscustomobject]@{ java=$java; git=($git -ne ''); maven=($mvn -ne ''); serverJar=$jar; eula=$eula; resolvedDir=$d }`;
    const rows = await runPowershellJson<{
      java: string; git: boolean; maven: boolean; serverJar: boolean; eula: boolean; resolvedDir: string;
    }>(script);
    const r = rows[0];
    if (!r) return { java: '', hasJava: false, git: false, maven: false, serverJar: false, eula: false, resolvedDir: '' };
    return {
      java: r.java ?? '',
      hasJava: !!r.java,
      git: !!r.git,
      maven: !!r.maven,
      serverJar: !!r.serverJar,
      eula: !!r.eula,
      resolvedDir: r.resolvedDir ?? '',
    };
  }, [dir, live]);

  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const refreshEngine = useCallback(() => {
    probe().then(
      (e) => { setEngine(e); setEngineErr(null); },
      (err) => setEngineErr(String(err?.message ?? err)),
    );
  }, [probe]);

  // Read RCON settings out of server.properties so Console/Players can connect.
  const refreshRcon = useCallback(async () => {
    if (!live) { setRcon(DEFAULT_RCON); return; }
    try {
      const rows = await runPowershellJson<{ enabled: boolean; port: string; password: string }>(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$p = Join-Path $d 'server.properties'
$en=$false; $port='25575'; $pw=''
if(Test-Path $p){
  foreach($line in (Get-Content $p)){
    $l = $line.Trim(); if($l.Length -eq 0 -or $l.StartsWith('#')){ continue }
    $i = $l.IndexOf('='); if($i -le 0){ continue }
    $k = $l.Substring(0,$i).Trim(); $v = $l.Substring($i+1)
    if($k -eq 'enable-rcon'){ $en = ($v.Trim().ToLower() -eq 'true') }
    elseif($k -eq 'rcon.port'){ $port = $v.Trim() }
    elseif($k -eq 'rcon.password'){ $pw = $v }
  }
}
[pscustomobject]@{ enabled=$en; port=$port; password=$pw }`);
      const r = rows[0];
      setRcon(r ? { enabled: !!r.enabled, port: r.port || '25575', password: r.password ?? '' } : DEFAULT_RCON);
    } catch {
      setRcon(DEFAULT_RCON);
    }
  }, [dir, live]);

  // Probe on mount and whenever the folder changes.
  useMemo(() => { refreshEngine(); refreshRcon(); }, [refreshEngine, refreshRcon]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mcserver.blurb')}
      </p>

      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 260, fontFamily: 'monospace' }}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder={t('mcserver.folderPlaceholder')}
        />
        <button className="mini" onClick={() => { refreshEngine(); refreshRcon(); }}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {!live && <p className="mod-msg">{t('mcserver.desktopOnly')}</p>}
      {engineErr && <pre className="cmd-out error">{engineErr}</pre>}

      {engine && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
          <StatusDot ok={engine.hasJava} label={engine.hasJava ? t('mcserver.javaOk') : t('mcserver.javaMissing')} />
          <StatusDot ok={engine.serverJar} label={engine.serverJar ? t('mcserver.jarPresent') : t('mcserver.jarMissing')} />
          <StatusDot ok={engine.eula} label={engine.eula ? t('mcserver.eulaOk') : t('mcserver.eulaNo')} />
          <StatusDot ok={rcon.enabled} label={rcon.enabled ? t('mcserver.rconOn') : t('mcserver.rconOff')} />
          <StatusDot ok={engine.maven} label={engine.maven ? t('mcserver.mavenOk') : t('mcserver.mavenNo')} />
          <StatusDot ok={engine.git} label={engine.git ? t('mcserver.gitOk') : t('mcserver.gitNo')} />
        </div>
      )}

      <div className="mod-tabbar" role="tablist" style={{ marginTop: 8 }}>
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={`mod-tab${id === tab ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(`mcserver.tab.${id}`)}
          </button>
        ))}
      </div>

      <div className="mod-tabpanel" role="tabpanel">
        {tab === 'server' && (
          <ServerTab dir={dir} live={live} engine={engine} refreshEngine={refreshEngine} />
        )}
        {tab === 'props' && (
          <PropsTab dir={dir} live={live} refreshEngine={refreshEngine} refreshRcon={refreshRcon} javaPath={engine?.java ?? ''} />
        )}
        {tab === 'console' && <ConsoleTab dir={dir} live={live} engine={engine} rcon={rcon} refreshEngine={refreshEngine} />}
        {tab === 'world' && <WorldTab dir={dir} live={live} />}
        {tab === 'players' && <PlayersTab dir={dir} live={live} rcon={rcon} />}
        {tab === 'plugins' && <PluginsTab dir={dir} live={live} engine={engine} refreshEngine={refreshEngine} />}
      </div>
    </div>
  );
}

// ── shared message row ───────────────────────────────────────────────────────
type Msg = { ok: boolean; text: string } | null;
function MsgLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <pre className={`cmd-out${msg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap' }}>
      {msg.text}
    </pre>
  );
}

// Lightweight bordered card + two-column form grid (no bespoke CSS classes;
// reuses design tokens via inline styles so it degrades cleanly everywhere).
const CARD_STYLE: CSSProperties = {
  border: '1px solid var(--stroke)',
  borderRadius: 'var(--radius)',
  padding: '14px 16px',
  marginTop: 12,
};
const FORM_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  gap: '8px 12px',
  alignItems: 'center',
  margin: '10px 0',
};

function Card({ children, first }: { children: ReactNode; first?: boolean }) {
  return <div style={first ? { ...CARD_STYLE, marginTop: 0 } : CARD_STYLE}>{children}</div>;
}

interface TabProps {
  dir: string;
  live: boolean;
  engine: EngineInfo | null;
  refreshEngine: () => void;
}

// ════════════════════════════ Server tab ════════════════════════════════════
function ServerTab({ dir, live, engine, refreshEngine }: TabProps) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [spigotVer, setSpigotVer] = useState('latest');
  const [log, setLog] = useState('');

  const loadVersions = async () => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      // PaperMC Fill v3: projects/paper -> versions map (group -> [versions]).
      const rows = await runPowershellJson<string>(`
$ProgressPreference='SilentlyContinue'
$h = @{ 'User-Agent' = 'WinForge/1.0 (Minecraft server setupper)' }
$r = Invoke-RestMethod -Uri 'https://fill.papermc.io/v3/projects/paper' -Headers $h -TimeoutSec 30
$list = New-Object System.Collections.Generic.List[string]
foreach($p in $r.versions.PSObject.Properties){ foreach($v in $p.Value){ if(-not $list.Contains($v)){ $list.Add($v) } } }
$list.Reverse()
$list`);
      setVersions(rows);
      if (rows.length > 0 && rows[0]) setVersion(rows[0]);
      setMsg({ ok: true, text: t('mcserver.versionsLoaded', { num: rows.length }) });
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.versionsFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const downloadPaper = async () => {
    if (!live || !version) {
      setMsg({ ok: false, text: t('mcserver.pickVersion') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // Resolve the newest stable build for the version, then download server:default.
      const res = await runPowershell(`
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
$h = @{ 'User-Agent' = 'WinForge/1.0 (Minecraft server setupper)' }
$b = Invoke-RestMethod -Uri 'https://fill.papermc.io/v3/projects/paper/versions/${psq(version)}/builds' -Headers $h -TimeoutSec 60
if(-not $b -or $b.Count -eq 0){ throw 'No builds for this version.' }
$stable = $b | Where-Object { $_.channel -eq 'STABLE' -or $_.channel -eq 'default' } | Select-Object -First 1
if(-not $stable){ $stable = $b | Sort-Object id -Descending | Select-Object -First 1 }
$url = $stable.downloads.'server:default'.url
if(-not $url){ $url = ($stable.downloads.PSObject.Properties | Select-Object -First 1).Value.url }
if(-not $url){ throw 'Build has no server download.' }
Invoke-WebRequest -Uri $url -Headers $h -OutFile (Join-Path $d 'server.jar') -TimeoutSec 600
"Downloaded Paper ${psq(version)} (build #$($stable.id)) -> server.jar"`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: res.stdout.trim() });
      refreshEngine();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.downloadFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const buildSpigot = async () => {
    if (!live) return;
    if (!engine?.hasJava) {
      setMsg({ ok: false, text: t('mcserver.needJava') });
      return;
    }
    if (!confirm(t('mcserver.confirmSpigot', { ver: spigotVer || 'latest' }))) return;
    setBusy(true);
    setMsg(null);
    setLog(t('mcserver.spigotBuilding'));
    try {
      // Download BuildTools.jar then run it; copy produced spigot-*.jar to server.jar.
      const res = await runPowershell(`
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$bt = Join-Path $d 'buildtools'
New-Item -ItemType Directory -Force -Path $bt | Out-Null
$jar = Join-Path $bt 'BuildTools.jar'
Invoke-WebRequest -Uri 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar' -OutFile $jar -TimeoutSec 300
Push-Location $bt
& '${psq(engine.java || 'java')}' -jar $jar --rev '${psq(spigotVer.trim() || 'latest')}' 2>&1 | Out-String
$spigot = Get-ChildItem -Path $bt -Filter 'spigot-*.jar' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
Pop-Location
if(-not $spigot){ throw 'Build finished but no spigot-*.jar was produced.' }
Copy-Item $spigot.FullName (Join-Path $d 'server.jar') -Force
"Built Spigot ${psq(spigotVer)} and copied $($spigot.Name) -> server.jar"`);
      setLog(res.stdout);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.spigotDone') });
      refreshEngine();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.spigotFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const setEula = async (accepted: boolean) => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
$body = "# Accepted via WinForge. By setting eula=true you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA).\`neula=${accepted ? 'true' : 'false'}\`n"
Set-Content -Path (Join-Path $d 'eula.txt') -Value $body -NoNewline -Encoding utf8
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: accepted ? t('mcserver.eulaAccepted') : t('mcserver.eulaFalse') });
      refreshEngine();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!live) return;
    await runPowershell(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
Start-Process explorer.exe $d`);
  };

  return (
    <div>
      {engine && !engine.hasJava && (
        <p className="mod-msg">{t('mcserver.javaWarn')}</p>
      )}

      {/* Server folder + engine status */}
      <Card first>
        <div className="mod-toolbar">
          <strong>{t('mcserver.folder')}</strong>
          <button className="mini" onClick={openFolder} disabled={!live}>
            {t('mcserver.openFolder')}
          </button>
        </div>
        <p className="count-note">
          {t('mcserver.resolvedDir')}: <code>{engine?.resolvedDir || '—'}</code>
        </p>
        {engine && (
          <p className="count-note" style={{ marginTop: 4 }}>
            {engine.maven ? t('mcserver.mavenOk') : t('mcserver.mavenNo')} · {engine.git ? t('mcserver.gitOk') : t('mcserver.gitNo')}
          </p>
        )}
      </Card>

      {/* Paper */}
      <Card>
        <strong>{t('mcserver.paperTitle')}</strong>
        <p className="count-note">{t('mcserver.paperBlurb')}</p>
        <div className="mod-toolbar">
          <button className="mini" onClick={loadVersions} disabled={busy || !live}>
            {t('mcserver.loadVersions')}
          </button>
          <select
            className="mod-search"
            style={{ minWidth: 160 }}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            {versions.length === 0 && <option value="">—</option>}
            {versions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <button className="mini primary" onClick={downloadPaper} disabled={busy || !live || !version}>
            {t('mcserver.downloadPaper')}
          </button>
        </div>
      </Card>

      {/* Spigot */}
      <Card>
        <strong>{t('mcserver.spigotTitle')}</strong>
        <p className="count-note">{t('mcserver.spigotBlurb')}</p>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ width: 160 }}
            value={spigotVer}
            onChange={(e) => setSpigotVer(e.target.value)}
            placeholder="1.21.4 / latest"
          />
          <button className="mini" onClick={buildSpigot} disabled={busy || !live}>
            {t('mcserver.buildSpigot')}
          </button>
        </div>
        {log && (
          <pre className="cmd-out" style={{ maxHeight: 200, overflow: 'auto', marginTop: 8 }}>{log}</pre>
        )}
      </Card>

      {/* EULA */}
      <Card>
        <strong>{t('mcserver.eulaTitle')}</strong>
        <p className="count-note">{t('mcserver.eulaBlurb')}</p>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={!!engine?.eula}
            disabled={busy || !live}
            onChange={(e) => setEula(e.target.checked)}
          />
          {t('mcserver.eulaAccept')}
        </label>
      </Card>

      <MsgLine msg={msg} />
    </div>
  );
}

// ════════════════════════════ Properties tab ════════════════════════════════
interface PropsForm {
  port: string;
  motd: string;
  gamemode: string;
  difficulty: string;
  maxPlayers: string;
  onlineMode: boolean;
  whitelist: boolean;
  pvp: boolean;
  seed: string;
}
const DEFAULT_FORM: PropsForm = {
  port: '25565',
  motd: 'A Minecraft Server',
  gamemode: 'survival',
  difficulty: 'easy',
  maxPlayers: '20',
  onlineMode: true,
  whitelist: false,
  pvp: true,
  seed: '',
};

function PropsTab({
  dir,
  live,
  refreshEngine,
  refreshRcon,
  javaPath,
}: {
  dir: string;
  live: boolean;
  refreshEngine: () => void;
  refreshRcon: () => void;
  javaPath: string;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PropsForm>(DEFAULT_FORM);
  const [raw, setRaw] = useState('');
  const [xms, setXms] = useState('1024');
  const [xmx, setXmx] = useState('2048');
  const [aikar, setAikar] = useState(false);
  // RCON settings (also written into server.properties so the live console works).
  const [rconEnabled, setRconEnabled] = useState(false);
  const [rconPort, setRconPort] = useState('25575');
  const [rconPass, setRconPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$p = Join-Path $d 'server.properties'
if(Test-Path $p){ Get-Content $p -Raw } else { '' }`);
      const text = res.stdout;
      setRaw(text);
      // Parse key=value lines into the form.
      const map: Record<string, string> = {};
      for (const line of text.replace(/\r/g, '').split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        const i = l.indexOf('=');
        if (i <= 0) continue;
        map[l.slice(0, i).trim()] = l.slice(i + 1);
      }
      setForm({
        port: map['server-port'] ?? '25565',
        motd: map['motd'] ?? 'A Minecraft Server',
        gamemode: map['gamemode'] ?? 'survival',
        difficulty: map['difficulty'] ?? 'easy',
        maxPlayers: map['max-players'] ?? '20',
        onlineMode: (map['online-mode'] ?? 'true').toLowerCase() !== 'false',
        whitelist: (map['white-list'] ?? 'false').toLowerCase() === 'true',
        pvp: (map['pvp'] ?? 'true').toLowerCase() !== 'false',
        seed: map['level-seed'] ?? '',
      });
      setRconEnabled((map['enable-rcon'] ?? 'false').toLowerCase() === 'true');
      setRconPort(map['rcon.port'] ?? '25575');
      setRconPass(map['rcon.password'] ?? '');
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }, [dir, live]);

  // Load form + raw on first render / folder change.
  useMemo(() => { load(); }, [load]);

  // Merge-write the given key=value pairs, preserving other lines.
  const writeProps = async (updates: Record<string, string>) => {
    const pairs = Object.entries(updates)
      .map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, ' ')}`)
      .join('\n');
    const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
$p = Join-Path $d 'server.properties'
$updates = @{}
@'
${psq(pairs)}
'@ -split "\`n" | ForEach-Object { $i = $_.IndexOf('='); if($i -gt 0){ $updates[$_.Substring(0,$i).Trim()] = $_.Substring($i+1) } }
$lines = if(Test-Path $p){ @(Get-Content $p) } else { @() }
$remaining = @{}; foreach($k in $updates.Keys){ $remaining[$k] = $updates[$k] }
for($idx=0; $idx -lt $lines.Count; $idx++){
  $line = $lines[$idx].Trim()
  if($line.Length -eq 0 -or $line.StartsWith('#')){ continue }
  $i = $line.IndexOf('='); if($i -le 0){ continue }
  $key = $line.Substring(0,$i).Trim()
  if($remaining.ContainsKey($key)){ $lines[$idx] = "$key=$($remaining[$key])"; $remaining.Remove($key) }
}
foreach($k in @($remaining.Keys)){ $lines += "$k=$($remaining[$k])" }
Set-Content -Path $p -Value $lines -Encoding utf8
'ok'`);
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
  };

  const saveForm = async () => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      await writeProps({
        'server-port': form.port,
        motd: form.motd,
        gamemode: form.gamemode,
        difficulty: form.difficulty,
        'max-players': form.maxPlayers,
        'online-mode': form.onlineMode ? 'true' : 'false',
        'white-list': form.whitelist ? 'true' : 'false',
        pvp: form.pvp ? 'true' : 'false',
        'level-seed': form.seed,
      });
      setMsg({ ok: true, text: t('mcserver.propsSaved') });
      load();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.propsFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const saveRcon = async () => {
    if (!live) return;
    if (rconEnabled && !rconPass.trim()) {
      setMsg({ ok: false, text: t('mcserver.rconNeedPass') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await writeProps({
        'enable-rcon': rconEnabled ? 'true' : 'false',
        'rcon.port': rconPort.trim() || '25575',
        'rcon.password': rconPass,
        'broadcast-rcon-to-ops': 'true',
      });
      setMsg({ ok: true, text: t('mcserver.rconSaved') });
      load();
      refreshRcon();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.propsFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const genPass = () => {
    // Generate a random 16-char RCON password client-side (never logged).
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    const rnd = new Uint32Array(16);
    (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(rnd);
    for (let i = 0; i < 16; i++) out += chars[(rnd[i] ?? Math.floor(Math.random() * 1e9)) % chars.length];
    setRconPass(out);
    setShowPass(true);
  };

  const saveRaw = async () => {
    if (!live) return;
    if (!confirm(t('mcserver.confirmRaw'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
$body = @'
${psq(raw)}
'@
Set-Content -Path (Join-Path $d 'server.properties') -Value $body -Encoding utf8
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.propsSaved') });
      load();
      refreshRcon();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.propsFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const genStart = async () => {
    if (!live) return;
    let lo = parseInt(xms, 10) || 1024;
    let hi = parseInt(xmx, 10) || 2048;
    if (lo > hi) [lo, hi] = [hi, lo];
    setBusy(true);
    setMsg(null);
    try {
      const javaCmd = javaPath ? `"${javaPath}"` : 'java';
      const flags = `-Xms${lo}M -Xmx${hi}M${aikar ? ' ' + AIKAR_FLAGS : ''}`;
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
New-Item -ItemType Directory -Force -Path $d | Out-Null
$script = "@echo off\`r\`ncd /d ""%~dp0""\`r\`n${psq(javaCmd)} ${psq(flags)} -jar server.jar nogui\`r\`npause\`r\`n"
Set-Content -Path (Join-Path $d 'start.bat') -Value $script -NoNewline -Encoding ascii
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.startWritten', { lo, hi }) });
      refreshEngine();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof PropsForm, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      {/* Key fields */}
      <Card first>
        <strong>{t('mcserver.propsTitle')}</strong>
        <div style={FORM_STYLE}>
          <label>{t('mcserver.port')}</label>
          <input className="mod-search" type="number" min={1} max={65535} value={form.port}
            onChange={(e) => field('port', e.target.value)} disabled={!live} />
          <label>{t('mcserver.motd')}</label>
          <input className="mod-search" value={form.motd} onChange={(e) => field('motd', e.target.value)} disabled={!live} />
          <label>{t('mcserver.gamemode')}</label>
          <select className="mod-search" value={form.gamemode} onChange={(e) => field('gamemode', e.target.value)} disabled={!live}>
            {GAMEMODES.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <label>{t('mcserver.difficulty')}</label>
          <select className="mod-search" value={form.difficulty} onChange={(e) => field('difficulty', e.target.value)} disabled={!live}>
            {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <label>{t('mcserver.maxPlayers')}</label>
          <input className="mod-search" type="number" min={1} max={1000} value={form.maxPlayers}
            onChange={(e) => field('maxPlayers', e.target.value)} disabled={!live} />
          <label>{t('mcserver.onlineMode')}</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.onlineMode} onChange={(e) => field('onlineMode', e.target.checked)} disabled={!live} />
            {t('mcserver.onlineHint')}
          </label>
          <label>{t('mcserver.whitelistProp')}</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.whitelist} onChange={(e) => field('whitelist', e.target.checked)} disabled={!live} />
            {t('mcserver.whitelistHint')}
          </label>
          <label>{t('mcserver.pvp')}</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.pvp} onChange={(e) => field('pvp', e.target.checked)} disabled={!live} />
            {t('mcserver.pvpHint')}
          </label>
          <label>{t('mcserver.seed')}</label>
          <input className="mod-search" value={form.seed} onChange={(e) => field('seed', e.target.value)} disabled={!live} />
        </div>
        <div className="mod-toolbar">
          <button className="mini" onClick={load} disabled={busy || !live}>{t('mcserver.reload')}</button>
          <button className="mini primary" onClick={saveForm} disabled={busy || !live}>{t('mcserver.saveProps')}</button>
        </div>
      </Card>

      {/* RCON (remote console — powers the live command box) */}
      <Card>
        <strong>{t('mcserver.rconTitle')}</strong>
        <p className="count-note">{t('mcserver.rconBlurb')}</p>
        <div style={FORM_STYLE}>
          <label>{t('mcserver.rconEnable')}</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={rconEnabled} onChange={(e) => setRconEnabled(e.target.checked)} disabled={!live} />
            {t('mcserver.rconEnableHint')}
          </label>
          <label>{t('mcserver.rconPort')}</label>
          <input className="mod-search" style={{ width: 140 }} type="number" min={1} max={65535} value={rconPort}
            onChange={(e) => setRconPort(e.target.value)} disabled={!live} />
          <label>{t('mcserver.rconPassword')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="mod-search" style={{ minWidth: 200, fontFamily: 'monospace' }}
              type={showPass ? 'text' : 'password'} value={rconPass}
              onChange={(e) => setRconPass(e.target.value)} disabled={!live}
              placeholder={t('mcserver.rconPasswordPh')} autoComplete="off" />
            <button className="mini" onClick={() => setShowPass((s) => !s)} disabled={!live}>
              {showPass ? t('mcserver.hide') : t('mcserver.show')}
            </button>
            <button className="mini" onClick={genPass} disabled={!live}>{t('mcserver.rconGen')}</button>
          </div>
        </div>
        <button className="mini primary" onClick={saveRcon} disabled={busy || !live}>{t('mcserver.rconSave')}</button>
      </Card>

      {/* Memory + start script */}
      <Card>
        <strong>{t('mcserver.memTitle')}</strong>
        <div className="mod-toolbar">
          <label>{t('mcserver.xms')}</label>
          <input className="mod-search" style={{ width: 120 }} type="number" value={xms} onChange={(e) => setXms(e.target.value)} disabled={!live} />
          <label>{t('mcserver.xmx')}</label>
          <input className="mod-search" style={{ width: 120 }} type="number" value={xmx} onChange={(e) => setXmx(e.target.value)} disabled={!live} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={aikar} onChange={(e) => setAikar(e.target.checked)} disabled={!live} />
            {t('mcserver.aikar')}
          </label>
          <button className="mini" onClick={genStart} disabled={busy || !live}>{t('mcserver.genStart')}</button>
        </div>
      </Card>

      {/* Raw editor */}
      <Card>
        <strong>{t('mcserver.rawTitle')}</strong>
        <textarea
          className="hosts-edit"
          style={{ minHeight: 200, whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto' }}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          disabled={!live}
        />
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini" onClick={load} disabled={busy || !live}>{t('mcserver.rawReload')}</button>
          <button className="mini" onClick={saveRaw} disabled={busy || !live}>{t('mcserver.rawSave')}</button>
        </div>
      </Card>

      <MsgLine msg={msg} />
    </div>
  );
}

// ════════════════════════════ Console tab ═══════════════════════════════════
function ConsoleTab({ dir, live, engine, rcon, refreshEngine }: TabProps & { rcon: RconInfo }) {
  const { t } = useTranslation();
  const [out, setOut] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<boolean | null>(null);
  const [cmd, setCmd] = useState('');
  const [sending, setSending] = useState(false);

  const checkRunning = useCallback(async () => {
    if (!live) return;
    try {
      const rows = await runPowershellJson<{ n: number }>(`
$p = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server.jar*' }
[pscustomobject]@{ n = @($p).Count }`);
      setRunning((rows[0]?.n ?? 0) > 0);
    } catch {
      setRunning(null);
    }
  }, [live]);

  useMemo(() => { checkRunning(); }, [checkRunning]);

  const canStart = !!engine?.serverJar && !!engine?.hasJava && !!engine?.eula;

  const start = async () => {
    if (!live) return;
    if (!canStart) {
      setMsg({ ok: false, text: t('mcserver.cantStart') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // Spawn start.bat (generated on the Properties tab) if present; otherwise
      // launch server.jar directly in a new window with default memory.
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$bat = Join-Path $d 'start.bat'
if(Test-Path $bat){
  Start-Process -FilePath $bat -WorkingDirectory $d
} else {
  Start-Process -FilePath '${psq(engine?.java || 'java')}' -WorkingDirectory $d -ArgumentList '-Xms1024M','-Xmx2048M','-jar','server.jar','nogui'
}
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.starting') });
      setTimeout(() => { checkRunning(); refreshEngine(); }, 800);
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Graceful stop: prefer RCON `stop` (clean save), else terminate the java tree.
  const stop = async (force: boolean) => {
    if (!live) return;
    if (!confirm(t(force ? 'mcserver.confirmKill' : 'mcserver.confirmStop'))) return;
    setBusy(true);
    setMsg(null);
    try {
      if (!force && rcon.enabled && rcon.password) {
        try {
          await sendRcon('stop');
          setMsg({ ok: true, text: t('mcserver.stopSent') });
          setTimeout(checkRunning, 1500);
          return;
        } catch {
          // fall through to hard terminate if RCON is unreachable
        }
      }
      const res = await runPowershell(`
Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server.jar*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.stopped') });
      setTimeout(checkRunning, 500);
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const tail = async () => {
    if (!live) return;
    setBusy(true);
    try {
      const res = await runPowershell(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$log = Join-Path $d 'logs\\latest.log'
if(Test-Path $log){ Get-Content $log -Tail 400 -ErrorAction SilentlyContinue | Out-String } else { '(no logs/latest.log yet)' }`);
      setOut(res.stdout.trim() || t('mcserver.logEmpty'));
    } finally {
      setBusy(false);
      checkRunning();
    }
  };

  // Fire a single RCON command; returns the server's textual reply.
  const sendRcon = useCallback(async (command: string): Promise<string> => {
    const res = await runPowershell(`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
${RCON_FN}
$out = Send-Rcon '127.0.0.1' ${parseInt(rcon.port, 10) || 25575} '${psq(rcon.password)}' '${psq(command)}'
$out`);
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    return res.stdout.replace(/\s+$/, '');
  }, [rcon.port, rcon.password]);

  const send = async () => {
    if (!live) return;
    const command = cmd.trim();
    if (!command) return;
    if (!rcon.enabled || !rcon.password) {
      setMsg({ ok: false, text: t('mcserver.rconNotSet') });
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      const reply = await sendRcon(command);
      setOut((o) => `${o}${o ? '\n' : ''}> ${command}${reply ? '\n' + reply : ''}`);
      setCmd('');
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.rconFailed')}: ${String(e)}` });
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini primary" onClick={start} disabled={busy || !live || !canStart}>
          {t('mcserver.startServer')}
        </button>
        <button className="mini" onClick={() => stop(false)} disabled={busy || !live || running === false}>
          {t('mcserver.stopServer')}
        </button>
        <button className="mini" onClick={() => stop(true)} disabled={busy || !live || running === false}>
          {t('mcserver.forceStop')}
        </button>
        <button className="mini" onClick={tail} disabled={busy || !live}>
          {t('mcserver.tailLog')}
        </button>
        {running !== null && (
          <StatusDot ok={!!running} label={running ? t('mcserver.running') : t('mcserver.stoppedState')} />
        )}
      </div>
      {!canStart && engine && (
        <p className="count-note">
          {!engine.serverJar ? t('mcserver.needJar') : !engine.eula ? t('mcserver.needEula') : !engine.hasJava ? t('mcserver.needJava') : ''}
        </p>
      )}
      <p className="count-note">{t('mcserver.consoleHint')}</p>
      {out && (
        <pre className="cmd-out" style={{ maxHeight: 460, overflow: 'auto' }}>{out}</pre>
      )}

      {/* Live RCON command box */}
      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 240, fontFamily: 'monospace' }}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder={t('mcserver.cmdPlaceholder')}
          disabled={!live}
        />
        <button className="mini primary" onClick={send} disabled={!live || sending || !cmd.trim()}>
          {t('mcserver.send')}
        </button>
      </div>
      {(!rcon.enabled || !rcon.password) && (
        <p className="count-note">{t('mcserver.rconNotSet')}</p>
      )}

      <MsgLine msg={msg} />
    </div>
  );
}

// ════════════════════════════ World tab (backups) ═══════════════════════════
interface Backup {
  name: string;
  size: number;
  modified: string;
}
function WorldTab({ dir, live }: { dir: string; live: boolean }) {
  const { t } = useTranslation();
  const [world, setWorld] = useState('world');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!live) return;
    try {
      const rows = await runPowershellJson<Backup>(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$bd = Join-Path $d 'backups'
if(Test-Path $bd){
  Get-ChildItem -Path $bd -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending | ForEach-Object {
    [pscustomobject]@{ name=$_.Name; size=[int64]$_.Length; modified=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }
  }
} else { @() }`);
      setBackups(rows);
    } catch {
      setBackups([]);
    }
  }, [dir, live]);

  useMemo(() => { refresh(); }, [refresh]);

  const backupNow = async () => {
    if (!live) return;
    const w = world.trim() || 'world';
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$wp = Join-Path $d '${psq(w)}'
if(-not (Test-Path $wp)){ throw "World folder '${psq(w)}' not found in the server directory." }
$bd = Join-Path $d 'backups'; New-Item -ItemType Directory -Force -Path $bd | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zip = Join-Path $bd ('${psq(w)}-' + $stamp + '.zip')
Compress-Archive -Path $wp -DestinationPath $zip -CompressionLevel Optimal -Force
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
"Backed up '${psq(w)}' -> backups/$(Split-Path $zip -Leaf) ($mb MB)"`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: res.stdout.trim() });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.backupFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const deleteBackup = async (name: string) => {
    if (!live) return;
    if (!confirm(t('mcserver.confirmDelBackup', { name }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$f = Join-Path (Join-Path $d 'backups') '${psq(name)}'
if(Test-Path $f){ Remove-Item $f -Force }
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.backupDeleted', { name }) });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const openBackups = async () => {
    if (!live) return;
    await runPowershell(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$bd = Join-Path $d 'backups'
New-Item -ItemType Directory -Force -Path $bd | Out-Null
Start-Process explorer.exe $bd`);
  };

  const fmtSize = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  return (
    <div>
      <Card first>
        <strong>{t('mcserver.backupTitle')}</strong>
        <p className="count-note">{t('mcserver.backupBlurb')}</p>
        <div className="mod-toolbar">
          <label>{t('mcserver.worldFolder')}</label>
          <input className="mod-search" style={{ width: 200 }} value={world} onChange={(e) => setWorld(e.target.value)} disabled={!live} placeholder="world" />
          <button className="mini primary" onClick={backupNow} disabled={busy || !live}>{t('mcserver.backupNow')}</button>
          <button className="mini" onClick={openBackups} disabled={!live}>{t('mcserver.openBackups')}</button>
          <button className="mini" onClick={refresh} disabled={!live}>⟳ {t('modules.refresh')}</button>
        </div>
        <p className="count-note">{t('mcserver.backupStopHint')}</p>
      </Card>

      <Card>
        <div className="mod-toolbar">
          <strong>{t('mcserver.backupsList')}</strong>
          <span className="count-note">{t('mcserver.backupCount', { num: backups.length })}</span>
        </div>
        {backups.length === 0 ? (
          <p className="count-note">{t('mcserver.noBackups')}</p>
        ) : (
          <div className="dt-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('mcserver.backupName')}</th>
                  <th style={{ width: 100 }}>{t('mcserver.backupSize')}</th>
                  <th style={{ width: 140 }}>{t('mcserver.backupDate')}</th>
                  <th style={{ width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.name}>
                    <td style={{ fontFamily: 'monospace' }}>{b.name}</td>
                    <td>{fmtSize(b.size)}</td>
                    <td>{b.modified}</td>
                    <td>
                      <button className="mini" onClick={() => deleteBackup(b.name)} disabled={busy || !live}>
                        {t('mcserver.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <MsgLine msg={msg} />
    </div>
  );
}

// ════════════════════════════ Players tab ═══════════════════════════════════
// Online players come from RCON `list`; ops / whitelist / bans are read from the
// server's json files (ops.json, whitelist.json, banned-players.json) and edited
// via RCON commands when running or by writing the json directly when stopped.
type ListKind = 'op' | 'whitelist' | 'ban';

function PlayersTab({ dir, live, rcon }: { dir: string; live: boolean; rcon: RconInfo }) {
  const { t } = useTranslation();
  const [online, setOnline] = useState<string[]>([]);
  const [ops, setOps] = useState<string[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [bans, setBans] = useState<string[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [addName, setAddName] = useState<Record<ListKind, string>>({ op: '', whitelist: '', ban: '' });

  const rconReady = rcon.enabled && !!rcon.password;

  // Read the json files (names) that the server maintains on disk.
  const refreshFiles = useCallback(async () => {
    if (!live) return;
    try {
      const rows = await runPowershellJson<{ kind: string; name: string }>(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
function Names($file,$prop){
  $p = Join-Path $d $file
  if(-not (Test-Path $p)){ return @() }
  try {
    $j = Get-Content $p -Raw | ConvertFrom-Json
    if($null -eq $j){ return @() }
    return @($j | ForEach-Object { $_.$prop } | Where-Object { $_ })
  } catch { return @() }
}
$out = @()
foreach($n in (Names 'ops.json' 'name')){ $out += [pscustomobject]@{ kind='op'; name=$n } }
foreach($n in (Names 'whitelist.json' 'name')){ $out += [pscustomobject]@{ kind='whitelist'; name=$n } }
foreach($n in (Names 'banned-players.json' 'name')){ $out += [pscustomobject]@{ kind='ban'; name=$n } }
$out`);
      const o: string[] = [], w: string[] = [], b: string[] = [];
      for (const r of rows) {
        if (r.kind === 'op') o.push(r.name);
        else if (r.kind === 'whitelist') w.push(r.name);
        else if (r.kind === 'ban') b.push(r.name);
      }
      setOps(o); setWhitelist(w); setBans(b);
    } catch {
      setOps([]); setWhitelist([]); setBans([]);
    }
  }, [dir, live]);

  const checkRunning = useCallback(async () => {
    if (!live) { setRunning(false); return; }
    try {
      const rows = await runPowershellJson<{ n: number }>(`
$p = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server.jar*' }
[pscustomobject]@{ n = @($p).Count }`);
      setRunning((rows[0]?.n ?? 0) > 0);
    } catch {
      setRunning(false);
    }
  }, [live]);

  useMemo(() => { refreshFiles(); checkRunning(); }, [refreshFiles, checkRunning]);

  // Send one RCON command and return its reply (used for live edits + `list`).
  const rconCmd = useCallback(async (command: string): Promise<string> => {
    const res = await runPowershell(`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
${RCON_FN}
$out = Send-Rcon '127.0.0.1' ${parseInt(rcon.port, 10) || 25575} '${psq(rcon.password)}' '${psq(command)}'
$out`);
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    return res.stdout.replace(/\s+$/, '');
  }, [rcon.port, rcon.password]);

  const listOnline = async () => {
    if (!live) return;
    if (!rconReady) { setMsg({ ok: false, text: t('mcserver.rconNotSet') }); return; }
    setBusy(true); setMsg(null);
    try {
      // Reply looks like: "There are 2 of a max of 20 players online: Alice, Bob"
      const reply = await rconCmd('list');
      const after = reply.split(':').slice(1).join(':').trim();
      const names = after ? after.split(',').map((s) => s.trim()).filter(Boolean) : [];
      setOnline(names);
      setMsg({ ok: true, text: reply });
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.rconFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  // Add or remove a name from an op/whitelist/ban list. When the server is
  // running with RCON we issue the real command; otherwise we edit the json file
  // directly so the change takes effect at next start.
  const mutate = async (kind: ListKind, name: string, add: boolean) => {
    if (!live) return;
    const nm = safeName(name);
    if (!nm) { setMsg({ ok: false, text: t('mcserver.needName') }); return; }
    if (!add && (kind === 'op' || kind === 'ban')) {
      if (!confirm(t(kind === 'op' ? 'mcserver.confirmDeop' : 'mcserver.confirmPardon', { name: nm }))) return;
    }
    if (add && kind === 'ban') {
      if (!confirm(t('mcserver.confirmBan', { name: nm }))) return;
    }
    setBusy(true); setMsg(null);
    try {
      if (running && rconReady) {
        const cmd =
          kind === 'op' ? (add ? `op ${nm}` : `deop ${nm}`)
            : kind === 'whitelist' ? (add ? `whitelist add ${nm}` : `whitelist remove ${nm}`)
              : (add ? `ban ${nm}` : `pardon ${nm}`);
        const reply = await rconCmd(cmd);
        setMsg({ ok: true, text: reply || t('mcserver.done') });
      } else {
        // Edit the json file directly (server stopped / no RCON).
        const file = kind === 'op' ? 'ops.json' : kind === 'whitelist' ? 'whitelist.json' : 'banned-players.json';
        const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$p = Join-Path $d '${file}'
$arr = @()
if(Test-Path $p){ try { $arr = @(Get-Content $p -Raw | ConvertFrom-Json) } catch { $arr = @() } }
$arr = @($arr | Where-Object { $_ -and $_.name -and ($_.name -ne '${psq(nm)}') })
${add ? `
$entry = [pscustomobject]@{ uuid=''; name='${psq(nm)}'${kind === 'op' ? '; level=4; bypassesPlayerLimit=$false' : kind === 'ban' ? "; source='WinForge'; expires='forever'; reason='Banned by an operator.'" : ''} }
$arr += $entry` : ''}
$json = if($arr.Count -eq 0){ '[]' } else { ,$arr | ConvertTo-Json -Depth 5 }
Set-Content -Path $p -Value $json -Encoding utf8
'ok'`);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        setMsg({ ok: true, text: t('mcserver.fileEdited', { file }) });
      }
      setAddName((s) => ({ ...s, [kind]: '' }));
      refreshFiles();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const ListCard = ({ kind, title, blurb, names }: { kind: ListKind; title: string; blurb: string; names: string[] }) => (
    <Card>
      <strong>{title}</strong>
      <p className="count-note">{blurb}</p>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ width: 200 }}
          value={addName[kind]}
          onChange={(e) => setAddName((s) => ({ ...s, [kind]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); mutate(kind, addName[kind], true); } }}
          placeholder={t('mcserver.playerName')}
          disabled={!live}
        />
        <button className="mini primary" onClick={() => mutate(kind, addName[kind], true)} disabled={busy || !live || !addName[kind].trim()}>
          {kind === 'ban' ? t('mcserver.ban') : kind === 'op' ? t('mcserver.opAdd') : t('mcserver.wlAdd')}
        </button>
      </div>
      {names.length === 0 ? (
        <p className="count-note">{t('mcserver.listEmpty')}</p>
      ) : (
        <div className="dt-wrap" style={{ marginTop: 6 }}>
          <table className="dt">
            <tbody>
              {names.map((n) => (
                <tr key={n}>
                  <td style={{ fontFamily: 'monospace' }}>{n}</td>
                  <td style={{ width: 90 }}>
                    <button className="mini" onClick={() => mutate(kind, n, false)} disabled={busy || !live}>
                      {kind === 'ban' ? t('mcserver.pardon') : kind === 'op' ? t('mcserver.deop') : t('mcserver.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  return (
    <div>
      {/* Online players */}
      <Card first>
        <div className="mod-toolbar">
          <strong>{t('mcserver.onlineTitle')}</strong>
          <button className="mini" onClick={listOnline} disabled={busy || !live}>{t('mcserver.listOnline')}</button>
          <button className="mini" onClick={() => { refreshFiles(); checkRunning(); }} disabled={!live}>⟳ {t('modules.refresh')}</button>
          <StatusDot ok={running} label={running ? t('mcserver.running') : t('mcserver.stoppedState')} />
        </div>
        <p className="count-note">{t('mcserver.playersHint')}</p>
        {!rconReady && <p className="count-note">{t('mcserver.rconNotSet')}</p>}
        {online.length === 0 ? (
          <p className="count-note">{t('mcserver.noOnline')}</p>
        ) : (
          <ul className="count-note" style={{ fontFamily: 'monospace', margin: '6px 0 0' }}>
            {online.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </Card>

      <ListCard kind="op" title={t('mcserver.opsTitle')} blurb={t('mcserver.opsBlurb')} names={ops} />
      <ListCard kind="whitelist" title={t('mcserver.whitelistTitle')} blurb={t('mcserver.whitelistBlurb')} names={whitelist} />
      <ListCard kind="ban" title={t('mcserver.bansTitle')} blurb={t('mcserver.bansBlurb')} names={bans} />

      <MsgLine msg={msg} />
    </div>
  );
}

// ════════════════════════════ Plugins tab ═══════════════════════════════════
function PluginsTab({ dir, live, engine, refreshEngine }: TabProps) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [installed, setInstalled] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [sys, setSys] = useState<BuildSys>('auto');

  const refreshInstalled = useCallback(async () => {
    if (!live) return;
    try {
      const rows = await runPowershellJson<string>(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$pd = Join-Path $d 'plugins'
if(Test-Path $pd){ Get-ChildItem -Path $pd -Filter '*.jar' -File | ForEach-Object { $_.Name } } else { @() }`);
      setInstalled(rows);
    } catch {
      setInstalled([]);
    }
  }, [dir, live]);

  useMemo(() => { refreshInstalled(); }, [refreshInstalled]);

  // Enable/disable a plugin by toggling its .jar <-> .jar.disabled extension.
  const togglePlugin = async (jar: string, enable: boolean) => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$pd = Join-Path $d 'plugins'
$src = Join-Path $pd '${psq(jar)}'
if(-not (Test-Path $src)){ throw 'Plugin file not found.' }
${enable
          ? `$dst = Join-Path $pd ('${psq(jar)}' -replace '\\.disabled$','')`
          : `$dst = "$src.disabled"`}
Move-Item -Path $src -Destination $dst -Force
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: enable ? t('mcserver.pluginEnabled', { name: jar }) : t('mcserver.pluginDisabled', { name: jar }) });
      refreshInstalled();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removePlugin = async (jar: string) => {
    if (!live) return;
    if (!confirm(t('mcserver.confirmRemovePlugin', { name: jar }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$f = Join-Path (Join-Path $d 'plugins') '${psq(jar)}'
if(Test-Path $f){ Remove-Item $f -Force }
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.pluginRemoved', { name: jar }) });
      refreshInstalled();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const build = async (pName: string, pUrl: string, pSys: BuildSys) => {
    if (!live) return;
    if (!pUrl.trim()) {
      setMsg({ ok: false, text: t('mcserver.needUrl') });
      return;
    }
    if (!engine?.git) {
      setMsg({ ok: false, text: t('mcserver.needGit') });
      return;
    }
    if (!confirm(t('mcserver.confirmBuild', { name: pName }))) return;
    setBusy(true);
    setMsg(null);
    setLog(`=== ${pName} ===\n`);
    try {
      const safe = pName.replace(/[^\w.-]/g, '') || 'plugin';
      const res = await runPowershell(`
$ErrorActionPreference='Continue'
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$work = Join-Path $d 'plugin-build'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$checkout = Join-Path $work '${psq(safe)}'
if(Test-Path (Join-Path $checkout '.git')){
  Write-Output "[git] updating"
  Push-Location $checkout; git pull --ff-only 2>&1 | Out-String; Pop-Location
} else {
  if(Test-Path $checkout){ Remove-Item $checkout -Recurse -Force }
  Write-Output "[git] cloning ${psq(pUrl.trim())}"
  git clone --depth 1 '${psq(pUrl.trim())}' $checkout 2>&1 | Out-String
}
if(-not (Test-Path $checkout)){ throw 'git clone failed.' }
$sys = '${pSys}'
if($sys -eq 'auto'){
  if((Test-Path (Join-Path $checkout 'gradlew.bat')) -or (Test-Path (Join-Path $checkout 'build.gradle')) -or (Test-Path (Join-Path $checkout 'build.gradle.kts'))){ $sys='gradle' }
  elseif(Test-Path (Join-Path $checkout 'pom.xml')){ $sys='maven' }
  else { throw 'No pom.xml / build.gradle found in the repo.' }
}
$before = @{}; Get-ChildItem -Path $checkout -Filter '*.jar' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $before[$_.FullName]=$true }
Push-Location $checkout
if($sys -eq 'maven'){
  Write-Output "[maven] mvn -B -DskipTests package"
  mvn -B -DskipTests package 2>&1 | Out-String
} else {
  $gw = Join-Path $checkout 'gradlew.bat'
  if(Test-Path $gw){ Write-Output "[gradle] gradlew shadowJar build"; & $gw shadowJar build -x test --no-daemon 2>&1 | Out-String }
  else { Write-Output "[gradle] gradle shadowJar build"; gradle shadowJar build -x test --no-daemon 2>&1 | Out-String }
}
Pop-Location
$cand = Get-ChildItem -Path $checkout -Filter '*.jar' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { -not $before.ContainsKey($_.FullName) } |
  Where-Object { $_.Name -notmatch 'sources|javadoc' -and $_.FullName -notmatch 'buildtools' } |
  Sort-Object @{E={ if($_.Name -match 'all|shadow'){2}else{0} };Descending=$true}, @{E={$_.Length};Descending=$true}
if(-not $cand){ throw 'Build finished but no plugin jar was found.' }
$jar = $cand[0]
$pd = Join-Path $d 'plugins'; New-Item -ItemType Directory -Force -Path $pd | Out-Null
Copy-Item $jar.FullName (Join-Path $pd $jar.Name) -Force
Write-Output "[done] $($jar.Name) -> plugins/"`);
      setLog(res.stdout);
      if (!res.success && !/\[done\]/.test(res.stdout)) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('mcserver.pluginBuilt', { name: pName }) });
      refreshInstalled();
      refreshEngine();
    } catch (e) {
      setMsg({ ok: false, text: `${t('mcserver.buildFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const openPlugins = async () => {
    if (!live) return;
    await runPowershell(`
$d = [Environment]::ExpandEnvironmentVariables('${psq(dir)}')
$pd = Join-Path $d 'plugins'
New-Item -ItemType Directory -Force -Path $pd | Out-Null
Start-Process explorer.exe $pd`);
  };

  return (
    <div>
      <p className="mod-msg">{t('mcserver.pluginWarn')}</p>

      {/* Presets */}
      <Card first>
        <strong>{t('mcserver.presetTitle')}</strong>
        {PRESETS.map((p) => (
          <div key={p.name} className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{p.name}</strong> <span className="count-note">({p.system})</span>
              <div className="count-note">{t(`mcserver.preset.${p.blurbKey}`)}</div>
            </div>
            <button className="mini" onClick={() => build(p.name, p.url, p.system)} disabled={busy || !live}>
              {t('mcserver.buildToPlugins')}
            </button>
          </div>
        ))}
      </Card>

      {/* Custom git plugin */}
      <Card>
        <strong>{t('mcserver.customTitle')}</strong>
        <div style={FORM_STYLE}>
          <label>{t('mcserver.name')}</label>
          <input className="mod-search" value={name} onChange={(e) => setName(e.target.value)} disabled={!live} placeholder="my-plugin" />
          <label>{t('mcserver.gitUrl')}</label>
          <input className="mod-search" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!live}
            placeholder="https://github.com/owner/repo.git" style={{ fontFamily: 'monospace' }} />
          <label>{t('mcserver.buildSystem')}</label>
          <select className="mod-search" value={sys} onChange={(e) => setSys(e.target.value as BuildSys)} disabled={!live}>
            {BUILD_SYS.map((s) => <option key={s} value={s}>{t(`mcserver.sys.${s}`)}</option>)}
          </select>
        </div>
        <button className="mini primary" onClick={() => build(name.trim() || 'custom-plugin', url, sys)} disabled={busy || !live || !url.trim()}>
          {t('mcserver.cloneBuild')}
        </button>
      </Card>

      {/* Installed plugins */}
      <Card>
        <div className="mod-toolbar">
          <strong>{t('mcserver.installedTitle')}</strong>
          <button className="mini" onClick={refreshInstalled} disabled={!live}>{t('modules.refresh')}</button>
          <button className="mini" onClick={openPlugins} disabled={!live}>{t('mcserver.openPlugins')}</button>
          <span className="count-note">{t('mcserver.pluginCount', { num: installed.length })}</span>
        </div>
        {installed.length === 0 ? (
          <p className="count-note">{t('mcserver.noPlugins')}</p>
        ) : (
          <div className="dt-wrap" style={{ marginTop: 6 }}>
            <table className="dt">
              <tbody>
                {installed.map((j) => {
                  const disabled = j.toLowerCase().endsWith('.disabled');
                  return (
                    <tr key={j}>
                      <td style={{ fontFamily: 'monospace' }}>
                        {j}{disabled && <span className="count-note"> ({t('mcserver.disabledTag')})</span>}
                      </td>
                      <td style={{ width: 170 }}>
                        <span className="row-actions">
                          <button className="mini" onClick={() => togglePlugin(j, disabled)} disabled={busy || !live}>
                            {disabled ? t('mcserver.enable') : t('mcserver.disable')}
                          </button>
                          <button className="mini" onClick={() => removePlugin(j)} disabled={busy || !live}>
                            {t('mcserver.remove')}
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Build log */}
      {log && (
        <Card>
          <strong>{t('mcserver.buildLog')}</strong>
          <pre className="cmd-out" style={{ maxHeight: 260, overflow: 'auto' }}>{log}</pre>
        </Card>
      )}

      <MsgLine msg={msg} />
    </div>
  );
}
