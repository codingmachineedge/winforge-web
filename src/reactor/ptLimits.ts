// 反應堆容器 P/T 操作限值 + 升降溫率監測 + 低溫超壓保護 + 承壓熱衝擊監測 ·
// Reactor-vessel Pressure/Temperature (P/T) operating envelope (10 CFR 50 Appendix G),
// RCS heatup/cooldown-rate monitor, LTOP/COMS arming, and the Pressurized Thermal Shock
// (PTS, 10 CFR 50.61) monitor.
//
// A pure, deterministic, framework-free TypeScript port of the corresponding blocks of
// WinForge's C# `ReactorSimService` (Services/ReactorSimService.cs):
//   • constants L519–596 (App-G table, K_IC curve, LTOP setpoints, rate filter, PTS material/geometry)
//   • state L829–871 (_prevTcoldForRate/_rateInit, LtopArmed, PTS wall-lag + EFPY age knob)
//   • UpdatePtLimits L4838–4862, ComputeRtPts L4870–4879, UpdatePtsMonitor L4892–4931
//
// Physics background (condensed from the C# region comments):
//   The beltline shell of an irradiated RPV is brittle when cold: a flaw can propagate by fast
//   fracture if pressure (membrane stress) is applied below the material's ductile-brittle
//   transition. Appendix G (via ASME XI App G) bounds the allowable RCS pressure as a function of
//   the indicated coolant temperature using the reference fracture-toughness curve
//       K_IC = 33.2 + 20.734·exp(0.02·(T − RT_NDT))   [ksi·√in, T & RT_NDT in °F]  (eq. G-2210)
//   PTS is the complementary FAST-transient threat: an overcooling event plunges the downcomer
//   fluid temperature while the thick beltline metal lags warm, and if high-head SI then
//   repressurizes the cold, embrittled vessel, applied K_I can reach K_IC → brittle crack
//   initiation. Both blocks are DISPLAY-ONLY figures of merit + annunciators — they never trip
//   the plant. The ONE outward coupling is `ltopArmed`: the pressure-relief module substitutes
//   the low cold PORV setpoint while it is asserted (C# StepThermal PORV block reads LtopArmed).
//
// The class never mutates the reactor sim: it reads Inputs, integrates its own latches/lags, and
// publishes Outputs (flags for the integrator) + a JSON-serializable View (for the panel).

import { _clamp } from './physics';

// ------------------------------------------------------------------ App G P/T table ----
// Representative, monotone composite *heatup* limit as a (°C → MPa-abs) table, interpolated on
// bulk Tcold. VALUES ARE REPRESENTATIVE / GENERIC for an aged 4-loop vessel (~82 °C / 180 °F ART)
// — NOT a plant PTLR. Anchor (°F,psig) points converted with MPa_abs = (psig + 14.7) / 145.038.
export const PtTempC: readonly number[] = [15.6, 37.8, 65.6, 93.3, 121.1, 148.9, 291.0]; // °C bulk Tcold knots — source L532
export const PtPmaxMPa: readonly number[] = [4.38, 4.93, 6.31, 9.07, 13.9, 17.24, 17.24]; // MPa-abs allowable (flattens at the 17.24 MPa design ceiling) — source L533

export const AppGRtndtF = 60.0; // °F — representative mid-life adjusted RT_NDT (provenance for the table) — source L534
export const KicFloorKsi = 33.2; // ksi·√in — exact ASME XI App G K_IC floor (eq. G-2210) — source L535
export const KicCoeffB = 20.734; // ksi·√in — exact App G K_IC coefficient — source L536
export const KicExpCoeff = 0.02; // /°F — exact App G K_IC exponent coefficient — source L537
export const AppGSfNormal = 2.0; // membrane-stress safety factor, normal heatup/cooldown (Level A/B) — source L538
export const AppGSfHydroTest = 1.5; // membrane-stress safety factor, inservice leak / hydrotest — source L539
export const CoreCriticalMarginC = 22.2; // °C (= +40 °F) extra margin above the P/T-limit temp required for criticality (App G Table 1) — source L540
export const MinBoltupTempC = 18.0; // °C (~65 °F) minimum flange-boltup / pressurization-enable temperature — source L541
const PtApproachWarnMPa = 1.0; // MPa — warn when primary pressure is within this of the App G allowable — source L542

