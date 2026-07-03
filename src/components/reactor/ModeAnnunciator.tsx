// 運轉模式指示 · Tech-Spec MODE 1–6 annunciator.
//
// Shows the six Westinghouse operational MODEs as a column; the engine's current tsMode is
// highlighted. Mode numbers are the ReactorTechSpecMode enum values (1..6); names come from i18n.
//
// Engine field bound: tsMode (ReactorTechSpecMode).

import { useTranslation } from 'react-i18next';
import { ReactorTechSpecMode } from '../../reactor/physics';

export interface ModeAnnunciatorProps {
  tsMode: ReactorTechSpecMode;
}

const MODES: { m: ReactorTechSpecMode; nameKey: string }[] = [
  { m: ReactorTechSpecMode.PowerOperation, nameKey: 'reactorui.mode1' },
  { m: ReactorTechSpecMode.Startup, nameKey: 'reactorui.mode2' },
  { m: ReactorTechSpecMode.HotStandby, nameKey: 'reactorui.mode3' },
  { m: ReactorTechSpecMode.HotShutdown, nameKey: 'reactorui.mode4' },
  { m: ReactorTechSpecMode.ColdShutdown, nameKey: 'reactorui.mode5' },
  { m: ReactorTechSpecMode.Refueling, nameKey: 'reactorui.mode6' },
];

export function ModeAnnunciator({ tsMode }: ModeAnnunciatorProps) {
  const { t } = useTranslation();
  return (
    <section className="panel mode-panel">
      <h2 className="panel-title">{t('reactorui.modeTitle')}</h2>
      <div className="mode-list">
        {MODES.map(({ m, nameKey }) => (
          <div key={m} className={`mode-cell${tsMode === m ? ' active' : ''}`}>
            <span className="mode-num">{t('reactorui.modeNumber', { n: m })}</span>
            <span className="mode-name">{t(nameKey)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
