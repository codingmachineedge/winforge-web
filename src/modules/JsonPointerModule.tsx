import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- RFC 6901 helpers (ported from WinForge/Services/JsonPointerService.cs) ----

type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function typeName(node: unknown): JsonType {
  if (node === null) return 'null';
  if (Array.isArray(node)) return 'array';
  const t = typeof node;
  if (t === 'object') return 'object';
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  return 'number';
}

// Unescape a single reference token: ~1 -> /, ~0 -> ~. A '~' not followed by 0/1 is invalid.
function tryUnescape(raw: string): { ok: true; value: string } | { ok: false; why: string } {
  if (raw.indexOf('~') < 0) return { ok: true, value: raw };
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '~') {
      if (i + 1 >= raw.length) return { ok: false, why: "dangling '~' escape in token" };
      const n = raw[++i]!;
      if (n === '0') out += '~';
      else if (n === '1') out += '/';
      else return { ok: false, why: `invalid escape "~${n}" (only ~0 and ~1 are allowed)` };
    } else out += c;
  }
  return { ok: true, value: out };
}

// Split a pointer string into reference tokens, applying ~1->/ and ~0->~ unescaping.
function tryParseTokens(pointer: string): { ok: true; tokens: string[] } | { ok: false; why: string } {
  if (pointer.length === 0) return { ok: true, tokens: [] }; // "" = whole document
  if (pointer[0] !== '/') return { ok: false, why: "a non-empty pointer must start with '/'" };
  const parts = pointer.split('/');
  const tokens: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const u = tryUnescape(parts[i]!);
    if (!u.ok) return { ok: false, why: u.why };
    tokens.push(u.value);
  }
  return { ok: true, tokens };
}

// RFC 6901 array index: "0" or a non-negative integer with no leading zeros.
function tryArrayIndex(token: string): number | null {
  if (token.length === 0) return null;
  if (token === '0') return 0;
  if (token[0] === '0') return null; // no leading zeros
  for (const c of token) if (c < '0' || c > '9') return null;
  return Number.parseInt(token, 10);
}

// Escape a member name for embedding into a pointer: ~ -> ~0, / -> ~1.
function escapeToken(member: string): string {
  return member.replace(/~/g, '~0').replace(/\//g, '~1');
}

interface ResolveResult {
  ok: boolean;
  invalidJson: boolean;
  badPointer: boolean;
  notFound: boolean;
  pretty?: string;
  valueType?: JsonType;
  detail?: string;
}

function resolvePointer(json: string, pointer: string): ResolveResult {
  let root: unknown;
  try {
    root = JSON.parse(json.length === 0 ? '""' : json);
  } catch (e) {
    return { ok: false, invalidJson: true, badPointer: false, notFound: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (json.length === 0) {
    // treat truly empty input as invalid so the user gets a clear message
    return { ok: false, invalidJson: true, badPointer: false, notFound: false, detail: 'empty document' };
  }

  const parsed = tryParseTokens(pointer);
  if (!parsed.ok) return { ok: false, invalidJson: false, badPointer: true, notFound: false, detail: parsed.why };

  let cur: unknown = root;
  for (const token of parsed.tokens) {
    if (cur === null) {
      return { ok: false, invalidJson: false, badPointer: false, notFound: true, detail: `cannot index into null at token "${token}"` };
    }
    if (Array.isArray(cur)) {
      if (token === '-') {
        return { ok: false, invalidJson: false, badPointer: true, notFound: false, detail: '"-" (end-of-array) is not resolvable for reads' };
      }
      const idx = tryArrayIndex(token);
      if (idx === null || idx < 0 || idx >= cur.length) {
        return { ok: false, invalidJson: false, badPointer: false, notFound: true, detail: `array index "${token}" out of range (count ${cur.length})` };
      }
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      const obj = cur as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, token)) {
        cur = obj[token];
      } else {
        return { ok: false, invalidJson: false, badPointer: false, notFound: true, detail: `no member "${token}"` };
      }
    } else {
      return { ok: false, invalidJson: false, badPointer: false, notFound: true, detail: `cannot descend into a scalar at token "${token}"` };
    }
  }

  const vt = typeName(cur);
  let pretty: string;
  try {
    pretty = cur === undefined ? 'null' : JSON.stringify(cur, null, 2);
  } catch {
    pretty = String(cur);
  }
  return { ok: true, invalidJson: false, badPointer: false, notFound: false, pretty, valueType: vt };
}

interface PointerEntry {
  pointer: string;
  valueType: JsonType;
  preview: string;
}

function preview(node: unknown): string {
  try {
    if (node === null) return 'null';
    let s: string;
    if (Array.isArray(node)) s = `[ ${node.length} item(s) ]`;
    else if (typeof node === 'object') s = `{ ${Object.keys(node as object).length} member(s) }`;
    else s = JSON.stringify(node);
    s = s.replace(/[\r\n]/g, ' ');
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  } catch {
    return '';
  }
}

function walk(node: unknown, prefix: string, sink: PointerEntry[]): void {
  if (sink.length > 20000) return; // safety cap against pathological documents
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const ptr = prefix + '/' + i;
      const child = node[i];
      sink.push({ pointer: ptr, valueType: typeName(child), preview: preview(child) });
      walk(child, ptr, sink);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const ptr = prefix + '/' + escapeToken(key);
      sink.push({ pointer: ptr, valueType: typeName(value), preview: preview(value) });
      walk(value, ptr, sink);
    }
  }
}

