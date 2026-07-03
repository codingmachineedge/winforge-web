import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Codec = 'base32' | 'base32nopad' | 'base58' | 'ascii85';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ---------------- Base32 (RFC 4648) ----------------

function base32Encode(data: Uint8Array, pad: boolean): string {
  if (data.length === 0) return '';
  let out = '';
  let buffer = 0;
  let bitsLeft = 0;
  for (const b of data) {
    buffer = (buffer << 8) | b;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      out += BASE32_ALPHABET[(buffer >> bitsLeft) & 0x1f]!;
    }
  }
  if (bitsLeft > 0) out += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f]!;
  if (pad) while (out.length % 8 !== 0) out += '=';
  return out;
}

function base32Decode(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const raw of s) {
    const c = raw.toUpperCase();
    if (c === '=' || /\s/.test(c) || c === '-') continue;
    const val = BASE32_ALPHABET.indexOf(c);
    if (val < 0) throw new Error(`Invalid Base32 character '${raw}'.`);
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// ---------------- Base58 (Bitcoin) ----------------

function base58Encode(data: Uint8Array): string {
  if (data.length === 0) return '';
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros++;

  let num = 0n;
  for (const b of data) num = num * 256n + BigInt(b);

  let out = '';
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    out = BASE58_ALPHABET[Number(rem)]! + out;
  }
  for (let i = 0; i < zeros; i++) out = BASE58_ALPHABET[0]! + out; // '1'
  return out;
}

function base58Decode(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  const trimmed = s.trim();
  let num = 0n;
  let leading = 0;
  let sawNonLeading = false;
  for (const c of trimmed) {
    if (/\s/.test(c)) continue;
    const val = BASE58_ALPHABET.indexOf(c);
    if (val < 0) throw new Error(`Invalid Base58 character '${c}'.`);
    if (!sawNonLeading && val === 0) leading++;
    else sawNonLeading = true;
    num = num * 58n + BigInt(val);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    const rem = num % 256n;
    num = num / 256n;
    bytes.unshift(Number(rem));
  }
  for (let i = 0; i < leading; i++) bytes.unshift(0);
  return new Uint8Array(bytes);
}

// ---------------- Ascii85 (Adobe) ----------------

function ascii85Encode(data: Uint8Array): string {
  if (data.length === 0) return '<~~>';
  let out = '<~';
  let i = 0;
  while (i < data.length) {
    const count = Math.min(4, data.length - i);
    let tuple = 0;
    for (let j = 0; j < 4; j++) tuple = (tuple * 256 + (j < count ? data[i + j]! : 0)) >>> 0;

    if (count === 4 && tuple === 0) {
      out += 'z';
    } else {
      const group = new Array<string>(5);
      let t = tuple;
      for (let k = 4; k >= 0; k--) {
        group[k] = String.fromCharCode(0x21 + (t % 85));
        t = Math.floor(t / 85);
      }
      out += group.slice(0, count + 1).join('');
    }
    i += 4;
  }
  out += '~>';
  return out;
}

function ascii85Decode(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  let body = s.trim();
  if (body.startsWith('<~')) body = body.slice(2);
  const end = body.indexOf('~>');
  if (end >= 0) body = body.slice(0, end);

  const bytes: number[] = [];
  let tuple = 0;
  let count = 0;
  for (const c of body) {
    if (/\s/.test(c)) continue;
    if (c === 'z') {
      if (count !== 0) throw new Error("Ascii85 'z' inside a group.");
      bytes.push(0, 0, 0, 0);
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x21 || code > 0x75) throw new Error(`Invalid Ascii85 character '${c}'.`);
    tuple = tuple * 85 + (code - 0x21);
    if (++count === 5) {
      bytes.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count === 1) throw new Error('Ascii85 group has a single trailing character.');
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84; // pad with 'u'
    for (let k = 0; k < count - 1; k++) bytes.push((tuple >>> (24 - k * 8)) & 0xff);
  }
  return new Uint8Array(bytes);
}

