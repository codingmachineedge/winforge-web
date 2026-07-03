import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ---------------------------------------------------------------------------
// Native clone of PowerToys "Mouse Utilities" (滑鼠工具) as a LIVE read-only view.
// The C# original owns Win32 global hooks + per-pixel-alpha overlays; those cannot
// run under the Tauri PowerShell sandbox. Instead this module surfaces the REAL,
// on-disk state of the same four utilities: it reads PowerToys' own settings.json
// files (root enabled-map + per-module config), reports install / run status, and
// lists the live display geometry that Mouse Jump spans across.
// ---------------------------------------------------------------------------

interface Utility {
  key: 'fmm' | 'hi' | 'cross' | 'jump';
  Enabled: boolean;
  Hotkey: string;
  Configured: boolean; // true when a per-module settings.json was found on disk
  // free-form key/value config rows (already stringified in PowerShell)
  Rows: { Label: string; Value: string; Color?: string }[];
}

interface Display {
  Name: string;
  Primary: boolean;
  Width: number;
  Height: number;
  X: number;
  Y: number;
}

interface Probe {
  Installed: boolean;
  Running: boolean;
  Version: string;
  Elevated: boolean;
  Startup: boolean;
  Fmm: Utility;
  Highlighter: Utility;
  Crosshairs: Utility;
  Jump: Utility;
  Displays: Display[];
  VW: number;
  VH: number;
}

