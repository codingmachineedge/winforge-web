import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TextEscapeService (multi-language string escaper/unescaper).
type Lang = 'json' | 'csharp' | 'javascript' | 'java' | 'python' | 'html' | 'url' | 'shell' | 'regex' | 'csv' | 'sql';
type Res = { ok: boolean; text: string };

function cStyleEscape(s: string, quote: string): string {
  let out = '';
  for (const c of s) {
    switch (c) {
      case '\\': out += '\\\\'; break;
      case '\0': out += '\\0'; break;
      case '\x07': out += '\\a'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\v': out += '\\v'; break;
      default: {
        const code = c.charCodeAt(0);
        if (c === quote) out += '\\' + quote;
        else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
        else out += c;
      }
    }
  }
  return out;
}

function cStyleUnescape(s: string): Res {
  let out = '';
  const hex = (h: string) => (/^[0-9a-fA-F]+$/.test(h) ? parseInt(h, 16) : NaN);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') { out += c; continue; }
    if (i + 1 >= s.length) return { ok: false, text: s };
    const n = s[++i]!;
    switch (n) {
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '`': out += '`'; break;
      case '0': out += '\0'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case 'u': {
        if (i + 4 >= s.length) return { ok: false, text: s };
        const u = hex(s.slice(i + 1, i + 5));
        if (Number.isNaN(u)) return { ok: false, text: s };
        out += String.fromCharCode(u); i += 4; break;
      }
      case 'x': {
        let start = i + 1, len = 0;
        while (len < 4 && start + len < s.length && /[0-9a-fA-F]/.test(s[start + len]!)) len++;
        if (len === 0) return { ok: false, text: s };
        out += String.fromCharCode(hex(s.slice(start, start + len))); i += len; break;
      }
      case 'U': {
        if (i + 8 >= s.length) return { ok: false, text: s };
        const big = hex(s.slice(i + 1, i + 9));
        if (Number.isNaN(big) || big > 0x10ffff) return { ok: false, text: s };
        out += String.fromCodePoint(big); i += 8; break;
      }
      default: return { ok: false, text: s };
    }
  }
  return { ok: true, text: out };
}

const htmlEncode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function htmlDecode(s: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
const shellSingleQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function shellUnwrap(s: string): string {
  let out = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQ) { if (c === "'") inQ = false; else out += c; }
    else if (c === "'") inQ = true;
    else if (c === '\\' && s[i + 1] === "'") { out += "'"; i++; }
    else out += c;
  }
  return out;
}
// .NET Regex.Escape: metachars + '#' + whitespace → escaped forms.
function regexEscape(s: string): string {
  let out = '';
  for (const c of s) {
    if ('\\*+?|{[()^$.#'.includes(c)) out += '\\' + c;
    else if (c === ' ') out += '\\ ';
    else if (c === '\t') out += '\\t';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\f') out += '\\f';
    else if (c === '\v') out += '\\v';
    else out += c;
  }
  return out;
}
function regexUnescape(s: string): Res {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') { out += c; continue; }
    if (i + 1 >= s.length) return { ok: false, text: s };
    const n = s[++i]!;
    switch (n) {
      case 't': out += '\t'; break; case 'n': out += '\n'; break; case 'r': out += '\r'; break;
      case 'f': out += '\f'; break; case 'v': out += '\v'; break; case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break; case 'e': out += '\x1b'; break; case ' ': out += ' '; break;
      case 'u': {
        const h = s.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) return { ok: false, text: s };
        out += String.fromCharCode(parseInt(h, 16)); i += 4; break;
      }
      case 'x': {
        const h = s.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return { ok: false, text: s };
        out += String.fromCharCode(parseInt(h, 16)); i += 2; break;
      }
      default: out += n; // \. \\ \* etc → literal
    }
  }
  return { ok: true, text: out };
}
function csvEscape(s: string): string {
  const need = s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r');
  const body = s.replace(/"/g, '""');
  return need ? '"' + body + '"' : body;
}
function csvUnescape(s: string): Res {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '"') {
        if (inner[i + 1] === '"') { out += '"'; i++; }
        else return { ok: false, text: s };
      } else out += inner[i];
    }
    return { ok: true, text: out };
  }
  return { ok: true, text: s };
}
const sqlEscape = (s: string) => s.replace(/'/g, "''");
function sqlUnescape(s: string): string {
  let t = s;
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) t = t.slice(1, -1);
  return t.replace(/''/g, "'");
}

