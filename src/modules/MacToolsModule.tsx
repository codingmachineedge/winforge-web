import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge MacToolsService — parse/normalize a MAC to colon / hyphen /
// Cisco-dot / bare (upper & lower), analyze the I/G and U/L bits, OUI vendor
// lookup, and random locally-administered unicast generation. Pure client-side.

// ~50 common OUI prefixes (upper-case, no separators) → vendor name.
const OUIS: Record<string, string> = {
  '001A2B': 'Ayecom Technology',
  '001B63': 'Apple',
  '001CB3': 'Apple',
  '0017F2': 'Apple',
  '002500': 'Apple',
  '3C0754': 'Apple',
  A45E60: 'Apple',
  F0DBF8: 'Apple',
  '001D0F': 'TP-Link',
  '50C7BF': 'TP-Link',
  A42BB0: 'TP-Link',
  '001B21': 'Intel',
  '001517': 'Intel',
  '00A0C9': 'Intel',
  '3CA9F4': 'Intel',
  B0359F: 'Intel',
  '001560': 'Hewlett-Packard',
  '001321': 'Hewlett-Packard',
  '3C4A92': 'Hewlett-Packard',
  '001279': 'Cisco',
  '00000C': 'Cisco',
  '0010A4': 'Cisco',
  '001A2F': 'Cisco',
  '00248C': 'Cisco',
  '001143': 'Dell',
  '00188B': 'Dell',
  '002170': 'Dell',
  B8CA3A: 'Dell',
  F8BC12: 'Dell',
  '001377': 'Samsung',
  '0016DB': 'Samsung',
  '0023D6': 'Samsung',
  '5CE8EB': 'Samsung',
  '001AA0': 'Sony',
  '001DBA': 'Sony',
  '0024BE': 'Sony',
  '00037F': 'Atheros',
  '001B11': 'D-Link',
  '00179A': 'D-Link',
  '1C7EE5': 'D-Link',
  '000FB5': 'Netgear',
  '00223F': 'Netgear',
  A040A0: 'Netgear',
  '001018': 'Broadcom',
  '00104B': '3Com',
  '001438': 'Hewlett-Packard',
  '00E04C': 'Realtek',
  '525400': 'QEMU/KVM virtual',
  '000C29': 'VMware',
  '005056': 'VMware',
  '0003FF': 'Microsoft (Hyper-V)',
  '00155D': 'Microsoft (Hyper-V)',
  '080027': 'VirtualBox',
  '0016CB': 'Apple',
  '001EC2': 'Apple',
  FCFBFB: 'Cisco',
  '001E58': 'D-Link',
  '00259C': 'Cisco-Linksys',
  '000625': 'Linksys',
};

const isHexDigit = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);

// Parse any common MAC form into 6 bytes. Returns null on bad input.
function parseMac(input: string | null | undefined): number[] | null {
  if (!input || !input.trim()) return null;
  let hex = '';
  for (const c of input) if (isHexDigit(c)) hex += c;
  if (hex.length !== 12) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const pair = hex.substring(i * 2, i * 2 + 2);
    const v = parseInt(pair, 16);
    if (Number.isNaN(v)) return null;
    bytes.push(v);
  }
  return bytes;
}

const hex = (b: number, upper: boolean): string => {
  const s = (b & 0xff).toString(16).padStart(2, '0');
  return upper ? s.toUpperCase() : s;
};

const join = (b: number[], sep: string, upper: boolean): string =>
  b.map((x) => hex(x, upper)).join(sep);

const toColon = (b: number[], upper: boolean) => join(b, ':', upper);
const toHyphen = (b: number[], upper: boolean) => join(b, '-', upper);
const toBare = (b: number[], upper: boolean) => join(b, '', upper);

// Cisco dotted form aabb.ccdd.eeff.
function toDot(b: number[], upper: boolean): string {
  return [
    hex(b[0]!, upper) + hex(b[1]!, upper),
    hex(b[2]!, upper) + hex(b[3]!, upper),
    hex(b[4]!, upper) + hex(b[5]!, upper),
  ].join('.');
}

const isMulticast = (b: number[]) => (b[0]! & 0x01) !== 0;
const isLocallyAdministered = (b: number[]) => (b[0]! & 0x02) !== 0;
const isBroadcast = (b: number[]) => b.every((x) => x === 0xff);

function lookupVendor(b: number[]): string | null {
  const oui = hex(b[0]!, true) + hex(b[1]!, true) + hex(b[2]!, true);
  return OUIS[oui] ?? null;
}

