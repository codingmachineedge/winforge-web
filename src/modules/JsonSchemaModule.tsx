import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ─── JSON Schema validator (draft-07 practical subset) ─────────────────────────
// Hand-written port of WinForge's JsonSchemaService — no external deps, pure Web
// APIs. Validates a JSON document against a schema and reports each violation with
// a JSON-Pointer path. Never throws from validate(); malformed JSON is surfaced as
// a structured result.

type Pick = (en: string, zh: string) => string;

interface Violation {
  path: string;
  message: string;
}

interface ValidateResult {
  schemaOk: boolean;
  documentOk: boolean;
  valid: boolean;
  schemaError: string | null;
  documentError: string | null;
  violations: Violation[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const isObject = (v: unknown): v is { [k: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ─── Parsing ───────────────────────────────────────────────────────────────────
// JSON.parse is stricter than System.Text.Json (no comments / trailing commas),
// but our sample and typical inputs are clean. We strip // and /* */ comments and
// trailing commas defensively to mirror the C# JsonDocumentOptions.

function stripJsonExtras(text: string): string {
  let out = '';
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // remove trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseNode(json: string): { ok: true; value: JsonValue } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(stripJsonExtras(json ?? '')) as JsonValue };
  } catch (error) {
    return { ok: false, error };
  }
}

const looksLikeNullLiteral = (s: string): boolean => (s ?? '').trim() === 'null';

// ─── Validation context ──────────────────────────────────────────────────────
class Context {
  readonly root: JsonValue;
  readonly pick: Pick;
  readonly violations: Violation[] = [];
  private depth = 0;

  constructor(root: JsonValue, pick: Pick) {
    this.root = root;
    this.pick = pick;
  }

  P(en: string, zh: string): string {
    return this.pick(en, zh);
  }

  add(path: string, message: string): void {
    this.violations.push({ path: path ? path : '/', message });
  }

  enter(): void {
    this.depth++;
    if (this.depth > 128) throw new Error('schema too deeply nested');
  }

  leave(): void {
    this.depth--;
  }
}

// ─── Core recursive validation ─────────────────────────────────────────────────
function validateNode(node: JsonValue, schema: JsonValue, path: string, ctx: Context): void {
  ctx.enter();
  try {
    // Boolean schemas: true = anything, false = nothing.
    if (typeof schema === 'boolean') {
      if (!schema) ctx.add(path, ctx.P("No value is allowed here (schema is 'false').", '呢度唔容許任何值（結構描述為 false）。'));
      return;
    }

    if (!isObject(schema)) return; // unknown schema form → permissive

    // $ref resolution (to #/definitions or #/$defs).
    const refRaw = schema['$ref'];
    if (typeof refRaw === 'string' && refRaw.trim() !== '') {
      const resolved = resolveRef(refRaw, ctx.root);
      if (resolved === undefined) {
        ctx.add(path, ctx.P(`Unresolved $ref '${refRaw}'.`, `解析唔到 $ref「${refRaw}」。`));
        return;
      }
      validateNode(node, resolved, path, ctx);
      return;
    }

    // const
    if ('const' in schema) {
      if (!jsonEquals(node, schema['const']!)) {
        ctx.add(path, ctx.P(`Value must equal the const ${render(schema['const']!)}.`, `個值必須等於常數 ${render(schema['const']!)}。`));
      }
    }

    // enum
    const enumNode = schema['enum'];
    if (Array.isArray(enumNode)) {
      const matched = enumNode.some((e) => jsonEquals(node, e));
      if (!matched) {
        ctx.add(path, ctx.P(`Value must be one of the allowed enum values: ${renderList(enumNode)}.`, `個值必須係列舉之一：${renderList(enumNode)}。`));
      }
    }

    // type
    const actual = typeName(node);
    const declared = readTypes(schema['type']);
    if (declared.length > 0) {
      const ok = declared.some((typ) => typeMatches(typ, node, actual));
      if (!ok) {
        const want = declared.join(' / ');
        ctx.add(path, ctx.P(`Expected type ${want} but got ${actual}.`, `預期類型 ${want}，但實際係 ${actual}。`));
        // type mismatch — further keyword checks would be noisy, so stop here.
        return;
      }
    }

    if (isObject(node)) validateObject(node, schema, path, ctx);
    else if (Array.isArray(node)) validateArray(node, schema, path, ctx);
    else validateScalar(node, schema, path, ctx);
  } finally {
    ctx.leave();
  }
}

function validateObject(obj: { [k: string]: JsonValue }, sObj: { [k: string]: JsonValue }, path: string, ctx: Context): void {
  const propsNode = sObj['properties'];
  const props = isObject(propsNode) ? propsNode : null;

  // required
  const req = sObj['required'];
  if (Array.isArray(req)) {
    for (const rn of req) {
      if (typeof rn === 'string' && !(rn in obj)) {
        ctx.add(join(path, rn), ctx.P(`Required property '${rn}' is missing.`, `缺少必填屬性「${rn}」。`));
      }
    }
  }

  // minProperties / maxProperties
  const keys = Object.keys(obj);
  const count = keys.length;
  const minP = tryInt(sObj['minProperties']);
  if (minP !== null && count < minP) {
    ctx.add(path, ctx.P(`Object has ${count} properties but at least ${minP} are required.`, `物件得 ${count} 個屬性，最少要 ${minP} 個。`));
  }
  const maxP = tryInt(sObj['maxProperties']);
  if (maxP !== null && count > maxP) {
    ctx.add(path, ctx.P(`Object has ${count} properties but at most ${maxP} are allowed.`, `物件有 ${count} 個屬性，最多只准 ${maxP} 個。`));
  }

  // properties
  if (props) {
    for (const key of keys) {
      const pSchema = props[key];
      if (pSchema !== undefined) validateNode(obj[key]!, pSchema, join(path, key), ctx);
    }
  }

  // additionalProperties: false (or a schema)
  const ap = sObj['additionalProperties'];
  if (ap === false) {
    for (const key of keys) {
      const known = props !== null && key in props;
      if (!known) ctx.add(join(path, key), ctx.P(`Additional property '${key}' is not allowed.`, `唔准有額外屬性「${key}」。`));
    }
  } else if (isObject(ap)) {
    for (const key of keys) {
      const known = props !== null && key in props;
      if (!known) validateNode(obj[key]!, ap, join(path, key), ctx);
    }
  }
}

function validateArray(arr: JsonValue[], sObj: { [k: string]: JsonValue }, path: string, ctx: Context): void {
  const count = arr.length;
  const mn = tryInt(sObj['minItems']);
  if (mn !== null && count < mn) {
    ctx.add(path, ctx.P(`Array has ${count} items but at least ${mn} are required.`, `陣列得 ${count} 個項目，最少要 ${mn} 個。`));
  }
  const mx = tryInt(sObj['maxItems']);
  if (mx !== null && count > mx) {
    ctx.add(path, ctx.P(`Array has ${count} items but at most ${mx} are allowed.`, `陣列有 ${count} 個項目，最多只准 ${mx} 個。`));
  }

  if (sObj['uniqueItems'] === true) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (jsonEquals(arr[i]!, arr[j]!)) {
          ctx.add(join(path, String(j)), ctx.P(`Duplicate item — items must be unique (matches index ${i}).`, `重複項目 — 各項必須唯一（同索引 ${i} 相同）。`));
        }
      }
    }
  }

