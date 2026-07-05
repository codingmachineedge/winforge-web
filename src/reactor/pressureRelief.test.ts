// 穩壓器釋壓系統測試 · PressureReliefSystem tests — PORV latch + LTOP re-ranging, staggered code
// safeties with blowdown hysteresis, the stuck-open-PORV (TMI-2) drill + block-valve isolation,
// and the PRT quench-tank mass/energy balance through to rupture-disc burst.

import { describe, expect, it } from 'vitest';
import {
  PressureReliefSystem,
  PressureReliefSetpoints as SP,
  type PressureReliefInputs,
} from './pressureRelief';

const inp = (primaryPressureMPa: number, extra?: Partial<PressureReliefInputs>): PressureReliefInputs => ({
  primaryPressureMPa,
  ltopArmed: false,
  ...extra,
});

describe('PORV auto latch', () => {
  it('stays shut below the 16.20 MPa open setpoint', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(16.1), 0.001);
    expect(out.porvOpen).toBe(false);
    expect(out.reliefRateMPaPerS).toBe(0);
  });

  it('opens above 16.20 MPa at the 2.5 MPa/s PORV rate and holds open inside the hysteresis band', () => {
    const sys = new PressureReliefSystem();
    let out = sys.step(inp(16.25), 0.001);
    expect(out.porvOpen).toBe(true);
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);

    // 16.10 is between reseat (16.06) and open (16.20): the latch must hold its previous state.
    out = sys.step(inp(16.1), 0.001);
    expect(out.porvOpen).toBe(true);
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);
  });

  it('reseats below 16.06 MPa', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.25), 0.001); // lift
    const out = sys.step(inp(16.0), 0.001); // below PorvClosePressure
    expect(out.porvOpen).toBe(false);
    expect(out.reliefRateMPaPerS).toBe(0);
  });

  it('a fresh latch stays shut inside the hysteresis band (direction check)', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(16.1), 0.001); // never lifted → band keeps it SHUT
    expect(out.porvOpen).toBe(false);
  });

  it('sub-steps a long dt: the valve can lift, blow down and reseat within one outer step', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(16.5), 1.0); // 50 internal 0.02 s sub-steps at 2.5 MPa/s
    // Blows down 16.5 → ~16.05 (below reseat) then closes: ~0.45 MPa over the 1 s step.
    expect(out.reliefRateMPaPerS).toBeGreaterThan(0.4);
    expect(out.reliefRateMPaPerS).toBeLessThan(0.8);
    expect(out.porvOpen).toBe(false); // ended the step reseated
  });
});

describe('LTOP re-ranged PORV', () => {
  it('lifts at 3.10 MPa when armed and reseats 0.21 MPa lower', () => {
    const sys = new PressureReliefSystem();
    let out = sys.step(inp(3.2, { ltopArmed: true }), 0.001);
    expect(out.porvOpen).toBe(true);
    expect(out.ltopPorvOpen).toBe(true);
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);

    // 2.95 MPa is above the 2.89 MPa reseat → still relieving.
    out = sys.step(inp(2.95, { ltopArmed: true }), 0.001);
    expect(out.ltopPorvOpen).toBe(true);

    // Below 3.10 − 0.21 = 2.89 MPa → reseats.
    out = sys.step(inp(2.85, { ltopArmed: true }), 0.001);
    expect(out.porvOpen).toBe(false);
    expect(out.ltopPorvOpen).toBe(false);
  });

  it('never lifts at the LTOP setpoint when disarmed', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(3.2), 0.001);
    expect(out.porvOpen).toBe(false);
  });
});

