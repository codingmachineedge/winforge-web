import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Source = 'text' | 'hex' | 'file';

const MAX_BYTES = 1024 * 1024; // ~1 MB read cap, matches WinForge HexDumpService.MaxBytes

function fromText(text: string): Uint8Array {
  try {
    return new TextEncoder().encode(text ?? '');
  } catch {
    return new Uint8Array(0);
  }
}

function hexVal(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 97 + 10; // a-f
  if (code >= 65 && code <= 70) return code - 65 + 10; // A-F
  return 0;
}

function isHexDigit(c: string): boolean {
  return /[0-9a-fA-F]/.test(c);
}

// Parse pasted hex, ignoring whitespace, commas, 0x prefixes and other
// separators. Odd trailing nibble is dropped. Mirrors HexDumpService.FromHex.
function fromHex(hex: string): Uint8Array {
  if (!hex) return new Uint8Array(0);
  try {
    const digits: string[] = [];
    for (let i = 0; i < hex.length; i++) {
      const c = hex[i]!;
      // skip a 0x / 0X prefix by dropping the leading 0 already appended
      if ((c === 'x' || c === 'X') && digits.length > 0 && digits[digits.length - 1] === '0') {
        digits.pop();
        continue;
      }
      if (isHexDigit(c)) digits.push(c);
    }
    const n = Math.floor(digits.length / 2);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const hi = hexVal(digits[i * 2]!);
      const lo = hexVal(digits[i * 2 + 1]!);
      bytes[i] = ((hi << 4) | lo) & 0xff;
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function toHex(b: number, upper: boolean): string {
  const s = b.toString(16).padStart(2, '0');
  return upper ? s.toUpperCase() : s;
}

function toOffset(off: number, upper: boolean): string {
  const s = off.toString(16).padStart(8, '0');
  return upper ? s.toUpperCase() : s;
}

// Render a classic offset | hex | ASCII dump. Mirrors HexDumpService.Render.
function renderDump(bytes: Uint8Array, perRow: number, upper: boolean, showOffset: boolean): string {
  try {
    if (perRow !== 8 && perRow !== 16 && perRow !== 32) perRow = 16;
    const group = 8; // insert an extra space every 8 bytes
    let out = '';

    for (let off = 0; off < bytes.length; off += perRow) {
      if (showOffset) {
        out += toOffset(off, upper);
        out += '  ';
      }

      // hex columns
      for (let i = 0; i < perRow; i++) {
        const idx = off + i;
        if (idx < bytes.length) out += toHex(bytes[idx]!, upper);
        else out += '  ';
        out += ' ';
        if ((i + 1) % group === 0 && i + 1 < perRow) out += ' ';
      }

      out += ' ';
      // ASCII gutter
      for (let i = 0; i < perRow; i++) {
        const idx = off + i;
        if (idx >= bytes.length) break;
        const b = bytes[idx]!;
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      }
      out += '\n';
    }

    if (bytes.length === 0) out += '(no bytes)';
    return out;
  } catch {
    return '(error rendering dump)';
  }
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function HexDumpModule() {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>('text');
  const [input, setInput] = useState('');
  const [perRow, setPerRow] = useState(16);
  const [upper, setUpper] = useState(false);
  const [showOffset, setShowOffset] = useState(true);
  const [fileBytes, setFileBytes] = useState<Uint8Array>(new Uint8Array(0));
  const [fileName, setFileName] = useState('');
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileError, setFileError] = useState('');
  const [copied, setCopied] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const bytes = useMemo<Uint8Array>(() => {
    if (source === 'text') return fromText(input);
    if (source === 'hex') return fromHex(input);
    return fileBytes;
  }, [source, input, fileBytes]);

  const dump = useMemo(() => renderDump(bytes, perRow, upper, showOffset), [bytes, perRow, upper, showOffset]);

  const truncated = source === 'file' && fileTruncated;

  const onBrowse = async (file: File | undefined) => {
    if (!file) return;
    setFileError('');
    try {
      setFileName(file.name);
      const slice = file.slice(0, MAX_BYTES);
      const buf = await slice.arrayBuffer();
      setFileBytes(new Uint8Array(buf));
      setFileTruncated(file.size > MAX_BYTES);
    } catch (e) {
      setFileBytes(new Uint8Array(0));
      setFileTruncated(false);
      setFileError(String(e instanceof Error ? e.message : e));
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(dump);
    setCopied(t('hexdump.copied'));
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <span className="count-note">{t('hexdump.source')}</span>
        <select
          className="mod-select"
          value={source}
          onChange={(e) => {
            setSource(e.target.value as Source);
            setCopied('');
          }}
        >
          <option value="text">{t('hexdump.srcText')}</option>
          <option value="hex">{t('hexdump.srcHex')}</option>
          <option value="file">{t('hexdump.srcFile')}</option>
        </select>

        <span className="count-note">{t('hexdump.bytesPerRow')}</span>
        <select className="mod-select" style={{ maxWidth: 80 }} value={perRow} onChange={(e) => setPerRow(+e.target.value)}>
          <option value={8}>8</option>
          <option value={16}>16</option>
          <option value={32}>32</option>
        </select>

        <label className="chk">
          <input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} />
          {t('hexdump.uppercase')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={showOffset} onChange={(e) => setShowOffset(e.target.checked)} />
          {t('hexdump.showOffset')}
        </label>
      </div>

      {source === 'file' ? (
        <div className="mod-toolbar">
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => void onBrowse(e.target.files?.[0] ?? undefined)}
          />
          <button className="mini" onClick={() => fileRef.current?.click()}>
            {t('hexdump.browse')}
          </button>
          <span className="count-note">
            {fileError
              ? `${t('hexdump.readError')}${fileError}`
              : fileName || t('hexdump.noFile')}
          </span>
        </div>
      ) : (
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 120, maxHeight: 220, fontFamily: 'Consolas, monospace' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={source === 'hex' ? t('hexdump.hexPlaceholder') : t('hexdump.textPlaceholder')}
        />
      )}

      <p className="count-note" style={{ marginTop: 6 }}>
        {`${formatCount(bytes.length)} ${t('hexdump.bytes')}`}
        {truncated ? `  ·  ${t('hexdump.truncated')} ${MAX_BYTES / 1024} KB` : ''}
      </p>

      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('hexdump.dump')}
        </h3>
        <button className="mini" onClick={copy}>
          {t('hexdump.copy')}
        </button>
        {copied && <span className="count-note">{copied}</span>}
      </div>

      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        style={{ minHeight: 260, maxHeight: 480, fontFamily: 'Consolas, monospace', fontSize: 13, whiteSpace: 'pre', overflowX: 'auto' }}
        value={dump}
      />
    </div>
  );
}
