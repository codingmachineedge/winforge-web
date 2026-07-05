// 控制棒程序 · Westinghouse rod-bank overlap program + speed-limited RCCA drive + Tavg/Tref
// automatic rod control.
//
// A pure, deterministic, framework-free TypeScript port of the rod-control slice of WinForge's C#
// `ReactorSimService` (Services/ReactorSimService.cs):
//
//   • Bank geometry / sequencing (source L305–320): four control banks of 228 steps each, withdrawn
//     in sequence A→B→C→D with a 128-step overlap → stride 100, group-demand span 4·228 − 3·128 = 528.
//   • `InferRodDemandFromBanks` (source L2164–2175): reconstruct the demand counter from an arbitrary
//     bank stack so the program takes over bumplessly from manual positioning / after a scram.
//   • `ApplyOverlapToBanks` (source L5352–5360): map the group-demand counter to per-bank insertion %.
//   • `UpdateAutoRods` (source L5315–5350): the Westinghouse Tavg/Tref automatic controller
//     (NRC Tech Manual §8.1, ML11223A252) — Tref programmed linearly from turbine load, ±1.5 °F
//     deadband, 8 spm lockup/minimum, 57.6 spm/°C proportional ramp to the 72 spm drive limit, plus
//     the power-mismatch anticipatory term (3 °C per unit load−power mismatch).
//   • The speed-limited manual drive mirrors the uncontrolled-RCCA-withdrawal driver (source
//     L3405–3424): the demand counter accumulates as a double at (spm/60)·dt, carrying the
//     fractional-step remainder across ticks — position never jumps.
//
// This class NEVER mutates the reactor sim. The integrator reads {@link RodControlOutputs} each tick
// and assigns `bankInsertionPct` to `sim.rodBankInsertion` ONLY while `engaged` is true and the
// reactor is not scrammed / rods not dropping (the scram rod-drop dynamics own the banks then).
//
// C# behavioural quirks kept deliberately:
//   • The anticipatory mismatch is `load − power` ADDED to the temperature error with the "too hot →
//     insert" direction rule — ported sign-exact from source L5334–5347.
//   • A scram forces the controller OFF (C# `Scram()` sets `AutoRodControl = false`, source L2186);
//     the operator must re-engage AUTO, and on release the demand counter is re-inferred from the
//     actual (fully-seated) banks.
//   • Rod WITHDRAWAL is blocked with no valid fuel in the core; insertion is always allowed —
//     mirrors the physics.ts fuel gate (`setRodBank`).

import { _clamp } from './physics';

// ----------------------------------------------------------------- constants ----
// Westinghouse rod-control geometry / sequencing. Each control bank spans 228 steps (0 = fully
// inserted, 228 = fully withdrawn); banks withdraw A→B→C→D with a 128-step overlap.
export const RodStepsPerBank = 228; // source L311
export const RodOverlap = 128; // source L312
export const RodStride = RodStepsPerBank - RodOverlap; // 100 — source L313
export const RodTotalSpan = 4 * RodStepsPerBank - 3 * RodOverlap; // 528 — source L314
const BankCount = 4;

// Westinghouse automatic rod-control: Tavg/Tref program (NRC Tech Manual §8.1, ML11223A252).
// Tref is linear in turbine load between a no-load and a full-load endpoint; the canonical span is
// 557→584.7 °F = 15.4 °C, anchored at the plant's 305 °C full-load datum.
export const NoLoadTavg = 289.6; // °C — 0 % load Tref endpoint (305 − 15.4 span) — source L345
export const FullLoadTavg = 305.0; // °C — 100 % load Tref endpoint (= NominalTavg) — source L346
// Temperature-error deadband: ±1.5 °F held about Tref. This is a ΔT-span conversion (1.5/1.8),
// not an absolute-temperature conversion → ±0.833 °C. No rod motion inside.
export const RodDeadbandC = 0.833; // °C — source L349
export const RodRampStartC = 1.667; // °C — 3 °F, end of min-speed / start of proportional ramp — source L350
export const RodRampEndC = 2.778; // °C — 5 °F, max-speed error — source L351
export const RodSpeedMinSpm = 8.0; // steps/min — lockup/minimum — source L352
export const RodSpeedMaxSpm = 72.0; // steps/min — maximum (drive-mechanism limit) — source L353
// Proportional-region slope: (72−8)/(2.778−1.667) = 57.6 spm per °C.
export const RodSpeedSlopeSpm = 57.6; // steps/min per °C — source L355
// Power-mismatch anticipatory gain: equivalent °C per unit (turbine load − nuclear power). A full
// 100 % load/power mismatch reads as 3 °C of error (max speed). Self-decays as power re-tracks load.
export const PowerMismatchGainC = 3.0; // °C per unit mismatch — source L359

