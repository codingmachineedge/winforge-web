import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// Native module — a manager front-end for PowerToys FancyZones (視窗分區), ported from
// WinForge's FancyZonesModule + FancyZonesService + FancyZonesOperations.
//
// The zone engine itself stays native PowerToys (a C++ mouse/keyboard hook that draws zones and
// snaps windows with SetWindowPos) — it cannot be reimplemented. So this view talks to the live
// system through PowerShell: it detects the PowerToys install (Program Files / LocalAppData /
// uninstall registry), reads the version + running state, reads FancyZones' JSON settings
// (%LOCALAPPDATA%\Microsoft\PowerToys\settings.json + FancyZones\settings.json +
// custom-layouts.json + applied-layouts.json), toggles the module and every behaviour flag by
// rewriting those JSON files (preserving the rest) and restarting the PowerToys runner, launches
// PowerToys / the zone editor (via the named runner toggle event, exe fallback) / the FancyZones
// settings page, imports/exports the layout JSON files, and adds an in-app zone-layout editor that
// composes column/row/grid/priority-grid/focus templates + drag-editable custom zones and saves
// them into PowerToys' custom-layouts.json in the native schema. Read-mostly and defensive; every
// mutation is explicit and click-gated, destructive ones confirm.

// ---- Detection payload (one PowerShell probe returns everything the header needs) ----
interface AppliedLayout {
  device: string;
  type: string; // 'grid' | 'columns' | 'rows' | 'grid' | 'priority-grid' | 'focus' | 'custom' | ''
  zoneCount: number | null;
  customName: string | null;
}
interface Probe {
  installed: boolean;
  hostPath: string | null;
  version: string | null;
  running: boolean;
  editorRunning: boolean;
  moduleEnabled: boolean | null; // null = settings.json missing / unreadable
  settingsExists: boolean;
  fancyZonesDir: string | null;
  customLayouts: string[];
  applied: AppliedLayout[]; // per-monitor applied layouts (applied-layouts.json)
  props: Record<string, boolean>; // resolved FancyZones behaviour flags (default-filled)
}

// ---- Behaviour toggles: exact FancyZones settings.json property + PowerToys default ----
interface Op {
  id: string;
  prop: string;
  def: boolean;
  group: string;
  keywords: string;
}
const OPS: Op[] = [
  // Dragging & snapping
  { id: 'shiftDrag', prop: 'fancyzones_shiftDrag', def: true, group: 'dragging', keywords: 'shift drag snap 貼齊 拖曳' },
  { id: 'mouseSwitch', prop: 'fancyzones_mouseSwitch', def: false, group: 'dragging', keywords: 'mouse switch 滑鼠' },
  { id: 'middleClickSpan', prop: 'fancyzones_mouseMiddleClickSpanningMultipleZones', def: false, group: 'dragging', keywords: 'middle click span 中鍵 跨' },
  { id: 'allowChildSnap', prop: 'fancyzones_allowChildWindowSnap', def: false, group: 'dragging', keywords: 'child window snap 子視窗' },
  // Keyboard
  { id: 'overrideSnapHotkeys', prop: 'fancyzones_overrideSnapHotkeys', def: false, group: 'keyboard', keywords: 'hotkey override win arrow 熱鍵 方向鍵 移動' },
  { id: 'moveBasedOnPosition', prop: 'fancyzones_moveWindowsBasedOnPosition', def: false, group: 'keyboard', keywords: 'position move 位置 移動' },
  { id: 'windowSwitching', prop: 'fancyzones_windowSwitching', def: false, group: 'keyboard', keywords: 'switch windows tab 切換' },
  // Multiple monitors
  { id: 'moveAcrossMonitors', prop: 'fancyzones_moveWindowAcrossMonitors', def: false, group: 'monitors', keywords: 'monitor move 顯示器 跨' },
  { id: 'spanAcrossMonitors', prop: 'fancyzones_span_zones_across_monitors', def: false, group: 'monitors', keywords: 'span monitor 跨 顯示器' },
  { id: 'showOnAllMonitors', prop: 'fancyzones_show_on_all_monitors', def: false, group: 'monitors', keywords: 'all monitors show 所有 顯示器' },
  { id: 'openOnActiveMonitor', prop: 'fancyzones_openWindowOnActiveMonitor', def: false, group: 'monitors', keywords: 'active monitor open 作用中 顯示器' },
  // Behaviour
  { id: 'restoreSize', prop: 'fancyzones_restoreSize', def: false, group: 'behaviour', keywords: 'restore size 還原 大小' },
  { id: 'appLastZone', prop: 'fancyzones_appLastZone_moveWindows', def: false, group: 'behaviour', keywords: 'last zone app 上次 分區' },
  { id: 'zoneSetChangeMove', prop: 'fancyzones_zoneSetChange_moveWindows', def: false, group: 'behaviour', keywords: 'layout change move 版面 切換' },
  { id: 'displayChangeMove', prop: 'fancyzones_displayOrWorkAreaChange_moveWindows', def: false, group: 'behaviour', keywords: 'display change move 顯示 改變' },
  { id: 'quickSwitch', prop: 'fancyzones_quickLayoutSwitch', def: true, group: 'behaviour', keywords: 'quick switch number 快速 數字' },
  { id: 'flashOnSwitch', prop: 'fancyzones_flashZonesOnQuickSwitch', def: true, group: 'behaviour', keywords: 'flash quick 閃 快速' },
  // Appearance
  { id: 'systemTheme', prop: 'fancyzones_systemTheme', def: true, group: 'appearance', keywords: 'theme colour 主題 顏色' },
  { id: 'showZoneNumber', prop: 'fancyzones_showZoneNumber', def: true, group: 'appearance', keywords: 'number zone 編號 分區' },
  { id: 'makeTransparent', prop: 'fancyzones_makeDraggedWindowTransparent', def: true, group: 'appearance', keywords: 'transparent drag 透明 拖曳' },
  { id: 'disableRoundCorners', prop: 'fancyzones_disableRoundCornersOnSnap', def: false, group: 'appearance', keywords: 'rounded corners 圓角' },
];
const OP_GROUPS = ['dragging', 'keyboard', 'monitors', 'behaviour', 'appearance'] as const;

