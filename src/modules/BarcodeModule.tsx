import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 條碼產生器 · 1D barcode generator — Code 128 (auto B/C + checksum), Code 39
// (start/stop *) and EAN-13 (guards, parity, mod-10 check). Encoders are
// hand-rolled (no deps), mirroring WinForge's BarcodeService. Draws bars live as
// SVG, copies the SVG or downloads it as a .svg file.

const MODULE_WIDTH = 2; // narrow-module width in px
const BAR_HEIGHT = 90;

type Sym = 'code128' | 'code39' | 'ean13';

// Error identity: a translation key plus optional interpolation values, so the
// UI renders the message in the active language (mirroring WinForge's bilingual
// BarcodeResult.ErrorEn/ErrorZh).
interface BarcodeError {
  key: string;
  vars?: Record<string, number>;
}

interface BarcodeResult {
  ok: boolean;
  error?: BarcodeError;
  modules: boolean[]; // true = bar (black), false = space
  humanText: string;
  sym: Sym;
}

function fail(key: string, vars?: Record<string, number>): BarcodeResult {
  return { ok: false, error: { key, vars }, modules: [], humanText: '', sym: 'code128' };
}

// ===== shared bit helpers =====
function addRunLengths(bits: boolean[], runs: string): void {
  // runs = alternating bar,space,bar,... widths as decimal chars, starting with a bar.
  let bar = true;
  for (const ch of runs) {
    const w = ch.charCodeAt(0) - 48;
    for (let i = 0; i < w; i++) bits.push(bar);
    bar = !bar;
  }
}
function addBitString(bits: boolean[], s: string): void {
  for (const ch of s) bits.push(ch === '1');
}
function addQuiet(bits: boolean[], modules: number): void {
  for (let i = 0; i < modules; i++) bits.push(false);
}

// ===================================================================================================
//  CODE 128 (code sets B and C, auto-switched; Start + checksum + Stop)
// ===================================================================================================
const C128: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const C128_START_B = 104;
const C128_START_C = 105;
const C128_STOP = 106;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function startWithC(s: string, pos: number): boolean {
  // Enter code set C when at least four consecutive digits begin at pos.
  let run = 0;
  for (let i = pos; i < s.length && isDigit(s[i]!); i++) run++;
  return run >= 4;
}

function encodeCode128(input: string): BarcodeResult {
  if (!input) return fail('errEmpty128');
  for (const c of input) {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) return fail('errAscii128');
  }

  const codes: number[] = [];
  let pos = 0;
  let inC = startWithC(input, 0);
  const startCode = inC ? C128_START_C : C128_START_B;
  codes.push(startCode);

  while (pos < input.length) {
    if (inC) {
      if (pos + 1 < input.length && isDigit(input[pos]!) && isDigit(input[pos + 1]!)) {
        const pair = (input.charCodeAt(pos) - 48) * 10 + (input.charCodeAt(pos + 1) - 48);
        codes.push(pair);
        pos += 2;
        // Stay in C while another full digit-pair remains; else drop to B.
        if (!(pos + 1 < input.length && isDigit(input[pos]!) && isDigit(input[pos + 1]!))) {
          if (pos < input.length) {
            codes.push(100); // Code B
            inC = false;
          }
        }
      } else {
        codes.push(100); // switch to B
        inC = false;
      }
    } else {
      // Consider switching up to C if a long digit run starts here.
      if (startWithC(input, pos)) {
        codes.push(99); // Code C
        inC = true;
        continue;
      }
      codes.push(input.charCodeAt(pos) - 32); // Code set B value
      pos++;
    }
  }

  // Checksum: start + sum(i * value_i) mod 103.
  let sum = startCode;
  for (let i = 1; i < codes.length; i++) sum += i * codes[i]!;
  const check = sum % 103;
  codes.push(check);
  codes.push(C128_STOP);

  const bits: boolean[] = [];
  addQuiet(bits, 10);
  for (const v of codes) addRunLengths(bits, C128[v]!);
  addQuiet(bits, 10);

  return { ok: true, modules: bits, humanText: input, sym: 'code128' };
}

