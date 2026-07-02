import { useSyncExternalStore } from 'react';

// Three language modes, matching the main app: English, Cantonese (粵語, Traditional),
// and Bilingual (both, auto-paired).
export type Lang = 'en' | 'yue' | 'bilingual';

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'yue', label: '粵語' },
  { code: 'bilingual', label: 'EN+粵' },
];

// [English, 粵語]
type Pair = [string, string];
const S = {
  title: ['WinForge Web Setup', 'WinForge Web 安裝程式'] as Pair,
  tagline: ['The WinForge desktop suite, self-contained.', 'WinForge 桌面套件，自成一體。'] as Pair,
  welcome: ['Welcome', '歡迎'] as Pair,
  ready: ['Ready to install WinForge Web', '準備安裝 WinForge Web'] as Pair,
  oneClick: ['Install', '安裝'] as Pair,
  installing: ['Installing…', '安裝緊…'] as Pair,
  advanced: ['Advanced options', '進階選項'] as Pair,
  location: ['Install location', '安裝位置'] as Pair,
  browse: ['Browse…', '瀏覽…'] as Pair,
  buildFromSource: [
    'Auto-build dependencies from source (leaner)',
    '自動由原始碼編譯相依套件（更精簡）',
  ] as Pair,
  buildHint: [
    'When on, open-source tools are compiled lean from source. When off, the smallest prebuilt package is used.',
    '開啟時，開源工具會由原始碼精簡編譯；關閉時，改用最細的預建套件。',
  ] as Pair,
  elevate: ['Administrator rights will be requested automatically.', '會自動要求系統管理員權限。'] as Pair,
  step_app: ['WinForge Web app', 'WinForge Web 應用程式'] as Pair,
  step_webview2: ['WebView2 runtime', 'WebView2 執行階段'] as Pair,
  step_vcredist: ['Visual C++ runtime', 'Visual C++ 執行階段'] as Pair,
  step_tools: ['Module tools', '模組工具'] as Pair,
  step_shortcut: ['Start menu shortcut', '開始功能表捷徑'] as Pair,
  pending: ['Pending', '等待中'] as Pair,
  working: ['Working…', '進行中…'] as Pair,
  done: ['Done', '完成'] as Pair,
  skipped: ['Not needed', '毋須'] as Pair,
  failed: ['Failed', '失敗'] as Pair,
  success: ['Installation complete', '安裝完成'] as Pair,
  successBody: ['WinForge Web is ready to use.', 'WinForge Web 已可使用。'] as Pair,
  launch: ['Launch WinForge Web', '啟動 WinForge Web'] as Pair,
  close: ['Close', '關閉'] as Pair,
  retry: ['Retry', '重試'] as Pair,
  errorTitle: ['Something went wrong', '發生問題'] as Pair,
  getStarted: ['Get started', '開始'] as Pair,
  via: ['via', '透過'] as Pair,
  builtFromSource: ['built from source', '由原始碼編譯'] as Pair,
} as const;

export type Key = keyof typeof S;

export function tr(key: Key, lang: Lang): string {
  const [en, yue] = S[key];
  if (lang === 'yue') return yue;
  if (lang === 'bilingual') return en === yue ? en : `${en} · ${yue}`;
  return en;
}

// Tiny global store for the language (no context needed for a single-window app).
let current: Lang = (localStorage.getItem('installer.lang') as Lang) || 'bilingual';
const listeners = new Set<() => void>();
export function setLang(l: Lang) {
  current = l;
  localStorage.setItem('installer.lang', l);
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-HK';
  listeners.forEach((fn) => fn());
}
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
