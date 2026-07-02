import { useTranslation } from 'react-i18next';
import { moduleCount, catalog, allModules } from '../data/catalog';

export function About() {
  const { t } = useTranslation();
  const nativeCount = allModules.filter((m) => m.native).length;
  const webCount = moduleCount - nativeCount;
  return (
    <div className="detail">
      <div className="page-head">
        <h1>{t('about.title')}</h1>
      </div>
      <div className="panel">
        <p style={{ marginTop: 0 }}>{t('about.body')}</p>
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
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12.5, marginBottom: 0 }}>
          {t('about.source')}
        </p>
      </div>
    </div>
  );
}
