// P/T 限值監測器測試 · PtLimitMonitor tests — Appendix-G envelope interpolation, heatup/cooldown
// rate EMA + alarms, LTOP arm/disarm hysteresis directions, PTS embrittlement/overcooling monitor,
// unit conversions and bilingual pairing. The class is driven standalone through realistic
// transients at outer-tick step sizes (dt 0.2–2 s), exactly as the integrator will call it.

import { describe, it, expect } from 'vitest';
import {
  PtLimitMonitor,
  appGAllowableMPaAt,
  mpaAbsToPsig,
  PtTempC,
  PtPmaxMPa,
  LtopEnableTempC,
  LtopEnableHystC,
  LtopOpenPressureMPa,
  LtopCloseHystMPa,
  AppGRateLimitCperHr,
  PtsScreeningLimitF,
} from './ptLimits';
import type { PtLimitsInputs } from './ptLimits';

/** Drive n steps with fixed inputs. */
function run(m: PtLimitMonitor, inp: PtLimitsInputs, n: number, dt: number) {
  let out = m.step(inp, dt);
  for (let i = 1; i < n; i++) out = m.step(inp, dt);
  return out;
}

describe('App G P/T envelope interpolation', () => {
  it('returns the exact table values at the knots and clamps outside them', () => {
    for (let i = 0; i < PtTempC.length; i++) {
      expect(appGAllowableMPaAt(PtTempC[i]!)).toBeCloseTo(PtPmaxMPa[i]!, 10);
    }
    expect(appGAllowableMPaAt(-10)).toBeCloseTo(4.38, 10); // clamp low
    expect(appGAllowableMPaAt(320)).toBeCloseTo(17.24, 10); // clamp high (design-ceiling plateau)
  });

  it('interpolates linearly between knots', () => {
    // midpoint of the first segment: (15.6, 4.38) → (37.8, 4.93)
    const mid = appGAllowableMPaAt((15.6 + 37.8) / 2);
    expect(mid).toBeCloseTo((4.38 + 4.93) / 2, 10);
  });

  it('flags approach inside 1.0 MPa below the limit and violation above it', () => {
    const m = new PtLimitMonitor();
    // cold vessel at 20 °C → allowable ≈ 4.49 MPa
    const allow = appGAllowableMPaAt(20);
    m.step({ tcoldC: 20, primaryPressureMPa: allow - 0.5 }, 1);
    let v = m.view();
    expect(v.appGApproach).toBe(true);
    expect(v.appGViolated).toBe(false);
    expect(v.appGMarginMPa).toBeCloseTo(0.5, 6);

    const out = m.step({ tcoldC: 20, primaryPressureMPa: allow + 0.3 }, 1);
    v = m.view();
    expect(out.appGViolated).toBe(true);
    expect(v.appGViolated).toBe(true);
    expect(v.appGApproach).toBe(false); // approach requires margin >= 0 (C# quirk)
    expect(v.appGMarginMPa).toBeLessThan(0);
    expect(v.alarmsEn).toContain('APP G P/T VIOLATION');
    expect(v.alarmsZh).toContain('附錄G P/T 越限');
  });

  it('converts the allowable to psig with the exact gauge formula', () => {
    // psig = (Pa − 101325)/6894.757 → 4.38 MPa-abs ≈ 620.5 psig
    expect(mpaAbsToPsig(4.38)).toBeCloseTo((4.38e6 - 101325) / 6894.757, 9);
    expect(mpaAbsToPsig(4.38)).toBeCloseTo(620.5, 0);
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 10, primaryPressureMPa: 2.0 }, 1);
    const v = m.view();
    expect(v.appGAllowablePsig).toBeCloseTo(mpaAbsToPsig(4.38), 6);
    expect(v.primaryPressurePsig).toBeCloseTo((2.0e6 - 101325) / 6894.757, 6);
  });
});

