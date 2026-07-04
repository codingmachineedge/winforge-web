import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';
import { ModuleToolbar, StatusDot } from './common';

/**
 * AltSnap · Alt 拖曳視窗 — native port of WinForge's AltSnapModule.
 * Detects the official RamonUnch.AltSnap binary, installs it via winget when missing, drives its
 * lifecycle (launch / quit / restart / reload / advanced settings), toggles run-at-startup
 * (HKCU…\Run), warns about conflicting hook owners, reads/writes the high-value AltSnap.ini keys,
 * imports / exports the config file, and offers a raw fallback editor — all live through the Tauri
 * PowerShell bridge. AltSnap is GPL; WinForge only installs and drives the binary, it never relinks
 * its code.
 */

// ---- curated option catalog (mirrors Catalog/AltSnapOptions.cs) ----

type OptKind = 'toggle' | 'choice' | 'number' | 'text';
interface OptChoice {
  en: string;
  zh: string;
  value: string;
}
interface AltSnapOption {
  id: string;
  section: string;
  key: string;
  kind: OptKind;
  en: string;
  zh: string;
  enDesc: string;
  zhDesc: string;
  def: string;
  choices?: OptChoice[];
  min?: number;
  max?: number;
}

const MODIFIER_KEYS: OptChoice[] = [
  { en: 'Alt (both)', zh: 'Alt（左右）', value: 'A4 A5' },
  { en: 'Left Alt', zh: '左 Alt', value: 'A4' },
  { en: 'Right Alt', zh: '右 Alt', value: 'A5' },
  { en: 'Win (both)', zh: 'Win（左右）', value: '5B 5C' },
  { en: 'Ctrl (both)', zh: 'Ctrl（左右）', value: 'A2 A3' },
  { en: 'Shift (both)', zh: 'Shift（左右）', value: 'A0 A1' },
];

const UP_ACTIONS: OptChoice[] = [
  { en: 'Nothing', zh: '唔做', value: 'Nothing' },
  { en: 'Toggle maximize', zh: '切換最大化', value: 'Maximize' },
  { en: 'Minimize', zh: '最小化', value: 'Minimize' },
  { en: 'Center', zh: '置中', value: 'Center' },
  { en: 'Always on top', zh: '永遠置頂', value: 'AlwaysOnTop' },
  { en: 'Close', zh: '關閉', value: 'Close' },
  { en: 'Lower (send to back)', zh: '送到最底', value: 'Lower' },
];

