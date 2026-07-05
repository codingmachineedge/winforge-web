import { useTranslation } from 'react-i18next';
import { moduleCount, catalog, allModules } from '../data/catalog';
import { MSym } from './m3/MSym';

export function About() {
  const { t } = useTranslation();
  const nativeCount = allModules.filter((m) => m.native).length;
  const webCount = moduleCount - nativeCount;
  return (
    <div className="detail">
      <div className="page-head">
        <h1>{t('about.title')}</h1>
      </div>
      <div className="about-card">
        <div className="about-brand">
          <span className="about-logo">
            <MSym name="radio_button_checked" fill size={30} />
          </span>
          <div>
            <div className="about-name">{t('app.title')}</div>
            <div className="about-sub">{t('app.subtitle')}</div>
          </div>
        </div>
        <p className="about-body">{t('about.body')}</p>
        <dl className="kv">
          <dt>Modules</dt>
          <dd>{moduleCount}</dd>
          <dt>Sections</dt>
          <dd>{catalog.length}</dd>
          <dt>Web-capable</dt>
          <dd>{webCount}</dd>
          <dt>Native-only stubs</dt>
          <dd>{nativeCount}</dd>
        </dl>
        <p className="about-source">{t('about.source')}</p>
      </div>
    </div>
  );
}
