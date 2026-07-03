import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EnvPair = { key: string; value: string };

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ===== parse =====
function unquote(v: string): string {
  if (
    v.length >= 2 &&
    ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))
  ) {
    let inner = v.substring(1, v.length - 1);
    if (v[0] === '"') inner = inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return inner;
  }
  // strip a trailing inline comment on an unquoted value ( value # note )
  const hash = v.indexOf(' #');
  if (hash >= 0) v = v.substring(0, hash).replace(/\s+$/, '');
  return v;
}

function parseEnv(raw: string): EnvPair[] {
  const list: EnvPair[] = [];
  if (!raw) return list;
  try {
    for (const line0 of raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
      let line = line0.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.substring(7).replace(/^\s+/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) continue; // no key, skip
      const key = line.substring(0, eq).trim();
      const val = unquote(line.substring(eq + 1).trim());
      list.push({ key, value: val });
    }
  } catch {
    /* never throw */
  }
  return list;
}

// ===== validation =====
function validate(pairs: EnvPair[], t: (k: string, o?: Record<string, unknown>) => string): string[] {
  const warnings: string[] = [];
  try {
    const seen = new Set<string>();
    for (const p of pairs) {
      const k = p.key ?? '';
      if (k.length === 0) {
        warnings.push(t('envfile.warnEmptyKey'));
        continue;
      }
      if (!KEY_RE.test(k)) warnings.push(t('envfile.warnInvalidKey', { key: k }));
      if (seen.has(k)) warnings.push(t('envfile.warnDupKey', { key: k }));
      else seen.add(k);
      if (/\s/.test(p.value ?? '')) warnings.push(t('envfile.warnWhitespace', { key: k }));
    }
  } catch {
    /* never throw */
  }
  return warnings;
}

// ===== convert =====
function canonicalize(pairs: EnvPair[]): EnvPair[] {
  const order: string[] = [];
  const map = new Map<string, string>();
  for (const p of pairs) {
    const k = p.key ?? '';
    if (k.length === 0) continue;
    if (!map.has(k)) order.push(k);
    map.set(k, p.value ?? '');
  }
  return order.map((k) => ({ key: k, value: map.get(k)! }));
}

