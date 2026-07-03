import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// HTTP Header Inspector — port of WinForge HttpHeadersService/HttpHeadersModule.
// The desktop original fires a real HttpClient GET/HEAD and reports the final
// status, elapsed time and every response/content header. In the browser a live
// cross-origin request is blocked by CORS for almost every URL, so we ship two
// modes:
//   • "paste" (always works, fully offline): paste a raw HTTP response or a bare
//     header block and inspect the status line + every header, sorted, plus the
//     Content-Type / Content-Length / Location summary the desktop tool shows.
//   • "fetch" (best-effort): issue a real request; the browser only surfaces the
//     handful of CORS-safelisted response headers, but the status/timing are real.

interface HeaderRow {
  key: string;
  value: string;
}

interface Summary {
  ok: boolean;
  message: string;
  statusCode: number;
  reason: string;
  elapsedMs: number;
  contentType: string;
  contentLength: string;
  location: string;
  finalUrl: string;
  headers: HeaderRow[];
}

// Merge duplicate header keys the way the desktop tool joins multi-values: ", ".
function collectHeaders(pairs: [string, string][]): HeaderRow[] {
  const order: string[] = [];
  const map = new Map<string, string[]>();
  for (const [rawK, rawV] of pairs) {
    const k = rawK.trim();
    if (!k) continue;
    const existing = map.get(k);
    if (existing) {
      existing.push(rawV);
    } else {
      map.set(k, [rawV]);
      order.push(k);
    }
  }
  const rows: HeaderRow[] = order.map((k) => ({ key: k, value: (map.get(k) ?? []).join(', ') }));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

function findHeader(rows: HeaderRow[], name: string): string {
  const lower = name.toLowerCase();
  for (const r of rows) if (r.key.toLowerCase() === lower) return r.value;
  return '';
}

// Format a byte count like the desktop's ToString("N0") (thousands-grouped).
function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return out;
}

// Parse pasted raw HTTP text: an optional "HTTP/1.1 200 OK" status line followed
// by "Key: Value" header lines. Blank line / body afterwards is ignored.
function parseRaw(text: string): { statusCode: number; reason: string; pairs: [string, string][] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let statusCode = 0;
  let reason = '';
  const pairs: [string, string][] = [];
  let started = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!started && line.trim() === '') continue; // skip leading blank lines
    const trimmed = line.trim();

    // Status line, e.g. "HTTP/1.1 301 Moved Permanently" or "HTTP/2 200".
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/i.exec(trimmed);
    if (!started && statusMatch) {
      statusCode = parseInt(statusMatch[1] ?? '0', 10);
      reason = (statusMatch[2] ?? '').trim();
      started = true;
      continue;
    }

    started = true;
    if (trimmed === '') break; // blank line ends the header block; rest is body

    const colon = line.indexOf(':');
    if (colon <= 0) continue; // not a header line (or a bare word) — skip
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) pairs.push([key, value]);
  }

  return { statusCode, reason, pairs };
}

