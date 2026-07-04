import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// API Client — full parity port of WinForge ApiClientModule + ApiClientService.
// A native Postman/Insomnia-style REST client: build a request (method · URL · query
// params · headers · body · auth), substitute {{env vars}}, send it, and inspect the
// response (status · time · size · pretty/raw body · response headers). Requests live
// in collections shown in a sidebar tree; a history list records every send; and
// environments hold {{var}} substitutions. In the desktop shell the request runs through
// the backend (PowerShell HttpClient) so there is NO cross-origin restriction and every
// status/header is captured; in a plain browser it falls back to fetch (CORS-limited).
// The whole workspace is persisted to localStorage (the web analog of apiclient.json).

type Row = { on: boolean; k: string; v: string };
type BodyMode = 'none' | 'json' | 'text' | 'form';
type AuthMode = 'none' | 'bearer' | 'basic' | 'apikey';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const STORE_KEY = 'winforge-web.apiclient';
const emptyRow = (): Row => ({ on: true, k: '', v: '' });

interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  params: Row[];
  headers: Row[];
  bodyMode: BodyMode;
  body: string;
  form: Row[];
  authMode: AuthMode;
  token: string;
  user: string;
  pass: string;
  apiKeyName: string;
  apiKeyValue: string;
}

interface Collection {
  id: string;
  name: string;
  requests: SavedRequest[];
}

interface ApiEnv {
  id: string;
  name: string;
  vars: Row[];
}

interface HistoryEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  at: number;
}

interface Workspace {
  collections: Collection[];
  environments: ApiEnv[];
  activeEnvId: string | null;
  history: HistoryEntry[];
}

interface Resp {
  ok: boolean;
  status: number;
  statusText: string;
  ms: number;
  bytes: number;
  body: string;
  contentType: string;
  headers: [string, string][];
  error?: string;
}

// ── ids / defaults ────────────────────────────────────────────────────────────

let seq = 0;
function uid(): string {
  seq += 1;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

function newRequest(over: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: uid(),
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    bodyMode: 'none',
    body: '',
    form: [],
    authMode: 'none',
    token: '',
    user: '',
    pass: '',
    apiKeyName: '',
    apiKeyValue: '',
    ...over,
  };
}

function seedWorkspace(): Workspace {
  return {
    collections: [
      {
        id: uid(),
        name: 'Sample',
        requests: [
          newRequest({ name: 'Get JSON', method: 'GET', url: 'https://httpbin.org/get' }),
          newRequest({
            name: 'Post JSON',
            method: 'POST',
            url: 'https://httpbin.org/post',
            bodyMode: 'json',
            body: '{\n  "hello": "world"\n}',
          }),
        ],
      },
    ],
    environments: [],
    activeEnvId: null,
    history: [],
  };
}

// ── persistence ────────────────────────────────────────────────────────────────

function loadWorkspace(): Workspace {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (raw) {
      const w = JSON.parse(raw) as Workspace;
      if (w && Array.isArray(w.collections)) {
        return {
          collections: w.collections,
          environments: Array.isArray(w.environments) ? w.environments : [],
          activeEnvId: w.activeEnvId ?? null,
          history: Array.isArray(w.history) ? w.history : [],
        };
      }
    }
  } catch {
    /* corrupt store — reseed */
  }
  return seedWorkspace();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function substitute(input: string, env: ApiEnv | null): string {
  if (!input || !env) return input ?? '';
  const map = new Map<string, string>();
  for (const v of env.vars) if (v.on && v.k) map.set(v.k, v.v ?? '');
  return input.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, name: string) => (map.has(name) ? (map.get(name) as string) : m));
}

function buildUrl(url: string, params: Row[], env: ApiEnv | null): string {
  let u = substitute(url.trim(), env);
  if (u && !u.includes('://')) u = 'https://' + u;
  const active = params.filter((p) => p.on && p.k);
  if (!active.length) return u;
  const qs = active
    .map((p) => `${encodeURIComponent(substitute(p.k, env))}=${encodeURIComponent(substitute(p.v, env))}`)
    .join('&');
  return u + (u.includes('?') ? '&' : '?') + qs;
}

function prettyJson(text: string): string | null {
  if (!text.trim()) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function looksJson(contentType: string, body: string): boolean {
  if (/json/i.test(contentType)) return true;
  const t = body.trimStart();
  return t.length > 0 && (t[0] === '{' || t[0] === '[');
}

function humanSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'partial';
  return 'bad';
}

