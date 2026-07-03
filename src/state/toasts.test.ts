// Unit tests for the toast queue singleton. Node env, fake timers — exercise push /
// dismiss, per-kind auto-dismiss timing, sticky (duration 0), the max-visible cap,
// subscribe notifications, and the pause/resume (hover) logic as pure functions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  toast,
  pushToast,
  dismissToast,
  clearToasts,
  pauseToast,
  resumeToast,
  getToasts,
  subscribeToasts,
  MAX_VISIBLE,
  DEFAULT_DURATIONS,
  __resetToastsForTest,
} from './toasts';

beforeEach(() => {
  vi.useFakeTimers();
  __resetToastsForTest();
});

afterEach(() => {
  clearToasts();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('push / dismiss', () => {
  it('pushes a toast and returns an incrementing id', () => {
    const id1 = pushToast('info', 'hello');
    const id2 = pushToast('success', 'world');
    expect(id2).toBeGreaterThan(id1);
    const list = getToasts();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: id1, kind: 'info', message: 'hello' });
    expect(list[1]).toMatchObject({ id: id2, kind: 'success', message: 'world' });
  });

  it('carries detail through when provided', () => {
    pushToast('error', 'Boom', { detail: 'stack trace here' });
    expect(getToasts()[0]?.detail).toBe('stack trace here');
  });

  it('dismisses a specific toast by id and leaves the rest', () => {
    const a = pushToast('info', 'a');
    const b = pushToast('info', 'b');
    dismissToast(a);
    const list = getToasts();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(b);
  });

  it('dismissing an unknown id is a no-op', () => {
    pushToast('info', 'a');
    dismissToast(99999);
    expect(getToasts()).toHaveLength(1);
  });

  it('clearToasts empties the queue', () => {
    pushToast('info', 'a');
    pushToast('info', 'b');
    clearToasts();
    expect(getToasts()).toHaveLength(0);
  });
});

describe('convenience toast() fn', () => {
  it('exposes kind shortcuts', () => {
    toast.info('i');
    toast.success('s');
    toast.warning('w');
    toast.error('e');
    expect(getToasts().map((t) => t.kind)).toEqual(['info', 'success', 'warning', 'error']);
  });

  it('is also callable as toast(kind, message)', () => {
    toast('warning', 'careful');
    expect(getToasts()[0]).toMatchObject({ kind: 'warning', message: 'careful' });
  });
});

describe('auto-dismiss timing per kind', () => {
  it('info/success auto-dismiss at the default duration', () => {
    pushToast('info', 'x');
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_DURATIONS.info - 1);
    expect(getToasts()).toHaveLength(1); // still present just before
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0); // gone at the threshold
  });

  it('errors linger longer than info', () => {
    pushToast('error', 'err');
    vi.advanceTimersByTime(DEFAULT_DURATIONS.info); // info would be gone by now
    expect(getToasts()).toHaveLength(1); // error still visible
    vi.advanceTimersByTime(DEFAULT_DURATIONS.error - DEFAULT_DURATIONS.info);
    expect(getToasts()).toHaveLength(0);
  });

  it('honours an explicit duration override', () => {
    pushToast('info', 'x', { duration: 1000 });
    vi.advanceTimersByTime(999);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });
});

describe('sticky (duration 0)', () => {
  it('never auto-dismisses when duration is 0', () => {
    pushToast('error', 'sticky', { duration: 0 });
    vi.advanceTimersByTime(1_000_000);
    expect(getToasts()).toHaveLength(1);
    // still removable manually
    dismissToast(getToasts()[0]!.id);
    expect(getToasts()).toHaveLength(0);
  });

  it('treats negative durations as sticky too', () => {
    pushToast('info', 'sticky', { duration: -5 });
    vi.advanceTimersByTime(1_000_000);
    expect(getToasts()).toHaveLength(1);
  });
});

describe('max-visible cap', () => {
  it('never exceeds MAX_VISIBLE, dropping the oldest', () => {
    const ids: number[] = [];
    for (let i = 0; i < MAX_VISIBLE + 3; i++) ids.push(pushToast('info', `#${i}`, { duration: 0 }));
    const list = getToasts();
    expect(list).toHaveLength(MAX_VISIBLE);
    // The first three should have been dropped; the last MAX_VISIBLE remain in order.
    expect(list.map((t) => t.id)).toEqual(ids.slice(-MAX_VISIBLE));
  });

  it('cancels the dropped toast timer so it cannot fire later', () => {
    const first = pushToast('info', 'first', { duration: 1000 });
    for (let i = 0; i < MAX_VISIBLE; i++) pushToast('info', `fill-${i}`, { duration: 0 });
    // `first` has been evicted; advancing past its timer must not throw or double-remove.
    expect(getToasts().some((t) => t.id === first)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(getToasts()).toHaveLength(MAX_VISIBLE);
  });
});

describe('subscribe notifications', () => {
  it('notifies subscribers on push and dismiss, and stops after unsubscribe', () => {
    const spy = vi.fn();
    const unsub = subscribeToasts(spy);
    const id = pushToast('info', 'a');
    expect(spy).toHaveBeenCalledTimes(1);
    dismissToast(id);
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
    pushToast('info', 'b');
    expect(spy).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });

  it('notifies when a toast auto-dismisses via its timer', () => {
    const spy = vi.fn();
    subscribeToasts(spy);
    pushToast('info', 'a', { duration: 500 });
    expect(spy).toHaveBeenCalledTimes(1); // push
    vi.advanceTimersByTime(500);
    expect(spy).toHaveBeenCalledTimes(2); // auto-dismiss
  });
});

describe('hover pause / resume (pure logic)', () => {
  it('pauseToast cancels the pending auto-dismiss', () => {
    const id = pushToast('info', 'x', { duration: 1000 });
    pauseToast(id);
    vi.advanceTimersByTime(5000);
    expect(getToasts().some((t) => t.id === id)).toBe(true); // paused → still here
  });

  it('resumeToast re-arms the timer from the configured duration', () => {
    const id = pushToast('info', 'x', { duration: 1000 });
    pauseToast(id);
    vi.advanceTimersByTime(5000);
    expect(getToasts()).toHaveLength(1);
    resumeToast(id);
    vi.advanceTimersByTime(999);
    expect(getToasts()).toHaveLength(1); // not yet
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0); // dismissed on the fresh full duration
  });

  it('resumeToast on a sticky toast stays sticky', () => {
    const id = pushToast('info', 'x', { duration: 0 });
    pauseToast(id);
    resumeToast(id);
    vi.advanceTimersByTime(1_000_000);
    expect(getToasts()).toHaveLength(1);
  });

  it('resumeToast on an unknown id is a no-op', () => {
    resumeToast(4242);
    expect(getToasts()).toHaveLength(0);
  });
});
