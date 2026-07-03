import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistedStore } from './store';

// Minimal in-memory localStorage mock — the node test env has no DOM, so we
// install one on globalThis before importing anything that reads it.
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
  get raw(): Map<string, string> {
    return this.map;
  }
}

interface TestPrefs {
  view: 'grid' | 'list';
  collapsed: boolean;
  scale: number;
}
const DEFAULTS: TestPrefs = { view: 'grid', collapsed: false, scale: 1 };
const KEY = 'test.prefs.v1';

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPersistedStore', () => {
  it('returns defaults when storage is empty', () => {
    const store = createPersistedStore(KEY, DEFAULTS);
    expect(store.get('view')).toBe('grid');
    expect(store.get('collapsed')).toBe(false);
    expect(store.getAll()).toEqual(DEFAULTS);
  });

  it('round-trips set -> get', () => {
    const store = createPersistedStore(KEY, DEFAULTS);
    store.set('view', 'list');
    store.set('collapsed', true);
    expect(store.get('view')).toBe('list');
    expect(store.get('collapsed')).toBe(true);
  });

  it('persists to storage as one JSON blob and reloads it', () => {
    const store = createPersistedStore(KEY, DEFAULTS);
    store.set('view', 'list');

    const raw = storage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ view: 'list' });

    // A fresh instance over the same storage sees the persisted value.
    const reloaded = createPersistedStore(KEY, DEFAULTS);
    expect(reloaded.get('view')).toBe('list');
  });

  it('deep-merges stored values over defaults (missing keys keep defaults)', () => {
    storage.setItem(KEY, JSON.stringify({ view: 'list' }));
    const store = createPersistedStore(KEY, DEFAULTS);
    expect(store.get('view')).toBe('list');
    expect(store.get('collapsed')).toBe(false); // absent in blob → default
    expect(store.get('scale')).toBe(1);
  });

  it('falls back to defaults on corrupt JSON', () => {
    storage.setItem(KEY, '{not valid json');
    const store = createPersistedStore(KEY, DEFAULTS);
    expect(store.getAll()).toEqual(DEFAULTS);
  });

  it('subscribe fires on set; unsubscribe stops it', () => {
    const store = createPersistedStore(KEY, DEFAULTS);
    const seen: string[] = [];
    const unsub = store.subscribe('view', (v) => seen.push(v));

    store.set('view', 'list');
    expect(seen).toEqual(['list']);

    unsub();
    store.set('view', 'grid');
    expect(seen).toEqual(['list']); // no further calls after unsubscribe
  });

  it('does not emit when the value is unchanged', () => {
    const store = createPersistedStore(KEY, DEFAULTS);
    const cb = vi.fn();
    store.subscribe('view', cb);
    store.set('view', 'grid'); // same as default
    expect(cb).not.toHaveBeenCalled();
  });

  it('works with no localStorage (in-memory fallback)', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', undefined);
    const store = createPersistedStore(KEY, DEFAULTS);
    store.set('view', 'list');
    expect(store.get('view')).toBe('list'); // still functional, just not persisted
  });
});

describe('prefs store (uiScale clamping)', () => {
  // Import lazily so the localStorage stub is installed first.
  it('clamps uiScale on set and via defaults', async () => {
    const { prefs, DEFAULT_PREFS, UI_SCALE_MIN, UI_SCALE_MAX } = await import('./prefs');
    expect(DEFAULT_PREFS.uiScale).toBe(1);

    prefs.set('uiScale', 5);
    expect(prefs.get('uiScale')).toBe(UI_SCALE_MAX);

    prefs.set('uiScale', 0.1);
    expect(prefs.get('uiScale')).toBe(UI_SCALE_MIN);

    prefs.set('uiScale', 1.2);
    expect(prefs.get('uiScale')).toBe(1.2);

    prefs.set('uiScale', Number.NaN);
    expect(prefs.get('uiScale')).toBe(DEFAULT_PREFS.uiScale);
  });
});
