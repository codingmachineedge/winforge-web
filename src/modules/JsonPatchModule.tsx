import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- Types -----------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type PickFn = (en: string, zh: string) => string;
type OpResult = { ok: true; output: string } | { ok: false; error: string };

// ---- JSON parsing (tolerant: strips comments + trailing commas) ------------

function stripJsonExtras(src: string): string {
  let out = '';
  let inStr = false;
  let quote = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1]!;
        i += 2;
        continue;
      }
      if (c === quote) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    // line comment
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // remove trailing commas ( , } and , ] )
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJson(text: string): Json {
  return JSON.parse(stripJsonExtras(text)) as Json;
}

// ---- Deep utilities --------------------------------------------------------

function clone<T extends Json>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(v)) out[k] = clone((v as { [k: string]: Json })[k]!);
  return out as T;
}

function deepEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== 'object') return a === b;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEquals(a[i]!, b[i]!)) return false;
    return true;
  }
  const ao = a as { [k: string]: Json };
  const bo = b as { [k: string]: Json };
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEquals(ao[k]!, bo[k]!)) return false;
  }
  return true;
}

type Kind = 'null' | 'object' | 'array' | 'value';
function kindOf(n: Json): Kind {
  if (n === null) return 'null';
  if (Array.isArray(n)) return 'array';
  if (typeof n === 'object') return 'object';
  return 'value';
}

function isObject(n: Json): n is { [k: string]: Json } {
  return n !== null && typeof n === 'object' && !Array.isArray(n);
}

// ---- JSON-Pointer helpers (RFC 6901) ---------------------------------------

const escapeToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapeToken = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~');

function splitPointer(pointer: string): string[] {
  if (!pointer) return [];
  const parts = pointer.split('/');
  // pointer starts with '/', so parts[0] is empty
  const tokens: string[] = [];
  for (let i = 1; i < parts.length; i++) tokens.push(unescapeToken(parts[i]!));
  return tokens;
}

// ---- Patch op shape --------------------------------------------------------

type PatchOp = { op: string; path: string; value?: Json; from?: string } & { [k: string]: Json | undefined };

function makeOp(op: string, path: string, value: Json | undefined): { [k: string]: Json } {
  const o: { [k: string]: Json } = { op, path };
  if (op === 'add' || op === 'replace' || op === 'test') o.value = value === undefined ? null : value;
  return o;
}

// ================= DIFF =================

function buildDiff(path: string, from: Json, to: Json, ops: { [k: string]: Json }[]): void {
  if (deepEquals(from, to)) return;

  const fromKind = kindOf(from);
  const toKind = kindOf(to);

  if (fromKind === 'object' && toKind === 'object') {
    const fo = from as { [k: string]: Json };
    const too = to as { [k: string]: Json };
    // removals & replacements/recursion
    for (const key of Object.keys(fo)) {
      const child = path + '/' + escapeToken(key);
      if (Object.prototype.hasOwnProperty.call(too, key)) buildDiff(child, fo[key]!, too[key]!, ops);
      else ops.push(makeOp('remove', child, undefined));
    }
    // additions
    for (const key of Object.keys(too)) {
      if (!Object.prototype.hasOwnProperty.call(fo, key)) ops.push(makeOp('add', path + '/' + escapeToken(key), clone(too[key]!)));
    }
  } else if (fromKind === 'array' && toKind === 'array') {
    const fa = from as Json[];
    const ta = to as Json[];
    const min = Math.min(fa.length, ta.length);
    for (let i = 0; i < min; i++) buildDiff(path + '/' + i, fa[i]!, ta[i]!, ops);
    if (ta.length > fa.length) {
      for (let i = fa.length; i < ta.length; i++) ops.push(makeOp('add', path + '/-', clone(ta[i]!)));
    } else if (fa.length > ta.length) {
      // remove from the tail backwards so indices stay valid
      for (let i = fa.length - 1; i >= ta.length; i--) ops.push(makeOp('remove', path + '/' + i, undefined));
    }
  } else {
    // scalars, or type changed → replace
    ops.push(makeOp('replace', path.length === 0 ? '' : path, clone(to)));
  }
}