// ---- Low-Temperature Overpressure Protection (LTOP) / Cold Overpressure Mitigation (COMS) ----
// Below the enable temperature the App G allowable pressure is low, so a mass-input or heat-input
// transient can breach the brittle-fracture limit in seconds. LTOP re-ranges the pressurizer PORVs
// to a low cold setpoint. P_set + overshoot + uncertainty ≤ P_AppG(T_enable); 3.10 ≪ ~15.6 MPa at 135 °C.
export const LtopEnableTempC = 135.0; // °C (~275 °F) bulk-Tcold arm threshold (≈ max(App G transition, RT_NDT+50 °F)) — source L549
export const LtopEnableHystC = 5.0; // °C — disarm only above enable+hyst to stop boundary chatter — source L550
export const LtopOpenPressureMPa = 3.1; // MPa-abs (~435 psig) LTOP PORV lift setpoint while armed — source L551
export const LtopCloseHystMPa = 0.21; // MPa (~30 psi) blowdown → reseat at 2.89 MPa (strictly < open) — source L552

// ---- App G heatup/cooldown rate limit + signed-rate filter ----
export const AppGRateLimitCperHr = 55.56; // °C/hr (= 100 °F/hr) Appendix-G heatup/cooldown rate limit — source L554
const RateAlarmFraction = 0.9; // alarm at 90% of the rate limit (|rate| > 50 °C/hr) — source L555
const RateFilterTauSec = 45.0; // s — single-pole EMA time constant for the displayed rate — source L556
const RateSampleMinDt = 0.05; // s — guard the finite-difference divide below this dt — source L557

// ---- Pressurized Thermal Shock (PTS) — 10 CFR 50.61 / RG 1.99 Rev.2 / ASME XI App G ----
// (a) Embrittlement — RT_PTS = RT_NDT(initial) + ΔRT_NDT + Margin, ΔRT_NDT = CF·f^(0.28−0.10·log₁₀ f),
//     f = fast fluence in 10¹⁹ n/cm² (RG 1.99 Rev.2). Computed ONCE (ctor/reset/EFPY change), not per tick.
const PtsRtNdtInitF = 0.0; // °F — unirradiated initial RT_NDT of the limiting beltline weld (representative generic) — source L574
const PtsChemFactorF = 180.0; // °F — RG 1.99 R2 chemistry factor CF (Cu≈0.30/Ni≈0.60 weld); lands RT_PTS≈260 °F at 32 EFPY — source L575
const PtsFluenceEol1e19 = 3.0; // 10¹⁹ n/cm² (E>1 MeV) — EOL beltline inner-wall fast fluence at 60 EFPY — source L576
const PtsEfpyEol = 60.0; // EFPY corresponding to the EOL fluence above — source L577
const PtsSigmaDeltaWeldF = 28.0; // °F — RG 1.99 R2 σ_Δ on ΔRT_NDT for welds (capped at ½·ΔRT_NDT before squaring) — source L578
const PtsSigmaInitF = 0.0; // °F — σ_I on initial RT_NDT (0 when a measured value is used) — source L579
export const PtsScreeningLimitF = 270.0; // °F — 10 CFR 50.61(b)(2) screening criterion: plates/forgings/axial welds — source L580
export const PtsScreeningLimitCircF = 300.0; // °F — 10 CFR 50.61(b)(2) screening criterion: circumferential welds — source L581
// (b) Fracture toughness — the exact App-G K_IC constants re-anchored to RT_PTS; shelf-capped.
const PtsKicUpperShelfKsi = 200.0; // ksi·√in — upper-shelf cap on K_IC — source L584
// (c) Vessel geometry + SA-508/533B material (representative generic 4-loop RPV beltline).
const PtsVesselRinIn = 86.0; // in — beltline inner radius — source L586
const PtsVesselWallIn = 8.5; // in — base-metal wall thickness (R/t ≈ 10.1) — source L587
const PtsFlawDepthIn = 2.125; // in — ASME App-G postulated 1/4-thickness (a = 0.25·t) inner-surface reference flaw — source L588
const PtsThermStressPerF = 0.3064; // ksi/°F — E·α/(1−ν) = 28 600 ksi · 7.5e-6/°F / 0.7 — source L589
const PtsPressInfluence = 1.1; // — membrane SIF influence factor F_p for the a/t=0.25 surface flaw — source L590
const PtsThermInfluence = 0.7; // — thermal-gradient SIF influence factor F_th at a/t=0.25 — source L591
const PtsWallLagTauSec = 30.0; // s — single-pole lag of the near-inner-surface metal temp behind the downcomer fluid — source L592
const PtsDowncomerAdvisoryF = 400.0; // °F — downcomer temp below which the susceptible-condition advisory can arm — source L593
const PtsCooldownRateThreshC = 28.0; // °C/hr (~50 °F/hr) — |cooldown| beyond this counts as "fast" for the advisory — source L594
const PtsRepressRateMPaPerS = 0.05; // MPa/s — +dP/dt above this counts as "repressurizing" for the advisory — source L595
const PtsKiFloorKsi = 1e-6; // ksi·√in — floor on K_I to keep the margin ratio finite — source L596

