import { useTranslation } from 'react-i18next';
import { useThemeMode, type ThemeMode } from '../state/theme';
import '../styles/theme-toggle.css';

// Compact cycling control for the titlebar / sidebar. One click advances
// Light → Dark → System → Light. Uses the repo's `.glyph` font pattern for the
// per-mode icon and pulls all copy from the `shelltheme` i18n namespace.

const ORDER: readonly ThemeMode[] = ['light', 'dark', 'system'];

// Segoe Fluent / MDL2 glyphs, with a safe unicode fallback baked into the font
// stack via `.glyph`. Sun / Moon / Auto-brightness.
const GLYPH: Record<ThemeMode, string> = {
  light: '\u{1F506}', // 🔆 bright
  dark: '\u{1F319}', //  🌙 moon
  system: '\u{1F5A5}', // 🖥 desktop
};

const nextMode = (mode: ThemeMode): ThemeMode => {
  const i = ORDER.indexOf(mode);
  return ORDER[(i + 1) % ORDER.length] ?? 'system';
};

export function ThemeToggle() {
  const { t } = useTranslation();
  const [mode, setMode] = useThemeMode();
  const next = nextMode(mode);

  const label = t(`shelltheme.${mode}`);
  const nextLabel = t(`shelltheme.${next}`);
  const shortLabel = t(`shelltheme.${mode}Short`);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setMode(next)}
      title={t('shelltheme.tooltip', { mode: label })}
      aria-label={t('shelltheme.toggleAria', { mode: label, next: nextLabel })}
    >
      <span className="glyph theme-toggle-glyph" aria-hidden="true">
        {GLYPH[mode]}
      </span>
      <span className="theme-toggle-label">{shortLabel}</span>
    </button>
  );
}
