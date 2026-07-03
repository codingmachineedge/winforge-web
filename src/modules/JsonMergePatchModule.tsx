import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Structural equality for JSON values (mirrors JsonNode.DeepEquals).
function deepEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEquals(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// RFC 7386 §2 — MergePatch(target, patch).
function merge(target: Json, patch: Json): Json {
  if (!isObject(patch)) return patch; // non-object patch replaces the whole document

  // A non-object target becomes {} before merging (RFC 7386 §2).
  const result: Record<string, Json> = isObject(target) ? { ...target } : {};

  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val === null) {
      delete result[key]; // null deletes the key
    } else {
      result[key] = merge(result[key] ?? null, val);
    }
  }
  return result;
}

// RFC 7386-derived diff: smallest patch whose merge(source, patch) == target.
function diff(source: Json, target: Json): Json {
  if (isObject(source) && isObject(target)) {
    const patch: Record<string, Json> = {};

    // Keys present in target: add/update where they differ.
    for (const key of Object.keys(target)) {
      const tgtChild = target[key];
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        patch[key] = tgtChild; // new key
      } else if (!deepEquals(source[key], tgtChild)) {
        patch[key] = diff(source[key], tgtChild);
      }
    }

    // Keys removed in target: emit null to delete.
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        patch[key] = null;
      }
    }

    return patch; // may be empty {} when nothing changed
  }

  // Otherwise (arrays / scalars / type change / null) — replace whole.
  return target;
}

const SRC_SAMPLE = `{
  "title": "Goodbye!",
  "author": { "givenName": "John", "familyName": "Doe" },
  "tags": [ "example", "sample" ],
  "content": "This will be unchanged"
}`;
const TGT_SAMPLE_GEN = `{
  "title": "Hello!",
  "author": { "givenName": "John" },
  "tags": [ "example" ],
  "content": "This will be unchanged",
  "phoneNumber": "+01-123-456-7890"
}`;
const PATCH_SAMPLE_APPLY = `{
  "title": "Hello!",
  "author": { "familyName": null },
  "phoneNumber": "+01-123-456-7890",
  "tags": [ "example" ]
}`;

type Mode = 'generate' | 'apply';

export function JsonMergePatchModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('generate');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const isGenerate = mode === 'generate';

  // Parse with a bilingual, labelled error — mirrors JsonMergePatchService.TryParse.
  const tryParse = (text: string, label: string): { node: Json; err?: undefined } | { node?: undefined; err: string } => {
    if (!text.trim()) return { err: t('jsonmergepatch.empty', { label }) };
    try {
      return { node: JSON.parse(text) as Json };
    } catch (e) {
      return { err: t('jsonmergepatch.invalid', { label, msg: e instanceof Error ? e.message : String(e) }) };
    }
  };

  const run = () => {
    if (isGenerate) {
      const s = tryParse(left, t('jsonmergepatch.source'));
      if (s.err !== undefined) return void setStatus({ ok: false, msg: s.err });
      const g = tryParse(right, t('jsonmergepatch.target'));
      if (g.err !== undefined) return void setStatus({ ok: false, msg: g.err });
      try {
        const patch = diff(s.node, g.node);
        setOutput(JSON.stringify(patch, null, 2));
        setStatus({ ok: true, msg: t('jsonmergepatch.generated') });
      } catch (e) {
        setStatus({ ok: false, msg: t('jsonmergepatch.genFail', { msg: e instanceof Error ? e.message : String(e) }) });
      }
    } else {
      const d = tryParse(left, t('jsonmergepatch.document'));
      if (d.err !== undefined) return void setStatus({ ok: false, msg: d.err });
      const p = tryParse(right, t('jsonmergepatch.patch'));
      if (p.err !== undefined) return void setStatus({ ok: false, msg: p.err });
      try {
        const merged = merge(d.node, p.node);
        setOutput(JSON.stringify(merged, null, 2));
        setStatus({ ok: true, msg: t('jsonmergepatch.applied') });
      } catch (e) {
        setStatus({ ok: false, msg: t('jsonmergepatch.applyFail', { msg: e instanceof Error ? e.message : String(e) }) });
      }
    }
  };

  const loadSample = () => {
    if (isGenerate) {
      setLeft(SRC_SAMPLE);
      setRight(TGT_SAMPLE_GEN);
    } else {
      setLeft(SRC_SAMPLE);
      setRight(PATCH_SAMPLE_APPLY);
    }
    setStatus(null);
  };

  const copy = () => {
    if (!output) return;
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('jsonmergepatch.copied') });
  };

  const changeMode = (m: Mode) => {
    setMode(m);
    setStatus(null);
  };

  const leftLabel = isGenerate ? t('jsonmergepatch.sourceJson') : t('jsonmergepatch.documentJson');
  const rightLabel = isGenerate ? t('jsonmergepatch.targetJson') : t('jsonmergepatch.patchJson');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginBottom: 10 }}>{t('jsonmergepatch.blurb')}</p>

      <div className="mod-toolbar">
        <span className="count-note">{t('jsonmergepatch.mode')}</span>
        <select className="mod-search" style={{ maxWidth: 260 }} value={mode} onChange={(e) => changeMode(e.target.value as Mode)}>
          <option value="generate">{t('jsonmergepatch.modeGenerate')}</option>
          <option value="apply">{t('jsonmergepatch.modeApply')}</option>
        </select>
        <button className="mini primary" onClick={run}>
          {isGenerate ? t('jsonmergepatch.generate') : t('jsonmergepatch.apply')}
        </button>
        <button className="mini" onClick={loadSample}>{t('jsonmergepatch.loadSample')}</button>
        <button className="mini" disabled={!output} onClick={copy}>{t('jsonmergepatch.copyResult')}</button>
      </div>

      <p className="count-note" style={{ marginTop: 0, marginBottom: 10, fontSize: 12 }}>{t('jsonmergepatch.note')}</p>

      <div className="io-grid">
        <div>
          <div className="count-note" style={{ fontWeight: 600, marginBottom: 4 }}>{leftLabel}</div>
          <textarea className="hosts-edit" spellCheck={false} value={left} onChange={(e) => setLeft(e.target.value)} placeholder={leftLabel} />
        </div>
        <div>
          <div className="count-note" style={{ fontWeight: 600, marginBottom: 4 }}>{rightLabel}</div>
          <textarea className="hosts-edit" spellCheck={false} value={right} onChange={(e) => setRight(e.target.value)} placeholder={rightLabel} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="count-note" style={{ fontWeight: 600, marginBottom: 4 }}>{t('jsonmergepatch.result')}</div>
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('jsonmergepatch.result')} />
      </div>

      {status && (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
