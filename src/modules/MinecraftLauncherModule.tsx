import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Minecraft Launcher — module.minecraftlauncher
//
// A live, read-only view of the local Minecraft Java Edition install. WinForge
// has no C# MinecraftLauncherModule source (verified: nothing matching
// *inecraft* / *auncher* under ../WinForge/Pages or /Services), so this is a
// fresh native port that gathers real data from the system through the Tauri
// PowerShell backend rather than a stub.
//
// The launcher keeps everything under %APPDATA%\.minecraft:
//   • launcher_profiles.json  → installed launcher profiles (name, version, icon)
//   • versions\<id>\<id>.json → installed game versions (release / snapshot, date)
//   • saves\<world>\          → worlds (level name, gamemode-ish size, last played)
//   • mods\*.jar              → installed mods (Forge / Fabric jars)
//   • resourcepacks\ shaderpacks\ → packs
//   • logs\latest.log         → tail of the most recent session log
// Plus detected Java runtimes (the launcher's bundled runtime + any java on PATH),
// and disk usage of the whole .minecraft tree.
//
// Read-only / data-gathering only. The single action — "Launch" — starts the
// official Minecraft launcher (MinecraftLauncher.exe) and is gated behind an
// explicit confirm; nothing auto-runs, nothing is written or deleted.
// ============================================================================

const TABS = ['overview', 'versions', 'worlds', 'content', 'runtimes', 'log'] as const;
type Tab = (typeof TABS)[number];

const CONTENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks'] as const;
type ContentKind = (typeof CONTENT_KINDS)[number];

// Root of a default Java Edition install. All scans are scoped under here.
const MC_ROOT = '$env:APPDATA + "\\.minecraft"';

interface Overview {
  root: string;
  exists: boolean;
  launcherExe: string;
  launcherFound: boolean;
  sizeBytes: number;
  versionsCount: number;
  worldsCount: number;
  modsCount: number;
}

interface VersionRow {
  Id: string;
  Type: string;
  ReleaseTime: string;
  SizeMB: number;
}

interface WorldRow {
  Name: string;
  Folder: string;
  SizeMB: number;
  LastPlayed: string;
  HasIcon: boolean;
}

interface ContentRow {
  Name: string;
  SizeMB: number;
  Modified: string;
}

interface RuntimeRow {
  Kind: string;
  Path: string;
  Version: string;
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function MinecraftLauncherModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Overview: root existence, launcher exe, aggregate counts + size ─────────
  const ov = useAsync<Overview>(async () => {
    const rows = await runPowershellJson<Overview>(`
      $root = ${MC_ROOT}
      $exists = Test-Path -LiteralPath $root
      $candidates = @(
        (Join-Path ${'${env:ProgramFiles(x86)}'} 'Minecraft Launcher\\MinecraftLauncher.exe'),
        (Join-Path $env:ProgramFiles 'Minecraft Launcher\\MinecraftLauncher.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\\Minecraft Launcher\\MinecraftLauncher.exe')
      )
      $exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
      $size = 0; $vC = 0; $wC = 0; $mC = 0
      if ($exists) {
        try { $s = (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if ($s) { $size = $s } } catch {}
        $vDir = Join-Path $root 'versions'; if (Test-Path $vDir) { $vC = @(Get-ChildItem -LiteralPath $vDir -Directory -ErrorAction SilentlyContinue).Count }
        $wDir = Join-Path $root 'saves';    if (Test-Path $wDir) { $wC = @(Get-ChildItem -LiteralPath $wDir -Directory -ErrorAction SilentlyContinue).Count }
        $mDir = Join-Path $root 'mods';     if (Test-Path $mDir) { $mC = @(Get-ChildItem -LiteralPath $mDir -File -Filter *.jar -ErrorAction SilentlyContinue).Count }
      }
      [pscustomobject]@{
        root = $root; exists = [bool]$exists;
        launcherExe = [string]$exe; launcherFound = [bool]$exe;
        sizeBytes = [long]$size;
        versionsCount = [int]$vC; worldsCount = [int]$wC; modsCount = [int]$mC
      }`);
    const r = rows[0];
    if (!r) throw new Error('no data');
    return { ...r, sizeBytes: Number(r.sizeBytes) || 0 };
  }, []);

