import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — In-App Login / embedded browser.
// The WinForge desktop port drives an embedded WebView2 window to complete OAuth or web
// sign-ins and capture the redirect params / session cookies, keeping a separate cookie jar
// per "profile" under %LOCALAPPDATA%\WinForge\WebView2.
//
// A plain browser can neither embed a privileged WebView2 host nor read another site's
// cookies (same-origin policy), so the live actions run only inside the WinForge desktop
// app. Here we faithfully port the same plumbing via the native backend (PowerShell):
//  - open a provider's sign-in URL in the system Edge browser using a dedicated
//    per-profile --user-data-dir (the same cookie-jar-per-profile model),
//  - detect the WebView2 / Edge runtime,
//  - list the cookie-jar profiles on disk, and
//  - sign out / clear a profile by deleting its folder.

interface Preset {
  key: string;
  startUrl: string;
  redirectPrefix: string | null;
  cookieNames: string[];
  cookieDomain: string | null;
  completeOnCookies: boolean;
}

// Mirrors the C# Presets list (labels come from t('weblogin.provider.<key>')).
const PRESETS: Preset[] = [
  { key: 'manual', startUrl: 'https://www.bing.com', redirectPrefix: null, cookieNames: [], cookieDomain: null, completeOnCookies: false },
  { key: 'github', startUrl: 'https://github.com/login', redirectPrefix: null, cookieNames: ['user_session', 'logged_in'], cookieDomain: 'https://github.com', completeOnCookies: true },
  { key: 'cloudflare', startUrl: 'https://dash.cloudflare.com/login', redirectPrefix: null, cookieNames: ['CF_Authorization', '__cf_logged_in'], cookieDomain: 'https://dash.cloudflare.com', completeOnCookies: false },
  { key: 'openai', startUrl: 'https://platform.openai.com/login', redirectPrefix: null, cookieNames: ['__Secure-next-auth.session-token'], cookieDomain: 'https://platform.openai.com', completeOnCookies: false },
  { key: 'anthropic', startUrl: 'https://console.anthropic.com/login', redirectPrefix: null, cookieNames: ['sessionKey', '__session'], cookieDomain: 'https://console.anthropic.com', completeOnCookies: false },
  { key: 'bitwarden', startUrl: 'https://vault.bitwarden.com', redirectPrefix: null, cookieNames: ['user'], cookieDomain: 'https://vault.bitwarden.com', completeOnCookies: false },
  { key: 'oauthDemo', startUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', redirectPrefix: 'http://localhost', cookieNames: [], cookieDomain: null, completeOnCookies: false },
];

interface ProfileRow {
  name: string;
  path: string;
}

const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'";

// Sanitize a profile name to a safe folder name (mirrors WebLoginService.Sanitize).
const UNSAFE_NAME = /[<>:"/\\|?*]/g;
const WHITESPACE = /\s+/g;
const sanitizeProfile = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return 'default';
  const cleaned = trimmed.replace(UNSAFE_NAME, '_').replace(WHITESPACE, '_').trim();
  return cleaned.length ? cleaned : 'default';
};

const PROFILES_ROOT = "Join-Path $env:LOCALAPPDATA 'WinForge\\WebView2'";

// Resolve the system Edge executable and launch it with a dedicated user-data folder.
// $folder must be defined earlier in the same script.
function edgeLaunchScript(url: string): string {
  return (
    `$edge=$null; ` +
    `$cands=@(); ` +
    `if($env:ProgramFiles){ $cands+= (Join-Path $env:ProgramFiles 'Microsoft\\Edge\\Application\\msedge.exe') } ` +
    `$px=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); ` +
    `if($px){ $cands+= (Join-Path $px 'Microsoft\\Edge\\Application\\msedge.exe') } ` +
    `foreach($c in $cands){ if($c -and (Test-Path -LiteralPath $c)){ $edge=$c; break } } ` +
    `if(-not $edge){ $g=Get-Command msedge.exe -ErrorAction SilentlyContinue; if($g){ $edge=$g.Source } } ` +
    `if(-not $edge){ Write-Error 'Microsoft Edge (msedge.exe) was not found.'; exit 1 } ` +
    `Start-Process -FilePath $edge -ArgumentList @(('--user-data-dir=' + $folder), ${psQuote(url)})`
  );
}

export function WebLoginModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [providerIdx, setProviderIdx] = useState(0);
  const [profile, setProfile] = useState('default');
  const [address, setAddress] = useState('https://www.bing.com');
  const [profiles, setProfiles] = useState<ProfileRow[] | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null); // Edge/WebView2 version, '' = missing, null = unknown
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'info' | 'err'; text: string } | null>(null);

  const preset = PRESETS[providerIdx] ?? PRESETS[0]!;

  const refreshProfiles = useCallback(async () => {
    if (!desktop) return;
    try {
      const script =
        `$root=${PROFILES_ROOT}; ` +
        `if(!(Test-Path -LiteralPath $root)){ New-Item -ItemType Directory -Force -Path $root | Out-Null } ` +
        `Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ` +
        `Sort-Object Name | ForEach-Object { [pscustomobject]@{ name=$_.Name; path=$_.FullName } }`;
      const rows = await runPowershellJson<ProfileRow>(script);
      const hasDefault = rows.some((r) => r.name.toLowerCase() === 'default');
      const merged = hasDefault ? rows : [{ name: 'default', path: '' }, ...rows];
      setProfiles(merged);
    } catch {
      setProfiles([{ name: 'default', path: '' }]);
    }
  }, [desktop]);

  const detectRuntime = useCallback(async () => {
    if (!desktop) return;
    try {
      // Prefer the WebView2 Runtime version from the registry; fall back to msedge.exe presence.
      const clients =
        "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'," +
        "'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'," +
        "'HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'";
      const script =
        `$v=$null; ` +
        `foreach($k in @(${clients})){ try{ $p=Get-ItemProperty -Path $k -ErrorAction Stop; if($p.pv){ $v=$p.pv; break } }catch{} } ` +
        `if(-not $v){ try{ $e=Get-Command msedge.exe -ErrorAction SilentlyContinue; if($e){ $v=(Get-Item $e.Source).VersionInfo.ProductVersion } }catch{} } ` +
        `Write-Output ([string]$v)`;
      const res = await runPowershell(script);
      setRuntime((res.stdout || '').trim());
    } catch {
      setRuntime('');
    }
  }, [desktop]);

  useEffect(() => {
    void refreshProfiles();
    void detectRuntime();
  }, [refreshProfiles, detectRuntime]);

  // Open the current provider's start URL (or the typed address, for the manual preset)
  // in system Edge using a dedicated per-profile user-data folder — the same
  // one-cookie-jar-per-profile model as the embedded browser.
  const openLogin = async () => {
    if (!desktop) return;
    const safe = sanitizeProfile(profile);
    let url = preset.startUrl;
    if (preset.redirectPrefix === null && preset.cookieNames.length === 0) {
      let typed = address.trim();
      if (typed.length > 0) {
        if (!typed.includes('://')) typed = 'https://' + typed;
        url = typed;
      }
    }
    setBusy('open');
    setStatus(null);
    try {
      const script =
        `$root=${PROFILES_ROOT}; ` +
        `$folder=Join-Path $root ${psQuote(safe)}; ` +
        `New-Item -ItemType Directory -Force -Path $folder | Out-Null; ` +
        edgeLaunchScript(url);
      const res = await runPowershell(script);
      if (res.success) {
        setStatus({ kind: 'ok', text: t('weblogin.opened', { profile: safe }) });
        await refreshProfiles();
      } else {
        setStatus({ kind: 'err', text: (res.stderr || res.stdout || `exit ${res.code}`).trim() });
      }
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  // Navigate: open the typed address in the current profile's Edge window.
  const navigate = async () => {
    if (!desktop) return;
    let url = address.trim();
    if (!url) return;
    if (!url.includes('://')) url = 'https://' + url;
    const safe = sanitizeProfile(profile);
    setBusy('go');
    setStatus(null);
    try {
      const script =
        `$root=${PROFILES_ROOT}; ` +
        `$folder=Join-Path $root ${psQuote(safe)}; ` +
        `New-Item -ItemType Directory -Force -Path $folder | Out-Null; ` +
        edgeLaunchScript(url);
      const res = await runPowershell(script);
      if (res.success) setStatus({ kind: 'ok', text: t('weblogin.navigated', { url }) });
      else setStatus({ kind: 'err', text: (res.stderr || res.stdout || `exit ${res.code}`).trim() });
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  // Sign out / clear: delete the profile's cookie-jar folder (mirrors ClearProfile).
  const clearProfile = async () => {
    if (!desktop) return;
    const safe = sanitizeProfile(profile);
    setBusy('clear');
    setStatus(null);
    try {
      const script =
        `$root=${PROFILES_ROOT}; ` +
        `$folder=Join-Path $root ${psQuote(safe)}; ` +
        `if(Test-Path -LiteralPath $folder){ ` +
        `try{ Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction Stop; Write-Output 'ok' } ` +
        `catch{ Write-Error 'in-use'; exit 1 } } else { Write-Output 'ok' }`;
      const res = await runPowershell(script);
      if (res.success) setStatus({ kind: 'ok', text: t('weblogin.cleared', { profile: safe }) });
      else setStatus({ kind: 'err', text: t('weblogin.clearFailed') });
      await refreshProfiles();
    } catch {
      setStatus({ kind: 'err', text: t('weblogin.clearFailed') });
    } finally {
      setBusy('');
    }
  };

  const onProviderChange = (idxRaw: number) => {
    const idx = idxRaw >= 0 && idxRaw < PRESETS.length ? idxRaw : 0;
    setProviderIdx(idx);
    const p = PRESETS[idx]!;
    setAddress(p.startUrl);
    setStatus(null);
  };

  const runtimeMissing = runtime !== null && runtime.trim() === '';
  const runtimeOk = runtime !== null && runtime.trim() !== '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('weblogin.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('weblogin.desktopOnly')}</p>
      )}

      {desktop && runtimeMissing && (
        <p className="dep-missing">⚠ {t('weblogin.runtimeMissing')}</p>
      )}
      {desktop && runtimeOk && (
        <p className="dep-ok">✓ {t('weblogin.runtimeOk', { version: runtime!.trim() })}</p>
      )}

      {/* Provider + profile selection */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="label">{t('weblogin.provider')}</label>
        <select
          className="mod-select"
          value={providerIdx}
          onChange={(e) => onProviderChange(Number(e.target.value))}
        >
          {PRESETS.map((p, i) => (
            <option key={p.key} value={i}>{t(`weblogin.provider.${p.key}`)}</option>
          ))}
        </select>

        <label className="label">{t('weblogin.profile')}</label>
        <input
          className="mod-search"
          style={{ maxWidth: 160 }}
          list="weblogin-profiles"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          placeholder="default"
        />
        <datalist id="weblogin-profiles">
          {(profiles ?? []).map((p) => (
            <option key={p.name} value={p.name} />
          ))}
        </datalist>

        <button className="mini primary" disabled={!desktop || !!busy} onClick={openLogin}>
          {busy === 'open' ? t('weblogin.opening') : t('weblogin.capture')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={clearProfile}>
          {busy === 'clear' ? t('weblogin.clearing') : t('weblogin.clear')}
        </button>
      </div>

      {/* Address bar */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 220 }}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && desktop && !busy) void navigate(); }}
          placeholder={t('weblogin.addressPlaceholder')}
        />
        <button className="mini" disabled={!desktop || !!busy} onClick={navigate}>
          {busy === 'go' ? t('weblogin.opening') : t('weblogin.go')}
        </button>
      </div>

      {/* What the selected provider captures */}
      <div className="panel">
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('weblogin.startUrl')}</span>
            <span className="value" style={{ fontFamily: 'monospace' }}>{preset.startUrl}</span>
          </div>
          {preset.redirectPrefix && (
            <div className="kv-row">
              <span className="label">{t('weblogin.redirectPrefix')}</span>
              <span className="value" style={{ fontFamily: 'monospace' }}>{preset.redirectPrefix}</span>
            </div>
          )}
          <div className="kv-row">
            <span className="label">{t('weblogin.cookies')}</span>
            <span className="value" style={{ fontFamily: 'monospace' }}>
              {preset.cookieNames.length ? preset.cookieNames.join(', ') : t('weblogin.none')}
            </span>
          </div>
          {preset.cookieDomain && (
            <div className="kv-row">
              <span className="label">{t('weblogin.cookieDomain')}</span>
              <span className="value" style={{ fontFamily: 'monospace' }}>{preset.cookieDomain}</span>
            </div>
          )}
          <div className="kv-row">
            <span className="label">{t('weblogin.completeOnCookies')}</span>
            <span className="value">{preset.completeOnCookies ? t('weblogin.yes') : t('weblogin.no')}</span>
          </div>
        </div>
      </div>

      {status && (
        <pre className={`cmd-out ${status.kind === 'err' ? 'error' : ''}`}>{status.text}</pre>
      )}

      {/* Cookie-jar profiles on disk */}
      {desktop && profiles && profiles.length > 0 && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('weblogin.profilesOnDisk', { count: profiles.length })}
          </p>
          <table className="dt">
            <thead>
              <tr>
                <th>{t('weblogin.profileCol')}</th>
                <th>{t('weblogin.pathCol')}</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.path || t('weblogin.notCreated')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="count-note">{t('weblogin.note')}</p>
    </div>
  );
}
