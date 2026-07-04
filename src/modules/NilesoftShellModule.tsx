import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershell,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// Native module — drives Nilesoft Shell (winget id Nilesoft.Shell), the native replacement
// for the Windows right-click menu. Registers / unregisters / reloads the shell extension via
// shell.exe verbs, restarts Explorer, checks registration status, and reads/edits the shell.nss
// config next to shell.exe (with a timestamped backup before every write) plus a curated snippet
// gallery, a structured builder (menu items / theme / settings), preset config templates,
// import/export, and backup listing + restore. Full parity with the WinForge C# module.

// A clean, safe default shell.nss (mirrors the WinForge bundled template).
const DEFAULT_CONFIG = `// shell.nss — Nilesoft Shell configuration (restored by WinForge)
// Docs: https://nilesoft.org/docs
settings
{
    priority = 1
    exclude.where = !process.is_explorer
    showdelay = 200
    modify.remove.duplicate = 1
    tip.enabled = true
}

// Modern dark theme
theme
{
    name = "modern"
    dark = auto
    background { opacity = auto }
}

// Keep Windows default items available under a sub-menu
menu(type='*' mode='multiple' title='More options' image=\\inherit)
{
}
`;

interface SnippetDef {
  key: string;
  code: string;
}

// Curated snippet/template gallery — inserted at the cursor in the editor.
const SNIPPETS: SnippetDef[] = [
  {
    key: 'snipDarkTheme',
    code: `theme
{
    name = "modern"
    dark = auto
    background { opacity = auto }
}
`,
  },
  {
    key: 'snipCopyPath',
    code: `item(type='file|dir' title='Copy as path' image=
    cmd-clipboard='"' + sel.path + '"')
`,
  },
  {
    key: 'snipPowershellHere',
    code: `item(title='PowerShell here' image=
    admin=false
    cmd='powershell.exe' args='-NoExit -Command "Set-Location -LiteralPath \\'' + sel.dir + '\\'"')
`,
  },
  {
    key: 'snipTerminalAdmin',
    code: `item(title='Terminal (Admin) here' image=
    admin=true
    cmd='wt.exe' args='-d "' + sel.dir + '"')
`,
  },
  {
    key: 'snipTakeOwnership',
    code: `item(type='file|dir' title='Take ownership' image= admin=true
    cmd='cmd.exe' args='/c takeown /f "' + sel.path + '" /r /d y && icacls "' + sel.path + '" /grant administrators:F /t')
`,
  },
  {
    key: 'snipRunAsAdmin',
    code: `item(type='file' title='Run as administrator' image= admin=true
    cmd=sel.path)
`,
  },
  {
    key: 'snipOpenNotepad',
    code: `item(type='file' title='Open with Notepad' image=
    cmd='notepad.exe' args='"' + sel.path + '"')
`,
  },
  {
    key: 'snipMenuGroup',
    code: `menu(title='My tools' image=)
{
    // put item(...) entries here
}
`,
  },
  {
    key: 'snipHideDefaults',
    code: `modify(where=this.id(id.give_access_to, id.restore_previous_versions) vis=hidden)
`,
  },
  {
    key: 'snipSettings',
    code: `settings
{
    priority = 1
    exclude.where = !process.is_explorer
    showdelay = 200
    tip.enabled = true
}
`,
  },
];

// Full-config preset templates the source ships (clean default + focused variants).
interface PresetDef {
  key: string;
  code: string;
}
const PRESETS: PresetDef[] = [
  { key: 'presetDefault', code: DEFAULT_CONFIG },
  {
    key: 'presetMinimal',
    code: `// Minimal — themed menu, keep Windows items in a sub-menu
settings
{
    priority = 1
    exclude.where = !process.is_explorer
}
theme
{
    name = "white"
    dark = auto
}
menu(type='*' mode='multiple' title='More options' image=\\inherit)
{
}
`,
  },
  {
    key: 'presetPower',
    code: `// Power-user — dark theme + developer entries
settings
{
    priority = 1
    exclude.where = !process.is_explorer
    showdelay = 150
    modify.remove.duplicate = 1
}
theme
{
    name = "modern"
    dark = auto
    background { opacity = auto }
}
item(type='file|dir' title='Copy as path' image=
    cmd-clipboard='"' + sel.path + '"')
item(title='Terminal here' image=
    cmd='wt.exe' args='-d "' + sel.dir + '"')
item(title='PowerShell (Admin) here' image= admin=true
    cmd='powershell.exe' args='-NoExit -Command "Set-Location -LiteralPath \\'' + sel.dir + '\\'"')
menu(type='*' mode='multiple' title='More options' image=\\inherit)
{
}
`,
  },
];

