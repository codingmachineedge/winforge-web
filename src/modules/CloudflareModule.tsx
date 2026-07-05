import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ── Native Cloudflare module ─────────────────────────────────────────────────
//
// Ported from WinForge's CloudflareModule / CloudflareService / CloudflareOperations
// (a thin wrapper over the cloudflared and warp-cli CLIs). This upgrade keeps that
// full CLI surface intact (tab 1) and ADDS a live Cloudflare REST API client (tab 2)
// covering token auth, the account/zone pickers, DNS-record CRUD, cache purge and a
// read-only zone settings summary — the API features the desktop equivalent exposes.
//
// Every API call is routed through the backend (PowerShell Invoke-RestMethod) so the
// browser's cross-origin rules never block it. The API token lives only in component
// state, is entered masked, is never persisted and is never written to any log/output.
// Reads auto-run on demand; every mutation (create/edit/delete/purge) needs an explicit
// click and destructive ones get a confirm.

interface CmdOut {
  stdout: string;
  stderr: string;
  ok: boolean;
}

/** Run `<program> <args…>` and return raw text (no-op empty result off Tauri). */
async function cli(program: string, args: string[]): Promise<CmdOut> {
  const res = await runCommand(program, args);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.success };
}

function looksMissing(text: string): boolean {
  const s = text.toLowerCase();
  return s.includes('not recognized') || s.includes('not found') || s.includes('no such file');
}

/** Probe an engine via `--version`; returns a trimmed version line or null. */
async function probeVersion(program: string): Promise<string | null> {
  try {
    const { stdout, stderr, ok } = await cli(program, ['--version']);
    const line = (stdout || stderr).trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (!ok && !line) return null;
    if (!line || looksMissing(line)) return null;
    return line;
  } catch {
    return null;
  }
}

// ── Tunnel-list parsing ──────────────────────────────────────────────────────
// `cloudflared tunnel list --output json` yields a JSON array. Older builds fall
// back to a fixed-width text table; we parse either.
interface Tunnel {
  id: string;
  name: string;
  created: string;
  connections: string;
}

async function fetchTunnels(): Promise<Tunnel[]> {
  const { stdout, stderr, ok } = await cli('cloudflared', ['tunnel', 'list', '--output', 'json']);
  const text = stdout.trim();
  if (!ok && !text) {
    const err = stderr.trim();
    if (err && looksMissing(err)) throw new Error(err);
    if (err) throw new Error(err);
    return [];
  }
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => {
      const conns = row['connections'];
      const connCount = Array.isArray(conns) ? conns.length : 0;
      return {
        id: String(row['id'] ?? row['ID'] ?? ''),
        name: String(row['name'] ?? row['Name'] ?? ''),
        created: String(row['created_at'] ?? row['createdAt'] ?? '').slice(0, 10),
        connections: String(connCount),
      };
    });
  } catch {
    return [];
  }
}

// ── WARP status / settings parsing ───────────────────────────────────────────
// warp-cli emits free text; we surface it raw plus a connected/disconnected dot.
interface WarpState {
  installed: boolean;
  connected: boolean;
  statusText: string;
}

async function fetchWarp(): Promise<WarpState> {
  const ver = await probeVersion('warp-cli');
  if (ver === null) return { installed: false, connected: false, statusText: '' };
  const { stdout, stderr } = await cli('warp-cli', ['status']);
  const text = (stdout + (stderr ? '\n' + stderr : '')).trim();
  const connected = /status update:\s*connected/i.test(text) || /^connected/im.test(text);
  return { installed: true, connected, statusText: text };
}

// ── Operation catalog (ported from Catalog/CloudflareOperations.cs) ──────────
// `template` is the exact command from the C# catalog with placeholders that we
// substitute from the editable inputs before running.
interface Op {
  id: string; // maps to an i18n key: cloudflare.op.<id>
  program: 'cloudflared' | 'warp-cli';
  template: string[]; // args; may contain the placeholder tokens below
  group: string;
  destructive?: boolean;
  requiresAdmin?: boolean;
  longRunning?: boolean; // C# opened a terminal; here we run & capture with a note
}

const TUN = '__TUNNEL__';
const HOST = '__HOSTNAME__';
const URL = '__LOCALURL__';

