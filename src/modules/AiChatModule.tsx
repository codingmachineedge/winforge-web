import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell } from '../tauri/bridge';

// Native "OpenWebUI-style" AI chat, ported from WinForge's AiChatModule.
// Talks to the LIVE local Ollama REST API (http://localhost:11434 by default) via
// PowerShell Invoke-RestMethod through the Tauri bridge:
//   • GET  /api/version        — reachability + version probe
//   • GET  /api/tags           — installed models (size / params / quant)
//   • GET  /api/ps             — models currently loaded in memory
//   • POST /api/chat           — a real chat completion (system prompt + full history)
//   • POST /api/pull           — download a model
//   • DELETE /api/delete       — remove a model (confirmed)
// Persistent conversations (per-chat system prompt, temperature, max tokens),
// message actions (copy / regenerate / edit-&-resend / delete), fenced-code
// rendering with copy-code, attach-a-text-file, and .md / .json export — all
// mirrored from the C# module and kept fully bilingual. Never throws on a bad
// network / empty state; the whole UI still renders with Ollama absent.

const DEFAULT_URL = 'http://localhost:11434';
const STORAGE_CHATS = 'winforge.aichat.conversations';
const STORAGE_URL = 'winforge.aichat.baseUrl';
const POPULAR = ['llama3.2', 'llama3.1', 'qwen2.5', 'gemma2', 'mistral', 'phi3', 'deepseek-r1'];

type Role = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  tokens?: number;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  messages: ChatMessage[];
  updated: number;
}

interface ModelInfo {
  name: string;
  size: number;
  parameterSize: string;
  quantization: string;
}

interface RunningInfo {
  name: string;
  processor: string;
}

