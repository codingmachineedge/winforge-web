import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Saved-site store, mirroring the C# FtpSiteStore schema ────────────────────
// The desktop WinForge app persists sites to %LOCALAPPDATA%\WinForge\ftp-sites.json
// with every password / passphrase DPAPI-encrypted (CurrentUser scope + the
// "WinForge.FtpSiteStore.v1" entropy). We read metadata for display and NEVER
// surface a decrypted secret — the plaintext password is only ever handed to the
// transfer CLI (psftp / curl) for the duration of a single command, never stored,
// never logged, never rendered.
interface Site {
  Id: string;
  Name: string;
  Protocol: string; // Ftp | Ftps | Sftp
  Host: string;
  Port: number;
  User: string;
  Auth: string; // Password | KeyFile
  KeyFilePath: string;
  RemoteDir: string;
  HasSecret: boolean;
  Trusted: boolean;
}

// ── Local directory row (live from Get-ChildItem) ─────────────────────────────
interface LocalRow {
  Name: string;
  FullPath: string;
  IsDir: boolean;
  Size: number;
  Modified: string; // preformatted string from PowerShell
}

// ── Remote directory row (parsed from psftp `ls -l` / curl listing) ───────────
interface RemoteRow {
  Name: string;
  FullPath: string;
  IsDir: boolean;
  Size: number;
  Perms: string; // rwxr-xr-x style, or "" when unknown
}

// ── Transfer-queue item ───────────────────────────────────────────────────────
type QueueStatus = 'pending' | 'active' | 'done' | 'failed' | 'cancelled';
interface QueueItem {
  id: string;
  upload: boolean;
  localPath: string;
  remotePath: string;
  fileName: string;
  status: QueueStatus;
  progress: number; // 0..1
  detail: string;
}

const PROTOCOLS = ['Sftp', 'Ftp', 'Ftps'] as const;
type Protocol = (typeof PROTOCOLS)[number];

function defaultPort(proto: string): number {
  return proto === 'Sftp' ? 22 : 21;
}

function fmtSize(bytes: number, dash: string): string {
  if (bytes < 0) return dash;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i] ?? 'TB'}`;
}

// Escape a value destined for a single-quoted PowerShell string literal.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

// Join a remote path using forward slashes (mirrors FtpService.CombineRemote).
function combineRemote(dir: string, name: string): string {
  if (!dir || dir === '/') return '/' + name.replace(/^\/+/, '');
  return dir.replace(/\/+$/, '') + '/' + name.replace(/^\/+/, '');
}

// Parent of a remote path (mirrors FtpService.ParentRemote).
function parentRemote(path: string): string {
  if (!path || path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

// numeric permission octal → symbolic (used to preview a chmod before applying).
function octalToSymbolic(oct: string): string {
  const digits = oct.replace(/[^0-7]/g, '').slice(-3);
  if (digits.length !== 3) return oct;
  const map = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  return [...digits].map((d) => map[Number(d)] ?? '---').join('');
}

// A tiny non-throwing PowerShell runner (browser preview returns a no-op stub).
async function pshell(script: string): Promise<{ stdout: string; stderr: string; code: number; success: boolean }> {
  if (!isTauri()) return { stdout: '', stderr: '', code: -1, success: false };
  try {
    return await runPowershell(script);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `q${idSeq}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Remote-transport helper. Builds and runs psftp (SFTP) / curl (FTP·FTPS)
//  commands. The password is passed only as a CLI argument for one command and is
//  never persisted. Returns the raw stdout for the caller to parse.
// ══════════════════════════════════════════════════════════════════════════════

interface Conn {
  proto: Protocol;
  host: string;
  port: number;
  user: string;
  password: string; // held in component memory only, for the session
  keyFile: string;
}

// Run a psftp batch script over a here-doc temp file (SFTP). psftp reads batch
// commands from a file via -b, so we write the script to a temp file, run, delete.
async function psftpBatch(c: Conn, commands: string[]): Promise<{ stdout: string; ok: boolean; err: string }> {
  if (!isTauri()) return { stdout: '', ok: false, err: 'preview' };
  const script = [
    `$tmp = [System.IO.Path]::GetTempFileName();`,
    `Set-Content -LiteralPath $tmp -Value @'`,
    ...commands,
    `'@ -Encoding ASCII;`,
    `$auth = @();`,
    c.keyFile
      ? `$auth = @('-i','${psq(c.keyFile)}');`
      : `$auth = @('-pw','${psq(c.password)}');`,
    `$args = @('${psq(c.host)}','-P','${c.port | 0}','-l','${psq(c.user)}') + $auth + @('-batch','-b',$tmp);`,
    `$out = & psftp @args 2>&1 | Out-String;`,
    `Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue;`,
    `$out`,
  ].join('\n');
  const r = await pshell(script);
  return { stdout: r.stdout ?? '', ok: r.success, err: (r.stderr || '').trim() };
}

// Build a curl URL for an FTP / FTPS endpoint.
function ftpUrl(c: Conn, remotePath: string, dir: boolean): string {
  const scheme = 'ftp';
  const host = c.host;
  const p = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
  return `${scheme}://${host}:${c.port}${p}${dir && !p.endsWith('/') ? '/' : ''}`;
}

function curlAuthArgs(c: Conn): string[] {
  const args = ['-s', '-S', '--connect-timeout', '15'];
  if (c.proto === 'Ftps') args.push('--ssl-reqd', '-k');
  if (c.user) args.push('-u', `${c.user}:${c.password}`);
  return args;
}

// ══════════════════════════════════════════════════════════════════════════════

