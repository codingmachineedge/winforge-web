import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// --- fixed plant characteristics (ported verbatim from H2PlantService) ---
const PLANT_CAPACITY_MW = 500.0; // max load the electrolysers can draw
const REACTOR_MAX_MWE = 1150.0; // full station output, for the "available" meter
const PEAK_KG_PER_MWH = 20.0; // kg H2 per MWh at full stack temperature
const TANK_CAPACITY_KG = 50000.0; // storage tank cap

// temperature model (arbitrary 0..1 "warmth", stands in for stack °C)
const WARM_UP_PER_SECOND = 0.02; // ~50 s of powered run to reach full warmth
const COOL_DOWN_PER_SECOND = 0.035; // cools faster than it warms when idle
const AMBIENT_WARMTH = 0.0;

const TICK_MS = 500; // matches the C# DispatcherTimer interval

// meter accents
const GREEN_ACCENT = '#3FB950';
const AMBER_ACCENT = '#E09F2A';
const IDLE_ACCENT = '#7A7A7A';

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Reactor snapshot the plant reads each tick. In WinForge this comes live from
 * ReactorStatusApiService; here the operator drives it directly so the module is
 * self-contained. The plant Tick logic below is ported faithfully from the C# service.
 */
interface ReactorInputs {
  reactorOutputMW: number; // operator-set station electrical output (MWe)
  reactorGenerating: boolean; // reactor is generating
  coldShutdown: boolean; // MODE 5 cold shutdown (no usable power)
  scrammed: boolean; // reactor is tripped
}

interface PlantState extends ReactorInputs {
  // operator inputs
  requestedLoadMW: number;
  running: boolean;

  // live state
  ticks: number;
  warmth: number; // 0..1 stack temperature fraction
  drawnMW: number; // actual MW consumed this tick
  rateKgPerHour: number; // instantaneous production rate
  tankKg: number; // hydrogen currently stored
  totalProducedKg: number; // lifetime production

  // reactor-derived, mirrored for the UI
  reactorAvailableMW: number;
  reactorMode: string;
  reactorGeneratingResolved: boolean;
}

const initialState: PlantState = {
  reactorOutputMW: 1150,
  reactorGenerating: true,
  coldShutdown: false,
  scrammed: false,
  requestedLoadMW: 300,
  running: false,
  ticks: 0,
  warmth: 0,
  drawnMW: 0,
  rateKgPerHour: 0,
  tankKg: 0,
  totalProducedKg: 0,
  reactorAvailableMW: 0,
  reactorMode: '-',
  reactorGeneratingResolved: false,
};

// derived helpers matching the C# computed properties
function stackTempC(warmth: number): number {
  return 150.0 + warmth * 700.0;
}
function efficiencyKgPerMWh(warmth: number): number {
  return PEAK_KG_PER_MWH * warmth;
}
function tankFillFraction(tankKg: number): number {
  return TANK_CAPACITY_KG <= 0 ? 0 : clamp(tankKg / TANK_CAPACITY_KG, 0, 1);
}
function powerAvailable(s: PlantState): boolean {
  return s.reactorGeneratingResolved && s.reactorAvailableMW > 1.0 && s.reactorMode !== '5';
}

type Action =
  | { type: 'tick'; dt: number }
  | { type: 'setRunning'; value: boolean }
  | { type: 'setRequestedLoad'; value: number }
  | { type: 'setReactorOutput'; value: number }
  | { type: 'setReactorGenerating'; value: boolean }
  | { type: 'setColdShutdown'; value: boolean }
  | { type: 'setScrammed'; value: boolean }
  | { type: 'vent' }
  | { type: 'reset' };

