// 控制棒程序測試 · RodController unit tests — drive the class standalone through realistic
// transients: overlap geometry, demand inference, speed-limited manual drive, slew targets,
// the Tavg/Tref auto controller (deadband / lockup / proportional ramp / direction), the
// power-mismatch anticipator, scram freeze + re-infer, the fuel withdrawal gate, and the
// bilingual string pairs.

import { describe, it, expect } from 'vitest';
import {
  RodController,
  applyOverlapToBanks,
  inferRodDemandFromBanks,
  RodStepsPerBank,
  RodOverlap,
  RodStride,
  RodTotalSpan,
  NoLoadTavg,
  FullLoadTavg,
  RodDeadbandC,
  RodSpeedMinSpm,
  RodSpeedMaxSpm,
  RodSpeedSlopeSpm,
  RodRampStartC,
  type RodControlInputs,
} from './rodControl';
import { enReactorRods, yueReactorRods } from '../i18n/reactorRods';

/** Baseline hot-standby-ish inputs; override per test. */
function inputs(over: Partial<RodControlInputs> = {}): RodControlInputs {
  return {
    tavgC: NoLoadTavg,
    turbineLoadFrac: 0,
    scrammed: false,
    rodsDropping: false,
    fuelAvailable: true,
    currentBankInsertionPct: [100, 100, 100, 100],
    ...over,
  };
}

/** Run n steps of dt, feeding the controller's own bank outputs back in (integrator loop). */
function run(rc: RodController, base: Partial<RodControlInputs>, n: number, dt: number) {
  let banks = [100, 100, 100, 100];
  let out = rc.step(inputs({ ...base, currentBankInsertionPct: banks }), dt);
  for (let i = 1; i < n; i++) {
    if (out.engaged) banks = out.bankInsertionPct;
    out = rc.step(inputs({ ...base, currentBankInsertionPct: banks }), dt);
  }
  return out;
}

describe('bank geometry / overlap program', () => {
  it('constants reproduce the Westinghouse geometry (source L311–314)', () => {
    expect(RodStepsPerBank).toBe(228);
    expect(RodOverlap).toBe(128);
    expect(RodStride).toBe(100);
    expect(RodTotalSpan).toBe(528); // 4·228 − 3·128
  });

  it('deadband constant is the ΔT-span conversion of ±1.5 °F (1.5/1.8 °C)', () => {
    // C# carries 0.833 (3 d.p.) of the exact 0.83333… — assert the C# value exactly.
    expect(RodDeadbandC).toBe(0.833);
    expect(Math.abs(RodDeadbandC - 1.5 / 1.8)).toBeLessThan(5e-4);
    // Proportional slope: (72−8)/(2.778−1.667) = 57.6 spm/°C (source L355).
    expect(Math.abs((RodSpeedMaxSpm - RodSpeedMinSpm) / (2.778 - 1.667) - RodSpeedSlopeSpm)).toBeLessThan(0.02);
  });

  it('demand 0 → all banks fully inserted; 528 → all fully withdrawn', () => {
    expect(applyOverlapToBanks(0)).toEqual([100, 100, 100, 100]);
    expect(applyOverlapToBanks(RodTotalSpan)).toEqual([0, 0, 0, 0]);
  });

  it('bank B starts moving when bank A passes 100 steps (128-step overlap)', () => {
    const at100 = applyOverlapToBanks(100);
    // A withdrawn 100/228 steps, B/C/D untouched.
    expect(at100[0]!).toBeCloseTo((1 - 100 / 228) * 100, 10);
    expect(at100[1]!).toBe(100);
    const at200 = applyOverlapToBanks(200);
    // Bank C waits for its k·stride = 200 start point.
    expect(at200[2]!).toBe(100);
    const at228 = applyOverlapToBanks(228);
    // A fully out; B has withdrawn 128 steps (the overlap); C started at 200 → 28 steps.
    expect(at228[0]!).toBe(0);
    expect(at228[1]!).toBeCloseTo((1 - 128 / 228) * 100, 10);
    expect(at228[2]!).toBeCloseTo((1 - 28 / 228) * 100, 10);
    expect(at228[3]!).toBe(100); // D starts at 300
  });

  it('InferRodDemandFromBanks round-trips overlap stacks and handles legacy all-equal stacks', () => {
    for (const d of [0, 37, 100, 128, 228, 300, 413.5, 528]) {
      expect(inferRodDemandFromBanks(applyOverlapToBanks(d))).toBeCloseTo(d, 9);
    }
    // Legacy setAllRods(60%): every bank 60% inserted → bank A partial ⇒ counter = A's withdrawal.
    expect(inferRodDemandFromBanks([60, 60, 60, 60])).toBeCloseTo(0.4 * 228, 9);
  });
});

