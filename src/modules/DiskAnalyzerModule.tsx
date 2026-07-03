// Disk Analyser · 磁碟分析 — port of WinForge Pages/DiskAnalyzerModule.xaml(.cs) +
// Services/DiskAnalyzer.cs. WinDirStat-style in-app disk-usage view: size of each
// immediate child (recursive) or top-200 largest files, %-bars, drill-in, Up, and a
// confirm-gated "send to Recycle Bin". Live data via the Tauri PowerShell bridge.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getEnv, isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface Entry {
  Name: string;
  Path: string;
  Size: number;
  IsDir: boolean;
}

interface DriveRow {
  Root: string;
  Free: number;
  Total: number;
}

type Mode = 'folders' | 'files';

/** Escape a literal for a single-quoted PowerShell string. */
const psq = (s: string) => s.replace(/'/g, "''");

/** Port of DiskAnalyzer.HumanSize (B → TB, one decimal). */
function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024;
    i += 1;
  }
  return `${Math.round(s * 10) / 10} ${units[i] ?? 'B'}`;
}

/** Parent directory of a Windows path, or null at a drive root. */
function parentOf(p: string): string | null {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i <= 0) return null;
  const up = norm.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
}

// Iterative (stack-based) walk — PowerShell 5.1-safe, skips reparse points so
// AppData junction loops can't hang the scan, swallows access-denied like the
// original C# DiskAnalyzer.DirSize.
const SIZER_BLOCK = `
$sizer = {
  param($p)
  $total = [long]0
  $st = New-Object 'System.Collections.Generic.Stack[string]'
  $st.Push($p)
  while ($st.Count -gt 0) {
    $d = $st.Pop()
    try {
      $di = New-Object System.IO.DirectoryInfo $d
      foreach ($f in $di.EnumerateFiles()) { $total += $f.Length }
      foreach ($s in $di.EnumerateDirectories()) {
        if (($s.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { $st.Push($s.FullName) }
      }
    } catch {}
  }
  return $total
}`;

/** DiskAnalyzer.ByChild: recursive size of each immediate subfolder + loose files. */
function byFolderScript(root: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$root = '${psq(root)}'
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw ('Folder not found: ' + $root) }
${SIZER_BLOCK}
$rows = New-Object 'System.Collections.Generic.List[object]'
$rd = New-Object System.IO.DirectoryInfo $root
try {
  foreach ($d in $rd.EnumerateDirectories()) {
    $rows.Add([pscustomobject]@{ Name = $d.Name; Path = $d.FullName; Size = [long](& $sizer $d.FullName); IsDir = $true })
  }
} catch {}
try {
  foreach ($f in $rd.EnumerateFiles()) {
    $rows.Add([pscustomobject]@{ Name = $f.Name; Path = $f.FullName; Size = [long]$f.Length; IsDir = $false })
  }
} catch {}
$rows | Sort-Object -Property Size -Descending
`;
}

/** DiskAnalyzer.LargestFiles: top 200 files under the folder, recursive. */
function largestScript(root: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$root = '${psq(root)}'
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw ('Folder not found: ' + $root) }
$files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
$st = New-Object 'System.Collections.Generic.Stack[string]'
$st.Push($root)
while ($st.Count -gt 0) {
  $d = $st.Pop()
  try {
    $di = New-Object System.IO.DirectoryInfo $d
    foreach ($f in $di.EnumerateFiles()) { $files.Add($f) }
    foreach ($s in $di.EnumerateDirectories()) {
      if (($s.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { $st.Push($s.FullName) }
    }
  } catch {}
}
$files | Sort-Object -Property Length -Descending | Select-Object -First 200 | ForEach-Object {
  [pscustomobject]@{ Name = $_.Name; Path = $_.FullName; Size = [long]$_.Length; IsDir = $false }
}
`;
}

const DRIVES_PS = `[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object {
  [pscustomobject]@{ Root = $_.Name; Free = [long]$_.AvailableFreeSpace; Total = [long]$_.TotalSize }
}`;

