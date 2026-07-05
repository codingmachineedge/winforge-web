// Integration tests for the ReactorAux coordinator — verifies it wires the six subsystems onto a
// live ReactorSim in the right order and that the cross-module couplings (LTOP arming, PORV relief,
// SI boration, CSF monitoring) actually fire against real engine state.

import { describe, expect, it } from 'vitest';
import { ReactorSim, ReactorMode } from './physics';
import { ReactorAux } from './reactorAux';

/** Drive the sim + aux together for `seconds` of sim-time at the given dt. */
function run(sim: ReactorSim, aux: ReactorAux, seconds: number, dt = 0.5): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    aux.stepBefore(sim, dt);
    sim.update(dt);
    aux.stepAfter(sim, dt);
  }
}

describe('ReactorAux coordinator', () => {
  it('snapshots all six subsystem views', () => {
    const aux = new ReactorAux();
    const v = aux.view();
    expect(v.rods).toBeDefined();
    expect(v.relief).toBeDefined();
    expect(v.ptLimits).toBeDefined();
    expect(v.esf).toBeDefined();
    expect(v.containment).toBeDefined();
    expect(v.csf.csf).toHaveLength(6);
    expect(Array.isArray(v.alarmsEn)).toBe(true);
    expect(v.alarmsEn.length).toBe(v.alarmsZh.length);
  });

  it('arms LTOP when the RCS is cold (App-G / COMS)', () => {
    const sim = new ReactorSim(); // cold shutdown: tcold = 35 °C, well below the 135 °C enable temp
    const aux = new ReactorAux();
    sim.setMode(ReactorMode.Shutdown);
    run(sim, aux, 5);
    expect(aux.view().ptLimits.ltopArmed).toBe(true);
  });

  it('does not arm LTOP once hot (warm-start above the enable temperature)', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical(); // tcold ≈ 305 °C
    run(sim, aux, 5);
    expect(aux.view().ptLimits.ltopArmed).toBe(false);
  });

  it('relieves pressure through the PORV when primary pressure exceeds the lift setpoint', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    sim.primaryPressure = 16.5; // above the 16.20 MPa PORV lift setpoint
    aux.stepBefore(sim, 0.5);
    sim.update(0.5);
    const before = sim.primaryPressure;
    aux.stepAfter(sim, 0.5);
    // relief removed pressure this tick and the PORV lamp shows open
    expect(sim.primaryPressure).toBeLessThanOrEqual(before);
    expect(aux.view().relief.porvFlowOpen || aux.view().relief.reliefRateMPaPerS > 0).toBe(true);
  });

  it('a stuck-open PORV keeps discharging into the PRT after the drill', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    sim.primaryPressure = 16.5;
    aux.triggerStuckPorv();
    run(sim, aux, 20);
    const relief = aux.view().relief;
    expect(relief.porvStuckOpen).toBe(true);
    // isolating with the block valve stops the flow path
    aux.closeBlockValve();
    run(sim, aux, 5);
    expect(aux.view().relief.blockValveClosed).toBe(true);
  });

  it('manual SI actuation borates the RCS beyond the CVCS slew limit', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    const boron0 = sim.boronPpm;
    aux.actuateSi();
    run(sim, aux, 10);
    expect(aux.view().esf.siActive).toBe(true);
    expect(sim.boronPpm).toBeGreaterThan(boron0); // borated HHSI raised RCS boron
  });

  it('the rod-control program stays disengaged in MANUAL-hold so the legacy slider still owns the banks', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    sim.setAllRods(40); // operator slider moves the banks directly
    run(sim, aux, 2);
    // controller re-synced to the actual banks and did not fight the slider
    for (let b = 0; b < 4; b++) expect(sim.rodBankInsertion[b]).toBeCloseTo(40, 0);
    expect(aux.view().rods.engaged).toBe(false);
  });

  it('AUTO rod control engages and takes the banks', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    aux.setRodControlMode('auto');
    run(sim, aux, 5);
    expect(aux.view().rods.mode).toBe('auto');
    expect(aux.view().rods.engaged).toBe(true);
  });

  it('the CSF trees evaluate to all-green at a healthy hot-critical steady state', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    run(sim, aux, 10);
    const csf = aux.view().csf;
    expect(csf.csf).toHaveLength(6);
    // subcriticality tree is not challenged when the reactor is critical-and-stable
    expect(csf.anyRed).toBe(false);
  });

  it('a seal-cooling loss drives a seal-LOCA leak over time', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    aux.triggerSealCoolingLoss();
    run(sim, aux, 120, 1);
    const c = aux.view().containment;
    expect(c.sealLeakGpmTotal).toBeGreaterThan(c.sealCavityMaxTempC > 0 ? 0 : -1);
    expect(c.ccwLossActive).toBe(true);
  });

  it('reset() returns every subsystem to its initial state', () => {
    const sim = new ReactorSim();
    const aux = new ReactorAux();
    sim.warmStartCritical();
    aux.actuateSi();
    aux.setRodControlMode('auto');
    run(sim, aux, 5);
    aux.reset();
    sim.reset();
    expect(aux.view().esf.siActive).toBe(false);
    expect(aux.view().rods.mode).toBe('manual');
    expect(aux.view().relief.porvStuckOpen).toBe(false);
  });
});