describe('manual speed-limited drive', () => {
  it('withdraws at exactly the commanded spm (72 spm → 72 steps in 60 s)', () => {
    const rc = new RodController();
    rc.driveRods(1, 72);
    const out = run(rc, {}, 60, 1.0);
    expect(out.demandSteps).toBeCloseTo(72, 6);
    expect(out.moving).toBe(true);
    expect(out.autoDirection).toBe(1);
    expect(out.rodSpeedDemandSpm).toBeCloseTo(72, 9);
    expect(out.engaged).toBe(true);
  });

  it('clamps commanded speed to the 8–72 spm drive program', () => {
    const rc = new RodController();
    rc.driveRods(1, 500); // absurd → clamps to 72
    const out = run(rc, {}, 10, 1.0);
    expect(out.demandSteps).toBeCloseTo((72 / 60) * 10, 6);
    rc.reset();
    rc.driveRods(1, 1); // below minimum → clamps to 8
    const out2 = run(rc, {}, 60, 1.0);
    expect(out2.demandSteps).toBeCloseTo(8, 6);
  });

  it('carries the fractional-step remainder across ticks (no quantization loss)', () => {
    const rc = new RodController();
    rc.driveRods(1, 8); // 8/60 = 0.1333 steps per 1 s tick
    const out = run(rc, {}, 45, 0.7); // 31.5 s at 8 spm = 4.2 steps
    expect(out.demandSteps).toBeCloseTo((8 / 60) * 45 * 0.7, 6);
  });

  it('setDemandTarget slews at the commanded spm and never overshoots', () => {
    const rc = new RodController();
    rc.driveRods(0, 60); // set speed 60 spm = 1 step/s
    rc.setDemandTarget(100);
    let out = run(rc, {}, 50, 1.0);
    expect(out.demandSteps).toBeCloseTo(50, 6); // half way after 50 s — no jump
    out = run(rc, {}, 60, 1.0);
    expect(out.demandSteps).toBe(100); // arrived, clamped exactly at target
    out = rc.step(inputs({ currentBankInsertionPct: out.bankInsertionPct }), 1.0);
    expect(out.moving).toBe(false); // and holds
    expect(rc.view().demandTargetSteps).toBeNull();
  });

  it('re-syncs from the legacy setAllRods stack while holding', () => {
    const rc = new RodController();
    // Program idle; the operator dragged the old slider to 60% inserted on all banks.
    rc.step(inputs({ currentBankInsertionPct: [60, 60, 60, 60] }), 1.0);
    const v = rc.view();
    expect(v.demandSteps).toBeCloseTo(0.4 * 228, 6); // tracked via InferRodDemandFromBanks
    expect(v.engaged).toBe(false); // holding — legacy controls still own the rods
    expect(v.bankInsertionPct).toEqual([60, 60, 60, 60]); // view shows the real stack
  });
});

describe('fuel gate', () => {
  it('blocks withdrawal without fuel (bilingual reason), insertion still allowed', () => {
    const rc = new RodController();
    rc.driveRods(1, 72);
    let out = run(rc, { fuelAvailable: false }, 10, 1.0);
    expect(out.demandSteps).toBe(0);
    expect(out.withdrawBlocked).toBe(true);
    expect(out.withdrawBlockedReasonEn.length).toBeGreaterThan(0);
    expect(out.withdrawBlockedReasonZh.length).toBeGreaterThan(0);
    expect(out.withdrawBlockedReasonEn).not.toBe(out.withdrawBlockedReasonZh);
    // Now from a withdrawn position, insertion must work with no fuel.
    rc.reset();
    rc.driveRods(1, 72);
    out = run(rc, {}, 60, 1.0); // withdraw to 72 steps with fuel
    rc.driveRods(-1, 72);
    out = rc.step(inputs({ fuelAvailable: false, currentBankInsertionPct: out.bankInsertionPct }), 30);
    expect(out.demandSteps).toBeCloseTo(72 - 36, 6);
    expect(out.withdrawBlocked).toBe(false);
    expect(out.autoDirection).toBe(-1);
  });
});

