import { useTranslation } from 'react-i18next';
import { LANGS, setLang, type LangCode } from '../../i18n';
import { MSym } from './MSym';

// Material 3 top app bar — design handoff "WinForge Material 3.dc.html": a
// pill-shaped search field that launches the command palette (Ctrl+K badge)
// and the EN / 粵語 / bilingual language toggle group.

interface Props {
  lang: string;
  onOpenPalette: (seed?: string) => void;
}

export function TopBar({ lang, onOpenPalette }: Props) {
  const { t } = useTranslation();
  return (
    <div className="m3-topbar">
      <button
        type="button"
        className="m3-search-launch"
        onClick={() => onOpenPalette()}
        aria-label={t('palette.placeholder')}
      >
        <MSym name="search" size={22} />
        <span className="m3-search-launch-text">{t('palette.launch')}</span>
        <span className="m3-kbd">Ctrl K</span>
      </button>
      <div className="m3-lang-group" role="group" aria-label={t('nav.language')}>
        {LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            className={`m3-lang-btn${lang === l.code ? ' active' : ''}`}
            aria-pressed={lang === l.code}
            onClick={() => setLang(l.code as LangCode)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
