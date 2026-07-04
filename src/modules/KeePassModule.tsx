import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// Native port of WinForge's "KeePass Vault" module (Pages/KeePassModule.xaml(.cs) +
// Services/KeePassService.cs). The desktop module ships a pure-managed KDBX 3.1/4 engine that opens,
// edits and saves .kdbx databases in-app (AES-KDF/Argon2d, ChaCha20/AES-CBC, HMAC block streams).
// Re-implementing that crypto engine inside the web shell is impractical, so — matching the
// resolveTool convention used across winforge-web for password managers — the LIVE editing path here
// drives `keepassxc-cli`, the official KeePassXC command-line tool, which speaks the exact same KDBX
// format the desktop engine does. The master password is piped to the CLI's stdin through a transient
// PowerShell process: it is NEVER written to argv, to disk, to a temp file, or to any log.
//
// Feature parity with the C# page:
//   • Open a .kdbx with a master password (and optional key file); create a new vault; lock (which
//     wipes all decrypted state and the in-memory password from React state).
//   • Group tree + entry list (title / username / URL), full entry detail (title, user, URL, notes,
//     custom fields, modified time), masked password with a gated reveal and 12s-auto-clear copy.
//   • Search across every entry in the vault.
//   • Add / edit / delete entries and add groups — every mutation is click-gated; delete confirms.
//   • Built-in password generator with the desktop's exact char pools, one-of-each guarantee, CSPRNG
//     and Fisher-Yates shuffle, plus an entropy/strength read-out.
//   • The original read-only companion: a filesystem scan for real .kdbx vaults + KeePass tool
//     detection, kept intact so the module is useful even before a vault is unlocked.
// Bilingual throughout. Nothing is uploaded; no secret is ever logged.

// ── Password generator (exact port of KeePassModule.GeneratePassword) ─────────
const POOL_U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const POOL_L = 'abcdefghijkmnopqrstuvwxyz';
const POOL_D = '23456789';
const POOL_S = '!@#$%^&*()-_=+[]{};:,.?/';

function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0] ?? 0;
  } while (v >= limit);
  return v % maxExclusive;
}

function generatePassword(
  length: number,
  upper: boolean,
  lower: boolean,
  digits: boolean,
  symbols: boolean,
): string {
  const pools: string[] = [];
  if (upper) pools.push(POOL_U);
  if (lower) pools.push(POOL_L);
  if (digits) pools.push(POOL_D);
  if (symbols) pools.push(POOL_S);
  if (pools.length === 0) pools.push(POOL_L);
  let len = length;
  if (len < pools.length) len = pools.length;

  const all = pools.join('');
  const chars: string[] = new Array(len);
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i] ?? POOL_L;
    chars[i] = pool[randInt(pool.length)] ?? 'a';
  }
  for (let i = pools.length; i < len; i++) {
    chars[i] = all[randInt(all.length)] ?? 'a';
  }
  for (let i = len - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = chars[i] ?? 'a';
    chars[i] = chars[j] ?? 'a';
    chars[j] = tmp;
  }
  return chars.join('');
}

function entropyBits(length: number, poolSize: number): number {
  if (length <= 0 || poolSize <= 1) return 0;
  return Math.round(length * (Math.log(poolSize) / Math.log(2)));
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + (units[u] ?? 'TB');
}

// ── Clipboard helpers (12s auto-clear, mirrors the desktop DispatcherTimer) ────
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the native bridge */
  }
  if (!isTauri()) return false;
  const b64 = btoa(unescape(encodeURIComponent(text)));
  if (b64.length > 24000) return false;
  const res = await runPowershell(
    "$t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" +
      b64 +
      "')); Set-Clipboard -Value $t",
  );
  return res.success;
}

async function clearClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText('');
    return;
  } catch {
    /* fall through */
  }
  if (isTauri()) {
    try {
      await runPowershell('Set-Clipboard -Value \x27 \x27');
    } catch {
      /* best effort */
    }
  }
}

const CLIP_CLEAR_MS = 12000;

function normStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// PowerShell single-quote escaping for values we must inline (never the password/key-file — those go
// via stdin/env only). Doubles every ' per PS literal-string rules.
function psq(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// ── keepassxc-cli bridge ──────────────────────────────────────────────────────
// keepassxc-cli reads the database password from stdin when it is not a TTY. We start it through a
// ProcessStartInfo with RedirectStandardInput and write the password there once, so the secret only
// ever lives in a transient child process — never in argv, a file, or a log. The password and any
// key-file path are base64-encoded before being embedded in the PS script text so no readable
// secret appears in the composed command, then decoded in-process.

interface CliResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `keepassxc-cli <args>` with the master password fed on stdin.
 * @param args   CLI argument vector (db path + flags). Passed as a PS array; no shell parsing.
 * @param pw     master password (may be empty when only a key file is used).
 * @param extraStdin extra lines written to stdin after the password (e.g. a new entry's password for `add -p`).
 */
async function kpcli(args: string[], pw: string, extraStdin: string[] = []): Promise<CliResult> {
  if (!isTauri()) {
    return { ok: false, code: -1, stdout: '', stderr: 'not-tauri' };
  }
  const argsLiteral = '@(' + args.map(psq).join(',') + ')';
  const pwB64 = btoa(unescape(encodeURIComponent(pw)));
  const extraB64 = extraStdin.map((l) => btoa(unescape(encodeURIComponent(l))));
  const extraArr = '@(' + extraB64.map((b) => psq(b)).join(',') + ')';
  const script =
    `try {` +
    `$OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$pw=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pwB64}'));` +
    `$extra=${extraArr} | ForEach-Object { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_)) };` +
    `$psi=New-Object System.Diagnostics.ProcessStartInfo;` +
    `$psi.FileName='keepassxc-cli';` +
    `foreach ($a in ${argsLiteral}) { [void]$psi.ArgumentList.Add($a) }` +
    `$psi.UseShellExecute=$false; $psi.CreateNoWindow=$true;` +
    `$psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true;` +
    `$psi.StandardOutputEncoding=[System.Text.Encoding]::UTF8; $psi.StandardErrorEncoding=[System.Text.Encoding]::UTF8;` +
    `$p=[System.Diagnostics.Process]::Start($psi);` +
    `$p.StandardInput.WriteLine($pw);` +
    `foreach ($e in $extra) { $p.StandardInput.WriteLine($e) }` +
    `$p.StandardInput.Close();` +
    `$so=$p.StandardOutput.ReadToEnd(); $se=$p.StandardError.ReadToEnd();` +
    `$p.WaitForExit(30000) | Out-Null;` +
    `[pscustomobject]@{ ok=($p.ExitCode -eq 0); code=$p.ExitCode; stdout=$so; stderr=$se } | ConvertTo-Json -Compress` +
    `} catch { [pscustomobject]@{ ok=$false; code=-1; stdout=''; stderr=$_.Exception.Message } | ConvertTo-Json -Compress }`;
  const res = await runPowershell(script);
  const text = (res.stdout ?? '').trim();
  if (!text) {
    return { ok: false, code: -1, stdout: '', stderr: (res.stderr ?? '').trim() || 'keepassxc-cli failed' };
  }
  try {
    const j = JSON.parse(text) as Partial<CliResult>;
    return {
      ok: !!j.ok,
      code: typeof j.code === 'number' ? j.code : -1,
      stdout: normStr(j.stdout),
      stderr: normStr(j.stderr),
    };
  } catch {
    return { ok: false, code: -1, stdout: '', stderr: 'unparseable keepassxc-cli output' };
  }
}

// Build the common trailing flags: -k <keyfile> when a key file is chosen, and --no-password when the
// password is empty (key-file-only vaults).
function keyFlags(keyFile: string, pw: string): string[] {
  const out: string[] = [];
  if (keyFile) out.push('-k', keyFile);
  if (!pw) out.push('--no-password');
  return out;
}

// ── Vault model (parsed from keepassxc-cli `ls -R` + `show`) ───────────────────
interface KpEntry {
  path: string; // full CLI path, e.g. "General/Email"
  group: string; // parent group path, e.g. "General"
  title: string;
}
interface KpGroupNode {
  path: string; // "" for root, "General", "General/Work", …
  name: string;
  children: KpGroupNode[];
  entries: KpEntry[];
}
interface EntryDetail {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  modified: string;
  extra: { key: string; value: string; masked: boolean }[];
}

const KNOWN_FIELDS = new Set([
  'Title',
  'UserName',
  'Password',
  'URL',
  'Notes',
  'Uuid',
  'Tags',
  'Last Modified',
  'Created',
]);

// keepassxc-cli `ls -R -f` prints a recursive listing; groups end in "/". We reconstruct the tree by
// tracking the group prefix that each line belongs to. `-f` shows the full path so we get an
// unambiguous parent for every entry.
function parseTree(raw: string): KpGroupNode {
  const root: KpGroupNode = { path: '', name: '/', children: [], entries: [] };
  const byPath = new Map<string, KpGroupNode>();
  byPath.set('', root);

  const ensureGroup = (full: string): KpGroupNode => {
    const clean = full.replace(/\/+$/, '');
    if (clean === '') return root;
    const existing = byPath.get(clean);
    if (existing) return existing;
    const idx = clean.lastIndexOf('/');
    const parentPath = idx >= 0 ? clean.slice(0, idx) : '';
    const name = idx >= 0 ? clean.slice(idx + 1) : clean;
    const parent = ensureGroup(parentPath);
    const node: KpGroupNode = { path: clean, name, children: [], entries: [] };
    parent.children.push(node);
    byPath.set(clean, node);
    return node;
  };

  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.endsWith('/')) {
      ensureGroup(line);
    } else {
      const idx = line.lastIndexOf('/');
      const groupPath = idx >= 0 ? line.slice(0, idx) : '';
      const title = idx >= 0 ? line.slice(idx + 1) : line;
      const group = ensureGroup(groupPath);
      group.entries.push({ path: line, group: groupPath, title });
    }
  }
  return root;
}

function flattenGroups(node: KpGroupNode, out: KpGroupNode[] = []): KpGroupNode[] {
  out.push(node);
  for (const c of node.children) flattenGroups(c, out);
  return out;
}
function allEntries(node: KpGroupNode, out: KpEntry[] = []): KpEntry[] {
  for (const e of node.entries) out.push(e);
  for (const c of node.children) allEntries(c, out);
  return out;
}

