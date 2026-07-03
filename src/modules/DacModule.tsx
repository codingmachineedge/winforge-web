import { useEffect, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

// ── plant constants (ported verbatim from WinForge DacService.cs) ────────────
const REACTOR_MAX_MWE = 1150.0; // station nameplate output
const PLANT_MAX_DRAW_MW = 500.0; // operator can request up to this
const SPECIFIC_ENERGY_MWH_PER_TONNE = 2.0; // DAC needs ~2.0 MWh per tonne CO₂
const TONNES_CO2_PER_CAR_PER_YEAR = 4.6; // typical passenger car annual emissions
const WATTS_PER_TONNE = 0.5; // carbon credits worth this many ⚡ per tonne

const TICK_MS = 500; // WinForge DispatcherTimer interval
const DT_SECONDS = 0.5; // simulated seconds per tick (500 ms)

// The DAC plant in WinForge reads a live reactor snapshot. This self-contained web
// port models the reactor as two operator controls (available MWe + online toggle),
// which drive the identical generating / capturing logic.
interface DacState {
  // operator inputs
  running: boolean; // capture fans armed
  requestedDrawMW: number; // clamped to [0, PLANT_MAX_DRAW_MW]
  reactorMWe: number; // station electrical output offered [0, REACTOR_MAX_MWE]
  reactorOnline: boolean; // false ⇒ MODE 5 cold shutdown, true ⇒ generating

  // derived reactor readouts (mirrored each tick)
  reactorAvailableMW: number;
  reactorMode: string;
  powerAvailable: boolean;

  // plant state
  drawnMW: number;
  rateTonnesPerHour: number;
  totalCapturedTonnes: number;
  fanSpin: number; // 0..1

  // economy deposit bookkeeping
  depositedTonnes: number;
  sinceDepositSeconds: number;
  carbonCredits: number; // ⚡ earned into the shared economy
}

const initialState: DacState = {
  running: false,
  requestedDrawMW: 250,
  reactorMWe: REACTOR_MAX_MWE,
  reactorOnline: true,
  reactorAvailableMW: 0,
  reactorMode: '5',
  powerAvailable: false,
  drawnMW: 0,
  rateTonnesPerHour: 0,
  totalCapturedTonnes: 0,
  fanSpin: 0,
  depositedTonnes: 0,
  sinceDepositSeconds: 0,
  carbonCredits: 0,
};

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

type Action =
  | { type: 'tick' }
  | { type: 'setRunning'; value: boolean }
  | { type: 'setDraw'; value: number }
  | { type: 'setReactorMWe'; value: number }
  | { type: 'setReactorOnline'; value: boolean }
  | { type: 'reset' };

// Faithful port of DacService.Tick(dtSeconds, snap).
function tick(s: DacState): DacState {
  const dtSeconds = clamp(DT_SECONDS, 0, 1);

  // Mirror the "reactor snapshot".
  let electricMW = s.reactorOnline ? s.reactorMWe : 0;
  if (Number.isNaN(electricMW) || electricMW < 0) electricMW = 0;
  const mode = s.reactorOnline ? '1' : '5';
  const reactorMode = mode.trim().length === 0 ? '5' : mode;

  const cold = mode.includes('5') || mode.toLowerCase().includes('cold');
  const generating = s.reactorOnline && electricMW > 1 && !cold;
  const powerAvailable = generating;
  const reactorAvailableMW = generating ? electricMW : 0;

  const capturing = s.running && generating;

  let drawnMW: number;
  let rateTonnesPerHour: number;
  let totalCapturedTonnes = s.totalCapturedTonnes;
  let fanSpin = s.fanSpin;

  if (capturing) {
    // Draw is clamped to whatever the station can actually spare.
    drawnMW = clamp(s.requestedDrawMW, 0, Math.min(PLANT_MAX_DRAW_MW, electricMW));
    // t/h = MW / (MWh per tonne).
    rateTonnesPerHour = SPECIFIC_ENERGY_MWH_PER_TONNE <= 0 ? 0 : drawnMW / SPECIFIC_ENERGY_MWH_PER_TONNE;

    const capturedTonnes = rateTonnesPerHour * (dtSeconds / 3600.0);
    if (capturedTonnes > 0) totalCapturedTonnes += capturedTonnes;

    fanSpin = clamp(fanSpin + dtSeconds * 1.0, 0, 1); // spin up
  } else {
    drawnMW = 0;
    rateTonnesPerHour = 0;
    fanSpin = clamp(fanSpin - dtSeconds * 0.6, 0, 1); // spin down
  }

  // ── economy deposit — carbon credits (in increments, not every tick) ──
  let depositedTonnes = s.depositedTonnes;
  let sinceDepositSeconds = s.sinceDepositSeconds + dtSeconds;
  let carbonCredits = s.carbonCredits;
  const undeposited = totalCapturedTonnes - depositedTonnes;
  if (undeposited >= 1.0 || (sinceDepositSeconds >= 3.0 && undeposited > 0)) {
    sinceDepositSeconds = 0;
    const watts = undeposited * WATTS_PER_TONNE;
    if (watts > 0) {
      depositedTonnes = totalCapturedTonnes;
      carbonCredits += watts;
    }
  }

  return {
    ...s,
    reactorAvailableMW,
    reactorMode,
    powerAvailable,
    drawnMW,
    rateTonnesPerHour,
    totalCapturedTonnes,
    fanSpin,
    depositedTonnes,
    sinceDepositSeconds,
    carbonCredits,
  };
}

function reducer(s: DacState, a: Action): DacState {
  switch (a.type) {
    case 'tick':
      return tick(s);
    case 'setRunning':
      return { ...s, running: a.value };
    case 'setDraw':
      return { ...s, requestedDrawMW: clamp(a.value, 0, PLANT_MAX_DRAW_MW) };
    case 'setReactorMWe':
      return { ...s, reactorMWe: clamp(a.value, 0, REACTOR_MAX_MWE) };
    case 'setReactorOnline':
      return { ...s, reactorOnline: a.value };
    case 'reset':
      // Reset the plant to a cold, empty state (keeps economy credits intact).
      return {
        ...s,
        running: false,
        requestedDrawMW: 0,
        drawnMW: 0,
        rateTonnesPerHour: 0,
        totalCapturedTonnes: 0,
        depositedTonnes: 0,
        sinceDepositSeconds: 0,
        fanSpin: 0,
        powerAvailable: false,
        reactorAvailableMW: 0,
      };
    default:
      return s;
  }
}

export function DacModule() {
  const { t } = useTranslation();
  const [s, dispatch] = useReducer(reducer, initialState);

  // Real-time tick loop — matches the 500 ms WinForge DispatcherTimer.
  useEffect(() => {
    const id = window.setInterval(() => dispatch({ type: 'tick' }), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const powerAvailable = s.powerAvailable;
  const availablePct = clamp((s.reactorAvailableMW / REACTOR_MAX_MWE) * 100, 0, 100);
  const carsOffset = TONNES_CO2_PER_CAR_PER_YEAR <= 0 ? 0 : s.totalCapturedTonnes / TONNES_CO2_PER_CAR_PER_YEAR;
  const fanPct = clamp(s.fanSpin * 100, 0, 100);

  let runStatus: string;
  if (!s.running) runStatus = t('dac.statusIdle');
  else if (!powerAvailable) runStatus = t('dac.statusArmed');
  else runStatus = t('dac.statusCapturing', { mw: s.drawnMW.toFixed(0) });

  const accent = powerAvailable ? '#3FB950' : '#7A7A7A';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('dac.subtitle')}
      </p>
      <p className="count-note">{t('dac.blurb')}</p>

      {/* Empty-state: reactor not generating */}
      {!powerAvailable && (
        <div className="panel" style={{ borderLeft: '4px solid #C4A000', padding: '12px 14px', marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('dac.idleTitle')}</div>
          <div className="count-note" style={{ margin: 0 }}>{t('dac.idleMessage')}</div>
        </div>
      )}

      {/* Reactor availability */}
      <div className="panel" style={{ padding: '14px 16px', marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('dac.reactorTitle')}</span>
          <span style={{ fontWeight: 600, opacity: 0.7 }}>{t('dac.modeLabel', { mode: s.reactorMode })}</span>
        </div>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            background: 'rgba(127,127,127,0.25)',
            overflow: 'hidden',
            margin: '8px 0',
          }}
        >
          <div style={{ width: `${availablePct}%`, height: '100%', background: accent, transition: 'width 0.3s' }} />
        </div>
        <div className="count-note" style={{ margin: 0 }}>
          {t('dac.availableText', { avail: s.reactorAvailableMW.toFixed(0), max: REACTOR_MAX_MWE.toFixed(0) })}
        </div>

        {/* Reactor operator controls (self-contained stand-in for the live snapshot) */}
        <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={s.reactorOnline}
            onChange={(e) => dispatch({ type: 'setReactorOnline', value: e.target.checked })}
          />
          <span>{t('dac.reactorOnline')}</span>
        </label>
        <div style={{ marginTop: 8 }}>
          <div className="count-note" style={{ margin: 0 }}>
            {t('dac.reactorOutputLabel', { mw: s.reactorMWe.toFixed(0), max: REACTOR_MAX_MWE.toFixed(0) })}
          </div>
          <input
            type="range"
            min={0}
            max={REACTOR_MAX_MWE}
            step={10}
            value={s.reactorMWe}
            onChange={(e) => dispatch({ type: 'setReactorMWe', value: +e.target.value })}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* Operator controls */}
      <div className="panel" style={{ padding: '14px 16px', marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{t('dac.runTitle')}</div>
            <div className="count-note" style={{ margin: '2px 0 0' }}>{runStatus}</div>
          </div>
          <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={s.running}
              onChange={(e) => dispatch({ type: 'setRunning', value: e.target.checked })}
            />
            <span>{s.running ? t('dac.on') : t('dac.off')}</span>
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="count-note" style={{ margin: 0 }}>
            {t('dac.loadLabel', { mw: s.requestedDrawMW.toFixed(0), max: PLANT_MAX_DRAW_MW.toFixed(0) })}
          </div>
          <input
            type="range"
            min={0}
            max={PLANT_MAX_DRAW_MW}
            step={5}
            value={s.requestedDrawMW}
            onChange={(e) => dispatch({ type: 'setDraw', value: +e.target.value })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
            {t('dac.reset')}
          </button>
        </div>
      </div>

      {/* Readouts */}
      <div className="panel" style={{ padding: '14px 16px', marginTop: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{t('dac.readoutTitle')}</div>
        <div className="kv-list">
          <div className="kv-row">{t('dac.drawnValue', { mw: s.drawnMW.toFixed(1) })}</div>
          <div className="kv-row">{t('dac.rateValue', { rate: s.rateTonnesPerHour.toFixed(1) })}</div>
          <div className="kv-row">{t('dac.energyValue', { e: SPECIFIC_ENERGY_MWH_PER_TONNE.toFixed(2) })}</div>
          <div className="kv-row">{t('dac.fanValue', { spin: fanPct.toFixed(0) })}</div>
        </div>

        <div style={{ fontWeight: 600, marginTop: 12 }}>
          {t('dac.totalValue', { total: s.totalCapturedTonnes.toFixed(1) })}
        </div>
        <div className="count-note" style={{ margin: '2px 0 0' }}>
          {t('dac.equivValue', { cars: carsOffset.toFixed(1) })}
        </div>
        <div className="count-note" style={{ margin: '2px 0 0' }}>
          {t('dac.creditsValue', { credits: s.totalCapturedTonnes.toFixed(1) })}
        </div>
        <div className="count-note" style={{ margin: '2px 0 0' }}>
          {t('dac.economyValue', { watts: s.carbonCredits.toFixed(1) })}
        </div>
      </div>
    </div>
  );
}
