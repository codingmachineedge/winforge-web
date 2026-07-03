// In-app navigation bus so module components (rendered standalone inside
// ModuleDetail) can ask the shell to open another module or the command
// palette — the web equivalent of WinForge's Navigator.GoToModule. App.tsx
// subscribes once; modules fire-and-forget.

const MODULE_EVENT = 'winforge:open-module';
const PALETTE_EVENT = 'winforge:open-palette';

const hasWindow = typeof window !== 'undefined';

export function requestModuleOpen(tag: string): void {
  if (hasWindow) window.dispatchEvent(new CustomEvent<string>(MODULE_EVENT, { detail: tag }));
}

export function requestPaletteOpen(seed = ''): void {
  if (hasWindow) window.dispatchEvent(new CustomEvent<string>(PALETTE_EVENT, { detail: seed }));
}

export function onModuleOpenRequest(cb: (tag: string) => void): () => void {
  if (!hasWindow) return () => {};
  const h = (e: Event) => {
    const tag = (e as CustomEvent<string>).detail;
    if (typeof tag === 'string' && tag) cb(tag);
  };
  window.addEventListener(MODULE_EVENT, h);
  return () => window.removeEventListener(MODULE_EVENT, h);
}

export function onPaletteOpenRequest(cb: (seed: string) => void): () => void {
  if (!hasWindow) return () => {};
  const h = (e: Event) => cb(String((e as CustomEvent<string>).detail ?? ''));
  window.addEventListener(PALETTE_EVENT, h);
  return () => window.removeEventListener(PALETTE_EVENT, h);
}
