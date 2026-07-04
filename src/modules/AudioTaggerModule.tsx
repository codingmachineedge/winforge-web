import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Ported from WinForge Pages/AudioTaggerModule + Services/AudioTagService.
// Native, Mp3tag-style tag editor. The desktop reads audio metadata (title, artist,
// album, album artist, track, disc, year, genre, composer, comment, duration, bit
// rate, sample rate, channels, cover art) and WRITES tags back via TagLib#. This web
// port reads the grid via the Windows Property System (Shell.Application GetDetailsOf —
// pure built-in, no external tool), and — where the desktop uses TagLib# to write —
// shells ffmpeg BY NAME to save edited tags + cover art back to disk (all writes are
// click-gated; batch/destructive ones confirm). Cover-art view/replace/remove and the
// filename ⇄ tags helpers (tag-from-filename apply, rename-from-tags) are all present.

const EXTS = [
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma',
  '.aiff', '.aif', '.ape', '.wv', '.mpc',
];

interface Track {
  Path: string;
  FileName: string;
  Title: string;
  Artist: string;
  Album: string;
  AlbumArtist: string;
  Track: string;
  Disc: string;
  Year: string;
  Genre: string;
  Composer: string;
  Comment: string;
  Duration: string;
  Bitrate: string;
  SampleRate: string;
  Channels: string;
  Ext: string;
}

/** The nine editable text/number fields, mirroring TagLib# TagEdit + the form. */
interface EditForm {
  Title: string;
  Artist: string;
  Album: string;
  AlbumArtist: string;
  Track: string;
  Disc: string;
  Year: string;
  Genre: string;
  Composer: string;
  Comment: string;
}

const EMPTY_FORM: EditForm = {
  Title: '', Artist: '', Album: '', AlbumArtist: '', Track: '', Disc: '',
  Year: '', Genre: '', Composer: '', Comment: '',
};

// ffmpeg metadata keys for each editable field (best-effort, format-agnostic; ffmpeg
// maps generic keys onto the right per-container frame on save).
const FF_META: Record<keyof EditForm, string> = {
  Title: 'title',
  Artist: 'artist',
  Album: 'album',
  AlbumArtist: 'album_artist',
  Track: 'track',
  Disc: 'disc',
  Year: 'date',
  Genre: 'genre',
  Composer: 'composer',
  Comment: 'comment',
};

