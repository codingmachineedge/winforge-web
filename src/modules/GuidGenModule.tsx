import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// --- Crypto helpers (all random material from crypto.getRandomValues) ---

/** Fill n bytes of CSPRNG randomness. */
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Unbiased integer in [0, max) using rejection sampling over 32-bit words. */
function randomInt(max: number): number {
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % max;
}

// --- GUID ---

/** RFC 4122 version-4 GUID: 16 random bytes with version + variant nibbles set. */
function rawGuidBytes(): Uint8Array {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant RFC 4122 (10xx)
  return b;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Format 16 bytes as the eight canonical hyphen groups (8-4-4-4-12), lowercase. */
function guidGroups(b: Uint8Array): string {
  const h = Array.from(b, hex2).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Match .NET Guid.ToString(format): "N", "D", "B", "P", "X". */
function formatGuid(b: Uint8Array, format: string, upper: boolean): string {
  const d = guidGroups(b); // 8-4-4-4-12
  const h = d.replace(/-/g, '');
  let out: string;
  switch (format) {
    case 'N':
      out = h;
      break;
    case 'B':
      out = `{${d}}`;
      break;
    case 'P':
      out = `(${d})`;
      break;
    case 'X': {
      // {0x00000000,0x0000,0x0000,{0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00}}
      const g = (i: number) => `0x${hex2(b[i]!)}`;
      const a = `0x${h.slice(0, 8)}`;
      const c = `0x${h.slice(8, 12)}`;
      const e = `0x${h.slice(12, 16)}`;
      const tail = [8, 9, 10, 11, 12, 13, 14, 15].map(g).join(',');
      out = `{${a},${c},${e},{${tail}}}`;
      break;
    }
    case 'D':
    default:
      out = d;
      break;
  }
  return upper ? out.toUpperCase() : out;
}

function newGuid(format: string, upper: boolean): string {
  return formatGuid(rawGuidBytes(), format, upper);
}

function bulkGuids(count: number, format: string, upper: boolean): string {
  const n = Math.min(1000, Math.max(1, count));
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(newGuid(format, upper));
  return lines.join('\n');
}

// --- ULID (Crockford base32, 48-bit ms timestamp + 80 random bits) ---

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newUlid(): string {
  let ms = Date.now();
  if (ms < 0) ms = 0;
  const rand = randomBytes(10);
  const chars = new Array<string>(26);

  // Timestamp: 48 bits → 10 base32 chars. Split across the 32-bit boundary to
  // stay exact (Date.now() fits in 48 bits well within safe-integer range).
  const high = Math.floor(ms / 0x100000000); // top 16 bits
  const low = ms % 0x100000000; // low 32 bits
  chars[0] = CROCKFORD[(high >> 13) & 0x1f]!;
  chars[1] = CROCKFORD[(high >> 8) & 0x1f]!;
  chars[2] = CROCKFORD[(high >> 3) & 0x1f]!;
  chars[3] = CROCKFORD[((high << 2) | (low >>> 30)) & 0x1f]!;
  chars[4] = CROCKFORD[(low >>> 25) & 0x1f]!;
  chars[5] = CROCKFORD[(low >>> 20) & 0x1f]!;
  chars[6] = CROCKFORD[(low >>> 15) & 0x1f]!;
  chars[7] = CROCKFORD[(low >>> 10) & 0x1f]!;
  chars[8] = CROCKFORD[(low >>> 5) & 0x1f]!;
  chars[9] = CROCKFORD[low & 0x1f]!;

  // Randomness: 80 bits → 16 base32 chars (matches WinForge's bit layout).
  const r = rand;
  chars[10] = CROCKFORD[(r[0]! & 0xff) >> 3]!;
  chars[11] = CROCKFORD[((r[0]! << 2) | (r[1]! >> 6)) & 0x1f]!;
  chars[12] = CROCKFORD[(r[1]! >> 1) & 0x1f]!;
  chars[13] = CROCKFORD[((r[1]! << 4) | (r[2]! >> 4)) & 0x1f]!;
  chars[14] = CROCKFORD[((r[2]! << 1) | (r[3]! >> 7)) & 0x1f]!;
  chars[15] = CROCKFORD[(r[3]! >> 2) & 0x1f]!;
  chars[16] = CROCKFORD[((r[3]! << 3) | (r[4]! >> 5)) & 0x1f]!;
  chars[17] = CROCKFORD[r[4]! & 0x1f]!;
  chars[18] = CROCKFORD[(r[5]! & 0xff) >> 3]!;
  chars[19] = CROCKFORD[((r[5]! << 2) | (r[6]! >> 6)) & 0x1f]!;
  chars[20] = CROCKFORD[(r[6]! >> 1) & 0x1f]!;
  chars[21] = CROCKFORD[((r[6]! << 4) | (r[7]! >> 4)) & 0x1f]!;
  chars[22] = CROCKFORD[((r[7]! << 1) | (r[8]! >> 7)) & 0x1f]!;
  chars[23] = CROCKFORD[(r[8]! >> 2) & 0x1f]!;
  chars[24] = CROCKFORD[((r[8]! << 3) | (r[9]! >> 5)) & 0x1f]!;
  chars[25] = CROCKFORD[r[9]! & 0x1f]!;

  return chars.join('');
}

// --- nano-ID (URL-safe 64-char alphabet, unbiased) ---

const NANO = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

function newNanoId(length: number): string {
  const len = Math.min(64, Math.max(4, length));
  const chars = new Array<string>(len);
  for (let i = 0; i < len; i++) chars[i] = NANO[randomInt(NANO.length)]!;
  return chars.join('');
}

// --- GUID inspector ---

interface GuidInfo {
  hex: string;
  version: number;
  variant: string;
}

/** Parse any accepted GUID form (D/N/B/P/X); throws on invalid input. */
function parseGuidBytes(text: string): Uint8Array {
  let s = (text ?? '').trim();
  // Strip surrounding braces / parentheses.
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('(') && s.endsWith(')'))) {
    s = s.slice(1, -1).trim();
  }
  // Hex-object form: keep only hex digits.
  const digits = s.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (digits.length !== 32) throw new Error('invalid');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const byte = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid');
    b[i] = byte;
  }
  return b;
}

