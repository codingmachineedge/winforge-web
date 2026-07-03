import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Native module — a WinForge clone of PowerToys "Peek": fast, read-only file preview.
// It drives the Windows shell + filesystem (no external CLI): pick a file via the native
// OpenFileDialog, classify by extension, read metadata, preview text/markdown inline,
// step Prev/Next through sibling files in the folder, and Open / Open-with / Show-in-folder
// / Copy-path via the shell. All live actions run only inside the WinForge desktop app.

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

// PowerShell single-quote escape.
const esc = (s: string) => s.replace(/'/g, "''");

// Raw metadata row returned from PowerShell (Get-Item).
interface RawMeta { path: string; sizeBytes: number; modified: string; created: string; exists: boolean }

export function PeekModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [item, setItem] = useState<PeekItem | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<string[] | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const clearPreview = () => {
    setTextPreview(null);
    setArchiveEntries(null);
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

  // Enumerate sibling files in the same folder (natural-ish order via PowerShell sort).
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

  const readText = async (path: string): Promise<string> => {
    const res = await runPowershell(
      `$p='${esc(path)}'; $b=[System.IO.File]::ReadAllBytes($p); ` +
      `$n=[Math]::Min($b.Length, 1048576); $slice=$b[0..([Math]::Max(0,$n-1))]; ` +
      `[System.Text.Encoding]::UTF8.GetString($slice)`,
    );
    let text = res.stdout;
    // Trailing newline from the pipeline is cosmetic; keep content mostly intact.
    if (text.endsWith('\r\n')) text = text.slice(0, -2);
    else if (text.endsWith('\n')) text = text.slice(0, -1);
    return text;
  };

  const listArchive = async (path: string): Promise<string[]> => {
    // Best-effort: only .zip is enumerable without external tools, via .NET ZipFile.
    if (!path.toLowerCase().endsWith('.zip')) return [];
    try {
      const rows = await runPowershellJson<string>(
        `$p='${esc(path)}'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$z=[System.IO.Compression.ZipFile]::OpenRead($p); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`,
      );
      return rows.filter((x): x is string => typeof x === 'string' && x.length > 0);
    } catch {
      return [];
    }
  };

  // Core load: describe → siblings → per-type preview.
  const load = async (path: string, keepSiblings = false) => {
    if (!desktop) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    clearPreview();
    try {
      const it = await describe(path);
      setItem(it);

      if (!keepSiblings) {
        const sib = await loadSiblings(path);
        setSiblings(sib);
        const i = sib.findIndex((p) => p.toLowerCase() === path.toLowerCase());
        setIndex(i >= 0 ? i : 0);
      }

      if (!it.exists) {
        setNote(t('peekmod.notFound'));
        return;
      }

      if (it.kind === 'Text' || it.kind === 'Markdown' || it.kind === 'Web') {
        const text = await readText(path);
        setTextPreview(text);
      } else if (it.kind === 'Archive') {
        const entries = await listArchive(path);
        if (entries.length) setArchiveEntries(entries);
        else setNote(t('peekmod.archiveNote'));
      } else if (it.kind === 'Image' || it.kind === 'Audio' || it.kind === 'Video' || it.kind === 'Pdf') {
        setNote(t('peekmod.openToView'));
      }
      // Unknown → metadata only (already shown).
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
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
            <div className="kv-row"><span className="label">{t('peekmod.type')}</span><span className="value">{kindLabel(item.kind)}{item.ext ? ` (.${item.ext})` : ''}</span></div>
            <div className="kv-row"><span className="label">{t('peekmod.size')}</span><span className="value">{item.exists ? `${item.sizeText}  (${item.sizeBytes.toLocaleString()} ${t('peekmod.bytes')})` : t('peekmod.missing')}</span></div>
            {item.exists && <div className="kv-row"><span className="label">{t('peekmod.modified')}</span><span className="value">{item.modified}</span></div>}
            {item.exists && <div className="kv-row"><span className="label">{t('peekmod.created')}</span><span className="value">{item.created}</span></div>}
            <div className="kv-row"><span className="label">{t('peekmod.location')}</span><span className="value">{item.path}</span></div>
          </div>

          {note && <p className="count-note">{note}</p>}

          {textPreview !== null && (
            <>
              <p className="count-note" style={{ marginTop: 8 }}>
                {t('peekmod.lines', { count: textPreview ? textPreview.split('\n').length : 0 })}
              </p>
              <pre className="cmd-out" style={{ maxHeight: 400, overflow: 'auto' }}>{textPreview || t('peekmod.emptyFile')}</pre>
            </>
          )}

          {archiveEntries !== null && (
            <>
              <p className="count-note" style={{ marginTop: 8 }}>{t('peekmod.entries', { count: archiveEntries.length })}</p>
              <pre className="cmd-out" style={{ maxHeight: 400, overflow: 'auto' }}>{archiveEntries.join('\n')}</pre>
            </>
          )}
        </div>
      )}

      <p className="count-note">{t('peekmod.footer')}</p>
    </div>
  );
}
