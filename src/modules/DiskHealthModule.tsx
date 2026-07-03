import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

/**
 * Disk Health (SMART) — CrystalDiskInfo-style health monitor, ported from the
 * WinForge desktop module. One consolidated PowerShell 5.1 pass gathers:
 *   - identity from Win32_DiskDrive (model/serial/firmware/interface/size),
 *   - media/bus/health from Get-PhysicalDisk (MSFT_PhysicalDisk),
 *   - temperature / power-on hours / wear from Get-StorageReliabilityCounter,
 *   - the raw ATA SMART attribute + threshold blobs from root\wmi
 *     (MSStorageDriver_FailurePredictData/-Thresholds/-Status), parsed
 *     byte-by-byte exactly like the desktop SmartService (30 × 12-byte entries).
 * Read-only: data gathering only, never writes to any drive.
 */

interface AttrJson {
  Id: number;
  Cur: number;
  Worst: number;
  Thr: number;
  Raw: number;
}

interface DiskJson {
  Index: number;
  Model?: string | null;
  Serial?: string | null;
  Firmware?: string | null;
  Iface?: string | null;
  Bus?: string | null;
  Media?: string | null;
  HealthStatus?: string | null;
  SizeBytes?: number | null;
  IsNvme?: boolean | null;
  Elevated?: boolean | null;
  PredictFailure?: boolean | null;
  TempC?: number | null;
  TempMax?: number | null;
  PowerOnHours?: number | null;
  PowerCycles?: number | null;
  Wear?: number | null;
  ReadErrU?: number | null;
  WriteErrU?: number | null;
  SmartRead?: boolean | null;
  Attributes?: AttrJson[] | AttrJson | null;
}

interface AttrRowView {
  id: string;
  name: string;
  cur: string;
  worst: string;
  thr: string;
  raw: string;
}

