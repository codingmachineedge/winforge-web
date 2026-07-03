import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge SubnetCalcService (IPv4 uint bit math).
function parseIPv4(text: string): number | null {
  const t = text.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (!m) return null;
  const b = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  if (b.some((x) => x > 255)) return null;
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}
const toDotted = (v: number) => `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
const maskFromPrefix = (p: number) => (p <= 0 ? 0 : p >= 32 ? 0xffffffff : (0xffffffff << (32 - p)) >>> 0);
function prefixFromMask(mask: number): number {
  const inv = (~mask) >>> 0;
  if (((inv & (inv + 1)) >>> 0) !== 0) return -1;
  let count = 0, m = mask;
  while (m !== 0) { count += m & 1; m >>>= 1; }
  return count;
}
function classOf(ip: number): string {
  const first = (ip >>> 24) & 0xff;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D';
  return 'E';
}
function isPrivate(ip: number): boolean {
  const a = (ip >>> 24) & 0xff, b = (ip >>> 16) & 0xff;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
interface Result {
  network: number; broadcast: number; mask: number; wildcard: number;
  first: number; last: number; total: number; usable: number; cls: string; priv: boolean; prefix: number;
}
function compute(ip: number, prefix: number): Result | null {
  if (prefix < 0 || prefix > 32) return null;
  const mask = maskFromPrefix(prefix);
  const wildcard = (~mask) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const total = 2 ** (32 - prefix);
  let first: number, last: number, usable: number;
  if (prefix >= 31) {
    first = network; last = broadcast; usable = prefix === 32 ? 1 : 2;
  } else {
    first = (network + 1) >>> 0; last = (broadcast - 1) >>> 0; usable = total - 2;
  }
  return { network, broadcast, mask, wildcard, first, last, total, usable, cls: classOf(ip), priv: isPrivate(ip), prefix };
}
function prefixForCount(currentPrefix: number, count: number): number {
  if (count <= 1) return currentPrefix;
  let bits = 0, n = 1;
  while (n < count) { n <<= 1; bits++; }
  const p = currentPrefix + bits;
  return p > 32 ? 32 : p;
}

export function SubnetCalcModule() {
  const { t } = useTranslation();
  const [ip, setIp] = useState('192.168.1.10');
  const [prefix, setPrefix] = useState(24);
  const [maskText, setMaskText] = useState('255.255.255.0');
  const [newPrefix, setNewPrefix] = useState(26);
  const [count, setCount] = useState(0);
  const [split, setSplit] = useState<string>('');

  const onPrefix = (p: number) => {
    const cl = Math.max(0, Math.min(32, p));
    setPrefix(cl);
    setMaskText(toDotted(maskFromPrefix(cl)));
  };
  const onMask = (v: string) => {
    setMaskText(v);
    const m = parseIPv4(v);
    if (m !== null) { const p = prefixFromMask(m); if (p >= 0) setPrefix(p); }
  };

  const currentPrefix = useMemo(() => {
    const m = parseIPv4(maskText);
    if (m !== null) { const p = prefixFromMask(m); if (p >= 0) return p; }
    return prefix;
  }, [maskText, prefix]);

  const { result, status } = useMemo(() => {
    const ipv = parseIPv4(ip);
    if (ipv === null) return { result: null, status: { ok: false, msg: t('subnet.badIp') } };
    const m = parseIPv4(maskText);
    if (maskText.trim() && m !== null && prefixFromMask(m) < 0) return { result: null, status: { ok: false, msg: t('subnet.nonContiguous') } };
    const r = compute(ipv, currentPrefix);
    if (!r) return { result: null, status: { ok: false, msg: t('subnet.badPrefix') } };
    return { result: r, status: { ok: true, msg: `${toDotted(ipv)}/${currentPrefix}` } };
  }, [ip, maskText, currentPrefix, t]);

  const doSplit = () => {
    const ipv = parseIPv4(ip);
    if (ipv === null) { setSplit(t('subnet.badIpFirst')); return; }
    const cur = currentPrefix;
    const np = count > 0 ? prefixForCount(cur, count) : Math.max(0, Math.min(32, newPrefix));
    if (np < cur) { setSplit(t('subnet.newBigger', { np, cur })); return; }
    const baseNet = (ipv & maskFromPrefix(cur)) >>> 0;
    const newMask = maskFromPrefix(np);
    const bits = np - cur;
    const totalWanted = 2 ** bits;
    const cap = 256;
    const shown = Math.min(totalWanted, cap);
    const step = 2 ** (32 - np);
    const lines: string[] = [t('subnet.splitHead', { base: toDotted(baseNet), cur, count: totalWanted, np }), ''];
    for (let i = 0; i < shown; i++) {
      const sub = (baseNet + i * step) >>> 0;
      lines.push(`${String(i + 1).padStart(4)}.  ${toDotted(sub)}/${np}   ${toDotted(newMask)}`);
    }
    if (totalWanted > shown) lines.push(t('subnet.splitMore', { shown, total: totalWanted }));
    setSplit(lines.join('\n'));
  };

  const D = toDotted;
  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('subnet.ip')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 160, fontFamily: 'monospace' }} value={ip} onChange={(e) => setIp(e.target.value)} />
        <label className="count-note">{t('subnet.cidr')}</label>
        <input className="mod-search" type="number" min={0} max={32} style={{ maxWidth: 70 }} value={prefix} onChange={(e) => onPrefix(+e.target.value)} />
        <label className="count-note">{t('subnet.mask')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 150, fontFamily: 'monospace' }} value={maskText} onChange={(e) => onMask(e.target.value)} />
      </div>
      {result ? (
        <div className="panel">
          <table className="dt">
            <tbody>
              <tr><td>{t('subnet.network')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.network)}/{result.prefix}</td></tr>
              <tr><td>{t('subnet.broadcast')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.broadcast)}</td></tr>
              <tr><td>{t('subnet.subnetMask')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.mask)}</td></tr>
              <tr><td>{t('subnet.wildcard')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.wildcard)}</td></tr>
              {result.prefix <= 30 ? (
                <>
                  <tr><td>{t('subnet.firstHost')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.first)}</td></tr>
                  <tr><td>{t('subnet.lastHost')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.last)}</td></tr>
                </>
              ) : (
                <tr><td>{t('subnet.hostRange')}</td><td style={{ fontFamily: 'monospace' }}>{D(result.first)} – {D(result.last)}</td></tr>
              )}
              <tr><td>{t('subnet.total')}</td><td>{result.total.toLocaleString()}</td></tr>
              <tr><td>{t('subnet.usable')}</td><td>{result.usable.toLocaleString()}</td></tr>
              <tr><td>{t('subnet.class')}</td><td>{result.cls} ({result.priv ? t('subnet.private') : t('subnet.public')})</td></tr>
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="count-note" style={{ color: status.ok ? undefined : 'var(--danger)' }}>{status.ok ? `OK — ${status.msg}` : status.msg}</p>
      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('subnet.splitTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('subnet.newPrefix')}</label>
          <input className="mod-search" type="number" min={0} max={32} style={{ maxWidth: 70 }} value={newPrefix} onChange={(e) => setNewPrefix(+e.target.value)} />
          <label className="count-note">{t('subnet.count')}</label>
          <input className="mod-search" type="number" min={0} style={{ maxWidth: 80 }} value={count} onChange={(e) => setCount(Math.max(0, +e.target.value || 0))} />
          <button className="mini primary" onClick={doSplit}>{t('subnet.split')}</button>
        </div>
        {split && <textarea className="hosts-edit" spellCheck={false} readOnly value={split} style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 180 }} />}
      </div>
    </div>
  );
}
