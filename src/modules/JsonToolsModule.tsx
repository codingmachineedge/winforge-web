import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar } from './common';

type Mode = 'json' | 'xml';

function countNodes(v: unknown): number {
  if (Array.isArray(v)) return 1 + v.reduce<number>((n, x) => n + countNodes(x), 0);
  if (v && typeof v === 'object') return 1 + Object.values(v).reduce<number>((n, x) => n + countNodes(x), 0);
  return 1;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

// --- XML helpers (DOMParser / XMLSerializer, no deps) ---
function parseXml(s: string): Document {
  const doc = new DOMParser().parseFromString(s, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(err.textContent?.replace(/\s+/g, ' ').trim() || 'invalid XML');
  return doc;
}
function formatXml(s: string): string {
  parseXml(s); // validate first
  const PAD = '  ';
  let depth = 0;
  const xml = s.replace(/>\s*</g, '><').trim();
  return xml
    .replace(/</g, '\n<')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      if (/^<\/\w/.test(line)) depth = Math.max(0, depth - 1);
      const out = PAD.repeat(depth) + line;
      if (/^<\w[^>]*[^/]>$/.test(line) && !/^<.*<\/.*>$/.test(line)) depth++;
      return out;
    })
    .join('\n');
}

export function JsonToolsModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('json');
  const [sortKeys, setSortKeys] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [stat, setStat] = useState('');

  const isJson = mode === 'json';

  const apply = (fn: () => { out: string; nodes?: number; msg: string }) => {
    try {
      const r = fn();
      setOutput(r.out);
      setStatus({ ok: true, msg: r.msg });
      setStat(
        r.nodes != null
          ? t('jsontools.stat', { nodes: r.nodes, chars: r.out.length })
          : t('jsontools.statChars', { chars: r.out.length }),
      );
    } catch (e) {
      setStatus({ ok: false, msg: String(e instanceof Error ? e.message : e) });
      setStat('');
    }
  };

  const format = () =>
    apply(() => {
      if (isJson) {
        const v = JSON.parse(input);
        const out = JSON.stringify(sortKeys ? sortDeep(v) : v, null, 2);
        return { out, nodes: countNodes(v), msg: t('jsontools.formatted') };
      }
      return { out: formatXml(input), msg: t('jsontools.formatted') };
    });

  const minify = () =>
    apply(() => {
      if (isJson) {
        const v = JSON.parse(input);
        return { out: JSON.stringify(sortKeys ? sortDeep(v) : v), nodes: countNodes(v), msg: t('jsontools.minified') };
      }
      parseXml(input);
      return { out: input.replace(/>\s+</g, '><').trim(), msg: t('jsontools.minified') };
    });

  const validate = () =>
    apply(() => {
      if (isJson) {
        const v = JSON.parse(input);
        return { out: output, nodes: countNodes(v), msg: t('jsontools.validJson') };
      }
      parseXml(input);
      return { out: output, msg: t('jsontools.validXml') };
    });

  const escape = () => apply(() => ({ out: JSON.stringify(input), msg: t('jsontools.escaped') }));
  const unescape = () =>
    apply(() => {
      const v = JSON.parse(input);
      if (typeof v !== 'string') throw new Error(t('jsontools.notString'));
      return { out: v, msg: t('jsontools.unescaped') };
    });

  const copy = () => {
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('jsontools.copied') });
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="json">JSON</option>
          <option value="xml">XML</option>
        </select>
        {isJson && (
          <label className="chk">
            <input type="checkbox" checked={sortKeys} onChange={(e) => setSortKeys(e.target.checked)} />
            {t('jsontools.sortKeys')}
          </label>
        )}
        <button className="mini primary" onClick={format}>
          {t('jsontools.format')}
        </button>
        <button className="mini" onClick={minify}>
          {t('jsontools.minify')}
        </button>
        <button className="mini" onClick={validate}>
          {t('jsontools.validate')}
        </button>
        {isJson && (
          <>
            <button className="mini" onClick={escape}>
              {t('jsontools.escape')}
            </button>
            <button className="mini" onClick={unescape}>
              {t('jsontools.unescape')}
            </button>
          </>
        )}
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('jsontools.note')}
      </p>
      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          placeholder={t('jsontools.inputPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('jsontools.outputPlaceholder')} />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('jsontools.copy')}
        </button>
        {stat && <span className="count-note">{stat}</span>}
        {status && (
          <span className={status.ok ? 'dep-ok' : ''} style={status.ok ? {} : { color: 'var(--danger)', fontSize: 12.5 }}>
            {status.msg}
          </span>
        )}
      </div>
    </div>
  );
}
