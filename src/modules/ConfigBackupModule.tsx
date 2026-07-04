import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Mirrors ConfigBackupService: snapshots live in %LOCALAPPDATA%\WinForge\snapshots as a git repo,
// two scheduled tasks drive daily/interval sync, and a fixed set of HKCU keys are the "touched" keys.
const SNAP_DIR = '$env:LOCALAPPDATA + "\\WinForge\\snapshots"';
const DAILY_TASK = 'WinForge Daily Backup';
const AUTOSYNC_TASK = 'WinForge Auto-Sync';

// AI Agent API-key env vars gathered into the encrypted secrets blob (AiAgentService.All catalog).
const AI_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

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

// Known app/config locations — the file catalog (dotfiles, VS Code, Windows Terminal, PowerShell
// profiles, git, SSH, hosts) plus the HKCU\Environment pseudo-item. `ps` is a PowerShell expression
// evaluated host-side so env vars resolve on the target machine.
interface CatalogDef {
  id: string;
  label: string;
  ps: string;
  file: boolean;
}
const CONFIG_CATALOG: CatalogDef[] = [
  { id: 'winforge', label: 'WinForge settings.json', ps: "(Join-Path $env:LOCALAPPDATA 'WinForge\\settings.json')", file: true },
  { id: 'vscode', label: 'VS Code settings.json', ps: "(Join-Path $env:APPDATA 'Code\\User\\settings.json')", file: true },
  { id: 'vscodekeys', label: 'VS Code keybindings.json', ps: "(Join-Path $env:APPDATA 'Code\\User\\keybindings.json')", file: true },
  { id: 'terminal', label: 'Windows Terminal settings', ps: "(Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json')", file: true },
  { id: 'ps5profile', label: 'PowerShell 5.1 profile', ps: "(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\\Microsoft.PowerShell_profile.ps1')", file: true },
  { id: 'ps7profile', label: 'PowerShell 7 profile', ps: "(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell\\Microsoft.PowerShell_profile.ps1')", file: true },
  { id: 'gitconfig', label: 'Git config (.gitconfig)', ps: "(Join-Path $env:USERPROFILE '.gitconfig')", file: true },
  { id: 'sshconfig', label: 'SSH config', ps: "(Join-Path $env:USERPROFILE '.ssh\\config')", file: true },
  { id: 'sshknown', label: 'SSH known_hosts', ps: "(Join-Path $env:USERPROFILE '.ssh\\known_hosts')", file: true },
  { id: 'bashrc', label: 'Dotfile .bashrc', ps: "(Join-Path $env:USERPROFILE '.bashrc')", file: true },
  { id: 'npmrc', label: 'Dotfile .npmrc', ps: "(Join-Path $env:USERPROFILE '.npmrc')", file: true },
  { id: 'hosts', label: 'Hosts file', ps: "(Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts')", file: true },
  { id: 'userenv', label: 'User environment variables', ps: "'HKCU:\\Environment'", file: false },
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

interface CatRow {
  Id: string;
  Path: string;
  Present: boolean;
  SizeKb: number;
  Modified: string;
  Info: string;
}

interface HistRow {
  Name: string;
  Path: string;
  SizeKb: number;
  Modified: string;
  IsZip: boolean;
}

interface ZipEntryRow {
  Name: string;
  Size: number;
  Modified: string;
}

interface BundleInfo {
  Ok: boolean;
  Version: string;
  Created: string;
  Machine: string;
  HasSettings: boolean;
  HasSecrets: boolean;
  SecretCount: number;
  Error: string;
}

const EMPTY_OVERVIEW: Overview = {
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
};

// ── small helpers ─────────────────────────────────────────────────────────────

/** Escape a JS string for embedding inside a PowerShell single-quoted literal. */
const psq = (s: string) => s.replace(/'/g, "''");

const lsGet = (key: string, fallback: string): string => {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const lsSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
};

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
};

// SecretsCrypto-compatible blob: [4 magic "WFS1"][1 ver=1][16 salt][12 nonce][16 tag][ciphertext],
// AES-256-GCM under PBKDF2-HMAC-SHA256 (210,000 iterations). Same format as the C# engine, so
// bundles are interchangeable between machines. MinPasswordLength = 4 (SecretsCrypto).
const WFS_ITER = 210000;
const WFS_MIN_PWD = 4;

async function wfsDeriveKey(password: string, salt: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: WFS_ITER, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

async function wfsEncrypt(plaintext: string, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await wfsDeriveKey(password, salt, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  // WebCrypto appends the 16-byte tag to the ciphertext; the WFS1 layout stores tag BEFORE cipher.
  const tag = ct.slice(ct.length - 16);
  const cipher = ct.slice(0, ct.length - 16);
  const out = new Uint8Array(4 + 1 + 16 + 12 + 16 + cipher.length);
  out.set([0x57, 0x46, 0x53, 0x31], 0); // "WFS1"
  out[4] = 1;
  out.set(salt, 5);
  out.set(nonce, 21);
  out.set(tag, 33);
  out.set(cipher, 49);
  return out;
}

async function wfsDecrypt(blob: Uint8Array, password: string): Promise<string> {
  if (blob.length < 49 || blob[0] !== 0x57 || blob[1] !== 0x46 || blob[2] !== 0x53 || blob[3] !== 0x31) {
    throw new Error('Not a WinForge secrets blob.');
  }
  if (blob[4] !== 1) throw new Error('Unsupported secrets format version.');
  const salt = blob.slice(5, 21);
  const nonce = blob.slice(21, 33);
  const tag = blob.slice(33, 49);
  const cipher = blob.slice(49);
  const key = await wfsDeriveKey(password, salt, ['decrypt']);
  const joined = new Uint8Array(cipher.length + 16);
  joined.set(cipher);
  joined.set(tag, cipher.length);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 },
    key,
    joined as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Backup folder PS expression: user-chosen path or Documents\WinForge-Backups. */
const dirExpr = (dir: string) =>
  dir.trim() ? `'${psq(dir.trim())}'` : "(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WinForge-Backups')";

// The headless snapshot runner registered with schtasks — self-contained, so scheduled backups
// keep working while the app is closed (same task names as the C# engine).
const RUNNER_LINES = [
  "$snap = Join-Path $env:LOCALAPPDATA 'WinForge\\snapshots'",
  'New-Item -ItemType Directory -Force -Path $snap | Out-Null',
  "if (-not (Test-Path (Join-Path $snap '.git'))) {",
  '  git -C $snap init | Out-Null',
  '  git -C $snap config user.name WinForge | Out-Null',
  '  git -C $snap config user.email winforge@localhost | Out-Null',
  '}',
  "$src = Join-Path $env:LOCALAPPDATA 'WinForge\\settings.json'",
  "if (Test-Path $src) { Copy-Item $src (Join-Path $snap 'settings.json') -Force }",
  'git -C $snap add -A | Out-Null',
  "git -C $snap commit -m ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' - scheduled') | Out-Null",
];

// Emitted as a PS string-array (not a here-string) so LF-only line endings can never break
// the terminator parsing under Windows PowerShell 5.1's -Command mode.
const RUNNER_SETUP = `$appDir = Join-Path $env:LOCALAPPDATA 'WinForge'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$runner = Join-Path $appDir 'autosnapshot.ps1'
$rl = @(${RUNNER_LINES.map((l) => `'${l.replace(/'/g, "''")}'`).join(',')})
($rl -join [Environment]::NewLine) | Set-Content -Encoding UTF8 $runner
$tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"'`;

/** Core snapshot commit script — shared by take/sync/restore-safety. Ends with OK | NOCHANGE. */
const snapshotCore = (commitMsg: string, withWinget: boolean) => `
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
${withWinget ? `try { $null = Get-Command winget.exe -ErrorAction Stop; & winget export -o (Join-Path $snap 'apps.json') --include-versions --accept-source-agreements 2>&1 | Out-Null } catch {}` : ''}
& git -C $snap add -A | Out-Null
$out = & git -C $snap commit -m '${psq(commitMsg)}' 2>&1
if ($LASTEXITCODE -ne 0 -and "$out" -match 'nothing to commit') { 'NOCHANGE' }
elseif ($LASTEXITCODE -ne 0) { throw "$out" }
else { 'OK' }`;

const nowStamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

type SyncUnit = 'minute' | 'hour' | 'day';
const UNIT_MS: Record<SyncUnit, number> = { minute: 60000, hour: 3600000, day: 86400000 };

/** Config & Backup · 設定與備份 — full-surface port of the WinForge module: portable settings
 * bundle (optional AES-256-GCM encrypted secrets), local git snapshot history with restore/diff/
 * verify/prune/bundle, capture & export (registry / winget / taskbar+Start), a catalog of known
 * config locations with selective zip backup + restore preview + gated restore + diff-vs-backup,
 * backup history, interval auto-sync with optional remote push, schtasks daily/interval schedules,
 * robocopy mirroring and a copyable output pane. */
export function ConfigBackupModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [output, setOutput] = useState('');

  // Backup folder + selection for the config-file catalog.
  const [backupDir, setBackupDir] = useState(() => lsGet('backup.dir', ''));
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [diffZip, setDiffZip] = useState('');
  const [preview, setPreview] = useState<{ name: string; rows: ZipEntryRow[] } | null>(null);

  // Portable bundle (secrets) state.
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [secApi, setSecApi] = useState(true);
  const [secSettings, setSecSettings] = useState(true);
  const [secEnv, setSecEnv] = useState(true);
  const [secSsh, setSecSsh] = useState(false);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importPwd, setImportPwd] = useState('');
  const [importInfo, setImportInfo] = useState<BundleInfo | null>(null);

  // Auto-sync schedule state (persisted like the C# SettingsStore keys).
  const [syncEnabled, setSyncEnabled] = useState(() => lsGet('backup.autosync.enabled', 'false') === 'true');
  const [syncCount, setSyncCount] = useState(() => {
    const n = parseInt(lsGet('backup.autosync.count', '15'), 10);
    return Number.isFinite(n) && n >= 1 ? n : 15;
  });
  const [syncUnit, setSyncUnit] = useState<SyncUnit>(() => {
    const u = lsGet('backup.autosync.unit', 'minute');
    return u === 'hour' || u === 'day' ? u : 'minute';
  });
  const [remoteUrl, setRemoteUrl] = useState(() => lsGet('backup.autosync.remote', ''));
  const [lastRun, setLastRun] = useState(() => lsGet('backup.autosync.lastrun', ''));

  // Daily schedule + mirror.
  const [timeStr, setTimeStr] = useState('03:00');
  const [mirrorDest, setMirrorDest] = useState('');

  // ── Overview: git/winget presence, repo state, scheduled tasks (one PowerShell probe). ──
  const overview = useAsync<Overview>(async () => {
    if (!desktop) return EMPTY_OVERVIEW;
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
    return rows[0] ?? EMPTY_OVERVIEW;
  }, [desktop]);

  // ── Snapshot history (git log of the snapshot repo). ──
  const snaps = useAsync<Snapshot[]>(async () => {
    if (!desktop) return [];
    const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
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
  }, [desktop]);

  // ── Touched registry keys — which exist and how many values they hold (read-only). ──
  const reg = useAsync<RegRow[]>(async () => {
    if (!desktop) return [];
    const items = TOUCHED_KEYS.map((k) => `@{L='${k.label}';K='${k.key.replace(/'/g, "''")}'}`).join(',');
    const script = `
$defs = @(${items})
foreach ($d in $defs) {
  $present = Test-Path -LiteralPath $d.K
  $vals = 0
  if ($present) { try { $vals = ((Get-Item -LiteralPath $d.K).GetValueNames()).Count } catch {} }
  [pscustomobject]@{ Label = $d.L; Key = $d.K; Present = [bool]$present; Values = [int]$vals }
}`;
    return runPowershellJson<RegRow>(script);
  }, [desktop]);

  // ── Config-file catalog probe: existence / size / modified per known location. ──
  const catalog = useAsync<CatRow[]>(async () => {
    if (!desktop) return [];
    const defs = CONFIG_CATALOG.filter((c) => c.file)
      .map((c) => `@{I='${c.id}';P=${c.ps}}`)
      .join(',');
    const script = `
$defs = @(${defs})
foreach ($d in $defs) {
  $p = $d.P
  $present = Test-Path -LiteralPath $p
  $kb = 0.0; $mod = ''
  if ($present) {
    try { $fi = Get-Item -LiteralPath $p -Force; $kb = [math]::Round($fi.Length / 1KB, 1); $mod = $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm') } catch {}
  }
  [pscustomobject]@{ Id = $d.I; Path = "$p"; Present = [bool]$present; SizeKb = [double]$kb; Modified = $mod; Info = '' }
}
$vals = 0
try { $vals = @((Get-Item 'HKCU:\\Environment').GetValueNames()).Count } catch {}
[pscustomobject]@{ Id = 'userenv'; Path = 'HKCU:\\Environment'; Present = $true; SizeKb = 0.0; Modified = ''; Info = "$vals" }`;
    return runPowershellJson<CatRow>(script);
  }, [desktop]);

  // ── Backup history: zips + git bundles inside the backup folder. ──
  const history = useAsync<HistRow[]>(async () => {
    if (!desktop) return [];
    const script = `
$dir = ${dirExpr(backupDir)}
if (Test-Path -LiteralPath $dir) {
  Get-ChildItem -Path (Join-Path $dir '*') -Include *.zip,*.bundle -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object {
      [pscustomobject]@{
        Name = $_.Name
        Path = $_.FullName
        SizeKb = [math]::Round($_.Length / 1KB, 1)
        Modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
        IsZip = ($_.Extension -eq '.zip')
      }
    }
}`;
    return runPowershellJson<HistRow>(script);
  }, [desktop, backupDir]);

  const reloadAll = () => {
    overview.reload();
    snaps.reload();
    reg.reload();
    catalog.reload();
    history.reload();
  };

  const ov = overview.data;
  const snapRows = useMemo(() => snaps.data ?? [], [snaps.data]);
  const catRows = useMemo(() => catalog.data ?? [], [catalog.data]);
  const histRows = useMemo(() => history.data ?? [], [history.data]);

  const isSel = (row: CatRow) => sel[row.Id] ?? row.Present;
  const toggleSel = (id: string, present: boolean) => setSel((s) => ({ ...s, [id]: !(s[id] ?? present) }));

  // ── plumbing: run PowerShell, throw on failure, return stdout. ──
  const ps = async (script: string): Promise<string> => {
    const res = await runPowershell(script);
    if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    return res.stdout;
  };

  /** Wrap a gated action: busy key, cleared message, error prefix from `failKey`. */
  const act = async (key: string, failKey: string, fn: () => Promise<void>) => {
    if (!desktop || busy !== null) return;
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(`${t(failKey)}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Write bytes (as base64) to a host file, chunking to stay under the command-line limit. */
  const writeB64File = async (psPathExpr: string, b64: string) => {
    const CHUNK = 12000;
    if (b64.length <= CHUNK) {
      await ps(`[IO.File]::WriteAllBytes(${psPathExpr}, [Convert]::FromBase64String('${b64}')); 'OK'`);
      return;
    }
    const tmp = "(Join-Path $env:TEMP 'winforge_cb_payload.b64')";
    await ps(`Set-Content -LiteralPath ${tmp} -Value '' -NoNewline -Encoding Ascii; 'OK'`);
    for (let i = 0; i < b64.length; i += CHUNK) {
      await ps(`Add-Content -LiteralPath ${tmp} -Value '${b64.slice(i, i + CHUNK)}' -NoNewline -Encoding Ascii; 'OK'`);
    }
    await ps(
      `[IO.File]::WriteAllBytes(${psPathExpr}, [Convert]::FromBase64String((Get-Content -Raw -LiteralPath ${tmp}))); Remove-Item ${tmp} -Force; 'OK'`,
    );
  };

  // ── snapshots ──
  const takeSnapshot = () =>
    act('snapshot', 'configbackup.snapFailed', async () => {
      const safeNote = note.trim();
      const commitMsg = safeNote ? `${nowStamp()} — ${safeNote}` : nowStamp();
      const out = await ps(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${snapshotCore(commitMsg, true)}`);
      setMsg(out.includes('NOCHANGE') ? t('configbackup.snapNoChange') : t('configbackup.snapDone'));
      setNote('');
      snaps.reload();
      overview.reload();
    });

  const verifyIntegrity = () =>
    act('verify', 'configbackup.verifyFailed', async () => {
      const script = `
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else { $o = & git -C $snap fsck --full 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { throw "$o" } else { "$o"; 'OKV' } }`;
      const out = await ps(script);
      if (out.includes('NOREPO')) setMsg(t('configbackup.noRepo'));
      else {
        setOutput(`git fsck:\n${out.replace('OKV', '').trim() || '(no problems reported)'}`);
        setMsg(t('configbackup.verifyOk'));
      }
    });

  const pruneHistory = () => {
    if (!window.confirm(t('configbackup.pruneConfirm'))) return;
    void act('prune', 'configbackup.pruneFailed', async () => {
      const script = `
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else {
  & git -C $snap reflog expire --expire=now --all 2>&1 | Out-Null
  & git -C $snap gc --prune=now --aggressive 2>&1 | Out-Null
  'OK'
}`;
      const out = await ps(script);
      setMsg(out.includes('NOREPO') ? t('configbackup.noRepo') : t('configbackup.pruneDone'));
      overview.reload();
    });
  };

  const restoreSnapshot = (snap: Snapshot) => {
    if (!/^[0-9a-f]{7,40}$/i.test(snap.Hash)) return;
    if (!window.confirm(t('configbackup.restoreSnapConfirm', { hash: snap.Short }))) return;
    void act('restoreSnap', 'configbackup.restoreSnapFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${snapshotCore(`${nowStamp()} — auto: before restore`, false)}
& git -C $snap checkout ${snap.Hash} -- .
if ($LASTEXITCODE -ne 0) { throw 'git restore failed' }
$live = Join-Path ($env:LOCALAPPDATA + "\\WinForge") 'settings.json'
$n = 0
$ss = Join-Path $snap 'settings.json'
if (Test-Path $ss) {
  New-Item -ItemType Directory -Force -Path (Split-Path $live) | Out-Null
  Copy-Item $ss $live -Force
  try { $n = @((Get-Content -Raw $live | ConvertFrom-Json).PSObject.Properties).Count } catch {}
}
"RESTORED $n"`;
      const out = await ps(script);
      const m = /RESTORED (\d+)/.exec(out);
      setMsg(t('configbackup.restoreSnapDone', { hash: snap.Short, n: m?.[1] ?? '0' }));
      snaps.reload();
      overview.reload();
      catalog.reload();
    });
  };

  const diffSnapshot = (snap: Snapshot) => {
    if (!/^[0-9a-f]{7,40}$/i.test(snap.Hash)) return;
    void act('diffSnap', 'configbackup.diffFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else {
  $src = Join-Path ($env:LOCALAPPDATA + "\\WinForge") 'settings.json'
  if (Test-Path $src) { Copy-Item $src (Join-Path $snap 'settings.json') -Force }
  $d = & git -C $snap diff ${snap.Hash} -- settings.json 2>&1 | Out-String
  if ([string]::IsNullOrWhiteSpace($d)) { 'NODIFF' } else { "$d" }
}`;
      const out = await ps(script);
      if (out.includes('NOREPO')) setMsg(t('configbackup.noRepo'));
      else if (out.includes('NODIFF')) setMsg(t('configbackup.diffNone'));
      else {
        setOutput(out.trim());
        setMsg(t('configbackup.diffDone'));
      }
    });
  };

  const saveBundleFile = () =>
    act('gitbundle', 'configbackup.bundleFileFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$snap = ${SNAP_DIR}
if (-not (Test-Path (Join-Path $snap '.git'))) { 'NOREPO' }
else {
  $dest = ${dirExpr(backupDir)}
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $bp = Join-Path $dest ('winforge-config-' + (Get-Date -Format 'yyyyMMdd') + '.bundle')
  if (Test-Path $bp) { Remove-Item $bp -Force }
  $out = & git -C $snap bundle create $bp --all 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "$out" }
  "BUNDLE $bp"
}`;
      const out = await ps(script);
      if (out.includes('NOREPO')) setMsg(t('configbackup.noRepo'));
      else {
        const m = /BUNDLE (.+)/.exec(out);
        setMsg(t('configbackup.bundleFileDone', { path: (m?.[1] ?? '').trim() }));
        history.reload();
      }
    });

  // ── capture & export ──
  const captureWinget = () =>
    act('winget', 'configbackup.wingetFailed', async () => {
      const script = `
