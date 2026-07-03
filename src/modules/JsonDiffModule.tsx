import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type DiffKind = 'added' | 'removed' | 'changed' | 'typeChanged';

interface DiffRow {
  path: string;
  kind: DiffKind;
  status: string;
  detail: string;
}

interface DiffOutcome {
  parsedA: boolean;
  parsedB: boolean;
  errorA: string | null;
  errorB: string | null;
  rows: DiffRow[];
  added: number;
  removed: number;
  changed: number;
  ok: boolean;
}

// --- JSON value-kind helpers (mirror System.Text.Json JsonValueKind) ---
type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'null';
}

function scalar(v: unknown): string {
  const k = kindOf(v);
  if (k === 'string') return '"' + String(v) + '"';
  if (k === 'null') return 'null';
  return String(v);
}

function preview(v: unknown): string {
  try {
    const k = kindOf(v);
    let raw = k === 'object' || k === 'array' ? JSON.stringify(v) : scalar(v);
    raw = raw.replace(/\r/g, ' ').replace(/\n/g, ' ');
    const max = 120;
    return raw.length > max ? raw.slice(0, max) + '…' : raw;
  } catch {
    return '';
  }
}

// Order-independent canonical form for multiset array matching.
function canonical(v: unknown): string {
  const k = kindOf(v);
  if (k === 'object') {
    const obj = v as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((name) => JSON.stringify(name) + ':' + canonical(obj[name]));
    return '{' + parts.join(',') + '}';
  }
  if (k === 'array') {
    return '[' + (v as unknown[]).map(canonical).join(',') + ']';
  }
  return JSON.stringify(v);
}

function scalarEqual(a: unknown, b: unknown): boolean {
  const k = kindOf(a);
  if (k === 'string') return a === b;
  if (k === 'number') return String(a) === String(b);
  if (k === 'boolean' || k === 'null') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Labels {
  typeChanged: string;
  changed: string;
  removed: string;
  added: string;
}

function walk(path: string, a: unknown, b: unknown, ignoreOrder: boolean, rows: DiffRow[], L: Labels): void {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    rows.push({ path, kind: 'typeChanged', status: L.typeChanged, detail: `${ka} → ${kb}` });
    return;
  }
  if (ka === 'object') {
    walkObject(path, a as Record<string, unknown>, b as Record<string, unknown>, ignoreOrder, rows, L);
  } else if (ka === 'array') {
    if (ignoreOrder) walkArrayMultiset(path, a as unknown[], b as unknown[], rows, L);
    else walkArrayOrdered(path, a as unknown[], b as unknown[], ignoreOrder, rows, L);
  } else {
    if (!scalarEqual(a, b)) {
      rows.push({ path, kind: 'changed', status: L.changed, detail: `${scalar(a)} → ${scalar(b)}` });
    }
  }
}

function walkObject(
  path: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  ignoreOrder: boolean,
  rows: DiffRow[],
  L: Labels,
): void {
  const seen = new Set<string>();
  for (const name of Object.keys(a)) {
    seen.add(name);
    const child = path + '.' + name;
    if (Object.prototype.hasOwnProperty.call(b, name)) {
      walk(child, a[name], b[name], ignoreOrder, rows, L);
    } else {
      rows.push({ path: child, kind: 'removed', status: L.removed, detail: preview(a[name]) });
    }
  }
  for (const name of Object.keys(b)) {
    if (seen.has(name)) continue;
    rows.push({ path: path + '.' + name, kind: 'added', status: L.added, detail: preview(b[name]) });
  }
}

function walkArrayOrdered(path: string, a: unknown[], b: unknown[], ignoreOrder: boolean, rows: DiffRow[], L: Labels): void {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const child = `${path}[${i}]`;
    if (i >= a.length) {
      rows.push({ path: child, kind: 'added', status: L.added, detail: preview(b[i]) });
    } else if (i >= b.length) {
      rows.push({ path: child, kind: 'removed', status: L.removed, detail: preview(a[i]) });
    } else {
      walk(child, a[i], b[i], ignoreOrder, rows, L);
    }
  }
}

function walkArrayMultiset(path: string, a: unknown[], b: unknown[], rows: DiffRow[], L: Labels): void {
  const bItems = b.map(canonical);
  const used = new Array<boolean>(bItems.length).fill(false);
  let idx = 0;
  for (const av of a) {
    const ac = canonical(av);
    let match = -1;
    for (let j = 0; j < bItems.length; j++) {
      if (!used[j] && bItems[j] === ac) {
        match = j;
        break;
      }
    }
    if (match >= 0) used[match] = true;
    else rows.push({ path: `${path}[${idx}]`, kind: 'removed', status: L.removed, detail: preview(av) });
    idx++;
  }
  let bIdx = 0;
  for (const bv of b) {
    if (!used[bIdx]) rows.push({ path: `${path}[+${bIdx}]`, kind: 'added', status: L.added, detail: preview(bv) });
    bIdx++;
  }
}

