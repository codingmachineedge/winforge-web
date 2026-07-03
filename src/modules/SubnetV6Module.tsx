import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// ---------------------------------------------------------------------------
// Faithful web-only port of WinForge SubnetV6Service.
// The C# code leans on System.Net.IPAddress + BigInteger; here we reimplement
// IPv6 parsing, RFC-5952 compression, classification, prefix math and MAC→EUI-64
// against a 16-byte array. Every helper is defensive and never throws.
// ---------------------------------------------------------------------------

type Bytes16 = number[]; // length 16, each 0..255

interface ParseResult {
  ok: boolean;
  error?: 'empty' | 'badprefix' | 'notv6' | 'badaddr';
  bytes?: Bytes16;
  prefix?: number; // 0..128 when supplied inline, else undefined
}

// Parse a group list around an optional "::". Returns 16 bytes or null.
function parseIPv6Core(text: string): Bytes16 | null {
  try {
    let s = text.trim();
    if (s.length === 0) return null;
    // Reject anything with characters outside hex / colon / dot.
    if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;

    // Handle an embedded IPv4 tail (e.g. ::ffff:192.168.0.1).
    const dotIdx = s.indexOf('.');
    let tailBytes: number[] | null = null;
    if (dotIdx >= 0) {
      const lastColon = s.lastIndexOf(':');
      if (lastColon < 0) return null;
      const v4 = s.slice(lastColon + 1);
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
      if (!m) return null;
      const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map((x) => Number(x));
      if (parts.some((x) => x > 255)) return null;
      tailBytes = parts;
      // Replace the v4 tail with two 16-bit groups so the rest parses uniformly.
      const g1 = ((parts[0]! << 8) | parts[1]!).toString(16);
      const g2 = ((parts[2]! << 8) | parts[3]!).toString(16);
      s = s.slice(0, lastColon + 1) + g1 + ':' + g2;
    }

    // Split around "::" (at most one allowed).
    const dblIdx = s.indexOf('::');
    let head: string[];
    let tail: string[];
    if (dblIdx >= 0) {
      if (s.indexOf('::', dblIdx + 1) >= 0) return null; // two "::"
      const before = s.slice(0, dblIdx);
      const after = s.slice(dblIdx + 2);
      head = before.length ? before.split(':') : [];
      tail = after.length ? after.split(':') : [];
    } else {
      head = s.split(':');
      tail = [];
    }

    // Validate every group is 1..4 hex digits.
    const groups = [...head, ...tail];
    for (const g of groups) {
      if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    }

    let words: number[];
    if (dblIdx >= 0) {
      const missing = 8 - groups.length;
      if (missing < 0) return null;
      words = [
        ...head.map((g) => parseInt(g, 16)),
        ...Array(missing).fill(0),
        ...tail.map((g) => parseInt(g, 16)),
      ];
    } else {
      if (groups.length !== 8) return null;
      words = groups.map((g) => parseInt(g, 16));
    }
    if (words.length !== 8) return null;

    const bytes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const w = words[i]!;
      if (w < 0 || w > 0xffff || Number.isNaN(w)) return null;
      bytes.push((w >> 8) & 0xff, w & 0xff);
    }
    // Sanity check against the parsed IPv4 tail if present.
    if (tailBytes) {
      // Nothing extra to verify; the group rebuild already used those bytes.
    }
    return bytes;
  } catch {
    return null;
  }
}

