import { useCallback, useEffect, useRef, useState } from 'react';
import { CvcsBlenderMode, ReactorSim, ReactorMode, type ReactorState } from './physics';
import { FuelFactory, type FuelAssembly, type LoadResult } from './fuelFactory';
import {
  INBOX_STORAGE_KEY,
  getPowerCreditLedger,
  installCreditGrantGlobal,
  redeemAutoStart,
  tickAutoRun,
  tickCreditGridSupply,
  type CreditRedemptionMode,
} from './powerCredits';
import { startDesktopCreditInboxPoll } from './creditInboxDesktop';
import { startWebCreditInboxPoll } from './creditInboxWeb';

export interface TrendPoint {
  t: number;
  powerPct: number; // % RTP (neutron)
  reactivityPcm: number;
  fuelTemp: number;
  coolantTemp: number;
}

const HISTORY_SECONDS = 120;
const TICK_MS = 100; // wall-clock cadence

/** Power-credit snapshot mirrored into React each tick and on every ledger change. */
export interface CreditSnapshot {
  balance: number;
  mode: CreditRedemptionMode;
  creditPowerMW: number; // MWe the credit supply is delivering (grid mode)
  gridPowerMW: number; // reactor electric output + credit supply
  autoRunActive: boolean;
  autoRunRemainingS: number; // paid auto-start sim-seconds left
}

/** Fuel-inventory snapshot mirrored into React each tick (cheap; assemblies are few). */
export interface FuelSnapshot {
  fresh: FuelAssembly[];
  loaded: FuelAssembly[];
  spent: FuelAssembly[];
  meanLoadedBurnup: number;
  canRun: boolean;
  newlySpent: string[]; // auto-discharged this tick (already moved to the spent pool)
}

export interface UseReactorSim {
  state: ReactorState;
  history: TrendPoint[];
  running: boolean;
  speed: number;
  simClock: number;
  fuel: FuelSnapshot;
  credits: CreditSnapshot;
  setCreditMode: (m: CreditRedemptionMode) => void;
  redeemAutoStartHour: () => boolean;
  setRunning: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setMode: (m: ReactorMode) => void;
  setAllRods: (percentInserted: number) => void;
  setTargetBoron: (ppm: number) => void;
  setRcps: (on: boolean) => void;
  setRcpFlowDemand: (v: number) => void;
  setFeedwaterFlow: (v: number) => void;
  setEasyStartup: (v: boolean) => void;
  setBlenderMode: (m: CvcsBlenderMode) => void;
  startDilutionDrill: () => void;
  terminateDilution: () => void;
  fabricateAssembly: (enrichmentPct: number, massKgHM: number) => void;
  loadAssembly: (id: string) => LoadResult;
  unloadAssembly: (id: string) => void;
  loadStandardCore: () => void;
  dischargeAll: () => void;
  scram: () => void;
  reset: () => void;
  warmStart: () => void;
}

/**
 * 反應堆模擬迴路 · Drives the pure {@link ReactorSim} engine on a fixed wall-clock cadence and
 * mirrors its state into React. The physics stays framework-free; this hook is the only bridge.
 */
