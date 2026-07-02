import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Obj = Record<string, unknown>;

function flatten(obj: unknown, sep: string, prefix: string, out: Obj): Obj {
  if (obj && typeof obj === 'object') {
    const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v] as const) : Object.entries(obj as Obj);
    if (entries.length === 0) {
      out[prefix] = Array.isArray(obj) ? [] : {};
      return out;
    }
    for (const [k, v] of entries) {
      const key = prefix ? prefix + sep + k : k;
      if (v && typeof v === 'object') flatten(v, sep, key, out);
      else out[key] = v;
    }
  } else if (prefix) {
    out[prefix] = obj;
  }
  return out;
}

function unflatten(flat: Obj, sep: string): unknown {
  const result: Obj = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split(sep);
    let cur: Obj = result;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (i === parts.length - 1) {
        cur[p] = flat[key];
      } else {
        const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
        if (cur[p] === undefined) cur[p] = nextIsIndex ? [] : {};
        cur = cur[p] as Obj;
      }
    }
  }
  return result;
}

export function JsonFlattenModule() {
  const { t } = useTranslation();
  const [sep, setSep] = useState('.');
  const [input, setInput] = useState('{\n  "user": {\n    "name": "Ada",\n    "roles": ["admin", "dev"]\n  },\n  "active": true\n}');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const run = (mode: 'flatten' | 'unflatten') => {
    try {
      const parsed = JSON.parse(input);
      const result = mode === 'flatten' ? flatten(parsed, sep, '', {}) : unflatten(parsed as Obj, sep);
      setOutput(JSON.stringify(result, null, 2));
      setStatus({ ok: true, msg: mode === 'flatten' ? t('flat.flattened') : t('flat.unflattened') });
    } catch (e) {
      setStatus({ ok: false, msg: String(e instanceof Error ? e.message : e) });
    }
  };

  const copy = () => {
    if (!output) return setStatus({ ok: false, msg: t('flat.nothing') });
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('flat.copied') });
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <span className="count-note">{t('flat.separator')}</span>
        <input className="mod-search" style={{ maxWidth: 70 }} value={sep} onChange={(e) => setSep(e.target.value || '.')} />
        <button className="mini primary" onClick={() => run('flatten')}>
          {t('flat.flatten')}
        </button>
        <button className="mini" onClick={() => run('unflatten')}>
          {t('flat.unflatten')}
        </button>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('flat.copy')}
        </button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('flat.inputPlaceholder')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('flat.outputPlaceholder')} />
      </div>
      {status && (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
