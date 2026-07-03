import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// HTTP Header Inspector — port of WinForge HttpHeadersService/HttpHeadersModule.
// A live GET/HEAD reports the final status, elapsed time and every response/content
// header. WinForge runs the real request through its own background service (a native
// HttpClient), so it sees the COMPLETE header set with no cross-origin restriction.
// When only a browser preview is available (no background service), it falls back to
// a direct fetch — real status/timing, but the browser exposes just the handful of
// CORS-safelisted response headers. Either way a "paste" mode inspects any raw
// response fully offline.

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
      let statusCode: number;
      let reason: string;
      let finalUrl: string;
      let headers: HeaderRow[];

      if (isTauri()) {
        // Real request through WinForge's background service — complete header set,
        // no cross-origin restriction.
        const r = await backendHeaders(u, method);
        statusCode = r.code;
        reason = r.desc;
        finalUrl = r.final || u;
        headers = collectHeaders(r.headers.map((p) => [p.k, p.v] as [string, string]));
      } else {
        // Browser preview: real status/timing, but only CORS-safelisted headers.
        const resp = await fetch(u, { method, redirect: 'follow' });
        statusCode = resp.status;
        reason = resp.statusText;
        finalUrl = resp.url || u;
        headers = collectHeaders([...resp.headers.entries()]);
      }
      const elapsed = Math.round(performance.now() - t0);

      const contentType = findHeader(headers, 'Content-Type') || '—';
      const clRaw = findHeader(headers, 'Content-Length');
      const contentLength = clRaw && /^\d+$/.test(clRaw) ? groupThousands(clRaw) : clRaw || '—';

      setFetched({
        ok: true,
        message: t('httpheaders.fetchSummary', {
          code: statusCode,
          reason,
          ms: elapsed,
          n: headers.length,
        }),
        statusCode,
        reason,
        elapsedMs: elapsed,
        contentType,
        contentLength,
        location: findHeader(headers, 'Location'),
        finalUrl,
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
          <p
            className="count-note"
            style={{ margin: 0, color: isTauri() ? 'var(--text-secondary)' : 'var(--danger)' }}
          >
            {isTauri() ? t('httpheaders.backendNotice') : t('httpheaders.corsNotice')}
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

// One header pair as returned by the backend PowerShell payload.
interface BackendHeader {
  k: string;
  v: string;
}
interface BackendResp {
  code: number;
  desc: string;
  final: string;
  headers: BackendHeader[];
}

// Perform the request through WinForge's background service using a native HttpClient.
// HttpClient does NOT throw on 4xx/5xx, so every status is captured uniformly, and it
// returns the full response + content header set with no cross-origin filtering.
async function backendHeaders(u: string, method: 'GET' | 'HEAD'): Promise<BackendResp> {
  const safeUrl = u.replace(/'/g, "''");
  const verb = method === 'HEAD' ? 'Head' : 'Get';
  const script = [
    "Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue",
    "$h = New-Object System.Net.Http.HttpClientHandler",
    "$h.AllowAutoRedirect = $true",
    "$c = New-Object System.Net.Http.HttpClient($h)",
    "$c.Timeout = [TimeSpan]::FromSeconds(30)",
    `$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::${verb}, '${safeUrl}')`,
    "$resp = $c.SendAsync($req).GetAwaiter().GetResult()",
    "$pairs = @()",
    "foreach ($kv in $resp.Headers) { foreach ($v in $kv.Value) { $pairs += [pscustomobject]@{ k = $kv.Key; v = [string]$v } } }",
    "if ($resp.Content) { foreach ($kv in $resp.Content.Headers) { foreach ($v in $kv.Value) { $pairs += [pscustomobject]@{ k = $kv.Key; v = [string]$v } } } }",
    "[pscustomobject]@{ code = [int]$resp.StatusCode; desc = [string]$resp.ReasonPhrase; final = [string]$resp.RequestMessage.RequestUri.AbsoluteUri; headers = @($pairs) }",
  ].join('\n');

  const rows = await runPowershellJson<BackendResp>(script);
  const r = rows[0];
  if (!r) throw new Error('empty backend response');
  // ConvertTo-Json collapses a single-element array to an object — normalise back.
  const rawHeaders = r.headers as BackendHeader[] | BackendHeader | undefined;
  const headers = Array.isArray(rawHeaders) ? rawHeaders : rawHeaders ? [rawHeaders] : [];
  return { code: r.code, desc: r.desc ?? '', final: r.final ?? u, headers };
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
