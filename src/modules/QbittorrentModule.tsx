import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { ModuleTabs, type ModuleTab } from './ModuleTabs';

// Native module — an in-app front-end over qBittorrent's local WebUI (Web API v2).
// The C# original held an HttpClient + CookieContainer session against http://localhost:8080
// and exposed 28 features across Torrents / Categories / Tags / Preferences.
// The web port drives the same Web API v2 through the desktop backend: each action is a
// single self-contained PowerShell script that logs in (grabbing the SID cookie into a
// WebRequestSession) and then performs the request in that same session — so no state leaks
// between calls, nothing ever throws, and requests route through the backend to avoid CORS
// (mirroring HttpHeadersModule). It also locates and launches the qBittorrent desktop exe,
// opens the WebUI URL, and — in a plain browser where the bridge no-ops — renders the full
// UI so every surface is visible. Live probing requires the WinForge desktop app.

interface QbTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number; // 0..1
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  ratio: number;
  category: string;
  tags: string;
  save_path: string;
  num_seeds: number;
  num_leechs: number;
}

interface QbStats {
  dl_info_speed: number;
  up_info_speed: number;
  dl_rate_limit: number;
  up_rate_limit: number;
  connection_status: string;
  dht_nodes: number;
  alt: boolean;
}

interface QbCat {
  name: string;
  savePath: string;
}

interface ListResult {
  ok: boolean;
  error: string;
  torrents: QbTorrent[];
  stats: QbStats | null;
  cats: QbCat[];
  tags: string[];
}

interface QbFile {
  name: string;
  size: number;
  progress: number;
  priority: number;
}
interface QbTracker {
  url: string;
  status: number;
  num_peers: number;
  num_seeds: number;
  msg: string;
}
interface QbPeer {
  addr: string;
  client: string;
  progress: number;
  dl_speed: number;
  up_speed: number;
  flags: string;
}
interface DetailResult {
  ok: boolean;
  error: string;
  files: QbFile[];
  trackers: QbTracker[];
  peers: QbPeer[];
}

interface QbPrefs {
  save_path: string;
  web_ui_port: number;
  dl_limit: number; // bytes/s
  up_limit: number; // bytes/s
  max_connec: number;
  max_active_downloads: number;
  max_active_torrents: number;
}

const FILTERS = [
  ['all', 'All', '全部'],
  ['downloading', 'Downloading', '下載中'],
  ['seeding', 'Seeding', '做種'],
  ['completed', 'Completed', '已完成'],
  ['stopped', 'Stopped', '已停止'],
  ['active', 'Active', '活躍'],
  ['inactive', 'Inactive', '不活躍'],
  ['errored', 'Errored', '出錯'],
] as const;

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

function humanEta(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0 || secs >= 8640000) return '∞';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${s}s`;
  return `${s}s`;
}

function stateLabel(state: string, en: boolean): string {
  const map: Record<string, [string, string]> = {
    error: ['Error', '錯誤'],
    missingFiles: ['Missing files', '缺少檔案'],
    uploading: ['Seeding', '做種'],
    forcedUP: ['Seeding', '做種'],
    stoppedUP: ['Completed', '已完成'],
    queuedUP: ['Queued (seed)', '排隊（做種）'],
    stalledUP: ['Seeding (idle)', '做種（停滯）'],
    checkingUP: ['Checking', '檢查中'],
    checkingDL: ['Checking', '檢查中'],
    checkingResumeData: ['Checking', '檢查中'],
    downloading: ['Downloading', '下載中'],
    forcedDL: ['Downloading', '下載中'],
    metaDL: ['Fetching metadata', '取中繼資料'],
    forcedMetaDL: ['Fetching metadata', '取中繼資料'],
    stoppedDL: ['Stopped', '已停止'],
    queuedDL: ['Queued', '排隊中'],
    stalledDL: ['Stalled', '停滯'],
    moving: ['Moving', '移動中'],
  };
  const pair = map[state];
  if (!pair) return state;
  return en ? pair[0] : pair[1];
}

function stateClass(state: string): string {
  if (state === 'error' || state === 'missingFiles') return 'neg';
  if (state === 'downloading' || state === 'forcedDL' || state === 'metaDL' || state === 'forcedMetaDL') return 'pos';
  return '';
}

function trackerStatus(st: number, en: boolean): string {
  const map: Record<number, [string, string]> = {
    0: ['Disabled', '停用'],
    1: ['Not contacted', '未聯絡'],
    2: ['Working', '運作中'],
    3: ['Updating', '更新中'],
    4: ['Not working', '無法運作'],
  };
  const pair = map[st];
  return pair ? (en ? pair[0] : pair[1]) : String(st);
}

// PowerShell-single-quote escape.
const psq = (s: string) => s.replace(/'/g, "''");
// PowerShell double-quote-string escape (backtick + double-quote).
const psd = (s: string) => s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');

/**
 * Emit a PowerShell prelude that logs into the qBittorrent WebUI and leaves a
 * $ses (WebRequestSession) + $base variable ready for follow-up calls. On any
 * failure it writes a JSON error object and exits, so callers always get JSON.
 */
function loginPrelude(base: string, user: string, pass: string): string {
  return (
    `$ErrorActionPreference='Stop';` +
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$base='${psq(base)}';` +
    `$ses=New-Object Microsoft.PowerShell.Commands.WebRequestSession;` +
    `$hdr=@{ Referer=$base; Origin=$base };` +
    `try{` +
    `$lg=Invoke-WebRequest -Uri "$base/api/v2/auth/login" -Method Post -WebSession $ses -Headers $hdr ` +
    `-Body @{ username='${psq(user)}'; password='${psq(pass)}' } -UseBasicParsing -TimeoutSec 20;` +
    `if(($lg.Content).Trim() -ne 'Ok.'){ if(-not ($ses.Cookies.GetCookies($base) | Where-Object { $_.Name -eq 'SID' })){ ` +
    `throw 'login-failed' } }` +
    `}catch{ ` +
    `$m=$_.Exception.Message; ` +
    `Write-Output ('{"ok":false,"error":"'+($m -replace '[\\\\"]',' ')+'"}'); exit }`
  );
}

