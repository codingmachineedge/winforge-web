import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a ScreenToGif-style GIF Studio ported from WinForge's GifLabModule +
// GifLabService. It captures a screen region / active window / full screen to PNG frames
// via ffmpeg gdigrab, lets you tidy them (delete · reorder · uniform crop · clear), preview
// the loop, then re-encode the survivors to GIF / MP4 / APNG (palettegen/paletteuse for GIF)
// with per-export fps, width scale and loop count. Everything runs in-app through ffmpeg.
//
// The web bridge's runCommand blocks until a process exits, so — exactly like the sibling
// ScreenRecorder — a live (manual-stop) capture is started detached via PowerShell (PID
// captured) and finalized with CloseMainWindow / taskkill. A duration-bound capture lets
// ffmpeg self-terminate and we simply wait for its PID to disappear. Frames live in a temp
// working directory created once per session under %TEMP%\WinForge-GifLab.

const esc = (s: string) => s.replace(/'/g, "''");
const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
// The work dir carries a literal %TEMP% so it survives single-quoted PS strings; every place
// that hands it to a cmdlet/ffmpeg wraps it in ExpandEnvironmentVariables to resolve it.
const expand = (p: string) => `([Environment]::ExpandEnvironmentVariables('${esc(p)}'))`;

type Source = 'region' | 'window' | 'full';
type Format = 'gif' | 'mp4' | 'apng';

interface FrameRow {
  Path: string;
  Name: string;
}
interface StartResult {
  pid: number;
  error: string;
}
interface OpResult {
  ok: boolean;
  error: string;
}

/** PowerShell snippet computing the physical-pixel rect for the chosen source into $x/$y/$w/$h. */
function rectSnippet(source: Source): string {
  if (source === 'window') {
    // Foreground window rect via user32 (added once through Add-Type).
    return (
      `Add-Type @'\nusing System;using System.Runtime.InteropServices;` +
      `public class WFGW{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();` +
      `[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);` +
      `[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}}\n'@ -ErrorAction SilentlyContinue; ` +
      `$r=New-Object WFGW+RECT; [void][WFGW]::GetWindowRect([WFGW]::GetForegroundWindow(),[ref]$r); ` +
      `$x=$r.Left; $y=$r.Top; $w=$r.Right-$r.Left; $h=$r.Bottom-$r.Top;`
    );
  }
  // Region falls back to full virtual screen here (no in-page rubber-band selector in the web shell).
  return (
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
    `$x=$vs.X; $y=$vs.Y; $w=$vs.Width; $h=$vs.Height;`
  );
}

/** Start ffmpeg gdigrab detached, writing frame%05d.png into $work. Returns its PID (0 on failure). */
function startScript(work: string, source: Source, fps: number, dur: number): string {
  const rect = rectSnippet(source);
  const durArg = dur > 0 ? `-t ${dur} ` : '';
  return (
    `try { ` +
    `$work=${expand(work)}; ` +
    `if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } ` +
    `New-Item -ItemType Directory -Force -Path $work | Out-Null; ` +
    rect +
    ` $w=$w-($w%2); $h=$h-($h%2); ` +
    `if ($w -le 0 -or $h -le 0) { [pscustomobject]@{ pid=0; error='Capture region is too small.' } | ConvertTo-Json -Compress; return } ` +
    `$pattern=Join-Path $work 'frame%05d.png'; ` +
    `$args='-y -f gdigrab -framerate ${fps} -offset_x '+$x+' -offset_y '+$y+' -video_size '+$w+'x'+$h+' -i desktop ${durArg}\"'+$pattern+'\"'; ` +
    `$psi=New-Object System.Diagnostics.ProcessStartInfo; ` +
    `$psi.FileName='ffmpeg'; $psi.Arguments=$args; ` +
    `$psi.UseShellExecute=$false; $psi.RedirectStandardInput=$true; $psi.RedirectStandardError=$true; $psi.CreateNoWindow=$true; ` +
    `$p=[System.Diagnostics.Process]::Start($psi); ` +
    `Start-Sleep -Milliseconds 500; ` +
    `if ($p.HasExited) { [pscustomobject]@{ pid=0; error=('ffmpeg exited: '+$p.StandardError.ReadToEnd()) } | ConvertTo-Json -Compress } ` +
    `else { [pscustomobject]@{ pid=$p.Id; error='' } | ConvertTo-Json -Compress } ` +
    `} catch { [pscustomobject]@{ pid=0; error=$_.Exception.Message } | ConvertTo-Json -Compress }`
  );
}

/** Ask ffmpeg (by PID) to finish cleanly so the PNG frames finalize; fall back to taskkill. */
function stopScript(pid: number): string {
  return (
    `try { ` +
    `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `try { $p.CloseMainWindow() | Out-Null } catch {} ` +
    `& taskkill /PID ${pid} /T 2>&1 | Out-Null; ` +
    `if (-not $p.WaitForExit(4000)) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue } ` +
    `[pscustomobject]@{ ok=$true; error='' } | ConvertTo-Json -Compress ` +
    `} catch { [pscustomobject]@{ ok=$true; error='' } | ConvertTo-Json -Compress }`
  );
}

export function GifLabModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // Stable per-session working directory holding the PNG frames.
  const workRef = useRef<string>(
    `%TEMP%\\WinForge-GifLab\\${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
  );
  const work = workRef.current;

  // Capture controls
  const [source, setSource] = useState<Source>('full');
  const [capFps, setCapFps] = useState(15);
  const [dur, setDur] = useState(0);
  const [pid, setPid] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Frames: ordered list of source PNG paths (order = export order). Thumbs are lazily loaded.
  const [frames, setFrames] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Preview playback
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const play = useRef<ReturnType<typeof setInterval> | null>(null);

  // Export controls
  const [format, setFormat] = useState<Format>('gif');
  const [outFps, setOutFps] = useState(15);
  const [scale, setScale] = useState(0);
  const [loop, setLoop] = useState(0);

  const [busy, setBusy] = useState<'' | 'start' | 'stop' | 'load' | 'crop' | 'export'>('');
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const recording = pid !== null;

  useEffect(() => {
    return () => {
      if (tick.current) clearInterval(tick.current);
      if (play.current) clearInterval(play.current);
    };
  }, []);

  const setResult = (ok: boolean, msg: string) => {
    setStatus(ok ? 'ok' : 'error');
    setMessage(msg);
  };

  // ---------------- Frame loading / thumbnails ----------------

  const loadThumb = async (path: string) => {
    try {
      const res = await runPowershell(
        `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${esc(path)}'))`,
      );
      const b64 = res.stdout.trim();
      if (b64) setThumbs((m) => ({ ...m, [path]: `data:image/png;base64,${b64}` }));
    } catch {
      /* thumbnail is best-effort */
    }
  };

  const refreshFrames = async () => {
    stopPlayback();
    setBusy('load');
    try {
      const rows = await runPowershellJson<FrameRow>(
        `Get-ChildItem -Path ${expand(work)} -Filter 'frame*.png' -File -ErrorAction SilentlyContinue | ` +
          `Sort-Object Name | Select-Object @{N='Path';E={$_.FullName}},Name`,
      );
      const paths = rows.map((r) => r.Path);
      setFrames(paths);
      setSelected(new Set());
      setThumbs({});
      setPlayIdx(0);
      // Load thumbnails sequentially-ish (fire them; state merges as each resolves).
      for (const p of paths) void loadThumb(p);
    } catch (e) {
      setResult(false, String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---------------- Capture ----------------

  const startCapture = async () => {
    if (recording || busy || !desktop) return;
    const fps = Math.max(1, Math.min(60, Math.round(capFps) || 15));
    const d = Math.max(0, Math.min(600, Math.round(dur) || 0));
    setBusy('start');
    setStatus('idle');
    setMessage('');
    try {
      const rows = await runPowershellJson<StartResult>(startScript(work, source, fps, d));
      const r = rows[0];
      if (r && r.pid > 0) {
        setPid(r.pid);
        setElapsed(0);
        if (tick.current) clearInterval(tick.current);
        tick.current = setInterval(() => setElapsed((e) => e + 1), 1000);
        if (d > 0) {
          // Self-terminating capture — poll until the PID is gone, then load frames.
          void waitForExit(r.pid);
        }
      } else {
        setResult(false, r?.error || t('giflab.startFailed'));
      }
    } catch (e) {
      setResult(false, String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const waitForExit = async (targetPid: number) => {
    for (let i = 0; i < 620; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const rows = await runPowershellJson<{ Running: boolean }>(
          `[pscustomobject]@{ Running = [bool](Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue) }`,
        );
        if (!rows[0]?.Running) break;
      } catch {
        break;
      }
    }
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    setPid(null);
    setElapsed(0);
    await refreshFrames();
    setResult(true, t('giflab.captured'));
  };

  const stopCapture = async () => {
    if (!recording || busy || pid === null) return;
    setBusy('stop');
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    try {
      await runPowershellJson<OpResult>(stopScript(pid));
    } catch {
      /* stop is best-effort; frames are still finalized */
    } finally {
      setPid(null);
      setElapsed(0);
      setBusy('');
    }
    await refreshFrames();
    setResult(true, t('giflab.captured'));
  };

  // ---------------- Frame editing ----------------

  const toggleSel = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const moveSelected = (delta: number) => {
    if (selected.size === 0) return;
    setFrames((prev) => {
      const arr = [...prev];
      const idxs = arr
        .map((p, i) => ({ p, i }))
        .filter((x) => selected.has(x.p))
        .map((x) => x.i);
      const order = delta > 0 ? idxs.reverse() : idxs;
      for (const i of order) {
        const j = i + delta;
        if (j < 0 || j >= arr.length) continue;
        const a = arr[i];
        const b = arr[j];
        if (a === undefined || b === undefined) continue;
        arr[i] = b;
        arr[j] = a;
      }
      return arr;
    });
    stopPlayback();
  };

  const deleteSelected = async () => {
    if (selected.size === 0) {
      setResult(false, t('giflab.nothingSelected'));
      return;
    }
    const toDel = frames.filter((p) => selected.has(p));
    try {
      const list = toDel.map((p) => `'${esc(p)}'`).join(',');
      await runPowershell(`@(${list}) | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }`);
    } catch {
      /* file removal best-effort */
    }
    const kept = frames.filter((p) => !selected.has(p));
    setFrames(kept);
    setSelected(new Set());
    setPlayIdx(0);
    stopPlayback();
    setResult(true, t('giflab.deleted', { n: toDel.length }));
  };

  const clearAll = async () => {
    stopPlayback();
    try {
      await runPowershell(`Remove-Item -Recurse -Force ${expand(work)} -ErrorAction SilentlyContinue`);
    } catch {
      /* best-effort */
    }
    setFrames([]);
    setSelected(new Set());
    setThumbs({});
    setPlayIdx(0);
    setResult(true, t('giflab.cleared'));
  };

  const cropAll = async () => {
    if (frames.length === 0 || !desktop) return;
    const first = frames[0];
    if (!first) return;
    setBusy('crop');
    setStatus('idle');
    setMessage('');
    try {
      // Measure the source frame so we can validate the crop box.
      const dim = await runPowershellJson<{ W: number; H: number }>(
        `Add-Type -AssemblyName System.Drawing; $im=[System.Drawing.Image]::FromFile('${esc(first)}'); ` +
          `$o=[pscustomobject]@{ W=$im.Width; H=$im.Height }; $im.Dispose(); $o`,
      );
      const fw = dim[0]?.W ?? 0;
      const fh = dim[0]?.H ?? 0;
      if (fw <= 0 || fh <= 0) {
        setResult(false, t('giflab.cropReadFail'));
        return;
      }
      const cxs = window.prompt(t('giflab.cropX'), '0');
      if (cxs === null) return;
      const cys = window.prompt(t('giflab.cropY'), '0');
      if (cys === null) return;
      const cws = window.prompt(t('giflab.cropW', { max: fw }), String(fw));
      if (cws === null) return;
      const chs = window.prompt(t('giflab.cropH', { max: fh }), String(fh));
      if (chs === null) return;
      let cx = Math.max(0, Math.floor(Number(cxs) || 0));
      let cy = Math.max(0, Math.floor(Number(cys) || 0));
      let cw = Math.floor(Number(cws) || 0);
      let ch = Math.floor(Number(chs) || 0);
      cw -= cw % 2;
      ch -= ch % 2;
      if (cw < 2 || ch < 2 || cx + cw > fw || cy + ch > fh) {
        setResult(false, t('giflab.cropInvalid'));
        return;
      }
      // Apply crop=W:H:X:Y to every frame, in place, via a temp file.
      const list = frames.map((p) => `'${esc(p)}'`).join(',');
      const script =
        `$ok=$true; $err=''; foreach ($f in @(${list})) { ` +
        `$tmp=$f+'.crop.png'; ` +
        `& ffmpeg -y -i $f -vf "crop=${cw}:${ch}:${cx}:${cy}" $tmp 2>&1 | Out-Null; ` +
        `if (Test-Path $tmp) { Remove-Item -LiteralPath $f -Force; Rename-Item -LiteralPath $tmp -NewName ([IO.Path]::GetFileName($f)) } ` +
        `else { $ok=$false; $err='crop failed'; break } } ` +
        `[pscustomobject]@{ ok=$ok; error=$err } | ConvertTo-Json -Compress`;
      const res = await runPowershellJson<OpResult>(script);
      const r = res[0];
      if (r?.ok) {
        setResult(true, t('giflab.cropped'));
        await refreshFrames();
      } else {
        setResult(false, r?.error || t('giflab.cropFail'));
      }
    } catch (e) {
      setResult(false, String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---------------- Preview ----------------

  const stopPlayback = () => {
    setPlaying(false);
    if (play.current) {
      clearInterval(play.current);
      play.current = null;
    }
  };

  const togglePlay = () => {
    if (frames.length === 0) return;
    if (playing) {
      stopPlayback();
      return;
    }
    setPlaying(true);
    const fps = Math.max(1, Math.min(60, Math.round(outFps) || 15));
    if (play.current) clearInterval(play.current);
    play.current = setInterval(() => {
      setPlayIdx((i) => (frames.length ? (i + 1) % frames.length : 0));
    }, Math.round(1000 / fps));
  };

  // ---------------- Export ----------------

  const exportGif = async () => {
    if (frames.length === 0 || !desktop) return;
    stopPlayback();
    const ext = format === 'mp4' ? 'mp4' : format === 'apng' ? 'apng' : 'gif';
    const d = new Date();
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const suggested = window.prompt(
      t('giflab.savePrompt'),
      `%USERPROFILE%\\Videos\\WinForge-gif-${stamp}.${ext}`,
    );
    if (suggested === null) return;
    const out = suggested.trim();
    if (!out) return;

    const fps = Math.max(1, Math.min(60, Math.round(outFps) || 15));
    const sc = Math.max(0, Math.round(scale) || 0);
    const lp = Math.max(0, Math.round(loop) || 0);
    const scaleFilter = sc > 0 ? `,scale=${sc}:-1:flags=lanczos` : '';

    setBusy('export');
    setStatus('idle');
    setMessage('');
    try {
      // concat demuxer list honours the (possibly reordered / trimmed) frame order.
      const listContent = frames
        .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('`n');
      // ffmpeg command using the PS vars $listFile / $pal / $out defined in the prelude below.
      let cmd: string;
      if (format === 'mp4') {
        cmd =
          `& ffmpeg -y -r ${fps} -f concat -safe 0 -i $listFile ` +
          `-vf "format=yuv420p${scaleFilter}" -c:v libx264 -preset medium -movflags +faststart $out 2>&1 | Out-Null`;
      } else if (format === 'apng') {
        const vf = scaleFilter ? `-vf "${scaleFilter.slice(1)}" ` : '';
        cmd = `& ffmpeg -y -r ${fps} -f concat -safe 0 -i $listFile ${vf}-f apng -plays ${lp} $out 2>&1 | Out-Null`;
      } else {
        cmd =
          `$pal=Join-Path $work 'pal.png'; ` +
          `& ffmpeg -y -r ${fps} -f concat -safe 0 -i $listFile -vf "fps=${fps}${scaleFilter},palettegen=stats_mode=diff" $pal 2>&1 | Out-Null; ` +
          `& ffmpeg -y -r ${fps} -f concat -safe 0 -i $listFile -i $pal ` +
          `-lavfi "fps=${fps}${scaleFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -loop ${lp} $out 2>&1 | Out-Null; ` +
          `Remove-Item -LiteralPath $pal -Force -ErrorAction SilentlyContinue`;
      }
      const script =
        `$work=${expand(work)}; New-Item -ItemType Directory -Force -Path $work | Out-Null; ` +
        `$listFile=Join-Path $work 'concat.txt'; ` +
        `$out=${expand(out)}; ` +
        `$dir=Split-Path -Parent $out; ` +
        `if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null } ` +
        `Set-Content -LiteralPath $listFile -Value "${listContent}" -Encoding utf8; ` +
        cmd +
        `; Remove-Item -LiteralPath $listFile -Force -ErrorAction SilentlyContinue; ` +
        `[pscustomobject]@{ ok=(Test-Path $out); error='' } | ConvertTo-Json -Compress`;
      const res = await runPowershellJson<OpResult>(script);
      if (res[0]?.ok) setResult(true, t('giflab.exported', { path: out }));
      else setResult(false, t('giflab.exportFailed'));
    } catch (e) {
      setResult(false, String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const timer = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;
  const hasFrames = frames.length > 0;
  const hasSel = selected.size > 0;
  const curFrame = frames[playIdx];
  const previewSrc = curFrame ? thumbs[curFrame] : undefined;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('giflab.blurb')}
      </p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('giflab.desktopOnly')}
        </p>
      )}

      <DependencyGate tool="ffmpeg" preferId="Gyan.FFmpeg" query="ffmpeg">
        {() => (
          <>
            {/* 1 · Capture */}
            <h4 className="giflab-h">{t('giflab.capTitle')}</h4>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('giflab.capBlurb')}
            </p>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="count-note">{t('giflab.sourceCap')}</label>
              <select
                className="mod-search"
                style={{ maxWidth: 220 }}
                value={source}
                disabled={recording}
                onChange={(e) => setSource(e.target.value as Source)}
              >
                <option value="full">{t('giflab.srcFull')}</option>
                <option value="window">{t('giflab.srcWindow')}</option>
                <option value="region">{t('giflab.srcRegion')}</option>
              </select>
              <label className="count-note">{t('giflab.fpsCap')}</label>
              <input
                className="mod-search"
                type="number"
                min={1}
                max={60}
                style={{ maxWidth: 80 }}
                value={capFps}
                disabled={recording}
                onChange={(e) => setCapFps(+e.target.value)}
              />
              <label className="count-note">{t('giflab.durCap')}</label>
              <input
                className="mod-search"
                type="number"
                min={0}
                max={600}
                style={{ maxWidth: 80 }}
                value={dur}
                disabled={recording}
                onChange={(e) => setDur(+e.target.value)}
              />
              {!recording ? (
                <button className="mini primary" disabled={!desktop || busy === 'start'} onClick={startCapture}>
                  {busy === 'start' ? t('giflab.starting') : t('giflab.capture')}
                </button>
              ) : (
                <button className="mini primary" disabled={busy === 'stop'} onClick={stopCapture}>
                  {busy === 'stop' ? t('giflab.stopping') : t('giflab.stop')}
                </button>
              )}
              <span
                className="count-note"
                style={{ fontFamily: 'monospace', color: recording ? 'var(--danger)' : undefined }}
              >
                {recording ? `● REC ${timer}` : t('giflab.idle')}
              </span>
            </div>
            {source === 'region' && (
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('giflab.regionNote')}
              </p>
            )}

            {/* 2 · Frames */}
            <h4 className="giflab-h">{t('giflab.framesTitle')}</h4>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="mini" disabled={!hasSel} onClick={() => moveSelected(-1)}>
                ‹ {t('giflab.moveLeft')}
              </button>
              <button className="mini" disabled={!hasSel} onClick={() => moveSelected(1)}>
                {t('giflab.moveRight')} ›
              </button>
              <button className="mini" disabled={!hasSel} onClick={deleteSelected}>
                {t('giflab.delete')}
              </button>
              <button className="mini" disabled={!hasFrames || busy === 'crop'} onClick={cropAll}>
                {busy === 'crop' ? t('giflab.cropping') : t('giflab.cropAll')}
              </button>
              <button className="mini" disabled={busy === 'load'} onClick={refreshFrames}>
                ⟳ {t('giflab.reload')}
              </button>
              <button className="mini" disabled={!hasFrames} onClick={clearAll}>
                {t('giflab.clearAll')}
              </button>
              <span className="count-note">{t('giflab.frameCount', { n: frames.length })}</span>
            </div>

            {hasFrames ? (
              <div className="giflab-strip">
                {frames.map((p, i) => {
                  const sel = selected.has(p);
                  const src = thumbs[p];
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`giflab-frame${sel ? ' sel' : ''}`}
                      onClick={() => toggleSel(p)}
                      title={p}
                    >
                      {src ? (
                        <img src={src} alt={`frame ${i + 1}`} />
                      ) : (
                        <span className="giflab-frame-ph">…</span>
                      )}
                      <span className="giflab-frame-idx">{i + 1}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="count-note">{t('giflab.emptyHint')}</p>
            )}

            {/* 3 · Preview */}
            {hasFrames && (
              <>
                <h4 className="giflab-h">{t('giflab.previewTitle')}</h4>
                <div className="mod-toolbar" style={{ alignItems: 'center' }}>
                  <button className="mini" onClick={togglePlay}>
                    {playing ? `⏸ ${t('giflab.pause')}` : `▶ ${t('giflab.play')}`}
                  </button>
                  <span className="count-note" style={{ fontFamily: 'monospace' }}>
                    {playIdx + 1}/{frames.length}
                  </span>
                </div>
                <div className="giflab-preview">
                  {previewSrc ? (
                    <img src={previewSrc} alt="preview" />
                  ) : (
                    <span className="giflab-frame-ph">…</span>
                  )}
                </div>
              </>
            )}

            {/* 4 · Export */}
            {hasFrames && (
              <>
                <h4 className="giflab-h">{t('giflab.exportTitle')}</h4>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <label className="count-note">{t('giflab.formatCap')}</label>
                  <select
                    className="mod-search"
                    style={{ maxWidth: 160 }}
                    value={format}
                    onChange={(e) => setFormat(e.target.value as Format)}
                  >
                    <option value="gif">GIF</option>
                    <option value="mp4">MP4 (H.264)</option>
                    <option value="apng">APNG</option>
                  </select>
                  <label className="count-note">{t('giflab.outFpsCap')}</label>
                  <input
                    className="mod-search"
                    type="number"
                    min={1}
                    max={60}
                    style={{ maxWidth: 80 }}
                    value={outFps}
                    onChange={(e) => setOutFps(+e.target.value)}
                  />
                  <label className="count-note">{t('giflab.scaleCap')}</label>
                  <select
                    className="mod-search"
                    style={{ maxWidth: 150 }}
                    value={scale}
                    onChange={(e) => setScale(+e.target.value)}
                  >
                    <option value={0}>{t('giflab.scaleOrig')}</option>
                    <option value={320}>320 px</option>
                    <option value={480}>480 px</option>
                    <option value={640}>640 px</option>
                    <option value={720}>720 px</option>
                    <option value={1280}>1280 px</option>
                  </select>
                  {format !== 'mp4' && (
                    <>
                      <label className="count-note">{t('giflab.loopCap')}</label>
                      <select
                        className="mod-search"
                        style={{ maxWidth: 150 }}
                        value={loop}
                        onChange={(e) => setLoop(+e.target.value)}
                      >
                        <option value={0}>{t('giflab.loopForever')}</option>
                        <option value={1}>{t('giflab.loopOnce')}</option>
                        <option value={3}>{t('giflab.loopThree')}</option>
                      </select>
                    </>
                  )}
                  <button className="mini primary" disabled={!desktop || busy === 'export'} onClick={exportGif}>
                    {busy === 'export' ? t('giflab.exporting') : t('giflab.export')}
                  </button>
                </div>
              </>
            )}

            {status !== 'idle' && message && (
              <pre className={`cmd-out${status === 'error' ? ' error' : ''}`}>{message}</pre>
            )}

            <style>{`
              .giflab-h { margin: 18px 0 4px; font-size: 14px; font-weight: 600; }
              .giflab-strip { display: flex; gap: 8px; overflow-x: auto; padding: 8px;
                background: var(--panel, rgba(127,127,127,.08)); border-radius: 6px; min-height: 120px; }
              .giflab-frame { position: relative; flex: 0 0 auto; width: 120px; height: 100px;
                padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden;
                background: rgba(0,0,0,.15); cursor: pointer; }
              .giflab-frame.sel { border-color: var(--accent, #4c8bf5); }
              .giflab-frame img { width: 100%; height: 100%; object-fit: contain; display: block; }
              .giflab-frame-ph { display: flex; align-items: center; justify-content: center;
                width: 100%; height: 100%; color: var(--text-dim, #888); font-size: 20px; }
              .giflab-frame-idx { position: absolute; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,.6); color: #fff; font-size: 11px; text-align: center; padding: 1px 0; }
              .giflab-preview { display: inline-block; margin-top: 8px; padding: 6px;
                background: var(--panel, rgba(127,127,127,.08)); border-radius: 6px; }
              .giflab-preview img { max-height: 320px; max-width: 560px; display: block; }
            `}</style>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
