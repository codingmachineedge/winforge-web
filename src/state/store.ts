import { useCallback, useSyncExternalStore } from 'react';

// A tiny generic persisted-store factory. State is a flat object of typed keys,
// serialized as one JSON blob in localStorage under `storageKey`. Values are
// deep-merged over `defaults` on load so newly-added keys always have a value,
// and corrupt / partial JSON degrades to the defaults instead of throwing.
//
// Everything feature-detects `window`/`localStorage` so it also works in SSR and
// in the node test environment (no jsdom): there it silently falls back to an
// in-memory copy and no-op cross-tab sync.

export interface PersistedStore<T extends object> {
  get<K extends keyof T>(k: K): T[K];
  set<K extends keyof T>(k: K, v: T[K]): void;
  getAll(): T;
  subscribe<K extends keyof T>(k: K, cb: (v: T[K]) => void): () => void;
  useValue<K extends keyof T>(k: K): [T[K], (v: T[K]) => void];
}

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed iframe / disabled cookies).
    return false;
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `source` over a clone of `base`; only overlays keys `base` knows. */
function deepMerge<T extends object>(base: T, source: unknown): T {
  const out = { ...base } as Record<string, unknown>;
  if (!isPlainObject(source)) return out as T;
  for (const key of Object.keys(base)) {
    if (!(key in source)) continue;
    const bv = (base as Record<string, unknown>)[key];
    const sv = source[key];
    out[key] = isPlainObject(bv) && isPlainObject(sv) ? deepMerge(bv, sv) : sv;
  }
  return out as T;
}

export function createPersistedStore<T extends object>(
  storageKey: string,
  defaults: T,
): PersistedStore<T> {
  const load = (): T => {
    if (!hasLocalStorage()) return { ...defaults };
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return { ...defaults };
      return deepMerge(defaults, JSON.parse(raw) as unknown);
    } catch {
      return { ...defaults };
    }
  };

  let state: T = load();

  // Per-key subscriber sets, plus whole-store listeners for the React hook.
  const listeners = new Map<keyof T, Set<(v: unknown) => void>>();

  const persist = (): void => {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Quota / disabled storage — keep the in-memory value, drop persistence.
    }
  };

  const emit = <K extends keyof T>(k: K, v: T[K]): void => {
    listeners.get(k)?.forEach((cb) => cb(v));
  };

  const get = <K extends keyof T>(k: K): T[K] => state[k];

  const set = <K extends keyof T>(k: K, v: T[K]): void => {
    if (Object.is(state[k], v)) return;
    state = { ...state, [k]: v };
    persist();
    emit(k, v);
  };

  const getAll = (): T => ({ ...state });

  const subscribe = <K extends keyof T>(k: K, cb: (v: T[K]) => void): (() => void) => {
    let set_ = listeners.get(k);
    if (!set_) {
      set_ = new Set();
      listeners.set(k, set_);
    }
    const fn = cb as (v: unknown) => void;
    set_.add(fn);
    return () => {
      set_?.delete(fn);
    };
  };

  // Cross-tab sync: another tab wrote the blob → reload and emit changed keys.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== null && e.key !== storageKey) return;
      const prev = state;
      state = load();
      for (const key of Object.keys(state) as (keyof T)[]) {
        if (!Object.is(prev[key], state[key])) emit(key, state[key]);
      }
    });
  }

  const useValue = <K extends keyof T>(k: K): [T[K], (v: T[K]) => void] => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const value = useSyncExternalStore(
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useCallback((onChange: () => void) => subscribe(k, onChange), [k]),
      () => get(k),
      () => get(k),
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const setValue = useCallback((v: T[K]) => set(k, v), [k]);
    return [value, setValue];
  };

  return { get, set, getAll, subscribe, useValue };
}
