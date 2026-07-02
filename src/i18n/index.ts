import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { zhHant } from './zh-Hant';

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hant', label: '繁體中文' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const STORAGE_KEY = 'winforge-web.lang';

function initialLang(): LangCode {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-Hant') return saved;
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh-Hant';
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-Hant': { translation: zhHant },
  },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLang(code: LangCode): void {
  void i18n.changeLanguage(code);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, code);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code === 'zh-Hant' ? 'zh-Hant' : 'en';
  }
}

/** Pick the correct bilingual field from a catalog entry for the active language. */
export function pick(en: string, zh: string, lang: string): string {
  return lang.startsWith('zh') ? zh || en : en;
}

export default i18n;
