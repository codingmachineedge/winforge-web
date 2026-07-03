import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// ── Faithful web-only port of WinForge YamlJsonService ──────────────────────
// A practical YAML subset ↔ JSON converter, hand-written, never-throwing.

type JsonNode = null | boolean | number | string | JsonNode[] | { [k: string]: JsonNode };

interface ConvertResult {
  ok: boolean;
  output: string;
  error?: string;
}

const LIMITATIONS_EN =
  'Subset only: 2-space indent, block mappings & sequences, quoted/plain scalars, inline # comments, simple flow [a,b] / {k:v}. Anchors/aliases, tags, multi-doc & block scalars (| >) are not supported.';
const LIMITATIONS_ZH =
  '只支援子集：2 格縮排、區塊映射同序列、有引號/無引號純量、行內 # 註解、簡單 flow [a,b] / {k:v}。唔支援 anchor/alias、tag、多文件同 block scalar（| >）。';

// ── JSON → YAML ─────────────────────────────────────────────────────────────

function jsonToYaml(json: string): ConvertResult {
  if (!json || json.trim().length === 0) return { ok: false, output: '', error: 'empty-json' };
  let root: JsonNode;
  try {
    root = JSON.parse(stripJsonComments(json)) as JsonNode;
  } catch (ex) {
    return { ok: false, output: '', error: 'invalid-json:' + errMsg(ex) };
  }
  try {
    const parts: string[] = [];
    emitYaml(root, parts, 0);
    const text = parts.join('').replace(/\n+$/, '');
    return { ok: true, output: text.length === 0 ? 'null' : text };
  } catch (ex) {
    return { ok: false, output: '', error: 'emit-failed:' + errMsg(ex) };
  }
}

// Best-effort strip of // and /* */ comments + tolerate trailing commas, so
// input closer to the C# (AllowTrailingCommas + CommentHandling.Skip) works.
function stripJsonComments(s: string): string {
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < s.length) {
        out += s[i + 1]!;
        i++;
      } else if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && i + 1 < s.length && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      if (i < s.length) out += '\n';
      continue;
    }
    if (c === '/' && i + 1 < s.length && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // remove trailing commas: , followed by whitespace then } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isPlainObject(n: JsonNode): n is { [k: string]: JsonNode } {
  return n !== null && typeof n === 'object' && !Array.isArray(n);
}

function emitYaml(node: JsonNode, parts: string[], indent: number): void {
  const pad = ' '.repeat(indent * 2);
  if (node === null) {
    parts.push(pad + 'null\n');
    return;
  }
  if (isPlainObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) {
      parts.push(pad + '{}\n');
      return;
    }
    for (const k of keys) {
      const key = emitKey(k);
      const child = node[k]!;
      if (isPlainObject(child) && Object.keys(child).length > 0) {
        parts.push(pad + key + ':\n');
        emitYaml(child, parts, indent + 1);
      } else if (Array.isArray(child) && child.length > 0) {
        parts.push(pad + key + ':\n');
        emitYaml(child, parts, indent); // sequences align under key at same indent
      } else {
        parts.push(pad + key + ': ' + emitScalar(child) + '\n');
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) {
      parts.push(pad + '[]\n');
      return;
    }
    for (const item of node) {
      if (isPlainObject(item) && Object.keys(item).length > 0) {
        const tmp: string[] = [];
        emitYaml(item, tmp, indent + 1);
        const lines = tmp.join('').replace(/\n+$/, '').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i]!;
          if (i === 0) parts.push(pad + '- ' + ln.trimStart() + '\n');
          else parts.push(ln + '\n');
        }
      } else if (Array.isArray(item) && item.length > 0) {
        parts.push(pad + '-\n');
        emitYaml(item, parts, indent + 1);
      } else {
        parts.push(pad + '- ' + emitScalar(item) + '\n');
      }
    }
    return;
  }
  // scalar
  parts.push(pad + emitScalar(node) + '\n');
}

function emitKey(key: string): string {
  return needsQuote(key) ? quote(key) : key;
}

