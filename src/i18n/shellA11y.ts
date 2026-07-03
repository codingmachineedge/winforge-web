// Accessibility strings for the app shell (skip link, landmarks, lazy-load fallback).
// Single top-level namespace `shella11y`, merged into the language bundles by
// src/i18n/index.ts alongside the other shell* slices.

export const enShellA11y = {
  shella11y: {
    skipToMain: 'Skip to main content',
    primaryNav: 'Primary',
    loading: 'Loading…',
  },
};

export const yueShellA11y: typeof enShellA11y = {
  shella11y: {
    skipToMain: '跳至主要內容',
    primaryNav: '主導覽',
    loading: '載入緊…',
  },
};
