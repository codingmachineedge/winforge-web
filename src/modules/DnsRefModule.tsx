import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface DnsRecord {
  type: string;
  code: number; // -1 = no numeric code
  purposeEn: string;
  purposeZh: string;
  example: string;
}

interface TaskHint {
  taskEn: string;
  taskZh: string;
  record: string;
}

const RECORDS: DnsRecord[] = [
  { type: 'A', code: 1, purposeEn: 'Maps a host name to an IPv4 address.', purposeZh: '將主機名指向一個 IPv4 地址。', example: 'www.example.com.  3600  IN  A     203.0.113.10' },
  { type: 'AAAA', code: 28, purposeEn: 'Maps a host name to an IPv6 address.', purposeZh: '將主機名指向一個 IPv6 地址。', example: 'www.example.com.  3600  IN  AAAA  2001:db8::10' },
  { type: 'CNAME', code: 5, purposeEn: 'Aliases one name to another canonical name (no other records may sit beside it).', purposeZh: '將一個名稱指向另一個正式名稱（同層唔可以有其他記錄）。', example: 'blog.example.com.  3600  IN  CNAME  hosting.example.net.' },
  { type: 'MX', code: 15, purposeEn: 'Directs email for the domain to mail servers, by priority (lower = preferred).', purposeZh: '將域名嘅電郵送去郵件伺服器，按優先次序（數字細＝優先）。', example: 'example.com.  3600  IN  MX  10  mail.example.com.' },
  { type: 'TXT', code: 16, purposeEn: 'Holds arbitrary text — domain verification, SPF, DKIM, DMARC and more.', purposeZh: '存放任意文字 — 網域驗證、SPF、DKIM、DMARC 等。', example: 'example.com.  3600  IN  TXT  "v=spf1 include:_spf.example.com -all"' },
  { type: 'NS', code: 2, purposeEn: 'Delegates a zone to its authoritative name servers.', purposeZh: '將一個區域委派俾佢嘅權威名稱伺服器。', example: 'example.com.  86400  IN  NS  ns1.example.net.' },
  { type: 'SOA', code: 6, purposeEn: "Start of Authority — the zone's primary server, admin contact and timers.", purposeZh: '權威起始 — 區域嘅主伺服器、管理員聯絡同各項計時。', example: 'example.com.  IN  SOA  ns1.example.net. admin.example.com. (2026070101 7200 3600 1209600 3600)' },
  { type: 'SRV', code: 33, purposeEn: 'Advertises the host and port of a specific service (priority, weight, port, target).', purposeZh: '公佈某個服務嘅主機同埠（優先、權重、埠、目標）。', example: '_sip._tcp.example.com.  3600  IN  SRV  10 60 5060 sipserver.example.com.' },
  { type: 'PTR', code: 12, purposeEn: 'Reverse DNS — maps an IP address back to a host name.', purposeZh: '反向 DNS — 將 IP 地址對返去主機名。', example: '10.113.0.203.in-addr.arpa.  3600  IN  PTR  www.example.com.' },
  { type: 'CAA', code: 257, purposeEn: 'Lists which certificate authorities may issue certs for the domain.', purposeZh: '列明邊啲憑證機構先可以為呢個域名簽發憑證。', example: 'example.com.  3600  IN  CAA  0 issue "letsencrypt.org"' },
  { type: 'DNSKEY', code: 48, purposeEn: 'Publishes a DNSSEC public key used to verify signatures in the zone.', purposeZh: '公佈用嚟核實區域簽名嘅 DNSSEC 公鑰。', example: 'example.com.  3600  IN  DNSKEY  257 3 13 mdsswUyr3D...==' },
  { type: 'DS', code: 43, purposeEn: "Delegation Signer — links a child zone's DNSKEY into the parent for DNSSEC.", purposeZh: '委派簽署者 — 為 DNSSEC 將子區域嘅 DNSKEY 連上父區域。', example: 'example.com.  86400  IN  DS  60485 13 2 D4B7D520E7BB5F0F...' },
  { type: 'RRSIG', code: 46, purposeEn: 'The DNSSEC signature over a record set, proving it is authentic.', purposeZh: 'DNSSEC 對某組記錄嘅簽名，證明佢係真確。', example: 'example.com.  3600  IN  RRSIG  A 13 2 3600 20260801000000 ...' },
  { type: 'NSEC', code: 47, purposeEn: 'DNSSEC authenticated denial-of-existence — proves a name/type does not exist.', purposeZh: 'DNSSEC 認證式否認 — 證明某名稱／類型並不存在。', example: 'alpha.example.com.  3600  IN  NSEC  beta.example.com. A RRSIG NSEC' },
  { type: 'TLSA', code: 52, purposeEn: 'DANE — pins a TLS certificate or key to a name via DNSSEC.', purposeZh: 'DANE — 透過 DNSSEC 將 TLS 憑證或金鑰綁定到某名稱。', example: '_443._tcp.www.example.com.  3600  IN  TLSA  3 1 1 0b9fa5a59eed715c...' },
  { type: 'SSHFP', code: 44, purposeEn: 'Publishes an SSH host key fingerprint for verification.', purposeZh: '公佈 SSH 主機金鑰指紋以供核實。', example: 'host.example.com.  3600  IN  SSHFP  4 2 123456789abcdef...' },
  { type: 'SPF', code: 99, purposeEn: 'Legacy SPF record type (now use TXT). Lists permitted mail senders.', purposeZh: '舊式 SPF 記錄類型（而家用 TXT）。列明獲准嘅寄件伺服器。', example: 'example.com.  3600  IN  TXT  "v=spf1 ip4:203.0.113.0/24 -all"' },
  { type: 'DKIM', code: -1, purposeEn: 'DomainKeys — a TXT record at a selector holding the email signing public key.', purposeZh: 'DomainKeys — 放喺選擇器下嘅 TXT 記錄，存放電郵簽名公鑰。', example: 'sel1._domainkey.example.com.  IN  TXT  "v=DKIM1; k=rsa; p=MIGfMA0G..."' },
  { type: 'DMARC', code: -1, purposeEn: 'A TXT record at _dmarc setting the policy for failed SPF/DKIM mail.', purposeZh: '放喺 _dmarc 嘅 TXT 記錄，設定 SPF／DKIM 失敗郵件嘅處理政策。', example: '_dmarc.example.com.  IN  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"' },
  { type: 'NAPTR', code: 35, purposeEn: 'Naming Authority Pointer — rule-based rewriting for ENUM / SIP discovery.', purposeZh: '命名權威指標 — 用規則改寫，供 ENUM／SIP 探索使用。', example: 'example.com.  3600  IN  NAPTR  100 10 "U" "E2U+sip" "!^.*$!sip:info@example.com!" .' },
  { type: 'HTTPS', code: 65, purposeEn: 'SVCB for HTTPS — advertises ALPN, port and hints so clients connect faster.', purposeZh: 'HTTPS 版 SVCB — 公佈 ALPN、埠同提示，令客戶端連接更快。', example: 'example.com.  3600  IN  HTTPS  1 . alpn="h3,h2" ipv4hint=203.0.113.10' },
  { type: 'SVCB', code: 64, purposeEn: 'Service Binding — generic service parameters and endpoint hints for a name.', purposeZh: '服務綁定 — 為某名稱提供通用服務參數同端點提示。', example: '_foo.example.com.  3600  IN  SVCB  1 svc.example.net. port=8080' },
  { type: 'ALIAS', code: -1, purposeEn: 'Provider CNAME-flattening — CNAME-like behaviour that is legal at the zone apex.', purposeZh: '供應商嘅 CNAME 扁平化 — 似 CNAME，但可以用喺區域頂點。', example: 'example.com.  3600  IN  ALIAS  target.hosting.net.' },
  { type: 'ANAME', code: -1, purposeEn: 'Same idea as ALIAS under a different vendor name — apex CNAME flattening.', purposeZh: '同 ALIAS 一樣，只係唔同供應商叫法 — 頂點 CNAME 扁平化。', example: 'example.com.  3600  IN  ANAME  target.hosting.net.' },
  { type: 'CERT', code: 37, purposeEn: 'Stores a certificate or certificate-revocation list in the DNS.', purposeZh: '喺 DNS 內存放憑證或憑證撤銷清單。', example: 'example.com.  3600  IN  CERT  1 0 0 MIICajCCAdOgAwIBAgIC...' },
  { type: 'LOC', code: 29, purposeEn: 'Encodes a geographic location (lat/long/altitude) for a name.', purposeZh: '為某名稱記錄地理位置（緯度／經度／海拔）。', example: 'example.com.  3600  IN  LOC  52 22 23.000 N 4 53 32.000 E -2.00m' },
  { type: 'HINFO', code: 13, purposeEn: 'Host information — CPU and OS strings (often used to blunt ANY queries).', purposeZh: '主機資訊 — CPU 同作業系統字串（常用嚟弱化 ANY 查詢）。', example: 'example.com.  3600  IN  HINFO  "RFC8482" ""' },
  { type: 'RP', code: 17, purposeEn: 'Responsible Person — a contact mailbox and TXT reference for the name.', purposeZh: '負責人 — 該名稱嘅聯絡信箱同 TXT 參照。', example: 'example.com.  3600  IN  RP  admin.example.com. contact.example.com.' },
  { type: 'URI', code: 256, purposeEn: 'Maps a name to a URI with priority and weight (service discovery).', purposeZh: '將名稱對應到一個 URI，附優先同權重（服務探索）。', example: '_http._tcp.example.com.  3600  IN  URI  10 1 "https://www.example.com/"' },
  { type: 'OPENPGPKEY', code: 61, purposeEn: 'Publishes an OpenPGP public key for an email address (DANE for PGP).', purposeZh: '為某電郵地址公佈 OpenPGP 公鑰（PGP 版 DANE）。', example: 'hash._openpgpkey.example.com.  IN  OPENPGPKEY  mQENBF...==' },
  { type: 'SMIMEA', code: 53, purposeEn: 'Associates an S/MIME certificate with an email address via DNSSEC.', purposeZh: '透過 DNSSEC 將 S/MIME 憑證同某電郵地址關聯。', example: 'hash._smimecert.example.com.  IN  SMIMEA  3 0 0 308202...' },
  { type: 'CDS', code: 59, purposeEn: 'Child copy of a DS record used to automate DNSSEC key rollover to the parent.', purposeZh: 'DS 記錄嘅子區域副本，用嚟自動將 DNSSEC 換鑰交上父區域。', example: 'example.com.  3600  IN  CDS  60485 13 2 D4B7D520E7BB5F0F...' },
  { type: 'DNAME', code: 39, purposeEn: 'Redirects an entire subtree of names to another domain.', purposeZh: '將成個名稱子樹重新導向去另一個域名。', example: 'old.example.com.  3600  IN  DNAME  new.example.net.' },
];

