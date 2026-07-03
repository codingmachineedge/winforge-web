import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Ascii85 / Base85 · pure-client port of WinForge's Ascii85Service (never throws;
// returns {ok,...} or {error}). Three variants — Adobe Ascii85, Z85 (ZeroMQ RFC 32),
// RFC 1924 (IPv6). Encode UTF-8 text or hex bytes; decode back to text + hex.

type Variant = 'adobe' | 'z85' | 'rfc1924';
type InputKind = 'utf8' | 'hex';

const Z85_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
const RFC1924_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

function buildDecode(alphabet: string): Int16Array {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) map[alphabet.charCodeAt(i)] = i;
  return map;
}
const Z85_DECODE = buildDecode(Z85_ALPHABET);
const RFC1924_DECODE = buildDecode(RFC1924_ALPHABET);

type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };
type TextResult = { ok: true; text: string } | { ok: false; error: string };

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 97 + 10; // a-f
  if (c >= 65 && c <= 70) return c - 65 + 10; // A-F
  return -1;
}

// --- bytes <-> input string ---
function inputToBytes(input: string, kind: InputKind): BytesResult {
  if (kind === 'utf8') return { ok: true, bytes: new TextEncoder().encode(input) };
  // Hex: strip whitespace, 0x prefixes and common separators.
  let hex = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (/\s/.test(ch) || ch === ':' || ch === '-' || ch === ',') continue;
    if ((ch === 'x' || ch === 'X') && hex.length > 0 && hex[hex.length - 1] === '0') {
      hex = hex.slice(0, -1);
      continue;
    }
    hex += ch;
  }
  if ((hex.length & 1) !== 0) return { ok: false, error: 'hexOdd' };
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = hexVal(hex.charCodeAt(i * 2));
    const lo = hexVal(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return { ok: false, error: 'hexBad' };
    bytes[i] = (hi << 4) | lo;
  }
  return { ok: true, bytes };
}

function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) parts.push(bytes[i]!.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(' ');
}

function bytesToUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

// --- encode ---
function encodeAdobe(data: Uint8Array, wrap: boolean, useZ: boolean): string {
  let out = wrap ? '<~' : '';
  let i = 0;
  while (i < data.length) {
    const n = Math.min(4, data.length - i);
    let tuple = 0;
    for (let k = 0; k < 4; k++) tuple = (tuple * 256 + (k < n ? data[i + k]! : 0)) >>> 0;
    if (n === 4 && useZ && tuple === 0) {
      out += 'z';
    } else {
      const five: string[] = new Array(5);
      let t = tuple;
      for (let k = 4; k >= 0; k--) {
        five[k] = String.fromCharCode(0x21 + (t % 85));
        t = Math.floor(t / 85);
      }
      out += five.slice(0, n + 1).join('');
    }
    i += 4;
  }
  if (wrap) out += '~>';
  return out;
}

function encodeZ85(data: Uint8Array): TextResult {
  if ((data.length & 3) !== 0) return { ok: false, error: 'z85Len' };
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    let tuple = ((data[i]! * 256 + data[i + 1]!) * 256 + data[i + 2]!) * 256 + data[i + 3]!;
    const five: string[] = new Array(5);
    for (let k = 4; k >= 0; k--) {
      five[k] = Z85_ALPHABET[tuple % 85]!;
      tuple = Math.floor(tuple / 85);
    }
    out += five.join('');
  }
  return { ok: true, text: out };
}

// Generic 4-byte -> 5-char big-endian encoder with tail padding (RFC 1924).
function encodeAlphabet(data: Uint8Array, alphabet: string): string {
  let out = '';
  let i = 0;
  while (i < data.length) {
    const n = Math.min(4, data.length - i);
    let tuple = 0;
    for (let k = 0; k < 4; k++) tuple = tuple * 256 + (k < n ? data[i + k]! : 0);
    const five: string[] = new Array(5);
    for (let k = 4; k >= 0; k--) {
      five[k] = alphabet[tuple % 85]!;
      tuple = Math.floor(tuple / 85);
    }
    out += five.slice(0, n + 1).join('');
    i += 4;
  }
  return out;
}

function encode(bytes: Uint8Array, variant: Variant, adobeWrap: boolean, adobeZ: boolean): TextResult {
  if (variant === 'adobe') return { ok: true, text: encodeAdobe(bytes, adobeWrap, adobeZ) };
  if (variant === 'z85') return encodeZ85(bytes);
  return { ok: true, text: encodeAlphabet(bytes, RFC1924_ALPHABET) };
}

