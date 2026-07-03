import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'winforge-web.recents.v1';

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
  return import('./recents');
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
});

describe('recents store', () => {
  it('starts empty', async () => {
    installStorage();
    const { getRecents } = await freshStore();
    expect(getRecents()).toEqual([]);
  });

  it('pushRecent puts newest first', async () => {
    installStorage();
    const { pushRecent, getRecents } = await freshStore();
    pushRecent('a');
    pushRecent('b');
    pushRecent('c');
    expect(getRecents()).toEqual(['c', 'b', 'a']);
  });

  it('re-pushing an existing tag moves it to the front (dedupe)', async () => {
    installStorage();
    const { pushRecent, getRecents } = await freshStore();
    pushRecent('a');
    pushRecent('b');
    pushRecent('c');
    pushRecent('a');
    expect(getRecents()).toEqual(['a', 'c', 'b']);
    expect(getRecents().length).toBe(3);
  });

  it('evicts the oldest past a cap of 12 (LRU)', async () => {
    installStorage();
    const { pushRecent, getRecents } = await freshStore();
    for (let i = 1; i <= 15; i++) pushRecent(`m${i}`);
    const r = getRecents();
    expect(r.length).toBe(12);
    expect(r[0]).toBe('m15'); // newest
    expect(r[11]).toBe('m4'); // m1..m3 evicted
    expect(r).not.toContain('m1');
    expect(r).not.toContain('m3');
  });

  it('clearRecents empties the list', async () => {
    installStorage(JSON.stringify(['a', 'b']));
    const { clearRecents, getRecents } = await freshStore();
    expect(getRecents()).toEqual(['a', 'b']);
    clearRecents();
    expect(getRecents()).toEqual([]);
  });

  it('persists across a reload (round-trip)', async () => {
    installStorage();
    {
      const { pushRecent } = await freshStore();
      pushRecent('a');
      pushRecent('b');
    }
    const { getRecents } = await freshStore();
    expect(getRecents()).toEqual(['b', 'a']);
  });

  it('falls back to empty on corrupt JSON', async () => {
    installStorage('<<<bad');
    const { getRecents, pushRecent } = await freshStore();
    expect(getRecents()).toEqual([]);
    pushRecent('a');
    expect(getRecents()).toEqual(['a']);
  });

  it('caps and de-dupes corrupt/legacy persisted data on load', async () => {
    const seed = JSON.stringify([
      'a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n',
    ]);
    installStorage(seed);
    const { getRecents } = await freshStore();
    const r = getRecents();
    expect(r.length).toBe(12);
    expect(r[0]).toBe('a');
    expect(new Set(r).size).toBe(12); // no dupes
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    installStorage();
    const { subscribeRecents, pushRecent } = await freshStore();
    const cb = vi.fn();
    const unsub = subscribeRecents(cb);
    pushRecent('a');
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    pushRecent('b');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('works with no localStorage (in-memory fallback)', async () => {
    const { pushRecent, getRecents } = await freshStore();
    pushRecent('a');
    expect(getRecents()).toEqual(['a']);
  });
});
