import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ── Grid market engine (ported faithfully from WinForge GridDispatchService.cs) ──
// A pure-managed simulated electricity market. Demand follows a deterministic sine over an
// internal tick counter (never wall-clock), spot price rises with demand, the operator sells a
// chosen setpoint of the reactor's available MWe, and grid frequency drifts around 60 Hz.

const GRID_BASE_MW = 620.0; // baseline demand
const GRID_SWING_MW = 380.0; // ± demand swing amplitude

interface GridState {
  tick: number; // deterministic internal step counter (NOT wall-clock)
  selling: boolean;
  frequencyHz: number;
  demandMW: number;
  priceUsdPerMWh: number;
  dispatchedMW: number;
  totalRevenueUsd: number;
  totalEnergyMWh: number;
}

function initialGridState(): GridState {
  return {
    tick: 0,
    selling: false,
    frequencyHz: 60.0,
    demandMW: GRID_BASE_MW,
    priceUsdPerMWh: 40.0,
    dispatchedMW: 0,
    totalRevenueUsd: 0,
    totalEnergyMWh: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

interface TickInput {
  dtSeconds: number;
  setpointMW: number;
  availableMW: number;
  generating: boolean;
}

// Faithful port of GridDispatchService.Tick — advance the simulated market one step.
function gridTick(s: GridState, input: TickInput): GridState {
  let dtSeconds = input.dtSeconds;
  if (Number.isNaN(dtSeconds) || !Number.isFinite(dtSeconds)) dtSeconds = 0.5;
  dtSeconds = clamp(dtSeconds, 0.0, 2.0);

  const tick = s.tick + 1;

  // Deterministic demand: two superposed sines over the tick counter for a plausible daily shape.
  const phase = tick * 0.01;
  const shape = 0.62 * Math.sin(phase) + 0.24 * Math.sin(phase * 2.7 + 1.1);
  let demandMW = GRID_BASE_MW + GRID_SWING_MW * shape;
  if (demandMW < 0) demandMW = 0;

  // Spot price rises with demand as a fraction of the swing envelope, plus mild convex scarcity.
  const load = clamp((demandMW - (GRID_BASE_MW - GRID_SWING_MW)) / (2 * GRID_SWING_MW), 0, 1);
  const priceUsdPerMWh = 18.0 + 90.0 * load + 70.0 * load * load;

  let availableMW = input.availableMW;
  let setpointMW = input.setpointMW;
  if (Number.isNaN(availableMW) || !Number.isFinite(availableMW) || availableMW < 0) availableMW = 0;
  if (Number.isNaN(setpointMW) || !Number.isFinite(setpointMW) || setpointMW < 0) setpointMW = 0;

  let dispatchedMW: number;
  let supply: number;
  let totalEnergyMWh = s.totalEnergyMWh;
  let totalRevenueUsd = s.totalRevenueUsd;

  if (s.selling && input.generating && availableMW > 1.0) {
    dispatchedMW = Math.min(setpointMW, availableMW);
    supply = dispatchedMW;

    const hours = dtSeconds / 3600.0;
    const energy = dispatchedMW * hours;
    totalEnergyMWh += energy;
    totalRevenueUsd += energy * priceUsdPerMWh;
  } else {
    dispatchedMW = 0;
    supply = 0;
  }

  // Frequency: over-supply pushes above 60 Hz, under-supply below. Pulls back toward 60.
  const demandForBalance = Math.max(demandMW, 1.0);
  const imbalance = clamp((supply - demandMW) / demandForBalance, -1.0, 1.0);
  const target = 60.0 + imbalance * 0.45;
  let frequencyHz = s.frequencyHz + (target - s.frequencyHz) * 0.25;
  frequencyHz = clamp(frequencyHz, 58.5, 61.5);

  return {
    tick,
    selling: s.selling,
    frequencyHz,
    demandMW,
    priceUsdPerMWh,
    dispatchedMW,
    totalRevenueUsd,
    totalEnergyMWh,
  };
}

type GridAction =
  | { type: 'tick'; input: TickInput }
  | { type: 'startSelling' }
  | { type: 'stopSelling' }
  | { type: 'reset' };

function gridReducer(s: GridState, a: GridAction): GridState {
  switch (a.type) {
    case 'tick':
      return gridTick(s, a.input);
    case 'startSelling':
      return { ...s, selling: true };
    case 'stopSelling':
      return { ...s, selling: false, dispatchedMW: 0 };
    case 'reset':
      return initialGridState();
    default:
      return s;
  }
}

// ── Reactor output source ──
// The WinForge page reads a live reactor via ReactorStatusApiService. In this self-contained
// web port the operator drives a simple reactor-output model directly: a target electric output
// (MWe) that ramps toward the setting, plus a MODE 5 (cold shutdown) / scram gate. This mirrors
// the snapshot fields the C# consumes: ElectricMW, Mode, IsGenerating, IsScrammed.

const TICK_MS = 500; // matches the WinForge DispatcherTimer interval

interface ReactorSrc {
  outputMW: number; // live available MWe (ramps toward target)
  mode: string; // "1" run … "5" cold shutdown
  scrammed: boolean;
}

export function GridDispatchModule() {
  const { t } = useTranslation();

  const [grid, dispatch] = useReducer(gridReducer, undefined, initialGridState);

  // Dispatch setpoint (MWe the operator wants to sell).
  const [setpoint, setSetpoint] = useState(0);

  // Reactor-output source controls.
  const [targetOutputMW, setTargetOutputMW] = useState(950);
  const [coldShutdown, setColdShutdown] = useState(false); // MODE 5
  const [scrammed, setScrammed] = useState(false);

  // Live (ramped) reactor output, held in a ref so the tick loop reads the freshest value.
  const srcRef = useRef<ReactorSrc>({ outputMW: 0, mode: '1', scrammed: false });
  const [availableMW, setAvailableMW] = useState(0);

  // Keep the latest control values available to the interval without re-subscribing each render.
  const setpointRef = useRef(setpoint);
  const targetRef = useRef(targetOutputMW);
  const coldRef = useRef(coldShutdown);
  const scramRef = useRef(scrammed);
  setpointRef.current = setpoint;
  targetRef.current = targetOutputMW;
  coldRef.current = coldShutdown;
  scramRef.current = scrammed;

  const lastTickRef = useRef<number>(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const dt = clamp((now - lastTickRef.current) / 1000, 0.0, 2.0);
      lastTickRef.current = now;

      // Advance the reactor-output source. When cold (MODE 5) or scrammed the target is 0.
      const cold = coldRef.current;
      const scram = scramRef.current;
      const desired = cold || scram ? 0 : Math.max(0, targetRef.current);
      const prev = srcRef.current.outputMW;
      // First-order ramp toward the desired output (≈ same feel as a warming reactor).
      const ramped = prev + (desired - prev) * clamp(dt * 0.5, 0, 1);
      const outputMW = Math.abs(ramped) < 0.05 ? (desired === 0 ? 0 : ramped) : ramped;
      const mode = scram ? '1' : cold ? '5' : outputMW > 1.0 ? '1' : '3';
      srcRef.current = { outputMW, mode, scrammed: scram };

      const available = Number.isNaN(outputMW) || outputMW < 0 ? 0 : outputMW;
      const generating = !scram && !cold && available > 1.0;

      dispatch({
        type: 'tick',
        input: { dtSeconds: dt, setpointMW: setpointRef.current, availableMW: available, generating },
      });
      setAvailableMW(available);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Derived reactor-source view.
  const mode = coldShutdown ? '5' : scrammed ? '1' : availableMW > 1.0 ? '1' : '3';
  const generating = !scrammed && !coldShutdown && availableMW > 1.0;

  // Slider max mirrors the C#: cap dispatch to available output (min 50).
  const sliderMax = Math.max(50, Math.round(availableMW <= 1 ? 1150 : availableMW));
  const effectiveSetpoint = Math.min(setpoint, sliderMax);

  const onSell = () => {
    if (grid.selling) dispatch({ type: 'stopSelling' });
    else dispatch({ type: 'startSelling' });
  };

  const onReset = () => {
    dispatch({ type: 'reset' });
    setSetpoint(0);
  };

  // ── Presentation ──

  const outputColor = !generating
    ? '#9A9A9A'
    : availableMW > 800
      ? '#3DD56A'
      : availableMW > 300
        ? '#E6B42A'
        : '#E06C3A';

  const outputPct = clamp((availableMW / 1150) * 100, 0, 100);

  const freq = grid.frequencyHz;
  const balance =
    !generating || grid.dispatchedMW <= 0
      ? t('griddispatch.noSupply')
      : freq > 60.05
        ? t('griddispatch.overSupply')
        : freq < 59.95
          ? t('griddispatch.underSupply')
          : t('griddispatch.balanced');
  const freqColor = Math.abs(freq - 60.0) < 0.1 ? '#3DD56A' : '#E6B42A';

  const needTitle = t('griddispatch.needTitle');
  const needMsg = scrammed
    ? t('griddispatch.needScrammed')
    : t('griddispatch.needCold');

  const stat = (caption: string, value: string, color?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="count-note" style={{ margin: 0, fontSize: 12 }}>
        {caption}
      </span>
      <span style={{ fontSize: 18, fontWeight: 600, color }}>{value}</span>
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('griddispatch.blurb')}
      </p>

      {/* Empty-state: reactor not generating */}
      {!generating && (
        <div
          className="status-pill"
          style={{
            display: 'block',
            padding: '10px 14px',
            marginBottom: 12,
            borderLeft: '3px solid #E6B42A',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{needTitle}</div>
          <div className="count-note" style={{ margin: 0 }}>
            {needMsg}
          </div>
        </div>
      )}

      {/* Reactor-output source */}
      <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('griddispatch.reactorTitle')}</span>
          <span className="count-note" style={{ margin: 0 }}>
            {t('griddispatch.reactorMode', { mode })}
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 5,
            background: 'rgba(127,127,127,0.25)',
            overflow: 'hidden',
            margin: '10px 0',
          }}
        >
          <div style={{ width: `${outputPct}%`, height: '100%', background: outputColor, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, color: outputColor }}>
          {t('griddispatch.mweValue', { value: availableMW.toFixed(1) })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 12 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('griddispatch.reactorTargetLabel', { value: targetOutputMW })}
          </span>
          <input
            type="range"
            min={0}
            max={1150}
            step={10}
            value={targetOutputMW}
            onChange={(e) => setTargetOutputMW(Math.trunc(Number(e.target.value)))}
          />
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
          <label className="chk">
            <input type="checkbox" checked={coldShutdown} onChange={(e) => setColdShutdown(e.target.checked)} />
            {t('griddispatch.coldShutdown')}
          </label>
          <label className="chk">
            <input type="checkbox" checked={scrammed} onChange={(e) => setScrammed(e.target.checked)} />
            {t('griddispatch.scram')}
          </label>
        </div>
      </div>

      {/* Dispatch controls */}
      <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('griddispatch.dispatchTitle')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('griddispatch.dispatchLabel')} · {t('griddispatch.mweValue', { value: effectiveSetpoint.toFixed(0) })}
          </span>
          <input
            type="range"
            min={0}
            max={sliderMax}
            step={5}
            value={effectiveSetpoint}
            onChange={(e) => setSetpoint(Math.trunc(Number(e.target.value)))}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="mini" onClick={onSell} disabled={!generating}>
            {grid.selling ? t('griddispatch.stopSelling') : t('griddispatch.startSelling')}
          </button>
          <button className="mini" onClick={onReset}>
            {t('griddispatch.reset')}
          </button>
        </div>
      </div>

      {/* Market / grid readouts */}
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>{t('griddispatch.marketTitle')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
          {stat(t('griddispatch.revenueCaption'), `$${grid.totalRevenueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}
          {stat(t('griddispatch.priceCaption'), t('griddispatch.pricePerMWh', { value: grid.priceUsdPerMWh.toFixed(1) }))}
          {stat(t('griddispatch.demandCaption'), t('griddispatch.mwValue', { value: grid.demandMW.toFixed(0) }))}
          {stat(t('griddispatch.dispatchedCaption'), t('griddispatch.mwValue', { value: grid.dispatchedMW.toFixed(1) }))}
          <div style={{ gridColumn: '1 / span 2' }}>
            {stat(
              t('griddispatch.frequencyCaption'),
              t('griddispatch.freqValue', { hz: freq.toFixed(2), balance }),
              freqColor,
            )}
          </div>
        </div>
        <div className="count-note" style={{ margin: '12px 0 0' }}>
          {t('griddispatch.energyTotal', { value: grid.totalEnergyMWh.toFixed(2) })}
        </div>
      </div>
    </div>
  );
}
