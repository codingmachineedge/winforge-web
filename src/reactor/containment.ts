// 安全殼壓力／溫度集總模型 + ESFAS 壓力雙穩態 + 隔離／噴淋／集水坑 + RCP 軸封失水事故 ·
// Containment pressure/temperature lump, Hi-1/2/3 ESFAS pressure bistables, containment
// isolation (Phase A / Phase B), containment spray, the normal sump, and the WOG-2000
// RCP seal-LOCA model (loss-of-seal-cooling staged degradation).
//
// A pure, deterministic, framework-free TypeScript port of these regions of WinForge's C#
// `ReactorSimService` (Services/ReactorSimService.cs):
//   • L1843–1866 + L1947  — containment lump fields, ESFAS bistable setpoints, spray setup timer
//   • L4026–4100          — UpdateContainment (mass/energy drive, bistables, isolation, spray)
//   • L1885–1915, L5803–5838 — sump constants + StepLeakDetection (sump fill / inferred rate /
//                              pump hysteresis / identified-leak categorization)
//   • L1223–1234, L3317–3358 — WOG-2000 seal constants + StepSeals (staged seal degradation)
//   • L1039, L2510–2513, L2571–2580, L3249–3306 — the _sealCoolingFailed / _ccwLossActive
//     scenario latches (StepComponentCooling reduced to its seal-cooling consequence: this
//     port has no electrical/CCW network yet, so `triggerSealCoolingLoss()` stands in for
//     LossOfComponentCoolingWater + RcpSealLoca — loss of BOTH seal-cooling paths).
//
// The module NEVER mutates the reactor sim: `step(inputs, dt)` reads plain numbers and returns
// the effects for the integrator to apply. All internal dynamics are clamped first-order
// relaxations (factor = min(1, dt/τ)) — unconditionally stable at the outer-tick dt (0.2–2 s).
//
// OUT OF SCOPE (this wave): the containment combustible-H₂ model (C# combustible-gas
// region, constants from L1917; 10 CFR 50.44) — see the integrator notes.

import { _clamp } from './physics';

// ---------------------------------------------------------------- constants ----
// Containment atmosphere lump (source L1852–1861).
const ContainmentAmbientC = 49.0; // °C — ~120 °F normal containment atmosphere (source L1852)
const ContainmentPeakC = 125.0; // °C — ~257 °F bounding (MSLB superheat) peak (source L1853)
const ContainmentSprayTempC = 35.0; // °C — spray-quench floor (source L1854)
const CtmtPeakLocaKpa = 415.0; // ~60 psig blowdown peak, large-break LOCA (source L1855)
const CtmtPeakMslbKpa = 350.0; // ~51 psig peak, in-containment MSLB (source L1856)
const CtmtTauPressUp = 8.0; // s — pressurization time constant (source L1857)
const CtmtTauPassive = 300.0; // s — passive steel/concrete heat sinks (source L1858)
const CtmtTauFan = 120.0; // s — fan-cooler condensation (source L1859)
const CtmtTauSpray = 30.0; // s — containment-spray condensation, dominant (source L1860)
export const CtmtDesignPsig = 47.0; // ~324 kPa-g design pressure, display reference (source L1861)

// Westinghouse containment-pressure ESFAS bistable setpoints, gauge kPa (source L1863–1866).
export const CtmtHi1Kpa = 28.0; // ~4.0 psig — SI + Containment Isolation Phase A + reactor trip (source L1863)
export const CtmtHi2Kpa = 71.0; // ~10.3 psig — Main Steam Line Isolation (source L1864)
export const CtmtHi3Kpa = 186.0; // ~27 psig — Containment Spray + Phase B isolation (source L1865)
export const CtmtHystKpa = 7.0; // ~1 psi reset deadband, anti-chatter (source L1866)
const SpraySetupSeconds = 35.0; // spray pump-start + valve-stroke actuation delay (source L1947)

// psig display divisor — the C# publishes ContainmentPressurePsig = kPa / 6.895 (source L1844).
// (Exact: 1 psi = 6.894757 kPa; the containment gauge is already gauge-referenced, so no
// 101.325 kPa atmospheric offset appears here.)
const KpaPerPsi = 6.895;

