import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, allModules, type CatalogModule, type CatalogSection } from '../data/catalog';
import { nonEmptySections } from '../data/catalogHelpers';
import { pick } from '../i18n';
import { ModuleCard } from './ModuleCard';
import { FavoritesRail } from './FavoritesRail';
import { RecentStrip } from './RecentStrip';
import { useLayoutPref } from '../state/prefs';
import { catalogMatches } from '../data/fuzzy';
import '../styles/settings.css';

type Filter = 'all' | 'web' | 'native';

interface Props {
  sectionId: string | null;
  query: string;
  lang: string;
  onOpen: (tag: string) => void;
}

export function ModuleCatalog({ sectionId, query, lang, onOpen }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [viewMode, setViewMode] = useLayoutPref('viewMode');
  const q = query.trim();

  // 'list' opts the shared .card-grid into the single-column list layout
  // defined in settings.css; 'grid' keeps the default multi-column grid.
  const gridClass = viewMode === 'list' ? 'card-grid list' : 'card-grid';

  const passesFilter = (m: CatalogModule) =>
    filter === 'all' || (filter === 'native' ? m.native : !m.native);

  // Search mode: flat result grid across all modules.
  const searchResults = useMemo(() => {
    if (!q) return null;
    return allModules.filter((m) => catalogMatches(m, q) && passesFilter(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter]);

  const sections: CatalogSection[] = useMemo(
    () => (sectionId ? catalog.filter((s) => s.id === sectionId) : nonEmptySections(catalog)),
    [sectionId],
  );

  if (searchResults) {
    return (
      <>
        <div className="page-head">
          <h1>{t('catalog.heading')}</h1>
          <p>{t('catalog.resultsFor', { query: q })}</p>
        </div>
        <FilterChips filter={filter} setFilter={setFilter} viewMode={viewMode} setViewMode={setViewMode} />
        {searchResults.length === 0 ? (
          <p className="count-note">{t('catalog.noResults')}</p>
        ) : (
          <>
            <p className="count-note">{t('catalog.count', { count: searchResults.length })}</p>
            <div className={gridClass}>
              {searchResults.map((m) => (
                <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} />
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  const total = sections.reduce(
    (n, s) =>
      n +
      s.directModules.filter(passesFilter).length +
      s.groups.reduce(
        (k, g) =>
          k +
          g.modules.filter(passesFilter).length +
          (g.subgroups?.reduce((j, sg) => j + sg.modules.filter(passesFilter).length, 0) ?? 0),
        0,
      ),
    0,
  );

  const heading = sectionId
    ? pick(sections[0]?.en ?? '', sections[0]?.zh ?? '', lang)
    : t('catalog.heading');

  return (
    <>
      <div className="page-head">
        <h1>{heading}</h1>
        <p>{t('app.tagline')}</p>
      </div>
      <FilterChips filter={filter} setFilter={setFilter} viewMode={viewMode} setViewMode={setViewMode} />
      <p className="count-note">{t('catalog.count', { count: total })}</p>

      {!sectionId && (
        <>
          <FavoritesRail lang={lang} onOpen={onOpen} />
          <RecentStrip lang={lang} onOpen={onOpen} />
        </>
      )}

      {sections.map((s) => (
        <section key={s.id}>
          {!sectionId && (
            <div className="section-title">
              {pick(s.en, s.zh, lang)}
              <span className="rule" />
            </div>
          )}
          {s.directModules.filter(passesFilter).length > 0 && (
            <div className={gridClass}>
              {s.directModules.filter(passesFilter).map((m) => (
                <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} />
              ))}
            </div>
          )}
          {s.groups.map((g) => {
            const mods = g.modules.filter(passesFilter);
            const subs = (g.subgroups ?? []).map((sg) => ({ sg, mods: sg.modules.filter(passesFilter) }));
            if (mods.length === 0 && subs.every((x) => x.mods.length === 0)) return null;
            return (
              <div key={g.id}>
                <h2 className="group-title">{pick(g.en, g.zh, lang)}</h2>
                {mods.length > 0 && (
                  <div className={gridClass}>
                    {mods.map((m) => (
                      <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} />
                    ))}
                  </div>
                )}
                {subs.map(({ sg, mods: sm }) =>
                  sm.length === 0 ? null : (
                    <div key={sg.id}>
                      <h3 className="group-title" style={{ fontSize: 13.5, opacity: 0.8 }}>
                        {pick(sg.en, sg.zh, lang)}
                      </h3>
                      <div className={gridClass}>
                        {sm.map((m) => (
                          <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} />
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}

function FilterChips({
  filter,
  setFilter,
  viewMode,
  setViewMode,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  viewMode: 'grid' | 'list';
  setViewMode: (v: 'grid' | 'list') => void;
}) {
  const { t } = useTranslation();
  const opts: { key: Filter; label: string }[] = [
    { key: 'all', label: t('catalog.filterAll') },
    { key: 'web', label: t('catalog.filterWeb') },
    { key: 'native', label: t('catalog.filterNative') },
  ];
  return (
    <div className="filters with-view-toggle">
      {opts.map((o) => (
        <button
          key={o.key}
          className={`chip${filter === o.key ? ' active' : ''}`}
          onClick={() => setFilter(o.key)}
        >
          {o.label}
        </button>
      ))}
      <div className="view-toggle" role="group" aria-label={t('shellsettings.viewModeLabel')}>
        <button
          type="button"
          className={`view-toggle-btn glyph${viewMode === 'grid' ? ' active' : ''}`}
          aria-pressed={viewMode === 'grid'}
          title={t('shellsettings.viewModeGrid')}
          aria-label={t('shellsettings.viewModeGrid')}
          onClick={() => setViewMode('grid')}
        >
          ▦
        </button>
        <button
          type="button"
          className={`view-toggle-btn glyph${viewMode === 'list' ? ' active' : ''}`}
          aria-pressed={viewMode === 'list'}
          title={t('shellsettings.viewModeList')}
          aria-label={t('shellsettings.viewModeList')}
          onClick={() => setViewMode('list')}
        >
          ▤
        </button>
      </div>
    </div>
  );
}
