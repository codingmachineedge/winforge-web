import { useTranslation } from 'react-i18next';
import { catalog, moduleCount } from '../data/catalog';
import { sectionCount, nonEmptySections } from '../data/catalogHelpers';
import { LANGS, setLang, pick, type LangCode } from '../i18n';
import { ThemeToggle } from './ThemeToggle';
import type { View } from '../types';

interface Props {
  view: View;
  query: string;
  lang: string;
  onNavigate: (v: View) => void;
  onOpenPalette: (seed?: string) => void;
}

export function Sidebar({ view, query, lang, onNavigate, onOpenPalette }: Props) {
  const { t } = useTranslation();
  const activeSection = view.kind === 'catalog' ? view.sectionId : undefined;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="logo glyph">☢</span>
          <span>
            {t('app.title')}
            <small>{t('app.subtitle')}</small>
          </span>
        </div>
        <button className="search-launch" onClick={() => onOpenPalette(query)} aria-label={t('palette.placeholder')}>
          <span className="glyph">⌕</span>
          <span className="search-launch-text">{query.trim() || t('palette.launch')}</span>
          <kbd className="search-kbd">Ctrl K</kbd>
        </button>
      </div>

      <nav className="nav" aria-label={t('shella11y.primaryNav')}>
        <button
          className={`nav-item${view.kind === 'catalog' && !activeSection ? ' active' : ''}`}
          onClick={() => onNavigate({ kind: 'catalog', sectionId: null })}
        >
          <span className="glyph">▤</span>
          {t('nav.allModules')}
          <span className="badge">{moduleCount}</span>
        </button>
        <button
          className={`nav-item${view.kind === 'reactor' ? ' active' : ''}`}
          onClick={() => onNavigate({ kind: 'reactor' })}
        >
          <span className="glyph">★</span>
          {t('nav.reactor')}
        </button>

        <div className="nav-header">{t('nav.sections')}</div>
        {nonEmptySections(catalog).map((s) => {
          const count = sectionCount(s);
          return (
            <button
              key={s.id}
              className={`nav-item${activeSection === s.id ? ' active' : ''}`}
              onClick={() => onNavigate({ kind: 'catalog', sectionId: s.id })}
            >
              <span className="glyph">▦</span>
              {pick(s.en, s.zh, lang)}
              <span className="badge">{count}</span>
            </button>
          );
        })}

        <div className="nav-header">&nbsp;</div>
        <button
          className={`nav-item${view.kind === 'settings' ? ' active' : ''}`}
          onClick={() => onNavigate({ kind: 'settings' })}
        >
          <span className="glyph">⚙</span>
          {t('shellsettings.title')}
        </button>
        <button
          className={`nav-item${view.kind === 'about' ? ' active' : ''}`}
          onClick={() => onNavigate({ kind: 'about' })}
        >
          <span className="glyph">ⓘ</span>
          {t('nav.about')}
        </button>
      </nav>

      <div className="sidebar-foot">
        <ThemeToggle />
        {LANGS.map((l) => (
          <button
            key={l.code}
            className={`lang-btn${lang === l.code ? ' active' : ''}`}
            onClick={() => setLang(l.code as LangCode)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </aside>
  );
}