// Containment normal sump (source L1885–1889).
export const SumpCapacityGal = 5000.0; // gal — normal-sump hard ceiling (source L1885)
export const SumpHiSetpointGal = 1000.0; // gal — sump-pump start setpoint (source L1886)
export const SumpLoSetpointGal = 200.0; // gal — sump-pump stop setpoint, hysteresis (source L1887)
const SumpPumpGpm = 50.0; // gpm — sump pump-down rate (source L1888)
const TauSumpSec = 120.0; // s — sump-level inferred-rate filter time constant (source L1889)
// PORT-ADDED: fraction of the containment-spray flow that finds its way to the NORMAL sump.
// The C# routes spray to the (unmodelled) recirculation sump; this wave's spec asks the normal
// sump to integrate "leakage + spray", so a modest collection rate is used for plausibility.
const SpraySumpCollectGpm = 150.0; // gpm reaching the normal sump while spray runs (port choice)

// WOG-2000 RCP seal model (source L1223–1234).
const SealCooledTempC = 50.0; // °C cooled-seal datum, charging/CCW removing seal heat (source L1223)
const SealHeatupTau = 900.0; // s — heat-up τ toward Thot when both cooling paths lost (source L1224)
const SealCooldownTau = 120.0; // s — faster relax back to the cooled datum (source L1225)
const SealBin1TempC = 93.0; // 200 °F — intact-but-hot floor begins → 21 gpm (source L1226)
const SealBin2TempC = 200.0; // 392 °F — → 76 gpm (WOG-2000 onset, ≈13 min) (source L1227)
const SealBin3TempC = 260.0; // 500 °F — popped O-ring → 182 gpm (source L1228)
const SealBin4TempC = 320.0; // ≈hot-leg — gross seal failure → 480 gpm (source L1229)
export const SealLeakNormalGpm = 3.0; // controlled #1-seal bleed-off per pump (source L1230)
export const SealLeakDegradedGpm = 21.0; // intact-but-hot floor per pump (source L1231)
const SealLeakBin2Gpm = 76.0; // WOG-2000 second bin per pump (source L1232)
const SealLeakPoppedGpm = 182.0; // WOG-2000 third bin per pump (source L1233)
const SealLeakGrossGpm = 480.0; // gross seal LOCA per pump, ~2-inch SBLOCA bounding (source L1234)
const SealPackages = 4; // 4 RCP seal packages — C# models all four cavities (source L1036)

// Alarm thresholds mirrored from the C# central alarm pass.
// RcpSealLoca: !SealCoolingAvailable && total > 4×normal bleed (source L5738).
const SealLocaAlarmGpm = 4.0 * SealLeakNormalGpm; // 12 gpm
// RcsIdentifiedLeakHi: IdentifiedLeakGpm > 10 gpm — LCO 3.4.13.c (source L1882, L5741).
const IdentLeakLimitGpm = 10.0;

/** Bilingual alarm pair — texts lifted from the C# annunciator table (Pages/ReactorModule.xaml.cs L1404–1453). */
export interface CtmtAlarm {
  en: string;
  zh: string;
}

// ---------------------------------------------------------------- interfaces ----
/** Values read FROM the reactor sim (and sibling modules) each tick. The module never mutates the sim. */
export interface ContainmentInputs {
  /** PRT rupture-disc vent pressurization drive, gauge kPa (from the pressure-relief module; safe default 0). */
  prtVentDriveKpa: number;
  /** Number of RCPs running (0–4). Display/context only — the C# models all 4 seal packages regardless (source L3330). */
  rcpRunningCount: number;
  /** RCS primary pressure, MPa-abs — fades the LOCA blowdown drive as the RCS empties (source L4033). */
  primaryPressureMPa: number;
  /** Cold-leg temperature °C — lower bound sanity guard on the seal-cavity heat-up target. */
  tcoldC: number;
  /** Hot-leg temperature °C — the C# seal-cavity heat-up target is max(Thot, cooled datum) (source L3335). */
  thotC: number;
  /** True once the reactor is tripped — gates the Hi-1 auto-scram request (source L4078). */
  scrammed: boolean;
  /** COUPLING (future LOCA module): normalized break area 0..1. Safe default 0 (source L4033). */
  locaBreakAreaFrac?: number;
  /** COUPLING (future MSLB module): normalized in-containment break steam flow 0..1. Safe default 0 (source L4034). */
  mslbBreakFlowFrac?: number;
}

