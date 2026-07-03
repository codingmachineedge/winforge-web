// 報警窗盤閂鎖邏輯 · Annunciator latching logic (pure, unit-testable).
//
// A control-room annunciator tile follows the classic ISA-18.1 sequence, reduced here to the three
// visible states an operator cares about:
//
//   • 'off'     — the alarm condition is NOT active and there is nothing to acknowledge.
//   • 'active'  — the alarm condition IS active and has NOT been acknowledged → tile FLASHES.
//   • 'latched' — the alarm condition has CLEARED but was never acknowledged → tile stays lit
//                 (steady) so a transient trip that came and went is not missed.
//
// Acknowledging clears the flash: an ack'd-but-still-active alarm shows steady lit ('ackActive');
// an ack'd alarm whose condition has since cleared returns to 'off'.
//
// The engine hands us a flat list of currently-active alarm keys each tick. We keep, per key, an
// immutable little record and fold the new active-set into it. No React, no timers — the flashing
// itself is a CSS animation driven by the returned state.

/** Visible annunciator states for one alarm tile. */
export type TileState =
  | 'off' // clear + acknowledged (or never fired)
  | 'active' // active + unacknowledged → flashing
  | 'ackActive' // active + acknowledged → steady lit
  | 'latched'; // cleared + unacknowledged → steady lit (ringback), awaiting ACK

/** Per-alarm latch record. */
export interface TileLatch {
  /** Is the underlying alarm condition currently asserted by the engine? */
  active: boolean;
  /** Has the operator acknowledged the current alarm episode? */
  acknowledged: boolean;
}

export type LatchMap = Readonly<Record<string, TileLatch>>;

/**
 * Derive the visible tile state from a latch record. An ABSENT record (undefined) means the tile
 * is fully off — the reducer only keeps a record while a tile is lit (active or a cleared ringback),
 * and drops it once acknowledged-and-cleared. A present record therefore never encodes 'off'.
 */
export function tileState(l: TileLatch | undefined): TileState {
  if (!l) return 'off';
  if (l.active) return l.acknowledged ? 'ackActive' : 'active';
  // present but not active ⇒ cleared-and-never-acknowledged ringback.
  return 'latched';
}

/** True when a tile should be flashing (active + unacknowledged). */
export function isFlashing(l: TileLatch | undefined): boolean {
  return tileState(l) === 'active';
}

/** True when a tile is illuminated at all (any state except fully-off). */
export function isLit(l: TileLatch | undefined): boolean {
  return tileState(l) !== 'off';
}

/**
 * Fold this tick's active alarm keys into the prior latch map, producing the next latch map.
 *
 * Rules:
 *   • A key newly appearing in `activeKeys` becomes active. If it was previously off/cleared, this
 *     is a fresh episode → acknowledged resets to false (it must flash again).
 *   • A key still present stays active and preserves its acknowledged flag.
 *   • A key that disappears becomes inactive. If it had NOT been acknowledged it latches (stays lit)
 *     until acknowledged; if it had been acknowledged it is dropped from the map (fully off).
 */
export function reduceLatches(prev: LatchMap, activeKeys: readonly string[]): LatchMap {
  const activeSet = new Set(activeKeys);
  const next: Record<string, TileLatch> = {};

  // 1) advance every currently-active key
  for (const key of activeSet) {
    const p = prev[key];
    if (p && p.active) {
      // still active — preserve acknowledged
      next[key] = { active: true, acknowledged: p.acknowledged };
    } else {
      // fresh episode (was off, or was latched-cleared) — must flash again
      next[key] = { active: true, acknowledged: false };
    }
  }

  // 2) carry forward prior keys that are no longer active
  for (const key of Object.keys(prev)) {
    if (activeSet.has(key)) continue; // already handled above
    const p = prev[key]!;
    if (p.acknowledged) {
      // cleared AND already acknowledged → drop (fully off); omit from map
      continue;
    }
    // cleared but never acknowledged → ringback latch, stays lit awaiting ACK
    next[key] = { active: false, acknowledged: false };
  }

  return next;
}

/**
 * Acknowledge alarms. Acknowledging marks every currently-latched/active tile as acknowledged.
 * Cleared-and-now-acknowledged tiles are dropped (they turn off); still-active tiles go steady.
 */
export function acknowledgeAll(prev: LatchMap): LatchMap {
  const next: Record<string, TileLatch> = {};
  for (const key of Object.keys(prev)) {
    const p = prev[key]!;
    if (p.active) {
      next[key] = { active: true, acknowledged: true }; // steady lit
    }
    // inactive tiles (latched ringbacks) are cleared by the ACK → dropped
  }
  return next;
}

/** Acknowledge a single tile by key. */
export function acknowledgeOne(prev: LatchMap, key: string): LatchMap {
  const p = prev[key];
  if (!p) return prev;
  const next: Record<string, TileLatch> = { ...prev };
  if (p.active) next[key] = { active: true, acknowledged: true };
  else delete next[key];
  return next;
}

/** Count tiles that are currently flashing (active + unacknowledged) — for a summary badge. */
export function flashingCount(map: LatchMap): number {
  let n = 0;
  for (const key of Object.keys(map)) if (isFlashing(map[key])) n++;
  return n;
}
