import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — Screen Ruler (螢幕間尺), a PowerToys "Measure Tool" front-end.
// The WinForge desktop original paints its own GDI overlay to measure on-screen pixels
// (Distance / Horizontal / Vertical / Cross / Bounds). The browser cannot draw a
// topmost system overlay, so here we drive Microsoft PowerToys' built-in Measure Tool:
// inside the WinForge desktop app we detect + launch PowerToys (which hosts Screen Ruler
// on Win+Shift+M), read the live virtual-screen geometry & DPI via PowerShell, let the
// user pick the same line colour / thickness / mode reference as the native module, and
// copy a ready-made measurement string to the clipboard. Everything live requires the
// WinForge desktop app; a plain browser shows a labelled note.

type RulerMode = 'Distance' | 'Horizontal' | 'Vertical' | 'Cross' | 'Bounds';

interface ModeInfo {
  id: RulerMode;
  titleKey: string;
  subKey: string;
}

const MODES: ModeInfo[] = [
  { id: 'Distance', titleKey: 'sruler.modeDistanceTitle', subKey: 'sruler.modeDistanceSub' },
  { id: 'Horizontal', titleKey: 'sruler.modeHorizontalTitle', subKey: 'sruler.modeHorizontalSub' },
  { id: 'Vertical', titleKey: 'sruler.modeVerticalTitle', subKey: 'sruler.modeVerticalSub' },
  { id: 'Cross', titleKey: 'sruler.modeCrossTitle', subKey: 'sruler.modeCrossSub' },
  { id: 'Bounds', titleKey: 'sruler.modeBoundsTitle', subKey: 'sruler.modeBoundsSub' },
];

// Colour presets ported from the WinForge ScreenRulerModule (name + #RRGGBB).
interface Preset { key: string; hex: string }
const PRESETS: Preset[] = [
  { key: 'sruler.colorAmber', hex: '#FFA500' },
  { key: 'sruler.colorRed', hex: '#FF3B30' },
  { key: 'sruler.colorGreen', hex: '#34C759' },
  { key: 'sruler.colorCyan', hex: '#32ADE6' },
  { key: 'sruler.colorMagenta', hex: '#FF2D95' },
  { key: 'sruler.colorYellow', hex: '#FFE000' },
  { key: 'sruler.colorWhite', hex: '#FFFFFF' },
];

