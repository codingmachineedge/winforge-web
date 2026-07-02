import { useTranslation } from 'react-i18next';
import { ReactorMode, type ReactorState } from '../reactor/physics';
import { useReactorSim, type TrendPoint } from '../reactor/useReactorSim';

// ---- small presentational helpers ----

function Gauge({
  label,
  value,
  unit,
  sub,
  tone,
  primary,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: 'accent' | 'warn' | 'danger' | 'ok';
  primary?: boolean;
}) {
  return (
    <div className={`gauge${primary ? ' gauge-primary' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value${tone ? ` tone-${tone}` : ''}`}>
        {value}
        {unit && <span className="unit"> {unit}</span>}
      </div>
      {sub && <div className="gauge-sub">{sub}</div>}
    </div>
  );
}

function Sparkline({
  points,
  accessor,
  color,
  zero,
}: {
  points: TrendPoint[];
  accessor: (p: TrendPoint) => number;
  color: string;
  zero?: boolean;
}) {
  const W = 320;
  const H = 60;
  if (points.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />;
  }
  const ys = points.map(accessor);
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  if (zero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (max - min < 1e-9) {
    max += 1;
    min -= 1;
  }
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1e-6, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(accessor(p)).toFixed(1)}`).join(' ');
  const zeroY = zero && min < 0 && max > 0 ? y(0) : null;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {zeroY !== null && <line x1={0} y1={zeroY} x2={W} y2={zeroY} className="spark-zero" />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ReactivityBar({ label, pcm }: { label: string; pcm: number }) {
  // map ±3000 pcm to a bar around the centre.
  const cap = 3000;
  const frac = Math.max(-1, Math.min(1, pcm / cap));
  const width = Math.abs(frac) * 50; // % of half-width
  const positive = pcm >= 0;
  return (
    <div className="rbar-row">
      <div className="rbar-label">{label}</div>
      <div className="rbar-track">
        <div className="rbar-centre" />
        <div
          className={`rbar-fill ${positive ? 'pos' : 'neg'}`}
          style={{ left: positive ? '50%' : `${50 - width}%`, width: `${width}%` }}
        />
      </div>
      <div className={`rbar-val ${positive ? 'pos' : 'neg'}`}>{pcm >= 0 ? '+' : ''}{Math.round(pcm)}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={`ctl-slider${disabled ? ' disabled' : ''}`}>
      <div className="ctl-slider-head">
        <span>{label}</span>
        <span className="ctl-slider-val">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// ---- formatting ----
const fmt = (n: number, d = 1) => n.toFixed(d);
function fmtPeriod(s: number, stableLabel: string): string {
  if (!Number.isFinite(s) || Math.abs(s) >= 1e6) return `∞ · ${stableLabel}`;
  if (Math.abs(s) >= 1000) return `${Math.round(s)}`;
  return s.toFixed(1);
}

function criticalityLabel(st: ReactorState, t: (k: string) => string): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  if (st.mode === ReactorMode.Meltdown) return { text: 'MELTDOWN', tone: 'danger' };
  if (st.isScrammed) return { text: t('reactor.scrammed'), tone: 'danger' };
  if (st.reactivityPcm > 5) return { text: t('reactor.supercritical'), tone: 'warn' };
  if (st.reactivityPcm > -50) return { text: t('reactor.critical'), tone: 'ok' };
  return { text: t('reactor.subcritical'), tone: 'ok' };
}

export function ReactorView() {
  const { t } = useTranslation();
  const sim = useReactorSim();
  const st = sim.state;

  const avgInsertion = st.rodBankInsertion.reduce((a, b) => a + b, 0) / st.rodBankInsertion.length;
  const rodWithdrawal = 100 - avgInsertion;
  const crit = criticalityLabel(st, t);
  const powerPct = st.neutronPowerFraction * 100;
  const modeButtons: { m: ReactorMode; key: string }[] = [
    { m: ReactorMode.Shutdown, key: 'reactor.modeShutdown' },
    { m: ReactorMode.Startup, key: 'reactor.modeStartup' },
    { m: ReactorMode.Run, key: 'reactor.modeRun' },
  ];

  const fuelTone = st.fuelTemp > 1200 ? 'danger' : st.fuelTemp > 900 ? 'warn' : undefined;
  const rho = st.reactivity;

  return (
    <div className="reactor">
      <div className="reactor-hero">
        <div className="reactor-hero-top">
          <div>
            <h1 style={{ margin: '0 0 6px' }}>★ {t('reactor.title')}</h1>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('reactor.subtitle')}</p>
          </div>
          <div className="reactor-status">
            <span className={`badge tone-${crit.tone}`}>{crit.text}</span>
            <span className="badge mode-badge">{t(`reactor.mode${st.mode}`) ?? st.mode}</span>
            {st.rodsDropping && <span className="badge tone-warn">↓ {t('reactor.rodsDropping')}</span>}
            {st.lastTripEn && st.isScrammed && (
              <span className="trip-note">{t('reactor.trips')}: {st.lastTripEn}</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- primary gauges (the four control-room instruments) ---- */}
      <div className="gauges">
        <Gauge
          primary
          label={t('reactor.power')}
          value={fmt(st.thermalPowerMW, 1)}
          unit="MWₜ"
          sub={`${fmt(powerPct, powerPct < 10 ? 3 : 1)} ${t('reactor.rtp')}`}
          tone="accent"
        />
        <Gauge
          primary
          label={t('reactor.reactivity')}
          value={`${st.reactivityPcm >= 0 ? '+' : ''}${Math.round(st.reactivityPcm)}`}
          unit="pcm"
          sub={`k-eff ${st.keff.toFixed(5)}`}
          tone={st.reactivityPcm > 5 ? 'warn' : st.reactivityPcm > -50 ? 'ok' : undefined}
        />
        <Gauge
          primary
          label={t('reactor.fuelTemp')}
          value={fmt(st.fuelTemp, 1)}
          unit="°C"
          tone={fuelTone}
        />
        <Gauge
          primary
          label={t('reactor.coolantTemp')}
          value={fmt(st.tavg, 1)}
          unit="°C"
          sub={`${t('reactor.hotLeg')} ${fmt(st.thot, 0)} · ${t('reactor.coldLeg')} ${fmt(st.tcold, 0)}`}
        />
      </div>

      {/* ---- supporting readouts ---- */}
      <div className="gauges gauges-sm">
        <Gauge label={t('reactor.electricPower')} value={fmt(st.electricPowerMW, 0)} unit="MWe" />
        <Gauge label={t('reactor.period')} value={fmtPeriod(st.reactorPeriodSeconds, t('reactor.stable'))} unit="s" />
        <Gauge label={t('reactor.primaryPressure')} value={fmt(st.primaryPressure, 2)} unit="MPa" />
        <Gauge label={t('reactor.coolantFlow')} value={fmt(st.coolantFlowFraction * 100, 0)} unit="%" />
        <Gauge label={t('reactor.boron')} value={fmt(st.boronPpm, 0)} unit="ppm" />
        <Gauge label={t('reactor.decayHeat')} value={fmt(st.decayHeatFraction * 100, 2)} unit="%" />
        <Gauge label={t('reactor.xenon')} value={st.xenon.toFixed(2)} sub={`Sm ${st.samarium.toFixed(2)}`} />
        <Gauge
          label={t('reactor.burnup')}
          value={fmt(st.burnupMwdPerTonne, 0)}
          unit="MWd/t"
          sub={`${st.coreLifePhase} · ${fmt(st.cycleFraction * 100, 0)}%`}
        />
      </div>

      <div className="reactor-grid">
        {/* ---- reactivity balance ---- */}
        <section className="panel">
          <h2 className="panel-title">{t('reactor.breakdown')}</h2>
          <ReactivityBar label={t('reactor.rodWorth')} pcm={rho.rod} />
          <ReactivityBar label={t('reactor.boronWorth')} pcm={rho.boron} />
          <ReactivityBar label={t('reactor.dopplerWorth')} pcm={rho.doppler} />
          <ReactivityBar label={t('reactor.moderatorWorth')} pcm={rho.moderator} />
          <ReactivityBar label={t('reactor.xenonWorth')} pcm={rho.xenon} />
          <ReactivityBar label={t('reactor.samariumWorth')} pcm={rho.samarium} />
        </section>

        {/* ---- trends ---- */}
        <section className="panel">
          <h2 className="panel-title">{t('reactor.trends')}</h2>
          <div className="trend">
            <div className="trend-label">{t('reactor.powerTrend')}</div>
            <Sparkline points={sim.history} accessor={(p) => p.powerPct} color="var(--accent)" />
          </div>
          <div className="trend">
            <div className="trend-label">{t('reactor.reactivityTrend')}</div>
            <Sparkline points={sim.history} accessor={(p) => p.reactivityPcm} color="var(--web)" zero />
          </div>
        </section>

        {/* ---- controls ---- */}
        <section className="panel panel-controls">
          <h2 className="panel-title">{t('reactor.controls')}</h2>

          <div className="mode-row">
            {modeButtons.map((b) => (
              <button
                key={b.m}
                className={`mode-btn${st.mode === b.m ? ' active' : ''}`}
                disabled={st.mode === ReactorMode.Meltdown}
                onClick={() => sim.setMode(b.m)}
              >
                {t(b.key)}
              </button>
            ))}
          </div>

          <Slider
            label={t('reactor.rodsWithdrawn')}
            value={rodWithdrawal}
            min={0}
            max={100}
            step={1}
            display={`${Math.round(rodWithdrawal)}% ${rodWithdrawal > 98 ? t('reactor.fullyWithdrawn') : rodWithdrawal < 2 ? t('reactor.fullyInserted') : ''}`}
            disabled={st.isScrammed || st.mode === ReactorMode.Meltdown}
            onChange={(v) => sim.setAllRods(100 - v)}
          />
          <Slider
            label={t('reactor.targetBoron')}
            value={st.targetBoronPpm}
            min={0}
            max={2000}
            step={10}
            display={`${Math.round(st.targetBoronPpm)} ppm`}
            onChange={(v) => sim.setTargetBoron(v)}
          />
          <Slider
            label={t('reactor.rcpFlow')}
            value={st.rcpFlowDemand}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(st.rcpFlowDemand * 100)}% → ${Math.round(st.coolantFlowFraction * 100)}%`}
            onChange={(v) => {
              sim.setRcps(v > 0);
              sim.setRcpFlowDemand(v);
            }}
          />
          <Slider
            label={t('reactor.feedwater')}
            value={st.feedwaterFlow}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(st.feedwaterFlow * 100)}%`}
            onChange={(v) => sim.setFeedwaterFlow(v)}
          />

          <label className="ctl-toggle">
            <input type="checkbox" checked={st.easyStartupMode} onChange={(e) => sim.setEasyStartup(e.target.checked)} />
            <span>{t('reactor.easyStartup')}</span>
          </label>

          <div className="ctl-row">
            <label className="ctl-speed">
              {t('reactor.speed')}{sim.speed}
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={sim.speed}
                onChange={(e) => sim.setSpeed(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="ctl-buttons">
            <button className="btn" onClick={() => sim.setRunning(!sim.running)}>
              {sim.running ? t('reactor.pause') : t('reactor.start')}
            </button>
            <button className="btn secondary" onClick={sim.warmStart}>
              {t('reactor.warmStart')}
            </button>
            <button className="btn secondary" onClick={sim.reset}>
              {t('reactor.reset')}
            </button>
            <button className="btn scram-btn" onClick={sim.scram}>
              {t('reactor.scram')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
