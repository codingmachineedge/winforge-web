import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, useAsync } from './common';

// ============================================================================
// Workspaces (module.workspaces) — native port of WinForge's WorkspacesModule,
// itself a clone of PowerToys Workspaces.
//   • Capture the visible top-level app windows of the current desktop (exe
//     path, command-line args, title, bounds, monitor, min/max state) via an
//     EnumWindows P/Invoke helper run through the desktop PowerShell backend.
//   • Save named workspaces as JSON in localStorage; edit each app (enable/
//     disable, tweak X/Y/W/H, window state, remove), rename, delete (two-step
//     confirm), re-capture.
//   • Launch (explicit click only): start every enabled app, wait for its new
//     window, then move/resize/restore it to the saved bounds — the same
//     Start-Process + SetWindowPos flow as the C# WorkspacesService.
//   • Import/Export JSON — understands this module's exports, the desktop
//     WinForge PascalCase export, and PowerToys' workspaces.json; the PowerToys
//     file is auto-detected (read-only) so its layouts can be imported.
// ============================================================================

interface WsApp {
  exePath: string;
  args: string;
  title: string;
  processName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  monitor: number;
  state: string; // 'normal' | 'maximized' | 'minimized'
  enabled: boolean;
  displayName: string;
}

interface Workspace {
  id: string;
  name: string;
  createdMs: number;
  lastLaunchedMs: number; // 0 = never launched
  apps: WsApp[];
}

interface CapRow {
  exePath: string;
  args: string;
  title: string;
  processName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  monitor: number;
  state: string;
}

interface LaunchRow {
  name: string;
  launched: boolean;
  positioned: boolean;
  error: string;
}

// ---------------------------------------------------------------- storage

const STORE_KEY = 'winforge.workspaces.list';

function loadAll(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is Workspace =>
        !!w && typeof w === 'object' && typeof (w as Workspace).id === 'string' && Array.isArray((w as Workspace).apps),
    );
  } catch {
    return [];
  }
}

function saveAll(list: Workspace[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* localStorage unavailable — keep in-memory only */
  }
}

function newId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function leaf(path: string): string {
  const parts = path.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : path;
}

