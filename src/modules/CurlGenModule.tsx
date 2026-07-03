import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Row = { k: string; v: string };
type Auth = 'none' | 'bearer' | 'basic';
type Fmt = 'curl' | 'fetch' | 'powershell';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

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

// b64 of a UTF-8 string, for Basic auth.
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

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
}

// Fold Content-Type + Authorization into the header list, honouring any the
// user already set (case-insensitive), exactly like WinForge EffectiveHeaders.
function effectiveHeaders(r: Req): Row[] {
  const list = r.headers.filter((h) => h.k.trim());
  const has = (name: string) => list.some((h) => h.k.trim().toLowerCase() === name.toLowerCase());
  const bodyPresent = r.body.trim().length > 0;
  if (bodyPresent && !has('Content-Type') && r.contentType.trim()) list.push({ k: 'Content-Type', v: r.contentType.trim() });
  if (!has('Authorization')) {
    if (r.auth === 'bearer' && r.bearer.trim()) list.push({ k: 'Authorization', v: 'Bearer ' + r.bearer.trim() });
    else if (r.auth === 'basic' && (r.user || r.pass)) list.push({ k: 'Authorization', v: 'Basic ' + b64(`${r.user}:${r.pass}`) });
  }
  return list;
}

function genCurl(r: Req): string {
  const h = effectiveHeaders(r);
  let out = 'curl ';
  if (r.method !== 'GET') out += '-X ' + r.method + ' \\\n     ';
  out += shQuote(r.url);
  for (const x of h) out += ' \\\n     -H ' + shQuote(`${x.k}: ${x.v}`);
  if (r.body.trim()) out += ' \\\n     --data ' + shQuote(r.body);
  return out;
}

function genFetch(r: Req): string {
  const h = effectiveHeaders(r);
  let out = 'const res = await fetch(' + jsQuote(r.url) + ', {\n';
  out += '  method: ' + jsQuote(r.method) + ',\n';
  if (h.length) {
    out += '  headers: {\n';
    h.forEach((x, i) => {
      out += '    ' + jsQuote(x.k) + ': ' + jsQuote(x.v) + (i < h.length - 1 ? ',\n' : '\n');
    });
    out += '  },\n';
  }
  if (r.body.trim()) out += '  body: ' + jsQuote(r.body) + ',\n';
  out += '});\n';
  out += 'const data = await res.text();\n';
  out += 'console.log(res.status, data);';
  return out;
}

function genPowershell(r: Req): string {
  const h = effectiveHeaders(r);
  let out = '';
  if (h.length) {
    out += '$headers = @{\n';
    for (const x of h) out += '  ' + psQuote(x.k) + ' = ' + psQuote(x.v) + '\n';
    out += '}\n';
  }
  const bodyPresent = r.body.trim().length > 0;
  if (bodyPresent) out += '$body = ' + psQuote(r.body) + '\n';
  out += 'Invoke-RestMethod -Uri ' + psQuote(r.url) + ' -Method ' + r.method;
  if (h.length) out += ' `\n  -Headers $headers';
  if (bodyPresent) out += ' `\n  -Body $body';
  return out;
}

export function CurlGenModule() {
  const { t } = useTranslation();
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('https://api.example.com/v1/users');
  const [headers, setHeaders] = useState<Row[]>([{ k: 'Accept', v: 'application/json' }]);
  const [contentType, setContentType] = useState('application/json');
  const [body, setBody] = useState('{\n  "name": "Ada"\n}');
  const [auth, setAuth] = useState<Auth>('none');
  const [bearer, setBearer] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [fmt, setFmt] = useState<Fmt>('curl');
  const [note, setNote] = useState('');

  const req: Req = { url, method, body, contentType, auth, bearer, user, pass, headers };
  const output = useMemo(() => (fmt === 'fetch' ? genFetch(req) : fmt === 'powershell' ? genPowershell(req) : genCurl(req)), [fmt, url, method, body, contentType, auth, bearer, user, pass, headers]);

  const patchHdr = (i: number, p: Partial<Row>) => setHeaders(headers.map((h, j) => (j === i ? { ...h, ...p } : h)));
  const copy = () => {
    if (!output.trim()) return setNote(t('curlgen.nothing'));
    void navigator.clipboard?.writeText(output);
    setNote(t('curlgen.copied'));
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
      </div>

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

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        {(['curl', 'fetch', 'powershell'] as Fmt[]).map((f) => (
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
