import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// ============================================================================
// Faithful port of WinForge TomlJsonService — a hand-written TOML subset
// parser/writer. Never throws: every entry point returns { ok, output, error }.
// JSON values are represented with a small tagged union so we can distinguish
// integers, floats, strings, booleans, arrays and objects (like JsonNode).
// ============================================================================

type JVal =
  | { k: 'str'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'arr'; v: JVal[] }
  | { k: 'obj'; v: JObj };

// Ordered object: keep insertion order of keys (like JsonObject).
class JObj {
  keys: string[] = [];
  map = new Map<string, JVal>();
  has(key: string): boolean {
    return this.map.has(key);
  }
  get(key: string): JVal | undefined {
    return this.map.get(key);
  }
  set(key: string, val: JVal): void {
    if (!this.map.has(key)) this.keys.push(key);
    this.map.set(key, val);
  }
  entries(): [string, JVal][] {
    return this.keys.map((k) => [k, this.map.get(k)!] as [string, JVal]);
  }
}

interface Result {
  ok: boolean;
  output: string;
  error: string | null;
}

// A tiny line cursor (mirrors the C# Cursor class).
class Cursor {
  private s: string;
  pos = 0;
  constructor(s: string) {
    this.s = s;
  }
  reset(s: string): void {
    this.s = s;
    this.pos = 0;
  }
  get eol(): boolean {
    return this.pos >= this.s.length;
  }
  peek(): string {
    return this.s[this.pos]!;
  }
  next(): string {
    return this.s[this.pos++]!;
  }
  skip(n: number): void {
    this.pos += n;
  }
  toEnd(): void {
    this.pos = this.s.length;
  }
  skipWs(): void {
    while (this.pos < this.s.length && (this.s[this.pos] === ' ' || this.s[this.pos] === '\t')) this.pos++;
  }
  slice(start: number): string {
    return this.s.substring(start, this.pos);
  }
  startsWith(tok: string): boolean {
    return this.pos + tok.length <= this.s.length && this.s.substring(this.pos, this.pos + tok.length) === tok;
  }
  charAt(i: number): string | undefined {
    return this.s[i];
  }
  get length(): number {
    return this.s.length;
  }
}

// A thrown TOML error carries the already-localised message.
class TomlError extends Error {}

function isLetterOrDigit(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

// ------------------------------------------------------------------ TOML → JSON

function tomlToJson(toml: string, t: TFunction): Result {
  try {
    const root = parseToml(toml ?? '', t);
    return { ok: true, output: jsonStringify(root, 0), error: null };
  } catch (ex) {
    if (ex instanceof TomlError) return { ok: false, output: '', error: ex.message };
    return { ok: false, output: '', error: ex instanceof Error ? ex.message : String(ex) };
  }
}

function err(t: TFunction, line: number, msgKey: string, params?: Record<string, unknown>): TomlError {
  return new TomlError(t('tomljson.errLine', { line: line + 1, msg: t(msgKey, params) }));
}

function parseToml(text: string, t: TFunction): JObj {
  const root = new JObj();
  let current = root; // current table for bare keys
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const p = new Cursor(raw);
    p.skipWs();
    if (p.eol || p.peek() === '#') continue; // blank or comment line

    const c = p.peek();
    if (c === '[') {
      const arrayOfTables = p.pos + 1 < raw.length && raw[p.pos + 1] === '[';
      p.next();
      if (arrayOfTables) p.next();
      const path = readKeyPath(p, t);
      p.skipWs();
      if (p.eol || p.peek() !== ']') throw err(t, i, 'tomljson.errUnterminatedHeader');
      p.next();
      if (arrayOfTables) {
        p.skipWs();
        if (p.eol || p.peek() !== ']') throw err(t, i, 'tomljson.errUnterminatedArrayHeader');
        p.next();
      }
      ensureTrailing(p, i, t);
      current = arrayOfTables ? descendArrayOfTables(root, path, i, t) : descendTable(root, path, i, t);
    } else {
      const path = readKeyPath(p, t);
      p.skipWs();
      if (p.eol || p.peek() !== '=') throw err(t, i, 'tomljson.errExpectedEquals');
      p.next();
      p.skipWs();
      const box = { i };
      const value = readValue(p, lines, box, t);
      i = box.i;
      ensureTrailing(p, i, t);
      assignDotted(current, path, value, i, t);
    }
  }
  return root;
}