function inspect(text: string): GuidInfo {
  const be = parseGuidBytes(text); // canonical RFC-4122 field order
  const hex = Array.from(be, (x) => hex2(x).toUpperCase()).join(' ');
  const version = (be[6]! >> 4) & 0x0f;
  const variantBits = (be[8]! >> 5) & 0x07;
  const variant =
    (variantBits & 0b100) === 0
      ? 'NCS (0xxx)'
      : (variantBits & 0b110) === 0b100
        ? 'RFC 4122 (10xx)'
        : (variantBits & 0b111) === 0b110
          ? 'Microsoft (110x)'
          : 'Reserved (111x)';
  return { hex, version, variant };
}

// --- Component ---

const FORMATS: { tag: string; label: string }[] = [
  { tag: 'D', label: 'D — 32 digits + hyphens' },
  { tag: 'N', label: 'N — 32 digits, no hyphens' },
  { tag: 'B', label: 'B — {braces}' },
  { tag: 'P', label: 'P — (parentheses)' },
  { tag: 'X', label: 'X — hex object' },
];

export function GuidGenModule() {
  const { t } = useTranslation();

  const [format, setFormat] = useState('D');
  const [upper, setUpper] = useState(false);
  const [guid, setGuid] = useState('');

  const [countInput, setCountInput] = useState(10);
  const [bulk, setBulk] = useState('');

  const [ulid, setUlid] = useState('');
  const [nanoLen, setNanoLen] = useState(21);
  const [nano, setNano] = useState('');

  const [inspectInput, setInspectInput] = useState('');

  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);

  const setOk = (msg: string) => setStatus({ msg, error: false });
  const setErr = (msg: string) => setStatus({ msg, error: true });

  // Regenerate the single GUID whenever format/case changes (mirrors Guid_OptionChanged).
  useEffect(() => {
    setGuid(newGuid(format, upper));
    setOk(t('guidgen.genGuidMsg'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, upper]);

  // Seed ULID and nano-ID once on mount (mirrors Loaded handler).
  useEffect(() => {
    setUlid(newUlid());
    setNano(newNanoId(21));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspectResult = useMemo<{ info: GuidInfo | null; error: boolean }>(() => {
    if (!inspectInput.trim()) return { info: null, error: false };
    try {
      return { info: inspect(inspectInput), error: false };
    } catch {
      return { info: null, error: true };
    }
  }, [inspectInput]);

  const copy = (text: string) => {
    if (!text) {
      setErr(t('guidgen.nothingCopy'));
      return;
    }
    navigator.clipboard?.writeText(text);
    setOk(t('guidgen.copied'));
  };

  const clampedCount = Math.min(1000, Math.max(1, countInput || 1));

  const cardStyle: React.CSSProperties = {
    padding: '14px 16px',
    border: '1px solid var(--border, #333)',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 14,
  };
  const titleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 15, margin: 0 };
  const rowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
  const monoStyle: React.CSSProperties = { fontFamily: 'Consolas, monospace' };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('guidgen.blurb')}
      </p>

      {/* --- GUID --- */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('guidgen.guidTitle')}</h3>
        <div style={rowStyle}>
          <span>{t('guidgen.format')}</span>
          <select className="mod-select" value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f.tag} value={f.tag}>
                {f.label}
              </option>
            ))}
          </select>
          <label className="chk">
            <input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} />
            {t('guidgen.uppercase')}
          </label>
        </div>
        <input className="mod-search" style={monoStyle} readOnly value={guid} />
        <div style={rowStyle}>
          <button
            className="mini primary"
            onClick={() => {
              setGuid(newGuid(format, upper));
              setOk(t('guidgen.genGuidMsg'));
            }}
          >
            {t('guidgen.generate')}
          </button>
          <button className="mini" onClick={() => copy(guid)}>
            {t('guidgen.copy')}
          </button>
        </div>
      </div>

      {/* --- Bulk --- */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('guidgen.bulkTitle')}</h3>
        <div style={rowStyle}>
          <span>{t('guidgen.count')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={1000}
            style={{ maxWidth: 120 }}
            value={countInput}
            onChange={(e) => setCountInput(Math.min(1000, Math.max(1, Math.floor(+e.target.value) || 1)))}
          />
          <button
            className="mini primary"
            onClick={() => {
              setBulk(bulkGuids(clampedCount, format, upper));
              setOk(t('guidgen.genBulkMsg', { chars: clampedCount.toLocaleString() }));
            }}
          >
            {t('guidgen.generate')}
          </button>
          <button className="mini" onClick={() => copy(bulk)}>
            {t('guidgen.copyAll')}
          </button>
        </div>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={bulk}
          style={{ ...monoStyle, minHeight: 180, whiteSpace: 'pre', overflow: 'auto' }}
        />
      </div>

      {/* --- ULID & nano-ID --- */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('guidgen.otherTitle')}</h3>
        <input className="mod-search" style={monoStyle} readOnly value={ulid} />
        <div style={rowStyle}>
          <button
            className="mini primary"
            onClick={() => {
              setUlid(newUlid());
              setOk(t('guidgen.genUlidMsg'));
            }}
          >
            {t('guidgen.newUlid')}
          </button>
          <button className="mini" onClick={() => copy(ulid)}>
            {t('guidgen.copy')}
          </button>
        </div>
        <div style={rowStyle}>
          <span>{t('guidgen.nanoLen')}</span>
          <input
            className="mod-search"
            type="number"
            min={4}
            max={64}
            style={{ maxWidth: 120 }}
            value={nanoLen}
            onChange={(e) => setNanoLen(Math.min(64, Math.max(4, Math.floor(+e.target.value) || 4)))}
          />
        </div>
        <input className="mod-search" style={monoStyle} readOnly value={nano} />
        <div style={rowStyle}>
          <button
            className="mini primary"
            onClick={() => {
              setNano(newNanoId(nanoLen));
              setOk(t('guidgen.genNanoMsg'));
            }}
          >
            {t('guidgen.newNano')}
          </button>
          <button className="mini" onClick={() => copy(nano)}>
            {t('guidgen.copy')}
          </button>
        </div>
      </div>

      {/* --- Inspector --- */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('guidgen.inspectTitle')}</h3>
        <input
          className="mod-search"
          style={monoStyle}
          value={inspectInput}
          placeholder={t('guidgen.inspectPlaceholder')}
          onChange={(e) => setInspectInput(e.target.value)}
        />
        <span className="count-note">{t('guidgen.inspectHexLabel')}</span>
        <input className="mod-search" style={monoStyle} readOnly value={inspectResult.info?.hex ?? ''} />
        {inspectResult.info && (
          <span style={{ fontSize: 13 }}>
            {t('guidgen.inspectMeta', {
              version: inspectResult.info.version,
              variant: inspectResult.info.variant,
            })}
          </span>
        )}
        {inspectResult.error && (
          <span style={{ fontSize: 13, color: 'var(--danger)' }}>{t('guidgen.invalidGuid')}</span>
        )}
      </div>

      {status && (
        <p
          className={status.error ? '' : 'count-note'}
          style={status.error ? { fontSize: 12.5, color: 'var(--danger)' } : undefined}
        >
          {status.msg}
        </p>
      )}
    </div>
  );
}
