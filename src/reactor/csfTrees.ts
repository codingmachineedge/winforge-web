// 關鍵安全功能狀態樹 · Westinghouse Critical Safety Function Status Trees (CSFST / F-0 monitoring).
//
// A pure, deterministic, framework-free TypeScript port of the six Emergency Response Guideline
// status trees from WinForge's C# `ReactorSimService` (Services/ReactorSimService.cs, regions
// L24–46 CsfStatus/CsfState and L5536–5699 UpdateCriticalSafetyFunctions):
//
//   F-0.1 S — Subcriticality  次臨界度      (flux + startup rate; ATWS → FR-S.1)
//   F-0.2 C — Core Cooling    堆芯冷卻      (core-exit TCs / ICC monitor → FR-C.1/2/3)
//   F-0.3 H — Heat Sink       熱阱          (SG narrow-range level + feed sources → FR-H.1/5)
//   F-0.4 P — RCS Integrity   一迴路完整性  (pressure boundary / PTS → FR-P.1/2)
//   F-0.5 Z — Containment     安全殼        (pressure / radiation / damage → FR-Z.1/3)
//   F-0.6 I — RCS Inventory   一迴路存量    (pressurizer level + RVLIS → FR-I.1/2/3)
//
// This is a PURE CLASSIFIER: `step()` re-evaluates all six trees each tick from the sampled plant
// signals — no physics is recomputed here and no latches exist in the C# original (WorstCsfStatus
// and HighestPriorityCsf are recomputed fresh every tick, source L5545–5553). Each tree is ordered
// Red→Orange→Yellow→Green with an Invalid (insufficient-data) guard first on its driving sensor,
// exactly like the source. Status ordinal ordering matters: Invalid(0) < Green(1) < Yellow(2) <
// Orange(3) < Red(4) — the annunciator takes the MAX ordinal, so a grey Invalid ranks BELOW Green
// (source L20–24 comment, preserved verbatim as a behavioural quirk).
//
// The module never mutates the reactor sim; the integrator samples Inputs from `ReactorSim`,
// calls `step()`, and treats the Outputs as ADVISORY annunciator drives only.

import { VesselPressureLimit } from './physics';

// ------------------------------------------------------------------ status enum ----
/** CsfStatus (source L24): Invalid=0, Green=1, Yellow=2, Orange=3, Red=4. */
export type CsfStatusLevel = 'invalid' | 'green' | 'yellow' | 'orange' | 'red';

/** Ordinal rank used for worst-of-six (source L24 enum values + L5547 max scan). */
export const CsfStatusRank: Readonly<Record<CsfStatusLevel, number>> = {
  invalid: 0,
  green: 1,
  yellow: 2,
  orange: 3,
  red: 4,
};

// ------------------------------------------------------------------ constants ----
// All thresholds carry their C# provenance; values/units copied EXACTLY.

// ---- F-0.1 Subcriticality ----
const AtwsPowerFrac = 0.05; //     >5 % RTP after a trip → ATWS RED (source L5564)
const AtwsSurDpm = 1.0; //         SUR > 1 DPM after a trip → ATWS RED (source L5564)
const OverpowerFrac = 1.05; //     un-tripped overpower >105 % RTP → ORANGE (source L5568)
const SurYellowDpm = 0.5; //       uncontrolled positive startup rate → YELLOW (source L5572)

// ---- F-0.2 Core Cooling (ICC monitor bools, re-derived verbatim) ----
const IccRedTempC = 649.0; //      ICC RED / FR-C.1 — 1200 °F core-exit TC (source L1205)
const IccOrangeTempC = 371.0; //   ICC ORANGE / FR-C.2 — 700 °F core-exit TC (source L1206)
const SubcoolYellowC = 11.0; //    low subcooling margin <11 °C ≈ 20 °F → YELLOW (source L5597)
export const RvlisTopOfFuelPct = 62.0; // RVLIS full-range % at top of active fuel (source L1129, L5597, L5682)