const esc = (s: string) => s.replace(/'/g, "''");

// PowerShell that walks a folder and, for each audio file, pulls Windows Property
// System fields by NAME (GetDetailsOf column headers are locale-stable enough for
// the common ones; we look them up by header text so it survives column reorder).
function scanScript(folder: string, recurse: boolean): string {
  const extList = EXTS.map((e) => `'${e}'`).join(',');
  const opt = recurse ? '-Recurse' : '';
  return `
$root='${esc(folder)}'
$exts=@(${extList})
$sh=New-Object -ComObject Shell.Application
$wanted=@{
  'Title'='Title';'Contributing artists'='Artist';'Authors'='Artist';'Album'='Album';
  'Album artist'='AlbumArtist';'#'='Track';'Track number'='Track';'Part of a set'='Disc';
  'Year'='Year';'Genre'='Genre';'Composers'='Composer';'Comments'='Comment';
  'Length'='Duration';'Bit rate'='Bitrate';'Rate'='SampleRate';'Channels'='Channels'
}
$files = Get-ChildItem -LiteralPath $root -File ${opt} -ErrorAction SilentlyContinue |
  Where-Object { $exts -contains $_.Extension.ToLower() } |
  Sort-Object FullName | Select-Object -First 3000
$folders=@{}
$results=@()
foreach($f in $files){
  $dir=$f.DirectoryName
  if(-not $folders.ContainsKey($dir)){ $folders[$dir]=$sh.Namespace($dir) }
  $ns=$folders[$dir]
  if($ns -eq $null){ continue }
  $item=$ns.ParseName($f.Name)
  if($item -eq $null){ continue }
  $vals=@{}
  for($i=0;$i -lt 320;$i++){
    $h=$ns.GetDetailsOf($null,$i)
    if($wanted.ContainsKey($h)){
      $key=$wanted[$h]
      $v=$ns.GetDetailsOf($item,$i)
      if($v){ if(-not $vals.ContainsKey($key) -or -not $vals[$key]){ $vals[$key]=$v } }
    }
  }
  [pscustomobject]@{
    Path=$f.FullName; FileName=$f.Name
    Title=[string]$vals['Title']; Artist=[string]$vals['Artist']; Album=[string]$vals['Album']
    AlbumArtist=[string]$vals['AlbumArtist']; Track=[string]$vals['Track']; Disc=[string]$vals['Disc']
    Year=[string]$vals['Year']; Genre=[string]$vals['Genre']; Composer=[string]$vals['Composer']
    Comment=[string]$vals['Comment']; Duration=[string]$vals['Duration']; Bitrate=[string]$vals['Bitrate']
    SampleRate=[string]$vals['SampleRate']; Channels=[string]$vals['Channels']
    Ext=$f.Extension.TrimStart('.').ToUpper()
  }
}
`.trim() + '\n$results';
}

// ── filename ⇄ tags helpers (pure, safe — mirrors AudioTagService) ──
const TOKENS = ['title', 'artist', 'album', 'albumartist', 'track', 'year', 'genre', 'disc', 'composer'];

// map a parsed token name → the EditForm field it fills.
const TOKEN_FIELD: Record<string, keyof EditForm> = {
  title: 'Title', artist: 'Artist', album: 'Album', albumartist: 'AlbumArtist',
  album_artist: 'AlbumArtist', track: 'Track', year: 'Year', genre: 'Genre',
  disc: 'Disc', composer: 'Composer', comment: 'Comment',
};

function patternToRegex(pattern: string): RegExp | null {
  let rx = '^';
  const order: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '%') {
      const end = pattern.indexOf('%', i + 1);
      if (end < 0) { rx += '%'; i++; continue; }
      const field = pattern.slice(i + 1, end).toLowerCase();
      order.push(field);
      rx += ['track', 'year', 'disc', 'trackcount'].includes(field) ? '(\\d+)' : '(.+?)';
      i = end + 1;
    } else {
      rx += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  rx += '$';
  try {
    const re = new RegExp(rx);
    (re as unknown as { _order: string[] })._order = order;
    return re;
  } catch {
    return null;
  }
}

function parseFromName(fileName: string, pattern: string): Record<string, string> | null {
  const base = fileName.replace(/\.[^.]+$/, '');
  const re = patternToRegex(pattern);
  if (!re) return null;
  const m = re.exec(base);
  if (!m) return null;
  const order = (re as unknown as { _order: string[] })._order ?? [];
  const out: Record<string, string> = {};
  order.forEach((field, idx) => {
    const v = (m[idx + 1] ?? '').trim();
    if (v) out[field] = v;
  });
  return out;
}

function buildName(t: Track, pattern: string): string {
  const tok = (f: string): string => {
    switch (f) {
      case 'title': return t.Title;
      case 'artist': return t.Artist;
      case 'album': return t.Album;
      case 'albumartist': case 'album_artist': return t.AlbumArtist;
      case 'genre': return t.Genre;
      case 'composer': return t.Composer;
      case 'comment': return t.Comment;
      case 'track': { const n = parseInt(t.Track, 10); return n > 0 ? String(n).padStart(2, '0') : ''; }
      case 'year': return t.Year;
      case 'disc': return t.Disc;
      default: return '';
    }
  };
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '%') {
      const end = pattern.indexOf('%', i + 1);
      if (end < 0) { out += pattern[i]; i++; continue; }
      out += tok(pattern.slice(i + 1, end).toLowerCase());
      i = end + 1;
    } else { out += pattern[i]; i++; }
  }
  // sanitize invalid filename chars
  out = out.replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+|\.+$/g, '');
  return out.length ? out : 'untitled';
}

// A container whose cover art ffmpeg can write as an attached picture. WAV/APE/etc.
// carry text metadata fine but embedded art is unreliable, so we gate the cover UI.
const COVER_EXTS = new Set(['mp3', 'flac', 'm4a', 'ogg', 'opus', 'aac']);