function ensureTrailing(p: Cursor, line: number, t: TFunction): void {
  p.skipWs();
  if (!p.eol && p.peek() !== '#') throw err(t, line, 'tomljson.errTrailing');
}

// ---- key paths (dotted, quoted segments allowed) ----

function readKeyPath(p: Cursor, t: TFunction): string[] {
  const parts: string[] = [];
  for (;;) {
    p.skipWs();
    if (p.eol) throw new TomlError(t('tomljson.errEndOfKey'));
    const c = p.peek();
    let part: string;
    if (c === '"') part = readBasicString(p, t);
    else if (c === "'") part = readLiteralString(p, t);
    else part = readBareKey(p, t);
    parts.push(part);
    p.skipWs();
    if (!p.eol && p.peek() === '.') {
      p.next();
      continue;
    }
    break;
  }
  return parts;
}

function readBareKey(p: Cursor, t: TFunction): string {
  const start = p.pos;
  while (!p.eol) {
    const c = p.peek();
    if (isLetterOrDigit(c) || c === '_' || c === '-') p.next();
    else break;
  }
  if (p.pos === start) throw new TomlError(t('tomljson.errEmptyKey'));
  return p.slice(start);
}

// ---- table descent ----

function descendTable(root: JObj, path: string[], line: number, t: TFunction): JObj {
  let cur = root;
  for (const key of path) {
    const existing = cur.get(key);
    if (existing && existing.k === 'obj') cur = existing.v;
    else if (existing && existing.k === 'arr' && existing.v.length > 0 && existing.v[existing.v.length - 1]!.k === 'obj')
      cur = (existing.v[existing.v.length - 1]! as { k: 'obj'; v: JObj }).v;
    else if (existing === undefined) {
      const n = new JObj();
      cur.set(key, { k: 'obj', v: n });
      cur = n;
    } else throw err(t, line, 'tomljson.errNonTable', { key });
  }
  return cur;
}

function descendArrayOfTables(root: JObj, path: string[], line: number, t: TFunction): JObj {
  let cur = root;
  for (let k = 0; k < path.length - 1; k++) {
    const key = path[k]!;
    const existing = cur.get(key);
    if (existing && existing.k === 'obj') cur = existing.v;
    else if (existing && existing.k === 'arr' && existing.v.length > 0 && existing.v[existing.v.length - 1]!.k === 'obj')
      cur = (existing.v[existing.v.length - 1]! as { k: 'obj'; v: JObj }).v;
    else if (existing === undefined) {
      const n = new JObj();
      cur.set(key, { k: 'obj', v: n });
      cur = n;
    } else throw err(t, line, 'tomljson.errNonTable', { key });
  }
  const leaf = path[path.length - 1]!;
  let target = cur.get(leaf);
  if (target === undefined) {
    target = { k: 'arr', v: [] };
    cur.set(leaf, target);
  }
  if (target.k !== 'arr') throw err(t, line, 'tomljson.errNotArrayOfTables', { key: leaf });
  const entry = new JObj();
  target.v.push({ k: 'obj', v: entry });
  return entry;
}

function assignDotted(table: JObj, path: string[], value: JVal, line: number, t: TFunction): void {
  let cur = table;
  for (let k = 0; k < path.length - 1; k++) {
    const key = path[k]!;
    const existing = cur.get(key);
    if (existing && existing.k === 'obj') cur = existing.v;
    else if (existing === undefined) {
      const n = new JObj();
      cur.set(key, { k: 'obj', v: n });
      cur = n;
    } else throw err(t, line, 'tomljson.errNonTable', { key });
  }
  const leaf = path[path.length - 1]!;
  if (cur.has(leaf)) throw err(t, line, 'tomljson.errDuplicateKey', { key: leaf });
  cur.set(leaf, value);
}

// ---- values ----

