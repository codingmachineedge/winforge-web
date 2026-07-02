import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const DELIMS: Record<string, string> = { comma: ',', tab: '\t', semicolon: ';', pipe: '|' };

function detectDelim(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? '';
  let best = ',';
  let max = -1;
  for (const d of [',', '\t', ';', '|']) {
    const n = first.split(d).length;
    if (n > max) {
      max = n;
      best = d;
    }
  }
  return best;
}

function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvField(v: string, delim: string): string {
  if (v.includes(delim) || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function CsvJsonModule() {
  const { t } = useTranslation();
  const [dir, setDir] = useState<'c2j' | 'j2c'>('c2j');
  const [delimKey, setDelimKey] = useState('auto');
  const [header, setHeader] = useState(true);
  const [input, setInput] = useState('name,age,city\nAda,36,London\nAlan,41,"Bletchley, UK"');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const convert = () => {
    try {
      if (dir === 'c2j') {
        const delim = delimKey === 'auto' ? detectDelim(input) : DELIMS[delimKey]!;
        const rows = parseCsv(input, delim).filter((r) => r.length > 1 || (r[0] ?? '') !== '');
        let out: unknown;
        if (header && rows.length) {
          const keys = rows[0]!;
          out = rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
        } else {
          out = rows;
        }
        setOutput(JSON.stringify(out, null, 2));
        setStatus({ ok: true, msg: t('csvjson.stat', { rows: rows.length - (header ? 1 : 0), cols: rows[0]?.length ?? 0 }) });
      } else {
        const delim = delimKey === 'auto' ? ',' : DELIMS[delimKey]!;
        const data = JSON.parse(input);
        const arr = Array.isArray(data) ? data : [data];
        let lines: string[];
        if (arr.length && typeof arr[0] === 'object' && !Array.isArray(arr[0])) {
          const keys = [...new Set(arr.flatMap((o: Record<string, unknown>) => Object.keys(o)))];
          lines = [keys.map((k) => csvField(k, delim)).join(delim)];
          for (const o of arr as Record<string, unknown>[]) {
            lines.push(keys.map((k) => csvField(o[k] == null ? '' : String(o[k]), delim)).join(delim));
          }
        } else {
          lines = (arr as unknown[][]).map((r) => (Array.isArray(r) ? r : [r]).map((v) => csvField(String(v ?? ''), delim)).join(delim));
        }
        setOutput(lines.join('\n'));
        setStatus({ ok: true, msg: t('csvjson.stat', { rows: arr.length, cols: 0 }) });
      }
    } catch (e) {
      setStatus({ ok: false, msg: String(e instanceof Error ? e.message : e) });
    }
  };

  const copy = () => {
    if (!output) return setStatus({ ok: false, msg: t('csvjson.nothing') });
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('csvjson.copied') });
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <select className="mod-select" value={dir} onChange={(e) => setDir(e.target.value as 'c2j' | 'j2c')}>
          <option value="c2j">CSV → JSON</option>
          <option value="j2c">JSON → CSV</option>
        </select>
        <span className="count-note">{t('csvjson.delimiter')}</span>
        <select className="mod-select" value={delimKey} onChange={(e) => setDelimKey(e.target.value)}>
          <option value="auto">{t('csvjson.auto')}</option>
          <option value="comma">{t('csvjson.comma')}</option>
          <option value="tab">{t('csvjson.tab')}</option>
          <option value="semicolon">{t('csvjson.semicolon')}</option>
          <option value="pipe">{t('csvjson.pipe')}</option>
        </select>
        <label className="chk">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          {t('csvjson.header')}
        </label>
        <button className="mini primary" onClick={convert}>
          {t('csvjson.convert')}
        </button>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('csvjson.copy')}
        </button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} placeholder={t('csvjson.placeholder')} value={input} onChange={(e) => setInput(e.target.value)} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('csvjson.outputPlaceholder')} />
      </div>
      {status && (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
