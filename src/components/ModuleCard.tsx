import { useTranslation } from 'react-i18next';
import type { CatalogModule } from '../data/catalog';
import { pick, sub } from '../i18n';
import { moduleStatus } from '../modules/status';
import { MSym, moduleSymbol, STATUS_SYMBOLS } from './m3/MSym';

interface Props {
  module: CatalogModule;
  lang: string;
  onOpen: (tag: string) => void;
  /** Extra classes (e.g. `cv-auto-card` for per-card native virtualization). */
  className?: string;
}

export function ModuleCard({ module, lang, onOpen, className }: Props) {
  const { t } = useTranslation();
  const title = pick(module.en, module.zh, lang);
  const subtitle = sub(module.en, module.zh, lang);
  const status = moduleStatus(module.tag);
  return (
    <button className={className ? `card ${className}` : 'card'} onClick={() => onOpen(module.tag)}>
      <div className="card-top">
        <span className={`card-icon${module.native ? ' native' : ''}`}>
          <MSym name={moduleSymbol(module)} size={22} />
        </span>
        <span className="card-text">
          <div className="card-title">{title}</div>
          {subtitle && subtitle !== title && <div className="card-sub">{subtitle}</div>}
        </span>
      </div>
      <div className="card-badges">
        <span className={`m3-status ${status}`}>
          <MSym name={STATUS_SYMBOLS[status] ?? 'schedule'} size={13} />
          {t(`status.${status}`)}
        </span>
        <span className="m3-type">{module.native ? t('catalog.native') : t('catalog.web')}</span>
      </div>
    </button>
  );
}
