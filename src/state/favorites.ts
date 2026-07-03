// Pinned favorites store: an ordered list of module tags the user has pinned.
// Self-contained persistence + subscribe (intentionally NOT sharing prefs.ts /
// store.ts, which are owned by another agent). ~30 lines of store boilerplate
// duplicated here is expected and will be reconciled later.

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'winforge-web.favorites.v1';

type Listener = () => void;

const listeners = new Set<Listener>();
let order: string[] = load();

/** localStorage may be missing (SSR, node tests) or throw (privacy mode). */
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
    // Keep only unique, truthy strings (defends against corrupt/legacy data).
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  } catch {
    return []; // corrupt JSON -> empty
  }
}

function persist(): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* quota / disabled — keep in-memory copy */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: string[]): void {
  order = next;
  persist();
  emit();
}

/** Current favorites, newest-pinned last (insertion order, user-reorderable). */
export function getFavorites(): string[] {
  return order;
}

export function isFavorite(tag: string): boolean {
  return order.includes(tag);
}

/** Pin if absent, unpin if present. Returns the resulting pinned state. */
export function toggleFavorite(tag: string): boolean {
  if (!tag) return false;
  if (order.includes(tag)) {
    commit(order.filter((t) => t !== tag));
    return false;
  }
  commit([...order, tag]);
  return true;
}

export function addFavorite(tag: string): void {
  if (tag && !order.includes(tag)) commit([...order, tag]);
}

export function removeFavorite(tag: string): void {
  if (order.includes(tag)) commit(order.filter((t) => t !== tag));
}

/** Move a pinned tag to a new index (for drag-and-drop reordering). */
export function moveFavorite(tag: string, toIndex: number): void {
  const from = order.indexOf(tag);
  if (from === -1) return;
  const next = order.slice();
  next.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, next.length));
  next.splice(clamped, 0, tag);
  // No-op guard: avoid spurious emit if nothing actually changed.
  if (next.every((t, i) => t === order[i]) && next.length === order.length) return;
  commit(next);
}

export function subscribeFavorites(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: re-renders when the favorites list changes. */
export function useFavorites(): string[] {
  return useSyncExternalStore(subscribeFavorites, getFavorites, getFavorites);
}
