import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type NumBase = 2 | 8 | 10 | 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function format(b: number, base: NumBase): string {
  switch (base) {
    case 2:
      return b.toString(2).padStart(8, '0');
    case 8:
      return b.toString(8);
    case 16:
      return b.toString(16).toUpperCase().padStart(2, '0');
    default:
      return b.toString(10);
  }
}

// Strip common prefixes (0x, 0b, 0o) so pasted codes still parse.
function strip(tok: string, base: NumBase): string {
  tok = tok.trim();
  if (tok.length > 2 && tok[0] === '0') {
    const p = tok[1]!.toLowerCase();
    if ((base === 16 && p === 'x') || (base === 2 && p === 'b') || (base === 8 && p === 'o')) {
      return tok.substring(2);
    }
  }
  return tok;
}

function isDigitFor(c: string, base: NumBase): boolean {
  let d: number;
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) d = code - 48; // 0-9
  else if (code >= 97 && code <= 102) d = 10 + (code - 97); // a-f
  else if (code >= 65 && code <= 70) d = 10 + (code - 65); // A-F
  else return false;
  return d < base;
}

function tryParse(tok: string, base: NumBase): number | null {
  for (const c of tok) {
    if (!isDigitFor(c, base)) return null;
  }
  const value = parseInt(tok, base);
  if (Number.isNaN(value)) return null;
  return value;
}

function encode(input: string, base: NumBase): { ok: boolean; text: string } {
  if (!input) return { ok: true, text: '' };
  try {
    const bytes = encoder.encode(input);
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      parts.push(format(bytes[i]!, base));
    }
    return { ok: true, text: parts.join(' ') };
  } catch {
    return { ok: false, text: '' };
  }
}

function decode(input: string, base: NumBase): { ok: boolean; text: string } {
  if (!input || !input.trim()) return { ok: true, text: '' };
  const tokens = input.split(/[ \t\r\n,]+/).filter((x) => x.length > 0);
  const bytes: number[] = [];
  for (const raw of tokens) {
    const tok = strip(raw, base);
    if (tok.length === 0) continue;
    const value = tryParse(tok, base);
    if (value === null) return { ok: false, text: '' };
    if (value < 0 || value > 255) return { ok: false, text: '' };
    bytes.push(value);
  }
  if (bytes.length === 0) return { ok: true, text: '' };
  return { ok: true, text: decoder.decode(new Uint8Array(bytes)) };
}

const BASES: { value: NumBase; key: string }[] = [
  { value: 2, key: 'binarytext.baseBinary' },
  { value: 10, key: 'binarytext.baseDecimal' },
  { value: 8, key: 'binarytext.baseOctal' },
  { value: 16, key: 'binarytext.baseHex' },
];

export function BinaryTextModule() {
  const { t } = useTranslation();
  const [base, setBase] = useState<NumBase>(2);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ text: string; warn: boolean }>({ text: t('binarytext.ready'), warn: false });

  const setBaseFrom = (v: string) => {
    setBase(Number(v) as NumBase);
    setStatus({ text: t('binarytext.baseChanged'), warn: false });
  };

  const doEncode = () => {
    const r = encode(input, base);
    if (r.ok) {
      setOutput(r.text);
      setStatus({ text: t('binarytext.encoded'), warn: false });
    } else {
      setStatus({ text: t('binarytext.encodeFail'), warn: true });
    }
  };

  const doDecode = () => {
    const r = decode(input, base);
    if (r.ok) {
      setOutput(r.text);
      setStatus({ text: t('binarytext.decoded'), warn: false });
    } else {
      setOutput('');
      setStatus({ text: t('binarytext.decodeFail'), warn: true });
    }
  };

  const doSwap = () => {
    setInput(output ?? '');
    setOutput('');
    setStatus({ text: t('binarytext.swapped'), warn: false });
  };

  const doCopy = () => {
    const text = output ?? '';
    if (!text) {
      setStatus({ text: t('binarytext.nothingToCopy'), warn: true });
      return;
    }
    void navigator.clipboard?.writeText(text);
    setStatus({ text: t('binarytext.copied'), warn: false });
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('binarytext.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('binarytext.numericBase')}</span>
        <select className="mod-select" value={String(base)} onChange={(e) => setBaseFrom(e.target.value)}>
          {BASES.map((b) => (
            <option key={b.value} value={String(b.value)}>
              {t(b.key)}
            </option>
          ))}
        </select>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('binarytext.encodingNote')}
      </p>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={doEncode}>
          {t('binarytext.encode')}
        </button>
        <button className="mini" onClick={doDecode}>
          {t('binarytext.decode')}
        </button>
        <button className="mini" onClick={doSwap}>
          {t('binarytext.swap')}
        </button>
        <button className="mini" disabled={!output} onClick={doCopy}>
          {t('binarytext.copy')}
        </button>
      </div>

      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('binarytext.inputLabel')}
        />
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={output}
          placeholder={t('binarytext.outputLabel')}
        />
      </div>

      <p style={{ marginTop: 10, fontSize: 12.5, color: status.warn ? 'var(--danger)' : undefined }} className={status.warn ? '' : 'count-note'}>
        {status.text}
      </p>
    </div>
  );
}