// Re-sync tolerance: if the ACTUAL banks depart from the program's overlap mapping by more than
// this many steps on any bank while the program is idle, an external actor (legacy setAllRods
// slider, scram seating) owns positioning — re-infer the demand counter from the real stack.
const ResyncToleranceSteps = 0.5;

export type RodControlMode = 'manual' | 'auto';
export type RodDirection = -1 | 0 | 1;

// ----------------------------------------------------------------- interfaces ----
/** Inputs read from the reactor sim each tick (plain numbers/booleans — never the sim itself). */
export interface RodControlInputs {
  /** Coolant average temperature, °C ← sim.tavg. */
  tavgC: number;
  /**
   * Turbine load fraction 0..1 — the Tref program input. The C# controller uses the turbine
   * first-stage (impulse) pressure as the load proxy (source L5324); until the TS turbine module
   * exists the integrator should feed the best available load signal (e.g. electric power / rated,
   * or 0 with the generator off-line). Tref is programmed from TURBINE LOAD, not reactor power.
   */
  turbineLoadFrac: number;
  /** Reactor tripped ← sim.isScrammed. Freezes the program; C# also drops AUTO (source L2186). */
  scrammed: boolean;
  /** Gravity rod-drop in progress ← sim.rodsDropping. The drop dynamics own the banks. */
  rodsDropping: boolean;
  /** Fuel gate ← sim.fuelAvailable. Withdrawal blocked without fuel; insertion always allowed. */
  fuelAvailable: boolean;
  /**
   * Actual per-bank insertion % (A,B,C,D) ← [...sim.rodBankInsertion]. Used to re-sync the demand
   * counter (InferRodDemandFromBanks) after a scram or after the legacy setAllRods slider moved
   * the banks directly.
   */
  currentBankInsertionPct: number[];
  /**
   * Nuclear power fraction 0..1 ← sim.neutronPowerFraction — feeds the anticipatory power-mismatch
   * term (source L5334). OPTIONAL coupling: when omitted it defaults to `turbineLoadFrac`, making
   * the mismatch zero and the controller purely Tavg/Tref-driven (safe degraded behaviour).
   */
  neutronPowerFraction?: number;
}

/** Effects the integrator applies back to the sim after each tick. */
export interface RodControlOutputs {
  /**
   * Per-bank insertion % (A,B,C,D) — the overlap-program mapping of the demand counter. Assign to
   * sim.rodBankInsertion ONLY when `engaged` is true and the reactor is not scrammed / dropping.
   */
  bankInsertionPct: number[];
  /** Group-demand counter, 0..528 steps. */
  demandSteps: number;
  /** True when the demand counter moved this tick. */
  moving: boolean;
  /** Direction of rod motion this tick: −1 stepping in, 0 holding, +1 stepping out. */
  autoDirection: RodDirection;
  /** Load-programmed reference temperature Tref, °C. */
  trefC: number;
  /** Tavg − Tref, °C (positive = too hot). */
  tavgTrefErrorC: number;
  /** Rod withdrawal currently blocked (fuel gate / trip). */
  withdrawBlocked: boolean;
  withdrawBlockedReasonEn: string;
  withdrawBlockedReasonZh: string;
  /** Signed speed demand telemetry, steps/min (+ = withdraw) — C# RodSpeedDemandSpm (source L1003). */
  rodSpeedDemandSpm: number;
  /**
   * True while the program owns bank positioning: AUTO mode, or MANUAL with an active jog /
   * slewing demand target. False in MANUAL-hold so the legacy per-bank controls still work.
   */
  engaged: boolean;
}

