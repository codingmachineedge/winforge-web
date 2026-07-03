import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge UuidV5Service (RFC 4122 name-based UUID v3 MD5 / v5 SHA-1).
// v3/v5 = hash of (namespace bytes big-endian + name UTF-8), with version + variant bits set.
// Pure client-side; never throws. Web Crypto covers SHA-1 (v5); v3 MD5 is implemented in JS.

const NS_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NS_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const NS_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const NS_X500 = '6ba7b814-9dad-11d1-80b4-00c04fd430c8';

type NsKey = 'dns' | 'url' | 'oid' | 'x500' | 'custom';
type Ver = 5 | 3;

/** Parse a GUID string into 16 big-endian bytes. Returns null on any bad input. */
function parseGuid(text: string | null | undefined): Uint8Array | null {
  if (!text) return null;
  const hex = text.trim().replace(/^\{|\}$/g, '').replace(/-/g, '').toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 16 big-endian bytes → canonical lowercase 8-4-4-4-12 UUID string. */
function bytesToUuid(b: Uint8Array): string {
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push((b[i]! & 0xff).toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// --- Pure-JS MD5 (for v3) -----------------------------------------------------
function md5(input: Uint8Array): Uint8Array {
  function rol(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c));
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }

  const msgLen = input.length;
  const bitLen = msgLen * 8;
  // padded length: multiple of 64
  const withOne = msgLen + 1;
  const padded = new Uint8Array((Math.floor((withOne + 8 + 63) / 64)) * 64);
  padded.set(input, 0);
  padded[msgLen] = 0x80;
  // append length as 64-bit little-endian (low 32 bits enough for our sizes, but write both)
  const lenLo = bitLen >>> 0;
  const lenHi = Math.floor(bitLen / 4294967296) >>> 0;
  const lenPos = padded.length - 8;
  padded[lenPos] = lenLo & 0xff;
  padded[lenPos + 1] = (lenLo >>> 8) & 0xff;
  padded[lenPos + 2] = (lenLo >>> 16) & 0xff;
  padded[lenPos + 3] = (lenLo >>> 24) & 0xff;
  padded[lenPos + 4] = lenHi & 0xff;
  padded[lenPos + 5] = (lenHi >>> 8) & 0xff;
  padded[lenPos + 6] = (lenHi >>> 16) & 0xff;
  padded[lenPos + 7] = (lenHi >>> 24) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] = (padded[p]! | (padded[p + 1]! << 8) | (padded[p + 2]! << 16) | (padded[p + 3]! << 24)) | 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rol(F, s[i]!)) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    const w = words[i]!;
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

/** SHA-1 via Web Crypto; returns 20-byte digest. */
async function sha1(input: Uint8Array): Promise<Uint8Array> {
  const view = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const buf = await crypto.subtle.digest('SHA-1', view);
  return new Uint8Array(buf);
}

/** Compute RFC 4122 name-based UUID. version = 3 (MD5) or 5 (SHA-1). Never throws. */
async function compute(ns: Uint8Array, name: string, version: Ver): Promise<string> {
  try {
    const nameBytes = utf8Bytes(name ?? '');
    const input = new Uint8Array(ns.length + nameBytes.length);
    input.set(ns, 0);
    input.set(nameBytes, ns.length);

    const hash = version === 3 ? md5(input) : await sha1(input);

    const u = new Uint8Array(16);
    u.set(hash.subarray(0, 16), 0);
    // Set version (high nibble of byte 6).
    u[6] = (u[6]! & 0x0f) | (version << 4);
    // Set variant (top two bits of byte 8 -> 10).
    u[8] = (u[8]! & 0x3f) | 0x80;

    return bytesToUuid(u);
  } catch {
    return '';
  }
}

function nsBytesFor(key: NsKey, custom: string): Uint8Array | null {
  switch (key) {
    case 'dns':
      return parseGuid(NS_DNS);
    case 'url':
      return parseGuid(NS_URL);
    case 'oid':
      return parseGuid(NS_OID);
    case 'x500':
      return parseGuid(NS_X500);
    default:
      return parseGuid(custom);
  }
}

interface BulkRow {
  name: string;
  uuid: string;
}

async function computeBulk(ns: Uint8Array, multiline: string, version: Ver): Promise<BulkRow[]> {
  const rows: BulkRow[] = [];
  if (!multiline) return rows;
  try {
    const lines = multiline.replace(/\r\n?/g, '\n').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      rows.push({ name: line, uuid: await compute(ns, line, version) });
    }
  } catch {
    /* never-throw */
  }
  return rows;
}

