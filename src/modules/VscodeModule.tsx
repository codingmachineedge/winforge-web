import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a faithful web port of WinForge's VsCodeModule / VsCodeService.
// Drives the Visual Studio Code `code` CLI through the desktop backend: open files/
// folders/workspaces (same / new / reuse / add window), diff two files, go-to file:line,
// open settings.json & keybindings.json, start the remote tunnel, and a full extension
// manager (list / install / uninstall). Detached GUI launches use runCommand(path, args);
// captured verbs (--version, --status, --list-extensions…) show their output inline.

interface Extension { id: string; version: string }

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

function Workbench({ codePath }: { codePath: string }) {
  const { t } = useTranslation();

  const [openPath, setOpenPath] = useState('');
  const [openMode, setOpenMode] = useState('0');
  const [diffA, setDiffA] = useState('');
  const [diffB, setDiffB] = useState('');
  const [gotoFile, setGotoFile] = useState('');
  const [gotoLine, setGotoLine] = useState(1);
  const [gotoCol, setGotoCol] = useState(1);
  const [profile, setProfile] = useState('');
  const [extId, setExtId] = useState('');
  const [extFilter, setExtFilter] = useState('');

  const [exts, setExts] = useState<Extension[] | null>(null);
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const append = (line: string) => setOut((prev) => (prev + line).slice(-20000));

  // Run a captured verb and show stdout/stderr inline.
  const runVerb = useCallback(
    async (label: string, args: string[], echo?: string): Promise<CommandOutput | null> => {
      setBusy(label);
      setErr(null);
      if (echo) append(`> code ${echo}\n`);
      try {
        const res = await runCommand(codePath, args);
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
    [codePath],
  );

  // Launch a GUI window (detached). We still await so failures surface, but VS Code
  // returns immediately once the window is handed off.
  const launch = useCallback(
    async (label: string, args: string[], echo: string) => {
      setBusy(label);
      setErr(null);
      append(`> code ${echo}\n`);
      try {
        const res = await runCommand(codePath, args);
        const text = (res.stderr || res.stdout).trim();
        if (text) append(text + '\n');
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy('');
      }
    },
    [codePath],
  );

  const loadExtensions = useCallback(async () => {
    setBusy('exts');
    setErr(null);
    try {
      const res = await runCommand(codePath, ['--list-extensions', '--show-versions']);
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
  }, [codePath]);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  // ---- open with mode ----
  const openWithMode = () => {
    const p = openPath.trim();
    if (!p) return;
    const flag = openMode === '1' ? ['-n'] : openMode === '2' ? ['-r'] : openMode === '3' ? ['--add'] : [];
    void launch('open', [...flag, p], `${flag.join(' ')} ${p}`.trim());
  };

  const openEmpty = () => void launch('empty', ['-n'], '-n');

  const doDiff = () => {
    const a = diffA.trim();
    const b = diffB.trim();
    if (!a || !b) {
      setErr(t('vscode.diffNeedBoth'));
      return;
    }
    void launch('diff', ['--diff', a, b], `--diff ${a} ${b}`);
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
  };

  const startTunnel = () => void runVerb('tunnel', ['tunnel'], 'tunnel');

  const installExt = async () => {
    const id = extId.trim();
    if (!id) {
      setErr(t('vscode.extNeedId'));
      return;
    }
    const res = await runVerb('install', ['--install-extension', id, '--force'], `--install-extension ${id}`);
    if (res) {
      setExtId('');
      await loadExtensions();
    }
  };

  const uninstallExt = async (id: string) => {
    const res = await runVerb('uninstall', ['--uninstall-extension', id], `--uninstall-extension ${id}`);
    if (res) await loadExtensions();
  };

  const shownExts = (() => {
    if (!exts) return [];
    const f = extFilter.trim().toLowerCase();
    return f ? exts.filter((x) => x.id.toLowerCase().includes(f)) : exts;
  })();

  return (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>{t('vscode.blurb')}</p>

      {/* ===== Open in VS Code ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('vscode.openLabel')}</p>
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
          <button className="mini primary" disabled={!!busy || !openPath.trim()} onClick={openWithMode}>{t('vscode.open')}</button>
          <button className="mini" disabled={!!busy} onClick={openEmpty}>{t('vscode.emptyWindow')}</button>
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>{t('vscode.pathHint')}</p>
      </div>

      {/* ===== Compare & navigate ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('vscode.compareLabel')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input className="mod-search" style={{ flex: 1, minWidth: 180 }} value={diffA} onChange={(e) => setDiffA(e.target.value)} placeholder={t('vscode.leftFile')} />
          <input className="mod-search" style={{ flex: 1, minWidth: 180 }} value={diffB} onChange={(e) => setDiffB(e.target.value)} placeholder={t('vscode.rightFile')} />
          <button className="mini" disabled={!!busy} onClick={doDiff}>{t('vscode.diff')}</button>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <input className="mod-search" style={{ flex: 1, minWidth: 180 }} value={gotoFile} onChange={(e) => setGotoFile(e.target.value)} placeholder={t('vscode.gotoFile')} />
          <label className="count-note">{t('vscode.line')}</label>
          <input className="mod-search" type="number" min={1} style={{ maxWidth: 80 }} value={gotoLine} onChange={(e) => setGotoLine(Math.max(1, +e.target.value || 1))} />
          <label className="count-note">{t('vscode.column')}</label>
          <input className="mod-search" type="number" min={1} style={{ maxWidth: 80 }} value={gotoCol} onChange={(e) => setGotoCol(Math.max(1, +e.target.value || 1))} />
          <button className="mini" disabled={!!busy} onClick={doGoto}>{t('vscode.gotoLine')}</button>
        </div>
      </div>

      {/* ===== Profiles, config & remote ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('vscode.configLabel')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input className="mod-search" style={{ flex: 1, minWidth: 200 }} value={profile} onChange={(e) => setProfile(e.target.value)} placeholder={t('vscode.profilePlaceholder')} />
          <button className="mini" disabled={!!busy} onClick={openProfile}>{t('vscode.openWithProfile')}</button>
          <button className="mini" disabled={!!busy} onClick={startTunnel}>{t('vscode.startTunnel')}</button>
        </div>
        <p className="count-note" style={{ marginBottom: 0 }}>{t('vscode.tunnelHint')}</p>
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
          <button className="mini primary" disabled={!!busy || !extId.trim()} onClick={() => void installExt()}>{t('vscode.install')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void loadExtensions()}>⟳ {t('vscode.refresh')}</button>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <input className="mod-search" style={{ flex: 1 }} value={extFilter} onChange={(e) => setExtFilter(e.target.value)} placeholder={t('vscode.extFilterPlaceholder')} />
        </div>
        <div style={{ marginTop: 8, maxHeight: 300, overflow: 'auto' }}>
          {exts === null ? (
            <p className="count-note">{t('vscode.extLoading')}</p>
          ) : shownExts.length === 0 ? (
            <p className="count-note">
              {exts.length === 0 ? t('vscode.extNone') : t('vscode.extNoMatch')}
            </p>
          ) : (
            <ul className="kv-list">
              {shownExts.map((ext) => (
                <li key={ext.id} className="kv-row" style={{ alignItems: 'center' }}>
                  <span className="value" style={{ flex: 1, fontFamily: 'monospace' }}>
                    {ext.id}
                    {ext.version ? <span className="count-note" style={{ marginLeft: 6 }}>v{ext.version}</span> : null}
                  </span>
                  <button className="mini" disabled={!!busy} onClick={() => void uninstallExt(ext.id)}>{t('vscode.uninstall')}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ===== Operation library (captured reference verbs) ===== */}
      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('vscode.opsLabel')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('version', ['--version'], '--version')}>{t('vscode.opVersion')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('status', ['--status'], '--status')}>{t('vscode.opStatus')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('help', ['--help'], '--help')}>{t('vscode.opHelp')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('tunnelHelp', ['tunnel', '--help'], 'tunnel --help')}>{t('vscode.opTunnelHelp')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void runVerb('tunnelStatus', ['tunnel', 'status'], 'tunnel status')}>{t('vscode.opTunnelStatus')}</button>
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
