// 本地化數字格式 · Locale-aware number formatting for reactor readouts.
//
// The control-room readouts (thermal power, temperatures, pressures, boron ppm, …) must render
// with digit grouping and decimal separators that match the active UI language. This module wraps
// Intl.NumberFormat, keyed to the i18next language code, with a small memo cache so we don't
// reconstruct a formatter on every render/tick.
//
// Language → BCP-47 locale mapping used across the app:
//   'en'                       → 'en-US'
//   'yue' | 'bilingual' | zh*  → 'zh-Hant'  (Traditional Chinese grouping/numerals)

import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';

/** Map an i18next language code to the BCP-47 locale used for number formatting. */
export function localeForLang(lang: string | undefined): string {
  if (!lang) return 'en-US';
  const l = lang.toLowerCase();
  if (l === 'en' || l.startsWith('en-')) return 'en-US';
  // 'yue', 'bilingual', 'zh', 'zh-hant', … all format with Traditional-Chinese conventions.
  return 'zh-Hant';
}

// Memo cache keyed by `${locale}|${digits}` so repeated readouts reuse one formatter instance.
const fmtCache = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let f = fmtCache.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    fmtCache.set(key, f);
  }
  return f;
}

/**
 * Format a number to a fixed number of fractional digits, grouped and decimal-separated for the
 * given i18next language. Non-finite inputs render as an em-dash so a NaN never reaches a gauge.
 *
 * @param n      the value
 * @param digits fixed fractional digits (default 1)
 * @param lang   i18next language code ('en' | 'yue' | 'bilingual' | …)
 */
export function fmtNum(n: number, digits = 1, lang?: string): string {
  if (!Number.isFinite(n)) return '—';
  return formatterFor(localeForLang(lang), digits).format(n);
}

export interface NumberFmt {
  /** The active i18next language code. */
  lang: string;
  /** The resolved BCP-47 locale (e.g. 'en-US' / 'zh-Hant'). */
  locale: string;
  /** Format `n` with `digits` fractional digits in the active locale. */
  fmt: (n: number, digits?: number) => string;
}

/**
 * React hook: a memoized locale-aware number formatter bound to the active i18n language.
 * Re-computes only when the language changes.
 */
export function useNumberFmt(): NumberFmt {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';
  return useMemo<NumberFmt>(() => {
    const locale = localeForLang(lang);
    return {
      lang,
      locale,
      fmt: (n: number, digits = 1) => fmtNum(n, digits, lang),
    };
  }, [lang]);
}
