import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { allModules } from '../data/catalog';
import { pick } from '../i18n';
import { clearRecents, useRecents } from '../state/recents';
import '../styles/favorites.css';

interface Props {
  lang: string;
  onOpen: (tag: string) => void;
}

/**
 * Horizontal scrollable strip of recently opened modules (newest first) with a
 * clear control. Renders nothing when there is no history.
 */
export function RecentStrip({ lang, onOpen }: Props) {
  const { t } = useTranslation();
  const recents = useRecents();
  const byTag = useMemo(() => new Map(allModules.map((m) => [m.tag, m])), []);

  const items = recents.map((tag) => byTag.get(tag)).filter((m): m is NonNullable<typeof m> => !!m);
  if (items.length === 0) return null;

  return (
    <div className="rail" aria-label={t('shellnav.recentTitle')}>
      <div className="rail-head">
        <span className="rail-title">{t('shellnav.recentTitle')}</span>
        <button
          type="button"
          className="rail-clear"
          onClick={() => clearRecents()}
          aria-label={t('shellnav.clearAria')}
        >
          {t('shellnav.clear')}
        </button>
      </div>
      <div className="recent-strip">
        {items.map((m) => {
          const name = pick(m.en, m.zh, lang);
          return (
            <button
              key={m.tag}
              type="button"
              className="rail-chip"
              onClick={() => onOpen(m.tag)}
              aria-label={t('shellnav.openAria', { name })}
              title={name}
            >
              <span className="glyph">{m.glyph || '▢'}</span>
              <span className="rail-chip-label">{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
