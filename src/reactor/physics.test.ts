// 反應堆物理單元測試 · Physics unit tests mirroring WinForge's headless C# reactor scenario suite
// (tests/ReactorSim.Tests/Program.cs → PhysicsScenarios). Each test drives the pure TypeScript
// engine deterministically and asserts the same mechanism the C# harness asserts.

import { describe, it, expect } from 'vitest';
import { ReactorSim, ReactorMode } from './physics';

const finite = (x: number) => Number.isFinite(x);
const avg = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s / a.length;
};

describe('point-kinetics physics engine', () => {
  // COLD-SHUTDOWN HELD — no runaway when left alone; operator must start it up.
  it('held cold shutdown stays subcritical and finite for 5 minutes', () => {
    const r = new ReactorSim();
    const dt = 0.1;
    const steps = (5 * 60) / dt;
    let maxPower = 0;
    for (let i = 0; i < steps; i++) {
      r.update(dt);
      maxPower = Math.max(maxPower, r.neutronPowerFraction);
    }
    expect(finite(r.neutronPowerFraction)).toBe(true);
    expect(finite(r.fuelTemp)).toBe(true);
    expect(maxPower).toBeLessThanOrEqual(r.sourceLevel * 1000 + 1e-5);
    expect(r.mode).toBe(ReactorMode.Shutdown);
    expect(r.meltdownTriggered).toBe(false);
  });

  // STARTUP STABILITY — backward-Euler integration: no NaN/Inf, no runaway to the clamp.
  it('startup ramp stays finite and never runs away to the numerical clamp', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup);
    for (let i = 0; i < 4; i++) r.startRcp(i);
    r.rcpFlowDemand = 1.0;
    r.feedwaterFlow = 1.0;
    r.targetBoronPpm = 800;
    const dt = 0.1;
    let everNonFinite = false;
    let hitClamp = false;
    for (let step = 0; step < 600; step++) {
      const insertion = Math.max(70, 100 - step * 0.05);
      r.setAllRods(insertion);
      r.update(dt);
      const p = r.neutronPowerFraction;
      if (!finite(p) || !finite(r.fuelTemp) || !finite(r.reactivityPcm)) everNonFinite = true;
      if (p >= 49.9) hitClamp = true;
    }
    expect(everNonFinite).toBe(false);
    expect(hitClamp).toBe(false);
    expect(r.mode).not.toBe(ReactorMode.Meltdown);
    expect(finite(r.neutronPowerFraction)).toBe(true);
  });

  // STARTUP MODE ALONE does not make a fresh fully-rodded cold core critical.
  it('startup mode with all rods in stays deeply subcritical', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Startup);
    r.update(0.1);
    const rhoAtStart = r.reactivityPcm;
    const pAfter1 = r.neutronPowerFraction;
    const modeAfter = r.mode;
    for (let i = 0; i < 50; i++) r.update(0.1);
    expect(rhoAtStart).toBeLessThan(-1000);
    expect(pAfter1).toBeLessThan(1e-3);
    expect(modeAfter).toBe(ReactorMode.Startup);
    expect(r.mode).not.toBe(ReactorMode.Meltdown);
    expect(r.meltdownTriggered).toBe(false);
  });

  // EASY STARTUP — a limited beginner assist (+500 pcm), NOT a bypass; core still subcritical.
  it('easy-startup assist is exactly +500 pcm and keeps the core subcritical', () => {
    const normal = new ReactorSim();
    normal.setMode(ReactorMode.Startup);
    normal.update(0.1);

    const easy = new ReactorSim();
    easy.easyStartupMode = true;
    easy.setMode(ReactorMode.Startup);
    easy.update(0.1);

    const deltaPcm = easy.reactivityPcm - normal.reactivityPcm;
    expect(Math.abs(easy.easyStartupAssistActivePcm - 500.0)).toBeLessThan(1e-6);
    expect(deltaPcm).toBeGreaterThan(450.0);
    expect(deltaPcm).toBeLessThan(550.0);
    expect(easy.reactivityPcm).toBeLessThan(0.0);
    expect(easy.neutronPowerFraction).toBeLessThan(1e-3);
    expect(easy.isScrammed).toBe(false);
    expect(easy.meltdownTriggered).toBe(false);
  });

  // SCRAM MECHANISM — trip latches, rods held for the release dead-time, then gravity-drop.
  it('scram latches the trip, holds the release delay, then drops the rods', () => {
    const r = new ReactorSim();
    r.setAllRods(10.0); // withdraw first
    const rodsBefore = avg(r.rodBankInsertion);
    r.scram();
    const rodsLatched = avg(r.rodBankInsertion);
    const releaseDelayHeld =
      Math.abs(rodsLatched - rodsBefore) < 1e-9 && !r.rodsDropping && r.rodDropElapsedS === 0.0;
    let sawMotion = false;
    for (let i = 0; i < 10; i++) {
      r.update(0.1);
      if (avg(r.rodBankInsertion) > rodsBefore + 0.1 || r.rodsDropping) sawMotion = true;
    }
    expect(releaseDelayHeld).toBe(true);
    expect(sawMotion).toBe(true);
    expect(r.mode).toBe(ReactorMode.Tripped);
    expect(r.isScrammed).toBe(true);
    expect(finite(r.neutronPowerFraction)).toBe(true);
  });

  // SCRAM SHUTDOWN MARGIN — a tripped fully-rodded core stays subcritical, never melts down.
  it('tripped fully-rodded core stays subcritical over 60 s', () => {
    const r = new ReactorSim();
    r.scram();
    let wentMeltdown = false;
    for (let i = 0; i < 600; i++) {
      r.update(0.1);
      if (r.mode === ReactorMode.Meltdown) {
        wentMeltdown = true;
        break;
      }
    }
    expect(wentMeltdown).toBe(false);
    expect(r.isScrammed).toBe(true);
    expect(r.mode).toBe(ReactorMode.Tripped);
    expect(r.reactivityPcm).toBeLessThan(-1000);
  });

  // DECAY HEAT — charges while fission power is present, then decays after the trip; bounded ≤ 0.10.
  it('decay heat charges while at power and decays (bounded) after a trip', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Run);
    r.setAllRods(70.0);
    const dt = 0.1;
    let decayPeak = 0;
    for (let i = 0; i < 50; i++) {
      r.update(dt);
      decayPeak = Math.max(decayPeak, r.decayHeatFraction);
    }
    r.scram();
    const dStart = r.decayHeatFraction;
    for (let i = 0; i < 6000; i++) r.update(dt); // 600 s
    const dEnd = r.decayHeatFraction;
    expect(decayPeak).toBeGreaterThan(0.0);
    expect(dEnd).toBeLessThanOrEqual(dStart + 1e-9);
    expect(dEnd).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(finite(dEnd)).toBe(true);
  });

  // OVERPOWER PROTECTION — the RPS auto-SCRAMs on a power excursion (rods out at cold).
  it('RPS auto-scrams on an overpower excursion', () => {
    const r = new ReactorSim();
    r.setMode(ReactorMode.Run);
    r.setAllRods(0); // rods out → cold-moderator positive reactivity → excursion
    const dt = 0.1;
    let autoScrammed = false;
    let peakPower = 0;
    for (let i = 0; i < 6000; i++) {
      r.update(dt);
      peakPower = Math.max(peakPower, r.neutronPowerFraction);
      if (r.isScrammed) {
        autoScrammed = true;
        break;
      }
    }
    expect(autoScrammed).toBe(true);
    expect(r.isScrammed).toBe(true);
    expect(r.lastTripFunctionEn.length).toBeGreaterThan(0);
    expect(peakPower).toBeGreaterThan(0);
  });

  // EASY STARTUP suppresses the automatic SCRAM (beginner mode).
  it('easy-startup mode suppresses the automatic scram on an excursion', () => {
    const r = new ReactorSim();
    r.easyStartupMode = true;
    r.setMode(ReactorMode.Run);
    r.setAllRods(0);
    const dt = 0.1;
    for (let i = 0; i < 2000; i++) {
      r.update(dt);
      if (r.mode === ReactorMode.Meltdown) break;
    }
    expect(r.isScrammed).toBe(false);
    expect(r.mode).not.toBe(ReactorMode.Tripped);
  });

  // XENON transient — post-trip iodine-pit jump, then Xe-135 decays monotonically.
  it('xenon jumps on restart then decays over two hours', () => {
    const r = new ReactorSim();
    r.triggerXenonRestart();
    const xeJump = r.xenon;
    const dt = 0.5;
    const xe0 = r.xenon;
    for (let i = 0; i < 3600 / dt; i++) r.update(dt); // 1 h held in Shutdown
    const xe1h = r.xenon;
    for (let i = 0; i < 3600 / dt; i++) r.update(dt); // another hour
    const xe2h = r.xenon;
    const eps = 1e-6;
    expect(xeJump).toBeGreaterThanOrEqual(2.5);
    expect(xe1h).toBeLessThanOrEqual(xe0 + eps);
    expect(xe2h <= xe1h + eps || xe2h <= eps).toBe(true);
    expect(finite(xe2h)).toBe(true);
  });

  // FUEL CYCLE — burnup accrues, critical boron letdown falls, β_eff drops toward EOL.
  it('fuel-cycle burnup shifts critical boron and beta toward EOL', () => {
    const r = new ReactorSim();
    r.warmStartCritical();
    const bolCriticalBoron = r.criticalBoronPpm;
    const bolBeta = r.betaEffectivePcm;
    r.depletionAccel = 5000; // fast-forward the cycle
    for (let i = 0; i < 20000; i++) r.update(1.0);
    expect(r.cycleFraction).toBeGreaterThan(0.0);
    expect(r.criticalBoronPpm).toBeLessThan(bolCriticalBoron);
    expect(r.betaEffectivePcm).toBeLessThan(bolBeta);
    expect(finite(r.reactivityPcm)).toBe(true);
    expect(r.mode).not.toBe(ReactorMode.Meltdown);
  });
});