// PowerShell that reads PowerToys' real settings.json tree and live screen geometry,
// emitting a single JSON object. Everything is guarded so absent files fall back to
// PowerToys' documented defaults (utility enabled but never opened in Settings).
const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
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
function Hex($v) {
  if ($null -eq $v) { return '' }
  $s = "$v".TrimStart('#')
  if ($s.Length -ge 6) { return '#' + $s.Substring(0,6).ToUpper() }
  return "$v"
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

# --- Find My Mouse ---
$f = Load 'FindMyMouse'
$fCfg = ($f -ne $null)
$fAct = [int](Prop $f 'properties.activation_method.value' 0)
$fActTxt = switch ($fAct) { 0 {'DoubleControl'} 1 {'Shake'} 2 {'CustomShortcut'} default {'DoubleControl'} }
$fmm = [pscustomobject]@{
  key='fmm'; Enabled=(IsOn 'FindMyMouse'); Hotkey='Double-tap Left Ctrl'; Configured=$fCfg
  Rows=@(
    [pscustomobject]@{Label='Activation'; Value=$fActTxt; Color=$null}
    [pscustomobject]@{Label='SpotlightRadius'; Value=('{0} px' -f [int](Prop $f 'properties.spotlight_radius.value' 100)); Color=$null}
    [pscustomobject]@{Label='BackdropOpacity'; Value=('{0}%' -f [int](Prop $f 'properties.overlay_opacity.value' 50)); Color=$null}
    [pscustomobject]@{Label='FadeDuration'; Value=('{0} ms' -f [int](Prop $f 'properties.animation_duration_ms.value' 400)); Color=$null}
    [pscustomobject]@{Label='SpotlightColor'; Value=(Hex (Prop $f 'properties.spotlight_color.value' '#FFFFFF')); Color=(Hex (Prop $f 'properties.spotlight_color.value' '#FFFFFF'))}
    [pscustomobject]@{Label='BackdropColor'; Value=(Hex (Prop $f 'properties.background_color.value' '#000000')); Color=(Hex (Prop $f 'properties.background_color.value' '#000000'))}
  )
}

# --- Mouse Highlighter ---
$h = Load 'MouseHighlighter'
$hi = [pscustomobject]@{
  key='hi'; Enabled=(IsOn 'MouseHighlighter'); Hotkey='Win + Shift + H'; Configured=($h -ne $null)
  Rows=@(
    [pscustomobject]@{Label='CircleRadius'; Value=('{0} px' -f [int](Prop $h 'properties.highlight_radius.value' 20)); Color=$null}
    [pscustomobject]@{Label='Opacity'; Value=('{0}%' -f [int](Prop $h 'properties.highlight_opacity.value' 50)); Color=$null}
    [pscustomobject]@{Label='FadeDuration'; Value=('{0} ms' -f [int](Prop $h 'properties.fade_duration_ms.value' 500)); Color=$null}
    [pscustomobject]@{Label='LeftColor'; Value=(Hex (Prop $h 'properties.left_button_click_color.value' '#FFFF00')); Color=(Hex (Prop $h 'properties.left_button_click_color.value' '#FFFF00'))}
    [pscustomobject]@{Label='RightColor'; Value=(Hex (Prop $h 'properties.right_button_click_color.value' '#0000FF')); Color=(Hex (Prop $h 'properties.right_button_click_color.value' '#0000FF'))}
  )
}

# --- Mouse Crosshairs ---
$c = Load 'MousePointerCrosshairs'
$cross = [pscustomobject]@{
  key='cross'; Enabled=(IsOn 'MousePointerCrosshairs'); Hotkey='Win + Shift + X'; Configured=($c -ne $null)
  Rows=@(
    [pscustomobject]@{Label='LineThickness'; Value=('{0} px' -f [int](Prop $c 'properties.crosshairs_thickness.value' 5)); Color=$null}
    [pscustomobject]@{Label='CentreGap'; Value=('{0} px' -f [int](Prop $c 'properties.crosshairs_radius.value' 20)); Color=$null}
    [pscustomobject]@{Label='Opacity'; Value=('{0}%' -f [int](Prop $c 'properties.crosshairs_opacity.value' 75)); Color=$null}
    [pscustomobject]@{Label='LineColor'; Value=(Hex (Prop $c 'properties.crosshairs_color.value' '#FF0000')); Color=(Hex (Prop $c 'properties.crosshairs_color.value' '#FF0000'))}
  )
}

# --- Mouse Jump ---
$j = Load 'MouseJump'
$jump = [pscustomobject]@{
  key='jump'; Enabled=(IsOn 'MouseJump'); Hotkey='Win + Shift + D'; Configured=($j -ne $null)
  Rows=@(
    [pscustomobject]@{Label='ThumbnailSize'; Value=('{0} x {1}' -f [int](Prop $j 'properties.thumbnail_size.value.width' 1920), [int](Prop $j 'properties.thumbnail_size.value.height' 1080)); Color=$null}
  )
}

# --- Displays (what Mouse Jump spans) ---
$displays = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $displays += [pscustomobject]@{
    Name = $s.DeviceName; Primary = [bool]$s.Primary
    Width = [int]$s.Bounds.Width; Height = [int]$s.Bounds.Height
    X = [int]$s.Bounds.X; Y = [int]$s.Bounds.Y
  }
}
$vw = [int][System.Windows.Forms.SystemInformation]::VirtualScreen.Width
$vh = [int][System.Windows.Forms.SystemInformation]::VirtualScreen.Height

