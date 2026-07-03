import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Port of WinForge's Clipboard module (Pages/ClipboardModule.xaml + Services/ClipboardService.cs):
// clipboard history for text, images and copied files, captured live through the Tauri backend
// (Windows PowerShell 5.1: Get-Clipboard / WinForms Clipboard). Copy back, copy as plain text
// (formatting stripped), delete, clear all. "Watch" mirrors the desktop background monitor by
// polling while the app is open; history persists locally (the desktop kept it in %LocalAppData%).

interface ClipFile {
  Path: string;
  Size: number;
  IsDir: boolean;
  Exists: boolean;
}

interface ClipSnapshot {
  Kind: 'Empty' | 'Text' | 'Image' | 'Files';
  Text: string;
  Chars: number;
  LineCount: number;
  Truncated: boolean;
  ImgB64: string; // PNG thumbnail (max 320px on the long edge), base64
  ImgW: number;
  ImgH: number;
  Files: ClipFile[];
  Formats: string[];
  HasHtml: boolean;
  HasRtf: boolean;
  Time: string;
}

interface Entry {
  id: string;
  sig: string;
  kind: 'Text' | 'Image' | 'Files';
  time: string;
  text: string;
  chars: number;
  lineCount: number;
  truncated: boolean;
  imgB64: string;
  imgW: number;
  imgH: number;
  files: ClipFile[];
}

const STORE_KEY = 'winforge.clipboard.history.v1';
const MAX_ITEMS = 200; // same cap as the desktop ClipboardService
const POLL_MS = 3000;

