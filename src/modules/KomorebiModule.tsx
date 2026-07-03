import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand } from '../tauri/bridge';
import { ModuleToolbar, StatusDot } from './common';

// ============================================================================
//  Komorebi · 平鋪視窗管理 — native React port of WinForge's KomorebiModule.
//  Drives the user-installed `komorebic` CLI: detect install, control the
//  daemon (start/stop/restart), show the live monitors → workspaces → windows
//  tree from `komorebic state`, switch layouts, navigate workspaces, edit
//  padding, add window rules, manage config, and inspect raw state JSON.
//  Read-only until the operator explicitly presses an action button.
// ============================================================================

const LAYOUTS: { value: string; en: string; zh: string }[] = [
  { value: 'bsp', en: 'BSP (binary split)', zh: 'BSP（二元分割）' },
  { value: 'columns', en: 'Columns', zh: '直欄' },
  { value: 'rows', en: 'Rows', zh: '橫列' },
  { value: 'vertical-stack', en: 'Vertical stack', zh: '垂直堆疊' },
  { value: 'horizontal-stack', en: 'Horizontal stack', zh: '水平堆疊' },
  { value: 'ultrawide-vertical-stack', en: 'Ultrawide vertical stack', zh: '超寬垂直堆疊' },
  { value: 'grid', en: 'Grid', zh: '網格' },
  { value: 'right-main-vertical-stack', en: 'Right-main vertical stack', zh: '右主垂直堆疊' },
  { value: 'scrolling', en: 'Scrolling', zh: '捲動' },
];

// One komorebic toggle/action op surfaced as a button row.
const OPS: { verb: string; args?: string[]; en: string; zh: string; descEn: string; descZh: string }[] = [
  { verb: 'toggle-tiling', en: 'Toggle tiling', zh: '切換平鋪', descEn: 'Turn automatic tiling on or off on the focused workspace.', descZh: '喺聚焦工作區開／熄自動平鋪。' },
  { verb: 'toggle-float', en: 'Toggle float', zh: '切換浮動', descEn: 'Float or re-manage the currently focused window.', descZh: '將聚焦視窗設為浮動或重新管理。' },
  { verb: 'toggle-monocle', en: 'Toggle monocle', zh: '切換單片', descEn: 'Expand the focused window to fill the workspace (monocle).', descZh: '將聚焦視窗放大填滿工作區（單片模式）。' },
  { verb: 'toggle-pause', en: 'Toggle pause', zh: '切換暫停', descEn: 'Pause or resume komorebi tiling globally.', descZh: '全域暫停或恢復 komorebi 平鋪。' },
  { verb: 'promote', en: 'Promote window', zh: '提升視窗', descEn: 'Promote the focused window to the primary position.', descZh: '將聚焦視窗提升到主要位置。' },
  { verb: 'retile', en: 'Retile', zh: '重新平鋪', descEn: 'Force a re-tile of all managed windows.', descZh: '強制重新平鋪所有受管視窗。' },
  { verb: 'session-float-rule', en: 'Float this window (session)', zh: '浮動此視窗（本次）', descEn: 'Float the focused window for this session only.', descZh: '只喺今次工作階段浮動聚焦視窗。' },
  { verb: 'clear-session-float-rules', en: 'Clear session float rules', zh: '清除本次浮動規則', descEn: 'Remove all session-only float rules.', descZh: '移除所有本次工作階段嘅浮動規則。' },
  { verb: 'mouse-follows-focus', args: ['enable'], en: 'Mouse follows focus (on)', zh: '滑鼠跟隨聚焦（開）', descEn: 'Move the mouse cursor to the focused window.', descZh: '將滑鼠游標移到聚焦視窗。' },
  { verb: 'mouse-follows-focus', args: ['disable'], en: 'Mouse follows focus (off)', zh: '滑鼠跟隨聚焦（熄）', descEn: 'Stop moving the mouse cursor to the focused window.', descZh: '唔再將滑鼠游標移到聚焦視窗。' },
];

