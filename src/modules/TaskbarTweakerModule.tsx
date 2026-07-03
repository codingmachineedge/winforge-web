import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson, type CommandOutput } from '../tauri/bridge';

// Native module — 7+ Taskbar Tweaker · 工作列調校.
// WinForge's native subset drives real Windows 11 taskbar/Start tweaks through registry
// DWords (HKCU\...\Explorer\Advanced etc.) applied via `reg.exe`, plus ms-settings:taskbar,
// plus a "restart explorer" helper. The DEEP runtime behaviours (middle-click close,
// double-click show desktop, scroll-to-switch, drag-reorder) require a DLL injected into
// explorer.exe and cannot be done in managed code — so, exactly like the C# module, we only
// DETECT and LAUNCH the already-installed 7+ Taskbar Tweaker and Windhawk. We never bundle,
// download or auto-install 7+TT (closed-source freeware, no winget id).
// All live registry/launch actions run only inside the WinForge desktop app (isTauri()).

type Root = 'HKCU' | 'HKLM';

interface RadioTweak {
  id: string;
  kind: 'radio';
  root: Root;
  path: string; // reg.exe path fragment after the root
  name: string;
  options: { value: number; en: string; zh: string }[];
}
interface ToggleTweak {
  id: string;
  kind: 'toggle';
  root: Root;
  path: string;
  name: string;
  onValue: number;
  offValue: number;
}
type Tweak = RadioTweak | ToggleTweak;

const ADV = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const SEARCH = 'Software\\Microsoft\\Windows\\CurrentVersion\\Search';
const EXPLORER = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer';
const TBDEV = 'Software\\Microsoft\\Windows\\CurrentVersion\\TaskbarDeveloperSettings';

// Registry-backed tweaks, faithful to WinForge's TaskbarTweaks.All().
const TWEAKS: Tweak[] = [
  {
    id: 'align', kind: 'radio', root: 'HKCU', path: ADV, name: 'TaskbarAl',
    options: [{ value: 0, en: 'Left', zh: '靠左' }, { value: 1, en: 'Center', zh: '置中' }],
  },
  {
    id: 'search-mode', kind: 'radio', root: 'HKCU', path: SEARCH, name: 'SearchboxTaskbarMode',
    options: [
      { value: 0, en: 'Hidden', zh: '隱藏' },
      { value: 1, en: 'Icon only', zh: '只顯示圖示' },
      { value: 2, en: 'Search box', zh: '搜尋框' },
      { value: 3, en: 'Icon and label', zh: '圖示同標籤' },
    ],
  },
  {
    id: 'combine', kind: 'radio', root: 'HKCU', path: ADV, name: 'TaskbarGlomLevel',
    options: [
      { value: 0, en: 'Always combine', zh: '永遠合併' },
      { value: 1, en: 'When taskbar is full', zh: '工作列滿先合併' },
      { value: 2, en: 'Never', zh: '永不合併' },
    ],
  },
  { id: 'task-view', kind: 'toggle', root: 'HKCU', path: ADV, name: 'ShowTaskViewButton', onValue: 1, offValue: 0 },
  { id: 'widgets', kind: 'toggle', root: 'HKCU', path: ADV, name: 'TaskbarDa', onValue: 1, offValue: 0 },
  { id: 'chat', kind: 'toggle', root: 'HKCU', path: ADV, name: 'TaskbarMn', onValue: 1, offValue: 0 },
  { id: 'end-task', kind: 'toggle', root: 'HKCU', path: TBDEV, name: 'TaskbarEndTask', onValue: 1, offValue: 0 },
  { id: 'start-most-used', kind: 'toggle', root: 'HKCU', path: ADV, name: 'Start_TrackProgs', onValue: 1, offValue: 0 },
  { id: 'start-recently-added', kind: 'toggle', root: 'HKCU', path: ADV, name: 'Start_TrackDocs', onValue: 1, offValue: 0 },
  { id: 'start-recommendations', kind: 'toggle', root: 'HKCU', path: ADV, name: 'Start_IrisRecommendations', onValue: 1, offValue: 0 },
  { id: 'show-seconds-clock', kind: 'toggle', root: 'HKCU', path: ADV, name: 'ShowSecondsInSystemClock', onValue: 1, offValue: 0 },
  // "Show all tray icons": EnableAutoTray is inverted (0 = show all, 1 = hide overflow).
  { id: 'show-all-tray-icons', kind: 'toggle', root: 'HKCU', path: EXPLORER, name: 'EnableAutoTray', onValue: 0, offValue: 1 },
  { id: 'multi-monitor-all', kind: 'toggle', root: 'HKCU', path: ADV, name: 'MMTaskbarEnabled', onValue: 1, offValue: 0 },
];

