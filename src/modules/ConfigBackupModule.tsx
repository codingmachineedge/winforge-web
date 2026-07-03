import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Mirrors ConfigBackupService: snapshots live in %LOCALAPPDATA%\WinForge\snapshots as a git repo,
// two scheduled tasks drive daily/interval sync, and a fixed set of HKCU keys are the "touched" keys.
const SNAP_DIR = '$env:LOCALAPPDATA + "\\WinForge\\snapshots"';
const DAILY_TASK = 'WinForge Daily Backup';
const AUTOSYNC_TASK = 'WinForge Auto-Sync';

// HKCU registry keys the suite is known to touch (ConfigBackupService.TouchedRegistryKeys).
const TOUCHED_KEYS: { key: string; label: string }[] = [
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', label: 'Explorer Advanced' },
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband', label: 'Taskbar pins' },
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', label: 'Search' },
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', label: 'Personalize / dark mode' },
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', label: 'Advertising ID' },
  { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', label: 'Suggestions' },
  { key: 'HKCU:\\Control Panel\\Desktop', label: 'Desktop / wallpaper quality' },
  { key: 'HKCU:\\Control Panel\\Mouse', label: 'Mouse' },
  { key: 'HKCU:\\Control Panel\\Keyboard', label: 'Keyboard' },
  { key: 'HKCU:\\Software\\Microsoft\\Clipboard', label: 'Clipboard' },
  { key: 'HKCU:\\Environment', label: 'User environment variables' },
];

interface Snapshot {
  Hash: string;
  Short: string;
  Date: string;
  Subject: string;
}

interface Overview {
  GitAvailable: boolean;
  GitVersion: string;
  WingetAvailable: boolean;
  RepoExists: boolean;
  SnapshotCount: number;
  LastCommitDate: string;
  RepoSizeMb: number;
  DailyScheduled: boolean;
  AutoSyncScheduled: boolean;
  RemoteUrl: string;
}

interface RegRow {
  Label: string;
  Key: string;
  Present: boolean;
  Values: number;
}

/** Config & Backup · 設定與備份 — live view of the WinForge snapshot repo, touched registry keys,
 * scheduled backup tasks and the git/winget tooling, with safe snapshot + capture actions. */
export function ConfigBackupModule() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');

  // ── Overview: git/winget presence, repo state, scheduled tasks (one PowerShell probe). ──
  const overview = useAsync<Overview>(async () => {
    const script = `
$snap = ${SNAP_DIR}
$gitVer = ''
try { $gitVer = (& git --version) 2>$null } catch {}
$gitOk = -not [string]::IsNullOrWhiteSpace($gitVer) -and ($gitVer -match 'git')
$wingetOk = $false
try { $null = Get-Command winget.exe -ErrorAction Stop; $wingetOk = $true } catch {}
$repo = Test-Path (Join-Path $snap '.git')
$count = 0; $last = ''; $remote = ''; $sizeMb = 0.0
if ($gitOk -and $repo) {
  try { $count = @(& git -C $snap log --pretty=format:'%H' 2>$null).Count } catch {}
  try { $last = (& git -C $snap log -1 --date=iso --pretty=format:'%ad' 2>$null) } catch {}
  try { $remote = (& git -C $snap remote get-url origin 2>$null) } catch {}
}
if ($repo) {
  try { $sizeMb = [math]::Round((Get-ChildItem $snap -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1) } catch {}
}
function TaskOn($n) { try { $null = Get-ScheduledTask -TaskName $n -ErrorAction Stop; return $true } catch { return $false } }
[pscustomobject]@{
  GitAvailable = [bool]$gitOk
  GitVersion = ("$gitVer").Trim()
  WingetAvailable = [bool]$wingetOk
  RepoExists = [bool]$repo
  SnapshotCount = [int]$count
  LastCommitDate = ("$last").Trim()
  RepoSizeMb = [double]$sizeMb
  DailyScheduled = (TaskOn '${DAILY_TASK}')
  AutoSyncScheduled = (TaskOn '${AUTOSYNC_TASK}')
  RemoteUrl = ("$remote").Trim()
}`;
    const rows = await runPowershellJson<Overview>(script);
    return (
      rows[0] ?? {
        GitAvailable: false,
        GitVersion: '',
        WingetAvailable: false,
        RepoExists: false,
        SnapshotCount: 0,
        LastCommitDate: '',
        RepoSizeMb: 0,
        DailyScheduled: false,
        AutoSyncScheduled: false,
        RemoteUrl: '',
      }
    );
  }, []);

  // ── Snapshot history (git log of the snapshot repo). ──
  const snaps = useAsync<Snapshot[]>(async () => {
    const script = `
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { return }
$log = @(& git -C $snap log --pretty=format:'%H%x09%ad%x09%s' --date=iso 2>$null)
$log | Where-Object { $_ } | ForEach-Object {
  $p = $_ -split "\`t", 3
  [pscustomobject]@{
    Hash = $p[0]
    Short = $(if ($p[0].Length -ge 7) { $p[0].Substring(0,7) } else { $p[0] })
    Date = $(if ($p.Count -gt 1) { $p[1] } else { '' })
    Subject = $(if ($p.Count -gt 2) { $p[2] } else { '' })
  }
}`;
    return runPowershellJson<Snapshot>(script);
  }, []);

  // ── Touched registry keys — which exist and how many values they hold (read-only). ──
  const reg = useAsync<RegRow[]>(async () => {
    const items = TOUCHED_KEYS.map(
      (k) =>
        `@{L='${k.label}';K='${k.key.replace(/'/g, "''")}'}`,
    ).join(',');
    const script = `
$defs = @(${items})
foreach ($d in $defs) {
  $present = Test-Path -LiteralPath $d.K
  $vals = 0
  if ($present) { try { $vals = ((Get-Item -LiteralPath $d.K).GetValueNames()).Count } catch {} }
  [pscustomobject]@{ Label = $d.L; Key = $d.K; Present = [bool]$present; Values = [int]$vals }
}`;
    return runPowershellJson<RegRow>(script);
  }, []);

  const reloadAll = () => {
    overview.reload();
    snaps.reload();
    reg.reload();
  };

  const ov = overview.data;

  // ── Actions (all read/append-only; nothing destructive runs without confirm). ──
  const takeSnapshot = async () => {
    setBusy('snapshot');
    setMsg(null);
    try {
      const safeNote = note.trim().replace(/"/g, "'");
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const commitMsg = safeNote ? `${stamp} — ${safeNote}` : stamp;
      const script = `
$snap = ${SNAP_DIR}
New-Item -ItemType Directory -Force -Path $snap | Out-Null
if (-not (Test-Path (Join-Path $snap '.git'))) {
  & git -C $snap init | Out-Null
  & git -C $snap config user.name WinForge | Out-Null
  & git -C $snap config user.email winforge@localhost | Out-Null
}
$src = Join-Path ($env:LOCALAPPDATA + "\\WinForge") 'settings.json'
if (Test-Path $src) { Copy-Item $src (Join-Path $snap 'settings.json') -Force }
elseif (-not (Test-Path (Join-Path $snap 'settings.json'))) { '{}' | Set-Content (Join-Path $snap 'settings.json') }
& git -C $snap add -A | Out-Null
$out = & git -C $snap commit -m "${commitMsg}" 2>&1
if ($LASTEXITCODE -ne 0 -and "$out" -match 'nothing to commit') { 'NOCHANGE' }
elseif ($LASTEXITCODE -ne 0) { throw "$out" }
else { 'OK' }`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      setMsg(
        res.stdout.includes('NOCHANGE')
          ? t('configbackup.snapNoChange')
          : t('configbackup.snapDone'),
      );
      setNote('');
      snaps.reload();
      overview.reload();
    } catch (e) {
      setMsg(`${t('configbackup.snapFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const verifyIntegrity = async () => {
    setBusy('verify');
    setMsg(null);
    try {
      const script = `
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else { & git -C $snap fsck --full 2>&1; if ($LASTEXITCODE -ne 0) { throw 'fsck reported problems' } else { 'OK' } }`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim());
      setMsg(res.stdout.includes('NOREPO') ? t('configbackup.noRepo') : t('configbackup.verifyOk'));
    } catch (e) {
      setMsg(`${t('configbackup.verifyFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const captureWinget = async () => {
    setBusy('winget');
    setMsg(null);
    try {
      const dest = `$env:LOCALAPPDATA + "\\WinForge\\apps.json"`;
      const script = `
$dest = ${dest}
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
$out = & winget export -o "$dest" --include-versions --accept-source-agreements 2>&1
if ($LASTEXITCODE -ne 0) { throw "$out" }
"$dest"`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim());
      setMsg(t('configbackup.wingetDone', { path: res.stdout.trim() }));
    } catch (e) {
      setMsg(`${t('configbackup.wingetFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const exportRegistry = async () => {
    setBusy('reg');
    setMsg(null);
    try {
      const keysPs = TOUCHED_KEYS.map((k) => {
        // reg.exe wants HKCU\... not HKCU:\...
        const regKey = k.key.replace('HKCU:\\', 'HKCU\\');
        return `'${regKey.replace(/'/g, "''")}'`;
      }).join(',');
      const script = `
$dest = $env:LOCALAPPDATA + "\\WinForge\\winforge-registry.reg"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
$keys = @(${keysPs})
"Windows Registry Editor Version 5.00" | Set-Content -Encoding UTF8 $dest
"" | Add-Content $dest
$n = 0
foreach ($k in $keys) {
  $tmp = Join-Path $env:TEMP ("wf_reg_" + [guid]::NewGuid().ToString('N') + ".reg")
  & reg.exe export "$k" "$tmp" /y | Out-Null
  if ((Test-Path $tmp)) {
    $body = Get-Content -Raw $tmp
    $lines = ($body -split "\`n") | Where-Object { $_ -notmatch '^Windows Registry Editor' -and $_.Trim() -ne '' }
    "; --- $k ---" | Add-Content $dest
    ($lines -join "\`n").TrimEnd() | Add-Content $dest
    "" | Add-Content $dest
    $n++
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}
"EXPORTED $n TO $dest"`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim());
      setMsg(t('configbackup.regDone', { text: res.stdout.trim() }));
    } catch (e) {
      setMsg(`${t('configbackup.regFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // Destructive-ish: prune rewrites git history / gc. Gate behind confirm.
  const pruneHistory = async () => {
    if (!window.confirm(t('configbackup.pruneConfirm'))) return;
    setBusy('prune');
    setMsg(null);
    try {
      const script = `
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else {
  & git -C $snap reflog expire --expire=now --all 2>&1 | Out-Null
  & git -C $snap gc --prune=now --aggressive 2>&1 | Out-Null
  'OK'
}`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim());
      setMsg(res.stdout.includes('NOREPO') ? t('configbackup.noRepo') : t('configbackup.pruneDone'));
      overview.reload();
    } catch (e) {
      setMsg(`${t('configbackup.pruneFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const openSnapshotsFolder = async () => {
    setBusy('open');
    setMsg(null);
    try {
      const res = await runPowershell(
        `$p = ${SNAP_DIR}; New-Item -ItemType Directory -Force -Path $p | Out-Null; "$p"`,
      );
      const dir = res.stdout.trim();
      if (dir) await runCommand('explorer.exe', [dir]);
      setMsg(t('configbackup.openedFolder', { path: dir }));
    } catch (e) {
      setMsg(`${t('configbackup.openFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const snapColumns: Column<Snapshot>[] = [
    {
      key: 'Short',
      header: t('configbackup.colHash'),
      width: 90,
      render: (s) => <code>{s.Short}</code>,
    },
    { key: 'Subject', header: t('configbackup.colSubject') },
    { key: 'Date', header: t('configbackup.colDate'), width: 200 },
  ];

  const regColumns: Column<RegRow>[] = [
    {
      key: 'Present',
      header: t('configbackup.colState'),
      width: 100,
      render: (r) => (
        <StatusDot ok={r.Present} label={r.Present ? t('configbackup.present') : t('configbackup.absent')} />
      ),
    },
    { key: 'Label', header: t('configbackup.colLabel'), width: 220 },
    { key: 'Key', header: t('configbackup.colKey') },
    {
      key: 'Values',
      header: t('configbackup.colValues'),
      width: 90,
      align: 'right',
      render: (r) => (r.Present ? String(r.Values) : '—'),
    },
  ];

  const snapRows = useMemo(() => snaps.data ?? [], [snaps.data]);

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" disabled={busy !== null} onClick={openSnapshotsFolder}>
          {t('configbackup.openFolder')}
        </button>
        <span className="count-note">{t('configbackup.blurb')}</span>
      </ModuleToolbar>

      {msg && <p className="mod-msg">{msg}</p>}

      {/* ── Environment / status summary ── */}
      <AsyncState loading={overview.loading} error={overview.error}>
        {ov && (
          <div className="mod-status-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
            <StatusDot
              ok={ov.GitAvailable}
              label={ov.GitAvailable ? ov.GitVersion || t('configbackup.gitOk') : t('configbackup.gitMissing')}
            />
            <StatusDot
              ok={ov.WingetAvailable}
              label={ov.WingetAvailable ? t('configbackup.wingetOk') : t('configbackup.wingetMissing')}
            />
            <StatusDot
              ok={ov.RepoExists}
              label={
                ov.RepoExists
                  ? t('configbackup.repoReady', { snaps: ov.SnapshotCount, mb: ov.RepoSizeMb })
                  : t('configbackup.repoNone')
              }
            />
            <StatusDot
              ok={ov.DailyScheduled}
              label={ov.DailyScheduled ? t('configbackup.dailyOn') : t('configbackup.dailyOff')}
            />
            <StatusDot
              ok={ov.AutoSyncScheduled}
              label={ov.AutoSyncScheduled ? t('configbackup.autosyncOn') : t('configbackup.autosyncOff')}
            />
            {ov.LastCommitDate && (
              <span className="count-note">{t('configbackup.lastSnap', { date: ov.LastCommitDate })}</span>
            )}
            {ov.RemoteUrl && (
              <span className="count-note">{t('configbackup.remote', { url: ov.RemoteUrl })}</span>
            )}
          </div>
        )}
      </AsyncState>

      {/* ── Snapshot actions ── */}
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <input
          className="mod-search"
          placeholder={t('configbackup.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="mini primary" disabled={busy !== null} onClick={takeSnapshot}>
          {t('configbackup.takeSnapshot')}
        </button>
        <button className="mini" disabled={busy !== null} onClick={verifyIntegrity}>
          {t('configbackup.verify')}
        </button>
        <button className="mini" disabled={busy !== null} onClick={pruneHistory}>
          {t('configbackup.prune')}
        </button>
        <button className="mini" disabled={busy !== null || ov?.WingetAvailable === false} onClick={captureWinget}>
          {t('configbackup.captureWinget')}
        </button>
        <button className="mini" disabled={busy !== null} onClick={exportRegistry}>
          {t('configbackup.exportReg')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.snapNote')}
      </p>

      {/* ── Snapshot history table ── */}
      <h4 style={{ margin: '10px 0 6px' }}>{t('configbackup.historyTitle')}</h4>
      <AsyncState loading={snaps.loading} error={snaps.error}>
        <DataTable
          columns={snapColumns}
          rows={snapRows}
          rowKey={(s) => s.Hash}
          empty={t('configbackup.noSnaps')}
        />
      </AsyncState>

      {/* ── Touched registry keys table ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.regTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.regNote')}
      </p>
      <AsyncState loading={reg.loading} error={reg.error}>
        <DataTable columns={regColumns} rows={reg.data ?? []} rowKey={(r) => r.Key} />
      </AsyncState>
    </div>
  );
}
