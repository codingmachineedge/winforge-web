import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/PumpedHydroModule + PumpedHydroService: a pumped-
// storage grid buffer. PUMP consumes spare reactor power to lift water uphill
// (charge); GENERATE releases it through turbines to make MWe (discharge), even
// when the reactor is down. Round-trip efficiency ~80%. The desktop app reads
// live reactor output; here it is an operator slider so the plant runs alone.

const CAPACITY_MWH = 2000;
const MAX_PUMP_MW = 400;
const MAX_GEN_MW = 350;
const ROUND_TRIP = 0.8;
const LEG_EFF = Math.sqrt(ROUND_TRIP); // per-leg efficiency
const SPARE_THRESHOLD_MW = 200;
const TICK_MS = 500;
// A full 2000 MWh reservoir charges in ~7.5 h at real time — too slow to watch.
// Advance 30 simulated seconds per 0.5 s real tick (60× compressed) so the
// buffer fills/drains on a demonstrable timescale while keeping the physics.
const SIM_SECONDS_PER_TICK = 30;

type Mode = 'idle' | 'pump' | 'generate';

interface State {
  reactorMW: number;
  mode: Mode;
  requestPumpMW: number;
  stored: number; // MWh in the upper reservoir
  pumpDrawMW: number;
  genOutMW: number;
}

export function PumpedHydroModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    reactorMW: 900,
    mode: 'idle',
    requestPumpMW: 300,
    stored: 400,
    pumpDrawMW: 0,
    genOutMW: 0,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setS((p) => {
        const hours = SIM_SECONDS_PER_TICK / 3600;
        const generating = p.reactorMW > 1;
        const spare = generating ? Math.max(0, p.reactorMW - SPARE_THRESHOLD_MW) : 0;
        let { stored } = p;
        let pumpDrawMW = 0;
        let genOutMW = 0;

        if (p.mode === 'pump') {
          const draw = Math.max(0, Math.min(p.requestPumpMW, MAX_PUMP_MW, spare));
          const add = Math.min(draw * hours * LEG_EFF, CAPACITY_MWH - stored);
          stored += Math.max(0, add);
          pumpDrawMW = draw;
        } else if (p.mode === 'generate') {
          let outMW = MAX_GEN_MW;
          const maxByStore = hours > 0 ? (stored * LEG_EFF) / hours : outMW;
          outMW = Math.min(outMW, maxByStore);
          const drawn = Math.min((outMW * hours) / LEG_EFF, stored);
          stored -= drawn;
          genOutMW = outMW;
        }
        return { ...p, stored: Math.max(0, Math.min(CAPACITY_MWH, stored)), pumpDrawMW, genOutMW };
      });
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));
  const level = (s.stored / CAPACITY_MWH) * 100;
  const generating = s.reactorMW > 1;
  const spare = generating ? Math.max(0, s.reactorMW - SPARE_THRESHOLD_MW) : 0;

  const status =
    s.mode === 'pump'
      ? !generating
        ? t('pumpedhydro.cantPump')
        : s.stored >= CAPACITY_MWH
          ? t('pumpedhydro.full')
          : t('pumpedhydro.pumping', { mw: Math.round(s.pumpDrawMW) })
      : s.mode === 'generate'
        ? s.stored <= 0
          ? t('pumpedhydro.empty')
          : t('pumpedhydro.generating', { mw: Math.round(s.genOutMW) })
        : t('pumpedhydro.idle');

  return (
    <div className="mod">
      <ModuleToolbar>
        <StatusDot ok={s.mode !== 'idle'} label={status} />
      </ModuleToolbar>
      <p className="count-note">{t('pumpedhydro.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('pumpedhydro.reactorTitle')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('pumpedhydro.reactorLabel', { mw: Math.round(s.reactorMW), spare: Math.round(spare) })}
          <input type="range" min={0} max={1150} value={s.reactorMW} onChange={(e) => upd({ reactorMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{t('pumpedhydro.mode')}</strong>
        {(['idle', 'pump', 'generate'] as const).map((m) => (
          <button key={m} className={`mini${s.mode === m ? ' primary' : ''}`} onClick={() => upd({ mode: m })}>
            {t(`pumpedhydro.mode_${m}`)}
          </button>
        ))}
        {s.mode === 'pump' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: '1 1 240px' }}>
            {t('pumpedhydro.pumpDraw', { mw: Math.round(s.requestPumpMW) })}
            <input type="range" min={0} max={MAX_PUMP_MW} value={s.requestPumpMW} onChange={(e) => upd({ requestPumpMW: Number(e.target.value) })} style={{ flex: 1 }} />
          </label>
        )}
      </div>

      <div className="panel">
        <strong>{t('pumpedhydro.reservoir')}</strong>
        <div style={{ margin: '8px 0', height: 24, background: 'var(--bg-elevated)', border: '1px solid var(--stroke)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ width: `${level}%`, height: '100%', background: 'var(--accent-strong)', transition: 'width 0.3s' }} />
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>
          {t('pumpedhydro.stored', { mwh: Math.round(s.stored), cap: CAPACITY_MWH, pct: level.toFixed(1) })}
          {' · '}
          {s.mode === 'pump'
            ? t('pumpedhydro.drawing', { mw: Math.round(s.pumpDrawMW) })
            : s.mode === 'generate'
              ? t('pumpedhydro.producing', { mw: Math.round(s.genOutMW) })
              : t('pumpedhydro.rtNote', { pct: Math.round(ROUND_TRIP * 100) })}
        </p>
      </div>
    </div>
  );
}
