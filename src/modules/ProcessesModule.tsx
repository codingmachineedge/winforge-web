import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

/**
 * System Monitor · 系統監察 — full web port of WinForge's btop-style SystemMonitorModule.
 * The desktop app samples via GetSystemTimes / GlobalMemoryStatusEx / NetworkInterface deltas and
 * LibreHardwareMonitor; here one PowerShell CIM + Get-Counter sweep gathers the same surface:
 *   • overall CPU% + per-logical-core load + a live sparkline history and CPU temperature
 *   • memory + swap (page-file) meters with used/total
 *   • network down/up rates with sparklines (byte-counter deltas computed between polls)
 *   • GPU utilisation and busiest physical-disk activity (extra web meters)
 *   • uptime, and a sortable / searchable top-processes grid with per-row CPU bars
 *   • per-process actions: End (confirmed), priority, Windows 11 efficiency mode, CPU affinity
 * Reads auto-run and refresh on an interval; every mutation is click-gated.
 */

interface ProcRow {
  pid: number;
  name: string;
  cpu: number; // % of total CPU capacity
  mem: number; // working-set bytes
}

interface Sample {
  cpu: number;
  perCore: number[];
  temp: number | null;
  memPct: number;
  memUsed: number;
  memTotal: number;
  swapPct: number;
  swapUsed: number;
  swapTotal: number;
  gpu: number | null;
  disk: number | null;
  rxBytes: number; // cumulative received bytes across active adapters
  txBytes: number; // cumulative sent bytes
  uptimeSec: number;
  procs: ProcRow[];
}

type SortKey = 'cpu' | 'mem' | 'name' | 'pid';
type PriorityClass = 'High' | 'AboveNormal' | 'Normal' | 'BelowNormal' | 'Idle';

const CPU_HISTORY = 90;
const NET_HISTORY = 60;
const TOP_N = 40;

// PowerShell 5.1-compatible enum names for [Diagnostics.ProcessPriorityClass].
const PRIORITY_CLASSES: PriorityClass[] = ['High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle'];

