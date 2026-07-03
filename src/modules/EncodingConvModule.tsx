import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 文字編碼／換行轉換 · Pure-client port of WinForge's EncodingConvService.
// Sniffs BOM to detect the source encoding, detects line-endings, then re-encodes
// text to a chosen target encoding + line-ending. All Web APIs; no backend.

type EncKind = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'ascii' | 'latin1' | 'unknown';
type Eol = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

const ENC_ORDER: EncKind[] = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'ascii', 'latin1'];
const EOL_ORDER: Eol[] = ['lf', 'crlf', 'cr'];

function encLabel(k: EncKind): string {
  switch (k) {
    case 'utf8': return 'UTF-8';
    case 'utf8bom': return 'UTF-8 with BOM';
    case 'utf16le': return 'UTF-16 LE';
    case 'utf16be': return 'UTF-16 BE';
    case 'ascii': return 'ASCII';
    case 'latin1': return 'Latin-1';
    default: return 'Unknown';
  }
}

function eolLabel(e: Eol): string {
  switch (e) {
    case 'lf': return 'LF';
    case 'crlf': return 'CRLF';
    case 'cr': return 'CR';
    case 'mixed': return 'Mixed';
    default: return 'None';
  }
}

// Detect the line-ending style of an in-memory string.
function detectEol(text: string): Eol {
  if (!text) return 'none';
  let crlf = false, lf = false, cr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') { crlf = true; i++; }
      else cr = true;
    } else if (c === '\n') {
      lf = true;
    }
  }
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  if (crlf) return 'crlf';
  if (lf) return 'lf';
  return 'cr';
}

// Normalise every line-ending in the text to the chosen style.
function convertLineEndings(text: string, target: Eol): string {
  if (!text) return text;
  const nl = target === 'crlf' ? '\r\n' : target === 'cr' ? '\r' : '\n';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') i++; // consume CRLF pair
      out += nl;
    } else if (c === '\n') {
      out += nl;
    } else {
      out += c;
    }
  }
  return out;
}

// Sniff a BOM at the head of the byte array. Returns the encoding and BOM length.
function sniffBom(b: Uint8Array): { enc: EncKind; bomLen: number } {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { enc: 'utf8bom', bomLen: 3 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { enc: 'utf16le', bomLen: 2 };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { enc: 'utf16be', bomLen: 2 };
  return { enc: 'unknown', bomLen: 0 };
}

function looksAscii(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i]! > 0x7f) return false;
  return true;
}

// Decode the body (after the BOM) using the detected encoding.
function decodeBytes(b: Uint8Array, bomLen: number, enc: EncKind): string {
  const body = b.subarray(bomLen);
  switch (enc) {
    case 'utf16le': return new TextDecoder('utf-16le').decode(body);
    case 'utf16be': return new TextDecoder('utf-16be').decode(body);
    case 'latin1': {
      // Latin-1: one byte = one code point 0-255.
      let s = '';
      for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]!);
      return s;
    }
    case 'ascii':
      // ASCII decoded as latin1 keeps 0-127 verbatim (and shows any stray high bytes).
      return new TextDecoder('latin1').decode(body);
    default:
      return new TextDecoder('utf-8').decode(body);
  }
}

// Encode text into bytes for the target encoding (with/without BOM).
function encode(text: string, target: EncKind): Uint8Array {
  const t = text ?? '';
  switch (target) {
    case 'utf8bom': {
      const body = new TextEncoder().encode(t);
      const out = new Uint8Array(3 + body.length);
      out.set([0xef, 0xbb, 0xbf], 0);
      out.set(body, 3);
      return out;
    }
    case 'utf8':
      return new TextEncoder().encode(t);
    case 'utf16le': {
      const out = new Uint8Array(2 + t.length * 2);
      out.set([0xff, 0xfe], 0);
      for (let i = 0; i < t.length; i++) {
        const cu = t.charCodeAt(i);
        out[2 + i * 2] = cu & 0xff;
        out[2 + i * 2 + 1] = (cu >> 8) & 0xff;
      }
      return out;
    }
    case 'utf16be': {
      const out = new Uint8Array(2 + t.length * 2);
      out.set([0xfe, 0xff], 0);
      for (let i = 0; i < t.length; i++) {
        const cu = t.charCodeAt(i);
        out[2 + i * 2] = (cu >> 8) & 0xff;
        out[2 + i * 2 + 1] = cu & 0xff;
      }
      return out;
    }
    case 'ascii': {
      const out = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0x7f;
      return out;
    }
    case 'latin1': {
      const out = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0xff;
      return out;
    }
    default:
      return new TextEncoder().encode(t);
  }
}

