import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { ModuleToolbar } from './common';
import { ModuleTabs } from './ModuleTabs';
import { ServicesModule } from './ServicesModule';

/**
 * Native Process Explorer — full parity port of WinForge's ProcessExplorerModule.
 *
 * A System-Informer-style process tree built from Get-Process + CIM Win32_Process:
 * parent/child hierarchy, live CPU %, working set, threads, owner and description.
 * CPU % is derived from TotalProcessorTime deltas between snapshots divided by the
 * logical core count (same maths as Task Manager / the C# service). Select a process
 * to end it (or its whole tree), set priority, open its file location, copy its PID /
 * path / command line, or view full details. Reads auto-run; every mutation is
 * click-gated and the destructive ones confirm first.
 */

interface RawProc {
  Pid: number;
  ParentPid: number;
  Name: string;
  CpuTimeMs: number; // TotalProcessorTime in ms (for delta CPU%)
  WorkingSetBytes: number;
  PrivateBytes: number;
  ThreadCount: number;
  ModuleCount: number;
  Owner: string;
  Description: string;
  CommandLine: string;
  ExecutablePath: string;
  StartTime: string; // ISO-ish or ''
  Priority: string;
}

interface ProcEntry extends RawProc {
  CpuPercent: number;
}

interface TreeNode {
  entry: ProcEntry;
  children: TreeNode[];
  depth: number;
}

const INTERVALS = [1, 2, 5] as const;

/** PowerShell 5.1-compatible snapshot: Get-Process joined with CIM Win32_Process. */
const SNAPSHOT_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cim = @{}
try {
  Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    $o = $null
    try { $o = (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop) } catch { $o = $null }
    $owner = ''
    if ($o -and $o.ReturnValue -eq 0 -and $o.User) {
      if ($o.Domain) { $owner = "$($o.Domain)\\$($o.User)" } else { $owner = $o.User }
    }
    $cim[[int]$_.ProcessId] = [pscustomobject]@{
      ParentPid = [int]$_.ParentProcessId
      CommandLine = [string]$_.CommandLine
      ExecutablePath = [string]$_.ExecutablePath
      Owner = $owner
      StartTime = if ($_.CreationDate) { (Get-Date $_.CreationDate).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
    }
  }
} catch {}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  $w = $null
  if ($cim.ContainsKey([int]$p.Id)) { $w = $cim[[int]$p.Id] }
  $cpuMs = 0.0
  try { $cpuMs = [double]$p.TotalProcessorTime.TotalMilliseconds } catch {}
  $ws = 0; try { $ws = [long]$p.WorkingSet64 } catch {}
  $pb = 0; try { $pb = [long]$p.PrivateMemorySize64 } catch {}
  $thr = 0; try { $thr = [int]$p.Threads.Count } catch {}
  $mods = 0; try { $mods = [int]$p.Modules.Count } catch {}
  $prio = ''; try { $prio = [string]$p.PriorityClass } catch {}
  $exe = ''; if ($w) { $exe = $w.ExecutablePath }
  if (-not $exe) { try { $exe = [string]$p.Path } catch {} }
  $st = ''; if ($w) { $st = $w.StartTime }
  if (-not $st) { try { $st = $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch {} }
  $desc = ''
  try { if ($p.Description) { $desc = [string]$p.Description } } catch {}
  [pscustomobject]@{
    Pid = [int]$p.Id
    ParentPid = if ($w) { [int]$w.ParentPid } else { 0 }
    Name = [string]$p.ProcessName
    CpuTimeMs = $cpuMs
    WorkingSetBytes = $ws
    PrivateBytes = $pb
    ThreadCount = $thr
    ModuleCount = $mods
    Owner = if ($w) { [string]$w.Owner } else { '' }
    Description = $desc
    CommandLine = if ($w) { [string]$w.CommandLine } else { '' }
    ExecutablePath = $exe
    StartTime = $st
    Priority = $prio
  }
}
`.trim();

function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Math.round(v * 10) / 10} ${u[i]}`;
}

/** Priority classes the menu offers → the .NET ProcessPriorityClass name we set. */
const PRIORITY_CLASSES = [
  'RealTime',
  'High',
  'AboveNormal',
  'Normal',
  'BelowNormal',
  'Idle',
] as const;
type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export function ProcExplorerModule() {
  return (
    <ModuleTabs
      tabs={[
        { id: 'processes', en: 'Processes', zh: '程序', render: () => <ProcessExplorerTab /> },
        { id: 'services', en: 'Services', zh: '服務', render: () => <ServicesModule /> },
      ]}
    />
  );
}

