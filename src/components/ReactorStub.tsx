import { useTranslation } from 'react-i18next';

// Placeholder reactor view. The point-kinetics physics port lands on a dedicated
// branch and replaces this stub with a live simulator.
export function ReactorStub() {
  const { t } = useTranslation();
  const gauges = [
    { label: t('reactor.power'), value: '0 MWₜ' },
    { label: t('reactor.reactivity'), value: '0 pcm' },
    { label: t('reactor.fuelTemp'), value: '20 °C' },
    { label: t('reactor.coolantTemp'), value: '20 °C' },
  ];
  return (
    <div>
      <div className="reactor-hero">
        <h1 style={{ margin: '0 0 6px' }}>★ {t('reactor.title')}</h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('reactor.subtitle')}</p>
      </div>
      <div className="gauges">
        {gauges.map((g) => (
          <div className="gauge" key={g.label}>
            <div className="label">{g.label}</div>
            <div className="value">{g.value}</div>
          </div>
        ))}
      </div>
      <p className="count-note" style={{ marginTop: 20 }}>
        {t('reactor.comingSoon')}
      </p>
    </div>
  );
}