function readValue(p: Cursor, lines: string[], box: { i: number }, t: TFunction): JVal {
  p.skipWs();
  if (p.eol) throw err(t, box.i, 'tomljson.errMissingValue');
  const c = p.peek();

  if (c === '"') {
    if (p.startsWith('"""')) return { k: 'str', v: readMultilineBasic(p, lines, box, t) };
    return { k: 'str', v: readBasicString(p, t) };
  }
  if (c === "'") {
    if (p.startsWith("'''")) return { k: 'str', v: readMultilineLiteral(p, lines, box, t) };
    return { k: 'str', v: readLiteralString(p, t) };
  }
  if (c === '[') return readArray(p, lines, box, t);
  if (c === '{') return readInlineTable(p, lines, box, t);
  return readScalar(p, box.i, t);
}

function readScalar(p: Cursor, line: number, t: TFunction): JVal {
  const start = p.pos;
  while (!p.eol) {
    const c = p.peek();
    if (c === ',' || c === ']' || c === '}' || c === '#') break;
    p.next();
  }
  const tok = p.slice(start).trim();
  if (tok.length === 0) throw err(t, line, 'tomljson.errEmptyValue');

  if (tok === 'true') return { k: 'bool', v: true };
  if (tok === 'false') return { k: 'bool', v: false };

  // Datetime heuristic → keep as string.
  if (looksLikeDateTime(tok)) return { k: 'str', v: tok };

  // floats: inf / nan
  if (tok === 'inf' || tok === '+inf') return { k: 'float', v: Number.POSITIVE_INFINITY };
  if (tok === '-inf') return { k: 'float', v: Number.NEGATIVE_INFINITY };
  if (tok === 'nan' || tok === '+nan' || tok === '-nan') return { k: 'float', v: Number.NaN };

  const noUnderscore = tok.replace(/_/g, '');

  // radixed integers
  if (noUnderscore.startsWith('0x') || noUnderscore.startsWith('0X'))
    return parseRadix(noUnderscore.substring(2), 16, line, tok, t);
  if (noUnderscore.startsWith('0o') || noUnderscore.startsWith('0O'))
    return parseRadix(noUnderscore.substring(2), 8, line, tok, t);
  if (noUnderscore.startsWith('0b') || noUnderscore.startsWith('0B'))
    return parseRadix(noUnderscore.substring(2), 2, line, tok, t);

  const looksFloat = noUnderscore.indexOf('.') >= 0 || noUnderscore.indexOf('e') >= 0 || noUnderscore.indexOf('E') >= 0;
  if (!looksFloat && /^[+-]?\d+$/.test(noUnderscore)) {
    const l = Number(noUnderscore);
    if (Number.isFinite(l)) return { k: 'int', v: l };
  }
  const d = Number(noUnderscore);
  if (noUnderscore.length > 0 && Number.isFinite(d) && /^[+-]?(\d|\.)/.test(noUnderscore)) return { k: 'float', v: d };

  throw err(t, line, 'tomljson.errParseValue', { tok });
}

function parseRadix(digits: string, radix: number, line: number, tok: string, t: TFunction): JVal {
  const re = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
  if (digits.length === 0 || !re.test(digits)) throw err(t, line, 'tomljson.errInvalidNumber', { tok });
  const v = parseInt(digits, radix);
  if (!Number.isFinite(v)) throw err(t, line, 'tomljson.errInvalidNumber', { tok });
  return { k: 'int', v };
}

function looksLikeDateTime(tok: string): boolean {
  let dashes = 0;
  let colons = 0;
  for (const c of tok) {
    if (c === '-') dashes++;
    else if (c === ':') colons++;
  }
  if (colons >= 1) return true;
  if (dashes >= 2 && tok.length >= 8 && /\d/.test(tok[0]!)) return true;
  return false;
}

