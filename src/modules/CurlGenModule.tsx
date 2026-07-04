import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Row = { k: string; v: string };
type Auth = 'none' | 'bearer' | 'basic';
type Fmt = 'curl' | 'fetch' | 'powershell' | 'pwshIwr' | 'wget' | 'httpie' | 'python';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const FMTS: Fmt[] = ['curl', 'powershell', 'pwshIwr', 'wget', 'httpie', 'fetch', 'python'];

// ---- quoting helpers (mirror WinForge Services/CurlGenService.cs) ----
const shQuote = (s: string) => "'" + (s ?? '').replace(/'/g, "'\\''") + "'";
const psQuote = (s: string) => "'" + (s ?? '').replace(/'/g, "''") + "'";
function jsQuote(s: string): string {
  let out = "'";
  for (const c of s ?? '') {
    out += c === '\\' ? '\\\\' : c === "'" ? "\\'" : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c;
  }
  return out + "'";
}
// Python single-quoted string literal.
function pyQuote(s: string): string {
  let out = "'";
  for (const c of s ?? '') {
    out += c === '\\' ? '\\\\' : c === "'" ? "\\'" : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c;
  }
  return out + "'";
}

// b64 of a UTF-8 string, for Basic auth.
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
// decode a base64 string back to UTF-8, for import.
function b64decode(s: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

interface Req {
  url: string;
  method: string;
  body: string;
  contentType: string;
  auth: Auth;
  bearer: string;
  user: string;
  pass: string;
  headers: Row[];
  query: Row[];
}

const hasBody = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());

// Build the final URL with query params appended (skips blank keys).
function effectiveUrl(r: Req): string {
  const base = (r.url || '').trim() || 'https://example.com';
  const qs = r.query
    .filter((q) => q.k.trim())
    .map((q) => `${encodeURIComponent(q.k.trim())}=${encodeURIComponent(q.v)}`)
    .join('&');
  if (!qs) return base;
  return base + (base.includes('?') ? '&' : '?') + qs;
}

// Fold Content-Type + Authorization into the header list, honouring any the
// user already set (case-insensitive), exactly like WinForge EffectiveHeaders.
function effectiveHeaders(r: Req): Row[] {
  const list = r.headers.filter((h) => h.k.trim()).map((h) => ({ k: h.k.trim(), v: h.v }));
  const has = (name: string) => list.some((h) => h.k.toLowerCase() === name.toLowerCase());
  const bodyPresent = hasBody(r.method) && r.body.length > 0;
  if (bodyPresent && !has('Content-Type') && r.contentType.trim()) list.push({ k: 'Content-Type', v: r.contentType.trim() });
  if (!has('Authorization')) {
    if (r.auth === 'bearer' && r.bearer.trim()) list.push({ k: 'Authorization', v: 'Bearer ' + r.bearer.trim() });
    else if (r.auth === 'basic' && (r.user || r.pass)) list.push({ k: 'Authorization', v: 'Basic ' + b64(`${r.user}:${r.pass}`) });
  }
  return list;
}

// ---- generators ----

function genCurl(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = 'curl ';
  if (method !== 'GET') out += '-X ' + method + ' \\\n     ';
  out += shQuote(effectiveUrl(r));
  for (const x of h) out += ' \\\n     -H ' + shQuote(`${x.k}: ${x.v}`);
  if (hasBody(method) && r.body.length > 0) out += ' \\\n     --data ' + shQuote(r.body);
  return out;
}

function genFetch(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = 'const res = await fetch(' + jsQuote(effectiveUrl(r)) + ', {\n';
  out += '  method: ' + jsQuote(method) + ',\n';
  if (h.length) {
    out += '  headers: {\n';
    h.forEach((x, i) => {
      out += '    ' + jsQuote(x.k) + ': ' + jsQuote(x.v) + (i < h.length - 1 ? ',\n' : '\n');
    });
    out += '  },\n';
  }
  if (hasBody(method) && r.body.length > 0) out += '  body: ' + jsQuote(r.body) + ',\n';
  out += '});\n';
  out += 'const data = await res.text();\n';
  out += 'console.log(res.status, data);';
  return out;
}

function genPowershell(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = '';
  if (h.length) {
    out += '$headers = @{\n';
    for (const x of h) out += '  ' + psQuote(x.k) + ' = ' + psQuote(x.v) + '\n';
    out += '}\n';
  }
  const bodyPresent = hasBody(method) && r.body.length > 0;
  if (bodyPresent) out += '$body = ' + psQuote(r.body) + '\n';
  out += 'Invoke-RestMethod -Uri ' + psQuote(effectiveUrl(r)) + ' -Method ' + method;
  if (h.length) out += ' `\n  -Headers $headers';
  if (bodyPresent) out += ' `\n  -Body $body';
  return out;
}

// PowerShell Invoke-WebRequest (returns the raw response object).
function genPwshIwr(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = '';
  if (h.length) {
    out += '$headers = @{\n';
    for (const x of h) out += '  ' + psQuote(x.k) + ' = ' + psQuote(x.v) + '\n';
    out += '}\n';
  }
  const bodyPresent = hasBody(method) && r.body.length > 0;
  if (bodyPresent) out += '$body = ' + psQuote(r.body) + '\n';
  out += 'Invoke-WebRequest -Uri ' + psQuote(effectiveUrl(r)) + ' -Method ' + method + ' `\n  -UseBasicParsing';
  if (h.length) out += ' `\n  -Headers $headers';
  if (bodyPresent) out += ' `\n  -Body $body';
  return out;
}

function genWget(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = 'wget ';
  if (method !== 'GET') out += '--method=' + method + ' \\\n     ';
  for (const x of h) out += '--header=' + shQuote(`${x.k}: ${x.v}`) + ' \\\n     ';
  if (hasBody(method) && r.body.length > 0) out += '--body-data=' + shQuote(r.body) + ' \\\n     ';
  out += '-O - \\\n     ';
  out += shQuote(effectiveUrl(r));
  return out;
}

function genHttpie(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  const bodyPresent = hasBody(method) && r.body.length > 0;
  let out = 'http ';
  if (bodyPresent) out += '--raw=' + shQuote(r.body) + ' ';
  out += method + ' ' + shQuote(effectiveUrl(r));
  for (const x of h) out += ' \\\n     ' + shQuote(`${x.k}:${x.v}`);
  return out;
}

function genPython(r: Req): string {
  const h = effectiveHeaders(r);
  const method = r.method.toUpperCase();
  let out = 'import requests\n\n';
  if (h.length) {
    out += 'headers = {\n';
    h.forEach((x, i) => {
      out += '    ' + pyQuote(x.k) + ': ' + pyQuote(x.v) + (i < h.length - 1 ? ',\n' : '\n');
    });
    out += '}\n';
  }
  const bodyPresent = hasBody(method) && r.body.length > 0;
  if (bodyPresent) out += 'data = ' + pyQuote(r.body) + '\n';
  out += '\nresp = requests.request(' + pyQuote(method) + ', ' + pyQuote(effectiveUrl(r));
  if (h.length) out += ', headers=headers';
  if (bodyPresent) out += ', data=data';
  out += ')\n';
  out += 'print(resp.status_code, resp.text)';
  return out;
}

function generate(fmt: Fmt, r: Req): string {
  switch (fmt) {
    case 'fetch':
      return genFetch(r);
    case 'powershell':
      return genPowershell(r);
    case 'pwshIwr':
      return genPwshIwr(r);
    case 'wget':
      return genWget(r);
    case 'httpie':
      return genHttpie(r);
    case 'python':
      return genPython(r);
    default:
      return genCurl(r);
  }
}

// ---- import: parse an existing `curl` command back into the form ----

// Tokenise a curl command respecting single/double quotes and line-continuations.
function tokenizeCurl(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) {
        // POSIX '\''  -> literal single quote when unquoted-escaped
        quote = '';
      } else if (c === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
        has = true;
      } else {
        cur += c;
        has = true;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

interface ParsedCurl {
  ok: boolean;
  method: string;
  url: string;
  headers: Row[];
  query: Row[];
  body: string;
  contentType: string;
  auth: Auth;
  bearer: string;
  user: string;
  pass: string;
}

function parseCurl(cmd: string): ParsedCurl {
  const empty: ParsedCurl = {
    ok: false,
    method: 'GET',
    url: '',
    headers: [],
    query: [],
    body: '',
    contentType: '',
    auth: 'none',
    bearer: '',
    user: '',
    pass: '',
  };
  const toks = tokenizeCurl(cmd.trim());
  if (!toks.length || !/curl/i.test(toks[0]!)) return empty;

  const res: ParsedCurl = { ...empty, ok: true, headers: [], query: [] };
  let method = '';
  let bodySet = false;
  for (let i = 1; i < toks.length; i++) {
    let t = toks[i]!;
    // support --opt=value form
    let inlineVal: string | null = null;
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=');
      inlineVal = t.slice(eq + 1);
      t = t.slice(0, eq);
    }
    const next = () => (inlineVal !== null ? inlineVal : toks[++i] ?? '');
    if (t === '-X' || t === '--request') {
      method = next().toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const hv = next();
      const idx = hv.indexOf(':');
      if (idx > 0) {
        const k = hv.slice(0, idx).trim();
        const v = hv.slice(idx + 1).trim();
        if (k.toLowerCase() === 'content-type') res.contentType = v;
        if (k.toLowerCase() === 'authorization') {
          const bm = /^Bearer\s+(.+)$/i.exec(v);
          const ba = /^Basic\s+(.+)$/i.exec(v);
          if (bm) {
            res.auth = 'bearer';
            res.bearer = bm[1]!.trim();
            continue;
          }
          if (ba) {
            const dec = b64decode(ba[1]!.trim());
            const ci = dec.indexOf(':');
            res.auth = 'basic';
            res.user = ci >= 0 ? dec.slice(0, ci) : dec;
            res.pass = ci >= 0 ? dec.slice(ci + 1) : '';
            continue;
          }
        }
        res.headers.push({ k, v });
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      res.body = next();
      bodySet = true;
    } else if (t === '-u' || t === '--user') {
      const uv = next();
      const ci = uv.indexOf(':');
      res.auth = 'basic';
      res.user = ci >= 0 ? uv.slice(0, ci) : uv;
      res.pass = ci >= 0 ? uv.slice(ci + 1) : '';
    } else if (t === '--url') {
      res.url = next();
    } else if (t === '-A' || t === '--user-agent') {
      res.headers.push({ k: 'User-Agent', v: next() });
    } else if (t === '-e' || t === '--referer') {
      res.headers.push({ k: 'Referer', v: next() });
    } else if (t === '-b' || t === '--cookie') {
      res.headers.push({ k: 'Cookie', v: next() });
    } else if (t === '-G' || t === '--get') {
      method = method || 'GET';
    } else if (t.startsWith('-') && t !== '-') {
      // unknown flag with a value we can't map — skip its value if it looks paired
      if (inlineVal === null && ['-o', '--output', '-w', '--write-out', '--connect-timeout', '--max-time', '-x', '--proxy'].includes(t)) i++;
    } else if (!res.url && (t.startsWith('http://') || t.startsWith('https://') || t.includes('.') || t.startsWith('localhost'))) {
      res.url = t;
    }
  }

  // Split query string out of the URL into the query editor.
  if (res.url) {
    const qi = res.url.indexOf('?');
    if (qi >= 0) {
      const qs = res.url.slice(qi + 1);
      res.url = res.url.slice(0, qi);
      for (const pair of qs.split('&')) {
        if (!pair) continue;
        const ei = pair.indexOf('=');
        const k = ei >= 0 ? pair.slice(0, ei) : pair;
        const v = ei >= 0 ? pair.slice(ei + 1) : '';
        try {
          res.query.push({ k: decodeURIComponent(k), v: decodeURIComponent(v) });
        } catch {
          res.query.push({ k, v });
        }
      }
    }
  }

  res.method = method || (bodySet ? 'POST' : 'GET');
  return res;
}

export function CurlGenModule() {
  const { t } = useTranslation();
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('https://api.example.com/v1/users');
  const [headers, setHeaders] = useState<Row[]>([{ k: 'Accept', v: 'application/json' }]);
  const [query, setQuery] = useState<Row[]>([]);
  const [contentType, setContentType] = useState('application/json');
  const [body, setBody] = useState('{\n  "name": "Ada"\n}');
  const [auth, setAuth] = useState<Auth>('none');
  const [bearer, setBearer] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [fmt, setFmt] = useState<Fmt>('curl');
  const [note, setNote] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  const req: Req = { url, method, body, contentType, auth, bearer, user, pass, headers, query };
  const output = useMemo(
    () => generate(fmt, req),
    [fmt, url, method, body, contentType, auth, bearer, user, pass, headers, query],
  );

  const patchHdr = (i: number, p: Partial<Row>) => setHeaders(headers.map((h, j) => (j === i ? { ...h, ...p } : h)));
  const patchQry = (i: number, p: Partial<Row>) => setQuery(query.map((q, j) => (j === i ? { ...q, ...p } : q)));

  const copy = () => {
    if (!output.trim()) return setNote(t('curlgen.nothing'));
    void navigator.clipboard?.writeText(output);
    setNote(t('curlgen.copied'));
  };

  const doImport = () => {
    const p = parseCurl(importText);
    if (!p.ok) {
      setNote(t('curlgen.importFail'));
      return;
    }
    setMethod(p.method);
    setUrl(p.url);
    setHeaders(p.headers.length ? p.headers : []);
    setQuery(p.query);
    setBody(p.body);
    if (p.contentType) setContentType(p.contentType);
    setAuth(p.auth);
    setBearer(p.bearer);
    setUser(p.user);
    setPass(p.pass);
    setShowImport(false);
    setImportText('');
    setNote(t('curlgen.imported'));
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <select className="mod-search" style={{ maxWidth: 110 }} value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input className="mod-search" style={{ flex: 1, minWidth: 220 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('curlgen.urlPlaceholder')} />
        <button className="mini" onClick={() => setShowImport((s) => !s)}>
          {t('curlgen.import')}
        </button>
      </div>

      {showImport && (
        <div className="mod-toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={t('curlgen.importPlaceholder')}
            style={{ minHeight: 80, fontFamily: 'var(--mono, monospace)' }}
          />
          <div className="mod-toolbar">
            <button className="mini primary" onClick={doImport}>
              {t('curlgen.importParse')}
            </button>
            <button className="mini" onClick={() => { setShowImport(false); setImportText(''); }}>
              {t('curlgen.importCancel')}
            </button>
          </div>
        </div>
      )}

      <div className="io-grid">
        <div>
          <p className="count-note">{t('curlgen.headers')}</p>
          <div className="kv-list">
            {headers.map((h, i) => (
              <div className="kv-row" key={i}>
                <input className="mod-search" placeholder={t('curlgen.headerName')} value={h.k} onChange={(e) => patchHdr(i, { k: e.target.value })} />
                <input className="mod-search" placeholder="application/json" value={h.v} onChange={(e) => patchHdr(i, { v: e.target.value })} />
                <button className="mini" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="mini" onClick={() => setHeaders([...headers, { k: '', v: '' }])}>
            {t('curlgen.add')}
          </button>

          <p className="count-note" style={{ marginTop: 12 }}>
            {t('curlgen.query')}
          </p>
          <div className="kv-list">
            {query.map((q, i) => (
              <div className="kv-row" key={i}>
                <input className="mod-search" placeholder={t('curlgen.queryName')} value={q.k} onChange={(e) => patchQry(i, { k: e.target.value })} />
                <input className="mod-search" placeholder={t('curlgen.queryValue')} value={q.v} onChange={(e) => patchQry(i, { v: e.target.value })} />
                <button className="mini" onClick={() => setQuery(query.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="mini" onClick={() => setQuery([...query, { k: '', v: '' }])}>
            {t('curlgen.add')}
          </button>

          <p className="count-note" style={{ marginTop: 12 }}>
            {t('curlgen.auth')}
          </p>
          <div className="mod-toolbar">
            {(['none', 'bearer', 'basic'] as Auth[]).map((a) => (
              <button key={a} className={`mini${auth === a ? ' primary' : ''}`} onClick={() => setAuth(a)}>
                {t(`curlgen.auth_${a}`)}
              </button>
            ))}
          </div>
          {auth === 'bearer' && <input className="mod-search" style={{ width: '100%', marginTop: 6 }} placeholder={t('curlgen.token')} value={bearer} onChange={(e) => setBearer(e.target.value)} />}
          {auth === 'basic' && (
            <div className="mod-toolbar">
              <input className="mod-search" placeholder={t('curlgen.user')} value={user} onChange={(e) => setUser(e.target.value)} />
              <input className="mod-search" type="password" placeholder={t('curlgen.pass')} value={pass} onChange={(e) => setPass(e.target.value)} />
            </div>
          )}
        </div>

        <div>
          <p className="count-note">
            {t('curlgen.contentType')} · {t('curlgen.body')}
          </p>
          <input className="mod-search" style={{ width: '100%', marginBottom: 6 }} value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="application/json" />
          <textarea className="hosts-edit" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('curlgen.bodyPlaceholder')} />
        </div>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        {FMTS.map((f) => (
          <button key={f} className={`mini${fmt === f ? ' primary' : ''}`} onClick={() => setFmt(f)}>
            {t(`curlgen.fmt_${f}`)}
          </button>
        ))}
        <button className="mini" onClick={copy}>
          {t('curlgen.copy')}
        </button>
        <span className="count-note">🔒 {t('curlgen.codeOnly')}</span>
      </div>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={output} style={{ minHeight: 160, fontFamily: 'var(--mono, monospace)' }} />
      {note && <p className="count-note" style={{ marginTop: 6 }}>{note}</p>}
    </div>
  );
}
