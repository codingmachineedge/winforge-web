import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge UrlToolsService (URL parse / query edit / rebuild).
interface UrlParts { valid: boolean; scheme: string; userInfo: string; host: string; port: string; path: string; query: string; fragment: string }
interface QueryParam { key: string; value: string }

const encode = (s: string) => { try { return encodeURIComponent(s ?? ''); } catch { return s ?? ''; } };
const decode = (s: string) => { if (!s) return ''; try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

function manualSplit(url: string): UrlParts {
  const p: UrlParts = { valid: false, scheme: '', userInfo: '', host: '', port: '', path: '', query: '', fragment: '' };
  let rest = url;
  const hash = rest.indexOf('#');
  if (hash >= 0) { p.fragment = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  const q = rest.indexOf('?');
  if (q >= 0) { p.query = rest.slice(q + 1); rest = rest.slice(0, q); }
  const scheme = rest.indexOf('://');
  if (scheme > 0) {
    p.scheme = rest.slice(0, scheme);
    rest = rest.slice(scheme + 3);
    const slash = rest.indexOf('/');
    let authority = slash >= 0 ? rest.slice(0, slash) : rest;
    p.path = slash >= 0 ? rest.slice(slash) : '';
    const at = authority.indexOf('@');
    if (at >= 0) { p.userInfo = authority.slice(0, at); authority = authority.slice(at + 1); }
    const colon = authority.lastIndexOf(':');
    const bracket = authority.lastIndexOf(']');
    if (colon > bracket && colon >= 0) { p.host = authority.slice(0, colon); p.port = authority.slice(colon + 1); }
    else p.host = authority;
  } else p.path = rest;
  return p;
}

function parse(url: string): UrlParts {
  const p: UrlParts = { valid: false, scheme: '', userInfo: '', host: '', port: '', path: '', query: '', fragment: '' };
  if (!url.trim()) return p;
  try {
    const u = new URL(url);
    p.valid = true;
    p.scheme = u.protocol.replace(/:$/, '');
    p.userInfo = u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : '';
    p.host = u.hostname;
    p.port = u.port || '';
    p.path = u.pathname;
    p.query = u.search.replace(/^\?/, '');
    p.fragment = u.hash.replace(/^#/, '');
    return p;
  } catch { return manualSplit(url); }
}

function parseQuery(query: string): QueryParam[] {
  const list: QueryParam[] = [];
  if (!query) return list;
  const q = query.replace(/^\?/, '');
  for (const raw of q.split('&')) {
    if (raw.length === 0) continue;
    const eq = raw.indexOf('=');
    const [k, v] = eq >= 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : [raw, ''];
    list.push({ key: decode(k), value: decode(v) });
  }
  return list;
}
function buildQuery(pairs: QueryParam[]): string {
  return pairs.filter((p) => p.key).map((p) => `${encode(p.key)}=${encode(p.value)}`).join('&');
}
function rebuild(p: UrlParts, pairs: QueryParam[]): string {
  let s = '';
  if (p.scheme) {
    s += p.scheme + '://';
    if (p.userInfo) s += p.userInfo + '@';
    s += p.host;
    if (p.port) s += ':' + p.port;
  }
  s += p.path;
  const query = buildQuery(pairs);
  if (query) s += '?' + query;
  if (p.fragment) s += '#' + p.fragment;
  return s;
}

export function UrlToolsModule() {
  const { t } = useTranslation();
  const [url, setUrl] = useState('https://user@example.com:8443/path/to/page?q=hello+world&lang=en&x=1#section');
  const parts = useMemo(() => parse(url), [url]);
  const [params, setParams] = useState<QueryParam[] | null>(null);

  // Derived params from the parsed URL, unless the user is editing an override set.
  const currentParams = params ?? parseQuery(parts.query);

  const updateParam = (i: number, key: 'key' | 'value', val: string) =>
    setParams(currentParams.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)));
  const addParam = () => setParams([...currentParams, { key: '', value: '' }]);
  const removeParam = (i: number) => setParams(currentParams.filter((_, idx) => idx !== i));
  const resetParams = () => setParams(null);

  const rebuilt = rebuild(parts, currentParams);

  const [encIn, setEncIn] = useState('hello world & café');
  const [encMode, setEncMode] = useState<'encode' | 'decode'>('encode');
  const encOut = encMode === 'encode' ? encode(encIn) : decode(encIn);

  const kv = (label: string, val: string) => val ? (
    <div className="kv-row"><span className="label">{label}</span><span className="value" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{val}</span></div>
  ) : null;

  return (
    <div className="mod">
      <label className="count-note">{t('urltools.url')}</label>
      <input className="hosts-edit" style={{ minHeight: 0, height: 38, fontFamily: 'monospace' }} value={url} onChange={(e) => { setUrl(e.target.value); resetParams(); }} placeholder="https://example.com/path?a=1" />
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="kv-list">
          {kv(t('urltools.scheme'), parts.scheme)}
          {kv(t('urltools.userInfo'), parts.userInfo)}
          {kv(t('urltools.host'), parts.host)}
          {kv(t('urltools.port'), parts.port)}
          {kv(t('urltools.path'), parts.path)}
          {kv(t('urltools.fragment'), parts.fragment)}
        </div>
        {!parts.valid && parts.scheme === '' && <p className="count-note" style={{ marginTop: 6 }}>{t('urltools.relative')}</p>}
      </div>
      <div className="panel">
        <div className="mod-toolbar" style={{ marginTop: 0 }}>
          <h4 style={{ margin: 0, flex: 1 }}>{t('urltools.queryParams')}</h4>
          <button className="mini" onClick={addParam}>{t('urltools.add')}</button>
          {params && <button className="mini" onClick={resetParams}>{t('urltools.reset')}</button>}
        </div>
        <table className="dt">
          <thead><tr><th>{t('urltools.key')}</th><th>{t('urltools.value')}</th><th></th></tr></thead>
          <tbody>
            {currentParams.map((p, i) => (
              <tr key={i}>
                <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 160 }} value={p.key} onChange={(e) => updateParam(i, 'key', e.target.value)} /></td>
                <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 220 }} value={p.value} onChange={(e) => updateParam(i, 'value', e.target.value)} /></td>
                <td><button className="mini" onClick={() => removeParam(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <label className="count-note">{t('urltools.rebuilt')}</label>
        <div className="mod-toolbar" style={{ marginTop: 4 }}>
          <code style={{ flex: 1, wordBreak: 'break-all' }}>{rebuilt}</code>
          <button className="mini" onClick={() => navigator.clipboard?.writeText(rebuilt)}>{t('urltools.copy')}</button>
        </div>
      </div>
      <div className="panel">
        <div className="mod-toolbar" style={{ marginTop: 0 }}>
          <h4 style={{ margin: 0, flex: 1 }}>{t('urltools.encoder')}</h4>
          <button className={`mini ${encMode === 'encode' ? 'primary' : ''}`} onClick={() => setEncMode('encode')}>{t('urltools.encode')}</button>
          <button className={`mini ${encMode === 'decode' ? 'primary' : ''}`} onClick={() => setEncMode('decode')}>{t('urltools.decode')}</button>
        </div>
        <div className="io-grid">
          <textarea className="hosts-edit" spellCheck={false} value={encIn} onChange={(e) => setEncIn(e.target.value)} style={{ minHeight: 70 }} />
          <textarea className="hosts-edit" spellCheck={false} readOnly value={encOut} style={{ minHeight: 70 }} />
        </div>
      </div>
    </div>
  );
}
