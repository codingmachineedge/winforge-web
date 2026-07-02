import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { catalog, type CatalogModule } from '../data/catalog';
import { pick } from '../i18n';

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

  if (!module) {
    return (
      <div className="detail">
        <button className="back" onClick={onBack}>
          ← {t('detail.back')}
        </button>
        <p>{t('catalog.noResults')}</p>
      </div>
    );
  }

  const isReactor = module.tag === 'module.reactor';
  const title = pick(module.en, module.zh, lang);
  const sub = lang.startsWith('zh') ? module.en : module.zh;

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← {t('detail.back')}
      </button>

      <div className="detail-head">
        <span className="detail-icon glyph">{module.glyph || '▢'}</span>
        <div>
          <h1>{title}</h1>
          {sub && sub !== title && <div className="zh">{sub}</div>}
        </div>
      </div>

      <div className={`panel ${module.native ? 'native' : 'web'}`}>
        <h3>{module.native ? t('detail.nativeTitle') : t('detail.webTitle')}</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          {module.native ? t('detail.nativeBody') : t('detail.webBody')}
        </p>
        {isReactor && (
          <p style={{ marginBottom: 0 }}>
            <button className="btn" onClick={onOpenReactor}>
              ★ {t('detail.openReactor')}
            </button>
          </p>
        )}
      </div>

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
    </div>
  );
}
