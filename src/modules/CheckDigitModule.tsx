import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Scheme = 'luhn' | 'isbn10' | 'isbn13' | 'ean13' | 'upca' | 'iban';

type Result =
  | { ok: false; en: string; zh: string }
  | { ok: true; valid: boolean; en: string; zh: string; computed: string };

const SCHEMES: Scheme[] = ['luhn', 'isbn10', 'isbn13', 'ean13', 'upca', 'iban'];

function cleanDigits(s: string): string {
  return (s ?? '').replace(/ /g, '').replace(/-/g, '').trim();
}

function fail(en: string, zh: string): Result {
  return { ok: false, en, zh };
}

// ---- Luhn / credit cards ---------------------------------------------------
function luhnCheckDigit(body: string): number {
  let sum = 0;
  let dbl = true; // body's last digit sits where the check digit's neighbour doubles
  for (let i = body.length - 1; i >= 0; i--) {
    let n = body.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10;
}

function detectBrand(d: string): string {
  const len = d.length;
  if (d.startsWith('4') && (len === 13 || len === 16 || len === 19)) return 'Visa';
  if (len === 15 && (d.startsWith('34') || d.startsWith('37'))) return 'Amex';
  if (len === 16) {
    const p2 = parseInt(d.slice(0, 2), 10);
    const p4 = parseInt(d.slice(0, 4), 10);
    if (p2 >= 51 && p2 <= 55) return 'Mastercard';
    if (p4 >= 2221 && p4 <= 2720) return 'Mastercard';
    if (d.startsWith('6011') || d.startsWith('65')) return 'Discover';
    const p3 = parseInt(d.slice(0, 3), 10);
    if (p3 >= 644 && p3 <= 649) return 'Discover';
  }
  return '';
}

function luhn(input: string): Result {
  const d = cleanDigits(input);
  if (d.length === 0) return fail('Enter a card / number.', '請輸入卡號或數字。');
  for (const c of d) if (c < '0' || c > '9') return fail('Digits only for Luhn.', 'Luhn 只接受數字。');
  if (d.length < 2) return fail('Too short.', '太短。');

  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  const valid = sum % 10 === 0;

  const check = luhnCheckDigit(d.slice(0, d.length - 1));
  const brand = detectBrand(d);
  const brandEn = brand.length > 0 ? ` · brand: ${brand}` : '';
  const brandZh = brand.length > 0 ? ` · 卡種：${brand}` : '';
  return {
    ok: true,
    valid,
    computed: String(check),
    en: `Expected last digit: ${check}${brandEn}`,
    zh: `應有嘅尾數：${check}${brandZh}`,
  };
}

// ---- ISBN-10 ---------------------------------------------------------------
function weighted10(first9: string): number {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (first9.charCodeAt(i) - 48) * (10 - i);
  return sum;
}

function isbn10(input: string): Result {
  const d = cleanDigits(input).toUpperCase();
  if (d.length === 0) return fail('Enter an ISBN-10.', '請輸入 ISBN-10。');
  if (d.length !== 10) return fail('ISBN-10 needs 10 characters.', 'ISBN-10 要 10 個字元。');
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = d[i]!;
    let v: number;
    if (c === 'X' && i === 9) v = 10;
    else if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
    else return fail('Only digits, plus X as the last check.', '只可用數字，尾位可用 X。');
    sum += v * (10 - i);
  }
  const valid = sum % 11 === 0;
  const chk = (11 - (weighted10(d.slice(0, 9)) % 11)) % 11;
  const chkStr = chk === 10 ? 'X' : String(chk);
  return { ok: true, valid, computed: chkStr, en: `Expected check: ${chkStr}`, zh: `應有檢查碼：${chkStr}` };
}