describe('ASME code safety valves', () => {
  it('pops the staggered valves one at a time (17.18 / 17.24 / 17.30 MPa)', () => {
    // dt tiny so the PORV drop within the sub-step cannot mask the staggered seats.
    const a = new PressureReliefSystem();
    expect(a.step(inp(17.2), 0.001).safetiesOpen).toBe(1); // > 17.18 only

    const b = new PressureReliefSystem();
    expect(b.step(inp(17.27), 0.001).safetiesOpen).toBe(2); // > 17.24 too

    const c = new PressureReliefSystem();
    expect(c.step(inp(17.4), 0.001).safetiesOpen).toBe(3); // > 17.30 as well
  });

  it('reseats only after the full 0.86 MPa blowdown below each seat', () => {
    const sys = new PressureReliefSystem();
    expect(sys.step(inp(17.2), 0.001).safetiesOpen).toBe(1);
    // 16.5 is above 17.18 − 0.86 = 16.32 → the popped valve stays open (hysteresis direction).
    expect(sys.step(inp(16.5), 0.001).safetiesOpen).toBe(1);
    // Below 16.32 → reseat.
    expect(sys.step(inp(16.3), 0.001).safetiesOpen).toBe(0);
  });

  it('relieves 3 × 4.0 MPa/s (+ PORV) at full lift ≥ 17.75 MPa accumulation', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(17.9), 0.001);
    expect(out.safetiesOpen).toBe(3);
    // PORV 2.5 + 3 valves × 4.0 at liftFrac 1 → 14.5 MPa/s total.
    expect(out.reliefRateMPaPerS).toBeCloseTo(
      SP.PorvReliefRate + 3 * SP.PzrSafetyReliefRate,
      1,
    );
  });

  it('lifts proportionally between pop and full accumulation', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(17.2), 0.001);
    // One valve at partial lift: total rate must sit between PORV-only and PORV + one full valve.
    expect(out.reliefRateMPaPerS).toBeGreaterThan(SP.PorvReliefRate);
    expect(out.reliefRateMPaPerS).toBeLessThan(SP.PorvReliefRate + SP.PzrSafetyReliefRate);
  });
});

describe('stuck-open PORV (TMI-2) + block valve', () => {
  it('sticks on the NEXT reseat when triggered while shut, and shows command≠position', () => {
    const sys = new PressureReliefSystem();
    sys.triggerStuckPorv();
    expect(sys.view().porvStuckPending).toBe(true);

    sys.step(inp(16.5), 0.1); // lifts normally
    const out = sys.step(inp(16.0), 0.1); // reseat demand → the valve FAILS open
    expect(out.porvStuckOpen).toBe(true);
    expect(out.porvOpen).toBe(true); // still discharging
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);

    const v = sys.view();
    expect(v.porvCommandOpen).toBe(false); // the TMI-2 lamp: command says SHUT…
    expect(v.porvFlowOpen).toBe(true); // …but the valve is passing flow
    expect(v.porvStuckPending).toBe(false);
  });

  it('sticks immediately when triggered while open', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001); // lift
    sys.triggerStuckPorv();
    expect(sys.view().porvStuckOpen).toBe(true);
    const out = sys.step(inp(15.0), 0.001); // far below reseat — still discharging
    expect(out.porvOpen).toBe(true);
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);
  });

  it('block valve isolates the stuck PORV (the TMI recovery) and can be reopened', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001);
    sys.triggerStuckPorv();

    sys.closeBlockValve();
    let out = sys.step(inp(16.0), 0.001);
    expect(out.blockValveClosed).toBe(true);
    expect(out.porvOpen).toBe(false); // no flow path
    expect(out.reliefRateMPaPerS).toBe(0);
    expect(out.porvStuckOpen).toBe(true); // the valve itself is still failed

    sys.openBlockValve();
    out = sys.step(inp(16.0), 0.001);
    expect(out.porvOpen).toBe(true); // discharge resumes through the still-stuck valve
    expect(out.reliefRateMPaPerS).toBeCloseTo(SP.PorvReliefRate, 6);
  });
});

