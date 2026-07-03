import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Native Bitwarden Vault module ────────────────────────────────────────────
//
// Ported from WinForge's BitwardenModule (a tabbed shell that manages self-hosted
// Vaultwarden containers through the managed DockerService, plus per-tab Bitwarden
// connections). The C# app drives Docker.DotNet over the local named pipe and owns
// its own in-memory keys.
//
// In winforge-web the equivalent LIVE path is the two CLIs that every such setup
// ships with and that talk to the SAME local daemons/vault:
//   • `docker` — lists/controls the running Vaultwarden self-hosted servers.
//   • `bw`     — the official Bitwarden CLI; `bw status` reports the login/lock state.
//
// This module is READ-ONLY for data. Container start/stop/restart mirror the C#
// instance buttons, are safe (no data-volume deletes), and are gated behind an
// explicit confirm — they never auto-run. Master passwords / session keys are never
// read, echoed, or logged here; we only surface the vault's own reported status.

// ── Docker (self-hosted Vaultwarden servers) ─────────────────────────────────

interface ContainerRow {
  ID: string;
  Names: string;
  Image: string;
  Status: string;
  State: string;
  Ports: string;
  CreatedAt: string;
  Labels: string;
}

/** Run `docker <args>`; returns raw output (empty + not-ok when not on Tauri). */
async function docker(args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const res = await runCommand('docker', args);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.success };
}

/** Query a `docker ... --format '{{json .}}'` list; one JSON object per non-empty line. */
async function dockerJsonList<T>(args: string[]): Promise<T[]> {
  const { stdout, stderr, ok } = await docker([...args, '--format', '{{json .}}']);
  if (!ok && !stdout.trim()) {
    throw new Error(stderr.trim() || 'docker command failed');
  }
  const rows: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s) as T);
    } catch {
      // skip non-JSON noise
    }
  }
  return rows;
}

/** A Vaultwarden/Bitwarden-compatible server is anything whose image looks like it. */
function isVaultServer(c: ContainerRow): boolean {
  const hay = `${c.Image} ${c.Names} ${c.Labels}`.toLowerCase();
  return (
    hay.includes('vaultwarden') ||
    hay.includes('bitwarden') ||
    hay.includes('bwrs') ||
    hay.includes('mprasil/bitwarden')
  );
}

function runningState(state: string): boolean {
  const s = (state || '').toLowerCase();
  return s === 'running' || s === 'restarting';
}

/** Extract the first published host port from a `docker ps` Ports string. */
function firstHostPort(ports: string): number | null {
  // e.g. "0.0.0.0:8443->80/tcp, :::8443->80/tcp"
  const m = /(?:0\.0\.0\.0|127\.0\.0\.1|\[?::\]?):(\d+)->/.exec(ports || '');
  return m && m[1] ? Number(m[1]) : null;
}

function localUrl(ports: string): string | null {
  const p = firstHostPort(ports);
  return p ? `http://localhost:${p}` : null;
}

