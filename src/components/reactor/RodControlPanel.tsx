// 控制棒面板 · Rod-control panel — MANUAL/AUTO selector, in/hold/out drive switch with the
// 8–72 spm speed program slider, per-bank step readouts (A–D of 228), the 0..528 group-demand
// counter bar, Tref / Tavg−Tref with the deadband lamp, and the rod-motion lamps.
//
// A dumb view over the RodControlView snapshot + operator callbacks: no engine import except
// types, no useReactorSim. Dynamic physics strings (status, withdraw-block reason) arrive
// bilingually on the view; chrome labels come from the `reactorrods` i18n slice.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RodControlMode, RodControlView, RodDirection } from '../../reactor/rodControl';
import type { NumberFmt } from './format';
import '../../styles/reactor-rods.css';

const PAIR = ' · ';

/** Bilingual passthrough for engine-supplied En/Zh string pairs (same policy as FuelCvcsPanel). */
function pickPair(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

export interface RodControlPanelProps {
  v: RodControlView;
  fmt: NumberFmt;
  onSetMode?: (m: RodControlMode) => void;
  onDrive?: (direction: RodDirection, spm?: number) => void;
  onSetDemandTarget?: (steps: number) => void;
}

const BANK_KEYS = ['reactorrods.bankA', 'reactorrods.bankB', 'reactorrods.bankC', 'reactorrods.bankD'] as const;
const TOTAL_SPAN = 528;
const STEPS_PER_BANK = 228;

export function RodControlPanel({ v, fmt, onSetMode, onDrive, onSetDemandTarget }: RodControlPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  // UI-local slider state, seeded from the engine's commanded speed; passed on every drive press.
  const [spm, setSpm] = useState(v.manualSpm);
  const [target, setTarget] = useState(Math.round(v.demandSteps));

  const drive = (dir: RodDirection) => onDrive?.(dir, spm);
  const isAuto = v.mode === 'auto';

  return (
    <section className="panel rods-panel">
      <h2 className="panel-title">{t('reactorrods.title')}</h2>

      {/* ---- mode selector ---- */}
      <div className="rods-mode-row">
        <span>{t('reactorrods.modeLabel')}</span>
        <button
          className={`mini${!isAuto ? ' primary' : ''}`}
          onClick={() => onSetMode?.('manual')}
          aria-pressed={!isAuto}
        >
          {t('reactorrods.modeManual')}
        </button>
        <button
          className={`mini${isAuto ? ' primary' : ''}`}
          onClick={() => onSetMode?.('auto')}
          aria-pressed={isAuto}
        >
          {t('reactorrods.modeAuto')}
        </button>
        <span className={`rods-lamp${v.engaged ? ' lit ok' : ''}`}>{t('reactorrods.engagedLamp')}</span>
      </div>

      {/* ---- manual drive: in / hold / out + speed program slider (8–72 spm) ---- */}
      <div className="rods-drive-row">
        <button className="mini" disabled={isAuto} onClick={() => drive(-1)}>
          {t('reactorrods.driveIn')}
        </button>
        <button className="mini" disabled={isAuto} onClick={() => drive(0)}>
          {t('reactorrods.driveHold')}
        </button>
        <button className="mini" disabled={isAuto} onClick={() => drive(1)}>
          {t('reactorrods.driveOut')}
        </button>
        <input
          type="range"
          min={8}
          max={72}
          step={1}
          value={spm}
          disabled={isAuto}
          aria-label={t('reactorrods.speed')}
          onChange={(e) => setSpm(Number(e.target.value))}
        />
        <span className="rods-spm">
          {t('reactorrods.speed')}: {fmt.fmt(spm, 0)} {t('reactorrods.spm')}
        </span>
      </div>

      {/* ---- demand target slew (manual) ---- */}
      <div className="rods-drive-row">
        <span>{t('reactorrods.demandTarget')}</span>
        <input
          type="number"
          min={0}
          max={TOTAL_SPAN}
          step={1}
          value={target}
          disabled={isAuto}
          onChange={(e) => setTarget(Number(e.target.value))}
        />
        <button
          className="mini"
          disabled={isAuto}
          onClick={() => onSetDemandTarget?.(Math.max(0, Math.min(TOTAL_SPAN, target)))}
        >
          {t('reactorrods.demandGo')}
        </button>
      </div>

      {/* ---- per-bank step readouts ---- */}
      <div className="rods-banks">
        <div className="rods-demand-head">
          <span>{t('reactorrods.banksTitle')}</span>
        </div>
        {v.bankStepsWithdrawn.map((steps, k) => (
          <div className="rods-bank-row" key={BANK_KEYS[k] ?? k}>
            <span>{t(BANK_KEYS[k] ?? 'reactorrods.bankA')}</span>
            <div className="rods-bar">
              <div
                className="rods-bar-fill"
                style={{ width: `${((steps / STEPS_PER_BANK) * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="rods-bank-steps">
              {t('reactorrods.stepsWithdrawn', { n: fmt.fmt(steps, 0) })} / {STEPS_PER_BANK}
            </span>
          </div>
        ))}
      </div>

      {/* ---- group demand counter 0..528 ---- */}
      <div className="rods-demand">
        <div className="rods-demand-head">
          <span>{t('reactorrods.demandCounter')}</span>
          <span className="rods-bank-steps">{t('reactorrods.demandOf', { n: fmt.fmt(v.demandSteps, 1) })}</span>
        </div>
        <div className="rods-bar">
          <div
            className="rods-bar-fill demand"
            style={{ width: `${((v.demandSteps / TOTAL_SPAN) * 100).toFixed(1)}%` }}
          />
        </div>
      </div>

      {/* ---- Tref / Tavg−Tref ---- */}
      <div className="rods-temps">
        <span>
          {t('reactorrods.tref')}: {fmt.fmt(v.trefC, 1)} °C
        </span>
        <span>
          {t('reactorrods.tavgTrefError')}: {v.tavgTrefErrorC >= 0 ? '+' : ''}
          {fmt.fmt(v.tavgTrefErrorC, 2)} °C
        </span>
        <span>
          {v.rodSpeedDemandSpm >= 0 ? '+' : ''}
          {fmt.fmt(v.rodSpeedDemandSpm, 1)} {t('reactorrods.spm')}
        </span>
      </div>

      {/* ---- lamps ---- */}
      <div className="rods-lamps">
        <span className={`rods-lamp${v.inDeadband ? ' lit ok' : ''}`}>{t('reactorrods.deadbandLamp')}</span>
        <span className={`rods-lamp${v.motionDirection > 0 ? ' lit out' : ''}`}>
          {t('reactorrods.steppingOut')}
        </span>
        <span className={`rods-lamp${v.motionDirection < 0 ? ' lit in' : ''}`}>
          {t('reactorrods.steppingIn')}
        </span>
        <span className={`rods-lamp${v.withdrawBlocked ? ' lit warn' : ''}`}>
          {t('reactorrods.withdrawBlockedLamp')}
        </span>
      </div>

      {/* ---- engine-supplied bilingual status / block reason ---- */}
      <div className="rods-status">{pickPair(v.statusEn, v.statusZh, lang)}</div>
      {v.withdrawBlocked && v.withdrawBlockedReasonEn && (
        <div className="rods-status">{pickPair(v.withdrawBlockedReasonEn, v.withdrawBlockedReasonZh, lang)}</div>
      )}
    </section>
  );
}