export function HttpHeadersModule() {
  const { t } = useTranslation();

  const [mode, setMode] = useState<'paste' | 'fetch'>('paste');

  // Paste mode
  const [raw, setRaw] = useState(
    'HTTP/1.1 200 OK\nContent-Type: text/html; charset=utf-8\nContent-Length: 1256\nCache-Control: max-age=3600\nServer: nginx\n',
  );

  // Fetch mode
  const [url, setUrl] = useState('https://example.com');
  const [method, setMethod] = useState<'GET' | 'HEAD'>('GET');
  const [busy, setBusy] = useState(false);
  const [fetched, setFetched] = useState<Summary | null>(null);

  const pasted = useMemo<Summary | null>(() => {
    if (!raw.trim()) return null;
    const { statusCode, reason, pairs } = parseRaw(raw);
    const headers = collectHeaders(pairs);

    const contentTypeRaw = findHeader(headers, 'Content-Type');
    const contentType = contentTypeRaw || '—';

    const clRaw = findHeader(headers, 'Content-Length');
    let contentLength = '—';
    if (clRaw) {
      const cleaned = clRaw.replace(/[,\s]/g, '');
      contentLength = /^\d+$/.test(cleaned) ? groupThousands(cleaned) : clRaw;
    }

    const location = findHeader(headers, 'Location');

    return {
      ok: true,
      message: t('httpheaders.parsedSummary', {
        code: statusCode || '—',
        reason,
        n: headers.length,
      }),
      statusCode,
      reason,
      elapsedMs: 0,
      contentType,
      contentLength,
      location,
      finalUrl: '',
      headers,
    };
  }, [raw, t]);

  const doFetch = async () => {
    let u = url.trim();
    if (!u) {
      setFetched({ ...emptySummary(), ok: false, message: t('httpheaders.enterUrl') });
      return;
    }
    if (!u.includes('://')) u = 'https://' + u;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      setFetched({ ...emptySummary(), ok: false, message: t('httpheaders.invalidUrl', { url: u }) });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setFetched({ ...emptySummary(), ok: false, message: t('httpheaders.invalidUrl', { url: u }) });
      return;
    }

    setBusy(true);
    setFetched(null);
    const t0 = performance.now();
    try {
      const resp = await fetch(u, { method, redirect: 'follow' });
      const elapsed = Math.round(performance.now() - t0);
      const pairs: [string, string][] = [...resp.headers.entries()];
      const headers = collectHeaders(pairs);

      const contentType = findHeader(headers, 'Content-Type') || '—';
      const clRaw = findHeader(headers, 'Content-Length');
      const contentLength = clRaw && /^\d+$/.test(clRaw) ? groupThousands(clRaw) : clRaw || '—';

      setFetched({
        ok: true,
        message: t('httpheaders.fetchSummary', {
          code: resp.status,
          reason: resp.statusText,
          ms: elapsed,
          n: headers.length,
        }),
        statusCode: resp.status,
        reason: resp.statusText,
        elapsedMs: elapsed,
        contentType,
        contentLength,
        location: findHeader(headers, 'Location'),
        finalUrl: resp.url || u,
        headers,
      });
    } catch (e) {
      setFetched({
        ...emptySummary(),
        ok: false,
        message: t('httpheaders.fetchFailed', { detail: String(e instanceof Error ? e.message : e) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const active = mode === 'paste' ? pasted : fetched;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('httpheaders.blurb')}
      </p>

      <div className="mod-toolbar">
        <button className={`mini${mode === 'paste' ? ' primary' : ''}`} onClick={() => setMode('paste')}>
          {t('httpheaders.modePaste')}
        </button>
        <button className={`mini${mode === 'fetch' ? ' primary' : ''}`} onClick={() => setMode('fetch')}>
          {t('httpheaders.modeFetch')}
        </button>
      </div>

      {mode === 'paste' ? (
        <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('httpheaders.rawLabel')}
          </span>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 160, fontFamily: 'Consolas, monospace' }}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={t('httpheaders.rawPlaceholder')}
          />
        </div>
      ) : (
        <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <p className="count-note" style={{ margin: 0, color: 'var(--danger)' }}>
            {t('httpheaders.corsNotice')}
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 220, fontFamily: 'Consolas, monospace' }}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('httpheaders.urlPlaceholder')}
            />
            <select className="mod-select" value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'HEAD')}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
            <button className="mini primary" disabled={busy} onClick={() => void doFetch()}>
              {busy ? t('httpheaders.sending') : t('httpheaders.send')}
            </button>
          </div>
        </div>
      )}

      {active && !active.ok && (
        <p style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12.5 }}>{active.message}</p>
      )}

      {active && active.ok && (
        <>
          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
            <h3 className="group-title" style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
              {active.statusCode
                ? t('httpheaders.statusLine', { code: active.statusCode, reason: active.reason })
                : t('httpheaders.noStatus')}
              {mode === 'fetch' && active.elapsedMs > 0 ? ` · ${active.elapsedMs} ${t('httpheaders.ms')}` : ''}
            </h3>
            <span className="count-note" style={{ margin: 0 }}>
              {t('httpheaders.contentTypeLine', { value: active.contentType })}
            </span>
            <span className="count-note" style={{ margin: 0 }}>
              {t('httpheaders.contentLengthLine', { value: active.contentLength })}
            </span>
            {active.statusCode >= 300 && active.statusCode < 400 && active.location && (
              <span className="count-note" style={{ margin: 0 }}>
                {t('httpheaders.locationLine', { value: active.location })}
              </span>
            )}
            {active.finalUrl && (
              <span className="count-note" style={{ margin: 0 }}>
                {t('httpheaders.finalUrlLine', { value: active.finalUrl })}
              </span>
            )}
          </div>

          {active.headers.length > 0 && (
            <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              <h3 className="group-title" style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
                {t('httpheaders.headersTitle', { count: active.headers.length })}
              </h3>
              <div className="dt-wrap">
                <table className="dt">
                  <tbody>
                    {active.headers.map((h, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{h.key}</td>
                        <td style={{ wordBreak: 'break-all' }}>{h.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function emptySummary(): Summary {
  return {
    ok: false,
    message: '',
    statusCode: 0,
    reason: '',
    elapsedMs: 0,
    contentType: '—',
    contentLength: '—',
    location: '',
    finalUrl: '',
    headers: [],
  };
}
