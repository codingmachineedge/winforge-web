// 工程安全設施 · Engineered Safety Features (ESF) — Safety Injection actuation + high-head charging
// at 2000 ppm boron, passive N₂ accumulator dump, and the Main Steam Safety Valve (MSSV) bank.
//
// A pure, deterministic, framework-free TypeScript port of the ESF slices of WinForge's C#
// `ReactorSimService` (Services/ReactorSimService.cs):
//
//   • SI actuation (ESFAS): Lo-Steamline-Pressure SI at 4.14 MPa (source L1831, function L2090)
//     gated by a P-11-style "RCS at operating pressure" permissive (source L2088), a
//     low-pressurizer-pressure channel derived from the C# powered-injection threshold
//     (`PrimaryPressure < 11.0`, source L5414), and manual actuation. The SI signal LATCHES
//     (source L5405 `SiActuated = true;` cleared only by scenario reset L2453/L2903) — here the
//     operator clears it with resetSi() after the conditions clear, mirroring the manual SI block.
//   • Borated high-head injection: SI ramps RCS boron toward 2000 ppm (MslbSiBoronPpm, source
//     L1832) at the UpdateBoron 4 ppm/s slew (source L4286, L5407). C# quirk kept: the boron path
//     rides the SI FLAG, not the injection flow — an MSLB never depressurizes the primary, yet the
//     charging pumps still borate against full RCS pressure (source L5401 comment).
//   • HHSI flow vs backpressure: powered injection only below the 11.0 MPa shutoff head (source
//     L5414); while injecting it repressurizes (+0.4 MPa/s, source L5417), cools the fuel/loops
//     (−30 / −5 °C/s, source L5418–5419) and restores pressurizer inventory (lvlTarget += 25,
//     source L4634).
//   • Passive N₂ accumulators: check valves crack whenever primary pressure < the ~4.5 MPa
//     precharge (source L3522) — no signal, no power. Effects per source L3525–3527 (fuel −25 °C/s,
//     loops −4 °C/s, pzr level +4 %/s). The C# tank is unmetered; this port carries a FINITE
//     inventory (100 % → 0 %) so the dump ends.
//   • MSSV bank: 5 lumped spring-safety stages on the steam header with staggered setpoints
//     7.60…8.40 MPa, 0.30 MPa blowdown reseat bands and full lift at MssvAccumMpa = 8.6 (source
//     L808–823); relief per open stage scales with overpressure above the LOWEST open seat
//     (choked-flow surrogate, source L5146–5167). Rising-edge pop events (source L885).
//
// The module never mutates the reactor sim: step() reads plain-number Inputs and returns Outputs
// (rates/deltas/flags) that the integrator applies. All latches live in this class.

import { _clamp } from './physics';

// ------------------------------------------------------------------ SI / ECCS constants ----
const SiBoronTargetPpm = 2000.0; // ppm — MslbSiBoronPpm, borated-SI shutdown-margin target (source L1832)
const SiBoronRampPpmPerS = 4.0; // ppm/s — the UpdateBoron slew the SI target rides (source L4286, L5407)
const SiLoSteamlineMPa = 4.14; // MPa — Lo-Steamline-Pressure SI setpoint ≈600 psia (source L1831)
const P11PermissiveMPa = 10.0; // MPa — "RCS at operating pressure" P-11-style arming (source L2088)
const HhsiShutoffHeadMPa = 11.0; // MPa — powered SI/HHSI injects only below this (source L5414)
const HhsiFlowRampMPa = 2.0; // MPa — port shaping of the L5414 step: flow ramps 0→1 over 2 MPa
const SiLowPressArmMPa = 12.0; // MPa — lo-pzr-press SI channel arms once the RCS has been at pressure (port)
const SiPressSupportMPaPerS = 0.4; // MPa/s — HHSI repressurization while injecting (source L5417)
const SiFuelCoolCPerS = 30.0; // °C/s — strong ECCS fuel cooling (source L5418)
const SiLoopCoolCPerS = 5.0; // °C/s — Tcold/Thot pulldown while injecting (source L5419)
const SiLevelBiasPct = 25.0; // % — pressurizer level-target bias while ECCS injects (source L4634)
const SiLevelTauS = 8.0; // s — the physics.ts pzr-level relaxation τ the bias acts through
const RcsMixVolumeRefGal = 80000.0; // gal — effective RCS mixing volume reference (source L433)