// ---- One read-only sampling sweep (Windows PowerShell 5.1) ----------------------------------
// Get-Counter gives cooked per-core / GPU / disk percentages without managing deltas in JS; CIM
// supplies memory, page-file, uptime and per-process working set. Network raw byte counters come
// from CIM too — the down/up *rate* is computed in JS from the delta between successive samples.
const SAMPLE_PS = `
$ErrorActionPreference = 'SilentlyContinue'

# --- CPU total + per-logical-core load ---
$cpu = 0.0; $cores = @()
try {
  $c = Get-Counter '\\Processor(*)\\% Processor Time' -ErrorAction Stop
  foreach ($s in $c.CounterSamples) {
    $inst = [string]$s.InstanceName
    $v = [math]::Round([double]$s.CookedValue, 1)
    if ($inst -eq '_Total') { $cpu = $v }
    elseif ($inst -match '^[0-9]+$') { $cores += [pscustomobject]@{ i = [int]$inst; v = [math]::Min(100, [math]::Max(0, $v)) } }
  }
} catch {}
$core = @($cores | Sort-Object i | ForEach-Object { $_.v })

# --- GPU engine utilisation (sum of 3D/compute engines, capped 100) ---
$gpu = $null
try {
  $g = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop
  $sum = 0.0; foreach ($s in $g.CounterSamples) { $sum += [double]$s.CookedValue }
  $gpu = [math]::Round([math]::Min(100, $sum), 1)
} catch {}

# --- Busiest physical disk (_Total % active time) ---
$disk = $null
try {
  $d = Get-Counter '\\PhysicalDisk(_Total)\\% Disk Time' -ErrorAction Stop
  $disk = [math]::Round([math]::Min(100, [double]($d.CounterSamples | Select-Object -First 1).CookedValue), 1)
} catch {}

# --- Memory + page file + uptime ---
$os = Get-CimInstance Win32_OperatingSystem
$totalKb = [double]$os.TotalVisibleMemorySize
$freeKb = [double]$os.FreePhysicalMemory
$memTotal = [int64]($totalKb * 1024)
$memUsed = [int64](($totalKb - $freeKb) * 1024)
$memPct = if ($totalKb -gt 0) { [math]::Round((1 - $freeKb / $totalKb) * 100, 1) } else { 0 }

$swapTotal = 0; $swapUsed = 0; $swapPct = 0
$pf = Get-CimInstance Win32_PageFileUsage
if ($pf) {
  $allocMb = 0.0; $usedMb = 0.0
  foreach ($p in $pf) { $allocMb += [double]$p.AllocatedBaseSize; $usedMb += [double]$p.CurrentUsage }
  $swapTotal = [int64]($allocMb * 1MB)
  $swapUsed = [int64]($usedMb * 1MB)
  $swapPct = if ($allocMb -gt 0) { [math]::Round($usedMb / $allocMb * 100, 1) } else { 0 }
}

$uptimeSec = 0
try { $uptimeSec = [int64]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch {}

# --- CPU temperature (°C) where the ACPI thermal-zone WMI provider exposes it ---
$temp = $null
try {
  $tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
  if ($tz -and $tz.CurrentTemperature) {
    $c = [math]::Round($tz.CurrentTemperature / 10 - 273.15, 1)
    if ($c -gt 0 -and $c -lt 130) { $temp = $c }
  }
} catch {}

# --- Network: cumulative bytes across up, non-loopback adapters (rate derived in JS) ---
$rx = [int64]0; $tx = [int64]0
try {
  $ni = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface
  foreach ($n in $ni) {
    if ([string]$n.Name -match 'Loopback|isatap|Teredo') { continue }
    $rx += [int64]$n.BytesReceivedPersec
    $tx += [int64]$n.BytesSentPersec
  }
} catch {}

# --- Top processes: CPU% (cooked, normalised by core count) + working set ---
$ncores = [Environment]::ProcessorCount
$cpuByPid = @{}
try {
  $pc = Get-Counter '\\Process(*)\\% Processor Time' -ErrorAction Stop
  $ids = Get-Counter '\\Process(*)\\ID Process' -ErrorAction Stop
  $idMap = @{}
  foreach ($s in $ids.CounterSamples) { $idMap[[string]$s.InstanceName] = [int]$s.CookedValue }
  foreach ($s in $pc.CounterSamples) {
    $inst = [string]$s.InstanceName
    if ($inst -eq '_total' -or $inst -eq 'idle') { continue }
    $id = $idMap[$inst]
    if ($id) { $cpuByPid[$id] = [math]::Round([double]$s.CookedValue / $ncores, 1) }
  }
} catch {}

$procs = @(Get-Process | ForEach-Object {
  $pct = 0.0
  if ($cpuByPid.ContainsKey($_.Id)) { $pct = [math]::Min(100, $cpuByPid[$_.Id]) }
  [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; cpu = $pct; mem = [int64]$_.WorkingSet64 }
} | Sort-Object -Property mem -Descending | Select-Object -First 220)

[pscustomobject]@{
  cpu = $cpu
  perCore = $core
  temp = $temp
  memPct = $memPct
  memUsed = $memUsed
  memTotal = $memTotal
  swapPct = $swapPct
  swapUsed = $swapUsed
  swapTotal = $swapTotal
  gpu = $gpu
  disk = $disk
  rxBytes = $rx
  txBytes = $tx
  uptimeSec = $uptimeSec
  procs = $procs
}`;

function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 10) / 10} ${u[i]}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// btop-style load colour: green (idle) → amber (mid) → red (hot).
function loadColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  const hue = 120 - (p / 100) * 120; // 120=green, 0=red
  return `hsl(${hue}, 70%, 48%)`;
}

