import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// JSONPath-lite — a small, dependency-free evaluator over parsed JSON.
// Supports: $ (root), .key / ['key'] member access, [n] index (negatives allowed),
// [*] and .* wildcards, and .. recursive descent (..key / ..*). Never throws for
// user input — returns structured results/errors.

const SAMPLE_JSON =
  '{\n  "name": "WinForge",\n  "version": 11,\n  "tags": ["winui", "reactor", "tools"],\n  "authors": [\n    { "id": 1, "name": "Ada" },\n    { "id": 2, "name": "Alan" }\n  ]\n}';

interface Match {
  path: string;
  value: string;
}

interface QueryResult {
  ok: boolean;
  error?: string;
  matches: Match[];
}

type StepKind = 'child' | 'index' | 'wildcard' | 'recursiveKey' | 'recursiveWildcard';

interface Step {
  kind: StepKind;
  key: string;
  index: number;
}

class ParseError extends Error {}

// ---- helpers ------------------------------------------------------------------------

// Path segment: dotted for simple identifiers, bracketed-quoted otherwise.
function seg(key: string): string {
  let simple = key.length > 0;
  for (const c of key) {
    if (!(/[A-Za-z0-9]/.test(c) || c === '_')) {
      simple = false;
      break;
    }
  }
  return simple ? '.' + key : "['" + key.replace(/'/g, "\\'") + "']";
}

// Compact string form of a JSON value for display (mirrors System.Text.Json Stringify).
function stringify(el: unknown): string {
  if (el === null) return 'null';
  if (el === undefined) return '';
  const tp = typeof el;
  if (tp === 'string') return el as string;
  if (tp === 'number' || tp === 'boolean') return String(el);
  try {
    return JSON.stringify(el);
  } catch {
    return String(el);
  }
}

// ---- query parsing ------------------------------------------------------------------

function readName(q: string, start: number): [string, number] {
  let i = start;
  while (i < q.length) {
    const c = q[i]!;
    if (c === '.' || c === '[' || c === ']' || c === '*') break;
    i++;
  }
  return [q.substring(start, i).trim(), i];
}

function parseQuery(query: string): Step[] {
  const steps: Step[] = [];
  if (!query || !query.trim()) throw new ParseError('empty');
  const q = query.trim();
  let i = 0;

  // optional leading $
  if (q[i] === '$') i++;

  while (i < q.length) {
    const c = q[i]!;
    if (c === '.') {
      if (i + 1 < q.length && q[i + 1] === '.') {
        // recursive descent: ..key or ..*
        i += 2;
        if (i < q.length && q[i] === '*') {
          steps.push({ kind: 'recursiveWildcard', key: '', index: 0 });
          i++;
        } else {
          const [name, next] = readName(q, i);
          i = next;
          if (name.length === 0) throw new ParseError("expected key after '..'");
          steps.push({ kind: 'recursiveKey', key: name, index: 0 });
        }
      } else {
        i++; // single '.'
        if (i < q.length && q[i] === '*') {
          steps.push({ kind: 'wildcard', key: '', index: 0 });
          i++;
        } else {
          const [name, next] = readName(q, i);
          i = next;
          if (name.length === 0) throw new ParseError("expected key after '.'");
          steps.push({ kind: 'child', key: name, index: 0 });
        }
      }
    } else if (c === '[') {
      const close = q.indexOf(']', i);
      if (close < 0) throw new ParseError("unclosed '['");
      const inner = q.substring(i + 1, close).trim();
      i = close + 1;
      if (inner === '*') {
        steps.push({ kind: 'wildcard', key: '', index: 0 });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
      ) {
        steps.push({ kind: 'child', key: inner.substring(1, inner.length - 1), index: 0 });
      } else if (/^[+-]?\d+$/.test(inner)) {
        steps.push({ kind: 'index', key: '', index: parseInt(inner, 10) });
      } else {
        throw new ParseError("bad index '" + inner + "'");
      }
    } else {
      // bare leading name (e.g. "a.b" without $)
      const [name, next] = readName(q, i);
      i = next;
      if (name.length === 0) throw new ParseError("unexpected '" + c + "'");
      steps.push({ kind: 'child', key: name, index: 0 });
    }
  }
  return steps;
}

// ---- evaluation ---------------------------------------------------------------------

function isObj(el: unknown): el is Record<string, unknown> {
  return el !== null && typeof el === 'object' && !Array.isArray(el);
}

function recurseKey(key: string, path: string, el: unknown, out: [string, unknown][]): void {
  if (isObj(el)) {
    for (const name of Object.keys(el)) {
      const child = el[name];
      if (name === key) out.push([path + seg(name), child]);
      recurseKey(key, path + seg(name), child, out);
    }
  } else if (Array.isArray(el)) {
    for (let i = 0; i < el.length; i++) {
      recurseKey(key, path + '[' + i + ']', el[i], out);
    }
  }
}

function recurseAll(path: string, el: unknown, out: [string, unknown][]): void {
  if (isObj(el)) {
    for (const name of Object.keys(el)) {
      const child = el[name];
      out.push([path + seg(name), child]);
      recurseAll(path + seg(name), child, out);
    }
  } else if (Array.isArray(el)) {
    for (let i = 0; i < el.length; i++) {
      out.push([path + '[' + i + ']', el[i]]);
      recurseAll(path + '[' + i + ']', el[i], out);
    }
  }
}

function applyStep(step: Step, path: string, el: unknown, out: [string, unknown][]): void {
  switch (step.kind) {
    case 'child':
      if (isObj(el) && Object.prototype.hasOwnProperty.call(el, step.key)) {
        out.push([path + seg(step.key), el[step.key]]);
      }
      break;
    case 'index':
      if (Array.isArray(el)) {
        const len = el.length;
        const idx = step.index < 0 ? len + step.index : step.index;
        if (idx >= 0 && idx < len) out.push([path + '[' + idx + ']', el[idx]]);
      }
      break;
    case 'wildcard':
      if (isObj(el)) {
        for (const name of Object.keys(el)) out.push([path + seg(name), el[name]]);
      } else if (Array.isArray(el)) {
        for (let i = 0; i < el.length; i++) out.push([path + '[' + i + ']', el[i]]);
      }
      break;
    case 'recursiveKey':
      recurseKey(step.key, path, el, out);
      break;
    case 'recursiveWildcard':
      recurseAll(path, el, out);
      break;
  }
}

function parseJsonDefensive(json: string): unknown {
  return JSON.parse(!json || !json.trim() ? 'null' : json);
}

function runQuery(json: string, query: string): QueryResult {
  let root: unknown;
  try {
    root = parseJsonDefensive(json);
  } catch (ex) {
    return { ok: false, error: 'json:' + (ex instanceof Error ? ex.message : String(ex)), matches: [] };
  }

  let steps: Step[];
  try {
    steps = parseQuery(query);
  } catch (ex) {
    return { ok: false, error: 'query:' + (ex instanceof Error ? ex.message : String(ex)), matches: [] };
  }

  try {
    let acc: [string, unknown][] = [['$', root]];
    for (const step of steps) {
      const next: [string, unknown][] = [];
      for (const [path, el] of acc) applyStep(step, path, el, next);
      acc = next;
    }
    return { ok: true, matches: acc.map(([path, el]) => ({ path, value: stringify(el) })) };
  } catch (ex) {
    return { ok: false, error: 'eval:' + (ex instanceof Error ? ex.message : String(ex)), matches: [] };
  }
}

function walkLeaves(path: string, el: unknown, out: Match[]): void {
  if (isObj(el)) {
    const keys = Object.keys(el);
    if (keys.length === 0) out.push({ path, value: '{}' });
    else for (const name of keys) walkLeaves(path + seg(name), el[name], out);
  } else if (Array.isArray(el)) {
    if (el.length === 0) out.push({ path, value: '[]' });
    else for (let i = 0; i < el.length; i++) walkLeaves(path + '[' + i + ']', el[i], out);
  } else {
    out.push({ path, value: stringify(el) });
  }
}

function leafPaths(json: string): QueryResult {
  let root: unknown;
  try {
    root = parseJsonDefensive(json);
  } catch (ex) {
    return { ok: false, error: 'json:' + (ex instanceof Error ? ex.message : String(ex)), matches: [] };
  }
  const matches: Match[] = [];
  walkLeaves('$', root, matches);
  return { ok: true, matches };
}

function walkFlatten(path: string, el: unknown, out: Match[]): void {
  out.push({ path, value: stringify(el) });
  if (isObj(el)) {
    for (const name of Object.keys(el)) walkFlatten(path + seg(name), el[name], out);
  } else if (Array.isArray(el)) {
    for (let i = 0; i < el.length; i++) walkFlatten(path + '[' + i + ']', el[i], out);
  }
}

function flattenAll(json: string): QueryResult {
  let root: unknown;
  try {
    root = parseJsonDefensive(json);
  } catch (ex) {
    return { ok: false, error: 'json:' + (ex instanceof Error ? ex.message : String(ex)), matches: [] };
  }
  const matches: Match[] = [];
  walkFlatten('$', root, matches);
  return { ok: true, matches };
}

// -------------------------------------------------------------------------------------

export function JsonPathModule() {
  const { t } = useTranslation();
  const [json, setJson] = useState(SAMPLE_JSON);
  const [query, setQuery] = useState('$..name');
  const [results, setResults] = useState<Match[] | null>(null);
  const [status, setStatus] = useState<{ msg: string; error: boolean }>({ msg: t('jsonpath.ready'), error: false });

  const setOk = (msg: string) => setStatus({ msg, error: false });
  const setErr = (msg: string) => setStatus({ msg, error: true });

  const showError = (code?: string) => {
    let kind = code ?? '';
    let detail = '';
    const colon = kind.indexOf(':');
    if (colon >= 0) {
      detail = kind.substring(colon + 1);
      kind = kind.substring(0, colon);
    }
    let msg: string;
    if (kind === 'json') msg = t('jsonpath.errJson');
    else if (kind === 'query') msg = t('jsonpath.errQuery');
    else msg = t('jsonpath.errEval');
    if (detail.trim()) msg += '  (' + detail.trim() + ')';
    setErr(msg);
  };

  const bind = (r: QueryResult, okMsg: string) => {
    if (!r.ok) {
      setResults(null);
      showError(r.error);
      return;
    }
    setResults(r.matches);
    if (r.matches.length === 0) setOk(t('jsonpath.noMatches'));
    else setOk(okMsg);
  };

  const onRun = () => {
    try {
      const r = runQuery(json, query);
      bind(r, t('jsonpath.matchCount', { count: r.matches.length }));
    } catch (ex) {
      setErr(t('jsonpath.wentWrong') + (ex instanceof Error ? ex.message : String(ex)));
    }
  };

  const onLeaf = () => {
    try {
      const r = leafPaths(json);
      bind(r, t('jsonpath.leafCount', { count: r.matches.length }));
    } catch (ex) {
      setErr(t('jsonpath.wentWrong') + (ex instanceof Error ? ex.message : String(ex)));
    }
  };

  const onFlatten = () => {
    try {
      const r = flattenAll(json);
      bind(r, t('jsonpath.flatCount', { count: r.matches.length }));
    } catch (ex) {
      setErr(t('jsonpath.wentWrong') + (ex instanceof Error ? ex.message : String(ex)));
    }
  };

  const onCopy = () => {
    try {
      if (!results || results.length === 0) {
        setOk(t('jsonpath.nothingToCopy'));
        return;
      }
      const text = results.map((m) => m.path + ' = ' + m.value).join('\n') + '\n';
      void navigator.clipboard?.writeText(text);
      setOk(t('jsonpath.copiedLines', { count: results.length }));
    } catch (ex) {
      setErr(t('jsonpath.wentWrong') + (ex instanceof Error ? ex.message : String(ex)));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('jsonpath.blurb')}
      </p>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        {t('jsonpath.jsonLabel')}
      </label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ width: '100%', minHeight: 180, fontFamily: 'Consolas, monospace' }}
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />

      <label className="count-note" style={{ display: 'block', fontWeight: 600, margin: '10px 0 4px' }}>
        {t('jsonpath.queryLabel')}
      </label>
      <div className="mod-toolbar" style={{ marginTop: 0 }}>
        <input
          className="mod-search"
          style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRun();
          }}
        />
        <button className="mini primary" onClick={onRun}>
          {t('jsonpath.run')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 6, fontSize: 12 }}>
        {t('jsonpath.hint')}
      </p>

      <div className="mod-toolbar">
        <button className="mini" onClick={onLeaf}>
          {t('jsonpath.leaf')}
        </button>
        <button className="mini" onClick={onFlatten}>
          {t('jsonpath.flatten')}
        </button>
        <button className="mini" disabled={!results || results.length === 0} onClick={onCopy}>
          {t('jsonpath.copy')}
        </button>
      </div>

      <p
        className={status.error ? '' : 'count-note'}
        style={status.error ? { marginTop: 4, color: 'var(--danger)', fontSize: 12.5 } : { marginTop: 4, fontSize: 12 }}
      >
        {status.msg}
      </p>

      {results && results.length > 0 && (
        <div className="kv-list" style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto' }}>
          {results.map((m, idx) => (
            <div className="kv-row" key={idx} style={{ display: 'block', padding: '6px 8px' }}>
              <div className="count-note" style={{ fontFamily: 'Consolas, monospace', fontSize: 12, marginBottom: 1 }}>
                {m.path}
              </div>
              <div style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{m.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
