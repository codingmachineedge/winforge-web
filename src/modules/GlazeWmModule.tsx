import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot } from './common';

// ============================================================================
//  GlazeWM Tiling · GlazeWM 平鋪視窗
//  Native port of WinForge Pages/GlazeWmModule + Services/GlazeWmService.
//  Detect/install (winget), start/stop/reload the daemon, structured config
//  editing (gaps / focus / startup / workspaces), a keybinding list, a raw-YAML
//  editor, and a grid of glazewm CLI operations. Read-only + safe by default;
//  destructive CLI ops (exit / close) are gated behind an explicit confirm.
// ============================================================================

const WINGET_ID = 'glzr-io.glazewm';
const CLI_DEFAULT = 'C:\\Program Files\\glzr.io\\cli\\glazewm.exe';
const DAEMON_DEFAULT = 'C:\\Program Files\\glzr.io\\glazewm.exe';

// PowerShell-single-quote escape.
const q = (s: string) => s.replace(/'/g, "''");

interface Engine {
  installed: boolean;
  running: boolean;
  version: string;
  configPath: string;
  configExists: boolean;
  raw: string;
  startWithWindows: boolean;
}

interface Binding {
  keys: string;
  commands: string;
}

interface Op {
  id: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  arg: string; // full glazewm arg string, e.g. "command wm-exit" or "query windows"
  destructive?: boolean;
}

// ----- CLI operations (ported from Catalog/GlazeWmOperations.cs) -----
const OPS: Op[] = [
  { id: 'reload', titleEn: 'Reload config', titleZh: '重新載入設定', descEn: 'Re-evaluate config.yaml without restarting the daemon.', descZh: '唔使重啟 daemon 就重新讀取 config.yaml。', arg: 'command wm-reload-config' },
  { id: 'exit', titleEn: 'Exit GlazeWM', titleZh: '退出 GlazeWM', descEn: 'Cleanly stop the WM and restore all managed windows.', descZh: '乾淨咁停止視窗管理員並還原所有受管理嘅視窗。', arg: 'command wm-exit', destructive: true },
  { id: 'redraw', titleEn: 'Redraw windows', titleZh: '重畫視窗', descEn: 'Force a redraw of all managed windows.', descZh: '強制重畫所有受管理嘅視窗。', arg: 'command wm-redraw' },
  { id: 'pause', titleEn: 'Toggle pause', titleZh: '切換暫停', descEn: 'Pause/resume window management and all keybindings.', descZh: '暫停／恢復視窗管理同所有鍵盤綁定。', arg: 'command wm-toggle-pause' },
  { id: 'cycle-focus', titleEn: 'Cycle focus', titleZh: '循環聚焦', descEn: 'Cycle focus between tiling, floating and fullscreen windows.', descZh: '喺平鋪、浮動同全螢幕視窗之間循環聚焦。', arg: 'command wm-cycle-focus' },
  { id: 'focus-left', titleEn: 'Focus left', titleZh: '聚焦左', descEn: 'Shift focus to the window on the left.', descZh: '將焦點移去左邊嘅視窗。', arg: 'command focus --direction left' },
  { id: 'focus-right', titleEn: 'Focus right', titleZh: '聚焦右', descEn: 'Shift focus to the window on the right.', descZh: '將焦點移去右邊嘅視窗。', arg: 'command focus --direction right' },
  { id: 'move-left', titleEn: 'Move window left', titleZh: '視窗向左移', descEn: 'Move the focused window left.', descZh: '將聚焦視窗向左移。', arg: 'command move --direction left' },
  { id: 'move-right', titleEn: 'Move window right', titleZh: '視窗向右移', descEn: 'Move the focused window right.', descZh: '將聚焦視窗向右移。', arg: 'command move --direction right' },
  { id: 'toggle-floating', titleEn: 'Toggle floating', titleZh: '切換浮動', descEn: 'Toggle the focused window between tiling and floating (centered).', descZh: '將聚焦視窗喺平鋪同浮動（置中）之間切換。', arg: 'command toggle-floating --centered' },
  { id: 'toggle-fullscreen', titleEn: 'Toggle fullscreen', titleZh: '切換全螢幕', descEn: 'Toggle fullscreen for the focused window.', descZh: '切換聚焦視窗嘅全螢幕。', arg: 'command toggle-fullscreen' },
  { id: 'toggle-tiling-dir', titleEn: 'Toggle tiling direction', titleZh: '切換平鋪方向', descEn: 'Change where new tiling windows are inserted.', descZh: '改變新平鋪視窗插入嘅位置。', arg: 'command toggle-tiling-direction' },
  { id: 'close', titleEn: 'Close window', titleZh: '關閉視窗', descEn: 'Close the focused window.', descZh: '關閉聚焦視窗。', arg: 'command close', destructive: true },
  { id: 'q-windows', titleEn: 'Query windows', titleZh: '查詢視窗', descEn: 'List all windows managed by GlazeWM (JSON).', descZh: '列出 GlazeWM 管理嘅所有視窗（JSON）。', arg: 'query windows' },
  { id: 'q-workspaces', titleEn: 'Query workspaces', titleZh: '查詢工作區', descEn: 'List all workspaces (JSON).', descZh: '列出所有工作區（JSON）。', arg: 'query workspaces' },
  { id: 'q-monitors', titleEn: 'Query monitors', titleZh: '查詢顯示器', descEn: 'List all monitors (JSON).', descZh: '列出所有顯示器（JSON）。', arg: 'query monitors' },
  { id: 'q-focused', titleEn: 'Query focused', titleZh: '查詢聚焦', descEn: 'Show the currently focused container (JSON).', descZh: '顯示目前聚焦嘅容器（JSON）。', arg: 'query focused' },
  { id: 'q-bindingmodes', titleEn: 'Query binding modes', titleZh: '查詢綁定模式', descEn: 'Show the active binding modes (JSON).', descZh: '顯示目前生效嘅綁定模式（JSON）。', arg: 'query binding-modes' },
];

// ----- bundled default config (trimmed official sample, from GlazeWmService.SampleConfig) -----
const SAMPLE_CONFIG = `general:
  startup_commands: []
  shutdown_commands: []
  config_reload_commands: []
  focus_follows_cursor: false
  hide_method: 'cloak'

gaps:
  scale_with_dpi: true
  inner_gap: '20px'
  outer_gap:
    top: '20px'
    right: '20px'
    bottom: '20px'
    left: '20px'

window_behavior:
  initial_state: 'tiling'

workspaces:
  - name: '1'
  - name: '2'
  - name: '3'
  - name: '4'
  - name: '5'

keybindings:
  - commands: ['focus --direction left']
    bindings: ['alt+h', 'alt+left']
  - commands: ['focus --direction right']
    bindings: ['alt+l', 'alt+right']
  - commands: ['focus --direction up']
    bindings: ['alt+k', 'alt+up']
  - commands: ['focus --direction down']
    bindings: ['alt+j', 'alt+down']
  - commands: ['move --direction left']
    bindings: ['alt+shift+h', 'alt+shift+left']
  - commands: ['move --direction right']
    bindings: ['alt+shift+l', 'alt+shift+right']
  - commands: ['toggle-floating --centered']
    bindings: ['alt+shift+space']
  - commands: ['toggle-fullscreen']
    bindings: ['alt+f']
  - commands: ['close']
    bindings: ['alt+shift+q']
  - commands: ['wm-exit']
    bindings: ['alt+shift+e']
  - commands: ['wm-reload-config']
    bindings: ['alt+shift+r']
  - commands: ['focus --workspace 1']
    bindings: ['alt+1']
  - commands: ['focus --workspace 2']
    bindings: ['alt+2']
  - commands: ['focus --workspace 3']
    bindings: ['alt+3']
`;

// ============================================================================
//  YAML line helpers — ported verbatim in spirit from GlazeWmService.cs so
//  edits touch only the modeled key/line and preserve comments + other keys.
// ============================================================================

const splitLines = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n');

function valueCommentIndex(value: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && i > 0 && /\s/.test(value[i - 1] ?? '')) return i;
  }
  return -1;
}

