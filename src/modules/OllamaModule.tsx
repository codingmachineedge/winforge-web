import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives the local `ollama` CLI (which fronts the REST API on
// http://localhost:11434). Core operations: list installed models, show running
// models, pull a model, remove a model (confirmed), single-turn chat via
// `ollama run`, unload a loaded model, print the version, start the server, and
// open the models folder / online library. Everything is guarded and never throws.

const POPULAR_MODELS = ['llama3.2', 'llama3.1', 'qwen2.5', 'gemma2', 'mistral', 'phi3', 'deepseek-r1'];

interface ParsedModel {
  name: string;
  id: string;
  size: string;
  modified: string;
}

interface ParsedRunning {
  name: string;
  id: string;
  size: string;
  processor: string;
  until: string;
}

// `ollama list` / `ollama ps` emit fixed-width, whitespace-separated columns with a
// header row. We split on runs of two-or-more spaces to keep multi-word cells intact,
// falling back to single-space splits, and tolerate any column count.
function splitRow(line: string): string[] {
  const byWide = line.trim().split(/\s{2,}/).filter((c) => c.length > 0);
  if (byWide.length >= 2) return byWide;
  return line.trim().split(/\s+/).filter((c) => c.length > 0);
}

function parseModels(stdout: string): ParsedModel[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: ParsedModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && /^\s*NAME\b/i.test(line)) continue; // header
    const cells = splitRow(line);
    const name = cells[0];
    if (!name) continue;
    out.push({
      name,
      id: cells[1] ?? '',
      size: cells[2] ?? '',
      modified: cells.slice(3).join(' '),
    });
  }
  return out;
}

function parseRunning(stdout: string): ParsedRunning[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: ParsedRunning[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && /^\s*NAME\b/i.test(line)) continue; // header
    const cells = splitRow(line);
    const name = cells[0];
    if (!name) continue;
    out.push({
      name,
      id: cells[1] ?? '',
      size: cells[2] ?? '',
      processor: cells[3] ?? '',
      until: cells.slice(4).join(' '),
    });
  }
  return out;
}

function outputText(res: CommandOutput): string {
  const body = res.stdout.trim() || res.stderr.trim();
  return body || `(exit ${res.code})`;
}

export function OllamaModule() {
  const { t } = useTranslation();

  return (
    <div className="mod">
      <DependencyGate tool="ollama" preferId="Ollama.Ollama" query="ollama">
        {(path) => <OllamaInner path={path} t={t} />}
      </DependencyGate>
    </div>
  );
}

type Tab = 'models' | 'pull' | 'running' | 'chat' | 'ops';

