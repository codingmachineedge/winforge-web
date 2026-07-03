import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// JSON → 型別 · Faithful port of WinForge's JsonToTsService. Walks parsed JSON and
// emits TypeScript interfaces or C# classes. Nested objects become their own named
// types (BFS queue), arrays infer their element type. Pure client-side. Never throws.

type Lang = 'ts' | 'cs';

interface GenResult {
  ok: boolean;
  code: string;
  errorEn?: string;
  errorZh?: string;
  typeCount: number;
}

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

function kindOf(v: unknown): ValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  // undefined / function / symbol / bigint — treat as null-ish
  return 'null';
}

function pascal(s: string): string {
  if (!s) return '';
  let out = '';
  let upper = true;
  for (const c of s) {
    if (/[\p{L}\p{N}]/u.test(c)) {
      out += upper ? c.toUpperCase() : c;
      upper = false;
    } else {
      upper = true;
    }
  }
  if (out.length === 0) return '';
  if (/\d/.test(out[0]!)) out = '_' + out;
  return out;
}

function singularize(s: string): string {
  if (!s) return 'Item';
  const lower = s.toLowerCase();
  if (lower.endsWith('ies') && s.length > 3) return s.substring(0, s.length - 3) + 'y';
  if (lower.endsWith('ses') && s.length > 3) return s.substring(0, s.length - 2);
  if (lower.endsWith('s') && s.length > 1 && !lower.endsWith('ss')) return s.substring(0, s.length - 1);
  return s + 'Item';
}

// C# integer check: whole number that fits in a 64-bit long → "long", else "double".
function isLongLike(n: number): boolean {
  return Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
}

function safeMember(name: string, lang: Lang): string {
  if (lang !== 'ts') return name;
  let simple = name.length > 0 && /[A-Za-z_$]/.test(name[0]!);
  if (simple) {
    for (const c of name) {
      if (!/[A-Za-z0-9_$]/.test(c)) {
        simple = false;
        break;
      }
    }
  }
  return simple ? name : '"' + name.replace(/"/g, '\\"') + '"';
}

interface Entry {
  name: string;
  shape: Record<string, unknown>;
}

function firstObjectOrSelf(arr: unknown[]): unknown {
  for (const e of arr) if (kindOf(e) === 'object') return e;
  return arr;
}

// Enqueue a nested object shape under a unique name and return that name.
function uniqueName(
  baseName: string,
  seen: Set<string>,
  queue: Entry[],
  shape: Record<string, unknown>,
): string {
  const name = baseName || 'Item';
  let candidate = name;
  let i = 2;
  while (seen.has(candidate)) candidate = name + i++;
  seen.add(candidate);
  queue.push({ name: candidate, shape });
  return candidate;
}

function typeOf(
  value: unknown,
  suggestedName: string,
  lang: Lang,
  seen: Set<string>,
  queue: Entry[],
): string {
  switch (kindOf(value)) {
    case 'string':
      return 'string';
    case 'number':
      if (lang === 'ts') return 'number';
      return isLongLike(value as number) ? 'long' : 'double';
    case 'boolean':
      return lang === 'ts' ? 'boolean' : 'bool';
    case 'null':
      return lang === 'ts' ? 'any' : 'object';
    case 'object':
      return uniqueName(suggestedName, seen, queue, value as Record<string, unknown>);
    case 'array': {
      const arr = value as unknown[];
      if (arr.length === 0) return lang === 'ts' ? 'any[]' : 'List<object>';
      const elem = arr[0];
      let elemType: string;
      if (kindOf(elem) === 'object') {
        const singular = singularize(suggestedName);
        elemType = uniqueName(singular, seen, queue, elem as Record<string, unknown>);
      } else {
        elemType = typeOf(elem, singularize(suggestedName), lang, seen, queue);
      }
      return lang === 'ts' ? elemType + '[]' : 'List<' + elemType + '>';
    }
    default:
      return lang === 'ts' ? 'any' : 'object';
  }
}

function emitType(
  parts: string[],
  name: string,
  shape: Record<string, unknown>,
  lang: Lang,
  seen: Set<string>,
  queue: Entry[],
): void {
  if (lang === 'ts') {
    let s = `export interface ${name} {\n`;
    for (const [propName, propValue] of Object.entries(shape)) {
      const optional = kindOf(propValue) === 'null';
      const type = typeOf(propValue, pascal(propName), lang, seen, queue);
      s += `  ${safeMember(propName, lang)}${optional ? '?: ' : ': '}${type};\n`;
    }
    s += '}\n';
    parts.push(s);
  } else {
    let s = `public class ${name}\n{\n`;
    for (const [propName, propValue] of Object.entries(shape)) {
      const nullable = kindOf(propValue) === 'null';
      let type = typeOf(propValue, pascal(propName), lang, seen, queue);
      if (nullable && !type.endsWith('?') && !type.endsWith('>') && !type.endsWith('[]')) type += '?';
      s += `    public ${type} ${pascal(propName)} { get; set; }\n`;
    }
    s += '}\n';
    parts.push(s);
  }
}

function generate(json: string, rootNameRaw: string, lang: Lang): GenResult {
  if (!json || !json.trim())
    return { ok: false, code: '', typeCount: 0, errorEn: 'Paste a JSON sample to begin.', errorZh: '貼一段 JSON 樣本先開始。' };

  let rootName = pascal(rootNameRaw && rootNameRaw.trim() ? rootNameRaw : 'Root');
  if (!rootName) rootName = 'Root';

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, code: '', typeCount: 0, errorEn: 'Invalid JSON: ' + m, errorZh: 'JSON 格式唔啱：' + m };
  }

  try {
    let root = parsed;
    // Unwrap a top-level array so a sample list still gives a useful element type.
    if (kindOf(root) === 'array') root = firstObjectOrSelf(root as unknown[]);

    if (kindOf(root) !== 'object')
      return {
        ok: false,
        code: '',
        typeCount: 0,
        errorEn: 'The sample must be a JSON object (or an array of objects) to generate types.',
        errorZh: '樣本要係一個 JSON 物件（或者物件陣列）先可以生成型別。',
      };

    const seen = new Set<string>();
    const queue: Entry[] = [];
    const parts: string[] = [];

    // Enqueue the root (dedupe by name, case-insensitive in WinForge; we mirror by
    // lower-casing the seen check for the root only via the same Set semantics).
    seen.add(rootName);
    queue.push({ name: rootName, shape: root as Record<string, unknown> });

    let count = 0;
    while (queue.length > 0) {
      const item = queue.shift()!;
      emitType(parts, item.name, item.shape, lang, seen, queue);
      count++;
      if (count > 500) break; // pathological-input guard
    }

    const code = parts.join('\n').replace(/\s+$/, '') + '\n';
    return { ok: true, code, typeCount: count };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, code: '', typeCount: 0, errorEn: 'Generation failed: ' + m, errorZh: '生成失敗：' + m };
  }
}

