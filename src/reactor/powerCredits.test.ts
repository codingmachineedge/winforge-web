// 發電額度測試 · Power-generation credits: ledger persistence, external grant entrypoints
// (direct call, window global, inbox payloads) and both redemption modes — the credit-powered
// grid (mode 'grid') and the paid one-hour assisted reactor run (mode 'autostart').

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactorMode, ReactorSim } from './physics';
import {
  CREDIT_GRID_SUPPLY_MW,
  CREDIT_SIM_SECONDS,
  DEFAULT_CREDIT_MODE,
  INBOX_STORAGE_KEY,
  PowerCreditLedger,
  _setSharedLedgerForTests,
  grantPowerCredits,
  installCreditGrantGlobal,
  redeemAutoStart,
  tickAutoRun,
  tickCreditGridSupply,
} from './powerCredits';

// Minimal in-memory localStorage — the node test env has no DOM (same stub as prefs.test.ts).
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
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  _setSharedLedgerForTests(null);
  vi.unstubAllGlobals();
});

const KEY = 'test.powerCredits.v1';
const mkLedger = () => new PowerCreditLedger({ persist: true, storageKey: KEY });

describe('PowerCreditLedger — balance & persistence', () => {
  it('starts at zero with the configured default mode', () => {
    const l = mkLedger();
    expect(l.balance).toBe(0);
    expect(l.mode).toBe(DEFAULT_CREDIT_MODE);
    expect(l.autoRunActive).toBe(false);
  });

  it('grant adds; non-finite / non-positive grants are refused', () => {
    const l = mkLedger();
    expect(l.grant(2.5)).toBe(2.5);
    expect(l.grant(0)).toBe(2.5);
    expect(l.grant(-3)).toBe(2.5);
    expect(l.grant(Number.NaN)).toBe(2.5);
    expect(l.grant(Number.POSITIVE_INFINITY)).toBe(2.5);
  });

  it('drain clamps at zero and reports what was actually drained', () => {
    const l = mkLedger();
    l.grant(1.5);
    expect(l.drain(1)).toBe(1);
    expect(l.drain(2)).toBe(0.5);
    expect(l.balance).toBe(0);
    expect(l.drain(1)).toBe(0);
  });

  it('persists balance, mode and the in-flight auto-run hour across instances', () => {
    const l = mkLedger();
    l.grant(3);
    l.setMode('autostart');
    l.beginAutoRun(); // 3 → 2, arms 3600 s
    l.tickAutoRun(600);

    const reloaded = mkLedger();
    expect(reloaded.balance).toBe(2);
    expect(reloaded.mode).toBe('autostart');
    expect(reloaded.autoRunRemainingS).toBe(CREDIT_SIM_SECONDS - 600);
  });

  it('degrades to defaults on a corrupt blob', () => {
    storage.setItem(KEY, '{not json');
    const l = mkLedger();
    expect(l.balance).toBe(0);
    expect(l.mode).toBe(DEFAULT_CREDIT_MODE);
  });

  it('notifies subscribers on every mutation', () => {
    const l = mkLedger();
    const cb = vi.fn();
    const unsub = l.subscribe(cb);
    l.grant(1);
    l.setMode('autostart');
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    l.grant(1);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('external grant entrypoints', () => {
  it('grant ids are idempotent — the same id is applied at most once', () => {
    const l = mkLedger();
    expect(l.grant(2, 'g-1')).toBe(2);
    expect(l.grant(2, 'g-1')).toBe(2); // duplicate delivery, no change
    expect(l.grant(2, 'g-2')).toBe(4);
  });

  it('ingestInboxPayload applies valid grants once and skips malformed entries', () => {
    const l = mkLedger();
    const payload = {
      grants: [
        { id: 'a', credits: 1 },
        { id: 'b', credits: 0.5 },
        { id: '', credits: 5 }, // empty id — skipped
        { id: 'c', credits: -2 }, // non-positive — skipped
        { credits: 9 }, // no id — skipped
        'garbage', // not an object — skipped
      ],
    };
    expect(l.ingestInboxPayload(payload)).toBe(1.5);
    expect(l.balance).toBe(1.5);
    expect(l.ingestInboxPayload(payload)).toBe(0); // re-delivery no-ops
    expect(l.ingestInboxPayload('nope')).toBe(0);
    expect(l.ingestInboxPayload({ grants: 'nope' })).toBe(0);
  });

  it('ingestBrowserInbox reads, applies and consumes the inbox key', () => {
    const l = mkLedger();
    storage.setItem(INBOX_STORAGE_KEY, JSON.stringify({ grants: [{ id: 'x', credits: 2 }] }));
    expect(l.ingestBrowserInbox()).toBe(2);
    expect(l.balance).toBe(2);
    expect(storage.getItem(INBOX_STORAGE_KEY)).toBeNull(); // consumed
    expect(l.ingestBrowserInbox()).toBe(0); // empty now
  });

  it('consumes a cumulative totalCredits feed once per high-water mark, per channel', () => {
    const l = mkLedger();
    expect(l.ingestTotalCounter(2, 'webroot')).toBe(2);
    expect(l.ingestTotalCounter(2, 'webroot')).toBe(0); // repeated total — nothing new
    expect(l.ingestTotalCounter(1.5, 'webroot')).toBe(0); // shrinking total — refused
    expect(l.ingestTotalCounter(3.5, 'webroot')).toBe(1.5); // growth delivers the delta
    expect(l.ingestTotalCounter(1, 'other-feed')).toBe(1); // channels are independent
    expect(l.balance).toBe(4.5);

    // High-water marks persist: a reloaded ledger ignores the same totals.
    const reloaded = mkLedger();
    expect(reloaded.ingestTotalCounter(3.5, 'webroot')).toBe(0);
    expect(reloaded.ingestTotalCounter(4, 'webroot')).toBe(0.5);
  });

  it('a grants array is authoritative — a redundant totalCredits summary is never double-counted', () => {
    const l = mkLedger();
    const payload = {
      version: 1,
      note: 'unrelated metadata the app never reads',
      grants: [{ id: 'g-1', credits: 1 }],
      totalCredits: 1, // ledger-style writers emit the summary alongside the array
    };
    expect(l.ingestInboxPayload(payload, 'webroot')).toBe(1);
    expect(l.ingestInboxPayload(payload, 'webroot')).toBe(0); // full re-delivery no-ops
    expect(l.balance).toBe(1);
    // Without a grants array, totalCredits IS consumed (through the channel high-water mark).
    expect(l.ingestInboxPayload({ totalCredits: 2 }, 'webroot')).toBe(2);
    expect(l.balance).toBe(3);
  });

  it('ingests an append-only external ledger: amount/unit spelling, extra fields, exactly-once growth', () => {
    const l = mkLedger();
    // The shape an external ledger-style writer emits: full history on every rewrite, amounts
    // under `amount` with a credit unit, plus metadata fields the app must ignore.
    const entry = (n: number) => ({
      id: `ext-${n}`,
      amount: 1,
      unit: 'power_generation_credit',
      reason: `external.provider.milestone${n}`,
      grantedAt: '2026-07-05T05:20:56Z',
      counter: n * 5,
    });
    const doc = (n: number) => ({
      version: 1,
      source: 'external-provider',
      target: 'some-store-label',
      totalCredits: n,
      grants: Array.from({ length: n }, (_, i) => entry(i + 1)),
    });

    expect(l.ingestInboxPayload(doc(1), 'webroot')).toBe(1); // first grant
    expect(l.ingestInboxPayload(doc(1), 'webroot')).toBe(0); // unchanged re-read
    expect(l.ingestInboxPayload(doc(3), 'webroot')).toBe(2); // ledger grew — only the new ids apply
    expect(l.balance).toBe(3);

    // A reloaded ledger (fresh app start) re-reads the same full history without re-granting.
    const reloaded = mkLedger();
    expect(reloaded.ingestInboxPayload(doc(3), 'webroot')).toBe(0);
  });

  it('accepts credits/amount spellings, prefers credits, and skips non-credit units', () => {
    const l = mkLedger();
    const paid = l.ingestInboxPayload({
      grants: [
        { id: 'sp-1', amount: 2 }, // amount spelling, no unit
        { id: 'sp-2', credits: 1, amount: 9 }, // both present — credits wins
        { id: 'sp-3', amount: 5, unit: 'watts' }, // wrong unit — not for this ledger
        { id: 'sp-4', unit: 'credit' }, // no value at all
      ],
    });
    expect(paid).toBe(3);
    expect(l.balance).toBe(3);
  });

  it('grantPowerCredits() and the window global feed the shared ledger', () => {
    const shared = new PowerCreditLedger();
    _setSharedLedgerForTests(shared);
    expect(grantPowerCredits(2)).toBe(2);

    const win: Record<string, unknown> = {};
    vi.stubGlobal('window', win);
    installCreditGrantGlobal();
    const hook = win['winforgeGrantPowerCredits'] as (n: number, id?: string) => number;
    expect(typeof hook).toBe('function');
    expect(hook(1.5, 'ext-1')).toBe(3.5);
    expect(hook(1.5, 'ext-1')).toBe(3.5); // idempotent id via the global too
    expect(shared.balance).toBe(3.5);
  });
});

describe("mode 'grid' — credit-powered grid", () => {
  it('supplies rated power and drains 1 credit per simulated hour while the reactor is off', () => {
    const l = mkLedger();
    l.grant(2);
    // 30 sim-minutes in 60 ticks of 30 s
    let mw = 0;
    for (let i = 0; i < 60; i++) mw = tickCreditGridSupply(l, 30, ReactorMode.Shutdown);
    expect(mw).toBe(CREDIT_GRID_SUPPLY_MW);
    expect(l.balance).toBeCloseTo(1.5, 9);
  });

  it('supplies nothing while the reactor is producing normally (Startup/Run)', () => {
    const l = mkLedger();
    l.grant(1);
    expect(tickCreditGridSupply(l, 60, ReactorMode.Run)).toBe(0);
    expect(tickCreditGridSupply(l, 60, ReactorMode.Startup)).toBe(0);
    expect(l.balance).toBe(1); // untouched
  });

  it("supplies nothing when the selected mode is 'autostart'", () => {
    const l = mkLedger();
    l.grant(1);
    l.setMode('autostart');
    expect(tickCreditGridSupply(l, 60, ReactorMode.Shutdown)).toBe(0);
    expect(l.balance).toBe(1);
  });

  it('scales the final partial tick and then stops — exhausted credits mean a dark grid', () => {
    const l = mkLedger();
    l.grant(30 / CREDIT_SIM_SECONDS); // exactly 30 sim-seconds of supply left
    const mw = tickCreditGridSupply(l, 60, ReactorMode.Tripped); // ask for 60 s, only 30 covered
    expect(mw).toBeCloseTo(CREDIT_GRID_SUPPLY_MW / 2, 6);
    expect(l.balance).toBe(0);
    expect(tickCreditGridSupply(l, 60, ReactorMode.Tripped)).toBe(0);
  });
});

describe("mode 'autostart' — 1 credit = exactly 1 assisted reactor hour", () => {
  const armed = () => {
    const l = mkLedger();
    l.grant(2);
    l.setMode('autostart');
    const sim = new ReactorSim();
    return { l, sim };
  };

  it('spends exactly 1 whole credit and brings the reactor to a hot critical run', () => {
    const { l, sim } = armed();
    expect(redeemAutoStart(l, sim)).toBe(true);
    expect(l.balance).toBe(1);
    expect(l.autoRunRemainingS).toBe(CREDIT_SIM_SECONDS);
    expect(sim.mode).toBe(ReactorMode.Run);
    expect(sim.autoStartMode).toBe(true);
    expect(sim.neutronPowerFraction).toBeGreaterThan(0);
  });

  it('is refused with less than 1 credit, in grid mode, without fuel, or while already running', () => {
    const { l, sim } = armed();
    l.drain(1.5); // 0.5 left
    expect(redeemAutoStart(l, sim)).toBe(false);

    const short = new PowerCreditLedger(); // fresh, unpersisted: balance 0, mode 'grid'
    short.grant(2);
    expect(redeemAutoStart(short, sim)).toBe(false); // mode is 'grid'

    short.setMode('autostart');
    sim.fuelAvailable = false;
    expect(redeemAutoStart(short, sim)).toBe(false); // fuel gate
    sim.fuelAvailable = true;
    expect(redeemAutoStart(short, sim)).toBe(true);
    expect(redeemAutoStart(short, sim)).toBe(false); // hour already in flight
    expect(short.balance).toBe(1); // only the first redemption charged
  });

  it('shuts the reactor down on its own after exactly one simulated hour', () => {
    const { l, sim } = armed();
    redeemAutoStart(l, sim);

    let expired = 0;
    let elapsed = 0;
    const dt = 7.3; // deliberately not a divisor of 3600
    while (elapsed < CREDIT_SIM_SECONDS + 100) {
      const status = tickAutoRun(l, sim, dt);
      elapsed += dt;
      if (status === 'expired') {
        expired++;
        expect(elapsed).toBeGreaterThanOrEqual(CREDIT_SIM_SECONDS);
        expect(elapsed).toBeLessThan(CREDIT_SIM_SECONDS + 2 * dt);
      }
    }
    expect(expired).toBe(1); // fires exactly once
    expect(sim.mode).toBe(ReactorMode.Shutdown);
    expect(sim.autoStartMode).toBe(false);
    expect(sim.rodBankInsertion.every((b) => b === 100)).toBe(true);
    expect(l.balance).toBe(1); // the second credit was never touched
    expect(tickAutoRun(l, sim, dt)).toBe('idle');
  });

  it('applies the assisted-run fuel penalty (2.5×, stacking with easy mode) only while active', () => {
    const sim = new ReactorSim();
    expect(sim.fuelConsumptionMultiplier).toBe(1);
    sim.autoStartMode = true;
    expect(sim.fuelConsumptionMultiplier).toBe(2.5);
    sim.easyStartupMode = true;
    expect(sim.fuelConsumptionMultiplier).toBeCloseTo(1.75 * 2.5, 9);
    sim.autoStartMode = false;
    expect(sim.fuelConsumptionMultiplier).toBe(1.75);
  });
});