describe('heatup/cooldown rate monitor', () => {
  it('seeds on the first sample with no startup spike', () => {
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 250, primaryPressureMPa: 15.5 }, 1); // huge jump from the reset seed (35 °C)
    expect(m.view().heatupRateCPerHr).toBe(0); // first sample only seeds the finite difference
  });

  it('EMA converges to a steady heatup ramp and alarms above 90% of 55.56 °C/hr', () => {
    const m = new PtLimitMonitor();
    let t = 100;
    const dt = 1;
    m.step({ tcoldC: t, primaryPressureMPa: 12 }, dt);
    // +100 °C/hr ramp for 300 s → EMA (τ=45 s) ≈ 100·(1−e^(−300/45)) ≈ 99.9
    for (let i = 0; i < 300; i++) {
      t += (100 / 3600) * dt;
      m.step({ tcoldC: t, primaryPressureMPa: 12 }, dt);
    }
    const v = m.view();
    expect(v.heatupRateCPerHr).toBeGreaterThan(90);
    expect(v.heatupRateCPerHr).toBeLessThan(105);
    expect(v.heatupRateFPerHr).toBeCloseTo(v.heatupRateCPerHr * 1.8, 9);
    expect(v.heatupRateAlarm).toBe(true);
    expect(v.cooldownRateAlarm).toBe(false);
    expect(v.alarmsEn).toContain('RCS HEAT/COOL RATE HI');
    expect(v.alarmsZh).toContain('RCS 升降溫率過高');
  });

  it('a slow ramp inside the limit does not alarm (alarm threshold is 50 °C/hr)', () => {
    const m = new PtLimitMonitor();
    let t = 100;
    const dt = 2;
    m.step({ tcoldC: t, primaryPressureMPa: 12 }, dt);
    for (let i = 0; i < 200; i++) {
      t += (40 / 3600) * dt; // +40 °C/hr < 0.9·55.56
      m.step({ tcoldC: t, primaryPressureMPa: 12 }, dt);
    }
    const v = m.view();
    expect(v.heatupRateCPerHr).toBeGreaterThan(30);
    expect(v.heatupRateAlarm).toBe(false);
    expect(Math.abs(v.heatupRateCPerHr)).toBeLessThan(AppGRateLimitCperHr * 0.9);
  });

  it('cooldown rate is signed negative and raises the cooldown alarm', () => {
    const m = new PtLimitMonitor();
    let t = 280;
    const dt = 1;
    m.step({ tcoldC: t, primaryPressureMPa: 15.5 }, dt);
    for (let i = 0; i < 300; i++) {
      t -= (80 / 3600) * dt; // −80 °C/hr cooldown
      m.step({ tcoldC: t, primaryPressureMPa: 15.5 }, dt);
    }
    const v = m.view();
    expect(v.heatupRateCPerHr).toBeLessThan(-60);
    expect(v.cooldownRateAlarm).toBe(true);
    expect(v.heatupRateAlarm).toBe(false);
  });
});

describe('LTOP/COMS arming', () => {
  it('arms below 135 °C, holds through the 5 °C hysteresis band, disarms above 140 °C', () => {
    const m = new PtLimitMonitor();
    // start warm and disarmed
    let out = run(m, { tcoldC: 200, primaryPressureMPa: 15.5 }, 3, 1);
    expect(out.ltopArmed).toBe(false);
    // cool below the enable temperature → arm
    out = m.step({ tcoldC: LtopEnableTempC - 1, primaryPressureMPa: 10 }, 1);
    expect(out.ltopArmed).toBe(true);
    // re-heat INTO the hysteresis band (135..140) → stays armed (no chatter)
    out = m.step({ tcoldC: LtopEnableTempC + LtopEnableHystC - 0.5, primaryPressureMPa: 10 }, 1);
    expect(out.ltopArmed).toBe(true);
    // above enable + hysteresis → disarm
    out = m.step({ tcoldC: LtopEnableTempC + LtopEnableHystC + 0.5, primaryPressureMPa: 10 }, 1);
    expect(out.ltopArmed).toBe(false);
    // and back below enable → arm again
    out = m.step({ tcoldC: LtopEnableTempC - 0.2, primaryPressureMPa: 10 }, 1);
    expect(out.ltopArmed).toBe(true);
  });

  it('publishes the lift/reseat setpoints for the pressureRelief module (reseat strictly below lift)', () => {
    const m = new PtLimitMonitor();
    const out = m.step({ tcoldC: 100, primaryPressureMPa: 2.0 }, 1);
    expect(out.ltopOpenSetpointMPa).toBeCloseTo(LtopOpenPressureMPa, 10); // 3.10 MPa-abs
    expect(out.ltopReseatSetpointMPa).toBeCloseTo(LtopOpenPressureMPa - LtopCloseHystMPa, 10); // 2.89
    expect(out.ltopReseatSetpointMPa).toBeLessThan(out.ltopOpenSetpointMPa);
  });

  it('the LTOP RELIEVING annunciator echoes the coupling input, defaulting safe (off)', () => {
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 100, primaryPressureMPa: 3.2 }, 1);
    expect(m.view().ltopActiveAlarm).toBe(false); // default false — valve lives in pressureRelief
    m.step({ tcoldC: 100, primaryPressureMPa: 3.2, ltopPorvOpen: true }, 1);
    const v = m.view();
    expect(v.ltopActiveAlarm).toBe(true);
    expect(v.alarmsEn).toContain('LTOP/COMS RELIEVING');
    expect(v.alarmsZh).toContain('低溫超壓保護洩放');
  });
});

