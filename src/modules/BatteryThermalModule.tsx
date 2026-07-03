import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

/**
 * Battery & Thermal — live port of WinForge's BatteryThermalModule.
 * Battery: Win32_Battery live charge/status + root/wmi static data (design vs full-charge
 * capacity, cycle count) for wear%. Thermal: MSAcpi_ThermalZoneTemperature zones, Win32_Fan,
 * CPU load (Win32_Processor) and memory load as sensor rows. Actions mirror the desktop app:
 * powercfg /batteryreport (parsed) and powercfg /energy warnings — both write reports to %TEMP%.
 */

interface ZoneT {
  name: string;
  c: number;
}
interface CpuT {
  name: string;
  load: number;
}
interface FanT {
  name: string;
  status: string;
}
interface Overview {
  present: boolean;
  charge: number;
  statusCode: number;
  runtimeMin: number;
  designMwh: number;
  fullMwh: number;
  cycles: number;
  manufacturer: string;
  deviceName: string;
  memLoad: number;
  memUsedGb: number;
  memTotalGb: number;
  zones: ZoneT[] | null;
  cpus: CpuT[] | null;
  fans: FanT[] | null;
}
interface HealthReport {
  ok: boolean;
  path: string;
  design: number;
  full: number;
  cycles: number;
  name: string;
  maker: string;
  chem: string;
  err: string;
}
interface EnergyResult {
  errors: number;
  warnings: number;
  path: string;
  raw: string;
}
type SensorKind = 'temp' | 'fan' | 'load';
interface SensorRow {
  hw: string;
  name: string;
  kind: SensorKind;
  reading: string;
  order: number;
}

// One read-only sweep: live battery, wear data, thermal zones, fans, CPU + memory load.
const OVERVIEW_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
$sd = Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData | Select-Object -First 1
$fc = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1
$cc = Get-CimInstance -Namespace root/wmi -ClassName BatteryCycleCount | Select-Object -First 1
$os = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1
$zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object {
    $c = [math]::Round($_.CurrentTemperature / 10 - 273.15, 1)
    if ($c -gt -20 -and $c -lt 150) {
      [pscustomobject]@{ name = [string](([string]$_.InstanceName -split '\\\\')[-1]); c = $c }
    }
  } | Where-Object { $_ })
$cpus = @(Get-CimInstance -ClassName Win32_Processor | ForEach-Object {
    [pscustomobject]@{ name = ([string]$_.Name).Trim(); load = [int]$_.LoadPercentage }
  })
$fans = @(Get-CimInstance -ClassName Win32_Fan | ForEach-Object {
    $n = ([string]$_.Name).Trim(); if (-not $n) { $n = [string]$_.DeviceID }
    [pscustomobject]@{ name = $n; status = [string]$_.Status }
  })
