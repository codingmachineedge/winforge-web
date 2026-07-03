import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// ---- Tunables (ported verbatim from AiClusterService) ----------------------
const MAX_DRAW_MW = 900.0; // operator draw ceiling (clamped to available)
const PFLOPS_PER_MW = 0.05; // PFLOP/s delivered per MW actually drawn
const SECONDS_PER_TICK = 0.5; // timer cadence (ramps use tick counter)
const TICK_MS = 500; // DispatcherTimer interval in WinForge

const WATTS_PER_PFLOP_DAY = 12.0; // ⚡ awarded per whole PFLOP-day of compute
const OVERCLOCK_MULTIPLIER = 1.3; // +30% throughput when the perk is owned

type ModelSize = 'small' | 'medium' | 'large' | 'frontier';

function targetPflopDays(size: ModelSize): number {
  switch (size) {
    case 'small':
      return 8.0;
    case 'medium':
      return 40.0;
    case 'large':
      return 150.0;
    case 'frontier':
      return 600.0;
    default:
      return 40.0;
  }
}

function sanitize(v: number): boolean {
  return !(Number.isNaN(v) || !Number.isFinite(v));
}
function san(v: number): number {
  return sanitize(v) ? v : 0;
}

// ---- Simulation state (mirrors AiClusterService fields) --------------------
interface SimState {
  running: boolean; // operator armed the run
  stalled: boolean; // paused because reactor can't feed it
  size: ModelSize;
  drawnMW: number; // power actually drawn this step
  pflopsNow: number; // instantaneous throughput (PFLOP/s)
  pflopDaysDone: number; // accumulated compute toward the run
  gpuUtilPct: number; // 0..100
  rackTempC: number; // idle ambient 24
  checkpoints: number; // how many times we checkpointed on a stall
  overclockActive: boolean; // permanent +30% perk
  pflopDaysAwarded: number; // PFLOP-days already awarded to the economy
  earnedWatts: number; // ⚡ earned so far this run
  ticks: number; // internal deterministic counter
  rampUtil: number; // smoothed utilisation ramp 0..1
}

function initSim(): SimState {
  return {
    running: false,
    stalled: false,
    size: 'medium',
    drawnMW: 0,
    pflopsNow: 0,
    pflopDaysDone: 0,
    gpuUtilPct: 0,
    rackTempC: 24.0,
    checkpoints: 0,
    overclockActive: false,
    pflopDaysAwarded: 0,
    earnedWatts: 0,
    ticks: 0,
    rampUtil: 0,
  };
}

function progressPct(s: SimState): number {
  const target = targetPflopDays(s.size);
  if (target <= 0) return 0;
  const p = (s.pflopDaysDone / target) * 100.0;
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

function isComplete(s: SimState): boolean {
  const target = targetPflopDays(s.size);
  return s.pflopDaysDone >= target && target > 0;
}

// ---- Reducer ---------------------------------------------------------------
interface TickArgs {
  requestedMW: number;
  availableMW: number;
  generating: boolean;
}

type Action =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'newRun'; size: ModelSize }
  | { type: 'setSize'; size: ModelSize }
  | { type: 'setOverclock'; on: boolean }
  | { type: 'reset' }
  | { type: 'tick'; args: TickArgs };

function newRunState(prev: SimState, size: ModelSize): SimState {
  return {
    ...prev,
    size,
    pflopDaysDone: 0,
    pflopDaysAwarded: 0,
    earnedWatts: 0,
    running: false,
    stalled: false,
    ticks: 0,
    rampUtil: 0,
    pflopsNow: 0,
    drawnMW: 0,
    gpuUtilPct: 0,
    rackTempC: 24.0,
  };
}

