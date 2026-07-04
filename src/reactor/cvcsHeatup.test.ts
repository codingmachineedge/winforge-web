// CVCS 硼混合器 + 泵熱升溫 · CVCS blender, uncontrolled-dilution scenario, RCP pump-heat heatup
// and the fuel-availability gate — mirroring ReactorSimService.cs semantics (blender enum L179,
// UpdateBoron 4 ppm/s L4286, exponential dilution L3396, doubling alarm L5765, fuel gate L6233).

import { describe, it, expect } from 'vitest';
import { BoronRampPpmPerS, CvcsBlenderMode, CvcsBoricAcidTankPpm, ReactorSim, ReactorMode, ReactorTechSpecMode } from './physics';

describe('CVCS makeup blender', () => {
  it('Borate lineup raises boron toward the 7000 ppm tank at ≤4 ppm/s', () => {
    const r = new ReactorSim();
    const c0 = r.boronPpm; // 1200 nominal
    r.setBlenderMode(CvcsBlenderMode.Borate);
    const dt = 0.5;
    let prev = c0;
    let maxRate = 0;
    for (let i = 0; i < 200; i++) {
      r.update(dt); // held Shutdown mode still runs updateBoron
      maxRate = Math.max(maxRate, (r.boronPpm - prev) / dt);
      prev = r.boronPpm;
    }
    // 100 s at 4 ppm/s = +400 ppm
    expect(r.boronPpm).toBeGreaterThan(c0 + 390);
    expect(r.boronPpm).toBeLessThan(c0 + 410);
    expect(maxRate).toBeLessThanOrEqual(BoronRampPpmPerS + 1e-9);
    expect(CvcsBoricAcidTankPpm).toBe(7000.0);
  });

  it('Dilute lineup lowers boron toward 0 ppm RMW; Automatic re-holds the operator target', () => {
    const r = new ReactorSim();
    const c0 = r.boronPpm;
    r.setBlenderMode(CvcsBlenderMode.Dilute);
    for (let i = 0; i < 100; i++) r.update(0.5); // 50 s → −200 ppm
    const afterDilute = r.boronPpm;
    expect(afterDilute).toBeLessThan(c0 - 190);
    // Back to Automatic: boron slews back up toward the (unchanged) operator target.
    r.setBlenderMode(CvcsBlenderMode.Automatic);
    for (let i = 0; i < 100; i++) r.update(0.5);
    expect(r.boronPpm).toBeGreaterThan(afterDilute + 150);
    expect(r.targetBoronPpm).toBe(c0); // lineup never rewrites the target
  });
});

describe('uncontrolled boron dilution scenario', () => {
  it('decays boron exponentially through the RCS mix volume and recovers after termination', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup);
    const flowGpm = 1500; // accident-study flow to make the transient visible quickly
    const c0 = r.boronPpm;
    r.startUncontrolledDilution(flowGpm);
    expect(r.dilutionActive).toBe(true);
    const dt = 1.0;
    const seconds = 2000;
    for (let i = 0; i < seconds; i++) r.update(dt);
    const k = flowGpm / 80000 / 60; // 1/s — must match RcsMixVolumeGal
    const expected = c0 * Math.exp(-k * seconds);
    expect(Math.abs(r.boronPpm - expected) / expected).toBeLessThan(0.02);
    // Operator terminates inside the action window: boron stops falling and recovers toward target.
    r.terminateDilution();
    const atTerm = r.boronPpm;
    for (let i = 0; i < 60; i++) r.update(1.0);
    expect(r.dilutionActive).toBe(false);
    expect(r.boronPpm).toBeGreaterThan(atTerm); // Automatic lineup pulls back toward 1200
  });

  it('raises the count-rate-doubling alarm as subcritical multiplication grows', () => {
    // The textbook event: rods fully inserted, shut down, and unborated water flows in.
    // Subcritical multiplication grows as boron blends out, the SR count rate doubles
    // (SR stays energized — power never gets near P-6), and the alarm annunciates.
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup);
    // Let the init flux transient die out so the SR reads its true deep-subcritical floor —
    // the doubling reference must be the settled count rate, as an operator would log it.
    for (let i = 0; i < 600; i++) r.update(1.0);
    r.startUncontrolledDilution(3000);
    let sawDoubling = false;
    for (let i = 0; i < 6000 && !sawDoubling; i++) {
      r.update(1.0);
      if (r.state().alarms.includes('Boron Dilution — Count Rate Doubling')) sawDoubling = true;
      if (r.isScrammed) break; // a protective trip ends the scenario — that's fine, but the alarm must precede it
    }
    expect(sawDoubling).toBe(true);
  });
});

describe('RCP pump-heat heatup path', () => {
  it('a cold plant reaches hot standby (MODE 3, Tavg ≥ 176.7 °C) on pump heat alone', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup); // rods stay fully inserted — zero fission power
    for (let i = 0; i < 4; i++) r.startRcp(i);
    r.rcpFlowDemand = 1.0;
    r.feedwaterFlow = 0.0; // SGs isolated during heatup
    const tavg0 = r.tavg;
    const dt = 2.0;
    let tHot: number | null = null;
    for (let i = 0; i < 3600; i++) {
      // 2 h of sim-time budget
      r.update(dt);
      if (tHot === null && r.tavg >= 176.7) tHot = (i + 1) * dt;
    }
    expect(r.neutronPowerFraction).toBeLessThan(1e-3); // still shut down — this is pump heat, not fission
    expect(r.tavg).toBeGreaterThan(176.7);
    expect(tHot).not.toBeNull(); // reached hot standby…
    // …but NOT instantly: minutes of sim-time from cold (the sim clock is compressed ~30-60×,
    // so ~6 sim-minutes ≈ the real multi-hour pump-heat heatup).
    expect(tHot!).toBeGreaterThan(240);
    expect(r.state().tsMode).toBe(ReactorTechSpecMode.HotStandby);
    expect(tavg0).toBeLessThan(50);
  });

  it('without pumps the cold plant stays cold — no phantom heat source', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup);
    for (let i = 0; i < 1000; i++) r.update(2.0);
    expect(r.tavg).toBeLessThan(60);
    expect(r.state().tsMode).toBe(ReactorTechSpecMode.ColdShutdown);
  });
});

describe('fuel-availability gate', () => {
  it('blocks Startup/Run and rod withdrawal with no fuel, with the bilingual gate note', () => {
    const r = new ReactorSim();
    r.fuelAvailable = false;
    r.setMode(ReactorMode.Startup);
    expect(r.mode).toBe(ReactorMode.Shutdown); // blocked
    r.setRodBank(0, 40); // withdrawal attempt from 100% inserted
    expect(r.rodBankInsertion[0]).toBe(100);
    const s = r.state();
    expect(s.fuelGateNoteEn).toContain('No fuel loaded');
    expect(s.fuelGateNoteZh).toContain('未裝燃料');
    // Insertion is never blocked (safety direction).
    r.rodBankInsertion[1] = 50;
    r.setRodBank(1, 90);
    expect(r.rodBankInsertion[1]).toBe(90);
    // Fuel back in: gate opens and the note self-clears on the next tick.
    r.fuelAvailable = true;
    r.setMode(ReactorMode.Startup);
    expect(r.mode).toBe(ReactorMode.Startup);
    r.update(0.1);
    expect(r.state().fuelGateNoteEn).toBe('');
  });
});