$dest = ${dirExpr(backupDir)}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$file = Join-Path $dest ('apps-' + (Get-Date -Format 'yyyyMMdd') + '.json')
$out = & winget export -o "$file" --include-versions --accept-source-agreements 2>&1
if ($LASTEXITCODE -ne 0) { throw "$out" }
"$file"`;
      const out = await ps(script);
      setMsg(t('configbackup.wingetDone', { path: out.trim() }));
    });

  const exportRegistry = () =>
    act('reg', 'configbackup.regFailed', async () => {
      const keysPs = TOUCHED_KEYS.map((k) => `'${k.key.replace('HKCU:\\', 'HKCU\\').replace(/'/g, "''")}'`).join(',');
      const script = `
$dest = ${dirExpr(backupDir)}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$file = Join-Path $dest ('winforge-registry-' + (Get-Date -Format 'yyyyMMdd') + '.reg')
$keys = @(${keysPs})
"Windows Registry Editor Version 5.00" | Set-Content -Encoding UTF8 $file
"" | Add-Content $file
$n = 0
foreach ($k in $keys) {
  $tmp = Join-Path $env:TEMP ("wf_reg_" + [guid]::NewGuid().ToString('N') + ".reg")
  & reg.exe export "$k" "$tmp" /y | Out-Null
  if ((Test-Path $tmp)) {
    $body = Get-Content -Raw $tmp
    $lines = ($body -split "\`n") | Where-Object { $_ -notmatch '^Windows Registry Editor' -and $_.Trim() -ne '' }
    "; --- $k ---" | Add-Content $file
    ($lines -join "\`n").TrimEnd() | Add-Content $file
    "" | Add-Content $file
    $n++
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}
"EXPORTED $n TO $file"`;
      const out = await ps(script);
      setMsg(t('configbackup.regDone', { text: out.trim() }));
      history.reload();
    });

  const backupTaskbar = () =>
    act('taskbar', 'configbackup.taskbarFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = ${dirExpr(backupDir)}
$dest = Join-Path $root ('taskbar-start-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$lines = @()
$reg = Join-Path $dest 'taskband.reg'
$null = & reg.exe export "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband" "$reg" /y 2>&1
$lines += $(if ($LASTEXITCODE -eq 0) { 'Taskbar pins (Taskband) exported.' } else { 'Taskband export failed.' })
$start2 = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\LocalState\\start2.bin'
if (Test-Path $start2) { Copy-Item $start2 (Join-Path $dest 'start2.bin') -Force; $lines += 'Start layout (start2.bin) copied - reference only (no supported import on Win11).' }
else { $lines += 'start2.bin not found (Start layout not captured).' }
($lines -join "\`n")
"DEST $dest"`;
      const out = await ps(script);
      const m = /DEST (.+)/.exec(out);
      setOutput(out.replace(/DEST .+/, '').trim());
      setMsg(t('configbackup.taskbarDone', { path: (m?.[1] ?? '').trim() }));
    });

  // ── catalog: selective zip backup / preview / restore / diff ──
  const backupSelected = () =>
    act('backup', 'configbackup.backupFailed', async () => {
      const chosen = CONFIG_CATALOG.filter((c) => {
        const row = catRows.find((r) => r.Id === c.id);
        return row ? isSel(row) && (row.Present || !c.file) : false;
      });
      const files = chosen.filter((c) => c.file);
      const withEnv = chosen.some((c) => c.id === 'userenv');
      if (files.length === 0 && !withEnv) {
        setMsg(t('configbackup.backupEmpty'));
        return;
      }
      const copies = files
        .map(
          (c) => `
$p = ${c.ps}
if (Test-Path -LiteralPath $p) {
  Copy-Item -LiteralPath $p (Join-Path $stage ('${c.id}__' + (Split-Path $p -Leaf))) -Force
  $map += [pscustomobject]@{ id = '${c.id}'; entry = ('${c.id}__' + (Split-Path $p -Leaf)); path = "$p" }
}`,
        )
        .join('');
      const envPart = withEnv
        ? `
$ue = [Environment]::GetEnvironmentVariables('User')
$em = @{}
foreach ($k in $ue.Keys) { $em["$k"] = [string]$ue[$k] }
$em | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $stage 'userenv__user-environment.json')
$map += [pscustomobject]@{ id = 'userenv'; entry = 'userenv__user-environment.json'; path = 'HKCU:\\Environment' }`
        : '';
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dest = ${dirExpr(backupDir)}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$stage = Join-Path $env:TEMP ('wfcb_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$map = @()
${copies}
${envPart}
if ($map.Count -eq 0) { 'EMPTY' }
else {
  [pscustomobject]@{ app = 'WinForge'; kind = 'config-files'; created = (Get-Date).ToString('o'); machine = $env:COMPUTERNAME; items = $map } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $stage 'backup-manifest.json')
  $zip = Join-Path $dest ('WinForge-config-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
  'SAVED ' + $map.Count + ' -> ' + $zip
}
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue`;
      const out = await ps(script);
      if (out.includes('EMPTY')) setMsg(t('configbackup.backupEmpty'));
      else {
        const m = /SAVED (\d+) -> (.+)/.exec(out);
        setMsg(t('configbackup.backupSaved', { n: m?.[1] ?? '?', path: (m?.[2] ?? '').trim() }));
        history.reload();
      }
    });

  const previewZip = (row: HistRow) =>
    act('preview', 'configbackup.previewFailed', async () => {
      const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${psq(row.Path)}')
try {
  $z.Entries | ForEach-Object {
    [pscustomobject]@{ Name = $_.FullName; Size = [long]$_.Length; Modified = $_.LastWriteTime.DateTime.ToString('yyyy-MM-dd HH:mm') }
  }
} finally { $z.Dispose() }`;
      const rows = await runPowershellJson<ZipEntryRow>(script);
      setPreview({ name: row.Name, rows });
    });

  const restoreZip = (row: HistRow) => {
    if (!window.confirm(t('configbackup.restoreConfirm', { name: row.Name }))) return;
    void act('restoreZip', 'configbackup.restoreFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$zip = '${psq(row.Path)}'
$stage = Join-Path $env:TEMP ('wfrs_' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
$manifest = Join-Path $stage 'backup-manifest.json'
$lines = @()
if (Test-Path $manifest) {
  $m = Get-Content -Raw $manifest | ConvertFrom-Json
  foreach ($it in @($m.items)) {
    $src = Join-Path $stage $it.entry
    if (-not (Test-Path -LiteralPath $src)) { $lines += ('MISS ' + $it.entry); continue }
    if ($it.id -eq 'userenv') {
      try {
        $envObj = Get-Content -Raw $src | ConvertFrom-Json
        $n = 0
        foreach ($prop in $envObj.PSObject.Properties) { [Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, 'User'); $n++ }
        $lines += ('OK   user environment (' + $n + ' values)')
      } catch { $lines += ('FAIL user environment: ' + $_.Exception.Message) }
    } else {
      try {
        $dir = Split-Path $it.path -Parent
        if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $src $it.path -Force
        $lines += ('OK   ' + $it.path)
      } catch { $lines += ('FAIL ' + $it.path + ': ' + $_.Exception.Message) }
    }
  }
} else { $lines += 'NOMANIFEST' }
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
$lines -join "\`n"`;
      const out = await ps(script);
      if (out.includes('NOMANIFEST')) setMsg(t('configbackup.restoreNoManifest'));
      else {
        setOutput(out.trim());
        setMsg(t('configbackup.restoreDone'));
        catalog.reload();
      }
    });
  };

  const diffAgainstZip = (row: CatRow) => {
    const def = CONFIG_CATALOG.find((c) => c.id === row.Id);
    if (!def || !def.file || !diffZip) return;
    void act('diffZip', 'configbackup.diffFailed', async () => {
      const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$z = [IO.Compression.ZipFile]::OpenRead('${psq(diffZip)}')
$e = $z.Entries | Where-Object { $_.FullName -like '${def.id}__*' } | Select-Object -First 1
if (-not $e) { $z.Dispose(); 'NOENTRY' }
else {
  $tmp = Join-Path $env:TEMP ('wfdiff_' + [guid]::NewGuid().ToString('N'))
  [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $tmp, $true)
  $z.Dispose()
  $cur = ${def.ps}
  if (-not (Test-Path -LiteralPath $cur)) { 'NOCURRENT' }
  else {
    $gitOk = $false
    try { $null = Get-Command git -ErrorAction Stop; $gitOk = $true } catch {}
    $d = ''
    if ($gitOk) { $d = & git diff --no-index -- $tmp $cur 2>&1 | Out-String }
    else {
      $a = Get-Content -LiteralPath $tmp; $b = Get-Content -LiteralPath $cur
      $d = (Compare-Object $a $b | ForEach-Object { ($_.SideIndicator -replace '=>', '+ current' -replace '<=', '- backup') + ' ' + $_.InputObject }) -join "\`n"
    }
    if ([string]::IsNullOrWhiteSpace($d)) { 'NODIFF' } else { "$d" }
  }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}`;
      const out = await ps(script);
      if (out.includes('NOENTRY')) setMsg(t('configbackup.diffNoEntry'));
      else if (out.includes('NOCURRENT')) setMsg(t('configbackup.diffNoCurrent'));
      else if (out.includes('NODIFF')) setMsg(t('configbackup.diffNone'));
      else {
        setOutput(out.trim());
        setMsg(t('configbackup.diffDone'));
      }
    });
  };

  // ── portable settings bundle (with optional AES-256-GCM encrypted secrets) ──
  const pwdValid = pwd.length >= WFS_MIN_PWD && pwd === pwd2;
  const pwdHint =
    pwd.length === 0 && pwd2.length === 0
      ? t('configbackup.pwdHintEmpty')
      : pwd.length < WFS_MIN_PWD
        ? t('configbackup.pwdHintShort')
        : pwd !== pwd2
          ? t('configbackup.pwdHintMismatch')
          : t('configbackup.pwdHintOk');

  const exportBundle = () =>
    act('exportBundle', 'configbackup.bundleFailed', async () => {
      let secretCount = 0;
      let hasSecrets = false;
      if (includeSecrets) {
        if (!pwdValid) {
          setMsg(t('configbackup.pwdCheck'));
          return;
        }
        if (!secApi && !secSettings && !secEnv && !secSsh) {
          setMsg(t('configbackup.secNone'));
          return;
        }
        const gather = `
$count = 0
$payload = [ordered]@{ schema = 'winforge.secrets/1'; captured = (Get-Date).ToString('o') }
${
  secApi
    ? `
$keys = [ordered]@{}
foreach ($n in @(${AI_ENV_KEYS.map((k) => `'${k}'`).join(',')})) {
  $v = [Environment]::GetEnvironmentVariable($n, 'User')
  if (-not [string]::IsNullOrEmpty($v)) { $keys[$n] = $v; $count++ }
}
$payload['apiKeys'] = $keys`
    : ''
}
${
  secSettings
    ? `
$sf = Join-Path $env:LOCALAPPDATA 'WinForge\\settings.json'
if (Test-Path $sf) { try { $s = Get-Content -Raw $sf | ConvertFrom-Json; $payload['settings'] = $s; $count += @($s.PSObject.Properties).Count } catch {} }`
    : ''
}
${
  secEnv
    ? `
$ue = [Environment]::GetEnvironmentVariables('User')
$em = [ordered]@{}
foreach ($k in $ue.Keys) { $em["$k"] = [string]$ue[$k]; $count++ }
$payload['userEnv'] = $em`
    : ''
}
${
  secSsh
    ? `
$sshDir = Join-Path $env:USERPROFILE '.ssh'
if (Test-Path $sshDir) {
  $sm = [ordered]@{}
  foreach ($f in (Get-ChildItem $sshDir -File -Recurse -Force)) {
    $rel = $f.FullName.Substring($sshDir.Length + 1).Replace('\\', '/')
    $sm[$rel] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName)); $count++
  }
  $payload['ssh'] = $sm
}`
    : ''
}
[pscustomobject]@{ Json = ($payload | ConvertTo-Json -Depth 10 -Compress); Count = [int]$count }`;
        const rows = await runPowershellJson<{ Json: string; Count: number }>(gather);
        const gathered = rows[0];
        if (!gathered) throw new Error('secret gathering produced no output');
        secretCount = gathered.Count;
        hasSecrets = true;
        // Encrypt in the frontend (WebCrypto, SecretsCrypto-compatible) — only ciphertext touches disk.
        const blob = await wfsEncrypt(gathered.Json, pwd);
        await writeB64File("(Join-Path $env:TEMP 'winforge_secrets_stage.enc')", bytesToB64(blob));
      }
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dest = ${dirExpr(backupDir)}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$stage = Join-Path $env:TEMP ('wfbe_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$sf = Join-Path $env:LOCALAPPDATA 'WinForge\\settings.json'
if (Test-Path $sf) { Copy-Item $sf (Join-Path $stage 'settings.json') -Force }
else { '{}' | Set-Content -Encoding UTF8 (Join-Path $stage 'settings.json') }
${hasSecrets ? `Move-Item (Join-Path $env:TEMP 'winforge_secrets_stage.enc') (Join-Path $stage 'secrets.enc') -Force` : ''}
$manifest = [ordered]@{
  app = 'WinForge'
  bundleVersion = '1'
  created = (Get-Date).ToString('o')
  machine = $env:COMPUTERNAME
  user = $env:USERNAME
  hasSecrets = ${hasSecrets ? '$true' : '$false'}
  secretCount = ${secretCount}
  secretsEncryption = ${hasSecrets ? "'AES-256-GCM / PBKDF2-SHA256'" : '$null'}
}
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $stage 'manifest.json')
$sums = @()
foreach ($f in (Get-ChildItem $stage -File | Where-Object { $_.Name -ne 'checksums.txt' })) {
  $h = Get-FileHash $f.FullName -Algorithm SHA256
  $sums += ($h.Hash + '  ' + $f.Name)
}
$sums -join "\`n" | Set-Content -Encoding Ascii (Join-Path $stage 'checksums.txt')
$zip = Join-Path $dest ('WinForge-config-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '${hasSecrets ? '-with-secrets' : ''}' + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
"BUNDLE $zip"`;
      const out = await ps(script);
      const m = /BUNDLE (.+)/.exec(out);
      const path = (m?.[1] ?? '').trim();
      setMsg(hasSecrets ? t('configbackup.bundleSecretsDone', { path }) : t('configbackup.bundleDone', { path }));
      history.reload();
    });

  const inspectScript = (path: string) => `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = '${psq(path)}'
if (-not (Test-Path -LiteralPath $zip)) {
  [pscustomobject]@{ Ok = $false; Version = ''; Created = ''; Machine = ''; HasSettings = $false; HasSecrets = $false; SecretCount = 0; Error = 'notfound' }
} else {
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $ver = ''; $created = ''; $machine = ''; $sc = 0
    $me = $z.GetEntry('manifest.json')
    if ($me) {
      $sr = New-Object IO.StreamReader($me.Open())
      $m = $sr.ReadToEnd() | ConvertFrom-Json
      $sr.Dispose()
      $ver = "$($m.bundleVersion)"; $created = "$($m.created)"; $machine = "$($m.machine)"
      try { $sc = [int]$m.secretCount } catch {}
    }
    [pscustomobject]@{
      Ok = $true
      Version = $ver
      Created = $created
      Machine = $machine
      HasSettings = [bool]$z.GetEntry('settings.json')
      HasSecrets = [bool]$z.GetEntry('secrets.enc')
      SecretCount = [int]$sc
      Error = ''
    }
  } finally { $z.Dispose() }
}`;

  const inspectBundle = () =>
    act('inspect', 'configbackup.inspectFailed', async () => {
      if (!importPath.trim()) return;
      const rows = await runPowershellJson<BundleInfo>(inspectScript(importPath.trim()));
      const info = rows[0];
      if (!info || !info.Ok) throw new Error(info?.Error || 'unreadable');
      setImportInfo(info);
      setMsg(
        `${t('configbackup.inspectInfo', { ver: info.Version || '1', created: info.Created || '—', machine: info.Machine || '—' })} ${
          info.HasSecrets
            ? t('configbackup.inspectSecrets', { n: info.SecretCount })
            : t('configbackup.inspectPlain')
        }`,
      );
    });

  const applySecretsScript = (sourceExpr: string) => `
${sourceExpr}
$o = $json | ConvertFrom-Json
$n = 0
if ($o.apiKeys) { foreach ($p in $o.apiKeys.PSObject.Properties) { try { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'User'); $n++ } catch {} } }
if ($o.userEnv) { foreach ($p in $o.userEnv.PSObject.Properties) { try { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'User'); $n++ } catch {} } }
if ($o.ssh) {
  $sshDir = Join-Path $env:USERPROFILE '.ssh'
  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  $root = (Get-Item $sshDir).FullName
  foreach ($p in $o.ssh.PSObject.Properties) {
    try {
      $destPath = [IO.Path]::GetFullPath((Join-Path $sshDir ($p.Name -replace '/', '\\')))
      if (-not $destPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $dd = Split-Path $destPath -Parent
      if ($dd) { New-Item -ItemType Directory -Force -Path $dd | Out-Null }
      [IO.File]::WriteAllBytes($destPath, [Convert]::FromBase64String([string]$p.Value)); $n++
    } catch {}
  }
}
"RESTORED $n"`;

  const importBundle = () =>
    act('importBundle', 'configbackup.importFailed', async () => {
      const path = importPath.trim();
      if (!path) return;
      // Read-only inspection first (mirrors BundleHasSecrets before the C# password prompt).
      let info = importInfo;
      if (!info) {
        const rows = await runPowershellJson<BundleInfo>(inspectScript(path));
        info = rows[0] ?? null;
        if (!info || !info.Ok) throw new Error(info?.Error || 'unreadable');
        setImportInfo(info);
      }
      if (info.HasSecrets && importPwd.length === 0) {
        setMsg(t('configbackup.importNeedPwd'));
        return;
      }
      const confirmText = info.HasSecrets
        ? t('configbackup.importSecretsConfirm')
        : t('configbackup.importConfirm');
      if (!window.confirm(confirmText)) return;
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$zip = '${psq(path)}'
$stage = Join-Path $env:TEMP ('wfbi_' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
$ms = Join-Path $stage 'manifest.json'
if (Test-Path $ms) {
  $m = Get-Content -Raw $ms | ConvertFrom-Json
  $bv = "$($m.bundleVersion)"
  if ($bv -and $bv -ne '1') { Remove-Item $stage -Recurse -Force; throw ('Unsupported bundle version ' + $bv) }
}
$src = Join-Path $stage 'settings.json'
if (-not (Test-Path $src)) { Remove-Item $stage -Recurse -Force; throw 'Bundle has no settings.json' }
$appDir = Join-Path $env:LOCALAPPDATA 'WinForge'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$live = Join-Path $appDir 'settings.json'
$imported = Get-Content -Raw $src | ConvertFrom-Json
$merged = [ordered]@{}
if (Test-Path $live) {
  try { $cur = Get-Content -Raw $live | ConvertFrom-Json; foreach ($p in $cur.PSObject.Properties) { $merged[$p.Name] = $p.Value } } catch {}
}
$n = 0
foreach ($p in $imported.PSObject.Properties) { $merged[$p.Name] = $p.Value; $n++ }
[pscustomobject]$merged | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $live
$secB64 = ''
$se = Join-Path $stage 'secrets.enc'
if (Test-Path $se) { $secB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($se)) }
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
[pscustomobject]@{ Applied = [int]$n; SecretsB64 = $secB64 }`;
      const rows = await runPowershellJson<{ Applied: number; SecretsB64: string }>(script);
      const res = rows[0];
      if (!res) throw new Error('import produced no output');
      if (info.HasSecrets && res.SecretsB64) {
        let json: string;
        try {
          json = await wfsDecrypt(b64ToBytes(res.SecretsB64), importPwd);
        } catch {
          // Wrong password (GCM tag mismatch) — settings were still imported, mirroring the C# flow.
          setMsg(t('configbackup.importWrongPwd'));
          return;
        }
        const jsonB64 = bytesToB64(new TextEncoder().encode(json));
        let out: string;
        if (jsonB64.length <= 20000) {
          out = await ps(
            applySecretsScript(`$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jsonB64}'))`),
          );
        } else {
          const tmp = "(Join-Path $env:TEMP 'winforge_secrets_apply.tmp')";
          await writeB64File(tmp, jsonB64);
          out = await ps(
            applySecretsScript(`$sp = ${tmp}
$json = [IO.File]::ReadAllText($sp)
Remove-Item $sp -Force -ErrorAction SilentlyContinue`),
          );
        }
        const sm = /RESTORED (\d+)/.exec(out);
        setMsg(t('configbackup.importSecretsDone', { n: res.Applied, s: sm?.[1] ?? '0' }));
      } else {
        setMsg(t('configbackup.importDone', { n: res.Applied }));
      }
      setImportPwd('');
      reloadAll();
    });

  // ── auto-sync (in-app interval timer + remote push + background schtasks) ──
  const lastTickRef = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const doSync = async (fromTimer: boolean) => {
    if (busyRef.current !== null) return;
    if (fromTimer && Date.now() - lastTickRef.current < 55000) return;
    lastTickRef.current = Date.now();
    await act('sync', 'configbackup.syncFailed', async () => {
      const remote = remoteUrl.trim();
      const pushPart = remote
        ? `
$null = & git -C $snap remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) { & git -C $snap remote set-url origin '${psq(remote)}' | Out-Null }
else { & git -C $snap remote add origin '${psq(remote)}' | Out-Null }
$pushOut = & git -C $snap push -u origin HEAD 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { 'PUSH:FAIL' } else { 'PUSH:OK' }
"$pushOut"`
        : '';
      const out = await ps(
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${snapshotCore(`${nowStamp()} — auto-sync`, !fromTimer)}\n${pushPart}`,
      );
      const stamp = new Date().toISOString();
      lsSet('backup.autosync.lastrun', stamp);
      setLastRun(stamp);
      if (remote) {
        setOutput(out.trim());
        setMsg(out.includes('PUSH:OK') ? t('configbackup.syncPushed') : t('configbackup.syncPushFailed'));
      } else {
        setMsg(out.includes('NOCHANGE') ? t('configbackup.snapNoChange') : t('configbackup.syncDone'));
      }
      snaps.reload();
      overview.reload();
    });
  };

  // Interval timer while the module is open (the background schtasks job covers app-closed time).
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    void doSync(true);
  };
  useEffect(() => {
    if (!desktop || !syncEnabled) return;
    const ms = Math.max(60000, syncCount * (UNIT_MS[syncUnit] ?? 60000));
    const id = window.setInterval(() => tickRef.current(), ms);
    return () => window.clearInterval(id);
  }, [desktop, syncEnabled, syncCount, syncUnit]);

  const persistSync = (enabled: boolean, count: number, unit: SyncUnit, remote: string) => {
    lsSet('backup.autosync.enabled', enabled ? 'true' : 'false');
    lsSet('backup.autosync.count', String(count));
    lsSet('backup.autosync.unit', unit);
    lsSet('backup.autosync.remote', remote);
  };

  const toggleAutoSync = (on: boolean) => {
    setSyncEnabled(on);
    persistSync(on, syncCount, syncUnit, remoteUrl);
    if (on) void doSync(false); // immediate baseline snapshot, like the C# toggle
  };

  const syncNow = () => {
    persistSync(syncEnabled, syncCount, syncUnit, remoteUrl);
    void doSync(false);
  };

  const pushNow = () => {
    const remote = remoteUrl.trim();
    if (!remote) {
      setMsg(t('configbackup.needRemote'));
      return;
    }
    persistSync(syncEnabled, syncCount, syncUnit, remote);
    void act('push', 'configbackup.pushFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$snap = ${SNAP_DIR}
New-Item -ItemType Directory -Force -Path $snap | Out-Null
if (-not (Test-Path (Join-Path $snap '.git'))) {
  & git -C $snap init | Out-Null
  & git -C $snap config user.name WinForge | Out-Null
  & git -C $snap config user.email winforge@localhost | Out-Null
}
$null = & git -C $snap remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) { & git -C $snap remote set-url origin '${psq(remote)}' | Out-Null }
else { & git -C $snap remote add origin '${psq(remote)}' | Out-Null }
$out = & git -C $snap push -u origin HEAD 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "$out" }
"$out"`;
      const out = await ps(script);
      setOutput(out.trim());
      setMsg(t('configbackup.pushDone'));
      overview.reload();
    });
  };

  const setBgTask = (on: boolean) => {
    void act('bgtask', 'configbackup.bgFailed', async () => {
      if (on) {
        const n = Math.min(9999, Math.max(1, Math.round(syncCount)));
        const sched =
          syncUnit === 'minute' ? `/SC MINUTE /MO ${n}` : syncUnit === 'hour' ? `/SC HOURLY /MO ${n}` : `/SC DAILY /MO ${n}`;
        const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${RUNNER_SETUP}
$out = & schtasks.exe /Create ${sched} /TN "${AUTOSYNC_TASK}" /TR $tr /RL LIMITED /F 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "$out" }
"$out"`;
        const out = await ps(script);
        setOutput(out.trim());
        const unitLabel =
          syncUnit === 'minute'
            ? t('configbackup.unit_minute')
            : syncUnit === 'hour'
              ? t('configbackup.unit_hour')
              : t('configbackup.unit_day');
        setMsg(t('configbackup.bgOnDone', { n, unit: unitLabel }));
      } else {
        const out = await ps(
          `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$out = & schtasks.exe /Delete /TN "${AUTOSYNC_TASK}" /F 2>&1 | Out-String\nif ($LASTEXITCODE -ne 0) { throw "$out" }\n"$out"`,
        );
        setOutput(out.trim());
        setMsg(t('configbackup.bgOffDone'));
      }
      overview.reload();
    });
  };

  // ── daily schedule + mirror ──
  const scheduleDaily = () => {
    const time = timeStr.trim() || '03:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setMsg(t('configbackup.badTime'));
      return;
    }
    void act('daily', 'configbackup.scheduleFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${RUNNER_SETUP}
$out = & schtasks.exe /Create /SC DAILY /TN "${DAILY_TASK}" /TR $tr /ST ${time} /RL LIMITED /F 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "$out" }
"$out"`;
      const out = await ps(script);
      setOutput(out.trim());
      setMsg(t('configbackup.scheduleDone', { time }));
      overview.reload();
    });
  };

  const unscheduleDaily = () =>
    act('unsched', 'configbackup.unscheduleFailed', async () => {
      const out = await ps(
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$out = & schtasks.exe /Delete /TN "${DAILY_TASK}" /F 2>&1 | Out-String\nif ($LASTEXITCODE -ne 0) { throw "$out" }\n"$out"`,
      );
      setOutput(out.trim());
      setMsg(t('configbackup.unscheduleDone'));
      overview.reload();
    });

  const mirrorNow = () => {
    const dest = mirrorDest.trim();
    if (!dest) {
      setMsg(t('configbackup.needDest'));
      return;
    }
    if (!window.confirm(t('configbackup.mirrorConfirm', { dest }))) return;
    void act('mirror', 'configbackup.mirrorFailed', async () => {
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$snap = ${SNAP_DIR}
if (-not (Test-Path $snap)) { 'NOSNAP' }
else {
  $dest = '${psq(dest)}'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $out = & robocopy $snap $dest /MIR /R:2 /W:2 /NP 2>&1 | Out-String
  $code = $LASTEXITCODE
  "$out"
  if ($code -ge 8) { throw ('robocopy exit code ' + $code) }
  'MIRROROK'
}`;
      const out = await ps(script);
      if (out.includes('NOSNAP')) setMsg(t('configbackup.noRepo'));
      else {
        setOutput(out.replace('MIRROROK', '').trim());
        setMsg(t('configbackup.mirrorDone', { dest }));
      }
    });
  };

  // ── environment helpers ──
  const installGit = () =>
    act('installgit', 'configbackup.gitInstallFailed', async () => {
      setMsg(t('configbackup.installingGit'));
      const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = & winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-String
"$out"
if ($LASTEXITCODE -ne 0) { throw ('winget exit ' + $LASTEXITCODE) }
'GITOK'`;
      const out = await ps(script);
      setOutput(out.replace('GITOK', '').trim());
      setMsg(t('configbackup.gitInstallDone'));
      overview.reload();
    });

  const openFolder = (expr: string, key: string) =>
    act(key, 'configbackup.openFailed', async () => {
      const res = await runPowershell(`$p = ${expr}; New-Item -ItemType Directory -Force -Path $p | Out-Null; "$p"`);
      const dir = res.stdout.trim();
      if (dir) await runCommand('explorer.exe', [dir]);
      setMsg(t('configbackup.openedFolder', { path: dir }));
    });
  const openSnapshotsFolder = () => openFolder(SNAP_DIR, 'open');
  const openBackupFolder = () => openFolder(dirExpr(backupDir), 'openbk');

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setMsg(t('configbackup.copiedOut'));
    } catch {
      setMsg(t('configbackup.copyOutFailed'));
    }
  };

  const lastSyncLabel = useMemo(() => {
    if (!lastRun) return t('configbackup.lastSyncNever');
    const d = new Date(lastRun);
    return Number.isNaN(d.getTime())
      ? t('configbackup.lastSyncNever')
      : t('configbackup.lastSyncAt', { date: d.toISOString().replace('T', ' ').slice(0, 19) });
  }, [lastRun, t]);

  // ── tables ──
  const dis = !desktop || busy !== null;
  const gitOff = ov?.GitAvailable === false;
  const catLabel = (id: string) => CONFIG_CATALOG.find((c) => c.id === id)?.label ?? id;

  const snapColumns: Column<Snapshot>[] = [
    { key: 'Short', header: t('configbackup.colHash'), width: 90, render: (s) => <code>{s.Short}</code> },
    { key: 'Subject', header: t('configbackup.colSubject') },
    { key: 'Date', header: t('configbackup.colDate'), width: 190 },
    {
      key: 'actions',
      header: '',
      width: 170,
      render: (s) => (
        <span className="row-actions">
          <button className="mini" disabled={dis} onClick={() => restoreSnapshot(s)}>
            {t('configbackup.snapRestore')}
          </button>
          <button className="mini" disabled={dis} onClick={() => diffSnapshot(s)}>
            {t('configbackup.snapDiff')}
          </button>
        </span>
      ),
    },
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

  const catColumns: Column<CatRow>[] = [
    {
      key: 'sel',
      header: t('configbackup.colInclude'),
      width: 70,
      align: 'center',
      render: (r) => (
        <input
          type="checkbox"
          checked={isSel(r)}
          disabled={!r.Present && r.Id !== 'userenv'}
          onChange={() => toggleSel(r.Id, r.Present)}
        />
      ),
    },
    {
      key: 'Present',
      header: t('configbackup.colState'),
      width: 100,
      render: (r) => (
        <StatusDot ok={r.Present} label={r.Present ? t('configbackup.present') : t('configbackup.absent')} />
      ),
    },
    { key: 'Id', header: t('configbackup.colItem'), width: 200, render: (r) => catLabel(r.Id) },
    { key: 'Path', header: t('configbackup.colPath'), render: (r) => <code>{r.Path}</code> },
    {
      key: 'SizeKb',
      header: t('configbackup.colSize'),
      width: 90,
      align: 'right',
      render: (r) =>
        r.Id === 'userenv' ? t('configbackup.envValues', { n: r.Info }) : r.Present ? `${r.SizeKb} KB` : '—',
    },
    { key: 'Modified', header: t('configbackup.colModified'), width: 130, render: (r) => r.Modified || '—' },
    {
      key: 'actions',
      header: '',
      width: 80,
      render: (r) =>
        r.Id !== 'userenv' ? (
          <button className="mini" disabled={dis || !diffZip || !r.Present} onClick={() => diffAgainstZip(r)}>
            {t('configbackup.diffBtn')}
          </button>
        ) : null,
    },
  ];

  const histColumns: Column<HistRow>[] = [
    { key: 'Name', header: t('configbackup.colName'), render: (r) => <code>{r.Name}</code> },
    { key: 'SizeKb', header: t('configbackup.colSize'), width: 90, align: 'right', render: (r) => `${r.SizeKb} KB` },
    { key: 'Modified', header: t('configbackup.colModified'), width: 130 },
    {
      key: 'actions',
      header: '',
      width: 260,
      render: (r) =>
        r.IsZip ? (
          <span className="row-actions">
            <button className="mini" disabled={dis} onClick={() => previewZip(r)}>
              {t('configbackup.previewBtn')}
            </button>
            <button className="mini" disabled={dis} onClick={() => restoreZip(r)}>
              {t('configbackup.restoreBtn')}
            </button>
            <button className="mini" disabled={dis} onClick={() => setDiffZip(r.Path)}>
              {t('configbackup.useForDiff')}
            </button>
          </span>
        ) : null,
    },
  ];

  const previewColumns: Column<ZipEntryRow>[] = [
    { key: 'Name', header: t('configbackup.colEntry'), render: (r) => <code>{r.Name}</code> },
    {
      key: 'Size',
      header: t('configbackup.colSize'),
      width: 90,
      align: 'right',
      render: (r) => `${Math.round((r.Size / 1024) * 10) / 10} KB`,
    },
    { key: 'Modified', header: t('configbackup.colModified'), width: 130 },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" disabled={dis} onClick={openSnapshotsFolder}>
          {t('configbackup.openFolder')}
        </button>
        <button className="mini" disabled={dis} onClick={openBackupFolder}>
          {t('configbackup.openBackupFolder')}
        </button>
        <span className="count-note">{t('configbackup.blurb')}</span>
      </ModuleToolbar>

      {!desktop && <p className="count-note">{t('detail.liveBrowser')}</p>}
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
            {ov.RemoteUrl && <span className="count-note">{t('configbackup.remote', { url: ov.RemoteUrl })}</span>}
            {desktop && gitOff && (
              <button className="mini primary" disabled={busy !== null} onClick={installGit}>
                {t('configbackup.installGit')}
              </button>
            )}
          </div>
        )}
      </AsyncState>

      {/* ── Portable settings bundle ── */}
      <h4 style={{ margin: '10px 0 6px' }}>{t('configbackup.bundleTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.bundleDesc')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
          {t('configbackup.secretsToggle')}
        </label>
        <span className="count-note">{t('configbackup.secretsToggleDesc')}</span>
      </div>
      {includeSecrets && (
        <div style={{ margin: '0 0 10px' }}>
          <p className="mod-msg">
            <strong>{t('configbackup.secretsWarnTitle')}</strong> — {t('configbackup.secretsWarnBody')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={secApi} onChange={(e) => setSecApi(e.target.checked)} />
              {t('configbackup.secApiKeys')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={secSettings} onChange={(e) => setSecSettings(e.target.checked)} />
              {t('configbackup.secSettings')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={secEnv} onChange={(e) => setSecEnv(e.target.checked)} />
              {t('configbackup.secEnv')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={secSsh} onChange={(e) => setSecSsh(e.target.checked)} />
              {t('configbackup.secSsh')}
            </label>
          </div>
          <div className="mod-toolbar" style={{ marginBottom: 4 }}>
            <input
              type="password"
              className="mod-search"
              placeholder={t('configbackup.pwdPh')}
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
            />
            <input
              type="password"
              className="mod-search"
              placeholder={t('configbackup.pwdConfirmPh')}
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
            />
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {pwdHint}
          </p>
        </div>
      )}
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <button className="mini primary" disabled={dis} onClick={exportBundle}>
          {t('configbackup.exportBundle')}
        </button>
        <input
          className="mod-search"
          style={{ minWidth: 300 }}
          placeholder={t('configbackup.importPathPh')}
          value={importPath}
          onChange={(e) => {
            setImportPath(e.target.value);
            setImportInfo(null);
          }}
        />
        <button className="mini" disabled={dis || !importPath.trim()} onClick={inspectBundle}>
          {t('configbackup.inspectBundle')}
        </button>
        {importInfo?.HasSecrets && (
          <input
            type="password"
            className="mod-search"
            placeholder={t('configbackup.importPwdPh')}
            value={importPwd}
            onChange={(e) => setImportPwd(e.target.value)}
          />
        )}
        <button className="mini" disabled={dis || !importPath.trim()} onClick={importBundle}>
          {t('configbackup.importBundle')}
        </button>
      </div>

      {/* ── Config snapshots (git) ── */}
      <h4 style={{ margin: '14px 0 6px' }}>{t('configbackup.historyTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.snapNote')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <input
          className="mod-search"
          placeholder={t('configbackup.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="mini primary" disabled={dis || gitOff} onClick={takeSnapshot}>
          {t('configbackup.takeSnapshot')}
        </button>
        <button className="mini" disabled={dis || gitOff} onClick={verifyIntegrity}>
          {t('configbackup.verify')}
        </button>
        <button className="mini" disabled={dis || gitOff} onClick={pruneHistory}>
          {t('configbackup.prune')}
        </button>
        <button className="mini" disabled={dis || gitOff} onClick={saveBundleFile}>
          {t('configbackup.saveBundleFile')}
        </button>
      </div>
      <AsyncState loading={snaps.loading} error={snaps.error}>
        <DataTable columns={snapColumns} rows={snapRows} rowKey={(s) => s.Hash} empty={t('configbackup.noSnaps')} />
      </AsyncState>

      {/* ── Capture & export ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.captureTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.captureDesc')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <button className="mini" disabled={dis} onClick={exportRegistry}>
          {t('configbackup.exportReg')}
        </button>
        <button className="mini" disabled={dis || ov?.WingetAvailable === false} onClick={captureWinget}>
          {t('configbackup.captureWinget')}
        </button>
        <button className="mini" disabled={dis} onClick={backupTaskbar}>
          {t('configbackup.backupTaskbar')}
        </button>
      </div>

      {/* ── Touched registry keys table ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.regTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.regNote')}
      </p>
      <AsyncState loading={reg.loading} error={reg.error}>
        <DataTable columns={regColumns} rows={reg.data ?? []} rowKey={(r) => r.Key} />
      </AsyncState>

      {/* ── Known config locations (file catalog) ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.catalogTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.catalogNote')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <input
          className="mod-search"
          style={{ minWidth: 280 }}
          placeholder={t('configbackup.backupDirPh')}
          value={backupDir}
          onChange={(e) => {
            setBackupDir(e.target.value);
            lsSet('backup.dir', e.target.value);
          }}
        />
        <button className="mini primary" disabled={dis} onClick={backupSelected}>
          {t('configbackup.backupSelected')}
        </button>
        <span className="count-note">{t('configbackup.diffZipLabel')}</span>
        <select className="mod-search" value={diffZip} onChange={(e) => setDiffZip(e.target.value)}>
          <option value="">{t('configbackup.diffPick')}</option>
          {histRows
            .filter((h) => h.IsZip)
            .map((h) => (
              <option key={h.Path} value={h.Path}>
                {h.Name}
              </option>
            ))}
        </select>
      </div>
      <AsyncState loading={catalog.loading} error={catalog.error}>
        <DataTable columns={catColumns} rows={catRows} rowKey={(r) => r.Id} />
      </AsyncState>

      {/* ── Backup history + restore preview ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.historyBackups')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.historyNote')}
      </p>
      <AsyncState loading={history.loading} error={history.error}>
        <DataTable
          columns={histColumns}
          rows={histRows}
          rowKey={(r) => r.Path}
          empty={t('configbackup.noBackups')}
        />
      </AsyncState>
      {preview && (
        <>
          <h4 style={{ margin: '12px 0 6px' }}>{t('configbackup.previewTitle', { name: preview.name })}</h4>
          <DataTable columns={previewColumns} rows={preview.rows} rowKey={(r, i) => `${r.Name}-${i}`} />
        </>
      )}

      {/* ── Auto-sync schedule ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.syncTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.syncDesc')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 6, alignItems: 'center' }}>
        <span>{t('configbackup.every')}</span>
        <input
          type="number"
          className="mod-search"
          style={{ width: 90 }}
          min={1}
          max={9999}
          value={syncCount}
          onChange={(e) => {
            const n = Math.min(9999, Math.max(1, parseInt(e.target.value, 10) || 1));
            setSyncCount(n);
            persistSync(syncEnabled, n, syncUnit, remoteUrl);
          }}
        />
        <select
          className="mod-search"
          value={syncUnit}
          onChange={(e) => {
            const u = e.target.value as SyncUnit;
            setSyncUnit(u);
            persistSync(syncEnabled, syncCount, u, remoteUrl);
          }}
        >
          <option value="minute">{t('configbackup.unit_minute')}</option>
          <option value="hour">{t('configbackup.unit_hour')}</option>
          <option value="day">{t('configbackup.unit_day')}</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={syncEnabled}
            disabled={dis || gitOff}
            onChange={(e) => toggleAutoSync(e.target.checked)}
          />
          {t('configbackup.enableAutosync')}
        </label>
      </div>
      <div className="mod-toolbar" style={{ marginBottom: 6 }}>
        <span className="count-note">{t('configbackup.remoteLabel')}</span>
        <input
          className="mod-search"
          style={{ minWidth: 300 }}
          placeholder={t('configbackup.remotePh')}
          value={remoteUrl}
          onChange={(e) => {
            setRemoteUrl(e.target.value);
            persistSync(syncEnabled, syncCount, syncUnit, e.target.value);
          }}
        />
        <button className="mini" disabled={dis || gitOff} onClick={pushNow}>
          {t('configbackup.pushNow')}
        </button>
        <button className="mini primary" disabled={dis || gitOff} onClick={syncNow}>
          {t('configbackup.syncNow')}
        </button>
      </div>
      <div className="mod-toolbar" style={{ marginBottom: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={ov?.AutoSyncScheduled ?? false}
            disabled={dis || gitOff}
            onChange={(e) => setBgTask(e.target.checked)}
          />
          {t('configbackup.bgTask')}
        </label>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {lastSyncLabel}
      </p>

      {/* ── Automate & mirror ── */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('configbackup.autoTitle')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('configbackup.autoDesc')}
      </p>
      <div className="mod-toolbar" style={{ marginBottom: 6, alignItems: 'center' }}>
        <span>{t('configbackup.dailyAt')}</span>
        <input
          className="mod-search"
          style={{ width: 80 }}
          value={timeStr}
          onChange={(e) => setTimeStr(e.target.value)}
        />
        <button className="mini primary" disabled={dis} onClick={scheduleDaily}>
          {t('configbackup.scheduleDaily')}
        </button>
        <button className="mini" disabled={dis} onClick={unscheduleDaily}>
          {t('configbackup.unschedule')}
        </button>
        <span className="count-note">
          {ov?.DailyScheduled ? t('configbackup.scheduled') : t('configbackup.notScheduled')}
        </span>
      </div>
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <input
          className="mod-search"
          style={{ minWidth: 280 }}
          placeholder={t('configbackup.mirrorPh')}
          value={mirrorDest}
          onChange={(e) => setMirrorDest(e.target.value)}
        />
        <button className="mini" disabled={dis} onClick={mirrorNow}>
          {t('configbackup.mirrorTo')}
        </button>
      </div>

      {/* ── Output pane ── */}
      <h4 style={{ margin: '16px 0 6px' }}>
        {t('configbackup.outputTitle')}{' '}
        <button className="mini" style={{ marginLeft: 8 }} disabled={!output} onClick={copyOutput}>
          {t('configbackup.copyOutput')}
        </button>
      </h4>
      <pre className="cmd-out" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {output || t('configbackup.outputEmpty')}
      </pre>
    </div>
  );
}
