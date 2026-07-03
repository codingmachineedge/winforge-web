import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';
import { isTauri, runPowershellJson } from '../tauri/bridge';
import { ModuleToolbar, StatusDot, useAsync } from './common';

// Native OSS clone hub — port of WinForge's OpenSourceAppHubModule (module.ossapps).
// A native-only map of open-source app ideas remade as in-app tabs. Faithful to the
// original: search, category filter, summary line, license notice, and per-entry
// cards (name, inspiration, --page alias, implementation notes, status pill).
// Live addition through the system backend: read-only detection of whether each
// UPSTREAM open-source app is installed on this PC (uninstall registry + PATH,
// where.exe style). The page keeps the original rule: nothing is installed,
// launched or modified from here.

interface CloneInfo {
  nameEn: string;
  nameZh: string;
  inspiredBy: string;
  catEn: string;
  catZh: string;
  descEn: string;
  descZh: string;
  tag: string; // in-app module tag, e.g. module.apiclient
  alias: string; // --page alias (also the detection row id)
  statusEn: string;
  statusZh: string;
  implEn: string;
  implZh: string;
  tags: string[];
  detect: { rx: string; exes: string[] }; // upstream app fingerprints
}

interface DetectRow {
  id: string;
  found: boolean;
  via: string; // 'registry' | 'path'
  detail: string;
}