// ---- Built-in layout previews: relative rects (x,y,w,h in 0..1), mirroring WinForge's BuiltInLayouts ----
type Cell = [number, number, number, number];
const LAYOUTS: { id: string; cells: Cell[] }[] = [
  { id: 'focus', cells: [[0.1, 0.16, 0.45, 0.55], [0.28, 0.3, 0.45, 0.55]] },
  { id: 'columns', cells: [[0.02, 0.05, 0.3, 0.9], [0.35, 0.05, 0.3, 0.9], [0.68, 0.05, 0.3, 0.9]] },
  { id: 'rows', cells: [[0.05, 0.04, 0.9, 0.28], [0.05, 0.36, 0.9, 0.28], [0.05, 0.68, 0.9, 0.28]] },
  { id: 'grid', cells: [[0.04, 0.06, 0.44, 0.4], [0.52, 0.06, 0.44, 0.4], [0.04, 0.54, 0.44, 0.4], [0.52, 0.54, 0.44, 0.4]] },
  { id: 'priorityGrid', cells: [[0.04, 0.06, 0.3, 0.88], [0.37, 0.06, 0.3, 0.88], [0.7, 0.06, 0.26, 0.42], [0.7, 0.52, 0.26, 0.42]] },
];

const HOTKEYS: { keys: string; id: string }[] = [
  { keys: 'Shift', id: 'shift' },
  { keys: 'Win + Ctrl + Arrow', id: 'winCtrlArrow' },
  { keys: 'Win + Arrow', id: 'winArrow' },
  { keys: 'Win + Shift + `', id: 'editor' },
  { keys: 'Ctrl + Win + Alt + Number', id: 'quickSwitch' },
];

