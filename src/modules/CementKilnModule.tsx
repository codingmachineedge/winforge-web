import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// 電熱水泥迴轉窯 · Electric Cement Kiln — a reactor-powered rotary kiln that
// calcines limestone (CaCO₃) into clinker → cement using electric heat instead
// of a fossil (coal/gas/petcoke) burner. Faithful port of WinForge's
// CementKilnService (the sim) + CementKilnModule (controls/telemetry).
//
// The real WinForge module reads a live reactor snapshot from a shared service.
// The web app has no such shared service, so the "available reactor output" is
// modelled here as a self-contained interactive source (generating toggle +
// available-MW + mode) and cement is sold into a local Reactor Bank balance.
// All kiln thermal/production formulas & constants match the C# service exactly.
// ---------------------------------------------------------------------------

// --- physical set-points (from CementKilnService) --------------------------
const CALCINATION_TEMP_C = 1450.0; // target temp the kiln climbs toward when hot
const CLINKER_THRESHOLD_C = 1300.0; // clinker only forms above this shell temp
const MAX_DRAW_MW = 400.0; // maximum operator power draw
const AMBIENT_C = 40.0; // temp the kiln decays toward when unpowered
const FOSSIL_CO2_PER_TONNE = 0.9; // t CO₂ avoided / t cement vs a fossil kiln
const TICK_SECONDS = 0.5; // 500 ms per tick
const TICK_MS = 500;

// --- economy (from CementKilnModule code-behind) ---------------------------
const PRICE_PER_TONNE = 2.0; // Watts (⚡) earned per whole tonne sold
const ECON_SYMBOL = '⚡';

// Reactor-output meter range (matches the XAML ProgressBar Maximum="1150").
const OUTPUT_MAX_MW = 1150;
const TEMP_BAR_MAX = 1450;

// ---------------------------------------------------------------------------
// Kiln simulation state (mirrors CementKilnService fields).
// ---------------------------------------------------------------------------
interface KilnState {
  setpointMW: number; // operator power-draw set-point (0..MaxDrawMW)
  firing: boolean; // operator has fired the kiln
  drawnMW: number; // actual power drawn this tick
  kilnTempC: number; // current kiln shell temperature
  tonnesPerHour: number; // instantaneous production rate
  totalTonnes: number; // lifetime cement produced
  lastTick: number; // integer tick of last step (int.MinValue sentinel)
}

// Reactor-source controls + economy live alongside the kiln.
interface SimState {
  kiln: KilnState;
  tick: number; // integer tick counter (drives sim timing, not Date.now)
  // reactor source (self-contained stand-in for the live reactor snapshot)
  reactorOn: boolean; // reactor is generating
  availableMW: number; // reactor's live electrical output (MWe)
  mode: string; // reactor mode string (as the snapshot exposes)
  scrammed: boolean;
  meltdown: boolean;
  // economy
  balance: number; // Reactor Bank balance (⚡)
  tonnesDeposited: number; // lifetime tonnes already sold (no double count)
  salesEarned: number; // ⚡ credited this session (display only)
  lastDepositTick: number; // throttle deposits to ~once per 3 s
}

const INT_MIN = -2147483648; // matches C# int.MinValue sentinel

function initKiln(): KilnState {
  return {
    setpointMW: (240 / MAX_DRAW_MW) * MAX_DRAW_MW, // slider default 240
    firing: false,
    drawnMW: 0,
    kilnTempC: AMBIENT_C,
    tonnesPerHour: 0,
    totalTonnes: 0,
    lastTick: INT_MIN,
  };
}

