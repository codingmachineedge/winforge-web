// 燃料工廠 + CVCS 混合器 · Fuel-factory screens and the CVCS makeup-blender lineup.
//
// The factory side mirrors FuelFactoryService: fabricate → fresh → load (validated, signed)
// → burnup accrual in-core → auto-discharge to the spent pool. Rejection text comes
// bilingually from the factory (reasonEn/reasonZh); chrome strings live in the
// `reactorfuel` i18n slice. The blender side lines up Automatic / Borate / Dilute /
// AlternateDilute exactly like the source enum, with the time-to-criticality estimate
// and the uncontrolled-dilution drill + terminate action.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CvcsBlenderMode } from '../../reactor/physics';
import { MaxAssemblyKgU, MaxEnrichmentPct, MinAssemblyKgU, MinEnrichmentPct, type FuelAssembly } from '../../reactor/fuelFactory';
import type { UseReactorSim } from '../../reactor/useReactorSim';
import type { NumberFmt } from './format';

const PAIR = ' · ';

/** Bilingual passthrough for factory-supplied reason strings. */
function pickReason(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

function AssemblyRow({
  a,
  action,
  actionLabel,
  fmt,
}: {
  a: FuelAssembly;
  action?: (id: string) => void;
  actionLabel?: string;
  fmt: NumberFmt;
}) {
  return (
    <div className="fuel-row">
      <span className="fuel-id" title={a.id}>{a.id.slice(0, 8)}</span>
      <span>{fmt.fmt(a.enrichmentPct, 2)}%</span>
      <span>{fmt.fmt(a.massKgHM, 0)} kg</span>
      <span>{fmt.fmt(a.burnupMwdPerTonne, 0)}</span>
      {action && actionLabel && (
        <button className="mini" onClick={() => action(a.id)}>{actionLabel}</button>
      )}
    </div>
  );
}

export function FuelCvcsPanel({ sim, fmt }: { sim: UseReactorSim; fmt: NumberFmt }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const st = sim.state;
  const fuel = sim.fuel;

  const [enrich, setEnrich] = useState(4.2);
  const [mass, setMass] = useState(500);
  const [note, setNote] = useState('');

  const fabricate = () => {
    sim.fabricateAssembly(enrich, mass);
    setNote('');
  };

  const load = (id: string) => {
    const res = sim.loadAssembly(id);
    setNote(
      res.loaded
        ? t('reactorfuel.loadedOk', { id: id.slice(0, 8) })
        : t('reactorfuel.loadRejected', { reason: pickReason(res.reasonEn, res.reasonZh, lang) }),
    );
  };

  const dischargeAll = () => {
    if (window.confirm(t('reactorfuel.confirmDischarge'))) sim.dischargeAll();
  };

  const blends: { m: CvcsBlenderMode; key: string }[] = [
    { m: CvcsBlenderMode.Automatic, key: 'reactorfuel.blendAuto' },
    { m: CvcsBlenderMode.Borate, key: 'reactorfuel.blendBorate' },
    { m: CvcsBlenderMode.Dilute, key: 'reactorfuel.blendDilute' },
    { m: CvcsBlenderMode.AlternateDilute, key: 'reactorfuel.blendAltDilute' },
  ];

  const ttc = st.timeToCriticalitySeconds;
  const ttcText = Number.isFinite(ttc)
    ? t('reactorfuel.timeToCrit', { t: `${fmt.fmt(Math.max(0, ttc), 0)} s` })
    : t('reactorfuel.timeToCritStable');

  return (
    <section className="panel fuel-panel">
      <h2 className="panel-title">{t('reactorfuel.title')}</h2>

      <div className="fuel-status">
        <span className={`badge ${fuel.canRun ? 'tone-ok' : 'tone-danger'}`}>
          {fuel.canRun ? t('reactorfuel.canRun') : t('reactorfuel.noFuel')}
        </span>
        <span className="fuel-status-text">
          {t('reactorfuel.coreStatus', { n: fuel.loaded.length, bu: fmt.fmt(fuel.meanLoadedBurnup, 0) })}
        </span>
      </div>
      {st.fuelGateNoteEn && (
        <div className="fuel-gate-note">{pickReason(st.fuelGateNoteEn, st.fuelGateNoteZh, lang)}</div>
      )}
      {note && <div className="fuel-note">{note}</div>}
      {fuel.newlySpent.map((id) => (
        <div key={id} className="fuel-note">{t('reactorfuel.dischargedNote', { id: id.slice(0, 8) })}</div>
      ))}

      {/* ---- fabricate ---- */}
      <div className="fuel-fab">
        <div className="fuel-fab-title">{t('reactorfuel.fabTitle')}</div>
        <label>
          {t('reactorfuel.enrichment')}
          <input
            type="number"
            min={MinEnrichmentPct}
            max={MaxEnrichmentPct}
            step={0.05}
            value={enrich}
            onChange={(e) => setEnrich(Number(e.target.value))}
          />
        </label>
        <label>
          {t('reactorfuel.mass')}
          <input
            type="number"
            min={MinAssemblyKgU}
            max={MaxAssemblyKgU}
            step={10}
            value={mass}
            onChange={(e) => setMass(Number(e.target.value))}
          />
        </label>
        <div className="fuel-fab-actions">
          <button className="mini primary" onClick={fabricate}>{t('reactorfuel.fabricate')}</button>
          <button className="mini" onClick={sim.loadStandardCore}>{t('reactorfuel.loadStandard')}</button>
        </div>
      </div>

      {/* ---- inventory ---- */}
      <div className="fuel-lists">
        <div className="fuel-list">
          <div className="fuel-list-title">{t('reactorfuel.fresh', { n: fuel.fresh.length })}</div>
          {fuel.fresh.length === 0 && <div className="fuel-empty">{t('reactorfuel.emptyFresh')}</div>}
          {fuel.fresh.slice(0, 8).map((a) => (
            <AssemblyRow key={a.id} a={a} action={load} actionLabel={t('reactorfuel.load')} fmt={fmt} />
          ))}
        </div>
        <div className="fuel-list">
          <div className="fuel-list-title">{t('reactorfuel.loaded', { n: fuel.loaded.length })}</div>
          {fuel.loaded.length === 0 && <div className="fuel-empty">{t('reactorfuel.emptyLoaded')}</div>}
          {fuel.loaded.slice(0, 8).map((a) => (
            <AssemblyRow key={a.id} a={a} action={sim.unloadAssembly} actionLabel={t('reactorfuel.unload')} fmt={fmt} />
          ))}
          {fuel.loaded.length > 0 && (
            <button className="mini fuel-discharge-all" onClick={dischargeAll}>{t('reactorfuel.dischargeAll')}</button>
          )}
        </div>
        <div className="fuel-list">
          <div className="fuel-list-title">{t('reactorfuel.spent', { n: fuel.spent.length })}</div>
          {fuel.spent.length === 0 && <div className="fuel-empty">{t('reactorfuel.emptySpent')}</div>}
          {fuel.spent.slice(0, 5).map((a) => (
            <AssemblyRow key={a.id} a={a} fmt={fmt} />
          ))}
        </div>
      </div>

      {/* ---- CVCS blender ---- */}
      <div className="cvcs">
        <div className="fuel-list-title">{t('reactorfuel.blenderTitle')}</div>
        <div className="mode-row">
          {blends.map((b) => (
            <button
              key={b.m}
              className={`mode-btn${st.blenderMode === b.m ? ' active' : ''}`}
              onClick={() => sim.setBlenderMode(b.m)}
            >
              {t(b.key)}
            </button>
          ))}
        </div>
        <div className="cvcs-readouts">
          <span>{t('reactorfuel.makeupBlend', { ppm: fmt.fmt(st.makeupBlendPpm, 0) })}</span>
          <span>{ttcText}</span>
          {st.dilutionActive && Number.isFinite(st.dilutionActionMarginSeconds) && (
            <span>{t('reactorfuel.actionMargin', { t: fmt.fmt(st.dilutionActionMarginSeconds, 0) })}</span>
          )}
        </div>
        {st.dilutionActive ? (
          <div className="cvcs-drill">
            <span className="badge tone-danger">{t('reactorfuel.dilutionActive')}</span>
            <button className="mini primary" onClick={sim.terminateDilution}>{t('reactorfuel.terminateDilution')}</button>
          </div>
        ) : (
          <button className="mini cvcs-drill-btn" onClick={sim.startDilutionDrill}>{t('reactorfuel.dilutionDrill')}</button>
        )}
      </div>
    </section>
  );
}
