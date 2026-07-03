import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Native module — 原生工具 / Native Utilities.
// A suite of in-app tools each built on a documented Windows capability: saved & nearby
// Wi-Fi (netsh wlan → wlanapi), SMB shares + inbound sessions (Get-SmbShare/Get-SmbSession
// → netapi32), logged-on user sessions (query session → wtsapi32) and certificate stores
// (Cert: PSDrive → crypt32). The browser has none of these, so live work runs only inside
// the WinForge desktop app; guarded everywhere so nothing ever throws to the UI.

type Tab = 'wifiSaved' | 'wifiScan' | 'smb' | 'sessions' | 'certs';

interface WifiSaved { name: string; auth: string; enc: string; key: string }
interface WifiScan { ssid: string; signal: number; auth: string; saved: boolean }
interface Share { name: string; path: string; type: string; desc: string }
interface SmbSess { client: string; user: string; files: number; idle: string }
interface UserSess { id: string; user: string; station: string; state: string; current: boolean }
interface Cert { subject: string; issuer: string; thumb: string; notAfter: string; expired: boolean }

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

// Nearby networks via `netsh wlan show networks mode=bssid` — SSID, auth and best signal %.
const scanScript = `
netsh wlan show networks mode=bssid 2>$null | Out-Null
$saved = @((netsh wlan show profiles) 2>$null | Select-String 'All User Profile\\s*:\\s*(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() })
$lines = (netsh wlan show networks mode=bssid) 2>$null
$cur=$null
foreach ($l in $lines) {
  if ($l -match '^SSID\\s+\\d+\\s*:\\s*(.*)$') {
    if ($cur) { $cur }
    $s = $Matches[1].Trim()
    $cur = [pscustomobject]@{ ssid=$s; signal=0; auth=''; saved=([bool]($saved -contains $s)) }
  } elseif ($cur -and $l -match 'Authentication\\s*:\\s*(.+)$') {
    if (-not $cur.auth) { $cur.auth = $Matches[1].Trim() }
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

const certScript = (store: string) => `Get-ChildItem -Path Cert:\\CurrentUser\\${store} -ErrorAction SilentlyContinue | ForEach-Object {
  $cn = $_.Subject; $m = [regex]::Match($cn,'CN=([^,]+)'); if ($m.Success) { $cn = $m.Groups[1].Value.Trim() }
  $iss = $_.Issuer; $mi = [regex]::Match($iss,'CN=([^,]+)'); if ($mi.Success) { $iss = $mi.Groups[1].Value.Trim() }
  [pscustomobject]@{ subject=$cn; issuer=$iss; thumb=[string]$_.Thumbprint; notAfter=$_.NotAfter.ToString('yyyy-MM-dd'); expired=([datetime]::Now -gt $_.NotAfter) } }`;

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

  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const guard = async <T,>(key: string, run: () => Promise<T>, set: (v: T | null) => void) => {
    if (!desktop) return;
    setBusy(key); setErr(null); setMsg(null);
    try { set(await run()); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); set(null); }
    finally { setBusy(''); }
  };

  const loadSaved = () => guard('saved', () => runPowershellJson<WifiSaved>(savedScript), setSaved);
  const loadScan = () => guard('scan', () => runPowershellJson<WifiScan>(scanScript), setScan);
  const loadShares = () => guard('shares', () => runPowershellJson<Share>(sharesScript), setShares);
  const loadSmbSess = () => guard('smbSess', () => runPowershellJson<SmbSess>(smbSessScript), setSmbSess);
  const loadSessions = () => guard('sessions', () => runPowershellJson<UserSess>(sessScript), setSessions);
  const loadCerts = (store: string) => guard('certs', () => runPowershellJson<Cert>(certScript(store)), setCerts);

  const copyKey = async (key: string) => {
    if (!key) { setMsg(t('nativeu.noKey')); return; }
    try { await navigator.clipboard.writeText(key); setMsg(t('nativeu.copied')); }
    catch { setMsg(t('nativeu.copyFail')); }
  };

  const forget = async (name: string) => {
    if (!desktop) return;
    setBusy('forget'); setErr(null); setMsg(null);
    try {
      const res = await runPowershell(deleteScript(name));
      setMsg(res.success ? t('nativeu.forgot', { name }) : (res.stderr.trim() || res.stdout.trim() || t('nativeu.forgotFail')));
      await loadSaved();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(''); }
  };

  const logoff = async (s: UserSess) => {
    if (!desktop || s.current) return;
    setBusy('logoff'); setErr(null); setMsg(null);
    try {
      const res = await runPowershell(logoffScript(s.id));
      setMsg(res.success ? t('nativeu.loggedOff', { user: s.user || s.id }) : (res.stderr.trim() || t('nativeu.logoffFail')));
      await loadSessions();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(''); }
  };

  const openTab = (next: Tab) => {
    setTab(next); setErr(null); setMsg(null);
    if (!desktop) return;
    if (next === 'wifiSaved' && !saved) loadSaved();
    else if (next === 'wifiScan' && !scan) loadScan();
    else if (next === 'smb' && !shares && !smbSess) { loadShares(); loadSmbSess(); }
    else if (next === 'sessions' && !sessions) loadSessions();
    else if (next === 'certs' && !certs) loadCerts(certStore);
  };

  const changeStore = (store: string) => { setCertStore(store); if (desktop) loadCerts(store); };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'wifiSaved', label: t('nativeu.tabSaved') },
    { id: 'wifiScan', label: t('nativeu.tabScan') },
    { id: 'smb', label: t('nativeu.tabSmb') },
    { id: 'sessions', label: t('nativeu.tabSessions') },
    { id: 'certs', label: t('nativeu.tabCerts') },
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
          {scan && scan.length > 0 && (
            <table className="dt">
              <thead><tr><th>{t('nativeu.ssid')}</th><th>{t('nativeu.security')}</th><th style={{ textAlign: 'right' }}>{t('nativeu.signal')}</th><th /></tr></thead>
              <tbody>
                {scan.map((n, i) => (
                  <tr key={`${n.ssid}-${i}`}>
                    <td>{n.ssid || t('nativeu.hidden')}</td>
                    <td className="count-note">{n.auth || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{n.signal}%</td>
                    <td>{n.saved ? <span className="count-note">{t('nativeu.savedBadge')}</span> : ''}</td>
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
                    <td>
                      {!s.current && (
                        <button className="mini" disabled={!desktop || !!busy} onClick={() => logoff(s)}>{t('nativeu.logoff')}</button>
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

      <p className="count-note">{t('nativeu.note')}</p>
    </div>
  );
}
