import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getEnv, isTauri, listDir, runCommand } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ---- Media file extensions WinForge treats as media (from MediaModule.xaml.cs MediaExts) ----
const MEDIA_EXTS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv',
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus',
]);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv']);

// ---- Folders to scan (user's known media folders) ----
const SCAN_FOLDERS: { key: string; env: string; sub?: string }[] = [
  { key: 'videos', env: 'USERPROFILE', sub: 'Videos' },
  { key: 'music', env: 'USERPROFILE', sub: 'Music' },
  { key: 'pictures', env: 'USERPROFILE', sub: 'Pictures' },
  { key: 'downloads', env: 'USERPROFILE', sub: 'Downloads' },
  { key: 'desktop', env: 'USERPROFILE', sub: 'Desktop' },
];

interface MediaFile {
  name: string;
  path: string;
  folder: string;
  ext: string;
  size: number;
  isVideo: boolean;
}

interface Engine {
  ffmpegPath: string;
  ffmpegVersion: string;
  ffprobePath: string;
  installed: boolean;
}

// ---- Quick conversions (from MediaModule.xaml.cs BuildQuickOps) ----
interface Recipe {
  id: string;
  en: string;
  zh: string;
  suffix: string;
  args: string;
}
const QUICK_OPS: Recipe[] = [
  { id: 'q.mp4', en: 'To MP4', zh: '轉 MP4', suffix: '.converted.mp4', args: '-i {in} -c:v libx264 -c:a aac -movflags +faststart {out}' },
  { id: 'q.webm', en: 'To WebM', zh: '轉 WebM', suffix: '.webm', args: '-i {in} -c:v libvpx-vp9 -b:v 0 -crf 32 -c:a libopus {out}' },
  { id: 'q.mkv', en: 'To MKV', zh: '轉 MKV', suffix: '.mkv', args: '-i {in} -c copy {out}' },
  { id: 'q.mp3', en: 'Extract MP3', zh: '抽 MP3', suffix: '.mp3', args: '-i {in} -vn -c:a libmp3lame -q:a 2 {out}' },
  { id: 'q.wav', en: 'Extract WAV', zh: '抽 WAV', suffix: '.wav', args: '-i {in} -vn -c:a pcm_s16le {out}' },
  { id: 'q.gif', en: 'GIF', zh: 'GIF', suffix: '.gif', args: '-i {in} -vf "fps=12,scale=480:-1:flags=lanczos" {out}' },
  { id: 'q.compress', en: 'Compress', zh: '壓細', suffix: '.compressed.mp4', args: '-i {in} -c:v libx264 -crf 28 -c:a aac {out}' },
  { id: 'q.mute', en: 'Mute', zh: '靜音', suffix: '.muted.mp4', args: '-i {in} -c:v copy -an {out}' },
  { id: 'q.norm', en: 'Normalize audio', zh: '正規化音量', suffix: '.norm.mp4', args: '-i {in} -af loudnorm -c:v copy {out}' },
];

