import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// 鋁冶煉廠 · Hall-Héroult aluminium smelter pot-line — a HEAVY reactor-powered
// load. Ported faithfully from WinForge's SmelterService (the tick/step physics)
// and SmelterModule (controls, gauges, economy). Because the web build has no
// live reactor feed, the "available reactor output" is driven by an operator
// slider here; all smelter physics, constants and formulas match the C# source.
// ---------------------------------------------------------------------------

// --- Physical / model constants (from SmelterService, verbatim) ---
const MAX_DRAW_MW = 700.0; // full line current draw, MW
const OPERATING_TEMP_C = 960.0; // molten pot temperature, °C
const FREEZE_TEMP_C = 830.0; // cryolite bath freezing point, °C
const AMBIENT_TEMP_C = 25.0; // temperature pots cool toward when unpowered, °C
const HEAT_FLOOR_FRACTION = 0.35; // fraction of full draw below which pots cool
const TONNES_PER_DAY_PER_MW = 0.153; // Faraday-lumped yield constant
const FULL_LINE_CURRENT_KA = 600.0; // line current at full draw, kA
const PREHEAT_FREEZE_MARGIN_C = 120.0; // °C subtracted from freeze threshold with pre-heaters

// --- Economy (from SmelterModule code-behind) ---
const PRICE_PER_TONNE = 6.0; // ⚡ per whole tonne of aluminium sold
const ECON_SYMBOL = '⚡';

// --- UI cadence (matches the C# 500 ms DispatcherTimer) ---
const TICK_MS = 500;
const DEPOSIT_THROTTLE_TICKS = 6; // deposit at most ~once per 3 s
const OUTPUT_BAR_MAX = 1150; // ProgressBar Maximum from XAML
const TEMP_BAR_MAX = 1000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Simulation state (mirrors SmelterService fields) ---
interface SimState {
  // operator setpoints
  lineRunning: boolean;
  loadSetpoint: number; // 0..1
  preheatersActive: boolean;
  // simulated reactor feed (operator-controlled here)
  reactorOutputMW: number; // 0..OUTPUT_BAR_MAX
  reactorOn: boolean;
  // live sim state
  drawnMW: number;
  potTempC: number;
  lineCurrentKA: number;
  frozen: boolean;
  tonnesProduced: number;
  tonnesPerDay: number;
  powered: boolean;
  // internal tick bookkeeping
  tick: number;
  lastTick: number;
  first: boolean;
  // economy accumulators
  tonnesDeposited: number;
  salesEarned: number;
  lastDepositTick: number;
}

function initialState(): SimState {
  return {
    lineRunning: false,
    loadSetpoint: 1.0,
    preheatersActive: false,
    reactorOutputMW: 900,
    reactorOn: true,
    drawnMW: 0,
    potTempC: AMBIENT_TEMP_C,
    lineCurrentKA: 0,
    frozen: false,
    tonnesProduced: 0,
    tonnesPerDay: 0,
    powered: false,
    tick: 0,
    lastTick: 0,
    first: true,
    tonnesDeposited: 0,
    salesEarned: 0,
    lastDepositTick: 0,
  };
}

function effectiveFreezeTempC(s: SimState): number {
  return s.preheatersActive ? FREEZE_TEMP_C - PREHEAT_FREEZE_MARGIN_C : FREEZE_TEMP_C;
}

type Action =
  | { type: 'tick' }
  | { type: 'setLoad'; value: number }
  | { type: 'toggleRun' }
  | { type: 'reset' }
  | { type: 'setReactorOutput'; value: number }
  | { type: 'toggleReactor' }
  | { type: 'togglePreheat' };