function defaultName(list: Workspace[], base: string): string {
  const names = new Set(list.map((w) => w.name.toLowerCase()));
  let n = list.length + 1;
  let candidate = `${base} ${n}`;
  while (names.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${base} ${n}`;
  }
  return candidate;
}

// ---------------------------------------------------------------- normalizers (import: web / desktop C# / PowerToys)

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function num(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : d;
}

/** Timestamps: .NET ticks (desktop export), unix ms (web) or unix seconds (PowerToys). */
function toMs(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return d;
  if (n > 1e16) return Math.round((n - 621355968000000000) / 10000); // .NET ticks
  if (n > 1e11) return Math.round(n); // already ms
  if (n > 1e8) return Math.round(n * 1000); // seconds
  return d;
}

function normState(raw: Record<string, unknown>): string {
  const s = (str(raw.state) || str(raw.State)).toLowerCase();
  if (s === 'maximized' || s === 'minimized' || s === 'normal') return s;
  if (raw.maximized === true || raw['is-maximized'] === true) return 'maximized';
  if (raw.minimized === true || raw['is-minimized'] === true) return 'minimized';
  return 'normal';
}

function normApp(raw: unknown): WsApp | null {
  if (!isRecord(raw)) return null;
  const exe = str(raw.exePath) || str(raw.ExePath) || str(raw['application-path']) || str(raw.applicationPath);
  if (!exe) return null;
  const pos = isRecord(raw.position) ? raw.position : null;
  const w = Math.max(1, num(raw.w ?? raw.W ?? pos?.width ?? pos?.Width, 800));
  const h = Math.max(1, num(raw.h ?? raw.H ?? pos?.height ?? pos?.Height, 600));
  return {
    exePath: exe,
    args: str(raw.args) || str(raw.Args) || str(raw['command-line-arguments']),
    title: str(raw.title) || str(raw.Title),
    processName: str(raw.processName) || str(raw.ProcessName) || leaf(exe).replace(/\.exe$/i, ''),
    x: num(raw.x ?? raw.X ?? pos?.X ?? pos?.x, 0),
    y: num(raw.y ?? raw.Y ?? pos?.Y ?? pos?.y, 0),
    w,
    h,
    monitor: num(raw.monitor ?? raw.Monitor, 0),
    state: normState(raw),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : typeof raw.Enabled === 'boolean' ? raw.Enabled : true,
    displayName: str(raw.displayName) || str(raw.DisplayName) || str(raw.application) || leaf(exe),
  };
}

function normWorkspace(raw: unknown): Workspace | null {
  if (!isRecord(raw)) return null;
  const appsRaw = Array.isArray(raw.apps)
    ? raw.apps
    : Array.isArray(raw.Apps)
      ? raw.Apps
      : Array.isArray(raw.applications)
        ? raw.applications
        : null;
  if (!appsRaw) return null;
  const apps: WsApp[] = [];
  for (const a of appsRaw) {
    const n = normApp(a);
    if (n) apps.push(n);
  }
  return {
    id: newId(),
    name: str(raw.name) || str(raw.Name),
    createdMs: toMs(raw['creation-time'] ?? raw.CreatedTicks ?? raw.createdMs, Date.now()),
    lastLaunchedMs: toMs(raw['last-launched-time'] ?? raw.LastLaunchedTicks ?? raw.lastLaunchedMs, 0),
    apps,
  };
}

/** Accepts: one workspace, an array of workspaces, or a PowerToys/desktop document wrapper. */
function normalizeAny(parsed: unknown): Workspace[] {
  if (Array.isArray(parsed)) {
    const out: Workspace[] = [];
    for (const item of parsed) {
      const w = normWorkspace(item);
      if (w) out.push(w);
    }
    return out;
  }
  if (isRecord(parsed)) {
    const arr = Array.isArray(parsed.workspaces) ? parsed.workspaces : Array.isArray(parsed.projects) ? parsed.projects : null;
    if (arr) {
      const out: Workspace[] = [];
      for (const item of arr) {
        const w = normWorkspace(item);
        if (w) out.push(w);
      }
      return out;
    }
    const single = normWorkspace(parsed);
    return single ? [single] : [];
  }
  return [];
}

// ---------------------------------------------------------------- PowerShell (Windows PowerShell 5.1 compatible)

const esc = (s: string) => s.replace(/'/g, "''");

// Win32 helper — same EnumWindows / GetWindowPlacement / SetWindowPos flow as
// the C# WorkspacesService (capture, find-windows-of-exe, arrange).
const PINVOKE = `Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class WfWs{
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint c);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h,ref WP wp);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a,bool b,uint p);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h,int f,StringBuilder b,ref int s);
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L;public int T;public int R;public int B;}
 [StructLayout(LayoutKind.Sequential)] public struct PT{public int X;public int Y;}
 [StructLayout(LayoutKind.Sequential)] public struct WP{public int len;public int flags;public int cmd;public PT p1;public PT p2;public RECT rc;}
 public class Row{ public uint Pid; public string Title; public string Exe; public int X; public int Y; public int W; public int H; public string State; }
 public static string ExeOf(uint pid){
  IntPtr hp=OpenProcess(0x1000,false,pid);
  if(hp==IntPtr.Zero) return "";
  try{ int c=1024; StringBuilder sb=new StringBuilder(c); if(QueryFullProcessImageName(hp,0,sb,ref c)) return sb.ToString(); }
  catch{} finally{ CloseHandle(hp); }
  return "";
 }
 public static List<Row> Snap(){
  List<Row> list=new List<Row>();
  EnumWindows(delegate(IntPtr h,IntPtr l){
   try{
    if(!IsWindowVisible(h)) return true;
    if(GetWindow(h,4)!=IntPtr.Zero) return true;
    if((GetWindowLong(h,-20) & 0x80)!=0) return true;
    int len=GetWindowTextLength(h); if(len==0) return true;
    StringBuilder sb=new StringBuilder(len+1); GetWindowText(h,sb,sb.Capacity);
    string t=sb.ToString(); if(t.Trim().Length==0) return true;
    uint pid; GetWindowThreadProcessId(h,out pid); if(pid==0) return true;
    string exe=ExeOf(pid); if(exe.Length==0) return true;
    WP wp=new WP(); wp.len=Marshal.SizeOf(typeof(WP));
    string st="normal";
    if(GetWindowPlacement(h,ref wp)){ if(wp.cmd==2) st="minimized"; else if(wp.cmd==3) st="maximized"; }
    int x;int y;int w;int hh;
    RECT r;
    if(st=="normal" && GetWindowRect(h,out r)){ x=r.L;y=r.T;w=r.R-r.L;hh=r.B-r.T; }
    else{ x=wp.rc.L;y=wp.rc.T;w=wp.rc.R-wp.rc.L;hh=wp.rc.B-wp.rc.T; }
    if(w<=0||hh<=0) return true;
    Row row=new Row(); row.Pid=pid; row.Title=t; row.Exe=exe; row.X=x; row.Y=y; row.W=w; row.H=hh; row.State=st;
    list.Add(row);
   }catch{}
   return true;
  },IntPtr.Zero);
  return list;
 }
 public static List<long> WinsOfLeaf(string leaf){
  List<long> outp=new List<long>();
  EnumWindows(delegate(IntPtr h,IntPtr l){
   try{
    if(GetWindow(h,4)!=IntPtr.Zero) return true;
    uint pid; GetWindowThreadProcessId(h,out pid); if(pid==0) return true;
    string e=ExeOf(pid); if(e.Length==0) return true;
    string lf=System.IO.Path.GetFileName(e);
    if(string.Equals(lf,leaf,StringComparison.OrdinalIgnoreCase)) outp.Add(h.ToInt64());
   }catch{}
   return true;
  },IntPtr.Zero);
  return outp;
 }
 public static bool Vis(long h){ IntPtr p=new IntPtr(h); return IsWindowVisible(p) && GetWindowTextLength(p)>0; }
 public static bool Arrange(long hl,int x,int y,int w,int h,string st){
  IntPtr hh=new IntPtr(hl);
  try{
   int cw=Math.Max(w,100); int ch=Math.Max(h,100);
   if(st=="maximized"){ ShowWindow(hh,9); SetWindowPos(hh,IntPtr.Zero,x,y,cw,ch,0x0014); ShowWindow(hh,3); }
   else if(st=="minimized"){ SetWindowPos(hh,IntPtr.Zero,x,y,cw,ch,0x0014); ShowWindow(hh,6); }
   else{ ShowWindow(hh,9); SetWindowPos(hh,IntPtr.Zero,x,y,cw,ch,0x0054); }
   return true;
  }catch{ return false; }
 }
}
'@ -ErrorAction SilentlyContinue;`;

