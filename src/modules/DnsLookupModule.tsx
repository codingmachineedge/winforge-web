import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

const TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'PTR'] as const;
type RecordType = (typeof TYPES)[number];

interface DnsAnswer {
  value: string;
  type: string;
  ttl: string;
}

interface DnsResult {
  answers: DnsAnswer[];
  elapsedMs: number;
  ok: boolean;
  statusEn: string;
  statusZh: string;
}

// Numeric DNS record types -> friendly names for display.
function typeName(t: number): string {
  switch (t) {
    case 1:
      return 'A';
    case 2:
      return 'NS';
    case 5:
      return 'CNAME';
    case 6:
      return 'SOA';
    case 12:
      return 'PTR';
    case 15:
      return 'MX';
    case 16:
      return 'TXT';
    case 28:
      return 'AAAA';
    default:
      return 'TYPE' + t;
  }
}

// Build the reverse-DNS name (in-addr.arpa / ip6.arpa) for a PTR query.
function reverseName(ip: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    if (parts.every((p) => Number(p) <= 255)) return parts.slice().reverse().join('.') + '.in-addr.arpa';
    return null;
  }
  if (ip.includes(':')) {
    // Expand an IPv6 address to full 32 nibbles.
    const half = ip.split('::');
    const expand = (seg: string) => (seg ? seg.split(':') : []);
    let groups: string[];
    if (half.length === 2) {
      const left = expand(half[0]!);
      const right = expand(half[1]!);
      const fill = 8 - left.length - right.length;
      if (fill < 0) return null;
      groups = [...left, ...Array<string>(fill).fill('0'), ...right];
    } else if (half.length === 1) {
      groups = expand(half[0]!);
    } else {
      return null;
    }
    if (groups.length !== 8) return null;
    let nibbles = '';
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      nibbles += g.padStart(4, '0').toLowerCase();
    }
    return nibbles.split('').reverse().join('.') + '.ip6.arpa';
  }
  return null;
}

async function lookup(rawName: string, type: RecordType): Promise<DnsResult> {
  const result: DnsResult = { answers: [], elapsedMs: 0, ok: false, statusEn: '', statusZh: '' };
  const started = performance.now();
  const name = (rawName || '').trim();

  if (!name) {
    result.statusEn = 'Enter a host name or IP address.';
    result.statusZh = '請輸入主機名或者 IP 位址。';
    result.elapsedMs = Math.round(performance.now() - started);
    return result;
  }

  // PTR queries need an IP address, converted to a reverse-lookup name.
  let queryName = name;
  const queryType: string = type;
  if (type === 'PTR') {
    const rev = reverseName(name);
    if (!rev) {
      result.statusEn = 'PTR (reverse) lookup needs an IP address (e.g. 8.8.8.8).';
      result.statusZh = 'PTR（反向）查詢需要一個 IP 位址（例如 8.8.8.8）。';
      result.elapsedMs = Math.round(performance.now() - started);
      return result;
    }
    queryName = rev;
  }

  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(queryName)}&type=${encodeURIComponent(queryType)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!resp.ok) {
      result.statusEn = 'Network error reaching the DNS-over-HTTPS resolver.';
      result.statusZh = '連接 DNS-over-HTTPS 解析器時發生網絡錯誤。';
      result.elapsedMs = Math.round(performance.now() - started);
      return result;
    }
    const doc = (await resp.json()) as { Status?: number; Answer?: Array<{ data?: string; type?: number; TTL?: number }> };

    // Status 3 = NXDOMAIN.
    const status = typeof doc.Status === 'number' ? doc.Status : -1;
    if (status === 3) {
      result.statusEn = `"${name}" does not exist (NXDOMAIN).`;
      result.statusZh = `「${name}」唔存在（NXDOMAIN）。`;
      result.elapsedMs = Math.round(performance.now() - started);
      return result;
    }

    result.ok = true;
    if (Array.isArray(doc.Answer)) {
      for (const ans of doc.Answer) {
        const data = typeof ans.data === 'string' ? ans.data : '';
        if (!data) continue;
        const nt = typeof ans.type === 'number' ? ans.type : 0;
        const ttl = typeof ans.TTL === 'number' ? String(ans.TTL) : '—';
        result.answers.push({ value: data, type: typeName(nt), ttl });
      }
    }
  } catch {
    result.statusEn = 'Network error reaching the DNS-over-HTTPS resolver.';
    result.statusZh = '連接 DNS-over-HTTPS 解析器時發生網絡錯誤。';
    result.elapsedMs = Math.round(performance.now() - started);
    return result;
  }

  result.elapsedMs = Math.round(performance.now() - started);
  if (result.ok && result.answers.length === 0) {
    result.statusEn = `No ${type} records for "${name}".`;
    result.statusZh = `「${name}」冇 ${type} 記錄。`;
  }
  return result;
}

export function DnsLookupModule() {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [type, setType] = useState<RecordType>('A');
  const [answers, setAnswers] = useState<DnsAnswer[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setAnswers([]);
    setStatus(t('dnslookup.looking', { type, name: name.trim() }));
    const result = await lookup(name, type);
    setAnswers(result.answers);
    if (result.statusEn || result.statusZh) {
      setStatus(pick(result.statusEn, result.statusZh, i18n.language));
    } else {
      setStatus(t('dnslookup.answersCount', { n: result.answers.length, ms: result.elapsedMs }));
    }
    setBusy(false);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dnslookup.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="example.com"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void run();
          }}
          aria-label={t('dnslookup.nameLabel')}
        />
        <select className="mod-select" value={type} onChange={(e) => setType(e.target.value as RecordType)} aria-label={t('dnslookup.typeLabel')}>
          {TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {ty}
            </option>
          ))}
        </select>
        <button className="mini primary" disabled={busy} onClick={() => void run()}>
          {t('dnslookup.lookup')}
        </button>
      </div>

      {status && (
        <p className="count-note" style={{ marginTop: 4 }}>
          {status}
        </p>
      )}

      {answers.length > 0 && (
        <div className="dt-wrap" style={{ maxHeight: 360, marginTop: 8 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>{t('dnslookup.colValue')}</th>
                <th style={{ width: 80 }}>{t('dnslookup.colType')}</th>
                <th style={{ width: 90 }}>{t('dnslookup.colTtl')}</th>
              </tr>
            </thead>
            <tbody>
              {answers.map((a, i) => (
                <tr key={`${a.type}-${i}-${a.value}`}>
                  <td style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{a.value}</td>
                  <td>{a.type}</td>
                  <td className="env-val">{a.ttl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="count-note" style={{ marginTop: 12 }}>
        {t('dnslookup.resolverNote')}
      </p>
    </div>
  );
}
