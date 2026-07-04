import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ---------------------------------------------------------------------------
// Native clone of PowerToys "Mouse Utilities" (滑鼠工具).
//
// The C# WinForge page owns four transparent click-through overlays (Find My
// Mouse, Highlighter, Crosshairs, Mouse Jump) via Win32 global hooks and drives
// them through its own MouseUtilsService with an Enable toggle + live settings
// (activation / colour / size / opacity / fade) that are saved and applied
// instantly. Those hooks cannot run inside the Tauri PowerShell sandbox, so this
// port targets the SAME feature surface against PowerToys itself, which ships the
// identical four utilities:
//
//   * DETECT PowerToys (root settings.json + running process + version).
//   * Per-utility ENABLE toggle  -> root settings.json  "enabled.<Utility>".
//   * Every setting each utility exposes (activation method / colours / sizes /
//     opacity / fade / thumbnail size) editable -> per-module settings.json
//     "properties.<field>.value".
//   * GATED save: edits build a local draft; nothing touches disk until the
//     user clicks "Save" for that utility (writes enabled flag + properties).
//   * APPLY / RELOAD: "Apply" restarts PowerToys so it re-reads the files;
//     "Refresh" re-reads on-disk state.
//
// Reads auto-run. Every mutation (enable/disable, save, apply-restart) is
// click-gated. The bridge no-ops in a plain browser, so the full UI still renders.
// ---------------------------------------------------------------------------

type UtilKey = 'fmm' | 'hi' | 'cross' | 'jump';

// PowerToys root "enabled" map keys, and per-module settings folder names.
const PT_ENABLED_KEY: Record<UtilKey, string> = {
  fmm: 'FindMyMouse',
  hi: 'MouseHighlighter',
  cross: 'MousePointerCrosshairs',
  jump: 'MouseJump',
};
const PT_FOLDER: Record<UtilKey, string> = {
  fmm: 'FindMyMouse',
  hi: 'MouseHighlighter',
  cross: 'MousePointerCrosshairs',
  jump: 'MouseJump',
};
const HOTKEY: Record<UtilKey, string> = {
  fmm: 'Double-tap Left Ctrl',
  hi: 'Win + Shift + H',
  cross: 'Win + Shift + X',
  jump: 'Win + Shift + D',
};

// Editable settings for each utility, held as a flat draft record.
interface FmmDraft {
  activationMethod: number; // 0 DoubleControl, 1 Shake, 2 CustomShortcut
  spotlightRadius: number;
  overlayOpacity: number; // 0-100
  fadeMs: number;
  spotlightColor: string; // #RRGGBB
  backgroundColor: string; // #RRGGBB
}
interface HiDraft {
  highlightRadius: number;
  highlightOpacity: number; // 0-100
  fadeMs: number;
  leftColor: string; // #RRGGBB
  rightColor: string; // #RRGGBB
}
interface CrossDraft {
  thickness: number;
  gap: number;
  opacity: number; // 0-100
  color: string; // #RRGGBB
}
interface JumpDraft {
  thumbWidth: number;
  thumbHeight: number;
}

interface Draft {
  enabled: Record<UtilKey, boolean>;
  fmm: FmmDraft;
  hi: HiDraft;
  cross: CrossDraft;
  jump: JumpDraft;
}

interface Display {
  Name: string;
  Primary: boolean;
  Width: number;
  Height: number;
  X: number;
  Y: number;
}

// Raw probe shape emitted by the read PowerShell — one object per utility with
// numeric/string values ready to seed the editable draft.
interface Probe {
  Installed: boolean;
  Running: boolean;
  Version: string;
  Elevated: boolean;
  Startup: boolean;
  Enabled: Record<UtilKey, boolean>;
  Configured: Record<UtilKey, boolean>;
  Fmm: FmmDraft;
  Hi: HiDraft;
  Cross: CrossDraft;
  Jump: JumpDraft;
  Displays: Display[];
  VW: number;
  VH: number;
}

