import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson, type CommandOutput } from '../tauri/bridge';

// Native module — WinForge's Explorer right-click integration.
// Ports WinForge's ShellContextMenuService: registers "classic" shell verbs under
// HKCU\Software\Classes (per-user, no elevation, applied live) so WinForge actions
// appear in Explorer's right-click menu. Each verb launches WinForge's own exe with
// a --page/--path deep link. On Win11 they show under "Show more options"; Win10 direct.
// Registry work runs only inside the WinForge desktop app (Tauri backend).

type Scope = 'AllFiles' | 'Directory' | 'DirectoryBackground';

interface ShellAction {
  id: string;
  en: string;
  zh: string;
  pageAlias: string;
  scope: Scope;
  icon: string;
}

// The curated action set, mirrored from ShellContextMenuService.Actions.
const ACTIONS: ShellAction[] = [
  { id: 'hash', en: 'Hash with WinForge', zh: '用 WinForge 計雜湊值', pageAlias: 'duplicates', scope: 'AllFiles', icon: 'imageres.dll,-5301' },
  { id: 'ocr', en: 'OCR image text', zh: '圖片文字辨識（OCR）', pageAlias: 'ocr', scope: 'AllFiles', icon: 'imageres.dll,-1019' },
  { id: 'resize', en: 'Resize image', zh: '縮放圖片', pageAlias: 'imageresizer', scope: 'AllFiles', icon: 'imageres.dll,-1019' },
  { id: 'locksmith', en: "What's locking this?", zh: '邊個程序鎖住佢？', pageAlias: 'filelocksmith', scope: 'AllFiles', icon: 'imageres.dll,-100' },
  { id: 'copypath', en: 'Copy as path', zh: '複製路徑', pageAlias: 'copypath', scope: 'AllFiles', icon: 'imageres.dll,-5302' },
  { id: 'openfolder', en: 'Open folder in WinForge', zh: '喺 WinForge 開資料夾', pageAlias: 'disk', scope: 'Directory', icon: 'imageres.dll,-3' },
  { id: 'diskusage', en: 'Analyse disk usage', zh: '分析磁碟用量', pageAlias: 'disk', scope: 'Directory', icon: 'imageres.dll,-30' },
  { id: 'lockfolder', en: "What's locking this folder?", zh: '邊個程序鎖住此資料夾？', pageAlias: 'filelocksmith', scope: 'Directory', icon: 'imageres.dll,-100' },
  { id: 'openhere', en: 'Open WinForge here', zh: '喺呢度開 WinForge', pageAlias: 'disk', scope: 'DirectoryBackground', icon: 'imageres.dll,-3' },
];

const KEY_PREFIX = 'WinForge.';
const GROUP_KEY = 'WinForge.Menu';

// scope → HKCU\Software\Classes sub-path (relative to HKCU:\).
function scopePath(scope: Scope): string {
  switch (scope) {
    case 'AllFiles': return 'Software\\Classes\\*\\shell';
    case 'Directory': return 'Software\\Classes\\Directory\\shell';
    case 'DirectoryBackground': return 'Software\\Classes\\Directory\\Background\\shell';
    default: return 'Software\\Classes\\*\\shell';
  }
}

// scope → placeholder for the selected item inside the command.
function scopePlaceholder(scope: Scope): string {
  return scope === 'DirectoryBackground' ? '%V' : '%1';
}

function groupCommandStorePath(scope: Scope): string {
  return `Software\\Classes\\WinForge.CommandStore\\${scope}\\shell`;
}

function verbPath(a: ShellAction): string {
  return `${scopePath(a.scope)}\\${KEY_PREFIX}${a.id}`;
}

function displayLabel(a: ShellAction): string {
  return `${a.en} · ${a.zh}`;
}

// The command each verb launches: "<exe>" --page <alias> --path "<%1|%V>".
// $exe is resolved in PowerShell from the WinForge process path at write time.
function buildCommandExpr(a: ShellAction): string {
  const ph = scopePlaceholder(a.scope);
  // Emits a PS string expression concatenating the resolved exe path with args.
  return `('"' + $exe + '" --page ${a.pageAlias} --path "${ph}"')`;
}

