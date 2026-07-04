import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, runCommand, isTauri } from '../tauri/bridge';
import { Column, DataTable } from './common';
import { ModuleTabs } from './ModuleTabs';

// Native module — a WinForge clone of PowerToys "Peek": fast, read-only file preview.
// It drives the Windows shell + filesystem: pick a file via the native OpenFileDialog,
// classify by extension, read metadata + shell thumbnail, preview by type INLINE (images,
// text/code, rendered Markdown, PDF/HTML, audio/video players, archive entry lists), step
// Prev/Next through sibling files, and Open / Open-with / Show-in-folder / Copy-path via the
// shell. A global-hotkey config surface (enable + chord + Explorer-selection trigger) mirrors
// the C# page. All live actions run only inside the WinForge desktop app.

type PeekKind = 'Image' | 'Text' | 'Markdown' | 'Pdf' | 'Audio' | 'Video' | 'Archive' | 'Web' | 'Unknown';

interface PeekItem {
  path: string;
  name: string;
  ext: string;
  kind: PeekKind;
  sizeBytes: number;
  sizeText: string;
  modified: string;
  created: string;
  exists: boolean;
}

interface ArchiveEntry {
  name: string;
  size: number;
  sizeText: string;
  modified: string;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'svg', 'heic', 'avif', 'jfif', 'dib', 'wdp'];
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'ape', 'alac'];
const VIDEO_EXTS = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'ogv'];
const ARCHIVE_EXTS = ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'lz', 'lzma', 'cab', 'iso', 'wim', 'jar', 'apk', 'war', 'zst', 'zstd'];
const MARKDOWN_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mdx'];
const WEB_EXTS = ['html', 'htm', 'xhtml', 'mht', 'mhtml'];
const PDF_EXTS = ['pdf'];
const TEXT_EXTS = [
  'txt', 'log', 'ini', 'cfg', 'conf', 'config', 'csv', 'tsv', 'json', 'json5', 'jsonc', 'xml', 'yaml', 'yml',
  'toml', 'properties', 'env', 'gitignore', 'gitattributes', 'editorconfig', 'lock', 'sln', 'props', 'targets',
  'cs', 'vb', 'fs', 'c', 'h', 'hpp', 'hh', 'cpp', 'cc', 'cxx', 'm', 'mm', 'java', 'kt', 'kts', 'scala', 'groovy',
  'go', 'rs', 'swift', 'py', 'pyw', 'rb', 'php', 'pl', 'pm', 'lua', 'tcl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl',
  'hs', 'elm', 'clj', 'cljs', 'edn', 'nim', 'zig', 'v', 'sv', 'vhd', 'asm', 's',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'styl',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'vbs', 'reg', 'diff', 'patch',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'dockerfile', 'makefile', 'mk', 'cmake', 'gradle', 'bazel',
  'tex', 'bib', 'rst', 'adoc', 'org', 'srt', 'vtt', 'ass', 'nfo', 'me', 'license', 'authors', 'readme', 'changelog',
];
const BARE_TEXT = ['dockerfile', 'makefile', 'license', 'licence', 'authors', 'readme', 'changelog', 'copying', 'notice', 'todo', 'install'];

// MIME map for inline media / image data URIs.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  avif: 'image/avif', jfif: 'image/jpeg',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  ogv: 'video/ogg', pdf: 'application/pdf',
};

// Cap for reading a whole file into a data URI (matches WinForge's practical limits).
const MAX_INLINE_MB = 64;

function classify(path: string): PeekKind {
  const file = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot + 1) : '';
  if (!ext) {
    if (BARE_TEXT.includes(file) || file === '.gitignore' || file === '.gitattributes' || file === '.editorconfig' || file === '.env') return 'Text';
  }
  if (IMAGE_EXTS.includes(ext)) return 'Image';
  if (MARKDOWN_EXTS.includes(ext)) return 'Markdown';
  if (PDF_EXTS.includes(ext)) return 'Pdf';
  if (AUDIO_EXTS.includes(ext)) return 'Audio';
  if (VIDEO_EXTS.includes(ext)) return 'Video';
  if (ARCHIVE_EXTS.includes(ext)) return 'Archive';
  if (WEB_EXTS.includes(ext)) return 'Web';
  if (TEXT_EXTS.includes(ext)) return 'Text';
  return 'Unknown';
}

