import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NANO_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function uuidV4(): string {
  return crypto.randomUUID();
}
function uuidV7(): string {
  const b = randomBytes(16);
  const ts = Date.now();
  b[0] = (ts / 2 ** 40) & 0xff;
  b[1] = (ts / 2 ** 32) & 0xff;
  b[2] = (ts / 2 ** 24) & 0xff;
  b[3] = (ts / 2 ** 16) & 0xff;
  b[4] = (ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = 0x70 | (b[6]! & 0x0f); // version 7
  b[8] = 0x80 | (b[8]! & 0x3f); // variant
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function ulid(): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i]! % 32];
  return time + r;
}
function nanoId(len: number): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += NANO_ALPHABET[bytes[i]! & 63];
  return s;
}
function formatGuid(uuid: string, fmt: string, upper: boolean): string {
  const n = uuid.replace(/-/g, '');
  let out: string;
  switch (fmt) {
    case 'N':
      out = n;
      break;
    case 'B':
      out = `{${uuid}}`;
      break;
    case 'P':
      out = `(${uuid})`;
      break;
    case 'X':
      out = `{0x${n.slice(0, 8)},0x${n.slice(8, 12)},0x${n.slice(12, 16)},{0x${n.slice(16, 18)},0x${n.slice(18, 20)},0x${n.slice(20, 22)},0x${n.slice(22, 24)},0x${n.slice(24, 26)},0x${n.slice(26, 28)},0x${n.slice(28, 30)},0x${n.slice(30, 32)}}}`;
      break;
    default:
      out = uuid;
  }
  return upper ? out.toUpperCase() : out;
}

export function IdGenModule() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<'v4' | 'v7'>('v4');
  const [fmt, setFmt] = useState('D');
  const [upper, setUpper] = useState(false);
  const [single, setSingle] = useState(() => formatGuid(uuidV4(), 'D', false));
  const [count, setCount] = useState(10);
  const [bulk, setBulk] = useState('');
  const [ulidVal, setUlidVal] = useState(() => ulid());
  const [nanoLen, setNanoLen] = useState(21);
  const [nanoVal, setNanoVal] = useState(() => nanoId(21));
  const [inspect, setInspect] = useState('');

  const gen = () => (version === 'v4' ? uuidV4() : uuidV7());
  const copy = (v: string) => void navigator.clipboard?.writeText(v);

  const inspectResult = (() => {
    const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(inspect.trim());
    if (!m) return null;
    const n = (m[1]! + m[2]! + m[3]! + m[4]! + m[5]!).toLowerCase();
    const ver = parseInt(n[12]!, 16);
    const varNib = parseInt(n[16]!, 16);
    const variant = varNib >= 0x8 && varNib <= 0xb ? 'RFC 4122' : varNib >= 0xc ? 'Microsoft' : 'NCS/reserved';
    return { version: ver, variant, bytes: n.match(/.{2}/g)!.join(' ') };
  })();

  return (
    <div className="mod">
      <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
        GUID / UUID
      </h3>
      <div className="mod-form">
        <select className="mod-select" value={version} onChange={(e) => setVersion(e.target.value as 'v4' | 'v7')}>
          <option value="v4">UUID v4</option>
          <option value="v7">UUID v7</option>
        </select>
        <select className="mod-select" value={fmt} onChange={(e) => setFmt(e.target.value)}>
          {['D', 'N', 'B', 'P', 'X'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <label className="chk">
          <input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} />
          {t('idgen.upper')}
        </label>
        <button className="mini primary" onClick={() => setSingle(formatGuid(gen(), fmt, upper))}>
          {t('idgen.generate')}
        </button>
        <button className="mini" onClick={() => copy(single)}>
          {t('idgen.copy')}
        </button>
      </div>
      <input className="mod-search rx-pattern" style={{ width: '100%' }} readOnly value={single} />

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('idgen.bulk')}
      </h3>
      <div className="mod-form">
        <span className="count-note">{t('idgen.count')}</span>
        <input className="mod-search" type="number" min={1} max={1000} style={{ maxWidth: 90 }} value={count} onChange={(e) => setCount(Math.max(1, Math.min(1000, +e.target.value || 1)))} />
        <button className="mini primary" onClick={() => setBulk(Array.from({ length: count }, () => formatGuid(gen(), fmt, upper)).join('\n'))}>
          {t('idgen.generate')}
        </button>
        <button className="mini" disabled={!bulk} onClick={() => copy(bulk)}>
          {t('idgen.copyAll')}
        </button>
      </div>
      {bulk && <textarea className="hosts-edit" spellCheck={false} readOnly value={bulk} style={{ minHeight: 120 }} />}

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('idgen.ulidNano')}
      </h3>
      <div className="mod-form">
        <input className="mod-search rx-pattern" readOnly value={ulidVal} />
        <button className="mini primary" onClick={() => setUlidVal(ulid())}>
          {t('idgen.newUlid')}
        </button>
        <button className="mini" onClick={() => copy(ulidVal)}>
          {t('idgen.copy')}
        </button>
      </div>
      <div className="mod-form">
        <input className="mod-search rx-pattern" readOnly value={nanoVal} />
        <span className="count-note">{t('idgen.nanoLen')}</span>
        <input className="mod-search" type="number" min={4} max={64} style={{ maxWidth: 80 }} value={nanoLen} onChange={(e) => setNanoLen(Math.max(4, Math.min(64, +e.target.value || 21)))} />
        <button className="mini primary" onClick={() => setNanoVal(nanoId(nanoLen))}>
          {t('idgen.newNano')}
        </button>
        <button className="mini" onClick={() => copy(nanoVal)}>
          {t('idgen.copy')}
        </button>
      </div>

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('idgen.inspector')}
      </h3>
      <input className="mod-search rx-pattern" style={{ width: '100%' }} placeholder={t('idgen.inspectPlaceholder')} value={inspect} onChange={(e) => setInspect(e.target.value)} />
      {inspectResult && (
        <table className="dt ct-table" style={{ marginTop: 8 }}>
          <tbody>
            <tr>
              <td style={{ width: 160, color: 'var(--text-tertiary)' }}>{t('idgen.versionLabel')}</td>
              <td>{inspectResult.version}</td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('idgen.variantLabel')}</td>
              <td>{inspectResult.variant}</td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('idgen.bytesLabel')}</td>
              <td>
                <code>{inspectResult.bytes}</code>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
