import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

/**
 * Native web port of WinForge HotkeyMacroModule (module.hotkeys) — the global hotkey + macro
 * runner + text expander.
 *
 * The desktop original registers Win32 global chords (RegisterHotKey) and installs a low-level
 * keyboard hook — neither is reachable from the Tauri sandbox, so this port keeps the same model
 * but makes it useful on the web: you build hotkey bindings (chord + action) and text-expander
 * snippets that persist in localStorage, and each one is runnable ON DEMAND through the Rust
 * backend — Launch app/file/URL, Run a PowerShell snippet — or copy-to-clipboard for Type-text and
 * snippet expansions. It also surfaces a genuinely LIVE system view: every Windows Explorer
 * shortcut (.lnk) that has an OS-assigned global hotkey, read read-only via WScript.Shell.
 */

type ActionKind = 'LaunchApp' | 'RunPowerShell' | 'TypeText';

interface Binding {
  id: string;
  enabled: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  key: string; // friendly key label e.g. "K", "F5"
  action: ActionKind;
  name: string;
  target: string; // program / file / URL (LaunchApp)
  args: string; // arguments (LaunchApp)
  script: string; // PowerShell body (RunPowerShell)
  keys: string; // text (TypeText)
}

interface Snippet {
  id: string;
  enabled: boolean;
  trigger: string;
  expansion: string;
}

/** A real Windows shortcut that has an OS-assigned global hotkey. */
interface LiveHotkey {
  Name: string;
  Hotkey: string;
  Target: string;
  Location: string;
}

const BIND_KEY = 'winforge.hotkeys.bindings.v1';
const SNIP_KEY = 'winforge.hotkeys.snippets.v1';

/** Common keys for the chord picker — mirrors HotkeyMacroService.PickableKeys. */
const PICKABLE_KEYS: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'Space',
  'Enter',
  'Tab',
  'Esc',
  'Insert',
  'Delete',
  'Home',
  'End',
  'Page Up',
  'Page Down',
  'Print Screen',
  'Left',
  'Up',
  'Right',
  'Down',
];

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function chordText(b: Binding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  if (b.win) parts.push('Win');
  parts.push(b.key || '?');
  return parts.join(' + ');
}

