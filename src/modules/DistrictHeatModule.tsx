import { useEffect, useMemo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

// ── plant constants (ported verbatim from DistrictHeatService.cs) ────────────
const ReactorMaxMWe = 1150.0; // station nameplate electrical output
const PlantMaxDrawMW = 300.0; // operator can request up to 300 MW drawn
const CogenEfficiency = 1.25; // fraction of drawn power delivered as network heat (CHP > 1.0)
const HomesPerMWth = 40.0; // homes served per MW-thermal delivered
const ReturnTempC = 45.0; // return leg temperature (cool side)
const MinSupplyC = 60.0;
const MaxSupplyC = 120.0;
const MinOutdoorC = -20.0;
const MaxOutdoorC = 15.0;
const WattsPerMWhTh = 0.6; // ⚡ earned per MWh-thermal of heat sold

const DT_SECONDS = 0.5; // 500 ms interval ⇒ 0.5 s of sim per tick
const DT_MS = 500;

// meter accents (from the XAML code-behind)
const GreenAccent = '#3FB950';
const AmberAccent = '#E09F2A';
const RedAccent = '#D13B3B';
const IdleAccent = '#7A7A7A';

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// The web build has no shared reactor snapshot service, so the operator drives a
// minimal reactor here. MODE 5 = cold shutdown (no power); any other mode generates
// at the chosen output. This mirrors the fields the C# Tick() reads from the snapshot.
type ReactorMode = '1' | '2' | '5';

interface State {
  running: boolean;
  requestedDrawMW: number;
  targetSupplyC: number;
  outdoorC: number;
  reactorMode: ReactorMode;
  reactorOutputMWe: number; // operator-set electrical output when generating

  // live plant state
  drawnMW: number;
  deliveredMWth: number;
  demandMWth: number;
  supplyTempC: number;
  homesHeated: number;
  totalDeliveredMWhTh: number;
  coldHomes: boolean;

  // mirrored reactor readouts
  reactorAvailableMW: number;
  powerAvailable: boolean;

  // economy dedupe
  depositedMWhTh: number;
  sinceDepositSeconds: number;
  earnedWatts: number;
}

function initialState(): State {
  return {
    running: false,
    requestedDrawMW: 0,
    targetSupplyC: 85.0,
    outdoorC: 0.0,
    reactorMode: '5',
    reactorOutputMWe: 1000,
    drawnMW: 0,
    deliveredMWth: 0,
    demandMWth: 0,
    supplyTempC: ReturnTempC,
    homesHeated: 0,
    totalDeliveredMWhTh: 0,
    coldHomes: false,
    reactorAvailableMW: 0,
    powerAvailable: false,
    depositedMWhTh: 0,
    sinceDepositSeconds: 0,
    earnedWatts: 0,
  };
}

// 需求模型 · Heat demand (MW-th) implied by outdoor temperature and requested draw.
function computeDemandMWth(requestedDrawMW: number, outdoorC: number): number {
  const span = MaxOutdoorC - MinOutdoorC;
  const coldFrac = span <= 0 ? 1.0 : clamp((MaxOutdoorC - outdoorC) / span, 0, 1);
  const demandFactor = 0.15 + 0.85 * coldFrac; // 0.15..1.0
  return requestedDrawMW * CogenEfficiency * demandFactor;
}

function demandCoverage(deliveredMWth: number, demandMWth: number): number {
  return demandMWth <= 0 ? 1.0 : clamp(deliveredMWth / demandMWth, 0, 1);
}

type Action =
  | { type: 'setRunning'; value: boolean }
  | { type: 'toggleRun' }
  | { type: 'setDraw'; value: number }
  | { type: 'setSupply'; value: number }
  | { type: 'setOutdoor'; value: number }
  | { type: 'setMode'; value: ReactorMode }
  | { type: 'setOutput'; value: number }
  | { type: 'reset' }
  | { type: 'tick' };

// Advance the simulation by DT_SECONDS. Faithful port of DistrictHeatService.Tick().
function tick(s: State): State {
  const dtSeconds = clamp(DT_SECONDS, 0.0, 1.0);

  // Mirror the (operator-driven) reactor.
  const mode = s.reactorMode;
  let electricMW = s.reactorOutputMWe;
  if (Number.isNaN(electricMW) || electricMW < 0) electricMW = 0;

  const cold = mode.includes('5') || mode.toLowerCase().includes('cold');
  // No scram/meltdown modelled locally; MODE 5 is the "not generating" state.
  const generating = electricMW > 1 && !cold;
  const powerAvailable = generating;
  const reactorAvailableMW = generating ? electricMW : 0;

  const demandMWth = computeDemandMWth(s.requestedDrawMW, s.outdoorC);

  let drawnMW = s.drawnMW;
  let deliveredMWth = s.deliveredMWth;
  let supplyTempC = s.supplyTempC;
  let homesHeated = s.homesHeated;
  let totalDeliveredMWhTh = s.totalDeliveredMWhTh;
  let coldHomes = s.coldHomes;

  if (s.running && generating) {
    drawnMW = clamp(s.requestedDrawMW, 0, Math.min(PlantMaxDrawMW, electricMW));
    const maxDeliverable = drawnMW * CogenEfficiency;
    deliveredMWth = Math.min(maxDeliverable, demandMWth);

    const cov = demandCoverage(deliveredMWth, demandMWth);
    const reached = ReturnTempC + (s.targetSupplyC - ReturnTempC) * cov;
    const blend = clamp(dtSeconds / 2.0, 0, 1);
    supplyTempC = supplyTempC + (reached - supplyTempC) * blend;

    homesHeated = Math.trunc(Math.max(0, deliveredMWth * HomesPerMWth));
    coldHomes = demandMWth > 0 && deliveredMWth < demandMWth - 0.5;

    const deliveredMWhTh = deliveredMWth * (dtSeconds / 3600.0);
    if (deliveredMWhTh > 0) totalDeliveredMWhTh += deliveredMWhTh;
  } else {
    drawnMW = 0;
    deliveredMWth = 0;
    homesHeated = 0;
    const blend = clamp(dtSeconds / 6.0, 0, 1);
    supplyTempC = supplyTempC + (ReturnTempC - supplyTempC) * blend;
    coldHomes = s.running && demandMWth > 0;
  }

  // ── economy deposit (in increments, not every tick) ──
  let sinceDepositSeconds = s.sinceDepositSeconds + dtSeconds;
  let depositedMWhTh = s.depositedMWhTh;
  let earnedWatts = s.earnedWatts;
  const undeposited = totalDeliveredMWhTh - depositedMWhTh;
  if (undeposited >= 1.0 || (sinceDepositSeconds >= 3.0 && undeposited > 0)) {
    sinceDepositSeconds = 0;
    const watts = undeposited * WattsPerMWhTh;
    if (watts > 0) {
      depositedMWhTh = totalDeliveredMWhTh;
      earnedWatts += watts;
    }
  }

  return {
    ...s,
    demandMWth,
    drawnMW,
    deliveredMWth,
    supplyTempC,
    homesHeated,
    totalDeliveredMWhTh,
    coldHomes,
    powerAvailable,
    reactorAvailableMW,
    depositedMWhTh,
    sinceDepositSeconds,
    earnedWatts,
  };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'setRunning':
      return { ...s, running: a.value };
    case 'toggleRun':
      return { ...s, running: !s.running };
    case 'setDraw':
      return { ...s, requestedDrawMW: clamp(a.value, 0, PlantMaxDrawMW) };
    case 'setSupply':
      return { ...s, targetSupplyC: clamp(a.value, MinSupplyC, MaxSupplyC) };
    case 'setOutdoor':
      return { ...s, outdoorC: clamp(a.value, MinOutdoorC, MaxOutdoorC) };
    case 'setMode':
      return { ...s, reactorMode: a.value };
    case 'setOutput':
      return { ...s, reactorOutputMWe: clamp(a.value, 0, ReactorMaxMWe) };
    case 'reset':
      // Keeps economy deposits intact (earnedWatts) as the C# Reset() does.
      return {
        ...initialState(),
        reactorMode: s.reactorMode,
        reactorOutputMWe: s.reactorOutputMWe,
        earnedWatts: s.earnedWatts,
      };
    case 'tick':
      return tick(s);
    default:
      return s;
  }
}