// ---- F-0.3 Heat Sink ----
const SgLoLoLevelPct = 17.0; //    SG NR level lo-lo setpoint (~17 %) (source L5613, L5616)
const SgLowLevelPct = 30.0; //     low/recovering level → YELLOW (source L5620)
const FeedNoFlowFrac = 0.02; //    "no feed" flow fraction for total-loss RED (source L5613)
const FeedMarginalFrac = 0.05; //  marginal-feed flow fraction for YELLOW (source L5620)

// ---- F-0.4 RCS Integrity ----
// RED above VesselPressureLimit (17.2 MPa design pressure, physics.ts L133 / source L5636);
const IntegrityOrangeBandMPa = 1.0; // ORANGE within 1 MPa of the limit (source L5640)
const CooldownYellowCPerHr = -55.0; // cooldown faster than ~100 °F/hr App-G limit → YELLOW (source L5644)

// ---- F-0.5 Containment (kPa GAUGE; psig = kPa/6.895, source L1844) ----
export const CtmtHi3Kpa = 186.0; // Hi-3 spray/design setpoint ~186 kPa ≈ 27 psig → RED (source L5659)
export const CtmtHi1Kpa = 28.0; //  Hi-1 ~28 kPa ≈ 4 psig → ORANGE (source L5663)
const RadMonitorRedRatio = 1.0; //  particulate/gaseous monitor at alarm ratio → RED (source L5658)
const RadMonitorYellowRatio = 0.5; // elevated rad → YELLOW (source L5667)
const DamageOrangeThreshold = 1.0; // accumulating core damage → ORANGE (source L5663)
const SumpYellowGal = 500.0; //     containment sump rising → YELLOW (source L5667)

// ---- F-0.6 RCS Inventory ----
const PzrOffScaleLowPct = 5.0; //  PZR level off-scale-low (RED with RVLIS < top of fuel) (source L5682)
const PzrOrangeLowPct = 17.0; //   PZR level low-low → ORANGE (source L5686)
const PzrYellowLowPct = 30.0; //   PZR level low → YELLOW FR-I.1 (source L5690)
const PzrYellowHighPct = 92.0; //  PZR overfill, solid-plant risk → YELLOW FR-I.3 (source L5690, L5692)

// psig ↔ Pa-abs conversion used only by tests/telemetry: psig = (Pa − 101325) / 6894.757.
export const PsiPa = 6894.757; // Pa per psi
export const AtmPa = 101325.0; // Pa, one standard atmosphere

// ------------------------------------------------------------------ interfaces ----

/**
 * Sampled plant signals. All plain numbers/booleans READ from the sim by the integrator each tick.
 * Where the C# input has no TS counterpart yet, the documented safe default keeps the branch
 * evaluating exactly as the source would in a healthy plant.
 */
export interface CsfTreesInputs {
  // ---- F-0.1 Subcriticality ----
  /** Neutron power, fraction of rated (C# NeutronPowerFraction, source L643). NaN ⇒ tree Invalid. */
  powerFraction: number;
  /** Startup rate, decades per minute (C# StartupRateDpm, source L1392). */
  startupRateDpm: number;
  /** Reactor trip demanded (C# IsScrammed). */
  scrammed: boolean;

  // ---- F-0.2 Core Cooling ----
  /** Core-exit thermocouple °C (C# CoreExitTempC, source L1372). No TS counterpart yet — safe default: thot °C. NaN ⇒ Invalid. */
  coreExitTempC: number;
  /** CET subcooling margin °C (C# CetSubcoolingMarginC, source L1376). Safe default: sim.subcoolingMarginC. */
  subcoolingMarginC: number;
  /** RVLIS full-range % (C# RvlisFullRangePct, source L1129). No TS counterpart yet — safe default: 100. */
  rvlisPct: number;

  // ---- F-0.3 Heat Sink ----
  /** SG narrow-range level % (C# SteamGenLevel). No TS counterpart yet — safe default: 30 + 34·feedwaterFlow (≈64 % at full feed). NaN ⇒ Invalid. */
  sgLevelPct: number;
  /** Main feedwater flow, fraction of rated (C# FeedwaterFlow — sim.feedwaterFlow). */
  feedwaterFlow: number;
  /** Aux feedwater running (C# AuxFeedwaterRunning). No TS counterpart yet — safe default: false. */
  auxFeedwaterRunning: boolean;

