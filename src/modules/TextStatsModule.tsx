import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TextStatsService.
const READ_WPM = 200;
const SPEAK_WPM = 130;
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you',
  'he', 'she', 'they', 'we', 'me', 'him', 'her', 'them', 'us', 'my', 'your', 'his', 'their', 'our', 'not',
  'no', 'do', 'does', 'did', 'so', 'than', 'then', 'too', 'very', 'can', 'will', 'just', 'from', 'up', 'out',
  'about', 'into', 'over', 'after', 'under', 'again', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
]);

const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xf900 && cp <= 0xfaff);

function tokenize(text: string): string[] {
  const list: string[] = [];
  let sb = '';
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (isCjk(cp)) {
      if (sb) { list.push(sb); sb = ''; }
      list.push(c);
    } else if (/[\p{L}\p{N}]/u.test(c) || c === "'" || c === '’') {
      sb += c;
    } else if (sb) { list.push(sb); sb = ''; }
  }
  if (sb) list.push(sb);
  return list;
}

function countSentences(text: string): number {
  let count = 0, inRun = false;
  for (const c of text) {
    const term = c === '.' || c === '!' || c === '?' || c === '。' || c === '！' || c === '？';
    if (term) { if (!inRun) { count++; inRun = true; } }
    else if (!/\s/.test(c)) inRun = false;
  }
  return count;
}

function countParagraphs(text: string): number {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n').filter((b) => b.trim().length > 0).length;
}

function syllablesIn(word: string): number {
  if (!word) return 0;
  if ([...word].length === 1 && isCjk(word.codePointAt(0)!)) return 1;
  let w = '';
  for (const c of word.toLowerCase()) if (c >= 'a' && c <= 'z') w += c;
  if (w.length === 0) return 1;
  let count = 0, prevVowel = false;
  for (const ch of w) {
    const vowel = 'aeiouy'.includes(ch);
    if (vowel && !prevVowel) count++;
    prevVowel = vowel;
  }
  if (w.endsWith('e') && count > 1) count--;
  return Math.max(1, count);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0s';
  let totalSec = Math.round(minutes * 60);
  if (totalSec < 1) totalSec = 1;
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

interface Stats {
  chars: number; charsNoSpace: number; words: number; unique: number; sentences: number;
  paragraphs: number; avgWord: number; avgSentence: number; readMin: number; speakMin: number;
  ease: number; grade: number; top: { word: string; count: number }[];
}

function analyze(text: string, ignoreStop: boolean, topN = 10): Stats {
  const s: Stats = { chars: text.length, charsNoSpace: 0, words: 0, unique: 0, sentences: 0, paragraphs: 0, avgWord: 0, avgSentence: 0, readMin: 0, speakMin: 0, ease: 0, grade: 0, top: [] };
  for (const c of text) if (!/\s/.test(c)) s.charsNoSpace++;
  const words = tokenize(text);
  s.words = words.length;
  s.sentences = countSentences(text);
  if (s.sentences === 0 && s.words > 0) s.sentences = 1;
  s.paragraphs = countParagraphs(text);
  let totalWordChars = 0, totalSyll = 0;
  const freq = new Map<string, number>();
  const uniq = new Set<string>();
  for (const w of words) {
    totalWordChars += w.length;
    totalSyll += syllablesIn(w);
    uniq.add(w.toLowerCase());
    if (ignoreStop && STOP.has(w.toLowerCase())) continue;
    const key = w.toLowerCase();
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  s.unique = uniq.size;
  s.avgWord = s.words > 0 ? totalWordChars / s.words : 0;
  s.avgSentence = s.sentences > 0 ? s.words / s.sentences : 0;
  s.readMin = s.words / READ_WPM;
  s.speakMin = s.words / SPEAK_WPM;
  if (s.words > 0 && s.sentences > 0) {
    const wps = s.words / s.sentences;
    const spw = totalSyll / s.words;
    s.ease = Math.round(clamp(206.835 - 1.015 * wps - 84.6 * spw, -100, 121) * 10) / 10;
    s.grade = Math.round(Math.max(0, 0.39 * wps + 11.8 * spw - 15.59) * 10) / 10;
  }
  s.top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
  return s;
}

export function TextStatsModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [ignoreStop, setIgnoreStop] = useState(false);
  const s = useMemo(() => analyze(input, ignoreStop), [input, ignoreStop]);

  const easeHint = (): string => {
    if (s.words <= 0) return '';
    const e = s.ease;
    if (e >= 90) return t('textstats.ease90');
    if (e >= 70) return t('textstats.ease70');
    if (e >= 60) return t('textstats.ease60');
    if (e >= 50) return t('textstats.ease50');
    if (e >= 30) return t('textstats.ease30');
    return t('textstats.ease0');
  };

  const n = (v: number) => v.toLocaleString();
  const f1 = (v: number) => v.toFixed(1);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="chk"><input type="checkbox" checked={ignoreStop} onChange={(e) => setIgnoreStop(e.target.checked)} /> {t('textstats.ignoreStop')}</label>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('textstats.placeholder')} style={{ minHeight: 320 }} />
        <div className="panel" style={{ margin: 0, overflow: 'auto' }}>
          <div className="kv-list">
            <div className="kv-row"><span className="label">{t('textstats.chars')}</span><span className="value">{n(s.chars)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.charsNoSpace')}</span><span className="value">{n(s.charsNoSpace)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.words')}</span><span className="value">{n(s.words)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.unique')}</span><span className="value">{n(s.unique)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.sentences')}</span><span className="value">{n(s.sentences)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.paragraphs')}</span><span className="value">{n(s.paragraphs)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.avgWord')}</span><span className="value">{f1(s.avgWord)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.avgSentence')}</span><span className="value">{f1(s.avgSentence)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.reading')}</span><span className="value">{formatDuration(s.readMin)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.speaking')}</span><span className="value">{formatDuration(s.speakMin)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.flesch')}</span><span className="value">{f1(s.ease)}</span></div>
            <div className="kv-row"><span className="label">{t('textstats.grade')}</span><span className="value">{f1(s.grade)}</span></div>
          </div>
          {easeHint() && <p className="count-note" style={{ marginTop: 8 }}>{easeHint()}</p>}
          <h4 style={{ margin: '14px 0 6px' }}>{t('textstats.topWords')}</h4>
          {s.top.length === 0 ? (
            <p className="count-note">{t('textstats.noWords')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <tbody>
                  {s.top.map((w) => (
                    <tr key={w.word}><td>{w.word}</td><td style={{ textAlign: 'right' }}>{w.count}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