// --- decode ---
function decodeAdobe(text: string): BytesResult {
  let start = 0;
  let end = text.length;
  const lt = text.indexOf('<~');
  if (lt >= 0) start = lt + 2;
  const gt = text.indexOf('~>', start);
  if (gt >= 0) end = gt;

  const outBytes: number[] = [];
  const group = new Array<number>(5);
  let count = 0;

  for (let idx = start; idx < end; idx++) {
    const c = text[idx]!;
    if (/\s/.test(c)) continue;
    if (c === 'z') {
      if (count !== 0) return { ok: false, error: 'zBoundary' };
      outBytes.push(0, 0, 0, 0);
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x21 || code > 0x75) return { ok: false, error: 'adobeRange' };
    group[count++] = code - 0x21;
    if (count === 5) {
      emitTuple(group, 5, outBytes);
      count = 0;
    }
  }

  if (count === 1) return { ok: false, error: 'adobeGroup1' };
  if (count > 0) {
    for (let k = count; k < 5; k++) group[k] = 84; // pad with 'u'
    emitTuple(group, count, outBytes);
  }
  return { ok: true, bytes: Uint8Array.from(outBytes) };
}

function emitTuple(group: number[], count: number, sink: number[]): void {
  let tuple = 0;
  for (let k = 0; k < 5; k++) tuple = tuple * 85 + group[k]!;
  tuple = tuple >>> 0;
  const bytesOut = count - 1; // full group -> 4 bytes; partial -> count-1
  const b = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
  for (let k = 0; k < bytesOut; k++) sink.push(b[k]!);
}

// Strict fixed-alphabet decoder: length must be a multiple of 5, every char in alphabet.
function decodeStrict(text: string, decode: Int16Array, label: string): BytesResult {
  let s = '';
  for (const c of text) if (!/\s/.test(c)) s += c;

  if (s.length % 5 !== 0) return { ok: false, error: `${label}|strictLen` };

  const outBytes = new Uint8Array((s.length / 5) * 4);
  let oi = 0;
  for (let i = 0; i < s.length; i += 5) {
    let tuple = 0;
    for (let k = 0; k < 5; k++) {
      const code = s.charCodeAt(i + k);
      const v = code < 128 ? decode[code]! : -1;
      if (v < 0) return { ok: false, error: `${label}|strictChar` };
      tuple = tuple * 85 + v;
    }
    if (tuple > 0xffffffff) return { ok: false, error: `${label}|strictOverflow` };
    outBytes[oi++] = (tuple / 0x1000000) & 0xff;
    outBytes[oi++] = (tuple / 0x10000) & 0xff;
    outBytes[oi++] = (tuple / 0x100) & 0xff;
    outBytes[oi++] = tuple & 0xff;
  }
  return { ok: true, bytes: outBytes };
}

function decode(text: string, variant: Variant): BytesResult {
  if (variant === 'adobe') return decodeAdobe(text);
  if (variant === 'z85') return decodeStrict(text, Z85_DECODE, 'Z85');
  return decodeStrict(text, RFC1924_DECODE, 'RFC 1924');
}

type Status = { sev: 'info' | 'success' | 'error' | 'warning'; msg: string };