  // ---- F-0.4 RCS Integrity ----
  /** RCS pressure, MPa ABSOLUTE (C# PrimaryPressure — sim.primaryPressure). NaN ⇒ Invalid. */
  primaryPressureMPa: number;
  /** Smoothed RCS heatup(+)/cooldown(−) rate °C/hr (C# RcsRateCperHr, source L839). No TS counterpart yet — safe default: 0. */
  heatupRateCPerHr: number;

  // ---- F-0.5 Containment (always-valid model state — no Invalid guard, source L5655) ----
  /** Severe-accident latch (C# Mode == ReactorMode.Meltdown — sim.mode === 'Meltdown'). */
  meltdown: boolean;
  /** Containment pressure, kPa GAUGE (C# ContainmentPressureKpa, source L1843). No TS counterpart yet — safe default: 0. */
  containmentPressureKpaG: number;
  /** Particulate rad monitor reading/alarm-setpoint ratio (C# ParticulateMonitorRatio, source L1905). Safe default: 0. */
  particulateMonitorRatio: number;
  /** Gaseous rad monitor ratio (C# GaseousMonitorRatio, source L1907). Safe default: 0. */
  gaseousMonitorRatio: number;
  /** Accumulated core damage 0..100+ (C# DamageAccumulation — sim.damageAccumulation). */
  damageAccumulation: number;
  /** Containment sump inventory, gallons (C# ContainmentSumpGal, source L1901). No TS counterpart yet — safe default: 0. */
  sumpGal: number;

  // ---- F-0.6 RCS Inventory ----
  /** Pressurizer level % (C# PressurizerLevel — sim.pressurizerLevel). NaN ⇒ Invalid. */
  pressurizerLevelPct: number;

  // ---- reserved (sampled but not read by any C# branch — accepted for forward coupling) ----
  reactivityPcm?: number; //      sim.reactivityPcm — reserved
  sourceRangeCps?: number; //     sim.sourceRangeCps — reserved
  thotC?: number; //              sim.thot — reserved (also the coreExitTempC default)
  tcoldC?: number; //             sim.tcold — reserved
  steamPressureMPa?: number; //   sim.steamPressure — reserved
  sealLocaActive?: boolean; //    RCP seal-LOCA module coupling — reserved, default false
  appGViolated?: boolean; //      App-G P/T-limit module coupling — reserved, default false
}

/** Advisory annunciator drives — the integrator applies NO physics from these. */
export interface CsfTreesOutputs {
  /** MAX-ordinal status across the six trees (C# WorstCsfStatus, source L5548). */
  worstStatus: CsfStatusLevel;
  /** Any tree RED — the CSF board's flashing master alarm condition. */
  anyRed: boolean;
  /** Number of trees above Green (Yellow/Orange/Red) — challenge tally for the annunciator. */
  challengeCount: number;
  /** Entry FRG of the highest-priority challenged tree in S,C,H,P,Z,I order (C# HighestPriorityCsf, source L5550–5553), or null. */
  highestPriorityFrId: string | null;
}

/** One evaluated tree — mirrors the C# CsfState struct (source L32–46). */
export interface CsfStateView {
  mnemonic: 'S' | 'C' | 'H' | 'P' | 'Z' | 'I';
  nameEn: string;
  nameZh: string;
  status: CsfStatusLevel;
  /** Entry Function Restoration Guideline, e.g. "FR-C.1" — or "--" when satisfied/invalid (source L37). */
  frId: string;
  conditionEn: string;
  conditionZh: string;
}

/** JSON-serializable display snapshot. */
export interface CsfTreesView {
  /** The six trees in fixed S,C,H,P,Z,I priority order (source L5538–5543). */
  csf: CsfStateView[];
  worstStatus: CsfStatusLevel;
  anyRed: boolean;
  /** Mnemonic of the first tree above Green in priority order, or null when all satisfied. */
  highestPriorityMnemonic: string | null;
  highestPriorityFrId: string | null;
}

// ------------------------------------------------------------------ helpers ----
const f0 = (x: number): string => x.toFixed(0); // C# :F0
const f1 = (x: number): string => x.toFixed(1); // C# :F1

