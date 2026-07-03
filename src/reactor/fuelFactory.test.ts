// 燃料工廠單元測試 · Fuel-factory / fuel-cycle unit tests, mirroring the intent of WinForge's
// FuelFactoryService behaviour (fabricate → load(consume) → burnup → auto-discharge, plus the
// validation / anti-replay / counterfeit-harm security model).

import { describe, it, expect } from 'vitest';
import {
  FuelFactory,
  DischargeThresholdMwd,
  MinEnrichmentPct,
  MaxEnrichmentPct,
  MaxAssemblyKgU,
} from './fuelFactory';

describe('fuel factory / fuel cycle', () => {
  it('fabricates a realistic 17x17 UO2 assembly clamped to the fresh-fuel envelope', () => {
    const ff = new FuelFactory();
    const a = ff.fabricate(4.2, 460);
    expect(a.lattice).toBe('17x17');
    expect(a.material).toBe('UO2');
    expect(a.enrichmentPct).toBeCloseTo(4.2, 5);
    expect(a.massKgHM).toBeCloseTo(460, 5);
    expect(a.status).toBe('fresh');
    expect(a.signatureValid).toBe(true);
    expect(a.burnupMwdPerTonne).toBe(0);
    expect(a.fabChain.length).toBeGreaterThanOrEqual(5);
    expect(a.id).toMatch(/^OPEN100-17x17-\d{4}$/);
  });

  it('clamps enrichment and mass to the physical envelope', () => {
    const ff = new FuelFactory();
    const hi = ff.fabricate(19, 9000);
    expect(hi.enrichmentPct).toBe(MaxEnrichmentPct);
    expect(hi.massKgHM).toBe(MaxAssemblyKgU);
    const lo = ff.fabricate(0.1, 1);
    expect(lo.enrichmentPct).toBe(MinEnrichmentPct);
  });

  it('loading consumes the assembly from fresh into the core and gates reactor-run', () => {
    const ff = new FuelFactory();
    expect(ff.canReactorRun()).toBe(false);
    const a = ff.fabricate(4.2, 460);
    const r = ff.loadIntoCore(a.id);
    expect(r.loaded).toBe(true);
    expect(ff.listFresh().find((x) => x.id === a.id)).toBeUndefined(); // consumed from fresh
    expect(ff.listLoaded().find((x) => x.id === a.id)?.status).toBe('loaded');
    expect(ff.canReactorRun()).toBe(true);
  });

  it('burnup accrues on in-core fuel split by mass and auto-discharges at the limit', () => {
    const ff = new FuelFactory();
    const a = ff.fabricate(4.5, 460);
    ff.loadIntoCore(a.id);
    // 460 kg = 0.46 t. To reach 50000 MWd/t need 23000 MWd. At 3411 MW that's ~6.74 days.
    let spent: string[] = [];
    for (let i = 0; i < 800; i++) {
      spent = ff.accrueBurnup(3411, 1000); // 1000 s chunks
      if (spent.length) break;
    }
    expect(spent).toContain(a.id);
    expect(ff.canReactorRun()).toBe(false); // core now depleted/empty
    expect(ff.listSpent().find((x) => x.id === a.id)?.status).toBe('spent');
    const disc = ff.listSpent().find((x) => x.id === a.id)!;
    expect(disc.burnupMwdPerTonne).toBeGreaterThanOrEqual(DischargeThresholdMwd);
  });

  it('refuses to replay a spent/consumed assembly id (anti-replay ledger)', () => {
    const ff = new FuelFactory();
    const a = ff.fabricate(4.2, 460);
    ff.loadIntoCore(a.id);
    ff.dischargeAll();
    // A crafted fresh copy of the same id must be refused as already-consumed.
    const copy = ff.craftSigned({
      assemblyId: a.id,
      lattice: '17x17',
      material: 'UO2',
      manufacturer: 'WinForge Nuclear Fuels (OPEN100)',
      fabricationLot: 'LOT-202501-01',
      enrichmentU235Pct: 4.2,
      massKgHM: 460,
      targetBurnupMwdPerTonne: 45000,
      fabricationDateUtc: '2025-01-01T00:00:00Z',
      burnupMwdPerTonne: 0,
      status: 'fresh',
    });
    ff.importRaw(copy);
    const v = ff.validate(a.id);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('already-consumed');
  });

  it('detects a tampered assembly (bad signature) and refuses to load it', () => {
    const ff = new FuelFactory();
    const a = ff.fabricate(4.2, 460);
    // Import a forged file: valid-looking payload but a signature this factory never issued.
    const forged = { payload: { ...ff.craftSigned({
      assemblyId: 'FORGED-0001', lattice: '17x17', material: 'UO2',
      manufacturer: 'ACME', fabricationLot: 'X', enrichmentU235Pct: 4.2, massKgHM: 460,
      targetBurnupMwdPerTonne: 45000, fabricationDateUtc: '2025-01-01T00:00:00Z',
      burnupMwdPerTonne: 0, status: 'fresh' as const,
    }).payload }, sig: 'deadbeefdeadbeef' };
    ff.importRaw(forged);
    const v = ff.validate('FORGED-0001');
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('tampered');
    const r = ff.loadIntoCore('FORGED-0001');
    expect(r.loaded).toBe(false);
    // sanity: the authentic one still loads
    expect(ff.loadIntoCore(a.id).loaded).toBe(true);
  });

  it('unsafe-load of counterfeit fuel consumes it and reports graded harm', () => {
    const ff = new FuelFactory();
    const forged = { payload: ff.craftSigned({
      assemblyId: 'BAD-0001', lattice: '17x17', material: 'UO2',
      manufacturer: 'ACME', fabricationLot: 'X', enrichmentU235Pct: 4.2, massKgHM: 460,
      targetBurnupMwdPerTonne: 45000, fabricationDateUtc: '2025-01-01T00:00:00Z',
      burnupMwdPerTonne: 0, status: 'fresh' as const,
    }).payload, sig: 'notavalidsig' };
    ff.importRaw(forged);
    const r = ff.loadIntoCoreUnsafe('BAD-0001');
    expect(r.loaded).toBe(false);
    expect(r.harmful).toBe(true);
    expect(r.harmSeverity).toBeGreaterThan(0);
    expect(r.harmSeverity).toBeLessThanOrEqual(1);
    // consumed: gone from every pool
    expect(ff.findAny('BAD-0001')).toBe(false);
  });

  it('unsafe-load of authentic in-spec fuel is a normal, non-harmful load', () => {
    const ff = new FuelFactory();
    const a = ff.fabricate(4.2, 460);
    const r = ff.loadIntoCoreUnsafe(a.id);
    expect(r.loaded).toBe(true);
    expect(r.harmful).toBe(false);
  });

  it('loadStandardCore fabricates and loads a full 8-assembly core', () => {
    const ff = new FuelFactory();
    const n = ff.loadStandardCore(4.2);
    expect(n).toBe(8);
    expect(ff.loadedCount()).toBe(8);
    expect(ff.canReactorRun()).toBe(true);
  });
});
