import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// WinForge's IpInfo module enumerates local adapters (System.Net.NetworkInformation)
// and looks up the public IP over HTTPS — both need OS/network access unavailable in
// a pure client-side browser. Per the porting brief we build the offline-capable part:
// an IPv4/IPv6 address + subnet analyzer (parse, validate, classify, binary, subnet
// math, IPv6 expansion). All pure computation, no network or OS calls.

type Lang = string;

// ---- IPv4 ------------------------------------------------------------------

// Parse dotted-quad into a 32-bit unsigned integer. Returns null if malformed.
function parseIPv4(text: string): number | null {
  const parts = text.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    // Reject leading zeros like "01" to stay strict (except plain "0").
    if (p.length > 1 && p.charAt(0) === '0') return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipv4ToString(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

function ipv4ToBinary(value: number): string {
  const v = value >>> 0;
  const octet = (n: number) => n.toString(2).padStart(8, '0');
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].map(octet).join('.');
}

function ipv4ToHex(value: number): string {
  return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Classify an IPv4 address into a bilingual category label.
function classifyIPv4(value: number, lang: Lang): string {
  const v = value >>> 0;
  const a = (v >>> 24) & 0xff;
  const b = (v >>> 16) & 0xff;
  if (v === 0) return pick('This host (0.0.0.0)', '本主機（0.0.0.0）', lang);
  if (a === 127) return pick('Loopback', '回送（Loopback）', lang);
  if (a === 10) return pick('Private (10.0.0.0/8)', '私有（10.0.0.0/8）', lang);
  if (a === 172 && b >= 16 && b <= 31) return pick('Private (172.16.0.0/12)', '私有（172.16.0.0/12）', lang);
  if (a === 192 && b === 168) return pick('Private (192.168.0.0/16)', '私有（192.168.0.0/16）', lang);
  if (a === 169 && b === 254) return pick('Link-local (APIPA)', '連結本地（APIPA）', lang);
  if (a === 100 && b >= 64 && b <= 127) return pick('Carrier-grade NAT (100.64.0.0/10)', '電信級 NAT（100.64.0.0/10）', lang);
  if (a >= 224 && a <= 239) return pick('Multicast', '多播（Multicast）', lang);
  if (a >= 240) return pick('Reserved', '保留', lang);
  if (v === 0xffffffff) return pick('Broadcast', '廣播', lang);
  return pick('Public / global unicast', '公開／全球單播', lang);
}

interface SubnetInfo {
  network: string;
  broadcast: string;
  first: string;
  last: string;
  mask: string;
  wildcard: string;
  prefix: number;
  totalHosts: string;
  usableHosts: string;
}

function computeSubnet(value: number, prefix: number): SubnetInfo {
  const p = Math.max(0, Math.min(32, prefix));
  // Mask as unsigned. prefix 0 -> 0, prefix 32 -> 0xFFFFFFFF.
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  const network = (value & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = Math.pow(2, 32 - p);
  let first = network;
  let last = broadcast;
  let usable = total - 2;
  if (p >= 31) {
    // /31 and /32 have no separate network/broadcast (RFC 3021 / host route).
    first = network;
    last = broadcast;
    usable = p === 32 ? 1 : 2;
  } else {
    first = (network + 1) >>> 0;
    last = (broadcast - 1) >>> 0;
  }
  return {
    network: ipv4ToString(network),
    broadcast: ipv4ToString(broadcast),
    first: ipv4ToString(first),
    last: ipv4ToString(last),
    mask: ipv4ToString(mask),
    wildcard: ipv4ToString(~mask >>> 0),
    prefix: p,
    totalHosts: total.toLocaleString(),
    usableHosts: Math.max(0, usable).toLocaleString(),
  };
}

// ---- IPv6 ------------------------------------------------------------------

// Parse an IPv6 address into eight 16-bit groups. Handles "::" compression.
// Returns null if malformed. Does not handle embedded IPv4 (kept strict/simple).
function parseIPv6(text: string): number[] | null {
  const s = text.trim().toLowerCase();
  if (s.length === 0) return null;
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const doubleColon = s.indexOf('::');
  if (doubleColon !== s.lastIndexOf('::')) return null; // at most one "::"

  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    const before = s.slice(0, doubleColon);
    const after = s.slice(doubleColon + 2);
    head = before.length > 0 ? before.split(':') : [];
    tail = after.length > 0 ? after.split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }

  for (const g of head.concat(tail)) {
    if (g.length === 0 || g.length > 4) return null;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }

  const missing = 8 - (head.length + tail.length);
  if (doubleColon >= 0) {
    if (missing < 1) return null; // "::" must stand for at least one group
  } else if (missing !== 0) {
    return null; // full form needs exactly 8 groups
  }

  const groups: number[] = [];
  for (const g of head) groups.push(parseInt(g, 16));
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const g of tail) groups.push(parseInt(g, 16));
  if (groups.length !== 8) return null;
  return groups;
}

function ipv6Full(groups: number[]): string {
  return groups.map((g) => g.toString(16).padStart(4, '0')).join(':');
}

// RFC 5952 canonical compression: longest run of zero groups (>=2) -> "::".
function ipv6Compressed(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLen).join(':');
  return `${before}::${after}`;
}

function classifyIPv6(groups: number[], lang: Lang): string {
  const g0 = groups[0]!;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return pick('Unspecified (::)', '未指定（::）', lang);
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return pick('Loopback (::1)', '回送（::1）', lang);
  }
  if ((g0 & 0xffc0) === 0xfe80) return pick('Link-local (fe80::/10)', '連結本地（fe80::/10）', lang);
  if ((g0 & 0xfe00) === 0xfc00) return pick('Unique local (fc00::/7)', '唯一本地（fc00::/7）', lang);
  if ((g0 & 0xff00) === 0xff00) return pick('Multicast (ff00::/8)', '多播（ff00::/8）', lang);
  if ((g0 & 0xe000) === 0x2000) return pick('Global unicast (2000::/3)', '全球單播（2000::/3）', lang);
  return pick('Reserved / other', '保留／其他', lang);
}