function initState(): SimState {
  return {
    kiln: initKiln(),
    tick: 0,
    reactorOn: true,
    availableMW: 900,
    mode: 'MODE 1 · Power',
    scrammed: false,
    meltdown: false,
    balance: 0,
    tonnesDeposited: 0,
    salesEarned: 0,
    lastDepositTick: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) v = lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// Faithful port of CementKilnService.Step(tick, availableMW, generating).
function stepKiln(k: KilnState, tick: number, availableMWin: number, generating: boolean): KilnState {
  // Elapsed seconds since last step (defensive against skipped/duplicate ticks).
  let dt = TICK_SECONDS;
  if (k.lastTick !== INT_MIN) {
    const delta = tick - k.lastTick;
    if (delta > 0) dt = clamp(delta * TICK_SECONDS, TICK_SECONDS, 5.0);
  }
  const lastTick = tick;

  let availableMW = availableMWin;
  if (Number.isNaN(availableMW) || availableMW < 0) availableMW = 0;

  // How much power actually reaches the elements: min(set-point, available).
  const want = k.firing && generating ? k.setpointMW : 0;
  let drawnMW = Math.min(want, availableMW);
  if (drawnMW < 0) drawnMW = 0;

  // --- kiln thermal model (first-order toward a driven target) ---
  let kilnTempC = k.kilnTempC;
  if (drawnMW > 1.0) {
    const drive = clamp(drawnMW / MAX_DRAW_MW, 0, 1);
    const target = AMBIENT_C + (CALCINATION_TEMP_C - AMBIENT_C) * drive;
    const kk = 0.06 * dt; // heating rate constant
    kilnTempC += (target - kilnTempC) * clamp(kk, 0, 1);
  } else {
    const kk = 0.03 * dt; // slower cooling
    kilnTempC += (AMBIENT_C - kilnTempC) * clamp(kk, 0, 1);
  }
  kilnTempC = clamp(kilnTempC, AMBIENT_C, CALCINATION_TEMP_C + 20);

  // --- production: clinker only above threshold; rate ∝ heat above threshold ---
  let tonnesPerHour: number;
  if (kilnTempC > CLINKER_THRESHOLD_C && drawnMW > 1.0) {
    let above = (kilnTempC - CLINKER_THRESHOLD_C) / (CALCINATION_TEMP_C - CLINKER_THRESHOLD_C);
    above = clamp(above, 0, 1);
    tonnesPerHour = 180.0 * above * clamp(drawnMW / MAX_DRAW_MW, 0, 1);
  } else {
    tonnesPerHour = 0;
  }

  // integrate production over the elapsed time
  let totalTonnes = k.totalTonnes;
  const producedNow = tonnesPerHour * (dt / 3600.0);
  if (producedNow > 0 && !Number.isNaN(producedNow)) totalTonnes += producedNow;

  return {
    setpointMW: k.setpointMW,
    firing: k.firing,
    drawnMW,
    kilnTempC,
    tonnesPerHour,
    totalTonnes,
    lastTick,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------
type Action =
  | { type: 'tick' }
  | { type: 'setPower'; mw: number }
  | { type: 'toggleFire' }
  | { type: 'reset' }
  | { type: 'setReactorOn'; on: boolean }
  | { type: 'setAvailable'; mw: number }
  | { type: 'setScram'; on: boolean }
  | { type: 'setMeltdown'; on: boolean };

// Derived: is the reactor actually delivering power right now?
function isGenerating(s: SimState): boolean {
  const available = Number.isNaN(s.availableMW) || s.availableMW < 0 ? 0 : s.availableMW;
  const mode = s.mode.trim() === '' ? '?' : s.mode;
  const coldMode =
    mode.toLowerCase().indexOf('5') >= 0 || mode.toLowerCase().indexOf('cold') >= 0;
  return s.reactorOn && available > 1.0 && !s.scrammed && !s.meltdown && !coldMode;
}

// Sell newly-made cement to the Reactor Bank (port of SellCement()).
function sellCement(s: SimState): SimState {
  const produced = s.kiln.totalTonnes;
  let tonnesDeposited = s.tonnesDeposited;
  // Reset guard: if the kiln was reset, re-baseline the deposited counter.
  if (produced < tonnesDeposited) tonnesDeposited = produced;

  const pending = produced - tonnesDeposited;
  const throttleOk = s.tick - s.lastDepositTick >= 6; // ~3 s at 500 ms ticks
  if (pending >= 1.0 && throttleOk) {
    const tonnesToSell = Math.floor(pending); // whole tonnes only
    const watts = tonnesToSell * PRICE_PER_TONNE;
    return {
      ...s,
      tonnesDeposited: tonnesDeposited + tonnesToSell,
      salesEarned: s.salesEarned + watts,
      balance: s.balance + watts,
      lastDepositTick: s.tick,
    };
  }
  return tonnesDeposited === s.tonnesDeposited ? s : { ...s, tonnesDeposited };
}

function reducer(s: SimState, a: Action): SimState {
  switch (a.type) {
    case 'tick': {
      const tick = s.tick + 1;
      const available = Number.isNaN(s.availableMW) || s.availableMW < 0 ? 0 : s.availableMW;
      const gen = isGenerating(s);
      const kiln = stepKiln(s.kiln, tick, available, gen);
      return sellCement({ ...s, tick, kiln });
    }
    case 'setPower': {
      // SetPowerFraction(fraction) = Clamp(fraction,0,1) * MaxDrawMW.
      const fraction = clamp(a.mw / MAX_DRAW_MW, 0, 1);
      const setpointMW = fraction * MAX_DRAW_MW;
      return { ...s, kiln: { ...s.kiln, setpointMW } };
    }
    case 'toggleFire':
      return { ...s, kiln: { ...s.kiln, firing: !s.kiln.firing } };
    case 'reset': {
      // Reset() cools the kiln + PowerSlider.Value = 240.
      const setpointMW = clamp(240 / MAX_DRAW_MW, 0, 1) * MAX_DRAW_MW;
      return {
        ...s,
        kiln: {
          setpointMW,
          firing: false,
          drawnMW: 0,
          kilnTempC: AMBIENT_C,
          tonnesPerHour: 0,
          totalTonnes: 0,
          lastTick: INT_MIN,
        },
        tonnesDeposited: 0,
      };
    }
    case 'setReactorOn': {
      const mode = a.on ? 'MODE 1 · Power' : 'MODE 5 · Cold shutdown';
      return { ...s, reactorOn: a.on, mode, scrammed: a.on ? s.scrammed : false, meltdown: a.on ? s.meltdown : false };
    }
    case 'setAvailable':
      return { ...s, availableMW: clamp(a.mw, 0, OUTPUT_MAX_MW) };
    case 'setScram':
      return { ...s, scrammed: a.on, mode: a.on ? 'SCRAM' : 'MODE 1 · Power' };
    case 'setMeltdown':
      return { ...s, meltdown: a.on, mode: a.on ? 'MELTDOWN' : 'MODE 1 · Power' };
    default:
      return s;
  }
}

// Colour a temperature dull-red → orange → yellow → white-hot (port of TempHeatColor).
function tempHeatColor(tempC: number): string {
  if (tempC < 200) return '#8A8A8A'; // cold — grey
  if (tempC < 700) return '#C83A2A'; // dull red
  if (tempC < 1100) return '#E86C1F'; // orange
  if (tempC < 1400) return '#F4C42A'; // yellow
  return '#FFF3D6'; // white-hot
}

function meterColor(generating: boolean, availableMW: number): string {
  if (!generating) return '#9A9A9A';
  if (availableMW > 800) return '#3DD56A';
  if (availableMW > 300) return '#E6B42A';
  return '#E06C3A';
}

// Small inline gauge (a filled bar).
function Gauge({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      style={{
        height: 8,
        borderRadius: 4,
        background: 'rgba(127,127,127,0.25)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${clamp(pct, 0, 100)}%`,
          background: color,
          borderRadius: 4,
          transition: 'width 0.2s linear',
        }}
      />
    </div>
  );
}

export function CementKilnModule() {
  const { t } = useTranslation();

  const [state, dispatch] = useReducer(reducer, undefined, initState);

  // Tick loop — matches the C# DispatcherTimer (500 ms).
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  useEffect(() => {
    const id = window.setInterval(() => dispatchRef.current({ type: 'tick' }), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const { kiln } = state;
  const available = Number.isNaN(state.availableMW) || state.availableMW < 0 ? 0 : state.availableMW;
  const generating = isGenerating(state);

  // Derived flags (mirror CementKilnService computed props).
  const powered = kiln.firing && kiln.drawnMW > 1.0;
  const clinkering = kiln.kilnTempC >= CLINKER_THRESHOLD_C;
  const co2Avoided = kiln.totalTonnes * FOSSIL_CO2_PER_TONNE;

  const mColor = meterColor(generating, available);
  const tColor = tempHeatColor(kiln.kilnTempC);

  const kilnStatus = !kiln.firing
    ? t('cementkiln.statusIdle')
    : !powered
      ? t('cementkiln.statusStalled')
      : clinkering
        ? t('cementkiln.statusCalcining')
        : t('cementkiln.statusHeating');

  const kilnNote = powered
    ? t('cementkiln.notePowered', {
        threshold: CLINKER_THRESHOLD_C.toFixed(0),
        co2: FOSSIL_CO2_PER_TONNE.toFixed(2),
      })
    : t('cementkiln.noteIdle', {
        calc: CALCINATION_TEMP_C.toFixed(0),
        threshold: CLINKER_THRESHOLD_C.toFixed(0),
      });

  const needPowerMsg = state.meltdown
    ? t('cementkiln.needMeltdown')
    : state.scrammed
      ? t('cementkiln.needScram')
      : t('cementkiln.needCold');

  const cardStyle: React.CSSProperties = {
    border: '1px solid rgba(127,127,127,0.28)',
    borderRadius: 8,
    padding: '14px 16px',
    marginTop: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cementkiln.blurb')}
      </p>

      {/* Reactor-power empty-state */}
      {!generating && (
        <div
          className="status-pill"
          style={{
            display: 'block',
            padding: '10px 14px',
            borderRadius: 8,
            background: state.meltdown ? 'rgba(224,60,60,0.18)' : 'rgba(230,180,42,0.18)',
            border: `1px solid ${state.meltdown ? '#E03C3C' : '#E6B42A'}`,
            marginBottom: 4,
          }}
        >
          <strong>{t('cementkiln.needTitle')}</strong>
          <div style={{ fontSize: 12, marginTop: 4 }}>{needPowerMsg}</div>
        </div>
      )}

      {/* Reactor source (self-contained stand-in for the live reactor snapshot) */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('cementkiln.reactorTitle')}</span>
          <span style={{ fontWeight: 600, fontSize: 15, color: mColor }}>{available.toFixed(1)} MWe</span>
        </div>
        <Gauge pct={(available / OUTPUT_MAX_MW) * 100} color={mColor} />
        <span className="count-note" style={{ margin: 0 }}>
          {t('cementkiln.reactorMode', { mode: state.mode })}
        </span>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={state.reactorOn}
              onChange={(e) => dispatch({ type: 'setReactorOn', on: e.target.checked })}
            />
            {t('cementkiln.reactorOn')}
          </label>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={state.scrammed}
              onChange={(e) => dispatch({ type: 'setScram', on: e.target.checked })}
            />
            {t('cementkiln.reactorScram')}
          </label>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={state.meltdown}
              onChange={(e) => dispatch({ type: 'setMeltdown', on: e.target.checked })}
            />
            {t('cementkiln.reactorMeltdown')}
          </label>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13 }}>{t('cementkiln.availableLabel')}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{available.toFixed(0)} MWe</span>
          </div>
          <input
            type="range"
            min={0}
            max={OUTPUT_MAX_MW}
            step={10}
            value={available}
            onChange={(e) => dispatch({ type: 'setAvailable', mw: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* Kiln controls */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{t('cementkiln.kilnTitle')}</span>
            <span className="count-note" style={{ margin: 0 }}>
              {kilnStatus}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="mini" disabled={!generating} onClick={() => dispatch({ type: 'toggleFire' })}>
              {kiln.firing ? t('cementkiln.idle') : t('cementkiln.fire')}
            </button>
            <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
              {t('cementkiln.reset')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13 }}>{t('cementkiln.powerLabel')}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{kiln.setpointMW.toFixed(0)} MW</span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX_DRAW_MW}
            step={10}
            value={kiln.setpointMW}
            onChange={(e) => dispatch({ type: 'setPower', mw: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* Kiln telemetry */}
      <div style={cardStyle}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{t('cementkiln.telemetryTitle')}</span>

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{t('cementkiln.tempCaption')}</span>
          <span style={{ fontWeight: 600, color: tColor }}>{kiln.kilnTempC.toFixed(0)} °C</span>
        </div>
        <Gauge pct={(kiln.kilnTempC / TEMP_BAR_MAX) * 100} color={tColor} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px 12px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.drawCaption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>{kiln.drawnMW.toFixed(0)} MW</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.rateCaption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>{kiln.tonnesPerHour.toFixed(0)} t/h</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.totalCaption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              {kiln.totalTonnes.toLocaleString(undefined, { maximumFractionDigits: 0 })} t
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.co2Caption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              {co2Avoided.toLocaleString(undefined, { maximumFractionDigits: 0 })} t
            </span>
          </div>
        </div>

        <span className="count-note" style={{ margin: 0 }}>
          {kilnNote}
        </span>
      </div>

      {/* Reactor-Bank economy: cement sales */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('cementkiln.econTitle')}</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {state.balance.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {ECON_SYMBOL}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.salesCaption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              +{state.salesEarned.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {ECON_SYMBOL}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('cementkiln.priceCaption')}
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              {t('cementkiln.priceValue', { price: PRICE_PER_TONNE.toFixed(0) })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
