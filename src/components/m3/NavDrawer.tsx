import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, moduleCount } from '../../data/catalog';
import { sectionCount, nonEmptySections } from '../../data/catalogHelpers';
import { pick } from '../../i18n';
import { MSym, sectionSymbol } from './MSym';
import type { View } from '../../types';

// Material 3 modal navigation drawer (320px, scrim, slide-in) — design handoff
// "WinForge Material 3.dc.html": app title block, "Sections" list with
// per-section module counts, then Settings / About entries. Escape or a scrim
// click closes it; animations respect prefers-reduced-motion (see m3.css).

interface Props {
  open: boolean;
  view: View;
  lang: string;
  onClose: () => void;
  onNavigate: (v: View) => void;
}

export function NavDrawer({ open, view, lang, onClose, onNavigate }: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog when it opens so Escape/Tab land inside it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const activeSection = view.kind === 'catalog' ? view.sectionId : undefined;
  const go = (v: View) => {
    onNavigate(v);
    onClose();
  };

  return (
    <div className="m3-scrim" onClick={onClose}>
      <div
        ref={panelRef}
        className="m3-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('shellm3.drawerNav')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="m3-drawer-brand">
          <span className="m3-logo">
            <MSym name="radio_button_checked" fill size={22} />
          </span>
          <div>
            <div className="m3-drawer-title">{t('app.title')}</div>
            <div className="m3-drawer-sub">{t('app.subtitle')}</div>
          </div>
        </div>

        <div className="m3-drawer-header">{t('nav.sections')}</div>
        <button
          type="button"
          className={`m3-drawer-item${view.kind === 'catalog' && !activeSection ? ' active' : ''}`}
          onClick={() => go({ kind: 'catalog', sectionId: null })}
        >
          <MSym name="grid_view" size={24} />
          <span className="m3-drawer-text">{t('nav.allModules')}</span>
          <span className="m3-drawer-count">{moduleCount}</span>
        </button>
        {nonEmptySections(catalog).map((s) => (
          <button
            key={s.id}
            type="button"
            className={`m3-drawer-item${activeSection === s.id ? ' active' : ''}`}
            onClick={() => go({ kind: 'catalog', sectionId: s.id })}
          >
            <MSym name={sectionSymbol(s.id)} size={24} />
            <span className="m3-drawer-text">{pick(s.en, s.zh, lang)}</span>
            <span className="m3-drawer-count">{sectionCount(s)}</span>
          </button>
        ))}

        <div className="m3-drawer-divider" />
        <button
          type="button"
          className={`m3-drawer-item${view.kind === 'settings' ? ' active' : ''}`}
          onClick={() => go({ kind: 'settings' })}
        >
          <MSym name="settings" size={24} />
          <span className="m3-drawer-text">{t('shellsettings.title')}</span>
        </button>
        <button
          type="button"
          className={`m3-drawer-item${view.kind === 'about' ? ' active' : ''}`}
          onClick={() => go({ kind: 'about' })}
        >
          <MSym name="info" size={24} />
          <span className="m3-drawer-text">{t('nav.about')}</span>
        </button>
      </div>
    </div>
  );
}