// Catalog ported verbatim from WinForge Services/OpenSourceAppHubService.cs.
const CATALOG: CloneInfo[] = [
  {
    nameEn: 'API Client', nameZh: 'REST API 用戶端', inspiredBy: 'Postman / Insomnia',
    catEn: 'Developer & data', catZh: '開發與數據',
    descEn: 'Build, send and save REST requests in-app with collections and environments.',
    descZh: '喺 app 內建立、發送同儲存 REST 請求，支援集合與環境變數。',
    tag: 'module.apiclient', alias: 'api', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'C# HttpClient engine with JSON workspace persistence.',
    implZh: 'C# HttpClient 引擎，加 JSON 工作區持久化。',
    tags: ['rest', 'http', 'api', 'postman'],
    detect: { rx: 'Postman|Insomnia', exes: ['postman', 'insomnia'] },
  },
  {
    nameEn: 'Diff & Merge', nameZh: '比對與合併', inspiredBy: 'WinMerge',
    catEn: 'Developer & data', catZh: '開發與數據',
    descEn: 'Side-by-side file and folder diff/merge with patch export.',
    descZh: '並排檔案／資料夾比對與合併，可匯出 patch。',
    tag: 'module.diffmerge', alias: 'diff', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'C# text/folder comparison surface inside WinForge.',
    implZh: 'WinForge 內建 C# 文字／資料夾比對介面。',
    tags: ['diff', 'merge', 'winmerge'],
    detect: { rx: 'WinMerge', exes: ['winmergeu', 'winmerge'] },
  },
  {
    nameEn: 'Diagram Editor', nameZh: '圖表編輯器', inspiredBy: 'draw.io / diagrams.net',
    catEn: 'Developer & data', catZh: '開發與數據',
    descEn: 'Flowchart and diagram canvas with JSON/PNG export.',
    descZh: '流程圖同圖表畫布，可匯出 JSON／PNG。',
    tag: 'module.diagram', alias: 'diagram', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'WinUI canvas model with local serialization.',
    implZh: 'WinUI 畫布模型，加本機序列化。',
    tags: ['diagram', 'flowchart', 'drawio'],
    detect: { rx: 'draw\\.io|diagrams\\.net', exes: ['draw.io', 'drawio'] },
  },
  {
    nameEn: '.NET Decompiler', nameZh: '.NET 反編譯器', inspiredBy: 'ILSpy',
    catEn: 'Developer & data', catZh: '開發與數據',
    descEn: 'Browse assemblies and decompile IL to readable C#.',
    descZh: '瀏覽組件並將 IL 反編譯成可讀 C#。',
    tag: 'module.decompiler', alias: 'decompiler', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'ICSharpCode.Decompiler runs in-process; no ILSpy executable.',
    implZh: 'ICSharpCode.Decompiler 喺程序內運行；唔啟動 ILSpy exe。',
    tags: ['ilspy', 'decompile', 'dotnet'],
    detect: { rx: 'ILSpy', exes: ['ilspy'] },
  },
  {
    nameEn: 'SQLite Browser', nameZh: 'SQLite 資料庫瀏覽器', inspiredBy: 'DB Browser for SQLite',
    catEn: 'Developer & data', catZh: '開發與數據',
    descEn: 'Open SQLite files, inspect schema, edit rows and run SQL.',
    descZh: '開 SQLite 檔、檢視結構、編輯資料列同執行 SQL。',
    tag: 'module.sqlitebrowser', alias: 'sqlite', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'Microsoft.Data.Sqlite-backed browser/editor.',
    implZh: '以 Microsoft.Data.Sqlite 驅動嘅瀏覽／編輯器。',
    tags: ['sqlite', 'database', 'sql'],
    detect: { rx: 'DB Browser for SQLite', exes: ['sqlitebrowser'] },
  },
  {
    nameEn: 'Feed Reader', nameZh: 'RSS 閱讀器', inspiredBy: 'QuiteRSS / Fluent Reader',
    catEn: 'Documents & knowledge', catZh: '文件與知識',
    descEn: 'Subscribe to RSS/Atom feeds, refresh articles and read summaries in-app.',
    descZh: '訂閱 RSS／Atom feed、重新整理文章，並喺 app 內閱讀摘要。',
    tag: 'module.feedreader', alias: 'rss', statusEn: 'New native tab', statusZh: '新增原生分頁',
    implEn: 'C# HttpClient + XML parser with local JSON feed storage.',
    implZh: 'C# HttpClient + XML 解析器，加本機 JSON feed 儲存。',
    tags: ['rss', 'atom', 'news', 'reader'],
    detect: { rx: 'QuiteRSS|Fluent Reader', exes: ['quiterss'] },
  },
  {
    nameEn: 'Flashcards', nameZh: '間隔重複記憶卡', inspiredBy: 'Anki',
    catEn: 'Documents & knowledge', catZh: '文件與知識',
    descEn: 'Decks, cards, CSV import/export and SM-2 review scheduling.',
    descZh: '牌組、卡片、CSV 匯入／匯出同 SM-2 複習排程。',
    tag: 'module.flashcards', alias: 'flashcards', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'Managed C# scheduler and JSON deck store.',
    implZh: '受控 C# 排程器同 JSON 牌組儲存。',
    tags: ['anki', 'srs', 'study'],
    detect: { rx: 'Anki', exes: ['anki'] },
  },
  {
    nameEn: 'PDF Toolkit', nameZh: 'PDF 工具箱', inspiredBy: 'Stirling-PDF / PDFsam',
    catEn: 'Media & documents', catZh: '媒體與文件',
    descEn: 'Merge, split, rotate, watermark, encrypt and extract from PDFs.',
    descZh: '合併、分割、旋轉、加浮水印、加密同抽取 PDF。',
    tag: 'module.pdftoolkit', alias: 'pdf', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'PDFsharp and PdfPig run inside WinForge.',
    implZh: 'PDFsharp 同 PdfPig 喺 WinForge 內運行。',
    tags: ['pdf', 'pdfsam', 'stirling'],
    detect: { rx: 'PDFsam|Stirling', exes: ['pdfsam'] },
  },
  {
    nameEn: 'Audio Tagger', nameZh: '音訊標籤編輯器', inspiredBy: 'Mp3tag / Kid3',
    catEn: 'Media & documents', catZh: '媒體與文件',
    descEn: 'Batch-edit audio metadata and cover art.',
    descZh: '批次編輯音訊中繼資料同封面圖。',
    tag: 'module.audiotagger', alias: 'tags', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'TagLibSharp metadata engine in-process.',
    implZh: 'TagLibSharp 中繼資料引擎喺程序內運行。',
    tags: ['mp3tag', 'id3', 'flac'],
    detect: { rx: 'Mp3tag|Kid3', exes: ['mp3tag', 'kid3'] },
  },
  {
    nameEn: 'Image Editor', nameZh: '點陣圖影像編輯器', inspiredBy: 'GIMP / Paint.NET',
    catEn: 'Media & documents', catZh: '媒體與文件',
    descEn: 'Open images, adjust color, apply filters, crop, resize and layer edits.',
    descZh: '開圖、調色、套濾鏡、裁切、縮放同圖層編輯。',
    tag: 'module.imageeditor', alias: 'imageeditor', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'SixLabors.ImageSharp processing in managed C#.',
    implZh: 'SixLabors.ImageSharp 以受控 C# 處理影像。',
    tags: ['gimp', 'paint', 'image'],
    detect: { rx: 'GIMP|paint\\.net', exes: ['gimp'] },
  },
  {
    nameEn: 'Text Extractor', nameZh: '原生文字辨識', inspiredBy: 'NormCap / PowerToys Text Extractor',
    catEn: 'Media & documents', catZh: '媒體與文件',
    descEn: 'OCR a screen region or image file using Windows OCR.',
    descZh: '用 Windows OCR 辨識螢幕區域或圖片檔。',
    tag: 'module.textocr', alias: 'ocr', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'Windows.Media.Ocr WinRT engine, no Tesseract executable.',
    implZh: 'Windows.Media.Ocr WinRT 引擎，無 Tesseract exe。',
    tags: ['ocr', 'text', 'normcap'],
    detect: { rx: 'NormCap|PowerToys', exes: ['normcap'] },
  },
  {
    nameEn: 'KeePass Vault', nameZh: '密碼保險庫', inspiredBy: 'KeePass / KeePassXC',
    catEn: 'Security & privacy', catZh: '安全與私隱',
    descEn: 'Open and manage local KDBX password databases.',
    descZh: '開啟同管理本機 KDBX 密碼資料庫。',
    tag: 'module.keepass', alias: 'keepass', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'KDBX parser/crypto in managed C# with Argon2 support.',
    implZh: '受控 C# KDBX 解析／加密，支援 Argon2。',
    tags: ['keepass', 'kdbx', 'password'],
    detect: { rx: 'KeePass', exes: ['keepassxc', 'keepass'] },
  },
  {
    nameEn: 'Native Torrent', nameZh: '原生種子下載', inspiredBy: 'qBittorrent / Transmission',
    catEn: 'Network & transfer', catZh: '網絡與傳輸',
    descEn: 'Download magnets/torrents with an in-process BitTorrent engine.',
    descZh: '用程序內 BitTorrent 引擎下載磁力／種子。',
    tag: 'module.torrent', alias: 'torrent', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'MonoTorrent engine, no qBittorrent process required.',
    implZh: 'MonoTorrent 引擎，唔需要 qBittorrent 程序。',
    tags: ['torrent', 'magnet', 'bittorrent'],
    detect: { rx: 'qBittorrent|Transmission', exes: ['qbittorrent', 'transmission-qt'] },
  },
  {
    nameEn: 'Docker', nameZh: 'Docker 容器管理', inspiredBy: 'Docker Desktop / Portainer',
    catEn: 'Virtualization & containers', catZh: '虛擬化與容器',
    descEn: 'Manage containers, images, volumes, networks and compose stacks.',
    descZh: '管理容器、映像、磁碟區、網路同 compose stack。',
    tag: 'module.docker', alias: 'docker', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'Docker.DotNet talks to Docker Engine API directly.',
    implZh: 'Docker.DotNet 直接連 Docker Engine API。',
    tags: ['docker', 'container', 'portainer'],
    detect: { rx: 'Docker Desktop|Portainer', exes: ['docker'] },
  },
  {
    nameEn: 'Process Explorer', nameZh: '程序總管', inspiredBy: 'Sysinternals Process Explorer',
    catEn: 'System utilities', catZh: '系統工具',
    descEn: 'Inspect process trees, paths, command lines, CPU, memory and modules.',
    descZh: '檢視程序樹、路徑、命令列、CPU、記憶體同模組。',
    tag: 'module.procexp', alias: 'procexp', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'C# process/WMI/module inspection inside WinForge.',
    implZh: 'WinForge 內建 C# 程序／WMI／模組檢視。',
    tags: ['process', 'taskmanager', 'sysinternals'],
    detect: { rx: 'Process Explorer', exes: ['procexp', 'procexp64'] },
  },
  {
    nameEn: 'Disk Health', nameZh: '硬碟健康', inspiredBy: 'CrystalDiskInfo',
    catEn: 'System utilities', catZh: '系統工具',
    descEn: 'Show SMART health, temperatures and disk warning signals.',
    descZh: '顯示 SMART 健康、溫度同硬碟警號。',
    tag: 'module.diskhealth', alias: 'diskhealth', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'Native storage counters and SMART collection.',
    implZh: '原生儲存計數器與 SMART 收集。',
    tags: ['smart', 'disk', 'crystaldiskinfo'],
    detect: { rx: 'CrystalDiskInfo', exes: ['DiskInfo64'] },
  },
  {
    nameEn: 'Disk Benchmark', nameZh: '硬碟速度測試', inspiredBy: 'CrystalDiskMark',
    catEn: 'System utilities', catZh: '系統工具',
    descEn: 'Run sequential/random disk speed tests from WinForge.',
    descZh: '喺 WinForge 內執行循序／隨機磁碟速度測試。',
    tag: 'module.diskbench', alias: 'diskbench', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'C# benchmark runner with managed result UI.',
    implZh: 'C# 測速執行器，加受控結果介面。',
    tags: ['benchmark', 'disk', 'crystaldiskmark'],
    detect: { rx: 'CrystalDiskMark', exes: ['DiskMark64'] },
  },
  {
    nameEn: 'Everything Search', nameZh: '即時檔案搜尋', inspiredBy: 'Everything',
    catEn: 'Files & disks', catZh: '檔案與磁碟',
    descEn: 'Instant NTFS filename index/search inside WinForge.',
    descZh: '喺 WinForge 入面做即時 NTFS 檔名索引／搜尋。',
    tag: 'module.everything', alias: 'everything', statusEn: 'Native tab', statusZh: '原生分頁',
    implEn: 'In-app index/search surface, no Everything UI redirect.',
    implZh: 'App 內索引／搜尋介面，唔跳去 Everything UI。',
    tags: ['search', 'files', 'ntfs'],
    detect: { rx: '^Everything', exes: ['everything', 'es'] },
  },
];

