import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

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

// ---- CSS named colours (147 standard names) ------------------------------
const NAMED: Record<string, string> = {
  aliceblue: 'F0F8FF', antiquewhite: 'FAEBD7', aqua: '00FFFF', aquamarine: '7FFFD4',
  azure: 'F0FFFF', beige: 'F5F5DC', bisque: 'FFE4C4', black: '000000',
  blanchedalmond: 'FFEBCD', blue: '0000FF', blueviolet: '8A2BE2', brown: 'A52A2A',
  burlywood: 'DEB887', cadetblue: '5F9EA0', chartreuse: '7FFF00', chocolate: 'D2691E',
  coral: 'FF7F50', cornflowerblue: '6495ED', cornsilk: 'FFF8DC', crimson: 'DC143C',
  cyan: '00FFFF', darkblue: '00008B', darkcyan: '008B8B', darkgoldenrod: 'B8860B',
  darkgray: 'A9A9A9', darkgreen: '006400', darkgrey: 'A9A9A9', darkkhaki: 'BDB76B',
  darkmagenta: '8B008B', darkolivegreen: '556B2F', darkorange: 'FF8C00', darkorchid: '9932CC',
  darkred: '8B0000', darksalmon: 'E9967A', darkseagreen: '8FBC8F', darkslateblue: '483D8B',
  darkslategray: '2F4F4F', darkslategrey: '2F4F4F', darkturquoise: '00CED1', darkviolet: '9400D3',
  deeppink: 'FF1493', deepskyblue: '00BFFF', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1E90FF', firebrick: 'B22222', floralwhite: 'FFFAF0', forestgreen: '228B22',
  fuchsia: 'FF00FF', gainsboro: 'DCDCDC', ghostwhite: 'F8F8FF', gold: 'FFD700',
  goldenrod: 'DAA520', gray: '808080', green: '008000', greenyellow: 'ADFF2F',
  grey: '808080', honeydew: 'F0FFF0', hotpink: 'FF69B4', indianred: 'CD5C5C',
  indigo: '4B0082', ivory: 'FFFFF0', khaki: 'F0E68C', lavender: 'E6E6FA',
  lavenderblush: 'FFF0F5', lawngreen: '7CFC00', lemonchiffon: 'FFFACD', lightblue: 'ADD8E6',
  lightcoral: 'F08080', lightcyan: 'E0FFFF', lightgoldenrodyellow: 'FAFAD2', lightgray: 'D3D3D3',
  lightgreen: '90EE90', lightgrey: 'D3D3D3', lightpink: 'FFB6C1', lightsalmon: 'FFA07A',
  lightseagreen: '20B2AA', lightskyblue: '87CEFA', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'B0C4DE', lightyellow: 'FFFFE0', lime: '00FF00', limegreen: '32CD32',
  linen: 'FAF0E6', magenta: 'FF00FF', maroon: '800000', mediumaquamarine: '66CDAA',
  mediumblue: '0000CD', mediumorchid: 'BA55D3', mediumpurple: '9370DB', mediumseagreen: '3CB371',
  mediumslateblue: '7B68EE', mediumspringgreen: '00FA9A', mediumturquoise: '48D1CC', mediumvioletred: 'C71585',
  midnightblue: '191970', mintcream: 'F5FFFA', mistyrose: 'FFE4E1', moccasin: 'FFE4B5',
  navajowhite: 'FFDEAD', navy: '000080', oldlace: 'FDF5E6', olive: '808000',
  olivedrab: '6B8E23', orange: 'FFA500', orangered: 'FF4500', orchid: 'DA70D6',
  palegoldenrod: 'EEE8AA', palegreen: '98FB98', paleturquoise: 'AFEEEE', palevioletred: 'DB7093',
  papayawhip: 'FFEFD5', peachpuff: 'FFDAB9', peru: 'CD853F', pink: 'FFC0CB',
  plum: 'DDA0DD', powderblue: 'B0E0E6', purple: '800080', rebeccapurple: '663399',
  red: 'FF0000', rosybrown: 'BC8F8F', royalblue: '4169E1', saddlebrown: '8B4513',
  salmon: 'FA8072', sandybrown: 'F4A460', seagreen: '2E8B57', seashell: 'FFF5EE',
  sienna: 'A0522D', silver: 'C0C0C0', skyblue: '87CEEB', slateblue: '6A5ACD',
  slategray: '708090', slategrey: '708090', snow: 'FFFAFA', springgreen: '00FF7F',
  steelblue: '4682B4', tan: 'D2B48C', teal: '008080', thistle: 'D8BFD8',
  tomato: 'FF6347', turquoise: '40E0D0', violet: 'EE82EE', wheat: 'F5DEB3',
  white: 'FFFFFF', whitesmoke: 'F5F5F5', yellow: 'FFFF00', yellowgreen: '9ACD32',
};

