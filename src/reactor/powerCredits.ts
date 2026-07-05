// 發電額度 · Power-generation credits — a framework-free, persisted credit ledger plus the two
// redemption controllers that let stored credits stand in for the reactor's electrical output.
//
// A CREDIT is an abstract unit of pre-paid generation awarded by EXTERNAL systems (this app has
// no knowledge of how credits are earned — see "External grant entrypoints" below). Exactly one
// definition, used by both redemption modes:
//
//     1 credit = 1 hour of SIMULATED operation (3600 sim-seconds)
//               = 1 hour of full rated grid supply (RatedElectricMW · 1 h ≈ 1,150 MWh) in grid mode
//               = 1 hour of automatic reactor run-time in auto-start mode
//
// Redemption modes (selectable; persisted; default = DEFAULT_CREDIT_MODE):
//   • 'grid'      — credit-powered grid. While the reactor is OFF (Shutdown / Tripped / Meltdown)
//                   the grid is fed at full rated output directly from the credit balance, draining
//                   1 credit per simulated hour (fractional drain per tick). When the balance hits
//                   zero the credit supply stops and the grid goes dark unless the reactor is
//                   started normally.
//   • 'autostart' — spend exactly 1 whole credit to auto-start the reactor for exactly 1 simulated
//                   hour, after which it shuts itself down (rods in, mode Shutdown). Mirrors the
//                   C# engine's assisted auto-start: automatic SCRAMs are suppressed and the
//                   AutoStartFuelWasteFactor (2.5×) fuel penalty applies for the paid hour.
//
// ---------------------------------------------------------------------------------------------
// PERSISTED STORE (survives restarts; browser + Tauri webview share this):
//   localStorage key  `winforge.powerCredits.v1`
//   value             JSON — {
//                       "version": 1,
//                       "balance": <number ≥ 0, fractional>,
//                       "mode": "grid" | "autostart",
//                       "autoRunRemainingS": <number ≥ 0>,   // in-flight auto-start hour
//                       "appliedGrantIds": ["<id>", ...]      // idempotency ledger (capped)
//                     }
//
// EXTERNAL GRANT ENTRYPOINTS (how an outside process awards credits — all generic, no coupling):
//   1. `grantPowerCredits(n, id?)` — exported from this module; also installed on the page as
//      `window.winforgeGrantPowerCredits(n, id?)` so any script context with access to the app
//      window can award credits directly.
//   2. Browser inbox — write the localStorage key `winforge.powerCredits.inbox.v1` (same origin):
//        { "grants": [ { "id": "<unique-string>", "credits": <positive number> } ] }
//      The app ingests it on load, on every storage event (cross-tab), and each sim tick. Each
//      grant id is applied at most once, so re-writing the same inbox is harmless.
//   3. Desktop inbox file (Tauri app) — write the SAME JSON shape to
//        %LOCALAPPDATA%\WinForge\power-credits\inbox.json
//      The app polls the file every few seconds, atomically claims it (rename), applies every
//      grant id it has not seen before, and deletes it. Writers simply create/overwrite the file;
//      the id ledger makes double-delivery safe. See creditInboxDesktop.ts.
//   4. Web-root grants file — drop `power-credits.json` next to the served app (in this repo:
//      `public/power-credits.json`, git-ignored and machine-local; vite serves `public/` at `/`).
//      The app polls `/power-credits.json` read-only every few seconds (creditInboxWeb.ts).
//      Same `grants` array as above; unknown extra fields are ignored. Alternatively (or in
//      addition) the file may carry a cumulative `"totalCredits": <number>` — a monotonic
//      counter; the app grants the delta since the highest total it has already consumed, so
//      overwriting the file with a growing total also delivers exactly once.
//
// The ledger itself follows the FuelFactory pattern: plain class, injected persistence key,
// localStorage when present, silent in-memory fallback (tests / SSR), deterministic — no
// Date.now() anywhere; all time advances via the sim's dt.

import { ReactorMode, RatedElectricMW, type ReactorSim } from './physics';

export type CreditRedemptionMode = 'grid' | 'autostart';

/** Default redemption mode for a fresh install — change here to reconfigure the default. */
export const DEFAULT_CREDIT_MODE: CreditRedemptionMode = 'grid';

/** Simulated seconds covered by one credit (both modes). 1 credit = 1 h. */
export const CREDIT_SIM_SECONDS = 3600;

