// 工程安全設施面板 · Engineered Safety Features (ESF) panel — Safety Injection status lamp block
// (ACTUATED / HHSI flow / boration rate), N₂ accumulator bank bar (remaining %, DUMPING lamp),
// the 5-stage MSSV bank with per-valve setpoint labels + total-relief readout, and the manual
// SI / reset SI pushbuttons.
//
// A dumb view over the EngineeredSafetyView snapshot + operator callbacks: no engine import
// (types only), no useReactorSim. Chrome labels come from the `reactoresf` i18n namespace;
// dynamic physics strings (SI status, annunciators) arrive bilingually on the View itself.

import { useTranslation } from 'react-i18next';
import type { EngineeredSafetyView } from '../../reactor/engineeredSafety';
import type { NumberFmt } from './format';
import '../../styles/reactor-esf.css';

const PAIR = ' · ';

/** Pick a bilingual engine-supplied string for the active language mode (same idiom as FuelCvcsPanel). */
function pickText(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

export interface EsfPanelProps {
  v: EngineeredSafetyView;
  fmt: NumberFmt;
  /** Manual SI actuation pushbutton. */
  onActuateSi?: () => void;
  /** SI block/reset pushbutton (honoured only after the actuating conditions clear). */
  onResetSi?: () => void;
}

export function EsfPanel({ v, fmt, onActuateSi, onResetSi }: EsfPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  return (
    <section className="panel esf-panel">
      <h2 className="panel-title">{t('reactoresf.title')}</h2>

      {/* ---- Safety Injection lamp block ---- */}
      <div className="esf-block">
        <div className="esf-block-head">
          <span className="esf-block-title">{t('reactoresf.siTitle')}</span>
          <span className={`esf-lamp${v.siActive ? ' lit-danger' : ''}`}>
            {v.siActive ? t('reactoresf.siActuated') : t('reactoresf.siStandby')}
          </span>
        </div>
        <div className="esf-si-status">{pickText(v.siStatusEn, v.siStatusZh, lang)}</div>
        <div className="esf-readouts">
          <div className="esf-readout">
            <span className="esf-readout-label">{t('reactoresf.siFlow')}</span>
            <span className="esf-readout-value">{fmt.fmt(v.siFlowFrac * 100, 0)} %</span>
            <div className="esf-bar">
              <div className="esf-bar-fill si" style={{ width: `${(v.siFlowFrac * 100).toFixed(1)}%` }} />
            </div>
          </div>
          <div className="esf-readout">
            <span className="esf-readout-label">{t('reactoresf.siBoronRate')}</span>
            <span className="esf-readout-value">
              {v.siBoronRatePpmPerS > 0 ? '+' : ''}
              {fmt.fmt(v.siBoronRatePpmPerS, 1)} ppm/s
            </span>
            <span className="esf-readout-sub">{t('reactoresf.siBoronTarget', { ppm: fmt.fmt(v.siBoronTargetPpm, 0) })}</span>
          </div>
        </div>
        <div className="esf-row">
          <span className={`esf-lamp small${v.siLowPressArmed ? ' lit-ok' : ''}`}>
            {v.siLowPressArmed ? t('reactoresf.siLowPressArmed') : t('reactoresf.siLowPressBlocked')}
          </span>
          <span className="esf-buttons">
            <button type="button" className="btn esf-btn danger" onClick={onActuateSi} disabled={!onActuateSi || v.siActive}>
              {t('reactoresf.actuateSi')}
            </button>
            <button type="button" className="btn secondary esf-btn" onClick={onResetSi} disabled={!onResetSi || !v.siActive}>
              {t('reactoresf.resetSi')}
            </button>
          </span>
        </div>
      </div>

      {/* ---- N₂ accumulator bank ---- */}
      <div className="esf-block">
        <div className="esf-block-head">
          <span className="esf-block-title">{t('reactoresf.accumTitle')}</span>
          <span
            className={`esf-lamp${
              v.accumulatorsDumping ? ' lit-warn' : v.accumulatorLevelPct <= 0 ? ' lit-danger' : ''
            }`}
          >
            {v.accumulatorsDumping
              ? t('reactoresf.accumDumping')
              : v.accumulatorLevelPct <= 0
                ? t('reactoresf.accumEmpty')
                : v.accumulatorsArmed
                  ? t('reactoresf.accumStandby')
                  : t('reactoresf.accumUnarmed')}
          </span>
        </div>
        <div className="esf-readout">
          <span className="esf-readout-label">
            {t('reactoresf.accumRemaining')} · {t('reactoresf.accumPrecharge', { mpa: fmt.fmt(v.accumulatorPrechargeMPa, 1) })}
          </span>
          <span className="esf-readout-value">{fmt.fmt(v.accumulatorLevelPct, 0)} %</span>
          <div className="esf-bar tall">
            <div
              className={`esf-bar-fill accum${v.accumulatorsDumping ? ' dumping' : ''}`}
              style={{ width: `${Math.max(0, Math.min(100, v.accumulatorLevelPct)).toFixed(1)}%` }}
            />
          </div>
        </div>
      </div>

      {/* ---- MSSV bank — 5 valve lamps with per-valve setpoint labels ---- */}
      <div className="esf-block">
        <div className="esf-block-head">
          <span className="esf-block-title">{t('reactoresf.mssvTitle')}</span>
          <span className={`esf-lamp${v.mssvOpenCount > 0 ? ' lit-warn' : ''}`}>
            {t('reactoresf.mssvOpenCount', { n: v.mssvOpenCount })}
          </span>
        </div>
        <div className="esf-mssv-row">
          {v.mssvOpen.map((open, i) => (
            <div key={i} className={`esf-mssv-valve${open ? ' open' : ''}`}>
              <span className="esf-mssv-name">{t('reactoresf.mssvValve', { n: i + 1 })}</span>
              <span className={`esf-mssv-lamp${open ? ' lit' : ''}`}>
                {open ? t('reactoresf.mssvOpen') : t('reactoresf.mssvShut')}
              </span>
              <span className="esf-mssv-set">
                {fmt.fmt(v.mssvAnalogPsig[i] ?? 0, 1)} {t('reactoresf.mssvSetpointUnit')}
              </span>
              <span className="esf-mssv-set sub">{fmt.fmt(v.mssvSetpointMpa[i] ?? 0, 2)} MPa</span>
            </div>
          ))}
        </div>
        <div className="esf-row">
          <span className="esf-readout-label">{t('reactoresf.mssvTotalRelief')}</span>
          <span className="esf-readout-value">{fmt.fmt(v.mssvReliefFlowFrac * 100, 1)} %</span>
        </div>
        <div className="esf-bar">
          <div className="esf-bar-fill mssv" style={{ width: `${(v.mssvReliefFlowFrac * 100).toFixed(1)}%` }} />
        </div>
      </div>

      {/* ---- ESF annunciators (bilingual pairs straight off the engine View) ---- */}
      {v.activeAlarmsEn.length > 0 && (
        <div className="esf-alarms">
          {v.activeAlarmsEn.map((a, i) => (
            <span key={a} className="esf-alarm-tile">
              {pickText(a, v.activeAlarmsZh[i] ?? '', lang)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
