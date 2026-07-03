import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar } from './common';

// Port of WinForge DuplicatesModule (Pages/DuplicatesModule.xaml.cs + Services/DuplicateFinder.cs):
// group files by size first (cheap), SHA-256 hash only same-size candidates, so every match is
// byte-identical — no false positives. Redundant copies are pre-checked; "Recycle checked" sends
// them to the Recycle Bin (recoverable, never a permanent delete), gated behind a confirm.

/** One set of byte-identical files, as emitted by the PowerShell scan. */
interface DupGroup {
  Hash: string;
  Size: number;
  Files: string[] | string; // ConvertTo-Json may collapse; normalised via filesOf()
}

interface Row {
  path: string;
  size: number;
  group: number;
  keeper: boolean;
  hash: string;
}

const filesOf = (g: DupGroup): string[] => (Array.isArray(g.Files) ? g.Files : [g.Files]);

/** Same HumanSize as WinForge's DuplicateFinder.HumanSize. */
function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024;
    i++;
  }
  return `${Math.round(s * 10) / 10} ${units[i] ?? 'B'}`;
}

/** Escape for a single-quoted PowerShell string literal. */
const psq = (s: string) => s.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');

const PRESETS = [
  { key: 'presetDownloads', path: '%USERPROFILE%\\Downloads' },
  { key: 'presetDocuments', path: '%USERPROFILE%\\Documents' },
  { key: 'presetPictures', path: '%USERPROFILE%\\Pictures' },
  { key: 'presetDesktop', path: '%USERPROFILE%\\Desktop' },
] as const;

