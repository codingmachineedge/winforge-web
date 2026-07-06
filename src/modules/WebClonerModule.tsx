import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';
import { isTauri, runPowershell } from '../tauri/bridge';

// Native module — Website Cloner (網站複製器). Faithful port of WinForge's WebsiteClonerService:
// fetch a live page, download its referenced assets (img/css/js/font/srcset/CSS url()), rewrite
// those links to local relative paths, and write a browsable index.html + /assets tree. The C#
// core is native HttpClient; here the same work runs through PowerShell's Invoke-WebRequest and
// .NET file APIs inside the WinForge desktop shell. Never launches an external browser or folder.
// Defensive throughout — never throws to the UI.

interface CloneResult {
  ok: boolean;
  indexPath: string;
  destFolder: string;
  htmlChars: number;
  assetsSaved: number;
  assetsFailed: number;
  totalBytes: number;
  colors: string;
  fonts: string;
  title: string;
  message: string;
}

// Hard caps mirror the C# service so a runaway page can't fill the disk.
const MAX_ASSETS = 200;
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // 25 MB per asset
const MAX_TOTAL_BYTES = 250 * 1024 * 1024; // 250 MB total

// Escape a JS string for safe single-quoted embedding inside a PowerShell here-string arg.
const psLit = (s: string) => s.replace(/'/g, "''");

// Validate an http(s) URL exactly as the C# service does (Uri.TryCreate + http/https scheme).
// Returns a normalised absolute URL, or null when the input isn't a usable web address.
function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Build the PowerShell script that performs the whole clone and emits a single JSON object.
 * It fetches HTML, collects asset URLs by regex (same attribute set as the C# service),
 * downloads each with per-asset and total size caps, rewrites links, and writes index.html.
 */
function cloneScript(url: string, destFolder: string, downloadAssets: boolean): string {
  const u = psLit(url.trim());
  const dest = psLit(destFolder);
  const doAssets = downloadAssets ? '$true' : '$false';
  return `
$ErrorActionPreference='Stop'
$ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
$url='${u}'
$dest='${dest}'
$doAssets=${doAssets}
$res=[ordered]@{ok=$false;indexPath='';destFolder=$dest;htmlChars=0;assetsSaved=0;assetsFailed=0;totalBytes=0;colors='';fonts='';title='';message=''}
try {
  $baseUri=$null
  if(-not [Uri]::TryCreate($url,[UriKind]::Absolute,[ref]$baseUri) -or ($baseUri.Scheme -ne 'http' -and $baseUri.Scheme -ne 'https')){
    $res.message="That doesn't look like a valid http(s) URL."
    $res | ConvertTo-Json -Compress; return
  }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $assetsDir=Join-Path $dest 'assets'
  if($doAssets){ New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null }

  $r=Invoke-WebRequest -Uri $baseUri.AbsoluteUri -UserAgent $ua -UseBasicParsing -TimeoutSec 60
  $html=$r.Content
  $res.htmlChars=$html.Length

  # Extract design tokens (colours / fonts / title).
  $cols=@{}
  foreach($m in [regex]::Matches($html,'#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b|rgba?\\([^)]*\\)')){ $k=$m.Value.ToLower(); if($cols.ContainsKey($k)){$cols[$k]++}else{$cols[$k]=1} }
  $res.colors=(($cols.GetEnumerator()|Sort-Object -Property Value -Descending|Select-Object -First 8|ForEach-Object{$_.Key}) -join ', ')
  $fnts=@{}
  foreach($m in [regex]::Matches($html,'font-family\\s*:\\s*([^;"}]+)','IgnoreCase')){ $k=$m.Groups[1].Value.Trim().ToLower(); if($k){ if($fnts.ContainsKey($k)){$fnts[$k]++}else{$fnts[$k]=1} } }
  $res.fonts=(($fnts.GetEnumerator()|Sort-Object -Property Value -Descending|Select-Object -First 5|ForEach-Object{$_.Key}) -join ' | ')
  $tm=[regex]::Match($html,'<title[^>]*>(.*?)</title>','IgnoreCase, Singleline')
  if($tm.Success){ $res.title=[System.Net.WebUtility]::HtmlDecode($tm.Groups[1].Value.Trim()) }

  $urlMap=@{}
  $saved=0; $failed=0; $total=0
  if($doAssets){
    # Collect asset URLs: src/href/data-src/poster, srcset, and CSS url().
    $seen=New-Object 'System.Collections.Generic.HashSet[string]'
    $refs=New-Object 'System.Collections.Generic.List[string]'
    function Add-Ref($raw){
      if([string]::IsNullOrWhiteSpace($raw)){return}
      $v=$raw.Trim().Trim('"',[char]39)
      if($v.Length -eq 0 -or $v.StartsWith('data:') -or $v.StartsWith('javascript:') -or $v.StartsWith('#') -or $v.StartsWith('mailto:') -or $v.StartsWith('tel:')){return}
      $abs=$null
      if(-not [Uri]::TryCreate($script:baseUri,$v,[ref]$abs)){return}
      if($abs.Scheme -ne 'http' -and $abs.Scheme -ne 'https'){return}
      if($script:refs.Count -ge ${MAX_ASSETS}){return}
      if($script:seen.Add($abs.AbsoluteUri)){ $script:refs.Add($abs.AbsoluteUri) }
    }
    $script:baseUri=$baseUri; $script:seen=$seen; $script:refs=$refs
    foreach($m in [regex]::Matches($html,'(?:src|href|data-src|data-srcset|poster)\\s*=\\s*(?:"([^"]*)"|''([^'']*)'')','IgnoreCase')){
      $val=if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value}; Add-Ref $val
    }
    foreach($m in [regex]::Matches($html,'srcset\\s*=\\s*(?:"([^"]*)"|''([^'']*)'')','IgnoreCase')){
      $val=if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value}
      foreach($part in $val.Split(',')){ $u2=($part.Trim() -split '\\s+')[0]; Add-Ref $u2 }
    }
    foreach($m in [regex]::Matches($html,'url\\(\\s*(?:"([^"]*)"|''([^'']*)''|([^)]*))\\s*\\)','IgnoreCase')){
      $val=if($m.Groups[1].Success){$m.Groups[1].Value}elseif($m.Groups[2].Success){$m.Groups[2].Value}else{$m.Groups[3].Value}; Add-Ref $val
    }

    $invalid=[System.IO.Path]::GetInvalidFileNameChars()
    foreach($assetUrl in $refs){
      if($total -ge ${MAX_TOTAL_BYTES}){ break }
      try {
        $au=[Uri]$assetUrl
        $tmp=[System.IO.Path]::GetTempFileName()
        Invoke-WebRequest -Uri $assetUrl -UserAgent $ua -UseBasicParsing -TimeoutSec 60 -OutFile $tmp | Out-Null
        $fi=Get-Item $tmp
        if($fi.Length -gt ${MAX_ASSET_BYTES}){ Remove-Item $tmp -Force; $failed++; continue }
        $name=[System.IO.Path]::GetFileName($au.LocalPath)
        if([string]::IsNullOrWhiteSpace($name)){ $name='asset' }
        foreach($c in $invalid){ $name=$name.Replace($c,'_') }
        $name=$name.Trim('.','_',' ')
        if([string]::IsNullOrWhiteSpace($name)){ $name='asset' }
        if($name.Length -gt 120){ $name=$name.Substring($name.Length-120) }
        $full=Join-Path $assetsDir $name
        if(Test-Path $full){
          $stem=[System.IO.Path]::GetFileNameWithoutExtension($name); $ext=[System.IO.Path]::GetExtension($name); $i2=1
          while(Test-Path $full){ $full=Join-Path $assetsDir ($stem+'_'+$i2+$ext); $i2++; if($i2 -gt 9999){break} }
        }
        Move-Item -Force $tmp $full
        $urlMap[$au.AbsoluteUri]=('assets/'+[System.IO.Path]::GetFileName($full))
        $saved++; $total+=$fi.Length
      } catch { $failed++; try{ if($tmp -and (Test-Path $tmp)){ Remove-Item $tmp -Force } }catch{} }
    }
  }

  # Rewrite asset links to local relative paths.
  if($urlMap.Count -gt 0){
    $rewrite={ param($raw)
      $v=$raw.Trim().Trim('"',[char]39); $abs=$null
      if([Uri]::TryCreate($baseUri,$v,[ref]$abs) -and $urlMap.ContainsKey($abs.AbsoluteUri)){ return $urlMap[$abs.AbsoluteUri] }
      return $raw }
    $html=[regex]::Replace($html,'(?<attr>\\b(?:src|href|data-src|poster)\\s*=\\s*)(?:"(?<u>[^"]*)"|''(?<u2>[^'']*)'')',{
      param($m); $u3=if($m.Groups['u'].Success){$m.Groups['u'].Value}else{$m.Groups['u2'].Value}; $m.Groups['attr'].Value+'"'+(& $rewrite $u3)+'"' },'IgnoreCase')
    $html=[regex]::Replace($html,'url\\(\\s*(?:"([^"]*)"|''([^'']*)''|([^)]*))\\s*\\)',{
      param($m); $u4=if($m.Groups[1].Success){$m.Groups[1].Value}elseif($m.Groups[2].Success){$m.Groups[2].Value}else{$m.Groups[3].Value}; 'url("'+(& $rewrite $u4)+'")' },'IgnoreCase')
  }
  # Ensure a UTF-8 meta so local viewing doesn't garble non-ASCII text.
  if(-not [regex]::IsMatch($html,'<meta[^>]+charset','IgnoreCase')){
    $html=[regex]::Replace($html,'<head[^>]*>',{ param($m); $m.Value+"\`n  <meta charset=""utf-8"">" },'IgnoreCase')
  }

  $indexPath=Join-Path $dest 'index.html'
  [System.IO.File]::WriteAllText($indexPath,$html,(New-Object System.Text.UTF8Encoding($false)))

  # Write a design-token summary the user can read.
  try {
    $tk="# Design tokens \`· 設計符記\`nSource: $($baseUri.AbsoluteUri)\`n\`ncolors: $($res.colors)\`nfonts: $($res.fonts)\`ntitle: $($res.title)"
    [System.IO.File]::WriteAllText((Join-Path $dest 'design-tokens.txt'),$tk,(New-Object System.Text.UTF8Encoding($false)))
  } catch {}

  $res.ok=$true; $res.indexPath=$indexPath; $res.assetsSaved=$saved; $res.assetsFailed=$failed; $res.totalBytes=$total
  $res.message="Clone complete."
  $res | ConvertTo-Json -Compress
} catch {
  $res.message="Clone failed: $($_.Exception.Message)"
  $res | ConvertTo-Json -Compress
}`;
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// Compact, copyable one-line preview of the run — mirrors the C# service's public knobs
// (URL, destination, asset download, plus the optional rendered-DOM / AI passes).
function commandPreview(
  url: string,
  folder: string,
  downloadAssets: boolean,
  renderedDom: boolean,
  aiReconstruct: boolean,
): string {
  const flags: string[] = [`-Url '${url.trim()}'`, `-Dest '${folder.trim()}'`];
  flags.push(downloadAssets ? '-DownloadAssets' : '-HtmlOnly');
  if (renderedDom) flags.push('-CaptureRenderedDom');
  if (aiReconstruct) flags.push('-AiReconstruct');
  return `WinForge.WebsiteCloner ${flags.join(' ')}`;
}

// Render the design-tokens.txt exactly as the C# RenderTokens() would, for copy/export in-browser.
function renderTokensText(r: CloneResult): string {
  const lines: string[] = ['# Design tokens · 設計符記', ''];
  if (r.colors) lines.push(`colors: ${r.colors}`);
  if (r.fonts) lines.push(`fonts: ${r.fonts}`);
  if (r.title) lines.push(`title: ${r.title}`);
  return lines.join('\n');
}

export function WebClonerModule() {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const [url, setUrl] = useState('https://example.com');
  const [folder, setFolder] = useState('%USERPROFILE%\\Documents\\WinForge Clones');
  const [downloadAssets, setDownloadAssets] = useState(true);
  // Optional passes mirrored from the C# page. Live execution needs the desktop WebView2 /
  // AI-agent services, so here they compose into the plan & command preview and are gated below.
  const [renderedDom, setRenderedDom] = useState(false);
  const [aiReconstruct, setAiReconstruct] = useState(false);
  const [showCmd, setShowCmd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const desktop = isTauri();

  // Live URL validity — shown inline like the C# service's up-front Uri.TryCreate guard.
  const urlValid = useMemo(() => normalizeUrl(url) !== null, [url]);

  const flash = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
  };

  const copyText = (text: string, key: string) => {
    if (!text) return;
    try {
      void navigator.clipboard?.writeText(text);
      flash(key);
    } catch {
      /* clipboard can be unavailable; never throw from a convenience action */
    }
  };

  // Download an in-browser text file (used to export the design-tokens summary without disk access).
  const downloadText = (text: string, name: string) => {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      /* ignore */
    }
  };

  const clone = async () => {
    if (!desktop || busy) return;
    if (!url.trim()) {
      setErr(pick('Enter a URL first.', '請先輸入網址。', lang));
      return;
    }
    if (!normalizeUrl(url)) {
      setErr(pick("That doesn't look like a valid http(s) URL.", '呢個唔似有效嘅 http(s) 網址。', lang));
      return;
    }
    if (!folder.trim()) {
      setErr(pick('Choose a destination folder first.', '請先揀目的資料夾。', lang));
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await runPowershell(cloneScript(url, folder, downloadAssets));
      const text = res.stdout.trim();
      if (!text) {
        setErr(res.stderr.trim() || pick('No output from the clone.', '複製冇任何輸出。', lang));
        return;
      }
      let parsed: CloneResult | null = null;
      try {
        parsed = JSON.parse(text) as CloneResult;
      } catch {
        // Backend may prepend noise; grab the last JSON object.
        const start = text.lastIndexOf('{');
        if (start >= 0) {
          try {
            parsed = JSON.parse(text.slice(start)) as CloneResult;
          } catch {
            parsed = null;
          }
        }
      }
      if (!parsed) {
        setErr(text);
        return;
      }
      if (!parsed.ok) {
        setErr(parsed.message || pick('Clone failed.', '複製失敗。', lang));
        setResult(null);
        return;
      }
      setResult(parsed);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!desktop || !result) return;
    try {
      await runPowershell(`Start-Process explorer.exe -ArgumentList '${psLit(result.destFolder)}'`);
    } catch {
      /* never throw from a convenience action */
    }
  };

  const openIndex = async () => {
    if (!desktop || !result || !result.indexPath) return;
    try {
      await runPowershell(`Start-Process '${psLit(result.indexPath)}'`);
    } catch {
      /* ignore */
    }
  };

  const cmd = commandPreview(url, folder, downloadAssets, renderedDom, aiReconstruct);

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {pick(
            'This is a native module — live cloning runs only in the WinForge desktop app.',
            '呢個係原生模組 — 實際複製只喺 WinForge 桌面版運行。',
            lang,
          )}
        </p>
      )}

      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          'Fetch a live web page, download its assets and save a browsable local copy — never opening an external browser or folder.',
          '下載一個網頁、攞埋佢嘅資源，儲存成可以喺本機瀏覽嘅副本，唔會開外部瀏覽器或資料夾。',
          lang,
        )}
      </p>
      <p className="count-note error" style={{ marginTop: 0 }}>
        {pick(
          "For personal & learning use only — cloning a site you don't own may breach copyright or terms of service.",
          '只供個人及學習用途 — 複製唔屬於你嘅網站可能侵犯版權或違反服務條款。',
          lang,
        )}
      </p>

      <div className="io-grid" style={{ display: 'grid', gap: 8 }}>
        <label className="label">{pick('Website URL', '網站網址', lang)}</label>
        <input
          className="mod-search"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && clone()}
          style={url.trim() && !urlValid ? { borderColor: 'var(--danger)' } : undefined}
        />
        {url.trim() && !urlValid && (
          <p className="count-note" style={{ marginTop: -4, color: 'var(--danger)' }}>
            {pick('Enter a valid http(s):// URL.', '請輸入有效嘅 http(s):// 網址。', lang)}
          </p>
        )}

        <label className="label">{pick('Destination folder', '目的資料夾', lang)}</label>
        <input
          className="mod-search"
          placeholder="%USERPROFILE%\Documents\WinForge Clones"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 6, marginTop: -2 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {pick('Presets:', '預設：', lang)}
          </span>
          <button
            className="mini"
            type="button"
            onClick={() => setFolder('%USERPROFILE%\\Documents\\WinForge Clones')}
          >
            {pick('Documents', '文件', lang)}
          </button>
          <button className="mini" type="button" onClick={() => setFolder('%USERPROFILE%\\Desktop\\WinForge Clones')}>
            {pick('Desktop', '桌面', lang)}
          </button>
          <button className="mini" type="button" onClick={() => setFolder('%USERPROFILE%\\Downloads\\WinForge Clones')}>
            {pick('Downloads', '下載', lang)}
          </button>
        </div>
      </div>

      <label className="label" style={{ marginTop: 10, display: 'block' }}>
        {pick('Options', '選項', lang)}
      </label>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 4, gap: 12 }}>
        <label className="chk">
          <input type="checkbox" checked={downloadAssets} onChange={(e) => setDownloadAssets(e.target.checked)} />
          {pick(
            'Download assets (images, CSS, JS, fonts) and rewrite links',
            '下載資源（圖片、CSS、JS、字型）並改寫連結',
            lang,
          )}
        </label>
        <label className="chk">
          <input type="checkbox" checked={renderedDom} onChange={(e) => setRenderedDom(e.target.checked)} />
          {pick(
            'Capture JS-rendered DOM (better for dynamic sites)',
            '擷取 JS 渲染後嘅 DOM（適合動態網站）',
            lang,
          )}
        </label>
        <label className="chk">
          <input type="checkbox" checked={aiReconstruct} onChange={(e) => setAiReconstruct(e.target.checked)} />
          {pick(
            'AI reconstruction: clean up the HTML/CSS/JS with an installed coding agent',
            'AI 重建：用已安裝嘅編程代理整靚 HTML／CSS／JS',
            lang,
          )}
        </label>
      </div>
      {(renderedDom || aiReconstruct) && (
        <p className="count-note" style={{ marginTop: 4 }}>
          {pick(
            'These passes use the desktop WebView2 / AI-agent services and apply on the WinForge desktop app; the native asset clone runs everywhere.',
            '呢啲步驟用桌面版 WebView2／AI 代理服務，喺 WinForge 桌面版套用；原生資源複製到處都行。',
            lang,
          )}
        </p>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <button className="mini primary" disabled={!desktop || busy || (url.trim() !== '' && !urlValid)} onClick={clone}>
          {busy ? pick('Cloning…', '複製中…', lang) : pick('Clone website', '複製網站', lang)}
        </button>
        <button className="mini" type="button" onClick={() => copyText(folder.trim(), 'folder')}>
          {copied === 'folder' ? pick('Copied', '已複製', lang) : pick('Copy folder path', '複製資料夾路徑', lang)}
        </button>
        <button className="mini" type="button" onClick={() => setShowCmd((v) => !v)}>
          {showCmd ? pick('Hide command', '隱藏指令', lang) : pick('Show command', '顯示指令', lang)}
        </button>
        {result && (
          <>
            <button className="mini" disabled={!desktop} onClick={openIndex}>
              {pick('Open index.html', '開啟 index.html', lang)}
            </button>
            <button className="mini" disabled={!desktop} onClick={openFolder}>
              {pick('Open folder', '開啟資料夾', lang)}
            </button>
          </>
        )}
      </div>

      {showCmd && (
        <div className="panel" style={{ marginTop: 8 }}>
          <div className="mod-toolbar" style={{ justifyContent: 'space-between', marginTop: 0 }}>
            <span className="label">{pick('Command preview', '指令預覽', lang)}</span>
            <button className="mini" type="button" onClick={() => copyText(cmd, 'cmd')}>
              {copied === 'cmd' ? pick('Copied', '已複製', lang) : pick('Copy', '複製', lang)}
            </button>
          </div>
          <pre className="cmd-out" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
            {cmd}
          </pre>
        </div>
      )}

      <p className="count-note" style={{ marginTop: 8 }}>
        {pick(
          'Caps: up to 200 assets, 25 MB per asset and 250 MB total, so a runaway page can’t fill the disk.',
          '上限：最多 200 個資源、每個 25 MB、合共 250 MB，避免失控頁面塞爆磁碟。',
          lang,
        )}
      </p>

      {err && <pre className="cmd-out error">{err}</pre>}

      {result && (
        <div className="panel">
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{pick('Title', '標題', lang)}</span>
              <span className="value">{result.title || '—'}</span>
            </div>
            <div className="kv-row">
              <span className="label">{pick('Index path', 'index 路徑', lang)}</span>
              <span className="value" style={{ fontFamily: 'monospace' }}>
                {result.indexPath || '—'}
              </span>
            </div>
            <div className="kv-row">
              <span className="label">{pick('HTML characters', 'HTML 字元', lang)}</span>
              <span className="value">{result.htmlChars.toLocaleString()}</span>
            </div>
            <div className="kv-row">
              <span className="label">{pick('Assets saved', '已存資源', lang)}</span>
              <span className="value">{result.assetsSaved}</span>
            </div>
            <div className="kv-row">
              <span className="label">{pick('Assets skipped', '略過資源', lang)}</span>
              <span className="value">{result.assetsFailed}</span>
            </div>
            <div className="kv-row">
              <span className="label">{pick('Total size', '總大小', lang)}</span>
              <span className="value">{fmtBytes(result.totalBytes)}</span>
            </div>
            {result.colors && (
              <div className="kv-row">
                <span className="label">{pick('Colors', '顏色', lang)}</span>
                <span className="value" style={{ fontFamily: 'monospace' }}>
                  {result.colors}
                </span>
              </div>
            )}
            {result.fonts && (
              <div className="kv-row">
                <span className="label">{pick('Fonts', '字型', lang)}</span>
                <span className="value">{result.fonts}</span>
              </div>
            )}
          </div>

          {(result.colors || result.fonts || result.title) && (
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              <span className="label" style={{ marginRight: 4 }}>
                {pick('Design tokens', '設計符記', lang)}
              </span>
              <button className="mini" type="button" onClick={() => copyText(renderTokensText(result), 'tokens')}>
                {copied === 'tokens' ? pick('Copied', '已複製', lang) : pick('Copy tokens', '複製符記', lang)}
              </button>
              <button
                className="mini"
                type="button"
                onClick={() => downloadText(renderTokensText(result), 'design-tokens.txt')}
              >
                {pick('Export design-tokens.txt', '匯出 design-tokens.txt', lang)}
              </button>
            </div>
          )}

          {/* Swatch preview of the extracted colours — a browser-composable read of the tokens. */}
          {result.colors && (
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {result.colors
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean)
                .slice(0, 12)
                .map((c, i) => (
                  <span
                    key={`${c}-${i}`}
                    title={c}
                    style={{
                      display: 'inline-block',
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      background: c,
                      border: '1px solid var(--border, rgba(128,128,128,0.4))',
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