/** Grid supply while credit-powered (MWe): full rated output — 1 credit ≈ 1,150 MWh delivered. */
export const CREDIT_GRID_SUPPLY_MW = RatedElectricMW;

/** Idempotency ledger cap — oldest applied grant ids are dropped past this. */
const APPLIED_IDS_CAP = 500;

const STORAGE_KEY = 'winforge.powerCredits.v1';
/** Browser-side inbox key an external same-origin script/tab may write (format above). */
export const INBOX_STORAGE_KEY = 'winforge.powerCredits.inbox.v1';
/** Desktop inbox file (under %LOCALAPPDATA%), polled by the Tauri app (format above). */
export const DESKTOP_INBOX_RELPATH = 'WinForge\\power-credits\\inbox.json';

interface PersistShape {
  version: 1;
  balance: number;
  mode: CreditRedemptionMode;
  autoRunRemainingS: number;
  appliedGrantIds: string[];
  /** Per-channel high-water marks for cumulative `totalCredits`-style feeds. */
  counters: Record<string, number>;
}

/** One entry of an inbox payload (browser key or desktop file). */
export interface CreditGrant {
  id: string;
  credits: number;
}

export interface CreditInboxPayload {
  grants?: CreditGrant[];
  /** Optional cumulative alternative to `grants`: a monotonic total; deltas are granted once. */
  totalCredits?: number;
}

const isMode = (v: unknown): v is CreditRedemptionMode => v === 'grid' || v === 'autostart';
const finitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function readStorage(key: string): PersistShape | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistShape>;
    return {
      version: 1,
      balance: finitePos(p.balance) ? p.balance : 0,
      mode: isMode(p.mode) ? p.mode : DEFAULT_CREDIT_MODE,
      autoRunRemainingS: finitePos(p.autoRunRemainingS) ? p.autoRunRemainingS : 0,
      appliedGrantIds: Array.isArray(p.appliedGrantIds)
        ? p.appliedGrantIds.filter((x): x is string => typeof x === 'string')
        : [],
      counters:
        typeof p.counters === 'object' && p.counters !== null && !Array.isArray(p.counters)
          ? Object.fromEntries(Object.entries(p.counters).filter(([, v]) => finitePos(v)))
          : {},
    };
  } catch {
    return null; // corrupt blob degrades to defaults, like every persisted store in the app
  }
}

/**
 * 額度帳簿 · The persisted credit ledger. All mutation goes through here; every mutation persists
 * and notifies subscribers, so React (and anything else) can mirror the balance live.
 */
export class PowerCreditLedger {
  private _balance = 0;
  private _mode: CreditRedemptionMode = DEFAULT_CREDIT_MODE;
  private _autoRunRemainingS = 0;
  private _appliedIds: string[] = [];
  private _counters: Record<string, number> = {};
  private readonly key: string;
  private readonly persistEnabled: boolean;
  private listeners = new Set<() => void>();

  constructor(opts?: { persist?: boolean; storageKey?: string }) {
    this.persistEnabled = opts?.persist ?? false;
    this.key = opts?.storageKey ?? STORAGE_KEY;
    const restored = this.persistEnabled ? readStorage(this.key) : null;
    if (restored) {
      this._balance = restored.balance;
      this._mode = restored.mode;
      this._autoRunRemainingS = restored.autoRunRemainingS;
      this._appliedIds = restored.appliedGrantIds;
      this._counters = restored.counters;
    }
  }

  // ------------------------------------------------------------------ persistence ----
  private persist(): void {
    if (!this.persistEnabled || typeof localStorage === 'undefined') return;
    try {
      const shape: PersistShape = {
        version: 1,
        balance: this._balance,
        mode: this._mode,
        autoRunRemainingS: this._autoRunRemainingS,
        appliedGrantIds: this._appliedIds.slice(-APPLIED_IDS_CAP),
        counters: this._counters,
      };
      localStorage.setItem(this.key, JSON.stringify(shape));
    } catch {
      /* quota / disabled storage — keep the in-memory value */
    }
  }

  private commit(): void {
    this.persist();
    this.listeners.forEach((cb) => cb());
  }

