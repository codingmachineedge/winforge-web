import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- faithful port of WinForge Services/SqlFormatService.cs ----
type Kind = 'word' | 'punct' | 'str' | 'comment' | 'number';
interface Tok { kind: Kind; text: string }

const MAJOR = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'INTO', 'ON']);
const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'INTO', 'ON', 'AS', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'INDEX', 'VIEW', 'WITH', 'USING', 'TRUE', 'FALSE', 'INT', 'INTEGER', 'VARCHAR', 'TEXT', 'DATE', 'DATETIME', 'BOOLEAN']);

const isLetter = (c: string) => /\p{L}/u.test(c);
const isLetterOrDigit = (c: string) => /[\p{L}\p{N}]/u.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

function tokenize(s: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { const start = i; while (i < n && s[i] !== '\n') i++; tokens.push({ kind: 'comment', text: s.slice(start, i).replace(/\s+$/, '') }); continue; }
    if (c === '/' && s[i + 1] === '*') { const start = i; i += 2; while (i + 1 < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i = Math.min(n, i + 2); tokens.push({ kind: 'comment', text: s.slice(start, i) }); continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; const start = i; i++;
      while (i < n) { if (s[i] === q) { if (s[i + 1] === q) { i += 2; continue; } i++; break; } i++; }
      tokens.push({ kind: 'str', text: s.slice(start, i) }); continue;
    }
    if (c === '[') { const start = i; i++; while (i < n && s[i] !== ']') i++; if (i < n) i++; tokens.push({ kind: 'str', text: s.slice(start, i) }); continue; }
    if (isDigit(c)) { const start = i; while (i < n && (isDigit(s[i]!) || s[i] === '.')) i++; tokens.push({ kind: 'number', text: s.slice(start, i) }); continue; }
    if (isLetter(c) || c === '_' || c === '@' || c === '#' || c === '$') {
      const start = i;
      while (i < n && (isLetterOrDigit(s[i]!) || s[i] === '_' || s[i] === '@' || s[i] === '#' || s[i] === '$')) i++;
      tokens.push({ kind: 'word', text: s.slice(start, i) }); continue;
    }
    if (i + 1 < n) { const two = s.slice(i, i + 2); if (['<=', '>=', '<>', '!=', '||', '::'].includes(two)) { tokens.push({ kind: 'punct', text: two }); i += 2; continue; } }
    tokens.push({ kind: 'punct', text: c }); i++;
  }
  return tokens;
}

function continuesPrevClause(tokens: Tok[], i: number): boolean {
  if (i === 0) return false;
  const prev = tokens[i - 1]!.text.toUpperCase();
  const cur = tokens[i]!.text.toUpperCase();
  if (cur === 'JOIN' && ['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS'].includes(prev)) return true;
  if (cur === 'OUTER' && ['LEFT', 'RIGHT', 'FULL'].includes(prev)) return true;
  return false;
}

const endsWithSelectHeader = (sb: string) => {
  let end = sb.length, start = end;
  while (start > 0 && isLetter(sb[start - 1]!)) start--;
  return end - start === 6 && sb.slice(start, end).toUpperCase() === 'SELECT';
};

