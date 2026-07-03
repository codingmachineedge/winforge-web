import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — PowerToys Extras. Four in-app, PowerToys-style utilities that do real work through
// the WinForge desktop backend (Windows + .NET/WinRT via PowerShell), never a redirect:
//   • Image Resizer      — bulk fit-within resize (System.Drawing), aspect ratio always kept.
//   • Text Extractor/OCR — capture the whole virtual screen and run Windows.Media.Ocr, copy to clipboard.
//   • Always On Top      — SetWindowPos HWND_TOPMOST on a picked top-level window; toggle / un-pin all.
//   • Paste Plain Text   — strip all clipboard formatting so the next paste is clean plain text.
// The browser has none of these OS capabilities, so live actions run only inside the WinForge desktop app.

interface WinRow { handle: string; title: string; process: string }
interface ResizeRow { source: string; output: string; ok: boolean; message: string }

const esc = (s: string) => s.replace(/'/g, "''");

const PRESETS: { key: string; w: number; h: number }[] = [
  { key: 'small', w: 854, h: 480 },
  { key: 'medium', w: 1366, h: 768 },
  { key: 'large', w: 1920, h: 1080 },
  { key: 'phone', w: 1080, h: 1920 },
  { key: 'thumb', w: 256, h: 256 },
];

// ---- Image Resizer: fit-within resize via System.Drawing, mirrors ImageResizeService ----
function resizeScript(files: string[], outFolder: string, maxW: number, maxH: number, shrinkOnly: boolean, quality: number, suffix: string): string {
  const list = files.map((f) => `'${esc(f)}'`).join(',');
  return `Add-Type -AssemblyName System.Drawing;
$out='${esc(outFolder)}'; if(-not (Test-Path -LiteralPath $out)){ New-Item -ItemType Directory -Force -Path $out | Out-Null }
$maxW=${maxW}; $maxH=${maxH}; $shrink=$${shrinkOnly ? 'true' : 'false'}; $q=${quality}; $suffix='${esc(suffix)}';
$jpegCodec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1;
foreach($src in @(${list})){
  try{
    $img=[System.Drawing.Image]::FromFile($src);
    $ow=$img.Width; $oh=$img.Height;
    $scale=[Math]::Min($maxW/$ow, $maxH/$oh);
    if($shrink -and $scale -ge 1.0){ $scale=1.0 }
    $nw=[Math]::Max(1,[int][Math]::Round($ow*$scale)); $nh=[Math]::Max(1,[int][Math]::Round($oh*$scale));
    $bmp=New-Object System.Drawing.Bitmap($nw,$nh);
    $g=[System.Drawing.Graphics]::FromImage($bmp);
    $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
    $g.DrawImage($img,0,0,$nw,$nh); $g.Dispose();
    $ext=[System.IO.Path]::GetExtension($src); $base=[System.IO.Path]::GetFileNameWithoutExtension($src);
    $outName=$base+$suffix+$ext; $outPath=Join-Path $out $outName;
    $lext=$ext.ToLowerInvariant();
    if(($lext -eq '.jpg' -or $lext -eq '.jpeg') -and $jpegCodec){
      $ep=New-Object System.Drawing.Imaging.EncoderParameters(1);
      $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]([Math]::Max(1,[Math]::Min(100,$q))));
      $bmp.Save($outPath,$jpegCodec,$ep);
    } elseif($lext -eq '.png'){ $bmp.Save($outPath,[System.Drawing.Imaging.ImageFormat]::Png) }
    elseif($lext -eq '.bmp'){ $bmp.Save($outPath,[System.Drawing.Imaging.ImageFormat]::Bmp) }
    elseif($lext -eq '.gif'){ $bmp.Save($outPath,[System.Drawing.Imaging.ImageFormat]::Gif) }
    elseif($lext -eq '.tif' -or $lext -eq '.tiff'){ $bmp.Save($outPath,[System.Drawing.Imaging.ImageFormat]::Tiff) }
    else{ $bmp.Save($outPath,[System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp.Dispose(); $img.Dispose();
    [pscustomobject]@{source=$src;output=$outPath;ok=$true;message=''}
  } catch { [pscustomobject]@{source=$src;output='';ok=$false;message=$_.Exception.Message} }
}`;
}

// ---- Text Extractor / OCR: capture virtual screen, run Windows.Media.Ocr, copy text to clipboard ----
function ocrScript(): string {
  return `Add-Type -AssemblyName System.Drawing;
$sw=[System.Windows.Forms.SystemInformation]::VirtualScreen 2>$null;
if(-not $sw){ Add-Type -AssemblyName System.Windows.Forms; $sw=[System.Windows.Forms.SystemInformation]::VirtualScreen }
$bmp=New-Object System.Drawing.Bitmap($sw.Width,$sw.Height);
$g=[System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($sw.X,$sw.Y,0,0,$bmp.Size); $g.Dispose();
$tmp=[System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),'winforge_ocr.png');
$bmp.Save($tmp,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose();
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime];
$null=[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime];
function Await($t,[Type]$rt){ $m=[System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethodDefinition } | Select-Object -First 1; $g=$m.MakeGenericMethod($rt); $task=$g.Invoke($null,@($t)); $task.Wait(-1) | Out-Null; $task.Result }
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile]);
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]);
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]);
$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]);
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
if(-not $engine){ throw 'No OCR language pack is installed. Add one in Windows Settings.' }
$result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]);
$text=$result.Text;
if($text){ Set-Clipboard -Value $text }
Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue;
Write-Output $text`;
}

// ---- Always On Top: list top-level windows via EnumWindows P/Invoke ----
const WIN_PINVOKE = `Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class WfWin{
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint c);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 public static IntPtr TOP=new IntPtr(-1); public static IntPtr NOTOP=new IntPtr(-2);
 public static bool SetTop(long h,bool pin){ return SetWindowPos((IntPtr)h,pin?TOP:NOTOP,0,0,0,0,0x0003); }
 public static List<object> ListWins(){
  var r=new List<object>();
  EnumWindows((h,l)=>{
   if(!IsWindowVisible(h)) return true;
   if(GetWindow(h,4)!=IntPtr.Zero) return true;
   int ex=GetWindowLong(h,-20); if((ex & 0x00000080)!=0) return true;
   int len=GetWindowTextLength(h); if(len==0) return true;
   var sb=new StringBuilder(len+1); GetWindowText(h,sb,sb.Capacity);
   string title=sb.ToString(); if(string.IsNullOrWhiteSpace(title)) return true;
   uint pid; GetWindowThreadProcessId(h,out pid); string proc="";
   try{ proc=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }catch{}
   r.Add(new{ handle=((long)h).ToString(), title=title, proc=proc });
   return true;
  },IntPtr.Zero);
  return r;
 }
}
'@ -ErrorAction SilentlyContinue;`;

function listWinsScript(): string {
  return `${WIN_PINVOKE}
[WfWin]::ListWins() | ForEach-Object { [pscustomobject]@{handle=$_.handle;title=$_.title;process=$_.proc} }`;
}

function setTopScript(handle: string, pin: boolean): string {
  return `${WIN_PINVOKE}
[void][WfWin]::SetTop([long]${esc(handle)}, $${pin ? 'true' : 'false'})`;
}

// ---- Paste as Plain Text: replace clipboard contents with their plain-text equivalent ----
function stripClipboardScript(): string {
  return `$t=Get-Clipboard -Raw -TextFormatType Text -ErrorAction SilentlyContinue;
if([string]::IsNullOrEmpty($t)){ $t=Get-Clipboard -Raw -ErrorAction SilentlyContinue }
if([string]::IsNullOrEmpty($t)){ Write-Output 'NONE' } else { Set-Clipboard -Value $t; Write-Output 'OK' }`;
}

export function PowerToysExtrasModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tab, setTab] = useState<'resize' | 'ocr' | 'top' | 'paste'>('resize');

  // Image Resizer state
  const [files, setFiles] = useState<string>('');
  const [presetIdx, setPresetIdx] = useState(2);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [shrinkOnly, setShrinkOnly] = useState(true);
  const [quality, setQuality] = useState(90);
  const [suffix, setSuffix] = useState('-resized');
  const [outFolder, setOutFolder] = useState('');
  const [resizeRows, setResizeRows] = useState<ResizeRow[] | null>(null);
  const [resizeBusy, setResizeBusy] = useState(false);

  // OCR state
  const [ocrText, setOcrText] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);

  // Always On Top state
  const [wins, setWins] = useState<WinRow[] | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [topBusy, setTopBusy] = useState(false);

  // Paste state
  const [pasteBusy, setPasteBusy] = useState(false);

  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const notify = (kind: 'ok' | 'warn' | 'err', text: string) => setMsg({ kind, text });

  const fileList = () => files.split('\n').map((s) => s.trim()).filter(Boolean);

  const applyPreset = (i: number) => {
    setPresetIdx(i);
    const p = PRESETS[i];
    if (p) { setWidth(p.w); setHeight(p.h); }
  };

  const runResize = async () => {
    const list = fileList();
    if (list.length === 0) { notify('warn', t('ptextras.needImages')); return; }
    if (!outFolder.trim()) { notify('warn', t('ptextras.needOut')); return; }
    setResizeBusy(true); setMsg(null); setResizeRows(null);
    try {
      const w = Math.max(1, width || 1);
      const h = Math.max(1, height || 1);
      const q = Math.max(1, Math.min(100, quality || 90));
      const rows = await runPowershellJson<ResizeRow>(resizeScript(list, outFolder.trim(), w, h, shrinkOnly, q, suffix));
      setResizeRows(rows);
      const ok = rows.filter((r) => r.ok).length;
      const fail = rows.length - ok;
      if (fail === 0) notify('ok', t('ptextras.resizeDone', { ok, out: outFolder.trim() }));
      else {
        const firstErr = rows.find((r) => !r.ok)?.message ?? '';
        notify('warn', t('ptextras.resizePartial', { ok, fail, err: firstErr }));
      }
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
    finally { setResizeBusy(false); }
  };

  const runOcr = async () => {
    setOcrBusy(true); setMsg(null);
    try {
      const res = await runPowershell(ocrScript());
      if (!res.success && !res.stdout.trim()) {
        notify('err', res.stderr.trim() || `exit ${res.code}`);
      } else {
        const text = res.stdout.replace(/\r/g, '');
        setOcrText(text);
        if (!text.trim()) notify('warn', t('ptextras.ocrEmpty'));
        else notify('ok', t('ptextras.ocrCopied'));
      }
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
    finally { setOcrBusy(false); }
  };

  const copyOcr = async () => {
    if (!ocrText.trim()) return;
    try {
      await runPowershell(`Set-Clipboard -Value @'\n${ocrText}\n'@`);
      notify('ok', t('ptextras.copied'));
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
  };

  const refreshWins = async () => {
    setTopBusy(true); setMsg(null);
    try {
      const rows = await runPowershellJson<WinRow>(listWinsScript());
      setWins(rows);
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
    finally { setTopBusy(false); }
  };

  const togglePin = async (w: WinRow) => {
    const willPin = !pinned.has(w.handle);
    try {
      await runPowershell(setTopScript(w.handle, willPin));
      setPinned((prev) => {
        const next = new Set(prev);
        if (willPin) next.add(w.handle); else next.delete(w.handle);
        return next;
      });
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
  };

  const unpinAll = async () => {
    setTopBusy(true); setMsg(null);
    try {
      for (const h of pinned) {
        await runPowershell(setTopScript(h, false));
      }
      setPinned(new Set());
      notify('ok', t('ptextras.unpinned'));
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
    finally { setTopBusy(false); }
  };

  const stripClipboard = async () => {
    setPasteBusy(true); setMsg(null);
    try {
      const res = await runPowershell(stripClipboardScript());
      if (res.stdout.trim() === 'OK') notify('ok', t('ptextras.stripped'));
      else if (res.stdout.trim() === 'NONE') notify('warn', t('ptextras.noText'));
      else notify('err', res.stderr.trim() || `exit ${res.code}`);
    } catch (e) { notify('err', String(e instanceof Error ? e.message : e)); }
    finally { setPasteBusy(false); }
  };

  const count = fileList().length;

  return (
    <div className="mod">
      <p className="count-note">{t('ptextras.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('ptextras.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className={tab === 'resize' ? 'mini primary' : 'mini'} onClick={() => setTab('resize')}>{t('ptextras.tabResize')}</button>
        <button className={tab === 'ocr' ? 'mini primary' : 'mini'} onClick={() => setTab('ocr')}>{t('ptextras.tabOcr')}</button>
        <button className={tab === 'top' ? 'mini primary' : 'mini'} onClick={() => setTab('top')}>{t('ptextras.tabTop')}</button>
        <button className={tab === 'paste' ? 'mini primary' : 'mini'} onClick={() => setTab('paste')}>{t('ptextras.tabPaste')}</button>
      </div>

      {msg && (
        <p className={msg.kind === 'err' ? 'cmd-out error' : 'count-note'} style={{ color: msg.kind === 'ok' ? 'var(--ok, green)' : msg.kind === 'warn' ? 'var(--warn, orange)' : undefined }}>
          {msg.text}
        </p>
      )}

      {tab === 'resize' && (
        <div className="panel">
          <p className="count-note">{t('ptextras.resizeIntro')}</p>
          <label className="label">{t('ptextras.filesLabel')}</label>
          <textarea
            className="hosts-edit"
            style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }}
            placeholder={t('ptextras.filesPlaceholder')}
            value={files}
            onChange={(e) => setFiles(e.target.value)}
          />
          <p className="count-note">{t('ptextras.imageCount', { n: count })}</p>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="label">{t('ptextras.presetLabel')}</label>
            <select className="mod-select" value={presetIdx} onChange={(e) => applyPreset(+e.target.value)}>
              {PRESETS.map((p, i) => (
                <option key={p.key} value={i}>{t(`ptextras.preset_${p.key}`)} ({p.w}×{p.h})</option>
              ))}
            </select>
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="label">{t('ptextras.maxWidth')}</label>
            <input className="mod-search" type="number" min={1} style={{ maxWidth: 100 }} value={width} onChange={(e) => setWidth(+e.target.value)} />
            <label className="label">{t('ptextras.maxHeight')}</label>
            <input className="mod-search" type="number" min={1} style={{ maxWidth: 100 }} value={height} onChange={(e) => setHeight(+e.target.value)} />
            <label className="label">{t('ptextras.quality')}</label>
            <input className="mod-search" type="number" min={1} max={100} style={{ maxWidth: 80 }} value={quality} onChange={(e) => setQuality(+e.target.value)} />
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="chk"><input type="checkbox" checked={shrinkOnly} onChange={(e) => setShrinkOnly(e.target.checked)} /> {t('ptextras.shrinkOnly')}</label>
            <label className="label">{t('ptextras.suffix')}</label>
            <input className="mod-search" style={{ maxWidth: 140 }} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="label">{t('ptextras.outFolder')}</label>
            <input className="mod-search" style={{ minWidth: 260, flex: 1 }} placeholder="C:\\Users\\You\\Pictures\\WinForge Resized" value={outFolder} onChange={(e) => setOutFolder(e.target.value)} />
          </div>

          <button className="mini primary" disabled={!desktop || resizeBusy} onClick={runResize}>
            {resizeBusy ? t('ptextras.resizing') : t('ptextras.resizeAll')}
          </button>

          {resizeRows && (
            <div className="dt-wrap" style={{ marginTop: 10 }}>
              <table className="dt">
                <thead><tr><th>{t('ptextras.colSource')}</th><th>{t('ptextras.colOutput')}</th><th>{t('ptextras.colStatus')}</th></tr></thead>
                <tbody>
                  {resizeRows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'monospace' }}>{r.source}</td>
                      <td style={{ fontFamily: 'monospace' }}>{r.ok ? r.output : '—'}</td>
                      <td className={r.ok ? 'dep-ok' : 'dep-missing'}>{r.ok ? t('ptextras.ok') : r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'ocr' && (
        <div className="panel">
          <p className="count-note">{t('ptextras.ocrIntro')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini primary" disabled={!desktop || ocrBusy} onClick={runOcr}>{ocrBusy ? t('ptextras.extracting') : t('ptextras.extract')}</button>
            <button className="mini" disabled={!desktop || !ocrText.trim()} onClick={copyOcr}>{t('ptextras.copyText')}</button>
            <button className="mini" disabled={!ocrText} onClick={() => setOcrText('')}>{t('ptextras.clear')}</button>
          </div>
          <p className="count-note">{t('ptextras.ocrHint')}</p>
          {ocrText && <pre className="cmd-out">{ocrText}</pre>}
        </div>
      )}

      {tab === 'top' && (
        <div className="panel">
          <p className="count-note">{t('ptextras.topIntro')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini primary" disabled={!desktop || topBusy} onClick={refreshWins}>{topBusy ? t('ptextras.loading') : t('ptextras.refresh')}</button>
            <button className="mini" disabled={!desktop || pinned.size === 0} onClick={unpinAll}>{t('ptextras.unpinAll')}</button>
            <span className="count-note">{t('ptextras.pinnedCount', { n: pinned.size })}</span>
          </div>
          {wins && (
            <div className="dt-wrap">
              <table className="dt">
                <thead><tr><th>{t('ptextras.colWindow')}</th><th>{t('ptextras.colProcess')}</th><th></th></tr></thead>
                <tbody>
                  {wins.map((w) => {
                    const on = pinned.has(w.handle);
                    return (
                      <tr key={w.handle}>
                        <td>{w.title}</td>
                        <td style={{ fontFamily: 'monospace' }}>{w.process}</td>
                        <td>
                          <button className={on ? 'mini primary' : 'mini'} disabled={!desktop} onClick={() => togglePin(w)}>
                            {on ? t('ptextras.onTop') : t('ptextras.pinOnTop')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'paste' && (
        <div className="panel">
          <p className="count-note">{t('ptextras.pasteIntro')}</p>
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('ptextras.stripTitle')}</span>
              <span className="value">{t('ptextras.stripBlurb')}</span>
            </div>
          </div>
          <button className="mini primary" disabled={!desktop || pasteBusy} onClick={stripClipboard}>
            {pasteBusy ? t('ptextras.stripping') : t('ptextras.stripNow')}
          </button>
        </div>
      )}

      <p className="count-note">{t('ptextras.note')}</p>
    </div>
  );
}
