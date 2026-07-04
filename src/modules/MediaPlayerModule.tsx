import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { getEnv, isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { resolveTool } from '../tauri/deps';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Ported from WinForge Pages/MediaPlayerModule.xaml(.cs) + Services/MediaPlayerService.cs.
// The desktop module embeds libVLC; here the same 36-feature surface runs on a real HTML5
// <video> element fed from disk through the backend (PowerShell base64 → blob URL — same
// pattern GifLab uses for frames), plus ffmpeg/ffprobe via resolveTool for everything the
// element cannot do natively:
//   Player      — open file… (picker) · add to playlist… (multi picker) · open URL/stream ·
//                 add disk path · video surface + no-media hint · seek slider + cur/total time ·
//                 prev / play-pause / stop / next (wrap like C#) · auto-advance on end ·
//                 mute toggle + volume 0..100 (raising unmutes) · speed 0.5–2.0× ·
//                 snapshot PNG (ffmpeg frame-grab to Pictures for disk entries, canvas
//                 otherwise) · fullscreen toggle · playback-error bar (EncounteredError parity).
//   Tracks      — audio-track list (ffprobe streams; in-element switching when the browser
//                 exposes audioTracks) · subtitle track combo with explicit “Off” ·
//                 load external subtitle file (srt/vtt/ass→WebVTT) · extract embedded subtitle
//                 streams with ffmpeg · subtitle delay in seconds (cue re-timing).
//   Playlist    — list + selection + double-click/row play · play selected · remove selected
//                 (index fixups like C#) · clear · reorder up/down · shuffle · repeat off/all/one ·
//                 named playlists saved/loaded/deleted in localStorage · current list + player
//                 prefs persisted across sessions.
//   Transcode   — the exact five desktop presets (libVLC sout chains mapped 1:1 to ffmpeg),
//                 source = local playlist file (C# rule), editable output path, gated overwrite
//                 confirm, live progress parsed from ffmpeg stderr (detached process + log
//                 tail), cancel, result bar with log tail.
//   Library     — recursive Videos+Music scan (kept from the earlier port) upgraded with
//                 sort buttons and per-row Play/Queue actions feeding the playlist.
//   Devices     — playback/capture endpoints (kept). Codecs — DirectShow registry list (kept).

// ===================== shared helpers =====================

const esc = (s: string) => s.replace(/'/g, "''");
const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

function stamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** C# Fmt(ms) parity: mm:ss, or h:mm:ss at ≥ 1 hour. */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h >= 1 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

// Same extension buckets as the C# MediaFilters().
const VIDEO_EXT = 'mp4,mkv,avi,mov,webm,flv,wmv,m4v,mpg,mpeg,ts,m2ts';
const AUDIO_EXT = 'mp3,flac,wav,aac,ogg,opus,m4a,wma';
const FILE_ACCEPT =
  'video/*,audio/*,' +
  VIDEO_EXT.split(',').map((e) => `.${e}`).join(',') +
  ',' +
  AUDIO_EXT.split(',').map((e) => `.${e}`).join(',');

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mov: 'video/quicktime', webm: 'video/webm', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** In-app streaming cap for base64 reads through the bridge (memory-safe). */
const MAX_LOAD_MB = 200;

// ── subtitle format converters (external + extracted tracks are normalised to WebVTT) ──

function srtToVtt(src: string): string {
  const body = src
    .replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

function assToVtt(src: string): string {
  const cues: string[] = [];
  const toVtt = (t: string): string => {
    // ASS time = H:MM:SS.cc → HH:MM:SS.cc0
    const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
    if (!m) return '00:00:00.000';
    return `${pad2(Number(m[1]))}:${m[2]}:${m[3]}.${m[4]}0`;
  };
  for (const line of src.split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue;
    const parts = line.slice('Dialogue:'.length).split(',');
    if (parts.length < 10) continue;
    const start = parts[1] ?? '';
    const end = parts[2] ?? '';
    const text = parts
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .trim();
    if (!text) continue;
    cues.push(`${toVtt(start)} --> ${toVtt(end)}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}`;
}

/** Shift every WebVTT timestamp by delaySec (clamped at 0) — powers the C# SubDelay box. */
function shiftVtt(vtt: string, delaySec: number): string {
  if (!delaySec) return vtt;
  return vtt.replace(/(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/g, (_all, h, m, s, ms) => {
    let total =
      Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms) + delaySec * 1000;
    if (total < 0) total = 0;
    const hh = Math.floor(total / 3600000);
    const mm = Math.floor((total / 60000) % 60);
    const ss = Math.floor((total / 1000) % 60);
    const mss = Math.floor(total % 1000);
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${String(mss).padStart(3, '0')}`;
  });
}

// ── transcode presets: the C# MediaPlayerService.Presets sout chains mapped 1:1 to ffmpeg ──

interface Preset {
  key: string;
  en: string;
  zh: string;
  ext: string;
  video: string;
  audio: string;
  /** ffmpeg argument mapping of the libVLC sout chain ({in}/{out} placeholders). */
  args: string[];
}

const PRESETS: Preset[] = [
  {
    key: 'mp4', en: 'MP4 · H.264 + AAC', zh: 'MP4 · H.264 + AAC', ext: '.mp4', video: 'H.264', audio: 'AAC',
    args: ['-i', '{in}', '-c:v', 'libx264', '-b:v', '2000k', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '44100', '-movflags', '+faststart', '{out}'],
  },
  {
    key: 'mp3', en: 'MP3 (audio only)', zh: 'MP3（淨音訊）', ext: '.mp3', video: '—', audio: 'MP3',
    args: ['-i', '{in}', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', '-ar', '44100', '{out}'],
  },
  {
    key: 'webm', en: 'WebM · VP8 + Vorbis', zh: 'WebM · VP8 + Vorbis', ext: '.webm', video: 'VP8', audio: 'Vorbis',
    args: ['-i', '{in}', '-c:v', 'libvpx', '-b:v', '2000k', '-c:a', 'libvorbis', '-b:a', '192k', '-ac', '2', '-ar', '44100', '{out}'],
  },
  {
    key: 'wav', en: 'WAV (audio only)', zh: 'WAV（無損音訊）', ext: '.wav', video: '—', audio: 'PCM s16l',
    args: ['-i', '{in}', '-vn', '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '44100', '{out}'],
  },
  {
    key: 'ogg', en: 'OGG/Theora', zh: 'OGG/Theora · 開放格式', ext: '.ogg', video: 'Theora', audio: 'Vorbis',
    args: ['-i', '{in}', '-c:v', 'libtheora', '-b:v', '2000k', '-c:a', 'libvorbis', '-b:a', '192k', '{out}'],
  },
];

// ── playlist model ──

type EntryKind = 'path' | 'url' | 'file';

interface Entry {
  id: string;
  kind: EntryKind;
  /** Display name (file name, or the URL itself — C# DisplayName parity). */
  name: string;
  /** Absolute disk path or URL; empty for browser-picked files. */
  path: string;
  file?: File;
}

interface PersistEntry {
  kind: 'path' | 'url';
  name: string;
  path: string;
}

const LS_STATE = 'winforge.mediaplayer.state';
const LS_LISTS = 'winforge.mediaplayer.playlists';

interface PersistState {
  list: PersistEntry[];
  volume: number;
  rate: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

function loadPersist(): PersistState {
  const fallback: PersistState = { list: [], volume: 100, rate: 1, shuffle: false, repeat: 'off' };
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<PersistState>;
    return {
      list: Array.isArray(p.list)
        ? p.list.filter((e): e is PersistEntry =>
            !!e && (e.kind === 'path' || e.kind === 'url') && typeof e.path === 'string' && typeof e.name === 'string')
        : [],
      volume: typeof p.volume === 'number' ? Math.min(100, Math.max(0, p.volume)) : 100,
      rate: typeof p.rate === 'number' ? p.rate : 1,
      shuffle: !!p.shuffle,
      repeat: p.repeat === 'all' || p.repeat === 'one' ? p.repeat : 'off',
    };
  } catch {
    return fallback;
  }
}

function loadSavedLists(): Record<string, PersistEntry[]> {
  try {
    const raw = localStorage.getItem(LS_LISTS);
    if (!raw) return {};
    const p = JSON.parse(raw) as Record<string, PersistEntry[]>;
    return typeof p === 'object' && p !== null ? p : {};
  } catch {
    return {};
  }
}

// ── ffprobe stream model ──

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  tags?: { language?: string; title?: string };
}

interface ProbeInfo {
  audio: ProbeStream[];
  subs: ProbeStream[];
  durationSec: number;
}

function streamLabel(s: ProbeStream, i: number): string {
  const bits = [`#${i}`, s.codec_name ?? '', s.tags?.language ?? '', s.tags?.title ?? ''];
  return bits.filter(Boolean).join(' · ');
}

interface SubTrack {
  id: string;
  label: string;
  vtt: string;
}

// ===================== Library tab · 媒體庫 =====================

interface MediaFile {
  Name: string;
  Folder: string;
  Kind: string;
  Ext: string;
  SizeMB: number;
  Modified: string;
  Path: string;
}

type LibSort = 'name' | 'size' | 'modified';

function LibraryTab({
  onPlay,
  onQueue,
}: {
  onPlay: (f: MediaFile) => void;
  onQueue: (f: MediaFile) => void;
}) {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | 'Video' | 'Audio'>('all');
  const [sortKey, setSortKey] = useState<LibSort>('modified');
  const [sortAsc, setSortAsc] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => {
      if (!desktop) return Promise.resolve([] as MediaFile[]);
      return runPowershellJson<MediaFile>(
        // Scan the user's Videos + Music known folders (recurse), classify by extension,
        // emit clean string/number fields so ConvertTo-Json stays flat.
        `$roots=@([Environment]::GetFolderPath('MyVideos'),[Environment]::GetFolderPath('MyMusic')) |
           Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
         $video='${VIDEO_EXT}'.Split(',')
         $audio='${AUDIO_EXT}'.Split(',')
         $all=@($video+$audio)
         $roots | ForEach-Object {
           Get-ChildItem -LiteralPath $_ -Recurse -File -ErrorAction SilentlyContinue |
             Where-Object { $all -contains ($_.Extension.TrimStart('.').ToLower()) }
         } | Select-Object -First 500 | ForEach-Object {
           $x=$_.Extension.TrimStart('.').ToLower()
           [pscustomobject]@{
             Name=$_.Name
             Folder=$_.DirectoryName
             Kind=$(if($video -contains $x){'Video'}else{'Audio'})
             Ext=$x
             SizeMB=[math]::Round($_.Length/1MB,1)
             Modified=$_.LastWriteTime.ToString('yyyy-MM-dd')
             Path=$_.FullName
           }
         }`,
      );
    },
    [desktop],
  );

  const rows = useMemo(() => {
    let all = data ?? [];
    if (kind !== 'all') all = all.filter((m) => m.Kind === kind);
    const q = filter.trim().toLowerCase();
    if (q) all = all.filter((m) => `${m.Name} ${m.Folder} ${m.Ext}`.toLowerCase().includes(q));
    const dir = sortAsc ? 1 : -1;
    return [...all].sort((a, b) => {
      if (sortKey === 'size') return (a.SizeMB - b.SizeMB) * dir;
      if (sortKey === 'name') return a.Name.localeCompare(b.Name) * dir;
      return (a.Modified || '').localeCompare(b.Modified || '') * dir;
    });
  }, [data, filter, kind, sortKey, sortAsc]);

  const totalMB = useMemo(() => rows.reduce((s, r) => s + (r.SizeMB || 0), 0), [rows]);

  const sortBtn = (key: LibSort, label: string) => (
    <button
      className={`mini${sortKey === key ? ' primary' : ''}`}
      onClick={() => {
        if (sortKey === key) setSortAsc((v) => !v);
        else {
          setSortKey(key);
          setSortAsc(key === 'name');
        }
      }}
    >
      {label}
      {sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </button>
  );

  const columns: Column<MediaFile>[] = [
    {
      key: 'Kind',
      header: t('mediaplayer.colKind'),
      width: 90,
      render: (m) => <StatusDot ok={m.Kind === 'Video'} label={t(`mediaplayer.kind${m.Kind}`)} />,
    },
    { key: 'Name', header: t('mediaplayer.colName') },
    { key: 'Ext', header: t('mediaplayer.colExt'), width: 70 },
    { key: 'SizeMB', header: t('mediaplayer.colSize'), width: 100, align: 'right', render: (m) => `${m.SizeMB} MB` },
    { key: 'Modified', header: t('mediaplayer.colModified'), width: 110 },
    { key: 'Folder', header: t('mediaplayer.colFolder') },
    {
      key: 'actions',
      header: '',
      width: 150,
      render: (m) => (
        <span className="row-actions">
          <button className="mini primary" onClick={() => onPlay(m)}>
            ▶ {t('mediaplayer.play')}
          </button>
          <button className="mini" onClick={() => onQueue(m)}>
            + {t('mediaplayer.queue')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('mediaplayer.libFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className={`mini${kind === 'all' ? ' primary' : ''}`} onClick={() => setKind('all')}>
          {t('mediaplayer.filterAll')}
        </button>
        <button className={`mini${kind === 'Video' ? ' primary' : ''}`} onClick={() => setKind('Video')}>
          {t('mediaplayer.kindVideo')}
        </button>
        <button className={`mini${kind === 'Audio' ? ' primary' : ''}`} onClick={() => setKind('Audio')}>
          {t('mediaplayer.kindAudio')}
        </button>
        {sortBtn('name', t('mediaplayer.sortName'))}
        {sortBtn('size', t('mediaplayer.sortSize'))}
        {sortBtn('modified', t('mediaplayer.sortModified'))}
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {t('mediaplayer.libCount', { files: rows.length })} · {totalMB.toFixed(0)} MB
        </span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.libNote')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(m) => m.Path}
          empty={desktop ? t('mediaplayer.libEmpty') : t('mediaplayer.previewNote')}
        />
      </AsyncState>
    </div>
  );
}

// ===================== Devices tab · 音訊裝置 =====================

interface AudioDev {
  Status: string;
  FriendlyName: string;
  Class: string;
  InstanceId: string;
}

function AudioDevicesTab() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [filter, setFilter] = useState('');

  const { data, loading, error, reload } = useAsync(
    () => {
      if (!desktop) return Promise.resolve([] as AudioDev[]);
      return runPowershellJson<AudioDev>(
        // The playback/capture endpoints the player renders to — audio + video device classes.
        `Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.Class -in @('AudioEndpoint','Media','MEDIA','Camera','Image') } |
           Select-Object @{N='Status';E={$_.Status.ToString()}},FriendlyName,@{N='Class';E={$_.Class.ToString()}},InstanceId`,
      );
    },
    [desktop],
  );

  const rows = useMemo(() => {
    let all = data ?? [];
    const q = filter.trim().toLowerCase();
    if (q) all = all.filter((d) => `${d.FriendlyName} ${d.Class}`.toLowerCase().includes(q));
    return [...all].sort((a, b) => (a.Class || '').localeCompare(b.Class || ''));
  }, [data, filter]);

  const columns: Column<AudioDev>[] = [
    {
      key: 'Status',
      header: t('mediaplayer.colStatus'),
      width: 90,
      render: (d) => <StatusDot ok={d.Status === 'OK'} label={d.Status} />,
    },
    { key: 'Class', header: t('mediaplayer.colClass'), width: 140 },
    { key: 'FriendlyName', header: t('mediaplayer.colDevice') },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('mediaplayer.devFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('mediaplayer.devCount', { devices: rows.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.devNote')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => d.InstanceId}
          empty={desktop ? t('mediaplayer.devEmpty') : t('mediaplayer.previewNote')}
        />
      </AsyncState>
    </div>
  );
}

// ===================== Codecs tab · 編解碼 =====================

interface Codec {
  Name: string;
  Category: string;
}

function CodecsTab() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // Live: installed DirectShow filters (audio/video codecs) from the registry — read-only.
  const { data, loading, error, reload } = useAsync(
    () => {
      if (!desktop) return Promise.resolve([] as Codec[]);
      return runPowershellJson<Codec>(
        `$cats=@(
           @{Path='HKLM:\\SOFTWARE\\Classes\\CLSID\\{083863F1-70DE-11D0-BD40-00A0C911CE86}\\Instance';Cat='Video/Audio filter'},
           @{Path='HKLM:\\SOFTWARE\\Classes\\CLSID\\{33D9A760-90C8-11D0-BD43-00A0C911CE86}\\Instance';Cat='Video compressor'},
           @{Path='HKLM:\\SOFTWARE\\Classes\\CLSID\\{33D9A761-90C8-11D0-BD43-00A0C911CE86}\\Instance';Cat='Audio compressor'}
         )
         $cats | ForEach-Object {
           $cat=$_.Cat
           Get-ChildItem -LiteralPath $_.Path -ErrorAction SilentlyContinue | ForEach-Object {
             $n=(Get-ItemProperty -LiteralPath $_.PSPath -Name FriendlyName -ErrorAction SilentlyContinue).FriendlyName
             if($n){ [pscustomobject]@{ Name=$n; Category=$cat } }
           }
         } | Sort-Object Category,Name -Unique`,
      );
    },
    [desktop],
  );

  const codecs = data ?? [];

  const codecCols: Column<Codec>[] = [
    { key: 'Category', header: t('mediaplayer.colCategory'), width: 180 },
    { key: 'Name', header: t('mediaplayer.colCodec') },
  ];

  return (
    <div className="mod">
      <h3 style={{ margin: '4px 0' }}>{t('mediaplayer.codecTitle')}</h3>
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('mediaplayer.codecCount', { codecs: codecs.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.codecBlurb')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={codecCols}
          rows={codecs}
          rowKey={(c, i) => `${c.Category}-${c.Name}-${i}`}
          empty={desktop ? t('mediaplayer.codecEmpty') : t('mediaplayer.previewNote')}
        />
      </AsyncState>
    </div>
  );
}

// ===================== module =====================

interface Engine {
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string;
}

interface Msg {
  ok: boolean;
  title: string;
  text: string;
}

export function MediaPlayerModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const desktop = isTauri();

  // ── persisted state ──
  const persisted = useRef(loadPersist());

  const [entries, setEntries] = useState<Entry[]>(() =>
    persisted.current.list.map((e) => ({ id: uid(), kind: e.kind, name: e.name, path: e.path })),
  );
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [selIdx, setSelIdx] = useState(-1);
  const [volume, setVolume] = useState(persisted.current.volume);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(persisted.current.rate);
  const [shuffle, setShuffle] = useState(persisted.current.shuffle);
  const [repeat, setRepeat] = useState<'off' | 'all' | 'one'>(persisted.current.repeat);
  const [savedLists, setSavedLists] = useState<Record<string, PersistEntry[]>>(loadSavedLists);
  const [listName, setListName] = useState('');
  const [savedSel, setSavedSel] = useState('');

  // ── player state ──
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState('');
  const objUrl = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [curSec, setCurSec] = useState(0);
  const [durSec, setDurSec] = useState(0);
  const seeking = useRef(false);
  const [seekVal, setSeekVal] = useState(0);
  const [mediaLoading, setMediaLoading] = useState(false);
  const wantPlay = useRef(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [urlText, setUrlText] = useState('');
  const [pathText, setPathText] = useState('');
  const pendingPlay = useRef<number | null>(null);
  const loadToken = useRef(0);

  // ── tracks state ──
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [audioSel, setAudioSel] = useState(0);
  const [subTracks, setSubTracks] = useState<SubTrack[]>([]);
  const [subSel, setSubSel] = useState(''); // '' = Off
  const [subDelay, setSubDelay] = useState(0);
  const trackUrls = useRef<string[]>([]);
  const [extracting, setExtracting] = useState<number | null>(null);

  // ── transcode state (lives here so a tab switch never orphans a running job) ──
  const [tcSrcId, setTcSrcId] = useState('');
  const [tcPreset, setTcPreset] = useState('mp4');
  const [tcOut, setTcOut] = useState('');
  const [tcPid, setTcPid] = useState<number | null>(null);
  const [tcPct, setTcPct] = useState<number | null>(null);
  const [tcTail, setTcTail] = useState('');
  const [tcBusy, setTcBusy] = useState(false);
  const tcPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const tcDur = useRef(0);
  const tcOutRef = useRef('');

  // ── engine probe ──
  const engineQ = useAsync<Engine>(async () => {
    if (!desktop) return { ffmpeg: null, ffprobe: null, version: '' };
    const [ff, fp] = await Promise.all([resolveTool('ffmpeg'), resolveTool('ffprobe')]);
    let version = '';
    if (ff.path) {
      try {
        const r = await runCommand(ff.path, ['-hide_banner', '-version']);
        version = r.stdout.split(/\r?\n/)[0]?.trim() ?? '';
      } catch {
        /* version stays blank */
      }
    }
    return { ffmpeg: ff.path, ffprobe: fp.path, version };
  }, [desktop]);
  const engine = engineQ.data;

  const cur: Entry | undefined = currentIndex >= 0 ? entries[currentIndex] : undefined;

  // ── persistence effects ──
  useEffect(() => {
    try {
      const state: PersistState = {
        list: entries
          .filter((e): e is Entry & { kind: 'path' | 'url' } => e.kind !== 'file')
          .map((e) => ({ kind: e.kind, name: e.name, path: e.path })),
        volume,
        rate,
        shuffle,
        repeat,
      };
      localStorage.setItem(LS_STATE, JSON.stringify(state));
    } catch {
      /* storage may be unavailable */
    }
  }, [entries, volume, rate, shuffle, repeat]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_LISTS, JSON.stringify(savedLists));
    } catch {
      /* storage may be unavailable */
    }
  }, [savedLists]);

  // Cleanup: revoke blob URLs, stop polling.
  useEffect(
    () => () => {
      if (objUrl.current) URL.revokeObjectURL(objUrl.current);
      for (const u of trackUrls.current) URL.revokeObjectURL(u);
      if (tcPoll.current) clearInterval(tcPoll.current);
    },
    [],
  );

  // ── media element wiring ──
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume, src]);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted, src]);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate, src]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !src) return;
    el.load();
    if (wantPlay.current) {
      wantPlay.current = false;
      el.play().catch(() => {
        /* surfaced through the error handler / user presses play */
      });
    }
  }, [src]);

  const setResult = (ok: boolean, title: string, text: string) => setMsg({ ok, title, text });

  const clearSubs = () => {
    for (const u of trackUrls.current) URL.revokeObjectURL(u);
    trackUrls.current = [];
    setSubTracks([]);
    setSubSel('');
    setSubDelay(0);
  };

  // ── ffprobe tracks for disk entries ──
  const probeTracks = async (path: string) => {
    if (!desktop || !engine?.ffprobe) return;
    try {
      const r = await runCommand(engine.ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
      ]);
      const parsed = JSON.parse(r.stdout || '{}') as {
        streams?: ProbeStream[];
        format?: { duration?: string };
      };
      const streams = parsed.streams ?? [];
      setProbe({
        audio: streams.filter((s) => s.codec_type === 'audio'),
        subs: streams.filter((s) => s.codec_type === 'subtitle'),
        durationSec: Number(parsed.format?.duration ?? 0) || 0,
      });
    } catch {
      setProbe(null);
    }
  };

  // ── open / load media (C# PlayIndex) ──
  const playIndex = async (index: number, list?: Entry[]) => {
    const arr = list ?? entries;
    const entry = arr[index];
    if (!entry) return;
    const token = ++loadToken.current;
    setCurrentIndex(index);
    setSelIdx(index);
    setMsg(null);
    setProbe(null);
    setAudioSel(0);
    clearSubs();
    setCurSec(0);
    setDurSec(0);
    setMediaLoading(false); // a superseded slow disk load must not leave the overlay stuck
    wantPlay.current = true;

    const swapSrc = (next: string, revokable: boolean) => {
      if (objUrl.current) {
        URL.revokeObjectURL(objUrl.current);
        objUrl.current = null;
      }
      if (revokable) objUrl.current = next;
      setSrc(next);
    };

    if (entry.kind === 'url') {
      swapSrc(entry.path, false);
      return;
    }
    if (entry.kind === 'file' && entry.file) {
      swapSrc(URL.createObjectURL(entry.file), true);
      return;
    }
    // Disk path — stream through the backend as base64 → blob URL (GifLab pattern).
    if (!desktop) {
      setResult(false, t('mediaplayer.loadFailed'), t('mediaplayer.needDesktop'));
      return;
    }
    setMediaLoading(true);
    try {
      const meta = await runPowershellJson<{ Ok: boolean; Err: string; MB: number }>(
        `$p='${esc(entry.path)}'
         if (-not (Test-Path -LiteralPath $p)) { [pscustomobject]@{ Ok=$false; Err='missing'; MB=0 } }
         else {
           $mb=[math]::Round((Get-Item -LiteralPath $p).Length/1MB)
           if ($mb -gt ${MAX_LOAD_MB}) { [pscustomobject]@{ Ok=$false; Err='toobig'; MB=$mb } }
           else { [pscustomobject]@{ Ok=$true; Err=''; MB=$mb } }
         }`,
      );
      const m = meta[0];
      if (!m?.Ok) {
        if (m?.Err === 'toobig') {
          setResult(false, t('mediaplayer.loadFailed'), t('mediaplayer.tooBig', { mb: m.MB, limit: MAX_LOAD_MB }));
        } else {
          setResult(false, t('mediaplayer.loadFailed'), entry.path);
        }
        return;
      }
      const b64res = await runPowershell(
        `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${esc(entry.path)}'))`,
      );
      if (token !== loadToken.current) return; // user moved on mid-load
      const b64 = b64res.stdout.trim();
      if (!b64) {
        setResult(false, t('mediaplayer.loadFailed'), b64res.stderr.trim() || entry.name);
        return;
      }
      const mime = MIME[extOf(entry.name)] ?? 'application/octet-stream';
      const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
      if (token !== loadToken.current) return;
      swapSrc(URL.createObjectURL(blob), true);
      void probeTracks(entry.path);
    } catch (e) {
      setResult(false, t('mediaplayer.loadFailed'), String(e instanceof Error ? e.message : e));
    } finally {
      if (token === loadToken.current) setMediaLoading(false);
    }
  };

  // Deferred play for entries appended via functional setState.
  useEffect(() => {
    if (pendingPlay.current !== null) {
      const i = pendingPlay.current;
      pendingPlay.current = null;
      void playIndex(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const enqueue = (list: Entry[], playNow: boolean) => {
    if (list.length === 0) return;
    setEntries((prev) => {
      const next = [...prev, ...list];
      if (playNow) pendingPlay.current = next.length - list.length;
      else if (currentIndex < 0) pendingPlay.current = 0; // C# AddFiles: play head when idle
      return next;
    });
    if (!playNow) setResult(true, t('mediaplayer.playlistTitle'), t('mediaplayer.added', { n: list.length }));
  };

  // ── open sources ──
  const openFileRef = useRef<HTMLInputElement | null>(null);
  const addFilesRef = useRef<HTMLInputElement | null>(null);
  const subFileRef = useRef<HTMLInputElement | null>(null);

  const filesToEntries = (fl: FileList | null): Entry[] => {
    const out: Entry[] = [];
    if (!fl) return out;
    for (let i = 0; i < fl.length; i++) {
      const f = fl.item(i);
      if (f) out.push({ id: uid(), kind: 'file', name: f.name, path: '', file: f });
    }
    return out;
  };

  const openUrl = () => {
    const url = urlText.trim();
    if (!url) return;
    enqueue([{ id: uid(), kind: 'url', name: url, path: url }], true);
    setUrlText('');
  };

  const addPath = () => {
    const p = pathText.trim();
    if (!p) return;
    const name = p.split(/[\\/]/).pop() || p;
    enqueue([{ id: uid(), kind: 'path', name, path: p }], true);
    setPathText('');
  };

  // ── transport (C# PlayPause/Stop/Prev/Next/EndReached) ──
  const playPause = () => {
    const el = videoRef.current;
    if (!el) return;
    if (!src && entries.length > 0) {
      void playIndex(Math.max(0, currentIndex));
      return;
    }
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  };

  const stop = () => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      /* not seekable */
    }
    setCurSec(0);
  };

  const pickNext = (dir: 1 | -1): number => {
    const n = entries.length;
    if (n === 0) return -1;
    if (shuffle && n > 1) {
      let r = currentIndex;
      while (r === currentIndex) r = Math.floor(Math.random() * n);
      return r;
    }
    if (dir === -1) return currentIndex <= 0 ? n - 1 : currentIndex - 1;
    return currentIndex >= n - 1 ? 0 : currentIndex + 1;
  };

  const prev = () => {
    if (entries.length === 0) return;
    void playIndex(pickNext(-1));
  };
  const next = () => {
    if (entries.length === 0) return;
    void playIndex(pickNext(1));
  };

  const onEnded = () => {
    const el = videoRef.current;
    if (repeat === 'one' && el) {
      try {
        el.currentTime = 0;
      } catch {
        /* ignore */
      }
      el.play().catch(() => undefined);
      return;
    }
    const last = currentIndex >= entries.length - 1;
    if (!last || repeat === 'all' || shuffle) {
      const i = pickNext(1);
      if (i >= 0) void playIndex(i);
      return;
    }
    stop(); // C#: reset progress at end of list
  };

  // ── seek ──
  const commitSeek = (v: number) => {
    const el = videoRef.current;
    if (el && durSec > 0) {
      try {
        el.currentTime = (v / 1000) * durSec;
      } catch {
        /* not seekable */
      }
    }
  };

  // ── volume / mute / speed ──
  const onVolume = (v: number) => {
    setVolume(v);
    if (muted && v > 0) setMuted(false); // C# parity: raising volume unmutes
  };

  // ── snapshot (C# TakeSnapshot) ──
  const snapshot = async () => {
    const el = videoRef.current;
    if (!el || !src || el.videoWidth === 0) {
      setResult(false, t('mediaplayer.snapshotFailed'), t('mediaplayer.nothingPlaying'));
      return;
    }
    const name = `WinForge-snapshot-${stamp()}.png`;
    // Disk entries + ffmpeg: grab the exact frame server-side into Pictures (real file on disk).
    if (desktop && cur?.kind === 'path' && engine?.ffmpeg) {
      try {
        const home = await getEnv('USERPROFILE');
        const out = `${home}\\Pictures\\${name}`;
        const r = await runCommand(engine.ffmpeg, [
          '-y', '-ss', String(Math.max(0, curSec)), '-i', cur.path, '-frames:v', '1', out,
        ]);
        if (r.success) {
          setResult(true, t('mediaplayer.snapshotSaved'), out);
          return;
        }
      } catch {
        /* fall through to canvas */
      }
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas context');
      ctx.drawImage(el, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          setResult(false, t('mediaplayer.snapshotFailed'), '');
          return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        setResult(true, t('mediaplayer.snapshotSaved'), name);
      }, 'image/png');
    } catch (e) {
      setResult(false, t('mediaplayer.snapshotFailed'), String(e instanceof Error ? e.message : e));
    }
  };

  // ── fullscreen (C# presenter toggle → element fullscreen) ──
  const fullscreen = () => {
    const host = surfaceRef.current;
    if (!host) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      host.requestFullscreen().catch(() => undefined);
    }
  };

  // ── subtitles ──
  const addSubTrack = (label: string, vtt: string, select: boolean) => {
    const id = uid();
    setSubTracks((prevT) => [...prevT, { id, label, vtt }]);
    if (select) setSubSel(id);
  };

  const loadSubFile = async (fl: FileList | null) => {
    const f = fl?.item(0);
    if (!f) return;
    try {
      const text = await f.text();
      const ext = extOf(f.name);
      let vtt: string | null = null;
      if (ext === 'vtt' || /^WEBVTT/m.test(text)) vtt = text;
      else if (ext === 'srt' || ext === 'sub') vtt = srtToVtt(text);
      else if (ext === 'ass' || ext === 'ssa') vtt = assToVtt(text);
      if (!vtt || !vtt.includes('-->')) {
        setResult(false, t('mediaplayer.subLoadFailed'), t('mediaplayer.subFormatBad'));
        return;
      }
      addSubTrack(f.name, vtt, true);
      setResult(true, t('mediaplayer.subLoaded'), f.name);
    } catch (e) {
      setResult(false, t('mediaplayer.subLoadFailed'), String(e instanceof Error ? e.message : e));
    }
  };

  /** Extract embedded subtitle stream #rel (among subtitle streams) with ffmpeg → WebVTT track. */
  const extractSub = async (rel: number, label: string) => {
    if (!desktop || !engine?.ffmpeg || cur?.kind !== 'path') return;
    setExtracting(rel);
    try {
      const temp = await getEnv('TEMP');
      const out = `${temp}\\WinForge-MediaPlayer\\sub-${Date.now()}-${rel}.vtt`;
      await runPowershell(
        `New-Item -ItemType Directory -Force -Path '${esc(`${temp}\\WinForge-MediaPlayer`)}' | Out-Null`,
      );
      const r = await runCommand(engine.ffmpeg, [
        '-y', '-i', cur.path, '-map', `0:s:${rel}`, '-f', 'webvtt', out,
      ]);
      if (!r.success) {
        setResult(false, t('mediaplayer.extractFailed'), r.stderr.split(/\r?\n/).slice(-3).join('\n'));
        return;
      }
      const read = await runPowershell(`Get-Content -LiteralPath '${esc(out)}' -Raw -Encoding UTF8`);
      const vtt = read.stdout;
      if (!vtt.includes('-->')) {
        setResult(false, t('mediaplayer.extractFailed'), '');
        return;
      }
      addSubTrack(label, vtt, true);
      setResult(true, t('mediaplayer.extractedSub'), label);
    } catch (e) {
      setResult(false, t('mediaplayer.extractFailed'), String(e instanceof Error ? e.message : e));
    } finally {
      setExtracting(null);
    }
  };

  // Build <track> URLs whenever tracks or the delay change (delay re-times every cue).
  const renderedTracks = useMemo(() => {
    for (const u of trackUrls.current) URL.revokeObjectURL(u);
    trackUrls.current = [];
    return subTracks.map((tr) => {
      const blob = new Blob([shiftVtt(tr.vtt, subDelay)], { type: 'text/vtt' });
      const u = URL.createObjectURL(blob);
      trackUrls.current.push(u);
      return { id: tr.id, label: tr.label, url: u };
    });
  }, [subTracks, subDelay]);

  // Apply showing/hidden modes after render (Off entry = everything hidden — C# id -1).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const list = el.textTracks;
    for (let i = 0; i < list.length; i++) {
      const tt = list[i];
      if (tt) tt.mode = renderedTracks[i]?.id === subSel ? 'showing' : 'hidden';
    }
  }, [renderedTracks, subSel, src]);

  // ── audio track switching (browser audioTracks API when available) ──
  const audioApi = (): { length: number; [i: number]: { enabled: boolean } } | undefined =>
    (videoRef.current as (HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }) | null)
      ?.audioTracks;

  const canSwitchAudio = !!audioApi() && (audioApi()?.length ?? 0) > 1;

  const onAudioSel = (i: number) => {
    setAudioSel(i);
    const tracks = audioApi();
    if (!tracks) return;
    for (let k = 0; k < tracks.length; k++) {
      const tr = tracks[k];
      if (tr) tr.enabled = k === i;
    }
  };

  // ── playlist ops (C# PlaySel/RemoveSel/Clear + reorder/shuffle/repeat/save) ──
  const removeSel = () => {
    if (selIdx < 0 || selIdx >= entries.length) return;
    const i = selIdx;
    setEntries((prevE) => prevE.filter((_, k) => k !== i));
    if (i === currentIndex) {
      stop();
      setSrc('');
      setCurrentIndex(-1);
    } else if (i < currentIndex) {
      setCurrentIndex((c) => c - 1);
    }
    setSelIdx(-1);
  };

  const clearList = () => {
    stop();
    setSrc('');
    setEntries([]);
    setCurrentIndex(-1);
    setSelIdx(-1);
  };

  const move = (delta: -1 | 1) => {
    if (selIdx < 0) return;
    const j = selIdx + delta;
    if (j < 0 || j >= entries.length) return;
    setEntries((prevE) => {
      const arr = [...prevE];
      const a = arr[selIdx];
      const b = arr[j];
      if (a === undefined || b === undefined) return prevE;
      arr[selIdx] = b;
      arr[j] = a;
      return arr;
    });
    if (currentIndex === selIdx) setCurrentIndex(j);
    else if (currentIndex === j) setCurrentIndex(selIdx);
    setSelIdx(j);
  };

  const saveList = () => {
    const name = listName.trim();
    if (!name) return;
    const savable: PersistEntry[] = entries
      .filter((e): e is Entry & { kind: 'path' | 'url' } => e.kind !== 'file')
      .map((e) => ({ kind: e.kind, name: e.name, path: e.path }));
    if (savable.length === 0) {
      setResult(false, t('mediaplayer.saveList'), t('mediaplayer.noSavable'));
      return;
    }
    setSavedLists((prevL) => ({ ...prevL, [name]: savable }));
    setSavedSel(name);
    setResult(true, t('mediaplayer.savedLists'), t('mediaplayer.savedOk', { name }));
  };

  const loadList = () => {
    const list = savedLists[savedSel];
    if (!list) return;
    stop();
    setSrc('');
    setCurrentIndex(-1);
    setSelIdx(-1);
    setEntries(list.map((e) => ({ id: uid(), kind: e.kind, name: e.name, path: e.path })));
    setResult(true, t('mediaplayer.savedLists'), t('mediaplayer.loadedOk', { name: savedSel }));
  };

  const deleteList = () => {
    if (!savedSel) return;
    if (!window.confirm(t('mediaplayer.confirmDeleteList', { name: savedSel }))) return;
    setSavedLists((prevL) => {
      const nextL = { ...prevL };
      delete nextL[savedSel];
      return nextL;
    });
    setSavedSel('');
  };

  // ── transcode (C# Convert_Click → ffmpeg with stderr progress) ──
  const localEntries = entries.filter((e) => e.kind === 'path');
  const tcSource: Entry | undefined = tcSrcId
    ? entries.find((e) => e.id === tcSrcId && e.kind === 'path')
    : cur?.kind === 'path'
      ? cur
      : localEntries[0];
  const preset = PRESETS.find((p) => p.key === tcPreset) ?? PRESETS[0];

  useEffect(() => {
    if (!tcSource || !preset) {
      setTcOut('');
      return;
    }
    const base = tcSource.path.replace(/\.[^.\\/]+$/, '');
    setTcOut(`${base}-converted${preset.ext}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcSource?.path, tcPreset]);

  const stopTcPoll = () => {
    if (tcPoll.current) {
      clearInterval(tcPoll.current);
      tcPoll.current = null;
    }
  };

  const finishTranscode = async (outPath: string) => {
    stopTcPoll();
    setTcPid(null);
    try {
      const check = await runPowershellJson<{ Ok: boolean }>(
        `[pscustomobject]@{ Ok = [bool](Test-Path -LiteralPath '${esc(outPath)}') }`,
      );
      if (check[0]?.Ok) {
        setTcPct(100);
        setResult(true, t('mediaplayer.converted'), outPath);
      } else {
        setResult(false, t('mediaplayer.convertFailed'), '');
      }
    } catch (e) {
      setResult(false, t('mediaplayer.convertFailed'), String(e instanceof Error ? e.message : e));
    }
  };

  const startTranscode = async () => {
    if (!desktop) return;
    if (!engine?.ffmpeg) {
      setResult(false, t('mediaplayer.convertFailed'), t('mediaplayer.needFfmpegT'));
      return;
    }
    if (!tcSource || tcSource.kind !== 'path') {
      // C# parity: URL / picked entries cannot be transcoded — need a real local file.
      setResult(false, t('mediaplayer.pickLocalFirst'), t('mediaplayer.pickLocalBody'));
      return;
    }
    const out = tcOut.trim();
    if (!out || !preset) return;

    setTcBusy(true);
    setTcTail('');
    setTcPct(null);
    try {
      // Gated overwrite: only pass -y after an explicit confirm.
      const exists = await runPowershellJson<{ Exists: boolean }>(
        `[pscustomobject]@{ Exists = [bool](Test-Path -LiteralPath '${esc(out)}') }`,
      );
      if (exists[0]?.Exists && !window.confirm(t('mediaplayer.overwriteQ', { path: out }))) {
        return;
      }
      // Duration for percent progress (probe fresh; fall back to indeterminate).
      tcDur.current = 0;
      if (engine.ffprobe) {
        try {
          const d = await runCommand(engine.ffprobe, [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tcSource.path,
          ]);
          tcDur.current = Number(d.stdout.trim()) || 0;
        } catch {
          /* indeterminate progress */
        }
      }
      const temp = await getEnv('TEMP');
      const log = `${temp}\\WinForge-MediaPlayer\\ff-${Date.now()}.log`;
      const argStr =
        '-y ' +
        preset.args
          .map((a) => (a === '{in}' ? `"${tcSource.path}"` : a === '{out}' ? `"${out}"` : a))
          .join(' ');
      const started = await runPowershellJson<{ pid: number; error: string }>(
        `try {
           $dir='${esc(`${temp}\\WinForge-MediaPlayer`)}'
           New-Item -ItemType Directory -Force -Path $dir | Out-Null
           $p = Start-Process -FilePath '${esc(engine.ffmpeg)}' -ArgumentList '${esc(argStr)}' -RedirectStandardError '${esc(log)}' -RedirectStandardOutput '${esc(`${log}.out`)}' -WindowStyle Hidden -PassThru
           [pscustomobject]@{ pid=$p.Id; error='' }
         } catch { [pscustomobject]@{ pid=0; error=$_.Exception.Message } }`,
      );
      const st = started[0];
      if (!st || st.pid <= 0) {
        setResult(false, t('mediaplayer.startFailed'), st?.error ?? '');
        return;
      }
      setTcPid(st.pid);
      tcOutRef.current = out;
      setResult(true, t('mediaplayer.converting'), t('mediaplayer.convertingBody'));
      stopTcPoll();
      tcPoll.current = setInterval(async () => {
        try {
          const polled = await runPowershellJson<{ Running: boolean; Tail: string }>(
            `$running=[bool](Get-Process -Id ${st.pid} -ErrorAction SilentlyContinue)
             $txt=''
             if (Test-Path -LiteralPath '${esc(log)}') {
               try {
                 $fs=[IO.File]::Open('${esc(log)}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
                 $len=$fs.Length; $take=[int][Math]::Min(4096,$len)
                 if ($take -gt 0) {
                   [void]$fs.Seek(-$take,[IO.SeekOrigin]::End)
                   $buf=New-Object byte[] $take
                   [void]$fs.Read($buf,0,$take)
                   $txt=[Text.Encoding]::UTF8.GetString($buf)
                 }
                 $fs.Close()
               } catch {}
             }
             [pscustomobject]@{ Running=$running; Tail=$txt }`,
          );
          const p0 = polled[0];
          if (!p0) return;
          const tail = p0.Tail || '';
          setTcTail(tail.split(/[\r\n]+/).filter(Boolean).slice(-4).join('\n'));
          // Progress from stderr: last time=HH:MM:SS.xx marker vs the source duration.
          const matches = tail.match(/time=(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/g);
          const last = matches && matches.length > 0 ? matches[matches.length - 1] : undefined;
          if (last && tcDur.current > 0) {
            const m = last.match(/time=(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/);
            if (m) {
              const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
              setTcPct(Math.min(99, Math.round((sec / tcDur.current) * 100)));
            }
          }
          if (!p0.Running) void finishTranscode(tcOutRef.current);
        } catch {
          /* poll again next tick */
        }
      }, 1000);
    } catch (e) {
      setResult(false, t('mediaplayer.convertFailed'), String(e instanceof Error ? e.message : e));
    } finally {
      setTcBusy(false);
    }
  };

  const cancelTranscode = async () => {
    if (tcPid === null) return;
    stopTcPoll();
    try {
      await runCommand('taskkill', ['/PID', String(tcPid), '/T', '/F']);
    } catch {
      /* already gone */
    }
    setTcPid(null);
    setTcPct(null);
    setResult(true, t('mediaplayer.transTitle'), t('mediaplayer.canceled'));
  };

  // ── library row actions ──
  const libToEntry = (f: MediaFile): Entry => ({ id: uid(), kind: 'path', name: f.Name, path: f.Path });

  // ── derived ui bits ──
  const sliderVal = seeking.current ? seekVal : durSec > 0 ? Math.min(1000, (curSec / durSec) * 1000) : 0;
  const shownCur = seeking.current && durSec > 0 ? (seekVal / 1000) * durSec : curSec;
  const hasList = entries.length > 0;
  const hasMedia = !!src;
  const hasSel = selIdx >= 0 && selIdx < entries.length;
  const kindBadge = (e: Entry) =>
    e.kind === 'url' ? t('mediaplayer.kindUrl') : e.kind === 'file' ? t('mediaplayer.kindFile') : t('mediaplayer.kindPath');

  const card: CSSProperties = {
    border: '1px solid rgba(127,127,127,.25)',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 12,
  };

  // ===================== render =====================
  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.blurb2')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mediaplayer.previewNote')}
        </p>
      )}

      {/* engine bar (C# EngineBar) */}
      <div className="mod-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusDot ok label={t('mediaplayer.engineHtml5')} />
        <StatusDot ok={!!engine?.ffmpeg} label={t('mediaplayer.engineFfmpeg')} />
        <StatusDot ok={!!engine?.ffprobe} label={t('mediaplayer.engineFfprobe')} />
        {engine?.version && <span className="count-note">{engine.version}</span>}
        <button className="mini" onClick={engineQ.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>
      {desktop && !engineQ.loading && !engine?.ffmpeg && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mediaplayer.engineHint')}
        </p>
      )}

      {/* result bar (C# ResultBar, closable) */}
      {msg && (
        <p className="mod-msg" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot ok={msg.ok} label={msg.title} />
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{msg.text}</span>
          <button className="mini" onClick={() => setMsg(null)} aria-label="close">
            ✕
          </button>
        </p>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ===== player column ===== */}
        <div style={{ flex: '2 1 460px', minWidth: 320 }}>
          {/* open file / URL / path */}
          <div style={card}>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <button className="mini primary" onClick={() => openFileRef.current?.click()}>
                📂 {t('mediaplayer.openFile')}
              </button>
              <button className="mini" onClick={() => addFilesRef.current?.click()}>
                + {t('mediaplayer.addToList')}
              </button>
              <input
                ref={openFileRef}
                type="file"
                accept={FILE_ACCEPT}
                style={{ display: 'none' }}
                onChange={(e) => {
                  enqueue(filesToEntries(e.target.files), true);
                  e.target.value = '';
                }}
              />
              <input
                ref={addFilesRef}
                type="file"
                accept={FILE_ACCEPT}
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  enqueue(filesToEntries(e.target.files), false);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <input
                className="mod-search"
                style={{ flex: '1 1 220px' }}
                placeholder={t('mediaplayer.urlPh')}
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && openUrl()}
              />
              <button className="mini" onClick={openUrl}>
                {t('mediaplayer.openUrl')}
              </button>
            </div>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginBottom: 0 }}>
              <input
                className="mod-search"
                style={{ flex: '1 1 220px' }}
                placeholder={t('mediaplayer.pathPh')}
                value={pathText}
                onChange={(e) => setPathText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPath()}
              />
              <button className="mini" onClick={addPath}>
                {t('mediaplayer.addPath')}
              </button>
            </div>
          </div>

          {/* video surface */}
          <div
            ref={surfaceRef}
            style={{
              position: 'relative',
              background: '#000',
              borderRadius: 8,
              overflow: 'hidden',
              minHeight: 240,
            }}
          >
            <video
              ref={videoRef}
              src={src || undefined}
              playsInline
              style={{ width: '100%', display: 'block', minHeight: 240, maxHeight: 420, background: '#000' }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={(e) => {
                const s = Math.floor(e.currentTarget.currentTime);
                if (!seeking.current) setCurSec(s);
              }}
              onDurationChange={(e) => {
                const d = e.currentTarget.duration;
                setDurSec(Number.isFinite(d) ? d : 0);
              }}
              onEnded={onEnded}
              onError={() => {
                if (src) setResult(false, t('mediaplayer.playbackError'), t('mediaplayer.playbackErrorBody'));
                setIsPlaying(false);
              }}
            >
              {renderedTracks.map((tr) => (
                <track key={tr.id} kind="subtitles" label={tr.label} src={tr.url} />
              ))}
            </video>
            {!hasMedia && !mediaLoading && (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', color: 'rgba(255,255,255,.5)', textAlign: 'center',
                  padding: 16, pointerEvents: 'none',
                }}
              >
                {t('mediaplayer.noMediaHint')}
              </div>
            )}
            {mediaLoading && (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', color: 'rgba(255,255,255,.7)',
                }}
              >
                {t('mediaplayer.loadingMedia')}
              </div>
            )}
          </div>

          {/* seek + time */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0' }}>
            <span className="count-note" style={{ fontFamily: 'monospace', margin: 0 }}>
              {fmtTime(shownCur)}
            </span>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(sliderVal)}
              style={{ flex: 1 }}
              onPointerDown={() => {
                seeking.current = true;
                setSeekVal(sliderVal);
              }}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSeekVal(v);
                if (!seeking.current) commitSeek(v); // keyboard arrows
              }}
              onPointerUp={(e) => {
                commitSeek(Number((e.target as HTMLInputElement).value));
                seeking.current = false;
              }}
            />
            <span className="count-note" style={{ fontFamily: 'monospace', margin: 0 }}>
              {fmtTime(durSec)}
            </span>
          </div>

          {/* transport bar */}
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="mini" disabled={!hasList} onClick={prev} title={t('mediaplayer.tipPrev')}>
              ⏮
            </button>
            <button className="mini primary" onClick={playPause} title={t('mediaplayer.tipPlayPause')}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button className="mini" disabled={!hasMedia} onClick={stop} title={t('mediaplayer.tipStop')}>
              ⏹
            </button>
            <button className="mini" disabled={!hasList} onClick={next} title={t('mediaplayer.tipNext')}>
              ⏭
            </button>
            <span style={{ width: 8 }} />
            <button className="mini" onClick={() => setMuted((m) => !m)} title={t('mediaplayer.tipMute')}>
              {muted || volume === 0 ? '🔇' : '🔊'}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              style={{ width: 110 }}
              title={t('mediaplayer.tipVolume')}
              onChange={(e) => onVolume(Number(e.target.value))}
            />
            <span style={{ width: 8 }} />
            <label className="count-note" style={{ margin: 0 }}>{t('mediaplayer.speedCap')}</label>
            <select className="mini" value={String(rate)} onChange={(e) => setRate(Number(e.target.value))}>
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1">1.0×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2.0×</option>
            </select>
            <span style={{ width: 8 }} />
            <button className="mini" disabled={!hasMedia} onClick={() => void snapshot()} title={t('mediaplayer.tipSnapshot')}>
              📷
            </button>
            <button className="mini" onClick={fullscreen} title={t('mediaplayer.tipFullscreen')}>
              ⛶
            </button>
          </div>
        </div>

        {/* ===== right column: tracks + playlist ===== */}
        <div style={{ flex: '1 1 300px', minWidth: 280 }}>
          {/* tracks card */}
          <div style={card}>
            <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('mediaplayer.tracksTitle')}</p>
            <p className="count-note" style={{ margin: '0 0 2px' }}>{t('mediaplayer.audioCap')}</p>
            <select
              className="mini"
              style={{ width: '100%' }}
              disabled={!canSwitchAudio && (probe?.audio.length ?? 0) === 0}
              value={String(audioSel)}
              onChange={(e) => onAudioSel(Number(e.target.value))}
            >
              {(probe?.audio.length ? probe.audio : [{ index: 0 } as ProbeStream]).map((s, i) => (
                <option key={`a${s.index}`} value={String(i)}>
                  {probe?.audio.length ? streamLabel(s, i) : '—'}
                </option>
              ))}
            </select>
            {(probe?.audio.length ?? 0) > 1 && !canSwitchAudio && (
              <p className="count-note" style={{ margin: '4px 0 0' }}>{t('mediaplayer.audioNote')}</p>
            )}

            <p className="count-note" style={{ margin: '10px 0 2px' }}>{t('mediaplayer.subCap')}</p>
            <select
              className="mini"
              style={{ width: '100%' }}
              value={subSel}
              onChange={(e) => setSubSel(e.target.value)}
            >
              <option value="">{t('mediaplayer.subOff')}</option>
              {subTracks.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.label}
                </option>
              ))}
            </select>
            <button
              className="mini"
              style={{ width: '100%', marginTop: 6 }}
              onClick={() => subFileRef.current?.click()}
            >
              {t('mediaplayer.loadSub')}
            </button>
            <input
              ref={subFileRef}
              type="file"
              accept=".srt,.ass,.ssa,.sub,.vtt"
              style={{ display: 'none' }}
              onChange={(e) => {
                void loadSubFile(e.target.files);
                e.target.value = '';
              }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <label className="count-note" style={{ margin: 0 }}>{t('mediaplayer.subDelayCap')}</label>
              <input
                className="mod-search"
                type="number"
                step={0.1}
                style={{ maxWidth: 100 }}
                value={subDelay}
                disabled={subTracks.length === 0}
                onChange={(e) => setSubDelay(Number(e.target.value) || 0)}
              />
            </div>

            {desktop && cur?.kind === 'path' && (probe?.subs.length ?? 0) > 0 && (
              <>
                <p className="count-note" style={{ margin: '10px 0 2px' }}>{t('mediaplayer.embSubs')}</p>
                {(probe?.subs ?? []).map((s, i) => (
                  <div key={`s${s.index}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <span className="count-note" style={{ margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {streamLabel(s, i)}
                    </span>
                    <button
                      className="mini"
                      disabled={!engine?.ffmpeg || extracting !== null}
                      onClick={() => void extractSub(i, streamLabel(s, i))}
                    >
                      {extracting === i ? '…' : t('mediaplayer.extract')}
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* playlist card */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <p style={{ fontWeight: 600, margin: 0, flex: 1 }}>
                {t('mediaplayer.playlistTitle')}{' '}
                <span className="count-note" style={{ margin: 0 }}>
                  {t('mediaplayer.entryCount', { n: entries.length })}
                </span>
              </p>
              <button className="mini" disabled={!hasList} onClick={clearList} title={t('mediaplayer.clearList')}>
                🗑
              </button>
            </div>

            {entries.length === 0 ? (
              <p className="count-note" style={{ margin: 0 }}>{t('mediaplayer.emptyList')}</p>
            ) : (
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                {entries.map((e, i) => (
                  <div
                    key={e.id}
                    onClick={() => setSelIdx(i)}
                    onDoubleClick={() => void playIndex(i)}
                    style={{
                      display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px',
                      borderRadius: 4, cursor: 'pointer',
                      background:
                        i === selIdx ? 'rgba(76,139,245,.18)' : i === currentIndex ? 'rgba(127,127,127,.12)' : 'transparent',
                    }}
                    title={e.path || e.name}
                  >
                    <span style={{ width: 16, textAlign: 'center' }}>{i === currentIndex ? (isPlaying ? '▶' : '❚❚') : ''}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.name}
                    </span>
                    <span className="count-note" style={{ margin: 0 }}>{kindBadge(e)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8, marginBottom: 0 }}>
              <button className="mini primary" disabled={!hasSel} onClick={() => hasSel && void playIndex(selIdx)}>
                {t('mediaplayer.play')}
              </button>
              <button className="mini" disabled={!hasSel} onClick={removeSel}>
                {t('mediaplayer.remove')}
              </button>
              <button className="mini" disabled={!hasSel} onClick={() => move(-1)} title={t('mediaplayer.moveUp')}>
                ▲
              </button>
              <button className="mini" disabled={!hasSel} onClick={() => move(1)} title={t('mediaplayer.moveDown')}>
                ▼
              </button>
              <button
                className={`mini${shuffle ? ' primary' : ''}`}
                onClick={() => setShuffle((s) => !s)}
                title={t('mediaplayer.shuffleCap')}
              >
                🔀
              </button>
              <select
                className="mini"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as 'off' | 'all' | 'one')}
              >
                <option value="off">{t('mediaplayer.repeatOff')}</option>
                <option value="all">{t('mediaplayer.repeatAll')}</option>
                <option value="one">{t('mediaplayer.repeatOne')}</option>
              </select>
            </div>

            {/* saved playlists (localStorage) */}
            <p className="count-note" style={{ margin: '10px 0 4px' }}>{t('mediaplayer.savedLists')}</p>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginBottom: 0 }}>
              <input
                className="mod-search"
                style={{ flex: '1 1 120px' }}
                placeholder={t('mediaplayer.listNamePh')}
                value={listName}
                onChange={(e) => setListName(e.target.value)}
              />
              <button className="mini" disabled={!listName.trim() || !hasList} onClick={saveList}>
                {t('mediaplayer.saveList')}
              </button>
            </div>
            {Object.keys(savedLists).length === 0 ? (
              <p className="count-note" style={{ margin: '6px 0 0' }}>{t('mediaplayer.noSaved')}</p>
            ) : (
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6, marginBottom: 0 }}>
                <select className="mini" value={savedSel} onChange={(e) => setSavedSel(e.target.value)}>
                  <option value="">—</option>
                  {Object.keys(savedLists)
                    .sort()
                    .map((n) => (
                      <option key={n} value={n}>
                        {n} ({savedLists[n]?.length ?? 0})
                      </option>
                    ))}
                </select>
                <button className="mini" disabled={!savedSel} onClick={loadList}>
                  {t('mediaplayer.loadList')}
                </button>
                <button className="mini" disabled={!savedSel} onClick={deleteList}>
                  {t('mediaplayer.deleteList')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== lower tabs: library / transcode / devices / codecs ===== */}
      <ModuleTabs
        tabs={[
          {
            id: 'library',
            en: 'Library',
            zh: '媒體庫',
            render: () => (
              <LibraryTab
                onPlay={(f) => enqueue([libToEntry(f)], true)}
                onQueue={(f) => enqueue([libToEntry(f)], false)}
              />
            ),
          },
          {
            id: 'transcode',
            en: 'Transcode',
            zh: '轉檔',
            render: () => (
              <div className="mod">
                <h3 style={{ margin: '4px 0' }}>{t('mediaplayer.transTitle')}</h3>
                <p className="count-note" style={{ marginTop: 0 }}>
                  {t('mediaplayer.transBlurb')}
                </p>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <label className="count-note" style={{ margin: 0 }}>{t('mediaplayer.sourceCap')}</label>
                  <select
                    className="mini"
                    style={{ maxWidth: 320 }}
                    value={tcSource?.id ?? ''}
                    onChange={(e) => setTcSrcId(e.target.value)}
                  >
                    {localEntries.length === 0 && <option value="">—</option>}
                    {localEntries.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  <label className="count-note" style={{ margin: 0 }}>{t('mediaplayer.presetCap')}</label>
                  <select className="mini" value={tcPreset} onChange={(e) => setTcPreset(e.target.value)}>
                    {PRESETS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {zh ? p.zh : p.en}
                      </option>
                    ))}
                  </select>
                </div>
                {localEntries.length === 0 && (
                  <p className="count-note" style={{ marginTop: 0 }}>{t('mediaplayer.sourceNone')}</p>
                )}

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <label className="count-note" style={{ margin: 0 }}>{t('mediaplayer.outputCap')}</label>
                  <input
                    className="mod-search"
                    style={{ flex: '1 1 320px' }}
                    value={tcOut}
                    onChange={(e) => setTcOut(e.target.value)}
                  />
                  {tcPid === null ? (
                    <button
                      className="mini primary"
                      disabled={!desktop || tcBusy || !engine?.ffmpeg || !tcSource || !tcOut.trim()}
                      onClick={() => void startTranscode()}
                    >
                      {tcBusy ? t('mediaplayer.converting') : t('mediaplayer.convert')}
                    </button>
                  ) : (
                    <button className="mini" onClick={() => void cancelTranscode()}>
                      {t('mediaplayer.cancel')}
                    </button>
                  )}
                </div>
                {desktop && !engine?.ffmpeg && (
                  <p className="count-note" style={{ marginTop: 0 }}>{t('mediaplayer.needFfmpegT')}</p>
                )}

                {(tcPid !== null || tcPct !== null) && (
                  <div style={{ margin: '8px 0' }}>
                    <div
                      style={{
                        height: 8, borderRadius: 4, background: 'rgba(127,127,127,.25)', overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${tcPct ?? (tcPid !== null ? 8 : 0)}%`,
                          minWidth: tcPid !== null ? 24 : 0,
                          background: 'var(--accent, #4c8bf5)',
                          transition: 'width .5s',
                        }}
                      />
                    </div>
                    <p className="count-note" style={{ margin: '4px 0 0', fontFamily: 'monospace' }}>
                      {tcPct !== null ? `${tcPct}%` : t('mediaplayer.converting')}
                    </p>
                  </div>
                )}
                {tcTail && (
                  <>
                    <p className="count-note" style={{ margin: '6px 0 2px' }}>{t('mediaplayer.logTail')}</p>
                    <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{tcTail}</pre>
                  </>
                )}

                <h3 style={{ margin: '16px 0 4px' }}>{t('mediaplayer.presetTitle')}</h3>
                <p className="count-note" style={{ marginTop: 0 }}>
                  {t('mediaplayer.presetBlurb')}
                </p>
                <DataTable
                  columns={[
                    { key: 'name', header: t('mediaplayer.colPreset'), render: (p: Preset) => (zh ? p.zh : p.en) },
                    { key: 'ext', header: t('mediaplayer.colContainer'), width: 90 },
                    { key: 'video', header: t('mediaplayer.colVideoCodec'), width: 110 },
                    { key: 'audio', header: t('mediaplayer.colAudioCodec'), width: 110 },
                    {
                      key: 'args',
                      header: t('mediaplayer.colArgs'),
                      render: (p: Preset) => (
                        <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                          {p.args.filter((a) => a !== '{in}' && a !== '{out}').join(' ')}
                        </code>
                      ),
                    },
                  ]}
                  rows={PRESETS}
                  rowKey={(p) => p.key}
                />
              </div>
            ),
          },
          { id: 'devices', en: 'Audio devices', zh: '音訊裝置', render: () => <AudioDevicesTab /> },
          { id: 'codecs', en: 'Codecs', zh: '編解碼', render: () => <CodecsTab /> },
        ]}
      />
    </div>
  );
}