function mk(
  m: CsfStateView['mnemonic'],
  nEn: string,
  nZh: string,
  s: CsfStatusLevel,
  frg: string,
  cEn: string,
  cZh: string,
): CsfStateView {
  return { mnemonic: m, nameEn: nEn, nameZh: nZh, status: s, frId: frg, conditionEn: cEn, conditionZh: cZh };
}

/** Pre-first-scan placeholder — grey Invalid until the first step() samples the plant. */
function awaiting(m: CsfStateView['mnemonic'], nEn: string, nZh: string): CsfStateView {
  return mk(m, nEn, nZh, 'invalid', '--', 'Awaiting first scan', '等待首次掃描');
}

// ------------------------------------------------------------------ evaluator ----

/**
 * 六個關鍵安全功能狀態樹評估器 · The six-tree CSF evaluator. Stateless between ticks apart from the
 * cached view (the C# recomputes everything every tick — no latches/hysteresis in this subsystem).
 */
export class CsfEvaluator {
  private _csf: CsfStateView[] = CsfEvaluator.initialBoard();
  private _worst: CsfStatusLevel = 'invalid';
  private _anyRed = false;
  private _challengeCount = 0;
  private _topMnemonic: string | null = null;
  private _topFrId: string | null = null;

  private static initialBoard(): CsfStateView[] {
    return [
      awaiting('S', 'Subcriticality', '次臨界度'),
      awaiting('C', 'Core Cooling', '堆芯冷卻'),
      awaiting('H', 'Heat Sink', '熱阱'),
      awaiting('P', 'RCS Integrity', '一迴路完整性'),
      awaiting('Z', 'Containment', '安全殼'),
      awaiting('I', 'RCS Inventory', '一迴路存量'),
    ];
  }

  /** Re-evaluate all six trees from the sampled signals. `dt` is accepted for interface parity — the classifier is memoryless (source L5536 takes dt and ignores it too). */
  step(inp: CsfTreesInputs, dt: number): CsfTreesOutputs {
    void dt; // pure classifier — no time integration (mirrors UpdateCriticalSafetyFunctions)

    this._csf = [
      this.evalSubcriticality(inp),
      this.evalCoreCooling(inp),
      this.evalHeatSink(inp),
      this.evalIntegrity(inp),
      this.evalContainment(inp),
      this.evalInventory(inp),
    ];

    // Worst = MAX ordinal (Invalid < Green < Yellow < Orange < Red), source L5545–5548.
    let worst: CsfStatusLevel = 'green';
    let challenges = 0;
    for (let i = 0; i < this._csf.length; i++) {
      const s = this._csf[i]!.status;
      if (CsfStatusRank[s] > CsfStatusRank[worst]) worst = s;
      if (CsfStatusRank[s] > CsfStatusRank.green) challenges++;
    }
    this._worst = worst;
    this._anyRed = worst === 'red';
    this._challengeCount = challenges;

    // Highest-priority challenged tree: first above Green in S,C,H,P,Z,I order (source L5550–5553).
    this._topMnemonic = null;
    this._topFrId = null;
    for (let i = 0; i < this._csf.length; i++) {
      const c = this._csf[i]!;
      if (CsfStatusRank[c.status] > CsfStatusRank.green) {
        this._topMnemonic = c.mnemonic;
        this._topFrId = c.frId;
        break;
      }
    }

    return {
      worstStatus: this._worst,
      anyRed: this._anyRed,
      challengeCount: this._challengeCount,
      highestPriorityFrId: this._topFrId,
    };
  }

  view(): CsfTreesView {
    return {
      csf: this._csf.map((c) => ({ ...c })),
      worstStatus: this._worst,
      anyRed: this._anyRed,
      highestPriorityMnemonic: this._topMnemonic,
      highestPriorityFrId: this._topFrId,
    };
  }

  reset(): void {
    this._csf = CsfEvaluator.initialBoard();
    this._worst = 'invalid';
    this._anyRed = false;
    this._challengeCount = 0;
    this._topMnemonic = null;
    this._topFrId = null;
  }

