import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Imaging & game tools · 燒錄與遊戲工具 — module.imaging
//
// Full-feature native web port of WinForge's Pages/ImagingGameModule +
// Services/ImagingService / RufusService / MinecraftService. Three tabs:
//
//   • Raspberry Pi Imager — pick an OS image (.img/.iso/.bin/.raw/.wic), pick a
//     removable SD card (system/boot disks are never offered), size-guarded raw
//     disk write behind a type-the-disk-number confirm, then pre-seed the FAT
//     boot partition (ssh / Wi-Fi wpa_supplicant / first user).
//   • USB imager (Rufus) — Rufus engine detect + winget install, pick ISO/IMG,
//     pick a removable USB drive, DD-mode raw write with optional read-back
//     verify (SHA-256), and 'Launch Rufus' for advanced bootable-media builds.
//   • Minecraft world downloader — engine probe (repo + JDK + built jar +
//     Maven), locate repo, build jar (mvn package), install JDK (winget), run
//     the headless proxy (server / local port / world output / extended render /
//     auto-open containers) with Start/Stop and a live output log.
//
// Every mutation (raw write, verify, seed, build, install, start, launch) is an
// explicit button click. Destructive raw writes require typing the exact disk
// number to confirm, refuse system/boot disks, and refuse when the image is
// larger than the target. Passwords are masked and never logged.
// ============================================================================

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

