import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, runPowershellJson, isTauri, type CommandOutput } from '../tauri/bridge';
import { AsyncState, Column, DataTable, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Native module — full front-end for the official Windhawk mod platform ─────────────────────────────
// (winget RamenSoftware.Windhawk). Windhawk is a C++ injection engine that compiles community "mods" and
// injects them into explorer.exe / the taskbar via an elevated service (windhawk.service). WinForge does not
// fork or bundle it (GPL-3.0). This module ports the C# WindhawkModule/WindhawkService surface and adds the
// full manager: detect/install the engine, an installed-mods list (id/name/version/enabled/author) read from
// %ProgramData%\Windhawk\Engine\Mods + the HKLM\SOFTWARE\Windhawk\Engine\Mods registry, enable/disable/remove
// (click-gated; remove confirms), per-mod settings editing (registry Settings subkey), the curated bilingual
// mod gallery with deep-links + install-by-id, and Windhawk engine/service controls. Every mutation is
// click-gated; reads auto-run. PowerShell 5.1-compatible only. Never throws.

const WINGET_ID = 'RamenSoftware.Windhawk';
const MOD_PAGE_ROOT = 'https://windhawk.net/mods/';
const HOMEPAGE = 'https://windhawk.net/';
// Windhawk engine data + registry roots (documented layout).
const ENGINE_MODS_SUBPATH = 'Windhawk\\Engine\\Mods';
const REG_UNINSTALL = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Windhawk_is1';
const REG_ENGINE_MODS = 'HKLM:\\SOFTWARE\\Windhawk\\Engine\\Mods';
const ENGINE_SERVICE = 'windhawk.service';

// PowerShell single-quote escape.
const q = (s: string): string => s.replace(/'/g, "''");
// Restrict a mod id to the safe slug charset windhawk.net uses (defence in depth for shelled paths/keys).
const isSafeId = (id: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id);

// ── Engine detection ──────────────────────────────────────────────────────────────────────────────────
interface Engine {
  installed: boolean;
  exe: string | null;
  version: string | null;
  engineFolder: string | null;
  settingsFolder: string | null;
}

// Locate windhawk.exe (Program Files, then Uninstall registry InstallLocation), read DisplayVersion,
// and resolve the engine data folder. One PS round-trip, JSON out.
const detectEngine = async (): Promise<Engine> => {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$exe=$null
foreach($d in @((Join-Path $env:ProgramFiles 'Windhawk'),(Join-Path ${'${env:ProgramFiles(x86)}'} 'Windhawk'))){
  if($d -and (Test-Path (Join-Path $d 'windhawk.exe'))){ $exe=(Join-Path $d 'windhawk.exe'); break }
}
$loc=(Get-ItemProperty -Path '${REG_UNINSTALL}' -ErrorAction SilentlyContinue).InstallLocation
if(-not $exe -and $loc){ $c=(Join-Path $loc 'windhawk.exe'); if(Test-Path $c){ $exe=$c } }
$ver=(Get-ItemProperty -Path '${REG_UNINSTALL}' -ErrorAction SilentlyContinue).DisplayVersion
$eng=(Join-Path $env:ProgramData '${ENGINE_MODS_SUBPATH}')
$engExists=$false; if(Test-Path $eng){ $engExists=$true }
$set=(Join-Path $env:ProgramData 'Windhawk')
$setExists=$false; if(Test-Path $set){ $setExists=$true }
[pscustomobject]@{
  installed=[bool]$exe
  exe=$exe
  version=$ver
  engineFolder=$(if($engExists){$eng}else{$null})
  settingsFolder=$(if($setExists){$set}else{$null})
}`;
  const rows = await runPowershellJson<Engine>(script);
  return (
    rows[0] ?? { installed: false, exe: null, version: null, engineFolder: null, settingsFolder: null }
  );
};

// ── Installed mod model ─────────────────────────────────────────────────────────────────────────────
interface InstalledMod {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
}

// Enumerate %ProgramData%\Windhawk\Engine\Mods\<id>, parse the mod.wh.cpp metadata header
// (// @name / @version / @author / @description), and read the Disabled DWORD from the engine registry.
const readInstalledMods = async (): Promise<InstalledMod[]> => {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$root=(Join-Path $env:ProgramData '${ENGINE_MODS_SUBPATH}')
if(-not (Test-Path $root)){ return }
Get-ChildItem -Path $root -Directory | ForEach-Object {
  $id=$_.Name
  $name=$id; $ver=''; $author=''; $desc=''
  $src=(Join-Path $_.FullName 'mod.wh.cpp')
  if(Test-Path $src){
    foreach($line in (Get-Content -Path $src -TotalCount 80 -Encoding UTF8)){
      if($line -match '^//\\s*@name(:[A-Za-z\\-]+)?\\s+(.+?)\\s*$' -and $name -eq $id){ $name=$Matches[2] }
      elseif($line -match '^//\\s*@version\\s+(.+?)\\s*$' -and -not $ver){ $ver=$Matches[1] }
      elseif($line -match '^//\\s*@author\\s+(.+?)\\s*$' -and -not $author){ $author=$Matches[1] }
      elseif($line -match '^//\\s*@description(:[A-Za-z\\-]+)?\\s+(.+?)\\s*$' -and -not $desc){ $desc=$Matches[2] }
      if($line -match '^//\\s*==/WindhawkMod=='){ break }
    }
  }
  $disabled=0
  $rk='${REG_ENGINE_MODS}\\' + $id
  $rv=(Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue).Disabled
  if($rv){ $disabled=[int]$rv }
  [pscustomobject]@{ id=$id; name=$name; version=$ver; author=$author; description=$desc; enabled=($disabled -eq 0) }
}`;
  return runPowershellJson<InstalledMod>(script);
};

// ── Curated bilingual gallery (mirrors WinForge.Catalog.WindhawkMods) ──────────────────────────────────
interface GalleryMod {
  id: string;
  enTitle: string;
  zhTitle: string;
  enDesc: string;
  zhDesc: string;
  author: string;
  keywords: string;
}

const MODS: GalleryMod[] = [
  { id: 'taskbar-icon-size', enTitle: 'Taskbar height and icon size', zhTitle: '工作列高度同圖示大小', enDesc: 'Make the Windows 11 taskbar shorter or taller and resize its icons — the most popular taskbar mod.', zhDesc: '調校 Windows 11 工作列高度，並重新設定圖示大小 — 最受歡迎嘅工作列 mod。', author: 'm417z', keywords: 'taskbar height icon size 工作列 高度 圖示' },
  { id: 'taskbar-clock-customization', enTitle: 'Taskbar Clock Customization', zhTitle: '工作列時鐘自訂', enDesc: 'Add seconds, the date, week number, custom text or even weather to the system-tray clock.', zhDesc: '喺系統匣時鐘加上秒數、日期、週次、自訂文字甚至天氣。', author: 'm417z', keywords: 'clock seconds date weather tray 時鐘 秒 日期 天氣' },
  { id: 'taskbar-grouping', enTitle: 'Disable grouping on the taskbar', zhTitle: '停用工作列群組', enDesc: 'Stop Windows from combining windows of the same app into a single taskbar button.', zhDesc: '唔再將同一個程式嘅視窗併埋成一粒工作列按鈕。', author: 'm417z', keywords: 'taskbar grouping ungroup labels 工作列 群組 標籤' },
  { id: 'windows-11-start-menu-styler', enTitle: 'Windows 11 Start Menu Styler', zhTitle: 'Windows 11 開始功能表美化', enDesc: 'Deeply restyle the Start menu with community themes — hide the recommended section, change layout, and more.', zhDesc: '用社群主題深度美化開始功能表 — 隱藏推薦區、改版面等等。', author: 'm417z', keywords: 'start menu styler theme recommended 開始 功能表 主題 推薦' },
  { id: 'windows-11-taskbar-styler', enTitle: 'Windows 11 Taskbar Styler', zhTitle: 'Windows 11 工作列美化', enDesc: 'Restyle the taskbar with community themes (translucent, segmented, classic-like, and many more).', zhDesc: '用社群主題美化工作列（半透明、分段、近似經典等多款）。', author: 'm417z', keywords: 'taskbar styler theme translucent 工作列 美化 主題 半透明' },
  { id: 'classic-taskbar-background-fixed', enTitle: 'Classic Taskbar (background fix)', zhTitle: '經典工作列（背景修正）', enDesc: 'Bring back a more classic, opaque taskbar look on Windows 11.', zhDesc: '喺 Windows 11 帶返較經典、不透明嘅工作列外觀。', author: 'ujk', keywords: 'classic taskbar opaque background 經典 工作列 不透明' },
  { id: 'taskbar-on-top', enTitle: 'Taskbar position on screen', zhTitle: '工作列螢幕位置', enDesc: 'Move the Windows 11 taskbar to the top, left or right edge of the screen.', zhDesc: '將 Windows 11 工作列移到螢幕頂部、左邊或右邊。', author: 'm417z', keywords: 'taskbar top left right position 工作列 頂部 位置' },
  { id: 'aerexplorer', enTitle: 'Aerexplorer (classic Explorer tweaks)', zhTitle: 'Aerexplorer（經典檔案總管調校）', enDesc: 'A bundle of File Explorer tweaks: classic search box, ribbon, details pane and more Aero-era behaviour.', zhDesc: '一系列檔案總管調校：經典搜尋框、功能區、詳細資料窗格等 Aero 年代行為。', author: 'Anixx', keywords: 'explorer aero ribbon search 檔案總管 經典 功能區' },
  { id: 'better-file-sizes-in-explorer-details', enTitle: 'Better file sizes in Explorer', zhTitle: '檔案總管更佳檔案大小', enDesc: 'Show file sizes for folders and use MB/GB units consistently in the Explorer details view.', zhDesc: '喺檔案總管詳細資料檢視顯示資料夾大小，並一致使用 MB／GB 單位。', author: 'Waldemar', keywords: 'explorer file size folder mb gb 檔案 大小 資料夾' },
  { id: 'disable-rounded-corners', enTitle: 'Disable rounded corners', zhTitle: '停用圓角', enDesc: 'Turn off the Windows 11 rounded window corners to get sharp, square edges back.', zhDesc: '關閉 Windows 11 圓角視窗，帶返尖角方正邊緣。', author: 'm417z', keywords: 'rounded corners square sharp window 圓角 方角 視窗' },
  { id: 'aero-tray', enTitle: 'Aero Tray', zhTitle: 'Aero 系統匣', enDesc: 'Restore Aero-style behaviour to the notification area / system tray.', zhDesc: '為通知區／系統匣帶返 Aero 風格行為。', author: 'Anixx', keywords: 'aero tray notification area 系統匣 通知區' },
  { id: 'start-menu-all-apps', enTitle: "Open Start menu on 'All apps'", zhTitle: '開始功能表直接顯示「所有應用程式」', enDesc: 'Make the Start menu open straight to the All apps list instead of the pinned/recommended page.', zhDesc: '令開始功能表一開就顯示「所有應用程式」清單，唔再停喺釘選／推薦頁。', author: 'm417z', keywords: 'start menu all apps pinned 開始 所有應用程式 釘選' },
  { id: 'middle-click-to-close', enTitle: 'Middle click to close on the taskbar', zhTitle: '中鍵點擊關閉工作列項目', enDesc: 'Close a taskbar window with a middle mouse click — like a browser tab.', zhDesc: '用滑鼠中鍵一㩒就關閉工作列視窗 — 似瀏覽器分頁咁。', author: 'm417z', keywords: 'middle click close taskbar tab 中鍵 關閉 工作列' },
  { id: 'acrylic-effect-radius-changer', enTitle: 'Acrylic / blur effect tuner', zhTitle: '壓克力／模糊效果調校', enDesc: 'Tune the acrylic blur radius and effects used across the Windows 11 UI.', zhDesc: '調校 Windows 11 介面所用嘅壓克力模糊半徑同效果。', author: 'm417z', keywords: 'acrylic blur radius effect transparency 壓克力 模糊 半透明' },
];

// Shared status banner state used across tabs.
interface Banner {
  msg: string | null;
  err: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
export function WindhawkModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const engine = useAsync<Engine>(detectEngine, []);
  const eng = engine.data;

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)', marginTop: 0 }}>
          {t('windhawk.desktopOnly')}
        </p>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.blurb')}
      </p>

      <ModuleTabs
        tabs={[
          {
            id: 'overview',
            en: 'Overview',
            zh: '概覽',
            render: () => <OverviewTab engine={engine} desktop={desktop} />,
          },
          {
            id: 'installed',
            en: 'Installed mods',
            zh: '已安裝 mod',
            render: () => <InstalledTab desktop={desktop} engineReady={!!eng?.installed} />,
          },
          {
            id: 'settings',
            en: 'Mod settings',
            zh: 'Mod 設定',
            render: () => <ModSettingsTab desktop={desktop} />,
          },
          {
            id: 'repo',
            en: 'Repository',
            zh: '模組庫',
            render: () => <RepoTab desktop={desktop} exe={eng?.exe ?? null} />,
          },
          {
            id: 'engine',
            en: 'Engine',
            zh: '引擎',
            render: () => <EngineTab desktop={desktop} exe={eng?.exe ?? null} />,
          },
        ]}
      />
    </div>
  );
}