// PowerShell reads PowerToys' real settings tree + live screen geometry into one
// JSON object. Absent files fall back to PowerToys' documented defaults.
const READ_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$base = Join-Path $env:LOCALAPPDATA 'Microsoft\PowerToys'
$rootPath = Join-Path $base 'settings.json'
$installed = Test-Path $rootPath
$root = if ($installed) { Get-Content $rootPath -Raw | ConvertFrom-Json } else { $null }
$enabled = if ($root) { $root.enabled } else { $null }
$running = [bool](Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue)

function IsOn($name) { if ($enabled -and ($enabled.PSObject.Properties.Name -contains $name)) { [bool]$enabled.$name } else { $false } }
function Load($folder) {
  $p = Join-Path $base (Join-Path $folder 'settings.json')
  if (Test-Path $p) { try { return Get-Content $p -Raw | ConvertFrom-Json } catch { return $null } }
  return $null
}
function Hex($v, $default) {
  if ($null -eq $v) { return $default }
  $s = "$v".TrimStart('#')
  if ($s.Length -ge 8) { $s = $s.Substring($s.Length-6,6) }   # ARGB -> RGB tail
  if ($s.Length -ge 6) { return '#' + $s.Substring(0,6).ToUpper() }
  return $default
}
function Prop($obj, $path, $default) {
  $cur = $obj
  foreach ($seg in $path.Split('.')) {
    if ($null -eq $cur) { return $default }
    $pp = $cur.PSObject.Properties[$seg]
    if ($null -eq $pp) { return $default }
    $cur = $pp.Value
  }
  if ($null -eq $cur) { return $default }
  return $cur
}

$f = Load 'FindMyMouse'
$h = Load 'MouseHighlighter'
$c = Load 'MousePointerCrosshairs'
$j = Load 'MouseJump'

[pscustomobject]@{
  Installed = $installed
  Running = $running
  Version = if ($root) { "$($root.powertoys_version)" } else { '' }
  Elevated = if ($root) { [bool](Prop $root 'is_elevated' $false) } else { $false }
  Startup = if ($root) { [bool](Prop $root 'startup' $false) } else { $false }
  Enabled = [pscustomobject]@{
    fmm=(IsOn 'FindMyMouse'); hi=(IsOn 'MouseHighlighter'); cross=(IsOn 'MousePointerCrosshairs'); jump=(IsOn 'MouseJump')
  }
  Configured = [pscustomobject]@{
    fmm=($f -ne $null); hi=($h -ne $null); cross=($c -ne $null); jump=($j -ne $null)
  }
  Fmm = [pscustomobject]@{
    activationMethod = [int](Prop $f 'properties.activation_method.value' 0)
    spotlightRadius  = [int](Prop $f 'properties.spotlight_radius.value' 100)
    overlayOpacity   = [int](Prop $f 'properties.overlay_opacity.value' 50)
    fadeMs           = [int](Prop $f 'properties.animation_duration_ms.value' 400)
    spotlightColor   = (Hex (Prop $f 'properties.spotlight_color.value' '#FFFFFF') '#FFFFFF')
    backgroundColor  = (Hex (Prop $f 'properties.background_color.value' '#000000') '#000000')
  }
  Hi = [pscustomobject]@{
    highlightRadius  = [int](Prop $h 'properties.highlight_radius.value' 20)
    highlightOpacity = [int](Prop $h 'properties.highlight_opacity.value' 50)
    fadeMs           = [int](Prop $h 'properties.fade_duration_ms.value' 500)
    leftColor        = (Hex (Prop $h 'properties.left_button_click_color.value' '#FFFF00') '#FFFF00')
    rightColor       = (Hex (Prop $h 'properties.right_button_click_color.value' '#0000FF') '#0000FF')
  }
  Cross = [pscustomobject]@{
    thickness = [int](Prop $c 'properties.crosshairs_thickness.value' 5)
    gap       = [int](Prop $c 'properties.crosshairs_radius.value' 20)
    opacity   = [int](Prop $c 'properties.crosshairs_opacity.value' 75)
    color     = (Hex (Prop $c 'properties.crosshairs_color.value' '#FF0000') '#FF0000')
  }
  Jump = [pscustomobject]@{
    thumbWidth  = [int](Prop $j 'properties.thumbnail_size.value.width' 1920)
    thumbHeight = [int](Prop $j 'properties.thumbnail_size.value.height' 1080)
  }
  Displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [pscustomobject]@{
      Name = $_.DeviceName; Primary = [bool]$_.Primary
      Width = [int]$_.Bounds.Width; Height = [int]$_.Bounds.Height
      X = [int]$_.Bounds.X; Y = [int]$_.Bounds.Y
    }
  })
  VW = [int][System.Windows.Forms.SystemInformation]::VirtualScreen.Width
  VH = [int][System.Windows.Forms.SystemInformation]::VirtualScreen.Height
}
`;

const DEFAULT_DRAFT: Draft = {
  enabled: { fmm: false, hi: false, cross: false, jump: false },
  fmm: {
    activationMethod: 0,
    spotlightRadius: 100,
    overlayOpacity: 50,
    fadeMs: 400,
    spotlightColor: '#FFFFFF',
    backgroundColor: '#000000',
  },
  hi: { highlightRadius: 20, highlightOpacity: 50, fadeMs: 500, leftColor: '#FFFF00', rightColor: '#0000FF' },
  cross: { thickness: 5, gap: 20, opacity: 75, color: '#FF0000' },
  jump: { thumbWidth: 1920, thumbHeight: 1080 },
};

const EMPTY_PROBE: Probe = {
  Installed: false,
  Running: false,
  Version: '',
  Elevated: false,
  Startup: false,
  Enabled: { ...DEFAULT_DRAFT.enabled },
  Configured: { fmm: false, hi: false, cross: false, jump: false },
  Fmm: { ...DEFAULT_DRAFT.fmm },
  Hi: { ...DEFAULT_DRAFT.hi },
  Cross: { ...DEFAULT_DRAFT.cross },
  Jump: { ...DEFAULT_DRAFT.jump },
  Displays: [],
  VW: 0,
  VH: 0,
};

function draftFromProbe(p: Probe): Draft {
  return {
    enabled: { ...p.Enabled },
    fmm: { ...p.Fmm },
    hi: { ...p.Hi },
    cross: { ...p.Cross },
    jump: { ...p.Jump },
  };
}

// ---- write helpers ---------------------------------------------------------

const psStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const int = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));
const hex6 = (s: string) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  return m ? `#${m[1]!.toUpperCase()}` : '#000000';
};