function formatSql(sql: string, upperKeywords: boolean, indentSize: number): string {
  if (!sql.trim()) return '';
  indentSize = Math.max(0, Math.min(16, indentSize));
  const tokens = tokenize(sql);
  const indent = ' '.repeat(indentSize);
  let sb = '';
  let inSelect = false;
  let atLineStart = true;
  let prevWasOpenParen = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let text = t.text;
    if (t.kind === 'word' && upperKeywords && KEYWORDS.has(text.toUpperCase())) text = text.toUpperCase();
    const isMajor = t.kind === 'word' && MAJOR.has(t.text.toUpperCase());
    const upper = t.text.toUpperCase();

    if (isMajor) {
      if (upper === 'SELECT') inSelect = true;
      else if (['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'INTO'].includes(upper)) inSelect = false;
      const continuation = continuesPrevClause(tokens, i);
      if (!atLineStart && !continuation) sb += '\n';
      if (continuation && !atLineStart) sb += ' ';
      sb += text;
      atLineStart = false;
      prevWasOpenParen = false;
      continue;
    }
    if (t.kind === 'comment') {
      if (!atLineStart) sb += '\n';
      sb += text + '\n';
      atLineStart = true;
      prevWasOpenParen = false;
      continue;
    }
    if (t.kind === 'punct' && text === ',' && inSelect) {
      sb = sb.replace(/ +$/, '');
      sb += ',\n' + indent;
      atLineStart = false;
      prevWasOpenParen = false;
      continue;
    }
    if (atLineStart && inSelect && sb.length >= 1 && sb[sb.length - 1] === '\n') sb += indent;
    if (sb.length > 0 && !atLineStart) {
      const last = sb[sb.length - 1]!;
      const noSpaceBefore = t.kind === 'punct' && [',', ')', ';', '.', '::'].includes(text);
      const afterOpen = prevWasOpenParen || last === '(' || last === '.';
      if (last !== '\n' && last !== ' ' && !noSpaceBefore && !afterOpen) sb += ' ';
    }
    if (inSelect && sb.length >= 6 && endsWithSelectHeader(sb) && t.kind !== 'punct') sb += '\n' + indent;
    sb += text;
    atLineStart = false;
    prevWasOpenParen = t.kind === 'punct' && text === '(';
  }
  // Cleanup: trim each line's trailing space, drop leading blanks, trim end.
  const lines = sb.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  let out = '';
  let started = false;
  for (const l of lines) { if (!started && l.length === 0) continue; started = true; out += l + '\n'; }
  return out.replace(/\s+$/, '');
}

function minifySql(sql: string): string {
  if (!sql.trim()) return '';
  const tokens = tokenize(sql);
  let sb = '';
  for (const t of tokens) {
    if (t.kind === 'comment') continue;
    const text = t.text;
    if (sb.length > 0) {
      const last = sb[sb.length - 1]!;
      const noSpaceBefore = t.kind === 'punct' && [',', ')', ';', '.', '::'].includes(text);
      const afterOpenOrDot = last === '(' || last === '.';
      if (!noSpaceBefore && !afterOpenOrDot) sb += ' ';
    }
    sb += text;
  }
  return sb.trim();
}

const SAMPLE = "select u.id, u.name, u.email from users u left join orders o on o.user_id = u.id where u.active = 1 and o.total > 100 order by u.name asc;";

export function SqlFormatModule() {
  const { t } = useTranslation();
  const [upper, setUpper] = useState(true);
  const [indent, setIndent] = useState(2);
  const [input, setInput] = useState(SAMPLE);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState(t('sqlformat.ready'));

  const doFormat = () => { if (!input.trim()) return setStatus(t('sqlformat.nothingFormat')); setOutput(formatSql(input, upper, indent)); setStatus(t('sqlformat.formatted')); };
  const doMinify = () => { if (!input.trim()) return setStatus(t('sqlformat.nothingMinify')); setOutput(minifySql(input)); setStatus(t('sqlformat.minified')); };
  const doSample = () => { setInput(SAMPLE); setOutput(formatSql(SAMPLE, upper, indent)); setStatus(t('sqlformat.loadedSample')); };
  const doClear = () => { setInput(''); setOutput(''); setStatus(t('sqlformat.cleared')); };
  const doCopy = () => { if (!output) return setStatus(t('sqlformat.nothingCopy')); void navigator.clipboard?.writeText(output); setStatus(t('sqlformat.copied')); };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} /> {t('sqlformat.upper')}
        </label>
        <label className="count-note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {t('sqlformat.indent')}
          <input className="mod-search" type="number" min={0} max={16} style={{ maxWidth: 80 }} value={indent} onChange={(e) => setIndent(Math.max(0, Math.min(16, Number(e.target.value) || 0)))} />
        </label>
        <button className="mini primary" onClick={doFormat}>{t('sqlformat.format')}</button>
        <button className="mini" onClick={doMinify}>{t('sqlformat.minify')}</button>
        <button className="mini" onClick={doSample}>{t('sqlformat.sample')}</button>
        <button className="mini" onClick={doClear}>{t('sqlformat.clear')}</button>
        <button className="mini" disabled={!output} onClick={doCopy}>{t('sqlformat.copy')}</button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('sqlformat.inputPlaceholder')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('sqlformat.outputPlaceholder')} style={{ fontFamily: 'var(--mono, monospace)', whiteSpace: 'pre' }} />
      </div>
      <p className="count-note" style={{ marginTop: 8 }}>{status}</p>
    </div>
  );
}
