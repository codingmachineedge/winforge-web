// 關鍵安全功能狀態樹測試 · CSF status-tree evaluator tests — drives CsfEvaluator standalone through
// realistic transients and asserts every branch threshold ported from ReactorSimService.cs
// L5536–5699, the S,C,H,P,Z,I priority ordering, the Invalid<Green ordinal quirk, the psig↔kPa/MPa
// unit conversions, and bilingual pair completeness.

import { describe, expect, it } from 'vitest';
import {
  AtmPa,
  CsfEvaluator,
  CsfStatusRank,
  CtmtHi1Kpa,
  CtmtHi3Kpa,
  PsiPa,
  RvlisTopOfFuelPct,
  type CsfTreesInputs,
} from './csfTrees';
import { VesselPressureLimit } from './physics';

/** Healthy full-power plant — every tree Green. Defaults mirror the documented safe defaults. */
function nominal(over: Partial<CsfTreesInputs> = {}): CsfTreesInputs {
  return {
    powerFraction: 1.0,
    startupRateDpm: 0.0,
    scrammed: false,
    coreExitTempC: 320.0, // ≈ thot at power
    subcoolingMarginC: 25.0,
    rvlisPct: 100.0,
    sgLevelPct: 64.0, // 30 + 34·feedwaterFlow at full feed
    feedwaterFlow: 1.0,
    auxFeedwaterRunning: false,
    primaryPressureMPa: 15.5,
    heatupRateCPerHr: 0.0,
    meltdown: false,
    containmentPressureKpaG: 0.0,
    particulateMonitorRatio: 0.0,
    gaseousMonitorRatio: 0.0,
    damageAccumulation: 0.0,
    sumpGal: 0.0,
    pressurizerLevelPct: 55.0,
    ...over,
  };
}

const DT = 0.5; // typical outer-tick dt (ignored by the pure classifier)

function stepped(over: Partial<CsfTreesInputs> = {}) {
  const ev = new CsfEvaluator();
  const out = ev.step(nominal(over), DT);
  return { ev, out, v: ev.view() };
}

const tree = (ev: CsfEvaluator, m: string) => ev.view().csf.find((c) => c.mnemonic === m)!;

describe('CsfEvaluator — board shape and ordering', () => {
  it('reports six trees in fixed S,C,H,P,Z,I order, Invalid before the first scan', () => {
    const ev = new CsfEvaluator();
    const v = ev.view();
    expect(v.csf.map((c) => c.mnemonic)).toEqual(['S', 'C', 'H', 'P', 'Z', 'I']);
    expect(v.csf.every((c) => c.status === 'invalid')).toBe(true);
    expect(v.worstStatus).toBe('invalid');
    expect(v.anyRed).toBe(false);
  });

  it('all Green at healthy full power; no FR entry', () => {
    const { out, v } = stepped();
    expect(v.csf.every((c) => c.status === 'green')).toBe(true);
    expect(v.csf.every((c) => c.frId === '--')).toBe(true);
    expect(out.worstStatus).toBe('green');
    expect(out.anyRed).toBe(false);
    expect(out.challengeCount).toBe(0);
    expect(out.highestPriorityFrId).toBeNull();
  });

  it('Invalid ranks BELOW Green (source L24 ordinal quirk): one dead sensor + rest green ⇒ worst green', () => {
    const { out, ev } = stepped({ sgLevelPct: Number.NaN });
    expect(tree(ev, 'H').status).toBe('invalid');
    expect(tree(ev, 'H').conditionZh).toBe('蒸汽發生器水位訊號失效');
    expect(out.worstStatus).toBe('green'); // max ordinal: Invalid(0) < Green(1)
    expect(out.challengeCount).toBe(0);
    expect(CsfStatusRank.invalid).toBeLessThan(CsfStatusRank.green);
  });

  it('highest-priority pick follows S,C,H,P,Z,I order, not severity', () => {
    // I is RED but S is only YELLOW — the C# picks the FIRST tree above green in array order.
    const { out, v } = stepped({
      startupRateDpm: 0.7, // S yellow FR-S.2
      pressurizerLevelPct: 3.0,
      rvlisPct: 50.0, // I red FR-I.2 (subcooling still fine)
      subcoolingMarginC: 25.0,
    });
    expect(v.highestPriorityMnemonic).toBe('S');
    expect(out.highestPriorityFrId).toBe('FR-S.2');
    expect(out.worstStatus).toBe('red');
    expect(out.anyRed).toBe(true);
    expect(out.challengeCount).toBeGreaterThanOrEqual(2);
  });

  it('reset() returns the board to the pre-scan Invalid state', () => {
    const { ev } = stepped({ meltdown: true });
    expect(ev.view().anyRed).toBe(true);
    ev.reset();
    const v = ev.view();
    expect(v.worstStatus).toBe('invalid');
    expect(v.anyRed).toBe(false);
    expect(v.csf.every((c) => c.status === 'invalid')).toBe(true);
  });
});

