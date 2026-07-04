import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { findInstall, installPackage, resolveTool } from '../tauri/deps';
import { ModuleToolbar, StatusDot } from './common';

// ============================================================================
//  Komorebi · 平鋪視窗管理 — native React port of WinForge's KomorebiModule.
//  Drives the user-installed `komorebic` CLI: detect/install, control the
//  daemon (start/stop/restart), show the live monitors → workspaces → windows
//  tree from `komorebic state`, switch layouts, navigate workspaces, edit
//  padding, add window rules, edit + reload the komorebi.json / .whkdrc config,
//  toggle autostart, and inspect raw state JSON.
//  Read-only until the operator explicitly presses an action button.
// ============================================================================

const WINGET_ID = 'LGUG2Z.komorebi';

const LAYOUTS: { value: string; en: string; zh: string }[] = [
  { value: 'bsp', en: 'BSP (binary split)', zh: 'BSP（二元分割）' },
  { value: 'columns', en: 'Columns', zh: '直欄' },
  { value: 'rows', en: 'Rows', zh: '橫列' },
  { value: 'vertical-stack', en: 'Vertical stack', zh: '垂直堆疊' },
  { value: 'horizontal-stack', en: 'Horizontal stack', zh: '水平堆疊' },
  { value: 'ultrawide-vertical-stack', en: 'Ultrawide vertical stack', zh: '超寬垂直堆疊' },
  { value: 'grid', en: 'Grid', zh: '網格' },
  { value: 'right-main-vertical-stack', en: 'Right-main vertical stack', zh: '右主垂直堆疊' },
  { value: 'scrolling', en: 'Scrolling', zh: '捲動' },
];

// One komorebic toggle/action op surfaced as a button row. `destructive` gates a
// confirm step. `args` carries fixed sub-arguments (e.g. flip direction).
interface Op {
  verb: string;
  args?: string[];
  en: string;
  zh: string;
  descEn: string;
  descZh: string;
  destructive?: boolean;
}

// Full parity with WinForge's KomorebiOperations catalog (22 verbs).
const OPS: Op[] = [
  // focus-mode toggles
  { verb: 'toggle-tiling', en: 'Toggle tiling', zh: '切換平鋪', descEn: 'Turn automatic tiling on or off on the focused workspace.', descZh: '喺聚焦工作區開／熄自動平鋪。' },
  { verb: 'toggle-float', en: 'Toggle float', zh: '切換浮動', descEn: 'Float or re-manage the currently focused window.', descZh: '將聚焦視窗設為浮動或重新管理。' },
  { verb: 'toggle-monocle', en: 'Toggle monocle', zh: '切換單片', descEn: 'Expand the focused window to fill the workspace (monocle).', descZh: '將聚焦視窗放大填滿工作區（單片模式）。' },
  { verb: 'toggle-pause', en: 'Toggle pause', zh: '切換暫停', descEn: 'Pause or resume komorebi tiling globally.', descZh: '全域暫停或恢復 komorebi 平鋪。', destructive: true },
  // arrangement
  { verb: 'promote', en: 'Promote window', zh: '提升視窗', descEn: 'Promote the focused window to the primary position.', descZh: '將聚焦視窗提升到主要位置。' },
  { verb: 'retile', en: 'Retile', zh: '重新平鋪', descEn: 'Force a re-tile of all managed windows.', descZh: '強制重新平鋪所有受管視窗。' },
  { verb: 'flip-layout', args: ['horizontal'], en: 'Flip layout horizontally', zh: '水平翻轉排版', descEn: 'Flip the focused workspace layout horizontally.', descZh: '將聚焦工作區排版水平翻轉。' },
  { verb: 'flip-layout', args: ['vertical'], en: 'Flip layout vertically', zh: '垂直翻轉排版', descEn: 'Flip the focused workspace layout vertically.', descZh: '將聚焦工作區排版垂直翻轉。' },
  // monitor / workspace focus cycling
  { verb: 'cycle-monitor', args: ['next'], en: 'Focus next monitor', zh: '聚焦下一個顯示器', descEn: 'Move focus to the next monitor.', descZh: '將焦點移去下一個顯示器。' },
  { verb: 'cycle-monitor', args: ['previous'], en: 'Focus previous monitor', zh: '聚焦上一個顯示器', descEn: 'Move focus to the previous monitor.', descZh: '將焦點移去上一個顯示器。' },
  { verb: 'cycle-workspace', args: ['next'], en: 'Focus next workspace', zh: '聚焦下一個工作區', descEn: 'Cycle focus to the next workspace.', descZh: '聚焦去下一個工作區。' },
  { verb: 'cycle-workspace', args: ['previous'], en: 'Focus previous workspace', zh: '聚焦上一個工作區', descEn: 'Cycle focus to the previous workspace.', descZh: '聚焦去上一個工作區。' },
  // mouse follows focus
  { verb: 'mouse-follows-focus', args: ['enable'], en: 'Mouse follows focus (on)', zh: '滑鼠跟隨聚焦（開）', descEn: 'Move the mouse cursor to the focused window.', descZh: '將滑鼠游標移到聚焦視窗。' },
  { verb: 'mouse-follows-focus', args: ['disable'], en: 'Mouse follows focus (off)', zh: '滑鼠跟隨聚焦（熄）', descEn: 'Stop moving the mouse cursor to the focused window.', descZh: '唔再將滑鼠游標移到聚焦視窗。' },
  // session float rules
  { verb: 'session-float-rule', en: 'Float this window (session)', zh: '浮動此視窗（本次）', descEn: 'Float the focused window for this session only.', descZh: '只喺今次工作階段浮動聚焦視窗。' },
  { verb: 'clear-session-float-rules', en: 'Clear session float rules', zh: '清除本次浮動規則', descEn: 'Remove all session-only float rules.', descZh: '移除所有本次工作階段嘅浮動規則。', destructive: true },
  // config / health
  { verb: 'reload-configuration', en: 'Reload configuration', zh: '重新載入設定', descEn: 'Reload the running komorebi configuration.', descZh: '重新載入執行中嘅 komorebi 設定。' },
  { verb: 'check', en: 'Check configuration', zh: '檢查設定', descEn: "Run komorebic's configuration health check.", descZh: '執行 komorebic 設定健康檢查。' },
  { verb: 'quickstart', en: 'Quickstart (gather examples)', zh: '快速開始（取得範例）', descEn: 'Gather example configuration files for a new-user quickstart.', descZh: '為新用戶收集範例設定檔。' },
  // autostart
  { verb: 'enable-autostart', en: 'Enable autostart', zh: '啟用開機自啟', descEn: 'Create a startup shortcut so komorebi launches at logon.', descZh: '建立啟動捷徑，令 komorebi 喺登入時自動啟動。' },
  { verb: 'enable-autostart', args: ['--bar'], en: 'Enable autostart (with bar)', zh: '啟用開機自啟（連狀態列）', descEn: 'Autostart komorebi together with komorebi-bar at logon.', descZh: '登入時連同 komorebi-bar 一齊自動啟動。' },
  { verb: 'disable-autostart', en: 'Disable autostart', zh: '停用開機自啟', descEn: 'Remove the komorebi startup shortcut.', descZh: '移除 komorebi 啟動捷徑。', destructive: true },
];

