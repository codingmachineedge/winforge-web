import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — front-end for the official Windhawk mod platform (winget RamenSoftware.Windhawk).
// Windhawk itself is a C++ injection engine that compiles community "mods" and injects them into
// explorer.exe / the taskbar via an elevated service; cloning it is out of scope. So WinForge resolves
// windhawk.exe (DependencyGate), launches its UI, opens the engine/mods folder, and deep-links to each
// mod's page on windhawk.net where the user installs / configures it inside Windhawk. Live actions
// (launch, open folder, open URL) need the WinForge desktop shell (Tauri). Never throws.

interface Mod {
  id: string; // windhawk.net mod slug
  enTitle: string;
  zhTitle: string;
  enDesc: string;
  zhDesc: string;
  author: string;
  keywords: string;
}

// Curated bilingual gallery mirroring WinForge's WindhawkMods catalog.
const MODS: Mod[] = [
  {
    id: 'taskbar-icon-size',
    enTitle: 'Taskbar height and icon size',
    zhTitle: '工作列高度同圖示大小',
    enDesc: 'Make the Windows 11 taskbar shorter or taller and resize its icons — the most popular taskbar mod.',
    zhDesc: '調校 Windows 11 工作列高度，並重新設定圖示大小 — 最受歡迎嘅工作列 mod。',
    author: 'm417z',
    keywords: 'taskbar height icon size 工作列 高度 圖示',
  },
  {
    id: 'taskbar-clock-customization',
    enTitle: 'Taskbar Clock Customization',
    zhTitle: '工作列時鐘自訂',
    enDesc: 'Add seconds, the date, week number, custom text or even weather to the system-tray clock.',
    zhDesc: '喺系統匣時鐘加上秒數、日期、週次、自訂文字甚至天氣。',
    author: 'm417z',
    keywords: 'clock seconds date weather tray 時鐘 秒 日期 天氣',
  },
  {
    id: 'taskbar-grouping',
    enTitle: 'Disable grouping on the taskbar',
    zhTitle: '停用工作列群組',
    enDesc: 'Stop Windows from combining windows of the same app into a single taskbar button.',
    zhDesc: '唔再將同一個程式嘅視窗併埋成一粒工作列按鈕。',
    author: 'm417z',
    keywords: 'taskbar grouping ungroup labels 工作列 群組 標籤',
  },
  {
    id: 'windows-11-start-menu-styler',
    enTitle: 'Windows 11 Start Menu Styler',
    zhTitle: 'Windows 11 開始功能表美化',
    enDesc: 'Deeply restyle the Start menu with community themes — hide the recommended section, change layout, and more.',
    zhDesc: '用社群主題深度美化開始功能表 — 隱藏推薦區、改版面等等。',
    author: 'm417z',
    keywords: 'start menu styler theme recommended 開始 功能表 主題 推薦',
  },
  {
    id: 'windows-11-taskbar-styler',
    enTitle: 'Windows 11 Taskbar Styler',
    zhTitle: 'Windows 11 工作列美化',
    enDesc: 'Restyle the taskbar with community themes (translucent, segmented, classic-like, and many more).',
    zhDesc: '用社群主題美化工作列（半透明、分段、近似經典等多款）。',
    author: 'm417z',
    keywords: 'taskbar styler theme translucent 工作列 美化 主題 半透明',
  },
  {
    id: 'classic-taskbar-background-fixed',
    enTitle: 'Classic Taskbar (background fix)',
    zhTitle: '經典工作列（背景修正）',
    enDesc: 'Bring back a more classic, opaque taskbar look on Windows 11.',
    zhDesc: '喺 Windows 11 帶返較經典、不透明嘅工作列外觀。',
    author: 'ujk',
    keywords: 'classic taskbar opaque background 經典 工作列 不透明',
  },
  {
    id: 'taskbar-on-top',
    enTitle: 'Taskbar position on screen',
    zhTitle: '工作列螢幕位置',
    enDesc: 'Move the Windows 11 taskbar to the top, left or right edge of the screen.',
    zhDesc: '將 Windows 11 工作列移到螢幕頂部、左邊或右邊。',
    author: 'm417z',
    keywords: 'taskbar top left right position 工作列 頂部 位置',
  },
  {
    id: 'aerexplorer',
    enTitle: 'Aerexplorer (classic Explorer tweaks)',
    zhTitle: 'Aerexplorer（經典檔案總管調校）',
    enDesc: 'A bundle of File Explorer tweaks: classic search box, ribbon, details pane and more Aero-era behaviour.',
    zhDesc: '一系列檔案總管調校：經典搜尋框、功能區、詳細資料窗格等 Aero 年代行為。',
    author: 'Anixx',
    keywords: 'explorer aero ribbon search 檔案總管 經典 功能區',
  },
  {
    id: 'better-file-sizes-in-explorer-details',
    enTitle: 'Better file sizes in Explorer',
    zhTitle: '檔案總管更佳檔案大小',
    enDesc: 'Show file sizes for folders and use MB/GB units consistently in the Explorer details view.',
    zhDesc: '喺檔案總管詳細資料檢視顯示資料夾大小，並一致使用 MB／GB 單位。',
    author: 'Waldemar',
    keywords: 'explorer file size folder mb gb 檔案 大小 資料夾',
  },
  {
    id: 'disable-rounded-corners',
    enTitle: 'Disable rounded corners',
    zhTitle: '停用圓角',
    enDesc: 'Turn off the Windows 11 rounded window corners to get sharp, square edges back.',
    zhDesc: '關閉 Windows 11 圓角視窗，帶返尖角方正邊緣。',
    author: 'm417z',
    keywords: 'rounded corners square sharp window 圓角 方角 視窗',
  },
  {
    id: 'aero-tray',
    enTitle: 'Aero Tray',
    zhTitle: 'Aero 系統匣',
    enDesc: 'Restore Aero-style behaviour to the notification area / system tray.',
    zhDesc: '為通知區／系統匣帶返 Aero 風格行為。',
    author: 'Anixx',
    keywords: 'aero tray notification area 系統匣 通知區',
  },
  {
    id: 'start-menu-all-apps',
    enTitle: "Open Start menu on 'All apps'",
    zhTitle: '開始功能表直接顯示「所有應用程式」',
    enDesc: 'Make the Start menu open straight to the All apps list instead of the pinned/recommended page.',
    zhDesc: '令開始功能表一開就顯示「所有應用程式」清單，唔再停喺釘選／推薦頁。',
    author: 'm417z',
    keywords: 'start menu all apps pinned 開始 所有應用程式 釘選',
  },
  {
    id: 'middle-click-to-close',
    enTitle: 'Middle click to close on the taskbar',
    zhTitle: '中鍵點擊關閉工作列項目',
    enDesc: 'Close a taskbar window with a middle mouse click — like a browser tab.',
    zhDesc: '用滑鼠中鍵一㩒就關閉工作列視窗 — 似瀏覽器分頁咁。',
    author: 'm417z',
    keywords: 'middle click close taskbar tab 中鍵 關閉 工作列',
  },
  {
    id: 'acrylic-effect-radius-changer',
    enTitle: 'Acrylic / blur effect tuner',
    zhTitle: '壓克力／模糊效果調校',
    enDesc: 'Tune the acrylic blur radius and effects used across the Windows 11 UI.',
    zhDesc: '調校 Windows 11 介面所用嘅壓克力模糊半徑同效果。',
    author: 'm417z',
    keywords: 'acrylic blur radius effect transparency 壓克力 模糊 半透明',
  },
];

