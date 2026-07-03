import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The theme store reads localStorage at module-load time (`loadMode()`), so each
// test installs its stubs, then dynamically imports a *fresh* copy of the module
// via `vi.resetModules()`. All DOM access in the store is feature-guarded, so we
// hand-roll only the minimal globals each test needs.

// ---- minimal in-memory localStorage ---------------------------------------
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

// ---- fake matchMedia -------------------------------------------------------
// Records listeners so a test can flip the OS scheme and fire a change event.
function makeMatchMedia(initialLight: boolean) {
  const state = { light: initialLight };
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return state.light;
    },
    media: '(prefers-color-scheme: light)',
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
    // legacy
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
  };
  const matchMedia = vi.fn(() => mql);
  const setLight = (light: boolean) => {
    state.light = light;
    listeners.forEach((cb) => cb());
  };
  return { matchMedia, setLight, listenerCount: () => listeners.size };
}

// ---- fake document with a documentElement.dataset -------------------------
function makeDocument() {
  return { documentElement: { dataset: {} as Record<string, string> } };
}

const KEY = 'winforge-web.theme.v1';
let storage: MemoryStorage;

beforeEach(() => {
  vi.resetModules();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  return import('./theme');
}

describe('theme store — defaults & persistence', () => {
  it("defaults to 'system' when storage is empty", async () => {
    const { getThemeMode, DEFAULT_THEME_MODE } = await load();
    expect(DEFAULT_THEME_MODE).toBe('system');
    expect(getThemeMode()).toBe('system');
  });

  it('round-trips set -> get', async () => {
    const { getThemeMode, setThemeMode } = await load();
    setThemeMode('dark');
    expect(getThemeMode()).toBe('dark');
    setThemeMode('light');
    expect(getThemeMode()).toBe('light');
  });

  it('persists the mode as a bare string and reloads it', async () => {
    const first = await load();
    first.setThemeMode('dark');
    expect(storage.getItem(KEY)).toBe('dark');

    // A fresh module instance over the same storage picks up the value.
    vi.resetModules();
    const second = await load();
    expect(second.getThemeMode()).toBe('dark');
  });

  it('tolerates a JSON-quoted stored value', async () => {
    storage.setItem(KEY, '"light"');
    const { getThemeMode } = await load();
    expect(getThemeMode()).toBe('light');
  });

  it('falls back to default on corrupt / unknown storage', async () => {
    storage.setItem(KEY, '{not valid');
    const a = await load();
    expect(a.getThemeMode()).toBe('system');

    vi.resetModules();
    storage.setItem(KEY, 'purple');
    const b = await load();
    expect(b.getThemeMode()).toBe('system');
  });

  it('ignores an invalid mode passed to setThemeMode', async () => {
    const { getThemeMode, setThemeMode } = await load();
    // @ts-expect-error — deliberately invalid at the type boundary
    setThemeMode('neon');
    expect(getThemeMode()).toBe('system');
  });
});

describe('resolvedTheme — mode wins over matchMedia', () => {
  it("mode 'light'/'dark' ignore the OS scheme", async () => {
    const mm = makeMatchMedia(true);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const { setThemeMode, resolvedTheme } = await load();
    setThemeMode('dark');
    expect(resolvedTheme()).toBe('dark');
    setThemeMode('light');
    expect(resolvedTheme()).toBe('light');
  });

  it("mode 'system' follows matchMedia (light)", async () => {
    const mm = makeMatchMedia(true);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const { setThemeMode, resolvedTheme } = await load();
    setThemeMode('system');
    expect(resolvedTheme()).toBe('light');
  });

  it("mode 'system' follows matchMedia (dark)", async () => {
    const mm = makeMatchMedia(false);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const { setThemeMode, resolvedTheme } = await load();
    setThemeMode('system');
    expect(resolvedTheme()).toBe('dark');
  });

  it('without matchMedia, system resolves to dark (CSS default)', async () => {
    // No window global at all.
    const { resolvedTheme, getThemeMode } = await load();
    expect(getThemeMode()).toBe('system');
    expect(resolvedTheme()).toBe('dark');
  });
});

describe('subscribe / hook-core notify', () => {
  it('notifies subscribers on change and stops after unsubscribe', async () => {
    const { setThemeMode, subscribeThemeMode } = await load();
    const seen: string[] = [];
    const unsub = subscribeThemeMode((m) => seen.push(m));

    setThemeMode('dark');
    expect(seen).toEqual(['dark']);

    setThemeMode('dark'); // unchanged → no emit
    expect(seen).toEqual(['dark']);

    unsub();
    setThemeMode('light');
    expect(seen).toEqual(['dark']);
  });

  it('emits when the OS scheme changes while in system mode', async () => {
    const mm = makeMatchMedia(false);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const doc = makeDocument();
    vi.stubGlobal('document', doc);

    const { initTheme, subscribeThemeMode, resolvedTheme } = await load();
    initTheme();

    const seen: string[] = [];
    subscribeThemeMode((m) => seen.push(m));

    expect(resolvedTheme()).toBe('dark');
    mm.setLight(true); // OS flips to light
    expect(seen).toEqual(['system']); // system mode re-emits
    expect(resolvedTheme()).toBe('light');
    expect(doc.documentElement.dataset.resolvedTheme).toBe('light');
  });
});

describe('initTheme — DOM application & idempotency', () => {
  it('sets dataset.theme and dataset.resolvedTheme on the mocked document', async () => {
    const mm = makeMatchMedia(true);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const doc = makeDocument();
    vi.stubGlobal('document', doc);

    const { initTheme, setThemeMode } = await load();
    setThemeMode('system');
    initTheme();

    expect(doc.documentElement.dataset.theme).toBe('system');
    expect(doc.documentElement.dataset.resolvedTheme).toBe('light');
  });

  it('is idempotent — repeated calls install only one media listener', async () => {
    const mm = makeMatchMedia(false);
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    vi.stubGlobal('document', makeDocument());

    const { initTheme } = await load();
    initTheme();
    initTheme();
    initTheme();
    expect(mm.listenerCount()).toBe(1);
  });

  it('applyTheme reflects the raw mode, not the resolved scheme', async () => {
    const mm = makeMatchMedia(true); // OS light
    vi.stubGlobal('window', { matchMedia: mm.matchMedia });
    const doc = makeDocument();
    vi.stubGlobal('document', doc);

    const { initTheme, setThemeMode } = await load();
    setThemeMode('dark'); // explicit dark despite OS light
    initTheme();

    expect(doc.documentElement.dataset.theme).toBe('dark');
    expect(doc.documentElement.dataset.resolvedTheme).toBe('dark');
  });
});