const okCatch =
  `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;

async function ps<T>(script: string): Promise<T | { ok: false; error: string }> {
  try {
    const res: CommandOutput = await runPowershell(script);
    const text = (res.stdout || '').trim();
    if (!text) {
      return { ok: false, error: (res.stderr || `exit ${res.code}`).trim() };
    }
    return JSON.parse(text) as T;
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

export function QbittorrentModule() {
  const { t, i18n } = useTranslation();
  const en = (i18n.language || 'en').startsWith('en');
  const desktop = isTauri();

  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(8080);
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(false);

  const [filter, setFilter] = useState('all');
  const [catFilter, setCatFilter] = useState('');
  const [search, setSearch] = useState('');

  const [connected, setConnected] = useState(false);
  const [rows, setRows] = useState<QbTorrent[]>([]);
  const [stats, setStats] = useState<QbStats | null>(null);
  const [cats, setCats] = useState<QbCat[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Add-torrent options.
  const [magnet, setMagnet] = useState('');
  const [addSave, setAddSave] = useState('');
  const [addCat, setAddCat] = useState('');
  const [addTags, setAddTags] = useState('');
  const [addPaused, setAddPaused] = useState(false);
  const [torrentPaths, setTorrentPaths] = useState('');

  // Assign category / tags to selection.
  const [assignCat, setAssignCat] = useState('');
  const [tagInput, setTagInput] = useState('');

  // Category CRUD.
  const [newCatName, setNewCatName] = useState('');
  const [newCatPath, setNewCatPath] = useState('');
  // Tag CRUD.
  const [newTagNames, setNewTagNames] = useState('');

  // Speed limits dialog.
  const [dlLimit, setDlLimit] = useState('0'); // KiB/s
  const [upLimit, setUpLimit] = useState('0');

  // Preferences.
  const [prefs, setPrefs] = useState<QbPrefs | null>(null);
  const [pSave, setPSave] = useState('');
  const [pDl, setPDl] = useState('0'); // KiB/s
  const [pUp, setPUp] = useState('0');
  const [pConn, setPConn] = useState('0');
  const [pMaxDl, setPMaxDl] = useState('0');
  const [pMaxAct, setPMaxAct] = useState('0');

  // Per-torrent detail.
  const [detail, setDetail] = useState<{ hash: string; name: string; data: DetailResult } | null>(null);
  const [detailTab, setDetailTab] = useState<'files' | 'trackers' | 'peers'>('files');

  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<null | boolean>(null); // boolean = deleteFiles pending

  const base = `http://${host.trim() || 'localhost'}:${port > 0 ? port : 8080}`;

  const say = (kind: 'ok' | 'err' | 'info', msg: string) => setNote({ kind, msg });

  // ── Live list + categories + tags + stats in one round-trip ───────────────
  const refresh = async (silent = false) => {
    if (!desktop) return;
    if (!silent) setBusy('list');
    const catQ = catFilter === ' NONE' ? '&category=' : catFilter ? `&category=${encodeURIComponent(catFilter)}` : '';
    const script =
      loginPrelude(base, user, pass) +
      `;try{` +
      `$f='${psq(filter)}';` +
      `$ti=Invoke-RestMethod -Uri "$base/api/v2/torrents/info?filter=$f${psq(catQ)}" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$tr=Invoke-RestMethod -Uri "$base/api/v2/transfer/info" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$sl=(Invoke-WebRequest -Uri "$base/api/v2/transfer/speedLimitsMode" -WebSession $ses -Headers $hdr -UseBasicParsing -TimeoutSec 20).Content.Trim();` +
      `$rawCats=Invoke-RestMethod -Uri "$base/api/v2/torrents/categories" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$catList=@(); if($rawCats){ foreach($p in $rawCats.PSObject.Properties){ $catList += [pscustomobject]@{ name=[string]$p.Name; savePath=[string]$p.Value.savePath } } }` +
      `$tagArr=@(Invoke-RestMethod -Uri "$base/api/v2/torrents/tags" -WebSession $ses -Headers $hdr -TimeoutSec 20);` +
      `$list=@($ti | ForEach-Object { [pscustomobject]@{ hash=$_.hash; name=$_.name; state=$_.state; progress=[double]$_.progress; size=[long]$_.size; dlspeed=[long]$_.dlspeed; upspeed=[long]$_.upspeed; eta=[long]$_.eta; ratio=[double]$_.ratio; category=[string]$_.category; tags=[string]$_.tags; save_path=[string]$_.save_path; num_seeds=[int]$_.num_seeds; num_leechs=[int]$_.num_leechs } });` +
      `$stats=[pscustomobject]@{ dl_info_speed=[long]$tr.dl_info_speed; up_info_speed=[long]$tr.up_info_speed; dl_rate_limit=[long]$tr.dl_rate_limit; up_rate_limit=[long]$tr.up_rate_limit; connection_status=[string]$tr.connection_status; dht_nodes=[long]$tr.dht_nodes; alt=($sl -eq '1') };` +
      `[pscustomobject]@{ ok=$true; error=''; torrents=$list; stats=$stats; cats=@($catList); tags=@($tagArr) } | ConvertTo-Json -Depth 6 -Compress` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;

    const r = await ps<ListResult>(script);
    if (!silent) setBusy('');
    if ('ok' in r && !r.ok) {
      setConnected(false);
      say('err', r.error || t('qbt.connFail'));
      return;
    }
    const res = r as ListResult;
    setConnected(true);
    const filtered = search.trim()
      ? res.torrents.filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase()))
      : res.torrents;
    setRows(filtered);
    setStats(res.stats);
    setCats(Array.isArray(res.cats) ? res.cats : []);
    setTags(Array.isArray(res.tags) ? res.tags.filter(Boolean) : []);
    setSelected((prev) => {
      const live = new Set(res.torrents.map((x) => x.hash));
      const next = new Set<string>();
      prev.forEach((h) => live.has(h) && next.add(h));
      return next;
    });
    if (!silent) say('ok', t('qbt.connected'));
  };

  const connect = async () => {
    if (!desktop) return;
    await refresh(false);
  };

  const disconnect = () => {
    setConnected(false);
    setRows([]);
    setStats(null);
    setSelected(new Set());
    say('info', t('qbt.disconnected'));
  };

  // ── Generic POST helper against the session ───────────────────────────────
  const post = async (path: string, body: Record<string, string>, tag: string, done?: () => void) => {
    if (!desktop) return false;
    setBusy(tag);
    const bodyLit = Object.entries(body)
      .map(([k, v]) => `${psq(k)}="${psd(v)}"`)
      .join('; ');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ Invoke-WebRequest -Uri "$base/api/v2${psq(path)}" -Method Post -WebSession $ses -Headers $hdr ` +
      `-Body @{ ${bodyLit} } -UseBasicParsing -TimeoutSec 30 | Out-Null; ` +
      okCatch;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return false;
    }
    done?.();
    await refresh(true);
    return true;
  };

  const hashesStr = () => [...selected].join('|');

  // ── Torrent lifecycle ─────────────────────────────────────────────────────
  const act = async (verb: string) => {
    if (selected.size === 0) return;
    await post(`/torrents/${verb}`, { hashes: hashesStr() }, verb);
  };

  const queueMove = async (dir: string) => {
    if (selected.size === 0) return;
    await post(`/torrents/${dir}`, { hashes: hashesStr() }, dir);
  };

  const del = async (deleteFiles: boolean) => {
    if (selected.size === 0) return;
    const ok = await post(
      '/torrents/delete',
      { hashes: hashesStr(), deleteFiles: deleteFiles ? 'true' : 'false' },
      'delete',
      () => say('ok', t('qbt.deleted')),
    );
    if (ok) setConfirmDel(null);
  };

  // ── Add magnet / URL ──────────────────────────────────────────────────────
  const buildAddBody = (): Record<string, string> => {
    const b: Record<string, string> = {};
    if (addSave.trim()) b.savepath = addSave.trim();
    if (addCat) b.category = addCat;
    if (addTags.trim()) b.tags = addTags.trim();
    b.stopped = addPaused ? 'true' : 'false';
    b.paused = addPaused ? 'true' : 'false';
    return b;
  };

  const addMagnet = async () => {
    if (!magnet.trim()) return;
    const urls = magnet
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean)
      .join('\n');
    const ok = await post('/torrents/add', { urls, ...buildAddBody() }, 'add', () => {
      say('ok', t('qbt.added'));
      setMagnet('');
    });
    if (ok) return;
  };

  // ── Add .torrent file(s) — multipart via backend ──────────────────────────
  const addFiles = async () => {
    if (!desktop) return;
    const paths = torrentPaths
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paths.length === 0) return;
    setBusy('addfile');
    // Build a multipart body natively: read each .torrent, attach as a file part,
    // then append the same add-options fields the C# AppendAddOptions sends.
    const opts = buildAddBody();
    const optLines = Object.entries(opts)
      .map(
        ([k, v]) =>
          `$sb.Append("--$bnd$nl") | Out-Null; $sb.Append('Content-Disposition: form-data; name="${psq(k)}"' + $nl + $nl) | Out-Null; $sb.Append('${psq(v)}' + $nl) | Out-Null;`,
      )
      .join('');
    const pathArr = paths.map((p) => `'${psq(p)}'`).join(',');
    const script =
      loginPrelude(base, user, pass) +
      `;try{` +
      `$bnd=[Guid]::NewGuid().ToString('N'); $nl="\`r\`n"; ` +
      `$ms=New-Object System.IO.MemoryStream; ` +
      `$enc=[System.Text.Encoding]::UTF8; ` +
      `function W([string]$s){ $b=$enc.GetBytes($s); $ms.Write($b,0,$b.Length) }` +
      `$n=0; foreach($p in @(${pathArr})){ if(Test-Path -LiteralPath $p){ ` +
      `$fn=[System.IO.Path]::GetFileName($p); $bytes=[System.IO.File]::ReadAllBytes($p); ` +
      `W("--$bnd$nl"); W('Content-Disposition: form-data; name="torrents"; filename="' + $fn + '"' + $nl); ` +
      `W('Content-Type: application/x-bittorrent' + $nl + $nl); ` +
      `$ms.Write($bytes,0,$bytes.Length); W($nl); $n++ } }` +
      `if($n -eq 0){ throw 'no-valid-files' } ` +
      `$sb=New-Object System.Text.StringBuilder; ${optLines} W($sb.ToString()); ` +
      `W("--$bnd--$nl"); ` +
      `$body=$ms.ToArray(); ` +
      `$ct="multipart/form-data; boundary=$bnd"; ` +
      `Invoke-WebRequest -Uri "$base/api/v2/torrents/add" -Method Post -WebSession $ses -Headers $hdr -ContentType $ct -Body $body -UseBasicParsing -TimeoutSec 60 | Out-Null; ` +
      okCatch;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
    else {
      say('ok', t('qbt.added'));
      setTorrentPaths('');
    }
    await refresh(true);
  };

  // ── Assign category / tags to selection ───────────────────────────────────
  const applyCategory = async () => {
    if (selected.size === 0) return;
    await post('/torrents/setCategory', { hashes: hashesStr(), category: assignCat }, 'setcat', () =>
      say('ok', t('qbt.catAssigned')),
    );
  };

  const applyTags = async (add: boolean) => {
    if (selected.size === 0 || !tagInput.trim()) return;
    await post(
      add ? '/torrents/addTags' : '/torrents/removeTags',
      { hashes: hashesStr(), tags: tagInput.trim() },
      'tags',
      () => {
        say('ok', add ? t('qbt.tagsAdded') : t('qbt.tagsRemoved'));
        setTagInput('');
      },
    );
  };

  // ── Category CRUD ─────────────────────────────────────────────────────────
  const createOrEditCat = async () => {
    if (!newCatName.trim()) return;
    const exists = cats.some((c) => c.name.toLowerCase() === newCatName.trim().toLowerCase());
    await post(
      exists ? '/torrents/editCategory' : '/torrents/createCategory',
      { category: newCatName.trim(), savePath: newCatPath.trim() },
      'catcrud',
      () => {
        say('ok', exists ? t('qbt.catUpdated') : t('qbt.catCreated'));
        setNewCatName('');
        setNewCatPath('');
      },
    );
  };

  const removeCat = async (name: string) => {
    await post('/torrents/removeCategories', { categories: name }, 'catdel', () => say('ok', t('qbt.catRemoved')));
  };

  // ── Tag CRUD ──────────────────────────────────────────────────────────────
  const createTags = async () => {
    if (!newTagNames.trim()) return;
    await post('/torrents/createTags', { tags: newTagNames.trim() }, 'tagcreate', () => {
      say('ok', t('qbt.tagsCreated'));
      setNewTagNames('');
    });
  };

  const deleteTag = async (name: string) => {
    await post('/torrents/deleteTags', { tags: name }, 'tagdel', () => say('ok', t('qbt.tagDeleted')));
  };

  // ── Speed limits ──────────────────────────────────────────────────────────
  const toggleAlt = async () => {
    await post('/transfer/toggleSpeedLimitsMode', {}, 'alt');
  };

  const applyGlobalLimits = async () => {
    const dl = Math.max(0, Math.round(parseFloat(dlLimit) || 0)) * 1024;
    const up = Math.max(0, Math.round(parseFloat(upLimit) || 0)) * 1024;
    const ok = await post('/transfer/setDownloadLimit', { limit: String(dl) }, 'limits');
    if (ok) await post('/transfer/setUploadLimit', { limit: String(up) }, 'limits', () => say('ok', t('qbt.limitsApplied')));
  };

  // ── Preferences ───────────────────────────────────────────────────────────
  const loadPrefs = async () => {
    if (!desktop) return;
    setBusy('prefs');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ $pr=Invoke-RestMethod -Uri "$base/api/v2/app/preferences" -WebSession $ses -Headers $hdr -TimeoutSec 20; ` +
      `[pscustomobject]@{ ok=$true; error=''; save_path=[string]$pr.save_path; web_ui_port=[int]$pr.web_ui_port; dl_limit=[long]$pr.dl_limit; up_limit=[long]$pr.up_limit; max_connec=[int]$pr.max_connec; max_active_downloads=[int]$pr.max_active_downloads; max_active_torrents=[int]$pr.max_active_torrents } | ConvertTo-Json -Compress ` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<QbPrefs & { ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return;
    }
    const p = r as QbPrefs & { ok: boolean };
    const pr: QbPrefs = {
      save_path: p.save_path || '',
      web_ui_port: p.web_ui_port || 8080,
      dl_limit: p.dl_limit || 0,
      up_limit: p.up_limit || 0,
      max_connec: p.max_connec || 0,
      max_active_downloads: p.max_active_downloads || 0,
      max_active_torrents: p.max_active_torrents || 0,
    };
    setPrefs(pr);
    setPSave(pr.save_path);
    setPDl(String(Math.round(pr.dl_limit / 1024)));
    setPUp(String(Math.round(pr.up_limit / 1024)));
    setPConn(String(pr.max_connec));
    setPMaxDl(String(pr.max_active_downloads));
    setPMaxAct(String(pr.max_active_torrents));
    say('ok', t('qbt.prefsLoaded'));
  };

  const savePrefs = async () => {
    const obj: Record<string, unknown> = {
      save_path: pSave,
      dl_limit: Math.max(0, Math.round(parseFloat(pDl) || 0)) * 1024,
      up_limit: Math.max(0, Math.round(parseFloat(pUp) || 0)) * 1024,
      max_connec: Math.max(0, Math.round(parseFloat(pConn) || 0)),
      max_active_downloads: Math.max(-1, Math.round(parseFloat(pMaxDl) || 0)),
      max_active_torrents: Math.max(-1, Math.round(parseFloat(pMaxAct) || 0)),
    };
    const json = JSON.stringify(obj);
    await post('/app/setPreferences', { json }, 'savePrefs', () => say('ok', t('qbt.prefsSaved')));
    await loadPrefs();
  };

  // ── Per-torrent detail (files / trackers / peers) ─────────────────────────
  const openDetail = async (hash: string, name: string) => {
    if (!desktop) {
      setDetail({ hash, name, data: { ok: true, error: '', files: [], trackers: [], peers: [] } });
      setDetailTab('files');
      return;
    }
    setBusy('detail-' + hash);
    const h = psq(hash);
    const script =
      loginPrelude(base, user, pass) +
      `;try{` +
      `$fl=@(Invoke-RestMethod -Uri "$base/api/v2/torrents/files?hash=${h}" -WebSession $ses -Headers $hdr -TimeoutSec 20);` +
      `$tk=@(Invoke-RestMethod -Uri "$base/api/v2/torrents/trackers?hash=${h}" -WebSession $ses -Headers $hdr -TimeoutSec 20);` +
      `$pr=Invoke-RestMethod -Uri "$base/api/v2/sync/torrentPeers?hash=${h}&rid=0" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$files=@($fl | ForEach-Object { [pscustomobject]@{ name=[string]$_.name; size=[long]$_.size; progress=[double]$_.progress; priority=[int]$_.priority } });` +
      `$trk=@($tk | ForEach-Object { [pscustomobject]@{ url=[string]$_.url; status=[int]$_.status; num_peers=[int]$_.num_peers; num_seeds=[int]$_.num_seeds; msg=[string]$_.msg } });` +
      `$peers=@(); if($pr.peers){ foreach($p in $pr.peers.PSObject.Properties){ $v=$p.Value; $peers += [pscustomobject]@{ addr=[string]$p.Name; client=[string]$v.client; progress=[double]$v.progress; dl_speed=[long]$v.dl_speed; up_speed=[long]$v.up_speed; flags=[string]$v.flags } } }` +
      `[pscustomobject]@{ ok=$true; error=''; files=@($files); trackers=@($trk); peers=@($peers) } | ConvertTo-Json -Depth 6 -Compress` +
      `}catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<DetailResult>(script);
    setBusy('');
    if ('ok' in r && !r.ok) {
      say('err', r.error);
      return;
    }
    const d = r as DetailResult;
    setDetail({
      hash,
      name,
      data: {
        ok: true,
        error: '',
        files: Array.isArray(d.files) ? d.files : [],
        trackers: Array.isArray(d.trackers) ? d.trackers : [],
        peers: Array.isArray(d.peers) ? d.peers : [],
      },
    });
    setDetailTab('files');
  };

  // ── qBittorrent desktop exe ───────────────────────────────────────────────
  const launchApp = async () => {
    if (!desktop) return;
    setBusy('launch');
    try {
      const find = await runPowershell(
        `$c=@("$env:ProgramFiles\\qBittorrent\\qbittorrent.exe","$env:ProgramW6432\\qBittorrent\\qbittorrent.exe",` +
          `"$([Environment]::GetFolderPath('ProgramFilesX86'))\\qBittorrent\\qbittorrent.exe"); ` +
          `$c | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      );
      const exe = (find.stdout || '').trim();
      if (!exe) {
        say('err', t('qbt.notFound'));
      } else {
        await runCommand(exe, []);
        say('info', t('qbt.launched'));
      }
    } catch (e) {
      say('err', String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const openWebUi = async () => {
    if (!desktop) return;
    try {
      await runCommand('cmd', ['/c', 'start', '', base]);
    } catch (e) {
      say('err', String(e instanceof Error ? e.message : e));
    }
  };

  const toggleSel = (hash: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.hash));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.hash)));

  const anySel = selected.size > 0;

  // ── Torrents sub-tab ──────────────────────────────────────────────────────
  const torrentsTab = () => (
    <>
      {/* Add magnet / URL */}
      <div className="panel">
        <label className="label">{t('qbt.addMagnet')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          rows={2}
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
          placeholder={t('qbt.magnetPlaceholder')}
        />
        <label className="label" style={{ marginTop: 8 }}>{t('qbt.addFiles')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          rows={2}
          value={torrentPaths}
          onChange={(e) => setTorrentPaths(e.target.value)}
          placeholder={t('qbt.filesPlaceholder')}
        />
        {/* Add options — save path, category, tags, paused-on-add */}
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <label className="count-note">{t('qbt.savePath')}</label>
          <input className="mod-search" style={{ maxWidth: 220 }} value={addSave} onChange={(e) => setAddSave(e.target.value)} placeholder={t('qbt.savePathPlaceholder')} />
          <label className="count-note">{t('qbt.category')}</label>
          <select className="mod-select" value={addCat} onChange={(e) => setAddCat(e.target.value)}>
            <option value="">{t('qbt.catNone')}</option>
            {cats.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
          <label className="count-note">{t('qbt.tags')}</label>
          <input className="mod-search" style={{ maxWidth: 160 }} value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder={t('qbt.tagsPlaceholder')} />
          <label className="chk">
            <input type="checkbox" checked={addPaused} onChange={(e) => setAddPaused(e.target.checked)} />
            {t('qbt.addPaused')}
          </label>
        </div>
        <div className="mod-toolbar">
          <button className="mini primary" disabled={!desktop || !connected || !magnet.trim() || busy === 'add'} onClick={addMagnet}>
            {busy === 'add' ? t('qbt.adding') : t('qbt.add')}
          </button>
          <button className="mini" disabled={!desktop || !connected || !torrentPaths.trim() || busy === 'addfile'} onClick={addFiles}>
            {busy === 'addfile' ? t('qbt.adding') : t('qbt.addFileBtn')}
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
        <select className="mod-select" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">{t('qbt.allCats')}</option>
          <option value=" NONE">{t('qbt.uncategorised')}</option>
          {cats.map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>
        <input className="mod-search" style={{ maxWidth: 180 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('qbt.searchPlaceholder')} />
        <button className="mini" disabled={!desktop || !connected || busy === 'list'} onClick={() => refresh(false)}>
          {t('qbt.refresh')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!connected || !anySel || busy === 'start'} onClick={() => act('start')}>{t('qbt.resume')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'stop'} onClick={() => act('stop')}>{t('qbt.pause')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'recheck'} onClick={() => act('recheck')}>{t('qbt.recheck')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'reannounce'} onClick={() => act('reannounce')}>{t('qbt.reannounce')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'delete'} onClick={() => setConfirmDel(false)}>{t('qbt.delete')}</button>
        {anySel && <span className="count-note">{t('qbt.selectedCount', { n: selected.size })}</span>}
      </div>

      {/* Priority / queue move */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <span className="count-note">{t('qbt.priority')}</span>
        <button className="mini" disabled={!connected || !anySel || busy === 'topPrio'} onClick={() => queueMove('topPrio')}>{t('qbt.prioTop')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'increasePrio'} onClick={() => queueMove('increasePrio')}>{t('qbt.prioUp')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'decreasePrio'} onClick={() => queueMove('decreasePrio')}>{t('qbt.prioDown')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'bottomPrio'} onClick={() => queueMove('bottomPrio')}>{t('qbt.prioBottom')}</button>
      </div>

      {/* Assign category / tags to selection */}
      {anySel && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('qbt.assignCat')}</label>
            <select className="mod-select" value={assignCat} onChange={(e) => setAssignCat(e.target.value)}>
              <option value="">{t('qbt.catRemove')}</option>
              {cats.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button className="mini" disabled={!connected || busy === 'setcat'} onClick={applyCategory}>{t('qbt.applyCat')}</button>
            <label className="count-note" style={{ marginLeft: 8 }}>{t('qbt.tags')}</label>
            <input className="mod-search" style={{ maxWidth: 180 }} value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder={tags.length ? tags.slice(0, 5).join(', ') : t('qbt.tagsPlaceholder')} />
            <button className="mini" disabled={!connected || !tagInput.trim() || busy === 'tags'} onClick={() => applyTags(true)}>{t('qbt.addTagsBtn')}</button>
            <button className="mini" disabled={!connected || !tagInput.trim() || busy === 'tags'} onClick={() => applyTags(false)}>{t('qbt.removeTagsBtn')}</button>
          </div>
        </div>
      )}

      {/* Confirm delete */}
      {confirmDel !== null && (
        <div className="panel" style={{ borderColor: 'var(--danger)' }}>
          <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.confirmDelete', { n: selected.size })}</p>
          <label className="chk">
            <input type="checkbox" checked={confirmDel === true} onChange={(e) => setConfirmDel(e.target.checked)} />
            {t('qbt.alsoDeleteData')}
          </label>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" disabled={busy === 'delete'} onClick={() => del(confirmDel === true)}>{t('qbt.confirmDeleteBtn')}</button>
            <button className="mini" onClick={() => setConfirmDel(null)}>{t('qbt.cancel')}</button>
          </div>
        </div>
      )}

      {/* Torrent table */}
      {rows.length === 0 ? (
        <p className="count-note">{connected ? t('qbt.noTorrents') : t('qbt.notConnectedHint')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                </th>
                <th>{t('qbt.colName')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colProgress')}</th>
                <th>{t('qbt.colState')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colDown')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colUp')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colRatio')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colEta')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colSize')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colPeers')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hash}>
                  <td>
                    <input type="checkbox" checked={selected.has(r.hash)} onChange={() => toggleSel(r.hash)} />
                  </td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>
                    {r.name}
                    {r.category ? <span className="count-note"> · {r.category}</span> : ''}
                    {r.tags ? <span className="count-note"> · 🏷 {r.tags}</span> : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>{(r.progress * 100).toFixed(1)}%</td>
                  <td className={stateClass(r.state)}>{stateLabel(r.state, en)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSpeed(r.dlspeed)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSpeed(r.upspeed)}</td>
                  <td style={{ textAlign: 'right' }}>{Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{humanEta(r.eta)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSize(r.size)}</td>
                  <td style={{ textAlign: 'right' }}>{r.num_seeds}/{r.num_leechs}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="mini" disabled={busy === 'detail-' + r.hash} onClick={() => openDetail(r.hash, r.name)}>{t('qbt.details')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-torrent detail */}
      {detail && (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }} title={detail.name}>{detail.name}</strong>
            <button className="mini" onClick={() => setDetail(null)}>{t('qbt.close')}</button>
          </div>
          <div className="mod-toolbar">
            <button className={`mini${detailTab === 'files' ? ' primary' : ''}`} onClick={() => setDetailTab('files')}>{t('qbt.tabFiles')}</button>
            <button className={`mini${detailTab === 'trackers' ? ' primary' : ''}`} onClick={() => setDetailTab('trackers')}>{t('qbt.tabTrackers')}</button>
            <button className={`mini${detailTab === 'peers' ? ' primary' : ''}`} onClick={() => setDetailTab('peers')}>{t('qbt.tabPeers')}</button>
          </div>
          {detailTab === 'files' && (
            detail.data.files.length === 0 ? (
              <p className="count-note">{t('qbt.noFiles')}</p>
            ) : (
              <div className="dt-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('qbt.colFile')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colSize')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colProgress')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.files.map((f, i) => (
                      <tr key={i}>
                        <td>{f.priority === 0 ? '⊘ ' : ''}{f.name}</td>
                        <td style={{ textAlign: 'right' }}>{humanSize(f.size)}</td>
                        <td style={{ textAlign: 'right' }}>{(f.progress * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {detailTab === 'trackers' && (
            detail.data.trackers.length === 0 ? (
              <p className="count-note">{t('qbt.noTrackers')}</p>
            ) : (
              <div className="dt-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('qbt.colTracker')}</th>
                      <th>{t('qbt.colState')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colPeers')}</th>
                      <th>{t('qbt.colMessage')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.trackers.map((tr, i) => (
                      <tr key={i}>
                        <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tr.url}>{tr.url}</td>
                        <td>{trackerStatus(tr.status, en)}</td>
                        <td style={{ textAlign: 'right' }}>{tr.num_seeds}/{tr.num_peers}</td>
                        <td>{tr.msg}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {detailTab === 'peers' && (
            detail.data.peers.length === 0 ? (
              <p className="count-note">{t('qbt.noPeers')}</p>
            ) : (
              <div className="dt-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('qbt.colPeer')}</th>
                      <th>{t('qbt.colClient')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colProgress')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colDown')}</th>
                      <th style={{ textAlign: 'right' }}>{t('qbt.colUp')}</th>
                      <th>{t('qbt.colFlags')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.peers.map((p, i) => (
                      <tr key={i}>
                        <td>{p.addr}</td>
                        <td>{p.client}</td>
                        <td style={{ textAlign: 'right' }}>{(p.progress * 100).toFixed(0)}%</td>
                        <td style={{ textAlign: 'right' }}>{humanSpeed(p.dl_speed)}</td>
                        <td style={{ textAlign: 'right' }}>{humanSpeed(p.up_speed)}</td>
                        <td>{p.flags}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      )}

      {/* Footer stats + alt speed + global limits */}
      {connected && stats && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="count-note">{t('qbt.footDown')}: {humanSpeed(stats.dl_info_speed)}</span>
          <span className="count-note">{t('qbt.footUp')}: {humanSpeed(stats.up_info_speed)}</span>
          <span className="count-note">{t('qbt.footStatus')}: {stats.connection_status} · DHT {stats.dht_nodes}</span>
          <span className="count-note">{t('qbt.footShown', { n: rows.length })}</span>
          <label className="chk">
            <input type="checkbox" checked={stats.alt} disabled={busy === 'alt'} onChange={toggleAlt} />
            {t('qbt.altSpeed')}
          </label>
        </div>
      )}

      {/* Global speed limits */}
      <div className="panel">
        <label className="label">{t('qbt.globalLimits')}</label>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('qbt.dlLimit')}</label>
          <input className="mod-search" type="number" style={{ maxWidth: 110 }} value={dlLimit} onChange={(e) => setDlLimit(e.target.value)} />
          <label className="count-note">{t('qbt.upLimit')}</label>
          <input className="mod-search" type="number" style={{ maxWidth: 110 }} value={upLimit} onChange={(e) => setUpLimit(e.target.value)} />
          <button className="mini" disabled={!desktop || !connected || busy === 'limits'} onClick={applyGlobalLimits}>{t('qbt.applyLimits')}</button>
          {stats && <span className="count-note">{t('qbt.currentLimits', { dl: stats.dl_rate_limit > 0 ? humanSpeed(stats.dl_rate_limit) : '∞', up: stats.up_rate_limit > 0 ? humanSpeed(stats.up_rate_limit) : '∞' })}</span>}
        </div>
      </div>
    </>
  );

  // ── Categories sub-tab ────────────────────────────────────────────────────
  const categoriesTab = () => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.catsBlurb')}</p>
      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('qbt.catName')}</label>
          <input className="mod-search" style={{ maxWidth: 180 }} value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder={t('qbt.catNamePlaceholder')} />
          <label className="count-note">{t('qbt.savePath')}</label>
          <input className="mod-search" style={{ maxWidth: 240 }} value={newCatPath} onChange={(e) => setNewCatPath(e.target.value)} placeholder={t('qbt.savePathPlaceholder')} />
          <button className="mini primary" disabled={!desktop || !connected || !newCatName.trim() || busy === 'catcrud'} onClick={createOrEditCat}>{t('qbt.catCreateBtn')}</button>
        </div>
      </div>
      {cats.length === 0 ? (
        <p className="count-note">{connected ? t('qbt.noCats') : t('qbt.notConnectedHint')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('qbt.catName')}</th>
                <th>{t('qbt.savePath')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>{c.savePath || t('qbt.catDefault')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="row-actions">
                      <button className="mini" onClick={() => { setNewCatName(c.name); setNewCatPath(c.savePath); }}>{t('qbt.catEditBtn')}</button>
                      <button className="mini" disabled={busy === 'catdel'} onClick={() => removeCat(c.name)}>{t('qbt.catDeleteBtn')}</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  // ── Tags sub-tab ──────────────────────────────────────────────────────────
  const tagsTab = () => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.tagsBlurb')}</p>
      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('qbt.newTags')}</label>
          <input className="mod-search" style={{ maxWidth: 260 }} value={newTagNames} onChange={(e) => setNewTagNames(e.target.value)} placeholder={t('qbt.tagsPlaceholder')} />
          <button className="mini primary" disabled={!desktop || !connected || !newTagNames.trim() || busy === 'tagcreate'} onClick={createTags}>{t('qbt.createTagsBtn')}</button>
        </div>
      </div>
      {tags.length === 0 ? (
        <p className="count-note">{connected ? t('qbt.noTags') : t('qbt.notConnectedHint')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('qbt.tagName')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tags.map((tg) => (
                <tr key={tg}>
                  <td>{tg}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="mini" disabled={busy === 'tagdel'} onClick={() => deleteTag(tg)}>{t('qbt.tagDeleteBtn')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  // ── Preferences sub-tab ───────────────────────────────────────────────────
  const prefsTab = () => (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.prefsBlurb')}</p>
      <div className="mod-toolbar">
        <button className="mini" disabled={!desktop || !connected || busy === 'prefs'} onClick={loadPrefs}>
          {busy === 'prefs' ? t('qbt.loading') : t('qbt.loadPrefs')}
        </button>
      </div>
      {prefs && (
        <div className="panel">
          <label className="label">{t('qbt.prefSavePath')}</label>
          <input className="mod-search" style={{ width: '100%', maxWidth: 480 }} value={pSave} onChange={(e) => setPSave(e.target.value)} placeholder={t('qbt.savePathPlaceholder')} />
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <label className="count-note">{t('qbt.dlLimit')}</label>
            <input className="mod-search" type="number" style={{ maxWidth: 110 }} value={pDl} onChange={(e) => setPDl(e.target.value)} />
            <label className="count-note">{t('qbt.upLimit')}</label>
            <input className="mod-search" type="number" style={{ maxWidth: 110 }} value={pUp} onChange={(e) => setPUp(e.target.value)} />
            <label className="count-note">{t('qbt.maxConn')}</label>
            <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={pConn} onChange={(e) => setPConn(e.target.value)} />
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('qbt.maxActiveDl')}</label>
            <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={pMaxDl} onChange={(e) => setPMaxDl(e.target.value)} />
            <label className="count-note">{t('qbt.maxActiveTorrents')}</label>
            <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={pMaxAct} onChange={(e) => setPMaxAct(e.target.value)} />
            <span className="count-note">{t('qbt.prefWebPort', { port: prefs.web_ui_port })}</span>
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" disabled={!desktop || !connected || busy === 'savePrefs'} onClick={savePrefs}>
              {busy === 'savePrefs' ? t('qbt.saving') : t('qbt.savePrefs')}
            </button>
          </div>
        </div>
      )}
    </>
  );

  const tabs: ModuleTab[] = [
    { id: 'torrents', en: 'Torrents', zh: '種子', render: torrentsTab },
    { id: 'categories', en: 'Categories', zh: '分類', render: categoriesTab },
    { id: 'tags', en: 'Tags', zh: '標籤', render: tagsTab },
    { id: 'preferences', en: 'Preferences', zh: '偏好設定', render: prefsTab },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.blurb')}</p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('qbt.desktopOnly')}</p>}

      {/* Connection */}
      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <span className={connected ? 'dep-ok' : 'dep-missing'}>
            {connected ? t('qbt.connectedPill') : t('qbt.notConnected')}
          </span>
          <label className="count-note">{t('qbt.host')}</label>
          <input className="mod-search" style={{ maxWidth: 150 }} value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
          <label className="count-note">{t('qbt.port')}</label>
          <input className="mod-search" type="number" style={{ maxWidth: 90 }} value={port} onChange={(e) => setPort(+e.target.value)} />
          <label className="count-note">{t('qbt.user')}</label>
          <input className="mod-search" style={{ maxWidth: 120 }} value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" />
          <label className="count-note">{t('qbt.pass')}</label>
          <input className="mod-search" type="password" autoComplete="off" style={{ maxWidth: 140 }} value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && desktop && connect()} />
          <label className="chk">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('qbt.remember')}
          </label>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" disabled={!desktop || busy === 'list'} onClick={connect}>
            {busy === 'list' ? t('qbt.connecting') : t('qbt.connect')}
          </button>
          <button className="mini" disabled={!connected} onClick={disconnect}>{t('qbt.disconnect')}</button>
          <button className="mini" disabled={!desktop} onClick={openWebUi}>{t('qbt.openWebUi')}</button>
          <button className="mini" disabled={!desktop || busy === 'launch'} onClick={launchApp}>{t('qbt.launchApp')}</button>
        </div>
        <p className="count-note" style={{ marginTop: 4 }}>{t('qbt.connNote')}</p>
      </div>

      {note && (
        <p className={note.kind === 'err' ? 'error' : note.kind === 'ok' ? 'dep-ok' : 'count-note'} style={{ marginTop: 8 }}>
          {note.msg}
        </p>
      )}

      <ModuleTabs tabs={tabs} />
    </div>
  );
}