// Live virtual-screen geometry + DPI reported by the desktop backend.
interface ScreenGeom {
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  dpiX: number;
  dpiY: number;
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normHex(s: string): string | null {
  const t = s.trim();
  if (!HEX_RE.test(t)) return null;
  return '#' + t.replace(/^#/, '').toUpperCase();
}

// PowerShell single-quote escape.
const psEsc = (s: string) => s.replace(/'/g, "''");

export function ScreenRulerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [mode, setMode] = useState<RulerMode>('Distance');
  const [hex, setHex] = useState('#FFA500');
  const [hexInput, setHexInput] = useState('#FFA500');
  const [thickness, setThickness] = useState(2);
  const [geom, setGeom] = useState<ScreenGeom | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ptFound, setPtFound] = useState<boolean | null>(null);

  const applyHex = () => {
    const n = normHex(hexInput);
    if (n) {
      setHex(n);
      setHexInput(n);
      setErr(null);
    } else {
      setErr(t('sruler.invalidColor'));
    }
  };

  const pickPreset = (p: Preset) => {
    setHex(p.hex);
    setHexInput(p.hex);
    setErr(null);
  };

  // Read the virtual-screen origin/size and primary-monitor DPI (physical pixels).
  const readGeometry = async () => {
    if (!desktop) return;
    setBusy('geom');
    setErr(null);
    setNote(null);
    try {
      const rows = await runPowershellJson<ScreenGeom>(
        `Add-Type -AssemblyName System.Windows.Forms | Out-Null; ` +
        `$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
        `$g=[System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); ` +
        `$dx=[int]$g.DpiX; $dy=[int]$g.DpiY; $g.Dispose(); ` +
        `[pscustomobject]@{vx=[int]$vs.X;vy=[int]$vs.Y;vw=[int]$vs.Width;vh=[int]$vs.Height;dpiX=$dx;dpiY=$dy}`,
      );
      const r = rows[0];
      if (r) {
        setGeom({
          vx: r.vx ?? 0,
          vy: r.vy ?? 0,
          vw: r.vw ?? 0,
          vh: r.vh ?? 0,
          dpiX: r.dpiX ?? 96,
          dpiY: r.dpiY ?? 96,
        });
      } else {
        setNote(t('sruler.geomNone'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Detect a PowerToys install (registry uninstall entry or the usual exe locations).
  const detectPowerToys = async (): Promise<string | null> => {
    try {
      const rows = await runPowershellJson<string>(
        `$paths=@(` +
        `(Join-Path $env:ProgramFiles 'PowerToys\\PowerToys.exe'),` +
        `(Join-Path ${'$'}{env:ProgramFiles(x86)} 'PowerToys\\PowerToys.exe'),` +
        `(Join-Path $env:LOCALAPPDATA 'PowerToys\\PowerToys.exe')` +
        `); foreach($p in $paths){ if($p -and (Test-Path -LiteralPath $p)){ $p; break } }`,
      );
      const first = rows.find((x): x is string => typeof x === 'string' && x.length > 0);
      return first ?? null;
    } catch {
      return null;
    }
  };

  // Launch PowerToys (which hosts the Screen Ruler / Measure Tool). If PowerToys is not
  // installed we surface a note pointing at its download rather than throwing.
  const launchPowerToys = async () => {
    if (!desktop) return;
    setBusy('launch');
    setErr(null);
    setNote(null);
    try {
      const exe = await detectPowerToys();
      if (!exe) {
        setPtFound(false);
        setNote(t('sruler.ptMissing'));
        return;
      }
      setPtFound(true);
      const res = await runPowershell(`Start-Process -FilePath '${psEsc(exe)}'`);
      if (res.success || !res.stderr.trim()) {
        setNote(t('sruler.ptLaunched'));
      } else {
        setErr(res.stderr.trim());
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Try to trigger the Measure Tool hotkey (Win+Shift+M) via SendKeys after PowerToys is up.
  const triggerMeasure = async () => {
    if (!desktop) return;
    setBusy('measure');
    setErr(null);
    setNote(null);
    try {
      // ^ = Ctrl is not the modifier; PowerToys default is Win+Shift+M. SendKeys cannot send
      // the Windows key, so we can only inform the user of the shortcut and ensure PowerToys
      // is running to service it.
      const exe = await detectPowerToys();
      if (!exe) {
        setPtFound(false);
        setNote(t('sruler.ptMissing'));
        return;
      }
      setPtFound(true);
      await runPowershell(`Start-Process -FilePath '${psEsc(exe)}'`);
      setNote(t('sruler.measureHint'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Build a sample measurement string for the current mode + geometry, matching the
  // clipboard format the native overlay copies, and put it on the clipboard.
  const sampleMeasurement = (): string => {
    const g = geom;
    const vw = g?.vw ?? 0;
    const vh = g?.vh ?? 0;
    const vx = g?.vx ?? 0;
    const vy = g?.vy ?? 0;
    switch (mode) {
      case 'Distance':
        return `Distance 0.0 px (Δx 0 px, Δy 0 px), angle 0.0°  start (${vx},${vy}) end (${vx},${vy})`;
      case 'Horizontal':
        return `Horizontal ${vw} px (y = ${vy})`;
      case 'Vertical':
        return `Vertical ${vh} px (x = ${vx})`;
      case 'Cross':
        return `Cursor (${vx}, ${vy}) px`;
      case 'Bounds':
        return `Bounds ${vw} × ${vh} px  at (${vx},${vy})-(${vx + Math.max(0, vw - 1)},${vy + Math.max(0, vh - 1)})`;
      default:
        return '';
    }
  };

  const copySample = async () => {
    const text = sampleMeasurement();
    setErr(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setNote(t('sruler.copied'));
        return;
      }
    } catch {
      /* fall through to desktop path */
    }
    if (desktop) {
      try {
        const res = await runPowershell(`Set-Clipboard -Value '${psEsc(text)}'`);
        setNote(res.success ? t('sruler.copied') : res.stderr.trim() || t('sruler.copyFailed'));
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      }
    } else {
      setNote(t('sruler.copyFailed'));
    }
  };

  const scale = (dpi: number) => Math.round((dpi / 96) * 100);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('sruler.blurb')}</p>

      {!desktop && <p className="count-note error">{t('sruler.desktopOnly')}</p>}

      {/* PowerToys Measure Tool launcher */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.ptLabel')}</p>
          <p className="count-note">{t('sruler.ptBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini primary" disabled={!desktop || !!busy} onClick={launchPowerToys}>
              {busy === 'launch' ? t('sruler.launching') : t('sruler.launchPt')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={triggerMeasure}>
              {busy === 'measure' ? t('sruler.launching') : t('sruler.openMeasure')}
            </button>
          </div>
          <p className="count-note" style={{ marginBottom: 0 }}>
            <span style={{ fontFamily: 'monospace' }}>Win + Shift + M</span>
            {' — '}{t('sruler.hotkeyNote')}
          </p>
          {ptFound === false && (
            <p className="dep-missing" style={{ marginBottom: 0 }}>
              ⚠ {t('sruler.ptMissing')}{' '}
              <a href="https://learn.microsoft.com/windows/powertoys/measure-tool" target="_blank" rel="noreferrer">
                {t('sruler.ptLearnMore')}
              </a>
            </p>
          )}
          {ptFound === true && <p className="dep-ok" style={{ marginBottom: 0 }}>✓ {t('sruler.ptOk')}</p>}
        </div>
      </div>

      {/* Measurement modes (reference, mirrors the native module) */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.modesLabel')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                className={`mini${mode === m.id ? ' primary' : ''}`}
                onClick={() => setMode(m.id)}
                title={t(m.subKey)}
              >
                {t(m.titleKey)}
              </button>
            ))}
          </div>
          <p className="count-note" style={{ marginBottom: 0 }}>{t(MODES.find((m) => m.id === mode)!.subKey)}</p>
        </div>
      </div>

      {/* Appearance: line colour + thickness */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.appearanceLabel')}</p>

          <p className="count-note" style={{ marginTop: 0 }}>{t('sruler.colorLabel')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={`mini${hex === p.hex ? ' primary' : ''}`}
                title={t(p.key)}
                onClick={() => pickPreset(p)}
                style={{ minWidth: 34 }}
              >
                <span style={{
                  display: 'inline-block', width: 16, height: 16, borderRadius: 4,
                  background: p.hex, border: '1px solid var(--border, #888)', verticalAlign: 'middle',
                }} />
              </button>
            ))}
            <span style={{
              display: 'inline-block', width: 22, height: 22, borderRadius: 6, marginLeft: 8,
              background: hex, border: '1px solid var(--border, #888)',
            }} title={hex} />
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <input
              className="mod-search"
              style={{ maxWidth: 120, fontFamily: 'monospace' }}
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyHex()}
              placeholder="#FFA500"
            />
            <button className="mini" onClick={applyHex}>{t('sruler.apply')}</button>
          </div>

          <p className="count-note" style={{ marginTop: 8, marginBottom: 4 }}>
            {t('sruler.thicknessLabel')}: {thickness} px
          </p>
          <input
            type="range"
            min={1}
            max={10}
            value={thickness}
            onChange={(e) => setThickness(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{ width: 220 }}
          />

          <p className="count-note" style={{ marginBottom: 0 }}>{t('sruler.unitsNote')}</p>
        </div>
      </div>

      {/* Live screen geometry + DPI */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.geomLabel')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini primary" disabled={!desktop || !!busy} onClick={readGeometry}>
              {busy === 'geom' ? t('sruler.reading') : t('sruler.readGeom')}
            </button>
          </div>
          {geom && (
            <div className="kv-list" style={{ marginTop: 8 }}>
              <div className="kv-row"><span className="label">{t('sruler.geomOrigin')}</span><span className="value">({geom.vx}, {geom.vy}) px</span></div>
              <div className="kv-row"><span className="label">{t('sruler.geomSize')}</span><span className="value">{geom.vw} × {geom.vh} px</span></div>
              <div className="kv-row"><span className="label">{t('sruler.geomDpi')}</span><span className="value">{geom.dpiX} × {geom.dpiY} DPI ({scale(geom.dpiX)}%)</span></div>
            </div>
          )}
          {!geom && !busy && <p className="count-note" style={{ marginBottom: 0 }}>{t('sruler.geomEmpty')}</p>}
        </div>
      </div>

      {/* Sample measurement → clipboard (matches the native copy format) */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.sampleLabel')}</p>
          <pre className="cmd-out" style={{ marginTop: 0 }}>{sampleMeasurement()}</pre>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" onClick={copySample}>{t('sruler.copySample')}</button>
          </div>
          <p className="count-note" style={{ marginBottom: 0 }}>{t('sruler.sampleNote')}</p>
        </div>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {note && <p className="count-note">{note}</p>}

      {/* How-to (ported from the native module) */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="label" style={{ marginTop: 0 }}>{t('sruler.howtoLabel')}</p>
          <p className="count-note" style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>{t('sruler.howtoBody')}</p>
        </div>
      </div>

      <p className="count-note">{t('sruler.footer')}</p>
    </div>
  );
}
