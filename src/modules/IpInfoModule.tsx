import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge's IpInfoModule (module.ipinfo). The desktop original lists every
// operational local network adapter (name, description, type, MAC, IPv4/IPv6, gateways,
// DNS, link speed via System.Net.NetworkInformation) AND looks up the public IP over
// HTTPS (api.ipify.org). Reading local adapters, MACs and DNS servers needs OS access
// that a sandboxed browser does not have, so the web port keeps the one feature that IS
// possible client-side — the public-IP lookup — and, since network IS the module's
// purpose here, enriches it with the geo/ISP details a public IP-info API returns. The
// desktop's "Refresh" button, public-IP card and "Copy" action are all reproduced; a
// bilingual note explains why the local-adapter table is OS-only.

interface PublicInfo {
  ip: string;
  version: string; // "IPv4" / "IPv6" / ""
  city: string;
  region: string;
  country: string;
  org: string; // ISP / org
  asn: string;
  timezone: string;
  reverse: string; // reverse DNS / hostname
}

// ipapi.co returns JSON with permissive CORS. Map its fields into our shape. Any
// missing field becomes "". Never throws for a well-formed object.
function mapIpapi(j: Record<string, unknown>): PublicInfo {
  const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const ip = s(j['ip']);
  const version = s(j['version']); // "IPv4" / "IPv6"
  const asnNum = s(j['asn']);
  const org = s(j['org']);
  return {
    ip,
    version: version === 'IPv4' || version === 'IPv6' ? version : ip.includes(':') ? 'IPv6' : ip ? 'IPv4' : '',
    city: s(j['city']),
    region: s(j['region']),
    country: [s(j['country_name']), s(j['country'])].filter((x) => x).join(' / '),
    org,
    asn: asnNum,
    timezone: s(j['timezone']),
    reverse: '',
  };
}

type Status = { kind: 'idle' | 'loading' | 'ok' | 'error'; msg: string };

export function IpInfoModule() {
  const { t } = useTranslation();

  const [publicIp, setPublicIp] = useState('');
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: '' });
  const [copied, setCopied] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // Cancel any in-flight lookup (mirrors the desktop CancellationTokenSource).
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const timer = setTimeout(() => ac.abort(), 8000); // 8s timeout like the desktop HttpClient

    setStatus({ kind: 'loading', msg: t('ipinfo.lookingUp') });
    setInfo(null);
    try {
      const resp = await fetch('https://ipapi.co/json/', {
        signal: ac.signal,
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = (await resp.json()) as Record<string, unknown>;
      if (ac.signal.aborted) return;
      if (j['error']) throw new Error(typeof j['reason'] === 'string' ? j['reason'] : 'error');
      const mapped = mapIpapi(j);
      if (!mapped.ip) throw new Error('no ip');
      setPublicIp(mapped.ip);
      setInfo(mapped);
      setStatus({ kind: 'ok', msg: '' });
    } catch (e) {
      if (ac.signal.aborted && abortRef.current !== ac) return; // superseded by a newer refresh
      setPublicIp('');
      setInfo(null);
      setStatus({ kind: 'error', msg: t('ipinfo.notAvailable') });
    } finally {
      clearTimeout(timer);
    }
  }, [t]);

  // Loaded += Render(); RefreshAsync() — kick off one lookup on mount.
  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  const copyIp = () => {
    if (!publicIp) {
      setCopied(t('ipinfo.noneToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(publicIp);
    setCopied(t('ipinfo.copiedMsg'));
  };

  const detailRows: [string, string][] = info
    ? [
        [t('ipinfo.version'), info.version || '—'],
        [t('ipinfo.city'), info.city || '—'],
        [t('ipinfo.region'), info.region || '—'],
        [t('ipinfo.country'), info.country || '—'],
        [t('ipinfo.org'), info.org || '—'],
        [t('ipinfo.asn'), info.asn || '—'],
        [t('ipinfo.timezone'), info.timezone || '—'],
      ]
    : [];

  const publicText =
    status.kind === 'loading'
      ? t('ipinfo.lookingUp')
      : publicIp
        ? publicIp
        : t('ipinfo.notAvailable');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ipinfo.blurb')}
      </p>

      <div className="mod-toolbar">
        <button
          className="mini primary"
          disabled={status.kind === 'loading'}
          onClick={() => void refresh()}
        >
          {status.kind === 'loading' ? t('ipinfo.lookingUp') : t('ipinfo.refresh')}
        </button>
      </div>

      {/* Public IP card */}
      <div
        className="kv-list"
        style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('ipinfo.publicTitle')}</div>
          <div
            style={{
              fontFamily: 'Consolas, monospace',
              fontSize: 14,
              color: 'var(--muted, #888)',
              wordBreak: 'break-all',
            }}
          >
            {publicText}
          </div>
        </div>
        <button className="mini" onClick={copyIp}>
          {t('ipinfo.copy')}
        </button>
      </div>

      {status.kind === 'error' && (
        <p style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12.5 }}>{status.msg}</p>
      )}
      {copied && (
        <p className="count-note" style={{ marginTop: 10 }}>
          {copied}
        </p>
      )}

      {/* Public IP details (geo / ISP) — what a browser CAN see about your connection */}
      {info && (
        <div
          className="kv-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}
        >
          <h3 className="group-title" style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
            {t('ipinfo.detailsTitle')}
          </h3>
          <div className="dt-wrap">
            <table className="dt">
              <tbody>
                {detailRows.map(([label, value], i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      {label}
                    </td>
                    <td
                      style={{
                        fontFamily: 'Consolas, monospace',
                        wordBreak: 'break-all',
                        userSelect: 'text',
                      }}
                    >
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Local adapters section — OS-only, cannot be read from a sandboxed browser. */}
      <div
        className="kv-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}
      >
        <h3 className="group-title" style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
          {t('ipinfo.adaptersTitle')}
        </h3>
        <p className="count-note" style={{ margin: 0 }}>
          {t('ipinfo.adaptersOsOnly')}
        </p>
      </div>
    </div>
  );
}