$memTot = 0; $memFree = 0
if ($os) { $memTot = [double]$os.TotalVisibleMemorySize; $memFree = [double]$os.FreePhysicalMemory }
$rt = -1
if ($b -and $b.EstimatedRunTime -and $b.EstimatedRunTime -gt 0 -and $b.EstimatedRunTime -lt 71582788) { $rt = [int]$b.EstimatedRunTime }
[pscustomobject]@{
  present = [bool]$b
  charge = $(if ($b) { [int]$b.EstimatedChargeRemaining } else { 0 })
  statusCode = $(if ($b) { [int]$b.BatteryStatus } else { 0 })
  runtimeMin = $rt
  designMwh = $(if ($sd -and $sd.DesignedCapacity) { [int64]$sd.DesignedCapacity } else { 0 })
  fullMwh = $(if ($fc -and $fc.FullChargedCapacity) { [int64]$fc.FullChargedCapacity } else { 0 })
  cycles = $(if ($cc -and $cc.CycleCount) { [int]$cc.CycleCount } else { 0 })
  manufacturer = $(if ($sd) { ([string]$sd.ManufactureName).Trim() } else { '' })
  deviceName = $(if ($sd) { ([string]$sd.DeviceName).Trim() } else { '' })
  memLoad = $(if ($memTot -gt 0) { [int][math]::Round((1 - $memFree / $memTot) * 100) } else { 0 })
  memUsedGb = $(if ($memTot -gt 0) { [math]::Round(($memTot - $memFree) / 1MB, 1) } else { 0 })
  memTotalGb = $(if ($memTot -gt 0) { [math]::Round($memTot / 1MB, 1) } else { 0 })
  zones = $zones
  cpus = $cpus
  fans = $fans
}`;

// powercfg /batteryreport -> parse design/full-charge capacity, cycles, name, maker, chemistry.
// Same fields as the desktop app's BatteryThermal.ParseBatteryReport, with the label pattern
// widened for Windows 11 reports where labels are wrapped as <span class="label">…</span>.
const HEALTH_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Join-Path $env:TEMP 'winforge-battery-report.html'
$raw = ((& cmd.exe /c ('powercfg.exe /batteryreport /output "' + $p + '" 2>&1')) -join ' ').Trim()
if (Test-Path $p) {
  $h = Get-Content $p -Raw
  $md = [regex]::Match($h, 'DESIGN CAPACITY\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*([\\d.,\\s]+?)\\s*mWh', 'IgnoreCase,Singleline')
  $mf = [regex]::Match($h, 'FULL CHARGE CAPACITY\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*([\\d.,\\s]+?)\\s*mWh', 'IgnoreCase,Singleline')
  $mc = [regex]::Match($h, 'CYCLE COUNT\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*([\\d,\\s]+?)\\s*</td>', 'IgnoreCase,Singleline')
  $mn = [regex]::Match($h, '>\\s*NAME\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*(.*?)\\s*</td>', 'IgnoreCase,Singleline')
  $mm = [regex]::Match($h, '>\\s*MANUFACTURER\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*(.*?)\\s*</td>', 'IgnoreCase,Singleline')
  $mh = [regex]::Match($h, '>\\s*CHEMISTRY\\s*(?:</span>)?\\s*</td>\\s*<td[^>]*>\\s*(.*?)\\s*</td>', 'IgnoreCase,Singleline')
  $design = [int64]0; if ($md.Success) { $d = $md.Groups[1].Value -replace '[^0-9]', ''; if ($d) { $design = [int64]$d } }
  $full = [int64]0; if ($mf.Success) { $d = $mf.Groups[1].Value -replace '[^0-9]', ''; if ($d) { $full = [int64]$d } }
  $cyc = 0; if ($mc.Success) { $d = $mc.Groups[1].Value -replace '[^0-9]', ''; if ($d) { $cyc = [int]$d } }
  $nm = ''; if ($mn.Success) { $nm = ($mn.Groups[1].Value -replace '<.*?>', '').Trim() }
  $mk = ''; if ($mm.Success) { $mk = ($mm.Groups[1].Value -replace '<.*?>', '').Trim() }
  $ch = ''; if ($mh.Success) { $ch = ($mh.Groups[1].Value -replace '<.*?>', '').Trim() }
  [pscustomobject]@{ ok = ($design -gt 0 -or $full -gt 0); path = $p; design = $design; full = $full; cycles = $cyc; name = $nm; maker = $mk; chem = $ch; err = '' }
} else {
  [pscustomobject]@{ ok = $false; path = ''; design = 0; full = 0; cycles = 0; name = ''; maker = ''; chem = ''; err = $raw }
}`;