describe('F-0.1 Subcriticality (source L5559–5578)', () => {
  it('RED FR-S.1 ATWS: scrammed with power > 5% RTP', () => {
    const { ev } = stepped({ scrammed: true, powerFraction: 0.2 });
    const s = tree(ev, 'S');
    expect(s.status).toBe('red');
    expect(s.frId).toBe('FR-S.1');
    expect(s.conditionEn).toBe('Power 20.0% after trip — ATWS');
    expect(s.conditionZh).toContain('未能停堆');
  });

  it('RED FR-S.1 ATWS: scrammed with SUR > 1 DPM even at low power', () => {
    const { ev } = stepped({ scrammed: true, powerFraction: 0.01, startupRateDpm: 1.5 });
    expect(tree(ev, 'S').status).toBe('red');
  });

  it('scrammed at 4.9% and SUR 1.0 exactly ⇒ not ATWS (strict > thresholds), but still SUR-yellow', () => {
    const { ev } = stepped({ scrammed: true, powerFraction: 0.049, startupRateDpm: 1.0 });
    // Falls through the ATWS gate (strict >), then hits the 0.5 DPM yellow branch — C# quirk kept.
    expect(tree(ev, 'S').status).toBe('yellow');
    expect(tree(ev, 'S').frId).toBe('FR-S.2');
    // And with SUR at exactly the yellow threshold too, the tree is green:
    const calm = stepped({ scrammed: true, powerFraction: 0.049, startupRateDpm: 0.5 });
    expect(tree(calm.ev, 'S').status).toBe('green');
  });

  it('ORANGE FR-S.1 un-tripped overpower > 105% RTP', () => {
    const { ev } = stepped({ powerFraction: 1.1 });
    const s = tree(ev, 'S');
    expect(s.status).toBe('orange');
    expect(s.frId).toBe('FR-S.1');
    expect(s.conditionEn).toBe('Overpower 110% RTP');
  });

  it('YELLOW FR-S.2 above 0.5 DPM; green at 0.5 exactly', () => {
    expect(tree(stepped({ startupRateDpm: 0.7 }).ev, 'S').status).toBe('yellow');
    expect(tree(stepped({ startupRateDpm: 0.7 }).ev, 'S').frId).toBe('FR-S.2');
    expect(tree(stepped({ startupRateDpm: 0.5 }).ev, 'S').status).toBe('green');
  });

  it('INVALID when NIS flux is NaN', () => {
    const s = tree(stepped({ powerFraction: Number.NaN }).ev, 'S');
    expect(s.status).toBe('invalid');
    expect(s.frId).toBe('--');
  });

  it('Infinity is NOT Invalid — C# double.IsNaN semantics: an off-scale-high reading still classifies', () => {
    // C# L5561 guards with double.IsNaN only; Infinity > 0.05 after a trip ⇒ ATWS RED, not grey.
    expect(tree(stepped({ scrammed: true, powerFraction: Number.POSITIVE_INFINITY }).ev, 'S').status).toBe('red');
    expect(tree(stepped({ coreExitTempC: Number.POSITIVE_INFINITY }).ev, 'C').status).toBe('red'); // ∞ ≥ 649
    expect(tree(stepped({ primaryPressureMPa: Number.POSITIVE_INFINITY }).ev, 'P').status).toBe('red'); // ∞ > 17.2
  });
});