// Parse `keepassxc-cli show -s <db> <path>` output ("Key: value" lines; Notes/multi-line trail).
function parseDetail(raw: string, showProtected: boolean): EntryDetail {
  const d: EntryDetail = {
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    modified: '',
    extra: [],
  };
  const lines = raw.split(/\r?\n/);
  let notesMode = false;
  const notesLines: string[] = [];
  for (const line of lines) {
    if (notesMode) {
      notesLines.push(line);
      continue;
    }
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? '').trim();
    const val = m[2] ?? '';
    switch (key) {
      case 'Title':
        d.title = val;
        break;
      case 'UserName':
        d.username = val;
        break;
      case 'Password':
        d.password = showProtected ? val : '';
        break;
      case 'URL':
        d.url = val;
        break;
      case 'Last Modified':
        d.modified = val;
        break;
      case 'Notes':
        d.notes = val;
        notesMode = true;
        break;
      default:
        if (!KNOWN_FIELDS.has(key)) {
          d.extra.push({ key, value: val, masked: false });
        }
        break;
    }
  }
  if (notesLines.length) {
    d.notes = [d.notes, ...notesLines].filter((s) => s.length).join('\n');
  }
  return d;
}

// ── Read-only vault scan (kept from the original module) ──────────────────────
const SCAN_PS = String.raw`
$roots = @(
  $env:USERPROFILE,
  (Join-Path $env:USERPROFILE 'Documents'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:USERPROFILE 'Downloads'),
  $env:OneDrive,
  $env:OneDriveConsumer,
  $env:OneDriveCommercial
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$seen = @{}
$out = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  try {
    $files = Get-ChildItem -LiteralPath $r -Filter *.kdbx -File -Recurse -Depth 5 -Force -ErrorAction SilentlyContinue |
      Select-Object -First 400
  } catch { $files = @() }
  foreach ($f in $files) {
    if ($seen.ContainsKey($f.FullName)) { continue }
    $seen[$f.FullName] = $true
    $ver = ''; $valid = $false
    try {
      $fs = [System.IO.File]::OpenRead($f.FullName)
      try {
        $hdr = New-Object byte[] 12
        $n = $fs.Read($hdr, 0, 12)
        if ($n -ge 12) {
          $sig1 = [System.BitConverter]::ToUInt32($hdr, 0)
          $sig2 = [System.BitConverter]::ToUInt32($hdr, 4)
          if ($sig1 -eq 0x9AA2D903 -and $sig2 -eq 0xB54BFB67) {
            $valid = $true
            $minor = [System.BitConverter]::ToUInt16($hdr, 8)
            $major = [System.BitConverter]::ToUInt16($hdr, 10)
            $ver = "$major.$minor"
          }
        }
      } finally { $fs.Close() }
    } catch {}
    [void]$out.Add([pscustomobject]@{
      Path = $f.FullName
      Name = $f.Name
      Dir = $f.DirectoryName
      Size = [long]$f.Length
      Modified = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
      Version = $ver
      Valid = $valid
    })
  }
}
$out | Sort-Object Modified -Descending | Select-Object -First 500
`;

const TOOLS_PS = String.raw`
function Find-App([string]$pattern) {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    $hit = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like $pattern } | Select-Object -First 1
    if ($hit) { return ($hit.DisplayName + ' ' + $hit.DisplayVersion).Trim() }
  }
  return ''
}
$kp = Find-App 'KeePass*'
if (-not $kp) { $cmd = Get-Command keepass.exe -ErrorAction SilentlyContinue; if ($cmd) { $kp = $cmd.Source } }
$xc = Find-App 'KeePassXC*'
if (-not $xc) { $cmd = Get-Command keepassxc.exe -ErrorAction SilentlyContinue; if ($cmd) { $xc = $cmd.Source } }
@(
  [pscustomobject]@{ Name = 'KeePass 2.x'; Found = [bool]$kp; Detail = $kp },
  [pscustomobject]@{ Name = 'KeePassXC';   Found = [bool]$xc; Detail = $xc }
)
`;

interface KdbxFile {
  Path: string;
  Name: string;
  Dir: string;
  Size: number;
  Modified: string;
  Version: string;
  Valid: boolean;
}
interface ToolInfo {
  Name: string;
  Found: boolean;
  Detail: string;
}

