import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { resolveTool } from '../tauri/deps';
import { pick } from '../i18n';
import { Column, DataTable, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ═══════════════════════════════════════════════════════════════════════════
// WinForge · Audio Editor — full in-app editor (Web Audio API).
// Ported & upgraded from WinForge/Pages/AudioEditorModule.xaml(.cs) + its
// Ffmpeg/AudioEngine services. The C# editor shells out to ffmpeg for decode,
// waveform peaks, playback and every destructive effect. The web platform is
// stronger here: we decode with AudioContext.decodeAudioData, draw + zoom +
// select the waveform on a <canvas>, and run cut/copy/paste/trim/silence/
// gain/fade/normalize/reverse/speed/pitch/mix as real DSP on the sample data
// — instantly, with a full undo stack — no external process. ffmpeg is still
// used (via resolveTool) for the transcode export formats (mp3/flac/m4a/ogg/
// opus) it uniquely provides, matching the source's Export codec map.
// ═══════════════════════════════════════════════════════════════════════════

// ── helpers ────────────────────────────────────────────────────────────────
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

/** Decode a base64 string to a Uint8Array (browser-safe, no Buffer). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array to base64 in chunks (avoids call-stack blowups). */
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  const two = (n: number) => String(n).padStart(2, '0');
  const base = `${m}:${two(s)}.${two(cs)}`;
  return h > 0 ? `${h}:${two(m)}:${two(s)}.${two(cs)}` : base;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── in-app audio buffer model ──────────────────────────────────────────────
// We keep audio as plain Float32 channel arrays + sample rate so DSP is trivial
// and portable; an AudioBuffer is materialised only for playback.
interface Clip {
  channels: Float32Array[];
  rate: number;
  name: string;
  bytes: number; // original source size (for the info line)
}

function clipDuration(c: Clip): number {
  return c.channels[0] ? c.channels[0].length / c.rate : 0;
}

function cloneClip(c: Clip): Clip {
  return {
    channels: c.channels.map((ch) => ch.slice()),
    rate: c.rate,
    name: c.name,
    bytes: c.bytes,
  };
}

// ── WAV encode / decode fallback ───────────────────────────────────────────
/** Encode channel data to a 16-bit PCM WAV (used for export + AudioContext reload). */
function encodeWav(channels: Float32Array[], rate: number): Uint8Array {
  const numCh = Math.max(1, channels.length);
  const len = channels[0]?.length ?? 0;
  const blockAlign = numCh * 2;
  const dataLen = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  wr(36, 'data');
  view.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = channels[ch]?.[i] ?? 0;
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

// ── effect DSP (operate on channel arrays) ─────────────────────────────────
function applyGainDb(chs: Float32Array[], db: number, a = 0, b = -1): Float32Array[] {
  const mul = Math.pow(10, db / 20);
  return chs.map((ch) => {
    const out = ch.slice();
    const end = b < 0 ? out.length : Math.min(b, out.length);
    for (let i = Math.max(0, a); i < end; i++) out[i] = Math.max(-1, Math.min(1, (out[i] ?? 0) * mul));
    return out;
  });
}

function applyFade(chs: Float32Array[], durSamples: number, out: boolean): Float32Array[] {
  return chs.map((ch) => {
    const o = ch.slice();
    const n = Math.min(durSamples, o.length);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      const idx = out ? o.length - n + i : i;
      const gain = out ? 1 - g : g;
      o[idx] = (o[idx] ?? 0) * gain;
    }
    return o;
  });
}

function peakOf(chs: Float32Array[]): number {
  let p = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i] ?? 0); if (a > p) p = a; }
  return p;
}

function applyNormalize(chs: Float32Array[], targetPeak = 0.98): Float32Array[] {
  const p = peakOf(chs);
  if (p <= 1e-6) return chs.map((c) => c.slice());
  const g = targetPeak / p;
  return chs.map((ch) => ch.map((v) => Math.max(-1, Math.min(1, v * g))));
}

function applyReverse(chs: Float32Array[], a = 0, b = -1): Float32Array[] {
  return chs.map((ch) => {
    const o = ch.slice();
    const lo = Math.max(0, a);
    const hi = b < 0 ? o.length : Math.min(b, o.length);
    let i = lo, j = hi - 1;
    while (i < j) { const t = o[i] ?? 0; o[i] = o[j] ?? 0; o[j] = t; i++; j--; }
    return o;
  });
}

function silenceRange(chs: Float32Array[], a: number, b: number): Float32Array[] {
  return chs.map((ch) => {
    const o = ch.slice();
    for (let i = a; i < b && i < o.length; i++) o[i] = 0;
    return o;
  });
}

function trimTo(chs: Float32Array[], a: number, b: number): Float32Array[] {
  return chs.map((ch) => ch.slice(a, b));
}

function deleteRange(chs: Float32Array[], a: number, b: number): Float32Array[] {
  return chs.map((ch) => {
    const head = ch.slice(0, a);
    const tail = ch.slice(b);
    const out = new Float32Array(head.length + tail.length);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
  });
}

function insertAt(chs: Float32Array[], at: number, ins: Float32Array[]): Float32Array[] {
  return chs.map((ch, i) => {
    const clip = ins[i] ?? ins[0] ?? new Float32Array(0);
    const head = ch.slice(0, at);
    const tail = ch.slice(at);
    const out = new Float32Array(head.length + clip.length + tail.length);
    out.set(head, 0);
    out.set(clip, head.length);
    out.set(tail, head.length + clip.length);
    return out;
  });
}

/** Linear-resample the whole clip by `factor` (>1 = faster/shorter). Changes pitch. */
function resample(chs: Float32Array[], factor: number): Float32Array[] {
  if (factor <= 0) return chs.map((c) => c.slice());
  const srcLen = chs[0]?.length ?? 0;
  const dstLen = Math.max(1, Math.round(srcLen / factor));
  return chs.map((ch) => {
    const out = new Float32Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const pos = i * factor;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = ch[i0] ?? 0;
      const s1 = ch[i0 + 1] ?? s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  });
}

/** Time-stretch (change duration, keep pitch) via overlap-add (OLA). factor>1 = faster. */
function timeStretch(chs: Float32Array[], factor: number): Float32Array[] {
  if (Math.abs(factor - 1) < 1e-4) return chs.map((c) => c.slice());
  const win = 2048;
  const half = win / 2;
  const synHop = half;
  const anaHop = Math.round(half * factor);
  return chs.map((ch) => {
    const outLen = Math.max(1, Math.round(ch.length / factor) + win);
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);
    let ana = 0;
    let syn = 0;
    while (ana + win < ch.length && syn + win < outLen) {
      for (let i = 0; i < win; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
        out[syn + i] = (out[syn + i] ?? 0) + (ch[ana + i] ?? 0) * w;
        norm[syn + i] = (norm[syn + i] ?? 0) + w;
      }
      ana += anaHop;
      syn += synHop;
    }
    for (let i = 0; i < outLen; i++) { const n = norm[i] ?? 0; if (n > 1e-6) out[i] = (out[i] ?? 0) / n; }
    // trim trailing silence introduced by the pad window
    let last = out.length;
    while (last > 1 && Math.abs(out[last - 1] ?? 0) < 1e-5) last--;
    return out.slice(0, last);
  });
}

/** Pitch shift by `semitones`, preserving duration: resample then time-stretch back. */
function pitchShift(chs: Float32Array[], semitones: number): Float32Array[] {
  const ratio = Math.pow(2, semitones / 12);
  const resampled = resample(chs, 1 / ratio); // longer/shorter, wrong tempo
  return timeStretch(resampled, 1 / ratio); // back to original duration
}