const MOD_PAGE_ROOT = 'https://windhawk.net/mods/';
const HOMEPAGE = 'https://windhawk.net/';

export function WindhawkModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [out, setOut] = useState('');

  const clear = () => {
    setMsg('');
    setErr('');
    setOut('');
  };

  // Open a URL with the system default handler.
  const openUrl = async (url: string) => {
    clear();
    if (!desktop) {
      setErr(t('windhawk.desktopOnly'));
      return;
    }
    setBusy('url');
    try {
      // Start-Process on a URL uses the system handler (default browser).
      await runPowershell(`Start-Process '${url.replace(/'/g, "''")}'`);
      setMsg(t('windhawk.opened', { target: url }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const openModPage = (id: string) => openUrl(MOD_PAGE_ROOT + id);

  // Launch the Windhawk UI (detached GUI app).
  const launch = async (exe: string) => {
    clear();
    if (!desktop) {
      setErr(t('windhawk.desktopOnly'));
      return;
    }
    setBusy('launch');
    try {
      const r: CommandOutput = await runCommand(exe, []);
      if (r.success || r.code === 0) {
        setMsg(t('windhawk.launched'));
      } else {
        setErr(r.stderr.trim() || t('windhawk.launchFailed'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Open the Windhawk engine folder (%ProgramData%\Windhawk\Engine), where mod configs live.
  const openEngineFolder = async () => {
    clear();
    if (!desktop) {
      setErr(t('windhawk.desktopOnly'));
      return;
    }
    setBusy('folder');
    try {
      const script =
        `$f = Join-Path $env:ProgramData 'Windhawk\\Engine'; ` +
        `if (Test-Path $f) { Start-Process -FilePath 'explorer.exe' -ArgumentList $f; 'OK' } ` +
        `else { 'MISSING' }`;
      const r = await runPowershell(script);
      if ((r.stdout || '').trim() === 'MISSING') {
        setErr(t('windhawk.folderMissing'));
      } else if (r.success) {
        setMsg(t('windhawk.folderOpened'));
      } else {
        setErr(r.stderr.trim() || t('windhawk.folderFailed'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const f = filter.trim().toLowerCase();
  const shown = f
    ? MODS.filter(
        (m) =>
          `${m.id} ${m.enTitle} ${m.zhTitle} ${m.enDesc} ${m.zhDesc} ${m.author} ${m.keywords}`
            .toLowerCase()
            .includes(f),
      )
    : MODS;

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('windhawk.desktopOnly')}
        </p>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('windhawk.blurb')}
      </p>

      <DependencyGate tool="windhawk" preferId="RamenSoftware.Windhawk" query="windhawk">
        {(exe) => (
          <>
            {/* Primary actions */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('windhawk.appTitle')}</h4>
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini primary" disabled={!desktop || !!busy} onClick={() => launch(exe)}>
                  {busy === 'launch' ? t('windhawk.working') : t('windhawk.launch')}
                </button>
                <button className="mini" disabled={!desktop || !!busy} onClick={openEngineFolder}>
                  {busy === 'folder' ? t('windhawk.working') : t('windhawk.modsFolder')}
                </button>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => openUrl(HOMEPAGE)}>
                  {t('windhawk.browseAll')}
                </button>
              </div>
              <p className="count-note" style={{ marginTop: 8 }}>
                {t('windhawk.about')}
              </p>
            </div>

            {/* Curated mod gallery */}
            <div className="panel">
              <div className="dt-wrap">
                <h4>{t('windhawk.galleryTitle', { count: MODS.length })}</h4>
              </div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('windhawk.galleryHint')}
              </p>
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
                        <span className="count-note" style={{ display: 'block', marginTop: 2 }}>
                          {m.enDesc}
                        </span>
                        <span className="count-note" style={{ display: 'block' }}>{m.zhDesc}</span>
                        <span className="count-note" style={{ display: 'block', marginTop: 2 }}>
                          {t('windhawk.byAuthor', { author: m.author })}
                        </span>
                      </span>
                      <button
                        className="mini primary"
                        disabled={!desktop || !!busy}
                        style={{ whiteSpace: 'nowrap' }}
                        onClick={() => openModPage(m.id)}
                      >
                        {t('windhawk.openInWindhawk')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {msg && <p className="dep-ok">{msg}</p>}
            {err && <pre className="cmd-out error">{err}</pre>}
            {out && <pre className="cmd-out">{out}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