// Built-in theme choices exposed by the theme picker.
const THEME_NAMES = ['modern', 'classic', 'white', 'black'] as const;
type ThemeName = (typeof THEME_NAMES)[number];
const DARK_MODES = ['auto', 'true', 'false'] as const;
type DarkMode = (typeof DARK_MODES)[number];

// Escape a string for a single-quoted PowerShell literal.
const psq = (s: string) => s.replace(/'/g, "''");
// Escape a value for a single-quoted .nss string literal.
const nssq = (s: string) => s.replace(/'/g, "\\'");

interface BackupRow {
  Name: string;
  FullName: string;
  Length: number;
  LastWriteTime: string;
}

export function NilesoftShellModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [config, setConfig] = useState('');
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [installDir, setInstallDir] = useState<string | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [opsFilter, setOpsFilter] = useState('');
  // Cursor position captured from the editor for snippet insertion.
  const [caret, setCaret] = useState(0);

  // Structured builder state (menu item / theme / settings).
  const [itemTitle, setItemTitle] = useState('');
  const [itemType, setItemType] = useState<'file' | 'dir' | 'file|dir' | '*'>('file|dir');
  const [itemCmd, setItemCmd] = useState('');
  const [itemArgs, setItemArgs] = useState('"' + '$sel.path' + '"');
  const [itemAdmin, setItemAdmin] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>('modern');
  const [darkMode, setDarkMode] = useState<DarkMode>('auto');
  const [setPriority, setSetPriority] = useState('1');
  const [setDelay, setSetDelay] = useState('200');
  const [setTips, setSetTips] = useState(true);

  // Import/export paths.
  const [importPath, setImportPath] = useState('');
  const [exportPath, setExportPath] = useState('');

  // Backups list.
  const [backups, setBackups] = useState<BackupRow[]>([]);

  // Given the resolved shell.exe path, the install dir is its parent, and shell.nss sits beside it.
  const dirOf = (exePath: string): string => {
    const norm = exePath.replace(/\//g, '\\');
    const idx = norm.lastIndexOf('\\');
    return idx > 0 ? norm.slice(0, idx) : norm;
  };
  const nssOf = (exePath: string): string => `${dirOf(exePath)}\\shell.nss`;

  const show = (res: CommandOutput, label: string) => {
    const body = res.stdout.trim() || res.stderr.trim() || t('nilesoft.exit', { code: res.code });
    setOut(`> ${label}\n${body}`);
  };

  // ---- status: install dir + registration probe ----
  const refreshStatus = async (exePath: string) => {
    if (!desktop) return;
    const dir = dirOf(exePath);
    setInstallDir(dir);
    try {
      // Nilesoft registers a CLSID for the current user + drops shell.dll beside shell.exe.
      const res = await runPowershell(
        `$clsid = Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\CLSID\\{3B1D0DA3-7A3F-4A29-9C26-9181A2C0B8F0}'; ` +
          `$dll = Test-Path -LiteralPath '${psq(dir)}\\shell.dll'; ` +
          `if ($clsid -or $dll) { 'yes' } else { 'no' }`,
      );
      setRegistered(res.stdout.trim() === 'yes');
    } catch {
      setRegistered(null);
    }
  };

  // ---- lifecycle verbs (shell.exe -register / -unregister / -restart) ----
  const runVerb = async (exePath: string, args: string[], label: string, tag: string) => {
    if (!desktop) return;
    setBusy(tag);
    setErr(null);
    setOut('');
    try {
      const res = await runCommand(exePath, args);
      show(res, label);
      await refreshStatus(exePath);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const register = (exePath: string) =>
    runVerb(exePath, ['-register', '-treat', '-restart'], 'shell.exe -register -treat -restart', 'reg');
  const unregister = (exePath: string) => {
    if (!window.confirm(t('nilesoft.confirmUnregister'))) return;
    runVerb(exePath, ['-unregister', '-restart'], 'shell.exe -unregister -restart', 'unreg');
  };
  const reload = (exePath: string) =>
    runVerb(exePath, ['-restart'], 'shell.exe -restart', 'reload');

  const restartExplorer = async () => {
    if (!desktop) return;
    if (!window.confirm(t('nilesoft.confirmRestartExplorer'))) return;
    setBusy('explorer');
    setErr(null);
    setOut('');
    try {
      await runPowershell(
        'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; Start-Process explorer.exe',
      );
      setOut(t('nilesoft.explorerRestarted'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const recheck = async (exePath: string) => {
    if (!desktop) return;
    setBusy('recheck');
    setErr(null);
    try {
      await loadConfig(exePath);
      await refreshStatus(exePath);
      setOut(t('nilesoft.rechecked'));
    } finally {
      setBusy('');
    }
  };

  // ---- config editor (read / write shell.nss via PowerShell, backup first) ----
  const loadConfig = async (exePath: string) => {
    if (!desktop) return;
    const path = nssOf(exePath);
    setConfigPath(path);
    setBusy('load');
    setErr(null);
    try {
      const res = await runPowershell(
        `if (Test-Path -LiteralPath '${psq(path)}') { Get-Content -LiteralPath '${psq(path)}' -Raw -Encoding UTF8 } else { '' }`,
      );
      const text = res.stdout;
      setConfig(text.length > 0 ? text : DEFAULT_CONFIG);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Revert the editor to what is currently on disk (discard unsaved edits).
  const revertConfig = async (exePath: string) => {
    await loadConfig(exePath);
    setOut(t('nilesoft.reverted'));
  };

  // Open an arbitrary .nss file into the editor (does NOT change the live save target).
  const openNss = async () => {
    if (!desktop || !importPath.trim()) return;
    setBusy('open');
    setErr(null);
    setOut('');
    try {
      const p = importPath.trim();
      const res = await runPowershell(
        `if (Test-Path -LiteralPath '${psq(p)}') { Get-Content -LiteralPath '${psq(p)}' -Raw -Encoding UTF8 } else { throw 'not found' }`,
      );
      setConfig(res.stdout);
      setConfigPath(p);
      setOut(t('nilesoft.opened', { path: p }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Write the editor text to an arbitrary path (export).
  const exportConfig = async () => {
    if (!desktop || !exportPath.trim()) return;
    setBusy('export');
    setErr(null);
    setOut('');
    try {
      const p = exportPath.trim();
      const b64 = btoa(unescape(encodeURIComponent(config)));
      const script =
        `$p='${psq(p)}'; ` +
        `$bytes=[Convert]::FromBase64String('${b64}'); ` +
        `$text=[System.Text.Encoding]::UTF8.GetString($bytes); ` +
        `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true))); ` +
        `Write-Output 'saved'`;
      const res = await runPowershell(script);
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || t('nilesoft.exit', { code: res.code }));
      }
      setOut(t('nilesoft.exported', { path: p }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const saveConfig = async (exePath: string, thenReload: boolean) => {
    if (!desktop) return;
    const path = configPath ?? nssOf(exePath);
    setBusy(thenReload ? 'savereload' : 'save');
    setErr(null);
    setOut('');
    try {
      // Timestamped backup into <install>\backups before overwriting.
      const backupDir = `${dirOf(exePath)}\\backups`;
      const b64 = btoa(unescape(encodeURIComponent(config)));
      const script =
        `$p='${psq(path)}'; ` +
        `if (Test-Path -LiteralPath $p) { ` +
        `$bd='${psq(backupDir)}'; New-Item -ItemType Directory -Force -Path $bd | Out-Null; ` +
        `$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; ` +
        `Copy-Item -LiteralPath $p -Destination (Join-Path $bd ("shell.$stamp.nss.bak")) -Force } ` +
        `$bytes=[Convert]::FromBase64String('${b64}'); ` +
        `$text=[System.Text.Encoding]::UTF8.GetString($bytes); ` +
        `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true))); ` +
        `Write-Output 'saved'`;
      const res = await runPowershell(script);
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || t('nilesoft.exit', { code: res.code }));
      }
      setOut(t('nilesoft.saved', { path }));
      if (thenReload) {
        const r = await runCommand(exePath, ['-restart']);
        show(r, 'shell.exe -restart');
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Take a timestamped backup of the live shell.nss right now.
  const backupNow = async (exePath: string) => {
    if (!desktop) return;
    setBusy('backup');
    setErr(null);
    setOut('');
    try {
      const path = nssOf(exePath);
      const backupDir = `${dirOf(exePath)}\\backups`;
      const script =
        `$p='${psq(path)}'; ` +
        `if (-not (Test-Path -LiteralPath $p)) { throw 'shell.nss not found' } ` +
        `$bd='${psq(backupDir)}'; New-Item -ItemType Directory -Force -Path $bd | Out-Null; ` +
        `$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; ` +
        `$dest=Join-Path $bd ("shell.$stamp.nss.bak"); ` +
        `Copy-Item -LiteralPath $p -Destination $dest -Force; ` +
        `Write-Output $dest`;
      const res = await runPowershell(script);
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || t('nilesoft.exit', { code: res.code }));
      }
      setOut(t('nilesoft.backedUp', { path: res.stdout.trim() }));
      await listBackups(exePath);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // List existing backups (newest first).
  const listBackups = async (exePath: string) => {
    if (!desktop) return;
    setBusy('list');
    setErr(null);
    try {
      const backupDir = `${dirOf(exePath)}\\backups`;
      const rows = await runPowershellJson<BackupRow>(
        `if (Test-Path -LiteralPath '${psq(backupDir)}') { ` +
          `Get-ChildItem -LiteralPath '${psq(backupDir)}' -Filter 'shell.*.nss.bak' | ` +
          `Sort-Object LastWriteTime -Descending | ` +
          `Select-Object Name, FullName, Length, @{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}} }`,
      );
      setBackups(rows);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Restore a chosen backup into the live shell.nss (backs current up first, via saveConfig path).
  const restoreBackup = async (exePath: string, backup: BackupRow) => {
    if (!desktop) return;
    if (!window.confirm(t('nilesoft.confirmRestoreBackup', { name: backup.Name }))) return;
    setBusy('restore-' + backup.Name);
    setErr(null);
    setOut('');
    try {
      const path = nssOf(exePath);
      const backupDir = `${dirOf(exePath)}\\backups`;
      const script =
        `$src='${psq(backup.FullName)}'; $p='${psq(path)}'; ` +
        `if (-not (Test-Path -LiteralPath $src)) { throw 'backup not found' } ` +
        `if (Test-Path -LiteralPath $p) { ` +
        `$bd='${psq(backupDir)}'; New-Item -ItemType Directory -Force -Path $bd | Out-Null; ` +
        `$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; ` +
        `Copy-Item -LiteralPath $p -Destination (Join-Path $bd ("shell.$stamp.nss.bak")) -Force } ` +
        `Copy-Item -LiteralPath $src -Destination $p -Force; ` +
        `Write-Output 'restored'`;
      const res = await runPowershell(script);
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || t('nilesoft.exit', { code: res.code }));
      }
      setOut(t('nilesoft.restored', { name: backup.Name }));
      await loadConfig(exePath);
      await listBackups(exePath);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const restoreDefault = () => {
    if (!window.confirm(t('nilesoft.confirmRestoreDefault'))) return;
    setConfig(DEFAULT_CONFIG);
    setOut(t('nilesoft.defaultLoaded'));
  };

  const insertSnippet = (code: string) => {
    const text = config;
    let pos = caret;
    if (pos < 0 || pos > text.length) pos = text.length;
    const before = text.slice(0, pos);
    const needsNl = pos > 0 && before.charAt(before.length - 1) !== '\n';
    const block = `${needsNl ? '\n' : ''}${code}\n`;
    setConfig(text.slice(0, pos) + block + text.slice(pos));
    setCaret(pos + block.length);
  };

  const loadPreset = (code: string) => {
    setConfig(code);
    setOut(t('nilesoft.presetLoaded'));
  };

  // ---- structured builders → generate .nss and insert at cursor ----
  const buildItem = (): string => {
    const title = itemTitle.trim() || 'My item';
    const admin = itemAdmin ? ' admin=true' : '';
    const cmd = itemCmd.trim() ? ` cmd='${nssq(itemCmd.trim())}'` : ' cmd=sel.path';
    const args = itemArgs.trim() ? `\n    args='${nssq(itemArgs.trim())}'` : '';
    return `item(type='${itemType}' title='${nssq(title)}' image=${admin}${cmd}${args})`;
  };
  const insertItem = () => insertSnippet(buildItem());

  const buildTheme = (): string =>
    `theme\n{\n    name = "${themeName}"\n    dark = ${darkMode}\n    background { opacity = auto }\n}`;
  const insertTheme = () => insertSnippet(buildTheme());

  const buildSettings = (): string => {
    const pr = setPriority.trim() || '1';
    const dl = setDelay.trim() || '200';
    return `settings\n{\n    priority = ${pr}\n    exclude.where = !process.is_explorer\n    showdelay = ${dl}\n    tip.enabled = ${setTips ? 'true' : 'false'}\n}`;
  };
  const insertSettings = () => insertSnippet(buildSettings());

  // Shared config editor textarea (used inside multiple tabs).
  const editorArea = (
    <textarea
      className="hosts-edit"
      spellCheck={false}
      value={config}
      onChange={(e) => {
        setConfig(e.target.value);
        setCaret(e.target.selectionStart);
      }}
      onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
      onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
      onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
      placeholder={t('nilesoft.editorPlaceholder')}
      style={{ width: '100%', minHeight: 220, fontFamily: 'monospace', marginTop: 8 }}
    />
  );

  const feedback = (
    <>
      {err && <pre className="cmd-out error">{err}</pre>}
      {out && <pre className="cmd-out">{out}</pre>}
    </>
  );

  // ---- tab renderers (each receives the resolved shell.exe path) ----
  const lifecycleTab = (path: string) => (
    <>
      <div className="panel">
        <div className="label">{t('nilesoft.status')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {installDir
            ? t('nilesoft.installedAt', {
                dir: installDir,
                reg:
                  registered === null
                    ? t('nilesoft.regUnknown')
                    : registered
                      ? t('nilesoft.regYes')
                      : t('nilesoft.regNo'),
              })
            : t('nilesoft.statusUnknown')}
        </p>
      </div>

      <div className="panel">
        <div className="label">{t('nilesoft.lifecycle')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.adminNote')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" disabled={!desktop || !!busy} onClick={() => register(path)}>
            {busy === 'reg' ? t('nilesoft.working') : t('nilesoft.register')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => unregister(path)}>
            {busy === 'unreg' ? t('nilesoft.working') : t('nilesoft.unregister')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => reload(path)}>
            {busy === 'reload' ? t('nilesoft.working') : t('nilesoft.reload')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={restartExplorer}>
            {busy === 'explorer' ? t('nilesoft.working') : t('nilesoft.restartExplorer')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => recheck(path)}>
            {busy === 'recheck' ? t('nilesoft.working') : t('nilesoft.recheck')}
          </button>
        </div>
      </div>
      {feedback}
    </>
  );

  const editorTab = (path: string) => (
    <>
      <div className="panel">
        <div className="label">{t('nilesoft.editorHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {configPath ? t('nilesoft.editing', { path: configPath }) : t('nilesoft.configHint')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => loadConfig(path)}>
            {busy === 'load' ? t('nilesoft.working') : t('nilesoft.loadConfig')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => revertConfig(path)}>
            {t('nilesoft.revert')}
          </button>
          <button className="mini primary" disabled={!desktop || !!busy} onClick={() => saveConfig(path, false)}>
            {busy === 'save' ? t('nilesoft.working') : t('nilesoft.save')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => saveConfig(path, true)}>
            {busy === 'savereload' ? t('nilesoft.working') : t('nilesoft.saveReload')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => backupNow(path)}>
            {busy === 'backup' ? t('nilesoft.working') : t('nilesoft.backup')}
          </button>
          <button className="mini" disabled={!!busy} onClick={restoreDefault}>
            {t('nilesoft.restoreDefault')}
          </button>
        </div>
        {editorArea}
      </div>

      {/* Structured builder */}
      <div className="panel">
        <div className="label">{t('nilesoft.builderHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.builderHint')}</p>

        {/* Menu item */}
        <div className="kv-list">
          <div className="kv-row">
            <div className="value" style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t('nilesoft.biItem')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                <input
                  className="mod-search"
                  placeholder={t('nilesoft.biItemTitle')}
                  value={itemTitle}
                  onChange={(e) => setItemTitle(e.target.value)}
                />
                <select className="mod-search" value={itemType} onChange={(e) => setItemType(e.target.value as typeof itemType)}>
                  <option value="file|dir">file|dir</option>
                  <option value="file">file</option>
                  <option value="dir">dir</option>
                  <option value="*">*</option>
                </select>
                <input
                  className="mod-search"
                  placeholder={t('nilesoft.biItemCmd')}
                  value={itemCmd}
                  onChange={(e) => setItemCmd(e.target.value)}
                />
                <input
                  className="mod-search"
                  placeholder={t('nilesoft.biItemArgs')}
                  value={itemArgs}
                  onChange={(e) => setItemArgs(e.target.value)}
                />
                <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={itemAdmin} onChange={(e) => setItemAdmin(e.target.checked)} />
                  {t('nilesoft.biAdmin')}
                </label>
              </div>
            </div>
            <button className="mini" disabled={!!busy} onClick={insertItem}>
              {t('nilesoft.insert')}
            </button>
          </div>

          {/* Theme */}
          <div className="kv-row">
            <div className="value" style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t('nilesoft.biTheme')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                <select className="mod-search" value={themeName} onChange={(e) => setThemeName(e.target.value as ThemeName)}>
                  {THEME_NAMES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <select className="mod-search" value={darkMode} onChange={(e) => setDarkMode(e.target.value as DarkMode)}>
                  {DARK_MODES.map((d) => (
                    <option key={d} value={d}>{t(`nilesoft.dark_${d}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className="mini" disabled={!!busy} onClick={insertTheme}>
              {t('nilesoft.insert')}
            </button>
          </div>

          {/* Settings */}
          <div className="kv-row">
            <div className="value" style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t('nilesoft.biSettings')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                <input
                  className="mod-search"
                  style={{ maxWidth: 140 }}
                  placeholder={t('nilesoft.biPriority')}
                  value={setPriority}
                  onChange={(e) => setSetPriority(e.target.value)}
                />
                <input
                  className="mod-search"
                  style={{ maxWidth: 160 }}
                  placeholder={t('nilesoft.biDelay')}
                  value={setDelay}
                  onChange={(e) => setSetDelay(e.target.value)}
                />
                <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={setTips} onChange={(e) => setSetTips(e.target.checked)} />
                  {t('nilesoft.biTips')}
                </label>
              </div>
            </div>
            <button className="mini" disabled={!!busy} onClick={insertSettings}>
              {t('nilesoft.insert')}
            </button>
          </div>
        </div>
      </div>

      {/* Import / export */}
      <div className="panel">
        <div className="label">{t('nilesoft.ioHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.ioHint')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            placeholder={t('nilesoft.importPathPlaceholder')}
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
          />
          <button className="mini" disabled={!desktop || !!busy || !importPath.trim()} onClick={() => openNss()}>
            {busy === 'open' ? t('nilesoft.working') : t('nilesoft.openNss')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <input
            className="mod-search"
            placeholder={t('nilesoft.exportPathPlaceholder')}
            value={exportPath}
            onChange={(e) => setExportPath(e.target.value)}
          />
          <button className="mini" disabled={!desktop || !!busy || !exportPath.trim()} onClick={exportConfig}>
            {busy === 'export' ? t('nilesoft.working') : t('nilesoft.exportNss')}
          </button>
        </div>
      </div>

      {/* Preset templates */}
      <div className="panel">
        <div className="label">{t('nilesoft.presetsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.presetsHint')}</p>
        <div className="kv-list">
          {PRESETS.map((p) => (
            <div className="kv-row" key={p.key}>
              <div className="value" style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t(`nilesoft.${p.key}Title`)}</div>
                <div className="count-note" style={{ marginTop: 2 }}>{t(`nilesoft.${p.key}Desc`)}</div>
              </div>
              <button className="mini" disabled={!!busy} onClick={() => loadPreset(p.code)}>
                {t('nilesoft.usePreset')}
              </button>
            </div>
          ))}
        </div>
      </div>
      {feedback}
    </>
  );

  const snippetsTab = () => (
    <>
      <div className="panel">
        <div className="label">{t('nilesoft.snippetsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.snippetsHint')}</p>
        <div className="kv-list">
          {SNIPPETS.map((s) => (
            <div className="kv-row" key={s.key}>
              <div className="value" style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t(`nilesoft.${s.key}Title`)}</div>
                <div className="count-note" style={{ marginTop: 2 }}>{t(`nilesoft.${s.key}Desc`)}</div>
              </div>
              <button className="mini" disabled={!!busy} onClick={() => insertSnippet(s.code)}>
                {t('nilesoft.insert')}
              </button>
            </div>
          ))}
        </div>
      </div>
      {feedback}
    </>
  );

  const backupsTab = (path: string) => (
    <>
      <div className="panel">
        <div className="label">{t('nilesoft.backupsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.backupsHint')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => listBackups(path)}>
            {busy === 'list' ? t('nilesoft.working') : t('nilesoft.listBackups')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => backupNow(path)}>
            {busy === 'backup' ? t('nilesoft.working') : t('nilesoft.backupNow')}
          </button>
          <span className="count-note">{t('nilesoft.backupCount', { n: backups.length })}</span>
        </div>
        {backups.length === 0 ? (
          <p className="count-note">{t('nilesoft.noBackups')}</p>
        ) : (
          <div className="kv-list">
            {backups.map((b) => (
              <div className="kv-row" key={b.FullName}>
                <div className="value" style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontFamily: 'monospace' }}>{b.Name}</div>
                  <div className="count-note" style={{ marginTop: 2 }}>
                    {t('nilesoft.backupMeta', { time: b.LastWriteTime, bytes: b.Length })}
                  </div>
                </div>
                <button
                  className="mini"
                  disabled={!desktop || !!busy}
                  onClick={() => restoreBackup(path, b)}
                >
                  {busy === 'restore-' + b.Name ? t('nilesoft.working') : t('nilesoft.restoreBackup')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {feedback}
    </>
  );

  // Operations cards — a filterable list mirroring the C# operations catalog.
  interface OpRow {
    key: string;
    label: string;
    haystack: string;
    danger?: boolean;
    run: (path: string) => void;
  }
  const opsTab = (path: string) => {
    const ops: OpRow[] = [
      { key: 'nssRegister', label: t('nilesoft.register'), haystack: 'register install hook enable', run: (p) => register(p) },
      { key: 'nssUnregister', label: t('nilesoft.unregister'), haystack: 'unregister disable remove uninstall', danger: true, run: (p) => unregister(p) },
      { key: 'nssReload', label: t('nilesoft.reload'), haystack: 'reload refresh apply restart', run: (p) => reload(p) },
      { key: 'nssRestartExplorer', label: t('nilesoft.restartExplorer'), haystack: 'explorer restart taskbar refresh', danger: true, run: () => restartExplorer() },
      { key: 'nssBackup', label: t('nilesoft.backup'), haystack: 'backup snapshot save copy', run: (p) => backupNow(p) },
      { key: 'nssRestoreDefault', label: t('nilesoft.restoreDefault'), haystack: 'restore default reset template', danger: true, run: () => restoreDefault() },
    ];
    const q = opsFilter.trim().toLowerCase();
    const shown = q ? ops.filter((o) => (o.label + ' ' + o.haystack).toLowerCase().includes(q)) : ops;
    return (
      <>
        <div className="panel">
          <div className="label">{t('nilesoft.opsHeader')}</div>
          <ModuleToolbarSearch value={opsFilter} onChange={setOpsFilter} placeholder={t('nilesoft.opsFilter')} />
          <div className="kv-list">
            {shown.map((o) => (
              <div className="kv-row" key={o.key}>
                <div className="value" style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t(`nilesoft.${o.key}Title`)}</div>
                  <div className="count-note" style={{ marginTop: 2 }}>{t(`nilesoft.${o.key}Desc`)}</div>
                </div>
                <button
                  className={`mini${o.danger ? ' danger' : ''}`}
                  disabled={!desktop || !!busy}
                  onClick={() => o.run(path)}
                >
                  {o.label}
                </button>
              </div>
            ))}
          </div>
        </div>
        {feedback}
      </>
    );
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('nilesoft.desktopOnly')}</p>
      )}

      <DependencyGate tool="shell" preferId="Nilesoft.Shell" query="nilesoft shell">
        {(path) => (
          <ModuleTabs
            tabs={[
              { id: 'lifecycle', en: 'Lifecycle', zh: '生命週期', render: () => lifecycleTab(path) },
              { id: 'editor', en: 'Editor', zh: '編輯器', render: () => editorTab(path) },
              { id: 'snippets', en: 'Snippets', zh: '片語', render: () => snippetsTab() },
              { id: 'ops', en: 'Operations', zh: '操作', render: () => opsTab(path) },
              { id: 'backups', en: 'Backups', zh: '備份', render: () => backupsTab(path) },
            ]}
          />
        )}
      </DependencyGate>
    </div>
  );
}

// Small local search input (avoids pulling a whole toolbar for one field).
function ModuleToolbarSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="mod-toolbar" style={{ marginTop: 4 }}>
      <input
        className="mod-search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