/** Effects the integrator applies back to the sim each tick. */
export interface ContainmentOutputs {
  /**
   * Total RCP seal leakoff, gpm — the integrator may bleed pressurizer level with it.
   * Suggested small coupling coefficient: sim.pressurizerLevel -= rcsLeakGpm * (dt/60) * 0.0074,
   * clamped ≥ 0 (0.0074 %/gal: pressurizer span ≈ 13,500 gal ≈ 100 %). Apply AFTER sim.update(dt)
   * so the sim's own level program runs first.
   */
  rcsLeakGpm: number;
  /** Hi-1 auto-scram request (true only while Hi-1 is up and the input said not-yet-scrammed). */
  requestScram: boolean;
  scramReasonEn: string;
  scramReasonZh: string;
  /** Safety injection actuated (latched by Hi-1, source L4075). */
  siActuated: boolean;
  /** Containment Isolation Phase A (Hi-1) — non-essential penetrations (source L4072). */
  isolationPhaseA: boolean;
  /** Containment Isolation Phase B (Hi-3) — full isolation incl. the CCW dump (source L4089). */
  isolationPhaseB: boolean;
  /** Hi-2 Main Steam Line Isolation request — close the MSIVs (source L4086). */
  msivIsolationRequest: boolean;
  /** Containment spray running (after the 35 s setup delay). */
  sprayActive: boolean;
}

/** Plain JSON-serializable display snapshot. */
export interface ContainmentView {
  pressureKpaG: number;
  pressurePsig: number;
  tempC: number;
  designPsig: number;
  // ---- Hi-1/2/3 bistable ladder ----
  hi1: boolean;
  hi2: boolean;
  hi3: boolean;
  hi1SetKpa: number;
  hi2SetKpa: number;
  hi3SetKpa: number;
  hystKpa: number;
  // ---- ESF actuations ----
  isolationPhaseA: boolean;
  isolationPhaseB: boolean;
  /** Latched: any containment-isolation signal has actuated since the last reset. */
  isolationActuated: boolean;
  siActuated: boolean;
  fanCoolers: boolean;
  sprayActive: boolean;
  sprayFlowFrac: number;
  /** Seconds of pump-start/valve-stroke delay remaining while Hi-3 is up (0 when quiescent or spraying). */
  spraySetupRemainingS: number;
  // ---- sump ----
  sumpGal: number;
  sumpCapacityGal: number;
  sumpHiSetpointGal: number;
  sumpLoSetpointGal: number;
  sumpPumpOn: boolean;
  sumpInferredLeakGpm: number;
  // ---- RCP seals ----
  sealCoolingAvailable: boolean;
  ccwLossActive: boolean;
  sealCavityTempC: number[];
  sealLeakGpmPerPump: number[];
  sealLeakGpmPerPumpMax: number;
  sealCavityMaxTempC: number;
  sealLeakGpmTotal: number;
  sealLocaActive: boolean;
  identifiedLeakGpm: number;
  rcsLeakGpm: number;
  rcpRunningCount: number;
  // ---- alarms (En/Zh pairs, wording from the C# annunciator table) ----
  alarms: CtmtAlarm[];
}

