import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/DesalModule + DesalService: a reverse-osmosis
// desalination plant driven by available reactor power. The desktop app pulls
// live station output from ReactorStatusApiService; here the available power is
// an operator slider so the plant runs standalone. Integer-tick driven (no wall
// clock), faithful to the service's constants and equations.

const REACTOR_MAX_MWE = 1150;
const PLANT_MAX_DRAW_MW = 400;
const YIELD_M3_PER_MWH = 280;
const TANK_CAPACITY_M3 = 50000;
const TICK_S = 0.5;

interface State {
  availableMW: number; // operator-set station output available to the plant
  requestedMW: number; // requested RO draw
  running: boolean;
  drawnMW: number;
  rateM3h: number;
  tankM3: number;
  totalM3: number;
}

const SPECIFIC_ENERGY = 1000 / YIELD_M3_PER_MWH; // kWh/m³

export function DesalModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    availableMW: 900,
    requestedMW: 200,
    running: false,
    drawnMW: 0,
    rateM3h: 0,
    tankM3: 0,
    totalM3: 0,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!s.running) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      setS((p) => {
        const drawnMW = Math.max(0, Math.min(p.requestedMW, PLANT_MAX_DRAW_MW, p.availableMW));
        const rateM3h = drawnMW * YIELD_M3_PER_MWH;
        let producedM3 = rateM3h * (TICK_S / 3600);
        const room = Math.max(0, TANK_CAPACITY_M3 - p.tankM3);
        if (producedM3 > room) producedM3 = room;
        return {
          ...p,
          drawnMW,
          rateM3h,
          tankM3: p.tankM3 + producedM3,
          totalM3: p.totalM3 + producedM3,
        };
      });
    }, TICK_S * 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [s.running]);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));
  const powered = s.availableMW > 1;
  const fillPct = Math.min(100, (s.tankM3 / TANK_CAPACITY_M3) * 100);

  const runStatus = !s.running
    ? t('desal.idle')
    : !powered
      ? t('desal.armed')
      : t('desal.runningNow', { mw: Math.round(s.drawnMW) });

  const bar = (label: string, value: number, max: number, unit: string, color = 'var(--accent)') => (
    <div style={{ marginBottom: 8 }}>
      <div className="count-note" style={{ margin: 0 }}>{label}</div>
      <div style={{ height: 14, background: 'var(--bg-elevated)', borderRadius: 7, overflow: 'hidden', border: '1px solid var(--stroke)' }}>
        <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 13 }}>{value.toFixed(unit === 'm³' ? 0 : 1)} {unit}</div>
    </div>
  );

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${s.running ? '' : ' primary'}`} onClick={() => upd({ running: !s.running })}>
          {s.running ? t('desal.stop') : t('desal.start')}
        </button>
        <button className="mini" onClick={() => upd({ tankM3: 0, totalM3: 0 })}>{t('desal.drainTank')}</button>
        <StatusDot ok={s.running && powered} label={runStatus} />
      </ModuleToolbar>
      <p className="count-note">{t('desal.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('desal.reactorTitle')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('desal.availableLabel', { mw: Math.round(s.availableMW), max: REACTOR_MAX_MWE })}
          <input type="range" min={0} max={REACTOR_MAX_MWE} value={s.availableMW} onChange={(e) => upd({ availableMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('desal.runTitle')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('desal.drawLabel', { mw: Math.round(s.requestedMW), max: PLANT_MAX_DRAW_MW })}
          <input type="range" min={0} max={PLANT_MAX_DRAW_MW} value={s.requestedMW} onChange={(e) => upd({ requestedMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel">
        <strong>{t('desal.readouts')}</strong>
        <div style={{ marginTop: 8 }}>
          {bar(t('desal.drawn'), s.drawnMW, PLANT_MAX_DRAW_MW, 'MW')}
          {bar(t('desal.rate'), s.rateM3h, PLANT_MAX_DRAW_MW * YIELD_M3_PER_MWH, 'm³/h', 'var(--web)')}
          {bar(t('desal.tank'), s.tankM3, TANK_CAPACITY_M3, 'm³', 'var(--accent-strong)')}
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>
          {t('desal.tankPct', { pct: fillPct.toFixed(1) })} · {t('desal.specificEnergy', { kwh: SPECIFIC_ENERGY.toFixed(2) })} · {t('desal.totalProduced', { m3: Math.round(s.totalM3) })}
        </p>
      </div>
    </div>
  );
}
