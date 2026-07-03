import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Break arbitrary text into lowercase word tokens. Mirrors WinForge's
// CaseConvertService.Tokenize: splits on whitespace, _ - . / \ : and other
// punctuation, plus camelCase/PascalCase and letter<->digit boundaries.
function tokenize(input: string): string[] {
  const words: string[] = [];
  if (!input) return words;
  let cur = '';
  let prev = '\0';
  const flush = () => {
    if (cur.length > 0) {
      words.push(cur.toLowerCase());
      cur = '';
    }
  };
  const isLetterOrDigit = (c: string) => /[\p{L}\p{N}]/u.test(c);
  const isLower = (c: string) => c.toLowerCase() === c && c.toUpperCase() !== c;
  const isUpper = (c: string) => c.toUpperCase() === c && c.toLowerCase() !== c;
  const isDigit = (c: string) => c >= '0' && c <= '9';

  for (const c of input) {
    const sep =
      c === ' ' || c === '\t' || c === '\r' || c === '\n' ||
      c === '_' || c === '-' || c === '.' || c === '/' ||
      c === '\\' || c === ':';
    if (sep) {
      flush();
      prev = c;
      continue;
    }
    if (!isLetterOrDigit(c)) {
      flush();
      prev = c;
      continue;
    }
    if (cur.length > 0) {
      const prevLower = isLower(prev);
      const prevDigit = isDigit(prev);
      const curUpper = isUpper(c);
      const curDigit = isDigit(c);
      if (curUpper && (prevLower || prevDigit)) flush();
      else if (curDigit !== prevDigit) flush();
    }
    cur += c;
    prev = c;
  }
  flush();
  return words;
}

const cap = (w: string) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1));

const camelCase = (w: string[]) => (w.length === 0 ? '' : w[0]! + w.slice(1).map(cap).join(''));
const pascalCase = (w: string[]) => w.map(cap).join('');
const snakeCase = (w: string[]) => w.join('_');
const kebabCase = (w: string[]) => w.join('-');
const constantCase = (w: string[]) => w.join('_').toUpperCase();
const dotCase = (w: string[]) => w.join('.');
const pathCase = (w: string[]) => w.join('/');
const titleCase = (w: string[]) => w.map(cap).join(' ');
const trainCase = (w: string[]) => w.map(cap).join('-');
const sentenceCase = (w: string[]) => (w.length === 0 ? '' : [cap(w[0]!), ...w.slice(1)].join(' '));

// (labelKey, value) for every supported form — same order as WinForge AllForms.
function allForms(w: string[]): { key: string; value: string }[] {
  return [
    { key: 'camel', value: camelCase(w) },
    { key: 'pascal', value: pascalCase(w) },
    { key: 'snake', value: snakeCase(w) },
    { key: 'kebab', value: kebabCase(w) },
    { key: 'constant', value: constantCase(w) },
    { key: 'title', value: titleCase(w) },
    { key: 'sentence', value: sentenceCase(w) },
    { key: 'dot', value: dotCase(w) },
    { key: 'path', value: pathCase(w) },
    { key: 'train', value: trainCase(w) },
  ];
}

export function CaseConvertModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('the quick brown-fox jumpsOver_the LAZY.dog 42 times');
  const [msg, setMsg] = useState('');

  const words = useMemo(() => tokenize(input), [input]);
  const rows = useMemo(() => allForms(words), [words]);

  const status = input.trim()
    ? t('caseconvert.wordsDetected', { count: words.length })
    : t('caseconvert.typeAbove');

  const copy = (value: string) => {
    if (!value) {
      setMsg(t('caseconvert.nothingToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(value);
    setMsg(t('caseconvert.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('caseconvert.blurb')}</p>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        {t('caseconvert.inputLabel')}
      </label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ width: '100%', minHeight: 80 }}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('caseconvert.inputPlaceholder')}
      />
      <p className="count-note" style={{ marginTop: 6 }}>
        {status}
        {msg && <span> · {msg}</span>}
      </p>

      <h3 className="group-title" style={{ fontSize: 14, margin: '14px 0 6px' }}>
        {t('caseconvert.outputLabel')}
      </h3>
      <div className="kv-list">
        {rows.map((r) => (
          <div key={r.key} className="kv-row" style={{ alignItems: 'center', gap: 10 }}>
            <span className="count-note" style={{ minWidth: 150 }}>{t(`caseconvert.form.${r.key}`)}</span>
            <input
              className="mod-search"
              style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
              readOnly
              value={r.value}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="mini" onClick={() => copy(r.value)}>
              {t('caseconvert.copy')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
