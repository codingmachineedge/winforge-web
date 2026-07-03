import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './components/Sidebar';
import { ModuleCatalog } from './components/ModuleCatalog';
import { ModuleDetail } from './components/ModuleDetail';
import { ReactorView } from './components/ReactorView';
import { About } from './components/About';
import { CommandPalette } from './components/CommandPalette';
import { allModules } from './data/catalog';
import type { View } from './types';

export function App() {
  const { i18n } = useTranslation();
  const [view, setView] = useState<View>({ kind: 'catalog', sectionId: null });
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSeed, setPaletteSeed] = useState('');
  const lang = i18n.language;

  // When searching, always show the catalog results regardless of the current view.
  const effectiveView: View = query.trim() ? { kind: 'catalog', sectionId: null } : view;

  const moduleByTag = useMemo(() => new Map(allModules.map((m) => [m.tag, m])), []);

  const openPalette = (seed = '') => {
    setPaletteSeed(seed);
    setPaletteOpen(true);
  };

  // Global Ctrl/⌘+K (and "/" when not typing) opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === '/' && !paletteOpen) {
        const el = document.activeElement;
        const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) { e.preventDefault(); openPalette(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  return (
    <div className="shell">
      <Sidebar
        view={effectiveView}
        query={query}
        lang={lang}
        onOpenPalette={openPalette}
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
        {effectiveView.kind === 'reactor' && <ReactorView />}
        {effectiveView.kind === 'about' && <About />}
      </main>

      <CommandPalette
        open={paletteOpen}
        lang={lang}
        initialQuery={paletteSeed}
        onClose={() => setPaletteOpen(false)}
        onOpenModule={(tag) => {
          setQuery('');
          setView({ kind: 'module', tag });
        }}
      />
    </div>
  );
}