// ── ffmpeg write helpers (shelled BY NAME per repo convention) ──────────────
// Build a PowerShell snippet that runs ffmpeg to a sibling temp file then swaps it
// in atomically. `metaArgs` is a pre-built ffmpeg argument string. cover: null =
// leave, '' = remove, path = embed the image at that path.
function ffmpegWriteScript(target: string, metaArgs: string, cover: string | null): string {
  const src = esc(target);
  const q = "'";
  if (cover !== null && cover !== '') {
    // embed a new front cover: audio from input 0, image from input 1.
    const img = esc(cover);
    return (
      `$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source; if(-not $ff){ throw ${q}ffmpeg-missing${q} }\n` +
      `$src=${q}${src}${q}; $ext=[System.IO.Path]::GetExtension($src)\n` +
      `$tmp=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($src), ([System.IO.Path]::GetFileNameWithoutExtension($src)+${q}.wf_tmp${q}+$ext))\n` +
      `& $ff -y -hide_banner -loglevel error -i $src -i ${q}${img}${q} -map 0:a -map 1:v -c copy -disposition:v attached_pic ${metaArgs} $tmp 2>&1 | Out-String\n` +
      `if($LASTEXITCODE -ne 0){ throw ${q}ffmpeg-failed${q} }\n` +
      `Move-Item -LiteralPath $tmp -Destination $src -Force; ${q}ok${q}`
    );
  }
  if (cover === '') {
    // strip embedded pictures: keep only audio streams.
    return (
      `$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source; if(-not $ff){ throw ${q}ffmpeg-missing${q} }\n` +
      `$src=${q}${src}${q}; $ext=[System.IO.Path]::GetExtension($src)\n` +
      `$tmp=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($src), ([System.IO.Path]::GetFileNameWithoutExtension($src)+${q}.wf_tmp${q}+$ext))\n` +
      `& $ff -y -hide_banner -loglevel error -i $src -map 0:a -c copy ${metaArgs} $tmp 2>&1 | Out-String\n` +
      `if($LASTEXITCODE -ne 0){ throw ${q}ffmpeg-failed${q} }\n` +
      `Move-Item -LiteralPath $tmp -Destination $src -Force; ${q}ok${q}`
    );
  }
  // text-only edit: keep every stream (audio + any existing cover), rewrite metadata.
  return (
    `$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source; if(-not $ff){ throw ${q}ffmpeg-missing${q} }\n` +
    `$src=${q}${src}${q}; $ext=[System.IO.Path]::GetExtension($src)\n` +
    `$tmp=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($src), ([System.IO.Path]::GetFileNameWithoutExtension($src)+${q}.wf_tmp${q}+$ext))\n` +
    `& $ff -y -hide_banner -loglevel error -i $src -map 0 -c copy ${metaArgs} $tmp 2>&1 | Out-String\n` +
    `if($LASTEXITCODE -ne 0){ throw ${q}ffmpeg-failed${q} }\n` +
    `Move-Item -LiteralPath $tmp -Destination $src -Force; ${q}ok${q}`
  );
}

/** Build the `-metadata key=value` argument string for the fields in `edit`.
 *  In batch mode a blank field means "leave untouched" (skipped); in single mode a
 *  blank field is written empty to clear it, matching TagLib# BuildEditFromForm. */
function metaArgsFor(edit: Partial<EditForm>, batch: boolean): string {
  const parts: string[] = [];
  (Object.keys(FF_META) as (keyof EditForm)[]).forEach((k) => {
    const v = edit[k];
    if (v === undefined) return;
    if (batch && v === '') return;
    // escape for PowerShell single-quoted arg + strip newlines
    const val = String(v).replace(/[\r\n]+/g, ' ');
    parts.push(`-metadata '${FF_META[k]}=${esc(val)}'`);
  });
  return parts.join(' ');
}

