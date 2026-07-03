// In-app toast queue — a framework-light, module-singleton store usable from anywhere,
// including non-React code (e.g. Tauri `invoke` error paths). React consumers subscribe
// via `useToasts()` (useSyncExternalStore); non-React callers just import `toast`.
//
// Queue semantics:
//   - max 5 visible; when a 6th arrives the oldest is auto-dropped (collapsed out).
//   - auto-dismiss after `duration` ms (default 4500; errors default 8000).
//   - `duration: 0` (or negative) → sticky, never auto-dismisses.
//   - timers are always cleared on dismiss / drop / clear so nothing leaks.
//
// The store is environment-guarded: timers only run where `setTimeout` exists, and
// nothing touches `window`/`document` here (that lives in ToastHost).

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  /** ms until auto-dismiss. Default depends on kind; 0 (or <0) = sticky. */
  duration?: number;
}

export interface ToastOptions {
  detail?: string;
  duration?: number;
}

/** Maximum number of toasts kept in the visible queue. */
export const MAX_VISIBLE = 5;

/** Default auto-dismiss durations (ms) per kind. `error` lingers longer to be read. */
export const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  info: 4500,
  success: 4500,
  warning: 4500,
  error: 8000,
};

type Listener = () => void;

let items: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const hasTimers = typeof setTimeout === 'function';

function emit(): void {
  // Snapshot the listener set so a listener that (un)subscribes mid-loop is safe.
  for (const l of [...listeners]) l();
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** Resolve the effective auto-dismiss duration for a kind + explicit override. */
function resolveDuration(kind: ToastKind, duration?: number): number {
  return duration === undefined ? DEFAULT_DURATIONS[kind] : duration;
}

function armTimer(id: number, duration: number): void {
  if (!hasTimers || duration <= 0) return; // sticky or non-browser: no timer
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      dismissToast(id);
    }, duration),
  );
}

/**
 * Push a toast. Callable directly (`pushToast('error', 'Boom')`) or via the kind
 * shortcuts (`toast.error('Boom')`). Returns the new toast id so callers can later
 * `dismissToast(id)` (e.g. to clear a sticky progress toast).
 */
export function pushToast(kind: ToastKind, message: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  const duration = resolveDuration(kind, opts.duration);
  const t: Toast = { id, kind, message, duration };
  if (opts.detail !== undefined) t.detail = opts.detail;

  let next = [...items, t];
  // Enforce the visible cap by dropping the oldest (and cancelling its timer).
  while (next.length > MAX_VISIBLE) {
    const dropped = next[0];
    next = next.slice(1);
    if (dropped) clearTimer(dropped.id);
  }
  items = next;

  armTimer(id, duration);
  emit();
  return id;
}

export interface ToastFn {
  (kind: ToastKind, message: string, opts?: ToastOptions): number;
  info(message: string, opts?: ToastOptions): number;
  success(message: string, opts?: ToastOptions): number;
  warning(message: string, opts?: ToastOptions): number;
  error(message: string, opts?: ToastOptions): number;
}

/**
 * The public convenience entry point. Use either form:
 *   toast('error', 'Failed to load')
 *   toast.error('Failed to load', { detail: String(err) })
 */
export const toast: ToastFn = Object.assign(
  (kind: ToastKind, message: string, opts?: ToastOptions) => pushToast(kind, message, opts),
  {
    info: (message: string, opts?: ToastOptions) => pushToast('info', message, opts),
    success: (message: string, opts?: ToastOptions) => pushToast('success', message, opts),
    warning: (message: string, opts?: ToastOptions) => pushToast('warning', message, opts),
    error: (message: string, opts?: ToastOptions) => pushToast('error', message, opts),
  },
);

/** Dismiss a single toast by id (no-op if it is already gone). */
export function dismissToast(id: number): void {
  clearTimer(id);
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return; // nothing removed
  items = next;
  emit();
}

/** Remove every toast and cancel all pending timers. */
export function clearToasts(): void {
  for (const id of timers.keys()) clearTimeout(timers.get(id)!);
  timers.clear();
  if (items.length === 0) return;
  items = [];
  emit();
}

/**
 * Pause auto-dismiss for a toast (e.g. while the pointer hovers it). Cancels the
 * pending timer but leaves the toast in the queue. Pure logic — safe to unit-test.
 */
export function pauseToast(id: number): void {
  clearTimer(id);
}

/**
 * Resume auto-dismiss for a toast, re-arming its timer from its configured duration.
 * No-op for sticky toasts (duration 0) or toasts that no longer exist.
 */
export function resumeToast(id: number): void {
  const t = items.find((x) => x.id === id);
  if (!t) return;
  armTimer(id, resolveDuration(t.kind, t.duration));
}

/** Subscribe to store changes. Returns an unsubscribe fn (useSyncExternalStore shape). */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot getter for useSyncExternalStore — returns the current array by reference. */
export function getToasts(): Toast[] {
  return items;
}

// Lazily imported React hook. Keeping `useSyncExternalStore` off the top-level import
// means non-React callers can import { toast } without pulling React into their path
// at module-eval time — but since React is always available in this app we import it
// normally here; the hook is only invoked inside components.
import { useSyncExternalStore } from 'react';

/** React hook: the live list of visible toasts. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}

// Test-only reset so unit tests start from a clean singleton without leaking state.
export function __resetToastsForTest(): void {
  for (const id of timers.keys()) clearTimeout(timers.get(id)!);
  timers.clear();
  items = [];
  nextId = 1;
  listeners.clear();
}