  const overview = ov.data;

  // ── Versions: installed game versions from versions\<id>\<id>.json ──────────
  const versions = useAsync<VersionRow[]>(
    () =>
      runPowershellJson<VersionRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root 'versions'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $id = $_.Name
          $json = Join-Path $_.FullName ($id + '.json')
          $type = 'unknown'; $rel = ''
          if (Test-Path $json) {
            try {
              $j = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
              if ($j.type) { $type = [string]$j.type }
              if ($j.releaseTime) { $rel = ([datetime]$j.releaseTime).ToString('yyyy-MM-dd') }
            } catch {}
          }
          $sz = 0
          try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          [pscustomobject]@{
            Id = $id; Type = $type; ReleaseTime = $rel;
            SizeMB = [math]::Round(($sz / 1MB), 1)
          }
        }`),
    [],
  );

  // ── Worlds: saves\<world>, level name from level.dat is binary, so use folder
  // name + last-write of the session lock / level.dat as "last played". ────────
  const worlds = useAsync<WorldRow[]>(
    () =>
      runPowershellJson<WorldRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root 'saves'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $sz = 0
          try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          $lvl = Join-Path $_.FullName 'level.dat'
          $when = $_.LastWriteTime
          if (Test-Path $lvl) { $when = (Get-Item -LiteralPath $lvl).LastWriteTime }
          [pscustomobject]@{
            Name = $_.Name; Folder = $_.Name;
            SizeMB = [math]::Round(($sz / 1MB), 1);
            LastPlayed = $when.ToString('yyyy-MM-dd HH:mm');
            HasIcon = [bool](Test-Path (Join-Path $_.FullName 'icon.png'))
          }
        }`),
    [],
  );

  // ── Content: mods / resourcepacks / shaderpacks (files + folders) ───────────
  const [kind, setKind] = useState<ContentKind>('mods');
  const content = useAsync<ContentRow[]>(
    () =>
      runPowershellJson<ContentRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root '${kind}'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | ForEach-Object {
          $sz = 0
          if ($_.PSIsContainer) {
            try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          } else { $sz = $_.Length }
          [pscustomobject]@{
            Name = $_.Name;
            SizeMB = [math]::Round(($sz / 1MB), 2);
            Modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
          }
        }`),
    [kind],
  );

  // ── Runtimes: launcher-bundled JREs + java on PATH ──────────────────────────
  const runtimes = useAsync<RuntimeRow[]>(async () => {
    const rows = await runPowershellJson<RuntimeRow>(`
      $out = @()
      $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime'),
        (Join-Path $env:APPDATA '.minecraft\\runtime'),
        (Join-Path ${'${env:ProgramFiles(x86)}'} 'Minecraft Launcher\\runtime')
      )
      foreach ($rt in $roots) {
        if (Test-Path $rt) {
          Get-ChildItem -LiteralPath $rt -Recurse -Filter 'javaw.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 12 | ForEach-Object {
            $ver = ''
            try {
              $fv = $_.VersionInfo.ProductVersion; if ($fv) { $ver = [string]$fv }
            } catch {}
            $out += [pscustomobject]@{ Kind = 'bundled'; Path = $_.FullName; Version = $ver }
          }
        }
      }
      $onPath = Get-Command java -ErrorAction SilentlyContinue
      if ($onPath) {
        $v = ''
        try { $v = (& java -version 2>&1 | Select-Object -First 1) -join ' ' } catch {}
        $out += [pscustomobject]@{ Kind = 'path'; Path = [string]$onPath.Source; Version = [string]$v }
      }
      $out`);
    return rows;
  }, []);

  // ── Log: tail of the most recent session log ────────────────────────────────
  const [logText, setLogText] = useState<string>('');
  const [logLoaded, setLogLoaded] = useState(false);
  const loadLog = async () => {
    if (!isTauri()) {
      setLogText(t('mclauncher.desktopOnly'));
      setLogLoaded(true);
      return;
    }
    setBusy(true);
    const res = await runPowershell(`
      $root = ${MC_ROOT}; $log = Join-Path $root 'logs\\latest.log'
      if (Test-Path $log) { Get-Content -LiteralPath $log -Tail 300 } else { '' }`);
    setBusy(false);
    setLogText(res.stdout.trim() || t('mclauncher.noLog'));
    setLogLoaded(true);
  };

  const launch = async () => {
    if (!overview) return;
    if (!overview.launcherFound) {
      setMsg({ ok: false, text: t('mclauncher.launcherMissing') });
      return;
    }
    if (!isTauri()) {
      setMsg({ ok: false, text: t('mclauncher.desktopOnly') });
      return;
    }
    if (!confirm(t('mclauncher.confirmLaunch'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runCommand(overview.launcherExe, []);
      setMsg({
        ok: res.success || res.code === 0,
        text: res.success ? t('mclauncher.launched') : res.stderr.trim() || t('mclauncher.launchFailed'),
      });
    } catch (e) {
      setMsg({ ok: false, text: `${t('mclauncher.launchFailed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const refreshAll = () => {
    ov.reload();
    versions.reload();
    worlds.reload();
    content.reload();
    runtimes.reload();
    setLogLoaded(false);
    setLogText('');
  };

  // ── column defs ─────────────────────────────────────────────────────────────
  const versionCols: Column<VersionRow>[] = [
    { key: 'Id', header: t('mclauncher.versionId') },
    {
      key: 'Type',
      header: t('mclauncher.versionType'),
      width: 130,
      render: (v) => <StatusDot ok={v.Type === 'release'} label={v.Type} />,
    },
    { key: 'ReleaseTime', header: t('mclauncher.released'), width: 130 },
    {
      key: 'SizeMB',
      header: t('mclauncher.size'),
      width: 100,
      align: 'right',
      render: (v) => `${v.SizeMB} MB`,
    },
  ];

  const worldCols: Column<WorldRow>[] = [
    {
      key: 'Name',
      header: t('mclauncher.worldName'),
      render: (w) => (
        <span>
          {w.HasIcon ? '🗺️ ' : '📁 '}
          {w.Name}
        </span>
      ),
    },
    { key: 'LastPlayed', header: t('mclauncher.lastPlayed'), width: 160 },
    {
      key: 'SizeMB',
      header: t('mclauncher.size'),
      width: 100,
      align: 'right',
      render: (w) => `${w.SizeMB} MB`,
    },
  ];

  const contentCols: Column<ContentRow>[] = [
    { key: 'Name', header: t('mclauncher.fileName'), render: (c) => <span style={{ fontFamily: 'monospace' }}>{c.Name}</span> },
    { key: 'Modified', header: t('mclauncher.modified'), width: 160 },
    {
      key: 'SizeMB',
      header: t('mclauncher.size'),
      width: 100,
      align: 'right',
      render: (c) => `${c.SizeMB} MB`,
    },
  ];

  const runtimeCols: Column<RuntimeRow>[] = [
    {
      key: 'Kind',
      header: t('mclauncher.runtimeKind'),
      width: 110,
      render: (r) => (r.Kind === 'bundled' ? t('mclauncher.bundled') : t('mclauncher.onPath')),
    },
    { key: 'Version', header: t('mclauncher.version'), width: 220 },
    { key: 'Path', header: t('mclauncher.path'), render: (r) => <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.Path}</span> },
  ];

  const sortedVersions = useMemo(
    () => [...(versions.data ?? [])].sort((a, b) => b.ReleaseTime.localeCompare(a.ReleaseTime) || a.Id.localeCompare(b.Id)),
    [versions.data],
  );
  const sortedWorlds = useMemo(
    () => [...(worlds.data ?? [])].sort((a, b) => b.LastPlayed.localeCompare(a.LastPlayed)),
    [worlds.data],
  );
  const sortedContent = useMemo(
    () => [...(content.data ?? [])].sort((a, b) => a.Name.localeCompare(b.Name)),
    [content.data],
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mclauncher.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={refreshAll} disabled={busy}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini primary" onClick={launch} disabled={busy || !overview?.launcherFound}>
          ▶ {t('mclauncher.launch')}
        </button>
        {overview && (
          <StatusDot
            ok={overview.exists}
            label={overview.exists ? t('mclauncher.installed') : t('mclauncher.notInstalled')}
          />
        )}
        {overview?.exists && (
          <span className="count-note">
            {t('mclauncher.diskUsage', { size: fmtBytes(overview.sizeBytes) })}
          </span>
        )}
      </ModuleToolbar>

      {overview && !overview.launcherFound && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mclauncher.launcherMissing')}
        </p>
      )}
      {msg && (
        <pre className={`cmd-out${msg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </pre>
      )}

      <div className="mod-tabbar" role="tablist" style={{ marginTop: 8 }}>
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={`mod-tab${id === tab ? ' active' : ''}`}
            onClick={() => {
              setTab(id);
              if (id === 'log' && !logLoaded) loadLog();
            }}
          >
            {t(`mclauncher.tab.${id}`)}
          </button>
        ))}
      </div>

      <div className="mod-tabpanel" role="tabpanel">
        {tab === 'overview' && (
          <AsyncState loading={ov.loading} error={ov.error}>
            {overview && (
              <div>
                <table className="dt">
                  <tbody>
                    <tr>
                      <td>{t('mclauncher.root')}</td>
                      <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{overview.root}</td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.launcherExe')}</td>
                      <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {overview.launcherFound ? overview.launcherExe : t('mclauncher.launcherMissing')}
                      </td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.installed')}</td>
                      <td>
                        <StatusDot ok={overview.exists} label={overview.exists ? t('mclauncher.yes') : t('mclauncher.no')} />
                      </td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.diskLabel')}</td>
                      <td>{fmtBytes(overview.sizeBytes)}</td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.tab.versions')}</td>
                      <td>{overview.versionsCount}</td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.tab.worlds')}</td>
                      <td>{overview.worldsCount}</td>
                    </tr>
                    <tr>
                      <td>{t('mclauncher.modsLabel')}</td>
                      <td>{overview.modsCount}</td>
                    </tr>
                  </tbody>
                </table>
                {!isTauri() && <p className="count-note">{t('mclauncher.desktopOnly')}</p>}
              </div>
            )}
          </AsyncState>
        )}

        {tab === 'versions' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={versions.reload} disabled={versions.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.versionCount', { num: sortedVersions.length })}</span>
            </div>
            <AsyncState loading={versions.loading} error={versions.error}>
              <DataTable columns={versionCols} rows={sortedVersions} rowKey={(v) => v.Id} empty={t('mclauncher.noVersions')} />
            </AsyncState>
          </div>
        )}

        {tab === 'worlds' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={worlds.reload} disabled={worlds.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.worldCount', { num: sortedWorlds.length })}</span>
            </div>
            <AsyncState loading={worlds.loading} error={worlds.error}>
              <DataTable columns={worldCols} rows={sortedWorlds} rowKey={(w) => w.Folder} empty={t('mclauncher.noWorlds')} />
            </AsyncState>
          </div>
        )}

        {tab === 'content' && (
          <div>
            <div className="mod-toolbar">
              <select className="mod-search" value={kind} onChange={(e) => setKind(e.target.value as ContentKind)}>
                {CONTENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`mclauncher.content.${k}`)}
                  </option>
                ))}
              </select>
              <button className="mini" onClick={content.reload} disabled={content.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.itemCount', { num: sortedContent.length })}</span>
            </div>
            <AsyncState loading={content.loading} error={content.error}>
              <DataTable columns={contentCols} rows={sortedContent} rowKey={(c) => c.Name} empty={t('mclauncher.noContent')} />
            </AsyncState>
          </div>
        )}

        {tab === 'runtimes' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={runtimes.reload} disabled={runtimes.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.runtimeCount', { num: (runtimes.data ?? []).length })}</span>
            </div>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('mclauncher.runtimeHint')}
            </p>
            <AsyncState loading={runtimes.loading} error={runtimes.error}>
              <DataTable
                columns={runtimeCols}
                rows={runtimes.data ?? []}
                rowKey={(r, i) => r.Path + i}
                empty={t('mclauncher.noRuntimes')}
              />
            </AsyncState>
          </div>
        )}

        {tab === 'log' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={loadLog} disabled={busy}>
                ⟳ {t('mclauncher.reloadLog')}
              </button>
              <span className="count-note">{t('mclauncher.logHint')}</span>
            </div>
            {logLoaded ? (
              <pre className="cmd-out" style={{ maxHeight: 460, overflow: 'auto' }}>
                {logText}
              </pre>
            ) : (
              <p className="count-note">{t('modules.loading')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
