import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Parsed JSON tree. We keep object entries as an ordered list of pairs so we can
// both detect duplicate keys and re-sort deterministically (mirrors WinForge's
// JsonSortService, which uses System.Text.Json + a duplicate-key pre-scan).
type JVal =
  | { kind: 'object'; entries: Array<{ key: string; value: JVal }> }
  | { kind: 'array'; items: JVal[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

type IndentKind = 'two' | 'four' | 'tab';

interface SortOptions {
  descending: boolean;
  caseInsensitive: boolean;
  minify: boolean;
  indent: IndentKind;
  sortArrays: boolean;
}

interface SortResult {
  ok: boolean;
  output: string;
  errorEn?: string;
  errorZh?: string;
  hadDuplicateKeys: boolean;
}

// ---------------------------------------------------------------------------
// A small, dependency-free JSON parser. It skips // and /* */ comments and
// tolerates trailing commas (matching WinForge's JsonDocumentOptions:
// CommentHandling.Skip + AllowTrailingCommas). It records duplicate keys per
// object (last value wins) so we can surface the same bilingual warning.
// ---------------------------------------------------------------------------
class JsonParser {
  private i = 0;
  hadDuplicateKeys = false;

  constructor(private readonly s: string) {}

  parse(): JVal {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) {
      throw new SyntaxError(`Unexpected character '${this.s[this.i]}' at position ${this.i}.`);
    }
    return v;
  }

  private ws(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '/') {
        this.i += 2;
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '*') {
        this.i += 2;
        while (this.i < this.s.length && !(this.s[this.i] === '*' && this.s[this.i + 1] === '/')) this.i++;
        if (this.i >= this.s.length) throw new SyntaxError('Unterminated comment.');
        this.i += 2;
        continue;
      }
      break;
    }
  }

  private value(): JVal {
    const c = this.s[this.i];
    if (c === undefined) throw new SyntaxError('Unexpected end of input.');
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return { kind: 'string', value: this.string() };
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    if (this.s.startsWith('true', this.i)) {
      this.i += 4;
      return { kind: 'bool', value: true };
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5;
      return { kind: 'bool', value: false };
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4;
      return { kind: 'null' };
    }
    throw new SyntaxError(`Unexpected token '${c}' at position ${this.i}.`);
  }

  private object(): JVal {
    this.i++; // {
    const entries: Array<{ key: string; value: JVal }> = [];
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++; // trailing comma tolerance
        break;
      }
      if (this.s[this.i] !== '"') throw new SyntaxError(`Expected property name at position ${this.i}.`);
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') throw new SyntaxError(`Expected ':' at position ${this.i}.`);
      this.i++;
      this.ws();
      const value = this.value();
      if (seen.has(key)) {
        this.hadDuplicateKeys = true;
        // last value wins
        const existing = entries.find((e) => e.key === key);
        if (existing) existing.value = value;
      } else {
        seen.add(key);
        entries.push({ key, value });
      }
      this.ws();
      const nc = this.s[this.i];
      if (nc === ',') {
        this.i++;
        continue;
      }
      if (nc === '}') {
        this.i++;
        break;
      }
      throw new SyntaxError(`Expected ',' or '}' at position ${this.i}.`);
    }
    return { kind: 'object', entries };
  }

  private array(): JVal {
    this.i++; // [
    const items: JVal[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return { kind: 'array', items };
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++; // trailing comma tolerance
        break;
      }
      items.push(this.value());
      this.ws();
      const nc = this.s[this.i];
      if (nc === ',') {
        this.i++;
        continue;
      }
      if (nc === ']') {
        this.i++;
        break;
      }
      throw new SyntaxError(`Expected ',' or ']' at position ${this.i}.`);
    }
    return { kind: 'array', items };
  }

  private string(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw new SyntaxError('Unterminated string.');
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const e = this.s[this.i + 1];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = this.s.slice(this.i + 2, this.i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError(`Invalid \\u escape at position ${this.i}.`);
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 6;
            continue;
          }
          default:
            throw new SyntaxError(`Invalid escape '\\${e}' at position ${this.i}.`);
        }
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private number(): JVal {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    while (this.i < this.s.length && /[0-9]/.test(this.s[this.i]!)) this.i++;
    if (this.s[this.i] === '.') {
      this.i++;
      while (this.i < this.s.length && /[0-9]/.test(this.s[this.i]!)) this.i++;
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      while (this.i < this.s.length && /[0-9]/.test(this.s[this.i]!)) this.i++;
    }
    const raw = this.s.slice(start, this.i);
    if (raw === '' || raw === '-') throw new SyntaxError(`Invalid number at position ${start}.`);
    return { kind: 'number', raw };
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function compareKeys(a: string, b: string, caseInsensitive: boolean): number {
  const x = caseInsensitive ? a.toLowerCase() : a;
  const y = caseInsensitive ? b.toLowerCase() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function isPrimitive(v: JVal): boolean {
  return v.kind !== 'object' && v.kind !== 'array';
}

function primitiveKey(v: JVal): string {
  switch (v.kind) {
    case 'string': return JSON.stringify(v.value);
    case 'number': return v.raw;
    case 'bool': return v.value ? 'true' : 'false';
    case 'null': return 'null';
    default: return '';
  }
}

function comparePrimitives(a: JVal, b: JVal, opts: SortOptions): number {
  const ka = primitiveKey(a);
  const kb = primitiveKey(b);
  const na = Number(ka.replace(/^"|"$/g, ''));
  const nb = Number(kb.replace(/^"|"$/g, ''));
  let cmp: number;
  const strA = ka.replace(/^"|"$/g, '');
  const strB = kb.replace(/^"|"$/g, '');
  if (strA.trim() !== '' && strB.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    cmp = na < nb ? -1 : na > nb ? 1 : 0;
  } else {
    const x = opts.caseInsensitive ? ka.toLowerCase() : ka;
    const y = opts.caseInsensitive ? kb.toLowerCase() : kb;
    cmp = x < y ? -1 : x > y ? 1 : 0;
  }
  return opts.descending ? -cmp : cmp;
}

function sortNode(node: JVal, opts: SortOptions): JVal {
  switch (node.kind) {
    case 'object': {
      const entries = node.entries
        .slice()
        .sort((p, q) => {
          const c = compareKeys(p.key, q.key, opts.caseInsensitive);
          return opts.descending ? -c : c;
        })
        .map((e) => ({ key: e.key, value: sortNode(e.value, opts) }));
      return { kind: 'object', entries };
    }
    case 'array': {
      let items = node.items.map((it) => sortNode(it, opts));
      if (opts.sortArrays && items.every(isPrimitive)) {
        items = items.slice().sort((a, b) => comparePrimitives(a, b, opts));
      }
      return { kind: 'array', items };
    }
    default:
      return node;
  }
}

// ---------------------------------------------------------------------------
// Serialisation. System.Text.Json escapes non-ASCII by default; to stay faithful
// and diff-friendly we use JSON.stringify's escaping for strings but drive our
// own indentation so we can honour tab / 2 / 4 exactly and minify.
// ---------------------------------------------------------------------------
function encodeString(s: string): string {
  return JSON.stringify(s);
}

function serialize(node: JVal, opts: SortOptions): string {
  if (opts.minify) return serializeMin(node);
  const unit = opts.indent === 'tab' ? '\t' : opts.indent === 'four' ? '    ' : '  ';
  return serializePretty(node, opts, unit, '');
}

function serializeMin(node: JVal): string {
  switch (node.kind) {
    case 'object':
      return `{${node.entries.map((e) => `${encodeString(e.key)}:${serializeMin(e.value)}`).join(',')}}`;
    case 'array':
      return `[${node.items.map((i) => serializeMin(i)).join(',')}]`;
    case 'string': return encodeString(node.value);
    case 'number': return node.raw;
    case 'bool': return node.value ? 'true' : 'false';
    case 'null': return 'null';
  }
}

function serializePretty(node: JVal, opts: SortOptions, unit: string, pad: string): string {
  switch (node.kind) {
    case 'object': {
      if (node.entries.length === 0) return '{}';
      const inner = pad + unit;
      const body = node.entries
        .map((e) => `${inner}${encodeString(e.key)}: ${serializePretty(e.value, opts, unit, inner)}`)
        .join(',\n');
      return `{\n${body}\n${pad}}`;
    }
    case 'array': {
      if (node.items.length === 0) return '[]';
      const inner = pad + unit;
      const body = node.items.map((i) => `${inner}${serializePretty(i, opts, unit, inner)}`).join(',\n');
      return `[\n${body}\n${pad}]`;
    }
    case 'string': return encodeString(node.value);
    case 'number': return node.raw;
    case 'bool': return node.value ? 'true' : 'false';
    case 'null': return 'null';
  }
}

function sortJson(input: string, opts: SortOptions): SortResult {
  const result: SortResult = { ok: false, output: '', hadDuplicateKeys: false };
  if (!input || input.trim() === '') {
    result.errorEn = 'Nothing to sort — paste some JSON first.';
    result.errorZh = '冇嘢排 — 請先貼入 JSON。';
    return result;
  }
  let root: JVal;
  let hadDupes = false;
  try {
    const parser = new JsonParser(input);
    root = parser.parse();
    hadDupes = parser.hadDuplicateKeys;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errorEn = `Invalid JSON — ${msg}`;
    result.errorZh = `JSON 格式錯誤 — ${msg}`;
    return result;
  }
  try {
    const sorted = sortNode(root, opts);
    result.output = serialize(sorted, opts);
    result.hadDuplicateKeys = hadDupes;
    result.ok = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errorEn = `Could not sort the JSON — ${msg}`;
    result.errorZh = `排唔到呢段 JSON — ${msg}`;
  }
  return result;
}

type Info = { severity: 'error' | 'warning' | 'success'; title: string; message: string };

export function JsonSortModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(
    '{\n  "name": "WinForge",\n  "active": true,\n  "tags": ["z", "a", "m"],\n  "meta": { "version": 2, "author": "Ada" }\n}',
  );
  const [output, setOutput] = useState('');
  const [descending, setDescending] = useState(false);
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [minify, setMinify] = useState(false);
  const [indent, setIndent] = useState<IndentKind>('two');
  const [sortArrays, setSortArrays] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);

  const canCopy = output.length > 0;

  const doSort = () => {
    const opts: SortOptions = { descending, caseInsensitive, minify, indent, sortArrays };
    const res = sortJson(input, opts);
    if (!res.ok) {
      setOutput('');
      setInfo({ severity: 'error', title: t('jsonsort.errTitle'), message: pickErr(t, res) });
      return;
    }
    setOutput(res.output);
    if (res.hadDuplicateKeys) {
      setInfo({ severity: 'warning', title: t('jsonsort.dupTitle'), message: t('jsonsort.dupBody') });
    } else {
      setInfo({ severity: 'success', title: t('jsonsort.okTitle'), message: t('jsonsort.okBody') });
    }
  };

  const doCopy = () => {
    if (!output) return;
    void navigator.clipboard?.writeText(output);
    setInfo({ severity: 'success', title: t('jsonsort.copiedTitle'), message: t('jsonsort.copiedBody') });
  };

  const infoColor =
    info?.severity === 'error' ? 'var(--danger)' : info?.severity === 'warning' ? 'var(--warn, #b8860b)' : 'var(--accent, #2ea043)';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('jsonsort.blurb')}</p>

      {info && (
        <div
          style={{
            border: `1px solid ${infoColor}`,
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          <strong style={{ color: infoColor }}>{info.title}</strong>
          <div style={{ marginTop: 2 }}>{info.message}</div>
        </div>
      )}

      <label className="count-note" style={{ display: 'block', marginBottom: 4 }}>{t('jsonsort.inputLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('jsonsort.inputPlaceholder')}
        style={{ width: '100%', minHeight: 150 }}
      />

      <div style={{ marginTop: 14, marginBottom: 4, fontWeight: 600, fontSize: 14 }}>{t('jsonsort.optionsTitle')}</div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note" style={{ minWidth: 90 }}>{t('jsonsort.orderLabel')}</label>
        <select className="mod-select" value={descending ? 'desc' : 'asc'} onChange={(e) => setDescending(e.target.value === 'desc')}>
          <option value="asc">{t('jsonsort.orderAsc')}</option>
          <option value="desc">{t('jsonsort.orderDesc')}</option>
        </select>
      </div>

      <label className="chk" style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={caseInsensitive} onChange={(e) => setCaseInsensitive(e.target.checked)} />
        {t('jsonsort.caseInsensitive')}
      </label>

      <label className="chk" style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={minify} onChange={(e) => setMinify(e.target.checked)} />
        <span>
          <strong>{t('jsonsort.minify')}</strong> <span className="count-note">{t('jsonsort.minifyHint')}</span>
        </span>
      </label>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', opacity: minify ? 0.4 : 1 }}>
        <label className="count-note" style={{ minWidth: 90 }}>{t('jsonsort.indentLabel')}</label>
        <select className="mod-select" value={indent} disabled={minify} onChange={(e) => setIndent(e.target.value as IndentKind)}>
          <option value="two">{t('jsonsort.indent2')}</option>
          <option value="four">{t('jsonsort.indent4')}</option>
          <option value="tab">{t('jsonsort.indentTab')}</option>
        </select>
      </div>

      <label className="chk" style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={sortArrays} onChange={(e) => setSortArrays(e.target.checked)} />
        {t('jsonsort.sortArrays')}
      </label>

      <div className="mod-toolbar" style={{ marginTop: 14 }}>
        <button className="mini primary" onClick={doSort}>{t('jsonsort.sortBtn')}</button>
        <button className="mini" disabled={!canCopy} onClick={doCopy}>{t('jsonsort.copyBtn')}</button>
      </div>

      <label className="count-note" style={{ display: 'block', marginTop: 14, marginBottom: 4 }}>{t('jsonsort.outputLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={output}
        placeholder={t('jsonsort.outputPlaceholder')}
        style={{ width: '100%', minHeight: 150, whiteSpace: 'pre' }}
      />
    </div>
  );
}

// Surface the parser's own English/粵語 error. We stored plain-language messages
// on the result; map them to a single localised line the module owns.
function pickErr(t: (k: string) => string, res: SortResult): string {
  // res.errorEn always begins with our canonical prefix; feed the localised body.
  if (res.errorEn?.startsWith('Nothing to sort')) return t('jsonsort.errEmpty');
  return `${t('jsonsort.errInvalid')}${detail(res)}`;
}

function detail(res: SortResult): string {
  const en = res.errorEn ?? '';
  const dash = en.indexOf('— ');
  return dash >= 0 ? ` ${en.slice(dash + 2)}` : '';
}
