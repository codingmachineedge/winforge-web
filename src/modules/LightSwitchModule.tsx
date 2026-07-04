import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAsync, AsyncState, ModuleToolbar, StatusDot } from './common';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Port of WinForge Pages/LightSwitchModule + LightSwitchService (PowerToys LightSwitch
// clone): schedule the Windows light/dark theme by fixed times or computed
// sunrise/sunset, apply it live (HKCU Personalize + WM_SETTINGCHANGE / WM_THEMECHANGED
// broadcast, ColorPrevalence reset on light), switch now, auto-detect location by IP,
// show a detailed current-theme + schedule status, and register a schtasks background
// job so switching keeps working when WinForge is closed. The per-minute scheduler runs
// in the webview while the app is open; settings persist to localStorage.

type Scope = 'both' | 'apps' | 'system';
type Mode = 'off' | 'fixed' | 'sun';

interface Settings {
  enabled: boolean;
  scope: Scope;
  mode: Mode;
  lightAt: string; // HH:MM
  darkAt: string;
  lat: string; // decimal degrees, stored as text (matches C# string coords)
  lon: string;
  sunriseOff: number; // minutes, may be negative
  sunsetOff: number;
}

const KEY = 'winforge-web.lightswitch.v2';
const TASK_NAME = 'WinForge LightSwitch';

const DEFAULTS: Settings = {
  enabled: false,
  scope: 'both',
  mode: 'off',
  lightAt: '07:00',
  darkAt: '19:00',
  lat: '',
  lon: '',
  sunriseOff: 0,
  sunsetOff: 0,
};

function load(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Settings> & { lat?: unknown; lon?: unknown };
    // Migrate v1 numeric coords → strings.
    const lat = typeof p.lat === 'number' ? String(p.lat) : (p.lat ?? '');
    const lon = typeof p.lon === 'number' ? String(p.lon) : (p.lon ?? '');
    return { ...DEFAULTS, ...p, lat: String(lat), lon: String(lon) };
  } catch {
    return DEFAULTS;
  }
}

// Reads AppsUseLightTheme / SystemUsesLightTheme (default light when the value is absent).
const CURRENT_PS = `
$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
[pscustomobject]@{
  apps   = ((Get-ItemProperty $p -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme -ne 0)
  system = ((Get-ItemProperty $p -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme -ne 0)
} | ConvertTo-Json
`;

// Writes the chosen scope's DWORDs, resets ColorPrevalence when going light (matches
// PowerToys — stops a coloured taskbar lingering), then broadcasts WM_SETTINGCHANGE
// (ImmersiveColorSet) + WM_THEMECHANGED so the change applies live.
function applyPs(light: boolean, scope: Scope): string {
  const val = light ? 1 : 0;
  const apps = scope !== 'system';
  const system = scope !== 'apps';
  return `
Add-Type -Name WfLs -Namespace Wf -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.IntPtr wParam, string lParam, uint flags, uint timeout, out System.IntPtr result);
'@
$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
New-Item -Path $p -Force | Out-Null
${apps ? `Set-ItemProperty $p -Name AppsUseLightTheme -Value ${val} -Type DWord` : ''}
${system ? `Set-ItemProperty $p -Name SystemUsesLightTheme -Value ${val} -Type DWord` : ''}
${system && light ? `Set-ItemProperty $p -Name ColorPrevalence -Value 0 -Type DWord` : ''}
$r = [System.IntPtr]::Zero
[void][Wf.WfLs]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.IntPtr]::Zero, 'ImmersiveColorSet', 2, 5000, [ref]$r)
[void][Wf.WfLs]::SendMessageTimeout([System.IntPtr]0xffff, 0x031A, [System.IntPtr]::Zero, '', 2, 5000, [ref]$r)
"Applied ${light ? 'light' : 'dark'} (${scope})"
`;
}

// ── coordinates ──