// PS-single-quote escape.
const esc = (s: string) => s.replace(/'/g, "''");

// A PS prelude that resolves WinForge's own exe path into $exe.
const EXE_PRELUDE =
  `$exe = (Get-Process -Id $PID).Path; if(-not $exe){ $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }; `;

interface StatusRow { id: string; on: boolean }

// Build a script that reports, for every action, whether it is registered
// (either as a flat verb or as a grouped sub-command).
function statusScript(): string {
  const checks = ACTIONS.map((a) => {
    const flat = `HKCU:\\${verbPath(a)}\\command`;
    const grouped = `HKCU:\\${groupCommandStorePath(a.scope)}\\${KEY_PREFIX}${a.id}\\command`;
    return `[pscustomobject]@{id='${esc(a.id)}';on=((Test-Path '${esc(flat)}') -or (Test-Path '${esc(grouped)}'))}`;
  });
  return checks.join('; ');
}

// Register one action (idempotent): write MUIVerb + default label + optional Icon + command.
function registerActionScript(a: ShellAction): string {
  const vp = `HKCU:\\${verbPath(a)}`;
  const label = esc(displayLabel(a));
  const iconLine = a.icon
    ? `New-ItemProperty -Path '${esc(vp)}' -Name 'Icon' -Value '${esc(a.icon)}' -PropertyType String -Force | Out-Null; `
    : '';
  return (
    EXE_PRELUDE +
    `New-Item -Path '${esc(vp)}' -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(vp)}' -Name 'MUIVerb' -Value '${label}' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(vp)}' -Name '(default)' -Value '${label}' -PropertyType String -Force | Out-Null; ` +
    iconLine +
    `New-Item -Path '${esc(vp)}\\command' -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(vp)}\\command' -Name '(default)' -Value ${buildCommandExpr(a)} -PropertyType String -Force | Out-Null;`
  );
}

// Unregister one action: drop the flat verb and any grouped variant.
function unregisterActionScript(a: ShellAction): string {
  const vp = `HKCU:\\${verbPath(a)}`;
  const gp = `HKCU:\\${groupCommandStorePath(a.scope)}\\${KEY_PREFIX}${a.id}`;
  return (
    `Remove-Item -Path '${esc(vp)}' -Recurse -Force -ErrorAction SilentlyContinue; ` +
    `Remove-Item -Path '${esc(gp)}' -Recurse -Force -ErrorAction SilentlyContinue;`
  );
}

function registerAllScript(): string {
  return ACTIONS.map(registerActionScript).join(' ');
}

function unregisterAllScript(): string {
  const perAction = ACTIONS.map(unregisterActionScript).join(' ');
  const scopes: Scope[] = ['AllFiles', 'Directory', 'DirectoryBackground'];
  const groups = scopes
    .map((s) => {
      const parent = `HKCU:\\${scopePath(s)}\\${GROUP_KEY}`;
      const store = `HKCU:\\${groupCommandStorePath(s)}`;
      return (
        `Remove-Item -Path '${esc(parent)}' -Recurse -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item -Path '${esc(store)}' -Recurse -Force -ErrorAction SilentlyContinue;`
      );
    })
    .join(' ');
  return perAction + ' ' + groups;
}

// Group all enabled actions for a scope under one "WinForge" parent flyout.
function registerGroupedScript(scope: Scope): string {
  const inScope = ACTIONS.filter((a) => a.scope === scope);
  const parent = `HKCU:\\${scopePath(scope)}\\${GROUP_KEY}`;
  const subList = inScope.map((a) => `${KEY_PREFIX}${a.id}`).join(';');

  // Remove flat verbs for this scope so they don't show twice.
  const clearFlat = inScope
    .map((a) => `Remove-Item -Path 'HKCU:\\${esc(verbPath(a))}' -Recurse -Force -ErrorAction SilentlyContinue;`)
    .join(' ');

  const parentDef =
    `New-Item -Path '${esc(parent)}' -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(parent)}' -Name 'MUIVerb' -Value 'WinForge' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(parent)}' -Name 'Icon' -Value 'imageres.dll,-3' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(parent)}' -Name 'SubCommands' -Value '${esc(subList)}' -PropertyType String -Force | Out-Null;`;

  const children = inScope
    .map((a) => {
      const cp = `HKCU:\\${groupCommandStorePath(scope)}\\${KEY_PREFIX}${a.id}`;
      const label = esc(displayLabel(a));
      const iconLine = a.icon
        ? `New-ItemProperty -Path '${esc(cp)}' -Name 'Icon' -Value '${esc(a.icon)}' -PropertyType String -Force | Out-Null; `
        : '';
      return (
        `New-Item -Path '${esc(cp)}' -Force | Out-Null; ` +
        `New-ItemProperty -Path '${esc(cp)}' -Name 'MUIVerb' -Value '${label}' -PropertyType String -Force | Out-Null; ` +
        iconLine +
        `New-Item -Path '${esc(cp)}\\command' -Force | Out-Null; ` +
        `New-ItemProperty -Path '${esc(cp)}\\command' -Name '(default)' -Value ${buildCommandExpr(a)} -PropertyType String -Force | Out-Null;`
      );
    })
    .join(' ');

  return EXE_PRELUDE + clearFlat + ' ' + parentDef + ' ' + children;
}

function scopeLabel(scope: Scope, t: (k: string) => string): string {
  switch (scope) {
    case 'AllFiles': return t('shellmenu.scopeFiles');
    case 'Directory': return t('shellmenu.scopeFolders');
    default: return t('shellmenu.scopeBackground');
  }
}

export function ShellMenuModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const desktop = isTauri();

  const [state, setState] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setBusy('refresh'); setErr(null);
    try {
      const rows = await runPowershellJson<StatusRow>(statusScript());
      const next: Record<string, boolean> = {};
      for (const r of rows) {
        if (r && typeof r.id === 'string') next[r.id] = !!r.on;
      }
      setState(next);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  }, [desktop]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Ensure a non-zero exit with stderr surfaces as an error.
  const run = async (script: string): Promise<CommandOutput> => {
    const res = await runPowershell(script);
    if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    return res;
  };

  const toggleAction = async (a: ShellAction) => {
    if (!desktop || busy) return;
    const currentlyOn = state[a.id] === true;
    setBusy(a.id); setErr(null); setNotice(null);
    try {
      await run(currentlyOn ? unregisterActionScript(a) : registerActionScript(a));
      setNotice(currentlyOn ? t('shellmenu.removedOne') : t('shellmenu.addedOne'));
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const registerAll = async () => {
    if (!desktop || busy) return;
    setBusy('all-on'); setErr(null); setNotice(null);
    try {
      await run(registerAllScript());
      setNotice(t('shellmenu.registeredAll'));
      await refresh();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); await refresh(); }
    finally { setBusy(''); }
  };

  const removeAll = async () => {
    if (!desktop || busy) return;
    setBusy('all-off'); setErr(null); setNotice(null);
    try {
      await run(unregisterAllScript());
      setNotice(t('shellmenu.removedAll'));
      await refresh();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); await refresh(); }
    finally { setBusy(''); }
  };

  const groupAll = async () => {
    if (!desktop || busy) return;
    setBusy('group'); setErr(null); setNotice(null);
    try {
      const scopes: Scope[] = ['AllFiles', 'Directory', 'DirectoryBackground'];
      for (const s of scopes) {
        const anyEnabled = ACTIONS.some((a) => a.scope === s && state[a.id] === true);
        if (anyEnabled) await run(registerGroupedScript(s));
      }
      setNotice(t('shellmenu.grouped'));
      await refresh();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); await refresh(); }
    finally { setBusy(''); }
  };

  const total = ACTIONS.length;
  const activeCount = ACTIONS.reduce((n, a) => n + (state[a.id] === true ? 1 : 0), 0);

  const scopes: Scope[] = ['AllFiles', 'Directory', 'DirectoryBackground'];

  return (
    <div className="mod">
      <p className="count-note">{t('shellmenu.blurb')}</p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('shellmenu.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!desktop || !!busy} onClick={registerAll}>
          {busy === 'all-on' ? t('shellmenu.working') : t('shellmenu.registerAll')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={removeAll}>
          {busy === 'all-off' ? t('shellmenu.working') : t('shellmenu.removeAll')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={groupAll}>
          {busy === 'group' ? t('shellmenu.working') : t('shellmenu.groupSubmenu')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => void refresh()}>
          {busy === 'refresh' ? t('shellmenu.working') : t('shellmenu.refresh')}
        </button>
        <span className="count-note">{t('shellmenu.activeCount', { n: activeCount, total })}</span>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {notice && <p className="count-note" style={{ color: 'var(--accent)' }}>{notice}</p>}

      {scopes.map((s) => {
        const rows = ACTIONS.filter((a) => a.scope === s);
        return (
          <div className="panel" key={s} style={{ marginTop: 12 }}>
            <p className="label" style={{ fontWeight: 600, marginBottom: 6 }}>{scopeLabel(s, t)}</p>
            <div className="kv-list">
              {rows.map((a) => {
                const on = state[a.id] === true;
                return (
                  <div className="kv-row" key={a.id} style={{ alignItems: 'center' }}>
                    <span className="label">
                      {zh ? a.zh : a.en}
                      <span className="count-note" style={{ display: 'block' }}>
                        {t('shellmenu.rowDesc', { scope: scopeLabel(s, t) })}
                      </span>
                    </span>
                    <span className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={on ? 'dep-ok' : 'count-note'}>
                        {on ? t('shellmenu.inMenu') : t('shellmenu.notShown')}
                      </span>
                      <label className="chk" style={{ cursor: desktop && !busy ? 'pointer' : 'default' }}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!desktop || !!busy}
                          onChange={() => void toggleAction(a)}
                        />
                        {busy === a.id ? t('shellmenu.working') : on ? t('shellmenu.on') : t('shellmenu.off')}
                      </label>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <p className="count-note" style={{ marginTop: 12 }}>{t('shellmenu.foot')}</p>
    </div>
  );
}