// ── Shared banner renderer ────────────────────────────────────────────────────────────────────────────
function BannerView({ banner }: { banner: Banner }) {
  return (
    <>
      {banner.msg && <p className="mod-msg">{banner.msg}</p>}
      {banner.err && <pre className="cmd-out error">{banner.err}</pre>}
    </>
  );
}

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Tab 1 — Overview: detection, install (gated), launch, folders, site, about.
function OverviewTab({ engine, desktop }: { engine: ReturnType<typeof useAsync<Engine>>; desktop: boolean }) {
  const { t } = useTranslation();
  const { data: eng, loading, error, reload } = engine;
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<Banner>({ msg: null, err: null });

  const guard = (): boolean => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return false;
    }
    setBanner({ msg: null, err: null });
    return true;
  };

  // Install the engine via winget (elevated service → may prompt UAC).
  const install = async () => {
    if (!guard()) return;
    setBusy('install');
    try {
      const r = await runCommand('winget', [
        'install', '--id', WINGET_ID, '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements',
      ]);
      if (r.success || r.code === 0) {
        setBanner({ msg: t('windhawk.installStarted'), err: null });
        reload();
      } else {
        setBanner({ msg: null, err: r.stderr.trim() || t('windhawk.installFailed') });
      }
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  const launch = async () => {
    if (!guard()) return;
    if (!eng?.exe) {
      setBanner({ msg: null, err: t('windhawk.notInstalled') });
      return;
    }
    setBusy('launch');
    try {
      const r: CommandOutput = await runCommand(eng.exe, []);
      if (r.success || r.code === 0) setBanner({ msg: t('windhawk.launched'), err: null });
      else setBanner({ msg: null, err: r.stderr.trim() || t('windhawk.launchFailed') });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  // Reveal a folder in Explorer (engine mods folder or the settings root).
  const openFolder = async (path: string | null, kind: string) => {
    if (!guard()) return;
    if (!path) {
      setBanner({ msg: null, err: t('windhawk.folderMissing') });
      return;
    }
    setBusy(kind);
    try {
      const r = await runCommand('explorer.exe', [path]);
      // explorer.exe returns a non-zero code even on success; treat launch as ok.
      void r;
      setBanner({ msg: t('windhawk.folderOpened'), err: null });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  const openUrl = async (url: string) => {
    if (!guard()) return;
    setBusy('url');
    try {
      await runPowershell(`Start-Process '${q(url)}'`);
      setBanner({ msg: t('windhawk.opened', { target: url }), err: null });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      <AsyncState loading={loading} error={error}>
        {/* Detection status */}
        <div className="panel">
          <div className="dt-wrap" style={{ border: 'none', maxHeight: 'none', overflow: 'visible' }}>
            <h4 style={{ margin: '0 0 8px' }}>{t('windhawk.appTitle')}</h4>
          </div>
          {eng?.installed ? (
            <p className="dep-ok" style={{ marginTop: 0 }}>
              ✓{' '}
              {eng.version
                ? t('windhawk.installedVer', { version: eng.version })
                : t('windhawk.installedNoVer')}
              {eng.exe ? <> · <code>{eng.exe}</code></> : null}
            </p>
          ) : (
            <>
              <p className="dep-missing" style={{ marginTop: 0 }}>
                ⚠ {t('windhawk.notInstalledHint')}
              </p>
              <div className="mod-toolbar">
                <button className="mini primary" disabled={!desktop || !!busy} onClick={install}>
                  {busy === 'install' ? t('windhawk.working') : t('windhawk.installAuto')}
                </button>
                <button className="mini" disabled={busy === 'recheck'} onClick={reload}>
                  ⟳ {t('windhawk.recheck')}
                </button>
              </div>
              <p className="count-note" style={{ marginBottom: 0 }}>
                {t('windhawk.installNote')}
              </p>
            </>
          )}

          {eng?.installed && (
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <button className="mini primary" disabled={!desktop || !!busy} onClick={launch}>
                {busy === 'launch' ? t('windhawk.working') : t('windhawk.launch')}
              </button>
              <button
                className="mini"
                disabled={!desktop || !!busy}
                onClick={() => openFolder(eng.engineFolder, 'engineFolder')}
              >
                {busy === 'engineFolder' ? t('windhawk.working') : t('windhawk.modsFolder')}
              </button>
              <button
                className="mini"
                disabled={!desktop || !!busy}
                onClick={() => openFolder(eng.settingsFolder, 'settingsFolder')}
              >
                {busy === 'settingsFolder' ? t('windhawk.working') : t('windhawk.settingsFolder')}
              </button>
              <button className="mini" disabled={!desktop || !!busy} onClick={() => openUrl(HOMEPAGE)}>
                {t('windhawk.browseAll')}
              </button>
              <button className="mini" disabled={busy === 'recheck'} onClick={reload}>
                ⟳ {t('windhawk.recheck')}
              </button>
            </div>
          )}
        </div>

        {/* About */}
        <div className="panel">
          <h4 style={{ margin: '0 0 6px' }}>{t('windhawk.aboutTitle')}</h4>
          <p className="count-note" style={{ margin: 0 }}>
            {t('windhawk.about')}
          </p>
        </div>

        <BannerView banner={banner} />
      </AsyncState>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Tab 2 — Installed mods: list from Engine\Mods + registry; enable / disable / remove (gated).
function InstalledTab({ desktop, engineReady }: { desktop: boolean; engineReady: boolean }) {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync<InstalledMod[]>(readInstalledMods, []);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<Banner>({ msg: null, err: null });

  const rows = useMemo(() => {
    const all = data ?? [];
    const f = filter.trim().toLowerCase();
    const list = f
      ? all.filter((m) => `${m.id} ${m.name} ${m.author}`.toLowerCase().includes(f))
      : all;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [data, filter]);

  // Toggle a mod's Disabled DWORD in the engine registry (gated). Restart engine to apply.
  const setEnabled = async (id: string, enable: boolean) => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    if (!isSafeId(id)) {
      setBanner({ msg: null, err: t('windhawk.badId') });
      return;
    }
    setBusy(id);
    setBanner({ msg: null, err: null });
    try {
      const key = `${REG_ENGINE_MODS}\\${id}`;
      const val = enable ? 0 : 1;
      const script =
        `$k='${q(key)}'; ` +
        `if(-not (Test-Path $k)){ New-Item -Path $k -Force | Out-Null }; ` +
        `New-ItemProperty -Path $k -Name 'Disabled' -PropertyType DWord -Value ${val} -Force | Out-Null; 'ok'`;
      const r = await runPowershell(script);
      if (!r.success && !r.stdout.includes('ok')) {
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      setBanner({
        msg: enable ? t('windhawk.enabled', { id }) : t('windhawk.disabled', { id }),
        err: null,
      });
      reload();
    } catch (e) {
      setBanner({ msg: null, err: `${t('windhawk.needsAdmin')} ${errText(e)}` });
    } finally {
      setBusy('');
    }
  };

  // Remove an installed mod: delete its Engine\Mods folder and registry key (gated + confirmed).
  const remove = async (id: string) => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    if (!isSafeId(id)) {
      setBanner({ msg: null, err: t('windhawk.badId') });
      return;
    }
    if (!window.confirm(t('windhawk.confirmRemove', { id }))) return;
    setBusy(id);
    setBanner({ msg: null, err: null });
    try {
      const script =
        `$id='${q(id)}'; ` +
        `$dir=(Join-Path $env:ProgramData ('${ENGINE_MODS_SUBPATH}\\' + $id)); ` +
        `if(Test-Path $dir){ Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop }; ` +
        `$k='${q(REG_ENGINE_MODS)}\\' + $id; ` +
        `if(Test-Path $k){ Remove-Item -Path $k -Recurse -Force -ErrorAction Stop }; 'ok'`;
      const r = await runPowershell(script);
      if (!r.success && !r.stdout.includes('ok')) {
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      setBanner({ msg: t('windhawk.removed', { id }), err: null });
      reload();
    } catch (e) {
      setBanner({ msg: null, err: `${t('windhawk.needsAdmin')} ${errText(e)}` });
    } finally {
      setBusy('');
    }
  };

  const columns: Column<InstalledMod>[] = [
    {
      key: 'enabled',
      header: t('windhawk.colState'),
      width: 96,
      render: (m) => (
        <StatusDot ok={m.enabled} label={m.enabled ? t('windhawk.on') : t('windhawk.off')} />
      ),
    },
    {
      key: 'name',
      header: t('windhawk.colName'),
      render: (m) => (
        <span>
          <span style={{ fontWeight: 600, display: 'block' }}>{m.name}</span>
          <span className="count-note" style={{ display: 'block' }}>
            {m.id}
            {m.author ? ` · ${t('windhawk.byAuthor', { author: m.author })}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'version', header: t('windhawk.colVersion'), width: 110 },
    {
      key: 'actions',
      header: '',
      width: 210,
      render: (m) => (
        <span className="row-actions">
          {m.enabled ? (
            <button
              className="mini"
              disabled={!desktop || busy === m.id}
              onClick={() => setEnabled(m.id, false)}
            >
              {busy === m.id ? t('windhawk.working') : t('windhawk.disable')}
            </button>
          ) : (
            <button
              className="mini primary"
              disabled={!desktop || busy === m.id}
              onClick={() => setEnabled(m.id, true)}
            >
              {busy === m.id ? t('windhawk.working') : t('windhawk.enable')}
            </button>
          )}
          <button
            className="mini danger"
            disabled={!desktop || busy === m.id}
            onClick={() => remove(m.id)}
          >
            {t('windhawk.remove')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <input
          className="mod-search"
          placeholder={t('windhawk.filterInstalled')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('windhawk.refresh')}
        </button>
        <span className="count-note">{t('windhawk.installedCount', { count: rows.length })}</span>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.installedNote')}
      </p>
      <BannerView banner={banner} />
      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(m) => m.id}
          empty={engineReady ? t('windhawk.noInstalled') : t('windhawk.engineMissing')}
        />
      </AsyncState>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Tab 3 — Per-mod settings: read the mod's registry Settings subkey, edit key=value lines, apply (gated).
interface SettingKV {
  Name: string;
  Value: string;
}

function ModSettingsTab({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [modId, setModId] = useState('');
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<Banner>({ msg: null, err: null });

  // Read HKLM\...\Engine\Mods\<id>\Settings values into key=value lines.
  const load = useCallback(async () => {
    const id = modId.trim();
    if (!id) {
      setBanner({ msg: null, err: t('windhawk.enterId') });
      return;
    }
    if (!isSafeId(id)) {
      setBanner({ msg: null, err: t('windhawk.badId') });
      return;
    }
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    setBusy('load');
    setBanner({ msg: null, err: null });
    try {
      const key = `${REG_ENGINE_MODS}\\${id}\\Settings`;
      const script =
        `$k='${q(key)}'; if(-not (Test-Path $k)){ return }; ` +
        `$p=Get-Item -Path $k; foreach($n in $p.GetValueNames()){ if($n){ ` +
        `[pscustomobject]@{ Name=$n; Value=[string]($p.GetValue($n)) } } }`;
      const rows = await runPowershellJson<SettingKV>(script);
      const body = rows.map((r) => `${r.Name}=${r.Value}`).join('\n');
      setText(body);
      setLoaded(id);
      setBanner({
        msg: rows.length ? t('windhawk.settingsLoaded', { count: rows.length }) : t('windhawk.noSettings'),
        err: null,
      });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  }, [modId, desktop, t]);

  // Write the edited key=value lines back to the Settings subkey as string values (gated).
  const apply = async () => {
    const id = loaded;
    if (!id || !isSafeId(id)) {
      setBanner({ msg: null, err: t('windhawk.loadFirst') });
      return;
    }
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    // Parse key=value lines client-side; build a here-string-free PS assignment list.
    const pairs: Array<[string, string]> = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) pairs.push([k, v]);
    }
    if (pairs.length === 0) {
      setBanner({ msg: null, err: t('windhawk.noPairs') });
      return;
    }
    if (!window.confirm(t('windhawk.confirmApply', { id, count: pairs.length }))) return;
    setBusy('apply');
    setBanner({ msg: null, err: null });
    try {
      const key = `${REG_ENGINE_MODS}\\${id}\\Settings`;
      const sets = pairs
        .map(
          ([k, v]) =>
            `New-ItemProperty -Path $k -Name '${q(k)}' -Value '${q(v)}' -PropertyType String -Force | Out-Null`,
        )
        .join('; ');
      const script =
        `$k='${q(key)}'; if(-not (Test-Path $k)){ New-Item -Path $k -Force | Out-Null }; ${sets}; 'ok'`;
      const r = await runPowershell(script);
      if (!r.success && !r.stdout.includes('ok')) {
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      setBanner({ msg: t('windhawk.settingsApplied', { id, count: pairs.length }), err: null });
    } catch (e) {
      setBanner({ msg: null, err: `${t('windhawk.needsAdmin')} ${errText(e)}` });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.settingsIntro')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          placeholder={t('windhawk.modIdPlaceholder')}
          value={modId}
          onChange={(e) => setModId(e.target.value)}
        />
        <button className="mini primary" disabled={!desktop || !!busy} onClick={load}>
          {busy === 'load' ? t('windhawk.working') : t('windhawk.loadSettings')}
        </button>
        <button
          className="mini"
          disabled={!desktop || !!busy || loaded === null}
          onClick={apply}
        >
          {busy === 'apply' ? t('windhawk.working') : t('windhawk.applySettings')}
        </button>
      </div>
      <BannerView banner={banner} />
      {loaded !== null && (
        <>
          <p className="count-note" style={{ marginBottom: 4 }}>
            {t('windhawk.settingsEditNote', { id: loaded })}
          </p>
          <textarea
            className="hosts-edit"
            style={{ minHeight: 260 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('windhawk.settingsPlaceholder')}
            spellCheck={false}
          />
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Tab 4 — Repository: curated gallery deep-links + install-by-id (gated).
function RepoTab({ desktop, exe }: { desktop: boolean; exe: string | null }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [installId, setInstallId] = useState('');
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<Banner>({ msg: null, err: null });

  const f = filter.trim().toLowerCase();
  const shown = f
    ? MODS.filter((m) =>
        `${m.id} ${m.enTitle} ${m.zhTitle} ${m.enDesc} ${m.zhDesc} ${m.author} ${m.keywords}`
          .toLowerCase()
          .includes(f),
      )
    : MODS;

  const openUrl = async (url: string) => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    setBusy('url');
    setBanner({ msg: null, err: null });
    try {
      await runPowershell(`Start-Process '${q(url)}'`);
      setBanner({ msg: t('windhawk.opened', { target: url }), err: null });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  // Install a mod by id: prefer the windhawk:// deep link (Windhawk registers the protocol and opens its
  // one-click installer for the mod); fall back to the windhawk.net mod page. Gated.
  const installMod = async (id: string) => {
    const clean = id.trim();
    if (!clean) {
      setBanner({ msg: null, err: t('windhawk.enterId') });
      return;
    }
    if (!isSafeId(clean)) {
      setBanner({ msg: null, err: t('windhawk.badId') });
      return;
    }
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    setBusy(`mod:${clean}`);
    setBanner({ msg: null, err: null });
    try {
      if (exe) {
        // Windhawk CLI: open its UI on the install-mod dialog for this id.
        const r = await runCommand(exe, ['-command', 'install-mod', '-mod', clean]);
        if (r.success || r.code === 0) {
          setBanner({ msg: t('windhawk.installModStarted', { id: clean }), err: null });
          return;
        }
      }
      // Deep-link fallback (protocol handler / web page).
      await runPowershell(`Start-Process '${q(MOD_PAGE_ROOT + clean)}'`);
      setBanner({ msg: t('windhawk.openedModPage', { id: clean }), err: null });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.galleryHint')}
      </p>

      {/* Install by id */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          placeholder={t('windhawk.installIdPlaceholder')}
          value={installId}
          onChange={(e) => setInstallId(e.target.value)}
        />
        <button
          className="mini primary"
          disabled={!desktop || !!busy}
          onClick={() => installMod(installId)}
        >
          {busy === `mod:${installId.trim()}` ? t('windhawk.working') : t('windhawk.installMod')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => openUrl(HOMEPAGE)}>
          {t('windhawk.browseAll')}
        </button>
      </div>
      <BannerView banner={banner} />

      {/* Curated gallery */}
      <div className="panel">
        <div className="dt-wrap" style={{ border: 'none', maxHeight: 'none', overflow: 'visible' }}>
          <h4 style={{ margin: '0 0 6px' }}>{t('windhawk.galleryTitle', { count: MODS.length })}</h4>
        </div>
        <input
          className="mod-search"
          style={{ maxWidth: 260, marginBottom: 8 }}
          placeholder={t('windhawk.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {shown.length === 0 ? (
          <p className="count-note">{t('windhawk.noMatch')}</p>
        ) : (
          <div className="kv-list">
            {shown.map((m) => (
              <div
                key={m.id}
                className="kv-row"
                style={{ alignItems: 'flex-start', gap: 12, padding: '10px 0' }}
              >
                <span className="label" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, display: 'block' }}>{m.enTitle}</span>
                  <span className="count-note" style={{ display: 'block' }}>{m.zhTitle}</span>
                  <span className="count-note" style={{ display: 'block', marginTop: 2 }}>{m.enDesc}</span>
                  <span className="count-note" style={{ display: 'block' }}>{m.zhDesc}</span>
                  <span className="count-note" style={{ display: 'block', marginTop: 2 }}>
                    {t('windhawk.byAuthor', { author: m.author })}
                  </span>
                </span>
                <span className="row-actions" style={{ flexDirection: 'column' }}>
                  <button
                    className="mini primary"
                    disabled={!desktop || !!busy}
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => installMod(m.id)}
                  >
                    {busy === `mod:${m.id}` ? t('windhawk.working') : t('windhawk.installMod')}
                  </button>
                  <button
                    className="mini"
                    disabled={!desktop || !!busy}
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => openUrl(MOD_PAGE_ROOT + m.id)}
                  >
                    {t('windhawk.openInWindhawk')}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Tab 5 — Engine: the elevated windhawk.service (start / stop / restart), gated; stop confirms.
interface SvcInfo {
  Status: string;
  StartType: string;
  Found: boolean;
}

function EngineTab({ desktop, exe }: { desktop: boolean; exe: string | null }) {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync<SvcInfo>(async () => {
    const rows = await runPowershellJson<SvcInfo>(
      `$s=Get-Service -Name '${ENGINE_SERVICE}' -ErrorAction SilentlyContinue; ` +
        `if($s){ [pscustomobject]@{ Status=$s.Status.ToString(); StartType=$s.StartType.ToString(); Found=$true } } ` +
        `else { [pscustomobject]@{ Status='—'; StartType='—'; Found=$false } }`,
    );
    return rows[0] ?? { Status: '—', StartType: '—', Found: false };
  }, []);
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<Banner>({ msg: null, err: null });

  const svc = data ?? { Status: '—', StartType: '—', Found: false };
  const running = svc.Status === 'Running';

  const act = async (verb: 'Start' | 'Stop' | 'Restart') => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    if (verb === 'Stop' && !window.confirm(t('windhawk.confirmStop'))) return;
    setBusy(verb);
    setBanner({ msg: null, err: null });
    try {
      const r = await runPowershell(
        `${verb}-Service -Name '${ENGINE_SERVICE}' -Force -ErrorAction Stop; 'ok'`,
      );
      if (!r.success && !r.stdout.includes('ok')) {
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      setBanner({ msg: t('windhawk.engineActed', { verb }), err: null });
      reload();
    } catch (e) {
      setBanner({ msg: null, err: `${t('windhawk.needsAdmin')} ${errText(e)}` });
    } finally {
      setBusy('');
    }
  };

  // Relaunch the Windhawk UI (engine picks up config on next injection cycle).
  const relaunch = async () => {
    if (!desktop) {
      setBanner({ msg: null, err: t('windhawk.desktopOnly') });
      return;
    }
    if (!exe) {
      setBanner({ msg: null, err: t('windhawk.notInstalled') });
      return;
    }
    setBusy('launch');
    setBanner({ msg: null, err: null });
    try {
      const r = await runCommand(exe, []);
      if (r.success || r.code === 0) setBanner({ msg: t('windhawk.launched'), err: null });
      else setBanner({ msg: null, err: r.stderr.trim() || t('windhawk.launchFailed') });
    } catch (e) {
      setBanner({ msg: null, err: errText(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.engineIntro')}
      </p>
      <BannerView banner={banner} />
      <AsyncState loading={loading} error={error}>
        <div className="panel">
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('windhawk.engineService')}</span>
              <span>
                {svc.Found ? (
                  <StatusDot ok={running} label={svc.Status} />
                ) : (
                  <span className="count-note">{t('windhawk.svcMissing')}</span>
                )}
              </span>
            </div>
            {svc.Found && (
              <div className="kv-row">
                <span className="label">{t('windhawk.startType')}</span>
                <span className="count-note">{svc.StartType}</span>
              </div>
            )}
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            {running ? (
              <>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => act('Restart')}>
                  {busy === 'Restart' ? t('windhawk.working') : t('windhawk.restartEngine')}
                </button>
                <button
                  className="mini danger"
                  disabled={!desktop || !!busy}
                  onClick={() => act('Stop')}
                >
                  {busy === 'Stop' ? t('windhawk.working') : t('windhawk.stopEngine')}
                </button>
              </>
            ) : (
              <button
                className="mini primary"
                disabled={!desktop || !!busy || !svc.Found}
                onClick={() => act('Start')}
              >
                {busy === 'Start' ? t('windhawk.working') : t('windhawk.startEngine')}
              </button>
            )}
            <button className="mini" disabled={!desktop || !!busy} onClick={relaunch}>
              {busy === 'launch' ? t('windhawk.working') : t('windhawk.relaunchUi')}
            </button>
            <button className="mini" disabled={busy === 'recheck'} onClick={reload}>
              ⟳ {t('windhawk.refresh')}
            </button>
          </div>
          <p className="count-note" style={{ marginBottom: 0 }}>
            {t('windhawk.engineNote')}
          </p>
        </div>
      </AsyncState>
    </div>
  );
}
