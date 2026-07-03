// 核測量系統 · Nuclear Instrumentation System (NIS) panel.
//
// Source Range (BF3 counters, cps, log scale), Intermediate Range (compensated ion chambers, amps
// → decades, log scale), Power Range (uncompensated ion chambers, linear % RTP), plus startup rate
// (DPM) and 1/M. All values come straight off the engine snapshot — nothing is synthesized here.
//
// Engine fields bound:
//   sourceRangeCps, oneOverM, sourceRangeEnergized,
//   intermediateRangeAmps, intermediateRangeDecades, intermediateRangePercent,
//   powerRangePercent, startupRateDpm

import { useTranslation } from 'react-i18next';
import type { NumberFmt } from './format';

export interface NisPanelProps {
  sourceRangeCps: number;
  oneOverM: number;
  sourceRangeEnergized: boolean;
  intermediateRangeAmps: number;
  intermediateRangeDecades: number;
  powerRangePercent: number;
  startupRateDpm: number;
  fmt: NumberFmt;
}

/** A horizontal log-scale bar spanning [10^loExp, 10^hiExp] filled to `value`. */
function LogBar({ value, loExp, hiExp }: { value: number; loExp: number; hiExp: number }) {
  const v = value > 0 ? Math.log10(value) : loExp;
  const frac = (v - loExp) / (hiExp - loExp);
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div className="nis-bar">
      <div className="nis-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
    </div>
  );
}

/** A linear bar over [0, max]. */
function LinBar({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="nis-bar">
      <div className="nis-bar-fill lin" style={{ width: `${pct.toFixed(1)}%` }} />
    </div>
  );
}

/** Compact scientific notation, e.g. 1.2e-9 → "1.2×10⁻⁹" (kept ASCII-ish for readability). */
function sci(n: number, fmt: NumberFmt): string {
  if (!Number.isFinite(n) || n <= 0) return fmt.fmt(0, 1);
  const exp = Math.floor(Math.log10(n));
  const mant = n / Math.pow(10, exp);
  return `${fmt.fmt(mant, 2)}e${exp}`;
}

export function NisPanel({
  sourceRangeCps,
  oneOverM,
  sourceRangeEnergized,
  intermediateRangeAmps,
  intermediateRangeDecades,
  powerRangePercent,
  startupRateDpm,
  fmt,
}: NisPanelProps) {
  const { t } = useTranslation();

  return (
    <section className="panel nis-panel">
      <h2 className="panel-title">{t('reactorui.nisTitle')}</h2>

      {/* Source Range — cps, log 1 .. 1e6 */}
      <div className="nis-row">
        <div className="nis-row-head">
          <span className="nis-name">
            <span className="nis-abbr">{t('reactorui.sourceRangeAbbr')}</span> {t('reactorui.sourceRange')}
          </span>
          <span className="nis-val">
            {fmt.fmt(sourceRangeCps, 0)} <span className="nis-unit">{t('reactorui.cps')}</span>
          </span>
        </div>
        <LogBar value={sourceRangeCps} loExp={0} hiExp={6} />
        <div className="nis-note">
          {t('reactorui.oneOverM')} = {fmt.fmt(oneOverM, 3)} ·{' '}
          <span className={sourceRangeEnergized ? 'nis-energized' : 'nis-deenergized'}>
            {sourceRangeEnergized ? t('reactorui.srEnergized') : t('reactorui.srDeenergized')}
          </span>
        </div>
      </div>

      {/* Intermediate Range — amps, log 1e-11 .. 1e-3 (0..8 decades) */}
      <div className="nis-row">
        <div className="nis-row-head">
          <span className="nis-name">
            <span className="nis-abbr">{t('reactorui.intermediateRangeAbbr')}</span> {t('reactorui.intermediateRange')}
          </span>
          <span className="nis-val">
            {sci(intermediateRangeAmps, fmt)} <span className="nis-unit">{t('reactorui.amps')}</span>
          </span>
        </div>
        <LogBar value={intermediateRangeAmps} loExp={-11} hiExp={-3} />
        <div className="nis-note">
          {fmt.fmt(intermediateRangeDecades, 1)} {t('reactorui.decades')}
        </div>
      </div>

      {/* Power Range — linear % RTP 0..120 */}
      <div className="nis-row">
        <div className="nis-row-head">
          <span className="nis-name">
            <span className="nis-abbr">{t('reactorui.powerRangeAbbr')}</span> {t('reactorui.powerRange')}
          </span>
          <span className="nis-val">
            {fmt.fmt(powerRangePercent, powerRangePercent < 10 ? 2 : 1)}{' '}
            <span className="nis-unit">{t('reactorui.pct')}</span>
          </span>
        </div>
        <LinBar value={powerRangePercent} max={120} />
      </div>

      {/* Startup rate — DPM */}
      <div className="nis-row nis-row-sur">
        <span className="nis-name">{t('reactorui.startupRate')}</span>
        <span className={`nis-val${startupRateDpm > 1 ? ' warn' : ''}`}>
          {startupRateDpm >= 0 ? '+' : ''}
          {fmt.fmt(startupRateDpm, 2)} <span className="nis-unit">{t('reactorui.dpm')}</span>
        </span>
      </div>
    </section>
  );
}
