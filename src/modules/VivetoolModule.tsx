import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { pick as pickLang } from '../i18n';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs, type ModuleTab } from './ModuleTabs';

// Native module — in-app ViVeTool feature-flag manager. Wraps the real ViVeTool.exe
// (thebookisclosed/ViVe): lists the live Feature Store via /query (labelled with a bundled
// human-name dictionary), enables/disables/resets by id (single or bulk, always confirmed),
// one-click "named toggles" whose candidate ids are resolved against the live store, a
// browsable known-features catalog, /export, /import, /lkgstatus, /fullreset, scan for
// available-but-disabled experiments, and restart-explorer / reboot apply helpers.
// The live store is the source of truth; the dictionary is only a label hint and every
// change shows the resolved numeric id(s) before it is applied.

const WINGET_ID = 'thebookisclosed.ViVeTool';

// ---- bundled human-name dictionary (label hints only — never the source of truth) --------
// Mirrors WinForge Services/ViveDictionary.cs ById.
interface ViveName {
  en: string;
  zh: string;
}
const DICTIONARY: Record<number, ViveName> = {
  // File Explorer
  37634385: { en: 'File Explorer tabs', zh: '檔案總管分頁' },
  39145991: { en: 'File Explorer tab bar', zh: '檔案總管分頁列' },
  36354489: { en: 'File Explorer duplicate tab', zh: '檔案總管複製分頁' },
  40729001: { en: 'File Explorer modern address bar', zh: '檔案總管新版位址列' },
  41040327: { en: 'AI actions in File Explorer', zh: '檔案總管 AI 操作' },
  49402389: { en: 'Click to Do', zh: 'Click to Do（隨點即做）' },
  // Start menu
  42395152: { en: 'New Start menu redesign', zh: '新版開始功能表' },
  47205210: { en: 'New Start menu (category grid)', zh: '新開始功能表（分類格）' },
  49221331: { en: 'Start menu Phone Link panel', zh: '開始功能表 Phone Link 面板' },
  // Context menu / command bar
  34230003: { en: 'Modern context menu', zh: '新版右鍵選單' },
  29785184: { en: 'Command bar surfaces', zh: '命令列介面' },
  // Taskbar / clock
  37389010: { en: "Taskbar 'End Task'", zh: '工作列「結束工作」' },
  45531387: { en: 'Seconds in system clock', zh: '系統時鐘顯示秒' },
  // Snap
  26008830: { en: 'Updated Snap Layouts', zh: '新版貼齊版面' },
  38764045: { en: 'Suggested snap groups', zh: '建議貼齊群組' },
  // Power
  42105254: { en: 'Energy Saver (desktop)', zh: '節能模式（桌機）' },
};

// ---- named toggles (mirrors ViveDictionary.NamedToggles) ----------------------------------
interface NamedToggle {
  key: string;
  en: string;
  zh: string;
  en2?: string;
  zh2?: string;
  ids: number[];
  shellOnly: boolean;
}
const NAMED_TOGGLES: NamedToggle[] = [
  {
    key: 'explorer-tabs',
    en: 'File Explorer tabs',
    zh: '檔案總管分頁',
    en2: 'Tab bar + duplicate tab',
    zh2: '分頁列 + 複製分頁',
    ids: [37634385, 39145991, 36354489],
    shellOnly: true,
  },
  {
    key: 'new-start',
    en: 'New Start menu',
    zh: '新版開始功能表',
    en2: 'Scrollable surface + category grid + Phone Link',
    zh2: '可捲版面 + 分類格 + Phone Link',
    ids: [42395152, 47205210, 49221331],
    shellOnly: true,
  },
  {
    key: 'modern-context',
    en: 'Modern context menus',
    zh: '新版右鍵選單',
    ids: [34230003, 29785184],
    shellOnly: true,
  },
  {
    key: 'clock-seconds',
    en: 'Seconds in clock',
    zh: '時鐘顯示秒',
    ids: [45531387],
    shellOnly: false,
  },
  {
    key: 'snap-layouts',
    en: 'Snap Layouts (updated)',
    zh: '新版貼齊版面',
    ids: [26008830, 38764045],
    shellOnly: false,
  },
  {
    key: 'energy-saver',
    en: 'Energy Saver',
    zh: '節能模式',
    ids: [42105254],
    shellOnly: false,
  },
  {
    key: 'end-task',
    en: "Taskbar 'End Task'",
    zh: '工作列「結束工作」',
    ids: [37389010],
    shellOnly: true,
  },
  {
    key: 'click-to-do',
    en: 'Click to Do / AI actions',
    zh: 'Click to Do／AI 操作',
    en2: 'Some surfaces are server-gated',
    zh2: '部分介面受伺服器控制',
    ids: [49402389, 41040327],
    shellOnly: false,
  },
];