interface CliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface KomoWindow {
  title: string;
  exe: string;
}
interface KomoWorkspace {
  index: number;
  name: string;
  layout: string;
  focused: boolean;
  windows: KomoWindow[];
}
interface KomoMonitor {
  index: number;
  name: string;
  focused: boolean;
  workspaces: KomoWorkspace[];
}

// Config-file probe result (both komorebi.json and .whkdrc).
interface ConfigProbe {
  komoPath: string;
  komoExists: boolean;
  komoRaw: string;
  whkdPath: string;
  whkdExists: boolean;
  whkdRaw: string;
}

// Run a raw komorebic command; never throws, always returns a CliResult.
async function komorebic(args: string[]): Promise<CliResult> {
  if (!isTauri()) {
    return { success: false, stdout: '', stderr: 'komorebic bridge unavailable (browser mode)', code: -1 };
  }
  try {
    return await runCommand('komorebic', args);
  } catch (e) {
    return { success: false, stdout: '', stderr: String((e as Error)?.message ?? e), code: -1 };
  }
}

// ----- state JSON parsing (mirrors KomorebiService.Parse) -----
type J = Record<string, unknown>;

function ring(parent: unknown, name: string): { items: J[]; focused: number } {
  const p = parent as J | undefined;
  const r = p?.[name];
  if (Array.isArray(r)) return { items: r as J[], focused: 0 };
  if (r && typeof r === 'object') {
    const ro = r as J;
    const els = ro.elements;
    const focused = typeof ro.focused === 'number' ? (ro.focused as number) : 0;
    if (Array.isArray(els)) return { items: els as J[], focused };
  }
  return { items: [], focused: 0 };
}

function str(el: J | undefined, name: string): string {
  const v = el?.[name];
  return typeof v === 'string' ? v : '';
}

function readLayout(ws: J): string {
  const lay = ws.layout;
  if (typeof lay === 'string') return lay;
  if (lay && typeof lay === 'object') {
    for (const [k, v] of Object.entries(lay as J)) {
      if (typeof v === 'string') return v;
      return k;
    }
  }
  return '';
}

