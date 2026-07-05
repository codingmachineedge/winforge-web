// 安全殼面板 · Containment panel — pressure/temperature readouts, the Hi-1/2/3 ESFAS
// bistable lamp ladder (with setpoints), ISOLATION / SPRAY / FAN COOLERS / SI status lamps,
// the containment normal-sump level bar + pump lamp, the per-RCP WOG-2000 seal-leakoff
// readout, and the CCW-loss drill / restore-seal-cooling operator buttons.
//
// A dumb view over the ContainmentView snapshot + operator callbacks: no engine import
// except types, no sim hook. Alarm-style texts arrive bilingually from the engine; only
// chrome labels come from the `reactorctmt` i18n slice.

import { useTranslation } from 'react-i18next';
import type { ContainmentView } from '../../reactor/containment';
import type { NumberFmt } from './format';
import '../../styles/reactor-ctmt.css';

export interface ContainmentPanelProps {
  v: ContainmentView;
  fmt: NumberFmt;
  /** CCW-loss drill — removes both RCP seal-cooling paths (WOG-2000 timeline starts). */
  onSealCoolingLoss?: () => void;
  /** Restore seal cooling (degradation already latched never reseats). */
  onRestoreSealCooling?: () => void;
}

/** A small status lamp: label lights when `on`. */
function Lamp({ on, label, tone = 'warn' }: { on: boolean; label: string; tone?: 'warn' | 'danger' | 'ok' }) {
  return <span className={`ctmt-lamp${on ? ` on tone-${tone}` : ''}`}>{label}</span>;
}

/** Linear level bar over [0, max] with an optional setpoint marker. */
function LevelBar({ value, max, markAt }: { value: number; max: number; markAt?: number }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="ctmt-bar">
      <div className="ctmt-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      {markAt !== undefined && (
        <div className="ctmt-bar-mark" style={{ left: `${((markAt / max) * 100).toFixed(1)}%` }} />
      )}
    </div>
  );
}

