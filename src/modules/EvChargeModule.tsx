import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ── Engine constants (ported verbatim from EvChargeService.cs) ──────────────
const PER_STALL_MAX_KW = 350.0; // DC fast-charge ceiling per stall
const BATTERY_KWH = 80.0; // nominal usable pack size per vehicle
const MAX_STALLS = 40;

const SECONDS_PER_TICK = 0.5; // sim seconds advanced per timer tick
const TICK_MS = 500; // matches the C# DispatcherTimer interval

const OUTPUT_MAX_MWE = 1150; // ProgressBar Maximum in the XAML

// ── Deterministic RNG (seeded like `new Random(0xE7C4)` in spirit) ──────────
// A small LCG so arrivals/targets are reproducible across the tick loop.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Stall {
  id: number;
  vehicleId: number; // 0 = empty
  soc: number; // 0..100 %
  deliveredKw: number; // instantaneous power this tick
  targetSoc: number; // where this vehicle unplugs
}

interface DepotState {
  stalls: Stall[];
  isOpen: boolean;
  activeStalls: number;
  totalDrawMW: number;
  perStallKw: number;
  fleetAvgSoc: number;
  completed: number;
  queueLength: number;
  nextVehicleId: number;
  deposited: number; // total ⚡ earned this session
  kwhBuffer: number; // kWh awaiting minting
  undeliveredKwh: number; // energy delivered but not yet minted
  sinceEarn: number; // ticks since last ⚡ deposit
}

function makeStall(id: number): Stall {
  return { id, vehicleId: 0, soc: 0, deliveredKw: 0, targetSoc: 0 };
}

