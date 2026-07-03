import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful, never-throwing port of WinForge QueryEditService.

interface UrlParts {
  scheme: string;
  authority: string; // host[:port][userinfo] — kept verbatim
  path: string;
  fragment: string;
  hasUrl: boolean;
}

interface Pair {
  key: string;
  value: string;
  hasEquals: boolean;
}

/** Percent-decode, tolerant of malformed sequences and '+' as space. Never throws. */
function safeDecode(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    try {
      return s.replace(/\+/g, ' ');
    } catch {
      return s ?? '';
    }
  }
}

/** Percent-encode a value for safe placement in a query. Never throws. */
function encode(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return encodeURIComponent(s);
  } catch {
    return s ?? '';
  }
}

/** Encode a path, keeping '/' separators intact. */
function encodePath(path: string): string {
  try {
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) segs[i] = encode(segs[i]!);
    return segs.join('/');
  } catch {
    return path;
  }
}

function looksLikeQuery(s: string): boolean {
  return s.includes('=') || s.includes('&');
}

function splitSchemeHostPath(before: string, parts: UrlParts): void {
  if (!before) return;
  const scheme = before.indexOf('://');
  if (scheme >= 0) {
    parts.hasUrl = true;
    parts.scheme = before.slice(0, scheme);
    const rest = before.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      parts.authority = rest.slice(0, slash);
      parts.path = safeDecode(rest.slice(slash));
    } else {
      parts.authority = rest;
      parts.path = '';
    }
  } else {
    // No scheme — the leading text is a path.
    parts.path = safeDecode(before);
  }
}

function parsePairs(query: string, pairs: Pair[]): void {
  if (!query) return;
  for (const segment of query.split('&')) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf('=');
    if (eq < 0) {
      pairs.push({ key: safeDecode(segment), value: '', hasEquals: false });
    } else {
      pairs.push({
        key: safeDecode(segment.slice(0, eq)),
        value: safeDecode(segment.slice(eq + 1)),
        hasEquals: true,
      });
    }
  }
}

/**
 * Split raw input into its non-query parts and its list of query pairs. Accepts a full URL,
 * a "?...=..." fragment, or a bare "a=1&b=2" string. Never throws.
 */
function parse(input: string | null | undefined): { parts: UrlParts; pairs: Pair[] } {
  const parts: UrlParts = { scheme: '', authority: '', path: '', fragment: '', hasUrl: false };
  const pairs: Pair[] = [];
  let raw = (input ?? '').trim();
  if (raw.length === 0) return { parts, pairs };

  let query = raw;
  try {
    // Prefer the URL API for well-formed absolute URLs so authority/path/fragment are precise.
    let uri: URL | null = null;
    try {
      uri = new URL(raw);
    } catch {
      uri = null;
    }
    if (uri && uri.protocol && /^[a-z][a-z0-9+.-]*:$/i.test(uri.protocol) && /:\/\//.test(raw)) {
      parts.hasUrl = true;
      parts.scheme = uri.protocol.replace(/:$/, '');
      // Authority = userinfo + host + port, kept verbatim.
      let authority = '';
      if (uri.username) {
        authority += uri.username;
        if (uri.password) authority += ':' + uri.password;
        authority += '@';
      }
      authority += uri.host; // host includes :port when present
      parts.authority = authority;
      parts.path = safeDecode(uri.pathname);
      parts.fragment = uri.hash.startsWith('#') ? safeDecode(uri.hash.slice(1)) : safeDecode(uri.hash);
      query = uri.search.startsWith('?') ? uri.search.slice(1) : uri.search;
    } else {
      // Manual fallback: pull off fragment, then query, keeping any leading scheme://authority/path verbatim.
      let work = raw;
      const hash = work.indexOf('#');
      if (hash >= 0) {
        parts.fragment = safeDecode(work.slice(hash + 1));
        work = work.slice(0, hash);
      }
      const q = work.indexOf('?');
      if (q >= 0) {
        query = work.slice(q + 1);
        const before = work.slice(0, q);
        splitSchemeHostPath(before, parts);
      } else if (looksLikeQuery(work)) {
        // Whole thing is a bare query string.
        query = work;
      } else {
        // No '?' and not query-shaped: treat as a URL-ish path with no query.
        query = '';
        splitSchemeHostPath(work, parts);
      }
    }
  } catch {
    // Absolute fallback: treat the untouched input as a raw query.
    query = raw;
  }

  parsePairs(query, pairs);
  return { parts, pairs };
}

