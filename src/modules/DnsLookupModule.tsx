import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge DnsLookupService. The C# original resolves A/AAAA/PTR through
// System.Net.Dns and MX/TXT/NS/CNAME through Google's public DNS-over-HTTPS JSON
// API (dns.google/resolve). In the browser we route *every* type through the same
// DoH endpoint — it is a public, CORS-enabled, pure client-side fetch (no OS/DNS
// syscalls, no Tauri). PTR queries build the reverse in-addr.arpa/ip6.arpa name.

const RECORD_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'PTR'] as const;
type RecordType = (typeof RECORD_TYPES)[number];

interface DnsAnswer {
  value: string;
  type: string;
  ttl: string;
}

// Numeric DNS record types -> friendly names for display (matches C# TypeName).
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

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]!);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

// Expand an IPv6 address to 32 hex nibbles, or null if not a valid IPv6 literal.
function ipv6Nibbles(s: string): string[] | null {
  if (s.indexOf(':') < 0) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;

  const parseGroups = (seg: string): string[] | null => {
    if (seg.length === 0) return [];
    const groups = seg.split(':');
    for (const g of groups) {
      if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    }
    return groups;
  };

  const head = parseGroups(parts[0]!);
  if (head === null) return null;
  let full: string[];
  if (parts.length === 2) {
    const tail = parseGroups(parts[1]!);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    full = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  } else {
    if (head.length !== 8) return null;
    full = head;
  }
  if (full.length !== 8) return null;

  const nibbles: string[] = [];
  for (const g of full) {
    const padded = g.toLowerCase().padStart(4, '0');
    for (let i = 0; i < 4; i++) nibbles.push(padded.charAt(i));
  }
  return nibbles;
}

// Build the reverse-DNS query name for a PTR lookup, or null if not an IP.
function reverseName(ip: string): string | null {
  const v4 = IPV4_RE.exec(ip);
  if (v4 && isIpv4(ip)) {
    return `${v4[4]}.${v4[3]}.${v4[2]}.${v4[1]}.in-addr.arpa`;
  }
  const nib = ipv6Nibbles(ip);
  if (nib) {
    return nib.reverse().join('.') + '.ip6.arpa';
  }
  return null;
}

interface LookupOutcome {
  answers: DnsAnswer[];
  ok: boolean;
  statusEn: string;
  statusZh: string;
  elapsedMs: number;
}

async function lookup(rawName: string, rawType: string): Promise<LookupOutcome> {
  const start =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const answers: DnsAnswer[] = [];
  let ok = false;
  let statusEn = '';
  let statusZh = '';

  const name = (rawName || '').trim();
  const type = (rawType || 'A').trim().toUpperCase();

  const finish = (): LookupOutcome => {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let en = statusEn;
    let zh = statusZh;
    if (ok && answers.length === 0 && !en && !zh) {
      en = `No ${type} records for "${name}".`;
      zh = `「${name}」冇 ${type} 記錄。`;
    }
    return { answers, ok, statusEn: en, statusZh: zh, elapsedMs: Math.round(now - start) };
  };

  if (!name) {
    statusEn = 'Enter a host name or IP address.';
    statusZh = '請輸入主機名或者 IP 位址。';
    return finish();
  }

  // Determine the actual query name (PTR needs the reverse zone name).
  let queryName = name;
  let queryType = type;
  if (type === 'PTR') {
    const rev = reverseName(name);
    if (rev === null) {
      statusEn = 'PTR (reverse) lookup needs an IP address (e.g. 8.8.8.8).';
      statusZh = 'PTR（反向）查詢需要一個 IP 位址（例如 8.8.8.8）。';
      return finish();
    }
    queryName = rev;
  }

  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(queryName)}&type=${encodeURIComponent(queryType)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!resp.ok) {
      statusEn = 'Network error reaching the DNS-over-HTTPS resolver.';
      statusZh = '連接 DNS-over-HTTPS 解析器時發生網絡錯誤。';
      return finish();
    }
    const root: unknown = await resp.json();
    const obj = (root && typeof root === 'object' ? (root as Record<string, unknown>) : {});

    const status = typeof obj.Status === 'number' ? obj.Status : -1;
    if (status === 3) {
      statusEn = `"${name}" does not exist (NXDOMAIN).`;
      statusZh = `「${name}」唔存在（NXDOMAIN）。`;
      return finish();
    }

    ok = true;
    const rawAnswer = obj.Answer;
    if (Array.isArray(rawAnswer)) {
      for (const item of rawAnswer) {
        if (!item || typeof item !== 'object') continue;
        const ans = item as Record<string, unknown>;
        const data = typeof ans.data === 'string' ? ans.data : '';
        if (data.length === 0) continue;
        const tNum = typeof ans.type === 'number' ? ans.type : 0;
        const ttl = typeof ans.TTL === 'number' ? String(ans.TTL) : '—';
        answers.push({ value: data, type: typeName(tNum), ttl });
      }
    }
    return finish();
  } catch {
    ok = false;
    statusEn = 'Network error reaching the DNS-over-HTTPS resolver.';
    statusZh = '連接 DNS-over-HTTPS 解析器時發生網絡錯誤。';
    return finish();
  }
}

export function DnsLookupModule() {
  const { t, i18n } = useTranslation();

  const [name, setName] = useState('');
  const [type, setType] = useState<RecordType>('A');
  const [answers, setAnswers] = useState<DnsAnswer[]>([]);
  const [status, setStatus] = useState(pick(
    'Enter a host and pick a record type.',
    '輸入主機並揀一個記錄類型。',
    i18n.language,
  ));
  const [busy, setBusy] = useState(false);

  const doLookup = async () => {
    setBusy(true);
    setAnswers([]);
    setStatus(t('dnslookup.looking', { type, name: name.trim() }));
    const result = await lookup(name, type);
    setAnswers(result.answers);
    if (result.statusEn || result.statusZh) {
      setStatus(pick(result.statusEn, result.statusZh, i18n.language));
    } else {
      setStatus(t('dnslookup.answersCount', { count: result.answers.length, ms: result.elapsedMs }));
    }
    setBusy(false);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dnslookup.blurb')}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('dnslookup.nameLabel')}</span>
          <input
            className="mod-search"
            placeholder="example.com"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void doLookup();
            }}
          />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('dnslookup.typeLabel')}</span>
          <select className="mod-select" value={type} onChange={(e) => setType(e.target.value as RecordType)}>
            {RECORD_TYPES.map((rt) => (
              <option key={rt} value={rt}>{rt}</option>
            ))}
          </select>
        </span>
        <button className="mini primary" disabled={busy} onClick={() => void doLookup()}>
          {t('dnslookup.lookUp')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 10 }}>{status}</p>

      {answers.length > 0 && (
        <div className="dt-wrap" style={{ maxHeight: 360, marginTop: 4 }}>
          <table className="dt">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{t('dnslookup.colValue')}</th>
                <th style={{ textAlign: 'left' }}>{t('dnslookup.colType')}</th>
                <th style={{ textAlign: 'left' }}>{t('dnslookup.colTtl')}</th>
              </tr>
            </thead>
            <tbody>
              {answers.map((a, i) => (
                <tr key={`${a.type}-${i}-${a.value}`}>
                  <td style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{a.value}</td>
                  <td style={{ fontFamily: 'monospace' }}>{a.type}</td>
                  <td style={{ fontFamily: 'monospace', opacity: 0.7 }}>{a.ttl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="count-note" style={{ marginTop: 12 }}>{t('dnslookup.resolverNote')}</p>
    </div>
  );
}