const SAMPLE = `{
  "id": 42,
  "name": "Ada",
  "active": true,
  "roles": ["admin", "dev"],
  "profile": { "city": "Toronto", "since": 2019 }
}`;

export function JsonToTsModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [input, setInput] = useState(SAMPLE);
  const [rootName, setRootName] = useState('Root');
  const [lang, setLang] = useState<Lang>('ts');
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => generate(input, rootName, lang), [input, rootName, lang]);

  const status = result.ok
    ? t('jsontots.okCount', { count: result.typeCount })
    : zh
      ? result.errorZh ?? t('jsontots.couldNotGenerate')
      : result.errorEn ?? t('jsontots.couldNotGenerate');

  const copy = () => {
    if (!result.ok || !result.code) {
      setCopied(false);
      return;
    }
    void navigator.clipboard?.writeText(result.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('jsontots.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('jsontots.rootLabel')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={rootName}
          onChange={(e) => setRootName(e.target.value)}
          placeholder="Root"
        />
        <span className="count-note">{t('jsontots.langLabel')}</span>
        <select className="mod-select" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          <option value="ts">{t('jsontots.tsInterface')}</option>
          <option value="cs">{t('jsontots.csClass')}</option>
        </select>
        <button className="mini" disabled={!result.ok || !result.code} onClick={copy}>
          {copied ? t('jsontots.copied') : t('jsontots.copy')}
        </button>
        <button className="mini" onClick={() => setInput('')}>
          {t('jsontots.clear')}
        </button>
      </div>

      <div className="io-grid">
        <div>
          <div className="count-note" style={{ marginBottom: 4 }}>
            {t('jsontots.inputLabel')}
          </div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('jsontots.inputPlaceholder')}
          />
        </div>
        <div>
          <div className="count-note" style={{ marginBottom: 4 }}>
            {t('jsontots.outputLabel')}
          </div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={result.ok ? result.code : ''}
            placeholder={t('jsontots.outputPlaceholder')}
          />
        </div>
      </div>

      <p
        className={result.ok ? 'count-note' : ''}
        style={result.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {input.trim() ? status : t('jsontots.waiting')}
      </p>
    </div>
  );
}
