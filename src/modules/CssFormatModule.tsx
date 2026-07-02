import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Private-use sentinels wrap each protected comment's index. They survive
// whitespace-collapse and .trim() (not whitespace) and never collide with CSS
// syntax or numeric literals, so restore only matches real placeholders.
const OPEN = '';
const CLOSE = '';

function protectComments(css: string): [string, string[]] {
  const comments: string[] = [];
  const out = css.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    comments.push(m);
    return `${OPEN}${comments.length - 1}${CLOSE}`;
  });
  return [out, comments];
}
const restore = (s: string, comments: string[]) =>
  s.replace(/(\d+)/g, (_m, i) => comments[+i]!);

function formatCss(css: string, indentSize: number): string {
  const [protectedCss, comments] = protectComments(css);
  const src = protectedCss.replace(/\s+/g, ' ');
  const pad = (n: number) => ' '.repeat(n * indentSize);
  let out = '';
  let depth = 0;
  let buf = '';
  for (const c of src) {
    if (c === '{') {
      out += pad(depth) + buf.trim() + ' {\n';
      buf = '';
      depth++;
    } else if (c === '}') {
      const s = buf.trim();
      if (s) out += pad(depth) + s + (s.endsWith(';') ? '' : ';') + '\n';
      buf = '';
      depth = Math.max(0, depth - 1);
      out += pad(depth) + '}\n';
    } else if (c === ';') {
      out += pad(depth) + buf.trim() + ';\n';
      buf = '';
    } else buf += c;
  }
  if (buf.trim()) out += pad(depth) + buf.trim() + '\n';
  return restore(out.replace(/\n{3,}/g, '\n\n'), comments).trim() + '\n';
}

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

export function CssFormatModule() {
  const { t } = useTranslation();
  const [indent, setIndent] = useState(2);
  const [input, setInput] = useState('@media (max-width:600px){.card{color:red;padding:8px 12px}}\n.btn,.link{display:flex;gap:4px}');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const act = (fn: (s: string) => string, okMsg: string) => {
    if (!input.trim()) return setStatus({ ok: false, msg: t('css.empty') });
    try {
      setOutput(fn(input));
      setStatus({ ok: true, msg: okMsg });
    } catch (e) {
      setStatus({ ok: false, msg: String(e instanceof Error ? e.message : e) });
    }
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini primary" onClick={() => act((s) => formatCss(s, indent), t('css.formatted'))}>
          {t('css.format')}
        </button>
        <button className="mini" onClick={() => act(minifyCss, t('css.minified'))}>
          {t('css.minify')}
        </button>
        <span className="count-note">{t('css.indent')}</span>
        <input className="mod-search" type="number" min={0} max={8} style={{ maxWidth: 70 }} value={indent} onChange={(e) => setIndent(Math.max(0, Math.min(8, +e.target.value || 2)))} />
        <button className="mini" disabled={!output} onClick={() => output && (navigator.clipboard?.writeText(output), setStatus({ ok: true, msg: t('css.copied') }))}>
          {t('css.copy')}
        </button>
        <button className="mini" onClick={() => (setInput(''), setOutput(''), setStatus(null))}>
          {t('css.clear')}
        </button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('css.inputPlaceholder')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('css.outputPlaceholder')} />
      </div>
      {status && (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg} {output && status.ok ? `· ${output.length} chars` : ''}
        </p>
      )}
    </div>
  );
}
