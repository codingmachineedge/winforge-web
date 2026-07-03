import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// --- Physical / model constants (ported verbatim from SteelMillService.cs) ---
const MaxDrawMW = 800.0; // Peak electrical draw of the furnace transformer when arcing at full power, MW.
const TapTempC = 1600.0; // Tapping temperature — the bath is ready to pour at this temperature, °C.
const AmbientTempC = 40.0; // Ambient / cold-charge temperature the bath cools toward when unpowered, °C.
const MeltFloorFraction = 0.3; // Fraction of full draw below which the melt stalls and the bath cools.
const HeatTonnes = 150.0; // Tonnes of steel in one full heat.
const FullElectrodeCurrentKA = 90.0; // Line current at full arc, kA.

// --- Reactor-Bank economy (ported from SteelMillModule.xaml.cs) ---
const PricePerTonne = 4.0; // Watts (⚡) earned per whole tonne of tapped steel sold.
const TICK_MS = 500; // Matches the DispatcherTimer interval (500 ms).

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Live simulation state — mirrors the public fields of SteelMillService. */
interface MillState {
  melting: boolean;
  powerSetpoint: number; // 0..1
  drawnMW: number;
  bathTempC: number;
  electrodeCurrentKA: number;
  heatProgress: number; // 0..1
  powered: boolean;
  heatsTapped: number;
  tonnesProduced: number;
  powerFactor: number; // 0..1
}

function initialState(): MillState {
  return {
    melting: false,
    powerSetpoint: 1.0,
    drawnMW: 0,
    bathTempC: AmbientTempC,
    electrodeCurrentKA: 0,
    heatProgress: 0,
    powered: false,
    heatsTapped: 0,
    tonnesProduced: 0,
    powerFactor: 0,
  };
}

function isReadyToTap(s: MillState): boolean {
  return s.heatProgress >= 1.0 && s.bathTempC >= TapTempC - 5.0;
}

/**
 * Advance the simulation one tick-window (port of SteelMillService.Step). dTicks is the tick delta
 * (never wall-clock). available is the MWe the reactor is offering; generating whether it is running.
 * Returns a NEW state object (never mutates s).
 */
function stepMill(s: MillState, dTicksRaw: number, availableRaw: number, generating: boolean): MillState {
  let dTicks = dTicksRaw;
  if (dTicks < 0) dTicks = 0;
  if (dTicks > 20) dTicks = 20; // clamp against long stalls

  let available = availableRaw;
  if (Number.isNaN(available) || available < 0) available = 0;

  // The furnace only wants power while the operator is melting, the reactor is generating,
  // and the current heat isn't already sitting ready to tap.
  const wantMelt = s.melting && generating && s.heatProgress < 1.0;
  const want = wantMelt ? MaxDrawMW * s.powerSetpoint : 0.0;

  const got = Math.min(want, Math.max(0, available));
  const powered = generating && got > 1.0;

  const electrodeCurrentKA = MaxDrawMW <= 0 ? 0 : FullElectrodeCurrentKA * (got / MaxDrawMW);
  const powerFactor = powered ? 0.6 + 0.2 * clamp(got / MaxDrawMW, 0, 1) : 0.0;

  const perTick = dTicks;
  const meltFloor = MaxDrawMW * MeltFloorFraction;

  let bathTempC = s.bathTempC;
  let heatProgress = s.heatProgress;

  if (got >= meltFloor && powered && heatProgress < 1.0) {
    // Melting: bath climbs toward tapping temperature; surplus arc power melts faster.
    const surplus = (got - meltFloor) / Math.max(1.0, MaxDrawMW - meltFloor); // 0..1
    const rate = 6.0 + 26.0 * clamp(surplus, 0, 1); // °C per tick
    bathTempC += rate * perTick;
    if (bathTempC > TapTempC) bathTempC = TapTempC;
    heatProgress = clamp((bathTempC - AmbientTempC) / Math.max(1.0, TapTempC - AmbientTempC), 0, 1);
  } else if (heatProgress < 1.0) {
    // Stalled: partial power slows cooling; no power cools fastest toward ambient.
    const powerHelp = clamp(got / Math.max(1.0, meltFloor), 0, 1); // 0..1
    const coolRate = 5.0 * (1.0 - 0.6 * powerHelp); // °C per tick
    bathTempC -= coolRate * perTick;
    if (bathTempC < AmbientTempC) bathTempC = AmbientTempC;
    heatProgress = clamp((bathTempC - AmbientTempC) / Math.max(1.0, TapTempC - AmbientTempC), 0, 1);
  }
  // When heatProgress >= 1 the heat simply holds ready (superheat), awaiting a tap.

  return {
    ...s,
    drawnMW: got,
    powered,
    electrodeCurrentKA,
    powerFactor,
    bathTempC,
    heatProgress,
  };
}