/** One read-only PowerShell pass over every physical disk (5.1-compatible). */
const PS_SCRIPT = `
$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
$dd = @()
try { $dd = @(Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction Stop) } catch { }
$pdMap = @{}
try { foreach ($p in @(Get-PhysicalDisk -ErrorAction Stop)) { $pdMap[[string]$p.DeviceId] = $p } } catch { }
$relMap = @{}
try { foreach ($r in @($pdMap.Values | Get-StorageReliabilityCounter -ErrorAction Stop)) { $relMap[[string]$r.DeviceId] = $r } } catch { }
$statMap = @{}
$dataMap = @{}
$thrMap = @{}
try { foreach ($x in @(Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop)) { $statMap[(([string]$x.InstanceName) -replace '_\\d+$','').ToUpper()] = [bool]$x.PredictFailure } } catch { }
try { foreach ($x in @(Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictData -ErrorAction Stop)) { $dataMap[(([string]$x.InstanceName) -replace '_\\d+$','').ToUpper()] = $x.VendorSpecific } } catch { }
try { foreach ($x in @(Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictThresholds -ErrorAction Stop)) { $thrMap[(([string]$x.InstanceName) -replace '_\\d+$','').ToUpper()] = $x.VendorSpecific } } catch { }
foreach ($mo in ($dd | Sort-Object Index)) {
  $idx = [int]$mo.Index
  $p = $pdMap[[string]$idx]
  $r = $relMap[[string]$idx]
  $pnp = ([string]$mo.PNPDeviceID).ToUpper()
  $media = ([string]$mo.MediaType).Trim()
  $bus = ''
  $health = ''
  $size = [long]0
  if ($mo.Size) { $size = [long]$mo.Size }
  if ($p) {
    $mt = [string]$p.MediaType
    if ($mt -eq '3') { $mt = 'HDD' }
    if ($mt -eq '4') { $mt = 'SSD' }
    if ($mt -eq '5') { $mt = 'SCM' }
    if ($mt -eq '0' -or $mt -eq 'Unspecified') { $mt = '' }
    if ($mt -ne '' -and ($media -eq '' -or $media -eq 'Fixed hard disk media')) { $media = $mt }
    $bus = [string]$p.BusType
    if ($bus -eq '17') { $bus = 'NVMe' }
    if ($bus -eq '11') { $bus = 'SATA' }
    if ($bus -eq '10') { $bus = 'SAS' }
    if ($bus -eq '8') { $bus = 'RAID' }
    if ($bus -eq '7') { $bus = 'USB' }
    if ($bus -eq '3') { $bus = 'ATA' }
    $health = [string]$p.HealthStatus
    if ($health -eq '0') { $health = 'Healthy' }
    if ($health -eq '1') { $health = 'Warning' }
    if ($health -eq '2') { $health = 'Unhealthy' }
    if ($size -eq 0 -and $p.Size) { $size = [long]$p.Size }
  }
  $isNvme = ($pnp -like '*NVME*') -or ($bus -eq 'NVMe') -or (([string]$mo.Model).ToUpper() -like '*NVME*')
  if ($media -eq '' -or $media -eq 'Fixed hard disk media') { if ($isNvme) { $media = 'NVMe' } else { $media = 'Unknown' } }
  $pf = $null
  if ($statMap.ContainsKey($pnp)) { $pf = $statMap[$pnp] }
  $thrDict = @{}
  if ($thrMap.ContainsKey($pnp)) {
    $tvs = $thrMap[$pnp]
    for ($i = 0; $i -lt 30; $i++) {
      $off = 2 + $i * 12
      if (($off + 1) -ge $tvs.Length) { break }
      $tid = [int]$tvs[$off]
      if ($tid -ne 0) { $thrDict[$tid] = [int]$tvs[$off + 1] }
    }
  }
  $attrs = @()
  if ($dataMap.ContainsKey($pnp)) {
    $vs = $dataMap[$pnp]
    for ($i = 0; $i -lt 30; $i++) {
      $off = 2 + $i * 12
      if (($off + 11) -ge $vs.Length) { break }
      $id = [int]$vs[$off]
      if ($id -eq 0) { continue }
      $raw = [long]0
      for ($b = 5; $b -ge 0; $b--) { $raw = ($raw * 256) + [long]$vs[$off + 5 + $b] }
      $thr = 0
      if ($thrDict.ContainsKey($id)) { $thr = $thrDict[$id] }
      $attrs += [pscustomobject]@{ Id = $id; Cur = [int]$vs[$off + 3]; Worst = [int]$vs[$off + 4]; Thr = $thr; Raw = $raw }
    }
  }
  $tempC = $null; $tempMax = $null; $poh = $null; $cyc = $null; $wear = $null; $rerr = $null; $werr = $null
  if ($r) {
    if ($r.Temperature -ne $null -and [int]$r.Temperature -gt 0) { $tempC = [int]$r.Temperature }
    if ($r.TemperatureMax -ne $null -and [int]$r.TemperatureMax -gt 0) { $tempMax = [int]$r.TemperatureMax }
    if ($r.PowerOnHours -ne $null) { $poh = [long]$r.PowerOnHours }
    if ($r.StartStopCycleCount -ne $null) { $cyc = [long]$r.StartStopCycleCount }
    if ($r.Wear -ne $null) { $wear = [int]$r.Wear }
    if ($r.ReadErrorsUncorrected -ne $null) { $rerr = [long]$r.ReadErrorsUncorrected }
    if ($r.WriteErrorsUncorrected -ne $null) { $werr = [long]$r.WriteErrorsUncorrected }
  }
  [pscustomobject]@{
    Index = $idx
    Model = ([string]$mo.Model).Trim()
    Serial = ([string]$mo.SerialNumber).Trim()
    Firmware = ([string]$mo.FirmwareRevision).Trim()
    Iface = ([string]$mo.InterfaceType).Trim()
    Bus = $bus
    Media = $media
    HealthStatus = $health
    SizeBytes = $size
    IsNvme = [bool]$isNvme
    Elevated = [bool]$isAdmin
    PredictFailure = $pf
    TempC = $tempC
    TempMax = $tempMax
    PowerOnHours = $poh
    PowerCycles = $cyc
    Wear = $wear
    ReadErrU = $rerr
    WriteErrU = $werr
    SmartRead = [bool]($attrs.Count -gt 0)
    Attributes = $attrs
  }
}
`;

