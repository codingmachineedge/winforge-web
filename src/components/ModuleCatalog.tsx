import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, allModules, type CatalogModule, type CatalogSection } from '../data/catalog';
import { nonEmptySections } from '../data/catalogHelpers';
import { pick } from '../i18n';
import { ModuleCard } from './ModuleCard';
import { FavoritesRail } from './FavoritesRail';
import { RecentStrip } from './RecentStrip';

type Filter = 'all' | 'web' | 'native';

interface Props {
  sectionId: string | null;
  query: string;
  lang: string;
  onOpen: (tag: string) => void;
}

function matches(m: CatalogModule, q: string): boolean {
  if (!q) return true;
  const hay = `${m.en} ${m.zh} ${m.keywords} ${m.tag}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function ModuleCatalog({ sectionId, query, lang, onOpen }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const q = query.trim();

  const passesFilter = (m: CatalogModule) =>
    filter === 'all' || (filter === 'native' ? m.native : !m.native);

  // Search mode: flat result grid across all modules.
  const searchResults = useMemo(() => {
    if (!q) return null;
    return allModules.filter((m) => matches(m, q) && passesFilter(m));
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
        <FilterChips filter={filter} setFilter={setFilter} />
        {searchResults.length === 0 ? (
          <p className="count-note">{t('catalog.noResults')}</p>
        ) : (
          <>
            <p className="count-note">{t('catalog.count', { count: searchResults.length })}</p>
            <div className="card-grid">
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
      <FilterChips filter={filter} setFilter={setFilter} />
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
            <div className="card-grid">
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
                  <div className="card-grid">
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
                      <div className="card-grid">
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

function FilterChips({ filter, setFilter }: { filter: Filter; setFilter: (f: Filter) => void }) {
  const { t } = useTranslation();
  const opts: { key: Filter; label: string }[] = [
    { key: 'all', label: t('catalog.filterAll') },
    { key: 'web', label: t('catalog.filterWeb') },
    { key: 'native', label: t('catalog.filterNative') },
  ];
  return (
    <div className="filters">
      {opts.map((o) => (
        <button
          key={o.key}
          className={`chip${filter === o.key ? ' active' : ''}`}
          onClick={() => setFilter(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
