// 工程安全設施測試 · EngineeredSafety — SI actuation/latching, 2000 ppm borated HHSI, passive
// accumulator dump and the staggered MSSV bank, driven standalone through realistic transients.
// Mirrors ReactorSimService.cs semantics: SiActuated latch L5405, MslbSiBoronPpm L1832, 4 ppm/s
// slew L4286/L5407, Lo-Steamline SI 4.14 MPa L1831 with P-11 permissive L2088, ECCS inject
// threshold 11.0 L5414, accumulator precharge 4.5 L3522, MSSV ladder L818–822 / loop L5147–5167.

import { describe, it, expect } from 'vitest';
import {
  EngineeredSafety,
  MssvLiftSetMpa,
  MssvCapacityFrac,
  MssvAccumMpa,
  mpaAbsToPsig,
  psigToMpaAbs,
  type EngineeredSafetyInputs,
} from './engineeredSafety';

/** Normal full-power baseline inputs (hot RCS at 15.5 MPa, header at no-load 6.9 MPa). */
function nominal(over: Partial<EngineeredSafetyInputs> = {}): EngineeredSafetyInputs {
  return {
    primaryPressureMPa: 15.5,
    pressurizerLevelPct: 55,
    steamPressureMPa: 6.9,
    boronPpm: 1200,
    rcsMixVolumeGal: 80000,
    scrammed: false,
    ...over,
  };
}

describe('unit conversions', () => {
  it('psig ↔ MPa-abs uses psig = (Pa − 101325)/6894.757 exactly', () => {
    // 7.60 MPa abs → (7.6e6 − 101325)/6894.757 psig
    const expected = (7.6e6 - 101325) / 6894.757;
    expect(mpaAbsToPsig(7.6)).toBeCloseTo(expected, 6);
    expect(mpaAbsToPsig(7.6)).toBeCloseTo(1087.6, 1);
    // round trip
    for (const mpa of MssvLiftSetMpa) expect(psigToMpaAbs(mpaAbsToPsig(mpa))).toBeCloseTo(mpa, 9);
    // atmospheric absolute pressure reads 0 psig
    expect(mpaAbsToPsig(0.101325)).toBeCloseTo(0, 6);
  });

  it('view exposes the computed psig setpoints alongside the real-plant analogs', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    const v = esf.view();
    expect(v.mssvSetpointMpa).toEqual([7.6, 7.8, 8.0, 8.2, 8.4]);
    expect(v.mssvSetpointPsig[0]!).toBeCloseTo(mpaAbsToPsig(7.6), 6);
    expect(v.mssvAnalogPsig).toEqual([1185, 1195, 1207.5, 1218.5, 1230]);
  });
});

