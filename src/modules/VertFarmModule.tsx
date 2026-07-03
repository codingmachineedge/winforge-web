import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/VertFarmModule + VertFarmService: a reactor-powered
// indoor vertical farm. Drawn power runs LED grow-lights (minus HVAC overhead)
// over a canopy; crops grow while lit during the photoperiod "day" and spoil
// slightly when the lights go dark. At 100% growth the canopy auto-harvests.
// Standalone (available power is an operator slider vs the desktop reactor feed).

const REACTOR_MAX_MWE = 1150;
const FARM_MAX_DRAW_MW = 200;
const AREA_PER_MW = 45; // m² canopy per delivered MW
const LIGHTS_PER_MW = 320;
const HVAC_FRACTION = 0.18;
const GROWTH_PCT_PER_SEC = 0.55;
const LIGHT_CAP_MW = FARM_MAX_DRAW_MW;
const PHOTO_CYCLE_TICKS = 240; // one sim-day
const PHOTO_LIGHT_TICKS = 180; // 18h "on"
const YIELD_KG_PER_M2 = 3.2;
const SPOIL_PCT_PER_SEC = 0.05;
const TICK_S = 0.5;

interface State {
  availableMW: number;
  requestedMW: number;
  running: boolean;
  tick: number;
  growthPct: number;
  totalKg: number;
  harvests: number;
  drawnMW: number;
  growLightMW: number;
  canopyM2: number;
  lights: number;
  dayPhase: boolean;
  lightsOn: boolean;
}

export function VertFarmModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    availableMW: 900,
    requestedMW: 160,
    running: false,
    tick: 0,
    growthPct: 0,
    totalKg: 0,
    harvests: 0,
    drawnMW: 0,
    growLightMW: 0,
    canopyM2: 0,
    lights: 0,
    dayPhase: true,
    lightsOn: false,
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
        const tick = p.tick + 1;
        const dayPhase = tick % PHOTO_CYCLE_TICKS < PHOTO_LIGHT_TICKS;
        const powered = p.availableMW > 1;
        const drawnMW = powered ? Math.max(0, Math.min(p.requestedMW, p.availableMW, FARM_MAX_DRAW_MW)) : 0;
        const growLightMW = Math.max(0, drawnMW * (1 - HVAC_FRACTION));
        const canopyM2 = growLightMW * AREA_PER_MW;
        const lights = Math.round(growLightMW * LIGHTS_PER_MW);
        const lightsOn = dayPhase && growLightMW > 0.01;

        let growthPct = p.growthPct;
        let totalKg = p.totalKg;
        let harvests = p.harvests;
        if (lightsOn) {
          const effLight = Math.min(growLightMW, LIGHT_CAP_MW) / LIGHT_CAP_MW;
          growthPct = Math.min(100, growthPct + GROWTH_PCT_PER_SEC * effLight * TICK_S);
          if (growthPct >= 100) {
            totalKg += YIELD_KG_PER_M2 * canopyM2;
            harvests += 1;
            growthPct = 0;
          }
        } else if (growLightMW < 0.01 && growthPct > 0) {
          // Lights out (no power) → slight spoilage. Dark-rest with power keeps growth.
          growthPct = Math.max(0, growthPct - SPOIL_PCT_PER_SEC * TICK_S);
        }
        return { ...p, tick, dayPhase, drawnMW, growLightMW, canopyM2, lights, lightsOn, growthPct, totalKg, harvests };
      });
    }, TICK_S * 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [s.running]);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));

  const status = !s.running
    ? t('vertfarm.idle')
    : s.availableMW <= 1
      ? t('vertfarm.noPower')
      : !s.dayPhase
        ? t('vertfarm.night')
        : s.lightsOn
          ? t('vertfarm.growing')
          : t('vertfarm.dark');

  const bar = (value: number, color: string) => (
    <div style={{ height: 14, background: 'var(--bg-elevated)', borderRadius: 7, overflow: 'hidden', border: '1px solid var(--stroke)' }}>
      <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
    </div>
  );

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${s.running ? '' : ' primary'}`} onClick={() => upd({ running: !s.running })}>
          {s.running ? t('vertfarm.stop') : t('vertfarm.start')}
        </button>
        <StatusDot ok={s.lightsOn} label={status} />
        <span className="count-note" style={{ margin: 0 }}>
          {s.dayPhase ? '☀ ' : '☾ '}{t('vertfarm.phase', { phase: s.dayPhase ? t('vertfarm.day') : t('vertfarm.nightWord') })}
        </span>
      </ModuleToolbar>
      <p className="count-note">{t('vertfarm.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('vertfarm.reactorTitle')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('vertfarm.availableLabel', { mw: Math.round(s.availableMW), max: REACTOR_MAX_MWE })}
          <input type="range" min={0} max={REACTOR_MAX_MWE} value={s.availableMW} onChange={(e) => upd({ availableMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('vertfarm.drawLabel', { mw: Math.round(s.requestedMW), max: FARM_MAX_DRAW_MW })}
          <input type="range" min={0} max={FARM_MAX_DRAW_MW} value={s.requestedMW} onChange={(e) => upd({ requestedMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel">
        <strong>{t('vertfarm.growth')}</strong>
        <div style={{ margin: '8px 0' }}>{bar(s.growthPct, 'var(--web)')}</div>
        <p className="count-note" style={{ margin: 0 }}>
          {t('vertfarm.growthPct', { pct: s.growthPct.toFixed(1) })} · {t('vertfarm.canopy', { m2: Math.round(s.canopyM2), lights: s.lights })} · {t('vertfarm.growLightMW', { mw: s.growLightMW.toFixed(0) })}
        </p>
        <p className="count-note" style={{ marginBottom: 0 }}>
          {t('vertfarm.harvested', { kg: Math.round(s.totalKg), n: s.harvests })}
        </p>
      </div>
    </div>
  );
}