/** Colour a temperature from grey → dull red → orange → yellow → white-hot (port of TempHeatColor). */
function tempHeatColor(tempC: number): string {
  if (tempC < 200) return '#8A8A8A'; // cold — grey
  if (tempC < 700) return '#C83A2A'; // dull red
  if (tempC < 1100) return '#E86C1F'; // orange
  if (tempC < 1450) return '#F4C42A'; // yellow
  return '#FFF3D6'; // white-hot
}

/** Colour for the reactor output meter (port of the meterColor ladder). */
function meterColor(generating: boolean, available: number): string {
  if (!generating) return '#9A9A9A'; // grey — idle
  if (available > 800) return '#3DD56A'; // green — strong
  if (available > 300) return '#E6B42A'; // amber
  return '#E06C3A'; // orange — low
}

function Bar({ pct, color, height = 8 }: { pct: number; color: string; height?: number }) {
  return (
    <div style={{ width: '100%', height, background: 'rgba(128,128,128,0.25)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ width: `${clamp(pct, 0, 100)}%`, height: '100%', background: color, transition: 'width 0.25s linear, background 0.25s linear' }} />
    </div>
  );
}

export function SteelMillModule() {
  const { t } = useTranslation();

  // --- Reactor snapshot stand-in: the web app has no live reactor service, so the operator
  //     drives the available reactor output directly (the C# read this from ReactorStatusApiService). ---
  const [availableMW, setAvailableMW] = useState(900);
  const [reactorOn, setReactorOn] = useState(true);

  const [state, setState] = useState<MillState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const tickRef = useRef(0);

  // --- Reactor-Bank economy (session display only) ---
  const [balance, setBalance] = useState(0);
  const [salesEarned, setSalesEarned] = useState(0);
  const depositedRef = useRef(0); // lifetime tonnes already sold
  const lastDepositTickRef = useRef(0);

  const generating = reactorOn && availableMW > 1.0;

  const genRef = useRef(generating);
  genRef.current = generating;
  const availRef = useRef(availableMW);
  availRef.current = availableMW;

  // Bank pending whole tonnes, throttled to at most once per ~3 s (6 ticks). Mirrors SellSteel().
  const sellSteel = (produced: number) => {
    if (produced < depositedRef.current) depositedRef.current = produced; // reset guard
    const pending = produced - depositedRef.current;
    const throttleOk = tickRef.current - lastDepositTickRef.current >= 6;
    if (pending >= 1.0 && throttleOk) {
      const tonnesToSell = Math.floor(pending);
      const watts = tonnesToSell * PricePerTonne;
      depositedRef.current += tonnesToSell;
      lastDepositTickRef.current = tickRef.current;
      setBalance((b) => b + watts);
      setSalesEarned((s) => s + watts);
    }
  };

  // Tick loop — advances the sim on the internal integer tick counter, matching the 500 ms C# timer.
  useEffect(() => {
    const id = setInterval(() => {
      tickRef.current += 1;
      const prev = stateRef.current;
      const next = stepMill(prev, 1, availRef.current, genRef.current);
      setState(next);
      sellSteel(next.tonnesProduced);
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readyToTap = isReadyToTap(state);

  const setPower = (fraction: number) => {
    if (Number.isNaN(fraction) || !Number.isFinite(fraction)) return;
    setState((s) => ({ ...s, powerSetpoint: clamp(fraction, 0, 1) }));
  };

  const toggleCharge = () => {
    if (!generating) return;
    setState((s) => ({ ...s, melting: !s.melting }));
  };

  const doTap = () => {
    setState((s) => {
      if (!isReadyToTap(s)) return s;
      const tonnes = s.tonnesProduced + HeatTonnes;
      const next: MillState = {
        ...s,
        heatsTapped: s.heatsTapped + 1,
        tonnesProduced: tonnes,
        heatProgress: 0,
        bathTempC: Math.min(s.bathTempC, AmbientTempC + 260.0), // residual heat in the shell
      };
      // Deposit immediately (throttling may defer to the tick loop).
      sellSteel(tonnes);
      return next;
    });
  };

  const doReset = () => {
    setState(initialState());
    depositedRef.current = 0;
    lastDepositTickRef.current = 0;
    // Bank balance & session sales are cumulative reactor-economy state; keep them (matches C#).
  };

  const mode = generating ? 'MODE 1 · at power' : reactorOn ? 'MODE 4 · low output' : 'MODE 5 · cold shutdown';

  const furnaceStatus = readyToTap
    ? t('steelmill.statusReady')
    : !state.melting
      ? t('steelmill.statusIdle')
      : state.powered
        ? t('steelmill.statusMelting')
        : t('steelmill.statusStalled');

  const electrodeNote = state.powered
    ? t('steelmill.electrodeArcing', { pf: state.powerFactor.toFixed(2), tonnes: HeatTonnes.toFixed(0) })
    : t('steelmill.electrodeIdle', { tonnes: HeatTonnes.toFixed(0), tap: TapTempC.toFixed(0) });

  const tempColor = tempHeatColor(state.bathTempC);
  const meter = meterColor(generating, availableMW);
  const progressPct = clamp(state.heatProgress * 100, 0, 100);

  const needPower = useMemo(() => {
    if (generating) return null;
    return reactorOn ? t('steelmill.needPowerLow') : t('steelmill.needPowerCold');
  }, [generating, reactorOn, t]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('steelmill.blurb')}
      </p>

      {/* Reactor-power empty-state */}
      {needPower && (
        <div className="status-pill" style={{ display: 'block', padding: '10px 12px', borderLeft: '3px solid #E6B42A', marginBottom: 12 }}>
          <strong>{t('steelmill.needPowerTitle')}</strong>
          <div className="count-note" style={{ margin: '4px 0 0' }}>{needPower}</div>
        </div>
      )}

      {/* Live available reactor output */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('steelmill.reactorTitle')}</span>
          <span style={{ fontWeight: 600, fontSize: 15, color: meter }}>{availableMW.toFixed(1)} MWe</span>
        </div>
        <Bar pct={(availableMW / 1150) * 100} color={meter} />
        <div className="count-note" style={{ margin: '6px 0 10px' }}>{t('steelmill.reactorMode', { mode })}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={reactorOn} onChange={(e) => setReactorOn(e.target.checked)} />
            {t('steelmill.reactorRunning')}
          </label>
          <input
            type="range"
            min={0}
            max={1150}
            step={10}
            value={availableMW}
            disabled={!reactorOn}
            onChange={(e) => setAvailableMW(Number(e.target.value))}
            style={{ flex: 1, minWidth: 160 }}
          />
        </div>
      </div>

      {/* Furnace controls */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{t('steelmill.furnaceTitle')}</div>
            <div className="count-note" style={{ margin: '2px 0 0' }}>{furnaceStatus}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="mini" onClick={toggleCharge} disabled={!generating}>
              {state.melting ? t('steelmill.idle') : t('steelmill.chargeMelt')}
            </button>
            <button className="mini" onClick={doTap} disabled={!readyToTap}>
              {t('steelmill.tap')}
            </button>
            <button className="mini" onClick={doReset}>
              {t('steelmill.reset')}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="count-note" style={{ margin: '0 0 4px' }}>
            {t('steelmill.powerLabel', { pct: Math.round(state.powerSetpoint * 100) })}
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(state.powerSetpoint * 100)}
            onChange={(e) => setPower(Number(e.target.value) / 100)}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* Furnace telemetry */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>{t('steelmill.telemetryTitle')}</div>

        {/* Furnace temperature */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>{t('steelmill.tempCaption')}</span>
          <span style={{ fontWeight: 600, color: tempColor }}>{state.bathTempC.toFixed(0)} °C</span>
        </div>
        <Bar pct={(state.bathTempC / 1600) * 100} color={tempColor} />

        {/* Heat progress */}
        <div style={{ display: 'flex', justifyContent: 'space-between', margin: '12px 0 4px' }}>
          <span>{t('steelmill.progressCaption')}</span>
          <span style={{ fontWeight: 600 }}>{progressPct.toFixed(0)}%</span>
        </div>
        <Bar pct={progressPct} color="#4A90D9" />

        {/* Numeric readouts */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.drawCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{state.drawnMW.toFixed(0)} MW</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.ampsCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{state.electrodeCurrentKA.toFixed(0)} kA</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.heatsCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{state.heatsTapped.toLocaleString()}</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.totalCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{state.tonnesProduced.toLocaleString()} t</div>
          </div>
        </div>

        <div className="count-note" style={{ margin: '12px 0 0' }}>{electrodeNote}</div>

        {readyToTap && (
          <div className="status-pill" style={{ display: 'block', padding: '10px 12px', borderLeft: '3px solid #3DD56A', marginTop: 12 }}>
            <strong>{t('steelmill.tapReadyTitle')}</strong>
            <div className="count-note" style={{ margin: '4px 0 0' }}>
              {t('steelmill.tapReadyMsg', { tonnes: HeatTonnes.toFixed(0) })}
            </div>
          </div>
        )}
      </div>

      {/* Reactor-Bank economy: steel sales */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('steelmill.econTitle')}</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{balance.toFixed(1)} ⚡</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.salesCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>+{salesEarned.toFixed(1)} ⚡</div>
          </div>
          <div>
            <div className="count-note" style={{ margin: 0 }}>{t('steelmill.priceCaption')}</div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{t('steelmill.priceValue', { price: PricePerTonne.toFixed(0) })}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
