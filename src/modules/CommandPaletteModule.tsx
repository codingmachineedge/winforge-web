import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar } from './common';
import { requestPaletteOpen } from '../state/navBus';

// Port of WinForge Pages/CommandPaletteModule: the control page for the global
// quick-launcher. winforge-web already ships that launcher (the Ctrl+K command
// palette), so this page configures it and can open it on demand. Settings
// persist to localStorage; the palette reads the same providers/limit.

type Provider = 'modules' | 'features' | 'sections' | 'actions' | 'web';

interface Config {
  enabled: boolean;
  maxResults: number;
  providers: Record<Provider, boolean>;
}

const KEY = 'winforge-web.cmdpalette.v1';
const ALL_PROVIDERS: Provider[] = ['modules', 'features', 'sections', 'actions', 'web'];
const DEFAULTS: Config = {
  enabled: true,
  maxResults: 60,
  providers: { modules: true, features: true, sections: true, actions: true, web: false },
};

function load(): Config {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw);
      return { ...DEFAULTS, ...p, providers: { ...DEFAULTS.providers, ...(p.providers ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

export function CommandPaletteModule() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<Config>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, [cfg]);

  const upd = (patch: Partial<Config>) => setCfg((c) => ({ ...c, ...patch }));
  const toggleProvider = (p: Provider) =>
    setCfg((c) => ({ ...c, providers: { ...c.providers, [p]: !c.providers[p] } }));

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={() => requestPaletteOpen()} disabled={!cfg.enabled}>
          {t('cmdpalette.openNow')}
        </button>
      </ModuleToolbar>
      <p className="count-note">{t('cmdpalette.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <strong>{t('cmdpalette.enable')}</strong>
          <div className="count-note" style={{ margin: 0 }}>
            {cfg.enabled ? t('cmdpalette.statusOn') : t('cmdpalette.statusOff')}
          </div>
        </div>
        <button
          className={`mini${cfg.enabled ? ' primary' : ''}`}
          aria-pressed={cfg.enabled}
          onClick={() => upd({ enabled: !cfg.enabled })}
        >
          {cfg.enabled ? t('cmdpalette.on') : t('cmdpalette.off')}
        </button>
      </div>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong>{t('cmdpalette.hotkey')}</strong>
          <div className="count-note" style={{ margin: 0 }}>
            <kbd>Ctrl</kbd> + <kbd>K</kbd> · <kbd>/</kbd>
          </div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {t('cmdpalette.maxResults')}
          <input
            type="number"
            min={5}
            max={200}
            value={cfg.maxResults}
            onChange={(e) => upd({ maxResults: Math.max(5, Math.min(200, Number(e.target.value) || 60)) })}
            style={{ width: 80 }}
          />
        </label>
      </div>

      <div className="panel">
        <strong>{t('cmdpalette.providers')}</strong>
        <div className="count-note" style={{ margin: '2px 0 10px' }}>{t('cmdpalette.providersHint')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ALL_PROVIDERS.map((p) => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={cfg.providers[p]} onChange={() => toggleProvider(p)} />
              <span>
                <strong>{t(`cmdpalette.prov_${p}`)}</strong> — <span className="count-note" style={{ margin: 0 }}>{t(`cmdpalette.provdesc_${p}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
