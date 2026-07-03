import { useEffect, useMemo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

// ── Tuning constants (ported verbatim from ComputeMineService.cs) ──────────────
const MAX_DRAW_MW = 600.0; // slider ceiling
const TH_PER_MW = 0.9; // ~0.9 TH/s produced per MW drawn
const BASE_PRICE_USD_PER_TH_HOUR = 0.42; // baseline earnings rate per TH/s per hour
const TURBO_MULTIPLIER = 1.25; // Reactor-Bank turbo perk → permanent +25% hashrate

// Difficulty walk bounds.
const DIFF_MIN = 0.6;
const DIFF_MAX = 1.8;

// Self-contained reactor-output control ceilings (mirrors the WinForge OutputBar Maximum=1150).
const REACTOR_MAX_MW = 1150.0;

const TICK_MS = 500; // matches the WinForge DispatcherTimer interval

// ── Sim state ────────────────────────────────────────────────────────────────
interface SimState {
  mining: boolean;
  ticks: number;
  difficulty: number; // [0.6 .. 1.8]
  diffDir: number; // +1 / -1
  hashrateThs: number; // current TH/s (0 when not generating)
  drawnMW: number; // MW actually consumed this tick
  totalEarnedUsd: number;
  totalThHashed: number;
  generating: boolean; // last-known reactor-generating state
  // Operator inputs / self-contained reactor model
  setpointMW: number; // operator power-draw setpoint (slider)
  turbo: boolean; // turbo-rigs perk owned
  reactorOutputMW: number; // available reactor output (operator-controlled here)
  reactorOnline: boolean; // reactor generating toggle
}

function initialState(): SimState {
  return {
    mining: false,
    ticks: 0,
    difficulty: 1.0,
    diffDir: 1,
    hashrateThs: 0,
    drawnMW: 0,
    totalEarnedUsd: 0,
    totalThHashed: 0,
    generating: false,
    setpointMW: 0,
    turbo: false,
    reactorOutputMW: 900,
    reactorOnline: true,
  };
}

type Action =
  | { type: 'tick'; dtSeconds: number }
  | { type: 'toggleMining' }
  | { type: 'sell' }
  | { type: 'reset' }
  | { type: 'setSetpoint'; mw: number }
  | { type: 'setTurbo'; on: boolean }
  | { type: 'setReactorOutput'; mw: number }
  | { type: 'setReactorOnline'; on: boolean };

// Current spot price per TH/s per hour, softened by difficulty (higher difficulty = lower yield).
function priceUsdPerThHour(difficulty: number): number {
  const d = difficulty <= 0.01 ? 0.01 : difficulty;
  const p = BASE_PRICE_USD_PER_TH_HOUR / d;
  return Number.isNaN(p) || !Number.isFinite(p) ? 0 : Math.max(0, p);
}

// Energy efficiency in Joules per TH. Lower is better. 0 when idle.
function joulesPerTh(drawnMW: number, hashrateThs: number): number {
  if (hashrateThs <= 0.0001) return 0;
  const watts = drawnMW * 1_000_000.0;
  const jth = watts / hashrateThs;
  return Number.isNaN(jth) || !Number.isFinite(jth) ? 0 : jth;
}

// Whether the reactor is actually producing usable power right now.
function reactorGenerating(s: SimState): boolean {
  return s.reactorOnline && s.reactorOutputMW > 1.0;
}

// Advance the simulation by dtSeconds. Ported faithfully from ComputeMineService.Tick.
function step(s: SimState, dtSeconds: number): SimState {
  const ticks = s.ticks + 1;
  const generating = reactorGenerating(s);

  const dt = Number.isNaN(dtSeconds) || dtSeconds < 0 ? 0 : Math.min(dtSeconds, 2.0);

  // Slow difficulty walk driven by the integer tick counter (no wall-clock).
  let difficulty = s.difficulty;
  let diffDir = s.diffDir;
  if (ticks % 8 === 0) {
    difficulty += diffDir * 0.03;
    if (difficulty >= DIFF_MAX) {
      difficulty = DIFF_MAX;
      diffDir = -1;
    } else if (difficulty <= DIFF_MIN) {
      difficulty = DIFF_MIN;
      diffDir = 1;
    }
  }

  // Clamp the operator's request to what's physically available.
  const avail = Number.isNaN(s.reactorOutputMW) || s.reactorOutputMW < 0 ? 0 : s.reactorOutputMW;
  const want = Number.isNaN(s.setpointMW) || s.setpointMW < 0 ? 0 : s.setpointMW;
  const cap = Math.min(MAX_DRAW_MW, avail);
  const target = Math.max(0, Math.min(want, cap));

  if (!s.mining || !generating) {
    // Starved / disarmed: no draw, no hash, no earnings.
    return {
      ...s,
      ticks,
      generating,
      difficulty,
      diffDir,
      drawnMW: 0,
      hashrateThs: 0,
    };
  }

  // Spend-gated perk: owning the Reactor-Bank turbo perk permanently boosts hashrate +25%.
  const boost = s.turbo ? TURBO_MULTIPLIER : 1.0;

  const drawnMW = target;
  const hashrateThs = Math.max(0, target * TH_PER_MW * boost);

  // Earnings = hashrate (TH/s) * price (USD per TH/s per hour) * elapsed hours.
  const hours = dt / 3600.0;
  const earned = hashrateThs * priceUsdPerThHour(difficulty) * hours;
  let totalEarnedUsd = s.totalEarnedUsd;
  if (!Number.isNaN(earned) && Number.isFinite(earned) && earned > 0) {
    totalEarnedUsd += earned;
  }

  const thisHash = hashrateThs * dt; // TH hashed this tick
  let totalThHashed = s.totalThHashed;
  if (!Number.isNaN(thisHash) && Number.isFinite(thisHash) && thisHash > 0) {
    totalThHashed += thisHash;
  }

  if (totalEarnedUsd > 1e12) totalEarnedUsd = 1e12; // sanity cap

  return {
    ...s,
    ticks,
    generating,
    difficulty,
    diffDir,
    drawnMW,
    hashrateThs,
    totalEarnedUsd,
    totalThHashed,
  };
}

function reducer(s: SimState, a: Action): SimState {
  switch (a.type) {
    case 'tick':
      return step(s, a.dtSeconds);
    case 'toggleMining':
      return { ...s, mining: !s.mining };
    case 'sell':
      return { ...s, totalEarnedUsd: 0 };
    case 'reset':
      return { ...initialState(), reactorOutputMW: s.reactorOutputMW, reactorOnline: s.reactorOnline, turbo: s.turbo };
    case 'setSetpoint':
      return { ...s, setpointMW: Math.max(0, Math.min(MAX_DRAW_MW, a.mw)) };
    case 'setTurbo':
      return { ...s, turbo: a.on };
    case 'setReactorOutput':
      return { ...s, reactorOutputMW: Math.max(0, Math.min(REACTOR_MAX_MW, a.mw)) };
    case 'setReactorOnline':
      return { ...s, reactorOnline: a.on };
    default:
      return s;
  }
}

export function ComputeMineModule() {
  const { t } = useTranslation();
  const [s, dispatch] = useReducer(reducer, undefined, initialState);

  // Tick loop — matches the WinForge 500 ms timer; dt is the real elapsed time (clamped in step()).
  useEffect(() => {
    const id = window.setInterval(() => {
      dispatch({ type: 'tick', dtSeconds: TICK_MS / 1000 });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const generating = reactorGenerating(s);
  const running = s.mining && generating && s.hashrateThs > 0;

  const price = useMemo(() => priceUsdPerThHour(s.difficulty), [s.difficulty]);
  const jth = joulesPerTh(s.drawnMW, s.hashrateThs);

  // Reactor meter colour (grey idle / orange low / amber moderate / green strong).
  const meterColor = !generating
    ? '#9A9A9A'
    : s.reactorOutputMW > 800
      ? '#3DD56A'
      : s.reactorOutputMW > 300
        ? '#E6B42A'
        : '#E06C3A';

  const hashColor = running ? '#3DD56A' : '#9A9A9A';

  const outputPct = Math.max(0, Math.min(100, (s.reactorOutputMW / REACTOR_MAX_MW) * 100));

  const needPower = !generating;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('computemine.blurb')}
      </p>

      {/* Empty state: reactor not generating */}
      {needPower && (
        <div
          className="status-pill"
          style={{
            display: 'block',
            padding: '12px 14px',
            marginBottom: 14,
            borderRadius: 8,
            background: 'rgba(224, 108, 58, 0.12)',
            border: '1px solid rgba(224, 108, 58, 0.4)',
          }}
        >
          <div style={{ fontWeight: 600 }}>{t('computemine.haltedTitle')}</div>
          <div className="count-note" style={{ margin: '4px 0 0' }}>
            {t('computemine.haltedMsg')}
          </div>
        </div>
      )}

      {/* Live reactor output the mine feeds on */}
      <div className="panel" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('computemine.reactorTitle')}</span>
          <span className="count-note" style={{ margin: 0 }}>
            {t('computemine.reactorMode', { mode: s.reactorOnline ? t('computemine.modeOnline') : t('computemine.modeOffline') })}
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 5,
            background: 'rgba(128,128,128,0.2)',
            overflow: 'hidden',
            margin: '10px 0',
          }}
        >
          <div style={{ width: `${outputPct}%`, height: '100%', background: meterColor, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, color: meterColor }}>{s.reactorOutputMW.toFixed(1)} MWe</div>

        {/* Self-contained reactor controls (stands in for the live reactor feed) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.reactorOnline}
              onChange={(e) => dispatch({ type: 'setReactorOnline', on: e.target.checked })}
            />
            {t('computemine.reactorOnline')}
          </label>
          <span className="count-note" style={{ margin: 0 }}>
            {t('computemine.reactorOutputLabel', { mw: s.reactorOutputMW.toFixed(0) })}
          </span>
          <input
            type="range"
            min={0}
            max={REACTOR_MAX_MW}
            step={10}
            value={s.reactorOutputMW}
            onChange={(e) => dispatch({ type: 'setReactorOutput', mw: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* Mine controls */}
      <div className="panel" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{t('computemine.mineTitle')}</div>
        <p className="count-note" style={{ marginTop: 6 }}>
          {t('computemine.mineHint')}
        </p>
        <p style={{ margin: '6px 0', fontSize: 13, color: s.turbo ? '#3DD56A' : '#9A9A9A' }}>
          {s.turbo ? t('computemine.turboActive') : t('computemine.turboHint')}
        </p>
        <label className="chk" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={s.turbo} onChange={(e) => dispatch({ type: 'setTurbo', on: e.target.checked })} />
          {t('computemine.turboToggle')}
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('computemine.drawLabel', { mw: s.setpointMW.toFixed(0) })}
          </span>
          <input
            type="range"
            min={0}
            max={MAX_DRAW_MW}
            step={5}
            value={s.setpointMW}
            onChange={(e) => dispatch({ type: 'setSetpoint', mw: Number(e.target.value) })}
          />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="mini" disabled={needPower} onClick={() => dispatch({ type: 'toggleMining' })}>
            {s.mining ? t('computemine.stopMining') : t('computemine.startMining')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'sell' })}>
            {t('computemine.sell')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
            {t('computemine.reset')}
          </button>
        </div>
      </div>

      {/* Mine readouts */}
      <div className="panel" style={{ padding: '14px 16px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('computemine.statsTitle')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
          <div>
            <div className="count-note" style={{ margin: 0, fontSize: 12 }}>
              {t('computemine.hashCaption')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: hashColor }}>{s.hashrateThs.toFixed(1)} TH/s</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0, fontSize: 12 }}>
              {t('computemine.earnedCaption')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              ${s.totalEarnedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0, fontSize: 12 }}>
              {t('computemine.powerCaption')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{s.drawnMW.toFixed(1)} MW</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0, fontSize: 12 }}>
              {t('computemine.effCaption')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              {jth <= 0.0001 ? t('computemine.idle') : `${(jth / 1_000_000_000.0).toFixed(2)} GJ/TH`}
            </div>
          </div>
          <div style={{ gridColumn: '1 / span 2' }}>
            <div className="count-note" style={{ margin: 0, fontSize: 12 }}>
              {t('computemine.priceCaption')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              ${price.toFixed(3)}/TH·h · {t('computemine.difficulty', { diff: s.difficulty.toFixed(2) })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