function topLevelIndex(lines: string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0 || /\s/.test(line[0] ?? '')) continue;
    if (line.trimEnd().startsWith(key + ':')) return i;
  }
  return -1;
}

/** Read a scalar one indent level under a top-level section. */
function scalarUnder(text: string, section: string, key: string): string {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, section);
  if (idx < 0) return '';
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
    const t = line.trimStart();
    if (t.startsWith(key + ':')) {
      let val = t.substring(key.length + 1).trim();
      const hash = valueCommentIndex(val);
      if (hash >= 0) val = val.substring(0, hash).trim();
      return val.replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function scalarUnder2(text: string, section: string, sub: string, key: string): string {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, section);
  if (idx < 0) return '';
  let inSub = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
    const t = line.trimStart();
    if (!inSub) {
      if (t.startsWith(sub + ':')) inSub = true;
      continue;
    }
    if (t.startsWith(key + ':')) {
      let val = t.substring(key.length + 1).trim();
      const hash = valueCommentIndex(val);
      if (hash >= 0) val = val.substring(0, hash).trim();
      return val.replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

/** Replace a scalar's value in place; returns the new text or null if key not found. */
function setScalarUnder(text: string, section: string, key: string, newValueText: string): string | null {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, section);
  if (idx < 0) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
    const trimmed = line.trimStart();
    if (trimmed.startsWith(key + ':')) {
      const indent = line.substring(0, line.length - trimmed.length);
      const after = trimmed.substring(key.length + 1);
      const hash = valueCommentIndex(after);
      const comment = hash >= 0 ? ' ' + after.substring(hash).trim() : '';
      lines[i] = `${indent}${key}: ${newValueText}${comment}`;
      return lines.join('\n');
    }
  }
  return null;
}

