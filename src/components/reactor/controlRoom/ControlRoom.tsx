// 反應堆主控室 · Reactor Control Room — the Material-design-rewrite handoff's primary design
// ("Reactor Control Room.dc.html"), implemented against the REAL engine (ReactorSim + ReactorAux)
// instead of the prototype's simplified sim. Full-bleed CRT console: HUD bar, NIS / reactimeter /
// rod banks, animated plant mimic with pan+zoom, four analog gauges, latching annunciator with
// per-tile ACK, control console, plant status + permissive lamps, the SCRAM button, a core-cutaway
// modal and an opt-in WebAudio soundscape.

import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';
import '@fontsource/roboto-mono/700.css';
import '@fontsource/oxanium/600.css';
import '@fontsource/oxanium/700.css';
import '@fontsource/oxanium/800.css';
import 'material-symbols/outlined.css';
import '../../../styles/control-room.css';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactorMode, RatedThermalMW, type ReactorState } from '../../../reactor/physics';
import type { UseReactorSim } from '../../../reactor/useReactorSim';
import { useNumberFmt } from '../format';
import { ControlRoomAudio } from './crAudio';
import { PlantMimic, type MimicModel } from './PlantMimic';
import { CoreCutaway } from './CoreCutaway';

interface AlarmLatch {
  active: boolean;
  acked: boolean;
  zh: string;
}

/** dim green (cold) → lime → amber → orange → red-hot, exactly the design's ladder. */
function coreColors(temp: number): { top: string; bot: string; glow: number } {
  if (temp < 320) return { top: '#2f7d55', bot: '#1c6b46', glow: 6 };
  if (temp < 600) return { top: '#7ad06a', bot: '#3f9a54', glow: 9 };
  if (temp < 900) return { top: '#e6d95a', bot: '#c99a34', glow: 13 };
  if (temp < 1200) return { top: '#ff9a52', bot: '#e0662a', glow: 18 };
  return { top: '#ff6a52', bot: '#ff3b30', glow: 26 };
}

const needleDeg = (v: number, min: number, max: number) => -210 + Math.min(1, Math.max(0, (v - min) / (max - min))) * 240;
const logPct = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, ((v > 0 ? Math.log10(v) : lo) - lo) / (hi - lo))) * 100;

const PANEL: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 10, padding: 14 };
const SECTION_LABEL: React.CSSProperties = { fontSize: 11, letterSpacing: 1.8, color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 12, fontWeight: 600 };
const SQ_BTN = (color: string): React.CSSProperties => ({ width: 46, height: 46, borderRadius: 8, border: '1px solid var(--edge2)', background: '#0c1519', color, cursor: 'pointer', display: 'grid', placeItems: 'center' });