/** BulkFileOps.Recycle equivalent: send to Recycle Bin (recoverable), never permanent delete. */
function recycleScript(path: string): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$p = '${psq(path)}'
if ([System.IO.Directory]::Exists($p)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
} elseif ([System.IO.File]::Exists($p)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  throw ('Not found: ' + $p)
}
'ok'
`;
}

export function DiskAnalyzerModule() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [folder, setFolder] = useState('');
  const [mode, setMode] = useState<Mode>('folders');
  const [home, setHome] = useState('');
  const [pending, setPending] = useState<Entry | null>(null);
  const [recycling, setRecycling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed with the user profile (WinForge seeds its own folder; the profile is
  // the useful starting point for "where did my space go").
  useEffect(() => {
    if (!isTauri()) return;
    getEnv('USERPROFILE')
      .then((p) => {
        if (!p) return;
        setHome(p);
        setDraft((d) => (d ? d : p));
        setFolder((f) => (f ? f : p));
      })
      .catch(() => {});
  }, []);

  const { data, loading, error, reload } = useAsync<Entry[]>(() => {
    if (!folder) return Promise.resolve([]);
    return runPowershellJson<Entry>(mode === 'files' ? largestScript(folder) : byFolderScript(folder));
  }, [folder, mode]);

  const { data: driveData } = useAsync<DriveRow[]>(
    () => (isTauri() ? runPowershellJson<DriveRow>(DRIVES_PS) : Promise.resolve([])),
    [],
  );

  const rows = data ?? [];
  const drives = driveData ?? [];
  const maxSize = rows.reduce((m, r) => (r.Size > m ? r.Size : m), 1);
  const totalBytes = rows.reduce((s, r) => s + r.Size, 0);
  const parent = folder ? parentOf(folder) : null;

  const navigate = (p: string) => {
    const clean = p.trim();
    if (!clean) return;
    setMsg(null);
    setPending(null);
    setDraft(clean);
    if (clean === folder) reload();
    else setFolder(clean);
  };

  const doRecycle = async () => {
    if (!pending) return;
    setRecycling(true);
    setMsg(null);
    try {
      const res = await runPowershell(recycleScript(pending.Path));
      if (!res.success || !res.stdout.includes('ok')) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      setMsg(t('disk.recycled', { name: pending.Name }));
      reload();
    } catch (e) {
      setMsg(`${t('disk.recycleFailed')} ${String(e)}`);
    } finally {
      setPending(null);
      setRecycling(false);
    }
  };

  const columns: Column<Entry>[] = [
    {
      key: 'Name',
      header: t('disk.name'),
      render: (r) =>
        r.IsDir ? (
          <button
            onClick={() => navigate(r.Path)}
            title={r.Path}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              textDecoration: 'underline',
              fontWeight: 600,
            }}
          >
            ▸ {r.Name}
          </button>
        ) : (
          <span title={r.Path}>{r.Name}</span>
        ),
    },
    {
      key: 'bar',
      header: t('disk.usage'),
      width: 200,
      render: (r) => (
        <div className="usage-bar">
          <div
            className="usage-fill"
            style={{ width: `${Math.max(1, Math.round((r.Size / maxSize) * 100))}%` }}
          />
        </div>
      ),
    },
    {
      key: 'Size',
      header: t('disk.size'),
      width: 100,
      align: 'right',
      render: (r) => humanSize(r.Size),
    },
    {
      key: 'pct',
      header: t('disk.pct'),
      width: 60,
      align: 'right',
      render: (r) => (totalBytes > 0 ? `${Math.round((r.Size * 100) / totalBytes)}%` : ''),
    },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (r) => (
        <button
          className="mini"
          disabled={recycling}
          onClick={() => {
            setMsg(null);
            setPending(r);
          }}
        >
          {t('disk.recycle')}
        </button>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" title={t('disk.up')} disabled={!parent} onClick={() => parent && navigate(parent)}>
          ↑ {t('disk.up')}
        </button>
        <input
          className="mod-search"
          placeholder={t('disk.pathPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(draft);
          }}
        />
        <select
          className="mod-select"
          value={mode}
          onChange={(e) => setMode(e.target.value === 'files' ? 'files' : 'folders')}
        >
          <option value="folders">{t('disk.byFolder')}</option>
          <option value="files">{t('disk.largestFiles')}</option>
        </select>
        <button className="mini primary" onClick={() => navigate(draft)}>
          {t('disk.analyse')}
        </button>
        <span className="count-note">
          {loading
            ? t('disk.analysing')
            : t('disk.summary', { items: rows.length, total: humanSize(totalBytes) })}
        </span>
      </ModuleToolbar>
      {(home || drives.length > 0) && (
        <ModuleToolbar>
          {home && (
            <button className="mini" title={home} onClick={() => navigate(home)}>
              {t('disk.home')}
            </button>
          )}
          {drives.map((d) => (
            <button
              key={d.Root}
              className="mini"
              title={t('disk.freeTip', { free: humanSize(d.Free), total: humanSize(d.Total) })}
              onClick={() => navigate(d.Root)}
            >
              {d.Root}
            </button>
          ))}
        </ModuleToolbar>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('disk.blurb')} {t('disk.slowNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      {pending && (
        <p className="mod-msg">
          {t('disk.confirmAsk', { name: pending.Name, size: humanSize(pending.Size) })}{' '}
          <button className="mini primary" disabled={recycling} onClick={doRecycle}>
            {t('disk.recycle')}
          </button>{' '}
          <button className="mini" disabled={recycling} onClick={() => setPending(null)}>
            {t('disk.cancel')}
          </button>
        </p>
      )}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.Path} empty={t('disk.emptyHint')} />
      </AsyncState>
    </div>
  );
}
