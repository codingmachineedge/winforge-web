import { useCallback, useSyncExternalStore } from 'react';

// Self-contained three-state theme store: Light / Dark / System.
//
// Persisted as a single string under `winforge-web.theme.v1`. Deliberately does
// NOT depend on the generic prefs store — theme has to apply the `data-theme`
// attribute to <html> as early as main.tsx (before React mounts) and follow the
// OS `prefers-color-scheme` at runtime, which is enough special behaviour to
// justify its own tiny store.
//
// Every `document` / `matchMedia` access is feature-guarded so this module is
// safe to import in the node test environment (no DOM).

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'winforge-web.theme.v1';
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const isThemeMode = (v: unknown): v is ThemeMode =>
  typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v);

const LIGHT_MEDIA = '(prefers-color-scheme: light)';

// ---- storage helpers (feature-guarded) -------------------------------------

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    // Accessing localStorage can throw (sandboxed iframe / disabled cookies).
    return false;
  }
};

function loadMode(): ThemeMode {
  if (!hasLocalStorage()) return DEFAULT_THEME_MODE;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw == null) return DEFAULT_THEME_MODE;
    // Tolerate both a bare string ("dark") and a JSON-quoted string ('"dark"').
    let value: unknown = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    return isThemeMode(value) ? value : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

function persistMode(mode: ThemeMode): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Quota / disabled storage — keep the in-memory value only.
  }
}

// ---- store core ------------------------------------------------------------

let currentMode: ThemeMode = loadMode();
const listeners = new Set<(mode: ThemeMode) => void>();

const emit = (mode: ThemeMode): void => {
  listeners.forEach((cb) => cb(mode));
};

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function subscribeThemeMode(cb: (mode: ThemeMode) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function setThemeMode(mode: ThemeMode): void {
  const next = isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  if (next === currentMode) {
    // Still re-apply the DOM attributes in case they drifted, but skip notify.
    applyTheme();
    return;
  }
  currentMode = next;
  persistMode(next);
  applyTheme();
  emit(next);
}

// ---- resolution + DOM application ------------------------------------------

/** True when the OS currently prefers a light color scheme. */
function systemPrefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    // No matchMedia (node/test) → mirror the CSS default, which is dark.
    return false;
  }
  try {
    return window.matchMedia(LIGHT_MEDIA).matches;
  } catch {
    return false;
  }
}

/**
 * The concrete theme in effect right now: mode wins unless it is 'system', in
 * which case the OS preference (via matchMedia) decides.
 */
export function resolvedTheme(): 'light' | 'dark' {
  if (currentMode === 'light') return 'light';
  if (currentMode === 'dark') return 'dark';
  return systemPrefersLight() ? 'light' : 'dark';
}

/**
 * Push `data-theme` (the raw mode) and `data-resolved-theme` (the concrete
 * light/dark result) onto <html>. `data-theme` drives the CSS token selectors;
 * `data-resolved-theme` is a convenience for JS consumers (charts, canvases…).
 */
function applyTheme(): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.dataset.theme = currentMode;
  root.dataset.resolvedTheme = resolvedTheme();
}

// ---- matchMedia auto-follow (System mode) ----------------------------------

let mediaQuery: MediaQueryList | null = null;
let mediaListenerInstalled = false;

const onSystemChange = (): void => {
  // The OS scheme flipped. Keep `data-resolved-theme` fresh and, when we are in
  // 'system' mode, notify subscribers so React consumers re-render.
  applyTheme();
  if (currentMode === 'system') emit(currentMode);
};

function installMediaListener(): void {
  if (mediaListenerInstalled) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    mediaQuery = window.matchMedia(LIGHT_MEDIA);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSystemChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      // Safari < 14 fallback.
      mediaQuery.addListener(onSystemChange);
    }
    mediaListenerInstalled = true;
  } catch {
    // matchMedia unavailable — auto-follow simply won't run.
  }
}

let initialised = false;

/**
 * Apply the persisted theme to <html> immediately and start following the OS
 * scheme. Idempotent — safe to call more than once (e.g. React StrictMode).
 * Call this in main.tsx *before* rendering so there is no flash of wrong theme.
 */
export function initTheme(): void {
  applyTheme(); // always re-apply (cheap, keeps attributes correct)
  if (initialised) return;
  initialised = true;
  installMediaListener();
}

// ---- React hook ------------------------------------------------------------

/**
 * `const [mode, setMode] = useThemeMode()`. Re-renders on mode changes and on
 * OS-scheme changes while in 'system' mode.
 */
export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const value = useSyncExternalStore(subscribeThemeMode, getThemeMode, getThemeMode);
  const setValue = useCallback((m: ThemeMode) => setThemeMode(m), []);
  return [value, setValue];
}