export function useReactorSim(): UseReactorSim {
  const simRef = useRef<ReactorSim | null>(null);
  if (simRef.current === null) simRef.current = new ReactorSim();
  const sim = simRef.current;

  // Fuel factory: persisted inventory (localStorage in the browser, memory in tests).
  // The reactor consumes what the factory has loaded; the factory gates the reactor.
  const factoryRef = useRef<FuelFactory | null>(null);
  if (factoryRef.current === null) factoryRef.current = new FuelFactory({ persist: true });
  const factory = factoryRef.current;

  // Power-generation credits: the shared persisted ledger + the public grant hook. Credits are
  // awarded from OUTSIDE the app (window global / inbox key / inbox file — see powerCredits.ts).
  const ledger = getPowerCreditLedger();
  const creditPowerRef = useRef(0);

  const takeCreditSnapshot = useCallback(
    (electricMW: number): CreditSnapshot => ({
      balance: ledger.balance,
      mode: ledger.mode,
      creditPowerMW: creditPowerRef.current,
      gridPowerMW: electricMW + creditPowerRef.current,
      autoRunActive: ledger.autoRunActive,
      autoRunRemainingS: ledger.autoRunRemainingS,
    }),
    [ledger],
  );

  const takeFuelSnapshot = useCallback(
    (newlySpent: string[] = []): FuelSnapshot => ({
      fresh: factory.listFresh(),
      loaded: factory.listLoaded(),
      spent: factory.listSpent(),
      meanLoadedBurnup: factory.meanLoadedBurnup(),
      canRun: factory.canReactorRun(),
      newlySpent,
    }),
    [factory],
  );

  const [state, setState] = useState<ReactorState>(() => {
    sim.fuelAvailable = factory.canReactorRun(); // gate reflects the persisted inventory from tick 0
    return sim.state();
  });
  const [fuel, setFuel] = useState<FuelSnapshot>(() => takeFuelSnapshot());
  const [credits, setCredits] = useState<CreditSnapshot>(() => takeCreditSnapshot(0));
  const [history, setHistory] = useState<TrendPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [simClock, setSimClock] = useState(0);

  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  const clockRef = useRef(0);
  const histRef = useRef<TrendPoint[]>([]);
  runningRef.current = running;
  speedRef.current = speed;

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!runningRef.current) return;
      const dt = (TICK_MS / 1000) * speedRef.current; // simulated seconds this tick
      sim.update(dt);
      clockRef.current += dt;

      // Fuel cycle coupling: the loaded assemblies absorb this tick's thermal energy
      // (with the easy-mode waste factor), auto-discharging at the burnup threshold,
      // and the factory's loaded state gates the reactor for the NEXT tick.
      const newlySpent = factory.accrueBurnup(sim.thermalPowerMW * sim.fuelConsumptionMultiplier, dt);
      sim.fuelAvailable = factory.canReactorRun();

      // Power credits: drain any freshly-written inbox grants, advance the paid auto-start hour
      // (shuts the reactor down on expiry) and, in grid mode, let the credit balance carry the
      // grid while the reactor is off.
      ledger.ingestBrowserInbox();
      tickAutoRun(ledger, sim, dt);
      creditPowerRef.current = tickCreditGridSupply(ledger, dt, sim.mode);

      const snap = sim.state();
      setCredits(takeCreditSnapshot(snap.electricPowerMW));
      setFuel(takeFuelSnapshot(newlySpent));
      const pt: TrendPoint = {
        t: clockRef.current,
        powerPct: snap.neutronPowerFraction * 100,
        reactivityPcm: snap.reactivityPcm,
        fuelTemp: snap.fuelTemp,
        coolantTemp: snap.tavg,
      };
      const cutoff = clockRef.current - HISTORY_SECONDS * Math.max(1, speedRef.current);
      histRef.current = [...histRef.current, pt].filter((p) => p.t >= cutoff);

      setState(snap);
      setHistory(histRef.current);
      setSimClock(clockRef.current);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [sim, factory, ledger, takeFuelSnapshot, takeCreditSnapshot]);

  // Credit intake: expose the public grant global, drain the browser inbox key (on mount and on
  // cross-tab writes), poll the desktop inbox file (Tauri only) and the web-root grants file,
  // and mirror every ledger change into React immediately — grants land live even while the sim
  // is paused.
  useEffect(() => {
    installCreditGrantGlobal();
    ledger.ingestBrowserInbox();
    const unsub = ledger.subscribe(() => setCredits(takeCreditSnapshot(sim.state().electricPowerMW)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === INBOX_STORAGE_KEY) ledger.ingestBrowserInbox();
    };
    window.addEventListener('storage', onStorage);
    const stopDesktopPoll = startDesktopCreditInboxPoll(ledger);
    const stopWebPoll = startWebCreditInboxPoll(ledger);
    return () => {
      unsub();
      window.removeEventListener('storage', onStorage);
      stopDesktopPoll();
      stopWebPoll();
    };
  }, [sim, ledger, takeCreditSnapshot]);

  const setCreditMode = useCallback((m: CreditRedemptionMode) => {
    ledger.setMode(m);
  }, [ledger]);

  // Mode B: 1 whole credit ⇒ assisted start now + self-shutdown in exactly one simulated hour.
  const redeemAutoStartHour = useCallback((): boolean => {
    if (!redeemAutoStart(ledger, sim)) return false;
    setRunning(true);
    setState(sim.state());
    return true;
  }, [ledger, sim]);

  const setMode = useCallback((m: ReactorMode) => {
    sim.setMode(m);
    setState(sim.state());
  }, [sim]);

  const setAllRods = useCallback((percentInserted: number) => {
    sim.setAllRods(percentInserted);
    setState(sim.state());
  }, [sim]);

  const setTargetBoron = useCallback((ppm: number) => {
    sim.targetBoronPpm = ppm;
    setState(sim.state());
  }, [sim]);

  const setRcps = useCallback((on: boolean) => {
    for (let i = 0; i < 4; i++) (on ? sim.startRcp(i) : sim.stopRcp(i));
    if (on && sim.rcpFlowDemand === 0) sim.rcpFlowDemand = 1;
    setState(sim.state());
  }, [sim]);

  const setRcpFlowDemand = useCallback((v: number) => {
    sim.rcpFlowDemand = v;
    setState(sim.state());
  }, [sim]);

  const setFeedwaterFlow = useCallback((v: number) => {
    sim.feedwaterFlow = v;
    setState(sim.state());
  }, [sim]);

  const setEasyStartup = useCallback((v: boolean) => {
    sim.easyStartupMode = v;
    setState(sim.state());
  }, [sim]);

  const setBlenderMode = useCallback((m: CvcsBlenderMode) => {
    sim.setBlenderMode(m);
    setState(sim.state());
  }, [sim]);

  const startDilutionDrill = useCallback(() => {
    sim.startUncontrolledDilution();
    setState(sim.state());
  }, [sim]);

  const terminateDilution = useCallback(() => {
    sim.terminateDilution();
    setState(sim.state());
  }, [sim]);

  // Any inventory mutation re-syncs the gate and the React snapshot immediately —
  // the operator shouldn't wait a tick to see the core accept/lose its fuel.
  const syncFuel = useCallback(() => {
    sim.fuelAvailable = factory.canReactorRun();
    setFuel(takeFuelSnapshot());
    setState(sim.state());
  }, [sim, factory, takeFuelSnapshot]);

  const fabricateAssembly = useCallback((enrichmentPct: number, massKgHM: number) => {
    factory.fabricate(enrichmentPct, massKgHM);
    syncFuel();
  }, [factory, syncFuel]);

  const loadAssembly = useCallback((id: string): LoadResult => {
    const res = factory.loadIntoCore(id);
    // A validated-but-harmful load (counterfeit path) perturbs the core like the source does.
    if (res.loaded && res.harmful) sim.injectFuelHarm(res.harmSeverity, res.harmKind);
    syncFuel();
    return res;
  }, [factory, sim, syncFuel]);

  const unloadAssembly = useCallback((id: string) => {
    factory.unloadFromCore(id);
    syncFuel();
  }, [factory, syncFuel]);

  const loadStandardCoreCb = useCallback(() => {
    factory.loadStandardCore();
    syncFuel();
  }, [factory, syncFuel]);

  const dischargeAll = useCallback(() => {
    factory.dischargeAll();
    syncFuel();
  }, [factory, syncFuel]);

  const scram = useCallback(() => {
    sim.scram();
    setState(sim.state());
  }, [sim]);

  const doReset = useCallback(() => {
    sim.reset();
    clockRef.current = 0;
    histRef.current = [];
    setHistory([]);
    setSimClock(0);
    setState(sim.state());
  }, [sim]);

  const warmStart = useCallback(() => {
    sim.warmStartCritical();
    setRunning(true);
    setState(sim.state());
  }, [sim]);

  return {
    state,
    history,
    running,
    speed,
    simClock,
    fuel,
    credits,
    setCreditMode,
    redeemAutoStartHour,
    setRunning,
    setSpeed,
    setMode,
    setAllRods,
    setTargetBoron,
    setRcps,
    setRcpFlowDemand,
    setFeedwaterFlow,
    setEasyStartup,
    setBlenderMode,
    startDilutionDrill,
    terminateDilution,
    fabricateAssembly,
    loadAssembly,
    unloadAssembly,
    loadStandardCore: loadStandardCoreCb,
    dischargeAll,
    scram,
    reset: doReset,
    warmStart,
  };
}