// ---------------------------------------------------------------- the system ----
export class ContainmentSystem {
  // containment lump
  private _pressureKpaG = 0.0; // gauge kPa, 0 = atmospheric (source L1843)
  private _tempC = ContainmentAmbientC; // source L1845
  // ESFAS pressure bistables (anti-chatter latches, source L1850)
  private _hi1 = false;
  private _hi2 = false;
  private _hi3 = false;
  private _spraySetupTimer = 0.0; // source L1851
  private _sprayActive = false;
  private _fanCoolers = false;
  private _siActuated = false; // Hi-1 latches SI (source L4075)
  private _isolationLatch = false; // any-phase isolation, latched until reset (this wave's spec)
  private _msivIsolated = false; // Hi-2 MSIV closure latch (source L4086: MslbIsolated = true)
  // sump (source L1914–1915)
  private _sumpGal = 0.0;
  private _sumpPrevGal = 0.0;
  private _sumpPumpOn = false;
  private _sumpInferredLeakGpm = 0.0;
  // WOG-2000 seals (source L1036–1041)
  private _sealCavityTempC = new Float64Array([SealCooledTempC, SealCooledTempC, SealCooledTempC, SealCooledTempC]);
  private _sealIntegrity = new Float64Array([1.0, 1.0, 1.0, 1.0]);
  private _sealLeakGpm = new Float64Array(SealPackages);
  private _sealCoolingLost = false; // _sealCoolingFailed/_ccwLossActive stand-in (source L1039, L1336)
  private _sealCoolingAvailable = true;
  private _sealLeakTotalGpm = 0.0;
  private _sealCavityMaxTempC = SealCooledTempC;
  private _identifiedLeakGpm = 0.0;
  private _rcpRunningCount = 0;
  private _scrammedIn = false;

  // -------------------------------------------------------------- scenario controls ----
  /**
   * 設備冷卻水喪失演練 · CCW-loss drill: removes BOTH seal-cooling paths (CCW thermal-barrier
   * cooling and charging seal-injection), exactly like the C# LossOfComponentCoolingWater +
   * RcpSealLoca scenario latches (source L2511, L2578). The seal cavities then climb the
   * WOG-2000 bins toward a seal LOCA over the 900 s heat-up timeline.
   */
  triggerSealCoolingLoss(): void {
    this._sealCoolingLost = true;
  }

  /**
   * 恢復軸封冷卻 · Restore seal cooling. Cavities relax back to the cooled datum (τ = 120 s),
   * but extruded O-rings never reseat — the Math.min integrity latch keeps the worst-reached
   * leak rate until a full reset (source L3346–3352).
   */
  restoreSealCooling(): void {
    this._sealCoolingLost = false;
  }

  reset(): void {
    this._pressureKpaG = 0.0;
    this._tempC = ContainmentAmbientC;
    this._hi1 = false;
    this._hi2 = false;
    this._hi3 = false;
    this._spraySetupTimer = 0.0;
    this._sprayActive = false;
    this._fanCoolers = false;
    this._siActuated = false;
    this._isolationLatch = false;
    this._msivIsolated = false;
    this._sumpGal = 0.0;
    this._sumpPrevGal = 0.0;
    this._sumpPumpOn = false;
    this._sumpInferredLeakGpm = 0.0;
    // seals — mirrors the C# reset block (source L2455–2457)
    this._sealCoolingLost = false;
    this._sealCoolingAvailable = true;
    for (let i = 0; i < SealPackages; i++) {
      this._sealCavityTempC[i] = SealCooledTempC;
      this._sealIntegrity[i] = 1.0;
      this._sealLeakGpm[i] = 0.0;
    }
    this._sealLeakTotalGpm = 0.0;
    this._sealCavityMaxTempC = SealCooledTempC;
    this._identifiedLeakGpm = 0.0;
    this._rcpRunningCount = 0;
    this._scrammedIn = false;
  }

  // -------------------------------------------------------------- main step ----
  step(inp: ContainmentInputs, dt: number): ContainmentOutputs {
    this._rcpRunningCount = Math.max(0, Math.min(SealPackages, Math.round(inp.rcpRunningCount)));
    this._scrammedIn = inp.scrammed;
    if (dt > 0) {
      this.stepSeals(inp, dt); // C# StepSeals (L3317)
      this.stepSump(dt); // C# StepLeakDetection sump part (L5810–5829)
      this.updateContainment(inp, dt); // C# UpdateContainment (L4026)
    }
    return {
      rcsLeakGpm: this._sealLeakTotalGpm,
      requestScram: this._hi1 && !inp.scrammed,
      // wording verbatim from the C# TryAutoScram call (source L4080)
      scramReasonEn: 'Containment Pressure Hi-1 (SI)',
      scramReasonZh: '安全殼壓力高 Hi-1（安全注入）',
      siActuated: this._siActuated,
      isolationPhaseA: this._hi1, // ContainmentIsolationPhaseA = _ctmtHi1 (source L4072)
      isolationPhaseB: this._hi3, // ContainmentIsolationPhaseB = _ctmtHi3 (source L4089)
      msivIsolationRequest: this._msivIsolated,
      sprayActive: this._sprayActive,
    };
  }