function readArray(p: Cursor, lines: string[], box: { i: number }, t: TFunction): JVal {
  const arr: JVal[] = [];
  p.next(); // '['
  for (;;) {
    skipArrayFiller(p, lines, box);
    if (p.eol) throw err(t, box.i, 'tomljson.errUnterminatedArray');
    if (p.peek() === ']') {
      p.next();
      break;
    }
    const v = readValue(p, lines, box, t);
    arr.push(v);
    skipArrayFiller(p, lines, box);
    if (p.eol) throw err(t, box.i, 'tomljson.errUnterminatedArray');
    const c = p.peek();
    if (c === ',') {
      p.next();
      continue;
    }
    if (c === ']') {
      p.next();
      break;
    }
    throw err(t, box.i, 'tomljson.errExpectedCommaArray');
  }
  return { k: 'arr', v: arr };
}

// In arrays whitespace, newlines and comments may separate elements.
function skipArrayFiller(p: Cursor, lines: string[], box: { i: number }): void {
  for (;;) {
    p.skipWs();
    if (!p.eol && p.peek() === '#') p.toEnd();
    if (p.eol) {
      if (box.i + 1 >= lines.length) return;
      box.i++;
      p.reset(lines[box.i]!);
      continue;
    }
    return;
  }
}

function readInlineTable(p: Cursor, lines: string[], box: { i: number }, t: TFunction): JVal {
  const obj = new JObj();
  p.next(); // '{'
  p.skipWs();
  if (!p.eol && p.peek() === '}') {
    p.next();
    return { k: 'obj', v: obj };
  }
  for (;;) {
    p.skipWs();
    const path = readKeyPath(p, t);
    p.skipWs();
    if (p.eol || p.peek() !== '=') throw err(t, box.i, 'tomljson.errExpectedEqualsInline');
    p.next();
    p.skipWs();
    const v = readValue(p, lines, box, t);
    assignDotted(obj, path, v, box.i, t);
    p.skipWs();
    if (p.eol) throw err(t, box.i, 'tomljson.errUnterminatedInline');
    const c = p.peek();
    if (c === ',') {
      p.next();
      continue;
    }
    if (c === '}') {
      p.next();
      break;
    }
    throw err(t, box.i, 'tomljson.errExpectedCommaInline');
  }
  return { k: 'obj', v: obj };
}

// ---- strings ----

function readBasicString(p: Cursor, t: TFunction): string {
  p.next(); // opening "
  let sb = '';
  while (!p.eol) {
    const c = p.next();
    if (c === '"') return sb;
    if (c === '\\') {
      if (p.eol) break;
      const e = p.next();
      switch (e) {
        case 'b': sb += '\b'; break;
        case 't': sb += '\t'; break;
        case 'n': sb += '\n'; break;
        case 'f': sb += '\f'; break;
        case 'r': sb += '\r'; break;
        case '"': sb += '"'; break;
        case '\\': sb += '\\'; break;
        case 'u': sb += readUnicode(p, 4); break;
        case 'U': sb += readUnicode(p, 8); break;
        default: sb += e; break;
      }
    } else sb += c;
  }
  throw new TomlError(t('tomljson.errUnterminatedString'));
}

function readUnicode(p: Cursor, n: number): string {
  let hex = '';
  for (let i = 0; i < n && !p.eol; i++) hex += p.next();
  const code = parseInt(hex, 16);
  if (!Number.isNaN(code) && Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  }
  return '';
}

function readLiteralString(p: Cursor, t: TFunction): string {
  p.next(); // opening '
  const start = p.pos;
  while (!p.eol) {
    if (p.peek() === "'") {
      const s = p.slice(start);
      p.next();
      return s;
    }
    p.next();
  }
  throw new TomlError(t('tomljson.errUnterminatedLiteral'));
}

