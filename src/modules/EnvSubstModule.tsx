import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 變數代入（envsubst 式）· Variable substitution engine. Pure client, never throws.
// Expands $VAR and ${VAR} placeholders — including ${VAR:-default} (default when
// unset/empty) and ${VAR:?} (report missing) — from a supplied map, with optional
// process-environment fallback and $$ → $ escaping.

interface VarRow {
  id: number;
  name: string;
  value: string;
}

interface SubstResult {
  output: string;
  referenced: string[];
  unresolved: string[];
  missing: string[];
}

const isNameStart = (c: string): boolean => c === '_' || /\p{L}/u.test(c);
const isNamePart = (c: string): boolean => c === '_' || /[\p{L}\p{Nd}]/u.test(c);

/** Scan a template and return every distinct variable name it references, in order. */
function detectNames(template: string): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  try {
    const s = template ?? '';
    const n = s.length;
    let i = 0;
    while (i < n) {
      const c = s[i]!;
      if (c === '$' && i + 1 < n) {
        const next = s[i + 1]!;
        if (next === '$') {
          i += 2;
          continue;
        } // $$ escape — not a variable
        if (next === '{') {
          let j = i + 2;
          const start = j;
          while (j < n && isNamePart(s[j]!)) j++;
          const name = s.slice(start, j);
          if (name.length > 0 && !set.has(name)) {
            set.add(name);
            seen.push(name);
          }
          const close = s.indexOf('}', j);
          i = close < 0 ? n : close + 1;
          continue;
        }
        if (isNameStart(next)) {
          let j = i + 1;
          const start = j;
          while (j < n && isNamePart(s[j]!)) j++;
          const name = s.slice(start, j);
          if (name.length > 0 && !set.has(name)) {
            set.add(name);
            seen.push(name);
          }
          i = j;
          continue;
        }
      }
      i++;
    }
  } catch {
    /* never throw */
  }
  return seen;
}

// Find the first ":-" or ":?" operator index inside a ${...} body, else -1.
function findOperator(inner: string): number {
  for (let k = 0; k + 1 < inner.length; k++) {
    if (inner[k] === ':' && (inner[k + 1] === '-' || inner[k + 1] === '?')) return k;
  }
  return -1;
}

// Resolve a name from the map (env fallback is not available in the browser, so the
// checkbox is a semantic no-op here — a value must be non-empty to count as resolved).
function tryGet(map: Map<string, string>, name: string): string | null {
  const v = map.get(name);
  if (v != null && v.length > 0) return v;
  return null;
}

function substitute(template: string, map: Map<string, string>, escapeDoubleDollar: boolean): SubstResult {
  const referenced: string[] = [];
  const unresolved: string[] = [];
  const missing: string[] = [];
  const refset = new Set<string>();
  const unresolvedSet = new Set<string>();
  const missingSet = new Set<string>();
  let out = '';

  try {
    const s = template ?? '';
    const n = s.length;
    let i = 0;
    while (i < n) {
      const c = s[i]!;
      if (c !== '$') {
        out += c;
        i++;
        continue;
      }
      if (i + 1 >= n) {
        out += '$';
        i++;
        continue;
      }
      const next = s[i + 1]!;

      // $$ escape
      if (next === '$') {
        out += escapeDoubleDollar ? '$' : '$$';
        i += 2;
        continue;
      }

      // ${...}
      if (next === '{') {
        const close = s.indexOf('}', i + 2);
        if (close < 0) {
          out += c;
          i++;
          continue;
        } // unterminated — literal $
        const inner = s.slice(i + 2, close);
        i = close + 1;

        let name = inner;
        let defaultVal: string | null = null;
        let required = false;

        const op = findOperator(inner);
        if (op >= 0) {
          name = inner.slice(0, op);
          const kind = inner[op + 1]!; // ":-" or ":?"
          const rest = inner.length > op + 2 ? inner.slice(op + 2) : '';
          if (kind === '-') defaultVal = rest;
          else if (kind === '?') required = true;
        }

        name = name.trim();
        if (name.length === 0) {
          out += '${' + inner + '}';
          continue;
        }
        if (!refset.has(name)) {
          refset.add(name);
          referenced.push(name);
        }

        const val = tryGet(map, name);
        if (val != null) {
          out += val;
        } else if (defaultVal != null) {
          out += defaultVal;
        } else if (required) {
          if (!missingSet.has(name)) {
            missingSet.add(name);
            missing.push(name);
          }
          if (!unresolvedSet.has(name)) {
            unresolvedSet.add(name);
            unresolved.push(name);
          }
          out += '${' + name + '}'; // leave marker
        } else {
          if (!unresolvedSet.has(name)) {
            unresolvedSet.add(name);
            unresolved.push(name);
          }
          out += '${' + name + '}'; // leave placeholder visible
        }
        continue;
      }

      // $VAR (bare)
      if (isNameStart(next)) {
        let j = i + 1;
        const start = j;
        while (j < n && isNamePart(s[j]!)) j++;
        const name = s.slice(start, j);
        i = j;
        if (!refset.has(name)) {
          refset.add(name);
          referenced.push(name);
        }

        const val = tryGet(map, name);
        if (val != null) {
          out += val;
        } else {
          if (!unresolvedSet.has(name)) {
            unresolvedSet.add(name);
            unresolved.push(name);
          }
          out += '$' + name;
        }
        continue;
      }

      // lone $ followed by something else — literal
      out += '$';
      i++;
    }
  } catch {
    /* never throw — return partial */
  }

  return { output: out, referenced, unresolved, missing };
}

// Snapshot the rows into a case-sensitive map (last non-empty name wins).
function buildMap(rows: VarRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const name = (r.name ?? '').trim();
    if (name.length === 0) continue;
    map.set(name, r.value ?? '');
  }
  return map;
}

