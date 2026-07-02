import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface RGB {
  r: number;
  g: number;
  b: number;
}

const clamp = (n: number, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, n));
const hex2 = (n: number) => clamp(Math.round(n)).toString(16).padStart(2, '0');

function toHex({ r, g, b }: RGB): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
}
function parseColor(s: string): RGB | null {
  const t = s.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(t);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^#?([0-9a-f]{3})$/i.exec(t);
  if (m) {
    const h = m[1]!;
    return { r: parseInt(h[0]! + h[0]!, 16), g: parseInt(h[1]! + h[1]!, 16), b: parseInt(h[2]! + h[2]!, 16) };
  }
  m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(t);
  if (m) return { r: clamp(+m[1]!), g: clamp(+m[2]!), b: clamp(+m[3]!) };
  return null;
}

function rgb2hsl({ r, g, b }: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
function rgb2hsv({ r, g, b }: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round((max ? d / max : 0) * 100), Math.round(max * 100)];
}
function rgb2cmyk({ r, g, b }: RGB): [number, number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k === 1) return [0, 0, 0, 100];
  return [
    Math.round(((1 - rr - k) / (1 - k)) * 100),
    Math.round(((1 - gg - k) / (1 - k)) * 100),
    Math.round(((1 - bb - k) / (1 - k)) * 100),
    Math.round(k * 100),
  ];
}
function hsl2rgb(h: number, s: number, l: number): RGB {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function rotate(c: RGB, deg: number): RGB {
  const [h, s, l] = rgb2hsl(c);
  return hsl2rgb((h + deg + 360) % 360, s, l);
}
function relLum({ r, g, b }: RGB): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
  const l1 = relLum(a);
  const l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function ColorToolsModule() {
  const { t } = useTranslation();
  const [color, setColor] = useState<RGB>({ r: 76, g: 194, b: 255 });
  const [bg, setBg] = useState<RGB>({ r: 27, g: 27, b: 31 });
  const [input, setInput] = useState('#4CC2FF');
  const [bgInput, setBgInput] = useState('#1B1B1F');
  const [msg, setMsg] = useState('');

  const hsl = useMemo(() => rgb2hsl(color), [color]);
  const hsv = useMemo(() => rgb2hsv(color), [color]);
  const cmyk = useMemo(() => rgb2cmyk(color), [color]);
  const ratio = useMemo(() => contrast(color, bg), [color, bg]);

  const setFromText = (s: string) => {
    setInput(s);
    const c = parseColor(s);
    if (c) setColor(c);
  };
  const setBgFromText = (s: string) => {
    setBgInput(s);
    const c = parseColor(s);
    if (c) setBg(c);
  };
  const applyColor = (c: RGB) => {
    setColor(c);
    setInput(toHex(c));
  };
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    setMsg(t('colortools.copied', { v }));
  };
  const random = () => applyColor({ r: (Math.random() * 256) | 0, g: (Math.random() * 256) | 0, b: (Math.random() * 256) | 0 });
  const swap = () => {
    const c = color;
    applyColor(bg);
    setBg(c);
    setBgInput(toHex(c));
  };

  const rgbStr = `rgb(${color.r}, ${color.g}, ${color.b})`;
  const hslStr = `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
  const hsvStr = `hsv(${hsv[0]}, ${hsv[1]}%, ${hsv[2]}%)`;
  const cmykStr = `cmyk(${cmyk[0]}%, ${cmyk[1]}%, ${cmyk[2]}%, ${cmyk[3]}%)`;
  const palette = [rotate(color, -60), rotate(color, -30), color, rotate(color, 30), rotate(color, 60), rotate(color, 180)];

  const rows: [string, string][] = [
    ['HEX', toHex(color)],
    ['RGB', rgbStr],
    ['HSL', hslStr],
    ['HSV', hsvStr],
    ['CMYK', cmykStr],
  ];
  const badges: [string, boolean][] = [
    [t('colortools.aaNormal'), ratio >= 4.5],
    [t('colortools.aaaNormal'), ratio >= 7],
    [t('colortools.aaLarge'), ratio >= 3],
    [t('colortools.aaaLarge'), ratio >= 4.5],
  ];

  return (
    <div className="mod">
      <div className="ct-top">
        <div className="ct-swatch" style={{ background: toHex(color) }} />
        <div className="ct-fields">
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <input className="mod-search" style={{ maxWidth: 180 }} value={input} onChange={(e) => setFromText(e.target.value)} />
            <button className="mini" onClick={random}>
              {t('colortools.random')}
            </button>
          </div>
          {(['r', 'g', 'b'] as const).map((ch) => (
            <label key={ch} className="ct-slider">
              <span>{ch.toUpperCase()}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={color[ch]}
                onChange={(e) => applyColor({ ...color, [ch]: +e.target.value })}
              />
              <span className="ct-val">{color[ch]}</span>
            </label>
          ))}
        </div>
      </div>

      <table className="dt ct-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 60, color: 'var(--text-tertiary)' }}>{k}</td>
              <td>
                <code>{v}</code>
              </td>
              <td style={{ width: 80, textAlign: 'right' }}>
                <button className="mini" onClick={() => copy(v)}>
                  {t('colortools.copy')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('colortools.palette')}
      </h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colortools.paletteHint')}
      </p>
      <div className="ct-palette">
        {palette.map((c, i) => (
          <button key={i} className="ct-chip" style={{ background: toHex(c) }} title={toHex(c)} onClick={() => applyColor(c)} />
        ))}
      </div>

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('colortools.contrast')}
      </h3>
      <div className="mod-form">
        <input className="mod-search" style={{ maxWidth: 180 }} value={bgInput} onChange={(e) => setBgFromText(e.target.value)} />
        <button className="mini" onClick={swap}>
          {t('colortools.swap')}
        </button>
      </div>
      <div className="ct-preview" style={{ background: toHex(bg), color: toHex(color) }}>
        {t('colortools.sample')}
      </div>
      <p className="count-note">{t('colortools.ratio', { ratio: ratio.toFixed(2) })}</p>
      <div className="ct-badges">
        {badges.map(([label, pass]) => (
          <span key={label} className={`status-pill ${pass ? 'working' : 'stub'}`}>
            {pass ? '✓' : '✗'} {label}
          </span>
        ))}
      </div>
      {msg && <p className="mod-msg" style={{ marginTop: 12 }}>{msg}</p>}
    </div>
  );
}