  // items: single schema applied to every element (tuple form not supported).
  const itemsSchema = sObj['items'];
  if (itemsSchema !== undefined && !Array.isArray(itemsSchema)) {
    for (let i = 0; i < arr.length; i++) {
      validateNode(arr[i]!, itemsSchema, join(path, String(i)), ctx);
    }
  }
}

function validateScalar(val: JsonValue, sObj: { [k: string]: JsonValue }, path: string, ctx: Context): void {
  // string constraints
  if (typeof val === 'string') {
    const len = val.length;
    const mn = tryInt(sObj['minLength']);
    if (mn !== null && len < mn) {
      ctx.add(path, ctx.P(`String length ${len} is below the minimum of ${mn}.`, `字串長度 ${len} 少過最小值 ${mn}。`));
    }
    const mx = tryInt(sObj['maxLength']);
    if (mx !== null && len > mx) {
      ctx.add(path, ctx.P(`String length ${len} exceeds the maximum of ${mx}.`, `字串長度 ${len} 超過最大值 ${mx}。`));
    }

    const patNode = sObj['pattern'];
    if (typeof patNode === 'string' && patNode !== '') {
      try {
        const re = new RegExp(patNode);
        if (!re.test(val)) ctx.add(path, ctx.P(`String does not match pattern /${patNode}/.`, `字串唔符合規則式 /${patNode}/。`));
      } catch {
        ctx.add(path, ctx.P(`Schema pattern /${patNode}/ is not a valid regular expression.`, `結構描述嘅規則式 /${patNode}/ 唔係有效嘅正規表示式。`));
      }
    }
  }

  // numeric constraints
  if (typeof val === 'number') {
    const num = val;
    const min = tryNum(sObj['minimum']);
    if (min !== null && num < min) {
      ctx.add(path, ctx.P(`Value ${trim(num)} is below the minimum of ${trim(min)}.`, `個值 ${trim(num)} 細過最小值 ${trim(min)}。`));
    }
    const max = tryNum(sObj['maximum']);
    if (max !== null && num > max) {
      ctx.add(path, ctx.P(`Value ${trim(num)} exceeds the maximum of ${trim(max)}.`, `個值 ${trim(num)} 大過最大值 ${trim(max)}。`));
    }
    const exmin = tryNum(sObj['exclusiveMinimum']);
    if (exmin !== null && num <= exmin) {
      ctx.add(path, ctx.P(`Value ${trim(num)} must be greater than ${trim(exmin)}.`, `個值 ${trim(num)} 必須大過 ${trim(exmin)}。`));
    }
    const exmax = tryNum(sObj['exclusiveMaximum']);
    if (exmax !== null && num >= exmax) {
      ctx.add(path, ctx.P(`Value ${trim(num)} must be less than ${trim(exmax)}.`, `個值 ${trim(num)} 必須細過 ${trim(exmax)}。`));
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function resolveRef(reference: string, root: JsonValue): JsonValue | undefined {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  const parts = reference.substring(2).split('/');
  let cur: JsonValue = root;
  for (const raw of parts) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (isObject(cur) && token in cur) cur = cur[token]!;
    else return undefined;
  }
  return cur;
}

function readTypes(typeNode: JsonValue | undefined): string[] {
  const list: string[] = [];
  if (typeof typeNode === 'string') list.push(typeNode);
  else if (Array.isArray(typeNode)) {
    for (const e of typeNode) if (typeof e === 'string') list.push(e);
  }
  return list;
}

function typeMatches(declared: string, node: JsonValue, actual: string): boolean {
  switch (declared) {
    case 'integer':
      return typeof node === 'number' && Number.isFinite(node) && Math.floor(node) === node;
    case 'number':
      return actual === 'integer' || actual === 'number';
    default:
      return declared === actual;
  }
}

function typeName(node: JsonValue): string {
  if (node === null) return 'null';
  if (Array.isArray(node)) return 'array';
  if (typeof node === 'object') return 'object';
  if (typeof node === 'boolean') return 'boolean';
  if (typeof node === 'number') return Number.isFinite(node) && Math.floor(node) === node ? 'integer' : 'number';
  if (typeof node === 'string') return 'string';
  return 'unknown';
}

function tryNum(node: JsonValue | undefined): number | null {
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

function tryInt(node: JsonValue | undefined): number | null {
  const d = tryNum(node);
  return d === null ? null : Math.trunc(d);
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEquals(a[i]!, b[i]!)) return false;
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in b)) return false;
      if (!jsonEquals(a[k]!, b[k]!)) return false;
    }
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (isObject(a) !== isObject(b)) return false;
  return a === b;
}