// ── effect catalog (reference — the exact ffmpeg chains the desktop uses) ───
type FxCat = 'amplitude' | 'fade' | 'pitch' | 'eq' | 'effect' | 'channel';
interface Fx {
  id: string;
  en: string;
  zh: string;
  descEn: string;
  descZh: string;
  cat: FxCat;
  filter: string;
  raw?: boolean;
}
const FX: Fx[] = [
  { id: 'gain-up-6', en: 'Amplify +6 dB', zh: '放大 +6 dB', descEn: 'Boost the whole clip by 6 decibels.', descZh: '將成段加大 6 分貝。', cat: 'amplitude', filter: 'volume=6dB' },
  { id: 'gain-up-3', en: 'Amplify +3 dB', zh: '放大 +3 dB', descEn: 'Boost the whole clip by 3 decibels.', descZh: '將成段加大 3 分貝。', cat: 'amplitude', filter: 'volume=3dB' },
  { id: 'gain-down-3', en: 'Attenuate -3 dB', zh: '減弱 -3 dB', descEn: 'Reduce the whole clip by 3 decibels.', descZh: '將成段減細 3 分貝。', cat: 'amplitude', filter: 'volume=-3dB' },
  { id: 'gain-down-6', en: 'Attenuate -6 dB', zh: '減弱 -6 dB', descEn: 'Reduce the whole clip by 6 decibels.', descZh: '將成段減細 6 分貝。', cat: 'amplitude', filter: 'volume=-6dB' },
  { id: 'normalize', en: 'Normalize loudness (EBU R128)', zh: '正規化響度 (EBU R128)', descEn: 'Even out perceived loudness to a broadcast target with loudnorm.', descZh: '用 loudnorm 將響度拉到廣播標準。', cat: 'amplitude', filter: 'loudnorm=I=-16:TP=-1.5:LRA=11' },
  { id: 'peak-normalize', en: 'Peak normalize', zh: '峰值正規化', descEn: 'Bring the loudest peak up to just below 0 dBFS.', descZh: '將最大峰值推到接近 0 dBFS。', cat: 'amplitude', filter: 'dynaudnorm=p=0.95' },
  { id: 'compress', en: 'Compressor', zh: '壓縮器', descEn: 'Tighten dynamic range so quiet and loud parts sit closer together.', descZh: '壓窄動態範圍，大細聲更平均。', cat: 'amplitude', filter: 'acompressor=threshold=-18dB:ratio=4:attack=20:release=250' },
  { id: 'limiter', en: 'Limiter', zh: '限幅器', descEn: 'Hard-limit peaks to prevent clipping.', descZh: '硬性限制峰值，防止削波。', cat: 'amplitude', filter: 'alimiter=limit=0.95' },
  { id: 'fade-in-1', en: 'Fade in (1 s)', zh: '淡入 (1 秒)', descEn: 'Add a one-second fade-in at the start.', descZh: '喺開頭加一秒淡入。', cat: 'fade', filter: 'afade=t=in:st=0:d=1' },
  { id: 'fade-in-3', en: 'Fade in (3 s)', zh: '淡入 (3 秒)', descEn: 'Add a three-second fade-in at the start.', descZh: '喺開頭加三秒淡入。', cat: 'fade', filter: 'afade=t=in:st=0:d=3' },
  { id: 'fade-out-1', en: 'Fade out (1 s)', zh: '淡出 (1 秒)', descEn: 'Add a one-second fade-out at the very end.', descZh: '喺結尾加一秒淡出。', cat: 'fade', filter: '-i {in} -af "areverse,afade=t=in:st=0:d=1,areverse" -c:a pcm_s16le {out}', raw: true },
  { id: 'fade-out-3', en: 'Fade out (3 s)', zh: '淡出 (3 秒)', descEn: 'Add a three-second fade-out at the very end.', descZh: '喺結尾加三秒淡出。', cat: 'fade', filter: '-i {in} -af "areverse,afade=t=in:st=0:d=3,areverse" -c:a pcm_s16le {out}', raw: true },
  { id: 'trim-silence', en: 'Trim leading/trailing silence', zh: '剪走頭尾靜音', descEn: 'Remove silence at the start and end of the clip.', descZh: '去走開頭同結尾嘅靜音。', cat: 'fade', filter: 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,areverse' },
  { id: 'pad-silence', en: 'Add 1 s silence at start', zh: '開頭加 1 秒靜音', descEn: 'Prepend one second of silence.', descZh: '喺開頭加一秒靜音。', cat: 'fade', filter: 'adelay=1000|1000' },
  { id: 'speed-1_5', en: 'Speed up 1.5×', zh: '加速 1.5 倍', descEn: 'Play 1.5× faster without changing pitch.', descZh: '用唔變音高嘅方式快 1.5 倍。', cat: 'pitch', filter: 'atempo=1.5' },
  { id: 'speed-2', en: 'Speed up 2×', zh: '加速 2 倍', descEn: 'Play twice as fast without changing pitch.', descZh: '用唔變音高嘅方式快一倍。', cat: 'pitch', filter: 'atempo=2.0' },
  { id: 'speed-0_75', en: 'Slow down 0.75×', zh: '減慢 0.75 倍', descEn: 'Play slower without changing pitch.', descZh: '用唔變音高嘅方式慢落嚟。', cat: 'pitch', filter: 'atempo=0.75' },
  { id: 'speed-0_5', en: 'Slow down 0.5×', zh: '減慢 0.5 倍', descEn: 'Play at half speed without changing pitch.', descZh: '用唔變音高嘅方式慢一半。', cat: 'pitch', filter: 'atempo=0.5' },
  { id: 'pitch-up', en: 'Pitch up +2 semitones', zh: '升音 +2 半音', descEn: 'Raise the pitch by two semitones, keeping duration.', descZh: '升高兩個半音，時長不變。', cat: 'pitch', filter: 'asetrate=44100*1.122462,aresample=44100,atempo=0.891' },
  { id: 'pitch-down', en: 'Pitch down -2 semitones', zh: '降音 -2 半音', descEn: 'Lower the pitch by two semitones, keeping duration.', descZh: '降低兩個半音，時長不變。', cat: 'pitch', filter: 'asetrate=44100*0.890899,aresample=44100,atempo=1.122' },
  { id: 'chipmunk', en: 'Chipmunk (pitch up octave)', zh: '花栗鼠 (升八度)', descEn: 'Raise pitch by a full octave for a chipmunk voice.', descZh: '升高一個八度，變花栗鼠聲。', cat: 'pitch', filter: 'asetrate=44100*2,aresample=44100' },
  { id: 'deep', en: 'Deep voice (pitch down octave)', zh: '低沉 (降八度)', descEn: 'Lower pitch by a full octave for a deep voice.', descZh: '降低一個八度，變低沉聲。', cat: 'pitch', filter: 'asetrate=44100*0.5,aresample=44100' },
  { id: 'bass-boost', en: 'Bass boost', zh: '加重低音', descEn: 'Lift the low frequencies.', descZh: '提升低頻。', cat: 'eq', filter: 'bass=g=8' },
  { id: 'bass-cut', en: 'Bass cut', zh: '減低音', descEn: 'Reduce the low frequencies.', descZh: '減少低頻。', cat: 'eq', filter: 'bass=g=-8' },
  { id: 'treble-boost', en: 'Treble boost', zh: '加重高音', descEn: 'Lift the high frequencies for more sparkle.', descZh: '提升高頻，更通透。', cat: 'eq', filter: 'treble=g=8' },
  { id: 'treble-cut', en: 'Treble cut', zh: '減高音', descEn: 'Reduce the high frequencies.', descZh: '減少高頻。', cat: 'eq', filter: 'treble=g=-8' },
  { id: 'highpass', en: 'High-pass 100 Hz (remove rumble)', zh: '高通 100 Hz (除隆隆聲)', descEn: 'Cut very low frequencies to remove rumble/hum.', descZh: '切走超低頻，去走隆隆聲。', cat: 'eq', filter: 'highpass=f=100' },
  { id: 'lowpass', en: 'Low-pass 12 kHz (soften hiss)', zh: '低通 12 kHz (柔化嘶聲)', descEn: 'Cut very high frequencies to soften hiss.', descZh: '切走超高頻，柔化嘶聲。', cat: 'eq', filter: 'lowpass=f=12000' },
  { id: 'telephone', en: 'Telephone EQ', zh: '電話聲 EQ', descEn: 'Band-limit to a tinny telephone sound.', descZh: '限頻做電話般嘅薄聲。', cat: 'eq', filter: 'highpass=f=300,lowpass=f=3400' },
  { id: 'loudness-contour', en: 'Loudness contour', zh: '響度等化曲線', descEn: 'Gently lift bass and treble for a fuller sound at low volume.', descZh: '輕微提升低高頻，細聲都飽滿。', cat: 'eq', filter: 'bass=g=4,treble=g=3' },
  { id: 'echo', en: 'Echo', zh: '回音', descEn: 'Add a repeating echo tail.', descZh: '加重複嘅回音尾。', cat: 'effect', filter: 'aecho=0.8:0.88:60:0.4' },
  { id: 'reverb', en: 'Reverb (room)', zh: '混響 (房間)', descEn: 'Add a small-room reverb.', descZh: '加細房間嘅混響。', cat: 'effect', filter: 'aecho=0.8:0.9:40|55|70:0.4|0.3|0.2' },
  { id: 'reverb-hall', en: 'Reverb (hall)', zh: '混響 (大廳)', descEn: 'Add a big-hall reverb.', descZh: '加大廳般嘅混響。', cat: 'effect', filter: 'aecho=0.8:0.9:500|700|900:0.5|0.4|0.3' },
  { id: 'denoise', en: 'Noise reduction (FFT)', zh: '降噪 (FFT)', descEn: 'Reduce broadband background noise/hiss.', descZh: '減少背景雜訊／嘶聲。', cat: 'effect', filter: 'afftdn=nr=12:nf=-25' },
  { id: 'denoise-strong', en: 'Noise reduction (strong)', zh: '降噪 (強)', descEn: 'Aggressively reduce background noise.', descZh: '大力減少背景雜訊。', cat: 'effect', filter: 'afftdn=nr=24:nf=-30' },
  { id: 'reverse', en: 'Reverse', zh: '倒轉播放', descEn: 'Play the clip backwards.', descZh: '將段聲倒返轉播。', cat: 'effect', filter: 'areverse' },
  { id: 'tremolo', en: 'Tremolo', zh: '顫音', descEn: 'Add a wobbling amplitude tremolo.', descZh: '加抖動嘅振幅顫音。', cat: 'effect', filter: 'tremolo=f=5:d=0.7' },
  { id: 'vibrato', en: 'Vibrato', zh: '抖音', descEn: 'Add a pitch vibrato.', descZh: '加音高抖動嘅抖音。', cat: 'effect', filter: 'vibrato=f=6:d=0.5' },
  { id: 'stereo-widen', en: 'Stereo widen', zh: '立體聲加寬', descEn: 'Widen the stereo image.', descZh: '加闊立體聲場。', cat: 'effect', filter: 'extrastereo=m=2.5' },
  { id: 'to-mono', en: 'Convert to mono', zh: '轉單聲道', descEn: 'Downmix to a single mono channel.', descZh: '混落單一單聲道。', cat: 'channel', filter: '-i {in} -ac 1 -c:a pcm_s16le {out}', raw: true },
  { id: 'to-stereo', en: 'Convert to stereo', zh: '轉立體聲', descEn: 'Upmix mono to two stereo channels.', descZh: '由單聲道升做兩聲道立體聲。', cat: 'channel', filter: '-i {in} -ac 2 -c:a pcm_s16le {out}', raw: true },
  { id: 'swap-channels', en: 'Swap L/R channels', zh: '左右聲道對調', descEn: 'Swap the left and right stereo channels.', descZh: '對調左右聲道。', cat: 'channel', filter: 'pan=stereo|c0=c1|c1=c0' },
  { id: 'resample-48k', en: 'Resample to 48 kHz', zh: '重新取樣到 48 kHz', descEn: 'Change the sample rate to 48000 Hz.', descZh: '將取樣率改做 48000 Hz。', cat: 'channel', filter: '-i {in} -ar 48000 -c:a pcm_s16le {out}', raw: true },
  { id: 'resample-44k', en: 'Resample to 44.1 kHz', zh: '重新取樣到 44.1 kHz', descEn: 'Change the sample rate to 44100 Hz.', descZh: '將取樣率改做 44100 Hz。', cat: 'channel', filter: '-i {in} -ar 44100 -c:a pcm_s16le {out}', raw: true },
];
const CAT_ORDER: FxCat[] = ['amplitude', 'fade', 'pitch', 'eq', 'effect', 'channel'];

// Export formats + their ffmpeg codec args (mirrors FfmpegAudioService.ExportAsync).
const EXPORT_FORMATS: { ext: string; codec: string[]; en: string; zh: string }[] = [
  { ext: 'wav', codec: ['-c:a', 'pcm_s16le'], en: 'WAV (in-app, no ffmpeg)', zh: 'WAV（app 內，唔使 ffmpeg）' },
  { ext: 'mp3', codec: ['-c:a', 'libmp3lame', '-q:a', '2'], en: 'MP3 (libmp3lame)', zh: 'MP3（libmp3lame）' },
  { ext: 'm4a', codec: ['-c:a', 'aac', '-b:a', '256k'], en: 'M4A / AAC', zh: 'M4A / AAC' },
  { ext: 'flac', codec: ['-c:a', 'flac'], en: 'FLAC (lossless)', zh: 'FLAC（無損）' },
  { ext: 'ogg', codec: ['-c:a', 'libvorbis', '-q:a', '5'], en: 'OGG Vorbis', zh: 'OGG Vorbis' },
  { ext: 'opus', codec: ['-c:a', 'libopus', '-b:a', '160k'], en: 'Opus', zh: 'Opus' },
];

const AUDIO_EXTS = 'wav;mp3;flac;m4a;aac;ogg;opus;wma;aiff;aif';

// ── multi-track mix model ──────────────────────────────────────────────────
interface Track {
  id: string;
  name: string;
  clip: Clip;
  gainDb: number;
  mute: boolean;
  solo: boolean;
  offsetSec: number;
}

// ── shared card style (matches the CardBackground look) ────────────────────
const card: CSSProperties = {
  background: 'var(--card, rgba(127,127,127,0.06))',
  border: '1px solid var(--border, rgba(127,127,127,0.22))',
  borderRadius: 8,
  padding: '14px 16px',
  marginTop: 12,
};

export function AudioEditorModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const live = isTauri();

  // ── engine probe (ffmpeg for transcode + probing) ────────────────────────
  const engineQ = useAsync<{ ffmpeg: string | null; ffprobe: string | null; version: string }>(
    async () => {
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
    },
    [live],
  );
  const engine = engineQ.data;
  const hasFfmpeg = !!engine?.ffmpeg;

  // ── working clip + undo/redo + clipboard ─────────────────────────────────
  const [clip, setClip] = useState<Clip | null>(null);
  const undoRef = useRef<Clip[]>([]);
  const redoRef = useRef<Clip[]>([]);
  const [histLen, setHistLen] = useState(0); // just to trigger re-render on undo depth
  const clipboardRef = useRef<{ channels: Float32Array[]; rate: number } | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  const originalRef = useRef<Clip | null>(null);

  // ── selection (samples) + view (zoom/scroll) ─────────────────────────────
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [view, setView] = useState<{ start: number; len: number } | null>(null); // in samples
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  // ── playback ─────────────────────────────────────────────────────────────
  const acRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const playStartRef = useRef({ ctxTime: 0, offset: 0, stopAt: 0 });
  const [playhead, setPlayhead] = useState<number | null>(null); // seconds
  const rafRef = useRef<number | null>(null);

  // ── effect params ────────────────────────────────────────────────────────
  const [gainDb, setGainDb] = useState(0);
  const [fadeSec, setFadeSec] = useState(2);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);

  // ── mix tracks ───────────────────────────────────────────────────────────
  const [tracks, setTracks] = useState<Track[]>([]);

  // ── effects catalog filter ───────────────────────────────────────────────
  const [fxFilter, setFxFilter] = useState('');
  const [fxCat, setFxCat] = useState<FxCat | 'all'>('all');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ anchor: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const P = useCallback((en: string, yue: string) => pick(en, yue, i18n.language), [i18n.language]);

  const ac = useCallback((): AudioContext => {
    if (!acRef.current) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      acRef.current = new Ctor();
    }
    return acRef.current;
  }, []);

  const dur = clip ? clipDuration(clip) : 0;
  const rate = clip?.rate ?? 44100;
  const totalSamples = clip?.channels[0]?.length ?? 0;

  // ── history helpers ──────────────────────────────────────────────────────
  const pushHistory = useCallback((next: Clip) => {
    setClip((cur) => {
      if (cur) undoRef.current.push(cur);
      if (undoRef.current.length > 40) undoRef.current.shift();
      redoRef.current = [];
      setHistLen(undoRef.current.length);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setClip((cur) => {
      if (cur) redoRef.current.push(cur);
      return prev;
    });
    setHistLen(undoRef.current.length);
    setSel(null);
    setStatus({ ok: true, text: P('Undone.', '已復原。') });
  }, [P]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    setClip((cur) => {
      if (cur) undoRef.current.push(cur);
      return next;
    });
    setHistLen(undoRef.current.length);
    setStatus({ ok: true, text: P('Redone.', '已重做。') });
  }, [P]);

  // ── stop playback + rAF loop ─────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (srcRef.current) {
      try { srcRef.current.onended = null; srcRef.current.stop(); } catch { /* already stopped */ }
      srcRef.current = null;
    }
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setPlayhead(null);
  }, []);

  useEffect(() => () => { stopPlayback(); try { acRef.current?.close(); } catch { /* ignore */ } }, [stopPlayback]);

  // ── load a clip (from decoded channels) ──────────────────────────────────
  const loadClip = useCallback((next: Clip) => {
    stopPlayback();
    undoRef.current = [];
    redoRef.current = [];
    setHistLen(0);
    originalRef.current = cloneClip(next);
    setClip(next);
    setSel(null);
    setView({ start: 0, len: next.channels[0]?.length ?? 0 });
    setStatus({ ok: true, text: P('Loaded {n}.', '已載入 {n}。').replace('{n}', next.name) });
  }, [P, stopPlayback]);

  // Decode an ArrayBuffer of file bytes into a Clip.
  const decodeBytes = useCallback(async (bytes: Uint8Array, name: string): Promise<Clip> => {
    const copy = bytes.slice();
    const audio = await ac().decodeAudioData(copy.buffer);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).slice());
    if (channels.length === 0) channels.push(new Float32Array(0));
    return { channels, rate: audio.sampleRate, name, bytes: bytes.length };
  }, [ac]);

  // ── OPEN ─────────────────────────────────────────────────────────────────
  const openFile = useCallback(async () => {
    setStatus(null);
    if (!live) {
      fileInputRef.current?.click();
      return;
    }
    setBusy('open');
    try {
      const filter = `Audio files|${AUDIO_EXTS.split(';').map((e) => `*.${e}`).join(';')}|All files|*.*`;
      const res = await runPowershell(
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(P('Open audio', '開啟音訊'))}'; ` +
          `$d.Filter='${psq(filter)}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const path = res.stdout.trim();
      if (!path) { setBusy(''); return; }
      const r = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psq(path)}'))`);
      const b64 = r.stdout.trim();
      if (!b64) throw new Error(P('Could not read file.', '讀唔到檔案。'));
      const name = path.split(/[\\/]/).pop() ?? path;
      const next = await decodeBytes(b64ToBytes(b64), name);
      loadClip(next);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [P, decodeBytes, live, loadClip]);

  const onBrowserFile = useCallback(async (file: File) => {
    setBusy('open');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const next = await decodeBytes(buf, file.name);
      loadClip(next);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [decodeBytes, loadClip]);

  const revert = useCallback(() => {
    if (!originalRef.current) return;
    stopPlayback();
    undoRef.current = [];
    redoRef.current = [];
    setHistLen(0);
    const o = cloneClip(originalRef.current);
    setClip(o);
    setSel(null);
    setView({ start: 0, len: o.channels[0]?.length ?? 0 });
    setStatus({ ok: true, text: P('Reverted to the original.', '已還原到原檔。') });
  }, [P, stopPlayback]);

  // ── RECORD (getUserMedia + MediaRecorder) ────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [permErr, setPermErr] = useState<string | null>(null);
  const recRef = useRef<{ recorder: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null);
  const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const startRecording = useCallback(async () => {
    setPermErr(null);
    setStatus(null);
    if (!canRecord) { setPermErr(P('Recording is not supported in this browser.', '呢個瀏覽器唔支援錄音。')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const buf = new Uint8Array(await blob.arrayBuffer());
          const next = await decodeBytes(buf, P('recording.wav', '錄音.wav'));
          loadClip(next);
        } catch (e) {
          setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
        }
      };
      recRef.current = { recorder, chunks, stream };
      recorder.start();
      setRecording(true);
    } catch (e) {
      setPermErr(P('Microphone permission was denied.', '麥克風權限被拒。') + ' ' + String(e instanceof Error ? e.message : e));
    }
  }, [P, canRecord, decodeBytes, loadClip]);

  const stopRecording = useCallback(() => {
    const r = recRef.current;
    if (!r) return;
    try { r.recorder.stop(); } catch { /* ignore */ }
    r.stream.getTracks().forEach((tk) => tk.stop());
    recRef.current = null;
    setRecording(false);
  }, []);

  // ── waveform drawing ─────────────────────────────────────────────────────
  const drawWave = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 800;
    const cssH = cv.clientHeight || 180;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    // background
    g.fillStyle = 'rgba(127,127,127,0.10)';
    g.fillRect(0, 0, cssW, cssH);

    if (!clip || totalSamples === 0 || !view) {
      g.fillStyle = 'rgba(127,127,127,0.75)';
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(P('Open or record audio to see its waveform here.', '開檔或錄音，波形會喺呢度顯示。'), cssW / 2, cssH / 2);
      return;
    }
    const vStart = Math.max(0, view.start);
    const vLen = Math.max(1, Math.min(view.len, totalSamples - vStart));
    const mid = cssH / 2;
    const accent = 'var(--accent)';

    // selection highlight
    if (sel && sel.b > sel.a) {
      const x1 = ((sel.a - vStart) / vLen) * cssW;
      const x2 = ((sel.b - vStart) / vLen) * cssW;
      g.fillStyle = 'rgba(96,165,250,0.22)';
      g.fillRect(Math.max(0, x1), 0, Math.min(cssW, x2) - Math.max(0, x1), cssH);
    }

    // waveform min/max per pixel column
    const ch0 = clip.channels[0];
    if (!ch0) return;
    g.strokeStyle = getComputedStyle(cv).getPropertyValue('--accent') || accent;
    g.fillStyle = g.strokeStyle;
    const perCol = vLen / cssW;
    for (let x = 0; x < cssW; x++) {
      const s0 = vStart + Math.floor(x * perCol);
      const s1 = vStart + Math.floor((x + 1) * perCol);
      let min = 1, max = -1;
      for (let i = s0; i < s1 && i < totalSamples; i++) {
        const v = ch0[i] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      const yTop = mid - max * (mid - 3);
      const yBot = mid - min * (mid - 3);
      g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }

    // playhead
    if (playhead != null) {
      const ps = playhead * rate;
      if (ps >= vStart && ps <= vStart + vLen) {
        const x = ((ps - vStart) / vLen) * cssW;
        g.fillStyle = 'var(--accent)';
        g.fillRect(x - 1, 0, 2, cssH);
      }
    }
  }, [P, clip, playhead, rate, sel, totalSamples, view]);

  useEffect(() => { drawWave(); }, [drawWave]);
  useEffect(() => {
    const onResize = () => drawWave();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [drawWave]);

  // ── pointer selection on canvas ──────────────────────────────────────────
  const xToSample = useCallback((clientX: number): number => {
    const cv = canvasRef.current;
    if (!cv || !view) return 0;
    const rect = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(view.start + frac * view.len);
  }, [view]);

  const onWaveDown = useCallback((e: React.PointerEvent) => {
    if (!clip || totalSamples === 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const s = xToSample(e.clientX);
    dragRef.current = { anchor: s };
    setSel({ a: s, b: s });
  }, [clip, totalSamples, xToSample]);

  const onWaveMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const s = xToSample(e.clientX);
    const a = Math.min(dragRef.current.anchor, s);
    const b = Math.max(dragRef.current.anchor, s);
    setSel({ a, b });
  }, [xToSample]);

  const onWaveUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const anchor = dragRef.current.anchor;
    dragRef.current = null;
    const s = xToSample(e.clientX);
    if (Math.abs(s - anchor) < rate * 0.01) {
      // a click = a seek point, no range
      setSel(null);
      setPlayhead(anchor / rate);
    }
  }, [rate, xToSample]);

  const selRange = sel && sel.b > sel.a ? sel : null;

  // ── zoom / scroll ────────────────────────────────────────────────────────
  const zoom = useCallback((factor: number) => {
    setView((v) => {
      if (!v || totalSamples === 0) return v;
      const center = v.start + v.len / 2;
      let len = Math.round(v.len * factor);
      len = Math.max(Math.round(rate * 0.02), Math.min(totalSamples, len));
      let start = Math.round(center - len / 2);
      start = Math.max(0, Math.min(totalSamples - len, start));
      return { start, len };
    });
  }, [rate, totalSamples]);

  const zoomSelection = useCallback(() => {
    if (!selRange) return;
    const len = Math.max(Math.round(rate * 0.02), selRange.b - selRange.a);
    setView({ start: Math.max(0, selRange.a), len: Math.min(len, totalSamples) });
  }, [rate, selRange, totalSamples]);

  const zoomFit = useCallback(() => setView({ start: 0, len: totalSamples }), [totalSamples]);

  const scroll = useCallback((dir: number) => {
    setView((v) => {
      if (!v) return v;
      const step = Math.round(v.len * 0.25) * dir;
      const start = Math.max(0, Math.min(totalSamples - v.len, v.start + step));
      return { start, len: v.len };
    });
  }, [totalSamples]);

  // ── build an AudioBuffer for playback ────────────────────────────────────
  const toAudioBuffer = useCallback((c: Clip): AudioBuffer => {
    const ctx = ac();
    const buf = ctx.createBuffer(Math.max(1, c.channels.length), c.channels[0]?.length ?? 1, c.rate);
    for (let ch = 0; ch < c.channels.length; ch++) {
      const data = buf.getChannelData(ch);
      data.set(c.channels[ch] ?? new Float32Array(0));
    }
    return buf;
  }, [ac]);

  const play = useCallback((fromSec: number, toSec: number) => {
    if (!clip) return;
    stopPlayback();
    const ctx = ac();
    void ctx.resume();
    const buf = toAudioBuffer(clip);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const from = Math.max(0, fromSec);
    const to = toSec > from ? Math.min(toSec, dur) : dur;
    playStartRef.current = { ctxTime: ctx.currentTime, offset: from, stopAt: to };
    src.start(0, from, to - from);
    src.onended = () => { if (srcRef.current === src) stopPlayback(); };
    srcRef.current = src;
    const loop = () => {
      const st = playStartRef.current;
      const pos = st.offset + (ctx.currentTime - st.ctxTime);
      if (pos >= st.stopAt) { stopPlayback(); return; }
      setPlayhead(pos);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [ac, clip, dur, stopPlayback, toAudioBuffer]);

  const playAll = useCallback(() => play(playhead ?? 0, dur), [dur, play, playhead]);
  const playSel = useCallback(() => {
    if (selRange) play(selRange.a / rate, selRange.b / rate);
    else playAll();
  }, [playAll, play, rate, selRange]);

  // ── edit operations ──────────────────────────────────────────────────────
  const needSel = useCallback((): { a: number; b: number } | null => {
    if (selRange) return selRange;
    setStatus({ ok: false, text: P('Drag on the waveform to select a range first.', '請先喺波形上拖曳揀範圍。') });
    return null;
  }, [P, selRange]);

  const withClip = useCallback((fn: (c: Clip) => Float32Array[], msg: [string, string]) => {
    if (!clip) return;
    stopPlayback();
    const chans = fn(clip);
    pushHistory({ ...clip, channels: chans });
    setStatus({ ok: true, text: P(msg[0], msg[1]) });
  }, [P, clip, pushHistory, stopPlayback]);

  const doTrim = useCallback(() => {
    const s = needSel();
    if (!s || !clip) return;
    withClip((c) => trimTo(c.channels, s.a, s.b), ['Trimmed to selection.', '已剪裁成選取。']);
    setSel(null);
    setView({ start: 0, len: s.b - s.a });
  }, [clip, needSel, withClip]);

  const doDelete = useCallback(() => {
    const s = needSel();
    if (!s) return;
    withClip((c) => deleteRange(c.channels, s.a, s.b), ['Deleted selection.', '已刪除選取。']);
    setSel(null);
  }, [needSel, withClip]);

  const doSilence = useCallback(() => {
    const s = needSel();
    if (!s) return;
    withClip((c) => silenceRange(c.channels, s.a, s.b), ['Silenced selection.', '已靜音選取。']);
  }, [needSel, withClip]);

  const doCopy = useCallback(() => {
    const s = needSel();
    if (!s || !clip) return;
    clipboardRef.current = { channels: clip.channels.map((ch) => ch.slice(s.a, s.b)), rate: clip.rate };
    setHasClipboard(true);
    setStatus({ ok: true, text: P('Copied selection to the clipboard.', '已複製選取到剪貼簿。') });
  }, [P, clip, needSel]);

  const doCut = useCallback(() => {
    const s = needSel();
    if (!s || !clip) return;
    clipboardRef.current = { channels: clip.channels.map((ch) => ch.slice(s.a, s.b)), rate: clip.rate };
    setHasClipboard(true);
    withClip((c) => deleteRange(c.channels, s.a, s.b), ['Cut selection.', '已剪下選取。']);
    setSel(null);
  }, [P, clip, needSel, withClip]);

  const doPaste = useCallback(() => {
    if (!clip || !clipboardRef.current) return;
    const at = selRange ? selRange.a : Math.round((playhead ?? 0) * rate);
    const ins = clipboardRef.current.channels;
    withClip((c) => insertAt(c.channels, Math.max(0, Math.min(at, totalSamples)), ins), ['Pasted at the cursor.', '已喺游標貼上。']);
  }, [clip, playhead, rate, selRange, totalSamples, withClip]);

  const selectAll = useCallback(() => { if (totalSamples > 0) setSel({ a: 0, b: totalSamples }); }, [totalSamples]);
  const clearSel = useCallback(() => setSel(null), []);

  const doGain = useCallback(() => {
    const s = selRange;
    withClip((c) => applyGainDb(c.channels, gainDb, s?.a ?? 0, s?.b ?? -1),
      s ? ['Applied gain to selection.', '已對選取套用增益。'] : ['Applied gain.', '已套用增益。']);
  }, [gainDb, selRange, withClip]);

  const doFadeIn = useCallback(() => {
    withClip((c) => applyFade(c.channels, Math.round(fadeSec * rate), false), ['Faded in.', '已淡入。']);
  }, [fadeSec, rate, withClip]);

  const doFadeOut = useCallback(() => {
    withClip((c) => applyFade(c.channels, Math.round(fadeSec * rate), true), ['Faded out.', '已淡出。']);
  }, [fadeSec, rate, withClip]);

  const doNormalize = useCallback(() => {
    withClip((c) => applyNormalize(c.channels), ['Normalized to peak.', '已正規化到峰值。']);
  }, [withClip]);

  const doReverse = useCallback(() => {
    const s = selRange;
    withClip((c) => applyReverse(c.channels, s?.a ?? 0, s?.b ?? -1),
      s ? ['Reversed selection.', '已倒轉選取。'] : ['Reversed.', '已倒轉。']);
  }, [selRange, withClip]);

  const doSpeed = useCallback(() => {
    setBusy('speed');
    setTimeout(() => {
      withClip((c) => timeStretch(c.channels, speed), ['Changed speed (pitch kept).', '已變速（音高不變）。']);
      setSel(null);
      setView((v) => (v ? { start: 0, len: 0 } : v));
      setBusy('');
    }, 10);
  }, [speed, withClip]);

  const doPitch = useCallback(() => {
    setBusy('pitch');
    setTimeout(() => {
      withClip((c) => pitchShift(c.channels, pitch), ['Shifted pitch (duration kept).', '已變調（時長不變）。']);
      setBusy('');
    }, 10);
  }, [pitch, withClip]);

  const doMono = useCallback(() => {
    if (!clip) return;
    withClip((c) => {
      if (c.channels.length <= 1) return c.channels.map((ch) => ch.slice());
      const n = c.channels[0]?.length ?? 0;
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (const ch of c.channels) sum += ch[i] ?? 0;
        mono[i] = sum / c.channels.length;
      }
      return [mono];
    }, ['Downmixed to mono.', '已混落單聲道。']);
  }, [clip, withClip]);

  // keep view length in sync when the clip length changes (e.g. speed/trim reset view.len=0)
  useEffect(() => {
    if (clip && view && view.len === 0) setView({ start: 0, len: clip.channels[0]?.length ?? 0 });
  }, [clip, view]);

  // ── mix: add / mixdown ───────────────────────────────────────────────────
  const addTrackFromClip = useCallback(() => {
    if (!clip) return;
    setTracks((ts) => [
      ...ts,
      { id: `t${Date.now()}`, name: clip.name, clip: cloneClip(clip), gainDb: 0, mute: false, solo: false, offsetSec: 0 },
    ]);
    setStatus({ ok: true, text: P('Added the current clip as a track.', '已將目前 clip 加做一軌。') });
  }, [P, clip]);

  const addTrackFromFile = useCallback(async () => {
    if (!live) {
      if (fileInputRef.current) fileInputRef.current.dataset.mode = 'track';
      fileInputRef.current?.click();
      return;
    }
    setBusy('track');
    try {
      const filter = `Audio files|${AUDIO_EXTS.split(';').map((e) => `*.${e}`).join(';')}|All files|*.*`;
      const res = await runPowershell(
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(P('Add a track', '加一軌'))}'; ` +
          `$d.Filter='${psq(filter)}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const path = res.stdout.trim();
      if (!path) { setBusy(''); return; }
      const r = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psq(path)}'))`);
      const b64 = r.stdout.trim();
      if (!b64) throw new Error(P('Could not read file.', '讀唔到檔案。'));
      const name = path.split(/[\\/]/).pop() ?? path;
      const c = await decodeBytes(b64ToBytes(b64), name);
      setTracks((ts) => [...ts, { id: `t${Date.now()}`, name: c.name, clip: c, gainDb: 0, mute: false, solo: false, offsetSec: 0 }]);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [P, decodeBytes, live]);

  const updateTrack = useCallback((id: string, patch: Partial<Track>) => {
    setTracks((ts) => ts.map((tk) => (tk.id === id ? { ...tk, ...patch } : tk)));
  }, []);
  const removeTrack = useCallback((id: string) => setTracks((ts) => ts.filter((tk) => tk.id !== id)), []);

  const mixdown = useCallback(() => {
    if (tracks.length === 0) return;
    const anySolo = tracks.some((tk) => tk.solo);
    const active = tracks.filter((tk) => (anySolo ? tk.solo : true) && !tk.mute);
    if (active.length === 0) { setStatus({ ok: false, text: P('All tracks are muted.', '所有軌都被靜音。') }); return; }
    const outRate = Math.max(...active.map((tk) => tk.clip.rate));
    // compute total length in output samples
    let maxLen = 0;
    const prepared = active.map((tk) => {
      let chans = tk.clip.channels;
      if (tk.clip.rate !== outRate) chans = resample(chans, tk.clip.rate / outRate);
      const off = Math.round(tk.offsetSec * outRate);
      const g = Math.pow(10, tk.gainDb / 20);
      const len = off + (chans[0]?.length ?? 0);
      if (len > maxLen) maxLen = len;
      return { chans, off, g };
    });
    const numCh = Math.max(...prepared.map((p) => p.chans.length), 1);
    const out: Float32Array[] = [];
    for (let ch = 0; ch < numCh; ch++) out.push(new Float32Array(maxLen));
    for (const p of prepared) {
      for (let ch = 0; ch < numCh; ch++) {
        const src = p.chans[ch] ?? p.chans[0] ?? new Float32Array(0);
        const dst = out[ch];
        if (!dst) continue;
        for (let i = 0; i < src.length; i++) {
          const j = p.off + i;
          if (j >= 0 && j < dst.length) dst[j] = (dst[j] ?? 0) + (src[i] ?? 0) * p.g;
        }
      }
    }
    // soft-clip guard
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-1, Math.min(1, ch[i] ?? 0));
    const mixedName = P('mix.wav', '混音.wav');
    loadClip({ channels: out, rate: outRate, name: mixedName, bytes: 0 });
    setStatus({ ok: true, text: P('Mixed {n} track(s) into the editor.', '已混 {n} 軌落編輯器。').replace('{n}', String(active.length)) });
  }, [P, loadClip, tracks]);

  // ── append (concat current clip onto itself is meaningless; append a file) ─
  const appendFile = useCallback(async () => {
    if (!clip) return;
    if (!live) {
      if (fileInputRef.current) fileInputRef.current.dataset.mode = 'append';
      fileInputRef.current?.click();
      return;
    }
    setBusy('append');
    try {
      const filter = `Audio files|${AUDIO_EXTS.split(';').map((e) => `*.${e}`).join(';')}|All files|*.*`;
      const res = await runPowershell(
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(P('Append a file', '接駁檔案'))}'; ` +
          `$d.Filter='${psq(filter)}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const path = res.stdout.trim();
      if (!path) { setBusy(''); return; }
      const r = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psq(path)}'))`);
      const b64 = r.stdout.trim();
      if (!b64) throw new Error(P('Could not read file.', '讀唔到檔案。'));
      const other = await decodeBytes(b64ToBytes(b64), path);
      const numCh = Math.max(clip.channels.length, other.channels.length);
      let otherChans = other.channels;
      if (other.rate !== clip.rate) otherChans = resample(otherChans, other.rate / clip.rate);
      const merged: Float32Array[] = [];
      for (let ch = 0; ch < numCh; ch++) {
        const a = clip.channels[ch] ?? clip.channels[0] ?? new Float32Array(0);
        const b = otherChans[ch] ?? otherChans[0] ?? new Float32Array(0);
        const out = new Float32Array(a.length + b.length);
        out.set(a, 0); out.set(b, a.length);
        merged.push(out);
      }
      pushHistory({ ...clip, channels: merged });
      setSel(null);
      setStatus({ ok: true, text: P('Appended the file.', '已接駁檔案。') });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [P, clip, decodeBytes, live, pushHistory]);

  // handle browser file input (open / track / append)
  const onFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const mode = e.target.dataset.mode ?? 'open';
    e.target.value = '';
    e.target.dataset.mode = 'open';
    if (!file) return;
    if (mode === 'track') {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const c = await decodeBytes(buf, file.name);
        setTracks((ts) => [...ts, { id: `t${Date.now()}`, name: c.name, clip: c, gainDb: 0, mute: false, solo: false, offsetSec: 0 }]);
      } catch (err) { setStatus({ ok: false, text: String(err instanceof Error ? err.message : err) }); }
      return;
    }
    if (mode === 'append' && clip) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const other = await decodeBytes(buf, file.name);
        const numCh = Math.max(clip.channels.length, other.channels.length);
        let otherChans = other.channels;
        if (other.rate !== clip.rate) otherChans = resample(otherChans, other.rate / clip.rate);
        const merged: Float32Array[] = [];
        for (let ch = 0; ch < numCh; ch++) {
          const a = clip.channels[ch] ?? clip.channels[0] ?? new Float32Array(0);
          const b = otherChans[ch] ?? otherChans[0] ?? new Float32Array(0);
          const out = new Float32Array(a.length + b.length);
          out.set(a, 0); out.set(b, a.length);
          merged.push(out);
        }
        pushHistory({ ...clip, channels: merged });
        setStatus({ ok: true, text: P('Appended the file.', '已接駁檔案。') });
      } catch (err) { setStatus({ ok: false, text: String(err instanceof Error ? err.message : err) }); }
      return;
    }
    void onBrowserFile(file);
  }, [P, clip, decodeBytes, onBrowserFile, pushHistory]);

  // ── EXPORT ───────────────────────────────────────────────────────────────
  const [exportFmt, setExportFmt] = useState('wav');

  const exportClip = useCallback(async () => {
    if (!clip) return;
    setBusy('export');
    setStatus(null);
    try {
      const fmt = EXPORT_FORMATS.find((f) => f.ext === exportFmt) ?? EXPORT_FORMATS[0]!;
      const wav = encodeWav(clip.channels, clip.rate);
      const baseName = (clip.name.replace(/\.[^.]+$/, '') || 'audio');

      // WAV: encode in-app, no ffmpeg needed.
      if (fmt.ext === 'wav') {
        if (live) {
          const savePath = await pickSavePath(baseName, 'wav', P);
          if (!savePath) { setBusy(''); return; }
          await writeBytesToPath(savePath, wav);
          setStatus({ ok: true, text: P('Exported to {p}', '已匯出到 {p}').replace('{p}', savePath) });
        } else {
          downloadBlob(new Blob([wav as BlobPart], { type: 'audio/wav' }), `${baseName}.wav`);
          setStatus({ ok: true, text: P('Downloaded the WAV.', '已下載 WAV。') });
        }
        setBusy('');
        return;
      }

      // Other formats: transcode via ffmpeg (resolveTool).
      if (!hasFfmpeg || !engine?.ffmpeg) {
        setStatus({ ok: false, text: P('This format needs ffmpeg. Install it (winget: Gyan.FFmpeg) or export WAV.', '呢個格式要 ffmpeg。裝咗佢（winget：Gyan.FFmpeg）或改匯出 WAV。') });
        setBusy('');
        return;
      }
      if (!live) {
        setStatus({ ok: false, text: P('Transcoding runs on the desktop app; the browser can still export WAV.', '轉碼喺桌面版行；瀏覽器仍可匯出 WAV。') });
        setBusy('');
        return;
      }
      const savePath = await pickSavePath(baseName, fmt.ext, P);
      if (!savePath) { setBusy(''); return; }
      // write the WAV to a scratch file, then transcode.
      const tmp = `${await tempDir()}\\wfae_${Date.now()}.wav`;
      await writeBytesToPath(tmp, wav);
      const args = ['-y', '-i', tmp, ...fmt.codec, savePath];
      const r = await runCommand(engine.ffmpeg, args);
      // cleanup scratch
      await runPowershell(`Remove-Item -LiteralPath '${psq(tmp)}' -Force -ErrorAction SilentlyContinue`).catch(() => undefined);
      if (r.success) setStatus({ ok: true, text: P('Exported to {p}', '已匯出到 {p}').replace('{p}', savePath) });
      else setStatus({ ok: false, text: r.stderr.trim() || `ffmpeg exit ${r.code}` });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [P, clip, engine, exportFmt, hasFfmpeg, live]);

  // ── effects catalog rows ─────────────────────────────────────────────────
  const fxRows = useMemo(() => {
    const q = fxFilter.trim().toLowerCase();
    return FX.filter((f) => {
      if (fxCat !== 'all' && f.cat !== fxCat) return false;
      if (!q) return true;
      return `${f.en} ${f.zh} ${f.descEn} ${f.descZh} ${f.filter} ${f.cat}`.toLowerCase().includes(q);
    }).sort((a, b) => {
      const c = CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat);
      return c !== 0 ? c : a.en.localeCompare(b.en);
    });
  }, [fxCat, fxFilter]);

  const fxColumns: Column<Fx>[] = [
    {
      key: 'name',
      header: t('audioeditor.colEffect'),
      render: (f) => (
        <span>
          <strong>{zh ? f.zh : f.en}</strong>
          <br />
          <span className="count-note" style={{ margin: 0 }}>{zh ? f.en : f.zh}</span>
        </span>
      ),
    },
    { key: 'desc', header: t('audioeditor.colDesc'), render: (f) => <span>{zh ? f.descZh : f.descEn}</span> },
    { key: 'cat', header: t('audioeditor.colCategory'), width: 120, render: (f) => t(`audioeditor.cat.${f.cat}`) },
    {
      key: 'filter',
      header: t('audioeditor.colFilter'),
      render: (f) => (
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{f.raw ? f.filter : `-af "${f.filter}"`}</code>
      ),
    },
  ];

  const has = !!clip;
  const mono = 'Consolas, ui-monospace, monospace';

  // ── sub-tab renderers ────────────────────────────────────────────────────
  const renderSource = () => (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.wma,.aiff,.aif"
        style={{ display: 'none' }}
        onChange={onFileInput}
      />
      <div style={card}>
        <strong>{t('audioeditor.sourceLabel')}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" onClick={openFile} disabled={busy === 'open'}>
            {busy === 'open' ? t('modules.loading') : t('audioeditor.openBtn')}
          </button>
          {!recording ? (
            <button className="mini" onClick={startRecording} disabled={!canRecord}>{t('audioeditor.recordBtn')}</button>
          ) : (
            <button className="mini" onClick={stopRecording} style={{ color: 'var(--accent)' }}>{t('audioeditor.stopRecordBtn')}</button>
          )}
          {recording && <StatusDot ok label={t('audioeditor.recordingLive')} />}
        </div>
        <p className="count-note" style={{ marginTop: 8 }}>{t('audioeditor.recordHint')}</p>
        {permErr && <p className="cmd-out error" style={{ whiteSpace: 'pre-wrap' }}>{permErr}</p>}
        <p className="count-note" style={{ marginTop: 4 }}>
          {has && clip
            ? t('audioeditor.clipInfo', {
                name: clip.name,
                dur: fmtTime(dur),
                ch: clip.channels.length,
                rate: (clip.rate / 1000).toFixed(1),
                size: clip.bytes ? fmtSize(clip.bytes) : '—',
              })
            : t('audioeditor.noClip')}
        </p>
      </div>

      <div style={card}>
        <strong>{t('audioeditor.engineHeader')}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
          <StatusDot ok={hasFfmpeg} label={hasFfmpeg ? t('audioeditor.engineReady') : t('audioeditor.engineMissing')} />
          {engine?.version && <span className="count-note">{engine.version}</span>}
          <button className="mini" onClick={engineQ.reload}>⟳ {t('modules.refresh')}</button>
        </div>
        <p className="count-note" style={{ marginTop: 8 }}>{t('audioeditor.engineNote')}</p>
      </div>
    </div>
  );

  const renderWaveform = () => (
    <div style={card}>
      <div className="mod-toolbar" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
        <strong>{t('audioeditor.waveLabel')}</strong>
        <span style={{ fontFamily: mono, fontSize: 12 }}>
          {fmtTime(playhead ?? 0)} / {fmtTime(dur)}
          {selRange && (
            <span className="count-note" style={{ marginLeft: 10 }}>
              {fmtTime(selRange.a / rate)} – {fmtTime(selRange.b / rate)} ({fmtTime((selRange.b - selRange.a) / rate)})
            </span>
          )}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 180, borderRadius: 6, display: 'block', cursor: has ? 'crosshair' : 'default', touchAction: 'none' }}
        onPointerDown={onWaveDown}
        onPointerMove={onWaveMove}
        onPointerUp={onWaveUp}
      />
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" onClick={playAll} disabled={!has}>{t('audioeditor.play')}</button>
        <button className="mini" onClick={stopPlayback} disabled={!has}>{t('audioeditor.stop')}</button>
        <button className="mini" onClick={playSel} disabled={!has}>{t('audioeditor.playSel')}</button>
        <button className="mini" onClick={selectAll} disabled={!has}>{t('audioeditor.selectAll')}</button>
        <button className="mini" onClick={clearSel} disabled={!selRange}>{t('audioeditor.clearSel')}</button>
      </div>
      <div className="mod-toolbar" style={{ marginTop: 6 }}>
        <span className="count-note">{t('audioeditor.zoomLabel')}</span>
        <button className="mini" onClick={() => zoom(0.5)} disabled={!has}>＋ {t('audioeditor.zoomIn')}</button>
        <button className="mini" onClick={() => zoom(2)} disabled={!has}>－ {t('audioeditor.zoomOut')}</button>
        <button className="mini" onClick={zoomSelection} disabled={!selRange}>{t('audioeditor.zoomSel')}</button>
        <button className="mini" onClick={zoomFit} disabled={!has}>{t('audioeditor.zoomFit')}</button>
        <button className="mini" onClick={() => scroll(-1)} disabled={!has}>◀</button>
        <button className="mini" onClick={() => scroll(1)} disabled={!has}>▶</button>
      </div>
    </div>
  );

  const renderEdit = () => (
    <div>
      <div style={card}>
        <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
          <strong>{t('audioeditor.editLabel')}</strong>
          <span>
            <button className="mini" onClick={undo} disabled={histLen === 0}>↶ {t('audioeditor.undo')}</button>{' '}
            <button className="mini" onClick={redo} disabled={redoRef.current.length === 0}>↷ {t('audioeditor.redo')}</button>
          </span>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini" onClick={doCut} disabled={!selRange}>{t('audioeditor.cut')}</button>
          <button className="mini" onClick={doCopy} disabled={!selRange}>{t('audioeditor.copy')}</button>
          <button className="mini" onClick={doPaste} disabled={!has || !hasClipboard}>{t('audioeditor.paste')}</button>
          <button className="mini" onClick={doTrim} disabled={!selRange}>{t('audioeditor.trim')}</button>
          <button className="mini" onClick={doDelete} disabled={!selRange}>{t('audioeditor.delete')}</button>
          <button className="mini" onClick={doSilence} disabled={!selRange}>{t('audioeditor.silence')}</button>
        </div>
        <p className="count-note" style={{ marginTop: 8 }}>{t('audioeditor.editHint')}</p>
      </div>

      <div style={card}>
        <strong>{t('audioeditor.fadeLabel')}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
          <span className="count-note">{t('audioeditor.fadeSeconds')}</span>
          <input
            type="number" min={0.1} max={30} step={0.5} value={fadeSec}
            onChange={(e) => setFadeSec(Math.max(0.1, Math.min(30, Number(e.target.value) || 2)))}
            style={{ width: 80 }}
          />
          <button className="mini" onClick={doFadeIn} disabled={!has}>{t('audioeditor.fadeIn')}</button>
          <button className="mini" onClick={doFadeOut} disabled={!has}>{t('audioeditor.fadeOut')}</button>
          <button className="mini" onClick={doNormalize} disabled={!has}>{t('audioeditor.normalize')}</button>
          <button className="mini" onClick={doReverse} disabled={!has}>{t('audioeditor.reverse')}</button>
          <button className="mini" onClick={doMono} disabled={!has}>{t('audioeditor.toMono')}</button>
        </div>
      </div>

      <div style={card}>
        <strong>{t('audioeditor.gainLabel', { db: gainDb > 0 ? `+${gainDb}` : gainDb })}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
          <input type="range" min={-24} max={24} step={1} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} style={{ flex: 1, minWidth: 160 }} />
          <button className="mini" onClick={doGain} disabled={!has}>{t('audioeditor.applyGain')}</button>
        </div>
      </div>

      <div style={card}>
        <strong>{t('audioeditor.speedLabel', { x: speed.toFixed(2) })}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
          <input type="range" min={0.25} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ flex: 1, minWidth: 160 }} />
          <button className="mini" onClick={doSpeed} disabled={!has || busy === 'speed'}>
            {busy === 'speed' ? t('modules.loading') : t('audioeditor.applySpeed')}
          </button>
        </div>
        <strong style={{ display: 'block', marginTop: 10 }}>{t('audioeditor.pitchLabel', { st: pitch > 0 ? `+${pitch}` : pitch })}</strong>
        <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
          <input type="range" min={-12} max={12} step={1} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} style={{ flex: 1, minWidth: 160 }} />
          <button className="mini" onClick={doPitch} disabled={!has || busy === 'pitch'}>
            {busy === 'pitch' ? t('modules.loading') : t('audioeditor.applyPitch')}
          </button>
        </div>
      </div>

      {/* full effects catalog (ffmpeg reference) */}
      <h4 style={{ marginBottom: 4 }}>{t('audioeditor.fxHeader', { total: FX.length })}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>{t('audioeditor.fxBlurb')}</p>
      <div className="mod-toolbar">
        <input className="mod-search" placeholder={t('audioeditor.fxFilter')} value={fxFilter} onChange={(e) => setFxFilter(e.target.value)} />
        <select className="mini" value={fxCat} onChange={(e) => setFxCat(e.target.value as FxCat | 'all')}>
          <option value="all">{t('audioeditor.catAll')}</option>
          {CAT_ORDER.map((c) => (<option key={c} value={c}>{t(`audioeditor.cat.${c}`)}</option>))}
        </select>
        <span className="count-note">{t('audioeditor.fxCount', { shown: fxRows.length })}</span>
      </div>
      <DataTable columns={fxColumns} rows={fxRows} rowKey={(f) => f.id} />
    </div>
  );

  const renderMix = () => (
    <div>
      <div style={card}>
        <strong>{t('audioeditor.mixLabel')}</strong>
        <p className="count-note" style={{ marginTop: 4 }}>{t('audioeditor.mixHint')}</p>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini" onClick={addTrackFromClip} disabled={!has}>{t('audioeditor.addCurrentTrack')}</button>
          <button className="mini" onClick={addTrackFromFile} disabled={busy === 'track'}>{t('audioeditor.addFileTrack')}</button>
          <button className="mini primary" onClick={mixdown} disabled={tracks.length === 0}>{t('audioeditor.mixdown')}</button>
          <button className="mini" onClick={appendFile} disabled={!has || busy === 'append'}>{t('audioeditor.appendFile')}</button>
        </div>
      </div>

      {tracks.length === 0 ? (
        <p className="count-note">{t('audioeditor.noTracks')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('audioeditor.trkName')}</th>
                <th style={{ width: 90 }}>{t('audioeditor.trkDur')}</th>
                <th style={{ width: 150 }}>{t('audioeditor.trkGain')}</th>
                <th style={{ width: 120 }}>{t('audioeditor.trkOffset')}</th>
                <th style={{ width: 70 }}>{t('audioeditor.trkMute')}</th>
                <th style={{ width: 70 }}>{t('audioeditor.trkSolo')}</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {tracks.map((tk) => (
                <tr key={tk.id}>
                  <td>{tk.name}</td>
                  <td style={{ fontFamily: mono }}>{fmtTime(clipDuration(tk.clip))}</td>
                  <td>
                    <input type="range" min={-24} max={24} step={1} value={tk.gainDb}
                      onChange={(e) => updateTrack(tk.id, { gainDb: Number(e.target.value) })} style={{ width: 90 }} />
                    <span className="count-note" style={{ marginLeft: 6 }}>{tk.gainDb > 0 ? `+${tk.gainDb}` : tk.gainDb} dB</span>
                  </td>
                  <td>
                    <input type="number" min={0} step={0.1} value={tk.offsetSec}
                      onChange={(e) => updateTrack(tk.id, { offsetSec: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 70 }} /> s
                  </td>
                  <td><input type="checkbox" checked={tk.mute} onChange={(e) => updateTrack(tk.id, { mute: e.target.checked })} /></td>
                  <td><input type="checkbox" checked={tk.solo} onChange={(e) => updateTrack(tk.id, { solo: e.target.checked })} /></td>
                  <td><button className="mini" onClick={() => removeTrack(tk.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderExport = () => (
    <div style={card}>
      <strong>{t('audioeditor.exportLabel')}</strong>
      <p className="count-note" style={{ marginTop: 4 }}>{t('audioeditor.exportHint')}</p>
      <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
        <span className="count-note">{t('audioeditor.format')}</span>
        <select className="mini" value={exportFmt} onChange={(e) => setExportFmt(e.target.value)}>
          {EXPORT_FORMATS.map((f) => (
            <option key={f.ext} value={f.ext} disabled={f.ext !== 'wav' && !hasFfmpeg}>
              {(zh ? f.zh : f.en)}{f.ext !== 'wav' && !hasFfmpeg ? ` — ${t('audioeditor.needsFfmpeg')}` : ''}
            </option>
          ))}
        </select>
        <button className="mini primary" onClick={exportClip} disabled={!has || busy === 'export'}>
          {busy === 'export' ? t('modules.loading') : t('audioeditor.exportBtn')}
        </button>
        <button className="mini" onClick={revert} disabled={!originalRef.current}>{t('audioeditor.revert')}</button>
      </div>
      {!hasFfmpeg && (
        <p className="count-note" style={{ marginTop: 8 }}>{t('audioeditor.transcodeNote')}</p>
      )}
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('audioeditor.blurb2')}</p>
      {!live && <p className="count-note" style={{ marginTop: 0 }}>{t('audioeditor.previewNote')}</p>}

      {status && (
        <p className={status.ok ? 'count-note' : 'cmd-out error'} style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>
          {status.ok ? '✓ ' : '✗ '}{status.text}
        </p>
      )}

      <ModuleTabs
        tabs={[
          { id: 'source', en: 'Source', zh: '來源', render: renderSource },
          { id: 'waveform', en: 'Waveform', zh: '波形', render: renderWaveform },
          { id: 'edit', en: 'Edit & effects', zh: '編輯與效果', render: renderEdit },
          { id: 'mix', en: 'Mix', zh: '混音', render: renderMix },
          { id: 'export', en: 'Export', zh: '匯出', render: renderExport },
        ]}
      />
    </div>
  );
}

// ── desktop save helpers (module-scope; keep the component lean) ────────────
async function pickSavePath(baseName: string, ext: string, P: (en: string, yue: string) => string): Promise<string | null> {
  const res = await runPowershell(
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d=New-Object System.Windows.Forms.SaveFileDialog; $d.Title='${psq(P('Export audio', '匯出音訊'))}'; ` +
      `$d.FileName='${psq(baseName)}.${ext}'; $d.Filter='${psq(ext.toUpperCase())} (*.${ext})|*.${ext}|All files|*.*'; ` +
      `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
  );
  const p = res.stdout.trim();
  return p || null;
}

async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  const b64 = bytesToB64(bytes);
  const r = await runPowershell(
    `[IO.File]::WriteAllBytes('${psq(path)}', [Convert]::FromBase64String('${b64}')); 'OK'`,
  );
  if (!r.success && !r.stdout.includes('OK')) throw new Error(r.stderr.trim() || 'write failed');
}

async function tempDir(): Promise<string> {
  const r = await runPowershell(`[System.IO.Path]::GetTempPath().TrimEnd('\\')`);
  return r.stdout.trim() || 'C:\\Windows\\Temp';
}

function downloadBlob(blob: Blob, name: string): void {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