// Faithful port of SmelterService.Step(tick, available, generating).
function step(s: SimState): SimState {
  const next: SimState = { ...s };
  const tick = next.tick;

  // Derive the reactor feed the way SmelterModule.UpdateStep does.
  let available = next.reactorOutputMW;
  if (Number.isNaN(available) || available < 0) available = 0;
  const generating = next.reactorOn && available > 1.0;

  if (next.first) {
    next.lastTick = tick;
    next.first = false;
  }
  let dTicks = tick - next.lastTick;
  next.lastTick = tick;
  if (dTicks < 0) dTicks = 0;
  if (dTicks > 20) dTicks = 20; // clamp against long stalls

  // How much power the line WANTS this step.
  let want = next.lineRunning && generating ? MAX_DRAW_MW * next.loadSetpoint : 0.0;
  // A frozen pot-line can only draw a trickle for the slow re-melt.
  if (next.frozen && want > 0) want = Math.min(want, MAX_DRAW_MW * 0.25);

  // The reactor can only give what it has available.
  const got = Math.min(want, Math.max(0, available));
  next.drawnMW = got;
  next.powered = generating && got > 1.0;

  next.lineCurrentKA = MAX_DRAW_MW <= 0 ? 0 : FULL_LINE_CURRENT_KA * (got / MAX_DRAW_MW);

  // --- Thermal model ---
  const heatFloor = MAX_DRAW_MW * HEAT_FLOOR_FRACTION;
  const perTick = dTicks;

  if (got >= heatFloor && next.powered) {
    const surplus = (got - heatFloor) / Math.max(1.0, MAX_DRAW_MW - heatFloor);
    const rate = 2.0 + 10.0 * clamp(surplus, 0, 1);
    next.potTempC += rate * perTick;
    if (next.potTempC > OPERATING_TEMP_C) next.potTempC = OPERATING_TEMP_C;
  } else {
    const powerHelp = clamp(got / Math.max(1.0, heatFloor), 0, 1);
    let coolRate = 6.0 * (1.0 - 0.7 * powerHelp);
    if (next.preheatersActive) coolRate *= 0.15;
    next.potTempC -= coolRate * perTick;
    const floorTemp = next.preheatersActive
      ? Math.max(AMBIENT_TEMP_C, effectiveFreezeTempC(next) + 8.0)
      : AMBIENT_TEMP_C;
    if (next.potTempC < floorTemp) next.potTempC = floorTemp;
  }

  // --- Freeze / thaw logic ---
  const freezeAt = effectiveFreezeTempC(next);
  if (!next.frozen && next.potTempC <= freezeAt) next.frozen = true;
  else if (next.frozen && next.potTempC >= OPERATING_TEMP_C - 5.0) next.frozen = false;

  // --- Production (Faraday-lumped) ---
  const producing = next.powered && !next.frozen && next.potTempC >= freezeAt + 10.0;
  if (producing) {
    const tempEff = clamp((next.potTempC - freezeAt) / Math.max(1.0, OPERATING_TEMP_C - freezeAt), 0, 1);
    next.tonnesPerDay = got * TONNES_PER_DAY_PER_MW * tempEff;
    const days = (perTick * 0.5) / 86400.0;
    next.tonnesProduced += next.tonnesPerDay * days;
  } else {
    next.tonnesPerDay = 0;
  }

  // --- EARN: sell newly-produced aluminium (SmelterModule.SellAluminium) ---
  const produced = next.tonnesProduced;
  if (produced < next.tonnesDeposited) next.tonnesDeposited = produced;
  const pending = produced - next.tonnesDeposited;
  const throttleOk = tick - next.lastDepositTick >= DEPOSIT_THROTTLE_TICKS;
  if (pending >= 1.0 && throttleOk) {
    const tonnesToSell = Math.floor(pending);
    const watts = tonnesToSell * PRICE_PER_TONNE;
    next.tonnesDeposited += tonnesToSell;
    next.salesEarned += watts;
    next.lastDepositTick = tick;
  }

  return next;
}

function reducer(s: SimState, a: Action): SimState {
  switch (a.type) {
    case 'tick': {
      const advanced = { ...s, tick: s.tick + 1 };
      return step(advanced);
    }
    case 'setLoad': {
      if (Number.isNaN(a.value) || !Number.isFinite(a.value)) return s;
      return { ...s, loadSetpoint: clamp(a.value, 0, 1) };
    }
    case 'toggleRun':
      return { ...s, lineRunning: !s.lineRunning };
    case 'reset':
      return {
        ...initialState(),
        // keep the operator's reactor feed settings across a line reset
        reactorOutputMW: s.reactorOutputMW,
        reactorOn: s.reactorOn,
        preheatersActive: s.preheatersActive,
      };
    case 'setReactorOutput':
      return { ...s, reactorOutputMW: clamp(a.value, 0, OUTPUT_BAR_MAX) };
    case 'toggleReactor':
      return { ...s, reactorOn: !s.reactorOn };
    case 'togglePreheat':
      return { ...s, preheatersActive: !s.preheatersActive };
    default:
      return s;
  }
}

interface MeterColors {
  reactor: string;
  temp: string;
}

function meterColors(s: SimState, generating: boolean): MeterColors {
  const available = s.reactorOutputMW;
  const reactor = !generating
    ? '#9A9A9A'
    : available > 800
      ? '#3DD56A'
      : available > 300
        ? '#E6B42A'
        : '#E06C3A';
  const temp = s.frozen
    ? '#4F9BFF'
    : s.potTempC >= OPERATING_TEMP_C - 20
      ? '#3DD56A'
      : s.potTempC >= FREEZE_TEMP_C + 40
        ? '#E6B42A'
        : '#E04A3A';
  return { reactor, temp };
}

