import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Live physical-disk model (mirrors WinForge ImagingService.PhysicalDisk) ──
interface RawDisk {
  Number: number;
  Model: string | null;
  Size: number;
  BusType: string | null;
  Removable: boolean;
  IsBoot: boolean;
  IsSystem: boolean;
  Letters: string[] | string | null;
  HasSysDrive: boolean;
}

interface Disk {
  number: number;
  model: string;
  size: number;
  busType: string;
  removable: boolean;
  isBoot: boolean;
  isSystem: boolean;
  letters: string[];
}

// ── Boot / FAT volume model (Pi pre-seed target) ──
interface RawVolume {
  Letter: string | null;
  Label: string | null;
  FileSystem: string | null;
  DriveType: string | null;
  SizeGB: number;
}

// ── Minecraft engine probe ──
interface Engine {
  Java: string | null;
  JavaVersion: string | null;
  Maven: boolean;
  Repo: string | null;
  Jar: string | null;
}

function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < u.length - 1) {
    s /= 1024;
    i++;
  }
  return `${Math.round(s * 10) / 10} ${u[i]}`;
}

function normLetters(v: string[] | string | null): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter((x) => !!x) : [v];
}

// Enumerate physical disks + their drive letters + boot/system flags (read-only CIM).
const DISK_SCRIPT = `
$sys = (Get-CimInstance Win32_OperatingSystem).SystemDrive
Get-Disk | ForEach-Object {
  $d = $_
  $letters = @()
  try { $letters = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue |
        Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter):" } } catch {}
  [pscustomobject]@{
    Number     = [int]$d.Number
    Model      = [string]$d.FriendlyName
    Size       = [int64]$d.Size
    BusType    = [string]$d.BusType
    Removable  = [bool]($d.BusType -eq 'USB' -or $d.BusType -eq 'SD' -or $d.BusType -eq 'MMC')
    IsBoot     = [bool]$d.IsBoot
    IsSystem   = [bool]$d.IsSystem
    Letters    = @($letters)
    HasSysDrive= [bool]($letters -contains $sys)
  }
}`;

// Removable / FAT volumes that can host a freshly-flashed Pi boot partition.
const VOLUME_SCRIPT = `
Get-Volume | Where-Object { $_.DriveLetter -and ($_.DriveType -eq 'Removable' -or $_.FileSystem -like 'FAT*') } |
  ForEach-Object {
    [pscustomobject]@{
      Letter     = "$($_.DriveLetter):"
      Label      = [string]$_.FileSystemLabel
      FileSystem = [string]$_.FileSystem
      DriveType  = [string]$_.DriveType
      SizeGB     = [math]::Round(($_.Size/1GB),1)
    }
  }`;

// Detect the Minecraft-world-downloader engine: Java, Maven, repo + built jar.
const ENGINE_SCRIPT = `
$java = (Get-Command java -ErrorAction SilentlyContinue).Source
$ver = $null
if ($java) { try { $ver = (& java -version 2>&1 | Select-Object -First 1).ToString() } catch {} }
$mvn = [bool](Get-Command mvn -ErrorAction SilentlyContinue)
$repo = $null; $jar = $null
$cand = @(
  (Join-Path $env:USERPROFILE 'Documents\\GitHub\\minecraft-world-downloader'),
  (Join-Path $env:USERPROFILE 'source\\repos\\minecraft-world-downloader'),
  (Join-Path $env:USERPROFILE 'minecraft-world-downloader')
)
foreach ($c in $cand) { if (Test-Path (Join-Path $c 'pom.xml')) { $repo = $c; break } }
if ($repo) {
  $j = Get-ChildItem -Path (Join-Path $repo 'target') -Filter '*.jar' -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -notlike '*sources*' -and $_.Name -notlike '*original*' } |
       Select-Object -First 1
  if ($j) { $jar = $j.FullName }
}
[pscustomobject]@{
  Java = $java; JavaVersion = $ver; Maven = $mvn; Repo = $repo; Jar = $jar
}`;

type Tab = 'disks' | 'boot' | 'mc';

