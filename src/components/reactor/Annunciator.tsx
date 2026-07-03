// 報警窗盤 · Control-room annunciator panel.
//
// A grid of alarm tiles driven by the engine's active-alarm list (state.alarms / state.alarmsZh).
// Latching + flashing behavior lives in the pure ./annunciator helper; this component only wires
// the engine's per-tick active-set into that reducer, renders tiles, and offers an ACK button.
//
// Keys are the ENGLISH alarm strings (stable identifiers from the engine). The visible label is
// chosen for the active language (English, 粵語, or bilingual "EN · 粵").

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  reduceLatches,
  acknowledgeAll,
  acknowledgeOne,
  tileState,
  flashingCount,
  type LatchMap,
} from './annunciatorLatch';

export interface AnnunciatorProps {
  /** Engine active-alarm strings (English) — the stable tile keys. */
  alarms: string[];
  /** Engine active-alarm strings (粵語/Traditional Chinese), index-aligned with `alarms`. */
  alarmsZh: string[];
}

const PAIR = ' · ';

/** Pick the display label for an alarm given the active language. */
function alarmLabel(en: string, zh: string | undefined, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

export function Annunciator({ alarms, alarmsZh }: AnnunciatorProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const [latches, setLatches] = useState<LatchMap>({});

  // Keep an EN→ZH lookup so latched (cleared) tiles can still show their 粵語 label after the
  // engine drops them from the active list.
  const zhByEn = useRef<Map<string, string>>(new Map());
  alarms.forEach((en, i) => {
    const zh = alarmsZh[i];
    if (zh) zhByEn.current.set(en, zh);
  });

  // Fold the current active set into the latch map whenever the engine's alarm list changes.
  const activeKey = alarms.join('');
  useEffect(() => {
    setLatches((prev) => reduceLatches(prev, alarms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const keys = Object.keys(latches);
  const flashing = flashingCount(latches);
  const hasAny = keys.length > 0;

  return (
    <section className="panel annunciator-panel">
      <div className="annunciator-head">
        <h2 className="panel-title">{t('reactorui.annunciatorTitle')}</h2>
        <div className="annunciator-head-right">
          <span className={`annunciator-count${flashing > 0 ? ' flashing' : ''}`}>
            {flashing > 0 ? t('reactorui.alarmsActive', { count: flashing }) : t('reactorui.allClear')}
          </span>
          <button
            type="button"
            className="btn secondary annunciator-ack"
            disabled={!hasAny}
            onClick={() => setLatches((prev) => acknowledgeAll(prev))}
          >
            {t('reactorui.ackAll')}
          </button>
        </div>
      </div>

      <div className="annunciator-grid">
        {!hasAny && <div className="annunciator-empty">{t('reactorui.allClear')}</div>}
        {keys.map((en) => {
          const s = tileState(latches[en]);
          const zh = zhByEn.current.get(en);
          return (
            <button
              type="button"
              key={en}
              className={`annunciator-tile tile-${s}`}
              onClick={() => setLatches((prev) => acknowledgeOne(prev, en))}
              title={t('reactorui.ack')}
            >
              {alarmLabel(en, zh, lang)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