// ---- Advanced operations catalog (from Catalog/MediaOperations.cs — 60 real ffmpeg/ffprobe ops) ----
interface Op {
  id: string;
  cat: string;
  en: string;
  zh: string;
  args: string;
  probe?: boolean;
}
const OPS: Op[] = [
  // video
  { id: 'media.video.to-mp4-h264', cat: 'video', en: 'Convert to MP4 (H.264)', zh: '轉做 MP4 (H.264)', args: '-i {in} -c:v libx264 -c:a aac -movflags +faststart {out}' },
  { id: 'media.video.to-mp4-h265', cat: 'video', en: 'Convert to MP4 (H.265/HEVC)', zh: '轉做 MP4 (H.265/HEVC)', args: '-i {in} -c:v libx265 -c:a aac -tag:v hvc1 -movflags +faststart {out}' },
  { id: 'media.video.to-webm-vp9', cat: 'video', en: 'Convert to WebM (VP9)', zh: '轉做 WebM (VP9)', args: '-i {in} -c:v libvpx-vp9 -b:v 0 -crf 31 -c:a libopus {out}' },
  { id: 'media.video.to-mkv', cat: 'video', en: 'Convert to MKV', zh: '轉做 MKV', args: '-i {in} -c:v libx264 -c:a aac {out}' },
  { id: 'media.video.to-mov', cat: 'video', en: 'Convert to MOV', zh: '轉做 MOV', args: '-i {in} -c:v libx264 -c:a aac -movflags +faststart {out}' },
  { id: 'media.video.to-avi', cat: 'video', en: 'Convert to AVI', zh: '轉做 AVI', args: '-i {in} -c:v mpeg4 -qscale:v 4 -c:a libmp3lame -q:a 4 {out}' },
  { id: 'media.video.remux-copy-mp4', cat: 'video', en: 'Remux to MP4 (copy streams)', zh: '重新封裝做 MP4 (複製串流)', args: '-i {in} -c copy -movflags +faststart {out}' },
  { id: 'media.video.faststart-web', cat: 'video', en: 'Optimise for web (faststart)', zh: '為網頁優化 (faststart)', args: '-i {in} -c copy -movflags +faststart {out}' },
  { id: 'media.video.set-crf-23', cat: 'video', en: 'Set quality (CRF 23)', zh: '設定畫質 (CRF 23)', args: '-i {in} -c:v libx264 -crf 23 -c:a aac {out}' },
  { id: 'media.video.set-bitrate-2m', cat: 'video', en: 'Set video bitrate (2 Mbps)', zh: '設定影片位元率 (2 Mbps)', args: '-i {in} -c:v libx264 -b:v 2M -c:a aac {out}' },
  { id: 'media.video.constant-fps-30', cat: 'video', en: 'Force constant 30 fps', zh: '強制固定 30 fps', args: '-i {in} -r 30 -c:v libx264 -c:a aac {out}' },
  { id: 'media.video.downscale-720p', cat: 'video', en: 'Downscale to 720p', zh: '縮放做 720p', args: '-i {in} -vf scale=-2:720 -c:v libx264 -crf 23 -c:a aac {out}' },
  // audio
  { id: 'media.audio.extract-mp3', cat: 'audio', en: 'Extract audio (MP3)', zh: '抽出聲音 (MP3)', args: '-i {in} -vn -c:a libmp3lame -q:a 2 {out}' },
  { id: 'media.audio.extract-aac', cat: 'audio', en: 'Extract audio (AAC)', zh: '抽出聲音 (AAC)', args: '-i {in} -vn -c:a aac {out}' },
  { id: 'media.audio.extract-wav', cat: 'audio', en: 'Extract audio (WAV)', zh: '抽出聲音 (WAV)', args: '-i {in} -vn -c:a pcm_s16le {out}' },
  { id: 'media.audio.extract-flac', cat: 'audio', en: 'Extract audio (FLAC)', zh: '抽出聲音 (FLAC)', args: '-i {in} -vn -c:a flac {out}' },
  { id: 'media.audio.extract-opus', cat: 'audio', en: 'Extract audio (Opus)', zh: '抽出聲音 (Opus)', args: '-i {in} -vn -c:a libopus {out}' },
  { id: 'media.audio.extract-ogg', cat: 'audio', en: 'Extract audio (OGG Vorbis)', zh: '抽出聲音 (OGG Vorbis)', args: '-i {in} -vn -c:a libvorbis {out}' },
  { id: 'media.audio.set-bitrate-192k', cat: 'audio', en: 'Set audio bitrate (192k)', zh: '設定音訊位元率 (192k)', args: '-i {in} -c:v copy -c:a aac -b:a 192k {out}' },
  { id: 'media.audio.to-mono', cat: 'audio', en: 'Convert to mono', zh: '轉做單聲道', args: '-i {in} -c:v copy -ac 1 {out}' },
  { id: 'media.audio.sample-rate-44100', cat: 'audio', en: 'Set sample rate (44.1 kHz)', zh: '設定取樣率 (44.1 kHz)', args: '-i {in} -c:v copy -ar 44100 {out}' },
  { id: 'media.audio.normalize-loudness', cat: 'audio', en: 'Normalize loudness', zh: '正規化響度', args: '-i {in} -af loudnorm {out}' },
  { id: 'media.audio.volume-up', cat: 'audio', en: 'Change volume (+50%)', zh: '調整音量 (+50%)', args: '-i {in} -af volume=1.5 {out}' },
  { id: 'media.audio.remove', cat: 'audio', en: 'Remove audio (mute)', zh: '移除聲音 (靜音)', args: '-i {in} -c:v copy -an {out}' },
  // edit
  { id: 'media.trim-first-30s', cat: 'edit', en: 'Trim first 30 seconds', zh: '剪頭 30 秒', args: '-i {in} -t 30 -c copy {out}' },
  { id: 'media.start-at-10s', cat: 'edit', en: 'Start at 10 seconds', zh: '由 10 秒開始', args: '-ss 10 -i {in} -c copy {out}' },
  { id: 'media.cut-range', cat: 'edit', en: 'Cut range (5s–15s)', zh: '截取片段 (5 至 15 秒)', args: '-ss 00:00:05 -to 00:00:15 -i {in} -c copy {out}' },
  { id: 'media.scale-1080p', cat: 'edit', en: 'Scale to 1080p', zh: '縮放到 1080p', args: '-i {in} -vf scale=-2:1080 -c:a copy {out}' },
  { id: 'media.scale-720p', cat: 'edit', en: 'Scale to 720p', zh: '縮放到 720p', args: '-i {in} -vf scale=-2:720 -c:a copy {out}' },
  { id: 'media.scale-480p', cat: 'edit', en: 'Scale to 480p', zh: '縮放到 480p', args: '-i {in} -vf scale=-2:480 -c:a copy {out}' },
  { id: 'media.crop-center', cat: 'edit', en: 'Crop center square', zh: '中央裁剪做正方形', args: '-i {in} -vf crop=min(iw\\,ih):min(iw\\,ih) -c:a copy {out}' },
  { id: 'media.rotate-90-cw', cat: 'edit', en: 'Rotate 90° clockwise', zh: '順時針轉 90 度', args: '-i {in} -vf transpose=1 -c:a copy {out}' },
  { id: 'media.rotate-90-ccw', cat: 'edit', en: 'Rotate 90° counter-clockwise', zh: '逆時針轉 90 度', args: '-i {in} -vf transpose=2 -c:a copy {out}' },
  { id: 'media.hflip', cat: 'edit', en: 'Flip horizontally', zh: '水平翻轉', args: '-i {in} -vf hflip -c:a copy {out}' },
  { id: 'media.speed-2x', cat: 'edit', en: 'Speed up 2×', zh: '加速 2 倍', args: '-i {in} -vf setpts=0.5*PTS -af atempo=2.0 {out}' },
  { id: 'media.fps-30', cat: 'edit', en: 'Change frame rate to 30', zh: '改幀率做 30', args: '-i {in} -r 30 -c:a copy {out}' },
  // imagegif
  { id: 'media.gif-make', cat: 'gif', en: 'Make GIF', zh: '整 GIF 動圖', args: '-i {in} -vf "fps=12,scale=480:-1:flags=lanczos" {out}' },
  { id: 'media.gif-hq-palette', cat: 'gif', en: 'High-quality GIF (palette)', zh: '高質 GIF (調色板)', args: '-i {in} -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" {out}' },
  { id: 'media.frame-at-5s', cat: 'gif', en: 'Frame at 5 seconds', zh: '第 5 秒嘅一格', args: '-ss 5 -i {in} -frames:v 1 {out}' },
  { id: 'media.thumbnail', cat: 'gif', en: 'Extract thumbnail', zh: '抽出縮圖', args: '-i {in} -vf "thumbnail" -frames:v 1 {out}' },
  { id: 'media.frames-every-1s', cat: 'gif', en: 'Frames every 1 second', zh: '每 1 秒一格', args: '-i {in} -vf fps=1 {out}' },
  { id: 'media.to-webp', cat: 'gif', en: 'Convert to WebP', zh: '轉做 WebP', args: '-i {in} -c:v libwebp -frames:v 1 {out}' },
  { id: 'media.to-animated-webp', cat: 'gif', en: 'Convert to animated WebP', zh: '轉做動態 WebP', args: '-i {in} -vf "fps=15,scale=480:-1:flags=lanczos" -c:v libwebp -loop 0 {out}' },
  { id: 'media.contact-sheet', cat: 'gif', en: 'Contact sheet', zh: '縮圖總表', args: '-i {in} -vf "select=not(mod(n\\,300)),scale=240:-1,tile=4x4" -frames:v 1 {out}' },
  { id: 'media.first-frame', cat: 'gif', en: 'Grab first frame', zh: '抽出第一格', args: '-i {in} -frames:v 1 {out}' },
  { id: 'media.poster', cat: 'gif', en: 'Poster image', zh: '海報圖', args: '-ss 1 -i {in} -frames:v 1 -q:v 2 {out}' },
  { id: 'media.frame-at-10s', cat: 'gif', en: 'Frame at 10 seconds', zh: '第 10 秒一格', args: '-ss 10 -i {in} -frames:v 1 {out}' },
  { id: 'media.gif-small', cat: 'gif', en: 'Make small GIF', zh: '整細 GIF', args: '-i {in} -vf "fps=10,scale=320:-1:flags=lanczos" {out}' },
  // filters
  { id: 'media.denoise', cat: 'filter', en: 'Denoise video', zh: '影片降噪', args: '-i {in} -vf hqdn3d {out}' },
  { id: 'media.sharpen', cat: 'filter', en: 'Sharpen video', zh: '影片銳化', args: '-i {in} -vf unsharp {out}' },
  { id: 'media.fade-in', cat: 'filter', en: 'Fade in', zh: '淡入', args: '-i {in} -vf "fade=t=in:st=0:d=1" {out}' },
  { id: 'media.fade-out', cat: 'filter', en: 'Fade out (3s mark)', zh: '淡出 (第3秒)', args: '-i {in} -vf "fade=t=out:st=3:d=1" {out}' },
  { id: 'media.brightness-contrast', cat: 'filter', en: 'Brightness & contrast', zh: '光暗同對比度', args: '-i {in} -vf eq=brightness=0.1:contrast=1.2 {out}' },
  { id: 'media.grayscale', cat: 'filter', en: 'Convert to grayscale', zh: '轉做黑白', args: '-i {in} -vf hue=s=0 {out}' },
  { id: 'media.deshake', cat: 'filter', en: 'Stabilize (deshake)', zh: '防震穩定', args: '-i {in} -vf deshake {out}' },
  { id: 'media.show-format', cat: 'inspect', en: 'Show format info', zh: '顯示格式資訊', args: '-hide_banner -show_format -i {in}', probe: true },
  { id: 'media.show-streams', cat: 'inspect', en: 'Show stream info', zh: '顯示串流資訊', args: '-hide_banner -show_streams -i {in}', probe: true },
  { id: 'media.duration', cat: 'inspect', en: 'Show duration', zh: '顯示時長', args: '-v error -show_entries format=duration -of default=nw=1 -i {in}', probe: true },
  { id: 'media.resolution', cat: 'inspect', en: 'Show resolution', zh: '顯示解析度', args: '-v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 -i {in}', probe: true },
  { id: 'media.video-codec', cat: 'inspect', en: 'Show video codec', zh: '顯示影片編碼', args: '-v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1 -i {in}', probe: true },
  { id: 'media.audio-codec', cat: 'inspect', en: 'Show audio codec', zh: '顯示聲音編碼', args: '-v error -select_streams a:0 -show_entries stream=codec_name -of default=nw=1 -i {in}', probe: true },
];

