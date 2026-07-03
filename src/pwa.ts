// PWA service-worker registration — browser only.
//
// This module is a hard no-op inside the Tauri desktop app and in any context
// where a service worker cannot / should not run:
//   - Tauri:            `__TAURI_INTERNALS__` is present on window (tauri:// origin).
//   - Non-http(s):      file://, tauri://, etc. — service workers are unsupported.
//   - No SW support:    older/embedded browsers without navigator.serviceWorker.
// In those cases we never import the virtual PWA module, so no SW is registered.

/** Register the PWA service worker when running in a real browser context. */
export function initPwa(): void {
  if (typeof window === 'undefined') return;

  // Skip inside the Tauri desktop shell.
  if ('__TAURI_INTERNALS__' in window) return;

  // Only over http/https (dev server or a deployed site).
  const proto = window.location.protocol;
  if (proto !== 'http:' && proto !== 'https:') return;

  // Skip when the browser has no service-worker support.
  if (!('serviceWorker' in navigator)) return;

  // Dynamically import so the virtual module is never pulled into the Tauri path.
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => {
      // Registration is best-effort; failures must never break app startup.
    });
}