// Single-quote escaping for embedding a literal into a PowerShell '…' string.
const psq = (s: string) => s.replace(/'/g, "''");

// PowerShell probe: resolve PowerToys + read all FancyZones JSON in one shot, emit one JSON object.
// $propList is injected so PowerShell resolves each behaviour flag to its live value or the default.
function buildProbeScript(): string {
  const propDefaults = OPS.map((o) => `'${o.prop}'=${o.def ? '$true' : '$false'}`).join(';');
  return `
$ErrorActionPreference='SilentlyContinue'
function Find-Host {
  $c = @()
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles 'PowerToys\\PowerToys.exe') }
  if (${'${env:ProgramFiles(x86)}'} ) { $c += (Join-Path ${'${env:ProgramFiles(x86)}'} 'PowerToys\\PowerToys.exe') }
  if ($env:LOCALAPPDATA) {
    $c += (Join-Path $env:LOCALAPPDATA 'PowerToys\\PowerToys.exe')
    $c += (Join-Path $env:LOCALAPPDATA 'Programs\\PowerToys\\PowerToys.exe')
  }
  foreach ($p in $c) { if (Test-Path -LiteralPath $p) { return $p } }
  $keys = @(
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  )
  foreach ($k in $keys) {
    Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*PowerToys*' -and $_.InstallLocation } | ForEach-Object {
      $exe = Join-Path $_.InstallLocation 'PowerToys.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  return $null
}
$host2 = Find-Host
$installed = [bool]$host2
$ver = $null
if ($installed) { try { $ver = (Get-Item -LiteralPath $host2).VersionInfo.ProductVersion } catch {} }
$running = @(Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue).Count -gt 0
$editorRunning = @(Get-Process -Name 'PowerToys.FancyZonesEditor' -ErrorAction SilentlyContinue).Count -gt 0
$root = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys'
$fzDir = Join-Path $root 'FancyZones'
$topPath = Join-Path $root 'settings.json'
$fzPath = Join-Path $fzDir 'settings.json'
$clPath = Join-Path $fzDir 'custom-layouts.json'
$alPath = Join-Path $fzDir 'applied-layouts.json'
$settingsExists = Test-Path -LiteralPath $topPath
$moduleEnabled = $null
if ($settingsExists) {
  try { $top = Get-Content -LiteralPath $topPath -Raw | ConvertFrom-Json; if ($top.enabled -and ($top.enabled.PSObject.Properties.Name -contains 'FancyZones')) { $moduleEnabled = [bool]$top.enabled.FancyZones } } catch {}
}
$defaults = @{${propDefaults}}
$props = @{}
$fz = $null
if (Test-Path -LiteralPath $fzPath) { try { $fz = Get-Content -LiteralPath $fzPath -Raw | ConvertFrom-Json } catch {} }
foreach ($name in $defaults.Keys) {
  $val = $defaults[$name]
  if ($fz -and $fz.properties -and ($fz.properties.PSObject.Properties.Name -contains $name)) {
    $p = $fz.properties.$name
    if ($p -is [bool]) { $val = $p } elseif ($p -and ($p.PSObject.Properties.Name -contains 'value')) { $val = [bool]$p.value }
  }
  $props[$name] = [bool]$val
}
$custom = @()
$customIndex = @{}
if (Test-Path -LiteralPath $clPath) {
  try {
    $cl = Get-Content -LiteralPath $clPath -Raw | ConvertFrom-Json
    $arr = if ($cl -is [array]) { $cl } elseif ($cl.'custom-layouts') { $cl.'custom-layouts' } else { @() }
    foreach ($it in $arr) { if ($it.name) { $custom += [string]$it.name; if ($it.uuid) { $customIndex[[string]$it.uuid] = [string]$it.name } } }
  } catch {}
}
$applied = @()
if (Test-Path -LiteralPath $alPath) {
  try {
    $al = Get-Content -LiteralPath $alPath -Raw | ConvertFrom-Json
    $arr2 = if ($al.'applied-layouts') { $al.'applied-layouts' } elseif ($al -is [array]) { $al } else { @() }
    foreach ($it in $arr2) {
      $dev = ''
      if ($it.device) {
        if ($it.device -is [string]) { $dev = [string]$it.device }
        elseif ($it.device.monitor) { $dev = [string]$it.device.monitor }
      }
      if (-not $dev -and $it.'device-id') { $dev = [string]$it.'device-id' }
      $ap = $it.'applied-layout'
      $type = ''
      $zc = $null
      $cn = $null
      if ($ap) {
        if ($ap.type) { $type = [string]$ap.type }
        if ($ap.PSObject.Properties.Name -contains 'zone-count') { $zc = [int]$ap.'zone-count' }
        if ($type -eq 'custom' -and $ap.uuid -and $customIndex.ContainsKey([string]$ap.uuid)) { $cn = $customIndex[[string]$ap.uuid] }
      }
      $applied += [pscustomobject]@{ device = $dev; type = $type; zoneCount = $zc; customName = $cn }
    }
  } catch {}
}
[pscustomobject]@{
  installed = $installed; hostPath = $host2; version = $ver; running = $running; editorRunning = $editorRunning;
  moduleEnabled = $moduleEnabled; settingsExists = $settingsExists; fancyZonesDir = $fzDir;
  customLayouts = @($custom); applied = @($applied); props = $props
}`;
}

// Write a boolean into the top-level settings.json enabled.FancyZones flag and restart the runner.
function buildSetModuleScript(enable: boolean): string {
  return `
$ErrorActionPreference='Stop'
$root = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$path = Join-Path $root 'settings.json'
$obj = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $obj.enabled) { $obj | Add-Member -NotePropertyName enabled -NotePropertyValue ([pscustomobject]@{}) -Force }
$obj.enabled | Add-Member -NotePropertyName FancyZones -NotePropertyValue ${enable ? '$true' : '$false'} -Force
$obj | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
'OK'`;
}

// Write a boolean FancyZones property (wrapped as {"value":...}) and restart the runner.
function buildSetPropScript(prop: string, value: boolean): string {
  return `
$ErrorActionPreference='Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\FancyZones'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir 'settings.json'
$obj = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $obj.name) { $obj | Add-Member -NotePropertyName name -NotePropertyValue 'FancyZones' -Force }
if (-not $obj.version) { $obj | Add-Member -NotePropertyName version -NotePropertyValue '1.0' -Force }
if (-not $obj.properties) { $obj | Add-Member -NotePropertyName properties -NotePropertyValue ([pscustomobject]@{}) -Force }
$obj.properties | Add-Member -NotePropertyName '${psq(prop)}' -NotePropertyValue ([pscustomobject]@{ value = ${value ? '$true' : '$false'} }) -Force
$obj | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
'OK'`;
}

// Restart the PowerToys runner from the resolved host path (best-effort; runs detached).
function buildRelaunchScript(hostPath: string): string {
  return `Start-Process -FilePath '${psq(hostPath)}' -ErrorAction SilentlyContinue; 'OK'`;
}

// Open the FancyZones zone editor the way the C# service does: ensure PowerToys is running, then
// Set() the named runner toggle event so the runner opens the editor (it writes monitor parameters
// first). Fall back to launching the editor exe next to PowerToys.exe.
const EDITOR_TOGGLE_EVENT = 'Local\\FancyZones-ToggleEditorEvent-1e174338-06a3-472b-874d-073b21c62f14';
function buildOpenEditorScript(hostPath: string): string {
  return `
$ErrorActionPreference='SilentlyContinue'
$host2 = '${psq(hostPath)}'
$dir = Split-Path -Parent $host2
if (-not (@(Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue).Count -gt 0)) {
  Start-Process -FilePath $host2
  Start-Sleep -Milliseconds 700
}
$signaled = $false
try {
  $ev = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::AutoReset, '${EDITOR_TOGGLE_EVENT}')
  [void]$ev.Set()
  $ev.Dispose()
  $signaled = $true
} catch { $signaled = $false }
if (-not $signaled) {
  $ed = Join-Path $dir 'PowerToys.FancyZonesEditor.exe'
  if (Test-Path -LiteralPath $ed) { Start-Process -FilePath $ed -WorkingDirectory $dir } else { Start-Process -FilePath $host2 }
}
'OK'`;
}

// Import a layout JSON file: validate it parses, then copy it into the FancyZones folder under the
// right filename (known files keep their name; anything else lands as custom-layouts.json). Mirrors
// FancyZonesService.ImportLayoutFile. Restarts the runner.
function buildImportScript(sourceFile: string): string {
  return `
$ErrorActionPreference='Stop'
$src = '${psq(sourceFile)}'
if (-not (Test-Path -LiteralPath $src)) { throw 'Source file not found.' }
try { $null = Get-Content -LiteralPath $src -Raw | ConvertFrom-Json } catch { throw 'That file is not valid JSON.' }
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\FancyZones'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$name = Split-Path -Leaf $src
$known = @('custom-layouts.json','applied-layouts.json','layout-templates.json','layout-hotkeys.json')
$dest = if ($known -contains $name.ToLowerInvariant()) { Join-Path $dir $name } else { Join-Path $dir 'custom-layouts.json' }
Copy-Item -LiteralPath $src -Destination $dest -Force
Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
Split-Path -Leaf $dest`;
}

// Export the FancyZones JSON files to a folder. Mirrors FancyZonesService.ExportLayouts.
function buildExportScript(targetFolder: string): string {
  return `
$ErrorActionPreference='Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\FancyZones'
if (-not (Test-Path -LiteralPath $dir)) { throw 'No FancyZones data folder found yet.' }
$target = '${psq(targetFolder)}'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$n = 0
Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
  try { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) -Force; $n++ } catch {}
}
if ($n -le 0) { throw 'Nothing was exported.' }
"$n"`;
}

// Append a designed layout into custom-layouts.json in PowerToys' native schema and restart the
// runner. `grid` type stores rows/columns/cell-child-map; `canvas` type stores absolute zones.
// The JSON is built here (as a compact string) and injected as a literal so PowerShell only merges
// it into the existing array — no schema logic in PowerShell.
function buildSaveCustomLayoutScript(layoutJson: string): string {
  return `
$ErrorActionPreference='Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\FancyZones'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir 'custom-layouts.json'
$new = '${psq(layoutJson)}' | ConvertFrom-Json
$list = @()
if (Test-Path -LiteralPath $path) {
  try {
    $cur = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($cur -is [array]) { $list = @($cur) }
    elseif ($cur.'custom-layouts') { $list = @($cur.'custom-layouts') }
  } catch { $list = @() }
}
$list = @($list) + $new
$out = [pscustomobject]@{ 'custom-layouts' = @($list) }
$out | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding UTF8
Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
'${psq('SAVED')}'`;
}

// RFC-4122-ish uuid for the custom layout (PowerToys wraps it in braces). crypto when available.
function newUuid(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = g?.randomUUID
    ? g.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
  return `{${raw.toUpperCase()}}`;
}

function MiniSwitch({ on, disabled, onLabel, offLabel, onToggle }: { on: boolean; disabled: boolean; onLabel: string; offLabel: string; onToggle: (next: boolean) => void }) {
  return (
    <span className="row-actions">
      <button className={`mini${on ? ' primary' : ''}`} disabled={disabled || on} onClick={() => onToggle(true)}>
        {onLabel}
      </button>
      <button className={`mini${!on ? ' primary' : ''}`} disabled={disabled || !on} onClick={() => onToggle(false)}>
        {offLabel}
      </button>
    </span>
  );
}

// ============================ Zone-layout editor ============================
// A grid or canvas of zones the user can compose, drag and resize in-app, then save into
// PowerToys' custom-layouts.json. Zones are stored in a 0..1 relative space so the editor is
// resolution-independent (matching the built-in previews). Grid mode emits the PowerToys `grid`
// schema (rows/columns/percents/cell-child-map); canvas mode emits the `canvas` schema at a
// reference 1920×1080 work area.

interface EZone {
  id: number;
  x: number; // 0..1
  y: number;
  w: number;
  h: number;
}

type Handle = 'move' | 'e' | 's' | 'se';

// Seed the canvas editor from one of the built-in templates or a rows×cols grid.
function seedZones(kind: string, cols: number, rows: number): EZone[] {
  let nid = 1;
  const mk = (x: number, y: number, w: number, h: number): EZone => ({ id: nid++, x, y, w, h });
  const gap = 0.006;
  if (kind === 'focus') {
    return [mk(0.08, 0.12, 0.5, 0.6), mk(0.42, 0.28, 0.5, 0.6)];
  }
  if (kind === 'columns') {
    const n = Math.max(1, cols);
    return Array.from({ length: n }, (_, i) => mk(i / n + gap, gap, 1 / n - gap * 2, 1 - gap * 2));
  }
  if (kind === 'rows') {
    const n = Math.max(1, rows);
    return Array.from({ length: n }, (_, i) => mk(gap, i / n + gap, 1 - gap * 2, 1 / n - gap * 2));
  }
  if (kind === 'priorityGrid') {
    return [
      mk(gap, gap, 0.3 - gap, 1 - gap * 2),
      mk(0.33 + gap, gap, 0.34 - gap * 2, 1 - gap * 2),
      mk(0.67 + gap, gap, 0.33 - gap * 2, 0.5 - gap),
      mk(0.67 + gap, 0.5 + gap, 0.33 - gap * 2, 0.5 - gap * 2),
    ];
  }
  // grid: cols × rows
  const c = Math.max(1, cols);
  const r = Math.max(1, rows);
  const out: EZone[] = [];
  for (let ri = 0; ri < r; ri++) {
    for (let ci = 0; ci < c; ci++) {
      out.push(mk(ci / c + gap, ri / r + gap, 1 / c - gap * 2, 1 / r - gap * 2));
    }
  }
  return out;
}

// Build a PowerToys `canvas` custom-layout object from the editor zones (reference 1920×1080).
function toCanvasLayout(name: string, zones: EZone[]): unknown {
  const RW = 1920;
  const RH = 1080;
  return {
    uuid: newUuid(),
    name,
    type: 'canvas',
    'zone-count': zones.length,
    info: {
      'ref-width': RW,
      'ref-height': RH,
      zones: zones.map((z) => ({
        X: Math.round(z.x * RW),
        Y: Math.round(z.y * RH),
        width: Math.round(z.w * RW),
        height: Math.round(z.h * RH),
      })),
      'sensitivity-radius': 20,
    },
  };
}

// Build a PowerToys `grid` custom-layout object from an even cols×rows grid.
function toGridLayout(name: string, cols: number, rows: number): unknown {
  const c = Math.max(1, cols);
  const r = Math.max(1, rows);
  const rowPct = Array.from({ length: r }, () => Math.floor(10000 / r));
  const colPct = Array.from({ length: c }, () => Math.floor(10000 / c));
  // fix rounding so each dimension sums to exactly 10000
  rowPct[0] = (rowPct[0] ?? 0) + (10000 - rowPct.reduce((a, b) => a + b, 0));
  colPct[0] = (colPct[0] ?? 0) + (10000 - colPct.reduce((a, b) => a + b, 0));
  let cell = 0;
  const map = Array.from({ length: r }, () => Array.from({ length: c }, () => cell++));
  return {
    uuid: newUuid(),
    name,
    type: 'grid',
    'zone-count': c * r,
    info: {
      rows: r,
      columns: c,
      'rows-percentage': rowPct,
      'columns-percentage': colPct,
      'cell-child-map': map,
      'show-spacing': true,
      spacing: 16,
      'sensitivity-radius': 20,
    },
  };
}

const CANVAS_W = 460;
const CANVAS_H = 288;

function LayoutEditor({
  installed,
  desktop,
  busy,
  onSave,
}: {
  installed: boolean;
  desktop: boolean;
  busy: string | null;
  onSave: (name: string, layout: unknown, mode: 'grid' | 'canvas', cols: number, rows: number) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'grid' | 'canvas'>('grid');
  const [template, setTemplate] = useState('grid');
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(2);
  const [name, setName] = useState('');
  const [zones, setZones] = useState<EZone[]>(() => seedZones('grid', 3, 2));
  const [sel, setSel] = useState<number | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; handle: Handle; sx: number; sy: number; z: EZone } | null>(null);

  const reseed = useCallback(
    (tpl: string, c: number, r: number) => {
      setZones(seedZones(tpl, c, r));
      setSel(null);
    },
    [],
  );

  const applyTemplate = (tpl: string) => {
    setTemplate(tpl);
    if (tpl === 'grid') setMode('grid');
    else setMode('canvas');
    reseed(tpl, cols, rows);
  };

  const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

  const onPointerDown = (e: React.PointerEvent, id: number, handle: Handle) => {
    if (!installed || !desktop) return;
    e.stopPropagation();
    e.preventDefault();
    const z = zones.find((zz) => zz.id === id);
    if (!z) return;
    setSel(id);
    setMode('canvas'); // any manual edit means we save absolute zones
    drag.current = { id, handle, sx: e.clientX, sy: e.clientY, z: { ...z } };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const area = areaRef.current;
    if (!d || !area) return;
    const rect = area.getBoundingClientRect();
    const dx = (e.clientX - d.sx) / rect.width;
    const dy = (e.clientY - d.sy) / rect.height;
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== d.id) return z;
        const base = d.z;
        if (d.handle === 'move') {
          return { ...z, x: clamp(base.x + dx, 0, 1 - base.w), y: clamp(base.y + dy, 0, 1 - base.h) };
        }
        let w = base.w;
        let h = base.h;
        if (d.handle === 'e' || d.handle === 'se') w = clamp(base.w + dx, 0.05, 1 - base.x);
        if (d.handle === 's' || d.handle === 'se') h = clamp(base.h + dy, 0.05, 1 - base.y);
        return { ...z, w, h };
      }),
    );
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      drag.current = null;
    }
  };

  const addZone = () => {
    setMode('canvas');
    setZones((prev) => {
      const id = prev.reduce((m, z) => Math.max(m, z.id), 0) + 1;
      return [...prev, { id, x: 0.3, y: 0.3, w: 0.35, h: 0.35 }];
    });
  };
  const removeSel = () => {
    if (sel == null) return;
    setZones((prev) => prev.filter((z) => z.id !== sel));
    setSel(null);
    setMode('canvas');
  };

  const canSave = installed && desktop && zones.length > 0 && busy !== 'saveLayout';
  const save = () => {
    const nm = name.trim() || t('fancyzones.ed_defaultName');
    if (mode === 'grid' && template === 'grid') {
      onSave(nm, toGridLayout(nm, cols, rows), 'grid', cols, rows);
    } else {
      onSave(nm, toCanvasLayout(nm, zones), 'canvas', cols, rows);
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('fancyzones.ed_blurb')}
      </p>

      {/* Template picker */}
      <div className="panel">
        <div className="dt-wrap">
          <h4>{t('fancyzones.ed_templateHeader')}</h4>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          {['grid', 'columns', 'rows', 'priorityGrid', 'focus'].map((tpl) => (
            <button
              key={tpl}
              className={`mini${template === tpl ? ' primary' : ''}`}
              onClick={() => applyTemplate(tpl)}
            >
              {t(`fancyzones.ed_tpl_${tpl}`)}
            </button>
          ))}
        </div>
        <div className="kv-row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
          <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('fancyzones.ed_columns')}
            <input
              type="number"
              min={1}
              max={12}
              value={cols}
              className="mod-search"
              style={{ width: 64 }}
              onChange={(e) => {
                const v = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                setCols(v);
                reseed(template, v, rows);
              }}
            />
          </label>
          <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('fancyzones.ed_rows')}
            <input
              type="number"
              min={1}
              max={12}
              value={rows}
              className="mod-search"
              style={{ width: 64 }}
              onChange={(e) => {
                const v = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                setRows(v);
                reseed(template, cols, v);
              }}
            />
          </label>
          <span className="count-note">{t('fancyzones.ed_zoneCount', { n: zones.length })}</span>
        </div>
      </div>

      {/* Canvas */}
      <div className="panel">
        <div className="dt-wrap">
          <h4>{t('fancyzones.ed_canvasHeader')}</h4>
        </div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('fancyzones.ed_canvasHint')}
        </p>
        <div
          ref={areaRef}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerDown={() => setSel(null)}
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: CANVAS_W,
            aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
            background: 'var(--code-bg, rgba(127,127,127,0.10))',
            border: '1px solid var(--stroke, #333)',
            borderRadius: 8,
            touchAction: 'none',
            userSelect: 'none',
            overflow: 'hidden',
          }}
        >
          {zones.map((z, i) => {
            const selected = z.id === sel;
            return (
              <div
                key={z.id}
                onPointerDown={(e) => onPointerDown(e, z.id, 'move')}
                style={{
                  position: 'absolute',
                  left: `${z.x * 100}%`,
                  top: `${z.y * 100}%`,
                  width: `${z.w * 100}%`,
                  height: `${z.h * 100}%`,
                  boxSizing: 'border-box',
                  border: `1.5px solid var(--accent, #0078d7)`,
                  background: selected ? 'var(--accent-soft, rgba(0,120,215,0.34))' : 'var(--accent-soft, rgba(0,120,215,0.18))',
                  borderRadius: 4,
                  cursor: installed && desktop ? 'move' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text, #ddd)',
                }}
              >
                {i + 1}
                {/* resize handles */}
                <span
                  onPointerDown={(e) => onPointerDown(e, z.id, 'e')}
                  style={{ position: 'absolute', right: -3, top: '50%', transform: 'translateY(-50%)', width: 8, height: 22, cursor: 'ew-resize', background: 'var(--accent, #0078d7)', borderRadius: 2, opacity: selected ? 1 : 0.5 }}
                />
                <span
                  onPointerDown={(e) => onPointerDown(e, z.id, 's')}
                  style={{ position: 'absolute', bottom: -3, left: '50%', transform: 'translateX(-50%)', width: 22, height: 8, cursor: 'ns-resize', background: 'var(--accent, #0078d7)', borderRadius: 2, opacity: selected ? 1 : 0.5 }}
                />
                <span
                  onPointerDown={(e) => onPointerDown(e, z.id, 'se')}
                  style={{ position: 'absolute', right: -4, bottom: -4, width: 11, height: 11, cursor: 'nwse-resize', background: 'var(--accent, #0078d7)', borderRadius: 2, opacity: selected ? 1 : 0.6 }}
                />
              </div>
            );
          })}
        </div>

        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <button className="mini" disabled={!installed || !desktop} onClick={addZone}>
            {t('fancyzones.ed_addZone')}
          </button>
          <button className="mini danger" disabled={!installed || !desktop || sel == null} onClick={removeSel}>
            {t('fancyzones.ed_removeZone')}
          </button>
          <button className="mini" disabled={!installed || !desktop} onClick={() => reseed(template, cols, rows)}>
            {t('fancyzones.ed_reset')}
          </button>
        </div>
      </div>

      {/* Save */}
      <div className="panel">
        <div className="dt-wrap">
          <h4>{t('fancyzones.ed_saveHeader')}</h4>
        </div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {mode === 'grid' && template === 'grid' ? t('fancyzones.ed_saveGrid') : t('fancyzones.ed_saveCanvas')}
        </p>
        <div className="kv-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ maxWidth: 260 }}
            placeholder={t('fancyzones.ed_namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="mini primary" disabled={!canSave} onClick={save}>
            {busy === 'saveLayout' ? t('fancyzones.working') : t('fancyzones.ed_save')}
          </button>
        </div>
        {(!installed || !desktop) && (
          <p className="count-note" style={{ marginTop: 8, fontStyle: 'italic' }}>
            {t('fancyzones.ed_needInstall')}
          </p>
        )}
      </div>
    </div>
  );
}