// ---- feature model ------------------------------------------------------------------------
interface ViveFeature {
  id: number;
  state: string; // Enabled / Disabled / Default
  priority: string;
  type: string; // Override / Experiment …
  friendlyEn: string;
  friendlyZh: string;
}

function hasFriendly(f: ViveFeature): boolean {
  return f.friendlyEn.length > 0;
}
function isEnabled(f: ViveFeature): boolean {
  return f.state.toLowerCase() === 'enabled';
}

/** Parse the textual `ViVeTool /query` output into feature rows. Never throws. */
function parseQuery(raw: string): ViveFeature[] {
  const list: ViveFeature[] = [];
  if (!raw) return list;
  let cur: ViveFeature | null = null;
  for (const lineRaw of raw.replace(/\r/g, '').split('\n')) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      let inner = line.slice(1, -1).trim();
      if (/^feature/i.test(inner)) inner = inner.slice('feature'.length).trim();
      const id = Number.parseInt(inner, 10);
      if (Number.isFinite(id) && /^\d+$/.test(inner)) {
        const name = DICTIONARY[id];
        cur = {
          id,
          state: '',
          priority: '',
          type: '',
          friendlyEn: name?.en ?? '',
          friendlyZh: name?.zh ?? '',
        };
        list.push(cur);
      } else {
        cur = null; // a section header like [Features in store]
      }
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key === 'state') cur.state = val;
    else if (key === 'priority') cur.priority = val;
    else if (key === 'type') cur.type = val;
  }
  return list;
}

export function VivetoolModule() {
  const { t } = useTranslation();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.intro')}
      </p>
      <DependencyGate tool="vivetool" preferId={WINGET_ID} query="ViVeTool">
        {(path) => <VivetoolInner path={path} />}
      </DependencyGate>
    </div>
  );
}

