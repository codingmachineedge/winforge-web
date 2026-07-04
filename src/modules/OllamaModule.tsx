import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a full in-app Ollama manager over the local REST API
// (http://localhost:11434 by default) plus a couple of CLI conveniences, ported to
// parity with WinForge's OllamaModule + OllamaService + OllamaOperations:
//   • Connection bar: base URL + Save + Connect, GET /api/version reachability pill.
//   • Models    — GET /api/tags: name + params·quant·family detail, human size,
//                 modified date; delete via DELETE /api/delete (confirmed).
//   • Pull      — POST /api/pull (streamed NDJSON in the browser for a live progress
//                 bar; blocking in the desktop shell) with popular-model chips + cancel.
//   • Running   — GET /api/ps: GPU/CPU processor split + size; unload via `ollama stop`.
//   • Chat      — POST /api/chat with a model picker, system prompt, streaming reply
//                 bubbles, and tunable temperature / top_p / top_k / num_ctx / seed,
//                 plus Stop and Clear.
//   • Show      — `ollama show <model>` model details.
//   • Operations— start `ollama serve`, version / list / ps via the CLI, open the
//                 models folder and the online library.
// HTTP is routed through PowerShell (Invoke-RestMethod) in the desktop shell so there
// is no cross-origin restriction, and through a direct fetch in a plain browser preview.
// Everything tolerates Ollama being absent or offline and never throws.

const DEFAULT_URL = 'http://127.0.0.1:11434';
const STORAGE_URL = 'winforge.ollama.baseUrl';
const POPULAR_MODELS = ['llama3.2', 'llama3.1', 'qwen2.5', 'gemma2', 'mistral', 'phi3', 'deepseek-r1'];