const MpaToPsia = 145.038; // MPa → psia — source L2640
const ColdTemp = 35.0; // °C cold shutdown coolant temp (physics.ts ColdTemp / C# ColdTemp) — reset seed
export const DefaultVesselEfpy = 32.0; // EFPY — mid-life default age knob — source L852

/** MPa-abs → psig, exact gauge conversion: psig = (Pa − 101325)/6894.757. */
export function mpaAbsToPsig(mpa: number): number {
  return (mpa * 1.0e6 - 101325.0) / 6894.757;
}

/** Clamped piecewise-linear interpolation of ys(xs) at x (xs strictly increasing) — C# Lerp, source L4815. */
function lerpTable(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]!) return ys[0]!;
  const n = xs.length;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 1;
  while (i < n && x > xs[i]!) i++;
  const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
  return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
}

/** App G 容許 RCS 壓力 · App G allowable RCS pressure (MPa-abs) at a bulk Tcold (°C). Pure helper. */
export function appGAllowableMPaAt(tcoldC: number): number {
  return lerpTable(PtTempC, PtPmaxMPa, tcoldC);
}

// ----------------------------------------------------------------------- interfaces ----

/** Values the integrator reads OFF the reactor sim each tick and feeds in. */
export interface PtLimitsInputs {
  /** 冷腳溫度 · Bulk cold-leg temperature, °C (← sim.tcold). */
  tcoldC: number;
  /** 一回路壓力 · Primary (RCS) pressure, MPa-abs (← sim.primaryPressure). */
  primaryPressureMPa: number;
  /**
   * 容器輻照壽命 · Vessel age knob, effective full-power years 0–60 (default 32 = mid-life).
   * Changing it re-derives RT_PTS (more fluence ⇒ more embrittled) — C# VesselEfpy setter, source L853.
   */
  vesselEfpy?: number;
  /**
   * COUPLING (from the pressureRelief module, which consumes our `ltopArmed`): true while the
   * LTOP-armed low-setpoint PORV path is actively relieving. Drives the LTOP/COMS RELIEVING
   * annunciator only (C# LtopPorvOpen, set in the StepThermal PORV block). Safe default: false.
   */
  ltopPorvOpen?: boolean;
}

