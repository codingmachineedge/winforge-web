import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a faithful web port of WinForge's VsCodeModule / VsCodeService.
// Drives the Visual Studio Code `code` CLI through the desktop backend: open files/
// folders/workspaces (same / new / reuse / add window), diff two files, 4-way merge,
// go-to file:line, open settings.json & keybindings.json, open a profile, start the
// remote tunnel, a full extension manager (list / install / uninstall / import set /
// export set), a Stable⇄Insiders target switch, an "open a terminal here" helper, a
// recent-workspaces list, and the operation library of captured reference verbs.
// Detached GUI launches use runCommand(exe, args); captured verbs (--version,
// --status, --list-extensions…) show their output inline.

interface Extension {
  id: string;
  version: string;
}

const RECENTS_KEY = 'winforge.vscode.recents';
const MAX_RECENTS = 12;

// Parse `code --list-extensions --show-versions` rows: publisher.name@1.2.3
function parseExtensions(out: string): Extension[] {
  const list: Extension[] = [];
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.includes(' ')) continue; // skip stray cmd noise
    const at = line.lastIndexOf('@');
    if (at > 0) list.push({ id: line.slice(0, at), version: line.slice(at + 1) });
    else list.push({ id: line, version: '' });
  }
  return list.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function Workbench({ codePath }: { codePath: string }) {
  const { t } = useTranslation();

  // The DependencyGate resolves the *stable* `code` shim. The Insiders toggle swaps the
  // invoked stem to `code-insiders` (resolved by cmd's own PATH lookup); when off we use
  // the exact resolved path so paths-with-spaces install locations still work.
  const [insiders, setInsiders] = useState(false);
  const exe = insiders ? 'code-insiders' : codePath;

  const [openPath, setOpenPath] = useState('');
  const [openMode, setOpenMode] = useState('0');
  const [diffA, setDiffA] = useState('');
  const [diffB, setDiffB] = useState('');
  const [mergeP1, setMergeP1] = useState('');
  const [mergeP2, setMergeP2] = useState('');
  const [mergeBase, setMergeBase] = useState('');
  const [mergeResult, setMergeResult] = useState('');
  const [gotoFile, setGotoFile] = useState('');
  const [gotoLine, setGotoLine] = useState(1);
  const [gotoCol, setGotoCol] = useState(1);
  const [profile, setProfile] = useState('');
  const [termPath, setTermPath] = useState('');
  const [extId, setExtId] = useState('');
  const [extFilter, setExtFilter] = useState('');
  const [importSet, setImportSet] = useState('');

  const [exts, setExts] = useState<Extension[] | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const append = (line: string) => setOut((prev) => (prev + line).slice(-20000));

  // Push a just-opened path onto the recent-workspaces list (most-recent first).
  const pushRecent = useCallback((p: string) => {
    const path = p.trim();
    if (!path) return;
    setRecents((prev) => {
      const next = [path, ...prev.filter((x) => x.toLowerCase() !== path.toLowerCase())].slice(0, MAX_RECENTS);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable */
      }
      return next;
    });
  }, []);

  const clearRecents = () => {
    setRecents([]);
    try {
      localStorage.removeItem(RECENTS_KEY);
    } catch {
      /* ignore */
    }
  };

  // Run a captured verb and show stdout/stderr inline.
  const runVerb = useCallback(
    async (label: string, args: string[], echo?: string): Promise<CommandOutput | null> => {
      setBusy(label);
      setErr(null);
      if (echo) append(`> ${insiders ? 'code-insiders' : 'code'} ${echo}\n`);
      try {
        const res = await runCommand(exe, args);
        const text = (res.stdout || res.stderr || `(exit ${res.code})`).trim();
        if (text) append(text + '\n');
        return res;
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
        return null;
      } finally {
        setBusy('');
      }
    },
    [exe, insiders],
  );

  // Launch a GUI window (detached). We still await so failures surface, but VS Code
  // returns immediately once the window is handed off.
  const launch = useCallback(
    async (label: string, args: string[], echo: string) => {
      setBusy(label);
      setErr(null);
      append(`> ${insiders ? 'code-insiders' : 'code'} ${echo}\n`);
      try {
        const res = await runCommand(exe, args);
        const text = (res.stderr || res.stdout).trim();
        if (text) append(text + '\n');
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy('');
      }
    },
    [exe, insiders],
  );

  const loadExtensions = useCallback(async () => {
    setBusy('exts');
    setErr(null);
    try {
      const res = await runCommand(exe, ['--list-extensions', '--show-versions']);
      if (res.success || res.stdout.trim()) setExts(parseExtensions(res.stdout));
      else {
        setExts([]);
        const e = res.stderr.trim();
        if (e) setErr(e);
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setExts([]);
    } finally {
      setBusy('');
    }
  }, [exe]);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  // ---- open with mode ----
  const openWithMode = () => {
    const p = openPath.trim();
    if (!p) return;
    const flag = openMode === '1' ? ['-n'] : openMode === '2' ? ['-r'] : openMode === '3' ? ['--add'] : [];
    void launch('open', [...flag, p], `${flag.join(' ')} ${p}`.trim());
    pushRecent(p);
  };

  const openEmpty = () => void launch('empty', ['-n'], '-n');

  const openRecent = (p: string) => {
    void launch('recent', [p], p);
    pushRecent(p);
  };

  const doDiff = () => {
    const a = diffA.trim();
    const b = diffB.trim();
    if (!a || !b) {
      setErr(t('vscode.diffNeedBoth'));
      return;
    }
    void launch('diff', ['--diff', a, b], `--diff ${a} ${b}`);
  };

  const doMerge = () => {
    const p1 = mergeP1.trim();
    const p2 = mergeP2.trim();
    const base = mergeBase.trim();
    const result = mergeResult.trim();
    if (!p1 || !p2 || !base || !result) {
      setErr(t('vscode.mergeNeedAll'));
      return;
    }
    void launch('merge', ['--merge', p1, p2, base, result], `--merge ${p1} ${p2} ${base} ${result}`);
  };

  const doGoto = () => {
    const f = gotoFile.trim();
    if (!f) {
      setErr(t('vscode.gotoNeedFile'));
      return;
    }
    const line = Math.max(1, gotoLine || 1);
    const col = Math.max(1, gotoCol || 1);
    const target = col > 1 ? `${f}:${line}:${col}` : `${f}:${line}`;
    void launch('goto', ['-g', target], `-g ${target}`);
  };

  const openProfile = () => {
    const prof = profile.trim();
    const p = openPath.trim();
    if (!prof) {
      setErr(t('vscode.profileNeedName'));
      return;
    }
    if (!p) {
      setErr(t('vscode.profileNeedPath'));
      return;
    }
    void launch('profile', ['--profile', prof, p], `--profile ${prof} ${p}`);
    pushRecent(p);
  };

  // ---- settings.json / keybindings.json quick-edit ----
  // %APPDATA%\Code\User\<file>  (Code - Insiders for the Insiders build). We resolve the
  // path with PowerShell (backend shells to Windows PowerShell 5.1) and only open it if it
  // exists — matching VsCodeService.UserSettingsPath / UserKeybindingsPath + File.Exists.
  const openUserJson = useCallback(
    async (file: 'settings.json' | 'keybindings.json') => {
      setBusy(file);
      setErr(null);
      try {
        const folder = insiders ? 'Code - Insiders' : 'Code';
        const script = `$p = Join-Path $env:APPDATA '${folder}\\User\\${file}'; if (Test-Path -LiteralPath $p) { $p } else { '' }`;
        const res = await runPowershell(script);
        const p = res.stdout.trim();
        if (!p) {
          append(t('vscode.jsonNotFound', { file }) + '\n');
          return;
        }
        await launch(file, [p], p);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy('');
      }
    },
    [insiders, launch, t],
  );

  // ---- open a terminal at a folder (wt.exe → cmd fallback) — mirrors OpenTerminalAt ----
  const openTerminal = useCallback(async () => {
    const folder = termPath.trim();
    if (!folder) {
      setErr(t('vscode.termNeedPath'));
      return;
    }
    setBusy('terminal');
    setErr(null);
    append(`> wt -d ${folder}\n`);
    try {
      const res = await runCommand('wt.exe', ['-d', folder]);
      if (!res.success) {
        await runCommand('cmd.exe', ['/k', 'cd', '/d', folder]);
      }
    } catch {
      try {
        await runCommand('cmd.exe', ['/k', 'cd', '/d', folder]);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      }
    } finally {
      setBusy('');
    }
  }, [termPath, t]);

  const startTunnel = () => void runVerb('tunnel', ['tunnel'], 'tunnel');

  // ---- extensions (install / uninstall click-gated with a confirm) ----
  const installExt = async () => {
    const id = extId.trim();
    if (!id) {
      setErr(t('vscode.extNeedId'));
      return;
    }
    if (!confirm(t('vscode.installConfirm', { id }))) return;
    const res = await runVerb('install', ['--install-extension', id, '--force'], `--install-extension ${id}`);
    if (res) {
      setExtId('');
      await loadExtensions();
    }
  };

  const uninstallExt = async (id: string) => {
    if (!confirm(t('vscode.uninstallConfirm', { id }))) return;
    const res = await runVerb('uninstall', ['--uninstall-extension', id], `--uninstall-extension ${id}`);
    if (res) await loadExtensions();
  };

  // Export the installed set as a newline-joined list into the import box (copy-ready).
  const exportSet = () => {
    if (!exts || exts.length === 0) {
      setErr(t('vscode.extNone'));
      return;
    }
    const text = exts.map((x) => x.id).join('\n');
    setImportSet(text);
    append(t('vscode.exportedN', { n: exts.length }) + '\n' + text + '\n');
  };

  // Import a set: parse IDs (skip blanks / # comments) and install each in turn, gated.
  const importSetRun = async () => {
    const ids = importSet
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (ids.length === 0) {
      setErr(t('vscode.importNeedIds'));
      return;
    }
    if (!confirm(t('vscode.importConfirm', { n: ids.length }))) return;
    setBusy('import');
    setErr(null);
    append(t('vscode.importingN', { n: ids.length }) + '\n');
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      append(`→ ${id}\n`);
      try {
        const res = await runCommand(exe, ['--install-extension', id, '--force']);
        if (res.success) {
          ok++;
          append(`   ✓ ${id}\n`);
        } else {
          fail++;
          append(`   ✗ ${id}\n`);
        }
      } catch {
        fail++;
        append(`   ✗ ${id}\n`);
      }
    }
    append(t('vscode.importDone', { ok, fail }) + '\n');
    setBusy('');
    await loadExtensions();
  };

  const shownExts = useMemo(() => {
    if (!exts) return [];
    const f = extFilter.trim().toLowerCase();
    return f ? exts.filter((x) => x.id.toLowerCase().includes(f)) : exts;
  }, [exts, extFilter]);

  return (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vscode.blurb')}
      </p>

      {/* ===== Target build (Stable ⇄ Insiders) ===== */}
      <div className="mod-toolbar" style={{ marginBottom: 8 }}>
        <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={insiders}
            onChange={(e) => {
              setInsiders(e.target.checked);
              setExts(null);
            }}
          />
          {t('vscode.insiders')}
        </label>
        <span className="count-note">{insiders ? t('vscode.targetInsiders') : t('vscode.targetStable')}</span>
        <button className="mini" disabled={!!busy} onClick={() => void loadExtensions()}>
          ⟳ {t('vscode.refresh')}
        </button>
      </div>

      {/* ===== Open in VS Code ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>
          {t('vscode.openLabel')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="hosts-edit"
            style={{ minHeight: 0, height: 34, flex: 1, minWidth: 240, fontFamily: 'monospace' }}
            value={openPath}
            onChange={(e) => setOpenPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && openWithMode()}
            placeholder={t('vscode.pathPlaceholder')}
          />
          <select className="mod-select" value={openMode} onChange={(e) => setOpenMode(e.target.value)}>
            <option value="0">{t('vscode.modeSame')}</option>
            <option value="1">{t('vscode.modeNew')}</option>
            <option value="2">{t('vscode.modeReuse')}</option>
            <option value="3">{t('vscode.modeAdd')}</option>
          </select>
          <button className="mini primary" disabled={!!busy || !openPath.trim()} onClick={openWithMode}>
            {t('vscode.open')}
          </button>
          <button className="mini" disabled={!!busy} onClick={openEmpty}>
            {t('vscode.emptyWindow')}
          </button>
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>
          {t('vscode.pathHint')}
        </p>
      </div>

      {/* ===== Recent workspaces ===== */}
      <div className="panel">
        <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
          <p className="label" style={{ margin: 0 }}>
            {t('vscode.recentLabel')}
          </p>
          {recents.length > 0 && (
            <button className="mini" disabled={!!busy} onClick={clearRecents}>
              {t('vscode.clearRecent')}
            </button>
          )}
        </div>
        {recents.length === 0 ? (
          <p className="count-note" style={{ marginBottom: 0 }}>
            {t('vscode.recentNone')}
          </p>
        ) : (
          <ul className="kv-list">
            {recents.map((p) => (
              <li key={p} className="kv-row" style={{ alignItems: 'center' }}>
                <span className="value" style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {p}
                </span>
                <button className="mini" disabled={!!busy} onClick={() => openRecent(p)}>
                  {t('vscode.reopen')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ===== Compare & navigate ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>
          {t('vscode.compareLabel')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 180 }}
            value={diffA}
            onChange={(e) => setDiffA(e.target.value)}
            placeholder={t('vscode.leftFile')}
          />
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 180 }}
            value={diffB}
            onChange={(e) => setDiffB(e.target.value)}
            placeholder={t('vscode.rightFile')}
          />
          <button className="mini" disabled={!!busy} onClick={doDiff}>
            {t('vscode.diff')}
          </button>
        </div>

        {/* 4-way merge */}
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 140 }}
            value={mergeP1}
            onChange={(e) => setMergeP1(e.target.value)}
            placeholder={t('vscode.mergeP1')}
          />
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 140 }}
            value={mergeP2}
            onChange={(e) => setMergeP2(e.target.value)}
            placeholder={t('vscode.mergeP2')}
          />
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 140 }}
            value={mergeBase}
            onChange={(e) => setMergeBase(e.target.value)}
            placeholder={t('vscode.mergeBase')}
          />
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 140 }}
            value={mergeResult}
            onChange={(e) => setMergeResult(e.target.value)}
            placeholder={t('vscode.mergeResult')}
          />
          <button className="mini" disabled={!!busy} onClick={doMerge}>
            {t('vscode.merge')}
          </button>
        </div>

        {/* go-to file:line:col */}
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 180 }}
            value={gotoFile}
            onChange={(e) => setGotoFile(e.target.value)}
            placeholder={t('vscode.gotoFile')}
          />
          <label className="count-note">{t('vscode.line')}</label>
          <input
            className="mod-search"
            type="number"
            min={1}
            style={{ maxWidth: 80 }}
            value={gotoLine}
            onChange={(e) => setGotoLine(Math.max(1, +e.target.value || 1))}
          />
          <label className="count-note">{t('vscode.column')}</label>
          <input
            className="mod-search"
            type="number"
            min={1}
            style={{ maxWidth: 80 }}
            value={gotoCol}
            onChange={(e) => setGotoCol(Math.max(1, +e.target.value || 1))}
          />
          <button className="mini" disabled={!!busy} onClick={doGoto}>
            {t('vscode.gotoLine')}
          </button>
        </div>
      </div>

      {/* ===== Profiles, config & remote ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>
          {t('vscode.configLabel')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 200 }}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder={t('vscode.profilePlaceholder')}
          />
          <button className="mini" disabled={!!busy} onClick={openProfile}>
            {t('vscode.openWithProfile')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <button className="mini" disabled={!!busy} onClick={() => void openUserJson('settings.json')}>
            {t('vscode.editSettings')}
          </button>
          <button className="mini" disabled={!!busy} onClick={() => void openUserJson('keybindings.json')}>
            {t('vscode.editKeybindings')}
          </button>
          <button className="mini" disabled={!!busy} onClick={startTunnel}>
            {t('vscode.startTunnel')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 200 }}
            value={termPath}
            onChange={(e) => setTermPath(e.target.value)}
            placeholder={t('vscode.termPlaceholder')}
          />
          <button className="mini" disabled={!!busy} onClick={() => void openTerminal()}>
            {t('vscode.terminalHere')}
          </button>
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>
          {t('vscode.tunnelHint')}
        </p>
      </div>

      {/* ===== Extensions ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>
          {exts ? t('vscode.extLabelCount', { n: exts.length }) : t('vscode.extLabel')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            value={extId}
            onChange={(e) => setExtId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void installExt()}
            placeholder={t('vscode.extIdPlaceholder')}
          />
          <button className="mini primary" disabled={!!busy || !extId.trim()} onClick={() => void installExt()}>
            {t('vscode.install')}
          </button>
          <button className="mini" disabled={!!busy} onClick={() => void loadExtensions()}>
            ⟳ {t('vscode.refresh')}
          </button>
          <button className="mini" disabled={!!busy || !exts || exts.length === 0} onClick={exportSet}>
            {t('vscode.exportSet')}
          </button>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <input
            className="mod-search"
            style={{ flex: 1 }}
            value={extFilter}
            onChange={(e) => setExtFilter(e.target.value)}
            placeholder={t('vscode.extFilterPlaceholder')}
          />
        </div>
        <div style={{ marginTop: 8, maxHeight: 300, overflow: 'auto' }}>
          {exts === null ? (
            <p className="count-note">{t('vscode.extLoading')}</p>
          ) : shownExts.length === 0 ? (
            <p className="count-note">{exts.length === 0 ? t('vscode.extNone') : t('vscode.extNoMatch')}</p>
          ) : (
            <ul className="kv-list">
              {shownExts.map((ext) => (
                <li key={ext.id} className="kv-row" style={{ alignItems: 'center' }}>
                  <span className="value" style={{ flex: 1, fontFamily: 'monospace' }}>
                    {ext.id}
                    {ext.version ? (
                      <span className="count-note" style={{ marginLeft: 6 }}>
                        v{ext.version}
                      </span>
                    ) : null}
                  </span>
                  <button className="mini" disabled={!!busy} onClick={() => void uninstallExt(ext.id)}>
                    {t('vscode.uninstall')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Import an extension set (paste a list, one id per line; # comments allowed) */}
        <p className="label">{t('vscode.importLabel')}</p>
        <textarea
          className="hosts-edit"
          style={{ width: '100%', minHeight: 96, fontFamily: 'monospace', resize: 'vertical' }}
          value={importSet}
          onChange={(e) => setImportSet(e.target.value)}
          placeholder={t('vscode.importPlaceholder')}
        />
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" disabled={!!busy || !importSet.trim()} onClick={() => void importSetRun()}>
            {t('vscode.importSet')}
          </button>
        </div>
      </div>

      {/* ===== Operation library (captured reference verbs) ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>
          {t('vscode.opsLabel')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('version', ['--version'], '--version')}>
            {t('vscode.opVersion')}
          </button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('status', ['--status'], '--status')}>
            {t('vscode.opStatus')}
          </button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('help', ['--help'], '--help')}>
            {t('vscode.opHelp')}
          </button>
          <button
            className="mini"
            disabled={!!busy}
            onClick={() => void runVerb('listExtCat', ['--list-extensions', '--category'], '--list-extensions --category')}
          >
            {t('vscode.opListExtCat')}
          </button>
          <button
            className="mini"
            disabled={!!busy}
            onClick={() => void runVerb('tunnelHelp', ['tunnel', '--help'], 'tunnel --help')}
          >
            {t('vscode.opTunnelHelp')}
          </button>
          <button
            className="mini"
            disabled={!!busy}
            onClick={() => void runVerb('tunnelStatus', ['tunnel', 'status'], 'tunnel status')}
          >
            {t('vscode.opTunnelStatus')}
          </button>
        </div>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {out && <pre className="cmd-out">{out}</pre>}
    </>
  );
}

export function VscodeModule() {
  return (
    <div className="mod">
      <DependencyGate tool="code" preferId="Microsoft.VisualStudioCode" query="visual studio code">
        {(path) => <Workbench codePath={path} />}
      </DependencyGate>
    </div>
  );
}
