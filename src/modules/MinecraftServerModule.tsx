import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { ModuleToolbar, StatusDot } from './common';

// ============================================================================
// Minecraft Server · Minecraft 伺服器架設器 — module.minecraftserver
//
// Native web port of WinForge's Pages/MinecraftServerModule + Services/
// MinecraftServerService.cs. The desktop original wrapped a Java runtime to
// download a Paper build (PaperMC Fill v3 API), compile Spigot with
// BuildTools.jar, accept the EULA, edit server.properties, run the server with
// a live console, and build plugins from git (Maven/Gradle) into plugins/.
//
// Here we drive the same real workflows through the Tauri backend:
//   • Server tab   — server folder, engine probe (Java / git / mvn / server.jar
//                    / EULA), Paper version list + download (Invoke-RestMethod),
//                    BuildTools download + Spigot build (java -jar BuildTools),
//                    EULA toggle (writes eula.txt).
//   • Properties   — server.properties key-field form, memory + start.bat
//                    generator, raw server.properties editor.
//   • Console      — start (spawns start.bat), stop / force-stop (kills java),
//                    live tail of logs/latest.log.
//   • Plugins      — popular-plugin presets + any git repo → plugins/
//                    (Maven/Gradle), installed jars list, build log.
//
// Everything is filesystem/process/network work done via PowerShell. Mutating
// or code-running actions (EULA write, downloads, builds, start/stop) are
// explicit button clicks; plugin builds run untrusted build scripts and are
// gated behind a confirm, never auto-run.
// ============================================================================

const DEFAULT_DIR = '%USERPROFILE%\\Documents\\MinecraftServer';

const TABS = ['server', 'props', 'console', 'plugins'] as const;
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

interface EngineInfo {
  java: string;
  hasJava: boolean;
  git: boolean;
  maven: boolean;
  serverJar: boolean;
  eula: boolean;
  resolvedDir: string;
}

export function MinecraftServerModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [tab, setTab] = useState<Tab>('server');
  const [dir, setDir] = useState(DEFAULT_DIR);

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

  // Probe on mount and whenever the folder changes.
  useMemo(() => { refreshEngine(); }, [refreshEngine]);

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
        <button className="mini" onClick={refreshEngine}>
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
        {tab === 'props' && <PropsTab dir={dir} live={live} refreshEngine={refreshEngine} javaPath={engine?.java ?? ''} />}
        {tab === 'console' && <ConsoleTab dir={dir} live={live} engine={engine} refreshEngine={refreshEngine} />}
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

      {/* Server folder */}
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
  seed: string;
}
const DEFAULT_FORM: PropsForm = {
  port: '25565',
  motd: 'A Minecraft Server',
  gamemode: 'survival',
  difficulty: 'easy',
  maxPlayers: '20',
  onlineMode: true,
  seed: '',
};

function PropsTab({
  dir,
  live,
  refreshEngine,
  javaPath,
}: {
  dir: string;
  live: boolean;
  refreshEngine: () => void;
  javaPath: string;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PropsForm>(DEFAULT_FORM);
  const [raw, setRaw] = useState('');
  const [xms, setXms] = useState('1024');
  const [xmx, setXmx] = useState('2048');
  const [aikar, setAikar] = useState(false);
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
        seed: map['level-seed'] ?? '',
      });
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

  const saveRaw = async () => {
    if (!live) return;
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
          <label>{t('mcserver.seed')}</label>
          <input className="mod-search" value={form.seed} onChange={(e) => field('seed', e.target.value)} disabled={!live} />
        </div>
        <div className="mod-toolbar">
          <button className="mini" onClick={load} disabled={busy || !live}>{t('mcserver.reload')}</button>
          <button className="mini primary" onClick={saveForm} disabled={busy || !live}>{t('mcserver.saveProps')}</button>
        </div>
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
function ConsoleTab({ dir, live, engine, refreshEngine }: TabProps) {
  const { t } = useTranslation();
  const [out, setOut] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<boolean | null>(null);

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

  const stop = async (force: boolean) => {
    if (!live) return;
    if (!confirm(t(force ? 'mcserver.confirmKill' : 'mcserver.confirmStop'))) return;
    setBusy(true);
    setMsg(null);
    try {
      // Kill the java process(es) hosting server.jar (graceful stdin isn't
      // available to a detached process here, so both stop + force terminate).
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
          <ul className="count-note" style={{ fontFamily: 'monospace', margin: 0 }}>
            {installed.map((j) => <li key={j}>{j}</li>)}
          </ul>
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