/** Effects for the integrator. This module raises flags only — it never writes plant state itself. */
export interface PtLimitsOutputs {
  /**
   * LTOP/COMS 已致動 · LTOP armed (Tcold below the enable temp, with hysteresis). The integrator
   * passes this to the pressureRelief module, which substitutes the low cold PORV setpoint
   * (lift ltopOpenSetpointMPa / reseat ltopReseatSetpointMPa) while asserted.
   */
  ltopArmed: boolean;
  /** LTOP PORV lift setpoint while armed, MPa-abs (constant 3.10 — published for the relief module). */
  ltopOpenSetpointMPa: number;
  /** LTOP PORV reseat setpoint, MPa-abs (constant 3.10 − 0.21 = 2.89 — strictly below the lift). */
  ltopReseatSetpointMPa: number;
  /** RCS 壓力已越過 App G P/T 限值 · Pressure above the App G allowable (display/annunciator only — no trip). */
  appGViolated: boolean;
  /** 承壓熱衝擊裂紋起裂預測 · Applied K_I ≥ K_IC at the embrittled RT_PTS curve (display-only advisory). */
  ptsFlawInitiation: boolean;
}

/** PTS 風險級別 · Informational PTS advisory ladder tier (never a trip). */
export type PtsRiskTier = 0 | 1 | 2 | 3; // 0 normal · 1 susceptible-condition watch · 2 low margin (K_IC/K_I < 2) · 3 flaw initiation predicted

/** Plain JSON-serializable display snapshot for the panel. */
export interface PtLimitsView {
  // echo of the operating point (so the panel is a pure function of the View)
  tcoldC: number;
  primaryPressureMPa: number;
  primaryPressurePsig: number;
  // App G envelope
  appGAllowableMPa: number;
  appGAllowablePsig: number;
  appGMarginMPa: number; // signed; negative = violation
  appGViolated: boolean;
  appGApproach: boolean; // within 1.0 MPa below the limit
  minBoltupTempC: number;
  coreCriticalMarginC: number;
  // heatup/cooldown rate
  heatupRateCPerHr: number; // signed EMA: + heatup, − cooldown
  heatupRateFPerHr: number;
  rateLimitCPerHr: number; // 55.56 (100 °F/hr)
  heatupRateAlarm: boolean; // rate > +90% of limit
  cooldownRateAlarm: boolean; // rate < −90% of limit
  // LTOP / COMS
  ltopArmed: boolean;
  ltopActiveAlarm: boolean; // armed path actively relieving (echo of the coupling input)
  ltopEnableTempC: number;
  ltopOpenPressureMPa: number;
  ltopReseatPressureMPa: number;
  // PTS monitor
  vesselEfpy: number;
  rtPtsF: number; // embrittled reference temperature RT_PTS, °F
  rtNdtC: number; // the same in °C for the metric readout
  ptsScreeningMarginF: number; // 270 − RT_PTS (negative = exceeds the 10 CFR 50.61 screen)
  wallTempC: number; // lagged inner-wall metal temperature, °C
  wallTempF: number;
  ptsKiPressureKsi: number;
  ptsKiThermalKsi: number; // signed; negative (compressive) on heatup
  ptsKiTotalKsi: number;
  ptsKicAtWallKsi: number;
  ptsMargin: number; // K_IC / K_I; < 1 ⇒ initiation predicted
  ptsSusceptible: boolean;
  ptsFlawInitiation: boolean;
  ptsRiskTier: PtsRiskTier;
  ptsAdvisoryEn: string;
  ptsAdvisoryZh: string;
  // annunciators — parallel En/Zh arrays, exactly like physics.ts activeAlarmsEn/Zh
  alarmsEn: string[];
  alarmsZh: string[];
  // App-G curve knots for the panel polyline (copies — safe to hand to the renderer)
  curveTempC: number[];
  curvePressMPa: number[];
}

// ----------------------------------------------------------- bilingual alarm strings ----
// Lifted verbatim from the C# UI alarm table (Pages/ReactorModule.xaml.cs L1446–1451) and the
// PTS watch chip (L1085) — NOT machine-translated.
const AlarmText = {
  ptApproach: { en: 'P/T LIMIT APPROACH', zh: 'P/T 限值接近' },
  ptViolation: { en: 'APP G P/T VIOLATION', zh: '附錄G P/T 越限' },
  rcsRate: { en: 'RCS HEAT/COOL RATE HI', zh: 'RCS 升降溫率過高' },
  ltopActive: { en: 'LTOP/COMS RELIEVING', zh: '低溫超壓保護洩放' },
  ptsSusceptible: { en: 'PTS SUSCEPTIBLE COND.', zh: '承壓熱衝擊敏感工況' },
  ptsFlaw: { en: 'PTS FLAW INITIATION', zh: '承壓熱衝擊裂紋起裂' },
} as const;

