// 反應性測量儀 · Reactimeter panel — the independent inverse-point-kinetics reactivity computer.
//
// Reconstructs reactivity (pcm and $), stable period and startup rate from the neutron-flux signal
// alone, independent of the engine's own reactivity breakdown. MARK captures a reference so the
// operator can read the integrated worth swing of a rod motion or boron change since the mark
// (the classic rod-worth measurement). All values come off the engine snapshot; mark/clear are the
// only controls. Bilingual chrome via the `reactorrmtr` namespace.

import { useTranslation } from 'react-i18next';
import type { NumberFmt } from './format';

export interface ReactimeterPanelProps {
  measuredReactivityPcm: number;
  measuredReactivityDollars: number;
  measuredPeriodSeconds: number;
  measuredStartupRateDpm: number;
  measuredWorthPcm: number;
  hasMark: boolean;
  positiveRateAlarm: boolean;
  fmt: NumberFmt;
  onMark: () => void;
  onClearMark: () => void;
}

function fmtPeriod(s: number, stable: string, fmt: NumberFmt): string {
  if (!Number.isFinite(s) || Math.abs(s) >= 1e6) return `∞ · ${stable}`;
  if (Math.abs(s) >= 1000) return fmt.fmt(s, 0);
  return fmt.fmt(s, 1);
}

export function ReactimeterPanel({
  measuredReactivityPcm,
  measuredReactivityDollars,
  measuredPeriodSeconds,
  measuredStartupRateDpm,
  measuredWorthPcm,
  hasMark,
  positiveRateAlarm,
  fmt,
  onMark,
  onClearMark,
}: ReactimeterPanelProps) {
  const { t } = useTranslation();
  const sign = (x: number) => (x >= 0 ? '+' : '');

  return (
    <section className="panel">
      <h2 className="panel-title">
        {t('reactorrmtr.title')}
        {positiveRateAlarm && <span className="badge tone-warn" style={{ marginLeft: 8 }}>{t('reactorrmtr.positiveRate')}</span>}
      </h2>
      <p className="gauge-sub" style={{ marginTop: 0 }}>{t('reactorrmtr.subtitle')}</p>

      <div className="gauges gauges-sm" style={{ marginTop: 8 }}>
        <div className="gauge">
          <div className="label">{t('reactorrmtr.reactivity')}</div>
          <div className={`value tone-${measuredReactivityPcm >= 0 ? 'warn' : 'ok'}`}>
            {sign(measuredReactivityPcm)}{fmt.fmt(measuredReactivityPcm, 0)}
            <span className="unit"> {t('reactorrmtr.pcm')}</span>
          </div>
          <div className="gauge-sub">
            {sign(measuredReactivityDollars)}{fmt.fmt(measuredReactivityDollars, 3)} {t('reactorrmtr.dollarsUnit')}
          </div>
        </div>
        <div className="gauge">
          <div className="label">{t('reactorrmtr.period')}</div>
          <div className="value">
            {fmtPeriod(measuredPeriodSeconds, t('reactorrmtr.stable'), fmt)}
            <span className="unit"> {t('reactorrmtr.sec')}</span>
          </div>
        </div>
        <div className="gauge">
          <div className="label">{t('reactorrmtr.sur')}</div>
          <div className="value">
            {sign(measuredStartupRateDpm)}{fmt.fmt(measuredStartupRateDpm, 2)}
            <span className="unit"> {t('reactorrmtr.dpm')}</span>
          </div>
        </div>
        <div className="gauge">
          <div className="label">{t('reactorrmtr.worth')}</div>
          <div className={`value tone-${hasMark ? 'accent' : undefined}`}>
            {hasMark ? `${sign(measuredWorthPcm)}${fmt.fmt(measuredWorthPcm, 0)}` : '—'}
            {hasMark && <span className="unit"> {t('reactorrmtr.pcm')}</span>}
          </div>
        </div>
      </div>

      <p className="gauge-sub">{hasMark ? t('reactorrmtr.marked') : t('reactorrmtr.noMark')}</p>

      <div className="ctl-buttons">
        <button className="btn" onClick={onMark}>{t('reactorrmtr.mark')}</button>
        <button className="btn secondary" disabled={!hasMark} onClick={onClearMark}>
          {t('reactorrmtr.clearMark')}
        </button>
      </div>
      <p className="gauge-sub">{t('reactorrmtr.note')}</p>
    </section>
  );
}
