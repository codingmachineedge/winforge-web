import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — in-app Store/UWP app uninstaller. Lists installed AppX packages for the
// current user (frameworks & resource packages excluded so shared runtimes can't be removed),
// filters them, and silently uninstalls a selected package via Remove-AppxPackage. A "deep"
// uninstall also clears the per-user leftover data folder (%LocalAppData%\Packages\<family>).
// The browser has no AppX / PackageManager, so live actions run only inside the WinForge desktop app.

interface AppRow {
  name: string;
  fullName: string;
  familyName: string;
  publisher: string;
  version: string;
  installLocation: string;
}

const listScript =
  `Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.IsBundle } | ` +
  `ForEach-Object { [pscustomobject]@{` +
  `name=[string]$_.Name; fullName=[string]$_.PackageFullName; familyName=[string]$_.PackageFamilyName; ` +
  `publisher=[string]$_.Publisher; version=[string]$_.Version; installLocation=[string]$_.InstallLocation } } | ` +
  `Sort-Object name`;

const esc = (s: string) => s.replace(/'/g, "''");

// Short name = last dotted segment of the package Name (e.g. Microsoft.XboxApp -> XboxApp).
function shortName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1) : name;
}

// Friendly publisher extracted from the AppX Publisher DN (CN=..., O=...).
function publisherLabel(pub: string): string {
  const m = pub.match(/(?:^|,\s*)(?:CN|O)=([^,]+)/i);
  return m && m[1] ? m[1].trim() : pub;
}

function uninstallScript(fullName: string): string {
  return `Remove-AppxPackage -Package '${esc(fullName)}' -ErrorAction Stop; 'Removed'`;
}

// Deep uninstall: remove the package, then delete the per-user leftover data folder.
function deepUninstallScript(fullName: string, familyName: string): string {
  return (
    `Remove-AppxPackage -Package '${esc(fullName)}' -ErrorAction Stop; ` +
    `$leftover = Join-Path $env:LOCALAPPDATA (Join-Path 'Packages' '${esc(familyName)}'); ` +
    `if ('${esc(familyName)}' -and (Test-Path $leftover)) { ` +
    `try { Remove-Item -LiteralPath $leftover -Recurse -Force -ErrorAction Stop; 'Removed + cleared leftover data' } ` +
    `catch { 'Removed (leftover data partly locked)' } } else { 'Removed' }`
  );
}

export function AppUninstallerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [apps, setApps] = useState<AppRow[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyFull, setBusyFull] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ app: AppRow; deep: boolean } | null>(null);

  const reload = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    setErr(null);
    try {
      const rows = await runPowershellJson<AppRow>(listScript);
      setApps(rows.filter((r) => r && r.name));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const f = filter.trim().toLowerCase();
  const shown = f
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(f) ||
          shortName(a.name).toLowerCase().includes(f) ||
          publisherLabel(a.publisher).toLowerCase().includes(f),
      )
    : apps;

  const doUninstall = async (app: AppRow, deep: boolean) => {
    setConfirm(null);
    if (!desktop) return;
    setBusyFull(app.fullName);
    setResult(null);
    setErr(null);
    try {
      const script = deep ? deepUninstallScript(app.fullName, app.familyName) : uninstallScript(app.fullName);
      const res = await runPowershell(script);
      if (res.success) {
        const detail = res.stdout.trim().split('\n')[0] ?? '';
        setResult({
          ok: true,
          text: t('uninst.removedOk', { name: shortName(app.name), detail }),
        });
        await reload();
      } else {
        const first = (res.stderr || res.stdout).trim().split('\n')[0] ?? '';
        setResult({
          ok: false,
          text: t('uninst.removeFail', { name: shortName(app.name), detail: first || t('uninst.maybeAdmin') }),
        });
      }
    } catch (e) {
      setResult({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusyFull('');
    }
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('uninst.desktopOnly')}</p>}
      <p className="count-note">{t('uninst.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('uninst.filterPlaceholder')}
        />
        <button className="mini" disabled={!desktop || loading} onClick={() => void reload()}>
          {loading ? t('uninst.loading') : t('uninst.refresh')}
        </button>
        <span className="count-note">{t('uninst.count', { shown: shown.length, total: apps.length })}</span>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}

      {result && (
        <p className={result.ok ? 'dep-ok' : 'dep-missing'} style={{ marginTop: 8 }}>
          {result.text}
        </p>
      )}

      {confirm && (
        <div className="panel" style={{ marginTop: 8 }}>
          <p className="label">{confirm.deep ? t('uninst.confirmDeepTitle') : t('uninst.confirmTitle')}</p>
          <p className="value" style={{ fontFamily: 'monospace' }}>
            {shortName(confirm.app.name)} — {confirm.app.name}
          </p>
          <p className="count-note">{confirm.deep ? t('uninst.confirmDeepBody') : t('uninst.confirmBody')}</p>
          <div className="mod-toolbar">
            <button
              className="mini primary"
              disabled={!!busyFull}
              onClick={() => void doUninstall(confirm.app, confirm.deep)}
            >
              {confirm.deep ? t('uninst.deepUninstall') : t('uninst.uninstall')}
            </button>
            <button className="mini" onClick={() => setConfirm(null)}>
              {t('uninst.cancel')}
            </button>
          </div>
        </div>
      )}

      {desktop && (
        <div className="panel" style={{ marginTop: 8 }}>
          {shown.length === 0 ? (
            <p className="count-note">
              {apps.length === 0 ? t('uninst.emptyNone') : t('uninst.emptyFilter')}
            </p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>{t('uninst.colApp')}</th>
                    <th>{t('uninst.colPackage')}</th>
                    <th>{t('uninst.colPublisher')}</th>
                    <th>{t('uninst.colVersion')}</th>
                    <th style={{ textAlign: 'right' }}>{t('uninst.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr key={a.fullName || a.name}>
                      <td>{shortName(a.name)}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{a.name}</td>
                      <td>{publisherLabel(a.publisher)}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{a.version}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="mini"
                          disabled={!!busyFull}
                          onClick={() => setConfirm({ app: a, deep: false })}
                        >
                          {busyFull === a.fullName ? t('uninst.working') : t('uninst.uninstall')}
                        </button>{' '}
                        <button
                          className="mini"
                          disabled={!!busyFull}
                          onClick={() => setConfirm({ app: a, deep: true })}
                        >
                          {t('uninst.deep')}
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

      <p className="count-note">{t('uninst.note')}</p>
    </div>
  );
}
