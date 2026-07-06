import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavRail } from './components/m3/NavRail';
import { NavDrawer } from './components/m3/NavDrawer';
import { TopBar } from './components/m3/TopBar';
import { ModuleCatalog } from './components/ModuleCatalog';
import { CommandPalette } from './components/CommandPalette';
import { ToastHost } from './components/ToastHost';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsView } from './components/SettingsView';
import { allModules } from './data/catalog';
import { pushRecent } from './state/recents';
import { useApplyLayoutPrefs } from './state/applyPrefs';
import { initDeepLinks } from './state/deepLink';
import { onModuleOpenRequest, onPaletteOpenRequest } from './state/navBus';
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
  useApplyLayoutPrefs();
  const [view, setView] = useState<View>(() => {
    // Shareable URL params (also used by tools/capture-screens.mjs): ?view=reactor|settings|about
    // opens a shell view directly; ?module=<tag> opens a module detail; ?section=<id> opens a
    // catalog section (e.g. ?section=suite → the Simulations tab). State-only — the app does not
    // rewrite the URL afterwards.
    const q = new URLSearchParams(window.location.search);
    const v = q.get('view');
    if (v === 'reactor') return { kind: 'reactor' };
    if (v === 'settings') return { kind: 'settings' };
    if (v === 'about') return { kind: 'about' };
    const tag = q.get('module');
    if (tag) return { kind: 'module', tag };
    const section = q.get('section');
    if (section) return { kind: 'catalog', sectionId: section };
    return { kind: 'catalog', sectionId: null };
  });
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSeed, setPaletteSeed] = useState('');
  const lang = i18n.language;

  // When searching, always show the catalog results regardless of the current view.
  const effectiveView: View = query.trim() ? { kind: 'catalog', sectionId: null } : view;
  const isReactor = effectiveView.kind === 'reactor';

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

  const navigate = (v: View) => {
    setQuery('');
    setView(v);
  };

  // Nav bus: modules (e.g. the Dashboard tiles) ask the shell to navigate.
  useEffect(() => {
    const offModule = onModuleOpenRequest((tag) => {
      if (moduleByTag.has(tag)) openModule(tag);
    });
    const offPalette = onPaletteOpenRequest((seed) => openPalette(seed));
    return () => {
      offModule();
      offPalette();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // winforge://module/<tag> deep links (Tauri only; no-op in the browser).
  // Links may carry the bare tag or the module.-prefixed form — resolve both.
  useEffect(() => {
    void initDeepLinks((tag) => {
      const resolved = moduleByTag.has(tag)
        ? tag
        : moduleByTag.has(`module.${tag}`)
          ? `module.${tag}`
          : tag.startsWith('module.') && moduleByTag.has(tag.slice('module.'.length))
            ? tag.slice('module.'.length)
            : null;
      if (resolved) openModule(resolved);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global Ctrl/⌘+K (and "/" when not typing) opens the command palette;
  // Escape closes the navigation drawer when nothing else claims it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape' && drawerOpen && !paletteOpen) {
        setDrawerOpen(false);
      } else if (e.key === '/' && !paletteOpen) {
        const el = document.activeElement;
        const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) { e.preventDefault(); openPalette(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, drawerOpen]);

  return (
    <div className="m3-shell">
      <a href="#main-content" className="skip-link">
        {t('shella11y.skipToMain')}
      </a>

      <NavRail view={effectiveView} onNavigate={navigate} onOpenDrawer={() => setDrawerOpen(true)} />
      <NavDrawer
        open={drawerOpen}
        view={effectiveView}
        lang={lang}
        onClose={() => setDrawerOpen(false)}
        onNavigate={navigate}
      />

      <main className="m3-content" id="main-content" tabIndex={-1}>
        {/* The reactor Control Room is a self-contained dark console rendered
            full-bleed — no top bar, no page padding. Everything else gets the
            M3 top app bar + padded page column. */}
        {!isReactor && <TopBar lang={lang} onOpenPalette={openPalette} />}
        {isReactor ? (
          <Suspense fallback={<div className="route-fallback">{t('shella11y.loading')}</div>}>
            <ErrorBoundary label="Reactor" onReset={() => navigate({ kind: 'catalog', sectionId: null })}>
              <ReactorView />
            </ErrorBoundary>
          </Suspense>
        ) : (
          <div className="m3-page">
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
                  onReset={() => navigate({ kind: 'catalog', sectionId: null })}
                >
                  <ModuleDetail
                    module={moduleByTag.get(effectiveView.tag) ?? null}
                    lang={lang}
                    onBack={() => navigate({ kind: 'catalog', sectionId: null })}
                    onOpenReactor={() => navigate({ kind: 'reactor' })}
                  />
                </ErrorBoundary>
              )}
              {effectiveView.kind === 'about' && <About />}
            </Suspense>
            {effectiveView.kind === 'settings' && <SettingsView />}
          </div>
        )}
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
