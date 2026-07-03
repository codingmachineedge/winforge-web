import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — in-app screen recorder wrapping ffmpeg's gdigrab, ported from
// WinForge's ScreenRecorder service. Records the WHOLE desktop (incl. Explorer/Start),
// which Xbox Game Bar can't. Saved as MP4 (H.264), video only.
//
// The web bridge's runCommand blocks until the process exits, so it can't hold a live
// recording. Instead we start ffmpeg *detached* via PowerShell (capturing its PID) and
// stop it gracefully: send 'q' to stdin if possible, else CloseMainWindow / taskkill.
// PID/elapsed state lives in the component so the live timer keeps ticking.

const esc = (s: string) => s.replace(/'/g, "''");

interface StartResult { pid: number; error: string }

/** Start ffmpeg gdigrab detached; return its PID (0 on failure). */
function startScript(output: string, fps: number): string {
  const args =
    `-y -f gdigrab -framerate ${fps} -i desktop ` +
    `-c:v libx264 -preset ultrafast -pix_fmt yuv420p '${esc(output)}'`;
  // Redirect stdin so we can later write 'q' for a clean finish; keep the window hidden.
  return (
    `try { ` +
    `$dir = Split-Path -Parent '${esc(output)}'; if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null } ` +
    `$psi = New-Object System.Diagnostics.ProcessStartInfo; ` +
    `$psi.FileName = 'ffmpeg'; ` +
    `$psi.Arguments = '${esc(args)}'; ` +
    `$psi.UseShellExecute = $false; ` +
    `$psi.RedirectStandardInput = $true; ` +
    `$psi.RedirectStandardError = $true; ` +
    `$psi.CreateNoWindow = $true; ` +
    `$p = [System.Diagnostics.Process]::Start($psi); ` +
    `Start-Sleep -Milliseconds 400; ` +
    `if ($p.HasExited) { [pscustomobject]@{ pid = 0; error = ('ffmpeg exited: ' + $p.StandardError.ReadToEnd()) } } ` +
    `else { [pscustomobject]@{ pid = $p.Id; error = '' } } ` +
    `} catch { [pscustomobject]@{ pid = 0; error = $_.Exception.Message } }`
  );
}

/** Ask ffmpeg (by PID) to finish cleanly; fall back to taskkill. Returns exists=$false when gone. */
function stopScript(pid: number): string {
  return (
    `try { ` +
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    // Best-effort graceful close, then wait; taskkill as a fallback so the MP4 finalizes.
    `try { $p.CloseMainWindow() | Out-Null } catch {} ` +
    `& taskkill /PID ${pid} /T 2>&1 | Out-Null; ` +
    `if (-not $p.WaitForExit(4000)) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue } ` +
    `[pscustomobject]@{ stopped = $true; error = '' } ` +
    `} catch { [pscustomobject]@{ stopped = $false; error = $_.Exception.Message } }`
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function ScreenRecorderModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [output, setOutput] = useState('');
  const [fps, setFps] = useState(30);
  const [pid, setPid] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<'' | 'start' | 'stop'>('');
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Default output filename: Videos\WinForge-<timestamp>.mp4.
  const freshName = (): string => {
    const d = new Date();
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `%USERPROFILE%\\Videos\\WinForge-${stamp}.mp4`;
  };

  useEffect(() => {
    setOutput(freshName());
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, []);

  const recording = pid !== null;

  const start = async () => {
    if (recording || busy) return;
    const clampedFps = Math.max(5, Math.min(60, Math.round(fps) || 30));
    const out = output.trim() || freshName();
    setBusy('start');
    setStatus('idle');
    setMessage('');
    try {
      const rows = await runPowershellJson<StartResult>(startScript(out, clampedFps));
      const r = rows[0];
      if (r && r.pid > 0) {
        setPid(r.pid);
        setElapsed(0);
        if (tick.current) clearInterval(tick.current);
        tick.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      } else {
        setStatus('error');
        setMessage(r?.error || t('recorder.startFailed'));
      }
    } catch (e) {
      setStatus('error');
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    if (!recording || busy || pid === null) return;
    setBusy('stop');
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    const savedTo = output.trim();
    try {
      const rows = await runPowershellJson<{ stopped: boolean; error: string }>(stopScript(pid));
      const r = rows[0];
      if (r && r.stopped) {
        setStatus('ok');
        setMessage(t('recorder.savedTo', { path: savedTo }));
      } else {
        setStatus('error');
        setMessage(r?.error || t('recorder.stopFailed'));
      }
    } catch (e) {
      setStatus('error');
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setPid(null);
      setElapsed(0);
      setOutput(freshName()); // fresh filename for the next take
      setBusy('');
    }
  };

  const openFolder = async () => {
    const out = output.trim();
    if (!out || !desktop) return;
    try {
      // Reveal the target folder (or the finished file) in Explorer.
      await runPowershell(
        `$p = [Environment]::ExpandEnvironmentVariables('${esc(out)}'); ` +
          `if (Test-Path $p) { & explorer.exe "/select,$p" } ` +
          `else { $d = Split-Path -Parent $p; if ($d) { & explorer.exe $d } }`,
      );
    } catch {
      /* opening Explorer is best-effort */
    }
  };

  const timer = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('recorder.blurb')}
      </p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('recorder.desktopOnly')}
        </p>
      )}

      <DependencyGate tool="ffmpeg" preferId="Gyan.FFmpeg" query="ffmpeg">
        {() => (
          <>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="count-note">{t('recorder.saveTo')}</label>
              <input
                className="mod-search"
                style={{ minWidth: 320, flex: 1 }}
                value={output}
                disabled={recording}
                onChange={(e) => setOutput(e.target.value)}
                placeholder={t('recorder.saveToPlaceholder')}
              />
              <button className="mini" disabled={!desktop} onClick={openFolder}>
                {t('recorder.openFolder')}
              </button>
            </div>

            <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="count-note">{t('recorder.fps')}</label>
              <input
                className="mod-search"
                type="number"
                min={5}
                max={60}
                style={{ maxWidth: 90 }}
                value={fps}
                disabled={recording}
                onChange={(e) => setFps(+e.target.value)}
              />
              {!recording ? (
                <button
                  className="mini primary"
                  disabled={!desktop || busy === 'start'}
                  onClick={start}
                >
                  {busy === 'start' ? t('recorder.starting') : t('recorder.record')}
                </button>
              ) : (
                <button className="mini primary" disabled={busy === 'stop'} onClick={stop}>
                  {busy === 'stop' ? t('recorder.stopping') : t('recorder.stop')}
                </button>
              )}
              <span
                className="count-note"
                style={{
                  fontFamily: 'monospace',
                  color: recording ? 'var(--danger)' : undefined,
                }}
              >
                {recording ? `● REC ${timer}` : t('recorder.idle')}
              </span>
            </div>

            {status !== 'idle' && message && (
              <pre className={`cmd-out${status === 'error' ? ' error' : ''}`}>{message}</pre>
            )}

            <p className="count-note">{t('recorder.note')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
