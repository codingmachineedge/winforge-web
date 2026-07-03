import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

// ── Ported from WinForge Pages/AudioTaggerModule + Services/AudioTagService.
// Native, Mp3tag-style tag view. The desktop reads audio metadata (title, artist,
// album, album artist, track, year, genre, composer, duration, bit rate, sample
// rate, channels) for any format Windows can index (mp3, flac, m4a, wma, wav…) via
// the Windows Property System (Shell.Application GetDetailsOf) — pure built-in, no
// external tool. It also ships the two filename ⇄ tag helpers: "tag from filename"
// (preview parse) and "rename from tags" (preview + confirm-gated apply on disk).

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

export function AudioTaggerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [folder, setFolder] = useState('');
  const [recurse, setRecurse] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [fromPattern, setFromPattern] = useState('%artist% - %title%');
  const [toPattern, setToPattern] = useState('%track% - %artist% - %title%');
  const [renameBusy, setRenameBusy] = useState(false);

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
      if (p) { setSelected(null); setFolder(p); }
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e));
    }
  };

  const doRename = async () => {
    if (!desktop || rows.length === 0) return;
    const targets = current ? [current] : rows;
    const scope = current ? current.FileName : t('audiotagger.allInList', { num: rows.length });
    if (
      !window.confirm(
        t('audiotagger.renameConfirm', { scope, pattern: toPattern }),
      )
    ) {
      return;
    }
    setRenameBusy(true);
    setNote(null);
    let ok = 0;
    let fail = 0;
    try {
      for (const trk of targets) {
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
      setRenameBusy(false);
    }
  };

  // filename → tags preview (read-only)
  const fromPreview = useMemo(() => {
    const targets = current ? [current] : rows.slice(0, 8);
    if (targets.length === 0) return [];
    return targets.map((trk) => {
      const parsed = parseFromName(trk.FileName, fromPattern);
      if (!parsed) return { file: trk.FileName, ok: false, text: t('audiotagger.noMatch') };
      const bits = TOKENS.filter((k) => parsed[k]).map((k) => `${k}=${parsed[k]}`);
      return { file: trk.FileName, ok: true, text: bits.join(', ') || t('audiotagger.nothing') };
    });
  }, [current, rows, fromPattern, t]);

  const toPreview = useMemo(() => {
    const targets = current ? [current] : rows.slice(0, 8);
    return targets.map((trk) => {
      const ext = trk.Ext ? `.${trk.Ext.toLowerCase()}` : '';
      return { file: trk.FileName, next: `${buildName(trk, toPattern)}${ext}` };
    });
  }, [current, rows, toPattern]);

  const columns: Column<Track>[] = [
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
    { key: 'Artist', header: t('audiotagger.colArtist'), width: 150, render: (r) => r.Artist || '—' },
    { key: 'Album', header: t('audiotagger.colAlbum'), width: 150, render: (r) => r.Album || '—' },
    { key: 'Track', header: t('audiotagger.colTrack'), width: 64, render: (r) => r.Track || '' },
    { key: 'Year', header: t('audiotagger.colYear'), width: 64, render: (r) => r.Year || '' },
    { key: 'Duration', header: t('audiotagger.colTime'), width: 80, render: (r) => r.Duration || '' },
  ];

  const detailRows: Array<[string, string]> = current
    ? ([
        [t('audiotagger.fTitle'), current.Title],
        [t('audiotagger.fArtist'), current.Artist],
        [t('audiotagger.fAlbum'), current.Album],
        [t('audiotagger.fAlbumArtist'), current.AlbumArtist],
        [t('audiotagger.fTrack'), current.Track],
        [t('audiotagger.fDisc'), current.Disc],
        [t('audiotagger.fYear'), current.Year],
        [t('audiotagger.fGenre'), current.Genre],
        [t('audiotagger.fComposer'), current.Composer],
        [t('audiotagger.fComment'), current.Comment],
      ] as Array<[string, string]>).filter(([, v]) => v.length > 0)
    : [];

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
      </ModuleToolbar>

      {!desktop && <p className="count-note">{t('audiotagger.desktopOnly')}</p>}
      {note && <p className="mod-msg">{note}</p>}

      <AsyncState loading={loading} error={error}>
        {folder === '' ? (
          <p className="count-note">{t('audiotagger.empty')}</p>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '2 1 360px', minWidth: 320 }}>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.Path}
                empty={t('audiotagger.noRows')}
              />
            </div>

            <div className="hosts-edit" style={{ flex: '1 1 300px', minWidth: 280 }}>
              <h4 style={{ marginTop: 0 }}>{t('audiotagger.editorHeader')}</h4>
              {!current ? (
                <p className="count-note">{t('audiotagger.selectHint')}</p>
              ) : (
                <>
                  <p className="count-note" style={{ marginTop: 0, wordBreak: 'break-all' }}>
                    {current.FileName}
                  </p>
                  <table className="dt">
                    <tbody>
                      {detailRows.map(([k, v]) => (
                        <tr key={k}>
                          <td style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{k}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                </>
              )}

              <div style={{ marginTop: 12 }}>
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
              </div>

              <div style={{ marginTop: 12 }}>
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
                  disabled={!desktop || renameBusy || rows.length === 0}
                  onClick={doRename}
                >
                  {current ? t('audiotagger.renameOne') : t('audiotagger.renameAll')}
                </button>
              </div>
            </div>
          </div>
        )}
      </AsyncState>
    </div>
  );
}
