import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

// ── formatters (mirror WinForge.Services.TimerService) ─────────────────────
const p2 = (n: number) => String(n).padStart(2, '0');

/** hh:mm:ss.ff (centiseconds) — TimerService.FormatStopwatch. */
function fmtStopwatch(ms: number): string {
  if (ms < 0) ms = 0;
  const totalCs = Math.floor(ms / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p2(cs)}`;
}

/** mm:ss, or hh:mm:ss past an hour — TimerService.FormatCountdown. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${p2(h)}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

// ── browser alarm: WebAudio chime + optional desktop notification ──────────
/** Two-tone "ding-dong" via WebAudio — no external asset, works fully offline. */
function playChime(repeat = 2): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const tone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.3, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };
    let at = 0;
    for (let i = 0; i < repeat; i++) {
      tone(880, at, 0.32);
      tone(660, at + 0.32, 0.42);
      at += 0.85;
    }
    setTimeout(() => ctx.close().catch(() => {}), (at + 0.1) * 1000);
  } catch {
    /* audio never fatal */
  }
}

function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    /* notifications never fatal */
  }
}

function NumField({ v, set, min, max, label }: { v: number; set: (n: number) => void; min: number; max: number; label: string }) {
  return (
    <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {label}
      <input
        className="mod-search"
        type="number"
        min={min}
        max={max}
        style={{ maxWidth: 120 }}
        value={v}
        onChange={(e) => set(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0))))}
      />
    </label>
  );
}

// Common countdown presets (seconds). Kept short + practical for a timer.
const CD_PRESETS: { key: string; secs: number }[] = [
  { key: 'p1m', secs: 60 },
  { key: 'p3m', secs: 3 * 60 },
  { key: 'p5m', secs: 5 * 60 },
  { key: 'p10m', secs: 10 * 60 },
  { key: 'p15m', secs: 15 * 60 },
  { key: 'p25m', secs: 25 * 60 },
  { key: 'p45m', secs: 45 * 60 },
  { key: 'p60m', secs: 60 * 60 },
];

export function TimerModule() {
  const { t } = useTranslation();

  // Shared alarm/notification prefs.
  const [soundOn, setSoundOn] = useState(true);
  const [notifyOn, setNotifyOn] = useState(false);
  const soundOnRef = useRef(soundOn);
  const notifyOnRef = useRef(notifyOn);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);
  useEffect(() => { notifyOnRef.current = notifyOn; }, [notifyOn]);

  const fireAlarm = useCallback((title: string, body: string, repeat = 3) => {
    if (soundOnRef.current) playChime(repeat);
    if (notifyOnRef.current) notify(title, body);
  }, []);

  // Click-gated: enabling desktop notifications must request browser permission.
  const toggleNotify = useCallback(() => {
    if (notifyOn) { setNotifyOn(false); return; }
    try {
      if (typeof Notification === 'undefined') { setNotifyOn(false); return; }
      if (Notification.permission === 'granted') { setNotifyOn(true); return; }
      Notification.requestPermission().then((perm) => setNotifyOn(perm === 'granted')).catch(() => setNotifyOn(false));
    } catch {
      setNotifyOn(false);
    }
  }, [notifyOn]);

  // ---- Stopwatch ----
  const [swRunning, setSwRunning] = useState(false);
  const [swMs, setSwMs] = useState(0);
  // Newest-first laps, each carrying total + split (mirrors C# "Lap N  +split  (total)").
  const [laps, setLaps] = useState<{ total: number; split: number }[]>([]);
  const swAcc = useRef(0);
  const swStart = useRef(0);
  const swLastLap = useRef(0);
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
  const swLap = () => {
    const total = swRunning ? swAcc.current + (performance.now() - swStart.current) : swMs;
    const split = total - swLastLap.current;
    swLastLap.current = total;
    setLaps((l) => [{ total, split }, ...l]);
  };
  const swReset = () => {
    setSwRunning(false);
    swAcc.current = 0;
    swLastLap.current = 0;
    setSwMs(0);
    setLaps([]);
  };

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
      if (left <= 0) {
        setCdMs(0);
        setCdRunning(false);
        setCdDone(true);
        setCdStarted(false);
        clearInterval(id);
        fireAlarm(t('timer.notifyTitle'), t('timer.cdNotifyBody'));
      } else setCdMs(left);
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdRunning]);
  const cdToggle = () => { if (cdMs <= 0) return; setCdDone(false); setCdStarted(true); setCdRunning((r) => !r); };
  const cdReset = () => { setCdRunning(false); setCdDone(false); setCdStarted(false); setCdMs((cdMin * 60 + cdSec) * 1000); };
  const cdApplyPreset = (secs: number) => {
    setCdRunning(false);
    setCdDone(false);
    setCdStarted(false);
    setCdMin(Math.floor(secs / 60));
    setCdSec(secs % 60);
    setCdMs(secs * 1000);
  };
  // Web affordance: add a minute to a live (or paused-but-started) countdown.
  const cdAddMinute = () => {
    if (cdDone) return;
    if (cdRunning) { cdEnd.current += 60000; setCdMs(cdEnd.current - performance.now()); }
    else { setCdStarted(true); setCdMs((m) => m + 60000); }
  };

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
        setPhase((ph) => {
          const next = ph === 'work' ? 'break' : 'work';
          if (ph === 'work') setCycles((c) => c + 1);
          const dur = (next === 'work' ? workMin : breakMin) * 60000;
          pomoEnd.current = performance.now() + dur;
          setPomoMs(dur);
          fireAlarm(
            t('timer.notifyTitle'),
            next === 'work' ? t('timer.pomoBreakOver') : t('timer.pomoWorkOver'),
            2,
          );
          return next;
        });
      } else setPomoMs(left);
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pomoRunning]);
  const pomoToggle = () => { setPomoStarted(true); setPomoRunning((r) => !r); };
  const pomoReset = () => { setPomoRunning(false); setPomoStarted(false); setPhase('work'); setCycles(0); setPomoMs(workMin * 60000); };

  const alarmBar = (
    <div className="mod-toolbar" style={{ justifyContent: 'center', gap: 16 }}>
      <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={soundOn} onChange={(e) => setSoundOn(e.target.checked)} />
        {t('timer.alarmSound')}
      </label>
      <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={notifyOn} onChange={toggleNotify} />
        {t('timer.notify')}
      </label>
    </div>
  );

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
            <button className="mini" disabled={!swRunning} onClick={swLap}>{t('timer.lap')}</button>
            <button className="mini" onClick={swReset}>{t('timer.reset')}</button>
          </div>
          {laps.length > 0 && (
            <ol className="timer-laps" reversed>
              {laps.map((l, i) => {
                const no = laps.length - i;
                return (
                  <li key={no}>
                    <span className="count-note">{t('timer.lapN', { n: no })}</span>{' '}
                    +{fmtStopwatch(l.split)} <span className="count-note">({fmtStopwatch(l.total)})</span>
                  </li>
                );
              })}
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
          <div className="mod-toolbar" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
            {CD_PRESETS.map((pre) => (
              <button key={pre.key} className="mini" onClick={() => cdApplyPreset(pre.secs)}>{t(`timer.${pre.key}`)}</button>
            ))}
          </div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <NumField v={cdMin} set={setCdMin} min={0} max={999} label={t('timer.minutes')} />
            <NumField v={cdSec} set={setCdSec} min={0} max={59} label={t('timer.seconds')} />
          </div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <button className="mini primary" onClick={cdToggle}>{cdRunning ? t('timer.pause') : t('timer.start')}</button>
            <button className="mini" onClick={cdAddMinute}>{t('timer.addMinute')}</button>
            <button className="mini" onClick={cdReset}>{t('timer.reset')}</button>
          </div>
          {alarmBar}
          <p className="count-note" style={{ textAlign: 'center' }}>{cdDone ? t('timer.cdFinished') : cdRunning ? t('timer.countingDown') : t('timer.ready')}</p>
        </div>
      ),
    },
    {
      id: 'pomo',
      en: 'Pomodoro',
      zh: '番茄鐘',
      render: () => (
        <div className="timer-pane">
          <div className="count-note" style={{ textAlign: 'center', fontWeight: 600, color: phase === 'work' ? '#ff4500' : '#3cb371' }}>
            {phase === 'work' ? t('timer.work') : t('timer.break')}
          </div>
          <div className="timer-display" style={{ color: phase === 'work' ? '#ff4500' : '#3cb371' }}>{fmtClock(pomoMs)}</div>
          <div className="count-note" style={{ textAlign: 'center' }}>🍅 × {cycles} — {t('timer.completedSessions', { n: cycles })}</div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <NumField v={workMin} set={setWorkMin} min={1} max={180} label={t('timer.workMin')} />
            <NumField v={breakMin} set={setBreakMin} min={1} max={180} label={t('timer.breakMin')} />
          </div>
          <div className="mod-toolbar" style={{ justifyContent: 'center' }}>
            <button className="mini primary" onClick={pomoToggle}>{pomoRunning ? t('timer.pause') : t('timer.start')}</button>
            <button className="mini" onClick={pomoReset}>{t('timer.reset')}</button>
          </div>
          {alarmBar}
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