// ------------------------------------------------------------------ N₂ accumulators ----
const AccumPrechargeMPa = 4.5; // MPa — passive dump threshold / N₂ precharge (source L3522)
const AccumArmMPa = AccumPrechargeMPa + 0.5; // MPa — isolation-valve arming latch: RCS was pressurized (port)
const AccumFuelCoolCPerS = 25.0; // °C/s — fuel quench while dumping (source L3525)
const AccumLoopCoolCPerS = 4.0; // °C/s — Tcold/Thot pulldown while dumping (source L3526)
const AccumLevelPctPerS = 4.0; // %/s — pressurizer level refill while dumping (source L3527)
const AccumFullDumpS = 120.0; // s — finite-inventory empty time at full ΔP (port; C# tank is unmetered)

// ------------------------------------------------------------------ MSSV bank ----
export const MssvAccumMpa = 8.6; // MPa — header pressure at full lift of the highest stage (source L815)
const MssvBlowdownMpa = 0.3; // MPa — reseat only at LiftSet − Blowdown, chatter-free hysteresis (source L818-822)
// Staggered lift ladder + per-stage capacities (fraction of nominal steam flow), source L818–822.
// Real-plant analogs per Tech-Spec Table 3.7.1-2: 1185 / 1195 / 1207.5 / 1218.5 / 1230 psig (source L799).
export const MssvLiftSetMpa: readonly number[] = [7.6, 7.8, 8.0, 8.2, 8.4];
export const MssvCapacityFrac: readonly number[] = [0.16, 0.2, 0.22, 0.22, 0.2];
export const MssvAnalogPsig: readonly number[] = [1185, 1195, 1207.5, 1218.5, 1230];

/** psig ↔ MPa-abs: psig = (Pa − 101325) / 6894.757. */
export function mpaAbsToPsig(mpa: number): number {
  return (mpa * 1.0e6 - 101325.0) / 6894.757;
}
/** Inverse: MPa-abs from psig. */
export function psigToMpaAbs(psig: number): number {
  return (psig * 6894.757 + 101325.0) / 1.0e6;
}

/** 輸入 · Plain numbers/booleans the integrator reads off the reactor sim each tick. */
export interface EngineeredSafetyInputs {
  /** RCS primary pressure, MPa-abs (sim.primaryPressure). */
  primaryPressureMPa: number;
  /** Pressurizer level, % (sim.pressurizerLevel). */
  pressurizerLevelPct: number;
  /** Lumped steam-header pressure, MPa-abs (sim.steamPressure). */
  steamPressureMPa: number;
  /** RCS soluble boron, ppm (sim.boronPpm). */
  boronPpm: number;
  /** Effective RCS mixing volume, gal — pass 80000 (source L433). Scales the SI boron rate. */
  rcsMixVolumeGal: number;
  /** Reactor already tripped (sim.isScrammed) — gates the SI reactor-trip demand. */
  scrammed: boolean;
}

/** 輸出 · Effects the integrator applies back onto the sim (rates, deltas, flags). */
export interface EngineeredSafetyOutputs {
  /** SI signal latched (SiActuated analog, source L1828). */
  siActive: boolean;
  /** 0..1 of max high-head safety-injection flow vs backpressure (0 above the 11.0 MPa shutoff head). */
  siFlowFrac: number;
  /** ppm/s the integrator ADDS to sim.boronPpm AFTER updateBoron — overrides the CVCS slew clamp. */
  boronPpmPerS: number;
  /** %/s pressurizer-level (inventory) addition from HHSI charging + accumulator dump. */
  pzrLevelPctPerS: number;
  /** MPa/s small repressurization from HHSI pumping against a depressurized RCS (source L5417). */
  pressureSupportMPaPerS: number;
  /** °C/s fuel-temperature pulldown from ECCS/accumulator water (sources L5418, L3525). */
  fuelCoolCPerS: number;
  /** °C/s Tcold AND Thot pulldown from injection (sources L5419, L3526). */
  loopCoolCPerS: number;
  /** SI trips the reactor (P-4, source L4078) — integrator calls sim.scram() when true. */
  siDemandsReactorTrip: boolean;
  /** Passive accumulator check valves open and inventory remains. */
  accumulatorsDumping: boolean;
  /** Remaining accumulator bank inventory, % (100 = full). */
  accumulatorLevelPct: number;
  /** How many of the 5 MSSV stages are latched open. */
  mssvOpenCount: number;
  /** Total MSSV relief flow this step, fraction of nominal steam flow (source L5167). */
  mssvReliefFlowFrac: number;
  /** True on any step where at least one MSSV stage POPPED (rising edge, source L885). */
  mssvLiftedEdge: boolean;
}