export function ControlRoom({ sim }: { sim: UseReactorSim }) {
  const { t, i18n } = useTranslation();
  const nf = useNumberFmt();
  const st = sim.state;
  const aux = sim.aux;
  const turbine = aux.turbine;

  const [latches, setLatches] = useState<Record<string, AlarmLatch>>({});
  const [soundOn, setSoundOn] = useState(false);
  const [coreOpen, setCoreOpen] = useState(false);
  const audioRef = useRef<ControlRoomAudio | null>(null);
  if (audioRef.current === null) audioRef.current = new ControlRoomAudio();
  const audio = audioRef.current;
  const tickRef = useRef(0);

  // Alarm latching: every engine alarm latches until it clears AND the operator has acked it.
  useEffect(() => {
    tickRef.current += 1;
    setLatches((prev) => {
      const next: Record<string, AlarmLatch> = { ...prev };
      const active = new Set(st.alarms);
      st.alarms.forEach((en, i) => {
        const existing = next[en];
        if (!existing) next[en] = { active: true, acked: false, zh: st.alarmsZh[i] ?? en };
        else if (!existing.active) next[en] = { ...existing, active: true };
      });
      for (const k of Object.keys(next)) {
        if (!active.has(k)) {
          const l = next[k]!;
          if (l.acked) delete next[k];
          else if (l.active) next[k] = { ...l, active: false };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const keys = Object.keys(latches);
  const flashing = keys.filter((k) => latches[k]!.active && !latches[k]!.acked).length;

  useEffect(() => {
    audio.update(st.neutronPowerFraction, st.sourceRangeCps, flashing, tickRef.current, sim.speed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);
  useEffect(() => () => audio.dispose(), [audio]);

  const lang = i18n.language;
  const alarmText = (en: string, zh: string) => (lang === 'yue' ? zh : lang === 'bilingual' && zh !== en ? `${en} · ${zh}` : en);

  // ---- derived display state ----
  const powerPct = st.neutronPowerFraction * 100;
  const crit =
    st.mode === ReactorMode.Meltdown
      ? { label: t('reactorcr.critMeltdown'), color: '#ff4438', blink: 'rcr-blink 0.5s steps(1,end) infinite' }
      : st.isScrammed
        ? { label: t('reactorcr.critScrammed'), color: '#ff4438', blink: 'rcr-blink 0.8s steps(1,end) infinite' }
        : st.reactivityPcm > 5
          ? { label: t('reactorcr.critSupercrit'), color: '#ffb62e', blink: 'none' }
          : st.reactivityPcm > -50
            ? { label: t('reactorcr.critCritical'), color: '#35e08a', blink: 'none' }
            : { label: t('reactorcr.critSubcritical'), color: '#35c9f0', blink: 'none' };

  const avgInsertion = st.rodBankInsertion.reduce((a, b) => a + b, 0) / st.rodBankInsertion.length;
  const rodWithdrawal = 100 - avgInsertion;
  const genOnline = turbine.breakerClosed;
  const mweValue = sim.credits.gridPowerMW;

  const sci = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return '0.0';
    const e = Math.floor(Math.log10(n));
    return nf.fmt(n / Math.pow(10, e), 1) + 'e' + e;
  };
  const nisRows = [
    { abbr: 'SR', name: t('reactorcr.nisSource'), value: nf.fmt(st.sourceRangeCps, 0) + ' cps', pct: logPct(st.sourceRangeCps, 0, 6), fill: '#35e08a' },
    { abbr: 'IR', name: t('reactorcr.nisIntermed'), value: sci(st.intermediateRangeAmps) + ' A', pct: logPct(st.intermediateRangeAmps, -11, -3), fill: '#35e08a' },
    { abbr: 'PR', name: t('reactorcr.nisPower'), value: nf.fmt(st.powerRangePercent, st.powerRangePercent < 10 ? 2 : 1) + '%', pct: Math.min(100, st.powerRangePercent / 1.2), fill: '#35c9f0' },
  ];

  const rhoPcm = st.reactivityPcm;
  const rhoFrac = Math.max(-1, Math.min(1, rhoPcm / 1500));
  const rhoWidth = Math.abs(rhoFrac) * 50;
  const rhoPos = rhoPcm >= 0;
  const rhoColor = rhoPos ? '#35e08a' : '#ff4438';

  // real per-bank positions (A,B,C,D from the engine, shown D→A like a real board)
  const bankIds = ['D', 'C', 'B', 'A'] as const;
  const rodBanks = bankIds.map((id, i) => {
    const ins = st.rodBankInsertion[3 - i] ?? 100;
    return { id, insPct: ins, steps: Math.round(((100 - ins) / 100) * 228) };
  });

  const gauges = [
    { label: t('reactorcr.gaugePower'), deg: needleDeg(st.thermalPowerMW, 0, RatedThermalMW * 1.2), valueText: nf.fmt(st.thermalPowerMW, 0), unit: 'MWt', sub: nf.fmt(powerPct, powerPct < 10 ? 2 : 1) + '% RTP', warnPath: 'M 176.82 86.46 A 78 78 0 0 1 170.11 134.19', dangerPath: 'M 170.11 134.19 A 78 78 0 0 1 167.55 139.00' },
    { label: t('reactorcr.gaugeReactivity'), deg: needleDeg(st.reactivityPcm, -3000, 3000), valueText: (st.reactivityPcm >= 0 ? '+' : '') + nf.fmt(st.reactivityPcm, 0), unit: 'pcm', sub: 'keff ' + nf.fmt(st.keff, 4), warnPath: 'M 100.27 22.00 A 78 78 0 0 1 141.33 33.85', dangerPath: 'M 141.33 33.85 A 78 78 0 0 1 167.55 139.00' },
    { label: t('reactorcr.gaugeFuel'), deg: needleDeg(st.fuelTemp, 0, 2800), valueText: nf.fmt(st.fuelTemp, 0), unit: '°C', sub: '', warnPath: 'M 46.95 42.82 A 78 78 0 0 1 77.01 25.47', dangerPath: 'M 77.01 25.47 A 78 78 0 0 1 167.55 139.00' },
    { label: t('reactorcr.gaugeTavg'), deg: needleDeg(st.tavg, 0, 350), valueText: nf.fmt(st.tavg, 0), unit: '°C', sub: '', warnPath: 'M 174.87 121.87 A 78 78 0 0 1 169.76 134.89', dangerPath: 'M 169.76 134.89 A 78 78 0 0 1 167.55 139.00' },
  ];

  const core = coreColors(st.fuelTemp);
  const rcpCount = st.rcpFlowDemand > 0 ? simRcpCount(st) : simRcpCount(st);
  const mimic: MimicModel = {
    coreTop: core.top,
    coreBot: core.bot,
    coreGlow: core.glow,
    rodY: Math.round(205 + (avgInsertion / 100) * 118),
    fuelTempText: nf.fmt(st.fuelTemp, 0),
    fuelTextColor: st.fuelTemp > 900 ? '#ffb62e' : '#a7bdb8',
    pressureText: nf.fmt(st.primaryPressure, 1),
    pzrWaterY: Math.round(140 - (st.pressurizerLevel / 100) * 66),
    pzrWaterH: Math.round((st.pressurizerLevel / 100) * 66),
    sgWaterY: Math.round(300 - (turbine.sgLevelPct / 100) * 180),
    sgWaterH: Math.round((turbine.sgLevelPct / 100) * 180),
    sgLevelText: nf.fmt(turbine.sgLevelPct, 0),
    sgPressureText: nf.fmt(turbine.sgPressureMPa, 1),
    thotText: nf.fmt(st.thot, 0),
    tcoldText: nf.fmt(st.tcold, 0),
    primaryFlowAnim: st.coolantFlowFraction > 0.03 ? 'running' : 'paused',
    coldFlowColor: '#35c9f0',
    steamFlowAnim: turbine.steamFlowFrac > 0.03 ? 'running' : 'paused',
    steamOpacity: turbine.steamFlowFrac > 0.03 ? 0.95 : 0.2,
    feedFlowAnim: st.feedwaterFlow > 0.03 ? 'running' : 'paused',
    gridFlowAnim: genOnline ? 'running' : 'paused',
    gridLineColor: genOnline ? '#35e08a' : '#2a3236',
    turbineSpinAnim: turbine.rpm > 30 ? 'running' : 'paused',
    turbineColor: genOnline ? '#35e08a' : turbine.rpm > 30 ? '#ffb62e' : '#4a5a56',
    turbineRpmText: nf.fmt(turbine.rpm, 0),
    genEdgeSvg: genOnline ? '#35e08a' : '#263a40',
    genGlowSvg: genOnline ? 12 : 0,
    genColorSvg: genOnline ? '#35e08a' : '#6d8480',
    genSyncText: genOnline ? t('reactorcr.syncOn') : t('reactorcr.syncOff'),
    rcpSpinAnim: st.coolantFlowFraction > 0.03 && rcpCount > 0 ? 'running' : 'paused',
    rcpColor: rcpCount > 0 ? '#35c9f0' : '#4a5a56',
    rcpCount,
  };

  const clockS = Math.round(sim.simClock);
  const clockText = clockS < 60 ? `${clockS}s` : `${Math.floor(clockS / 60)}m ${clockS % 60}s`;
  const suppress = st.easyStartupMode || st.autoStartMode;

  const sliders = [
    { label: t('reactorcr.rodWithdrawal'), value: Math.round(rodWithdrawal), min: 0, max: 100, step: 1, display: `${Math.round(rodWithdrawal)}%`, disabled: st.isScrammed || st.mode === ReactorMode.Meltdown, onChange: (v: number) => sim.setAllRods(100 - v) },
    { label: t('reactorcr.targetBoron'), value: Math.round(st.targetBoronPpm), min: 0, max: 2000, step: 10, display: `${Math.round(st.targetBoronPpm)} ppm`, disabled: false, onChange: (v: number) => sim.setTargetBoron(v) },
    { label: t('reactorcr.rcpFlow'), value: st.rcpFlowDemand, min: 0, max: 1, step: 0.05, display: `${Math.round(st.rcpFlowDemand * 100)}%`, disabled: false, onChange: (v: number) => { sim.setRcps(v > 0); sim.setRcpFlowDemand(v); } },
    { label: t('reactorcr.feedwater'), value: st.feedwaterFlow, min: 0, max: 1, step: 0.05, display: `${Math.round(st.feedwaterFlow * 100)}%`, disabled: false, onChange: (v: number) => sim.setFeedwaterFlow(v) },
  ];

  const statusReadouts = [
    { label: t('reactorcr.stElectric'), value: nf.fmt(mweValue, 0) + ' MWe', color: '#35e08a' },
    { label: t('reactorcr.stPrimaryP'), value: nf.fmt(st.primaryPressure, 2) + ' MPa', color: st.primaryPressure > 16.5 ? '#ffb62e' : '#cfe3dd' },
    { label: t('reactorcr.stPzrLevel'), value: nf.fmt(st.pressurizerLevel, 0) + '%', color: '#cfe3dd' },
    { label: t('reactorcr.stBoron'), value: nf.fmt(st.boronPpm, 0) + ' ppm', color: '#cfe3dd' },
    { label: t('reactorcr.stSgPress'), value: nf.fmt(turbine.sgPressureMPa, 2) + ' MPa', color: '#cfe3dd' },
    { label: t('reactorcr.stRcsFlow'), value: nf.fmt(st.coolantFlowFraction * 100, 0) + '%', color: st.coolantFlowFraction < 0.9 && powerPct > 10 ? '#ffb62e' : '#cfe3dd' },
    { label: t('reactorcr.stDecayHeat'), value: nf.fmt(st.decayHeatFraction * 100, 2) + '%', color: '#cfe3dd' },
    { label: t('reactorcr.stXenon'), value: nf.fmt(st.xenon, 2), color: '#cfe3dd' },
    { label: t('reactorcr.stBurnup'), value: nf.fmt(st.burnupMwdPerTonne, 0), color: '#cfe3dd' },
    { label: t('reactorcr.stPeriod'), value: !Number.isFinite(st.reactorPeriodSeconds) || Math.abs(st.reactorPeriodSeconds) >= 1e5 ? '∞' : nf.fmt(st.reactorPeriodSeconds, 0) + ' s', color: '#cfe3dd' },
  ];
  const permLamps = ([['P6', st.p6], ['P7', st.p7], ['P8', st.p8], ['P9', st.p9], ['P10', st.p10]] as const).map(([id, on]) => ({
    id,
    dotBg: on ? '#35e08a' : '#1c2a2f',
    dotGlow: on ? '0 0 8px rgba(53,224,138,0.7)' : 'none',
    idColor: on ? '#35e08a' : '#6d8480',
  }));

  const ack = (en: string) =>
    setLatches((prev) => {
      const next = { ...prev };
      const l = next[en];
      if (l) {
        if (l.active) next[en] = { ...l, acked: true };
        else delete next[en];
      }
      return next;
    });
  const ackAll = () =>
    setLatches((prev) => {
      const next: Record<string, AlarmLatch> = {};
      for (const [k, l] of Object.entries(prev)) if (l.active) next[k] = { ...l, acked: true };
      return next;
    });

  const modeBtns = [
    { m: ReactorMode.Shutdown, label: t('reactorcr.modeShutdown') },
    { m: ReactorMode.Startup, label: t('reactorcr.modeStartup') },
    { m: ReactorMode.Run, label: t('reactorcr.modeRun') },
  ];

  return (
    <div className="rcr">
      <div className="rcr-overlay" />
      {flashing > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 4, background: 'var(--alarm)', zIndex: 95, boxShadow: '0 0 18px var(--alarm)', animation: 'rcr-strobe 0.7s steps(1,end) infinite' }} />
      )}
      <div style={{ maxWidth: 1600, margin: '0 auto', padding: '14px 20px 40px' }}>
        {/* ============ TOP HUD BAR ============ */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 300, background: 'linear-gradient(180deg, var(--panel2), var(--panel))', border: '1px solid var(--edge)', borderRadius: 10, padding: '12px 18px', display: 'flex', alignItems: 'center', gap: '16px 20px', flexWrap: 'wrap', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="msym fill" style={{ fontSize: 30, color: 'var(--live)', filter: 'drop-shadow(0 0 6px rgba(53,224,138,0.5))' }}>radio_button_checked</span>
              <div>
                <div style={{ fontFamily: 'Oxanium', fontWeight: 800, fontSize: 17, letterSpacing: 1.5, color: '#dcefe9' }}>{t('reactorcr.plantName')}</div>
                <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase' }}>{t('reactorcr.plantSub')}</div>
              </div>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--edge)' }} />
            <HudStat label={t('reactorcr.criticality')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'Oxanium', fontWeight: 700, fontSize: 15, letterSpacing: 1, color: crit.color }}>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: crit.color, boxShadow: `0 0 10px ${crit.color}`, animation: crit.blink }} />
                {crit.label}
              </span>
            </HudStat>
            <HudStat label={t('reactorcr.mode')}>
              <span style={{ fontFamily: 'Oxanium', fontWeight: 700, fontSize: 15, letterSpacing: 1, color: '#cfe3dd' }}>{String(st.mode).toUpperCase()}</span>
            </HudStat>
            <HudStat label={t('reactorcr.techSpec')}>
              <span style={{ fontFamily: 'Oxanium', fontWeight: 700, fontSize: 15, letterSpacing: 1, color: 'var(--water)' }}>MODE {st.tsMode}</span>
            </HudStat>
          </div>

          <div style={{ background: 'linear-gradient(180deg, var(--panel2), var(--panel))', border: `1px solid ${flashing > 0 ? '#ff4438' : '#1d2c31'}`, borderRadius: 10, padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 14, minWidth: 190 }}>
            <span className="msym" style={{ fontSize: 28, color: flashing > 0 ? '#ff4438' : '#6d8480', animation: flashing > 0 ? 'rcr-blink 0.85s steps(1,end) infinite' : 'none' }}>
              {flashing > 0 ? 'warning' : 'notifications'}
            </span>
            <div>
              <div style={{ fontFamily: 'Oxanium', fontWeight: 800, fontSize: 20, letterSpacing: 1, color: flashing > 0 ? '#ff4438' : '#6d8480' }}>{flashing}</div>
              <div style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase' }}>{t('reactorcr.activeAlarms')}</div>
            </div>
          </div>

          <div style={{ background: 'linear-gradient(180deg, #0f1d17, #0a1410)', border: `1px solid ${genOnline ? '#1c6b46' : '#1d2c31'}`, borderRadius: 10, padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 22, boxShadow: `inset 0 0 24px ${genOnline ? 'rgba(53,224,138,0.12)' : 'transparent'}` }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'Oxanium', fontWeight: 800, fontSize: 34, lineHeight: 1, color: genOnline ? '#35e08a' : '#6d8480', letterSpacing: 1, textShadow: `0 0 14px ${genOnline ? 'rgba(53,224,138,0.5)' : 'transparent'}` }}>
                {nf.fmt(mweValue, 0)}
              </div>
              <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase', marginTop: 2 }}>{t('reactorcr.mweUnit')}</div>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--edge)' }} />
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'Oxanium', fontWeight: 700, fontSize: 22, lineHeight: 1, color: '#cfe3dd' }}>{nf.fmt(st.thermalPowerMW, 0)}</div>
              <div style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase', marginTop: 3 }}>
                {t('reactorcr.mwtUnit', { rtp: nf.fmt(powerPct, powerPct < 10 ? 1 : 0) })}
              </div>
            </div>
          </div>

          <div style={{ background: 'linear-gradient(180deg, var(--panel2), var(--panel))', border: '1px solid var(--edge)', borderRadius: 10, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="rcr-btn" onClick={() => sim.setRunning(!sim.running)} title={t('reactorcr.pauseRun')} style={SQ_BTN('var(--live)')}>
              <span className="msym" style={{ fontSize: 24 }}>{sim.running ? 'pause' : 'play_arrow'}</span>
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase', fontFamily: "'Roboto Mono'" }}>{t('reactorcr.time', { n: sim.speed })}</span>
              <input type="range" min={1} max={20} step={1} value={sim.speed} onChange={(e) => sim.setSpeed(Number(e.target.value))} style={{ width: 118 }} />
              <span style={{ fontFamily: "'Roboto Mono'", fontSize: 11, color: 'var(--dim)' }}>T+ {clockText}</span>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--edge)' }} />
            <button className="rcr-btn" onClick={() => setCoreOpen(true)} title={t('reactorcr.coreCutaway')} style={SQ_BTN('var(--warn)')}>
              <span className="msym" style={{ fontSize: 24 }}>grain</span>
            </button>
            <button
              className="rcr-btn-bright"
              onClick={() => setSoundOn(audio.toggle())}
              title={t('reactorcr.sound')}
              style={{ ...SQ_BTN(soundOn ? '#35e08a' : '#6d8480'), background: soundOn ? '#0f2a1c' : '#0c1519', border: `1px solid ${soundOn ? '#1c6b46' : 'var(--edge2)'}` }}
            >
              <span className="msym" style={{ fontSize: 24 }}>{soundOn ? 'volume_up' : 'volume_off'}</span>
            </button>
          </div>
        </div>

        {/* ============ MAIN: instruments · mimic · gauges ============ */}
        <div style={{ display: 'grid', gridTemplateColumns: '234px 1fr 210px', gap: 12, alignItems: 'stretch' }}>
          {/* LEFT */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={PANEL}>
              <div style={SECTION_LABEL}>{t('reactorcr.nisTitle')}</div>
              {nisRows.map((nr) => (
                <div key={nr.abbr} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                    <span style={{ fontSize: 12, color: '#a7bdb8' }}>
                      <span style={{ color: 'var(--live)', fontWeight: 700, fontFamily: "'Roboto Mono'" }}>{nr.abbr}</span> {nr.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 7, borderRadius: 4, background: '#0a1013', overflow: 'hidden', border: '1px solid #16232a' }}>
                      <div style={{ height: '100%', width: `${nr.pct.toFixed(1)}%`, background: nr.fill, boxShadow: `0 0 8px ${nr.fill}` }} />
                    </div>
                    <span style={{ fontFamily: "'Roboto Mono'", fontSize: 11.5, fontWeight: 500, color: '#cfe3dd', minWidth: 62, textAlign: 'right' }}>{nr.value}</span>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 8, borderTop: '1px solid var(--edge)', marginTop: 2 }}>
                <span style={{ fontSize: 12, color: '#a7bdb8' }}>{t('reactorcr.startupRate')}</span>
                <span style={{ fontFamily: "'Roboto Mono'", fontSize: 13, fontWeight: 600, color: st.startupRateDpm > 1 ? '#ffb62e' : '#cfe3dd' }}>
                  {(st.startupRateDpm >= 0 ? '+' : '') + nf.fmt(st.startupRateDpm, 2)} DPM
                </span>
              </div>
            </div>

            <div style={PANEL}>
              <div style={{ ...SECTION_LABEL, marginBottom: 10 }}>{t('reactorcr.reactimeter')}</div>
              <div style={{ position: 'relative', height: 14, background: '#0a1013', border: '1px solid #16232a', borderRadius: 7, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: 'var(--edge2)' }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${rhoPos ? 50 : 50 - rhoWidth}%`, width: `${rhoWidth}%`, background: rhoColor, boxShadow: `0 0 8px ${rhoColor}` }} />
              </div>
              <div style={{ textAlign: 'center', fontFamily: 'Oxanium', fontWeight: 700, fontSize: 22, color: rhoColor }}>{(rhoPcm >= 0 ? '+' : '') + nf.fmt(rhoPcm, 0)}</div>
              <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--dim)', fontFamily: "'Roboto Mono'" }}>k-eff {nf.fmt(st.keff, 5)}</div>
            </div>

            <div style={{ ...PANEL, flex: 1 }}>
              <div style={SECTION_LABEL}>{t('reactorcr.rodBanks')}</div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'space-around', alignItems: 'flex-end', height: 150 }}>
                {rodBanks.map((rb) => (
                  <div key={rb.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%' }}>
                    <div style={{ position: 'relative', width: 26, flex: 1, background: '#0a1013', border: '1px solid #16232a', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${rb.insPct.toFixed(0)}%`, background: 'linear-gradient(180deg, #2a3d43, #1a2b30)', borderBottom: '2px solid var(--live)' }} />
                      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, textAlign: 'center', fontFamily: "'Roboto Mono'", fontSize: 9, color: 'var(--live)', fontWeight: 700 }}>{rb.steps}</div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#a7bdb8', fontFamily: "'Roboto Mono'" }}>{rb.id}</span>
                  </div>
                ))}
              </div>
              <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'var(--dim)' }}>
                {t('reactorcr.withdrawal')} <span style={{ color: 'var(--live)', fontFamily: "'Roboto Mono'" }}>{Math.round(rodWithdrawal)}%</span>
              </div>
            </div>
          </div>

          {/* CENTER */}
          <PlantMimic m={mimic} />

          {/* RIGHT */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {gauges.map((ag) => (
              <div key={ag.label} style={{ background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 10, padding: '10px 12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ alignSelf: 'flex-start', fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 600 }}>{ag.label}</div>
                <svg viewBox="0 0 200 150" style={{ width: '100%', maxWidth: 180, height: 'auto', display: 'block' }}>
                  <path d="M 32.45 139.00 A 78 78 0 1 1 167.55 139.00" fill="none" stroke="#16232a" strokeWidth={9} strokeLinecap="round" />
                  <path d={ag.warnPath} fill="none" stroke="var(--warn)" strokeWidth={9} opacity={0.85} />
                  <path d={ag.dangerPath} fill="none" stroke="var(--alarm)" strokeWidth={9} />
                  <g stroke="#3a4d52" strokeWidth={1.5} opacity={0.6}>
                    <line x1="32.5" y1="139.0" x2="39.4" y2="135.0" /><line x1="22.0" y1="100.0" x2="30.0" y2="100.0" /><line x1="32.5" y1="61.0" x2="39.4" y2="65.0" /><line x1="61.0" y1="32.5" x2="65.0" y2="39.4" /><line x1="100.0" y1="22.0" x2="100.0" y2="30.0" /><line x1="139.0" y1="32.5" x2="135.0" y2="39.4" /><line x1="167.5" y1="61.0" x2="160.6" y2="65.0" /><line x1="178.0" y1="100.0" x2="170.0" y2="100.0" /><line x1="167.5" y1="139.0" x2="160.6" y2="135.0" />
                  </g>
                  <g style={{ transform: `rotate(${ag.deg}deg)`, transformOrigin: '100px 100px', transition: 'transform 0.4s cubic-bezier(0.22,1,0.36,1)' }}>
                    <line x1={100} y1={100} x2={164} y2={100} stroke="var(--live)" strokeWidth={3} strokeLinecap="round" />
                  </g>
                  <circle cx={100} cy={100} r={6} fill="var(--live)" stroke="var(--panel)" strokeWidth={2} />
                </svg>
                <div style={{ marginTop: -14, textAlign: 'center' }}>
                  <span style={{ fontFamily: 'Oxanium', fontWeight: 700, fontSize: 20, color: '#dcefe9' }}>{ag.valueText}</span>
                  <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: "'Roboto Mono'" }}> {ag.unit}</span>
                </div>
                {ag.sub && <div style={{ fontSize: 10.5, color: 'var(--dim)', textAlign: 'center', marginTop: 1, fontFamily: "'Roboto Mono'" }}>{ag.sub}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* ============ ANNUNCIATOR ============ */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 12, padding: '14px 16px', marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
            <span style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700 }}>{t('reactorcr.annunciator')}</span>
            <span style={{ flex: 1, height: 1, background: 'var(--edge)' }} />
            <button className="rcr-btn" onClick={ackAll} style={{ height: 30, padding: '0 16px', borderRadius: 6, border: '1px solid var(--edge2)', background: '#0c1519', color: 'var(--warn)', cursor: 'pointer', fontSize: 12, fontWeight: 600, letterSpacing: 1, fontFamily: "'Chakra Petch'" }}>
              {t('reactorcr.ackAll')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {keys.length === 0 && (
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--live)', fontSize: 13, padding: '4px 0', fontFamily: "'Roboto Mono'" }}>
                <span className="msym" style={{ fontSize: 18 }}>check_circle</span>
                {t('reactorcr.allNominal')}
              </div>
            )}
            {keys.map((en) => {
              const l = latches[en]!;
              const set = l.active && !l.acked
                ? { bg: '#3a0f0c', border: '#ff4438', color: '#ff8a7a', anim: 'rcr-blink 0.85s steps(1,end) infinite', glow: '0 0 12px rgba(255,68,56,0.4)' }
                : l.active
                  ? { bg: '#2a1310', border: '#ff4438', color: '#ff8a7a', anim: 'none', glow: 'none' }
                  : { bg: '#2a2410', border: '#ffb62e', color: '#ffcf6e', anim: 'none', glow: 'none' };
              return (
                <button key={en} onClick={() => ack(en)} style={{ border: `1px solid ${set.border}`, borderRadius: 6, background: set.bg, color: set.color, fontSize: 11, fontWeight: 700, lineHeight: 1.2, padding: '9px 10px', minHeight: 46, textAlign: 'left', cursor: 'pointer', fontFamily: "'Chakra Petch'", letterSpacing: 0.5, textTransform: 'uppercase', animation: set.anim, boxShadow: set.glow }}>
                  {alarmText(en, l.zh)}
                </button>
              );
            })}
          </div>
        </div>

        {/* ============ CONTROL CONSOLE ============ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12, marginTop: 12 }}>
          <div style={{ background: 'linear-gradient(180deg, var(--panel2), var(--panel))', border: '1px solid var(--edge)', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 14 }}>{t('reactorcr.reactorControls')}</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: 1, textTransform: 'uppercase' }}>{t('reactorcr.mode')}</span>
              <div style={{ display: 'inline-flex', border: '1px solid var(--edge2)', borderRadius: 8, overflow: 'hidden' }}>
                {modeBtns.map((mb, i) => (
                  <button
                    key={mb.label}
                    onClick={() => sim.setMode(mb.m)}
                    disabled={st.mode === ReactorMode.Meltdown}
                    style={{ height: 38, padding: '0 18px', border: 'none', borderLeft: i === 0 ? 'none' : '1px solid #263a40', background: st.mode === mb.m ? '#123a24' : 'transparent', color: st.mode === mb.m ? '#35e08a' : '#6d8480', fontWeight: 700, cursor: 'pointer', fontFamily: "'Chakra Petch'", fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', opacity: st.mode === ReactorMode.Meltdown ? 0.45 : 1 }}
                  >
                    {mb.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 24px' }}>
              {sliders.map((cs) => (
                <label key={cs.label} style={{ display: 'block', opacity: cs.disabled ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a7bdb8', marginBottom: 6 }}>
                    <span style={{ letterSpacing: 0.5 }}>{cs.label}</span>
                    <span style={{ fontFamily: "'Roboto Mono'", color: 'var(--live)', fontWeight: 600 }}>{cs.display}</span>
                  </div>
                  <input type="range" min={cs.min} max={cs.max} step={cs.step} value={cs.value} disabled={cs.disabled} onChange={(e) => cs.onChange(Number(e.target.value))} style={{ width: '100%' }} />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 18, alignItems: 'center' }}>
              <button
                onClick={() => sim.setTurbine(!turbine.latched)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 44, padding: '0 16px', borderRadius: 8, border: `1px solid ${turbine.latched ? '#1c6b46' : '#263a40'}`, background: turbine.latched ? '#0f2a1c' : '#0c1519', color: turbine.latched ? '#35e08a' : '#a7bdb8', cursor: 'pointer', fontFamily: "'Chakra Petch'", fontWeight: 600, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}
              >
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: genOnline ? '#35e08a' : turbine.latched ? '#ffb62e' : '#4a5a56', boxShadow: `0 0 8px ${genOnline ? '#35e08a' : turbine.latched ? '#ffb62e' : '#4a5a56'}` }} />
                {t('reactorcr.turbine')} {turbine.latched ? t('reactorcr.turbineLatched') : t('reactorcr.turbineOff')}
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 12.5, color: '#a7bdb8' }}>
                <button onClick={() => sim.setEasyStartup(!st.easyStartupMode)} style={{ width: 44, height: 24, borderRadius: 999, border: `1px solid ${st.easyStartupMode ? '#1c6b46' : '#263a40'}`, background: st.easyStartupMode ? '#123a24' : '#0c1519', cursor: 'pointer', padding: 0, position: 'relative' }}>
                  <span style={{ position: 'absolute', top: 2, left: st.easyStartupMode ? 22 : 2, width: 18, height: 18, borderRadius: '50%', background: st.easyStartupMode ? '#35e08a' : '#6d8480', transition: 'left 0.15s' }} />
                </button>
                {t('reactorcr.easyStartup')}
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="rcr-btn" onClick={sim.warmStart} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid var(--edge2)', background: '#0c1519', color: 'var(--warn)', cursor: 'pointer', fontFamily: "'Chakra Petch'", fontWeight: 600, fontSize: 12.5, letterSpacing: 1, textTransform: 'uppercase' }}>
                <span className="msym" style={{ fontSize: 18 }}>local_fire_department</span>
                {t('reactorcr.warmStart')}
              </button>
              <button className="rcr-btn" onClick={sim.reset} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid var(--edge2)', background: '#0c1519', color: '#a7bdb8', cursor: 'pointer', fontFamily: "'Chakra Petch'", fontWeight: 600, fontSize: 12.5, letterSpacing: 1, textTransform: 'uppercase' }}>
                <span className="msym" style={{ fontSize: 18 }}>restart_alt</span>
                {t('reactorcr.reset')}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 12, padding: '14px 16px', flex: 1 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 12 }}>{t('reactorcr.plantStatus')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                {statusReadouts.map((sr) => (
                  <div key={sr.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid #16232a' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>{sr.label}</span>
                    <span style={{ fontFamily: "'Roboto Mono'", fontSize: 12.5, fontWeight: 600, color: sr.color }}>{sr.value}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
                {permLamps.map((pl) => (
                  <div key={pl.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: pl.dotBg, boxShadow: pl.dotGlow }} />
                    <span style={{ fontSize: 10.5, fontFamily: "'Roboto Mono'", fontWeight: 700, color: pl.idColor }}>{pl.id}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: 'linear-gradient(180deg, #1a0d0d, #120909)', border: '1px solid #3a1c1c', borderRadius: 12, padding: 14, display: 'flex', alignItems: 'center', gap: 16 }}>
              <button
                className="rcr-scrambtn"
                onClick={() => {
                  audio.scramWhoop();
                  sim.setTurbine(false);
                  sim.scram();
                }}
                style={{ width: 96, height: 96, borderRadius: '50%', border: '4px solid #5a1a15', background: 'radial-gradient(circle at 40% 35%, #ff5a48, #c81e12 65%, #8a1109)', color: '#fff', cursor: 'pointer', fontFamily: 'Oxanium', fontWeight: 800, fontSize: 20, letterSpacing: 1, boxShadow: '0 6px 18px rgba(255,68,56,0.35), inset 0 2px 8px rgba(255,255,255,0.25)', flexShrink: 0, animation: flashing > 0 ? 'rcr-pulse 1.1s ease-in-out infinite' : 'none' }}
              >
                {t('reactorcr.scram')}
              </button>
              <div>
                <div style={{ fontFamily: "'Chakra Petch'", fontWeight: 700, fontSize: 15, letterSpacing: 1, color: '#ff9a8a', textTransform: 'uppercase' }}>{t('reactorcr.emergencyTrip')}</div>
                <div style={{ fontSize: 12, color: '#a7877f', marginTop: 4, lineHeight: 1.4 }}>
                  {t('reactorcr.scramNote', { state: suppress ? t('reactorcr.rpsBypassed') : t('reactorcr.rpsArmed') })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <CoreCutaway
        open={coreOpen}
        onClose={() => setCoreOpen(false)}
        powerFraction={st.neutronPowerFraction}
        rodInsertionPct={avgInsertion}
        fuelTempC={st.fuelTemp}
        tavgC={st.tavg}
        coolantFlowFraction={st.coolantFlowFraction}
        fluxCore={core.top}
        fmt={nf}
      />
    </div>
  );
}

function HudStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </div>
  );
}

/** Running RCP count. ReactorState doesn't carry the per-pump array; infer from demand + flow. */
function simRcpCount(st: ReactorState): number {
  if (st.rcpFlowDemand <= 0) return 0;
  return st.coolantFlowFraction > 0.03 ? 4 : 0;
}