function readMultilineBasic(p: Cursor, lines: string[], box: { i: number }, t: TFunction): string {
  p.skip(3); // """
  let sb = '';
  let firstChunk = true;
  for (;;) {
    if (p.eol) {
      if (box.i + 1 >= lines.length) throw new TomlError(t('tomljson.errUnterminatedMultiline'));
      box.i++;
      p.reset(lines[box.i]!);
      if (!firstChunk) sb += '\n';
      firstChunk = false;
      continue;
    }
    firstChunk = false;
    if (p.startsWith('"""')) {
      p.skip(3);
      break;
    }
    const c = p.next();
    if (c === '\\') {
      if (p.eol) {
        // line-ending backslash: trim following whitespace/newlines
        while (box.i + 1 < lines.length) {
          box.i++;
          p.reset(lines[box.i]!);
          p.skipWs();
          if (!p.eol) break;
        }
        continue;
      }
      const e = p.next();
      switch (e) {
        case 'b': sb += '\b'; break;
        case 't': sb += '\t'; break;
        case 'n': sb += '\n'; break;
        case 'f': sb += '\f'; break;
        case 'r': sb += '\r'; break;
        case '"': sb += '"'; break;
        case '\\': sb += '\\'; break;
        case 'u': sb += readUnicode(p, 4); break;
        case 'U': sb += readUnicode(p, 8); break;
        default: sb += e; break;
      }
    } else sb += c;
  }
  let result = sb;
  if (result.startsWith('\n')) result = result.substring(1);
  return result;
}

function readMultilineLiteral(p: Cursor, lines: string[], box: { i: number }, t: TFunction): string {
  p.skip(3); // '''
  let sb = '';
  let firstChunk = true;
  for (;;) {
    if (p.eol) {
      if (box.i + 1 >= lines.length) throw new TomlError(t('tomljson.errUnterminatedMultilineLiteral'));
      box.i++;
      p.reset(lines[box.i]!);
      if (!firstChunk) sb += '\n';
      firstChunk = false;
      continue;
    }
    firstChunk = false;
    if (p.startsWith("'''")) {
      p.skip(3);
      break;
    }
    sb += p.next();
  }
  let result = sb;
  if (result.startsWith('\n')) result = result.substring(1);
  return result;
}

// ---- JSON serialisation of our JVal tree (pretty, 2-space, like WriteIndented) ----

function jsonStringify(node: JVal | JObj, indent: number): string {
  if (node instanceof JObj) return jsonObj(node, indent);
  switch (node.k) {
    case 'str':
      return JSON.stringify(node.v);
    case 'bool':
      return node.v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'int':
      return Number.isFinite(node.v) ? String(node.v) : jsonNonFinite(node.v);
    case 'float':
      return Number.isFinite(node.v) ? formatFloat(node.v) : jsonNonFinite(node.v);
    case 'arr': {
      if (node.v.length === 0) return '[]';
      const pad = '  '.repeat(indent + 1);
      const inner = node.v.map((it) => pad + jsonStringify(it, indent + 1)).join(',\n');
      return '[\n' + inner + '\n' + '  '.repeat(indent) + ']';
    }
    case 'obj':
      return jsonObj(node.v, indent);
  }
}

function jsonObj(obj: JObj, indent: number): string {
  const ents = obj.entries();
  if (ents.length === 0) return '{}';
  const pad = '  '.repeat(indent + 1);
  const inner = ents
    .map(([k, v]) => pad + JSON.stringify(k) + ': ' + jsonStringify(v, indent + 1))
    .join(',\n');
  return '{\n' + inner + '\n' + '  '.repeat(indent) + '}';
}

// System.Text.Json serialises non-finite doubles as their token strings quoted;
// but to keep round-trips lossless-ish we emit them as JSON strings.
function jsonNonFinite(v: number): string {
  if (Number.isNaN(v)) return '"NaN"';
  return v > 0 ? '"Infinity"' : '"-Infinity"';
}

