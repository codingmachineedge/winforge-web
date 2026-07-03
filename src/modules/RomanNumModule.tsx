import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Faithful port of WinForge RomanNumService. Vinculum = U+0305 combining overline (×1000).
const OVERLINE = '̅';
const STD_MAX = 3999;
const EXT_MAX = 3_999_999;
const STD_TABLE: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

const bar = (sym: string) => [...sym].map((c) => c + OVERLINE).join('');

function buildStandard(value: number, breakdown: string[], barred: boolean): string {
  let out = '';
  for (const [v, sym] of STD_TABLE) {
    while (value >= v) {
      value -= v;
      const piece = barred ? bar(sym) : sym;
      out += piece;
      breakdown.push(piece);
    }
  }
  return out;
}

interface RomanResult { ok: boolean; roman?: string; breakdown?: string; reason?: string }

function toRoman(n: number, ext: boolean, t: TFunction): RomanResult {
  const max = ext ? EXT_MAX : STD_MAX;
  if (!Number.isFinite(n) || n < 1 || n > max) {
    return { ok: false, reason: t('romannum.range', { max: max.toLocaleString() }) };
  }
  const parts: string[] = [];
  let roman = '';
  if (ext && n >= 4000) {
    const high = Math.floor(n / 1000);
    const low = n % 1000;
    roman += buildStandard(high, parts, true);
    if (low > 0) roman += buildStandard(low, parts, false);
  } else {
    roman += buildStandard(n, parts, false);
  }
  return { ok: true, roman, breakdown: parts.join(' + ') };
}

function letterVal(c: string): number | null {
  switch (c.toUpperCase()) {
    case 'I': return 1; case 'V': return 5; case 'X': return 10; case 'L': return 50;
    case 'C': return 100; case 'D': return 500; case 'M': return 1000; default: return null;
  }
}

function expandParens(s: string): { out: string; error: boolean } {
  if (!s.includes('(') && !s.includes(')')) return { out: s, error: false };
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '(') {
      const close = s.indexOf(')', i + 1);
      if (close < 0) return { out: s, error: true };
      const inner = s.slice(i + 1, close);
      if (inner.length === 0) return { out: s, error: true };
      out += bar(inner.toUpperCase());
      i = close + 1;
    } else if (c === ')') {
      return { out: s, error: true };
    } else {
      out += c.toUpperCase();
      i++;
    }
  }
  return { out, error: false };
}

interface NumResult { ok: boolean; value?: number; breakdown?: string; reason?: string }

function toNumber(input: string, ext: boolean, t: TFunction): NumResult {
  if (!input.trim()) return { ok: false, reason: t('romannum.typeRoman') };
  const { out: normalized, error } = expandParens(input.trim());
  if (error) return { ok: false, reason: t('romannum.parens') };

  const tokens: number[] = [];
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i]!;
    const barred = i + 1 < normalized.length && normalized[i + 1] === OVERLINE;
    const base = letterVal(c);
    if (base === null) return { ok: false, reason: t('romannum.badChar', { c }) };
    tokens.push(barred ? base * 1000 : base);
    i += barred ? 2 : 1;
  }
  if (tokens.length === 0) return { ok: false, reason: t('romannum.noLetters') };

  let total = 0;
  for (let k = 0; k < tokens.length; k++) {
    if (k + 1 < tokens.length && tokens[k]! < tokens[k + 1]!) total -= tokens[k]!;
    else total += tokens[k]!;
  }
  if (total < 1) return { ok: false, reason: t('romannum.notPositive') };
  const max = ext ? EXT_MAX : STD_MAX;
  if (total > max) return { ok: false, reason: ext ? t('romannum.aboveExt', { max: EXT_MAX.toLocaleString() }) : t('romannum.aboveStd', { max: STD_MAX }) };

  const re = toRoman(total, true, t);
  if (!re.ok || re.roman !== normalized) {
    return { ok: false, reason: t('romannum.malformed', { value: total.toLocaleString(), canon: re.ok ? re.roman : '?' }) };
  }
  return { ok: true, value: total, breakdown: re.breakdown };
}

function parseInt2(s: string): number | null {
  if (!s.trim()) return null;
  const v = s.trim().replace(/,/g, '');
  if (!/^-?\d+$/.test(v)) return null;
  return Number(v);
}

export function RomanNumModule() {
  const { t } = useTranslation();
  const [ext, setExt] = useState(false);
  const [numInput, setNumInput] = useState('2024');
  const [romInput, setRomInput] = useState('MMXXIV');

  const n2r = useMemo(() => {
    if (!numInput.trim()) return null;
    const n = parseInt2(numInput);
    if (n === null) return { ok: false, reason: t('romannum.whole') } as RomanResult;
    return toRoman(n, ext, t);
  }, [numInput, ext, t]);

  const r2n = useMemo(() => {
    if (!romInput.trim()) return null;
    return toNumber(romInput, ext, t);
  }, [romInput, ext, t]);

  const copy = (v?: string) => v && navigator.clipboard?.writeText(v);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="chk"><input type="checkbox" checked={ext} onChange={(e) => setExt(e.target.checked)} /> {t('romannum.extended')}</label>
        <span className="count-note">{t('romannum.extNote')}</span>
      </div>
      <div className="io-grid">
        <div>
          <label className="count-note">{t('romannum.n2r')}</label>
          <input className="hosts-edit" style={{ minHeight: 0, height: 38 }} value={numInput} onChange={(e) => setNumInput(e.target.value)} placeholder="2024" />
          <div className="panel" style={{ marginTop: 8 }}>
            <div style={{ fontSize: 26, fontWeight: 600, wordBreak: 'break-all' }}>{n2r?.ok ? n2r.roman : n2r ? '—' : ''}</div>
            {n2r?.ok && n2r.breakdown && <p className="count-note" style={{ marginTop: 6 }}>{parseInt2(numInput)?.toLocaleString()} = {n2r.breakdown}</p>}
            {n2r && !n2r.ok && <p style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 6 }}>{n2r.reason}</p>}
            {n2r?.ok && <button className="mini" style={{ marginTop: 6 }} onClick={() => copy(n2r.roman)}>{t('romannum.copy')}</button>}
          </div>
        </div>
        <div>
          <label className="count-note">{t('romannum.r2n')}</label>
          <input className="hosts-edit" style={{ minHeight: 0, height: 38 }} value={romInput} onChange={(e) => setRomInput(e.target.value)} placeholder="MMXXIV" />
          <div className="panel" style={{ marginTop: 8 }}>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{r2n?.ok ? r2n.value?.toLocaleString() : r2n ? '—' : ''}</div>
            {r2n?.ok && r2n.breakdown && <p className="count-note" style={{ marginTop: 6 }}>= {r2n.breakdown}</p>}
            {r2n && !r2n.ok && <p style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 6 }}>{r2n.reason}</p>}
            {r2n?.ok && <button className="mini" style={{ marginTop: 6 }} onClick={() => copy(String(r2n.value))}>{t('romannum.copy')}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
