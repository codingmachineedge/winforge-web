import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { zhHant } from './zh-Hant';
import { enB, yueB } from './batchB';
import { enShellNav, yueShellNav } from './shellNav';
import { enShellFeedback, yueShellFeedback } from './shellFeedback';
import { enShellTheme, yueShellTheme } from './shellTheme';
import { enShellA11y, yueShellA11y } from './shellA11y';
import { enShellSettings, yueShellSettings } from './shellSettings';
import { enReactorUi, yueReactorUi } from './reactorUi';

// batch-B modules (N–Z) keep their strings in a dedicated file to avoid collisions
// with concurrent edits to en.ts / zh-Hant.ts. Merge them into the base bundles here.
// Shell UI features (favorites/recents, toasts, theme, a11y) do the same, one file
// per feature slice, each under its own shell* namespace.
const enAll = { ...en, ...enB, ...enShellNav, ...enShellFeedback, ...enShellTheme, ...enShellA11y, ...enShellSettings, ...enReactorUi };
const yueAll = { ...zhHant, ...yueB, ...yueShellNav, ...yueShellFeedback, ...yueShellTheme, ...yueShellA11y, ...yueShellSettings, ...yueReactorUi };

// Three language modes:
//   en        — English only
//   yue       — Cantonese (粵語), written in Traditional Chinese (WinForge wording)
//   bilingual — English and Cantonese shown together (auto-merged from en + yue)
export const LANGS = [
  { code: 'en', label: 'EN' },
  { code: 'yue', label: '粵語' },
  { code: 'bilingual', label: 'EN+粵' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const STORAGE_KEY = 'winforge-web.lang';
const PAIR = ' · ';

/** Build the bilingual bundle: every leaf string becomes "English · 粵語". */
type Tree = { [k: string]: string | Tree };
function mergeBilingual(enT: Tree, yueT: Tree): Tree {
  const out: Tree = {};
  for (const k of Object.keys(enT)) {
    const ev = enT[k];
    const yv = yueT?.[k];
    if (typeof ev === 'string') {
      out[k] = typeof yv === 'string' && yv && yv !== ev ? `${ev}${PAIR}${yv}` : ev;
    } else {
      out[k] = mergeBilingual(ev as Tree, (yv as Tree) ?? {});
    }
  }
  return out;
}

const bilingual = mergeBilingual(enAll as unknown as Tree, yueAll as unknown as Tree);

function migrate(code: string | null): LangCode | null {
  if (code === 'en' || code === 'yue' || code === 'bilingual') return code;
  if (code === 'zh-Hant' || code === 'zh') return 'yue'; // migrate old two-mode setting
  return null;
}

function initialLang(): LangCode {
  if (typeof localStorage !== 'undefined') {
    const saved = migrate(localStorage.getItem(STORAGE_KEY));
    if (saved) return saved;
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'yue';
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: enAll },
    yue: { translation: yueAll },
    bilingual: { translation: bilingual as Record<string, unknown> },
  },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLang(code: LangCode): void {
  void i18n.changeLanguage(code);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, code);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code === 'en' ? 'en' : 'zh-HK';
  }
}

/** Pick a bilingual catalog field for the active mode. */
export function pick(enText: string, yueText: string, lang: string): string {
  if (lang === 'yue') return yueText || enText;
  if (lang === 'bilingual') return yueText && yueText !== enText ? `${enText}${PAIR}${yueText}` : enText;
  return enText; // 'en' (and any fallback)
}

/**
 * The secondary line under a title. In single-language modes it shows the *other*
 * language; in bilingual mode the title already carries both, so there is none.
 */
export function sub(enText: string, yueText: string, lang: string): string {
  if (lang === 'bilingual') return '';
  if (lang === 'yue') return enText;
  return yueText;
}

export default i18n;