function parseState(json: string): { monitors: KomoMonitor[]; error?: string } {
  let raw = json.trim().replace(/^﻿/, '');
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { monitors: [], error: raw || 'empty state' };
  raw = raw.slice(a, b + 1);
  let root: J;
  try {
    root = JSON.parse(raw) as J;
  } catch (e) {
    return { monitors: [], error: String((e as Error)?.message ?? e) };
  }
  const mons = ring(root, 'monitors');
  const monitors: KomoMonitor[] = mons.items.map((mEl, mi) => {
    const mFocused = mi === mons.focused;
    const wss = ring(mEl, 'workspaces');
    const workspaces: KomoWorkspace[] = wss.items.map((wsEl, wi) => {
      const windows: KomoWindow[] = [];
      const addWin = (winEl: J) => {
        windows.push({ title: str(winEl, 'title'), exe: str(winEl, 'exe') });
      };
      const conts = ring(wsEl, 'containers');
      for (const cEl of conts.items) for (const w of ring(cEl, 'windows').items) addWin(w);
      for (const w of ring(wsEl, 'floating_windows').items) addWin(w);
      const mono = wsEl.monocle_container;
      if (mono && typeof mono === 'object') for (const w of ring(mono, 'windows').items) addWin(w);
      const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      return {
        index: wi,
        name: str(wsEl, 'name') || roman[wi] || String(wi + 1),
        layout: readLayout(wsEl),
        focused: mFocused && wi === wss.focused,
        windows,
      };
    });
    return {
      index: mi,
      name: str(mEl, 'name') || str(mEl, 'device') || `Monitor ${mi}`,
      focused: mFocused,
      workspaces,
    };
  });
  return { monitors };
}

