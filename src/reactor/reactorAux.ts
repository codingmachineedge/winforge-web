// 反應堆輔助系統協調器 · Reactor auxiliary-systems coordinator.
//
// Orchestrates the six protection/ESF subsystems ported from ReactorSimService.cs that live
// OUTSIDE the pure point-kinetics core (physics.ts stays framework-free and untouched):
//
//   • rodControl        — Westinghouse rod-bank overlap program + Tavg/Tref auto rod control
//   • pressureRelief     — pressurizer PORV / code safeties / PRT (+ stuck-PORV TMI-2 drill)
//   • ptLimits           — Appendix-G P/T envelope + heatup/cooldown rate + LTOP arming + PTS
//   • engineeredSafety   — SI actuation, borated HHSI, accumulators, MSSV bank
//   • containment        — containment pressure / Hi-1-2-3 / spray / sump + RCP seal-LOCA
//   • csfTrees           — the six Westinghouse Critical Safety Function status trees (monitor)
//
// Each module is a pure `step(inputs, dt) → outputs` engine that never mutates the sim; this
// coordinator is the single writer that reads sim state into each module's Inputs and applies its
// Outputs back onto the sim, in the exact tick order the C# uses, honouring the one-tick-lag
// couplings between modules (ptLimits.ltopArmed → pressureRelief; pressureRelief.prtVentDrive →
// containment; pressureRelief.ltopPorvOpen → ptLimits; containment pressure → pressureRelief).

import { ReactorMode, RatedElectricMW, VesselBurstPressure, _clamp, type ReactorSim } from './physics';
import { RodController, type RodControlMode, type RodControlView, type RodDirection } from './rodControl';
import { PressureReliefSystem, type PressureReliefView } from './pressureRelief';
import { PtLimitMonitor, type PtLimitsView } from './ptLimits';
import { EngineeredSafety, type EngineeredSafetyView } from './engineeredSafety';
import { ContainmentSystem, type ContainmentView } from './containment';
import { CsfEvaluator, type CsfTreesView } from './csfTrees';

const RCS_MIX_VOLUME_GAL = 80000; // source L433 — SI boron-rate reference volume
const COLD = 35; // °C floor for temperature pulldown clamps (ReactorSim ColdTemp)

/** Immutable per-tick snapshot of every auxiliary subsystem, mirrored into React. */
export interface AuxSnapshot {
  rods: RodControlView;
  relief: PressureReliefView;
  ptLimits: PtLimitsView;
  esf: EngineeredSafetyView;
  containment: ContainmentView;
  csf: CsfTreesView;
  /** Aux annunciators merged across all subsystems (bilingual parallel arrays). */
  alarmsEn: string[];
  alarmsZh: string[];
}

export class ReactorAux {
  readonly rods = new RodController();
  readonly relief = new PressureReliefSystem();
  readonly ptLimits = new PtLimitMonitor();
  readonly esf = new EngineeredSafety();
  readonly containment = new ContainmentSystem();
  readonly csf = new CsfEvaluator();

  // ---- one-tick-lag couplings between modules (mirror the C# end-of-tick handoffs) ----
  private _ltopArmed = false; // ptLimits (tick N) → pressureRelief (tick N+1)
  private _ltopPorvOpen = false; // pressureRelief (tick N) → ptLimits (same tick, read after)
  private _prtVentKpa = 0; // pressureRelief (tick N) → containment (same tick, read after)
  private _containmentKpa = 0; // containment (tick N) → pressureRelief (tick N+1) back-pressure

  reset(): void {
    this.rods.reset();
    this.relief.reset();
    this.ptLimits.reset();
    this.esf.reset();
    this.containment.reset();
    this.csf.reset();
    this._ltopArmed = false;
    this._ltopPorvOpen = false;
    this._prtVentKpa = 0;
    this._containmentKpa = 0;
  }