// Capture — enumerate visible top-level windows, resolve exe + args + monitor,
// skip shell surfaces (same filter list as the C# IsShellProcess).
const CAPTURE_SCRIPT = `${PINVOKE}
Add-Type -AssemblyName System.Windows.Forms;
$mons=@([System.Windows.Forms.Screen]::AllScreens);
$cl=@{};
try{ Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $cl[$_.ProcessId]=$_.CommandLine } }catch{}
$skip=@('applicationframehost','shellexperiencehost','searchhost','searchapp','startmenuexperiencehost','textinputhost','systemsettings','lockapp','peopleexperiencehost','widgetboard','widgets','dwm','msedgewebview2');
[WfWs]::Snap() | ForEach-Object {
 $exe=$_.Exe;
 $leafn='';
 try{ $leafn=[System.IO.Path]::GetFileNameWithoutExtension($exe).ToLower() }catch{ return }
 if($skip -contains $leafn){ return }
 if($leafn -like 'winforge*'){ return }
 if($leafn -eq 'explorer' -and $_.Title -eq 'Program Manager'){ return }
 $aa='';
 $c=$cl[$_.Pid];
 if($c){
  $c=$c.Trim();
  if($c.StartsWith('"')){ $e2=$c.IndexOf('"',1); if($e2 -gt 0){ $aa=$c.Substring($e2+1).Trim() } }
  else{ $sp=$c.IndexOf(' '); if($sp -gt 0){ $aa=$c.Substring($sp+1).Trim() } }
 }
 $cx=$_.X+[int]($_.W/2); $cy=$_.Y+[int]($_.H/2); $mi=0;
 for($i=0;$i -lt $mons.Count;$i++){
  $b=$mons[$i].Bounds;
  if($cx -ge $b.Left -and $cx -lt $b.Right -and $cy -ge $b.Top -and $cy -lt $b.Bottom){ $mi=$i; break }
 }
 [pscustomobject]@{ exePath=$exe; args=$aa; title=$_.Title; processName=$leafn; x=$_.X; y=$_.Y; w=$_.W; h=$_.H; monitor=$mi; state=$_.State }
}`;

