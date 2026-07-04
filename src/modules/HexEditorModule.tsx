// Hex Editor · 十六進位編輯器 — port of WinForge Pages/HexEditorModule.xaml(.cs) +
// Services/HexEditorService.cs. A native HxD-style hex/binary editor: open a file of
// any size (seek + windowed read, never the whole file), view offset · hex · ASCII in
// 16-byte rows, page through it, go to an offset, find text or a hex pattern, compute
// MD5 / SHA-1 / SHA-256, and — mirroring the desktop editor — click-select ranges, a
// data inspector (int8/16/32/64, float32/64, string, endianness), in-place byte
// overwrite, insert / delete bytes, bookmarks, and copy-as (hex / C-array / base64).
// Live file access via the Tauri PowerShell bridge; reads auto-run, writes are gated
// behind an explicit confirm before touching disk.
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

interface MutResult {
  Length: number;
}

/** Overwrite `count` bytes at `offset` in place (mirrors HexEditorService.Overwrite). */
function overwriteScript(path: string, offset: number, patternHex: string): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$hex = '${psq(patternHex)}'
$data = New-Object byte[] ([int]($hex.Length / 2))
for ($i = 0; $i -lt $data.Length; $i++) { $data[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }
$fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
try {
  $off = [long]${Math.max(0, Math.floor(offset))}
  if ($off -gt $fs.Length) { throw 'Offset past end of file.' }
  [void]$fs.Seek($off, [System.IO.SeekOrigin]::Begin)
  $fs.Write($data, 0, $data.Length)
  $fs.Flush($true)
  [pscustomobject]@{ Length = $fs.Length }
} finally { $fs.Dispose() }
`;
}

/** Insert bytes at `offset`, shifting the tail right (mirrors HexEditorService.Insert). */
function insertScript(path: string, offset: number, patternHex: string): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$hex = '${psq(patternHex)}'
$data = New-Object byte[] ([int]($hex.Length / 2))
for ($i = 0; $i -lt $data.Length; $i++) { $data[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }
$off = [long]${Math.max(0, Math.floor(offset))}
$tmp = $p + '.winforge.tmp'
$src = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  if ($off -gt $src.Length) { $off = $src.Length }
  $dst = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $buf = New-Object byte[] 1048576
    $copied = [long]0
    [void]$src.Seek(0, [System.IO.SeekOrigin]::Begin)
    while ($copied -lt $off) {
      $want = [int]([Math]::Min([long]$buf.Length, $off - $copied))
      $n = $src.Read($buf, 0, $want); if ($n -le 0) { break }
      $dst.Write($buf, 0, $n); $copied += $n
    }
    $dst.Write($data, 0, $data.Length)
    while ($true) { $n = $src.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $dst.Write($buf, 0, $n) }
    $dst.Flush($true)
  } finally { $dst.Dispose() }
} finally { $src.Dispose() }
[System.IO.File]::Replace($tmp, $p, $null)
[pscustomobject]@{ Length = (Get-Item -LiteralPath $p).Length }
`;
}

/** Delete `count` bytes at `offset`, shifting the tail left (mirrors HexEditorService.Delete). */
function deleteScript(path: string, offset: number, count: number): string {
  return `
$ErrorActionPreference = 'Stop'
$p = '${psq(path)}'
if (-not [System.IO.File]::Exists($p)) { throw ('File not found: ' + $p) }
$off = [long]${Math.max(0, Math.floor(offset))}
$cnt = [long]${Math.max(1, Math.floor(count))}
$tmp = $p + '.winforge.tmp'
$src = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  if ($off -ge $src.Length) { throw 'Offset past end of file.' }
  if ($off + $cnt -gt $src.Length) { $cnt = $src.Length - $off }
  $dst = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $buf = New-Object byte[] 1048576
    $copied = [long]0
    [void]$src.Seek(0, [System.IO.SeekOrigin]::Begin)
    while ($copied -lt $off) {
      $want = [int]([Math]::Min([long]$buf.Length, $off - $copied))
      $n = $src.Read($buf, 0, $want); if ($n -le 0) { break }
      $dst.Write($buf, 0, $n); $copied += $n
    }
    [void]$src.Seek($off + $cnt, [System.IO.SeekOrigin]::Begin)
    while ($true) { $n = $src.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $dst.Write($buf, 0, $n) }
    $dst.Flush($true)
  } finally { $dst.Dispose() }
} finally { $src.Dispose() }
[System.IO.File]::Replace($tmp, $p, $null)
[pscustomobject]@{ Length = (Get-Item -LiteralPath $p).Length }
`;
}

