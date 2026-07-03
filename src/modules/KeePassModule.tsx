import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Native port of WinForge's "KeePass Vault" module (Pages/KeePassModule.xaml(.cs) +
// Services/KeePassService.cs). The desktop module is a pure-managed KDBX 3.1/4 engine that opens,
// edits and saves .kdbx databases in-app. Reproducing the full crypto engine (AES-KDF / Argon2d,
// ChaCha20 / AES-CBC, HMAC block streams) inside a PowerShell one-liner is out of scope for the web
// shell, so this native module delivers the honest, read-only, genuinely-useful half of the tool:
//   • it scans the live filesystem for real .kdbx vaults (common vault locations), reading each
//     file's KDBX signature + version bytes, size and last-modified time — data-gathering only;
//   • it detects installed KeePass tooling (KeePass 2.x / KeePassXC) so you know what opens them;
//   • it ports the desktop's exact built-in password generator (CSPRNG char pools, one-of-each
//     guarantee, Fisher-Yates shuffle) with the same ~12s clipboard auto-clear on copy.
// Bilingual throughout, reusing the desktop module's P("en","粵語") strings. Nothing is ever
// launched, decrypted or uploaded — no master password is entered here.

interface KdbxFile {
  Path: string;
  Name: string;
  Dir: string;
  Size: number;
  Modified: string;
  Version: string; // e.g. "4.1", "3.1", or "" when the header couldn't be read
  Valid: boolean; // KDBX magic matched
}

interface ToolInfo {
  Name: string;
  Found: boolean;
  Detail: string;
}

// ── Vault scan ───────────────────────────────────────────────────────────────
// Enumerate *.kdbx under the common vault roots (user profile, OneDrive, Documents, Desktop,
// Downloads), read the first 12 bytes of each file to confirm the KDBX magic (0x9AA2D903 /
// 0xB54BFB67) and pull the little-endian minor/major version words. Read-only; capped depth and
// count so a huge tree never hangs the UI.
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

// ── Tooling detection ────────────────────────────────────────────────────────
// Which local program would actually open these vaults? Look up KeePass 2.x and KeePassXC via the
// uninstall registry and PATH. Purely informational; nothing is launched.
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

// ── Password generator (exact port of KeePassModule.GeneratePassword) ─────────
// Ambiguity-free pools, guarantees one char from each selected class, CSPRNG throughout, then a
// Fisher-Yates shuffle — identical to the desktop RandomNumberGenerator implementation.
const POOL_U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const POOL_L = 'abcdefghijkmnopqrstuvwxyz';
const POOL_D = '23456789';
const POOL_S = '!@#$%^&*()-_=+[]{};:,.?/';

function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  // Rejection sampling over crypto bytes for an unbiased [0, maxExclusive).
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

// Rough strength estimate for the generator preview (bits of entropy = length * log2(poolSize)).
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

const CLIP_CLEAR_MS = 12000; // matches the desktop DispatcherTimer (~12s auto-clear)

function normStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function KeePassModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  // Generator state (defaults mirror the desktop dialog: length 20, all classes on).
  const [genLen, setGenLen] = useState(20);
  const [genUpper, setGenUpper] = useState(true);
  const [genLower, setGenLower] = useState(true);
  const [genDigits, setGenDigits] = useState(true);
  const [genSymbols, setGenSymbols] = useState(true);
  const [password, setPassword] = useState('');

  const clipTimer = useRef<number>(0);

  const {
    data: files,
    loading,
    error,
    reload,
  } = useAsync<KdbxFile[]>(async () => {
    if (!isTauri()) return [];
    return runPowershellJson<KdbxFile>(SCAN_PS);
  }, []);

  const { data: tools } = useAsync<ToolInfo[]>(async () => {
    if (!isTauri()) return [];
    return runPowershellJson<ToolInfo>(TOOLS_PS);
  }, []);

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

  // Generate an initial password and re-roll whenever the options change (like the desktop Make()).
  useEffect(() => {
    setPassword(generatePassword(genLen, genUpper, genLower, genDigits, genSymbols));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genLen, genUpper, genLower, genDigits, genSymbols]);

  useEffect(() => () => window.clearTimeout(clipTimer.current), []);

  // Copy a secret and arm the ~12s auto-clear, exactly as the desktop CopyToClipboard(persistent:false).
  const copySecret = async (value: string) => {
    setMsg(null);
    const ok = await copyText(value);
    if (!ok) {
      setMsg(t('keepass.copyFailed'));
      return;
    }
    window.clearTimeout(clipTimer.current);
    clipTimer.current = window.setTimeout(() => {
      void clearClipboard();
      setMsg(t('keepass.clipCleared'));
    }, CLIP_CLEAR_MS);
    setMsg(t('keepass.copiedClears'));
  };

  const rows = useMemo(() => {
    const all = files ?? [];
    const q = filter.trim().toLowerCase();
    return q
      ? all.filter((f) => (f.Name + ' ' + f.Dir).toLowerCase().includes(q))
      : all;
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
    {
      key: 'Size',
      header: t('keepass.colSize'),
      width: 100,
      align: 'right',
      render: (f) => fmtBytes(f.Size),
    },
    { key: 'Modified', header: t('keepass.colModified'), width: 150 },
    {
      key: 'actions',
      header: '',
      width: 120,
      render: (f) => (
        <span className="row-actions">
          <button className="mini" onClick={() => void copyText(f.Path).then((ok) => setMsg(ok ? t('keepass.pathCopied') : t('keepass.copyFailed')))}>
            {t('keepass.copyPath')}
          </button>
        </span>
      ),
    },
  ];

  const bits = entropyBits(password.length, poolSize);
  const strengthKey = bits >= 128 ? 'strongVery' : bits >= 80 ? 'strong' : bits >= 60 ? 'fair' : 'weak';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('keepass.blurb')}
      </p>

      {/* Generator — exact port of the desktop built-in password generator. */}
      <div className="hosts-edit" style={{ marginBottom: 16 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
          {t('keepass.generatorTitle')}
        </h3>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}
        >
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
          <button className="mini" onClick={() => void copySecret(password)} disabled={!password}>
            {t('keepass.copy')}
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

      {/* Installed tooling that can open these vaults. */}
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

      {/* Vault scan. */}
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
      {msg && <p className="mod-msg">{msg}</p>}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('keepass.scanNote')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(f) => f.Path} empty={t('keepass.noVaults')} />
      </AsyncState>
    </div>
  );
}