/** Plain JSON-serializable display snapshot for the panel. */
export interface RodControlView {
  mode: RodControlMode;
  demandSteps: number; // 0..528
  demandTargetSteps: number | null; // active slew target, null when none
  manualSpm: number; // commanded manual drive speed, 8..72 steps/min
  manualDirection: RodDirection; // commanded jog: −1 in / 0 hold / +1 out
  bankInsertionPct: number[]; // % inserted (A,B,C,D)
  bankStepsWithdrawn: number[]; // 0..228 per bank (rod-position indication)
  trefC: number;
  tavgTrefErrorC: number;
  inDeadband: boolean; // |combined error| ≤ ±0.833 °C — no auto rod motion
  rodSpeedDemandSpm: number; // signed, + = withdraw
  moving: boolean;
  motionDirection: RodDirection; // −1 stepping in / 0 holding / +1 stepping out
  withdrawBlocked: boolean;
  withdrawBlockedReasonEn: string;
  withdrawBlockedReasonZh: string;
  engaged: boolean;
  statusEn: string;
  statusZh: string;
}

// ----------------------------------------------------------------- helpers ----
/**
 * Map the group-demand counter to per-bank insertion %. Bank k begins withdrawing at k·stride and
 * is fully out after a further 228 steps; the 128-step overlap means two banks move together.
 * Port of ApplyOverlapToBanks (source L5352–5360).
 */
export function applyOverlapToBanks(counter: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < BankCount; k++) {
    const stepsWithdrawn = _clamp(counter - k * RodStride, 0.0, RodStepsPerBank);
    out.push((1.0 - stepsWithdrawn / RodStepsPerBank) * 100.0);
  }
  return out;
}

/**
 * Reconstruct the demand counter from the present bank stack. Port of InferRodDemandFromBanks
 * (source L2164–2175): walk A→D; the last contributing bank sets the counter; a partial bank is
 * the lead bank and terminates the walk. Exact for overlap-programmed stacks, and gives the C#'s
 * own take-over point for arbitrary (e.g. all-banks-equal legacy slider) stacks.
 */
export function inferRodDemandFromBanks(bankInsertionPct: readonly number[]): number {
  let c = 0;
  for (let k = 0; k < BankCount; k++) {
    const ins = bankInsertionPct[k] ?? 100.0;
    const w = (1.0 - ins / 100.0) * RodStepsPerBank;
    if (w <= 0.0) break;
    c = k * RodStride + w; // last contributing bank sets the counter
    if (w < RodStepsPerBank) break; // partial bank = the lead bank
  }
  return _clamp(c, 0, RodTotalSpan);
}

/** Clamp an actual-bank snapshot to 4 sane insertion percentages (missing/NaN → fully inserted). */
function sanitizeBanks(banks: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < BankCount; k++) {
    const b = banks[k];
    out.push(_clamp(b !== undefined && Number.isFinite(b) ? b : 100.0, 0.0, 100.0));
  }
  return out;
}

// Bilingual withdraw-block reasons (dynamic physics strings live here, not in the i18n slice).
const BlockNone = { en: '', zh: '' };
// Mirrors the physics.ts / C# fuel-gate wording (source L6233 gate; note text L537–539 in physics.ts).
const BlockNoFuel = {
  en: 'Rod withdrawal blocked — no valid fuel in the core.',
  zh: '提棒被封鎖 — 堆芯冇有效燃料。',
};
const BlockTripped = {
  en: 'Rod motion blocked — reactor trip in progress.',
  zh: '控制棒動作被封鎖 — 反應堆跳堆中。',
};

// ----------------------------------------------------------------- controller ----
/**
 * 棒控制器 · RodController — owns the group-demand counter (0..528 steps), the MANUAL/AUTO mode,
 * the commanded manual direction/speed, and the Tref/error telemetry. Deterministic; all timing
 * comes in as simulated dt seconds.
 */
export class RodController {
  // ---- owned state ----
  private _demand = 0.0; // group-demand counter, 0..528 (all rods in) — accumulates as a double
  private _mode: RodControlMode = 'manual';
  private _manualDir: RodDirection = 0; // commanded jog: −1 in / 0 hold / +1 out
  private _manualSpm = RodSpeedMaxSpm; // commanded drive speed; C# _rccaWithdrawSpm default (source L966)
  private _target: number | null = null; // setDemandTarget slew target (steps), null = none
  private _autoWasOn = false; // bumpless-transfer latch — C# _autoRodWasOn (source L5313)
  private _wasFrozen = false; // scram/drop freeze latch → re-infer demand on release