// Mirrors NativeOssCloneInfo.SearchHaystack (plus the module tag for convenience).
function haystack(a: CloneInfo): string {
  return (
    `${a.nameEn} ${a.nameZh} ${a.inspiredBy} ${a.catEn} ${a.catZh} ${a.descEn} ${a.descZh} ` +
    `${a.alias} ${a.tag} ${a.statusEn} ${a.statusZh} ${a.implEn} ${a.implZh} ${a.tags.join(' ')}`
  ).toLowerCase();
}

// Read-only upstream detection: uninstall registry (HKLM 64/32-bit + HKCU) by
// DisplayName pattern, then PATH lookup (where.exe equivalent via Get-Command).
// Windows PowerShell 5.1-compatible; emits one row per catalog entry.
function buildDetectScript(): string {
  const specs = CATALOG.map(
    (c) => `@{id='${c.alias}';rx='${c.detect.rx}';exes=@(${c.detect.exes.map((e) => `'${e}'`).join(',')})}`,
  ).join(',');
  return (
    `$roots='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',` +
    `'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',` +
    `'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; ` +
    `$inst=@(); foreach($r in $roots){ $inst+=@(Get-ItemProperty -Path $r -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName }) }; ` +
    `$specs=@(${specs}); ` +
    `foreach($s in $specs){ ` +
    `$hit=$inst | Where-Object { $_.DisplayName -match $s.rx } | Select-Object -First 1; ` +
    `if($hit){ [pscustomobject]@{ id=[string]$s.id; found=$true; via='registry'; detail=(([string]$hit.DisplayName+' '+[string]$hit.DisplayVersion).Trim()) } } ` +
    `else { $cmd=$null; foreach($e in $s.exes){ if($null -eq $cmd){ $cmd=@(Get-Command -Name ($e+'.exe') -CommandType Application -ErrorAction SilentlyContinue)[0] } }; ` +
    `if($cmd){ [pscustomobject]@{ id=[string]$s.id; found=$true; via='path'; detail=[string]$cmd.Source } } ` +
    `else { [pscustomobject]@{ id=[string]$s.id; found=$false; via=''; detail='' } } } }`
  );
}