// Parse text as IPv6 with an optional "/prefix" and zone id. Never throws.
function parse(input: string | undefined): ParseResult {
  try {
    let text = (input ?? '').trim();
    if (text.length === 0) return { ok: false, error: 'empty' };

    let prefix: number | undefined;
    const slash = text.indexOf('/');
    if (slash >= 0) {
      const pfxPart = text.slice(slash + 1).trim();
      text = text.slice(0, slash).trim();
      if (!/^\d+$/.test(pfxPart)) return { ok: false, error: 'badprefix' };
      const p = Number(pfxPart);
      if (!Number.isInteger(p) || p < 0 || p > 128) return { ok: false, error: 'badprefix' };
      prefix = p;
    }

    // Strip an optional zone id (fe80::1%eth0).
    const pct = text.indexOf('%');
    if (pct >= 0) text = text.slice(0, pct).trim();

    // Reject a bare IPv4 as "notv6".
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return { ok: false, error: 'notv6' };

    const bytes = parseIPv6Core(text);
    if (!bytes) return { ok: false, error: 'badaddr' };

    return { ok: true, bytes, prefix };
  } catch {
    return { ok: false, error: 'badaddr' };
  }
}

const hex4 = (w: number) => w.toString(16).padStart(4, '0');

function words8(b: Bytes16): number[] {
  const w: number[] = [];
  for (let i = 0; i < 8; i++) w.push(((b[i * 2]! << 8) | b[i * 2 + 1]!) & 0xffff);
  return w;
}

// Fully-expanded: 8 groups of 4 hex digits.
function expand(b: Bytes16): string {
  try {
    return words8(b).map(hex4).join(':');
  } catch {
    return '';
  }
}

// RFC-5952 canonical compressed form (lowercase, longest run of zeros → "::").
function compress(b: Bytes16): string {
  try {
    const w = words8(b);
    // Find the longest run of consecutive zero words (length >= 2).
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < 8; i++) {
      if (w[i] === 0) {
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
    if (bestLen < 2) {
      return w.map((x) => x.toString(16)).join(':');
    }
    const before = w.slice(0, bestStart).map((x) => x.toString(16));
    const after = w.slice(bestStart + bestLen).map((x) => x.toString(16));
    return before.join(':') + '::' + after.join(':');
  } catch {
    return '';
  }
}

// Classify by leading bits. Returns keys mapped to bilingual strings via t().
function classify(b: Bytes16): string {
  try {
    const isAll = (v: number) => b.every((x) => x === v);
    const w = words8(b);
    // ::1 loopback
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 1) {
      return 'typeLoopback';
    }
    if (isAll(0)) return 'typeUnspecified';
    if (b[0] === 0xff) return 'typeMulticast'; // ff00::/8
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'typeLinkLocal'; // fe80::/10
    if ((b[0]! & 0xfe) === 0xfc) return 'typeUniqueLocal'; // fc00::/7
    return 'typeGlobal';
  } catch {
    return 'typeUnknown';
  }
}

interface PrefixResult {
  ok: boolean;
  networkCompressed: string;
  maskCompressed: string;
  first: string;
  last: string;
  countPow: string;
  countBig: string;
}

// BigInteger.One << hostBits as a decimal string, without needing native BigInt
// fallbacks — modern browsers all support BigInt, but guard anyway.
function powerOfTwoDecimal(exp: number): string {
  try {
    if (exp <= 0) return '1';
    return (1n << BigInt(exp)).toString(10);
  } catch {
    return '';
  }
}

function computePrefix(b: Bytes16, prefix: number): PrefixResult | null {
  try {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    if (b.length !== 16) return null;

    const mask = new Array<number>(16).fill(0);
    const full = Math.floor(prefix / 8);
    const rem = prefix % 8;
    for (let i = 0; i < full && i < 16; i++) mask[i] = 0xff;
    if (rem > 0 && full < 16) mask[full] = (0xff << (8 - rem)) & 0xff;

    const netBytes: number[] = [];
    const lastBytes: number[] = [];
    for (let i = 0; i < 16; i++) {
      const m = mask[i]!;
      const net = b[i]! & m;
      netBytes.push(net);
      lastBytes.push((net | (~m & 0xff)) & 0xff);
    }

    const hostBits = 128 - prefix;
    return {
      ok: true,
      networkCompressed: compress(netBytes),
      maskCompressed: compress(mask),
      first: compress(netBytes),
      last: compress(lastBytes),
      countPow: '2^' + hostBits,
      countBig: powerOfTwoDecimal(hostBits),
    };
  } catch {
    return null;
  }
}

