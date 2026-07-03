import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Native Docker module ────────────────────────────────────────────────────
//
// Ported from WinForge's DockerModule (Docker.DotNet over the local named pipe).
// In winforge-web the equivalent live path is the docker CLI, which is the client
// that ships with every Docker Desktop / Engine install and talks to the SAME local
// daemon. We query it with `--format '{{json .}}'` so each line is one clean JSON
// object, then parse. Read-only by default; every destructive verb is gated behind
// an explicit confirm and never auto-runs.

interface ContainerRow {
  ID: string;
  Names: string;
  Image: string;
  Status: string;
  State: string;
  Ports: string;
  CreatedAt: string;
}
interface ImageRow {
  ID: string;
  Repository: string;
  Tag: string;
  Size: string;
  CreatedSince: string;
}
interface VolumeRow {
  Name: string;
  Driver: string;
  Mountpoint: string;
}
interface NetworkRow {
  ID: string;
  Name: string;
  Driver: string;
  Scope: string;
}

type TabId = 'containers' | 'images' | 'volumes' | 'networks';

/** Run `docker <args>` and return the raw command output (empty when not on Tauri). */
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

function isRunning(state: string): boolean {
  const s = (state || '').toLowerCase();
  return s === 'running' || s === 'restarting';
}
function isPaused(state: string): boolean {
  return (state || '').toLowerCase() === 'paused';
}
function shortId(id: string): string {
  const raw = (id || '').replace(/^sha256:/, '');
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

export function DockerModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>('containers');
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [pull, setPull] = useState('');

  // Engine version — also serves as the reachability probe for the daemon.
  const ver = useAsync(async () => {
    const { stdout, stderr, ok } = await docker(['version', '--format', '{{.Server.Version}}']);
    const v = stdout.trim();
    if (!ok || !v) throw new Error(stderr.trim() || 'Docker daemon not reachable');
    return v;
  }, []);

  const containers = useAsync(
    () => dockerJsonList<ContainerRow>(['ps', '-a', '--no-trunc']),
    [],
  );
  const images = useAsync(() => dockerJsonList<ImageRow>(['image', 'ls']), []);
  const volumes = useAsync(() => dockerJsonList<VolumeRow>(['volume', 'ls']), []);
  const networks = useAsync(() => dockerJsonList<NetworkRow>(['network', 'ls']), []);

  const reloadAll = useCallback(() => {
    ver.reload();
    containers.reload();
    images.reload();
    volumes.reload();
    networks.reload();
  }, [ver, containers, images, volumes, networks]);

  const cList = containers.data ?? [];
  const runningCount = cList.filter((c) => isRunning(c.State)).length;

  // ── actions ────────────────────────────────────────────────────────────────
  const run = async (key: string, args: string[], okMsg: string, after: () => void) => {
    setBusy(key);
    setMsg(null);
    try {
      const { stderr, ok } = await docker(args);
      if (!ok) throw new Error(stderr.trim() || 'command failed');
      setMsg(okMsg);
      after();
    } catch (e) {
      setMsg(`${t('docker.actionFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const containerAct = (verb: 'start' | 'stop' | 'restart' | 'pause' | 'unpause', id: string) =>
    run(`${verb}:${id}`, ['container', verb, id], t(`docker.did.${verb}`), containers.reload);

  const removeContainer = (c: ContainerRow) => {
    const force = isRunning(c.State) || isPaused(c.State);
    const label = (c.Names || shortId(c.ID)).replace(/^\//, '');
    if (!window.confirm(t('docker.confirmRemoveContainer', { name: label }))) return;
    run(
      `rm:${c.ID}`,
      force ? ['container', 'rm', '-f', c.ID] : ['container', 'rm', c.ID],
      t('docker.did.removed'),
      () => {
        setDetail(null);
        containers.reload();
      },
    );
  };

  const showLogs = async (c: ContainerRow) => {
    setBusy(`logs:${c.ID}`);
    setMsg(null);
    try {
      const { stdout, stderr } = await docker(['logs', '--tail', '500', c.ID]);
      const text = (stdout + (stderr ? '\n' + stderr : '')).trim();
      setDetail(text || t('docker.noLogs'));
    } catch (e) {
      setDetail(String(e));
    } finally {
      setBusy(null);
    }
  };

  const inspect = async (c: ContainerRow) => {
    setBusy(`inspect:${c.ID}`);
    setMsg(null);
    try {
      const { stdout, stderr } = await docker(['inspect', c.ID]);
      setDetail(stdout.trim() || stderr.trim() || '(empty)');
    } catch (e) {
      setDetail(String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPull = () => {
    const name = pull.trim();
    if (!name) return;
    run(`pull:${name}`, ['pull', name], t('docker.did.pulled', { name }), () => {
      setPull('');
      images.reload();
    });
  };

  const removeImage = (img: ImageRow) => {
    const ref = img.Repository && img.Repository !== '<none>' ? `${img.Repository}:${img.Tag}` : img.ID;
    if (!window.confirm(t('docker.confirmRemoveImage', { name: ref }))) return;
    run(`rmi:${img.ID}`, ['image', 'rm', '-f', ref], t('docker.did.removed'), images.reload);
  };
  const pruneImages = () => {
    if (!window.confirm(t('docker.confirmPruneImages'))) return;
    run('prune:img', ['image', 'prune', '-f'], t('docker.did.pruned'), images.reload);
  };

  const createVolume = () => {
    const name = window.prompt(t('docker.promptVolumeName'), '')?.trim();
    if (!name) return;
    run(`vcreate:${name}`, ['volume', 'create', name], t('docker.did.created'), volumes.reload);
  };
  const removeVolume = (v: VolumeRow) => {
    if (!window.confirm(t('docker.confirmRemoveVolume', { name: v.Name }))) return;
    run(`vrm:${v.Name}`, ['volume', 'rm', v.Name], t('docker.did.removed'), volumes.reload);
  };
  const pruneVolumes = () => {
    if (!window.confirm(t('docker.confirmPruneVolumes'))) return;
    run('prune:vol', ['volume', 'prune', '-f'], t('docker.did.pruned'), volumes.reload);
  };

  const createNetwork = () => {
    const name = window.prompt(t('docker.promptNetworkName'), '')?.trim();
    if (!name) return;
    run(`ncreate:${name}`, ['network', 'create', name], t('docker.did.created'), networks.reload);
  };
  const removeNetwork = (n: NetworkRow) => {
    if (!window.confirm(t('docker.confirmRemoveNetwork', { name: n.Name }))) return;
    run(`nrm:${n.ID}`, ['network', 'rm', n.ID], t('docker.did.removed'), networks.reload);
  };
  const pruneNetworks = () => {
    if (!window.confirm(t('docker.confirmPruneNetworks'))) return;
    run('prune:net', ['network', 'prune', '-f'], t('docker.did.pruned'), networks.reload);
  };

  // ── filtered rows ────────────────────────────────────────────────────────────
  const q = filter.trim().toLowerCase();
  const containerRows = useMemo(() => {
    const list = q
      ? cList.filter((c) => `${c.Names} ${c.Image} ${c.Status}`.toLowerCase().includes(q))
      : cList;
    return [...list].sort((a, b) => a.Names.localeCompare(b.Names));
  }, [cList, q]);
  const imageRows = useMemo(() => {
    const list = images.data ?? [];
    return q
      ? list.filter((i) => `${i.Repository} ${i.Tag}`.toLowerCase().includes(q))
      : list;
  }, [images.data, q]);
  const volumeRows = useMemo(() => {
    const list = volumes.data ?? [];
    return q ? list.filter((v) => v.Name.toLowerCase().includes(q)) : list;
  }, [volumes.data, q]);
  const networkRows = useMemo(() => {
    const list = networks.data ?? [];
    return q ? list.filter((n) => n.Name.toLowerCase().includes(q)) : list;
  }, [networks.data, q]);

  // ── columns ────────────────────────────────────────────────────────────────
  const containerCols: Column<ContainerRow>[] = [
    {
      key: 'State',
      header: t('docker.col.state'),
      width: 110,
      render: (c) => <StatusDot ok={isRunning(c.State)} label={isPaused(c.State) ? t('docker.paused') : c.State} />,
    },
    {
      key: 'Names',
      header: t('docker.col.name'),
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{(c.Names || '').replace(/^\//, '')}</div>
          <div className="count-note" style={{ margin: 0 }}>{shortId(c.ID)}</div>
        </div>
      ),
    },
    {
      key: 'Image',
      header: t('docker.col.image'),
      render: (c) => (
        <div>
          <div style={{ fontSize: 12 }}>{c.Image}</div>
          {c.Ports && <div className="count-note" style={{ margin: 0 }}>{c.Ports}</div>}
        </div>
      ),
    },
    { key: 'Status', header: t('docker.col.status'), width: 160 },
    {
      key: 'actions',
      header: '',
      width: 320,
      render: (c) => {
        const b = (v: string) => busy === `${v}:${c.ID}`;
        const running = isRunning(c.State);
        const paused = isPaused(c.State);
        return (
          <span className="row-actions">
            {!running && !paused && (
              <button className="mini" disabled={!!busy} onClick={() => containerAct('start', c.ID)}>
                {t('docker.start')}
              </button>
            )}
            {running && (
              <button className="mini" disabled={!!busy} onClick={() => containerAct('stop', c.ID)}>
                {t('docker.stop')}
              </button>
            )}
            {(running || paused) && (
              <button className="mini" disabled={!!busy} onClick={() => containerAct('restart', c.ID)}>
                {t('docker.restart')}
              </button>
            )}
            {running && !paused && (
              <button className="mini" disabled={!!busy} onClick={() => containerAct('pause', c.ID)}>
                {t('docker.pause')}
              </button>
            )}
            {paused && (
              <button className="mini" disabled={!!busy} onClick={() => containerAct('unpause', c.ID)}>
                {t('docker.unpause')}
              </button>
            )}
            <button className="mini" disabled={b('logs')} onClick={() => showLogs(c)}>
              {t('docker.logs')}
            </button>
            <button className="mini" disabled={b('inspect')} onClick={() => inspect(c)}>
              {t('docker.inspect')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => removeContainer(c)}>
              {t('docker.remove')}
            </button>
          </span>
        );
      },
    },
  ];

  const imageCols: Column<ImageRow>[] = [
    {
      key: 'Repository',
      header: t('docker.col.repo'),
      render: (i) => (
        <span style={{ fontWeight: 600 }}>
          {i.Repository === '<none>' ? '<none>' : `${i.Repository}:${i.Tag}`}
        </span>
      ),
    },
    { key: 'ID', header: t('docker.col.imageId'), width: 150, render: (i) => shortId(i.ID) },
    { key: 'Size', header: t('docker.col.size'), width: 100 },
    { key: 'CreatedSince', header: t('docker.col.created'), width: 130 },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (i) => (
        <button className="mini" disabled={!!busy} onClick={() => removeImage(i)}>
          {t('docker.remove')}
        </button>
      ),
    },
  ];

  const volumeCols: Column<VolumeRow>[] = [
    { key: 'Name', header: t('docker.col.name'), render: (v) => <span style={{ fontWeight: 600 }}>{v.Name}</span> },
    { key: 'Driver', header: t('docker.col.driver'), width: 100 },
    { key: 'Mountpoint', header: t('docker.col.mountpoint') },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (v) => (
        <button className="mini" disabled={!!busy} onClick={() => removeVolume(v)}>
          {t('docker.remove')}
        </button>
      ),
    },
  ];

  const networkCols: Column<NetworkRow>[] = [
    { key: 'Name', header: t('docker.col.name'), render: (n) => <span style={{ fontWeight: 600 }}>{n.Name}</span> },
    { key: 'Driver', header: t('docker.col.driver'), width: 110 },
    { key: 'Scope', header: t('docker.col.scope'), width: 110 },
    { key: 'ID', header: t('docker.col.netId'), width: 150, render: (n) => shortId(n.ID) },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (n) => (
        <button className="mini" disabled={!!busy} onClick={() => removeNetwork(n)}>
          {t('docker.remove')}
        </button>
      ),
    },
  ];

  const tabs: { id: TabId; label: string }[] = [
    { id: 'containers', label: t('docker.tab.containers') },
    { id: 'images', label: t('docker.tab.images') },
    { id: 'volumes', label: t('docker.tab.volumes') },
    { id: 'networks', label: t('docker.tab.networks') },
  ];

  const daemonDown = !!ver.error && !ver.loading;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('docker.blurb')}</p>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('docker.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        {!ver.loading && !ver.error && ver.data && (
          <span className="count-note">
            {t('docker.summary', {
              version: ver.data,
              running: runningCount,
              containers: cList.length,
              images: (images.data ?? []).length,
            })}
          </span>
        )}
      </ModuleToolbar>

      {daemonDown && <pre className="cmd-out error">{t('docker.daemonDown')}</pre>}
      {msg && <p className="mod-msg">{msg}</p>}

      <div className="mod-tabbar" role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tb.id === tab}
            className={`mod-tab${tb.id === tab ? ' active' : ''}`}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'containers' && (
        <AsyncState loading={containers.loading} error={containers.error}>
          <DataTable
            columns={containerCols}
            rows={containerRows}
            rowKey={(c) => c.ID}
            empty={t('docker.noContainers')}
          />
        </AsyncState>
      )}

      {tab === 'images' && (
        <>
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <input
              className="mod-search"
              placeholder={t('docker.pullPlaceholder')}
              value={pull}
              onChange={(e) => setPull(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doPull()}
            />
            <button className="mini primary" disabled={!!busy || !pull.trim()} onClick={doPull}>
              {busy?.startsWith('pull:') ? t('docker.pulling') : t('docker.pull')}
            </button>
            <button className="mini" disabled={!!busy} onClick={pruneImages}>
              {t('docker.prune')}
            </button>
          </div>
          <AsyncState loading={images.loading} error={images.error}>
            <DataTable columns={imageCols} rows={imageRows} rowKey={(i) => i.ID + i.Repository + i.Tag} />
          </AsyncState>
        </>
      )}

      {tab === 'volumes' && (
        <>
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <button className="mini primary" disabled={!!busy} onClick={createVolume}>
              {t('docker.create')}
            </button>
            <button className="mini" disabled={!!busy} onClick={pruneVolumes}>
              {t('docker.prune')}
            </button>
          </div>
          <AsyncState loading={volumes.loading} error={volumes.error}>
            <DataTable columns={volumeCols} rows={volumeRows} rowKey={(v) => v.Name} />
          </AsyncState>
        </>
      )}

      {tab === 'networks' && (
        <>
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <button className="mini primary" disabled={!!busy} onClick={createNetwork}>
              {t('docker.create')}
            </button>
            <button className="mini" disabled={!!busy} onClick={pruneNetworks}>
              {t('docker.prune')}
            </button>
          </div>
          <AsyncState loading={networks.loading} error={networks.error}>
            <DataTable columns={networkCols} rows={networkRows} rowKey={(n) => n.ID} />
          </AsyncState>
        </>
      )}

      {detail && (
        <div style={{ marginTop: 12 }}>
          <div className="mod-form" style={{ marginBottom: 4 }}>
            <strong>{t('docker.output')}</strong>
            <button className="mini" onClick={() => setDetail(null)}>
              {t('docker.close')}
            </button>
          </div>
          <pre className="cmd-out">{detail}</pre>
        </div>
      )}
    </div>
  );
}