function tickSim(s: SimState, args: TickArgs): SimState {
  const next: SimState = { ...s };
  next.ticks = s.ticks + 1;

  let want = san(args.requestedMW);
  if (want < 0) want = 0;
  if (want > MAX_DRAW_MW) want = MAX_DRAW_MW;

  let avail = san(args.availableMW);
  if (avail < 0) avail = 0;

  // The cluster can only ever draw what the reactor delivers.
  const canFeed = args.generating && avail >= want && want > 0;

  if (s.running && canFeed) {
    if (next.stalled) next.stalled = false; // recovered

    next.drawnMW = want;

    // Smooth utilisation ramp toward full using the tick counter (deterministic).
    let ramp = s.rampUtil + (1.0 - s.rampUtil) * 0.08;
    if (ramp > 1) ramp = 1;
    next.rampUtil = ramp;

    next.gpuUtilPct = Math.round(ramp * 100.0 * 10) / 10;
    next.pflopsNow = next.drawnMW * PFLOPS_PER_MW * ramp * (s.overclockActive ? OVERCLOCK_MULTIPLIER : 1.0);

    // PFLOP-days accrual: PFLOP/s * elapsed seconds -> PFLOP-seconds, /86400 -> PFLOP-days.
    const pflopSeconds = next.pflopsNow * SECONDS_PER_TICK;
    next.pflopDaysDone = s.pflopDaysDone + pflopSeconds / 86400.0;

    const target = targetPflopDays(next.size);
    if (next.pflopDaysDone >= target) {
      next.pflopDaysDone = target;
      next.running = false; // run complete
      next.rampUtil = 0;
    }

    // Rack temperature climbs with load, capped.
    const targetTemp = 24.0 + ramp * 44.0; // up to ~68C at full tilt
    next.rackTempC = s.rackTempC + (targetTemp - s.rackTempC) * 0.1;
  } else {
    // Stalled or idle: checkpoint once on the transition into a stall.
    if (s.running && !canFeed && !next.stalled) {
      next.stalled = true;
      next.checkpoints = s.checkpoints + 1; // checkpoint-and-pause
    }
    if (!s.running) next.stalled = false;

    next.drawnMW = 0;
    next.pflopsNow = 0;
    let ramp = s.rampUtil + (0.0 - s.rampUtil) * 0.15;
    if (ramp < 0.001) ramp = 0;
    next.rampUtil = ramp;
    next.gpuUtilPct = Math.round(ramp * 100.0 * 10) / 10;
    next.rackTempC = s.rackTempC + (24.0 - s.rackTempC) * 0.06; // drift to ambient
  }

  if (next.rackTempC < 20) next.rackTempC = 20;
  if (next.rackTempC > 95) next.rackTempC = 95;

  // Claim any WHOLE PFLOP-days of compute produced since the last claim.
  const pending = next.pflopDaysDone - next.pflopDaysAwarded;
  if (!Number.isNaN(pending) && pending >= 1.0) {
    const whole = Math.floor(pending);
    if (whole > 0) {
      next.pflopDaysAwarded += whole;
      next.earnedWatts = next.pflopDaysAwarded * WATTS_PER_PFLOP_DAY;
    }
  }

  return next;
}

function reducer(state: SimState, action: Action): SimState {
  switch (action.type) {
    case 'start':
      return { ...state, running: true };
    case 'pause':
      return {
        ...state,
        checkpoints: state.running ? state.checkpoints + 1 : state.checkpoints,
        running: false,
        stalled: false,
      };
    case 'newRun':
      return newRunState(state, action.size);
    case 'setSize':
      // Changing the model in the combo starts a fresh run (WinForge NewRun).
      return newRunState(state, action.size);
    case 'setOverclock':
      return { ...state, overclockActive: action.on };
    case 'reset':
      return {
        ...initSim(),
        overclockActive: state.overclockActive,
      };
    case 'tick':
      return tickSim(state, action.args);
    default:
      return state;
  }
}

// ---- Reactor "available output" — self-contained operator control ----------
// WinForge reads live reactor output from ReactorStatusApiService. Client-side
// and self-contained, we let the operator drive the reactor state directly so
// the stall / starve / meltdown empty-states are fully exercisable.
type ReactorMode = 'generating' | 'cold' | 'scrammed' | 'meltdown';

interface UiState {
  drawSetpoint: number; // slider MW
  reactorOutput: number; // MWe available
  reactorMode: ReactorMode;
}

const OUTPUT_MAX = 1150; // matches XAML OutputBar Maximum

function gaugeBar(value: number, max: number, color: string, height = 10) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      style={{
        flex: 1,
        height,
        borderRadius: height / 2,
        background: 'rgba(127,127,127,0.22)',
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.2s linear' }} />
    </div>
  );
}

