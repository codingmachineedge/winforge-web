import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// Native module — Proxmox VE integration over the REST API (api2/json).
// The WinForge C# module uses a managed HttpClient; on the web/desktop bridge we drive the
// same REST endpoints through PowerShell's Invoke-RestMethod (auth via the PVEAPIToken header),
// so it runs only inside the WinForge desktop app. Every action is guarded and never throws.

interface Guest {
  node: string;
  vmid: number;
  type: string; // "qemu" | "lxc"
  name: string;
  status: string;
  cpuFraction: number;
  maxCpu: number;
  memBytes: number;
  maxMemBytes: number;
  uptimeSec: number;
  lock: string;
  template: boolean;
}

const esc = (s: string) => s.replace(/'/g, "''");

function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  let b = bytes;
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  const unit = u[i]!;
  return i === 0 ? `${bytes} ${unit}` : `${b.toFixed(2)} ${unit}`;
}

function humanUptime(secs: number): string {
  if (!secs || secs <= 0) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m`;
  return `${s}s`;
}

// Build a PowerShell script that authenticates with a PVEAPIToken header and enumerates every
// QEMU VM and LXC container across all online nodes, emitting a flat array of guest objects.
function listGuestsScript(host: string, port: number, tokenId: string, secret: string, trust: boolean): string {
  const base = `https://${esc(host)}:${port}/api2/json`;
  const auth = `PVEAPIToken=${esc(tokenId)}=${esc(secret)}`;
  return (
    `${trust ? '[System.Net.ServicePointManager]::ServerCertificateValidationCallback={$true};' : ''}` +
    `[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12;` +
    `$h=@{Authorization='${auth}'};` +
    `$nodes=(Invoke-RestMethod -Uri '${base}/nodes' -Headers $h -TimeoutSec 20).data;` +
    `$out=@();` +
    `foreach($n in $nodes){` +
    `if($n.status -and $n.status -ne 'online'){continue};` +
    `foreach($ty in @('qemu','lxc')){` +
    `try{$gs=(Invoke-RestMethod -Uri ('${base}/nodes/'+$n.node+'/'+$ty) -Headers $h -TimeoutSec 20).data}catch{$gs=@()};` +
    `foreach($g in $gs){$out+=[pscustomobject]@{` +
    `node=$n.node;vmid=[int]$g.vmid;type=$ty;name=[string]$g.name;status=[string]$g.status;` +
    `cpuFraction=[double]($g.cpu);maxCpu=[int]($g.cpus);memBytes=[long]($g.mem);maxMemBytes=[long]($g.maxmem);` +
    `uptimeSec=[long]($g.uptime);lock=[string]$g.lock;template=([int]($g.template) -ne 0)}}}}` +
    `$out`
  );
}

// Build a PowerShell script that reads one guest's config as key/value lines.
function configScript(host: string, port: number, tokenId: string, secret: string, trust: boolean, node: string, type: string, vmid: number): string {
  const base = `https://${esc(host)}:${port}/api2/json`;
  const auth = `PVEAPIToken=${esc(tokenId)}=${esc(secret)}`;
  return (
    `${trust ? '[System.Net.ServicePointManager]::ServerCertificateValidationCallback={$true};' : ''}` +
    `[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12;` +
    `$h=@{Authorization='${auth}'};` +
    `$d=(Invoke-RestMethod -Uri '${base}/nodes/${esc(node)}/${esc(type)}/${vmid}/config' -Headers $h -TimeoutSec 20).data;` +
    `$d.PSObject.Properties | ForEach-Object {[pscustomobject]@{key=$_.Name;value=[string]$_.Value}}`
  );
}

// Build a PowerShell script that POSTs a power action to a guest's status endpoint.
function powerScript(host: string, port: number, tokenId: string, secret: string, trust: boolean, node: string, type: string, vmid: number, action: string): string {
  const base = `https://${esc(host)}:${port}/api2/json`;
  const auth = `PVEAPIToken=${esc(tokenId)}=${esc(secret)}`;
  return (
    `${trust ? '[System.Net.ServicePointManager]::ServerCertificateValidationCallback={$true};' : ''}` +
    `[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12;` +
    `$h=@{Authorization='${auth}'};` +
    `Invoke-RestMethod -Method Post -Uri '${base}/nodes/${esc(node)}/${esc(type)}/${vmid}/status/${esc(action)}' -Headers $h -TimeoutSec 20 | Out-Null;` +
    `[pscustomobject]@{ok=$true}`
  );
}

interface CfgRow { key: string; value: string }