function coordsValid(lat: string, lon: string): boolean {
  const la = Number(lat);
  const lo = Number(lon);
  if (lat.trim() === '' || lon.trim() === '') return false;
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (la === 0 && lo === 0) return false; // null-island guard (matches C#)
  return la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

// ── sunrise / sunset ──
// Port of LightSwitchService.CalculateSunriseSunset — the "Sunrise/Sunset Algorithm"
// (Almanac for Computers, 1990), the same one PowerToys LightSwitch uses. Returns local
// minutes-of-day; -1 for a boundary the sun never crosses today (polar day/night).
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
function mod360(v: number): number {
  while (v < 0) v += 360;
  while (v > 360) v -= 360;
  return v;
}
function sunTimes(lat: number, lon: number, date: Date): { sunrise: number; sunset: number } {
  const zenith = 90.833;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const N1 = Math.floor((275 * month) / 9);
  const N2 = Math.floor((month + 9) / 12);
  const N3 = Math.floor(1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3));
  const N = N1 - N2 * N3 + day - 30;

  // Local time-zone offset in hours for this date (JS getTimezoneOffset is minutes, UTC−local).
  const tzHours = -date.getTimezoneOffset() / 60;

  const calc = (sunrise: boolean): number => {
    const lngHour = lon / 15;
    const t = sunrise ? N + (6 - lngHour) / 24 : N + (18 - lngHour) / 24;

    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(D2R * M) + 0.02 * Math.sin(2 * D2R * M) + 282.634;
    L = mod360(L);

    let RA = R2D * Math.atan(0.91764 * Math.tan(D2R * L));
    RA = mod360(RA);
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = (RA + (Lquadrant - RAquadrant)) / 15;

    const sinDec = 0.39782 * Math.sin(D2R * L);
    const cosDec = Math.cos(Math.asin(sinDec));

    const cosH = (Math.cos(D2R * zenith) - sinDec * Math.sin(D2R * lat)) / (cosDec * Math.cos(D2R * lat));
    if (cosH > 1 || cosH < -1) return -1; // never rises / never sets today

    let H = sunrise ? 360 - R2D * Math.acos(cosH) : R2D * Math.acos(cosH);
    H /= 15;

    const T = H + RA - 0.06571 * t - 6.622;
    let UT = T - lngHour;
    while (UT < 0) UT += 24;
    while (UT >= 24) UT -= 24;

    let local = UT + tzHours;
    while (local < 0) local += 24;
    while (local >= 24) local -= 24;
    let hour = Math.floor(local);
    let minute = Math.round((local - hour) * 60);
    if (minute === 60) {
      minute = 0;
      hour = (hour + 1) % 24;
    }
    return hour * 60 + minute;
  };

  return { sunrise: calc(true), sunset: calc(false) };
}

const hhmm = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const wrap = (m: number) => (((m % 1440) + 1440) % 1440);

// Decide light vs dark from light-start / dark-start minutes, handling midnight wrap.
// Matches LightSwitchService.ShouldBeLight (degenerate equal → always light).
function shouldBeLight(nowMin: number, lightStart: number, darkStart: number): boolean {
  if (lightStart === darkStart) return true;
  if (lightStart < darkStart) return nowMin >= lightStart && nowMin < darkStart;
  return nowMin >= lightStart || nowMin < darkStart;
}

// Given settings + now, should the theme be light? null = undecidable (off / bad coords / polar).
function shouldBeLightNow(s: Settings, now: Date): boolean | null {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (s.mode === 'fixed') {
    return shouldBeLight(nowMin, wrap(toMin(s.lightAt)), wrap(toMin(s.darkAt)));
  }
  if (s.mode === 'sun') {
    if (!coordsValid(s.lat, s.lon)) return null;
    const st = sunTimes(Number(s.lat), Number(s.lon), now);
    if (st.sunrise < 0 || st.sunset < 0) return null;
    return shouldBeLight(nowMin, wrap(st.sunrise + s.sunriseOff), wrap(st.sunset + s.sunsetOff));
  }
  return null;
}