// ---- EAN-13 / UPC-A / ISBN-13 (GS1 mod-10) ---------------------------------
function mod10Weighted(body: string, oddWeight3FromLeft: boolean): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = body.charCodeAt(i) - 48;
    const weight3 = oddWeight3FromLeft ? i % 2 === 0 : i % 2 === 1;
    sum += n * (weight3 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function ean13Core(input: string, isbn: boolean): Result {
  const label = isbn ? 'ISBN-13' : 'EAN-13';
  const d = cleanDigits(input);
  if (d.length === 0) return fail(`Enter an ${label}.`, `請輸入 ${label}。`);
  for (const c of d) if (c < '0' || c > '9') return fail('Digits only.', '只可用數字。');
  if (d.length !== 13) return fail(`${label} needs 13 digits.`, `${label} 要 13 個數字。`);
  const chk = mod10Weighted(d.slice(0, 12), false);
  const valid = d.charCodeAt(12) - 48 === chk;
  return { ok: true, valid, computed: String(chk), en: `Expected check digit: ${chk}`, zh: `應有檢查碼：${chk}` };
}

function upca(input: string): Result {
  const d = cleanDigits(input);
  if (d.length === 0) return fail('Enter a UPC-A.', '請輸入 UPC-A。');
  for (const c of d) if (c < '0' || c > '9') return fail('Digits only.', '只可用數字。');
  if (d.length !== 12) return fail('UPC-A needs 12 digits.', 'UPC-A 要 12 個數字。');
  const chk = mod10Weighted(d.slice(0, 11), true);
  const valid = d.charCodeAt(11) - 48 === chk;
  return { ok: true, valid, computed: String(chk), en: `Expected check digit: ${chk}`, zh: `應有檢查碼：${chk}` };
}

// ---- IBAN (mod-97, BigInt) -------------------------------------------------
function lettersToDigits(s: string): string | null {
  let out = '';
  for (const c of s) {
    if (c >= '0' && c <= '9') out += c;
    else if (c >= 'A' && c <= 'Z') out += String(c.charCodeAt(0) - 65 + 10);
    else return null;
  }
  return out;
}

function computeIbanCheck(raw: string): string {
  try {
    const country = raw.slice(0, 2);
    const bban = raw.slice(4);
    const rearranged = bban + country + '00';
    const digits = lettersToDigits(rearranged);
    if (digits === null) return '??';
    const mod = Number(BigInt(digits) % 97n);
    const chk = 98 - mod;
    return chk.toString().padStart(2, '0');
  } catch {
    return '??';
  }
}

function iban(input: string): Result {
  const raw = (input ?? '').replace(/ /g, '').replace(/-/g, '').trim().toUpperCase();
  if (raw.length === 0) return fail('Enter an IBAN.', '請輸入 IBAN。');
  if (raw.length < 5 || raw.length > 34) return fail('IBAN length must be 5–34.', 'IBAN 長度要 5–34。');
  for (const c of raw)
    if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')))
      return fail('IBAN uses letters & digits only.', 'IBAN 只可用字母同數字。');
  const c0 = raw[0]!;
  const c1 = raw[1]!;
  if (!(c0 >= 'A' && c0 <= 'Z') || !(c1 >= 'A' && c1 <= 'Z'))
    return fail('IBAN must start with a 2-letter country.', 'IBAN 開頭要兩個國家字母。');

  const rearranged = raw.slice(4) + raw.slice(0, 4);
  const digits = lettersToDigits(rearranged);
  if (digits === null) return fail('Could not parse IBAN.', '無法解析 IBAN。');
  let mod: number;
  try {
    mod = Number(BigInt(digits) % 97n);
  } catch {
    return fail('Could not parse IBAN.', '無法解析 IBAN。');
  }
  const valid = mod === 1;
  const computed = computeIbanCheck(raw);
  return {
    ok: true,
    valid,
    computed,
    en: `mod-97 = ${mod} (valid = 1) · correct check digits: ${computed}`,
    zh: `mod-97 = ${mod}（正確係 1）· 正確檢查碼：${computed}`,
  };
}

function validate(scheme: Scheme, input: string): Result {
  try {
    switch (scheme) {
      case 'luhn':
        return luhn(input);
      case 'isbn10':
        return isbn10(input);
      case 'isbn13':
        return ean13Core(input, true);
      case 'ean13':
        return ean13Core(input, false);
      case 'upca':
        return upca(input);
      case 'iban':
        return iban(input);
      default:
        return fail('Unknown scheme.', '未知格式。');
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return fail('Could not validate: ' + m, '無法驗證：' + m);
  }
}

export function CheckDigitModule() {
  const { t, i18n } = useTranslation();
  const [scheme, setScheme] = useState<Scheme>('luhn');
  const [input, setInput] = useState('');

  const zh = i18n.language.startsWith('zh');
  const pick = (en: string, tw: string): string => (zh ? tw : en);

  const result = useMemo<Result | null>(() => {
    if (input.trim().length === 0) return null;
    return validate(scheme, input);
  }, [scheme, input]);

  let badge: 'valid' | 'invalid' | null = null;
  let detail = '';
  let status = t('checkdigit.emptyHint');
  if (result) {
    if (!result.ok) {
      detail = '';
      status = pick(result.en, result.zh);
    } else {
      badge = result.valid ? 'valid' : 'invalid';
      detail = pick(result.en, result.zh);
      status = result.valid ? t('checkdigit.matches') : t('checkdigit.noMatch');
    }
  }

  const badgeText = badge === 'valid' ? t('checkdigit.valid') : badge === 'invalid' ? t('checkdigit.invalid') : '—';
  const badgeBg =
    badge === 'valid' ? '#1E7A34' : badge === 'invalid' ? '#9B2226' : 'var(--card-stroke, rgba(128,128,128,0.35))';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 14 }}>
        {t('checkdigit.blurb')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontWeight: 600 }}>{t('checkdigit.scheme')}</label>
          <select
            className="mod-select"
            style={{ minWidth: 220, maxWidth: 260 }}
            value={scheme}
            onChange={(e) => setScheme(e.target.value as Scheme)}
          >
            {SCHEMES.map((s) => (
              <option key={s} value={s}>
                {t(`checkdigit.scheme_${s}`)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontWeight: 600 }}>{t('checkdigit.valueLabel')}</label>
          <input
            className="mod-search"
            style={{ maxWidth: 360 }}
            value={input}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('checkdigit.placeholder')}
          />
        </div>

        <div>
          <span
            style={{
              display: 'inline-block',
              borderRadius: 4,
              padding: '4px 10px',
              fontWeight: 600,
              color: badge ? '#fff' : 'inherit',
              background: badgeBg,
            }}
          >
            {badgeText}
          </span>
        </div>

        {detail && (
          <p className="count-note" style={{ margin: 0 }}>
            {detail}
          </p>
        )}
        <p className="count-note" style={{ margin: 0, fontSize: 12 }}>
          {status}
        </p>
      </div>
    </div>
  );
}