function diff(sourceJson: string, targetJson: string, P: PickFn): OpResult {
  let src: Json;
  let tgt: Json;
  try {
    src = parseJson(sourceJson);
  } catch (ex) {
    return { ok: false, error: P('Source JSON is not valid: ', '來源 JSON 無效：') + (ex instanceof Error ? ex.message : String(ex)) };
  }
  try {
    tgt = parseJson(targetJson);
  } catch (ex) {
    return { ok: false, error: P('Target JSON is not valid: ', '目標 JSON 無效：') + (ex instanceof Error ? ex.message : String(ex)) };
  }
  try {
    const ops: { [k: string]: Json }[] = [];
    buildDiff('', src, tgt, ops);
    return { ok: true, output: JSON.stringify(ops, null, 2) };
  } catch (ex) {
    return { ok: false, error: P('Could not build a patch: ', '無法產生修補：') + (ex instanceof Error ? ex.message : String(ex)) };
  }
}

// ================= APPLY =================

// A mutable box so root-replacing ops can swap the whole document.
type DocBox = { doc: Json };

function resolveParent(doc: Json, tokens: string[], index: number, P: PickFn): { ok: true; parent: Json } | { ok: false; error: string } {
  let parent = doc;
  for (let t = 0; t < tokens.length - 1; t++) {
    const tok = tokens[t]!;
    if (isObject(parent)) {
      if (!Object.prototype.hasOwnProperty.call(parent, tok)) {
        return { ok: false, error: P(`Operation #${index}: path segment "${tok}" does not exist.`, `第 ${index} 個運算：路徑段 "${tok}" 唔存在。`) };
      }
      parent = parent[tok]!;
    } else if (Array.isArray(parent)) {
      const i = Number(tok);
      if (!/^\d+$/.test(tok) || i < 0 || i >= parent.length) {
        return { ok: false, error: P(`Operation #${index}: array index "${tok}" is out of range.`, `第 ${index} 個運算：陣列索引 "${tok}" 超出範圍。`) };
      }
      parent = parent[i]!;
    } else {
      return { ok: false, error: P(`Operation #${index}: cannot navigate into a non-container at "${tok}".`, `第 ${index} 個運算：唔可以進入非容器 "${tok}"。`) };
    }
  }
  return { ok: true, parent };
}

function resolve(doc: Json, path: string, index: number, P: PickFn): { ok: true; node: Json } | { ok: false; error: string } {
  let node = doc;
  const tokens = splitPointer(path);
  for (const tok of tokens) {
    if (isObject(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, tok)) {
        return { ok: false, error: P(`Operation #${index}: path "${path}" does not exist.`, `第 ${index} 個運算：路徑 "${path}" 唔存在。`) };
      }
      node = node[tok]!;
    } else if (Array.isArray(node)) {
      const i = Number(tok);
      if (!/^\d+$/.test(tok) || i < 0 || i >= node.length) {
        return { ok: false, error: P(`Operation #${index}: path "${path}" does not exist.`, `第 ${index} 個運算：路徑 "${path}" 唔存在。`) };
      }
      node = node[i]!;
    } else {
      return { ok: false, error: P(`Operation #${index}: path "${path}" does not exist.`, `第 ${index} 個運算：路徑 "${path}" 唔存在。`) };
    }
  }
  return { ok: true, node };
}

function doAdd(box: DocBox, path: string, value: Json, index: number, P: PickFn): string | null {
  const tokens = splitPointer(path);
  if (tokens.length === 0) {
    box.doc = clone(value);
    return null;
  }
  const rp = resolveParent(box.doc, tokens, index, P);
  if (!rp.ok) return rp.error;
  const parent = rp.parent;
  const last = tokens[tokens.length - 1]!;

  if (isObject(parent)) {
    parent[last] = clone(value);
    return null;
  }
  if (Array.isArray(parent)) {
    if (last === '-') {
      parent.push(clone(value));
      return null;
    }
    const i = Number(last);
    if (!/^\d+$/.test(last) || i < 0 || i > parent.length) {
      return P(`Operation #${index}: array index "${last}" is out of range for add.`, `第 ${index} 個運算：陣列索引 "${last}" 超出範圍（add）。`);
    }
    parent.splice(i, 0, clone(value));
    return null;
  }
  return P(`Operation #${index}: cannot add under a non-container at "${path}".`, `第 ${index} 個運算：唔可以喺非容器 "${path}" 加嘢。`);
}