  /** WOG-2000 staged seal degradation — verbatim port of C# StepSeals (source L3317–3358). */
  private stepSeals(inp: ContainmentInputs, dt: number): void {
    // Both cooling paths (CCW thermal barrier + charging seal injection) are healthy unless the
    // scenario latch removed them — this port has no electrical/CCW network yet (source L3324–3326).
    const sealCoolOk = !this._sealCoolingLost;
    this._sealCoolingAvailable = sealCoolOk;

    // Heat-up target: the C# uses max(Thot, cooled datum) (source L3335). Tcold is folded in as a
    // lower-bound guard (Thot ≥ Tcold always holds in the sim; a cold/depressurized plant with
    // Thot < 100 °C can never reach a failure bin — no seal-LOCA risk at cold shutdown).
    const rcsHotC = Math.max(inp.thotC, inp.tcoldC);
    let total = 0.0;
    let maxT = SealCooledTempC;
    for (let i = 0; i < SealPackages; i++) {
      const target = sealCoolOk ? SealCooledTempC : Math.max(rcsHotC, SealCooledTempC);
      const tau = sealCoolOk ? SealCooldownTau : SealHeatupTau;
      this._sealCavityTempC[i] =
        this._sealCavityTempC[i]! + (target - this._sealCavityTempC[i]!) * Math.min(1.0, dt / tau);

      const t = this._sealCavityTempC[i]!;
      const binLeak =
        t >= SealBin4TempC ? SealLeakGrossGpm
        : t >= SealBin3TempC ? SealLeakPoppedGpm
        : t >= SealBin2TempC ? SealLeakBin2Gpm
        : t >= SealBin1TempC ? SealLeakDegradedGpm
        : SealLeakNormalGpm;

      // Monotonic degradation latch — once an O-ring pops the leak stays at its worst-reached
      // level even after the cavity cools (source L3348–3352).
      const degFrac = (binLeak - SealLeakNormalGpm) / (SealLeakGrossGpm - SealLeakNormalGpm);
      this._sealIntegrity[i] = Math.min(this._sealIntegrity[i]!, 1.0 - degFrac);
      const effLeak = SealLeakNormalGpm + (1.0 - this._sealIntegrity[i]!) * (SealLeakGrossGpm - SealLeakNormalGpm);

      this._sealLeakGpm[i] = Math.max(binLeak, effLeak);
      total += this._sealLeakGpm[i]!;
      if (this._sealCavityTempC[i]! > maxT) maxT = this._sealCavityTempC[i]!;
    }
    this._sealLeakTotalGpm = total;
    this._sealCavityMaxTempC = maxT;
    // Identified LEAKAGE = seal leakoff above the normal recovered #1-seal bleed-off (source L5813).
    this._identifiedLeakGpm = Math.max(0.0, total - SealPackages * SealLeakNormalGpm);
  }

  /** Sump fill / inferred-rate channel / pump hysteresis — C# StepLeakDetection (source L5815–5829). */
  private stepSump(dt: number): void {
    const dtMin = dt / 60.0;
    // Fill: seal leakoff ABOVE the recovered bleed is lost to containment, not the VCT (source
    // L1286 comment) — it reaches the floor/sump. Spray adds its collected fraction (port choice;
    // the C# sends spray to the unmodelled recirculation sump).
    const fillGpm = this._identifiedLeakGpm + (this._sprayActive ? SpraySumpCollectGpm : 0.0);
    this._sumpGal = _clamp(this._sumpGal + fillGpm * dtMin, 0.0, SumpCapacityGal);

    // RG 1.45 sump channel — infer the leak rate from the level-rise rate BEFORE pumping down
    // (source L5820–5823). A pump-down cycle is not a negative leak.
    const rawSumpRateGpm = (this._sumpGal - this._sumpPrevGal) / dtMin;
    this._sumpPrevGal = this._sumpGal;
    this._sumpInferredLeakGpm += (rawSumpRateGpm - this._sumpInferredLeakGpm) * Math.min(1.0, dt / TauSumpSec);
    if (this._sumpInferredLeakGpm < 0.0) this._sumpInferredLeakGpm = 0.0;

    // Pump the sump out at the hi setpoint (hysteresis latch, anti-chatter, source L5826–5829).
    if (this._sumpGal >= SumpHiSetpointGal) this._sumpPumpOn = true;
    else if (this._sumpGal <= SumpLoSetpointGal) this._sumpPumpOn = false;
    if (this._sumpPumpOn) this._sumpGal = Math.max(0.0, this._sumpGal - SumpPumpGpm * dtMin);
  }

