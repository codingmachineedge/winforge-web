import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Fn = (s: string) => string;
const lines = (s: string) => s.split(/\r?\n/);
const join = (a: string[]) => a.join('\n');

const transforms: { key: string; fn: Fn }[] = [
  { key: 'upper', fn: (s) => s.toUpperCase() },
  { key: 'lower', fn: (s) => s.toLowerCase() },
  { key: 'title', fn: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase()) },
  {
    key: 'toggle',
    fn: (s) =>
      [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
  },
  { key: 'trim', fn: (s) => join(lines(s).map((l) => l.trim())) },
  { key: 'noblank', fn: (s) => join(lines(s).filter((l) => l.trim() !== '')) },
  { key: 'collapse', fn: (s) => s.replace(/[ \t]+/g, ' ') },
  {
    key: 'dedupe',
    fn: (s) => {
      const seen = new Set<string>();
      return join(lines(s).filter((l) => (seen.has(l) ? false : seen.add(l))));
    },
  },
  { key: 'sortAZ', fn: (s) => join([...lines(s)].sort((a, b) => a.localeCompare(b))) },
  { key: 'sortZA', fn: (s) => join([...lines(s)].sort((a, b) => b.localeCompare(a))) },
  {
    key: 'sortNum',
    fn: (s) => join([...lines(s)].sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0))),
  },
  { key: 'reverseLines', fn: (s) => join([...lines(s)].reverse()) },
  {
    key: 'shuffle',
    fn: (s) => {
      const a = lines(s);
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return join(a);
    },
  },
  { key: 'reverseChars', fn: (s) => join(lines(s).map((l) => [...l].reverse().join(''))) },
  {
    key: 'slugify',
    fn: (s) =>
      s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
  },
];

export function TextToolsModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');

  const stats = useMemo(() => {
    const src = output || input;
    const chars = src.length;
    const words = (src.match(/\S+/g) || []).length;
    const ln = src === '' ? 0 : lines(src).length;
    return { chars, words, ln };
  }, [input, output]);

  const run = (fn: Fn) => setOutput(fn(input));
  const feedback = () => {
    setInput(output);
    setOutput('');
  };
  const copy = () => void navigator.clipboard?.writeText(output);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        {transforms.map((tr) => (
          <button key={tr.key} className="mini" onClick={() => run(tr.fn)}>
            {t(`texttools.${tr.key}`)}
          </button>
        ))}
      </div>
      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          placeholder={t('texttools.inputPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('texttools.outputPlaceholder')} />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('texttools.copy')}
        </button>
        <button className="mini" disabled={!output} onClick={feedback}>
          {t('texttools.toInput')}
        </button>
        <span className="count-note">
          {t('texttools.stats', { chars: stats.chars, words: stats.words, lines: stats.ln })}
        </span>
      </div>
    </div>
  );
}
