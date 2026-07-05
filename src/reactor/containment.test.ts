// 安全殼系統測試 · ContainmentSystem standalone transient tests.
//
// Drives the module through realistic transients: a PRT-vent pressurization to Hi-1, a
// large-break-LOCA drive to Hi-3 + spray, the WOG-2000 loss-of-seal-cooling timeline
// (staged 3 → 21 → 76 → 182 gpm degradation with the monotonic no-reseat latch), sump
// fill / pump hysteresis, unit conversions and the bilingual alarm pairs.

import { describe, expect, it } from 'vitest';
import {
  ContainmentSystem,
  CtmtHi1Kpa,
  CtmtHi2Kpa,
  CtmtHi3Kpa,
  CtmtHystKpa,
  SealLeakDegradedGpm,
  SealLeakNormalGpm,
  SumpHiSetpointGal,
  SumpLoSetpointGal,
  type ContainmentInputs,
  type ContainmentOutputs,
} from './containment';

/** Baseline at-power plant: 4 RCPs, nominal RCS, no breaks, not scrammed. */
function atPower(over: Partial<ContainmentInputs> = {}): ContainmentInputs {
  return {
    prtVentDriveKpa: 0,
    rcpRunningCount: 4,
    primaryPressureMPa: 15.5,
    tcoldC: 292,
    thotC: 320,
    scrammed: false,
    ...over,
  };
}

/** Step `sys` with constant inputs for `seconds` sim-seconds at `dt`; returns the last outputs. */
function run(sys: ContainmentSystem, inp: ContainmentInputs, seconds: number, dt = 0.5): ContainmentOutputs {
  let out: ContainmentOutputs = sys.step(inp, dt);
  for (let t = dt; t < seconds; t += dt) out = sys.step(inp, dt);
  return out;
}

describe('containment quiescent state', () => {
  it('stays at ambient with no drives and normal seal bleed only', () => {
    const sys = new ContainmentSystem();
    const out = run(sys, atPower(), 60);
    const v = sys.view();
    expect(v.pressureKpaG).toBeLessThan(0.5);
    expect(v.tempC).toBeCloseTo(49.0, 0); // ContainmentAmbientC, source L1852
    expect(v.hi1).toBe(false);
    expect(v.isolationActuated).toBe(false);
    expect(v.sprayActive).toBe(false);
    // 4 pumps × 3 gpm controlled #1-seal bleed-off; none of it is LEAKAGE.
    expect(v.sealLeakGpmTotal).toBeCloseTo(4 * SealLeakNormalGpm, 5);
    expect(v.identifiedLeakGpm).toBeCloseTo(0, 5);
    expect(v.sumpGal).toBeCloseTo(0, 5);
    expect(out.requestScram).toBe(false);
    expect(v.alarms.length).toBe(0);
  });
});

describe('Hi-1 bistable, isolation Phase A and the auto-scram request', () => {
  it('latches Hi-1 at 28 kPa, requests a scram once unscrammed, and resets only below set − 7 kPa', () => {
    const sys = new ContainmentSystem();
    // PRT rupture-disc vent drives the building toward 40 kPa (τ_up = 8 s → crosses 28 kPa ~9.6 s).
    const inp = atPower({ prtVentDriveKpa: 40 });
    run(sys, inp, 5);
    expect(sys.view().hi1).toBe(false); // not yet — pressurization is first-order
    const out = run(sys, inp, 25);
    const v = sys.view();
    expect(v.hi1).toBe(true);
    expect(v.hi2).toBe(false); // staggered setpoints: 40 kPa < 71 kPa
    expect(v.isolationPhaseA).toBe(true);
    expect(v.isolationActuated).toBe(true);
    expect(v.siActuated).toBe(true);
    expect(v.fanCoolers).toBe(true); // safeguards-sequence fan coolers start on Hi-1
    expect(out.requestScram).toBe(true);
    expect(out.scramReasonEn).toBe('Containment Pressure Hi-1 (SI)');
    expect(out.scramReasonZh).toBe('安全殼壓力高 Hi-1（安全注入）');
    expect(v.alarms.some((a) => a.en === 'CTMT PRESS HI' && a.zh === '安全殼壓力高')).toBe(true);
    expect(v.alarms.some((a) => a.en === 'CTMT ISOLATION' && a.zh === '安全殼隔離')).toBe(true);

    // Once the integrator scrams, the request drops (mirrors the C# !IsScrammed gate, source L4078).
    const out2 = sys.step(atPower({ prtVentDriveKpa: 40, scrammed: true }), 0.5);
    expect(out2.requestScram).toBe(false);

    // Remove the drive: pressure decays through passive + fan-cooler sinks. Hysteresis: Hi-1 holds
    // above 21 kPa and resets below it — but the isolation and SI latches stay in.
    const scrammed = atPower({ prtVentDriveKpa: 0, scrammed: true });
    let seenHeldInBand = false;
    for (let t = 0; t < 400; t += 0.5) {
      sys.step(scrammed, 0.5);
      const p = sys.view().pressureKpaG;
      if (p < CtmtHi1Kpa && p >= CtmtHi1Kpa - CtmtHystKpa && sys.view().hi1) seenHeldInBand = true;
    }
    const vEnd = sys.view();
    expect(seenHeldInBand).toBe(true); // anti-chatter deadband exercised in the downward direction
    expect(vEnd.pressureKpaG).toBeLessThan(CtmtHi1Kpa - CtmtHystKpa);
    expect(vEnd.hi1).toBe(false);
    expect(vEnd.isolationActuated).toBe(true); // latch survives the bistable reset
    expect(vEnd.siActuated).toBe(true);
  });
});