export function DuplicatesModule() {
  const { t } = useTranslation();
  const [folder, setFolder] = useState('%USERPROFILE%\\Downloads');
  const [recurse, setRecurse] = useState(true);
  const [minSize, setMinSize] = useState('1'); // bytes; 1 = any non-empty file (desktop parity)
  const [filter, setFilter] = useState('');
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [recycling, setRecycling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const scanScript = () => {
    const min = Number.parseInt(minSize, 10) || 1;
    const rec = recurse ? ' -Recurse' : '';
    return (
      `$folder=[Environment]::ExpandEnvironmentVariables('${psq(folder.trim())}'); ` +
      `if(-not (Test-Path -LiteralPath $folder -PathType Container)){ throw ('Not a folder: ' + $folder) }; ` +
      `$files=@(Get-ChildItem -LiteralPath $folder -File${rec} -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -ge ${min} }); ` +
      // Size-group first, then SHA-256 only the same-size candidates (unreadable/locked files skipped).
      `$cand=@($files | Group-Object Length | Where-Object { $_.Count -gt 1 } | ForEach-Object { ` +
      `$sz=[long]$_.Name; foreach($f in $_.Group){ ` +
      `try { $h=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $h=$null }; ` +
      `if($h){ [pscustomobject]@{ H=$h; P=$f.FullName; S=$sz } } } }); ` +
      `$cand | Group-Object H | Where-Object { $_.Count -gt 1 } | ForEach-Object { ` +
      `[pscustomobject]@{ Hash=$_.Name; Size=[long]$_.Group[0].S; Files=@($_.Group | ForEach-Object { $_.P }) } } | ` +
      `Sort-Object @{E={ $_.Size * ($_.Files.Count - 1) }} -Descending`
    );
  };

  const doScan = async () => {
    if (scanning) return;
    setScanning(true);
    setErr(null);
    setMsg(null);
    try {
      const g = await runPowershellJson<DupGroup>(scanScript());
      setGroups(g);
      // Desktop parity: pre-check every redundant copy, keep the first file of each group.
      const pre = new Set<string>();
      for (const grp of g) filesOf(grp).slice(1).forEach((p) => pre.add(p));
      setChecked(pre);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setScanning(false);
    }
  };

  const doRecycle = async () => {
    if (recycling || scanning) return;
    const paths = Array.from(checked);
    if (paths.length === 0) {
      setMsg(t('duplicates.nothingChecked'));
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(t('duplicates.confirmRecycle', { n: paths.length }))) return;
    setRecycling(true);
    setErr(null);
    setMsg(null);
    try {
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < paths.length; i += 80) {
        const list = paths
          .slice(i, i + 80)
          .map((p) => `'${psq(p)}'`)
          .join(',');
        // FileIO.DeleteFile with SendToRecycleBin = SHFileOperation w/ FOF_ALLOWUNDO (recoverable).
        const res = await runPowershellJson<{ Ok: number; Fail: number }>(
          `Add-Type -AssemblyName Microsoft.VisualBasic; $ok=0; $fail=0; ` +
            `foreach($p in @(${list})){ try { ` +
            `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin','ThrowException'); $ok++ ` +
            `} catch { $fail++ } }; [pscustomobject]@{ Ok=$ok; Fail=$fail }`,
        );
        const r = res[0];
        ok += r?.Ok ?? 0;
        fail += r?.Fail ?? 0;
      }
      setMsg(t('duplicates.recycled', { ok, fail }));
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setRecycling(false);
    }
    void doScan(); // desktop parity: rescan after recycling
  };

  const toggle = (p: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const stats = useMemo(() => {
    let redundant = 0;
    let wasted = 0;
    for (const g of groups ?? []) {
      const extra = filesOf(g).length - 1;
      redundant += extra;
      wasted += g.Size * extra;
    }
    return { groupsN: (groups ?? []).length, redundant, wasted };
  }, [groups]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    (groups ?? []).forEach((g, gi) => {
      filesOf(g).forEach((p, fi) =>
        out.push({ path: p, size: g.Size, group: gi + 1, keeper: fi === 0, hash: g.Hash }),
      );
    });
    const q = filter.trim().toLowerCase();
    return q ? out.filter((r) => r.path.toLowerCase().includes(q)) : out;
  }, [groups, filter]);

  const busy = scanning || recycling;

  const columns: Column<Row>[] = [
    {
      key: 'check',
      header: '',
      width: 36,
      render: (r) => (
        <input type="checkbox" checked={checked.has(r.path)} disabled={busy} onChange={() => toggle(r.path)} />
      ),
    },
    {
      key: 'group',
      header: t('duplicates.group'),
      width: 120,
      render: (r) => (
        <span title={`SHA-256 ${r.hash}`} style={{ whiteSpace: 'nowrap' }}>
          {t('duplicates.groupN', { n: r.group })}
          {r.keeper && <em style={{ opacity: 0.65, fontStyle: 'normal' }}> {t('duplicates.keep')}</em>}
        </span>
      ),
    },
    {
      key: 'path',
      header: t('duplicates.path'),
      render: (r) => (
        <span style={{ fontFamily: 'Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }}>{r.path}</span>
      ),
    },
    {
      key: 'size',
      header: t('duplicates.size'),
      width: 90,
      align: 'right',
      render: (r) => humanSize(r.size),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('duplicates.blurb')}
      </p>
      <ModuleToolbar>
        <span className="count-note">{t('duplicates.folder')}</span>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 240 }}
          value={folder}
          placeholder="%USERPROFILE%\Downloads"
          onChange={(e) => setFolder(e.target.value)}
        />
        {PRESETS.map((p) => (
          <button key={p.key} className="mini" disabled={busy} onClick={() => setFolder(p.path)}>
            {t(`duplicates.${p.key}`)}
          </button>
        ))}
      </ModuleToolbar>
      <ModuleToolbar>
        <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={recurse} disabled={busy} onChange={(e) => setRecurse(e.target.checked)} />
          {t('duplicates.subfolders')}
        </label>
        <select className="mod-select" value={minSize} disabled={busy} onChange={(e) => setMinSize(e.target.value)}>
          <option value="1">{t('duplicates.minAny')}</option>
          <option value="1024">≥ 1 KB</option>
          <option value="1048576">≥ 1 MB</option>
          <option value="104857600">≥ 100 MB</option>
        </select>
        <button className="mini primary" disabled={busy} onClick={doScan}>
          {scanning ? t('duplicates.scanning') : t('duplicates.scan')}
        </button>
        <button className="mini" disabled={busy || checked.size === 0} onClick={doRecycle}>
          {recycling ? t('duplicates.recycling') : t('duplicates.recycle', { n: checked.size })}
        </button>
        <input
          className="mod-search"
          style={{ maxWidth: 180 }}
          placeholder={t('duplicates.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {groups !== null && !scanning && (
          <span className="count-note">
            {t('duplicates.summary', {
              groups: stats.groupsN,
              redundant: stats.redundant,
              size: humanSize(stats.wasted),
            })}
          </span>
        )}
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('duplicates.binNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}
      {scanning ? (
        <p className="count-note">{t('duplicates.scanning')}</p>
      ) : groups === null ? (
        !err && <p className="count-note">{t('duplicates.idleHint')}</p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.path} empty={t('duplicates.noDupes')} />
      )}
    </div>
  );
}
