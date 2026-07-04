import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Native Docker module ────────────────────────────────────────────────────
//
// Full port of WinForge's DockerModule (Docker.DotNet over the local named pipe).
// In winforge-web the equivalent live path is the docker CLI, which ships with every
// Docker Desktop / Engine install and talks to the SAME local daemon. We query it with
// `--format '{{json .}}'` so each line is one clean JSON object, then parse.
//
// Feature surface (parity with the C# page):
//   engine     — endpoint box (npipe default, -H override), connect/refresh, disconnect,
//                availability probe (docker version), summary chips, one-click
//                winget install of Docker Desktop when the CLI is missing.
//   containers — ps -a with state dot / name / image+ports / status / created,
//                start · stop · restart · pause · unpause · remove (confirm, force),
//                logs viewer (tail N + refresh), one-shot exec (/bin/sh -c),
//                inspect (summary + pretty JSON), stats snapshot (CPU/MEM/NET/IO).
//   images     — ls, pull with progress output (runPowershell stdout), rm (confirm),
//                prune dangling (confirm), history.
//   volumes    — ls, create, inspect, rm (confirm), prune (confirm).
//   networks   — ls, create (name + driver), inspect, rm (confirm), prune (confirm).
//   compose    — detect compose files in a folder, validate services (config
//                --services), up -d / down (confirm) / ps with an output log.
//
// Reads auto-run; every mutation runs only on explicit click; destructive verbs are
// gated behind a confirm. In a plain browser the full UI renders with bridge no-ops.

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
interface HistoryRow {
  ID?: string;
  CreatedBy?: string;
  CreatedSince?: string;
  Size?: string;
}
interface StatsRow {
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
  BlockIO?: string;
  PIDs?: string;
}
interface VersionJson {
  Client?: { Version?: string } | null;
  Server?: { Version?: string } | null;
}
interface InspectInfo {
  Name?: string;
  Config?: { Image?: string; Env?: string[] } | null;
  State?: { Status?: string } | null;
  Mounts?: { Source?: string; Destination?: string; Mode?: string }[] | null;
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostIP?: string; HostPort?: string }[] | null> | null;
  } | null;
}

type TabId = 'containers' | 'images' | 'volumes' | 'networks' | 'compose';

type EngineMode = 'preview' | 'off' | 'nocli' | 'down' | 'ok';
interface Engine {
  mode: EngineMode;
  client: string;
  server: string;
  compose: string;
  err: string;
}

interface PanelBase {
  title: string;
  body: string;
}
type Panel =
  | (PanelBase & { kind: 'out' })
  | (PanelBase & { kind: 'logs'; id: string; name: string })
  | (PanelBase & { kind: 'exec'; id: string; name: string })
  | (PanelBase & { kind: 'stats'; id: string; name: string });

/** Same default the C# module uses (SettingsStore key docker.endpoint). */
const DEFAULT_EP = 'npipe://./pipe/docker_engine';
const EP_KEY = 'winforge-web.docker.endpoint';
const NET_DRIVERS = ['bridge', 'host', 'overlay', 'macvlan', 'none'] as const;
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Global -H flag when the endpoint differs from the CLI's own default pipe. */
function hostArgs(ep: string): string[] {
  const e = ep.trim();
  return e && e !== DEFAULT_EP ? ['-H', e] : [];
}

/** Run `docker <args>` and return the raw command output. */
async function docker(ep: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const res = await runCommand('docker', [...hostArgs(ep), ...args]);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.success };
}

