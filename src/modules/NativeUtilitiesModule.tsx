import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Native module — 原生工具 / Native Utilities.
// A suite of in-app tools each built on a documented Windows capability, mirroring the
// desktop module's nine System32 P/Invoke feature groups:
//   1. Saved Wi-Fi passwords    (wlanapi   → netsh wlan show profile key=clear)
//   2. Nearby Wi-Fi scanner     (wlanapi   → netsh wlan show networks mode=bssid)
//   3. SMB shares + sessions    (netapi32  → Get-SmbShare / Get-SmbSession)
//   4. Monitor brightness       (dxva2     → WmiMonitorBrightness WMI class)
//   5. User sessions            (wtsapi32  → query session; logoff / tsdiscon)
//   6. Certificate stores       (crypt32   → Cert: PSDrive)
//   7. Live disk / GPU counters (pdh       → Get-Counter, English counter paths)
//   8. Process modules          (psapi     → (Get-Process -Id).Modules)
//   9. Paired Bluetooth         (bluetoothapis → Get-PnpDevice -Class Bluetooth)
// Reads auto-run when a tab opens; every mutation (forget / logoff / disconnect /
// set-brightness / unpair) is click-gated, and destructive ones confirm first. All
// PowerShell is 5.1-compatible and guarded so nothing ever throws to the UI. The
// browser has no native backend, so live work runs only inside the WinForge desktop app.

type Tab =
  | 'wifiSaved'
  | 'wifiScan'
  | 'smb'
  | 'brightness'
  | 'sessions'
  | 'certs'
  | 'counters'
  | 'modules'
  | 'bluetooth';

interface WifiSaved { name: string; auth: string; enc: string; key: string }
interface WifiScan { ssid: string; signal: number; auth: string; cipher: string; saved: boolean }
interface Share { name: string; path: string; type: string; desc: string }
interface SmbSess { client: string; user: string; files: number; idle: string }
interface UserSess { id: string; user: string; station: string; state: string; current: boolean }
interface Cert { subject: string; issuer: string; thumb: string; notAfter: string; expired: boolean }
interface Monitor { instance: string; active: number; description: string }
interface Counter { label: string; value: number; unit: string }
interface ProcOption { pid: number; name: string }
interface ProcMod { name: string; path: string; size: number }
interface BtDev { name: string; instanceId: string; status: string; connected: boolean }