  // ---- F-0.1 SUBCRITICALITY (source L5559–5578) — power-range flux + startup rate. RED = trip
  // demanded yet >5 % RTP or positive SUR (ATWS) → FR-S.1; ORANGE = un-tripped overpower >105 % RTP;
  // YELLOW = uncontrolled positive startup rate → FR-S.2.
  private evalSubcriticality(inp: CsfTreesInputs): CsfStateView {
    if (Number.isNaN(inp.powerFraction)) // C# double.IsNaN — ±Infinity still classifies (source L5561)
      return mk('S', 'Subcriticality', '次臨界度', 'invalid', '--', 'NIS flux invalid', '中子通量訊號失效');
    if (inp.scrammed && (inp.powerFraction > AtwsPowerFrac || inp.startupRateDpm > AtwsSurDpm))
      return mk(
        'S', 'Subcriticality', '次臨界度', 'red', 'FR-S.1',
        `Power ${f1(inp.powerFraction * 100)}% after trip — ATWS`,
        `跳機後功率 ${f1(inp.powerFraction * 100)}% — 未能停堆 (ATWS)`,
      );
    if (!inp.scrammed && inp.powerFraction > OverpowerFrac)
      return mk(
        'S', 'Subcriticality', '次臨界度', 'orange', 'FR-S.1',
        `Overpower ${f0(inp.powerFraction * 100)}% RTP`,
        `超功率 ${f0(inp.powerFraction * 100)}% RTP`,
      );
    if (inp.startupRateDpm > SurYellowDpm)
      return mk(
        'S', 'Subcriticality', '次臨界度', 'yellow', 'FR-S.2',
        `Positive startup rate ${f1(inp.startupRateDpm)} DPM`,
        `正向啟動率 ${f1(inp.startupRateDpm)} DPM`,
      );
    return mk('S', 'Subcriticality', '次臨界度', 'green', '--', 'Reactor subcritical', '反應堆次臨界');
  }

  // ---- F-0.2 CORE COOLING (source L5584–5603) — core-exit TCs / ICC monitor. The IccRed/IccOrange
  // bools are re-derived verbatim from the C# expressions (source L1378–1379): RED = CET ≥ 649 °C;
  // ORANGE = CET ≥ 371 °C OR subcooling ≤ 0. YELLOW = subcooling < 11 °C or RVLIS < 62 % → FR-C.3.
  private evalCoreCooling(inp: CsfTreesInputs): CsfStateView {
    if (Number.isNaN(inp.coreExitTempC)) // C# double.IsNaN (source L5586)
      return mk('C', 'Core Cooling', '堆芯冷卻', 'invalid', '--', 'Core-exit TCs invalid', '堆芯出口熱電偶失效');
    const iccRed = inp.coreExitTempC >= IccRedTempC; //                       source L1378
    const iccOrange = inp.coreExitTempC >= IccOrangeTempC || inp.subcoolingMarginC <= 0.0; // source L1379
    if (iccRed)
      return mk(
        'C', 'Core Cooling', '堆芯冷卻', 'red', 'FR-C.1',
        `CET ${f0(inp.coreExitTempC)}°C ≥ 649°C — core damage imminent`,
        `堆芯出口 ${f0(inp.coreExitTempC)}°C ≥ 649°C — 堆芯損毀逼近`,
      );
    if (iccOrange)
      return mk(
        'C', 'Core Cooling', '堆芯冷卻', 'orange', 'FR-C.2',
        `CET ${f0(inp.coreExitTempC)}°C / subcooling lost`,
        `堆芯出口 ${f0(inp.coreExitTempC)}°C / 喪失過冷裕度`,
      );
    if (inp.subcoolingMarginC < SubcoolYellowC || inp.rvlisPct < RvlisTopOfFuelPct)
      return mk(
        'C', 'Core Cooling', '堆芯冷卻', 'yellow', 'FR-C.3',
        `Subcooling ${f0(inp.subcoolingMarginC)}°C / RVLIS ${f0(inp.rvlisPct)}%`,
        `過冷裕度 ${f0(inp.subcoolingMarginC)}°C / RVLIS ${f0(inp.rvlisPct)}%`,
      );
    return mk('C', 'Core Cooling', '堆芯冷卻', 'green', '--', 'Adequate core cooling', '堆芯冷卻充足');
  }