[pscustomobject]@{
  Installed = $installed
  Running = $running
  Version = if ($root) { "$($root.powertoys_version)" } else { '' }
  Elevated = if ($root) { [bool](Prop $root 'is_elevated' $false) } else { $false }
  Startup = if ($root) { [bool](Prop $root 'startup' $false) } else { $false }
  Fmm = $fmm; Highlighter = $hi; Crosshairs = $cross; Jump = $jump
  Displays = $displays; VW = $vw; VH = $vh
}
`;

const EMPTY_PROBE: Probe = {
  Installed: false,
  Running: false,
  Version: '',
  Elevated: false,
  Startup: false,
  Fmm: { key: 'fmm', Enabled: false, Hotkey: 'Double-tap Left Ctrl', Configured: false, Rows: [] },
  Highlighter: { key: 'hi', Enabled: false, Hotkey: 'Win + Shift + H', Configured: false, Rows: [] },
  Crosshairs: { key: 'cross', Enabled: false, Hotkey: 'Win + Shift + X', Configured: false, Rows: [] },
  Jump: { key: 'jump', Enabled: false, Hotkey: 'Win + Shift + D', Configured: false, Rows: [] },
  Displays: [],
  VW: 0,
  VH: 0,
};

function UtilityCard({ u }: { u: Utility }) {
  const { t } = useTranslation();
  return (
    <div className="mu-card">
      <div className="mu-card-head">
        <div className="mu-card-title">
          <span className="mu-card-name">{t(`mouseutils.${u.key}.name`)}</span>
          <StatusDot ok={u.Enabled} label={u.Enabled ? t('mouseutils.on') : t('mouseutils.off')} />
        </div>
        <span className="mu-hotkey">
          {t('mouseutils.toggleHotkey')}: <code>{u.Hotkey}</code>
        </span>
      </div>
      <p className="count-note" style={{ margin: '2px 0 8px' }}>
        {t(`mouseutils.${u.key}.desc`)}
      </p>
      <div className="mu-rows">
        {u.Rows.map((r) => (
          <div className="mu-row" key={r.Label}>
            <span className="mu-row-label">{t(`mouseutils.field.${r.Label}`)}</span>
            <span className="mu-row-value">
              {r.Color && (
                <span
                  className="mu-swatch"
                  style={{ background: r.Color }}
                  title={r.Color}
                  aria-hidden
                />
              )}
              {r.Value || '—'}
            </span>
          </div>
        ))}
      </div>
      <p className="count-note" style={{ margin: '6px 0 0', fontSize: 11 }}>
        {u.Configured ? t('mouseutils.fromDisk') : t('mouseutils.defaults')}
      </p>
    </div>
  );
}

export function MouseUtilsModule() {
  const { t } = useTranslation();

  const { data, loading, error, reload } = useAsync(
    () => runPowershellJson<Probe>(PS),
    [],
  );

  const probe = useMemo<Probe>(() => data?.[0] ?? EMPTY_PROBE, [data]);
  const utils = [probe.Fmm, probe.Highlighter, probe.Crosshairs, probe.Jump];

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
    {
      key: 'res',
      header: t('mouseutils.display.resolution'),
      width: 140,
      render: (d) => `${d.Width} × ${d.Height}`,
    },
    {
      key: 'pos',
      header: t('mouseutils.display.position'),
      width: 120,
      render: (d) => `(${d.X}, ${d.Y})`,
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {probe.Installed
            ? t('mouseutils.ptInstalled', { version: probe.Version || '?' })
            : t('mouseutils.ptMissing')}
        </span>
        <StatusDot
          ok={probe.Running}
          label={probe.Running ? t('mouseutils.running') : t('mouseutils.stopped')}
        />
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mouseutils.blurb')}
      </p>

      <AsyncState loading={loading} error={error}>
        {!probe.Installed && (
          <p className="count-note">{t('mouseutils.installHint')}</p>
        )}
        <div className="mu-grid">
          {utils.map((u) => (
            <UtilityCard key={u.key} u={u} />
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
        .mu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin: 8px 0 4px; }
        .mu-card { border: 1px solid var(--mod-border, #2a2a33); border-radius: 10px; padding: 14px 16px; background: var(--mod-card, rgba(255,255,255,0.02)); }
        .mu-card-head { display: flex; flex-direction: column; gap: 4px; }
        .mu-card-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .mu-card-name { font-weight: 600; font-size: 14px; }
        .mu-hotkey { font-size: 12px; opacity: 0.75; }
        .mu-hotkey code { padding: 1px 5px; border-radius: 4px; background: rgba(127,127,127,0.18); font-size: 11px; }
        .mu-rows { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
        .mu-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 2px 0; border-bottom: 1px dashed rgba(127,127,127,0.14); }
        .mu-row:last-child { border-bottom: none; }
        .mu-row-label { opacity: 0.8; }
        .mu-row-value { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
        .mu-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(127,127,127,0.5); display: inline-block; }
        .mu-badge { margin-left: 8px; padding: 0 6px; border-radius: 8px; font-size: 10px; background: rgba(80,160,255,0.22); vertical-align: middle; }
        .mu-section-title { margin: 18px 0 4px; font-size: 14px; }
      `}</style>
    </div>
  );
}
