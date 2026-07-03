import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — Text Extractor (OCR). Faithful port of WinForge's TextOcrModule, which is built
// on the BUILT-IN Windows OCR engine (Windows.Media.Ocr, WinRT) — no external tool, nothing to
// install. We drive that same WinRT engine from PowerShell inside the WinForge desktop app.
//   • list installed OCR languages + engine availability
//   • OCR an image file from disk (PNG/JPG/BMP/GIF/TIFF), preserving line layout
//   • copy / clear the recognised text, show line/word/char stats, keep an in-session history
//   • open Windows Language settings to add an OCR language pack

const esc = (s: string) => s.replace(/'/g, "''");

interface LangInfo {
  tag: string;
  name: string;
}

interface OcrResult {
  text: string;
  lines: number;
  words: number;
  chars: number;
}

interface HistoryItem {
  id: number;
  text: string;
  preview: string;
  source: string;
  time: string;
  lines: number;
  words: number;
}

// PowerShell that enumerates the OCR recognizer languages the engine can create.
function langScript(): string {
  return `[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { ` +
    `[pscustomobject]@{ tag=$_.LanguageTag; name=$_.DisplayName } }`;
}

// PowerShell that OCRs an image file via the built-in WinRT engine, preserving lines.
// Emits a single object { text; lines; words; chars }. Throws (non-zero + stderr) on failure.
function ocrScript(path: string, langTag: string | null): string {
  const langSel = langTag
    ? `$lang = New-Object Windows.Globalization.Language('${esc(langTag)}'); ` +
      `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang); ` +
      `if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }`
    : `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()`;
  return (
    `Add-Type -AssemblyName System.Runtime.WindowsRuntime; ` +
    `[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; ` +
    // Generic Await helper for WinRT IAsyncOperation<T>.
    `$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]; ` +
    `function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result } ` +
    `$path = '${esc(path)}'; ` +
    `if (-not (Test-Path -LiteralPath $path)) { throw 'Image not found: ' + $path } ` +
    langSel + `; ` +
    `if ($null -eq $engine) { throw 'No OCR language pack is installed. Add one in Windows Settings > Time and language > Language and region > (a language) > Language options > install the optional OCR feature.' } ` +
    `$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile]); ` +
    `$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]); ` +
    `$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]); ` +
    `$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]); ` +
    `$result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]); ` +
    `$lineList = @($result.Lines | ForEach-Object { $_.Text }); ` +
    `$text = if ($lineList.Count -gt 0) { [string]::Join([Environment]::NewLine, $lineList) } else { [string]$result.Text }; ` +
    `$words = 0; foreach ($ln in $result.Lines) { $words += $ln.Words.Count }; ` +
    `[pscustomobject]@{ text=$text; lines=$lineList.Count; words=$words; chars=$text.Length }`
  );
}

function statsFromText(text: string): { lines: number; words: number; chars: number } {
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
  const words = text.split(/[\s]+/).filter((w) => w.length > 0).length;
  return { lines, words, chars: text.length };
}

export function TextOcrModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [langs, setLangs] = useState<LangInfo[]>([]);
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [selLang, setSelLang] = useState<string>('');
  const [imgPath, setImgPath] = useState<string>('');
  const [result, setResult] = useState<string>('');
  const [stats, setStats] = useState<{ lines: number; words: number; chars: number } | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'info' | 'err'; msg: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [nextId, setNextId] = useState<number>(1);

  const loadLangs = async () => {
    if (!desktop) return;
    try {
      const list = await runPowershellJson<LangInfo>(langScript());
      const clean = list.filter((l) => l && typeof l.tag === 'string');
      setLangs(clean);
      setEngineOk(clean.length > 0);
    } catch {
      setLangs([]);
      setEngineOk(false);
    }
  };

  useEffect(() => {
    void loadLangs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runOcr = async () => {
    const path = imgPath.trim();
    if (!path || !desktop) return;
    setBusy(true);
    setStatus(null);
    try {
      const rows = await runPowershellJson<OcrResult>(ocrScript(path, selLang || null));
      const info = rows[0];
      if (!info) {
        setStatus({ kind: 'err', msg: t('textocr.ocrFailed') });
        return;
      }
      const text = typeof info.text === 'string' ? info.text : '';
      setResult(text);
      const s = statsFromText(text);
      setStats(s);
      const fileName = path.split(/[\\/]/).pop() || path;
      if (!text.trim()) {
        setStatus({ kind: 'info', msg: t('textocr.noText') });
        return;
      }
      const preview0 = text.replace(/[\r\n]+/g, ' ').trim();
      const preview = preview0.length > 120 ? preview0.slice(0, 120) + '…' : preview0;
      const now = new Date();
      const time = now.toLocaleTimeString();
      const item: HistoryItem = {
        id: nextId,
        text,
        preview,
        source: fileName,
        time,
        lines: info.lines ?? s.lines,
        words: info.words ?? s.words,
      };
      setNextId((n) => n + 1);
      setHistory((h) => [item, ...h].slice(0, 25));
      setStatus({
        kind: 'ok',
        msg: t('textocr.recognisedMsg', { lines: item.lines, words: item.words, source: fileName }),
      });
    } catch (e) {
      setResult('');
      setStats(null);
      setStatus({ kind: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(result);
        setStatus({ kind: 'ok', msg: t('textocr.copied') });
      }
    } catch {
      setStatus({ kind: 'err', msg: t('textocr.copyFailed') });
    }
  };

  const clearResult = () => {
    setResult('');
    setStats(null);
    setStatus(null);
  };

  const loadHistory = (item: HistoryItem) => {
    setResult(item.text);
    setStats(statsFromText(item.text));
    setStatus(null);
  };

  const openLangSettings = async () => {
    if (!desktop) return;
    try {
      await runPowershell(`Start-Process 'ms-settings:regionlanguage'`);
    } catch {
      /* best effort */
    }
  };

  const statsLabel = stats
    ? t('textocr.stats', { lines: stats.lines, words: stats.words, chars: stats.chars })
    : '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('textocr.blurb')}</p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('textocr.desktopOnly')}</p>}

      {desktop && engineOk === false && (
        <div className="panel dep-missing">
          <p style={{ margin: 0 }}>{t('textocr.noEngineTitle')}</p>
          <p className="count-note">{t('textocr.noEngineMsg')}</p>
          <div className="mod-toolbar">
            <button className="mini" onClick={openLangSettings}>{t('textocr.openLangSettings')}</button>
            <button className="mini" onClick={loadLangs}>{t('textocr.recheck')}</button>
          </div>
        </div>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textocr.langLabel')}</label>
        <select
          className="mod-select"
          value={selLang}
          onChange={(e) => setSelLang(e.target.value)}
          disabled={!desktop}
        >
          <option value="">{t('textocr.langAuto')}</option>
          {langs.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.tag.toLowerCase() === 'zh-hant' ? `${l.name} · 繁體中文 (zh-Hant)` : l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textocr.fileLabel')}</label>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 240 }}
          placeholder={t('textocr.filePlaceholder')}
          value={imgPath}
          onChange={(e) => setImgPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && !busy && runOcr()}
        />
        <button className="mini primary" disabled={!desktop || busy || !imgPath.trim()} onClick={runOcr}>
          {busy ? t('textocr.recognising') : t('textocr.recognise')}
        </button>
      </div>

      {status && (
        <p className={status.kind === 'err' ? 'error' : 'count-note'} style={{ marginTop: 4 }}>
          {status.msg}
        </p>
      )}

      <div className="panel">
        <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
          <span className="label">{t('textocr.resultHeader')}</span>
          <span className="mod-toolbar">
            <button className="mini" disabled={!result} onClick={copyResult}>{t('textocr.copy')}</button>
            <button className="mini" disabled={!result} onClick={clearResult}>{t('textocr.clear')}</button>
          </span>
        </div>
        <textarea
          className="hosts-edit"
          style={{ width: '100%', minHeight: 140, fontFamily: 'monospace', boxSizing: 'border-box' }}
          value={result}
          onChange={(e) => {
            setResult(e.target.value);
            setStats(statsFromText(e.target.value));
          }}
          placeholder={t('textocr.resultPlaceholder')}
        />
        {statsLabel && <p className="count-note" style={{ marginTop: 4 }}>{statsLabel}</p>}
      </div>

      <div className="panel">
        <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
          <span className="label">{t('textocr.historyHeader')}</span>
          {history.length > 0 && (
            <button className="mini" onClick={() => setHistory([])}>{t('textocr.historyClear')}</button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="count-note">{t('textocr.historyEmpty')}</p>
        ) : (
          <ul className="kv-list">
            {history.map((h) => (
              <li className="kv-row" key={h.id} style={{ cursor: 'pointer' }} onClick={() => loadHistory(h)}>
                <span className="value" style={{ flex: 1 }}>{h.preview || t('textocr.noText')}</span>
                <span className="count-note">
                  {h.source} · {h.time} · {t('textocr.historyMeta', { lines: h.lines, words: h.words })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="count-note">{t('textocr.note')}</p>
    </div>
  );
}