// ── types ─────────────────────────────────────────────────────────────────────
interface ModelInfo {
  name: string;
  size: number;
  family: string;
  parameterSize: string;
  quantization: string;
  modified: string;
}
interface RunningInfo {
  name: string;
  size: number;
  sizeVram: number;
  parameterSize: string;
  quantization: string;
}
type Role = 'system' | 'user' | 'assistant';
interface ChatMsg {
  role: Role;
  content: string;
}
interface PullState {
  status: string;
  completed: number;
  total: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────────
function loadUrl(): string {
  try {
    return localStorage.getItem(STORAGE_URL)?.trim() || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}
function norm(url: string): string {
  return (url || '').trim().replace(/\/+$/, '') || DEFAULT_URL;
}
function psq(s: string): string {
  return `'${(s || '').replace(/'/g, "''")}'`;
}
function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}
function detailLine(parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(' · ');
}
function processorText(size: number, vram: number): string {
  if (size <= 0) return '';
  if (vram <= 0) return '100% CPU';
  if (vram >= size) return '100% GPU';
  const gpu = Math.round((100 * vram) / size);
  return `${gpu}% GPU / ${100 - gpu}% CPU`;
}
function fmtModified(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Run PowerShell, tolerating failure.
async function ps(script: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await runPowershell(script);
    return { ok: r.success, out: r.stdout.trim(), err: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: '', err: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * GET a JSON endpoint and return the raw body text (never throws). In the desktop
 * shell this goes through PowerShell's Invoke-WebRequest so there is no cross-origin
 * restriction; in a plain browser it falls back to fetch.
 */
async function httpGet(base: string, path: string, timeoutSec = 8): Promise<string> {
  if (isTauri()) {
    const r = await ps(
      `try{$r=Invoke-WebRequest -Uri '${base}${path}' -UseBasicParsing -TimeoutSec ${timeoutSec};` +
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[string]$r.Content}catch{''}`,
    );
    return r.out;
  }
  try {
    const resp = await fetch(base + path, { method: 'GET' });
    if (!resp.ok) return '';
    return await resp.text();
  } catch {
    return '';
  }
}

// JSON body helper (POST / DELETE). Returns { ok, body }.
async function httpJson(
  base: string,
  path: string,
  method: 'POST' | 'DELETE',
  payload: unknown,
  timeoutSec: number,
): Promise<{ ok: boolean; body: string }> {
  if (isTauri()) {
    const json = JSON.stringify(payload);
    const r = await ps(
      `$body=${psq(json)};[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
        `try{$r=Invoke-WebRequest -Uri '${base}${path}' -Method ${method} -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec ${timeoutSec};` +
        `[pscustomobject]@{ok=$true;body=[string]$r.Content}|ConvertTo-Json -Compress -Depth 4}` +
        `catch{[pscustomobject]@{ok=$false;body=[string]$_.Exception.Message}|ConvertTo-Json -Compress -Depth 4}`,
    );
    try {
      const parsed = JSON.parse(r.out || '{}');
      return { ok: !!parsed.ok, body: String(parsed.body ?? '') };
    } catch {
      return { ok: false, body: r.err || r.out };
    }
  }
  try {
    const resp = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await resp.text();
    return { ok: resp.ok, body };
  } catch (e) {
    return { ok: false, body: String(e instanceof Error ? e.message : e) };
  }
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

  // Connection
  const [baseUrl, setBaseUrl] = useState<string>(loadUrl);
  const [urlDraft, setUrlDraft] = useState<string>(loadUrl);
  const [version, setVersion] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [probing, setProbing] = useState(false);

  // Models
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsMsg, setModelsMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Pull
  const [pullName, setPullName] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pullState, setPullState] = useState<PullState | null>(null);
  const [pullMsg, setPullMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const pullAbort = useRef<AbortController | null>(null);

  // Running
  const [running, setRunning] = useState<RunningInfo[] | null>(null);
  const [runningBusy, setRunningBusy] = useState(false);

  // Chat
  const [chatModel, setChatModel] = useState('');
  const [system, setSystem] = useState('');
  const [temp, setTemp] = useState(0.8);
  const [topP, setTopP] = useState(0.9);
  const [topK, setTopK] = useState(40);
  const [numCtx, setNumCtx] = useState(4096);
  const [seed, setSeed] = useState('');
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatNote, setChatNote] = useState<string | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const chatCancel = useRef(false);
  const chatScroll = useRef<HTMLDivElement | null>(null);

  // Ops
  const [opsOut, setOpsOut] = useState('');
  const [opsBusy, setOpsBusy] = useState('');
  const [showModel, setShowModel] = useState('');

  const safeRun = async (args: string[]): Promise<CommandOutput> => {
    try {
      return await runCommand(path, args);
    } catch (e) {
      return { stdout: '', stderr: String(e instanceof Error ? e.message : e), code: -1, success: false };
    }
  };

  // ── connection / probe ──────────────────────────────────────────────────────
  const probe = useCallback(async () => {
    const base = norm(baseUrl);
    setProbing(true);
    const body = await httpGet(base, '/api/version', 6);
    let v: string | null = null;
    try {
      const j = JSON.parse(body || '{}');
      v = j.version ? String(j.version) : null;
    } catch {
      v = null;
    }
    setVersion(v);
    setReachable(!!v);
    setProbing(false);
    return !!v;
  }, [baseUrl]);

  const saveUrl = () => {
    const n = norm(urlDraft);
    setBaseUrl(n);
    setUrlDraft(n);
    try {
      localStorage.setItem(STORAGE_URL, n);
    } catch {
      /* non-fatal */
    }
  };
  const connect = async () => {
    saveUrl();
    // saveUrl setState is async; probe reads the freshly-normalised value directly.
    const n = norm(urlDraft);
    setProbing(true);
    const body = await httpGet(n, '/api/version', 6);
    let v: string | null = null;
    try {
      const j = JSON.parse(body || '{}');
      v = j.version ? String(j.version) : null;
    } catch {
      v = null;
    }
    setVersion(v);
    setReachable(!!v);
    setProbing(false);
    void loadModels(n);
    void loadRunning(n);
  };

  // ── models ──────────────────────────────────────────────────────────────────
  const loadModels = useCallback(
    async (baseOverride?: string) => {
      const base = norm(baseOverride ?? baseUrl);
      setModelsBusy(true);
      setModelsMsg(null);
      const body = await httpGet(base, '/api/tags', 8);
      let list: ModelInfo[] | null = null;
      if (body) {
        try {
          const j = JSON.parse(body);
          const arr = Array.isArray(j?.models) ? j.models : [];
          list = arr
            .map((m: Record<string, unknown>) => {
              const d = (m.details ?? {}) as Record<string, unknown>;
              return {
                name: String(m.name ?? m.model ?? ''),
                size: Number(m.size) || 0,
                family: String(d.family ?? ''),
                parameterSize: String(d.parameter_size ?? ''),
                quantization: String(d.quantization_level ?? ''),
                modified: String(m.modified_at ?? ''),
              };
            })
            .filter((m: ModelInfo) => m.name.length > 0)
            .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
        } catch {
          list = null;
        }
      }
      // Fallback to the CLI when the REST API is unreachable.
      if (list === null) {
        const res = await safeRun(['list']);
        if (res.stdout.trim()) {
          list = parseCliModels(res.stdout);
        } else {
          setModelsMsg(res.stderr.trim() || t('ollama.loadFailed'));
          list = [];
        }
      }
      setModels(list);
      setModelsBusy(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const deleteModel = async (name: string) => {
    setConfirmDelete(null);
    setModelsBusy(true);
    const base = norm(baseUrl);
    const res = await httpJson(base, '/api/delete', 'DELETE', { model: name }, 30);
    if (!res.ok) {
      // CLI fallback.
      const cli = await safeRun(['rm', name]);
      setModelsMsg(cli.success ? t('ollama.deleted', { name }) : t('ollama.deleteFailed', { msg: cli.stderr.trim() || res.body }));
    } else {
      setModelsMsg(t('ollama.deleted', { name }));
    }
    setModelsBusy(false);
    await loadModels();
  };

  // ── pull (streamed) ─────────────────────────────────────────────────────────
  const pull = async () => {
    const name = pullName.trim();
    if (!name) {
      setPullMsg({ kind: 'info', text: t('ollama.enterName') });
      return;
    }
    setPullBusy(true);
    setPullMsg(null);
    setPullState({ status: t('ollama.pullStarting'), completed: 0, total: 0 });

    if (isTauri()) {
      // The bridge cannot stream incrementally, so use a blocking POST and show an
      // indeterminate state; report the final status when it returns.
      const res = await httpJson(baseUrl, '/api/pull', 'POST', { model: name, stream: false }, 3600);
      let ok = false;
      let errText = '';
      try {
        const j = JSON.parse(res.body || '{}');
        ok = res.ok && /success/i.test(String(j.status ?? ''));
        if (j.error) errText = String(j.error);
      } catch {
        ok = res.ok && /success/i.test(res.body);
      }
      setPullState(null);
      setPullBusy(false);
      if (ok) {
        setPullMsg({ kind: 'ok', text: t('ollama.pulled', { name }) });
        await loadModels();
      } else {
        setPullMsg({ kind: 'err', text: t('ollama.pullFailed', { msg: errText || res.body || `exit` }) });
      }
      return;
    }

    // Browser preview: real streamed NDJSON progress via fetch + ReadableStream.
    const ctrl = new AbortController();
    pullAbort.current = ctrl;
    let ok = false;
    let errText = '';
    try {
      const resp = await fetch(norm(baseUrl) + '/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        errText = `HTTP ${resp.status}`;
      } else {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (j.error) {
                errText = String(j.error);
              } else {
                setPullState({
                  status: String(j.status ?? ''),
                  completed: Number(j.completed) || 0,
                  total: Number(j.total) || 0,
                });
                if (String(j.status ?? '').toLowerCase() === 'success') ok = true;
              }
            } catch {
              /* ignore partial / non-JSON line */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setPullState(null);
        setPullBusy(false);
        setPullMsg({ kind: 'info', text: t('ollama.pullCancelled', { name }) });
        pullAbort.current = null;
        return;
      }
      errText = String(e instanceof Error ? e.message : e);
    }
    pullAbort.current = null;
    setPullState(null);
    setPullBusy(false);
    if (ok && !errText) {
      setPullMsg({ kind: 'ok', text: t('ollama.pulled', { name }) });
      await loadModels();
    } else {
      setPullMsg({ kind: 'err', text: t('ollama.pullFailed', { msg: errText || 'error' }) });
    }
  };

  const cancelPull = () => {
    pullAbort.current?.abort();
  };

  // ── running ─────────────────────────────────────────────────────────────────
  const loadRunning = useCallback(
    async (baseOverride?: string) => {
      const base = norm(baseOverride ?? baseUrl);
      setRunningBusy(true);
      const body = await httpGet(base, '/api/ps', 8);
      let list: RunningInfo[] | null = null;
      if (body) {
        try {
          const j = JSON.parse(body);
          const arr = Array.isArray(j?.models) ? j.models : [];
          list = arr
            .map((m: Record<string, unknown>) => {
              const d = (m.details ?? {}) as Record<string, unknown>;
              return {
                name: String(m.name ?? m.model ?? ''),
                size: Number(m.size) || 0,
                sizeVram: Number(m.size_vram) || 0,
                parameterSize: String(d.parameter_size ?? ''),
                quantization: String(d.quantization_level ?? ''),
              };
            })
            .filter((m: RunningInfo) => m.name.length > 0)
            .sort((a: RunningInfo, b: RunningInfo) => a.name.localeCompare(b.name));
        } catch {
          list = null;
        }
      }
      if (list === null) {
        const res = await safeRun(['ps']);
        list = res.stdout.trim() ? parseCliRunning(res.stdout) : [];
      }
      setRunning(list);
      setRunningBusy(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const stopModel = async (name: string) => {
    setRunningBusy(true);
    // Unload = `ollama stop` (keep_alive 0), matching the desktop module.
    await safeRun(['stop', name]);
    await loadRunning();
  };

  // ── chat (streamed) ─────────────────────────────────────────────────────────
  const buildOptions = (): Record<string, number> => {
    const o: Record<string, number> = { temperature: temp, top_p: topP, top_k: topK };
    if (numCtx > 0) o.num_ctx = numCtx;
    const s = parseInt(seed, 10);
    if (!Number.isNaN(s)) o.seed = s;
    return o;
  };

  const sendChat = async () => {
    const model = chatModel.trim();
    if (!model) {
      setChatNote(t('ollama.pickModel'));
      return;
    }
    const text = chatInput.trim();
    if (!text) return;
    setChatNote(null);
    setChatInput('');

    const userTurn: ChatMsg = { role: 'user', content: text };
    const nextHistory = [...history, userTurn];
    setHistory(nextHistory);

    const messages: ChatMsg[] = [];
    if (system.trim()) messages.push({ role: 'system', content: system.trim() });
    messages.push(...nextHistory);

    setChatBusy(true);
    setStreaming('');
    chatCancel.current = false;

    let reply = '';
    let promptTok: number | null = null;
    let compTok: number | null = null;
    let err = '';

    if (isTauri()) {
      // Blocking non-streamed completion — the reply appears at once.
      const payload = { model, stream: false, messages, options: buildOptions() };
      const res = await httpJson(baseUrl, '/api/chat', 'POST', payload, 600);
      try {
        const j = JSON.parse(res.body || '{}');
        if (j.error) err = String(j.error);
        else {
          reply = String(j.message?.content ?? '');
          if (typeof j.prompt_eval_count === 'number') promptTok = j.prompt_eval_count;
          if (typeof j.eval_count === 'number') compTok = j.eval_count;
        }
      } catch {
        err = res.body || t('ollama.requestFailed');
      }
      if (reply) setStreaming(reply);
    } else {
      // Browser preview: real streamed tokens via fetch + ReadableStream.
      const ctrl = new AbortController();
      chatAbort.current = ctrl;
      try {
        const resp = await fetch(norm(baseUrl) + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, stream: true, messages, options: buildOptions() }),
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) {
          err = `HTTP ${resp.status}`;
        } else {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const j = JSON.parse(line);
                if (j.error) {
                  err = String(j.error);
                } else {
                  const c = String(j.message?.content ?? '');
                  if (c) {
                    reply += c;
                    setStreaming(reply);
                    if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
                  }
                  if (typeof j.prompt_eval_count === 'number') promptTok = j.prompt_eval_count;
                  if (typeof j.eval_count === 'number') compTok = j.eval_count;
                }
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') err = String(e instanceof Error ? e.message : e);
      }
      chatAbort.current = null;
    }

    setChatBusy(false);
    setStreaming('');

    if (err) {
      setHistory((h) => h.slice(0, -1)); // drop the half-finished user turn's reply expectation
      setChatNote(t('ollama.chatError', { msg: err }));
      return;
    }
    if (chatCancel.current && !reply) {
      setHistory((h) => h.slice(0, -1));
      setChatNote(t('ollama.chatStopped'));
      return;
    }
    setHistory((h) => [...h, { role: 'assistant', content: reply }]);
    if (compTok !== null) {
      setChatNote(
        promptTok !== null
          ? t('ollama.tokensBoth', { p: promptTok, c: compTok })
          : t('ollama.tokensReply', { c: compTok }),
      );
    }
    void loadRunning();
  };

  const stopChat = () => {
    chatCancel.current = true;
    chatAbort.current?.abort();
  };
  const clearChat = () => {
    setHistory([]);
    setStreaming('');
    setChatNote(null);
  };

  // ── ops ─────────────────────────────────────────────────────────────────────
  const runVerb = async (key: string, args: string[]) => {
    setOpsBusy(key);
    const res = await safeRun(args);
    setOpsOut(res.stdout.trim() || res.stderr.trim() || t('ollama.noOutput', { code: res.code }));
    setOpsBusy('');
  };
  const startServe = async () => {
    setOpsBusy('serve');
    void safeRun(['serve']); // `serve` blocks — fire and report.
    setOpsOut(t('ollama.serveStarted'));
    setOpsBusy('');
    window.setTimeout(() => void probe(), 2500);
  };
  const showDetails = async () => {
    const name = showModel.trim();
    if (!name) {
      setOpsOut(t('ollama.enterName'));
      return;
    }
    setOpsBusy('show');
    const res = await safeRun(['show', name]);
    setOpsOut(res.stdout.trim() || res.stderr.trim() || t('ollama.noOutput', { code: res.code }));
    setOpsBusy('');
  };
  const openFolder = async () => {
    setOpsBusy('folder');
    // ~/.ollama/models or $OLLAMA_MODELS
    const r = await ps(
      `$d=$env:OLLAMA_MODELS; if(-not $d){ $d=Join-Path $env:USERPROFILE '.ollama\\models' }; ` +
        `if(Test-Path $d){ Start-Process $d; 'ok:'+$d }else{ 'missing:'+$d }`,
    );
    if (r.out.startsWith('ok:')) setOpsOut(t('ollama.folderOpened', { dir: r.out.slice(3) }));
    else if (r.out.startsWith('missing:')) setOpsOut(t('ollama.folderMissing', { dir: r.out.slice(8) }));
    else setOpsOut(r.err || r.out || t('ollama.opened'));
    setOpsBusy('');
  };
  const openLibrary = async () => {
    setOpsBusy('library');
    try {
      if (isTauri()) await runCommand('explorer', ['https://ollama.com/library']);
      else window.open('https://ollama.com/library', '_blank', 'noopener');
      setOpsOut(t('ollama.opened'));
    } catch (e) {
      setOpsOut(String(e instanceof Error ? e.message : e));
    }
    setOpsBusy('');
  };

  // Auto-probe + load once on mount (reads only — safe).
  useEffect(() => {
    void (async () => {
      const ok = await probe();
      if (ok) {
        void loadModels();
        void loadRunning();
      } else {
        void loadModels(); // CLI fallback still populates the table if the daemon is off
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep chat model synced to an installed model when possible
  useEffect(() => {
    if (!models) return;
    const names = models.map((m) => m.name);
    if (chatModel && names.includes(chatModel)) return;
    if (names.length > 0 && names[0]) setChatModel(names[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  const TABS: { id: Tab; label: string }[] = [
    { id: 'models', label: t('ollama.tabModels') },
    { id: 'pull', label: t('ollama.tabPull') },
    { id: 'running', label: t('ollama.tabRunning') },
    { id: 'chat', label: t('ollama.tabChat') },
    { id: 'ops', label: t('ollama.tabOps') },
  ];

  const pullFraction = pullState && pullState.total > 0 ? pullState.completed / pullState.total : 0;
  const modelNames = models?.map((m) => m.name) ?? [];

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.subtitle')}</p>

      {/* ── Connection bar ─────────────────────────────────────────────────── */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="count-note" style={{ margin: 0 }}>{t('ollama.apiUrl')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 240, fontFamily: 'Consolas, monospace' }}
          value={urlDraft}
          placeholder={DEFAULT_URL}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void connect()}
        />
        <button className="mini" onClick={saveUrl}>{t('ollama.save')}</button>
        <button className="mini primary" disabled={probing} onClick={() => void connect()}>
          {probing ? t('ollama.connecting') : t('ollama.connect')}
        </button>
        <span className={`status-dot ${reachable ? 'on' : 'off'}`} style={{ marginLeft: 4 }}>
          <span className="dot" />
          {reachable === null
            ? t('ollama.notProbed')
            : reachable
              ? t('ollama.reachable', { version: version ?? '?' })
              : t('ollama.unreachable')}
        </span>
      </div>
      {reachable === false && (
        <p className="count-note ol-warn">{t('ollama.offlineHint')}</p>
      )}

      {/* ── Tab strip ──────────────────────────────────────────────────────── */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb.id} className={tab === tb.id ? 'mini primary' : 'mini'} onClick={() => setTab(tb.id)}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Models ─────────────────────────────────────────────────────────── */}
      {tab === 'models' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini primary" disabled={modelsBusy} onClick={() => void loadModels()}>
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
                  <th>{t('ollama.colDetail')}</th>
                  <th style={{ textAlign: 'right' }}>{t('ollama.colSize')}</th>
                  <th>{t('ollama.colModified')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td style={{ fontFamily: 'monospace' }}>{m.name}</td>
                    <td>{detailLine([m.parameterSize, m.quantization, m.family]) || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{m.size > 0 ? humanSize(m.size) : '—'}</td>
                    <td>{fmtModified(m.modified) || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {confirmDelete === m.name ? (
                        <>
                          <button className="mini danger" onClick={() => void deleteModel(m.name)}>{t('ollama.confirmDelete')}</button>{' '}
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
          {models && models.length === 0 && !modelsMsg && <p className="count-note">{t('ollama.noModels')}</p>}
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
              style={{ maxWidth: 280, fontFamily: 'Consolas, monospace' }}
              placeholder={t('ollama.pullPlaceholder')}
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !pullBusy && void pull()}
            />
            <button className="mini primary" disabled={pullBusy} onClick={() => void pull()}>
              {pullBusy ? t('ollama.pulling') : t('ollama.pull')}
            </button>
            <button className="mini" disabled={!pullBusy || isTauri()} onClick={cancelPull}>
              {t('ollama.cancel')}
            </button>
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="count-note">{t('ollama.popular')}</span>
            {POPULAR_MODELS.map((m) => (
              <button key={m} className="mini" onClick={() => setPullName(m)}>{m}</button>
            ))}
          </div>
          {pullState && (
            <div className="ol-progress">
              <div className="ol-progress-status">{pullState.status || t('ollama.pulling')}</div>
              <div className="ol-bar">
                <div
                  className={`ol-bar-fill${pullState.total > 0 ? '' : ' indet'}`}
                  style={pullState.total > 0 ? { width: `${Math.round(pullFraction * 100)}%` } : undefined}
                />
              </div>
              {pullState.total > 0 && (
                <div className="count-note" style={{ fontFamily: 'Consolas, monospace' }}>
                  {humanSize(pullState.completed)} / {humanSize(pullState.total)} ({Math.round(pullFraction * 100)}%)
                </div>
              )}
            </div>
          )}
          {pullMsg && (
            <p className="count-note" style={{ color: pullMsg.kind === 'err' ? 'var(--danger)' : undefined }}>
              {pullMsg.text}
            </p>
          )}
        </div>
      )}

      {/* ── Running ────────────────────────────────────────────────────────── */}
      {tab === 'running' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini primary" disabled={runningBusy} onClick={() => void loadRunning()}>
              {runningBusy ? t('ollama.loading') : t('ollama.refresh')}
            </button>
            {running && <span className="count-note">{t('ollama.loadedCount', { n: running.length })}</span>}
          </div>
          {running && running.length > 0 && (
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('ollama.colName')}</th>
                  <th>{t('ollama.colDetail')}</th>
                  <th style={{ textAlign: 'right' }}>{t('ollama.colSize')}</th>
                  <th>{t('ollama.colProcessor')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {running.map((m) => (
                  <tr key={m.name}>
                    <td style={{ fontFamily: 'monospace' }}>{m.name}</td>
                    <td>{detailLine([m.parameterSize, m.quantization]) || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{m.size > 0 ? humanSize(m.size) : '—'}</td>
                    <td>{processorText(m.size, m.sizeVram) || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="mini" onClick={() => void stopModel(m.name)}>{t('ollama.unload')}</button>
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
          <div className="ol-chat">
            <div className="ol-chat-main">
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <select
                  className="mod-select"
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                  style={{ minWidth: 180 }}
                >
                  {modelNames.length === 0 && <option value="">{t('ollama.pickModelPlaceholder')}</option>}
                  {modelNames.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {chatModel && !modelNames.includes(chatModel) && <option value={chatModel}>{chatModel}</option>}
                </select>
                <button className="mini" onClick={() => void loadModels()}>{t('ollama.reloadModels')}</button>
                <button className="mini" onClick={clearChat}>{t('ollama.clearChat')}</button>
              </div>

              <div className="ol-log" ref={chatScroll}>
                {history.length === 0 && !streaming && !chatBusy && (
                  <p className="count-note" style={{ textAlign: 'center', margin: 'auto' }}>{t('ollama.chatEmpty')}</p>
                )}
                {history.map((m, i) => (
                  <div key={i} className={`ol-bubble ${m.role}`}>{m.content}</div>
                ))}
                {chatBusy && (
                  <div className="ol-bubble assistant">
                    {streaming || <span className="count-note">{t('ollama.thinking')}</span>}
                  </div>
                )}
              </div>

              {chatNote && <p className="count-note ol-note">{chatNote}</p>}

              <div className="ol-composer">
                <textarea
                  className="hosts-edit"
                  style={{ flex: 1, minHeight: 56, maxHeight: 140 }}
                  placeholder={t('ollama.chatInputPlaceholder')}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      if (!chatBusy) void sendChat();
                    }
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="mini primary" disabled={chatBusy} onClick={() => void sendChat()}>
                    {chatBusy ? t('ollama.generating') : t('ollama.send')}
                  </button>
                  <button className="mini" disabled={!chatBusy} onClick={stopChat}>{t('ollama.stop')}</button>
                </div>
              </div>
            </div>

            {/* parameters */}
            <div className="ol-params">
              <div className="ol-params-title">{t('ollama.parameters')}</div>
              <label className="ol-field">
                <span className="count-note">{t('ollama.systemPrompt')}</span>
                <textarea
                  className="hosts-edit"
                  style={{ width: '100%', minHeight: 60 }}
                  placeholder={t('ollama.systemPlaceholder')}
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                />
              </label>
              <label className="ol-field">
                <span className="count-note">{t('ollama.temperature', { v: temp.toFixed(2) })}</span>
                <input type="range" min={0} max={2} step={0.05} value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
              </label>
              <label className="ol-field">
                <span className="count-note">{t('ollama.topP', { v: topP.toFixed(2) })}</span>
                <input type="range" min={0} max={1} step={0.05} value={topP} onChange={(e) => setTopP(Number(e.target.value))} />
              </label>
              <label className="ol-field">
                <span className="count-note">{t('ollama.topK', { v: topK })}</span>
                <input type="range" min={0} max={100} step={1} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
              </label>
              <label className="ol-field">
                <span className="count-note">{t('ollama.numCtx')}</span>
                <input
                  className="mod-search"
                  type="number"
                  min={0}
                  step={512}
                  value={numCtx}
                  onChange={(e) => setNumCtx(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label className="ol-field">
                <span className="count-note">{t('ollama.seed')}</span>
                <input
                  className="mod-search"
                  type="number"
                  placeholder={t('ollama.seedPlaceholder')}
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* ── Ops ────────────────────────────────────────────────────────────── */}
      {tab === 'ops' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('ollama.opsBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" disabled={opsBusy === 'serve'} onClick={() => void startServe()}>{t('ollama.startServer')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => void runVerb('version', ['--version'])}>{t('ollama.checkVersion')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => void runVerb('list', ['list'])}>{t('ollama.listCli')}</button>
            <button className="mini" disabled={!!opsBusy} onClick={() => void runVerb('ps', ['ps'])}>{t('ollama.psCli')}</button>
            <button className="mini" disabled={opsBusy === 'folder'} onClick={() => void openFolder()}>{t('ollama.openFolder')}</button>
            <button className="mini" disabled={opsBusy === 'library'} onClick={() => void openLibrary()}>{t('ollama.openLibrary')}</button>
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="count-note">{t('ollama.showLabel')}</span>
            <input
              className="mod-search"
              style={{ maxWidth: 220, fontFamily: 'Consolas, monospace' }}
              placeholder={t('ollama.showPlaceholder')}
              value={showModel}
              onChange={(e) => setShowModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !opsBusy && void showDetails()}
            />
            <button className="mini" disabled={opsBusy === 'show'} onClick={() => void showDetails()}>{t('ollama.showDetails')}</button>
          </div>
          {opsOut && <pre className="cmd-out">{opsOut}</pre>}
        </div>
      )}

      <style>{CSS}</style>
    </div>
  );
}

// ── CLI fallbacks (whitespace columns from `ollama list` / `ollama ps`) ─────────
function splitRow(line: string): string[] {
  const byWide = line.trim().split(/\s{2,}/).filter((c) => c.length > 0);
  if (byWide.length >= 2) return byWide;
  return line.trim().split(/\s+/).filter((c) => c.length > 0);
}
function parseCliModels(stdout: string): ModelInfo[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: ModelInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && /^\s*NAME\b/i.test(line)) continue;
    const cells = splitRow(line);
    const name = cells[0];
    if (!name) continue;
    out.push({
      name,
      size: 0,
      family: '',
      parameterSize: '',
      quantization: '',
      modified: cells.slice(3).join(' '),
    });
  }
  return out;
}
function parseCliRunning(stdout: string): RunningInfo[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: RunningInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && /^\s*NAME\b/i.test(line)) continue;
    const cells = splitRow(line);
    const name = cells[0];
    if (!name) continue;
    out.push({ name, size: 0, sizeVram: 0, parameterSize: '', quantization: '' });
  }
  return out;
}

const CSS = `
.ol-warn{color:#e0a030;margin-top:6px}
.ol-progress{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.ol-progress-status{font-weight:600;font-size:13px}
.ol-bar{height:8px;border-radius:6px;background:rgba(127,127,127,.18);overflow:hidden}
.ol-bar-fill{height:100%;background:var(--accent,#5b8def);border-radius:6px;transition:width .2s}
.ol-bar-fill.indet{width:35%;animation:ol-indet 1.1s ease-in-out infinite}
@keyframes ol-indet{0%{margin-left:-35%}100%{margin-left:100%}}
.ol-chat{display:flex;gap:14px;flex-wrap:wrap}
.ol-chat-main{flex:1;min-width:300px;display:flex;flex-direction:column;gap:10px}
.ol-log{min-height:240px;max-height:46vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--stroke,#3333);border-radius:8px;background:rgba(127,127,127,.05)}
.ol-bubble{padding:8px 10px;border-radius:8px;max-width:86%;white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:13.5px}
.ol-bubble.user{align-self:flex-end;background:rgba(91,141,239,.18);border:1px solid rgba(91,141,239,.30)}
.ol-bubble.assistant{align-self:flex-start;background:rgba(127,127,127,.10);border:1px solid var(--stroke,#3333)}
.ol-note{text-align:center;font-style:italic}
.ol-composer{display:flex;gap:8px;align-items:stretch}
.ol-params{width:280px;flex:0 0 280px;display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--stroke,#3333);border-radius:8px;height:fit-content}
.ol-params-title{font-weight:600;font-size:15px}
.ol-field{display:flex;flex-direction:column;gap:4px}
.ol-field input[type=range]{width:100%}
@media (max-width:720px){.ol-params{width:100%;flex-basis:100%}}
`;
