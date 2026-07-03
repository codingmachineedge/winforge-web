import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const MIN_BASE = 2;
const MAX_BASE = 36;

function digitValue(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 122) return code - 97 + 10; // a-z
  if (code >= 65 && code <= 90) return code - 65 + 10; // A-Z
  return -1;
}

// Parse a signed integer in radix (2-36). Grouping via spaces/underscores allowed.
function tryParse(text: string | null | undefined, radix: number): { ok: boolean; value: bigint } {
  if (radix < MIN_BASE || radix > MAX_BASE) return { ok: false, value: 0n };
  if (!text || !text.trim()) return { ok: false, value: 0n };

  const t = text.trim();
  let negative = false;
  let i = 0;
  const first = t[0]!;
  if (first === '+' || first === '-') {
    negative = first === '-';
    i = 1;
  }

  let sawDigit = false;
  let big = 0n;
  const b = BigInt(radix);
  for (; i < t.length; i++) {
    const c = t[i]!;
    if (c === '_' || c === ' ') continue;
    const digit = digitValue(c);
    if (digit < 0 || digit >= radix) return { ok: false, value: 0n };
    big = big * b + BigInt(digit);
    sawDigit = true;
  }

  if (!sawDigit) return { ok: false, value: 0n };
  return { ok: true, value: negative ? -big : big };
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

// Render value in radix (2-36), lowercase, no prefix.
function toBase(value: bigint, radix: number): string {
  if (radix < MIN_BASE || radix > MAX_BASE) return '';
  if (value === 0n) return '0';

  const negative = value < 0n;
  let n = absBig(value);
  const b = BigInt(radix);
  let out = '';
  while (n > 0n) {
    const d = Number(n % b);
    out = String.fromCharCode(d < 10 ? 48 + d : 97 + (d - 10)) + out;
    n = n / b;
  }
  return negative ? '-' + out : out;
}

function toGroupedBinary(value: bigint): string {
  const negative = value < 0n;
  let bits = toBase(absBig(value), 2);
  const pad = (4 - (bits.length % 4)) % 4;
  if (pad > 0) bits = '0'.repeat(pad) + bits;

  let out = '';
  for (let i = 0; i < bits.length; i++) {
    if (i > 0 && i % 4 === 0) out += ' ';
    out += bits[i]!;
  }
  return negative ? '-' + out : out;
}

function toHexPrefixed(value: bigint): string {
  if (value < 0n) return '-0x' + toBase(absBig(value), 16).toUpperCase();
  return '0x' + toBase(value, 16).toUpperCase();
}

function bitLength(value: bigint): number {
  let n = absBig(value);
  if (n === 0n) return 0;
  let bits = 0;
  while (n > 0n) {
    bits++;
    n >>= 1n;
  }
  return bits;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

function fitsIn64Bits(value: bigint): boolean {
  return value >= LONG_MIN && value <= LONG_MAX;
}

// Full 64-bit two's-complement binary, grouped into bytes.
function to64BitBinary(value: bigint): string {
  const mask = (1n << 64n) - 1n;
  const u = value & mask; // two's-complement wrap into 64 bits
  let out = '';
  for (let bit = 63; bit >= 0; bit--) {
    out += ((u >> BigInt(bit)) & 1n) === 1n ? '1' : '0';
    if (bit % 8 === 0 && bit !== 0) out += ' ';
  }
  return out;
}

// Parse a bitwise operand: plain decimal, or a 0x-prefixed hex literal.
function tryParseOperand(text: string | null | undefined): { ok: boolean; value: bigint } {
  if (!text || !text.trim()) return { ok: false, value: 0n };
  let t = text.trim();

  let negative = false;
  if (t.startsWith('+')) t = t.slice(1);
  else if (t.startsWith('-')) {
    negative = true;
    t = t.slice(1);
  }

  if (t.slice(0, 2).toLowerCase() === '0x') {
    const hex = tryParse(t.slice(2), 16);
    if (!hex.ok) return { ok: false, value: 0n };
    return { ok: true, value: negative ? -hex.value : hex.value };
  }

  const dec = tryParse(t, 10);
  if (!dec.ok) return { ok: false, value: 0n };
  return { ok: true, value: negative ? -dec.value : dec.value };
}

type BitOp = 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'lshift' | 'rshift';

function evaluate(op: BitOp, a: bigint, b: bigint, shift: number): bigint {
  const s = shift < 0 ? 0 : shift;
  switch (op) {
    case 'and':
      return a & b;
    case 'or':
      return a | b;
    case 'xor':
      return a ^ b;
    case 'nand':
      return ~(a & b);
    case 'nor':
      return ~(a | b);
    case 'lshift':
      return a << BigInt(s);
    case 'rshift':
      return a >> BigInt(s);
    default:
      return 0n;
  }
}

type BaseSel = '2' | '8' | '10' | '16' | 'custom';

function selToRadix(sel: BaseSel, custom: number): number {
  switch (sel) {
    case '2':
      return 2;
    case '8':
      return 8;
    case '10':
      return 10;
    case '16':
      return 16;
    default:
      return custom;
  }
}

export function BaseConvertModule() {
  const { t } = useTranslation();

  // Converter state
  const [baseSel, setBaseSel] = useState<BaseSel>('10');
  const [customBase, setCustomBase] = useState(36);
  const [value, setValue] = useState('255');
  const [copied, setCopied] = useState('');

  // Bitwise state
  const [operandA, setOperandA] = useState('0xF0');
  const [operandB, setOperandB] = useState('0x0F');
  const [op, setOp] = useState<BitOp>('and');
  const [shift, setShift] = useState(1);

  const radix = selToRadix(baseSel, customBase);

  const conv = useMemo(() => {
    if (!value.trim()) {
      return { status: t('baseconvert.enterValue'), ok: false as const };
    }
    const parsed = tryParse(value, radix);
    if (!parsed.ok) {
      return {
        status: t('baseconvert.invalid', { value: value.trim(), radix }),
        ok: false as const,
      };
    }
    const v = parsed.value;
    const bits = bitLength(v);
    const fits = fitsIn64Bits(v);
    return {
      ok: true as const,
      status: t('baseconvert.parsedAs', { radix }),
      bin: toGroupedBinary(v),
      oct: toBase(v, 8),
      dec: v.toString(),
      hex: toHexPrefixed(v),
      custom: toBase(v, radix),
      bitLength: bits,
      fits,
      bin64: fits ? to64BitBinary(v) : '',
    };
  }, [value, radix, t]);

  const isShift = op === 'lshift' || op === 'rshift';

  const bitwise = useMemo(() => {
    const pa = tryParseOperand(operandA);
    if (!pa.ok) return { text: t('baseconvert.operandABad') };
    let b = 0n;
    if (!isShift) {
      const pb = tryParseOperand(operandB);
      if (!pb.ok) return { text: t('baseconvert.operandBBad') };
      b = pb.value;
    }
    const sh = isShift ? (shift < 0 ? 0 : shift) : 0;
    const result = evaluate(op, pa.value, b, sh);
    return { text: `${result}  ·  ${toHexPrefixed(result)}` };
  }, [operandA, operandB, op, shift, isShift, t]);

  const doCopy = (text: string, tag: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text);
    setCopied(tag);
  };

  const copyLabel = t('baseconvert.copy');

  const outputRow = (label: string, text: string, tag: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="mod-search" style={{ flex: 1, fontFamily: 'Consolas, monospace' }} readOnly value={text} />
        <button className="mini" onClick={() => doCopy(text, tag)}>
          {copyLabel}
        </button>
      </div>
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('baseconvert.blurb')}
      </p>

      {/* Input card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('baseconvert.input')}
        </h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <select className="mod-select" value={baseSel} onChange={(e) => setBaseSel(e.target.value as BaseSel)}>
            <option value="2">{t('baseconvert.binary')}</option>
            <option value="8">{t('baseconvert.octal')}</option>
            <option value="10">{t('baseconvert.decimal')}</option>
            <option value="16">{t('baseconvert.hex')}</option>
            <option value="custom">{t('baseconvert.customBaseOpt')}</option>
          </select>
        </div>
        {baseSel === 'custom' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('baseconvert.customBaseLabel')}
            </span>
            <input
              className="mod-search"
              type="number"
              min={MIN_BASE}
              max={MAX_BASE}
              style={{ maxWidth: 120 }}
              value={customBase}
              onChange={(e) => setCustomBase(Math.max(MIN_BASE, Math.min(MAX_BASE, Math.trunc(+e.target.value) || MAX_BASE)))}
            />
          </div>
        )}
        <span className="count-note" style={{ margin: 0 }}>
          {conv.status}
        </span>
      </div>

      {/* Outputs card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('baseconvert.outputs')}
        </h3>
        {outputRow(t('baseconvert.binLabel'), conv.ok ? conv.bin : '', 'bin')}
        {outputRow(t('baseconvert.octLabel'), conv.ok ? conv.oct : '', 'oct')}
        {outputRow(t('baseconvert.decLabel'), conv.ok ? conv.dec : '', 'dec')}
        {outputRow(t('baseconvert.hexLabel'), conv.ok ? conv.hex : '', 'hex')}
        {outputRow(t('baseconvert.customOutLabel', { radix }), conv.ok ? conv.custom : '', 'custom')}
        {copied && <span className="count-note" style={{ margin: 0 }}>{t('baseconvert.copied')}</span>}
      </div>

      {/* Bit info card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('baseconvert.bitInfo')}
        </h3>
        {conv.ok && (
          <>
            <span className="count-note" style={{ margin: 0 }}>
              {t('baseconvert.bitLength', { bits: conv.bitLength })}
            </span>
            {conv.fits ? (
              <>
                <span className="count-note" style={{ margin: 0 }}>
                  {t('baseconvert.bit64Label')}
                </span>
                <input className="mod-search" style={{ fontFamily: 'Consolas, monospace' }} readOnly value={conv.bin64} />
              </>
            ) : (
              <span className="count-note" style={{ margin: 0 }}>
                {t('baseconvert.exceeds64')}
              </span>
            )}
          </>
        )}
      </div>

      {/* Bitwise card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('baseconvert.bitwiseTitle')}
        </h3>
        <span className="count-note" style={{ margin: 0 }}>
          {t('baseconvert.bitwiseBlurb')}
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
            value={operandA}
            onChange={(e) => setOperandA(e.target.value)}
          />
          <select className="mod-select" value={op} onChange={(e) => setOp(e.target.value as BitOp)}>
            <option value="and">AND</option>
            <option value="or">OR</option>
            <option value="xor">XOR</option>
            <option value="nand">NAND</option>
            <option value="nor">NOR</option>
            <option value="lshift">{t('baseconvert.leftShift')}</option>
            <option value="rshift">{t('baseconvert.rightShift')}</option>
          </select>
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
            value={operandB}
            disabled={isShift}
            onChange={(e) => setOperandB(e.target.value)}
          />
        </div>
        {isShift && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('baseconvert.shiftLabel')}
            </span>
            <input
              className="mod-search"
              type="number"
              min={0}
              max={4096}
              style={{ maxWidth: 120 }}
              value={shift}
              onChange={(e) => setShift(Math.max(0, Math.min(4096, Math.trunc(+e.target.value) || 0)))}
            />
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('baseconvert.resultLabel')}
          </span>
          <span style={{ fontFamily: 'Consolas, monospace', fontSize: 14, userSelect: 'text', wordBreak: 'break-all' }}>
            {bitwise.text}
          </span>
        </div>
      </div>
    </div>
  );
}
