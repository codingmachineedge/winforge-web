import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type JsonlResult = {
  ok: boolean;
  output: string;
  records: number;
  validLines: number;
  invalidLines: number;
  errors: string[];
};

function splitLines(input: string): string[] {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function fail(msg: string): JsonlResult {
  return { ok: false, output: '', records: 0, validLines: 0, invalidLines: 0, errors: [msg] };
}

// Parse each non-blank line; report how many are valid/invalid, line number + error of each bad one.
function validate(input: string, lineLabel: (n: number, msg: string) => string): JsonlResult {
  const errors: string[] = [];
  let valid = 0;
  let invalid = 0;
  const lines = splitLines(input);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
      valid++;
    } catch (ex) {
      invalid++;
      errors.push(lineLabel(i + 1, ex instanceof Error ? ex.message : String(ex)));
    }
  }
  return { ok: true, output: '', records: valid, validLines: valid, invalidLines: invalid, errors };
}

// Wrap every non-blank line into a single pretty-printed JSON array. Bad lines are skipped and reported.
function toArray(input: string, lineLabel: (n: number, msg: string) => string): JsonlResult {
  const errors: string[] = [];
  const items: unknown[] = [];
  let valid = 0;
  let invalid = 0;
  const lines = splitLines(input);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      items.push(JSON.parse(line));
      valid++;
    } catch (ex) {
      invalid++;
      errors.push(lineLabel(i + 1, ex instanceof Error ? ex.message : String(ex)));
    }
  }
  return {
    ok: true,
    output: JSON.stringify(items, null, 2),
    records: valid,
    validLines: valid,
    invalidLines: invalid,
    errors,
  };
}

// Take a JSON array and emit one compact JSON value per line.
function fromArray(input: string, notArray: (kind: string) => string, emptyMsg: string): JsonlResult {
  const text = input.trim();
  if (text.length === 0) return fail(emptyMsg);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (ex) {
    return fail(ex instanceof Error ? ex.message : String(ex));
  }
  if (!Array.isArray(root)) {
    const kind = root === null ? 'Null' : Array.isArray(root) ? 'Array' : typeof root === 'object' ? 'Object' : typeof root;
    return fail(notArray(kind));
  }
  let out = '';
  let count = 0;
  for (const item of root) {
    out += JSON.stringify(item) + '\n';
    count++;
  }
  return { ok: true, output: out, records: count, validLines: count, invalidLines: 0, errors: [] };
}

// Pretty-print / minify each non-blank line. Bad lines are passed through and reported.
function transformEach(
  input: string,
  pretty: boolean,
  lineLabel: (n: number, msg: string) => string,
): JsonlResult {
  const errors: string[] = [];
  let valid = 0;
  let invalid = 0;
  let out = '';
  const lines = splitLines(input);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      out += (pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)) + '\n';
      valid++;
    } catch (ex) {
      invalid++;
      errors.push(lineLabel(i + 1, ex instanceof Error ? ex.message : String(ex)));
      out += raw + '\n';
    }
  }
  return { ok: true, output: out, records: valid, validLines: valid, invalidLines: invalid, errors };
}

const SAMPLE = '{"id":1,"name":"Ada","roles":["admin","dev"]}\n{"id":2,"name":"Linus","active":true}\n{"id":3,"name":"Grace"}';

export function JsonlToolsModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  const lineLabel = (n: number, msg: string) => t('jsonltools.lineError', { n, msg });

  // Live non-blank line count, shown only when there are no reported errors (mirrors WinForge).
  const nonBlank = useMemo(() => {
    let n = 0;
    for (const line of splitLines(input)) if (line.trim().length > 0) n++;
    return n;
  }, [input]);

  const apply = (r: JsonlResult, verb: string) => {
    if (!r.ok) {
      setErrors(r.errors);
      setStatusOk(false);
      setStatus(t('jsonltools.opFailed'));
      return;
    }
    setOutput(r.output);
    setErrors(r.errors);
    setStatusOk(true);
    const tail = r.invalidLines > 0 ? t('jsonltools.badTail', { count: r.invalidLines }) : '';
    setStatus(`${verb} — ${t('jsonltools.records', { count: r.records })}${tail}`);
  };

  const doValidate = () => {
    const r = validate(input, lineLabel);
    if (!r.ok) {
      setErrors(r.errors);
      setStatusOk(false);
      setStatus(t('jsonltools.couldNotValidate'));
      return;
    }
    setErrors(r.errors);
    setStatusOk(r.invalidLines === 0);
    if (r.invalidLines === 0) setStatus(t('jsonltools.allValid', { count: r.validLines }));
    else setStatus(t('jsonltools.someInvalid', { valid: r.validLines, invalid: r.invalidLines }));
  };

  const copy = () => {
    if (!output) {
      setStatusOk(false);
      setStatus(t('jsonltools.nothingToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(output);
    setStatusOk(true);
    setStatus(t('jsonltools.copied'));
  };

  // Status line: after any operation shows its result; otherwise falls back to the live line count.
  const statusText = status || t('jsonltools.lineCount', { count: nonBlank });

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 10 }}>
        {t('jsonltools.blurb')}
      </p>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={doValidate}>
          {t('jsonltools.validate')}
        </button>
        <button className="mini" onClick={() => apply(toArray(input, lineLabel), t('jsonltools.wrapped'))}>
          {t('jsonltools.toArray')}
        </button>
        <button
          className="mini"
          onClick={() =>
            apply(
              fromArray(input, (kind) => t('jsonltools.notArray', { kind }), t('jsonltools.emptyArray')),
              t('jsonltools.split'),
            )
          }
        >
          {t('jsonltools.fromArray')}
        </button>
        <button className="mini" onClick={() => apply(transformEach(input, true, lineLabel), t('jsonltools.prettied'))}>
          {t('jsonltools.pretty')}
        </button>
        <button className="mini" onClick={() => apply(transformEach(input, false, lineLabel), t('jsonltools.minified'))}>
          {t('jsonltools.minify')}
        </button>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('jsonltools.copy')}
        </button>
      </div>

      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('jsonltools.inputPlaceholder')}
        />
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={output}
          placeholder={t('jsonltools.outputPlaceholder')}
        />
      </div>

      <p
        className={statusOk ? 'count-note' : ''}
        style={statusOk ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {statusText}
      </p>

      {errors.length > 0 && (
        <div className="kv-list" style={{ marginTop: 4 }}>
          {errors.map((err, i) => (
            <div key={i} className="kv-row" style={{ color: 'var(--danger)', fontSize: 12.5 }}>
              {err}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