describe('Hi-3, spray setup delay and spray knockdown', () => {
  it('starts spray only after the 35 s pump-start/valve-stroke delay, then knocks pressure down faster', () => {
    const sys = new ContainmentSystem();
    // Full large-break LOCA drive: breakArea 1 at nominal RCS pressure → 415 kPa target.
    const loca = atPower({ locaBreakAreaFrac: 1.0 });
    // Hi-3 (186 kPa) is crossed at ~4.8 s; the spray setup timer then runs.
    run(sys, loca, 20, 0.5);
    let v = sys.view();
    expect(v.hi3).toBe(true);
    expect(v.isolationPhaseB).toBe(true);
    expect(v.sprayActive).toBe(false); // still stroking valves
    expect(v.spraySetupRemainingS).toBeGreaterThan(0);
    run(sys, loca, 40, 0.5); // past the 35 s delay
    v = sys.view();
    expect(v.sprayActive).toBe(true);
    expect(v.sprayFlowFrac).toBe(1.0);
    expect(v.alarms.some((a) => a.en === 'CTMT SPRAY' && a.zh === '安全殼噴淋')).toBe(true);
    const pPeak = v.pressureKpaG;
    expect(pPeak).toBeGreaterThan(CtmtHi3Kpa);

    // Close the break (RCS empty): with spray running the effective sink τ ≈ 22 s — pressure
    // falls fast. The MSLB Hi-2 latch also had to be up on the way (71 kPa < 186 kPa).
    expect(v.hi2).toBe(true);
    const closed = atPower({ locaBreakAreaFrac: 0, scrammed: true });
    run(sys, closed, 30, 0.5);
    const pAfter = sys.view().pressureKpaG;
    expect(pAfter).toBeLessThan(pPeak * 0.45); // ≥ 55% knockdown in 30 s ⇒ spray-dominated sink
    // Spray temperature quench: atmosphere pulled toward the 35 °C floor band, well under ambient-tracking.
    expect(sys.view().tempC).toBeLessThan(80);
  });

  it('drops the spray permissive as soon as Hi-3 resets (setpoint − deadband)', () => {
    const sys = new ContainmentSystem();
    run(sys, atPower({ locaBreakAreaFrac: 1.0 }), 60, 0.5);
    expect(sys.view().sprayActive).toBe(true);
    const closed = atPower({ locaBreakAreaFrac: 0, scrammed: true });
    for (let t = 0; t < 600 && sys.view().hi3; t += 0.5) sys.step(closed, 0.5);
    const v = sys.view();
    expect(v.hi3).toBe(false);
    expect(v.pressureKpaG).toBeLessThan(CtmtHi3Kpa - CtmtHystKpa);
    expect(v.sprayActive).toBe(false); // C# L4095–4099: timer cleared, spray off with the bistable
    expect(v.spraySetupRemainingS).toBe(0);
  });
});