/** Bilingual ATA attribute names, ported verbatim from the desktop SmartService. */
const ATTR_NAMES: Record<number, readonly [string, string]> = {
  0x01: ['Raw Read Error Rate', '原始讀取錯誤率'],
  0x02: ['Throughput Performance', '輸送量效能'],
  0x03: ['Spin-Up Time', '啟動時間'],
  0x04: ['Start/Stop Count', '啟停次數'],
  0x05: ['Reallocated Sectors Count', '重新分配磁區數'],
  0x07: ['Seek Error Rate', '尋道錯誤率'],
  0x08: ['Seek Time Performance', '尋道效能'],
  0x09: ['Power-On Hours', '通電時數'],
  0x0a: ['Spin Retry Count', '啟動重試次數'],
  0x0b: ['Recalibration Retries', '重新校準重試'],
  0x0c: ['Power Cycle Count', '通電次數'],
  0x0d: ['Soft Read Error Rate', '軟讀取錯誤率'],
  0xaa: ['Available Reserved Space', '可用保留空間'],
  0xab: ['Program Fail Count', '編程失敗次數'],
  0xac: ['Erase Fail Count', '抹除失敗次數'],
  0xae: ['Unexpected Power Loss', '異常斷電次數'],
  0xb1: ['Wear Leveling Count', '磨損平衡次數'],
  0xb7: ['SATA Downshift Error Count', 'SATA 降速錯誤'],
  0xb8: ['End-to-End Error', '端對端錯誤'],
  0xbb: ['Reported Uncorrectable Errors', '報告之不可修正錯誤'],
  0xbc: ['Command Timeout', '指令逾時'],
  0xbd: ['High Fly Writes', '高飛寫入'],
  0xbe: ['Airflow Temperature', '氣流溫度'],
  0xbf: ['G-Sense Error Rate', '震動錯誤率'],
  0xc0: ['Power-Off Retract Count', '斷電收回次數'],
  0xc1: ['Load/Unload Cycle Count', '載入／卸載循環'],
  0xc2: ['Temperature', '溫度'],
  0xc3: ['Hardware ECC Recovered', '硬體 ECC 修復'],
  0xc4: ['Reallocation Event Count', '重新分配事件數'],
  0xc5: ['Current Pending Sector Count', '待處理磁區數'],
  0xc6: ['Uncorrectable Sector Count', '不可修正磁區數'],
  0xc7: ['UltraDMA CRC Error Count', 'UltraDMA CRC 錯誤'],
  0xc8: ['Write Error Rate', '寫入錯誤率'],
  0xca: ['Data Address Mark Errors', '資料位址標記錯誤'],
  0xcc: ['Soft ECC Correction', '軟 ECC 修正'],
  0xcd: ['Thermal Asperity Rate', '熱粗糙率'],
  0xdc: ['Disk Shift', '磁碟偏移'],
  0xdf: ['Load/Unload Retry Count', '載入／卸載重試'],
  0xe1: ['Load Friction', '載入摩擦'],
  0xe7: ['SSD Life Left / Temperature', 'SSD 剩餘壽命／溫度'],
  0xe8: ['Endurance Remaining', '剩餘耐用度'],
  0xe9: ['Media Wearout Indicator', '媒體耗損指標'],
  0xf1: ['Total LBAs Written', '累計寫入 LBA'],
  0xf2: ['Total LBAs Read', '累計讀取 LBA'],
  0xfa: ['Read Error Retry Rate', '讀取錯誤重試率'],
};

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const num = (v: number) => v.toLocaleString();

function attrName(id: number, zh: boolean): string {
  const pair = ATTR_NAMES[id];
  if (pair) return zh ? pair[1] : pair[0];
  const h = hex2(id);
  return zh ? `屬性 0x${h}` : `Attribute 0x${h}`;
}