/** 顯示快照 · Plain JSON-serializable display snapshot for the panel. */
export interface EngineeredSafetyView {
  siActive: boolean;
  siFlowFrac: number;
  siBoronRatePpmPerS: number;
  siBoronTargetPpm: number;
  /** Lo-pzr-press SI channel armed (RCS has been at operating pressure). */
  siLowPressArmed: boolean;
  /** Last actuation came from the manual pushbutton. */
  siManual: boolean;
  siStatusEn: string;
  siStatusZh: string;
  accumulatorLevelPct: number;
  accumulatorsDumping: boolean;
  accumulatorsArmed: boolean;
  accumulatorPrechargeMPa: number;
  mssvOpen: boolean[];
  mssvSetpointMpa: number[];
  mssvSetpointPsig: number[];
  mssvAnalogPsig: number[];
  mssvOpenCount: number;
  mssvReliefFlowFrac: number;
  mssvLiftedEdge: boolean;
  activeAlarmsEn: string[];
  activeAlarmsZh: string[];
}

const zeroOutputs = (): EngineeredSafetyOutputs => ({
  siActive: false,
  siFlowFrac: 0,
  boronPpmPerS: 0,
  pzrLevelPctPerS: 0,
  pressureSupportMPaPerS: 0,
  fuelCoolCPerS: 0,
  loopCoolCPerS: 0,
  siDemandsReactorTrip: false,
  accumulatorsDumping: false,
  accumulatorLevelPct: 100,
  mssvOpenCount: 0,
  mssvReliefFlowFrac: 0,
  mssvLiftedEdge: false,
});

/**
 * 工程安全設施引擎 · The ESF engine module. Deterministic; dt is SIMULATED seconds (called once per
 * outer tick, dt typically 0.2–2 s — nothing here is stiff at that step: the only integrations are
 * a clamped boron ramp and a bounded inventory drain, and the MSSV/SI latches carry hysteresis
 * bands wider than any single-step swing).
 */
export class EngineeredSafety {
  // ---- SI latches ----
  private _siLatched = false; // SiActuated analog (source L1828) — seals in until operator reset
  private _siManual = false; // last actuation source was the manual pushbutton
  private _siLowPressArmed = false; // lo-pzr-press channel armed once RCS has been ≥ 12 MPa
  // ---- accumulators ----
  private _accumArmed = false; // isolation lineup: RCS has been above precharge + margin
  private _accumLevelPct = 100.0;
  // ---- MSSV latched lift state (mirrors the C# Mssv.Open value-type array, source L808) ----
  private readonly _mssvOpen = [false, false, false, false, false];
  private _mssvEdge = false;
  // ---- last-step snapshot for the view ----
  private _out: EngineeredSafetyOutputs = zeroOutputs();

  /** 手動安全注入 · Manual SI actuation pushbutton — latches the SI signal immediately. */
  actuateSi(): void {
    this._siLatched = true;
    this._siManual = true;
  }

  /**
   * 復位／閉鎖安全注入 · Reset the latched SI signal (the C# latch only clears on scenario reset,
   * L2453/L2903; here the operator clears it). If a live automatic actuation condition still
   * exists it re-latches on the next step. Resetting while the RCS is depressurized (< 12 MPa)
   * also inserts the lo-pzr-press SI block — the manual block operators carry below P-11 — so a
   * recovering plant is not immediately re-tripped; the channel re-arms once P ≥ 12 MPa.
   */
  resetSi(): void {
    this._siLatched = false;
    this._siManual = false;
    this._siLowPressArmed = false; // re-arms automatically at ≥ SiLowPressArmMPa (step())
  }

  reset(): void {
    this._siLatched = false;
    this._siManual = false;
    this._siLowPressArmed = false;
    this._accumArmed = false;
    this._accumLevelPct = 100.0;
    for (let i = 0; i < this._mssvOpen.length; i++) this._mssvOpen[i] = false;
    this._mssvEdge = false;
    this._out = zeroOutputs();
  }