// Launch — Start-Process each enabled app, poll for its new window (~5s),
// then move/resize/restore it to the saved bounds. Emits one result row per app.
function launchScript(apps: WsApp[]): string {
  const items = apps
    .map(
      (a) =>
        `@{n='${esc(a.displayName || a.processName || leaf(a.exePath))}';e='${esc(a.exePath)}';a='${esc(a.args)}';x=${a.x | 0};y=${a.y | 0};w=${Math.max(1, a.w | 0)};h=${Math.max(1, a.h | 0)};st='${esc(a.state)}'}`,
    )
    .join(',');
  return `${PINVOKE}
$apps=@(${items});
foreach($ap in $apps){
 if(-not (Test-Path -LiteralPath $ap.e)){ [pscustomobject]@{name=$ap.n;launched=$false;positioned=$false;error='missing'}; continue }
 $leafn=[System.IO.Path]::GetFileName($ap.e);
 $before=@([WfWs]::WinsOfLeaf($leafn));
 try{
  $dir=[System.IO.Path]::GetDirectoryName($ap.e); if([string]::IsNullOrEmpty($dir)){ $dir=$env:USERPROFILE }
  if($ap.a){ Start-Process -FilePath $ap.e -ArgumentList $ap.a -WorkingDirectory $dir }
  else{ Start-Process -FilePath $ap.e -WorkingDirectory $dir }
 }catch{ [pscustomobject]@{name=$ap.n;launched=$false;positioned=$false;error=$_.Exception.Message}; continue }
 $hw=[long]0;
 for($i=0;$i -lt 25 -and $hw -eq 0;$i++){
  Start-Sleep -Milliseconds 200;
  foreach($cand in @([WfWs]::WinsOfLeaf($leafn))){ if(($before -notcontains $cand) -and [WfWs]::Vis($cand)){ $hw=$cand; break } }
 }
 if($hw -eq 0){ foreach($cand in @([WfWs]::WinsOfLeaf($leafn))){ if([WfWs]::Vis($cand)){ $hw=$cand; break } } }
 $pos=$false;
 if($hw -ne 0){ $pos=[WfWs]::Arrange($hw,$ap.x,$ap.y,$ap.w,$ap.h,$ap.st) }
 [pscustomobject]@{name=$ap.n;launched=$true;positioned=[bool]$pos;error=''}
}`;
}

// PowerToys Workspaces file probe (read-only).
const PT_PROBE = `$p=Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\Workspaces\\workspaces.json';
if(Test-Path -LiteralPath $p){ Get-Content -Raw -LiteralPath $p -Encoding UTF8 }`;

// ---------------------------------------------------------------- component

interface AppRow {
  app: WsApp;
  idx: number;
}

const numStyle: CSSProperties = {
  width: 58,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--stroke)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  fontSize: 12,
  fontFamily: 'inherit',
};

const selStyle: CSSProperties = { ...numStyle, width: 110 };

