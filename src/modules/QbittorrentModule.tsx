import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — an in-app front-end over qBittorrent's local WebUI (Web API v2).
// The C# original held an HttpClient + CookieContainer session against http://localhost:8080.
// The web port drives the same Web API v2 through the desktop backend: each action is a
// single self-contained PowerShell script that logs in (grabbing the SID cookie into a
// WebRequestSession) and then performs the request in that same session — so no state leaks
// between calls and nothing ever throws. It also locates and launches the qBittorrent desktop
// exe and opens the WebUI URL. Live probing requires the WinForge desktop app.

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
  num_seeds: number;
  num_leechs: number;
}

interface QbStats {
  dl_info_speed: number;
  up_info_speed: number;
  connection_status: string;
  dht_nodes: number;
  alt: boolean;
}

interface ListResult {
  ok: boolean;
  error: string;
  torrents: QbTorrent[];
  stats: QbStats | null;
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

// PowerShell-single-quote escape.
const psq = (s: string) => s.replace(/'/g, "''");

/**
 * Emit a PowerShell prelude that logs into the qBittorrent WebUI and leaves a
 * $ses (WebRequestSession) + $base variable ready for follow-up calls. On any
 * failure it writes a JSON error object and exits, so callers always get JSON.
 */
function loginPrelude(base: string, user: string, pass: string): string {
  return (
    `$ErrorActionPreference='Stop';` +
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

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const [connected, setConnected] = useState(false);
  const [rows, setRows] = useState<QbTorrent[]>([]);
  const [stats, setStats] = useState<QbStats | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [magnet, setMagnet] = useState('');

  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);

  const base = `http://${(host.trim() || 'localhost')}:${port > 0 ? port : 8080}`;

  const say = (kind: 'ok' | 'err' | 'info', msg: string) => setNote({ kind, msg });

  const refresh = async (silent = false) => {
    if (!desktop) return;
    if (!silent) setBusy('list');
    const script =
      loginPrelude(base, user, pass) +
      `;try{` +
      `$f='${psq(filter)}';` +
      `$ti=Invoke-RestMethod -Uri "$base/api/v2/torrents/info?filter=$f" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$tr=Invoke-RestMethod -Uri "$base/api/v2/transfer/info" -WebSession $ses -Headers $hdr -TimeoutSec 20;` +
      `$sl=(Invoke-WebRequest -Uri "$base/api/v2/transfer/speedLimitsMode" -WebSession $ses -Headers $hdr -UseBasicParsing -TimeoutSec 20).Content.Trim();` +
      `$list=@($ti | ForEach-Object { [pscustomobject]@{ hash=$_.hash; name=$_.name; state=$_.state; progress=[double]$_.progress; size=[long]$_.size; dlspeed=[long]$_.dlspeed; upspeed=[long]$_.upspeed; eta=[long]$_.eta; ratio=[double]$_.ratio; category=[string]$_.category; tags=[string]$_.tags; num_seeds=[int]$_.num_seeds; num_leechs=[int]$_.num_leechs } });` +
      `$stats=[pscustomobject]@{ dl_info_speed=[long]$tr.dl_info_speed; up_info_speed=[long]$tr.up_info_speed; connection_status=[string]$tr.connection_status; dht_nodes=[long]$tr.dht_nodes; alt=($sl -eq '1') };` +
      `[pscustomobject]@{ ok=$true; error=''; torrents=$list; stats=$stats } | ConvertTo-Json -Depth 6 -Compress` +
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
    // Drop selections that no longer exist.
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

  // Run a POST action against a set of hashes (start/stop/recheck), then refresh.
  const act = async (verb: string) => {
    if (!desktop || selected.size === 0) return;
    setBusy(verb);
    const hashes = [...selected].join('|');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ Invoke-WebRequest -Uri "$base/api/v2/torrents/${psq(verb)}" -Method Post -WebSession $ses -Headers $hdr -Body @{ hashes='${psq(hashes)}' } -UseBasicParsing -TimeoutSec 20 | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
    await refresh(true);
  };

  const del = async (deleteFiles: boolean) => {
    if (!desktop || selected.size === 0) return;
    setBusy('delete');
    const hashes = [...selected].join('|');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ Invoke-WebRequest -Uri "$base/api/v2/torrents/delete" -Method Post -WebSession $ses -Headers $hdr ` +
      `-Body @{ hashes='${psq(hashes)}'; deleteFiles='${deleteFiles ? 'true' : 'false'}' } -UseBasicParsing -TimeoutSec 20 | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
    else say('ok', t('qbt.deleted'));
    await refresh(true);
  };

  const addMagnet = async () => {
    if (!desktop || !magnet.trim()) return;
    setBusy('add');
    const urls = magnet
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean)
      .join('`n');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ Invoke-WebRequest -Uri "$base/api/v2/torrents/add" -Method Post -WebSession $ses -Headers $hdr ` +
      `-Body @{ urls="${psq(urls)}" } -UseBasicParsing -TimeoutSec 30 | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
    else {
      say('ok', t('qbt.added'));
      setMagnet('');
    }
    await refresh(true);
  };

  const toggleAlt = async () => {
    if (!desktop) return;
    setBusy('alt');
    const script =
      loginPrelude(base, user, pass) +
      `;try{ Invoke-WebRequest -Uri "$base/api/v2/transfer/toggleSpeedLimitsMode" -Method Post -WebSession $ses -Headers $hdr -UseBasicParsing -TimeoutSec 20 | Out-Null; ` +
      `Write-Output '{"ok":true,"error":""}' }catch{ Write-Output ('{"ok":false,"error":"'+($_.Exception.Message -replace '[\\\\"]',' ')+'"}') }`;
    const r = await ps<{ ok: boolean; error: string }>(script);
    setBusy('');
    if ('ok' in r && !r.ok) say('err', r.error);
    await refresh(true);
  };

  // Locate qbittorrent.exe under Program Files and launch it detached.
  const launchApp = async () => {
    if (!desktop) return;
    setBusy('launch');
    try {
      const find = await runPowershell(
        `$c=@("$env:ProgramFiles\\qBittorrent\\qbittorrent.exe","${''}$env:ProgramW6432\\qBittorrent\\qbittorrent.exe","` +
          `$(${''}[Environment]::GetFolderPath('ProgramFilesX86'))\\qBittorrent\\qbittorrent.exe"); ` +
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
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.hash)));

  const anySel = selected.size > 0;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('qbt.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('qbt.desktopOnly')}</p>
      )}

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
          <input className="mod-search" type="password" style={{ maxWidth: 140 }} value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && desktop && connect()} />
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

