import { useTranslation } from 'react-i18next';
import { moduleCount, catalog, allModules, tweakCategoryCount } from '../data/catalog';
import { tweakCount } from '../data/tweaks';
import { MSym } from './m3/MSym';

export function About() {
  const { t } = useTranslation();
  // Real modules only (module.tweaks.* category buckets are excluded from moduleCount).
  const nativeCount = allModules.filter((m) => m.native).length;
  const webCount = moduleCount - nativeCount;
  const totalFeatures = moduleCount + tweakCount;
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
          <dt>Features · 功能</dt>
          <dd>{totalFeatures}</dd>
          <dt>Modules · 模組</dt>
          <dd>{moduleCount}</dd>
          <dt>Windows tweaks · 調校</dt>
          <dd>{tweakCount}</dd>
          <dt>Tweak categories · 分類</dt>
          <dd>{tweakCategoryCount}</dd>
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
