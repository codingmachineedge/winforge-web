import type { Resources } from './en';

// 繁體中文 UI strings. Mirrors the shape of en.ts exactly.
export const zhHant: Resources = {
  app: {
    title: 'WinForge 網頁版',
    subtitle: '模組目錄與反應堆模擬器',
    tagline: 'WinForge 桌面套件嘅網頁重寫版本。',
  },
  nav: {
    search: '搜尋模組…',
    sections: '分類',
    allModules: '所有模組',
    reactor: '核反應堆',
    about: '關於',
    language: '語言',
  },
  catalog: {
    heading: '模組目錄',
    count_one: '{{count}} 個模組',
    count_other: '{{count}} 個模組',
    resultsFor: '「{{query}}」嘅搜尋結果',
    noResults: '搵唔到符合嘅模組。',
    native: '僅限原生',
    web: '網頁移植',
    open: '開啟',
    filterAll: '全部',
    filterWeb: '可上網頁',
    filterNative: '僅限原生',
  },
  detail: {
    back: '返回目錄',
    tag: '頁面標籤',
    keywords: '關鍵字',
    section: '分類',
    group: '群組',
    nativeTitle: '僅限原生模組',
    nativeBody:
      '此模組操作 Windows 系統功能（登錄檔、服務、原生工具、硬件），無法喺瀏覽器運行。喺網頁版本中會顯示為標示清楚嘅佔位介面。請執行 WinForge 桌面應用程式以取得完整功能。',
    webTitle: '可移植至網頁嘅模組',
    webBody:
      '此模組屬純用戶端運算，適合完整移植至網頁。網頁版本計劃提供可運作嘅實作。',
    openReactor: '開啟反應堆模擬器',
  },
  reactor: {
    title: 'PWR 壓水式反應堆模擬器',
    subtitle: '點動力學核心物理，移植自 WinForge 反應堆引擎。',
    comingSoon: '物理引擎移植正喺獨立分支進行中。',
    power: '熱功率',
    reactivity: '反應性',
    fuelTemp: '燃料溫度',
    coolantTemp: '冷卻劑溫度',
    rods: '控制棒',
    scram: '緊急停堆',
    start: '開始',
    pause: '暫停',
    reset: '重設',
  },
  about: {
    title: '關於 WinForge 網頁版',
    body:
      'WinForge 網頁版係 WinForge 嘅 React + TypeScript（Vite）重寫版本。WinForge 係一個 WinUI 3 / .NET 桌面套件，擁有 314 個模組，主打一個基於物理嘅 PWR 壓水式核反應堆模擬器。僅限原生嘅模組會呈現為標示清楚嘅佔位介面。',
    source: '模組數量源自 WinForge 嘅 ModuleRegistry 同 MainWindow 導覽結構。',
  },
  footer: {
    builtWith: 'React · TypeScript · Vite',
  },
};
