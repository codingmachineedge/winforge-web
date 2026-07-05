import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface KeyCount {
  key: string;
  count: number;
}

interface JsonStatResult {
  ok: boolean;
  error?: string;
  totalNodes: number;
  objectCount: number;
  arrayCount: number;
  maxDepth: number;
  totalKeys: number;
  uniqueKeys: number;
  stringCount: number;
  numberCount: number;
  booleanCount: number;
  nullCount: number;
  largestArray: number;
  stringChars: number;
  byteSize: number;
  keys: KeyCount[];
}

function emptyResult(): JsonStatResult {
  return {
    ok: false,
    totalNodes: 0,
    objectCount: 0,
    arrayCount: 0,
    maxDepth: 0,
    totalKeys: 0,
    uniqueKeys: 0,
    stringCount: 0,
    numberCount: 0,
    booleanCount: 0,
    nullCount: 0,
    largestArray: 0,
    stringChars: 0,
    byteSize: 0,
    keys: [],
  };
}

// Recursively walk a parsed JSON value, mirroring JsonStatService.Walk.
function walk(value: unknown, depth: number, r: JsonStatResult, tally: Map<string, number>): void {
  if (depth > r.maxDepth) r.maxDepth = depth;
  r.totalNodes++;

  if (value === null) {
    r.nullCount++;
    return;
  }
  if (Array.isArray(value)) {
    r.arrayCount++;
    let len = 0;
    for (const item of value) {
      len++;
      walk(item, depth + 1, r, tally);
    }
    if (len > r.largestArray) r.largestArray = len;
    return;
  }
  switch (typeof value) {
    case 'object': {
      r.objectCount++;
      for (const [name, propVal] of Object.entries(value as Record<string, unknown>)) {
        r.totalKeys++;
        tally.set(name, (tally.get(name) ?? 0) + 1);
        walk(propVal, depth + 1, r, tally);
      }
      break;
    }
    case 'string':
      r.stringCount++;
      r.stringChars += (value as string).length;
      break;
    case 'number':
      r.numberCount++;
      break;
    case 'boolean':
      r.booleanCount++;
      break;
    default:
      break;
  }
}

// Analyze JSON text — never throws; parse failures surface via .error.
function analyze(json: string | undefined): JsonStatResult {
  const r = emptyResult();

  if (!json || json.trim().length === 0) {
    r.error = 'empty';
    return r;
  }

  try {
    r.byteSize = new TextEncoder().encode(json).length;
  } catch {
    r.byteSize = 0;
  }

  const tally = new Map<string, number>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    r.ok = false;
    r.error = e instanceof Error ? e.message : String(e);
    return r;
  }

  walk(parsed, 1, r, tally);
  r.ok = true;

  r.uniqueKeys = tally.size;
  for (const [key, count] of tally) r.keys.push({ key, count });
  r.keys.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return r;
}

const nf = new Intl.NumberFormat('en-US');
const n0 = (v: number) => nf.format(v);

const SAMPLE = `{
  "name": "WinForge",
  "version": 3,
  "active": true,
  "tags": ["tools", "bilingual", "win11"],
  "author": { "name": "Kei", "roles": ["admin", "dev"] },
  "settings": { "theme": "dark", "notify": null }
}`;