/** Faithful port of H2PlantService.Tick(dt, reactor). */
function tick(state: PlantState, dtRaw: number): PlantState {
  let dt = dtRaw;
  if (Number.isNaN(dt) || !Number.isFinite(dt)) dt = 0;
  dt = clamp(dt, 0, 1.0);

  const ticks = state.ticks + 1;

  // Read the reactor safely (operator-driven snapshot).
  const rawElectric = state.reactorOutputMW;
  const avail = Number.isNaN(rawElectric) || !Number.isFinite(rawElectric) ? 0 : Math.max(0, rawElectric);
  const generating = state.reactorGenerating;
  const mode = state.coldShutdown ? '5' : '1';
  const scrammed = state.scrammed;

  const reactorAvailableMW = avail;
  const reactorMode = mode;
  // cold MODE 5 or a scram means no usable generation, whatever the flag says
  const coldOrTripped = scrammed || mode === '5';
  const reactorGeneratingResolved = generating && !coldOrTripped && avail > 1.0;

  // How much can we actually draw right now?
  const powered = state.running && reactorGeneratingResolved;
  const reqLoad = Number.isNaN(state.requestedLoadMW) ? 0 : state.requestedLoadMW;
  const want = clamp(reqLoad, 0, PLANT_CAPACITY_MW);
  const ceiling = Math.min(PLANT_CAPACITY_MW, Math.max(0, reactorAvailableMW));
  const drawnMW = powered ? Math.min(want, ceiling) : 0;

  // Stack temperature ramp: warms only while genuinely drawing power.
  let warmth = state.warmth;
  if (drawnMW > 1.0) warmth += WARM_UP_PER_SECOND * dt;
  else warmth -= COOL_DOWN_PER_SECOND * dt;
  warmth = clamp(warmth, AMBIENT_WARMTH, 1.0);

  // Production this tick.
  let rateKgPerHour: number;
  let tankKg = state.tankKg;
  let totalProducedKg = state.totalProducedKg;
  if (drawnMW > 0.0 && warmth > 0.0) {
    rateKgPerHour = drawnMW * efficiencyKgPerMWh(warmth); // MW * (kg/MWh) = kg/h
    let producedKg = rateKgPerHour * (dt / 3600.0);
    if (Number.isNaN(producedKg) || !Number.isFinite(producedKg)) producedKg = 0;
    const room = Math.max(0, TANK_CAPACITY_KG - tankKg);
    const stored = Math.min(producedKg, room);
    tankKg = clamp(tankKg + stored, 0, TANK_CAPACITY_KG);
    totalProducedKg += stored;
  } else {
    rateKgPerHour = 0;
  }

  return {
    ...state,
    ticks,
    warmth,
    drawnMW,
    rateKgPerHour,
    tankKg,
    totalProducedKg,
    reactorAvailableMW,
    reactorMode,
    reactorGeneratingResolved,
  };
}

function reducer(state: PlantState, action: Action): PlantState {
  switch (action.type) {
    case 'tick':
      return tick(state, action.dt);
    case 'setRunning':
      return { ...state, running: action.value };
    case 'setRequestedLoad':
      return { ...state, requestedLoadMW: clamp(action.value, 0, PLANT_CAPACITY_MW) };
    case 'setReactorOutput':
      return { ...state, reactorOutputMW: clamp(action.value, 0, REACTOR_MAX_MWE) };
    case 'setReactorGenerating':
      return { ...state, reactorGenerating: action.value };
    case 'setColdShutdown':
      return { ...state, coldShutdown: action.value };
    case 'setScrammed':
      return { ...state, scrammed: action.value };
    case 'vent':
      // Empty the storage tank. Lifetime total is preserved.
      return { ...state, tankKg: 0 };
    case 'reset':
      // Full reset — clears warmth, tank, totals and stops the plant.
      // Reactor inputs are left as-is (they are the "environment").
      return {
        ...state,
        running: false,
        requestedLoadMW: 0,
        warmth: 0,
        drawnMW: 0,
        rateKgPerHour: 0,
        tankKg: 0,
        totalProducedKg: 0,
      };
    default:
      return state;
  }
}

