import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';
import { ModuleTabs } from './ModuleTabs';

// Native module — Proxmox VE integration over the REST API (api2/json).
// Ports WinForge's ProxmoxService / ProxmoxModule (managed HttpClient). On the desktop
// bridge every REST call is routed through PowerShell's Invoke-RestMethod so it runs
// backend-side (no browser CORS, self-signed certs accepted when the user opts in).
// Two auth modes: an API token (Authorization: PVEAPIToken=…) or a username/password
// ticket login (POST /access/ticket → PVEAuthCookie + CSRFPreventionToken for writes).
// Connection settings persist to localStorage; the token secret / password are NEVER
// written to disk (the "remember" flag only re-fills the non-secret fields). Every
// mutation is click-gated; hard stop / shutdown confirm first. Nothing ever throws.

// ── types ──────────────────────────────────────────────────────────────────────────

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
  diskBytes: number;
  maxDiskBytes: number;
  uptimeSec: number;
  lock: string;
  template: boolean;
}

interface Node {
  node: string;
  status: string;
  cpuFraction: number;
  memBytes: number;
  maxMemBytes: number;
  diskBytes: number;
  maxDiskBytes: number;
  uptimeSec: number;
  level: string;
}

interface Storage {
  node: string;
  storage: string;
  type: string;
  content: string;
  active: number;
  enabled: number;
  usedBytes: number;
  totalBytes: number;
  availBytes: number;
}

interface Task {
  node: string;
  upid: string;
  typ: string;
  id: string;
  user: string;
  status: string;
  startSec: number;
  endSec: number;
}

interface CfgRow {
  key: string;
  value: string;
}

interface SavedConn {
  host: string;
  port: number;
  authMode: 'token' | 'ticket';
  tokenId: string;
  user: string;
  realm: string;
  trust: boolean;
  remember: boolean;
}

// Connection state, mirroring PveConnState in the C# service.
type ConnState = 'disconnected' | 'connected' | 'unreachable' | 'unauthorized' | 'certUntrusted';

const STORE_KEY = 'winforge-web.proxmox.conn';

