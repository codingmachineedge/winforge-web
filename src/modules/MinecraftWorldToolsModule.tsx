import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

/** One discovered Minecraft world, described like the C# DescribeWorld / IsValidWorld surface. */
interface World {
  Name: string;
  Path: string;
  Edition: string; // "Java" | "Bedrock"
  Regions: number;
  SizeMB: number;
  Modified: string;
  Source: string; // save-root label (e.g. .minecraft/saves)
}

/** Toolchain probe: Java + Python presence, mirroring FindJava + ProbePythonAndChunker. */
interface Toolchain {
  JavaFound: boolean;
  JavaVersion: string;
  PythonFound: boolean;
  PythonVersion: string;
}

// PowerShell: probe the external toolchain Chunker/BlueMap depend on, read-only (`--version`).
const TOOLCHAIN_PS = String.raw`
$java = ''
try {
  $jv = (& java -version) 2>&1 | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $jv) { $java = ($jv | Out-String).Trim() }
} catch {}
$py = ''
foreach ($cmd in @('python','py')) {
  try {
    $pv = (& $cmd --version) 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and "$pv" -match 'Python') { $py = ("$pv").Trim(); break }
  } catch {}
}
[pscustomobject]@{
  JavaFound   = [bool]$java
  JavaVersion = if ($java) { $java } else { '' }
  PythonFound = [bool]$py
  PythonVersion = if ($py) { $py } else { '' }
}`;

// PowerShell: enumerate Minecraft worlds across standard Java + Bedrock save roots and describe each
// like the C# service (level.dat / region / db detection, size, region-file count, last modified).
const WORLDS_PS = String.raw`
$roots = @()
$appdata = $env:APPDATA
$local = $env:LOCALAPPDATA
if ($appData) { $roots += [pscustomobject]@{ Dir = (Join-Path $appData '.minecraft\saves'); Edition='Java'; Label='.minecraft/saves' } }
if ($local) {
  $bedrock = Join-Path $local 'Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\minecraftWorlds'
  $roots += [pscustomobject]@{ Dir = $bedrock; Edition='Bedrock'; Label='Bedrock' }
}
$prof = Join-Path $HOME 'curseforge\minecraft\Instances'
if (Test-Path $prof) { $roots += [pscustomobject]@{ Dir = $prof; Edition='Java'; Label='CurseForge'; Deep=$true } }

$out = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r.Dir)) { continue }
  $depth = if ($r.PSObject.Properties['Deep']) { 4 } else { 1 }
  $dirs = Get-ChildItem -LiteralPath $r.Dir -Directory -ErrorAction SilentlyContinue
  if ($r.PSObject.Properties['Deep']) {
    $dirs = Get-ChildItem -LiteralPath $r.Dir -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'level.dat') }
  }
  foreach ($d in $dirs) {
    $p = $d.FullName
    $isJava = (Test-Path (Join-Path $p 'region')) -or (Test-Path (Join-Path $p 'level.dat'))
    $isBedrock = Test-Path (Join-Path $p 'db')
    if (-not ($isJava -or $isBedrock)) { continue }
    $edition = if ($isBedrock -and -not (Test-Path (Join-Path $p 'region'))) { 'Bedrock' } else { $r.Edition }
    $regions = 0
    foreach ($rd in @('region','DIM-1\region','DIM1\region')) {
      $rp = Join-Path $p $rd
      if (Test-Path $rp) { $regions += (Get-ChildItem -LiteralPath $rp -Filter '*.mca' -ErrorAction SilentlyContinue | Measure-Object).Count }
    }
    $bytes = 0
    try { $bytes = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
    if (-not $bytes) { $bytes = 0 }
    $out += [pscustomobject]@{
      Name = $d.Name
      Path = $p
      Edition = $edition
      Regions = [int]$regions
      SizeMB = [math]::Round($bytes / 1MB, 1)
      Modified = $d.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
      Source = $r.Label
    }
  }
}
$out`;

