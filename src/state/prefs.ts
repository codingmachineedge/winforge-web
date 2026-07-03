import { createPersistedStore } from './store';

// The central persisted app-preferences store. Other UI features (layout mode,
// density, sidebar, zoom) read/write these keys; the store handles persistence,
// cross-tab sync and React subscriptions.

export interface LayoutPrefs {
  viewMode: 'grid' | 'list';
  density: 'compact' | 'comfortable' | 'spacious';
  sidebarCollapsed: boolean;
  uiScale: number; // 0.8–1.5, clamped on set
}

export const DEFAULT_PREFS: LayoutPrefs = {
  viewMode: 'grid',
  density: 'comfortable',
  sidebarCollapsed: false,
  uiScale: 1,
};

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;

const clampUiScale = (v: number): number => {
  if (!Number.isFinite(v)) return DEFAULT_PREFS.uiScale;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v));
};

const store = createPersistedStore('winforge-web.prefs.v1', DEFAULT_PREFS);

// Wrap `set` so uiScale is always clamped into range, whatever the caller passes.
export const prefs = {
  ...store,
  set<K extends keyof LayoutPrefs>(k: K, v: LayoutPrefs[K]): void {
    if (k === 'uiScale') {
      store.set('uiScale', clampUiScale(v as number));
      return;
    }
    store.set(k, v);
  },
};

/**
 * Convenience hook: `const [viewMode, setViewMode] = useLayoutPref('viewMode')`.
 * Reads via the underlying store; the returned setter routes through `prefs.set`
 * so uiScale stays clamped whether written from the hook or directly.
 */
export function useLayoutPref<K extends keyof LayoutPrefs>(
  k: K,
): [LayoutPrefs[K], (v: LayoutPrefs[K]) => void] {
  const [value] = store.useValue(k);
  return [value, (v: LayoutPrefs[K]) => prefs.set(k, v)];
}