/** Query a `docker ... --format '{{json .}}'` list; one JSON object per non-empty line. */
async function dockerJsonList<T>(ep: string, args: string[]): Promise<T[]> {
  const { stdout, stderr, ok } = await docker(ep, [...args, '--format', '{{json .}}']);
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

/** PowerShell 5.1 single-quote literal. */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Long-running docker verbs (pull / compose up / down) go through Windows PowerShell
 * so stdout+stderr arrive merged, in order, UTF-8 — the layer-by-layer progress the
 * C# pull dialog streams. 5.1-compatible syntax only.
 */
function psDocker(ep: string, tail: string): string {
  const e = ep.trim();
  const h = e && e !== DEFAULT_EP ? `-H ${psq(e)} ` : '';
  return (
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `try { & docker ${h}${tail} 2>&1 | Out-String -Width 300 } catch { $_ | Out-String; exit 1 }; exit $LASTEXITCODE`
  );
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
function displayName(c: ContainerRow): string {
  return (c.Names || shortId(c.ID)).replace(/^\//, '');
}
function imageRef(img: ImageRow): string {
  return img.Repository && img.Repository !== '<none>' ? `${img.Repository}:${img.Tag}` : img.ID;
}
/** Compose default project name from the folder (parent folder when a file path was given). */
function deriveProject(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  let seg = parts[parts.length - 1] ?? '';
  if (/\.ya?ml$/i.test(seg)) seg = parts[parts.length - 2] ?? '';
  const clean = seg.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return clean || 'app';
}

export function DockerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [tab, setTab] = useState<TabId>('containers');
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pull, setPull] = useState('');
  const [tailN, setTailN] = useState('500');
  const [execCmd, setExecCmd] = useState('ls -la');
  const [volName, setVolName] = useState('');
  const [netName, setNetName] = useState('');
  const [netDriver, setNetDriver] = useState<string>('bridge');

  // Engine endpoint — committed value (ep) drives queries; draft is the text box.
  const [ep, setEp] = useState<string>(() => {
    try {
      return localStorage.getItem(EP_KEY) ?? DEFAULT_EP;
    } catch {
      return DEFAULT_EP;
    }
  });
  const [draft, setDraft] = useState(ep);
  const [off, setOff] = useState(false);

  // Compose tab state.
  const [compDir, setCompDir] = useState('');
  const [compFiles, setCompFiles] = useState<string[]>([]);
  const [compFile, setCompFile] = useState('');
  const [compProj, setCompProj] = useState('app');
  const [compLog, setCompLog] = useState('');

  // ── engine probe (docker CLI availability + daemon reachability) ────────────
  const eng = useAsync<Engine>(async () => {
    if (!desktop) return { mode: 'preview', client: '', server: '', compose: '', err: '' };
    if (off) return { mode: 'off', client: '', server: '', compose: '', err: '' };
    let raw: { stdout: string; stderr: string; ok: boolean };
    try {
      raw = await docker(ep, ['version', '--format', '{{json .}}']);
    } catch (e) {
      return { mode: 'nocli', client: '', server: '', compose: '', err: String(e) };
    }
    let client = '';
    let server = '';
    const line = raw.stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    if (line) {
      try {
        const v = JSON.parse(line.trim()) as VersionJson;
        client = v.Client?.Version ?? '';
        server = v.Server?.Version ?? '';
      } catch {
        // unparseable version output — fall through to stderr heuristics
      }
    }
    let compose = '';
    if (client || server) {
      try {
        const cv = await docker(ep, ['compose', 'version', '--short']);
        if (cv.ok) compose = cv.stdout.trim();
      } catch {
        // compose plugin missing — surfaced in the Compose tab
      }
    }
    if (server) return { mode: 'ok', client, server, compose, err: '' };
    const errTxt = raw.stderr.trim();
    if (client || /daemon|pipe|connect|docker_engine/i.test(errTxt)) {
      return { mode: 'down', client, server: '', compose, err: errTxt };
    }
    return { mode: 'nocli', client: '', server: '', compose: '', err: errTxt };
  }, [desktop, ep, off]);

  const mode: EngineMode | undefined = eng.data?.mode;
  const engineOk = mode === 'ok';

  const containers = useAsync<ContainerRow[]>(
    async () => (desktop && engineOk ? dockerJsonList<ContainerRow>(ep, ['ps', '-a', '--no-trunc']) : []),
    [desktop, engineOk, ep],
  );
  const images = useAsync<ImageRow[]>(
    async () => (desktop && engineOk ? dockerJsonList<ImageRow>(ep, ['image', 'ls']) : []),
    [desktop, engineOk, ep],
  );
  const volumes = useAsync<VolumeRow[]>(
    async () => (desktop && engineOk ? dockerJsonList<VolumeRow>(ep, ['volume', 'ls']) : []),
    [desktop, engineOk, ep],
  );
  const networks = useAsync<NetworkRow[]>(
    async () => (desktop && engineOk ? dockerJsonList<NetworkRow>(ep, ['network', 'ls']) : []),
    [desktop, engineOk, ep],
  );

  const reloadAll = () => {
    eng.reload();
    containers.reload();
    images.reload();
    volumes.reload();
    networks.reload();
  };

  const applyEndpoint = () => {
    const next = draft.trim() || DEFAULT_EP;
    setOff(false);
    try {
      localStorage.setItem(EP_KEY, next);
    } catch {
      // storage unavailable — endpoint still applies for this session
    }
    if (next !== ep) setEp(next);
    else reloadAll();
  };

  const disconnect = () => {
    setOff(true);
    setPanel(null);
    setMsg(t('docker.disconnected'));
  };

  const cList = containers.data ?? [];
  const runningCount = cList.filter((c) => isRunning(c.State)).length;

  // ── generic mutation runner (explicit click only) ────────────────────────────
  const run = async (key: string, args: string[], okMsg: string, after: () => void) => {
    if (!desktop) return;
    setBusy(key);
    setMsg(null);
    try {
      const { stderr, ok } = await docker(ep, args);
      if (!ok) throw new Error(stderr.trim() || 'command failed');
      setMsg(okMsg);
      after();
    } catch (e) {
      setMsg(`${t('docker.actionFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── containers ────────────────────────────────────────────────────────────────
  const containerAct = (verb: 'start' | 'stop' | 'restart' | 'pause' | 'unpause', id: string) =>
    run(`${verb}:${id}`, ['container', verb, id], t(`docker.did.${verb}`), containers.reload);

  const removeContainer = (c: ContainerRow) => {
    const force = isRunning(c.State) || isPaused(c.State);
    const label = displayName(c);
    if (!window.confirm(t('docker.confirmRemoveContainer', { name: label }))) return;
    run(
      `rm:${c.ID}`,
      force ? ['container', 'rm', '-f', c.ID] : ['container', 'rm', c.ID],
      t('docker.did.removed'),
      () => {
        setPanel(null);
        containers.reload();
      },
    );
  };

  const loadLogs = async (id: string, name: string) => {
    if (!desktop) return;
    setBusy(`logs:${id}`);
    setMsg(null);
    try {
      const n = Math.max(1, parseInt(tailN, 10) || 500);
      const { stdout, stderr } = await docker(ep, ['logs', '--tail', String(n), id]);
      const text = (stdout + (stderr ? '\n' + stderr : '')).trim();
      setPanel({ kind: 'logs', title: t('docker.logsTitle', { name }), id, name, body: text || t('docker.noLogs') });
    } catch (e) {
      setPanel({ kind: 'logs', title: t('docker.logsTitle', { name }), id, name, body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const openExec = (c: ContainerRow) => {
    const name = displayName(c);
    setPanel({ kind: 'exec', title: t('docker.execTitle', { name }), id: c.ID, name, body: '' });
  };

  const runExec = async (id: string, name: string) => {
    if (!desktop) return;
    const cmd = execCmd.trim();
    if (!cmd) return;
    setBusy(`exec:${id}`);
    setMsg(null);
    setPanel({ kind: 'exec', title: t('docker.execTitle', { name }), id, name, body: t('docker.running') });
    try {
      // Same wrapper as the C# module: /bin/sh -c "<command>" inside the container.
      const { stdout, stderr } = await docker(ep, ['exec', id, '/bin/sh', '-c', cmd]);
      const text = (stdout + (stderr ? '\n' + stderr : '')).trim();
      setPanel({ kind: 'exec', title: t('docker.execTitle', { name }), id, name, body: text || t('docker.noOutput') });
    } catch (e) {
      setPanel({ kind: 'exec', title: t('docker.execTitle', { name }), id, name, body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const loadStats = async (id: string, name: string) => {
    if (!desktop) return;
    setBusy(`stats:${id}`);
    setMsg(null);
    try {
      const rows = await dockerJsonList<StatsRow>(ep, ['stats', '--no-stream', id]);
      const s = rows[0];
      const body = s
        ? t('docker.statsLine', {
            cpu: s.CPUPerc ?? '',
            mem: s.MemUsage ?? '',
            memPct: s.MemPerc ?? '',
            net: s.NetIO ?? '',
            io: s.BlockIO ?? '',
            pids: s.PIDs ?? '',
          })
        : t('docker.statsNotRunning');
      setPanel({ kind: 'stats', title: t('docker.statsTitle', { name }), id, name, body });
    } catch (e) {
      setPanel({ kind: 'stats', title: t('docker.statsTitle', { name }), id, name, body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const inspectContainer = async (c: ContainerRow) => {
    if (!desktop) return;
    const name = displayName(c);
    setBusy(`inspect:${c.ID}`);
    setMsg(null);
    try {
      const { stdout, stderr } = await docker(ep, ['inspect', c.ID]);
      const raw = stdout.trim();
      let body = raw || stderr.trim() || t('docker.noOutput');
      try {
        // Human summary first (like the C# detail card), full pretty JSON below.
        const arr = JSON.parse(raw) as InspectInfo[];
        const info = arr[0];
        if (info) {
          const lines: string[] = [];
          lines.push(`${t('docker.col.name')}: ${(info.Name ?? '').replace(/^\//, '')}`);
          lines.push(`${t('docker.col.image')}: ${info.Config?.Image ?? ''}`);
          lines.push(`${t('docker.col.state')}: ${info.State?.Status ?? ''}`);
          const env = info.Config?.Env;
          if (env && env.length > 0) {
            lines.push(t('docker.envLabel'));
            for (const e of env) lines.push('  ' + e);
          }
          const mounts = info.Mounts;
          if (mounts && mounts.length > 0) {
            lines.push(t('docker.mountsLabel'));
            for (const m of mounts) {
              lines.push(`  ${m.Source ?? ''} → ${m.Destination ?? ''}${m.Mode ? ` (${m.Mode})` : ''}`);
            }
          }
          const ports = info.NetworkSettings?.Ports;
          if (ports) {
            const keys = Object.keys(ports);
            if (keys.length > 0) {
              lines.push(t('docker.portsLabel'));
              for (const k of keys) {
                const binds = ports[k];
                const txt =
                  binds && binds.length > 0
                    ? ' → ' + binds.map((b) => `${b.HostIp ?? b.HostIP ?? ''}:${b.HostPort ?? ''}`).join(', ')
                    : '';
                lines.push(`  ${k}${txt}`);
              }
            }
          }
          body = `${lines.join('\n')}\n${'─'.repeat(48)}\n${JSON.stringify(arr, null, 2)}`;
        }
      } catch {
        // not JSON — show raw output
      }
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name }), body });
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name }), body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── images ──────────────────────────────────────────────────────────────────
  const doPull = async () => {
    if (!desktop) return;
    const name = pull.trim();
    if (!name) return;
    setBusy(`pull:${name}`);
    setMsg(null);
    setPanel({ kind: 'out', title: t('docker.pullTitle', { name }), body: t('docker.pulling') });
    try {
      // PowerShell captures docker pull's layer-by-layer progress lines (stdout+stderr).
      const res = await runPowershell(psDocker(ep, `pull ${psq(name)}`));
      const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
      setPanel({
        kind: 'out',
        title: t('docker.pullTitle', { name }),
        body: `${out || t('docker.noOutput')}\n\n${res.success ? t('docker.pullDone') : t('docker.actionFailed')}`,
      });
      if (res.success) {
        setMsg(t('docker.did.pulled', { name }));
        setPull('');
        images.reload();
      } else {
        setMsg(t('docker.actionFailed'));
      }
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.pullTitle', { name }), body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const removeImage = (img: ImageRow) => {
    const ref = imageRef(img);
    if (!window.confirm(t('docker.confirmRemoveImage', { name: ref }))) return;
    run(`rmi:${img.ID}`, ['image', 'rm', '-f', ref], t('docker.did.removed'), images.reload);
  };
  const pruneImages = () => {
    if (!window.confirm(t('docker.confirmPruneImages'))) return;
    run('prune:img', ['image', 'prune', '-f'], t('docker.did.pruned'), images.reload);
  };

  const showHistory = async (img: ImageRow) => {
    if (!desktop) return;
    const ref = imageRef(img);
    setBusy(`hist:${img.ID}`);
    setMsg(null);
    try {
      const rows = await dockerJsonList<HistoryRow>(ep, ['history', ref]);
      const body =
        rows.length > 0
          ? rows
              .map((h) => `${(h.Size ?? '').padStart(8)}  ${(h.CreatedSince ?? '').padEnd(14)}  ${h.CreatedBy ?? ''}`)
              .join('\n')
          : t('docker.noOutput');
      setPanel({ kind: 'out', title: t('docker.historyTitle', { name: ref }), body });
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.historyTitle', { name: ref }), body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── volumes ─────────────────────────────────────────────────────────────────
  const createVolume = () => {
    const name = volName.trim();
    if (!name) return;
    run(`vcreate:${name}`, ['volume', 'create', name], t('docker.did.created'), () => {
      setVolName('');
      volumes.reload();
    });
  };
  const removeVolume = (v: VolumeRow) => {
    if (!window.confirm(t('docker.confirmRemoveVolume', { name: v.Name }))) return;
    run(`vrm:${v.Name}`, ['volume', 'rm', v.Name], t('docker.did.removed'), volumes.reload);
  };
  const pruneVolumes = () => {
    if (!window.confirm(t('docker.confirmPruneVolumes'))) return;
    run('prune:vol', ['volume', 'prune', '-f'], t('docker.did.pruned'), volumes.reload);
  };
  const inspectVolume = async (v: VolumeRow) => {
    if (!desktop) return;
    setBusy(`vinspect:${v.Name}`);
    setMsg(null);
    try {
      const { stdout, stderr } = await docker(ep, ['volume', 'inspect', v.Name]);
      const raw = stdout.trim();
      let body = raw || stderr.trim() || t('docker.noOutput');
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // keep raw
      }
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name: v.Name }), body });
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name: v.Name }), body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── networks ────────────────────────────────────────────────────────────────
  const createNetwork = () => {
    const name = netName.trim();
    if (!name) return;
    run(
      `ncreate:${name}`,
      ['network', 'create', '--driver', netDriver, name],
      t('docker.did.created'),
      () => {
        setNetName('');
        networks.reload();
      },
    );
  };
  const removeNetwork = (n: NetworkRow) => {
    if (!window.confirm(t('docker.confirmRemoveNetwork', { name: n.Name }))) return;
    run(`nrm:${n.ID}`, ['network', 'rm', n.ID], t('docker.did.removed'), networks.reload);
  };
  const pruneNetworks = () => {
    if (!window.confirm(t('docker.confirmPruneNetworks'))) return;
    run('prune:net', ['network', 'prune', '-f'], t('docker.did.pruned'), networks.reload);
  };
  const inspectNetwork = async (n: NetworkRow) => {
    if (!desktop) return;
    setBusy(`ninspect:${n.ID}`);
    setMsg(null);
    try {
      const { stdout, stderr } = await docker(ep, ['network', 'inspect', n.ID]);
      const raw = stdout.trim();
      let body = raw || stderr.trim() || t('docker.noOutput');
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // keep raw
      }
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name: n.Name }), body });
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.inspectTitle', { name: n.Name }), body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── compose ─────────────────────────────────────────────────────────────────
  const validateCompose = async (file: string) => {
    if (!desktop || !file) return;
    const { stdout, stderr, ok } = await docker(ep, ['compose', '-f', file, 'config', '--services']);
    if (!ok) {
      const errTxt = stderr.trim();
      setCompLog(
        /not a docker command|unknown (command|flag)|is not recognized/i.test(errTxt)
          ? t('docker.composeMissing')
          : errTxt || t('docker.actionFailed'),
      );
      return;
    }
    const svcs = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    setCompLog(t('docker.composeServices', { n: svcs.length, names: svcs.join(', ') }));
  };

  const detectCompose = async () => {
    if (!desktop) return;
    const input = compDir.trim();
    if (!input) return;
    setBusy('compose:detect');
    setMsg(null);
    try {
      let files: string[] = [];
      if (/\.ya?ml$/i.test(input)) {
        files = [input];
      } else {
        const names = COMPOSE_NAMES.map((n) => psq(n)).join(',');
        const ps =
          `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
          `Get-ChildItem -LiteralPath ${psq(input)} -File | Where-Object { @(${names}) -contains $_.Name.ToLower() } | ForEach-Object { $_.FullName }`;
        const res = await runPowershell(ps);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        files = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      setCompFiles(files);
      const first = files[0];
      if (!first) {
        setCompFile('');
        setCompLog(t('docker.composeNoFiles'));
        return;
      }
      setCompFile(first);
      setCompProj(deriveProject(first));
      await validateCompose(first);
    } catch (e) {
      setCompLog(`${t('docker.actionFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const composeUp = async () => {
    if (!desktop) return;
    const file = compFile.trim();
    const proj = compProj.trim();
    if (!file) {
      setMsg(t('docker.composeNeedFile'));
      return;
    }
    if (!proj) {
      setMsg(t('docker.composeNeedProject'));
      return;
    }
    setBusy('compose:up');
    setMsg(null);
    setCompLog(t('docker.running'));
    try {
      const res = await runPowershell(psDocker(ep, `compose -f ${psq(file)} -p ${psq(proj)} up -d`));
      const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
      setCompLog(out || t('docker.noOutput'));
      if (res.success) {
        setMsg(t('docker.composeUpDone', { name: proj }));
        reloadAll();
      } else {
        setMsg(t('docker.actionFailed'));
      }
    } catch (e) {
      setCompLog(String(e));
    } finally {
      setBusy(null);
    }
  };

  const composeDown = async () => {
    if (!desktop) return;
    const file = compFile.trim();
    const proj = compProj.trim();
    if (!proj) {
      setMsg(t('docker.composeNeedProject'));
      return;
    }
    if (!window.confirm(t('docker.composeConfirmDown', { name: proj }))) return;
    setBusy('compose:down');
    setMsg(null);
    setCompLog(t('docker.running'));
    try {
      const tail = file ? `compose -f ${psq(file)} -p ${psq(proj)} down` : `compose -p ${psq(proj)} down`;
      const res = await runPowershell(psDocker(ep, tail));
      const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
      setCompLog(out || t('docker.noOutput'));
      if (res.success) {
        setMsg(t('docker.composeDownDone', { name: proj }));
        reloadAll();
      } else {
        setMsg(t('docker.actionFailed'));
      }
    } catch (e) {
      setCompLog(String(e));
    } finally {
      setBusy(null);
    }
  };

  const composePs = async () => {
    if (!desktop) return;
    const file = compFile.trim();
    const proj = compProj.trim();
    if (!file && !proj) {
      setMsg(t('docker.composeNeedFile'));
      return;
    }
    setBusy('compose:ps');
    setMsg(null);
    try {
      const args = ['compose', ...(file ? ['-f', file] : []), ...(proj ? ['-p', proj] : []), 'ps'];
      const { stdout, stderr } = await docker(ep, args);
      setCompLog((stdout + (stderr ? '\n' + stderr : '')).trim() || t('docker.noOutput'));
    } catch (e) {
      setCompLog(String(e));
    } finally {
      setBusy(null);
    }
  };

  // ── Docker Desktop install (winget) when CLI/daemon missing ─────────────────
  const installDocker = async () => {
    if (!desktop || busy) return;
    setBusy('install');
    setMsg(null);
    setPanel({ kind: 'out', title: t('docker.installDesktop'), body: t('docker.installing') });
    try {
      const ps =
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
        `try { & winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-String -Width 300 } catch { $_ | Out-String; exit 1 }; exit $LASTEXITCODE`;
      const res = await runPowershell(ps);
      const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
      setPanel({
        kind: 'out',
        title: t('docker.installDesktop'),
        body: `${out || t('docker.noOutput')}\n\n${t('docker.installDone')}`,
      });
    } catch (e) {
      setPanel({ kind: 'out', title: t('docker.installDesktop'), body: String(e) });
    } finally {
      setBusy(null);
    }
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
    return q ? list.filter((i) => `${i.Repository} ${i.Tag}`.toLowerCase().includes(q)) : list;
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
          <div style={{ fontWeight: 600 }}>{displayName(c)}</div>
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
    { key: 'Status', header: t('docker.col.status'), width: 150 },
    {
      key: 'CreatedAt',
      header: t('docker.col.created'),
      width: 130,
      render: (c) => <span className="count-note" style={{ margin: 0 }}>{(c.CreatedAt || '').slice(0, 16)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 400,
      render: (c) => {
        const b = (v: string) => busy === `${v}:${c.ID}`;
        const running = isRunning(c.State);
        const paused = isPaused(c.State);
        const dis = !desktop || !!busy;
        return (
          <span className="row-actions">
            {!running && !paused && (
              <button className="mini" disabled={dis} onClick={() => containerAct('start', c.ID)}>
                {t('docker.start')}
              </button>
            )}
            {running && (
              <button className="mini" disabled={dis} onClick={() => containerAct('stop', c.ID)}>
                {t('docker.stop')}
              </button>
            )}
            {(running || paused) && (
              <button className="mini" disabled={dis} onClick={() => containerAct('restart', c.ID)}>
                {t('docker.restart')}
              </button>
            )}
            {running && !paused && (
              <button className="mini" disabled={dis} onClick={() => containerAct('pause', c.ID)}>
                {t('docker.pause')}
              </button>
            )}
            {paused && (
              <button className="mini" disabled={dis} onClick={() => containerAct('unpause', c.ID)}>
                {t('docker.unpause')}
              </button>
            )}
            <button className="mini" disabled={!desktop || b('logs')} onClick={() => loadLogs(c.ID, displayName(c))}>
              {t('docker.logs')}
            </button>
            {running && (
              <button className="mini" disabled={!desktop || b('exec')} onClick={() => openExec(c)}>
                {t('docker.exec')}
              </button>
            )}
            {(running || paused) && (
              <button className="mini" disabled={!desktop || b('stats')} onClick={() => loadStats(c.ID, displayName(c))}>
                {t('docker.stats')}
              </button>
            )}
            <button className="mini" disabled={!desktop || b('inspect')} onClick={() => inspectContainer(c)}>
              {t('docker.inspect')}
            </button>
            <button className="mini" disabled={dis} onClick={() => removeContainer(c)}>
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
      width: 190,
      render: (i) => (
        <span className="row-actions">
          <button className="mini" disabled={!desktop || !!busy} onClick={() => showHistory(i)}>
            {t('docker.history')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => removeImage(i)}>
            {t('docker.remove')}
          </button>
        </span>
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
      width: 190,
      render: (v) => (
        <span className="row-actions">
          <button className="mini" disabled={!desktop || !!busy} onClick={() => inspectVolume(v)}>
            {t('docker.inspect')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => removeVolume(v)}>
            {t('docker.remove')}
          </button>
        </span>
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
      width: 190,
      render: (n) => (
        <span className="row-actions">
          <button className="mini" disabled={!desktop || !!busy} onClick={() => inspectNetwork(n)}>
            {t('docker.inspect')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => removeNetwork(n)}>
            {t('docker.remove')}
          </button>
        </span>
      ),
    },
  ];

  const tabs: { id: TabId; label: string }[] = [
    { id: 'containers', label: t('docker.tab.containers') },
    { id: 'images', label: t('docker.tab.images') },
    { id: 'volumes', label: t('docker.tab.volumes') },
    { id: 'networks', label: t('docker.tab.networks') },
    { id: 'compose', label: t('docker.tabCompose') },
  ];

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
        <button className="mini" onClick={() => { setOff(false); reloadAll(); }}>
          ⟳ {t('modules.refresh')}
        </button>
        {engineOk && eng.data && (
          <span className="count-note">
            {t('docker.summary', {
              version: eng.data.server,
              running: runningCount,
              containers: cList.length,
              images: (images.data ?? []).length,
            })}
            {eng.data.compose ? ` · ${t('docker.composeVer', { version: eng.data.compose })}` : ''}
          </span>
        )}
      </ModuleToolbar>

      {/* engine endpoint row — same npipe default as the C# module, -H override */}
      <div className="mod-form" style={{ marginBottom: 8 }}>
        <span className="count-note" style={{ margin: 0 }}>{t('docker.endpoint')}</span>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 220 }}
          placeholder={DEFAULT_EP}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyEndpoint()}
        />
        <button className="mini primary" disabled={!desktop || !!busy} onClick={applyEndpoint}>
          {t('docker.connect')}
        </button>
        <button className="mini" disabled={!desktop || !!busy || !engineOk} onClick={disconnect}>
          {t('docker.disconnect')}
        </button>
      </div>

      {desktop && eng.loading && <p className="count-note">{t('modules.loading')}</p>}
      {mode === 'preview' && <p className="count-note">{t('docker.previewNote')}</p>}
      {mode === 'off' && <p className="count-note">{t('docker.notConnected')}</p>}
      {(mode === 'nocli' || mode === 'down') && (
        <>
          <pre className="cmd-out error">
            {mode === 'nocli' ? t('docker.cliMissing') : t('docker.daemonDown')}
            {eng.data?.err ? `\n${eng.data.err}` : ''}
          </pre>
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <button className="mini primary" disabled={!!busy} onClick={installDocker}>
              {t('docker.installDesktop')}
            </button>
            {mode === 'down' && eng.data?.client && (
              <span className="count-note">{t('docker.clientOnly', { version: eng.data.client })}</span>
            )}
          </div>
        </>
      )}
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
            empty={engineOk ? t('docker.noContainers') : t('docker.notConnected')}
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
            <button className="mini primary" disabled={!desktop || !!busy || !pull.trim()} onClick={doPull}>
              {busy?.startsWith('pull:') ? t('docker.pulling') : t('docker.pull')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={pruneImages}>
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
            <input
              className="mod-search"
              style={{ maxWidth: 220 }}
              placeholder={t('docker.promptVolumeName')}
              value={volName}
              onChange={(e) => setVolName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createVolume()}
            />
            <button className="mini primary" disabled={!desktop || !!busy || !volName.trim()} onClick={createVolume}>
              {t('docker.create')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={pruneVolumes}>
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
            <input
              className="mod-search"
              style={{ maxWidth: 220 }}
              placeholder={t('docker.promptNetworkName')}
              value={netName}
              onChange={(e) => setNetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createNetwork()}
            />
            <select
              className="mod-search"
              style={{ maxWidth: 130 }}
              title={t('docker.col.driver')}
              value={netDriver}
              onChange={(e) => setNetDriver(e.target.value)}
            >
              {NET_DRIVERS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <button className="mini primary" disabled={!desktop || !!busy || !netName.trim()} onClick={createNetwork}>
              {t('docker.create')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={pruneNetworks}>
              {t('docker.prune')}
            </button>
          </div>
          <AsyncState loading={networks.loading} error={networks.error}>
            <DataTable columns={networkCols} rows={networkRows} rowKey={(n) => n.ID} />
          </AsyncState>
        </>
      )}

      {tab === 'compose' && (
        <>
          <p className="count-note" style={{ marginTop: 0 }}>{t('docker.composeBlurb')}</p>
          {desktop && eng.data && (mode === 'ok' || mode === 'down') && !eng.data.compose && (
            <p className="count-note">{t('docker.composeMissing')}</p>
          )}
          <div className="mod-form" style={{ marginBottom: 8 }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 260 }}
              title={t('docker.composeDir')}
              placeholder={t('docker.composeDirPlaceholder')}
              value={compDir}
              onChange={(e) => setCompDir(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && detectCompose()}
            />
            <button className="mini primary" disabled={!desktop || !!busy || !compDir.trim()} onClick={detectCompose}>
              {t('docker.composeDetect')}
            </button>
          </div>
          <div className="mod-form" style={{ marginBottom: 8 }}>
            {compFiles.length > 0 && (
              <select
                className="mod-search"
                style={{ maxWidth: 340 }}
                title={t('docker.composeFile')}
                value={compFile}
                onChange={(e) => {
                  setCompFile(e.target.value);
                  void validateCompose(e.target.value);
                }}
              >
                {compFiles.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            )}
            <input
              className="mod-search"
              style={{ maxWidth: 160 }}
              title={t('docker.composeProject')}
              placeholder={t('docker.composeProject')}
              value={compProj}
              onChange={(e) => setCompProj(e.target.value)}
            />
            <button className="mini primary" disabled={!desktop || !!busy || !compFile} onClick={composeUp}>
              {t('docker.composeUp')}
            </button>
            <button className="mini" disabled={!desktop || !!busy || !compProj.trim()} onClick={composeDown}>
              {t('docker.composeDown')}
            </button>
            <button className="mini" disabled={!desktop || !!busy || (!compFile && !compProj.trim())} onClick={composePs}>
              {t('docker.composePs')}
            </button>
          </div>
          {compLog && (
            <>
              <div className="mod-form" style={{ marginBottom: 4 }}>
                <strong>{t('docker.output')}</strong>
              </div>
              <pre className="cmd-out" style={{ maxHeight: 280, overflow: 'auto' }}>{compLog}</pre>
            </>
          )}
        </>
      )}

      {panel && (
        <div style={{ marginTop: 12 }}>
          <div className="mod-form" style={{ marginBottom: 4, alignItems: 'center' }}>
            <strong>{panel.title}</strong>
            {panel.kind === 'logs' && (
              <>
                <span className="count-note" style={{ margin: 0 }}>{t('docker.tailLines')}</span>
                <input
                  className="mod-search"
                  style={{ maxWidth: 80 }}
                  value={tailN}
                  onChange={(e) => setTailN(e.target.value)}
                />
                <button
                  className="mini"
                  disabled={!desktop || !!busy}
                  onClick={() => loadLogs(panel.id, panel.name)}
                >
                  ⟳ {t('modules.refresh')}
                </button>
              </>
            )}
            {panel.kind === 'stats' && (
              <button
                className="mini"
                disabled={!desktop || !!busy}
                onClick={() => loadStats(panel.id, panel.name)}
              >
                ⟳ {t('modules.refresh')}
              </button>
            )}
            <button className="mini" onClick={() => setPanel(null)}>
              {t('docker.close')}
            </button>
          </div>
          {panel.kind === 'exec' && (
            <div className="mod-form" style={{ marginBottom: 4 }}>
              <input
                className="mod-search"
                style={{ flex: 1, minWidth: 220 }}
                placeholder={t('docker.execPlaceholder')}
                value={execCmd}
                onChange={(e) => setExecCmd(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runExec(panel.id, panel.name)}
              />
              <button
                className="mini primary"
                disabled={!desktop || !!busy || !execCmd.trim()}
                onClick={() => runExec(panel.id, panel.name)}
              >
                {t('docker.run')}
              </button>
              <span className="count-note" style={{ margin: 0 }}>{t('docker.execNote')}</span>
            </div>
          )}
          <pre className="cmd-out" style={{ maxHeight: 340, overflow: 'auto' }}>{panel.body}</pre>
        </div>
      )}
    </div>
  );
}