// Every tweak requires an Explorer restart to take effect (matches RestartScope.Explorer).
const esc = (s: string) => s.replace(/'/g, "''");
const regKey = (root: Root, path: string) => `${root}:\\${path}`;

// Read one DWord; returns the number or null if unset/unreadable. Never throws upstream.
async function readDword(root: Root, path: string, name: string): Promise<number | null> {
  const script =
    `try { $v = (Get-ItemProperty -Path '${esc(regKey(root, path))}' -Name '${esc(name)}' -ErrorAction Stop).'${esc(name)}'; ` +
    `[pscustomobject]@{ value = [int]$v } } catch { [pscustomobject]@{ value = $null } }`;
  const rows = await runPowershellJson<{ value: number | null }>(script);
  const row = rows[0];
  if (!row || row.value === null || row.value === undefined) return null;
  return Number(row.value);
}

// Write one DWord.
async function writeDword(root: Root, path: string, name: string, value: number): Promise<CommandOutput> {
  const script =
    `New-Item -Path '${esc(regKey(root, path))}' -Force | Out-Null; ` +
    `New-ItemProperty -Path '${esc(regKey(root, path))}' -Name '${esc(name)}' -Value ${Math.trunc(value)} -PropertyType DWord -Force | Out-Null`;
  return runPowershell(script);
}

interface Detection { installed: boolean; path: string | null; version: string | null }

// Detect a tool via uninstall registry keys (HKLM/HKCU, 64/32-bit) — mirrors ProbeUninstall.
async function detectTool(displayNameContains: string): Promise<Detection> {
  const needle = esc(displayNameContains);
  const script =
    `$roots = @(` +
    `'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',` +
    `'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',` +
    `'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); ` +
    `foreach ($r in $roots) { ` +
    `Get-ChildItem -Path $r -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue; ` +
    `if ($p -and $p.DisplayName -and $p.DisplayName -like '*${needle}*') { ` +
    `$exe = $null; ` +
    `if ($p.DisplayIcon) { $c = ($p.DisplayIcon -split ',')[0].Trim('\"',' '); if ($c -like '*.exe' -and (Test-Path $c)) { $exe = $c } } ` +
    `if (-not $exe -and $p.InstallLocation -and (Test-Path $p.InstallLocation)) { ` +
    `$f = Get-ChildItem -Path $p.InstallLocation -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $exe = $f.FullName } } ` +
    `[pscustomobject]@{ path = $exe; version = [string]$p.DisplayVersion } } } }`;
  try {
    const rows = await runPowershellJson<{ path: string | null; version: string | null }>(script);
    const hit = rows.find((r) => r && r.path);
    if (hit && hit.path) return { installed: true, path: hit.path, version: hit.version || null };
    if (rows.length > 0) {
      const first = rows[0];
      return { installed: true, path: null, version: (first && first.version) || null };
    }
  } catch {
    /* fall through to not-installed */
  }
  return { installed: false, path: null, version: null };
}

async function launchPath(path: string): Promise<CommandOutput> {
  // Launch detached via Start-Process; UseShellExecute-equivalent.
  return runPowershell(`Start-Process -FilePath '${esc(path)}'`);
}

export function TaskbarTweakerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [filter, setFilter] = useState('');
  const [current, setCurrent] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string>('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sevenTt, setSevenTt] = useState<Detection | null>(null);
  const [windhawk, setWindhawk] = useState<Detection | null>(null);
  const [detecting, setDetecting] = useState(false);

  const pick = (en: string, zh: string) => (t('tbtweak.lang') === 'zh' ? zh : en);

  const loadCurrent = async (tw: Tweak) => {
    if (!desktop) return;
    try {
      const v = await readDword(tw.root, tw.path, tw.name);
      setCurrent((c) => ({ ...c, [tw.id]: v }));
    } catch {
      setCurrent((c) => ({ ...c, [tw.id]: null }));
    }
  };

  const loadAll = async () => {
    for (const tw of TWEAKS) await loadCurrent(tw);
  };

  const applyValue = async (tw: Tweak, value: number) => {
    if (!desktop) return;
    setBusy(tw.id);
    setStatus(null);
    try {
      const res = await writeDword(tw.root, tw.path, tw.name, value);
      if (res.success) {
        setCurrent((c) => ({ ...c, [tw.id]: value }));
        setStatus({ kind: 'ok', text: t('tbtweak.appliedRestart') });
      } else {
        setStatus({ kind: 'err', text: res.stderr.trim() || t('tbtweak.failed') });
      }
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  const runDetection = async () => {
    if (!desktop) return;
    setDetecting(true);
    try {
      const [a, b] = await Promise.all([
        detectTool('7+ Taskbar Tweaker').catch(() => ({ installed: false, path: null, version: null }) as Detection),
        detectTool('Windhawk').catch(() => ({ installed: false, path: null, version: null }) as Detection),
      ]);
      setSevenTt(a);
      setWindhawk(b);
    } finally {
      setDetecting(false);
    }
  };

  const doLaunch = async (path: string | null) => {
    if (!desktop || !path) return;
    setStatus(null);
    try {
      const res = await launchPath(path);
      if (!res.success) setStatus({ kind: 'err', text: res.stderr.trim() || t('tbtweak.launchFailed') });
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    }
  };

  const openSettings = async () => {
    if (!desktop) return;
    setStatus(null);
    try {
      await runPowershell('Start-Process ms-settings:taskbar');
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    }
  };

  const restartExplorer = async () => {
    if (!desktop) return;
    setBusy('restart');
    setStatus(null);
    try {
      await runPowershell('Stop-Process -Name explorer -Force; Start-Sleep -Milliseconds 400; Start-Process explorer');
      setStatus({ kind: 'ok', text: t('tbtweak.explorerRestarted') });
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  const f = filter.trim().toLowerCase();
  const shown = TWEAKS.filter((tw) => {
    if (!f) return true;
    const label = (t(`tbtweak.${tw.id}.title`) + ' ' + t(`tbtweak.${tw.id}.desc`) + ' ' + tw.id).toLowerCase();
    return label.includes(f);
  });

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('tbtweak.desktopOnly')}</p>}

      <p className="count-note">{t('tbtweak.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 260 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('tbtweak.filterPlaceholder')}
        />
        <button className="mini primary" disabled={!desktop || !!busy} onClick={loadAll}>{t('tbtweak.readAll')}</button>
        <button className="mini" disabled={!desktop || busy === 'restart'} onClick={restartExplorer}>
          {busy === 'restart' ? t('tbtweak.restarting') : t('tbtweak.restartExplorer')}
        </button>
        <button className="mini" disabled={!desktop} onClick={openSettings}>{t('tbtweak.openSettings')}</button>
      </div>

      {status && <pre className={`cmd-out ${status.kind === 'err' ? 'error' : ''}`}>{status.text}</pre>}

      <div className="panel">
        <div className="kv-list">
          {shown.length === 0 && <p className="count-note">{t('tbtweak.noMatch')}</p>}
          {shown.map((tw) => {
            const cur = current[tw.id];
            const curKnown = cur !== undefined;
            return (
              <div className="kv-row" key={tw.id} style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="label" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{t(`tbtweak.${tw.id}.title`)}</div>
                  <div className="count-note" style={{ marginTop: 2 }}>{t(`tbtweak.${tw.id}.desc`)}</div>
                  <div className="count-note" style={{ marginTop: 2, opacity: 0.7 }}>{t('tbtweak.restartHint')}</div>
                </div>
                <div className="value" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  {tw.kind === 'toggle' ? (
                    <ToggleControl
                      tw={tw}
                      cur={cur ?? null}
                      disabled={!desktop || busy === tw.id}
                      onApply={(v) => applyValue(tw, v)}
                      onLabel={t('tbtweak.on')}
                      offLabel={t('tbtweak.off')}
                    />
                  ) : (
                    <select
                      className="mod-select"
                      disabled={!desktop || busy === tw.id}
                      value={cur !== undefined && cur !== null ? String(cur) : ''}
                      onChange={(e) => e.target.value !== '' && applyValue(tw, Number(e.target.value))}
                    >
                      <option value="" disabled>{t('tbtweak.choose')}</option>
                      {tw.options.map((o) => (
                        <option key={o.value} value={o.value}>{pick(o.en, o.zh)}</option>
                      ))}
                    </select>
                  )}
                  <span className="count-note" style={{ fontSize: 11 }}>
                    {!curKnown ? t('tbtweak.unread') : cur === null ? t('tbtweak.notSet') : describeCurrent(tw, cur, pick)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deep behaviours explainer + real-tool detection/launch */}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="dt-wrap">
          <div style={{ fontWeight: 600 }}>{t('tbtweak.deepTitle')}</div>
          <p className="count-note" style={{ marginTop: 4 }}>{t('tbtweak.deepBody')}</p>
        </div>

        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" disabled={!desktop || detecting} onClick={runDetection}>
            {detecting ? t('tbtweak.detecting') : t('tbtweak.detect')}
          </button>
        </div>

        {sevenTt && (
          <div className="kv-row" style={{ marginTop: 8 }}>
            <span className="label">7+ Taskbar Tweaker</span>
            <span className="value">
              {sevenTt.installed ? (
                <>
                  <span className="dep-ok">
                    ✓ {t('tbtweak.installed')}{sevenTt.version ? ` (v${sevenTt.version})` : ''}
                  </span>
                  {sevenTt.path && (
                    <button className="mini" style={{ marginLeft: 8 }} disabled={!desktop} onClick={() => doLaunch(sevenTt.path)}>
                      {t('tbtweak.launch7tt')}
                    </button>
                  )}
                </>
              ) : (
                <span className="dep-missing">⚠ {t('tbtweak.notDetected7tt')}</span>
              )}
            </span>
          </div>
        )}

        {windhawk && (
          <div className="kv-row">
            <span className="label">Windhawk</span>
            <span className="value">
              {windhawk.installed ? (
                <>
                  <span className="dep-ok">
                    ✓ {t('tbtweak.installed')}{windhawk.version ? ` (v${windhawk.version})` : ''}
                  </span>
                  {windhawk.path && (
                    <button className="mini" style={{ marginLeft: 8 }} disabled={!desktop} onClick={() => doLaunch(windhawk.path)}>
                      {t('tbtweak.launchWindhawk')}
                    </button>
                  )}
                </>
              ) : (
                <span className="dep-missing">⚠ {t('tbtweak.notDetectedWindhawk')}</span>
              )}
            </span>
          </div>
        )}

        {(sevenTt || windhawk) && (sevenTt?.installed === false || windhawk?.installed === false) && (
          <p className="count-note" style={{ marginTop: 4 }}>{t('tbtweak.installNote')}</p>
        )}
      </div>

      <p className="count-note">{t('tbtweak.note')}</p>
    </div>
  );
}

function describeCurrent(tw: Tweak, cur: number, pick: (en: string, zh: string) => string): string {
  if (tw.kind === 'toggle') {
    return cur === tw.onValue ? pick('On', '開') : pick('Off', '熄');
  }
  const opt = tw.options.find((o) => o.value === cur);
  return opt ? pick(opt.en, opt.zh) : String(cur);
}

interface ToggleControlProps {
  tw: ToggleTweak;
  cur: number | null;
  disabled: boolean;
  onApply: (value: number) => void;
  onLabel: string;
  offLabel: string;
}

function ToggleControl({ tw, cur, disabled, onApply, onLabel, offLabel }: ToggleControlProps) {
  const isOn = cur !== null && cur === tw.onValue;
  return (
    <label className="chk" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        type="checkbox"
        disabled={disabled}
        checked={isOn}
        onChange={(e) => onApply(e.target.checked ? tw.onValue : tw.offValue)}
      />
      <span>{isOn ? onLabel : offLabel}</span>
    </label>
  );
}