// Emit PowerShell that (1) flips the root enabled flag and (2) writes the
// per-module settings.json with the full PowerToys property schema. Values are
// sanitized (ints clamped, hex validated) so nothing user-controlled is
// interpolated raw. Returns 'ok' on success.
function buildWritePS(key: UtilKey, d: Draft): string {
  const enabled = d.enabled[key];
  const folder = PT_FOLDER[key];
  const enabledKey = PT_ENABLED_KEY[key];

  let propsPS = '';
  if (key === 'fmm') {
    const f = d.fmm;
    propsPS = `$props = [ordered]@{
  activation_method     = @{ value = ${int(f.activationMethod, 0, 2)} }
  spotlight_radius      = @{ value = ${int(f.spotlightRadius, 20, 400)} }
  overlay_opacity       = @{ value = ${int(f.overlayOpacity, 0, 100)} }
  animation_duration_ms = @{ value = ${int(f.fadeMs, 50, 1500)} }
  spotlight_color       = @{ value = ${psStr(hex6(f.spotlightColor))} }
  background_color      = @{ value = ${psStr(hex6(f.backgroundColor))} }
}`;
  } else if (key === 'hi') {
    const h = d.hi;
    propsPS = `$props = [ordered]@{
  highlight_radius        = @{ value = ${int(h.highlightRadius, 5, 120)} }
  highlight_opacity       = @{ value = ${int(h.highlightOpacity, 0, 100)} }
  fade_duration_ms        = @{ value = ${int(h.fadeMs, 100, 2000)} }
  left_button_click_color = @{ value = ${psStr(hex6(h.leftColor))} }
  right_button_click_color= @{ value = ${psStr(hex6(h.rightColor))} }
}`;
  } else if (key === 'cross') {
    const c = d.cross;
    propsPS = `$props = [ordered]@{
  crosshairs_thickness = @{ value = ${int(c.thickness, 1, 30)} }
  crosshairs_radius    = @{ value = ${int(c.gap, 0, 100)} }
  crosshairs_opacity   = @{ value = ${int(c.opacity, 0, 100)} }
  crosshairs_color     = @{ value = ${psStr(hex6(c.color))} }
}`;
  } else {
    const j = d.jump;
    propsPS = `$props = [ordered]@{
  thumbnail_size = @{ value = @{ width = ${int(j.thumbWidth, 100, 7680)}; height = ${int(j.thumbHeight, 100, 4320)} } }
}`;
  }

  return String.raw`
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'Microsoft\PowerToys'
$rootPath = Join-Path $base 'settings.json'
if (-not (Test-Path $rootPath)) { throw 'PowerToys is not installed.' }

# 1) flip the root enabled flag (create the node if missing)
$root = Get-Content $rootPath -Raw | ConvertFrom-Json
if ($null -eq $root.PSObject.Properties['enabled']) {
  $root | Add-Member -NotePropertyName enabled -NotePropertyValue ([pscustomobject]@{}) -Force
}
if ($null -eq $root.enabled.PSObject.Properties['${enabledKey}']) {
  $root.enabled | Add-Member -NotePropertyName '${enabledKey}' -NotePropertyValue $${enabled} -Force
} else {
  $root.enabled.'${enabledKey}' = $${enabled}
}
$root | ConvertTo-Json -Depth 20 | Set-Content -Path $rootPath -Encoding UTF8

# 2) write the per-module settings.json, preserving any existing fields
$dir = Join-Path $base '${folder}'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$modPath = Join-Path $dir 'settings.json'
if (Test-Path $modPath) {
  try { $mod = Get-Content $modPath -Raw | ConvertFrom-Json } catch { $mod = $null }
}
if ($null -eq $mod) {
  $mod = [pscustomobject]@{ name='${folder}'; version='1.0'; properties=[pscustomobject]@{} }
}
if ($null -eq $mod.PSObject.Properties['properties']) {
  $mod | Add-Member -NotePropertyName properties -NotePropertyValue ([pscustomobject]@{}) -Force
}
${propsPS}
foreach ($k in $props.Keys) {
  if ($null -eq $mod.properties.PSObject.Properties[$k]) {
    $mod.properties | Add-Member -NotePropertyName $k -NotePropertyValue $props[$k] -Force
  } else {
    $mod.properties.$k = $props[$k]
  }
}
$mod | ConvertTo-Json -Depth 20 | Set-Content -Path $modPath -Encoding UTF8
'ok'
`;
}