describe('WOG-2000 seal-LOCA timeline', () => {
  it('degrades over TIME after cooling loss: 3 gpm → 21 gpm near 171 s → 76 gpm near 731 s (τ = 900 s)', () => {
    const sys = new ContainmentSystem();
    const inp = atPower(); // Thot = 320 °C — the C# heat-up target
    run(sys, inp, 10, 1);
    sys.triggerSealCoolingLoss();

    run(sys, inp, 140, 1); // t = 140 s: cavity ≈ 91.5 °C — still below the 93 °C bin-1 edge
    let v = sys.view();
    expect(v.sealCoolingAvailable).toBe(false);
    expect(v.sealCavityMaxTempC).toBeGreaterThan(80);
    expect(v.sealCavityMaxTempC).toBeLessThan(93);
    expect(v.sealLeakGpmTotal).toBeCloseTo(4 * SealLeakNormalGpm, 5);
    expect(v.sealLocaActive).toBe(false); // 12 gpm is NOT above the 4×normal alarm threshold

    run(sys, inp, 60, 1); // t = 200 s: cavity ≈ 98–99 °C ≥ 93 °C → intact-but-hot 21 gpm/pump
    v = sys.view();
    expect(v.sealLeakGpmPerPump[0]).toBeCloseTo(SealLeakDegradedGpm, 5);
    expect(v.sealLeakGpmTotal).toBeCloseTo(4 * SealLeakDegradedGpm, 5);
    expect(v.sealLocaActive).toBe(true);
    expect(v.alarms.some((a) => a.en === 'RCP SEAL LOCA' && a.zh === '主泵軸封失水')).toBe(true);
    // Identified LEAKAGE = total − 4×3 gpm recovered bleed = 72 gpm > 10 gpm LCO limit.
    expect(v.identifiedLeakGpm).toBeCloseTo(4 * (SealLeakDegradedGpm - SealLeakNormalGpm), 5);
    expect(v.alarms.some((a) => a.en === 'IDENT LEAK > 10 GPM')).toBe(true);

    run(sys, inp, 600, 1); // t = 800 s: cavity ≈ 204 °C ≥ 200 °C → WOG-2000 second bin 76 gpm/pump
    v = sys.view();
    expect(v.sealLeakGpmPerPump[0]).toBeCloseTo(76.0, 5);
    expect(v.sealCavityMaxTempC).toBeGreaterThan(200);
  });

  it('never reseats: restoring cooling cools the cavity but the 76 gpm leak floor is latched', () => {
    const sys = new ContainmentSystem();
    const inp = atPower();
    sys.triggerSealCoolingLoss();
    run(sys, inp, 800, 1); // into the 76 gpm bin
    expect(sys.view().sealLeakGpmPerPump[0]).toBeCloseTo(76.0, 5);

    sys.restoreSealCooling();
    run(sys, inp, 1200, 1); // cavities relax back toward 50 °C (τ = 120 s)
    const v = sys.view();
    expect(v.sealCoolingAvailable).toBe(true);
    expect(v.sealCavityMaxTempC).toBeLessThan(60);
    expect(v.sealLeakGpmPerPump[0]).toBeCloseTo(76.0, 5); // monotonic degradation latch holds
    expect(v.sealLocaActive).toBe(false); // cooling restored → the seal-LOCA annunciator clears
    // rcsLeakGpm output keeps carrying the latched leak for the pressurizer-level bleed.
    const out = sys.step(inp, 1);
    expect(out.rcsLeakGpm).toBeCloseTo(4 * 76.0, 5);
  });

  it('carries no seal-LOCA risk on a cold, depressurized plant (cavity target < bin 1)', () => {
    const sys = new ContainmentSystem();
    const cold = atPower({ thotC: 60, tcoldC: 40, primaryPressureMPa: 2.5, rcpRunningCount: 0 });
    sys.triggerSealCoolingLoss();
    run(sys, cold, 3600, 2);
    const v = sys.view();
    expect(v.sealCavityMaxTempC).toBeLessThan(93);
    expect(v.sealLeakGpmTotal).toBeCloseTo(4 * SealLeakNormalGpm, 5);
    expect(v.sealLocaActive).toBe(false);
  });
});

describe('containment sump', () => {
  it('integrates the excess seal leakage, infers the leak rate, and pump cycles on 1000/200 gal hysteresis', () => {
    const sys = new ContainmentSystem();
    const inp = atPower();
    sys.triggerSealCoolingLoss();
    run(sys, inp, 900, 1); // 76 gpm bin → identified excess (4×73 = 292 gpm) fills the sump
    let v = sys.view();
    expect(v.sumpGal).toBeGreaterThan(SumpHiSetpointGal);
    expect(v.sumpPumpOn).toBe(true); // hi-setpoint start
    expect(v.alarms.some((a) => a.en === 'CTMT SUMP LVL HI' && a.zh === '安全殼集水坑水位高')).toBe(true);
    // RG 1.45 inferred-rate channel converges toward the NET fill rate (filtered, τ = 120 s).
    expect(v.sumpInferredLeakGpm).toBeGreaterThan(50);

    // Full reset clears the seal latch; with only the 3 gpm recovered bleed (no LEAKAGE) the pump
    // hysteresis can be watched draining a pre-filled sump — rebuild that state via a short spray
    // run instead: spray collection is the only remaining fill path.
    sys.reset();
    const loca = atPower({ locaBreakAreaFrac: 1.0 });
    run(sys, loca, 500, 0.5); // spray active ~460 s → ~150 gpm collected → >1000 gal, pump on
    v = sys.view();
    expect(v.sumpGal).toBeGreaterThan(SumpHiSetpointGal);
    expect(v.sumpPumpOn).toBe(true);

    // Close the break; once spray drops out the fill stops and the pump drains to the lo setpoint.
    const closed = atPower({ locaBreakAreaFrac: 0, scrammed: true });
    let pumpedOff = false;
    for (let t = 0; t < 4000; t += 2) {
      sys.step(closed, 2);
      if (!sys.view().sumpPumpOn) {
        pumpedOff = true;
        break;
      }
    }
    v = sys.view();
    expect(pumpedOff).toBe(true);
    expect(v.sumpGal).toBeLessThanOrEqual(SumpLoSetpointGal + 2); // stopped at the lo setpoint
    expect(v.sumpGal).toBeGreaterThan(0); // hysteresis: it does NOT pump to dry
    run(sys, closed, 120, 2);
    expect(sys.view().sumpPumpOn).toBe(false); // stays off below the hi setpoint
  });
});