// ===================================================================================================
//  CODE 39 (start/stop *, 43 data chars, no check digit)
// ===================================================================================================
const C39_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
const C39: string[] = [
  'nnnwwnwnn', 'wnnwnnnnw', 'nnwwnnnnw', 'wnwwnnnnn', 'nnnwwnnnw', // 0-4
  'wnnwwnnnn', 'nnwwwnnnn', 'nnnwnnwnw', 'wnnwnnwnn', 'nnwwnnwnn', // 5-9
  'wnnnnwnnw', 'nnwnnwnnw', 'wnwnnwnnn', 'nnnnwwnnw', 'wnnnwwnnn', // A-E
  'nnwnwwnnn', 'nnnnnwwnw', 'wnnnnwwnn', 'nnwnnwwnn', 'nnnnwwwnn', // F-J
  'wnnnnnnww', 'nnwnnnnww', 'wnwnnnnwn', 'nnnnwnnww', 'wnnnwnnwn', // K-O
  'nnwnwnnwn', 'nnnnnnwww', 'wnnnnnwwn', 'nnwnnnwwn', 'nnnnwnwwn', // P-T
  'wwnnnnnnw', 'nwwnnnnnw', 'wwwnnnnnn', 'nwnnwnnnw', 'wwnnwnnnn', // U-Y
  'nwwnwnnnn', 'nwnnnnwnw', 'wwnnnnwnn', 'nwwnnnwnn', 'nwnnwnwnn', // Z - . space $
  'nwnwnwnnn', 'nwnwnnnwn', 'nwnnnwnwn', 'nnnwnwnwn',               // / + % *
];

function addC39Char(bits: boolean[], c: string): void {
  const idx = C39_ALPHABET.indexOf(c);
  if (idx < 0) return;
  const pat = C39[idx]!;
  let bar = true; // patterns are bar-first, alternating
  for (const w of pat) {
    const width = w === 'w' ? 3 : 1;
    for (let i = 0; i < width; i++) bits.push(bar);
    bar = !bar;
  }
}

function encodeCode39(input: string): BarcodeResult {
  if (!input) return fail('errEmpty39');
  const upper = input.toUpperCase();
  for (const c of upper) {
    if (c === '*') return fail('errStar39');
    if (C39_ALPHABET.indexOf(c) < 0) return fail('errChars39');
  }

  const bits: boolean[] = [];
  addQuiet(bits, 10);
  addC39Char(bits, '*');
  bits.push(false); // narrow inter-character gap
  for (const c of upper) {
    addC39Char(bits, c);
    bits.push(false);
  }
  addC39Char(bits, '*');
  addQuiet(bits, 10);

  return { ok: true, modules: bits, humanText: '*' + upper + '*', sym: 'code39' };
}

// ===================================================================================================
//  EAN-13 (12 data digits + mod-10 check, left/right guards, L/G parity per first digit)
// ===================================================================================================
const EAN_L: string[] = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];
const EAN_G: string[] = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
];
const EAN_R: string[] = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
];
const EAN_PARITY: string[] = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