function compare(a: string, b: string, ignoreOrder: boolean, L: Labels): DiffOutcome {
  let valA: unknown;
  let valB: unknown;
  let parsedA = false;
  let parsedB = false;
  let errorA: string | null = null;
  let errorB: string | null = null;
  try {
    valA = JSON.parse(a ?? '');
    parsedA = true;
  } catch (e) {
    errorA = e instanceof Error ? e.message : String(e);
  }
  try {
    valB = JSON.parse(b ?? '');
    parsedB = true;
  } catch (e) {
    errorB = e instanceof Error ? e.message : String(e);
  }

  if (!parsedA || !parsedB) {
    return { parsedA, parsedB, errorA, errorB, rows: [], added: 0, removed: 0, changed: 0, ok: false };
  }

  const rows: DiffRow[] = [];
  try {
    walk('$', valA, valB, ignoreOrder, rows, L);
  } catch {
    /* never throw to the UI */
  }
  const added = rows.filter((r) => r.kind === 'added').length;
  const removed = rows.filter((r) => r.kind === 'removed').length;
  const changed = rows.filter((r) => r.kind === 'changed' || r.kind === 'typeChanged').length;
  return { parsedA: true, parsedB: true, errorA: null, errorB: null, rows, added, removed, changed, ok: true };
}

const COLORS: Record<DiffKind, string> = {
  added: '#3FB950',
  removed: '#E0483B',
  changed: '#E88B1A',
  typeChanged: '#E88B1A',
};

const SAMPLE_A = '{\n  "name": "WinForge",\n  "version": 1,\n  "tags": ["a", "b"],\n  "active": true\n}';
const SAMPLE_B = '{\n  "name": "WinForge",\n  "version": 2,\n  "tags": ["b", "a"],\n  "beta": false\n}';

export function JsonDiffModule() {
  const { t } = useTranslation();
  const [inputA, setInputA] = useState(SAMPLE_A);
  const [inputB, setInputB] = useState(SAMPLE_B);
  const [ignoreOrder, setIgnoreOrder] = useState(false);
  const [copied, setCopied] = useState(false);

  const labels: Labels = {
    typeChanged: t('jsondiff.statusTypeChanged'),
    changed: t('jsondiff.statusChanged'),
    removed: t('jsondiff.statusRemoved'),
    added: t('jsondiff.statusAdded'),
  };

  const outcome = useMemo(
    () => compare(inputA, inputB, ignoreOrder, labels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputA, inputB, ignoreOrder, t],
  );

  const errA = !outcome.parsedA && inputA.trim() ? t('jsondiff.invalidA', { msg: outcome.errorA ?? '' }) : '';
  const errB = !outcome.parsedB && inputB.trim() ? t('jsondiff.invalidB', { msg: outcome.errorB ?? '' }) : '';

  const summary = outcome.ok
    ? t('jsondiff.summary', { added: outcome.added, removed: outcome.removed, changed: outcome.changed })
    : t('jsondiff.waiting');

  const emptyHint = !outcome.ok
    ? inputA.trim() || inputB.trim()
      ? t('jsondiff.fixInvalid')
      : ''
    : outcome.rows.length === 0
      ? t('jsondiff.noDiff')
      : '';

  const copy = () => {
    const text =
      outcome.rows.length === 0
        ? t('jsondiff.noDifferences')
        : outcome.rows.map((r) => `${r.path}\t${r.status}\t${r.detail}`).join('\n');
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('jsondiff.blurb')}
      </p>

      <div className="io-grid">
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('jsondiff.labelA')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ fontFamily: 'Consolas, monospace', minHeight: 220 }}
            value={inputA}
            onChange={(e) => setInputA(e.target.value)}
          />
          {errA && (
            <p style={{ margin: '6px 0 0', color: '#E0483B', fontSize: 12 }}>{errA}</p>
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('jsondiff.labelB')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ fontFamily: 'Consolas, monospace', minHeight: 220 }}
            value={inputB}
            onChange={(e) => setInputB(e.target.value)}
          />
          {errB && (
            <p style={{ margin: '6px 0 0', color: '#E0483B', fontSize: 12 }}>{errB}</p>
          )}
        </div>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 12, alignItems: 'center' }}>
        <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={ignoreOrder} onChange={(e) => setIgnoreOrder(e.target.checked)} />
          <span>
            <span style={{ fontWeight: 600 }}>{t('jsondiff.ignoreOrder')}</span>
            <span className="count-note" style={{ display: 'block', fontSize: 12 }}>
              {t('jsondiff.ignoreOrderSub')}
            </span>
          </span>
        </label>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>{summary}</span>
        <button className="mini" onClick={copy}>
          {copied ? t('jsondiff.copied') : t('jsondiff.copy')}
        </button>
      </div>

      {outcome.rows.length > 0 && (
        <div className="dt-wrap" style={{ maxHeight: 420, marginTop: 8 }}>
          <table className="dt">
            <tbody>
              {outcome.rows.map((r, i) => (
                <tr key={`${r.path}-${i}`}>
                  <td style={{ fontFamily: 'Consolas, monospace', color: COLORS[r.kind], width: '32%', wordBreak: 'break-all' }}>
                    {r.path}
                  </td>
                  <td style={{ color: COLORS[r.kind], fontWeight: 600, whiteSpace: 'nowrap' }}>{r.status}</td>
                  <td style={{ fontFamily: 'Consolas, monospace', color: 'var(--text-muted, #888)', wordBreak: 'break-all' }}>
                    {r.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {emptyHint && (
        <p className="count-note" style={{ marginTop: 10 }}>
          {emptyHint}
        </p>
      )}
    </div>
  );
}