function loadBindings(): Binding[] {
  try {
    const raw = localStorage.getItem(BIND_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Binding[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const action = o.action === 'RunPowerShell' || o.action === 'TypeText' ? o.action : 'LaunchApp';
        out.push({
          id: typeof o.id === 'string' ? o.id : newId(),
          enabled: o.enabled !== false,
          ctrl: o.ctrl === true,
          alt: o.alt === true,
          shift: o.shift === true,
          win: o.win === true,
          key: typeof o.key === 'string' ? o.key : '',
          action,
          name: typeof o.name === 'string' ? o.name : '',
          target: typeof o.target === 'string' ? o.target : '',
          args: typeof o.args === 'string' ? o.args : '',
          script: typeof o.script === 'string' ? o.script : '',
          keys: typeof o.keys === 'string' ? o.keys : '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Snippet[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        out.push({
          id: typeof o.id === 'string' ? o.id : newId(),
          enabled: o.enabled !== false,
          trigger: typeof o.trigger === 'string' ? o.trigger : '',
          expansion: typeof o.expansion === 'string' ? o.expansion : '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// Read-only PowerShell that lists every Explorer shortcut with an OS-assigned global hotkey.
const LIVE_HOTKEYS_PS = `
$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  @{ P = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"; L = 'User Start Menu' },
  @{ P = "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"; L = 'Common Start Menu' },
  @{ P = "$env:USERPROFILE\\Desktop"; L = 'Desktop' },
  @{ P = "$env:PUBLIC\\Desktop"; L = 'Public Desktop' }
)
$out = New-Object System.Collections.Generic.List[object]
foreach ($d in $dirs) {
  if (Test-Path $d.P) {
    Get-ChildItem -Path $d.P -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $lnk = $sh.CreateShortcut($_.FullName)
        if ($lnk.Hotkey) {
          $out.Add([pscustomobject]@{
            Name     = $_.BaseName
            Hotkey   = [string]$lnk.Hotkey
            Target   = [string]$lnk.TargetPath
            Location = $d.L
          })
        }
      } catch {}
    }
  }
}
$out`;

export function HotkeyMacroModule() {
  const { t } = useTranslation();
  const tauri = isTauri();

  const [bindings, setBindings] = useState<Binding[]>(() => loadBindings());
  const [snippets, setSnippets] = useState<Snippet[]>(() => loadSnippets());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // chord + action draft
  const [ctrl, setCtrl] = useState(true);
  const [alt, setAlt] = useState(true);
  const [shift, setShift] = useState(false);
  const [win, setWin] = useState(false);
  const [key, setKey] = useState('K');
  const [action, setAction] = useState<ActionKind>('LaunchApp');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [script, setScript] = useState('');
  const [keys, setKeys] = useState('');

  // snippet draft
  const [trigger, setTrigger] = useState('');
  const [expansion, setExpansion] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(BIND_KEY, JSON.stringify(bindings));
    } catch {
      /* ignore */
    }
  }, [bindings]);

  useEffect(() => {
    try {
      localStorage.setItem(SNIP_KEY, JSON.stringify(snippets));
    } catch {
      /* ignore */
    }
  }, [snippets]);

  // Live system view — real Explorer shortcut hotkeys.
  const live = useAsync<LiveHotkey[]>(
    () => (tauri ? runPowershellJson<LiveHotkey>(LIVE_HOTKEYS_PS) : Promise.resolve([])),
    [tauri],
  );
  const liveRows = useMemo(() => {
    const all = live.data ?? [];
    return [...all].sort((a, b) => a.Hotkey.localeCompare(b.Hotkey));
  }, [live.data]);

  const addBinding = () => {
    if (!ctrl && !alt && !shift && !win) {
      setMsg(t('hotkeys.needMod'));
      return;
    }
    if (!key) {
      setMsg(t('hotkeys.needKey'));
      return;
    }
    if (action === 'LaunchApp' && !target.trim()) {
      setMsg(t('hotkeys.needTarget'));
      return;
    }
    if (action === 'RunPowerShell' && !script.trim()) {
      setMsg(t('hotkeys.needScript'));
      return;
    }
    if (action === 'TypeText' && !keys.length) {
      setMsg(t('hotkeys.needKeys'));
      return;
    }
    const dupe = bindings.some(
      (b) => b.ctrl === ctrl && b.alt === alt && b.shift === shift && b.win === win && b.key === key,
    );
    if (dupe) {
      setMsg(t('hotkeys.dupeChord'));
      return;
    }
    const b: Binding = {
      id: newId(),
      enabled: true,
      ctrl,
      alt,
      shift,
      win,
      key,
      action,
      name: name.trim(),
      target: target.trim(),
      args: args.trim(),
      script,
      keys,
    };
    setBindings((prev) => [b, ...prev]);
    setName('');
    setTarget('');
    setArgs('');
    setScript('');
    setKeys('');
    setMsg(t('hotkeys.added', { chord: chordText(b) }));
  };

  const removeBinding = (id: string) => setBindings((prev) => prev.filter((b) => b.id !== id));
  const toggleBinding = (id: string) =>
    setBindings((prev) => prev.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));

  const runBinding = async (b: Binding) => {
    setBusy(b.id);
    setMsg(null);
    try {
      if (b.action === 'TypeText') {
        const ok = await copyText(b.keys);
        setMsg(ok ? t('hotkeys.copied') : t('hotkeys.copyFailed'));
        return;
      }
      if (!tauri) {
        setMsg(t('hotkeys.webOnly'));
        return;
      }
      if (b.action === 'LaunchApp') {
        // Launch program / file / URL via the shell so file associations + URLs resolve.
        const argList = b.args.trim() ? b.args.trim() : '';
        const res = await runCommand('cmd', ['/c', 'start', '', b.target, ...(argList ? [argList] : [])]);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        setMsg(t('hotkeys.launched', { target: b.target }));
      } else if (b.action === 'RunPowerShell') {
        const res = await runPowershell(b.script);
        if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
        setMsg(res.stdout.trim() || t('hotkeys.ranScript'));
      }
    } catch (e) {
      setMsg(`${t('hotkeys.runFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const addSnippet = () => {
    const trig = trigger.trim();
    if (!trig) {
      setMsg(t('hotkeys.needTrigger'));
      return;
    }
    if (!expansion.length) {
      setMsg(t('hotkeys.needExpansion'));
      return;
    }
    if (snippets.some((s) => s.trigger === trig)) {
      setMsg(t('hotkeys.dupeTrigger'));
      return;
    }
    setSnippets((prev) => [{ id: newId(), enabled: true, trigger: trig, expansion }, ...prev]);
    setTrigger('');
    setExpansion('');
    setMsg(t('hotkeys.snippetAdded', { trigger: trig }));
  };

  const removeSnippet = (id: string) => setSnippets((prev) => prev.filter((s) => s.id !== id));
  const toggleSnippet = (id: string) =>
    setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));

  const copySnippet = async (s: Snippet) => {
    const ok = await copyText(s.expansion);
    setMsg(ok ? t('hotkeys.copied') : t('hotkeys.copyFailed'));
  };

  const actionSummary = (b: Binding): string => {
    if (b.action === 'LaunchApp') return b.args ? `${b.target} ${b.args}` : b.target;
    if (b.action === 'RunPowerShell') return b.script.replace(/[\r\n]+/g, ' ');
    return b.keys;
  };

  const actionLabel = (a: ActionKind): string =>
    a === 'LaunchApp' ? t('hotkeys.actLaunch') : a === 'RunPowerShell' ? t('hotkeys.actPs') : t('hotkeys.actType');

  const bindColumns: Column<Binding>[] = [
    {
      key: 'enabled',
      header: t('hotkeys.on'),
      width: 70,
      render: (b) => (
        <button className="mini" onClick={() => toggleBinding(b.id)} title={t('hotkeys.toggle')}>
          <StatusDot ok={b.enabled} label={b.enabled ? t('hotkeys.enabled') : t('hotkeys.disabled')} />
        </button>
      ),
    },
    { key: 'name', header: t('hotkeys.colName'), width: 150, render: (b) => b.name || '—' },
    {
      key: 'chord',
      header: t('hotkeys.colChord'),
      width: 150,
      render: (b) => <code>{chordText(b)}</code>,
    },
    { key: 'kind', header: t('hotkeys.colAction'), width: 130, render: (b) => actionLabel(b.action) },
    {
      key: 'detail',
      header: t('hotkeys.colDetail'),
      render: (b) => <span className="count-note">{actionSummary(b)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 170,
      render: (b) => (
        <span className="row-actions">
          <button className="mini primary" disabled={busy === b.id} onClick={() => runBinding(b)}>
            {b.action === 'TypeText' ? t('hotkeys.copy') : t('hotkeys.runNow')}
          </button>
          <button className="mini" onClick={() => removeBinding(b.id)}>
            {t('hotkeys.remove')}
          </button>
        </span>
      ),
    },
  ];

  const snipColumns: Column<Snippet>[] = [
    {
      key: 'enabled',
      header: t('hotkeys.on'),
      width: 70,
      render: (s) => (
        <button className="mini" onClick={() => toggleSnippet(s.id)} title={t('hotkeys.toggle')}>
          <StatusDot ok={s.enabled} label={s.enabled ? t('hotkeys.enabled') : t('hotkeys.disabled')} />
        </button>
      ),
    },
    { key: 'trigger', header: t('hotkeys.colTrigger'), width: 200, render: (s) => <code>{s.trigger}</code> },
    {
      key: 'expansion',
      header: t('hotkeys.colExpansion'),
      render: (s) => <span className="count-note">{s.expansion.replace(/[\r\n]+/g, ' ')}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 170,
      render: (s) => (
        <span className="row-actions">
          <button className="mini primary" onClick={() => copySnippet(s)}>
            {t('hotkeys.copy')}
          </button>
          <button className="mini" onClick={() => removeSnippet(s.id)}>
            {t('hotkeys.remove')}
          </button>
        </span>
      ),
    },
  ];

  const liveColumns: Column<LiveHotkey>[] = [
    { key: 'Hotkey', header: t('hotkeys.colChord'), width: 170, render: (h) => <code>{h.Hotkey}</code> },
    { key: 'Name', header: t('hotkeys.colName'), width: 220 },
    { key: 'Target', header: t('hotkeys.colTarget'), render: (h) => <span className="count-note">{h.Target}</span> },
    { key: 'Location', header: t('hotkeys.colLocation'), width: 150 },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('hotkeys.blurb')}
      </p>
      {!tauri && <p className="mod-msg">{t('hotkeys.desktopNote')}</p>}
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ===================== Build a hotkey ===================== */}
      <h3 className="group-title">{t('hotkeys.hotkeysHeader')}</h3>
      <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>{t('hotkeys.chord')}</span>
          <label>
            <input type="checkbox" checked={ctrl} onChange={(e) => setCtrl(e.target.checked)} /> Ctrl
          </label>
          <label>
            <input type="checkbox" checked={alt} onChange={(e) => setAlt(e.target.checked)} /> Alt
          </label>
          <label>
            <input type="checkbox" checked={shift} onChange={(e) => setShift(e.target.checked)} /> Shift
          </label>
          <label>
            <input type="checkbox" checked={win} onChange={(e) => setWin(e.target.checked)} /> Win
          </label>
          <select className="mod-search" value={key} onChange={(e) => setKey(e.target.value)} style={{ minWidth: 120 }}>
            {PICKABLE_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>{t('hotkeys.action')}</span>
          <select
            className="mod-search"
            value={action}
            onChange={(e) => setAction(e.target.value as ActionKind)}
            style={{ minWidth: 200 }}
          >
            <option value="LaunchApp">{t('hotkeys.actLaunch')}</option>
            <option value="RunPowerShell">{t('hotkeys.actPs')}</option>
            <option value="TypeText">{t('hotkeys.actType')}</option>
          </select>
          <input
            className="mod-search"
            placeholder={t('hotkeys.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 180 }}
          />
        </div>

        {action === 'LaunchApp' && (
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ flex: 2, minWidth: 220 }}
              placeholder={t('hotkeys.targetPlaceholder')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 140 }}
              placeholder={t('hotkeys.argsPlaceholder')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>
        )}

        {action === 'RunPowerShell' && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 80, fontFamily: 'Consolas, monospace' }}
            placeholder={t('hotkeys.scriptPlaceholder')}
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
        )}

        {action === 'TypeText' && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 60 }}
            placeholder={t('hotkeys.keysPlaceholder')}
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
        )}

        <div>
          <button className="mini primary" onClick={addBinding}>
            {t('hotkeys.addHotkey')}
          </button>
        </div>
      </div>

      <p className="count-note">{t('hotkeys.bindCount', { total: bindings.length })}</p>
      <DataTable columns={bindColumns} rows={bindings} rowKey={(b) => b.id} empty={t('hotkeys.noBindings')} />

      {/* ===================== Text expander ===================== */}
      <h3 className="group-title">{t('hotkeys.snippetsHeader')}</h3>
      <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ minWidth: 160 }}
            placeholder={t('hotkeys.triggerPlaceholder')}
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('hotkeys.expansionPlaceholder')}
            value={expansion}
            onChange={(e) => setExpansion(e.target.value)}
          />
          <button className="mini primary" onClick={addSnippet}>
            {t('hotkeys.addSnippet')}
          </button>
        </div>
      </div>

      <p className="count-note">{t('hotkeys.snipCount', { total: snippets.length })}</p>
      <DataTable columns={snipColumns} rows={snippets} rowKey={(s) => s.id} empty={t('hotkeys.noSnippets')} />

      {/* ===================== Live system hotkeys ===================== */}
      <h3 className="group-title">{t('hotkeys.liveHeader')}</h3>
      <ModuleToolbar>
        <button className="mini" onClick={live.reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('hotkeys.liveCount', { total: liveRows.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('hotkeys.liveNote')}
      </p>
      <AsyncState loading={live.loading} error={live.error}>
        <DataTable columns={liveColumns} rows={liveRows} rowKey={(h) => `${h.Location}:${h.Name}`} empty={t('hotkeys.noLive')} />
      </AsyncState>
    </div>
  );
}