function parseColor(s: string): RGB | null {
  const t = s.trim();
  // named
  const named = NAMED[t.toLowerCase()];
  if (named) {
    const n = parseInt(named, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
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
  m = /hsla?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)%?[,\s]+(\d+(?:\.\d+)?)%?/i.exec(t);
  if (m) return hsl2rgb(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

/** Nearest CSS named colour by Euclidean RGB distance. */
function nearestNamed(c: RGB): { name: string; hex: string; exact: boolean } {
  let best = '';
  let bestHex = '';
  let bestD = Infinity;
  for (const [name, hx] of Object.entries(NAMED)) {
    const n = parseInt(hx, 16);
    const dr = c.r - ((n >> 16) & 255);
    const dg = c.g - ((n >> 8) & 255);
    const db = c.b - (n & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = name;
      bestHex = `#${hx}`;
    }
  }
  return { name: best, hex: bestHex.toUpperCase(), exact: bestD === 0 };
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
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function rotate(c: RGB, deg: number): RGB {
  const [h, s, l] = rgb2hsl(c);
  return hsl2rgb((h + deg + 360) % 360, s, l);
}
function withLightness(c: RGB, l: number): RGB {
  const [h, s] = rgb2hsl(c);
  return hsl2rgb(h, s, clamp(l, 0, 100));
}
/** Perceptual-ish mix in linear-ish RGB at t (0=a, 1=b). */
function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
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

// ==========================================================================
export function ColorToolsModule() {
  const { t } = useTranslation();
  const [color, setColor] = useState<RGB>({ r: 76, g: 194, b: 255 });
  const [input, setInput] = useState('#4CC2FF');
  const [msg, setMsg] = useState('');

  const setFromText = (s: string) => {
    setInput(s);
    const c = parseColor(s);
    if (c) setColor(c);
  };
  const applyColor = (c: RGB) => {
    setColor(c);
    setInput(toHex(c));
    setMsg('');
  };
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    setMsg(t('colortools.copied', { v }));
  };
  const random = () => applyColor({ r: (Math.random() * 256) | 0, g: (Math.random() * 256) | 0, b: (Math.random() * 256) | 0 });

  const shared = { color, applyColor, copy, t };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('colortools.blurb')}
      </p>
      <div className="ct-top">
        <div className="ct-swatch" style={{ background: toHex(color) }} />
        <div className="ct-fields">
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <input
              className="mod-search"
              style={{ maxWidth: 200 }}
              value={input}
              placeholder={t('colortools.inputPh')}
              onChange={(e) => setFromText(e.target.value)}
            />
            <button className="mini" onClick={random}>
              {t('colortools.random')}
            </button>
          </div>
          {(['r', 'g', 'b'] as const).map((ch) => (
            <label key={ch} className="ct-slider">
              <span>{ch.toUpperCase()}</span>
              <input type="range" min={0} max={255} value={color[ch]} onChange={(e) => applyColor({ ...color, [ch]: +e.target.value })} />
              <span className="ct-val">{color[ch]}</span>
            </label>
          ))}
        </div>
      </div>

      <ModuleTabs
        tabs={[
          { id: 'convert', en: 'Convert', zh: '轉換', render: () => <ConvertTab {...shared} /> },
          { id: 'schemes', en: 'Schemes', zh: '配色方案', render: () => <SchemesTab {...shared} /> },
          { id: 'mix', en: 'Mix & Blend', zh: '混色', render: () => <MixTab {...shared} /> },
          { id: 'gradient', en: 'Gradient', zh: '漸變', render: () => <GradientTab {...shared} /> },
          { id: 'contrast', en: 'Contrast', zh: '對比度', render: () => <ContrastTab {...shared} /> },
          { id: 'export', en: 'Named & Export', zh: '命名 · 匯出', render: () => <ExportTab {...shared} /> },
        ]}
      />

      {msg && (
        <p className="mod-msg" style={{ marginTop: 12 }}>
          {msg}
        </p>
      )}
    </div>
  );
}

type Shared = {
  color: RGB;
  applyColor: (c: RGB) => void;
  copy: (v: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
};

// ---- Swatch grid helper ---------------------------------------------------
function Swatches({ items, applyColor, copy }: { items: { c: RGB; label?: string }[]; applyColor: (c: RGB) => void; copy: (v: string) => void }) {
  return (
    <div className="ct-palette">
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <button
            className="ct-chip"
            style={{ background: toHex(it.c) }}
            title={`${toHex(it.c)} — ${it.label ?? ''}`.trim()}
            onClick={() => applyColor(it.c)}
            onContextMenu={(e) => {
              e.preventDefault();
              copy(toHex(it.c));
            }}
          />
          <code style={{ fontSize: 10 }}>{toHex(it.c)}</code>
          {it.label && <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>{it.label}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- Convert tab ----------------------------------------------------------
function ConvertTab({ color, copy, t }: Shared) {
  const hsl = useMemo(() => rgb2hsl(color), [color]);
  const hsv = useMemo(() => rgb2hsv(color), [color]);
  const cmyk = useMemo(() => rgb2cmyk(color), [color]);
  const named = useMemo(() => nearestNamed(color), [color]);

  const rows: [string, string][] = [
    ['HEX', toHex(color)],
    ['RGB', `rgb(${color.r}, ${color.g}, ${color.b})`],
    ['HSL', `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`],
    ['HSV', `hsv(${hsv[0]}, ${hsv[1]}%, ${hsv[2]}%)`],
    ['CMYK', `cmyk(${cmyk[0]}%, ${cmyk[1]}%, ${cmyk[2]}%, ${cmyk[3]}%)`],
    ['Int', String((color.r << 16) | (color.g << 8) | color.b)],
    [t('colortools.nearest'), named.exact ? named.name : `${named.name} (${named.hex})`],
  ];
  return (
    <table className="dt ct-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td style={{ width: 70, color: 'var(--text-tertiary)' }}>{k}</td>
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
  );
}

// ---- Schemes tab ----------------------------------------------------------
function SchemesTab({ color, applyColor, copy, t }: Shared) {
  const [l] = useMemo(() => rgb2hsl(color), [color]);
  void l;
  const schemes: { key: string; title: string; items: { c: RGB; label?: string }[] }[] = useMemo(() => {
    const shades = Array.from({ length: 7 }, (_, i) => ({ c: withLightness(color, 10 + i * 13), label: `${10 + i * 13}%` }));
    return [
      { key: 'complementary', title: t('colortools.schComplementary'), items: [{ c: color }, { c: rotate(color, 180) }] },
      { key: 'analogous', title: t('colortools.schAnalogous'), items: [{ c: rotate(color, -30) }, { c: color }, { c: rotate(color, 30) }] },
      { key: 'triadic', title: t('colortools.schTriadic'), items: [{ c: color }, { c: rotate(color, 120) }, { c: rotate(color, 240) }] },
      {
        key: 'splitcomp',
        title: t('colortools.schSplit'),
        items: [{ c: color }, { c: rotate(color, 150) }, { c: rotate(color, 210) }],
      },
      {
        key: 'tetradic',
        title: t('colortools.schTetradic'),
        items: [{ c: color }, { c: rotate(color, 90) }, { c: rotate(color, 180) }, { c: rotate(color, 270) }],
      },
      { key: 'shades', title: t('colortools.schShades'), items: shades },
    ];
  }, [color, t]);

  return (
    <>
      {schemes.map((s) => (
        <div key={s.key} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 className="group-title" style={{ fontSize: 13, margin: '10px 0 6px' }}>
              {s.title}
            </h3>
            <button className="mini" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => copy(s.items.map((i) => toHex(i.c)).join(', '))}>
              {t('colortools.copy')}
            </button>
          </div>
          <Swatches items={s.items} applyColor={applyColor} copy={copy} />
        </div>
      ))}
      <p className="count-note">{t('colortools.schemesHint')}</p>
    </>
  );
}

// ---- Mix & Blend tab ------------------------------------------------------
function MixTab({ color, applyColor, copy, t }: Shared) {
  const [otherInput, setOtherInput] = useState('#FFFFFF');
  const [steps, setSteps] = useState(5);
  const other = parseColor(otherInput) ?? { r: 255, g: 255, b: 255 };
  const blend = useMemo(() => {
    const n = Math.max(2, Math.min(11, steps));
    return Array.from({ length: n }, (_, i) => ({ c: mix(color, other, i / (n - 1)), label: `${Math.round((i / (n - 1)) * 100)}%` }));
  }, [color, other, steps]);
  const mid = mix(color, other, 0.5);

  return (
    <>
      <div className="mod-form">
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={otherInput}
          placeholder={t('colortools.mixOtherPh')}
          onChange={(e) => setOtherInput(e.target.value)}
        />
        <label className="ct-slider" style={{ margin: 0 }}>
          <span style={{ width: 'auto' }}>{t('colortools.steps')}</span>
          <input type="range" min={2} max={11} value={steps} onChange={(e) => setSteps(+e.target.value)} style={{ width: 120 }} />
          <span className="ct-val">{steps}</span>
        </label>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colortools.mixHint')}
      </p>
      <Swatches items={blend} applyColor={applyColor} copy={copy} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{t('colortools.midpoint')}</span>
        <code>{toHex(mid)}</code>
        <button className="mini" onClick={() => copy(toHex(mid))}>
          {t('colortools.copy')}
        </button>
        <button className="mini primary" onClick={() => applyColor(mid)}>
          {t('colortools.useIt')}
        </button>
      </div>
    </>
  );
}

// ---- Gradient tab ---------------------------------------------------------
function GradientTab({ color, copy, applyColor, t }: Shared) {
  void applyColor;
  const [endInput, setEndInput] = useState('#FF6347');
  const [angle, setAngle] = useState(90);
  const end = parseColor(endInput) ?? { r: 255, g: 99, b: 71 };
  const css = `linear-gradient(${angle}deg, ${toHex(color)}, ${toHex(end)})`;

  return (
    <>
      <div className="mod-form">
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={endInput}
          placeholder={t('colortools.gradEndPh')}
          onChange={(e) => setEndInput(e.target.value)}
        />
        <label className="ct-slider" style={{ margin: 0 }}>
          <span style={{ width: 'auto' }}>{t('colortools.angle')}</span>
          <input type="range" min={0} max={360} value={angle} onChange={(e) => setAngle(+e.target.value)} style={{ width: 140 }} />
          <span className="ct-val">{angle}°</span>
        </label>
      </div>
      <div style={{ height: 96, borderRadius: 'var(--radius)', border: '1px solid var(--stroke)', background: css, marginBottom: 8 }} />
      <div className="ct-table" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ flex: 1, wordBreak: 'break-all' }}>background: {css};</code>
        <button className="mini" onClick={() => copy(`background: ${css};`)}>
          {t('colortools.copy')}
        </button>
      </div>
    </>
  );
}

// ---- Contrast tab ---------------------------------------------------------
function ContrastTab({ color, applyColor, t }: Shared) {
  const [bg, setBg] = useState<RGB>({ r: 27, g: 27, b: 31 });
  const [bgInput, setBgInput] = useState('#1B1B1F');
  const ratio = useMemo(() => contrast(color, bg), [color, bg]);

  const setBgFromText = (s: string) => {
    setBgInput(s);
    const c = parseColor(s);
    if (c) setBg(c);
  };
  const swap = () => {
    const c = color;
    applyColor(bg);
    setBg(c);
    setBgInput(toHex(c));
  };

  const badges: [string, boolean][] = [
    [t('colortools.aaNormal'), ratio >= 4.5],
    [t('colortools.aaaNormal'), ratio >= 7],
    [t('colortools.aaLarge'), ratio >= 3],
    [t('colortools.aaaLarge'), ratio >= 4.5],
  ];

  return (
    <>
      <div className="mod-form">
        <input className="mod-search" style={{ maxWidth: 200 }} value={bgInput} placeholder={t('colortools.bgPh')} onChange={(e) => setBgFromText(e.target.value)} />
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
    </>
  );
}

// ---- Named & Export tab ---------------------------------------------------
function ExportTab({ color, applyColor, copy, t }: Shared) {
  const [importText, setImportText] = useState('');
  const [imported, setImported] = useState<RGB[]>([]);

  const palette = useMemo(
    () => [rotate(color, -60), rotate(color, -30), color, rotate(color, 30), rotate(color, 180)],
    [color],
  );
  const hexes = palette.map(toHex);
  const asCss = palette.map((c, i) => `  --color-${i + 1}: ${toHex(c)};`).join('\n');
  const asJson = JSON.stringify(
    palette.map((c) => ({ hex: toHex(c), rgb: [c.r, c.g, c.b] })),
    null,
    2,
  );

  const doImport = () => {
    const found: RGB[] = [];
    for (const tok of importText.split(/[\s,;\n]+/)) {
      const c = parseColor(tok);
      if (c) found.push(c);
    }
    setImported(found);
    if (found.length) applyColor(found[0]!);
  };

  // named colour picker (compact list of common names)
  const commonNames = ['red', 'orangered', 'orange', 'gold', 'yellow', 'lime', 'green', 'teal', 'cyan', 'dodgerblue', 'blue', 'indigo', 'purple', 'magenta', 'pink', 'brown', 'gray', 'black', 'white'];

  return (
    <>
      <h3 className="group-title" style={{ fontSize: 13, margin: '4px 0 6px' }}>
        {t('colortools.namedPicker')}
      </h3>
      <Swatches
        items={commonNames.map((n) => {
          const hx = NAMED[n]!;
          const num = parseInt(hx, 16);
          return { c: { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }, label: n };
        })}
        applyColor={applyColor}
        copy={copy}
      />

      <h3 className="group-title" style={{ fontSize: 13, margin: '14px 0 6px' }}>
        {t('colortools.exportPalette')}
      </h3>
      <div className="ct-table" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="mini" onClick={() => copy(hexes.join('\n'))}>
          {t('colortools.exportList')}
        </button>
        <button className="mini" onClick={() => copy(`:root {\n${asCss}\n}`)}>
          {t('colortools.exportCss')}
        </button>
        <button className="mini" onClick={() => copy(asJson)}>
          {t('colortools.exportJson')}
        </button>
      </div>
      <pre className="dt ct-table" style={{ marginTop: 8, padding: 12, overflowX: 'auto', fontSize: 12 }}>
        {`:root {\n${asCss}\n}`}
      </pre>

      <h3 className="group-title" style={{ fontSize: 13, margin: '14px 0 6px' }}>
        {t('colortools.importPalette')}
      </h3>
      <textarea
        className="mod-search"
        style={{ width: '100%', minHeight: 60, fontFamily: 'monospace', resize: 'vertical' }}
        value={importText}
        placeholder={t('colortools.importPh')}
        onChange={(e) => setImportText(e.target.value)}
      />
      <div className="mod-form" style={{ marginTop: 8 }}>
        <button className="mini primary" onClick={doImport}>
          {t('colortools.importBtn')}
        </button>
      </div>
      {imported.length > 0 && (
        <>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('colortools.importCount', { n: imported.length })}
          </p>
          <Swatches items={imported.map((c) => ({ c }))} applyColor={applyColor} copy={copy} />
        </>
      )}
    </>
  );
}