function initState(): DepotState {
  const stalls: Stall[] = [];
  for (let i = 0; i < 8; i++) stalls.push(makeStall(i + 1));
  return {
    stalls,
    isOpen: false,
    activeStalls: 0,
    totalDrawMW: 0,
    perStallKw: 0,
    fleetAvgSoc: 0,
    completed: 0,
    queueLength: 0,
    nextVehicleId: 1,
    deposited: 0,
    kwhBuffer: 0,
    undeliveredKwh: 0,
    sinceEarn: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function setStallCount(stalls: Stall[], count: number): Stall[] {
  const c = clamp(Math.trunc(count), 0, MAX_STALLS);
  const next = stalls.slice(0, c);
  while (next.length < c) next.push(makeStall(next.length + 1));
  return next;
}

type Action =
  | { type: 'open' }
  | { type: 'setStalls'; count: number }
  | { type: 'addStalls'; n: number }
  | { type: 'removeStalls'; n: number }
  | { type: 'reset' }
  | { type: 'tick'; availableMW: number; generating: boolean };

const NEW_TARGET_SOC = (r: number) => 78 + r * 22; // vehicles leave at 78..100%
const NEW_ARRIVAL_SOC = (r: number) => 8 + r * 42; // arrive nearly-empty to half

// One deterministic RNG shared across the reducer lifetime.
const rng = makeRng(0xe7c4);

function reducer(state: DepotState, action: Action): DepotState {
  switch (action.type) {
    case 'open':
      return { ...state, isOpen: !state.isOpen };

    case 'setStalls':
      return { ...state, stalls: setStallCount(state.stalls, action.count) };

    case 'addStalls': {
      if (action.n <= 0) return state;
      return { ...state, stalls: setStallCount(state.stalls, state.stalls.length + action.n) };
    }

    case 'removeStalls': {
      if (action.n <= 0) return state;
      return { ...state, stalls: setStallCount(state.stalls, state.stalls.length - action.n) };
    }

    case 'reset':
      return {
        ...state,
        isOpen: false,
        completed: 0,
        queueLength: 0,
        undeliveredKwh: 0,
        totalDrawMW: 0,
        activeStalls: 0,
        perStallKw: 0,
        fleetAvgSoc: 0,
        nextVehicleId: 1,
        deposited: 0,
        kwhBuffer: 0,
        sinceEarn: 0,
        stalls: state.stalls.map((s) => makeStall(s.id)),
      };

    case 'tick':
      return tick(state, action.availableMW, action.generating);
  }
}

// Port of EvChargeService.Tick — advances the depot one step and folds in the
// economy/minting logic that lived in the page's UpdateStep.
function tick(state: DepotState, availableMWRaw: number, generating: boolean): DepotState {
  const dtSeconds = clamp(SECONDS_PER_TICK, 0, 5);
  const availableMW = Number.isNaN(availableMWRaw) || availableMWRaw < 0 ? 0 : availableMWRaw;

  let nextVehicleId = state.nextVehicleId;
  // Work on cloned stalls so state stays immutable.
  const stalls: Stall[] = state.stalls.map((s) => ({ ...s }));

  // Arrivals: fill empty stalls from the (implied infinite) queue.
  if (state.isOpen && generating) {
    for (const s of stalls) {
      if (s.vehicleId === 0) {
        s.vehicleId = nextVehicleId++;
        s.soc = NEW_ARRIVAL_SOC(rng());
        s.targetSoc = NEW_TARGET_SOC(rng());
        s.deliveredKw = 0;
      }
    }
  }

  let wanting = 0;
  for (const s of stalls) if (s.vehicleId !== 0 && s.soc < s.targetSoc) wanting++;

  const active = state.isOpen && generating && wanting > 0;

  // Power budget: available MWe -> kW, shared across wanting stalls, capped per stall.
  const budgetKw = availableMW * 1000.0;
  let perStall: number;
  if (!active) perStall = 0;
  else {
    perStall = budgetKw / wanting;
    if (perStall > PER_STALL_MAX_KW) perStall = PER_STALL_MAX_KW;
    if (perStall < 0) perStall = 0;
  }

  let deliveredKwh = 0;
  let totalKw = 0;
  let completedThisTick = 0;

  for (const s of stalls) {
    if (!active || s.vehicleId === 0 || s.soc >= s.targetSoc) {
      s.deliveredKw = 0;
      continue;
    }

    let kw = perStall;
    let kwh = kw * (dtSeconds / 3600.0);
    let socGain = (kwh / BATTERY_KWH) * 100.0;

    // Don't overshoot the target SoC.
    const room = s.targetSoc - s.soc;
    if (socGain > room) {
      socGain = room;
      kwh = (socGain / 100.0) * BATTERY_KWH;
      kw = dtSeconds > 0 ? kwh / (dtSeconds / 3600.0) : 0;
    }

    s.soc += socGain;
    s.deliveredKw = kw;
    totalKw += kw;
    deliveredKwh += kwh;

    if (s.soc >= s.targetSoc - 0.01) {
      // Vehicle full -> leaves. Depot open+generating repopulates next tick.
      completedThisTick++;
      s.vehicleId = 0;
      s.soc = 0;
      s.deliveredKw = 0;
      s.targetSoc = 0;
    }
  }

  // Live aggregates.
  let occupied = 0;
  let socSum = 0;
  let activeNow = 0;
  for (const s of stalls) {
    if (s.vehicleId !== 0) {
      occupied++;
      socSum += s.soc;
    }
    if (s.deliveredKw > 0.01) activeNow++;
  }

  const totalDrawMW = totalKw / 1000.0;
  const perStallKw = active ? perStall : 0;
  const fleetAvgSoc = occupied > 0 ? socSum / occupied : 0;
  const queueLength = active ? Math.max(0, wanting - activeNow) : 0;

  // Economy: mint ⚡ periodically (~every 3s) or once enough energy buffered. ~1 ⚡ / 4 kWh.
  let kwhBuffer = state.kwhBuffer + deliveredKwh;
  let undeliveredKwh = state.undeliveredKwh + deliveredKwh;
  let deposited = state.deposited;
  let sinceEarn = state.sinceEarn + 1;

  if ((sinceEarn >= 6 || kwhBuffer >= 40) && kwhBuffer > 0) {
    const earn = kwhBuffer * 0.25;
    if (earn >= 1.0) {
      deposited += earn;
      kwhBuffer = 0;
      undeliveredKwh = 0; // DrainDeliveredKwh(UndeliveredKwh)
    }
    sinceEarn = 0;
  }

  return {
    ...state,
    stalls,
    nextVehicleId,
    activeStalls: activeNow,
    totalDrawMW,
    perStallKw,
    fleetAvgSoc,
    completed: state.completed + completedThisTick,
    queueLength,
    kwhBuffer,
    undeliveredKwh,
    deposited,
    sinceEarn,
  };
}

export function EvChargeModule() {
  const { t } = useTranslation();

  const [state, dispatch] = useReducer(reducer, undefined, initState);

  // Stand-in for the flagship reactor (WinForge's backend reads a live snapshot from
  // ReactorStatusApiService). Here the player drives the available output directly.
  const [reactorOn, setReactorOn] = useState(true);
  const [availableMW, setAvailableMW] = useState(950);

  // Keep the latest reactor inputs in a ref so the interval closure stays fresh
  // without re-subscribing every render.
  const inputsRef = useRef({ availableMW, reactorOn });
  inputsRef.current = { availableMW, reactorOn };

  useEffect(() => {
    const id = window.setInterval(() => {
      const { availableMW: mw, reactorOn: on } = inputsRef.current;
      const generating = on && mw > 1.0;
      dispatch({ type: 'tick', availableMW: generating ? mw : 0, generating });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const generating = reactorOn && availableMW > 1.0;

  const meterColor = useMemo(() => {
    if (!generating) return '#9A9A9A';
    if (availableMW > 800) return '#3DD56A';
    if (availableMW > 300) return '#E6B42A';
    return '#E06C3A';
  }, [generating, availableMW]);

  const throttled =
    generating && state.activeStalls > 0 && state.perStallKw < PER_STALL_MAX_KW - 0.5;

  const perStallMsg = !state.isOpen
    ? t('evcharge.depotClosed')
    : !generating
      ? t('evcharge.waitingPower')
      : throttled
        ? t('evcharge.throttled', { kw: state.perStallKw.toFixed(0) })
        : t('evcharge.chargingAt', { kw: state.perStallKw.toFixed(0) });

  const meterPct = clamp((availableMW / OUTPUT_MAX_MWE) * 100, 0, 100);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('evcharge.blurb')}
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
            background: 'rgba(230,180,42,0.10)',
          }}
        >
          <strong>{t('evcharge.idleTitle')}</strong>
          <div className="count-note" style={{ margin: '4px 0 0' }}>
            {t('evcharge.idleMsg')}
          </div>
        </div>
      )}

      {/* Live reactor output */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{t('evcharge.reactorTitle')}</span>
          <span className="count-note" style={{ margin: 0 }}>
            {t('evcharge.reactorMode', { mode: generating ? t('evcharge.modeOnline') : t('evcharge.modeCold') })}
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 5,
            background: 'rgba(128,128,128,0.25)',
            overflow: 'hidden',
            margin: '10px 0',
          }}
        >
          <div style={{ width: `${meterPct}%`, height: '100%', background: meterColor }} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, color: meterColor }}>
          {availableMW.toFixed(1)} MWe
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={reactorOn} onChange={(e) => setReactorOn(e.target.checked)} />
            {t('evcharge.reactorGenerating')}
          </label>
          <input
            type="range"
            min={0}
            max={OUTPUT_MAX_MWE}
            step={10}
            value={availableMW}
            onChange={(e) => setAvailableMW(clamp(Math.trunc(+e.target.value) || 0, 0, OUTPUT_MAX_MWE))}
            style={{ flex: 1, minWidth: 160 }}
          />
        </div>
      </div>

      {/* Depot controls */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('evcharge.depotTitle')}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          <span>{t('evcharge.stallsLabel')}</span>
          <input
            className="mod-search"
            type="number"
            min={0}
            max={MAX_STALLS}
            style={{ maxWidth: 120 }}
            value={state.stalls.length}
            onChange={(e) =>
              dispatch({ type: 'setStalls', count: clamp(Math.trunc(+e.target.value) || 0, 0, MAX_STALLS) })
            }
          />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="mini" onClick={() => dispatch({ type: 'open' })}>
            {state.isOpen ? t('evcharge.closeDepot') : t('evcharge.openDepot')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'addStalls', n: 1 })}>
            {t('evcharge.addStall')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'removeStalls', n: 1 })}>
            {t('evcharge.removeStall')}
          </button>
          <button className="mini" onClick={() => dispatch({ type: 'reset' })}>
            {t('evcharge.reset')}
          </button>
        </div>
      </div>

      {/* Depot readouts */}
      <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{t('evcharge.statusTitle')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Stat caption={t('evcharge.activeCaption')} value={`${state.activeStalls} / ${state.stalls.length}`} />
          <Stat caption={t('evcharge.drawCaption')} value={`${state.totalDrawMW.toFixed(2)} MW`} />
          <Stat caption={t('evcharge.avgCaption')} value={`${state.fleetAvgSoc.toFixed(0)}%`} />
          <Stat caption={t('evcharge.completedCaption')} value={`${state.completed}`} />
          <Stat caption={t('evcharge.queueCaption')} value={`${state.queueLength}`} />
          <Stat caption={t('evcharge.earnedCaption')} value={`${state.deposited.toFixed(0)} ⚡`} />
        </div>
        <div className="count-note" style={{ margin: '10px 0 0' }}>
          {perStallMsg}
        </div>
      </div>

      {/* Per-stall list */}
      <div className="panel" style={{ padding: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 15, margin: '0 4px 6px' }}>{t('evcharge.stallsTitle')}</div>
        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {state.stalls.map((s) => {
            const empty = s.vehicleId === 0;
            const socText = empty ? t('evcharge.empty') : `${s.soc.toFixed(0)}%`;
            const kwText = empty ? '—' : s.deliveredKw > 0.01 ? `${s.deliveredKw.toFixed(0)} kW` : t('evcharge.stallIdle');
            const soc = clamp(s.soc, 0, 100);
            return (
              <div
                key={s.id}
                style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 4px' }}
              >
                <span style={{ fontWeight: 600, minWidth: 78 }}>{t('evcharge.stall', { id: s.id })}</span>
                <div
                  style={{
                    flex: 1,
                    height: 8,
                    borderRadius: 4,
                    background: 'rgba(128,128,128,0.25)',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ width: `${soc}%`, height: '100%', background: '#3DD56A' }} />
                </div>
                <span className="count-note" style={{ margin: 0, minWidth: 46, textAlign: 'right' }}>
                  {socText}
                </span>
                <span style={{ minWidth: 80, textAlign: 'right' }}>{kwText}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ caption, value }: { caption: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="count-note" style={{ margin: 0, fontSize: 12 }}>
        {caption}
      </span>
      <span style={{ fontSize: 18, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
