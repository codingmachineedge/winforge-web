import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, type CommandOutput } from '../tauri/bridge';

// Native module — a faithful web port of WinForge's Shortcut Guide (a PowerToys-style
// Win-key overlay). The original installs a low-level keyboard hook (WH_KEYBOARD_LL) to
// pop a topmost overlay when you hold Win; a global hook can't run in a web port, so the
// port preserves the module's other core: the full, searchable, bilingual reference of
// Windows shortcuts. Inside the desktop app it can additionally launch the real PowerToys
// Shortcut Guide overlay (if PowerToys is installed) and "try" a shortcut by sending the
// key combo via .NET SendKeys, so the guide is genuinely useful on the desktop too.

interface Shortcut { keys: string[]; descKey: string }
interface Group { titleKey: string; items: Shortcut[] }

// The catalogue mirrors ShortcutGuideService.BuildCatalogue() one-to-one. Descriptions
// live as i18n keys (scguide.d.<n>) so both languages come from the store.
const CATALOGUE: Group[] = [
  {
    titleKey: 'scguide.g.essentials',
    items: [
      { keys: ['Win'], descKey: 'scguide.d.start' },
      { keys: ['Win', 'E'], descKey: 'scguide.d.explorer' },
      { keys: ['Win', 'D'], descKey: 'scguide.d.desktop' },
      { keys: ['Win', 'L'], descKey: 'scguide.d.lock' },
      { keys: ['Win', 'I'], descKey: 'scguide.d.settings' },
      { keys: ['Win', 'A'], descKey: 'scguide.d.quicksettings' },
      { keys: ['Win', 'N'], descKey: 'scguide.d.notifications' },
      { keys: ['Win', 'R'], descKey: 'scguide.d.run' },
      { keys: ['Win', 'X'], descKey: 'scguide.d.quicklink' },
      { keys: ['Win', 'Pause'], descKey: 'scguide.d.about' },
    ],
  },
  {
    titleKey: 'scguide.g.snap',
    items: [
      { keys: ['Win', '←'], descKey: 'scguide.d.snapleft' },
      { keys: ['Win', '→'], descKey: 'scguide.d.snapright' },
      { keys: ['Win', '↑'], descKey: 'scguide.d.maximise' },
      { keys: ['Win', '↓'], descKey: 'scguide.d.minimise' },
      { keys: ['Win', 'Z'], descKey: 'scguide.d.snaplayouts' },
      { keys: ['Win', 'Home'], descKey: 'scguide.d.minallbut' },
      { keys: ['Win', 'Shift', '↑'], descKey: 'scguide.d.stretch' },
      { keys: ['Win', 'Shift', '←'], descKey: 'scguide.d.moveleft' },
      { keys: ['Win', 'Shift', '→'], descKey: 'scguide.d.moveright' },
      { keys: ['Win', ','], descKey: 'scguide.d.peek' },
    ],
  },
  {
    titleKey: 'scguide.g.desktops',
    items: [
      { keys: ['Win', 'Tab'], descKey: 'scguide.d.taskview' },
      { keys: ['Win', 'Ctrl', 'D'], descKey: 'scguide.d.newdesktop' },
      { keys: ['Win', 'Ctrl', '←'], descKey: 'scguide.d.desktopleft' },
      { keys: ['Win', 'Ctrl', '→'], descKey: 'scguide.d.desktopright' },
      { keys: ['Win', 'Ctrl', 'F4'], descKey: 'scguide.d.closedesktop' },
      { keys: ['Alt', 'Tab'], descKey: 'scguide.d.switchapps' },
      { keys: ['Ctrl', 'Shift', 'Esc'], descKey: 'scguide.d.taskmgr' },
    ],
  },
  {
    titleKey: 'scguide.g.apps',
    items: [
      { keys: ['Win', 'S'], descKey: 'scguide.d.search' },
      { keys: ['Win', 'Q'], descKey: 'scguide.d.search' },
      { keys: ['Win', '1–9'], descKey: 'scguide.d.taskbarnum' },
      { keys: ['Win', 'T'], descKey: 'scguide.d.cycletaskbar' },
      { keys: ['Win', 'B'], descKey: 'scguide.d.tray' },
      { keys: ['Win', 'C'], descKey: 'scguide.d.copilot' },
      { keys: ['Win', 'W'], descKey: 'scguide.d.widgets' },
      { keys: ['Win', 'K'], descKey: 'scguide.d.cast' },
    ],
  },
  {
    titleKey: 'scguide.g.capture',
    items: [
      { keys: ['Win', 'Shift', 'S'], descKey: 'scguide.d.snip' },
      { keys: ['Win', 'PrtScn'], descKey: 'scguide.d.screenshot' },
      { keys: ['Win', 'V'], descKey: 'scguide.d.clipboard' },
      { keys: ['Win', '.'], descKey: 'scguide.d.emoji' },
      { keys: ['Win', ';'], descKey: 'scguide.d.emoji' },
      { keys: ['Win', 'H'], descKey: 'scguide.d.voice' },
      { keys: ['Win', 'G'], descKey: 'scguide.d.gamebar' },
      { keys: ['Win', 'Alt', 'R'], descKey: 'scguide.d.record' },
      { keys: ['Win', 'P'], descKey: 'scguide.d.project' },
    ],
  },
  {
    titleKey: 'scguide.g.accessibility',
    items: [
      { keys: ['Win', '+'], descKey: 'scguide.d.magnifier' },
      { keys: ['Win', '-'], descKey: 'scguide.d.zoomout' },
      { keys: ['Win', 'Esc'], descKey: 'scguide.d.closemag' },
      { keys: ['Win', 'Ctrl', 'Enter'], descKey: 'scguide.d.narrator' },
      { keys: ['Win', 'U'], descKey: 'scguide.d.accsettings' },
      { keys: ['Win', 'Ctrl', 'C'], descKey: 'scguide.d.colourfilters' },
      { keys: ['Win', 'Ctrl', 'O'], descKey: 'scguide.d.osk' },
      { keys: ['Win', 'Ctrl', 'S'], descKey: 'scguide.d.speech' },
    ],
  },
  {
    titleKey: 'scguide.g.text',
    items: [
      { keys: ['Ctrl', 'C'], descKey: 'scguide.d.copy' },
      { keys: ['Ctrl', 'X'], descKey: 'scguide.d.cut' },
      { keys: ['Ctrl', 'V'], descKey: 'scguide.d.paste' },
      { keys: ['Ctrl', 'Z'], descKey: 'scguide.d.undo' },
      { keys: ['Ctrl', 'Y'], descKey: 'scguide.d.redo' },
      { keys: ['Ctrl', 'A'], descKey: 'scguide.d.selectall' },
      { keys: ['Ctrl', 'F'], descKey: 'scguide.d.find' },
      { keys: ['Ctrl', 'S'], descKey: 'scguide.d.save' },
      { keys: ['Ctrl', 'P'], descKey: 'scguide.d.print' },
      { keys: ['Ctrl', '←'], descKey: 'scguide.d.prevword' },
      { keys: ['Ctrl', '→'], descKey: 'scguide.d.nextword' },
      { keys: ['F2'], descKey: 'scguide.d.rename' },
    ],
  },
  {
    titleKey: 'scguide.g.explorer',
    items: [
      { keys: ['Ctrl', 'N'], descKey: 'scguide.d.newwindow' },
      { keys: ['Ctrl', 'W'], descKey: 'scguide.d.closewindow' },
      { keys: ['Ctrl', 'Shift', 'N'], descKey: 'scguide.d.newfolder' },
      { keys: ['Alt', '↑'], descKey: 'scguide.d.upfolder' },
      { keys: ['Alt', '←'], descKey: 'scguide.d.back' },
      { keys: ['Alt', '→'], descKey: 'scguide.d.forward' },
      { keys: ['Alt', 'Enter'], descKey: 'scguide.d.properties' },
      { keys: ['F5'], descKey: 'scguide.d.refresh' },
      { keys: ['Ctrl', 'Shift', 'E'], descKey: 'scguide.d.expandtree' },
    ],
  },
  {
    titleKey: 'scguide.g.window',
    items: [
      { keys: ['Alt', 'F4'], descKey: 'scguide.d.closeactive' },
      { keys: ['Alt', 'Space'], descKey: 'scguide.d.sysmenu' },
      { keys: ['Alt', 'Esc'], descKey: 'scguide.d.cyclewindows' },
      { keys: ['Ctrl', 'Alt', 'Tab'], descKey: 'scguide.d.viewapps' },
      { keys: ['Win', 'M'], descKey: 'scguide.d.minall' },
      { keys: ['Win', 'Shift', 'M'], descKey: 'scguide.d.restoreall' },
      { keys: ['Ctrl', 'Shift', 'Esc'], descKey: 'scguide.d.taskmgr' },
    ],
  },
];