// Read the clipboard once: kind (image > files > text, same priority as the desktop Capture()),
// a PNG thumbnail for images, per-file size/existence for file drops, plain text (capped at
// 32,000 chars for transport) plus HTML/RTF presence and the raw format list. Read-only.
const SNAPSHOT_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$kind='Empty'; $text=''; $chars=0; $lineCount=0; $trunc=$false
$imgB64=''; $imgW=0; $imgH=0
$files=@(); $fmts=@(); $hasHtml=$false; $hasRtf=$false
try { $dobj=[System.Windows.Forms.Clipboard]::GetDataObject(); if ($dobj) { $fmts=@($dobj.GetFormats() | ForEach-Object { [string]$_ }) } } catch {}
try { $hasHtml=[System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::Html) } catch {}
try { $hasRtf=[System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::Rtf) } catch {}
$img=$null
try { $img=Get-Clipboard -Format Image -ErrorAction SilentlyContinue } catch {}
if ($img) {
  $kind='Image'
  try {
    $imgW=[int]$img.Width; $imgH=[int]$img.Height
    $mx=[Math]::Max($imgW,$imgH); $scale=1.0; if ($mx -gt 320) { $scale=320.0/$mx }
    $tw=[Math]::Max(1,[int][Math]::Floor($imgW*$scale)); $th=[Math]::Max(1,[int][Math]::Floor($imgH*$scale))
    $thumb=New-Object System.Drawing.Bitmap($img,$tw,$th)
    $ms=New-Object System.IO.MemoryStream
    $thumb.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
    $imgB64=[System.Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose(); $thumb.Dispose()
  } catch {}
  $img.Dispose()
} else {
  $fl=$null
  try { $fl=Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue } catch {}
  if ($fl -and @($fl).Count -gt 0) {
    $kind='Files'
    $files=@(@($fl) | ForEach-Object {
      $p=''
      if ($_ -is [string]) { $p=$_ } elseif ($_.PSObject.Properties['FullName']) { $p=[string]$_.FullName } else { $p=[string]$_ }
      $sz=[long]0; $dir=$false; $ex=$false
      $it=Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
      if ($it) { $ex=$true; $dir=[bool]$it.PSIsContainer; if (-not $dir) { $sz=[long]$it.Length } }
      New-Object PSObject -Property @{ Path=$p; Size=$sz; IsDir=$dir; Exists=$ex }
    })
  } else {
    $t=$null
    try { $t=Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
    if ($t -ne $null) { $t=[string]$t }
    if ($t) {
      $kind='Text'; $text=$t; $chars=$text.Length
      $lineCount=([regex]::Matches($text,'\n')).Count + 1
      if ($chars -gt 32000) { $text=$text.Substring(0,32000); $trunc=$true }
    }
  }
}
New-Object PSObject -Property @{ Kind=$kind; Text=$text; Chars=$chars; LineCount=$lineCount; Truncated=$trunc; ImgB64=$imgB64; ImgW=$imgW; ImgH=$imgH; Files=$files; Formats=$fmts; HasHtml=$hasHtml; HasRtf=$hasRtf; Time=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
`;

function sigOf(s: ClipSnapshot): string {
  if (s.Kind === 'Image') {
    const b = s.ImgB64 ?? '';
    return 'I|' + s.ImgW + 'x' + s.ImgH + '|' + b.length + '|' + b.slice(0, 80);
  }
  if (s.Kind === 'Files') return 'F|' + (s.Files ?? []).map((f) => f.Path).join('|');
  if (s.Kind === 'Text') return 'T|' + s.Chars + '|' + s.Text;
  return 'E';
}

function textSig(text: string): string {
  return 'T|' + text.length + '|' + text.slice(0, 32000);
}

function entryOf(s: ClipSnapshot, sig: string): Entry {
  return {
    id: s.Time + '-' + Math.random().toString(36).slice(2, 8),
    sig,
    kind: s.Kind === 'Image' ? 'Image' : s.Kind === 'Files' ? 'Files' : 'Text',
    time: s.Time,
    text: s.Text ?? '',
    chars: s.Chars ?? 0,
    lineCount: s.LineCount ?? 0,
    truncated: s.Truncated === true,
    imgB64: s.ImgB64 ?? '',
    imgW: s.ImgW ?? 0,
    imgH: s.ImgH ?? 0,
    files: Array.isArray(s.Files) ? s.Files : [],
  };
}

function normFile(v: unknown): ClipFile[] {
  if (typeof v !== 'object' || v === null) return [];
  const f = v as Record<string, unknown>;
  if (typeof f.Path !== 'string') return [];
  return [
    {
      Path: f.Path,
      Size: typeof f.Size === 'number' ? f.Size : 0,
      IsDir: f.IsDir === true,
      Exists: f.Exists !== false,
    },
  ];
}

function normEntry(v: unknown): Entry[] {
  if (typeof v !== 'object' || v === null) return [];
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'Text' && kind !== 'Image' && kind !== 'Files') return [];
  return [
    {
      id: typeof o.id === 'string' ? o.id : 'e-' + Math.random().toString(36).slice(2, 10),
      sig: typeof o.sig === 'string' ? o.sig : '',
      kind,
      time: typeof o.time === 'string' ? o.time : '',
      text: typeof o.text === 'string' ? o.text : '',
      chars: typeof o.chars === 'number' ? o.chars : 0,
      lineCount: typeof o.lineCount === 'number' ? o.lineCount : 0,
      truncated: o.truncated === true,
      imgB64: typeof o.imgB64 === 'string' ? o.imgB64 : '',
      imgW: typeof o.imgW === 'number' ? o.imgW : 0,
      imgH: typeof o.imgH === 'number' ? o.imgH : 0,
      files: Array.isArray(o.files) ? o.files.flatMap(normFile) : [],
    },
  ];
}

function loadHistory(): Entry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(normEntry).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + (units[u] ?? 'TB');
}

function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/** Write plain text to the system clipboard: webview API first, PowerShell Set-Clipboard fallback. */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the native bridge */
  }
  if (!isTauri()) return false;
  const b64 = toB64(text);
  if (b64.length > 24000) return false; // stay clear of the Windows command-line length limit
  const res = await runPowershell(
    "$t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" +
      b64 +
      "')); Set-Clipboard -Value $t",
  );
  return res.success;
}

/** Put a PNG (base64) back on the clipboard via the async clipboard API. */
async function copyPngToClipboard(b64: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined') return false;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

export function ClipboardModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [armClear, setArmClear] = useState(false);
  const [history, setHistory] = useState<Entry[]>(loadHistory);

  const inFlight = useRef(false);
  const manualRef = useRef(false);
  const lastSeen = useRef<string | null>(null);
  const suppressImgUntil = useRef(0);
  const armTimer = useRef(0);
  const historyRef = useRef<Entry[]>(history);

  const { data, loading, error, reload } = useAsync<ClipSnapshot | null>(async () => {
    if (!isTauri()) return null;
    inFlight.current = true;
    try {
      const rows = await runPowershellJson<ClipSnapshot>(SNAPSHOT_PS);
      return rows[0] ?? null;
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Persist history locally (the desktop service kept a manifest in %LocalAppData%\WinForge).
  useEffect(() => {
    try {
      let arr = history;
      let json = JSON.stringify(arr);
      while (json.length > 3_500_000 && arr.length > 1) {
        arr = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
        json = JSON.stringify(arr);
      }
      localStorage.setItem(STORE_KEY, json);
    } catch {
      /* quota exceeded / private mode — history stays in memory */
    }
  }, [history]);

  // Change monitor: every snapshot that differs from the last seen clipboard state is captured
  // into history (dedup against the newest entry, like the desktop monitor did for text).
  useEffect(() => {
    if (!data) return;
    const manual = manualRef.current;
    manualRef.current = false;
    if (data.Kind === 'Empty') {
      lastSeen.current = 'E';
      if (manual) setMsg(t('clipboard.nowEmpty'));
      return;
    }
    const sig = sigOf(data);
    const changed = sig !== lastSeen.current;
    lastSeen.current = sig;
    if (data.Kind === 'Image' && Date.now() < suppressImgUntil.current) {
      suppressImgUntil.current = 0; // one-shot: skip re-capturing an image we just copied back
      return;
    }
    if (!changed && !manual) return;
    const top = historyRef.current[0];
    if (top && top.sig === sig) {
      if (manual) setMsg(t('clipboard.alreadyTop'));
      return;
    }
    setHistory((h) => {
      const cur = h[0];
      if (cur && cur.sig === sig) return h;
      return [entryOf(data, sig), ...h].slice(0, MAX_ITEMS);
    });
    if (manual) setMsg(t('clipboard.capturedMsg'));
  }, [data, t]);

  // Watch mode = the desktop background monitor, expressed as polling while the app is open.
  useEffect(() => {
    if (!watching || !isTauri()) return;
    const id = window.setInterval(() => {
      if (!inFlight.current) reload();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [watching, reload]);

  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  const captureNow = () => {
    manualRef.current = true;
    setMsg(null);
    reload();
  };

  const clearAll = () => {
    if (!armClear) {
      setArmClear(true);
      window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmClear(false), 4000);
      return;
    }
    window.clearTimeout(armTimer.current);
    setArmClear(false);
    setHistory([]);
    setMsg(t('clipboard.clearedMsg'));
  };

  const removeEntry = (id: string) => setHistory((h) => h.filter((e) => e.id !== id));

  const copyEntryBack = async (e: Entry) => {
    setMsg(null);
    let ok = false;
    if (e.kind === 'Image') {
      ok = e.imgB64 ? await copyPngToClipboard(e.imgB64) : false;
      if (ok) suppressImgUntil.current = Date.now() + 12000;
    } else {
      const payload = e.kind === 'Files' ? e.files.map((f) => f.Path).join('\r\n') : e.text;
      ok = await copyTextToClipboard(payload);
      if (ok) lastSeen.current = textSig(payload);
    }
    setMsg(ok ? t('clipboard.copied') : t('clipboard.copyFailed'));
  };

  // "Copy as plain text" — the desktop CopyPlainText: writing plain text drops HTML/RTF formats.
  const copyPlainNow = async (s: ClipSnapshot) => {
    setMsg(null);
    const payload = s.Kind === 'Files' ? s.Files.map((f) => f.Path).join('\r\n') : s.Text;
    const ok = await copyTextToClipboard(payload);
    if (ok) lastSeen.current = textSig(payload);
    setMsg(ok ? t('clipboard.plainDone') : t('clipboard.copyFailed'));
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return history;
    return history.filter((e) =>
      (e.text + ' ' + e.files.map((f) => f.Path).join(' ') + ' ' + e.kind + ' ' + e.time)
        .toLowerCase()
        .includes(q),
    );
  }, [history, filter]);

  const kindLabel = (k: string) =>
    k === 'Image'
      ? t('clipboard.kindImage')
      : k === 'Files'
        ? t('clipboard.kindFiles')
        : k === 'Empty'
          ? t('clipboard.kindEmpty')
          : t('clipboard.kindText');

  const infoOf = (e: Entry): string => {
    if (e.kind === 'Image') return t('clipboard.dims', { w: e.imgW, h: e.imgH });
    if (e.kind === 'Files') {
      const total = e.files.reduce((a, f) => a + (f.IsDir ? 0 : f.Size), 0);
      return t('clipboard.filesN', { n: e.files.length }) + ' · ' + fmtBytes(total);
    }
    const base =
      t('clipboard.chars', { n: e.chars }) + ' · ' + t('clipboard.lines', { n: e.lineCount });
    return e.truncated ? base + ' · ' + t('clipboard.truncShort') : base;
  };

  const columns: Column<Entry>[] = [
    { key: 'kind', header: t('clipboard.typeLabel'), width: 80, render: (e) => kindLabel(e.kind) },
    {
      key: 'preview',
      header: t('clipboard.preview'),
      render: (e) => {
        if (e.kind === 'Image') {
          return e.imgB64 ? (
            <img
              src={'data:image/png;base64,' + e.imgB64}
              alt=""
              style={{ maxHeight: 44, maxWidth: 160, borderRadius: 4, display: 'block' }}
            />
          ) : (
            <span className="count-note">{t('clipboard.dims', { w: e.imgW, h: e.imgH })}</span>
          );
        }
        if (e.kind === 'Files') {
          const first = e.files[0];
          return (
            <span style={{ wordBreak: 'break-all' }}>
              <code>{first ? first.Path : ''}</code>
              {e.files.length > 1 && (
                <span className="count-note"> {t('clipboard.moreFiles', { n: e.files.length - 1 })}</span>
              )}
              {first && !first.Exists && (
                <span className="count-note" style={{ color: 'var(--danger)' }}>
                  {' '}
                  ({t('clipboard.missing')})
                </span>
              )}
            </span>
          );
        }
        const txt = e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text;
        return (
          <code
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {txt}
          </code>
        );
      },
    },
    { key: 'info', header: t('clipboard.details'), width: 170, render: (e) => infoOf(e) },
    { key: 'time', header: t('clipboard.capturedLabel'), width: 150, render: (e) => e.time },
    {
      key: 'actions',
      header: '',
      width: 160,
      render: (e) => (
        <span className="row-actions">
          <button
            className="mini"
            disabled={e.kind === 'Image' && !e.imgB64}
            onClick={() => copyEntryBack(e)}
            title={t('clipboard.copyBack')}
          >
            {t('clipboard.copyBack')}
          </button>
          <button className="mini danger" onClick={() => removeEntry(e.id)}>
            {t('clipboard.delete')}
          </button>
        </span>
      ),
    },
  ];

  const snap = data;
  const contentSummary = (s: ClipSnapshot): string => {
    if (s.Kind === 'Image') return t('clipboard.dims', { w: s.ImgW, h: s.ImgH });
    if (s.Kind === 'Files') return t('clipboard.filesN', { n: s.Files.length });
    return t('clipboard.chars', { n: s.Chars });
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={captureNow} disabled={loading}>
          {t('clipboard.captureNow')}
        </button>
        <button
          className={watching ? 'mini primary' : 'mini'}
          onClick={() => setWatching((w) => !w)}
        >
          {watching ? t('clipboard.watchStop') : t('clipboard.watchStart')}
        </button>
        <button className="mini" onClick={() => reload()} disabled={loading}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini danger" onClick={clearAll} disabled={history.length === 0}>
          {armClear ? t('clipboard.clearConfirm') : t('clipboard.clearAll')}
        </button>
        <input
          className="mod-search"
          placeholder={t('clipboard.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count-note">{t('clipboard.itemsNote', { n: rows.length })}</span>
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('clipboard.blurb')} {t('clipboard.watchNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      {error && <pre className="cmd-out error">{error}</pre>}

      <h3
        className="group-title"
        style={{ fontSize: 15, margin: '14px 0 8px', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        {t('clipboard.nowTitle')}
        <StatusDot
          ok={watching}
          label={watching ? t('clipboard.watching') : t('clipboard.notWatching')}
        />
      </h3>

      {snap && snap.Kind !== 'Empty' ? (
        <div>
          <div className="gauges" style={{ marginBottom: 10 }}>
            <div className="gauge">
              <div className="label">{t('clipboard.typeLabel')}</div>
              <div className="value">{kindLabel(snap.Kind)}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('clipboard.contentLabel')}</div>
              <div className="value" style={{ fontSize: 16 }}>
                {contentSummary(snap)}
              </div>
            </div>
            <div className="gauge">
              <div className="label">{t('clipboard.formatsLabel')}</div>
              <div className="value">{snap.Formats.length}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('clipboard.capturedLabel')}</div>
              <div className="value" style={{ fontSize: 16 }}>
                {snap.Time}
              </div>
            </div>
          </div>

          <p style={{ margin: '0 0 8px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {snap.HasHtml && <span className="badge tone-warn">{t('clipboard.richHtml')}</span>}
            {snap.HasRtf && <span className="badge tone-warn">{t('clipboard.richRtf')}</span>}
            {snap.Truncated && <span className="badge">{t('clipboard.truncatedBadge')}</span>}
            {(snap.Kind === 'Text' || snap.Kind === 'Files') && (
              <button className="mini" onClick={() => copyPlainNow(snap)}>
                {t('clipboard.copyPlain')}
              </button>
            )}
          </p>

          {snap.Kind === 'Text' && (
            <pre className="cmd-out" style={{ maxHeight: 180, overflow: 'auto' }}>
              {snap.Text.length > 2000 ? snap.Text.slice(0, 2000) + '…' : snap.Text}
            </pre>
          )}
          {snap.Kind === 'Image' && snap.ImgB64 && (
            <img
              src={'data:image/png;base64,' + snap.ImgB64}
              alt=""
              style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 6, display: 'block' }}
            />
          )}
          {snap.Kind === 'Files' && (
            <div className="dt-wrap">
              <table className="dt">
                <tbody>
                  {snap.Files.slice(0, 20).map((f, i) => (
                    <tr key={i + '-' + f.Path}>
                      <td style={{ wordBreak: 'break-all' }}>
                        <code>{f.Path}</code>
                      </td>
                      <td style={{ width: 110, textAlign: 'right' }}>
                        {f.IsDir ? t('clipboard.dirBadge') : fmtBytes(f.Size)}
                      </td>
                      <td style={{ width: 90, color: 'var(--danger)' }}>
                        {f.Exists ? '' : t('clipboard.missing')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snap.Files.length > 20 && (
                <p className="count-note">{t('clipboard.moreFiles', { n: snap.Files.length - 20 })}</p>
              )}
            </div>
          )}

          {snap.Formats.length > 0 && (
            <p className="count-note">
              {t('clipboard.formatsList', {
                list:
                  snap.Formats.slice(0, 14).join(', ') + (snap.Formats.length > 14 ? ', …' : ''),
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="count-note">
          {snap ? t('clipboard.nowEmpty') : loading ? t('modules.loading') : t('clipboard.hint')}
        </p>
      )}

      <h3 className="group-title" style={{ fontSize: 15, margin: '18px 0 8px' }}>
        {t('clipboard.historyTitle')}
      </h3>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        empty={t('clipboard.empty')}
      />
    </div>
  );
}
