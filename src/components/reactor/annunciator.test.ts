import { describe, it, expect } from 'vitest';
import {
  reduceLatches,
  acknowledgeAll,
  acknowledgeOne,
  tileState,
  isFlashing,
  isLit,
  flashingCount,
  type LatchMap,
} from './annunciatorLatch';

describe('annunciator latching logic', () => {
  it('an inactive/absent key is off', () => {
    expect(tileState(undefined)).toBe('off');
    expect(isLit(undefined)).toBe(false);
    expect(isFlashing(undefined)).toBe(false);
  });

  it('a newly active alarm flashes (active + unacknowledged)', () => {
    const m = reduceLatches({}, ['Reactor Trip']);
    expect(tileState(m['Reactor Trip'])).toBe('active');
    expect(isFlashing(m['Reactor Trip'])).toBe(true);
    expect(isLit(m['Reactor Trip'])).toBe(true);
    expect(flashingCount(m)).toBe(1);
  });

  it('acknowledging an active alarm makes it steady lit, not off', () => {
    let m: LatchMap = reduceLatches({}, ['Power Range High']);
    m = acknowledgeAll(m);
    expect(tileState(m['Power Range High'])).toBe('ackActive');
    expect(isFlashing(m['Power Range High'])).toBe(false);
    expect(isLit(m['Power Range High'])).toBe(true);
    expect(flashingCount(m)).toBe(0);
  });

  it('an active alarm that stays active preserves its acknowledged flag across ticks', () => {
    let m: LatchMap = reduceLatches({}, ['Hot-Leg Temperature High']);
    m = acknowledgeAll(m); // ackActive
    m = reduceLatches(m, ['Hot-Leg Temperature High']); // still active next tick
    expect(tileState(m['Hot-Leg Temperature High'])).toBe('ackActive');
  });

  it('an unacknowledged alarm that clears LATCHES (stays lit as ringback)', () => {
    let m: LatchMap = reduceLatches({}, ['Startup Rate High']);
    m = reduceLatches(m, []); // condition cleared, never ack'd
    expect(tileState(m['Startup Rate High'])).toBe('latched');
    expect(isLit(m['Startup Rate High'])).toBe(true);
    expect(isFlashing(m['Startup Rate High'])).toBe(false);
  });

  it('acknowledging a latched (cleared) ringback turns it off', () => {
    let m: LatchMap = reduceLatches({}, ['Startup Rate High']);
    m = reduceLatches(m, []); // latched
    m = acknowledgeAll(m);
    expect(tileState(m['Startup Rate High'])).toBe('off');
    expect(m['Startup Rate High']).toBeUndefined();
  });

  it('an acknowledged alarm that then clears is dropped (fully off)', () => {
    let m: LatchMap = reduceLatches({}, ['Pressurizer Pressure High']);
    m = acknowledgeAll(m); // ackActive
    m = reduceLatches(m, []); // clears while acknowledged
    expect(tileState(m['Pressurizer Pressure High'])).toBe('off');
    expect(m['Pressurizer Pressure High']).toBeUndefined();
  });

  it('re-firing a cleared-but-latched alarm resets it to flashing (fresh episode)', () => {
    let m: LatchMap = reduceLatches({}, ['Reactor Coolant Flow Low']);
    m = reduceLatches(m, []); // latched (never ack'd)
    m = reduceLatches(m, ['Reactor Coolant Flow Low']); // fires again
    expect(tileState(m['Reactor Coolant Flow Low'])).toBe('active');
    expect(isFlashing(m['Reactor Coolant Flow Low'])).toBe(true);
  });

  it('re-firing an alarm after ACK + clear flashes again (acknowledged does not stick)', () => {
    let m: LatchMap = reduceLatches({}, ['Fuel Temperature High']);
    m = acknowledgeAll(m); // ackActive
    m = reduceLatches(m, []); // clears, dropped
    m = reduceLatches(m, ['Fuel Temperature High']); // new episode
    expect(tileState(m['Fuel Temperature High'])).toBe('active');
  });

  it('acknowledgeOne only affects the named tile', () => {
    let m: LatchMap = reduceLatches({}, ['A', 'B']);
    m = acknowledgeOne(m, 'A');
    expect(tileState(m['A'])).toBe('ackActive');
    expect(tileState(m['B'])).toBe('active');
    expect(flashingCount(m)).toBe(1);
  });

  it('handles several simultaneous alarms and a mixed clear/persist tick', () => {
    let m: LatchMap = reduceLatches({}, ['A', 'B', 'C']);
    expect(flashingCount(m)).toBe(3);
    m = acknowledgeAll(m); // all ackActive
    expect(flashingCount(m)).toBe(0);
    m = reduceLatches(m, ['A']); // B, C clear (were ack'd → dropped); A persists
    expect(tileState(m['A'])).toBe('ackActive');
    expect(m['B']).toBeUndefined();
    expect(m['C']).toBeUndefined();
  });
});