export function JsonStatModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE);
  const [msg, setMsg] = useState('');

  const result = useMemo(() => analyze(input), [input]);

  const status = (() => {
    if (!result.ok && result.error === 'empty') return t('jsonstat.waiting');
    if (!result.ok) return t('jsonstat.invalid') + (result.error ?? '');
    return t('jsonstat.valid');
  })();

  const rows: { label: string; value: string }[] = result.ok
    ? [
        { label: t('jsonstat.totalNodes'), value: n0(result.totalNodes) },
        { label: t('jsonstat.objects'), value: n0(result.objectCount) },
        { label: t('jsonstat.arrays'), value: n0(result.arrayCount) },
        { label: t('jsonstat.maxDepth'), value: n0(result.maxDepth) },
        { label: t('jsonstat.totalKeys'), value: n0(result.totalKeys) },
        { label: t('jsonstat.uniqueKeys'), value: n0(result.uniqueKeys) },
        { label: t('jsonstat.strings'), value: n0(result.stringCount) },
        { label: t('jsonstat.numbers'), value: n0(result.numberCount) },
        { label: t('jsonstat.booleans'), value: n0(result.booleanCount) },
        { label: t('jsonstat.nulls'), value: n0(result.nullCount) },
        { label: t('jsonstat.largestArray'), value: n0(result.largestArray) },
        { label: t('jsonstat.stringChars'), value: n0(result.stringChars) },
        { label: t('jsonstat.byteSize'), value: n0(result.byteSize) },
      ]
    : [];

  const keysEmpty = result.ok && result.keys.length === 0;

  const copyReport = () => {
    try {
      const r = result;
      const lines: string[] = [];
      if (!r.ok) {
        lines.push(t('jsonstat.reportInvalid'));
        if (r.error && r.error !== 'empty') lines.push(r.error);
      } else {
        lines.push(t('jsonstat.reportTitle'));
        lines.push(t('jsonstat.rTotalNodes') + n0(r.totalNodes));
        lines.push(t('jsonstat.rObjects') + n0(r.objectCount));
        lines.push(t('jsonstat.rArrays') + n0(r.arrayCount));
        lines.push(t('jsonstat.rMaxDepth') + n0(r.maxDepth));
        lines.push(t('jsonstat.rTotalKeys') + n0(r.totalKeys));
        lines.push(t('jsonstat.rUniqueKeys') + n0(r.uniqueKeys));
        lines.push(t('jsonstat.rStrings') + n0(r.stringCount));
        lines.push(t('jsonstat.rNumbers') + n0(r.numberCount));
        lines.push(t('jsonstat.rBooleans') + n0(r.booleanCount));
        lines.push(t('jsonstat.rNulls') + n0(r.nullCount));
        lines.push(t('jsonstat.rLargestArray') + n0(r.largestArray));
        lines.push(t('jsonstat.rStringChars') + n0(r.stringChars));
        lines.push(t('jsonstat.rByteSize') + n0(r.byteSize));
        lines.push('');
        lines.push(t('jsonstat.rKeysHeader'));
        for (const k of r.keys) lines.push(`  ${k.key} × ${k.count}`);
      }
      void navigator.clipboard?.writeText(lines.join('\n'));
      setMsg(t('jsonstat.copied'));
    } catch (e) {
      setMsg(t('jsonstat.copyFailed') + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('jsonstat.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note" style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>
          {t('jsonstat.inputLabel')}
        </span>
        <button className="mini primary" onClick={copyReport}>
          {t('jsonstat.copyReport')}
        </button>
        <button className="mini" onClick={() => (setInput(''), setMsg(''))}>
          {t('jsonstat.clear')}
        </button>
      </div>

      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ minHeight: 170, fontFamily: 'Consolas, monospace' }}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('jsonstat.inputPlaceholder')}
      />

      <p
        className={result.ok ? 'count-note' : ''}
        style={result.ok ? { marginTop: 8 } : { marginTop: 8, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {status}
        {msg ? ` · ${msg}` : ''}
      </p>

      <h3 className="group-title" style={{ fontSize: 14, marginTop: 16, marginBottom: 6 }}>
        {t('jsonstat.statistics')}
      </h3>
      {rows.length > 0 ? (
        <div className="kv-list">
          {rows.map((row) => (
            <div className="kv-row" key={row.label}>
              <span>{row.label}</span>
              <span style={{ fontWeight: 600, fontFamily: 'Consolas, monospace' }}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="count-note" style={{ marginTop: 0 }}>
          {status}
        </p>
      )}

      <h3 className="group-title" style={{ fontSize: 14, marginTop: 16, marginBottom: 6 }}>
        {t('jsonstat.keysLabel')}
      </h3>
      {result.ok && result.keys.length > 0 ? (
        <div className="dt-wrap" style={{ maxHeight: 320 }}>
          <table className="dt">
            <tbody>
              {result.keys.map((k) => (
                <tr key={k.key}>
                  <td>
                    <code>{k.key}</code>
                  </td>
                  <td className="env-val" style={{ width: 80, fontWeight: 600 }}>
                    {n0(k.count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="count-note" style={{ marginTop: 0 }}>
          {keysEmpty ? t('jsonstat.noKeys') : status}
        </p>
      )}
    </div>
  );
}