describe('units and setpoint exposure', () => {
  it('psig display matches the C# kPa/6.895 and the exact psig identity within 0.1%', () => {
    const sys = new ContainmentSystem();
    run(sys, atPower({ prtVentDriveKpa: 101.325 }), 900, 0.5); // settle at ~1 atm gauge
    const v = sys.view();
    expect(v.pressureKpaG).toBeCloseTo(101.325, 1);
    expect(v.pressurePsig).toBeCloseTo(v.pressureKpaG / 6.895, 6); // source L1844 divisor
    // Exact identity: psig = (Pa_abs − 101325)/6894.757 with Pa_abs = gauge + atmospheric.
    const paAbs = v.pressureKpaG * 1000 + 101325;
    const psigExact = (paAbs - 101325) / 6894.757;
    expect(Math.abs(v.pressurePsig - psigExact) / psigExact).toBeLessThan(0.001);
    expect(v.pressurePsig).toBeCloseTo(14.7, 1);
  });

  it('publishes the staggered Westinghouse setpoints in the view', () => {
    const v = new ContainmentSystem().view();
    expect(v.hi1SetKpa).toBe(CtmtHi1Kpa);
    expect(v.hi2SetKpa).toBe(CtmtHi2Kpa);
    expect(v.hi3SetKpa).toBe(CtmtHi3Kpa);
    expect(v.hystKpa).toBe(CtmtHystKpa);
    expect(CtmtHi1Kpa).toBe(28.0);
    expect(CtmtHi2Kpa).toBe(71.0);
    expect(CtmtHi3Kpa).toBe(186.0);
    expect(v.designPsig).toBe(47.0);
  });
});

describe('bilingual pairs and reset', () => {
  it('every alarm carries a non-empty En/Zh pair', () => {
    const sys = new ContainmentSystem();
    sys.triggerSealCoolingLoss();
    run(sys, atPower({ locaBreakAreaFrac: 1.0 }), 900, 1); // everything lit at once
    const v = sys.view();
    expect(v.alarms.length).toBeGreaterThanOrEqual(4);
    for (const a of v.alarms) {
      expect(a.en.length).toBeGreaterThan(0);
      expect(a.zh.length).toBeGreaterThan(0);
      expect(a.en).not.toBe(a.zh);
    }
    const out = sys.step(atPower({ locaBreakAreaFrac: 1.0 }), 1);
    expect(out.scramReasonEn.length).toBeGreaterThan(0);
    expect(out.scramReasonZh.length).toBeGreaterThan(0);
  });

  it('reset() returns the whole system — latches included — to the quiescent baseline', () => {
    const sys = new ContainmentSystem();
    sys.triggerSealCoolingLoss();
    run(sys, atPower({ locaBreakAreaFrac: 1.0 }), 900, 1);
    sys.reset();
    const v = sys.view();
    expect(v.pressureKpaG).toBe(0);
    expect(v.tempC).toBe(49.0);
    expect(v.hi1 || v.hi2 || v.hi3).toBe(false);
    expect(v.isolationActuated).toBe(false);
    expect(v.siActuated).toBe(false);
    expect(v.fanCoolers).toBe(false);
    expect(v.sprayActive).toBe(false);
    expect(v.sumpGal).toBe(0);
    expect(v.sumpPumpOn).toBe(false);
    expect(v.sealCoolingAvailable).toBe(true);
    expect(v.sealCavityMaxTempC).toBe(50.0);
    expect(v.sealLeakGpmPerPump.every((g) => g === 0)).toBe(true); // C# reset zeroes _sealLeakGpm (L2456)
    expect(v.alarms.length).toBe(0);
  });
});