  // ---- telemetry (latest step) ----
  private _trefC = NoLoadTavg;
  private _errC = 0;
  private _combinedErrC = 0;
  private _speedDemandSpm = 0; // signed, + = withdraw
  private _moving = false;
  private _motionDir: RodDirection = 0;
  private _block = BlockNone;
  private _engaged = false;
  private _banks: number[] = applyOverlapToBanks(0); // overlap mapping of the demand counter (outputs)
  private _viewBanks: number[] = applyOverlapToBanks(0); // panel readout: actual banks when disengaged

  // ------------------------------------------------------------- controls ----
  /** MANUAL ⇄ AUTO selector. Entering AUTO arms the bumpless demand-counter sync (source L5318). */
  setControlMode(m: RodControlMode): void {
    if (m === this._mode) return;
    this._mode = m;
    if (m === 'auto') {
      this._autoWasOn = false; // next step re-infers demand from the actual banks — bumpless
      this._manualDir = 0;
      this._target = null;
    } else {
      this._manualDir = 0;
      this._target = null;
    }
  }

  /**
   * Manual in/hold/out jog at the commanded speed (steps/min, clamped to the 8–72 drive program).
   * Ignored in AUTO — the C# UI locks the manual rod switches out while AutoRodControl is on.
   */
  driveRods(direction: RodDirection, spm?: number): void {
    if (spm !== undefined && Number.isFinite(spm)) this._manualSpm = _clamp(spm, RodSpeedMinSpm, RodSpeedMaxSpm);
    if (this._mode !== 'manual') return;
    this._manualDir = direction;
    if (direction !== 0) this._target = null; // a live jog overrides a pending slew target
  }

  /**
   * Slew the demand counter to an absolute target (0..528 steps) at the commanded manual speed —
   * never jumps; the counter integrates at (spm/60)·dt exactly like the C# drivers. MANUAL only.
   */
  setDemandTarget(steps: number): void {
    if (this._mode !== 'manual' || !Number.isFinite(steps)) return;
    this._target = _clamp(steps, 0, RodTotalSpan);
    this._manualDir = 0;
  }

  reset(): void {
    this._demand = 0.0;
    this._mode = 'manual';
    this._manualDir = 0;
    this._manualSpm = RodSpeedMaxSpm;
    this._target = null;
    this._autoWasOn = false;
    this._wasFrozen = false;
    this._trefC = NoLoadTavg;
    this._errC = 0;
    this._combinedErrC = 0;
    this._speedDemandSpm = 0;
    this._moving = false;
    this._motionDir = 0;
    this._block = BlockNone;
    this._engaged = false;
    this._banks = applyOverlapToBanks(0);
    this._viewBanks = applyOverlapToBanks(0);
  }

