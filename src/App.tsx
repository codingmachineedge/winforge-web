import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './components/Sidebar';
import { ModuleCatalog } from './components/ModuleCatalog';
import { ModuleDetail } from './components/ModuleDetail';
import { ReactorStub } from './components/ReactorStub';
import { About } from './components/About';
import { allModules } from './data/catalog';
import type { View } from './types';

export function App() {
  const { i18n } = useTranslation();
  const [view, setView] = useState<View>({ kind: 'catalog', sectionId: null });
  const [query, setQuery] = useState('');
  const lang = i18n.language;

  // When searching, always show the catalog results regardless of the current view.
  const effectiveView: View = query.trim() ? { kind: 'catalog', sectionId: null } : view;

  const moduleByTag = useMemo(() => {
    const map = new Map(allModules.map((m) => [m.tag, m]));
    return map;
  }, []);

  return (
    <div className="shell">
      <Sidebar
        view={effectiveView}
        query={query}
        lang={lang}
        onQuery={setQuery}
        onNavigate={(v) => {
          setQuery('');
          setView(v);
        }}
      />
      <main className="content">
        {effectiveView.kind === 'catalog' && (
          <ModuleCatalog
            sectionId={effectiveView.sectionId}
            query={query}
            lang={lang}
            onOpen={(tag) => {
              // Clear the search so effectiveView stops forcing the catalog and the
              // module detail actually shows (fixes: clicking a search result did nothing).
              setQuery('');
              setView({ kind: 'module', tag });
            }}
          />
        )}
        {effectiveView.kind === 'module' && (
          <ModuleDetail
            module={moduleByTag.get(effectiveView.tag) ?? null}
            lang={lang}
            onBack={() => setView({ kind: 'catalog', sectionId: null })}
            onOpenReactor={() => setView({ kind: 'reactor' })}
          />
        )}
        {effectiveView.kind === 'reactor' && <ReactorStub />}
        {effectiveView.kind === 'about' && <About />}
      </main>
    </div>
  );
}
