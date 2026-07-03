import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// Native module — async TCP port scanner via the desktop backend (Windows PowerShell + .NET TcpClient).
// The browser has no raw sockets, so scanning runs through WinForge Web's backend in the packaged app.
// Only ever scan hosts you own or are authorised to test.

const WELL_KNOWN: Record<number, string> = {
  20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 69: 'TFTP',
  80: 'HTTP', 110: 'POP3', 111: 'RPC', 123: 'NTP', 135: 'MS-RPC', 139: 'NetBIOS', 143: 'IMAP',
  161: 'SNMP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP-Sub', 993: 'IMAPS',
  995: 'POP3S', 1433: 'MSSQL', 1521: 'Oracle', 1723: 'PPTP', 2049: 'NFS', 3306: 'MySQL', 3389: 'RDP',
  5432: 'PostgreSQL', 5900: 'VNC', 5985: 'WinRM', 6379: 'Redis', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt',
  9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB',
};
const COMMON_PORTS = Object.keys(WELL_KNOWN).map(Number).sort((a, b) => a - b);

const esc = (s: string) => s.replace(/'/g, "''");

function scanScript(host: string, ports: number[], timeoutMs: number): string {
  const list = ports.join(',');
  return `$ip=[System.Net.Dns]::GetHostAddresses('${esc(host)}')[0]; $ports=@(${list}); ` +
    `$open=foreach($port in $ports){ $c=New-Object System.Net.Sockets.TcpClient; ` +
    `try{ $iar=$c.BeginConnect($ip,$port,$null,$null); if($iar.AsyncWaitHandle.WaitOne(${timeoutMs})){ try{$c.EndConnect($iar); $port}catch{} } }catch{}finally{$c.Close()} }; ` +
    `[pscustomobject]@{ ip=$ip.ToString(); open=@($open) }`;
}

export function PortScanModule() {
  const { t } = useTranslation();
  const [host, setHost] = useState('scanme.nmap.org');
  const [mode, setMode] = useState<'common' | 'range'>('common');
  const [startPort, setStartPort] = useState(1);
  const [endPort, setEndPort] = useState(1024);
  const [timeout, setTimeoutMs] = useState(400);
  const [result, setResult] = useState<{ ip: string; open: number[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const desktop = isTauri();

  const scan = async () => {
    if (!host.trim()) return;
    let ports: number[];
    if (mode === 'common') ports = COMMON_PORTS;
    else {
      let lo = Math.max(1, Math.min(65535, startPort));
      let hi = Math.max(1, Math.min(65535, endPort));
      if (hi < lo) [lo, hi] = [hi, lo];
      if (hi - lo > 2048) hi = lo + 2048; // keep sequential scan responsive
      ports = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    setBusy(true); setErr(null);
    try {
      const [r] = await runPowershellJson<{ ip: string; open: number[] }>(scanScript(host.trim(), ports, Math.max(50, Math.min(3000, timeout))));
      setResult(r ? { ip: r.ip, open: (r.open ?? []).slice().sort((a, b) => a - b) } : { ip: '', open: [] });
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); setResult(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('portscan.desktopOnly')}</p>}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('portscan.host')}</label>
        <input className="mod-search" style={{ maxWidth: 240 }} value={host} onChange={(e) => setHost(e.target.value)} placeholder="host or IP" />
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as 'common' | 'range')}>
          <option value="common">{t('portscan.common')}</option>
          <option value="range">{t('portscan.range')}</option>
        </select>
        {mode === 'range' && (
          <>
            <input className="mod-search" type="number" min={1} max={65535} style={{ maxWidth: 90 }} value={startPort} onChange={(e) => setStartPort(+e.target.value)} />
            <span className="count-note">–</span>
            <input className="mod-search" type="number" min={1} max={65535} style={{ maxWidth: 90 }} value={endPort} onChange={(e) => setEndPort(+e.target.value)} />
          </>
        )}
        <label className="count-note">{t('portscan.timeout')}</label>
        <input className="mod-search" type="number" min={50} max={3000} style={{ maxWidth: 80 }} value={timeout} onChange={(e) => setTimeoutMs(+e.target.value)} />
        <button className="mini primary" disabled={!desktop || busy} onClick={scan}>{busy ? t('portscan.scanning') : t('portscan.scan')}</button>
      </div>
      {err && <pre className="cmd-out error">{err}</pre>}
      {result && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('portscan.resolved', { ip: result.ip, n: result.open.length })}</p>
          {result.open.length === 0 ? (
            <p className="count-note">{t('portscan.none')}</p>
          ) : (
            <table className="dt">
              <thead><tr><th>{t('portscan.port')}</th><th>{t('portscan.service')}</th></tr></thead>
              <tbody>
                {result.open.map((p) => (
                  <tr key={p}><td style={{ fontFamily: 'monospace' }}>{p}</td><td>{WELL_KNOWN[p] ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <p className="count-note" style={{ color: 'var(--text-tertiary)' }}>{t('portscan.warn')}</p>
    </div>
  );
}