// ── Password generator sub-panel ──────────────────────────────────────────────
function GeneratorPanel({
  onCopy,
  copyLabelHost,
}: {
  onCopy: (value: string) => void;
  copyLabelHost: string | null;
}) {
  const { t } = useTranslation();
  const [genLen, setGenLen] = useState(20);
  const [genUpper, setGenUpper] = useState(true);
  const [genLower, setGenLower] = useState(true);
  const [genDigits, setGenDigits] = useState(true);
  const [genSymbols, setGenSymbols] = useState(true);
  const [password, setPassword] = useState('');

  const poolSize = useMemo(() => {
    let n = 0;
    if (genUpper) n += POOL_U.length;
    if (genLower) n += POOL_L.length;
    if (genDigits) n += POOL_D.length;
    if (genSymbols) n += POOL_S.length;
    return n || POOL_L.length;
  }, [genUpper, genLower, genDigits, genSymbols]);

  const regen = () =>
    setPassword(generatePassword(genLen, genUpper, genLower, genDigits, genSymbols));

  useEffect(() => {
    setPassword(generatePassword(genLen, genUpper, genLower, genDigits, genSymbols));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genLen, genUpper, genLower, genDigits, genSymbols]);

  const bits = entropyBits(password.length, poolSize);
  const strengthKey = bits >= 128 ? 'strongVery' : bits >= 80 ? 'strong' : bits >= 60 ? 'fair' : 'weak';

  return (
    <div className="hosts-edit" style={{ marginBottom: 16 }}>
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
        {t('keepass.generatorTitle')}
      </h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <code
          style={{
            flex: '1 1 260px',
            minWidth: 220,
            padding: '8px 10px',
            fontSize: 15,
            wordBreak: 'break-all',
            background: 'var(--card-2, rgba(127,127,127,0.12))',
            borderRadius: 6,
          }}
        >
          {password || '—'}
        </code>
        <button className="mini primary" onClick={regen}>
          {t('keepass.regenerate')}
        </button>
        <button className="mini" onClick={() => onCopy(password)} disabled={!password}>
          {copyLabelHost ? t('keepass.copyInto', { field: copyLabelHost }) : t('keepass.copy')}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('keepass.length')}
          <input
            type="range"
            min={4}
            max={128}
            value={genLen}
            onChange={(e) => setGenLen(Number(e.target.value))}
          />
          <input
            type="number"
            min={4}
            max={128}
            value={genLen}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setGenLen(Math.min(128, Math.max(4, Math.round(n))));
            }}
            style={{ width: 64 }}
          />
        </label>
        <span className="badge">{t('keepass.entropy', { bits })}</span>
        <span className={'badge ' + (bits >= 80 ? 'tone-ok' : bits >= 60 ? 'tone-warn' : 'tone-danger')}>
          {t('keepass.strength.' + strengthKey)}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={genUpper} onChange={(e) => setGenUpper(e.target.checked)} />
          {t('keepass.upper')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={genLower} onChange={(e) => setGenLower(e.target.checked)} />
          {t('keepass.lower')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={genDigits} onChange={(e) => setGenDigits(e.target.checked)} />
          {t('keepass.digits')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={genSymbols} onChange={(e) => setGenSymbols(e.target.checked)} />
          {t('keepass.symbols')}
        </label>
      </div>
    </div>
  );
}

// ── Vault-scan sub-panel (read-only, from the original module) ────────────────
function ScanPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const { data: files, loading, error, reload } = useAsync<KdbxFile[]>(async () => {
    if (!isTauri()) return [];
    return runPowershellJson<KdbxFile>(SCAN_PS);
  }, []);

  const { data: tools } = useAsync<ToolInfo[]>(async () => {
    if (!isTauri()) return [];
    return runPowershellJson<ToolInfo>(TOOLS_PS);
  }, []);

  const rows = useMemo(() => {
    const all = files ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((f) => (f.Name + ' ' + f.Dir).toLowerCase().includes(q)) : all;
  }, [files, filter]);

  const columns: Column<KdbxFile>[] = [
    {
      key: 'Name',
      header: t('keepass.colName'),
      render: (f) => (
        <span>
          <strong>{f.Name}</strong>
          <br />
          <span className="count-note" style={{ wordBreak: 'break-all' }}>
            {f.Dir}
          </span>
        </span>
      ),
    },
    {
      key: 'Version',
      header: t('keepass.colVersion'),
      width: 130,
      render: (f) =>
        f.Valid ? (
          <StatusDot ok label={f.Version ? 'KDBX ' + f.Version : 'KDBX'} />
        ) : (
          <StatusDot ok={false} label={t('keepass.notKdbx')} />
        ),
    },
    { key: 'Size', header: t('keepass.colSize'), width: 100, align: 'right', render: (f) => fmtBytes(f.Size) },
    { key: 'Modified', header: t('keepass.colModified'), width: 150 },
    {
      key: 'actions',
      header: '',
      width: 120,
      render: (f) => (
        <span className="row-actions">
          <button
            className="mini"
            onClick={() =>
              void copyText(f.Path).then((ok) => onMsg(ok ? t('keepass.pathCopied') : t('keepass.copyFailed')))
            }
          >
            {t('keepass.copyPath')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '0 0 12px' }}>
        {(tools ?? []).map((tool) => (
          <span key={tool.Name} title={normStr(tool.Detail)}>
            <StatusDot
              ok={tool.Found}
              label={tool.Name + (tool.Found ? '' : ' · ' + t('keepass.notInstalled'))}
            />
          </span>
        ))}
      </div>
      <h3 className="group-title" style={{ fontSize: 15, margin: '4px 0 8px' }}>
        {t('keepass.vaultsTitle')}
      </h3>
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('keepass.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload} disabled={loading}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('keepass.vaultCount', { num: rows.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('keepass.scanNote')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(f) => f.Path} empty={t('keepass.noVaults')} />
      </AsyncState>
    </div>
  );
}

// ── Vault editor sub-panel (the LIVE keepassxc-cli path) ──────────────────────
interface EntryForm {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}
const EMPTY_FORM: EntryForm = { title: '', username: '', password: '', url: '', notes: '' };

function VaultPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const { t } = useTranslation();
  const desktop = isTauri();

  // Locked vs. unlocked state. The password lives ONLY in this ref while unlocked, and is wiped on
  // lock. It is never rendered, logged, or persisted.
  const pwRef = useRef<string>('');
  const [dbPath, setDbPath] = useState('');
  const [keyFile, setKeyFile] = useState('');
  const [pwInput, setPwInput] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const [tree, setTree] = useState<KpGroupNode | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>(''); // group path
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null); // full CLI path
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [search, setSearch] = useState('');

  // Editor dialog state.
  const [editorOpen, setEditorOpen] = useState<'add' | 'edit' | 'group' | null>(null);
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM);
  const [groupName, setGroupName] = useState('');

  const clipTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(clipTimer.current), []);

  const copySecret = useCallback(
    async (value: string) => {
      if (!value) return;
      const ok = await copyText(value);
      if (!ok) {
        onMsg(t('keepass.copyFailed'));
        return;
      }
      window.clearTimeout(clipTimer.current);
      clipTimer.current = window.setTimeout(() => {
        void clearClipboard();
        onMsg(t('keepass.clipCleared'));
      }, CLIP_CLEAR_MS);
      onMsg(t('keepass.copiedClears'));
    },
    [onMsg, t],
  );

  const copyPlain = useCallback(
    async (value: string, toast: string) => {
      if (!value) return;
      const ok = await copyText(value);
      onMsg(ok ? toast : t('keepass.copyFailed'));
    },
    [onMsg, t],
  );

  // Reload the group tree via `ls -R -f`.
  const loadTree = useCallback(
    async (path: string, pw: string, kf: string): Promise<KpGroupNode | null> => {
      const res = await kpcli(['ls', path, '-R', '-f', ...keyFlags(kf, pw)], pw);
      if (!res.ok) {
        setOpenErr(res.stderr.trim() || t('keepass.openFailed'));
        return null;
      }
      const root = parseTree(res.stdout);
      setTree(root);
      return root;
    },
    [t],
  );

  // Open / unlock.
  const doOpen = useCallback(async () => {
    if (!dbPath.trim()) {
      setOpenErr(t('keepass.chooseFirst'));
      return;
    }
    if (!pwInput && !keyFile) {
      setOpenErr(t('keepass.needCred'));
      return;
    }
    setBusy(true);
    setOpenErr(null);
    try {
      const pw = pwInput;
      const root = await loadTree(dbPath.trim(), pw, keyFile);
      if (!root) return;
      pwRef.current = pw;
      setPwInput(''); // do not keep the password in an input's state
      setUnlocked(true);
      setSelectedGroup('');
      setSelectedEntry(null);
      setDetail(null);
      onMsg(t('keepass.opened'));
    } catch (e) {
      setOpenErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [dbPath, pwInput, keyFile, loadTree, onMsg, t]);

  // Lock — wipe every decrypted trace and the master password.
  const doLock = useCallback(() => {
    window.clearTimeout(clipTimer.current);
    void clearClipboard();
    pwRef.current = '';
    setPwInput('');
    setUnlocked(false);
    setTree(null);
    setSelectedGroup('');
    setSelectedEntry(null);
    setDetail(null);
    setRevealed(false);
    setSearch('');
    setEditorOpen(null);
    onMsg(t('keepass.locked'));
  }, [onMsg, t]);

  // Reload the tree after a mutation.
  const refreshTree = useCallback(async () => {
    if (!unlocked) return;
    await loadTree(dbPath.trim(), pwRef.current, keyFile);
  }, [unlocked, dbPath, keyFile, loadTree]);

  // Show an entry's detail. Password only fetched (unmasked) when the user reveals it.
  const openEntry = useCallback(
    async (entryPath: string, reveal: boolean) => {
      if (!unlocked) return;
      setBusy(true);
      try {
        const args = ['show', dbPath.trim(), entryPath, ...keyFlags(keyFile, pwRef.current)];
        if (reveal) args.push('-s'); // -s reveals protected attributes (the password)
        const res = await kpcli(args, pwRef.current);
        if (!res.ok) {
          onMsg(res.stderr.trim() || t('keepass.showFailed'));
          return;
        }
        setDetail(parseDetail(res.stdout, reveal));
        setSelectedEntry(entryPath);
        setRevealed(reveal);
      } finally {
        setBusy(false);
      }
    },
    [unlocked, dbPath, keyFile, onMsg, t],
  );

  const toggleReveal = useCallback(() => {
    if (!selectedEntry) return;
    void openEntry(selectedEntry, !revealed);
  }, [selectedEntry, revealed, openEntry]);

  // Copy the password: fetch it unmasked via `show -s -a Password`, copy, arm the 12s clear.
  const copyEntryPassword = useCallback(async () => {
    if (!selectedEntry) return;
    setBusy(true);
    try {
      const res = await kpcli(
        ['show', dbPath.trim(), selectedEntry, '-s', '-a', 'Password', ...keyFlags(keyFile, pwRef.current)],
        pwRef.current,
      );
      if (!res.ok) {
        onMsg(res.stderr.trim() || t('keepass.showFailed'));
        return;
      }
      await copySecret(res.stdout.replace(/\r?\n$/, ''));
    } finally {
      setBusy(false);
    }
  }, [selectedEntry, dbPath, keyFile, onMsg, t, copySecret]);

  // Add / edit entry through keepassxc-cli. The new password (if any) is written on stdin after the
  // db password — never on argv.
  const submitEntry = useCallback(async () => {
    const title = form.title.trim();
    if (!title) {
      onMsg(t('keepass.titleRequired'));
      return;
    }
    setBusy(true);
    try {
      const isAdd = editorOpen === 'add';
      // Target path: for add, <group>/<title>; for edit, the existing selected path.
      const targetPath = isAdd
        ? (selectedGroup ? selectedGroup + '/' : '') + title
        : selectedEntry ?? title;
      const args: string[] = [isAdd ? 'add' : 'edit', dbPath.trim(), targetPath];
      const extraStdin: string[] = [];
      if (!isAdd && form.title.trim() && selectedEntry) {
        // rename via -t when title changed
        const oldTitle = selectedEntry.slice(selectedEntry.lastIndexOf('/') + 1);
        if (oldTitle !== title) args.push('-t', title);
      }
      args.push('-u', form.username);
      if (form.url) args.push('--url', form.url);
      if (form.notes) args.push('--notes', form.notes);
      if (form.password) {
        args.push('-p'); // prompt for password → read from stdin (second line)
        extraStdin.push(form.password);
      }
      args.push(...keyFlags(keyFile, pwRef.current));
      const res = await kpcli(args, pwRef.current, extraStdin);
      if (!res.ok) {
        onMsg(res.stderr.trim() || t('keepass.saveFailed'));
        return;
      }
      setEditorOpen(null);
      setForm(EMPTY_FORM);
      await refreshTree();
      const newPath = isAdd ? targetPath : selectedEntry;
      if (newPath) await openEntry(newPath, false);
      onMsg(isAdd ? t('keepass.entryAdded') : t('keepass.entryUpdated'));
    } finally {
      setBusy(false);
    }
  }, [form, editorOpen, selectedGroup, selectedEntry, dbPath, keyFile, refreshTree, openEntry, onMsg, t]);

  // Add group via `mkdir`.
  const submitGroup = useCallback(async () => {
    const name = groupName.trim();
    if (!name) {
      onMsg(t('keepass.groupNameRequired'));
      return;
    }
    setBusy(true);
    try {
      const path = (selectedGroup ? selectedGroup + '/' : '') + name;
      const res = await kpcli(['mkdir', dbPath.trim(), path, ...keyFlags(keyFile, pwRef.current)], pwRef.current);
      if (!res.ok) {
        onMsg(res.stderr.trim() || t('keepass.saveFailed'));
        return;
      }
      setEditorOpen(null);
      setGroupName('');
      await refreshTree();
      onMsg(t('keepass.groupAdded'));
    } finally {
      setBusy(false);
    }
  }, [groupName, selectedGroup, dbPath, keyFile, refreshTree, onMsg, t]);

  // Delete entry via `rm` (gated + confirmed).
  const deleteEntry = useCallback(async () => {
    if (!selectedEntry) return;
    const title = selectedEntry.slice(selectedEntry.lastIndexOf('/') + 1);
    if (!window.confirm(t('keepass.confirmDelete', { title }))) return;
    setBusy(true);
    try {
      const res = await kpcli(
        ['rm', dbPath.trim(), selectedEntry, ...keyFlags(keyFile, pwRef.current)],
        pwRef.current,
      );
      if (!res.ok) {
        onMsg(res.stderr.trim() || t('keepass.deleteFailed'));
        return;
      }
      setSelectedEntry(null);
      setDetail(null);
      await refreshTree();
      onMsg(t('keepass.entryDeleted'));
    } finally {
      setBusy(false);
    }
  }, [selectedEntry, dbPath, keyFile, refreshTree, onMsg, t]);

  // Create a brand-new vault via `db-create`. The password is fed on stdin twice (create + confirm
  // where the CLI asks); keepassxc-cli 2.7 uses --set-password reading a single stdin line.
  const createVault = useCallback(async () => {
    const path = dbPath.trim();
    if (!path) {
      setOpenErr(t('keepass.chooseFirst'));
      return;
    }
    if (!pwInput) {
      setOpenErr(t('keepass.needCred'));
      return;
    }
    setBusy(true);
    setOpenErr(null);
    try {
      const args = ['db-create', path, '--set-password'];
      if (keyFile) args.push('--set-key-file', keyFile);
      // stdin: password, then confirm.
      const res = await kpcli(args, pwInput, [pwInput]);
      if (!res.ok) {
        setOpenErr(res.stderr.trim() || t('keepass.createFailed'));
        return;
      }
      const pw = pwInput;
      const root = await loadTree(path, pw, keyFile);
      if (!root) return;
      pwRef.current = pw;
      setPwInput('');
      setUnlocked(true);
      onMsg(t('keepass.vaultCreated'));
    } finally {
      setBusy(false);
    }
  }, [dbPath, pwInput, keyFile, loadTree, onMsg, t]);

  // Save-as / export a decrypted copy via `export` (gated). keepassxc-cli export writes XML/CSV to
  // stdout; we run it and write to a chosen path through PowerShell.
  const exportVault = useCallback(async () => {
    if (!unlocked) return;
    if (!window.confirm(t('keepass.confirmExport'))) return;
    setBusy(true);
    try {
      const res = await kpcli(
        ['export', '-f', 'xml', dbPath.trim(), ...keyFlags(keyFile, pwRef.current)],
        pwRef.current,
      );
      if (!res.ok) {
        onMsg(res.stderr.trim() || t('keepass.exportFailed'));
        return;
      }
      const outPath = dbPath.trim().replace(/\.kdbx$/i, '') + '-export.xml';
      const b64 = btoa(unescape(encodeURIComponent(res.stdout)));
      const wr = await runPowershell(
        `$b=[System.Convert]::FromBase64String('${b64}');` +
          `[System.IO.File]::WriteAllBytes(${psq(outPath)}, $b)`,
      );
      onMsg(wr.success ? t('keepass.exported', { path: outPath }) : t('keepass.exportFailed'));
    } finally {
      setBusy(false);
    }
  }, [unlocked, dbPath, keyFile, onMsg, t]);

  // Entries to show in the middle column: the selected group's entries, or search results across all.
  const shownEntries = useMemo(() => {
    if (!tree) return [];
    const q = search.trim().toLowerCase();
    if (q) {
      return allEntries(tree)
        .filter((e) => (e.title + ' ' + e.group).toLowerCase().includes(q))
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    const groups = flattenGroups(tree);
    const g = groups.find((x) => x.path === selectedGroup) ?? tree;
    return [...g.entries].sort((a, b) => a.title.localeCompare(b.title));
  }, [tree, selectedGroup, search]);

  const groupList = useMemo(() => (tree ? flattenGroups(tree) : []), [tree]);

  // Depth for indentation in the tree list.
  const depthOf = (path: string) => (path ? path.split('/').length : 0);

  if (!desktop) {
    return (
      <div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('keepass.webNote')}
        </p>
      </div>
    );
  }

  // ── Locked: open / create form ──────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="hosts-edit" style={{ maxWidth: 560 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
          {t('keepass.openTitle')} <StatusDot ok={false} label={t('keepass.lockedState')} />
        </h3>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('keepass.dbFile')}
            </span>
            <input
              className="mod-search"
              placeholder={t('keepass.dbFilePlaceholder')}
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('keepass.masterPw')}
            </span>
            <input
              type="password"
              className="mod-search"
              placeholder={t('keepass.masterPw')}
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doOpen();
              }}
              autoComplete="off"
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('keepass.keyFileOpt')}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="mod-search"
                placeholder={t('keepass.keyFileNone')}
                value={keyFile}
                onChange={(e) => setKeyFile(e.target.value)}
                style={{ flex: 1 }}
              />
              {keyFile && (
                <button className="mini" onClick={() => setKeyFile('')}>
                  {t('keepass.clear')}
                </button>
              )}
            </div>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="mini primary" onClick={() => void doOpen()} disabled={busy}>
              {t('keepass.open')}
            </button>
            <button className="mini" onClick={() => void createVault()} disabled={busy}>
              {t('keepass.createNew')}
            </button>
            {busy && <span className="count-note">{t('modules.loading')}</span>}
          </div>
          {openErr && <pre className="cmd-out error">{openErr}</pre>}
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('keepass.cliNote')}
          </p>
        </div>
      </div>
    );
  }

  // ── Unlocked: toolbar + tree | list | detail ────────────────────────────────
  return (
    <div>
      <ModuleToolbar>
        <button
          className="mini primary"
          onClick={() => {
            setForm(EMPTY_FORM);
            setEditorOpen('add');
          }}
          disabled={busy}
        >
          + {t('keepass.addEntry')}
        </button>
        <button
          className="mini"
          onClick={() => {
            setGroupName('');
            setEditorOpen('group');
          }}
          disabled={busy}
        >
          + {t('keepass.addGroup')}
        </button>
        <input
          className="mod-search"
          placeholder={t('keepass.searchEntries')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 160 }}
        />
        <button className="mini" onClick={() => void refreshTree()} disabled={busy}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" onClick={() => void exportVault()} disabled={busy}>
          {t('keepass.saveAs')}
        </button>
        <button className="mini" onClick={doLock} disabled={busy}>
          🔒 {t('keepass.lock')}
        </button>
        <StatusDot ok label={t('keepass.unlockedState')} />
      </ModuleToolbar>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 220px) minmax(200px, 1.2fr) minmax(240px, 1.4fr)',
          gap: 12,
          marginTop: 12,
          alignItems: 'start',
        }}
      >
        {/* Groups tree */}
        <div className="hosts-edit" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="group-title" style={{ fontSize: 13, padding: '8px 12px', margin: 0 }}>
            {t('keepass.groups')}
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {groupList.map((g) => (
              <button
                key={g.path || '__root__'}
                className={'mini' + (g.path === selectedGroup && !search ? ' primary' : '')}
                onClick={() => {
                  setSelectedGroup(g.path);
                  setSearch('');
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 0,
                  paddingLeft: 12 + depthOf(g.path) * 14,
                }}
              >
                📁 {g.path === '' ? t('keepass.rootGroup') : g.name}
              </button>
            ))}
          </div>
        </div>

        {/* Entry list */}
        <div className="hosts-edit" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="group-title" style={{ fontSize: 13, padding: '8px 12px', margin: 0 }}>
            {search
              ? t('keepass.searchResults', { num: shownEntries.length })
              : t('keepass.entriesCount', { num: shownEntries.length })}
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {shownEntries.length === 0 ? (
              <p className="count-note" style={{ padding: 12 }}>
                {t('keepass.noEntries')}
              </p>
            ) : (
              shownEntries.map((e) => (
                <button
                  key={e.path}
                  className={'mini' + (e.path === selectedEntry ? ' primary' : '')}
                  onClick={() => void openEntry(e.path, false)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    borderRadius: 0,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{e.title || t('keepass.untitled')}</div>
                  {search && (
                    <div className="count-note" style={{ margin: 0 }}>
                      {e.group || '/'}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Detail */}
        <div className="hosts-edit" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            className="group-title"
            style={{
              fontSize: 13,
              padding: '8px 12px',
              margin: 0,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>{detail ? detail.title || t('keepass.untitled') : t('keepass.details')}</span>
            {selectedEntry && (
              <span className="row-actions">
                <button
                  className="mini"
                  onClick={() => {
                    if (!detail) return;
                    setForm({
                      title: detail.title,
                      username: detail.username,
                      password: '',
                      url: detail.url,
                      notes: detail.notes,
                    });
                    setEditorOpen('edit');
                  }}
                  disabled={busy}
                >
                  {t('keepass.edit')}
                </button>
                <button className="mini" onClick={() => void deleteEntry()} disabled={busy}>
                  {t('keepass.delete')}
                </button>
              </span>
            )}
          </div>
          <div style={{ padding: 16 }}>
            {!detail ? (
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('keepass.selectEntry')}
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <DetailField
                  label={t('keepass.fieldUser')}
                  value={detail.username}
                  onCopy={() => void copyPlain(detail.username, t('keepass.userCopied'))}
                />
                {/* Password: masked, gated reveal, secure copy */}
                <div style={{ display: 'grid', gap: 2 }}>
                  <span className="count-note" style={{ margin: 0 }}>
                    {t('keepass.fieldPassword')}
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code style={{ flex: 1, wordBreak: 'break-all' }}>
                      {revealed ? detail.password || '—' : detail.password ? '••••••••••••' : '—'}
                    </code>
                    <button className="mini" onClick={toggleReveal} disabled={busy}>
                      {revealed ? t('keepass.hide') : t('keepass.reveal')}
                    </button>
                    <button className="mini" onClick={() => void copyEntryPassword()} disabled={busy}>
                      {t('keepass.copy')}
                    </button>
                  </div>
                </div>
                <DetailField
                  label={t('keepass.fieldUrl')}
                  value={detail.url}
                  isLink
                  onCopy={() => void copyPlain(detail.url, t('keepass.urlCopied'))}
                />
                {detail.notes && (
                  <div style={{ display: 'grid', gap: 2 }}>
                    <span className="count-note" style={{ margin: 0 }}>
                      {t('keepass.fieldNotes')}
                    </span>
                    <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                      {detail.notes}
                    </pre>
                  </div>
                )}
                {detail.extra.map((f) => (
                  <DetailField
                    key={f.key}
                    label={f.key}
                    value={f.value}
                    onCopy={() => void copyPlain(f.value, t('keepass.fieldCopied'))}
                  />
                ))}
                {detail.modified && (
                  <div className="count-note" style={{ margin: 0 }}>
                    {t('keepass.modified')}: {detail.modified}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add / edit entry dialog */}
      {(editorOpen === 'add' || editorOpen === 'edit') && (
        <div className="hosts-edit" style={{ marginTop: 12, maxWidth: 560 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
            {editorOpen === 'add' ? t('keepass.addEntry') : t('keepass.editEntry')}
          </h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <LabeledInput
              label={t('keepass.fieldTitle')}
              value={form.title}
              onChange={(v) => setForm((f) => ({ ...f, title: v }))}
            />
            <LabeledInput
              label={t('keepass.fieldUser')}
              value={form.username}
              onChange={(v) => setForm((f) => ({ ...f, username: v }))}
            />
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="count-note" style={{ margin: 0 }}>
                {t('keepass.fieldPassword')}
                {editorOpen === 'edit' && ' · ' + t('keepass.leaveBlankKeep')}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  className="mod-search"
                  value={form.password}
                  autoComplete="new-password"
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <button
                  className="mini"
                  onClick={() =>
                    setForm((f) => ({ ...f, password: generatePassword(20, true, true, true, true) }))
                  }
                >
                  {t('keepass.generate')}
                </button>
              </div>
            </label>
            <LabeledInput
              label={t('keepass.fieldUrl')}
              value={form.url}
              onChange={(v) => setForm((f) => ({ ...f, url: v }))}
            />
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="count-note" style={{ margin: 0 }}>
                {t('keepass.fieldNotes')}
              </span>
              <textarea
                className="mod-search"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="mini primary" onClick={() => void submitEntry()} disabled={busy}>
                {t('keepass.save')}
              </button>
              <button className="mini" onClick={() => setEditorOpen(null)} disabled={busy}>
                {t('keepass.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add group dialog */}
      {editorOpen === 'group' && (
        <div className="hosts-edit" style={{ marginTop: 12, maxWidth: 420 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
            {t('keepass.addGroup')}
          </h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <LabeledInput
              label={t('keepass.groupName')}
              value={groupName}
              onChange={setGroupName}
            />
            <div className="count-note" style={{ margin: 0 }}>
              {t('keepass.groupUnder', { group: selectedGroup || t('keepass.rootGroup') })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="mini primary" onClick={() => void submitGroup()} disabled={busy}>
                {t('keepass.add')}
              </button>
              <button className="mini" onClick={() => setEditorOpen(null)} disabled={busy}>
                {t('keepass.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailField({
  label,
  value,
  onCopy,
  isLink,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  isLink?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {isLink && value ? (
          <a href={value} target="_blank" rel="noopener noreferrer" style={{ flex: 1, wordBreak: 'break-all' }}>
            {value}
          </a>
        ) : (
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{value || '—'}</span>
        )}
        {value && (
          <button className="mini" onClick={onCopy}>
            ⧉
          </button>
        )}
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {label}
      </span>
      <input
        className="mod-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%' }}
      />
    </label>
  );
}

export function KeePassModule() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<string | null>(null);

  const tabs = [
    {
      id: 'vault',
      en: 'Vault',
      zh: '保險庫',
      render: () => <VaultPanel onMsg={setMsg} />,
    },
    {
      id: 'generator',
      en: 'Generator',
      zh: '密碼產生器',
      render: () => <GeneratorPanel onCopy={(v) => void copyText(v).then((ok) => setMsg(ok ? t('keepass.copiedClears') : t('keepass.copyFailed')))} copyLabelHost={null} />,
    },
    {
      id: 'scan',
      en: 'Find vaults',
      zh: '搵保險庫',
      render: () => <ScanPanel onMsg={setMsg} />,
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('keepass.blurb')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      <ModuleTabs tabs={tabs} initial="vault" />
    </div>
  );
}