describe('Pressurizer Relief Tank (PRT)', () => {
  it('sits quiet at the normal cold state (~65% level, well under the 8 psig alarm)', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(15.5), 1.0); // no relief path open
    const v = sys.view();
    expect(v.discharging).toBe(false);
    // 33 t pool at 322 K: N₂ (recompressed by the warm-water volume) + Buck vapour ≈ 5 psig.
    expect(v.prtPressurePsig).toBeGreaterThan(4.0);
    expect(v.prtPressurePsig).toBeLessThan(SP.PrtAlarmPressPsig);
    expect(v.prtTempC).toBeCloseTo(322.0 - 273.15, 3);
    expect(v.prtLevelPct).toBeGreaterThan(60);
    expect(v.prtLevelPct).toBeLessThan(70);
    expect(v.alarmsEn.length).toBe(0);
    expect(v.ruptureDiscBurst).toBe(false);
  });

  it('psig readout matches the gauge conversion (Pa − 101325) / 6894.76', () => {
    // Reproduce the tank state independently: unchanged 33 t pool at 322 K after one idle step.
    const rhoW = 1000.0 - 0.45 * (322.0 - 277.0); // 979.75 kg/m³
    const vW = 33000.0 / rhoW;
    const vG = 51.0 - vW;
    const n2Kg = (1.2e5 * (51.0 - 33.0)) / (296.8 * 322.0); // init assumes 1000 kg/m³ (source L3974)
    const pN2 = (n2Kg * 296.8 * 322.0) / vG;
    const tc = 322.0 - 273.15;
    const pSat = 611.21 * Math.exp((18.678 - tc / 234.5) * (tc / (257.14 + tc)));
    const expectedPsig = (pN2 + pSat - 101325.0) / 6894.76;

    const sys = new PressureReliefSystem();
    sys.step(inp(15.5), 1.0);
    expect(sys.view().prtPressurePsig).toBeCloseTo(expectedPsig, 6);
  });

  it('a stuck-open PORV heats/pressurizes/fills the PRT, trips the annunciators, then bursts the disc', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001);
    sys.triggerStuckPorv(); // stuck immediately (valve is open)

    const dt = 0.5;
    let sawPressHi = false;
    let sawTempHi = false;
    let burstAtS = -1;
    let prevTemp = sys.view().prtTempC;
    let levelAtBurst = 0;

    for (let t = 0; t < 900; t += dt) {
      const out = sys.step(inp(16.5), dt); // HPI holds the primary up; ~30 kg/s into the sparger
      expect(out.discharging).toBe(true);
      const v = sys.view();
      expect(v.prtTempC).toBeGreaterThanOrEqual(prevTemp - 1e-9); // pool only warms while discharging
      prevTemp = v.prtTempC;
      if (!v.ruptureDiscBurst) {
        // The annunciators must precede the burst — the operator gets the TMI-2 cue in time.
        if (v.alarmsEn.includes('PRT PRESS HI')) sawPressHi = true;
        if (v.alarmsEn.includes('PRT TEMP HI')) sawTempHi = true;
      }
      if (v.ruptureDiscBurst && burstAtS < 0) {
        burstAtS = t;
        levelAtBurst = v.prtLevelPct;
      }
      if (burstAtS >= 0 && t > burstAtS + 10) break;
    }

    expect(sawPressHi).toBe(true); // > 8 psig annunciator, before the disc goes
    expect(sawTempHi).toBe(true); // > 60 °C annunciator, before the disc goes
    expect(burstAtS).toBeGreaterThan(0); // 100 psig rupture disc
    expect(levelAtBurst).toBeGreaterThan(70); // the pool visibly filled from the condensed discharge
    // The annunciators must precede the burst — the operator gets the TMI-2 cue in time.
    const v = sys.view();
    expect(v.ruptureDiscBurst).toBe(true);
    expect(v.alarmsEn).toContain('PRT RUPTURE DISC BURST');
    expect(v.prtVentDriveKpa).toBeGreaterThan(0); // post-burst containment drive
  });

  it('post-burst blowdown vents water toward containment (18 kg/s per MPa, 0.9 kPa per kg/s)', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001);
    sys.triggerStuckPorv();
    // Drive to burst.
    for (let t = 0; t < 900; t += 1) {
      sys.step(inp(16.5), 1.0);
      if (sys.view().ruptureDiscBurst) break;
    }
    expect(sys.view().ruptureDiscBurst).toBe(true);

    // Isolate the PORV, then watch the burst tank blow down: vent drive is proportional to Δp.
    sys.closeBlockValve();
    const out = sys.step(inp(16.0), 1.0);
    const v = sys.view();
    const dpMPa = Math.max(0, (v.prtPressurePsig * 6894.76 + 101325 - 101325) / 1e6);
    expect(out.prtVentDriveKpa).toBeCloseTo(0.9 * 18.0 * dpMPa, 1);
    expect(out.prtVentDriveKpa).toBeGreaterThan(0);

    // The disc never re-closes even as pressure falls (latched), and with the inflow isolated the
    // sustained blowdown drains the pool through the LOW-level annunciator band (< 50%).
    for (let t = 0; t < 2500; t += 1) sys.step(inp(16.0), 1.0);
    const after = sys.view();
    expect(after.ruptureDiscBurst).toBe(true);
    expect(after.prtVentDriveKpa).toBeLessThan(out.prtVentDriveKpa); // relaxing toward containment
    expect(after.prtLevelPct).toBeLessThan(50);
    expect(after.alarmsEn).toContain('PRT LEVEL ABNORMAL');
  });

  it('prtVentDriveKpa stays 0 while the disc is intact', () => {
    const sys = new PressureReliefSystem();
    const out = sys.step(inp(16.5), 1.0);
    expect(out.prtVentDriveKpa).toBe(0);
  });
});