function setScalarUnder2(text: string, section: string, sub: string, key: string, newValueText: string): string | null {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, section);
  if (idx < 0) return null;
  let inSub = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
    const trimmed = line.trimStart();
    if (!inSub) {
      if (trimmed.startsWith(sub + ':')) inSub = true;
      continue;
    }
    if (trimmed.startsWith(key + ':')) {
      const indent = line.substring(0, line.length - trimmed.length);
      const after = trimmed.substring(key.length + 1);
      const hash = valueCommentIndex(after);
      const comment = hash >= 0 ? ' ' + after.substring(hash).trim() : '';
      lines[i] = `${indent}${key}: ${newValueText}${comment}`;
      return lines.join('\n');
    }
  }
  return null;
}

function yamlQuote(value: string): string {
  const v = value.trim();
  if (v.length === 0) return "''";
  if (v.startsWith('[') || v.toLowerCase() === 'true' || v.toLowerCase() === 'false') return v;
  if (v.startsWith("'") || v.startsWith('"')) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

function getWorkspaces(text: string): string[] {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, 'workspaces');
  const out: string[] = [];
  if (idx < 0) return out;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
    const t = line.trimStart();
    const n = t.indexOf('name:');
    if (t.startsWith('-') && n >= 0) {
      const val = t.substring(n + 'name:'.length).trim().replace(/^['"]|['"]$/g, '');
      if (val.length > 0) out.push(val);
    }
  }
  return out;
}

function writeWorkspacesBlock(text: string, names: string[]): string {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, 'workspaces');
  const block: string[] = ['workspaces:'];
  for (const n of names) {
    const clean = n.trim();
    if (clean.length === 0) continue;
    block.push(`  - name: '${clean.replace(/'/g, "''")}'`);
  }
  if (idx < 0) {
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length > 0) lines.push('');
    lines.push(...block);
  } else {
    let end = idx + 1;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      if (line.length > 0 && !/\s/.test(line[0] ?? '') && !line.trimStart().startsWith('#')) break;
      end++;
    }
    lines.splice(idx, end - idx, ...block);
  }
  return lines.join('\n');
}