describe('Tavg/Tref automatic controller', () => {
  it('Tref program is linear in TURBINE LOAD: 289.6 °C at no load → 305.0 °C at full load', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    let out = rc.step(inputs({ turbineLoadFrac: 0 }), 1.0);
    expect(out.trefC).toBeCloseTo(NoLoadTavg, 9);
    out = rc.step(inputs({ turbineLoadFrac: 1 }), 1.0);
    expect(out.trefC).toBeCloseTo(FullLoadTavg, 9);
    out = rc.step(inputs({ turbineLoadFrac: 0.5 }), 1.0);
    expect(out.trefC).toBeCloseTo((NoLoadTavg + FullLoadTavg) / 2, 9);
  });

  it('no motion inside the ±0.833 °C deadband', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    // Start from a mid stack so motion in either direction would be visible.
    const banks = applyOverlapToBanks(264);
    const out = rc.step(
      inputs({ tavgC: NoLoadTavg + 0.5, turbineLoadFrac: 0, currentBankInsertionPct: banks }),
      2.0,
    );
    expect(out.demandSteps).toBeCloseTo(264, 6); // bumpless sync, then held
    expect(out.moving).toBe(false);
    expect(out.autoDirection).toBe(0);
    expect(out.rodSpeedDemandSpm).toBe(0);
    expect(rc.view().inDeadband).toBe(true);
  });

  it('too hot → rods step IN at the 8 spm lockup speed just outside the deadband', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(264);
    // error = +1.0 °C: deadband < e ≤ ramp start → minimum speed, inserting.
    const out = rc.step(
      inputs({ tavgC: NoLoadTavg + 1.0, turbineLoadFrac: 0, currentBankInsertionPct: banks }),
      60.0,
    );
    expect(out.autoDirection).toBe(-1);
    expect(out.rodSpeedDemandSpm).toBeCloseTo(-RodSpeedMinSpm, 9);
    expect(out.demandSteps).toBeCloseTo(264 - 8, 6); // 8 steps in one simulated minute
    expect(out.tavgTrefErrorC).toBeCloseTo(1.0, 9);
  });

  it('too cold → rods step OUT, proportional region: e=2.167 °C → 8+57.6·0.5 = 36.8 spm', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(264);
    const e = RodRampStartC + 0.5; // 2.167 °C
    const out = rc.step(
      inputs({ tavgC: NoLoadTavg - e, turbineLoadFrac: 0, currentBankInsertionPct: banks }),
      60.0,
    );
    expect(out.autoDirection).toBe(1);
    expect(out.rodSpeedDemandSpm).toBeCloseTo(RodSpeedMinSpm + RodSpeedSlopeSpm * 0.5, 6);
    expect(out.demandSteps).toBeCloseTo(264 + (RodSpeedMinSpm + RodSpeedSlopeSpm * 0.5), 5);
  });

  it('saturates at the 72 spm drive-mechanism limit for large errors', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(264);
    const out = rc.step(
      inputs({ tavgC: NoLoadTavg - 10, turbineLoadFrac: 0, currentBankInsertionPct: banks }),
      1.0,
    );
    expect(out.rodSpeedDemandSpm).toBeCloseTo(RodSpeedMaxSpm, 9);
  });

  it('power-mismatch anticipator: sign-exact C# port (load>power adds +error → insert)', () => {
    // Kept behavioural quirk of source L5334–5347: mismatch = load − power is ADDED to the
    // temperature error and combinedError>0 commands insertion. Tavg exactly on program,
    // load 1.0, power 0.5 ⇒ combined = 0 + 3·0.5 = 1.5 °C ⇒ 8 spm, stepping IN.
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(400);
    const out = rc.step(
      inputs({
        tavgC: FullLoadTavg,
        turbineLoadFrac: 1.0,
        neutronPowerFraction: 0.5,
        currentBankInsertionPct: banks,
      }),
      1.0,
    );
    expect(out.tavgTrefErrorC).toBeCloseTo(0, 9); // pure Tavg−Tref telemetry stays honest
    expect(out.autoDirection).toBe(-1);
    expect(out.rodSpeedDemandSpm).toBeCloseTo(-RodSpeedMinSpm, 9);
  });

  it('omitted neutronPowerFraction defaults the mismatch to zero (safe coupling default)', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(400);
    const out = rc.step(
      inputs({ tavgC: FullLoadTavg, turbineLoadFrac: 1.0, currentBankInsertionPct: banks }),
      1.0,
    );
    expect(out.moving).toBe(false); // on-program, no mismatch signal → deadband hold
  });

  it('AUTO engage is bumpless: demand counter syncs to the live bank stack', () => {
    const rc = new RodController();
    const banks = applyOverlapToBanks(313.7);
    rc.setControlMode('auto');
    const out = rc.step(inputs({ currentBankInsertionPct: banks }), 0.5);
    expect(out.demandSteps).toBeCloseTo(313.7, 6);
  });

  it('AUTO withdrawal is fuel-gated too', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    const banks = applyOverlapToBanks(264);
    const out = rc.step(
      inputs({ tavgC: NoLoadTavg - 5, turbineLoadFrac: 0, fuelAvailable: false, currentBankInsertionPct: banks }),
      10.0,
    );
    expect(out.demandSteps).toBeCloseTo(264, 6);
    expect(out.withdrawBlocked).toBe(true);
    expect(out.moving).toBe(false);
  });
});

