import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

type Row = { k: string; v: string; on: boolean };
type BodyMode = 'none' | 'json' | 'text' | 'form';
type AuthMode = 'none' | 'bearer' | 'basic';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const emptyRow = (): Row => ({ k: '', v: '', on: true });

interface Resp {
  status: number;
  statusText: string;
  ms: number;
  bytes: number;
  body: string;
  headers: [string, string][];
  error?: string;
}

function KeyVals({ rows, setRows, kPh, vPh }: { rows: Row[]; setRows: (r: Row[]) => void; kPh: string; vPh: string }) {
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="kv-list">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={r.on} onChange={(e) => patch(i, { on: e.target.checked })} />
          <input className="mod-search" placeholder={kPh} value={r.k} onChange={(e) => patch(i, { k: e.target.value })} />
          <input className="mod-search" placeholder={vPh} value={r.v} onChange={(e) => patch(i, { v: e.target.value })} />
          <button className="mini" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function buildUrl(url: string, params: Row[]): string {
  const active = params.filter((p) => p.on && p.k);
  if (!active.length) return url;
  const qs = active.map((p) => `${encodeURIComponent(p.k)}=${encodeURIComponent(p.v)}`).join('&');
  return url + (url.includes('?') ? '&' : '?') + qs;
}

export function ApiClientModule() {
  const { t } = useTranslation();
  const [method, setMethod] = useState<string>('GET');
  const [url, setUrl] = useState('https://jsonplaceholder.typicode.com/todos/1');
  const [params, setParams] = useState<Row[]>([emptyRow()]);
  const [headers, setHeaders] = useState<Row[]>([emptyRow()]);
  const [bodyMode, setBodyMode] = useState<BodyMode>('none');
  const [body, setBody] = useState('{\n  "title": "hello"\n}');
  const [authMode, setAuthMode] = useState<AuthMode>('none');
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [resp, setResp] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const send = async () => {
    if (!url.trim()) return setNote(t('api.needUrl'));
    setNote('');
    setBusy(true);
    const finalUrl = buildUrl(url.trim(), params);
    const h = new Headers();
    for (const row of headers) if (row.on && row.k) h.set(row.k, row.v);
    if (authMode === 'bearer' && token) h.set('Authorization', `Bearer ${token}`);
    if (authMode === 'basic' && (user || pass)) h.set('Authorization', `Basic ${btoa(`${user}:${pass}`)}`);
    let sendBody: string | undefined;
    if (bodyMode !== 'none' && method !== 'GET' && method !== 'HEAD') {
      sendBody = body;
      if (bodyMode === 'json' && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
      if (bodyMode === 'text' && !h.has('Content-Type')) h.set('Content-Type', 'text/plain');
      if (bodyMode === 'form' && !h.has('Content-Type')) h.set('Content-Type', 'application/x-www-form-urlencoded');
    }
    const t0 = performance.now();
    try {
      const r = await fetch(finalUrl, { method, headers: h, body: sendBody });
      const text = await r.text();
      setResp({
        status: r.status,
        statusText: r.statusText,
        ms: Math.round(performance.now() - t0),
        bytes: new Blob([text]).size,
        body: text,
        headers: [...r.headers.entries()],
      });
    } catch (e) {
      setResp({ status: 0, statusText: '', ms: Math.round(performance.now() - t0), bytes: 0, body: '', headers: [], error: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const beautify = () => {
    if (!resp) return;
    try {
      setResp({ ...resp, body: JSON.stringify(JSON.parse(resp.body), null, 2) });
    } catch {
      setNote(t('api.notJson'));
    }
  };

  const statusClass = resp && resp.status >= 200 && resp.status < 400 ? 'ok' : 'bad';

  const reqTabs = [
    {
      id: 'params',
      en: 'Query Params',
      zh: '查詢參數',
      render: () => (
        <>
          <KeyVals rows={params} setRows={setParams} kPh={t('api.key')} vPh={t('api.value')} />
          <button className="mini" onClick={() => setParams([...params, emptyRow()])}>
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
          <KeyVals rows={headers} setRows={setHeaders} kPh={t('api.headerName')} vPh={t('api.value')} />
          <button className="mini" onClick={() => setHeaders([...headers, emptyRow()])}>
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
              <button key={m} className={`mini${bodyMode === m ? ' primary' : ''}`} onClick={() => setBodyMode(m)}>
                {t(`api.body_${m}`)}
              </button>
            ))}
          </div>
          {bodyMode !== 'none' && (
            <textarea className="hosts-edit" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('api.bodyPlaceholder')} />
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
            {(['none', 'bearer', 'basic'] as AuthMode[]).map((m) => (
              <button key={m} className={`mini${authMode === m ? ' primary' : ''}`} onClick={() => setAuthMode(m)}>
                {t(`api.auth_${m}`)}
              </button>
            ))}
          </div>
          {authMode === 'bearer' && (
            <input className="mod-search" style={{ width: '100%' }} placeholder={t('api.token')} value={token} onChange={(e) => setToken(e.target.value)} />
          )}
          {authMode === 'basic' && (
            <div className="mod-toolbar">
              <input className="mod-search" placeholder={t('api.user')} value={user} onChange={(e) => setUser(e.target.value)} />
              <input className="mod-search" type="password" placeholder={t('api.pass')} value={pass} onChange={(e) => setPass(e.target.value)} />
            </div>
          )}
        </>
      ),
    },
  ];

  const respTabs = [
    {
      id: 'rbody',
      en: 'Response Body',
      zh: '回應內文',
      render: () => <textarea className="hosts-edit" spellCheck={false} readOnly value={resp?.error ? `⚠ ${resp.error}` : resp?.body ?? ''} placeholder={t('api.respPlaceholder')} />,
    },
    {
      id: 'rheaders',
      en: 'Response Headers',
      zh: '回應標頭',
      render: () => (
        <table className="dt">
          <tbody>
            {(resp?.headers ?? []).map(([k, v], i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
  ];

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
        <input className="mod-search" style={{ flex: 1, minWidth: 220 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('api.urlPlaceholder')} />
        <button className="mini primary" disabled={busy} onClick={send}>
          {busy ? t('api.sending') : t('api.send')}
        </button>
      </div>

      <ModuleTabs tabs={reqTabs} />

      <div className="api-resp">
        <div className="mod-toolbar" style={{ marginTop: 12 }}>
          {resp && !resp.error && (
            <span className={`status-pill ${statusClass}`}>
              {resp.status} {resp.statusText}
            </span>
          )}
          {resp && !resp.error && <span className="count-note">{resp.ms} ms · {resp.bytes} B</span>}
          <button className="mini" disabled={!resp?.body} onClick={beautify}>
            {t('api.beautify')}
          </button>
          <button className="mini" disabled={!resp?.body} onClick={() => resp?.body && navigator.clipboard?.writeText(resp.body)}>
            {t('api.copy')}
          </button>
        </div>
        {resp ? <ModuleTabs tabs={respTabs} /> : <p className="count-note">{t('api.respPlaceholder')}</p>}
      </div>

      {note && <p style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12.5 }}>{note}</p>}
    </div>
  );
}
