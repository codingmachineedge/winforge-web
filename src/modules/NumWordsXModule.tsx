import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge NumWordsXService (number → words, English + Chinese 大寫).
const MAX_INT_DIGITS = 66;

interface Parsed { negative: boolean; integer: bigint; fraction: string }
function tryParse(raw: string): Parsed | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim().replace(/[,_ ]/g, '');
  if (s.length === 0) return null;
  let i = 0, negative = false;
  if (s[0] === '+') i = 1;
  else if (s[0] === '-') { negative = true; i = 1; }
  let intPart = '', fracPart = '', seenDot = false, anyDigit = false;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '.') { if (seenDot) return null; seenDot = true; }
    else if (c >= '0' && c <= '9') { anyDigit = true; if (seenDot) fracPart += c; else intPart += c; }
    else return null;
  }
  if (!anyDigit) return null;
  let it = intPart.replace(/^0+/, '');
  if (it.length === 0) it = '0';
  if (it.length > MAX_INT_DIGITS) return null;
  return { negative, integer: BigInt(it), fraction: fracPart };
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion',
  'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion'];

function threeDigits(n: number): string {
  let s = '';
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n > 0) s += ' '; }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; if (n % 10 > 0) s += '-' + ONES[n % 10]; }
  else if (n > 0) s += ONES[n];
  return s;
}
function englishCardinal(value: bigint): string {
  if (value < 0n) value = -value;
  if (value === 0n) return 'zero';
  const groups: number[] = [];
  while (value > 0n) { groups.push(Number(value % 1000n)); value /= 1000n; }
  if (groups.length > SCALES.length) return '';
  const parts: string[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (groups[g] === 0) continue;
    let words = threeDigits(groups[g]!);
    if (g > 0) words += ' ' + SCALES[g];
    parts.push(words);
  }
  return parts.join(' ');
}
const ORDINAL_ONES: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};
function englishOrdinal(value: bigint): string {
  if (value < 0n) value = -value;
  const card = englishCardinal(value);
  if (!card) return '';
  const lastSpace = card.lastIndexOf(' ');
  const head = lastSpace < 0 ? '' : card.slice(0, lastSpace + 1);
  const tail = lastSpace < 0 ? card : card.slice(lastSpace + 1);
  const hyphen = tail.lastIndexOf('-');
  const prefix = hyphen < 0 ? '' : tail.slice(0, hyphen + 1);
  const lastWord = hyphen < 0 ? tail : tail.slice(hyphen + 1);
  let ord: string;
  if (ORDINAL_ONES[lastWord]) ord = ORDINAL_ONES[lastWord]!;
  else if (lastWord.endsWith('y')) ord = lastWord.slice(0, -1) + 'ieth';
  else ord = lastWord + 'th';
  return head + prefix + ord;
}
function ordinalNumeric(negative: boolean, value: bigint): string {
  const digits = value.toString();
  const last2 = Number(value % 100n), last1 = Number(value % 10n);
  let suffix = 'th';
  if (last2 < 11 || last2 > 13) suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[last1] ?? 'th';
  return (negative && value !== 0n ? '-' : '') + digits + suffix;
}
function twoDigitMinor(fraction: string): number {
  if (!fraction) return 0;
  let whole = 0;
  if (fraction.length >= 1) whole = (fraction.charCodeAt(0) - 48) * 10;
  if (fraction.length >= 2) whole += fraction.charCodeAt(1) - 48;
  if (fraction.length >= 3 && fraction[2]! >= '5') whole += 1;
  if (whole > 99) whole = 99;
  return whole;
}
interface CurrencySpec { major: string; majorPlural: string; minor: string; minorPlural: string }
const CURRENCIES: Record<string, CurrencySpec> = {
  USD: { major: 'dollar', majorPlural: 'dollars', minor: 'cent', minorPlural: 'cents' },
  HKD: { major: 'dollar', majorPlural: 'dollars', minor: 'cent', minorPlural: 'cents' },
  GBP: { major: 'pound', majorPlural: 'pounds', minor: 'penny', minorPlural: 'pence' },
};
function englishCurrency(negative: boolean, integer: bigint, fraction: string, spec: CurrencySpec): string {
  const cents = twoDigitMinor(fraction);
  let s = '';
  if (negative && !(integer === 0n && cents === 0)) s += 'negative ';
  s += englishCardinal(integer) + ' ' + (integer === 1n ? spec.major : spec.majorPlural);
  s += ' and ' + englishCardinal(BigInt(cents)) + ' ' + (cents === 1 ? spec.minor : spec.minorPlural);
  return s;
}

// ---- Chinese ----
const CN_LOWER = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UPPER = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖'];
const CN_LOWER_UNIT = ['', '十', '百', '千'];
const CN_UPPER_UNIT = ['', '拾', '佰', '仟'];
const CN_SECTION = ['', '萬', '億', '兆'];