// Build the final header set actually put on the wire (auth + content-type baked in).
function resolveHeaders(r: SavedRequest, env: ApiEnv | null): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const push = (k: string, v: string) => {
    if (!k) return;
    out.push([k, v]);
    seen.add(k.toLowerCase());
  };
  for (const h of r.headers) if (h.on && h.k) push(substitute(h.k, env).trim(), substitute(h.v, env));

  const hasBody = r.method !== 'GET' && r.method !== 'HEAD' && r.bodyMode !== 'none';
  if (hasBody && !seen.has('content-type')) {
    if (r.bodyMode === 'json') push('Content-Type', 'application/json; charset=utf-8');
    else if (r.bodyMode === 'text') push('Content-Type', 'text/plain; charset=utf-8');
    else if (r.bodyMode === 'form') push('Content-Type', 'application/x-www-form-urlencoded');
  }

  if (r.authMode === 'bearer') {
    const tk = substitute(r.token, env).trim();
    if (tk) push('Authorization', `Bearer ${tk}`);
  } else if (r.authMode === 'basic') {
    const raw = substitute(r.user, env) + ':' + substitute(r.pass, env);
    push('Authorization', `Basic ${btoa(unescape(encodeURIComponent(raw)))}`);
  } else if (r.authMode === 'apikey') {
    const name = substitute(r.apiKeyName, env).trim();
    if (name) push(name, substitute(r.apiKeyValue, env));
  }
  return out;
}

// The request body string that goes on the wire.
function resolveBody(r: SavedRequest, env: ApiEnv | null): string | undefined {
  if (r.method === 'GET' || r.method === 'HEAD' || r.bodyMode === 'none') return undefined;
  if (r.bodyMode === 'form') {
    return r.form
      .filter((f) => f.on && f.k)
      .map((f) => `${encodeURIComponent(substitute(f.k, env))}=${encodeURIComponent(substitute(f.v, env))}`)
      .join('&');
  }
  return substitute(r.body, env);
}

// ── backend send (no CORS) via PowerShell HttpClient — mirrors HttpHeadersModule ──

interface BackendResp {
  code: number;
  desc: string;
  ctype: string;
  body: string;
  headers: { k: string; v: string }[] | { k: string; v: string };
}

async function backendSend(
  finalUrl: string,
  method: string,
  headers: [string, string][],
  body: string | undefined,
): Promise<Omit<Resp, 'ms'>> {
  const esc = (s: string) => s.replace(/'/g, "''");
  const lines: string[] = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue',
    '$h = New-Object System.Net.Http.HttpClientHandler',
    '$h.AllowAutoRedirect = $false',
    '$h.UseCookies = $false',
    'try { $h.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate } catch {}',
    '$c = New-Object System.Net.Http.HttpClient($h)',
    '$c.Timeout = [TimeSpan]::FromSeconds(100)',
    `$m = New-Object System.Net.Http.HttpMethod('${esc(method)}')`,
    `$req = New-Object System.Net.Http.HttpRequestMessage($m, '${esc(finalUrl)}')`,
  ];

  // Content first (so content-type headers can attach), then non-content headers.
  const ctPair = headers.find(([k]) => k.toLowerCase() === 'content-type');
  if (body !== undefined) {
    lines.push(`$bytes = [System.Text.Encoding]::UTF8.GetBytes('${esc(body)}')`);
    lines.push('$req.Content = New-Object System.Net.Http.ByteArrayContent(,$bytes)');
    if (ctPair) {
      lines.push(
        `try { $req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('${esc(ctPair[1])}') } catch {}`,
      );
    }
  }
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-type') continue; // handled above
    if (lk === 'authorization') {
      // Authorization is a restricted header — set it explicitly.
      lines.push(`try { $req.Headers.TryAddWithoutValidation('${esc(k)}', '${esc(v)}') | Out-Null } catch {}`);
      continue;
    }
    lines.push(
      `if (-not $req.Headers.TryAddWithoutValidation('${esc(k)}', '${esc(v)}')) { if ($req.Content) { $req.Content.Headers.TryAddWithoutValidation('${esc(k)}', '${esc(v)}') | Out-Null } }`,
    );
  }

  lines.push('$resp = $c.SendAsync($req).GetAwaiter().GetResult()');
  lines.push('$bodyText = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()');
  lines.push('$pairs = @()');
  lines.push('foreach ($kv in $resp.Headers) { foreach ($val in $kv.Value) { $pairs += [pscustomobject]@{ k = $kv.Key; v = [string]$val } } }');
  lines.push('if ($resp.Content) { foreach ($kv in $resp.Content.Headers) { foreach ($val in $kv.Value) { $pairs += [pscustomobject]@{ k = $kv.Key; v = [string]$val } } } }');
  lines.push('$ct = ""; if ($resp.Content -and $resp.Content.Headers.ContentType) { $ct = [string]$resp.Content.Headers.ContentType }');
  lines.push('[pscustomobject]@{ code = [int]$resp.StatusCode; desc = [string]$resp.ReasonPhrase; ctype = $ct; body = [string]$bodyText; headers = @($pairs) }');

  const rows = await runPowershellJson<BackendResp>(lines.join('\n'));
  const r = rows[0];
  if (!r) throw new Error('empty backend response');
  const rawHeaders = r.headers;
  const hs = Array.isArray(rawHeaders) ? rawHeaders : rawHeaders ? [rawHeaders] : [];
  const bodyText = r.body ?? '';
  return {
    ok: true,
    status: r.code,
    statusText: r.desc ?? '',
    bytes: new Blob([bodyText]).size,
    body: bodyText,
    contentType: r.ctype ?? '',
    headers: hs.map((p) => [p.k, p.v] as [string, string]),
  };
}