const OPTIONS: AltSnapOption[] = [
  {
    id: 'hotkeys',
    section: 'Input',
    key: 'Hotkeys',
    kind: 'choice',
    en: 'Modifier key',
    zh: '修飾鍵',
    enDesc: 'Hold this key, then drag anywhere in a window to move it (Linux-style alt-drag).',
    zhDesc: '撳住呢個鍵，就可以喺視窗任何位置拖動嚟移動（Linux 式 alt 拖曳）。',
    def: 'A4 A5',
    choices: MODIFIER_KEYS,
  },
  {
    id: 'moveup',
    section: 'Input',
    key: 'MoveUp',
    kind: 'choice',
    en: 'Release action (after move)',
    zh: '鬆手動作（移動後）',
    enDesc: 'What happens when you let go of the modifier with the left button still down after a move.',
    zhDesc: '移動後左鍵仲撳住、鬆開修飾鍵時做嘅動作。',
    def: 'Nothing',
    choices: UP_ACTIONS,
  },
  {
    id: 'resizeup',
    section: 'Input',
    key: 'ResizeUp',
    kind: 'choice',
    en: 'Release action (after resize)',
    zh: '鬆手動作（縮放後）',
    enDesc: 'What happens when you let go of the modifier with the right button still down after a resize.',
    zhDesc: '縮放後右鍵仲撳住、鬆開修飾鍵時做嘅動作。',
    def: 'Nothing',
    choices: UP_ACTIONS,
  },
  {
    id: 'rbactn',
    section: 'Input',
    key: 'GrabWithAlt',
    kind: 'choice',
    en: 'Left-button action',
    zh: '左鍵動作',
    enDesc: 'What the modifier + left mouse button does (Move is the classic behaviour).',
    zhDesc: '修飾鍵 + 滑鼠左鍵嘅動作（移動係經典行為）。',
    def: 'Move',
    choices: [
      { en: 'Move', zh: '移動', value: 'Move' },
      { en: 'Resize', zh: '縮放', value: 'Resize' },
      { en: 'Nothing', zh: '唔做', value: 'Nothing' },
    ],
  },
  {
    id: 'autosnap',
    section: 'General',
    key: 'AutoSnap',
    kind: 'choice',
    en: 'Auto-snap to edges',
    zh: '自動貼邊',
    enDesc: 'Snap windows to screen edges / other windows while dragging.',
    zhDesc: '拖動時自動貼齊螢幕邊緣或其他視窗。',
    def: '0',
    choices: [
      { en: 'Off', zh: '關', value: '0' },
      { en: 'Outer edges', zh: '外邊緣', value: '1' },
      { en: 'Outer + inner edges', zh: '外 + 內邊緣', value: '2' },
      { en: 'Outer + inner + windows', zh: '外 + 內 + 視窗', value: '3' },
    ],
  },
  {
    id: 'aerotopmax',
    section: 'Advanced',
    key: 'AeroTopMaximizes',
    kind: 'toggle',
    en: 'Drag to top maximizes',
    zh: '拖到頂部最大化',
    enDesc: 'Dragging a window to the top edge of the screen maximizes it (Aero Snap style).',
    zhDesc: '將視窗拖到螢幕頂邊就最大化（Aero Snap 風格）。',
    def: '1',
  },
  {
    id: 'snapthreshold',
    section: 'Advanced',
    key: 'SnapThreshold',
    kind: 'number',
    en: 'Snap threshold (px)',
    zh: '貼邊距離（像素）',
    enDesc: 'How close (in pixels) a window must be to an edge before it snaps.',
    zhDesc: '視窗要幾近邊緣（像素）先會貼齊。',
    def: '20',
    min: 0,
    max: 200,
  },
  {
    id: 'movetrans',
    section: 'Advanced',
    key: 'MoveTrans',
    kind: 'number',
    en: 'Transparency while dragging (0–255)',
    zh: '拖動時透明度（0–255）',
    enDesc: 'Window opacity while it is being moved (255 = opaque, lower = more see-through).',
    zhDesc: '拖動時視窗嘅透明度（255 = 不透明，越細越透明）。',
    def: '255',
    min: 0,
    max: 255,
  },
  {
    id: 'fullwin',
    section: 'Performance',
    key: 'FullWin',
    kind: 'choice',
    en: 'Show window contents while dragging',
    zh: '拖動時顯示視窗內容',
    enDesc: 'On = solid live window; Off = a lightweight outline (snappier on slow machines).',
    zhDesc: '開 = 實時實體視窗；關 = 輕量外框（慢機更順暢）。',
    def: '1',
    choices: [
      { en: 'Outline only', zh: '只顯示外框', value: '0' },
      { en: 'Full contents', zh: '完整內容', value: '1' },
    ],
  },
  {
    id: 'usezones',
    section: 'Zones',
    key: 'UseZones',
    kind: 'choice',
    en: 'Snap layouts / zones',
    zh: '貼齊版面／區域',
    enDesc: 'Enable FancyZones-style snap layouts when dragging windows.',
    zhDesc: '拖動視窗時啟用類似 FancyZones 嘅貼齊版面。',
    def: '0',
    choices: [
      { en: 'Off', zh: '關', value: '0' },
      { en: 'Snap layouts', zh: '貼齊版面', value: '1' },
      { en: 'Grid zones', zh: '格狀區域', value: '3' },
    ],
  },
  {
    id: 'multiplemonitors',
    section: 'General',
    key: 'MultipleAltSnap',
    kind: 'toggle',
    en: 'Span multiple monitors',
    zh: '跨越多個螢幕',
    enDesc: 'Allow snapping and maximizing across all connected monitors.',
    zhDesc: '允許喺所有連接螢幕之間貼齊同最大化。',
    def: '1',
  },
  {
    id: 'bl_processes',
    section: 'Blacklist',
    key: 'Processes',
    kind: 'text',
    en: 'Process blacklist',
    zh: '程式黑名單',
    enDesc: 'Comma-separated process names AltSnap must ignore. Example: Notepad.exe, vlc.exe',
    zhDesc: '用逗號分隔嘅程式名，AltSnap 會忽略佢哋。例如：Notepad.exe, vlc.exe',
    def: '',
  },
  {
    id: 'bl_windows',
    section: 'Blacklist',
    key: 'Windows',
    kind: 'text',
    en: 'Window blacklist (title|class)',
    zh: '視窗黑名單（標題|類別）',
    enDesc: 'Comma-separated title|class entries to ignore. Example: Program Manager|Progman, *|Shell_TrayWnd',
    zhDesc: '用逗號分隔嘅 標題|類別，會被忽略。例如：Program Manager|Progman, *|Shell_TrayWnd',
    def: '',
  },
];

