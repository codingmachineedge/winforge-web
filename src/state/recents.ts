// Recently-viewed store: an LRU of opened module tags, newest first, capped at
// MAX. Self-contained persistence + subscribe (see favorites.ts for the rationale
// on not sharing prefs.ts / store.ts).

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'winforge-web.recents.v1';
const MAX = 12;

type Listener = () => void;

const listeners = new Set<Listener>();
let recents: string[] = load();

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function load(): string[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
        if (out.length >= MAX) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function persist(): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: string[]): void {
  recents = next;
  persist();
  emit();
}

export function getRecents(): string[] {
  return recents;
}

/** Record a freshly opened module: dedupe to front, evict past MAX. */
export function pushRecent(tag: string): void {
  if (!tag) return;
  const next = [tag, ...recents.filter((t) => t !== tag)].slice(0, MAX);
  // Avoid a redundant emit when the same tag is already at the front.
  if (next.length === recents.length && next.every((t, i) => t === recents[i])) return;
  commit(next);
}

export function clearRecents(): void {
  if (recents.length === 0) return;
  commit([]);
}

export function subscribeRecents(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useRecents(): string[] {
  return useSyncExternalStore(subscribeRecents, getRecents, getRecents);
}