export function ImagingGameModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('disks');
  const [showAll, setShowAll] = useState(false);

  const disksAsync = useAsync(async () => {
    const raw = await runPowershellJson<RawDisk>(DISK_SCRIPT);
    return raw
      .map<Disk>((d) => ({
        number: d.Number,
        model: d.Model || '—',
        size: d.Size,
        busType: d.BusType || '—',
        removable: !!d.Removable,
        isBoot: !!d.IsBoot,
        isSystem: !!d.IsSystem || !!d.HasSysDrive,
        letters: normLetters(d.Letters),
      }))
      .sort((a, b) => a.number - b.number);
  }, []);

  const shownDisks = useMemo(() => {
    const all = disksAsync.data ?? [];
    return showAll ? all : all.filter((d) => d.removable && !d.isSystem && !d.isBoot);
  }, [disksAsync.data, showAll]);

  const diskColumns: Column<Disk>[] = [
    { key: 'number', header: t('imaging.disk'), width: 60, render: (d) => `#${d.number}` },
    { key: 'model', header: t('imaging.model') },
    { key: 'size', header: t('imaging.size'), width: 100, align: 'right', render: (d) => humanSize(d.size) },
    { key: 'busType', header: t('imaging.bus'), width: 80 },
    {
      key: 'letters',
      header: t('imaging.volumes'),
      width: 120,
      render: (d) => (d.letters.length ? d.letters.join(' ') : '—'),
    },
    {
      key: 'safety',
      header: t('imaging.safety'),
      width: 150,
      render: (d) =>
        d.isSystem || d.isBoot ? (
          <StatusDot ok={false} label={t('imaging.systemDisk')} />
        ) : d.removable ? (
          <StatusDot ok={true} label={t('imaging.safeTarget')} />
        ) : (
          <span className="count-note">{t('imaging.fixed')}</span>
        ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imaging.blurb')}
      </p>

      <ModuleToolbar>
        <button className={`mini ${tab === 'disks' ? 'primary' : ''}`} onClick={() => setTab('disks')}>
          {t('imaging.tabDisks')}
        </button>
        <button className={`mini ${tab === 'boot' ? 'primary' : ''}`} onClick={() => setTab('boot')}>
          {t('imaging.tabBoot')}
        </button>
        <button className={`mini ${tab === 'mc' ? 'primary' : ''}`} onClick={() => setTab('mc')}>
          {t('imaging.tabMc')}
        </button>
      </ModuleToolbar>

      {tab === 'disks' && (
        <>
          <ModuleToolbar>
            <button className="mini" onClick={disksAsync.reload}>
              ⟳ {t('modules.refresh')}
            </button>
            <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {t('imaging.showAll')}
            </label>
            <span className="count-note">{t('imaging.diskCount', { num: shownDisks.length })}</span>
          </ModuleToolbar>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('imaging.danger')}
          </p>
          <AsyncState loading={disksAsync.loading} error={disksAsync.error}>
            <DataTable
              columns={diskColumns}
              rows={shownDisks}
              rowKey={(d) => String(d.number)}
              empty={t('imaging.noDisks')}
            />
          </AsyncState>
        </>
      )}

      {tab === 'boot' && <BootSeedPanel />}
      {tab === 'mc' && <McEnginePanel />}
    </div>
  );
}

