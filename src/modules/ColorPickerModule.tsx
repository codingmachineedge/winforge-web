import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';
import { ModuleToolbar } from './common';

// Screen colour picker (PowerToys Color Picker style). The WinForge desktop module
// uses a global low-level mouse hook to grab the pixel under a click; a browser/Tauri
// bridge cannot install that hook, so we grab the pixel under the CURRENT cursor
// position on demand via System.Drawing (GetCursorPos + a 1x1 CopyFromScreen). Manual
// HEX/RGB/HSL entry + live conversions + a recent-swatch history round out the module.

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function hex({ r, g, b }: Rgb): string {
  const h = (n: number) => clamp(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbStr({ r, g, b }: Rgb): string {
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rr = clamp(r) / 255;
  const gg = clamp(g) / 255;
  const bb = clamp(b) / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslStr(c: Rgb): string {
  const { h, s, l } = toHsl(c);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// Relative luminance → pick a readable text colour to overlay on the swatch.
function readableOn({ r, g, b }: Rgb): string {
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? '#111' : '#fff';
}

// Parse "#RRGGBB" / "RRGGBB" / "#RGB" or an "rgb(r,g,b)" string into an Rgb.
function parseColor(input: string): Rgb | null {
  const s = input.trim();
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) return { r, g, b };
    return null;
  }
  const hx = s.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hx)) {
    return {
      r: parseInt(hx.slice(0, 2), 16),
      g: parseInt(hx.slice(2, 4), 16),
      b: parseInt(hx.slice(4, 6), 16),
    };
  }
  if (/^[0-9a-fA-F]{3}$/.test(hx)) {
    return {
      r: parseInt(hx[0]! + hx[0], 16),
      g: parseInt(hx[1]! + hx[1], 16),
      b: parseInt(hx[2]! + hx[2], 16),
    };
  }
  return null;
}

