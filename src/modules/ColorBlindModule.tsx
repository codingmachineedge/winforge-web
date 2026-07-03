import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 色盲模擬 · Pure-managed colour-vision-deficiency simulator ported from
// WinForge's ColorBlindService. sRGB → linear, apply the Brettel/Vienot
// approximation matrices per type, blend for anomalous trichromacies, back
// to sRGB. Approximations, not a medical instrument. Never throws.

type Cvd =
  | 'protanopia'
  | 'protanomaly'
  | 'deuteranopia'
  | 'deuteranomaly'
  | 'tritanopia'
  | 'tritanomaly'
  | 'achromatopsia';

const clamp01 = (c: number) => (c < 0 ? 0 : c > 1 ? 1 : c);

function toLinear(c: number): number {
  c = clamp01(c);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgb(c: number): number {
  c = clamp01(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

function toByte(v: number): number {
  const n = Math.round(v * 255.0);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

type Matrix = [[number, number, number], [number, number, number], [number, number, number]];

const PROTAN: Matrix = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
];
const DEUTAN: Matrix = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
const TRITAN: Matrix = [
  [1.255528, -0.076749, -0.178779],
  [-0.078411, 0.930809, 0.147602],
  [0.004733, 0.691367, 0.3039],
];

function apply(m: Matrix, r: number, g: number, b: number): [number, number, number] {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

function simulate(r: number, g: number, b: number, type: Cvd): [number, number, number] {
  if (type === 'achromatopsia') {
    const lr = toLinear(r / 255.0);
    const lg = toLinear(g / 255.0);
    const lb = toLinear(b / 255.0);
    const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const v = toByte(toSrgb(y));
    return [v, v, v];
  }

  let matrix: Matrix;
  let blend: number; // 0 = full dichromat, 0.5 = anomalous
  switch (type) {
    case 'protanopia':
      matrix = PROTAN;
      blend = 0.0;
      break;
    case 'protanomaly':
      matrix = PROTAN;
      blend = 0.5;
      break;
    case 'deuteranopia':
      matrix = DEUTAN;
      blend = 0.0;
      break;
    case 'deuteranomaly':
      matrix = DEUTAN;
      blend = 0.5;
      break;
    case 'tritanopia':
      matrix = TRITAN;
      blend = 0.0;
      break;
    case 'tritanomaly':
      matrix = TRITAN;
      blend = 0.5;
      break;
    default:
      return [r, g, b];
  }

  const slr = toLinear(r / 255.0);
  const slg = toLinear(g / 255.0);
  const slb = toLinear(b / 255.0);
  let [dr, dg, db] = apply(matrix, slr, slg, slb);

  if (blend > 0.0) {
    dr = slr * blend + dr * (1.0 - blend);
    dg = slg * blend + dg * (1.0 - blend);
    db = slb * blend + db * (1.0 - blend);
  }

  return [toByte(toSrgb(dr)), toByte(toSrgb(dg)), toByte(toSrgb(db))];
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s);

// Port of ColorBlindService.TryParse: "#RGB", "#RRGGBB", "rgb(r,g,b)", "r,g,b".
function tryParse(text: string): [number, number, number] | null {
  if (!text || !text.trim()) return null;
  let s = text.trim();

  if (s.toLowerCase().startsWith('rgb')) {
    const lp = s.indexOf('(');
    const rp = s.indexOf(')');
    if (lp < 0 || rp < lp) return null;
    s = s.substring(lp + 1, rp);
  }

  if (s.startsWith('#')) s = s.substring(1);

  if (s.length === 6 && isHex(s)) {
    return [parseInt(s.substring(0, 2), 16), parseInt(s.substring(2, 4), 16), parseInt(s.substring(4, 6), 16)];
  }
  if (s.length === 3 && isHex(s)) {
    const c0 = s[0]!;
    const c1 = s[1]!;
    const c2 = s[2]!;
    return [parseInt(c0 + c0, 16), parseInt(c1 + c1, 16), parseInt(c2 + c2, 16)];
  }

  const parts = s.split(/[,;\s\t]+/).filter((p) => p.length > 0);
  if (parts.length === 3) {
    const ri = Number(parts[0]);
    const gi = Number(parts[1]);
    const bi = Number(parts[2]);
    if (Number.isInteger(ri) && Number.isInteger(gi) && Number.isInteger(bi)) {
      const cl = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);
      return [cl(ri), cl(gi), cl(bi)];
    }
  }
  return null;
}

const TYPES: { type: Cvd; key: string }[] = [
  { type: 'protanopia', key: 'protanopia' },
  { type: 'protanomaly', key: 'protanomaly' },
  { type: 'deuteranopia', key: 'deuteranopia' },
  { type: 'deuteranomaly', key: 'deuteranomaly' },
  { type: 'tritanopia', key: 'tritanopia' },
  { type: 'tritanomaly', key: 'tritanomaly' },
  { type: 'achromatopsia', key: 'achromatopsia' },
];

export function ColorBlindModule() {
  const { t } = useTranslation();
  const [rgb, setRgb] = useState<[number, number, number]>([0x4c, 0xaf, 0x50]);
  const [input, setInput] = useState('#4CAF50');
  const [status, setStatus] = useState('');

  const [r, g, b] = rgb;
  const baseHex = toHex(r, g, b);

  const rows = useMemo(
    () =>
      TYPES.map(({ type, key }) => {
        const [sr, sg, sb] = simulate(r, g, b, type);
        return { key, hex: toHex(sr, sg, sb), css: `rgb(${sr},${sg},${sb})` };
      }),
    [r, g, b],
  );

  const applyColor = () => {
    const parsed = tryParse(input);
    if (parsed) {
      setRgb(parsed);
      setInput(toHex(parsed[0], parsed[1], parsed[2]));
      setStatus(t('colorblind.simulating', { hex: toHex(parsed[0], parsed[1], parsed[2]) }));
    } else {
      setStatus(t('colorblind.badColor'));
    }
  };

  const randomColor = () => {
    const nr = Math.floor(Math.random() * 256);
    const ng = Math.floor(Math.random() * 256);
    const nb = Math.floor(Math.random() * 256);
    setRgb([nr, ng, nb]);
    setInput(toHex(nr, ng, nb));
    setStatus(t('colorblind.simulating', { hex: toHex(nr, ng, nb) }));
  };

  const setChannel = (i: 0 | 1 | 2, val: number) => {
    const v = Math.max(0, Math.min(255, Math.round(val)));
    const next: [number, number, number] = [...rgb];
    next[i] = v;
    setRgb(next);
    setInput(toHex(next[0], next[1], next[2]));
    setStatus(t('colorblind.simulating', { hex: toHex(next[0], next[1], next[2]) }));
  };

  const copy = (hex: string) => {
    try {
      void navigator.clipboard?.writeText(hex);
      setStatus(t('colorblind.copied', { hex }));
    } catch {
      setStatus(t('colorblind.copyFail'));
    }
  };

  const channels: { label: string; idx: 0 | 1 | 2; value: number }[] = [
    { label: 'R', idx: 0, value: r },
    { label: 'G', idx: 1, value: g },
    { label: 'B', idx: 2, value: b },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colorblind.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('colorblind.inputLabel')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 180 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyColor();
          }}
        />
        <button className="mini primary" onClick={applyColor}>
          {t('colorblind.apply')}
        </button>
        <button className="mini" onClick={randomColor}>
          {t('colorblind.random')}
        </button>
      </div>

      <div className="kv-list" style={{ marginTop: 12, maxWidth: 480 }}>
        {channels.map((ch) => (
          <div key={ch.label} className="kv-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 18, fontFamily: 'monospace' }}>{ch.label}</span>
            <input
              type="range"
              min={0}
              max={255}
              value={ch.value}
              onChange={(e) => setChannel(ch.idx, +e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ width: 34, textAlign: 'right', fontFamily: 'monospace' }}>{ch.value}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 8,
            background: baseHex,
            border: '1px solid var(--border, #444)',
          }}
        />
        <div>
          <div style={{ fontWeight: 600 }}>{t('colorblind.original')}</div>
          <div style={{ fontFamily: 'monospace', opacity: 0.8 }}>{baseHex}</div>
        </div>
      </div>

      {status && (
        <p className="count-note" style={{ marginTop: 10 }}>
          {status}
        </p>
      )}

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row) => (
          <div
            key={row.key}
            className="kv-row"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 8,
                background: row.css,
                border: '1px solid var(--border, #444)',
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t(`colorblind.${row.key}`)}</div>
              <div style={{ fontFamily: 'monospace', opacity: 0.8 }}>{row.hex}</div>
            </div>
            <button className="mini" onClick={() => copy(row.hex)}>
              {t('colorblind.copy')}
            </button>
          </div>
        ))}
      </div>

      <p className="count-note" style={{ marginTop: 14 }}>
        {t('colorblind.note')}
      </p>
    </div>
  );
}
