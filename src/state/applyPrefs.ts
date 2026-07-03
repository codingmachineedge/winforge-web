import { useEffect } from 'react';
import { useLayoutPref } from './prefs';

// Bridges the persisted LayoutPrefs into concrete DOM effects. The prefs store
// only *stores* values; this hook is what makes density and uiScale actually
// change the page. Kept separate from the store so the store stays DOM-free and
// node-testable.
//
// Effects applied to <html> (document.documentElement):
//   • data-density="compact|comfortable|spacious"  → drives the .card-grid /
//     .card spacing overrides declared in styles/settings.css.
//   • --ui-scale: <number>                          → a CSS custom property other
//     rules can consume.
//   • style.fontSize = calc(14px * scale)           → because the base font-size
//     lives on <body> (14px) and cascades into rem-free px sizes across the app,
//     scaling the root font-size is the simplest global zoom. 14px matches the
//     body font-size in global.css.
//
// Every access is SSR/node guarded and the writes are idempotent (setting the
// same attribute/value twice is a no-op), so this is safe under React
// StrictMode double-invocation.

const BASE_FONT_PX = 14;

function applyDensity(density: string): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.density = density;
}

function applyUiScale(scale: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  root.style.setProperty('--ui-scale', String(safe));
  root.style.fontSize = `${(BASE_FONT_PX * safe).toFixed(3)}px`;
}

/**
 * Keep `document.documentElement` in sync with the layout prefs. Mount once,
 * high in the tree (e.g. in App). Re-runs whenever `density` or `uiScale`
 * change in the store.
 */
export function useApplyLayoutPrefs(): void {
  const [density] = useLayoutPref('density');
  const [uiScale] = useLayoutPref('uiScale');

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  useEffect(() => {
    applyUiScale(uiScale);
  }, [uiScale]);
}