// PTS advisory ladder texts (tier → operator guidance). Tier names reuse the C# wording where it
// exists (承壓熱衝擊警戒 = "PTS WATCH", ReactorModule.xaml.cs L1085); tier 0/2 lines are additive.
const PtsAdvisory: readonly { en: string; zh: string }[] = [
  { en: 'PTS: normal — no overcooling condition', zh: '承壓熱衝擊：正常 — 無過冷工況' },
  { en: 'PTS WATCH — overcooling / repressurization condition', zh: '承壓熱衝擊警戒 — 過冷／再升壓工況' },
  { en: 'PTS margin low — K_IC/K_I below 2, limit repressurization', zh: '承壓熱衝擊裕度偏低 — K_IC/K_I 低於 2，限制再升壓' },
  { en: 'PTS FLAW INITIATION predicted — K_I at or above K_IC', zh: '承壓熱衝擊裂紋起裂預測 — K_I 已達或超過 K_IC' },
];

// --------------------------------------------------------------------------- monitor ----

/**
 * P/T 限值監測器 · Appendix-G P/T envelope + heatup/cooldown rate + LTOP arming + PTS monitor.
 * Deterministic: all state advances only through step(inputs, dt) with dt in SIMULATED seconds.
 * The EMA/lag forms use the exact discrete single-pole α = dt/(τ+dt) of the C# source, which is
 * unconditionally stable at any dt, so no internal sub-stepping is needed.
 */
export class PtLimitMonitor {
  // ---- App G / rate state (C# L829–831, L4838–4862) ----
  private _prevTcoldForRate = ColdTemp; // last tick's Tcold, for the heatup/cooldown finite difference — source L830
  private _rateInit = false; // seeds the rate signal on the first sample (no startup spike) — source L831
  private _rateCperHr = 0; // EMA-filtered signed RCS heatup(+)/cooldown(−) rate, °C/hr
  private _allowableMPa = appGAllowableMPaAt(ColdTemp); // cached App G allowable at current Tcold
  private _marginMPa = 0;
  private _violation = false;
  private _approach = false;
  private _ltopArmed = false; // C# LtopArmed — source L843
  private _ltopPorvOpen = false; // echo of the coupling input (annunciator only)

  // ---- PTS state (C# L847–871, L4892–4931) ----
  private _ptsWallInit = false; // seeds the wall-temp lag on the first sample — source L848
  private _wallTempF = ColdTemp * 1.8 + 32.0; // lagged inner-wall metal temperature, °F — source L858
  private _ptsPressInit = false; // seeds the repressurization detector (C# reset seeds _ptsPrevPressMPa — source L2823)
  private _ptsPrevPressMPa = 0; // last tick's pressure, for the repressurization-rate detector — source L849
  private _vesselEfpy = DefaultVesselEfpy; // EFPY age knob, default mid-life — source L852
  private _rtPtsF = 0; // embrittled RT_PTS, °F — source L855
  private _kiPressKsi = 0;
  private _kiThermKsi = 0;
  private _kiTotalKsi = 0;
  private _kicWallKsi = PtsKicUpperShelfKsi;
  private _ptsMargin = 99.0; // C# init — source L868
  private _susceptible = false;
  private _flawInit = false;

  // last inputs echoed into the view
  private _tcoldC = ColdTemp;
  private _pressMPa = 0.1;

  constructor() {
    this.computeRtPts();
  }

