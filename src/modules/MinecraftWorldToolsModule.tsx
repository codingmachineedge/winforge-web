// Minecraft World Tools — full web parity port of
// WinForge/Pages/MinecraftWorldToolsModule.xaml(.cs) + Services/MinecraftWorldToolsService.cs.
//
// Feature surface (36 C# controls across 4 sub-tabs):
//   Chunker  — Python/Chunker CLI probe (Re-check + gated Install via pip --user),
//              world folder picker with level.dat/region metadata (reusing the
//              in-app world discovery), output folder picker, Preview batches
//              (bounded 500 MB batch planner), Convert in batches (gated + confirm),
//              Cancel, and a live batch list.
//   BlueMap  — output folder picker + Open, Generate config (writes core/webserver/
//              map .conf), Start render (gated, launches java -jar bluemap.jar),
//              Stop (confirm).
//   Settings — WorkDir, Chunker tool (.exe/.jar), Chunker args, Chunker target,
//              batch size (MB), BlueMap jar, BlueMap JVM args, memory (MB),
//              render threads, web port, enable web-server toggle, Save + Reload.
//   Log      — tail of the last run's stdout/stderr with Clear.
//
// Settings persist to localStorage (the web analog of SettingsStore). Reads
// (world discovery, toolchain probe, Python/Chunker detection) auto-run; every
// conversion/render/install/save runs ONLY on an explicit click, and the two
// destructive/long-running mutations (Convert, Start render) confirm first.
// In a plain browser the bridge no-ops and the UI renders with a preview notice.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { resolveTool } from '../tauri/deps';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

/** One discovered Minecraft world, described like the C# DescribeWorld / IsValidWorld surface. */
interface World {
  Name: string;
  Path: string;
  Edition: string; // "Java" | "Bedrock"
  Regions: number;
  SizeMB: number;
  Modified: string;
  Source: string; // save-root label (e.g. .minecraft/saves)
}

/** Toolchain probe: Java + Python presence, mirroring FindJava + ProbePythonAndChunker. */
interface Toolchain {
  JavaFound: boolean;
  JavaVersion: string;
  PythonFound: boolean;
  PythonVersion: string;
}

/** Python + Chunker CLI probe — port of MinecraftWorldToolsService.ProbePythonAndChunkerAsync. */
interface ChunkerProbe {
  PythonFound: boolean;
  PythonCommand: string;
  PythonVersion: string;
  ChunkerFound: boolean;
  ChunkerDetail: string;
}

/** One planned Chunker batch — port of BatchPlan (Index/Files/Bytes). */
interface BatchPlan {
  Index: number;
  Files: number;
  Bytes: number;
}

/** Settings block — mirrors every SettingsStore-backed property of the service. */
interface Settings {
  workDir: string;
  chunkerTool: string;
  chunkerArgs: string;
  chunkerTarget: string;
  chunkerBatchMb: number;
  blueMapJar: string;
  blueMapArgs: string;
  blueMapMemoryMb: number;
  blueMapThreads: number;
  blueMapPort: number;
  blueMapWebServer: boolean;
}

const SETTINGS_KEY = 'mcworldtools.settings';
const WORLD_KEY = 'mcworldtools.world';
const CHUNKER_OUT_KEY = 'mcworldtools.chunkerOut';
const BLUEMAP_OUT_KEY = 'mcworldtools.blueMapOut';

// Service defaults — identical to the C# property fallbacks.
const DEFAULT_SETTINGS: Settings = {
  workDir: '',
  chunkerTool: '',
  chunkerArgs: '--input {input} --output {output} --target {target}',
  chunkerTarget: 'java',
  chunkerBatchMb: 500,
  blueMapJar: '',
  blueMapArgs: '-Xmx{memoryMb}m -jar {jar} -r -c {config} -w {world}',
  blueMapMemoryMb: 4096,
  blueMapThreads: 4,
  blueMapPort: 8100,
  blueMapWebServer: true,
};