export function ColorPickerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [color, setColor] = useState<Rgb>({ r: 0x2d, g: 0x7d, b: 0x46 });
  const [history, setHistory] = useState<Rgb[]>([]);
  const [hexInput, setHexInput] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<Rgb[]>([]);
  historyRef.current = history;

  const pushHistory = (c: Rgb) => {
    setHistory((prev) => {
      const h = hex(c);
      const deduped = prev.filter((p) => hex(p) !== h);
      return [c, ...deduped].slice(0, 16);
    });
  };

  const applyColor = (c: Rgb, remember = true) => {
    setColor(c);
    if (remember) pushHistory(c);
  };

  // Grab the pixel under the current mouse cursor from the live screen.
  const grabUnderCursor = async () => {
    if (!desktop) {
      setNote(t('colorpicker.desktopOnly'));
      return;
    }
    setBusy(true);
    setNote(t('colorpicker.grabbing'));
    try {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing | Out-Null; ` +
        `$p=[System.Windows.Forms.Cursor]::Position; ` +
        `$bmp=New-Object System.Drawing.Bitmap 1,1; ` +
        `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen($p.X,$p.Y,0,0,(New-Object System.Drawing.Size 1,1)); ` +
        `$c=$bmp.GetPixel(0,0); $g.Dispose(); $bmp.Dispose(); ` +
        `Write-Output ("{0} {1} {2}" -f $c.R,$c.G,$c.B)`;
      const res = await runPowershell(script);
      const out = res.stdout.trim();
      const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(out);
      if (!res.success || !m) {
        throw new Error(res.stderr.trim() || out || `exit ${res.code}`);
      }
      const c: Rgb = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
      applyColor(c);
      setNote(t('colorpicker.grabbed', { hex: hex(c) }));
    } catch (e) {
      setNote(`${t('colorpicker.grabFailed')}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  const applyHex = () => {
    const c = parseColor(hexInput);
    if (c) {
      applyColor(c);
      setNote(null);
    } else {
      setNote(t('colorpicker.badHex'));
    }
  };

  const copy = async (value: string) => {
    try {
      if (desktop) {
        await runPowershell(`Set-Clipboard -Value '${value.replace(/'/g, "''")}'`);
      } else {
        await navigator.clipboard?.writeText(value);
      }
      setNote(t('colorpicker.copied', { value }));
    } catch {
      setNote(t('colorpicker.copyFailed'));
    }
  };

  const setChannel = (ch: keyof Rgb, raw: string) => {
    const n = raw === '' ? 0 : Number(raw);
    if (Number.isNaN(n)) return;
    setColor((prev) => ({ ...prev, [ch]: clamp(n) }));
  };

  const hexValue = useMemo(() => hex(color), [color]);
  const rgbValue = useMemo(() => rgbStr(color), [color]);
  const hslValue = useMemo(() => hslStr(color), [color]);
  const swatchText = useMemo(() => readableOn(color), [color]);

  const rows: { label: string; value: string }[] = [
    { label: 'HEX', value: hexValue },
    { label: 'RGB', value: rgbValue },
    { label: 'HSL', value: hslValue },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colorpicker.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini primary" disabled={busy} onClick={grabUnderCursor}>
          🎯 {t('colorpicker.grab')}
        </button>
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: '1px solid var(--card-stroke, #8884)',
            background: hexValue,
            display: 'inline-block',
          }}
        />
        <span className="count-note">{t('colorpicker.grabHint')}</span>
      </ModuleToolbar>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('colorpicker.desktopOnly')}
        </p>
      )}
      {note && <p className="mod-msg">{note}</p>}

      {/* Big swatch */}
      <div
        style={{
          height: 96,
          borderRadius: 8,
          border: '1px solid var(--card-stroke, #8884)',
          background: hexValue,
          color: swatchText,
          display: 'flex',
          alignItems: 'flex-end',
          padding: '10px 14px',
          fontFamily: 'Consolas, monospace',
          fontWeight: 600,
        }}
      >
        {hexValue} · {rgbValue}
      </div>

      {/* Format rows with copy buttons */}
      <div className="dt-wrap" style={{ marginTop: 12 }}>
        <table className="dt">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td style={{ width: 60, fontWeight: 600 }}>{row.label}</td>
                <td style={{ fontFamily: 'Consolas, monospace' }}>{row.value}</td>
                <td style={{ width: 90, textAlign: 'right' }}>
                  <button className="mini" onClick={() => copy(row.value)}>
                    {t('colorpicker.copy')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* RGB channel sliders */}
      <div style={{ marginTop: 14, display: 'grid', gap: 8, maxWidth: 460 }}>
        {(['r', 'g', 'b'] as const).map((ch) => (
          <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 20, fontWeight: 600, textTransform: 'uppercase' }}>{ch}</span>
            <input
              type="range"
              min={0}
              max={255}
              value={color[ch]}
              onChange={(e) => setChannel(ch, e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              className="mod-search"
              style={{ width: 64 }}
              type="number"
              min={0}
              max={255}
              value={color[ch]}
              onChange={(e) => setChannel(ch, e.target.value)}
            />
          </label>
        ))}
      </div>

      {/* Manual HEX / rgb() entry */}
      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ width: 180, fontFamily: 'Consolas, monospace' }}
          placeholder="#RRGGBB"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyHex();
          }}
        />
        <button className="mini" onClick={applyHex}>
          {t('colorpicker.apply')}
        </button>
        <button className="mini" onClick={() => pushHistory(color)}>
          {t('colorpicker.save')}
        </button>
      </ModuleToolbar>

      {/* Recent history swatches */}
      <p className="count-note" style={{ fontWeight: 600, marginBottom: 4 }}>
        {t('colorpicker.recent')}
      </p>
      {history.length === 0 ? (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('colorpicker.noHistory')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {history.map((c, i) => (
            <button
              key={`${hex(c)}-${i}`}
              title={hex(c)}
              onClick={() => applyColor(c, false)}
              style={{
                width: 30,
                height: 30,
                borderRadius: 6,
                border: '1px solid var(--card-stroke, #8884)',
                background: hex(c),
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