describe('PTS monitor', () => {
  it('RT_PTS ≈ 260 °F at the default 32 EFPY, under the 270 °F screen; embrittles with age', () => {
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 280, primaryPressureMPa: 15.5 }, 1);
    const v32 = m.view();
    expect(v32.vesselEfpy).toBe(32);
    expect(v32.rtPtsF).toBeGreaterThan(250);
    expect(v32.rtPtsF).toBeLessThan(265); // C# comment: "lands RT_PTS≈260 °F"
    expect(v32.ptsScreeningMarginF).toBeGreaterThan(0);
    expect(v32.rtNdtC).toBeCloseTo((v32.rtPtsF - 32) / 1.8, 9);

    // age to EOL 60 EFPY → crosses the 10 CFR 50.61 screening criterion
    m.step({ tcoldC: 280, primaryPressureMPa: 15.5, vesselEfpy: 60 }, 1);
    const v60 = m.view();
    expect(v60.rtPtsF).toBeGreaterThan(v32.rtPtsF);
    expect(v60.rtPtsF).toBeGreaterThan(PtsScreeningLimitF);
    expect(v60.ptsScreeningMarginF).toBeLessThan(0);
  });

  it('wall temperature lags the fluid and settles on it at steady state', () => {
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 280, primaryPressureMPa: 15.5 }, 1); // seed: wall = fluid, no spike
    expect(m.view().wallTempC).toBeCloseTo(280, 6);
    // step the fluid down 50 °C → the wall follows with τ = 30 s
    m.step({ tcoldC: 230, primaryPressureMPa: 15.5 }, 1);
    const w1 = m.view().wallTempC;
    expect(w1).toBeGreaterThan(230); // still lagging warm
    expect(w1).toBeLessThan(280);
    run(m, { tcoldC: 230, primaryPressureMPa: 15.5 }, 400, 1);
    expect(m.view().wallTempC).toBeCloseTo(230, 1);
  });

  it('an overcooling transient below 400 °F downcomer raises the susceptible advisory and tensile K_Ith', () => {
    const m = new PtLimitMonitor();
    // settle hot & pressurized
    run(m, { tcoldC: 290, primaryPressureMPa: 15.5 }, 120, 1);
    let v = m.view();
    expect(v.ptsSusceptible).toBe(false);
    expect(v.ptsRiskTier).toBe(0);
    const marginHot = v.ptsMargin;

    // MSLB-style plunge: −2 °C/s (≫ 28 °C/hr threshold), pressure held by SI
    let t = 290;
    for (let i = 0; i < 120; i++) {
      t = Math.max(120, t - 2);
      m.step({ tcoldC: t, primaryPressureMPa: 15.5 }, 1);
    }
    v = m.view();
    expect((v.tcoldC * 9) / 5 + 32).toBeLessThan(400); // downcomer below the 400 °F advisory gate
    expect(v.ptsSusceptible).toBe(true);
    expect(v.ptsKiThermalKsi).toBeGreaterThan(0); // wall hotter than fluid → tensile, crack-opening
    expect(v.ptsKiTotalKsi).toBeGreaterThan(v.ptsKiPressureKsi);
    expect(v.ptsMargin).toBeLessThan(marginHot); // cold + gradient erodes the toughness margin
    expect(v.ptsRiskTier).toBeGreaterThanOrEqual(1);
    expect(v.alarmsEn).toContain('PTS SUSCEPTIBLE COND.');
    expect(v.alarmsZh).toContain('承壓熱衝擊敏感工況');
    expect(v.ptsAdvisoryEn.length).toBeGreaterThan(0);
    expect(v.ptsAdvisoryZh.length).toBeGreaterThan(0);
  });

  it('on heatup the thermal SIF is compressive (negative) and discarded from K_I total', () => {
    const m = new PtLimitMonitor();
    run(m, { tcoldC: 80, primaryPressureMPa: 3.0 }, 60, 1); // settle cold
    // heat up fast: fluid leads the wall → ΔT = wall − fluid < 0
    let t = 80;
    for (let i = 0; i < 30; i++) {
      t += 1.5;
      m.step({ tcoldC: t, primaryPressureMPa: 3.0 }, 1);
    }
    const v = m.view();
    expect(v.ptsKiThermalKsi).toBeLessThan(0);
    expect(v.ptsKiTotalKsi).toBeCloseTo(v.ptsKiPressureKsi, 9); // tensile part clamped to 0
  });

  it('a cold repressurization above 0.05 MPa/s asserts the susceptible advisory without a cooldown', () => {
    const m = new PtLimitMonitor();
    run(m, { tcoldC: 100, primaryPressureMPa: 2.0 }, 60, 1); // cold, settled, rate ≈ 0
    expect(m.view().ptsSusceptible).toBe(false);
    // inadvertent SI: +0.2 MPa in one 1 s step = 0.2 MPa/s > 0.05
    m.step({ tcoldC: 100, primaryPressureMPa: 2.2 }, 1);
    expect(m.view().ptsSusceptible).toBe(true);
  });

  it('flaw initiation is predicted when a cold embrittled vessel is fully repressurized', () => {
    const m = new PtLimitMonitor();
    // EOL vessel (60 EFPY → RT_PTS ≈ 288 °F), bone-cold at 20 °C (68 °F wall) → K_IC near its floor
    run(m, { tcoldC: 20, primaryPressureMPa: 0.5, vesselEfpy: 60 }, 120, 1);
    let v = m.view();
    expect(v.ptsFlawInitiation).toBe(false);
    // grossly overpressurize cold (hydro-style fault at full operating pressure)
    const out = m.step({ tcoldC: 20, primaryPressureMPa: 15.5, vesselEfpy: 60 }, 1);
    v = m.view();
    // K_Ip = 1.10·(15.5·145.038·86/8.5/1000)·√(π·2.125) ≈ 65 ksi√in ≫ K_IC(68 °F − 288 °F) ≈ 33.4
    expect(v.ptsKiTotalKsi).toBeGreaterThan(v.ptsKicAtWallKsi);
    expect(out.ptsFlawInitiation).toBe(true);
    expect(v.ptsFlawInitiation).toBe(true);
    expect(v.ptsMargin).toBeLessThan(1);
    expect(v.ptsRiskTier).toBe(3);
    expect(v.alarmsEn).toContain('PTS FLAW INITIATION');
    expect(v.alarmsZh).toContain('承壓熱衝擊裂紋起裂');
  });
});