function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const n = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n} ${units[i] ?? 'B'}`;
}

function attrsOf(d: DiskJson): AttrJson[] {
  const a = d.Attributes;
  if (Array.isArray(a)) return a;
  if (a && typeof a === 'object') return [a];
  return [];
}

function rawOf(d: DiskJson, id: number): number | null {
  const a = attrsOf(d).find((x) => x.Id === id);
  return a ? a.Raw : null;
}

/** Current temperature: reliability counter first, then ATA attr C2 (low byte). */
function tempOf(d: DiskJson): number | null {
  if (typeof d.TempC === 'number' && d.TempC > 0) return d.TempC;
  const r = rawOf(d, 0xc2);
  if (r != null) return r % 256;
  return null;
}

function hoursOf(d: DiskJson): number | null {
  if (typeof d.PowerOnHours === 'number') return d.PowerOnHours;
  return rawOf(d, 0x09);
}

function cyclesOf(d: DiskJson): number | null {
  if (typeof d.PowerCycles === 'number') return d.PowerCycles;
  return rawOf(d, 0x0c);
}

/** Percentage of life used: NVMe/SSD wear counter, else ATA attr E7 (life left). */
function lifeUsedOf(d: DiskJson): number | null {
  if (typeof d.Wear === 'number' && (d.Wear > 0 || d.IsNvme === true)) return d.Wear;
  const e7 = rawOf(d, 0xe7);
  if (e7 != null && e7 >= 0 && e7 <= 100) return 100 - e7;
  return null;
}

/** Anything beyond bare WMI identity was read for this drive. */
function hasSmartData(d: DiskJson): boolean {
  return (
    d.SmartRead === true ||
    tempOf(d) != null ||
    hoursOf(d) != null ||
    cyclesOf(d) != null ||
    lifeUsedOf(d) != null
  );
}

type Health = 'good' | 'warn' | 'bad' | 'unknown';

const HEALTH_COLOR: Record<Health, string> = {
  good: '#167a3d',
  warn: '#b27a00',
  bad: '#c42b1c',
  unknown: '#6b6b6b',
};

/** Health bucket — same thresholds as the desktop module, plus the Windows
 *  failure-prediction flag and MSFT_PhysicalDisk HealthStatus as extra signals. */
function healthOf(d: DiskJson): Health {
  const attrs = attrsOf(d);
  const realloc = rawOf(d, 0x05);
  const pending = rawOf(d, 0xc5);
  const uncorr = rawOf(d, 0xc6);
  const used = lifeUsedOf(d);
  const temp = tempOf(d);
  if (
    d.PredictFailure === true ||
    d.HealthStatus === 'Unhealthy' ||
    (realloc ?? 0) > 0 ||
    (uncorr ?? 0) > 0 ||
    (used ?? 0) >= 100 ||
    attrs.some((a) => a.Thr > 0 && a.Cur > 0 && a.Cur <= a.Thr)
  ) {
    return 'bad';
  }
  if (
    d.HealthStatus === 'Warning' ||
    (pending ?? 0) > 0 ||
    (used ?? 0) >= 80 ||
    (temp ?? 0) >= 60 ||
    attrs.some((a) => a.Thr > 0 && a.Cur > 0 && a.Cur <= a.Thr + 10)
  ) {
    return 'warn';
  }
  if (hasSmartData(d) || d.HealthStatus === 'Healthy') return 'good';
  return 'unknown';
}

const cardStyle: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--stroke)',
  borderRadius: 'var(--radius-lg)',
  padding: 16,
  marginBottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const pillStyle = (bg: string): CSSProperties => ({
  background: bg,
  color: '#fff',
  borderRadius: 999,
  padding: '3px 12px',
  fontWeight: 600,
  fontSize: 12.5,
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

const tileCapStyle: CSSProperties = { fontSize: 11, color: 'var(--text-tertiary)' };
const tileValStyle: CSSProperties = { fontSize: 18, fontWeight: 600 };

export function DiskHealthModule() {
  const { t, i18n } = useTranslation();
  const [auto, setAuto] = useState(false);
  const zh = (i18n.resolvedLanguage ?? i18n.language ?? '').toLowerCase().startsWith('zh');

  const { data, loading, error, reload } = useAsync(() => runPowershellJson<DiskJson>(PS_SCRIPT), []);
  const disks = data ?? [];

  // Desktop parity: the XAML module re-reads temperatures on a timer; here the
  // opt-in checkbox re-runs the (read-only) scan every 30 seconds.
  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => reload(), 30000);
    return () => window.clearInterval(id);
  }, [auto, reload]);

  const elevated = disks.some((d) => d.Elevated === true);
  const anyBlocked = disks.some((d) => !hasSmartData(d));

  const attrCols: Column<AttrRowView>[] = [
    { key: 'id', header: t('diskhealth.colId'), width: 52, render: (r) => <code>{r.id}</code> },
    { key: 'name', header: t('diskhealth.colName') },
    { key: 'cur', header: t('diskhealth.colCur'), width: 70, align: 'right' },
    { key: 'worst', header: t('diskhealth.colWorst'), width: 70, align: 'right' },
    { key: 'thr', header: t('diskhealth.colThr'), width: 80, align: 'right' },
    { key: 'raw', header: t('diskhealth.colRaw'), width: 150, align: 'right', render: (r) => <code>{r.raw}</code> },
  ];

  const renderCard = (d: DiskJson) => {
    const na = t('diskhealth.na');
    const model = (d.Model ?? '').trim() || t('diskhealth.unknownDrive');
    const serial = (d.Serial ?? '').trim() || na;
    const firmware = (d.Firmware ?? '').trim() || na;
    const iface = (d.Bus ?? '').trim() || (d.Iface ?? '').trim() || (d.IsNvme ? 'NVMe' : '—');
    const media = d.IsNvme ? 'NVMe SSD' : (d.Media ?? '').trim() || 'Unknown';
    const sub = `${t('diskhealth.serial')}: ${serial} · ${t('diskhealth.firmware')}: ${firmware} · ${iface} · ${media} · ${humanSize(d.SizeBytes ?? 0)} · \\\\.\\PhysicalDrive${d.Index}`;

    const health = healthOf(d);
    const healthLabel =
      health === 'good'
        ? t('diskhealth.healthGood')
        : health === 'warn'
          ? t('diskhealth.healthWarn')
          : health === 'bad'
            ? t('diskhealth.healthBad')
            : t('diskhealth.healthUnknown');

    const temp = tempOf(d);
    const hours = hoursOf(d);
    const cycles = cyclesOf(d);
    const used = lifeUsedOf(d);
    const realloc = rawOf(d, 0x05);

    // Fourth headline tile depends on media type (desktop parity).
    let extraCap: string;
    let extraVal: string;
    if (d.IsNvme && used != null) {
      extraCap = t('diskhealth.lifeUsed');
      extraVal = `${used}%`;
    } else if (realloc != null) {
      extraCap = t('diskhealth.reallocated');
      extraVal = num(realloc);
    } else if (used != null) {
      extraCap = t('diskhealth.lifeUsed');
      extraVal = `${used}%`;
    } else {
      extraCap = t('diskhealth.iface');
      extraVal = iface;
    }

    const tiles: Array<[string, string]> = [
      [t('diskhealth.temp'), temp != null ? `${temp} °C` : '—'],
      [t('diskhealth.hours'), hours != null ? `${num(hours)} h` : '—'],
      [t('diskhealth.cycles'), cycles != null ? num(cycles) : '—'],
      [extraCap, extraVal],
    ];

    const ataAttrs = attrsOf(d);
    const ataRows: AttrRowView[] = ataAttrs.map((a) => ({
      id: hex2(a.Id),
      name: attrName(a.Id, zh),
      cur: a.Cur > 0 ? String(a.Cur) : '—',
      worst: a.Worst > 0 ? String(a.Worst) : '—',
      thr: a.Thr > 0 ? String(a.Thr) : '—',
      raw: num(a.Raw),
    }));

    // NVMe / non-ATA drives: surface the reliability counters as pseudo-rows,
    // like the desktop module surfaces the NVMe health log.
    const pseudoRows: AttrRowView[] = [];
    if (ataRows.length === 0) {
      const push = (name: string, val: string) =>
        pseudoRows.push({ id: '—', name, cur: '—', worst: '—', thr: '—', raw: val });
      if (temp != null) push(t('diskhealth.temp'), `${temp} °C`);
      if (typeof d.TempMax === 'number' && d.TempMax > 0) push(t('diskhealth.tempMax'), `${d.TempMax} °C`);
      if (used != null) push(t('diskhealth.lifeUsed'), `${used}%`);
      if (hours != null) push(t('diskhealth.hours'), `${num(hours)} h`);
      if (cycles != null) push(t('diskhealth.cycles'), num(cycles));
      if (typeof d.ReadErrU === 'number') push(t('diskhealth.readErr'), num(d.ReadErrU));
      if (typeof d.WriteErrU === 'number') push(t('diskhealth.writeErr'), num(d.WriteErrU));
    }
    const tableRows = ataRows.length > 0 ? ataRows : pseudoRows;
    const tableHeader =
      ataRows.length > 0
        ? t('diskhealth.attrHeader', { n: ataRows.length })
        : t('diskhealth.relHeader', { n: pseudoRows.length });

    return (
      <div key={d.Index} style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{model}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{sub}</div>
          </div>
          <span style={pillStyle(HEALTH_COLOR[health])}>{healthLabel}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          {tiles.map(([cap, val], i) => (
            <div key={i}>
              <div style={tileCapStyle}>{cap}</div>
              <div style={tileValStyle}>{val}</div>
            </div>
          ))}
        </div>

        {d.PredictFailure === true && (
          <div style={{ color: 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>{t('diskhealth.predicted')}</div>
        )}

        {!hasSmartData(d) && (
          <div style={{ color: 'var(--native)', fontSize: 12.5 }}>
            {elevated ? t('diskhealth.errCtrl') : t('diskhealth.errAdmin')}
          </div>
        )}

        {tableRows.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>
              {tableHeader}
            </summary>
            <div style={{ marginTop: 8 }}>
              <DataTable columns={attrCols} rows={tableRows} rowKey={(r, i) => `${d.Index}-${r.id}-${i}`} />
            </div>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t('diskhealth.autoRefresh')}
        </label>
        <span className="count-note">{t('diskhealth.drives', { n: disks.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('diskhealth.blurb')}
      </p>
      {disks.length > 0 && anyBlocked && !elevated && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('diskhealth.limited')}
        </p>
      )}
      <AsyncState loading={loading} error={error}>
        {disks.length === 0 ? (
          <p className="count-note">
            {t('diskhealth.noDrivesTitle')} — {t('diskhealth.noDrivesMsg')}
          </p>
        ) : (
          <div>{disks.map(renderCard)}</div>
        )}
      </AsyncState>
    </div>
  );
}