const clampInt = (v: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      workDir: typeof parsed.workDir === 'string' ? parsed.workDir : DEFAULT_SETTINGS.workDir,
      chunkerTool: typeof parsed.chunkerTool === 'string' ? parsed.chunkerTool : DEFAULT_SETTINGS.chunkerTool,
      chunkerArgs: typeof parsed.chunkerArgs === 'string' ? parsed.chunkerArgs : DEFAULT_SETTINGS.chunkerArgs,
      chunkerTarget: typeof parsed.chunkerTarget === 'string' ? parsed.chunkerTarget : DEFAULT_SETTINGS.chunkerTarget,
      chunkerBatchMb: clampInt(Number(parsed.chunkerBatchMb), 64, 4096, DEFAULT_SETTINGS.chunkerBatchMb),
      blueMapJar: typeof parsed.blueMapJar === 'string' ? parsed.blueMapJar : DEFAULT_SETTINGS.blueMapJar,
      blueMapArgs: typeof parsed.blueMapArgs === 'string' ? parsed.blueMapArgs : DEFAULT_SETTINGS.blueMapArgs,
      blueMapMemoryMb: clampInt(Number(parsed.blueMapMemoryMb), 512, 131072, DEFAULT_SETTINGS.blueMapMemoryMb),
      blueMapThreads: clampInt(Number(parsed.blueMapThreads), 1, 128, DEFAULT_SETTINGS.blueMapThreads),
      blueMapPort: clampInt(Number(parsed.blueMapPort), 1, 65535, DEFAULT_SETTINGS.blueMapPort),
      blueMapWebServer: typeof parsed.blueMapWebServer === 'boolean' ? parsed.blueMapWebServer : DEFAULT_SETTINGS.blueMapWebServer,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const lsGet = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const lsSet = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

// PowerShell: probe the external toolchain Chunker/BlueMap depend on, read-only (`--version`).
const TOOLCHAIN_PS = String.raw`
$java = ''
try {
  $jv = (& java -version) 2>&1 | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $jv) { $java = ($jv | Out-String).Trim() }
} catch {}
$py = ''
foreach ($cmd in @('python','py')) {
  try {
    $pv = (& $cmd --version) 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and "$pv" -match 'Python') { $py = ("$pv").Trim(); break }
  } catch {}
}
[pscustomobject]@{
  JavaFound   = [bool]$java
  JavaVersion = if ($java) { $java } else { '' }
  PythonFound = [bool]$py
  PythonVersion = if ($py) { $py } else { '' }
}`;

// PowerShell: detect a usable Python launcher then whether the Chunker CLI resolves — port of
// ProbePythonAndChunkerAsync (python then py; `-m chunker --help` then `pip show chunker`).
const CHUNKER_PROBE_PS = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$pyCmd = ''; $pyVer = ''
foreach ($cmd in @('python','py')) {
  try {
    $pv = (& $cmd --version) 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and "$pv" -match 'Python') { $pyCmd = $cmd; $pyVer = ("$pv").Trim(); break }
  } catch {}
}
$chFound = $false; $chDetail = ''
if ($pyCmd) {
  try {
    $help = (& $pyCmd -m chunker --help) 2>&1
    if ($LASTEXITCODE -eq 0) {
      $chFound = $true
      $chDetail = ($help | Where-Object { "$_".Trim().Length -gt 0 } | Select-Object -First 1)
      $chDetail = ("$chDetail").Trim()
    }
  } catch {}
  if (-not $chFound) {
    try {
      $show = (& $pyCmd -m pip show chunker) 2>&1
      if ($LASTEXITCODE -eq 0 -and ("$show" -match 'Name:')) {
        $chFound = $true
        $ver = ($show | Where-Object { "$_" -match '^Version:' } | Select-Object -First 1)
        $chDetail = ("$ver").Trim()
      }
    } catch {}
  }
}
[pscustomobject]@{
  PythonFound = [bool]$pyCmd
  PythonCommand = $pyCmd
  PythonVersion = $pyVer
  ChunkerFound = [bool]$chFound
  ChunkerDetail = $chDetail
}`;

// PowerShell: enumerate Minecraft worlds across standard Java + Bedrock save roots and describe each
// like the C# service (level.dat / region / db detection, size, region-file count, last modified).
const WORLDS_PS = String.raw`
$roots = @()
$appData = $env:APPDATA
$local = $env:LOCALAPPDATA
if ($appData) { $roots += [pscustomobject]@{ Dir = (Join-Path $appData '.minecraft\saves'); Edition='Java'; Label='.minecraft/saves' } }
if ($local) {
  $bedrock = Join-Path $local 'Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\minecraftWorlds'
  $roots += [pscustomobject]@{ Dir = $bedrock; Edition='Bedrock'; Label='Bedrock' }
}
$prof = Join-Path $HOME 'curseforge\minecraft\Instances'
if (Test-Path $prof) { $roots += [pscustomobject]@{ Dir = $prof; Edition='Java'; Label='CurseForge'; Deep=$true } }

$out = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r.Dir)) { continue }
  $dirs = Get-ChildItem -LiteralPath $r.Dir -Directory -ErrorAction SilentlyContinue
  if ($r.PSObject.Properties['Deep']) {
    $dirs = Get-ChildItem -LiteralPath $r.Dir -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'level.dat') }
  }
  foreach ($d in $dirs) {
    $p = $d.FullName
    $isJava = (Test-Path (Join-Path $p 'region')) -or (Test-Path (Join-Path $p 'level.dat'))
    $isBedrock = Test-Path (Join-Path $p 'db')
    if (-not ($isJava -or $isBedrock)) { continue }
    $edition = if ($isBedrock -and -not (Test-Path (Join-Path $p 'region'))) { 'Bedrock' } else { $r.Edition }
    $regions = 0
    foreach ($rd in @('region','DIM-1\region','DIM1\region')) {
      $rp = Join-Path $p $rd
      if (Test-Path $rp) { $regions += (Get-ChildItem -LiteralPath $rp -Filter '*.mca' -ErrorAction SilentlyContinue | Measure-Object).Count }
    }
    $bytes = 0
    try { $bytes = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
    if (-not $bytes) { $bytes = 0 }
    $out += [pscustomobject]@{
      Name = $d.Name
      Path = $p
      Edition = $edition
      Regions = [int]$regions
      SizeMB = [math]::Round($bytes / 1MB, 1)
      Modified = $d.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
      Source = $r.Label
    }
  }
}
$out`;

/** PowerShell single-quote escape. */
const psq = (s: string): string => s.replace(/'/g, "''");

/**
 * Describe an arbitrary world folder (size + region count + validity) — port of
 * IsValidWorld + DescribeWorld for a folder the user typed/picked outside discovery.
 */
function describeWorldPs(folder: string): string {
  const f = psq(folder);
  return String.raw`
