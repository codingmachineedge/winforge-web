import { useTranslation } from 'react-i18next';
import type { CatalogModule } from '../data/catalog';
import { pick } from '../i18n';

interface Props {
  module: CatalogModule;
  lang: string;
  onOpen: (tag: string) => void;
}

export function ModuleCard({ module, lang, onOpen }: Props) {
  const { t } = useTranslation();
  const title = pick(module.en, module.zh, lang);
  const sub = lang.startsWith('zh') ? module.en : module.zh;
  return (
    <button className="card" onClick={() => onOpen(module.tag)}>
      <div className="card-top">
        <span className="card-icon glyph">{module.glyph || '▢'}</span>
        <span>
          <div className="card-title">{title}</div>
          {sub && sub !== title && <div className="card-sub">{sub}</div>}
        </span>
      </div>
      <span className={`tag-pill ${module.native ? 'native' : 'web'}`}>
        {module.native ? t('catalog.native') : t('catalog.web')}
      </span>
    </button>
  );
}