function OllamaInner({ path, t }: { path: string; t: (k: string, o?: Record<string, unknown>) => string }) {
  const [tab, setTab] = useState<Tab>('models');

  // Models tab
  const [models, setModels] = useState<ParsedModel[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsMsg, setModelsMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Pull tab
  const [pullName, setPullName] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pullOut, setPullOut] = useState('');

  // Running tab
  const [running, setRunning] = useState<ParsedRunning[] | null>(null);
  const [runningBusy, setRunningBusy] = useState(false);

  // Chat tab
  const [chatModel, setChatModel] = useState('');
  const [chatPrompt, setChatPrompt] = useState('');
  const [chatOut, setChatOut] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  // Ops tab
  const [opsOut, setOpsOut] = useState('');
  const [opsBusy, setOpsBusy] = useState('');

  const safeRun = async (args: string[]): Promise<CommandOutput> => {
    try {
      return await runCommand(path, args);
    } catch (e) {
      return { stdout: '', stderr: String(e instanceof Error ? e.message : e), code: -1, success: false };
    }
  };

  // ── Models ────────────────────────────────────────────────────────────────
  const loadModels = async () => {
    setModelsBusy(true);
    setModelsMsg(null);
    const res = await safeRun(['list']);
    if (!res.success && !res.stdout.trim()) {
      setModelsMsg(res.stderr.trim() || t('ollama.loadFailed'));
      setModels([]);
    } else {
      setModels(parseModels(res.stdout));
    }
    setModelsBusy(false);
  };

  const deleteModel = async (name: string) => {
    setConfirmDelete(null);
    setModelsBusy(true);
    const res = await safeRun(['rm', name]);
    setModelsMsg(res.success ? t('ollama.deleted', { name }) : t('ollama.deleteFailed', { msg: res.stderr.trim() }));
    setModelsBusy(false);
    await loadModels();
  };

  // ── Pull ──────────────────────────────────────────────────────────────────
  const pull = async () => {
    const name = pullName.trim();
    if (!name) {
      setPullOut(t('ollama.enterName'));
      return;
    }
    setPullBusy(true);
    setPullOut(`> ollama pull ${name}\n`);
    const res = await safeRun(['pull', name]);
    setPullOut(outputText(res));
    setPullBusy(false);
    if (res.success) await loadModels();
  };

  // ── Running ───────────────────────────────────────────────────────────────
  const loadRunning = async () => {
    setRunningBusy(true);
    const res = await safeRun(['ps']);
    setRunning(res.success || res.stdout.trim() ? parseRunning(res.stdout) : []);
    setRunningBusy(false);
  };

  const stopModel = async (name: string) => {
    setRunningBusy(true);
    await safeRun(['stop', name]);
    await loadRunning();
  };

  // ── Chat ──────────────────────────────────────────────────────────────────
  const sendChat = async () => {
    const model = chatModel.trim();
    const prompt = chatPrompt.trim();
    if (!model) {
      setChatOut(t('ollama.pickModel'));
      return;
    }
    if (!prompt) return;
    setChatBusy(true);
    setChatOut(`> ollama run ${model}\n${prompt}\n\n`);
    const res = await safeRun(['run', model, prompt]);
    setChatOut(outputText(res));
    setChatBusy(false);
  };

  // ── Ops ───────────────────────────────────────────────────────────────────
  const runVerb = async (key: string, args: string[]) => {
    setOpsBusy(key);
    const res = await safeRun(args);
    setOpsOut(outputText(res));
    setOpsBusy('');
  };

  const startServe = async () => {
    setOpsBusy('serve');
    // Detached — `serve` blocks, so just fire it and report.
    void safeRun(['serve']);
    setOpsOut(t('ollama.serveStarted'));
    setOpsBusy('');
  };

  const openLibrary = async () => {
    setOpsBusy('library');
    try {
      await runCommand('explorer', ['https://ollama.com/library']);
      setOpsOut(t('ollama.opened'));
    } catch (e) {
      setOpsOut(String(e instanceof Error ? e.message : e));
    }
    setOpsBusy('');
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'models', label: t('ollama.tabModels') },
    { id: 'pull', label: t('ollama.tabPull') },
    { id: 'running', label: t('ollama.tabRunning') },
    { id: 'chat', label: t('ollama.tabChat') },
    { id: 'ops', label: t('ollama.tabOps') },
  ];

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.subtitle')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            className={tab === tb.id ? 'mini primary' : 'mini'}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Models ─────────────────────────────────────────────────────────── */}
      {tab === 'models' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini primary" disabled={modelsBusy} onClick={loadModels}>
              {modelsBusy ? t('ollama.loading') : t('ollama.refresh')}
            </button>
            {models && <span className="count-note">{t('ollama.installedCount', { n: models.length })}</span>}
          </div>
          {modelsMsg && <pre className="cmd-out">{modelsMsg}</pre>}
          {models && models.length > 0 && (
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('ollama.colName')}</th>
                  <th>{t('ollama.colId')}</th>
                  <th style={{ textAlign: 'right' }}>{t('ollama.colSize')}</th>
                  <th>{t('ollama.colModified')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td style={{ fontFamily: 'monospace' }}>{m.name}</td>
                    <td style={{ fontFamily: 'monospace' }}>{m.id}</td>
                    <td style={{ textAlign: 'right' }}>{m.size}</td>
                    <td>{m.modified}</td>
                    <td style={{ textAlign: 'right' }}>
                      {confirmDelete === m.name ? (
                        <>
                          <button className="mini" onClick={() => deleteModel(m.name)}>{t('ollama.confirmDelete')}</button>{' '}
                          <button className="mini" onClick={() => setConfirmDelete(null)}>{t('ollama.cancel')}</button>
                        </>
                      ) : (
                        <button className="mini" onClick={() => setConfirmDelete(m.name)}>{t('ollama.delete')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {models && models.length === 0 && !modelsMsg && (
            <p className="count-note">{t('ollama.noModels')}</p>
          )}
          {!models && !modelsBusy && <p className="count-note">{t('ollama.clickRefresh')}</p>}
        </div>
      )}

      {/* ── Pull ───────────────────────────────────────────────────────────── */}
      {tab === 'pull' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.pullBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ maxWidth: 260 }}
              placeholder={t('ollama.pullPlaceholder')}
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !pullBusy && pull()}
            />
            <button className="mini primary" disabled={pullBusy} onClick={pull}>
              {pullBusy ? t('ollama.pulling') : t('ollama.pull')}
            </button>
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="count-note">{t('ollama.popular')}</span>
            {POPULAR_MODELS.map((m) => (
              <button key={m} className="mini" onClick={() => setPullName(m)}>{m}</button>
            ))}
          </div>
          {pullOut && <pre className="cmd-out">{pullOut}</pre>}
        </div>
      )}

      {/* ── Running ────────────────────────────────────────────────────────── */}
      {tab === 'running' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini primary" disabled={runningBusy} onClick={loadRunning}>
              {runningBusy ? t('ollama.loading') : t('ollama.refresh')}
            </button>
            {running && <span className="count-note">{t('ollama.loadedCount', { n: running.length })}</span>}
          </div>
          {running && running.length > 0 && (
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('ollama.colName')}</th>
                  <th>{t('ollama.colId')}</th>
                  <th style={{ textAlign: 'right' }}>{t('ollama.colSize')}</th>
                  <th>{t('ollama.colProcessor')}</th>
                  <th>{t('ollama.colUntil')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {running.map((m) => (
                  <tr key={m.name}>
                    <td style={{ fontFamily: 'monospace' }}>{m.name}</td>
                    <td style={{ fontFamily: 'monospace' }}>{m.id}</td>
                    <td style={{ textAlign: 'right' }}>{m.size}</td>
                    <td>{m.processor}</td>
                    <td>{m.until}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="mini" onClick={() => stopModel(m.name)}>{t('ollama.unload')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {running && running.length === 0 && <p className="count-note">{t('ollama.noRunning')}</p>}
          {!running && !runningBusy && <p className="count-note">{t('ollama.clickRefresh')}</p>}
        </div>
      )}

      {/* ── Chat ───────────────────────────────────────────────────────────── */}
      {tab === 'chat' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.chatBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ maxWidth: 200 }}
              placeholder={t('ollama.chatModelPlaceholder')}
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
            />
          </div>
          <textarea
            className="hosts-edit"
            style={{ width: '100%', minHeight: 90 }}
            placeholder={t('ollama.chatPromptPlaceholder')}
            value={chatPrompt}
            onChange={(e) => setChatPrompt(e.target.value)}
          />
          <div className="mod-toolbar">
            <button className="mini primary" disabled={chatBusy} onClick={sendChat}>
              {chatBusy ? t('ollama.generating') : t('ollama.send')}
            </button>
          </div>
          {chatOut && <pre className="cmd-out">{chatOut}</pre>}
        </div>
      )}

      {/* ── Ops ────────────────────────────────────────────────────────────── */}
      {tab === 'ops' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.opsBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" disabled={opsBusy === 'serve'} onClick={startServe}>{t('ollama.startServer')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => runVerb('version', ['--version'])}>{t('ollama.checkVersion')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => runVerb('list', ['list'])}>{t('ollama.listCli')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => runVerb('ps', ['ps'])}>{t('ollama.psCli')}</button>
            <button className="mini" disabled={opsBusy === 'library'} onClick={openLibrary}>{t('ollama.openLibrary')}</button>
          </div>
          {opsOut && <pre className="cmd-out">{opsOut}</pre>}
        </div>
      )}
    </div>
  );
}