function doRemove(box: DocBox, path: string, index: number, P: PickFn): { ok: true; removed: Json } | { ok: false; error: string } {
  const tokens = splitPointer(path);
  if (tokens.length === 0) {
    const removed = box.doc;
    box.doc = null;
    return { ok: true, removed };
  }
  const rp = resolveParent(box.doc, tokens, index, P);
  if (!rp.ok) return { ok: false, error: rp.error };
  const parent = rp.parent;
  const last = tokens[tokens.length - 1]!;

  if (isObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) {
      return { ok: false, error: P(`Operation #${index}: nothing to remove at "${path}".`, `第 ${index} 個運算："${path}" 冇嘢可以移除。`) };
    }
    const removed = parent[last]!;
    delete parent[last];
    return { ok: true, removed };
  }
  if (Array.isArray(parent)) {
    const i = Number(last);
    if (!/^\d+$/.test(last) || i < 0 || i >= parent.length) {
      return { ok: false, error: P(`Operation #${index}: array index "${last}" is out of range for remove.`, `第 ${index} 個運算：陣列索引 "${last}" 超出範圍（remove）。`) };
    }
    const removed = parent[i]!;
    parent.splice(i, 1);
    return { ok: true, removed };
  }
  return { ok: false, error: P(`Operation #${index}: cannot remove from a non-container at "${path}".`, `第 ${index} 個運算：唔可以喺非容器 "${path}" 移除。`) };
}

function doReplace(box: DocBox, path: string, value: Json, index: number, P: PickFn): string | null {
  const tokens = splitPointer(path);
  if (tokens.length === 0) {
    box.doc = clone(value);
    return null;
  }
  const rp = resolveParent(box.doc, tokens, index, P);
  if (!rp.ok) return rp.error;
  const parent = rp.parent;
  const last = tokens[tokens.length - 1]!;

  if (isObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) {
      return P(`Operation #${index}: nothing to replace at "${path}".`, `第 ${index} 個運算："${path}" 冇嘢可以取代。`);
    }
    parent[last] = clone(value);
    return null;
  }
  if (Array.isArray(parent)) {
    const i = Number(last);
    if (!/^\d+$/.test(last) || i < 0 || i >= parent.length) {
      return P(`Operation #${index}: array index "${last}" is out of range for replace.`, `第 ${index} 個運算：陣列索引 "${last}" 超出範圍（replace）。`);
    }
    parent[i] = clone(value);
    return null;
  }
  return P(`Operation #${index}: cannot replace inside a non-container at "${path}".`, `第 ${index} 個運算：唔可以喺非容器 "${path}" 取代。`);
}

function doTest(doc: Json, path: string, value: Json, index: number, P: PickFn): string | null {
  const r = resolve(doc, path, index, P);
  if (!r.ok) return r.error;
  if (!deepEquals(r.node, value)) {
    return P(`Operation #${index}: test failed at "${path}" — value did not match.`, `第 ${index} 個運算："${path}" 測試失敗 — 值唔一致。`);
  }
  return null;
}