export function LightSwitchModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [s, setS] = useState<Settings>(load);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(true);
  const [busy, setBusy] = useState<'apply' | 'detect' | 'bg' | null>(null);
  // Ticks once a minute so status/preview text stays current (sun times, "wants light now").
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s]);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const current = useAsync(async () => {
    if (!live) return null;
    const rows = await runPowershellJson<{ apps: boolean; system: boolean }>(CURRENT_PS);
    return rows[0] ?? null;
  }, [live]);

  // Background schtasks job state (present when the query succeeds).
  const bgJob = useAsync(async () => {
    if (!live) return false;
    const res = await runPowershell(`schtasks.exe /Query /TN "${TASK_NAME}" 2>$null; if ($LASTEXITCODE -eq 0) { 'yes' } else { 'no' }`);
    return res.stdout.trim().endsWith('yes');
  }, [live]);

  const report = (r: { success: boolean; stdout: string; stderr: string }, okMsg?: string) => {
    setOk(r.success);
    setMsg(r.success ? (okMsg ?? r.stdout.trim()) : (r.stderr.trim() || r.stdout.trim() || t('lightswitch.failed')));
  };

  const apply = (light: boolean) => {
    if (!live) return;
    setBusy('apply');
    setMsg(null);
    runPowershell(applyPs(light, s.scope)).then(
      (r) => {
        report(r, light ? t('lightswitch.switchedLight') : t('lightswitch.switchedDark'));
        current.reload();
        setBusy(null);
      },
      (e) => {
        setOk(false);
        setMsg(String(e));
        setBusy(null);
      },
    );
  };

  // Best-effort IP geolocation via PowerShell (webview CSP blocks direct fetch; the
  // backend shells out with no such restriction). Mirrors DetectLocationByIpAsync.
  const detect = async () => {
    if (!live) return;
    setBusy('detect');
    setMsg(null);
    try {
      const rows = await runPowershellJson<{ status: string; lat: number; lon: number; city: string; country: string }>(
        `try { Invoke-RestMethod -Uri 'http://ip-api.com/json/?fields=status,lat,lon,city,country' -TimeoutSec 8 } catch { [pscustomobject]@{ status='fail' } }`,
      );
      const r = rows[0];
      if (r && r.status === 'success' && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        upd({ lat: String(r.lat), lon: String(r.lon) });
        const place = [r.city, r.country].filter((x) => x && String(x).trim()).join(', ');
        setOk(true);
        setMsg(t('lightswitch.detected', { place: place || `${r.lat}, ${r.lon}` }));
      } else {
        setOk(false);
        setMsg(t('lightswitch.detectFail'));
      }
    } catch (e) {
      setOk(false);
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleBg = async () => {
    if (!live) return;
    const enabling = !bgJob.data;
    if (!enabling && !window.confirm(t('lightswitch.bgRemoveConfirm'))) return;
    setBusy('bg');
    setMsg(null);
    try {
      // Register the app's --apply-theme headless entrypoint to run every minute
      // (/RL LIMITED → no elevation needed for HKCU writes). Idempotent via /F.
      const exe = 'WinForge.exe';
      const cmd = enabling
        ? `schtasks.exe /Create /SC MINUTE /MO 1 /TN "${TASK_NAME}" /TR "\\"$env:LOCALAPPDATA\\Programs\\WinForge\\${exe}\\" --apply-theme" /RL LIMITED /F`
        : `schtasks.exe /Delete /TN "${TASK_NAME}" /F`;
      const res = await runPowershell(`${cmd}; if ($LASTEXITCODE -ne 0) { throw "schtasks exit $LASTEXITCODE" }; 'ok'`);
      report(res, enabling ? t('lightswitch.bgScheduled') : t('lightswitch.bgRemoved'));
    } catch (e) {
      setOk(false);
      setMsg(String(e));
    } finally {
      setBusy(null);
      bgJob.reload();
    }
  };

  const upd = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  // Live scheduler: while enabled, evaluate the target theme each minute and apply on change.
  useEffect(() => {
    if (!live || !s.enabled || s.mode === 'off') return;
    let last: boolean | null = null;
    const run = () => {
      const should = shouldBeLightNow(s, new Date(Date.now()));
      if (should === null || should === last) return;
      last = should;
      runPowershell(applyPs(should, s.scope)).then(() => current.reload()).catch(() => {});
    };
    run();
    const id = setInterval(run, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, s]);

  const now = useMemo(() => new Date(Date.now()), [tick]);
  const sun = useMemo(
    () => (coordsValid(s.lat, s.lon) ? sunTimes(Number(s.lat), Number(s.lon), now) : null),
    [s.lat, s.lon, now],
  );

  // Detailed status text: current apps/system theme + what the schedule wants now.
  const statusText = useMemo(() => {
    const c = current.data;
    const appsTxt = c ? (c.apps ? t('lightswitch.themeLight') : t('lightswitch.themeDark')) : '—';
    const sysTxt = c ? (c.system ? t('lightswitch.themeLight') : t('lightswitch.themeDark')) : '—';
    const modeTxt =
      s.mode === 'fixed' ? t('lightswitch.mode_fixed') : s.mode === 'sun' ? t('lightswitch.mode_sun') : t('lightswitch.mode_off');
    let sched: string;
    if (!s.enabled) {
      sched = t('lightswitch.schedOff');
    } else {
      const want = shouldBeLightNow(s, now);
      sched =
        want === null
          ? t('lightswitch.schedUndecided', { mode: modeTxt })
          : want
            ? t('lightswitch.schedWantsLight', { mode: modeTxt })
            : t('lightswitch.schedWantsDark', { mode: modeTxt });
    }
    return t('lightswitch.statusLine', { apps: appsTxt, system: sysTxt, sched });
  }, [current.data, s, now, t]);

  const themeNow = current.data
    ? current.data.apps
      ? t('lightswitch.themeLight')
      : t('lightswitch.themeDark')
    : '—';

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={() => apply(true)} disabled={!live || busy !== null}>
          {t('lightswitch.lightNow')}
        </button>
        <button className="mini" onClick={() => apply(false)} disabled={!live || busy !== null}>
          {t('lightswitch.darkNow')}
        </button>
        <button className="mini" onClick={current.reload} disabled={!live}>
          ⟳ {t('lightswitch.refresh')}
        </button>
        <StatusDot ok={live} label={live ? themeNow : t('lightswitch.preview')} />
      </ModuleToolbar>
      <p className="count-note">{t('lightswitch.blurb')}</p>
      {msg && <p className={`mod-msg${ok ? '' : ' error'}`}>{msg}</p>}

      {live ? (
        <AsyncState loading={current.loading} error={current.error}>
          {/* Current theme + schedule status */}
          <div className="panel" style={{ marginBottom: 10 }}>
            <strong>{t('lightswitch.currentTheme')}</strong>
            <div className="count-note" style={{ margin: '4px 0 0' }}>{statusText}</div>
          </div>

          {/* Enable + scope */}
          <div className="panel" style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={s.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
              <strong>{t('lightswitch.enable')}</strong>
            </label>
            <div className="count-note" style={{ margin: '4px 0 10px' }}>{t('lightswitch.enableDesc')}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>{t('lightswitch.scope')}</strong>
              {(['both', 'apps', 'system'] as const).map((sc) => (
                <button key={sc} className={`mini${s.scope === sc ? ' primary' : ''}`} onClick={() => upd({ scope: sc })}>
                  {t(`lightswitch.scope_${sc}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule mode */}
          <div className="panel" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>{t('lightswitch.mode')}</strong>
              {(['off', 'fixed', 'sun'] as const).map((m) => (
                <button key={m} className={`mini${s.mode === m ? ' primary' : ''}`} onClick={() => upd({ mode: m })}>
                  {t(`lightswitch.mode_${m}`)}
                </button>
              ))}
            </div>

            {s.mode === 'fixed' && (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
                <label>{t('lightswitch.lightAt')} <input type="time" value={s.lightAt} onChange={(e) => upd({ lightAt: e.target.value })} /></label>
                <label>{t('lightswitch.darkAt')} <input type="time" value={s.darkAt} onChange={(e) => upd({ darkAt: e.target.value })} /></label>
              </div>
            )}

            {s.mode === 'sun' && (
              <div style={{ marginTop: 12 }}>
                <div className="count-note" style={{ margin: '0 0 10px' }}>{t('lightswitch.sunHelp')}</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label>{t('lightswitch.lat')} <input className="hosts-edit" type="text" inputMode="decimal" placeholder="22.3193" value={s.lat} onChange={(e) => upd({ lat: e.target.value })} style={{ width: 110 }} /></label>
                  <label>{t('lightswitch.lon')} <input className="hosts-edit" type="text" inputMode="decimal" placeholder="114.1694" value={s.lon} onChange={(e) => upd({ lon: e.target.value })} style={{ width: 110 }} /></label>
                  <label>{t('lightswitch.sunriseOff')} <input type="number" value={s.sunriseOff} min={-720} max={720} onChange={(e) => upd({ sunriseOff: Number(e.target.value) || 0 })} style={{ width: 80 }} /></label>
                  <label>{t('lightswitch.sunsetOff')} <input type="number" value={s.sunsetOff} min={-720} max={720} onChange={(e) => upd({ sunsetOff: Number(e.target.value) || 0 })} style={{ width: 80 }} /></label>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                  <button className="mini" onClick={detect} disabled={busy !== null}>
                    {busy === 'detect' ? t('lightswitch.detecting') : t('lightswitch.detect')}
                  </button>
                </div>
                <div className="count-note" style={{ marginTop: 10 }}>
                  {!coordsValid(s.lat, s.lon)
                    ? t('lightswitch.sunNeedsCoords')
                    : !sun || sun.sunrise < 0 || sun.sunset < 0
                      ? t('lightswitch.sunPolar')
                      : t('lightswitch.sunPreview', {
                          sunrise: hhmm(sun.sunrise),
                          light: hhmm(sun.sunrise + s.sunriseOff),
                          sunset: hhmm(sun.sunset),
                          dark: hhmm(sun.sunset + s.sunsetOff),
                        })}
                </div>
              </div>
            )}
          </div>

          {/* Background job (schtasks) */}
          <div className="panel" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong>{t('lightswitch.bgTitle')}</strong>
                <div className="count-note" style={{ margin: '4px 0 0' }}>{t('lightswitch.bgDesc')}</div>
              </div>
              <StatusDot ok={!!bgJob.data} label={bgJob.data ? t('lightswitch.bgOn') : t('lightswitch.bgOff')} />
              <button
                className={`mini${bgJob.data ? ' danger' : ' primary'}`}
                onClick={toggleBg}
                disabled={busy !== null || bgJob.loading}
              >
                {busy === 'bg'
                  ? t('lightswitch.working')
                  : bgJob.data
                    ? t('lightswitch.bgRemove')
                    : t('lightswitch.bgSchedule')}
              </button>
            </div>
          </div>
        </AsyncState>
      ) : (
        <p className="count-note">{t('lightswitch.previewNote')}</p>
      )}
    </div>
  );
}