  step(inp: EngineeredSafetyInputs, dt: number): EngineeredSafetyOutputs {
    if (!(dt > 0)) dt = 0;
    const p = _clamp(inp.primaryPressureMPa, 0, 25);
    const ps = _clamp(inp.steamPressureMPa, 0, 12);
    const boron = _clamp(inp.boronPpm, 0, 30000);
    const level = _clamp(inp.pressurizerLevelPct, 0, 100);
    const vGal = inp.rcsMixVolumeGal > 1 ? inp.rcsMixVolumeGal : RcsMixVolumeRefGal;

    // ---- MSSV bank: latch on up-crossing, reseat only after the full blowdown band ----
    // (indexed loop mirroring the C# value-type array walk, source L5147–5158)
    this._mssvEdge = false;
    let lowestOpenSet = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._mssvOpen.length; i++) {
      const lift = MssvLiftSetMpa[i]!;
      if (!this._mssvOpen[i] && ps >= lift) {
        this._mssvOpen[i] = true; // rising edge — annunciate once per individual pop (source L5151)
        this._mssvEdge = true;
      } else if (this._mssvOpen[i] && ps <= lift - MssvBlowdownMpa) {
        this._mssvOpen[i] = false; // reseat only after a full blowdown band (source L5154)
      }
      if (this._mssvOpen[i] && lift < lowestOpenSet) lowestOpenSet = lift;
    }
    let mssvRelief = 0.0;
    let mssvOpenCount = 0;
    if (Number.isFinite(lowestOpenSet)) {
      // Relief per open stage scales with overpressure above the LOWEST open seat — a choked-flow
      // surrogate so the header equilibrates just above the highest open stage (source L5160–5166).
      const liftFrac = _clamp((ps - lowestOpenSet) / (MssvAccumMpa - lowestOpenSet), 0, 1);
      for (let i = 0; i < this._mssvOpen.length; i++) {
        if (this._mssvOpen[i]) {
          mssvRelief += MssvCapacityFrac[i]! * liftFrac;
          mssvOpenCount++;
        }
      }
    }

    // ---- passive N₂ accumulators (check valves — no signal, no power) ----
    // Arming latch: the isolation valves are open / the tank sees the RCS only after the plant has
    // been pressurized above the precharge (port adaptation of the C# `FuelTemp > 200 || _breakArea`
    // gate at L3522 given this module's input set — prevents a cold-shutdown plant, which sits at
    // 2.5 MPa by construction, from draining the bank).
    if (p >= AccumArmMPa) this._accumArmed = true;
    const dumping = this._accumArmed && p < AccumPrechargeMPa && this._accumLevelPct > 0;
    if (dumping) {
      // ΔP-driven blowdown: full-ΔP empty time AccumFullDumpS; slows as primary backfills toward
      // the precharge (finite inventory — port addition, the C# tank at L3522 is unmetered).
      const dpFrac = _clamp((AccumPrechargeMPa - p) / AccumPrechargeMPa, 0, 1);
      this._accumLevelPct = Math.max(0, this._accumLevelPct - (100.0 / AccumFullDumpS) * dpFrac * dt);
    }

    // ---- SI actuation logic ----
    // Lo-pzr-press channel arming: RCS has been at operating pressure (port latch; see resetSi()).
    if (p >= SiLowPressArmMPa) this._siLowPressArmed = true;
    // Live conditions:
    //  (a) low pressurizer pressure — derived from the C# powered-injection threshold (source L5414);
    //  (b) Lo-Steamline-Pressure SI, blocked below the P-11-style permissive so the naturally-low
    //      secondary pressure during cold shutdown / heat-up never spuriously actuates (source
    //      L2082–2091). The permissive is LIVE, exactly like the C# `rcsAtPressure` lambda.
    const loPressSi = this._siLowPressArmed && p < HhsiShutoffHeadMPa;
    const loSteamSi = ps <= SiLoSteamlineMPa && p >= P11PermissiveMPa;
    if (loPressSi || loSteamSi) {
      if (!this._siLatched) this._siManual = false; // automatic actuation
      this._siLatched = true; // seals in (source L5405)
    }

    // ---- SI effects ----
    const siActive = this._siLatched;
    // HHSI flow vs backpressure: dead-headed at/above the 11.0 MPa shutoff (source L5414), ramping
    // to full flow HhsiFlowRampMPa below it (port shaping of the C# on/off step).
    const siFlowFrac = siActive ? _clamp((HhsiShutoffHeadMPa - p) / HhsiFlowRampMPa, 0, 1) : 0;

    // Borated injection: ramp RCS boron toward 2000 ppm at the 4 ppm/s UpdateBoron slew (sources
    // L1832, L4286, L5407). C# quirk kept: driven by the SI FLAG, not the injection flow (L5401) —
    // charging borates even against a fully-pressurized RCS. Scaled by the mixing-volume ratio so
    // a smaller RCS borates proportionally faster (reference 80000 gal ⇒ exactly 4 ppm/s), and
    // clamped so a single step never overshoots the target.
    let boronRate = 0.0;
    if (siActive && boron < SiBoronTargetPpm && dt > 0) {
      const slew = SiBoronRampPpmPerS * (RcsMixVolumeRefGal / vGal);
      boronRate = Math.min(slew, (SiBoronTargetPpm - boron) / dt);
    }