  /** Rod-control program: runs BEFORE sim.update so the demand-counter mapping owns the banks
   *  this tick when engaged (AUTO, or MANUAL with an active jog / slew target). */
  stepBefore(sim: ReactorSim, dt: number): void {
    const out = this.rods.step(
      {
        tavgC: sim.tavg,
        turbineLoadFrac: _clamp(sim.electricPowerMW / RatedElectricMW, 0, 1),
        scrammed: sim.isScrammed,
        rodsDropping: sim.rodsDropping,
        fuelAvailable: sim.fuelAvailable,
        currentBankInsertionPct: Array.from(sim.rodBankInsertion),
        neutronPowerFraction: sim.neutronPowerFraction,
      },
      dt,
    );
    // Only take the banks when the program is engaged and the scram rod-drop isn't running them.
    if (out.engaged && !sim.isScrammed && !sim.rodsDropping) {
      for (let b = 0; b < 4; b++) sim.rodBankInsertion[b] = out.bankInsertionPct[b]!;
    }
  }

  /** Protection / ESF / monitors: run AFTER sim.update so they see post-update plant state, in the
   *  C# tick order (relief → P/T limits → ESF → containment → CSF). */
  stepAfter(sim: ReactorSim, dt: number): void {
    // 1) Pressurizer relief — depressurizes the RCS through any open PORV / code safety.
    const rOut = this.relief.step(
      {
        primaryPressureMPa: sim.primaryPressure,
        ltopArmed: this._ltopArmed, // from ptLimits' previous tick (one-tick lag, matches C#)
        containmentPressureKpa: this._containmentKpa, // containment back-pressure, previous tick
        scrammed: sim.isScrammed,
      },
      dt,
    );
    sim.primaryPressure = _clamp(sim.primaryPressure - rOut.reliefRateMPaPerS * dt, 0.1, VesselBurstPressure);
    this._prtVentKpa = rOut.prtVentDriveKpa;
    this._ltopPorvOpen = rOut.ltopPorvOpen;

    // 2) Appendix-G P/T limits + LTOP arming + PTS monitor (raises flags only; never trips).
    const pOut = this.ptLimits.step(
      {
        tcoldC: sim.tcold,
        primaryPressureMPa: sim.primaryPressure,
        ltopPorvOpen: this._ltopPorvOpen,
      },
      dt,
    );
    this._ltopArmed = pOut.ltopArmed; // consumed by pressureRelief next tick

    // 3) Engineered safety features — SI, borated HHSI, accumulators, MSSVs.
    const eOut = this.esf.step(
      {
        primaryPressureMPa: sim.primaryPressure,
        pressurizerLevelPct: sim.pressurizerLevel,
        steamPressureMPa: sim.steamPressure,
        boronPpm: sim.boronPpm,
        rcsMixVolumeGal: RCS_MIX_VOLUME_GAL,
        scrammed: sim.isScrammed,
      },
      dt,
    );
    // SI boration OVERRIDES the CVCS blender slew (applied after sim's own updateBoron ran).
    sim.boronPpm = _clamp(sim.boronPpm + eOut.boronPpmPerS * dt, 0, 3000);
    sim.primaryPressure = Math.min(VesselBurstPressure, sim.primaryPressure + eOut.pressureSupportMPaPerS * dt);
    sim.pressurizerLevel = _clamp(sim.pressurizerLevel + eOut.pzrLevelPctPerS * dt, 0, 100);
    sim.fuelTemp = Math.max(COLD, sim.fuelTemp - eOut.fuelCoolCPerS * dt);
    sim.tcold = Math.max(COLD, sim.tcold - eOut.loopCoolCPerS * dt);
    sim.thot = Math.max(sim.tcold, sim.thot - eOut.loopCoolCPerS * dt);
    sim.steamPressure = Math.max(0.3, sim.steamPressure - 0.5 * eOut.mssvReliefFlowFrac * dt);
    if (eOut.siDemandsReactorTrip && !sim.isScrammed) {
      sim.lastTripFunctionEn = 'Safety Injection (SI)';
      sim.lastTripFunctionZh = '安全注入 SI';
      sim.scram();
    }

    // 4) Containment — pressure/temperature lump, Hi-1/2/3, spray, sump, RCP seal-LOCA.
    const cOut = this.containment.step(
      {
        prtVentDriveKpa: this._prtVentKpa,
        rcpRunningCount: sim.rcpRunning.filter(Boolean).length,
        primaryPressureMPa: sim.primaryPressure,
        tcoldC: sim.tcold,
        thotC: sim.thot,
        scrammed: sim.isScrammed,
      },
      dt,
    );
    if (cOut.rcsLeakGpm > 0) {
      sim.pressurizerLevel = Math.max(0, sim.pressurizerLevel - cOut.rcsLeakGpm * (dt / 60) * 0.0074);
    }
    if (cOut.requestScram && !sim.isScrammed) {
      sim.lastTripFunctionEn = cOut.scramReasonEn;
      sim.lastTripFunctionZh = cOut.scramReasonZh;
      sim.scram();
    }
    const cView = this.containment.view();
    this._containmentKpa = cView.pressureKpaG; // back-pressure for pressureRelief next tick

    // 5) Critical Safety Function trees — pure monitor. Wire the real signals now available from
    //    the sibling modules (heatup rate, containment pressure/sump, seal-LOCA, App-G violation)
    //    instead of the safe defaults each module documented.
    this.csf.step(
      {
        powerFraction: sim.neutronPowerFraction,
        startupRateDpm: sim.startupRateDpm,
        scrammed: sim.isScrammed,
        coreExitTempC: sim.thot,
        subcoolingMarginC: sim.subcoolingMarginC,
        rvlisPct: 100,
        sgLevelPct: 30 + 34 * sim.feedwaterFlow,
        feedwaterFlow: sim.feedwaterFlow,
        auxFeedwaterRunning: false,
        primaryPressureMPa: sim.primaryPressure,
        heatupRateCPerHr: pOut ? this.ptLimits.view().heatupRateCPerHr : 0,
        meltdown: sim.mode === ReactorMode.Meltdown,
        containmentPressureKpaG: cView.pressureKpaG,
        particulateMonitorRatio: 0,
        gaseousMonitorRatio: 0,
        damageAccumulation: sim.damageAccumulation,
        sumpGal: cView.sumpGal,
        pressurizerLevelPct: sim.pressurizerLevel,
        sealLocaActive: cView.sealLocaActive,
        appGViolated: pOut.appGViolated,
      },
      dt,
    );
  }