      {/* Add magnet */}
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
        <div className="mod-toolbar">
          <button className="mini primary" disabled={!desktop || !connected || !magnet.trim() || busy === 'add'} onClick={addMagnet}>
            {busy === 'add' ? t('qbt.adding') : t('qbt.add')}
          </button>
        </div>
      </div>

      {/* Filter + actions */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <select className="mod-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map(([code, e, z]) => (
            <option key={code} value={code}>{en ? e : z}</option>
          ))}
        </select>
        <input className="mod-search" style={{ maxWidth: 200 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('qbt.searchPlaceholder')} />
        <button className="mini" disabled={!desktop || !connected || busy === 'list'} onClick={() => refresh(false)}>
          {t('qbt.refresh')}
        </button>
        <button className="mini" disabled={!connected || !anySel || busy === 'start'} onClick={() => act('start')}>{t('qbt.resume')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'stop'} onClick={() => act('stop')}>{t('qbt.pause')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'recheck'} onClick={() => act('recheck')}>{t('qbt.recheck')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'delete'} onClick={() => del(false)}>{t('qbt.delete')}</button>
        <button className="mini" disabled={!connected || !anySel || busy === 'delete'} onClick={() => del(true)}>{t('qbt.deleteData')}</button>
        {anySel && <span className="count-note">{t('qbt.selectedCount', { n: selected.size })}</span>}
      </div>

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
                <th style={{ textAlign: 'right' }}>{t('qbt.colEta')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colSize')}</th>
                <th style={{ textAlign: 'right' }}>{t('qbt.colPeers')}</th>
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
                  </td>
                  <td style={{ textAlign: 'right' }}>{(r.progress * 100).toFixed(1)}%</td>
                  <td className={stateClass(r.state)}>{stateLabel(r.state, en)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSpeed(r.dlspeed)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSpeed(r.upspeed)}</td>
                  <td style={{ textAlign: 'right' }}>{humanEta(r.eta)}</td>
                  <td style={{ textAlign: 'right' }}>{humanSize(r.size)}</td>
                  <td style={{ textAlign: 'right' }}>{r.num_seeds}/{r.num_leechs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer stats */}
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
    </div>
  );
}