function ean13Check(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

function encodeEan13(input: string): BarcodeResult {
  let digits = (input || '').split('').filter(isDigit).join('');
  if (digits.length !== 12 && digits.length !== 13) return fail('errDigitsEan');

  if (digits.length === 13) {
    const expected = ean13Check(digits.substring(0, 12));
    if (digits.charCodeAt(12) - 48 !== expected) return fail('errCheckEan', { d: expected });
  } else {
    digits += String.fromCharCode(48 + ean13Check(digits));
  }

  const first = digits.charCodeAt(0) - 48;
  const parity = EAN_PARITY[first]!;

  const bits: boolean[] = [];
  addQuiet(bits, 9);
  addBitString(bits, '101'); // left guard
  for (let i = 0; i < 6; i++) {
    const d = digits.charCodeAt(1 + i) - 48;
    addBitString(bits, parity[i] === 'L' ? EAN_L[d]! : EAN_G[d]!);
  }
  addBitString(bits, '01010'); // center guard
  for (let i = 0; i < 6; i++) {
    const d = digits.charCodeAt(7 + i) - 48;
    addBitString(bits, EAN_R[d]!);
  }
  addBitString(bits, '101'); // right guard
  addQuiet(bits, 9);

  return { ok: true, modules: bits, humanText: digits, sym: 'ean13' };
}

function encode(sym: Sym, input: string): BarcodeResult {
  try {
    input = input || '';
    if (sym === 'code39') return encodeCode39(input);
    if (sym === 'ean13') return encodeEan13(input);
    return encodeCode128(input);
  } catch {
    return fail('errGeneric');
  }
}

// ===== SVG (self-contained, copyable, savable) =====
function fmt(d: number): string {
  return Number(d.toFixed(3)).toString();
}
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toSvg(r: BarcodeResult, moduleWidth: number, barHeight: number, showText: boolean): string {
  if (!r.ok || r.modules.length === 0)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

  const n = r.modules.length;
  const textH = showText && r.humanText ? 22 : 0;
  const w = n * moduleWidth;
  const h = barHeight + textH + 8;

  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n`;
  out += `  <rect width="${fmt(w)}" height="${fmt(h)}" fill="#ffffff"/>\n`;

  let i = 0;
  while (i < n) {
    if (r.modules[i]) {
      const start = i;
      while (i < n && r.modules[i]) i++;
      const x = start * moduleWidth;
      const rw = (i - start) * moduleWidth;
      out += `  <rect x="${fmt(x)}" y="0" width="${fmt(rw)}" height="${fmt(barHeight)}" fill="#000000"/>\n`;
    } else i++;
  }

  if (textH > 0) {
    out += `  <text x="${fmt(w / 2)}" y="${fmt(barHeight + textH)}" font-family="Consolas,monospace" font-size="18" text-anchor="middle" fill="#000000">${escapeXml(r.humanText)}</text>\n`;
  }
  out += '</svg>\n';
  return out;
}

// Coalesce consecutive bar-modules into <rect> runs for the live preview.
function barRects(mods: boolean[], moduleWidth: number): { x: number; w: number }[] {
  const rects: { x: number; w: number }[] = [];
  const n = mods.length;
  let i = 0;
  while (i < n) {
    if (mods[i]) {
      const start = i;
      while (i < n && mods[i]) i++;
      rects.push({ x: start * moduleWidth, w: (i - start) * moduleWidth });
    } else i++;
  }
  return rects;
}

export function BarcodeModule() {
  const { t } = useTranslation();
  const [sym, setSym] = useState<Sym>('code128');
  const [input, setInput] = useState('WinForge-128');
  const [showText, setShowText] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const result = useMemo(() => encode(sym, input), [sym, input]);
  const svg = useMemo(
    () => (result.ok ? toSvg(result, MODULE_WIDTH, BAR_HEIGHT, showText) : ''),
    [result, showText],
  );

  const hint =
    sym === 'code39'
      ? t('barcode.hintCode39')
      : sym === 'ean13'
        ? t('barcode.hintEan13')
        : t('barcode.hintCode128');

  const totalW = result.ok ? result.modules.length * MODULE_WIDTH : 0;
  const textH = showText && result.humanText ? 24 : 0;
  const rects = result.ok ? barRects(result.modules, MODULE_WIDTH) : [];

  const copySvg = () => {
    if (!svg) return;
    navigator.clipboard
      ?.writeText(svg)
      .then(() => setMsg({ ok: true, text: t('barcode.svgCopied') }))
      .catch(() => setMsg({ ok: false, text: t('barcode.copyFailed') }));
  };

  const saveSvg = () => {
    if (!svg) return;
    try {
      const name = sym === 'code39' ? 'code39.svg' : sym === 'ean13' ? 'ean13.svg' : 'code128.svg';
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text: t('barcode.saved') });
    } catch {
      setMsg({ ok: false, text: t('barcode.saveFailed') });
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('barcode.blurb')}</p>

      <div className="mod-toolbar">
        <label className="chk" style={{ gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{t('barcode.symbology')}</span>
          <select
            className="mod-select"
            value={sym}
            onChange={(e) => setSym(e.target.value as Sym)}
          >
            <option value="code128">Code 128</option>
            <option value="code39">Code 39</option>
            <option value="ean13">EAN-13</option>
          </select>
        </label>
        <label className="chk">
          <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} />
          {t('barcode.showText')}
        </label>
      </div>

      <div style={{ marginTop: 4 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('barcode.data')}</div>
        <input
          className="mod-search"
          style={{ maxWidth: 420, width: '100%' }}
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('barcode.data')}
        />
        <p className="count-note" style={{ marginTop: 6 }}>{hint}</p>
      </div>

      {!result.ok && result.error && (
        <p style={{ marginTop: 6, color: 'var(--danger)', fontSize: 12.5 }}>
          {t(`barcode.${result.error.key}`, result.error.vars)}
        </p>
      )}

      {result.ok && (
        <div
          style={{
            marginTop: 12,
            padding: 16,
            background: '#ffffff',
            border: '1px solid var(--border, #ccc)',
            borderRadius: 8,
            overflowX: 'auto',
          }}
        >
          <svg
            width={totalW}
            height={BAR_HEIGHT + textH}
            viewBox={`0 0 ${totalW} ${BAR_HEIGHT + textH}`}
            style={{ display: 'block', margin: '0 auto' }}
            xmlns="http://www.w3.org/2000/svg"
          >
            {rects.map((rc, i) => (
              <rect key={i} x={rc.x} y={0} width={rc.w} height={BAR_HEIGHT} fill="#000000" />
            ))}
            {textH > 0 && (
              <text
                x={totalW / 2}
                y={BAR_HEIGHT + 18}
                fontFamily="Consolas,monospace"
                fontSize={16}
                textAnchor="middle"
                fill="#000000"
              >
                {result.humanText}
              </text>
            )}
          </svg>
        </div>
      )}

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <button className="mini" disabled={!result.ok} onClick={copySvg}>
          {t('barcode.copySvg')}
        </button>
        <button className="mini primary" disabled={!result.ok} onClick={saveSvg}>
          {t('barcode.saveSvg')}
        </button>
        {msg && (
          <span
            className={msg.ok ? 'count-note' : ''}
            style={msg.ok ? undefined : { color: 'var(--danger)', fontSize: 12.5 }}
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