describe('F-0.2 Core Cooling (source L5584–5603, ICC bools L1378–1379)', () => {
  it('RED FR-C.1 at CET ≥ 649 °C (1200 °F)', () => {
    const c = tree(stepped({ coreExitTempC: 650.0, subcoolingMarginC: -50 }).ev, 'C');
    expect(c.status).toBe('red');
    expect(c.frId).toBe('FR-C.1');
    expect(c.conditionEn).toContain('649');
    expect(tree(stepped({ coreExitTempC: 649.0, subcoolingMarginC: -50 }).ev, 'C').status).toBe('red'); // ≥, inclusive
  });

  it('ORANGE FR-C.2 at CET ≥ 371 °C (700 °F) or subcooling lost (≤ 0)', () => {
    expect(tree(stepped({ coreExitTempC: 400.0 }).ev, 'C').status).toBe('orange');
    expect(tree(stepped({ subcoolingMarginC: 0.0 }).ev, 'C').status).toBe('orange'); // ≤ 0, inclusive
    expect(tree(stepped({ subcoolingMarginC: 0.0 }).ev, 'C').frId).toBe('FR-C.2');
  });

  it('YELLOW FR-C.3 on low subcooling (<11 °C) or RVLIS below top of active fuel (<62 %)', () => {
    expect(tree(stepped({ subcoolingMarginC: 8.0 }).ev, 'C').status).toBe('yellow');
    expect(tree(stepped({ rvlisPct: 60.0 }).ev, 'C').status).toBe('yellow');
    expect(tree(stepped({ rvlisPct: RvlisTopOfFuelPct }).ev, 'C').status).toBe('green'); // strict <
    expect(tree(stepped({ subcoolingMarginC: 11.0 }).ev, 'C').status).toBe('green');
  });

  it('INVALID when core-exit TCs are NaN', () => {
    expect(tree(stepped({ coreExitTempC: Number.NaN }).ev, 'C').status).toBe('invalid');
  });
});

describe('F-0.3 Heat Sink (source L5608–5626)', () => {
  it('RED FR-H.1 total loss: SG < 17% AND no main feed AND no aux feed', () => {
    const h = tree(stepped({ sgLevelPct: 10.0, feedwaterFlow: 0.0 }).ev, 'H');
    expect(h.status).toBe('red');
    expect(h.frId).toBe('FR-H.1');
    expect(h.conditionZh).toBe('完全喪失蒸汽發生器給水');
  });

  it('ORANGE (not red) below lo-lo when ANY feed source is available', () => {
    expect(tree(stepped({ sgLevelPct: 10.0, feedwaterFlow: 0.0, auxFeedwaterRunning: true }).ev, 'H').status).toBe('orange');
    expect(tree(stepped({ sgLevelPct: 10.0, feedwaterFlow: 0.03 }).ev, 'H').status).toBe('orange'); // 0.03 ≥ 0.02
  });

  it('YELLOW FR-H.5 on low level (<30 %) or marginal feed (<0.05 with no aux)', () => {
    expect(tree(stepped({ sgLevelPct: 25.0 }).ev, 'H').status).toBe('yellow');
    const marginal = tree(stepped({ sgLevelPct: 40.0, feedwaterFlow: 0.03 }).ev, 'H');
    expect(marginal.status).toBe('yellow');
    expect(marginal.frId).toBe('FR-H.5');
    // aux feed covers marginal main feed:
    expect(tree(stepped({ sgLevelPct: 40.0, feedwaterFlow: 0.03, auxFeedwaterRunning: true }).ev, 'H').status).toBe('green');
  });
});