export function MinecraftWorldToolsModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const worlds = useAsync(() => runPowershellJson<World>(WORLDS_PS), []);
  const tools = useAsync(async () => {
    const rows = await runPowershellJson<Toolchain>(TOOLCHAIN_PS);
    return rows[0] ?? null;
  }, []);

  const rows = useMemo(() => {
    const all = worlds.data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((w) => `${w.Name} ${w.Edition} ${w.Source}`.toLowerCase().includes(q))
      : all;
    return [...list].sort((a, b) => b.SizeMB - a.SizeMB);
  }, [worlds.data, filter]);

  const totalMB = useMemo(() => rows.reduce((s, w) => s + (w.SizeMB || 0), 0), [rows]);

  const copyPath = async (path: string) => {
    setCopied(null);
    try {
      await runPowershell(`Set-Clipboard -Value ${JSON.stringify(path)}`);
      setCopied(path);
    } catch {
      setCopied(null);
    }
  };

  const openFolder = (path: string) => {
    // Read-only: just reveal the world folder in Explorer, never mutate it.
    void runPowershell(`Start-Process explorer.exe -ArgumentList ${JSON.stringify(path)}`);
  };

  const fmtMB = (mb: number) => {
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
  };

  const columns: Column<World>[] = [
    {
      key: 'Edition',
      header: t('mcworldtools.edition'),
      width: 96,
      render: (w) => <StatusDot ok={w.Edition === 'Java'} label={w.Edition} />,
    },
    { key: 'Name', header: t('mcworldtools.worldName') },
    {
      key: 'SizeMB',
      header: t('mcworldtools.size'),
      width: 110,
      align: 'right',
      render: (w) => fmtMB(w.SizeMB),
    },
    {
      key: 'Regions',
      header: t('mcworldtools.regions'),
      width: 110,
      align: 'right',
      render: (w) => (w.Regions > 0 ? w.Regions.toLocaleString() : '—'),
    },
    { key: 'Source', header: t('mcworldtools.source'), width: 140 },
    { key: 'Modified', header: t('mcworldtools.modified'), width: 140 },
    {
      key: 'actions',
      header: '',
      width: 170,
      render: (w) => (
        <span className="row-actions">
          <button className="mini" onClick={() => openFolder(w.Path)}>
            {t('mcworldtools.open')}
          </button>
          <button className="mini" onClick={() => copyPath(w.Path)}>
            {copied === w.Path ? t('mcworldtools.copied') : t('mcworldtools.copyPath')}
          </button>
        </span>
      ),
    },
  ];

  const tc = tools.data;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mcworldtools.blurb')}
      </p>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('mcworldtools.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="mini"
          onClick={() => {
            worlds.reload();
            tools.reload();
          }}
        >
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {t('mcworldtools.count', { worlds: rows.length })} · {fmtMB(totalMB)}
        </span>
      </ModuleToolbar>

      <div className="mod-toolbar" style={{ gap: 16, flexWrap: 'wrap' }}>
        {tools.loading ? (
          <span className="count-note">{t('mcworldtools.probingTools')}</span>
        ) : (
          <>
            <StatusDot
              ok={!!tc?.JavaFound}
              label={
                tc?.JavaFound
                  ? `${t('mcworldtools.java')}: ${tc.JavaVersion}`
                  : `${t('mcworldtools.java')}: ${t('mcworldtools.notFound')}`
              }
            />
            <StatusDot
              ok={!!tc?.PythonFound}
              label={
                tc?.PythonFound
                  ? `${t('mcworldtools.python')}: ${tc.PythonVersion}`
                  : `${t('mcworldtools.python')}: ${t('mcworldtools.notFound')}`
              }
            />
          </>
        )}
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mcworldtools.toolsNote')}
      </p>

      <AsyncState loading={worlds.loading} error={worlds.error}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(w) => w.Path}
          empty={t('mcworldtools.empty')}
        />
      </AsyncState>
    </div>
  );
}
