import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// Native module — Activity Timeline (活動時間軸 · TimeLens). Faithful web port of the WinForge
// desktop module: it samples the FOREGROUND window (process name + title) plus system idle time
// via Win32 (GetForegroundWindow / GetLastInputInfo), through the desktop backend's PowerShell.
//
// The desktop app runs a persistent background sampler that writes segments to a local JSONL
// store. A React page cannot host a persistent OS daemon, so this port reproduces the same core
// sampling loop as an in-page LIVE session: press Start and it polls the foreground window every
// N seconds, closing/opening focus segments and pausing on idle exactly like the native Tick loop,
// then renders the 24-hour stacked timeline and sorted per-app totals. Everything stays local;
// data is kept in memory for the session and can be exported to CSV. Live sampling requires the
// WinForge desktop app (browser has no foreground-window / idle APIs).

interface Snapshot {
  process: string;
  title: string;
}

interface Segment {
  process: string;
  title: string;
  startUnix: number;
  endUnix: number;
}

const MIN_IDLE = 1;
const MAX_IDLE = 120;
const MIN_POLL = 1;
const MAX_POLL = 30;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const nowUnix = () => Math.floor(Date.now() / 1000);

// PowerShell snapshot of the foreground window + system idle seconds via Win32 P/Invoke.
const FOREGROUND_SCRIPT = `
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class TimeLensNative {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static string Proc() {
    try {
      IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return "";
      uint pid; GetWindowThreadProcessId(h, out pid); if (pid == 0) return "";
      try { using (var p = Process.GetProcessById((int)pid)) { return p.ProcessName ?? ""; } } catch { return ""; }
    } catch { return ""; }
  }
  public static string Title() {
    try {
      IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return "";
      int len = GetWindowTextLength(h); if (len <= 0) return "";
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString();
    } catch { return ""; }
  }
  public static double Idle() {
    try {
      var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      if (!GetLastInputInfo(ref info)) return 0;
      uint tick = (uint)Environment.TickCount; uint last = info.dwTime;
      uint diff = tick >= last ? tick - last : (uint.MaxValue - last + tick);
      return diff / 1000.0;
    } catch { return 0; }
  }
}
'@
[pscustomobject]@{ process=[TimeLensNative]::Proc(); title=[TimeLensNative]::Title(); idle=[TimeLensNative]::Idle() }
`.trim();