$p = '${f}'
if (-not (Test-Path -LiteralPath $p)) {
  [pscustomobject]@{ Valid=$false; SizeMB=0; Regions=0 }
} else {
  $valid = (Test-Path (Join-Path $p 'level.dat')) -or (Test-Path (Join-Path $p 'region')) -or (Test-Path (Join-Path $p 'db'))
  $regions = 0
  foreach ($rd in @('region','DIM-1\region','DIM1\region')) {
    $rp = Join-Path $p $rd
    if (Test-Path $rp) { $regions += (Get-ChildItem -LiteralPath $rp -Filter '*.mca' -ErrorAction SilentlyContinue | Measure-Object).Count }
  }
  $bytes = 0
  try { $bytes = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
  if (-not $bytes) { $bytes = 0 }
  [pscustomobject]@{ Valid=[bool]$valid; SizeMB=[math]::Round($bytes/1MB,1); Regions=[int]$regions }
}`;
}

interface WorldMeta {
  Valid: boolean;
  SizeMB: number;
  Regions: number;
}

/**
 * Plan bounded batches from a world's payload files (all files below the world root),
 * greedily packing to <= maxBytes — the read-only preview half of BuildBatches. No
 * staging/copy happens here; the real convert run stages + invokes the tool natively.
 */
function batchPreviewPs(world: string, maxMb: number): string {
  const f = psq(world);
  const maxBytes = Math.max(64, maxMb) * 1024 * 1024;
  return String.raw`
$p = '${f}'
if (-not (Test-Path -LiteralPath $p)) { return }
$max = ${maxBytes}
$files = Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'session.lock' } |
  Where-Object { $_.DirectoryName -ne (Resolve-Path -LiteralPath $p).Path } |
  Sort-Object FullName