  // ---- F-0.3 HEAT SINK (source L5608–5626) — SG narrow-range level + feed sources. RED = level
  // below lo-lo AND no feed (main or aux) → total loss of heat sink, FR-H.1; ORANGE = NR level below
  // lo-lo (~17 %); YELLOW = low/recovering level or marginal feed → FR-H.5.
  private evalHeatSink(inp: CsfTreesInputs): CsfStateView {
    if (Number.isNaN(inp.sgLevelPct)) // C# double.IsNaN (source L5610)
      return mk('H', 'Heat Sink', '熱阱', 'invalid', '--', 'SG level invalid', '蒸汽發生器水位訊號失效');
    if (inp.sgLevelPct < SgLoLoLevelPct && !inp.auxFeedwaterRunning && inp.feedwaterFlow < FeedNoFlowFrac)
      return mk('H', 'Heat Sink', '熱阱', 'red', 'FR-H.1', 'Total loss of SG feedwater', '完全喪失蒸汽發生器給水');
    if (inp.sgLevelPct < SgLoLoLevelPct)
      return mk(
        'H', 'Heat Sink', '熱阱', 'orange', 'FR-H.1',
        `SG level ${f0(inp.sgLevelPct)}% < lo-lo`,
        `蒸發器水位 ${f0(inp.sgLevelPct)}% 低於低低值`,
      );
    if (inp.sgLevelPct < SgLowLevelPct || (inp.feedwaterFlow < FeedMarginalFrac && !inp.auxFeedwaterRunning))
      return mk(
        'H', 'Heat Sink', '熱阱', 'yellow', 'FR-H.5',
        `SG level ${f0(inp.sgLevelPct)}% / feed marginal`,
        `蒸發器水位 ${f0(inp.sgLevelPct)}% / 給水不足`,
      );
    return mk('H', 'Heat Sink', '熱阱', 'green', '--', 'Heat sink available', '熱阱可用');
  }

  // ---- F-0.4 RCS INTEGRITY (source L5631–5650) — pressure boundary / PTS. RED = above the 17.2 MPa
  // design pressure → FR-P.1; ORANGE = within 1 MPa of it; YELLOW = cooldown faster than the
  // ~100 °F/hr (−55 °C/hr) Tech-Spec App-G limit → FR-P.2. One-sided quirk kept: HEATUP rate never
  // yellows this tree (only cooldown, PTS concern).
  private evalIntegrity(inp: CsfTreesInputs): CsfStateView {
    if (Number.isNaN(inp.primaryPressureMPa)) // C# double.IsNaN (source L5633)
      return mk('P', 'RCS Integrity', '一迴路完整性', 'invalid', '--', 'RCS pressure invalid', '一迴路壓力訊號失效');
    if (inp.primaryPressureMPa > VesselPressureLimit)
      return mk(
        'P', 'RCS Integrity', '一迴路完整性', 'red', 'FR-P.1',
        `RCS ${f1(inp.primaryPressureMPa)} MPa > ${f1(VesselPressureLimit)} MPa overpressure`,
        `一迴路 ${f1(inp.primaryPressureMPa)} MPa > ${f1(VesselPressureLimit)} MPa 超壓`,
      );
    if (inp.primaryPressureMPa > VesselPressureLimit - IntegrityOrangeBandMPa)
      return mk(
        'P', 'RCS Integrity', '一迴路完整性', 'orange', 'FR-P.1',
        `RCS ${f1(inp.primaryPressureMPa)} MPa near limit`,
        `一迴路 ${f1(inp.primaryPressureMPa)} MPa 逼近上限`,
      );
    if (inp.heatupRateCPerHr < CooldownYellowCPerHr)
      return mk(
        'P', 'RCS Integrity', '一迴路完整性', 'yellow', 'FR-P.2',
        `Cooldown ${f0(inp.heatupRateCPerHr)}°C/hr — PTS concern`,
        `降溫率 ${f0(inp.heatupRateCPerHr)}°C/hr — 加壓熱衝擊風險`,
      );
    return mk('P', 'RCS Integrity', '一迴路完整性', 'green', '--', 'Pressure boundary intact', '壓力邊界完整');
  }

