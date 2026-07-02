import { useTranslation } from 'react-i18next';
import { catalog, moduleCount } from '../data/catalog';
import { sectionCount, nonEmptySections } from '../data/catalogHelpers';
import { LANGS, setLang, pick, type LangCode } from '../i18n';
import type { View } from '../types';

interface Props {
  view: View;
  query: string;
  lang: string;
  onQuery: (q: string) => void;
  onNavigate: (v: View) => void;
}

export function Sidebar({ view, query, lang, onQuery, onNavigate }: Props) {
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
        <input
          className="search"
          type="search"
          value={query}
          placeholder={t('nav.search')}
          onChange={(e) => onQuery(e.target.value)}
          aria-label={t('nav.search')}
        />
      </div>

      <nav className="nav">
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
          className={`nav-item${view.kind === 'about' ? ' active' : ''}`}
          onClick={() => onNavigate({ kind: 'about' })}
        >
          <span className="glyph">ⓘ</span>
          {t('nav.about')}
        </button>
      </nav>

      <div className="sidebar-foot">
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