export function SmelterModule() {
  const { t } = useTranslation();
  const [s, dispatch] = useReducer(reducer, undefined, initialState);

  // Fixed-cadence tick loop (matches the C# 500 ms DispatcherTimer).
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  useEffect(() => {
    const id = window.setInterval(() => dispatchRef.current({ type: 'tick' }), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const available = s.reactorOutputMW < 0 || Number.isNaN(s.reactorOutputMW) ? 0 : s.reactorOutputMW;
  const generating = s.reactorOn && available > 1.0;
  const colors = meterColors(s, generating);

  const lineStatus = s.frozen
    ? t('smelter.statusFrozen')
    : !s.lineRunning
      ? t('smelter.statusBanked')
      : s.powered
        ? t('smelter.statusPouring')
        : t('smelter.statusStarved');

  return (
    <div className="mod">
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{t('smelter.title')}</h2>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('smelter.blurb')}
      </p>

      {/* Reactor-power empty-state */}
      {!generating && (
        <div className="status-pill" style={{ background: 'rgba(224,108,58,0.15)', color: '#E06C3A', display: 'block', padding: '10px 12px', borderRadius: 8, marginBottom: 12 }}>
          <strong>{t('smelter.needPowerTitle')}</strong>
          <div style={{ marginTop: 4 }}>{t('smelter.needPowerMsg')}</div>
        </div>
      )}

      {/* Available reactor output (operator-driven feed) */}
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('smelter.reactorTitle')}</span>
          <span style={{ fontWeight: 600, fontSize: 15, color: colors.reactor }}>
            {available.toFixed(1)} MWe
          </span>
        </div>
        <div style={{ height: 8, background: 'rgba(128,128,128,0.25)', borderRadius: 4, overflow: 'hidden', margin: '8px 0' }}>
          <div style={{ height: '100%', width: `${clamp(available, 0, OUTPUT_BAR_MAX) / OUTPUT_BAR_MAX * 100}%`, background: colors.reactor }} />
        </div>
        <div className="count-note" style={{ margin: 0 }}>
          {t('smelter.reactorMode', { mode: s.reactorOn ? t('smelter.modeOnline') : t('smelter.modeOffline') })}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <span className="count-note" style={{ margin: 0, minWidth: 130 }}>{t('smelter.reactorSupply')}</span>
          <input
            type="range"
            min={0}
            max={OUTPUT_BAR_MAX}
            step={10}
            value={available}
            onChange={(e) => dispatch({ type: 'setReactorOutput', value: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
          <label className="chk" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={s.reactorOn} onChange={() => dispatch({ type: 'toggleReactor' })} />
            {t('smelter.reactorGenerating')}
          </label>
        </div>
      </div>

      {/* Pot-line controls */}
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{t('smelter.lineTitle')}</div>
            <div className="count-note" style={{ margin: 0 }}>{lineStatus}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="mini" disabled={!generating} onClick={() => dispatch({ type: 'toggleRun' })}>
              {s.lineRunning ? t('smelter.bankLine') : t('smelter.runLine')}
            </button>
            <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
              {t('smelter.reset')}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>{t('smelter.loadLabel')}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(s.loadSetpoint * 100)}
              onChange={(e) => dispatch({ type: 'setLoad', value: Number(e.target.value) / 100 })}
              style={{ flex: 1 }}
            />
            <span className="count-note" style={{ margin: 0, minWidth: 44, textAlign: 'right' }}>
              {Math.round(s.loadSetpoint * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Pot-line telemetry */}
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('smelter.telemetryTitle')}</div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('smelter.potTemp')}</span>
          <span style={{ fontWeight: 600, color: colors.temp }}>{s.potTempC.toFixed(0)} °C</span>
        </div>
        <div style={{ height: 8, background: 'rgba(128,128,128,0.25)', borderRadius: 4, overflow: 'hidden', margin: '8px 0 12px' }}>
          <div style={{ height: '100%', width: `${clamp(s.potTempC, 0, TEMP_BAR_MAX) / TEMP_BAR_MAX * 100}%`, background: colors.temp }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.drawCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{s.drawnMW.toFixed(0)} MW</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.ampsCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{s.lineCurrentKA.toFixed(0)} kA</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.rateCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{s.tonnesPerDay.toFixed(1)} {t('smelter.perDay')}</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.totalCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{s.tonnesProduced.toFixed(3)} t</div>
          </div>
        </div>

        {s.frozen && (
          <div style={{ background: 'rgba(79,155,255,0.15)', color: '#4F9BFF', padding: '10px 12px', borderRadius: 8, marginTop: 12 }}>
            <strong>{t('smelter.frozenTitle')}</strong>
            <div style={{ marginTop: 4 }}>
              {generating ? t('smelter.frozenMsgRecovering') : t('smelter.frozenMsgLost')}
            </div>
          </div>
        )}
      </div>

      {/* Reactor-Bank economy: aluminium sales + pre-heater perk */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('smelter.econTitle')}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.salesCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>
              +{s.salesEarned.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {ECON_SYMBOL}
            </div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('smelter.priceCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>
              {t('smelter.priceValue', { price: PRICE_PER_TONNE.toFixed(0) })}
            </div>
          </div>
        </div>

        <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input type="checkbox" checked={s.preheatersActive} onChange={() => dispatch({ type: 'togglePreheat' })} />
          <span>{s.preheatersActive ? t('smelter.preheatOnTitle') : t('smelter.preheatOffTitle')}</span>
        </label>
        <div className="count-note" style={{ margin: '4px 0 0' }}>
          {s.preheatersActive ? t('smelter.preheatOnMsg') : t('smelter.preheatOffMsg')}
        </div>
      </div>
    </div>
  );
}