/** Build just the query string (no leading '?') from the pairs, encoding each part. */
function buildQuery(pairs: Pair[]): string {
  let out = '';
  let first = true;
  for (const p of pairs) {
    if (!first) out += '&';
    first = false;
    out += encode(p.key);
    if (p.hasEquals || p.value.length > 0) {
      out += '=';
      out += encode(p.value);
    }
  }
  return out;
}

/** Rebuild a full URL/query from parts + pairs. Preserves scheme/host/path/fragment. Never throws. */
function buildUrl(parts: UrlParts, pairs: Pair[]): string {
  try {
    const query = buildQuery(pairs);
    let out = '';
    if (parts.hasUrl && parts.scheme) {
      out += parts.scheme + '://' + parts.authority;
      if (parts.path) {
        if (!parts.path.startsWith('/')) out += '/';
        out += encodePath(parts.path);
      }
    } else if (parts.path) {
      out += encodePath(parts.path);
    }
    if (query.length > 0) out += '?' + query;
    if (parts.fragment) out += '#' + encode(parts.fragment);
    return out;
  } catch {
    return buildQuery(pairs);
  }
}

interface Row {
  key: string;
  value: string;
  enabled: boolean;
  hasEquals: boolean;
}

export function QueryEditModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('https://example.com/search?q=hello+world&lang=en&debug=');
  const [parts, setParts] = useState<UrlParts>({ scheme: '', authority: '', path: '', fragment: '', hasUrl: false });
  const [rows, setRows] = useState<Row[]>([]);
  const [decoded, setDecoded] = useState(false);
  const [info, setInfo] = useState<{ msg: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState('');

  const onParse = () => {
    try {
      const { parts: p, pairs } = parse(input);
      setParts(p);
      setRows(pairs.map((x) => ({ key: x.key, value: x.value, enabled: true, hasEquals: x.hasEquals })));
      setInfo({ msg: t('queryedit.parsed', { count: pairs.length }), ok: true });
    } catch {
      setInfo({ msg: t('queryedit.parseError'), ok: false });
    }
  };

  const onAdd = () => {
    setRows((r) => [...r, { key: 'key', value: 'value', enabled: true, hasEquals: true }]);
  };

  const onSort = () => {
    setRows((r) => [...r].sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase())));
  };

  const onMove = (i: number, delta: number) => {
    setRows((r) => {
      const j = i + delta;
      if (i < 0 || j < 0 || j >= r.length) return r;
      const next = r.slice();
      const a = next[i]!;
      const b = next[j]!;
      next[i] = b;
      next[j] = a;
      return next;
    });
  };

  const onRemove = (i: number) => {
    setRows((r) => r.filter((_, idx) => idx !== i));
  };

  const editRow = (i: number, patch: Partial<Row>) => {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };

  const enabledPairs = useMemo<Pair[]>(
    () => rows.filter((r) => r.enabled).map((r) => ({ key: r.key, value: r.value, hasEquals: r.hasEquals })),
    [rows],
  );

  const resultUrl = useMemo(() => {
    const url = buildUrl(parts, enabledPairs);
    return decoded ? safeDecode(url) : url;
  }, [parts, enabledPairs, decoded]);

  const resultQuery = useMemo(() => {
    const q = buildQuery(enabledPairs);
    return decoded ? safeDecode(q) : q;
  }, [enabledPairs, decoded]);

  const copy = (text: string, which: string, okMsg: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(which);
      setInfo({ msg: okMsg, ok: true });
      setTimeout(() => setCopied(''), 1200);
    } catch {
      setInfo({ msg: t('queryedit.copyFailed'), ok: false });
    }
  };

  const dash = (s: string) => (s ? s : '—');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('queryedit.blurb')}</p>

      <label className="count-note">{t('queryedit.inputLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{ fontFamily: 'monospace', minHeight: 60 }}
      />

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" onClick={onParse}>{t('queryedit.parse')}</button>
        <button className="mini" onClick={onAdd}>{t('queryedit.addParam')}</button>
        <button className="mini" onClick={onSort}>{t('queryedit.sortKeys')}</button>
      </div>

      {info ? (
        <p className="count-note" style={{ color: info.ok ? undefined : 'var(--danger)' }}>{info.msg}</p>
      ) : null}

      <div className="panel">
        <div className="label" style={{ marginBottom: 6 }}>{t('queryedit.parameters')}</div>
        {rows.length === 0 ? (
          <p className="count-note">{t('queryedit.emptyHint')}</p>
        ) : (
          <div className="kv-list">
            <div className="kv-row" style={{ fontWeight: 600 }}>
              <span style={{ width: 40 }}>{t('queryedit.colOn')}</span>
              <span style={{ flex: 1 }}>{t('queryedit.colKey')}</span>
              <span style={{ flex: 1 }}>{t('queryedit.colValue')}</span>
              <span style={{ width: 120 }} />
            </div>
            {rows.map((row, i) => (
              <div className="kv-row" key={i} style={{ alignItems: 'center', gap: 6 }}>
                <label className="chk" style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => editRow(i, { enabled: e.target.checked })}
                  />
                </label>
                <input
                  className="hosts-edit"
                  style={{ minHeight: 0, height: 32, flex: 1, fontFamily: 'monospace' }}
                  value={row.key}
                  onChange={(e) => editRow(i, { key: e.target.value })}
                />
                <input
                  className="hosts-edit"
                  style={{ minHeight: 0, height: 32, flex: 1, fontFamily: 'monospace' }}
                  value={row.value}
                  onChange={(e) => editRow(i, { value: e.target.value, hasEquals: true })}
                />
                <span style={{ width: 120, display: 'flex', gap: 4 }}>
                  <button className="mini" title={t('queryedit.moveUp')} onClick={() => onMove(i, -1)}>↑</button>
                  <button className="mini" title={t('queryedit.moveDown')} onClick={() => onMove(i, 1)}>↓</button>
                  <button className="mini" title={t('queryedit.remove')} onClick={() => onRemove(i)}>✕</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="label">{t('queryedit.result')}</div>
          <label className="chk">
            <input type="checkbox" checked={decoded} onChange={(e) => setDecoded(e.target.checked)} />
            {decoded ? t('queryedit.showingDecoded') : t('queryedit.showingEncoded')}
          </label>
        </div>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={resultUrl}
          style={{ fontFamily: 'monospace', minHeight: 50 }}
        />
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <button className="mini primary" onClick={() => copy(resultUrl, 'url', t('queryedit.urlCopied'))}>
            {copied === 'url' ? t('queryedit.copied') : t('queryedit.copyUrl')}
          </button>
          <button className="mini" onClick={() => copy(resultQuery, 'query', t('queryedit.queryCopied'))}>
            {copied === 'query' ? t('queryedit.copied') : t('queryedit.copyQuery')}
          </button>
        </div>

        <table className="dt" style={{ marginTop: 10 }}>
          <tbody>
            <tr><td>{t('queryedit.scheme')}</td><td style={{ fontFamily: 'monospace' }}>{dash(parts.scheme)}</td></tr>
            <tr><td>{t('queryedit.host')}</td><td style={{ fontFamily: 'monospace' }}>{dash(parts.authority)}</td></tr>
            <tr><td>{t('queryedit.path')}</td><td style={{ fontFamily: 'monospace' }}>{dash(parts.path)}</td></tr>
            <tr><td>{t('queryedit.fragment')}</td><td style={{ fontFamily: 'monospace' }}>{dash(parts.fragment)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