export function FancyZonesModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [exportPath, setExportPath] = useState('');

  const probe = useAsync<Probe | null>(async () => {
    if (!desktop) return null;
    const rows = await runPowershellJson<Probe>(buildProbeScript());
    return rows[0] ?? null;
  }, [desktop]);

  const data = probe.data;
  const installed = data?.installed ?? false;
  const props = data?.props ?? {};

  const clear = () => {
    setMsg(null);
    setErr(null);
  };

  const relaunch = async (hostPath: string | null) => {
    if (hostPath) {
      try {
        await runPowershell(buildRelaunchScript(hostPath));
      } catch {
        /* best-effort */
      }
    }
  };

  // Toggle the whole FancyZones module in the top-level settings.json.
  const setModule = async (enable: boolean) => {
    clear();
    setBusy('module');
    try {
      const r = await runPowershell(buildSetModuleScript(enable));
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      await relaunch(data?.hostPath ?? null);
      setMsg(enable ? t('fancyzones.moduleOn') : t('fancyzones.moduleOff'));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Write one behaviour flag into FancyZones/settings.json and reload PowerToys.
  const setProp = async (op: Op, value: boolean) => {
    clear();
    setBusy(op.id);
    try {
      const r = await runPowershell(buildSetPropScript(op.prop, value));
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      await relaunch(data?.hostPath ?? null);
      setMsg(t('fancyzones.applied'));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Launch PowerToys, open the zone editor (named event + exe fallback), or open the settings page.
  const runAction = async (kind: 'launch' | 'editor' | 'settings') => {
    clear();
    const host = data?.hostPath;
    if (!host) {
      setErr(t('fancyzones.notInstalled'));
      return;
    }
    setBusy(kind);
    try {
      let script: string;
      if (kind === 'launch') {
        script = `Start-Process -FilePath '${psq(host)}'; 'OK'`;
      } else if (kind === 'settings') {
        script = `Start-Process -FilePath '${psq(host)}' -ArgumentList '--open-settings=FancyZones'; 'OK'`;
      } else {
        script = buildOpenEditorScript(host);
      }
      const r = await runPowershell(script);
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      setMsg(t(`fancyzones.action_${kind}_ok`));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Import a layout JSON file (path is user-provided; the write is explicit and gated).
  const importLayout = async () => {
    clear();
    const src = importPath.trim();
    if (!src) {
      setErr(t('fancyzones.importNeedPath'));
      return;
    }
    setBusy('import');
    try {
      const r = await runPowershell(buildImportScript(src));
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      await relaunch(data?.hostPath ?? null);
      setMsg(t('fancyzones.importDone', { file: r.stdout.trim() || 'custom-layouts.json' }));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Export the FancyZones JSON files to a folder (explicit, gated).
  const exportLayouts = async () => {
    clear();
    const dst = exportPath.trim();
    if (!dst) {
      setErr(t('fancyzones.exportNeedPath'));
      return;
    }
    setBusy('export');
    try {
      const r = await runPowershell(buildExportScript(dst));
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      setMsg(t('fancyzones.exportDone', { n: r.stdout.trim() || '?' }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Save a designed layout into custom-layouts.json (explicit, gated + confirm).
  const saveLayout = async (name: string, layout: unknown) => {
    clear();
    if (!desktop || !installed) {
      setErr(t('fancyzones.notInstalled'));
      return;
    }
    if (!window.confirm(t('fancyzones.ed_confirm', { name }))) return;
    setBusy('saveLayout');
    try {
      const r = await runPowershell(buildSaveCustomLayoutScript(JSON.stringify(layout)));
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      await relaunch(data?.hostPath ?? null);
      setMsg(t('fancyzones.ed_saved', { name }));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  // Install PowerToys via winget (elevated installer; may prompt UAC). Explicit, user-triggered.
  const install = async () => {
    clear();
    setBusy('install');
    try {
      const r = await runPowershell(
        "winget install --id Microsoft.PowerToys -e --accept-source-agreements --accept-package-agreements; 'DONE'",
      );
      if (!r.success && !r.stdout.includes('DONE')) {
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      setMsg(t('fancyzones.installDone'));
      probe.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const statusLine = useMemo(() => {
    if (!data) return '';
    if (!installed) return t('fancyzones.statusNotInstalled');
    const verPart = data.version ? ` (v${data.version})` : '';
    const runPart = data.running ? t('fancyzones.running') : t('fancyzones.notRunning');
    const enPart =
      data.moduleEnabled === true
        ? t('fancyzones.fzOn')
        : data.moduleEnabled === false
          ? t('fancyzones.fzOff')
          : t('fancyzones.fzUnknown');
    return `${t('fancyzones.installed')}${verPart} · ${runPart} · ${enPart}`;
  }, [data, installed, t]);

  const q = filter.trim().toLowerCase();
  const shownOps = useMemo(
    () =>
      q
        ? OPS.filter((o) =>
            `${o.id} ${o.prop} ${o.keywords} ${t(`fancyzones.op_${o.id}_title`)} ${t(`fancyzones.op_${o.id}_desc`)}`
              .toLowerCase()
              .includes(q),
          )
        : OPS,
    [q, t],
  );

  const feedback = (
    <>
      {msg && <p className="dep-ok" style={{ marginTop: 8 }}>{msg}</p>}
      {err && <pre className="cmd-out error" style={{ marginTop: 8 }}>{err}</pre>}
    </>
  );

  // ── Overview tab: status, module toggle, actions, layouts, hotkeys, custom+applied, import/export ──
  const overview = (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('fancyzones.blurb')}
      </p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('fancyzones.desktopOnly')}
        </p>
      )}

      <AsyncState loading={probe.loading} error={probe.error}>
        {/* ── Install bar when PowerToys is missing ── */}
        {desktop && data && !installed && (
          <div className="panel" style={{ borderColor: 'var(--danger)' }}>
            <div className="dt-wrap">
              <h4>{t('fancyzones.notFoundTitle')}</h4>
            </div>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('fancyzones.notFoundHint')}
            </p>
            <button className="mini primary" disabled={!!busy} onClick={install}>
              {busy === 'install' ? t('fancyzones.installing') : t('fancyzones.install')}
            </button>
          </div>
        )}

        {/* ── Status + module toggle + primary actions ── */}
        <div className="panel">
          <div className="kv-row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <span className="label" style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, display: 'block' }}>{t('fancyzones.statusTitle')}</span>
              <span className="count-note" style={{ display: 'block' }}>{statusLine}</span>
            </span>
            <span className="row-actions" style={{ alignItems: 'center' }}>
              {installed && (
                <StatusDot ok={data?.running ?? false} label={data?.running ? t('fancyzones.running') : t('fancyzones.notRunning')} />
              )}
              <button className="mini" disabled={!!busy} onClick={probe.reload}>
                ⟳ {t('fancyzones.recheck')}
              </button>
            </span>
          </div>

          {/* Module enable toggle */}
          <div className="kv-row" style={{ alignItems: 'flex-start', gap: 12, marginTop: 10 }}>
            <span className="label" style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, display: 'block' }}>{t('fancyzones.moduleToggleTitle')}</span>
              <span className="count-note" style={{ display: 'block' }}>{t('fancyzones.moduleToggleSub')}</span>
            </span>
            <MiniSwitch
              on={data?.moduleEnabled === true}
              disabled={!desktop || !installed || busy === 'module'}
              onLabel={t('fancyzones.on')}
              offLabel={t('fancyzones.off')}
              onToggle={setModule}
            />
          </div>

          {/* Primary actions */}
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <button className="mini primary" disabled={!desktop || !installed || !!busy} onClick={() => runAction('launch')}>
              {busy === 'launch' ? t('fancyzones.working') : t('fancyzones.launch')}
            </button>
            <button className="mini" disabled={!desktop || !installed || !!busy} onClick={() => runAction('editor')}>
              {busy === 'editor' ? t('fancyzones.working') : t('fancyzones.openEditor')}
            </button>
            <button className="mini" disabled={!desktop || !installed || !!busy} onClick={() => runAction('settings')}>
              {busy === 'settings' ? t('fancyzones.working') : t('fancyzones.openSettings')}
            </button>
          </div>

          {feedback}
        </div>

        {/* ── Built-in layout previews ── */}
        <div className="panel">
          <div className="dt-wrap">
            <h4>{t('fancyzones.layoutsHeader')}</h4>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('fancyzones.layoutsHint')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {LAYOUTS.map((l) => (
              <div
                key={l.id}
                style={{
                  border: '1px solid var(--border, #333)',
                  borderRadius: 8,
                  padding: 10,
                  textAlign: 'center',
                }}
              >
                <svg viewBox="0 0 150 95" width={150} height={95} role="img" aria-label={t(`fancyzones.layout_${l.id}`)}>
                  {l.cells.map((c, i) => (
                    <rect
                      key={i}
                      x={c[0] * 150}
                      y={c[1] * 95}
                      width={Math.max(2, c[2] * 150)}
                      height={Math.max(2, c[3] * 95)}
                      rx={3}
                      ry={3}
                      fill="var(--accent-soft, rgba(0,120,215,0.24))"
                      stroke="var(--accent, #0078d7)"
                      strokeWidth={1.2}
                    />
                  ))}
                </svg>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>{t(`fancyzones.layout_${l.id}`)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Snap hotkeys reference ── */}
        <div className="panel">
          <div className="dt-wrap">
            <h4>{t('fancyzones.hotkeysHeader')}</h4>
          </div>
          <div className="kv-list">
            {HOTKEYS.map((h) => (
              <div key={h.id} className="kv-row" style={{ alignItems: 'flex-start', gap: 12, padding: '8px 0' }}>
                <code
                  style={{
                    minWidth: 190,
                    padding: '3px 8px',
                    borderRadius: 4,
                    background: 'var(--code-bg, rgba(127,127,127,0.14))',
                    fontFamily: 'Consolas, monospace',
                    fontSize: 12.5,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h.keys}
                </code>
                <span className="count-note" style={{ flex: 1 }}>{t(`fancyzones.hotkey_${h.id}`)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Applied (per-monitor) layouts ── */}
        <div className="panel">
          <div className="dt-wrap">
            <h4>{t('fancyzones.appliedHeader')}</h4>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('fancyzones.appliedHint')}
          </p>
          {(data?.applied.length ?? 0) === 0 ? (
            <p className="count-note" style={{ fontStyle: 'italic' }}>{t('fancyzones.appliedNone')}</p>
          ) : (
            <div className="kv-list">
              {data?.applied.map((a, i) => {
                const type = a.customName
                  ? a.customName
                  : a.type
                    ? t(`fancyzones.type_${a.type}`, a.type)
                    : t('fancyzones.type_unknown');
                return (
                  <div key={`${a.device}-${i}`} className="kv-row" style={{ gap: 12, padding: '6px 0' }}>
                    <code
                      style={{
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: 'var(--code-bg, rgba(127,127,127,0.14))',
                        fontSize: 11.5,
                      }}
                      title={a.device}
                    >
                      {a.device || t('fancyzones.monitorUnknown', { n: i + 1 })}
                    </code>
                    <span className="count-note" style={{ flex: 1 }}>
                      {type}
                      {a.zoneCount != null ? ` · ${t('fancyzones.zoneCountLabel', { n: a.zoneCount })}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Saved custom layouts (read live from custom-layouts.json) ── */}
        <div className="panel">
          <div className="dt-wrap">
            <h4>{t('fancyzones.customHeader')}</h4>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('fancyzones.customText')}
          </p>
          {(data?.customLayouts.length ?? 0) === 0 ? (
            <p className="count-note" style={{ fontStyle: 'italic' }}>{t('fancyzones.customNone')}</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data?.customLayouts.map((n, i) => (
                <li key={`${n}-${i}`} style={{ padding: '2px 0' }}>{n}</li>
              ))}
            </ul>
          )}

          {/* Import / export the layout JSON files (mirrors the C# Import/Export buttons) */}
          <div className="kv-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 220 }}
              placeholder={t('fancyzones.importPlaceholder')}
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
            <button className="mini" disabled={!desktop || !installed || !!busy} onClick={importLayout}>
              {busy === 'import' ? t('fancyzones.working') : t('fancyzones.importBtn')}
            </button>
          </div>
          <div className="kv-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 220 }}
              placeholder={t('fancyzones.exportPlaceholder')}
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
            />
            <button className="mini" disabled={!desktop || !installed || !!busy} onClick={exportLayouts}>
              {busy === 'export' ? t('fancyzones.working') : t('fancyzones.exportBtn')}
            </button>
          </div>
          <p className="count-note" style={{ marginTop: 8, fontStyle: 'italic' }}>
            {t('fancyzones.ioHint')}
          </p>
        </div>
      </AsyncState>
    </div>
  );

  // ── Behaviour tab: the 21 settings.json toggles ──
  const behaviour = (
    <div className="mod">
      <AsyncState loading={probe.loading} error={probe.error}>
        <div className="panel">
          <div className="dt-wrap">
            <h4>{t('fancyzones.opsHeader')}</h4>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('fancyzones.opsHint')}
          </p>
          <input
            className="mod-search"
            style={{ maxWidth: 320, marginBottom: 8 }}
            placeholder={t('fancyzones.opsFilter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {shownOps.length === 0 ? (
            <p className="count-note">{t('fancyzones.noMatch')}</p>
          ) : (
            OP_GROUPS.map((g) => {
              const inGroup = shownOps.filter((o) => o.group === g);
              if (inGroup.length === 0) return null;
              return (
                <div key={g} style={{ marginTop: 10 }}>
                  <div className="count-note" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {t(`fancyzones.group_${g}`)}
                  </div>
                  <div className="kv-list">
                    {inGroup.map((o) => {
                      const on = props[o.prop] ?? o.def;
                      return (
                        <div key={o.id} className="kv-row" style={{ alignItems: 'flex-start', gap: 12, padding: '10px 0' }}>
                          <span className="label" style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontWeight: 600, display: 'block' }}>{t(`fancyzones.op_${o.id}_title`)}</span>
                            <span className="count-note" style={{ display: 'block' }}>{t(`fancyzones.op_${o.id}_desc`)}</span>
                          </span>
                          <MiniSwitch
                            on={on}
                            disabled={!desktop || !installed || busy === o.id}
                            onLabel={t('fancyzones.on')}
                            offLabel={t('fancyzones.off')}
                            onToggle={(next) => setProp(o, next)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
          {feedback}
        </div>
      </AsyncState>
    </div>
  );

  // ── Layout-editor tab: compose + drag + save into custom-layouts.json ──
  const editor = (
    <>
      <LayoutEditor
        installed={installed}
        desktop={desktop}
        busy={busy}
        onSave={(name, layout) => saveLayout(name, layout)}
      />
      <div className="mod">{feedback}</div>
    </>
  );

  return (
    <ModuleTabs
      tabs={[
        { id: 'overview', en: 'Overview', zh: '總覽', render: () => overview },
        { id: 'editor', en: 'Layout editor', zh: '版面編輯器', render: () => editor },
        { id: 'behaviour', en: 'Behaviour', zh: '行為', render: () => behaviour },
      ]}
    />
  );
}