  // ------------------------------------------------------------- main step ----
  step(inp: RodControlInputs, dt: number): RodControlOutputs {
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const load = _clamp(Number.isFinite(inp.turbineLoadFrac) ? inp.turbineLoadFrac : 0, 0.0, 1.0);
    const tavg = Number.isFinite(inp.tavgC) ? inp.tavgC : NoLoadTavg;
    // Optional coupling: with no nuclear-power signal the mismatch defaults to zero (power = load).
    const power =
      inp.neutronPowerFraction !== undefined && Number.isFinite(inp.neutronPowerFraction)
        ? inp.neutronPowerFraction
        : load;

    // --- Tref program + error telemetry — always live, even tripped (source L5324–5326) ---
    this._trefC = NoLoadTavg + (FullLoadTavg - NoLoadTavg) * load; // linear Tref program
    this._errC = tavg - this._trefC; // °C, + = too hot
    // Anticipatory power mismatch: turbine load minus nuclear power as an equivalent-temperature
    // signal; sign-exact port of source L5334–5336 (a kept behavioural quirk — see header).
    const mismatch = load - power; // −1..1
    this._combinedErrC = this._errC + PowerMismatchGainC * mismatch;

    const frozen = inp.scrammed || inp.rodsDropping;
    if (frozen) {
      // Scram / rod drop: the trip owns the banks. C# Scram() also forces AutoRodControl off
      // (source L2186) — drop to MANUAL-hold; the operator must re-engage AUTO after recovery.
      if (this._mode === 'auto') this._mode = 'manual';
      this._manualDir = 0;
      this._target = null;
      this._autoWasOn = false;
      this._wasFrozen = true;
      this._speedDemandSpm = 0;
      this._moving = false;
      this._motionDir = 0;
      this._block = BlockTripped;
      this._engaged = false;
      // Demand counter frozen (NOT reset — post-trip rod telemetry stays honest, source L3411).
      this._banks = applyOverlapToBanks(this._demand);
      this._viewBanks = sanitizeBanks(inp.currentBankInsertionPct); // show the real dropping rods
      return this.buildOutputs();
    }

    // --- release / external-motion re-sync (InferRodDemandFromBanks) ---
    if (this._wasFrozen) {
      // First step after the trip clears: take over from the actual (seated) bank stack.
      this._demand = inferRodDemandFromBanks(inp.currentBankInsertionPct);
      this._wasFrozen = false;
    } else if (this._mode === 'auto' && !this._autoWasOn) {
      // On engaging AUTO, sync the group-demand counter to the current bank stack — bumpless
      // transfer (source L5317–5318).
      this._demand = inferRodDemandFromBanks(inp.currentBankInsertionPct);
    } else if (this._mode === 'manual' && this._manualDir === 0 && this._target === null) {
      // MANUAL-hold: the program is disengaged; if the legacy setAllRods slider (or anything
      // else) moved the banks, track it so the next jog starts from the true position.
      const mapped = applyOverlapToBanks(this._demand);
      let maxDevSteps = 0;
      for (let k = 0; k < BankCount; k++) {
        const dev = Math.abs((mapped[k]! - (inp.currentBankInsertionPct[k] ?? mapped[k]!)) / 100.0) * RodStepsPerBank;
        if (dev > maxDevSteps) maxDevSteps = dev;
      }
      if (maxDevSteps > ResyncToleranceSteps) this._demand = inferRodDemandFromBanks(inp.currentBankInsertionPct);
    }
    this._autoWasOn = this._mode === 'auto';

    // --- commanded motion for this tick: direction + speed (steps/min) ---
    let dir: RodDirection = 0;
    let speedSpm = 0;
    if (this._mode === 'auto') {
      // Variable-speed program: deadband → 8 spm (min/lockup) → linear ramp → 72 spm (max)
      // (source L5338–5344).
      const e = Math.abs(this._combinedErrC);
      if (e <= RodDeadbandC) speedSpm = 0.0;
      else if (e <= RodRampStartC) speedSpm = RodSpeedMinSpm;
      else speedSpm = _clamp(RodSpeedMinSpm + RodSpeedSlopeSpm * (e - RodRampStartC), RodSpeedMinSpm, RodSpeedMaxSpm);
      // Direction: too hot (combinedError>0) → insert rods → lower the counter; too cold →
      // withdraw (source L5346–5347).
      if (speedSpm > 0) dir = this._combinedErrC > 0 ? -1 : 1;
    } else if (this._target !== null) {
      const gap = this._target - this._demand;
      if (Math.abs(gap) > 1e-9) {
        dir = gap > 0 ? 1 : -1;
        speedSpm = this._manualSpm;
      } else {
        this._target = null; // target reached — hold
      }
    } else if (this._manualDir !== 0) {
      dir = this._manualDir;
      speedSpm = this._manualSpm;
    }

    // --- fuel gate: withdrawal blocked without fuel; insertion always allowed (physics.ts gate) ---
    let blocked = false;
    if (dir > 0 && !inp.fuelAvailable) {
      blocked = true;
      dir = 0;
      speedSpm = 0;
    }
    this._block = blocked ? BlockNoFuel : BlockNone;

    // --- integrate the group-demand counter as a double, carrying the fractional-step remainder
    //     across ticks (source L5348, L3418); slew targets clamp AT the target — never overshoot ---
    const before = this._demand;
    if (dir !== 0 && speedSpm > 0 && h > 0) {
      let next = this._demand + dir * (speedSpm / 60.0) * h;
      if (this._mode === 'manual' && this._target !== null) {
        if (dir > 0 && next >= this._target) next = this._target;
        if (dir < 0 && next <= this._target) next = this._target;
        if (next === this._target) this._target = null;
      }
      this._demand = _clamp(next, 0, RodTotalSpan);
    }
    const moved = this._demand !== before;

    this._speedDemandSpm = dir * speedSpm; // signed telemetry (+ = withdraw) — C# RodSpeedDemandSpm
    this._moving = moved;
    this._motionDir = moved ? dir : 0;
    this._engaged = this._mode === 'auto' || this._target !== null || this._manualDir !== 0 || moved;
    this._banks = applyOverlapToBanks(this._demand);
    // Panel readout: the program's mapping while it owns the banks, the real stack when idle.
    this._viewBanks = this._engaged ? [...this._banks] : sanitizeBanks(inp.currentBankInsertionPct);
    return this.buildOutputs();
  }

