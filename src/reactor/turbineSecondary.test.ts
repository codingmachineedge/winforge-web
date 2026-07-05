// Turbine / secondary balance-of-plant — behavioural tests against the prototype reference
// (material-design-rewrite reactor-sim.js): governor roll, breaker auto-sync/drop, steam dump,
// SG level integration, MWe gating on the breaker.

import { describe, expect, it } from 'vitest';
import { TurbineSecondary, TurbineRatedRpm } from './turbineSecondary';

/** Hot full-flow plant inputs (Tavg 305 °C, header at no-load 6.9 MPa, full feed). */
const hot = (over: Partial<Parameters<TurbineSecondary['step']>[0]> = {}) => ({
  tavgC: 305,
  coolantFlowFraction: 1,
  feedwaterFlow: 1,
  steamPressureMPa: 6.9,
  meltdown: false,
  ...over,
});

function run(t: TurbineSecondary, inp: ReturnType<typeof hot>, seconds: number, dt = 0.5) {
  let out = { electricMW: 0, steamFlowFrac: 0 };
  for (let i = 0; i < Math.round(seconds / dt); i++) out = t.step(inp, dt);
  return out;
}

describe('TurbineSecondary', () => {
  it('stays still unlatched, rolls to 1800 rpm when latched with steam', () => {
    const t = new TurbineSecondary();
    run(t, hot(), 10);
    expect(t.rpm).toBe(0);
    t.setLatched(true);
    run(t, hot(), 3);
    expect(t.rpm).toBeGreaterThan(500); // 260 rpm/s roll
    run(t, hot(), 10);
    expect(t.rpm).toBe(TurbineRatedRpm);
  });

  it('auto-syncs the generator breaker near rated speed and produces MWe only then', () => {
    const t = new TurbineSecondary();
    t.setLatched(true);
    const early = run(t, hot(), 2); // ~520 rpm — not synced
    expect(t.breakerClosed).toBe(false);
    expect(early.electricMW).toBe(0);
    const late = run(t, hot(), 10);
    expect(t.breakerClosed).toBe(true);
    expect(late.electricMW).toBeGreaterThan(0);
  });

  it('unlatching opens the breaker immediately and the turbine coasts down', () => {
    const t = new TurbineSecondary();
    t.setLatched(true);
    run(t, hot(), 12);
    expect(t.breakerClosed).toBe(true);
    t.setLatched(false);
    expect(t.breakerClosed).toBe(false);
    const rpmAtTrip = t.rpm;
    run(t, hot(), 2);
    expect(t.rpm).toBeLessThan(rpmAtTrip); // 170 rpm/s coastdown
  });

  it('breaker drops below 1500 rpm when steam is lost', () => {
    const t = new TurbineSecondary();
    t.setLatched(true);
    run(t, hot(), 12);
    expect(t.breakerClosed).toBe(true);
    // cold plant: no steam available → governor can't hold speed
    run(t, hot({ tavgC: 60, steamPressureMPa: 0.5 }), 3);
    expect(t.rpm).toBeLessThan(1500);
    expect(t.breakerClosed).toBe(false);
  });

  it('steam-dump valves open above 7.6 MPa header pressure', () => {
    const t = new TurbineSecondary();
    t.step(hot({ steamPressureMPa: 8.2 }), 0.5);
    const v = t.view();
    expect(v.steamDumpFrac).toBeGreaterThan(0);
    expect(v.steamDumpFrac).toBeLessThanOrEqual(0.6);
    t.step(hot({ steamPressureMPa: 6.9 }), 0.5);
    expect(t.view().steamDumpFrac).toBe(0);
  });

  it('SG level rises on full feed with no steam draw and relaxes toward 50 %', () => {
    const t = new TurbineSecondary();
    run(t, hot(), 20); // unlatched: feed in, no turbine draw
    expect(t.sgLevelPct).toBeGreaterThan(50);
    run(t, hot({ feedwaterFlow: 0 }), 120);
    expect(t.sgLevelPct).toBeLessThanOrEqual(52); // relaxes back down without feed
  });

  it('meltdown trips the roll even while latched', () => {
    const t = new TurbineSecondary();
    t.setLatched(true);
    run(t, hot(), 12);
    expect(t.rpm).toBe(TurbineRatedRpm);
    run(t, hot({ meltdown: true }), 4);
    expect(t.rpm).toBeLessThan(TurbineRatedRpm);
  });

  it('reset returns everything to cold-iron', () => {
    const t = new TurbineSecondary();
    t.setLatched(true);
    run(t, hot(), 12);
    t.reset();
    const v = t.view();
    expect(v.rpm).toBe(0);
    expect(v.latched).toBe(false);
    expect(v.breakerClosed).toBe(false);
    expect(v.sgLevelPct).toBe(50);
  });
});