interface WalkResult {
  invalidJson: boolean;
  detail?: string;
  entries: PointerEntry[];
}

function listAllPointers(json: string): WalkResult {
  let root: unknown;
  try {
    root = JSON.parse(json.length === 0 ? '""' : json);
  } catch (e) {
    return { invalidJson: true, detail: e instanceof Error ? e.message : String(e), entries: [] };
  }
  if (json.length === 0) return { invalidJson: true, detail: 'empty document', entries: [] };
  const entries: PointerEntry[] = [];
  // The whole document is always a valid pointer ("").
  entries.push({ pointer: '', valueType: typeName(root), preview: preview(root) });
  try {
    walk(root, '', entries);
  } catch {
    /* never throw — return whatever we gathered */
  }
  return { invalidJson: false, entries };
}

const SAMPLE = `{
  "name": "WinForge",
  "tags": ["a", "b", "c"],
  "nested": { "x": 1, "y": [true, null, 3.5] },
  "a/b": "slash key",
  "m~n": "tilde key"
}`;

export function JsonPointerModule() {
  const { t } = useTranslation();
  const [doc, setDoc] = useState(SAMPLE);
  const [pointer, setPointer] = useState('/nested/y/2');
  const [pointers, setPointers] = useState<PointerEntry[] | null>(null);
  const [listMsg, setListMsg] = useState('');
  const [copyMsg, setCopyMsg] = useState('');

  const res = useMemo(() => resolvePointer(doc, pointer), [doc, pointer]);

  const loadSample = () => {
    setDoc(SAMPLE);
    if (!pointer.trim()) setPointer('/nested/y/2');
  };

  const doList = () => {
    const r = listAllPointers(doc);
    if (r.invalidJson) {
      setPointers([]);
      setListMsg(t('jsonpointer.invalidNothing'));
      return;
    }
    setPointers(r.entries);
    setListMsg(t('jsonpointer.count', { count: r.entries.length }));
  };

  const copyValue = () => {
    if (!res.ok || !res.pretty) return;
    void navigator.clipboard?.writeText(res.pretty);
    setCopyMsg(t('jsonpointer.copied'));
  };

  const clickRow = (entry: PointerEntry) => {
    void navigator.clipboard?.writeText(entry.pointer);
    setPointer(entry.pointer);
    setCopyMsg(t('jsonpointer.copied'));
  };

  // Bilingual result banner state
  let barKind: 'error' | 'warn' | 'ok';
  let barTitle: string;
  let barMsg: string;
  if (res.invalidJson) {
    barKind = 'error';
    barTitle = t('jsonpointer.invalidJson');
    barMsg = t('jsonpointer.invalidJsonMsg');
  } else if (res.badPointer) {
    barKind = 'warn';
    barTitle = t('jsonpointer.invalidPointer');
    barMsg = t('jsonpointer.invalidPointerMsg');
  } else if (res.notFound) {
    barKind = 'warn';
    barTitle = t('jsonpointer.notFound');
    barMsg = t('jsonpointer.notFoundMsg');
  } else {
    barKind = 'ok';
    barTitle = t('jsonpointer.resolved');
    barMsg = t('jsonpointer.resolvedMsg');
  }
  const fullMsg = res.detail ? `${barMsg}  (${res.detail})` : barMsg;
  const typeLine = res.ok && res.valueType ? t('jsonpointer.typeLine', { type: res.valueType }) : '';

  const barColor = barKind === 'error' ? 'var(--danger)' : barKind === 'warn' ? '#c98a00' : 'var(--accent, #2e7d32)';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('jsonpointer.blurb')}
      </p>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        {t('jsonpointer.docLabel')}
      </label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ width: '100%', minHeight: 150 }}
        value={doc}
        onChange={(e) => setDoc(e.target.value)}
      />

      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" onClick={loadSample}>
          {t('jsonpointer.loadSample')}
        </button>
        <button className="mini primary" onClick={doList}>
          {t('jsonpointer.listAll')}
        </button>
      </div>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginTop: 12, marginBottom: 4 }}>
        {t('jsonpointer.pointerLabel')}
      </label>
      <input
        className="mod-search"
        style={{ width: '100%', fontFamily: 'monospace' }}
        placeholder="/a/b/0"
        value={pointer}
        onChange={(e) => setPointer(e.target.value)}
      />

      <div className="mod-toolbar" style={{ marginTop: 14, alignItems: 'baseline' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('jsonpointer.resultTitle')}</div>
          {typeLine && <div className="count-note" style={{ marginTop: 1 }}>{typeLine}</div>}
        </div>
        <button className="mini" disabled={!res.ok} onClick={copyValue}>
          {t('jsonpointer.copyValue')}
        </button>
      </div>

      <div
        style={{
          marginTop: 8,
          padding: '8px 12px',
          borderRadius: 6,
          borderLeft: `3px solid ${barColor}`,
          background: 'var(--surface-2, rgba(127,127,127,0.08))',
          fontSize: 13,
        }}
      >
        <strong style={{ color: barColor }}>{barTitle}</strong>
        <span style={{ marginLeft: 8 }}>{fullMsg}</span>
      </div>

      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        style={{ width: '100%', minHeight: 90, marginTop: 8, whiteSpace: 'pre', fontFamily: 'monospace' }}
        value={res.ok ? res.pretty ?? '' : ''}
      />
      {copyMsg && (
        <p className="count-note" style={{ marginTop: 8 }}>
          {copyMsg}
        </p>
      )}

      {pointers !== null && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('jsonpointer.allTitle')}</div>
          <p className="count-note" style={{ marginTop: 2 }}>
            {listMsg || t('jsonpointer.listHint')}
          </p>
          {pointers.length > 0 && (
            <div className="dt-wrap" style={{ maxHeight: 360 }}>
              <table className="dt">
                <tbody>
                  {pointers.map((entry, i) => (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => clickRow(entry)}>
                      <td>
                        <code>{entry.pointer.length === 0 ? '""' : entry.pointer}</code>
                        <div className="count-note" style={{ marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
                          {entry.preview}
                        </div>
                      </td>
                      <td className="env-val" style={{ whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        {entry.valueType}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