// 48-bit MAC → 64-bit EUI-64 interface id. Accepts ':', '-', '.', ' ' or none.
function macToEui64(mac: string | undefined): string | null {
  try {
    const text = mac ?? '';
    const hexChars: string[] = [];
    for (const c of text) {
      if (c === ':' || c === '-' || c === '.' || c === ' ') continue;
      if (!/^[0-9a-fA-F]$/.test(c)) return null;
      if (hexChars.length >= 12) return null;
      hexChars.push(c);
    }
    if (hexChars.length !== 12) return null;

    const b: number[] = [];
    for (let i = 0; i < 6; i++) {
      const pair = hexChars[i * 2]! + hexChars[i * 2 + 1]!;
      b.push(parseInt(pair, 16));
    }

    const first = (b[0]! ^ 0x02) & 0xff; // flip U/L bit
    const eui = [first, b[1]!, b[2]!, 0xff, 0xfe, b[3]!, b[4]!, b[5]!];

    const groups: string[] = [];
    for (let i = 0; i < 4; i++) {
      groups.push(hex4(((eui[i * 2]! << 8) | eui[i * 2 + 1]!) & 0xffff));
    }
    return groups.join(':');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    if (!text) return;
    try {
      navigator.clipboard?.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1000);
    } catch {
      /* never throw from a copy button */
    }
  };
  return (
    <button className="mini" disabled={!text} onClick={copy} style={{ marginLeft: 8 }}>
      {done ? '✓' : label}
    </button>
  );
}

