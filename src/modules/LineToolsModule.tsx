import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// 行工具 · Line Tools — pure client-side per-line text transforms, ported from
// WinForge's LineToolsService. Every helper is tolerant of \r\n / \r / \n, treats
// missing input as empty, and returns a new string. No I/O, no network.

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

const joinLines = (lines: string[]): string => lines.join('\n');

function count(text: string): { lines: number; chars: number; words: number } {
  if (!text) return { lines: 0, chars: 0, words: 0 };
  const lines = splitLines(text).length;
  const chars = text.length;
  const words = text.split(/[ \t\r\n]+/).filter((w) => w.length > 0).length;
  return { lines, chars, words };
}

function numberLines(text: string, paren: boolean): string {
  return joinLines(splitLines(text).map((l, i) => (paren ? `${i + 1}) ${l}` : `${i + 1}. ${l}`)));
}

// Strip a leading "12. ", "12) ", "12:", "12 " or "12\t" style number from each line.
function removeLineNumbers(text: string): string {
  return joinLines(
    splitLines(text).map((s) => {
      let p = 0;
      while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
      let d = p;
      while (d < s.length && s[d]! >= '0' && s[d]! <= '9') d++;
      if (d > p) {
        let q = d;
        if (q < s.length && (s[q] === '.' || s[q] === ')' || s[q] === ':')) q++;
        if (q < s.length && (s[q] === ' ' || s[q] === '\t')) {
          while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
          return s.substring(q);
        } else if (q > d) {
          return s.substring(q);
        }
      }
      return s;
    }),
  );
}

const addPrefix = (text: string, prefix: string): string =>
  joinLines(splitLines(text).map((l) => prefix + l));

const addSuffix = (text: string, suffix: string): string =>
  joinLines(splitLines(text).map((l) => l + suffix));

const wrapQuotes = (text: string): string => joinLines(splitLines(text).map((l) => `"${l}"`));

const joinOn = (text: string, delimiter: string): string => splitLines(text).join(delimiter);

function splitOn(text: string, delimiter: string): string {
  if (!text) return '';
  if (!delimiter) return text;
  return joinLines(text.split(delimiter));
}

const reverseChars = (text: string): string =>
  joinLines(splitLines(text).map((l) => [...l].reverse().join('')));

const sortLines = (text: string): string =>
  joinLines(
    splitLines(text).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), undefined, { sensitivity: 'accent' })),
  );

const reverseOrder = (text: string): string => joinLines(splitLines(text).reverse());

function deduplicate(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of splitLines(text)) {
    const key = l.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(l);
    }
  }
  return joinLines(out);
}

const removeEmpty = (text: string): string =>
  joinLines(splitLines(text).filter((l) => l.trim().length > 0));

const trimLines = (text: string): string => joinLines(splitLines(text).map((l) => l.trim()));

// Fisher–Yates shuffle using a cryptographically strong RNG.
function shuffle(text: string): string {
  const lines = splitLines(text);
  for (let i = lines.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0]! % (i + 1);
    const a = lines[i]!;
    const b = lines[j]!;
    lines[i] = b;
    lines[j] = a;
  }
  return joinLines(lines);
}

export function LineToolsModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const [delim, setDelim] = useState(', ');
  const [status, setStatus] = useState<{ ok: boolean; msg: string }>({ ok: true, msg: t('linetools.ready') });

  const c = count(input);

  // Apply a transform: read input, run it, write output, report line count out.
  const apply = (op: (s: string) => string, nameKey: string) => {
    try {
      const result = op(input) ?? '';
      setOutput(result);
      const outLines = count(result).lines;
      setStatus({ ok: true, msg: t('linetools.applied', { name: t(nameKey), n: outLines }) });
    } catch {
      setStatus({ ok: false, msg: t('linetools.errApply') });
    }
  };

  const copy = () => {
    if (!output) {
      setStatus({ ok: false, msg: t('linetools.nothingCopy') });
      return;
    }
    try {
      void navigator.clipboard?.writeText(output);
      setStatus({ ok: true, msg: t('linetools.copied') });
    } catch {
      setStatus({ ok: false, msg: t('linetools.errClipboard') });
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 10 }}>{t('linetools.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          {t('linetools.prefix')}
          <input className="mod-search" style={{ maxWidth: 130 }} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          {t('linetools.suffix')}
          <input className="mod-search" style={{ maxWidth: 130 }} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          {t('linetools.delim')}
          <input className="mod-search" style={{ maxWidth: 130 }} value={delim} onChange={(e) => setDelim(e.target.value)} />
        </label>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => apply((s) => numberLines(s, false), 'linetools.numberedName')}>{t('linetools.numberDot')}</button>
        <button className="mini" onClick={() => apply((s) => numberLines(s, true), 'linetools.numberedName')}>{t('linetools.numberParen')}</button>
        <button className="mini" onClick={() => apply(removeLineNumbers, 'linetools.removedNumsName')}>{t('linetools.removeNums')}</button>
        <button className="mini" onClick={() => apply((s) => addPrefix(s, prefix), 'linetools.prefixedName')}>{t('linetools.addPrefix')}</button>
        <button className="mini" onClick={() => apply((s) => addSuffix(s, suffix), 'linetools.suffixedName')}>{t('linetools.addSuffix')}</button>
        <button className="mini" onClick={() => apply(wrapQuotes, 'linetools.quotedName')}>{t('linetools.quotes')}</button>
        <button className="mini" onClick={() => apply((s) => joinOn(s, delim), 'linetools.joinedName')}>{t('linetools.join')}</button>
        <button className="mini" onClick={() => apply((s) => splitOn(s, delim), 'linetools.splitName')}>{t('linetools.split')}</button>
        <button className="mini" onClick={() => apply(reverseChars, 'linetools.reversedCharsName')}>{t('linetools.reverseChars')}</button>
        <button className="mini" onClick={() => apply(sortLines, 'linetools.sortedName')}>{t('linetools.sort')}</button>
        <button className="mini" onClick={() => apply(reverseOrder, 'linetools.reversedOrderName')}>{t('linetools.reverseOrder')}</button>
        <button className="mini" onClick={() => apply(deduplicate, 'linetools.dedupedName')}>{t('linetools.dedupe')}</button>
        <button className="mini" onClick={() => apply(removeEmpty, 'linetools.removedEmptyName')}>{t('linetools.removeEmpty')}</button>
        <button className="mini" onClick={() => apply(trimLines, 'linetools.trimmedName')}>{t('linetools.trim')}</button>
        <button className="mini" onClick={() => apply(shuffle, 'linetools.shuffledName')}>{t('linetools.shuffle')}</button>
        <button className="mini primary" disabled={!output} onClick={copy}>{t('linetools.copy')}</button>
      </div>

      <div className="io-grid">
        <div>
          <p className="count-note" style={{ marginTop: 0, marginBottom: 4 }}>{t('linetools.input')}</p>
          <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('linetools.inputPlaceholder')} />
        </div>
        <div>
          <p className="count-note" style={{ marginTop: 0, marginBottom: 4 }}>{t('linetools.output')}</p>
          <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('linetools.outputPlaceholder')} />
        </div>
      </div>

      <p className="count-note" style={{ marginTop: 10 }}>{t('linetools.count', { lines: c.lines, words: c.words, chars: c.chars })}</p>
      <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 4 } : { marginTop: 4, color: 'var(--danger)', fontSize: 12.5 }}>{status.msg}</p>
    </div>
  );
}