function render(node: JsonValue): string {
  if (node === null) return 'null';
  try {
    return JSON.stringify(node);
  } catch {
    return String(node);
  }
}

function renderList(arr: JsonValue[]): string {
  return arr.map(render).join(', ');
}

function trim(d: number): string {
  // mirror C# "0.######" — up to 6 decimals, no trailing zeros
  return parseFloat(d.toFixed(6)).toString();
}

function join(basePath: string, token: string): string {
  const escaped = token.replace(/~/g, '~0').replace(/\//g, '~1');
  return basePath + '/' + escaped;
}

// ─── Top-level validate ─────────────────────────────────────────────────────────
function validate(schemaJson: string, documentJson: string, pick: Pick): ValidateResult {
  const result: ValidateResult = {
    schemaOk: false,
    documentOk: false,
    valid: false,
    schemaError: null,
    documentError: null,
    violations: [],
  };

  const schemaParse = parseNode(schemaJson);
  let schema: JsonValue = null;
  if (schemaParse.ok) {
    schema = schemaParse.value;
    if (schema === null && !looksLikeNullLiteral(schemaJson)) {
      result.schemaError = pick('Schema is empty.', '結構描述係空白嘅。');
    } else {
      result.schemaOk = true;
    }
  } else {
    const msg = schemaParse.error instanceof Error ? schemaParse.error.message : String(schemaParse.error);
    result.schemaError = pick(`Schema is not valid JSON: ${msg}`, `結構描述唔係有效嘅 JSON：${msg}`);
  }

  const docParse = parseNode(documentJson);
  let doc: JsonValue = null;
  if (docParse.ok) {
    doc = docParse.value;
    result.documentOk = true;
  } else {
    const msg = docParse.error instanceof Error ? docParse.error.message : String(docParse.error);
    result.documentError = pick(`Document is not valid JSON: ${msg}`, `文件唔係有效嘅 JSON：${msg}`);
  }

  if (!result.schemaOk || !result.documentOk) return result;

  const ctx = new Context(schema, pick);
  try {
    validateNode(doc, schema, '', ctx);
  } catch (ex) {
    const msg = ex instanceof Error ? ex.message : String(ex);
    ctx.add('', pick(`Internal validation error: ${msg}`, `驗證期間發生內部錯誤：${msg}`));
  }

  result.violations = ctx.violations;
  result.valid = ctx.violations.length === 0 && result.schemaOk && result.documentOk;
  return result;
}

// ─── Sample schema + document ────────────────────────────────────────────────────
function sample(): { schema: string; doc: string } {
  const schema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["name", "age", "role"],
  "additionalProperties": false,
  "properties": {
    "name":  { "type": "string", "minLength": 2, "maxLength": 40 },
    "age":   { "type": "integer", "minimum": 0, "maximum": 130 },
    "email": { "type": "string", "pattern": "^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$" },
    "role":  { "enum": ["admin", "user", "guest"] },
    "tags":  { "type": "array", "items": { "type": "string" }, "uniqueItems": true, "maxItems": 5 },
    "manager": { "$ref": "#/definitions/person" }
  },
  "definitions": {
    "person": {
      "type": "object",
      "required": ["name"],
      "properties": { "name": { "type": "string" } }
    }
  }
}`;

  const doc = `{
  "name": "A",
  "age": 200,
  "email": "not-an-email",
  "role": "superuser",
  "tags": ["x", "x"],
  "nickname": "oops",
  "manager": { "age": 40 }
}`;

  return { schema, doc };
}

// ─── Finding row type ─────────────────────────────────────────────────────────────
type BadgeKind = 'schema' | 'doc' | 'fail' | 'pass';
interface Finding {
  kind: BadgeKind;
  badge: string;
  path: string;
  message: string;
}

const BADGE_COLOR: Record<BadgeKind, string> = {
  schema: '#B58A00', // amber (warn)
  doc: '#B58A00', // amber (warn)
  fail: '#C42B1C', // red
  pass: '#2EA043', // green
};

type VerdictKind = 'warn' | 'pass' | 'fail' | 'error';
const VERDICT_COLOR: Record<VerdictKind, string> = {
  warn: '#B58A00',
  pass: '#2EA043',
  fail: '#C42B1C',
  error: '#B58A00',
};

// ─── Component ─────────────────────────────────────────────────────────────────
export function JsonSchemaModule() {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  const pick: Pick = (en, zh) => (isZh ? zh : en);

  const [schemaText, setSchemaText] = useState('');
  const [docText, setDocText] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [verdict, setVerdict] = useState<{ kind: VerdictKind; text: string; sub: string } | null>(null);
  const [copied, setCopied] = useState('');

  const runValidate = () => {
    setCopied('');
    try {
      const rows: Finding[] = [];
      const result = validate(schemaText ?? '', docText ?? '', pick);

      // Surface JSON-parse problems up top.
      if (!result.schemaOk && result.schemaError !== null) {
        rows.push({ kind: 'schema', badge: t('jsonschema.badgeSchema'), path: '/', message: result.schemaError });
      }
      if (!result.documentOk && result.documentError !== null) {
        rows.push({ kind: 'doc', badge: t('jsonschema.badgeDoc'), path: '/', message: result.documentError });
      }

      for (const v of result.violations) {
        rows.push({ kind: 'fail', badge: t('jsonschema.badgeFail'), path: v.path, message: v.message });
      }

      if (!result.schemaOk || !result.documentOk) {
        setVerdict({ kind: 'error', text: t('jsonschema.verdictCould'), sub: t('jsonschema.verdictCouldSub') });
      } else if (result.valid) {
        setVerdict({ kind: 'pass', text: t('jsonschema.verdictPass'), sub: t('jsonschema.verdictPassSub') });
        rows.push({ kind: 'pass', badge: t('jsonschema.badgePass'), path: '/', message: t('jsonschema.noViolations') });
      } else {
        setVerdict({
          kind: 'fail',
          text: t('jsonschema.verdictFail', { n: result.violations.length }),
          sub: t('jsonschema.verdictFailSub'),
        });
      }

      setFindings(rows);
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : String(ex);
      setFindings([]);
      setVerdict({ kind: 'error', text: t('jsonschema.verdictError'), sub: msg });
    }
  };

  const loadSample = () => {
    const s = sample();
    setSchemaText(s.schema);
    setDocText(s.doc);
    setCopied('');
  };

  const clearAll = () => {
    setSchemaText('');
    setDocText('');
    setFindings([]);
    setVerdict(null);
    setCopied('');
  };

  const copyResults = () => {
    if (!verdict) return;
    const lines: string[] = [verdict.text];
    for (const f of findings) lines.push(`[${f.badge}] ${f.path} — ${f.message}`);
    void navigator.clipboard?.writeText(lines.join('\n'));
    setCopied(t('jsonschema.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('jsonschema.blurb')}
      </p>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={runValidate}>
          {t('jsonschema.validate')}
        </button>
        <button className="mini" onClick={loadSample}>
          {t('jsonschema.loadSample')}
        </button>
        <button className="mini" onClick={clearAll}>
          {t('jsonschema.clear')}
        </button>
        <button className="mini" disabled={!verdict} onClick={copyResults}>
          {t('jsonschema.copyResults')}
        </button>
        {copied && <span className="count-note">{copied}</span>}
      </div>

      <div className="io-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="count-note" style={{ fontWeight: 600 }}>
            {t('jsonschema.schemaLabel')}
          </span>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 280, fontFamily: 'Consolas, monospace' }}
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            placeholder={t('jsonschema.schemaPlaceholder')}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="count-note" style={{ fontWeight: 600 }}>
            {t('jsonschema.docLabel')}
          </span>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 280, fontFamily: 'Consolas, monospace' }}
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
            placeholder={t('jsonschema.docPlaceholder')}
          />
        </div>
      </div>

      {verdict && (
        <div
          style={{
            marginTop: 14,
            padding: '12px 16px',
            borderRadius: 8,
            border: '1px solid var(--border, #333)',
            background: 'var(--card-bg, rgba(127,127,127,0.08))',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 18, color: VERDICT_COLOR[verdict.kind] }}>{verdict.text}</div>
          <div className="count-note" style={{ marginTop: 2 }}>
            {verdict.sub}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, fontWeight: 600 }} className="count-note">
        {t('jsonschema.findingsLabel')}
      </div>
      <div className="dt-wrap" style={{ maxHeight: 360, marginTop: 6, border: '1px solid var(--border, #333)', borderRadius: 8 }}>
        <div className="kv-list">
          {findings.length === 0 ? (
            <div className="count-note" style={{ padding: 12 }}>
              {t('jsonschema.noFindings')}
            </div>
          ) : (
            findings.map((f, i) => (
              <div
                key={i}
                className="kv-row"
                style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 8px' }}
              >
                <span
                  style={{
                    background: BADGE_COLOR[f.kind],
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 4,
                    padding: '2px 8px',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {f.badge}
                </span>
                <code style={{ color: 'var(--text-secondary, #999)', flexShrink: 0 }}>{f.path}</code>
                <span style={{ flex: 1, wordBreak: 'break-word' }}>{f.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
