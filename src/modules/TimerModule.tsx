import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

const p2 = (n: number) => String(n).padStart(2, '0');
function fmtStopwatch(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p2(cs)}`;
}
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${p2(m)}:${p2(s)}`;
}

function NumField({ v, set, min, max, label }: { v: number; set: (n: number) => void; min: number; max: number; label: string }) {
  return (
    <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {label}
      <input className="mod-search" type="number" min={min} max={max} style={{ maxWidth: 120 }} value={v} onChange={(e) => set(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
    </label>
  );
}

export function TimerModule() {
  const { t } = useTranslation();

  // ---- Stopwatch ----
  const [swRunning, setSwRunning] = useState(false);
  const [swMs, setSwMs] = useState(0);
  const [laps, setLaps] = useState<number[]>([]);
  const swAcc = useRef(0);
  const swStart = useRef(0);
  useEffect(() => {
    if (!swRunning) return;
    swStart.current = performance.now();
    const id = setInterval(() => setSwMs(swAcc.current + (performance.now() - swStart.current)), 31);
    return () => clearInterval(id);
  }, [swRunning]);
  const swToggle = () => {
    if (swRunning) { swAcc.current += performance.now() - swStart.current; setSwMs(swAcc.current); }
    setSwRunning((r) => !r);
  };
  const swReset = () => { setSwRunning(false); swAcc.current = 0; setSwMs(0); setLaps([]); };

  // ---- Countdown ----
  const [cdMin, setCdMin] = useState(5);
  const [cdSec, setCdSec] = useState(0);
  const [cdRunning, setCdRunning] = useState(false);
  const [cdMs, setCdMs] = useState(5 * 60000);
  const [cdDone, setCdDone] = useState(false);
  const [cdStarted, setCdStarted] = useState(false); // started and not yet reset — edits must not clobber remaining
  const cdEnd = useRef(0);
  useEffect(() => { if (!cdStarted) setCdMs((cdMin * 60 + cdSec) * 1000); }, [cdMin, cdSec, cdStarted]);
  useEffect(() => {
    if (!cdRunning) return;
    cdEnd.current = performance.now() + cdMs;
    const id = setInterval(() => {
      const left = cdEnd.current - performance.now();
      if (left <= 0) { setCdMs(0); setCdRunning(false); setCdDone(true); setCdStarted(false); clearInterval(id); }
      else setCdMs(left);
    }, 100);
    return () => clearInterval(id);
  }, [cdRunning]);
  const cdToggle = () => { if (cdMs <= 0) return; setCdDone(false); setCdStarted(true); setCdRunning((r) => !r); };
  const cdReset = () => { setCdRunning(false); setCdDone(false); setCdStarted(false); setCdMs((cdMin * 60 + cdSec) * 1000); };

  // ---- Pomodoro ----
  const [workMin, setWorkMin] = useState(25);
  const [breakMin, setBreakMin] = useState(5);
  const [phase, setPhase] = useState<'work' | 'break'>('work');
  const [pomoRunning, setPomoRunning] = useState(false);
  const [pomoMs, setPomoMs] = useState(25 * 60000);
  const [cycles, setCycles] = useState(0);
  const [pomoStarted, setPomoStarted] = useState(false);
  const pomoEnd = useRef(0);
  useEffect(() => { if (!pomoStarted && phase === 'work') setPomoMs(workMin * 60000); }, [workMin, pomoStarted, phase]);
  useEffect(() => {
    if (!pomoRunning) return;
    pomoEnd.current = performance.now() + pomoMs;
    const id = setInterval(() => {
      const left = pomoEnd.current - performance.now();
      if (left <= 0) {
        // phase transition
        setPhase((ph) => {
          const next = ph === 'work' ? 'break' : 'work';
          if (ph === 'work') setCycles((c) => c + 1);
          const dur = (next === 'work' ? workMin : breakMin) * 60000;
          pomoEnd.current = performance.now() + dur;
          setPomoMs(dur);
          return next;
        });
      } else setPomoMs(left);
    }, 200);
    return () => clearInterval(id);
  }, [pomoRunning]);
  const pomoToggle = () => { setPomoStarted(true); setPomoRunning((r) => !r); };
  const pomoReset = () => { setPomoRunning(false); setPomoStarted(false); setPhase('work'); setCycles(0); setPomoMs(workMin * 60000); };

  const tabs = [
    {
      id: 'sw',
      en: 'Stopwatch',
      zh: '碼錶',
      render: () => (
        <div className="timer-pane">
          <div className="timer-display">{fmtStopwatch(swMs)}</div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <button className="mini primary" onClick={swToggle}>{swRunning ? t('timer.stop') : t('timer.start')}</button>
            <button className="mini" disabled={!swRunning} onClick={() => setLaps((l) => [...l, swMs])}>{t('timer.lap')}</button>
            <button className="mini" onClick={swReset}>{t('timer.reset')}</button>
          </div>
          {laps.length > 0 && (
            <ol className="timer-laps">
              {laps.map((l, i) => (
                <li key={i}><span className="count-note">#{i + 1}</span> {fmtStopwatch(l)}{i > 0 ? <span className="count-note"> (+{fmtStopwatch(l - laps[i - 1]!)})</span> : null}</li>
              ))}
            </ol>
          )}
          <p className="count-note" style={{ textAlign: 'center' }}>{swRunning ? t('timer.running') : swMs > 0 ? t('timer.stopped') : t('timer.ready')}</p>
        </div>
      ),
    },
    {
      id: 'cd',
      en: 'Countdown',
      zh: '倒數',
      render: () => (
        <div className="timer-pane">
          <div className="timer-display" style={cdDone ? { color: 'var(--web)' } : undefined}>{cdDone ? t('timer.done') : fmtClock(cdMs)}</div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <NumField v={cdMin} set={setCdMin} min={0} max={999} label={t('timer.minutes')} />
            <NumField v={cdSec} set={setCdSec} min={0} max={59} label={t('timer.seconds')} />
          </div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <button className="mini primary" onClick={cdToggle}>{cdRunning ? t('timer.pause') : t('timer.start')}</button>
            <button className="mini" onClick={cdReset}>{t('timer.reset')}</button>
          </div>
          <p className="count-note" style={{ textAlign: 'center' }}>{cdDone ? t('timer.done') : cdRunning ? t('timer.countingDown') : t('timer.ready')}</p>
        </div>
      ),
    },
    {
      id: 'pomo',
      en: 'Pomodoro',
      zh: '番茄鐘',
      render: () => (
        <div className="timer-pane">
          <div className="count-note" style={{ textAlign: 'center', fontWeight: 600 }}>{phase === 'work' ? t('timer.work') : t('timer.break')}</div>
          <div className="timer-display" style={phase === 'break' ? { color: 'var(--web)' } : undefined}>{fmtClock(pomoMs)}</div>
          <div className="count-note" style={{ textAlign: 'center' }}>🍅 × {cycles}</div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <NumField v={workMin} set={setWorkMin} min={1} max={180} label={t('timer.workMin')} />
            <NumField v={breakMin} set={setBreakMin} min={1} max={180} label={t('timer.breakMin')} />
          </div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <button className="mini primary" onClick={pomoToggle}>{pomoRunning ? t('timer.pause') : t('timer.start')}</button>
            <button className="mini" onClick={pomoReset}>{t('timer.reset')}</button>
          </div>
          <p className="count-note" style={{ textAlign: 'center' }}>{pomoRunning ? t('timer.focusRunning') : t('timer.ready')}</p>
        </div>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleTabs tabs={tabs} />
    </div>
  );
}