export function DistrictHeatModule() {
  const { t } = useTranslation();
  const [s, dispatch] = useReducer(reducer, undefined, initialState);

  // Tick loop — always runs (the reactor snapshot updates even while idle so the
  // network cools/warms). Matches the DispatcherTimer's 500 ms cadence.
  useEffect(() => {
    const id = window.setInterval(() => dispatch({ type: 'tick' }), DT_MS);
    return () => window.clearInterval(id);
  }, []);

  const covPct = useMemo(
    () => clamp(demandCoverage(s.deliveredMWth, s.demandMWth) * 100.0, 0, 100),
    [s.deliveredMWth, s.demandMWth],
  );

  const powerAvailable = s.powerAvailable;
  const availablePct = clamp((s.reactorAvailableMW / ReactorMaxMWe) * 100, 0, 100);

  const covColor =
    !powerAvailable || !s.running
      ? IdleAccent
      : s.coldHomes
        ? covPct < 50
          ? RedAccent
          : AmberAccent
        : GreenAccent;

  const runStatus = !s.running
    ? t('districtheat.runIdle')
    : !powerAvailable
      ? t('districtheat.runArmed')
      : t('districtheat.runRunning', { mw: s.deliveredMWth.toFixed(0) });

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('districtheat.blurb')}
      </p>

      {/* Empty-state: reactor not generating */}
      {!powerAvailable && (
        <div className="panel" style={{ borderLeft: `3px solid ${AmberAccent}`, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{t('districtheat.idleTitle')}</div>
          <div className="count-note" style={{ margin: '4px 0 0' }}>
            {t('districtheat.idleMsg')}
          </div>
        </div>
      )}

      {/* Reactor availability */}
      <div className="panel" style={{ padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('districtheat.reactorTitle')}</span>
          <span className="status-pill">{t('districtheat.mode', { mode: s.reactorMode })}</span>
        </div>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label className="count-note" style={{ margin: 0 }}>
              {t('districtheat.reactorModeLabel')}
            </label>
            <select
              className="mod-select"
              value={s.reactorMode}
              onChange={(e) => dispatch({ type: 'setMode', value: e.target.value as ReactorMode })}
            >
              <option value="5">{t('districtheat.mode5')}</option>
              <option value="2">{t('districtheat.mode2')}</option>
              <option value="1">{t('districtheat.mode1')}</option>
            </select>
          </div>
          <label className="count-note" style={{ margin: '6px 0 0' }}>
            {t('districtheat.outputLabel', { mw: s.reactorOutputMWe.toFixed(0) })}
          </label>
          <input
            type="range"
            min={0}
            max={ReactorMaxMWe}
            step={10}
            value={s.reactorOutputMWe}
            onChange={(e) => dispatch({ type: 'setOutput', value: +e.target.value })}
          />
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.25)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${availablePct}%`,
                height: '100%',
                background: powerAvailable ? GreenAccent : IdleAccent,
                transition: 'width 0.3s',
              }}
            />
          </div>
          <div className="count-note" style={{ margin: '6px 0 0' }}>
            {t('districtheat.availableText', {
              avail: s.reactorAvailableMW.toFixed(0),
              max: ReactorMaxMWe.toFixed(0),
            })}
          </div>
        </div>
      </div>

      {/* Operator controls */}
      <div className="panel" style={{ padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{t('districtheat.runTitle')}</div>
            <div className="count-note" style={{ margin: '2px 0 0' }}>
              {runStatus}
            </div>
          </div>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.running}
              onChange={(e) => dispatch({ type: 'setRunning', value: e.target.checked })}
            />
            {t('districtheat.runToggle')}
          </label>
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('districtheat.loadLabel', {
              mw: s.requestedDrawMW.toFixed(0),
              max: PlantMaxDrawMW.toFixed(0),
            })}
          </label>
          <input
            type="range"
            min={0}
            max={PlantMaxDrawMW}
            step={5}
            value={s.requestedDrawMW}
            onChange={(e) => dispatch({ type: 'setDraw', value: +e.target.value })}
          />
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('districtheat.supplyLabel', { c: s.targetSupplyC.toFixed(0) })}
          </label>
          <input
            type="range"
            min={MinSupplyC}
            max={MaxSupplyC}
            step={1}
            value={s.targetSupplyC}
            onChange={(e) => dispatch({ type: 'setSupply', value: +e.target.value })}
          />
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('districtheat.outdoorLabel', { c: s.outdoorC.toFixed(0) })}
          </label>
          <input
            type="range"
            min={MinOutdoorC}
            max={MaxOutdoorC}
            step={1}
            value={s.outdoorC}
            onChange={(e) => dispatch({ type: 'setOutdoor', value: +e.target.value })}
          />
        </div>

        <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
          <button className="mini" onClick={() => dispatch({ type: 'toggleRun' })}>
            {s.running ? t('districtheat.idle') : t('districtheat.run')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
            {t('districtheat.reset')}
          </button>
        </div>
      </div>

      {/* Readouts */}
      <div className="panel" style={{ padding: '14px 16px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('districtheat.readoutTitle')}</div>

        <div className="kv-list">
          <div className="kv-row">
            <span className="dt">{t('districtheat.deliveredLabel')}</span>
            <span>
              {t('districtheat.deliveredValue', {
                delivered: s.deliveredMWth.toFixed(1),
                demand: s.demandMWth.toFixed(1),
              })}
            </span>
          </div>
          <div className="kv-row">
            <span className="dt">{t('districtheat.homesLabel')}</span>
            <span>{s.homesHeated.toLocaleString()}</span>
          </div>
          <div className="kv-row">
            <span className="dt">{t('districtheat.supplyTempLabel')}</span>
            <span>{t('districtheat.supplyTempValue', { c: s.supplyTempC.toFixed(1) })}</span>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="count-note" style={{ margin: '0 0 4px' }}>
            {t('districtheat.coverageLabel', { pct: covPct.toFixed(0) })}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.25)', overflow: 'hidden' }}>
            <div style={{ width: `${covPct}%`, height: '100%', background: covColor, transition: 'width 0.3s' }} />
          </div>
        </div>

        {s.running && s.coldHomes && (
          <div
            className="panel"
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderLeft: `3px solid ${powerAvailable ? AmberAccent : RedAccent}`,
            }}
          >
            <div style={{ fontWeight: 600 }}>{t('districtheat.coldTitle')}</div>
            <div className="count-note" style={{ margin: '4px 0 0' }}>
              {powerAvailable ? t('districtheat.coldMsgPower') : t('districtheat.coldMsgNoPower')}
            </div>
          </div>
        )}

        <div className="count-note" style={{ margin: '12px 0 0' }}>
          {t('districtheat.totalValue', { total: s.totalDeliveredMWhTh.toFixed(0) })}
        </div>
        <div className="count-note" style={{ margin: '4px 0 0' }}>
          {t('districtheat.earnedValue', { watts: s.earnedWatts.toFixed(1) })}
        </div>
      </div>
    </div>
  );
}
