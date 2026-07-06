import { useTranslation } from 'react-i18next';
import { useThemeMode, type ThemeMode } from '../../state/theme';
import { MSym } from './MSym';
import type { View } from '../../types';

// Material 3 navigation rail (88px, left edge) — design handoff "WinForge
// Material 3.dc.html": menu button (opens the modal drawer), the prominent
// reactor shortcut on a primary-container pill, four rail destinations with
// active-pill states, and the theme toggle at the bottom.

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  onOpenDrawer: () => void;
}

const THEME_ORDER: readonly ThemeMode[] = ['light', 'dark', 'system'];
const THEME_ICON: Record<ThemeMode, string> = {
  light: 'light_mode',
  dark: 'dark_mode',
  system: 'contrast',
};

function ThemeRailButton() {
  const { t } = useTranslation();
  const [mode, setMode] = useThemeMode();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length] ?? 'system';
  const label = t(`shelltheme.${mode}`);
  const nextLabel = t(`shelltheme.${next}`);
  return (
    <button
      type="button"
      className="m3-rail-theme"
      onClick={() => setMode(next)}
      title={t('shelltheme.tooltip', { mode: label })}
      aria-label={t('shelltheme.toggleAria', { mode: label, next: nextLabel })}
    >
      <MSym name={THEME_ICON[mode]} size={22} />
    </button>
  );
}

export function NavRail({ view, onNavigate, onOpenDrawer }: Props) {
  const { t } = useTranslation();

  const destinations: { key: string; icon: string; label: string; on: boolean; go: () => void }[] = [
    {
      key: 'catalog',
      icon: 'grid_view',
      label: t('shellm3.railModules'),
      on: view.kind === 'catalog' && !view.sectionId,
      go: () => onNavigate({ kind: 'catalog', sectionId: null }),
    },
    {
      key: 'simulations',
      icon: 'science',
      label: t('shellm3.railSimulations'),
      on: view.kind === 'catalog' && view.sectionId === 'suite',
      go: () => onNavigate({ kind: 'catalog', sectionId: 'suite' }),
    },
    {
      key: 'reactor',
      icon: 'bolt',
      label: t('shellm3.railReactor'),
      on: view.kind === 'reactor',
      go: () => onNavigate({ kind: 'reactor' }),
    },
    {
      key: 'settings',
      icon: 'settings',
      label: t('shellm3.railSettings'),
      on: view.kind === 'settings',
      go: () => onNavigate({ kind: 'settings' }),
    },
    {
      key: 'about',
      icon: 'info',
      label: t('shellm3.railAbout'),
      on: view.kind === 'about',
      go: () => onNavigate({ kind: 'about' }),
    },
  ];

  return (
    <nav className="m3-rail" aria-label={t('shella11y.primaryNav')}>
      <button
        type="button"
        className="m3-rail-menu"
        onClick={onOpenDrawer}
        aria-label={t('shellm3.menu')}
        title={t('shellm3.menu')}
      >
        <MSym name="menu" size={24} />
      </button>
      <button
        type="button"
        className="m3-rail-fab"
        onClick={() => onNavigate({ kind: 'reactor' })}
        aria-label={t('shellm3.reactorShortcut')}
        title={t('shellm3.reactorShortcut')}
      >
        <MSym name="bolt" size={26} />
      </button>
      {destinations.map((d) => (
        <button
          key={d.key}
          type="button"
          className={`m3-rail-dest${d.on ? ' active' : ''}`}
          onClick={d.go}
          aria-current={d.on ? 'page' : undefined}
        >
          <span className="m3-rail-pill">
            <MSym name={d.icon} size={24} fill={d.on} />
          </span>
          <span className="m3-rail-label">{d.label}</span>
        </button>
      ))}
      <div className="m3-rail-spacer" />
      <ThemeRailButton />
    </nav>
  );
}