describe('F-0.4 RCS Integrity (source L5631–5650)', () => {
  it('RED FR-P.1 above the 17.2 MPa design pressure', () => {
    const p = tree(stepped({ primaryPressureMPa: 17.5 }).ev, 'P');
    expect(p.status).toBe('red');
    expect(p.frId).toBe('FR-P.1');
    expect(p.conditionEn).toBe('RCS 17.5 MPa > 17.2 MPa overpressure');
  });

  it('ORANGE within 1 MPa of the limit (staggered setpoint)', () => {
    expect(tree(stepped({ primaryPressureMPa: 16.5 }).ev, 'P').status).toBe('orange');
    expect(tree(stepped({ primaryPressureMPa: VesselPressureLimit - 1.0 }).ev, 'P').status).toBe('green'); // strict >
  });

  it('YELLOW FR-P.2 only on cooldown faster than −55 °C/hr — heatup never yellows (one-way quirk)', () => {
    const p = tree(stepped({ heatupRateCPerHr: -60.0 }).ev, 'P');
    expect(p.status).toBe('yellow');
    expect(p.frId).toBe('FR-P.2');
    expect(p.conditionZh).toContain('加壓熱衝擊');
    expect(tree(stepped({ heatupRateCPerHr: -55.0 }).ev, 'P').status).toBe('green'); // strict <
    expect(tree(stepped({ heatupRateCPerHr: +120.0 }).ev, 'P').status).toBe('green'); // heatup side ignored
  });
});

describe('F-0.5 Containment (source L5656–5672) — no Invalid guard', () => {
  it('RED FR-Z.1 on meltdown, rad-monitor alarm (ratio ≥ 1), or Hi-3 pressure (≥ 186 kPa)', () => {
    expect(tree(stepped({ meltdown: true }).ev, 'Z').status).toBe('red');
    expect(tree(stepped({ particulateMonitorRatio: 1.0 }).ev, 'Z').status).toBe('red');
    expect(tree(stepped({ gaseousMonitorRatio: 1.2 }).ev, 'Z').status).toBe('red');
    const z = tree(stepped({ containmentPressureKpaG: 186.0 }).ev, 'Z');
    expect(z.status).toBe('red');
    expect(z.frId).toBe('FR-Z.1');
  });

  it('ORANGE at Hi-1 (≥ 28 kPa) or accumulating core damage (> 1)', () => {
    expect(tree(stepped({ containmentPressureKpaG: 30.0 }).ev, 'Z').status).toBe('orange');
    expect(tree(stepped({ containmentPressureKpaG: 28.0 }).ev, 'Z').status).toBe('orange'); // ≥, inclusive
    expect(tree(stepped({ damageAccumulation: 2.0 }).ev, 'Z').status).toBe('orange');
    expect(tree(stepped({ damageAccumulation: 1.0 }).ev, 'Z').status).toBe('green'); // strict >
  });

  it('YELLOW FR-Z.3 on elevated rad (> 0.5) or sump > 500 gal', () => {
    expect(tree(stepped({ particulateMonitorRatio: 0.6 }).ev, 'Z').status).toBe('yellow');
    expect(tree(stepped({ gaseousMonitorRatio: 0.6 }).ev, 'Z').status).toBe('yellow');
    const z = tree(stepped({ sumpGal: 600.0 }).ev, 'Z');
    expect(z.status).toBe('yellow');
    expect(z.frId).toBe('FR-Z.3');
    expect(tree(stepped({ sumpGal: 500.0 }).ev, 'Z').status).toBe('green'); // strict >
  });
});