let nextId = 1;
const mkRow = (name = '', value = ''): VarRow => ({ id: nextId++, name, value });

export function EnvSubstModule() {
  const { t } = useTranslation();
  const [template, setTemplate] = useState('Hello ${NAME:-world}, port=$PORT');
  const [rows, setRows] = useState<VarRow[]>(() => [mkRow('PORT', '8080')]);
  const [envFallback, setEnvFallback] = useState(false);
  const [escapeDollar, setEscapeDollar] = useState(true);
  const [msg, setMsg] = useState<{ sev: 'success' | 'warning' | 'error'; text: string } | null>(null);

  const map = useMemo(() => buildMap(rows), [rows]);
  const res = useMemo(() => substitute(template, map, escapeDollar), [template, map, escapeDollar]);

  const report = useMemo(() => {
    const parts: string[] = [t('envsubst.referenced', { count: res.referenced.length })];
    if (res.unresolved.length > 0) parts.push(t('envsubst.unresolved', { list: res.unresolved.join(t('envsubst.sep')) }));
    if (res.missing.length > 0) parts.push(t('envsubst.missingList', { list: res.missing.join(t('envsubst.sep')) }));
    return parts.join(' ');
  }, [res, t]);

  // Live severity banner mirroring WinForge's UpdateReport.
  const banner = useMemo<{ sev: 'error' | 'warning'; text: string } | null>(() => {
    if (res.missing.length > 0) return { sev: 'error', text: t('envsubst.missingBanner') };
    if (res.unresolved.length > 0) return { sev: 'warning', text: t('envsubst.unresolvedBanner') };
    return null;
  }, [res, t]);

  const bannerColor = (sev: 'success' | 'warning' | 'error') =>
    sev === 'error' ? 'var(--danger)' : sev === 'warning' ? 'var(--warning, #b8860b)' : 'var(--accent, #2d7d46)';

  const detect = () => {
    const names = detectNames(template);
    const existing = new Set(rows.map((r) => (r.name ?? '').trim()));
    const added: VarRow[] = [];
    for (const name of names) {
      if (!name || existing.has(name)) continue;
      added.push(mkRow(name, ''));
      existing.add(name);
    }
    if (added.length > 0) setRows((prev) => [...prev, ...added]);
    setMsg({ sev: 'success', text: added.length > 0 ? t('envsubst.added', { count: added.length }) : t('envsubst.noNew') });
  };

  const addRow = () => setRows((prev) => [...prev, mkRow()]);
  const clearRows = () => {
    setRows([]);
    setMsg(null);
  };
  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));
  const updateRow = (id: number, patch: Partial<VarRow>) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const copy = () => {
    if (!res.output) return;
    void navigator.clipboard?.writeText(res.output);
    setMsg({ sev: 'success', text: t('envsubst.copied') });
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('envsubst.blurb')}
      </p>

      {banner && (
        <p style={{ margin: '0 0 12px', fontSize: 12.5, color: bannerColor(banner.sev) }}>{banner.text}</p>
      )}

      {/* Template */}
      <div className="mod-toolbar" style={{ marginBottom: 6 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('envsubst.template')}
        </h3>
        <button className="mini" onClick={detect}>
          {t('envsubst.detect')}
        </button>
      </div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ minHeight: 120, fontFamily: 'Consolas, monospace' }}
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        placeholder={t('envsubst.templatePlaceholder')}
      />

      {/* Options */}
      <div className="mod-toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <label className="chk">
          <input type="checkbox" checked={envFallback} onChange={(e) => setEnvFallback(e.target.checked)} />
          {t('envsubst.envFallback')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={escapeDollar} onChange={(e) => setEscapeDollar(e.target.checked)} />
          {t('envsubst.escape')}
        </label>
      </div>

      {/* Variables */}
      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('envsubst.variables')}
        </h3>
        <button className="mini" onClick={addRow}>
          {t('envsubst.add')}
        </button>
        <button className="mini" onClick={clearRows}>
          {t('envsubst.clear')}
        </button>
      </div>
      <div className="kv-list" style={{ marginTop: 6 }}>
        <div className="kv-row" style={{ fontSize: 12, opacity: 0.7 }}>
          <span style={{ flex: 1 }}>{t('envsubst.colName')}</span>
          <span style={{ flex: 1 }}>{t('envsubst.colValue')}</span>
          <span style={{ width: 32 }} />
        </div>
        {rows.map((r) => (
          <div className="kv-row" key={r.id}>
            <input
              className="mod-search"
              style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
              value={r.name}
              placeholder={t('envsubst.colName')}
              onChange={(e) => updateRow(r.id, { name: e.target.value })}
            />
            <input
              className="mod-search"
              style={{ flex: 1 }}
              value={r.value}
              placeholder={t('envsubst.colValue')}
              onChange={(e) => updateRow(r.id, { value: e.target.value })}
            />
            <button className="mini" style={{ width: 32 }} title={t('envsubst.remove')} onClick={() => removeRow(r.id)}>
              ✕
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="count-note" style={{ margin: '4px 0 0' }}>{t('envsubst.noVars')}</p>}
      </div>

      {/* Output */}
      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('envsubst.output')}
        </h3>
        <button className="mini" disabled={!res.output} onClick={copy}>
          {t('envsubst.copy')}
        </button>
      </div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        style={{ minHeight: 120, fontFamily: 'Consolas, monospace' }}
        value={res.output}
      />
      <p className="count-note" style={{ marginTop: 8 }}>
        {report}
      </p>
      {msg && (
        <p style={{ marginTop: 4, fontSize: 12.5, color: bannerColor(msg.sev) }}>{msg.text}</p>
      )}
    </div>
  );
}
