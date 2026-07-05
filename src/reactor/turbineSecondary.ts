// 汽輪機／二迴路平衡廠房模型 · Turbine + secondary-side balance-of-plant.
//
// Ported from the Material-design-rewrite prototype's reactor-sim.js (the control-room design's
// own engine), which the handoff bundle ships as the behavioural reference for the new Control
// Room screen: a turbine governor that rolls to 1800 rpm when latched and steam is available,
// an auto-syncing generator breaker, high-pressure steam-dump valves, an SG narrow-range level
// integration, condenser vacuum, and gross electric output only while the breaker is closed.
//
// Pure module per the reactorAux pattern: step(inputs, dt) → outputs; never mutates the sim.
// The SG heat-draw estimate reproduces physics.ts stepThermal's internal sgRemoval formula from
// PUBLIC sim fields only (flow, Tavg, steam pressure, feedwater), so physics.ts stays untouched.

import { RatedThermalMW, _clamp } from './physics';

// ---- constants (prototype reactor-sim.js L415–447 provenance) ----
export const TurbineRatedRpm = 1800; // 4-pole 60 Hz synchronous speed
const RollRpmPerS = 260; // governor roll-up rate when latched with steam available
const CoastRpmPerS = 170; // coastdown rate otherwise
const SyncRpm = 1780; // breaker auto-closes at/above this speed…
const DropRpm = 1500; // …and opens below this (or on unlatch)
const SteamAvailFullMW = RatedThermalMW * 0.28; // steam flow that counts as "full" for the governor
const SteamDumpOpenMPa = 7.6; // steam-dump valves start bypassing to the condenser
const SteamDumpGain = 1.2; // fraction per MPa above the setpoint
const SteamDumpMax = 0.6;
const HouseLoadMW = 60; // station service load subtracted before the grid sees anything
const GrossEff = 0.337; // steam-MW → MWe conversion at the generator terminals
const SgLevelSetpointPct = 50;
const CondVacuumNominal = 5.0; // inHg-abs-ish display figure from the prototype

/** Values read from the sim each tick. */
export interface TurbineSecondaryInputs {
  /** Coolant average temperature °C ← sim.tavg. */
  tavgC: number;
  /** Total RCS flow fraction ← sim.coolantFlowFraction. */
  coolantFlowFraction: number;
  /** Feedwater flow fraction ← sim.feedwaterFlow. */
  feedwaterFlow: number;
  /** Lumped steam-header pressure MPa ← sim.steamPressure. */
  steamPressureMPa: number;
  /** Core melted ← sim.mode === Meltdown (turbine trips and coasts). */
  meltdown: boolean;
}

/** Effects / signals for the integrator and the Control Room view. */
export interface TurbineSecondaryOutputs {
  /** Gross electric output at the generator terminals, MWe (0 unless the breaker is closed). */
  electricMW: number;
  /** Fraction of nominal steam flow actually leaving the SGs (turbine draw + dump). */
  steamFlowFrac: number;
}

/** Plain JSON-serializable display snapshot. */
export interface TurbineSecondaryView {
  latched: boolean;
  rpm: number;
  /** Generator breaker closed — synced to the grid. */
  breakerClosed: boolean;
  steamFlowFrac: number;
  steamDumpFrac: number;
  sgLevelPct: number;
  sgPressureMPa: number;
  condVacuum: number;
  electricMW: number;
  /** Estimated SG thermal draw, MW (the qSG the governor sees). */
  steamMW: number;
}

/** physics.ts secondarySatTemp(), reproduced (it is private there). */
function secondarySatTemp(steamPressureMPa: number): number {
  const sp = Math.max(steamPressureMPa, 0.05);
  return 100.0 + 26.8 * Math.sqrt(sp) + sp * 8.0;
}

export class TurbineSecondary {
  latched = false;
  rpm = 0;
  breakerClosed = false;
  sgLevelPct = SgLevelSetpointPct;
  condVacuum = 0;
  private _steamFlowFrac = 0;
  private _steamDumpFrac = 0;
  private _electricMW = 0;
  private _steamMW = 0;
  private _sgPressureMPa = 0.5;

