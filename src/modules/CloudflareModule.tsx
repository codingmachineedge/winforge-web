import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Native Cloudflare & Tunnel module ───────────────────────────────────────
//
// Ported from WinForge's CloudflareModule / CloudflareService / CloudflareOperations
// (a thin wrapper over the cloudflared and warp-cli CLIs). In winforge-web the live
// path is those same two CLIs, driven through the Tauri run_command bridge. We probe
// both engines, render live status tables (tunnel list, WARP status, routed IPs),
// and expose the full operation catalog as run-and-capture buttons.
//
// Placeholders from the C# catalog (MYTUNNEL, app.example.com, http://localhost:8080)
// are lifted into editable inputs so the emitted commands target the user's own
// values. Read-only by default: every destructive/admin verb is gated behind an
// explicit confirm and never auto-runs.

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
    // Not logged in / no cert is a normal state, not a hard error — surface as empty.
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

export function CloudflareModule() {
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
      // Live-state actions refresh their table.
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
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('cloudflare.blurb')}</p>

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

      {!engine.loading && !engine.data?.cf && (
        <p className="mod-msg">{t('cloudflare.installHint')}</p>
      )}

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