// Deterministic pleasant colour from a process name (mirrors the C# ColorFor / HslToRgb).
function colorFor(key: string): string {
  const k = (key || '').toLowerCase();
  let hash = 17;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  const hue = (((hash % 360) + 360) % 360);
  return hslToRgb(hue, 0.55, 0.55);
}
function hslToRgb(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function TimeLensModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tracking, setTracking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [idle, setIdle] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(5);
  const [pollSeconds, setPollSeconds] = useState(3);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [current, setCurrent] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Refs hold the live-loop state so the interval callback always sees fresh values
  // without re-subscribing (mirrors the service's _cur* fields under its lock).
  const openRef = useRef<Segment | null>(null);
  const wasIdleRef = useRef(false);
  const pausedRef = useRef(false);
  const idleMinRef = useRef(5);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segsRef = useRef<Segment[]>([]);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { idleMinRef.current = idleMinutes; }, [idleMinutes]);
  useEffect(() => { segsRef.current = segments; }, [segments]);

  const flushOpen = (endUnix: number) => {
    const open = openRef.current;
    openRef.current = null;
    if (!open) return;
    if (endUnix <= open.startUnix) return;
    const seg: Segment = { ...open, endUnix };
    const next = [...segsRef.current, seg];
    segsRef.current = next;
    setSegments(next);
  };

  const tick = async () => {
    try {
      if (pausedRef.current) return;
      const rows = await runPowershellJson<Snapshot & { idle: number }>(FOREGROUND_SCRIPT);
      const snap = rows[0];
      const now = nowUnix();
      if (!snap) return;

      const idleSecs = typeof snap.idle === 'number' ? snap.idle : 0;
      const isIdle = idleSecs >= idleMinRef.current * 60;
      if (isIdle) {
        if (!wasIdleRef.current) { flushOpen(now); wasIdleRef.current = true; }
        setIdle(true);
        setCurrent(null);
        return;
      }
      if (wasIdleRef.current) wasIdleRef.current = false;
      setIdle(false);

      const proc = snap.process && snap.process.trim() ? snap.process : 'Unknown';
      const title = snap.title ?? '';
      setCurrent({ process: proc, title });

      const open = openRef.current;
      if (!open) {
        openRef.current = { process: proc, title, startUnix: now, endUnix: now };
      } else if (
        open.process.toLowerCase() !== proc.toLowerCase() ||
        open.title !== title
      ) {
        flushOpen(now);
        openRef.current = { process: proc, title, startUnix: now, endUnix: now };
      } else {
        open.endUnix = now;
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const stopTimer = () => {
    if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const startTracking = () => {
    if (!desktop || tracking) return;
    setErr(null);
    setTracking(true);
    setPaused(false);
    pausedRef.current = false;
    wasIdleRef.current = false;
    openRef.current = null;
    void tick();
    stopTimer();
    timerRef.current = setInterval(() => { void tick(); }, clamp(pollSeconds, MIN_POLL, MAX_POLL) * 1000);
  };

  const stopTracking = () => {
    if (!tracking) return;
    flushOpen(nowUnix());
    stopTimer();
    setTracking(false);
    setPaused(false);
    setIdle(false);
    setCurrent(null);
  };

  const togglePause = () => {
    if (!tracking) return;
    setPaused((p) => {
      const next = !p;
      pausedRef.current = next;
      if (next) flushOpen(nowUnix()); // close the open segment so the gap is honest
      return next;
    });
  };

  // Re-arm the timer when the poll interval changes mid-session (mirrors RestartIfRunning).
  useEffect(() => {
    if (!tracking) return;
    stopTimer();
    timerRef.current = setInterval(() => { void tick(); }, clamp(pollSeconds, MIN_POLL, MAX_POLL) * 1000);
    return () => { /* cleared on next run / unmount below */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollSeconds, tracking]);

  // Flush + clear the timer on unmount.
  useEffect(() => {
    return () => {
      const open = openRef.current;
      if (open && open.endUnix > open.startUnix) {
        segsRef.current = [...segsRef.current, { ...open }];
      }
      stopTimer();
    };
  }, []);

  const clearAll = () => {
    openRef.current = null;
    segsRef.current = [];
    setSegments([]);
    setCurrent(null);
  };

  // ===== aggregation =====

  const fmtDuration = (seconds: number): string => {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h >= 1) return t('timelens.durHM', { h, m });
    if (m >= 1) return t('timelens.durMS', { m, s });
    return t('timelens.durS', { s });
  };

  const display = (proc: string) => (proc && proc.trim() ? proc : t('timelens.unknown'));

  const totalSeconds = segments.reduce((a, s) => a + Math.max(0, s.endUnix - s.startUnix), 0);

  // Per-process totals, descending.
  const totalsMap = new Map<string, number>();
  for (const s of segments) {
    const key = s.process && s.process.trim() ? s.process : 'Unknown';
    totalsMap.set(key, (totalsMap.get(key) ?? 0) + Math.max(0, s.endUnix - s.startUnix));
  }
  const totals = Array.from(totalsMap.entries())
    .map(([process, secs]) => ({ process, secs }))
    .sort((a, b) => b.secs - a.secs);
  const maxTotal = totals.length > 0 ? Math.max(...totals.map((x) => x.secs)) : 1;

  // 24-hour rows: for each hour, the overlapping slices of each segment (local time).
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStartUnix = Math.floor(startOfDay.getTime() / 1000);

  interface Slice { process: string; offFrac: number; widFrac: number; label: string }
  const hourRows: Slice[][] = [];
  for (let hour = 0; hour < 24; hour++) {
    const hStart = dayStartUnix + hour * 3600;
    const hEnd = hStart + 3600;
    const slices: Slice[] = [];
    for (const s of segments) {
      if (s.endUnix <= hStart || s.startUnix >= hEnd) continue;
      const clipStart = Math.max(s.startUnix, hStart);
      const clipEnd = Math.min(s.endUnix, hEnd);
      const widFrac = (clipEnd - clipStart) / 3600;
      if (widFrac <= 0) continue;
      const offFrac = (clipStart - hStart) / 3600;
      const proc = s.process && s.process.trim() ? s.process : 'Unknown';
      slices.push({
        process: proc,
        offFrac,
        widFrac,
        label: `${display(proc)} · ${fmtDuration(clipEnd - clipStart)}${s.title ? ` — ${s.title}` : ''}`,
      });
    }
    hourRows.push(slices);
  }

  const empty = segments.length === 0;
  const hasActiveHours = hourRows.some((r) => r.length > 0);

  const statusText = !tracking
    ? t('timelens.statusOff')
    : paused
      ? t('timelens.statusPaused')
      : idle
        ? t('timelens.statusIdle')
        : t('timelens.statusTracking');

  const csvFor = (segs: Segment[]): string => {
    const esc = (v: string) => {
      const val = v ?? '';
      return /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
    };
    const lines = ['date,start,end,seconds,process,title'];
    for (const s of [...segs].sort((a, b) => a.startUnix - b.startUnix)) {
      const ds = new Date(s.startUnix * 1000);
      const de = new Date(s.endUnix * 1000);
      const date = `${ds.getFullYear()}-${pad2(ds.getMonth() + 1)}-${pad2(ds.getDate())}`;
      const st = `${pad2(ds.getHours())}:${pad2(ds.getMinutes())}:${pad2(ds.getSeconds())}`;
      const en = `${pad2(de.getHours())}:${pad2(de.getMinutes())}:${pad2(de.getSeconds())}`;
      const secs = Math.max(0, s.endUnix - s.startUnix);
      lines.push([date, st, en, String(secs), esc(s.process), esc(s.title)].join(','));
    }
    return lines.join('\n');
  };

  const exportCsv = () => {
    if (segments.length === 0) return;
    try {
      const blob = new Blob(['﻿' + csvFor(segments)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      a.href = url;
      a.download = `WinForge-activity-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="mod">
      <p className="count-note">{t('timelens.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('timelens.desktopOnly')}</p>}
      <p className="count-note">{t('timelens.privacy')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button
          className={tracking ? 'mini' : 'mini primary'}
          disabled={!desktop}
          onClick={() => (tracking ? stopTracking() : startTracking())}
        >
          {tracking ? t('timelens.stop') : t('timelens.start')}
        </button>
        <button className="mini" disabled={!tracking} onClick={togglePause}>
          {paused ? t('timelens.resume') : t('timelens.pause')}
        </button>
        <button className="mini" disabled={segments.length === 0} onClick={exportCsv}>{t('timelens.exportCsv')}</button>
        <button className="mini" disabled={segments.length === 0} onClick={clearAll}>{t('timelens.clear')}</button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('timelens.idleLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={MIN_IDLE}
          max={MAX_IDLE}
          style={{ maxWidth: 70 }}
          value={idleMinutes}
          onChange={(e) => setIdleMinutes(clamp(Math.floor(+e.target.value) || MIN_IDLE, MIN_IDLE, MAX_IDLE))}
        />
        <label className="count-note">{t('timelens.pollLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={MIN_POLL}
          max={MAX_POLL}
          style={{ maxWidth: 70 }}
          value={pollSeconds}
          onChange={(e) => setPollSeconds(clamp(Math.floor(+e.target.value) || MIN_POLL, MIN_POLL, MAX_POLL))}
        />
      </div>

      <div className="kv-list">
        <div className="kv-row">
          <span className="label">{t('timelens.statusCol')}</span>
          <span className={`value ${idle ? '' : tracking && !paused ? 'dep-ok' : ''}`}>{statusText}</span>
        </div>
        {current && tracking && !paused && !idle && (
          <div className="kv-row">
            <span className="label">{t('timelens.foreground')}</span>
            <span className="value">{display(current.process)}{current.title ? ` — ${current.title}` : ''}</span>
          </div>
        )}
        <div className="kv-row">
          <span className="label">{t('timelens.summary')}</span>
          <span className="value">
            {empty
              ? t('timelens.summaryEmpty')
              : t('timelens.summaryValue', { dur: fmtDuration(totalSeconds), count: segments.length })}
          </span>
        </div>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}

      {empty ? (
        <p className="count-note">{t('timelens.emptyHint')}</p>
      ) : (
        <>
          <div className="panel">
            <p className="count-note" style={{ marginTop: 0 }}>{t('timelens.timelineTitle')}</p>
            {!hasActiveHours && <p className="count-note">{t('timelens.noHoursToday')}</p>}
            <div className="dt-wrap">
              {hourRows.map((slices, hour) => (
                slices.length === 0 ? null : (
                  <div key={hour} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 22 }}>
                    <span className="count-note" style={{ width: 48, flex: '0 0 auto', fontFamily: 'monospace' }}>
                      {pad2(hour)}:00
                    </span>
                    <div style={{ position: 'relative', flex: 1, height: 16, borderRadius: 3, background: 'var(--panel, rgba(127,127,127,0.15))' }}>
                      {slices.map((sl, i) => (
                        <div
                          key={i}
                          title={sl.label}
                          style={{
                            position: 'absolute',
                            top: 0,
                            height: 16,
                            left: `${sl.offFrac * 100}%`,
                            width: `${Math.max(0.5, sl.widFrac * 100)}%`,
                            borderRadius: 2,
                            background: colorFor(sl.process),
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>

          <div className="panel">
            <p className="count-note" style={{ marginTop: 0 }}>{t('timelens.totalsTitle')}</p>
            <div className="kv-list">
              {totals.map((row) => {
                const pct = totalSeconds > 0 ? Math.round((row.secs / totalSeconds) * 100) : 0;
                const frac = maxTotal > 0 ? row.secs / maxTotal : 0;
                return (
                  <div key={row.process} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, flex: '0 0 auto', background: colorFor(row.process) }} />
                      <span className="value" style={{ flex: 1 }}>{display(row.process)}</span>
                      <span className="count-note">{fmtDuration(row.secs)} · {pct}%</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--panel, rgba(127,127,127,0.15))' }}>
                      <div style={{ height: 8, borderRadius: 4, width: `${Math.max(3, frac * 100)}%`, background: colorFor(row.process) }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <p className="count-note">{t('timelens.note')}</p>
    </div>
  );
}