describe('F-0.6 RCS Inventory (source L5677–5697)', () => {
  it('RED FR-I.2 only when PZR off-scale-low AND RVLIS below top of fuel', () => {
    const i = tree(stepped({ pressurizerLevelPct: 3.0, rvlisPct: 50.0 }).ev, 'I');
    expect(i.status).toBe('red');
    expect(i.frId).toBe('FR-I.2');
    // RVLIS still healthy ⇒ falls through to ORANGE (<17 %), not red:
    expect(tree(stepped({ pressurizerLevelPct: 3.0, rvlisPct: 100.0 }).ev, 'I').status).toBe('orange');
  });

  it('ORANGE FR-I.2 below 17 %', () => {
    const i = tree(stepped({ pressurizerLevelPct: 10.0 }).ev, 'I');
    expect(i.status).toBe('orange');
    expect(i.frId).toBe('FR-I.2');
    expect(i.conditionEn).toBe('PZR level 10% low');
  });

  it('YELLOW splits the FRG: low (<30 %) → FR-I.1, overfill (>92 %) → FR-I.3', () => {
    const low = tree(stepped({ pressurizerLevelPct: 25.0 }).ev, 'I');
    expect(low.status).toBe('yellow');
    expect(low.frId).toBe('FR-I.1');
    const high = tree(stepped({ pressurizerLevelPct: 95.0 }).ev, 'I');
    expect(high.status).toBe('yellow');
    expect(high.frId).toBe('FR-I.3');
    expect(tree(stepped({ pressurizerLevelPct: 92.0 }).ev, 'I').status).toBe('green'); // strict >
  });
});

describe('unit conversions and bilingual completeness', () => {
  it('containment setpoints match their psig provenance: psig = (Pa−101325)/6894.757 on ABSOLUTE Pa', () => {
    // kPa-GAUGE → Pa-abs → psig (source comments: Hi-3 ~186 kPa ≈ 27 psig, Hi-1 ~28 kPa ≈ 4 psig).
    const kpaGToPsig = (kpaG: number) => (kpaG * 1000.0 + AtmPa - AtmPa) / PsiPa; // gauge already excludes 1 atm
    expect(kpaGToPsig(CtmtHi3Kpa)).toBeCloseTo(26.98, 1);
    expect(kpaGToPsig(CtmtHi1Kpa)).toBeCloseTo(4.06, 1);
  });

  it('the 17.2 MPa-abs design limit sits at the plausible ~2480 psig PWR design pressure', () => {
    const psig = (VesselPressureLimit * 1e6 - AtmPa) / PsiPa;
    expect(psig).toBeGreaterThan(2400);
    expect(psig).toBeLessThan(2500);
  });

  it('every state carries a non-empty En/Zh pair (names + conditions) in every status colour', () => {
    const scenarios: Partial<CsfTreesInputs>[] = [
      {}, // all green
      { scrammed: true, powerFraction: 0.2, coreExitTempC: 700, subcoolingMarginC: -10, sgLevelPct: 5, feedwaterFlow: 0, primaryPressureMPa: 18, meltdown: true, containmentPressureKpaG: 200, pressurizerLevelPct: 2, rvlisPct: 30 }, // all red-ish
      { startupRateDpm: 0.8, subcoolingMarginC: 5, sgLevelPct: 25, heatupRateCPerHr: -70, sumpGal: 900, pressurizerLevelPct: 95 }, // all yellow
      { powerFraction: Number.NaN, coreExitTempC: Number.NaN, sgLevelPct: Number.NaN, primaryPressureMPa: Number.NaN, pressurizerLevelPct: Number.NaN }, // invalids
    ];
    for (const over of scenarios) {
      const { v } = stepped(over);
      for (const c of v.csf) {
        expect(c.nameEn.length).toBeGreaterThan(0);
        expect(c.nameZh.length).toBeGreaterThan(0);
        expect(c.conditionEn.length).toBeGreaterThan(0);
        expect(c.conditionZh.length).toBeGreaterThan(0);
        expect(c.frId.length).toBeGreaterThan(0);
      }
    }
  });

  it('the view snapshot is plain JSON-serializable data', () => {
    const { v } = stepped({ scrammed: true, powerFraction: 0.3 });
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });
});