  /** Snapshot every subsystem's View, with the aux annunciators merged into one bilingual list. */
  view(): AuxSnapshot {
    const rods = this.rods.view();
    const relief = this.relief.view();
    const ptLimits = this.ptLimits.view();
    const esf = this.esf.view();
    const containment = this.containment.view();
    const csf = this.csf.view();

    const alarmsEn: string[] = [];
    const alarmsZh: string[] = [];
    const push = (en: string[], zh: string[]) => {
      for (let i = 0; i < en.length; i++) {
        alarmsEn.push(en[i]!);
        alarmsZh.push(zh[i] ?? en[i]!);
      }
    };
    if (rods.withdrawBlocked && rods.withdrawBlockedReasonEn) push([rods.withdrawBlockedReasonEn], [rods.withdrawBlockedReasonZh]);
    push(relief.alarmsEn, relief.alarmsZh);
    push(ptLimits.alarmsEn, ptLimits.alarmsZh);
    push(esf.activeAlarmsEn, esf.activeAlarmsZh);
    push(containment.alarms.map((a) => a.en), containment.alarms.map((a) => a.zh));

    return { rods, relief, ptLimits, esf, containment, csf, alarmsEn, alarmsZh };
  }

  // ---- operator controls (delegated to the owning module) ----
  setRodControlMode(m: RodControlMode): void {
    this.rods.setControlMode(m);
  }
  driveRods(direction: RodDirection, spm?: number): void {
    this.rods.driveRods(direction, spm);
  }
  setRodDemandTarget(steps: number): void {
    this.rods.setDemandTarget(steps);
  }
  triggerStuckPorv(): void {
    this.relief.triggerStuckPorv();
  }
  closeBlockValve(): void {
    this.relief.closeBlockValve();
  }
  openBlockValve(): void {
    this.relief.openBlockValve();
  }
  actuateSi(): void {
    this.esf.actuateSi();
  }
  resetSi(): void {
    this.esf.resetSi();
  }
  triggerSealCoolingLoss(): void {
    this.containment.triggerSealCoolingLoss();
  }
  restoreSealCooling(): void {
    this.containment.restoreSealCooling();
  }
}