function shortId(id: string): string {
  const raw = (id || '').replace(/^sha256:/, '');
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

// ── Bitwarden CLI (`bw status`) ──────────────────────────────────────────────

interface BwStatus {
  serverUrl: string | null;
  lastSync: string | null;
  userEmail: string | null;
  status: string; // "unauthenticated" | "locked" | "unlocked"
}

async function bwStatus(): Promise<BwStatus | null> {
  const res = await runCommand('bw', ['status']);
  const text = (res.stdout ?? '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<BwStatus>;
    return {
      serverUrl: j.serverUrl ?? null,
      lastSync: j.lastSync ?? null,
      userEmail: j.userEmail ?? null,
      status: j.status ?? 'unknown',
    };
  } catch {
    return null;
  }
}

export function BitwardenModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reach, setReach] = useState<Record<string, 'up' | 'down' | 'checking'>>({});

  // Docker engine version doubles as the reachability probe for the daemon.
  const engine = useAsync(async () => {
    const { stdout, stderr, ok } = await docker(['version', '--format', '{{.Server.Version}}']);
    const v = stdout.trim();
    if (!ok || !v) throw new Error(stderr.trim() || 'Docker engine not reachable');
    return v;
  }, []);

  const containers = useAsync(() => dockerJsonList<ContainerRow>(['ps', '-a', '--no-trunc']), []);

  // Bitwarden CLI login/lock state (read-only; never touches secrets).
  const cli = useAsync(async () => await bwStatus(), []);

  const reloadAll = useCallback(() => {
    engine.reload();
    containers.reload();
    cli.reload();
    setReach({});
  }, [engine, containers, cli]);

  const all = containers.data ?? [];
  const servers = useMemo(() => all.filter(isVaultServer), [all]);
  const runningCount = servers.filter((c) => runningState(c.State)).length;

  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = q
      ? servers.filter((c) => `${c.Names} ${c.Image} ${c.Status}`.toLowerCase().includes(q))
      : servers;
    return [...list].sort((a, b) => a.Names.localeCompare(b.Names));
  }, [servers, q]);

  // ── safe container lifecycle (mirrors the C# Start/Stop buttons) ────────────
  const act = async (verb: 'start' | 'stop' | 'restart', c: ContainerRow) => {
    const name = (c.Names || shortId(c.ID)).replace(/^\//, '');
    if (verb !== 'start' && !window.confirm(t(`bitwarden.confirm.${verb}`, { name }))) return;
    setBusy(c.ID);
    setMsg(null);
    try {
      const { stderr, ok } = await docker(['container', verb, c.ID]);
      if (!ok) throw new Error(stderr.trim() || 'command failed');
      setMsg(t(`bitwarden.did.${verb}`, { name }));
      containers.reload();
    } catch (e) {
      setMsg(`${t('bitwarden.actionFailed', { name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── reachability probe (HTTP HEAD via PowerShell-free runCommand curl) ───────
  const probe = async (c: ContainerRow) => {
    const url = localUrl(c.Ports);
    if (!url) return;
    setReach((r) => ({ ...r, [c.ID]: 'checking' }));
    try {
      // curl ships with Windows 10+; -s silent, -o discard, fast timeout.
      const res = await runCommand('curl', ['-s', '-o', 'NUL', '-m', '4', '-w', '%{http_code}', url]);
      const codeText = (res.stdout ?? '').trim();
      const httpCode = Number(codeText);
      setReach((r) => ({ ...r, [c.ID]: httpCode > 0 ? 'up' : 'down' }));
    } catch {
      setReach((r) => ({ ...r, [c.ID]: 'down' }));
    }
  };

  const openUrl = (c: ContainerRow) => {
    const url = localUrl(c.Ports);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const stateLabel = (c: ContainerRow) =>
    runningState(c.State) ? t('bitwarden.state.running') : t('bitwarden.state.stopped');

  const columns: Column<ContainerRow>[] = [
    {
      key: 'State',
      header: t('bitwarden.col.state'),
      width: 110,
      render: (c) => <StatusDot ok={runningState(c.State)} label={stateLabel(c)} />,
    },
    {
      key: 'Names',
      header: t('bitwarden.col.name'),
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{(c.Names || '').replace(/^\//, '')}</div>
          <div className="count-note" style={{ margin: 0 }}>{shortId(c.ID)}</div>
        </div>
      ),
    },
    {
      key: 'Url',
      header: t('bitwarden.col.url'),
      width: 190,
      render: (c) => {
        const url = localUrl(c.Ports);
        const state = reach[c.ID];
        return (
          <div>
            {url ? (
              <button className="mini" onClick={() => openUrl(c)} title={t('bitwarden.open')}>
                {url}
              </button>
            ) : (
              <span className="count-note" style={{ margin: 0 }}>{t('bitwarden.noPort')}</span>
            )}
            {state && (
              <div style={{ marginTop: 4 }}>
                {state === 'checking' ? (
                  <span className="count-note" style={{ margin: 0 }}>{t('bitwarden.probing')}</span>
                ) : (
                  <StatusDot ok={state === 'up'} label={state === 'up' ? t('bitwarden.reachable') : t('bitwarden.unreachable')} />
                )}
              </div>
            )}
          </div>
        );
      },
    },
    { key: 'Image', header: t('bitwarden.col.image'), width: 200 },
    { key: 'Status', header: t('bitwarden.col.status'), width: 160 },
    {
      key: 'actions',
      header: '',
      width: 300,
      render: (c) => {
        const running = runningState(c.State);
        const url = localUrl(c.Ports);
        return (
          <span className="row-actions">
            {running ? (
              <>
                <button className="mini" disabled={busy === c.ID} onClick={() => act('stop', c)}>
                  {t('bitwarden.stop')}
                </button>
                <button className="mini" disabled={busy === c.ID} onClick={() => act('restart', c)}>
                  {t('bitwarden.restart')}
                </button>
              </>
            ) : (
              <button className="mini" disabled={busy === c.ID} onClick={() => act('start', c)}>
                {t('bitwarden.start')}
              </button>
            )}
            {url && (
              <button className="mini" disabled={reach[c.ID] === 'checking'} onClick={() => probe(c)}>
                {t('bitwarden.probe')}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  const engineDown = !!engine.error && !engine.loading;

  // Bitwarden CLI status card.
  const st = cli.data;
  const cliMap: Record<string, string> = {
    unauthenticated: t('bitwarden.cli.unauthenticated'),
    locked: t('bitwarden.cli.locked'),
    unlocked: t('bitwarden.cli.unlocked'),
    unknown: t('bitwarden.cli.unknown'),
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.blurb')}</p>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('bitwarden.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        {!engine.loading && !engine.error && engine.data && (
          <span className="count-note">
            {t('bitwarden.summary', {
              version: engine.data,
              running: runningCount,
              servers: servers.length,
            })}
          </span>
        )}
      </ModuleToolbar>

      {msg && <p className="mod-msg">{msg}</p>}
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.safeNote')}</p>

      {/* ── Self-hosted servers (Vaultwarden via Docker) ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 4px' }}>{t('bitwarden.serversTitle')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.serversBlurb')}</p>

      {engineDown && <pre className="cmd-out error">{t('bitwarden.engineDown')}</pre>}

      {!engineDown && (
        <AsyncState loading={containers.loading} error={containers.error}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(c) => c.ID}
            empty={t('bitwarden.noServers')}
          />
        </AsyncState>
      )}

      {/* ── Bitwarden CLI vault status ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '20px 0 4px' }}>{t('bitwarden.cliTitle')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.cliBlurb')}</p>

      <AsyncState loading={cli.loading} error={null}>
        {st ? (
          <div className="hosts-edit" style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
            <div>
              <StatusDot ok={st.status === 'unlocked'} label={cliMap[st.status] ?? cliMap.unknown ?? st.status} />
            </div>
            <div className="count-note" style={{ margin: 0 }}>
              {t('bitwarden.cli.server')}: {st.serverUrl || t('bitwarden.cli.official')}
            </div>
            {st.userEmail && (
              <div className="count-note" style={{ margin: 0 }}>
                {t('bitwarden.cli.account')}: {st.userEmail}
              </div>
            )}
            {st.lastSync && (
              <div className="count-note" style={{ margin: 0 }}>
                {t('bitwarden.cli.lastSync')}: {new Date(st.lastSync).toLocaleString()}
              </div>
            )}
          </div>
        ) : (
          <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.cli.notInstalled')}</p>
        )}
      </AsyncState>
    </div>
  );
}