const esc = (s: string) => s.replace(/'/g, "''");

// ── formatting (mirrors ProxmoxService.HumanSize / HumanUptime) ──────────────────────

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

function pct(used: number, total: number): string {
  if (!total || total <= 0) return '—';
  return `${Math.round((used / total) * 100)}%`;
}

function localTime(secs: number): string {
  if (!secs || secs <= 0) return '—';
  try {
    return new Date(secs * 1000).toLocaleString();
  } catch {
    return '—';
  }
}

// ── PowerShell payload builders (backend Invoke-RestMethod, no CORS) ──────────────────

// Common prologue: TLS 1.2, optional self-signed trust, and the auth header block.
// For token mode we send Authorization: PVEAPIToken=…; for ticket mode we first POST
// /access/ticket, capture the PVEAuthCookie + CSRFPreventionToken, and reuse them.
function prologue(c: ConnInputs): string {
  const base = `https://${esc(c.host)}:${c.port}/api2/json`;
  let s =
    `${c.trust ? '[System.Net.ServicePointManager]::ServerCertificateValidationCallback={$true};' : ''}` +
    `[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12;` +
    `$base='${base}';`;
  if (c.authMode === 'ticket') {
    const userRealm = `${esc(c.user)}@${esc(c.realm)}`;
    s +=
      `$lf=@{username='${userRealm}';password='${esc(c.password)}'};` +
      `$tk=(Invoke-RestMethod -Method Post -Uri ($base+'/access/ticket') -Body $lf -TimeoutSec 20).data;` +
      `$h=@{Cookie=('PVEAuthCookie='+$tk.ticket);CSRFPreventionToken=$tk.CSRFPreventionToken};`;
  } else {
    const auth = `PVEAPIToken=${esc(c.tokenId)}=${esc(c.secret)}`;
    s += `$h=@{Authorization='${auth}'};`;
  }
  return s;
}

interface ConnInputs {
  host: string;
  port: number;
  authMode: 'token' | 'ticket';
  tokenId: string;
  secret: string;
  user: string;
  realm: string;
  password: string;
  trust: boolean;
}

// A connectivity + auth probe: GET /version. Emits an object with an ok flag and, on
// failure, an httpStatus so the UI can map it to a PveConnState-style message.
function probeScript(c: ConnInputs): string {
  return (
    prologue(c) +
    `try{$v=(Invoke-RestMethod -Uri ($base+'/version') -Headers $h -TimeoutSec 20).data;` +
    `[pscustomobject]@{ok=$true;version=[string]$v.version;release=[string]$v.release;httpStatus=200;error=''}}` +
    `catch{$code=0;if($_.Exception.Response){$code=[int]$_.Exception.Response.StatusCode};` +
    `[pscustomobject]@{ok=$false;version='';release='';httpStatus=$code;error=[string]$_.Exception.Message}}`
  );
}

// Enumerate every QEMU VM and LXC container across all online nodes.
function listGuestsScript(c: ConnInputs): string {
  return (
    prologue(c) +
    `$nodes=(Invoke-RestMethod -Uri ($base+'/nodes') -Headers $h -TimeoutSec 20).data;` +
    `$out=@();` +
    `foreach($n in $nodes){` +
    `if($n.status -and $n.status -ne 'online'){continue};` +
    `foreach($ty in @('qemu','lxc')){` +
    `try{$gs=(Invoke-RestMethod -Uri ($base+'/nodes/'+$n.node+'/'+$ty) -Headers $h -TimeoutSec 20).data}catch{$gs=@()};` +
    `foreach($g in $gs){$out+=[pscustomobject]@{` +
    `node=$n.node;vmid=[int]$g.vmid;type=$ty;name=[string]$g.name;status=[string]$g.status;` +
    `cpuFraction=[double]($g.cpu);maxCpu=[int]($g.cpus);memBytes=[long]($g.mem);maxMemBytes=[long]($g.maxmem);` +
    `diskBytes=[long]($g.disk);maxDiskBytes=[long]($g.maxdisk);` +
    `uptimeSec=[long]($g.uptime);lock=[string]$g.lock;template=([int]($g.template) -ne 0)}}}}` +
    `$out`
  );
}

// Cluster nodes (GET /nodes).
function listNodesScript(c: ConnInputs): string {
  return (
    prologue(c) +
    `$ns=(Invoke-RestMethod -Uri ($base+'/nodes') -Headers $h -TimeoutSec 20).data;` +
    `foreach($n in $ns){[pscustomobject]@{` +
    `node=[string]$n.node;status=[string]$n.status;cpuFraction=[double]($n.cpu);` +
    `memBytes=[long]($n.mem);maxMemBytes=[long]($n.maxmem);diskBytes=[long]($n.disk);maxDiskBytes=[long]($n.maxdisk);` +
    `uptimeSec=[long]($n.uptime);level=[string]$n.level}}`
  );
}

// Storage across every node (GET /nodes/{node}/storage).
function listStorageScript(c: ConnInputs): string {
  return (
    prologue(c) +
    `$ns=(Invoke-RestMethod -Uri ($base+'/nodes') -Headers $h -TimeoutSec 20).data;` +
    `$out=@();` +
    `foreach($n in $ns){` +
    `if($n.status -and $n.status -ne 'online'){continue};` +
    `try{$ss=(Invoke-RestMethod -Uri ($base+'/nodes/'+$n.node+'/storage') -Headers $h -TimeoutSec 20).data}catch{$ss=@()};` +
    `foreach($s in $ss){$out+=[pscustomobject]@{` +
    `node=$n.node;storage=[string]$s.storage;type=[string]$s.type;content=[string]$s.content;` +
    `active=[int]($s.active);enabled=[int]($s.enabled);` +
    `usedBytes=[long]($s.used);totalBytes=[long]($s.total);availBytes=[long]($s.avail)}}}` +
    `$out`
  );
}

// Recent cluster tasks (GET /nodes/{node}/tasks?limit=…).
function listTasksScript(c: ConnInputs, limit: number): string {
  return (
    prologue(c) +
    `$ns=(Invoke-RestMethod -Uri ($base+'/nodes') -Headers $h -TimeoutSec 20).data;` +
    `$out=@();` +
    `foreach($n in $ns){` +
    `if($n.status -and $n.status -ne 'online'){continue};` +
    `try{$ts=(Invoke-RestMethod -Uri ($base+'/nodes/'+$n.node+'/tasks?limit=${limit}&errors=1') -Headers $h -TimeoutSec 20).data}catch{$ts=@()};` +
    `foreach($tk in $ts){$out+=[pscustomobject]@{` +
    `node=$n.node;upid=[string]$tk.upid;typ=[string]$tk.type;id=[string]$tk.id;user=[string]$tk.user;` +
    `status=[string]$tk.status;startSec=[long]($tk.starttime);endSec=[long]($tk.endtime)}}}` +
    `$out`
  );
}

// One guest's config as key/value lines (GET …/{vmid}/config).
function configScript(c: ConnInputs, node: string, type: string, vmid: number): string {
  return (
    prologue(c) +
    `$d=(Invoke-RestMethod -Uri ($base+'/nodes/${esc(node)}/${esc(type)}/${vmid}/config') -Headers $h -TimeoutSec 20).data;` +
    `$d.PSObject.Properties | ForEach-Object {[pscustomobject]@{key=$_.Name;value=[string]$_.Value}}`
  );
}

// Best-effort guest IP via the QEMU guest agent (QEMU + running only).
function guestIpScript(c: ConnInputs, node: string, vmid: number): string {
  return (
    prologue(c) +
    `try{$r=(Invoke-RestMethod -Uri ($base+'/nodes/${esc(node)}/qemu/${vmid}/agent/network-get-interfaces') -Headers $h -TimeoutSec 20).data;` +
    `$ips=@();foreach($if in $r.result){if($if.name -like 'lo*'){continue};` +
    `foreach($a in $if.'ip-addresses'){$ip=[string]$a.'ip-address';if(-not $ip){continue};` +
    `if($ip.StartsWith('127.') -or $ip -eq '::1'){continue};$ips+=$ip}}` +
    `[pscustomobject]@{ip=(($ips | Select-Object -Unique) -join ', ')}}` +
    `catch{[pscustomobject]@{ip=''}}`
  );
}

// POST a power action to a guest's status endpoint (ticket mode sends the CSRF token).
function powerScript(c: ConnInputs, node: string, type: string, vmid: number, action: string): string {
  return (
    prologue(c) +
    `Invoke-RestMethod -Method Post -Uri ($base+'/nodes/${esc(node)}/${esc(type)}/${vmid}/status/${esc(action)}') -Headers $h -TimeoutSec 20 | Out-Null;` +
    `[pscustomobject]@{ok=$true}`
  );
}

interface ProbeResult {
  ok: boolean;
  version: string;
  release: string;
  httpStatus: number;
  error: string;
}

const CFG_ORDER = ['cores', 'sockets', 'cpu', 'memory', 'balloon', 'boot', 'bootdisk', 'ostype', 'arch', 'hostname', 'rootfs', 'scsi0', 'virtio0', 'ide0', 'sata0', 'net0', 'net1'];

function loadSaved(): SavedConn | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedConn>;
    return {
      host: String(p.host ?? ''),
      port: Number(p.port ?? 8006) || 8006,
      authMode: p.authMode === 'ticket' ? 'ticket' : 'token',
      tokenId: String(p.tokenId ?? ''),
      user: String(p.user ?? 'root'),
      realm: String(p.realm ?? 'pam'),
      trust: p.trust !== false,
      remember: p.remember === true,
    };
  } catch {
    return null;
  }
}

