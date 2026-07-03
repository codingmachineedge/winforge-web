import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Mode = 'words' | 'bigrams' | 'characters';

interface FreqRow {
  rank: number;
  term: string;
  count: number;
  barWidth: number; // 0..220 px relative to the top term
  percent: string;
}

interface Result {
  rows: FreqRow[];
  totalTokens: number;
  uniqueTokens: number;
  diversity: number; // unique / total, 0..1
}

const MAX_BAR = 220.0;

// A small, common English stop-word list (matches WinForge WordFreqService).
const STOP_WORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'you', 'your', 'would', 'could', 'should', 'being', 'do', 'does', 'did',
  'just', 'than', 'too', 'very', 'can', 'us', 'am',
]);

// Trim leading/trailing apostrophes and hyphens.
function trimEdges(s: string): string {
  return s.replace(/^['-]+/, '').replace(/['-]+$/, '');
}

// Split into word tokens. When stripping punctuation, keep letters/digits (and
// in-word apostrophes/hyphens); otherwise split on whitespace only.
function tokenize(text: string, stripPunctuation: boolean): string[] {
  if (!stripPunctuation) {
    return text.split(/\s+/).filter((p) => p.length > 0);
  }
  const out: string[] = [];
  let sb = '';
  for (const ch of text) {
    const isLetterOrDigit = /[\p{L}\p{N}]/u.test(ch);
    if (isLetterOrDigit || ch === "'" || ch === '-') {
      sb += ch;
    } else if (sb.length > 0) {
      out.push(trimEdges(sb));
      sb = '';
    }
  }
  if (sb.length > 0) out.push(trimEdges(sb));
  return out;
}

function words(text: string, caseInsensitive: boolean, stripPunctuation: boolean, removeStopWords: boolean, minLength: number): string[] {
  const list: string[] = [];
  for (const raw of tokenize(text, stripPunctuation)) {
    const w = caseInsensitive ? raw.toLowerCase() : raw;
    if (w.length < minLength) continue;
    if (removeStopWords && STOP_WORDS.has(w.toLowerCase())) continue;
    list.push(w);
  }
  return list;
}

function bigrams(text: string, caseInsensitive: boolean, stripPunctuation: boolean, removeStopWords: boolean, minLength: number): string[] {
  const w = words(text, caseInsensitive, stripPunctuation, removeStopWords, minLength);
  const list: string[] = [];
  for (let i = 0; i + 1 < w.length; i++) {
    list.push(w[i]! + ' ' + w[i + 1]!);
  }
  return list;
}

function characters(text: string, caseInsensitive: boolean): string[] {
  const list: string[] = [];
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const s = caseInsensitive ? ch.toLowerCase() : ch;
    list.push(s);
  }
  return list;
}

/** Faithful port of WinForge WordFreqService.Analyze — never throws. */
function analyze(text: string, mode: Mode, caseInsensitive: boolean, minLengthIn: number, stripPunctuation: boolean, removeStopWords: boolean): Result {
  const result: Result = { rows: [], totalTokens: 0, uniqueTokens: 0, diversity: 0 };
  try {
    if (!text || text.trim().length === 0) return result;
    let minLength = minLengthIn;
    if (minLength < 1) minLength = 1;

    let tokens: string[];
    if (mode === 'characters') tokens = characters(text, caseInsensitive);
    else if (mode === 'bigrams') tokens = bigrams(text, caseInsensitive, stripPunctuation, removeStopWords, minLength);
    else tokens = words(text, caseInsensitive, stripPunctuation, removeStopWords, minLength);

    if (tokens.length === 0) return result;

    const counts = new Map<string, number>();
    for (const tk of tokens) {
      counts.set(tk, (counts.get(tk) ?? 0) + 1);
    }

    result.totalTokens = tokens.length;
    result.uniqueTokens = counts.size;
    result.diversity = tokens.length > 0 ? counts.size / tokens.length : 0;

    // Order by count desc, then by term (case-insensitive) asc.
    const ordered = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].toLowerCase().localeCompare(b[0].toLowerCase());
    });

    const first = ordered[0];
    if (!first) return result;
    const max = first[1];
    let rank = 1;
    for (const [term, count] of ordered) {
      const frac = max > 0 ? count / max : 0;
      const pctOfTotal = result.totalTokens > 0 ? (count * 100.0) / result.totalTokens : 0;
      result.rows.push({
        rank: rank++,
        term,
        count,
        barWidth: Math.max(2.0, frac * MAX_BAR),
        percent: pctOfTotal.toFixed(1) + '%',
      });
    }
  } catch {
    // Never throw — return whatever we have.
  }
  return result;
}