const CFG_ORDER = ['cores', 'sockets', 'cpu', 'memory', 'balloon', 'boot', 'bootdisk', 'ostype', 'arch', 'hostname', 'rootfs', 'scsi0', 'virtio0', 'ide0', 'sata0', 'net0', 'net1'];

export function ProxmoxModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [host, setHost] = useState('');
  const [port, setPort] = useState(8006);
  const [tokenId, setTokenId] = useState('');
  const [secret, setSecret] = useState('');
  const [trust, setTrust] = useState(true);

  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [config, setConfig] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const keyOf = (g: Guest) => `${g.node}/${g.type}/${g.vmid}`;
  const selected = guests?.find((g) => keyOf(g) === selKey) ?? null;

  const statusLabel = (status: string): string => {
    const s = status.toLowerCase();
    if (s === 'running') return t('proxmox.stRunning');
    if (s === 'stopped') return t('proxmox.stStopped');
    if (s === 'paused' || s === 'suspended') return t('proxmox.stPaused');
    return status || '—';
  };

  const canConnect = desktop && host.trim() !== '' && tokenId.trim() !== '' && secret !== '';

  const refresh = async (silent: boolean) => {
    if (!canConnect) return;
    setBusy('refresh');
    if (!silent) {
      setErr(null);
      setMsg(null);
    }
    try {
      const rows = await runPowershellJson<Guest>(
        listGuestsScript(host.trim(), port || 8006, tokenId.trim(), secret, trust),
      );
      const sorted = rows.slice().sort((a, b) => (a.node === b.node ? a.vmid - b.vmid : a.node.localeCompare(b.node)));
      setGuests(sorted);
      if (selKey && !sorted.some((g) => keyOf(g) === selKey)) {
        setSelKey(null);
        setConfig('');
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      if (!silent) setGuests(null);
    } finally {
      setBusy('');
    }
  };

  const loadConfig = async (g: Guest) => {
    setConfig(t('proxmox.loading'));
    try {
      const rows = await runPowershellJson<CfgRow>(
        configScript(host.trim(), port || 8006, tokenId.trim(), secret, trust, g.node, g.type, g.vmid),
      );
      const map = new Map<string, string>();
      for (const r of rows) if (r && r.key) map.set(r.key, r.value ?? '');
      const lines: string[] = [];
      for (const k of CFG_ORDER) {
        const v = map.get(k);
        if (v !== undefined && v !== '') lines.push(`${k.padEnd(10)} ${v}`);
      }
      const seen = new Set(CFG_ORDER);
      const rest = Array.from(map.keys())
        .filter((k) => !seen.has(k))
        .sort((a, b) => a.localeCompare(b));
      for (const k of rest) {
        const v = map.get(k);
        if (v !== undefined && v !== '') lines.push(`${k.padEnd(10)} ${v}`);
      }
      setConfig(lines.length === 0 ? t('proxmox.noConfig') : lines.join('\n'));
    } catch (e) {
      setConfig(String(e instanceof Error ? e.message : e));
    }
  };

  const select = (g: Guest) => {
    setSelKey(keyOf(g));
    void loadConfig(g);
  };

  const power = async (action: string, labelKey: string, confirmKey?: string) => {
    if (!selected) return;
    const g = selected;
    if (confirmKey && typeof window !== 'undefined' && !window.confirm(t(confirmKey))) return;
    setBusy(action);
    setErr(null);
    setMsg(null);
    try {
      await runPowershellJson(
        powerScript(host.trim(), port || 8006, tokenId.trim(), secret, trust, g.node, g.type, g.vmid, action),
      );
      setMsg(`${t(labelKey)}: ${g.name || `#${g.vmid}`}`);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
    // Status settles server-side; refresh shortly after.
    await new Promise((r) => setTimeout(r, 900));
    await refresh(true);
  };

  const isRunning = (g: Guest | null) => !!g && g.status.toLowerCase() === 'running';
  const isPaused = (g: Guest | null) => !!g && g.status.toLowerCase() === 'paused';
  const running = isRunning(selected);
  const paused = isPaused(selected);
  const stopped = !!selected && !running && !paused;

  const cpuText = (g: Guest): string => {
    if (running && g.maxCpu > 0) return `${Math.round(g.cpuFraction * 100)}% · ${g.maxCpu}`;
    return g.maxCpu > 0 ? `${g.maxCpu} vCPU` : '—';
  };
  const memText = (g: Guest): string => {
    if (g.maxMemBytes <= 0) return '—';
    return g.status.toLowerCase() === 'running'
      ? `${humanSize(g.memBytes)} / ${humanSize(g.maxMemBytes)}`
      : humanSize(g.maxMemBytes);
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('proxmox.desktopOnly')}</p>}

      <p className="count-note" style={{ marginTop: 0 }}>{t('proxmox.blurb')}</p>

      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('proxmox.host')}</label>
          <input className="mod-search" style={{ maxWidth: 200 }} placeholder="pve.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
          <label className="count-note">{t('proxmox.port')}</label>
          <input className="mod-search" type="number" style={{ maxWidth: 90 }} value={port} onChange={(e) => setPort(+e.target.value)} />
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('proxmox.tokenId')}</label>
          <input className="mod-search" style={{ maxWidth: 240 }} placeholder="user@pam!tokenid" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
          <label className="count-note">{t('proxmox.tokenSecret')}</label>
          <input className="mod-search" type="password" style={{ maxWidth: 240 }} value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="chk">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            {t('proxmox.trustCert')}
          </label>
          <button className="mini primary" disabled={!canConnect || !!busy} onClick={() => refresh(false)}>
            {busy === 'refresh' ? t('proxmox.connecting') : t('proxmox.connect')}
          </button>
        </div>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {msg && <p className="count-note dep-ok">{msg}</p>}

      {guests && (
        <div className="panel">
          {guests.length === 0 ? (
            <p className="count-note">{t('proxmox.empty')}</p>
          ) : (
            <>
              <table className="dt">
                <thead>
                  <tr>
                    <th>{t('proxmox.colGuest')}</th>
                    <th>{t('proxmox.colType')}</th>
                    <th>{t('proxmox.colStatus')}</th>
                    <th style={{ textAlign: 'right' }}>{t('proxmox.colCpu')}</th>
                    <th style={{ textAlign: 'right' }}>{t('proxmox.colMem')}</th>
                    <th style={{ textAlign: 'right' }}>{t('proxmox.colUptime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {guests.map((g) => {
                    const k = keyOf(g);
                    return (
                      <tr
                        key={k}
                        onClick={() => select(g)}
                        style={{ cursor: 'pointer', background: k === selKey ? 'var(--surface-2, rgba(127,127,127,0.12))' : undefined }}
                      >
                        <td>{g.name || `#${g.vmid}`}<span className="count-note"> · {g.node} · #{g.vmid}{g.template ? ' · template' : ''}{g.lock ? ' · 🔒 ' + g.lock : ''}</span></td>
                        <td>{g.type === 'lxc' ? t('proxmox.typeCt') : t('proxmox.typeVm')}</td>
                        <td>{statusLabel(g.status)}</td>
                        <td style={{ textAlign: 'right' }}>{cpuText(g)}</td>
                        <td style={{ textAlign: 'right' }}>{memText(g)}</td>
                        <td style={{ textAlign: 'right' }}>{g.status.toLowerCase() === 'running' ? humanUptime(g.uptimeSec) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="count-note" style={{ marginTop: 8 }}>{t('proxmox.count', { n: guests.length })}</p>
            </>
          )}
        </div>
      )}

      {selected && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <strong>{selected.name || `#${selected.vmid}`} (#{selected.vmid})</strong>
            <button className="mini" disabled={!stopped || !!busy} onClick={() => power('start', 'proxmox.start')}>{t('proxmox.start')}</button>
            <button className="mini" disabled={!running || !!busy} onClick={() => power('shutdown', 'proxmox.shutdown', 'proxmox.confirmShutdown')}>{t('proxmox.shutdown')}</button>
            <button className="mini" disabled={(!running && !paused) || !!busy} onClick={() => power('stop', 'proxmox.stop', 'proxmox.confirmStop')}>{t('proxmox.stop')}</button>
            <button className="mini" disabled={!running || !!busy} onClick={() => power('reboot', 'proxmox.reboot')}>{t('proxmox.reboot')}</button>
            <button className="mini" disabled={!running || !!busy} onClick={() => power('suspend', 'proxmox.suspend')}>{t('proxmox.suspend')}</button>
            <button className="mini" disabled={!paused || !!busy} onClick={() => power('resume', 'proxmox.resume')}>{t('proxmox.resume')}</button>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {selected.type === 'lxc' ? t('proxmox.typeCt') : t('proxmox.typeVm')} · {t('proxmox.onNode', { node: selected.node })} · {statusLabel(selected.status)} · {selected.maxCpu} vCPU · {humanSize(selected.maxMemBytes)} RAM
          </p>
          {config && <pre className="cmd-out">{config}</pre>}
        </div>
      )}

      <p className="count-note">{t('proxmox.note')}</p>
    </div>
  );
}
