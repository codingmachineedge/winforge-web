// 穩壓器釋壓面板 · Pressurizer relief panel — PORV command lamp vs the PRT symptoms (the TMI-2
// lesson), block valve, 3 code-safety lamps, LTOP state, PRT mini-gauges (pressure psig /
// temperature °C / level %), rupture-disc lamp, discharge indicator, and the stuck-PORV drill +
// block-valve operator actions.
//
// Dumb view over the PressureReliefView snapshot + callbacks: no engine import except types,
// no useReactorSim. Dynamic annunciator/status text arrives bilingually from the engine
// (alarmsEn/Zh, porvStatusEn/Zh); chrome labels live in the `reactorrelief` i18n slice.

import { useTranslation } from 'react-i18next';
import type { PressureReliefView } from '../../reactor/pressureRelief';
import type { NumberFmt } from './format';
import '../../styles/reactor-relief.css';

const PAIR = ' · ';

/** Bilingual passthrough for engine-supplied En/Zh pairs (same policy as FuelCvcsPanel). */
function pick(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

/** A linear mini-gauge bar over [0, max] with optional warn/danger colouring and setpoint ticks. */
function ReliefBar({
  value,
  max,
  tone,
  ticks,
}: {
  value: number;
  max: number;
  tone: 'ok' | 'warn' | 'danger';
  ticks?: number[];
}) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="relief-bar">
      <div
        className={`relief-bar-fill${tone === 'ok' ? '' : ` ${tone}`}`}
        style={{ width: `${pct.toFixed(1)}%` }}
      />
      {(ticks ?? []).map((tk) => (
        <div key={tk} className="relief-bar-tick" style={{ left: `${((tk / max) * 100).toFixed(1)}%` }} />
      ))}
    </div>
  );
}

export interface PressureReliefPanelProps {
  v: PressureReliefView;
  fmt: NumberFmt;
  /** 卡閥演習 · Arm the stuck-open-PORV (TMI-2) drill. */
  onTriggerStuckPorv?: () => void;
  /** 關隔離閥 · Close the PORV block valve (the TMI recovery isolation). */
  onCloseBlockValve?: () => void;
  /** 開隔離閥 · Reopen the PORV block valve. */
  onOpenBlockValve?: () => void;
}