  /**
   * 計算 RT_PTS · RG 1.99 Rev.2 embrittlement: ΔRT_NDT = CF·f^(0.28−0.10·log₁₀ f) with the fluence
   * scaled linearly from the EOL value by EFPY; Margin = 2·√(σ_I² + σ_Δ²), σ_Δ capped at ½·ΔRT_NDT.
   * Called from the ctor, reset(), and on an EFPY change — NOT per tick (C# ComputeRtPts, L4870–4879).
   */
  private computeRtPts(): void {
    const fa = PtsFluenceEol1e19 * (this._vesselEfpy / PtsEfpyEol); // fast fluence in 10¹⁹ n/cm², scaled by age
    const ff = fa <= 0.0 ? 0.0 : Math.pow(fa, 0.28 - 0.1 * Math.log10(fa)); // RG 1.99 R2 fluence factor (guard f>0)
    const deltaRtNdt = PtsChemFactorF * ff;
    const sigmaDelta = Math.min(PtsSigmaDeltaWeldF, 0.5 * deltaRtNdt); // RG 1.99 R2 cap, applied before squaring
    const margin = 2.0 * Math.sqrt(PtsSigmaInitF * PtsSigmaInitF + sigmaDelta * sigmaDelta);
    this._rtPtsF = PtsRtNdtInitF + deltaRtNdt + margin;
  }