function VivetoolInner({ path }: { path: string }) {
  const { t, i18n } = useTranslation();
  const pick = useCallback(
    (en: string, zhs: string) => pickLang(en, zhs, i18n.language),
    [i18n.language],
  );

  const [features, setFeatures] = useState<ViveFeature[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scanMode, setScanMode] = useState(false); // list currently shows scan results
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [out, setOut] = useState('');

  // enable/disable/reset variant + store params (ViVeTool /variant: /store:)
  const [variant, setVariant] = useState('');
  const [store, setStore] = useState('');

  // export / import path
  const [profilePath, setProfilePath] = useState('');

  const run = useCallback(
    async (args: string[], label: string): Promise<CommandOutput | null> => {
      setBusy(true);
      setStatus(null);
      setOut(`> vivetool ${args.join(' ')}\n`);
      try {
        const res = await runCommand(path, args);
        setOut(res.stdout || res.stderr || `(exit ${res.code})`);
        setStatus({
          ok: res.success,
          text: res.success ? t('vivetool.done', { label }) : t('vivetool.failed', { label }),
        });
        return res;
      } catch (e) {
        setOut(String(e instanceof Error ? e.message : e));
        setStatus({ ok: false, text: t('vivetool.failed', { label }) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [path, t],
  );

  const reload = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    setOut('');
    setScanMode(false);
    try {
      const res = await runCommand(path, ['/query']);
      const parsed = parseQuery(res.stdout || '');
      // Named features first, then by id (mirrors C# OrderByDescending(HasFriendly).ThenBy(Id)).
      parsed.sort((a, b) => {
        const fa = hasFriendly(a) ? 1 : 0;
        const fb = hasFriendly(b) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return a.id - b.id;
      });
      setFeatures(parsed);
      setLoaded(true);
      if (parsed.length === 0 && !res.success) {
        setStatus({ ok: false, text: t('vivetool.failed', { label: t('vivetool.query') }) });
        setOut(res.stderr || res.stdout || `(exit ${res.code})`);
      }
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : e));
      setStatus({ ok: false, text: t('vivetool.failed', { label: t('vivetool.query') }) });
      setFeatures([]);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [path, t]);

  const confirm = useCallback(
    (text: string): boolean => (typeof window !== 'undefined' ? window.confirm(text) : false),
    [],
  );

  // ---- offer-apply after a successful mutation (restart explorer / reboot) ----
  const restartExplorer = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    setOut(t('vivetool.restartingExplorer'));
    try {
      const res = await runPowershell(
        'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; Start-Process explorer',
      );
      setStatus({
        ok: res.success,
        text: res.success
          ? t('vivetool.done', { label: t('vivetool.restartExplorer') })
          : t('vivetool.failed', { label: t('vivetool.restartExplorer') }),
      });
      if (res.stderr) setOut(res.stderr);
    } catch (e) {
      setStatus({ ok: false, text: t('vivetool.failed', { label: t('vivetool.restartExplorer') }) });
      setOut(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const reboot = useCallback(
    async (askConfirm = true) => {
      if (askConfirm && !confirm(t('vivetool.rebootConfirm'))) return;
      setBusy(true);
      setStatus(null);
      try {
        await runPowershell('shutdown /r /t 0');
      } catch {
        /* machine is going down; ignore */
      } finally {
        setBusy(false);
      }
    },
    [confirm, t],
  );

  const offerApply = useCallback(
    (shellOnly: boolean) => {
      if (shellOnly) {
        if (confirm(t('vivetool.offerApplyShell'))) void restartExplorer();
      } else if (confirm(t('vivetool.offerApplyReboot'))) {
        void reboot(false);
      }
    },
    [confirm, restartExplorer, reboot, t],
  );

  // ---- per-id verb (single or comma list), gated + confirmed ----
  const applyIds = useCallback(
    async (
      verb: 'enable' | 'disable' | 'reset',
      ids: number[],
      opts?: { shellOnly?: boolean; useParams?: boolean; skipConfirm?: boolean },
    ) => {
      if (ids.length === 0) {
        setStatus({ ok: false, text: t('vivetool.badId') });
        return null;
      }
      const idStr = ids.join(',');
      const verbLabel = t(`vivetool.${verb}`);
      if (!opts?.skipConfirm) {
        const names = ids
          .map((id) => {
            const n = DICTIONARY[id];
            return n ? `${id} (${pick(n.en, n.zh)})` : String(id);
          })
          .join('\n');
        if (!confirm(t('vivetool.confirmApply', { verb: verbLabel, ids: names }))) return null;
      }
      const args = [`/${verb}`, `/id:${idStr}`];
      // Variant / store params only meaningful on enable (mirrors ViVeTool CLI).
      if (opts?.useParams && verb === 'enable') {
        const v = variant.trim();
        const s = store.trim();
        if (v && /^\d+$/.test(v)) args.push(`/variant:${v}`);
        if (s) args.push(`/store:${s}`);
      }
      const res = await run(args, `${verbLabel} ${idStr}`);
      if (res && res.success) {
        if (opts?.shellOnly !== undefined) offerApply(opts.shellOnly);
        if (loaded && !scanMode) void reload();
      }
      return res;
    },
    [run, reload, loaded, scanMode, confirm, offerApply, variant, store, pick, t],
  );

  const parseIdList = useCallback((raw: string): number[] => {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number.parseInt(s, 10));
  }, []);

  // ---- named toggles: resolve candidate ids against the live store ----
  const presentIds = useMemo(() => new Set(features.map((f) => f.id)), [features]);

  const runToggle = useCallback(
    async (toggle: NamedToggle, verb: 'enable' | 'reset') => {
      const resolved = toggle.ids.filter((id) => presentIds.has(id));
      const missing = toggle.ids.filter((id) => !presentIds.has(id));
      if (!loaded) {
        setStatus({ ok: false, text: t('vivetool.toggleNeedsQuery') });
        return;
      }
      if (resolved.length === 0) {
        setStatus({ ok: false, text: t('vivetool.toggleNoneResolved', { name: pick(toggle.en, toggle.zh) }) });
        return;
      }
      const verbLabel = verb === 'enable' ? t('vivetool.enable') : t('vivetool.reset');
      const body = t('vivetool.toggleConfirm', {
        verb: verbLabel,
        name: pick(toggle.en, toggle.zh),
        resolved: resolved.join(', '),
        missing: missing.length ? missing.join(', ') : t('vivetool.none'),
      });
      if (!confirm(body)) return;
      await applyIds(verb, resolved, { shellOnly: toggle.shellOnly, skipConfirm: true });
    },
    [presentIds, loaded, confirm, applyIds, pick, t],
  );

  // ---- global verbs ----
  const doFullReset = useCallback(async () => {
    if (!confirm(t('vivetool.fullResetConfirm'))) return;
    const res = await run(['/fullreset'], t('vivetool.fullReset'));
    if (res && res.success && loaded && !scanMode) void reload();
  }, [run, reload, loaded, scanMode, confirm, t]);

  const doExport = useCallback(async () => {
    const p = profilePath.trim();
    if (!p) {
      setStatus({ ok: false, text: t('vivetool.needPath') });
      return;
    }
    await run(['/export', p], t('vivetool.export'));
  }, [run, profilePath, t]);

  const doImport = useCallback(async () => {
    const p = profilePath.trim();
    if (!p) {
      setStatus({ ok: false, text: t('vivetool.needPath') });
      return;
    }
    if (!confirm(t('vivetool.importConfirm', { path: p }))) return;
    const res = await run(['/import', p], t('vivetool.import'));
    if (res && res.success && loaded && !scanMode) void reload();
  }, [run, profilePath, loaded, scanMode, confirm, t]);

  const doLkg = useCallback(() => run(['/lkgstatus'], t('vivetool.lkg')), [run, t]);

  // Scan: known experiments present on THIS build but not currently enabled
  // (diff live store against the dictionary — mirrors ScanAvailableDisabled).
  const scanAvailable = useCallback(async () => {
    if (!loaded) await reload();
    setScanMode(true);
    setStatus({ ok: true, text: t('vivetool.scanNote') });
  }, [loaded, reload, t]);

  // ---- Feature Store view ----
  const [filter, setFilter] = useState('');

  const scanRows = useMemo(
    () => features.filter((f) => hasFriendly(f) && !isEnabled(f)),
    [features],
  );

  const baseRows = scanMode ? scanRows : features;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return baseRows;
    return baseRows.filter(
      (x) =>
        String(x.id).includes(f) ||
        x.friendlyEn.toLowerCase().includes(f) ||
        x.friendlyZh.includes(filter.trim()) ||
        x.state.toLowerCase().includes(f) ||
        x.type.toLowerCase().includes(f) ||
        x.priority.toLowerCase().includes(f),
    );
  }, [baseRows, filter]);

  const enabledCount = useMemo(() => features.filter(isEnabled).length, [features]);

  const featureStoreTab = (
    <>
      {/* Global verbs */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={busy} onClick={() => void reload()}>
          {busy ? t('vivetool.loading') : t('vivetool.query')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void scanAvailable()}>
          {t('vivetool.scan')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void doLkg()}>
          {t('vivetool.lkg')}
        </button>
      </div>

      {loaded && (
        <div className="panel">
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ maxWidth: 320 }}
              placeholder={t('vivetool.filter')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="count-note">
              {scanMode
                ? t('vivetool.scanCount', { shown: shown.length })
                : t('vivetool.count', { shown: shown.length, total: features.length, enabled: enabledCount })}
            </span>
            {scanMode && (
              <button className="mini" disabled={busy} onClick={() => setScanMode(false)}>
                {t('vivetool.showAll')}
              </button>
            )}
          </div>
          {baseRows.length === 0 ? (
            <p className="count-note">{scanMode ? t('vivetool.scanEmpty') : t('vivetool.empty')}</p>
          ) : shown.length === 0 ? (
            <p className="count-note">{t('vivetool.noMatch')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>{t('vivetool.colName')}</th>
                    <th>{t('vivetool.colId')}</th>
                    <th>{t('vivetool.colState')}</th>
                    <th>{t('vivetool.colType')}</th>
                    <th>{t('vivetool.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((feat) => (
                    <tr key={feat.id}>
                      <td>{hasFriendly(feat) ? pick(feat.friendlyEn, feat.friendlyZh) : t('vivetool.unnamed')}</td>
                      <td style={{ fontFamily: 'monospace' }}>{feat.id}</td>
                      <td>{feat.state || '—'}</td>
                      <td>{feat.type || '—'}</td>
                      <td>
                        <span className="row-actions">
                          <button
                            className="mini primary"
                            disabled={busy}
                            onClick={() => void applyIds('enable', [feat.id])}
                          >
                            {t('vivetool.enable')}
                          </button>
                          <button
                            className="mini"
                            disabled={busy}
                            onClick={() => void applyIds('disable', [feat.id])}
                          >
                            {t('vivetool.disable')}
                          </button>
                          <button
                            className="mini"
                            disabled={busy}
                            onClick={() => void applyIds('reset', [feat.id])}
                          >
                            {t('vivetool.reset')}
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {!loaded && <p className="count-note">{t('vivetool.queryFirst')}</p>}
    </>
  );

  // ---- Named toggles view ----
  const togglesTab = (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.togglesNote')}
      </p>
      {!loaded && (
        <p className="count-note">
          {t('vivetool.toggleNeedsQuery')}{' '}
          <button className="mini" disabled={busy} onClick={() => void reload()}>
            {t('vivetool.query')}
          </button>
        </p>
      )}
      <div className="panel">
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('vivetool.colToggle')}</th>
                <th>{t('vivetool.colResolved')}</th>
                <th>{t('vivetool.colApply')}</th>
                <th>{t('vivetool.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {NAMED_TOGGLES.map((tog) => {
                const resolved = tog.ids.filter((id) => presentIds.has(id));
                const missing = tog.ids.filter((id) => !presentIds.has(id));
                return (
                  <tr key={tog.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{pick(tog.en, tog.zh)}</div>
                      {tog.en2 && (
                        <div className="count-note" style={{ margin: 0 }}>
                          {pick(tog.en2, tog.zh2 ?? tog.en2)}
                        </div>
                      )}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {loaded
                        ? resolved.length
                          ? resolved.join(', ')
                          : t('vivetool.none')
                        : tog.ids.join(', ')}
                      {loaded && missing.length > 0 && (
                        <div className="count-note" style={{ margin: 0 }}>
                          {t('vivetool.skipped', { ids: missing.join(', ') })}
                        </div>
                      )}
                    </td>
                    <td>{tog.shellOnly ? t('vivetool.applyShell') : t('vivetool.applyReboot')}</td>
                    <td>
                      <span className="row-actions">
                        <button
                          className="mini primary"
                          disabled={busy || !loaded || resolved.length === 0}
                          onClick={() => void runToggle(tog, 'enable')}
                        >
                          {t('vivetool.enable')}
                        </button>
                        <button
                          className="mini"
                          disabled={busy || !loaded || resolved.length === 0}
                          onClick={() => void runToggle(tog, 'reset')}
                        >
                          {t('vivetool.reset')}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  // ---- Known features catalog view ----
  const [catFilter, setCatFilter] = useState('');
  const catalogRows = useMemo(() => {
    const entries = Object.entries(DICTIONARY).map(([id, name]) => ({
      id: Number.parseInt(id, 10),
      en: name.en,
      zh: name.zh,
    }));
    const q = catFilter.trim().toLowerCase();
    const filtered = q
      ? entries.filter(
          (e) =>
            String(e.id).includes(q) ||
            e.en.toLowerCase().includes(q) ||
            e.zh.includes(catFilter.trim()),
        )
      : entries;
    return filtered.sort((a, b) => a.en.localeCompare(b.en));
  }, [catFilter]);

  const catalogTab = (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.catalogNote')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          placeholder={t('vivetool.catalogFilter')}
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
        />
        <span className="count-note">{t('vivetool.catalogCount', { n: catalogRows.length })}</span>
      </div>
      <div className="panel">
        {catalogRows.length === 0 ? (
          <p className="count-note">{t('vivetool.noMatch')}</p>
        ) : (
          <div className="dt-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('vivetool.colName')}</th>
                  <th>{t('vivetool.colId')}</th>
                  <th>{t('vivetool.colOnBuild')}</th>
                  <th>{t('vivetool.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {catalogRows.map((row) => {
                  const present = presentIds.has(row.id);
                  return (
                    <tr key={row.id}>
                      <td>{pick(row.en, row.zh)}</td>
                      <td style={{ fontFamily: 'monospace' }}>{row.id}</td>
                      <td>
                        {loaded ? (present ? t('vivetool.present') : t('vivetool.absent')) : '—'}
                      </td>
                      <td>
                        <span className="row-actions">
                          <button
                            className="mini primary"
                            disabled={busy}
                            onClick={() => void applyIds('enable', [row.id])}
                          >
                            {t('vivetool.enable')}
                          </button>
                          <button
                            className="mini"
                            disabled={busy}
                            onClick={() => void applyIds('disable', [row.id])}
                          >
                            {t('vivetool.disable')}
                          </button>
                          <button
                            className="mini"
                            disabled={busy}
                            onClick={() => void applyIds('reset', [row.id])}
                          >
                            {t('vivetool.reset')}
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );

  // ---- Manual / bulk by-id + params view ----
  const [idInput, setIdInput] = useState('');
  const manualIds = parseIdList(idInput);

  const manualTab = (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.idNote')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 260 }}
          placeholder={t('vivetool.idPlaceholder')}
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
        />
        <button
          className="mini primary"
          disabled={busy}
          onClick={() => void applyIds('enable', manualIds, { useParams: true })}
        >
          {t('vivetool.enable')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void applyIds('disable', manualIds)}>
          {t('vivetool.disable')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void applyIds('reset', manualIds)}>
          {t('vivetool.reset')}
        </button>
      </div>

      {/* variant / store params (enable only) */}
      <div className="hosts-edit">
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('vivetool.paramsNote')}
        </p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ maxWidth: 160 }}
            placeholder={t('vivetool.variantPlaceholder')}
            value={variant}
            onChange={(e) => setVariant(e.target.value)}
          />
          <input
            className="mod-search"
            style={{ maxWidth: 200 }}
            placeholder={t('vivetool.storePlaceholder')}
            value={store}
            onChange={(e) => setStore(e.target.value)}
          />
        </div>
      </div>
      {manualIds.length > 1 && (
        <p className="count-note">{t('vivetool.bulkNote', { n: manualIds.length })}</p>
      )}
    </>
  );

  // ---- Profiles + system apply view ----
  const profilesTab = (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.profilesNote')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 340 }}
          placeholder={t('vivetool.profilePlaceholder')}
          value={profilePath}
          onChange={(e) => setProfilePath(e.target.value)}
        />
        <button className="mini" disabled={busy} onClick={() => void doExport()}>
          {t('vivetool.export')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void doImport()}>
          {t('vivetool.import')}
        </button>
      </div>

      <p className="count-note">{t('vivetool.applyNote')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={busy} onClick={() => void restartExplorer()}>
          {t('vivetool.restartExplorer')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void reboot()}>
          {t('vivetool.reboot')}
        </button>
      </div>

      <p className="count-note">{t('vivetool.dangerNote')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={busy} onClick={() => void doFullReset()}>
          {t('vivetool.fullReset')}
        </button>
      </div>
    </>
  );

  const tabs: ModuleTab[] = [
    { id: 'store', en: 'Feature Store', zh: 'Feature Store', render: () => featureStoreTab },
    { id: 'toggles', en: 'Named toggles', zh: '有名嘅切換', render: () => togglesTab },
    { id: 'catalog', en: 'Known features', zh: '已知功能', render: () => catalogTab },
    { id: 'manual', en: 'By ID', zh: '用 ID', render: () => manualTab },
    { id: 'profiles', en: 'Profiles & apply', zh: '設定檔與套用', render: () => profilesTab },
  ];

  return (
    <>
      <ModuleTabs tabs={tabs} />

      {status && (
        <p
          className="count-note"
          style={{ color: status.ok ? 'var(--ok, inherit)' : 'var(--danger)' }}
        >
          {status.text}
        </p>
      )}

      {out && <pre className="cmd-out">{out}</pre>}

      <p className="count-note">{t('vivetool.adminNote')}</p>
    </>
  );
}
