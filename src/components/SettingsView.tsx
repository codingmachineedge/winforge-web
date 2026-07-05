import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  settingsRegistry,
  filterSettings,
  langOptionLabel,
  type SettingDef,
  type SettingOption,
} from '../data/settingsRegistry';
// Subscribe to every backing store so the controls re-render live as values
// change (whether changed here, from the command palette, or another tab).
import { useLayoutPref } from '../state/prefs';
import { useThemeMode } from '../state/theme';
import { MSym } from './m3/MSym';
import '../styles/settings.css';

// Full settings page. Zero required props — reads/writes the real stores through
// the declarative registry. A live search box filters the (translated) settings;
// the rest render grouped by category, one control per `SettingDef.control`.

export function SettingsView() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  // Depend on the live store values so this component re-renders on any change;
  // the registry get()/set() closures are the source of truth for actual values.
  useThemeMode();
  useLayoutPref('viewMode');
  useLayoutPref('density');
  useLayoutPref('sidebarCollapsed');
  useLayoutPref('uiScale');

  const filtered = useMemo(() => filterSettings(settingsRegistry, query, t), [query, t]);

  // Group the filtered defs by category, preserving first-seen order.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byCat = new Map<string, SettingDef[]>();
    for (const def of filtered) {
      if (!byCat.has(def.categoryKey)) {
        byCat.set(def.categoryKey, []);
        order.push(def.categoryKey);
      }
      byCat.get(def.categoryKey)!.push(def);
    }
    return order.map((categoryKey) => ({ categoryKey, defs: byCat.get(categoryKey)! }));
  }, [filtered]);

  return (
    <div className="settings-view">
      <div className="page-head">
        <h1>{t('shellsettings.title')}</h1>
        <p>{t('shellsettings.subtitle')}</p>
      </div>

      <div className="settings-search">
        <span className="settings-search-icon" aria-hidden="true">
          <MSym name="search" size={20} />
        </span>
        <input
          type="search"
          className="settings-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('shellsettings.searchPlaceholder')}
          aria-label={t('shellsettings.searchPlaceholder')}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="settings-empty">{t('shellsettings.noResults', { query: query.trim() })}</p>
      ) : (
        <>
          <p className="count-note">
            {t('shellsettings.resultCount', { count: filtered.length })}
          </p>
          {groups.map(({ categoryKey, defs }) => (
            <section key={categoryKey} className="settings-group">
              <h2 className="settings-cat">{t(categoryKey)}</h2>
              <div className="settings-rows">
                {defs.map((def) => (
                  <SettingRow key={def.id} def={def} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

// Per-setting leading icon (M3 list-item style), keyed by the registry id.
const SETTING_ICONS: Record<string, string> = {
  theme: 'contrast',
  uiScale: 'zoom_in',
  lang: 'translate',
  viewMode: 'grid_view',
  density: 'density_medium',
  sidebarCollapsed: 'side_navigation',
};

function SettingRow({ def }: { def: SettingDef }) {
  const { t } = useTranslation();
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-icon" aria-hidden="true">
          <MSym name={SETTING_ICONS[def.id] ?? 'tune'} size={22} />
        </span>
        <div>
          <div className="setting-label">{t(def.labelKey)}</div>
          <div className="setting-desc">{t(def.descKey)}</div>
        </div>
      </div>
      <div className="setting-control">
        <SettingControl def={def} />
      </div>
    </div>
  );
}

function SettingControl({ def }: { def: SettingDef }) {
  switch (def.control) {
    case 'toggle':
      return <ToggleControl def={def} />;
    case 'slider':
      return <SliderControl def={def} />;
    // 'select', 'theme' and 'lang' all render as a segmented button group.
    default:
      return <SegmentedControl def={def} />;
  }
}

function SegmentedControl({ def }: { def: SettingDef }) {
  const { t } = useTranslation();
  const current = String(def.get());
  const options: SettingOption[] = def.options ?? [];
  const optLabel = (o: SettingOption) =>
    o.labelKey.startsWith('__lang.') ? langOptionLabel(o.value) : t(o.labelKey);

  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`segmented-btn${current === o.value ? ' active' : ''}`}
          aria-pressed={current === o.value}
          onClick={() => def.set(o.value)}
        >
          {optLabel(o)}
        </button>
      ))}
    </div>
  );
}

function ToggleControl({ def }: { def: SettingDef }) {
  const on = Boolean(def.get());
  return (
    <button
      type="button"
      className={`toggle-switch${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => def.set(!on)}
    >
      <span className="toggle-knob" aria-hidden="true" />
    </button>
  );
}

function SliderControl({ def }: { def: SettingDef }) {
  const value = Number(def.get());
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  const step = def.step ?? 0.1;
  return (
    <div className="slider-control">
      <input
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => def.set(Number(e.target.value))}
      />
      <span className="slider-readout">{Math.round(value * 100)}%</span>
    </div>
  );
}
