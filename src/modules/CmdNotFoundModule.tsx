import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand } from '../tauri/bridge';
import { StatusDot, useAsync } from './common';

/** Marker GUID for the WinForge / PowerToys Command Not Found hook block (kept compatible). */
const MARKER_GUID = 'f45873b3-b655-43a6-b217-97c00aa0db58';
/** Legacy GUID cleaned up on enable/disable. */
const LEGACY_GUID = '34de4b3d-13a8-4540-b76d-b9e8d3851756';
const CNF_MODULE = 'Microsoft.WinGet.CommandNotFound';
const DOCS_URL = 'https://learn.microsoft.com/windows/package-manager/winget/';

interface CnfStatus {
  PwshPresent: boolean;
  PwshVersion: string;
  PwshOk: boolean;
  ClientPresent: boolean;
  ClientUpToDate: boolean;
  CnfPresent: boolean;
  FeedbackEnabled: boolean;
  SuggestionEnabled: boolean;
  ProfilePath: string;
  HookEnabled: boolean;
  LegacyHookPresent: boolean;
  ProfileText: string;
}

type Severity = 'info' | 'success' | 'warn' | 'error';
interface Banner {
  severity: Severity;
  message: string;
  detail?: string;
}

/** Base64-UTF16LE encode a script for `pwsh -EncodedCommand` (avoids quoting hell). */
function encodePwsh(script: string): string {
  const buf: number[] = [];
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    buf.push(c & 0xff, (c >> 8) & 0xff);
  }
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Run a script through the resolved pwsh (PowerShell 7). Uses -EncodedCommand so we never
 * fight quoting. `useProfile` loads the user profile (needed to test the hook).
 */
