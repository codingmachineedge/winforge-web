import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface RenderResult {
  ok: boolean;
  output: string;
  errorKey?: string;
  errorArg?: string;
  substituted: number;
  missing: number;
}

/** Flatten a parsed JSON value into dotted-path string entries (a.b.c -> value). */
function flatten(prefix: string, value: unknown, map: Map<string, string>): void {
  if (value === null) {
    if (prefix.length > 0) map.set(prefix.toLowerCase(), '');
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const key = prefix.length === 0 ? String(i) : `${prefix}.${i}`;
      flatten(key, value[i], map);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix.length === 0 ? k : `${prefix}.${k}`;
      flatten(key, v, map);
    }
    return;
  }
  // string / number / boolean primitive
  if (prefix.length > 0) {
    if (typeof value === 'string') map.set(prefix.toLowerCase(), value);
    else map.set(prefix.toLowerCase(), String(value));
  }
}

/** Turn a JSON object OR key=value / key: value lines into a flat, case-insensitive lookup map. Throws on malformed JSON. */
function parseData(data: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = data.replace(/^\s+/, '');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // May throw SyntaxError — caller handles it.
    const parsed = JSON.parse(data);
    flatten('', parsed, map);
    return map;
  }

  // Fallback: key=value (or key: value) lines, one per line.
  const lines = data.replace(/\r\n/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
    if (sep <= 0) continue;
    const key = line.substring(0, sep).trim();
    const val = line.substring(sep + 1).trim();
    if (key.length > 0) map.set(key.toLowerCase(), val);
  }
  return map;
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim();
  if (t.length === 0) return false;
  if (t === '0') return false;
  if (t.toLowerCase() === 'false') return false;
  if (t.toLowerCase() === 'no') return false;
  if (t.toLowerCase() === 'null') return false;
  return true;
}

/** Resolve {{#if key}}body{{/if}} — innermost-first, robust to nesting. */
function processIfBlocks(template: string, map: Map<string, string>): string {
  const openStart = '{{#if';
  const close = '{{/if}}';
  let tpl = template;
  for (let guard = 0; guard < 500; guard++) {
    const closeIdx = tpl.indexOf(close);
    if (closeIdx < 0) break;

    // Nearest #if open before this close.
    const openIdx = tpl.lastIndexOf(openStart, closeIdx);
    if (openIdx < 0) break; // dangling {{/if}} — leave the rest alone.

    const openTagEnd = tpl.indexOf('}}', openIdx);
    if (openTagEnd < 0 || openTagEnd > closeIdx) break; // malformed open — stop cleanly.

    const keyExpr = tpl.substring(openIdx + openStart.length, openTagEnd).trim();
    const body = tpl.substring(openTagEnd + 2, closeIdx);

    const val = map.get(keyExpr.toLowerCase());
    const replacement = truthy(val) ? body : '';

    tpl = tpl.substring(0, openIdx) + replacement + tpl.substring(closeIdx + close.length);
  }
  return tpl;
}

/** Replace {{key}} tokens (ignores control tokens which are handled earlier). */
function replaceTokens(template: string, map: Map<string, string>, passthrough: boolean, result: RenderResult): string {
  let out = '';
  let i = 0;
  const len = template.length;
  while (i < len) {
    const open = template.indexOf('{{', i);
    if (open < 0) {
      out += template.substring(i);
      break;
    }
    out += template.substring(i, open);

    const end = template.indexOf('}}', open + 2);
    if (end < 0) {
      out += template.substring(open);
      break;
    }

    const token = template.substring(open + 2, end).trim();

    if (token.startsWith('#if') || token === '/if') {
      i = end + 2;
      continue;
    }

    const val = map.get(token.toLowerCase());
    if (val !== undefined) {
      out += val;
      result.substituted++;
    } else {
      result.missing++;
      if (passthrough) out += `{{${token}}}`;
      // else: empty string
    }
    i = end + 2;
  }
  return out;
}

/** Faithful port of WinForge TextTemplateService.Render — never throws. */
function render(template: string, data: string, passthrough: boolean): RenderResult {
  const result: RenderResult = { ok: false, output: '', substituted: 0, missing: 0 };
  const tpl = template ?? '';
  const dat = data ?? '';

  let map: Map<string, string>;
  try {
    map = parseData(dat);
  } catch (e) {
    result.ok = false;
    result.output = '';
    result.errorKey = 'texttemplate.errBadJson';
    result.errorArg = e instanceof Error ? e.message : String(e);
    return result;
  }

  try {
    const withIfs = processIfBlocks(tpl, map);
    result.output = replaceTokens(withIfs, map, passthrough, result);
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.output = '';
    result.errorKey = 'texttemplate.errRenderFailed';
    result.errorArg = e instanceof Error ? e.message : String(e);
  }
  return result;
}

function statusText(t: TFunction, res: RenderResult): { msg: string; ok: boolean } {
  if (!res.ok) {
    if (res.errorKey) return { msg: t(res.errorKey, { msg: res.errorArg ?? '' }), ok: false };
    return { msg: t('texttemplate.errGeneric'), ok: false };
  }
  if (res.missing > 0) {
    return { msg: t('texttemplate.statusMissing', { filled: res.substituted, missing: res.missing }), ok: true };
  }
  return { msg: t('texttemplate.statusOk', { filled: res.substituted }), ok: true };
}

const DEFAULT_TEMPLATE = 'Hello {{name}}!\n{{#if vip}}Thanks for being a VIP.{{/if}}\nAccount: {{account.id}}';
const DEFAULT_DATA = '{\n  "name": "Sam",\n  "vip": true,\n  "account": { "id": "A-42" }\n}';

export function TextTemplateModule() {
  const { t } = useTranslation();
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [data, setData] = useState(DEFAULT_DATA);
  const [passthrough, setPassthrough] = useState(false);
  const [copied, setCopied] = useState(false);

  const res = useMemo(() => render(template, data, passthrough), [template, data, passthrough]);
  const status = useMemo(() => statusText(t, res), [t, res]);

  const copy = () => {
    if (!res.output) return;
    navigator.clipboard?.writeText(res.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('texttemplate.blurb')}</p>

      <div className="io-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="label">{t('texttemplate.template')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={t('texttemplate.templatePlaceholder')}
            style={{ minHeight: 160, fontFamily: 'monospace' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="label">{t('texttemplate.data')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={data}
            onChange={(e) => setData(e.target.value)}
            placeholder={t('texttemplate.dataPlaceholder')}
            style={{ minHeight: 160, fontFamily: 'monospace' }}
          />
          <span className="count-note">{t('texttemplate.dataHint')}</span>
        </div>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 10 }}>
        <label className="chk">
          <input type="checkbox" checked={passthrough} onChange={(e) => setPassthrough(e.target.checked)} />{' '}
          {t('texttemplate.passthrough')}
        </label>
        <button className="mini primary" disabled={!res.output} onClick={copy}>
          {copied ? t('texttemplate.copied') : t('texttemplate.copy')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        <label className="label">{t('texttemplate.output')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={res.output}
          style={{ minHeight: 160, fontFamily: 'monospace' }}
        />
      </div>

      <p className="count-note" style={{ color: status.ok ? undefined : 'var(--danger)' }}>{status.msg}</p>
    </div>
  );
}