export function Ascii85Module() {
  const { t } = useTranslation();

  const [variant, setVariant] = useState<Variant>('adobe');
  const [inputKind, setInputKind] = useState<InputKind>('utf8');
  const [wrap, setWrap] = useState(false);
  const [useZ, setUseZ] = useState(false);

  const [plain, setPlain] = useState('');
  const [encoded, setEncoded] = useState('');
  const [encodeInfo, setEncodeInfo] = useState('');

  const [cipher, setCipher] = useState('');
  const [decodedText, setDecodedText] = useState('');
  const [decodedHex, setDecodedHex] = useState('');
  const [decodeInfo, setDecodeInfo] = useState('');

  const [status, setStatus] = useState<Status>({ sev: 'info', msg: t('ascii85.ready') });

  // Map a service error code to a bilingual message.
  const errMsg = (code: string): string => {
    if (code.includes('|')) {
      const [label, key] = code.split('|');
      return t(`ascii85.${key}`, { label: label! });
    }
    return t(`ascii85.${code}`);
  };

  const onEncode = () => {
    try {
      const tb = inputToBytes(plain, inputKind);
      if (!tb.ok) {
        setEncoded('');
        setStatus({ sev: 'error', msg: errMsg(tb.error) });
        return;
      }
      const enc = encode(tb.bytes, variant, wrap, useZ);
      if (!enc.ok) {
        setEncoded('');
        setStatus({ sev: 'error', msg: errMsg(enc.error) });
        return;
      }
      setEncoded(enc.text);
      setEncodeInfo(t('ascii85.encodeInfo', { bytes: tb.bytes.length, chars: enc.text.length }));
      setStatus({ sev: 'success', msg: t('ascii85.encoded') });
    } catch (e) {
      setStatus({ sev: 'error', msg: t('ascii85.encodeErr') + (e instanceof Error ? e.message : String(e)) });
    }
  };

  const onDecode = () => {
    try {
      const dec = decode(cipher, variant);
      if (!dec.ok) {
        setDecodedText('');
        setDecodedHex('');
        setStatus({ sev: 'error', msg: errMsg(dec.error) });
        return;
      }
      setDecodedText(bytesToUtf8(dec.bytes));
      setDecodedHex(bytesToHex(dec.bytes));
      setDecodeInfo(t('ascii85.decodeInfo', { bytes: dec.bytes.length }));
      setStatus({ sev: 'success', msg: t('ascii85.decoded') });
    } catch (e) {
      setStatus({ sev: 'error', msg: t('ascii85.decodeErr') + (e instanceof Error ? e.message : String(e)) });
    }
  };

  const copy = (value: string, what: string) => {
    if (!value) {
      setStatus({ sev: 'warning', msg: t('ascii85.nothingToCopy') });
      return;
    }
    navigator.clipboard?.writeText(value);
    setStatus({ sev: 'success', msg: t('ascii85.copied', { what }) });
  };

  const statusColor =
    status.sev === 'error' ? 'var(--danger)' : status.sev === 'warning' ? 'var(--warning, #b8860b)' : status.sev === 'success' ? 'var(--accent, #2e7d32)' : undefined;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ascii85.blurb')}
      </p>

      <p style={{ margin: '0 0 12px', color: statusColor, fontSize: 12.5 }}>{status.msg}</p>

      {/* Options */}
      <div className="kv-list" style={{ marginBottom: 14 }}>
        <div className="kv-row" style={{ alignItems: 'center', gap: 10 }}>
          <span className="count-note" style={{ minWidth: 140 }}>
            {t('ascii85.variantLabel')}
          </span>
          <select className="mod-select" value={variant} onChange={(e) => setVariant(e.target.value as Variant)}>
            <option value="adobe">{t('ascii85.variantAdobe')}</option>
            <option value="z85">{t('ascii85.variantZ85')}</option>
            <option value="rfc1924">{t('ascii85.variantRfc1924')}</option>
          </select>
        </div>
        <div className="kv-row" style={{ alignItems: 'center', gap: 10 }}>
          <span className="count-note" style={{ minWidth: 140 }}>
            {t('ascii85.inputLabel')}
          </span>
          <select className="mod-select" value={inputKind} onChange={(e) => setInputKind(e.target.value as InputKind)}>
            <option value="utf8">{t('ascii85.inputUtf8')}</option>
            <option value="hex">{t('ascii85.inputHex')}</option>
          </select>
        </div>
        {variant === 'adobe' && (
          <div className="kv-row" style={{ alignItems: 'center', gap: 20 }}>
            <label className="chk">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
              {t('ascii85.wrap')}
            </label>
            <label className="chk">
              <input type="checkbox" checked={useZ} onChange={(e) => setUseZ(e.target.checked)} />
              {t('ascii85.zShortcut')}
            </label>
          </div>
        )}
      </div>

      {/* Encode */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 8px' }}>
        {t('ascii85.encodeTitle')}
      </h3>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={plain}
        onChange={(e) => setPlain(e.target.value)}
        placeholder={t('ascii85.plainPlaceholder')}
        style={{ minHeight: 90 }}
      />
      {encodeInfo && (
        <p className="count-note" style={{ marginTop: 6 }}>
          {encodeInfo}
        </p>
      )}
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={encoded}
        placeholder={t('ascii85.encodedPlaceholder')}
        style={{ minHeight: 90, marginTop: 8 }}
      />
      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <button className="mini primary" onClick={onEncode}>
          {t('ascii85.encode')}
        </button>
        <button className="mini" disabled={!encoded} onClick={() => copy(encoded, t('ascii85.whatBase85'))}>
          {t('ascii85.copyBase85')}
        </button>
      </div>

      {/* Decode */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '18px 0 8px' }}>
        {t('ascii85.decodeTitle')}
      </h3>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={cipher}
        onChange={(e) => setCipher(e.target.value)}
        placeholder={t('ascii85.cipherPlaceholder')}
        style={{ minHeight: 90 }}
      />
      <p className="count-note" style={{ marginTop: 6, marginBottom: 4 }}>
        {t('ascii85.decodeTextLabel')}
      </p>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={decodedText} style={{ minHeight: 60 }} />
      <p className="count-note" style={{ marginTop: 8, marginBottom: 4 }}>
        {t('ascii85.decodeHexLabel')}
      </p>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={decodedHex} style={{ minHeight: 60, fontFamily: 'monospace' }} />
      {decodeInfo && (
        <p className="count-note" style={{ marginTop: 6 }}>
          {decodeInfo}
        </p>
      )}
      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <button className="mini primary" onClick={onDecode}>
          {t('ascii85.decode')}
        </button>
        <button className="mini" disabled={!decodedText} onClick={() => copy(decodedText, t('ascii85.whatText'))}>
          {t('ascii85.copyText')}
        </button>
        <button className="mini" disabled={!decodedHex} onClick={() => copy(decodedHex, t('ascii85.whatHex'))}>
          {t('ascii85.copyHex')}
        </button>
      </div>
    </div>
  );
}
