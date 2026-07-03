import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Minecraft World Editor (Amulet) — module.amulet — native web port of
// WinForge's AmuletModule (Pages/AmuletModule.xaml.cs + Services/AmuletService.cs
// + Catalog/AmuletOperations.cs).
//
// WinForge is the launcher / setup harness around the Amulet Minecraft world
// editor (a GPLv3 Python/wxPython app it never links). Ported here against the
// Tauri PowerShell bridge, staying read-only and data-first:
//   • Environment probe — is a Java world's saves folder present, is Python 3
//     installed (py launcher / python.exe / common roots), and has WinForge's
//     managed Amulet app-data dir been extracted (frozen .exe or the
//     amulet_map_editor package). Rendered as coloured status dots.
//   • World scanner — enumerates %AppData%\.minecraft\saves (or a custom saves
//     path), and for every folder holding a level.dat it reads the gzipped
//     big-endian NBT natively in PowerShell to surface name / version /
//     DataVersion / edition / dimensions / size / last-played — the same
//     metadata AmuletService.ReadWorldMeta pulls — in a sortable table.
//   • Per-world actions — open the world folder in Explorer, back it up to a
//     timestamped .zip (Compress-Archive), and launch Amulet pointed at it
//     (frozen .exe or `python -m amulet_map_editor "<world>"`, detached).
//   • Setup / maintenance — open the saves folder, open the managed Amulet
//     app-data folder, and a live log tail fed by every action.
// Launch/backup are gated: launch only enables when Amulet is resolved, backup
// writes a NEW zip beside a chosen folder. No destructive ops.
// ============================================================================

