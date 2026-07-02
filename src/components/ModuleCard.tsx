import { useTranslation } from 'react-i18next';
import type { CatalogModule } from '../data/catalog';
import { pick, sub } from '../i18n';
import { moduleStatus } from '../modules/status';

interface Props {
  module: CatalogModule;
  lang: string;
  onOpen: (tag: string) => void;
}

export function ModuleCard({ module, lang, onOpen }: Props) {
  const { t } = useTranslation();
  const title = pick(module.en, module.zh, lang);
  const subtitle = sub(module.en, module.zh, lang);
  const status = moduleStatus(module.tag);
  return (
    <button className="card" onClick={() => onOpen(module.tag)}>
      <div className="card-top">
        <span className="card-icon glyph">{module.glyph || '▢'}</span>
        <span>
          <div className="card-title">{title}</div>
          {subtitle && subtitle !== title && <div className="card-sub">{subtitle}</div>}
        </span>
      </div>
      <div className="card-badges">
        <span className={`status-pill ${status}`}>{t(`status.${status}`)}</span>
        <span className={`tag-pill ${module.native ? 'native' : 'web'}`}>
          {module.native ? t('catalog.native') : t('catalog.web')}
        </span>
      </div>
    </button>
  );
}
