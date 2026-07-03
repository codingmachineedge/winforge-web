import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand } from '../tauri/bridge';
import { resolveTool } from '../tauri/deps';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Effect catalog ─────────────────────────────────────────────────────────
// Ported 1:1 from WinForge Catalog/AudioEffectsOperations.cs — the same ~46
// ffmpeg-backed effects the desktop editor exposes, with their real filter
// chains. Kept as a live reference of exactly what each effect runs.
type FxCat = 'amplitude' | 'fade' | 'pitch' | 'eq' | 'effect' | 'channel';

interface Fx {
  id: string;
  en: string;
  zh: string;
  descEn: string;
  descZh: string;
  cat: FxCat;
  /** The exact ffmpeg -af filter (or full args, when `raw`). */
  filter: string;
  raw?: boolean;
}

const FX: Fx[] = [
  // amplitude
  { id: 'gain-up-6', en: 'Amplify +6 dB', zh: '放大 +6 dB', descEn: 'Boost the whole clip by 6 decibels.', descZh: '將成段加大 6 分貝。', cat: 'amplitude', filter: 'volume=6dB' },
  { id: 'gain-up-3', en: 'Amplify +3 dB', zh: '放大 +3 dB', descEn: 'Boost the whole clip by 3 decibels.', descZh: '將成段加大 3 分貝。', cat: 'amplitude', filter: 'volume=3dB' },
  { id: 'gain-down-3', en: 'Attenuate -3 dB', zh: '減弱 -3 dB', descEn: 'Reduce the whole clip by 3 decibels.', descZh: '將成段減細 3 分貝。', cat: 'amplitude', filter: 'volume=-3dB' },
  { id: 'gain-down-6', en: 'Attenuate -6 dB', zh: '減弱 -6 dB', descEn: 'Reduce the whole clip by 6 decibels.', descZh: '將成段減細 6 分貝。', cat: 'amplitude', filter: 'volume=-6dB' },
  { id: 'normalize', en: 'Normalize loudness (EBU R128)', zh: '正規化響度 (EBU R128)', descEn: 'Even out perceived loudness to a broadcast target with loudnorm.', descZh: '用 loudnorm 將響度拉到廣播標準。', cat: 'amplitude', filter: 'loudnorm=I=-16:TP=-1.5:LRA=11' },
  { id: 'peak-normalize', en: 'Peak normalize', zh: '峰值正規化', descEn: 'Bring the loudest peak up to just below 0 dBFS.', descZh: '將最大峰值推到接近 0 dBFS。', cat: 'amplitude', filter: 'dynaudnorm=p=0.95' },
  { id: 'compress', en: 'Compressor', zh: '壓縮器', descEn: 'Tighten dynamic range so quiet and loud parts sit closer together.', descZh: '壓窄動態範圍，大細聲更平均。', cat: 'amplitude', filter: 'acompressor=threshold=-18dB:ratio=4:attack=20:release=250' },
  { id: 'limiter', en: 'Limiter', zh: '限幅器', descEn: 'Hard-limit peaks to prevent clipping.', descZh: '硬性限制峰值，防止削波。', cat: 'amplitude', filter: 'alimiter=limit=0.95' },
  // fades & silence
  { id: 'fade-in-1', en: 'Fade in (1 s)', zh: '淡入 (1 秒)', descEn: 'Add a one-second fade-in at the start.', descZh: '喺開頭加一秒淡入。', cat: 'fade', filter: 'afade=t=in:st=0:d=1' },
  { id: 'fade-in-3', en: 'Fade in (3 s)', zh: '淡入 (3 秒)', descEn: 'Add a three-second fade-in at the start.', descZh: '喺開頭加三秒淡入。', cat: 'fade', filter: 'afade=t=in:st=0:d=3' },
  { id: 'fade-out-1', en: 'Fade out (1 s)', zh: '淡出 (1 秒)', descEn: 'Add a one-second fade-out at the very end.', descZh: '喺結尾加一秒淡出。', cat: 'fade', filter: '-i {in} -af "areverse,afade=t=in:st=0:d=1,areverse" -c:a pcm_s16le {out}', raw: true },
  { id: 'fade-out-3', en: 'Fade out (3 s)', zh: '淡出 (3 秒)', descEn: 'Add a three-second fade-out at the very end.', descZh: '喺結尾加三秒淡出。', cat: 'fade', filter: '-i {in} -af "areverse,afade=t=in:st=0:d=3,areverse" -c:a pcm_s16le {out}', raw: true },
  { id: 'trim-silence', en: 'Trim leading/trailing silence', zh: '剪走頭尾靜音', descEn: 'Remove silence at the start and end of the clip.', descZh: '去走開頭同結尾嘅靜音。', cat: 'fade', filter: 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,areverse' },
  { id: 'pad-silence', en: 'Add 1 s silence at start', zh: '開頭加 1 秒靜音', descEn: 'Prepend one second of silence.', descZh: '喺開頭加一秒靜音。', cat: 'fade', filter: 'adelay=1000|1000' },
  // pitch & speed
  { id: 'speed-1_5', en: 'Speed up 1.5×', zh: '加速 1.5 倍', descEn: 'Play 1.5× faster without changing pitch.', descZh: '用唔變音高嘅方式快 1.5 倍。', cat: 'pitch', filter: 'atempo=1.5' },
  { id: 'speed-2', en: 'Speed up 2×', zh: '加速 2 倍', descEn: 'Play twice as fast without changing pitch.', descZh: '用唔變音高嘅方式快一倍。', cat: 'pitch', filter: 'atempo=2.0' },
  { id: 'speed-0_75', en: 'Slow down 0.75×', zh: '減慢 0.75 倍', descEn: 'Play slower without changing pitch.', descZh: '用唔變音高嘅方式慢落嚟。', cat: 'pitch', filter: 'atempo=0.75' },
  { id: 'speed-0_5', en: 'Slow down 0.5×', zh: '減慢 0.5 倍', descEn: 'Play at half speed without changing pitch.', descZh: '用唔變音高嘅方式慢一半。', cat: 'pitch', filter: 'atempo=0.5' },
  { id: 'pitch-up', en: 'Pitch up +2 semitones', zh: '升音 +2 半音', descEn: 'Raise the pitch by two semitones, keeping duration.', descZh: '升高兩個半音，時長不變。', cat: 'pitch', filter: 'asetrate=44100*1.122462,aresample=44100,atempo=0.891' },
  { id: 'pitch-down', en: 'Pitch down -2 semitones', zh: '降音 -2 半音', descEn: 'Lower the pitch by two semitones, keeping duration.', descZh: '降低兩個半音，時長不變。', cat: 'pitch', filter: 'asetrate=44100*0.890899,aresample=44100,atempo=1.122' },
  { id: 'chipmunk', en: 'Chipmunk (pitch up octave)', zh: '花栗鼠 (升八度)', descEn: 'Raise pitch by a full octave for a chipmunk voice.', descZh: '升高一個八度，變花栗鼠聲。', cat: 'pitch', filter: 'asetrate=44100*2,aresample=44100' },
  { id: 'deep', en: 'Deep voice (pitch down octave)', zh: '低沉 (降八度)', descEn: 'Lower pitch by a full octave for a deep voice.', descZh: '降低一個八度，變低沉聲。', cat: 'pitch', filter: 'asetrate=44100*0.5,aresample=44100' },
  // EQ & tone
  { id: 'bass-boost', en: 'Bass boost', zh: '加重低音', descEn: 'Lift the low frequencies.', descZh: '提升低頻。', cat: 'eq', filter: 'bass=g=8' },
  { id: 'bass-cut', en: 'Bass cut', zh: '減低音', descEn: 'Reduce the low frequencies.', descZh: '減少低頻。', cat: 'eq', filter: 'bass=g=-8' },
  { id: 'treble-boost', en: 'Treble boost', zh: '加重高音', descEn: 'Lift the high frequencies for more sparkle.', descZh: '提升高頻，更通透。', cat: 'eq', filter: 'treble=g=8' },
  { id: 'treble-cut', en: 'Treble cut', zh: '減高音', descEn: 'Reduce the high frequencies.', descZh: '減少高頻。', cat: 'eq', filter: 'treble=g=-8' },
  { id: 'highpass', en: 'High-pass 100 Hz (remove rumble)', zh: '高通 100 Hz (除隆隆聲)', descEn: 'Cut very low frequencies to remove rumble/hum.', descZh: '切走超低頻，去走隆隆聲。', cat: 'eq', filter: 'highpass=f=100' },
  { id: 'lowpass', en: 'Low-pass 12 kHz (soften hiss)', zh: '低通 12 kHz (柔化嘶聲)', descEn: 'Cut very high frequencies to soften hiss.', descZh: '切走超高頻，柔化嘶聲。', cat: 'eq', filter: 'lowpass=f=12000' },
  { id: 'telephone', en: 'Telephone EQ', zh: '電話聲 EQ', descEn: 'Band-limit to a tinny telephone sound.', descZh: '限頻做電話般嘅薄聲。', cat: 'eq', filter: 'highpass=f=300,lowpass=f=3400' },
  { id: 'loudness-contour', en: 'Loudness contour', zh: '響度等化曲線', descEn: 'Gently lift bass and treble for a fuller sound at low volume.', descZh: '輕微提升低高頻，細聲都飽滿。', cat: 'eq', filter: 'bass=g=4,treble=g=3' },
  // effects
  { id: 'echo', en: 'Echo', zh: '回音', descEn: 'Add a repeating echo tail.', descZh: '加重複嘅回音尾。', cat: 'effect', filter: 'aecho=0.8:0.88:60:0.4' },
  { id: 'reverb', en: 'Reverb (room)', zh: '混響 (房間)', descEn: 'Add a small-room reverb.', descZh: '加細房間嘅混響。', cat: 'effect', filter: 'aecho=0.8:0.9:40|55|70:0.4|0.3|0.2' },
  { id: 'reverb-hall', en: 'Reverb (hall)', zh: '混響 (大廳)', descEn: 'Add a big-hall reverb.', descZh: '加大廳般嘅混響。', cat: 'effect', filter: 'aecho=0.8:0.9:500|700|900:0.5|0.4|0.3' },
  { id: 'denoise', en: 'Noise reduction (FFT)', zh: '降噪 (FFT)', descEn: 'Reduce broadband background noise/hiss.', descZh: '減少背景雜訊／嘶聲。', cat: 'effect', filter: 'afftdn=nr=12:nf=-25' },
  { id: 'denoise-strong', en: 'Noise reduction (strong)', zh: '降噪 (強)', descEn: 'Aggressively reduce background noise.', descZh: '大力減少背景雜訊。', cat: 'effect', filter: 'afftdn=nr=24:nf=-30' },
  { id: 'reverse', en: 'Reverse', zh: '倒轉播放', descEn: 'Play the clip backwards.', descZh: '將段聲倒返轉播。', cat: 'effect', filter: 'areverse' },
  { id: 'tremolo', en: 'Tremolo', zh: '顫音', descEn: 'Add a wobbling amplitude tremolo.', descZh: '加抖動嘅振幅顫音。', cat: 'effect', filter: 'tremolo=f=5:d=0.7' },
  { id: 'vibrato', en: 'Vibrato', zh: '抖音', descEn: 'Add a pitch vibrato.', descZh: '加音高抖動嘅抖音。', cat: 'effect', filter: 'vibrato=f=6:d=0.5' },
  { id: 'stereo-widen', en: 'Stereo widen', zh: '立體聲加寬', descEn: 'Widen the stereo image.', descZh: '加闊立體聲場。', cat: 'effect', filter: 'extrastereo=m=2.5' },
  // channel / format
  { id: 'to-mono', en: 'Convert to mono', zh: '轉單聲道', descEn: 'Downmix to a single mono channel.', descZh: '混落單一單聲道。', cat: 'channel', filter: '-i {in} -ac 1 -c:a pcm_s16le {out}', raw: true },
  { id: 'to-stereo', en: 'Convert to stereo', zh: '轉立體聲', descEn: 'Upmix mono to two stereo channels.', descZh: '由單聲道升做兩聲道立體聲。', cat: 'channel', filter: '-i {in} -ac 2 -c:a pcm_s16le {out}', raw: true },
  { id: 'swap-channels', en: 'Swap L/R channels', zh: '左右聲道對調', descEn: 'Swap the left and right stereo channels.', descZh: '對調左右聲道。', cat: 'channel', filter: 'pan=stereo|c0=c1|c1=c0' },
  { id: 'resample-48k', en: 'Resample to 48 kHz', zh: '重新取樣到 48 kHz', descEn: 'Change the sample rate to 48000 Hz.', descZh: '將取樣率改做 48000 Hz。', cat: 'channel', filter: '-i {in} -ar 48000 -c:a pcm_s16le {out}', raw: true },
  { id: 'resample-44k', en: 'Resample to 44.1 kHz', zh: '重新取樣到 44.1 kHz', descEn: 'Change the sample rate to 44100 Hz.', descZh: '將取樣率改做 44100 Hz。', cat: 'channel', filter: '-i {in} -ar 44100 -c:a pcm_s16le {out}', raw: true },
];

interface Engine {
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string;
}

interface Device {
  name: string;
  alt: string;
}

// Parse ffmpeg's dshow enumeration off stderr, exactly like
// AudioEngineService.ListInputDevicesAsync in WinForge.
function parseDshowAudio(stderr: string): Device[] {
  const out: Device[] = [];
  let inAudio = false;
  let pending: string | null = null;
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    const m = line.match(/"([^"]+)"/);
    if (!m || m[1] === undefined) continue;
    const name = m[1];
    if (name.startsWith('@')) {
      // Alternative-name line for the previously listed device.
      if (pending) {
        const prev = out.find((d) => d.name === pending);
        if (prev) prev.alt = name;
        pending = null;
      }
      continue;
    }
    const isAudio = inAudio || /\(audio\)/i.test(line);
    if (isAudio && !out.some((d) => d.name === name)) {
      out.push({ name, alt: '' });
      pending = name;
    }
  }
  return out;
}

