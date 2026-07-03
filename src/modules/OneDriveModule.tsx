import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — OneDrive Files-On-Demand control via the WinForge desktop backend.
// Pins items to always-local (attrib +P -U), dehydrates them to online-only (attrib +U -P),
// pauses/resumes OneDrive.exe, and reads/sets the auto-free dehydration age (registry DWORD).
// No external tool: everything is a built-in Windows capability, so live actions need the
// desktop app. In a plain browser we show a "requires WinForge desktop" note and disable them.

// Cloud Files placeholder attributes (winnt.h).
const FILE_PINNED = 0x00080000; // FILE_ATTRIBUTE_PINNED  -> always-local
const FILE_UNPINNED = 0x00100000; // FILE_ATTRIBUTE_UNPINNED -> online-only
const FILE_RECALL = 0x00400000; // FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
const FILE_OFFLINE = 0x00001000; // FILE_ATTRIBUTE_OFFLINE

const STORAGE_POLICY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy';
const THRESHOLD_VALUE = 'ConfigStorageSenseCloudContentDehydrationThreshold';

type OdState = 'online' | 'pinned' | 'ondemand';

interface Entry {
  path: string;
  name: string;
  isFolder: boolean;
  size: number;
  attr: number;
}

interface RawEntry {
  path?: unknown;
  name?: unknown;
  isFolder?: unknown;
  size?: unknown;
  attr?: unknown;
}

const esc = (s: string) => s.replace(/'/g, "''");

function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < u.length - 1) {
    s /= 1024;
    i++;
  }
  return `${Math.round(s * 10) / 10} ${u[i] ?? 'B'}`;
}

function stateOf(e: Entry): OdState {
  if ((e.attr & FILE_UNPINNED) !== 0) return 'online';
  if ((e.attr & FILE_PINNED) !== 0) return 'pinned';
  return 'ondemand';
}

// Best-guess OneDrive root: $env:OneDrive, else consumer/commercial, else profile\OneDrive.
const defaultRootScript = `$c=$env:OneDrive; if(-not $c){ $c=$env:OneDriveConsumer }; if(-not $c){ $c=$env:OneDriveCommercial }; ` +
  `if($c -and (Test-Path -LiteralPath $c)){ $c } else { $g=Join-Path $env:USERPROFILE 'OneDrive'; if(Test-Path -LiteralPath $g){ $g } else { '' } }`;

function listScript(folder: string): string {
  const p = esc(folder);
  return `$f='${p}'; if(-not (Test-Path -LiteralPath $f)){ return }; ` +
    `Get-ChildItem -LiteralPath $f -Force -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$sz=0; if(-not $_.PSIsContainer){ try{ $sz=[long]$_.Length }catch{ $sz=0 } }; ` +
    `[pscustomobject]@{ path=$_.FullName; name=$_.Name; isFolder=[bool]$_.PSIsContainer; size=$sz; attr=[int]$_.Attributes } }`;
}

// attrib +P -U (pin) / +U -P (dehydrate); recurse into directories with /S /D.
function attribScript(paths: string[], flags: string): string {
  const lines = paths.map((raw) => {
    const p = esc(raw);
    return `$p='${p}'; if(Test-Path -LiteralPath $p){ ` +
      `if(Test-Path -LiteralPath $p -PathType Container){ & attrib ${flags} $p /S /D } else { & attrib ${flags} $p }; ` +
      `if($LASTEXITCODE -eq 0){ $ok++ } else { $fail++ } } else { $fail++ }`;
  });
  return `$ok=0; $fail=0; ${lines.join(' ')} Write-Output "$ok $fail"`;
}

function oneDriveActionScript(arg: string): string {
  return `$pf86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); ` +
    `$cands=@((Join-Path $env:LOCALAPPDATA 'Microsoft\\OneDrive\\OneDrive.exe'), ` +
    `(Join-Path $env:ProgramFiles 'Microsoft OneDrive\\OneDrive.exe')); ` +
    `if($pf86){ $cands += (Join-Path $pf86 'Microsoft OneDrive\\OneDrive.exe') }; ` +
    `$hit=$cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1; ` +
    `if(-not $hit){ Write-Error 'OneDrive.exe not found.'; exit 1 }; ` +
    `Start-Process -FilePath $hit -ArgumentList '${arg}'; Write-Output 'ok'`;
}

const getThresholdScript = `try{ $v=(Get-ItemProperty -Path '${STORAGE_POLICY}' -Name '${THRESHOLD_VALUE}' -ErrorAction Stop).'${THRESHOLD_VALUE}'; if($v -is [int] -and $v -gt 0){ [int]$v } else { 0 } }catch{ 0 }`;