function formatFloat(v: number): string {
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

// ------------------------------------------------------------------ JSON → TOML
// We parse JSON with the native parser, then convert to our JVal tree so the
// writer can distinguish objects / arrays-of-tables / scalars.

function nativeToJVal(x: unknown): JVal {
  if (x === null || x === undefined) return { k: 'null' };
  if (typeof x === 'boolean') return { k: 'bool', v: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { k: 'int', v: x } : { k: 'float', v: x };
  if (typeof x === 'string') return { k: 'str', v: x };
  if (Array.isArray(x)) return { k: 'arr', v: x.map(nativeToJVal) };
  if (typeof x === 'object') {
    const o = new JObj();
    for (const key of Object.keys(x as Record<string, unknown>)) {
      o.set(key, nativeToJVal((x as Record<string, unknown>)[key]));
    }
    return { k: 'obj', v: o };
  }
  return { k: 'null' };
}

function jsonToToml(json: string, t: TFunction): Result {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json ?? '');
    } catch (jex) {
      return { ok: false, output: '', error: t('tomljson.invalidJson') + (jex instanceof Error ? jex.message : String(jex)) };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, output: '', error: t('tomljson.topLevelObject') };
    }

    const obj = nativeToJVal(parsed);
    if (obj.k !== 'obj') return { ok: false, output: '', error: t('tomljson.topLevelObject') };

    const out: string[] = [];
    writeTable(out, obj.v, '');
    return { ok: true, output: out.join('').replace(/\s+$/, '') + '\n', error: null };
  } catch (ex) {
    return { ok: false, output: '', error: ex instanceof Error ? ex.message : String(ex) };
  }
}

// ---- TOML writer ----

function writeTable(out: string[], obj: JObj, prefix: string): void {
  const subTables: [string, JObj][] = [];
  const tableArrays: [string, JVal[]][] = [];

  for (const [key, val] of obj.entries()) {
    if (val.k === 'obj') {
      subTables.push([key, val.v]);
    } else if (val.k === 'arr' && isArrayOfTables(val.v)) {
      tableArrays.push([key, val.v]);
    } else {
      out.push(formatKey(key) + ' = ' + formatValue(val) + '\n');
    }
  }

  for (const [key, child] of subTables) {
    const path = prefix.length === 0 ? formatKey(key) : prefix + '.' + formatKey(key);
    out.push('\n[' + path + ']\n');
    writeTable(out, child, path);
  }

  for (const [key, arr] of tableArrays) {
    const path = prefix.length === 0 ? formatKey(key) : prefix + '.' + formatKey(key);
    for (const item of arr) {
      out.push('\n[[' + path + ']]\n');
      // isArrayOfTables guarantees every item is an object.
      writeTable(out, (item as { k: 'obj'; v: JObj }).v, path);
    }
  }
}

function isArrayOfTables(arr: JVal[]): boolean {
  if (arr.length === 0) return false;
  for (const item of arr) if (item.k !== 'obj') return false;
  return true;
}

function formatKey(key: string): string {
  let bare = key.length > 0;
  for (const c of key) {
    if (!(isLetterOrDigit(c) || c === '_' || c === '-')) {
      bare = false;
      break;
    }
  }
  return bare ? key : '"' + escapeBasic(key) + '"';
}

function formatValue(node: JVal): string {
  switch (node.k) {
    case 'null':
      return '""'; // TOML has no null; represent as empty string
    case 'arr': {
      let sb = '[';
      for (let i = 0; i < node.v.length; i++) {
        if (i > 0) sb += ', ';
        const el = node.v[i]!;
        if (el.k === 'obj') sb += formatInlineTable(el.v);
        else sb += formatValue(el);
      }
      sb += ']';
      return sb;
    }
    case 'obj':
      return formatInlineTable(node.v);
    default:
      return formatScalar(node);
  }
}

function formatInlineTable(o: JObj): string {
  const ents = o.entries();
  if (ents.length === 0) return '{}';
  let sb = '{ ';
  let first = true;
  for (const [key, val] of ents) {
    if (!first) sb += ', ';
    first = false;
    sb += formatKey(key) + ' = ' + formatValue(val);
  }
  sb += ' }';
  return sb;
}

function formatScalar(val: JVal): string {
  switch (val.k) {
    case 'bool':
      return val.v ? 'true' : 'false';
    case 'int':
      return String(val.v);
    case 'float': {
      const d = val.v;
      if (Number.isNaN(d)) return 'nan';
      if (d === Number.POSITIVE_INFINITY) return 'inf';
      if (d === Number.NEGATIVE_INFINITY) return '-inf';
      let s = String(d);
      if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0) s += '.0';
      return s;
    }
    case 'str':
      return '"' + escapeBasic(val.v) + '"';
    default:
      return '""';
  }
}