const DETECT_SCRIPT = buildDetectScript();

export function OpenSourceAppHubModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const desktop = isTauri();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');

  // Auto-runs on mount (read-only scan, same pattern as the Services module);
  // in a plain browser the bridge no-ops and the full catalog still renders.
  const { data, loading, error, reload } = useAsync(async () => {
    if (!isTauri()) return [] as DetectRow[];
    return runPowershellJson<DetectRow>(DETECT_SCRIPT);
  }, []);

  const detected = useMemo(() => new Map((data ?? []).map((r) => [r.id, r])), [data]);
  const foundCount = useMemo(() => (data ?? []).filter((r) => r.found).length, [data]);

  // Distinct categories ordered like OpenSourceAppHubService.CategoryKeys.
  const cats = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of CATALOG) if (!seen.has(a.catEn)) seen.set(a.catEn, a.catZh);
    return [...seen.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATALOG.filter((a) => !category || a.catEn === category)
      .filter((a) => !q || haystack(a).includes(q))
      .sort((a, b) => a.catEn.localeCompare(b.catEn) || a.nameEn.localeCompare(b.nameEn));
  }, [query, category]);

  // Web counterpart of the original "Open tab" button: copy the module name and
  // open the app's command palette (same handler as pressing Ctrl+K).
  const findInApp = (app: CloneInfo) => {
    try {
      void navigator.clipboard?.writeText(app.nameEn)?.catch(() => undefined);
    } catch {
      /* clipboard unavailable — the palette still opens */
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ossapps.blurb')}{' '}
        <span className="mini" title={t('ossapps.nativeOnlyTip')}>
          ⛨ {t('ossapps.nativeOnly')}
        </span>
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('ossapps.desktopOnly')}</p>
      )}

      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ maxWidth: 300 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ossapps.searchPlaceholder')}
        />
        <select
          className="mod-search"
          style={{ maxWidth: 240 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('ossapps.allCategories')}</option>
          {cats.map(([en, zh]) => (
            <option key={en} value={en}>
              {pick(en, zh, lang)}
            </option>
          ))}
        </select>
        <button className="mini" onClick={() => { setQuery(''); setCategory(''); }}>
          {t('ossapps.clear')}
        </button>
        <button className="mini" disabled={!desktop || loading} onClick={reload}>
          ⟳ {loading && desktop ? t('ossapps.scanning') : t('ossapps.rescan')}
        </button>
        <span className="count-note">
          {t('ossapps.summary', { shown: shown.length, total: CATALOG.length })}
        </span>
      </ModuleToolbar>

      {desktop && !loading && !error && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('ossapps.upstreamSummary', { found: foundCount, total: CATALOG.length })}
        </p>
      )}
      {error && <pre className="cmd-out error">{error}</pre>}

      <div className="panel" style={{ marginTop: 10 }}>
        <div className="label" style={{ fontWeight: 600 }}>{t('ossapps.licenseTitle')}</div>
        <p className="count-note" style={{ margin: '4px 0 0' }}>{t('ossapps.licenseBody')}</p>
      </div>

      {shown.length === 0 && <p className="count-note">{t('ossapps.empty')}</p>}

      {shown.map((app) => {
        const det = detected.get(app.alias);
        return (
          <div className="panel" key={app.tag} style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="label" style={{ fontWeight: 600, fontSize: 14 }}>
                  {pick(app.nameEn, app.nameZh, lang)}{' '}
                  <span className="mini">{pick(app.statusEn, app.statusZh, lang)}</span>
                </div>
                <div className="count-note" style={{ margin: '3px 0' }}>
                  {pick(app.descEn, app.descZh, lang)}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.75 }}>
                  {t('ossapps.inspiredBy')}: {app.inspiredBy} · {pick(app.catEn, app.catZh, lang)} ·{' '}
                  --page {app.alias} · {app.tag}
                </div>
                <div className="count-note" style={{ margin: '3px 0 0', fontSize: 12 }}>
                  {pick(app.implEn, app.implZh, lang)}
                </div>
                {desktop && det && (
                  <div style={{ marginTop: 6 }}>
                    <StatusDot
                      ok={det.found}
                      label={
                        det.found
                          ? `${t('ossapps.upstreamFound')}: ${det.detail} — ${det.via === 'registry' ? t('ossapps.viaRegistry') : t('ossapps.viaPath')}`
                          : t('ossapps.upstreamMissing')
                      }
                    />
                  </div>
                )}
              </div>
              <button
                className="mini primary"
                title={t('ossapps.openPaletteTip')}
                onClick={() => findInApp(app)}
              >
                {t('ossapps.openPalette')}
              </button>
            </div>
          </div>
        );
      })}

      <p className="count-note" style={{ marginTop: 10 }}>{t('ossapps.detectNote')}</p>
    </div>
  );
}
