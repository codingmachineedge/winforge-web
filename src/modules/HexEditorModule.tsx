// Hex Editor · 十六進位編輯器 — port of WinForge Pages/HexEditorModule.xaml(.cs) +
// Services/HexEditorService.cs. A native HxD-style hex/binary viewer: open a file of
// any size (seek + windowed read, never the whole file), view offset · hex · ASCII in
// 16-byte rows, page through it, go to an offset, find text or a hex pattern, and
// compute MD5 / SHA-1 / SHA-256. Live data via the Tauri PowerShell bridge, read-only.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';
import { AsyncState, ModuleToolbar, useAsync } from './common';

const BYTES_PER_ROW = 16;
const ROWS_PER_PAGE = 32; // one page = 512 bytes
const PAGE_BYTES = BYTES_PER_ROW * ROWS_PER_PAGE;

/** Escape a literal for a single-quoted PowerShell string. */
const psq = (s: string) => s.replace(/'/g, "''");

/** Port of HexEditorService.HumanSize (B → TB). */
function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  const unit = u[i] ?? 'B';
  return i === 0 ? `${bytes.toLocaleString()} B` : `${Math.round(v * 100) / 100} ${unit} (${bytes.toLocaleString()} B)`;
}

interface Window {
  Length: number;
  Offset: number;
  Read: number;
  B64: string;
}

interface HashResult {
  Md5: string;
  Sha1: string;
  Sha256: string;
  Size: number;
}

/** Read a windowed slice of the file as base64 plus the total length, all in one shot. */
function windowScript(path: string, offset: number, count: number): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  $len = $fs.Length
  $off = [long]${Math.max(0, Math.floor(offset))}
  if ($off -gt $len) { $off = $len }
  $want = [int]${Math.max(0, Math.floor(count))}
  $avail = [long]($len - $off)
  if ($want -gt $avail) { $want = [int]$avail }
  $buf = New-Object byte[] ([int]$want)
  $read = 0
  if ($want -gt 0) {
    [void]$fs.Seek($off, [System.IO.SeekOrigin]::Begin)
    while ($read -lt $want) {
      $n = $fs.Read($buf, $read, $want - $read)
      if ($n -le 0) { break }
      $read += $n
    }
  }
  $b64 = if ($read -gt 0) { [Convert]::ToBase64String($buf, 0, $read) } else { '' }
  [pscustomobject]@{ Length = $len; Offset = $off; Read = $read; B64 = $b64 }
} finally { $fs.Dispose() }
`;
}

/** Compute MD5 / SHA-1 / SHA-256 over the whole file (mirrors ComputeHashesAsync). */
function hashScript(path: string): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$size = (Get-Item -LiteralPath $p).Length
[pscustomobject]@{
  Md5    = (Get-FileHash -LiteralPath $p -Algorithm MD5).Hash.ToLower()
  Sha1   = (Get-FileHash -LiteralPath $p -Algorithm SHA1).Hash.ToLower()
  Sha256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
  Size   = [long]$size
}
`;
}