  /** Change notification (balance / mode / auto-run). Returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---------------------------------------------------------------------- balance ----
  get balance(): number {
    return this._balance;
  }

  /**
   * 授予額度 · Award credits. `id`, when given, is applied AT MOST ONCE (idempotent delivery for
   * the inbox paths). Non-finite / non-positive amounts are refused. Returns the new balance.
   */
  grant(credits: number, id?: string): number {
    if (!finitePos(credits)) return this._balance;
    if (id !== undefined) {
      if (this._appliedIds.includes(id)) return this._balance; // already delivered
      this._appliedIds.push(id);
      if (this._appliedIds.length > APPLIED_IDS_CAP) this._appliedIds = this._appliedIds.slice(-APPLIED_IDS_CAP);
    }
    this._balance += credits;
    this.commit();
    return this._balance;
  }

  /** Drain up to `credits` (fractional); clamps at zero. Returns what was actually drained. */
  drain(credits: number): number {
    if (!finitePos(credits) || this._balance <= 0) return 0;
    const used = Math.min(this._balance, credits);
    this._balance -= used;
    if (this._balance < 1e-12) this._balance = 0; // sweep float dust
    this.commit();
    return used;
  }

  // ------------------------------------------------------------------------ mode ----
  get mode(): CreditRedemptionMode {
    return this._mode;
  }
  setMode(m: CreditRedemptionMode): void {
    if (!isMode(m) || m === this._mode) return;
    this._mode = m;
    this.commit();
  }

  // ---------------------------------------------------------------- inbox ingest ----
  /**
   * 累計計數通道 · Consume a cumulative `totalCredits`-style feed: grant the delta above the
   * highest total already consumed on `channel` (per-channel high-water mark, persisted).
   * A shrinking or repeated total delivers nothing. Returns credits added.
   */
  ingestTotalCounter(total: number, channel: string): number {
    if (!finitePos(total) || !channel) return 0;
    const seen = this._counters[channel] ?? 0;
    if (total <= seen) return 0;
    this._counters[channel] = total; // commit happens inside grant()
    const delta = total - seen;
    this.grant(delta);
    return delta;
  }

  /**
   * Apply an inbox payload (inbox key / inbox file / web-root grants file — format documented at
   * the top). Each grant id is applied at most once ever; malformed entries are skipped; an
   * optional cumulative `totalCredits` is consumed through the channel high-water mark.
   * Returns credits added.
   */
  ingestInboxPayload(payload: unknown, channel = 'inbox'): number {
    if (typeof payload !== 'object' || payload === null) return 0;
    const { grants, totalCredits } = payload as CreditInboxPayload;
    let added = 0;
    if (Array.isArray(grants)) {
      for (const g of grants) {
        if (typeof g !== 'object' || g === null) continue;
        if (typeof g.id !== 'string' || g.id.length === 0 || !finitePos(g.credits)) continue;
        const before = this._balance;
        this.grant(g.credits, g.id);
        added += this._balance - before;
      }
    }
    if (typeof totalCredits === 'number') added += this.ingestTotalCounter(totalCredits, channel);
    return added;
  }