function emitScalar(node: JsonNode): string {
  if (node === null) return 'null';
  if (Array.isArray(node)) return '[]';
  if (isPlainObject(node)) return '{}';
  if (typeof node === 'boolean') return node ? 'true' : 'false';
  if (typeof node === 'number') {
    if (Number.isInteger(node)) return String(node);
    return String(node);
  }
  const s = String(node);
  return needsQuote(s) ? quote(s) : s;
}

function needsQuote(s: string): boolean {
  if (s.length === 0) return true;
  if (s !== s.trim()) return true;
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'null' || lower === '~' || lower === 'yes' || lower === 'no') return true;
  // parses as a number → quote so re-parse keeps it a string
  if (s.trim().length > 0 && !Number.isNaN(Number(s))) return true;
  for (const c of s) {
    if (
      c === ':' || c === '#' || c === '-' || c === '{' || c === '}' || c === '[' || c === ']' ||
      c === ',' || c === '&' || c === '*' || c === '!' || c === '|' || c === '>' || c === "'" ||
      c === '"' || c === '%' || c === '@' || c === '`' || c === '\n' || c === '\t'
    )
      return true;
  }
  const first = s[0]!;
  if (first === ' ' || first === '?' || first === "'" || first === '"') return true;
  return false;
}

function quote(s: string): string {
  let out = '"';
  for (const c of s) {
    switch (c) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\t': out += '\\t'; break;
      case '\r': out += '\\r'; break;
      default: out += c; break;
    }
  }
  out += '"';
  return out;
}

// ── YAML → JSON ─────────────────────────────────────────────────────────────

interface Line {
  indent: number;
  content: string;
  number: number;
}

class YamlError extends Error {}

function yamlToJson(yaml: string): ConvertResult {
  if (!yaml || yaml.trim().length === 0) return { ok: false, output: '', error: 'empty-yaml' };
  let lines: Line[];
  try {
    lines = tokenize(yaml);
  } catch (ex) {
    return { ok: false, output: '', error: 'yaml-lex:' + errMsg(ex) };
  }
  if (lines.length === 0) return { ok: false, output: '', error: 'empty-yaml' };
  try {
    const idx = { i: 0 };
    const node = parseBlock(lines, idx, lines[0]!.indent);
    const json = node === undefined || node === null ? 'null' : JSON.stringify(node, null, 2);
    return { ok: true, output: json };
  } catch (ex) {
    if (ex instanceof YamlError) return { ok: false, output: '', error: 'yaml-parse:' + ex.message };
    return { ok: false, output: '', error: 'yaml-parse:' + errMsg(ex) };
  }
}

function tokenize(yaml: string): Line[] {
  const result: Line[] = [];
  const raw = yaml.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    const t = line.replace(/\s+$/, '');
    const trimmed = t.trim();
    if (trimmed === '---' || trimmed === '...') continue;
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    let body = line.substring(indent);
    body = stripComment(body).replace(/\s+$/, '');
    if (body.length === 0) continue;
    result.push({ indent, content: body, number: i + 1 });
  }
  return result;
}

function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      if (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t') return s.substring(0, i);
    }
  }
  return s;
}

function parseBlock(lines: Line[], idx: { i: number }, indent: number): JsonNode {
  if (idx.i >= lines.length) return null;
  const line = lines[idx.i]!;
  if (line.content.startsWith('- ') || line.content === '-') return parseSequence(lines, idx, indent);
  return parseMapping(lines, idx, indent);
}

function parseMapping(lines: Line[], idx: { i: number }, indent: number): JsonNode {
  const obj: { [k: string]: JsonNode } = {};
  while (idx.i < lines.length) {
    const line = lines[idx.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`line ${line.number}: unexpected extra indent`);
    if (line.content.startsWith('- ') || line.content === '-')
      throw new YamlError(`line ${line.number}: sequence item inside a mapping`);

    const [key, rest] = splitKey(line, line.number);
    idx.i++;
    if (rest.length > 0) {
      obj[key] = parseScalar(rest);
    } else {
      if (idx.i < lines.length && lines[idx.i]!.indent > indent) {
        obj[key] = parseBlock(lines, idx, lines[idx.i]!.indent);
      } else if (
        idx.i < lines.length &&
        lines[idx.i]!.indent === indent &&
        (lines[idx.i]!.content.startsWith('- ') || lines[idx.i]!.content === '-')
      ) {
        obj[key] = parseSequence(lines, idx, indent);
      } else {
        obj[key] = null;
      }
    }
  }
  return obj;
}

