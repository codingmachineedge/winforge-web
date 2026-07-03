import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- Rgb -------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexOf(c: Rgb): string {
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- Parsing ---------------------------------------------------------------

function isHexDigit(c: string): boolean {
  return /^[0-9a-fA-F]$/.test(c);
}
function hexVal(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 97 + 10;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 65 + 10;
  return NaN;
}
function looksLikeBareHex(s: string): boolean {
  if (![3, 4, 6, 8].includes(s.length)) return false;
  for (const c of s) if (!isHexDigit(c)) return false;
  return true;
}
function byteFromComponent(pRaw: string): number | null {
  const p = pRaw.trim();
  if (p.endsWith('%')) {
    const pct = Number.parseFloat(p.slice(0, -1));
    if (Number.isFinite(pct)) return clampByte(Math.round((pct / 100) * 255));
    return null;
  }
  const d = Number.parseFloat(p);
  if (Number.isFinite(d)) return clampByte(Math.round(d));
  return null;
}
function tryParseHex(hIn: string): Rgb | null {
  const h = hIn.trim();
  if (h.length === 3 || h.length === 4) {
    const r = hexVal(h[0]!) * 17;
    const g = hexVal(h[1]!) * 17;
    const b = hexVal(h[2]!) * 17;
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  if (h.length === 6 || h.length === 8) {
    const r = (hexVal(h[0]!) << 4) | hexVal(h[1]!);
    const g = (hexVal(h[2]!) << 4) | hexVal(h[3]!);
    const b = (hexVal(h[4]!) << 4) | hexVal(h[5]!);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  return null;
}

/** Parse "#hex" (3/4/6/8), "rgb(r,g,b)" or "r,g,b" / "r g b". Returns null, never throws. */
function tryParse(text: string): Rgb | null {
  if (!text || !text.trim()) return null;
  try {
    let s = text.trim();
    const lp = s.indexOf('(');
    const rp = s.indexOf(')');
    if (lp >= 0 && rp > lp) s = s.substring(lp + 1, rp);

    if (s.startsWith('#') || looksLikeBareHex(s)) return tryParseHex(s.replace(/^#+/, ''));

    const parts = s.split(/[,\s\t;/]+/).filter((x) => x.length > 0);
    if (parts.length >= 3) {
      const r = byteFromComponent(parts[0]!);
      const g = byteFromComponent(parts[1]!);
      const b = byteFromComponent(parts[2]!);
      if (r !== null && g !== null && b !== null) return { r, g, b };
    }
  } catch {
    /* never throw */
  }
  return null;
}

// ---- HSL conversion --------------------------------------------------------

function toHsl(c: Rgb): [number, number, number] {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s: number;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) {
    s = 0;
    h = 0;
  } else {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function fromHsl(hIn: number, sIn: number, lIn: number): Rgb {
  const h = (((hIn % 360) + 360) % 360);
  const s = clamp01(sIn);
  const l = clamp01(lIn);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1: number, g1: number, b1: number;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return {
    r: clampByte(Math.round((r1 + m) * 255)),
    g: clampByte(Math.round((g1 + m) * 255)),
    b: clampByte(Math.round((b1 + m) * 255)),
  };
}

// ---- Scheme generation -----------------------------------------------------

type Scheme =
  | 'complementary'
  | 'analogous'
  | 'triadic'
  | 'tetradic'
  | 'splitComplementary'
  | 'monochromatic'
  | 'shades'
  | 'tints';

function generate(base: Rgb, scheme: Scheme): Rgb[] {
  const list: Rgb[] = [];
  try {
    const [h, s, l] = toHsl(base);
    switch (scheme) {
      case 'complementary':
        list.push(base, fromHsl(h + 180, s, l));
        break;
      case 'analogous':
        list.push(fromHsl(h - 30, s, l), base, fromHsl(h + 30, s, l), fromHsl(h + 60, s, l));
        break;
      case 'triadic':
        list.push(base, fromHsl(h + 120, s, l), fromHsl(h + 240, s, l));
        break;
      case 'tetradic':
        list.push(base, fromHsl(h + 90, s, l), fromHsl(h + 180, s, l), fromHsl(h + 270, s, l));
        break;
      case 'splitComplementary':
        list.push(base, fromHsl(h + 150, s, l), fromHsl(h + 210, s, l));
        break;
      case 'monochromatic':
        for (let i = 0; i < 5; i++) list.push(fromHsl(h, s, 0.15 + i * 0.175));
        break;
      case 'shades':
        for (let i = 0; i < 6; i++) list.push(fromHsl(h, s, l * (1 - i / 6)));
        break;
      case 'tints':
        for (let i = 0; i < 6; i++) list.push(fromHsl(h, s, l + (1 - l) * (i / 6)));
        break;
      default:
        list.push(base);
        break;
    }
  } catch {
    list.length = 0;
    list.push(base);
  }
  if (list.length === 0) list.push(base);
  return list;
}

function randomColor(): Rgb {
  const buf = new Uint8Array(3);
  (globalThis.crypto ?? window.crypto).getRandomValues(buf);
  return { r: buf[0]!, g: buf[1]!, b: buf[2]! };
}

function toCss(palette: Rgb[]): string {
  let out = ':root {\n';
  for (let i = 0; i < palette.length; i++) out += `  --c${i + 1}: ${hexOf(palette[i]!)};\n`;
  out += '}';
  return out;
}
function toJson(palette: Rgb[]): string {
  return `[${palette.map((c) => `"${hexOf(c)}"`).join(', ')}]`;
}

// ---- Component -------------------------------------------------------------

const SCHEMES: { id: Scheme; key: string }[] = [
  { id: 'complementary', key: 'schemeComplementary' },
  { id: 'analogous', key: 'schemeAnalogous' },
  { id: 'triadic', key: 'schemeTriadic' },
  { id: 'tetradic', key: 'schemeTetradic' },
  { id: 'splitComplementary', key: 'schemeSplitComplementary' },
  { id: 'monochromatic', key: 'schemeMonochromatic' },
  { id: 'shades', key: 'schemeShades' },
  { id: 'tints', key: 'schemeTints' },
];

export function ColorPaletteModule() {
  const { t } = useTranslation();
  const [baseText, setBaseText] = useState('#3EB489');
  const [base, setBase] = useState<Rgb>({ r: 0x3e, g: 0xb4, b: 0x89 });
  const [scheme, setScheme] = useState<Scheme>('complementary');
  const [status, setStatus] = useState('');

  const palette = useMemo(() => generate(base, scheme), [base, scheme]);

  const copy = (text: string, ok: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setStatus(ok);
    } catch {
      setStatus(t('colorpalette.clipboardFail'));
    }
  };

  const onBaseText = (v: string) => {
    setBaseText(v);
    const rgb = tryParse(v);
    if (rgb) {
      setBase(rgb);
      setStatus('');
    } else {
      setStatus(t('colorpalette.parseFail'));
    }
  };

  const onSlider = (chan: 'r' | 'g' | 'b', v: number) => {
    const next = { ...base, [chan]: clampByte(v) };
    setBase(next);
    setBaseText(hexOf(next));
    setStatus('');
  };

  const onRandom = () => {
    const c = randomColor();
    setBase(c);
    setBaseText(hexOf(c));
    setStatus('');
  };

  const swatchClick = (c: Rgb) => copy(hexOf(c), t('colorpalette.copiedHex', { hex: hexOf(c) }));

  const chanRow = (chan: 'r' | 'g' | 'b', label: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 20, fontWeight: 600 }}>{label}</span>
      <input
        type="range"
        min={0}
        max={255}
        value={base[chan]}
        style={{ width: 260 }}
        onChange={(e) => onSlider(chan, +e.target.value)}
      />
      <span className="count-note" style={{ width: 32 }}>
        {base[chan]}
      </span>
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colorpalette.blurb')}
      </p>

      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <span
          title={hexOf(base)}
          style={{
            width: 40,
            height: 40,
            borderRadius: 6,
            border: '1px solid var(--border, #444)',
            background: hexOf(base),
            display: 'inline-block',
            flex: '0 0 auto',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{t('colorpalette.baseLabel')}</span>
          <input
            className="mod-search"
            style={{ minWidth: 200 }}
            value={baseText}
            spellCheck={false}
            onChange={(e) => onBaseText(e.target.value)}
          />
        </div>
        <button className="mini" onClick={onRandom} style={{ alignSelf: 'flex-end' }}>
          {t('colorpalette.random')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {chanRow('r', 'R')}
        {chanRow('g', 'G')}
        {chanRow('b', 'B')}
      </div>

      <div className="mod-toolbar" style={{ marginTop: 10, alignItems: 'center' }}>
        <span className="count-note" style={{ margin: 0 }}>
          {t('colorpalette.scheme')}
        </span>
        <select
          className="mod-select"
          value={scheme}
          onChange={(e) => setScheme(e.target.value as Scheme)}
          style={{ minWidth: 220 }}
        >
          {SCHEMES.map((s) => (
            <option key={s.id} value={s.id}>
              {t(`colorpalette.${s.key}`)}
            </option>
          ))}
        </select>
      </div>

      <p className="count-note" style={{ marginTop: 8 }}>
        {status || t('colorpalette.countHint', { n: palette.length })}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {palette.map((c, i) => {
          const hex = hexOf(c);
          return (
            <div key={`${hex}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 88 }}>
              <div
                title={t('colorpalette.clickToCopy')}
                onClick={() => swatchClick(c)}
                style={{
                  width: 88,
                  height: 64,
                  borderRadius: 6,
                  border: '1px solid var(--border, #444)',
                  background: hex,
                  cursor: 'pointer',
                }}
              />
              <span style={{ fontSize: 12, textAlign: 'center' }}>{hex}</span>
            </div>
          );
        })}
      </div>

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <button className="mini" onClick={() => copy(toCss(palette), t('colorpalette.cssCopied'))}>
          {t('colorpalette.copyCss')}
        </button>
        <button className="mini" onClick={() => copy(toJson(palette), t('colorpalette.jsonCopied'))}>
          {t('colorpalette.copyJson')}
        </button>
      </div>
    </div>
  );
}