/** Search the file for a byte pattern from `from`; returns the hit offset or -1 (wraps). */
function findScript(path: string, from: number, patternHex: string): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$hex = '${psq(patternHex)}'
$pat = New-Object byte[] ([int]($hex.Length / 2))
for ($i = 0; $i -lt $pat.Length; $i++) { $pat[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }
$fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  $len = $fs.Length
  $plen = $pat.Length
  $hit = [long](-1)
  $chunk = 1048576
  $ov = $plen - 1
  $buf = New-Object byte[] ($chunk + $ov)
  function Scan([long]$start) {
    $pos = $start
    while ($pos -lt $len) {
      [void]$fs.Seek($pos, [System.IO.SeekOrigin]::Begin)
      $got = 0
      $want = [int]([Math]::Min([long]$buf.Length, $len - $pos))
      while ($got -lt $want) { $n = $fs.Read($buf, $got, $want - $got); if ($n -le 0) { break }; $got += $n }
      if ($got -lt $plen) { break }
      $limit = $got - $plen
      for ($i = 0; $i -le $limit; $i++) {
        $m = $true
        for ($j = 0; $j -lt $plen; $j++) { if ($buf[$i+$j] -ne $pat[$j]) { $m = $false; break } }
        if ($m) { return ($pos + $i) }
      }
      $pos += $got - $ov
    }
    return [long](-1)
  }
  $start = [long]([Math]::Max(0, [Math]::Min(${Math.max(0, Math.floor(from))}, $len)))
  $hit = Scan $start
  if ($hit -lt 0 -and $start -gt 0) { $hit = Scan 0 }
  [pscustomobject]@{ Hit = $hit; Length = $len }
} finally { $fs.Dispose() }
`;
}

interface FindResult {
  Hit: number;
  Length: number;
}

/** Decode base64 to a byte array in the browser. */
function b64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** "0x0", "1024", "0x1F" → number | null (mirrors ParseOffset). */
function parseOffset(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const hex = /^0x/i.test(t);
  const body = hex ? t.slice(2) : t;
  if (hex ? !/^[0-9a-f]+$/i.test(body) : !/^\d+$/.test(body)) return null;
  const v = parseInt(body, hex ? 16 : 10);
  return Number.isFinite(v) ? v : null;
}

/** Build a clean hex pattern from find text — text→UTF-8 bytes, or hex-mode digits. */
function toPatternHex(input: string, asHex: boolean): string | null {
  if (!input) return null;
  if (asHex) {
    const clean = input.replace(/[^0-9a-f]/gi, '');
    if (clean.length === 0 || clean.length % 2 !== 0) return null;
    return clean.toLowerCase();
  }
  const enc = new TextEncoder().encode(input);
  if (enc.length === 0) return null;
  let hex = '';
  for (const b of enc) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const off8 = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');

export function HexEditorModule() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [path, setPath] = useState('');
  const [offset, setOffset] = useState(0);

  const [gotoText, setGotoText] = useState('');
  const [findText, setFindText] = useState('');
  const [findHex, setFindHex] = useState(false);
  const [findMsg, setFindMsg] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  const [hashes, setHashes] = useState<HashResult | null>(null);
  const [hashing, setHashing] = useState(false);
  const [hashMsg, setHashMsg] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<Window[]>(() => {
    if (!path) return Promise.resolve([]);
    return runPowershellJson<Window>(windowScript(path, offset, PAGE_BYTES));
  }, [path, offset]);

  const win = data && data.length > 0 ? data[0] : undefined;
  const total = win?.Length ?? 0;
  const bytes = useMemo(() => (win ? b64ToBytes(win.B64) : new Uint8Array(0)), [win]);

  const rows = useMemo(() => {
    if (!win) return [];
    const base = win.Offset;
    const out: { off: number; hex: string; ascii: string }[] = [];
    for (let r = 0; r < bytes.length; r += BYTES_PER_ROW) {
      let hex = '';
      let ascii = '';
      for (let i = 0; i < BYTES_PER_ROW; i += 1) {
        if (r + i < bytes.length) {
          const b = bytes[r + i] ?? 0;
          hex += b.toString(16).toUpperCase().padStart(2, '0') + ' ';
          ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
        } else {
          hex += '   ';
        }
        if (i === 7) hex += ' ';
      }
      out.push({ off: base + r, hex: hex.trimEnd(), ascii });
    }
    return out;
  }, [win, bytes]);

  const columnHeader = useMemo(() => {
    let h = 'Offset(h)  ';
    for (let i = 0; i < BYTES_PER_ROW; i += 1) {
      h += i.toString(16).toUpperCase().padStart(2, '0') + ' ';
      if (i === 7) h += ' ';
    }
    return h.trimEnd();
  }, []);

  const load = () => {
    const clean = draft.trim().replace(/^"|"$/g, '');
    if (!clean) return;
    setFindMsg(null);
    setHashMsg(null);
    setHashes(null);
    setOffset(0);
    if (clean === path) reload();
    else setPath(clean);
  };

  const pageStart = win?.Offset ?? 0;
  const pageEnd = pageStart + bytes.length;
  const atStart = pageStart <= 0;
  const atEnd = pageEnd >= total;

  const goPrev = () => setOffset(Math.max(0, pageStart - PAGE_BYTES));
  const goNext = () => {
    if (!atEnd) setOffset(pageStart + PAGE_BYTES);
  };
  const goHome = () => setOffset(0);
  const goEnd = () => {
    if (total <= 0) return;
    const lastPage = Math.floor((total - 1) / PAGE_BYTES) * PAGE_BYTES;
    setOffset(lastPage);
  };

  const doGoto = () => {
    const off = parseOffset(gotoText);
    if (off === null || off < 0 || off >= total) {
      setFindMsg(t('hexeditor.gotoRange', { max: `0x${Math.max(0, total - 1).toString(16).toUpperCase()}` }));
      return;
    }
    setFindMsg(null);
    setOffset(Math.floor(off / PAGE_BYTES) * PAGE_BYTES);
  };

  const doFind = async () => {
    if (!path) return;
    const patHex = toPatternHex(findText, findHex);
    if (!patHex) {
      setFindMsg(findHex ? t('hexeditor.findHexBad') : t('hexeditor.findTextBad'));
      return;
    }
    setFinding(true);
    setFindMsg(null);
    try {
      const res = await runPowershellJson<FindResult>(findScript(path, pageStart + 1, patHex));
      const hit = res.length > 0 ? (res[0]?.Hit ?? -1) : -1;
      if (hit < 0) {
        setFindMsg(t('hexeditor.notFound'));
      } else {
        setFindMsg(t('hexeditor.foundAt', { off: `0x${hit.toString(16).toUpperCase()}` }));
        setOffset(Math.floor(hit / PAGE_BYTES) * PAGE_BYTES);
      }
    } catch (e) {
      setFindMsg(String(e));
    } finally {
      setFinding(false);
    }
  };

  const doHash = async () => {
    if (!path) return;
    setHashing(true);
    setHashMsg(null);
    try {
      const res = await runPowershellJson<HashResult>(hashScript(path));
      if (res.length > 0 && res[0]) setHashes(res[0]);
      else setHashMsg(t('hexeditor.hashFailed'));
    } catch (e) {
      setHashMsg(`${t('hexeditor.hashFailed')} ${String(e)}`);
    } finally {
      setHashing(false);
    }
  };

  const mono: React.CSSProperties = {
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    whiteSpace: 'pre',
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('hexeditor.pathPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
        />
        <button className="mini primary" onClick={load}>
          {t('hexeditor.open')}
        </button>
        <button className="mini" onClick={reload} disabled={!path}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" onClick={doHash} disabled={!path || hashing}>
          {hashing ? t('hexeditor.hashing') : t('hexeditor.hashes')}
        </button>
      </ModuleToolbar>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('hexeditor.findPlaceholder')}
          value={findText}
          onChange={(e) => setFindText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doFind();
          }}
          disabled={!path}
        />
        <select
          className="mod-select"
          value={findHex ? 'hex' : 'text'}
          onChange={(e) => setFindHex(e.target.value === 'hex')}
          disabled={!path}
        >
          <option value="text">{t('hexeditor.modeText')}</option>
          <option value="hex">{t('hexeditor.modeHex')}</option>
        </select>
        <button className="mini" onClick={doFind} disabled={!path || finding}>
          {finding ? t('hexeditor.searching') : t('hexeditor.findNext')}
        </button>
        <input
          className="mod-search"
          style={{ maxWidth: 140 }}
          placeholder="0x0"
          value={gotoText}
          onChange={(e) => setGotoText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doGoto();
          }}
          disabled={!path}
        />
        <button className="mini" onClick={doGoto} disabled={!path}>
          {t('hexeditor.goto')}
        </button>
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('hexeditor.blurb')}
      </p>
      {!isTauri() && <p className="count-note">{t('hexeditor.desktopNote')}</p>}
      {findMsg && <p className="mod-msg">{findMsg}</p>}
      {hashMsg && <p className="mod-msg">{hashMsg}</p>}

      {hashes && (
        <div className="dt-wrap" style={{ marginBottom: 12 }}>
          <table className="dt">
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, width: 90 }}>MD5</td>
                <td style={mono}>{hashes.Md5}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>SHA-1</td>
                <td style={mono}>{hashes.Sha1}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>SHA-256</td>
                <td style={mono}>{hashes.Sha256}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {path && (
        <ModuleToolbar>
          <button className="mini" onClick={goHome} disabled={atStart}>
            ⏮ {t('hexeditor.first')}
          </button>
          <button className="mini" onClick={goPrev} disabled={atStart}>
            ◀ {t('hexeditor.prev')}
          </button>
          <button className="mini" onClick={goNext} disabled={atEnd}>
            {t('hexeditor.next')} ▶
          </button>
          <button className="mini" onClick={goEnd} disabled={atEnd}>
            {t('hexeditor.last')} ⏭
          </button>
          <span className="count-note">
            {t('hexeditor.range', {
              from: `0x${pageStart.toString(16).toUpperCase()}`,
              to: `0x${Math.max(pageStart, pageEnd - 1).toString(16).toUpperCase()}`,
              size: humanSize(total),
            })}
          </span>
        </ModuleToolbar>
      )}

      <AsyncState loading={loading} error={error}>
        {!path ? (
          <p className="count-note">{t('hexeditor.emptyHint')}</p>
        ) : rows.length === 0 ? (
          <p className="count-note">{t('hexeditor.emptyFile')}</p>
        ) : (
          <div className="dt-wrap">
            <div style={{ ...mono, padding: '8px 12px', color: 'var(--text-2, #888)' }}>{columnHeader}</div>
            <table className="dt">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.off}>
                    <td style={{ ...mono, color: 'var(--text-2, #888)' }}>{off8(r.off)}</td>
                    <td style={mono}>{r.hex}</td>
                    <td style={{ ...mono, color: 'var(--text-3, #aaa)' }}>{r.ascii}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncState>
    </div>
  );
}