// Restart PowerToys so the freshly written files take effect.
const RESTART_PS = String.raw`
$ErrorActionPreference = 'Stop'
Get-Process -Name 'PowerToys' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
$exe = $null
foreach ($p in @(
  (Join-Path $env:ProgramFiles 'PowerToys\PowerToys.exe'),
  (Join-Path ${'$'}{env:ProgramFiles(x86)} 'PowerToys\PowerToys.exe'),
  (Join-Path $env:LOCALAPPDATA 'PowerToys\PowerToys.exe')
)) { if ($p -and (Test-Path $p)) { $exe = $p; break } }
if (-not $exe) { throw 'PowerToys.exe not found — start PowerToys manually.' }
Start-Process -FilePath $exe | Out-Null
'ok'
`;

// ---- small controls --------------------------------------------------------

function Heading({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mu-heading">
      <span className="mu-heading-title">{title}</span>
      {desc && <span className="mu-heading-desc">{desc}</span>}
    </div>
  );
}

function SliderRow({
  title,
  desc,
  min,
  max,
  value,
  unit,
  onChange,
}: {
  title: string;
  desc: string;
  min: number;
  max: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mu-ctrl">
      <Heading title={title} desc={desc} />
      <div className="mu-slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="mu-slider-val">
          {value}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
    </div>
  );
}