function fourDigitsChinese(n: number, upper: boolean): string {
  const digits = upper ? CN_UPPER : CN_LOWER;
  const units = upper ? CN_UPPER_UNIT : CN_LOWER_UNIT;
  let s = '', zeroPending = false, any = false;
  for (let pos = 3; pos >= 0; pos--) {
    const place = Math.pow(10, pos);
    const d = Math.floor(n / place) % 10;
    if (d === 0) { if (any) zeroPending = true; }
    else {
      if (zeroPending) { s += digits[0]; zeroPending = false; }
      s += digits[d];
      if (units[pos] !== '') s += units[pos];
      any = true;
    }
  }
  return s;
}
function chinese(value: bigint, upper: boolean): string {
  if (value < 0n) value = -value;
  const digits = upper ? CN_UPPER : CN_LOWER;
  if (value === 0n) return digits[0]!;
  const sections: number[] = [];
  while (value > 0n) { sections.push(Number(value % 10000n)); value /= 10000n; }
  if (sections.length > CN_SECTION.length) return '';
  let s = '', higherHadValue = false;
  for (let sec = sections.length - 1; sec >= 0; sec--) {
    const secVal = sections[sec]!;
    if (secVal === 0) continue;
    if (higherHadValue && secVal < 1000) s += digits[0];
    s += fourDigitsChinese(secVal, upper) + CN_SECTION[sec];
    higherHadValue = true;
  }
  if (!upper && s.startsWith('一十')) s = s.slice(1);
  return s;
}
function chineseCurrencyUpper(negative: boolean, integer: bigint, fraction: string): string {
  let jiao = 0, fen = 0;
  if (fraction.length >= 1) jiao = fraction.charCodeAt(0) - 48;
  if (fraction.length >= 2) fen = fraction.charCodeAt(1) - 48;
  if (fraction.length >= 3 && fraction[2]! >= '5') {
    fen++;
    if (fen > 9) { fen = 0; jiao++; if (jiao > 9) { jiao = 0; integer += 1n; } }
  }
  let s = '';
  if (negative && !(integer === 0n && jiao === 0 && fen === 0)) s += '負';
  const yuan = chinese(integer, true);
  if (!yuan) return '';
  s += yuan + '圓';
  if (jiao === 0 && fen === 0) return s + '整';
  if (jiao > 0) s += CN_UPPER[jiao] + '角';
  else if (fen > 0 && integer !== 0n) s += '零';
  if (fen > 0) s += CN_UPPER[fen] + '分';
  return s;
}

export function NumWordsXModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('12345.67');
  const [currency, setCurrency] = useState('USD');
  const parsed = useMemo(() => tryParse(input), [input]);

  const rows = useMemo(() => {
    if (!parsed) return null;
    const { negative, integer, fraction } = parsed;
    const spec = CURRENCIES[currency]!;
    return {
      cardinal: (negative && integer !== 0n ? 'negative ' : '') + englishCardinal(integer),
      ordinalWords: (negative && integer !== 0n ? 'negative ' : '') + englishOrdinal(integer),
      ordinalNumeric: ordinalNumeric(negative, integer),
      currency: englishCurrency(negative, integer, fraction, spec),
      chineseLower: (negative && integer !== 0n ? '負' : '') + chinese(integer, false),
      chineseUpper: (negative && integer !== 0n ? '負' : '') + chinese(integer, true),
      chineseCurrency: chineseCurrencyUpper(negative, integer, fraction),
    };
  }, [parsed, currency]);

  const copy = (v: string) => navigator.clipboard?.writeText(v);
  const Row = ({ label, val }: { label: string; val: string }) => (
    <tr><td style={{ width: 190 }}>{label}</td><td>{val || '—'}</td>
      <td style={{ width: 50, textAlign: 'right' }}>{val && <button className="mini" onClick={() => copy(val)}>{t('numwords.copy')}</button>}</td></tr>
  );

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('numwords.value')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 220 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="12345.67" />
        <label className="count-note">{t('numwords.currency')}</label>
        <select className="mod-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="USD">USD ($)</option><option value="HKD">HKD (HK$)</option><option value="GBP">GBP (£)</option>
        </select>
      </div>
      {rows ? (
        <div className="panel">
          <table className="dt"><tbody>
            <Row label={t('numwords.cardinal')} val={rows.cardinal} />
            <Row label={t('numwords.ordinalWords')} val={rows.ordinalWords} />
            <Row label={t('numwords.ordinalNumeric')} val={rows.ordinalNumeric} />
            <Row label={t('numwords.currencyWords')} val={rows.currency} />
            <Row label={t('numwords.chineseLower')} val={rows.chineseLower} />
            <Row label={t('numwords.chineseUpper')} val={rows.chineseUpper} />
            <Row label={t('numwords.chineseCurrency')} val={rows.chineseCurrency} />
          </tbody></table>
        </div>
      ) : (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('numwords.badNumber')}</p>
      )}
    </div>
  );
}