  reset(): void {
    this.latched = false;
    this.rpm = 0;
    this.breakerClosed = false;
    this.sgLevelPct = SgLevelSetpointPct;
    this.condVacuum = 0;
    this._steamFlowFrac = 0;
    this._steamDumpFrac = 0;
    this._electricMW = 0;
    this._steamMW = 0;
    this._sgPressureMPa = 0.5;
  }

  /** Operator latches / trips the turbine. Unlatching opens the generator breaker immediately. */
  setLatched(on: boolean): void {
    this.latched = on;
    if (!on) this.breakerClosed = false;
  }

  step(inp: TurbineSecondaryInputs, dt: number): TurbineSecondaryOutputs {
    // SG thermal draw estimate — mirrors physics.ts stepThermal's sgRemoval from public fields:
    // (8 + 90·flow) · max(0, Tavg − Tsat(secondary)) · 0.01 · (0.3 + 0.7·feedwater)
    const satC = secondarySatTemp(inp.steamPressureMPa);
    let steamMW =
      (8.0 + 90.0 * inp.coolantFlowFraction) * Math.max(0, inp.tavgC - satC) * 0.01 * (0.3 + 0.7 * inp.feedwaterFlow);
    steamMW = Math.max(0, steamMW);
    this._steamMW = steamMW;
    this._sgPressureMPa = inp.steamPressureMPa;

    // Governor: roll toward synchronous speed when latched with steam; coast down otherwise.
    const steamAvail = Math.min(1, steamMW / SteamAvailFullMW);
    if (this.latched && steamAvail > 0.03 && !inp.meltdown) {
      this.rpm = Math.min(TurbineRatedRpm, this.rpm + RollRpmPerS * dt);
    } else {
      this.rpm = Math.max(0, this.rpm - CoastRpmPerS * dt);
    }
    // Generator breaker auto-sync / drop.
    if (this.rpm >= SyncRpm && steamAvail > 0.05 && this.latched) this.breakerClosed = true;
    if (this.rpm < DropRpm || !this.latched) this.breakerClosed = false;

    // Steam paths: turbine draw while synced, high-pressure dump to the condenser.
    const turbineDrawFrac = this.breakerClosed ? Math.min(1, this.rpm / TurbineRatedRpm) * steamAvail : 0;
    this._steamDumpFrac =
      inp.steamPressureMPa > SteamDumpOpenMPa
        ? Math.min(SteamDumpMax, (inp.steamPressureMPa - SteamDumpOpenMPa) * SteamDumpGain)
        : 0;
    this._steamFlowFrac = Math.min(1, turbineDrawFrac + this._steamDumpFrac);

    // SG narrow-range level: feedwater in vs steam out, relaxing to the 50 % setpoint.
    this.sgLevelPct += dt * ((inp.feedwaterFlow - turbineDrawFrac * 0.9) * 6 - (this.sgLevelPct - SgLevelSetpointPct) * 0.03);
    this.sgLevelPct = _clamp(this.sgLevelPct, 0, 100);

    // Condenser vacuum establishes while circulating water is available (assumed on).
    this.condVacuum += dt * (CondVacuumNominal - this.condVacuum) * 0.2;

    // Gross electric output only when synced.
    this._electricMW = this.breakerClosed ? Math.max(0, GrossEff * (steamMW - HouseLoadMW)) : 0;

    return { electricMW: this._electricMW, steamFlowFrac: this._steamFlowFrac };
  }

  view(): TurbineSecondaryView {
    return {
      latched: this.latched,
      rpm: this.rpm,
      breakerClosed: this.breakerClosed,
      steamFlowFrac: this._steamFlowFrac,
      steamDumpFrac: this._steamDumpFrac,
      sgLevelPct: this.sgLevelPct,
      sgPressureMPa: this._sgPressureMPa,
      condVacuum: this.condVacuum,
      electricMW: this._electricMW,
      steamMW: this._steamMW,
    };
  }
}
