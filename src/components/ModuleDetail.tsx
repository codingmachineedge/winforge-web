import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, type CatalogModule } from '../data/catalog';
import { pick, sub } from '../i18n';
import { registerModuleStrings } from '../i18n/moduleStrings';
import { isTauri } from '../tauri/bridge';
import { actionFor } from '../tauri/nativeActions';
import { realModuleFor } from '../modules/registry';
import { toggleFavorite, useFavorites } from '../state/favorites';
import { MSym, moduleSymbol } from './m3/MSym';

// This module is only reached through the lazy ModuleDetail route chunk. Registering
// the per-module i18n strings here (at chunk-eval time, before any component renders)
// keeps that ~570 kB out of the eager bundle while guaranteeing t('<module>.…')
// resolves synchronously the moment a module renders. addResourceBundle is sync.
registerModuleStrings();

interface Props {
  module: CatalogModule | null;
  lang: string;
  onBack: () => void;
  onOpenReactor: () => void;
}

interface Location {
  sectionEn: string;
  sectionZh: string;
  groupEn?: string;
  groupZh?: string;
}

function locate(tag: string): Location | null {
  for (const s of catalog) {
    if (s.directModules.some((m) => m.tag === tag)) return { sectionEn: s.en, sectionZh: s.zh };
    for (const g of s.groups) {
      if (g.modules.some((m) => m.tag === tag))
        return { sectionEn: s.en, sectionZh: s.zh, groupEn: g.en, groupZh: g.zh };
      for (const sg of g.subgroups ?? []) {
        if (sg.modules.some((m) => m.tag === tag))
          return { sectionEn: s.en, sectionZh: s.zh, groupEn: sg.en, groupZh: sg.zh };
      }
    }
  }
  return null;
}

export function ModuleDetail({ module, lang, onBack, onOpenReactor }: Props) {
  const { t } = useTranslation();
  const loc = useMemo(() => (module ? locate(module.tag) : null), [module]);
  const favorites = useFavorites();
  const pinned = module ? favorites.includes(module.tag) : false;

  if (!module) {
    return (
      <div className="detail">
        <button className="back" onClick={onBack}>
          <MSym name="arrow_back" size={20} />
          {t('detail.back')}
        </button>
        <p>{t('catalog.noResults')}</p>
      </div>
    );
  }

  const isReactor = module.tag === 'module.reactor';
  const title = pick(module.en, module.zh, lang);
  const subtitle = sub(module.en, module.zh, lang);
  const RealModule = realModuleFor(module.tag);
  const inDesktop = isTauri();

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        <MSym name="arrow_back" size={20} />
        {t('detail.back')}
      </button>

      <div className="detail-head">
        <span className={`detail-icon${module.native ? ' native' : ''}`}>
          <MSym name={moduleSymbol(module)} size={38} />
        </span>
        <div>
          <h1>{title}</h1>
          {subtitle && subtitle !== title && <div className="zh">{subtitle}</div>}
        </div>
        <button
          className={`pin-toggle${pinned ? ' pinned' : ''}`}
          onClick={() => toggleFavorite(module.tag)}
          title={t(pinned ? 'shellnav.unpinAria' : 'shellnav.pinAria', { name: title })}
          aria-label={t(pinned ? 'shellnav.unpinAria' : 'shellnav.pinAria', { name: title })}
          aria-pressed={pinned}
        >
          <MSym name="push_pin" size={22} fill={pinned} />
        </button>
      </div>

      {RealModule && (inDesktop || !module.native) ? (
        <div className="panel live">
          <h3>
            <MSym name="radio_button_checked" fill size={18} />
            {t('detail.liveTitle')}
          </h3>
          <RealModule />
        </div>
      ) : RealModule && !inDesktop ? (
        <div className="panel native">
          <h3>{t('detail.liveTitle')}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('detail.liveBrowser')}</p>
        </div>
      ) : (
        <div className={`panel ${module.native ? 'native' : 'web'}`}>
          <h3>
            <MSym name={module.native ? 'memory' : 'web'} size={22} />
            {module.native ? t('detail.nativeTitle') : t('detail.webTitle')}
          </h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {module.native ? t('detail.nativeBody') : t('detail.webBody')}
          </p>
          {isReactor && (
            <p style={{ marginBottom: 0 }}>
              <button className="btn" onClick={onOpenReactor}>
                <MSym name="bolt" size={20} />
                {t('detail.openReactor')}
              </button>
            </p>
          )}
        </div>
      )}

      <div className="panel">
        <dl className="kv">
          <dt>{t('detail.tag')}</dt>
          <dd>
            <code>{module.tag}</code>
          </dd>
          <dt>{t('detail.section')}</dt>
          <dd>{loc ? pick(loc.sectionEn, loc.sectionZh, lang) : '—'}</dd>
          {loc?.groupEn && (
            <>
              <dt>{t('detail.group')}</dt>
              <dd>{pick(loc.groupEn, loc.groupZh ?? '', lang)}</dd>
            </>
          )}
          <dt>{t('detail.keywords')}</dt>
          <dd style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>{module.keywords || '—'}</dd>
        </dl>
      </div>

      {!RealModule && <NativeActionPanel tag={module.tag} lang={lang} />}
    </div>
  );
}

function NativeActionPanel({ tag, lang }: { tag: string; lang: string }) {
  const { t } = useTranslation();
  const action = actionFor(tag);
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!action) return null;

  const label = pick(action.labelEn, action.labelZh, lang);
  const inDesktop = isTauri();

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setOutput(await action.run());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel web">
      <h3>
        <MSym name="bolt" size={20} />
        {t('detail.backendTitle')}
      </h3>
      {inDesktop ? (
        <>
          <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>{t('detail.backendBody')}</p>
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? t('detail.running') : `▶ ${label}`}
          </button>
          {error && <pre className="cmd-out error">{error}</pre>}
          {output !== null && <pre className="cmd-out">{output}</pre>}
        </>
      ) : (
        <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>
          {t('detail.backendBrowser', { label })}
        </p>
      )}
    </div>
  );
}