interface CliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface KomoWindow {
  title: string;
  exe: string;
}
interface KomoWorkspace {
  index: number;
  name: string;
  layout: string;
  focused: boolean;
  windows: KomoWindow[];
}
interface KomoMonitor {
  index: number;
  name: string;
  focused: boolean;
  workspaces: KomoWorkspace[];
}

// Run a raw komorebic command; never throws, always returns a CliResult.
async function komorebic(args: string[]): Promise<CliResult> {
  if (!isTauri()) {
    return { success: false, stdout: '', stderr: 'komorebic bridge unavailable (browser mode)', code: -1 };
  }
  try {
    return await runCommand('komorebic', args);
  } catch (e) {
    return { success: false, stdout: '', stderr: String((e as Error)?.message ?? e), code: -1 };
  }
}

// ----- state JSON parsing (mirrors KomorebiService.Parse) -----
type J = Record<string, unknown>;

function ring(parent: unknown, name: string): { items: J[]; focused: number } {
  const p = parent as J | undefined;
  const r = p?.[name];
  if (Array.isArray(r)) return { items: r as J[], focused: 0 };
  if (r && typeof r === 'object') {
    const ro = r as J;
    const els = ro.elements;
    const focused = typeof ro.focused === 'number' ? (ro.focused as number) : 0;
    if (Array.isArray(els)) return { items: els as J[], focused };
  }
  return { items: [], focused: 0 };
}

function str(el: J | undefined, name: string): string {
  const v = el?.[name];
  return typeof v === 'string' ? v : '';
}

function readLayout(ws: J): string {
  const lay = ws.layout;
  if (typeof lay === 'string') return lay;
  if (lay && typeof lay === 'object') {
    for (const [k, v] of Object.entries(lay as J)) {
      if (typeof v === 'string') return v;
      return k;
    }
  }
  return '';
}

function parseState(json: string): { monitors: KomoMonitor[]; error?: string } {
  let raw = json.trim().replace(/^﻿/, '');
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { monitors: [], error: raw || 'empty state' };
  raw = raw.slice(a, b + 1);
  let root: J;
  try {
    root = JSON.parse(raw) as J;
  } catch (e) {
    return { monitors: [], error: String((e as Error)?.message ?? e) };
  }
  const mons = ring(root, 'monitors');
  const monitors: KomoMonitor[] = mons.items.map((mEl, mi) => {
    const mFocused = mi === mons.focused;
    const wss = ring(mEl, 'workspaces');
    const workspaces: KomoWorkspace[] = wss.items.map((wsEl, wi) => {
      const windows: KomoWindow[] = [];
      const addWin = (winEl: J) => {
        windows.push({ title: str(winEl, 'title'), exe: str(winEl, 'exe') });
      };
      const conts = ring(wsEl, 'containers');
      for (const cEl of conts.items) for (const w of ring(cEl, 'windows').items) addWin(w);
      for (const w of ring(wsEl, 'floating_windows').items) addWin(w);
      const mono = wsEl.monocle_container;
      if (mono && typeof mono === 'object') for (const w of ring(mono, 'windows').items) addWin(w);
      const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      return {
        index: wi,
        name: str(wsEl, 'name') || roman[wi] || String(wi + 1),
        layout: readLayout(wsEl),
        focused: mFocused && wi === wss.focused,
        windows,
      };
    });
    return {
      index: mi,
      name: str(mEl, 'name') || str(mEl, 'device') || `Monitor ${mi}`,
      focused: mFocused,
      workspaces,
    };
  });
  return { monitors };
}