// Combos we can safely replay with SendKeys — pure Ctrl/Alt/Shift chords that don't
// depend on the Windows key (SendKeys has no reliable Win-key modifier). Maps the
// catalogue's display keys to a SendKeys string.
const SENDKEYS: Record<string, string> = {
  'Ctrl+C': '^c',
  'Ctrl+X': '^x',
  'Ctrl+V': '^v',
  'Ctrl+Z': '^z',
  'Ctrl+Y': '^y',
  'Ctrl+A': '^a',
  'Ctrl+F': '^f',
  'Ctrl+S': '^s',
  'Ctrl+P': '^p',
  'Ctrl+N': '^n',
  'Ctrl+W': '^w',
  'F2': '{F2}',
  'F5': '{F5}',
  'Alt+F4': '%{F4}',
  'Ctrl+Shift+Esc': '^+{ESC}',
  'Alt+Tab': '%{TAB}',
};

const comboOf = (keys: string[]) => keys.join('+');

export function ShortcutGuideModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filter the catalogue by a case-insensitive haystack of combo + both descriptions.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATALOGUE;
    const out: Group[] = [];
    for (const g of CATALOGUE) {
      const items = g.items.filter((s) => {
        const combo = comboOf(s.keys).toLowerCase();
        const desc = String(t(s.descKey)).toLowerCase();
        return combo.includes(q) || desc.includes(q);
      });
      if (items.length > 0) out.push({ titleKey: g.titleKey, items });
    }
    return out;
  }, [query, t]);

  const shownCount = useMemo(
    () => filtered.reduce((n, g) => n + g.items.length, 0),
    [filtered],
  );
  const totalCount = useMemo(
    () => CATALOGUE.reduce((n, g) => n + g.items.length, 0),
    [],
  );

  const report = (out: CommandOutput, okMsg: string) => {
    if (out.success) {
      setStatus(okMsg);
      setStatusOk(true);
      setErr(null);
    } else {
      setStatus(null);
      setErr(out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`);
    }
  };

  // Launch the real PowerToys Shortcut Guide overlay if PowerToys is installed. Falls
  // back to a clear message when it isn't found.
  const launchPowerToys = async () => {
    if (!desktop || busy) return;
    setBusy(true); setErr(null); setStatus(null);
    try {
      const script =
        "$c=@(\"$env:ProgramFiles\\PowerToys\\PowerToys.exe\"," +
        "\"$env:LOCALAPPDATA\\PowerToys\\PowerToys.exe\"," +
        "\"$env:ProgramFiles\\PowerToys\\WinUI3Apps\\PowerToys.ShortcutGuide.exe\"," +
        "\"$env:LOCALAPPDATA\\Microsoft\\WindowsApps\\PowerToys.exe\") | " +
        "Where-Object { Test-Path $_ } | Select-Object -First 1; " +
        "if($c){ Start-Process -FilePath $c; 'launched: ' + $c } else { throw 'PowerToys not found' }";
      const out = await runPowershell(script);
      report(out, t('scguide.ptLaunched'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  // "Try it" — replay a Ctrl/Alt/Shift chord into the foreground window after a short
  // delay so the user can click where they want it to land.
  const tryShortcut = async (keys: string[]) => {
    if (!desktop || busy) return;
    const send = SENDKEYS[comboOf(keys)];
    if (!send) return;
    setBusy(true); setErr(null); setStatus(null);
    try {
      const literal = send.replace(/'/g, "''");
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "Start-Sleep -Milliseconds 1200; " +
        `[System.Windows.Forms.SendKeys]::SendWait('${literal}'); 'sent'`;
      const out = await runPowershell(script);
      report(out, t('scguide.trySent', { combo: comboOf(keys) }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('scguide.desktopOnly')}</p>}

      <p className="count-note">{t('scguide.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ minWidth: 240, flex: '1 1 240px' }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('scguide.searchPlaceholder')}
        />
        <button
          className="mini primary"
          disabled={!desktop || busy}
          onClick={launchPowerToys}
          title={t('scguide.ptHint')}
        >
          {t('scguide.launchPt')}
        </button>
      </div>

      <p className="count-note">
        {query.trim()
          ? t('scguide.shownFiltered', { shown: shownCount, total: totalCount })
          : t('scguide.shownAll', { total: totalCount })}
      </p>

      {status && <p className={statusOk ? 'dep-ok' : 'count-note'}>{status}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}

      {filtered.length === 0 && (
        <p className="count-note">{t('scguide.noResults', { query: query.trim() })}</p>
      )}

      {filtered.map((g) => (
        <div key={g.titleKey} className="panel" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 6, fontWeight: 600 }}>{t(g.titleKey)}</div>
          <div className="kv-list">
            {g.items.map((s, i) => {
              const combo = comboOf(s.keys);
              const canTry = desktop && !!SENDKEYS[combo];
              return (
                <div className="kv-row" key={`${g.titleKey}-${combo}-${i}`}>
                  <div className="label" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {s.keys.map((k, ki) => (
                      <span key={ki} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {ki > 0 && <span style={{ opacity: 0.5 }}>+</span>}
                        <kbd
                          style={{
                            border: '1px solid var(--border, #4444)',
                            borderRadius: 5,
                            padding: '2px 7px',
                            fontSize: 12,
                            fontWeight: 600,
                            minWidth: 20,
                            textAlign: 'center',
                          }}
                        >
                          {k}
                        </kbd>
                      </span>
                    ))}
                  </div>
                  <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1 }}>{t(s.descKey)}</span>
                    {canTry && (
                      <button
                        className="mini"
                        disabled={busy}
                        onClick={() => tryShortcut(s.keys)}
                        title={t('scguide.tryHint')}
                      >
                        {t('scguide.try')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="count-note">{t('scguide.hookNote')}</p>
    </div>
  );
}