  /** Containment lump + bistables + actuations — verbatim port of C# UpdateContainment (source L4026–4100). */
  private updateContainment(inp: ContainmentInputs, dt: number): void {
    // --- mass/energy source into the building (source L4033–4037) ---
    // The LOCA blowdown drive FADES as the RCS depressurizes; the PRT rupture-disc vent adds its
    // own (smaller) drive — TMI-2: how the stuck-open PORV flooded the sump. SGTR and out-of-
    // containment breaks are deliberately absent (they bypass the containment boundary).
    const breakArea = _clamp(inp.locaBreakAreaFrac ?? 0.0, 0.0, 1.0);
    const mslbFlow = _clamp(inp.mslbBreakFlowFrac ?? 0.0, 0.0, 1.0);
    const locaDrive = breakArea * _clamp(inp.primaryPressureMPa / 6.0, 0.0, 1.0);
    let pTarget = Math.max(mslbFlow * CtmtPeakMslbKpa, locaDrive * CtmtPeakLocaKpa);
    pTarget += Math.max(0.0, inp.prtVentDriveKpa);

    // --- pressurize fast, depressurize via parallel heat-removal conductances (source L4039–4054) ---
    let tau: number;
    if (pTarget > this._pressureKpaG + 1.0) {
      tau = CtmtTauPressUp; // a break is adding energy: pressure rising
    } else {
      let g = 1.0 / CtmtTauPassive; // passive heat sinks always condensing
      if (this._fanCoolers) g += 1.0 / CtmtTauFan;
      if (this._sprayActive) g += 1.0 / CtmtTauSpray;
      tau = 1.0 / g;
    }
    const fP = Math.min(1.0, dt / tau); // stable relaxation factor
    this._pressureKpaG += (pTarget - this._pressureKpaG) * fP;
    if (this._pressureKpaG < 0.0) this._pressureKpaG = 0.0;

    // Atmosphere temperature loosely tracks pressure; spray quenches toward ~35 °C (source L4056–4060).
    const pf = _clamp(this._pressureKpaG / CtmtPeakLocaKpa, 0.0, 1.0);
    let tTarget = ContainmentAmbientC + pf * (ContainmentPeakC - ContainmentAmbientC);
    if (this._sprayActive) tTarget = Math.min(tTarget, ContainmentSprayTempC + 10.0);
    this._tempC += (tTarget - this._tempC) * fP;

    // --- ESFAS bistables: latch on up-crossing, reset below set − deadband (source L4062–4068) ---
    if (this._pressureKpaG >= CtmtHi1Kpa) this._hi1 = true;
    else if (this._pressureKpaG < CtmtHi1Kpa - CtmtHystKpa) this._hi1 = false;
    if (this._pressureKpaG >= CtmtHi2Kpa) this._hi2 = true;
    else if (this._pressureKpaG < CtmtHi2Kpa - CtmtHystKpa) this._hi2 = false;
    if (this._pressureKpaG >= CtmtHi3Kpa) this._hi3 = true;
    else if (this._pressureKpaG < CtmtHi3Kpa - CtmtHystKpa) this._hi3 = false;

    // Hi-1 (~4 psig): SI + Phase A; safeguards fan coolers start; SI trips the reactor (source L4070–4082).
    if (this._hi1) {
      this._siActuated = true;
      this._fanCoolers = true;
      this._isolationLatch = true;
    }
    // Hi-2 (~10 psig): Main Steam Line Isolation — close the MSIVs (source L4084–4086).
    if (this._hi2) this._msivIsolated = true;
    // Hi-3 (~27 psig): Containment Spray after the ~35 s pump-start/valve-stroke delay + Phase B
    // (source L4088–4099). The spray permissive drops the moment Hi-3 resets.
    if (this._hi3) {
      this._isolationLatch = true;
      this._spraySetupTimer += dt;
      if (this._spraySetupTimer >= SpraySetupSeconds) this._sprayActive = true;
    } else {
      this._spraySetupTimer = 0.0;
      this._sprayActive = false;
    }
  }

