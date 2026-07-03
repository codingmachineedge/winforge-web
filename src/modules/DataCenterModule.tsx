import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/DataCenterModule + DataCenterService: a hyperscale
// data centre that is a heavy reactor-powered load. The operator sets an IT
// load (MW of servers); facility draw = IT × PUE (cooling overhead worsens as
// the reactor is stressed). When supply can't meet demand, racks shed and the
// SLA bleeds. Standalone (available power is an operator slider vs the desktop
// reactor feed). Integer-tick driven, faithful to the service.

const MAX_IT_LOAD_MW = 500;
const BASE_PUE = 1.2;
const NOMINAL_UPTIME = 99.99;
const REQS_PER_MW_PER_SEC = 3200;
const MW_PER_RACK = 5;
const RESERVE_MW = 12;
const REACTOR_ENVELOPE = 1150;
const TICK_S = 0.5;

interface State {
  availableMW: number;
  itLoadMW: number;
  running: boolean;
  tick: number;
  pue: number;
  totalDrawMW: number;
  suppliedMW: number;
  onlineFrac: number;
  onlineRacks: number;
  totalRacks: number;
  shedRacks: number;
  reqsPerSec: number;
  uptime: number;
  onNuclear: boolean;
}

export function DataCenterModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    availableMW: 900,
    itLoadMW: 250,
    running: false,
    tick: 0,
    pue: BASE_PUE,
    totalDrawMW: 0,
    suppliedMW: 0,
    onlineFrac: 1,
    onlineRacks: 0,
    totalRacks: 0,
    shedRacks: 0,
    reqsPerSec: 0,
    uptime: NOMINAL_UPTIME,
    onNuclear: true,
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
        const generating = p.availableMW > 1;
        const onNuclear = generating && p.availableMW > 1;
        const supplyCap = onNuclear ? p.availableMW : RESERVE_MW;
        const it = Math.max(0, Math.min(p.itLoadMW, MAX_IT_LOAD_MW));
        const stress = onNuclear ? Math.max(0, Math.min(1, (REACTOR_ENVELOPE - p.availableMW) / REACTOR_ENVELOPE)) : 1;
        const ripple = 0.02 * Math.sin(tick * 0.013);
        const pue = Math.max(BASE_PUE, Math.min(1.9, BASE_PUE + 0.35 * stress + ripple));
        const totalDrawMW = it * pue;
        const suppliedMW = Math.min(totalDrawMW, supplyCap);
        const frac = totalDrawMW > 0.001 ? Math.max(0, Math.min(1, suppliedMW / totalDrawMW)) : 1;
        const onlineItMW = it * frac;
        const totalRacks = Math.ceil(it / MW_PER_RACK);
        let onlineRacks = Math.floor(onlineItMW / MW_PER_RACK + 0.0001);
        if (onlineRacks > totalRacks) onlineRacks = totalRacks;
        const shedRacks = Math.max(0, totalRacks - onlineRacks);
        const reqsPerSec = onlineItMW * REQS_PER_MW_PER_SEC;
        // SLA holds at nominal when nothing is shed, bleeds down when starved, recovers slowly.
        let uptime = p.uptime;
        if (frac >= 0.999) uptime = Math.min(NOMINAL_UPTIME, uptime + 0.001 * TICK_S);
        else uptime = Math.max(90, uptime - (1 - frac) * 0.05 * TICK_S);
        return {
          ...p,
          tick,
          onNuclear,
          pue,
          totalDrawMW,
          suppliedMW,
          onlineFrac: frac,
          onlineRacks,
          totalRacks,
          shedRacks,
          reqsPerSec,
          uptime,
        };
      });
    }, TICK_S * 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [s.running]);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));

  const status = !s.running
    ? t('datacenter.idle')
    : !s.onNuclear
      ? t('datacenter.reserve')
      : s.shedRacks > 0
        ? t('datacenter.shedding', { racks: s.shedRacks })
        : t('datacenter.healthy');

  const fmt = (n: number) => new Intl.NumberFormat().format(Math.round(n));

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${s.running ? '' : ' primary'}`} onClick={() => upd({ running: !s.running })}>
          {s.running ? t('datacenter.stop') : t('datacenter.start')}
        </button>
        <button className="mini" onClick={() => upd({ uptime: NOMINAL_UPTIME })}>{t('datacenter.resetSla')}</button>
        <StatusDot ok={s.running && s.shedRacks === 0 && s.onNuclear} label={status} />
      </ModuleToolbar>
      <p className="count-note">{t('datacenter.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('datacenter.power')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('datacenter.availableLabel', { mw: Math.round(s.availableMW), max: REACTOR_ENVELOPE })}
          <input type="range" min={0} max={REACTOR_ENVELOPE} value={s.availableMW} onChange={(e) => upd({ availableMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('datacenter.itLabel', { mw: Math.round(s.itLoadMW), max: MAX_IT_LOAD_MW })}
          <input type="range" min={0} max={MAX_IT_LOAD_MW} value={s.itLoadMW} onChange={(e) => upd({ itLoadMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel">
        <strong>{t('datacenter.readouts')}</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 8 }}>
          <Readout label={t('datacenter.pue')} value={s.pue.toFixed(2)} />
          <Readout label={t('datacenter.draw')} value={`${Math.round(s.totalDrawMW)} MW`} />
          <Readout label={t('datacenter.supplied')} value={`${Math.round(s.suppliedMW)} MW`} />
          <Readout label={t('datacenter.racks')} value={`${s.onlineRacks} / ${s.totalRacks}`} />
          <Readout label={t('datacenter.shed')} value={`${s.shedRacks}`} danger={s.shedRacks > 0} />
          <Readout label={t('datacenter.requests')} value={`${fmt(s.reqsPerSec)}/s`} />
          <Readout label={t('datacenter.sla')} value={`${s.uptime.toFixed(3)}%`} danger={s.uptime < 99.9} />
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="panel" style={{ margin: 0, padding: '8px 12px' }}>
      <div className="count-note" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: danger ? 'var(--danger)' : 'var(--text)' }}>{value}</div>
    </div>
  );
}