describe('MSSV bank — staggered pops, blowdown reseat hysteresis, capacity', () => {
  it('walks UP the setpoint ladder as header pressure rises, with rising-edge pops', () => {
    const esf = new EngineeredSafety();
    // Below the first seat: everything shut.
    let o = esf.step(nominal({ steamPressureMPa: 7.5 }), 0.5);
    expect(o.mssvOpenCount).toBe(0);
    expect(o.mssvReliefFlowFrac).toBe(0);
    expect(o.mssvLiftedEdge).toBe(false);
    // Cross stage 1 (7.60): one valve pops — edge asserted this step only.
    o = esf.step(nominal({ steamPressureMPa: 7.65 }), 0.5);
    expect(o.mssvOpenCount).toBe(1);
    expect(o.mssvLiftedEdge).toBe(true);
    o = esf.step(nominal({ steamPressureMPa: 7.65 }), 0.5);
    expect(o.mssvLiftedEdge).toBe(false); // no new pop, edge clears
    // Climb to 8.25: stages 1–4 open.
    o = esf.step(nominal({ steamPressureMPa: 8.25 }), 0.5);
    expect(o.mssvOpenCount).toBe(4);
    expect(o.mssvLiftedEdge).toBe(true);
    // Full accumulation 8.6: all 5 open at FULL lift → relief = Σ capacities = 1.0.
    o = esf.step(nominal({ steamPressureMPa: MssvAccumMpa }), 0.5);
    expect(o.mssvOpenCount).toBe(5);
    const sumCap = MssvCapacityFrac.reduce((a, b) => a + b, 0);
    expect(sumCap).toBeCloseTo(1.0, 9);
    expect(o.mssvReliefFlowFrac).toBeCloseTo(sumCap, 6);
  });

  it('reseats only after the full 0.30 MPa blowdown band (latch direction)', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal({ steamPressureMPa: 7.65 }), 0.5); // stage 1 open
    // Back below the lift setpoint but ABOVE LiftSet − Blowdown (7.30): stays latched open,
    // though liftFrac clamps to 0 below the seat (the C# choked-flow surrogate, source L5163).
    let o = esf.step(nominal({ steamPressureMPa: 7.45 }), 0.5);
    expect(o.mssvOpenCount).toBe(1);
    expect(o.mssvReliefFlowFrac).toBe(0);
    // At/below 7.30: reseats.
    o = esf.step(nominal({ steamPressureMPa: 7.3 }), 0.5);
    expect(o.mssvOpenCount).toBe(0);
    expect(o.mssvReliefFlowFrac).toBe(0);
  });

  it('relief scales with overpressure above the lowest open seat (choked-flow surrogate)', () => {
    const esf = new EngineeredSafety();
    const o1 = esf.step(nominal({ steamPressureMPa: 7.62 }), 0.5); // just past stage 1
    const liftFrac1 = (7.62 - 7.6) / (MssvAccumMpa - 7.6);
    expect(o1.mssvReliefFlowFrac).toBeCloseTo(MssvCapacityFrac[0]! * liftFrac1, 6);
    const o2 = esf.step(nominal({ steamPressureMPa: 8.0 }), 0.5); // stages 1–3 open
    const liftFrac2 = (8.0 - 7.6) / (MssvAccumMpa - 7.6);
    const cap123 = MssvCapacityFrac[0]! + MssvCapacityFrac[1]! + MssvCapacityFrac[2]!;
    expect(o2.mssvReliefFlowFrac).toBeCloseTo(cap123 * liftFrac2, 6);
    expect(o2.mssvReliefFlowFrac).toBeGreaterThan(o1.mssvReliefFlowFrac);
  });
});

describe('SI actuation — setpoints, latch, reset', () => {
  it('actuates on low pressurizer pressure once the channel is armed, and LATCHES', () => {
    const esf = new EngineeredSafety();
    // Arm at operating pressure, then depressurize through the 11.0 MPa threshold (SBLOCA).
    esf.step(nominal(), 1);
    let o = esf.step(nominal({ primaryPressureMPa: 11.5 }), 1);
    expect(o.siActive).toBe(false); // above the setpoint
    o = esf.step(nominal({ primaryPressureMPa: 10.5 }), 1);
    expect(o.siActive).toBe(true);
    expect(o.siDemandsReactorTrip).toBe(true); // SI trips the reactor (P-4, source L4078)
    // Pressure recovers — the signal stays sealed in (source L5405).
    o = esf.step(nominal({ primaryPressureMPa: 15.5 }), 1);
    expect(o.siActive).toBe(true);
    expect(o.siFlowFrac).toBe(0); // but HHSI is dead-headed at full RCS pressure
    // Already-scrammed plant: no further trip demand.
    o = esf.step(nominal({ primaryPressureMPa: 15.5, scrammed: true }), 1);
    expect(o.siDemandsReactorTrip).toBe(false);
  });

  it('never actuates on low pressure from a cold, never-pressurized start (channel unarmed)', () => {
    const esf = new EngineeredSafety();
    // Cold shutdown: primary sits at 2.5 MPa by construction — must NOT spuriously SI.
    for (let i = 0; i < 50; i++) {
      const o = esf.step(nominal({ primaryPressureMPa: 2.5, steamPressureMPa: 0.5 }), 1);
      expect(o.siActive).toBe(false);
      expect(o.accumulatorsDumping).toBe(false); // accumulator bank equally unarmed when cold
    }
  });

  it('actuates on Lo-Steamline-Pressure (4.14 MPa) only above the P-11 permissive (10.0 MPa)', () => {
    // MSLB at power: primary at pressure, header crashes.
    const esf = new EngineeredSafety();
    let o = esf.step(nominal({ steamPressureMPa: 4.2 }), 1);
    expect(o.siActive).toBe(false); // just above the setpoint
    o = esf.step(nominal({ steamPressureMPa: 4.0 }), 1);
    expect(o.siActive).toBe(true);
    // Blocked below P-11: a fresh cold/heat-up plant with a naturally-low header never actuates.
    const cold = new EngineeredSafety();
    o = cold.step(nominal({ primaryPressureMPa: 9.0, steamPressureMPa: 4.0 }), 1);
    expect(o.siActive).toBe(false);
  });

  it('manual SI actuates from anywhere; reset clears once conditions are gone, re-latches if live', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    esf.actuateSi();
    let o = esf.step(nominal(), 1);
    expect(o.siActive).toBe(true);
    expect(esf.view().siManual).toBe(true);
    // Conditions normal → reset holds.
    esf.resetSi();
    o = esf.step(nominal(), 1);
    expect(o.siActive).toBe(false);
    // Live Lo-Steamline condition → reset is overridden next step (signal re-latches).
    o = esf.step(nominal({ steamPressureMPa: 4.0 }), 1);
    expect(o.siActive).toBe(true);
    expect(esf.view().siManual).toBe(false); // automatic re-actuation
    esf.resetSi();
    o = esf.step(nominal({ steamPressureMPa: 4.0 }), 1);
    expect(o.siActive).toBe(true);
  });

  it('reset during a depressurized recovery inserts the lo-press block until P ≥ 12 MPa again', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1); // arm
    esf.step(nominal({ primaryPressureMPa: 8.0 }), 1); // SI on low pressure
    esf.resetSi(); // operator blocks + resets while still depressurized
    let o = esf.step(nominal({ primaryPressureMPa: 8.0 }), 1);
    expect(o.siActive).toBe(false); // block holds below the re-arm pressure
    // Plant repressurizes past 12 MPa: channel re-arms, but P > 11 so no actuation.
    o = esf.step(nominal({ primaryPressureMPa: 15.5 }), 1);
    expect(o.siActive).toBe(false);
    expect(esf.view().siLowPressArmed).toBe(true);
    // A second depressurization re-actuates.
    o = esf.step(nominal({ primaryPressureMPa: 10.0 }), 1);
    expect(o.siActive).toBe(true);
  });
});