function humanSize(bytes: number): string {
  if (bytes < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const unit = u[i] ?? 'B';
  if (i === 0) return `${bytes.toLocaleString()} ${unit}`;
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${unit}`;
}

// Minimal, safe-ish Markdown → HTML (mirrors PeekService.MarkdownToHtml at a smaller scope).
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  for (const raw of lines) {
    if (raw.trimStart().startsWith('```')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw)); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const lvl = h[1]?.length ?? 1;
      out.push(`<h${lvl}>${inline(h[2] ?? '')}</h${lvl}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1] ?? '')}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (raw.trim() === '') { out.push(''); continue; }
    if (/^\s*>/.test(raw)) { out.push(`<blockquote>${inline(raw.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

// PowerShell single-quote escape.
const esc = (s: string) => s.replace(/'/g, "''");

// Raw metadata row returned from PowerShell (Get-Item).
interface RawMeta { path: string; sizeBytes: number; modified: string; created: string; exists: boolean }

// ===================== global-hotkey config (localStorage — mirrors SettingsStore) =====================
const HK_ENABLED = 'peek.hotkey.enabled';
const HK_MODS = 'peek.hotkey.mods';
const HK_KEY = 'peek.hotkey.vk';
const MOD_CTRL = 0x0002, MOD_ALT = 0x0001, MOD_SHIFT = 0x0004, MOD_WIN = 0x0008;

interface HotkeyCfg { enabled: boolean; mods: number; key: string }
function loadHotkey(): HotkeyCfg {
  try {
    const enabled = localStorage.getItem(HK_ENABLED) === '1';
    const mods = parseInt(localStorage.getItem(HK_MODS) ?? '', 10);
    const key = (localStorage.getItem(HK_KEY) ?? 'P').toUpperCase().slice(0, 1) || 'P';
    return { enabled, mods: Number.isFinite(mods) ? mods : MOD_CTRL, key };
  } catch {
    return { enabled: false, mods: MOD_CTRL, key: 'P' };
  }
}
function describeChord(mods: number, key: string): string {
  const parts: string[] = [];
  if (mods & MOD_CTRL) parts.push('Ctrl');
  if (mods & MOD_ALT) parts.push('Alt');
  if (mods & MOD_SHIFT) parts.push('Shift');
  if (mods & MOD_WIN) parts.push('Win');
  parts.push(key || 'P');
  return parts.join('+');
}

function PeekView() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [item, setItem] = useState<PeekItem | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[] | null>(null);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [pixels, setPixels] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadToken = useRef(0);
  const blobRef = useRef<string | null>(null);

  // Revoke any outstanding object URL on unmount.
  useEffect(() => () => { if (blobRef.current) URL.revokeObjectURL(blobRef.current); }, []);

  const clearPreview = () => {
    setTextPreview(null);
    setTextTruncated(false);
    setArchiveEntries(null);
    setDataUri(null);
    setMdHtml(null);
    setPixels(null);
    setThumb(null);
    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    setBlobUrl(null);
  };

  // Build a PeekItem by reading filesystem metadata for a path.
  const describe = async (path: string): Promise<PeekItem> => {
    const kind = classify(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const base: PeekItem = {
      path, name, ext, kind,
      sizeBytes: 0, sizeText: '—', modified: '', created: '', exists: false,
    };
    if (!desktop) return base;
    try {
      const rows = await runPowershellJson<RawMeta>(
        `$p='${esc(path)}'; if(Test-Path -LiteralPath $p -PathType Leaf){ $i=Get-Item -LiteralPath $p; ` +
        `[pscustomobject]@{path=$p;sizeBytes=[long]$i.Length;modified=$i.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss');` +
        `created=$i.CreationTime.ToString('yyyy-MM-dd HH:mm:ss');exists=$true} } else { ` +
        `[pscustomobject]@{path=$p;sizeBytes=[long]0;modified='';created='';exists=$false} }`,
      );
      const r = rows[0];
      if (r) {
        return {
          ...base,
          sizeBytes: r.sizeBytes ?? 0,
          sizeText: humanSize(r.sizeBytes ?? 0),
          modified: r.modified ?? '',
          created: r.created ?? '',
          exists: !!r.exists,
        };
      }
    } catch { /* fall through to base */ }
    return base;
  };

  // Enumerate sibling files in the same folder (name-sorted).
  const loadSiblings = async (path: string): Promise<string[]> => {
    if (!desktop) return [path];
    try {
      const rows = await runPowershellJson<string>(
        `$p='${esc(path)}'; $d=Split-Path -LiteralPath $p -Parent; ` +
        `if($d -and (Test-Path -LiteralPath $d)){ Get-ChildItem -LiteralPath $d -File -Force | Sort-Object Name | ForEach-Object { $_.FullName } }`,
      );
      const files = rows.filter((x): x is string => typeof x === 'string' && x.length > 0);
      return files.length ? files : [path];
    } catch {
      return [path];
    }
  };

  // Load the shell thumbnail / associated icon as a PNG data URI (48px) for the header.
  const loadThumb = async (path: string): Promise<string | null> => {
    if (!desktop) return null;
    try {
      const res = await runPowershell(
        `Add-Type -AssemblyName System.Drawing; $p='${esc(path)}'; ` +
        `try { $ico=[System.Drawing.Icon]::ExtractAssociatedIcon($p); if($ico){ $bmp=$ico.ToBitmap(); ` +
        `$ms=New-Object System.IO.MemoryStream; $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); ` +
        `[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $bmp.Dispose(); $ico.Dispose() } } catch {}`,
      );
      const b64 = res.stdout.trim();
      return b64 ? `data:image/png;base64,${b64}` : null;
    } catch {
      return null;
    }
  };

  // Read up to `maxBytes` of text and detect binary (null-byte heuristic).
  const readText = async (path: string, maxBytes = 1048576): Promise<{ text: string; truncated: boolean; binary: boolean }> => {
    const res = await runPowershell(
      `$p='${esc(path)}'; $b=[System.IO.File]::ReadAllBytes($p); $len=$b.Length; ` +
      `$n=[Math]::Min($len, ${maxBytes}); $slice=$b[0..([Math]::Max(0,$n-1))]; ` +
      `$nul=0; foreach($c in $slice){ if($c -eq 0){ $nul++ } }; ` +
      `$flag=if($len -gt ${maxBytes}){'1'}else{'0'}; $bin=if($nul -gt 1){'1'}else{'0'}; ` +
      `Write-Output ("META:{0}:{1}" -f $flag,$bin); ` +
      `[System.Text.Encoding]::UTF8.GetString($slice)`,
    );
    let out = res.stdout;
    let truncated = false;
    let binary = false;
    const m = /^META:([01]):([01])\r?\n/.exec(out);
    if (m) {
      truncated = m[1] === '1';
      binary = m[2] === '1';
      out = out.slice(m[0].length);
    }
    if (out.endsWith('\r\n')) out = out.slice(0, -2);
    else if (out.endsWith('\n')) out = out.slice(0, -1);
    return { text: out, truncated, binary };
  };

  // Read a whole file to a base64 → object URL for inline media / PDF (respects MAX_INLINE_MB).
  const readBlob = async (path: string, mime: string): Promise<string | null> => {
    const b64res = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${esc(path)}'))`);
    const b64 = b64res.stdout.trim();
    if (!b64) return null;
    const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
    return URL.createObjectURL(blob);
  };

  // List archive contents WITH size + modified, preferring 7-Zip (7z l), else .NET ZipFile.
  const listArchive = async (path: string): Promise<{ entries: ArchiveEntry[]; note: string | null }> => {
    // 1) 7-Zip technical listing (any archive type it supports).
    try {
      const res = await runCommand('7z', ['l', '-slt', path]);
      if (res.success && res.stdout.includes('Path =')) {
        const entries: ArchiveEntry[] = [];
        let cur: Partial<ArchiveEntry & { folder: boolean }> = {};
        const flush = () => {
          if (cur.name && !cur.folder) {
            entries.push({
              name: cur.name,
              size: cur.size ?? 0,
              sizeText: humanSize(cur.size ?? 0),
              modified: cur.modified ?? '',
            });
          }
          cur = {};
        };
        for (const line of res.stdout.split(/\r?\n/)) {
          if (line.startsWith('Path = ')) { flush(); cur.name = line.slice(7); }
          else if (line.startsWith('Size = ')) cur.size = parseInt(line.slice(7), 10) || 0;
          else if (line.startsWith('Modified = ')) cur.modified = line.slice(11).trim();
          else if (line.startsWith('Folder = ')) cur.folder = line.slice(9).trim() === '+';
          else if (line.startsWith('Attributes = ') && /D/.test(line)) cur.folder = true;
        }
        flush();
        // First "Path =" is the archive itself in -slt output; drop it if it equals the file.
        const self = path.split(/[\\/]/).pop() ?? '';
        return { entries: entries.filter((e) => e.name !== path && e.name !== self), note: null };
      }
    } catch { /* 7z not installed — fall through */ }

    // 2) .NET ZipFile fallback (zip only) with real sizes + timestamps.
    if (path.toLowerCase().endsWith('.zip')) {
      try {
        const rows = await runPowershellJson<{ name: string; size: number; modified: string }>(
          `$p='${esc(path)}'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `$z=[System.IO.Compression.ZipFile]::OpenRead($p); try { $z.Entries | Where-Object { $_.Name -ne '' } | ForEach-Object { ` +
          `[pscustomobject]@{name=$_.FullName;size=[long]$_.Length;modified=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')} } } finally { $z.Dispose() }`,
        );
        const entries = rows
          .filter((r): r is { name: string; size: number; modified: string } => !!r && typeof r.name === 'string')
          .map((r) => ({ name: r.name, size: r.size ?? 0, sizeText: humanSize(r.size ?? 0), modified: r.modified ?? '' }));
        return { entries, note: null };
      } catch { /* fall through */ }
    }
    return { entries: [], note: '7z-missing' };
  };

  // Core load: describe → siblings → per-type preview (INLINE).
  const load = async (path: string, keepSiblings = false) => {
    if (!desktop) return;
    const token = ++loadToken.current;
    setBusy(true);
    setErr(null);
    setNote(null);
    clearPreview();
    try {
      const it = await describe(path);
      if (token !== loadToken.current) return;
      setItem(it);
      void loadThumb(path).then((th) => { if (token === loadToken.current) setThumb(th); });

      if (!keepSiblings) {
        const sib = await loadSiblings(path);
        if (token !== loadToken.current) return;
        setSiblings(sib);
        const i = sib.findIndex((p) => p.toLowerCase() === path.toLowerCase());
        setIndex(i >= 0 ? i : 0);
      }

      if (!it.exists) {
        setNote(t('peekmod.notFound'));
        return;
      }

      const tooBig = it.sizeBytes > MAX_INLINE_MB * 1024 * 1024;

      if (it.kind === 'Text') {
        const { text, truncated, binary } = await readText(path);
        if (token !== loadToken.current) return;
        if (binary) { setNote(t('peekmod.binaryNote')); return; }
        setTextPreview(text);
        setTextTruncated(truncated);
      } else if (it.kind === 'Markdown') {
        const { text } = await readText(path, 4 * 1024 * 1024);
        if (token !== loadToken.current) return;
        setMdHtml(renderMarkdown(text));
      } else if (it.kind === 'Web') {
        const { text } = await readText(path, 4 * 1024 * 1024);
        if (token !== loadToken.current) return;
        setDataUri(`data:text/html;charset=utf-8,${encodeURIComponent(text)}`);
      } else if (it.kind === 'Image') {
        const mime = MIME[it.ext] ?? 'image/png';
        if (it.ext === 'svg') {
          const { text } = await readText(path, 4 * 1024 * 1024);
          if (token !== loadToken.current) return;
          setDataUri(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`);
        } else if (tooBig) {
          setNote(t('peekmod.tooBig', { limit: MAX_INLINE_MB }));
        } else {
          const b64res = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${esc(path)}'))`);
          if (token !== loadToken.current) return;
          const b64 = b64res.stdout.trim();
          if (b64) setDataUri(`data:${mime};base64,${b64}`);
          else setNote(t('peekmod.previewFailed'));
        }
      } else if (it.kind === 'Audio' || it.kind === 'Video' || it.kind === 'Pdf') {
        if (tooBig) { setNote(t('peekmod.tooBig', { limit: MAX_INLINE_MB })); return; }
        const mime = MIME[it.ext] ?? 'application/octet-stream';
        const url = await readBlob(path, mime);
        if (token !== loadToken.current) { if (url) URL.revokeObjectURL(url); return; }
        if (url) { blobRef.current = url; setBlobUrl(url); }
        else setNote(t('peekmod.previewFailed'));
      } else if (it.kind === 'Archive') {
        const { entries, note: an } = await listArchive(path);
        if (token !== loadToken.current) return;
        if (an === '7z-missing') setNote(t('peekmod.archiveNote'));
        else setArchiveEntries(entries);
      }
      // Unknown → metadata only (already shown).
    } catch (e) {
      if (token === loadToken.current) setErr(String(e instanceof Error ? e.message : e));
    } finally {
      if (token === loadToken.current) setBusy(false);
    }
  };

  // Native OpenFileDialog via PowerShell (System.Windows.Forms).
  const pickFile = async () => {
    if (!desktop) return;
    setErr(null);
    setNote(null);
    try {
      const res = await runPowershell(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${esc(t('peekmod.pickTitle'))}'; ` +
        `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const path = res.stdout.trim();
      if (path) await load(path);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  // Native folder picker → load first file in the folder.
  const pickFolder = async () => {
    if (!desktop) return;
    setErr(null);
    setNote(null);
    try {
      const res = await runPowershell(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='${esc(t('peekmod.pickFolderTitle'))}'; ` +
        `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.SelectedPath }`,
      );
      const folder = res.stdout.trim();
      if (!folder) return;
      const rows = await runPowershellJson<string>(
        `$d='${esc(folder)}'; Get-ChildItem -LiteralPath $d -File -Force | Sort-Object Name | Select-Object -First 1 | ForEach-Object { $_.FullName }`,
      );
      const first = rows[0];
      if (typeof first === 'string' && first.length) await load(first);
      else setNote(t('peekmod.folderEmpty'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  // Read the file currently selected in the foreground Explorer window (Shell.Application COM).
  const peekExplorer = async () => {
    if (!desktop) return;
    setErr(null);
    setNote(null);
    try {
      const res = await runPowershell(
        `$sh=New-Object -ComObject Shell.Application; $sel=$null; ` +
        `foreach($w in $sh.Windows()){ try { $items=$w.Document.SelectedItems(); if($items -and $items.Count -gt 0){ ` +
        `$p=$items.Item(0).Path; if($p -and (Test-Path -LiteralPath $p -PathType Leaf)){ $sel=$p; break } } } catch {} } ` +
        `if($sel){ $sel }`,
      );
      const sel = res.stdout.trim();
      if (sel) await load(sel);
      else setNote(t('peekmod.noSelection'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const loadManual = async () => {
    const p = manualPath.trim();
    if (!p || !desktop) return;
    await load(p);
  };

  const prev = async () => {
    if (siblings.length < 2) return;
    const i = (index - 1 + siblings.length) % siblings.length;
    setIndex(i);
    const p = siblings[i];
    if (p) await load(p, true);
  };
  const next = async () => {
    if (siblings.length < 2) return;
    const i = (index + 1) % siblings.length;
    setIndex(i);
    const p = siblings[i];
    if (p) await load(p, true);
  };

  const doOpen = async () => {
    if (!item || !desktop) return;
    try {
      await runPowershell(`Start-Process -FilePath '${esc(item.path)}'`);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const doOpenWith = async () => {
    if (!item || !desktop) return;
    try {
      await runPowershell(`Start-Process -FilePath 'rundll32.exe' -ArgumentList 'shell32.dll,OpenAs_RunDLL ${esc(item.path)}'`);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const doShowInFolder = async () => {
    if (!item || !desktop) return;
    try {
      await runPowershell(`Start-Process -FilePath 'explorer.exe' -ArgumentList '/select,"${esc(item.path)}"'`);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const doCopyPath = async () => {
    if (!item) return;
    try {
      if (desktop) await runPowershell(`Set-Clipboard -Value '${esc(item.path)}'`);
      else if (navigator?.clipboard) await navigator.clipboard.writeText(item.path);
      setNote(t('peekmod.pathCopied'));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };

  const kindLabel = (k: PeekKind): string => {
    switch (k) {
      case 'Image': return t('peekmod.kindImage');
      case 'Text': return t('peekmod.kindText');
      case 'Markdown': return 'Markdown';
      case 'Pdf': return 'PDF';
      case 'Audio': return t('peekmod.kindAudio');
      case 'Video': return t('peekmod.kindVideo');
      case 'Archive': return t('peekmod.kindArchive');
      case 'Web': return 'HTML';
      default: return t('peekmod.kindFile');
    }
  };

  const archiveCols: Column<ArchiveEntry>[] = [
    { key: 'name', header: t('peekmod.entryName'), render: (e) => <span style={{ fontFamily: 'var(--mono, monospace)' }}>{e.name}</span> },
    { key: 'size', header: t('peekmod.entrySize'), width: 110, align: 'right', render: (e) => e.sizeText },
    { key: 'modified', header: t('peekmod.entryModified'), width: 150, align: 'right', render: (e) => e.modified || '—' },
  ];

  return (
    <div className="mod">
      <p className="count-note">{t('peekmod.blurb')}</p>
      {!desktop && <p className="count-note error">{t('peekmod.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!desktop || busy} onClick={pickFile}>{t('peekmod.openFile')}</button>
        <button className="mini" disabled={!desktop || busy} onClick={pickFolder}>{t('peekmod.fromFolder')}</button>
        <button className="mini" disabled={!desktop || busy} onClick={peekExplorer}>{t('peekmod.peekExplorer')}</button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 220 }}
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadManual()}
          placeholder={t('peekmod.pathPlaceholder')}
        />
        <button className="mini" disabled={!desktop || busy || !manualPath.trim()} onClick={loadManual}>{t('peekmod.preview')}</button>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}

      {!item && !busy && <p className="count-note">{t('peekmod.empty')}</p>}
      {busy && <p className="count-note">{t('peekmod.loading')}</p>}

      {item && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {thumb && <img src={thumb} alt="" width={20} height={20} style={{ borderRadius: 4 }} />}
            <button className="mini" disabled={siblings.length < 2 || busy} onClick={prev} title={t('peekmod.prev')}>‹</button>
            <button className="mini" disabled={siblings.length < 2 || busy} onClick={next} title={t('peekmod.next')}>›</button>
            {siblings.length > 1 && <span className="count-note">{index + 1} / {siblings.length}</span>}
            <span style={{ flex: 1 }} />
            <button className="mini" disabled={!desktop || busy} onClick={doOpen}>{t('peekmod.open')}</button>
            <button className="mini" disabled={!desktop || busy} onClick={doOpenWith}>{t('peekmod.openWith')}</button>
            <button className="mini" disabled={!desktop || busy} onClick={doShowInFolder}>{t('peekmod.showInFolder')}</button>
            <button className="mini" disabled={busy} onClick={doCopyPath}>{t('peekmod.copyPath')}</button>
          </div>

          <div className="kv-list" style={{ marginTop: 8 }}>
            <div className="kv-row"><span className="label">{t('peekmod.name')}</span><span className="value">{item.name}</span></div>
            <div className="kv-row"><span className="label">{t('peekmod.type')}</span><span className="value">{kindLabel(item.kind)}{item.ext ? ` (.${item.ext})` : ''}{pixels ? `  ·  ${pixels}` : ''}</span></div>
            <div className="kv-row"><span className="label">{t('peekmod.size')}</span><span className="value">{item.exists ? `${item.sizeText}  (${item.sizeBytes.toLocaleString()} ${t('peekmod.bytes')})` : t('peekmod.missing')}</span></div>
            {item.exists && <div className="kv-row"><span className="label">{t('peekmod.modified')}</span><span className="value">{item.modified}</span></div>}
            {item.exists && <div className="kv-row"><span className="label">{t('peekmod.created')}</span><span className="value">{item.created}</span></div>}
            <div className="kv-row"><span className="label">{t('peekmod.location')}</span><span className="value">{item.path}</span></div>
          </div>

          {note && <p className="count-note">{note}</p>}

          {/* Inline image / SVG */}
          {dataUri !== null && (item.kind === 'Image') && (
            <div style={{ marginTop: 10, textAlign: 'center', maxHeight: 460, overflow: 'auto', border: '1px solid var(--stroke)', borderRadius: 8, padding: 8, background: 'var(--bg-2, transparent)' }}>
              <img
                src={dataUri}
                alt={item.name}
                style={{ maxWidth: '100%', maxHeight: 440, objectFit: 'contain' }}
                onLoad={(e) => {
                  const im = e.currentTarget;
                  if (im.naturalWidth) setPixels(`${im.naturalWidth} × ${im.naturalHeight} px`);
                }}
              />
            </div>
          )}

          {/* Inline HTML (Web) via sandboxed iframe from a data URI */}
          {dataUri !== null && item.kind === 'Web' && (
            <iframe
              title="html-preview"
              src={dataUri}
              sandbox=""
              style={{ marginTop: 10, width: '100%', height: 440, border: '1px solid var(--stroke)', borderRadius: 8, background: '#fff' }}
            />
          )}

          {/* Inline PDF via object URL */}
          {blobUrl !== null && item.kind === 'Pdf' && (
            <iframe
              title="pdf-preview"
              src={blobUrl}
              style={{ marginTop: 10, width: '100%', height: 500, border: '1px solid var(--stroke)', borderRadius: 8 }}
            />
          )}

          {/* Inline audio player */}
          {blobUrl !== null && item.kind === 'Audio' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio src={blobUrl} controls style={{ marginTop: 10, width: '100%' }} />
          )}

          {/* Inline video player */}
          {blobUrl !== null && item.kind === 'Video' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={blobUrl} controls style={{ marginTop: 10, width: '100%', maxHeight: 460, background: '#000', borderRadius: 8 }} />
          )}

          {/* Rendered Markdown */}
          {mdHtml !== null && (
            <div className="md-preview" style={{ marginTop: 10, maxHeight: 460, overflow: 'auto', border: '1px solid var(--stroke)', borderRadius: 8, padding: 12 }} dangerouslySetInnerHTML={{ __html: mdHtml }} />
          )}

          {/* Text / code */}
          {textPreview !== null && (
            <>
              <p className="count-note" style={{ marginTop: 8 }}>
                {t('peekmod.lines', { n: textPreview ? textPreview.split('\n').length : 0 })}
                {textTruncated ? `  ·  ${t('peekmod.truncated')}` : ''}
              </p>
              <pre className="cmd-out" style={{ maxHeight: 400, overflow: 'auto' }}>{textPreview || t('peekmod.emptyFile')}</pre>
            </>
          )}

          {/* Archive entry list */}
          {archiveEntries !== null && (
            <div style={{ marginTop: 8 }}>
              <p className="count-note">
                {t('peekmod.entries', { n: archiveEntries.length })}
                {archiveEntries.length > 0 ? `  ·  ${humanSize(archiveEntries.reduce((s, e) => s + e.size, 0))} ${t('peekmod.uncompressed')}` : ''}
              </p>
              <DataTable columns={archiveCols} rows={archiveEntries} rowKey={(e, i) => `${e.name}#${i}`} empty={t('peekmod.archiveEmpty')} />
            </div>
          )}
        </div>
      )}

      <p className="count-note">{t('peekmod.footer')}</p>
    </div>
  );
}

// ===================== Hotkey configuration sub-tab =====================
function HotkeyView() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<HotkeyCfg>(() => loadHotkey());
  const [saved, setSaved] = useState(false);

  const toggleMod = (bit: number) => setCfg((c) => ({ ...c, mods: c.mods ^ bit }));

  const valid = !cfg.enabled || (cfg.mods !== 0 && !!cfg.key);

  const save = () => {
    if (!valid) return;
    try {
      localStorage.setItem(HK_ENABLED, cfg.enabled ? '1' : '0');
      localStorage.setItem(HK_MODS, String(cfg.mods));
      localStorage.setItem(HK_KEY, cfg.key.toUpperCase().slice(0, 1) || 'P');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
  };

  const chord = useMemo(() => describeChord(cfg.mods, cfg.key), [cfg.mods, cfg.key]);

  return (
    <div className="mod">
      <p className="count-note">{t('peekmod.hkBlurb')}</p>

      <div className="panel" style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 460 }}>
        <label className="mod-toolbar" style={{ alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} />
          <span>{cfg.enabled ? t('peekmod.hkEnabled') : t('peekmod.hkDisabled')}</span>
        </label>

        <div>
          <div className="count-note" style={{ marginTop: 0 }}>{t('peekmod.hkModifiers')}</div>
          <div className="mod-toolbar" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!(cfg.mods & MOD_CTRL)} onChange={() => toggleMod(MOD_CTRL)} /> Ctrl
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!(cfg.mods & MOD_ALT)} onChange={() => toggleMod(MOD_ALT)} /> Alt
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!(cfg.mods & MOD_SHIFT)} onChange={() => toggleMod(MOD_SHIFT)} /> Shift
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!(cfg.mods & MOD_WIN)} onChange={() => toggleMod(MOD_WIN)} /> Win
            </label>
          </div>
        </div>

        <div>
          <div className="count-note" style={{ marginTop: 0 }}>{t('peekmod.hkKey')}</div>
          <input
            className="mod-search"
            style={{ width: 72 }}
            maxLength={1}
            value={cfg.key}
            placeholder="P"
            onChange={(e) => setCfg((c) => ({ ...c, key: e.target.value.toUpperCase().slice(0, 1) }))}
          />
        </div>

        <div className="dep-ok" style={{ background: 'transparent' }}>
          {t('peekmod.hkChord')}: <code>{chord}</code>
        </div>

        <div className="mod-toolbar">
          <button className="mini primary" disabled={!valid} onClick={save}>{t('peekmod.hkSave')}</button>
          {saved && <span className="dep-ok">{t('peekmod.hkSaved')}</span>}
        </div>

        {!valid && <p className="count-note error">{t('peekmod.hkInvalid')}</p>}
        <p className="count-note">{t('peekmod.hkNote')}</p>
      </div>
    </div>
  );
}

export function PeekModule() {
  return (
    <ModuleTabs
      tabs={[
        { id: 'preview', en: 'Preview', zh: '預覽', render: () => <PeekView /> },
        { id: 'hotkey', en: 'Hotkey', zh: '熱鍵', render: () => <HotkeyView /> },
      ]}
    />
  );
}