function needsQuote(v: string): boolean {
  return v.length === 0 || /[\s"'#$]/.test(v);
}

function doubleQuote(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function toShell(pairs: EnvPair[]): string {
  let out = '';
  for (const p of canonicalize(pairs)) out += 'export ' + p.key + '=' + doubleQuote(p.value) + '\n';
  return out;
}

function toJson(pairs: EnvPair[]): string {
  try {
    const dict: Record<string, string> = {};
    for (const p of canonicalize(pairs)) dict[p.key] = p.value;
    return JSON.stringify(dict, null, 2);
  } catch {
    return '{}';
  }
}

function toDocker(pairs: EnvPair[]): string {
  let out = '';
  for (const p of canonicalize(pairs)) {
    const v = needsQuote(p.value) ? doubleQuote(p.value) : p.value;
    out += '--env ' + p.key + '=' + v + '\n';
  }
  return out;
}

function toEnv(pairs: EnvPair[]): string {
  let out = '';
  for (const p of canonicalize(pairs)) {
    const v = needsQuote(p.value) ? doubleQuote(p.value) : p.value;
    out += p.key + '=' + v + '\n';
  }
  return out;
}

export function EnvFileModule() {
  const { t } = useTranslation();
  const [raw, setRaw] = useState('# paste .env here\nexport API_KEY="abc123"\nPORT=8080');
  const [pairs, setPairs] = useState<EnvPair[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState(t('envfile.ready'));
  const fileRef = useRef<HTMLInputElement | null>(null);

  const showWarnings = (ps: EnvPair[]) => {
    try {
      setWarnings(validate(ps, t));
    } catch {
      /* never throw */
    }
  };

  const parse = () => {
    try {
      const ps = parseEnv(raw);
      setPairs(ps);
      showWarnings(ps);
      setStatus(t('envfile.parsed', { count: ps.length }));
    } catch {
      /* never throw */
    }
  };

  const add = () => {
    const ps = [...pairs, { key: '', value: '' }];
    setPairs(ps);
    showWarnings(ps);
  };

  const removeAt = (i: number) => {
    const ps = pairs.filter((_, idx) => idx !== i);
    setPairs(ps);
    showWarnings(ps);
  };

  const editKey = (i: number, key: string) => {
    const ps = pairs.map((p, idx) => (idx === i ? { ...p, key } : p));
    setPairs(ps);
    showWarnings(ps);
  };
  const editValue = (i: number, value: string) => {
    const ps = pairs.map((p, idx) => (idx === i ? { ...p, value } : p));
    setPairs(ps);
    showWarnings(ps);
  };

  const emit = (text: string, kind: string) => {
    try {
      showWarnings(pairs);
      setOutput(text);
      setStatus(t('envfile.converted', { kind }));
    } catch (e) {
      setStatus(t('envfile.convertFailed') + (e instanceof Error ? e.message : String(e)));
    }
  };

  const copy = () => {
    const text = output ?? '';
    if (text.length === 0) {
      setStatus(t('envfile.nothingToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(text);
    setStatus(t('envfile.copied'));
  };

  const load = () => fileRef.current?.click();

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    file
      .text()
      .then((text) => {
        setRaw(text);
        const ps = parseEnv(text);
        setPairs(ps);
        showWarnings(ps);
        setStatus(t('envfile.loaded', { count: ps.length, name: file.name }));
      })
      .catch((err: unknown) => {
        setStatus(t('envfile.loadFailed') + (err instanceof Error ? err.message : String(err)));
      });
  };

  const save = () => {
    try {
      const text = toEnv(pairs);
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '.env';
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t('envfile.saved'));
    } catch (e) {
      setStatus(t('envfile.saveFailed') + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('envfile.blurb')}
      </p>

      {/* Raw input */}
      <h3 className="group-title" style={{ fontSize: 14, margin: '4px 0' }}>
        {t('envfile.rawTitle')}
      </h3>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={t('envfile.rawPlaceholder')}
        style={{ minHeight: 150, width: '100%' }}
      />
      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <button className="mini primary" onClick={parse}>
          {t('envfile.parse')}
        </button>
        <button className="mini" onClick={load}>
          {t('envfile.load')}
        </button>
        <button className="mini" onClick={save}>
          {t('envfile.save')}
        </button>
        <input ref={fileRef} type="file" accept=".env,.txt,text/plain" style={{ display: 'none' }} onChange={onFile} />
      </div>

      {/* Pairs editor */}
      <div className="mod-toolbar" style={{ marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('envfile.pairsTitle')}
        </h3>
        <button className="mini" onClick={add}>
          {t('envfile.add')}
        </button>
      </div>
      <div className="kv-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {pairs.length === 0 && <p className="count-note">{t('envfile.noPairs')}</p>}
        {pairs.map((p, i) => (
          <div className="kv-row" key={i}>
            <input
              className="mod-search"
              style={{ maxWidth: 220, flex: '0 0 220px', fontFamily: 'monospace' }}
              value={p.key}
              placeholder="KEY"
              onChange={(e) => editKey(i, e.target.value)}
            />
            <input
              className="mod-search"
              style={{ fontFamily: 'monospace' }}
              value={p.value}
              placeholder="value"
              onChange={(e) => editValue(i, e.target.value)}
            />
            <button className="mini" title={t('envfile.remove')} onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      {warnings.length > 0 && (
        <div style={{ color: 'var(--danger)', fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 4 }}>
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Convert */}
      <h3 className="group-title" style={{ fontSize: 14, margin: '14px 0 4px' }}>
        {t('envfile.convertTitle')}
      </h3>
      <div className="mod-toolbar">
        <button className="mini" onClick={() => emit(toShell(pairs), 'shell')}>
          {t('envfile.toShell')}
        </button>
        <button className="mini" onClick={() => emit(toJson(pairs), 'JSON')}>
          {t('envfile.toJson')}
        </button>
        <button className="mini" onClick={() => emit(toDocker(pairs), 'docker')}>
          {t('envfile.toDocker')}
        </button>
        <button className="mini" onClick={() => emit(toEnv(pairs), '.env')}>
          {t('envfile.toEnv')}
        </button>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('envfile.copyOutput')}
        </button>
      </div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={output}
        style={{ minHeight: 150, width: '100%', marginTop: 8, fontFamily: 'monospace' }}
      />

      <p className="count-note" style={{ marginTop: 10 }}>
        {status}
      </p>
    </div>
  );
}
