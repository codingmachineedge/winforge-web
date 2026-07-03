import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives wt.exe (Windows Terminal). Quick-launch its common verbs
// (open window / new tab / split pane / open here / PowerShell tab / cmd tab / settings UI)
// and read the user's Windows Terminal profiles from settings.json to launch a chosen one.
// wt.exe is an external tool → gated by DependencyGate; profile reading needs the desktop
// backend (PowerShell), so it is gated on isTauri().

interface WtProfile {
  guid: string;
  name: string;
  commandline: string;
  hidden: boolean;
  source: string;
  isDefault: boolean;
}

// Quick-launch actions, mirroring Catalog/TerminalOperations.cs. `args` is the wt.exe
// argument string (split on spaces below, keeping quoted segments intact).
interface LaunchOp {
  key: string;
  args: string;
}

const OPS: LaunchOp[] = [
  { key: 'launch', args: '' },
  { key: 'newTab', args: 'nt' },
  { key: 'splitPane', args: 'sp' },
  { key: 'here', args: '-d %USERPROFILE%' },
  { key: 'pwsh', args: 'nt -p "Windows PowerShell"' },
  { key: 'cmd', args: 'nt -p "Command Prompt"' },
];

// Split a wt argument string into argv, honouring double-quoted segments so
// -p "Windows PowerShell" stays one argument.
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const quoted = m[1];
    const bare = m[2];
    if (quoted !== undefined) out.push(quoted);
    else if (bare !== undefined) out.push(bare);
  }
  return out;
}

// PowerShell that locates the first existing Windows Terminal settings.json across the
// known candidate paths, parses it, and emits one row per profile with the default flag.
const PROFILES_SCRIPT = String.raw`
$local = [Environment]::GetFolderPath('LocalApplicationData')
$candidates = @(
  (Join-Path $local 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Microsoft\Windows Terminal\settings.json')
)
$path = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $path) { return }
$raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
$json = $raw | ConvertFrom-Json -ErrorAction Stop
$def = [string]$json.defaultProfile
$list = @()
if ($json.profiles -and $json.profiles.list) { $list = $json.profiles.list }
elseif ($json.profiles -is [array]) { $list = $json.profiles }
foreach ($p in $list) {
  [pscustomobject]@{
    guid        = [string]$p.guid
    name        = [string]$p.name
    commandline = [string]$p.commandline
    hidden      = [bool]$p.hidden
    source      = [string]$p.source
    isDefault   = ($p.guid -eq $def -and $def -ne '')
  }
}
`;

export function TerminalModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const [profiles, setProfiles] = useState<WtProfile[] | null>(null);
  const [profErr, setProfErr] = useState<string | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(false);

  // Run wt.exe with a parsed argument string. Windows Terminal returns immediately
  // (it hands off to the running instance), so this is effectively a detached launch.
  const runOp = async (wtPath: string, op: LaunchOp) => {
    setBusy(op.key);
    setErr(null);
    const argv = splitArgs(op.args);
    setOut(`> wt ${op.args}`.trim());
    try {
      const res: CommandOutput = await runCommand(wtPath, argv);
      const text = res.stdout || res.stderr;
      if (text.trim()) setOut(text);
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Open Windows Terminal's own settings UI (equivalent to Ctrl+, inside WT).
  const openSettingsUi = async (wtPath: string) => {
    setBusy('settings');
    setErr(null);
    setOut('> wt (settings)');
    try {
      const res = await runCommand(wtPath, ['-w', '0']);
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const loadProfiles = async () => {
    if (!desktop) return;
    setLoadingProfiles(true);
    setProfErr(null);
    try {
      const rows = await runPowershellJson<WtProfile>(PROFILES_SCRIPT);
      setProfiles(rows);
    } catch (e) {
      setProfErr(String(e instanceof Error ? e.message : e));
      setProfiles(null);
    } finally {
      setLoadingProfiles(false);
    }
  };

  // Launch a specific profile in a new tab (wt nt -p "<name>").
  const launchProfile = async (wtPath: string, name: string) => {
    if (!name.trim()) return;
    setBusy(`prof:${name}`);
    setErr(null);
    setOut(`> wt nt -p "${name}"`);
    try {
      const res = await runCommand(wtPath, ['nt', '-p', name]);
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('wterminal.blurb')}
      </p>

      <DependencyGate tool="wt" preferId="Microsoft.WindowsTerminal" query="windows terminal">
        {(path) => (
          <>
            <div className="panel">
              <div className="dt-wrap">
                <p className="count-note" style={{ marginTop: 0 }}>
                  {t('wterminal.quickLaunch')}
                </p>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  {OPS.map((op) => (
                    <button
                      key={op.key}
                      className="mini"
                      disabled={!!busy}
                      onClick={() => runOp(path, op)}
                      title={t(`wterminal.op.${op.key}.desc`)}
                    >
                      {busy === op.key ? t('wterminal.running') : t(`wterminal.op.${op.key}.label`)}
                    </button>
                  ))}
                  <button
                    className="mini"
                    disabled={!!busy}
                    onClick={() => openSettingsUi(path)}
                    title={t('wterminal.op.settings.desc')}
                  >
                    {busy === 'settings' ? t('wterminal.running') : t('wterminal.op.settings.label')}
                  </button>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <span className="label">{t('wterminal.profiles')}</span>
                <button
                  className="mini primary"
                  disabled={!desktop || loadingProfiles}
                  onClick={loadProfiles}
                >
                  {loadingProfiles ? t('wterminal.loading') : t('wterminal.loadProfiles')}
                </button>
              </div>
              {!desktop && (
                <p className="count-note" style={{ color: 'var(--danger)' }}>
                  {t('wterminal.desktopOnly')}
                </p>
              )}
              {profErr && <pre className="cmd-out error">{profErr}</pre>}
              {profiles && profiles.length === 0 && (
                <p className="count-note">{t('wterminal.noProfiles')}</p>
              )}
              {profiles && profiles.length > 0 && (
                <div className="dt-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>{t('wterminal.colName')}</th>
                        <th>{t('wterminal.colCommand')}</th>
                        <th>{t('wterminal.colFlags')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.map((p) => {
                        const flags: string[] = [];
                        if (p.isDefault) flags.push(t('wterminal.flagDefault'));
                        if (p.hidden) flags.push(t('wterminal.flagHidden'));
                        if (p.source) flags.push(t('wterminal.flagGenerated'));
                        return (
                          <tr key={p.guid || p.name}>
                            <td>{p.name || t('wterminal.unnamed')}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                              {p.commandline || '—'}
                            </td>
                            <td className="count-note">{flags.join(' · ') || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="mini"
                                disabled={!!busy || !p.name}
                                onClick={() => launchProfile(path, p.name)}
                              >
                                {busy === `prof:${p.name}`
                                  ? t('wterminal.running')
                                  : t('wterminal.launch')}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="count-note" style={{ marginTop: 8 }}>
                    {t('wterminal.profilesNote', { count: profiles.length })}
                  </p>
                </div>
              )}
            </div>

            {err && <pre className="cmd-out error">{err}</pre>}
            {out && !err && <pre className="cmd-out">{out}</pre>}
            <p className="count-note">{t('wterminal.footNote')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
