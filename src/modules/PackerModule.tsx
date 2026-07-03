import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, listDir, isTauri, type CommandOutput, type DirEntry } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives the official HashiCorp Packer CLI (winget id Hashicorp.Packer).
// Pick a working folder, list *.pkr.hcl / *.json templates and *.pkrvars.hcl var-files,
// edit -var key/values, then run init / validate / fmt / build / inspect and see the output.
// Faithful port of WinForge's PackerModule (BUSL-1.1: only shells out to the packer binary).

interface VarRow { key: string; value: string }

// Quote a path that may contain spaces (empty -> ".").
function q(s: string): string {
  return !s ? '.' : `"${s}"`;
}

// Template patterns Packer recognises.
function isTemplate(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.pkr.hcl') || n.endsWith('.pkr.json') || n.endsWith('.json');
}
function isVarFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.pkrvars.hcl') || n.endsWith('.pkrvars.json') ||
    n.endsWith('.auto.pkrvars.hcl') || n.endsWith('.auto.pkrvars.json');
}

export function PackerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [folder, setFolder] = useState('');
  const [templates, setTemplates] = useState<string[]>([]);
  const [varFiles, setVarFiles] = useState<string[]>([]);
  const [selTemplate, setSelTemplate] = useState('');
  const [selVarFiles, setSelVarFiles] = useState<string[]>([]);

  const [vars, setVars] = useState<VarRow[]>([{ key: '', value: '' }]);
  const [targets, setTargets] = useState<string[]>([]);
  const [selTargets, setSelTargets] = useState<string[]>([]);
  const [targetMode, setTargetMode] = useState<'only' | 'except'>('only');

  const [out, setOut] = useState('');
  const [busy, setBusy] = useState('');
  const [scanErr, setScanErr] = useState('');

  // ---- Folder scanning (via native list_dir) ----
  const scanFolder = async () => {
    const dir = folder.trim();
    if (!dir) { setScanErr(t('packer.pickFirst')); return; }
    setScanErr('');
    setBusy('scan');
    try {
      const entries: DirEntry[] = await listDir(dir);
      const files = entries.filter((e) => !e.is_dir).map((e) => e.name);
      const tpls = files.filter(isTemplate).sort();
      const vfs = files.filter(isVarFile).sort();
      setTemplates(tpls);
      setVarFiles(vfs);
      // Drop selections that no longer exist.
      setSelTemplate((cur) => (cur && tpls.includes(cur) ? cur : ''));
      setSelVarFiles((cur) => cur.filter((v) => vfs.includes(v)));
      setTargets([]);
      setSelTargets([]);
      if (tpls.length === 0) setScanErr(t('packer.noTemplates'));
    } catch (e) {
      setTemplates([]);
      setVarFiles([]);
      setScanErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const openFolder = async () => {
    const dir = folder.trim();
    if (!dir || !desktop) return;
    try { await runCommand('explorer.exe', [dir]); } catch { /* ignore */ }
  };

  // Full path helpers.
  const joinPath = (name: string): string => {
    const dir = folder.trim().replace(/[\\/]+$/, '');
    return dir ? `${dir}\\${name}` : name;
  };
  const templatePath = (): string => (selTemplate ? joinPath(selTemplate) : folder.trim());

  // ---- Variables ----
  const setVar = (i: number, patch: Partial<VarRow>) => {
    setVars((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const addVar = () => setVars((rows) => [...rows, { key: '', value: '' }]);
  const removeVar = (i: number) => setVars((rows) => rows.filter((_, idx) => idx !== i));

  // Build the -var / -var-file argument list.
  const varArgs = (): string[] => {
    const args: string[] = [];
    for (const r of vars) {
      const k = r.key.trim();
      if (!k) continue;
      args.push('-var', `${k}=${r.value}`);
    }
    for (const vf of selVarFiles) {
      args.push(`-var-file=${joinPath(vf)}`);
    }
    return args;
  };

  const targetArgs = (): string[] => {
    if (selTargets.length === 0) return [];
    const flag = targetMode === 'except' ? '-except' : '-only';
    return [`${flag}=${selTargets.join(',')}`];
  };

  // ---- Run a packer command and capture output ----
  const run = async (packerPath: string, label: string, args: string[]) => {
    if (busy) return;
    setBusy(label);
    setOut(`$ packer ${args.map((a) => (a.includes(' ') ? q(a) : a)).join(' ')}\n`);
    try {
      const res: CommandOutput = await runCommand(packerPath, args);
      const body = (res.stdout || '') + (res.stderr ? (res.stdout ? '\n' : '') + res.stderr : '');
      setOut(body.trim() || `(exit ${res.code})`);
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const requireFolder = (): boolean => {
    if (!folder.trim()) { setScanErr(t('packer.pickFirst')); return false; }
    return true;
  };

  const doVersion = (p: string) => run(p, 'version', ['version']);
  const doHelp = (p: string) => run(p, 'help', ['--help']);
  const doInit = (p: string) => { if (requireFolder()) run(p, 'init', ['init', templatePath()]); };
  const doValidate = (p: string) => {
    if (!requireFolder()) return;
    run(p, 'validate', ['validate', ...varArgs(), ...targetArgs(), templatePath()]);
  };
  const doFmt = (p: string) => { if (requireFolder()) run(p, 'fmt', ['fmt', folder.trim() || '.']); };
  const doFmtCheck = (p: string) => { if (requireFolder()) run(p, 'fmtcheck', ['fmt', '-check', '-diff', folder.trim() || '.']); };
  const doBuild = (p: string) => {
    if (!requireFolder()) return;
    run(p, 'build', ['build', ...varArgs(), ...targetArgs(), templatePath()]);
  };
  const doInspect = (p: string) => { if (requireFolder()) run(p, 'inspect', ['inspect', templatePath()]); };
  const doPluginsInstalled = (p: string) => run(p, 'plugins-installed', ['plugins', 'installed']);
  const doPluginsRequired = (p: string) => { if (requireFolder()) run(p, 'plugins-required', ['plugins', 'required', folder.trim() || '.']); };

  // Parse build targets from `packer inspect`.
  const inspectTargets = async (p: string) => {
    if (!requireFolder()) return;
    if (busy) return;
    setBusy('targets');
    try {
      const res = await runCommand(p, ['inspect', templatePath()]);
      const raw = (res.stdout || '') + '\n' + (res.stderr || '');
      const found = new Set<string>();
      let inBuilds = false;
      for (const lineRaw of raw.split('\n')) {
        const line = lineRaw.replace(/\s+$/, '');
        const trimmed = line.trim();
        if (/^builds:/i.test(trimmed)) { inBuilds = true; continue; }
        if (inBuilds) {
          const first = line[0];
          if (trimmed.length > 0 && first !== undefined && !/\s/.test(first) && trimmed.endsWith(':')) break;
          let name = trimmed.replace(/^[>\-\s\t]+/, '');
          const colon = name.indexOf(':');
          if (colon > 0) name = name.slice(0, colon);
          name = name.trim();
          const c0 = name[0];
          if (name.length > 0 && c0 !== undefined && (name.includes('.') || name.includes('-') || /[a-zA-Z]/.test(c0))) {
            found.add(name);
          }
        }
      }
      const list = Array.from(found).sort();
      setTargets(list);
      setSelTargets((cur) => cur.filter((x) => list.includes(x)));
      if (list.length === 0) setOut(t('packer.noTargets'));
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const toggleVarFile = (name: string) => {
    setSelVarFiles((cur) => (cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name]));
  };
  const toggleTarget = (name: string) => {
    setSelTargets((cur) => (cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name]));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('packer.blurb')}</p>

      <DependencyGate tool="packer" preferId="Hashicorp.Packer" query="packer">
        {(path) => (
          <>
            {/* ---- Working folder & templates ---- */}
            <div className="panel">
              <div className="label">{t('packer.folderHeader')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input
                  className="mod-search"
                  style={{ minWidth: 260, flex: 1 }}
                  placeholder={t('packer.folderPlaceholder')}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && scanFolder()}
                />
                <button className="mini primary" disabled={busy === 'scan'} onClick={scanFolder}>
                  {busy === 'scan' ? t('packer.scanning') : t('packer.scan')}
                </button>
                <button className="mini" disabled={!desktop || !folder.trim()} onClick={openFolder}>
                  {t('packer.openFolder')}
                </button>
              </div>
              {scanErr && <p className="count-note error" style={{ marginBottom: 0 }}>{scanErr}</p>}

              {templates.length > 0 && (
                <div className="io-grid" style={{ marginTop: 8 }}>
                  <div>
                    <div className="label">{t('packer.templatesLabel')}</div>
                    <select
                      className="mod-select"
                      style={{ width: '100%' }}
                      value={selTemplate}
                      onChange={(e) => setSelTemplate(e.target.value)}
                    >
                      <option value="">{t('packer.wholeFolder')}</option>
                      {templates.map((tpl) => (
                        <option key={tpl} value={tpl}>{tpl}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="label">{t('packer.varFilesLabel')}</div>
                    {varFiles.length === 0 && <p className="count-note" style={{ margin: 0 }}>{t('packer.noVarFiles')}</p>}
                    {varFiles.map((vf) => (
                      <label key={vf} className="chk" style={{ display: 'block' }}>
                        <input type="checkbox" checked={selVarFiles.includes(vf)} onChange={() => toggleVarFile(vf)} />
                        {' '}{vf}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ---- Variables ---- */}
            <div className="panel">
              <div className="label">{t('packer.varsHeader')}</div>
              <p className="count-note" style={{ marginTop: 0 }}>{t('packer.varsBlurb')}</p>
              {vars.map((r, i) => (
                <div key={i} className="mod-toolbar" style={{ marginBottom: 4 }}>
                  <input
                    className="mod-search"
                    style={{ maxWidth: 180 }}
                    placeholder={t('packer.varKey')}
                    value={r.key}
                    onChange={(e) => setVar(i, { key: e.target.value })}
                  />
                  <input
                    className="mod-search"
                    style={{ flex: 1, minWidth: 160 }}
                    placeholder={t('packer.varValue')}
                    value={r.value}
                    onChange={(e) => setVar(i, { value: e.target.value })}
                  />
                  <button className="mini" onClick={() => removeVar(i)} disabled={vars.length === 1 && !r.key && !r.value}>
                    {t('packer.removeVar')}
                  </button>
                </div>
              ))}
              <button className="mini" onClick={addVar}>{t('packer.addVar')}</button>
            </div>

            {/* ---- Build targets ---- */}
            <div className="panel">
              <div className="label">{t('packer.targetsHeader')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini" disabled={!!busy} onClick={() => inspectTargets(path)}>
                  {busy === 'targets' ? t('packer.inspecting') : t('packer.inspectTargets')}
                </button>
                <label className="chk">
                  <input type="radio" name="pk-target-mode" checked={targetMode === 'only'} onChange={() => setTargetMode('only')} />
                  {' '}{t('packer.only')}
                </label>
                <label className="chk">
                  <input type="radio" name="pk-target-mode" checked={targetMode === 'except'} onChange={() => setTargetMode('except')} />
                  {' '}{t('packer.except')}
                </label>
              </div>
              {targets.length === 0
                ? <p className="count-note" style={{ margin: 0 }}>{t('packer.targetsHint')}</p>
                : targets.map((tg) => (
                  <label key={tg} className="chk" style={{ display: 'block' }}>
                    <input type="checkbox" checked={selTargets.includes(tg)} onChange={() => toggleTarget(tg)} />
                    {' '}<span className="value" style={{ fontFamily: 'monospace' }}>{tg}</span>
                  </label>
                ))}
            </div>

            {/* ---- Run ---- */}
            <div className="panel">
              <div className="label">{t('packer.runHeader')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini" disabled={!!busy} onClick={() => doInit(path)}>{t('packer.init')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doValidate(path)}>{t('packer.validate')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doFmt(path)}>{t('packer.fmt')}</button>
                <button className="mini primary" disabled={!!busy} onClick={() => doBuild(path)}>{t('packer.build')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doInspect(path)}>{t('packer.inspect')}</button>
              </div>
            </div>

            {/* ---- More operations ---- */}
            <div className="panel">
              <div className="label">{t('packer.opsHeader')}</div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini" disabled={!!busy} onClick={() => doVersion(path)}>{t('packer.opVersion')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doHelp(path)}>{t('packer.opHelp')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doFmtCheck(path)}>{t('packer.opFmtCheck')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doPluginsInstalled(path)}>{t('packer.opPluginsInstalled')}</button>
                <button className="mini" disabled={!!busy} onClick={() => doPluginsRequired(path)}>{t('packer.opPluginsRequired')}</button>
              </div>
            </div>

            {out && <pre className="cmd-out">{out}</pre>}
            <p className="count-note">{t('packer.note')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