const OPS: Op[] = [
  // basics
  { id: 'version', program: 'cloudflared', template: ['--version'], group: 'basics' },
  { id: 'update', program: 'cloudflared', template: ['update'], group: 'basics' },
  { id: 'help', program: 'cloudflared', template: ['help'], group: 'basics' },
  // auth
  { id: 'login', program: 'cloudflared', template: ['tunnel', 'login'], group: 'auth', longRunning: true },
  // named tunnels
  { id: 'tunnelList', program: 'cloudflared', template: ['tunnel', 'list'], group: 'tunnels' },
  { id: 'tunnelCreate', program: 'cloudflared', template: ['tunnel', 'create', TUN], group: 'tunnels' },
  { id: 'tunnelInfo', program: 'cloudflared', template: ['tunnel', 'info', TUN], group: 'tunnels' },
  { id: 'tunnelToken', program: 'cloudflared', template: ['tunnel', 'token', TUN], group: 'tunnels' },
  { id: 'routeDns', program: 'cloudflared', template: ['tunnel', 'route', 'dns', TUN, HOST], group: 'tunnels' },
  { id: 'routeIpAdd', program: 'cloudflared', template: ['tunnel', 'route', 'ip', 'add', '10.0.0.0/24', TUN], group: 'tunnels' },
  { id: 'routeIpList', program: 'cloudflared', template: ['tunnel', 'route', 'ip', 'list'], group: 'tunnels' },
  { id: 'tunnelRun', program: 'cloudflared', template: ['tunnel', 'run', TUN], group: 'tunnels', longRunning: true },
  { id: 'tunnelCleanup', program: 'cloudflared', template: ['tunnel', 'cleanup', TUN], group: 'tunnels', destructive: true },
  { id: 'tunnelDelete', program: 'cloudflared', template: ['tunnel', 'delete', TUN], group: 'tunnels', destructive: true },
  // quick tunnel
  { id: 'quickTunnel', program: 'cloudflared', template: ['tunnel', '--url', URL], group: 'quick', longRunning: true },
  // service
  { id: 'serviceInstall', program: 'cloudflared', template: ['service', 'install'], group: 'service', requiresAdmin: true },
  { id: 'serviceUninstall', program: 'cloudflared', template: ['service', 'uninstall'], group: 'service', requiresAdmin: true, destructive: true },
  // access
  { id: 'accessLogin', program: 'cloudflared', template: ['access', 'login', `https://${HOST}`], group: 'access', longRunning: true },
  { id: 'accessCurl', program: 'cloudflared', template: ['access', 'curl', `https://${HOST}`], group: 'access' },
  { id: 'accessTcp', program: 'cloudflared', template: ['access', 'tcp', '--hostname', HOST, '--url', 'localhost:2222'], group: 'access', longRunning: true },
  { id: 'accessSsh', program: 'cloudflared', template: ['access', 'ssh-config', '--hostname', HOST], group: 'access' },
  // DoH
  { id: 'doh', program: 'cloudflared', template: ['proxy-dns', '--port', '5053', '--upstream', 'https://1.1.1.1/dns-query'], group: 'doh', longRunning: true },
  // WARP
  { id: 'warpVersion', program: 'warp-cli', template: ['--version'], group: 'warp' },
  { id: 'warpRegister', program: 'warp-cli', template: ['registration', 'new'], group: 'warp' },
  { id: 'warpConnect', program: 'warp-cli', template: ['connect'], group: 'warp' },
  { id: 'warpDisconnect', program: 'warp-cli', template: ['disconnect'], group: 'warp' },
  { id: 'warpStatus', program: 'warp-cli', template: ['status'], group: 'warp' },
  { id: 'warpSettings', program: 'warp-cli', template: ['settings'], group: 'warp' },
  { id: 'warpModeWarp', program: 'warp-cli', template: ['mode', 'warp'], group: 'warp' },
  { id: 'warpModeDoh', program: 'warp-cli', template: ['mode', 'doh'], group: 'warp' },
  { id: 'warpAccount', program: 'warp-cli', template: ['account'], group: 'warp' },
];

const QUICK: string[] = ['version', 'tunnelList', 'login', 'warpStatus', 'update'];

const GROUPS: string[] = ['basics', 'auth', 'tunnels', 'quick', 'service', 'access', 'doh', 'warp'];