// ── Rufus engine probe ──
interface RufusProbe {
  Installed: boolean;
  Path: string | null;
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

// Single-quote a string for embedding inside a PowerShell single-quoted literal.
function psq(s: string): string {
  return s.replace(/'/g, "''");
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

// Is Rufus installed? (winget id Akeo.Rufus, or a rufus*.exe on PATH / common spots)
const RUFUS_SCRIPT = `
$p = (Get-Command rufus -ErrorAction SilentlyContinue).Source
if (-not $p) {
  $cand = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links\\rufus.exe'),
    (Join-Path $env:ProgramFiles 'Rufus\\rufus.exe')
  )
  foreach ($c in $cand) { if (Test-Path $c) { $p = $c; break } }
}
if (-not $p) {
  try {
    $wg = winget list --id Akeo.Rufus -e 2>$null | Out-String
    if ($wg -match 'Akeo\\.Rufus') { $p = 'winget:Akeo.Rufus' }
  } catch {}
}
[pscustomobject]@{ Installed = [bool]$p; Path = $p }`;

type Tab = 'pi' | 'usb' | 'mc';

export function ImagingGameModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('pi');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imaging.blurb')}
      </p>

      <ModuleToolbar>
        <button className={`mini ${tab === 'pi' ? 'primary' : ''}`} onClick={() => setTab('pi')}>
          {t('imaging.tabPi')}
        </button>
        <button className={`mini ${tab === 'usb' ? 'primary' : ''}`} onClick={() => setTab('usb')}>
          {t('imaging.tabUsb')}
        </button>
        <button className={`mini ${tab === 'mc' ? 'primary' : ''}`} onClick={() => setTab('mc')}>
          {t('imaging.tabMc')}
        </button>
      </ModuleToolbar>

      {tab === 'pi' && <PiImagerPanel />}
      {tab === 'usb' && <UsbImagerPanel />}
      {tab === 'mc' && <McEnginePanel />}
    </div>
  );
}

// ════════════ shared: physical-disk picker ════════════
function useDisks() {
  return useAsync(async () => {
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
}

function diskColumns(t: (k: string, o?: Record<string, unknown>) => string): Column<Disk>[] {
  return [
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
}

// ── DD-mode raw write of a file to \\.\PhysicalDriveN, with progress-less
//    but streamed FileStream copy. Dismounts + offlines the disk first, clears
//    it, then copies bytes 1:1. Requires an elevated backend. ──
function writeImageScript(diskNumber: number, imagePath: string): string {
  return `
$ErrorActionPreference='Stop'
$n = ${diskNumber}
$img = '${psq(imagePath)}'
if (-not (Test-Path $img)) { throw 'Image not found.' }
$disk = Get-Disk -Number $n
if ($disk.IsSystem -or $disk.IsBoot) { throw 'Refused: system/boot disk.' }
# Dismount every volume on the disk, then clear + offline for exclusive access.
Get-Partition -DiskNumber $n -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.DriveLetter) { try { Remove-PartitionAccessPath -DiskNumber $n -PartitionNumber $_.PartitionNumber -AccessPath ("$($_.DriveLetter):\\") -ErrorAction SilentlyContinue } catch {} }
}
try { Clear-Disk -Number $n -RemoveData -RemoveOEM -Confirm:\$false -ErrorAction SilentlyContinue } catch {}
$path = "\\\\.\\PhysicalDrive$n"
$src = [System.IO.File]::OpenRead($img)
$dst = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
  $buf = New-Object byte[] (4MB)
  while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) { $dst.Write($buf, 0, $read) }
  $dst.Flush()
} finally { $src.Close(); $dst.Close() }
'ok'`;
}

// ── Read-back verify: hash the image, hash the same number of bytes from the
//    raw device, compare. ──
function verifyImageScript(diskNumber: number, imagePath: string): string {
  return `
$ErrorActionPreference='Stop'
$n = ${diskNumber}
$img = '${psq(imagePath)}'
$len = (Get-Item $img).Length
$imgHash = (Get-FileHash -Path $img -Algorithm SHA256).Hash
$path = "\\\\.\\PhysicalDrive$n"
$dev = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $buf = New-Object byte[] (4MB)
  $remaining = $len
  while ($remaining -gt 0) {
    $want = [Math]::Min([int64]$buf.Length, $remaining)
    $read = $dev.Read($buf, 0, [int]$want)
    if ($read -le 0) { break }
    $sha.TransformBlock($buf, 0, $read, $null, 0) | Out-Null
    $remaining -= $read
  }
  $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0) | Out-Null
  $devHash = ($sha.Hash | ForEach-Object { $_.ToString('X2') }) -join ''
} finally { $dev.Close(); $sha.Dispose() }
if ($devHash -eq $imgHash) { 'match' } else { throw "Mismatch: image $imgHash vs device $devHash" }`;
}

// ════════════ Raspberry Pi Imager tab ════════════
function PiImagerPanel() {
  const { t } = useTranslation();
  const disks = useDisks();
  const [showAll, setShowAll] = useState(false);
  const [imagePath, setImagePath] = useState('');
  const [imageSize, setImageSize] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmNum, setConfirmNum] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shownDisks = useMemo(() => {
    const all = disks.data ?? [];
    return showAll ? all : all.filter((d) => d.removable && !d.isSystem && !d.isBoot);
  }, [disks.data, showAll]);

  const target = useMemo(() => shownDisks.find((d) => d.number === selected) ?? null, [shownDisks, selected]);

  const pickImage = async () => {
    setMsg(null);
    const p = window.prompt(t('imaging.imagePathPrompt'), imagePath) ?? '';
    if (!p.trim()) return;
    setImagePath(p.trim());
    try {
      const rows = await runPowershellJson<{ Size: number }>(
        `$f='${psq(p.trim())}'; if (Test-Path $f) { [pscustomobject]@{ Size=[int64](Get-Item $f).Length } } else { [pscustomobject]@{ Size=-1 } }`,
      );
      const sz = rows[0]?.Size ?? -1;
      setImageSize(sz >= 0 ? sz : null);
      if (sz < 0) setMsg({ ok: false, text: t('imaging.imageMissing') });
    } catch {
      setImageSize(null);
    }
  };

  const write = async () => {
    setMsg(null);
    if (!imagePath.trim() || imageSize == null) {
      setMsg({ ok: false, text: t('imaging.pickImageFirst') });
      return;
    }
    if (!target) {
      setMsg({ ok: false, text: t('imaging.pickDiskFirst') });
      return;
    }
    if (target.isSystem || target.isBoot) {
      setMsg({ ok: false, text: t('imaging.refusedSystem') });
      return;
    }
    if (imageSize > target.size) {
      setMsg({ ok: false, text: t('imaging.imageTooBig', { img: humanSize(imageSize), disk: humanSize(target.size) }) });
      return;
    }
    if (confirmNum.trim() !== String(target.number)) {
      setMsg({ ok: false, text: t('imaging.typeNumber', { num: target.number }) });
      return;
    }
    if (
      !window.confirm(
        t('imaging.confirmWrite', {
          num: target.number,
          model: target.model,
          size: humanSize(target.size),
          letters: target.letters.length ? target.letters.join(', ') : '—',
        }),
      )
    )
      return;
    setBusy(true);
    setProgress(t('imaging.writing'));
    try {
      const res = await runPowershell(writeImageScript(target.number, imagePath.trim()));
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('imaging.writeDone') });
      setProgress(t('imaging.writeDoneHint'));
      setConfirmNum('');
      disks.reload();
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.writeFail')}: ${String(e)}` });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="count-note danger" style={{ marginTop: 0 }}>
        {t('imaging.piDanger')}
      </p>

      {/* Step 1 — image */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720, marginBottom: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.piStep1')}
        </span>
        <ModuleToolbar>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 320 }}
            value={imagePath}
            placeholder={t('imaging.imagePathPrompt')}
            onChange={(e) => {
              setImagePath(e.target.value);
              setImageSize(null);
            }}
          />
          <button className="mini" onClick={pickImage}>
            {t('imaging.chooseImage')}
          </button>
        </ModuleToolbar>
        {imageSize != null && (
          <span className="count-note">
            {t('imaging.size')}: {humanSize(imageSize)}
          </span>
        )}
      </div>

      {/* Step 2 — target disk */}
      <span className="count-note" style={{ fontWeight: 600 }}>
        {t('imaging.piStep2')}
      </span>
      <ModuleToolbar>
        <button className="mini" onClick={disks.reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {t('imaging.showAll')}
        </label>
        <span className="count-note">{t('imaging.diskCount', { num: shownDisks.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={disks.loading} error={disks.error}>
        <DataTable
          columns={[
            ...diskColumns(t),
            {
              key: 'pick',
              header: '',
              width: 90,
              render: (d) =>
                d.isSystem || d.isBoot ? (
                  <span className="count-note">—</span>
                ) : (
                  <button
                    className={`mini ${selected === d.number ? 'primary' : ''}`}
                    onClick={() => setSelected(d.number)}
                  >
                    {selected === d.number ? t('imaging.selected') : t('imaging.select')}
                  </button>
                ),
            },
          ]}
          rows={shownDisks}
          rowKey={(d) => String(d.number)}
          empty={t('imaging.noDisks')}
        />
      </AsyncState>

      {/* Step 3 — write (type-the-number confirm) */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720, marginTop: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.piStep3')}
        </span>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">
            {target ? t('imaging.typeNumberFor', { num: target.number }) : t('imaging.typeNumberNone')}
          </span>
          <input
            className="mod-search"
            style={{ width: 160 }}
            value={confirmNum}
            disabled={!target}
            placeholder={target ? String(target.number) : ''}
            onChange={(e) => setConfirmNum(e.target.value)}
          />
        </label>
        <button
          className="mini primary"
          disabled={busy || !target || !imagePath.trim() || confirmNum.trim() !== String(target?.number ?? '')}
          onClick={write}
        >
          {busy ? t('imaging.writing') : t('imaging.writeImage')}
        </button>
        {progress && <p className="count-note">{progress}</p>}
        {!isTauri() && <p className="count-note">{t('imaging.nativeNote')}</p>}
      </div>

      {msg && <p className={`mod-msg ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}

      {/* Step 4 — boot pre-seed */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border, #333)', paddingTop: 12 }}>
        <BootSeedPanel />
      </div>
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
    if (!window.confirm(t('imaging.confirmSeed', { drive }))) return;
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
      <span className="count-note" style={{ fontWeight: 600 }}>
        {t('imaging.piStep4')}
      </span>
      <p className="count-note" style={{ marginTop: 4 }}>
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

// ════════════ USB imager (Rufus) tab ════════════
function UsbImagerPanel() {
  const { t } = useTranslation();
  const disks = useDisks();
  const rufus = useAsync(async () => {
    const rows = await runPowershellJson<RufusProbe>(RUFUS_SCRIPT);
    return rows[0] ?? { Installed: false, Path: null };
  }, []);
  const [showAll, setShowAll] = useState(false);
  const [imagePath, setImagePath] = useState('');
  const [imageSize, setImageSize] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmNum, setConfirmNum] = useState('');
  const [verify, setVerify] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);

  // Rufus DD is for removable USB only; keep the same safety filter as the Pi tab.
  const shownDisks = useMemo(() => {
    const all = disks.data ?? [];
    const base = showAll ? all : all.filter((d) => d.removable && !d.isSystem && !d.isBoot);
    return base;
  }, [disks.data, showAll]);

  const target = useMemo(() => shownDisks.find((d) => d.number === selected) ?? null, [shownDisks, selected]);

  const pickImage = async () => {
    setMsg(null);
    const p = window.prompt(t('imaging.usbImagePathPrompt'), imagePath) ?? '';
    if (!p.trim()) return;
    setImagePath(p.trim());
    try {
      const rows = await runPowershellJson<{ Size: number }>(
        `$f='${psq(p.trim())}'; if (Test-Path $f) { [pscustomobject]@{ Size=[int64](Get-Item $f).Length } } else { [pscustomobject]@{ Size=-1 } }`,
      );
      const sz = rows[0]?.Size ?? -1;
      setImageSize(sz >= 0 ? sz : null);
      if (sz < 0) setMsg({ ok: false, text: t('imaging.imageMissing') });
    } catch {
      setImageSize(null);
    }
  };

  const installRufus = async () => {
    setInstalling(true);
    setMsg(null);
    try {
      const res = await runCommand('winget', ['install', '-e', '--id', 'Akeo.Rufus', '--accept-package-agreements', '--accept-source-agreements']);
      if (!res.success && res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('imaging.rufusInstalled') });
      rufus.reload();
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.rufusInstallFail')}: ${String(e)}` });
    } finally {
      setInstalling(false);
    }
  };

  const launchRufus = async () => {
    setMsg(null);
    try {
      const path = rufus.data?.Path;
      if (path && !path.startsWith('winget:')) {
        const res = await runCommand(path, []);
        if (!res.success && res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      } else {
        // Installed via winget shim — launch by name.
        const res = await runPowershell(`Start-Process rufus`);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      setMsg({ ok: true, text: t('imaging.rufusLaunched') });
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.rufusLaunchFail')}: ${String(e)}` });
    }
  };

  const write = async () => {
    setMsg(null);
    if (!imagePath.trim() || imageSize == null) {
      setMsg({ ok: false, text: t('imaging.pickImageFirst') });
      return;
    }
    if (!target) {
      setMsg({ ok: false, text: t('imaging.pickUsbFirst') });
      return;
    }
    if (target.isSystem || target.isBoot) {
      setMsg({ ok: false, text: t('imaging.refusedSystem') });
      return;
    }
    if (imageSize > target.size) {
      setMsg({ ok: false, text: t('imaging.imageTooBig', { img: humanSize(imageSize), disk: humanSize(target.size) }) });
      return;
    }
    if (confirmNum.trim() !== String(target.number)) {
      setMsg({ ok: false, text: t('imaging.typeNumber', { num: target.number }) });
      return;
    }
    if (
      !window.confirm(
        t('imaging.confirmWrite', {
          num: target.number,
          model: target.model,
          size: humanSize(target.size),
          letters: target.letters.length ? target.letters.join(', ') : '—',
        }),
      )
    )
      return;
    setBusy(true);
    setProgress(t('imaging.writing'));
    try {
      const wr = await runPowershell(writeImageScript(target.number, imagePath.trim()));
      if (!wr.success) throw new Error(wr.stderr.trim() || `exit ${wr.code}`);
      if (verify) {
        setProgress(t('imaging.verifying'));
        const vr = await runPowershell(verifyImageScript(target.number, imagePath.trim()));
        if (!vr.success) throw new Error(vr.stderr.trim() || `exit ${vr.code}`);
        setMsg({ ok: true, text: t('imaging.writeVerifyDone') });
        setProgress(t('imaging.verifyDoneHint'));
      } else {
        setMsg({ ok: true, text: t('imaging.writeDone') });
        setProgress(t('imaging.writeNoVerifyHint'));
      }
      setConfirmNum('');
      disks.reload();
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.writeFail')}: ${String(e)}` });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="count-note danger" style={{ marginTop: 0 }}>
        {t('imaging.usbDanger')}
      </p>

      {/* Engine bar */}
      <AsyncState loading={rufus.loading} error={rufus.error}>
        <div className="hosts-edit" style={{ display: 'grid', gap: 6, maxWidth: 720, marginBottom: 12 }}>
          <StatusDot ok={!!rufus.data?.Installed} label={rufus.data?.Installed ? t('imaging.rufusInstalledOk') : t('imaging.rufusMissing')} />
          <p className="count-note" style={{ marginTop: 0 }}>
            {rufus.data?.Installed ? t('imaging.rufusOkNote') : t('imaging.rufusMissingNote')}
          </p>
          {!rufus.data?.Installed && (
            <button className="mini" disabled={installing} onClick={installRufus}>
              {installing ? t('imaging.installing') : t('imaging.installRufus')}
            </button>
          )}
        </div>
      </AsyncState>

      {/* Step 1 — image */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720, marginBottom: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.usbStep1')}
        </span>
        <ModuleToolbar>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 320 }}
            value={imagePath}
            placeholder={t('imaging.usbImagePathPrompt')}
            onChange={(e) => {
              setImagePath(e.target.value);
              setImageSize(null);
            }}
          />
          <button className="mini" onClick={pickImage}>
            {t('imaging.chooseImage')}
          </button>
        </ModuleToolbar>
        {imageSize != null && (
          <span className="count-note">
            {t('imaging.size')}: {humanSize(imageSize)}
          </span>
        )}
      </div>

      {/* Step 2 — target USB */}
      <span className="count-note" style={{ fontWeight: 600 }}>
        {t('imaging.usbStep2')}
      </span>
      <ModuleToolbar>
        <button className="mini" onClick={disks.reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {t('imaging.showAllRisky')}
        </label>
        <span className="count-note">{t('imaging.diskCount', { num: shownDisks.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={disks.loading} error={disks.error}>
        <DataTable
          columns={[
            ...diskColumns(t),
            {
              key: 'pick',
              header: '',
              width: 90,
              render: (d) =>
                d.isSystem || d.isBoot ? (
                  <span className="count-note">—</span>
                ) : (
                  <button
                    className={`mini ${selected === d.number ? 'primary' : ''}`}
                    onClick={() => setSelected(d.number)}
                  >
                    {selected === d.number ? t('imaging.selected') : t('imaging.select')}
                  </button>
                ),
            },
          ]}
          rows={shownDisks}
          rowKey={(d) => String(d.number)}
          empty={t('imaging.noUsb')}
        />
      </AsyncState>

      {/* Step 3 — write + verify */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720, marginTop: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.usbStep3')}
        </span>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          {t('imaging.verifyAfter')}
        </label>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('imaging.ddModeHint')}
        </p>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">
            {target ? t('imaging.typeNumberFor', { num: target.number }) : t('imaging.typeNumberNone')}
          </span>
          <input
            className="mod-search"
            style={{ width: 160 }}
            value={confirmNum}
            disabled={!target}
            placeholder={target ? String(target.number) : ''}
            onChange={(e) => setConfirmNum(e.target.value)}
          />
        </label>
        <button
          className="mini primary"
          disabled={busy || !target || !imagePath.trim() || confirmNum.trim() !== String(target?.number ?? '')}
          onClick={write}
        >
          {busy ? t('imaging.writing') : t('imaging.writeImage')}
        </button>
        {progress && <p className="count-note">{progress}</p>}
        {!isTauri() && <p className="count-note">{t('imaging.nativeNote')}</p>}
      </div>

      {msg && <p className={`mod-msg ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}

      {/* Advanced — Rufus launch */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border, #333)', paddingTop: 12 }}>
        <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
          <span className="count-note" style={{ fontWeight: 600 }}>
            {t('imaging.usbAdvanced')}
          </span>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('imaging.usbAdvancedBlurb')}
          </p>
          <div>
            <button className="mini" disabled={!rufus.data?.Installed} onClick={launchRufus}>
              {t('imaging.launchRufus')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════ Minecraft world-downloader engine + runner ════════════
function McEnginePanel() {
  const { t } = useTranslation();
  const eng = useAsync(async () => {
    const rows = await runPowershellJson<Engine>(ENGINE_SCRIPT);
    return rows[0] ?? null;
  }, []);

  const [repo, setRepo] = useState<string | null>(null);
  const [jar, setJar] = useState<string | null>(null);
  const [server, setServer] = useState('');
  const [port, setPort] = useState(25565);
  const [outDir, setOutDir] = useState('');
  const [render, setRender] = useState(0);
  const [autoOpen, setAutoOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync probe results into local editable state.
  useEffect(() => {
    if (!eng.data) return;
    setRepo(eng.data.Repo);
    setJar(eng.data.Jar);
    if (!outDir && eng.data.Jar) {
      const dir = eng.data.Jar.replace(/[\\/][^\\/]+$/, '');
      setOutDir(`${dir}\\world`);
    }
  }, [eng.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Log file the detached proxy writes to (kept next to the jar's folder).
  const logFile = useMemo(() => {
    if (!jar) return null;
    const dir = jar.replace(/[\\/][^\\/]+$/, '');
    return `${dir}\\wf-mcwd.log`;
  }, [jar]);

  const appendLog = (line: string) => setLog((l) => (l.length > 60000 ? l.slice(-40000) : l) + (l ? '\n' : '') + line);

  const locateRepo = async () => {
    setMsg(null);
    const p = window.prompt(t('imaging.locateRepoPrompt'), repo ?? '') ?? '';
    if (!p.trim()) return;
    try {
      const rows = await runPowershellJson<{ Ok: boolean; Jar: string | null }>(`
$c='${psq(p.trim())}'
$ok=[bool](Test-Path (Join-Path $c 'pom.xml'))
$jar=$null
if ($ok) {
  $j = Get-ChildItem -Path (Join-Path $c 'target') -Filter '*.jar' -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -notlike '*sources*' -and $_.Name -notlike '*original*' } | Select-Object -First 1
  if ($j) { $jar = $j.FullName }
}
[pscustomobject]@{ Ok=$ok; Jar=$jar }`);
      if (!rows[0]?.Ok) {
        setMsg({ ok: false, text: t('imaging.notRepo') });
        return;
      }
      setRepo(p.trim());
      setJar(rows[0].Jar ?? null);
      setMsg({ ok: true, text: t('imaging.repoSet', { path: p.trim() }) });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    }
  };

  const buildJar = async () => {
    if (!repo) return;
    setBusy(true);
    setMsg(null);
    appendLog(t('imaging.buildingJar'));
    try {
      const res = await runPowershell(`
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Set-Location '${psq(repo)}'
$mvn = (Get-Command mvn -ErrorAction SilentlyContinue).Source
if (-not $mvn) {
  if (Test-Path (Join-Path '${psq(repo)}' 'mvnw.cmd')) { $mvn = (Join-Path '${psq(repo)}' 'mvnw.cmd') }
  else { throw 'Maven not found. Install Maven or use the repo mvnw wrapper.' }
}
& $mvn -q -DskipTests package 2>&1 | Out-String`);
      if (res.stdout.trim()) appendLog(res.stdout.trim());
      // Re-probe the built jar.
      const rows = await runPowershellJson<{ Jar: string | null }>(`
$j = Get-ChildItem -Path (Join-Path '${psq(repo)}' 'target') -Filter '*.jar' -ErrorAction SilentlyContinue |
     Where-Object { $_.Name -notlike '*sources*' -and $_.Name -notlike '*original*' } | Select-Object -First 1
[pscustomobject]@{ Jar = $(if ($j) { $j.FullName } else { $null }) }`);
      const built = rows[0]?.Jar ?? null;
      if (built) {
        setJar(built);
        setMsg({ ok: true, text: t('imaging.buildOk', { jar: built }) });
      } else {
        setMsg({ ok: false, text: t('imaging.buildFail') });
      }
    } catch (e) {
      appendLog(String(e));
      setMsg({ ok: false, text: t('imaging.buildFail') });
    } finally {
      setBusy(false);
    }
  };

  const installJdk = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await runCommand('winget', ['install', '-e', '--id', 'EclipseAdoptium.Temurin.21.JDK', '--accept-package-agreements', '--accept-source-agreements']);
      if (!res.success && res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg({ ok: true, text: t('imaging.jdkInstalled') });
      eng.reload();
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.jdkInstallFail')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const openOut = async () => {
    if (!outDir.trim()) return;
    await runPowershell(`$d='${psq(outDir.trim())}'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Start-Process explorer.exe $d`);
  };

  const pickOut = () => {
    const p = window.prompt(t('imaging.outDirPrompt'), outDir) ?? '';
    if (p.trim()) setOutDir(p.trim());
  };

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPoll(), []);

  const start = async () => {
    if (!jar) {
      setMsg({ ok: false, text: t('imaging.buildFirst') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const java = eng.data?.Java || 'java';
      const args = [
        '-jar',
        `'${psq(jar)}'`,
        '--server',
        `'${psq(server.trim())}'`,
        '--port',
        String(port),
        '--output',
        `'${psq(outDir.trim())}'`,
      ];
      if (render > 0) args.push('--render-distance', String(render));
      if (autoOpen) args.push('--enable-world-gen');
      const argList = args.join(',');
      const res = await runPowershell(`
$ErrorActionPreference='Stop'
$lf='${psq(logFile ?? '')}'
if ($lf) { '' | Set-Content -Path $lf }
$p = Start-Process -FilePath '${psq(java)}' -ArgumentList @(${argList}) -WorkingDirectory '${psq(jar.replace(/[\\/][^\\/]+$/, ''))}' -RedirectStandardOutput $lf -RedirectStandardError (($lf) + '.err') -PassThru -WindowStyle Hidden
$p.Id`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setRunning(true);
      setMsg({ ok: true, text: t('imaging.started', { port }) });
      appendLog(t('imaging.startedLog', { port }));
      // Poll the log file for live output.
      stopPoll();
      pollRef.current = setInterval(async () => {
        if (!logFile) return;
        try {
          const r = await runPowershell(`
$lf='${psq(logFile)}'
if (Test-Path $lf) { Get-Content $lf -Tail 200 -ErrorAction SilentlyContinue | Out-String } else { '' }
$run = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*minecraft*' -or $_.CommandLine -like '*world*downloader*' }
if (-not $run) { '::STOPPED::' }`);
          const text = r.stdout;
          if (text.includes('::STOPPED::')) {
            setRunning(false);
            stopPoll();
            appendLog(t('imaging.downloaderStopped'));
          }
          const body = text.replace('::STOPPED::', '').trim();
          if (body) setLog(body);
        } catch {
          /* transient */
        }
      }, 1500);
    } catch (e) {
      setMsg({ ok: false, text: `${t('imaging.startFail')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!window.confirm(t('imaging.confirmStop'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`
Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*world*downloader*' -or $_.CommandLine -like '*minecraft-world*' -or $_.CommandLine -like '*--server*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setRunning(false);
      stopPoll();
      appendLog(t('imaging.downloaderStopped'));
      setMsg({ ok: true, text: t('imaging.stopped') });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const java = eng.data?.Java ?? null;

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imaging.mcBlurb')}
      </p>

      {/* Engine */}
      <span className="count-note" style={{ fontWeight: 600 }}>
        {t('imaging.mcEngine')}
      </span>
      <ModuleToolbar>
        <button className="mini" onClick={eng.reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" disabled={busy} onClick={locateRepo}>
          {t('imaging.locateRepo')}
        </button>
        <button className="mini" disabled={busy || !repo} onClick={buildJar}>
          {t('imaging.buildJar')}
        </button>
        <button className="mini" disabled={busy || !!java} onClick={installJdk}>
          {t('imaging.installJdk')}
        </button>
      </ModuleToolbar>
      <AsyncState loading={eng.loading} error={eng.error}>
        {eng.data ? (
          <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
            <StatusDot
              ok={!!java}
              label={java ? `Java: ${eng.data.JavaVersion || java}` : t('imaging.javaMissing')}
            />
            <StatusDot ok={!!eng.data.Maven} label={eng.data.Maven ? t('imaging.mavenOk') : t('imaging.mavenMissing')} />
            <StatusDot ok={!!repo} label={repo ? `${t('imaging.repo')}: ${repo}` : t('imaging.repoMissing')} />
            <StatusDot ok={!!jar} label={jar ? `${t('imaging.jar')}: ${jar}` : t('imaging.jarMissing')} />
          </div>
        ) : (
          <p className="count-note">{t('imaging.mcNone')}</p>
        )}
      </AsyncState>

      {/* Run */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 10, maxWidth: 720, marginTop: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.mcRun')}
        </span>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">{t('imaging.mcServer')}</span>
          <input
            className="mod-search"
            value={server}
            placeholder="mc.example.com"
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">{t('imaging.mcPort')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={65535}
            style={{ width: 160 }}
            value={port}
            onChange={(e) => setPort(Math.max(1, Math.min(65535, Number(e.target.value) || 25565)))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">{t('imaging.mcOut')}</span>
          <ModuleToolbar>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 300 }}
              value={outDir}
              onChange={(e) => setOutDir(e.target.value)}
            />
            <button className="mini" onClick={pickOut}>
              {t('imaging.choose')}
            </button>
            <button className="mini" onClick={openOut}>
              {t('imaging.openFolder')}
            </button>
          </ModuleToolbar>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="count-note">{t('imaging.mcRender')}</span>
          <input
            className="mod-search"
            type="number"
            min={0}
            max={48}
            style={{ width: 160 }}
            value={render}
            onChange={(e) => setRender(Math.max(0, Math.min(48, Number(e.target.value) || 0)))}
          />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          {t('imaging.mcAutoOpen')}
        </label>
        <ModuleToolbar>
          <button className="mini primary" disabled={busy || running || !jar || !java} onClick={start}>
            {t('imaging.start')}
          </button>
          <button className="mini" disabled={busy || !running} onClick={stop}>
            {t('imaging.stop')}
          </button>
          {running && <StatusDot ok={true} label={t('imaging.mcLive', { port })} />}
        </ModuleToolbar>
        {!isTauri() && <p className="count-note">{t('imaging.nativeNote')}</p>}
      </div>

      {/* Live log */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 6, marginTop: 12 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('imaging.mcLog')}
        </span>
        <textarea
          className="mod-search"
          readOnly
          value={log}
          style={{ height: 220, fontFamily: 'Consolas, monospace', whiteSpace: 'pre', overflow: 'auto' }}
        />
      </div>

      {msg && <p className={`mod-msg ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}
    </div>
  );
}