$plans = @(); $index = 1; $curBytes = [long]0; $curFiles = 0
function Flush {
  if ($script:curFiles -eq 0) { return }
  $script:plans += [pscustomobject]@{ Index=$script:index; Files=$script:curFiles; Bytes=$script:curBytes }
  $script:index++; $script:curBytes=[long]0; $script:curFiles=0
}
foreach ($file in $files) {
  $size = [long]$file.Length
  if ($curFiles -gt 0 -and ($curBytes + $size) -gt $max) { Flush }
  $curBytes += $size; $curFiles++
  if ($size -ge $max) { Flush }
}
Flush
$plans`;
}

const fmtMB = (mb: number): string => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
};

const fmtBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
};

export function MinecraftWorldToolsModule() {
  const { t } = useTranslation();
  const tauri = isTauri();

  // ── settings (persisted; the web analog of SettingsStore) ───────────────────────────
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [draft, setDraft] = useState<Settings>(settings); // editable copy for the Settings tab
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  const setDraftField = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const saveSettings = () => {
    const clamped: Settings = {
      ...draft,
      chunkerTarget: draft.chunkerTarget.trim() || 'java',
      chunkerBatchMb: clampInt(draft.chunkerBatchMb, 64, 4096, DEFAULT_SETTINGS.chunkerBatchMb),
      blueMapMemoryMb: clampInt(draft.blueMapMemoryMb, 512, 131072, DEFAULT_SETTINGS.blueMapMemoryMb),
      blueMapThreads: clampInt(draft.blueMapThreads, 1, 128, DEFAULT_SETTINGS.blueMapThreads),
      blueMapPort: clampInt(draft.blueMapPort, 1, 65535, DEFAULT_SETTINGS.blueMapPort),
    };
    setSettings(clamped);
    setDraft(clamped);
    lsSet(SETTINGS_KEY, JSON.stringify(clamped));
    setSettingsMsg(t('mcworldtools.settingsSaved'));
  };

  const reloadSettings = () => {
    const fresh = loadSettings();
    setSettings(fresh);
    setDraft(fresh);
    setSettingsMsg(t('mcworldtools.settingsReloaded'));
  };

  // ── world / output selections (persisted paths) ─────────────────────────────────────
  const [world, setWorld] = useState<string>(() => lsGet(WORLD_KEY));
  const [chunkerOut, setChunkerOut] = useState<string>(() => lsGet(CHUNKER_OUT_KEY));
  const [blueMapOut, setBlueMapOut] = useState<string>(() => lsGet(BLUEMAP_OUT_KEY));
  useEffect(() => lsSet(WORLD_KEY, world), [world]);
  useEffect(() => lsSet(CHUNKER_OUT_KEY, chunkerOut), [chunkerOut]);
  useEffect(() => lsSet(BLUEMAP_OUT_KEY, blueMapOut), [blueMapOut]);

  // ── run log (tailed in the Log tab) ─────────────────────────────────────────────────
  const [log, setLog] = useState<string>('');
  const appendLog = useCallback((line: string) => {
    setLog((prev) => (prev ? `${prev}\n${line}` : line).slice(-200_000));
  }, []);

  // ── world discovery + toolchain probe (read-only, auto-run) ─────────────────────────
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const worlds = useAsync(() => (tauri ? runPowershellJson<World>(WORLDS_PS) : Promise.resolve<World[]>([])), [tauri]);
  const tools = useAsync(async () => {
    if (!tauri) return null;
    const rows = await runPowershellJson<Toolchain>(TOOLCHAIN_PS);
    return rows[0] ?? null;
  }, [tauri]);

  // ── Chunker CLI (Python) detection — auto-run once, re-check on demand ───────────────
  const chunker = useAsync(async () => {
    if (!tauri) return null;
    const rows = await runPowershellJson<ChunkerProbe>(CHUNKER_PROBE_PS);
    return rows[0] ?? null;
  }, [tauri]);
  const [installBusy, setInstallBusy] = useState(false);
  const [chunkerCliMsg, setChunkerCliMsg] = useState<string | null>(null);

  // Install/upgrade the Chunker CLI via a user-scoped pip (no admin) — gated on click.
  const installChunker = async () => {
    const cmd = chunker.data?.PythonCommand;
    if (!cmd) return;
    setInstallBusy(true);
    setChunkerCliMsg(null);
    appendLog(t('mcworldtools.logInstallStart'));
    try {
      const res = await runCommand(cmd, ['-m', 'pip', 'install', '--user', '--upgrade', 'chunker']);
      const body = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
      if (body) appendLog(body);
      if (res.success) {
        setChunkerCliMsg(t('mcworldtools.chunkerInstalled'));
      } else {
        const lastLine = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
        setChunkerCliMsg(t('mcworldtools.chunkerInstallFailed', { error: lastLine || `exit ${res.code}` }));
      }
    } catch (e) {
      setChunkerCliMsg(t('mcworldtools.chunkerInstallFailed', { error: String(e) }));
      appendLog(String(e));
    } finally {
      setInstallBusy(false);
      chunker.reload(); // re-probe so a successful install flips to "ready"
    }
  };

  // ── world metadata for the current selection (level.dat / region summary) ───────────
  const [meta, setMeta] = useState<WorldMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const refreshMeta = useCallback(
    async (folder: string) => {
      if (!folder.trim() || !tauri) {
        setMeta(null);
        return;
      }
      setMetaLoading(true);
      try {
        const rows = await runPowershellJson<WorldMeta>(describeWorldPs(folder));
        setMeta(rows[0] ?? null);
      } catch {
        setMeta(null);
      } finally {
        setMetaLoading(false);
      }
    },
    [tauri],
  );
  useEffect(() => {
    void refreshMeta(world);
  }, [world, refreshMeta]);

  // ── batch preview (read-only planner) ───────────────────────────────────────────────
  const [batches, setBatches] = useState<BatchPlan[] | null>(null);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const previewBatches = async () => {
    if (!world.trim()) {
      setBatchMsg(t('mcworldtools.needWorld'));
      return;
    }
    setBatchBusy(true);
    setBatchMsg(null);
    try {
      const rows = tauri ? await runPowershellJson<BatchPlan>(batchPreviewPs(world, settings.chunkerBatchMb)) : [];
      setBatches(rows);
      setBatchMsg(
        rows.length > 0
          ? t('mcworldtools.batchPlanned', { count: rows.length })
          : t('mcworldtools.batchNone'),
      );
    } catch (e) {
      setBatches([]);
      setBatchMsg(String(e));
    } finally {
      setBatchBusy(false);
    }
  };

  // ── Chunker convert run (gated + confirm) ───────────────────────────────────────────
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertConfirm, setConvertConfirm] = useState(false);
  const convertRunId = useRef(0);

  const startConvert = async () => {
    setConvertConfirm(false);
    if (!world.trim()) {
      appendLog(t('mcworldtools.needWorld'));
      return;
    }
    if (!chunkerOut.trim()) {
      appendLog(t('mcworldtools.needOutput'));
      return;
    }
    if (!settings.chunkerTool.trim()) {
      appendLog(t('mcworldtools.needChunkerTool'));
      return;
    }
    const id = ++convertRunId.current;
    setConvertBusy(true);
    appendLog(t('mcworldtools.logChunkerStart'));
    try {
      if (!tauri) {
        appendLog(t('mcworldtools.previewNoRun'));
        return;
      }
      // Expand the argument template the same way the service does, then resolve a
      // .jar tool through `java -jar`. The whole run streams into the Log tab.
      const isJar = settings.chunkerTool.toLowerCase().endsWith('.jar');
      const argTemplate = settings.chunkerArgs
        .replace(/\{input\}/gi, `"${world}"`)
        .replace(/\{output\}/gi, `"${chunkerOut}"`)
        .replace(/\{world\}/gi, `"${world}"`)
        .replace(/\{target\}/gi, settings.chunkerTarget);
      let file: string;
      let argsStr: string;
      if (isJar) {
        const java = await resolveTool('java');
        file = java.path ?? 'java';
        argsStr = `-jar "${settings.chunkerTool}" ${argTemplate}`;
      } else {
        file = settings.chunkerTool;
        argsStr = argTemplate;
      }
      appendLog(`> ${file} ${argsStr}`);
      // Run via PowerShell so stdout+stderr are captured together for the Log tab.
      const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${psq(file)}' ${argsStr.replace(/`/g, '``')} 2>&1 | Out-String`;
      const res = await runPowershell(script);
      if (convertRunId.current !== id) return; // cancelled — discard late result
      const body = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
      if (body) appendLog(body);
      appendLog(res.success ? t('mcworldtools.chunkerComplete') : t('mcworldtools.chunkerFailed', { code: res.code }));
    } catch (e) {
      if (convertRunId.current === id) appendLog(String(e));
    } finally {
      if (convertRunId.current === id) setConvertBusy(false);
    }
  };

  const cancelConvert = () => {
    if (!convertBusy) return;
    convertRunId.current += 1; // discard the in-flight result
    setConvertBusy(false);
    appendLog(t('mcworldtools.chunkerCancelled'));
  };

  // ── BlueMap ─────────────────────────────────────────────────────────────────────────
  const [blueMapMsg, setBlueMapMsg] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderConfirm, setRenderConfirm] = useState(false);

  // Config dir + the three .conf bodies — a faithful port of GenerateBlueMapConfig.
  const configDir = (settings.workDir.trim() || 'WinForge\\MinecraftWorldTools') + '\\bluemap-config';
  const slash = (s: string) => s.replace(/\\/g, '/');

  const generateConfig = async () => {
    if (!world.trim()) {
      setBlueMapMsg(t('mcworldtools.needWorld'));
      return;
    }
    if (!blueMapOut.trim()) {
      setBlueMapMsg(t('mcworldtools.needBlueMapOut'));
      return;
    }
    setConfigBusy(true);
    setBlueMapMsg(null);
    try {
      if (!tauri) {
        setBlueMapMsg(t('mcworldtools.previewNoRun'));
        return;
      }
      const core = [
        'accept-download: true',
        `render-thread-count: ${settings.blueMapThreads}`,
        `data: "${slash(blueMapOut + '\\data')}"`,
        `webroot: "${slash(blueMapOut + '\\web')}"`,
        'metrics: false',
      ].join('\n');
      const webServer = [
        `enabled: ${settings.blueMapWebServer ? 'true' : 'false'}`,
        `webroot: "${slash((settings.workDir.trim() || 'WinForge\\MinecraftWorldTools') + '\\bluemap-web')}"`,
        `port: ${settings.blueMapPort}`,
      ].join('\n');
      const mapConf = [
        `world: "${slash(world)}"`,
        'dimension: "minecraft:overworld"',
        'name: "Overworld"',
        'enabled: true',
      ].join('\n');
      const script = String.raw`