describe('borated HHSI — 2000 ppm target at the 4 ppm/s slew', () => {
  it('ramps boron toward 2000 ppm at 4 ppm/s even against a fully-pressurized RCS (C# quirk)', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    esf.actuateSi();
    // Full RCS pressure: no HHSI flow, yet boration proceeds (source L5401 — flag, not flow).
    const o = esf.step(nominal({ boronPpm: 1200 }), 1);
    expect(o.siFlowFrac).toBe(0);
    expect(o.boronPpmPerS).toBeCloseTo(4.0, 9);
  });

  it('integrates to exactly 2000 ppm with no overshoot at dt = 2 s, then stops', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    esf.actuateSi();
    let boron = 1993.0;
    const dt = 2.0;
    for (let i = 0; i < 10; i++) {
      const o = esf.step(nominal({ boronPpm: boron }), dt);
      boron += o.boronPpmPerS * dt; // exactly how the integrator applies it (AFTER updateBoron)
    }
    expect(boron).toBeCloseTo(2000.0, 9);
    const o = esf.step(nominal({ boronPpm: boron }), dt);
    expect(o.boronPpmPerS).toBe(0); // at target — injection boron rate stops
  });

  it('scales the slew with the RCS mixing volume (80000 gal reference ⇒ 4 ppm/s)', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    esf.actuateSi();
    const half = esf.step(nominal({ rcsMixVolumeGal: 160000 }), 1);
    expect(half.boronPpmPerS).toBeCloseTo(2.0, 9);
  });

  it('injects flow + pressure support + level makeup against a depressurized RCS', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1); // arm
    const o = esf.step(nominal({ primaryPressureMPa: 6.0, pressurizerLevelPct: 20 }), 1);
    expect(o.siActive).toBe(true);
    expect(o.siFlowFrac).toBe(1); // well below shutoff-head minus ramp span → full HHSI
    expect(o.pressureSupportMPaPerS).toBeCloseTo(0.4, 9); // source L5417
    expect(o.fuelCoolCPerS).toBeCloseTo(30.0, 9); // source L5418
    expect(o.loopCoolCPerS).toBeCloseTo(5.0, 9); // source L5419
    expect(o.pzrLevelPctPerS).toBeGreaterThan(0);
  });
});