// ---------------- codec dispatch ----------------

function encodeWith(text: string, codec: Codec): string {
  const bytes = new TextEncoder().encode(text);
  switch (codec) {
    case 'base32':
      return base32Encode(bytes, true);
    case 'base32nopad':
      return base32Encode(bytes, false);
    case 'base58':
      return base58Encode(bytes);
    case 'ascii85':
      return ascii85Encode(bytes);
  }
}

function decodeWith(text: string, codec: Codec): string {
  let bytes: Uint8Array;
  switch (codec) {
    case 'base32':
    case 'base32nopad':
      bytes = base32Decode(text);
      break;
    case 'base58':
      bytes = base58Decode(text);
      break;
    case 'ascii85':
      bytes = ascii85Decode(text);
      break;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

const CODEC_LABEL: Record<Codec, string> = {
  base32: 'base32',
  base32nopad: 'base32nopad',
  base58: 'base58',
  ascii85: 'ascii85',
};

export function Base32Module() {
  const { t } = useTranslation();
  const [codec, setCodec] = useState<Codec>('base32');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string }>({ ok: true, msg: t('base32.ready') });

  const codecName = () => t(`base32.codec_${CODEC_LABEL[codec]}`);

  const onEncode = () => {
    try {
      setOutput(encodeWith(input, codec));
      setStatus({ ok: true, msg: t('base32.encoded') });
    } catch (e) {
      setStatus({ ok: false, msg: t('base32.encodeError', { error: String(e instanceof Error ? e.message : e) }) });
    }
  };

  const onDecode = () => {
    try {
      setOutput(decodeWith(input, codec));
      setStatus({ ok: true, msg: t('base32.decoded') });
    } catch (e) {
      setStatus({
        ok: false,
        msg: t('base32.decodeError', { codec: codecName(), error: String(e instanceof Error ? e.message : e) }),
      });
    }
  };

  const onSwap = () => {
    setInput(output);
    setOutput('');
    setStatus({ ok: true, msg: t('base32.swapped') });
  };

  const onCopy = () => {
    if (!output.length) {
      setStatus({ ok: false, msg: t('base32.nothingToCopy') });
      return;
    }
    navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('base32.copied') });
  };

  const onCodecChange = (c: Codec) => {
    setCodec(c);
    setStatus({ ok: true, msg: t('base32.codecChanged') });
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('base32.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('base32.codec')}</span>
        <select className="mod-select" value={codec} onChange={(e) => onCodecChange(e.target.value as Codec)}>
          <option value="base32">{t('base32.codec_base32')}</option>
          <option value="base32nopad">{t('base32.codec_base32nopad')}</option>
          <option value="base58">{t('base32.codec_base58')}</option>
          <option value="ascii85">{t('base32.codec_ascii85')}</option>
        </select>
        <button className="mini primary" onClick={onEncode}>
          {t('base32.encode')}
        </button>
        <button className="mini" onClick={onDecode}>
          {t('base32.decode')}
        </button>
        <button className="mini" onClick={onSwap}>
          {t('base32.swap')}
        </button>
        <button className="mini" disabled={!output} onClick={onCopy}>
          {t('base32.copyOutput')}
        </button>
      </div>

      <div className="io-grid">
        <div>
          <div className="count-note" style={{ marginBottom: 4, fontWeight: 600 }}>
            {t('base32.input')}
          </div>
          <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <div>
          <div className="count-note" style={{ marginBottom: 4, fontWeight: 600 }}>
            {t('base32.output')}
          </div>
          <textarea className="hosts-edit" spellCheck={false} readOnly value={output} />
        </div>
      </div>

      <p
        className={status.ok ? 'count-note' : ''}
        style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {status.msg}
      </p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('base32.encodingNote')}
      </p>
    </div>
  );
}