// powercfg /energy — 10 s observation window like the desktop app. Needs admin on most systems.
// cmd.exe /c merges powercfg's stderr as plain text (PS 5.1 2>&1 turns it into error records).
const ENERGY_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Join-Path $env:TEMP 'winforge-energy-report.html'
$raw = & cmd.exe /c ('powercfg.exe /energy /output "' + $p + '" /duration 10 2>&1')
($raw -join [Environment]::NewLine).Trim()
if (Test-Path $p) { 'REPORT_PATH::' + $p }`;

/** Wear % from design vs full-charge capacity (desktop formula: 0 unless full <= design). */
function wearPercent(design: number, full: number): number | null {
  if (design > 0 && full > 0 && full <= design) {
    return Math.round((1 - full / design) * 1000) / 10;
  }
  return null;
}

const fmt = (mwh: number) => mwh.toLocaleString();

export function BatteryThermalModule() {
  const { t } = useTranslation();
  const [live, setLive] = useState(() => isTauri());
  const [snap, setSnap] = useState<Overview | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [busy, setBusy] = useState<'health' | 'energy' | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [energy, setEnergy] = useState<EnergyResult | null>(null);

  const { data, loading, error, reload } = useAsync(
    () => (isTauri() ? runPowershellJson<Overview>(OVERVIEW_PS) : Promise.resolve([] as Overview[])),
    [],
  );

  // Keep the last good snapshot rendered so live refreshes never flash the UI.
  useEffect(() => {
    const first = data?.[0];
    if (first) {
      setSnap(first);
      setUpdatedAt(new Date().toLocaleTimeString());
    }
  }, [data]);

  // Live sampling — the desktop ticks every 1 s; a PowerShell sweep every 5 s is the web pace.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => reload(), 5000);
    return () => window.clearInterval(id);
  }, [live, reload]);

  const onAc = snap ? [2, 6, 7, 8, 9, 11].includes(snap.statusCode) : false;
  const statusKey =
    snap && snap.statusCode >= 1 && snap.statusCode <= 11
      ? `battery.st${snap.statusCode}`
      : 'battery.stUnknown';

  // Health card prefers the parsed powercfg report, falls back to root/wmi static data.
  const design = health?.ok && health.design > 0 ? health.design : snap?.designMwh ?? 0;
  const full = health?.ok && health.full > 0 ? health.full : snap?.fullMwh ?? 0;
  const cycles = health?.ok && health.cycles > 0 ? health.cycles : snap?.cycles ?? 0;
  const wear = wearPercent(design, full);

  const hottest = useMemo(() => {
    const zs = snap?.zones ?? [];
    let max: ZoneT | null = null;
    for (const z of zs) if (!max || z.c > max.c) max = z;
    return max ? { c: max.c, total: zs.length } : null;
  }, [snap]);

  const sensors = useMemo<SensorRow[]>(() => {
    if (!snap) return [];
    const rows: SensorRow[] = [];
    for (const z of snap.zones ?? []) {
      rows.push({
        hw: t('battery.zoneHw'),
        name: z.name || 'TZ',
        kind: 'temp',
        reading: `${Number(z.c).toFixed(1)} °C`,
        order: 0,
      });
    }
    for (const f of snap.fans ?? []) {
      rows.push({
        hw: t('battery.fanHw'),
        name: f.name || 'Fan',
        kind: 'fan',
        reading: f.status || 'OK',
        order: 1,
      });
    }
    for (const c of snap.cpus ?? []) {
      rows.push({
        hw: c.name || 'CPU',
        name: t('battery.cpuTotal'),
        kind: 'load',
        reading: `${c.load} %`,
        order: 2,
      });
    }
    if (snap.memTotalGb > 0) {
      rows.push({
        hw: t('battery.memHw'),
        name: t('battery.memUsed', { used: snap.memUsedGb, total: snap.memTotalGb }),
        kind: 'load',
        reading: `${snap.memLoad} %`,
        order: 2,
      });
    }
    // Same stable ordering as the desktop: temperature, fan, load; then hardware, then name.
    rows.sort((a, b) => a.order - b.order || a.hw.localeCompare(b.hw) || a.name.localeCompare(b.name));
    return rows;
  }, [snap, t]);

  const kindLabel = (k: SensorKind) =>
    k === 'temp' ? t('battery.typeTemp') : k === 'fan' ? t('battery.typeFan') : t('battery.typeLoad');

  const runHealth = async () => {
    if (busy) return;
    setBusy('health');
    setActionMsg(t('battery.genReport'));
    try {
      const rows = await runPowershellJson<HealthReport>(HEALTH_PS);
      const r = rows[0];
      if (r && r.ok) {
        setHealth(r);
        setActionMsg(null);
      } else {
        setHealth(null);
        setActionMsg(r?.err?.trim() || t('battery.reportNoData'));
      }
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runEnergy = async () => {
    if (busy) return;
    setBusy('energy');
    setActionMsg(t('battery.energyRunning'));
    try {
      const res = await runPowershell(ENERGY_PS);
      const rawAll = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`.trim();
      const pathMatch = /REPORT_PATH::(.+)/.exec(rawAll);
      const path = pathMatch?.[1]?.trim() ?? '';
      const raw = rawAll.replace(/REPORT_PATH::.+/g, '').trim();
      const eC = /(\d+)\s+Error/i.exec(raw)?.[1];
      const wC = /(\d+)\s+Warning/i.exec(raw)?.[1];
      if (eC !== undefined && wC !== undefined) {
        setEnergy({ errors: Number(eC), warnings: Number(wC), path, raw });
        setActionMsg(t('battery.energyDone', { e: eC, w: wC }));
      } else {
        setEnergy({ errors: -1, warnings: -1, path, raw });
        setActionMsg(t('battery.energyFailed'));
      }
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<SensorRow>[] = [
    { key: 'hw', header: t('battery.colHw'), width: 240 },
    { key: 'name', header: t('battery.colSensor') },
    { key: 'kind', header: t('battery.colType'), width: 110, render: (r) => kindLabel(r.kind) },
    {
      key: 'reading',
      header: t('battery.colReading'),
      width: 120,
      align: 'right',
      render: (r) => <strong>{r.reading}</strong>,
    },
  ];

  const runtimeLine =
    snap && snap.present && snap.runtimeMin > 0 && !onAc
      ? t('battery.remaining', { h: Math.floor(snap.runtimeMin / 60), m: snap.runtimeMin % 60 })
      : snap && snap.present && onAc
        ? t('battery.onAc')
        : '';

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className={`mini${live ? ' primary' : ''}`} onClick={() => setLive((v) => !v)}>
          {t('battery.live')}
        </button>
        <span className="count-note">{t('battery.sensorRows', { n: sensors.length })}</span>
        {updatedAt && <span className="count-note">{t('battery.updated', { time: updatedAt })}</span>}
      </ModuleToolbar>

      {/* live cards row — battery charge, health/wear, hottest sensor */}
      <div className="gauges" style={{ marginBottom: 14 }}>
        <div className="gauge">
          <div className="label">{t('battery.batteryCard')}</div>
          <div className="value">
            {!snap ? '—' : snap.present ? `${snap.charge}%` : t('battery.noBattery')}
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: 'var(--stroke-subtle)',
              overflow: 'hidden',
              margin: '8px 0 6px',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${snap && snap.present ? Math.min(100, Math.max(0, snap.charge)) : 0}%`,
                background: 'var(--accent)',
                borderRadius: 3,
                transition: 'width .5s',
              }}
            />
          </div>
          <div className="count-note" style={{ marginTop: 0 }}>
            {!snap ? '' : snap.present ? t(statusKey) : t('battery.noBatteryNote')}
          </div>
          {runtimeLine && (
            <div className="count-note" style={{ marginTop: 2 }}>
              {runtimeLine}
            </div>
          )}
        </div>

        <div className="gauge">
          <div className="label">{t('battery.healthCard')}</div>
          <div className="value">{wear !== null ? `${wear}%` : '—'}</div>
          {design > 0 && full > 0 && (
            <div className="count-note" style={{ marginTop: 6 }}>
              {t('battery.caps', { full: fmt(full), design: fmt(design) })}
            </div>
          )}
          {cycles > 0 && (
            <div className="count-note" style={{ marginTop: 2 }}>
              {t('battery.cycles', { n: cycles })}
            </div>
          )}
          {snap && (snap.deviceName || snap.manufacturer) && (
            <div className="count-note" style={{ marginTop: 2 }}>
              {[snap.deviceName, snap.manufacturer].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>

        <div className="gauge">
          <div className="label">{t('battery.hottestCard')}</div>
          <div className="value">{hottest ? `${hottest.c.toFixed(1)} °C` : '—'}</div>
          <div className="count-note" style={{ marginTop: 6 }}>
            {hottest ? t('battery.zoneSub', { n: hottest.total }) : t('battery.noThermal')}
          </div>
        </div>
      </div>

      {/* actions — same two reports as the desktop app, gated behind explicit clicks */}
      <ModuleToolbar>
        <button className="mini" disabled={busy !== null} onClick={runHealth}>
          {t('battery.healthBtn')}
        </button>
        <button className="mini" disabled={busy !== null} onClick={runEnergy}>
          {t('battery.energyBtn')}
        </button>
        {busy && <span className="count-note">…</span>}
      </ModuleToolbar>
      {actionMsg && <p className="mod-msg">{actionMsg}</p>}

      {health && health.ok && (
        <div className="panel" style={{ marginTop: 8 }}>
          <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {t('battery.healthTitle')}
            <button className="mini" onClick={() => setHealth(null)}>
              {t('battery.close')}
            </button>
          </h3>
          <dl className="kv">
            {health.name && (
              <>
                <dt>{t('battery.device')}</dt>
                <dd>{health.name}</dd>
              </>
            )}
            {health.maker && (
              <>
                <dt>{t('battery.manufacturer')}</dt>
                <dd>{health.maker}</dd>
              </>
            )}
            {health.chem && (
              <>
                <dt>{t('battery.chemistry')}</dt>
                <dd>{health.chem}</dd>
              </>
            )}
            {health.design > 0 && (
              <>
                <dt>{t('battery.designCap')}</dt>
                <dd>{fmt(health.design)} mWh</dd>
              </>
            )}
            {health.full > 0 && (
              <>
                <dt>{t('battery.fullCap')}</dt>
                <dd>{fmt(health.full)} mWh</dd>
              </>
            )}
            {health.cycles > 0 && (
              <>
                <dt>{t('battery.cycleCount')}</dt>
                <dd>{health.cycles}</dd>
              </>
            )}
          </dl>
          <p style={{ fontWeight: 600, marginTop: 10, marginBottom: 4 }}>
            {t('battery.wear', { pct: wearPercent(health.design, health.full) ?? 0 })}
          </p>
          {health.path && (
            <p className="count-note">{t('battery.savedHtml', { path: health.path })}</p>
          )}
        </div>
      )}

      {energy && (
        <div className="panel" style={{ marginTop: 8 }}>
          <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {t('battery.energyBtn')}
            <button className="mini" onClick={() => setEnergy(null)}>
              {t('battery.close')}
            </button>
          </h3>
          <p className="count-note" style={{ marginTop: 0 }}>
            {energy.errors >= 0
              ? t('battery.energyDone', { e: energy.errors, w: energy.warnings })
              : t('battery.energyFailed')}
          </p>
          {energy.path && (
            <p className="count-note">{t('battery.savedTo', { path: energy.path })}</p>
          )}
          {energy.raw && (
            <pre className="cmd-out" style={{ maxHeight: 260, overflow: 'auto' }}>
              {energy.raw}
            </pre>
          )}
        </div>
      )}

      {/* sensor table — temperature, fan, load rows like the desktop list */}
      {error && snap && <p className="mod-msg">{error}</p>}
      {!snap ? (
        <AsyncState loading={loading} error={error}>
          <DataTable
            columns={columns}
            rows={sensors}
            rowKey={(r, i) => `${r.hw}|${r.name}|${i}`}
            empty={`${t('battery.emptyTitle')} — ${t('battery.emptyBody')}`}
          />
        </AsyncState>
      ) : (
        <DataTable
          columns={columns}
          rows={sensors}
          rowKey={(r, i) => `${r.hw}|${r.name}|${i}`}
          empty={`${t('battery.emptyTitle')} — ${t('battery.emptyBody')}`}
        />
      )}
    </div>
  );
}