  /**
   * One monitor step. dt = SIMULATED seconds (typically 0.2–2 s). Order mirrors the C# outer tick:
   * UpdatePtLimits first, then UpdatePtsMonitor (so the PTS advisory reads the final smoothed rate).
   */
  step(inp: PtLimitsInputs, dt: number): PtLimitsOutputs {
    const tcold = inp.tcoldC;
    const press = inp.primaryPressureMPa;
    this._tcoldC = tcold;
    this._pressMPa = press;

    // EFPY age knob (re-derives RT_PTS only when it actually changes — C# VesselEfpy setter, L853).
    const efpy = _clamp(inp.vesselEfpy ?? DefaultVesselEfpy, 0.0, 60.0);
    if (efpy !== this._vesselEfpy) {
      this._vesselEfpy = efpy;
      this.computeRtPts();
    }

    // ================= UpdatePtLimits (C# L4838–4862) =================
    // (1) App G allowable pressure at the indicated cold-leg temperature.
    this._allowableMPa = lerpTable(PtTempC, PtPmaxMPa, tcold);
    this._marginMPa = this._allowableMPa - press; // C# PtMarginMPa — source L836
    this._violation = press > this._allowableMPa; // C# PtViolation — source L837

    // (2) Smoothed signed RCS heatup(+)/cooldown(−) rate, °C/hr (single-pole EMA; first sample
    //     seeds it; below RateSampleMinDt the previous sample is deliberately NOT advanced — C# quirk).
    if (!this._rateInit) {
      this._prevTcoldForRate = tcold;
      this._rateInit = true;
    } else if (dt >= RateSampleMinDt) {
      const inst = ((tcold - this._prevTcoldForRate) / dt) * 3600.0; // instantaneous °C/hr
      const a = dt / (RateFilterTauSec + dt); // exact discrete single-pole α
      this._rateCperHr += a * (inst - this._rateCperHr);
      this._prevTcoldForRate = tcold;
    }

    // (3) LTOP arm/disarm with hysteresis so the boundary doesn't chatter.
    if (tcold < LtopEnableTempC) this._ltopArmed = true;
    else if (tcold > LtopEnableTempC + LtopEnableHystC) this._ltopArmed = false;

    // (4) Annunciator conditions (the valve itself lives in the pressureRelief module; we only echo).
    this._approach = this._marginMPa < PtApproachWarnMPa && this._marginMPa >= 0.0;
    this._ltopPorvOpen = inp.ltopPorvOpen ?? false;

    // ================= UpdatePtsMonitor (C# L4892–4931) =================
    // (1) Downcomer fluid temperature (°F) and the lagged near-inner-surface wall metal temperature.
    const tFluidF = tcold * 1.8 + 32.0;
    if (!this._ptsWallInit) {
      this._wallTempF = tFluidF;
      this._ptsWallInit = true;
    } else {
      const aW = dt / (PtsWallLagTauSec + dt); // exact discrete single-pole α (matches the C# EMA form)
      this._wallTempF += aW * (tFluidF - this._wallTempF);
    }

    // (2a) Pressure (membrane) SIF: thin-wall hoop σ = p·R/t (psi → ksi), K_Ip = F_p·σ·√(πa).
    const pPsi = press * MpaToPsia;
    const sigmaHoopKsi = (pPsi * PtsVesselRinIn) / PtsVesselWallIn / 1000.0;
    this._kiPressKsi = PtsPressInfluence * sigmaHoopKsi * Math.sqrt(Math.PI * PtsFlawDepthIn);

    // (2b) Thermal SIF from the lag-induced gradient: σ_th = E·α/(1−ν)·(T_wall − T_fluid). Positive
    //      (crack-opening) only while the wall is HOTTER than the rapidly cooling fluid — i.e. during
    //      a cooldown. On heatup ΔT < 0 (compressive) → discard the tensile contribution.
    const deltaTF = this._wallTempF - tFluidF;
    this._kiThermKsi = PtsThermInfluence * (PtsThermStressPerF * deltaTF) * Math.sqrt(Math.PI * PtsFlawDepthIn);
    const kiThermalTensile = Math.max(0.0, this._kiThermKsi);

    // (3) Total applied SIF and the App-G K_IC at the wall temp, re-anchored to RT_PTS, shelf-capped.
    this._kiTotalKsi = this._kiPressKsi + kiThermalTensile;
    this._kicWallKsi = Math.min(
      PtsKicUpperShelfKsi,
      KicFloorKsi + KicCoeffB * Math.exp(KicExpCoeff * (this._wallTempF - this._rtPtsF)),
    );

    // (4) Margin = toughness ÷ applied SIF (< 1 ⇒ predicted initiation).
    this._ptsMargin = this._kicWallKsi / Math.max(this._kiTotalKsi, PtsKiFloorKsi);

    // (5) Advisory conditions (display-only; never a trip). First sample seeds the pressure memory
    //     so a fresh scenario shows no repressurization spike (C# reset seeds _ptsPrevPressMPa, L2823).
    if (!this._ptsPressInit) {
      this._ptsPrevPressMPa = press;
      this._ptsPressInit = true;
    }
    const dPdt = dt > 1e-9 ? (press - this._ptsPrevPressMPa) / dt : 0.0; // MPa/s
    this._susceptible =
      tFluidF < PtsDowncomerAdvisoryF &&
      (this._rateCperHr < -PtsCooldownRateThreshC || dPdt > PtsRepressRateMPaPerS);
    this._flawInit = this._kiTotalKsi >= this._kicWallKsi;
    this._ptsPrevPressMPa = press;

    return {
      ltopArmed: this._ltopArmed,
      ltopOpenSetpointMPa: LtopOpenPressureMPa,
      ltopReseatSetpointMPa: LtopOpenPressureMPa - LtopCloseHystMPa,
      appGViolated: this._violation,
      ptsFlawInitiation: this._flawInit,
    };
  }

  /** 風險級別 · The informational PTS ladder tier (3 initiation > 2 low margin > 1 watch > 0 normal). */
  private ptsRiskTier(): PtsRiskTier {
    if (this._flawInit) return 3;
    if (this._ptsMargin < 2.0) return 2;
    if (this._susceptible) return 1;
    return 0;
  }