export function ProxmoxModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const saved = useRef<SavedConn | null>(loadSaved());

  // ── connection form ──
  const [host, setHost] = useState(saved.current?.host ?? '');
  const [port, setPort] = useState(saved.current?.port ?? 8006);
  const [authMode, setAuthMode] = useState<'token' | 'ticket'>(saved.current?.authMode ?? 'token');
  const [tokenId, setTokenId] = useState(saved.current?.tokenId ?? '');
  const [secret, setSecret] = useState('');
  const [user, setUser] = useState(saved.current?.user ?? 'root');
  const [realm, setRealm] = useState(saved.current?.realm ?? 'pam');
  const [password, setPassword] = useState('');
  const [trust, setTrust] = useState(saved.current?.trust ?? true);
  const [remember, setRemember] = useState(saved.current?.remember ?? false);

  // ── connection status ──
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string>('');
  const [connMsg, setConnMsg] = useState<{ sev: 'ok' | 'err' | 'info'; text: string; detail?: string } | null>(null);
  const [connBusy, setConnBusy] = useState(false);

  // ── data ──
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [storage, setStorage] = useState<Storage[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [config, setConfig] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const keyOf = (g: Guest) => `${g.node}/${g.type}/${g.vmid}`;
  const selected = guests?.find((g) => keyOf(g) === selKey) ?? null;

  const inputs = (): ConnInputs => ({
    host: host.trim(),
    port: port || 8006,
    authMode,
    tokenId: tokenId.trim(),
    secret,
    user: user.trim() || 'root',
    realm: realm.trim() || 'pam',
    password,
    trust,
  });

  const canConnect =
    desktop &&
    host.trim() !== '' &&
    (authMode === 'token' ? tokenId.trim() !== '' && secret !== '' : user.trim() !== '' && password !== '');

  const statusLabel = (status: string): string => {
    const s = status.toLowerCase();
    if (s === 'running') return t('proxmox.stRunning');
    if (s === 'stopped') return t('proxmox.stStopped');
    if (s === 'paused' || s === 'suspended') return t('proxmox.stPaused');
    if (s === 'online') return t('proxmox.stOnline');
    if (s === 'offline') return t('proxmox.stOffline');
    return status || '—';
  };

  const statusClass = (status: string): 'on' | 'off' | 'warn' => {
    const s = status.toLowerCase();
    if (s === 'running' || s === 'online') return 'on';
    if (s === 'paused' || s === 'suspended') return 'warn';
    return 'off';
  };

  // Save only the non-secret connection fields; the token secret / password are never
  // written to disk (satisfies "never store the token unmasked").
  const persist = (rememberFlag: boolean) => {
    if (typeof localStorage === 'undefined') return;
    try {
      const rec: SavedConn = {
        host: host.trim(),
        port: port || 8006,
        authMode,
        tokenId: tokenId.trim(),
        user: user.trim() || 'root',
        realm: realm.trim() || 'pam',
        trust,
        remember: rememberFlag,
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(rec));
    } catch {
      /* ignore quota / serialization errors */
    }
  };

  const connErrorFor = (p: ProbeResult): ConnState => {
    const e = (p.error || '').toLowerCase();
    if (p.httpStatus === 401 || p.httpStatus === 403) return 'unauthorized';
    if (e.includes('certificate') || e.includes('ssl') || e.includes('tls') || e.includes('trust')) return 'certUntrusted';
    return 'unreachable';
  };

  const showState = (state: ConnState, detail?: string) => {
    setConnState(state);
    switch (state) {
      case 'connected':
        setConnMsg({ sev: 'ok', text: t('proxmox.stateConnected') });
        break;
      case 'unauthorized':
        setConnMsg({ sev: 'err', text: t('proxmox.stateUnauthorized'), detail });
        break;
      case 'certUntrusted':
        setConnMsg({ sev: 'err', text: t('proxmox.stateCertUntrusted'), detail });
        break;
      case 'unreachable':
        setConnMsg({ sev: 'err', text: t('proxmox.stateUnreachable', { host: host.trim(), port: port || 8006 }), detail });
        break;
      default:
        setConnMsg(null);
    }
  };

  const connect = async () => {
    if (!canConnect) return;
    setConnBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const rows = await runPowershellJson<ProbeResult>(probeScript(inputs()));
      const p = rows[0];
      if (!p || !p.ok) {
        setConnected(false);
        setVersion('');
        setGuests(null);
        showState(p ? connErrorFor(p) : 'unreachable', p?.error);
        return;
      }
      setConnected(true);
      setVersion(p.version ? `${p.version}${p.release ? '-' + p.release : ''}` : '');
      showState('connected');
      persist(remember);
      await Promise.all([refreshGuests(true), refreshNodes()]);
    } catch (e) {
      setConnected(false);
      setVersion('');
      showState('unreachable', String(e instanceof Error ? e.message : e));
    } finally {
      setConnBusy(false);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setConnState('disconnected');
    setVersion('');
    setGuests(null);
    setNodes(null);
    setStorage(null);
    setTasks(null);
    setSelKey(null);
    setConfig('');
    setAutoRefresh(false);
    setConnMsg({ sev: 'info', text: t('proxmox.disconnected') });
  };

  const refreshGuests = async (silent: boolean) => {
    if (!connected && !silent) return;
    setBusy('guests');
    if (!silent) {
      setErr(null);
      setMsg(null);
    }
    try {
      const rows = await runPowershellJson<Guest>(listGuestsScript(inputs()));
      const sorted = rows.slice().sort((a, b) => (a.node === b.node ? a.vmid - b.vmid : a.node.localeCompare(b.node)));
      setGuests(sorted);
      if (selKey && !sorted.some((g) => keyOf(g) === selKey)) {
        setSelKey(null);
        setConfig('');
      }
    } catch (e) {
      if (!silent) setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const refreshNodes = async () => {
    try {
      const rows = await runPowershellJson<Node>(listNodesScript(inputs()));
      setNodes(rows.slice().sort((a, b) => a.node.localeCompare(b.node)));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const refreshStorage = async () => {
    setBusy('storage');
    try {
      const rows = await runPowershellJson<Storage>(listStorageScript(inputs()));
      setStorage(rows.slice().sort((a, b) => (a.node === b.node ? a.storage.localeCompare(b.storage) : a.node.localeCompare(b.node))));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const refreshTasks = async () => {
    setBusy('tasks');
    try {
      const rows = await runPowershellJson<Task>(listTasksScript(inputs(), 50));
      setTasks(rows.slice().sort((a, b) => b.startSec - a.startSec));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const loadConfig = async (g: Guest) => {
    setConfig(t('proxmox.loading'));
    try {
      const rows = await runPowershellJson<CfgRow>(configScript(inputs(), g.node, g.type, g.vmid));
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
      // Best-effort guest IP (QEMU agent) shown first when available.
      if (g.type === 'qemu' && g.status.toLowerCase() === 'running') {
        try {
          const ipRows = await runPowershellJson<{ ip: string }>(guestIpScript(inputs(), g.node, g.vmid));
          const ip = ipRows[0]?.ip ?? '';
          if (ip) lines.unshift(`${'IP'.padEnd(10)} ${ip}`);
        } catch {
          /* agent unavailable — ignore */
        }
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
    if (confirmKey && typeof window !== 'undefined' && !window.confirm(t(confirmKey, { name: g.name || `#${g.vmid}` }))) return;
    setBusy(action);
    setErr(null);
    setMsg(null);
    try {
      await runPowershellJson(powerScript(inputs(), g.node, g.type, g.vmid, action));
      setMsg(`${t(labelKey)}: ${g.name || `#${g.vmid}`}`);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
    // Status settles server-side; refresh shortly after.
    await new Promise((r) => setTimeout(r, 900));
    await refreshGuests(true);
  };

  // Auto-refresh timer (5s), mirroring the C# DispatcherTimer.
  useEffect(() => {
    if (!autoRefresh || !connected) return;
    const id = setInterval(() => {
      void refreshGuests(true);
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, connected, selKey, host, port, authMode, tokenId, secret, user, realm, password, trust]);

  const isRunning = (g: Guest | null) => !!g && g.status.toLowerCase() === 'running';
  const isPaused = (g: Guest | null) => !!g && (g.status.toLowerCase() === 'paused' || g.status.toLowerCase() === 'suspended');
  const running = isRunning(selected);
  const paused = isPaused(selected);
  const stopped = !!selected && !running && !paused;

  const cpuText = (g: Guest): string => {
    if (g.status.toLowerCase() === 'running' && g.maxCpu > 0) return `${Math.round(g.cpuFraction * 100)}% · ${g.maxCpu}`;
    return g.maxCpu > 0 ? `${g.maxCpu} vCPU` : '—';
  };
  const memText = (g: Guest): string => {
    if (g.maxMemBytes <= 0) return '—';
    return g.status.toLowerCase() === 'running'
      ? `${humanSize(g.memBytes)} / ${humanSize(g.maxMemBytes)}`
      : humanSize(g.maxMemBytes);
  };

  // Amber for the "warn" (paused/suspended) state, which the base .status-dot CSS
  // leaves grey — inline so it reads without touching global.css.
  const warnDot = { background: 'var(--warning, #E0A030)' };

  const pill = (status: string) => {
    const cls = statusClass(status);
    return (
      <span className={`status-dot ${cls}`}>
        <span className="dot" style={cls === 'warn' ? warnDot : undefined} />
        {statusLabel(status)}
      </span>
    );
  };

  // ── connection panel (always visible above the tabs) ──
  const connectionPanel = (
    <div className="panel">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('proxmox.host')}</label>
        <input className="mod-search" style={{ maxWidth: 200 }} placeholder="pve.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
        <label className="count-note">{t('proxmox.port')}</label>
        <input className="mod-search" type="number" style={{ maxWidth: 90 }} value={port} onChange={(e) => setPort(+e.target.value)} />
        {(() => {
          const st = connected ? 'on' : connState === 'disconnected' ? 'off' : 'warn';
          return (
            <span className={`status-dot ${st}`}>
              <span className="dot" style={st === 'warn' ? warnDot : undefined} />
              {connected ? t('proxmox.connectedPill') : t('proxmox.notConnectedPill')}
              {connected && version ? ` · v${version}` : ''}
            </span>
          );
        })()}
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('proxmox.authMode')}</label>
        <label className="chk">
          <input type="radio" name="pveauth" checked={authMode === 'token'} onChange={() => setAuthMode('token')} />
          {t('proxmox.authToken')}
        </label>
        <label className="chk">
          <input type="radio" name="pveauth" checked={authMode === 'ticket'} onChange={() => setAuthMode('ticket')} />
          {t('proxmox.authTicket')}
        </label>
      </div>

      {authMode === 'token' ? (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('proxmox.tokenId')}</label>
          <input className="mod-search" style={{ maxWidth: 240 }} placeholder="user@pam!tokenid" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
          <label className="count-note">{t('proxmox.tokenSecret')}</label>
          <input className="mod-search" type="password" style={{ maxWidth: 240 }} autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
      ) : (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('proxmox.user')}</label>
          <input className="mod-search" style={{ maxWidth: 140 }} placeholder="root" value={user} onChange={(e) => setUser(e.target.value)} />
          <label className="count-note">{t('proxmox.realm')}</label>
          <input className="mod-search" style={{ maxWidth: 90 }} placeholder="pam" value={realm} onChange={(e) => setRealm(e.target.value)} />
          <label className="count-note">{t('proxmox.password')}</label>
          <input className="mod-search" type="password" style={{ maxWidth: 200 }} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="chk">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          {t('proxmox.trustCert')}
        </label>
        {authMode === 'token' && (
          <label className="chk">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('proxmox.remember')}
          </label>
        )}
        <button className="mini primary" disabled={!canConnect || connBusy} onClick={() => void connect()}>
          {connBusy ? t('proxmox.connecting') : t('proxmox.connect')}
        </button>
        <button className="mini" disabled={!connected} onClick={disconnect}>
          {t('proxmox.disconnect')}
        </button>
      </div>

      {remember && authMode === 'token' && <p className="count-note" style={{ marginTop: 4 }}>{t('proxmox.rememberNote')}</p>}

      {connMsg && (
        <p
          className={connMsg.sev === 'ok' ? 'count-note dep-ok' : 'count-note'}
          style={{ marginTop: 8, color: connMsg.sev === 'err' ? 'var(--danger)' : undefined }}
        >
          {connMsg.text}
          {connMsg.detail ? ` — ${connMsg.detail}` : ''}
        </p>
      )}
    </div>
  );

  // ── Guests tab ──
  const guestsTab = () => (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!connected || !!busy} onClick={() => void refreshGuests(false)}>
          ⟳ {t('modules.refresh')}
        </button>
        <label className="chk">
          <input type="checkbox" checked={autoRefresh} disabled={!connected} onChange={(e) => setAutoRefresh(e.target.checked)} />
          {t('proxmox.autoRefresh')}
        </label>
        {guests && <span className="count-note">{t('proxmox.guestCount', { n: guests.length })}</span>}
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {msg && <p className="count-note dep-ok">{msg}</p>}

      {!guests ? (
        <p className="count-note">{connected ? t('proxmox.loading') : t('proxmox.connectFirst')}</p>
      ) : guests.length === 0 ? (
        <p className="count-note">{t('proxmox.empty')}</p>
      ) : (
        <div className="dt-wrap">
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
                    <td>
                      {g.name || `#${g.vmid}`}
                      <span className="count-note">
                        {' '}· {g.node} · #{g.vmid}
                        {g.template ? ' · template' : ''}
                        {g.lock ? ' · 🔒 ' + g.lock : ''}
                      </span>
                    </td>
                    <td>{g.type === 'lxc' ? t('proxmox.typeCt') : t('proxmox.typeVm')}</td>
                    <td>{pill(g.status)}</td>
                    <td style={{ textAlign: 'right' }}>{cpuText(g)}</td>
                    <td style={{ textAlign: 'right' }}>{memText(g)}</td>
                    <td style={{ textAlign: 'right' }}>{g.status.toLowerCase() === 'running' ? humanUptime(g.uptimeSec) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <strong>
              {selected.name || `#${selected.vmid}`} (#{selected.vmid})
            </strong>
            <button className="mini primary" disabled={!stopped || !!busy} onClick={() => void power('start', 'proxmox.start')}>
              {t('proxmox.start')}
            </button>
            <button className="mini" disabled={!running || !!busy} onClick={() => void power('shutdown', 'proxmox.shutdown', 'proxmox.confirmShutdown')}>
              {t('proxmox.shutdown')}
            </button>
            <button className="mini" disabled={(!running && !paused) || !!busy} onClick={() => void power('stop', 'proxmox.stop', 'proxmox.confirmStop')}>
              {t('proxmox.stop')}
            </button>
            <button className="mini" disabled={!running || !!busy} onClick={() => void power('reboot', 'proxmox.reboot')}>
              {t('proxmox.reboot')}
            </button>
            <button className="mini" disabled={!running || !!busy} onClick={() => void power('suspend', 'proxmox.suspend')}>
              {t('proxmox.suspend')}
            </button>
            <button className="mini" disabled={!paused || !!busy} onClick={() => void power('resume', 'proxmox.resume')}>
              {t('proxmox.resume')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => void loadConfig(selected)}>
              ⟳ {t('proxmox.reloadConfig')}
            </button>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {selected.type === 'lxc' ? t('proxmox.typeCt') : t('proxmox.typeVm')} · {t('proxmox.onNode', { node: selected.node })} · {statusLabel(selected.status)} · {selected.maxCpu} vCPU · {humanSize(selected.maxMemBytes)} RAM
          </p>
          {config && <pre className="cmd-out">{config}</pre>}
        </div>
      )}
    </div>
  );

  // ── Nodes tab (cluster info) ──
  const nodesTab = () => (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" disabled={!connected || !!busy} onClick={() => void refreshNodes()}>
          ⟳ {t('modules.refresh')}
        </button>
        {nodes && <span className="count-note">{t('proxmox.nodeCount', { n: nodes.length })}</span>}
      </div>
      {!nodes ? (
        <p className="count-note">{connected ? t('proxmox.loading') : t('proxmox.connectFirst')}</p>
      ) : nodes.length === 0 ? (
        <p className="count-note">{t('proxmox.noNodes')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('proxmox.colNode')}</th>
                <th>{t('proxmox.colStatus')}</th>
                <th style={{ textAlign: 'right' }}>{t('proxmox.colCpu')}</th>
                <th style={{ textAlign: 'right' }}>{t('proxmox.colMem')}</th>
                <th style={{ textAlign: 'right' }}>{t('proxmox.colUptime')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.node}>
                  <td>
                    {n.node}
                    {n.level ? <span className="count-note"> · {n.level}</span> : ''}
                  </td>
                  <td>{pill(n.status)}</td>
                  <td style={{ textAlign: 'right' }}>{n.status.toLowerCase() === 'online' ? `${Math.round(n.cpuFraction * 100)}%` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{n.maxMemBytes > 0 ? `${humanSize(n.memBytes)} / ${humanSize(n.maxMemBytes)}` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{n.status.toLowerCase() === 'online' ? humanUptime(n.uptimeSec) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ── Storage tab ──
  const storageTab = () => (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" disabled={!connected || !!busy} onClick={() => void refreshStorage()}>
          ⟳ {t('modules.refresh')}
        </button>
        {storage && <span className="count-note">{t('proxmox.storageCount', { n: storage.length })}</span>}
      </div>
      {!storage ? (
        <p className="count-note">{connected ? t('proxmox.storageHint') : t('proxmox.connectFirst')}</p>
      ) : storage.length === 0 ? (
        <p className="count-note">{t('proxmox.noStorage')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('proxmox.colStorage')}</th>
                <th>{t('proxmox.colNode')}</th>
                <th>{t('proxmox.colStType')}</th>
                <th>{t('proxmox.colContent')}</th>
                <th>{t('proxmox.colStStatus')}</th>
                <th style={{ textAlign: 'right' }}>{t('proxmox.colUsage')}</th>
              </tr>
            </thead>
            <tbody>
              {storage.map((s) => (
                <tr key={`${s.node}/${s.storage}`}>
                  <td>{s.storage}</td>
                  <td>{s.node}</td>
                  <td>{s.type}</td>
                  <td>
                    <span className="count-note">{s.content || '—'}</span>
                  </td>
                  <td>{pill(s.active ? 'online' : 'offline')}</td>
                  <td style={{ textAlign: 'right' }}>
                    {s.totalBytes > 0 ? `${humanSize(s.usedBytes)} / ${humanSize(s.totalBytes)} · ${pct(s.usedBytes, s.totalBytes)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ── Tasks tab ──
  const tasksTab = () => (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" disabled={!connected || !!busy} onClick={() => void refreshTasks()}>
          ⟳ {t('modules.refresh')}
        </button>
        {tasks && <span className="count-note">{t('proxmox.taskCount', { n: tasks.length })}</span>}
      </div>
      {!tasks ? (
        <p className="count-note">{connected ? t('proxmox.tasksHint') : t('proxmox.connectFirst')}</p>
      ) : tasks.length === 0 ? (
        <p className="count-note">{t('proxmox.noTasks')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('proxmox.colTask')}</th>
                <th>{t('proxmox.colNode')}</th>
                <th>{t('proxmox.colUser')}</th>
                <th>{t('proxmox.colStatus')}</th>
                <th>{t('proxmox.colStarted')}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((tk) => {
                const okStatus = (tk.status || '').toUpperCase() === 'OK';
                return (
                  <tr key={tk.upid}>
                    <td>
                      {tk.typ}
                      {tk.id ? <span className="count-note"> · {tk.id}</span> : ''}
                    </td>
                    <td>{tk.node}</td>
                    <td>
                      <span className="count-note">{tk.user}</span>
                    </td>
                    <td>
                      <span className={`status-dot ${tk.status ? (okStatus ? 'on' : 'off') : 'warn'}`}>
                        <span className="dot" style={!tk.status ? warnDot : undefined} />
                        {tk.status || t('proxmox.taskRunning')}
                      </span>
                    </td>
                    <td>
                      <span className="count-note">{localTime(tk.startSec)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)', marginTop: 0 }}>
          {t('proxmox.desktopOnly')}
        </p>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('proxmox.blurb')}
      </p>

      {connectionPanel}

      <ModuleTabs
        tabs={[
          { id: 'guests', en: 'Guests', zh: '客體', render: guestsTab },
          { id: 'nodes', en: 'Nodes', zh: '節點', render: nodesTab },
          { id: 'storage', en: 'Storage', zh: '儲存', render: storageTab },
          { id: 'tasks', en: 'Tasks', zh: '工作', render: tasksTab },
        ]}
      />

      <p className="count-note">{t('proxmox.note')}</p>
    </div>
  );
}
