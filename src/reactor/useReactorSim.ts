import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactorSim, ReactorMode, type ReactorState } from './physics';

export interface TrendPoint {
  t: number;
  powerPct: number; // % RTP (neutron)
  reactivityPcm: number;
  fuelTemp: number;
  coolantTemp: number;
}

const HISTORY_SECONDS = 120;
const TICK_MS = 100; // wall-clock cadence

export interface UseReactorSim {
  state: ReactorState;
  history: TrendPoint[];
  running: boolean;
  speed: number;
  simClock: number;
  setRunning: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setMode: (m: ReactorMode) => void;
  setAllRods: (percentInserted: number) => void;
  setTargetBoron: (ppm: number) => void;
  setRcps: (on: boolean) => void;
  setRcpFlowDemand: (v: number) => void;
  setFeedwaterFlow: (v: number) => void;
  setEasyStartup: (v: boolean) => void;
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

  const [state, setState] = useState<ReactorState>(() => sim.state());
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

      const snap = sim.state();
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
  }, [sim]);

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
    setRunning,
    setSpeed,
    setMode,
    setAllRods,
    setTargetBoron,
    setRcps,
    setRcpFlowDemand,
    setFeedwaterFlow,
    setEasyStartup,
    scram,
    reset: doReset,
    warmStart,
  };
}