// ---- PowerShell snippets ----

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WINGET_ID = 'RamonUnch.AltSnap';

// Locate AltSnap.exe (registry uninstall keys → well-known dirs → winget packages → PATH),
// its running state, version, run-at-startup registry value, and any conflicting hook owner.
// Emits one JSON object.
const PROBE = String.raw`
$ErrorActionPreference='SilentlyContinue'
function Find-AltSnap {
  $c = @()
  $unKeys = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap_is1',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap_is1',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AltSnap_is1'
  )
  foreach ($k in $unKeys) {
    $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($p.InstallLocation) { $c += (Join-Path ($p.InstallLocation.Trim('"')) 'AltSnap.exe') }
    if ($p.DisplayIcon) { $c += ($p.DisplayIcon -split ',')[0].Trim('"') }
  }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $c += @(
    (Join-Path $env:ProgramFiles 'AltSnap\AltSnap.exe'),
    (Join-Path $pf86 'AltSnap\AltSnap.exe'),
    (Join-Path $env:LOCALAPPDATA 'AltSnap\AltSnap.exe')
  )
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path } }
  $pkg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $pkg) {
    $hit = Get-ChildItem -Path $pkg -Filter 'AltSnap.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $w = (Get-Command AltSnap.exe -ErrorAction SilentlyContinue).Source
  if ($w) { return $w }
  return $null
}
$exe = Find-AltSnap
$running = @(Get-Process -Name 'AltSnap' -ErrorAction SilentlyContinue).Count -gt 0
$ver = ''
if ($exe -and (Test-Path $exe)) {
  try { $vi = (Get-Item $exe).VersionInfo; $ver = if ($vi.ProductVersion) { $vi.ProductVersion } else { $vi.FileVersion } } catch {}
}
$startup = $false
try {
  $rv = (Get-ItemProperty -Path '${RUN_KEY}' -Name 'AltSnap' -ErrorAction SilentlyContinue).AltSnap
  if ($rv) { $startup = $true }
} catch {}
$conflict = $null
foreach ($n in @('AltDrag','WindowsGrep','easydrag')) {
  if (@(Get-Process -Name $n -ErrorAction SilentlyContinue).Count -gt 0) { $conflict = $n + '.exe'; break }
}
$ini = $null
if ($exe) {
  $d = Split-Path $exe -Parent
  $p1 = Join-Path $d 'AltSnap.ini'
  if (Test-Path $p1) { $ini = $p1 }
}
if (-not $ini) {
  $p2 = Join-Path $env:APPDATA 'AltSnap\AltSnap.ini'
  if (Test-Path $p2) { $ini = $p2 }
}
$iniText = ''
if ($ini) { $iniText = Get-Content -Path $ini -Raw -ErrorAction SilentlyContinue }
[pscustomobject]@{
  Installed = [bool]$exe
  Exe = $exe
  Running = $running
  Version = $ver
  Startup = $startup
  Conflict = $conflict
  IniPath = $ini
  IniText = $iniText
} | ConvertTo-Json -Compress
`;