    // Inventory / pressure / cooling terms — HHSI (source L5415–5419, L4634) + accumulators
    // (source L3523–3527), both expressed as rates the integrator applies.
    let pzrLevelRate = 0.0;
    let pressSupport = 0.0;
    let fuelCool = 0.0;
    let loopCool = 0.0;
    if (siFlowFrac > 0) {
      // lvlTarget += 25 through the τ = 8 s level relaxation ⇒ ≈ 3.13 %/s equivalent, tapered off
      // as the pressurizer fills so the integral cannot exceed 100 %.
      pzrLevelRate += (SiLevelBiasPct / SiLevelTauS) * siFlowFrac * _clamp((100 - level) / SiLevelBiasPct, 0, 1);
      pressSupport += SiPressSupportMPaPerS * siFlowFrac; // source L5417
      fuelCool += SiFuelCoolCPerS * siFlowFrac; // source L5418
      loopCool += SiLoopCoolCPerS * siFlowFrac; // source L5419
    }
    if (dumping) {
      pzrLevelRate += AccumLevelPctPerS * _clamp((100 - level) / 4.0, 0, 1); // source L3527
      fuelCool += AccumFuelCoolCPerS; // source L3525
      loopCool += AccumLoopCoolCPerS; // source L3526
    }

    this._out = {
      siActive,
      siFlowFrac,
      boronPpmPerS: boronRate,
      pzrLevelPctPerS: pzrLevelRate,
      pressureSupportMPaPerS: pressSupport,
      fuelCoolCPerS: fuelCool,
      loopCoolCPerS: loopCool,
      siDemandsReactorTrip: siActive && !inp.scrammed, // SI trips the reactor / P-4 (source L4078)
      accumulatorsDumping: dumping,
      accumulatorLevelPct: this._accumLevelPct,
      mssvOpenCount,
      mssvReliefFlowFrac: mssvRelief,
      mssvLiftedEdge: this._mssvEdge,
    };
    return this._out;
  }

  view(): EngineeredSafetyView {
    const o = this._out;
    const en: string[] = [];
    const zh: string[] = [];
    const add = (e: string, z: string) => {
      en.push(e);
      zh.push(z);
    };
    // Annunciator text pairs lifted from the C# alarm table (Pages/ReactorModule.xaml.cs L1377–1403).
    if (o.siActive) add('SAFETY INJECTION', '安全注入 SI');
    if (o.siFlowFrac > 0) add('ECCS ACTIVE', '應急堆芯冷卻');
    if (o.accumulatorsDumping) add('ACCUM INJECT', '蓄壓器注入');
    if (this._accumArmed && this._accumLevelPct <= 0) add('ACCUMULATORS EMPTY', '蓄壓器已排空');
    if (o.mssvOpenCount > 0) add('MAIN STEAM SAFETY OPEN', '主蒸汽安全閥起跳');
    return {
      siActive: o.siActive,
      siFlowFrac: o.siFlowFrac,
      siBoronRatePpmPerS: o.boronPpmPerS,
      siBoronTargetPpm: SiBoronTargetPpm,
      siLowPressArmed: this._siLowPressArmed,
      siManual: this._siManual,
      siStatusEn: o.siActive ? (this._siManual ? 'SI ACTUATED (MANUAL)' : 'SI ACTUATED') : 'SI STANDBY',
      siStatusZh: o.siActive ? (this._siManual ? '安全注入已致動（手動）' : '安全注入已致動') : '安全注入待命',
      accumulatorLevelPct: this._accumLevelPct,
      accumulatorsDumping: o.accumulatorsDumping,
      accumulatorsArmed: this._accumArmed,
      accumulatorPrechargeMPa: AccumPrechargeMPa,
      mssvOpen: [...this._mssvOpen],
      mssvSetpointMpa: [...MssvLiftSetMpa],
      mssvSetpointPsig: MssvLiftSetMpa.map(mpaAbsToPsig),
      mssvAnalogPsig: [...MssvAnalogPsig],
      mssvOpenCount: o.mssvOpenCount,
      mssvReliefFlowFrac: o.mssvReliefFlowFrac,
      mssvLiftedEdge: o.mssvLiftedEdge,
      activeAlarmsEn: en,
      activeAlarmsZh: zh,
    };
  }
}