  /** Read + consume the browser inbox key (if present). Safe to call every tick. */
  ingestBrowserInbox(): number {
    try {
      if (typeof localStorage === 'undefined') return 0;
      const raw = localStorage.getItem(INBOX_STORAGE_KEY);
      if (!raw) return 0;
      const added = this.ingestInboxPayload(JSON.parse(raw) as unknown);
      localStorage.removeItem(INBOX_STORAGE_KEY); // consumed — ids guard against re-delivery
      return added;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------- auto-start hour ----
  get autoRunRemainingS(): number {
    return this._autoRunRemainingS;
  }
  get autoRunActive(): boolean {
    return this._autoRunRemainingS > 0;
  }

  /**
   * Spend exactly 1 whole credit and arm the 1-hour auto-run clock. Refused (false) when the
   * balance is short or an auto-run hour is already in flight.
   */
  beginAutoRun(): boolean {
    if (this._balance < 1 || this._autoRunRemainingS > 0) return false;
    this._balance -= 1;
    this._autoRunRemainingS = CREDIT_SIM_SECONDS;
    this.commit();
    return true;
  }

  /**
   * Advance the auto-run clock by dt sim-seconds. Returns 'expired' on the tick the hour ends
   * (exactly once), 'running' while in flight, 'idle' otherwise.
   */
  tickAutoRun(dtS: number): 'idle' | 'running' | 'expired' {
    if (this._autoRunRemainingS <= 0) return 'idle';
    if (!finitePos(dtS)) return 'running';
    this._autoRunRemainingS = Math.max(0, this._autoRunRemainingS - dtS);
    this.commit();
    return this._autoRunRemainingS === 0 ? 'expired' : 'running';
  }

  /** Test/inspection helper. */
  clearAll(): void {
    this._balance = 0;
    this._mode = DEFAULT_CREDIT_MODE;
    this._autoRunRemainingS = 0;
    this._appliedIds = [];
    this._counters = {};
    this.commit();
  }
}

// ------------------------------------------------------------------- shared singleton ----

let sharedLedger: PowerCreditLedger | null = null;

/** The app-wide persisted ledger (browser + Tauri webview). Lazily created. */
export function getPowerCreditLedger(): PowerCreditLedger {
  if (!sharedLedger) sharedLedger = new PowerCreditLedger({ persist: true });
  return sharedLedger;
}

/** Swap the singleton (tests only). */
export function _setSharedLedgerForTests(l: PowerCreditLedger | null): void {
  sharedLedger = l;
}

/**
 * 對外授予入口 · The generic public grant entrypoint: award `credits` to the shared ledger.
 * External callers that can reach this module (or the window global below) need to know nothing
 * else about the app. Optional `id` makes delivery idempotent.
 */
export function grantPowerCredits(credits: number, id?: string): number {
  return getPowerCreditLedger().grant(credits, id);
}

declare global {
  interface Window {
    /** Public grant hook for external scripts: window.winforgeGrantPowerCredits(n, id?). */
    winforgeGrantPowerCredits?: (credits: number, id?: string) => number;
  }
}

/** Install `window.winforgeGrantPowerCredits` (idempotent; no-op without a window). */
export function installCreditGrantGlobal(): void {
  if (typeof window === 'undefined') return;
  window.winforgeGrantPowerCredits = (credits: number, id?: string) => grantPowerCredits(credits, id);
}

// ------------------------------------------------------------- redemption controllers ----

/** True when the reactor itself is NOT supplying the grid (credit-grid mode may engage). */
export function reactorIsOff(mode: ReactorMode): boolean {
  return mode === ReactorMode.Shutdown || mode === ReactorMode.Tripped || mode === ReactorMode.Meltdown;
}

/**
 * 額度供電 · Mode-'grid' per-tick controller. When selected, the reactor is off and credits
 * remain, supply the grid at full rated output and drain the balance at 1 credit / sim-hour.
 * Returns the MWe the credit supply is delivering this tick (0 when inactive or exhausted).
 */
export function tickCreditGridSupply(ledger: PowerCreditLedger, dtS: number, reactorMode: ReactorMode): number {
  if (ledger.mode !== 'grid') return 0;
  if (!reactorIsOff(reactorMode)) return 0;
  if (!finitePos(dtS) || ledger.balance <= 0) return 0;
  const want = dtS / CREDIT_SIM_SECONDS; // credits this tick
  const got = ledger.drain(want);
  // Partial final tick: scale the delivered power so the last sliver of a credit still counts.
  return CREDIT_GRID_SUPPLY_MW * (got >= want ? 1 : got / want);
}

/**
 * 自動啟動兌換 · Mode-'autostart' redemption: spend 1 credit, put the engine in its assisted
 * auto-start state (SCRAM suppression + 2.5× fuel penalty, per the C# engine) and bring it to a
 * hot critical run. Returns false (and changes nothing) when the credit, fuel, or plant state
 * does not allow it.
 */
export function redeemAutoStart(ledger: PowerCreditLedger, sim: ReactorSim): boolean {
  if (ledger.mode !== 'autostart') return false;
  if (sim.mode === ReactorMode.Meltdown || !sim.fuelAvailable) return false;
  if (!ledger.beginAutoRun()) return false;
  sim.autoStartMode = true;
  sim.warmStartCritical();
  return true;
}

/**
 * Advance the paid auto-run hour. On expiry the reactor shuts itself down: assist off, all rods
 * driven in, mode Shutdown. Returns the clock status for UI/tests.
 */
export function tickAutoRun(ledger: PowerCreditLedger, sim: ReactorSim, dtS: number): 'idle' | 'running' | 'expired' {
  const status = ledger.tickAutoRun(dtS);
  if (status === 'expired') {
    sim.autoStartMode = false;
    sim.setAllRods(100);
    sim.setMode(ReactorMode.Shutdown);
  }
  return status;
}