describe('N₂ accumulators — passive check-valve dump, finite inventory', () => {
  it('dumps whenever primary < 4.5 MPa precharge after being armed; latch-free and signal-free', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1); // pressurized → bank armed
    let o = esf.step(nominal({ primaryPressureMPa: 4.6 }), 1);
    expect(o.accumulatorsDumping).toBe(false); // just above precharge
    o = esf.step(nominal({ primaryPressureMPa: 4.0 }), 1);
    expect(o.accumulatorsDumping).toBe(true);
    expect(o.fuelCoolCPerS).toBeGreaterThanOrEqual(25.0); // source L3525 (+ HHSI share)
    expect(o.pzrLevelPctPerS).toBeGreaterThan(0); // source L3527
    // Check valves close the instant pressure recovers above the precharge — no hysteresis, passive.
    o = esf.step(nominal({ primaryPressureMPa: 5.0 }), 1);
    expect(o.accumulatorsDumping).toBe(false);
    o = esf.step(nominal({ primaryPressureMPa: 4.0 }), 1);
    expect(o.accumulatorsDumping).toBe(true); // and reopen when it falls again
  });

  it('has finite inventory: a sustained deep blowdown empties the bank and the dump ends', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    let last = 100;
    let emptiedAt = -1;
    for (let i = 0; i < 400; i++) {
      const o = esf.step(nominal({ primaryPressureMPa: 0.5 }), 1);
      expect(o.accumulatorLevelPct).toBeLessThanOrEqual(last);
      last = o.accumulatorLevelPct;
      if (o.accumulatorLevelPct <= 0 && emptiedAt < 0) emptiedAt = i;
      // The step AFTER the bank empties (level 0 at step entry) must report no dump.
      if (emptiedAt >= 0 && i > emptiedAt) expect(o.accumulatorsDumping).toBe(false);
    }
    expect(emptiedAt).toBeGreaterThan(60); // ~135 s at 0.5 MPa backpressure (dpFrac ≈ 0.889)
    expect(emptiedAt).toBeLessThan(220);
    expect(last).toBe(0);
    const v = esf.view();
    expect(v.activeAlarmsEn).toContain('ACCUMULATORS EMPTY');
  });
});

describe('bilingual pairs + view integrity', () => {
  it('every alarm and status string exists as a non-empty En/Zh pair', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    // Light everything up: SI + injection + accumulator dump + MSSV lift.
    esf.step(nominal({ primaryPressureMPa: 3.0, steamPressureMPa: 8.6 }), 1);
    const v = esf.view();
    expect(v.activeAlarmsEn.length).toBeGreaterThanOrEqual(4);
    expect(v.activeAlarmsEn.length).toBe(v.activeAlarmsZh.length);
    for (let i = 0; i < v.activeAlarmsEn.length; i++) {
      expect(v.activeAlarmsEn[i]!.length).toBeGreaterThan(0);
      expect(v.activeAlarmsZh[i]!.length).toBeGreaterThan(0);
    }
    // C#-lifted wordings preserved (Pages/ReactorModule.xaml.cs L1377–1403).
    expect(v.activeAlarmsEn).toContain('SAFETY INJECTION');
    expect(v.activeAlarmsZh).toContain('安全注入 SI');
    expect(v.activeAlarmsEn).toContain('MAIN STEAM SAFETY OPEN');
    expect(v.activeAlarmsZh).toContain('主蒸汽安全閥起跳');
    expect(v.siStatusEn.length).toBeGreaterThan(0);
    expect(v.siStatusZh.length).toBeGreaterThan(0);
    // View is a plain JSON-serializable snapshot.
    expect(() => JSON.stringify(v)).not.toThrow();
  });

  it('reset() restores the pristine state', () => {
    const esf = new EngineeredSafety();
    esf.step(nominal(), 1);
    esf.step(nominal({ primaryPressureMPa: 3.0, steamPressureMPa: 8.6 }), 5);
    esf.reset();
    const v = esf.view();
    expect(v.siActive).toBe(false);
    expect(v.accumulatorLevelPct).toBe(100);
    expect(v.mssvOpenCount).toBe(0);
    expect(v.mssvOpen.every((x) => !x)).toBe(true);
    expect(v.activeAlarmsEn.length).toBe(0);
    // And it does not spuriously SI from cold after the reset.
    const o = esf.step(nominal({ primaryPressureMPa: 2.5, steamPressureMPa: 0.5 }), 1);
    expect(o.siActive).toBe(false);
  });
});
