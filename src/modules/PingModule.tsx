import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// Native module — ICMP ping & traceroute via the desktop backend (Windows PowerShell + .NET Ping).
// The browser has no ICMP, so live probing runs only inside the WinForge desktop app.

interface PingRow { seq: number; address: string; latency: number; ttl: number; status: string; success: boolean }
interface HopRow { hop: number; address: string; latency: number; status: string }

const esc = (s: string) => s.replace(/'/g, "''");

function pingScript(host: string, count: number): string {
  return `$p=New-Object System.Net.NetworkInformation.Ping; $payload=New-Object byte[] 32; ` +
    `for($i=1;$i -le ${count};$i++){ try{ $r=$p.Send('${esc(host)}',4000,$payload); ` +
    `[pscustomobject]@{seq=$i;address=$r.Address.ToString();latency=[int]$r.RoundtripTime;ttl=[int]$r.Options.Ttl;status=$r.Status.ToString();success=($r.Status -eq 'Success')} }` +
    `catch{ [pscustomobject]@{seq=$i;address='*';latency=0;ttl=0;status='Failed';success=$false} } }`;
}
function traceScript(host: string, maxHops: number): string {
  return `$p=New-Object System.Net.NetworkInformation.Ping; $payload=New-Object byte[] 32; ` +
    `for($ttl=1;$ttl -le ${maxHops};$ttl++){ $opt=New-Object System.Net.NetworkInformation.PingOptions($ttl,$false); ` +
    `try{ $r=$p.Send('${esc(host)}',4000,$payload,$opt); $a=if($r.Address){$r.Address.ToString()}else{'*'}; ` +
    `[pscustomobject]@{hop=$ttl;address=$a;latency=[int]$r.RoundtripTime;status=$r.Status.ToString()}; if($r.Status -eq 'Success'){break} }` +
    `catch{ [pscustomobject]@{hop=$ttl;address='*';latency=0;status='Failed'} } }`;
}

export function PingModule() {
  const { t } = useTranslation();
  const [host, setHost] = useState('8.8.8.8');
  const [count, setCount] = useState(4);
  const [maxHops, setMaxHops] = useState(30);
  const [pings, setPings] = useState<PingRow[] | null>(null);
  const [hops, setHops] = useState<HopRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const desktop = isTauri();

  const doPing = async () => {
    if (!host.trim()) return;
    setBusy('ping'); setErr(null); setHops(null);
    try {
      setPings(await runPowershellJson<PingRow>(pingScript(host.trim(), Math.max(1, Math.min(100, count)))));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); setPings(null); }
    finally { setBusy(''); }
  };
  const doTrace = async () => {
    if (!host.trim()) return;
    setBusy('trace'); setErr(null); setPings(null);
    try {
      setHops(await runPowershellJson<HopRow>(traceScript(host.trim(), Math.max(1, Math.min(60, maxHops)))));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); setHops(null); }
    finally { setBusy(''); }
  };

  const sent = pings?.length ?? 0;
  const ok = pings?.filter((p) => p.success).length ?? 0;
  const lat = pings?.filter((p) => p.success).map((p) => p.latency) ?? [];
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('ping.desktopOnly')}</p>}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('ping.host')}</label>
        <input className="mod-search" style={{ maxWidth: 240 }} value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && desktop && doPing()} placeholder="host or IP" />
        <label className="count-note">{t('ping.count')}</label>
        <input className="mod-search" type="number" min={1} max={100} style={{ maxWidth: 70 }} value={count} onChange={(e) => setCount(+e.target.value)} />
        <button className="mini primary" disabled={!desktop || !!busy} onClick={doPing}>{busy === 'ping' ? t('ping.pinging') : t('ping.ping')}</button>
        <label className="count-note">{t('ping.maxHops')}</label>
        <input className="mod-search" type="number" min={1} max={60} style={{ maxWidth: 70 }} value={maxHops} onChange={(e) => setMaxHops(+e.target.value)} />
        <button className="mini" disabled={!desktop || !!busy} onClick={doTrace}>{busy === 'trace' ? t('ping.tracing') : t('ping.traceroute')}</button>
      </div>
      {err && <pre className="cmd-out error">{err}</pre>}
      {pings && (
        <div className="panel">
          <table className="dt">
            <thead><tr><th>#</th><th>{t('ping.address')}</th><th style={{ textAlign: 'right' }}>{t('ping.latency')}</th><th style={{ textAlign: 'right' }}>TTL</th><th>{t('ping.statusCol')}</th></tr></thead>
            <tbody>
              {pings.map((p) => (
                <tr key={p.seq}><td>{p.seq}</td><td style={{ fontFamily: 'monospace' }}>{p.address}</td><td style={{ textAlign: 'right' }}>{p.success ? `${p.latency} ms` : '—'}</td><td style={{ textAlign: 'right' }}>{p.ttl || '—'}</td><td className={p.success ? 'pos' : 'neg'}>{p.status}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="count-note" style={{ marginTop: 8 }}>{t('ping.summary', { sent, ok, loss: sent ? Math.round(((sent - ok) / sent) * 100) : 0, avg })}</p>
        </div>
      )}
      {hops && (
        <div className="panel">
          <table className="dt">
            <thead><tr><th>{t('ping.hop')}</th><th>{t('ping.address')}</th><th style={{ textAlign: 'right' }}>{t('ping.latency')}</th><th>{t('ping.statusCol')}</th></tr></thead>
            <tbody>
              {hops.map((h) => (
                <tr key={h.hop}><td>{h.hop}</td><td style={{ fontFamily: 'monospace' }}>{h.address}</td><td style={{ textAlign: 'right' }}>{h.address !== '*' ? `${h.latency} ms` : '—'}</td><td className={h.status === 'Success' ? 'pos' : ''}>{h.status}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="count-note">{t('ping.note')}</p>
    </div>
  );
}
