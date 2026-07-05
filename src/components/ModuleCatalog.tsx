import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, allModules, type CatalogModule, type CatalogSection } from '../data/catalog';
import { nonEmptySections } from '../data/catalogHelpers';
import { pick } from '../i18n';
import { ModuleCard } from './ModuleCard';
import { FavoritesRail } from './FavoritesRail';
import { RecentStrip } from './RecentStrip';
import { useLayoutPref } from '../state/prefs';
import { catalogMatches } from '../data/fuzzy';
import { useRovingGrid } from '../state/rovingGrid';
import { MSym, sectionSymbol } from './m3/MSym';
import '../styles/settings.css';
import '../styles/catalog-perf.css';

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

  // One roving-tabindex scope covers every visible ModuleCard (across all
  // section/group/subgroup grids, or the flat search grid). The hook queries
  // `.card` descendants of this container, so a single ref on a wrapper around
  // the whole catalog body is the simplest correct scope. Arrow keys move
  // focus by row/column (columns measured from live geometry), Home/End jump
  // to row start/end, Enter/Space use native button behavior.
  const rovingRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useRovingGrid(rovingRef);

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
            <div ref={rovingRef} onKeyDown={onKeyDown} className="catalog-roving">
              <div className={gridClass}>
                {searchResults.map((m) => (
                  <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} className="cv-auto-card" />
                ))}
              </div>
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

      <div ref={rovingRef} onKeyDown={onKeyDown} className="catalog-roving">
        {sections.map((s) => (
          <section key={s.id} className="cv-auto-section">
            {!sectionId && (
              <div className="section-title">
                <span className="section-icon">
                  <MSym name={sectionSymbol(s.id)} size={18} />
                </span>
                {pick(s.en, s.zh, lang)}
                <span className="rule" />
              </div>
            )}
            {s.directModules.filter(passesFilter).length > 0 && (
              <div className="cv-auto-group">
                <div className={gridClass}>
                  {s.directModules.filter(passesFilter).map((m) => (
                    <ModuleCard key={m.tag} module={m} lang={lang} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            )}
            {s.groups.map((g) => {
              const mods = g.modules.filter(passesFilter);
              const subs = (g.subgroups ?? []).map((sg) => ({ sg, mods: sg.modules.filter(passesFilter) }));
              if (mods.length === 0 && subs.every((x) => x.mods.length === 0)) return null;
              return (
                <div key={g.id} className="cv-auto-group">
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
                      <div key={sg.id} className="cv-auto-group">
                        <h3 className="group-title subgroup">{pick(sg.en, sg.zh, lang)}</h3>
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
      </div>
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
          {filter === o.key && <MSym name="check" size={18} />}
          {o.label}
        </button>
      ))}
      <div className="view-toggle" role="group" aria-label={t('shellsettings.viewModeLabel')}>
        <button
          type="button"
          className={`view-toggle-btn${viewMode === 'grid' ? ' active' : ''}`}
          aria-pressed={viewMode === 'grid'}
          title={t('shellsettings.viewModeGrid')}
          aria-label={t('shellsettings.viewModeGrid')}
          onClick={() => setViewMode('grid')}
        >
          <MSym name="grid_view" size={20} />
        </button>
        <button
          type="button"
          className={`view-toggle-btn${viewMode === 'list' ? ' active' : ''}`}
          aria-pressed={viewMode === 'list'}
          title={t('shellsettings.viewModeList')}
          aria-label={t('shellsettings.viewModeList')}
          onClick={() => setViewMode('list')}
        >
          <MSym name="view_agenda" size={20} />
        </button>
      </div>
    </div>
  );
}
