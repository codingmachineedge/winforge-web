import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAsync, AsyncState, ModuleToolbar, StatusDot } from './common';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Port of WinForge Pages/LightSwitchModule + LightSwitchService: schedule the
// Windows light/dark theme by fixed times or computed sunrise/sunset, apply it
// live (HKCU Personalize + WM_SETTINGCHANGE broadcast), and switch now. The
// per-minute scheduler runs in the webview while the app is open; settings
// persist to localStorage.

type Scope = 'both' | 'apps' | 'system';
type Mode = 'off' | 'fixed' | 'sun';

interface Settings {
  enabled: boolean;
  scope: Scope;
  mode: Mode;
  lightAt: string; // HH:MM
  darkAt: string;
  lat: number;
  lon: number;
  sunriseOff: number;
  sunsetOff: number;
}

const KEY = 'winforge-web.lightswitch.v1';
const DEFAULTS: Settings = {
  enabled: false,
  scope: 'both',
  mode: 'off',
  lightAt: '07:00',
  darkAt: '19:00',
  lat: 43.65,
  lon: -79.38,
  sunriseOff: 0,
  sunsetOff: 0,
};

function load(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const CURRENT_PS = `
$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
[pscustomobject]@{
  apps   = ((Get-ItemProperty $p -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme -ne 0)
  system = ((Get-ItemProperty $p -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme -ne 0)
} | ConvertTo-Json
`;

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
$r = [System.IntPtr]::Zero
[void][Wf.WfLs]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.IntPtr]::Zero, 'ImmersiveColorSet', 2, 1000, [ref]$r)
"Applied ${light ? 'light' : 'dark'} (${scope})"
`;
}

// Standard low-precision sunrise/sunset (NOAA-style) in local minutes-of-day.
function sunTimes(lat: number, lon: number, date: Date): { sunrise: number; sunset: number } | null {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000);
  const decl = 23.45 * rad * Math.sin(rad * (360 / 365) * (dayOfYear - 81));
  const latR = lat * rad;
  const cosH = -Math.tan(latR) * Math.tan(decl);
  if (cosH < -1 || cosH > 1) return null; // polar day/night
  const H = Math.acos(cosH) / rad; // degrees
  // Equation of time (minutes) approximation.
  const B = rad * (360 / 365) * (dayOfYear - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solarNoonUtcMin = 720 - 4 * lon - eot;
  const offsetMin = -date.getTimezoneOffset(); // local minus UTC
  const sunrise = Math.round(solarNoonUtcMin - 4 * H + offsetMin);
  const sunset = Math.round(solarNoonUtcMin + 4 * H + offsetMin);
  return { sunrise: ((sunrise % 1440) + 1440) % 1440, sunset: ((sunset % 1440) + 1440) % 1440 };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function LightSwitchModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [s, setS] = useState<Settings>(load);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s]);

  const current = useAsync(async () => {
    if (!live) return null;
    const rows = await runPowershellJson<{ apps: boolean; system: boolean }>(CURRENT_PS);
    return rows[0] ?? null;
  }, [live]);

  const apply = (light: boolean) => {
    if (!live) return;
    runPowershell(applyPs(light, s.scope)).then(
      (r) => {
        setMsg(r.success ? r.stdout.trim() : r.stderr.trim());
        current.reload();
      },
      (e) => setMsg(String(e)),
    );
  };

  const sun = useMemo(() => sunTimes(s.lat, s.lon, new Date(Date.now())), [s.lat, s.lon]);

  // Scheduler: while enabled, evaluate the target theme each minute and apply on change.
  useEffect(() => {
    if (!live || !s.enabled || s.mode === 'off') return;
    let last: boolean | null = null;
    const tick = () => {
      const now = new Date(Date.now());
      const nowMin = now.getHours() * 60 + now.getMinutes();
      let wantLight: boolean;
      if (s.mode === 'fixed') {
        const l = toMin(s.lightAt);
        const d = toMin(s.darkAt);
        wantLight = l <= d ? nowMin >= l && nowMin < d : nowMin >= l || nowMin < d;
      } else {
        const st = sunTimes(s.lat, s.lon, now);
        if (!st) return;
        const rise = st.sunrise + s.sunriseOff;
        const set = st.sunset + s.sunsetOff;
        wantLight = nowMin >= rise && nowMin < set;
      }
      if (wantLight !== last) {
        last = wantLight;
        runPowershell(applyPs(wantLight, s.scope)).catch(() => {});
      }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [live, s]);

  const upd = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  const themeNow = current.data
    ? current.data.apps
      ? t('lightswitch.themeLight')
      : t('lightswitch.themeDark')
    : '—';

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={() => apply(true)} disabled={!live}>{t('lightswitch.lightNow')}</button>
        <button className="mini" onClick={() => apply(false)} disabled={!live}>{t('lightswitch.darkNow')}</button>
        <button className="mini" onClick={current.reload} disabled={!live}>{t('lightswitch.refresh')}</button>
        <StatusDot ok={live} label={live ? themeNow : t('lightswitch.preview')} />
      </ModuleToolbar>
      <p className="count-note">{t('lightswitch.blurb')}</p>
      {msg && <p className="count-note">{msg}</p>}

      {live ? (
        <AsyncState loading={current.loading} error={current.error}>
          <div className="panel" style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={s.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
              <strong>{t('lightswitch.enable')}</strong>
            </label>
            <div className="count-note" style={{ margin: '4px 0 0' }}>{t('lightswitch.enableDesc')}</div>
          </div>

          <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong>{t('lightswitch.scope')}</strong>
            {(['both', 'apps', 'system'] as const).map((sc) => (
              <button key={sc} className={`mini${s.scope === sc ? ' primary' : ''}`} onClick={() => upd({ scope: sc })}>
                {t(`lightswitch.scope_${sc}`)}
              </button>
            ))}
          </div>

          <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong>{t('lightswitch.mode')}</strong>
            {(['off', 'fixed', 'sun'] as const).map((m) => (
              <button key={m} className={`mini${s.mode === m ? ' primary' : ''}`} onClick={() => upd({ mode: m })}>
                {t(`lightswitch.mode_${m}`)}
              </button>
            ))}
          </div>

          {s.mode === 'fixed' && (
            <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label>{t('lightswitch.lightAt')} <input type="time" value={s.lightAt} onChange={(e) => upd({ lightAt: e.target.value })} /></label>
              <label>{t('lightswitch.darkAt')} <input type="time" value={s.darkAt} onChange={(e) => upd({ darkAt: e.target.value })} /></label>
            </div>
          )}

          {s.mode === 'sun' && (
            <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <label>{t('lightswitch.lat')} <input type="number" step="0.01" value={s.lat} onChange={(e) => upd({ lat: Number(e.target.value) })} style={{ width: 90 }} /></label>
              <label>{t('lightswitch.lon')} <input type="number" step="0.01" value={s.lon} onChange={(e) => upd({ lon: Number(e.target.value) })} style={{ width: 90 }} /></label>
              <label>{t('lightswitch.sunriseOff')} <input type="number" value={s.sunriseOff} onChange={(e) => upd({ sunriseOff: Number(e.target.value) })} style={{ width: 70 }} /></label>
              <label>{t('lightswitch.sunsetOff')} <input type="number" value={s.sunsetOff} onChange={(e) => upd({ sunsetOff: Number(e.target.value) })} style={{ width: 70 }} /></label>
              <span className="count-note" style={{ margin: 0 }}>
                {sun ? t('lightswitch.sunPreview', { sunrise: hhmm(sun.sunrise), sunset: hhmm(sun.sunset) }) : t('lightswitch.sunPolar')}
              </span>
            </div>
          )}
        </AsyncState>
      ) : (
        <p className="count-note">{t('lightswitch.previewNote')}</p>
      )}
    </div>
  );
}
