import type { TFunction } from 'i18next';
import { prefs, UI_SCALE_MIN, UI_SCALE_MAX, type LayoutPrefs } from '../state/prefs';
import { getThemeMode, setThemeMode, type ThemeMode } from '../state/theme';
import i18n, { LANGS, setLang, type LangCode } from '../i18n';

// The declarative settings registry. Each entry describes one user-facing
// preference: what to call it (i18n keys), which category it belongs to, how to
// render it (control type + options), and — crucially — get()/set() closures
// wired straight to the REAL stores (prefs, theme, i18n). The SettingsView is a
// pure renderer over this list; nothing here touches the DOM or React.

export type ControlType = 'select' | 'toggle' | 'slider' | 'lang' | 'theme';

export type SettingCategory = 'appearance' | 'layout' | 'language';

export interface SettingOption {
  /** The stored value this option sets. */
  value: string;
  /** i18n key for the option's visible label. */
  labelKey: string;
}

export interface SettingDef<V = unknown> {
  /** Stable unique id (also used as React key + test identity). */
  id: string;
  category: SettingCategory;
  /** i18n key for the setting's category heading. */
  categoryKey: string;
  /** i18n key for the setting's label. */
  labelKey: string;
  /** i18n key for the setting's longer description / helper text. */
  descKey: string;
  control: ControlType;
  /** Present for 'select' / 'theme' / 'lang' — the choices to render. */
  options?: SettingOption[];
  /** Present for 'slider' — numeric bounds + step. */
  min?: number;
  max?: number;
  step?: number;
  /** Read the current value from the underlying store. */
  get(): V;
  /** Write a new value back to the underlying store. */
  set(v: V): void;
}

// ---- control option tables -------------------------------------------------

const THEME_OPTIONS: SettingOption[] = [
  { value: 'light', labelKey: 'shellsettings.themeLight' },
  { value: 'dark', labelKey: 'shellsettings.themeDark' },
  { value: 'system', labelKey: 'shellsettings.themeSystem' },
];

const LANG_OPTIONS: SettingOption[] = LANGS.map((l) => ({
  value: l.code,
  // The visible label is the LANGS label itself (EN / 粵語 / EN+粵), so we map
  // each to a tiny inline key-free label via a synthetic key the renderer knows
  // to fall back on. We still expose a labelKey for symmetry, but the renderer
  // for 'lang' prefers the raw LANGS label.
  labelKey: `__lang.${l.code}`,
}));

const VIEW_MODE_OPTIONS: SettingOption[] = [
  { value: 'grid', labelKey: 'shellsettings.viewModeGrid' },
  { value: 'list', labelKey: 'shellsettings.viewModeList' },
];

const DENSITY_OPTIONS: SettingOption[] = [
  { value: 'compact', labelKey: 'shellsettings.densityCompact' },
  { value: 'comfortable', labelKey: 'shellsettings.densityComfortable' },
  { value: 'spacious', labelKey: 'shellsettings.densitySpacious' },
];

// ---- the registry ----------------------------------------------------------

export const settingsRegistry: SettingDef[] = [
  {
    id: 'theme',
    category: 'appearance',
    categoryKey: 'shellsettings.catAppearance',
    labelKey: 'shellsettings.themeLabel',
    descKey: 'shellsettings.themeDesc',
    control: 'theme',
    options: THEME_OPTIONS,
    get: () => getThemeMode(),
    set: (v) => setThemeMode(v as ThemeMode),
  } as SettingDef,
  {
    id: 'uiScale',
    category: 'appearance',
    categoryKey: 'shellsettings.catAppearance',
    labelKey: 'shellsettings.uiScaleLabel',
    descKey: 'shellsettings.uiScaleDesc',
    control: 'slider',
    min: UI_SCALE_MIN,
    max: UI_SCALE_MAX,
    step: 0.05,
    get: () => prefs.get('uiScale'),
    set: (v) => prefs.set('uiScale', v as number),
  } as SettingDef,
  {
    id: 'lang',
    category: 'language',
    categoryKey: 'shellsettings.catLanguage',
    labelKey: 'shellsettings.langLabel',
    descKey: 'shellsettings.langDesc',
    control: 'lang',
    options: LANG_OPTIONS,
    // i18n.language may carry a region suffix; normalise to a known LangCode.
    get: () => normalizeLang(i18n.language),
    set: (v) => setLang(v as LangCode),
  } as SettingDef,
  {
    id: 'viewMode',
    category: 'layout',
    categoryKey: 'shellsettings.catLayout',
    labelKey: 'shellsettings.viewModeLabel',
    descKey: 'shellsettings.viewModeDesc',
    control: 'select',
    options: VIEW_MODE_OPTIONS,
    get: () => prefs.get('viewMode'),
    set: (v) => prefs.set('viewMode', v as LayoutPrefs['viewMode']),
  } as SettingDef,
  {
    id: 'density',
    category: 'layout',
    categoryKey: 'shellsettings.catLayout',
    labelKey: 'shellsettings.densityLabel',
    descKey: 'shellsettings.densityDesc',
    control: 'select',
    options: DENSITY_OPTIONS,
    get: () => prefs.get('density'),
    set: (v) => prefs.set('density', v as LayoutPrefs['density']),
  } as SettingDef,
  {
    id: 'sidebarCollapsed',
    category: 'layout',
    categoryKey: 'shellsettings.catLayout',
    labelKey: 'shellsettings.sidebarLabel',
    descKey: 'shellsettings.sidebarDesc',
    control: 'toggle',
    get: () => prefs.get('sidebarCollapsed'),
    set: (v) => prefs.set('sidebarCollapsed', v as boolean),
  } as SettingDef,
];

/** Coerce an arbitrary i18next language string down to a known LangCode. */
function normalizeLang(lng: string | undefined): LangCode {
  if (lng === 'yue' || lng === 'bilingual' || lng === 'en') return lng;
  return 'en';
}

/**
 * The label a 'lang' option should show: the raw LANGS label (EN / 粵語 / EN+粵),
 * which is not translated. Exported so the view and tests share one source.
 */
export function langOptionLabel(value: string): string {
  return LANGS.find((l) => l.code === value)?.label ?? value;
}

/**
 * Pure, testable filter used by the search box. Matches `query` (case-insensitive,
 * whitespace-tokenised, ALL terms must hit) against each setting's TRANSLATED
 * label + description + option labels, so searching works in whatever language
 * (including bilingual "EN · 粵") is active. Empty/blank query returns all defs.
 */
export function filterSettings(
  defs: SettingDef[],
  query: string,
  t: TFunction,
): SettingDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  const terms = q.split(/\s+/).filter(Boolean);

  return defs.filter((def) => {
    const parts: string[] = [t(def.labelKey), t(def.descKey), t(def.categoryKey)];
    for (const opt of def.options ?? []) {
      parts.push(opt.labelKey.startsWith('__lang.') ? langOptionLabel(opt.value) : t(opt.labelKey));
    }
    const hay = parts.join(' ').toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}