// ----- config-file probe (mirrors KomorebiService.GuessConfigPath) -----
// PowerShell 5.1-compatible. Resolves komorebi.json (KOMOREBI_CONFIG_HOME →
// %USERPROFILE%\.config\komorebi\komorebi.json → %USERPROFILE%\komorebi.json)
// plus the neighbouring .whkdrc, and returns both paths + contents.
async function probeConfig(): Promise<ConfigProbe> {
  const empty: ConfigProbe = {
    komoPath: '',
    komoExists: false,
    komoRaw: '',
    whkdPath: '',
    whkdExists: false,
    whkdRaw: '',
  };
  if (!isTauri()) return empty;
  const script = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$profile = $env:USERPROFILE
$home1 = $env:KOMOREBI_CONFIG_HOME
$cands = New-Object System.Collections.ArrayList
if ($home1) { [void]$cands.Add((Join-Path $home1 'komorebi.json')) }
[void]$cands.Add((Join-Path $profile '.config\\komorebi\\komorebi.json'))
[void]$cands.Add((Join-Path $profile 'komorebi.json'))
$komo = $null
foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { $komo = $c; break } }
if (-not $komo) { $komo = $cands[0] }
$komoExists = Test-Path -LiteralPath $komo
$komoRaw = if ($komoExists) { [IO.File]::ReadAllText($komo) } else { '' }
$whkdCands = New-Object System.Collections.ArrayList
if ($env:WHKD_CONFIG_HOME) { [void]$whkdCands.Add((Join-Path $env:WHKD_CONFIG_HOME '.whkdrc')) }
[void]$whkdCands.Add((Join-Path $profile '.config\\whkdrc'))
[void]$whkdCands.Add((Join-Path $profile '.config\\komorebi\\.whkdrc'))
[void]$whkdCands.Add((Join-Path $profile '.whkdrc'))
$whkd = $null
foreach ($c in $whkdCands) { if (Test-Path -LiteralPath $c) { $whkd = $c; break } }
if (-not $whkd) { $whkd = $whkdCands[0] }
$whkdExists = Test-Path -LiteralPath $whkd
$whkdRaw = if ($whkdExists) { [IO.File]::ReadAllText($whkd) } else { '' }
[pscustomobject]@{
  komoPath = $komo
  komoExists = [bool]$komoExists
  komoRaw = $komoRaw
  whkdPath = $whkd
  whkdExists = [bool]$whkdExists
  whkdRaw = $whkdRaw
} | ConvertTo-Json -Compress -Depth 3
`;
  try {
    const res = await runPowershell(script);
    const text = res.stdout.trim();
    if (!text) return empty;
    const p = JSON.parse(text) as Partial<ConfigProbe>;
    return {
      komoPath: p.komoPath ?? '',
      komoExists: !!p.komoExists,
      komoRaw: p.komoRaw ?? '',
      whkdPath: p.whkdPath ?? '',
      whkdExists: !!p.whkdExists,
      whkdRaw: p.whkdRaw ?? '',
    };
  } catch {
    return empty;
  }
}

// PowerShell single-quote escaper.
function q(s: string): string {
  return s.replace(/'/g, "''");
}

// Write text verbatim to a path (UTF-8, no BOM), creating the parent dir.
async function writeFile(path: string, text: string): Promise<void> {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const res = await runPowershell(
    `$p='${q(path)}'; $d=Split-Path -Parent $p; if(-not (Test-Path -LiteralPath $d)){ New-Item -ItemType Directory -Force -Path $d | Out-Null }; ` +
      `$bytes=[Convert]::FromBase64String('${b64}'); [IO.File]::WriteAllBytes($p, $bytes); 'ok'`,
  );
  if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
}

// Open a file / folder with the shell default handler.
async function shellOpen(path: string): Promise<void> {
  const res = await runPowershell(`Start-Process -FilePath '${q(path)}'; 'ok'`);
  if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
}

async function shellOpenFolder(filePath: string): Promise<void> {
  const res = await runPowershell(
    `$d=Split-Path -Parent '${q(filePath)}'; if (Test-Path -LiteralPath $d) { Start-Process explorer.exe $d } ; 'ok'`,
  );
  if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
}

export function KomorebiModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh') ?? false;
  const P = useCallback((en: string, zhTxt: string) => (zh ? zhTxt : en), [zh]);

  const [installed, setInstalled] = useState<boolean | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [monitors, setMonitors] = useState<KomoMonitor[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rawOut, setRawOut] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  // form state
  const [withBar, setWithBar] = useState(false);
  const [layout, setLayout] = useState('bsp');
  const [wsIndex, setWsIndex] = useState(0);
  const [wsPad, setWsPad] = useState(20);
  const [contPad, setContPad] = useState(20);
  const [ruleKind, setRuleKind] = useState<'workspace' | 'ignore' | 'manage'>('workspace');
  const [ruleId, setRuleId] = useState('exe');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleMon, setRuleMon] = useState(0);
  const [ruleWs, setRuleWs] = useState(0);
  const [opsFilter, setOpsFilter] = useState('');
  const [confirmVerb, setConfirmVerb] = useState<string | null>(null);

  // config editor state
  const [cfg, setCfg] = useState<ConfigProbe | null>(null);
  const [komoBox, setKomoBox] = useState('');
  const [whkdBox, setWhkdBox] = useState('');
  const [confirmSaveKomo, setConfirmSaveKomo] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshTree = useCallback(async () => {
    const r = await komorebic(['state']);
    if (!alive.current) return;
    const parsed = parseState(r.stdout || '');
    setMonitors(parsed.monitors);
    setTreeError(parsed.error ?? null);
  }, []);

  const loadConfig = useCallback(async () => {
    const c = await probeConfig();
    if (!alive.current) return;
    setCfg(c);
    setKomoBox(c.komoRaw);
    setWhkdBox(c.whkdRaw);
  }, []);

  const refresh = useCallback(async () => {
    const ver = await komorebic(['--version']);
    const isInstalled =
      ver.stdout.trim().length > 0 &&
      !/not recognized|not found|cannot find/i.test(ver.stdout + ver.stderr);
    if (!alive.current) return;
    setInstalled(isInstalled);
    if (!isInstalled) {
      setRunning(null);
      setMonitors([]);
      return;
    }
    void loadConfig();
    const st = await komorebic(['state']);
    if (!alive.current) return;
    const isRunning = st.success && st.stdout.trimStart().startsWith('{');
    setRunning(isRunning);
    if (isRunning) await refreshTree();
    else {
      setMonitors([]);
      setTreeError(null);
    }
  }, [refreshTree, loadConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ----- winget install -----
  const install = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setMsg(null);
    try {
      if (!isTauri()) throw new Error(P('Desktop app required to install.', '要用桌面版先可以安裝。'));
      const existing = await resolveTool('komorebic');
      if (existing.source !== 'missing') {
        await refresh();
        return;
      }
      const hit = await findInstall('komorebi', WINGET_ID);
      if (!hit) throw new Error(P('No installer found via winget or Chocolatey.', '喺 winget 或 Chocolatey 搵唔到安裝程式。'));
      const res = await installPackage(hit);
      if (!res.success) throw new Error((res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 400));
      if (alive.current) setMsg({ ok: true, text: P('Komorebi installed.', 'Komorebi 已安裝。') });
      await refresh();
    } catch (e) {
      if (alive.current) setMsg({ ok: false, text: `${P('Failed', '失敗')}: ${String((e as Error)?.message ?? e)}` });
    } finally {
      if (alive.current) setInstalling(false);
    }
  }, [installing, P, refresh]);

  // Run a guarded command: disables controls, shows result, then refreshes.
  const guarded = useCallback(
    async (args: string[], okEn: string, okZh: string) => {
      if (busy) return;
      setBusy(true);
      setMsg(null);
      try {
        const r = await komorebic(args);
        if (r.success) setMsg({ ok: true, text: P(okEn, okZh) });
        else
          setMsg({
            ok: false,
            text: `${P('Failed', '失敗')}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 400)}`,
          });
      } catch (e) {
        setMsg({ ok: false, text: `${P('Error', '錯誤')}: ${String(e)}` });
      } finally {
        if (alive.current) {
          setBusy(false);
          await refresh();
        }
      }
    },
    [busy, P, refresh],
  );

  const start = () => guarded(withBar ? ['start', '--bar'] : ['start'], 'Daemon started.', '守護程序已啟動。');
  const stop = () => guarded(['stop'], 'Daemon stopped, windows restored.', '守護程序已停止，視窗已還原。');
  const restart = () => guarded(['restart'], 'Daemon restarted.', '守護程序已重新啟動。');

  const applyLayout = () => guarded(['change-layout', layout], `Layout set to ${layout}.`, `排版已設為 ${layout}。`);
  const cycleNext = () => guarded(['cycle-layout', 'next'], 'Cycled to next layout.', '已切換到下一個排版。');
  const cyclePrev = () => guarded(['cycle-layout', 'previous'], 'Cycled to previous layout.', '已切換到上一個排版。');

  const focusWs = () => guarded(['focus-workspace', String(wsIndex)], `Focused workspace ${wsIndex}.`, `已聚焦工作區 ${wsIndex}。`);
  const moveWs = () => guarded(['move-to-workspace', String(wsIndex)], `Window moved to workspace ${wsIndex}.`, `視窗已移去工作區 ${wsIndex}。`);
  const sendWs = () => guarded(['send-to-workspace', String(wsIndex)], `Window sent to workspace ${wsIndex}.`, `視窗已送去工作區 ${wsIndex}。`);

  const applyPad = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const a = await komorebic(['focused-workspace-padding', String(wsPad)]);
      const b = await komorebic(['focused-workspace-container-padding', String(contPad)]);
      if (a.success && b.success) setMsg({ ok: true, text: P('Padding applied to focused workspace.', '間距已套用到聚焦工作區。') });
      else
        setMsg({
          ok: false,
          text: `${P('Failed', '失敗')}: ${[a.stderr, b.stderr].filter(Boolean).join(' ').trim().slice(0, 400)}`,
        });
    } finally {
      if (alive.current) {
        setBusy(false);
        await refresh();
      }
    }
  };

  const addRule = () => {
    const val = ruleValue.trim();
    if (!val) {
      setMsg({ ok: false, text: P('Enter an identifier value first (e.g. firefox.exe).', '請先輸入識別碼值（例如 firefox.exe）。') });
      return;
    }
    const args =
      ruleKind === 'ignore'
        ? ['ignore-rule', ruleId, val]
        : ruleKind === 'manage'
          ? ['manage-rule', ruleId, val]
          : ['workspace-rule', ruleId, val, String(ruleMon), String(ruleWs)];
    return guarded(args, `Rule added: ${ruleKind} ${ruleId} ${val}.`, `已加規則：${ruleKind} ${ruleId} ${val}。`);
  };

  const reloadConfig = () => guarded(['reload-configuration'], 'Configuration reloaded.', '設定已重新載入。');
  const quickstart = async () => {
    await guarded(['quickstart'], 'Example configuration gathered.', '已收集範例設定。');
    if (alive.current) await loadConfig();
  };

  // ----- config editor: save + open -----
  const komoDirty = useMemo(() => cfg != null && komoBox !== cfg.komoRaw, [cfg, komoBox]);
  const whkdDirty = useMemo(() => cfg != null && whkdBox !== cfg.whkdRaw, [cfg, whkdBox]);

  const doSaveKomo = useCallback(async () => {
    if (!cfg?.komoPath) return;
    setConfirmSaveKomo(false);
    setBusy(true);
    setMsg(null);
    try {
      await writeFile(cfg.komoPath, komoBox);
      if (running) {
        const r = await komorebic(['reload-configuration']);
        if (!r.success) {
          setMsg({ ok: true, text: P('Saved komorebi.json (reload reported an issue — check output).', '已儲存 komorebi.json（重新載入有問題，請睇輸出）。') });
        } else {
          setMsg({ ok: true, text: P('Saved komorebi.json and reloaded.', '已儲存 komorebi.json 並重新載入。') });
        }
      } else {
        setMsg({ ok: true, text: P('Saved komorebi.json.', '已儲存 komorebi.json。') });
      }
      await loadConfig();
    } catch (e) {
      setMsg({ ok: false, text: `${P('Failed', '失敗')}: ${String((e as Error)?.message ?? e)}` });
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [cfg, komoBox, running, P, loadConfig]);

  const saveWhkd = useCallback(async () => {
    if (!cfg?.whkdPath) return;
    setBusy(true);
    setMsg(null);
    try {
      await writeFile(cfg.whkdPath, whkdBox);
      setMsg({ ok: true, text: P('Saved .whkdrc. Restart whkd for it to take effect.', '已儲存 .whkdrc。重開 whkd 先會生效。') });
      await loadConfig();
    } catch (e) {
      setMsg({ ok: false, text: `${P('Failed', '失敗')}: ${String((e as Error)?.message ?? e)}` });
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [cfg, whkdBox, P, loadConfig]);

  const openInEditor = useCallback(
    async (path: string, exists: boolean) => {
      if (!isTauri()) return;
      if (!exists) {
        setMsg({ ok: false, text: P('No config file exists yet. Use “Create defaults” first.', '暫時未有設定檔。請先用「建立預設」。') });
        return;
      }
      try {
        await shellOpen(path);
      } catch (e) {
        setMsg({ ok: false, text: `${P('Failed', '失敗')}: ${String((e as Error)?.message ?? e)}` });
      }
    },
    [P],
  );

  const openFolder = useCallback(
    async (path: string) => {
      if (!isTauri() || !path) return;
      try {
        await shellOpenFolder(path);
      } catch (e) {
        setMsg({ ok: false, text: `${P('Failed', '失敗')}: ${String((e as Error)?.message ?? e)}` });
      }
    },
    [P],
  );

  const runOp = async (op: Op) => {
    const key = op.verb + (op.args?.join('') ?? '');
    if (opBusy) return;
    setOpBusy(key);
    setMsg(null);
    try {
      const r = await komorebic([op.verb, ...(op.args ?? [])]);
      if (r.success) setMsg({ ok: true, text: `${P('Done', '完成')}: ${P(op.en, op.zh)}` });
      else
        setMsg({
          ok: false,
          text: `${P('Failed', '失敗')}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 400)}`,
        });
    } finally {
      if (alive.current) {
        setOpBusy(null);
        await refreshTree();
      }
    }
  };

  const showRaw = async (args: string[]) => {
    setRawOut(P('Loading…', '載入中…'));
    const r = await komorebic(args);
    if (!alive.current) return;
    const body = (r.stdout || r.stderr || '').trim() || P('(no output)', '（冇輸出）');
    setRawOut(body.length > 12000 ? body.slice(0, 12000) + '\n…' : body);
  };

  const shownOps = useMemo(() => {
    const f = opsFilter.trim().toLowerCase();
    if (!f) return OPS;
    return OPS.filter((o) =>
      `${o.en} ${o.zh} ${o.verb} ${o.args?.join(' ') ?? ''} ${o.descEn} ${o.descZh}`.toLowerCase().includes(f),
    );
  }, [opsFilter]);

  const windowCount = useMemo(
    () => monitors.reduce((n, m) => n + m.workspaces.reduce((k, w) => k + w.windows.length, 0), 0),
    [monitors],
  );

  const controlsDisabled = busy || installed === false;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {P(
          'Drive the Komorebi tiling window manager: install it, start/stop the daemon, switch layouts, navigate workspaces, set gaps, add window rules, edit the komorebi.json / .whkdrc config and reload — all over the komorebic CLI.',
          '操控 Komorebi 平鋪視窗管理：安裝、開／停守護程序、切換排版、切換工作區、設定間距、加視窗規則、編輯 komorebi.json／.whkdrc 設定同重新載入 — 全部經 komorebic CLI。',
        )}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={() => void refresh()} disabled={busy}>
          ⟳ {t('komorebi.refresh')}
        </button>
        {installed !== null && (
          <StatusDot
            ok={running === true}
            label={
              installed === false
                ? P('Not installed', '未安裝')
                : running
                  ? P('Daemon running', '守護程序執行中')
                  : P('Daemon not running', '守護程序未執行')
            }
          />
        )}
        {running && <span className="count-note">{t('komorebi.windowCount', { num: windowCount })}</span>}
      </ModuleToolbar>

      {installed === false && (
        <section className="hosts-edit" style={{ marginTop: 8 }}>
          <h4 style={{ marginTop: 0 }}>{t('komorebi.notFoundTitle')}</h4>
          <p className="count-note" style={{ marginTop: 0 }}>
            {P(
              'Komorebi (komorebic) was not found on PATH. Install it automatically via winget (Chocolatey fallback), then press Refresh.',
              '喺 PATH 搵唔到 Komorebi（komorebic）。用 winget 自動安裝（唔得就 Chocolatey），然後撳重新整理。',
            )}
          </p>
          <div className="row-actions">
            <button className="mini primary" onClick={() => void install()} disabled={installing || !isTauri()}>
              {installing ? t('komorebi.installing') : t('komorebi.install')}
            </button>
          </div>
          {!isTauri() && (
            <p className="count-note" style={{ marginTop: 8 }}>
              {P(
                'Browser preview: install and CLI control run only in the WinForge desktop app. The full UI is shown here for reference.',
                '瀏覽器預覽：安裝同 CLI 操控淨係喺 WinForge 桌面版行到。呢度顯示完整介面畀你參考。',
              )}
            </p>
          )}
        </section>
      )}

      {running === false && installed && (
        <p className="mod-msg">
          {P(
            'Komorebi takes over tiling and may rearrange your windows. Save your work first — you can Stop any time to restore windows.',
            'Komorebi 會接管視窗平鋪，可能會重新排列。請先儲存工作 — 隨時可撳停止還原視窗。',
          )}
        </p>
      )}

      {msg && <p className={`mod-msg ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}

      {/* daemon lifecycle */}
      <section className="hosts-edit" style={{ marginTop: 8 }}>
        <h4 style={{ marginTop: 0 }}>{t('komorebi.lifecycle')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="mini primary" onClick={start} disabled={controlsDisabled || running === true}>
            {t('komorebi.start')}
          </button>
          <button className="mini" onClick={stop} disabled={controlsDisabled || running !== true}>
            {t('komorebi.stop')}
          </button>
          <button className="mini" onClick={restart} disabled={controlsDisabled || running !== true}>
            {t('komorebi.restart')}
          </button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={withBar} onChange={(e) => setWithBar(e.target.checked)} />
            {t('komorebi.withBar')}
          </label>
        </div>
      </section>

      {/* layout switcher */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.layoutHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.layoutHint')}</p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <select value={layout} onChange={(e) => setLayout(e.target.value)} disabled={controlsDisabled}>
            {LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {P(l.en, l.zh)}
              </option>
            ))}
          </select>
          <button className="mini" onClick={applyLayout} disabled={controlsDisabled || running !== true}>
            {t('komorebi.applyLayout')}
          </button>
          <button className="mini" onClick={cyclePrev} disabled={controlsDisabled || running !== true}>
            {t('komorebi.cyclePrev')}
          </button>
          <button className="mini" onClick={cycleNext} disabled={controlsDisabled || running !== true}>
            {t('komorebi.cycleNext')}
          </button>
        </div>
      </section>

      {/* live state tree */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.treeHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.treeHint')}</p>
        {running !== true ? (
          <p className="count-note">{t('komorebi.treeStartHint')}</p>
        ) : treeError ? (
          <pre className="cmd-out error">{t('komorebi.treeError', { detail: treeError.slice(0, 300) })}</pre>
        ) : monitors.length === 0 ? (
          <p className="count-note">{t('komorebi.treeEmpty')}</p>
        ) : (
          <div className="dt-wrap">
            {monitors.map((m) => (
              <div key={m.index} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600 }}>
                  {(m.focused ? '★ ' : '') + P(`Monitor ${m.index}: ${m.name}`, `顯示器 ${m.index}：${m.name}`)}
                </div>
                {m.workspaces.map((w) => (
                  <div key={w.index} style={{ marginLeft: 16 }}>
                    <div style={{ opacity: 0.9 }}>
                      {(w.focused ? '★ ' : '') +
                        P(
                          `Workspace ${w.index} (${w.name})${w.layout ? ' · ' + w.layout : ''} — ${w.windows.length} win`,
                          `工作區 ${w.index}（${w.name}）${w.layout ? ' · ' + w.layout : ''} — ${w.windows.length} 個視窗`,
                        )}
                    </div>
                    {w.windows.map((win, i) => (
                      <div key={i} style={{ marginLeft: 20, fontSize: 12, opacity: 0.75 }}>
                        {(win.title.trim() || win.exe) + (win.exe ? '  ·  ' + win.exe : '')}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* workspace navigation + padding */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.wsHeader')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.wsLabel')}
            <input
              type="number"
              min={0}
              max={20}
              value={wsIndex}
              onChange={(e) => setWsIndex(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <button className="mini" onClick={focusWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.focusWs')}
          </button>
          <button className="mini" onClick={moveWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.moveWs')}
          </button>
          <button className="mini" onClick={sendWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.sendWs')}
          </button>
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.wsPad')}
            <input
              type="number"
              min={0}
              max={200}
              value={wsPad}
              onChange={(e) => setWsPad(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.contPad')}
            <input
              type="number"
              min={0}
              max={200}
              value={contPad}
              onChange={(e) => setContPad(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <button className="mini" onClick={() => void applyPad()} disabled={controlsDisabled || running !== true}>
            {t('komorebi.applyPad')}
          </button>
        </div>
      </section>

      {/* window rules */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.rulesHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.rulesHint')}</p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as typeof ruleKind)} disabled={controlsDisabled}>
            <option value="workspace">{t('komorebi.ruleWorkspace')}</option>
            <option value="ignore">{t('komorebi.ruleIgnore')}</option>
            <option value="manage">{t('komorebi.ruleManage')}</option>
          </select>
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} disabled={controlsDisabled}>
            <option value="exe">exe</option>
            <option value="class">class</option>
            <option value="title">title</option>
            <option value="path">path</option>
          </select>
          <input
            className="mod-search"
            placeholder="firefox.exe"
            value={ruleValue}
            onChange={(e) => setRuleValue(e.target.value)}
            style={{ minWidth: 200 }}
          />
        </div>
        {ruleKind === 'workspace' && (
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('komorebi.ruleMon')}
              <input type="number" min={0} max={20} value={ruleMon} onChange={(e) => setRuleMon(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('komorebi.ruleWs')}
              <input type="number" min={0} max={20} value={ruleWs} onChange={(e) => setRuleWs(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} />
            </label>
          </div>
        )}
        <div className="row-actions" style={{ marginTop: 8 }}>
          <button className="mini" onClick={addRule} disabled={controlsDisabled}>
            {t('komorebi.addRule')}
          </button>
        </div>
      </section>

      {/* configuration editor */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.configHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.configHint')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {cfg
            ? cfg.komoExists
              ? t('komorebi.configFound', { path: cfg.komoPath })
              : t('komorebi.configMissing', { path: cfg.komoPath })
            : t('komorebi.configUnknown')}
        </p>

        {/* komorebi.json editor */}
        <p className="count-note" style={{ marginTop: 8, fontWeight: 600 }}>{t('komorebi.komoLabel')}</p>
        <textarea
          className="mod-search"
          style={{ width: '100%', minHeight: 200, fontFamily: 'Consolas, monospace', fontSize: 13, whiteSpace: 'pre' }}
          value={komoBox}
          onChange={(e) => setKomoBox(e.target.value)}
          spellCheck={false}
          placeholder={cfg?.komoExists ? undefined : '{\n  "default_workspace_padding": 10\n}'}
          disabled={!isTauri()}
        />
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {confirmSaveKomo ? (
            <>
              <span className="count-note" style={{ alignSelf: 'center' }}>{t('komorebi.saveKomoConfirm')}</span>
              <button className="mini primary" onClick={() => void doSaveKomo()} disabled={busy}>
                {t('komorebi.confirm')}
              </button>
              <button className="mini" onClick={() => setConfirmSaveKomo(false)}>
                {t('komorebi.cancel')}
              </button>
            </>
          ) : (
            <button
              className="mini primary"
              onClick={() => setConfirmSaveKomo(true)}
              disabled={controlsDisabled || !cfg?.komoPath || !komoDirty}
            >
              {t('komorebi.saveKomo')}
            </button>
          )}
          <button className="mini" onClick={() => setKomoBox(cfg?.komoRaw ?? '')} disabled={busy || !komoDirty}>
            {t('komorebi.revert')}
          </button>
          <button className="mini" onClick={reloadConfig} disabled={controlsDisabled || running !== true}>
            {t('komorebi.reloadConfig')}
          </button>
          <button className="mini" onClick={() => void openInEditor(cfg?.komoPath ?? '', !!cfg?.komoExists)} disabled={!isTauri()}>
            {t('komorebi.openEditor')}
          </button>
          <button className="mini" onClick={() => void openFolder(cfg?.komoPath ?? '')} disabled={!isTauri() || !cfg?.komoPath}>
            {t('komorebi.openFolder')}
          </button>
          <button className="mini" onClick={() => void quickstart()} disabled={controlsDisabled}>
            {t('komorebi.quickstart')}
          </button>
        </div>

        {/* .whkdrc editor */}
        <p className="count-note" style={{ marginTop: 14, fontWeight: 600 }}>{t('komorebi.whkdLabel')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.whkdHint')}</p>
        <textarea
          className="mod-search"
          style={{ width: '100%', minHeight: 160, fontFamily: 'Consolas, monospace', fontSize: 13, whiteSpace: 'pre' }}
          value={whkdBox}
          onChange={(e) => setWhkdBox(e.target.value)}
          spellCheck={false}
          placeholder={cfg?.whkdExists ? undefined : 'alt + h : komorebic focus left'}
          disabled={!isTauri()}
        />
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button className="mini primary" onClick={() => void saveWhkd()} disabled={controlsDisabled || !cfg?.whkdPath || !whkdDirty}>
            {t('komorebi.saveWhkd')}
          </button>
          <button className="mini" onClick={() => setWhkdBox(cfg?.whkdRaw ?? '')} disabled={busy || !whkdDirty}>
            {t('komorebi.revert')}
          </button>
          <button className="mini" onClick={() => void openInEditor(cfg?.whkdPath ?? '', !!cfg?.whkdExists)} disabled={!isTauri()}>
            {t('komorebi.openEditor')}
          </button>
        </div>
      </section>

      {/* raw inspectors */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.inspectHeader')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="mini" onClick={() => void showRaw(['state'])} disabled={installed === false}>
            {t('komorebi.rawState')}
          </button>
          <button className="mini" onClick={() => void showRaw(['global-state'])} disabled={installed === false}>
            {t('komorebi.globalState')}
          </button>
          <button className="mini" onClick={() => void showRaw(['check'])} disabled={installed === false}>
            {t('komorebi.check')}
          </button>
          {rawOut !== null && (
            <button className="mini" onClick={() => setRawOut(null)}>
              {t('komorebi.clear')}
            </button>
          )}
        </div>
        {rawOut !== null && (
          <pre className="cmd-out" style={{ maxHeight: 260, overflow: 'auto' }}>
            {rawOut}
          </pre>
        )}
      </section>

      {/* operations */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.opsHeader', { num: OPS.length })}</h4>
        <input
          className="mod-search"
          placeholder={t('komorebi.opsFilter')}
          value={opsFilter}
          onChange={(e) => setOpsFilter(e.target.value)}
          style={{ maxWidth: 420, marginBottom: 8 }}
        />
        {shownOps.map((op) => {
          const key = op.verb + (op.args?.join('') ?? '');
          return (
            <div
              key={key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 16,
                padding: '6px 2px',
                borderTop: '1px solid var(--card-stroke, rgba(128,128,128,0.2))',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{P(op.en, op.zh)}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{P(op.descEn, op.descZh)}</div>
              </div>
              {op.destructive && confirmVerb === key ? (
                <span className="row-actions">
                  <button
                    className="mini primary"
                    onClick={() => {
                      setConfirmVerb(null);
                      void runOp(op);
                    }}
                    disabled={installed === false}
                  >
                    {t('komorebi.confirm')}
                  </button>
                  <button className="mini" onClick={() => setConfirmVerb(null)}>
                    {t('komorebi.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  className="mini"
                  onClick={() => (op.destructive ? setConfirmVerb(key) : void runOp(op))}
                  disabled={installed === false || opBusy === key}
                >
                  {opBusy === key ? '…' : t('komorebi.run')}
                </button>
              )}
            </div>
          );
        })}
      </section>

      <p className="count-note">{t('komorebi.hotkeyNote')}</p>
    </div>
  );
}