  // ---- F-0.5 CONTAINMENT (source L5656–5672) — pressure / radiation / damage. RED = meltdown,
  // containment-atmosphere rad monitor in alarm, or pressure at the Hi-3 spray/design setpoint
  // (~186 kPa ≈ 27 psig) → FR-Z.1; ORANGE = Hi-1 (~28 kPa ≈ 4 psig) or accumulating core damage;
  // YELLOW = elevated rad / sump rising → FR-Z.3. All Z inputs are always-valid model state — no
  // Invalid guard (source L5655 comment).
  private evalContainment(inp: CsfTreesInputs): CsfStateView {
    if (
      inp.meltdown ||
      inp.particulateMonitorRatio >= RadMonitorRedRatio ||
      inp.gaseousMonitorRatio >= RadMonitorRedRatio ||
      inp.containmentPressureKpaG >= CtmtHi3Kpa
    )
      return mk(
        'Z', 'Containment', '安全殼', 'red', 'FR-Z.1',
        `Containment ${f0(inp.containmentPressureKpaG)} kPa / rad / meltdown`,
        `安全殼 ${f0(inp.containmentPressureKpaG)} kPa / 輻射 / 熔毀`,
      );
    if (inp.containmentPressureKpaG >= CtmtHi1Kpa || inp.damageAccumulation > DamageOrangeThreshold)
      return mk(
        'Z', 'Containment', '安全殼', 'orange', 'FR-Z.1',
        `Containment ${f0(inp.containmentPressureKpaG)} kPa Hi-1`,
        `安全殼 ${f0(inp.containmentPressureKpaG)} kPa 高一`,
      );
    if (
      inp.particulateMonitorRatio > RadMonitorYellowRatio ||
      inp.gaseousMonitorRatio > RadMonitorYellowRatio ||
      inp.sumpGal > SumpYellowGal
    )
      return mk('Z', 'Containment', '安全殼', 'yellow', 'FR-Z.3', 'Containment rad / sump rising', '安全殼輻射 / 地坑上升');
    return mk('Z', 'Containment', '安全殼', 'green', '--', 'Containment intact', '安全殼完整');
  }

  // ---- F-0.6 RCS INVENTORY (source L5677–5697) — pressurizer level (+ RVLIS cross-check). RED =
  // level off-scale-low with RVLIS below top of active fuel → inventory lost, FR-I.2; ORANGE = level
  // below ~17 %; YELLOW = low (<30 %, FR-I.1) or overfill (>92 %, solid-plant risk, FR-I.3).
  private evalInventory(inp: CsfTreesInputs): CsfStateView {
    if (Number.isNaN(inp.pressurizerLevelPct)) // C# double.IsNaN (source L5679)
      return mk('I', 'RCS Inventory', '一迴路存量', 'invalid', '--', 'PZR level invalid', '穩壓器水位訊號失效');
    if (inp.pressurizerLevelPct < PzrOffScaleLowPct && inp.rvlisPct < RvlisTopOfFuelPct)
      return mk(
        'I', 'RCS Inventory', '一迴路存量', 'red', 'FR-I.2',
        'PZR level off-scale low — inventory lost',
        '穩壓器水位低於量程 — 喪失存量',
      );
    if (inp.pressurizerLevelPct < PzrOrangeLowPct)
      return mk(
        'I', 'RCS Inventory', '一迴路存量', 'orange', 'FR-I.2',
        `PZR level ${f0(inp.pressurizerLevelPct)}% low`,
        `穩壓器水位 ${f0(inp.pressurizerLevelPct)}% 偏低`,
      );
    if (inp.pressurizerLevelPct < PzrYellowLowPct || inp.pressurizerLevelPct > PzrYellowHighPct)
      return mk(
        'I', 'RCS Inventory', '一迴路存量', 'yellow',
        inp.pressurizerLevelPct > PzrYellowHighPct ? 'FR-I.3' : 'FR-I.1', // overfill vs low (source L5692)
        `PZR level ${f0(inp.pressurizerLevelPct)}%`,
        `穩壓器水位 ${f0(inp.pressurizerLevelPct)}%`,
      );
    return mk('I', 'RCS Inventory', '一迴路存量', 'green', '--', 'RCS inventory normal', '一迴路存量正常');
  }
}