  get sealLocaActive(): boolean {
    // C# alarm condition: seal cooling unavailable AND total leakoff > 4× the normal bleed (source L5738).
    return !this._sealCoolingAvailable && this._sealLeakTotalGpm > SealLocaAlarmGpm;
  }

  // -------------------------------------------------------------- view ----
  view(): ContainmentView {
    const alarms: CtmtAlarm[] = [];
    // Annunciator wording lifted from the C# tile table (Pages/ReactorModule.xaml.cs L1404–1453).
    if (this._hi1) alarms.push({ en: 'CTMT PRESS HI', zh: '安全殼壓力高' });
    if (this._hi1 || this._hi3) alarms.push({ en: 'CTMT ISOLATION', zh: '安全殼隔離' });
    if (this._sprayActive) alarms.push({ en: 'CTMT SPRAY', zh: '安全殼噴淋' });
    if (this.sealLocaActive) alarms.push({ en: 'RCP SEAL LOCA', zh: '主泵軸封失水' });
    if (this._identifiedLeakGpm > IdentLeakLimitGpm) alarms.push({ en: 'IDENT LEAK > 10 GPM', zh: '已辨識洩漏 >10 GPM' });
    // PORT-ADDED sump-level annunciator (no C# enum member; Chinese from the C# property doc 安全殼集水坑存量, L1900).
    if (this._sumpGal >= SumpHiSetpointGal) alarms.push({ en: 'CTMT SUMP LVL HI', zh: '安全殼集水坑水位高' });

    return {
      pressureKpaG: this._pressureKpaG,
      pressurePsig: this._pressureKpaG / KpaPerPsi, // source L1844
      tempC: this._tempC,
      designPsig: CtmtDesignPsig,
      hi1: this._hi1,
      hi2: this._hi2,
      hi3: this._hi3,
      hi1SetKpa: CtmtHi1Kpa,
      hi2SetKpa: CtmtHi2Kpa,
      hi3SetKpa: CtmtHi3Kpa,
      hystKpa: CtmtHystKpa,
      isolationPhaseA: this._hi1,
      isolationPhaseB: this._hi3,
      isolationActuated: this._isolationLatch,
      siActuated: this._siActuated,
      fanCoolers: this._fanCoolers,
      sprayActive: this._sprayActive,
      sprayFlowFrac: this._sprayActive ? 1.0 : 0.0,
      spraySetupRemainingS:
        this._hi3 && !this._sprayActive ? Math.max(0.0, SpraySetupSeconds - this._spraySetupTimer) : 0.0,
      sumpGal: this._sumpGal,
      sumpCapacityGal: SumpCapacityGal,
      sumpHiSetpointGal: SumpHiSetpointGal,
      sumpLoSetpointGal: SumpLoSetpointGal,
      sumpPumpOn: this._sumpPumpOn,
      sumpInferredLeakGpm: this._sumpInferredLeakGpm,
      sealCoolingAvailable: this._sealCoolingAvailable,
      ccwLossActive: this._sealCoolingLost,
      sealCavityTempC: Array.from(this._sealCavityTempC),
      sealLeakGpmPerPump: Array.from(this._sealLeakGpm),
      sealLeakGpmPerPumpMax: SealLeakGrossGpm,
      sealCavityMaxTempC: this._sealCavityMaxTempC,
      sealLeakGpmTotal: this._sealLeakTotalGpm,
      sealLocaActive: this.sealLocaActive,
      identifiedLeakGpm: this._identifiedLeakGpm,
      rcsLeakGpm: this._sealLeakTotalGpm,
      rcpRunningCount: this._rcpRunningCount,
      alarms,
    };
  }

  /** Convenience for tests/integration — true only while the Hi-1 scram request would fire. */
  get scramRequested(): boolean {
    return this._hi1 && !this._scrammedIn;
  }
}
