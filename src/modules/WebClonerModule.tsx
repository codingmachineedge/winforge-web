import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

export function WebClonerModule() {
  const { t } = useTranslation();
  const [url, setUrl] = useState('https://example.com');
  const [folder, setFolder] = useState('%USERPROFILE%\\Documents\\WinForge Clones');
  const [downloadAssets, setDownloadAssets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const desktop = isTauri();

  const clone = async () => {
    if (!desktop || busy) return;
    if (!url.trim()) {
      setErr(t('webcloner.needUrl'));
      return;
    }
    if (!folder.trim()) {
      setErr(t('webcloner.needFolder'));
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await runPowershell(cloneScript(url, folder, downloadAssets));
      const text = res.stdout.trim();
      if (!text) {
        setErr(res.stderr.trim() || t('webcloner.noOutput'));
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
        setErr(parsed.message || t('webcloner.failed'));
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

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('webcloner.desktopOnly')}
        </p>
      )}

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('webcloner.blurb')}
      </p>
      <p className="count-note error" style={{ marginTop: 0 }}>
        {t('webcloner.disclaimer')}
      </p>

      <div className="io-grid" style={{ display: 'grid', gap: 8 }}>
        <label className="label">{t('webcloner.urlLabel')}</label>
        <input
          className="mod-search"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && clone()}
        />
        <label className="label">{t('webcloner.folderLabel')}</label>
        <input
          className="mod-search"
          placeholder="%USERPROFILE%\Documents\WinForge Clones"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <label className="chk">
          <input
            type="checkbox"
            checked={downloadAssets}
            onChange={(e) => setDownloadAssets(e.target.checked)}
          />
          {t('webcloner.assetsOpt')}
        </label>
        <button className="mini primary" disabled={!desktop || busy} onClick={clone}>
          {busy ? t('webcloner.cloning') : t('webcloner.clone')}
        </button>
        {result && (
          <>
            <button className="mini" disabled={!desktop} onClick={openIndex}>
              {t('webcloner.openIndex')}
            </button>
            <button className="mini" disabled={!desktop} onClick={openFolder}>
              {t('webcloner.openFolder')}
            </button>
          </>
        )}
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('webcloner.note')}
      </p>

      {err && <pre className="cmd-out error">{err}</pre>}

      {result && (
        <div className="panel">
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('webcloner.rTitle')}</span>
              <span className="value">{result.title || '—'}</span>
            </div>
            <div className="kv-row">
              <span className="label">{t('webcloner.rIndex')}</span>
              <span className="value" style={{ fontFamily: 'monospace' }}>
                {result.indexPath || '—'}
              </span>
            </div>
            <div className="kv-row">
              <span className="label">{t('webcloner.rHtml')}</span>
              <span className="value">{result.htmlChars.toLocaleString()}</span>
            </div>
            <div className="kv-row">
              <span className="label">{t('webcloner.rSaved')}</span>
              <span className="value">{result.assetsSaved}</span>
            </div>
            <div className="kv-row">
              <span className="label">{t('webcloner.rFailed')}</span>
              <span className="value">{result.assetsFailed}</span>
            </div>
            <div className="kv-row">
              <span className="label">{t('webcloner.rTotal')}</span>
              <span className="value">{fmtBytes(result.totalBytes)}</span>
            </div>
            {result.colors && (
              <div className="kv-row">
                <span className="label">{t('webcloner.rColors')}</span>
                <span className="value" style={{ fontFamily: 'monospace' }}>
                  {result.colors}
                </span>
              </div>
            )}
            {result.fonts && (
              <div className="kv-row">
                <span className="label">{t('webcloner.rFonts')}</span>
                <span className="value">{result.fonts}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
