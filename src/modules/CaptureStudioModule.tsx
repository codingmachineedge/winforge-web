import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ---------------------------------------------------------------------------
// Capture Studio · 擷取工作室 — native port.
// The WinForge desktop module uses a transparent drag-rectangle overlay + GDI
// BitBlt + Windows.Media.Ocr + ffmpeg gdigrab. In the Tauri shell we cannot draw
// an interactive drag overlay, so the region is chosen from the live monitor list
// (queried through the Rust/PowerShell bridge). Everything else is faithful:
//   • Region record → MP4 / GIF   (ffmpeg gdigrab, two-pass palette GIF)
//   • Instant snip → clipboard    (.NET System.Drawing + WinForms Clipboard)
//   • OCR — text from an image    (Windows.Media.Ocr WinRT projection)
// All work runs in-app through the backend — no redirects.
// ---------------------------------------------------------------------------

interface Monitor {
  Name: string;
  Primary: boolean;
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

interface OcrLang {
  Tag: string;
  DisplayName: string;
}

interface EngineInfo {
  FfmpegPath: string;
  HasFfmpeg: boolean;
  VideosDir: string;
}

// PowerShell string literal — single-quote escape.
const ps = (s: string) => s.replace(/'/g, "''");

export function CaptureStudioModule() {
  const { t } = useTranslation();

  const [busy, setBusy] = useState<string | null>(null);
  const [recMsg, setRecMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [snipMsg, setSnipMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ocrMsg, setOcrMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ocrResult, setOcrResult] = useState<string>('');

  const [fps, setFps] = useState(30);
  const [makeGif, setMakeGif] = useState(false);
  const [selMonitor, setSelMonitor] = useState<string>('');
  const [snipPath, setSnipPath] = useState('');
  const [ocrFile, setOcrFile] = useState('');
  const [recording, setRecording] = useState(false);

  // ---- live system state ---------------------------------------------------

  const engine = useAsync<EngineInfo>(async () => {
    const rows = await runPowershellJson<EngineInfo>(
      "$ff = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source; " +
        "$vid = [Environment]::GetFolderPath('MyVideos'); " +
        "[pscustomobject]@{ FfmpegPath = ($ff -as [string]); HasFfmpeg = [bool]$ff; VideosDir = $vid }",
    );
    return rows[0] ?? { FfmpegPath: '', HasFfmpeg: false, VideosDir: '' };
  }, []);

  const monitors = useAsync<Monitor[]>(
    () =>
      runPowershellJson<Monitor>(
        "Add-Type -AssemblyName System.Windows.Forms; " +
          "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
          "[pscustomobject]@{ Name = $_.DeviceName; Primary = $_.Primary; " +
          "X = $_.Bounds.X; Y = $_.Bounds.Y; Width = $_.Bounds.Width; Height = $_.Bounds.Height } }",
      ),
    [],
  );

  const ocrLangs = useAsync<OcrLang[]>(
    () =>
      runPowershellJson<OcrLang>(
        "$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]; " +
          "[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { " +
          "[pscustomobject]@{ Tag = $_.LanguageTag; DisplayName = $_.DisplayName } }",
      ),
    [],
  );

  const monitorList = monitors.data ?? [];
  const activeMonitor = useMemo(() => {
    if (monitorList.length === 0) return null;
    const chosen = monitorList.find((m) => m.Name === selMonitor);
    return chosen ?? monitorList.find((m) => m.Primary) ?? monitorList[0] ?? null;
  }, [monitorList, selMonitor]);

  const langList = ocrLangs.data ?? [];
  const hasChinese = langList.some((l) => l.Tag.toLowerCase().startsWith('zh'));
  const langSummary = langList.map((l) => l.DisplayName).join(', ');

  const hasFfmpeg = engine.data?.HasFfmpeg ?? false;
  const videosDir = engine.data?.VideosDir ?? '';

  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  // ---- region recording ----------------------------------------------------

  const startRecording = async () => {
    if (!activeMonitor || !hasFfmpeg) return;
    const out = `${videosDir}\\WinForge-${stamp()}.mp4`;
    const m = activeMonitor;
    setBusy('rec');
    setRecMsg(null);
    try {
      // Launch ffmpeg detached (Start-Process) with a stdin pipe file so Stop can send 'q'.
      // We start a hidden ffmpeg gdigrab bound to the chosen monitor's physical rect.
      const args =
        `-y -f gdigrab -framerate ${Math.max(5, Math.min(60, fps))} ` +
        `-offset_x ${m.X} -offset_y ${m.Y} -video_size ${m.Width}x${m.Height} -i desktop ` +
        `-c:v libx264 -preset ultrafast -pix_fmt yuv420p "${out}"`;
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `$p = Start-Process -FilePath 'ffmpeg.exe' -ArgumentList '${ps(args)}' -WindowStyle Hidden -PassThru; ` +
        `Set-Content -Path (Join-Path $env:TEMP 'winforge-capture.pid') -Value $p.Id; ` +
        `Set-Content -Path (Join-Path $env:TEMP 'winforge-capture.out') -Value '${ps(out)}'; ` +
        `Set-Content -Path (Join-Path $env:TEMP 'winforge-capture.gif') -Value '${makeGif ? '1' : '0'}'; ` +
        `Set-Content -Path (Join-Path $env:TEMP 'winforge-capture.gfps') -Value '15'; ` +
        `'started ' + $p.Id`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setRecording(true);
      setRecMsg({ ok: true, text: t('capture.recStarted', { path: out }) });
    } catch (e) {
      setRecMsg({ ok: false, text: `${t('capture.recFailed')}: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const stopRecording = async () => {
    setBusy('rec');
    try {
      // Gracefully stop ffmpeg (CtrlC via taskkill /pid), then build the GIF if requested.
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `$pidFile = Join-Path $env:TEMP 'winforge-capture.pid'; ` +
        `if (-not (Test-Path $pidFile)) { throw 'Not recording.' }; ` +
        `$capturePid = (Get-Content $pidFile).Trim(); ` +
        `$out = (Get-Content (Join-Path $env:TEMP 'winforge-capture.out')).Trim(); ` +
        `$gif = (Get-Content (Join-Path $env:TEMP 'winforge-capture.gif')).Trim(); ` +
        `$gfps = (Get-Content (Join-Path $env:TEMP 'winforge-capture.gfps')).Trim(); ` +
        // ffmpeg with no console can't receive 'q'; stop it cleanly by killing the process.
        // gdigrab flushes the moov atom on SIGTERM-equivalent taskkill without /f first.
        `taskkill /pid $capturePid 2>$null | Out-Null; Start-Sleep -Milliseconds 400; ` +
        `if (Get-Process -Id $capturePid -ErrorAction SilentlyContinue) { taskkill /f /pid $capturePid 2>$null | Out-Null }; ` +
        `Start-Sleep -Milliseconds 300; ` +
        `Remove-Item $pidFile -ErrorAction SilentlyContinue; ` +
        `$gifPath = ''; ` +
        `if ($gif -eq '1' -and (Test-Path $out)) { ` +
        `  $gifPath = [IO.Path]::ChangeExtension($out, '.gif'); ` +
        `  $pal = Join-Path $env:TEMP ('winforge-pal-' + [Guid]::NewGuid().ToString('N') + '.png'); ` +
        `  & ffmpeg.exe -y -i \"$out\" -vf \"fps=$gfps,scale=720:-1:flags=lanczos,palettegen=stats_mode=diff\" \"$pal\" 2>$null | Out-Null; ` +
        `  & ffmpeg.exe -y -i \"$out\" -i \"$pal\" -lavfi \"fps=$gfps,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3\" \"$gifPath\" 2>$null | Out-Null; ` +
        `  Remove-Item $pal -ErrorAction SilentlyContinue } ; ` +
        `if (Test-Path $out) { 'ok|' + $out + '|' + $gifPath } else { throw 'Output not written.' }`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const parts = res.stdout.trim().split('|');
      const savedMp4 = parts[1] ?? '';
      const savedGif = parts[2] ?? '';
      setRecMsg({
        ok: true,
        text: savedGif
          ? t('capture.savedBoth', { mp4: savedMp4, gif: savedGif })
          : t('capture.savedMp4', { path: savedMp4 }),
      });
    } catch (e) {
      setRecMsg({ ok: false, text: `${t('capture.recFailed')}: ${String(e)}` });
    } finally {
      setRecording(false);
      setBusy(null);
    }
  };

  // ---- snip → clipboard ----------------------------------------------------

  const snip = async (save: boolean) => {
    if (!activeMonitor) return;
    const m = activeMonitor;
    setBusy('snip');
    setSnipMsg(null);
    const savePath =
      save && snipPath.trim() ? snipPath.trim() : `${videosDir}\\WinForge-snip-${stamp()}.png`;
    try {
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ` +
        `$bmp = New-Object System.Drawing.Bitmap ${m.Width}, ${m.Height}; ` +
        `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen(${m.X}, ${m.Y}, 0, 0, $bmp.Size); ` +
        `[System.Windows.Forms.Clipboard]::SetImage($bmp); ` +
        (save
          ? `$dir = Split-Path -Parent '${ps(savePath)}'; if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; ` +
            `$bmp.Save('${ps(savePath)}', [System.Drawing.Imaging.ImageFormat]::Png); `
          : '') +
        `$g.Dispose(); $bmp.Dispose(); 'ok'`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setSnipMsg({
        ok: true,
        text: save ? t('capture.snipSaved', { path: savePath }) : t('capture.snipCopied'),
      });
    } catch (e) {
      setSnipMsg({ ok: false, text: `${t('capture.snipFailed')}: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  // ---- OCR an image file ---------------------------------------------------

  const runOcr = async () => {
    const file = ocrFile.trim();
    if (!file) {
      setOcrMsg({ ok: false, text: t('capture.ocrNoFile') });
      return;
    }
    setBusy('ocr');
    setOcrMsg(null);
    setOcrResult('');
    try {
      // Windows.Media.Ocr over the image file, preferring a zh-Hant recognizer.
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `$path = '${ps(file)}'; ` +
        `if (-not (Test-Path $path)) { throw 'File not found.' }; ` +
        `$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]; ` +
        `$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]; ` +
        `$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]; ` +
        // await helper for WinRT IAsyncOperation<T> (avoid backtick in the generic arity name)
        `function Await($op, $t) { $task = [System.WindowsRuntimeSystemExtensions].GetMethods() | ` +
        `  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') } | ` +
        `  Select-Object -First 1; $g = $task.MakeGenericMethod($t); $res = $g.Invoke($null, @($op)); $res.Wait(); $res.Result }; ` +
        `$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages; ` +
        `$zh = $langs | Where-Object { $_.LanguageTag -like 'zh-Hant*' } | Select-Object -First 1; ` +
        `if (-not $zh) { $zh = $langs | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1 }; ` +
        `if ($zh) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($zh.LanguageTag)) } ` +
        `else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }; ` +
        `if (-not $engine) { throw 'No OCR language pack installed.' }; ` +
        `$sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile]); ` +
        `$stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]); ` +
        `$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]); ` +
        `$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]); ` +
        `$ocr = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]); ` +
        `$text = ($ocr.Lines | ForEach-Object { $_.Text }) -join ([char]10); ` +
        `if ($text) { Set-Clipboard -Value $text }; ` +
        `$text`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const text = res.stdout.replace(/\r/g, '');
      setOcrResult(text.trim());
      setOcrMsg({
        ok: true,
        text: text.trim() ? t('capture.ocrDone') : t('capture.ocrEmpty'),
      });
    } catch (e) {
      setOcrMsg({ ok: false, text: `${t('capture.ocrFailed')}: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const monitorColumns: Column<Monitor>[] = [
    {
      key: 'sel',
      header: '',
      width: 40,
      render: (m) => (
        <input
          type="radio"
          name="capMon"
          checked={activeMonitor?.Name === m.Name}
          onChange={() => setSelMonitor(m.Name)}
        />
      ),
    },
    { key: 'Name', header: t('capture.monName') },
    {
      key: 'Primary',
      header: t('capture.monPrimary'),
      width: 90,
      render: (m) => <StatusDot ok={m.Primary} label={m.Primary ? t('capture.yes') : t('capture.no')} />,
    },
    {
      key: 'size',
      header: t('capture.monSize'),
      width: 130,
      render: (m) => `${m.Width}×${m.Height}`,
    },
    {
      key: 'pos',
      header: t('capture.monPos'),
      width: 110,
      render: (m) => `${m.X}, ${m.Y}`,
    },
  ];

  const Msg = ({ m }: { m: { ok: boolean; text: string } | null }) =>
    m ? <p className={`mod-msg ${m.ok ? '' : 'error'}`}>{m.text}</p> : null;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button
          className="mini"
          onClick={() => {
            engine.reload();
            monitors.reload();
            ocrLangs.reload();
          }}
        >
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('capture.headerBlurb')}</span>
      </ModuleToolbar>

      {/* Monitor picker — the region source (replaces the desktop drag-overlay). */}
      <div className="hosts-edit" style={{ marginBottom: 14 }}>
        <p style={{ fontWeight: 600, margin: '0 0 8px' }}>{t('capture.regionLabel')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('capture.regionBlurb')}
        </p>
        <AsyncState loading={monitors.loading} error={monitors.error}>
          <DataTable columns={monitorColumns} rows={monitorList} rowKey={(m) => m.Name} />
        </AsyncState>
      </div>

      {/* ============ Region record → MP4 / GIF ============ */}
      <div className="hosts-edit" style={{ marginBottom: 14 }}>
        <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{t('capture.recLabel')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('capture.recBlurb')}
        </p>
        {!engine.loading && !hasFfmpeg && (
          <p className="mod-msg error">{t('capture.ffmpegMissing')}</p>
        )}
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('capture.fps')}
            <input
              type="number"
              min={5}
              max={60}
              value={fps}
              disabled={recording}
              onChange={(e) => setFps(Number(e.target.value) || 30)}
              style={{ width: 70 }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={makeGif}
              disabled={recording}
              onChange={(e) => setMakeGif(e.target.checked)}
            />
            {t('capture.alsoGif')}
          </label>
          {!recording ? (
            <button
              className="mini primary"
              disabled={busy !== null || !hasFfmpeg || !activeMonitor}
              onClick={startRecording}
            >
              ● {t('capture.record')}
            </button>
          ) : (
            <button className="mini" disabled={busy !== null} onClick={stopRecording}>
              ■ {t('capture.stop')}
            </button>
          )}
          <StatusDot
            ok={recording}
            label={recording ? t('capture.statusRec') : t('capture.statusIdle')}
          />
        </div>
        <Msg m={recMsg} />
      </div>

      {/* ============ Instant snip → clipboard ============ */}
      <div className="hosts-edit" style={{ marginBottom: 14 }}>
        <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{t('capture.snipLabel')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('capture.snipBlurb')}
        </p>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button
            className="mini primary"
            disabled={busy !== null || !activeMonitor}
            onClick={() => snip(false)}
          >
            {t('capture.snipClip')}
          </button>
          <input
            className="mod-search"
            placeholder={t('capture.snipPathPlaceholder')}
            value={snipPath}
            onChange={(e) => setSnipPath(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <button
            className="mini"
            disabled={busy !== null || !activeMonitor}
            onClick={() => snip(true)}
          >
            {t('capture.snipSave')}
          </button>
        </div>
        <Msg m={snipMsg} />
      </div>

      {/* ============ OCR ============ */}
      <div className="hosts-edit">
        <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{t('capture.ocrLabel')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('capture.ocrBlurb')}
        </p>
        <AsyncState loading={ocrLangs.loading} error={ocrLangs.error}>
          <p className="count-note">
            {t('capture.ocrLangs')} {langSummary || t('capture.ocrLangsNone')}
          </p>
        </AsyncState>
        {!ocrLangs.loading && !hasChinese && langList.length > 0 && (
          <p className="mod-msg error">{t('capture.ocrNoChinese')}</p>
        )}
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <input
            className="mod-search"
            placeholder={t('capture.ocrFilePlaceholder')}
            value={ocrFile}
            onChange={(e) => setOcrFile(e.target.value)}
            style={{ minWidth: 320 }}
          />
          <button className="mini primary" disabled={busy !== null} onClick={runOcr}>
            {t('capture.ocrRun')}
          </button>
        </div>
        <Msg m={ocrMsg} />
        {ocrResult && (
          <textarea
            className="mod-search"
            readOnly
            value={ocrResult}
            style={{ width: '100%', minHeight: 120, marginTop: 8, fontFamily: 'monospace' }}
          />
        )}
      </div>
    </div>
  );
}