export function AudioTaggerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [folder, setFolder] = useState('');
  const [recurse, setRecurse] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // editor form + staged cover action (0 leave / 1 set / 2 remove).
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  const [coverAction, setCoverAction] = useState<0 | 1 | 2>(0);
  const [coverPath, setCoverPath] = useState<string>('');
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null);
  const [coverNote, setCoverNote] = useState<string | null>(null);

  const [fromPattern, setFromPattern] = useState('%artist% - %title%');
  const [toPattern, setToPattern] = useState('%track% - %artist% - %title%');

  // ── ffmpeg engine probe (writes need it; reads use the Property System) ──
  const engineQ = useAsync<boolean>(async () => {
    if (!desktop) return false;
    try {
      const r = await runPowershell(
        `if((Get-Command ffmpeg -ErrorAction SilentlyContinue)){ 'yes' } else { 'no' }`,
      );
      return r.stdout.trim() === 'yes';
    } catch {
      return false;
    }
  }, [desktop]);
  const hasFfmpeg = engineQ.data === true;

  const { data, loading, error, reload } = useAsync<Track[]>(
    () => (folder ? runPowershellJson<Track>(scanScript(folder, recurse)) : Promise.resolve([])),
    [folder, recurse],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return q
      ? all.filter((r) =>
          `${r.FileName} ${r.Title} ${r.Artist} ${r.Album} ${r.Genre}`.toLowerCase().includes(q),
        )
      : all;
  }, [data, filter]);

  const current = useMemo(
    () => rows.find((r) => r.Path === selected) ?? null,
    [rows, selected],
  );

  // The batch scope: all *checked* rows still present in the current view.
  const checkedRows = useMemo(
    () => rows.filter((r) => checked.has(r.Path)),
    [rows, checked],
  );
  const batch = checkedRows.length > 1;
  // Files a save/tool will touch: the checked set if any, else the selected single file.
  const targets = useMemo<Track[]>(
    () => (checkedRows.length > 0 ? checkedRows : current ? [current] : []),
    [checkedRows, current],
  );

  // Re-seed the form whenever the selection or the underlying row changes.
  useEffect(() => {
    setCoverAction(0);
    setCoverPath('');
    setCoverDataUrl(null);
    setCoverNote(null);
    if (batch) {
      // common values across the checked set; differing → blank (leave-untouched).
      const common = (get: (t: Track) => string): string => {
        const first = get(checkedRows[0]!);
        return checkedRows.every((r) => get(r) === first) ? first : '';
      };
      setForm({
        Title: common((r) => r.Title),
        Artist: common((r) => r.Artist),
        Album: common((r) => r.Album),
        AlbumArtist: common((r) => r.AlbumArtist),
        Track: '',
        Disc: common((r) => r.Disc),
        Year: common((r) => r.Year),
        Genre: common((r) => r.Genre),
        Composer: common((r) => r.Composer),
        Comment: common((r) => r.Comment),
      });
    } else if (current) {
      setForm({
        Title: current.Title, Artist: current.Artist, Album: current.Album,
        AlbumArtist: current.AlbumArtist, Track: current.Track, Disc: current.Disc,
        Year: current.Year, Genre: current.Genre, Composer: current.Composer,
        Comment: current.Comment,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current, batch, checkedRows.length]);

  const setField = (k: keyof EditForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const toggleCheck = (path: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });

  const revert = () => {
    // re-run the seeding effect by nudging selection identity
    setCoverAction(0); setCoverPath(''); setCoverDataUrl(null); setCoverNote(null);
    if (current) {
      setForm({
        Title: current.Title, Artist: current.Artist, Album: current.Album,
        AlbumArtist: current.AlbumArtist, Track: current.Track, Disc: current.Disc,
        Year: current.Year, Genre: current.Genre, Composer: current.Composer,
        Comment: current.Comment,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  };

  const pickFolder = async () => {
    if (!desktop) return;
    setNote(null);
    try {
      const res = await runPowershell(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.FolderBrowserDialog; ` +
          `$d.Description='${esc(t('audiotagger.pickTitle'))}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.SelectedPath }`,
      );
      const p = res.stdout.trim();
      if (p) { setSelected(null); setChecked(new Set()); setFolder(p); }
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e));
    }
  };

  // ── cover art: extract current file's embedded art to a data URL for preview ──
  const coverQ = useAsync<string | null>(async () => {
    if (!desktop || !hasFfmpeg || batch || !current) return null;
    const ext = current.Ext.toLowerCase();
    if (!COVER_EXTS.has(ext)) return null;
    try {
      // ffmpeg extracts the attached picture stream to a temp png, we base64 it.
      const script =
        `$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source; if(-not $ff){ ''; return }\n` +
        `$src='${esc(current.Path)}'\n` +
        `$png=[System.IO.Path]::Combine($env:TEMP, ('wf_cover_' + [guid]::NewGuid().ToString('N') + '.png'))\n` +
        `& $ff -y -hide_banner -loglevel error -i $src -an -vcodec png -frames:v 1 $png 2>$null | Out-Null\n` +
        `if(Test-Path -LiteralPath $png){ [Convert]::ToBase64String([IO.File]::ReadAllBytes($png)); Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue } else { '' }`;
      const r = await runPowershell(script);
      const b64 = r.stdout.trim();
      return b64 ? `data:image/png;base64,${b64}` : null;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, hasFfmpeg, batch, current?.Path]);

  const loadCover = async () => {
    if (!desktop) return;
    setCoverNote(null);
    try {
      const res = await runPowershell(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; ` +
          `$d.Filter='Images|*.jpg;*.jpeg;*.png;*.bmp;*.gif;*.webp'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const p = res.stdout.trim();
      if (!p) return;
      // preview the picked image inline
      const b64r = await runPowershell(
        `$b=[System.IO.Path]::GetExtension('${esc(p)}').TrimStart('.').ToLower(); ` +
          `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${esc(p)}'))`,
      );
      const b64 = b64r.stdout.trim();
      setCoverPath(p);
      setCoverAction(1);
      setCoverDataUrl(b64 ? `data:image/*;base64,${b64}` : null);
      setCoverNote(t('audiotagger.coverStaged'));
    } catch (e) {
      setCoverNote(String(e instanceof Error ? e.message : e));
    }
  };

  const removeCover = () => {
    setCoverAction(2);
    setCoverPath('');
    setCoverDataUrl(null);
    setCoverNote(t('audiotagger.coverWillRemove'));
  };

  // ── save edited tags (single or batch) — write-gated via ffmpeg ──
  const save = async () => {
    if (!desktop || targets.length === 0) return;
    if (!hasFfmpeg) { setNote(t('audiotagger.needFfmpeg')); return; }
    const cover = coverAction === 1 ? coverPath : coverAction === 2 ? '' : null;
    const metaArgs = metaArgsFor(form, batch);
    if (!metaArgs && cover === null) { setNote(t('audiotagger.nothingToSave')); return; }
    if (
      batch &&
      !window.confirm(t('audiotagger.saveConfirm', { num: targets.length }))
    ) {
      return;
    }
    setBusy(true);
    setNote(null);
    let ok = 0;
    let fail = 0;
    const errs: string[] = [];
    try {
      for (const trk of targets) {
        try {
          const r = await runPowershell(ffmpegWriteScript(trk.Path, metaArgs, cover));
          if (r.success && r.stdout.trim().endsWith('ok')) ok++;
          else { fail++; errs.push(`${trk.FileName}: ${r.stderr.trim() || r.stdout.trim() || 'ffmpeg'}`); }
        } catch (e) {
          fail++;
          errs.push(`${trk.FileName}: ${String(e instanceof Error ? e.message : e)}`);
        }
      }
      setNote(
        t('audiotagger.saveDone', { ok, fail }) +
          (errs.length ? ` — ${errs.slice(0, 2).join(' | ')}` : ''),
      );
      reload();
    } finally {
      setBusy(false);
    }
  };

  // filename → tags preview (read-only)
  const fromPreview = useMemo(() => {
    const list = targets.length > 0 ? targets.slice(0, 8) : rows.slice(0, 8);
    if (list.length === 0) return [];
    return list.map((trk) => {
      const parsed = parseFromName(trk.FileName, fromPattern);
      if (!parsed) return { file: trk.FileName, ok: false, text: t('audiotagger.noMatch') };
      const bits = TOKENS.filter((k) => parsed[k]).map((k) => `${k}=${parsed[k]}`);
      return { file: trk.FileName, ok: true, text: bits.join(', ') || t('audiotagger.nothing') };
    });
  }, [targets, rows, fromPattern, t]);

  // ── tag-from-filename APPLY (write-gated via ffmpeg) ──
  const applyFromName = async () => {
    if (!desktop || targets.length === 0) return;
    if (!hasFfmpeg) { setNote(t('audiotagger.needFfmpeg')); return; }
    if (!window.confirm(t('audiotagger.fromNameConfirm', { num: targets.length, pattern: fromPattern }))) {
      return;
    }
    setBusy(true);
    setNote(null);
    let ok = 0, skip = 0, fail = 0;
    try {
      for (const trk of targets) {
        const parsed = parseFromName(trk.FileName, fromPattern);
        if (!parsed) { skip++; continue; }
        const edit: Partial<EditForm> = {};
        for (const [tok, v] of Object.entries(parsed)) {
          const field = TOKEN_FIELD[tok];
          if (field) edit[field] = v;
        }
        const metaArgs = metaArgsFor(edit, true);
        if (!metaArgs) { skip++; continue; }
        try {
          const r = await runPowershell(ffmpegWriteScript(trk.Path, metaArgs, null));
          if (r.success && r.stdout.trim().endsWith('ok')) ok++; else fail++;
        } catch { fail++; }
      }
      setNote(t('audiotagger.fromNameDone', { ok, skip, fail }));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const toPreview = useMemo(() => {
    const list = targets.length > 0 ? targets.slice(0, 8) : rows.slice(0, 8);
    return list.map((trk) => {
      const ext = trk.Ext ? `.${trk.Ext.toLowerCase()}` : '';
      return { file: trk.FileName, next: `${buildName(trk, toPattern)}${ext}` };
    });
  }, [targets, rows, toPattern]);

  const doRename = async () => {
    if (!desktop) return;
    const list = targets.length > 0 ? targets : rows;
    if (list.length === 0) return;
    const scope =
      targets.length === 1
        ? targets[0]!.FileName
        : t('audiotagger.allInList', { num: list.length });
    if (!window.confirm(t('audiotagger.renameConfirm', { scope, pattern: toPattern }))) {
      return;
    }
    setBusy(true);
    setNote(null);
    let ok = 0;
    let fail = 0;
    try {
      for (const trk of list) {
        const base = buildName(trk, toPattern);
        const ext = trk.Ext ? `.${trk.Ext.toLowerCase()}` : '';
        const newName = `${base}${ext}`;
        if (newName === trk.FileName) continue;
        const res = await runPowershell(
          `$src='${esc(trk.Path)}'; $dir=Split-Path -Parent $src; ` +
            `$dst=Join-Path $dir '${esc(newName)}'; ` +
            `if($src -ieq $dst){ 'same' } elseif(Test-Path -LiteralPath $dst){ throw 'exists' } ` +
            `else { Rename-Item -LiteralPath $src -NewName '${esc(newName)}' -ErrorAction Stop; 'ok' }`,
        );
        if (res.success) ok++; else fail++;
      }
      setNote(t('audiotagger.renameDone', { ok, fail }));
      reload();
    } catch (e) {
      setNote(`${t('audiotagger.renameFailed')}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Track>[] = [
    {
      key: 'check',
      header: (
        <input
          type="checkbox"
          aria-label={t('audiotagger.selectAll')}
          checked={rows.length > 0 && rows.every((r) => checked.has(r.Path))}
          onChange={(e) =>
            setChecked(e.target.checked ? new Set(rows.map((r) => r.Path)) : new Set())
          }
        />
      ),
      width: 32,
      render: (r) => (
        <input
          type="checkbox"
          aria-label={r.FileName}
          checked={checked.has(r.Path)}
          onChange={() => toggleCheck(r.Path)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      key: 'Title',
      header: t('audiotagger.colTitle'),
      render: (r) => (
        <div
          role="button"
          onClick={() => setSelected(r.Path)}
          style={{
            cursor: 'pointer',
            fontWeight: selected === r.Path ? 700 : undefined,
          }}
        >
          <div style={{ fontWeight: 600 }}>{r.Title || r.FileName}</div>
          <div className="count-note" style={{ margin: 0 }}>{r.FileName}</div>
        </div>
      ),
    },
    { key: 'Artist', header: t('audiotagger.colArtist'), width: 140, render: (r) => r.Artist || '—' },
    { key: 'Album', header: t('audiotagger.colAlbum'), width: 140, render: (r) => r.Album || '—' },
    { key: 'Track', header: t('audiotagger.colTrack'), width: 56, render: (r) => r.Track || '' },
    { key: 'Year', header: t('audiotagger.colYear'), width: 56, render: (r) => r.Year || '' },
    { key: 'Duration', header: t('audiotagger.colTime'), width: 72, render: (r) => r.Duration || '' },
  ];

  const canEdit = targets.length > 0;
  const coverExt = current ? current.Ext.toLowerCase() : '';
  const coverSupported = !batch && !!current && COVER_EXTS.has(coverExt);
  const previewCover = coverAction === 2 ? null : coverDataUrl ?? coverQ.data;

  // ── editor field row ──
  const fieldRow = (
    key: keyof EditForm,
    label: string,
    opts?: { area?: boolean; ph?: string },
  ) => (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <div className="count-note" style={{ margin: '0 0 2px' }}>{label}</div>
      {opts?.area ? (
        <textarea
          className="hosts-edit"
          style={{ width: '100%', minHeight: 54, resize: 'vertical' }}
          value={form[key]}
          disabled={!canEdit}
          placeholder={opts?.ph}
          onChange={(e) => setField(key, e.target.value)}
        />
      ) : (
        <input
          className="mod-search"
          style={{ width: '100%' }}
          value={form[key]}
          disabled={!canEdit}
          placeholder={opts?.ph}
          onChange={(e) => setField(key, e.target.value)}
        />
      )}
    </label>
  );

  const editorPane = (
    <div className="hosts-edit" style={{ minWidth: 280 }}>
      <h4 style={{ marginTop: 0 }}>{t('audiotagger.editorHeader')}</h4>
      {!canEdit ? (
        <p className="count-note">{t('audiotagger.selectHint')}</p>
      ) : (
        <>
          <p className="count-note" style={{ marginTop: 0, wordBreak: 'break-all' }}>
            {batch
              ? t('audiotagger.batchInfo', { num: targets.length })
              : current?.FileName}
          </p>

          {/* cover art */}
          <div
            style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              margin: '4px 0 10px', padding: 8, borderRadius: 6,
              background: 'var(--surface-2, rgba(127,127,127,0.08))',
            }}
          >
            <div
              style={{
                width: 88, height: 88, flex: '0 0 auto', borderRadius: 4,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(127,127,127,0.12)', overflow: 'hidden',
                border: '1px solid rgba(127,127,127,0.25)',
              }}
            >
              {previewCover ? (
                <img src={previewCover} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span className="count-note" style={{ fontSize: 22 }}>♪</span>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <div className="count-note" style={{ fontWeight: 600, margin: 0 }}>
                {t('audiotagger.coverLbl')}
              </div>
              {coverSupported || batch ? (
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <button className="mini" disabled={!desktop || busy} onClick={loadCover}>
                    {t('audiotagger.loadCover')}
                  </button>
                  <button className="mini" disabled={!desktop || busy} onClick={removeCover}>
                    {t('audiotagger.removeCover')}
                  </button>
                </div>
              ) : (
                <p className="count-note" style={{ margin: '4px 0 0' }}>
                  {t('audiotagger.coverUnsupported')}
                </p>
              )}
              {coverNote && <p className="count-note" style={{ margin: '4px 0 0' }}>{coverNote}</p>}
            </div>
          </div>

          {fieldRow('Title', t('audiotagger.fTitle'))}
          {fieldRow('Artist', t('audiotagger.fArtist'), { ph: t('audiotagger.multiHint') })}
          {fieldRow('Album', t('audiotagger.fAlbum'))}
          {fieldRow('AlbumArtist', t('audiotagger.fAlbumArtist'))}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>{fieldRow('Track', t('audiotagger.fTrack'))}</div>
            <div style={{ flex: 1 }}>{fieldRow('Disc', t('audiotagger.fDisc'))}</div>
            <div style={{ flex: 1 }}>{fieldRow('Year', t('audiotagger.fYear'))}</div>
          </div>
          {fieldRow('Genre', t('audiotagger.fGenre'))}
          {fieldRow('Composer', t('audiotagger.fComposer'))}
          {fieldRow('Comment', t('audiotagger.fComment'), { area: true })}

          {!batch && current && (
            <p className="count-note">
              {[
                current.Duration,
                current.Bitrate,
                current.SampleRate && `${current.SampleRate}`,
                current.Channels,
                current.Ext,
              ]
                .filter((x) => x && String(x).length)
                .join(' · ')}
            </p>
          )}

          {batch && (
            <p className="count-note">{t('audiotagger.batchHint')}</p>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="mini primary" disabled={!desktop || busy} onClick={save}>
              {t('audiotagger.saveTags')}
            </button>
            <button className="mini" disabled={busy} onClick={revert}>
              {t('audiotagger.revert')}
            </button>
          </div>
          {desktop && !hasFfmpeg && (
            <p className="count-note" style={{ marginTop: 6 }}>{t('audiotagger.needFfmpeg')}</p>
          )}
        </>
      )}
    </div>
  );

  const toolsPane = (
    <div className="hosts-edit" style={{ minWidth: 280 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{t('audiotagger.fromNameLbl')}</div>
        <input
          className="mod-search"
          style={{ width: '100%', marginTop: 4 }}
          value={fromPattern}
          onChange={(e) => setFromPattern(e.target.value)}
        />
        <p className="count-note" style={{ marginTop: 4 }}>{t('audiotagger.fromNameHint')}</p>
        {fromPreview.map((p) => (
          <div key={p.file} className="count-note" style={{ margin: '2px 0' }}>
            {p.ok ? '✓' : '✗'} {p.file} → {p.text}
          </div>
        ))}
        <button
          className="mini primary"
          style={{ marginTop: 6 }}
          disabled={!desktop || busy || targets.length === 0}
          onClick={applyFromName}
        >
          {t('audiotagger.fromNameApply')}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600 }}>{t('audiotagger.toNameLbl')}</div>
        <input
          className="mod-search"
          style={{ width: '100%', marginTop: 4 }}
          value={toPattern}
          onChange={(e) => setToPattern(e.target.value)}
        />
        <p className="count-note" style={{ marginTop: 4 }}>{t('audiotagger.toNameHint')}</p>
        {toPreview.map((p) => (
          <div key={p.file} className="count-note" style={{ margin: '2px 0', wordBreak: 'break-all' }}>
            {p.file} → {p.next}
          </div>
        ))}
        <button
          className="mini primary"
          style={{ marginTop: 6 }}
          disabled={!desktop || busy || rows.length === 0}
          onClick={doRename}
        >
          {targets.length === 1 ? t('audiotagger.renameOne') : t('audiotagger.renameAll')}
        </button>
      </div>
    </div>
  );

  const libraryTab = (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '2 1 360px', minWidth: 320 }}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.Path}
          empty={t('audiotagger.noRows')}
        />
      </div>
      <div style={{ flex: '1 1 300px', minWidth: 280 }}>{editorPane}</div>
    </div>
  );

  const tabs = [
    { id: 'library', en: 'Library · 音樂庫', zh: '音樂庫', render: () => libraryTab },
    { id: 'tools', en: 'Filename ⇄ tags · 檔名 ⇄ 標籤', zh: '檔名 ⇄ 標籤', render: () => toolsPane },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('audiotagger.blurb')}</p>

      <ModuleToolbar>
        <button className="mini primary" onClick={pickFolder} disabled={!desktop}>
          {t('audiotagger.openFolder')}
        </button>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder={t('audiotagger.folderPlaceholder')}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={recurse} onChange={(e) => setRecurse(e.target.checked)} />
          {t('audiotagger.recurse')}
        </label>
        <button className="mini" onClick={reload}>⟳ {t('modules.refresh')}</button>
      </ModuleToolbar>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('audiotagger.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count-note">{t('audiotagger.count', { num: rows.length })}</span>
        {checkedRows.length > 0 && (
          <span className="count-note">{t('audiotagger.checkedCount', { num: checkedRows.length })}</span>
        )}
        {desktop && (
          <StatusDot ok={hasFfmpeg} label={t('audiotagger.ffmpegLbl')} />
        )}
      </ModuleToolbar>

      {!desktop && <p className="count-note">{t('audiotagger.desktopOnly')}</p>}
      {note && <p className="mod-msg">{note}</p>}

      <AsyncState loading={loading} error={error}>
        {folder === '' ? (
          <p className="count-note">{t('audiotagger.empty')}</p>
        ) : (
          <ModuleTabs tabs={tabs} />
        )}
      </AsyncState>
    </div>
  );
}