const CAT_ORDER: FxCat[] = ['amplitude', 'fade', 'pitch', 'eq', 'effect', 'channel'];

export function AudioEditorModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const live = isTauri();
  const [filter, setFilter] = useState('');
  const [cat, setCat] = useState<FxCat | 'all'>('all');

  // ── ffmpeg engine probe ──────────────────────────────────────────────────
  const engineQ = useAsync<Engine>(async () => {
    if (!live) return { ffmpeg: null, ffprobe: null, version: '' };
    const [ff, fp] = await Promise.all([resolveTool('ffmpeg'), resolveTool('ffprobe')]);
    let version = '';
    if (ff.path) {
      try {
        const r = await runCommand(ff.path, ['-hide_banner', '-version']);
        version = r.stdout.split(/\r?\n/)[0]?.trim() ?? '';
      } catch {
        /* leave blank */
      }
    }
    return { ffmpeg: ff.path, ffprobe: fp.path, version };
  }, [live]);

  const engine = engineQ.data;
  const hasFfmpeg = !!engine?.ffmpeg;

  // ── microphone input devices (dshow) ─────────────────────────────────────
  const devQ = useAsync<Device[]>(async () => {
    if (!live || !engine?.ffmpeg) return [];
    // ffmpeg writes the device list to stderr and exits non-zero — expected.
    const r = await runCommand(engine.ffmpeg, [
      '-hide_banner',
      '-list_devices',
      'true',
      '-f',
      'dshow',
      '-i',
      'dummy',
    ]);
    return parseDshowAudio(`${r.stderr}\n${r.stdout}`);
  }, [live, engine?.ffmpeg]);

  const devices = devQ.data ?? [];

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return FX.filter((f) => {
      if (cat !== 'all' && f.cat !== cat) return false;
      if (!q) return true;
      return `${f.en} ${f.zh} ${f.descEn} ${f.descZh} ${f.filter} ${f.cat}`
        .toLowerCase()
        .includes(q);
    }).sort((a, b) => {
      const c = CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat);
      return c !== 0 ? c : a.en.localeCompare(b.en);
    });
  }, [filter, cat]);

  const columns: Column<Fx>[] = [
    {
      key: 'name',
      header: t('audioeditor.colEffect'),
      render: (f) => (
        <span>
          <strong>{zh ? f.zh : f.en}</strong>
          <br />
          <span className="count-note" style={{ margin: 0 }}>
            {zh ? f.en : f.zh}
          </span>
        </span>
      ),
    },
    {
      key: 'desc',
      header: t('audioeditor.colDesc'),
      render: (f) => <span>{zh ? f.descZh : f.descEn}</span>,
    },
    {
      key: 'cat',
      header: t('audioeditor.colCategory'),
      width: 130,
      render: (f) => t(`audioeditor.cat.${f.cat}`),
    },
    {
      key: 'filter',
      header: t('audioeditor.colFilter'),
      render: (f) => (
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {f.raw ? f.filter : `-af "${f.filter}"`}
        </code>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('audioeditor.blurb')}
      </p>

      {/* ── engine status ─────────────────────────────────────────── */}
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <StatusDot
          ok={hasFfmpeg}
          label={hasFfmpeg ? t('audioeditor.engineReady') : t('audioeditor.engineMissing')}
        />
        {engine?.version && <span className="count-note">{engine.version}</span>}
        <button className="mini" onClick={engineQ.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>
      {!hasFfmpeg && !engineQ.loading && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('audioeditor.engineHint')}
        </p>
      )}

      {/* ── microphone input devices ──────────────────────────────── */}
      <h4 style={{ marginBottom: 4 }}>{t('audioeditor.micHeader')}</h4>
      <ModuleToolbar>
        <button className="mini" onClick={devQ.reload} disabled={!hasFfmpeg}>
          ⟳ {t('audioeditor.refreshMics')}
        </button>
        <span className="count-note">
          {t('audioeditor.micCount', { mics: devices.length })}
        </span>
      </ModuleToolbar>
      <AsyncState loading={devQ.loading} error={devQ.error}>
        {hasFfmpeg ? (
          <DataTable
            columns={[
              { key: 'name', header: t('audioeditor.micName') },
              {
                key: 'alt',
                header: t('audioeditor.micAlt'),
                render: (d: Device) => (
                  <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{d.alt || '—'}</code>
                ),
              },
            ]}
            rows={devices}
            rowKey={(d, i) => `${d.name}-${i}`}
            empty={t('audioeditor.noMics')}
          />
        ) : (
          <p className="count-note">{t('audioeditor.micNeedFfmpeg')}</p>
        )}
      </AsyncState>

      {/* ── effects catalog ───────────────────────────────────────── */}
      <h4 style={{ marginBottom: 4 }}>{t('audioeditor.fxHeader', { total: FX.length })}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('audioeditor.fxBlurb')}
      </p>
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('audioeditor.fxFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="mini"
          value={cat}
          onChange={(e) => setCat(e.target.value as FxCat | 'all')}
        >
          <option value="all">{t('audioeditor.catAll')}</option>
          {CAT_ORDER.map((c) => (
            <option key={c} value={c}>
              {t(`audioeditor.cat.${c}`)}
            </option>
          ))}
        </select>
        <span className="count-note">{t('audioeditor.fxCount', { shown: rows.length })}</span>
      </ModuleToolbar>
      <DataTable columns={columns} rows={rows} rowKey={(f) => f.id} />
    </div>
  );
}