const HINTS: TaskHint[] = [
  { taskEn: 'Verify domain ownership', taskZh: '驗證域名擁有權', record: 'TXT' },
  { taskEn: 'Route incoming mail', taskZh: '接收電郵', record: 'MX' },
  { taskEn: 'Point a subdomain at another name', taskZh: '將子域名指向另一名稱', record: 'CNAME' },
  { taskEn: 'Point the root domain (apex) at a host', taskZh: '將根域名（頂點）指向主機', record: 'A / AAAA / ALIAS' },
  { taskEn: 'Stop mail spoofing', taskZh: '防止電郵假冒', record: 'TXT (SPF / DKIM / DMARC)' },
  { taskEn: 'Restrict who can issue TLS certs', taskZh: '限制邊個可簽發 TLS 憑證', record: 'CAA' },
  { taskEn: "Delegate a subdomain's DNS", taskZh: '委派子域名嘅 DNS', record: 'NS' },
  { taskEn: 'Advertise a service host + port', taskZh: '公佈服務主機同埠', record: 'SRV' },
  { taskEn: 'Set up reverse DNS for an IP', taskZh: '為 IP 設定反向 DNS', record: 'PTR' },
  { taskEn: 'Speed up HTTPS with ALPN hints', taskZh: '用 ALPN 提示加快 HTTPS', record: 'HTTPS / SVCB' },
  { taskEn: 'Sign a zone with DNSSEC', taskZh: '用 DNSSEC 簽署區域', record: 'DNSKEY / DS / RRSIG' },
];

