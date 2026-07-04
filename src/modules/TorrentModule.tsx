import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs, type ModuleTab } from './ModuleTabs';

// Native Torrent · 原生種子下載
//
// The WinForge desktop module embeds MonoTorrent — a fully-managed BitTorrent
// protocol engine (DHT / LSD / PEX / UDP+HTTP trackers) running in-process, with
// a live grid, per-torrent start/pause/remove(±data)/recheck, per-file priority,
// a detail panel (files · trackers · peers · info) and persisted global settings.
//
// The browser has no such engine, so the faithful native port drives aria2c —
// a real BitTorrent client CLI — through the desktop backend in TWO ways:
//   • Client tab: aria2c runs as a background JSON-RPC daemon (aria2c --enable-rpc),
//     and every feature the MonoTorrent page has maps onto an aria2 RPC method:
//     addUri (magnet) / addTorrent (.torrent), tellActive+tellWaiting+tellStopped
//     (live list with progress · speeds · peers · ratio · ETA), pause / unpause /
//     remove / removeDownloadResult (± data), getFiles + changeOption select-file
//     (per-file skip/keep), and changeGlobalOption (global up/down limits, DHT,
//     connections). This is the closest analogue to the in-process engine.
//   • Quick download tab: the original one-shot aria2c invocation (magnet or file →
//     download to a folder), preserved verbatim.
// Everything is gated on the aria2 dependency, mutations are click-gated, and every
// call is guarded so it never throws. The daemon's RPC secret is never logged.

type Mode = 'magnet' | 'file';

const CACHE_ROOT = '%LOCALAPPDATA%\\WinForge\\torrent';
const DEFAULT_SAVE = '%USERPROFILE%\\Downloads\\WinForge';

// Sanitise a numeric text field into a clamped integer.
function clampInt(text: string, lo: number, hi: number, fallback: number): number {
  const n = parseInt(text, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let b = bytes;
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} ${u[i]!}` : `${b.toFixed(2)} ${u[i]!}`;
}

function humanSpeed(bps: number): string {
  return !Number.isFinite(bps) || bps <= 0 ? '—' : humanSize(bps) + '/s';
}

function humanEta(remainBytes: number, speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0 || remainBytes <= 0) return '∞';
  const secs = remainBytes / speed;
  if (!Number.isFinite(secs) || secs >= 8640000) return '∞';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${s}s`;
  return `${s}s`;
}

// aria2 download "status" → WinForge-style state label.
function stateLabel(st: string, seeder: boolean, en: boolean): string {
  const map: Record<string, [string, string]> = {
    active: seeder ? ['Seeding', '做種'] : ['Downloading', '下載中'],
    waiting: ['Queued', '排隊中'],
    paused: ['Paused', '暫停'],
    complete: ['Complete', '完成'],
    error: ['Error', '錯誤'],
    removed: ['Removed', '已移除'],
  };
  const pair = map[st];
  return pair ? (en ? pair[0] : pair[1]) : st;
}

function stateClass(st: string, seeder: boolean): string {
  if (st === 'error') return 'neg';
  if (st === 'active') return seeder ? '' : 'pos';
  return '';
}

interface AriaTorrent {
  gid: string;
  name: string;
  status: string; // active | waiting | paused | complete | error | removed
  completedLength: number;
  totalLength: number;
  downloadSpeed: number;
  uploadSpeed: number;
  uploadLength: number;
  connections: number;
  numSeeders: number;
  seeder: boolean;
  errorMessage: string;
}

interface AriaFile {
  index: number;
  path: string;
  length: number;
  completedLength: number;
  selected: boolean;
}

interface ListResult {
  ok: boolean;
  error: string;
  torrents: AriaTorrent[];
  globalDown: number;
  globalUp: number;
  numActive: number;
  numWaiting: number;
  numStopped: number;
  dlLimit: number;
  ulLimit: number;
}