function apply(docJson: string, patchJson: string, P: PickFn): OpResult {
  let doc: Json;
  let patchNode: Json;
  try {
    doc = parseJson(docJson);
  } catch (ex) {
    return { ok: false, error: P('Document JSON is not valid: ', '文件 JSON 無效：') + (ex instanceof Error ? ex.message : String(ex)) };
  }
  try {
    patchNode = parseJson(patchJson);
  } catch (ex) {
    return { ok: false, error: P('Patch JSON is not valid: ', '修補 JSON 無效：') + (ex instanceof Error ? ex.message : String(ex)) };
  }

  if (!Array.isArray(patchNode)) {
    return { ok: false, error: P('A patch must be a JSON array of operations.', '修補必須係一個運算陣列（JSON array）。') };
  }
  const patch = patchNode;

  const box: DocBox = { doc };
  let index = 0;
  for (const item of patch) {
    index++;
    if (!isObject(item)) {
      return { ok: false, error: P(`Operation #${index} is not an object.`, `第 ${index} 個運算唔係物件（object）。`) };
    }
    const op = item as PatchOp;

    const rawKind = typeof op.op === 'string' ? op.op.trim() : '';
    if (!rawKind) {
      return { ok: false, error: P(`Operation #${index} is missing an "op".`, `第 ${index} 個運算冇 "op"。`) };
    }
    const kind = rawKind;

    const pathVal = typeof op.path === 'string' ? op.path : null;
    if (pathVal === null) {
      return { ok: false, error: P(`Operation #${index} is missing a "path".`, `第 ${index} 個運算冇 "path"。`) };
    }
    if (pathVal.length !== 0 && pathVal[0] !== '/') {
      return { ok: false, error: P(`Operation #${index}: path "${pathVal}" must start with '/'.`, `第 ${index} 個運算：路徑 "${pathVal}" 要以 '/' 開頭。`) };
    }

    const hasValue = Object.prototype.hasOwnProperty.call(op, 'value');
    const valueOf = (): Json => (op.value === undefined ? null : op.value);

    switch (kind) {
      case 'add': {
        if (!hasValue) return { ok: false, error: P(`Operation #${index} is missing a "value".`, `第 ${index} 個運算冇 "value"。`) };
        const err = doAdd(box, pathVal, valueOf(), index, P);
        if (err) return { ok: false, error: err };
        break;
      }
      case 'remove': {
        const r = doRemove(box, pathVal, index, P);
        if (!r.ok) return { ok: false, error: r.error };
        break;
      }
      case 'replace': {
        if (!hasValue) return { ok: false, error: P(`Operation #${index} is missing a "value".`, `第 ${index} 個運算冇 "value"。`) };
        const err = doReplace(box, pathVal, valueOf(), index, P);
        if (err) return { ok: false, error: err };
        break;
      }
      case 'test': {
        if (!hasValue) return { ok: false, error: P(`Operation #${index} is missing a "value".`, `第 ${index} 個運算冇 "value"。`) };
        const err = doTest(box.doc, pathVal, valueOf(), index, P);
        if (err) return { ok: false, error: err };
        break;
      }
      case 'copy':
      case 'move': {
        const fromVal = typeof op.from === 'string' ? op.from : null;
        if (fromVal === null) {
          return { ok: false, error: P(`Operation #${index} (${kind}) is missing a "from".`, `第 ${index} 個運算（${kind}）冇 "from"。`) };
        }
        if (fromVal.length !== 0 && fromVal[0] !== '/') {
          return { ok: false, error: P(`Operation #${index}: from "${fromVal}" must start with '/'.`, `第 ${index} 個運算：from "${fromVal}" 要以 '/' 開頭。`) };
        }
        const r = resolve(box.doc, fromVal, index, P);
        if (!r.ok) return { ok: false, error: r.error };
        const copyOfMoved = clone(r.node);
        if (kind === 'move') {
          if (fromVal.length !== 0 && (pathVal === fromVal || pathVal.startsWith(fromVal + '/'))) {
            return { ok: false, error: P(`Operation #${index}: cannot move a location into itself.`, `第 ${index} 個運算：唔可以將位置移入自己入面。`) };
          }
          const rem = doRemove(box, fromVal, index, P);
          if (!rem.ok) return { ok: false, error: rem.error };
        }
        const err = doAdd(box, pathVal, copyOfMoved, index, P);
        if (err) return { ok: false, error: err };
        break;
      }
      default:
        return { ok: false, error: P(`Operation #${index}: unknown op "${kind}".`, `第 ${index} 個運算：唔識嘅 op "${kind}"。`) };
    }
  }

  return { ok: true, output: box.doc === undefined ? 'null' : JSON.stringify(box.doc, null, 2) };
}

