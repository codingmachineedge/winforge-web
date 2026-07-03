import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar } from './common';

/** One process holding a handle on the target, as reported by the Windows Restart Manager. */
interface LockProc {
  Name: string;
  Pid: number;
  User: string;
  Path: string;
  AppType: string;
  Started: string;
  Restricted: boolean;
  Files: string[];
  FileCount: number;
}

interface ScanResult {
  Processes: LockProc[];
  FilesScanned: number;
  NeedsElevationHint: boolean;
  IsElevated: boolean;
  Error: string;
}

// PowerShell that reproduces FileLocksmithService.cs: it enumerates the target (bounded folder
// walk to 4000 files), registers the resources with the Windows Restart Manager (rstrtmgr.dll)
// via inline P/Invoke, then reports every locking process with name, PID, user, image path,
// app-type and start time — exactly what the WinForge native module surfaces. Read-only.
function scanScript(rawPath: string): string {
  const path = rawPath.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$target = '${path}'
$sig = @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class WFLock {
  const int CCH_RM_SESSION_KEY = 32;
  const int CCH_RM_MAX_APP_NAME = 255;
  const int CCH_RM_MAX_SVC_NAME = 63;
  const int ERROR_MORE_DATA = 234;
  const uint RmRebootReasonNone = 0;
  const int MaxFiles = 4000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint TOKEN_QUERY = 0x0008;

  enum RM_APP_TYPE { RmUnknownApp=0, RmMainWindow=1, RmOtherWindow=2, RmService=3, RmExplorer=4, RmConsole=5, RmCritical=1000 }

  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public uint dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_APP_NAME+1)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_SVC_NAME+1)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In,Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint a, [MarshalAs(UnmanagedType.Bool)] bool b, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryFullProcessImageName(IntPtr h, uint f, StringBuilder n, ref int sz);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr info, int len, out int outLen);

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_USER { public SID_AND_ATTRIBUTES User; }

  public static bool IsElevated() {
    try { using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator); }
    catch { return false; }
  }

  static IEnumerable<string> Walk(string root, int cap) {
    var q = new Queue<string>(); q.Enqueue(root); int n = 0;
    while (q.Count > 0) {
      var dir = q.Dequeue(); string[] fs;
      try { fs = Directory.GetFiles(dir); } catch { fs = new string[0]; }
      foreach (var f in fs) { yield return f; if (++n >= cap) yield break; }
      string[] ds; try { ds = Directory.GetDirectories(dir); } catch { ds = new string[0]; }
      foreach (var d in ds) q.Enqueue(d);
    }
  }

  static string QueryImagePath(int pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
    if (h == IntPtr.Zero) return "";
    try { int cap = 1024; var sb = new StringBuilder(cap); return QueryFullProcessImageName(h, 0, sb, ref cap) ? sb.ToString() : ""; }
    finally { CloseHandle(h); }
  }

  static string QueryUser(int pid, ref bool restricted) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
    if (h == IntPtr.Zero) { restricted = true; return ""; }
    try {
      IntPtr tok;
      if (!OpenProcessToken(h, TOKEN_QUERY, out tok)) { restricted = true; return ""; }
      try {
        int len; GetTokenInformation(tok, 1, IntPtr.Zero, 0, out len);
        if (len <= 0) { restricted = true; return ""; }
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
          int outLen;
          if (!GetTokenInformation(tok, 1, buf, len, out outLen)) { restricted = true; return ""; }
          var tu = (TOKEN_USER)Marshal.PtrToStructure(buf, typeof(TOKEN_USER));
          var sid = new SecurityIdentifier(tu.User.Sid);
          try { return ((NTAccount)sid.Translate(typeof(NTAccount))).Value; } catch { return sid.Value; }
        } finally { Marshal.FreeHGlobal(buf); }
      } finally { CloseHandle(tok); }
    } catch { restricted = true; return ""; }
    finally { CloseHandle(h); }
  }

  static string DescribeType(RM_APP_TYPE t) {
    switch (t) {
      case RM_APP_TYPE.RmMainWindow: return "App (window)";
      case RM_APP_TYPE.RmOtherWindow: return "App";
      case RM_APP_TYPE.RmService: return "Service";
      case RM_APP_TYPE.RmExplorer: return "Explorer";
      case RM_APP_TYPE.RmConsole: return "Console";
      case RM_APP_TYPE.RmCritical: return "Critical system";
      default: return "Unknown";
    }
  }

  public class Row {
    public string Name; public int Pid; public string User; public string Path;
    public string AppType; public string Started; public bool Restricted;
    public List<string> Files = new List<string>(); public int FileCount;
  }
  public class Result {
    public List<Row> Processes = new List<Row>();
    public int FilesScanned; public bool NeedsElevationHint; public bool IsElevated; public string Error = "";
  }

  public static Result Scan(string path) {
    var res = new Result(); res.IsElevated = IsElevated();
    path = (path ?? "").Trim().Trim('"');
    if (path.Length == 0) { res.Error = "No path given."; return res; }
    bool isDir; try { isDir = Directory.Exists(path); } catch { isDir = false; }
    if (!isDir && !File.Exists(path)) { res.Error = "Path not found: " + path; return res; }

    var files = new List<string>(); var dirs = new List<string>();
    if (isDir) { dirs.Add(path); try { foreach (var f in Walk(path, MaxFiles)) { files.Add(f); if (files.Count >= MaxFiles) break; } } catch {} }
    else files.Add(path);
    res.FilesScanned = files.Count;

    var resources = new List<string>(); resources.AddRange(files); resources.AddRange(dirs);

    uint session; var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
    int rc = RmStartSession(out session, 0, key);
    if (rc != 0) { res.Error = "Restart Manager could not start a session (error " + rc + ")."; return res; }
    try {
      if (resources.Count > 0) {
        rc = RmRegisterResources(session, (uint)resources.Count, resources.ToArray(), 0, IntPtr.Zero, 0, null);
        if (rc != 0) { res.Error = "Restart Manager could not register the file(s) (error " + rc + ")."; return res; }
      }
      uint needed = 0, count = 0, reasons = RmRebootReasonNone;
      RM_PROCESS_INFO[] info = new RM_PROCESS_INFO[0];
      rc = RmGetList(session, out needed, ref count, null, ref reasons);
      if (rc == ERROR_MORE_DATA && needed > 0) {
        count = needed + 8; info = new RM_PROCESS_INFO[count]; reasons = RmRebootReasonNone;
        rc = RmGetList(session, out needed, ref count, info, ref reasons);
      } else if (rc == 0) { return res; }
      if (rc != 0) { res.Error = "Restart Manager could not list processes (error " + rc + ")."; return res; }

      bool needsElev = false;
      var all = new List<string>(); all.AddRange(files); all.AddRange(dirs);
      for (uint i = 0; i < count; i++) {
        var pi = info[i]; int pid = (int)pi.Process.dwProcessId; if (pid == 0) continue;
        string name = pi.strAppName ?? ""; string exePath = ""; string user = ""; string started = ""; bool restricted = false;
        try { using (var p = Process.GetProcessById(pid)) {
          if (name.Length == 0) name = p.ProcessName;
          try { started = p.StartTime.ToString("yyyy-MM-dd HH:mm:ss"); } catch { restricted = true; }
          try { exePath = QueryImagePath(pid); } catch { restricted = true; }
        } } catch {}
        user = QueryUser(pid, ref restricted);
        if (restricted) needsElev = true;
        var row = new Row();
        row.Name = name.Length == 0 ? ("PID " + pid) : name;
        row.Pid = pid; row.User = user; row.Path = exePath;
        row.AppType = DescribeType(pi.ApplicationType); row.Started = started; row.Restricted = restricted;
        row.Files = all; row.FileCount = all.Count;
        res.Processes.Add(row);
      }
      res.NeedsElevationHint = needsElev && !res.IsElevated;
      res.Processes.Sort(delegate(Row a, Row b) {
        int c = b.FileCount.CompareTo(a.FileCount);
        return c != 0 ? c : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
      });
      return res;
    } finally { try { RmEndSession(session); } catch {} }
  }
}
"@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Security.Principal.Windows | Out-Null
$r = [WFLock]::Scan($target)
$r | ConvertTo-Json -Depth 5 -Compress
`;
}

export function FileLocksmithModule() {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [scanned, setScanned] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [filesFor, setFilesFor] = useState<LockProc | null>(null);

  const doScan = useCallback(
    async (target: string) => {
      const p = target.trim().replace(/^"|"$/g, '');
      if (!p) {
        setMsg({ kind: 'warn', text: t('filelocksmith.needPath') });
        return;
      }
      if (!isTauri()) {
        setScanned(p);
        setResult(null);
        setError(t('filelocksmith.browserNote'));
        return;
      }
      setLoading(true);
      setError(null);
      setMsg(null);
      setScanned(p);
      try {
        const res = await runPowershell(scanScript(p));
        const text = res.stdout.trim();
        if (!text) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        const parsed = JSON.parse(text) as Partial<ScanResult>;
        const norm: ScanResult = {
          Processes: (parsed.Processes ?? []).map((x) => ({
            Name: x.Name ?? '',
            Pid: x.Pid ?? 0,
            User: x.User ?? '',
            Path: x.Path ?? '',
            AppType: x.AppType ?? '',
            Started: x.Started ?? '',
            Restricted: !!x.Restricted,
            Files: Array.isArray(x.Files) ? x.Files : x.Files ? [String(x.Files)] : [],
            FileCount: x.FileCount ?? 0,
          })),
          FilesScanned: parsed.FilesScanned ?? 0,
          NeedsElevationHint: !!parsed.NeedsElevationHint,
          IsElevated: !!parsed.IsElevated,
          Error: parsed.Error ?? '',
        };
        setResult(norm);
      } catch (e) {
        setResult(null);
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const rows = result?.Processes ?? [];
  const scanError = result?.Error ?? '';

  const endTask = async (r: LockProc) => {
    if (r.Pid <= 4) {
      setMsg({ kind: 'warn', text: t('filelocksmith.coreProcess') });
      return;
    }
    const ok = window.confirm(t('filelocksmith.confirmEnd', { name: r.Name, pid: r.Pid }));
    if (!ok) return;
    setBusyPid(r.Pid);
    setMsg(null);
    try {
      const res = await runPowershell(
        `try { Stop-Process -Id ${r.Pid} -Force -ErrorAction Stop; 'ok' } catch { if ($_.CategoryInfo.Category -eq 'PermissionDenied') { 'denied' } else { 'gone' } }`,
      );
      const out = res.stdout.trim();
      if (out === 'ok' || out === 'gone') {
        setMsg({ kind: 'ok', text: t('filelocksmith.ended', { name: r.Name, pid: r.Pid }) });
      } else if (out === 'denied') {
        setMsg({ kind: 'warn', text: t('filelocksmith.denied') });
      } else if (!res.success) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      } else {
        setMsg({ kind: 'ok', text: t('filelocksmith.ended', { name: r.Name, pid: r.Pid }) });
      }
      if (scanned) await doScan(scanned);
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('filelocksmith.endFailed', { name: r.Name })}: ${String(e)}` });
    } finally {
      setBusyPid(null);
    }
  };

  const openLocation = async (r: LockProc) => {
    const target = r.Path || r.Files[0] || '';
    if (!target) {
      setMsg({ kind: 'warn', text: t('filelocksmith.noLocation') });
      return;
    }
    if (!isTauri()) return;
    try {
      // Prefer /select on a real file; otherwise open the containing folder.
      const args = /\.[^\\/.]+$/.test(target) ? ['/select,', target] : [target];
      await runCommand('explorer.exe', args);
    } catch {
      setMsg({ kind: 'warn', text: t('filelocksmith.openFailed') });
    }
  };

  const columns: Column<LockProc>[] = useMemo(
    () => [
      {
        key: 'Name',
        header: t('filelocksmith.colProcess'),
        render: (r) => (
          <div className="fl-proc">
            <span className="fl-name">{r.Name}</span>
            <span className="fl-sub">{r.AppType}</span>
            {r.Path ? (
              <span className="fl-path" title={r.Path}>
                {r.Path}
              </span>
            ) : r.Restricted ? (
              <span className="fl-sub">{t('filelocksmith.needsAdminPath')}</span>
            ) : null}
            {r.Started ? (
              <span className="fl-sub">{t('filelocksmith.started', { when: r.Started })}</span>
            ) : null}
          </div>
        ),
      },
      { key: 'Pid', header: t('filelocksmith.colPid'), width: 70, align: 'right' },
      {
        key: 'User',
        header: t('filelocksmith.colUser'),
        width: 170,
        render: (r) => r.User || t('filelocksmith.unknownUser'),
      },
      {
        key: 'FileCount',
        header: t('filelocksmith.colFiles'),
        width: 70,
        align: 'right',
        render: (r) => String(r.FileCount),
      },
      {
        key: 'actions',
        header: t('filelocksmith.colActions'),
        width: 250,
        render: (r) => (
          <span className="row-actions">
            <button className="mini" onClick={() => setFilesFor(r)}>
              {t('filelocksmith.showFiles')}
            </button>
            <button className="mini" onClick={() => openLocation(r)}>
              {t('filelocksmith.openLocation')}
            </button>
            <button
              className="mini danger"
              disabled={busyPid === r.Pid}
              onClick={() => endTask(r)}
            >
              {t('filelocksmith.endTask')}
            </button>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, busyPid, scanned],
  );

  const countText = result
    ? scanError
      ? ''
      : rows.length === 0
        ? t('filelocksmith.nothingLocking', { files: result.FilesScanned })
        : t('filelocksmith.someLocking', { procs: rows.length, files: result.FilesScanned })
    : '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('filelocksmith.blurb')}
      </p>

      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('filelocksmith.pathPlaceholder')}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doScan(path);
          }}
        />
        <button className="mini primary" disabled={loading} onClick={() => doScan(path)}>
          {loading ? t('filelocksmith.scanning') : t('filelocksmith.scan')}
        </button>
        <button className="mini" disabled={loading || !scanned} onClick={() => scanned && doScan(scanned)}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {countText && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {countText}
        </p>
      )}

      {result && (result.NeedsElevationHint || (!result.IsElevated && !scanError)) && (
        <p className="mod-msg" style={{ marginTop: 0 }}>
          {result.NeedsElevationHint
            ? t('filelocksmith.needsElevationDetails')
            : t('filelocksmith.elevationTip')}
        </p>
      )}

      {msg && (
        <p className={`mod-msg${msg.kind === 'err' ? ' error' : ''}`}>{msg.text}</p>
      )}

      {loading && <p className="count-note">{t('filelocksmith.scanning')}</p>}

      {!loading && error && <pre className="cmd-out error">{error}</pre>}

      {!loading && !error && scanError && (
        <pre className="cmd-out error">{scanError}</pre>
      )}

      {!loading && !error && !scanError && result && (
        <>
          {rows.length === 0 ? (
            <p className="count-note">{t('filelocksmith.freeToUse')}</p>
          ) : (
            <DataTable columns={columns} rows={rows} rowKey={(r) => String(r.Pid)} />
          )}
        </>
      )}

      {!loading && !error && !result && !scanned && (
        <p className="count-note">{t('filelocksmith.emptyHint')}</p>
      )}

      <p className="count-note">{t('filelocksmith.footer')}</p>

      {filesFor && (
        <div className="fl-dialog-backdrop" onClick={() => setFilesFor(null)}>
          <div className="hosts-edit fl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="fl-dialog-head">
              <strong>
                {t('filelocksmith.filesTitle', { name: filesFor.Name, n: filesFor.FileCount })}
              </strong>
              <button className="mini" onClick={() => setFilesFor(null)}>
                {t('filelocksmith.close')}
              </button>
            </div>
            <pre className="cmd-out" style={{ maxHeight: 360, overflow: 'auto' }}>
              {filesFor.Files.length === 0
                ? t('filelocksmith.folderLock')
                : filesFor.Files.slice(0, 500).join('\n') +
                  (filesFor.Files.length > 500
                    ? '\n' + t('filelocksmith.andMore', { n: filesFor.Files.length - 500 })
                    : '')}
            </pre>
          </div>
        </div>
      )}

      <style>{`
        .fl-proc { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .fl-name { font-weight: 600; }
        .fl-sub { font-size: 11px; opacity: 0.7; }
        .fl-path { font-size: 11px; font-family: Consolas, monospace; opacity: 0.7;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
        .fl-dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45);
          display: flex; align-items: center; justify-content: center; z-index: 50; }
        .fl-dialog { max-width: 640px; width: 90%; }
        .fl-dialog-head { display: flex; justify-content: space-between; align-items: center;
          gap: 12px; margin-bottom: 8px; }
      `}</style>
    </div>
  );
}
