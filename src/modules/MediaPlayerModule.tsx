import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Ported from WinForge Pages/MediaPlayerModule.xaml(.cs) + Services/MediaPlayerService.cs.
// The desktop module embeds the libVLC engine to play files/URLs. In the native web build we
// cannot embed VLC, so this surfaces the same domain LIVE from the system: the media library
// (real files under Videos/Music with duration + size), the audio playback/capture devices the
// player would render to, and the transcode presets + installed media codecs. Read-only.

// ===================== Library · 媒體庫 =====================

interface MediaFile {
  Name: string;
  Folder: string;
  Kind: string;
  Ext: string;
  SizeMB: number;
  Modified: string;
  Path: string;
}

// Same extension buckets as the C# MediaFilters().
const VIDEO_EXT = 'mp4,mkv,avi,mov,webm,flv,wmv,m4v,mpg,mpeg,ts,m2ts';
const AUDIO_EXT = 'mp3,flac,wav,aac,ogg,opus,m4a,wma';

function LibraryTab() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | 'Video' | 'Audio'>('all');

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<MediaFile>(
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
      ),
    [],
  );

  const rows = useMemo(() => {
    let all = data ?? [];
    if (kind !== 'all') all = all.filter((m) => m.Kind === kind);
    const q = filter.trim().toLowerCase();
    if (q) all = all.filter((m) => `${m.Name} ${m.Folder} ${m.Ext}`.toLowerCase().includes(q));
    return [...all].sort((a, b) => (b.Modified || '').localeCompare(a.Modified || ''));
  }, [data, filter, kind]);

  const totalMB = useMemo(() => rows.reduce((s, r) => s + (r.SizeMB || 0), 0), [rows]);

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
        <DataTable columns={columns} rows={rows} rowKey={(m) => m.Path} empty={t('mediaplayer.libEmpty')} />
      </AsyncState>
    </div>
  );
}

// ===================== Audio devices · 音訊裝置 =====================

interface AudioDev {
  Status: string;
  FriendlyName: string;
  Class: string;
  InstanceId: string;
}

function AudioDevicesTab() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<AudioDev>(
        // The playback/capture endpoints the player renders to — audio + video device classes.
        `Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.Class -in @('AudioEndpoint','Media','MEDIA','Camera','Image') } |
           Select-Object @{N='Status';E={$_.Status.ToString()}},FriendlyName,@{N='Class';E={$_.Class.ToString()}},InstanceId`,
      ),
    [],
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
        <DataTable columns={columns} rows={rows} rowKey={(d) => d.InstanceId} empty={t('mediaplayer.devEmpty')} />
      </AsyncState>
    </div>
  );
}

// ===================== Codecs & presets · 編解碼／預設 =====================

// The transcode presets shipped by the C# MediaPlayerService.Presets (libVLC sout chains).
interface Preset {
  key: string;
  en: string;
  zh: string;
  ext: string;
  video: string;
  audio: string;
}

const PRESETS: Preset[] = [
  { key: 'mp4', en: 'MP4 · H.264 + AAC', zh: 'MP4 · H.264 + AAC', ext: '.mp4', video: 'H.264', audio: 'AAC' },
  { key: 'mp3', en: 'MP3 (audio only)', zh: 'MP3（淨音訊）', ext: '.mp3', video: '—', audio: 'MP3' },
  { key: 'webm', en: 'WebM · VP8 + Vorbis', zh: 'WebM · VP8 + Vorbis', ext: '.webm', video: 'VP8', audio: 'Vorbis' },
  { key: 'wav', en: 'WAV (audio only)', zh: 'WAV（無損音訊）', ext: '.wav', video: '—', audio: 'PCM s16l' },
  { key: 'ogg', en: 'OGG/Theora', zh: 'OGG/Theora · 開放格式', ext: '.ogg', video: 'Theora', audio: 'Vorbis' },
];

interface Codec {
  Name: string;
  Category: string;
}

function CodecsTab() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');

  // Live: installed DirectShow filters (audio/video codecs) from the registry — read-only.
  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Codec>(
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
      ),
    [],
  );

  const codecs = data ?? [];

  const presetCols: Column<Preset>[] = [
    { key: 'name', header: t('mediaplayer.colPreset'), render: (p) => (zh ? p.zh : p.en) },
    { key: 'ext', header: t('mediaplayer.colContainer'), width: 100 },
    { key: 'video', header: t('mediaplayer.colVideoCodec'), width: 120 },
    { key: 'audio', header: t('mediaplayer.colAudioCodec'), width: 120 },
  ];

  const codecCols: Column<Codec>[] = [
    { key: 'Category', header: t('mediaplayer.colCategory'), width: 180 },
    { key: 'Name', header: t('mediaplayer.colCodec') },
  ];

  return (
    <div className="mod">
      <h3 style={{ margin: '4px 0' }}>{t('mediaplayer.presetTitle')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.presetBlurb')}
      </p>
      <DataTable columns={presetCols} rows={PRESETS} rowKey={(p) => p.key} />

      <h3 style={{ margin: '18px 0 4px' }}>{t('mediaplayer.codecTitle')}</h3>
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
        <DataTable columns={codecCols} rows={codecs} rowKey={(c, i) => `${c.Category}-${c.Name}-${i}`} empty={t('mediaplayer.codecEmpty')} />
      </AsyncState>
    </div>
  );
}

// ===================== module ·  =====================

export function MediaPlayerModule() {
  const { t } = useTranslation();
  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mediaplayer.blurb')}
      </p>
      <ModuleTabs
        tabs={[
          { id: 'library', en: 'Library', zh: '媒體庫', render: () => <LibraryTab /> },
          { id: 'devices', en: 'Audio devices', zh: '音訊裝置', render: () => <AudioDevicesTab /> },
          { id: 'codecs', en: 'Codecs & presets', zh: '編解碼／預設', render: () => <CodecsTab /> },
        ]}
      />
    </div>
  );
}