function escapeCsv(s: string): string {
  if (!s) return '""';
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Render the ranked table as CSV text. Never throws. */
function toCsv(result: Result): string {
  try {
    let out = 'Rank,Term,Count,Percent\n';
    for (const r of result.rows) {
      out += `${r.rank},${escapeCsv(r.term)},${r.count},${r.percent}\n`;
    }
    return out;
  } catch {
    return '';
  }
}

const DEFAULT_TEXT =
  'The quick brown fox jumps over the lazy dog. The dog was not amused, ' +
  'but the fox was quick and the fox was clever.';

export function WordFreqModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(DEFAULT_TEXT);
  const [mode, setMode] = useState<Mode>('words');
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [minLength, setMinLength] = useState(1);
  const [stripPunctuation, setStripPunctuation] = useState(true);
  const [removeStopWords, setRemoveStopWords] = useState(false);
  const [copied, setCopied] = useState(false);

  const result = useMemo(
    () => analyze(input, mode, caseInsensitive, minLength, stripPunctuation, removeStopWords),
    [input, mode, caseInsensitive, minLength, stripPunctuation, removeStopWords],
  );

  const diversityPct = (result.diversity * 100).toFixed(1);

  const copy = () => {
    const csv = toCsv(result);
    if (!csv) return;
    navigator.clipboard?.writeText(csv);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const nf = (n: number) => n.toLocaleString();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('wordfreq.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('wordfreq.mode')}</label>
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="words">{t('wordfreq.modeWords')}</option>
          <option value="bigrams">{t('wordfreq.modeBigrams')}</option>
          <option value="characters">{t('wordfreq.modeChars')}</option>
        </select>
        <label className="count-note">{t('wordfreq.minLength')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          style={{ maxWidth: 80 }}
          value={minLength}
          onChange={(e) => setMinLength(Math.max(1, Math.floor(+e.target.value) || 1))}
        />
        <button className="mini" disabled={result.rows.length === 0} onClick={copy}>
          {copied ? t('wordfreq.copied') : t('wordfreq.copy')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="chk"><input type="checkbox" checked={caseInsensitive} onChange={(e) => setCaseInsensitive(e.target.checked)} /> {t('wordfreq.caseInsensitive')}</label>
        <label className="chk"><input type="checkbox" checked={stripPunctuation} onChange={(e) => setStripPunctuation(e.target.checked)} /> {t('wordfreq.stripPunct')}</label>
        <label className="chk"><input type="checkbox" checked={removeStopWords} onChange={(e) => setRemoveStopWords(e.target.checked)} /> {t('wordfreq.removeStop')}</label>
      </div>

      <label className="count-note">{t('wordfreq.inputLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('wordfreq.inputPlaceholder')}
        style={{ minHeight: 120 }}
      />

      <p className="count-note" style={{ marginTop: 10 }}>
        {t('wordfreq.totals', {
          total: nf(result.totalTokens),
          unique: nf(result.uniqueTokens),
          diversity: diversityPct,
        })}
      </p>

      {result.rows.length > 0 ? (
        <div className="panel">
          <table className="dt">
            <thead>
              <tr>
                <td>{t('wordfreq.colRank')}</td>
                <td>{t('wordfreq.colTerm')}</td>
                <td>{t('wordfreq.colCount')}</td>
                <td style={{ width: MAX_BAR + 60 }}>{t('wordfreq.colBar')}</td>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 300).map((r) => (
                <tr key={r.rank}>
                  <td>{r.rank}</td>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'pre' }}>{r.term}</td>
                  <td>{r.count}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: r.barWidth, height: 12, background: 'var(--accent, #4f8cff)', borderRadius: 3, flexShrink: 0 }} />
                      <span className="count-note">{r.percent}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > 300 ? (
            <p className="count-note">{t('wordfreq.truncated', { shown: 300, total: nf(result.rows.length) })}</p>
          ) : null}
        </div>
      ) : (
        <p className="count-note">{t('wordfreq.empty')}</p>
      )}
    </div>
  );
}