/** Copy the current logical bytes to a new path (mirrors HexEditorService.SaveAsAsync). */
function saveAsScript(src: string, dst: string): string {
  return `
$ErrorActionPreference = 'Stop'
$s = '${psq(src)}'
$d = '${psq(dst)}'
if (-not [System.IO.File]::Exists($s)) { throw ('File not found: ' + $s) }
Copy-Item -LiteralPath $s -Destination $d -Force
[pscustomobject]@{ Length = (Get-Item -LiteralPath $d).Length }
`;
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
const hexU = (n: number) => n.toString(16).toUpperCase();

/** Data-inspector: interpret bytes at a cursor as the classic integer / float / string set. */
function inspect(bytes: Uint8Array, at: number, little: boolean): { label: string; value: string }[] {
  const avail = bytes.length - at;
  if (at < 0 || avail <= 0) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset + at, avail);
  const rows: { label: string; value: string }[] = [];
  const has = (n: number) => avail >= n;
  const push = (label: string, ok: boolean, fn: () => string) => rows.push({ label, value: ok ? fn() : '—' });

  push('int8', has(1), () => String(dv.getInt8(0)));
  push('uint8', has(1), () => String(dv.getUint8(0)));
  push('int16', has(2), () => String(dv.getInt16(0, little)));
  push('uint16', has(2), () => String(dv.getUint16(0, little)));
  push('int32', has(4), () => String(dv.getInt32(0, little)));
  push('uint32', has(4), () => String(dv.getUint32(0, little)));
  push('int64', has(8), () => dv.getBigInt64(0, little).toString());
  push('uint64', has(8), () => dv.getBigUint64(0, little).toString());
  push('float32', has(4), () => {
    const f = dv.getFloat32(0, little);
    return Number.isFinite(f) ? String(f) : String(f);
  });
  push('float64', has(8), () => {
    const f = dv.getFloat64(0, little);
    return Number.isFinite(f) ? String(f) : String(f);
  });
  // ASCII string: printable run from the cursor (up to 32 chars).
  push('string', has(1), () => {
    let s = '';
    for (let i = 0; i < Math.min(avail, 32); i += 1) {
      const b = bytes[at + i] ?? 0;
      if (b === 0) break;
      s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    }
    return s || '—';
  });
  return rows;
}

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

  // Selection / caret. `caret` is the anchor; `selEnd` extends it (inclusive).
  const [caret, setCaret] = useState(-1);
  const [selEnd, setSelEnd] = useState(-1);
  const [little, setLittle] = useState(true);

  // Edit state.
  const [insertMode, setInsertMode] = useState(false);
  const [editHex, setEditHex] = useState('');
  const [editMsg, setEditMsg] = useState<string | null>(null);
  const [pendingWrite, setPendingWrite] = useState<null | { kind: 'overwrite' | 'insert' | 'delete'; at: number; hex?: string; count?: number; label: string }>(null);
  const [writing, setWriting] = useState(false);

  // Save-As.
  const [saveAsPath, setSaveAsPath] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Bookmarks (in-memory, per-file).
  const [bookmarks, setBookmarks] = useState<number[]>([]);

  // Copy-as feedback.
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

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
    const out: { off: number; cells: { off: number; hex: string }[]; ascii: { off: number; ch: string }[] }[] = [];
    for (let r = 0; r < bytes.length; r += BYTES_PER_ROW) {
      const cells: { off: number; hex: string }[] = [];
      const ascii: { off: number; ch: string }[] = [];
      for (let i = 0; i < BYTES_PER_ROW; i += 1) {
        const idx = r + i;
        if (idx < bytes.length) {
          const b = bytes[idx] ?? 0;
          cells.push({ off: base + idx, hex: b.toString(16).toUpperCase().padStart(2, '0') });
          ascii.push({ off: base + idx, ch: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.' });
        } else {
          cells.push({ off: -1, hex: '  ' });
        }
      }
      out.push({ off: base + r, cells, ascii });
    }
    return out;
  }, [win, bytes]);

  const load = () => {
    const clean = draft.trim().replace(/^"|"$/g, '');
    if (!clean) return;
    setFindMsg(null);
    setHashMsg(null);
    setHashes(null);
    setEditMsg(null);
    setSaveMsg(null);
    setCopyMsg(null);
    setPendingWrite(null);
    setCaret(-1);
    setSelEnd(-1);
    setOffset(0);
    if (clean !== path) setBookmarks([]);
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

  /** Jump to an absolute offset: page to it and set the caret there. */
  const jumpTo = (off: number) => {
    setCaret(off);
    setSelEnd(off);
    setOffset(Math.floor(off / PAGE_BYTES) * PAGE_BYTES);
  };

  const doGoto = () => {
    const off = parseOffset(gotoText);
    if (off === null || off < 0 || off >= total) {
      setFindMsg(t('hexeditor.gotoRange', { max: `0x${hexU(Math.max(0, total - 1))}` }));
      return;
    }
    setFindMsg(null);
    jumpTo(off);
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
    const from = (caret >= 0 ? caret : pageStart) + 1;
    try {
      const res = await runPowershellJson<FindResult>(findScript(path, from, patHex));
      const hit = res.length > 0 ? (res[0]?.Hit ?? -1) : -1;
      if (hit < 0) {
        setFindMsg(t('hexeditor.notFound'));
      } else {
        const len = patHex.length / 2;
        setFindMsg(t('hexeditor.foundAt', { off: `0x${hexU(hit)}` }));
        setCaret(hit);
        setSelEnd(hit + len - 1);
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

  // ── Selection ──────────────────────────────────────────────────────────────
  const selLo = caret >= 0 && selEnd >= 0 ? Math.min(caret, selEnd) : caret;
  const selHi = caret >= 0 && selEnd >= 0 ? Math.max(caret, selEnd) : caret;
  const selLen = caret >= 0 ? selHi - selLo + 1 : 0;

  const clickByte = (byteOff: number, extend: boolean) => {
    if (byteOff < 0) return;
    if (extend && caret >= 0) {
      setSelEnd(byteOff);
    } else {
      setCaret(byteOff);
      setSelEnd(byteOff);
    }
    // Prefill the edit box with the current byte for convenience.
    if (byteOff >= pageStart && byteOff < pageEnd) {
      const b = bytes[byteOff - pageStart] ?? 0;
      setEditHex(b.toString(16).toUpperCase().padStart(2, '0'));
    }
  };

  const inSelection = (byteOff: number) =>
    byteOff >= 0 && caret >= 0 && byteOff >= selLo && byteOff <= selHi;

  // Bytes of the current selection that fall inside the loaded page (for copy-as / inspector).
  const selectedBytes = useMemo(() => {
    if (caret < 0) return new Uint8Array(0);
    const from = Math.max(selLo, pageStart);
    const to = Math.min(selHi, pageEnd - 1);
    if (to < from) return new Uint8Array(0);
    return bytes.slice(from - pageStart, to - pageStart + 1);
  }, [bytes, caret, selLo, selHi, pageStart, pageEnd]);

  // Data inspector reads from the caret within the loaded page.
  const inspectorRows = useMemo(() => {
    if (caret < 0 || caret < pageStart || caret >= pageEnd) return [];
    return inspect(bytes, caret - pageStart, little);
  }, [bytes, caret, pageStart, pageEnd, little]);

  const caretByte = caret >= pageStart && caret < pageEnd ? (bytes[caret - pageStart] ?? null) : null;

  // ── Copy-as ────────────────────────────────────────────────────────────────
  const copyAs = async (fmt: 'hex' | 'carray' | 'base64') => {
    const src = selectedBytes.length > 0 ? selectedBytes : bytes;
    if (src.length === 0) {
      setCopyMsg(t('hexeditor.copyNothing'));
      return;
    }
    let out = '';
    if (fmt === 'hex') {
      out = Array.from(src, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    } else if (fmt === 'carray') {
      out = '{ ' + Array.from(src, (b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ' }';
    } else {
      let bin = '';
      for (const b of src) bin += String.fromCharCode(b);
      out = btoa(bin);
    }
    try {
      await navigator.clipboard.writeText(out);
      setCopyMsg(t('hexeditor.copied', { n: src.length, fmt }));
    } catch {
      setCopyMsg(out); // clipboard blocked — surface the text so it can be copied manually
    }
  };

  // ── Bookmarks ──────────────────────────────────────────────────────────────
  const toggleBookmark = () => {
    if (caret < 0) return;
    setBookmarks((prev) => (prev.includes(caret) ? prev.filter((b) => b !== caret) : [...prev, caret].sort((a, b) => a - b)));
  };
  const removeBookmark = (off: number) => setBookmarks((prev) => prev.filter((b) => b !== off));

  // ── Edits (gated: stage → confirm → write) ──────────────────────────────────
  const stageOverwrite = () => {
    if (caret < 0) return;
    const clean = editHex.replace(/[^0-9a-f]/gi, '');
    if (clean.length === 0 || clean.length % 2 !== 0) {
      setEditMsg(t('hexeditor.findHexBad'));
      return;
    }
    setEditMsg(null);
    const n = clean.length / 2;
    setPendingWrite({
      kind: 'overwrite',
      at: caret,
      hex: clean.toLowerCase(),
      label: t('hexeditor.confirmOverwrite', { n, off: `0x${hexU(caret)}` }),
    });
  };

  const stageInsert = () => {
    if (caret < 0) return;
    const clean = editHex.replace(/[^0-9a-f]/gi, '');
    if (clean.length === 0 || clean.length % 2 !== 0) {
      setEditMsg(t('hexeditor.findHexBad'));
      return;
    }
    setEditMsg(null);
    const n = clean.length / 2;
    setPendingWrite({
      kind: 'insert',
      at: caret,
      hex: clean.toLowerCase(),
      label: t('hexeditor.confirmInsert', { n, off: `0x${hexU(caret)}` }),
    });
  };

  const stageDelete = () => {
    if (caret < 0) return;
    const count = selLen > 0 ? selLen : 1;
    setEditMsg(null);
    setPendingWrite({
      kind: 'delete',
      at: selLo,
      count,
      label: t('hexeditor.confirmDelete', { n: count, off: `0x${hexU(selLo)}` }),
    });
  };

  const runPendingWrite = async () => {
    if (!pendingWrite || !path) return;
    setWriting(true);
    setEditMsg(null);
    try {
      let script = '';
      if (pendingWrite.kind === 'overwrite') script = overwriteScript(path, pendingWrite.at, pendingWrite.hex ?? '');
      else if (pendingWrite.kind === 'insert') script = insertScript(path, pendingWrite.at, pendingWrite.hex ?? '');
      else script = deleteScript(path, pendingWrite.at, pendingWrite.count ?? 1);
      const res = await runPowershellJson<MutResult>(script);
      const newLen = res.length > 0 ? (res[0]?.Length ?? total) : total;
      setEditMsg(t('hexeditor.writeOk', { size: humanSize(newLen) }));
      setPendingWrite(null);
      setHashes(null);
      reload();
    } catch (e) {
      setEditMsg(t('hexeditor.writeFail', { detail: String(e) }));
    } finally {
      setWriting(false);
    }
  };

  const doSaveAs = async () => {
    const dst = saveAsPath.trim().replace(/^"|"$/g, '');
    if (!path || !dst) {
      setSaveMsg(t('hexeditor.saveAsNeedPath'));
      return;
    }
    setSaveMsg(null);
    try {
      const res = await runPowershellJson<MutResult>(saveAsScript(path, dst));
      const len = res.length > 0 ? (res[0]?.Length ?? 0) : 0;
      setSaveMsg(t('hexeditor.saveAsOk', { size: humanSize(len) }));
    } catch (e) {
      setSaveMsg(t('hexeditor.saveAsFail', { detail: String(e) }));
    }
  };

  const mono: React.CSSProperties = {
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    whiteSpace: 'pre',
  };

  const canEdit = !!path && caret >= 0;

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
              from: `0x${hexU(pageStart)}`,
              to: `0x${hexU(Math.max(pageStart, pageEnd - 1))}`,
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
          <>
            <p className="count-note" style={{ marginBottom: 6 }}>
              {t('hexeditor.selectHint')}
            </p>
            <div className="dt-wrap">
              <table className="dt" style={{ userSelect: 'none' }}>
                <thead>
                  <tr>
                    <th style={{ ...mono, textAlign: 'left', color: 'var(--text-secondary)' }}>{t('hexeditor.colOffset')}</th>
                    {Array.from({ length: BYTES_PER_ROW }, (_, i) => (
                      <th key={i} style={{ ...mono, textAlign: 'center', color: 'var(--text-secondary)', padding: '2px 4px' }}>
                        {i.toString(16).toUpperCase().padStart(2, '0')}
                      </th>
                    ))}
                    <th style={{ ...mono, textAlign: 'left', color: 'var(--text-secondary)' }}>{t('hexeditor.colText')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.off}>
                      <td style={{ ...mono, color: 'var(--text-secondary)' }}>{off8(r.off)}</td>
                      {r.cells.map((c, i) => {
                        const sel = inSelection(c.off);
                        const isCaret = c.off === caret;
                        const marked = c.off >= 0 && bookmarks.includes(c.off);
                        return (
                          <td
                            key={i}
                            onClick={(e) => clickByte(c.off, e.shiftKey)}
                            style={{
                              ...mono,
                              textAlign: 'center',
                              padding: '2px 4px',
                              cursor: c.off >= 0 ? 'pointer' : 'default',
                              background: isCaret
                                ? 'color-mix(in srgb, var(--accent) 45%, transparent)'
                                : sel
                                  ? 'color-mix(in srgb, var(--accent) 22%, transparent)'
                                  : undefined,
                              borderBottom: marked ? '2px solid var(--accent)' : undefined,
                            }}
                          >
                            {c.hex}
                          </td>
                        );
                      })}
                      <td style={{ ...mono, color: 'var(--text-secondary)' }}>
                        {r.ascii.map((a, i) => (
                          <span
                            key={i}
                            onClick={(e) => clickByte(a.off, e.shiftKey)}
                            style={{
                              cursor: 'pointer',
                              background: inSelection(a.off)
                                ? 'color-mix(in srgb, var(--accent) 22%, transparent)'
                                : a.off === caret
                                  ? 'color-mix(in srgb, var(--accent) 45%, transparent)'
                                  : undefined,
                            }}
                          >
                            {a.ch}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Status footer — offset dec/hex, byte dec/hex/bin, selection, size */}
            <div
              className="count-note"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 8, ...mono, whiteSpace: 'normal' }}
            >
              <span>
                {caret >= 0
                  ? t('hexeditor.statusOffset', { dec: caret, hex: `0x${hexU(caret)}` })
                  : t('hexeditor.statusNoCaret')}
              </span>
              {caretByte !== null && (
                <span>
                  {t('hexeditor.statusByte', {
                    dec: caretByte,
                    hex: `0x${caretByte.toString(16).toUpperCase().padStart(2, '0')}`,
                    bin: `0b${caretByte.toString(2).padStart(8, '0')}`,
                  })}
                </span>
              )}
              {selLen > 1 && (
                <span>
                  {t('hexeditor.statusSelection', { from: `0x${hexU(selLo)}`, to: `0x${hexU(selHi)}`, n: selLen })}
                </span>
              )}
              <span>{t('hexeditor.statusSize', { size: humanSize(total) })}</span>
            </div>

            {/* Data inspector */}
            {inspectorRows.length > 0 && (
              <div className="dt-wrap" style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                  <strong style={{ fontSize: 13 }}>{t('hexeditor.inspectorTitle')}</strong>
                  <button className="mini" onClick={() => setLittle((v) => !v)}>
                    {little ? t('hexeditor.endianLE') : t('hexeditor.endianBE')}
                  </button>
                </div>
                <table className="dt">
                  <tbody>
                    {inspectorRows.map((row) => (
                      <tr key={row.label}>
                        <td style={{ fontWeight: 600, width: 120 }}>{row.label}</td>
                        <td style={mono}>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Copy-as */}
            <ModuleToolbar>
              <span className="count-note" style={{ marginRight: 4 }}>
                {t('hexeditor.copyLabel', { n: selectedBytes.length > 0 ? selectedBytes.length : bytes.length })}
              </span>
              <button className="mini" onClick={() => void copyAs('hex')} disabled={bytes.length === 0}>
                {t('hexeditor.copyHex')}
              </button>
              <button className="mini" onClick={() => void copyAs('carray')} disabled={bytes.length === 0}>
                {t('hexeditor.copyCArray')}
              </button>
              <button className="mini" onClick={() => void copyAs('base64')} disabled={bytes.length === 0}>
                {t('hexeditor.copyBase64')}
              </button>
              <button className="mini" onClick={toggleBookmark} disabled={caret < 0}>
                {caret >= 0 && bookmarks.includes(caret) ? t('hexeditor.bookmarkRemove') : t('hexeditor.bookmarkAdd')}
              </button>
            </ModuleToolbar>
            {copyMsg && <p className="mod-msg" style={{ wordBreak: 'break-all' }}>{copyMsg}</p>}

            {/* Bookmarks list */}
            {bookmarks.length > 0 && (
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <span className="count-note" style={{ marginRight: 4 }}>
                  {t('hexeditor.bookmarksTitle', { n: bookmarks.length })}
                </span>
                {bookmarks.map((b) => (
                  <span key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <button className="mini" onClick={() => jumpTo(b)}>
                      0x{hexU(b)}
                    </button>
                    <button className="mini" onClick={() => removeBookmark(b)} title={t('hexeditor.bookmarkRemove')}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Edit / patch — gated behind an explicit confirm before writing to disk */}
            <div className="dt-wrap" style={{ marginTop: 12, padding: 12 }}>
              <strong style={{ fontSize: 13 }}>{t('hexeditor.editTitle')}</strong>
              <p className="count-note" style={{ marginTop: 4 }}>{t('hexeditor.editHint')}</p>
              <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={insertMode} onChange={(e) => setInsertMode(e.target.checked)} />
                  {t('hexeditor.insertMode')}
                </label>
                <input
                  className="mod-search"
                  style={{ maxWidth: 220, ...mono }}
                  placeholder={t('hexeditor.editPlaceholder')}
                  value={editHex}
                  onChange={(e) => setEditHex(e.target.value)}
                  disabled={!canEdit}
                />
                {insertMode ? (
                  <button className="mini primary" onClick={stageInsert} disabled={!canEdit}>
                    {t('hexeditor.insertBtn')}
                  </button>
                ) : (
                  <button className="mini primary" onClick={stageOverwrite} disabled={!canEdit}>
                    {t('hexeditor.overwriteBtn')}
                  </button>
                )}
                <button className="mini danger" onClick={stageDelete} disabled={!canEdit}>
                  {t('hexeditor.deleteBtn')}
                </button>
              </div>

              {pendingWrite && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    border: '1px solid var(--danger)',
                    borderRadius: 8,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>⚠ {pendingWrite.label}</span>
                  <button className="mini danger" onClick={() => void runPendingWrite()} disabled={writing}>
                    {writing ? t('hexeditor.writing') : t('hexeditor.confirmWrite')}
                  </button>
                  <button className="mini" onClick={() => setPendingWrite(null)} disabled={writing}>
                    {t('hexeditor.cancel')}
                  </button>
                </div>
              )}
              {editMsg && <p className="mod-msg" style={{ marginTop: 8 }}>{editMsg}</p>}
            </div>

            {/* Save As — copy the current file to a new path */}
            <div className="mod-toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <span className="count-note" style={{ marginRight: 4 }}>{t('hexeditor.saveAsTitle')}</span>
              <input
                className="mod-search"
                style={{ maxWidth: 320 }}
                placeholder={t('hexeditor.saveAsPlaceholder')}
                value={saveAsPath}
                onChange={(e) => setSaveAsPath(e.target.value)}
              />
              <button className="mini" onClick={() => void doSaveAs()} disabled={!path || !saveAsPath.trim()}>
                {t('hexeditor.saveAsBtn')}
              </button>
            </div>
            {saveMsg && <p className="mod-msg">{saveMsg}</p>}
          </>
        )}
      </AsyncState>
    </div>
  );
}
