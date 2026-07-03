import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershell,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// ── Native module — In-app Rainmeter front-end ────────────────────────────────
// Drives the real Rainmeter.exe binary (resolved via DependencyGate → winget id
// Rainmeter.Rainmeter) through its command-line "!bang" interface. Skins and
// layouts are discovered on disk by parsing Rainmeter.ini + the Skins tree with
// PowerShell (mirroring the WinForge RainmeterService C# logic). State is re-read
// from Rainmeter.ini after every change rather than trusting a bang exit code.
// Nothing is reimplemented — WinForge only wraps the binary. Never throws.

interface Skin {
  config: string; // config folder relative to Skins root, e.g. illustro\Clock
  file: string; // ini file, e.g. Clock.ini
  active: boolean;
  count: number; // number of ini files in the same config
}

type Status = { kind: 'ok' | 'err'; text: string } | null;

// PowerShell string literal escape (single-quoted).
const psq = (s: string) => s.replace(/'/g, "''");

/**
 * PowerShell that resolves the Rainmeter settings folder + Skins folder the same
 * way the native service does (Rainmeter.ini SkinPath → My Documents\Rainmeter\Skins),
 * enumerates every .ini config under Skins, and cross-references Rainmeter.ini for
 * which configs are active. Emits one object per skin ini.
 */
function enumerateSkinsScript(): string {
  return `
$ErrorActionPreference='SilentlyContinue'
function Resolve-Settings {
  $appdata = Join-Path $env:APPDATA 'Rainmeter'
  if (Test-Path (Join-Path $appdata 'Rainmeter.ini')) { return $appdata }
  return $null
}
function Read-IniValue($ini,$section,$key){
  $cur=$null
  foreach($raw in (Get-Content -LiteralPath $ini)){
    $line=$raw.Trim()
    if($line.Length -eq 0 -or $line.StartsWith(';')){continue}
    if($line.StartsWith('[') -and $line.EndsWith(']')){$cur=$line.Substring(1,$line.Length-2).Trim();continue}
    if($cur -ne $section){continue}
    $eq=$line.IndexOf('=')
    if($eq -le 0){continue}
    if($line.Substring(0,$eq).Trim() -ieq $key){return $line.Substring($eq+1).Trim()}
  }
  return $null
}
$settings = Resolve-Settings
$ini = if($settings){ Join-Path $settings 'Rainmeter.ini' } else { $null }
if($ini -and -not (Test-Path -LiteralPath $ini)){ $ini=$null }
# Resolve Skins folder.
$skins=$null
if($ini){
  $sp = Read-IniValue $ini 'Rainmeter' 'SkinPath'
  if($sp){ $sp=[Environment]::ExpandEnvironmentVariables($sp.Trim()); if(Test-Path -LiteralPath $sp){ $skins=$sp } }
}
if(-not $skins){
  $docs=[Environment]::GetFolderPath('MyDocuments')
  if($docs){ $p=Join-Path (Join-Path $docs 'Rainmeter') 'Skins'; if(Test-Path -LiteralPath $p){ $skins=$p } }
}
if(-not $skins){ return }
$root=$skins.TrimEnd('\\')
# Active configs: [Config] Active=N + FileN=name.ini  (config lower -> active file).
$active=@{}
if($ini){
  $section=$null; $activeIndex=0; $fileByIndex=@{}
  function Flush(){
    if($section -and $activeIndex -gt 0 -and $fileByIndex.ContainsKey($activeIndex)){
      $script:active[$script:section.ToLowerInvariant()]=$script:fileByIndex[$script:activeIndex]
    }
  }
  foreach($raw in (Get-Content -LiteralPath $ini)){
    $line=$raw.Trim()
    if($line.Length -eq 0 -or $line.StartsWith(';')){continue}
    if($line.StartsWith('[') -and $line.EndsWith(']')){ Flush; $section=$line.Substring(1,$line.Length-2).Trim(); $activeIndex=0; $fileByIndex=@{}; continue }
    if(-not $section){continue}
    $eq=$line.IndexOf('=')
    if($eq -le 0){continue}
    $key=$line.Substring(0,$eq).Trim(); $val=$line.Substring($eq+1).Trim()
    if($key -ieq 'Active'){ [int]::TryParse($val,[ref]$activeIndex) | Out-Null }
    elseif($key.Length -gt 4 -and $key.Substring(0,4) -ieq 'File'){ $idx=0; if([int]::TryParse($key.Substring(4),[ref]$idx)){ $fileByIndex[$idx]=$val } }
  }
  Flush
  $active.Remove('rainmeter') | Out-Null
}
# Group ini files by config folder.
$byConfig=@{}
foreach($f in (Get-ChildItem -LiteralPath $root -Recurse -Filter *.ini -File)){
  $dir=$f.DirectoryName
  $rel=$dir.Substring($root.Length).Trim('\\')
  if($rel -eq '' -or $rel -eq '.'){continue}
  if(-not $byConfig.ContainsKey($rel)){ $byConfig[$rel]=New-Object System.Collections.ArrayList }
  [void]$byConfig[$rel].Add($f.Name)
}
foreach($config in $byConfig.Keys){
  $files=$byConfig[$config]
  foreach($fn in $files){
    $isActive=$false
    $lc=$config.ToLowerInvariant()
    if($active.ContainsKey($lc) -and ($active[$lc] -ieq $fn)){ $isActive=$true }
    [pscustomobject]@{ config=$config; file=$fn; active=$isActive; count=$files.Count }
  }
}`;
}

/** List saved layout names (subfolders under the Layouts folder, sibling of Skins). */
function enumerateLayoutsScript(): string {
  return `
$ErrorActionPreference='SilentlyContinue'
$appdata = Join-Path $env:APPDATA 'Rainmeter'
$ini = Join-Path $appdata 'Rainmeter.ini'
$skins=$null
if(Test-Path -LiteralPath $ini){
  $cur=$null
  foreach($raw in (Get-Content -LiteralPath $ini)){
    $line=$raw.Trim()
    if($line.Length -eq 0 -or $line.StartsWith(';')){continue}
    if($line.StartsWith('[') -and $line.EndsWith(']')){$cur=$line.Substring(1,$line.Length-2).Trim();continue}
    if($cur -ne 'Rainmeter'){continue}
    $eq=$line.IndexOf('=')
    if($eq -le 0){continue}
    if($line.Substring(0,$eq).Trim() -ieq 'SkinPath'){ $v=[Environment]::ExpandEnvironmentVariables($line.Substring($eq+1).Trim()); if(Test-Path -LiteralPath $v){$skins=$v} }
  }
}
if(-not $skins){
  $docs=[Environment]::GetFolderPath('MyDocuments')
  if($docs){ $p=Join-Path (Join-Path $docs 'Rainmeter') 'Skins'; if(Test-Path -LiteralPath $p){ $skins=$p } }
}
if(-not $skins){ return }
$parent=Split-Path -Parent $skins.TrimEnd('\\')
if(-not $parent){ return }
$layouts=Join-Path $parent 'Layouts'
if(-not (Test-Path -LiteralPath $layouts)){ return }
Get-ChildItem -LiteralPath $layouts -Directory | Sort-Object Name | ForEach-Object { $_.Name }`;
}

interface Pack {
  name: string;
  enKey: string;
  yueKey: string;
  url: string;
}

const PACKS: Pack[] = [
  { name: 'illustro', enKey: 'rainmeter.packIllustro', yueKey: 'rainmeter.packIllustro', url: 'https://docs.rainmeter.net/manual/skins/' },
  { name: 'Mond', enKey: 'rainmeter.packMond', yueKey: 'rainmeter.packMond', url: 'https://www.deviantart.com/antondeluxe/art/Mond-507130559' },
  { name: 'Win10 Widgets', enKey: 'rainmeter.packWin10', yueKey: 'rainmeter.packWin10', url: 'https://win10widgets.com/' },
  { name: 'Enigma', enKey: 'rainmeter.packEnigma', yueKey: 'rainmeter.packEnigma', url: 'https://www.rainmeter.net/discover/' },
  { name: 'Jarvis / Honeycomb', enKey: 'rainmeter.packJarvis', yueKey: 'rainmeter.packJarvis', url: 'https://www.rainmeter.net/discover/' },
  { name: 'Discover more', enKey: 'rainmeter.packDiscover', yueKey: 'rainmeter.packDiscover', url: 'https://www.rainmeter.net/discover/' },
];

type Tab = 'skins' | 'layouts' | 'packs' | 'ops';

export function RainmeterModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('rainmeter.blurb')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('rainmeter.desktopOnly')}
        </p>
      )}
      <DependencyGate tool="rainmeter" preferId="Rainmeter.Rainmeter" query="Rainmeter">
        {(path) => <RainmeterInner exePath={path} />}
      </DependencyGate>
    </div>
  );
}