// ── row editor ─────────────────────────────────────────────────────────────────

function KeyVals({
  rows,
  setRows,
  kPh,
  vPh,
  masked,
}: {
  rows: Row[];
  setRows: (r: Row[]) => void;
  kPh: string;
  vPh: string;
  masked?: boolean;
}) {
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="kv-list">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={r.on} onChange={(e) => patch(i, { on: e.target.checked })} />
          <input className="mod-search" placeholder={kPh} value={r.k} onChange={(e) => patch(i, { k: e.target.value })} />
          <input
            className="mod-search"
            type={masked ? 'password' : 'text'}
            placeholder={vPh}
            value={r.v}
            onChange={(e) => patch(i, { v: e.target.value })}
          />
          <button className="mini danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ── module ─────────────────────────────────────────────────────────────────────

export function ApiClientModule() {
  const { t } = useTranslation();

  const [ws, setWs] = useState<Workspace>(() => loadWorkspace());

  // The working request being edited (a copy detached from any saved one).
  const [req, setReq] = useState<SavedRequest>(() => ws.collections[0]?.requests[0] ?? newRequest());
  const [loadedId, setLoadedId] = useState<string | null>(() => ws.collections[0]?.requests[0]?.id ?? null);

  const [resp, setResp] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [pretty, setPretty] = useState(true);
  const [note, setNote] = useState('');
  const firstRender = useRef(true);

  // Persist workspace whenever it changes (never on mount before any change).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(ws));
    } catch {
      /* best effort */
    }
  }, [ws]);

  const activeEnv = useMemo(() => ws.environments.find((e) => e.id === ws.activeEnvId) ?? null, [ws.environments, ws.activeEnvId]);

  const patchReq = (p: Partial<SavedRequest>) => setReq((r) => ({ ...r, ...p }));

  // ── send (mutation — explicit click only) ──
  const send = async () => {
    if (!req.url.trim()) {
      setNote(t('api.needUrl'));
      return;
    }
    setNote('');
    setBusy(true);
    const finalUrl = buildUrl(req.url, req.params, activeEnv);
    const headers = resolveHeaders(req, activeEnv);
    const body = resolveBody(req, activeEnv);
    const t0 = performance.now();
    let result: Resp;
    try {
      if (isTauri()) {
        const r = await backendSend(finalUrl, req.method, headers, body);
        result = { ...r, ms: Math.round(performance.now() - t0) };
      } else {
        const h = new Headers();
        for (const [k, v] of headers) h.set(k, v);
        const r = await fetch(finalUrl, { method: req.method, headers: h, body, redirect: 'manual' });
        const text = await r.text();
        result = {
          ok: true,
          status: r.status,
          statusText: r.statusText,
          ms: Math.round(performance.now() - t0),
          bytes: new Blob([text]).size,
          body: text,
          contentType: r.headers.get('content-type') ?? '',
          headers: [...r.headers.entries()],
        };
      }
    } catch (e) {
      result = {
        ok: false,
        status: 0,
        statusText: '',
        ms: Math.round(performance.now() - t0),
        bytes: 0,
        body: '',
        contentType: '',
        headers: [],
        error: String(e instanceof Error ? e.message : e),
      };
    }
    setResp(result);
    setPretty(true);
    // Record history (cap at 40).
    setWs((w) => ({
      ...w,
      history: [
        { id: uid(), method: req.method, url: finalUrl, status: result.status, ms: result.ms, at: Date.now() },
        ...w.history,
      ].slice(0, 40),
    }));
    setBusy(false);
  };

  // ── collections / saved requests ──
  const loadInto = (r: SavedRequest) => {
    // Deep clone so edits to the editor don't mutate the stored request.
    setReq(JSON.parse(JSON.stringify(r)) as SavedRequest);
    setLoadedId(r.id);
    setResp(null);
    setNote('');
  };

  const newCollection = () => {
    const name = (typeof prompt !== 'undefined' ? prompt(t('api.collNamePrompt'), 'My API') : 'My API')?.trim();
    if (!name) return;
    setWs((w) => ({ ...w, collections: [...w.collections, { id: uid(), name, requests: [] }] }));
  };

  const renameCollection = (c: Collection) => {
    const name = (typeof prompt !== 'undefined' ? prompt(t('api.collNamePrompt'), c.name) : c.name)?.trim();
    if (!name) return;
    setWs((w) => ({ ...w, collections: w.collections.map((x) => (x.id === c.id ? { ...x, name } : x)) }));
  };

  const deleteCollection = (c: Collection) => {
    if (typeof confirm !== 'undefined' && !confirm(t('api.confirmDeleteColl', { name: c.name }))) return;
    setWs((w) => ({ ...w, collections: w.collections.filter((x) => x.id !== c.id) }));
  };

  const deleteRequest = (c: Collection, r: SavedRequest) => {
    if (typeof confirm !== 'undefined' && !confirm(t('api.confirmDeleteReq', { name: r.name }))) return;
    setWs((w) => ({
      ...w,
      collections: w.collections.map((x) => (x.id === c.id ? { ...x, requests: x.requests.filter((q) => q.id !== r.id) } : x)),
    }));
  };

  const saveRequest = () => {
    if (ws.collections.length === 0) {
      newCollection();
      return;
    }
    const first = ws.collections[0];
    if (!first) return;
    const suggested = req.name && req.name !== 'New Request' ? req.name : req.url || 'Request';
    const name = (typeof prompt !== 'undefined' ? prompt(t('api.reqNamePrompt'), suggested) : suggested)?.trim();
    if (!name) return;
    // Save into the collection that already holds this id, else the first one.
    setWs((w) => {
      const targetColl = w.collections.find((c) => c.requests.some((q) => q.id === loadedId)) ?? w.collections[0];
      if (!targetColl) return w;
      const saved: SavedRequest = { ...JSON.parse(JSON.stringify(req)), name, id: loadedId ?? uid() };
      return {
        ...w,
        collections: w.collections.map((c) => {
          if (c.id !== targetColl.id) return c;
          const exists = c.requests.some((q) => q.id === saved.id);
          return {
            ...c,
            requests: exists ? c.requests.map((q) => (q.id === saved.id ? saved : q)) : [...c.requests, saved],
          };
        }),
      };
    });
    setLoadedId((id) => id ?? req.id);
    setNote(t('api.saved', { name }));
  };

  // ── environments ──
  const newEnv = () => {
    const name = (typeof prompt !== 'undefined' ? prompt(t('api.envNamePrompt'), 'Production') : 'Production')?.trim();
    if (!name) return;
    const env: ApiEnv = { id: uid(), name, vars: [] };
    setWs((w) => ({ ...w, environments: [...w.environments, env], activeEnvId: env.id }));
  };

  const setEnvVars = (rows: Row[]) => {
    if (!activeEnv) return;
    setWs((w) => ({ ...w, environments: w.environments.map((e) => (e.id === activeEnv.id ? { ...e, vars: rows } : e)) }));
  };

  const renameEnv = () => {
    if (!activeEnv) return;
    const name = (typeof prompt !== 'undefined' ? prompt(t('api.envNamePrompt'), activeEnv.name) : activeEnv.name)?.trim();
    if (!name) return;
    setWs((w) => ({ ...w, environments: w.environments.map((e) => (e.id === activeEnv.id ? { ...e, name } : e)) }));
  };

  const deleteEnv = () => {
    if (!activeEnv) return;
    if (typeof confirm !== 'undefined' && !confirm(t('api.confirmDeleteEnv', { name: activeEnv.name }))) return;
    setWs((w) => ({
      ...w,
      environments: w.environments.filter((e) => e.id !== activeEnv.id),
      activeEnvId: null,
    }));
  };

  // ── response body view ──
  const respBodyText = useMemo(() => {
    if (!resp) return '';
    if (resp.error) return `⚠ ${resp.error}`;
    if (pretty && looksJson(resp.contentType, resp.body)) {
      return prettyJson(resp.body) ?? resp.body;
    }
    return resp.body;
  }, [resp, pretty]);

  const saveResponse = () => {
    if (!resp || resp.error) return;
    const ext = looksJson(resp.contentType, resp.body) ? 'json' : 'txt';
    const blob = new Blob([respBodyText], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `response.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── request sub-tabs ──
  const reqTabs = [
    {
      id: 'params',
      en: 'Query Params',
      zh: '查詢參數',
      render: () => (
        <>
          <KeyVals rows={req.params} setRows={(r) => patchReq({ params: r })} kPh={t('api.key')} vPh={t('api.value')} />
          <button className="mini" onClick={() => patchReq({ params: [...req.params, emptyRow()] })}>
            {t('api.addParam')}
          </button>
        </>
      ),
    },
    {
      id: 'headers',
      en: 'Headers',
      zh: '標頭',
      render: () => (
        <>
          <KeyVals rows={req.headers} setRows={(r) => patchReq({ headers: r })} kPh={t('api.headerName')} vPh={t('api.value')} />
          <button className="mini" onClick={() => patchReq({ headers: [...req.headers, emptyRow()] })}>
            {t('api.addHeader')}
          </button>
        </>
      ),
    },
    {
      id: 'body',
      en: 'Body',
      zh: '內文',
      render: () => (
        <>
          <div className="mod-toolbar">
            {(['none', 'json', 'text', 'form'] as BodyMode[]).map((m) => (
              <button key={m} className={`mini${req.bodyMode === m ? ' primary' : ''}`} onClick={() => patchReq({ bodyMode: m })}>
                {t(`api.body_${m}`)}
              </button>
            ))}
            {req.bodyMode === 'json' && (
              <button className="mini" onClick={() => patchReq({ body: prettyJson(req.body) ?? req.body })}>
                {t('api.beautify')}
              </button>
            )}
          </div>
          {(req.bodyMode === 'json' || req.bodyMode === 'text') && (
            <textarea
              className="hosts-edit"
              spellCheck={false}
              style={{ fontFamily: 'Consolas, monospace' }}
              value={req.body}
              onChange={(e) => patchReq({ body: e.target.value })}
              placeholder={t('api.bodyPlaceholder')}
            />
          )}
          {req.bodyMode === 'form' && (
            <>
              <KeyVals rows={req.form} setRows={(r) => patchReq({ form: r })} kPh={t('api.field')} vPh={t('api.value')} />
              <button className="mini" onClick={() => patchReq({ form: [...req.form, emptyRow()] })}>
                {t('api.addField')}
              </button>
            </>
          )}
        </>
      ),
    },
    {
      id: 'auth',
      en: 'Auth',
      zh: '驗證',
      render: () => (
        <>
          <div className="mod-toolbar">
            {(['none', 'bearer', 'basic', 'apikey'] as AuthMode[]).map((m) => (
              <button key={m} className={`mini${req.authMode === m ? ' primary' : ''}`} onClick={() => patchReq({ authMode: m })}>
                {t(`api.auth_${m}`)}
              </button>
            ))}
          </div>
          {req.authMode === 'bearer' && (
            <input
              className="mod-search"
              style={{ width: '100%' }}
              type="password"
              placeholder={t('api.token')}
              value={req.token}
              onChange={(e) => patchReq({ token: e.target.value })}
            />
          )}
          {req.authMode === 'basic' && (
            <div className="mod-toolbar">
              <input className="mod-search" placeholder={t('api.user')} value={req.user} onChange={(e) => patchReq({ user: e.target.value })} />
              <input
                className="mod-search"
                type="password"
                placeholder={t('api.pass')}
                value={req.pass}
                onChange={(e) => patchReq({ pass: e.target.value })}
              />
            </div>
          )}
          {req.authMode === 'apikey' && (
            <div className="mod-toolbar">
              <input
                className="mod-search"
                placeholder={t('api.apiKeyName')}
                value={req.apiKeyName}
                onChange={(e) => patchReq({ apiKeyName: e.target.value })}
              />
              <input
                className="mod-search"
                type="password"
                placeholder={t('api.apiKeyValue')}
                value={req.apiKeyValue}
                onChange={(e) => patchReq({ apiKeyValue: e.target.value })}
              />
            </div>
          )}
        </>
      ),
    },
  ];

  // ── response sub-tabs ──
  const respTabs = [
    {
      id: 'rbody',
      en: 'Response Body',
      zh: '回應內文',
      render: () => (
        <>
          <div className="mod-toolbar">
            <button className={`mini${pretty ? ' primary' : ''}`} onClick={() => setPretty(true)}>
              {t('api.pretty')}
            </button>
            <button className={`mini${!pretty ? ' primary' : ''}`} onClick={() => setPretty(false)}>
              {t('api.raw')}
            </button>
            <button className="mini" disabled={!resp || !!resp.error} onClick={() => void navigator.clipboard?.writeText(respBodyText)}>
              {t('api.copy')}
            </button>
            <button className="mini" disabled={!resp || !!resp.error} onClick={saveResponse}>
              {t('api.saveResp')}
            </button>
          </div>
          <textarea className="hosts-edit" spellCheck={false} readOnly style={{ fontFamily: 'Consolas, monospace' }} value={respBodyText} placeholder={t('api.respPlaceholder')} />
        </>
      ),
    },
    {
      id: 'rheaders',
      en: 'Response Headers',
      zh: '回應標頭',
      render: () => (
        <div className="dt-wrap">
          <table className="dt">
            <tbody>
              {(resp?.headers ?? []).map(([k, v], i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                  <td style={{ wordBreak: 'break-all' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    },
  ];

  // ── sidebar sub-tabs (collections / environment / history) ──
  const sideTabs = [
    {
      id: 'collections',
      en: 'Collections',
      zh: '集合',
      render: () => (
        <div className="kv-list" style={{ gap: 4 }}>
          <div className="mod-toolbar" style={{ marginBottom: 6 }}>
            <button className="mini" onClick={newCollection}>
              {t('api.newCollection')}
            </button>
            <button className="mini primary" onClick={saveRequest}>
              {t('api.saveReq')}
            </button>
          </div>
          {ws.collections.length === 0 && <p className="count-note">{t('api.noCollections')}</p>}
          {ws.collections.map((c) => (
            <div key={c.id} style={{ marginBottom: 6 }}>
              <div className="kv-row" style={{ fontWeight: 600 }}>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>▤ {c.name}</span>
                <button className="mini" title={t('api.rename')} onClick={() => renameCollection(c)}>
                  ✎
                </button>
                <button className="mini danger" title={t('api.delete')} onClick={() => deleteCollection(c)}>
                  ✕
                </button>
              </div>
              {c.requests.map((r) => (
                <div className="kv-row" key={r.id} style={{ paddingLeft: 12 }}>
                  <button
                    className="mini"
                    style={{ flex: 1, textAlign: 'left', background: r.id === loadedId ? 'var(--bg-card-hover)' : undefined }}
                    onClick={() => loadInto(r)}
                  >
                    <span className={`status-pill ${statusClass(r.method === 'DELETE' ? 400 : 200)}`} style={{ marginRight: 6 }}>
                      {r.method}
                    </span>
                    {r.name}
                  </button>
                  <button className="mini danger" title={t('api.delete')} onClick={() => deleteRequest(c, r)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'env',
      en: 'Environment',
      zh: '環境',
      render: () => (
        <div className="kv-list">
          <div className="mod-toolbar" style={{ marginBottom: 6 }}>
            <select
              className="mod-select"
              value={ws.activeEnvId ?? ''}
              onChange={(e) => setWs((w) => ({ ...w, activeEnvId: e.target.value || null }))}
            >
              <option value="">{t('api.noEnv')}</option>
              {ws.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button className="mini" onClick={newEnv}>
              {t('api.newEnv')}
            </button>
          </div>
          {activeEnv ? (
            <>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('api.envHint', { name: activeEnv.name })}
              </p>
              <KeyVals rows={activeEnv.vars} setRows={setEnvVars} kPh={t('api.varName')} vPh={t('api.value')} />
              <div className="mod-toolbar">
                <button className="mini" onClick={() => setEnvVars([...activeEnv.vars, emptyRow()])}>
                  {t('api.addVar')}
                </button>
                <button className="mini" onClick={renameEnv}>
                  {t('api.renameEnv')}
                </button>
                <button className="mini danger" onClick={deleteEnv}>
                  {t('api.deleteEnv')}
                </button>
              </div>
            </>
          ) : (
            <p className="count-note">{t('api.pickEnv')}</p>
          )}
        </div>
      ),
    },
    {
      id: 'history',
      en: 'History',
      zh: '歷史',
      render: () => (
        <div className="kv-list" style={{ gap: 4 }}>
          {ws.history.length === 0 ? (
            <p className="count-note">{t('api.noHistory')}</p>
          ) : (
            <>
              <div className="mod-toolbar" style={{ marginBottom: 6 }}>
                <button className="mini danger" onClick={() => setWs((w) => ({ ...w, history: [] }))}>
                  {t('api.clearHistory')}
                </button>
              </div>
              {ws.history.map((hst) => (
                <button
                  key={hst.id}
                  className="mini"
                  style={{ textAlign: 'left', display: 'block', width: '100%' }}
                  title={hst.url}
                  onClick={() => patchReq({ method: hst.method, url: hst.url })}
                >
                  <span className={`status-pill ${statusClass(hst.status)}`} style={{ marginRight: 6 }}>
                    {hst.status || '—'}
                  </span>
                  <b>{hst.method}</b>{' '}
                  <span style={{ opacity: 0.75 }}>{hst.url.replace(/^https?:\/\//, '')}</span>{' '}
                  <span className="count-note">· {hst.ms} ms</span>
                </button>
              ))}
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('api.blurb')}
      </p>
      {!isTauri() && (
        <p className="count-note" style={{ margin: '0 0 8px', color: 'var(--danger)' }}>
          {t('api.corsNotice')}
        </p>
      )}

      <div className="api-split">
        {/* Sidebar: collections / environment / history */}
        <aside className="api-side">
          <ModuleTabs tabs={sideTabs} />
        </aside>

        {/* Builder + response */}
        <div className="api-main">
          <div className="mod-toolbar">
            <select className="mod-select" style={{ maxWidth: 120 }} value={req.method} onChange={(e) => patchReq({ method: e.target.value })}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 200, fontFamily: 'Consolas, monospace' }}
              value={req.url}
              onChange={(e) => patchReq({ url: e.target.value })}
              placeholder={t('api.urlPlaceholder')}
            />
            <button className="mini primary" disabled={busy} onClick={() => void send()}>
              {busy ? t('api.sending') : t('api.send')}
            </button>
            <button className="mini" onClick={saveRequest} title={t('api.saveReq')}>
              {t('api.saveShort')}
            </button>
          </div>

          <ModuleTabs tabs={reqTabs} />

          <div className="api-resp">
            <div className="mod-toolbar" style={{ marginTop: 12 }}>
              {resp && !resp.error && (
                <span className={`status-pill ${statusClass(resp.status)}`}>
                  {resp.status} {resp.statusText}
                </span>
              )}
              {resp && !resp.error && (
                <span className="count-note">
                  ⏱ {resp.ms} ms · ⤓ {humanSize(resp.bytes)}
                  {resp.contentType ? ` · ${resp.contentType}` : ''}
                </span>
              )}
            </div>
            {resp ? <ModuleTabs tabs={respTabs} /> : <p className="count-note">{t('api.respPlaceholder')}</p>}
          </div>
        </div>
      </div>

      {note && <p className="mod-msg" style={{ marginTop: 8 }}>{note}</p>}

      {/* Layout for the split — reuses existing tokens; no new css files. */}
      <style>{`
        .api-split { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
        .api-side { flex: 0 0 260px; min-width: 220px; max-width: 100%; }
        .api-main { flex: 1 1 380px; min-width: 300px; }
        @media (max-width: 720px) { .api-side { flex-basis: 100%; } }
      `}</style>
    </div>
  );
}
