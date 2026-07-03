import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — in-app ViVeTool feature-flag manager. Wraps the real ViVeTool.exe
// (thebookisclosed/ViVe): lists the live Feature Store via /query, enables/disables/resets
// by id, /fullreset, /export, /import, /lkgstatus, plus restart-explorer / reboot helpers.
// The live store is the source of truth; ids are shown before any change is applied.

interface ViveFeature {
  id: number;
  state: string; // Enabled / Disabled / Default
  priority: string;
  type: string; // Override / Experiment …
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
        cur = { id, state: '', priority: '', type: '' };
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

function isEnabled(f: ViveFeature): boolean {
  return f.state.toLowerCase() === 'enabled';
}

const WINGET_ID = 'thebookisclosed.ViVeTool';

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
  const { t } = useTranslation();

  const [features, setFeatures] = useState<ViveFeature[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [out, setOut] = useState('');

  // manual by-id action inputs
  const [idInput, setIdInput] = useState('');

  // export / import paths
  const [profilePath, setProfilePath] = useState('');

  const run = useCallback(
    async (args: string[], label: string): Promise<CommandOutput | null> => {
      setBusy(true);
      setStatus(null);
      setOut(`> vivetool ${args.join(' ')}\n`);
      try {
        const res = await runCommand(path, args);
        setOut(res.stdout || res.stderr || `(exit ${res.code})`);
        setStatus({ ok: res.success, text: res.success ? t('vivetool.done', { label }) : t('vivetool.failed', { label }) });
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
    try {
      const res = await runCommand(path, ['/query']);
      const parsed = parseQuery(res.stdout || '');
      parsed.sort((a, b) => a.id - b.id);
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

  // Per-id verb; refreshes the store afterward so the list reflects the change.
  const applyId = useCallback(
    async (verb: 'enable' | 'disable' | 'reset', rawId: string) => {
      const id = rawId.trim();
      if (!/^\d+(,\d+)*$/.test(id)) {
        setStatus({ ok: false, text: t('vivetool.badId') });
        return;
      }
      const res = await run([`/${verb}`, `/id:${id}`], t(`vivetool.${verb}`));
      if (res && res.success && loaded) void reload();
    },
    [run, reload, loaded, t],
  );

  const doFullReset = useCallback(async () => {
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined' ? window.confirm(t('vivetool.fullResetConfirm')) : false;
    if (!ok) return;
    const res = await run(['/fullreset'], t('vivetool.fullReset'));
    if (res && res.success && loaded) void reload();
  }, [run, reload, loaded, t]);

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
    const res = await run(['/import', p], t('vivetool.import'));
    if (res && res.success && loaded) void reload();
  }, [run, profilePath, loaded, t]);

  const doLkg = useCallback(() => run(['/lkgstatus'], t('vivetool.lkg')), [run, t]);

  // Apply helpers (built-in OS actions, run via PowerShell so they work regardless of ViVeTool path).
  const restartExplorer = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    setOut(t('vivetool.restartingExplorer'));
    try {
      const res = await runPowershell('Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; Start-Process explorer');
      setStatus({ ok: res.success, text: res.success ? t('vivetool.done', { label: t('vivetool.restartExplorer') }) : t('vivetool.failed', { label: t('vivetool.restartExplorer') }) });
      if (res.stderr) setOut(res.stderr);
    } catch (e) {
      setStatus({ ok: false, text: t('vivetool.failed', { label: t('vivetool.restartExplorer') }) });
      setOut(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const reboot = useCallback(async () => {
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined' ? window.confirm(t('vivetool.rebootConfirm')) : false;
    if (!ok) return;
    setBusy(true);
    setStatus(null);
    try {
      await runPowershell('shutdown /r /t 0');
    } catch {
      /* machine is going down; ignore */
    } finally {
      setBusy(false);
    }
  }, [t]);

  const scanDisabled = useCallback(() => {
    setFilter('');
    // Non-enabled features present in the live store — the "available to try" view.
    setStatus({ ok: true, text: t('vivetool.scanNote') });
  }, [t]);

  // ---- derived list ----
  const f = filter.trim().toLowerCase();
  const shown = features.filter((x) => {
    if (!f) return true;
    return (
      String(x.id).includes(f) ||
      x.state.toLowerCase().includes(f) ||
      x.type.toLowerCase().includes(f) ||
      x.priority.toLowerCase().includes(f)
    );
  });

  const enabledCount = features.filter(isEnabled).length;

  return (
    <>
      {/* Toolbar: manual by-id verbs */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          placeholder={t('vivetool.idPlaceholder')}
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
        />
        <button className="mini primary" disabled={busy} onClick={() => void applyId('enable', idInput)}>
          {t('vivetool.enable')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void applyId('disable', idInput)}>
          {t('vivetool.disable')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void applyId('reset', idInput)}>
          {t('vivetool.reset')}
        </button>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vivetool.idNote')}
      </p>

      {/* Global verbs */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={busy} onClick={() => void reload()}>
          {busy ? t('vivetool.loading') : t('vivetool.query')}
        </button>
        <button className="mini" disabled={busy || !loaded} onClick={scanDisabled}>
          {t('vivetool.scan')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void doLkg()}>
          {t('vivetool.lkg')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void restartExplorer()}>
          {t('vivetool.restartExplorer')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void reboot()}>
          {t('vivetool.reboot')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void doFullReset()}>
          {t('vivetool.fullReset')}
        </button>
      </div>

      {/* Export / import */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
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

      {status && (
        <p className="count-note" style={{ color: status.ok ? 'var(--ok, inherit)' : 'var(--danger)' }}>
          {status.text}
        </p>
      )}

      {/* Feature Store list */}
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
              {t('vivetool.count', { shown: shown.length, total: features.length, enabled: enabledCount })}
            </span>
          </div>
          {features.length === 0 ? (
            <p className="count-note">{t('vivetool.empty')}</p>
          ) : shown.length === 0 ? (
            <p className="count-note">{t('vivetool.noMatch')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>{t('vivetool.colId')}</th>
                    <th>{t('vivetool.colState')}</th>
                    <th>{t('vivetool.colType')}</th>
                    <th>{t('vivetool.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((feat) => (
                    <tr key={feat.id}>
                      <td style={{ fontFamily: 'monospace' }}>{feat.id}</td>
                      <td>{feat.state || '—'}</td>
                      <td>{feat.type || '—'}</td>
                      <td>
                        <button className="mini primary" disabled={busy} onClick={() => void applyId('enable', String(feat.id))}>
                          {t('vivetool.enable')}
                        </button>{' '}
                        <button className="mini" disabled={busy} onClick={() => void applyId('disable', String(feat.id))}>
                          {t('vivetool.disable')}
                        </button>{' '}
                        <button className="mini" disabled={busy} onClick={() => void applyId('reset', String(feat.id))}>
                          {t('vivetool.reset')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {out && <pre className="cmd-out">{out}</pre>}

      <p className="count-note">{t('vivetool.adminNote')}</p>
    </>
  );
}