export function EncodingConvModule() {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [result, setResult] = useState('');
  const [targetEnc, setTargetEnc] = useState<EncKind>('utf8');
  const [targetEol, setTargetEol] = useState<Eol>('crlf'); // CRLF default on Windows
  const [detectedEnc, setDetectedEnc] = useState<EncKind>('unknown');
  const [detectedEol, setDetectedEol] = useState<Eol>('none');
  const [status, setStatus] = useState(t('encodingconv.ready'));

  const encName = detectedEnc === 'unknown' ? t('encodingconv.unknown') : encLabel(detectedEnc);
  const detectLine = t('encodingconv.detected', {
    enc: encName,
    eol: eolLabel(detectedEol),
    tEnc: encLabel(targetEnc),
    tEol: eolLabel(targetEol),
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { enc: sniffed, bomLen } = sniffBom(bytes);
      const enc: EncKind = sniffed === 'unknown' ? (looksAscii(bytes) ? 'ascii' : 'utf8') : sniffed;
      const text = decodeBytes(bytes, bomLen, enc);
      setSource(text);
      setDetectedEnc(enc);
      setDetectedEol(detectEol(text));
      setStatus(t('encodingconv.loaded', { n: bytes.length.toLocaleString() }));
    } catch (err) {
      setStatus(t('encodingconv.loadFailed', { msg: String(err instanceof Error ? err.message : err) }));
    }
  };

  const onSourceChange = (v: string) => {
    setSource(v);
    // Typed/pasted text — encoding is unknown; detect line-endings live.
    setDetectedEnc('unknown');
    setDetectedEol(detectEol(v));
  };

  const convert = () => {
    try {
      const converted = convertLineEndings(source, targetEol);
      setResult(converted);
      const bytes = encode(converted, targetEnc);
      setStatus(t('encodingconv.converted', {
        enc: encLabel(targetEnc),
        eol: eolLabel(targetEol),
        bytes: bytes.length.toLocaleString(),
      }));
    } catch (err) {
      setStatus(t('encodingconv.convertFailed', { msg: String(err instanceof Error ? err.message : err) }));
    }
  };

  const save = () => {
    if (!result) {
      setStatus(t('encodingconv.nothingSave'));
      return;
    }
    try {
      const bytes = encode(result, targetEnc);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted.txt';
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t('encodingconv.saved', { n: bytes.length.toLocaleString() }));
    } catch (err) {
      setStatus(t('encodingconv.saveFailed', { msg: String(err instanceof Error ? err.message : err) }));
    }
  };

  const copy = () => {
    if (!result) {
      setStatus(t('encodingconv.nothingCopy'));
      return;
    }
    void navigator.clipboard?.writeText(result);
    setStatus(t('encodingconv.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 4 }}>{t('encodingconv.blurb')}</p>

      <div className="mod-toolbar">
        <button className="mini" onClick={() => fileRef.current?.click()}>{t('encodingconv.load')}</button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,.log,.json,.xml,.md,.ini,.cfg"
          style={{ display: 'none' }}
          onChange={onFile}
        />
        <span className="count-note">{detectLine}</span>
      </div>

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{t('encodingconv.sourceLabel')}</div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={source}
        onChange={(e) => onSourceChange(e.target.value)}
        placeholder={t('encodingconv.sourcePlaceholder')}
        style={{ minHeight: 130 }}
      />

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('encodingconv.targetEnc')}
          <select className="mod-select" value={targetEnc} onChange={(e) => setTargetEnc(e.target.value as EncKind)}>
            {ENC_ORDER.map((k) => (
              <option key={k} value={k}>{encLabel(k)}</option>
            ))}
          </select>
        </label>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('encodingconv.targetEol')}
          <select className="mod-select" value={targetEol} onChange={(e) => setTargetEol(e.target.value as Eol)}>
            {EOL_ORDER.map((eol) => (
              <option key={eol} value={eol}>{eolLabel(eol)}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini primary" onClick={convert}>{t('encodingconv.convert')}</button>
        <button className="mini" disabled={!result} onClick={save}>{t('encodingconv.save')}</button>
        <button className="mini" disabled={!result} onClick={copy}>{t('encodingconv.copy')}</button>
      </div>

      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 12, marginBottom: 4 }}>{t('encodingconv.resultLabel')}</div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={result}
        placeholder={t('encodingconv.resultPlaceholder')}
        style={{ minHeight: 130 }}
      />

      {status && <p className="count-note" style={{ marginTop: 10 }}>{status}</p>}
    </div>
  );
}