function fillArgs(args: string[], tunnel: string, hostname: string, localUrl: string): string[] {
  const tun = tunnel.trim() || 'MYTUNNEL';
  const host = hostname.trim() || 'app.example.com';
  const url = localUrl.trim() || 'http://localhost:8080';
  return args.map((a) => a.split(TUN).join(tun).split(HOST).join(host).split(URL).join(url));
}

// ══════════════════════════════════════════════════════════════════════════
// Tab 1 — cloudflared / WARP CLI surface (the WinForge desktop module)
// ══════════════════════════════════════════════════════════════════════════
function CliTab() {
  const { t } = useTranslation();
  const [tunnel, setTunnel] = useState('MYTUNNEL');
  const [hostname, setHostname] = useState('app.example.com');
  const [localUrl, setLocalUrl] = useState('http://localhost:8080');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; body: string; err: boolean } | null>(null);

  const engine = useAsync(async () => {
    const [cf, warp] = await Promise.all([probeVersion('cloudflared'), probeVersion('warp-cli')]);
    return { cf, warp };
  }, []);

  const tunnels = useAsync(fetchTunnels, []);
  const warp = useAsync(fetchWarp, []);

  const reloadAll = useCallback(() => {
    engine.reload();
    tunnels.reload();
    warp.reload();
  }, [engine, tunnels, warp]);

  const cfInstalled = !engine.loading && !!engine.data?.cf;

  const runOp = async (op: Op) => {
    if (op.destructive) {
      const label = t(`cloudflare.op.${op.id}.title`);
      if (!window.confirm(t('cloudflare.confirmDestructive', { name: label }))) return;
    }
    if (op.requiresAdmin) {
      if (!window.confirm(t('cloudflare.confirmAdmin', { name: t(`cloudflare.op.${op.id}.title`) }))) return;
    }
    const args = fillArgs(op.template, tunnel, hostname, localUrl);
    setBusy(op.id);
    setOutput(null);
    try {
      const { stdout, stderr, ok } = await cli(op.program, args);
      let body = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).trim();
      if (op.longRunning) {
        body = `${t('cloudflare.longRunningNote')}\n\n${body}`.trim();
      }
      if (!body) body = ok ? t('cloudflare.doneNoOutput') : t('cloudflare.failedNoOutput');
      setOutput({
        title: `${op.program} ${args.join(' ')}`,
        body: body.length > 8000 ? body.slice(-8000) : body,
        err: !ok,
      });
      if (op.id === 'tunnelCreate' || op.id === 'tunnelDelete' || op.id === 'tunnelCleanup') tunnels.reload();
      if (op.group === 'warp') warp.reload();
    } catch (e) {
      setOutput({ title: `${op.program} ${args.join(' ')}`, body: String(e), err: true });
    } finally {
      setBusy(null);
    }
  };

  // Filtered operations by the search box (matches localized title/description + id).
  const shownOps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return OPS;
    return OPS.filter((op) => {
      const hay = `${op.id} ${t(`cloudflare.op.${op.id}.title`)} ${t(`cloudflare.op.${op.id}.desc`)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [filter, t]);

  const opsByGroup = useMemo(() => {
    const map = new Map<string, Op[]>();
    for (const g of GROUPS) map.set(g, []);
    for (const op of shownOps) map.get(op.group)?.push(op);
    return map;
  }, [shownOps]);

  const tunnelCols: Column<Tunnel>[] = [
    { key: 'name', header: t('cloudflare.tun.name'), render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
    { key: 'id', header: t('cloudflare.tun.id'), width: 300, render: (r) => <span style={{ fontSize: 12 }}>{r.id}</span> },
    { key: 'connections', header: t('cloudflare.tun.connections'), width: 110, align: 'center' },
    { key: 'created', header: t('cloudflare.tun.created'), width: 120 },
    {
      key: 'actions',
      header: '',
      width: 90,
      render: (r) => (
        <button
          className="mini"
          disabled={!!busy}
          onClick={() => {
            setTunnel(r.name);
          }}
        >
          {t('cloudflare.use')}
        </button>
      ),
    },
  ];

  return (
    <div className="mod" style={{ paddingTop: 4 }}>
      <ModuleToolbar>
        <button className="mini" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        <span style={{ display: 'inline-flex', gap: 12 }}>
          <StatusDot ok={!!engine.data?.cf} label={engine.data?.cf ? t('cloudflare.cfReady') : t('cloudflare.cfMissing')} />
          <StatusDot ok={!!engine.data?.warp} label={engine.data?.warp ? t('cloudflare.warpReady') : t('cloudflare.warpMissing')} />
        </span>
        {engine.data?.cf && <span className="count-note">{engine.data.cf}</span>}
      </ModuleToolbar>

      {!engine.loading && !engine.data?.cf && <p className="mod-msg">{t('cloudflare.installHint')}</p>}

      {/* Placeholder editors — feed every command that uses them. */}
      <div className="mod-form" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.field.tunnel')}</label>
        <input className="mod-search" style={{ maxWidth: 180 }} value={tunnel} onChange={(e) => setTunnel(e.target.value)} />
        <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.field.hostname')}</label>
        <input className="mod-search" style={{ maxWidth: 200 }} value={hostname} onChange={(e) => setHostname(e.target.value)} />
        <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.field.localUrl')}</label>
        <input className="mod-search" style={{ maxWidth: 220 }} value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} />
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('cloudflare.placeholderHint')}</p>

      {/* Live status: WARP + tunnels */}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{t('cloudflare.warpTitle')}</strong>{' '}
        <StatusDot
          ok={!!warp.data?.connected}
          label={
            !warp.data?.installed
              ? t('cloudflare.warpMissing')
              : warp.data.connected
                ? t('cloudflare.warpConnected')
                : t('cloudflare.warpDisconnected')
          }
        />
      </div>
      {warp.data?.installed && warp.data.statusText && (
        <pre className="cmd-out" style={{ maxHeight: 120 }}>{warp.data.statusText}</pre>
      )}

      <div style={{ marginTop: 12 }}>
        <strong>{t('cloudflare.tunnelsTitle')}</strong>
        <AsyncState loading={tunnels.loading} error={tunnels.error}>
          <DataTable columns={tunnelCols} rows={tunnels.data ?? []} rowKey={(r) => r.id || r.name} empty={t('cloudflare.noTunnels')} />
        </AsyncState>
      </div>

      {/* Operation catalog */}
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('cloudflare.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count-note">{t('cloudflare.opsCount', { total: shownOps.length })}</span>
      </ModuleToolbar>

      {GROUPS.map((g) => {
        const ops = opsByGroup.get(g) ?? [];
        if (ops.length === 0) return null;
        return (
          <div key={g} style={{ marginTop: 12 }}>
            <div className="count-note" style={{ margin: '0 0 4px', fontWeight: 600 }}>{t(`cloudflare.group.${g}`)}</div>
            <div className="dt-wrap">
              <table className="dt">
                <tbody>
                  {ops.map((op) => (
                    <tr key={op.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {t(`cloudflare.op.${op.id}.title`)}
                          {op.destructive && <span className="count-note" style={{ marginLeft: 6 }}>· {t('cloudflare.destructive')}</span>}
                          {op.requiresAdmin && <span className="count-note" style={{ marginLeft: 6 }}>· {t('cloudflare.admin')}</span>}
                          {op.longRunning && <span className="count-note" style={{ marginLeft: 6 }}>· {t('cloudflare.longRunning')}</span>}
                        </div>
                        <div className="count-note" style={{ margin: 0 }}>{t(`cloudflare.op.${op.id}.desc`)}</div>
                      </td>
                      <td style={{ width: 130, textAlign: 'right' }}>
                        <button
                          className={QUICK.includes(op.id) ? 'mini primary' : 'mini'}
                          disabled={busy === op.id || (op.program === 'cloudflared' && !cfInstalled && !engine.loading)}
                          onClick={() => runOp(op)}
                        >
                          {busy === op.id ? t('cloudflare.running') : t(`cloudflare.op.${op.id}.btn`)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {output && (
        <div style={{ marginTop: 12 }}>
          <div className="mod-form" style={{ marginBottom: 4 }}>
            <strong>{output.title}</strong>
            <button className="mini" onClick={() => setOutput(null)}>{t('cloudflare.close')}</button>
          </div>
          <pre className={output.err ? 'cmd-out error' : 'cmd-out'}>{output.body}</pre>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Tab 2 — Cloudflare REST API client (token, account/zone pickers, DNS, purge)
// ══════════════════════════════════════════════════════════════════════════

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfError {
  code: number;
  message: string;
}
interface CfEnvelope<T> {
  success: boolean;
  errors: CfError[];
  messages: unknown[];
  result: T;
  result_info?: { total_count?: number };
}

// PowerShell single-quote escape.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Call the Cloudflare API through the backend so the browser's CORS rules never
 * apply. Uses Invoke-RestMethod with a Bearer header; the token is embedded in a
 * single-quoted PS string (escaped) and is never echoed back. Returns the parsed
 * CfEnvelope. Off Tauri there is no backend — the caller handles that separately.
 */
async function apiFetch<T>(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<CfEnvelope<T>> {
  const uri = `${CF_API}${path}`;
  const parts = [
    "$ErrorActionPreference='Stop'",
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
    `$h=@{ Authorization = 'Bearer ${psq(token)}'; 'Content-Type' = 'application/json' }`,
  ];
  let bodyArg = '';
  if (body !== undefined) {
    const json = JSON.stringify(body);
    parts.push(`$b='${psq(json)}'`);
    bodyArg = ' -Body $b';
  }
  // -SkipHttpErrorCheck isn't on PS 5.1, so trap non-2xx and read the response body,
  // which Cloudflare fills with a proper {success:false,errors:[…]} envelope.
  parts.push(
    'try {' +
      `$r = Invoke-RestMethod -Uri '${psq(uri)}' -Method ${method} -Headers $h${bodyArg} -TimeoutSec 30;` +
      '$r | ConvertTo-Json -Depth 12 -Compress' +
      '} catch {' +
      '$resp = $_.Exception.Response;' +
      'if ($resp) { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd(); if ($txt) { $txt } else { throw } }' +
      'else { throw }' +
      '}',
  );
  const script = parts.join('\n');
  const res = await runPowershell(script);
  const text = res.stdout.trim();
  if (!text) {
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    throw new Error('empty response');
  }
  let parsed: CfEnvelope<T>;
  try {
    parsed = JSON.parse(text) as CfEnvelope<T>;
  } catch {
    throw new Error(text.slice(0, 400));
  }
  return parsed;
}

/** Flatten a Cloudflare errors array into one readable line. */
function cfErrText(env: CfEnvelope<unknown>): string {
  const errs = Array.isArray(env.errors) ? env.errors : [];
  if (errs.length === 0) return 'request failed';
  return errs.map((e) => `${e.code}: ${e.message}`).join('; ');
}

interface CfAccount {
  id: string;
  name: string;
}
interface CfZone {
  id: string;
  name: string;
  status: string;
  plan?: { name?: string };
}
interface CfDns {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

interface DnsDraft {
  type: string;
  name: string;
  content: string;
  ttl: string;
  proxied: boolean;
}

function emptyDraft(): DnsDraft {
  return { type: 'A', name: '', content: '', ttl: '1', proxied: false };
}

function ApiTab() {
  const { t } = useTranslation();
  const tauri = isTauri();

  const [token, setToken] = useState('');
  const [tokenActive, setTokenActive] = useState(false); // set once a call succeeds
  const [accounts, setAccounts] = useState<CfAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [zones, setZones] = useState<CfZone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [records, setRecords] = useState<CfDns[]>([]);
  const [settings, setSettings] = useState<{ ssl: string; dev: string; https: string } | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);

  // DNS create / edit draft.
  const [draft, setDraft] = useState<DnsDraft>(emptyDraft());
  const [editId, setEditId] = useState<string | null>(null);

  const selectedZone = useMemo(() => zones.find((z) => z.id === zoneId) ?? null, [zones, zoneId]);

  const flash = (text: string, err: boolean) => setMsg({ text, err });

  const guardTauri = (): boolean => {
    if (!tauri) {
      flash(t('cloudflare.previewNotice'), true);
      return false;
    }
    if (!token.trim()) {
      flash(t('cloudflare.needToken'), true);
      return false;
    }
    return true;
  };

  // Verify the token, then load accounts. This is the entry point for the whole tab.
  const connect = async () => {
    if (!guardTauri()) return;
    setBusy('connect');
    setMsg(null);
    try {
      const verify = await apiFetch<{ status: string }>(token, 'GET', '/user/tokens/verify');
      if (!verify.success) {
        setTokenActive(false);
        flash(cfErrText(verify), true);
        return;
      }
      const accEnv = await apiFetch<CfAccount[]>(token, 'GET', '/accounts?per_page=50');
      if (!accEnv.success) {
        flash(cfErrText(accEnv), true);
        return;
      }
      const accs = Array.isArray(accEnv.result) ? accEnv.result : [];
      setAccounts(accs);
      setTokenActive(true);
      const firstAcc = accs[0]?.id ?? '';
      setAccountId(firstAcc);
      flash(t('cloudflare.verified', { status: verify.result?.status ?? 'active' }), false);
      await loadZones(firstAcc);
    } catch (e) {
      setTokenActive(false);
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const loadZones = async (acc: string) => {
    setBusy('zones');
    try {
      const q = acc ? `?account.id=${encodeURIComponent(acc)}&per_page=50` : '?per_page=50';
      const env = await apiFetch<CfZone[]>(token, 'GET', `/zones${q}`);
      if (!env.success) {
        flash(cfErrText(env), true);
        return;
      }
      const zs = Array.isArray(env.result) ? env.result : [];
      setZones(zs);
      const firstZone = zs[0]?.id ?? '';
      setZoneId(firstZone);
      setRecords([]);
      setSettings(null);
      if (firstZone) await loadZoneData(firstZone);
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  // DNS records + a compact settings summary for a zone.
  const loadZoneData = async (zone: string) => {
    setBusy('records');
    try {
      const dnsEnv = await apiFetch<CfDns[]>(token, 'GET', `/zones/${zone}/dns_records?per_page=100`);
      if (dnsEnv.success) {
        setRecords(Array.isArray(dnsEnv.result) ? dnsEnv.result : []);
      } else {
        flash(cfErrText(dnsEnv), true);
      }
      // Read-only settings the desktop surface shows: SSL mode, Dev mode, Always-HTTPS.
      const read = async (key: string): Promise<string> => {
        try {
          const s = await apiFetch<{ value: unknown }>(token, 'GET', `/zones/${zone}/settings/${key}`);
          return s.success ? String(s.result?.value ?? '—') : '—';
        } catch {
          return '—';
        }
      };
      const [ssl, dev, https] = await Promise.all([read('ssl'), read('development_mode'), read('always_use_https')]);
      setSettings({ ssl, dev, https });
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const onAccountChange = async (acc: string) => {
    setAccountId(acc);
    if (tauri && token.trim()) await loadZones(acc);
  };

  const onZoneChange = async (zone: string) => {
    setZoneId(zone);
    setRecords([]);
    setSettings(null);
    if (tauri && token.trim() && zone) await loadZoneData(zone);
  };

  // ── DNS mutations (all gated behind an explicit click; delete also confirms) ──
  const submitDraft = async () => {
    if (!guardTauri() || !zoneId) return;
    const name = draft.name.trim();
    const content = draft.content.trim();
    if (!name || !content) {
      flash(t('cloudflare.needNameContent'), true);
      return;
    }
    const ttlNum = Number.parseInt(draft.ttl, 10);
    const payload = {
      type: draft.type,
      name,
      content,
      ttl: Number.isFinite(ttlNum) && ttlNum > 0 ? ttlNum : 1,
      proxied: draft.proxied,
    };
    setBusy('dns-save');
    setMsg(null);
    try {
      const env = editId
        ? await apiFetch<CfDns>(token, 'PUT', `/zones/${zoneId}/dns_records/${editId}`, payload)
        : await apiFetch<CfDns>(token, 'POST', `/zones/${zoneId}/dns_records`, payload);
      if (!env.success) {
        flash(cfErrText(env), true);
        return;
      }
      flash(editId ? t('cloudflare.dnsUpdated', { name }) : t('cloudflare.dnsCreated', { name }), false);
      setDraft(emptyDraft());
      setEditId(null);
      await loadZoneData(zoneId);
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (r: CfDns) => {
    setEditId(r.id);
    setDraft({ type: r.type, name: r.name, content: r.content, ttl: String(r.ttl), proxied: r.proxied });
  };

  const cancelEdit = () => {
    setEditId(null);
    setDraft(emptyDraft());
  };

  const deleteRecord = async (r: CfDns) => {
    if (!guardTauri() || !zoneId) return;
    if (!window.confirm(t('cloudflare.confirmDeleteDns', { name: r.name }))) return;
    setBusy(`del-${r.id}`);
    setMsg(null);
    try {
      const env = await apiFetch<{ id: string }>(token, 'DELETE', `/zones/${zoneId}/dns_records/${r.id}`);
      if (!env.success) {
        flash(cfErrText(env), true);
        return;
      }
      flash(t('cloudflare.dnsDeleted', { name: r.name }), false);
      await loadZoneData(zoneId);
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const purgeCache = async () => {
    if (!guardTauri() || !zoneId) return;
    const zn = selectedZone?.name ?? zoneId;
    if (!window.confirm(t('cloudflare.confirmPurge', { name: zn }))) return;
    setBusy('purge');
    setMsg(null);
    try {
      const env = await apiFetch<{ id: string }>(token, 'POST', `/zones/${zoneId}/purge_cache`, {
        purge_everything: true,
      });
      if (!env.success) {
        flash(cfErrText(env), true);
        return;
      }
      flash(t('cloudflare.purged', { name: zn }), false);
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const dnsCols: Column<CfDns>[] = [
    { key: 'type', header: t('cloudflare.colType'), width: 70, render: (r) => <span style={{ fontWeight: 600 }}>{r.type}</span> },
    { key: 'name', header: t('cloudflare.colName'), render: (r) => <span style={{ wordBreak: 'break-all' }}>{r.name}</span> },
    { key: 'content', header: t('cloudflare.colContent'), render: (r) => <span style={{ wordBreak: 'break-all', fontSize: 12 }}>{r.content}</span> },
    { key: 'ttl', header: t('cloudflare.colTtl'), width: 80, align: 'center', render: (r) => (r.ttl === 1 ? t('cloudflare.ttlAuto') : String(r.ttl)) },
    {
      key: 'proxied',
      header: t('cloudflare.colProxied'),
      width: 90,
      align: 'center',
      render: (r) => <StatusDot ok={r.proxied} label={r.proxied ? t('cloudflare.proxied') : t('cloudflare.dnsOnly')} />,
    },
    {
      key: 'actions',
      header: '',
      width: 150,
      render: (r) => (
        <span className="row-actions">
          <button className="mini" disabled={!!busy} onClick={() => startEdit(r)}>
            {t('cloudflare.edit')}
          </button>
          <button className="mini danger" disabled={busy === `del-${r.id}`} onClick={() => deleteRecord(r)}>
            {t('cloudflare.delete')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod" style={{ paddingTop: 4 }}>
      <p className="count-note" style={{ marginTop: 0 }}>{t('cloudflare.apiBlurb')}</p>

      {!tauri && <p className="mod-msg">{t('cloudflare.previewNotice')}</p>}

      {/* Credentials — masked, never persisted. */}
      <div className="mod-form" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.tokenLabel')}</label>
        <input
          className="mod-search"
          type="password"
          autoComplete="off"
          spellCheck={false}
          style={{ minWidth: 280, flex: 1, fontFamily: 'Consolas, monospace' }}
          placeholder={t('cloudflare.tokenPlaceholder')}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTokenActive(false);
          }}
        />
        <button className="mini primary" disabled={busy === 'connect'} onClick={connect}>
          {busy === 'connect' ? t('cloudflare.verifying') : t('cloudflare.connect')}
        </button>
        <StatusDot ok={tokenActive} label={tokenActive ? t('cloudflare.connected') : t('cloudflare.notConnected')} />
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('cloudflare.tokenNote')}</p>

      {/* Account + zone pickers */}
      {tokenActive && (
        <div className="mod-form" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.account')}</label>
          <select className="mod-select" value={accountId} onChange={(e) => void onAccountChange(e.target.value)} disabled={!!busy}>
            {accounts.length === 0 && <option value="">{t('cloudflare.noAccounts')}</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.zone')}</label>
          <select className="mod-select" value={zoneId} onChange={(e) => void onZoneChange(e.target.value)} disabled={!!busy || zones.length === 0}>
            {zones.length === 0 && <option value="">{t('cloudflare.noZones')}</option>}
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>
          <button className="mini" disabled={!zoneId || !!busy} onClick={() => void loadZoneData(zoneId)}>
            ⟳ {t('modules.refresh')}
          </button>
        </div>
      )}

      {msg && (
        <p className="mod-msg" style={{ color: msg.err ? 'var(--danger)' : undefined }}>{msg.text}</p>
      )}

      {/* Zone settings summary (read-only) */}
      {tokenActive && selectedZone && (
        <div className="dt-wrap" style={{ marginTop: 8 }}>
          <table className="dt">
            <tbody>
              <tr>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.zoneStatus')}</td>
                <td>
                  <StatusDot ok={selectedZone.status === 'active'} label={selectedZone.status} />
                </td>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.zonePlan')}</td>
                <td>{selectedZone.plan?.name ?? '—'}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.sslMode')}</td>
                <td>{settings?.ssl ?? '…'}</td>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.devMode')}</td>
                <td>{settings?.dev ?? '…'}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.alwaysHttps')}</td>
                <td>{settings?.https ?? '…'}</td>
                <td style={{ fontWeight: 600 }}>{t('cloudflare.zoneId')}</td>
                <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{selectedZone.id}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Cache purge (gated) */}
      {tokenActive && zoneId && (
        <div className="mod-form" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
          <strong>{t('cloudflare.cacheTitle')}</strong>
          <button className="mini danger" disabled={busy === 'purge'} onClick={purgeCache}>
            {busy === 'purge' ? t('cloudflare.purging') : t('cloudflare.purgeEverything')}
          </button>
          <span className="count-note" style={{ margin: 0 }}>{t('cloudflare.purgeNote')}</span>
        </div>
      )}

      {/* DNS create / edit form (gated) */}
      {tokenActive && zoneId && (
        <div style={{ marginTop: 12 }}>
          <strong>{editId ? t('cloudflare.editRecord') : t('cloudflare.addRecord')}</strong>
          <div className="mod-form" style={{ flexWrap: 'wrap', gap: 8, marginTop: 4, alignItems: 'center' }}>
            <select className="mod-select" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
              {DNS_TYPES.map((ty) => (
                <option key={ty} value={ty}>{ty}</option>
              ))}
            </select>
            <input
              className="mod-search"
              style={{ maxWidth: 200 }}
              placeholder={t('cloudflare.namePlaceholder')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              className="mod-search"
              style={{ maxWidth: 240 }}
              placeholder={t('cloudflare.contentPlaceholder')}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
            <label className="count-note" style={{ margin: 0 }}>{t('cloudflare.ttl')}</label>
            <input
              className="mod-search"
              style={{ maxWidth: 90 }}
              value={draft.ttl}
              onChange={(e) => setDraft({ ...draft, ttl: e.target.value })}
            />
            <label className="count-note" style={{ margin: 0, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.proxied} onChange={(e) => setDraft({ ...draft, proxied: e.target.checked })} />
              {t('cloudflare.proxy')}
            </label>
            <button className="mini primary" disabled={busy === 'dns-save'} onClick={submitDraft}>
              {busy === 'dns-save'
                ? t('cloudflare.saving')
                : editId
                  ? t('cloudflare.saveEdit')
                  : t('cloudflare.create')}
            </button>
            {editId && (
              <button className="mini" disabled={busy === 'dns-save'} onClick={cancelEdit}>
                {t('cloudflare.cancel')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* DNS records table */}
      {tokenActive && zoneId && (
        <div style={{ marginTop: 12 }}>
          <div className="count-note" style={{ margin: '0 0 4px', fontWeight: 600 }}>
            {t('cloudflare.recordsTitle', { total: records.length })}
          </div>
          {busy === 'records' ? (
            <p className="count-note">{t('modules.loading')}</p>
          ) : (
            <DataTable columns={dnsCols} rows={records} rowKey={(r) => r.id} empty={t('cloudflare.noRecords')} />
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
export function CloudflareModule() {
  const { t } = useTranslation();
  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('cloudflare.blurb')}</p>
      <ModuleTabs
        tabs={[
          { id: 'cli', en: 'Tunnel & WARP', zh: 'Tunnel 與 WARP', render: () => <CliTab /> },
          { id: 'api', en: 'Cloudflare API', zh: 'Cloudflare API', render: () => <ApiTab /> },
        ]}
      />
    </div>
  );
}