const esc = (s: string) => s.replace(/'/g, "''");

// --- PowerShell builders (locale-independent where practical) --------------

// Saved Wi-Fi profiles + their plaintext keys, mirroring WlanGetProfile(PLAINTEXT_KEY).
// `netsh wlan show profiles` lists names; `... show profile name=X key=clear` reveals the key.
const savedScript = `
$names = (netsh wlan show profiles) 2>$null | Select-String 'All User Profile\\s*:\\s*(.+)$' |
  ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() }
foreach ($n in $names) {
  $d = (netsh wlan show profile name="$n" key=clear) 2>$null
  $auth = ($d | Select-String 'Authentication\\s*:\\s*(.+)$'); $auth = if($auth){$auth.Matches[0].Groups[1].Value.Trim()}else{''}
  $enc  = ($d | Select-String 'Cipher\\s*:\\s*(.+)$');         $enc  = if($enc){$enc.Matches[0].Groups[1].Value.Trim()}else{''}
  $key  = ($d | Select-String 'Key Content\\s*:\\s*(.+)$');    $key  = if($key){$key.Matches[0].Groups[1].Value.Trim()}else{''}
  [pscustomobject]@{ name=$n; auth=$auth; enc=$enc; key=$key }
}`;

// Nearby networks via `netsh wlan show networks mode=bssid` — SSID, auth, cipher and best signal %.
const scanScript = `
netsh wlan show networks mode=bssid 2>$null | Out-Null
$saved = @((netsh wlan show profiles) 2>$null | Select-String 'All User Profile\\s*:\\s*(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() })
$lines = (netsh wlan show networks mode=bssid) 2>$null
$cur=$null
foreach ($l in $lines) {
  if ($l -match '^SSID\\s+\\d+\\s*:\\s*(.*)$') {
    if ($cur) { $cur }
    $s = $Matches[1].Trim()
    $cur = [pscustomobject]@{ ssid=$s; signal=0; auth=''; cipher=''; saved=([bool]($saved -contains $s)) }
  } elseif ($cur -and $l -match 'Authentication\\s*:\\s*(.+)$') {
    if (-not $cur.auth) { $cur.auth = $Matches[1].Trim() }
  } elseif ($cur -and $l -match 'Encryption\\s*:\\s*(.+)$') {
    if (-not $cur.cipher) { $cur.cipher = $Matches[1].Trim() }
  } elseif ($cur -and $l -match 'Signal\\s*:\\s*(\\d+)%') {
    $v = [int]$Matches[1]; if ($v -gt $cur.signal) { $cur.signal = $v }
  }
}
if ($cur) { $cur }`;

const deleteScript = (name: string) => `netsh wlan delete profile name='${esc(name)}' 2>&1 | Out-String`;

const sharesScript = `Get-SmbShare -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name=$_.Name; path=[string]$_.Path; type=[string]$_.ShareType; desc=[string]$_.Description } }`;

const smbSessScript = `Get-SmbSession -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ client=[string]$_.ClientComputerName; user=[string]$_.ClientUserName; files=[int]$_.NumOpens; idle='' } }`;

// Logged-on sessions via `query session` (qwinsta). A leading '>' marks the current session.
const sessScript = `
$me = (query session) 2>$null
foreach ($l in $me | Select-Object -Skip 1) {
  $cur = $l.StartsWith('>')
  $t = $l.Substring(1)
  $station = $t.Substring(0,18).Trim()
  $user    = $t.Substring(18,20).Trim()
  $idPart  = $t.Substring(38,8).Trim()
  $state   = if ($t.Length -gt 46) { $t.Substring(46).Trim().Split(' ')[0] } else { '' }
  if ($station -eq '' -and $user -eq '') { continue }
  [pscustomobject]@{ id=$idPart; user=$user; station=$station; state=$state; current=$cur }
}`;

const logoffScript = (id: string) => `logoff '${esc(id)}' 2>&1 | Out-String`;
// tsdiscon disconnects a session by id but leaves programs running (WTSDisconnectSession).
const disconScript = (id: string) => `tsdiscon '${esc(id)}' 2>&1 | Out-String`;

const certScript = (store: string) => `Get-ChildItem -Path Cert:\\CurrentUser\\${store} -ErrorAction SilentlyContinue | ForEach-Object {
  $cn = $_.Subject; $m = [regex]::Match($cn,'CN=([^,]+)'); if ($m.Success) { $cn = $m.Groups[1].Value.Trim() }
  $iss = $_.Issuer; $mi = [regex]::Match($iss,'CN=([^,]+)'); if ($mi.Success) { $iss = $mi.Groups[1].Value.Trim() }
  [pscustomobject]@{ subject=$cn; issuer=$iss; thumb=[string]$_.Thumbprint; notAfter=$_.NotAfter.ToString('yyyy-MM-dd'); expired=([datetime]::Now -gt $_.NotAfter) } }`;

// Monitor brightness — WMI (root/wmi) mirrors dxva2's GetMonitorBrightness. Level is 0..100.
const brightScript = `Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ instance=[string]$_.InstanceName; active=[int]$_.CurrentBrightness; description='Display' } }`;

// SetBrightness → WmiSetBrightness(timeout, level) on WmiMonitorBrightnessMethods, keyed by InstanceName.
const setBrightScript = (instance: string, level: number) => `
$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop |
  Where-Object { $_.InstanceName -eq '${esc(instance)}' } | Select-Object -First 1
if (-not $m) { throw 'monitor not found' }
Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]${Math.round(level)} } | Out-Null
'ok'`;

// Live counters via Get-Counter with English (locale-independent) paths — disk %/read/write + GPU.
// -SampleInterval 1 gives rate counters a baseline, matching PdhCollect/Read timing.
const countersScript = `
$paths = @(
  '\\PhysicalDisk(_Total)\\% Disk Time',
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec'
)
$labels = @{ '% Disk Time'='Disk busy'; 'Disk Read Bytes/sec'='Disk read'; 'Disk Write Bytes/sec'='Disk write' }
$units  = @{ '% Disk Time'='%'; 'Disk Read Bytes/sec'='B/s'; 'Disk Write Bytes/sec'='B/s' }
$c = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
foreach ($s in $c.CounterSamples) {
  $leaf = ($s.Path -split '\\\\')[-1]
  [pscustomobject]@{ label=[string]$labels[$leaf]; value=[double]$s.CookedValue; unit=[string]$units[$leaf] }
}
$gpu = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
if ($gpu) {
  $sum = ($gpu | Measure-Object -Property CookedValue -Sum).Sum
  [pscustomobject]@{ label='GPU'; value=[double]$sum; unit='%' }
}`;

// Process list for the picker (name · pid), sorted by name.
const procListScript = `Get-Process -ErrorAction SilentlyContinue |
  Sort-Object ProcessName, Id |
  ForEach-Object { [pscustomobject]@{ pid=[int]$_.Id; name=[string]$_.ProcessName } }`;

// Loaded modules for one PID — mirrors EnumProcessModulesEx + GetModuleInformation.
const procModScript = (pid: number) => `
try {
  (Get-Process -Id ${pid} -ErrorAction Stop).Modules | ForEach-Object {
    [pscustomobject]@{ name=[string]$_.ModuleName; path=[string]$_.FileName; size=[long]$_.ModuleMemorySize }
  } | Sort-Object name
} catch { }`;

// Paired Bluetooth via Get-PnpDevice (root of bluetoothapis' BluetoothFindFirstDevice list).
const btScript = `Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like 'BTHENUM*' -or $_.InstanceId -like 'BTHLE*' } |
  ForEach-Object {
    [pscustomobject]@{ name=[string]$_.FriendlyName; instanceId=[string]$_.InstanceId; status=[string]$_.Status; connected=([bool]($_.Status -eq 'OK')) }
  } | Sort-Object @{E={-1*[int]([bool]($_.status -eq 'OK'))}}, name`;

// Unpair = remove the PnP device node (pnputil). Destructive; confirmed in the UI.
const btRemoveScript = (instanceId: string) =>
  `pnputil /remove-device "${instanceId.replace(/"/g, '')}" 2>&1 | Out-String`;

const humanBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
};