export function UuidV5Module() {
  const { t } = useTranslation();
  const [nsKey, setNsKey] = useState<NsKey>('dns');
  const [custom, setCustom] = useState('');
  const [version, setVersion] = useState<Ver>(5);
  const [name, setName] = useState('example.com');
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);

  const [bulkInput, setBulkInput] = useState('');
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkCopied, setBulkCopied] = useState(false);

  const ns = useMemo(() => nsBytesFor(nsKey, custom), [nsKey, custom]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ns) {
        if (!cancelled) {
          setResult('');
          setStatus(t('uuidv5.badCustom'));
        }
        return;
      }
      const r = await compute(ns, name, version);
      if (cancelled) return;
      if (!r) {
        setResult('');
        setStatus(t('uuidv5.computeFail'));
        return;
      }
      setResult(r);
      setStatus(t('uuidv5.deterministic', { ver: version }));
    })();
    return () => {
      cancelled = true;
    };
  }, [ns, name, version, t]);

  const copy = () => {
    if (!result) return;
    try {
      navigator.clipboard?.writeText(result);
      setCopied(true);
      setStatus(t('uuidv5.copied'));
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setStatus(t('uuidv5.copyFail'));
    }
  };

  const runBulk = async () => {
    if (!ns) {
      setStatus(t('uuidv5.badCustomFirst'));
      setBulkRows([]);
      return;
    }
    const rows = await computeBulk(ns, bulkInput, version);
    setBulkRows(rows);
    setStatus(t('uuidv5.generated', { count: rows.length }));
  };

  const copyBulk = () => {
    if (bulkRows.length === 0) return;
    try {
      const text = bulkRows.map((r) => `${r.name}  →  ${r.uuid}`).join('\n');
      navigator.clipboard?.writeText(text);
      setBulkCopied(true);
      setStatus(t('uuidv5.allCopied'));
      setTimeout(() => setBulkCopied(false), 1200);
    } catch {
      setStatus(t('uuidv5.copyFail'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note">{t('uuidv5.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('uuidv5.namespace')}</label>
        <select className="mod-select" value={nsKey} onChange={(e) => setNsKey(e.target.value as NsKey)}>
          <option value="dns">DNS · {NS_DNS}</option>
          <option value="url">URL · {NS_URL}</option>
          <option value="oid">OID · {NS_OID}</option>
          <option value="x500">X500 · {NS_X500}</option>
          <option value="custom">{t('uuidv5.custom')}</option>
        </select>
        <label className="count-note">{t('uuidv5.version')}</label>
        <select className="mod-select" value={version} onChange={(e) => setVersion(Number(e.target.value) === 3 ? 3 : 5)}>
          <option value={5}>v5 · SHA-1</option>
          <option value={3}>v3 · MD5</option>
        </select>
      </div>

      {nsKey === 'custom' && (
        <div className="mod-toolbar">
          <input
            className="hosts-edit"
            style={{ minHeight: 0, height: 34, maxWidth: 340, fontFamily: 'monospace' }}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
          />
        </div>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('uuidv5.name')}</label>
        <input
          className="hosts-edit"
          style={{ minHeight: 0, height: 34, maxWidth: 340 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="panel">
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('uuidv5.result')}</span>
            <span className="value" style={{ fontFamily: 'monospace' }}>{result || '—'}</span>
          </div>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" disabled={!result} onClick={copy}>
            {copied ? t('uuidv5.copied') : t('uuidv5.copy')}
          </button>
        </div>
      </div>

      <p className="count-note" style={{ color: result ? undefined : 'var(--danger)' }}>{status}</p>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('uuidv5.bulkTitle')}</h4>
        <p className="count-note">{t('uuidv5.bulkBlurb')}</p>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={bulkInput}
          onChange={(e) => setBulkInput(e.target.value)}
          placeholder={t('uuidv5.bulkPlaceholder')}
          style={{ minHeight: 120 }}
        />
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" onClick={runBulk}>{t('uuidv5.generate')}</button>
          <button className="mini" disabled={bulkRows.length === 0} onClick={copyBulk}>
            {bulkCopied ? t('uuidv5.allCopied') : t('uuidv5.copyAll')}
          </button>
        </div>
        {bulkRows.length > 0 && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={bulkRows.map((r) => `${r.name}  →  ${r.uuid}`).join('\n')}
            style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 140 }}
          />
        )}
      </div>
    </div>
  );
}