export function AiClusterModule() {
  const { t } = useTranslation();

  const [sim, dispatch] = useReducer(reducer, undefined, initSim);
  const [ui, setUi] = useReducer(
    (s: UiState, patch: Partial<UiState>): UiState => ({ ...s, ...patch }),
    { drawSetpoint: 0, reactorOutput: 900, reactorMode: 'generating' },
  );

  // Live reactor derivation (mirrors UpdateStep gating).
  const available = ui.reactorMode === 'generating' ? Math.max(0, san(ui.reactorOutput)) : 0;
  const scrammed = ui.reactorMode === 'scrammed';
  const meltdown = ui.reactorMode === 'meltdown';
  const generating = ui.reactorMode === 'generating' && available > 1.0;

  // Clamp the draw slider to the available output (never above the service ceiling).
  const sliderMax = Math.min(MAX_DRAW_MW, Math.max(50, Math.round(available <= 1 ? MAX_DRAW_MW : available)));
  const requested = Math.min(san(ui.drawSetpoint), sliderMax);

  // Refs so the interval always ticks with fresh inputs without re-subscribing.
  const inputRef = useRef({ requested, available, generating });
  inputRef.current = { requested, available, generating };

  useEffect(() => {
    // One steady loop: always tick so reactor readouts + rack-temp drift stay
    // live even while idle; the sim itself no-ops when nothing is running.
    const id = window.setInterval(() => {
      const inp = inputRef.current;
      dispatch({ type: 'tick', args: { requestedMW: inp.requested, availableMW: inp.available, generating: inp.generating } });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const target = targetPflopDays(sim.size);
  const prog = progressPct(sim);
  const complete = isComplete(sim);

  // Empty-state gating (mirrors UpdateStep).
  const starved = sim.stalled || !generating || (generating && available < requested && requested > 0);

  // Reactor meter colour.
  const meterColor = !generating
    ? '#9A9A9A'
    : available > 800
      ? '#3DD56A'
      : available > 300
        ? '#E6B42A'
        : '#E06C3A';

  const tempColor = sim.rackTempC > 78 ? '#E06C3A' : sim.rackTempC > 60 ? '#E6B42A' : '#3DD56A';

  // Which empty-state banner (if any) to show.
  let banner: { sev: 'error' | 'warning' | 'success'; title: string; msg: string } | null = null;
  if (meltdown || scrammed || !generating) {
    banner = {
      sev: meltdown ? 'error' : 'warning',
      title: t('aicluster.stallTitle'),
      msg: meltdown
        ? t('aicluster.stallMeltdown')
        : scrammed
          ? t('aicluster.stallScram')
          : t('aicluster.stallCold'),
    };
  } else if (sim.running && starved) {
    banner = {
      sev: 'warning',
      title: t('aicluster.stallTitle'),
      msg: t('aicluster.stallStarved', { available: available.toFixed(1), requested: requested.toFixed(1) }),
    };
  } else if (complete) {
    banner = { sev: 'success', title: t('aicluster.completeTitle'), msg: t('aicluster.completeMsg') };
  }

  const bannerBg =
    banner?.sev === 'error'
      ? 'rgba(224,108,58,0.14)'
      : banner?.sev === 'success'
        ? 'rgba(61,213,106,0.14)'
        : 'rgba(230,180,42,0.14)';
  const bannerBorder =
    banner?.sev === 'error' ? '#E06C3A' : banner?.sev === 'success' ? '#3DD56A' : '#E6B42A';

  const modelOptions: { size: ModelSize; label: string }[] = [
    { size: 'small', label: t('aicluster.modelSmall') },
    { size: 'medium', label: t('aicluster.modelMedium') },
    { size: 'large', label: t('aicluster.modelLarge') },
    { size: 'frontier', label: t('aicluster.modelFrontier') },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aicluster.blurb')}
      </p>

      {/* Needs-power / status banner */}
      {banner && (
        <div
          className="panel"
          style={{
            padding: '12px 14px',
            marginBottom: 14,
            background: bannerBg,
            border: `1px solid ${bannerBorder}`,
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{banner.title}</div>
          <div className="count-note" style={{ margin: 0 }}>
            {banner.msg}
          </div>
        </div>
      )}

      {/* Live reactor output */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('aicluster.reactorTitle')}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {gaugeBar(available, OUTPUT_MAX, meterColor)}
          <span style={{ fontWeight: 600, color: meterColor, minWidth: 92, textAlign: 'right' }}>
            {available.toFixed(1)} MWe
          </span>
        </div>
        <span className="count-note" style={{ margin: 0 }}>
          {t('aicluster.reactorMode', { mode: t(`aicluster.mode_${ui.reactorMode}`) })}
        </span>

        {/* Operator controls for the reactor feed (replaces the cross-module status API). */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
          <select
            className="mod-select"
            value={ui.reactorMode}
            onChange={(e) => setUi({ reactorMode: e.target.value as ReactorMode })}
          >
            <option value="generating">{t('aicluster.mode_generating')}</option>
            <option value="cold">{t('aicluster.mode_cold')}</option>
            <option value="scrammed">{t('aicluster.mode_scrammed')}</option>
            <option value="meltdown">{t('aicluster.mode_meltdown')}</option>
          </select>
          <span className="count-note" style={{ margin: 0 }}>
            {t('aicluster.reactorOutputLabel')}
          </span>
          <input
            type="range"
            min={0}
            max={OUTPUT_MAX}
            step={10}
            value={ui.reactorOutput}
            disabled={ui.reactorMode !== 'generating'}
            onChange={(e) => setUi({ reactorOutput: Math.trunc(+e.target.value) })}
            style={{ flex: 1, minWidth: 160 }}
          />
          <span style={{ fontWeight: 600, minWidth: 78, textAlign: 'right' }}>{ui.reactorOutput} MW</span>
        </div>
      </div>

      {/* Cluster power & run */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('aicluster.clusterTitle')}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('aicluster.drawLabel')}</span>
            <span style={{ fontWeight: 600 }}>{requested.toFixed(0)} MW</span>
          </div>
          <input
            type="range"
            min={0}
            max={sliderMax}
            step={10}
            value={Math.min(ui.drawSetpoint, sliderMax)}
            onChange={(e) => setUi({ drawSetpoint: Math.trunc(+e.target.value) })}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>{t('aicluster.modelLabel')}</span>
          <select
            className="mod-select"
            value={sim.size}
            onChange={(e) => dispatch({ type: 'setSize', size: e.target.value as ModelSize })}
            style={{ minWidth: 220 }}
          >
            {modelOptions.map((o) => (
              <option key={o.size} value={o.size}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="mini"
            onClick={() => dispatch({ type: sim.running ? 'pause' : 'start' })}
          >
            {sim.running ? t('aicluster.pauseRun') : t('aicluster.startRun')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'newRun', size: sim.size })}>
            {t('aicluster.newRun')}
          </button>
          <button className="mini" onClick={() => { dispatch({ type: 'reset' }); setUi({ drawSetpoint: 0 }); }}>
            {t('aicluster.reset')}
          </button>
          <label className="chk" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={sim.overclockActive}
              onChange={(e) => dispatch({ type: 'setOverclock', on: e.target.checked })}
            />
            {t('aicluster.overclockToggle')}
          </label>
        </div>

        <span
          className="count-note"
          style={{ margin: 0, fontWeight: 600, color: sim.overclockActive ? '#3DD56A' : '#9A9A9A' }}
        >
          {sim.overclockActive ? t('aicluster.overclockActive') : t('aicluster.overclockHint')}
        </span>
      </div>

      {/* Training progress + telemetry */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('aicluster.progressTitle')}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.progressCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>{prog.toFixed(1)}%</span>
          </div>
          {gaugeBar(prog, 100, '#3DD56A')}
        </div>

        <div className="kv-list" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.throughputCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>{sim.pflopsNow.toFixed(2)} PFLOP/s</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.computeCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>
              {t('aicluster.computeValue', {
                done: sim.pflopDaysDone.toFixed(3),
                target: target.toFixed(0),
              })}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="count-note" style={{ margin: 0 }}>
                {t('aicluster.gpuCaption')}
              </span>
              <span style={{ fontWeight: 600 }}>{sim.gpuUtilPct.toFixed(0)}%</span>
            </div>
            {gaugeBar(sim.gpuUtilPct, 100, '#3DD56A', 8)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="count-note" style={{ margin: 0 }}>
                {t('aicluster.tempCaption')}
              </span>
              <span style={{ fontWeight: 600 }}>{sim.rackTempC.toFixed(1)} °C</span>
            </div>
            {gaugeBar(sim.rackTempC - 20, 75, tempColor, 8)}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.drawnCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>{sim.drawnMW.toFixed(1)} MW</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.checkpointCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>{sim.checkpoints}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('aicluster.earnCaption')}
            </span>
            <span style={{ fontWeight: 600 }}>{sim.earnedWatts.toFixed(1)} ⚡</span>
          </div>
        </div>
      </div>
    </div>
  );
}
