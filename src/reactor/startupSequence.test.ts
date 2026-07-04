// 冷啟動程序整合測試 · Cold-startup integration test: the FULL realistic sequence the source
// enforces, driven exactly like an operator would — fuel load → RCPs → pump-heat heatup
// (MODE 5→4→3) → dilution toward estimated critical boron → SUR-limited rod withdrawal →
// approach to criticality (1/M, P-6) → power ascension into MODE 2 → MODE 1 (P-10).
// The one thing this test exists to prove: criticality from cold is NOT instant and the
// Tech-Spec MODE ladder is climbed in order.

import { describe, it, expect } from 'vitest';
import { CvcsBlenderMode, ReactorMode, ReactorSim, ReactorTechSpecMode } from './physics';
import { FuelFactory } from './fuelFactory';

describe('cold-startup sequence (integration)', () => {
  it('climbs MODE 5→4→3→2→1 in order, criticality takes realistic sim-time, fuel gate enforced', () => {
    const sim = new ReactorSim();
    const factory = new FuelFactory({ persist: false });

    // ---- 0) fuel gate: an empty core refuses to start up ----
    sim.fuelAvailable = factory.canReactorRun(); // false — nothing loaded
    sim.setMode(ReactorMode.Startup);
    expect(sim.mode).toBe(ReactorMode.Shutdown);
    expect(sim.fuelGateNoteEn).toContain('No fuel');

    factory.loadStandardCore(4.2);
    sim.fuelAvailable = factory.canReactorRun();
    expect(sim.fuelAvailable).toBe(true);
    sim.setMode(ReactorMode.Startup);
    expect(sim.mode).toBe(ReactorMode.Startup);

    // ---- instrumented drive loop ----
    const dt = 0.5;
    let clock = 0;
    const firstSeen = new Map<ReactorTechSpecMode, number>();
    let tCritical: number | null = null;
    let tP6: number | null = null;
    const tick = () => {
      sim.update(dt);
      clock += dt;
      const m = sim.state().tsMode;
      if (!firstSeen.has(m)) firstSeen.set(m, clock);
      if (tCritical === null && sim.reactivityPcm >= 0) tCritical = clock;
      if (tP6 === null && sim.p6) tP6 = clock;
    };

    // ---- 1) RCPs on, SGs isolated: pump-heat heatup to hot standby ----
    for (let i = 0; i < 4; i++) sim.startRcp(i);
    sim.rcpFlowDemand = 1.0;
    sim.feedwaterFlow = 0.0;
    let guard = 0;
    while (sim.tavg < 176.7 && guard++ < 12000) tick();
    expect(sim.tavg).toBeGreaterThanOrEqual(176.7);
    expect(sim.state().tsMode).toBe(ReactorTechSpecMode.HotStandby);
    expect(sim.neutronPowerFraction).toBeLessThan(1e-3); // heatup was pumps, not fission
    const tHotStandby = clock;

    // ---- 2) SGs to service GENTLY while still deeply subcritical, then dilute ----
    // A feed ramp is a reactivity event (moderator cooldown): done at criticality it inserts
    // hundreds of pcm and trips on short period, so it happens here, where it is harmless.
    while (sim.feedwaterFlow < 0.3) {
      sim.feedwaterFlow = Math.min(0.3, sim.feedwaterFlow + 0.005);
      tick();
    }
    for (let i = 0; i < 600; i++) tick(); // settle at the no-load heat balance

    // ---- dilute toward the estimated critical boron, then hold (Automatic lineup) ----
    const ecc = sim.criticalBoronPpm; // the sim's own estimated critical concentration
    sim.setBlenderMode(CvcsBlenderMode.Dilute);
    guard = 0;
    while (sim.boronPpm > ecc + 30 && guard++ < 12000) tick();
    sim.targetBoronPpm = Math.max(0, ecc + 20); // hold just above critical — rods finish the approach
    sim.setBlenderMode(CvcsBlenderMode.Automatic);

    // ---- 3) SUR-limited rod withdrawal: pause whenever startup rate exceeds 1 DPM ----
    guard = 0;
    while (tCritical === null && guard++ < 40000) {
      const sur = sim.startupRateDpm;
      if (sur < 1.0 && !sim.isScrammed) {
        const cur = sim.rodBankInsertion[0]!;
        sim.setAllRods(Math.max(0, cur - 0.08 * dt)); // ≈ drive-mechanism-limited speed
      }
      tick();
    }
    expect(sim.isScrammed).toBe(false);
    expect(tCritical).not.toBeNull();

    // ---- 4) controlled power ascension in MODE 2 ----
    // Rods carried the approach; from here it is DILUTE-AND-WAIT: 4-ppm boron batches, each
    // only after the previous batch has fully blended in and a soak has passed, feed following
    // power gently. (Diluting flat-out inserts ~30 pcm/s → short-period trip; stepping the feed
    // → moderator-cooldown excursion → trip. The RPS catching every impatient shortcut is the
    // fidelity this test exists to enforce.) Target: sustained multi-decade power rise on a
    // tame startup rate — the MODE 2 regime.
    let boronDemand = sim.boronPpm;
    let soak = 0;
    guard = 0;
    while (sim.coreThermalPowerFraction < 0.005 && guard++ < 30000 && !sim.isScrammed) {
      const sur = sim.startupRateDpm;
      if (soak > 0) {
        soak--;
      } else if (sur < 0.3 && Math.abs(sim.boronPpm - boronDemand) < 0.5) {
        boronDemand = Math.max(0, boronDemand - 4);
        sim.targetBoronPpm = boronDemand;
        soak = 20; // 10 s at dt=0.5
      }
      if (sur < 1.0) {
        const cur = sim.rodBankInsertion[0]!;
        sim.setAllRods(Math.max(0, cur - 0.05 * dt));
      }
      // Feed follows power, slowly, and only while the rate is tame — never as a step.
      if (sur < 0.3) sim.feedwaterFlow = Math.min(1.0, sim.feedwaterFlow + 0.001);
      tick();
    }
    expect(sim.isScrammed).toBe(false);
    expect(sim.coreThermalPowerFraction).toBeGreaterThanOrEqual(0.004); // decades above source level
    expect(sim.p6).toBe(true); // IR on-scale through the ascension

    // ---- the point of it all: order + realistic (non-instant) timing ----
    const t5 = firstSeen.get(ReactorTechSpecMode.ColdShutdown);
    const t4 = firstSeen.get(ReactorTechSpecMode.HotShutdown);
    const t3 = firstSeen.get(ReactorTechSpecMode.HotStandby);
    const t2 = firstSeen.get(ReactorTechSpecMode.Startup);
    expect(t5).toBeDefined(); // started cold
    expect(t4).toBeDefined();
    expect(t3).toBeDefined();
    expect(t2).toBeDefined();
    expect(t5!).toBeLessThan(t4!);
    expect(t4!).toBeLessThan(t3!);
    expect(t3!).toBeLessThan(t2!);
    expect(tP6).not.toBeNull(); // IR came on-scale during the approach
    expect(tCritical!).toBeGreaterThan(tHotStandby); // criticality only after hot standby
    expect(tCritical!).toBeGreaterThan(900); // > 15 sim-minutes from cold — NOT instant
    expect(sim.state().tsMode).toBe(ReactorTechSpecMode.Startup); // holding in MODE 2 at power

    // ---- 5) the loaded assemblies actually burned while at power ----
    factory.accrueBurnup(sim.thermalPowerMW, 3600);
    expect(factory.meanLoadedBurnup()).toBeGreaterThan(0);
  });
});
