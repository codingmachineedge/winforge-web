import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allModules } from '../data/catalog';
import { pick } from '../i18n';
import { moveFavorite, removeFavorite, useFavorites } from '../state/favorites';
import '../styles/favorites.css';

interface Props {
  lang: string;
  onOpen: (tag: string) => void;
}

/**
 * Compact rail of pinned modules. Each chip opens its module; an inline control
 * unpins it. Chips can be reordered by HTML5 drag-and-drop, persisted via
 * moveFavorite. Renders nothing when there are no favorites.
 */
export function FavoritesRail({ lang, onOpen }: Props) {
  const { t } = useTranslation();
  const favorites = useFavorites();
  const byTag = useMemo(() => new Map(allModules.map((m) => [m.tag, m])), []);
  const [dragTag, setDragTag] = useState<string | null>(null);
  const [overTag, setOverTag] = useState<string | null>(null);

  // Only render tags that resolve to a known module.
  const items = favorites.map((tag) => byTag.get(tag)).filter((m): m is NonNullable<typeof m> => !!m);
  if (items.length === 0) return null;

  const onDrop = (targetTag: string) => {
    if (dragTag && dragTag !== targetTag) {
      moveFavorite(dragTag, favorites.indexOf(targetTag));
    }
    setDragTag(null);
    setOverTag(null);
  };

  return (
    <div className="rail" aria-label={t('shellnav.pinnedTitle')}>
      <div className="rail-head">
        <span className="rail-title">{t('shellnav.pinnedTitle')}</span>
      </div>
      <div className="fav-rail">
        {items.map((m) => {
          const name = pick(m.en, m.zh, lang);
          const isDragging = dragTag === m.tag;
          const isOver = overTag === m.tag && dragTag !== m.tag;
          return (
            <div
              key={m.tag}
              className={`rail-chip fav-chip${isDragging ? ' dragging' : ''}${isOver ? ' drop-target' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragTag(m.tag);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOverTag(m.tag);
              }}
              onDragLeave={() => setOverTag((cur) => (cur === m.tag ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(m.tag);
              }}
              onDragEnd={() => {
                setDragTag(null);
                setOverTag(null);
              }}
            >
              <button
                type="button"
                className="fav-chip-open"
                onClick={() => onOpen(m.tag)}
                aria-label={t('shellnav.openAria', { name })}
                title={name}
              >
                <span className="glyph">{m.glyph || '▢'}</span>
                <span className="rail-chip-label">{name}</span>
              </button>
              <button
                type="button"
                className="fav-unpin"
                onClick={() => removeFavorite(m.tag)}
                aria-label={t('shellnav.unpinAria', { name })}
                title={t('shellnav.unpin')}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