function parseSequence(lines: Line[], idx: { i: number }, indent: number): JsonNode {
  const arr: JsonNode[] = [];
  while (idx.i < lines.length) {
    const line = lines[idx.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`line ${line.number}: unexpected extra indent in sequence`);
    if (!(line.content.startsWith('- ') || line.content === '-')) break;

    const after = line.content === '-' ? '' : line.content.substring(2).trim();
    if (after.length === 0) {
      idx.i++;
      if (idx.i < lines.length && lines[idx.i]!.indent > indent) arr.push(parseBlock(lines, idx, lines[idx.i]!.indent));
      else arr.push(null);
    } else if (looksLikeInlineKey(after)) {
      const itemIndent = indent + 2;
      const obj: { [k: string]: JsonNode } = {};
      const firstLine: Line = { indent: itemIndent, content: after, number: line.number };
      const [k, rest] = splitKey(firstLine, line.number);
      idx.i++;
      if (rest.length > 0) {
        obj[k] = parseScalar(rest);
      } else if (idx.i < lines.length && lines[idx.i]!.indent > indent) {
        obj[k] = parseBlock(lines, idx, lines[idx.i]!.indent);
      } else {
        obj[k] = null;
      }

      while (
        idx.i < lines.length &&
        lines[idx.i]!.indent > indent &&
        !(lines[idx.i]!.content.startsWith('- ') || lines[idx.i]!.content === '-')
      ) {
        const kl = lines[idx.i]!;
        const [k2, rest2] = splitKey(kl, kl.number);
        idx.i++;
        if (rest2.length > 0) obj[k2] = parseScalar(rest2);
        else if (idx.i < lines.length && lines[idx.i]!.indent > kl.indent) obj[k2] = parseBlock(lines, idx, lines[idx.i]!.indent);
        else obj[k2] = null;
      }
      arr.push(obj);
    } else {
      arr.push(parseScalar(after));
      idx.i++;
    }
  }
  return arr;
}

function looksLikeInlineKey(s: string): boolean {
  const p = findColon(s);
  if (p < 0) return false;
  if (p + 1 < s.length && s[p + 1] !== ' ') return false;
  const key = s.substring(0, p).trim();
  return key.length > 0;
}

function splitKey(line: Line, num: number): [string, string] {
  const p = findColon(line.content);
  if (p < 0) throw new YamlError(`line ${num}: expected 'key: value'`);
  const keyRaw = line.content.substring(0, p).trim();
  const rest = line.content.substring(p + 1).trim();
  if (keyRaw.length === 0) throw new YamlError(`line ${num}: empty key`);
  return [unquote(keyRaw), rest];
}

function findColon(s: string): number {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD) {
      if (i + 1 === s.length || s[i + 1] === ' ') return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unescapeDouble(s.substring(1, s.length - 1));
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.substring(1, s.length - 1).replace(/''/g, "'");
  return s;
}

function unescapeDouble(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i]!;
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '0': out += '\0'; break;
        default: out += n; break;
      }
    } else out += c;
  }
  return out;
}

function parseScalar(raw: string): JsonNode {
  const s = raw.trim();
  if (s.length === 0) return null;

  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return unquote(s);

  if ((s[0] === '[' && s.endsWith(']')) || (s[0] === '{' && s.endsWith('}'))) {
    try {
      const n = JSON.parse(s) as JsonNode;
      if (n !== null && n !== undefined) return n;
    } catch {
      /* fall through as string */
    }
  }

  const lower = s.toLowerCase();
  if (lower === 'null' || lower === '~') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  // integer
  if (/^[+-]?\d+$/.test(s)) {
    const l = Number(s);
    if (Number.isSafeInteger(l)) return l;
  }
  // float
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    const d = Number(s);
    if (!Number.isNaN(d)) return d;
  }

  return unquote(s);
}

function errMsg(ex: unknown): string {
  if (ex instanceof Error) return ex.message;
  return String(ex);
}

