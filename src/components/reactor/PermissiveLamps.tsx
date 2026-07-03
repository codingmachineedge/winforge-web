// 許可訊號燈 · Permissive / interlock lamp row (P-6 … P-10).
//
// A row of indicator lamps for the reactor-protection permissives the engine computes. Each lamp
// is lit when its interlock is asserted. Engine fields bound: p6, p7, p8, p9, p10.

import { useTranslation } from 'react-i18next';

export interface PermissiveLampsProps {
  p6: boolean;
  p7: boolean;
  p8: boolean;
  p9: boolean;
  p10: boolean;
}

export function PermissiveLamps({ p6, p7, p8, p9, p10 }: PermissiveLampsProps) {
  const { t } = useTranslation();
  const lamps: { id: string; on: boolean; descKey: string }[] = [
    { id: 'P-6', on: p6, descKey: 'reactorui.p6' },
    { id: 'P-7', on: p7, descKey: 'reactorui.p7' },
    { id: 'P-8', on: p8, descKey: 'reactorui.p8' },
    { id: 'P-9', on: p9, descKey: 'reactorui.p9' },
    { id: 'P-10', on: p10, descKey: 'reactorui.p10' },
  ];

  return (
    <section className="panel permissive-panel">
      <h2 className="panel-title">{t('reactorui.permissivesTitle')}</h2>
      <div className="permissive-row">
        {lamps.map((l) => (
          <div
            key={l.id}
            className={`permissive-lamp${l.on ? ' on' : ''}`}
            title={`${l.id}: ${t(l.descKey)} — ${l.on ? t('reactorui.lit') : t('reactorui.unlit')}`}
          >
            <span className="permissive-dot" aria-hidden="true" />
            <span className="permissive-id">{l.id}</span>
            <span className="permissive-desc">{t(l.descKey)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