// ---- Component -------------------------------------------------------------

type Kind = 'ipv4' | 'ipv6' | 'invalid';

interface Parsed {
  kind: Kind;
  v4?: number;
  v6?: number[];
  prefix?: number;
}

// Split an input into an address and optional /prefix, then parse whichever family matches.
function parseInput(raw: string): Parsed {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'invalid' };
  let addr = text;
  let prefix: number | undefined;
  const slash = text.indexOf('/');
  if (slash >= 0) {
    addr = text.slice(0, slash).trim();
    const rest = text.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(rest)) return { kind: 'invalid' };
    prefix = Number(rest);
  }

  if (addr.indexOf(':') >= 0) {
    const v6 = parseIPv6(addr);
    if (v6) {
      if (prefix !== undefined && prefix > 128) return { kind: 'invalid' };
      return { kind: 'ipv6', v6, prefix };
    }
    return { kind: 'invalid' };
  }
  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    if (prefix !== undefined && prefix > 32) return { kind: 'invalid' };
    return { kind: 'ipv4', v4, prefix };
  }
  return { kind: 'invalid' };
}

export function IpInfoModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const [input, setInput] = useState('192.168.1.42/24');
  const [copied, setCopied] = useState('');

  const parsed = useMemo(() => parseInput(input), [input]);

  const copy = (text: string, tag: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text);
    setCopied(tag);
  };

  const kvRow = (label: string, value: string, tag: string) => (
    <div className="kv-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span className="count-note" style={{ margin: 0, minWidth: 150 }}>
        {label}
      </span>
      <input
        className="mod-search"
        style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
        readOnly
        value={value}
      />
      <button className="mini" onClick={() => copy(value, tag)}>
        {t('ipinfo.copy')}
      </button>
    </div>
  );

  const v4 = parsed.kind === 'ipv4' ? parsed.v4! : null;
  const subnet =
    v4 !== null && parsed.prefix !== undefined ? computeSubnet(v4, parsed.prefix) : null;
  const v6 = parsed.kind === 'ipv6' ? parsed.v6! : null;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ipinfo.blurb')}
      </p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ipinfo.offlineNote')}
      </p>

      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('ipinfo.inputTitle')}
        </h3>
        <input
          className="mod-search"
          style={{ fontFamily: 'Consolas, monospace' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('ipinfo.inputPlaceholder')}
        />
        <span className="count-note" style={{ margin: 0 }}>
          {parsed.kind === 'invalid'
            ? input.trim().length === 0
              ? t('ipinfo.enterValue')
              : t('ipinfo.invalid')
            : parsed.kind === 'ipv4'
              ? t('ipinfo.detectedV4')
              : t('ipinfo.detectedV6')}
        </span>
      </div>

      {v4 !== null && (
        <div
          className="kv-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}
        >
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
            {t('ipinfo.addressTitle')}
          </h3>
          {kvRow(t('ipinfo.category'), classifyIPv4(v4, lang), 'v4cat')}
          {kvRow(t('ipinfo.dotted'), ipv4ToString(v4), 'v4dot')}
          {kvRow(t('ipinfo.decimal'), (v4 >>> 0).toString(), 'v4dec')}
          {kvRow(t('ipinfo.hex'), ipv4ToHex(v4), 'v4hex')}
          {kvRow(t('ipinfo.binary'), ipv4ToBinary(v4), 'v4bin')}
        </div>
      )}

      {subnet && (
        <div
          className="kv-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}
        >
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
            {t('ipinfo.subnetTitle', { prefix: subnet.prefix })}
          </h3>
          {kvRow(t('ipinfo.netmask'), subnet.mask, 'mask')}
          {kvRow(t('ipinfo.wildcard'), subnet.wildcard, 'wild')}
          {kvRow(t('ipinfo.network'), subnet.network, 'net')}
          {kvRow(t('ipinfo.broadcast'), subnet.broadcast, 'bcast')}
          {kvRow(t('ipinfo.firstHost'), subnet.first, 'first')}
          {kvRow(t('ipinfo.lastHost'), subnet.last, 'last')}
          {kvRow(t('ipinfo.totalAddrs'), subnet.totalHosts, 'total')}
          {kvRow(t('ipinfo.usableHosts'), subnet.usableHosts, 'usable')}
        </div>
      )}

      {v4 !== null && parsed.prefix === undefined && (
        <p className="count-note" style={{ marginTop: 12 }}>
          {t('ipinfo.addPrefixHint')}
        </p>
      )}

      {v6 !== null && (
        <div
          className="kv-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}
        >
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
            {t('ipinfo.addressTitle')}
          </h3>
          {kvRow(t('ipinfo.category'), classifyIPv6(v6, lang), 'v6cat')}
          {kvRow(t('ipinfo.compressed'), ipv6Compressed(v6), 'v6comp')}
          {kvRow(t('ipinfo.expanded'), ipv6Full(v6), 'v6full')}
          {parsed.prefix !== undefined &&
            kvRow(t('ipinfo.prefixLen'), '/' + parsed.prefix, 'v6prefix')}
        </div>
      )}

      {copied && (
        <p className="count-note" style={{ marginTop: 12 }}>
          {t('ipinfo.copied')}
        </p>
      )}
    </div>
  );
}