// ── persistence (mirrors the C# LocalAppData JSON store) ──────────────────────
function loadChats(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_CHATS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  } catch {
    return [];
  }
}
function saveChats(list: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_CHATS, JSON.stringify(list));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
function loadUrl(): string {
  try {
    return localStorage.getItem(STORAGE_URL)?.trim() || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function norm(url: string): string {
  return (url || '').trim().replace(/\/+$/, '') || DEFAULT_URL;
}
function psq(s: string): string {
  // single-quote a string for a PowerShell literal
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

// Split assistant text into prose / fenced-code segments (ported from SplitFences).
interface Segment {
  code: boolean;
  lang: string;
  text: string;
}
function splitFences(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let prose = '';
  const src = s ?? '';
  while (i < src.length) {
    const fence = src.indexOf('```', i);
    if (fence < 0) {
      prose += src.slice(i);
      break;
    }
    prose += src.slice(i, fence);
    const langEnd = src.indexOf('\n', fence + 3);
    if (langEnd < 0) {
      prose += src.slice(fence);
      break;
    }
    const lang = src.slice(fence + 3, langEnd).trim();
    const close = src.indexOf('```', langEnd + 1);
    if (close < 0) {
      if (prose) {
        out.push({ code: false, lang: '', text: prose });
        prose = '';
      }
      out.push({ code: true, lang, text: src.slice(langEnd + 1) });
      return out;
    }
    if (prose) {
      out.push({ code: false, lang: '', text: prose });
      prose = '';
    }
    out.push({ code: true, lang, text: src.slice(langEnd + 1, close) });
    i = close + 3;
  }
  if (prose) out.push({ code: false, lang: '', text: prose });
  return out;
}

async function ps(script: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await runPowershell(script);
    return { ok: r.success, out: r.stdout.trim(), err: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: '', err: String(e instanceof Error ? e.message : e) };
  }
}

export function AiChatModule() {
  const { t } = useTranslation();

  const [baseUrl, setBaseUrl] = useState<string>(loadUrl);
  const [urlDraft, setUrlDraft] = useState<string>(loadUrl);
  const [chats, setChats] = useState<Conversation[]>(() => loadChats());
  const [activeId, setActiveId] = useState<string>('');
  const [search, setSearch] = useState('');

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [running, setRunning] = useState<RunningInfo[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [confirmDelChat, setConfirmDelChat] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Manage dialog state
  const [pullName, setPullName] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pullMsg, setPullMsg] = useState('');
  const [confirmDelModel, setConfirmDelModel] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const active = useMemo(() => chats.find((c) => c.id === activeId) ?? null, [chats, activeId]);

  const persist = useCallback((next: Conversation[]) => {
    const sorted = [...next].sort((a, b) => b.updated - a.updated);
    setChats(sorted);
    saveChats(sorted);
  }, []);

  const patchActive = useCallback(
    (patch: Partial<Conversation>) => {
      if (!active) return;
      const next = chats.map((c) => (c.id === active.id ? { ...c, ...patch, updated: Date.now() } : c));
      persist(next);
    },
    [active, chats, persist],
  );

  const newChat = useCallback(() => {
    const c: Conversation = {
      id: uid(),
      title: t('aichat.newChat'),
      model: models[0]?.name ?? '',
      systemPrompt: '',
      temperature: 0.8,
      maxTokens: 0,
      messages: [],
      updated: Date.now(),
    };
    const next = [c, ...chats];
    persist(next);
    setActiveId(c.id);
    setStatus(null);
  }, [chats, models, persist, t]);

  // seed a first conversation once
  useEffect(() => {
    if (chats.length === 0) {
      const c: Conversation = {
        id: uid(),
        title: t('aichat.newChat'),
        model: '',
        systemPrompt: '',
        temperature: 0.8,
        maxTokens: 0,
        messages: [],
        updated: Date.now(),
      };
      persist([c]);
      setActiveId(c.id);
    } else if (!activeId) {
      setActiveId(chats[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── live probes ────────────────────────────────────────────────────────────
  const refreshModels = useCallback(async () => {
    const base = norm(baseUrl);
    const ver = await ps(
      `try{(Invoke-RestMethod -Uri '${base}/api/version' -TimeoutSec 6).version}catch{''}`,
    );
    const v = ver.out.trim();
    setVersion(v || null);
    setReachable(!!v);

    const tags = await ps(
      `try{(Invoke-RestMethod -Uri '${base}/api/tags' -TimeoutSec 8).models | ForEach-Object {` +
        `[pscustomobject]@{name=$_.name;size=[int64]$_.size;p=[string]$_.details.parameter_size;q=[string]$_.details.quantization_level}} | ConvertTo-Json -Compress}catch{''}`,
    );
    setModels(parseModels(tags.out));

    const ps2 = await ps(
      `try{(Invoke-RestMethod -Uri '${base}/api/ps' -TimeoutSec 8).models | ForEach-Object {` +
        `$g=0;if($_.size -gt 0 -and $_.size_vram -gt 0){$g=[int][math]::Round(100.0*$_.size_vram/$_.size)};` +
        `[pscustomobject]@{name=$_.name;proc=$(if($_.size -le 0){''}elseif($_.size_vram -le 0){'100% CPU'}elseif($_.size_vram -ge $_.size){'100% GPU'}else{"$g% GPU / $(100-$g)% CPU"})}} | ConvertTo-Json -Compress}catch{''}`,
    );
    setRunning(parseRunning(ps2.out));
  }, [baseUrl]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  // auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active?.messages, busy]);

  function parseModels(out: string): ModelInfo[] {
    if (!out) return [];
    try {
      const raw = JSON.parse(out);
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr
        .filter((m) => m && m.name)
        .map((m) => ({
          name: String(m.name),
          size: Number(m.size) || 0,
          parameterSize: String(m.p ?? ''),
          quantization: String(m.q ?? ''),
        }));
    } catch {
      return [];
    }
  }
  function parseRunning(out: string): RunningInfo[] {
    if (!out) return [];
    try {
      const raw = JSON.parse(out);
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.filter((m) => m && m.name).map((m) => ({ name: String(m.name), processor: String(m.proc ?? '') }));
    } catch {
      return [];
    }
  }

  // ── send / chat ────────────────────────────────────────────────────────────
  const runChat = useCallback(
    async (history: ChatMessage[], convo: Conversation) => {
      const base = norm(baseUrl);
      const model = convo.model || models[0]?.name || '';
      if (!model) {
        setStatus({ kind: 'error', text: t('aichat.noModel') });
        return;
      }
      setBusy(true);
      setStatus(null);

      // build the /api/chat payload as a PowerShell hashtable → JSON
      const msgs: { role: string; content: string }[] = [];
      if (convo.systemPrompt.trim()) msgs.push({ role: 'system', content: convo.systemPrompt });
      for (const m of history) msgs.push({ role: m.role, content: m.content });

      const payload: Record<string, unknown> = {
        model,
        stream: false,
        messages: msgs,
        options: { temperature: convo.temperature },
      };
      if (convo.maxTokens > 0) (payload.options as Record<string, unknown>).num_predict = convo.maxTokens;

      const json = JSON.stringify(payload);
      const script =
        `$body=${psq(json)};` +
        `try{$r=Invoke-RestMethod -Uri '${base}/api/chat' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600;` +
        `[pscustomobject]@{content=$r.message.content;tokens=[int]$r.eval_count} | ConvertTo-Json -Compress}` +
        `catch{[pscustomobject]@{error=$_.Exception.Message} | ConvertTo-Json -Compress}`;

      const res = await ps(script);
      let content = '';
      let tokens: number | undefined;
      let err = '';
      try {
        const parsed = JSON.parse(res.out || '{}');
        if (parsed.error) err = String(parsed.error);
        else {
          content = String(parsed.content ?? '');
          if (parsed.tokens) tokens = Number(parsed.tokens);
        }
      } catch {
        err = res.err || res.out || t('aichat.requestFailed');
      }

      setBusy(false);

      if (err || !content.trim()) {
        setStatus({ kind: 'error', text: err || t('aichat.emptyReply') });
        return;
      }

      const assistant: ChatMessage = { id: uid(), role: 'assistant', content, tokens };
      const nextMsgs = [...history, assistant];
      const next = chats.map((c) => (c.id === convo.id ? { ...c, messages: nextMsgs, updated: Date.now() } : c));
      persist(next);
    },
    [baseUrl, chats, models, persist, t],
  );

  const send = useCallback(async () => {
    if (!active || busy) return;
    const text = input.trim();
    if (!text) return;
    setInput('');

    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text };
    let title = active.title;
    const isFirst = active.messages.filter((m) => m.role === 'user').length === 0;
    if (isFirst && (!active.title.trim() || active.title === t('aichat.newChat'))) {
      title = text.length > 40 ? text.slice(0, 40) + '…' : text;
    }
    const history = [...active.messages, userMsg];
    const updated: Conversation = { ...active, title, messages: history, updated: Date.now() };
    persist(chats.map((c) => (c.id === active.id ? updated : c)));
    await runChat(history, updated);
  }, [active, busy, chats, input, persist, runChat, t]);

  const regenerate = useCallback(
    async (assistantId: string) => {
      if (!active || busy) return;
      const idx = active.messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const history = active.messages.slice(0, idx);
      const updated: Conversation = { ...active, messages: history, updated: Date.now() };
      persist(chats.map((c) => (c.id === active.id ? updated : c)));
      await runChat(history, updated);
    },
    [active, busy, chats, persist, runChat],
  );

  const editResend = useCallback(
    async (userId: string) => {
      if (!active || busy) return;
      const idx = active.messages.findIndex((m) => m.id === userId);
      if (idx < 0) return;
      const current = active.messages[idx]!.content;
      const edited = window.prompt(t('aichat.editPrompt'), current);
      if (edited === null) return;
      const trimmed = edited.trim();
      if (!trimmed) return;
      const history = [...active.messages.slice(0, idx), { id: uid(), role: 'user' as Role, content: trimmed }];
      const updated: Conversation = { ...active, messages: history, updated: Date.now() };
      persist(chats.map((c) => (c.id === active.id ? updated : c)));
      await runChat(history, updated);
    },
    [active, busy, chats, persist, runChat, t],
  );

  const deleteMessage = useCallback(
    (id: string) => {
      if (!active) return;
      patchActive({ messages: active.messages.filter((m) => m.id !== id) });
    },
    [active, patchActive],
  );

  const copyText = useCallback((key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
  }, []);

  // ── conversation ops ───────────────────────────────────────────────────────
  const renameChat = useCallback(
    (c: Conversation) => {
      const name = window.prompt(t('aichat.renamePrompt'), c.title);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      persist(chats.map((x) => (x.id === c.id ? { ...x, title: trimmed, updated: Date.now() } : x)));
    },
    [chats, persist, t],
  );

  const deleteChat = useCallback(
    (id: string) => {
      const next = chats.filter((c) => c.id !== id);
      setConfirmDelChat(null);
      if (next.length === 0) {
        const c: Conversation = {
          id: uid(),
          title: t('aichat.newChat'),
          model: models[0]?.name ?? '',
          systemPrompt: '',
          temperature: 0.8,
          maxTokens: 0,
          messages: [],
          updated: Date.now(),
        };
        persist([c]);
        setActiveId(c.id);
      } else {
        persist(next);
        if (activeId === id) setActiveId(next[0]!.id);
      }
    },
    [activeId, chats, models, persist, t],
  );

  const exportChat = useCallback(
    (c: Conversation, json: boolean) => {
      let text: string;
      let mime: string;
      if (json) {
        text = JSON.stringify(c, null, 2);
        mime = 'application/json';
      } else {
        const lines: string[] = [`# ${c.title}`, ''];
        if (c.systemPrompt.trim()) lines.push(`> **System / 系統:** ${c.systemPrompt}`, '');
        for (const m of c.messages) {
          lines.push(`### ${m.role === 'user' ? 'You · 你' : 'Assistant · 助手'}`, '', m.content, '');
        }
        text = lines.join('\n');
        mime = 'text/markdown';
      }
      const safe = (c.title || 'chat').replace(/[^\w\-. ]+/g, '_').slice(0, 60);
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safe + (json ? '.json' : '.md');
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ kind: 'info', text: t('aichat.exported') });
    },
    [t],
  );

  // ── attach a text file into the composer ───────────────────────────────────
  const onAttach = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      try {
        let content = await f.text();
        if (content.length > 100_000) content = content.slice(0, 100_000) + '\n…[truncated]';
        setInput((prev) => `${prev}\n\n--- ${f.name} ---\n${content}\n--- end ${f.name} ---\n`);
      } catch (err) {
        setStatus({ kind: 'error', text: `${t('aichat.attachFailed')}: ${String(err)}` });
      }
    },
    [t],
  );

  // ── model management (pull / delete) ───────────────────────────────────────
  const pullModel = useCallback(async () => {
    const name = pullName.trim();
    if (!name) return;
    setPullBusy(true);
    setPullMsg(t('aichat.pulling', { name }));
    const base = norm(baseUrl);
    // non-streaming pull: one request, then re-list
    const res = await ps(
      `$body=${psq(JSON.stringify({ model: name, stream: false }))};` +
        `try{$r=Invoke-RestMethod -Uri '${base}/api/pull' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 1800;` +
        `[string]$r.status}catch{'ERR:'+$_.Exception.Message}`,
    );
    const ok = /success/i.test(res.out) && !res.out.startsWith('ERR:');
    setPullMsg(ok ? t('aichat.pulled', { name }) : `${t('aichat.pullFailed')}: ${res.out || res.err}`);
    setPullBusy(false);
    if (ok) await refreshModels();
  }, [baseUrl, pullName, refreshModels, t]);

  const deleteModel = useCallback(
    async (name: string) => {
      setConfirmDelModel(null);
      const base = norm(baseUrl);
      await ps(
        `$body=${psq(JSON.stringify({ model: name }))};` +
          `try{Invoke-RestMethod -Uri '${base}/api/delete' -Method Delete -Body $body -ContentType 'application/json' -TimeoutSec 30 | Out-Null;'ok'}catch{'err'}`,
      );
      await refreshModels();
    },
    [baseUrl, refreshModels],
  );

  const saveUrl = useCallback(() => {
    const n = norm(urlDraft);
    setBaseUrl(n);
    try {
      localStorage.setItem(STORAGE_URL, n);
    } catch {
      /* non-fatal */
    }
  }, [urlDraft]);

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? chats.filter((c) => (c.title || '').toLowerCase().includes(q)) : chats;
  }, [chats, search]);

  const modelNames = useMemo(() => models.map((m) => m.name), [models]);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="mod aichat">
      <div className="aichat-wrap">
        {/* Sidebar */}
        <aside className="aichat-side">
          <div className="aichat-side-top">
            <button className="mini primary aichat-newbtn" onClick={newChat}>
              ✚ {t('aichat.newChat')}
            </button>
            <input
              className="mod-search"
              placeholder={t('aichat.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="count-note aichat-side-header">{t('aichat.conversations')}</div>
          <div className="aichat-convo-list">
            {filteredChats.length === 0 && <p className="count-note">{t('aichat.noConversations')}</p>}
            {filteredChats.map((c) => (
              <div
                key={c.id}
                className={`aichat-convo ${c.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="aichat-convo-title">{c.title || t('aichat.untitled')}</span>
                <span className="aichat-convo-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="mini" title={t('aichat.rename')} onClick={() => renameChat(c)}>
                    ✎
                  </button>
                  <button className="mini" title={t('aichat.exportMd')} onClick={() => exportChat(c, false)}>
                    ↧md
                  </button>
                  <button className="mini" title={t('aichat.exportJson')} onClick={() => exportChat(c, true)}>
                    ↧json
                  </button>
                  {confirmDelChat === c.id ? (
                    <>
                      <button className="mini" onClick={() => deleteChat(c.id)}>
                        {t('aichat.confirm')}
                      </button>
                      <button className="mini" onClick={() => setConfirmDelChat(null)}>
                        {t('aichat.cancel')}
                      </button>
                    </>
                  ) : (
                    <button className="mini" title={t('aichat.delete')} onClick={() => setConfirmDelChat(c.id)}>
                      ✕
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* Main pane */}
        <section className="aichat-main">
          {/* Top bar */}
          <div className="aichat-topbar">
            <input
              className="aichat-title-input"
              value={active?.title ?? ''}
              placeholder={t('aichat.conversationPlaceholder')}
              onChange={(e) => patchActive({ title: e.target.value })}
            />
            <select
              className="aichat-select"
              value={active?.model ?? ''}
              onChange={(e) => patchActive({ model: e.target.value })}
            >
              <option value="">{t('aichat.selectModel')}</option>
              {modelNames.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {active?.model && !modelNames.includes(active.model) && (
                <option value={active.model}>{active.model}</option>
              )}
            </select>
            <button className="mini" onClick={() => setShowSettings((v) => !v)}>
              ⚙ {t('aichat.settings')}
            </button>
            <button className="mini" onClick={() => setShowManage((v) => !v)}>
              ▤ {t('aichat.manage')}
            </button>
            <button className="mini" onClick={() => void refreshModels()}>
              ⟳ {t('modules.refresh')}
            </button>
            <span className="count-note aichat-conn">
              {reachable === null
                ? ''
                : reachable
                  ? t('aichat.connected', { version: version ?? '?' })
                  : t('aichat.offline')}
            </span>
          </div>

          {/* Settings panel (per-chat) */}
          {showSettings && active && (
            <div className="panel aichat-settings">
              <div className="aichat-settings-title">{t('aichat.settings')}</div>
              <label className="aichat-field">
                <span className="count-note">{t('aichat.systemPrompt')}</span>
                <textarea
                  className="hosts-edit"
                  style={{ width: '100%', minHeight: 72 }}
                  value={active.systemPrompt}
                  onChange={(e) => patchActive({ systemPrompt: e.target.value })}
                />
              </label>
              <div className="aichat-field-row">
                <label className="aichat-field">
                  <span className="count-note">
                    {t('aichat.temperature')}: {active.temperature.toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={active.temperature}
                    onChange={(e) => patchActive({ temperature: Number(e.target.value) })}
                  />
                </label>
                <label className="aichat-field">
                  <span className="count-note">{t('aichat.maxTokens')}</span>
                  <input
                    className="mod-search"
                    type="number"
                    min={0}
                    max={131072}
                    value={active.maxTokens}
                    onChange={(e) => patchActive({ maxTokens: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
              </div>
            </div>
          )}

          {/* Manage panel (providers/models) */}
          {showManage && (
            <div className="panel aichat-manage">
              <div className="aichat-settings-title">{t('aichat.manageTitle')}</div>
              <label className="aichat-field">
                <span className="count-note">{t('aichat.baseUrl')}</span>
                <span className="aichat-field-row">
                  <input
                    className="mod-search"
                    style={{ flex: 1 }}
                    value={urlDraft}
                    onChange={(e) => setUrlDraft(e.target.value)}
                    placeholder={DEFAULT_URL}
                  />
                  <button className="mini" onClick={saveUrl}>
                    {t('aichat.save')}
                  </button>
                </span>
              </label>

              {reachable === false && (
                <p className="count-note aichat-warn">{t('aichat.ollamaNotRunning')}</p>
              )}

              <div className="aichat-field-row" style={{ flexWrap: 'wrap' }}>
                <input
                  className="mod-search"
                  style={{ maxWidth: 240 }}
                  placeholder={t('aichat.pullPlaceholder')}
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !pullBusy && void pullModel()}
                />
                <button className="mini primary" disabled={pullBusy} onClick={() => void pullModel()}>
                  {pullBusy ? t('aichat.pullingShort') : t('aichat.pull')}
                </button>
              </div>
              <div className="aichat-field-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="count-note">{t('aichat.popular')}</span>
                {POPULAR.map((m) => (
                  <button key={m} className="mini" onClick={() => setPullName(m)}>
                    {m}
                  </button>
                ))}
              </div>
              {pullMsg && <pre className="cmd-out">{pullMsg}</pre>}

              <div className="count-note aichat-side-header">
                {t('aichat.installedModels', { n: models.length })}
              </div>
              {models.length === 0 ? (
                <p className="count-note">{t('aichat.noModelsInstalled')}</p>
              ) : (
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('aichat.colModel')}</th>
                      <th style={{ textAlign: 'right' }}>{t('aichat.colSize')}</th>
                      <th>{t('aichat.colDetail')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => (
                      <tr key={m.name}>
                        <td style={{ fontFamily: 'monospace' }}>{m.name}</td>
                        <td style={{ textAlign: 'right' }}>{humanSize(m.size)}</td>
                        <td>{[m.parameterSize, m.quantization].filter(Boolean).join(' · ')}</td>
                        <td style={{ textAlign: 'right' }}>
                          {confirmDelModel === m.name ? (
                            <>
                              <button className="mini" onClick={() => void deleteModel(m.name)}>
                                {t('aichat.confirm')}
                              </button>{' '}
                              <button className="mini" onClick={() => setConfirmDelModel(null)}>
                                {t('aichat.cancel')}
                              </button>
                            </>
                          ) : (
                            <button className="mini" onClick={() => setConfirmDelModel(m.name)}>
                              {t('aichat.delete')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {running.length > 0 && (
                <>
                  <div className="count-note aichat-side-header">{t('aichat.runningModels')}</div>
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>{t('aichat.colModel')}</th>
                        <th>{t('aichat.colProcessor')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {running.map((r) => (
                        <tr key={r.name}>
                          <td style={{ fontFamily: 'monospace' }}>{r.name}</td>
                          <td>{r.processor}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {status && (
            <div className={`aichat-status ${status.kind}`}>
              <span>{status.text}</span>
              <button className="mini" onClick={() => setStatus(null)}>
                ✕
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="aichat-messages" ref={scrollRef}>
            {active && active.messages.length === 0 && !busy && (
              <p className="count-note aichat-empty">{t('aichat.emptyChat')}</p>
            )}
            {active?.messages.map((m) => (
              <div key={m.id} className={`aichat-msg ${m.role}`}>
                <div className="aichat-msg-head">
                  <span className="aichat-role">{m.role === 'user' ? t('aichat.you') : t('aichat.assistant')}</span>
                  {typeof m.tokens === 'number' && <span className="count-note">· {m.tokens} tok</span>}
                </div>
                <div className="aichat-bubble">
                  {splitFences(m.content).map((seg, i) =>
                    seg.code ? (
                      <div className="aichat-code" key={i}>
                        <div className="aichat-code-bar">
                          <span className="count-note">{seg.lang || 'code'}</span>
                          <button
                            className="mini"
                            onClick={() => copyText(`${m.id}-${i}`, seg.text.replace(/\n+$/, ''))}
                          >
                            {copied === `${m.id}-${i}` ? t('aichat.copied') : t('aichat.copyCode')}
                          </button>
                        </div>
                        <pre>{seg.text.replace(/\n+$/, '')}</pre>
                      </div>
                    ) : (
                      seg.text.trim() && (
                        <p className="aichat-prose" key={i}>
                          {seg.text.replace(/^\n+|\n+$/g, '')}
                        </p>
                      )
                    ),
                  )}
                </div>
                <div className="aichat-msg-actions">
                  <button className="mini" onClick={() => copyText(m.id, m.content)}>
                    {copied === m.id ? t('aichat.copied') : t('aichat.copy')}
                  </button>
                  {m.role === 'user' ? (
                    <button className="mini" disabled={busy} onClick={() => void editResend(m.id)}>
                      {t('aichat.editResend')}
                    </button>
                  ) : (
                    <button className="mini" disabled={busy} onClick={() => void regenerate(m.id)}>
                      {t('aichat.regenerate')}
                    </button>
                  )}
                  <button className="mini" onClick={() => deleteMessage(m.id)}>
                    {t('aichat.delete')}
                  </button>
                </div>
              </div>
            ))}
            {busy && <p className="count-note aichat-thinking">{t('aichat.thinking')}</p>}
          </div>

          {/* Composer */}
          <div className="aichat-composer">
            <button className="mini" title={t('aichat.attach')} onClick={() => fileRef.current?.click()}>
              📎
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.cs,.json,.log,.xml,.yml,.yaml,.py,.js,.ts"
              style={{ display: 'none' }}
              onChange={onAttach}
            />
            <textarea
              className="aichat-input"
              placeholder={t('aichat.messagePlaceholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="mini primary aichat-send" disabled={busy || !input.trim()} onClick={() => void send()}>
              {busy ? '…' : '➤'}
            </button>
          </div>
        </section>
      </div>

      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.aichat-wrap{display:flex;gap:0;height:calc(100vh - 190px);min-height:420px;border:1px solid var(--border,#3333);border-radius:10px;overflow:hidden}
.aichat-side{width:250px;flex:0 0 250px;display:flex;flex-direction:column;border-right:1px solid var(--border,#3333);background:rgba(127,127,127,.05)}
.aichat-side-top{padding:10px;display:flex;flex-direction:column;gap:8px}
.aichat-newbtn{width:100%}
.aichat-side-header{margin:6px 12px 2px;font-size:12px;opacity:.7}
.aichat-convo-list{flex:1;overflow-y:auto;padding:4px 8px 8px}
.aichat-convo{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:13px}
.aichat-convo:hover{background:rgba(127,127,127,.12)}
.aichat-convo.active{background:rgba(127,127,127,.20)}
.aichat-convo-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.aichat-convo-actions{display:none;gap:2px;flex:0 0 auto}
.aichat-convo:hover .aichat-convo-actions,.aichat-convo.active .aichat-convo-actions{display:flex}
.aichat-convo-actions .mini{padding:1px 5px;font-size:11px}
.aichat-main{flex:1;display:flex;flex-direction:column;min-width:0}
.aichat-topbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border,#3333);flex-wrap:wrap}
.aichat-title-input{flex:1;min-width:120px;border:0;background:transparent;font-size:15px;font-weight:600;color:inherit;padding:4px 2px}
.aichat-title-input:focus{outline:none;border-bottom:1px solid var(--accent,#5b8def)}
.aichat-select{padding:5px 8px;border-radius:6px;background:rgba(127,127,127,.10);color:inherit;border:1px solid var(--border,#3333);max-width:200px}
.aichat-conn{margin-left:auto}
.aichat-settings,.aichat-manage{margin:10px 12px;display:flex;flex-direction:column;gap:10px}
.aichat-settings-title{font-weight:600;font-size:13px}
.aichat-field{display:flex;flex-direction:column;gap:4px}
.aichat-field-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.aichat-field-row .aichat-field{flex:1;min-width:140px}
.aichat-warn{color:#e0a030}
.aichat-status{margin:8px 12px;padding:8px 10px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px}
.aichat-status.info{background:rgba(80,140,255,.14)}
.aichat-status.warn{background:rgba(224,160,48,.16)}
.aichat-status.error{background:rgba(224,64,64,.16)}
.aichat-messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:16px}
.aichat-empty,.aichat-thinking{text-align:center;margin:auto 0}
.aichat-msg{display:flex;flex-direction:column;gap:4px;max-width:820px;width:100%;align-self:center}
.aichat-msg-head{display:flex;gap:8px;align-items:center;font-size:12px;opacity:.75}
.aichat-role{font-weight:600}
.aichat-bubble{padding:10px 12px;border-radius:10px;border:1px solid var(--border,#3333);background:rgba(127,127,127,.06);white-space:normal}
.aichat-msg.user .aichat-bubble{background:rgba(91,141,239,.16);border-color:rgba(91,141,239,.30)}
.aichat-prose{white-space:pre-wrap;word-break:break-word;margin:0 0 6px;line-height:1.5}
.aichat-prose:last-child{margin-bottom:0}
.aichat-code{margin:6px 0;border:1px solid var(--border,#3333);border-radius:8px;overflow:hidden;background:rgba(0,0,0,.22)}
.aichat-code-bar{display:flex;justify-content:space-between;align-items:center;padding:3px 8px;background:rgba(127,127,127,.10)}
.aichat-code pre{margin:0;padding:8px 10px;overflow-x:auto;font-family:Consolas,monospace;font-size:12.5px;line-height:1.45}
.aichat-msg-actions{display:flex;gap:4px;opacity:.5;transition:opacity .12s}
.aichat-msg:hover .aichat-msg-actions{opacity:1}
.aichat-msg-actions .mini{padding:1px 7px;font-size:11px}
.aichat-composer{display:flex;gap:6px;align-items:flex-end;padding:10px 14px;border-top:1px solid var(--border,#3333)}
.aichat-input{flex:1;resize:vertical;min-height:42px;max-height:160px;padding:9px 10px;border-radius:8px;border:1px solid var(--border,#3333);background:rgba(127,127,127,.06);color:inherit;font-family:inherit;font-size:14px}
.aichat-input:focus{outline:none;border-color:var(--accent,#5b8def)}
.aichat-send{align-self:stretch;min-width:44px}
`;