function ColorRow({
  title,
  desc,
  value,
  onChange,
}: {
  title: string;
  desc: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const presets = ['#FFFFFF', '#000000', '#FF0000', '#00FF00', '#0080FF', '#FFFF00', '#FF00FF', '#FF8000'];
  const safe = hex6(value);
  return (
    <div className="mu-ctrl">
      <div className="mu-color-top">
        <Heading title={title} desc={desc} />
        <div className="mu-color-pick">
          <input
            type="color"
            value={safe}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            aria-label={title}
          />
          <input
            className="hosts-edit mu-hex"
            value={value}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => onChange(hex6(e.target.value))}
          />
        </div>
      </div>
      <div className="mu-presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className="mu-preset"
            style={{ background: p }}
            title={p}
            onClick={() => onChange(p)}
          />
        ))}
      </div>
    </div>
  );
}

function EnableToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <label className="mu-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="mu-toggle-track" aria-hidden>
        <span className="mu-toggle-thumb" />
      </span>
      <span className="mu-toggle-label">{on ? t('mouseutils.on') : t('mouseutils.off')}</span>
    </label>
  );
}

function HotkeyPill({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="mu-hotkey-pill">
      <span className="mu-hotkey-label">{label}</span>
      <code>{keys}</code>
    </div>
  );
}

// ---- utility section -------------------------------------------------------