// ════════════ Boot-partition pre-seed (safe targeted file writes) ════════════
function BootSeedPanel() {
  const { t } = useTranslation();
  const vols = useAsync(() => runPowershellJson<RawVolume>(VOLUME_SCRIPT), []);
  const [drive, setDrive] = useState('');
  const [ssh, setSsh] = useState(true);
  const [ssid, setSsid] = useState('');
  const [wifiPw, setWifiPw] = useState('');
  const [country, setCountry] = useState('GB');
  const [user, setUser] = useState('pi');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const list = (vols.data ?? []).filter((v) => v.Letter);
    if (!drive && list[0]?.Letter) setDrive(list[0].Letter);
    return list;
  }, [vols.data, drive]);

  const seed = async () => {
    if (!drive) {
      setMsg(t('imaging.pickBoot'));
      return;
    }
    if (!ssh && !ssid.trim()) {
      setMsg(t('imaging.nothingSeed'));
      return;
    }
    setBusy(true);
    setMsg(null);
    // Root path like E:\  — everything below is a plain user-file write, no raw disk access.
    const root = `${drive}\\`.replace(/\\\\$/, '\\');
    const parts: string[] = [`$root='${root.replace(/'/g, "''")}'`];
    parts.push(`if (-not (Test-Path $root)) { throw 'Boot partition not found. Re-insert the card.' }`);
    const written: string[] = [];
    if (ssh) {
      parts.push(`Set-Content -Path (Join-Path $root 'ssh') -Value '' -NoNewline`);
      written.push('ssh');
    }
    if (ssid.trim()) {
      const cc = (country.trim() || 'GB').toUpperCase().slice(0, 2);
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const conf =
        'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\n' +
        `country=${cc}\n` +
        'update_config=1\n\n' +
        'network={\n' +
        `\tssid="${esc(ssid.trim())}"\n` +
        (wifiPw ? `\tpsk="${esc(wifiPw)}"\n` : '\tkey_mgmt=NONE\n') +
        '}\n';
      const b64 = btoa(unescape(encodeURIComponent(conf)));
      parts.push(
        `[IO.File]::WriteAllText((Join-Path $root 'wpa_supplicant.conf'), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
      );
      written.push('wpa_supplicant.conf');
    }
    parts.push(`'${written.join(', ')}'`);
    try {
      const res = await runPowershell(parts.join('\n'));
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('imaging.seedOk', { files: written.join(', '), drive }));
      vols.reload();
    } catch (e) {
      setMsg(`${t('imaging.seedFail')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imaging.bootBlurb')}
      </p>
      <ModuleToolbar>
        <select className="mod-search" value={drive} onChange={(e) => setDrive(e.target.value)}>
          <option value="">{t('imaging.pickBoot')}</option>
          {options.map((v) => (
            <option key={v.Letter ?? ''} value={v.Letter ?? ''}>
              {v.Letter} {v.Label || ''} ({v.FileSystem || '?'}, {v.SizeGB} GB)
            </option>
          ))}
        </select>
        <button className="mini" onClick={vols.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      <AsyncState loading={vols.loading} error={vols.error}>
        <div className="hosts-edit" style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={ssh} onChange={(e) => setSsh(e.target.checked)} />
            {t('imaging.enableSsh')}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note">{t('imaging.wifiSsid')}</span>
            <input className="mod-search" value={ssid} onChange={(e) => setSsid(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note">{t('imaging.wifiPw')}</span>
            <input
              className="mod-search"
              type="password"
              value={wifiPw}
              onChange={(e) => setWifiPw(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note">{t('imaging.wifiCountry')}</span>
            <input
              className="mod-search"
              maxLength={2}
              style={{ width: 80 }}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note">{t('imaging.firstUser')}</span>
            <input className="mod-search" value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <button className="mini primary" disabled={busy || !drive} onClick={seed}>
            {busy ? t('imaging.writing') : t('imaging.writeBoot')}
          </button>
          <p className="count-note">{t('imaging.userNote')}</p>
        </div>
      </AsyncState>
      {msg && <p className="mod-msg">{msg}</p>}
    </div>
  );
}

// ════════════ Minecraft world-downloader engine probe (read-only) ════════════
function McEnginePanel() {
  const { t } = useTranslation();
  const eng = useAsync(async () => {
    const rows = await runPowershellJson<Engine>(ENGINE_SCRIPT);
    return rows[0] ?? null;
  }, []);

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imaging.mcBlurb')}
      </p>
      <ModuleToolbar>
        <button className="mini" onClick={eng.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>
      <AsyncState loading={eng.loading} error={eng.error}>
        {eng.data ? (
          <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 640 }}>
            <StatusDot
              ok={!!eng.data.Java}
              label={eng.data.Java ? `Java: ${eng.data.JavaVersion || eng.data.Java}` : t('imaging.javaMissing')}
            />
            <StatusDot ok={!!eng.data.Maven} label={eng.data.Maven ? t('imaging.mavenOk') : t('imaging.mavenMissing')} />
            <StatusDot
              ok={!!eng.data.Repo}
              label={eng.data.Repo ? `${t('imaging.repo')}: ${eng.data.Repo}` : t('imaging.repoMissing')}
            />
            <StatusDot
              ok={!!eng.data.Jar}
              label={eng.data.Jar ? `${t('imaging.jar')}: ${eng.data.Jar}` : t('imaging.jarMissing')}
            />
            <p className="count-note">{t('imaging.mcNote')}</p>
          </div>
        ) : (
          <p className="count-note">{t('imaging.mcNone')}</p>
        )}
      </AsyncState>
    </div>
  );
}