function friendlyError(t: TFunction, code?: string): string {
  const c = code ?? '';
  const idx = c.indexOf(':');
  const tail = idx >= 0 ? c.substring(idx + 1) : '';
  if (c.startsWith('empty')) return t('yamljson.errEmpty');
  if (c.startsWith('invalid-json')) return t('yamljson.errJson') + ' ' + tail;
  if (c.startsWith('yaml-parse') || c.startsWith('yaml-lex')) return t('yamljson.errYaml') + ' ' + tail;
  return t('yamljson.errFail') + ' ' + tail;
}

const SAMPLE_YAML =
  '# WinForge sample config\n' +
  'name: WinForge\n' +
  'version: 11\n' +
  'enabled: true\n' +
  'reactor:\n' +
  '  mode: 5\n' +
  '  coolant: "heavy water"\n' +
  '  rods: 121\n' +
  'modules:\n' +
  '  - awake\n' +
  '  - yamljson\n' +
  '  - reactor\n' +
  'authors:\n' +
  '  - name: Claude\n' +
  '    role: agent\n';

const SAMPLE_JSON =
  '{\n' +
  '  "name": "WinForge",\n' +
  '  "version": 11,\n' +
  '  "enabled": true,\n' +
  '  "reactor": { "mode": 5, "coolant": "heavy water", "rods": 121 },\n' +
  '  "modules": ["awake", "yamljson", "reactor"],\n' +
  '  "authors": [ { "name": "Claude", "role": "agent" } ]\n' +
  '}\n';

export function YamlJsonModule() {
  const { t, i18n } = useTranslation();
  const [direction, setDirection] = useState(0); // 0 = YAML→JSON, 1 = JSON→YAML
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);

  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const limitations = zh ? LIMITATIONS_ZH : LIMITATIONS_EN;

  const { output, status } = useMemo(() => {
    if (!input || input.trim().length === 0) {
      return { output: '', status: null as null | { ok: boolean; title: string; msg: string } };
    }
    const r: ConvertResult = direction === 0 ? yamlToJson(input) : jsonToYaml(input);
    if (r.ok) {
      return {
        output: r.output,
        status: {
          ok: true,
          title: t('yamljson.converted'),
          msg: direction === 0 ? t('yamljson.okYaml2Json') : t('yamljson.okJson2Yaml'),
        },
      };
    }
    return {
      output: '',
      status: { ok: false, title: t('yamljson.couldNotConvert'), msg: friendlyError(t, r.error) },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, direction, t, i18n.language]);

  const loadSample = () => {
    setInput(direction === 0 ? SAMPLE_YAML : SAMPLE_JSON);
  };

  const clear = () => {
    setInput('');
    setCopied(false);
  };

  const copy = () => {
    if (!output) return;
    navigator.clipboard?.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('yamljson.blurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('yamljson.direction')}</label>
        <select className="mod-select" value={direction} onChange={(e) => setDirection(Number(e.target.value))}>
          <option value={0}>{t('yamljson.yaml2json')}</option>
          <option value={1}>{t('yamljson.json2yaml')}</option>
        </select>
        <button className="mini" onClick={loadSample}>{t('yamljson.loadSample')}</button>
        <button className="mini" disabled={!output} onClick={copy}>
          {copied ? t('yamljson.copied') : t('yamljson.copyOutput')}
        </button>
        <button className="mini" onClick={clear}>{t('yamljson.clear')}</button>
      </div>
      <div className="io-grid">
        <div>
          <label className="label">{t('yamljson.input')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={direction === 0 ? t('yamljson.phYaml') : t('yamljson.phJson')}
            style={{ fontFamily: 'monospace', minHeight: 240 }}
          />
        </div>
        <div>
          <label className="label">{t('yamljson.output')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={output}
            placeholder={t('yamljson.phOutput')}
            style={{ fontFamily: 'monospace', minHeight: 240 }}
          />
        </div>
      </div>
      {status ? (
        <p className="count-note" style={{ color: status.ok ? undefined : 'var(--danger)' }}>
          {status.ok ? `OK — ${status.msg}` : `${status.title}: ${status.msg}`}
        </p>
      ) : null}
      <div className="panel">
        <p className="count-note" style={{ margin: 0 }}>{limitations}</p>
      </div>
    </div>
  );
}