function extractList(inlineArray: string): string {
  let s = inlineArray.trim();
  s = s.replace(/^\[|\]$/g, '');
  return s
    .split(',')
    .map((p) => p.trim().replace(/^['"]|['"]$/g, ''))
    .filter((p) => p.length > 0)
    .join(' ; ');
}

function getKeybindings(text: string): Binding[] {
  const lines = splitLines(text);
  const idx = topLevelIndex(lines, 'keybindings');
  const out: Binding[] = [];
  if (idx < 0) return out;
  let cur: Binding | null = null;
  for (let i = idx + 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.length > 0 && !/\s/.test(raw[0] ?? '') && !raw.trimStart().startsWith('#')) break;
    const t = raw.trimStart();
    if (t.startsWith('#') || t.length === 0) continue;
    if (t.startsWith('- commands:')) {
      if (cur) out.push(cur);
      cur = { commands: extractList(t.substring('- commands:'.length)), keys: '' };
    } else if (t.startsWith('commands:') && cur) {
      cur.commands = extractList(t.substring('commands:'.length));
    } else if (t.startsWith('bindings:') && cur) {
      cur.keys = extractList(t.substring('bindings:'.length));
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ============================================================================
//  PowerShell-backed probe: detect install, running state, version, config.
// ============================================================================

async function probe(): Promise<Engine> {
  const script = `
$cli = '${q(CLI_DEFAULT)}'
$daemon = '${q(DAEMON_DEFAULT)}'
$onPath = (Get-Command glazewm.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
$exe = if (Test-Path -LiteralPath $cli) { $cli } elseif ($onPath) { $onPath } else { $null }
$installed = [bool]($exe -or (Test-Path -LiteralPath $daemon))
$running = [bool]((Get-Process -Name glazewm -ErrorAction SilentlyContinue) -ne $null)
$version = ''
if ($exe) { try { $version = (& $exe --version 2>$null | Select-Object -First 1) } catch {} }
$cfg = Join-Path $env:USERPROFILE '.glzr\\glazewm\\config.yaml'
$cfgExists = Test-Path -LiteralPath $cfg
$raw = if ($cfgExists) { [IO.File]::ReadAllText($cfg) } else { '' }
$run = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'GlazeWM' -ErrorAction SilentlyContinue
$startup = [bool]($run -and $run.GlazeWM)
[pscustomobject]@{
  installed = $installed
  running = $running
  version = ("$version").Trim()
  configPath = $cfg
  configExists = [bool]$cfgExists
  raw = $raw
  startWithWindows = $startup
} | ConvertTo-Json -Compress -Depth 3
`;
  const res = await runPowershell(script);
  const text = res.stdout.trim();
  if (!text) {
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    throw new Error('no output');
  }
  const p = JSON.parse(text) as Partial<Engine>;
  return {
    installed: !!p.installed,
    running: !!p.running,
    version: p.version ?? '',
    configPath: p.configPath ?? '',
    configExists: !!p.configExists,
    raw: p.raw ?? '',
    startWithWindows: !!p.startWithWindows,
  };
}

async function resolveCli(): Promise<string> {
  const res = await runPowershell(
    `$cli='${q(CLI_DEFAULT)}'; if (Test-Path -LiteralPath $cli) { $cli } else { (Get-Command glazewm.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source) }`,
  );
  const p = res.stdout.trim();
  return p || 'glazewm';
}

async function resolveDaemon(): Promise<string> {
  const res = await runPowershell(
    `if (Test-Path -LiteralPath '${q(DAEMON_DEFAULT)}') { '${q(DAEMON_DEFAULT)}' } else { '' }`,
  );
  const p = res.stdout.trim();
  return p || (await resolveCli());
}

// ============================================================================
//  Component
// ============================================================================

export function GlazeWmModule() {
  const { t } = useTranslation();
  const native = isTauri();

  const [engine, setEngine] = useState<Engine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // editable form state (populated from engine.raw)
  const [innerGap, setInnerGap] = useState('');
  const [outerGap, setOuterGap] = useState('');
  const [focusFollows, setFocusFollows] = useState(false);
  const [startupCmds, setStartupCmds] = useState('');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [rawBox, setRawBox] = useState('');
  const [opFilter, setOpFilter] = useState('');
  const [opOut, setOpOut] = useState<string | null>(null);

  const applyRawToForm = useCallback((raw: string) => {
    setInnerGap(scalarUnder(raw, 'gaps', 'inner_gap'));
    setOuterGap(scalarUnder2(raw, 'gaps', 'outer_gap', 'top') || scalarUnder(raw, 'gaps', 'outer_gap'));
    setFocusFollows(scalarUnder(raw, 'general', 'focus_follows_cursor').toLowerCase() === 'true');
    setStartupCmds(scalarUnder(raw, 'general', 'startup_commands'));
    setWorkspaces(getWorkspaces(raw));
    setRawBox(raw);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const e = await probe();
      setEngine(e);
      applyRawToForm(e.raw);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [applyRawToForm]);

  useEffect(() => {
    if (native) void load();
    else setLoading(false);
  }, [native, load]);

  const keybindings = useMemo(() => getKeybindings(rawBox), [rawBox]);
  const shownOps = useMemo(() => {
    const f = opFilter.trim().toLowerCase();
    if (!f) return OPS;
    return OPS.filter((o) =>
      `${o.id} ${o.titleEn} ${o.titleZh} ${o.descEn} ${o.descZh} ${o.arg}`.toLowerCase().includes(f),
    );
  }, [opFilter]);

  const say = (ok: boolean, text: string) => setMsg({ ok, text });

  // ----- write config.yaml verbatim -----
  const writeConfig = useCallback(async (text: string): Promise<boolean> => {
    const cfg = engine?.configPath;
    if (!cfg) return false;
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const res = await runPowershell(
      `$p='${q(cfg)}'; $d=Split-Path -Parent $p; if(-not (Test-Path -LiteralPath $d)){ New-Item -ItemType Directory -Force -Path $d | Out-Null }; ` +
        `$bytes=[Convert]::FromBase64String('${b64}'); [IO.File]::WriteAllBytes($p, $bytes); 'ok'`,
    );
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    return true;
  }, [engine?.configPath]);

  const autoReload = useCallback(async () => {
    if (!engine?.running) return;
    try {
      const cli = await resolveCli();
      await runCommand(cli, ['command', 'wm-reload-config']);
    } catch {
      /* best-effort */
    }
  }, [engine?.running]);

  // ----- process control -----
  const runLifecycle = async (action: 'start' | 'stop' | 'reload' | 'refresh') => {
    setBusy(action);
    setMsg(null);
    try {
      if (action === 'refresh') {
        await load();
        return;
      }
      if (action === 'start') {
        const daemon = await resolveDaemon();
        const res = await runCommand('cmd', ['/c', 'start', '', '/min', daemon]);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        say(true, t('glazewm.msgStarted'));
      } else if (action === 'reload') {
        const cli = await resolveCli();
        const res = await runCommand(cli, ['command', 'wm-reload-config']);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        say(true, t('glazewm.msgReloaded'));
      } else if (action === 'stop') {
        const cli = await resolveCli();
        await runCommand(cli, ['command', 'wm-exit']).catch(() => undefined);
        // fall back to a hard stop of the daemon + watcher
        await runPowershell(
          "Get-Process -Name glazewm,glazewm-watcher -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'",
        );
        say(true, t('glazewm.msgStopped'));
      }
      await load();
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleStartup = async (enabled: boolean) => {
    setBusy('startup');
    setMsg(null);
    try {
      if (enabled) {
        const daemon = await resolveDaemon();
        await runPowershell(
          `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'GlazeWM' -Value '"${q(daemon)}"' -ErrorAction Stop; 'ok'`,
        );
      } else {
        await runPowershell(
          "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'GlazeWM' -ErrorAction SilentlyContinue; 'ok'",
        );
      }
      await load();
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ----- install via winget -----
  const install = async () => {
    setBusy('install');
    setMsg(null);
    try {
      const res = await runCommand('winget', [
        'install',
        '-e',
        '--id',
        WINGET_ID,
        '--accept-source-agreements',
        '--accept-package-agreements',
      ]);
      if (!res.success && !/already installed/i.test(res.stdout)) {
        throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      }
      say(true, t('glazewm.msgInstalled'));
      await load();
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ----- config saves -----
  const saveStructured = async () => {
    if (!engine?.configExists) {
      say(false, t('glazewm.msgNoConfig'));
      return;
    }
    setBusy('save-structured');
    setMsg(null);
    try {
      let text = engine.raw;
      if (innerGap.trim()) {
        const r = setScalarUnder(text, 'gaps', 'inner_gap', yamlQuote(innerGap.trim()));
        if (r != null) text = r;
      }
      if (outerGap.trim()) {
        const nested = setScalarUnder2(text, 'gaps', 'outer_gap', 'top', yamlQuote(outerGap.trim()));
        const r = nested ?? setScalarUnder(text, 'gaps', 'outer_gap', yamlQuote(outerGap.trim()));
        if (r != null) text = r;
      }
      const ff = setScalarUnder(text, 'general', 'focus_follows_cursor', focusFollows ? 'true' : 'false');
      if (ff != null) text = ff;
      if (startupCmds.trim()) {
        const r = setScalarUnder(text, 'general', 'startup_commands', startupCmds.trim());
        if (r != null) text = r;
      }
      await writeConfig(text);
      setEngine({ ...engine, raw: text });
      applyRawToForm(text);
      await autoReload();
      say(true, t('glazewm.msgSaved'));
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveWorkspaces = async () => {
    if (!engine) return;
    setBusy('save-workspaces');
    setMsg(null);
    try {
      const text = writeWorkspacesBlock(engine.raw, workspaces.filter((w) => w.trim().length > 0));
      await writeConfig(text);
      setEngine({ ...engine, raw: text });
      applyRawToForm(text);
      await autoReload();
      say(true, t('glazewm.msgSaved'));
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveRaw = async () => {
    if (!engine) return;
    setBusy('save-raw');
    setMsg(null);
    try {
      await writeConfig(rawBox);
      setEngine({ ...engine, raw: rawBox, configExists: true });
      applyRawToForm(rawBox);
      await autoReload();
      say(true, t('glazewm.msgSaved'));
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  const createConfig = async () => {
    if (!engine) return;
    setBusy('create');
    setMsg(null);
    try {
      await writeConfig(SAMPLE_CONFIG);
      const e = { ...engine, raw: SAMPLE_CONFIG, configExists: true };
      setEngine(e);
      applyRawToForm(SAMPLE_CONFIG);
      say(true, t('glazewm.msgConfigCreated'));
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    if (!engine?.configPath) return;
    await runPowershell(
      `$d=Split-Path -Parent '${q(engine.configPath)}'; if(-not (Test-Path -LiteralPath $d)){ New-Item -ItemType Directory -Force -Path $d | Out-Null }; Start-Process explorer.exe $d`,
    ).catch(() => undefined);
  };

  // ----- run a CLI operation -----
  const runOp = async (op: Op) => {
    if (op.destructive && !window.confirm(t('glazewm.confirmDestructive', { title: `${op.titleEn} · ${op.titleZh}` }))) {
      return;
    }
    setBusy(`op:${op.id}`);
    setMsg(null);
    setOpOut(null);
    try {
      const cli = await resolveCli();
      const args = op.arg.split(/\s+/).filter((a) => a.length > 0);
      const res = await runCommand(cli, args);
      const body = `${res.stdout}${res.stderr}`.trim();
      setOpOut(body ? (body.length > 4000 ? body.slice(-4000) : body) : t('glazewm.opNoOutput'));
      say(res.success, res.success ? t('glazewm.msgDone') : t('glazewm.msgFailed'));
      if (op.arg.includes('wm-exit')) await load();
    } catch (e) {
      say(false, `${t('glazewm.msgFailed')}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ----- workspace row editing -----
  const setWorkspaceAt = (i: number, val: string) =>
    setWorkspaces((ws) => ws.map((w, idx) => (idx === i ? val : w)));
  const removeWorkspaceAt = (i: number) => setWorkspaces((ws) => ws.filter((_, idx) => idx !== i));
  const addWorkspace = () => setWorkspaces((ws) => [...ws, String(ws.length + 1)]);

  const keybindCols: Column<Binding>[] = [
    { key: 'keys', header: t('glazewm.colKeys'), width: 220, render: (b) => <code className="env-val">{b.keys}</code> },
    { key: 'commands', header: t('glazewm.colCommands'), render: (b) => <code className="env-val">{b.commands}</code> },
  ];

  const running = engine?.running ?? false;
  const installed = engine?.installed ?? false;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" disabled={busy != null} onClick={() => runLifecycle('refresh')}>
          ⟳ {t('glazewm.refresh')}
        </button>
        {engine?.version ? (
          <span className="count-note">{t('glazewm.version', { version: engine.version })}</span>
        ) : null}
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('glazewm.blurb')}
      </p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('glazewm.warnBar')}
      </p>

      {msg && <p className={msg.ok ? 'mod-msg' : 'mod-msg error'}>{msg.text}</p>}

      <AsyncState loading={loading} error={error}>
        {!native ? (
          <p className="count-note">{t('glazewm.desktopOnly')}</p>
        ) : (
          <>
            {/* Engine / install */}
            {!installed && (
              <div className="hosts-edit" style={{ marginBottom: 12 }}>
                <p style={{ marginTop: 0 }}>
                  <strong>{t('glazewm.notFoundTitle')}</strong> — {t('glazewm.notFoundMsg')}
                </p>
                <button className="mini primary" disabled={busy != null} onClick={install}>
                  {busy === 'install' ? t('glazewm.installing') : t('glazewm.install')}
                </button>
              </div>
            )}

            {/* Status + process control */}
            <div className="hosts-edit" style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 8 }}>
                <StatusDot ok={running} label={running ? t('glazewm.running') : t('glazewm.stopped')} />
                <span className="count-note" style={{ marginLeft: 8 }}>
                  {running ? t('glazewm.runningMsg') : t('glazewm.stoppedMsg')}
                </span>
              </div>
              <div className="row-actions" style={{ marginBottom: 8 }}>
                <button className="mini primary" disabled={!installed || running || busy != null} onClick={() => runLifecycle('start')}>
                  {t('glazewm.start')}
                </button>
                <button className="mini" disabled={!running || busy != null} onClick={() => runLifecycle('stop')}>
                  {t('glazewm.stop')}
                </button>
                <button className="mini" disabled={!running || busy != null} onClick={() => runLifecycle('reload')}>
                  {t('glazewm.reload')}
                </button>
              </div>
              <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={engine?.startWithWindows ?? false}
                  disabled={!installed || busy != null}
                  onChange={(e) => toggleStartup(e.target.checked)}
                />
                {t('glazewm.startWithWindows')}
              </label>
            </div>

            {/* Config path + no-config warning */}
            <p className="count-note" style={{ marginTop: 0, userSelect: 'text' }}>
              {t('glazewm.configLabel', { path: engine?.configPath ?? '' })}
            </p>
            {engine && !engine.configExists && (
              <div className="hosts-edit" style={{ marginBottom: 12 }}>
                <p style={{ marginTop: 0 }}>
                  <strong>{t('glazewm.noConfigTitle')}</strong> — {t('glazewm.noConfigMsg')}
                </p>
                <button className="mini primary" disabled={busy != null} onClick={createConfig}>
                  {t('glazewm.createConfig')}
                </button>
              </div>
            )}

            {/* Structured config editor */}
            <h3>{t('glazewm.configHeader')}</h3>
            <div className="hosts-edit" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
                <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {t('glazewm.innerGap')}
                  <input className="mod-search" style={{ width: 140 }} value={innerGap} onChange={(e) => setInnerGap(e.target.value)} />
                </label>
                <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {t('glazewm.outerGap')}
                  <input className="mod-search" style={{ width: 140 }} value={outerGap} onChange={(e) => setOuterGap(e.target.value)} />
                </label>
              </div>
              <label className="count-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                <input type="checkbox" checked={focusFollows} onChange={(e) => setFocusFollows(e.target.checked)} />
                {t('glazewm.focusFollows')}
              </label>
              <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
                {t('glazewm.startupCmds')}
                <input className="mod-search" value={startupCmds} onChange={(e) => setStartupCmds(e.target.value)} />
              </label>
              <div className="row-actions">
                <button className="mini primary" disabled={!engine?.configExists || busy != null} onClick={saveStructured}>
                  {t('glazewm.saveReload')}
                </button>
                <button className="mini" disabled={busy != null} onClick={() => applyRawToForm(engine?.raw ?? '')}>
                  {t('glazewm.revert')}
                </button>
              </div>
            </div>

            {/* Workspaces editor */}
            <h3>{t('glazewm.workspacesHeader')}</h3>
            <div className="hosts-edit" style={{ marginBottom: 12 }}>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('glazewm.workspacesHint')}
              </p>
              {workspaces.map((w, i) => (
                <div key={i} className="row-actions" style={{ marginBottom: 4 }}>
                  <input className="mod-search" style={{ flex: 1 }} value={w} onChange={(e) => setWorkspaceAt(i, e.target.value)} />
                  <button className="mini" disabled={busy != null} onClick={() => removeWorkspaceAt(i)}>
                    {t('glazewm.remove')}
                  </button>
                </div>
              ))}
              <div className="row-actions" style={{ marginTop: 8 }}>
                <button className="mini" disabled={busy != null} onClick={addWorkspace}>
                  {t('glazewm.addWorkspace')}
                </button>
                <button className="mini primary" disabled={!engine?.configExists || busy != null} onClick={saveWorkspaces}>
                  {t('glazewm.saveWorkspaces')}
                </button>
              </div>
            </div>

            {/* Keybindings (read-only) */}
            <h3>{t('glazewm.keybindHeader')}</h3>
            <DataTable
              columns={keybindCols}
              rows={keybindings}
              rowKey={(_b, i) => `kb-${i}`}
              empty={t('glazewm.keybindEmpty')}
            />

            {/* Raw YAML editor */}
            <h3>{t('glazewm.rawHeader')}</h3>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('glazewm.rawHint')}
            </p>
            <textarea
              className="mod-search"
              style={{ width: '100%', minHeight: 220, fontFamily: 'Consolas, monospace', fontSize: 13, whiteSpace: 'pre' }}
              value={rawBox}
              onChange={(e) => setRawBox(e.target.value)}
              spellCheck={false}
            />
            <div className="row-actions" style={{ marginTop: 8, marginBottom: 12 }}>
              <button className="mini primary" disabled={busy != null} onClick={saveRaw}>
                {t('glazewm.saveRaw')}
              </button>
              <button className="mini" disabled={busy != null} onClick={() => setRawBox(engine?.raw ?? '')}>
                {t('glazewm.revert')}
              </button>
              <button className="mini" disabled={busy != null} onClick={openFolder}>
                {t('glazewm.openFolder')}
              </button>
            </div>

            {/* CLI operations */}
            <h3>{t('glazewm.opsHeader', { total: OPS.length })}</h3>
            <input
              className="mod-search"
              placeholder={t('glazewm.opsFilter')}
              value={opFilter}
              onChange={(e) => setOpFilter(e.target.value)}
              style={{ maxWidth: 420, marginBottom: 8 }}
            />
            {opOut != null && <pre className="cmd-out">{opOut}</pre>}
            <div className="hosts-edit">
              {shownOps.map((op) => (
                <div
                  key={op.id}
                  className="row-actions"
                  style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border, #333)' }}
                >
                  <span style={{ flex: 1 }}>
                    <strong>{`${op.titleEn} · ${op.titleZh}`}</strong>
                    <br />
                    <span className="count-note">{`${op.descEn} · ${op.descZh}`}</span>
                  </span>
                  <button className="mini" disabled={!running || busy != null} onClick={() => runOp(op)}>
                    {busy === `op:${op.id}` ? '…' : op.arg.startsWith('query') ? t('glazewm.query') : t('glazewm.run')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </AsyncState>
    </div>
  );
}
