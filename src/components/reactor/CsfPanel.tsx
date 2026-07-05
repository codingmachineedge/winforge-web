// 關鍵安全功能狀態板 · Critical Safety Function status-tree board (F-0) — the classic six-tile
// CSF wall display: one tile per function in S,C,H,P,Z,I priority order, colour-filled by status
// (grey Invalid / Green / Yellow / Orange / Red), showing mnemonic + name + entry FRG + condition.
// A RED tile pulses (CSS animation, suppressed under prefers-reduced-motion).
//
// Dumb view over the CsfEvaluator View snapshot — no engine import except types. Tree names and
// condition text arrive bilingually from the engine (nameEn/nameZh, conditionEn/conditionZh);
// chrome labels come from the `reactorcsf` i18n slice.

import { useTranslation } from 'react-i18next';
import type { NumberFmt } from './format';
import type { CsfStateView, CsfStatusLevel, CsfTreesView } from '../../reactor/csfTrees';
import '../../styles/reactor-csf.css';

export interface CsfPanelProps {
  v: CsfTreesView;
  fmt: NumberFmt;
}

const PAIR = ' · ';

/** Bilingual passthrough for engine-supplied strings (same policy as FuelCvcsPanel). */
function pick(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

/** i18n key suffix per status colour. */
const STATUS_KEY: Record<CsfStatusLevel, string> = {
  invalid: 'reactorcsf.statusInvalid',
  green: 'reactorcsf.statusGreen',
  yellow: 'reactorcsf.statusYellow',
  orange: 'reactorcsf.statusOrange',
  red: 'reactorcsf.statusRed',
};

function CsfTile({ c, lang, statusLabel }: { c: CsfStateView; lang: string; statusLabel: string }) {
  return (
    <div
      className={`csf-tile csf-${c.status}`}
      role="status"
      aria-label={`${c.mnemonic} ${c.nameEn}: ${statusLabel}`}
    >
      <div className="csf-tile-head">
        <span className="csf-mnemonic">{c.mnemonic}</span>
        <span className="csf-name">{pick(c.nameEn, c.nameZh, lang)}</span>
      </div>
      <div className="csf-status-line">
        <span>{statusLabel}</span>
        <span className="csf-fr">{c.frId}</span>
      </div>
      <div className="csf-condition">{pick(c.conditionEn, c.conditionZh, lang)}</div>
    </div>
  );
}

export function CsfPanel({ v }: CsfPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  return (
    <section className="panel csf-panel">
      <h2 className="panel-title">
        {t('reactorcsf.title')} <span className="csf-fr">{t('reactorcsf.subtitle')}</span>
      </h2>

      <div className="csf-board">
        {v.csf.map((c) => (
          <CsfTile key={c.mnemonic} c={c} lang={lang} statusLabel={t(STATUS_KEY[c.status])} />
        ))}
      </div>

      <div className="csf-summary">
        <span className={`csf-summary-dot csf-${v.worstStatus}`} aria-hidden="true" />
        <span>
          {t('reactorcsf.worstLabel')}: {t(STATUS_KEY[v.worstStatus])}
        </span>
        {v.highestPriorityMnemonic !== null && v.highestPriorityFrId !== null && (
          <span className="csf-summary-alarm">
            {t('reactorcsf.challengeAlarm')} — {v.highestPriorityMnemonic} → {t('reactorcsf.frLabel')}{' '}
            {v.highestPriorityFrId}
          </span>
        )}
      </div>
    </section>
  );
}