/** Fixed-width sparkline of the most recent `cap` samples, scaled to `max`. */
function Sparkline({
  values,
  max,
  height = 48,
  color,
}: {
  values: number[];
  max: number;
  height?: number;
  color: string;
}) {
  const cap = values.length;
  const w = 300;
  const points = useMemo(() => {
    if (cap === 0) return '';
    const denom = max > 0 ? max : 1;
    return values
      .map((v, i) => {
        const x = cap === 1 ? 0 : (i / (cap - 1)) * w;
        const y = height - Math.max(0, Math.min(1, v / denom)) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [values, cap, max, height]);

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
      role="img"
    >
      {points && (
        <>
          <polyline
            points={`${points} ${w},${height} 0,${height}`}
            fill={color}
            fillOpacity={0.16}
            stroke="none"
          />
          <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
        </>
      )}
    </svg>
  );
}

/** Horizontal meter bar with a coloured fill proportional to `pct`. */
function Meter({ pct, height = 10 }: { pct: number; height?: number }) {
  return (
    <div
      style={{
        height,
        borderRadius: 3,
        background: 'var(--stroke-subtle)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: loadColor(pct),
          borderRadius: 3,
          transition: 'width .4s',
        }}
      />
    </div>
  );
}

export function ProcessesModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('cpu');
  const [sortDesc, setSortDesc] = useState(true);
  const [live, setLive] = useState(() => isTauri());
  const [intervalSec, setIntervalSec] = useState(2);
  const [snap, setSnap] = useState<Sample | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [menuPid, setMenuPid] = useState<number | null>(null);
  const [affinityRow, setAffinityRow] = useState<ProcRow | null>(null);

  // Sparkline history + previous network sample (for rate deltas), kept across renders.
  const cpuHist = useRef<number[]>([]);
  const gpuHist = useRef<number[]>([]);
  const downHist = useRef<number[]>([]);
  const upHist = useRef<number[]>([]);
  const prevNet = useRef<{ rx: number; tx: number; t: number } | null>(null);
  const [, forceTick] = useState(0);

  const { data, loading, error, reload } = useAsync(
    () => (isTauri() ? runPowershellJson<Sample>(SAMPLE_PS) : Promise.resolve([] as Sample[])),
    [],
  );

  // Fold each new sweep into the last-good snapshot + rolling histories (never flashes the UI).
  useEffect(() => {
    const s = data?.[0];
    if (!s) return;
    const now = Date.now();

    let down = 0;
    let up = 0;
    if (prevNet.current) {
      const dt = Math.max(0.001, (now - prevNet.current.t) / 1000);
      down = Math.max(0, (s.rxBytes - prevNet.current.rx) / dt);
      up = Math.max(0, (s.txBytes - prevNet.current.tx) / dt);
    }
    prevNet.current = { rx: s.rxBytes, tx: s.txBytes, t: now };

    const push = (arr: number[], v: number, cap: number) => {
      arr.push(v);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
    };
    push(cpuHist.current, s.cpu, CPU_HISTORY);
    push(gpuHist.current, s.gpu ?? 0, CPU_HISTORY);
    if (prevNet.current) {
      push(downHist.current, down, NET_HISTORY);
      push(upHist.current, up, NET_HISTORY);
    }

    setSnap(s);
    setUpdatedAt(new Date().toLocaleTimeString());
    forceTick((n) => n + 1);
  }, [data]);

  // Live polling at the chosen refresh interval (desktop offers 0.5 / 1 / 2 / 5 s).
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => reload(), Math.round(intervalSec * 1000));
    return () => window.clearInterval(id);
  }, [live, intervalSec, reload]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setSortDesc((d) => !d);
    else {
      setSort(key);
      setSortDesc(key === 'cpu' || key === 'mem'); // numbers default high→low, names low→high
    }
  };

  const rows = useMemo(() => {
    const all = snap?.procs ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
      : all;
    const dir = sortDesc ? -1 : 1;
    const sorted = [...list].sort((a, b) => {
      if (sort === 'name') return dir * a.name.localeCompare(b.name);
      if (sort === 'pid') return dir * (a.pid - b.pid);
      if (sort === 'mem') return dir * (a.mem - b.mem);
      return dir * (a.cpu - b.cpu);
    });
    return sorted.slice(0, TOP_N);
  }, [snap, filter, sort, sortDesc]);

  const netMax = useMemo(() => {
    const m = Math.max(64 * 1024, ...downHist.current, ...upHist.current);
    return m;
  }, [snap]);

  // ---- Mutations (all click-gated) ----------------------------------------------------------
  const runAction = async (label: string, script: string, pid: number, okMsg: string) => {
    setBusy(pid);
    setMenuPid(null);
    setMsg(null);
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(okMsg);
      reload();
    } catch (e) {
      setMsg(`${label}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const kill = (row: ProcRow) => {
    if (!window.confirm(t('proc.killConfirm', { name: row.name, pid: row.pid }))) return;
    void runAction(
      t('proc.killFailed', { name: row.name }),
      `Stop-Process -Id ${row.pid} -Force -ErrorAction Stop; 'ok'`,
      row.pid,
      t('proc.killed', { name: row.name, pid: row.pid }),
    );
  };

  const setPriority = (row: ProcRow, cls: PriorityClass) =>
    void runAction(
      t('proc.priFailed', { name: row.name }),
      `(Get-Process -Id ${row.pid} -ErrorAction Stop).PriorityClass=[Diagnostics.ProcessPriorityClass]::${cls}; 'ok'`,
      row.pid,
      t('proc.priDone', { name: row.name, level: t(`proc.pri${cls}`) }),
    );

  // Windows 11 Efficiency mode (EcoQoS): Idle priority + PROCESS_POWER_THROTTLING EXECUTION_SPEED,
  // applied via an inline P/Invoke — same control mask the desktop app sets. Off restores Normal.
  const setEfficiency = (row: ProcRow, on: boolean) => {
    const ctrl = on ? 1 : 0;
    const state = on ? 1 : 0;
    const pri = on ? 0x40 : 0x20; // IDLE_PRIORITY_CLASS / NORMAL_PRIORITY_CLASS
    const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Eco {
  [StructLayout(LayoutKind.Sequential)] public struct PPTS { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessInformation(IntPtr h, int c, ref PPTS s, uint sz);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetPriorityClass(IntPtr h, uint c);
  public static bool Apply(uint pid, uint ctrl, uint state, uint pri) {
    IntPtr h = OpenProcess(0x0200, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      PPTS s = new PPTS(); s.Version = 1; s.ControlMask = ctrl; s.StateMask = state;
      bool ok = SetProcessInformation(h, 4, ref s, (uint)Marshal.SizeOf(typeof(PPTS)));
      ok = SetPriorityClass(h, pri) && ok;
      return ok;
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
if ([Eco]::Apply(${row.pid}, ${ctrl}, ${state}, ${pri})) { 'ok' } else { throw 'efficiency change denied' }`;
    void runAction(
      t('proc.ecoFailed', { name: row.name }),
      script,
      row.pid,
      t(on ? 'proc.ecoOnDone' : 'proc.ecoOffDone', { name: row.name }),
    );
  };

  const applyAffinity = (row: ProcRow, mask: number) => {
    setAffinityRow(null);
    void runAction(
      t('proc.affFailed', { name: row.name }),
      `(Get-Process -Id ${row.pid} -ErrorAction Stop).ProcessorAffinity=[IntPtr]${mask}; 'ok'`,
      row.pid,
      t('proc.affDone', { name: row.name }),
    );
  };

  const coreCount = snap?.perCore.length || 0;
  const memSub = snap ? `${fmtBytes(snap.memUsed)} / ${fmtBytes(snap.memTotal)}` : '';
  const swapSub = snap
    ? snap.swapTotal > 0
      ? `${fmtBytes(snap.swapUsed)} / ${fmtBytes(snap.swapTotal)}`
      : t('proc.noPageFile')
    : '';
  const down = downHist.current[downHist.current.length - 1] ?? 0;
  const up = upHist.current[upHist.current.length - 1] ?? 0;

  const sortArrow = (key: SortKey) => (sort === key ? (sortDesc ? ' ▼' : ' ▲') : '');

  const columns: Column<ProcRow>[] = [
    {
      key: 'pid',
      header: <button className="linklike" onClick={() => toggleSort('pid')}>{t('proc.pid')}{sortArrow('pid')}</button>,
      width: 74,
      align: 'right',
      render: (p) => <span className="mono">{p.pid}</span>,
    },
    {
      key: 'name',
      header: <button className="linklike" onClick={() => toggleSort('name')}>{t('proc.name')}{sortArrow('name')}</button>,
      render: (p) => p.name,
    },
    {
      key: 'cpu',
      header: <button className="linklike" onClick={() => toggleSort('cpu')}>{t('proc.cpuHdr')}{sortArrow('cpu')}</button>,
      width: 130,
      render: (p) => (
        <div style={{ position: 'relative', height: 16, minWidth: 90 }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${Math.min(100, p.cpu)}%`,
              background: loadColor(p.cpu),
              opacity: 0.5,
              borderRadius: 2,
            }}
          />
          <span
            className="mono"
            style={{ position: 'relative', display: 'block', textAlign: 'right', fontSize: 11, lineHeight: '16px' }}
          >
            {p.cpu.toFixed(0)}%
          </span>
        </div>
      ),
    },
    {
      key: 'mem',
      header: <button className="linklike" onClick={() => toggleSort('mem')}>{t('proc.mem')}{sortArrow('mem')}</button>,
      width: 100,
      align: 'right',
      render: (p) => <span className="mono">{fmtBytes(p.mem)}</span>,
    },
    {
      key: 'actions',
      header: t('proc.actions'),
      width: 210,
      render: (p) => (
        <span className="row-actions" style={{ position: 'relative' }}>
          <button
            className="mini"
            disabled={busy === p.pid}
            onClick={() => setMenuPid((cur) => (cur === p.pid ? null : p.pid))}
          >
            {t('proc.priority')}
          </button>
          <button className="mini danger" disabled={busy === p.pid} onClick={() => kill(p)}>
            {t('proc.kill')}
          </button>
          {menuPid === p.pid && (
            <div className="proc-menu">
              {PRIORITY_CLASSES.map((cls) => (
                <button key={cls} className="proc-menu-item" onClick={() => setPriority(p, cls)}>
                  {t(`proc.pri${cls}`)}
                </button>
              ))}
              <div className="proc-menu-sep" />
              <button className="proc-menu-item" onClick={() => setEfficiency(p, true)}>
                {t('proc.ecoOn')}
              </button>
              <button className="proc-menu-item" onClick={() => setEfficiency(p, false)}>
                {t('proc.ecoOff')}
              </button>
              <div className="proc-menu-sep" />
              <button
                className="proc-menu-item"
                onClick={() => {
                  setMenuPid(null);
                  setAffinityRow(p);
                }}
              >
                {t('proc.affinity')}
              </button>
            </div>
          )}
        </span>
      ),
    },
  ];

  const noData = !snap;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className={`mini${live ? ' primary' : ''}`} onClick={() => setLive((v) => !v)}>
          {t('proc.live')}
        </button>
        <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {t('proc.refresh')}
          <select
            className="mod-select"
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
          >
            <option value={0.5}>{t('proc.int05')}</option>
            <option value={1}>{t('proc.int1')}</option>
            <option value={2}>{t('proc.int2')}</option>
            <option value={5}>{t('proc.int5')}</option>
          </select>
        </label>
        {updatedAt && <span className="count-note">{t('proc.updated', { time: updatedAt })}</span>}
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('proc.blurb')}
      </p>

      {msg && <p className="mod-msg">{msg}</p>}

      {noData ? (
        <AsyncState loading={loading} error={error}>
          <p className="count-note">{t('proc.waiting')}</p>
        </AsyncState>
      ) : (
        <>
          {error && <p className="mod-msg">{error}</p>}

          {/* CPU card: overall %, sparkline, per-core bars, temperature */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 12, marginBottom: 12 }}>
            <div className="gauge">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="label" style={{ fontWeight: 600 }}>{t('proc.cpuLabel')}</span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {snap.temp != null ? `${Math.round(snap.temp)}°C` : ''}
                </span>
                <span style={{ fontSize: 26, fontWeight: 700 }}>{Math.round(snap.cpu)}%</span>
              </div>
              <Sparkline values={cpuHist.current} max={100} color={loadColor(snap.cpu)} height={52} />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${coreCount <= 8 ? 2 : coreCount <= 24 ? 3 : 4}, 1fr)`,
                  gap: '4px 10px',
                  marginTop: 6,
                }}
              >
                {snap.perCore.map((v, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', width: 24 }}>
                      {i}
                    </span>
                    <div style={{ flex: 1 }}>
                      <Meter pct={v} height={7} />
                    </div>
                    <span className="mono" style={{ fontSize: 10, width: 30, textAlign: 'right' }}>
                      {Math.round(v)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Memory + swap meters */}
            <div className="gauge">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="label" style={{ fontWeight: 600 }}>{t('proc.memLabel')}</span>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{Math.round(snap.memPct)}%</span>
              </div>
              <div style={{ margin: '6px 0 4px' }}>
                <Meter pct={snap.memPct} />
              </div>
              <div className="count-note" style={{ marginTop: 0 }}>{memSub}</div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 12 }}>
                <span className="label" style={{ fontWeight: 600 }}>{t('proc.swapLabel')}</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {snap.swapTotal > 0 ? `${Math.round(snap.swapPct)}%` : t('proc.off')}
                </span>
              </div>
              <div style={{ margin: '6px 0 4px' }}>
                <Meter pct={snap.swapTotal > 0 ? snap.swapPct : 0} height={8} />
              </div>
              <div className="count-note" style={{ marginTop: 0 }}>{swapSub}</div>
            </div>
          </div>

          {/* Network sparklines + GPU / disk / uptime tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 12, marginBottom: 12 }}>
            <div className="gauge">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div className="mono" style={{ fontSize: 13 }}>↓ {fmtBytes(down)}/s</div>
                  <Sparkline values={downHist.current} max={netMax} color="var(--accent)" height={40} />
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 13 }}>↑ {fmtBytes(up)}/s</div>
                  <Sparkline values={upHist.current} max={netMax} color="var(--web)" height={40} />
                </div>
              </div>
              <div className="label" style={{ marginTop: 6, fontWeight: 600 }}>{t('proc.netLabel')}</div>
            </div>

            <div className="gauge">
              <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '8px 12px' }}>
                <span className="label">{t('proc.gpuLabel')}</span>
                <span className="mono">{snap.gpu != null ? `${Math.round(snap.gpu)}%` : t('proc.na')}</span>
                <span className="label">{t('proc.diskLabel')}</span>
                <span className="mono">{snap.disk != null ? `${Math.round(snap.disk)}%` : t('proc.na')}</span>
                <span className="label">{t('proc.uptimeLabel')}</span>
                <span className="mono">{fmtUptime(snap.uptimeSec)}</span>
              </div>
            </div>
          </div>

          {/* Process grid */}
          <ModuleToolbar>
            <input
              className="mod-search"
              placeholder={t('proc.filter')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select className="mod-select" value={sort} onChange={(e) => toggleSort(e.target.value as SortKey)}>
              <option value="cpu">{t('proc.sortCpu')}</option>
              <option value="mem">{t('proc.sortMem')}</option>
              <option value="name">{t('proc.sortName')}</option>
              <option value="pid">{t('proc.sortPid')}</option>
            </select>
            <span className="count-note">{t('proc.count', { count: rows.length })}</span>
          </ModuleToolbar>

          <DataTable columns={columns} rows={rows} rowKey={(p) => String(p.pid)} />
        </>
      )}

      {affinityRow && snap && (
        <AffinityDialog
          row={affinityRow}
          coreCount={Math.max(1, coreCount)}
          onClose={() => setAffinityRow(null)}
          onApply={(mask) => applyAffinity(affinityRow, mask)}
        />
      )}

      {/* Local styles for the process context menu (reuses global tokens, no new css files). */}
      <style>{`
        .proc-menu {
          position: absolute; top: 100%; right: 0; z-index: 20; margin-top: 4px;
          background: var(--bg-card); border: 1px solid var(--stroke); border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,.28); padding: 4px; min-width: 168px;
          display: flex; flex-direction: column;
        }
        .proc-menu-item {
          text-align: left; background: none; border: none; color: var(--text);
          padding: 6px 10px; border-radius: 5px; font-size: 13px; cursor: pointer; white-space: nowrap;
        }
        .proc-menu-item:hover { background: var(--stroke-subtle); }
        .proc-menu-sep { height: 1px; background: var(--stroke-subtle); margin: 4px 2px; }
        .linklike {
          background: none; border: none; color: inherit; font: inherit; font-weight: 600;
          cursor: pointer; padding: 0;
        }
        .mono { font-family: ui-monospace, Consolas, monospace; }
      `}</style>
    </div>
  );
}

/** CPU-affinity picker — choose which logical cores a process may run on (mirrors the desktop dialog). */
function AffinityDialog({
  row,
  coreCount,
  onClose,
  onApply,
}: {
  row: ProcRow;
  coreCount: number;
  onClose: () => void;
  onApply: (mask: number) => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState<boolean[]>(() => Array(coreCount).fill(true));

  const toggle = (i: number) =>
    setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)));

  const apply = () => {
    let mask = 0;
    for (let i = 0; i < coreCount; i++) if (checked[i]) mask |= 1 << i;
    if (mask !== 0) onApply(mask);
  };

  const allCores = () => onApply(coreCount >= 31 ? -1 : (1 << coreCount) - 1);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ maxWidth: 420, width: '90%', margin: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('proc.affinity')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('proc.affinityBody', { name: row.name })}
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6,
            maxHeight: 260,
            overflow: 'auto',
            margin: '10px 0',
          }}
        >
          {Array.from({ length: coreCount }, (_, i) => (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={checked[i] ?? false} onChange={() => toggle(i)} />
              CPU {i}
            </label>
          ))}
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="mini" onClick={allCores}>
            {t('proc.affAll')}
          </button>
          <button className="mini" onClick={onClose}>
            {t('proc.cancel')}
          </button>
          <button className="mini primary" onClick={apply}>
            {t('proc.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