// Random locally-administered unicast MAC (U/L set, I/G clear).
function generateLocalUnicast(): number[] {
  const b = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256);
  }
  const out = Array.from(b);
  out[0] = (out[0]! & 0xfc) | 0x02; // clear I/G (unicast), set U/L (local)
  return out;
}

export function MacToolsModule() {
  const { t, i18n } = useTranslation();
  const [mac, setMac] = useState('');
  const [copied, setCopied] = useState('');

  const parsed = useMemo(() => parseMac(mac), [mac]);

  const analysis = useMemo(() => {
    if (!parsed) return null;
    const cast = isBroadcast(parsed)
      ? pick('Broadcast (all-ones)', '廣播（全一）', i18n.language)
      : isMulticast(parsed)
        ? pick('Multicast (I/G bit set)', '多播（I/G 位元 = 1）', i18n.language)
        : pick('Unicast (I/G bit clear)', '單播（I/G 位元 = 0）', i18n.language);
    const admin = isLocallyAdministered(parsed)
      ? pick('Locally administered (U/L bit set)', '本地管理（U/L 位元 = 1）', i18n.language)
      : pick('Universally administered (U/L bit clear)', '全域管理（U/L 位元 = 0）', i18n.language);
    const vendor = lookupVendor(parsed) ?? pick('unknown', '未知', i18n.language);
    return { cast, admin, vendor };
  }, [parsed, i18n.language]);

  const formats = useMemo(() => {
    if (!parsed) return [];
    return [
      { label: pick('Colon (lower)', '冒號（細楷）', i18n.language), value: toColon(parsed, false) },
      { label: pick('Colon (upper)', '冒號（大楷）', i18n.language), value: toColon(parsed, true) },
      { label: pick('Hyphen (lower)', '連字號（細楷）', i18n.language), value: toHyphen(parsed, false) },
      { label: pick('Hyphen (upper)', '連字號（大楷）', i18n.language), value: toHyphen(parsed, true) },
      { label: pick('Cisco dot (lower)', 'Cisco 點（細楷）', i18n.language), value: toDot(parsed, false) },
      { label: pick('Cisco dot (upper)', 'Cisco 點（大楷）', i18n.language), value: toDot(parsed, true) },
      { label: pick('Bare (lower)', '純值（細楷）', i18n.language), value: toBare(parsed, false) },
      { label: pick('Bare (upper)', '純值（大楷）', i18n.language), value: toBare(parsed, true) },
    ];
  }, [parsed, i18n.language]);

  const status = mac.trim()
    ? parsed
      ? t('mactools.valid')
      : t('mactools.invalid')
    : t('mactools.enterToBegin');

  const generate = () => {
    setMac(toColon(generateLocalUnicast(), false));
    setCopied('');
  };

  const copyRow = (value: string) => {
    if (!value) return;
    try {
      void navigator.clipboard?.writeText(value);
      setCopied(t('mactools.copied', { value }));
    } catch {
      setCopied(t('mactools.copyFailed'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mactools.blurb')}
      </p>

      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('mactools.inputLabel')}
        </h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 260, fontFamily: 'Consolas, monospace' }}
            value={mac}
            onChange={(e) => {
              setMac(e.target.value);
              setCopied('');
            }}
            placeholder="00:1A:2B:3C:4D:5E"
          />
          <button className="mini" onClick={generate}>
            {t('mactools.generate')}
          </button>
        </div>
        <span className="count-note" style={{ margin: 0 }}>
          {status}
        </span>
      </div>

      {parsed && analysis && (
        <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
            {t('mactools.analysisTitle')}
          </h3>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>{t('mactools.delivery')}</dt>
            <dd>{analysis.cast}</dd>
            <dt>{t('mactools.administration')}</dt>
            <dd>{analysis.admin}</dd>
            <dt>{t('mactools.ouiVendor')}</dt>
            <dd>{analysis.vendor}</dd>
          </dl>

          <h3 className="group-title" style={{ fontSize: 15, margin: 0, marginTop: 6 }}>
            {t('mactools.formatsTitle')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {formats.map((f) => (
              <button
                key={f.label}
                className="mini"
                style={{
                  display: 'flex',
                  gap: 12,
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  width: '100%',
                }}
                onClick={() => copyRow(f.value)}
              >
                <span className="count-note" style={{ margin: 0, minWidth: 130 }}>
                  {f.label}
                </span>
                <span style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>
                  {f.value}
                </span>
              </button>
            ))}
          </div>
          {copied && (
            <span className="count-note" style={{ margin: 0 }}>
              {copied}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
