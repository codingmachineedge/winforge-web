import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Sep = '-' | '_' | '.';
type Case = 'lower' | 'upper' | 'keep';

interface Options {
  sep: Sep;
  letterCase: Case;
  stripDiacritics: boolean;
  collapse: boolean;
  keepUnicode: boolean;
  maxLength: number;
}

/** Faithful port of WinForge SlugifyService.Slugify — NFD strip + letter/digit walk. */
function slugify(input: string, o: Options): string {
  try {
    let source = input ?? '';
    if (o.stripDiacritics) {
      // NFD then drop combining marks (Mn category) → café -> cafe.
      source = source.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC');
    }
    const sep = o.sep;
    let out = '';
    let pendingSep = false;
    for (const c of source) {
      const ascii = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
      const uni = o.keepUnicode && c.codePointAt(0)! > 127 && /\p{L}|\p{N}/u.test(c);
      if (ascii || uni) {
        if (pendingSep && out.length > 0) out += sep;
        pendingSep = false;
        out += c;
      } else {
        pendingSep = true;
      }
    }
    if (o.collapse && out.length > 0) {
      const dup = new RegExp(`\\${sep}{2,}`, 'g');
      out = out.replace(dup, sep);
    }
    // trim stray separators from ends
    const trimRe = new RegExp(`^\\${sep}+|\\${sep}+$`, 'g');
    out = out.replace(trimRe, '');
    if (o.letterCase === 'lower') out = out.toLowerCase();
    else if (o.letterCase === 'upper') out = out.toUpperCase();
    if (o.maxLength > 0 && out.length > o.maxLength) {
      out = out.slice(0, o.maxLength).replace(trimRe, '');
    }
    return out;
  } catch {
    return '';
  }
}

function slugifyBlock(input: string, o: Options): string {
  if (!input) return '';
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => slugify(l, o))
    .join('\n');
}

export function SlugifyModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('Hello, World! Crème brûlée\n10 Ways to Win at SEO');
  const [sep, setSep] = useState<Sep>('-');
  const [letterCase, setCase] = useState<Case>('lower');
  const [stripDiacritics, setStrip] = useState(true);
  const [collapse, setCollapse] = useState(true);
  const [keepUnicode, setKeep] = useState(false);
  const [maxLength, setMax] = useState(0);
  const [copied, setCopied] = useState(false);

  const opts: Options = { sep, letterCase, stripDiacritics, collapse, keepUnicode, maxLength };
  const output = useMemo(() => slugifyBlock(input, opts), [input, sep, letterCase, stripDiacritics, collapse, keepUnicode, maxLength]);

  const firstLine = input.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const preview = firstLine ? `${firstLine}  →  ${slugify(firstLine, opts) || t('slugify.empty')}` : t('slugify.typeSomething');

  const copy = () => {
    if (!output) return;
    navigator.clipboard?.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note">{t('slugify.separator')}</label>
        <select className="mod-select" value={sep} onChange={(e) => setSep(e.target.value as Sep)}>
          <option value="-">{t('slugify.hyphen')}</option>
          <option value="_">{t('slugify.underscore')}</option>
          <option value=".">{t('slugify.dot')}</option>
        </select>
        <label className="count-note">{t('slugify.case')}</label>
        <select className="mod-select" value={letterCase} onChange={(e) => setCase(e.target.value as Case)}>
          <option value="lower">{t('slugify.lower')}</option>
          <option value="upper">{t('slugify.upper')}</option>
          <option value="keep">{t('slugify.keep')}</option>
        </select>
        <label className="count-note">{t('slugify.maxLength')}</label>
        <input className="mod-search" type="number" min={0} style={{ maxWidth: 80 }} value={maxLength} onChange={(e) => setMax(Math.max(0, +e.target.value || 0))} />
        <button className="mini" disabled={!output} onClick={copy}>
          {copied ? t('slugify.copied') : t('slugify.copy')}
        </button>
      </div>
      <div className="mod-toolbar">
        <label className="chk"><input type="checkbox" checked={stripDiacritics} onChange={(e) => setStrip(e.target.checked)} /> {t('slugify.strip')}</label>
        <label className="chk"><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> {t('slugify.collapse')}</label>
        <label className="chk"><input type="checkbox" checked={keepUnicode} onChange={(e) => setKeep(e.target.checked)} /> {t('slugify.unicode')}</label>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('slugify.inputPlaceholder')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('slugify.outputPlaceholder')} />
      </div>
      <p className="count-note" style={{ marginTop: 10 }}>{t('slugify.preview')}: <code>{preview}</code></p>
    </div>
  );
}
