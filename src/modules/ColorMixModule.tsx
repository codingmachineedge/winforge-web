import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// --- Colour engine (port of WinForge.Services.ColorMixService) ---------------

type Rgb = { r: number; g: number; b: number };
type BlendSpace = 'srgbLinear' | 'rgbAverage' | 'hsl';

function hexDigit(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 97 + 10; // a-f
  if (code >= 65 && code <= 70) return code - 65 + 10; // A-F
  return -1;
}

function hexPair(hi: string, lo: string): number {
  const h = hexDigit(hi);
  const l = hexDigit(lo);
  if (h < 0 || l < 0) return -1;
  return (h << 4) | l;
}

/** Parse "#rrggbb", "rrggbb", "#rgb" or "rgb". Returns black on any failure. */
function parseColor(text: string): Rgb {
  const black: Rgb = { r: 0, g: 0, b: 0 };
  if (!text || !text.trim()) return black;
  let s = text.trim();
  if (s.startsWith('#')) s = s.slice(1);
  s = s.trim();
  if (s.length === 3) {
    const c0 = s[0]!, c1 = s[1]!, c2 = s[2]!;
    const r = hexPair(c0, c0);
    const g = hexPair(c1, c1);
    const b = hexPair(c2, c2);
    if (r < 0 || g < 0 || b < 0) return black;
    return { r, g, b };
  }
  if (s.length === 6) {
    const r = hexPair(s[0]!, s[1]!);
    const g = hexPair(s[2]!, s[3]!);
    const b = hexPair(s[4]!, s[5]!);
    if (r < 0 || g < 0 || b < 0) return black;
    return { r, g, b };
  }
  return black;
}

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const toHex = (c: Rgb) => `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
const rgbCss = (c: Rgb) => `rgb(${c.r}, ${c.g}, ${c.b})`;

function rgbToHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

const hslCss = (c: Rgb) => {
  const { h, s, l } = rgbToHsl(c);
  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
};

function to255(v: number): number {
  let x = v * 255;
  if (x < 0) x = 0;
  else if (x > 255) x = 255;
  return Math.round(x);
}

function hslToRgb(hIn: number, sIn: number, lIn: number): Rgb {
  let h = ((hIn % 360) + 360) % 360;
  let s = sIn < 0 ? 0 : sIn > 1 ? 1 : sIn;
  let l = lIn < 0 ? 0 : lIn > 1 ? 1 : lIn;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  return { r: to255(r1 + m), g: to255(g1 + m), b: to255(b1 + m) };
}

function lerp8(x: number, y: number, t: number): number {
  let v = x + (y - x) * t;
  if (v < 0) v = 0;
  else if (v > 255) v = 255;
  return Math.round(v);
}

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function toSrgb(lin: number): number {
  let l = lin < 0 ? 0 : lin > 1 ? 1 : lin;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  let v = s * 255;
  if (v < 0) v = 0;
  else if (v > 255) v = 255;
  return Math.round(v);
}

function mixLinear(a: Rgb, b: Rgb, t: number): Rgb {
  const lr = toLinear(a.r) + (toLinear(b.r) - toLinear(a.r)) * t;
  const lg = toLinear(a.g) + (toLinear(b.g) - toLinear(a.g)) * t;
  const lb = toLinear(a.b) + (toLinear(b.b) - toLinear(a.b)) * t;
  return { r: toSrgb(lr), g: toSrgb(lg), b: toSrgb(lb) };
}

function mixHsl(a: Rgb, b: Rgb, t: number): Rgb {
  const c1 = rgbToHsl(a);
  const c2 = rgbToHsl(b);
  let dh = c2.h - c1.h;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  let h = c1.h + dh * t;
  h = ((h % 360) + 360) % 360;
  const s = c1.s + (c2.s - c1.s) * t;
  const l = c1.l + (c2.l - c1.l) * t;
  return hslToRgb(h, s, l);
}

function mix(a: Rgb, b: Rgb, tIn: number, space: BlendSpace): Rgb {
  let t = Number.isNaN(tIn) ? 0 : tIn;
  t = Math.max(0, Math.min(1, t));
  switch (space) {
    case 'rgbAverage':
      return { r: lerp8(a.r, b.r, t), g: lerp8(a.g, b.g, t), b: lerp8(a.b, b.b, t) };
    case 'hsl':
      return mixHsl(a, b, t);
    case 'srgbLinear':
    default:
      return mixLinear(a, b, t);
  }
}

function gradient(a: Rgb, b: Rgb, stepsIn: number, space: BlendSpace): Rgb[] {
  let steps = stepsIn;
  if (steps < 2) steps = 2;
  if (steps > 64) steps = 64;
  const list: Rgb[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    list.push(mix(a, b, t, space));
  }
  return list;
}

function gradientCss(stops: Rgb[]): string {
  if (!stops.length) return 'linear-gradient(90deg)';
  const parts: string[] = ['linear-gradient(90deg'];
  for (let i = 0; i < stops.length; i++) {
    const pct = stops.length === 1 ? 0 : (i * 100) / (stops.length - 1);
    const pctStr = pct
      .toFixed(1)
      .replace(/\.0$/, '');
    parts.push(`, ${toHex(stops[i]!)} ${pctStr}%`);
  }
  return parts.join('') + ')';
}

const detail = (c: Rgb) => `${rgbCss(c)}  ·  ${hslCss(c)}`;

// --- Module ------------------------------------------------------------------

const SPACES: BlendSpace[] = ['srgbLinear', 'rgbAverage', 'hsl'];

export function ColorMixModule() {
  const { t } = useTranslation();
  const [hexA, setHexA] = useState('#3366CC');
  const [hexB, setHexB] = useState('#CC3333');
  const [ratio, setRatio] = useState(50); // 0..100 = % of B
  const [space, setSpace] = useState<BlendSpace>('srgbLinear');
  const [steps, setSteps] = useState(7);
  const [msg, setMsg] = useState('');

  const a = useMemo(() => parseColor(hexA), [hexA]);
  const b = useMemo(() => parseColor(hexB), [hexB]);
  const mixed = useMemo(() => mix(a, b, ratio / 100, space), [a, b, ratio, space]);

  const clampedSteps = Math.max(3, Math.min(20, Math.round(Number.isNaN(steps) ? 7 : steps)));
  const stops = useMemo(() => gradient(a, b, clampedSteps, space), [a, b, clampedSteps, space]);
  const barCss = useMemo(() => gradientCss(stops), [stops]);

  const copy = (text: string, toast: string) => {
    navigator.clipboard?.writeText(text).then(
      () => setMsg(toast),
      () => setMsg(t('colormix.clipFail')),
    );
  };

  const spaceLabel = (s: BlendSpace) => t(`colormix.space.${s}`);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('colormix.blurb')}</p>

      {msg && <p className="count-note" style={{ marginTop: 0 }}>{msg}</p>}

      {/* Two colour inputs */}
      <div className="kv-list" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 8 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 12px' }}>{t('colormix.inputsTitle')}</h3>
        <div className="io-grid">
          <div className="mod-toolbar" style={{ alignItems: 'flex-start' }}>
            <div
              style={{ width: 44, height: 44, borderRadius: 6, border: '1px solid var(--border)', background: toHex(a), flex: '0 0 auto' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="count-note" style={{ margin: 0 }}>{t('colormix.labelA')}</label>
              <input className="mod-search" style={{ maxWidth: 160 }} value={hexA} spellCheck={false} onChange={(e) => setHexA(e.target.value)} />
            </div>
          </div>
          <div className="mod-toolbar" style={{ alignItems: 'flex-start' }}>
            <div
              style={{ width: 44, height: 44, borderRadius: 6, border: '1px solid var(--border)', background: toHex(b), flex: '0 0 auto' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="count-note" style={{ margin: 0 }}>{t('colormix.labelB')}</label>
              <input className="mod-search" style={{ maxWidth: 160 }} value={hexB} spellCheck={false} onChange={(e) => setHexB(e.target.value)} />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('colormix.ratioLabel', { a: 100 - ratio, b: ratio })}
          </label>
          <input type="range" min={0} max={100} step={1} value={ratio} onChange={(e) => setRatio(+e.target.value)} style={{ width: '100%' }} />
        </div>

        <div className="mod-toolbar" style={{ marginTop: 12 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('colormix.spaceLabel')}</span>
          <select className="mod-select" value={space} onChange={(e) => setSpace(e.target.value as BlendSpace)}>
            {SPACES.map((s) => (
              <option key={s} value={s}>{spaceLabel(s)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Mixed result */}
      <div className="kv-list" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 8, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 12px' }}>{t('colormix.mixedTitle')}</h3>
        <div className="mod-toolbar" style={{ alignItems: 'center' }}>
          <div
            style={{ width: 72, height: 72, borderRadius: 8, border: '1px solid var(--border)', background: toHex(mixed), flex: '0 0 auto' }}
          />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 18 }}>{toHex(mixed)}</span>
            <span className="count-note" style={{ margin: 0 }}>{rgbCss(mixed)}</span>
            <span className="count-note" style={{ margin: 0 }}>{hslCss(mixed)}</span>
          </div>
          <button className="mini primary" onClick={() => copy(toHex(mixed), t('colormix.copied', { hex: toHex(mixed) }))}>
            {t('colormix.copyHex')}
          </button>
        </div>
      </div>

      {/* Gradient */}
      <div className="kv-list" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 8, marginTop: 14 }}>
        <div className="mod-toolbar">
          <h3 className="group-title" style={{ fontSize: 15, margin: 0, flex: 1 }}>{t('colormix.gradientTitle')}</h3>
          <button className="mini" onClick={() => copy('background: ' + barCss + ';', t('colormix.cssCopied'))}>
            {t('colormix.copyCss')}
          </button>
        </div>

        <div className="mod-toolbar" style={{ marginTop: 10 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('colormix.stepsLabel')}</span>
          <input
            className="mod-search"
            type="number"
            min={3}
            max={20}
            style={{ maxWidth: 90 }}
            value={steps}
            onChange={(e) => setSteps(Math.max(3, Math.min(20, Math.round(+e.target.value || 7))))}
          />
        </div>

        <div style={{ height: 26, borderRadius: 6, border: '1px solid var(--border)', background: barCss, marginTop: 12 }} />

        <p className="count-note" style={{ marginBottom: 4 }}>{t('colormix.gradientHint')}</p>

        <div className="dt-wrap" style={{ maxHeight: 420 }}>
          <table className="dt">
            <tbody>
              {stops.map((c, i) => {
                const hex = toHex(c);
                return (
                  <tr
                    key={`${hex}-${i}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => copy(hex, t('colormix.copied', { hex }))}
                  >
                    <td style={{ width: 42 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', background: hex }} />
                    </td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 90 }}>{hex}</td>
                    <td className="env-val">{detail(c)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