describe('scram handling', () => {
  it('freezes on trip, drops AUTO (C# Scram sets AutoRodControl=false), re-infers on release', () => {
    const rc = new RodController();
    rc.setControlMode('auto');
    // Drive out under auto for a while (too cold → withdraw).
    let out = run(rc, { tavgC: NoLoadTavg - 5, turbineLoadFrac: 0 }, 120, 1.0);
    expect(out.demandSteps).toBeGreaterThan(100);
    // Trip: rods dropping, banks slam toward fully inserted; program must freeze + disengage.
    const dBefore = out.demandSteps;
    out = rc.step(
      inputs({ scrammed: true, rodsDropping: true, currentBankInsertionPct: [55, 70, 90, 100] }),
      1.0,
    );
    expect(out.demandSteps).toBe(dBefore); // counter NOT reset mid-drop (post-trip telemetry honest)
    expect(out.engaged).toBe(false);
    expect(out.moving).toBe(false);
    expect(out.withdrawBlocked).toBe(true);
    expect(rc.view().mode).toBe('manual'); // AUTO forced off by the trip
    expect(rc.view().bankInsertionPct).toEqual([55, 70, 90, 100]); // view tracks the real drop
    // Trip clears with all rods seated → demand re-inferred from the actual banks (all-in = 0).
    out = rc.step(inputs({ currentBankInsertionPct: [100, 100, 100, 100] }), 1.0);
    expect(out.demandSteps).toBe(0);
    // Auto does not silently re-engage.
    out = rc.step(inputs({ tavgC: NoLoadTavg - 5 }), 60.0);
    expect(out.moving).toBe(false);
  });
});

describe('bilingual strings & i18n slice', () => {
  it('status pairs are non-empty and distinct in every regime', () => {
    const rc = new RodController();
    const check = () => {
      const v = rc.view();
      expect(v.statusEn.length).toBeGreaterThan(0);
      expect(v.statusZh.length).toBeGreaterThan(0);
      expect(v.statusEn).not.toBe(v.statusZh);
    };
    rc.step(inputs(), 1.0); // manual hold
    check();
    rc.driveRods(1, 40);
    rc.step(inputs(), 1.0); // manual stepping out
    check();
    expect(rc.view().statusZh).toContain('提棒');
    rc.driveRods(-1);
    rc.step(inputs(), 1.0); // manual stepping in
    check();
    expect(rc.view().statusZh).toContain('插棒');
    rc.step(inputs({ scrammed: true, rodsDropping: true }), 1.0); // tripped
    check();
    rc.reset();
    rc.setControlMode('auto');
    rc.step(inputs(), 1.0); // auto deadband hold
    check();
    rc.driveRods(1, 40); // ignored in AUTO
    expect(rc.view().manualDirection).toBe(0);
    rc.step(inputs({ fuelAvailable: false, tavgC: NoLoadTavg - 5 }), 1.0); // withdrawal blocked
    check();
  });

  it('i18n slice: En/Yue key parity, all leaves non-empty', () => {
    const en = enReactorRods.reactorrods as Record<string, string>;
    const yue = yueReactorRods.reactorrods as Record<string, string>;
    expect(Object.keys(yue).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect(en[k]!.length).toBeGreaterThan(0);
      expect(yue[k]!.length).toBeGreaterThan(0);
    }
  });
});