// Category → member record types. "All" and "Modern" mirror DnsRefService.
const CATEGORY_KEYS = ['All', 'Addressing', 'Mail', 'Security', 'Service', 'Modern'] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

const CATEGORY_MEMBERS: Record<Exclude<CategoryKey, 'All'>, string[]> = {
  Addressing: ['A', 'AAAA', 'CNAME', 'NS', 'SOA', 'PTR', 'ALIAS', 'ANAME', 'DNAME'],
  Mail: ['MX', 'TXT', 'SPF', 'DKIM', 'DMARC'],
  Security: ['DNSKEY', 'DS', 'RRSIG', 'NSEC', 'TLSA', 'SSHFP', 'CAA', 'CERT', 'OPENPGPKEY', 'SMIMEA', 'CDS'],
  Service: ['SRV', 'NAPTR', 'URI', 'LOC', 'HINFO', 'RP'],
  Modern: ['HTTPS', 'SVCB', 'ALIAS', 'ANAME'],
};

function codeText(code: number): string {
  return code >= 0 ? `#${code}` : '';
}
function typeAndCode(r: DnsRecord): string {
  return r.code >= 0 ? `${r.type}  ·  ${codeText(r.code)}` : r.type;
}

export function DnsRefModule() {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh') || (i18n.language || '').toLowerCase().startsWith('yue');

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryKey>('All');
  const [msg, setMsg] = useState('');

  const filtered = useMemo(() => {
    let src = RECORDS;
    if (category !== 'All') {
      const members = CATEGORY_MEMBERS[category];
      const set = new Set(members.map((m) => m.toUpperCase()));
      src = src.filter((r) => set.has(r.type.toUpperCase()));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      src = src.filter(
        (r) =>
          r.type.toLowerCase().includes(q) ||
          codeText(r.code).toLowerCase().includes(q) ||
          String(r.code).toLowerCase().includes(q) ||
          r.purposeEn.toLowerCase().includes(q) ||
          r.purposeZh.toLowerCase().includes(q) ||
          r.example.toLowerCase().includes(q),
      );
    }
    return src;
  }, [query, category]);

  const copyExample = (r: DnsRecord) => {
    try {
      void navigator.clipboard?.writeText(r.example);
      setMsg(t('dnsref.copied', { type: r.type }));
    } catch {
      setMsg(t('dnsref.copyFail'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dnsref.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('dnsref.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="mod-select" value={category} onChange={(e) => setCategory(e.target.value as CategoryKey)}>
          {CATEGORY_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(`dnsref.cat.${k}`)}
            </option>
          ))}
        </select>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dnsref.listHint')} · {t('dnsref.showing', { n: filtered.length })}
      </p>

      <div className="dt-wrap" style={{ maxHeight: 520 }}>
        <table className="dt">
          <tbody>
            {filtered.map((r) => (
              <tr key={r.type} style={{ cursor: 'pointer' }} onClick={() => copyExample(r)} title={t('dnsref.clickToCopy')}>
                <td>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{typeAndCode(r)}</div>
                  <div className="env-val" style={{ fontSize: 12 }}>{isZh ? r.purposeZh : r.purposeEn}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.75, marginTop: 2, wordBreak: 'break-all' }}>{r.example}</div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td className="count-note">{t('dnsref.noMatch')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="group-title" style={{ fontSize: 15, marginBottom: 6, marginTop: 16 }}>
        {t('dnsref.hintsTitle')}
      </h3>
      <div className="kv-list">
        {HINTS.map((h) => (
          <div className="kv-row" key={h.taskEn}>
            <span>{isZh ? h.taskZh : h.taskEn}</span>
            <code>{h.record}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
