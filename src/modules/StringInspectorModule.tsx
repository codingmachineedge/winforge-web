import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge StringInspectorService (text analysis + transforms).
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

function countCodePoints(s: string): number { return [...s].length; }
function countGraphemes(s: string): number {
  try {
    // @ts-expect-error Intl.Segmenter may be untyped in older lib versions
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(s)) n++;
    return n;
  } catch { return s.length; }
}
function countWords(s: string): number {
  let n = 0, inWord = false;
  for (const c of s) {
    if (/\s/.test(c)) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n++;
    else if (s[i] === '\r') { n++; if (s[i + 1] === '\n') i++; }
  }
  return n;
}

interface Stats { chars: number; utf8: number; utf16: number; utf32: number; codePoints: number; graphemes: number; words: number; lines: number }
function analyze(s: string): Stats {
  const cp = countCodePoints(s);
  return {
    chars: s.length, utf8: utf8Bytes(s), utf16: s.length * 2, utf32: cp * 4,
    codePoints: cp, graphemes: countGraphemes(s), words: countWords(s), lines: countLines(s),
  };
}

function describe(cp: number): string {
  if (cp === 10) return '\\n';
  if (cp === 13) return '\\r';
  if (cp === 9) return '\\t';
  if (cp === 32) return '␠';
  if (cp < 0x20 || cp === 0x7f) return '⟨ctrl⟩';
  try { return String.fromCodePoint(cp); } catch { return '?'; }
}
function categoryOf(c: string): string {
  // Approximate the .NET UnicodeCategory names using JS regex property escapes.
  const tests: [RegExp, string][] = [
    [/\p{Lu}/u, 'UppercaseLetter'], [/\p{Ll}/u, 'LowercaseLetter'], [/\p{Lt}/u, 'TitlecaseLetter'],
    [/\p{Lm}/u, 'ModifierLetter'], [/\p{Lo}/u, 'OtherLetter'], [/\p{Nd}/u, 'DecimalDigitNumber'],
    [/\p{Nl}/u, 'LetterNumber'], [/\p{No}/u, 'OtherNumber'], [/\p{Mn}/u, 'NonSpacingMark'],
    [/\p{Mc}/u, 'SpacingCombiningMark'], [/\p{Pc}/u, 'ConnectorPunctuation'], [/\p{Pd}/u, 'DashPunctuation'],
    [/\p{Ps}/u, 'OpenPunctuation'], [/\p{Pe}/u, 'ClosePunctuation'], [/\p{Po}/u, 'OtherPunctuation'],
    [/\p{Sm}/u, 'MathSymbol'], [/\p{Sc}/u, 'CurrencySymbol'], [/\p{Sk}/u, 'ModifierSymbol'],
    [/\p{So}/u, 'OtherSymbol'], [/\p{Zs}/u, 'SpaceSeparator'], [/\p{Cc}/u, 'Control'], [/\p{Cf}/u, 'Format'],
  ];
  for (const [re, name] of tests) if (re.test(c)) return name;
  return 'OtherNotAssigned';
}

interface Row { codePoint: string; display: string; category: string }
function codePointRows(s: string, max = 512): Row[] {
  const rows: Row[] = [];
  for (const ch of s) {
    if (rows.length >= max) break;
    const cp = ch.codePointAt(0)!;
    rows.push({
      codePoint: 'U+' + cp.toString(16).toUpperCase().padStart(cp > 0xffff ? 6 : 4, '0'),
      display: describe(cp), category: categoryOf(ch),
    });
  }
  return rows;
}

function reverse(s: string): string {
  try {
    // @ts-expect-error Segmenter typing
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...seg.segment(s)].map((x: { segment: string }) => x.segment).reverse().join('');
  } catch { return [...s].reverse().join(''); }
}
const stripDiacritics = (s: string) => s.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC');
const removeNonAscii = (s: string) => [...s].filter((c) => c.charCodeAt(0) <= 0x7f).join('');

export function StringInspectorModule() {
  const { t } = useTranslation();
  const [text, setText] = useState('Café — 你好 👋\r\nSecond line');
  const s = useMemo(() => analyze(text), [text]);
  const rows = useMemo(() => codePointRows(text), [text]);

  const apply = (fn: (v: string) => string) => setText(fn(text));

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => apply(reverse)}>{t('strinspect.reverse')}</button>
        <button className="mini" onClick={() => apply((v) => v.normalize('NFC'))}>NFC</button>
        <button className="mini" onClick={() => apply((v) => v.normalize('NFD'))}>NFD</button>
        <button className="mini" onClick={() => apply((v) => v.normalize('NFKC'))}>NFKC</button>
        <button className="mini" onClick={() => apply((v) => v.normalize('NFKD'))}>NFKD</button>
        <button className="mini" onClick={() => apply(stripDiacritics)}>{t('strinspect.stripDiacritics')}</button>
        <button className="mini" onClick={() => apply(removeNonAscii)}>{t('strinspect.removeNonAscii')}</button>
      </div>
      <textarea className="hosts-edit" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('strinspect.placeholder')} style={{ minHeight: 120 }} />
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="kv-list" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 24px' }}>
          <div className="kv-row"><span className="label">{t('strinspect.chars')}</span><span className="value">{s.chars}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.codePoints')}</span><span className="value">{s.codePoints}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.graphemes')}</span><span className="value">{s.graphemes}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.words')}</span><span className="value">{s.words}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.lines')}</span><span className="value">{s.lines}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.utf8')}</span><span className="value">{s.utf8}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.utf16')}</span><span className="value">{s.utf16}</span></div>
          <div className="kv-row"><span className="label">{t('strinspect.utf32')}</span><span className="value">{s.utf32}</span></div>
        </div>
      </div>
      <div className="dt-wrap" style={{ marginTop: 10, maxHeight: 260, overflow: 'auto' }}>
        <table className="dt">
          <thead><tr><th>{t('strinspect.codePoint')}</th><th>{t('strinspect.char')}</th><th>{t('strinspect.category')}</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td style={{ fontFamily: 'monospace' }}>{r.codePoint}</td><td>{r.display}</td><td>{r.category}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