async function runPwsh(script: string, useProfile = false): Promise<string> {
  const encoded = encodePwsh(script);
  const profileFlag = useProfile ? [] : ['-NoProfile'];
  const args = [
    ...profileFlag,
    '-NoLogo',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
  // Try the well-known pwsh names in order; run_command resolves via PATH.
  for (const exe of ['pwsh', 'pwsh.exe']) {
    try {
      const r = await runCommand(exe, args);
      if (r.success || r.stdout.trim() || r.stderr.trim()) {
        return `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
      }
    } catch {
      /* try next */
    }
  }
  return '';
}

function extractJson(raw: string): string {
  const s = raw.replace(/^﻿/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  if (!version) return false;
  const core = version.split(/[-+]/)[0] ?? '';
  const parts = core.split('.');
  const maj = Number(parts[0] ?? 0) || 0;
  const min = Number(parts[1] ?? 0) || 0;
  if (maj > major) return true;
  if (maj < major) return false;
  return min >= minor;
}

/** Remove any GUID-fenced hook block (mirrors the C# RemoveHookBlock line-fence logic). */
function removeHookBlock(content: string): string {
  if (!content) return content;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const isMarker =
      line.toLowerCase().includes(MARKER_GUID.toLowerCase()) ||
      line.toLowerCase().includes(LEGACY_GUID.toLowerCase());
    if (isMarker && !inside) {
      inside = true;
      continue;
    }
    if (isMarker && inside) {
      inside = false;
      continue;
    }
    if (inside) continue;
    out.push(line);
  }
  const result = out.join('\r\n');
  return result.replace(/[\r\n]+$/, '') + (result.length > 0 ? '\r\n' : '');
}

async function detect(): Promise<CnfStatus> {
  const s: CnfStatus = {
    PwshPresent: false,
    PwshVersion: '',
    PwshOk: false,
    ClientPresent: false,
    ClientUpToDate: false,
    CnfPresent: false,
    FeedbackEnabled: false,
    SuggestionEnabled: false,
    ProfilePath: '',
    HookEnabled: false,
    LegacyHookPresent: false,
    ProfileText: '',
  };
  if (!isTauri()) return s;

  const probe = `
$out = [ordered]@{}
$out.PSVersion = $PSVersionTable.PSVersion.ToString()
$feats = (Get-ExperimentalFeature -ErrorAction SilentlyContinue)
$out.FeedbackEnabled = [bool]($feats | Where-Object { $_.Name -eq 'PSFeedbackProvider' -and $_.Enabled })
$out.SuggestionEnabled = [bool]($feats | Where-Object { $_.Name -eq 'PSCommandNotFoundSuggestion' -and $_.Enabled })
$client = Get-Module -ListAvailable -Name Microsoft.WinGet.Client -ErrorAction SilentlyContinue
$out.ClientPresent = [bool]$client
$out.ClientUpToDate = [bool]($client | Where-Object { $_.Version -ge [version]'1.8.1133' })
$out.CnfPresent = [bool](Get-Module -ListAvailable -Name Microsoft.WinGet.CommandNotFound -ErrorAction SilentlyContinue)
$out.ProfilePath = $PROFILE
$profileText = ''
if ($PROFILE -and (Test-Path -LiteralPath $PROFILE)) { $profileText = Get-Content -LiteralPath $PROFILE -Raw -ErrorAction SilentlyContinue }
$out.ProfileText = "$profileText"
$out | ConvertTo-Json -Compress
`;
  const raw = await runPwsh(probe);
  if (!raw.trim()) return s; // pwsh not present / not launchable
  s.PwshPresent = true;
  try {
    const root = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    s.PwshVersion = String(root.PSVersion ?? '');
    s.PwshOk = versionAtLeast(s.PwshVersion, 7, 4);
    s.FeedbackEnabled = Boolean(root.FeedbackEnabled);
    s.SuggestionEnabled = Boolean(root.SuggestionEnabled);
    s.ClientPresent = Boolean(root.ClientPresent);
    s.ClientUpToDate = Boolean(root.ClientUpToDate);
    s.CnfPresent = Boolean(root.CnfPresent);
    s.ProfilePath = String(root.ProfilePath ?? '');
    s.ProfileText = String(root.ProfileText ?? '');
    const lc = s.ProfileText.toLowerCase();
    s.HookEnabled = lc.includes(MARKER_GUID.toLowerCase());
    s.LegacyHookPresent = lc.includes(LEGACY_GUID.toLowerCase());
  } catch {
    /* leave defaults */
  }
  return s;
}

export function CmdNotFoundModule() {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync(detect, []);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('pyton');
  const [testOut, setTestOut] = useState('');
  const [lookupInput, setLookupInput] = useState('');
  const [lookupOut, setLookupOut] = useState('');

  const s = data;
  const native = isTauri();

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setBanner({ severity: 'success', message: label, detail: text });
      } catch {
        setBanner({ severity: 'error', message: t('cmdnotfound.copyFailed'), detail: text });
      }
    },
    [t],
  );

  const enableHook = async () => {
    if (!s || busy) return;
    const confirmed = window.confirm(t('cmdnotfound.enableConfirm'));
    if (!confirmed) return;
    setBusy('enable');
    setBanner({ severity: 'info', message: t('cmdnotfound.enabling') });
    try {
      // Enable experimental features + install module if missing, then rewrite the profile safely.
      const prep = `
$ErrorActionPreference='SilentlyContinue'
$names = (Get-ExperimentalFeature).Name
if ($names -contains 'PSFeedbackProvider') { Enable-ExperimentalFeature PSFeedbackProvider -ErrorAction SilentlyContinue }
if ($names -contains 'PSCommandNotFoundSuggestion') { Enable-ExperimentalFeature PSCommandNotFoundSuggestion -ErrorAction SilentlyContinue }
if (-not (Get-Module -ListAvailable -Name Microsoft.WinGet.Client)) { Install-Module -Name Microsoft.WinGet.Client -Force -Scope CurrentUser -Repository PSGallery -ErrorAction SilentlyContinue }
if (-not (Get-Module -ListAvailable -Name Microsoft.WinGet.CommandNotFound)) { Install-Module -Name Microsoft.WinGet.CommandNotFound -Force -Scope CurrentUser -Repository PSGallery -ErrorAction SilentlyContinue }
Write-Host 'PREP_DONE'
`;
      await runPwsh(prep);

      const profilePath = s.ProfilePath || (await runPwsh('$PROFILE')).trim();
      if (!profilePath) throw new Error(t('cmdnotfound.noProfilePath'));

      const current = s.ProfileText ?? '';
      let content = removeHookBlock(current);
      const nl = content.length > 0 && !content.endsWith('\n') ? '\r\n' : '';
      const block =
        `${nl}\r\n#${MARKER_GUID} WinForge CommandNotFound module\r\n` +
        `Import-Module -Name ${CNF_MODULE}\r\n` +
        `#${MARKER_GUID}\r\n`;
      const finalText = content + block;

      // Write the profile via pwsh (creates the directory + a timestamped backup first).
      const b64 = btoa(unescape(encodeURIComponent(finalText)));
      const write = `
$ErrorActionPreference='Stop'
try {
  $p = $PROFILE
  $dir = Split-Path -Parent $p
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination ($p + '.winforge-bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force }
  $bytes = [Convert]::FromBase64String('${b64}')
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  Set-Content -LiteralPath $p -Value $text -NoNewline -Encoding UTF8
  Write-Host ('WRITE_OK ' + $p)
} catch { Write-Host ('WRITE_FAIL: ' + $_.Exception.Message) }
`;
      const out = await runPwsh(write);
      if (out.includes('WRITE_OK')) {
        setBanner({ severity: 'success', message: t('cmdnotfound.enabled'), detail: profilePath });
      } else {
        setBanner({ severity: 'error', message: t('cmdnotfound.enableFailed'), detail: out });
      }
    } catch (e) {
      setBanner({ severity: 'error', message: t('cmdnotfound.enableFailed'), detail: String(e) });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const disableHook = async () => {
    if (!s || busy) return;
    const confirmed = window.confirm(t('cmdnotfound.disableConfirm'));
    if (!confirmed) return;
    setBusy('disable');
    setBanner({ severity: 'info', message: t('cmdnotfound.disabling') });
    try {
      const stripped = removeHookBlock(s.ProfileText ?? '');
      const b64 = btoa(unescape(encodeURIComponent(stripped)));
      const write = `
$ErrorActionPreference='Stop'
try {
  $p = $PROFILE
  if (-not (Test-Path -LiteralPath $p)) { Write-Host 'NOTHING'; return }
  Copy-Item -LiteralPath $p -Destination ($p + '.winforge-bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
  $bytes = [Convert]::FromBase64String('${b64}')
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  Set-Content -LiteralPath $p -Value $text -NoNewline -Encoding UTF8
  Write-Host ('WRITE_OK ' + $p)
} catch { Write-Host ('WRITE_FAIL: ' + $_.Exception.Message) }
`;
      const out = await runPwsh(write);
      if (out.includes('WRITE_OK') || out.includes('NOTHING')) {
        setBanner({ severity: 'success', message: t('cmdnotfound.disabled') });
      } else {
        setBanner({ severity: 'error', message: t('cmdnotfound.disableFailed'), detail: out });
      }
    } catch (e) {
      setBanner({ severity: 'error', message: t('cmdnotfound.disableFailed'), detail: String(e) });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const installModule = async (update: boolean) => {
    if (busy) return;
    setBusy('module');
    setBanner({ severity: 'info', message: t(update ? 'cmdnotfound.updating' : 'cmdnotfound.installing') });
    try {
      const verb = update ? 'Update-Module' : 'Install-Module';
      const script = `
$ErrorActionPreference='Continue'
try {
  if (-not (Get-Module -ListAvailable -Name Microsoft.WinGet.Client)) { Install-Module -Name Microsoft.WinGet.Client -Force -Scope CurrentUser -Repository PSGallery -ErrorAction SilentlyContinue }
  elseif ('${verb}' -eq 'Update-Module') { Update-Module -Name Microsoft.WinGet.Client -Force -ErrorAction SilentlyContinue }
  if (-not (Get-Module -ListAvailable -Name Microsoft.WinGet.CommandNotFound)) { Install-Module -Name Microsoft.WinGet.CommandNotFound -Force -Scope CurrentUser -Repository PSGallery -ErrorAction SilentlyContinue }
  elseif ('${verb}' -eq 'Update-Module') { Update-Module -Name Microsoft.WinGet.CommandNotFound -Force -ErrorAction SilentlyContinue }
  Write-Host 'MOD_OK'
} catch { Write-Host ('MOD_FAIL: ' + $_.Exception.Message) }
`;
      const out = await runPwsh(script);
      if (out.includes('MOD_OK')) {
        setBanner({ severity: 'success', message: t(update ? 'cmdnotfound.updated' : 'cmdnotfound.installed'), detail: out.trim() });
      } else {
        setBanner({ severity: 'error', message: t('cmdnotfound.moduleFailed'), detail: out.trim() });
      }
    } catch (e) {
      setBanner({ severity: 'error', message: t('cmdnotfound.moduleFailed'), detail: String(e) });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const runTest = async () => {
    if (busy) return;
    const cmd = (testInput.trim() || 'pyton').replace(/'/g, "''");
    setBusy('test');
    setTestOut('');
    setBanner({ severity: 'info', message: t('cmdnotfound.testing') });
    try {
      const script = `
$ErrorActionPreference='SilentlyContinue'
& '${cmd}' 2>&1 | Out-String | Write-Host
`;
      const out = (await runPwsh(script, true)).trim();
      setTestOut(out);
      if (!out) {
        setBanner({ severity: 'warn', message: t('cmdnotfound.testNoOutput', { cmd: testInput.trim() || 'pyton' }) });
      } else {
        const got = /winget|install|try/i.test(out);
        setBanner({
          severity: got ? 'success' : 'info',
          message: t(got ? 'cmdnotfound.testGot' : 'cmdnotfound.testRan', { cmd: testInput.trim() || 'pyton' }),
        });
      }
    } catch (e) {
      setBanner({ severity: 'error', message: t('cmdnotfound.testFailed'), detail: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const runLookup = async () => {
    if (busy) return;
    const q = lookupInput.trim();
    if (!q) {
      setBanner({ severity: 'warn', message: t('cmdnotfound.lookupEmpty') });
      return;
    }
    setBusy('lookup');
    setLookupOut('');
    setBanner({ severity: 'info', message: t('cmdnotfound.searching', { query: q }) });
    try {
      const r = await runCommand('winget', [
        'search',
        '--query',
        q.replace(/"/g, ''),
        '--accept-source-agreements',
        '--disable-interactivity',
      ]);
      const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
      setLookupOut(out);
      const none = !out || /No package found|找不到/i.test(out);
      setBanner(
        none
          ? { severity: 'warn', message: t('cmdnotfound.lookupNone', { query: q }) }
          : { severity: 'success', message: t('cmdnotfound.lookupHit', { query: q }) },
      );
    } catch (e) {
      setBanner({ severity: 'error', message: t('cmdnotfound.lookupFailed'), detail: String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── status row descriptors ────────────────────────────────────────────────
  const pwshRow = (() => {
    if (!s || !s.PwshPresent) {
      return {
        ok: false,
        title: t('cmdnotfound.pwshMissing'),
        detail: t('cmdnotfound.pwshMissingDetail'),
      };
    }
    if (!s.PwshOk) {
      return {
        ok: false,
        title: t('cmdnotfound.pwshOld', { version: s.PwshVersion }),
        detail: t('cmdnotfound.pwshOldDetail'),
      };
    }
    return {
      ok: true,
      title: t('cmdnotfound.pwshReady', { version: s.PwshVersion }),
      detail:
        s.FeedbackEnabled && s.SuggestionEnabled
          ? t('cmdnotfound.featsOn')
          : t('cmdnotfound.featsPending'),
    };
  })();

  const hookState = !s
    ? 'disabled'
    : s.HookEnabled && !s.LegacyHookPresent
      ? 'enabled'
      : s.LegacyHookPresent
        ? 'legacy'
        : 'disabled';

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <strong style={{ marginRight: 'auto' }}>{t('cmdnotfound.title')}</strong>
        <button className="mini" onClick={reload} disabled={loading || busy !== null}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cmdnotfound.blurb')}
      </p>

      {!native && <p className="count-note">{t('cmdnotfound.desktopOnly')}</p>}
      {banner && (
        <p className={`mod-msg cmd-out ${banner.severity === 'error' ? 'error' : ''}`}>
          {banner.message}
          {banner.detail ? `\n${banner.detail}` : ''}
        </p>
      )}
      {loading && <p className="count-note">{t('modules.loading')}</p>}
      {error && <pre className="cmd-out error">{error}</pre>}

      {/* A) Status card */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 12 }}>
        <strong>{t('cmdnotfound.statusHeader')}</strong>

        <div className="cnf-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <StatusDot ok={pwshRow.ok} label={pwshRow.title} />
          <span className="count-note">{pwshRow.detail}</span>
          {s && !s.PwshOk && (
            <span className="row-actions">
              <button className="mini" disabled={busy !== null} onClick={() => copy('winget install Microsoft.PowerShell', t('cmdnotfound.copied'))}>
                {t('cmdnotfound.copyPwshInstall')}
              </button>
            </span>
          )}
        </div>

        <div className="cnf-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <StatusDot ok={!!s?.CnfPresent} label={s?.CnfPresent ? t('cmdnotfound.moduleInstalled') : t('cmdnotfound.moduleMissing')} />
          <span className="count-note">
            {!s?.CnfPresent
              ? t('cmdnotfound.moduleMissingDetail')
              : s.ClientPresent
                ? s.ClientUpToDate
                  ? t('cmdnotfound.clientCurrent')
                  : t('cmdnotfound.clientOld')
                : t('cmdnotfound.clientMissing')}
          </span>
          {s?.PwshPresent && (
            <span className="row-actions">
              <button className="mini" disabled={busy !== null} onClick={() => installModule(!!s.CnfPresent)}>
                {s.CnfPresent ? t('cmdnotfound.update') : t('cmdnotfound.installModule')}
              </button>
            </span>
          )}
        </div>

        <div className="cnf-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <StatusDot
            ok={hookState === 'enabled'}
            label={
              hookState === 'enabled'
                ? t('cmdnotfound.hookEnabled')
                : hookState === 'legacy'
                  ? t('cmdnotfound.hookLegacy')
                  : t('cmdnotfound.hookDisabled')
            }
          />
          <span className="count-note">
            {hookState === 'enabled'
              ? t('cmdnotfound.hookEnabledDetail')
              : hookState === 'legacy'
                ? t('cmdnotfound.hookLegacyDetail')
                : t('cmdnotfound.hookDisabledDetail')}
          </span>
          <span className="row-actions">
            {hookState !== 'enabled' && (
              <button className="mini primary" disabled={!s?.PwshPresent || busy !== null} onClick={enableHook}>
                {hookState === 'legacy' ? t('cmdnotfound.enableUpgrade') : t('cmdnotfound.enable')}
              </button>
            )}
            {hookState !== 'disabled' && (
              <button className="mini" disabled={!s?.PwshPresent || busy !== null} onClick={disableHook}>
                {t('cmdnotfound.disable')}
              </button>
            )}
          </span>
        </div>

        <span className="count-note" style={{ fontFamily: 'Consolas, monospace' }}>
          {s?.ProfilePath ? s.ProfilePath : t('cmdnotfound.profileUnknown')}
        </span>
      </div>

      {/* B) Test a missing command */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <strong>{t('cmdnotfound.testHeader')}</strong>
        <p className="count-note" style={{ marginTop: 0 }}>{t('cmdnotfound.testBlurb')}</p>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runTest()}
            placeholder="pyton"
          />
          <button className="mini" disabled={busy !== null} onClick={runTest}>
            {t('cmdnotfound.test')}
          </button>
        </div>
        {testOut && <pre className="cmd-out">{testOut}</pre>}
      </div>

      {/* C) In-app winget lookup */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <strong>{t('cmdnotfound.lookupHeader')}</strong>
        <p className="count-note" style={{ marginTop: 0 }}>{t('cmdnotfound.lookupBlurb')}</p>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runLookup()}
            placeholder={t('cmdnotfound.lookupPlaceholder')}
          />
          <button className="mini" disabled={busy !== null} onClick={runLookup}>
            {t('cmdnotfound.search')}
          </button>
        </div>
        {lookupOut && <pre className="cmd-out">{lookupOut}</pre>}
      </div>

      {/* D) Profile viewer */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <div className="mod-toolbar">
          <strong style={{ marginRight: 'auto' }}>{t('cmdnotfound.profileHeader')}</strong>
          <button
            className="mini"
            disabled={!s?.ProfilePath}
            onClick={() => s && copy(s.ProfilePath, t('cmdnotfound.profileCopied'))}
          >
            {t('cmdnotfound.copyProfilePath')}
          </button>
        </div>
        {s?.ProfileText ? (
          <pre className="cmd-out">{s.ProfileText}</pre>
        ) : (
          <p className="count-note">{t('cmdnotfound.profileEmpty')}</p>
        )}
      </div>

      {/* E) Bilingual explainer */}
      <div className="hosts-edit" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <strong>{t('cmdnotfound.explainHeader')}</strong>
        <p className="count-note">{t('cmdnotfound.explainEn')}</p>
        <p className="count-note">{t('cmdnotfound.explainZh')}</p>
        <button className="mini" onClick={() => copy(DOCS_URL, t('cmdnotfound.copied'))}>
          {t('cmdnotfound.copyDocsUrl')}
        </button>
      </div>
    </div>
  );
}