export function PressureReliefPanel({
  v,
  fmt,
  onTriggerStuckPorv,
  onCloseBlockValve,
  onOpenBlockValve,
}: PressureReliefPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  const pressTone = v.prtPressurePsig > 100 ? 'danger' : v.prtPressurePsig > 8 ? 'warn' : 'ok';
  const tempTone = v.prtTempC > 60 ? 'warn' : 'ok';
  const levelTone = v.prtLevelPct > 92 || v.prtLevelPct < 50 ? 'warn' : 'ok';

  const ltopState = v.ltopPorvOpen
    ? t('reactorrelief.ltopRelieving')
    : v.ltopArmed
      ? t('reactorrelief.ltopArmed')
      : t('reactorrelief.ltopDisarmed');

  return (
    <section className="panel relief-panel">
      <h2 className="panel-title">{t('reactorrelief.title')}</h2>

      {/* ---- valve lamps: COMMAND, not position — the TMI-2 trap ---- */}
      <div className="relief-lamps">
        <div className={`relief-lamp ${v.porvCommandOpen ? 'lit' : 'ok'}`}>
          <span className="relief-lamp-name">{t('reactorrelief.porvCmd')}</span>
          <span className="relief-lamp-state">
            {v.porvCommandOpen ? t('reactorrelief.cmdOpen') : t('reactorrelief.cmdShut')}
          </span>
        </div>

        <div className={`relief-lamp ${v.blockValveClosed ? 'warn' : 'ok'}`}>
          <span className="relief-lamp-name">{t('reactorrelief.blockValve')}</span>
          <span className="relief-lamp-state">
            {v.blockValveClosed ? t('reactorrelief.blockShut') : t('reactorrelief.blockOpen')}
          </span>
        </div>

        <div className={`relief-lamp ${v.safetiesOpen > 0 ? 'lit' : 'ok'}`}>
          <span className="relief-lamp-name">{t('reactorrelief.safeties')}</span>
          <div className="relief-sv-dots" aria-label={`${t('reactorrelief.safetyAbbr')} 1-3`}>
            {v.safetyOpen.map((open, i) => (
              <span
                key={i}
                className={`relief-sv-dot${open ? ' open' : ''}`}
                title={`${t('reactorrelief.safetyAbbr')}-${i + 1}`}
              />
            ))}
          </div>
        </div>

        <div className={`relief-lamp ${v.ltopPorvOpen ? 'lit' : v.ltopArmed ? 'warn' : 'ok'}`}>
          <span className="relief-lamp-name">{t('reactorrelief.ltop')}</span>
          <span className="relief-lamp-state">{ltopState}</span>
        </div>

        <div className={`relief-lamp ${v.discharging ? 'lit' : 'ok'}`}>
          <span className="relief-lamp-name">{t('reactorrelief.reliefRate')}</span>
          <span className="relief-lamp-state">{fmt.fmt(v.reliefRateMPaPerS, 2)} MPa/s</span>
        </div>
      </div>

      {/* Engine-supplied PORV status line (En/Zh pair from the module). */}
      <div className="relief-status-line">{pick(v.porvStatusEn, v.porvStatusZh, lang)}</div>
      {v.porvStuckPending && <div className="relief-note">{t('reactorrelief.drillArmed')}</div>}

      <div className="relief-note">{t('reactorrelief.tmiNote')}</div>

      {/* ---- PRT quench tank — the honest symptoms ---- */}
      <div className="relief-prt-title">
        {t('reactorrelief.prtTitle')}
        {' — '}
        {v.ruptureDiscBurst ? (
          <span className="relief-gauge-val danger">{t('reactorrelief.discBurst')}</span>
        ) : v.discharging ? (
          <span className="relief-gauge-val warn">{t('reactorrelief.discharging')}</span>
        ) : (
          <span>{t('reactorrelief.quiet')}</span>
        )}
      </div>

      <div className="relief-gauge-row">
        <span>{t('reactorrelief.prtPress')}</span>
        <span className={`relief-gauge-val${pressTone === 'ok' ? '' : ` ${pressTone}`}`}>
          {fmt.fmt(v.prtPressurePsig, 1)} psig
        </span>
      </div>
      <ReliefBar value={v.prtPressurePsig} max={120} tone={pressTone} ticks={[8, 100]} />

      <div className="relief-gauge-row">
        <span>{t('reactorrelief.prtTemp')}</span>
        <span className={`relief-gauge-val${tempTone === 'ok' ? '' : ` ${tempTone}`}`}>
          {fmt.fmt(v.prtTempC, 1)} °C
        </span>
      </div>
      <ReliefBar value={v.prtTempC} max={200} tone={tempTone} ticks={[60]} />

      <div className="relief-gauge-row">
        <span>{t('reactorrelief.prtLevel')}</span>
        <span className={`relief-gauge-val${levelTone === 'ok' ? '' : ` ${levelTone}`}`}>
          {fmt.fmt(v.prtLevelPct, 1)} %
        </span>
      </div>
      <ReliefBar value={v.prtLevelPct} max={100} tone={levelTone} ticks={[50, 92]} />

      <div className="relief-gauge-row">
        <span>{t('reactorrelief.ruptureDisc')}</span>
        <span className={`relief-gauge-val${v.ruptureDiscBurst ? ' danger' : ''}`}>
          {v.ruptureDiscBurst ? t('reactorrelief.discBurst') : t('reactorrelief.discIntact')}
        </span>
      </div>

      {/* ---- operator actions ---- */}
      <div className="relief-actions">
        {onTriggerStuckPorv && (
          <button
            className="mini danger"
            onClick={onTriggerStuckPorv}
            disabled={v.porvStuckOpen || v.porvStuckPending}
          >
            {t('reactorrelief.drillStuck')}
          </button>
        )}
        {v.blockValveClosed
          ? onOpenBlockValve && (
              <button className="mini" onClick={onOpenBlockValve}>
                {t('reactorrelief.openBlock')}
              </button>
            )
          : onCloseBlockValve && (
              <button className="mini primary" onClick={onCloseBlockValve}>
                {t('reactorrelief.closeBlock')}
              </button>
            )}
      </div>

      {/* ---- annunciators (engine-supplied bilingual parallel arrays) ---- */}
      <div className="relief-alarms">
        {v.alarmsEn.length === 0 ? (
          <span className="relief-no-alarms">{t('reactorrelief.noAlarms')}</span>
        ) : (
          v.alarmsEn.map((en, i) => (
            <span key={en} className="relief-alarm">
              {pick(en, v.alarmsZh[i] ?? en, lang)}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