const CATS = ['all', 'video', 'audio', 'edit', 'gif', 'filter', 'inspect'] as const;

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}
function fmtSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Split a full ffmpeg/ffprobe args template into an argv array, substituting the input path.
function buildArgv(argsTemplate: string, input: string): string[] {
  // Tokenize respecting double-quoted filter graphs, then swap {in}/{out} placeholders.
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsTemplate)) !== null) {
    const tok = m[1] !== undefined ? m[1] : (m[2] ?? '');
    if (tok === '{in}') out.push(input);
    else out.push(tok);
  }
  return out;
}

async function loadEngine(): Promise<Engine> {
  if (!isTauri()) {
    return { ffmpegPath: '', ffmpegVersion: '', ffprobePath: '', installed: false };
  }
  const find = async (exe: string): Promise<string> => {
    const r = await runCommand('where', [exe]).catch(() => null);
    if (r && r.success) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first ?? '';
    }
    return '';
  };
  const ffmpegPath = await find('ffmpeg.exe');
  const ffprobePath = await find('ffprobe.exe');
  let ffmpegVersion = '';
  if (ffmpegPath) {
    const v = await runCommand('ffmpeg', ['-hide_banner', '-version']).catch(() => null);
    if (v && v.stdout) ffmpegVersion = (v.stdout.split(/\r?\n/)[0] ?? '').trim();
  }
  return { ffmpegPath, ffmpegVersion, ffprobePath, installed: Boolean(ffmpegPath) };
}

