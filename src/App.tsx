import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './components/Sidebar';
import { ModuleCatalog } from './components/ModuleCatalog';
import { CommandPalette } from './components/CommandPalette';
import { ToastHost } from './components/ToastHost';
import { ErrorBoundary } from './components/ErrorBoundary';
import { allModules } from './data/catalog';
import { pushRecent } from './state/recents';
import type { View } from './types';

// Route-level code splitting: the module-detail registry, the reactor simulator,
// and the About page are pulled into separate chunks so the initial bundle only
// ships the catalog + shell. These use named exports, so map them to `default`.
const ModuleDetail = lazy(() =>
  import('./components/ModuleDetail').then((m) => ({ default: m.ModuleDetail })),
);
const ReactorView = lazy(() =>
  import('./components/ReactorView').then((m) => ({ default: m.ReactorView })),
);
const About = lazy(() => import('./components/About').then((m) => ({ default: m.About })));

export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<View>({ kind: 'catalog', sectionId: null });
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSeed, setPaletteSeed] = useState('');
  const lang = i18n.language;

  // When searching, always show the catalog results regardless of the current view.
  const effectiveView: View = query.trim() ? { kind: 'catalog', sectionId: null } : view;

  const moduleByTag = useMemo(() => new Map(allModules.map((m) => [m.tag, m])), []);

  // Single entry point for opening a module — records it in the recents LRU so
  // cards, palette, favorites rail and recent strip all feed the same history.
  const openModule = (tag: string) => {
    pushRecent(tag);
    setQuery('');
    setView({ kind: 'module', tag });
  };

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
      <a href="#main-content" className="skip-link">
        {t('shella11y.skipToMain')}
      </a>
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
      <main className="content" id="main-content" tabIndex={-1}>
        {effectiveView.kind === 'catalog' && (
          <ModuleCatalog
            sectionId={effectiveView.sectionId}
            query={query}
            lang={lang}
            onOpen={openModule}
          />
        )}
        <Suspense fallback={<div className="route-fallback">{t('shella11y.loading')}</div>}>
          {effectiveView.kind === 'module' && (
            <ErrorBoundary
              label={moduleByTag.get(effectiveView.tag)?.en}
              onReset={() => setView({ kind: 'catalog', sectionId: null })}
            >
              <ModuleDetail
                module={moduleByTag.get(effectiveView.tag) ?? null}
                lang={lang}
                onBack={() => setView({ kind: 'catalog', sectionId: null })}
                onOpenReactor={() => setView({ kind: 'reactor' })}
              />
            </ErrorBoundary>
          )}
          {effectiveView.kind === 'reactor' && (
            <ErrorBoundary label="Reactor" onReset={() => setView({ kind: 'catalog', sectionId: null })}>
              <ReactorView />
            </ErrorBoundary>
          )}
          {effectiveView.kind === 'about' && <About />}
        </Suspense>
      </main>

      <CommandPalette
        open={paletteOpen}
        lang={lang}
        initialQuery={paletteSeed}
        onClose={() => setPaletteOpen(false)}
        onOpenModule={openModule}
      />

      <ToastHost />
    </div>
  );
}