export function WorkspacesModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [list, setList] = useState<Workspace[]>(() => loadAll());
  const [selId, setSelId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState<'' | 'capture' | 'launch' | 'recapture'>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showIO, setShowIO] = useState(false);
  const [ioText, setIoText] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  // Detect the PowerToys workspaces.json (read-only probe; desktop backend only).
  const pt = useAsync<Workspace[] | null>(async () => {
    if (!isTauri()) return null;
    const res = await runPowershell(PT_PROBE);
    const text = res.stdout.trim();
    if (!text) return null;
    try {
      const found = normalizeAny(JSON.parse(text));
      return found.length > 0 ? found : null;
    } catch {
      return null;
    }
  }, []);

  const sel = list.find((w) => w.id === selId) ?? null;

  const persist = (next: Workspace[]) => {
    setList(next);
    saveAll(next);
  };
  const patchWs = (id: string, fn: (w: Workspace) => Workspace) =>
    persist(list.map((w) => (w.id === id ? fn(w) : w)));

  const selectWs = (id: string) => {
    setSelId(id);
    setConfirmDel(false);
    setRenaming(false);
  };

  const subtitle = (w: Workspace): string => {
    const apps = t('workspaces.appsCount', { n: w.apps.length });
    if (w.lastLaunchedMs > 0)
      return `${apps} · ${t('workspaces.launchedAt', { when: new Date(w.lastLaunchedMs).toLocaleString() })}`;
    return apps;
  };

  const rowToApp = (r: CapRow): WsApp => ({
    exePath: str(r.exePath),
    args: str(r.args),
    title: str(r.title),
    processName: str(r.processName),
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(1, num(r.w, 800)),
    h: Math.max(1, num(r.h, 600)),
    monitor: num(r.monitor, 0),
    state: r.state === 'maximized' || r.state === 'minimized' ? r.state : 'normal',
    enabled: true,
    displayName: leaf(str(r.exePath)),
  });

  // ---- capture / re-capture (explicit click; runs the EnumWindows snapshot)
  const doCapture = async (existingId?: string) => {
    setBusy(existingId ? 'recapture' : 'capture');
    setErr(null);
    setMsg(null);
    try {
      const rows = await runPowershellJson<CapRow>(CAPTURE_SCRIPT);
      const apps = rows.filter((r) => str(r.exePath)).map(rowToApp);
      if (existingId) {
        patchWs(existingId, (w) => ({ ...w, apps }));
        setMsg(t('workspaces.recaptured', { n: apps.length }));
      } else {
        const name = nameDraft.trim() || defaultName(list, t('workspaces.defaultName'));
        const ws: Workspace = { id: newId(), name, createdMs: Date.now(), lastLaunchedMs: 0, apps };
        persist([...list, ws]);
        setSelId(ws.id);
        setNameDraft('');
        setMsg(t('workspaces.captured', { name, n: apps.length }));
      }
    } catch (e) {
      setErr(`${t('workspaces.captureFailed')}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy('');
    }
  };

  // ---- launch (explicit click; starts apps + restores window positions)
  const runLaunch = async (ws: Workspace, apps: WsApp[]) => {
    setBusy('launch');
    setErr(null);
    setMsg(null);
    try {
      const rows = await runPowershellJson<LaunchRow>(launchScript(apps));
      const launched = rows.filter((r) => r.launched).length;
      const positioned = rows.filter((r) => r.positioned).length;
      const errors = rows
        .filter((r) => r.error)
        .map((r) => `${r.name}: ${r.error === 'missing' ? t('workspaces.missingExe') : r.error}`);
      patchWs(ws.id, (w) => ({ ...w, lastLaunchedMs: Date.now() }));
      setMsg(
        t('workspaces.launchDone', { launched, positioned }) +
          (errors.length > 0 ? ` · ${errors.slice(0, 4).join(' · ')}` : ''),
      );
    } catch (e) {
      setErr(`${t('workspaces.launchFailed')}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy('');
    }
  };

  const doLaunch = () => {
    if (!sel) return;
    const enabled = sel.apps.filter((a) => a.enabled);
    if (enabled.length === 0) {
      setMsg(t('workspaces.nothingToLaunch'));
      return;
    }
    void runLaunch(sel, enabled);
  };

  const doLaunchOne = (app: WsApp) => {
    if (!sel) return;
    void runLaunch(sel, [app]);
  };

  const doReveal = (app: WsApp) => {
    void runCommand('explorer.exe', [`/select,${app.exePath}`]).catch(() => undefined);
  };

  // ---- rename / delete
  const startRename = () => {
    if (!sel) return;
    setRenameDraft(sel.name);
    setRenaming(true);
  };
  const commitRename = () => {
    if (!sel) return;
    const name = renameDraft.trim();
    setRenaming(false);
    if (!name) return;
    patchWs(sel.id, (w) => ({ ...w, name }));
  };
  const doDelete = () => {
    if (!sel) return;
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    const name = sel.name;
    persist(list.filter((w) => w.id !== sel.id));
    setSelId(null);
    setConfirmDel(false);
    setMsg(t('workspaces.deleted', { name }));
  };

  // ---- per-app edits
  const patchApp = (idx: number, patch: Partial<WsApp>) => {
    if (!sel) return;
    patchWs(sel.id, (w) => ({ ...w, apps: w.apps.map((a, i) => (i === idx ? { ...a, ...patch } : a)) }));
  };
  const removeApp = (idx: number) => {
    if (!sel) return;
    patchWs(sel.id, (w) => ({ ...w, apps: w.apps.filter((_, i) => i !== idx) }));
  };

  // ---- import / export
  const doExport = () => {
    if (!sel) return;
    const json = JSON.stringify(sel, null, 2);
    setIoText(json);
    setShowIO(true);
    try {
      void navigator.clipboard?.writeText(json)?.catch(() => undefined);
    } catch {
      /* clipboard may be blocked — JSON stays in the textarea */
    }
    setMsg(t('workspaces.exported'));
  };

  const doImport = () => {
    setErr(null);
    setMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(ioText);
    } catch {
      setErr(t('workspaces.importBad'));
      return;
    }
    const found = normalizeAny(parsed).map((w) => ({
      ...w,
      id: newId(),
      name: w.name || defaultName(list, t('workspaces.defaultName')),
    }));
    if (found.length === 0) {
      setErr(t('workspaces.importBad'));
      return;
    }
    persist([...list, ...found]);
    const first = found[0];
    if (found.length === 1 && first) {
      setSelId(first.id);
      setMsg(t('workspaces.importOk', { name: first.name, n: first.apps.length }));
    } else {
      setMsg(t('workspaces.importedMany', { n: found.length }));
    }
  };

  const importPt = (w: Workspace) => {
    const ws: Workspace = { ...w, id: newId(), name: w.name || defaultName(list, t('workspaces.defaultName')) };
    persist([...list, ws]);
    setSelId(ws.id);
    setMsg(t('workspaces.importOk', { name: ws.name, n: ws.apps.length }));
  };
  const importPtAll = () => {
    const found = pt.data ?? [];
    if (found.length === 0) return;
    persist([...list, ...found.map((w) => ({ ...w, id: newId() }))]);
    setMsg(t('workspaces.importedMany', { n: found.length }));
  };

  const refreshAll = () => {
    setList(loadAll());
    pt.reload();
    setMsg(null);
    setErr(null);
  };

  // ---- app table columns
  const appRows: AppRow[] = sel ? sel.apps.map((app, idx) => ({ app, idx })) : [];
  const enabledCount = sel ? sel.apps.filter((a) => a.enabled).length : 0;

  const appCols: Column<AppRow>[] = [
    {
      key: 'on',
      header: t('workspaces.colOn'),
      width: 46,
      render: (r) => (
        <input
          type="checkbox"
          checked={r.app.enabled}
          onChange={(e) => patchApp(r.idx, { enabled: e.target.checked })}
        />
      ),
    },
    {
      key: 'app',
      header: t('workspaces.colApp'),
      render: (r) => (
        <div style={{ minWidth: 180 }}>
          <div style={{ fontWeight: 600 }}>{r.app.displayName || r.app.processName}</div>
          {r.app.title && (
            <div className="count-note" style={{ margin: 0 }}>
              {r.app.title}
            </div>
          )}
          <div className="env-val">{r.app.exePath}</div>
          {r.app.args && (
            <div className="env-val">
              {t('workspaces.argsLabel')} {r.app.args}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'x',
      header: 'X',
      width: 70,
      render: (r) => (
        <input
          type="number"
          style={numStyle}
          key={`x${r.idx}:${r.app.x}`}
          defaultValue={r.app.x}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) patchApp(r.idx, { x: Math.round(v) });
          }}
        />
      ),
    },
    {
      key: 'y',
      header: 'Y',
      width: 70,
      render: (r) => (
        <input
          type="number"
          style={numStyle}
          key={`y${r.idx}:${r.app.y}`}
          defaultValue={r.app.y}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) patchApp(r.idx, { y: Math.round(v) });
          }}
        />
      ),
    },
    {
      key: 'w',
      header: 'W',
      width: 70,
      render: (r) => (
        <input
          type="number"
          style={numStyle}
          key={`w${r.idx}:${r.app.w}`}
          defaultValue={r.app.w}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) patchApp(r.idx, { w: Math.max(1, Math.round(v)) });
          }}
        />
      ),
    },
    {
      key: 'h',
      header: 'H',
      width: 70,
      render: (r) => (
        <input
          type="number"
          style={numStyle}
          key={`h${r.idx}:${r.app.h}`}
          defaultValue={r.app.h}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) patchApp(r.idx, { h: Math.max(1, Math.round(v)) });
          }}
        />
      ),
    },
    {
      key: 'state',
      header: t('workspaces.colState'),
      width: 120,
      render: (r) => (
        <select style={selStyle} value={r.app.state} onChange={(e) => patchApp(r.idx, { state: e.target.value })}>
          <option value="normal">{t('workspaces.stateNormal')}</option>
          <option value="maximized">{t('workspaces.stateMaximized')}</option>
          <option value="minimized">{t('workspaces.stateMinimized')}</option>
        </select>
      ),
    },
    { key: 'monitor', header: t('workspaces.colMon'), width: 50, render: (r) => <span>{r.app.monitor}</span> },
    {
      key: 'actions',
      header: '',
      width: 210,
      render: (r) => (
        <span className="row-actions">
          <button
            className="mini"
            disabled={!desktop || busy !== ''}
            title={t('workspaces.startOneTip')}
            onClick={() => doLaunchOne(r.app)}
          >
            {t('workspaces.startOne')}
          </button>
          <button className="mini" disabled={!desktop} title={t('workspaces.revealTip')} onClick={() => doReveal(r.app)}>
            {t('workspaces.reveal')}
          </button>
          <button className="mini danger" title={t('workspaces.removeTip')} onClick={() => removeApp(r.idx)}>
            {t('workspaces.remove')}
          </button>
        </span>
      ),
    },
  ];

  const ptData = pt.data ?? [];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('workspaces.blurb')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('workspaces.desktopNote')}
        </p>
      )}

      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ maxWidth: 260 }}
          placeholder={t('workspaces.namePh')}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && busy === '' && doCapture()}
        />
        <button className="mini primary" disabled={!desktop || busy !== ''} onClick={() => doCapture()}>
          {busy === 'capture' ? t('workspaces.capturing') : t('workspaces.capture')}
        </button>
        <button className="mini" onClick={() => setShowIO((v) => !v)}>
          {t('workspaces.importExport')}
        </button>
        <button className="mini" onClick={refreshAll}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('workspaces.wsCount', { n: list.length })}</span>
      </ModuleToolbar>

      {msg && <p className="mod-msg">{msg}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}

      {ptData.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <p className="count-note" style={{ margin: '0 0 8px' }}>
            {t('workspaces.ptFound', { n: ptData.length })}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ptData.map((w, i) => (
              <button key={`pt${i}`} className="mini" title={t('workspaces.ptImport')} onClick={() => importPt(w)}>
                + {w.name || `PowerToys ${i + 1}`} · {t('workspaces.appsCount', { n: w.apps.length })}
              </button>
            ))}
            {ptData.length > 1 && (
              <button className="mini primary" onClick={importPtAll}>
                {t('workspaces.ptImportAll')}
              </button>
            )}
          </div>
        </div>
      )}

      {showIO && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <p className="count-note" style={{ margin: '0 0 8px' }}>
            {t('workspaces.ioHint')}
          </p>
          <textarea
            className="hosts-edit"
            style={{ minHeight: 160 }}
            spellCheck={false}
            value={ioText}
            onChange={(e) => setIoText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="mini primary" onClick={doImport}>
              {t('workspaces.importBtn')}
            </button>
            <button className="mini" disabled={!sel} onClick={doExport}>
              {t('workspaces.exportBtn')}
            </button>
            <button className="mini" onClick={() => setShowIO(false)}>
              {t('workspaces.close')}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* workspace list */}
        <div className="panel" style={{ flex: '0 0 260px', minWidth: 220, padding: 0, overflow: 'hidden' }}>
          {list.length === 0 ? (
            <p className="count-note" style={{ padding: 12, margin: 0 }}>
              {t('workspaces.empty')}
            </p>
          ) : (
            list.map((w) => (
              <button
                key={w.id}
                onClick={() => selectWs(w.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '9px 12px',
                  background: selId === w.id ? 'var(--bg-card-hover)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--stroke-subtle)',
                  borderLeft: selId === w.id ? '3px solid var(--accent)' : '3px solid transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 600 }}>{w.name}</div>
                <div className="count-note" style={{ margin: 0 }}>
                  {subtitle(w)}
                </div>
              </button>
            ))
          )}
        </div>

        {/* detail / editor */}
        <div className="panel" style={{ flex: '1 1 420px', minWidth: 320 }}>
          {!sel ? (
            <p className="count-note" style={{ margin: 0 }}>
              {t('workspaces.selectHint')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {renaming ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="mod-search"
                    style={{ maxWidth: 280 }}
                    autoFocus
                    value={renameDraft}
                    placeholder={t('workspaces.renamePh')}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commitRename()}
                  />
                  <button className="mini primary" onClick={commitRename}>
                    {t('workspaces.save')}
                  </button>
                  <button className="mini" onClick={() => setRenaming(false)}>
                    {t('workspaces.cancel')}
                  </button>
                </div>
              ) : (
                <h3 style={{ margin: 0 }}>{sel.name}</h3>
              )}
              <p className="count-note" style={{ margin: 0 }}>
                {t('workspaces.metaLine', { total: sel.apps.length, enabled: enabledCount })}
              </p>
              <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                <button className="mini primary" disabled={!desktop || busy !== ''} onClick={doLaunch}>
                  {busy === 'launch' ? t('workspaces.launching') : t('workspaces.launch')}
                </button>
                <button className="mini" disabled={!desktop || busy !== ''} onClick={() => doCapture(sel.id)}>
                  {busy === 'recapture' ? t('workspaces.recapturing') : t('workspaces.recapture')}
                </button>
                <button className="mini" onClick={startRename}>
                  {t('workspaces.rename')}
                </button>
                <button className="mini" onClick={doExport}>
                  {t('workspaces.exportBtn')}
                </button>
                <button className="mini danger" title={t('workspaces.delNote')} onClick={doDelete}>
                  {confirmDel ? t('workspaces.confirmDel') : t('workspaces.del')}
                </button>
              </div>
              {busy === 'launch' && <p className="mod-msg">{t('workspaces.launchingNote')}</p>}
              <DataTable
                columns={appCols}
                rows={appRows}
                rowKey={(r) => `${sel.id}:${r.idx}`}
                empty={t('workspaces.noApps')}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