  /** Plain display snapshot — everything the panel needs, JSON-serializable, no live references. */
  view(): PtLimitsView {
    const rateAlarmAbs = AppGRateLimitCperHr * RateAlarmFraction; // 50.0 °C/hr
    const heatupAlarm = this._rateCperHr > rateAlarmAbs;
    const cooldownAlarm = this._rateCperHr < -rateAlarmAbs;
    const tier = this.ptsRiskTier();
    const advisory = PtsAdvisory[tier]!;

    const en: string[] = [];
    const zh: string[] = [];
    const add = (k: keyof typeof AlarmText) => {
      en.push(AlarmText[k].en);
      zh.push(AlarmText[k].zh);
    };
    // Same set + assertion conditions as the C# SetAlarm block (L4858–4861, L4927–4928).
    if (this._approach) add('ptApproach');
    if (this._violation) add('ptViolation');
    if (Math.abs(this._rateCperHr) > rateAlarmAbs) add('rcsRate');
    if (this._ltopPorvOpen) add('ltopActive');
    if (this._susceptible) add('ptsSusceptible');
    if (this._flawInit) add('ptsFlaw');

    return {
      tcoldC: this._tcoldC,
      primaryPressureMPa: this._pressMPa,
      primaryPressurePsig: mpaAbsToPsig(this._pressMPa),
      appGAllowableMPa: this._allowableMPa,
      appGAllowablePsig: mpaAbsToPsig(this._allowableMPa),
      appGMarginMPa: this._marginMPa,
      appGViolated: this._violation,
      appGApproach: this._approach,
      minBoltupTempC: MinBoltupTempC,
      coreCriticalMarginC: CoreCriticalMarginC,
      heatupRateCPerHr: this._rateCperHr,
      heatupRateFPerHr: this._rateCperHr * 1.8, // C# RcsRateFperHr — source L841
      rateLimitCPerHr: AppGRateLimitCperHr,
      heatupRateAlarm: heatupAlarm,
      cooldownRateAlarm: cooldownAlarm,
      ltopArmed: this._ltopArmed,
      ltopActiveAlarm: this._ltopPorvOpen,
      ltopEnableTempC: LtopEnableTempC,
      ltopOpenPressureMPa: LtopOpenPressureMPa,
      ltopReseatPressureMPa: LtopOpenPressureMPa - LtopCloseHystMPa,
      vesselEfpy: this._vesselEfpy,
      rtPtsF: this._rtPtsF,
      rtNdtC: (this._rtPtsF - 32.0) / 1.8,
      ptsScreeningMarginF: PtsScreeningLimitF - this._rtPtsF, // C# PtsScreeningMarginF — source L856
      wallTempC: (this._wallTempF - 32.0) / 1.8,
      wallTempF: this._wallTempF,
      ptsKiPressureKsi: this._kiPressKsi,
      ptsKiThermalKsi: this._kiThermKsi,
      ptsKiTotalKsi: this._kiTotalKsi,
      ptsKicAtWallKsi: this._kicWallKsi,
      ptsMargin: this._ptsMargin,
      ptsSusceptible: this._susceptible,
      ptsFlawInitiation: this._flawInit,
      ptsRiskTier: tier,
      ptsAdvisoryEn: advisory.en,
      ptsAdvisoryZh: advisory.zh,
      alarmsEn: en,
      alarmsZh: zh,
      curveTempC: [...PtTempC],
      curvePressMPa: [...PtPmaxMPa],
    };
  }

  /**
   * 重置 · Back to a fresh cold scenario: clear the rate seed (no first-tick spike), disarm LTOP,
   * re-seed the wall-temp lag cold, refresh RT_PTS for the current age knob (C# Reset, L2819–2824).
   * The EFPY knob itself is retained, exactly like the C# `_vesselEfpy` field across Reset.
   */
  reset(): void {
    this._rateInit = false;
    this._rateCperHr = 0;
    this._prevTcoldForRate = ColdTemp;
    this._ltopArmed = false;
    this._ltopPorvOpen = false;
    this._allowableMPa = appGAllowableMPaAt(ColdTemp);
    this._marginMPa = 0;
    this._violation = false;
    this._approach = false;
    this._ptsWallInit = false;
    this._wallTempF = ColdTemp * 1.8 + 32.0;
    this._ptsPressInit = false;
    this._ptsPrevPressMPa = 0;
    this._susceptible = false;
    this._flawInit = false;
    this._ptsMargin = 99.0;
    this._kiPressKsi = 0;
    this._kiThermKsi = 0;
    this._kiTotalKsi = 0;
    this._kicWallKsi = PtsKicUpperShelfKsi;
    this._tcoldC = ColdTemp;
    this._pressMPa = 0.1;
    this.computeRtPts();
  }
}