async function scanMedia(): Promise<MediaFile[]> {
  if (!isTauri()) return [];
  const home = await getEnv('USERPROFILE').catch(() => '');
  if (!home) return [];
  const files: MediaFile[] = [];
  const seen = new Set<string>();
  for (const f of SCAN_FOLDERS) {
    const dir = f.sub ? `${home}\\${f.sub}` : home;
    const entries = await listDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.is_dir) continue;
      const ext = extOf(e.name);
      if (!MEDIA_EXTS.has(ext)) continue;
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      files.push({
        name: e.name,
        path: e.path,
        folder: f.key,
        ext,
        size: e.size,
        isVideo: VIDEO_EXTS.has(ext),
      });
    }
  }
  files.sort((a, b) => b.size - a.size);
  return files;
}

// ---- Split a path into { dir, base (no ext), ext } for deriving sibling outputs. ----
function splitPath(p: string): { dir: string; base: string; ext: string } {
  const norm = p.replace(/\//g, '\\');
  const slash = norm.lastIndexOf('\\');
  const dir = slash < 0 ? '' : norm.slice(0, slash);
  const file = slash < 0 ? norm : norm.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot < 0 ? file : file.slice(0, dot);
  const ext = dot < 0 ? '' : file.slice(dot);
  return { dir, base, ext };
}
// Derive an output path beside the input (mirrors MediaModule.xaml.cs DeriveBeside).
function deriveBeside(input: string, suffixWithExt: string): string {
  const { dir, base } = splitPath(input);
  const name = base + suffixWithExt;
  return dir ? `${dir}\\${name}` : name;
}

export function MediaModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const pick = (en: string, z: string) => (zh ? z : en);

  const engine = useAsync(loadEngine, []);
  const media = useAsync(scanMedia, []);

  const [filter, setFilter] = useState('');
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [cat, setCat] = useState<(typeof CATS)[number]>('all');
  const [opFilter, setOpFilter] = useState('');
  const [selected, setSelected] = useState<MediaFile | null>(null);
  const [probeOut, setProbeOut] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [runOut, setRunOut] = useState<string | null>(null);
  const [busyOp, setBusyOp] = useState<string | null>(null);

  // ---- Explicit Input / Output paths (mirrors the C# Open… / Save as… pickers + AppState) ----
  const [inputPath, setInputPath] = useState('');
  const [outputPath, setOutputPath] = useState('');
  // ---- Trim panel (start + length, HH:MM:SS) ----
  const [trimStart, setTrimStart] = useState('');
  const [trimDuration, setTrimDuration] = useState('');
  // ---- GIF / frame panel (fps · width) ----
  const [gifFps, setGifFps] = useState(12);
  const [gifWidth, setGifWidth] = useState(480);

  const eng = engine.data;
  const installed = eng?.installed ?? false;

  // The active input is the typed path if set, otherwise the selected library row.
  const activeInput = inputPath.trim() || selected?.path || '';

  const files = useMemo(() => {
    const all = media.data ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter(
      (f) =>
        (folderFilter === 'all' || f.folder === folderFilter) &&
        (!q || f.name.toLowerCase().includes(q)),
    );
  }, [media.data, filter, folderFilter]);

  const folderCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of media.data ?? []) c[f.folder] = (c[f.folder] ?? 0) + 1;
    return c;
  }, [media.data]);

  const ops = useMemo(() => {
    const q = opFilter.trim().toLowerCase();
    return OPS.filter(
      (o) =>
        (cat === 'all' || o.cat === cat) &&
        (!q || `${o.en} ${o.zh} ${o.id} ${o.args}`.toLowerCase().includes(q)),
    );
  }, [cat, opFilter]);

  // ---- Probe a path with ffprobe (read-only). Shared by inspect + Input picker. ----
  const probePath = async (path: string) => {
    setProbeOut(null);
    setRunOut(null);
    if (!path) return;
    if (!installed || !eng?.ffprobePath) {
      setProbeOut(pick('ffprobe not found — install ffmpeg to inspect files.', '搵唔到 ffprobe — 裝咗 ffmpeg 先可以檢視。'));
      return;
    }
    setProbing(true);
    try {
      const args = [
        '-v', 'error', '-hide_banner',
        '-show_entries',
        'format=duration,size,bit_rate,format_long_name:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate',
        '-of', 'default=noprint_wrappers=0', path,
      ];
      const r = await runCommand('ffprobe', args);
      const text = (r.stdout || r.stderr || '').trim();
      setProbeOut(text || pick('No info available.', '冇資訊。'));
    } catch (e) {
      setProbeOut(String(e));
    } finally {
      setProbing(false);
    }
  };

  // ---- Inspect selected library file with ffprobe (read-only). Also sets it as the input. ----
  const inspect = async (f: MediaFile) => {
    setSelected(f);
    setInputPath(f.path);
    await probePath(f.path);
  };

  // ---- Set the explicit input path (mirrors PickInput_Click → auto-probe on select). ----
  const useAsInput = async () => {
    const p = inputPath.trim();
    if (!p) return;
    setSelected(null);
    await probePath(p);
  };

  // ---- Shared ffmpeg encode runner: derives output, confirms, writes a new file beside input. ----
  // outPath: explicit output (from Output picker) wins; else derived beside input via suffixOrExt.
  const runEncode = async (opts: {
    busyId: string;
    label: string;
    argsTemplate: string; // contains {in} and {out}
    suffixOrExt: string; // e.g. '.trimmed.mp4' or '.gif' — used when no explicit output set
  }) => {
    const input = activeInput;
    if (!input) {
      setRunOut(pick('Pick an input file first.', '請先揀輸入檔。'));
      return;
    }
    if (!installed) {
      setRunOut(pick('ffmpeg not found.', '搵唔到 ffmpeg。'));
      return;
    }
    const outPath = outputPath.trim() || deriveBeside(input, opts.suffixOrExt);
    const cmdPreview = `ffmpeg -y ${opts.argsTemplate.replace('{in}', `"${input}"`).replace('{out}', `"${outPath}"`)}`;
    const ok = window.confirm(
      `${opts.label}\n\n${pick('This writes a new file:', '呢個會寫一個新檔：')}\n${outPath}\n\n${cmdPreview}\n\n${pick('Proceed?', '繼續？')}`,
    );
    if (!ok) return;

    setBusyOp(opts.busyId);
    setRunOut(pick('Running ffmpeg…', '執行緊 ffmpeg…'));
    try {
      const argv = ['-y', ...buildArgv(opts.argsTemplate.replace('{out}', outPath), input)];
      const r = await runCommand('ffmpeg', argv);
      const tail = (r.stderr || r.stdout || '').trim().slice(-3000);
      const head = r.success ? pick('✓ Done', '✓ 完成') : pick('✗ Failed', '✗ 失敗');
      setRunOut(`${head} → ${outPath}\n\n${tail}`);
      media.reload();
    } catch (e) {
      setRunOut(String(e));
    } finally {
      setBusyOp(null);
    }
  };

  // ---- Run an ffmpeg/ffprobe op on the active input (probe ops run freely; encode ops confirm) ----
  const runOp = async (o: Op) => {
    const input = activeInput;
    if (!input) {
      setRunOut(pick('Pick a file first (click a row or set an input path).', '請先揀個檔（撳一行或者填輸入路徑）。'));
      return;
    }
    if (!installed) {
      setRunOut(pick('ffmpeg not found.', '搵唔到 ffmpeg。'));
      return;
    }

    if (o.probe) {
      setBusyOp(o.id);
      setRunOut(pick('Running ffprobe…', '執行緊 ffprobe…'));
      try {
        const argv = buildArgv(o.args, input);
        const r = await runCommand('ffprobe', argv);
        const text = (r.stdout || r.stderr || '').trim();
        setRunOut(`${pick(o.en, o.zh)}\n${text || pick('(no output)', '（冇輸出）')}`);
      } catch (e) {
        setRunOut(String(e));
      } finally {
        setBusyOp(null);
      }
      return;
    }

    await runEncode({
      busyId: o.id,
      label: pick(o.en, o.zh),
      argsTemplate: o.args,
      suffixOrExt: guessOutExt(o),
    });
  };

  // ---- Trim: start + length (HH:MM:SS). Copy = no re-encode, Encode = H.264/AAC. ----
  const start = () => (trimStart.trim() || '00:00:00');
  const dur = () => (trimDuration.trim() || '00:00:10');

  const trimCopy = () =>
    runEncode({
      busyId: 'trim.copy',
      label: pick('Trim (no re-encode)', '剪裁（唔重編碼）'),
      argsTemplate: `-ss ${start()} -i {in} -t ${dur()} -c copy {out}`,
      suffixOrExt: `.trimmed${splitPath(activeInput).ext || '.mp4'}`,
    });

  const trimEncode = () =>
    runEncode({
      busyId: 'trim.encode',
      label: pick('Trim (re-encode)', '剪裁（重編碼）'),
      argsTemplate: `-ss ${start()} -i {in} -t ${dur()} -c:v libx264 -c:a aac -movflags +faststart {out}`,
      suffixOrExt: '.trimmed.mp4',
    });

  // ---- GIF / frame with the fps · width controls. ----
  const makeGif = () =>
    runEncode({
      busyId: 'gif.make',
      label: pick('Make GIF', '整 GIF'),
      argsTemplate: `-i {in} -vf "fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos" {out}`,
      suffixOrExt: '.gif',
    });

  const grabFrame = () =>
    runEncode({
      busyId: 'frame.grab',
      label: pick('Grab frame', '擷取畫格'),
      argsTemplate: `-ss ${start()} -i {in} -frames:v 1 {out}`,
      suffixOrExt: '.frame.png',
    });

  const fileColumns: Column<MediaFile>[] = [
    {
      key: 'kind',
      header: t('media.kind'),
      width: 64,
      render: (f) => (
        <span className="status-dot on" title={f.isVideo ? t('media.video') : t('media.audio')}>
          <span className="dot" />
          {f.isVideo ? t('media.video') : t('media.audio')}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('media.file'),
      render: (f) => (
        <span title={f.path}>{f.name}</span>
      ),
    },
    { key: 'folder', header: t('media.folderCol'), width: 100, render: (f) => t(`media.folder.${f.folder}`) },
    { key: 'ext', header: t('media.type'), width: 70, render: (f) => f.ext.replace('.', '').toUpperCase() },
    { key: 'size', header: t('media.size'), width: 90, align: 'right', render: (f) => fmtSize(f.size) },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (f) => (
        <button className="mini primary" disabled={probing && selected?.path === f.path} onClick={() => inspect(f)}>
          {t('media.inspect')}
        </button>
      ),
    },
  ];

  const totalBytes = (media.data ?? []).reduce((s, f) => s + f.size, 0);

  return (
    <div className="mod">
      {/* Engine status */}
      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <AsyncState loading={engine.loading} error={engine.error}>
          <StatusDot ok={installed} label={installed ? t('media.engineOk') : t('media.engineMissing')} />
          {installed && eng?.ffmpegVersion && (
            <span className="count-note">{eng.ffmpegVersion}</span>
          )}
          <StatusDot ok={Boolean(eng?.ffprobePath)} label={eng?.ffprobePath ? t('media.probeOk') : t('media.probeMissing')} />
        </AsyncState>
        <button className="mini" onClick={() => { engine.reload(); }}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>{t('media.blurb')}</p>
      {!installed && !engine.loading && (
        <p className="count-note">{t('media.installHint')}</p>
      )}
      {!isTauri() && <p className="count-note">{t('media.webNote')}</p>}

      {/* Library */}
      <h3 style={{ marginBottom: 4 }}>{t('media.library')}</h3>
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('media.filterFiles')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="mini" value={folderFilter} onChange={(e) => setFolderFilter(e.target.value)}>
          <option value="all">{t('media.allFolders')}</option>
          {SCAN_FOLDERS.map((f) => (
            <option key={f.key} value={f.key}>
              {t(`media.folder.${f.key}`)} ({folderCounts[f.key] ?? 0})
            </option>
          ))}
        </select>
        <button className="mini" onClick={() => media.reload()}>
          ⟳ {t('media.rescan')}
        </button>
        <span className="count-note">
          {t('media.fileCount', { files: files.length })} · {fmtSize(totalBytes)}
        </span>
      </ModuleToolbar>

      <AsyncState loading={media.loading} error={media.error}>
        <DataTable
          columns={fileColumns}
          rows={files}
          rowKey={(f) => f.path}
          empty={isTauri() ? t('media.noFiles') : t('media.webEmpty')}
        />
      </AsyncState>

      {/* Explicit Input / Output paths (mirrors the C# Open… / Save as… pickers) */}
      <div className="hosts-edit" style={{ marginTop: 12 }}>
        <p style={{ fontWeight: 600, margin: '0 0 8px' }}>{t('media.files')}</p>
        <div className="mod-toolbar" style={{ alignItems: 'center' }}>
          <span className="count-note" style={{ minWidth: 60 }}>{t('media.inputCap')}</span>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('media.inputPh')}
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
          />
          <button className="mini primary" disabled={!inputPath.trim() || probing} onClick={useAsInput}>
            {t('media.useInput')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ alignItems: 'center', marginTop: 6 }}>
          <span className="count-note" style={{ minWidth: 60 }}>{t('media.outputCap')}</span>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('media.outputPh')}
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          {outputPath.trim() && (
            <button className="mini" onClick={() => setOutputPath('')}>{t('media.clearOutput')}</button>
          )}
        </div>
        <p className="count-note" style={{ margin: '6px 0 0' }}>
          {activeInput ? `${t('media.active')}: ${activeInput}` : t('media.noActive')}
        </p>
        {probing ? (
          <p className="count-note" style={{ marginBottom: 0 }}>{t('modules.loading')}</p>
        ) : (
          probeOut && <pre className="cmd-out" style={{ marginBottom: 0 }}>{probeOut}</pre>
        )}
      </div>

      {/* Trim + GIF / frame panels (mirror the C# Trim + GIF/frame chrome-free sections) */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 16, marginTop: 12, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 260 }}>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('media.trimLabel')}</p>
          <div className="mod-toolbar">
            <input
              className="mod-search"
              style={{ width: 110 }}
              placeholder="00:00:00"
              value={trimStart}
              onChange={(e) => setTrimStart(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ width: 110 }}
              placeholder="00:00:10"
              value={trimDuration}
              onChange={(e) => setTrimDuration(e.target.value)}
            />
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini" disabled={!activeInput || busyOp === 'trim.copy'} onClick={trimCopy}>
              {t('media.trimCopy')}
            </button>
            <button className="mini" disabled={!activeInput || busyOp === 'trim.encode'} onClick={trimEncode}>
              {t('media.trimEncode')}
            </button>
          </div>
        </div>

        <div style={{ minWidth: 260 }}>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>{t('media.gifLabel')}</p>
          <div className="mod-toolbar" style={{ alignItems: 'center' }}>
            <label className="count-note">
              {t('media.gifFps')}{' '}
              <input
                className="mod-search"
                type="number"
                min={1}
                max={60}
                style={{ width: 70 }}
                value={gifFps}
                onChange={(e) => setGifFps(Math.max(1, Math.min(60, Number(e.target.value) || 12)))}
              />
            </label>
            <label className="count-note">
              {t('media.gifWidth')}{' '}
              <input
                className="mod-search"
                type="number"
                min={80}
                max={3840}
                style={{ width: 80 }}
                value={gifWidth}
                onChange={(e) => setGifWidth(Math.max(80, Math.min(3840, Number(e.target.value) || 480)))}
              />
            </label>
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini" disabled={!activeInput || busyOp === 'gif.make'} onClick={makeGif}>
              {t('media.makeGif')}
            </button>
            <button className="mini" disabled={!activeInput || busyOp === 'frame.grab'} onClick={grabFrame}>
              {t('media.grabFrame')}
            </button>
          </div>
        </div>
      </div>

      {/* Operations catalog */}
      <h3 style={{ marginBottom: 4, marginTop: 16 }}>{t('media.operations', { ops: OPS.length })}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>{t('media.opsHint')}</p>

      {/* Quick conversions */}
      <p style={{ fontWeight: 600, margin: '8px 0 4px' }}>{t('media.quick')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {QUICK_OPS.map((q) => {
          const op: Op = { id: q.id, cat: 'quick', en: q.en, zh: q.zh, args: q.args };
          return (
            <button
              key={q.id}
              className="mini"
              disabled={!activeInput || busyOp === q.id}
              onClick={() => runOp({ ...op, id: q.id })}
              title={q.args}
            >
              {pick(q.en, q.zh)}
            </button>
          );
        })}
      </div>

      {/* Advanced ops */}
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('media.filterOps')}
          value={opFilter}
          onChange={(e) => setOpFilter(e.target.value)}
        />
        <select className="mini" value={cat} onChange={(e) => setCat(e.target.value as (typeof CATS)[number])}>
          {CATS.map((c) => (
            <option key={c} value={c}>
              {t(`media.cat.${c}`)}
            </option>
          ))}
        </select>
        <span className="count-note">{t('media.opCount', { ops: ops.length })}</span>
      </ModuleToolbar>

      <DataTable
        columns={[
          {
            key: 'cat',
            header: t('media.category'),
            width: 90,
            render: (o: Op) => t(`media.cat.${o.cat}`),
          },
          { key: 'op', header: t('media.op'), render: (o: Op) => pick(o.en, o.zh) },
          {
            key: 'args',
            header: t('media.command'),
            render: (o: Op) => <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{o.args}</code>,
          },
          {
            key: 'run',
            header: '',
            width: 110,
            render: (o: Op) => (
              <button
                className={o.probe ? 'mini primary' : 'mini'}
                disabled={!activeInput || busyOp === o.id}
                onClick={() => runOp(o)}
                title={activeInput ? '' : pick('Pick a file first', '請先揀個檔')}
              >
                {o.probe ? t('media.show') : t('media.run')}
              </button>
            ),
          },
        ]}
        rows={ops}
        rowKey={(o) => o.id}
      />

      {runOut && (
        <div className="hosts-edit" style={{ marginTop: 12 }}>
          <pre className="cmd-out">{runOut}</pre>
        </div>
      )}
    </div>
  );
}

// Best-effort output extension for an encoding op (used to derive the new file's name).
function guessOutExt(o: Op): string {
  const a = o.args;
  if (a.includes('libwebp')) return o.args.includes('-loop') ? '.anim.webp' : '.webp';
  if (a.includes('.gif') || (o.id.includes('gif'))) return '.gif';
  if (a.includes('-frames:v 1') || o.id.includes('frame') || o.id.includes('thumbnail') || o.id.includes('poster') || o.id.includes('sheet')) return '.png';
  if (a.includes('pcm_s16le')) return '.wav';
  if (a.includes('libmp3lame')) return '.mp3';
  if (a.includes('flac')) return '.flac';
  if (a.includes('libopus')) return '.opus';
  if (a.includes('libvorbis')) return '.ogg';
  if (a.includes('-vn') && a.includes('aac')) return '.m4a';
  if (a.includes('libvpx-vp9') || a.includes('WebM') || o.id.includes('webm')) return '.webm';
  if (o.id.includes('mkv')) return '.mkv';
  if (o.id.includes('mov')) return '.mov';
  if (o.id.includes('avi')) return '.avi';
  return '.out.mp4';
}