// ---- Component -------------------------------------------------------------

const SAMPLE_LEFT = '{\n  "name": "Ada",\n  "age": 36,\n  "roles": ["admin", "dev"],\n  "active": true\n}';
const SAMPLE_RIGHT = '{\n  "name": "Ada Lovelace",\n  "age": 36,\n  "roles": ["admin", "dev", "owner"],\n  "email": "ada@example.com"\n}';

export function JsonPatchModule() {
  const { t, i18n } = useTranslation();

  const [isApply, setIsApply] = useState(false);
  const [left, setLeft] = useState(SAMPLE_LEFT);
  const [right, setRight] = useState(SAMPLE_RIGHT);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // Engine error strings carry WinForge's own bilingual P("en","粵語") pairs;
  // route them through the active language so they match the rest of the UI.
  const zh = i18n.language.startsWith('zh');
  const pick: PickFn = (en, zhStr) => (zh ? zhStr : en);

  const run = () => {
    setStatus(null);
    let r: OpResult;
    try {
      r = isApply ? apply(left, right, pick) : diff(left, right, pick);
    } catch (ex) {
      setOutput('');
      setStatus({ ok: false, msg: t('jsonpatch.unexpected') + (ex instanceof Error ? ex.message : String(ex)) });
      return;
    }
    if (r.ok) {
      setOutput(r.output);
      setStatus({ ok: true, msg: isApply ? t('jsonpatch.applied') : t('jsonpatch.generated') });
    } else {
      setOutput('');
      setStatus({ ok: false, msg: r.error });
    }
  };

  const copy = () => {
    if (!output) {
      setStatus({ ok: false, msg: t('jsonpatch.nothingToCopy') });
      return;
    }
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('jsonpatch.copied') });
  };

  const swapMode = (v: boolean) => {
    setIsApply(v);
    setStatus(null);
  };

  const leftLabel = isApply ? t('jsonpatch.docLabel') : t('jsonpatch.sourceLabel');
  const rightLabel = isApply ? t('jsonpatch.patchLabel') : t('jsonpatch.targetLabel');
  const runLabel = isApply ? t('jsonpatch.applyBtn') : t('jsonpatch.generateBtn');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('jsonpatch.blurb')}</p>

      <div className="mod-toolbar">
        <span className="count-note">{t('jsonpatch.mode')}</span>
        <select className="mod-select" value={isApply ? 'apply' : 'diff'} onChange={(e) => swapMode(e.target.value === 'apply')}>
          <option value="diff">{t('jsonpatch.modeDiff')}</option>
          <option value="apply">{t('jsonpatch.modeApply')}</option>
        </select>
        <button className="mini primary" onClick={run}>{runLabel}</button>
        <button className="mini" disabled={!output} onClick={copy}>{t('jsonpatch.copyBtn')}</button>
      </div>

      <div className="io-grid">
        <div>
          <div className="count-note" style={{ marginBottom: 4, fontWeight: 600 }}>{leftLabel}</div>
          <textarea className="hosts-edit" spellCheck={false} value={left} onChange={(e) => setLeft(e.target.value)} placeholder={leftLabel} />
        </div>
        <div>
          <div className="count-note" style={{ marginBottom: 4, fontWeight: 600 }}>{rightLabel}</div>
          <textarea className="hosts-edit" spellCheck={false} value={right} onChange={(e) => setRight(e.target.value)} placeholder={rightLabel} />
        </div>
      </div>

      <div className="count-note" style={{ marginTop: 12, marginBottom: 4, fontWeight: 600 }}>{t('jsonpatch.output')}</div>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('jsonpatch.outputPlaceholder')} style={{ minHeight: 180 }} />

      {status ? (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </p>
      ) : (
        <p className="count-note" style={{ marginTop: 10 }}>{t('jsonpatch.hint')}</p>
      )}
    </div>
  );
}