export function KomorebiModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh') ?? false;
  const P = useCallback((en: string, zhTxt: string) => (zh ? zhTxt : en), [zh]);

  const [installed, setInstalled] = useState<boolean | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [monitors, setMonitors] = useState<KomoMonitor[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rawOut, setRawOut] = useState<string | null>(null);

  // form state
  const [withBar, setWithBar] = useState(false);
  const [layout, setLayout] = useState('bsp');
  const [wsIndex, setWsIndex] = useState(0);
  const [wsPad, setWsPad] = useState(20);
  const [contPad, setContPad] = useState(20);
  const [ruleKind, setRuleKind] = useState<'workspace' | 'ignore' | 'manage'>('workspace');
  const [ruleId, setRuleId] = useState('exe');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleMon, setRuleMon] = useState(0);
  const [ruleWs, setRuleWs] = useState(0);
  const [opsFilter, setOpsFilter] = useState('');
  const [confirmVerb, setConfirmVerb] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshTree = useCallback(async () => {
    const r = await komorebic(['state']);
    if (!alive.current) return;
    const parsed = parseState(r.stdout || '');
    setMonitors(parsed.monitors);
    setTreeError(parsed.error ?? null);
  }, []);

  const refresh = useCallback(async () => {
    const ver = await komorebic(['--version']);
    const isInstalled =
      ver.stdout.trim().length > 0 &&
      !/not recognized|not found|cannot find/i.test(ver.stdout + ver.stderr);
    if (!alive.current) return;
    setInstalled(isInstalled);
    if (!isInstalled) {
      setRunning(null);
      setMonitors([]);
      return;
    }
    const st = await komorebic(['state']);
    if (!alive.current) return;
    const isRunning = st.success && st.stdout.trimStart().startsWith('{');
    setRunning(isRunning);
    if (isRunning) await refreshTree();
    else {
      setMonitors([]);
      setTreeError(null);
    }
  }, [refreshTree]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Run a guarded command: disables controls, shows result, then refreshes.
  const guarded = useCallback(
    async (args: string[], okEn: string, okZh: string) => {
      if (busy) return;
      setBusy(true);
      setMsg(null);
      try {
        const r = await komorebic(args);
        if (r.success) setMsg({ ok: true, text: P(okEn, okZh) });
        else
          setMsg({
            ok: false,
            text: `${P('Failed', '失敗')}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 400)}`,
          });
      } catch (e) {
        setMsg({ ok: false, text: `${P('Error', '錯誤')}: ${String(e)}` });
      } finally {
        if (alive.current) {
          setBusy(false);
          await refresh();
        }
      }
    },
    [busy, P, refresh],
  );

  const start = () => guarded(withBar ? ['start', '--bar'] : ['start'], 'Daemon started.', '守護程序已啟動。');
  const stop = () => guarded(['stop'], 'Daemon stopped, windows restored.', '守護程序已停止，視窗已還原。');
  const restart = () => guarded(['restart'], 'Daemon restarted.', '守護程序已重新啟動。');

  const applyLayout = () => guarded(['change-layout', layout], `Layout set to ${layout}.`, `排版已設為 ${layout}。`);
  const cycleNext = () => guarded(['cycle-layout', 'next'], 'Cycled to next layout.', '已切換到下一個排版。');
  const cyclePrev = () => guarded(['cycle-layout', 'previous'], 'Cycled to previous layout.', '已切換到上一個排版。');

  const focusWs = () => guarded(['focus-workspace', String(wsIndex)], `Focused workspace ${wsIndex}.`, `已聚焦工作區 ${wsIndex}。`);
  const moveWs = () => guarded(['move-to-workspace', String(wsIndex)], `Window moved to workspace ${wsIndex}.`, `視窗已移去工作區 ${wsIndex}。`);
  const sendWs = () => guarded(['send-to-workspace', String(wsIndex)], `Window sent to workspace ${wsIndex}.`, `視窗已送去工作區 ${wsIndex}。`);

  const applyPad = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const a = await komorebic(['focused-workspace-padding', String(wsPad)]);
      const b = await komorebic(['focused-workspace-container-padding', String(contPad)]);
      if (a.success && b.success) setMsg({ ok: true, text: P('Padding applied to focused workspace.', '間距已套用到聚焦工作區。') });
      else
        setMsg({
          ok: false,
          text: `${P('Failed', '失敗')}: ${[a.stderr, b.stderr].filter(Boolean).join(' ').trim().slice(0, 400)}`,
        });
    } finally {
      if (alive.current) {
        setBusy(false);
        await refresh();
      }
    }
  };

  const addRule = () => {
    const val = ruleValue.trim();
    if (!val) {
      setMsg({ ok: false, text: P('Enter an identifier value first (e.g. firefox.exe).', '請先輸入識別碼值（例如 firefox.exe）。') });
      return;
    }
    const args =
      ruleKind === 'ignore'
        ? ['ignore-rule', ruleId, val]
        : ruleKind === 'manage'
          ? ['manage-rule', ruleId, val]
          : ['workspace-rule', ruleId, val, String(ruleMon), String(ruleWs)];
    return guarded(args, `Rule added: ${ruleKind} ${ruleId} ${val}.`, `已加規則：${ruleKind} ${ruleId} ${val}。`);
  };

  const reloadConfig = () => guarded(['reload-configuration'], 'Configuration reloaded.', '設定已重新載入。');
  const quickstart = () => guarded(['quickstart'], 'Example configuration gathered.', '已收集範例設定。');

  const runOp = async (op: (typeof OPS)[number]) => {
    if (opBusy) return;
    setOpBusy(op.verb + (op.args?.join('') ?? ''));
    setMsg(null);
    try {
      const r = await komorebic([op.verb, ...(op.args ?? [])]);
      if (r.success) setMsg({ ok: true, text: `${P('Done', '完成')}: ${P(op.en, op.zh)}` });
      else
        setMsg({
          ok: false,
          text: `${P('Failed', '失敗')}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 400)}`,
        });
    } finally {
      if (alive.current) {
        setOpBusy(null);
        await refreshTree();
      }
    }
  };

  const showRaw = async (args: string[]) => {
    setRawOut(P('Loading…', '載入中…'));
    const r = await komorebic(args);
    if (!alive.current) return;
    const body = (r.stdout || r.stderr || '').trim() || P('(no output)', '（冇輸出）');
    setRawOut(body.length > 12000 ? body.slice(0, 12000) + '\n…' : body);
  };

  const shownOps = useMemo(() => {
    const f = opsFilter.trim().toLowerCase();
    if (!f) return OPS;
    return OPS.filter((o) => `${o.en} ${o.zh} ${o.verb} ${o.descEn} ${o.descZh}`.toLowerCase().includes(f));
  }, [opsFilter]);

  const windowCount = useMemo(
    () => monitors.reduce((n, m) => n + m.workspaces.reduce((k, w) => k + w.windows.length, 0), 0),
    [monitors],
  );

  const controlsDisabled = busy || installed === false;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {P(
          'Drive the Komorebi tiling window manager: start/stop the daemon, switch layouts, navigate workspaces, set gaps, add window rules and reload the config — all over the komorebic CLI.',
          '操控 Komorebi 平鋪視窗管理：開／停守護程序、切換排版、切換工作區、設定間距、加視窗規則同重新載入設定 — 全部經 komorebic CLI。',
        )}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={() => void refresh()} disabled={busy}>
          ⟳ {t('komorebi.refresh')}
        </button>
        {installed !== null && (
          <StatusDot
            ok={running === true}
            label={
              installed === false
                ? P('Not installed', '未安裝')
                : running
                  ? P('Daemon running', '守護程序執行中')
                  : P('Daemon not running', '守護程序未執行')
            }
          />
        )}
        {running && <span className="count-note">{t('komorebi.windowCount', { num: windowCount })}</span>}
      </ModuleToolbar>

      {installed === false && (
        <p className="mod-msg">
          {P(
            'Komorebi (komorebic) was not found on PATH. Install it with:  winget install LGUG2Z.komorebi  — then press Refresh.',
            '喺 PATH 搵唔到 Komorebi（komorebic）。用 winget install LGUG2Z.komorebi 安裝，然後撳重新整理。',
          )}
        </p>
      )}

      {running === false && installed && (
        <p className="mod-msg">
          {P(
            'Komorebi takes over tiling and may rearrange your windows. Save your work first — you can Stop any time to restore windows.',
            'Komorebi 會接管視窗平鋪，可能會重新排列。請先儲存工作 — 隨時可撳停止還原視窗。',
          )}
        </p>
      )}

      {msg && <p className={`mod-msg ${msg.ok ? '' : 'error'}`}>{msg.text}</p>}

      {/* daemon lifecycle */}
      <section className="hosts-edit" style={{ marginTop: 8 }}>
        <h4 style={{ marginTop: 0 }}>{t('komorebi.lifecycle')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="mini primary" onClick={start} disabled={controlsDisabled || running === true}>
            {t('komorebi.start')}
          </button>
          <button className="mini" onClick={stop} disabled={controlsDisabled || running !== true}>
            {t('komorebi.stop')}
          </button>
          <button className="mini" onClick={restart} disabled={controlsDisabled || running !== true}>
            {t('komorebi.restart')}
          </button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={withBar} onChange={(e) => setWithBar(e.target.checked)} />
            {t('komorebi.withBar')}
          </label>
        </div>
      </section>

      {/* layout switcher */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.layoutHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.layoutHint')}</p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <select value={layout} onChange={(e) => setLayout(e.target.value)} disabled={controlsDisabled}>
            {LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {P(l.en, l.zh)}
              </option>
            ))}
          </select>
          <button className="mini" onClick={applyLayout} disabled={controlsDisabled || running !== true}>
            {t('komorebi.applyLayout')}
          </button>
          <button className="mini" onClick={cyclePrev} disabled={controlsDisabled || running !== true}>
            {t('komorebi.cyclePrev')}
          </button>
          <button className="mini" onClick={cycleNext} disabled={controlsDisabled || running !== true}>
            {t('komorebi.cycleNext')}
          </button>
        </div>
      </section>

      {/* live state tree */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.treeHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.treeHint')}</p>
        {running !== true ? (
          <p className="count-note">{t('komorebi.treeStartHint')}</p>
        ) : treeError ? (
          <pre className="cmd-out error">{t('komorebi.treeError', { detail: treeError.slice(0, 300) })}</pre>
        ) : monitors.length === 0 ? (
          <p className="count-note">{t('komorebi.treeEmpty')}</p>
        ) : (
          <div className="dt-wrap">
            {monitors.map((m) => (
              <div key={m.index} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600 }}>
                  {(m.focused ? '★ ' : '') + P(`Monitor ${m.index}: ${m.name}`, `顯示器 ${m.index}：${m.name}`)}
                </div>
                {m.workspaces.map((w) => (
                  <div key={w.index} style={{ marginLeft: 16 }}>
                    <div style={{ opacity: 0.9 }}>
                      {(w.focused ? '★ ' : '') +
                        P(
                          `Workspace ${w.index} (${w.name})${w.layout ? ' · ' + w.layout : ''} — ${w.windows.length} win`,
                          `工作區 ${w.index}（${w.name}）${w.layout ? ' · ' + w.layout : ''} — ${w.windows.length} 個視窗`,
                        )}
                    </div>
                    {w.windows.map((win, i) => (
                      <div key={i} style={{ marginLeft: 20, fontSize: 12, opacity: 0.75 }}>
                        {(win.title.trim() || win.exe) + (win.exe ? '  ·  ' + win.exe : '')}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* workspace navigation + padding */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.wsHeader')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.wsLabel')}
            <input
              type="number"
              min={0}
              max={20}
              value={wsIndex}
              onChange={(e) => setWsIndex(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <button className="mini" onClick={focusWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.focusWs')}
          </button>
          <button className="mini" onClick={moveWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.moveWs')}
          </button>
          <button className="mini" onClick={sendWs} disabled={controlsDisabled || running !== true}>
            {t('komorebi.sendWs')}
          </button>
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.wsPad')}
            <input
              type="number"
              min={0}
              max={200}
              value={wsPad}
              onChange={(e) => setWsPad(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('komorebi.contPad')}
            <input
              type="number"
              min={0}
              max={200}
              value={contPad}
              onChange={(e) => setContPad(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 70 }}
            />
          </label>
          <button className="mini" onClick={() => void applyPad()} disabled={controlsDisabled || running !== true}>
            {t('komorebi.applyPad')}
          </button>
        </div>
      </section>

      {/* window rules */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.rulesHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.rulesHint')}</p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as typeof ruleKind)} disabled={controlsDisabled}>
            <option value="workspace">{t('komorebi.ruleWorkspace')}</option>
            <option value="ignore">{t('komorebi.ruleIgnore')}</option>
            <option value="manage">{t('komorebi.ruleManage')}</option>
          </select>
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} disabled={controlsDisabled}>
            <option value="exe">exe</option>
            <option value="class">class</option>
            <option value="title">title</option>
            <option value="path">path</option>
          </select>
          <input
            className="mod-search"
            placeholder="firefox.exe"
            value={ruleValue}
            onChange={(e) => setRuleValue(e.target.value)}
            style={{ minWidth: 200 }}
          />
        </div>
        {ruleKind === 'workspace' && (
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('komorebi.ruleMon')}
              <input type="number" min={0} max={20} value={ruleMon} onChange={(e) => setRuleMon(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('komorebi.ruleWs')}
              <input type="number" min={0} max={20} value={ruleWs} onChange={(e) => setRuleWs(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} />
            </label>
          </div>
        )}
        <div className="row-actions" style={{ marginTop: 8 }}>
          <button className="mini" onClick={addRule} disabled={controlsDisabled}>
            {t('komorebi.addRule')}
          </button>
        </div>
      </section>

      {/* configuration */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.configHeader')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('komorebi.configHint')}</p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="mini" onClick={reloadConfig} disabled={controlsDisabled || running !== true}>
            {t('komorebi.reloadConfig')}
          </button>
          <button className="mini" onClick={quickstart} disabled={controlsDisabled}>
            {t('komorebi.quickstart')}
          </button>
        </div>
      </section>

      {/* raw inspectors */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.inspectHeader')}</h4>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="mini" onClick={() => void showRaw(['state'])} disabled={installed === false}>
            {t('komorebi.rawState')}
          </button>
          <button className="mini" onClick={() => void showRaw(['global-state'])} disabled={installed === false}>
            {t('komorebi.globalState')}
          </button>
          <button className="mini" onClick={() => void showRaw(['check'])} disabled={installed === false}>
            {t('komorebi.check')}
          </button>
          {rawOut !== null && (
            <button className="mini" onClick={() => setRawOut(null)}>
              {t('komorebi.clear')}
            </button>
          )}
        </div>
        {rawOut !== null && (
          <pre className="cmd-out" style={{ maxHeight: 260, overflow: 'auto' }}>
            {rawOut}
          </pre>
        )}
      </section>

      {/* operations */}
      <section className="hosts-edit">
        <h4 style={{ marginTop: 0 }}>{t('komorebi.opsHeader', { num: OPS.length })}</h4>
        <input
          className="mod-search"
          placeholder={t('komorebi.opsFilter')}
          value={opsFilter}
          onChange={(e) => setOpsFilter(e.target.value)}
          style={{ maxWidth: 420, marginBottom: 8 }}
        />
        {shownOps.map((op) => {
          const key = op.verb + (op.args?.join('') ?? '');
          const destructive = op.verb === 'toggle-pause';
          return (
            <div
              key={key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 16,
                padding: '6px 2px',
                borderTop: '1px solid var(--card-stroke, rgba(128,128,128,0.2))',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{P(op.en, op.zh)}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{P(op.descEn, op.descZh)}</div>
              </div>
              {destructive && confirmVerb === key ? (
                <span className="row-actions">
                  <button
                    className="mini primary"
                    onClick={() => {
                      setConfirmVerb(null);
                      void runOp(op);
                    }}
                    disabled={installed === false}
                  >
                    {t('komorebi.confirm')}
                  </button>
                  <button className="mini" onClick={() => setConfirmVerb(null)}>
                    {t('komorebi.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  className="mini"
                  onClick={() => (destructive ? setConfirmVerb(key) : void runOp(op))}
                  disabled={installed === false || opBusy === key}
                >
                  {opBusy === key ? '…' : t('komorebi.run')}
                </button>
              )}
            </div>
          );
        })}
      </section>

      <p className="count-note">{t('komorebi.hotkeyNote')}</p>
    </div>
  );
}
