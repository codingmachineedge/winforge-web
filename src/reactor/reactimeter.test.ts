// 反應性計單元測試 · Reactimeter (inverse point-kinetics) tests. Drive the meter with a synthetic
// neutron-flux signal and confirm it recovers the reactor period, startup rate, and reads ~0 at
// steady state — the behaviours a field reactivity computer must exhibit in startup physics testing.

import { describe, it, expect } from 'vitest';
import { Reactimeter } from './reactimeter';

// Match the engine's six-group BOL kinetics constants.
const Beta = new Float64Array([0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273]);
const Lambda = new Float64Array([0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01]);
const PromptLifetime = 2.0e-5;

describe('reactimeter — inverse point kinetics', () => {
  it('reads ~0 reactivity and ~0 startup rate at steady equilibrium flux', () => {
    const m = new Reactimeter(Beta, Lambda, PromptLifetime);
    m.reset(1.0, 1.0);
    for (let i = 0; i < 200; i++) m.update(1.0, 0.1, 1.0, 1e-9);
    expect(Math.abs(m.reactivityPcm)).toBeLessThan(20);
    expect(Math.abs(m.startupRateDpm)).toBeLessThan(0.05);
    expect(Math.abs(m.periodSeconds)).toBeGreaterThan(1e6); // effectively infinite
  });

  it('recovers a positive reactor period and startup rate on a rising exponential flux', () => {
    const m = new Reactimeter(Beta, Lambda, PromptLifetime);
    const T = 100.0; // s asymptotic period
    let n = 1.0;
    const dt = 0.1;
    m.reset(n, 1.0);
    // Let the reconstructed precursors settle onto the ramp, then measure.
    for (let i = 0; i < 3000; i++) {
      n *= Math.exp(dt / T);
      m.update(n, dt, 1.0, 1e-9);
    }
    expect(m.periodSeconds).toBeGreaterThan(0);
    expect(m.periodSeconds).toBeGreaterThan(60);
    expect(m.periodSeconds).toBeLessThan(160);
    // SUR = 60/(T·ln10) = 26.056/T ≈ 0.26 DPM at T=100 s.
    expect(m.startupRateDpm).toBeGreaterThan(0.15);
    expect(m.startupRateDpm).toBeLessThan(0.40);
    expect(m.reactivityPcm).toBeGreaterThan(0); // rising flux ⇒ positive net reactivity
    expect(m.positiveRateAlarm).toBe(false); // 0.26 DPM is below the +1 DPM advisory
  });

  it('flags the positive-rate advisory on a brisk (> +1 DPM) ramp', () => {
    const m = new Reactimeter(Beta, Lambda, PromptLifetime);
    const T = 20.0; // brisk: SUR ≈ 1.3 DPM
    let n = 1e-3;
    const dt = 0.1;
    m.reset(n, 1.0);
    let sawAlarm = false;
    for (let i = 0; i < 2000; i++) {
      n *= Math.exp(dt / T);
      m.update(n, dt, 1.0, 1e-9);
      if (m.positiveRateAlarm) sawAlarm = true;
    }
    expect(sawAlarm).toBe(true);
    expect(m.startupRateDpm).toBeGreaterThan(1.0);
  });

  it('mark then integrate reports a measured worth', () => {
    const m = new Reactimeter(Beta, Lambda, PromptLifetime);
    let n = 1.0;
    const dt = 0.1;
    m.reset(n, 1.0);
    for (let i = 0; i < 100; i++) m.update(n, dt, 1.0, 1e-9);
    expect(m.hasMark).toBe(false);
    m.mark();
    expect(m.hasMark).toBe(true);
    // Now ramp up: measured reactivity climbs positive, so worth vs the mark is positive.
    for (let i = 0; i < 300; i++) {
      n *= Math.exp(dt / 50.0);
      m.update(n, dt, 1.0, 1e-9);
    }
    expect(m.measuredWorthPcm).toBeGreaterThan(0);
    m.clearMark();
    expect(m.hasMark).toBe(false);
    expect(m.measuredWorthPcm).toBe(0);
  });
});