function escapeBasic(s: string): string {
  let sb = '';
  for (const c of s) {
    switch (c) {
      case '\\': sb += '\\\\'; break;
      case '"': sb += '\\"'; break;
      case '\b': sb += '\\b'; break;
      case '\t': sb += '\\t'; break;
      case '\n': sb += '\\n'; break;
      case '\f': sb += '\\f'; break;
      case '\r': sb += '\\r'; break;
      default: {
        const code = c.codePointAt(0)!;
        if (code < 0x20) sb += '\\u' + code.toString(16).padStart(4, '0');
        else sb += c;
        break;
      }
    }
  }
  return sb;
}

// ============================================================================
// Component
// ============================================================================

type Direction = 'tomlToJson' | 'jsonToToml';

const SAMPLE_TOML = `# Example TOML
title = "TOML Example"

[owner]
name = "Tom Preston-Werner"
dob = 1979-05-27T07:32:00

[database]
enabled = true
ports = [ 8000, 8001, 8002 ]
data = [ ["delta", "phi"], [3.14] ]

[[servers]]
name = "alpha"
ip = "10.0.0.1"

[[servers]]
name = "beta"
ip = "10.0.0.2"
`;

export function TomlJsonModule() {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<Direction>('tomlToJson');
  const [input, setInput] = useState(SAMPLE_TOML);
  const [copied, setCopied] = useState(false);

  const tomlToJsonSelected = direction === 'tomlToJson';

  const { result } = useMemo(() => {
    if (input.trim().length === 0) {
      return { result: { ok: true, output: '', error: null } as Result };
    }
    const r = tomlToJsonSelected ? tomlToJson(input, t) : jsonToToml(input, t);
    return { result: r };
  }, [input, direction, t, tomlToJsonSelected]);

  const output = result.ok ? result.output : '';

  const status: { severity: 'success' | 'error' | 'none'; title: string; message: string } = (() => {
    if (input.trim().length === 0) return { severity: 'none', title: '', message: '' };
    if (result.ok) {
      return {
        severity: 'success',
        title: t('tomljson.converted'),
        message: tomlToJsonSelected ? t('tomljson.msgTomlToJson') : t('tomljson.msgJsonToToml'),
      };
    }
    return {
      severity: 'error',
      title: t('tomljson.couldNotConvert'),
      message: result.error ?? t('tomljson.unknownError'),
    };
  })();

  const swap = () => {
    const next: Direction = tomlToJsonSelected ? 'jsonToToml' : 'tomlToJson';
    setDirection(next);
    if (output.trim().length > 0) setInput(output);
  };

  const copy = () => {
    if (!output) return;
    navigator.clipboard?.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const inputLabel = tomlToJsonSelected ? t('tomljson.tomlInput') : t('tomljson.jsonInput');
  const outputLabel = tomlToJsonSelected ? t('tomljson.jsonOutput') : t('tomljson.tomlOutput');

  const statusColor = status.severity === 'error' ? 'var(--danger)' : undefined;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('tomljson.blurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('tomljson.direction')}</label>
        <select
          className="mod-select"
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
        >
          <option value="tomlToJson">{t('tomljson.tomlToJson')}</option>
          <option value="jsonToToml">{t('tomljson.jsonToToml')}</option>
        </select>
        <button className="mini" onClick={swap}>{t('tomljson.swap')}</button>
        <button className="mini primary" disabled={!output} onClick={copy}>
          {copied ? t('tomljson.copied') : t('tomljson.copyOutput')}
        </button>
      </div>
      <div className="io-grid">
        <div>
          <label className="label">{inputLabel}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ fontFamily: 'monospace', minHeight: 300 }}
            placeholder={inputLabel}
          />
        </div>
        <div>
          <label className="label">{outputLabel}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={output}
            style={{ fontFamily: 'monospace', minHeight: 300 }}
            placeholder={outputLabel}
          />
        </div>
      </div>
      {status.severity !== 'none' && (
        <p className="count-note" style={{ color: statusColor }}>
          <strong>{status.title}</strong>
          {status.message ? ' — ' + status.message : ''}
        </p>
      )}
      <p className="count-note">{t('tomljson.notes')}</p>
    </div>
  );
}