function UtilitySection({
  ukey,
  probe,
  draft,
  setDraft,
  onSave,
  busy,
  savedKey,
  disabled,
}: {
  ukey: UtilKey;
  probe: Probe;
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  onSave: (k: UtilKey) => void;
  busy: UtilKey | null;
  savedKey: UtilKey | null;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const on = draft.enabled[ukey];
  const configured = probe.Configured[ukey];
  const busyThis = busy === ukey;

  const setEnabled = (v: boolean) =>
    setDraft((d) => ({ ...d, enabled: { ...d.enabled, [ukey]: v } }));

  const body = () => {
    if (ukey === 'fmm') {
      const f = draft.fmm;
      const set = (patch: Partial<FmmDraft>) => setDraft((d) => ({ ...d, fmm: { ...d.fmm, ...patch } }));
      const acts = [
        t('mouseutils.actDoubleCtrl'),
        t('mouseutils.actShake'),
        t('mouseutils.actShortcut'),
      ];
      return (
        <>
          <div className="mu-ctrl">
            <Heading title={t('mouseutils.activationMethod')} desc={t('mouseutils.activationMethodDesc')} />
            <select
              className="hosts-edit mu-select"
              value={f.activationMethod}
              onChange={(e) => set({ activationMethod: Number(e.target.value) })}
            >
              {acts.map((a, i) => (
                <option key={i} value={i}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <SliderRow title={t('mouseutils.spotlightRadius')} desc={t('mouseutils.spotlightRadiusDesc')} min={20} max={400} value={f.spotlightRadius} unit="px" onChange={(v) => set({ spotlightRadius: v })} />
          <SliderRow title={t('mouseutils.backdropDim')} desc={t('mouseutils.backdropDimDesc')} min={0} max={100} value={f.overlayOpacity} unit="%" onChange={(v) => set({ overlayOpacity: v })} />
          <SliderRow title={t('mouseutils.fadeDuration')} desc={t('mouseutils.fadeDurationInDesc')} min={50} max={1500} value={f.fadeMs} unit="ms" onChange={(v) => set({ fadeMs: v })} />
          <ColorRow title={t('mouseutils.spotlightColour')} desc={t('mouseutils.spotlightColourDesc')} value={f.spotlightColor} onChange={(v) => set({ spotlightColor: v })} />
          <ColorRow title={t('mouseutils.backdropColour')} desc={t('mouseutils.backdropColourDesc')} value={f.backgroundColor} onChange={(v) => set({ backgroundColor: v })} />
        </>
      );
    }
    if (ukey === 'hi') {
      const h = draft.hi;
      const set = (patch: Partial<HiDraft>) => setDraft((d) => ({ ...d, hi: { ...d.hi, ...patch } }));
      return (
        <>
          <HotkeyPill label={t('mouseutils.toggleHotkey')} keys={HOTKEY.hi} />
          <SliderRow title={t('mouseutils.circleRadius')} desc={t('mouseutils.circleRadiusDesc')} min={5} max={120} value={h.highlightRadius} unit="px" onChange={(v) => set({ highlightRadius: v })} />
          <SliderRow title={t('mouseutils.opacity')} desc={t('mouseutils.opacityDesc')} min={0} max={100} value={h.highlightOpacity} unit="%" onChange={(v) => set({ highlightOpacity: v })} />
          <SliderRow title={t('mouseutils.fadeDuration')} desc={t('mouseutils.fadeDurationDesc')} min={100} max={2000} value={h.fadeMs} unit="ms" onChange={(v) => set({ fadeMs: v })} />
          <ColorRow title={t('mouseutils.leftColour')} desc={t('mouseutils.leftColourDesc')} value={h.leftColor} onChange={(v) => set({ leftColor: v })} />
          <ColorRow title={t('mouseutils.rightColour')} desc={t('mouseutils.rightColourDesc')} value={h.rightColor} onChange={(v) => set({ rightColor: v })} />
        </>
      );
    }
    if (ukey === 'cross') {
      const c = draft.cross;
      const set = (patch: Partial<CrossDraft>) => setDraft((d) => ({ ...d, cross: { ...d.cross, ...patch } }));
      return (
        <>
          <HotkeyPill label={t('mouseutils.toggleHotkey')} keys={HOTKEY.cross} />
          <SliderRow title={t('mouseutils.lineThickness')} desc={t('mouseutils.lineThicknessDesc')} min={1} max={30} value={c.thickness} unit="px" onChange={(v) => set({ thickness: v })} />
          <SliderRow title={t('mouseutils.centreGap')} desc={t('mouseutils.centreGapDesc')} min={0} max={100} value={c.gap} unit="px" onChange={(v) => set({ gap: v })} />
          <SliderRow title={t('mouseutils.opacity')} desc={t('mouseutils.opacityDesc')} min={0} max={100} value={c.opacity} unit="%" onChange={(v) => set({ opacity: v })} />
          <ColorRow title={t('mouseutils.lineColour')} desc={t('mouseutils.lineColourDesc')} value={c.color} onChange={(v) => set({ color: v })} />
        </>
      );
    }
    // jump
    const j = draft.jump;
    const set = (patch: Partial<JumpDraft>) => setDraft((d) => ({ ...d, jump: { ...d.jump, ...patch } }));
    return (
      <>
        <HotkeyPill label={t('mouseutils.toggleHotkey')} keys={HOTKEY.jump} />
        <p className="count-note" style={{ margin: '2px 0 6px' }}>
          {t('mouseutils.jumpNote')}
        </p>
        <div className="mu-ctrl">
          <Heading title={t('mouseutils.thumbnailSize')} desc={t('mouseutils.thumbnailSizeDesc')} />
          <div className="mu-dims">
            <input
              className="hosts-edit mu-dim"
              type="number"
              min={100}
              max={7680}
              value={j.thumbWidth}
              onChange={(e) => set({ thumbWidth: Number(e.target.value) })}
            />
            <span className="mu-dim-x">×</span>
            <input
              className="hosts-edit mu-dim"
              type="number"
              min={100}
              max={4320}
              value={j.thumbHeight}
              onChange={(e) => set({ thumbHeight: Number(e.target.value) })}
            />
            <span className="count-note">px</span>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="mu-section">
      <div className="mu-section-head">
        <div className="mu-section-titles">
          <span className="mu-section-name">{t(`mouseutils.${ukey}.name`)}</span>
          <p className="count-note" style={{ margin: '2px 0 0' }}>
            {t(`mouseutils.${ukey}.desc`)}
          </p>
        </div>
        <StatusDot
          ok={probe.Enabled[ukey]}
          label={probe.Enabled[ukey] ? t('mouseutils.liveOn') : t('mouseutils.liveOff')}
        />
      </div>

      <div className="mu-enable-row">
        <Heading title={t('mouseutils.enable')} desc={t('mouseutils.enableDesc')} />
        <EnableToggle on={on} onChange={setEnabled} />
      </div>

      {on && <div className="mu-settings">{body()}</div>}

      <div className="mu-section-foot">
        <button
          className="mini primary"
          disabled={disabled || busyThis}
          onClick={() => onSave(ukey)}
        >
          {busyThis ? t('mouseutils.saving') : t('mouseutils.save')}
        </button>
        {savedKey === ukey && <span className="count-note mu-saved">{t('mouseutils.savedTick')}</span>}
        <span className="count-note mu-config-note">
          {configured ? t('mouseutils.fromDisk') : t('mouseutils.defaults')}
        </span>
      </div>
    </div>
  );
}

// ---- module ----------------------------------------------------------------

export function MouseUtilsModule() {
  const { t } = useTranslation();

  const { data, loading, error, reload } = useAsync(() => runPowershellJson<Probe>(READ_PS), []);
  const probe = useMemo<Probe>(() => data?.[0] ?? EMPTY_PROBE, [data]);

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [busy, setBusy] = useState<UtilKey | null>(null);
  const [applying, setApplying] = useState(false);
  const [savedKey, setSavedKey] = useState<UtilKey | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed / re-seed the editable draft whenever a fresh probe lands.
  useEffect(() => {
    if (data?.[0]) setDraft(draftFromProbe(data[0]));
  }, [data]);

  const saveUtility = async (k: UtilKey) => {
    setBusy(k);
    setSavedKey(null);
    setMsg(null);
    try {
      const res = await runPowershell(
        `$ErrorActionPreference='Stop'; $out = @(${buildWritePS(k, draft)}); $out`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setSavedKey(k);
      setMsg(t('mouseutils.savedMsg', { name: t(`mouseutils.${k}.name`) }));
    } catch (e) {
      setMsg(`${t('mouseutils.saveFailed', { name: t(`mouseutils.${k}.name`) })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const applyRestart = async () => {
    setApplying(true);
    setMsg(null);
    try {
      const res = await runPowershell(RESTART_PS);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('mouseutils.applied'));
      reload();
    } catch (e) {
      setMsg(`${t('mouseutils.applyFailed')}: ${String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  const revertDraft = () => {
    if (data?.[0]) setDraft(draftFromProbe(data[0]));
    setSavedKey(null);
    setMsg(null);
  };

  const displayCols: Column<Display>[] = [
    {
      key: 'Name',
      header: t('mouseutils.display.name'),
      render: (d) => (
        <span>
          {d.Name}
          {d.Primary && <span className="mu-badge">{t('mouseutils.display.primary')}</span>}
        </span>
      ),
    },
    { key: 'res', header: t('mouseutils.display.resolution'), width: 140, render: (d) => `${d.Width} × ${d.Height}` },
    { key: 'pos', header: t('mouseutils.display.position'), width: 120, render: (d) => `(${d.X}, ${d.Y})` },
  ];

  const notInstalled = !probe.Installed;
  const order: UtilKey[] = ['fmm', 'hi', 'cross', 'jump'];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" onClick={revertDraft} disabled={loading}>
          {t('mouseutils.revert')}
        </button>
        <button className="mini primary" onClick={applyRestart} disabled={applying || notInstalled}>
          {applying ? t('mouseutils.applying') : t('mouseutils.applyRestart')}
        </button>
        <span className="count-note">
          {probe.Installed
            ? t('mouseutils.ptInstalled', { version: probe.Version || '?' })
            : t('mouseutils.ptMissing')}
        </span>
        <StatusDot ok={probe.Running} label={probe.Running ? t('mouseutils.running') : t('mouseutils.stopped')} />
      </ModuleToolbar>

      {msg && <p className="mod-msg">{msg}</p>}

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mouseutils.blurb')}
      </p>

      <AsyncState loading={loading} error={error}>
        {notInstalled && <p className="count-note mu-install">{t('mouseutils.installHint')}</p>}

        <div className="mu-grid">
          {order.map((k) => (
            <UtilitySection
              key={k}
              ukey={k}
              probe={probe}
              draft={draft}
              setDraft={setDraft}
              onSave={saveUtility}
              busy={busy}
              savedKey={savedKey}
              disabled={notInstalled}
            />
          ))}
        </div>

        <h3 className="mu-section-title">{t('mouseutils.displaysTitle')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mouseutils.virtualScreen', { w: probe.VW, h: probe.VH, screens: probe.Displays.length })}
        </p>
        <DataTable
          columns={displayCols}
          rows={probe.Displays}
          rowKey={(d) => d.Name}
          empty={t('mouseutils.noDisplays')}
        />
      </AsyncState>

      <style>{`
        .mu-install { color: var(--danger, #e06c6c); }
        .mu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; margin: 10px 0 6px; }
        .mu-section { border: 1px solid var(--stroke, #2a2a33); border-radius: 12px; padding: 16px; background: var(--bg-card, rgba(255,255,255,0.02)); display: flex; flex-direction: column; gap: 12px; }
        .mu-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .mu-section-name { font-weight: 600; font-size: 15px; }
        .mu-enable-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--stroke, #2a2a33); border-radius: 8px; background: rgba(127,127,127,0.06); }
        .mu-heading { display: flex; flex-direction: column; gap: 1px; }
        .mu-heading-title { font-weight: 600; font-size: 13px; }
        .mu-heading-desc { font-size: 11.5px; opacity: 0.7; }
        .mu-settings { display: flex; flex-direction: column; gap: 12px; }
        .mu-ctrl { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--stroke, #2a2a33); border-radius: 8px; background: rgba(127,127,127,0.04); }
        .mu-slider-row { display: flex; align-items: center; gap: 12px; }
        .mu-slider-row input[type=range] { flex: 1; accent-color: var(--accent, #5aa0ff); }
        .mu-slider-val { width: 68px; text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; }
        .mu-select { width: 100%; }
        .mu-color-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .mu-color-pick { display: flex; align-items: center; gap: 6px; }
        .mu-color-pick input[type=color] { width: 40px; height: 28px; padding: 0; border: 1px solid var(--stroke, #444); border-radius: 6px; background: none; cursor: pointer; }
        .mu-hex { width: 92px; font-variant-numeric: tabular-nums; text-transform: uppercase; }
        .mu-presets { display: flex; gap: 6px; flex-wrap: wrap; }
        .mu-preset { width: 24px; height: 24px; border-radius: 5px; border: 1px solid rgba(127,127,127,0.5); cursor: pointer; padding: 0; }
        .mu-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
        .mu-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
        .mu-toggle-track { width: 40px; height: 22px; border-radius: 11px; background: rgba(127,127,127,0.35); position: relative; transition: background 0.15s; flex: none; }
        .mu-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
        .mu-toggle input:checked + .mu-toggle-track { background: var(--accent-strong, #2f6bd8); }
        .mu-toggle input:checked + .mu-toggle-track .mu-toggle-thumb { transform: translateX(18px); }
        .mu-toggle input:focus-visible + .mu-toggle-track { outline: 2px solid var(--accent, #5aa0ff); outline-offset: 2px; }
        .mu-toggle-label { font-size: 12.5px; opacity: 0.85; min-width: 24px; }
        .mu-hotkey-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: rgba(127,127,127,0.1); align-self: flex-start; }
        .mu-hotkey-label { font-size: 12px; opacity: 0.8; }
        .mu-hotkey-pill code { padding: 1px 6px; border-radius: 4px; background: rgba(127,127,127,0.2); font-size: 11.5px; font-weight: 600; }
        .mu-dims { display: flex; align-items: center; gap: 8px; }
        .mu-dim { width: 88px; }
        .mu-dim-x { opacity: 0.7; }
        .mu-section-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
        .mu-saved { color: var(--accent, #5aa0ff); }
        .mu-config-note { margin-left: auto; font-size: 11px; opacity: 0.7; }
        .mu-badge { margin-left: 8px; padding: 0 6px; border-radius: 8px; font-size: 10px; background: rgba(80,160,255,0.22); vertical-align: middle; }
        .mu-section-title { margin: 18px 0 4px; font-size: 14px; }
      `}</style>
    </div>
  );
}