// PowerShell single-quote escape.
const psq = (s: string) => s.replace(/'/g, "''");

/**
 * Build a PowerShell script that POSTs one-or-more aria2 JSON-RPC calls to the
 * local daemon and writes a single JSON object to stdout. `$rpc` is a helper that
 * takes a method name + a params-array literal (already including the secret token)
 * and returns the parsed `.result`. On any failure a `{ok:false,error:...}` object
 * is emitted so the caller always gets JSON.
 */
function rpcPrelude(port: number, secret: string): string {
  return (
    `$ErrorActionPreference='Stop';` +
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$ep='http://127.0.0.1:${port}/jsonrpc';` +
    `$tok='token:${psq(secret)}';` +
    `function Rpc([string]$m,$p){` +
    `$body=@{ jsonrpc='2.0'; id='wf'; method=$m; params=$p } | ConvertTo-Json -Depth 8 -Compress;` +
    `$r=Invoke-RestMethod -Uri $ep -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 20;` +
    `if($r.error){ throw ($r.error.message) }; return $r.result }`
  );
}

async function ps<T>(script: string): Promise<T | { ok: false; error: string }> {
  try {
    const res: CommandOutput = await runPowershell(script);
    const text = (res.stdout || '').trim();
    if (!text) return { ok: false, error: (res.stderr || `exit ${res.code}`).trim() };
    return JSON.parse(text) as T;
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

export function TorrentModule() {
  const { t, i18n } = useTranslation();
  const en = (i18n.language || 'en').startsWith('en');
  const desktop = isTauri();

  // ── Quick-download (one-shot) state — preserved from the original port ──
  const [mode, setMode] = useState<Mode>('magnet');
  const [magnet, setMagnet] = useState('');
  const [torrentPath, setTorrentPath] = useState('');
  const [savePath, setSavePath] = useState(DEFAULT_SAVE);
  const [seq, setSeq] = useState(false);
  const [seedAfter, setSeedAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // ── Global engine settings (mirror of the MonoTorrent engine settings) ──
  const [maxDown, setMaxDown] = useState('0'); // KiB/s, 0 = unlimited
  const [maxUp, setMaxUp] = useState('0'); // KiB/s, 0 = unlimited
  const [maxConn, setMaxConn] = useState('200');
  const [listenPort, setListenPort] = useState('55123');
  const [dht, setDht] = useState(true);

  // ── Client (RPC daemon) state ──
  const [rpcPort, setRpcPort] = useState('6800');
  const [secret, setSecret] = useState('');
  const [engineUp, setEngineUp] = useState(false);
  const [rows, setRows] = useState<AriaTorrent[]>([]);
  const [globals, setGlobals] = useState<{ down: number; up: number; active: number; dl: number; ul: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [clientBusy, setClientBusy] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<null | boolean>(null);

  // Add-to-client inputs.
  const [addMagnet, setAddMagnet] = useState('');
  const [addFile, setAddFile] = useState('');
  const [addSave, setAddSave] = useState(DEFAULT_SAVE);
  const [addPaused, setAddPaused] = useState(false);

  // Per-torrent detail (files + selection).
  const [detail, setDetail] = useState<{ gid: string; name: string; files: AriaFile[] } | null>(null);

  const say = (kind: 'ok' | 'err' | 'info', msg: string) => setNote({ kind, msg });

  const portNum = () => clampInt(rpcPort, 1, 65535, 6800);

  // ── Quick download (one-shot) — original mechanism preserved ────────────
  const buildArgs = (): string[] | null => {
    const dir = savePath.trim() || DEFAULT_SAVE;
    const port = clampInt(listenPort, 1, 65535, 55123);
    const conn = clampInt(maxConn, 10, 2000, 200);
    const dn = clampInt(maxDown, 0, 1_000_000, 0);
    const up = clampInt(maxUp, 0, 1_000_000, 0);

    const args: string[] = [
      '--dir', dir,
      '--enable-dht=' + (dht ? 'true' : 'false'),
      '--enable-dht6=' + (dht ? 'true' : 'false'),
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      '--listen-port', String(port),
      '--dht-listen-port', String(port),
      '--max-overall-download-limit=' + (dn > 0 ? `${dn}K` : '0'),
      '--max-overall-upload-limit=' + (up > 0 ? `${up}K` : '0'),
      '--max-connection-per-server', String(Math.min(16, conn)),
      '--bt-max-peers', String(conn),
      '--summary-interval=0',
      '--console-log-level=notice',
      '--dht-file-path=' + CACHE_ROOT + '\\dht.dat',
      '--bt-save-metadata=true',
      '--check-integrity=true',
    ];
    if (!seedAfter) args.push('--seed-ratio=0.0');
    if (seq) args.push('--bt-prioritize-piece=head,tail');

    if (mode === 'magnet') {
      const m = magnet.trim();
      if (!m) return null;
      args.push(m);
    } else {
      const f = torrentPath.trim();
      if (!f) return null;
      args.push(f);
    }
    return args;
  };

  const run = async (path: string) => {
    const args = buildArgs();
    if (!args) {
      setErr(t('torrentn.errNoSource'));
      return;
    }
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c ' + args.join(' ') + '\n');
    try {
      const res: CommandOutput = await runCommand(path, args);
      const text = res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code });
      setOut(text);
      setStatus(res.success ? t('torrentn.doneOk') : t('torrentn.doneErr', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const showInfo = async (path: string) => {
    const args = buildArgs();
    if (!args) {
      setErr(t('torrentn.errNoSource'));
      return;
    }
    const infoArgs = ['--show-files=true', ...args];
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c --show-files ...\n');
    try {
      const res = await runCommand(path, infoArgs);
      setOut(res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code }));
      setStatus(res.success ? t('torrentn.infoOk') : t('torrentn.doneErr', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (dir: string) => {
    const target = dir.trim() || DEFAULT_SAVE;
    setErr(null);
    try {
      const res = await runCommand('explorer.exe', [target]);
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const version = async (path: string) => {
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c --version\n');
    try {
      const res = await runCommand(path, ['--version']);
      setOut(res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  // ── Client: start / stop the aria2 JSON-RPC daemon ──────────────────────
  const startEngine = async (path: string) => {
    if (!desktop) return;
    setClientBusy('engine');
    setNote(null);
    const port = portNum();
    const conn = clampInt(maxConn, 10, 2000, 200);
    const dn = clampInt(maxDown, 0, 1_000_000, 0);
    const up = clampInt(maxUp, 0, 1_000_000, 0);
    const btPort = clampInt(listenPort, 1, 65535, 55123);
    // Fresh secret per engine session — kept in state, never printed to `out`.
    const sec = secret || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    if (!secret) setSecret(sec);
    // Launch aria2c detached with RPC enabled. Start-Process so runPowershell
    // returns immediately instead of blocking on the long-lived daemon.
    const args = [
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${port}`,
      `--rpc-secret=${sec}`,
      `--dir=${addSave.trim() || DEFAULT_SAVE}`,
      `--enable-dht=${dht ? 'true' : 'false'}`,
      `--enable-dht6=${dht ? 'true' : 'false'}`,
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      `--listen-port=${btPort}`,
      `--dht-listen-port=${btPort}`,
      `--max-overall-download-limit=${dn > 0 ? `${dn}K` : '0'}`,
      `--max-overall-upload-limit=${up > 0 ? `${up}K` : '0'}`,
      `--bt-max-peers=${conn}`,
      `--max-connection-per-server=${Math.min(16, conn)}`,
      `--dht-file-path=${CACHE_ROOT}\\dht.dat`,
      '--bt-save-metadata=true',
      '--save-session=' + CACHE_ROOT + '\\aria2.session',
      '--input-file=' + CACHE_ROOT + '\\aria2.session',
      '--save-session-interval=15',
      '--seed-ratio=0.0',
    ];
    const argLit = args.map((a) => `'${psq(a)}'`).join(',');
    const script =
      `$ErrorActionPreference='Stop';` +
      `New-Item -ItemType Directory -Force -Path (${JSON.stringify(CACHE_ROOT)} -replace '%LOCALAPPDATA%',$env:LOCALAPPDATA) | Out-Null;` +
      // Only launch if nothing is already listening on the RPC port.
      `$busy=$false; try{ $c=New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',${port}); $busy=$true; $c.Close() }catch{}` +
      `if(-not $busy){ Start-Process -WindowStyle Hidden -FilePath '${psq(path)}' -ArgumentList @(${argLit}) };` +
      `Write-Output '{"ok":true,"error":""}'`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error || t('torrentn.engineFail'));
      return;
    }
    setEngineUp(true);
    say('ok', t('torrentn.engineStarted', { port }));
    // Give the daemon a moment, then pull the first list.
    await refresh(sec, true);
  };

  const stopEngine = async () => {
    if (!desktop) return;
    setClientBusy('engine');
    const port = portNum();
    const script = rpcPrelude(port, secret) + `;try{ Rpc 'aria2.shutdown' @($tok) | Out-Null; Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    setEngineUp(false);
    setRows([]);
    setGlobals(null);
    setSelected(new Set());
    setDetail(null);
    say('info', t('torrentn.engineStopped'));
  };

  // ── Client: live list (active + waiting + stopped + global stat) ────────
  const refresh = async (sec = secret, silent = false) => {
    if (!desktop) return;
    if (!silent) setClientBusy('list');
    const port = portNum();
    const keys = `@('gid','status','totalLength','completedLength','uploadLength','downloadSpeed','uploadSpeed','connections','numSeeders','seeder','bittorrent','errorMessage','files')`;
    const script =
      rpcPrelude(port, sec) +
      `;try{` +
      `$active=@(Rpc 'aria2.tellActive' @($tok,${keys}));` +
      `$wait=@(Rpc 'aria2.tellWaiting' @($tok,0,1000,${keys}));` +
      `$stop=@(Rpc 'aria2.tellStopped' @($tok,0,1000,${keys}));` +
      `$all=$active + $wait + $stop;` +
      `$gs=Rpc 'aria2.getGlobalStat' @($tok);` +
      `$opt=Rpc 'aria2.getGlobalOption' @($tok);` +
      `$list=@($all | ForEach-Object {` +
      `$nm=''; if($_.bittorrent -and $_.bittorrent.info -and $_.bittorrent.info.name){ $nm=[string]$_.bittorrent.info.name } elseif($_.files -and $_.files.Count -gt 0){ $nm=[System.IO.Path]::GetFileName([string]$_.files[0].path) }` +
      `[pscustomobject]@{ gid=[string]$_.gid; name=$nm; status=[string]$_.status; completedLength=[long]$_.completedLength; totalLength=[long]$_.totalLength; downloadSpeed=[long]$_.downloadSpeed; uploadSpeed=[long]$_.uploadSpeed; uploadLength=[long]$_.uploadLength; connections=[int]$_.connections; numSeeders=[int]$_.numSeeders; seeder=($_.seeder -eq 'true'); errorMessage=[string]$_.errorMessage } });` +
      `[pscustomobject]@{ ok=$true; error=''; torrents=@($list); globalDown=[long]$gs.downloadSpeed; globalUp=[long]$gs.uploadSpeed; numActive=[int]$gs.numActive; numWaiting=[int]$gs.numWaiting; numStopped=[int]$gs.numStopped; dlLimit=[long]$opt.'max-overall-download-limit'; ulLimit=[long]$opt.'max-overall-upload-limit' } | ConvertTo-Json -Depth 6 -Compress` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<ListResult>(script);
    if (!silent) setClientBusy('');
    if ('ok' in r && !r.ok) {
      setEngineUp(false);
      say('err', r.error || t('torrentn.engineOffline'));
      return;
    }
    const res = r as ListResult;
    setEngineUp(true);
    setRows(Array.isArray(res.torrents) ? res.torrents : []);
    setGlobals({
      down: res.globalDown,
      up: res.globalUp,
      active: res.numActive,
      dl: res.dlLimit,
      ul: res.ulLimit,
    });
    setSelected((prev) => {
      const live = new Set((res.torrents || []).map((x) => x.gid));
      const next = new Set<string>();
      prev.forEach((g) => live.has(g) && next.add(g));
      return next;
    });
    if (!silent) say('ok', t('torrentn.listUpdated'));
  };

  // ── Client: single RPC method against selection ─────────────────────────
  const rpcOnGid = async (method: string, gid: string, tag: string, extra = ''): Promise<boolean> => {
    if (!desktop) return false;
    const port = portNum();
    setClientBusy(tag);
    const script =
      rpcPrelude(port, secret) +
      `;try{ Rpc '${method}' @($tok,'${psq(gid)}'${extra}) | Out-Null; Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return false;
    }
    return true;
  };

  const actSelected = async (method: string, tag: string) => {
    if (selected.size === 0) return;
    let ok = true;
    for (const gid of [...selected]) {
      const r = await rpcOnGid(method, gid, tag);
      ok = ok && r;
    }
    if (ok) say('ok', t('torrentn.actionDone'));
    await refresh(secret, true);
  };

  // ── Client: remove (± downloaded data) ──────────────────────────────────
  const removeSelected = async (deleteData: boolean) => {
    if (selected.size === 0) return;
    if (!desktop) {
      setConfirmDel(null);
      return;
    }
    setClientBusy('remove');
    const port = portNum();
    for (const gid of [...selected]) {
      // Force-remove active/paused torrents, then purge from the stopped list.
      // deleteData: aria2 keeps files on remove, so we look them up and delete on disk.
      const delFilesBlock = deleteData
        ? `try{ $st=Rpc 'aria2.tellStatus' @($tok,'${psq(gid)}',@('files','dir')); foreach($f in @($st.files)){ $p=[string]$f.path; if($p -and (Test-Path -LiteralPath $p)){ Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } } }catch{}`
        : '';
      const script =
        rpcPrelude(port, secret) +
        `;try{` +
        delFilesBlock +
        `try{ Rpc 'aria2.forceRemove' @($tok,'${psq(gid)}') | Out-Null }catch{};` +
        `try{ Rpc 'aria2.removeDownloadResult' @($tok,'${psq(gid)}') | Out-Null }catch{};` +
        `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
      await ps<{ ok: boolean; error: string }>(script);
    }
    setClientBusy('');
    setConfirmDel(null);
    setSelected(new Set());
    say('ok', deleteData ? t('torrentn.removedWithData') : t('torrentn.removed'));
    await refresh(secret, true);
  };

  // ── Client: add magnet / .torrent to the running daemon ─────────────────
  const addToClient = async (kind: 'magnet' | 'file') => {
    if (!desktop) return;
    const src = kind === 'magnet' ? addMagnet.trim() : addFile.trim();
    if (!src) {
      say('err', t('torrentn.errNoSource'));
      return;
    }
    setClientBusy('add');
    const port = portNum();
    const opt = `@{ dir='${psq(addSave.trim() || DEFAULT_SAVE)}'; pause='${addPaused ? 'true' : 'false'}' }`;
    let script: string;
    if (kind === 'magnet') {
      const lines = addMagnet
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const arr = lines.map((l) => `'${psq(l)}'`).join(',');
      script =
        rpcPrelude(port, secret) +
        `;try{ foreach($u in @(${arr})){ Rpc 'aria2.addUri' @($tok,@($u),${opt}) | Out-Null }; ` +
        `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    } else {
      // Read the .torrent, base64-encode it, and hand it to aria2.addTorrent.
      script =
        rpcPrelude(port, secret) +
        `;try{ $b=[Convert]::ToBase64String([System.IO.File]::ReadAllBytes('${psq(src)}'));` +
        `Rpc 'aria2.addTorrent' @($tok,$b,@(),${opt}) | Out-Null;` +
        `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    }
    const r = await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return;
    }
    say('ok', t('torrentn.added'));
    if (kind === 'magnet') setAddMagnet('');
    else setAddFile('');
    await refresh(secret, true);
  };

  // ── Client: apply global engine settings to the running daemon ──────────
  const applyGlobal = async () => {
    if (!desktop) return;
    setClientBusy('global');
    const port = portNum();
    const dn = clampInt(maxDown, 0, 1_000_000, 0);
    const up = clampInt(maxUp, 0, 1_000_000, 0);
    const conn = clampInt(maxConn, 10, 2000, 200);
    const opt =
      `@{ 'max-overall-download-limit'='${dn > 0 ? `${dn}K` : '0'}'; ` +
      `'max-overall-upload-limit'='${up > 0 ? `${up}K` : '0'}'; ` +
      `'bt-max-peers'='${conn}'; ` +
      `'max-connection-per-server'='${Math.min(16, conn)}' }`;
    const script =
      rpcPrelude(port, secret) +
      `;try{ Rpc 'aria2.changeGlobalOption' @($tok,${opt}) | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return;
    }
    say('ok', t('torrentn.settingsApplied'));
    await refresh(secret, true);
  };

  // ── Client: per-torrent files + selection (skip/keep) ───────────────────
  const openDetail = async (gid: string, name: string) => {
    if (!desktop) {
      setDetail({ gid, name, files: [] });
      return;
    }
    setClientBusy('detail-' + gid);
    const port = portNum();
    const script =
      rpcPrelude(port, secret) +
      `;try{ $fs=@(Rpc 'aria2.getFiles' @($tok,'${psq(gid)}'));` +
      `$out=@($fs | ForEach-Object { [pscustomobject]@{ index=[int]$_.index; path=[string]$_.path; length=[long]$_.length; completedLength=[long]$_.completedLength; selected=($_.selected -eq 'true') } });` +
      `[pscustomobject]@{ ok=$true; error=''; files=@($out) } | ConvertTo-Json -Depth 5 -Compress` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string; files: AriaFile[] }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return;
    }
    const d = r as { files: AriaFile[] };
    setDetail({ gid, name, files: Array.isArray(d.files) ? d.files : [] });
  };

  // Toggle a single file's selection and push the new select-file list.
  const toggleFile = async (index: number) => {
    if (!detail) return;
    const next = detail.files.map((f) => (f.index === index ? { ...f, selected: !f.selected } : f));
    const keep = next.filter((f) => f.selected).map((f) => f.index);
    setDetail({ ...detail, files: next });
    if (!desktop) return;
    // aria2 needs at least one file selected; if user deselects all, keep this one.
    const list = keep.length > 0 ? keep : [index];
    setClientBusy('selfile');
    const port = portNum();
    const opt = `@{ 'select-file'='${list.join(',')}' }`;
    const script =
      rpcPrelude(port, secret) +
      `;try{ Rpc 'aria2.changeOption' @($tok,'${psq(detail.gid)}',${opt}) | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setClientBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
  };

  // ── Selection helpers ───────────────────────────────────────────────────
  const toggleSel = (gid: string) =>
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(gid)) s.delete(gid);
      else s.add(gid);
      return s;
    });

  const visibleRows = rows.filter((r) => {
    if (search.trim() && !r.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (filter === 'all') return true;
    if (filter === 'downloading') return r.status === 'active' && !r.seeder;
    if (filter === 'seeding') return (r.status === 'active' && r.seeder) || r.status === 'complete';
    if (filter === 'paused') return r.status === 'paused' || r.status === 'waiting';
    if (filter === 'error') return r.status === 'error';
    return true;
  });

  const allSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.gid));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.gid)));
  const anySel = selected.size > 0;

  const FILTERS: [string, string, string][] = [
    ['all', 'All', '全部'],
    ['downloading', 'Downloading', '下載中'],
    ['seeding', 'Seeding', '做種'],
    ['paused', 'Paused/Queued', '暫停／排隊'],
    ['error', 'Errored', '出錯'],
  ];

  // ── Client tab ──────────────────────────────────────────────────────────
  const clientTab = (path: string) => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.clientBlurb')}</p>

      {/* Engine lifecycle */}
      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <span className={engineUp ? 'dep-ok' : 'dep-missing'}>
            {engineUp ? t('torrentn.engineOn') : t('torrentn.engineOff')}
          </span>
          <label className="count-note">{t('torrentn.rpcPort')}</label>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={65535}
            style={{ maxWidth: 100 }}
            value={rpcPort}
            onChange={(e) => setRpcPort(e.target.value)}
            disabled={engineUp}
          />
          <button className="mini primary" disabled={!desktop || engineUp || clientBusy === 'engine'} onClick={() => startEngine(path)}>
            {clientBusy === 'engine' ? t('torrentn.working') : t('torrentn.startEngine')}
          </button>
          <button className="mini" disabled={!desktop || !engineUp || clientBusy === 'engine'} onClick={stopEngine}>
            {t('torrentn.stopEngine')}
          </button>
          <button className="mini" disabled={!desktop || !engineUp || clientBusy === 'list'} onClick={() => refresh(secret, false)}>
            ⟳ {t('torrentn.refresh')}
          </button>
        </div>
        <p className="count-note" style={{ marginTop: 4 }}>{t('torrentn.engineNote2')}</p>
      </div>

      {/* Add to client */}
      <div className="panel">
        <label className="label">{t('torrentn.addMagnetLbl')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          rows={2}
          value={addMagnet}
          onChange={(e) => setAddMagnet(e.target.value)}
          placeholder={t('torrentn.magnetPlaceholder')}
        />
        <label className="label" style={{ marginTop: 8 }}>{t('torrentn.addFileLbl')}</label>
        <input
          className="mod-search"
          style={{ width: '100%', maxWidth: 480 }}
          value={addFile}
          onChange={(e) => setAddFile(e.target.value)}
          placeholder={t('torrentn.filePlaceholder')}
        />
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <label className="count-note">{t('torrentn.saveFolder')}</label>
          <input className="mod-search" style={{ maxWidth: 260 }} value={addSave} onChange={(e) => setAddSave(e.target.value)} placeholder={DEFAULT_SAVE} />
          <label className="chk">
            <input type="checkbox" checked={addPaused} onChange={(e) => setAddPaused(e.target.checked)} />
            {t('torrentn.addPaused')}
          </label>
        </div>
        <div className="mod-toolbar">
          <button className="mini primary" disabled={!desktop || !engineUp || !addMagnet.trim() || clientBusy === 'add'} onClick={() => addToClient('magnet')}>
            {t('torrentn.addMagnetBtn')}
          </button>
          <button className="mini" disabled={!desktop || !engineUp || !addFile.trim() || clientBusy === 'add'} onClick={() => addToClient('file')}>
            {t('torrentn.addFileBtn')}
          </button>
        </div>
      </div>

      {/* Filter + bulk actions */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <select className="mod-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map(([code, e, z]) => (
            <option key={code} value={code}>{en ? e : z}</option>
          ))}
        </select>
        <input className="mod-search" style={{ maxWidth: 180 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('torrentn.searchPlaceholder')} />
      </div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!engineUp || !anySel || clientBusy === 'unpause'} onClick={() => actSelected('aria2.unpause', 'unpause')}>{t('torrentn.resume')}</button>
        <button className="mini" disabled={!engineUp || !anySel || clientBusy === 'pause'} onClick={() => actSelected('aria2.pause', 'pause')}>{t('torrentn.pause')}</button>
        <button className="mini" disabled={!engineUp || !anySel || clientBusy === 'remove'} onClick={() => setConfirmDel(false)}>{t('torrentn.remove')}</button>
        {anySel && <span className="count-note">{t('torrentn.selectedCount', { n: selected.size })}</span>}
      </div>

      {/* Confirm remove (± data) */}
      {confirmDel !== null && (
        <div className="panel" style={{ borderColor: 'var(--danger)' }}>
          <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.confirmRemove', { n: selected.size })}</p>
          <label className="chk">
            <input type="checkbox" checked={confirmDel === true} onChange={(e) => setConfirmDel(e.target.checked)} />
            {t('torrentn.alsoDeleteData')}
          </label>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" disabled={clientBusy === 'remove'} onClick={() => removeSelected(confirmDel === true)}>{t('torrentn.confirmRemoveBtn')}</button>
            <button className="mini" onClick={() => setConfirmDel(null)}>{t('torrentn.cancel')}</button>
          </div>
        </div>
      )}

      {/* Torrent table */}
      {visibleRows.length === 0 ? (
        <p className="count-note">{engineUp ? t('torrentn.noTorrents') : t('torrentn.engineOffHint')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                </th>
                <th>{t('torrentn.colName')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colProgress')}</th>
                <th>{t('torrentn.colState')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colDown')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colUp')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colRatio')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colEta')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colSize')}</th>
                <th style={{ textAlign: 'right' }}>{t('torrentn.colPeers')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const pct = r.totalLength > 0 ? (r.completedLength / r.totalLength) * 100 : 0;
                const ratio = r.completedLength > 0 ? r.uploadLength / r.completedLength : 0;
                const remain = Math.max(0, r.totalLength - r.completedLength);
                return (
                  <tr key={r.gid}>
                    <td>
                      <input type="checkbox" checked={selected.has(r.gid)} onChange={() => toggleSel(r.gid)} />
                    </td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name || r.gid}>
                      {r.name || t('torrentn.fetchingMeta')}
                      {r.errorMessage ? <span className="count-note"> · {r.errorMessage}</span> : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>{pct.toFixed(1)}%</td>
                    <td className={stateClass(r.status, r.seeder)}>{stateLabel(r.status, r.seeder, en)}</td>
                    <td style={{ textAlign: 'right' }}>{humanSpeed(r.downloadSpeed)}</td>
                    <td style={{ textAlign: 'right' }}>{humanSpeed(r.uploadSpeed)}</td>
                    <td style={{ textAlign: 'right' }}>{ratio.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{r.status === 'active' && !r.seeder ? humanEta(remain, r.downloadSpeed) : '∞'}</td>
                    <td style={{ textAlign: 'right' }}>{humanSize(r.totalLength)}</td>
                    <td style={{ textAlign: 'right' }}>{r.numSeeders}/{r.connections}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="mini" disabled={clientBusy === 'detail-' + r.gid} onClick={() => openDetail(r.gid, r.name)}>{t('torrentn.details')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-torrent detail: files + priority (skip / keep) */}
      {detail && (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }} title={detail.name}>
              {detail.name || t('torrentn.fetchingMeta')}
            </strong>
            <button className="mini" onClick={() => setDetail(null)}>{t('torrentn.close')}</button>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.filesNote')}</p>
          {detail.files.length === 0 ? (
            <p className="count-note">{t('torrentn.noFiles')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>{t('torrentn.colPriority')}</th>
                    <th>{t('torrentn.colFile')}</th>
                    <th style={{ textAlign: 'right' }}>{t('torrentn.colSize')}</th>
                    <th style={{ textAlign: 'right' }}>{t('torrentn.colProgress')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.files.map((f) => {
                    const fpct = f.length > 0 ? (f.completedLength / f.length) * 100 : 0;
                    return (
                      <tr key={f.index}>
                        <td>
                          <select
                            className="mod-select"
                            value={f.selected ? 'keep' : 'skip'}
                            disabled={!desktop || clientBusy === 'selfile'}
                            onChange={() => toggleFile(f.index)}
                          >
                            <option value="keep">{t('torrentn.prioKeep')}</option>
                            <option value="skip">{t('torrentn.prioSkip')}</option>
                          </select>
                        </td>
                        <td style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</td>
                        <td style={{ textAlign: 'right' }}>{humanSize(f.length)}</td>
                        <td style={{ textAlign: 'right' }}>{fpct.toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Footer stats */}
      {engineUp && globals && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="count-note">↓ {humanSpeed(globals.down)}</span>
          <span className="count-note">↑ {humanSpeed(globals.up)}</span>
          <span className="count-note">{t('torrentn.footActive', { n: globals.active })}</span>
          <span className="count-note">{t('torrentn.footLimits', { dl: globals.dl > 0 ? humanSpeed(globals.dl) : '∞', up: globals.ul > 0 ? humanSpeed(globals.ul) : '∞' })}</span>
          <span className="count-note">{t('torrentn.footShown', { n: visibleRows.length, total: rows.length })}</span>
        </div>
      )}
    </>
  );

  // ── Settings tab (global engine settings) ───────────────────────────────
  const settingsTab = () => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.settingsBlurb')}</p>
      <div className="panel">
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('torrentn.maxDown')}</span>
            <span className="value">
              <input className="mod-search" type="number" min={0} style={{ maxWidth: 110 }} value={maxDown} onChange={(e) => setMaxDown(e.target.value)} />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('torrentn.maxUp')}</span>
            <span className="value">
              <input className="mod-search" type="number" min={0} style={{ maxWidth: 110 }} value={maxUp} onChange={(e) => setMaxUp(e.target.value)} />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('torrentn.maxConn')}</span>
            <span className="value">
              <input className="mod-search" type="number" min={10} max={2000} style={{ maxWidth: 110 }} value={maxConn} onChange={(e) => setMaxConn(e.target.value)} />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('torrentn.listenPort')}</span>
            <span className="value">
              <input className="mod-search" type="number" min={1} max={65535} style={{ maxWidth: 110 }} value={listenPort} onChange={(e) => setListenPort(e.target.value)} disabled={engineUp} />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('torrentn.dht')}</span>
            <span className="value">
              <label className="chk">
                <input type="checkbox" checked={dht} onChange={(e) => setDht(e.target.checked)} disabled={engineUp} />
                {t('torrentn.dhtOn')}
              </label>
            </span>
          </div>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" disabled={!desktop || !engineUp || clientBusy === 'global'} onClick={applyGlobal}>
            {clientBusy === 'global' ? t('torrentn.working') : t('torrentn.applySettings')}
          </button>
        </div>
        <p className="count-note" style={{ marginTop: 6 }}>{t('torrentn.settingsNote')}</p>
      </div>
    </>
  );

  // ── Quick download tab (original one-shot flow, preserved) ──────────────
  const quickTab = (path: string) => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.quickBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value === 'file' ? 'file' : 'magnet')}>
          <option value="magnet">{t('torrentn.srcMagnet')}</option>
          <option value="file">{t('torrentn.srcFile')}</option>
        </select>
        <button className="mini primary" disabled={busy} onClick={() => run(path)}>
          {busy ? t('torrentn.working') : t('torrentn.download')}
        </button>
        <button className="mini" disabled={busy} onClick={() => showInfo(path)}>{t('torrentn.showFiles')}</button>
        <button className="mini" disabled={busy} onClick={() => openFolder(savePath)}>{t('torrentn.openFolder')}</button>
        <button className="mini" disabled={busy} onClick={() => version(path)}>{t('torrentn.version')}</button>
      </div>

      {mode === 'magnet' ? (
        <textarea
          className="hosts-edit"
          placeholder={t('torrentn.magnetPlaceholder')}
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
          spellCheck={false}
          rows={2}
        />
      ) : (
        <input
          className="mod-search"
          placeholder={t('torrentn.filePlaceholder')}
          value={torrentPath}
          onChange={(e) => setTorrentPath(e.target.value)}
        />
      )}

      <div className="io-grid" style={{ marginTop: 10 }}>
        <label className="label">{t('torrentn.saveFolder')}</label>
        <input className="mod-search" value={savePath} onChange={(e) => setSavePath(e.target.value)} placeholder={DEFAULT_SAVE} />
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <label className="chk">
          <input type="checkbox" checked={seq} onChange={(e) => setSeq(e.target.checked)} />
          {t('torrentn.sequentialNote')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={seedAfter} onChange={(e) => setSeedAfter(e.target.checked)} />
          {t('torrentn.seedNote')}
        </label>
      </div>

      {status && <p className="count-note" style={{ color: 'var(--accent)' }}>{status}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}
      {out && <pre className="cmd-out">{out}</pre>}
    </>
  );

  const tabs = (path: string): ModuleTab[] => [
    { id: 'client', en: 'Client', zh: '用戶端', render: () => clientTab(path) },
    { id: 'quick', en: 'Quick download', zh: '快速下載', render: () => quickTab(path) },
    { id: 'settings', en: 'Settings', zh: '設定', render: settingsTab },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.blurb')}</p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('torrentn.desktopOnly')}</p>}

      {note && (
        <p className={note.kind === 'err' ? 'error' : note.kind === 'ok' ? 'dep-ok' : 'count-note'} style={{ marginTop: 8 }}>
          {note.msg}
        </p>
      )}

      <DependencyGate tool="aria2c" preferId="aria2.aria2" query="aria2">
        {(path) => <ModuleTabs tabs={tabs(path)} />}
      </DependencyGate>
    </div>
  );
}