  private buildOutputs(): RodControlOutputs {
    return {
      bankInsertionPct: [...this._banks],
      demandSteps: this._demand,
      moving: this._moving,
      autoDirection: this._motionDir,
      trefC: this._trefC,
      tavgTrefErrorC: this._errC,
      withdrawBlocked: this._block !== BlockNone,
      withdrawBlockedReasonEn: this._block.en,
      withdrawBlockedReasonZh: this._block.zh,
      rodSpeedDemandSpm: this._speedDemandSpm,
      engaged: this._engaged,
    };
  }

  // ------------------------------------------------------------- view ----
  view(): RodControlView {
    const stepsWithdrawn = this._viewBanks.map((ins) => Math.round((1.0 - ins / 100.0) * RodStepsPerBank));
    const inDeadband = Math.abs(this._combinedErrC) <= RodDeadbandC;
    // Bilingual dynamic status line (operator-facing; En/Zh pair like physics.ts alarms).
    let statusEn: string;
    let statusZh: string;
    const modeEn = this._mode === 'auto' ? 'AUTO' : 'MANUAL';
    const modeZh = this._mode === 'auto' ? '自動' : '手動';
    if (this._block === BlockTripped) {
      statusEn = 'Reactor trip — rods released to gravity insertion.';
      statusZh = '反應堆跳堆 — 控制棒已釋放，重力插入。';
    } else if (this._block === BlockNoFuel) {
      statusEn = `${modeEn} — withdrawal blocked (no fuel).`;
      statusZh = `${modeZh} — 提棒被封鎖（冇燃料）。`;
    } else if (this._motionDir > 0) {
      statusEn = `${modeEn} — rods stepping OUT at ${Math.abs(this._speedDemandSpm).toFixed(0)} spm.`;
      statusZh = `${modeZh} — 提棒中，${Math.abs(this._speedDemandSpm).toFixed(0)} 步/分。`;
    } else if (this._motionDir < 0) {
      statusEn = `${modeEn} — rods stepping IN at ${Math.abs(this._speedDemandSpm).toFixed(0)} spm.`;
      statusZh = `${modeZh} — 插棒中，${Math.abs(this._speedDemandSpm).toFixed(0)} 步/分。`;
    } else if (this._mode === 'auto' && inDeadband) {
      statusEn = 'AUTO — holding, Tavg within the ±1.5 °F deadband.';
      statusZh = '自動 — 保持，Tavg 喺 ±1.5 °F 死區之內。';
    } else {
      statusEn = `${modeEn} — holding.`;
      statusZh = `${modeZh} — 保持。`;
    }
    return {
      mode: this._mode,
      demandSteps: this._demand,
      demandTargetSteps: this._target,
      manualSpm: this._manualSpm,
      manualDirection: this._manualDir,
      bankInsertionPct: [...this._viewBanks],
      bankStepsWithdrawn: stepsWithdrawn,
      trefC: this._trefC,
      tavgTrefErrorC: this._errC,
      inDeadband,
      rodSpeedDemandSpm: this._speedDemandSpm,
      moving: this._moving,
      motionDirection: this._motionDir,
      withdrawBlocked: this._block !== BlockNone,
      withdrawBlockedReasonEn: this._block.en,
      withdrawBlockedReasonZh: this._block.zh,
      engaged: this._engaged,
      statusEn,
      statusZh,
    };
  }
}