function Row({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <div className="kv-row">
      <span className="label">{label}</span>
      <span className="value" style={{ fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center' }}>
        {value}
        <CopyBtn text={value} label={copyLabel} />
      </span>
    </div>
  );
}

export function SubnetV6Module() {
  const { t } = useTranslation();
  const [addr, setAddr] = useState('2001:db8::1');
  const [prefixStr, setPrefixStr] = useState('64');
  const [mac, setMac] = useState('00:1A:2B:3C:4D:5E');

  const addrState = useMemo(() => computeAddr(addr, prefixStr, t), [addr, prefixStr, t]);
  const euiState = useMemo(() => computeEui(mac, t), [mac, t]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('subnetv6.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('subnetv6.addrLabel')}</label>
        <input
          className="hosts-edit"
          style={{ minHeight: 0, height: 34, maxWidth: 320, fontFamily: 'monospace' }}
          value={addr}
          spellCheck={false}
          onChange={(e) => setAddr(e.target.value)}
        />
        <label className="count-note">{t('subnetv6.prefixLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={0}
          max={128}
          style={{ maxWidth: 80 }}
          value={prefixStr}
          onChange={(e) => setPrefixStr(e.target.value)}
        />
      </div>

      {addrState.addr ? (
        <div className="panel">
          <div className="dt-wrap">
            <h4 style={{ marginTop: 0 }}>{t('subnetv6.resultsTitle')}</h4>
            <div className="kv-list">
              <Row label={t('subnetv6.expandedLabel')} value={addrState.addr.expanded} copyLabel={t('subnetv6.copy')} />
              <Row label={t('subnetv6.compressedLabel')} value={addrState.addr.compressed} copyLabel={t('subnetv6.copy')} />
              <div className="kv-row">
                <span className="label">{t('subnetv6.typeLabel')}</span>
                <span className="value">{t('subnetv6.' + addrState.addr.typeKey)}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addrState.prefix ? (
        <div className="panel">
          <div className="dt-wrap">
            <h4 style={{ marginTop: 0 }}>{t('subnetv6.prefixTitle')}</h4>
            <div className="kv-list">
              <Row label={t('subnetv6.netLabel')} value={addrState.prefix.net} copyLabel={t('subnetv6.copy')} />
              <Row label={t('subnetv6.maskLabel')} value={addrState.prefix.mask} copyLabel={t('subnetv6.copy')} />
              <Row label={t('subnetv6.countLabel')} value={addrState.prefix.count} copyLabel={t('subnetv6.copy')} />
              <Row label={t('subnetv6.firstLabel')} value={addrState.prefix.first} copyLabel={t('subnetv6.copy')} />
              <Row label={t('subnetv6.lastLabel')} value={addrState.prefix.last} copyLabel={t('subnetv6.copy')} />
            </div>
          </div>
        </div>
      ) : null}

      <p className="count-note" style={{ color: addrState.ok ? undefined : 'var(--danger)' }}>{addrState.status}</p>

      <div className="panel">
        <div className="dt-wrap">
          <h4 style={{ marginTop: 0 }}>{t('subnetv6.euiTitle')}</h4>
          <p className="count-note" style={{ marginTop: 0 }}>{t('subnetv6.euiBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="hosts-edit"
              style={{ minHeight: 0, height: 34, maxWidth: 240, fontFamily: 'monospace' }}
              value={mac}
              spellCheck={false}
              onChange={(e) => setMac(e.target.value)}
            />
          </div>
          {euiState.value ? (
            <div className="kv-list" style={{ marginTop: 8 }}>
              <Row label={t('subnetv6.euiLabel')} value={euiState.value} copyLabel={t('subnetv6.copy')} />
            </div>
          ) : null}
          <p className="count-note">{euiState.status}</p>
        </div>
      </div>
    </div>
  );
}

// -------- computation wrappers (kept out of render for clarity) --------

interface AddrView {
  expanded: string;
  compressed: string;
  typeKey: string;
}
interface PrefixView {
  net: string;
  mask: string;
  count: string;
  first: string;
  last: string;
}

function computeAddr(
  addrText: string,
  prefixStr: string,
  t: TFunction,
): { ok: boolean; status: string; addr: AddrView | null; prefix: PrefixView | null } {
  try {
    const parsed = parse(addrText);
    if (!parsed.ok || !parsed.bytes) {
      let msg: string;
      switch (parsed.error) {
        case 'empty':
          msg = t('subnetv6.stEmpty');
          break;
        case 'badprefix':
          msg = t('subnetv6.stBadPrefix');
          break;
        case 'notv6':
          msg = t('subnetv6.stNotV6');
          break;
        default:
          msg = t('subnetv6.stBadAddr');
          break;
      }
      return { ok: false, status: msg, addr: null, prefix: null };
    }

    const bytes = parsed.bytes;
    const addrView: AddrView = {
      expanded: expand(bytes),
      compressed: compress(bytes),
      typeKey: classify(bytes),
    };

    // Inline /prefix wins; else use the numeric box; else default 64.
    let prefix: number;
    if (parsed.prefix !== undefined) {
      prefix = parsed.prefix;
    } else {
      const p = prefixStr.trim() === '' ? 64 : Number(prefixStr);
      prefix = Number.isInteger(p) && p >= 0 && p <= 128 ? p : 64;
    }

    const pr = computePrefix(bytes, prefix);
    if (!pr) {
      return { ok: true, status: t('subnetv6.stPrefixFail'), addr: addrView, prefix: null };
    }

    const prefixView: PrefixView = {
      net: pr.networkCompressed + '/' + prefix,
      mask: pr.maskCompressed,
      count: pr.countPow + '  =  ' + pr.countBig,
      first: pr.first,
      last: pr.last,
    };

    return { ok: true, status: t('subnetv6.stOk'), addr: addrView, prefix: prefixView };
  } catch {
    return { ok: false, status: t('subnetv6.stError'), addr: null, prefix: null };
  }
}

function computeEui(macText: string, t: TFunction): { value: string; status: string } {
  try {
    if (macText.trim().length === 0) {
      return { value: '', status: t('subnetv6.euiPrompt') };
    }
    const eui = macToEui64(macText);
    if (eui === null) {
      return { value: '', status: t('subnetv6.euiNeed') };
    }
    return { value: eui, status: t('subnetv6.euiReady') };
  } catch {
    return { value: '', status: t('subnetv6.euiError') };
  }
}