function jsonEscape(s: string): string {
  const q = JSON.stringify(s);
  return q.length >= 2 ? q.slice(1, -1) : q;
}
function jsonUnescape(s: string): Res {
  try {
    let body = s;
    if (!(body.length >= 2 && body.startsWith('"') && body.endsWith('"'))) body = '"' + s.replace(/"/g, '\\"') + '"';
    const v = JSON.parse(body);
    return { ok: typeof v === 'string', text: typeof v === 'string' ? v : s };
  } catch { return { ok: false, text: s }; }
}

function escape(lang: Lang, s: string): Res {
  try {
    switch (lang) {
      case 'json': return { ok: true, text: jsonEscape(s) };
      case 'csharp': case 'javascript': case 'java': case 'python': return { ok: true, text: cStyleEscape(s, '"') };
      case 'html': return { ok: true, text: htmlEncode(s) };
      case 'url': return { ok: true, text: encodeURIComponent(s) };
      case 'shell': return { ok: true, text: shellSingleQuote(s) };
      case 'regex': return { ok: true, text: regexEscape(s) };
      case 'csv': return { ok: true, text: csvEscape(s) };
      case 'sql': return { ok: true, text: sqlEscape(s) };
    }
  } catch { return { ok: false, text: s }; }
}
function unescape(lang: Lang, s: string): Res {
  try {
    switch (lang) {
      case 'json': return jsonUnescape(s);
      case 'csharp': case 'javascript': case 'java': case 'python': return cStyleUnescape(s);
      case 'html': return { ok: true, text: htmlDecode(s) };
      case 'url': return { ok: true, text: decodeURIComponent(s) };
      case 'shell': return { ok: true, text: shellUnwrap(s) };
      case 'regex': return regexUnescape(s);
      case 'csv': return csvUnescape(s);
      case 'sql': return { ok: true, text: sqlUnescape(s) };
    }
  } catch { return { ok: false, text: s }; }
}

const LANGS: Lang[] = ['json', 'csharp', 'javascript', 'java', 'python', 'html', 'url', 'shell', 'regex', 'csv', 'sql'];
const LANG_LABEL: Record<Lang, string> = {
  json: 'JSON', csharp: 'C#', javascript: 'JavaScript', java: 'Java', python: 'Python',
  html: 'XML / HTML', url: 'URL', shell: 'Shell (single-quote)', regex: 'Regex', csv: 'CSV field', sql: 'SQL string',
};

export function TextEscapeModule() {
  const { t } = useTranslation();
  const [lang, setLang] = useState<Lang>('json');
  const [mode, setMode] = useState<'escape' | 'unescape'>('escape');
  const [input, setInput] = useState('Hello "World"\nLine\tTab — café');

  const res = useMemo(() => (mode === 'escape' ? escape(lang, input) : unescape(lang, input)), [lang, mode, input]);

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textesc.language')}</label>
        <select className="mod-select" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
        </select>
        <button className={`mini ${mode === 'escape' ? 'primary' : ''}`} onClick={() => setMode('escape')}>{t('textesc.escape')}</button>
        <button className={`mini ${mode === 'unescape' ? 'primary' : ''}`} onClick={() => setMode('unescape')}>{t('textesc.unescape')}</button>
        <button className="mini" disabled={!res.text} onClick={() => navigator.clipboard?.writeText(res.text)}>{t('textesc.copy')}</button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('textesc.input')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={res.text} placeholder={t('textesc.output')} />
      </div>
      {!res.ok && <p className="count-note" style={{ color: 'var(--danger)', marginTop: 8 }}>{t('textesc.malformed')}</p>}
    </div>
  );
}