function RainmeterInner({ exePath }: { exePath: string }) {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tab, setTab] = useState<Tab>('skins');
  const [skins, setSkins] = useState<Skin[]>([]);
  const [layouts, setLayouts] = useState<string[]>([]);
  const [selectedLayout, setSelectedLayout] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [opsFilter, setOpsFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const setOk = (text: string) => setStatus({ kind: 'ok', text });
  const setErr = (text: string) => setStatus({ kind: 'err', text });

  // ── Send one !bang to the running instance (Rainmeter.exe forwards it). ──
  const sendBang = useCallback(
    async (args: string[]): Promise<CommandOutput | null> => {
      if (!desktop) {
        setErr(t('rainmeter.desktopOnly'));
        return null;
      }
      try {
        return await runCommand(exePath, args);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
        return null;
      }
    },
    [desktop, exePath, t],
  );

  const reloadSkins = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    try {
      const rows = await runPowershellJson<Skin>(enumerateSkinsScript());
      setSkins(Array.isArray(rows) ? rows : []);
    } catch {
      setSkins([]);
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  const reloadLayouts = useCallback(async () => {
    if (!desktop) return;
    try {
      const rows = await runPowershellJson<string>(enumerateLayoutsScript());
      const names = (Array.isArray(rows) ? rows : []).filter((n): n is string => typeof n === 'string' && n.length > 0);
      setLayouts(names);
      setSelectedLayout((prev) => (prev && names.includes(prev) ? prev : names[0] ?? ''));
    } catch {
      setLayouts([]);
    }
  }, [desktop]);

  useEffect(() => {
    void reloadSkins();
    void reloadLayouts();
  }, [reloadSkins, reloadLayouts]);

  // ── Skin row actions ──────────────────────────────────────────────────────
  const runRow = async (key: string, args: string[], okMsg: string) => {
    if (rowBusy) return;
    setRowBusy(key);
    setStatus(null);
    const res = await sendBang(args);
    if (res) setOk(okMsg);
    // Re-read Rainmeter.ini rather than trusting the bang.
    await reloadSkins();
    setRowBusy(null);
  };

  const activate = (s: Skin) => runRow(rowKey(s) + ':on', ['!ActivateConfig', s.config, s.file], t('rainmeter.loaded'));
  const deactivate = (s: Skin) => runRow(rowKey(s) + ':off', ['!DeactivateConfig', s.config], t('rainmeter.unloaded'));
  const showSkin = (s: Skin) => runRow(rowKey(s) + ':show', ['!Show', s.config], t('rainmeter.shown'));
  const hideSkin = (s: Skin) => runRow(rowKey(s) + ':hide', ['!Hide', s.config], t('rainmeter.hidden'));
  const refreshSkin = (s: Skin) => runRow(rowKey(s) + ':ref', ['!Refresh', s.config], t('rainmeter.refreshed'));
  const editSkin = (s: Skin) => runRow(rowKey(s) + ':edit', ['!EditSkin', s.config, s.file], t('rainmeter.editing'));

  // ── Global operations ─────────────────────────────────────────────────────
  const startEngine = async () => {
    if (!desktop) {
      setErr(t('rainmeter.desktopOnly'));
      return;
    }
    setStatus(null);
    try {
      // Launch the GUI detached; no bang means it just starts the tray engine.
      await runCommand(exePath, []);
      setOk(t('rainmeter.started'));
      await reloadSkins();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const globalBang = async (args: string[], okMsg: string, then?: () => Promise<void>) => {
    setStatus(null);
    const res = await sendBang(args);
    if (res) setOk(okMsg);
    if (then) await then();
  };

  const openFolder = async (which: 'skins' | 'settings') => {
    if (!desktop) {
      setErr(t('rainmeter.desktopOnly'));
      return;
    }
    setStatus(null);
    const script =
      which === 'settings'
        ? `$p=Join-Path $env:APPDATA 'Rainmeter'; if(Test-Path -LiteralPath $p){ Start-Process explorer.exe $p; 'ok' } else { 'missing' }`
        : `$appdata=Join-Path $env:APPDATA 'Rainmeter'; $ini=Join-Path $appdata 'Rainmeter.ini'; $skins=$null;
if(Test-Path -LiteralPath $ini){ foreach($raw in (Get-Content -LiteralPath $ini)){ $l=$raw.Trim(); if($l -match '^SkinPath\\s*='){ $v=[Environment]::ExpandEnvironmentVariables($l.Substring($l.IndexOf('=')+1).Trim()); if(Test-Path -LiteralPath $v){$skins=$v} } } }
if(-not $skins){ $docs=[Environment]::GetFolderPath('MyDocuments'); if($docs){ $p=Join-Path (Join-Path $docs 'Rainmeter') 'Skins'; if(Test-Path -LiteralPath $p){$skins=$p} } }
if($skins){ Start-Process explorer.exe $skins; 'ok' } else { 'missing' }`;
    try {
      const res = await runPowershell(script);
      if (res.stdout.trim() === 'missing') setErr(t('rainmeter.folderMissing'));
      else setOk(t('rainmeter.opened'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const installRmskin = async () => {
    if (!desktop) {
      setErr(t('rainmeter.desktopOnly'));
      return;
    }
    setStatus(null);
    // Pick a .rmskin via a native file dialog (PowerShell / WinForms), then launch
    // SkinInstaller.exe alongside Rainmeter.exe (fallback: the .rmskin association).
    const exeDir = exePath.replace(/[\\/][^\\/]*$/, '');
    const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg=New-Object System.Windows.Forms.OpenFileDialog
$dlg.Filter='Rainmeter skin pack (*.rmskin)|*.rmskin|All files (*.*)|*.*'
$dlg.Title='${psq(t('rainmeter.choosePack'))}'
if($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){ 'cancel'; return }
$file=$dlg.FileName
$installer=Join-Path '${psq(exeDir)}' 'SkinInstaller.exe'
if(Test-Path -LiteralPath $installer){ Start-Process -FilePath $installer -ArgumentList ('"'+$file+'"') } else { Start-Process -FilePath $file }
'ok'`;
    try {
      const res = await runPowershell(script);
      const out = res.stdout.trim();
      if (out === 'cancel') return;
      if (out === 'ok') setOk(t('rainmeter.installerLaunched'));
      else setErr(res.stderr.trim() || `exit ${res.code}`);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const loadLayout = async () => {
    if (!selectedLayout) return;
    setStatus(null);
    const res = await sendBang(['!LoadLayout', selectedLayout]);
    if (res) setOk(t('rainmeter.layoutLoaded', { name: selectedLayout }));
    await reloadSkins();
  };

  const copyUrl = async (url: string) => {
    setStatus(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setOk(t('rainmeter.urlCopied'));
      } else {
        setErr(url);
      }
    } catch {
      setErr(url);
    }
  };

  const openUrl = (url: string) => {
    try {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noreferrer');
    } catch {
      void copyUrl(url);
    }
  };

  // ── Derived lists ─────────────────────────────────────────────────────────
  const f = filter.trim().toLowerCase();
  const shownSkins = skins
    .filter((s) => (onlyActive ? s.active : true))
    .filter((s) => (f ? s.config.toLowerCase().includes(f) || s.file.toLowerCase().includes(f) : true));
  const total = skins.length;
  const activeCount = skins.filter((s) => s.active).length;

  interface Op {
    key: string;
    title: string;
    desc: string;
    label: string;
    run: () => void | Promise<void>;
    hay: string;
  }
  const ops: Op[] = [
    {
      key: 'refreshapp',
      title: t('rainmeter.opRefreshAll'),
      desc: t('rainmeter.opRefreshAllDesc'),
      label: t('rainmeter.actRefresh'),
      run: () => globalBang(['!RefreshApp'], t('rainmeter.refreshedAll'), reloadSkins),
      hay: 'refresh reload all 重新整理 重載',
    },
    {
      key: 'start',
      title: t('rainmeter.opStart'),
      desc: t('rainmeter.opStartDesc'),
      label: t('rainmeter.actStart'),
      run: startEngine,
      hay: 'start launch run engine 啟動 執行',
    },
    {
      key: 'manage',
      title: t('rainmeter.opManage'),
      desc: t('rainmeter.opManageDesc'),
      label: t('rainmeter.actOpen'),
      run: () => globalBang(['!Manage'], t('rainmeter.opened')),
      hay: 'manage window 管理 視窗',
    },
    {
      key: 'about',
      title: t('rainmeter.opAbout'),
      desc: t('rainmeter.opAboutDesc'),
      label: t('rainmeter.actOpen'),
      run: () => globalBang(['!About'], t('rainmeter.opened')),
      hay: 'about log 關於 記錄 日誌',
    },
    {
      key: 'skinsfolder',
      title: t('rainmeter.opSkinsFolder'),
      desc: t('rainmeter.opSkinsFolderDesc'),
      label: t('rainmeter.actOpen'),
      run: () => openFolder('skins'),
      hay: 'skins folder explorer 資料夾',
    },
    {
      key: 'settingsfolder',
      title: t('rainmeter.opSettingsFolder'),
      desc: t('rainmeter.opSettingsFolderDesc'),
      label: t('rainmeter.actOpen'),
      run: () => openFolder('settings'),
      hay: 'settings folder rainmeter.ini 設定 資料夾',
    },
    {
      key: 'quit',
      title: t('rainmeter.opQuit'),
      desc: t('rainmeter.opQuitDesc'),
      label: t('rainmeter.actQuit'),
      run: () => globalBang(['!Quit'], t('rainmeter.quit'), reloadSkins),
      hay: 'quit exit close 退出 關閉',
    },
  ];
  const of = opsFilter.trim().toLowerCase();
  const shownOps = of ? ops.filter((o) => (o.title + ' ' + o.desc + ' ' + o.hay).toLowerCase().includes(of)) : ops;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'skins', label: t('rainmeter.tabSkins') },
    { id: 'layouts', label: t('rainmeter.tabLayouts') },
    { id: 'packs', label: t('rainmeter.tabPacks') },
    { id: 'ops', label: t('rainmeter.tabOps') },
  ];

  return (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={tab === tb.id ? 'mini primary' : 'mini'}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {status && (
        <p className={status.kind === 'err' ? 'error' : 'dep-ok'} style={{ marginTop: 8 }}>
          {status.kind === 'err' ? '⚠ ' : '✓ '}
          {status.text}
        </p>
      )}

      {tab === 'skins' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('rainmeter.skinsBlurb')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" disabled={!desktop || loading} onClick={() => void reloadSkins()}>
              {loading ? t('rainmeter.scanning') : t('rainmeter.rescan')}
            </button>
            <button
              className="mini"
              disabled={!desktop || !!rowBusy}
              onClick={() => globalBang(['!RefreshApp'], t('rainmeter.refreshedAll'), reloadSkins)}
            >
              {t('rainmeter.refreshAll')}
            </button>
            <button className="mini" disabled={!desktop} onClick={() => void installRmskin()}>
              {t('rainmeter.installRmskin')}
            </button>
            <label className="chk">
              <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
              {t('rainmeter.onlyLoaded')}
            </label>
            <input
              className="mod-search"
              style={{ maxWidth: 200 }}
              placeholder={t('rainmeter.filterSkins')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <p className="count-note">{t('rainmeter.skinsCount', { total, active: activeCount })}</p>

          {shownSkins.length === 0 ? (
            <p className="count-note">{desktop ? t('rainmeter.noSkins') : t('rainmeter.desktopOnly')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>{t('rainmeter.colSkin')}</th>
                    <th>{t('rainmeter.colState')}</th>
                    <th style={{ textAlign: 'right' }}>{t('rainmeter.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSkins.map((s) => {
                    const k = rowKey(s);
                    const busyThis = rowBusy !== null && rowBusy.startsWith(k + ':');
                    return (
                      <tr key={k}>
                        <td style={{ fontFamily: 'monospace' }}>{displayName(s)}</td>
                        <td
                          className="value"
                          style={{ color: s.active ? 'var(--ok, #3ba55d)' : undefined }}
                        >
                          {s.active ? t('rainmeter.loaded') : t('rainmeter.notLoaded')}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {s.active ? (
                            <button className="mini" disabled={!desktop || busyThis} onClick={() => deactivate(s)}>
                              {t('rainmeter.unload')}
                            </button>
                          ) : (
                            <button className="mini primary" disabled={!desktop || busyThis} onClick={() => activate(s)}>
                              {t('rainmeter.load')}
                            </button>
                          )}{' '}
                          <button className="mini" disabled={!desktop || busyThis || !s.active} onClick={() => showSkin(s)}>
                            {t('rainmeter.show')}
                          </button>{' '}
                          <button className="mini" disabled={!desktop || busyThis || !s.active} onClick={() => hideSkin(s)}>
                            {t('rainmeter.hide')}
                          </button>{' '}
                          <button className="mini" disabled={!desktop || busyThis || !s.active} onClick={() => refreshSkin(s)}>
                            {t('rainmeter.refresh')}
                          </button>{' '}
                          <button className="mini" disabled={!desktop || busyThis} onClick={() => editSkin(s)}>
                            {t('rainmeter.edit')}
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

      {tab === 'layouts' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('rainmeter.layoutsBlurb')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <select
              className="mod-select"
              value={selectedLayout}
              disabled={!desktop || layouts.length === 0}
              onChange={(e) => setSelectedLayout(e.target.value)}
            >
              {layouts.length === 0 ? (
                <option value="">{t('rainmeter.noLayouts')}</option>
              ) : (
                layouts.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))
              )}
            </select>
            <button className="mini primary" disabled={!desktop || !selectedLayout} onClick={() => void loadLayout()}>
              {t('rainmeter.loadLayout')}
            </button>
            <button className="mini" disabled={!desktop} onClick={() => void reloadLayouts()}>
              {t('rainmeter.reloadList')}
            </button>
          </div>
        </div>
      )}

      {tab === 'packs' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('rainmeter.packsBlurb')}
          </p>
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop} onClick={() => void installRmskin()}>
              {t('rainmeter.installRmskinFile')}
            </button>
          </div>
          <div className="kv-list">
            {PACKS.map((p) => (
              <div className="kv-row" key={p.name}>
                <span className="label">
                  <strong>{p.name}</strong>
                  <br />
                  <span className="value">{t(p.enKey)}</span>
                </span>
                <span className="value" style={{ whiteSpace: 'nowrap' }}>
                  <button className="mini" onClick={() => openUrl(p.url)}>
                    {t('rainmeter.openPage')}
                  </button>{' '}
                  <button className="mini" onClick={() => void copyUrl(p.url)}>
                    {t('rainmeter.copyUrl')}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'ops' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('rainmeter.opsBlurb')}
          </p>
          <div className="mod-toolbar">
            <input
              className="mod-search"
              style={{ maxWidth: 240 }}
              placeholder={t('rainmeter.filterOps')}
              value={opsFilter}
              onChange={(e) => setOpsFilter(e.target.value)}
            />
          </div>
          <div className="kv-list">
            {shownOps.map((o) => (
              <div className="kv-row" key={o.key}>
                <span className="label">
                  <strong>{o.title}</strong>
                  <br />
                  <span className="value">{o.desc}</span>
                </span>
                <span className="value">
                  <button
                    className={o.key === 'quit' ? 'mini' : 'mini primary'}
                    disabled={!desktop}
                    onClick={() => void o.run()}
                  >
                    {o.label}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function rowKey(s: Skin): string {
  return `${s.config} ${s.file}`;
}

/** "config\file" without trailing .ini, collapsed to just config when it's the sole ini. */
function displayName(s: Skin): string {
  const soleOrSkinIni = s.file.toLowerCase() === 'skin.ini' || s.count <= 1;
  return soleOrSkinIni ? s.config : `${s.config}\\${s.file}`;
}