interface Probe {
  Installed: boolean;
  Exe: string | null;
  Running: boolean;
  Version: string;
  Startup: boolean;
  Conflict: string | null;
  IniPath: string | null;
  IniText: string;
}

// Preferred write path for AltSnap.ini given the located exe (next to exe, else %APPDATA%).
function writeIniPathPs(exe: string | null): string {
  if (exe) {
    return `$ini = Join-Path (Split-Path '${psq(exe)}' -Parent) 'AltSnap.ini'`;
  }
  return `$ini = Join-Path $env:APPDATA 'AltSnap\\AltSnap.ini'`;
}

// PowerShell single-quote escape.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

// Parse an INI blob (case-insensitive section/key) into a lookup.
function parseIni(text: string): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = { '': {} };
  let cur = '';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      cur = line.slice(1, -1).trim().toLowerCase();
      if (!map[cur]) map[cur] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const bucket = map[cur] ?? (map[cur] = {});
    bucket[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return map;
}

function iniGet(map: Record<string, Record<string, string>>, section: string, key: string, def: string): string {
  const sect = map[section.toLowerCase()];
  if (!sect) return def;
  const v = sect[key.toLowerCase()];
  return v ?? def;
}

type Kind = 'ok' | 'err';

export function AltSnapModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const pick = useCallback((en: string, zh: string) => (lang === 'zh' ? zh : en), [lang]);

  const [probe, setProbe] = useState<Probe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [msg, setMsg] = useState<{ kind: Kind; text: string } | null>(null);
  const [reloadOnSave, setReloadOnSave] = useState(true);
  const [rawText, setRawText] = useState('');
  const [rawOrig, setRawOrig] = useState('');
  const [importPath, setImportPath] = useState('');
  const [exportPath, setExportPath] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await runPowershell(PROBE);
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      const text = res.stdout.trim();
      const p: Probe = text
        ? (JSON.parse(text) as Probe)
        : { Installed: false, Exe: null, Running: false, Version: '', Startup: false, Conflict: null, IniPath: null, IniText: '' };
      setProbe(p);
      setRawText(p.IniText ?? '');
      setRawOrig(p.IniText ?? '');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const iniMap = useMemo(() => parseIni(probe?.IniText ?? ''), [probe?.IniText]);
  const exe = probe?.Exe ?? null;

  const flash = (kind: Kind, text: string) => setMsg({ kind, text });

  // ---- install via winget (RamonUnch.AltSnap) — click-gated, then re-probe ----
  const install = async () => {
    if (installing) return;
    if (!isTauri()) {
      flash('err', t('altsnap.installNeedsDesktop'));
      return;
    }
    setInstalling(true);
    setMsg(null);
    try {
      const res = await runPowershell(
        `try { & winget install --id ${WINGET_ID} -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String -Width 300 } catch { $_ | Out-String; exit 1 }; exit $LASTEXITCODE`,
      );
      if (!res.success) {
        throw new Error((res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 500));
      }
      flash('ok', t('altsnap.installed'));
      await load();
    } catch (e) {
      flash('err', `${t('altsnap.installFailed')}: ${String(e)}`);
    } finally {
      setInstalling(false);
    }
  };

  // Run a lifecycle command against the located exe.
  const lifecycle = async (
    build: (exeVar: string) => string,
    label: string,
    needsExe = true,
  ) => {
    if (needsExe && !exe) {
      flash('err', t('altsnap.notInstalled'));
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(build(exe ? `'${psq(exe)}'` : "''"));
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      flash('ok', label);
      await load();
    } catch (e) {
      flash('err', `${label}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const launch = (elevated: boolean) =>
    lifecycle(
      (e) =>
        elevated
          ? `Start-Process -FilePath ${e} -Verb RunAs; 'ok'`
          : `Start-Process -FilePath ${e}; 'ok'`,
      elevated ? t('altsnap.launchedElevated') : t('altsnap.launched'),
    );

  const quit = () =>
    lifecycle(
      () => `taskkill /f /im AltSnap.exe 2>$null; if (@(Get-Process -Name AltSnap -EA SilentlyContinue).Count -gt 0){ throw 'still running' }; 'ok'`,
      t('altsnap.quitDone'),
      false,
    );

  const restart = () =>
    lifecycle(
      (e) =>
        `taskkill /f /im AltSnap.exe 2>$null; Start-Sleep -Milliseconds 400; Start-Process -FilePath ${e}; 'ok'`,
      t('altsnap.restarted'),
    );

  const reload = () =>
    lifecycle(
      (e) =>
        `if (@(Get-Process -Name AltSnap -EA SilentlyContinue).Count -gt 0){ Start-Process -FilePath ${e} -ArgumentList '-r' } else { Start-Process -FilePath ${e} }; 'ok'`,
      t('altsnap.reloaded'),
    );

  const openAdvanced = () =>
    lifecycle((e) => `Start-Process -FilePath ${e} -ArgumentList '-c'; 'ok'`, t('altsnap.advancedOpened'));

  const toggleStartup = async () => {
    if (!probe) return;
    setBusy(true);
    setMsg(null);
    try {
      if (probe.Startup) {
        const res = await runPowershell(
          `Remove-ItemProperty -Path '${RUN_KEY}' -Name 'AltSnap' -ErrorAction Stop; 'ok'`,
        );
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        flash('ok', t('altsnap.startupOff'));
      } else {
        if (!exe) {
          flash('err', t('altsnap.notInstalled'));
          setBusy(false);
          return;
        }
        const res = await runPowershell(
          `New-Item -Path '${RUN_KEY}' -Force -EA SilentlyContinue | Out-Null; Set-ItemProperty -Path '${RUN_KEY}' -Name 'AltSnap' -Value '"${psq(exe)}"' -ErrorAction Stop; 'ok'`,
        );
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        flash('ok', t('altsnap.startupOn'));
      }
      await load();
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(false);
    }
  };

  // Upsert one curated key into AltSnap.ini (comment/other-key preserving) via PowerShell.
  const saveOption = async (opt: AltSnapOption, value: string) => {
    setBusy(true);
    setMsg(null);
    const b64 = btoa(unescape(encodeURIComponent(value)));
    const script = [
      writeIniPathPs(exe),
      `$dir = Split-Path $ini -Parent; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
      `$val = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
      `$section='${psq(opt.section)}'; $key='${psq(opt.key)}'`,
      `$nl = "\`r\`n"`,
      `$lines = if (Test-Path $ini) { [System.IO.File]::ReadAllText($ini) -replace "\`r\`n","\`n" -split "\`n" } else { @() }`,
      `$out = New-Object System.Collections.Generic.List[string]`,
      `$inTarget=$false; $done=$false; $sawSection=$false`,
      `for ($i=0; $i -lt $lines.Count; $i++) {`,
      `  $line = $lines[$i]; $tl = $line.Trim()`,
      `  if ($tl -match '^\[(.+)\]$') {`,
      `    if ($inTarget -and -not $done) { $out.Add("$key=$val"); $done=$true }`,
      `    $inTarget = ($Matches[1].Trim() -ieq $section)`,
      `    if ($inTarget) { $sawSection=$true }`,
      `    $out.Add($line); continue`,
      `  }`,
      `  if ($inTarget -and -not $done -and $tl -notmatch '^[;#]' -and $tl -match '^([^=]+)=') {`,
      `    if ($Matches[1].Trim() -ieq $key) { $out.Add("$key=$val"); $done=$true; continue }`,
      `  }`,
      `  $out.Add($line)`,
      `}`,
      `if (-not $done) {`,
      `  if (-not $sawSection) { if ($out.Count -gt 0) { $out.Add('') }; $out.Add("[$section]") }`,
      `  $out.Add("$key=$val")`,
      `}`,
      `[System.IO.File]::WriteAllText($ini, ($out -join $nl))`,
      `'ok'`,
    ].join('; ');
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      if (reloadOnSave && probe?.Running && exe) {
        await runPowershell(`Start-Process -FilePath '${psq(exe)}' -ArgumentList '-r'`);
      }
      flash(
        'ok',
        reloadOnSave && probe?.Running
          ? t('altsnap.savedReloaded', { name: pick(opt.en, opt.zh) })
          : t('altsnap.savedRestart', { name: pick(opt.en, opt.zh) }),
      );
      await load();
    } catch (e) {
      flash('err', `${pick(opt.en, opt.zh)}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---- import: copy a chosen .ini file over the active AltSnap.ini (click-gated) ----
  const importIni = async () => {
    const src = importPath.trim();
    if (!src) {
      flash('err', t('altsnap.importNeedPath'));
      return;
    }
    setBusy(true);
    setMsg(null);
    const script = [
      writeIniPathPs(exe),
      `$src = '${psq(src)}'`,
      `if (-not (Test-Path -LiteralPath $src)) { throw 'source not found' }`,
      `$dir = Split-Path $ini -Parent; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
      `Copy-Item -LiteralPath $src -Destination $ini -Force`,
      `'ok'`,
    ].join('; ');
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      if (reloadOnSave && probe?.Running && exe) {
        await runPowershell(`Start-Process -FilePath '${psq(exe)}' -ArgumentList '-r'`);
      }
      flash('ok', t('altsnap.imported'));
      await load();
    } catch (e) {
      flash('err', `${t('altsnap.importFailed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---- export: copy the active AltSnap.ini to a chosen path (click-gated) ----
  const exportIni = async () => {
    const dest = exportPath.trim();
    if (!dest) {
      flash('err', t('altsnap.exportNeedPath'));
      return;
    }
    if (!probe?.IniPath) {
      flash('err', t('altsnap.exportNothing'));
      return;
    }
    setBusy(true);
    setMsg(null);
    const script = [
      `$dest = '${psq(dest)}'`,
      `$srcIni = '${psq(probe.IniPath)}'`,
      `if (-not (Test-Path -LiteralPath $srcIni)) { throw 'no AltSnap.ini to export' }`,
      `$dd = Split-Path $dest -Parent; if ($dd -and -not (Test-Path $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }`,
      `Copy-Item -LiteralPath $srcIni -Destination $dest -Force`,
      `'ok'`,
    ].join('; ');
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      flash('ok', t('altsnap.exported', { path: dest }));
    } catch (e) {
      flash('err', `${t('altsnap.exportFailed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveRaw = async () => {
    setBusy(true);
    setMsg(null);
    const b64 = btoa(unescape(encodeURIComponent(rawText)));
    const script = [
      writeIniPathPs(exe),
      `$dir = Split-Path $ini -Parent; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
      `$val = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
      `[System.IO.File]::WriteAllText($ini, $val)`,
      `'ok'`,
    ].join('; ');
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      if (reloadOnSave && probe?.Running && exe) {
        await runPowershell(`Start-Process -FilePath '${psq(exe)}' -ArgumentList '-r'`);
      }
      flash('ok', t('altsnap.rawSaved'));
      await load();
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(false);
    }
  };

  const installed = probe?.Installed ?? false;
  const running = probe?.Running ?? false;
  const disabled = busy || !installed;
  const rawDirty = rawText !== rawOrig;

  const statusLabel = !installed
    ? t('altsnap.stNotInstalled')
    : running
      ? t('altsnap.stRunning')
      : t('altsnap.stStopped');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          'Move and resize any window by holding a modifier key (Alt by default) and dragging anywhere inside it — classic Linux-style alt-drag. WinForge detects the official AltSnap, controls it, and edits its configuration.',
          '撳住一個修飾鍵（預設 Alt）就可以喺視窗任何位置拖動嚟移動同縮放 — 經典 Linux 式 alt 拖曳。WinForge 會偵測官方 AltSnap、控制佢、並編輯佢嘅設定。',
        )}
      </p>

      <ModuleToolbar>
        <StatusDot ok={running} label={statusLabel} />
        {probe?.Version ? <span className="count-note">{t('altsnap.version', { v: probe.Version })}</span> : null}
        <button className="mini" disabled={busy || installing} onClick={load}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {loading && <p className="count-note">{t('modules.loading')}</p>}
      {error && <pre className="cmd-out error">{error}</pre>}

      {/* ---- install offer when missing ---- */}
      {!loading && !installed && !error && (
        <div className="mod-toolbar" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          <p className="mod-msg" style={{ marginBottom: 0 }}>{t('altsnap.installHint')}</p>
          <button className="mini primary" disabled={installing} onClick={install}>
            {installing ? t('altsnap.installing') : t('altsnap.installBtn')}
          </button>
        </div>
      )}

      {probe?.Conflict && (
        <p className="mod-msg">{t('altsnap.conflict', { name: probe.Conflict })}</p>
      )}

      {installed && <p className="count-note">{t('altsnap.elevationHint')}</p>}

      {probe?.IniPath ? (
        <p className="count-note" style={{ wordBreak: 'break-all' }}>
          {t('altsnap.filePath', { path: probe.IniPath })}
        </p>
      ) : null}

      {msg && (
        <p className="mod-msg" style={msg.kind === 'err' ? { color: 'var(--err, #d33)' } : undefined}>
          {msg.text}
        </p>
      )}

      {/* ---- Lifecycle ---- */}
      <h3 className="mod-h">{t('altsnap.engine')}</h3>
      <div className="mod-toolbar">
        <button className="mini primary" disabled={disabled} onClick={() => launch(false)}>
          {t('altsnap.launch')}
        </button>
        <button className="mini" disabled={disabled} onClick={() => launch(true)}>
          {t('altsnap.launchElevated')}
        </button>
        <button className="mini" disabled={disabled || !running} onClick={quit}>
          {t('altsnap.quit')}
        </button>
        <button className="mini" disabled={disabled} onClick={restart}>
          {t('altsnap.restart')}
        </button>
        <button className="mini" disabled={disabled} onClick={reload}>
          {t('altsnap.reload')}
        </button>
        <button className="mini" disabled={disabled} onClick={openAdvanced}>
          {t('altsnap.advanced')}
        </button>
      </div>

      {/* ---- Startup ---- */}
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" disabled={disabled} checked={probe?.Startup ?? false} onChange={toggleStartup} />
          {t('altsnap.startup')}
        </label>
        <span className="count-note">{t('altsnap.startupBlurb')}</span>
      </div>
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={reloadOnSave} onChange={(e) => setReloadOnSave(e.target.checked)} />
          {t('altsnap.reloadOnSave')}
        </label>
      </div>

      {/* ---- Curated config ---- */}
      <h3 className="mod-h">{t('altsnap.configHeader')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('altsnap.configBlurb')}
      </p>

      <div className="altsnap-opts">
        {OPTIONS.map((opt) => {
          const val = iniGet(iniMap, opt.section, opt.key, opt.def);
          return (
            <div key={opt.id} className="altsnap-opt-row">
              <div className="altsnap-opt-label">
                <div className="altsnap-opt-title">
                  {opt.en} · {opt.zh}
                </div>
                <div className="count-note">{pick(opt.enDesc, opt.zhDesc)}</div>
              </div>
              <div className="altsnap-opt-editor">
                {opt.kind === 'toggle' && (
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={val === '1' || val.toLowerCase() === 'true'}
                      onChange={(e) => saveOption(opt, e.target.checked ? '1' : '0')}
                    />
                    {val === '1' || val.toLowerCase() === 'true' ? t('altsnap.on') : t('altsnap.off')}
                  </label>
                )}
                {opt.kind === 'choice' && (
                  <select
                    className="mod-search"
                    disabled={disabled}
                    value={
                      opt.choices?.some((c) => c.value.toLowerCase() === val.toLowerCase())
                        ? opt.choices.find((c) => c.value.toLowerCase() === val.toLowerCase())!.value
                        : opt.def
                    }
                    onChange={(e) => saveOption(opt, e.target.value)}
                  >
                    {opt.choices?.map((c) => (
                      <option key={c.value} value={c.value}>
                        {pick(c.en, c.zh)}
                      </option>
                    ))}
                  </select>
                )}
                {opt.kind === 'number' && (
                  <input
                    className="mod-search"
                    type="number"
                    style={{ width: 120 }}
                    disabled={disabled}
                    min={opt.min}
                    max={opt.max}
                    defaultValue={val}
                    onBlur={(e) => {
                      if (e.target.value !== val) saveOption(opt, e.target.value.trim() || opt.def);
                    }}
                  />
                )}
                {opt.kind === 'text' && (
                  <input
                    className="mod-search"
                    type="text"
                    style={{ minWidth: 260 }}
                    disabled={disabled}
                    placeholder={opt.def}
                    defaultValue={val}
                    onBlur={(e) => {
                      if (e.target.value !== val) saveOption(opt, e.target.value);
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Import / Export ---- */}
      <h3 className="mod-h">{t('altsnap.transferHeader')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('altsnap.transferBlurb')}
      </p>
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <input
          className="mod-search"
          type="text"
          style={{ minWidth: 320, flex: '1 1 320px' }}
          disabled={disabled}
          placeholder={t('altsnap.importPlaceholder')}
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
        />
        <button className="mini" disabled={disabled || !importPath.trim()} onClick={importIni}>
          {t('altsnap.importBtn')}
        </button>
      </div>
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <input
          className="mod-search"
          type="text"
          style={{ minWidth: 320, flex: '1 1 320px' }}
          disabled={disabled}
          placeholder={t('altsnap.exportPlaceholder')}
          value={exportPath}
          onChange={(e) => setExportPath(e.target.value)}
        />
        <button className="mini" disabled={disabled || !exportPath.trim() || !probe?.IniPath} onClick={exportIni}>
          {t('altsnap.exportBtn')}
        </button>
      </div>

      {/* ---- Raw editor ---- */}
      <h3 className="mod-h">{t('altsnap.rawHeader')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('altsnap.rawBlurb')}
      </p>
      <div className="mod-toolbar">
        <button
          className="mini"
          disabled={busy}
          onClick={() => {
            setRawText(rawOrig);
            setMsg({ kind: 'ok', text: t('altsnap.rawReloaded') });
          }}
        >
          {t('altsnap.rawReload')}
        </button>
        <button className="mini primary" disabled={busy || !rawDirty || !installed} onClick={saveRaw}>
          {t('altsnap.rawSave')}
        </button>
        {rawDirty && <span className="count-note">{t('altsnap.unsaved')}</span>}
      </div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        placeholder={t('altsnap.rawEmpty')}
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
      />

      <style>{`
        .altsnap-opts { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 4px; }
        .altsnap-opt-row {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px; border: 1px solid var(--border, #2a2a2a);
          border-radius: 8px; background: var(--card, rgba(127,127,127,.05));
        }
        .altsnap-opt-label { flex: 1 1 auto; min-width: 0; }
        .altsnap-opt-title { font-weight: 600; font-size: 13.5px; }
        .altsnap-opt-editor { flex: 0 0 auto; }
        .mod-h { font-size: 14px; font-weight: 600; margin: 14px 0 2px; }
        @media (max-width: 640px) {
          .altsnap-opt-row { flex-direction: column; align-items: stretch; }
        }
      `}</style>
    </div>
  );
}
