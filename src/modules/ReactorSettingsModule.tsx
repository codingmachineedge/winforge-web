import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar } from './common';

// Port of WinForge Pages/ReactorSettingsModule: reversible controls that affect
// the REAL computer or EXTERNAL systems, kept separate from the pure reactor
// simulation. Persisted to localStorage. The dangerous one (real shutdown on
// meltdown) defaults OFF. In the browser these are stored preferences the Tauri
// backend honours; the sim itself never depends on them.

interface Settings {
  keepAwake: boolean;
  sysLink: boolean;
  armShutdown: boolean;
  statusApi: boolean;
  autosave: boolean;
  haMirror: boolean;
}

const KEY = 'winforge-web.reactorsettings.v1';
const DEFAULTS: Settings = {
  keepAwake: true, // default ON
  sysLink: false, // default OFF
  armShutdown: false, // default OFF (in-memory / dangerous)
  statusApi: true, // default ON
  autosave: true, // default ON
  haMirror: false, // default OFF
};

function load(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const ROWS: Array<{ key: keyof Settings; danger?: boolean }> = [
  { key: 'keepAwake' },
  { key: 'sysLink' },
  { key: 'statusApi' },
  { key: 'autosave' },
  { key: 'haMirror' },
  { key: 'armShutdown', danger: true },
];

export function ReactorSettingsModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<Settings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s]);

  const toggle = (key: keyof Settings) => {
    if (key === 'armShutdown' && !s.armShutdown) {
      if (!window.confirm(t('reactorsettings.armConfirm'))) return;
    }
    setS((p) => ({ ...p, [key]: !p[key] }));
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={() => setS(DEFAULTS)}>{t('reactorsettings.reset')}</button>
      </ModuleToolbar>
      <p className="count-note">{t('reactorsettings.blurb')}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ROWS.map(({ key, danger }) => (
          <div
            key={key}
            className="panel"
            style={{ display: 'flex', alignItems: 'center', gap: 16, borderColor: danger ? 'var(--danger)' : undefined }}
          >
            <div style={{ flex: 1 }}>
              <strong style={danger ? { color: 'var(--danger)' } : undefined}>{t(`reactorsettings.${key}`)}</strong>
              <div className="count-note" style={{ margin: 0 }}>{t(`reactorsettings.${key}Note`)}</div>
            </div>
            <button
              className={`mini${s[key] ? (danger ? ' danger' : ' primary') : ''}`}
              aria-pressed={s[key]}
              onClick={() => toggle(key)}
            >
              {s[key] ? t(danger ? 'reactorsettings.armed' : 'reactorsettings.on') : t('reactorsettings.off')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
