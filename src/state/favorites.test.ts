import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store reads localStorage at module-evaluation time and holds module-level
// state, so each test freshly imports it after seeding storage. A minimal
// in-memory localStorage polyfill stands in for the browser API (node env).

const KEY = 'winforge-web.favorites.v1';

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
}

function installStorage(seed?: string) {
  const s = new MemStorage();
  if (seed !== undefined) s.setItem(KEY, seed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = s as unknown as Storage;
  return s;
}

async function freshStore() {
  vi.resetModules();
  return import('./favorites');
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
});

describe('favorites store', () => {
  it('starts empty with no storage seed', async () => {
    installStorage();
    const { getFavorites, isFavorite } = await freshStore();
    expect(getFavorites()).toEqual([]);
    expect(isFavorite('a')).toBe(false);
  });

  it('toggle pins then unpins, returning the new state', async () => {
    installStorage();
    const { toggleFavorite, isFavorite, getFavorites } = await freshStore();
    expect(toggleFavorite('a')).toBe(true);
    expect(isFavorite('a')).toBe(true);
    expect(getFavorites()).toEqual(['a']);
    expect(toggleFavorite('a')).toBe(false);
    expect(isFavorite('a')).toBe(false);
    expect(getFavorites()).toEqual([]);
  });

  it('preserves insertion order and does not duplicate', async () => {
    installStorage();
    const { toggleFavorite, addFavorite, getFavorites } = await freshStore();
    toggleFavorite('a');
    toggleFavorite('b');
    toggleFavorite('c');
    addFavorite('b'); // already present -> no-op
    expect(getFavorites()).toEqual(['a', 'b', 'c']);
  });

  it('moveFavorite reorders by index', async () => {
    installStorage(JSON.stringify(['a', 'b', 'c', 'd']));
    const { moveFavorite, getFavorites } = await freshStore();
    moveFavorite('a', 2);
    expect(getFavorites()).toEqual(['b', 'c', 'a', 'd']);
    moveFavorite('d', 0);
    expect(getFavorites()).toEqual(['d', 'b', 'c', 'a']);
  });

  it('moveFavorite clamps out-of-range indices and ignores unknown tags', async () => {
    installStorage(JSON.stringify(['a', 'b', 'c']));
    const { moveFavorite, getFavorites } = await freshStore();
    moveFavorite('a', 99);
    expect(getFavorites()).toEqual(['b', 'c', 'a']);
    moveFavorite('zzz', 0); // not present -> no change
    expect(getFavorites()).toEqual(['b', 'c', 'a']);
  });

  it('persists across a reload (round-trip)', async () => {
    installStorage();
    {
      const { toggleFavorite } = await freshStore();
      toggleFavorite('x');
      toggleFavorite('y');
    }
    // Re-import without wiping storage: simulates a page reload.
    const { getFavorites } = await freshStore();
    expect(getFavorites()).toEqual(['x', 'y']);
  });

  it('falls back to empty on corrupt JSON', async () => {
    installStorage('{not valid json');
    const { getFavorites, toggleFavorite } = await freshStore();
    expect(getFavorites()).toEqual([]);
    expect(toggleFavorite('a')).toBe(true);
  });

  it('ignores non-array persisted data and de-dupes legacy entries', async () => {
    installStorage(JSON.stringify(['a', 'a', 'b', 3, '']));
    const { getFavorites } = await freshStore();
    expect(getFavorites()).toEqual(['a', 'b']);
  });

  it('notifies subscribers on change', async () => {
    installStorage();
    const { subscribeFavorites, toggleFavorite } = await freshStore();
    const cb = vi.fn();
    const unsub = subscribeFavorites(cb);
    toggleFavorite('a');
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    toggleFavorite('b');
    expect(cb).toHaveBeenCalledTimes(1); // no calls after unsubscribe
  });

  it('works with no localStorage at all (in-memory fallback)', async () => {
    // Intentionally do not install storage.
    const { toggleFavorite, getFavorites } = await freshStore();
    expect(toggleFavorite('a')).toBe(true);
    expect(getFavorites()).toEqual(['a']);
  });
});
