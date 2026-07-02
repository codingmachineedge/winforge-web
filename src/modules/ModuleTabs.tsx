import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

export interface ModuleTab {
  id: string;
  en: string;
  zh: string;
  render: () => ReactNode;
}

/**
 * Internal sub-tab navigation for a module — mirrors WinForge modules that use a
 * TabView/Pivot/SelectorBar (e.g. Docker: Containers/Images/Volumes/Networks/Compose).
 * This is the reusable slot system so every ported module has a home for its sub-views.
 */
export function ModuleTabs({ tabs, initial }: { tabs: ModuleTab[]; initial?: string }) {
  const { i18n } = useTranslation();
  const [active, setActive] = useState(initial ?? tabs[0]?.id ?? '');
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div className="mod-tabs">
      <div className="mod-tabbar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`mod-tab${t.id === active ? ' active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            {pick(t.en, t.zh, i18n.language)}
          </button>
        ))}
      </div>
      <div className="mod-tabpanel" role="tabpanel">
        {current?.render()}
      </div>
    </div>
  );
}