$dir = '${psq(configDir)}'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'maps') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'web') | Out-Null
New-Item -ItemType Directory -Force -Path '${psq(blueMapOut)}' | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'core.conf') -Value @'
${core}
'@ -Encoding UTF8
Set-Content -LiteralPath (Join-Path $dir 'webserver.conf') -Value @'
${webServer}
'@ -Encoding UTF8
Set-Content -LiteralPath (Join-Path $dir 'maps\overworld.conf') -Value @'
${mapConf}
'@ -Encoding UTF8
'ok'`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setBlueMapMsg(t('mcworldtools.configGenerated', { dir: configDir }));
      appendLog(t('mcworldtools.configGenerated', { dir: configDir }));
    } catch (e) {
      setBlueMapMsg(t('mcworldtools.configFailed', { error: String(e) }));
    } finally {
      setConfigBusy(false);
    }
  };

  const startRender = async () => {
    setRenderConfirm(false);
    if (!settings.blueMapJar.trim()) {
      setBlueMapMsg(t('mcworldtools.needBlueMapJar'));
      return;
    }
    setRenderBusy(true);
    setBlueMapMsg(null);
    appendLog(t('mcworldtools.logBlueMapStart'));
    try {
      if (!tauri) {
        setBlueMapMsg(t('mcworldtools.previewNoRun'));
        appendLog(t('mcworldtools.previewNoRun'));
        return;
      }
      // Ensure config is present, then launch java -jar bluemap.jar in its own window
      // so a long render/web-server does not block the UI (the Stop button kills it).
      await generateConfig();
      const java = await resolveTool('java');
      if (!java.path) {
        setBlueMapMsg(t('mcworldtools.needJava'));
        return;
      }
      const args = settings.blueMapArgs
        .replace(/\{jar\}/gi, `"${settings.blueMapJar}"`)
        .replace(/\{world\}/gi, `"${world}"`)
        .replace(/\{config\}/gi, `"${configDir}"`)
        .replace(/\{memoryMb\}/gi, String(settings.blueMapMemoryMb))
        .replace(/\{threads\}/gi, String(settings.blueMapThreads))
        .replace(/\{port\}/gi, String(settings.blueMapPort));
      const argList = args
        .match(/"[^"]*"|\S+/g)
        ?.map((a) => `'${psq(a)}'`)
        .join(',');
      appendLog(`> ${java.path} ${args}`);
      const res = await runPowershell(
        `Start-Process -FilePath '${psq(java.path)}' -ArgumentList ${argList ?? "''"} -WindowStyle Minimized -PassThru | Select-Object -ExpandProperty Id`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const pid = res.stdout.trim();
      if (pid) lsSet('mcworldtools.blueMapPid', pid);
      setBlueMapMsg(t('mcworldtools.blueMapStarted'));
      appendLog(t('mcworldtools.blueMapStarted'));
    } catch (e) {
      setBlueMapMsg(t('mcworldtools.blueMapFailed', { error: String(e) }));
      appendLog(String(e));
    } finally {
      setRenderBusy(false);
    }
  };

  const stopRender = async () => {
    setBlueMapMsg(null);
    try {
      if (!tauri) {
        setBlueMapMsg(t('mcworldtools.previewNoRun'));
        return;
      }
      const pid = lsGet('mcworldtools.blueMapPid');
      if (!pid) {
        setBlueMapMsg(t('mcworldtools.blueMapNotRunning'));
        return;
      }
      const res = await runPowershell(
        `Stop-Process -Id ${Number(pid) || 0} -Force -ErrorAction SilentlyContinue; 'ok'`,
      );
      lsSet('mcworldtools.blueMapPid', '');
      setBlueMapMsg(res.success ? t('mcworldtools.blueMapStopped') : t('mcworldtools.blueMapNotRunning'));
      appendLog(t('mcworldtools.blueMapStopped'));
    } catch (e) {
      setBlueMapMsg(String(e));
    }
  };

  // ── shared folder helpers (read-only reveal in Explorer) ────────────────────────────
  const openFolder = (path: string) => {
    if (!path.trim() || !tauri) return;
    void runPowershell(
      `New-Item -ItemType Directory -Force -Path '${psq(path)}' | Out-Null; Start-Process explorer.exe -ArgumentList '${psq(path)}'`,
    );
  };
  const copyPath = async (path: string) => {
    setCopied(null);
    try {
      if (tauri) await runPowershell(`Set-Clipboard -Value ${JSON.stringify(path)}`);
      else await navigator.clipboard.writeText(path);
      setCopied(path);
    } catch {
      setCopied(null);
    }
  };

  // ── world discovery table (fold-in of the original module surface) ──────────────────
  const rows = useMemo(() => {
    const all = worlds.data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((w) => `${w.Name} ${w.Edition} ${w.Source}`.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => b.SizeMB - a.SizeMB);
  }, [worlds.data, filter]);
  const totalMB = useMemo(() => rows.reduce((s, w) => s + (w.SizeMB || 0), 0), [rows]);

  const worldColumns: Column<World>[] = [
    {
      key: 'Edition',
      header: t('mcworldtools.edition'),
      width: 96,
      render: (w) => <StatusDot ok={w.Edition === 'Java'} label={w.Edition} />,
    },
    { key: 'Name', header: t('mcworldtools.worldName') },
    { key: 'SizeMB', header: t('mcworldtools.size'), width: 110, align: 'right', render: (w) => fmtMB(w.SizeMB) },
    {
      key: 'Regions',
      header: t('mcworldtools.regions'),
      width: 110,
      align: 'right',
      render: (w) => (w.Regions > 0 ? w.Regions.toLocaleString() : '—'),
    },
    { key: 'Source', header: t('mcworldtools.source'), width: 130 },
    { key: 'Modified', header: t('mcworldtools.modified'), width: 130 },
    {
      key: 'actions',
      header: '',
      width: 210,
      render: (w) => (
        <span className="row-actions">
          <button className="mini primary" onClick={() => setWorld(w.Path)}>
            {t('mcworldtools.useWorld')}
          </button>
          <button className="mini" onClick={() => openFolder(w.Path)}>
            {t('mcworldtools.open')}
          </button>
          <button className="mini" onClick={() => copyPath(w.Path)}>
            {copied === w.Path ? t('mcworldtools.copied') : t('mcworldtools.copyPath')}
          </button>
        </span>
      ),
    },
  ];

  const tc = tools.data;

  // Small reusable field row for the Settings grid.
  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
      <label className="count-note" style={{ margin: 0, fontWeight: 600 }}>
        {label}
      </label>
      {node}
      {hint && (
        <span className="count-note" style={{ margin: 0, fontSize: 11.5 }}>
          {hint}
        </span>
      )}
    </div>
  );

  const pathPicker = (value: string, onChange: (v: string) => void, placeholder: string, extra?: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        className="mod-search"
        style={{ flex: 1, minWidth: 240, fontFamily: 'Consolas, monospace' }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {extra}
    </div>
  );

  // ── sub-tab renderers ───────────────────────────────────────────────────────────────
  const renderChunker = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Chunker CLI (Python) status card */}
      <section className="dep-gate" style={{ margin: 0 }}>
        <p style={{ fontWeight: 600, margin: 0 }}>{t('mcworldtools.chunkerCli')}</p>
        <p className="count-note" style={{ marginTop: 4 }}>
          {chunker.loading
            ? t('mcworldtools.checkingChunker')
            : !chunker.data
              ? t('mcworldtools.previewNoProbe')
              : !chunker.data.PythonFound
                ? t('mcworldtools.pythonMissing')
                : chunker.data.ChunkerFound
                  ? t('mcworldtools.chunkerReady', {
                      version: chunker.data.PythonVersion,
                      detail: chunker.data.ChunkerDetail || '—',
                    })
                  : t('mcworldtools.chunkerNotInstalled', { version: chunker.data.PythonVersion })}
        </p>
        <ModuleToolbar>
          <button className="mini" disabled={chunker.loading || installBusy} onClick={chunker.reload}>
            ⟳ {t('mcworldtools.recheck')}
          </button>
          <button
            className="mini primary"
            disabled={installBusy || !chunker.data?.PythonFound}
            onClick={() => void installChunker()}
          >
            {installBusy
              ? t('mcworldtools.installing')
              : chunker.data?.ChunkerFound
                ? t('mcworldtools.reinstallChunker')
                : t('mcworldtools.installChunker')}
          </button>
        </ModuleToolbar>
        {chunkerCliMsg && <p className="mod-msg">{chunkerCliMsg}</p>}
      </section>

      {/* World folder picker + metadata */}
      <section>
        <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('mcworldtools.worldFolder')}</p>
        {pathPicker(
          world,
          setWorld,
          t('mcworldtools.worldPlaceholder'),
          <>
            <button className="mini" disabled={!world.trim()} onClick={() => openFolder(world)}>
              {t('mcworldtools.open')}
            </button>
            <button className="mini" disabled={!world.trim()} onClick={() => void refreshMeta(world)}>
              ⟳ {t('mcworldtools.refreshMeta')}
            </button>
          </>,
        )}
        <p className="count-note" style={{ marginTop: 6 }}>
          {!world.trim()
            ? t('mcworldtools.noWorld')
            : metaLoading
              ? t('modules.loading')
              : meta
                ? meta.Valid
                  ? t('mcworldtools.worldMeta', { size: fmtMB(meta.SizeMB), regions: meta.Regions })
                  : t('mcworldtools.notAWorld')
                : t('mcworldtools.noWorld')}
        </p>
      </section>

      {/* Chunker output folder */}
      <section>
        <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('mcworldtools.chunkerOutput')}</p>
        {pathPicker(
          chunkerOut,
          setChunkerOut,
          t('mcworldtools.outputPlaceholder'),
          <button className="mini" disabled={!chunkerOut.trim()} onClick={() => openFolder(chunkerOut)}>
            {t('mcworldtools.open')}
          </button>,
        )}
      </section>

      {/* Batch preview + convert run */}
      <section>
        <ModuleToolbar>
          <button className="mini" disabled={batchBusy || convertBusy} onClick={() => void previewBatches()}>
            {batchBusy ? t('modules.loading') : t('mcworldtools.previewBatches')}
          </button>
          {!convertBusy ? (
            <button className="mini primary" disabled={batchBusy} onClick={() => setConvertConfirm(true)}>
              {t('mcworldtools.convertBatches')}
            </button>
          ) : (
            <button className="mini" onClick={cancelConvert}>
              {t('mcworldtools.cancel')}
            </button>
          )}
          <span className="count-note">{t('mcworldtools.batchSizeNote', { mb: settings.chunkerBatchMb })}</span>
        </ModuleToolbar>

        {convertConfirm && (
          <div className="dep-gate" style={{ marginTop: 8 }}>
            <p className="count-note" style={{ marginTop: 0, color: 'var(--danger)' }}>
              {t('mcworldtools.convertConfirm')}
            </p>
            <div className="mod-toolbar">
              <button className="mini primary" onClick={() => void startConvert()}>
                {t('mcworldtools.confirmConvert')}
              </button>
              <button className="mini" onClick={() => setConvertConfirm(false)}>
                {t('mcworldtools.cancel')}
              </button>
            </div>
          </div>
        )}

        {batchMsg && <p className="mod-msg">{batchMsg}</p>}
        {batches && batches.length > 0 && (
          <div className="dt-wrap" style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto' }}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>{t('mcworldtools.batchNum')}</th>
                  <th style={{ width: 110, textAlign: 'right' }}>{t('mcworldtools.batchFiles')}</th>
                  <th style={{ textAlign: 'right' }}>{t('mcworldtools.batchBytes')}</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.Index}>
                    <td>#{String(b.Index).padStart(3, '0')}</td>
                    <td style={{ textAlign: 'right' }}>{b.Files.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBytes(b.Bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );

  const renderBlueMap = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section>
        <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('mcworldtools.blueMapOutput')}</p>
        {pathPicker(
          blueMapOut,
          setBlueMapOut,
          t('mcworldtools.outputPlaceholder'),
          <button className="mini" disabled={!blueMapOut.trim()} onClick={() => openFolder(blueMapOut)}>
            {t('mcworldtools.open')}
          </button>,
        )}
        <p className="count-note" style={{ marginTop: 6 }}>
          {t('mcworldtools.blueMapNote', { world: world.trim() || t('mcworldtools.noWorldShort') })}
        </p>
      </section>

      <section>
        <ModuleToolbar>
          <button className="mini" disabled={configBusy || renderBusy} onClick={() => void generateConfig()}>
            {configBusy ? t('modules.loading') : t('mcworldtools.generateConfig')}
          </button>
          <button className="mini primary" disabled={renderBusy} onClick={() => setRenderConfirm(true)}>
            {renderBusy ? t('mcworldtools.starting') : t('mcworldtools.startRender')}
          </button>
          <button className="mini" onClick={() => void stopRender()}>
            {t('mcworldtools.stop')}
          </button>
        </ModuleToolbar>

        {renderConfirm && (
          <div className="dep-gate" style={{ marginTop: 8 }}>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('mcworldtools.renderConfirm', { port: settings.blueMapPort, memory: settings.blueMapMemoryMb })}
            </p>
            <div className="mod-toolbar">
              <button className="mini primary" onClick={() => void startRender()}>
                {t('mcworldtools.confirmRender')}
              </button>
              <button className="mini" onClick={() => setRenderConfirm(false)}>
                {t('mcworldtools.cancel')}
              </button>
            </div>
          </div>
        )}

        {blueMapMsg && <p className="mod-msg">{blueMapMsg}</p>}
      </section>
    </div>
  );

  const renderSettings = () => (
    <div style={{ maxWidth: 640 }}>
      {field(
        t('mcworldtools.workDir'),
        pathPicker(draft.workDir, (v) => setDraftField('workDir', v), t('mcworldtools.workDirPlaceholder')),
        t('mcworldtools.workDirHint'),
      )}
      {field(
        t('mcworldtools.chunkerToolLbl'),
        pathPicker(draft.chunkerTool, (v) => setDraftField('chunkerTool', v), t('mcworldtools.chunkerToolPlaceholder')),
      )}
      {field(
        t('mcworldtools.chunkerArgsLbl'),
        <input
          className="mod-search"
          style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
          value={draft.chunkerArgs}
          onChange={(e) => setDraftField('chunkerArgs', e.target.value)}
          spellCheck={false}
        />,
        t('mcworldtools.argsHint'),
      )}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {field(
          t('mcworldtools.chunkerTargetLbl'),
          <select
            className="mod-search"
            value={draft.chunkerTarget}
            onChange={(e) => setDraftField('chunkerTarget', e.target.value)}
          >
            <option value="java">Java</option>
            <option value="bedrock">Bedrock</option>
          </select>,
        )}
        {field(
          t('mcworldtools.batchSize'),
          <input
            className="mod-search"
            type="number"
            min={64}
            max={4096}
            style={{ width: 160 }}
            value={draft.chunkerBatchMb}
            onChange={(e) => setDraftField('chunkerBatchMb', Number(e.target.value))}
          />,
        )}
      </div>

      {field(
        t('mcworldtools.blueMapJarLbl'),
        pathPicker(draft.blueMapJar, (v) => setDraftField('blueMapJar', v), t('mcworldtools.blueMapJarPlaceholder')),
      )}
      {field(
        t('mcworldtools.blueMapArgsLbl'),
        <input
          className="mod-search"
          style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
          value={draft.blueMapArgs}
          onChange={(e) => setDraftField('blueMapArgs', e.target.value)}
          spellCheck={false}
        />,
        t('mcworldtools.blueMapArgsHint'),
      )}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {field(
          t('mcworldtools.memory'),
          <input
            className="mod-search"
            type="number"
            min={512}
            max={131072}
            style={{ width: 160 }}
            value={draft.blueMapMemoryMb}
            onChange={(e) => setDraftField('blueMapMemoryMb', Number(e.target.value))}
          />,
        )}
        {field(
          t('mcworldtools.threads'),
          <input
            className="mod-search"
            type="number"
            min={1}
            max={128}
            style={{ width: 120 }}
            value={draft.blueMapThreads}
            onChange={(e) => setDraftField('blueMapThreads', Number(e.target.value))}
          />,
        )}
        {field(
          t('mcworldtools.webPort'),
          <input
            className="mod-search"
            type="number"
            min={1}
            max={65535}
            style={{ width: 120 }}
            value={draft.blueMapPort}
            onChange={(e) => setDraftField('blueMapPort', Number(e.target.value))}
          />,
        )}
      </div>
      <label className="count-note" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
        <input
          type="checkbox"
          checked={draft.blueMapWebServer}
          onChange={(e) => setDraftField('blueMapWebServer', e.target.checked)}
        />
        {t('mcworldtools.webServerToggle')}
      </label>

      <ModuleToolbar>
        <button className="mini primary" onClick={saveSettings}>
          {t('mcworldtools.saveSettings')}
        </button>
        <button className="mini" onClick={reloadSettings}>
          {t('mcworldtools.reload')}
        </button>
      </ModuleToolbar>
      {settingsMsg && <p className="mod-msg">{settingsMsg}</p>}
    </div>
  );

  const renderLog = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ModuleToolbar>
        <button className="mini" disabled={!log} onClick={() => setLog('')}>
          {t('mcworldtools.clearLog')}
        </button>
        <span className="count-note">{t('mcworldtools.logNote')}</span>
      </ModuleToolbar>
      <textarea
        className="hosts-edit"
        readOnly
        spellCheck={false}
        value={log || t('mcworldtools.logEmpty')}
        style={{ minHeight: 260, fontFamily: 'Consolas, monospace', fontSize: 12.5, whiteSpace: 'pre' }}
      />
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mcworldtools.blurb')}
      </p>
      {!tauri && (
        <p className="count-note" style={{ marginTop: 0, color: 'var(--danger)' }}>
          {t('mcworldtools.previewNotice')}
        </p>
      )}

      {/* Toolchain status (Java + Python) — read-only probe */}
      <div className="mod-toolbar" style={{ gap: 16, flexWrap: 'wrap' }}>
        {tools.loading ? (
          <span className="count-note">{t('mcworldtools.probingTools')}</span>
        ) : (
          <>
            <StatusDot
              ok={!!tc?.JavaFound}
              label={tc?.JavaFound ? `${t('mcworldtools.java')}: ${tc.JavaVersion}` : `${t('mcworldtools.java')}: ${t('mcworldtools.notFound')}`}
            />
            <StatusDot
              ok={!!tc?.PythonFound}
              label={tc?.PythonFound ? `${t('mcworldtools.python')}: ${tc.PythonVersion}` : `${t('mcworldtools.python')}: ${t('mcworldtools.notFound')}`}
            />
            <button className="mini" onClick={() => { tools.reload(); chunker.reload(); }}>
              ⟳ {t('modules.refresh')}
            </button>
          </>
        )}
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mcworldtools.toolsNote')}
      </p>

      {/* Sub-tabs mirroring the C# Pivot: Chunker / BlueMap / Settings / Log, plus a
          fold-in Worlds tab exposing the in-app world discovery as a quick picker. */}
      <ModuleTabs
        tabs={[
          { id: 'chunker', en: 'Chunker', zh: 'Chunker', render: renderChunker },
          { id: 'bluemap', en: 'BlueMap', zh: 'BlueMap', render: renderBlueMap },
          { id: 'settings', en: 'Settings', zh: '設定', render: renderSettings },
          { id: 'log', en: 'Log', zh: '記錄', render: renderLog },
          {
            id: 'worlds',
            en: 'Worlds',
            zh: '世界',
            render: () => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ModuleToolbar>
                  <input
                    className="mod-search"
                    placeholder={t('mcworldtools.filter')}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <button className="mini" onClick={worlds.reload}>
                    ⟳ {t('modules.refresh')}
                  </button>
                  <span className="count-note">
                    {t('mcworldtools.count', { worlds: rows.length })} · {fmtMB(totalMB)}
                  </span>
                </ModuleToolbar>
                <AsyncState loading={worlds.loading} error={worlds.error}>
                  <DataTable columns={worldColumns} rows={rows} rowKey={(w) => w.Path} empty={t('mcworldtools.empty')} />
                </AsyncState>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
