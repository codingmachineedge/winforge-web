import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/ColliderModule + ColliderService: a superconducting
// particle collider. Magnet power to hold the beam grows with the square of
// beam energy (~800 MW at 14 TeV). The beam ramps toward the target only while
// the reactor can supply the required MW; if power falls short the energy caps,
// and a reactor stop causes a beam dump. Above the collision threshold, stable
// running accrues integrated luminosity, recorded events, and discoveries.
// Standalone (available power is an operator slider vs the desktop reactor feed).

const MAX_BEAM_TEV = 14;
const MAX_MAGNET_MW = 800;
const COLLISION_THRESHOLD_TEV = 3;
const RAMP_PER_TICK = 0.06;
const DECAY_PER_TICK = 0.1;
const PRIORITY_RAMP = 1.6;
const PRIORITY_LUMI = 1.5;
const DISCOVERY_MARKS = [5, 25, 75, 150, 300, 600, 1200];
const TICK_MS = 400;

const requiredMagnetPower = (tev: number) => MAX_MAGNET_MW * (tev / MAX_BEAM_TEV) ** 2;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface State {
  availableMW: number;
  targetTeV: number;
  ramping: boolean;
  priority: boolean;
  beamTeV: number;
  requiredMW: number;
  lumi: number; // fb^-1
  events: number;
  discoveries: number;
  beamDumped: boolean;
}

export function ColliderModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    availableMW: 900,
    targetTeV: 13,
    ramping: false,
    priority: false,
    beamTeV: 0,
    requiredMW: 0,
    lumi: 0,
    events: 0,
    discoveries: 0,
    beamDumped: false,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setS((p) => {
        const generating = p.availableMW > 1;
        let beamTeV = p.beamTeV;
        let beamDumped = false;
        if (!generating) {
          if (beamTeV > 0.001) beamDumped = true;
          beamTeV = 0;
        } else {
          const target = p.ramping ? p.targetTeV : 0;
          if (target > beamTeV) {
            const rampStep = RAMP_PER_TICK * (p.priority ? PRIORITY_RAMP : 1);
            const nextWanted = Math.min(target, beamTeV + rampStep);
            if (requiredMagnetPower(nextWanted) <= p.availableMW) {
              beamTeV = nextWanted;
            } else {
              const sustainable = MAX_BEAM_TEV * Math.sqrt(clamp01(p.availableMW / MAX_MAGNET_MW));
              beamTeV = sustainable < beamTeV ? Math.max(sustainable, beamTeV - DECAY_PER_TICK) : Math.min(nextWanted, sustainable);
            }
          } else if (target < beamTeV) {
            beamTeV = Math.max(target, beamTeV - DECAY_PER_TICK);
          }
        }
        const requiredMW = requiredMagnetPower(beamTeV);

        let lumi = p.lumi;
        let events = p.events;
        let discoveries = p.discoveries;
        if (beamTeV >= COLLISION_THRESHOLD_TEV && requiredMW <= p.availableMW + 0.5) {
          const over = (beamTeV - COLLISION_THRESHOLD_TEV) / (MAX_BEAM_TEV - COLLISION_THRESHOLD_TEV);
          let lumiRate = 0.05 + 0.45 * over;
          if (p.priority) lumiRate *= PRIORITY_LUMI;
          lumi += lumiRate;
          events += Math.round(lumiRate * 1e6);
          discoveries = DISCOVERY_MARKS.filter((m) => lumi >= m).length;
        }
        return { ...p, beamTeV, requiredMW, lumi, events, discoveries, beamDumped };
      });
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));
  const colliding = s.beamTeV >= COLLISION_THRESHOLD_TEV && s.requiredMW <= s.availableMW + 0.5;
  const powerShort = s.ramping && s.availableMW > 1 && s.requiredMW > s.availableMW + 0.5;

  const status = s.beamDumped
    ? t('collider.dumped')
    : s.availableMW <= 1
      ? t('collider.noPower')
      : !s.ramping
        ? t('collider.standby')
        : colliding
          ? t('collider.colliding', { tev: s.beamTeV.toFixed(1) })
          : powerShort
            ? t('collider.starved')
            : t('collider.ramping', { tev: s.beamTeV.toFixed(1) });

  const fmt = (n: number) => new Intl.NumberFormat().format(Math.round(n));

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${s.ramping ? '' : ' primary'}`} onClick={() => upd({ ramping: !s.ramping })}>
          {s.ramping ? t('collider.beamOff') : t('collider.beamOn')}
        </button>
        <button className={`mini${s.priority ? ' primary' : ''}`} onClick={() => upd({ priority: !s.priority })}>
          {t('collider.priority')}
        </button>
        <button className="mini" onClick={() => upd({ lumi: 0, events: 0, discoveries: 0 })}>{t('collider.resetRun')}</button>
        <StatusDot ok={colliding} label={status} />
      </ModuleToolbar>
      <p className="count-note">{t('collider.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('collider.availableLabel', { mw: Math.round(s.availableMW) })}
          <input type="range" min={0} max={1150} value={s.availableMW} onChange={(e) => upd({ availableMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('collider.targetLabel', { tev: s.targetTeV.toFixed(1) })}
          <input type="range" min={0} max={MAX_BEAM_TEV * 10} value={s.targetTeV * 10} onChange={(e) => upd({ targetTeV: Number(e.target.value) / 10 })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('collider.beam')}</strong>
        <div style={{ margin: '8px 0', height: 20, background: 'var(--bg-elevated)', border: '1px solid var(--stroke)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ width: `${(s.beamTeV / MAX_BEAM_TEV) * 100}%`, height: '100%', background: colliding ? 'var(--web)' : 'var(--native)', transition: 'width 0.2s' }} />
        </div>
        <p className="count-note" style={{ margin: 0 }}>
          {t('collider.beamStat', { tev: s.beamTeV.toFixed(2), req: Math.round(s.requiredMW), avail: Math.round(s.availableMW) })}
        </p>
      </div>

      <div className="panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Readout label={t('collider.lumi')} value={`${s.lumi.toFixed(1)} fb⁻¹`} />
        <Readout label={t('collider.events')} value={fmt(s.events)} />
        <Readout label={t('collider.discoveries')} value={`${s.discoveries} / ${DISCOVERY_MARKS.length}`} />
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel" style={{ margin: 0, padding: '8px 12px' }}>
      <div className="count-note" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
