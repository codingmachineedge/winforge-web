import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershell,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives Nilesoft Shell (winget id Nilesoft.Shell), the native replacement
// for the Windows right-click menu. Registers / unregisters / reloads the shell extension via
// shell.exe verbs, restarts Explorer, and reads/edits the shell.nss config next to shell.exe
// (with a timestamped backup before every write) plus a curated snippet gallery.

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

// Escape a string for a single-quoted PowerShell literal.
const psq = (s: string) => s.replace(/'/g, "''");

export function NilesoftShellModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [config, setConfig] = useState('');
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  // Cursor position captured from the editor for snippet insertion.
  const [caret, setCaret] = useState(0);

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

  // ---- lifecycle verbs (shell.exe -register / -unregister / -restart) ----
  const runVerb = async (exePath: string, args: string[], label: string, tag: string) => {
    if (!desktop) return;
    setBusy(tag);
    setErr(null);
    setOut('');
    try {
      const res = await runCommand(exePath, args);
      show(res, label);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const register = (exePath: string) =>
    runVerb(exePath, ['-register', '-treat', '-restart'], 'shell.exe -register -treat -restart', 'reg');
  const unregister = (exePath: string) =>
    runVerb(exePath, ['-unregister', '-restart'], 'shell.exe -unregister -restart', 'unreg');
  const reload = (exePath: string) =>
    runVerb(exePath, ['-restart'], 'shell.exe -restart', 'reload');

  const restartExplorer = async () => {
    if (!desktop) return;
    setBusy('explorer');
    setErr(null);
    setOut('');
    try {
      await runPowershell('Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; Start-Process explorer.exe');
      setOut(t('nilesoft.explorerRestarted'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
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

  const restoreDefault = () => setConfig(DEFAULT_CONFIG);

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

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('nilesoft.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('nilesoft.desktopOnly')}</p>
      )}

      <DependencyGate tool="shell" preferId="Nilesoft.Shell" query="nilesoft shell">
        {(path) => (
          <>
            {/* Lifecycle */}
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
              </div>
            </div>

            {/* Config editor */}
            <div className="panel">
              <div className="label">{t('nilesoft.editorHeader')}</div>
              <p className="count-note" style={{ marginTop: 0 }}>
                {configPath ? t('nilesoft.editing', { path: configPath }) : t('nilesoft.configHint')}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => loadConfig(path)}>
                  {busy === 'load' ? t('nilesoft.working') : t('nilesoft.loadConfig')}
                </button>
                <button className="mini primary" disabled={!desktop || !!busy} onClick={() => saveConfig(path, false)}>
                  {busy === 'save' ? t('nilesoft.working') : t('nilesoft.save')}
                </button>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => saveConfig(path, true)}>
                  {busy === 'savereload' ? t('nilesoft.working') : t('nilesoft.saveReload')}
                </button>
                <button className="mini" disabled={!!busy} onClick={restoreDefault}>
                  {t('nilesoft.restoreDefault')}
                </button>
              </div>
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
            </div>

            {/* Snippet gallery */}
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

            {err && <pre className="cmd-out error">{err}</pre>}
            {out && <pre className="cmd-out">{out}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