describe('bilingual strings + reset', () => {
  it('every alarm exists as a non-empty En/Zh pair (parallel arrays)', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001);
    sys.triggerStuckPorv();
    for (let t = 0; t < 900; t += 1) {
      sys.step(inp(17.9), 1.0); // safeties + PORV + PRT abuse → many annunciators
      if (sys.view().ruptureDiscBurst) break;
    }
    const v = sys.view();
    expect(v.alarmsEn.length).toBeGreaterThan(2);
    expect(v.alarmsZh.length).toBe(v.alarmsEn.length);
    for (let i = 0; i < v.alarmsEn.length; i++) {
      expect(v.alarmsEn[i]!.length).toBeGreaterThan(0);
      expect(v.alarmsZh[i]!.length).toBeGreaterThan(0);
    }
    expect(v.porvStatusEn.length).toBeGreaterThan(0);
    expect(v.porvStatusZh.length).toBeGreaterThan(0);
  });

  it('reset() restores the normal cold state', () => {
    const sys = new PressureReliefSystem();
    sys.step(inp(16.5), 0.001);
    sys.triggerStuckPorv();
    sys.closeBlockValve();
    for (let t = 0; t < 400; t += 1) sys.step(inp(17.9), 1.0);

    sys.reset();
    const v = sys.view();
    expect(v.porvCommandOpen).toBe(false);
    expect(v.porvStuckOpen).toBe(false);
    expect(v.porvStuckPending).toBe(false);
    expect(v.blockValveClosed).toBe(false);
    expect(v.safetiesOpen).toBe(0);
    expect(v.ruptureDiscBurst).toBe(false);
    expect(v.discharging).toBe(false);
    expect(v.prtTempC).toBeCloseTo(322.0 - 273.15, 6);
    expect(v.prtLevelPct).toBeCloseTo((100.0 * 33000.0) / (1000.0 * 51.0), 6);
    expect(v.alarmsEn.length).toBe(0);

    // And it behaves like a fresh instance afterwards.
    const out = sys.step(inp(16.1), 0.001);
    expect(out.porvOpen).toBe(false);
    expect(out.reliefRateMPaPerS).toBe(0);
  });
});