function ProcessExplorerTab() {
  const { t } = useTranslation();
  const native = isTauri();

  const [entries, setEntries] = useState<ProcEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [elevated, setElevated] = useState<boolean | null>(null);

  const [filter, setFilter] = useState('');
  const [auto, setAuto] = useState(true);
  const [intervalSec, setIntervalSec] = useState<number>(2);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);

  const [detail, setDetail] = useState<ProcEntry | null>(null);
  const [prioFor, setPrioFor] = useState<number | null>(null);
  const [copyFor, setCopyFor] = useState<number | null>(null);
  const [confirmTree, setConfirmTree] = useState<ProcEntry | null>(null);

  // Previous TotalProcessorTime per PID + wall clock, for CPU% deltas (Task-Manager maths).
  const prevCpu = useRef<Map<number, number>>(new Map());
  const prevStamp = useRef<number>(0);
  const cores = useRef<number>(Math.max(1, navigator.hardwareConcurrency || 1));
  const inflight = useRef<boolean>(false);

  const sample = useCallback(async () => {
    if (!native || inflight.current) return;
    inflight.current = true;
    try {
      const raw = await runPowershellJson<RawProc>(SNAPSHOT_PS);
      const now = Date.now();
      const elapsedMs = prevStamp.current > 0 ? Math.max(1, now - prevStamp.current) : 0;
      const nextPrev = new Map<number, number>();
      const withCpu: ProcEntry[] = raw.map((r) => {
        nextPrev.set(r.Pid, r.CpuTimeMs);
        let cpu = 0;
        const prior = prevCpu.current.get(r.Pid);
        if (elapsedMs > 0 && prior != null) {
          cpu = ((r.CpuTimeMs - prior) / (elapsedMs * cores.current)) * 100;
          cpu = Math.min(100, Math.max(0, cpu));
        }
        return { ...r, CpuPercent: cpu };
      });
      prevCpu.current = nextPrev;
      prevStamp.current = now;
      setEntries(withCpu);
      setError(null);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, [native]);

  // Elevation probe (read-only) + prime the CPU sampler, once.
  useEffect(() => {
    if (!native) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await runPowershell(
          "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        );
        if (alive) setElevated(res.stdout.trim().toLowerCase() === 'true');
      } catch {
        if (alive) setElevated(null);
      }
      // First sample primes the delta table (CPU shows on the second tick).
      await sample();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // Auto-refresh loop.
  useEffect(() => {
    if (!native || !auto) return;
    const id = window.setInterval(() => void sample(), Math.max(1, intervalSec) * 1000);
    return () => window.clearInterval(id);
  }, [native, auto, intervalSec, sample]);

  const filterQ = filter.trim().toLowerCase();
  const filtering = filterQ.length > 0;

  const matches = useCallback(
    (e: ProcEntry) =>
      e.Name.toLowerCase().includes(filterQ) ||
      String(e.Pid).includes(filterQ) ||
      (e.CommandLine ?? '').toLowerCase().includes(filterQ) ||
      (e.Owner ?? '').toLowerCase().includes(filterQ),
    [filterQ],
  );

  // Summary totals.
  const totals = useMemo(() => {
    const cpu = entries.reduce((s, e) => s + e.CpuPercent, 0);
    const mem = entries.reduce((s, e) => s + e.WorkingSetBytes, 0);
    return { count: entries.length, cpu: Math.round(Math.min(100, Math.max(0, cpu))), mem };
  }, [entries]);

  // Build the flattened row list: a parent→child tree, or a flat sorted match list when filtering.
  const flatRows = useMemo(() => {
    const byName = (a: ProcEntry, b: ProcEntry) =>
      a.Name.localeCompare(b.Name, undefined, { sensitivity: 'base' });

    if (filtering) {
      return entries
        .filter(matches)
        .sort(byName)
        .map((entry) => ({ entry, children: [] as TreeNode[], depth: 0 }) as TreeNode);
    }

    const byPid = new Map<number, ProcEntry>();
    entries.forEach((e) => byPid.set(e.Pid, e));
    const childrenOf = new Map<number, ProcEntry[]>();
    const roots: ProcEntry[] = [];
    for (const e of entries) {
      const isRoot = e.ParentPid === 0 || e.ParentPid === e.Pid || !byPid.has(e.ParentPid);
      if (isRoot) {
        roots.push(e);
      } else {
        const l = childrenOf.get(e.ParentPid);
        if (l) l.push(e);
        else childrenOf.set(e.ParentPid, [e]);
      }
    }
    roots.sort(byName);
    childrenOf.forEach((l) => l.sort(byName));

    const out: TreeNode[] = [];
    const visit = (e: ProcEntry, depth: number, seen: Set<number>) => {
      if (seen.has(e.Pid)) return;
      seen.add(e.Pid);
      const kids = childrenOf.get(e.Pid) ?? [];
      out.push({ entry: e, children: kids.map((k) => ({ entry: k, children: [], depth: depth + 1 })), depth });
      if (!collapsed.has(e.Pid)) {
        for (const k of kids) visit(k, depth + 1, seen);
      }
    };
    const seen = new Set<number>();
    for (const r of roots) visit(r, 0, seen);
    return out;
  }, [entries, filtering, matches, collapsed]);

  const selEntry = useMemo(
    () => (selected == null ? null : (entries.find((e) => e.Pid === selected) ?? null)),
    [entries, selected],
  );

  const childCount = useCallback(
    (pid: number) => entries.filter((e) => e.ParentPid === pid && e.Pid !== pid).length,
    [entries],
  );

  // ---- Actions (all click-gated) ----
  const doKill = async (pid: number, name: string) => {
    setBusy(pid);
    setMsg(null);
    try {
      const res = await runPowershell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('procexp.ended', { name, pid }));
      await sample();
    } catch (e) {
      setMsg(t('procexp.endFailed', { name, pid, err: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const doKillTree = async (root: ProcEntry) => {
    setConfirmTree(null);
    setBusy(root.Pid);
    setMsg(null);
    // Collect descendants (children first) from the current snapshot.
    const childrenOf = new Map<number, number[]>();
    for (const e of entries) {
      if (e.ParentPid === e.Pid) continue;
      const l = childrenOf.get(e.ParentPid);
      if (l) l.push(e.Pid);
      else childrenOf.set(e.ParentPid, [e.Pid]);
    }
    const order: number[] = [];
    const seen = new Set<number>();
    const collect = (pid: number) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      for (const k of childrenOf.get(pid) ?? []) collect(k);
      order.push(pid); // leaves before parent
    };
    collect(root.Pid);
    try {
      const list = order.join(',');
      const res = await runPowershell(
        `$k=0; foreach($id in @(${list})){ try{ Stop-Process -Id $id -Force -ErrorAction Stop; $k++ }catch{} }; $k`,
      );
      const killed = parseInt(res.stdout.trim(), 10) || 0;
      setMsg(t('procexp.endedTree', { count: killed }));
      await sample();
    } catch (e) {
      setMsg(t('procexp.endFailed', { name: root.Name, pid: root.Pid, err: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const doPriority = async (pid: number, name: string, cls: PriorityClass) => {
    setPrioFor(null);
    setBusy(pid);
    setMsg(null);
    try {
      const res = await runPowershell(
        `(Get-Process -Id ${pid} -ErrorAction Stop).PriorityClass=[System.Diagnostics.ProcessPriorityClass]::${cls}; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('procexp.prioritySet', { name, cls: t(`procexp.prio_${cls}`) }));
      await sample();
    } catch (e) {
      setMsg(t('procexp.priorityFailed', { name, err: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const doOpenLocation = async (e: ProcEntry) => {
    if (!e.ExecutablePath) {
      setMsg(t('procexp.noLocation'));
      return;
    }
    setMsg(null);
    try {
      await runCommand('explorer.exe', ['/select,', e.ExecutablePath]);
      setMsg(t('procexp.openedLocation', { name: e.Name }));
    } catch (err) {
      setMsg(t('procexp.noLocation'));
      void err;
    }
  };

  const doCopy = async (text: string, label: string) => {
    setCopyFor(null);
    setMsg(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (native) {
        await runPowershell(`Set-Clipboard -Value @'\n${text.replace(/'/g, "''")}\n'@`);
      }
      setMsg(t('procexp.copied', { label }));
    } catch {
      setMsg(t('procexp.copyFailed'));
    }
  };

  const priorityLabel = (raw: string): string => {
    const cls = PRIORITY_CLASSES.find((c) => c === raw);
    return cls ? t(`procexp.prio_${cls}`) : raw || '—';
  };

  if (!native) {
    return (
      <div className="mod">
        <p className="count-note">{t('procexp.blurb')}</p>
        <p className="mod-msg">{t('procexp.desktopOnly')}</p>
      </div>
    );
  }

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('procexp.blurb')}
      </p>

      {/* Summary cards */}
      <div className="pe-cards">
        <div className="pe-card">
          <span className="pe-card-label">{t('procexp.sumProcesses')}</span>
          <span className="pe-card-value">{totals.count || '—'}</span>
        </div>
        <div className="pe-card">
          <span className="pe-card-label">{t('procexp.sumCpu')}</span>
          <span className="pe-card-value">{entries.length ? `${totals.cpu}%` : '—'}</span>
        </div>
        <div className="pe-card">
          <span className="pe-card-label">{t('procexp.sumMemory')}</span>
          <span className="pe-card-value">{entries.length ? fmtBytes(totals.mem) : '—'}</span>
        </div>
      </div>

      {/* Toolbar */}
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('procexp.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="pe-auto">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t('procexp.autoRefresh')}
        </label>
        <select
          className="mod-select"
          value={intervalSec}
          onChange={(e) => setIntervalSec(Number(e.target.value))}
          disabled={!auto}
          title={t('procexp.interval')}
        >
          {INTERVALS.map((s) => (
            <option key={s} value={s}>
              {t('procexp.everySeconds', { s })}
            </option>
          ))}
        </select>
        <button className="mini" onClick={() => void sample()}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('procexp.procCount', { count: flatRows.length })}</span>
      </ModuleToolbar>

      {/* Selected-process action bar */}
      <div className="pe-actionbar">
        <span className="pe-sel-name">
          {selEntry ? `${selEntry.Name} · PID ${selEntry.Pid}` : t('procexp.noSelection')}
        </span>
        <span className="row-actions" style={{ position: 'relative' }}>
          <button className="mini" disabled={!selEntry} onClick={() => selEntry && setDetail(selEntry)}>
            {t('procexp.details')}
          </button>
          <button className="mini" disabled={!selEntry} onClick={() => selEntry && void doOpenLocation(selEntry)}>
            {t('procexp.openLocation')}
          </button>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              className="mini"
              disabled={!selEntry}
              onClick={() => setCopyFor(copyFor === selEntry?.Pid ? null : (selEntry?.Pid ?? null))}
            >
              {t('procexp.copy')} ▾
            </button>
            {selEntry && copyFor === selEntry.Pid && (
              <span className="pe-menu">
                <button className="pe-menu-item" onClick={() => void doCopy(String(selEntry.Pid), t('procexp.copyPidLabel'))}>
                  {t('procexp.copyPid', { pid: selEntry.Pid })}
                </button>
                <button
                  className="pe-menu-item"
                  disabled={!selEntry.ExecutablePath}
                  onClick={() => void doCopy(selEntry.ExecutablePath, t('procexp.copyPathLabel'))}
                >
                  {t('procexp.copyPath')}
                </button>
                <button
                  className="pe-menu-item"
                  disabled={!selEntry.CommandLine}
                  onClick={() => void doCopy(selEntry.CommandLine, t('procexp.copyCmdLabel'))}
                >
                  {t('procexp.copyCmd')}
                </button>
              </span>
            )}
          </span>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              className="mini"
              disabled={!selEntry || busy === selEntry?.Pid}
              onClick={() => setPrioFor(prioFor === selEntry?.Pid ? null : (selEntry?.Pid ?? null))}
            >
              {t('procexp.priority')} ▾
            </button>
            {selEntry && prioFor === selEntry.Pid && (
              <span className="pe-menu">
                {PRIORITY_CLASSES.map((cls) => (
                  <button
                    key={cls}
                    className="pe-menu-item"
                    onClick={() => void doPriority(selEntry.Pid, selEntry.Name, cls)}
                  >
                    {t(`procexp.prio_${cls}`)}
                  </button>
                ))}
              </span>
            )}
          </span>
          <button
            className="mini danger"
            disabled={!selEntry || busy === selEntry?.Pid}
            onClick={() => selEntry && void doKill(selEntry.Pid, selEntry.Name)}
          >
            {t('procexp.endProcess')}
          </button>
          <button
            className="mini danger"
            disabled={!selEntry || busy === selEntry?.Pid}
            onClick={() => selEntry && setConfirmTree(selEntry)}
          >
            {t('procexp.endTree')}
          </button>
        </span>
      </div>

      {elevated === false && <p className="mod-msg">{t('procexp.elevationNote')}</p>}
      {msg && <p className="mod-msg">{msg}</p>}

      {error ? (
        <pre className="cmd-out error">{error}</pre>
      ) : loading && entries.length === 0 ? (
        <p className="count-note">{t('modules.loading')}</p>
      ) : flatRows.length === 0 ? (
        <p className="count-note">{t('modules.noRows')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt pe-table">
            <thead>
              <tr>
                <th>{t('procexp.colProcess')}</th>
                <th style={{ width: 72, textAlign: 'right' }}>{t('procexp.colPid')}</th>
                <th style={{ width: 68, textAlign: 'right' }}>{t('procexp.colCpu')}</th>
                <th style={{ width: 104, textAlign: 'right' }}>{t('procexp.colMem')}</th>
                <th style={{ width: 56, textAlign: 'right' }}>{t('procexp.colThreads')}</th>
                <th style={{ width: 160 }}>{t('procexp.colUser')}</th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map((node) => {
                const e = node.entry;
                const kids = filtering ? 0 : childCount(e.Pid);
                const isCollapsed = collapsed.has(e.Pid);
                return (
                  <tr
                    key={e.Pid}
                    className={selected === e.Pid ? 'pe-selected' : undefined}
                    onClick={() => setSelected(e.Pid)}
                  >
                    <td>
                      <span className="pe-namecell" style={{ paddingLeft: node.depth * 16 }}>
                        {!filtering && kids > 0 ? (
                          <button
                            className="pe-twisty"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setCollapsed((prev) => {
                                const next = new Set(prev);
                                if (next.has(e.Pid)) next.delete(e.Pid);
                                else next.add(e.Pid);
                                return next;
                              });
                            }}
                            aria-label={isCollapsed ? t('procexp.expand') : t('procexp.collapse')}
                          >
                            {isCollapsed ? '▸' : '▾'}
                          </button>
                        ) : (
                          <span className="pe-twisty pe-twisty-empty" />
                        )}
                        <span className="pe-name">{e.Name}</span>
                        {e.Description && <span className="pe-desc">{e.Description}</span>}
                        {kids > 0 && <span className="pe-kidcount">({kids})</span>}
                      </span>
                    </td>
                    <td className="pe-mono" style={{ textAlign: 'right' }}>
                      {e.Pid}
                    </td>
                    <td className="pe-mono" style={{ textAlign: 'right' }}>
                      {e.CpuPercent >= 0.05 ? `${Math.round(e.CpuPercent)}%` : '—'}
                    </td>
                    <td className="pe-mono" style={{ textAlign: 'right' }}>
                      {fmtBytes(e.WorkingSetBytes)}
                    </td>
                    <td className="pe-mono" style={{ textAlign: 'right' }}>
                      {e.ThreadCount > 0 ? e.ThreadCount : '—'}
                    </td>
                    <td className="pe-user">{e.Owner || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Details modal */}
      {detail && (
        <div className="pe-backdrop" onClick={() => setDetail(null)}>
          <div className="pe-dialog" onClick={(ev) => ev.stopPropagation()}>
            <div className="pe-dialog-head">
              <strong>{t('procexp.detailsTitle', { name: detail.Name })}</strong>
              <button className="mini" onClick={() => setDetail(null)}>
                {t('procexp.close')}
              </button>
            </div>
            <div className="pe-detail-grid">
              <DetailRow label={t('procexp.dName')} value={detail.Name} />
              <DetailRow label={t('procexp.dDescription')} value={detail.Description} />
              <DetailRow label={t('procexp.dPid')} value={String(detail.Pid)} />
              <DetailRow label={t('procexp.dParent')} value={String(detail.ParentPid)} />
              <DetailRow label={t('procexp.dOwner')} value={detail.Owner} />
              <DetailRow label={t('procexp.dCpu')} value={`${Math.round(detail.CpuPercent * 10) / 10}%`} />
              <DetailRow label={t('procexp.dWorkingSet')} value={fmtBytes(detail.WorkingSetBytes)} />
              <DetailRow label={t('procexp.dPrivate')} value={fmtBytes(detail.PrivateBytes)} />
              <DetailRow label={t('procexp.dThreads')} value={String(detail.ThreadCount)} />
              <DetailRow
                label={t('procexp.dModules')}
                value={detail.ModuleCount > 0 ? String(detail.ModuleCount) : '—'}
              />
              <DetailRow label={t('procexp.dPriority')} value={priorityLabel(detail.Priority)} />
              <DetailRow label={t('procexp.dStartTime')} value={detail.StartTime} />
              <DetailRow label={t('procexp.dExecutable')} value={detail.ExecutablePath} />
              <DetailRow label={t('procexp.dCommandLine')} value={detail.CommandLine} />
              {elevated === false && (
                <DetailRow label={t('procexp.dNote')} value={t('procexp.accessDenied')} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* End-tree confirm */}
      {confirmTree && (
        <div className="pe-backdrop" onClick={() => setConfirmTree(null)}>
          <div className="pe-dialog pe-confirm" onClick={(ev) => ev.stopPropagation()}>
            <strong>{t('procexp.endTree')}</strong>
            <p>
              {t('procexp.endTreeConfirm', {
                name: confirmTree.Name,
                pid: confirmTree.Pid,
                count: childCount(confirmTree.Pid),
              })}
            </p>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="mini" onClick={() => setConfirmTree(null)}>
                {t('procexp.cancel')}
              </button>
              <button className="mini danger" onClick={() => void doKillTree(confirmTree)}>
                {t('procexp.endTree')}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .pe-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
        .pe-card { display: flex; flex-direction: column; gap: 2px; padding: 10px 16px;
          background: var(--bg-card); border: 1px solid var(--stroke-subtle); border-radius: var(--radius); }
        .pe-card-label { font-size: 12px; color: var(--text-tertiary); }
        .pe-card-value { font-size: 22px; font-weight: 700; color: var(--text); }
        .pe-auto { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
          color: var(--text-secondary); white-space: nowrap; }
        .pe-actionbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          flex-wrap: wrap; margin-bottom: 10px; }
        .pe-sel-name { font-size: 12.5px; color: var(--text-secondary); font-family: Consolas, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pe-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 40; display: flex;
          flex-direction: column; min-width: 180px; padding: 4px; gap: 2px; background: var(--bg-elevated);
          border: 1px solid var(--stroke); border-radius: var(--radius);
          box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
        .pe-menu-item { text-align: left; padding: 6px 10px; border: none; background: transparent;
          color: var(--text); font-size: 12.5px; font-family: inherit; border-radius: 4px; cursor: pointer; }
        .pe-menu-item:hover:not(:disabled) { background: var(--bg-card-hover); }
        .pe-menu-item:disabled { opacity: 0.4; cursor: default; }
        .pe-table tbody tr { cursor: pointer; }
        .pe-table tr.pe-selected td { background: color-mix(in srgb, var(--accent) 18%, transparent); }
        .pe-namecell { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
        .pe-twisty { width: 16px; height: 16px; line-height: 1; padding: 0; border: none;
          background: transparent; color: var(--text-tertiary); cursor: pointer; font-size: 10px; flex: none; }
        .pe-twisty-empty { cursor: default; }
        .pe-name { font-weight: 600; }
        .pe-desc { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; max-width: 34ch; }
        .pe-kidcount { font-size: 11px; color: var(--text-tertiary); }
        .pe-mono { font-family: Consolas, monospace; font-size: 12px; color: var(--text-secondary); }
        .pe-user { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; max-width: 160px; }
        .pe-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex;
          align-items: center; justify-content: center; z-index: 60; }
        .pe-dialog { width: 90%; max-width: 620px; max-height: 80vh; overflow: auto; padding: 16px;
          background: var(--bg-card); border: 1px solid var(--stroke); border-radius: var(--radius);
          box-shadow: 0 16px 48px rgba(0,0,0,0.5); }
        .pe-dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 12px;
          margin-bottom: 12px; }
        .pe-detail-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; }
        .pe-detail-label { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
        .pe-detail-value { font-size: 12.5px; font-family: Consolas, monospace; color: var(--text);
          word-break: break-word; }
        .pe-confirm { max-width: 460px; display: flex; flex-direction: column; gap: 10px; }
        .pe-confirm p { margin: 0; font-size: 13px; color: var(--text-secondary); }
      `}</style>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="pe-detail-label">{label}</span>
      <span className="pe-detail-value">{value && value.trim() ? value : '—'}</span>
    </>
  );
}
