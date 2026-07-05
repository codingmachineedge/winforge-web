// 發電額度面板 · Power-credit ledger, redemption-mode selector and both redemption surfaces.
//
// Credits are awarded by EXTERNAL systems (window.winforgeGrantPowerCredits / the inbox key /
// the desktop inbox file — see src/reactor/powerCredits.ts for the documented store + formats);
// this panel only shows the balance and redeems it:
//   • grid mode — the credit supply carries the grid while the reactor is off (1 credit / h),
//   • auto-start mode — 1 whole credit buys exactly one self-terminating reactor hour.

import { useTranslation } from 'react-i18next';
import { ReactorMode } from '../../reactor/physics';
import { CREDIT_GRID_SUPPLY_MW, reactorIsOff, type CreditRedemptionMode } from '../../reactor/powerCredits';
import type { UseReactorSim } from '../../reactor/useReactorSim';
import type { NumberFmt } from './format';

function fmtClock(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function PowerCreditsPanel({ sim, fmt }: { sim: UseReactorSim; fmt: NumberFmt }) {
  const { t } = useTranslation();
  const st = sim.state;
  const c = sim.credits;

  const modes: { m: CreditRedemptionMode; key: string; noteKey: string }[] = [
    { m: 'grid', key: 'reactorcredits.modeGrid', noteKey: 'reactorcredits.modeGridNote' },
    { m: 'autostart', key: 'reactorcredits.modeAuto', noteKey: 'reactorcredits.modeAutoNote' },
  ];

  const supplying = c.creditPowerMW > 0;
  const gridBadge = supplying
    ? { key: 'reactorcredits.gridSupplying', tone: 'ok' }
    : c.balance <= 0 && reactorIsOff(st.mode)
      ? { key: 'reactorcredits.gridExhausted', tone: 'danger' }
      : { key: 'reactorcredits.gridStandby', tone: 'warn' };

  const canAutoStart =
    c.balance >= 1 && !c.autoRunActive && st.fuelAvailable && st.mode !== ReactorMode.Meltdown;

  return (
    <section className="panel credits-panel">
      <h2 className="panel-title">{t('reactorcredits.title')}</h2>

      <div className="credits-balance">
        <span className="credits-balance-label">{t('reactorcredits.balance')}</span>
        <span className="credits-balance-value">
          {t('reactorcredits.balanceValue', { n: fmt.fmt(c.balance, 2) })}
        </span>
      </div>
      <p className="count-note credits-note">
        {t('reactorcredits.unitNote', { mwh: fmt.fmt(CREDIT_GRID_SUPPLY_MW, 0) })}
      </p>
      <p className="count-note credits-note">{t('reactorcredits.sourceNote')}</p>

      {/* ---- redemption mode ---- */}
      <div className="fuel-list-title">{t('reactorcredits.modeTitle')}</div>
      <div className="mode-row">
        {modes.map((b) => (
          <button
            key={b.m}
            className={`mode-btn${c.mode === b.m ? ' active' : ''}`}
            onClick={() => sim.setCreditMode(b.m)}
          >
            {t(b.key)}
          </button>
        ))}
      </div>
      <p className="count-note credits-note">
        {t(c.mode === 'grid' ? 'reactorcredits.modeGridNote' : 'reactorcredits.modeAutoNote')}
      </p>

      {/* ---- active-mode surface ---- */}
      {c.mode === 'grid' ? (
        <div className="credits-grid-row">
          <span className={`badge tone-${gridBadge.tone}`}>{t(gridBadge.key)}</span>
          <span>
            {t('reactorcredits.gridOutput')}: {fmt.fmt(c.gridPowerMW, 0)} MWe
            {supplying && <> · {t('reactorcredits.creditSupply', { mw: fmt.fmt(c.creditPowerMW, 0) })}</>}
          </span>
          {c.balance > 0 && <span>{t('reactorcredits.hoursLeft', { h: fmt.fmt(c.balance, 1) })}</span>}
        </div>
      ) : (
        <div className="credits-auto-row">
          {c.autoRunActive ? (
            <span className="badge tone-ok">{t('reactorcredits.autoActive', { t: fmtClock(c.autoRunRemainingS) })}</span>
          ) : (
            <button className="mini primary" disabled={!canAutoStart} onClick={sim.redeemAutoStartHour}>
              {t('reactorcredits.autoBtn')}
            </button>
          )}
          {!c.autoRunActive && c.balance < 1 && <span className="count-note credits-note">{t('reactorcredits.noCredits')}</span>}
          {!c.autoRunActive && c.balance >= 1 && !st.fuelAvailable && (
            <span className="count-note credits-note">{t('reactorcredits.autoNeedsFuel')}</span>
          )}
          <span className="count-note credits-note">{t('reactorcredits.autoNote')}</span>
        </div>
      )}
    </section>
  );
}