describe('bilingual pairing + view hygiene', () => {
  it('alarm arrays stay index-paired and non-empty per entry', () => {
    const m = new PtLimitMonitor();
    // provoke several alarms at once: cold overpressure + LTOP relieving
    run(m, { tcoldC: 60, primaryPressureMPa: 8.0, ltopPorvOpen: true }, 5, 1);
    const v = m.view();
    expect(v.alarmsEn.length).toBeGreaterThan(0);
    expect(v.alarmsEn.length).toBe(v.alarmsZh.length);
    for (let i = 0; i < v.alarmsEn.length; i++) {
      expect(v.alarmsEn[i]!.length).toBeGreaterThan(0);
      expect(v.alarmsZh[i]!.length).toBeGreaterThan(0);
    }
    expect(v.ptsAdvisoryEn.length).toBeGreaterThan(0);
    expect(v.ptsAdvisoryZh.length).toBeGreaterThan(0);
  });

  it('view is JSON-serializable and the curve knots are copies', () => {
    const m = new PtLimitMonitor();
    m.step({ tcoldC: 50, primaryPressureMPa: 3 }, 1);
    const v = m.view();
    expect(() => JSON.stringify(v)).not.toThrow();
    expect(v.curveTempC).toEqual([...PtTempC]);
    expect(v.curvePressMPa).toEqual([...PtPmaxMPa]);
    v.curveTempC[0] = -999; // mutating the snapshot must not corrupt the module tables
    expect(PtTempC[0]).toBeCloseTo(15.6, 10);
  });

  it('reset() returns to a clean cold state with the EFPY knob retained', () => {
    const m = new PtLimitMonitor();
    run(m, { tcoldC: 280, primaryPressureMPa: 15.5, vesselEfpy: 48 }, 50, 1);
    m.reset();
    const v = m.view();
    expect(v.heatupRateCPerHr).toBe(0);
    expect(v.ltopArmed).toBe(false);
    expect(v.ptsSusceptible).toBe(false);
    expect(v.ptsMargin).toBe(99);
    expect(v.vesselEfpy).toBe(48); // age knob survives reset, like C# _vesselEfpy
    // first post-reset sample seeds the rate — still no spike
    m.step({ tcoldC: 200, primaryPressureMPa: 12 }, 1);
    expect(m.view().heatupRateCPerHr).toBe(0);
  });
});