const humanRate = (bps: number): string => {
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
};

export function NativeUtilitiesModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [tab, setTab] = useState<Tab>('wifiSaved');

  const [saved, setSaved] = useState<WifiSaved[] | null>(null);
  const [scan, setScan] = useState<WifiScan[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [smbSess, setSmbSess] = useState<SmbSess[] | null>(null);
  const [sessions, setSessions] = useState<UserSess[] | null>(null);
  const [certStore, setCertStore] = useState('My');
  const [certs, setCerts] = useState<Cert[] | null>(null);

  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [counters, setCounters] = useState<Counter[] | null>(null);
  const [live, setLive] = useState(false);
  const [procs, setProcs] = useState<ProcOption[] | null>(null);
  const [selPid, setSelPid] = useState<number | null>(null);
  const [mods, setMods] = useState<ProcMod[] | null>(null);
  const [bt, setBt] = useState<BtDev[] | null>(null);

  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const guard = async <T,>(key: string, run: () => Promise<T>, set: (v: T | null) => void) => {
    if (!desktop) return;
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      set(await run());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      set(null);
    } finally {
      setBusy('');
    }
  };

  const loadSaved = () => guard('saved', () => runPowershellJson<WifiSaved>(savedScript), setSaved);
  const loadScan = () => guard('scan', () => runPowershellJson<WifiScan>(scanScript), setScan);
  const loadShares = () => guard('shares', () => runPowershellJson<Share>(sharesScript), setShares);
  const loadSmbSess = () => guard('smbSess', () => runPowershellJson<SmbSess>(smbSessScript), setSmbSess);
  const loadSessions = () => guard('sessions', () => runPowershellJson<UserSess>(sessScript), setSessions);
  const loadCerts = (store: string) => guard('certs', () => runPowershellJson<Cert>(certScript(store)), setCerts);
  const loadMonitors = () => guard('brightness', () => runPowershellJson<Monitor>(brightScript), setMonitors);
  const loadBt = () => guard('bluetooth', () => runPowershellJson<BtDev>(btScript), setBt);

  const loadProcs = async () => {
    if (!desktop) return;
    setBusy('procs');
    setErr(null);
    try {
      const list = await runPowershellJson<ProcOption>(procListScript);
      setProcs(list);
      if (list.length > 0 && selPid == null) {
        const first = list[0];
        if (first) {
          setSelPid(first.pid);
          void loadMods(first.pid);
        }
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setProcs(null);
    } finally {
      setBusy('');
    }
  };

  const loadMods = (pid: number) => guard('mods', () => runPowershellJson<ProcMod>(procModScript(pid)), setMods);

  // Live counters: poll once immediately, then every ~2s (Get-Counter already blocks 1s per read)
  // while the toggle is on and we're on the counters tab.
  const liveRef = useRef(false);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    if (!desktop || !live || tab !== 'counters') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const c = await runPowershellJson<Counter>(countersScript);
        if (!cancelled) setCounters(c);
      } catch {
        /* a tick must never surface an error */
      }
    };
    void tick();
    const h = window.setInterval(() => {
      if (!cancelled && liveRef.current) void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(h);
    };
  }, [desktop, live, tab]);

  const copyKey = async (key: string) => {
    if (!key) {
      setMsg(t('nativeu.noKey'));
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      setMsg(t('nativeu.copied'));
    } catch {
      setMsg(t('nativeu.copyFail'));
    }
  };

  const forget = async (name: string) => {
    if (!desktop) return;
    if (!window.confirm(t('nativeu.forgetConfirm', { name }))) return;
    setBusy('forget');
    setErr(null);
    setMsg(null);
    try {
      const res = await runPowershell(deleteScript(name));
      setMsg(res.success ? t('nativeu.forgot', { name }) : res.stderr.trim() || res.stdout.trim() || t('nativeu.forgotFail'));
      await loadSaved();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const logoff = async (s: UserSess) => {
    if (!desktop || s.current) return;
    if (!window.confirm(t('nativeu.logoffConfirm', { user: s.user || s.id }))) return;
    setBusy('logoff');
    setErr(null);
    setMsg(null);
    try {
      const res = await runPowershell(logoffScript(s.id));
      setMsg(res.success ? t('nativeu.loggedOff', { user: s.user || s.id }) : res.stderr.trim() || t('nativeu.logoffFail'));
      await loadSessions();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (s: UserSess) => {
    if (!desktop || s.current) return;
    if (!window.confirm(t('nativeu.disconConfirm', { user: s.user || s.id }))) return;
    setBusy('discon');
    setErr(null);
    setMsg(null);
    try {
      const res = await runPowershell(disconScript(s.id));
      setMsg(res.success ? t('nativeu.disconnected', { user: s.user || s.id }) : res.stderr.trim() || t('nativeu.disconFail'));
      await loadSessions();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const setBrightness = async (instance: string, level: number) => {
    if (!desktop) return;
    setBusy('setBright');
    setErr(null);
    setMsg(null);
    try {
      const res = await runPowershell(setBrightScript(instance, level));
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMonitors((prev) => (prev ? prev.map((m) => (m.instance === instance ? { ...m, active: level } : m)) : prev));
      setMsg(t('nativeu.brightSet', { n: level }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const unpair = async (d: BtDev) => {
    if (!desktop) return;
    if (!window.confirm(t('nativeu.unpairConfirm', { name: d.name || d.instanceId }))) return;
    setBusy('unpair');
    setErr(null);
    setMsg(null);
    try {
      const res = await runPowershell(btRemoveScript(d.instanceId));
      setMsg(res.success ? t('nativeu.unpaired', { name: d.name || d.instanceId }) : res.stderr.trim() || res.stdout.trim() || t('nativeu.unpairFail'));
      await loadBt();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const pickProc = (pid: number) => {
    setSelPid(pid);
    void loadMods(pid);
  };

  const openTab = (next: Tab) => {
    setTab(next);
    setErr(null);
    setMsg(null);
    if (next !== 'counters') setLive(false);
    if (!desktop) return;
    if (next === 'wifiSaved' && !saved) loadSaved();
    else if (next === 'wifiScan' && !scan) loadScan();
    else if (next === 'smb' && !shares && !smbSess) {
      loadShares();
      loadSmbSess();
    } else if (next === 'brightness' && !monitors) loadMonitors();
    else if (next === 'sessions' && !sessions) loadSessions();
    else if (next === 'certs' && !certs) loadCerts(certStore);
    else if (next === 'modules' && !procs) void loadProcs();
    else if (next === 'bluetooth' && !bt) loadBt();
    else if (next === 'counters') setLive(true);
  };

  const changeStore = (store: string) => {
    setCertStore(store);
    if (desktop) loadCerts(store);
  };

  const scanRows = useMemo(() => scan ?? [], [scan]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'wifiSaved', label: t('nativeu.tabSaved') },
    { id: 'wifiScan', label: t('nativeu.tabScan') },
    { id: 'smb', label: t('nativeu.tabSmb') },
    { id: 'brightness', label: t('nativeu.tabBrightness') },
    { id: 'sessions', label: t('nativeu.tabSessions') },
    { id: 'certs', label: t('nativeu.tabCerts') },
    { id: 'counters', label: t('nativeu.tabCounters') },
    { id: 'modules', label: t('nativeu.tabModules') },
    { id: 'bluetooth', label: t('nativeu.tabBluetooth') },
  ];

  return (
    <div className="mod">
      <p className="count-note">{t('nativeu.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('nativeu.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={tab === tb.id ? 'mini primary' : 'mini'}
            onClick={() => openTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {msg && <p className="count-note">{msg}</p>}

      {/* ===== Saved Wi-Fi ===== */}
      {tab === 'wifiSaved' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={loadSaved}>
              {busy === 'saved' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
            {saved && <span className="count-note">{t('nativeu.profileCount', { n: saved.length })}</span>}
          </div>
          {saved && saved.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.ssid')}</th><th>{t('nativeu.security')}</th><th>{t('nativeu.password')}</th><th /></tr></thead>
              <tbody>
                {saved.map((w) => (
                  <tr key={w.name}>
                    <td>{w.name}</td>
                    <td className="count-note">{[w.auth, w.enc].filter(Boolean).join(' / ') || '—'}</td>
                    <td style={{ fontFamily: 'monospace' }}>{w.key || t('nativeu.noPassword')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="mini" disabled={!w.key} onClick={() => copyKey(w.key)}>{t('nativeu.copy')}</button>{' '}
                      <button className="mini" disabled={!desktop || !!busy} onClick={() => forget(w.name)}>{t('nativeu.forget')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {saved && saved.length === 0 && <p className="count-note">{t('nativeu.none')}</p>}
        </div>
      )}

      {/* ===== Nearby Wi-Fi ===== */}
      {tab === 'wifiScan' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini primary" disabled={!desktop || !!busy} onClick={loadScan}>
              {busy === 'scan' ? t('nativeu.scanning') : t('nativeu.scan')}
            </button>
            {scan && <span className="count-note">{t('nativeu.networkCount', { n: scan.length })}</span>}
          </div>
          {scanRows.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.ssid')}</th><th>{t('nativeu.security')}</th><th /><th style={{ textAlign: 'right' }}>{t('nativeu.signal')}</th></tr></thead>
              <tbody>
                {scanRows.map((n, i) => (
                  <tr key={`${n.ssid}-${i}`}>
                    <td>{n.ssid || t('nativeu.hidden')}</td>
                    <td className="count-note">{[n.auth, n.cipher].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{n.saved ? <span className="count-note">{t('nativeu.savedBadge')}</span> : ''}</td>
                    <td style={{ textAlign: 'right' }}>{n.signal}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {scan && scan.length === 0 && <p className="count-note">{t('nativeu.none')}</p>}
        </div>
      )}

      {/* ===== SMB ===== */}
      {tab === 'smb' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={() => { loadShares(); loadSmbSess(); }}>
              {busy === 'shares' || busy === 'smbSess' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
          </div>
          <p className="count-note">{t('nativeu.publishedShares', { n: shares?.length ?? 0 })}</p>
          {shares && shares.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.shareName')}</th><th>{t('nativeu.sharePath')}</th><th>{t('nativeu.shareType')}</th></tr></thead>
              <tbody>
                {shares.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td style={{ fontFamily: 'monospace' }}>{s.path || '—'}</td>
                    <td className="count-note">{s.type || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="count-note" style={{ marginTop: 12 }}>
            {smbSess && smbSess.length > 0 ? t('nativeu.inboundSessions', { n: smbSess.length }) : t('nativeu.inboundNone')}
          </p>
          {smbSess && smbSess.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.client')}</th><th>{t('nativeu.user')}</th><th style={{ textAlign: 'right' }}>{t('nativeu.openFiles')}</th></tr></thead>
              <tbody>
                {smbSess.map((s, i) => (
                  <tr key={`${s.client}-${i}`}>
                    <td>{s.client || '—'}</td>
                    <td>{s.user || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.files}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ===== Monitor brightness ===== */}
      {tab === 'brightness' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={loadMonitors}>
              {busy === 'brightness' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
          </div>
          <p className="count-note">{t('nativeu.brightHint')}</p>
          {monitors && monitors.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
              {monitors.map((m, i) => (
                <div key={`${m.instance}-${i}`} className="hosts-edit" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    {m.description}{' '}
                    <span className="count-note">{m.instance}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={m.active}
                      disabled={!desktop || !!busy}
                      style={{ flex: 1 }}
                      onChange={(e) =>
                        setMonitors((prev) =>
                          prev ? prev.map((x) => (x.instance === m.instance ? { ...x, active: Number(e.target.value) } : x)) : prev,
                        )
                      }
                      onMouseUp={(e) => setBrightness(m.instance, Number((e.target as HTMLInputElement).value))}
                      onKeyUp={(e) => setBrightness(m.instance, Number((e.target as HTMLInputElement).value))}
                    />
                    <span className="count-note" style={{ minWidth: 42, textAlign: 'right' }}>{m.active}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {monitors && monitors.length === 0 && <p className="count-note">{t('nativeu.brightNone')}</p>}
        </div>
      )}

      {/* ===== User sessions ===== */}
      {tab === 'sessions' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={loadSessions}>
              {busy === 'sessions' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
          </div>
          {sessions && sessions.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.user')}</th><th>{t('nativeu.station')}</th><th>{t('nativeu.state')}</th><th>{t('nativeu.id')}</th><th /></tr></thead>
              <tbody>
                {sessions.map((s, i) => (
                  <tr key={`${s.id}-${i}`}>
                    <td>{s.current ? t('nativeu.userYou', { user: s.user || '—' }) : (s.user || '—')}</td>
                    <td className="count-note">{s.station || '—'}</td>
                    <td>{s.state || '—'}</td>
                    <td className="count-note">{s.id || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!s.current && (
                        <>
                          <button className="mini" disabled={!desktop || !!busy} onClick={() => disconnect(s)}>{t('nativeu.disconnect')}</button>{' '}
                          <button className="mini" disabled={!desktop || !!busy} onClick={() => logoff(s)}>{t('nativeu.logoff')}</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sessions && sessions.length === 0 && <p className="count-note">{t('nativeu.none')}</p>}
          <p className="count-note">{t('nativeu.sessionNote')}</p>
        </div>
      )}

      {/* ===== Certificates ===== */}
      {tab === 'certs' && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <select className="mod-select" value={certStore} onChange={(e) => changeStore(e.target.value)}>
              <option value="My">{t('nativeu.storeMy')}</option>
              <option value="Root">{t('nativeu.storeRoot')}</option>
              <option value="CA">{t('nativeu.storeCA')}</option>
            </select>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => loadCerts(certStore)}>
              {busy === 'certs' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
            {certs && <span className="count-note">{t('nativeu.certCount', { n: certs.length })}</span>}
          </div>
          {certs && certs.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.subject')}</th><th>{t('nativeu.issuer')}</th><th>{t('nativeu.validity')}</th></tr></thead>
              <tbody>
                {certs.map((c, i) => (
                  <tr key={`${c.thumb}-${i}`}>
                    <td>{c.subject || '—'}</td>
                    <td className="count-note">{c.issuer || '—'}</td>
                    <td style={{ color: c.expired ? 'var(--danger)' : undefined }}>
                      {c.expired ? t('nativeu.expired', { date: c.notAfter }) : t('nativeu.validTo', { date: c.notAfter })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {certs && certs.length === 0 && <p className="count-note">{t('nativeu.none')}</p>}
        </div>
      )}

      {/* ===== Live counters ===== */}
      {tab === 'counters' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className={live ? 'mini primary' : 'mini'} disabled={!desktop} onClick={() => setLive((v) => !v)}>
              {live ? t('nativeu.live') : t('nativeu.paused')}
            </button>
            <span className="count-note">{t('nativeu.countersHint')}</span>
          </div>
          {counters && counters.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {counters.map((c, i) => (
                <div key={`${c.label}-${i}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontWeight: 600 }}>{c.label || '—'}</span>
                    <span className="count-note">
                      {c.unit === 'B/s' ? humanRate(c.value) : `${c.value.toFixed(1)}${c.unit}`}
                    </span>
                  </div>
                  {c.unit === '%' && (
                    <div style={{ height: 4, background: 'var(--border, #333)', borderRadius: 2, overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(c.value, 100)}%`,
                          background: 'var(--accent, #4a9eff)',
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="count-note">{live ? t('nativeu.loading') : t('nativeu.countersPaused')}</p>
          )}
        </div>
      )}

      {/* ===== Process modules ===== */}
      {tab === 'modules' && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <select
              className="mod-select"
              value={selPid ?? ''}
              disabled={!desktop || !procs || !!busy}
              onChange={(e) => pickProc(Number(e.target.value))}
            >
              {(procs ?? []).map((p) => (
                <option key={p.pid} value={p.pid}>{p.name} · {p.pid}</option>
              ))}
            </select>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void loadProcs()}>
              {busy === 'procs' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
            {mods && <span className="count-note">{t('nativeu.moduleCount', { n: mods.length })}</span>}
          </div>
          {mods && mods.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.moduleName')}</th><th>{t('nativeu.modulePath')}</th><th style={{ textAlign: 'right' }}>{t('nativeu.moduleSize')}</th></tr></thead>
              <tbody>
                {mods.map((m, i) => (
                  <tr key={`${m.name}-${i}`}>
                    <td>{m.name || '?'}</td>
                    <td className="count-note" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.path || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{humanBytes(m.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {mods && mods.length === 0 && <p className="count-note">{t('nativeu.moduleNone')}</p>}
        </div>
      )}

      {/* ===== Bluetooth ===== */}
      {tab === 'bluetooth' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={loadBt}>
              {busy === 'bluetooth' ? t('nativeu.loading') : t('nativeu.refresh')}
            </button>
            {bt && <span className="count-note">{t('nativeu.btCount', { n: bt.length })}</span>}
          </div>
          {bt && bt.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.btName')}</th><th>{t('nativeu.btStatus')}</th><th /></tr></thead>
              <tbody>
                {bt.map((d, i) => (
                  <tr key={`${d.instanceId}-${i}`}>
                    <td>{d.name || t('nativeu.btUnnamed')}</td>
                    <td className="count-note">{d.connected ? t('nativeu.btConnected') : t('nativeu.btPaired')} · {d.status}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="mini" disabled={!desktop || !!busy} onClick={() => unpair(d)}>{t('nativeu.unpair')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bt && bt.length === 0 && <p className="count-note">{t('nativeu.btNone')}</p>}
        </div>
      )}

      <p className="count-note">{t('nativeu.note')}</p>
    </div>
  );
}