export function FileZillaModule() {
  const { t } = useTranslation();
  const dash = '—';
  const native = isTauri();

  const [msg, setMsg] = useState<string | null>(null);

  // ── Site Manager ────────────────────────────────────────────────────────────
  const sitesState = useAsync(
    () =>
      runPowershellJson<Site>(
        [
          "$p = Join-Path $env:LOCALAPPDATA 'WinForge\\ftp-sites.json';",
          'if (-not (Test-Path $p)) { @() | ConvertTo-Json; return }',
          '$raw = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json',
          '$raw | ForEach-Object {',
          '  $sec = [string]$_.EncryptedSecret;',
          '  $fp  = [string]$_.TrustedFingerprint;',
          '  [pscustomobject]@{',
          '    Id=[string]$_.Id; Name=[string]$_.Name; Protocol=[string]$_.Protocol;',
          '    Host=[string]$_.Host; Port=[int]$_.Port; User=[string]$_.User;',
          '    Auth=[string]$_.Auth; KeyFilePath=[string]$_.KeyFilePath; RemoteDir=[string]$_.RemoteDir;',
          '    HasSecret=($sec.Length -gt 0); Trusted=($fp.Length -gt 0)',
          '  }',
          '}',
        ].join('\n'),
      ),
    [],
  );

  const sites = useMemo(() => sitesState.data ?? [], [sitesState.data]);
  const trustedCount = useMemo(() => sites.filter((s) => s.Trusted).length, [sites]);

  // Live reachability probe per site host:port — Test-NetConnection is read-only.
  const [reach, setReach] = useState<Record<string, boolean | 'checking'>>({});
  const probe = useCallback(async (host: string, port: number, id: string) => {
    if (!host) return;
    setReach((r) => ({ ...r, [id]: 'checking' }));
    try {
      const rows = await runPowershellJson<{ Ok: boolean }>(
        `$r = Test-NetConnection -ComputerName '${psq(host)}' -Port ${port | 0} -WarningAction SilentlyContinue; [pscustomobject]@{ Ok = [bool]$r.TcpTestSucceeded }`,
      );
      const ok = rows[0]?.Ok === true;
      setReach((r) => ({ ...r, [id]: ok }));
    } catch {
      setReach((r) => ({ ...r, [id]: false }));
    }
  }, []);

  // ── Site editor dialog (add / edit) ──────────────────────────────────────────
  interface Draft {
    id: string;
    name: string;
    protocol: Protocol;
    host: string;
    port: string;
    user: string;
    auth: 'Password' | 'KeyFile';
    keyFile: string;
    remoteDir: string;
    password: string; // plaintext held only while the editor is open
    isNew: boolean;
  }
  const [draft, setDraft] = useState<Draft | null>(null);

  const openNewSite = () =>
    setDraft({
      id: '',
      name: t('filezilla.newSiteName'),
      protocol: 'Sftp',
      host: '',
      port: '22',
      user: '',
      auth: 'Password',
      keyFile: '',
      remoteDir: '',
      password: '',
      isNew: true,
    });

  const openEditSite = (s: Site) =>
    setDraft({
      id: s.Id,
      name: s.Name,
      protocol: (PROTOCOLS.includes(s.Protocol as Protocol) ? s.Protocol : 'Sftp') as Protocol,
      host: s.Host,
      port: String(s.Port || defaultPort(s.Protocol)),
      user: s.User,
      auth: s.Auth === 'KeyFile' ? 'KeyFile' : 'Password',
      keyFile: s.KeyFilePath,
      remoteDir: s.RemoteDir,
      password: '', // never pre-filled; blank means "keep existing encrypted secret"
      isNew: false,
    });

  const [savingSite, setSavingSite] = useState(false);
  // Persist a site to the DPAPI-backed JSON store. The password is DPAPI-encrypted
  // (CurrentUser + module entropy) in PowerShell and only the ciphertext is written.
  const saveSite = async () => {
    if (!draft) return;
    setSavingSite(true);
    setMsg(null);
    const port = parseInt(draft.port, 10) || defaultPort(draft.protocol);
    const script = [
      "$dir = Join-Path $env:LOCALAPPDATA 'WinForge';",
      'New-Item -ItemType Directory -Force -Path $dir | Out-Null;',
      "$p = Join-Path $dir 'ftp-sites.json';",
      '$list = @();',
      'if (Test-Path $p) { $list = @(Get-Content -Raw -LiteralPath $p | ConvertFrom-Json) }',
      'Add-Type -AssemblyName System.Security;',
      "$entropy = [System.Text.Encoding]::UTF8.GetBytes('WinForge.FtpSiteStore.v1');",
      `$plain = '${psq(draft.password)}';`,
      '$enc = "";',
      'if ($plain.Length -gt 0) {',
      '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain);',
      '  $prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '  $enc = [Convert]::ToBase64String($prot);',
      '}',
      `$id = '${psq(draft.id)}';`,
      'if ([string]::IsNullOrEmpty($id)) { $id = [guid]::NewGuid().ToString("N") }',
      '$existing = $null;',
      'foreach ($s in $list) { if ($s.Id -eq $id) { $existing = $s } }',
      // keep existing ciphertext when the password box was left blank on an edit
      'if ($enc.Length -eq 0 -and $existing) { $enc = [string]$existing.EncryptedSecret }',
      '$fp = "";',
      'if ($existing) { $fp = [string]$existing.TrustedFingerprint }',
      '$obj = [pscustomobject]@{',
      '  Id=$id;',
      `  Name='${psq(draft.name || draft.host || 'site')}';`,
      `  Protocol='${draft.protocol}';`,
      `  Host='${psq(draft.host)}';`,
      `  Port=${port | 0};`,
      `  User='${psq(draft.user)}';`,
      '  EncryptedSecret=$enc;',
      `  Auth='${draft.auth}';`,
      `  KeyFilePath='${psq(draft.keyFile)}';`,
      `  RemoteDir='${psq(draft.remoteDir)}';`,
      '  LocalDir="";',
      '  TrustedFingerprint=$fp;',
      '};',
      '$out = @(); $found = $false;',
      'foreach ($s in $list) { if ($s.Id -eq $id) { $out += $obj; $found = $true } else { $out += $s } }',
      'if (-not $found) { $out += $obj }',
      '$out | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $p -Encoding UTF8;',
      "'ok'",
    ].join('\n');
    try {
      const r = await pshell(script);
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      setMsg(t('filezilla.siteSaved', { name: draft.name || draft.host }));
      setDraft(null);
      sitesState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.siteSaveFail')}: ${String(e)}`);
    } finally {
      setSavingSite(false);
    }
  };

  const deleteSite = async (s: Site) => {
    if (!window.confirm(t('filezilla.deleteSiteConfirm', { name: s.Name, host: s.Host }))) return;
    setMsg(null);
    const script = [
      "$p = Join-Path $env:LOCALAPPDATA 'WinForge\\ftp-sites.json';",
      'if (-not (Test-Path $p)) { return }',
      '$list = @(Get-Content -Raw -LiteralPath $p | ConvertFrom-Json)',
      `$out = @($list | Where-Object { $_.Id -ne '${psq(s.Id)}' })`,
      '$out | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $p -Encoding UTF8;',
      "'ok'",
    ].join('\n');
    try {
      const r = await pshell(script);
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      setMsg(t('filezilla.siteDeleted', { name: s.Name }));
      sitesState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.siteSaveFail')}: ${String(e)}`);
    }
  };

  // ── Live connection state (drives the remote pane) ────────────────────────────
  const [conn, setConn] = useState<Conn | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  const [remoteDir, setRemoteDir] = useState('/');
  const [remotePathInput, setRemotePathInput] = useState('/');

  // ── Quickconnect bar ──────────────────────────────────────────────────────────
  const [qcProto, setQcProto] = useState<Protocol>('Sftp');
  const [qcHost, setQcHost] = useState('');
  const [qcPort, setQcPort] = useState('22');
  const [qcUser, setQcUser] = useState('');
  const [qcPass, setQcPass] = useState('');
  const [qcResult, setQcResult] = useState<string | null>(null);
  const [qcBusy, setQcBusy] = useState(false);

  const quickCheck = async () => {
    if (!qcHost.trim()) {
      setQcResult(t('filezilla.qcNoHost'));
      return;
    }
    setQcBusy(true);
    setQcResult(t('filezilla.qcChecking'));
    const port = parseInt(qcPort, 10) || defaultPort(qcProto);
    try {
      const rows = await runPowershellJson<{ Ok: boolean }>(
        `$r = Test-NetConnection -ComputerName '${psq(qcHost.trim())}' -Port ${port} -WarningAction SilentlyContinue; [pscustomobject]@{ Ok = [bool]$r.TcpTestSucceeded }`,
      );
      const ok = rows[0]?.Ok === true;
      setQcResult(
        ok
          ? t('filezilla.qcReachable', { host: qcHost.trim(), port })
          : t('filezilla.qcUnreachable', { host: qcHost.trim(), port }),
      );
    } catch (e) {
      setQcResult(`${t('filezilla.qcFailed')}: ${String(e)}`);
    } finally {
      setQcBusy(false);
    }
  };

  // Establish a live connection. Decrypts the site secret (DPAPI) once, holds it in
  // component memory for the session, verifies with a login listing, then opens the
  // remote pane. The plaintext never leaves this component and is never rendered.
  const connectWith = async (c: Conn, startDir: string) => {
    setConnBusy(true);
    setMsg(t('filezilla.connecting', { host: c.host }));
    try {
      // Probe the login by listing the start directory.
      const listing = await listRemote(c, startDir || (c.proto === 'Sftp' ? '.' : '/'));
      if (listing === null) throw new Error(t('filezilla.connectRefused'));
      setConn(c);
      const dir = startDir || '/';
      setRemoteDir(dir);
      setRemotePathInput(dir);
      setRemoteRows(listing);
      setMsg(t('filezilla.connected', { proto: c.proto, host: c.host }));
    } catch (e) {
      setConn(null);
      setMsg(`${t('filezilla.connectFail')}: ${String(e)}`);
    } finally {
      setConnBusy(false);
    }
  };

  const quickConnect = async () => {
    if (!qcHost.trim()) {
      setMsg(t('filezilla.qcNoHost'));
      return;
    }
    if (!native) {
      setMsg(t('filezilla.previewNote'));
      return;
    }
    const c: Conn = {
      proto: qcProto,
      host: qcHost.trim(),
      port: parseInt(qcPort, 10) || defaultPort(qcProto),
      user: qcUser.trim(),
      password: qcPass,
      keyFile: '',
    };
    await connectWith(c, '/');
  };

  // Connect from a saved site (decrypt its secret first).
  const connectSite = async (s: Site) => {
    if (!native) {
      setMsg(t('filezilla.previewNote'));
      return;
    }
    setConnBusy(true);
    setMsg(t('filezilla.connecting', { host: s.Host }));
    // Decrypt the DPAPI secret in PowerShell; hand it straight to the connection
    // object in memory. It is never written back or displayed.
    const decScript = [
      "$p = Join-Path $env:LOCALAPPDATA 'WinForge\\ftp-sites.json';",
      'if (-not (Test-Path $p)) { ""; return }',
      '$list = @(Get-Content -Raw -LiteralPath $p | ConvertFrom-Json)',
      `$s = $list | Where-Object { $_.Id -eq '${psq(s.Id)}' } | Select-Object -First 1;`,
      'if (-not $s) { ""; return }',
      '$enc = [string]$s.EncryptedSecret;',
      'if ($enc.Length -eq 0) { ""; return }',
      'Add-Type -AssemblyName System.Security;',
      "$entropy = [System.Text.Encoding]::UTF8.GetBytes('WinForge.FtpSiteStore.v1');",
      'try {',
      '  $bytes = [Convert]::FromBase64String($enc);',
      '  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '  [System.Text.Encoding]::UTF8.GetString($plain)',
      '} catch { "" }',
    ].join('\n');
    let password = '';
    try {
      const r = await pshell(decScript);
      password = (r.stdout || '').replace(/\r?\n$/, '');
    } catch {
      password = '';
    }
    const c: Conn = {
      proto: (PROTOCOLS.includes(s.Protocol as Protocol) ? s.Protocol : 'Sftp') as Protocol,
      host: s.Host,
      port: s.Port || defaultPort(s.Protocol),
      user: s.User,
      password,
      keyFile: s.Auth === 'KeyFile' ? s.KeyFilePath : '',
    };
    await connectWith(c, s.RemoteDir || '/');
  };

  const disconnect = () => {
    setConn(null);
    setRemoteRows([]);
    setRemoteDir('/');
    setRemotePathInput('/');
    setMsg(t('filezilla.disconnected'));
  };

  // ── Local pane: a live, native local file browser via Get-ChildItem ───────────
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [localSel, setLocalSel] = useState<Record<string, boolean>>({});

  const localState = useAsync(async () => {
    let dir = localDir;
    if (dir === null) {
      const home = await runPowershell('$env:USERPROFILE');
      dir = (home.stdout || '').trim() || 'C:\\';
      setLocalDir(dir);
      setPathInput(dir);
    }
    const rows = await runPowershellJson<LocalRow>(
      [
        `$dir = '${psq(dir)}';`,
        'if (-not (Test-Path -LiteralPath $dir)) { throw "No such folder: $dir" }',
        'Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |',
        '  Sort-Object @{E={ -not $_.PSIsContainer }}, Name |',
        '  ForEach-Object {',
        '    [pscustomobject]@{',
        '      Name=$_.Name; FullPath=$_.FullName; IsDir=[bool]$_.PSIsContainer;',
        '      Size=$(if ($_.PSIsContainer) { -1 } else { [long]$_.Length });',
        "      Modified=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')",
        '    }',
        '  }',
      ].join('\n'),
    );
    return { dir, rows };
  }, [localDir]);

  const goLocal = (dir: string) => {
    setMsg(null);
    setLocalSel({});
    setLocalDir(dir);
    setPathInput(dir);
  };

  const goUp = async () => {
    const cur = localState.data?.dir;
    if (!cur) return;
    const res = await runPowershell(`(Split-Path -Parent -LiteralPath '${psq(cur)}')`);
    const parent = (res.stdout || '').trim();
    if (parent && parent !== cur) goLocal(parent);
  };

  const submitPath = () => {
    const p = pathInput.trim();
    if (p) goLocal(p);
  };

  const makeLocalFolder = async () => {
    const cur = localState.data?.dir;
    if (!cur) return;
    const name = window.prompt(t('filezilla.newFolderPrompt'));
    if (!name || !name.trim()) return;
    if (!window.confirm(t('filezilla.newFolderConfirm', { name: name.trim(), dir: cur }))) return;
    setMsg(null);
    try {
      const res = await runPowershell(
        `New-Item -ItemType Directory -Path (Join-Path '${psq(cur)}' '${psq(name.trim())}') -ErrorAction Stop | Out-Null; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('filezilla.newFolderOk', { name: name.trim() }));
      localState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.newFolderFail')}: ${String(e)}`);
    }
  };

  const renameLocal = async (r: LocalRow) => {
    const name = window.prompt(t('filezilla.renamePrompt'), r.Name);
    if (!name || !name.trim() || name.trim() === r.Name) return;
    const cur = localState.data?.dir;
    if (!cur) return;
    setMsg(null);
    try {
      const res = await runPowershell(
        `Rename-Item -LiteralPath '${psq(r.FullPath)}' -NewName '${psq(name.trim())}' -ErrorAction Stop; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('filezilla.renameOk', { name: name.trim() }));
      localState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.renameFail')}: ${String(e)}`);
    }
  };

  const deleteLocal = async (r: LocalRow) => {
    if (!window.confirm(t('filezilla.deleteLocalConfirm', { name: r.Name }))) return;
    setMsg(null);
    try {
      const res = await runPowershell(
        `Remove-Item -LiteralPath '${psq(r.FullPath)}' -Recurse -Force -ErrorAction Stop; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('filezilla.deleteOk', { name: r.Name }));
      localState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.deleteFail')}: ${String(e)}`);
    }
  };

  const localRows = localState.data?.rows ?? [];

  // ── Remote pane state ─────────────────────────────────────────────────────────
  const [remoteRows, setRemoteRows] = useState<RemoteRow[]>([]);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteSel, setRemoteSel] = useState<Record<string, boolean>>({});

  // List a remote directory. Returns rows, or null when the login/list failed.
  async function listRemote(c: Conn, dir: string): Promise<RemoteRow[] | null> {
    if (!native) return null;
    if (c.proto === 'Sftp') {
      const path = dir || '.';
      const res = await psftpBatch(c, [`cd "${path}"`, 'pwd', 'ls -l']);
      if (!res.ok && !res.stdout.trim()) return null;
      // psftp `ls -l` prints a unix-style long listing after a "Remote directory is" line.
      return parseSftpLs(res.stdout, dir);
    }
    // FTP / FTPS via curl directory listing (MLSD not universal → use LIST/`-l`).
    const url = ftpUrl(c, dir || '/', true);
    const args = [...curlAuthArgs(c), '-l', url];
    let out: { stdout: string; success: boolean; stderr: string };
    try {
      out = await runCommand('curl', args);
    } catch {
      return null;
    }
    if (!out.success && !out.stdout.trim()) return null;
    // `curl -l` gives bare names; do a second non-`-l` call for sizes when possible.
    let detail = '';
    try {
      const d = await runCommand('curl', [...curlAuthArgs(c), url]);
      detail = d.stdout ?? '';
    } catch {
      detail = '';
    }
    return parseFtpList(out.stdout, detail, dir || '/');
  }

  // Parse psftp `ls -l` output into RemoteRow[].
  function parseSftpLs(text: string, dir: string): RemoteRow[] {
    const rows: RemoteRow[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      // e.g. "drwxr-xr-x    2 user group     4096 Jan 01 12:00 name"
      const m = line.match(/^([dl-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      if (!m) continue;
      const type = m[1] ?? '-';
      const perms = m[2] ?? '';
      const size = Number(m[3] ?? '0');
      const name = (m[4] ?? '').trim();
      if (name === '.' || name === '..' || !name) continue;
      rows.push({
        Name: name,
        FullPath: combineRemote(dir, name),
        IsDir: type === 'd',
        Size: type === 'd' ? -1 : size,
        Perms: perms,
      });
    }
    rows.sort((a, b) => Number(b.IsDir) - Number(a.IsDir) || a.Name.localeCompare(b.Name));
    return rows;
  }

  // Parse a curl FTP listing. `names` from `-l` (one name per line); `detail` from a
  // LIST for sizes/dir flags (unix long format) when the server provides it.
  function parseFtpList(names: string, detail: string, dir: string): RemoteRow[] {
    const meta = new Map<string, { isDir: boolean; size: number; perms: string }>();
    for (const raw of detail.split(/\r?\n/)) {
      const line = raw.trim();
      const m = line.match(/^([dl-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      if (!m) continue;
      const nm = (m[4] ?? '').trim();
      meta.set(nm, { isDir: (m[1] ?? '-') === 'd', size: Number(m[3] ?? '0'), perms: m[2] ?? '' });
    }
    const rows: RemoteRow[] = [];
    for (const raw of names.split(/\r?\n/)) {
      const name = raw.trim();
      if (!name || name === '.' || name === '..') continue;
      const info = meta.get(name);
      rows.push({
        Name: name,
        FullPath: combineRemote(dir, name),
        IsDir: info?.isDir ?? false,
        Size: info?.isDir ? -1 : info?.size ?? -1,
        Perms: info?.perms ?? '',
      });
    }
    rows.sort((a, b) => Number(b.IsDir) - Number(a.IsDir) || a.Name.localeCompare(b.Name));
    return rows;
  }

  const refreshRemote = useCallback(
    async (dir?: string) => {
      if (!conn) return;
      const target = dir ?? remoteDir;
      setRemoteBusy(true);
      setRemoteSel({});
      try {
        const rows = await listRemote(conn, target);
        if (rows === null) throw new Error(t('filezilla.listFail'));
        setRemoteRows(rows);
        setRemoteDir(target);
        setRemotePathInput(target);
      } catch (e) {
        setMsg(`${t('filezilla.listFail')}: ${String(e)}`);
      } finally {
        setRemoteBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conn, remoteDir],
  );

  const goRemote = (dir: string) => refreshRemote(dir);
  const goRemoteUp = () => refreshRemote(parentRemote(remoteDir));
  const submitRemotePath = () => {
    const p = remotePathInput.trim() || '/';
    refreshRemote(p);
  };

  const makeRemoteFolder = async () => {
    if (!conn) return;
    const name = window.prompt(t('filezilla.newFolderPrompt'));
    if (!name || !name.trim()) return;
    if (!window.confirm(t('filezilla.newRemoteConfirm', { name: name.trim(), dir: remoteDir }))) return;
    setMsg(null);
    const target = combineRemote(remoteDir, name.trim());
    try {
      if (conn.proto === 'Sftp') {
        const r = await psftpBatch(conn, [`mkdir "${target}"`]);
        if (!r.ok) throw new Error(r.err || 'mkdir failed');
      } else {
        const r = await runCommand('curl', [...curlAuthArgs(conn), '-Q', `MKD ${target}`, ftpUrl(conn, remoteDir + '/', true)]);
        if (!r.success && !r.stdout.trim()) throw new Error(r.stderr.trim() || 'MKD failed');
      }
      setMsg(t('filezilla.newFolderOk', { name: name.trim() }));
      refreshRemote();
    } catch (e) {
      setMsg(`${t('filezilla.newFolderFail')}: ${String(e)}`);
    }
  };

  const renameRemote = async (r: RemoteRow) => {
    if (!conn) return;
    const name = window.prompt(t('filezilla.renamePrompt'), r.Name);
    if (!name || !name.trim() || name.trim() === r.Name) return;
    setMsg(null);
    const dest = combineRemote(remoteDir, name.trim());
    try {
      if (conn.proto === 'Sftp') {
        const res = await psftpBatch(conn, [`mv "${r.FullPath}" "${dest}"`]);
        if (!res.ok) throw new Error(res.err || 'rename failed');
      } else {
        const res = await runCommand('curl', [
          ...curlAuthArgs(conn),
          '-Q',
          `RNFR ${r.FullPath}`,
          '-Q',
          `RNTO ${dest}`,
          ftpUrl(conn, remoteDir + '/', true),
        ]);
        if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || 'rename failed');
      }
      setMsg(t('filezilla.renameOk', { name: name.trim() }));
      refreshRemote();
    } catch (e) {
      setMsg(`${t('filezilla.renameFail')}: ${String(e)}`);
    }
  };

  const deleteRemote = async (r: RemoteRow) => {
    if (!conn) return;
    if (!window.confirm(t('filezilla.deleteRemoteConfirm', { name: r.Name }))) return;
    setMsg(null);
    try {
      if (conn.proto === 'Sftp') {
        const cmd = r.IsDir ? `rmdir "${r.FullPath}"` : `rm "${r.FullPath}"`;
        const res = await psftpBatch(conn, [cmd]);
        if (!res.ok) throw new Error(res.err || 'delete failed');
      } else {
        const verb = r.IsDir ? 'RMD' : 'DELE';
        const res = await runCommand('curl', [...curlAuthArgs(conn), '-Q', `${verb} ${r.FullPath}`, ftpUrl(conn, remoteDir + '/', true)]);
        if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || 'delete failed');
      }
      setMsg(t('filezilla.deleteOk', { name: r.Name }));
      refreshRemote();
    } catch (e) {
      setMsg(`${t('filezilla.deleteFail')}: ${String(e)}`);
    }
  };

  // chmod on a remote file/dir (SFTP only — FTP via SITE CHMOD when the server allows).
  const chmodRemote = async (r: RemoteRow) => {
    if (!conn) return;
    const oct = window.prompt(t('filezilla.chmodPrompt', { name: r.Name }), '644');
    if (!oct || !/^[0-7]{3,4}$/.test(oct.trim())) return;
    const mode = oct.trim();
    if (!window.confirm(t('filezilla.chmodConfirm', { name: r.Name, mode, sym: octalToSymbolic(mode) }))) return;
    setMsg(null);
    try {
      if (conn.proto === 'Sftp') {
        const res = await psftpBatch(conn, [`chmod ${mode} "${r.FullPath}"`]);
        if (!res.ok) throw new Error(res.err || 'chmod failed');
      } else {
        const res = await runCommand('curl', [...curlAuthArgs(conn), '-Q', `SITE CHMOD ${mode} ${r.FullPath}`, ftpUrl(conn, remoteDir + '/', true)]);
        if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || 'SITE CHMOD failed');
      }
      setMsg(t('filezilla.chmodOk', { name: r.Name, mode }));
      refreshRemote();
    } catch (e) {
      setMsg(`${t('filezilla.chmodFail')}: ${String(e)}`);
    }
  };

  // ── Transfer queue ────────────────────────────────────────────────────────────
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [resume, setResume] = useState(true);
  const [pumping, setPumping] = useState(false);
  const cancelRef = useMemo(() => ({ current: false }), []);

  const setItem = (id: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  // Run a single upload/download via the transport CLI. Progress is coarse
  // (0 → 0.5 while running → 1 done) because psftp/curl don't stream a fraction
  // back through this bridge; the queue still shows per-item + overall state.
  const runTransfer = async (c: Conn, it: QueueItem): Promise<void> => {
    setItem(it.id, { status: 'active', progress: 0.5, detail: t('filezilla.transferring') });
    if (c.proto === 'Sftp') {
      const cmd = it.upload
        ? [`put "${it.localPath}" "${it.remotePath}"`]
        : [`get "${it.remotePath}" "${it.localPath}"`];
      if (resume && it.upload) cmd.unshift('reput on'); // psftp: reput/reget resume
      if (resume && !it.upload) cmd.unshift('reget on');
      const res = await psftpBatch(c, cmd);
      if (!res.ok && /(no such file|permission denied|failure)/i.test(res.stdout + res.err))
        throw new Error(res.err || res.stdout.slice(0, 200));
    } else {
      if (it.upload) {
        const args = [...curlAuthArgs(c), '-T', it.localPath, ftpUrl(c, it.remotePath, false)];
        if (resume) args.push('-C', '-');
        const res = await runCommand('curl', args);
        if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || 'upload failed');
      } else {
        const args = [...curlAuthArgs(c), '-o', it.localPath, ftpUrl(c, it.remotePath, false)];
        if (resume) args.push('-C', '-');
        const res = await runCommand('curl', args);
        if (!res.success) throw new Error(res.stderr.trim() || 'download failed');
      }
    }
    setItem(it.id, { status: 'done', progress: 1, detail: t('filezilla.done') });
  };

  const pumpQueue = useCallback(async () => {
    if (pumping || !conn) return;
    setPumping(true);
    cancelRef.current = false;
    // Snapshot pending ids so we drain them serially.
    const pending = queue.filter((q) => q.status === 'pending');
    for (const it of pending) {
      if (cancelRef.current) {
        setItem(it.id, { status: 'cancelled', detail: t('filezilla.cancelled') });
        continue;
      }
      try {
        await runTransfer(conn, it);
      } catch (e) {
        setItem(it.id, { status: 'failed', progress: 0, detail: String(e).slice(0, 200) });
      }
    }
    setPumping(false);
    localState.reload();
    if (conn) refreshRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pumping, conn, queue, resume]);

  const enqueueUpload = () => {
    if (!conn) return;
    const chosen = localRows.filter((r) => !r.IsDir && localSel[r.FullPath]);
    if (chosen.length === 0) {
      setMsg(t('filezilla.pickLocal'));
      return;
    }
    const items: QueueItem[] = chosen.map((r) => ({
      id: nextId(),
      upload: true,
      localPath: r.FullPath,
      remotePath: combineRemote(remoteDir, r.Name),
      fileName: r.Name,
      status: 'pending',
      progress: 0,
      detail: t('filezilla.queued'),
    }));
    setQueue((q) => [...q, ...items]);
    setMsg(t('filezilla.enqueued', { n: items.length }));
  };

  const enqueueDownload = () => {
    if (!conn) return;
    const dir = localState.data?.dir;
    if (!dir) return;
    const chosen = remoteRows.filter((r) => !r.IsDir && remoteSel[r.FullPath]);
    if (chosen.length === 0) {
      setMsg(t('filezilla.pickRemote'));
      return;
    }
    const items: QueueItem[] = chosen.map((r) => ({
      id: nextId(),
      upload: false,
      localPath: `${dir.replace(/\\+$/, '')}\\${r.Name}`,
      remotePath: r.FullPath,
      fileName: r.Name,
      status: 'pending',
      progress: 0,
      detail: t('filezilla.queued'),
    }));
    setQueue((q) => [...q, ...items]);
    setMsg(t('filezilla.enqueued', { n: items.length }));
  };

  const cancelQueue = () => {
    cancelRef.current = true;
  };
  const clearFinished = () =>
    setQueue((q) => q.filter((it) => it.status === 'pending' || it.status === 'active'));

  const queueActive = queue.filter((q) => q.status === 'pending' || q.status === 'active').length;
  const queueDone = queue.filter((q) => q.status === 'done').length;
  const overall = useMemo(() => {
    const rel = queue.filter((q) => q.status !== 'cancelled');
    if (rel.length === 0) return 0;
    return rel.reduce((s, q) => s + (q.status === 'done' ? 1 : q.progress), 0) / rel.length;
  }, [queue]);

  // ── Launch the full FileZilla desktop client ──────────────────────────────────
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  const launchFileZilla = async () => {
    setLaunchMsg(t('filezilla.launching'));
    // Resolve the installed FileZilla by name (PATH / common install dirs) then
    // launch it detached so it never blocks the UI.
    const script = [
      "$pf = [string]$env:ProgramFiles;",
      "$pfx = [string]${env:ProgramFiles(x86)};",
      '$cands = @(',
      "  'filezilla.exe',",
      "  (Join-Path $pf 'FileZilla FTP Client\\filezilla.exe'),",
      "  (Join-Path $pfx 'FileZilla FTP Client\\filezilla.exe')",
      ');',
      '$exe = $null;',
      'foreach ($c in $cands) {',
      '  if ([string]::IsNullOrEmpty($c)) { continue }',
      '  $cmd = Get-Command $c -ErrorAction SilentlyContinue;',
      '  if ($cmd) { $exe = $cmd.Source; break }',
      '  if (Test-Path -LiteralPath $c) { $exe = $c; break }',
      '}',
      'if ($exe) { Start-Process -FilePath $exe; "launched:$exe" } else { "missing" }',
    ].join('\n');
    try {
      const r = await pshell(script);
      const out = (r.stdout || '').trim();
      if (out.startsWith('launched:')) setLaunchMsg(t('filezilla.launched'));
      else setLaunchMsg(t('filezilla.launchMissing'));
    } catch (e) {
      setLaunchMsg(`${t('filezilla.launchFail')}: ${String(e)}`);
    }
  };

  // ── Table columns ─────────────────────────────────────────────────────────────
  const siteColumns: Column<Site>[] = [
    { key: 'Name', header: t('filezilla.colName') },
    { key: 'Protocol', header: t('filezilla.colProtocol'), width: 80 },
    {
      key: 'Endpoint',
      header: t('filezilla.colEndpoint'),
      render: (s) => `${s.Host || dash}:${s.Port || defaultPort(s.Protocol)}`,
    },
    { key: 'User', header: t('filezilla.colUser'), render: (s) => s.User || dash },
    {
      key: 'Auth',
      header: t('filezilla.colAuth'),
      width: 110,
      render: (s) => (s.Auth === 'KeyFile' ? t('filezilla.authKey') : t('filezilla.authPassword')),
    },
    {
      key: 'Trust',
      header: t('filezilla.colTrust'),
      width: 110,
      render: (s) => <StatusDot ok={s.Trusted} label={s.Trusted ? t('filezilla.trusted') : t('filezilla.untrusted')} />,
    },
    {
      key: 'actions',
      header: '',
      width: 260,
      render: (s) => (
        <span className="row-actions">
          <button className="mini primary" disabled={connBusy || !native || !s.Host} onClick={() => connectSite(s)}>
            {t('filezilla.connect')}
          </button>
          <button className="mini" onClick={() => openEditSite(s)}>
            {t('filezilla.edit')}
          </button>
          <button className="mini" onClick={() => deleteSite(s)}>
            {t('filezilla.delete')}
          </button>
          {reach[s.Id] === 'checking' ? (
            <span className="count-note">{t('filezilla.qcChecking')}</span>
          ) : reach[s.Id] === undefined ? (
            <button
              className="mini"
              disabled={!s.Host}
              onClick={() => probe(s.Host, s.Port || defaultPort(s.Protocol), s.Id)}
            >
              {t('filezilla.testReach')}
            </button>
          ) : (
            <StatusDot ok={reach[s.Id] === true} label={reach[s.Id] ? t('filezilla.reachable') : t('filezilla.unreachable')} />
          )}
        </span>
      ),
    },
  ];

  const localColumns: Column<LocalRow>[] = [
    {
      key: 'sel',
      header: '',
      width: 30,
      render: (r) =>
        r.IsDir ? null : (
          <input
            type="checkbox"
            checked={!!localSel[r.FullPath]}
            onChange={(e) => setLocalSel((s) => ({ ...s, [r.FullPath]: e.target.checked }))}
          />
        ),
    },
    {
      key: 'Name',
      header: t('filezilla.colName'),
      render: (r) =>
        r.IsDir ? (
          <button className="mini" style={{ textAlign: 'left' }} onClick={() => goLocal(r.FullPath)}>
            📁 {r.Name}
          </button>
        ) : (
          <span>📄 {r.Name}</span>
        ),
    },
    { key: 'Size', header: t('filezilla.colSize'), width: 90, align: 'right', render: (r) => fmtSize(r.Size, dash) },
    { key: 'Modified', header: t('filezilla.colModified'), width: 140 },
    {
      key: 'ops',
      header: '',
      width: 150,
      render: (r) => (
        <span className="row-actions">
          <button className="mini" onClick={() => renameLocal(r)}>
            {t('filezilla.rename')}
          </button>
          <button className="mini" onClick={() => deleteLocal(r)}>
            {t('filezilla.delete')}
          </button>
        </span>
      ),
    },
  ];

  const remoteColumns: Column<RemoteRow>[] = [
    {
      key: 'sel',
      header: '',
      width: 30,
      render: (r) =>
        r.IsDir ? null : (
          <input
            type="checkbox"
            checked={!!remoteSel[r.FullPath]}
            onChange={(e) => setRemoteSel((s) => ({ ...s, [r.FullPath]: e.target.checked }))}
          />
        ),
    },
    {
      key: 'Name',
      header: t('filezilla.colName'),
      render: (r) =>
        r.IsDir ? (
          <button className="mini" style={{ textAlign: 'left' }} onClick={() => goRemote(r.FullPath)}>
            📁 {r.Name}
          </button>
        ) : (
          <span>📄 {r.Name}</span>
        ),
    },
    { key: 'Size', header: t('filezilla.colSize'), width: 90, align: 'right', render: (r) => fmtSize(r.Size, dash) },
    { key: 'Perms', header: t('filezilla.colPerms'), width: 110, render: (r) => r.Perms || dash },
    {
      key: 'ops',
      header: '',
      width: 210,
      render: (r) => (
        <span className="row-actions">
          <button className="mini" onClick={() => renameRemote(r)}>
            {t('filezilla.rename')}
          </button>
          <button className="mini" onClick={() => chmodRemote(r)}>
            {t('filezilla.chmod')}
          </button>
          <button className="mini" onClick={() => deleteRemote(r)}>
            {t('filezilla.delete')}
          </button>
        </span>
      ),
    },
  ];

  const queueColumns: Column<QueueItem>[] = [
    { key: 'dir', header: '', width: 30, render: (q) => (q.upload ? '⬆' : '⬇') },
    { key: 'fileName', header: t('filezilla.colFile') },
    {
      key: 'path',
      header: t('filezilla.colPath'),
      render: (q) => (q.upload ? q.remotePath : q.localPath),
    },
    {
      key: 'progress',
      header: t('filezilla.colProgress'),
      width: 120,
      render: (q) => <progress max={1} value={q.progress} style={{ width: '100%' }} />,
    },
    { key: 'detail', header: t('filezilla.colStatus'), width: 120, render: (q) => q.detail },
  ];

  // ── Sub-tabs ──────────────────────────────────────────────────────────────────
  const tabs = [
    {
      id: 'sites',
      en: 'Site Manager',
      zh: '站台管理',
      render: () => (
        <div className="mod">
          <ModuleToolbar>
            <h3 style={{ margin: 0 }}>{t('filezilla.siteManager')}</h3>
            <button className="mini primary" onClick={openNewSite}>
              {t('filezilla.newSite')}
            </button>
            <button className="mini" onClick={sitesState.reload}>
              ⟳ {t('modules.refresh')}
            </button>
            <span className="count-note">
              {t('filezilla.siteCount', { sites: sites.length })} · {t('filezilla.trustedCount', { trusted: trustedCount })}
            </span>
          </ModuleToolbar>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('filezilla.storeNote')}
          </p>
          <AsyncState loading={sitesState.loading} error={sitesState.error}>
            <DataTable columns={siteColumns} rows={sites} rowKey={(s) => s.Id} empty={t('filezilla.noSites')} />
          </AsyncState>

          {draft && (
            <div className="hosts-edit" style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px' }}>{draft.isNew ? t('filezilla.newSite') : t('filezilla.editSite')}</h4>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <label>
                  {t('filezilla.fName')}
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label>
                  {t('filezilla.fProtocol')}
                  <select
                    value={draft.protocol}
                    onChange={(e) => {
                      const proto = e.target.value as Protocol;
                      const curPort = parseInt(draft.port, 10);
                      const nextPort =
                        curPort === 21 || curPort === 22 || !curPort ? String(defaultPort(proto)) : draft.port;
                      setDraft({ ...draft, protocol: proto, port: nextPort, auth: proto === 'Sftp' ? draft.auth : 'Password' });
                    }}
                  >
                    <option value="Sftp">SFTP</option>
                    <option value="Ftp">FTP</option>
                    <option value="Ftps">FTPS</option>
                  </select>
                </label>
                <label>
                  {t('filezilla.fHost')}
                  <input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
                </label>
                <label>
                  {t('filezilla.fPort')}
                  <input
                    style={{ width: 70 }}
                    value={draft.port}
                    onChange={(e) => setDraft({ ...draft, port: e.target.value.replace(/[^\d]/g, '') })}
                  />
                </label>
                <label>
                  {t('filezilla.fUser')}
                  <input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
                </label>
                {draft.protocol === 'Sftp' && (
                  <label>
                    {t('filezilla.fAuth')}
                    <select
                      value={draft.auth}
                      onChange={(e) => setDraft({ ...draft, auth: e.target.value as 'Password' | 'KeyFile' })}
                    >
                      <option value="Password">{t('filezilla.authPassword')}</option>
                      <option value="KeyFile">{t('filezilla.authKey')}</option>
                    </select>
                  </label>
                )}
                <label>
                  {t('filezilla.fPassword')}
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={draft.isNew ? '' : t('filezilla.keepSecret')}
                    value={draft.password}
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  />
                </label>
                {draft.protocol === 'Sftp' && draft.auth === 'KeyFile' && (
                  <label>
                    {t('filezilla.fKeyFile')}
                    <input value={draft.keyFile} onChange={(e) => setDraft({ ...draft, keyFile: e.target.value })} />
                  </label>
                )}
                <label>
                  {t('filezilla.fRemoteDir')}
                  <input value={draft.remoteDir} onChange={(e) => setDraft({ ...draft, remoteDir: e.target.value })} />
                </label>
              </div>
              <div className="mod-toolbar">
                <button className="mini primary" disabled={savingSite} onClick={saveSite}>
                  {t('filezilla.save')}
                </button>
                <button className="mini" disabled={savingSite} onClick={() => setDraft(null)}>
                  {t('filezilla.cancel')}
                </button>
              </div>
              <p className="count-note" style={{ marginTop: 4 }}>
                {t('filezilla.secretNote')}
              </p>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'transfer',
      en: 'Transfer',
      zh: '傳輸',
      render: () => (
        <div className="mod">
          {/* Quickconnect bar */}
          <section>
            <h3>{t('filezilla.quickconnect')}</h3>
            <div className="mod-toolbar hosts-edit">
              <select value={qcProto} onChange={(e) => setQcProto(e.target.value as Protocol)}>
                <option value="Sftp">SFTP</option>
                <option value="Ftp">FTP</option>
                <option value="Ftps">FTPS</option>
              </select>
              <input className="mod-search" placeholder={t('filezilla.host')} value={qcHost} onChange={(e) => setQcHost(e.target.value)} />
              <input
                style={{ width: 70 }}
                placeholder={t('filezilla.port')}
                value={qcPort}
                onChange={(e) => setQcPort(e.target.value.replace(/[^\d]/g, ''))}
              />
              <input className="mod-search" placeholder={t('filezilla.user')} value={qcUser} onChange={(e) => setQcUser(e.target.value)} />
              <input
                className="mod-search"
                type="password"
                autoComplete="new-password"
                placeholder={t('filezilla.password')}
                value={qcPass}
                onChange={(e) => setQcPass(e.target.value)}
              />
              <button className="mini primary" disabled={connBusy} onClick={quickConnect}>
                {t('filezilla.connect')}
              </button>
              <button className="mini" disabled={qcBusy} onClick={quickCheck}>
                {t('filezilla.testConnection')}
              </button>
              {conn && (
                <button className="mini" onClick={disconnect}>
                  {t('filezilla.disconnect')}
                </button>
              )}
            </div>
            {qcResult && (
              <p className="count-note" style={{ marginTop: 4 }}>
                {qcResult}
              </p>
            )}
            {conn && (
              <p className="count-note" style={{ marginTop: 4 }}>
                <StatusDot ok label={t('filezilla.connected', { proto: conn.proto, host: conn.host })} />
              </p>
            )}
          </section>

          {/* Dual pane */}
          <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* Local pane */}
            <div style={{ flex: '1 1 340px', minWidth: 300 }}>
              <ModuleToolbar>
                <h4 style={{ margin: 0 }}>{t('filezilla.localPane')}</h4>
                <button className="mini" onClick={goUp}>
                  ↑ {t('filezilla.up')}
                </button>
                <button className="mini" onClick={makeLocalFolder}>
                  {t('filezilla.newFolder')}
                </button>
                <button className="mini" onClick={localState.reload}>
                  ⟳
                </button>
                <button className="mini primary" disabled={!conn} onClick={enqueueUpload}>
                  {t('filezilla.upload')} ⬆
                </button>
              </ModuleToolbar>
              <div className="mod-toolbar">
                <input
                  className="mod-search"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitPath();
                  }}
                  placeholder={t('filezilla.pathPlaceholder')}
                />
                <button className="mini" onClick={submitPath}>
                  {t('filezilla.go')}
                </button>
              </div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {localState.data?.dir ?? dash} · {t('filezilla.itemCount', { items: localRows.length })}
              </p>
              <AsyncState loading={localState.loading} error={localState.error}>
                <DataTable columns={localColumns} rows={localRows} rowKey={(r) => r.FullPath} empty={t('filezilla.emptyFolder')} />
              </AsyncState>
            </div>

            {/* Remote pane */}
            <div style={{ flex: '1 1 340px', minWidth: 300 }}>
              <ModuleToolbar>
                <h4 style={{ margin: 0 }}>{t('filezilla.remotePane')}</h4>
                <button className="mini" disabled={!conn} onClick={goRemoteUp}>
                  ↑ {t('filezilla.up')}
                </button>
                <button className="mini" disabled={!conn} onClick={makeRemoteFolder}>
                  {t('filezilla.newFolder')}
                </button>
                <button className="mini" disabled={!conn} onClick={() => refreshRemote()}>
                  ⟳
                </button>
                <button className="mini primary" disabled={!conn} onClick={enqueueDownload}>
                  ⬇ {t('filezilla.download')}
                </button>
              </ModuleToolbar>
              <div className="mod-toolbar">
                <input
                  className="mod-search"
                  value={remotePathInput}
                  disabled={!conn}
                  onChange={(e) => setRemotePathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRemotePath();
                  }}
                  placeholder={t('filezilla.remotePathPlaceholder')}
                />
                <button className="mini" disabled={!conn} onClick={submitRemotePath}>
                  {t('filezilla.go')}
                </button>
              </div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {conn ? remoteDir : t('filezilla.notConnected')} ·{' '}
                {remoteBusy ? t('filezilla.qcChecking') : t('filezilla.itemCount', { items: remoteRows.length })}
              </p>
              {!conn ? (
                <p className="count-note">{t('filezilla.connectFirst')}</p>
              ) : (
                <DataTable columns={remoteColumns} rows={remoteRows} rowKey={(r) => r.FullPath} empty={t('filezilla.emptyFolder')} />
              )}
            </div>
          </section>

          {/* Transfer queue */}
          <section>
            <ModuleToolbar>
              <h4 style={{ margin: 0 }}>{t('filezilla.queueTitle')}</h4>
              <label className="count-note">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} /> {t('filezilla.resume')}
              </label>
              <button className="mini primary" disabled={pumping || !conn || queueActive === 0} onClick={pumpQueue}>
                {t('filezilla.startQueue')}
              </button>
              <button className="mini" disabled={!pumping} onClick={cancelQueue}>
                {t('filezilla.cancelTransfer')}
              </button>
              <button className="mini" onClick={clearFinished}>
                {t('filezilla.clearFinished')}
              </button>
              <span className="count-note">{t('filezilla.queueStat', { queued: queueActive, done: queueDone })}</span>
            </ModuleToolbar>
            <progress max={1} value={overall} style={{ display: 'block', width: '100%', maxWidth: 320 }} />
            <DataTable columns={queueColumns} rows={queue} rowKey={(q) => q.id} empty={t('filezilla.queueEmpty')} />
          </section>
        </div>
      ),
    },
    {
      id: 'help',
      en: 'About & help',
      zh: '關於與說明',
      render: () => (
        <div className="mod">
          <section>
            <h3>{t('filezilla.launchTitle')}</h3>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('filezilla.launchBody')}
            </p>
            <div className="mod-toolbar">
              <button className="mini primary" disabled={!native} onClick={launchFileZilla}>
                {t('filezilla.launchBtn')}
              </button>
            </div>
            {launchMsg && (
              <p className="count-note" style={{ marginTop: 4 }}>
                {launchMsg}
              </p>
            )}
          </section>
          <section>
            <h3>{t('filezilla.protocolsTitle')}</h3>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('filezilla.protocolsBody')}
            </p>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('filezilla.transportBody')}
            </p>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('filezilla.securityBody')}
            </p>
          </section>
        </div>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('filezilla.subtitle')}
      </p>
      {!native && <p className="count-note">{t('filezilla.previewNote')}</p>}
      {msg && <p className="mod-msg">{msg}</p>}
      <ModuleTabs tabs={tabs} />
    </div>
  );
}