export function H2PlantModule() {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, initialState);
  const lastTickRef = useRef<number>(Date.now());

  useEffect(() => {
    lastTickRef.current = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      const dt = clamp((now - lastTickRef.current) / 1000, 0.0, 1.0);
      lastTickRef.current = now;
      dispatch({ type: 'tick', dt });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const isPowerAvailable = powerAvailable(state);
  const warmthPct = clamp(state.warmth * 100.0, 0, 100);
  const fillPct = clamp(tankFillFraction(state.tankKg) * 100.0, 0, 100);
  const availPct = clamp((state.reactorAvailableMW / REACTOR_MAX_MWE) * 100, 0, 100);

  let runStatus: string;
  if (!state.running) runStatus = t('h2plant.runIdle');
  else if (!isPowerAvailable) runStatus = t('h2plant.runArmed');
  else runStatus = t('h2plant.runRunning', { mw: state.drawnMW.toFixed(0) });

  const availColor = isPowerAvailable ? GREEN_ACCENT : IDLE_ACCENT;
  const warmthColor = state.warmth >= 0.9 ? GREEN_ACCENT : AMBER_ACCENT;
  const tankColor = fillPct >= 95 ? AMBER_ACCENT : GREEN_ACCENT;

  const bar = (pct: number, color: string, height: number) => (
    <div
      style={{
        width: '100%',
        height,
        background: 'rgba(127,127,127,0.2)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('h2plant.blurb')}
      </p>

      {/* Empty state: no nuclear power */}
      {!isPowerAvailable && (
        <div className="panel" style={{ borderLeft: `4px solid ${AMBER_ACCENT}`, padding: '10px 14px', marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>{t('h2plant.idleTitle')}</div>
          <div className="count-note" style={{ margin: '4px 0 0' }}>
            {t('h2plant.idleMessage')}
          </div>
        </div>
      )}

      {/* Reactor output available */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
            {t('h2plant.reactorTitle')}
          </h3>
          <span className="count-note" style={{ margin: 0 }}>
            {t('h2plant.reactorMode', { mode: state.reactorMode })}
          </span>
        </div>
        {bar(availPct, availColor, 8)}
        <span className="count-note" style={{ margin: 0 }}>
          {t('h2plant.availableText', {
            avail: state.reactorAvailableMW.toFixed(0),
            max: REACTOR_MAX_MWE.toFixed(0),
          })}
        </span>

        {/* Reactor operator inputs (self-contained stand-in for the live snapshot) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('h2plant.reactorOutputLabel', { mw: state.reactorOutputMW.toFixed(0) })}
          </span>
          <input
            type="range"
            min={0}
            max={REACTOR_MAX_MWE}
            step={10}
            value={state.reactorOutputMW}
            onChange={(e) => dispatch({ type: 'setReactorOutput', value: +e.target.value })}
          />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label className="chk">
              <input
                type="checkbox"
                checked={state.reactorGenerating}
                onChange={(e) => dispatch({ type: 'setReactorGenerating', value: e.target.checked })}
              />
              {t('h2plant.reactorGeneratingLabel')}
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={state.coldShutdown}
                onChange={(e) => dispatch({ type: 'setColdShutdown', value: e.target.checked })}
              />
              {t('h2plant.coldShutdownLabel')}
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={state.scrammed}
                onChange={(e) => dispatch({ type: 'setScrammed', value: e.target.checked })}
              />
              {t('h2plant.scrammedLabel')}
            </label>
          </div>
        </div>
      </div>

      {/* Plant controls */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
              {t('h2plant.runTitle')}
            </h3>
            <span className="count-note" style={{ margin: 0 }}>
              {runStatus}
            </span>
          </div>
          <label className="chk">
            <input
              type="checkbox"
              checked={state.running}
              onChange={(e) => dispatch({ type: 'setRunning', value: e.target.checked })}
            />
            {t('h2plant.runToggle')}
          </label>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('h2plant.loadLabel', {
              load: state.requestedLoadMW.toFixed(0),
              max: PLANT_CAPACITY_MW.toFixed(0),
            })}
          </span>
          <input
            type="range"
            min={0}
            max={PLANT_CAPACITY_MW}
            step={10}
            value={state.requestedLoadMW}
            onChange={(e) => dispatch({ type: 'setRequestedLoad', value: +e.target.value })}
          />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="mini" disabled={state.tankKg <= 0.5} onClick={() => dispatch({ type: 'vent' })}>
            {t('h2plant.ventButton')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
            {t('h2plant.resetButton')}
          </button>
        </div>
      </div>

      {/* Live readouts */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('h2plant.readoutTitle')}
        </h3>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            columnGap: 16,
            rowGap: 8,
          }}
        >
          <span>{t('h2plant.drawnValue', { mw: state.drawnMW.toFixed(1) })}</span>
          <span>{t('h2plant.rateValue', { rate: state.rateKgPerHour.toFixed(1) })}</span>
          <span>{t('h2plant.stackValue', { temp: stackTempC(state.warmth).toFixed(0) })}</span>
          <span>{t('h2plant.effValue', { eff: efficiencyKgPerMWh(state.warmth).toFixed(1) })}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('h2plant.warmthLabel', { pct: warmthPct.toFixed(0) })}
          </span>
          {bar(warmthPct, warmthColor, 8)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('h2plant.tankLabel', {
              kg: state.tankKg.toFixed(0),
              cap: TANK_CAPACITY_KG.toFixed(0),
              pct: fillPct.toFixed(0),
            })}
          </span>
          {bar(fillPct, tankColor, 10)}
        </div>

        <div style={{ fontWeight: 600 }}>
          {t('h2plant.totalValue', { kg: state.totalProducedKg.toFixed(0) })}
        </div>
      </div>
    </div>
  );
}