export function ContainmentPanel({ v, fmt, onSealCoolingLoss, onRestoreSealCooling }: ContainmentPanelProps) {
  const { t } = useTranslation();

  const ladder: { on: boolean; labelKey: string; setKpa: number }[] = [
    { on: v.hi3, labelKey: 'reactorctmt.hi3', setKpa: v.hi3SetKpa },
    { on: v.hi2, labelKey: 'reactorctmt.hi2', setKpa: v.hi2SetKpa },
    { on: v.hi1, labelKey: 'reactorctmt.hi1', setKpa: v.hi1SetKpa },
  ];

  return (
    <section className="panel ctmt-panel">
      <h2 className="panel-title">{t('reactorctmt.title')}</h2>

      {/* ---- pressure / temperature gauges ---- */}
      <div className="ctmt-gauges">
        <div className="ctmt-gauge">
          <div className="ctmt-gauge-label">{t('reactorctmt.pressure')}</div>
          <div className="ctmt-gauge-value">
            {fmt.fmt(v.pressureKpaG, 1)} <span className="ctmt-unit">{t('reactorctmt.kpag')}</span>
          </div>
          <div className="ctmt-gauge-sub">
            {fmt.fmt(v.pressurePsig, 2)} {t('reactorctmt.psig')} · {t('reactorctmt.designRef', { p: fmt.fmt(v.designPsig, 0) })}
          </div>
          <LevelBar value={v.pressureKpaG} max={415} markAt={v.hi3SetKpa} />
        </div>
        <div className="ctmt-gauge">
          <div className="ctmt-gauge-label">{t('reactorctmt.temp')}</div>
          <div className="ctmt-gauge-value">
            {fmt.fmt(v.tempC, 1)} <span className="ctmt-unit">{t('reactorctmt.degC')}</span>
          </div>
          <LevelBar value={v.tempC} max={150} />
        </div>
      </div>

      {/* ---- Hi-1/2/3 bistable ladder (highest on top) ---- */}
      <div className="ctmt-ladder">
        <div className="ctmt-section-title">{t('reactorctmt.ladderTitle')}</div>
        {ladder.map((r) => (
          <div key={r.labelKey} className={`ctmt-ladder-row${r.on ? ' on' : ''}`}>
            <span className="ctmt-ladder-dot" aria-hidden="true" />
            <span className="ctmt-ladder-name">{t(r.labelKey)}</span>
            <span className="ctmt-ladder-set">{t('reactorctmt.setpoint', { kpa: fmt.fmt(r.setKpa, 0) })}</span>
          </div>
        ))}
      </div>

      {/* ---- ESF status lamps ---- */}
      <div className="ctmt-lamps">
        <Lamp on={v.isolationActuated} label={t('reactorctmt.isolation')} tone="danger" />
        <Lamp on={v.sprayActive} label={t('reactorctmt.spray')} tone="danger" />
        <Lamp on={v.fanCoolers} label={t('reactorctmt.fanCoolers')} tone="warn" />
        <Lamp on={v.siActuated} label={t('reactorctmt.si')} tone="danger" />
      </div>
      {v.spraySetupRemainingS > 0 && (
        <div className="ctmt-note">{t('reactorctmt.sprayCountdown', { s: fmt.fmt(v.spraySetupRemainingS, 0) })}</div>
      )}

      {/* ---- sump ---- */}
      <div className="ctmt-sump">
        <div className="ctmt-row-head">
          <span className="ctmt-section-title">{t('reactorctmt.sumpTitle')}</span>
          <span className="ctmt-val">
            {fmt.fmt(v.sumpGal, 0)} / {fmt.fmt(v.sumpCapacityGal, 0)} {t('reactorctmt.gal')}
          </span>
        </div>
        <LevelBar value={v.sumpGal} max={v.sumpCapacityGal} markAt={v.sumpHiSetpointGal} />
        <div className="ctmt-row-head">
          <Lamp on={v.sumpPumpOn} label={t('reactorctmt.sumpPump')} tone="ok" />
          <span className="ctmt-note">{t('reactorctmt.sumpInferred', { g: fmt.fmt(v.sumpInferredLeakGpm, 1) })}</span>
        </div>
      </div>

      {/* ---- RCP seal leakoff ---- */}
      <div className="ctmt-seals">
        <div className="ctmt-row-head">
          <span className="ctmt-section-title">{t('reactorctmt.sealTitle')}</span>
          <Lamp
            on={!v.sealCoolingAvailable || v.sealLocaActive}
            label={
              v.sealLocaActive
                ? t('reactorctmt.sealLoca')
                : v.sealCoolingAvailable
                  ? t('reactorctmt.sealCoolingOk')
                  : t('reactorctmt.sealCoolingLost')
            }
            tone="danger"
          />
        </div>
        <div className="ctmt-seal-grid">
          {v.sealLeakGpmPerPump.map((g, i) => (
            <div key={i} className="ctmt-seal-cell">
              <div className="ctmt-seal-name">{t('reactorctmt.rcp', { n: i + 1 })}</div>
              <div className="ctmt-seal-val">
                {fmt.fmt(g, 1)} <span className="ctmt-unit">{t('reactorctmt.gpm')}</span>
              </div>
              <div className="ctmt-note">{t('reactorctmt.cavity', { t: fmt.fmt(v.sealCavityTempC[i] ?? 0, 0) })}</div>
              <LevelBar value={g} max={v.sealLeakGpmPerPumpMax} />
            </div>
          ))}
        </div>
        <div className="ctmt-row-head">
          <span className="ctmt-note">{t('reactorctmt.rcpsRunning', { n: v.rcpRunningCount })}</span>
          <span className="ctmt-val">
            {t('reactorctmt.totalLeak')}: {fmt.fmt(v.sealLeakGpmTotal, 1)} {t('reactorctmt.gpm')}
          </span>
        </div>
        <div className="ctmt-drill">
          <button
            className="mini"
            onClick={onSealCoolingLoss}
            disabled={!onSealCoolingLoss || v.ccwLossActive}
          >
            {t('reactorctmt.ccwDrill')}
          </button>
          <button
            className="mini"
            onClick={onRestoreSealCooling}
            disabled={!onRestoreSealCooling || !v.ccwLossActive}
          >
            {t('reactorctmt.restoreCooling')}
          </button>
        </div>
      </div>

      {/* ---- engine-supplied bilingual alarms ---- */}
      {v.alarms.length > 0 && (
        <div className="ctmt-alarms">
          {v.alarms.map((a) => (
            <span key={a.en} className="ctmt-alarm">
              {a.en} · {a.zh}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