function setThresholdScript(days: number): string {
  const d = Math.max(0, Math.floor(days));
  if (d <= 0) {
    return `if(-not (Test-Path -LiteralPath '${STORAGE_POLICY}')){ Write-Output 'ok'; return }; ` +
      `Remove-ItemProperty -Path '${STORAGE_POLICY}' -Name '${THRESHOLD_VALUE}' -ErrorAction SilentlyContinue; Write-Output 'ok'`;
  }
  return `if(-not (Test-Path -LiteralPath '${STORAGE_POLICY}')){ New-Item -Path '${STORAGE_POLICY}' -Force | Out-Null }; ` +
    `New-ItemProperty -Path '${STORAGE_POLICY}' -Name '${THRESHOLD_VALUE}' -Value ${d} -PropertyType DWord -Force | Out-Null; Write-Output 'ok'`;
}

function firstText(res: CommandOutput): string {
  return (res.stdout || '').trim();
}

export function OneDriveModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [folder, setFolder] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState(0);
  const [thresholdInput, setThresholdInput] = useState('0');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const parseEntries = (rows: RawEntry[]): Entry[] => {
    const out: Entry[] = [];
    for (const r of rows) {
      const path = typeof r.path === 'string' ? r.path : '';
      if (!path) continue;
      out.push({
        path,
        name: typeof r.name === 'string' ? r.name : path,
        isFolder: r.isFolder === true,
        size: typeof r.size === 'number' ? r.size : 0,
        attr: typeof r.attr === 'number' ? r.attr : 0,
      });
    }
    out.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return out;
  };

  const load = async (target: string) => {
    if (!desktop) return;
    const dir = target.trim();
    if (!dir) {
      setEntries(null);
      return;
    }
    setBusy('load');
    setErr(null);
    setSelected(new Set());
    try {
      const rows = await runPowershellJson<RawEntry>(listScript(dir));
      setEntries(parseEntries(rows));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setEntries(null);
    } finally {
      setBusy('');
    }
  };

  const detectAndLoad = async () => {
    if (!desktop) return;
    setBusy('detect');
    setErr(null);
    try {
      const rootRes = await runPowershell(defaultRootScript);
      const root = firstText(rootRes);
      if (root) {
        setFolder(root);
        await load(root);
      } else {
        setEntries([]);
        setStatus(t('onedrivem.noRoot'));
      }
      const thr = await runPowershell(getThresholdScript);
      const n = parseInt(firstText(thr), 10);
      const days = Number.isFinite(n) ? n : 0;
      setThreshold(days);
      setThresholdInput(String(days));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => {
    if (!entries) return;
    setSelected(new Set(entries.map((e) => e.path)));
  };
  const clearSel = () => setSelected(new Set());

  const runAttrib = async (flags: string, verbKey: string) => {
    if (!desktop || selected.size === 0) return;
    setBusy(verbKey);
    setErr(null);
    setStatus(null);
    try {
      const paths = Array.from(selected);
      const res = await runPowershell(attribScript(paths, flags));
      const parts = firstText(res).split(/\s+/);
      const ok = parseInt(parts[0] ?? '0', 10) || 0;
      const fail = parseInt(parts[1] ?? '0', 10) || 0;
      setStatus(t('onedrivem.attribResult', { verb: t(verbKey), ok, fail }));
      if (!res.success && fail > 0 && res.stderr.trim()) setErr(res.stderr.trim());
      await load(folder);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const syncAction = async (arg: string, verbKey: string) => {
    if (!desktop) return;
    setBusy(verbKey);
    setErr(null);
    setStatus(null);
    try {
      const res = await runPowershell(oneDriveActionScript(arg));
      if (firstText(res) === 'ok' && res.success) {
        setStatus(t('onedrivem.syncDone', { verb: t(verbKey) }));
      } else {
        setErr(res.stderr.trim() || t('onedrivem.noExe'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const applyThreshold = async () => {
    if (!desktop) return;
    const n = parseInt(thresholdInput, 10);
    const days = Number.isFinite(n) && n > 0 ? n : 0;
    setBusy('threshold');
    setErr(null);
    setStatus(null);
    try {
      const res = await runPowershell(setThresholdScript(days));
      if (firstText(res) === 'ok' && res.success) {
        setThreshold(days);
        setStatus(days > 0 ? t('onedrivem.thresholdSet', { days }) : t('onedrivem.thresholdCleared'));
      } else {
        setErr(res.stderr.trim() || `exit ${res.code}`);
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const stateLabel: Record<OdState, string> = {
    online: t('onedrivem.stateOnline'),
    pinned: t('onedrivem.statePinned'),
    ondemand: t('onedrivem.stateOndemand'),
  };
  const stateColor: Record<OdState, string> = {
    online: 'var(--warn, #b8860b)',
    pinned: 'var(--ok, #2e7d32)',
    ondemand: 'var(--muted, #888)',
  };

  const localCount = entries?.filter((e) => {
    const s = e.isFolder ? 0 : e.attr;
    return !e.isFolder && (s & FILE_RECALL) === 0 && (s & FILE_OFFLINE) === 0;
  }).length ?? 0;

  return (
    <div className="mod">
      <p className="count-note">{t('onedrivem.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('onedrivem.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!desktop || !!busy} onClick={detectAndLoad}>
          {busy === 'detect' ? t('onedrivem.detecting') : t('onedrivem.detect')}
        </button>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 220 }}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && load(folder)}
          placeholder={t('onedrivem.folderPlaceholder')}
        />
        <button className="mini" disabled={!desktop || !!busy || !folder.trim()} onClick={() => load(folder)}>
          {busy === 'load' ? t('onedrivem.loading') : t('onedrivem.refresh')}
        </button>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {status && <p className="count-note" style={{ color: 'var(--ok, #2e7d32)' }}>{status}</p>}

      {entries && entries.length > 0 && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" disabled={!desktop || !!busy} onClick={selectAll}>{t('onedrivem.selectAll')}</button>
            <button className="mini" disabled={!desktop || !!busy || selected.size === 0} onClick={clearSel}>{t('onedrivem.clear')}</button>
            <button className="mini primary" disabled={!desktop || !!busy || selected.size === 0} onClick={() => runAttrib('+P -U', 'onedrivem.pin')}>
              {busy === 'onedrivem.pin' ? t('onedrivem.working') : t('onedrivem.pin')}
            </button>
            <button className="mini" disabled={!desktop || !!busy || selected.size === 0} onClick={() => runAttrib('+U -P', 'onedrivem.dehydrate')}>
              {busy === 'onedrivem.dehydrate' ? t('onedrivem.working') : t('onedrivem.dehydrate')}
            </button>
            <span className="count-note">{selected.size > 0 ? t('onedrivem.selCount', { n: selected.size }) : ''}</span>
          </div>
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>{t('onedrivem.colName')}</th>
                <th>{t('onedrivem.colType')}</th>
                <th style={{ textAlign: 'right' }}>{t('onedrivem.colSize')}</th>
                <th>{t('onedrivem.colState')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const st = stateOf(e);
                return (
                  <tr key={e.path}>
                    <td>
                      <input
                        className="chk"
                        type="checkbox"
                        checked={selected.has(e.path)}
                        disabled={!desktop || !!busy}
                        onChange={() => toggle(e.path)}
                      />
                    </td>
                    <td
                      style={{ cursor: e.isFolder ? 'pointer' : 'default', fontFamily: 'monospace' }}
                      onDoubleClick={() => e.isFolder && desktop && load(e.path)}
                      title={e.path}
                    >
                      {e.isFolder ? '📁 ' : '📄 '}{e.name}
                    </td>
                    <td>{e.isFolder ? t('onedrivem.folder') : t('onedrivem.file')}</td>
                    <td style={{ textAlign: 'right' }}>{e.isFolder ? '' : humanSize(e.size)}</td>
                    <td style={{ color: stateColor[st] }}>{stateLabel[st]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="count-note" style={{ marginTop: 8 }}>{t('onedrivem.summary', { total: entries.length, local: localCount })}</p>
        </div>
      )}

      {entries && entries.length === 0 && (
        <p className="count-note">{t('onedrivem.emptyFolder')}</p>
      )}

      <div className="panel">
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => syncAction('/shutdown', 'onedrivem.pause')}>
            {busy === 'onedrivem.pause' ? t('onedrivem.working') : t('onedrivem.pause')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => syncAction('/background', 'onedrivem.resume')}>
            {busy === 'onedrivem.resume' ? t('onedrivem.working') : t('onedrivem.resume')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <label className="count-note">{t('onedrivem.thresholdLabel')}</label>
          <input
            className="mod-search"
            type="number"
            min={0}
            max={365}
            style={{ maxWidth: 90 }}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
          />
          <button className="mini primary" disabled={!desktop || !!busy} onClick={applyThreshold}>
            {busy === 'threshold' ? t('onedrivem.working') : t('onedrivem.apply')}
          </button>
          <span className="count-note">
            {threshold > 0 ? t('onedrivem.thresholdCurrent', { days: threshold }) : t('onedrivem.thresholdOff')}
          </span>
        </div>
      </div>

      <p className="count-note">{t('onedrivem.note')}</p>
    </div>
  );
}