// PowerShell single-quoted string literal — double any embedded quotes.
function ps(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

interface World {
  Folder: string;
  Name: string;
  Version: string;
  DataVersion: number;
  Edition: string;
  Dimensions: string;
  SizeBytes: number;
  SizeDisplay: string;
  LastPlayed: string; // display, "" when unknown
  LastPlayedTicks: number; // for sorting
}

interface Env {
  savesPath: string;
  savesFound: boolean;
  pythonPath: string;
  pythonFound: boolean;
  amuletMode: string; // 'frozen' | 'python' | ''
  amuletPath: string;
  amuletFound: boolean;
  appDir: string;
}

// ── PowerShell: environment probe (saves / python / amulet) ──────────────────
// Mirrors AmuletService.FindSavesFolder / FindPython / FindEntryPoint. Emits a
// single JSON object. All local-disk probes — no WMI, no network.
function envScript(customSaves: string): string {
  const savesOverride = customSaves.trim() ? ps(customSaves.trim()) : '$null';
  return `
$ErrorActionPreference='SilentlyContinue'
$appDir = Join-Path $env:LOCALAPPDATA 'WinForge\\Amulet'
$extractDir = Join-Path $appDir 'app'
$sourceDir = Join-Path $appDir 'source'

# saves folder
$saves = ${savesOverride}
if (-not $saves) { $saves = Join-Path $env:APPDATA '.minecraft\\saves' }
$savesFound = (Test-Path -LiteralPath $saves)

# python: py launcher, then python.exe (skip WindowsApps stub), then common roots
$py = ''
$c = (Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ($c) { $py = $c }
if (-not $py) {
  $pcs = @(Get-Command python.exe -ErrorAction SilentlyContinue) | Where-Object { $_.Source -notmatch 'WindowsApps' }
  if ($pcs.Count -gt 0) { $py = $pcs[0].Source }
}
if (-not $py) {
  foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs\\Python'), (Join-Path $env:ProgramFiles 'Python'), (Join-Path \${env:ProgramFiles(x86)} 'Python'))) {
    if (Test-Path -LiteralPath $root) {
      $subs = Get-ChildItem -Directory -LiteralPath $root -ErrorAction SilentlyContinue | Sort-Object Name -Descending
      foreach ($d in $subs) { $p = Join-Path $d.FullName 'python.exe'; if (Test-Path -LiteralPath $p) { $py = $p; break } }
    }
    if ($py) { break }
  }
}

# amulet entry point: frozen amulet*.exe, else amulet_map_editor package (with __main__.py)
$amMode = ''; $amPath = ''
foreach ($rootDir in @($sourceDir, $extractDir)) {
  if (-not (Test-Path -LiteralPath $rootDir)) { continue }
  $exe = Get-ChildItem -Recurse -File -Filter '*.exe' -LiteralPath $rootDir -ErrorAction SilentlyContinue |
    Where-Object { $n = $_.BaseName.ToLower(); ($n -like '*amulet*' -or $n -eq 'amulet_app') -and ($n -notlike '*unins*') } |
    Select-Object -First 1
  if ($exe) { $amMode = 'frozen'; $amPath = $exe.FullName; break }
  $pkg = Get-ChildItem -Recurse -Directory -Filter 'amulet_map_editor' -LiteralPath $rootDir -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '__main__.py') } |
    Select-Object -First 1
  if ($pkg) { $amMode = 'python'; $amPath = (Split-Path -Parent $pkg.FullName); break }
}

[pscustomobject]@{
  savesPath   = "$saves"
  savesFound  = [bool]$savesFound
  pythonPath  = "$py"
  pythonFound = [bool]($py -ne '')
  amuletMode  = "$amMode"
  amuletPath  = "$amPath"
  amuletFound = [bool]($amMode -ne '')
  appDir      = "$appDir"
}`;
}

// ── PowerShell: scan a saves folder into World rows ──────────────────────────
// For each immediate subfolder that contains level.dat, read the gzipped
// big-endian NBT (Java level.dat) with an inline minimal reader that mirrors
// AmuletService.NbtReader — pulling LevelName, Version{Name,Id}, DataVersion,
// LastPlayed — plus folder size + dimension subfolders. Best-effort per world.
function scanScript(savesPath: string): string {
  const saves = ps(savesPath);
  return `
$ErrorActionPreference='SilentlyContinue'
$saves = ${saves}
if (-not (Test-Path -LiteralPath $saves)) { return }

function Read-LevelDat($path) {
  $out = [ordered]@{ Name=''; Version=''; DataVersion=0; Edition='' }
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $gz = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
      $ms = New-Object System.IO.MemoryStream
      $gz.CopyTo($ms); $gz.Dispose()
      $b = $ms.ToArray(); $ms.Dispose()
      $out.Edition = 'Java'
    } catch { $out.Edition = 'Bedrock?'; return $out }
    finally { $fs.Dispose() }

    $script:i = 0
    function RB { $v = $b[$script:i]; $script:i++; return $v }
    function RShort { $v = ($b[$script:i] -shl 8) -bor $b[$script:i+1]; $script:i += 2; return $v }
    function RInt { $v = ($b[$script:i] -shl 24) -bor ($b[$script:i+1] -shl 16) -bor ($b[$script:i+2] -shl 8) -bor $b[$script:i+3]; $script:i += 4; return $v }
    function RLong { $v = [long]0; for ($k=0; $k -lt 8; $k++){ $v = ($v -shl 8) -bor $b[$script:i+$k] }; $script:i += 8; return $v }
    function RStr { $len = [int]((($b[$script:i] -band 0xff) -shl 8) -bor ($b[$script:i+1] -band 0xff)); $script:i += 2; $s = [System.Text.Encoding]::UTF8.GetString($b, $script:i, $len); $script:i += $len; return $s }
    function RPayload($t) {
      switch ($t) {
        1 { RB | Out-Null }
        2 { RShort | Out-Null }
        3 { RInt | Out-Null }
        4 { RLong | Out-Null }
        5 { $script:i += 4 }
        6 { $script:i += 8 }
        7 { $n = RInt; $script:i += $n }
        8 { RStr | Out-Null }
        9 { $e = RB; $n = RInt; for ($k=0; $k -lt $n; $k++){ RPayload $e | Out-Null } }
        10 { RComp | Out-Null }
        11 { $n = RInt; $script:i += $n*4 }
        12 { $n = RInt; $script:i += $n*8 }
      }
    }
    function RComp {
      $c = @{}
      while ($true) {
        $t = RB
        if ($t -eq 0) { break }
        $name = RStr
        if ($t -eq 8) { $c[$name] = @{ k='s'; v=RStr } }
        elseif ($t -eq 3) { $c[$name] = @{ k='i'; v=RInt } }
        elseif ($t -eq 4) { $c[$name] = @{ k='l'; v=RLong } }
        elseif ($t -eq 10) { $c[$name] = @{ k='c'; v=RComp } }
        else { RPayload $t | Out-Null }
      }
      return $c
    }

    $t = RB
    if ($t -ne 10) { return $out }
    RStr | Out-Null
    $root = RComp
    $data = if ($root.ContainsKey('Data') -and $root['Data'].k -eq 'c') { $root['Data'].v } else { $root }

    if ($data.ContainsKey('LevelName') -and $data['LevelName'].k -eq 's') { $out.Name = $data['LevelName'].v }
    if ($data.ContainsKey('Version') -and $data['Version'].k -eq 'c') {
      $vc = $data['Version'].v
      if ($vc.ContainsKey('Name') -and $vc['Name'].k -eq 's') { $out.Version = $vc['Name'].v }
      if ($vc.ContainsKey('Id') -and $vc['Id'].k -eq 'i') { $out.DataVersion = $vc['Id'].v }
    }
    if ($out.DataVersion -eq 0 -and $data.ContainsKey('DataVersion') -and $data['DataVersion'].k -eq 'i') { $out.DataVersion = $data['DataVersion'].v }
    if ($data.ContainsKey('LastPlayed') -and $data['LastPlayed'].k -eq 'l' -and $data['LastPlayed'].v -gt 0) {
      $out.LastPlayed = $data['LastPlayed'].v
    }
  } catch {}
  return $out
}

Get-ChildItem -Directory -LiteralPath $saves -ErrorAction SilentlyContinue | ForEach-Object {
  $wf = $_.FullName
  $ld = Join-Path $wf 'level.dat'
  if (-not (Test-Path -LiteralPath $ld)) { return }

  $m = Read-LevelDat $ld
  $name = if ($m.Name) { $m.Name } else { $_.Name }

  # dimensions
  $dims = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath (Join-Path $wf 'region')) { $dims.Add('Overworld') }
  if (Test-Path -LiteralPath (Join-Path $wf 'DIM-1')) { $dims.Add('Nether') }
  if (Test-Path -LiteralPath (Join-Path $wf 'DIM1')) { $dims.Add('End') }
  $custom = Join-Path $wf 'dimensions'
  if (Test-Path -LiteralPath $custom) {
    Get-ChildItem -Directory -LiteralPath $custom -ErrorAction SilentlyContinue | ForEach-Object {
      $nsName = $_.Name
      Get-ChildItem -Directory -LiteralPath $_.FullName -ErrorAction SilentlyContinue | ForEach-Object { $dims.Add("$nsName:$($_.Name)") }
    }
  }

  # size
  $bytes = 0L
  try { $bytes = (Get-ChildItem -Recurse -File -LiteralPath $wf -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum }
  catch {}
  if (-not $bytes) { $bytes = 0L }
  $u = 'B','KB','MB','GB','TB'; $sz = [double]$bytes; $ui = 0
  while ($sz -ge 1024 -and $ui -lt 4) { $sz /= 1024; $ui++ }
  $sizeDisp = ('{0:0.#} {1}' -f $sz, $u[$ui])

  # last played (epoch ms)
  $lpDisp = ''; $lpTicks = 0L
  if ($m.LastPlayed -and [long]$m.LastPlayed -gt 0) {
    try {
      $dto = [System.DateTimeOffset]::FromUnixTimeMilliseconds([long]$m.LastPlayed).LocalDateTime
      $lpDisp = $dto.ToString('yyyy-MM-dd HH:mm')
      $lpTicks = [long]$m.LastPlayed
    } catch {}
  }

  [pscustomobject]@{
    Folder          = $wf
    Name            = $name
    Version         = "$($m.Version)"
    DataVersion     = [int]$m.DataVersion
    Edition         = if ($m.Edition) { $m.Edition } else { '' }
    Dimensions      = if ($dims.Count -gt 0) { ($dims -join ', ') } else { '' }
    SizeBytes       = [long]$bytes
    SizeDisplay     = $sizeDisp
    LastPlayed      = $lpDisp
    LastPlayedTicks = $lpTicks
  }
}`;
}

type SortKey = 'Name' | 'LastPlayed' | 'Size';

export function AmuletModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const pick = (en: string, zhs: string) => (zh ? zhs : en);

  const [customSaves, setCustomSaves] = useState('');
  const [appliedSaves, setAppliedSaves] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('LastPlayed');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState('');

  const appendLog = (line: string) =>
    setLog((prev) => {
      const next = (prev.length ? prev + '\n' : '') + line;
      return next.length > 60000 ? next.slice(next.length - 40000) : next;
    });

  // ── Environment probe ──────────────────────────────────────────────────────
  const env = useAsync<Env>(async () => {
    const fallback: Env = {
      savesPath: '',
      savesFound: false,
      pythonPath: '',
      pythonFound: false,
      amuletMode: '',
      amuletPath: '',
      amuletFound: false,
      appDir: '',
    };
    if (!isTauri()) return fallback;
    const rows = await runPowershellJson<Env>(envScript(appliedSaves));
    return rows[0] ?? fallback;
  }, [appliedSaves]);

  const savesPath = env.data?.savesPath ?? '';

  // ── World scan (depends on the resolved saves path) ────────────────────────
  const worlds = useAsync<World[]>(async () => {
    if (!isTauri() || !savesPath) return [];
    return await runPowershellJson<World>(scanScript(savesPath));
  }, [savesPath, env.data?.savesFound]);

  const rows = useMemo(() => {
    const all = worlds.data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((w) => `${w.Name} ${w.Version} ${w.Folder}`.toLowerCase().includes(q))
      : all;
    const sorted = [...list];
    if (sortKey === 'Name') sorted.sort((a, b) => a.Name.localeCompare(b.Name));
    else if (sortKey === 'Size') sorted.sort((a, b) => b.SizeBytes - a.SizeBytes);
    else sorted.sort((a, b) => b.LastPlayedTicks - a.LastPlayedTicks);
    return sorted;
  }, [worlds.data, filter, sortKey]);

  // ── Per-world actions ──────────────────────────────────────────────────────
  const openFolder = async (folder: string) => {
    if (!isTauri()) return;
    await runPowershell(`if (Test-Path -LiteralPath ${ps(folder)}) { Start-Process explorer.exe ${ps(folder)} }`);
    appendLog(pick(`[opened ${folder}]`, `[已開啟 ${folder}]`));
  };

  const backupWorld = async (w: World) => {
    if (!isTauri()) return;
    if (
      !window.confirm(
        pick(
          `Back up "${w.Name}" to a timestamped .zip in its parent folder?`,
          `將「${w.Name}」備份為帶時間戳嘅 .zip（放喺上層資料夾）？`,
        ),
      )
    )
      return;
    setBusy(w.Folder);
    appendLog(pick(`[backing up ${w.Name}…]`, `[備份 ${w.Name} 中…]`));
    // Compress-Archive the world folder into <parent>\<name>-backup-<stamp>.zip.
    const script = `
$ErrorActionPreference='Stop'
$wf = ${ps(w.Folder)}
$name = Split-Path -Leaf $wf
$parent = Split-Path -Parent $wf
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dest = Join-Path $parent ("$name-backup-$stamp.zip")
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
Compress-Archive -Path (Join-Path $wf '*') -DestinationPath $dest -CompressionLevel Optimal
$dest`;
    try {
      const r = await runPowershell(script);
      if (r.success && r.stdout.trim()) {
        appendLog(pick(`[backed up → ${r.stdout.trim()}]`, `[已備份 → ${r.stdout.trim()}]`));
      } else {
        appendLog(pick(`! Backup failed: ${r.stderr.trim() || `exit ${r.code}`}`, `！備份失敗：${r.stderr.trim() || `結束 ${r.code}`}`));
      }
    } catch (e) {
      appendLog(pick(`! Backup failed: ${String(e)}`, `！備份失敗：${String(e)}`));
    } finally {
      setBusy(null);
    }
  };

  const launchWorld = async (w: World) => {
    if (!isTauri()) return;
    const e = env.data;
    if (!e || !e.amuletFound) {
      appendLog(pick('! Amulet is not set up yet.', '！Amulet 仲未設定好。'));
      return;
    }
    setBusy(w.Folder);
    appendLog(pick(`[launching Amulet on ${w.Name}…]`, `[喺 ${w.Name} 啟動 Amulet 中…]`));
    // frozen exe → run directly with the world as an arg; python → py/python -m amulet_map_editor "<world>".
    // Detached via Start-Process so it never blocks the UI. Python mode runs from the package parent.
    let script: string;
    if (e.amuletMode === 'frozen') {
      script = `Start-Process -FilePath ${ps(e.amuletPath)} -ArgumentList ${ps(`"${w.Folder}"`)}`;
    } else {
      const pyExe = e.pythonPath || 'python';
      const isLauncher = /\\py\.exe$/i.test(pyExe);
      const argList = `${isLauncher ? '-3 ' : ''}-m amulet_map_editor "${w.Folder}"`;
      script = `Start-Process -FilePath ${ps(pyExe)} -ArgumentList ${ps(argList)} -WorkingDirectory ${ps(e.amuletPath)}`;
    }
    try {
      const r = await runPowershell(script);
      appendLog(
        r.success
          ? pick(`[Amulet launched on ${w.Name}]`, `[Amulet 已喺 ${w.Name} 啟動]`)
          : pick(`! Launch failed: ${r.stderr.trim() || `exit ${r.code}`}`, `！啟動失敗：${r.stderr.trim() || `結束 ${r.code}`}`),
      );
    } catch (err) {
      appendLog(pick(`! Launch failed: ${String(err)}`, `！啟動失敗：${String(err)}`));
    } finally {
      setBusy(null);
    }
  };

  // ── Setup / maintenance ────────────────────────────────────────────────────
  const openSaves = async () => {
    if (!isTauri() || !savesPath) return;
    await runPowershell(`if (Test-Path -LiteralPath ${ps(savesPath)}) { Start-Process explorer.exe ${ps(savesPath)} }`);
    appendLog(pick('[opened saves folder]', '[已開啟存檔資料夾]'));
  };

  const openAppDir = async () => {
    if (!isTauri()) return;
    const dir = env.data?.appDir || '';
    await runPowershell(
      `$d = ${dir ? ps(dir) : `Join-Path $env:LOCALAPPDATA 'WinForge\\Amulet'`}; New-Item -ItemType Directory -Force -Path $d | Out-Null; Start-Process explorer.exe $d`,
    );
    appendLog(pick('[opened Amulet app folder]', '[已開啟 Amulet 應用資料夾]'));
  };

  const applyCustomSaves = () => {
    setAppliedSaves(customSaves);
    appendLog(
      customSaves.trim()
        ? pick(`[using saves: ${customSaves.trim()}]`, `[使用存檔：${customSaves.trim()}]`)
        : pick('[using default .minecraft\\saves]', '[使用預設 .minecraft\\saves]'),
    );
  };

  const e = env.data;
  const amuletLabel = e?.amuletFound
    ? e.amuletMode === 'frozen'
      ? pick('Amulet ready (frozen build)', 'Amulet 就緒（凍結版）')
      : pick('Amulet ready (Python source)', 'Amulet 就緒（Python 源碼）')
    : pick('Amulet not set up', 'Amulet 未設定');
  const needsPython = !e?.amuletFound || e.amuletMode === 'python';

  const columns: Column<World>[] = [
    { key: 'Name', header: t('amulet.colName'), render: (w) => <span style={{ fontWeight: 600 }}>{w.Name}</span> },
    {
      key: 'Version',
      header: t('amulet.colVersion'),
      width: 150,
      render: (w) =>
        w.Version
          ? w.DataVersion > 0
            ? `${w.Version} (${w.DataVersion})`
            : w.Version
          : w.DataVersion > 0
            ? `DataVersion ${w.DataVersion}`
            : '—',
    },
    { key: 'Edition', header: t('amulet.colEdition'), width: 90, render: (w) => w.Edition || '—' },
    { key: 'Dimensions', header: t('amulet.colDims'), render: (w) => w.Dimensions || '—' },
    { key: 'SizeDisplay', header: t('amulet.colSize'), width: 90, align: 'right', render: (w) => w.SizeDisplay },
    { key: 'LastPlayed', header: t('amulet.colPlayed'), width: 140, render: (w) => w.LastPlayed || '—' },
    {
      key: 'actions',
      header: '',
      width: 240,
      render: (w) => (
        <span className="row-actions">
          <button className="mini primary" disabled={!e?.amuletFound || busy === w.Folder} onClick={() => launchWorld(w)}>
            {t('amulet.launch')}
          </button>
          <button className="mini" disabled={busy === w.Folder} onClick={() => openFolder(w.Folder)}>
            {t('amulet.open')}
          </button>
          <button className="mini" disabled={busy === w.Folder} onClick={() => backupWorld(w)}>
            {t('amulet.backup')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('amulet.blurb')}
      </p>

      {/* ── Environment status ── */}
      <ModuleToolbar>
        <button className="mini" onClick={() => { env.reload(); worlds.reload(); }} disabled={env.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        {e && <StatusDot ok={e.savesFound} label={e.savesFound ? t('amulet.savesFound') : t('amulet.savesMissing')} />}
        {e && <StatusDot ok={e.amuletFound} label={amuletLabel} />}
        {e && needsPython && (
          <StatusDot ok={e.pythonFound} label={e.pythonFound ? t('amulet.pythonFound') : t('amulet.pythonMissing')} />
        )}
        <button className="mini" onClick={openSaves} disabled={!e?.savesFound}>
          {t('amulet.openSaves')}
        </button>
        <button className="mini" onClick={openAppDir}>
          {t('amulet.openAppDir')}
        </button>
      </ModuleToolbar>

      {e?.pythonPath && needsPython && (
        <p className="count-note" style={{ marginTop: 0, fontFamily: 'monospace' }}>
          {e.pythonPath}
        </p>
      )}
      {e && !e.amuletFound && (
        <p className="mod-msg">{t('amulet.setupHint')}</p>
      )}
      {e && !e.pythonFound && needsPython && (
        <p className="mod-msg">{t('amulet.pythonHint')}</p>
      )}

      {/* ── Custom saves path ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <label className="count-note">{t('amulet.savesLabel')}</label>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'monospace' }}
            placeholder={savesPath || 'C:\\Users\\you\\AppData\\Roaming\\.minecraft\\saves'}
            value={customSaves}
            onChange={(ev) => setCustomSaves(ev.target.value)}
            onKeyDown={(ev) => ev.key === 'Enter' && applyCustomSaves()}
          />
          <button className="mini" onClick={applyCustomSaves}>
            {t('amulet.useSaves')}
          </button>
        </div>
        {savesPath && (
          <p className="count-note" style={{ marginTop: 0, fontFamily: 'monospace' }}>
            {savesPath}
          </p>
        )}
      </section>

      {/* ── World table ── */}
      <section style={{ marginTop: 12 }}>
        <ModuleToolbar>
          <input
            className="mod-search"
            placeholder={t('amulet.filter')}
            value={filter}
            onChange={(ev) => setFilter(ev.target.value)}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('amulet.sortBy')}
            <select className="mod-search" value={sortKey} onChange={(ev) => setSortKey(ev.target.value as SortKey)}>
              <option value="LastPlayed">{t('amulet.sortPlayed')}</option>
              <option value="Name">{t('amulet.sortName')}</option>
              <option value="Size">{t('amulet.sortSize')}</option>
            </select>
          </label>
          <button className="mini" onClick={worlds.reload} disabled={worlds.loading}>
            ⟳ {t('amulet.rescan')}
          </button>
          <span className="count-note">{t('amulet.worldCount', { num: rows.length })}</span>
        </ModuleToolbar>
        <AsyncState loading={worlds.loading || env.loading} error={worlds.error ?? env.error}>
          <DataTable columns={columns} rows={rows} rowKey={(w) => w.Folder} empty={t('amulet.noWorlds')} />
        </AsyncState>
      </section>

      {/* ── Live log ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <div className="mod-toolbar">
          <h3 style={{ flex: 1, margin: 0 }}>{t('amulet.logHeader')}</h3>
          <button className="mini" onClick={() => setLog('')} disabled={!log}>
            {t('amulet.clearLog')}
          </button>
        </div>
        <pre className="cmd-out" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {log || t('amulet.logEmpty')}
        </pre>
      </section>

      <p className="count-note">{t('amulet.gplNote')}</p>
    </div>
  );
}
