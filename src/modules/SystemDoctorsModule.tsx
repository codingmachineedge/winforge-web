import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Native module — System Doctors: guided rescue routines for common Windows 11 breakages,
// ported from WinForge (Pages/SystemDoctorsModule.xaml.cs + Services/SystemDoctors.cs).
// Eight doctors: print spooler, network/DNS, sleep/wake, taskbar & Start, search index,
// Explorer perf, icon/thumbnail caches, take-ownership. Diagnostics run read-only commands
// immediately; every repair action is gated behind an explicit inline confirm.

interface ShellResult {
  ok: boolean;
  text: string;
}

async function runShell(script: string): Promise<ShellResult> {
  const res = await runPowershell(script);
  const text = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  return { ok: res.success, text: text || (res.success ? '' : `exit ${res.code}`) };
}

async function runExe(program: string, args: string[]): Promise<ShellResult> {
  const res = await runCommand(program, args);
  const text = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  return { ok: res.success, text: text || (res.success ? '' : `exit ${res.code}`) };
}

const esc = (s: string) => s.replace(/'/g, "''");

// ---- PowerShell / command payloads (Windows PowerShell 5.1 compatible, ASCII only) ----
const PS = {
  admin:
    '[pscustomobject]@{ Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }',
  printJobs:
    "Get-CimInstance Win32_PrintJob | Select-Object @{N='Document';E={[string]$_.Document}},@{N='Owner';E={[string]$_.Owner}},@{N='JobStatus';E={[string]$_.JobStatus}},@{N='Pages';E={[int]$_.TotalPages}},@{N='Name';E={[string]$_.Name}}",
  rescueSpooler: String.raw`Stop-Service -Name Spooler -Force; Remove-Item "$env:SystemRoot\System32\spool\PRINTERS\*" -Force -Recurse -ErrorAction SilentlyContinue; Start-Service -Name Spooler; 'Spooler stopped, queue purged and restarted.'`,
  restartSpooler: "Restart-Service -Name Spooler -Force; 'Spooler restarted.'",
  adapters:
    "Get-NetAdapter | Select-Object Name,InterfaceDescription,@{N='Status';E={[string]$_.Status}},@{N='LinkSpeed';E={[string]$_.LinkSpeed}},@{N='MacAddress';E={[string]$_.MacAddress}}",
  flushDns: 'ipconfig /flushdns',
  resetWinsock: 'netsh winsock reset',
  resetTcpIp: 'netsh int ip reset',
  releaseRenew: 'ipconfig /release; ipconfig /renew',
  repairAll:
    'ipconfig /flushdns; netsh winsock reset; netsh int ip reset; ipconfig /release; ipconfig /renew; netsh advfirewall reset',
  fastState: String.raw`(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled`,
  wakeTimersOff:
    "powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 0; powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 0; powercfg /setactive SCHEME_CURRENT; 'Wake timers disabled.'",
  fastOn: String.raw`Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 1 -Type DWord; 'HiberbootEnabled = 1'`,
  fastOff: String.raw`Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -Type DWord; 'HiberbootEnabled = 0'`,
  ultimate:
    "powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61; powercfg /setactive e9a42b02-d5df-448d-aa00-03f14749eb61; 'Ultimate Performance unlocked and active.'",
  fixShell: String.raw`Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; reg delete "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\IrisService" /f 2>$null; Get-AppxPackage Microsoft.Windows.ShellExperienceHost | ForEach-Object { Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml" -ErrorAction SilentlyContinue }; Get-AppxPackage Microsoft.Windows.StartMenuExperienceHost | ForEach-Object { Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml" -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Taskbar & Start repaired: cache cleared, shell packages re-registered, Explorer restarted.'`,
  searchState: String.raw`$s = Get-Service WSearch -ErrorAction SilentlyContinue; $w = (Get-ItemProperty 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\Explorer' -Name DisableSearchBoxSuggestions -ErrorAction SilentlyContinue).DisableSearchBoxSuggestions; [pscustomobject]@{ Status = $(if ($s) { [string]$s.Status } else { 'not found' }); StartType = $(if ($s) { [string]$s.StartType } else { '' }); WebOff = ($w -eq 1) }`,
  pauseSearch: "Stop-Service WSearch -Force; 'Windows Search paused (service stopped).'",
  resumeSearch: "Set-Service WSearch -StartupType Automatic; Start-Service WSearch; 'Windows Search resumed.'",
  rebuildIndex: String.raw`Stop-Service WSearch -Force; Remove-Item "$env:ProgramData\Microsoft\Search\Data\Applications\Windows\Windows.edb" -Force -ErrorAction SilentlyContinue; Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Search' -Name SetupCompletedSuccessfully -Value 0 -Type DWord -ErrorAction SilentlyContinue; Start-Service WSearch; 'Search index reset - Windows will rebuild it in the background.'`,
  webOff: String.raw`New-Item 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\Explorer' -Force | Out-Null; Set-ItemProperty 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\Explorer' -Name DisableSearchBoxSuggestions -Value 1 -Type DWord; Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Web results disabled in Start search.'`,
  webOn: String.raw`Remove-ItemProperty 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\Explorer' -Name DisableSearchBoxSuggestions -ErrorAction SilentlyContinue; Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Web results re-enabled in Start search.'`,
  expState: String.raw`$sep = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name SeparateProcess -ErrorAction SilentlyContinue).SeparateProcess; $n = (Get-Process explorer -ErrorAction SilentlyContinue | Measure-Object).Count; [pscustomobject]@{ SeparateOn = ($sep -eq 1); Procs = [int]$n }`,
  sepOn: String.raw`Set-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name SeparateProcess -Value 1 -Type DWord; 'SeparateProcess = 1 - new folder windows apply it.'`,
  sepOff: String.raw`Set-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name SeparateProcess -Value 0 -Type DWord; 'SeparateProcess = 0 - new folder windows apply it.'`,
  killGhosts:
    "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Ghost Explorer processes cleared; the shell was restarted once.'",
  iconCache: String.raw`Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; ie4uinit.exe -show; Remove-Item "$env:LocalAppData\IconCache.db" -Force -ErrorAction SilentlyContinue; Remove-Item "$env:LocalAppData\Microsoft\Windows\Explorer\iconcache*" -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Icon cache rebuilt.'`,
  thumbCache: String.raw`Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Remove-Item "$env:LocalAppData\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }; 'Thumbnail cache rebuilt.'`,
};

// ---- parsed diagnostic rows (ported from SystemDoctors.cs parsers) ----

interface Row {
  primary: string;
  secondary?: string;
  tag?: string;
}

/** powercfg /requests → category headers are ALL-CAPS tokens ending with ':'. */
function parsePowercfgRequests(raw: string): Row[] {
  const rows: Row[] = [];
  let category = '';
  for (const lineRaw of raw.replace(/\r/g, '').split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.endsWith(':') && line === line.toUpperCase() && line.length <= 24) {
      category = line.slice(0, -1);
      continue;
    }
    if (/^none\.?$/i.test(line)) continue;
    rows.push({ primary: line, secondary: category });
  }
  return rows;
}

/** powercfg /waketimers → timer entries with wrapped continuation lines. */
function parseWakeTimers(raw: string): Row[] {
  const rows: Row[] = [];
  for (const lineRaw of raw.replace(/\r/g, '').split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (/^there are no active wake timers/i.test(line)) break;
    if (line.startsWith('[') || /^timer set by/i.test(line)) {
      rows.push({ primary: line });
    } else {
      const last = rows[rows.length - 1];
      if (last) last.secondary = last.secondary ? `${last.secondary}  ${line}` : line;
    }
  }
  return rows;
}

/** powercfg /devicequery wake_armed → one device per line, NONE when empty. */
function parseWakeArmed(raw: string): Row[] {
  const rows: Row[] = [];
  for (const lineRaw of raw.replace(/\r/g, '').split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (/^none/i.test(line)) break;
    rows.push({ primary: line, tag: line });
  }
  return rows;
}

// ---- small shared UI pieces ----

/** Click-triggered async loader (diagnostics run on demand, like WinForge's buttons). */
function useLazy<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };
  return { data, loading, error, load };
}

/** Per-card action runner: busy flag, done/failed note, captured command output. */
function useActionBox() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const exec = async (verb: string, fn: () => Promise<ShellResult>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      setNote({ ok: r.ok, text: r.ok ? t('doctors.done', { verb }) : t('doctors.failed', { verb }) });
      setOutput(r.text || null);
      if (r.ok && after) after();
    } catch (e) {
      setNote({ ok: false, text: `${t('doctors.failed', { verb })} ${String(e instanceof Error ? e.message : e)}` });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, output, exec };
}

function Note({ note, busy }: { note: { ok: boolean; text: string } | null; busy: boolean }) {
  const { t } = useTranslation();
  if (busy) {
    return (
      <p className="count-note" style={{ margin: 0 }}>
        {t('doctors.running')}
      </p>
    );
  }
  if (!note) return null;
  return (
    <p className="mod-msg" style={{ margin: 0, color: note.ok ? undefined : 'var(--danger)' }}>
      {note.text}
    </p>
  );
}

/** Monospace, scrollable, copyable output pane (WinForge's RenderOutputPane). */
function Output({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mod-toolbar" style={{ marginBottom: 4 }}>
        <span className="count-note" style={{ margin: 0 }}>
          {t('doctors.output')}
        </span>
        <button
          className="mini"
          onClick={() => {
            void navigator.clipboard?.writeText(text).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? t('doctors.copied') : t('doctors.copy')}
        </button>
      </div>
      <pre className="cmd-out" style={{ maxHeight: 220, overflow: 'auto', margin: 0 }}>
        {text}
      </pre>
    </div>
  );
}

/** Every repair is confirm-gated: first click asks, second click runs. Never auto-runs. */
function ConfirmBtn({
  label,
  danger,
  disabled,
  onRun,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="row-actions" style={{ alignItems: 'center' }}>
        <span className="count-note" style={{ margin: 0 }}>
          {t('doctors.confirmQ', { action: label })}
        </span>
        <button
          className="mini primary"
          onClick={() => {
            setAsking(false);
            onRun();
          }}
        >
          {t('doctors.confirmYes')}
        </button>
        <button className="mini" onClick={() => setAsking(false)}>
          {t('doctors.confirmNo')}
        </button>
      </span>
    );
  }
  return (
    <button
      className={danger ? 'mini danger' : 'mini'}
      style={danger ? { color: 'var(--danger)' } : undefined}
      disabled={disabled}
      onClick={() => setAsking(true)}
    >
      {label}
    </button>
  );
}

/** One doctor card (WinForge Expander → native details/summary). */
function Card({ icon, title, desc, children }: { icon: string; title: string; desc: string; children: ReactNode }) {
  return (
    <details
      style={{
        border: '1px solid var(--stroke)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-card)',
        overflow: 'hidden',
      }}
    >
      <summary style={{ cursor: 'pointer', padding: '10px 14px' }}>
        <strong>
          {icon} {title}
        </strong>
        <span className="count-note" style={{ margin: '0 0 0 10px' }}>
          {desc}
        </span>
      </summary>
      <div style={{ padding: '6px 14px 14px', display: 'grid', gap: 8 }}>{children}</div>
    </details>
  );
}

/** Parsed diagnostic rows (item + detail + optional per-row action). */
function RowsTable({ rows, action }: { rows: Row[]; action?: (row: Row) => ReactNode }) {
  const { t } = useTranslation();
  const columns: Column<Row>[] = [
    { key: 'primary', header: t('doctors.colItem'), render: (r) => r.primary },
    {
      key: 'secondary',
      header: t('doctors.colDetail'),
      render: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.secondary ?? ''}</span>,
    },
  ];
  if (action) columns.push({ key: 'act', header: '', width: 150, render: (r) => action(r) });
  return <DataTable columns={columns} rows={rows} rowKey={(r, i) => `${i}-${r.primary}`} />;
}

// =============================== the module ===============================

export function SystemDoctorsModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const { data: adminRows } = useAsync(
    () => (desktop ? runPowershellJson<{ Admin: boolean }>(PS.admin) : Promise.resolve([] as { Admin: boolean }[])),
    [desktop],
  );
  const admin = adminRows && adminRows.length > 0 ? adminRows[0]?.Admin === true : null;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('doctors.subtitle')}
      </p>
      {!desktop && <p className="count-note">{t('doctors.desktopOnly')}</p>}
      {desktop && admin !== null && (
        <div className="mod-toolbar">
          <StatusDot ok={admin} label={admin ? t('doctors.adminOn') : t('doctors.adminOff')} />
        </div>
      )}
      {desktop && admin === false && (
        <p className="mod-msg">
          {t('doctors.adminWarnTitle')} — {t('doctors.adminWarnBody')}
        </p>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        <PrintDoctor desktop={desktop} />
        <NetworkDoctor desktop={desktop} />
        <SleepDoctor desktop={desktop} />
        <ShellDoctor desktop={desktop} />
        <SearchDoctor desktop={desktop} />
        <ExplorerDoctor desktop={desktop} />
        <CacheDoctor desktop={desktop} />
        <OwnershipDoctor desktop={desktop} />
      </div>
    </div>
  );
}

// ---- 1) Print Spooler & queue rescue ----

interface PrintJob {
  Document: string | null;
  Owner: string | null;
  JobStatus: string | null;
  Pages: number;
  Name: string | null;
}

function PrintDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const jobs = useLazy(() => runPowershellJson<PrintJob>(PS.printJobs));
  const box = useActionBox();

  const cancelJob = (name: string) =>
    void box.exec(
      t('doctors.verbCancelJob'),
      () =>
        runShell(
          `Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -eq '${esc(name)}' } | Remove-CimInstance; 'Job cancelled.'`,
        ),
      () => void jobs.load(),
    );

  const columns: Column<PrintJob>[] = [
    { key: 'Document', header: t('doctors.document'), render: (j) => j.Document || j.Name || '—' },
    { key: 'Owner', header: t('doctors.owner'), width: 120, render: (j) => j.Owner ?? '' },
    { key: 'JobStatus', header: t('doctors.statusCol'), width: 150, render: (j) => j.JobStatus ?? '' },
    { key: 'Pages', header: t('doctors.pages'), width: 70, align: 'right', render: (j) => String(j.Pages) },
    {
      key: 'act',
      header: '',
      width: 130,
      render: (j) =>
        j.Name ? (
          <ConfirmBtn
            label={t('doctors.cancelJob')}
            danger
            disabled={box.busy}
            onRun={() => cancelJob(j.Name ?? '')}
          />
        ) : null,
    },
  ];

  return (
    <Card icon="🖨️" title={t('doctors.printTitle')} desc={t('doctors.printDesc')}>
      <ModuleToolbar>
        <button className="mini primary" disabled={!desktop || jobs.loading} onClick={() => void jobs.load()}>
          {t('doctors.printDiagnose')}
        </button>
        <ConfirmBtn
          label={t('doctors.printRescue')}
          danger
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.verbRescue'), () => runShell(PS.rescueSpooler), () => void jobs.load())}
        />
        <ConfirmBtn
          label={t('doctors.printRestart')}
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.verbRestartSpooler'), () => runShell(PS.restartSpooler))}
        />
      </ModuleToolbar>
      {jobs.error && <pre className="cmd-out error">{jobs.error}</pre>}
      {jobs.data && (
        <>
          <p className="count-note" style={{ margin: 0 }}>
            {jobs.data.length === 0 ? t('doctors.printEmpty') : t('doctors.printJobs', { total: jobs.data.length })}
          </p>
          {jobs.data.length > 0 && (
            <DataTable columns={columns} rows={jobs.data} rowKey={(j, i) => j.Name ?? String(i)} />
          )}
        </>
      )}
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 2) Network / DNS doctor ----

interface Adapter {
  Name: string | null;
  InterfaceDescription: string | null;
  Status: string | null;
  LinkSpeed: string | null;
  MacAddress: string | null;
}

function NetworkDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const adapters = useLazy(() => runPowershellJson<Adapter>(PS.adapters));
  const box = useActionBox();

  const bounce = (name: string) =>
    void box.exec(
      t('doctors.verbBounce'),
      () =>
        runShell(
          `Disable-NetAdapter -Name '${esc(name)}' -Confirm:$false; Start-Sleep -Seconds 2; Enable-NetAdapter -Name '${esc(name)}' -Confirm:$false; 'Adapter bounced.'`,
        ),
      () => void adapters.load(),
    );

  const columns: Column<Adapter>[] = [
    {
      key: 'Status',
      header: t('doctors.statusCol'),
      width: 110,
      render: (a) => <StatusDot ok={(a.Status ?? '') === 'Up'} label={a.Status ?? '?'} />,
    },
    { key: 'Name', header: t('doctors.adapter'), width: 160, render: (a) => a.Name ?? '' },
    {
      key: 'InterfaceDescription',
      header: t('doctors.netDescCol'),
      render: (a) => <span style={{ color: 'var(--text-secondary)' }}>{a.InterfaceDescription ?? ''}</span>,
    },
    { key: 'LinkSpeed', header: t('doctors.speed'), width: 110, render: (a) => a.LinkSpeed ?? '' },
    {
      key: 'act',
      header: '',
      width: 130,
      render: (a) =>
        a.Name ? (
          <ConfirmBtn label={t('doctors.bounce')} disabled={box.busy} onRun={() => bounce(a.Name ?? '')} />
        ) : null,
    },
  ];

  const op = (labelKey: string, script: string) => (
    <ConfirmBtn
      label={t(labelKey)}
      disabled={!desktop || box.busy}
      onRun={() => void box.exec(t(labelKey), () => runShell(script))}
    />
  );

  return (
    <Card icon="🌐" title={t('doctors.netTitle')} desc={t('doctors.netDesc')}>
      <ModuleToolbar>
        <button className="mini primary" disabled={!desktop || adapters.loading} onClick={() => void adapters.load()}>
          {t('doctors.netList')}
        </button>
        {op('doctors.flushDns', PS.flushDns)}
        {op('doctors.resetWinsock', PS.resetWinsock)}
        {op('doctors.resetTcpip', PS.resetTcpIp)}
        {op('doctors.releaseRenew', PS.releaseRenew)}
        <ConfirmBtn
          label={t('doctors.repairAll')}
          danger
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.repairAll'), () => runShell(PS.repairAll))}
        />
      </ModuleToolbar>
      {adapters.error && <pre className="cmd-out error">{adapters.error}</pre>}
      {adapters.data && (
        <>
          <p className="count-note" style={{ margin: 0 }}>
            {adapters.data.length === 0 ? t('doctors.netNone') : t('doctors.netFound', { total: adapters.data.length })}
          </p>
          {adapters.data.length > 0 && (
            <DataTable columns={columns} rows={adapters.data} rowKey={(a, i) => a.Name ?? String(i)} />
          )}
        </>
      )}
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 3) Sleep / Wake doctor ----

type SleepKind = 'blockers' | 'wake' | 'timers' | 'devices' | 'fast';

interface SleepReport {
  kind: SleepKind;
  summary: string;
  rows: Row[];
  raw: string;
}

function SleepDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<SleepReport | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const box = useActionBox();

  const diagnose = async (kind: SleepKind) => {
    setDiagBusy(true);
    setDiagErr(null);
    try {
      if (kind === 'fast') {
        const r = await runShell(PS.fastState);
        if (!r.ok) {
          setReport({ kind, rows: [], raw: r.text, summary: t('doctors.diagFailed') });
          return;
        }
        const v = r.text.split('\n')[0]?.trim() ?? '';
        setReport({
          kind,
          rows: [],
          raw: `HiberbootEnabled = ${v || '(unset)'}`,
          summary: v.startsWith('1') ? t('doctors.fastOn') : t('doctors.fastOff'),
        });
        return;
      }
      const args =
        kind === 'blockers'
          ? ['/requests']
          : kind === 'wake'
            ? ['/lastwake']
            : kind === 'timers'
              ? ['/waketimers']
              : ['/devicequery', 'wake_armed'];
      const r = await runExe('powercfg', args);
      if (!r.ok) {
        setReport({ kind, rows: [], raw: r.text, summary: t('doctors.diagFailed') });
        return;
      }
      if (kind === 'blockers') {
        const rows = parsePowercfgRequests(r.text);
        setReport({
          kind,
          rows,
          raw: r.text,
          summary: rows.length === 0 ? t('doctors.blockersNone') : t('doctors.blockersFound', { total: rows.length }),
        });
      } else if (kind === 'wake') {
        setReport({ kind, rows: [], raw: r.text, summary: t('doctors.lastWakeTitle') });
      } else if (kind === 'timers') {
        const rows = parseWakeTimers(r.text);
        setReport({
          kind,
          rows,
          raw: r.text,
          summary:
            rows.length === 0 ? t('doctors.wakeTimersNone') : t('doctors.wakeTimersFound', { total: rows.length }),
        });
      } else {
        const rows = parseWakeArmed(r.text);
        setReport({
          kind,
          rows,
          raw: r.text,
          summary:
            rows.length === 0 ? t('doctors.wakeArmedNone') : t('doctors.wakeArmedFound', { total: rows.length }),
        });
      }
    } catch (e) {
      setDiagErr(String(e instanceof Error ? e.message : e));
    } finally {
      setDiagBusy(false);
    }
  };

  const diag = (labelKey: string, kind: SleepKind) => (
    <button className="mini" disabled={!desktop || diagBusy} onClick={() => void diagnose(kind)}>
      {t(labelKey)}
    </button>
  );

  const op = (labelKey: string, script: string) => (
    <ConfirmBtn
      label={t(labelKey)}
      disabled={!desktop || box.busy}
      onRun={() => void box.exec(t(labelKey), () => runShell(script))}
    />
  );

  return (
    <Card icon="💤" title={t('doctors.sleepTitle')} desc={t('doctors.sleepDesc')}>
      <ModuleToolbar>
        {diag('doctors.blockers', 'blockers')}
        {diag('doctors.lastWake', 'wake')}
        {diag('doctors.wakeTimers', 'timers')}
        {diag('doctors.wakeArmed', 'devices')}
        {diag('doctors.fastState', 'fast')}
      </ModuleToolbar>
      <ModuleToolbar>
        {op('doctors.disableTimers', PS.wakeTimersOff)}
        {op('doctors.fastDisable', PS.fastOff)}
        {op('doctors.fastEnable', PS.fastOn)}
        {op('doctors.ultimate', PS.ultimate)}
      </ModuleToolbar>
      {diagErr && <pre className="cmd-out error">{diagErr}</pre>}
      {report && (
        <>
          <p className="count-note" style={{ margin: 0 }}>
            {report.summary}
          </p>
          {report.rows.length > 0 && (
            <RowsTable
              rows={report.rows}
              action={
                report.kind === 'devices'
                  ? (r) => {
                      const tag = r.tag;
                      if (!tag) return null;
                      return (
                        <ConfirmBtn
                          label={t('doctors.disarm')}
                          danger
                          disabled={box.busy}
                          onRun={() =>
                            void box.exec(
                              t('doctors.verbDisarm'),
                              () => runExe('powercfg', ['/devicedisablewake', tag]),
                              () => void diagnose('devices'),
                            )
                          }
                        />
                      );
                    }
                  : undefined
              }
            />
          )}
          {report.rows.length === 0 && report.raw && <Output text={report.raw} />}
        </>
      )}
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 4) Shell recovery: fix taskbar & Start ----

function ShellDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const box = useActionBox();
  return (
    <Card icon="🧰" title={t('doctors.shellTitle')} desc={t('doctors.shellDesc')}>
      <p className="count-note" style={{ margin: 0 }}>
        {t('doctors.shellFlash')}
      </p>
      <ModuleToolbar>
        <ConfirmBtn
          label={t('doctors.shellRepair')}
          danger
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.shellRepair'), () => runShell(PS.fixShell))}
        />
      </ModuleToolbar>
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 5) Search index governor ----

interface SearchState {
  Status: string;
  StartType: string;
  WebOff: boolean;
}

function SearchDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const state = useLazy(() => runPowershellJson<SearchState>(PS.searchState));
  const box = useActionBox();
  const st = state.data && state.data.length > 0 ? state.data[0] : undefined;

  const op = (labelKey: string, script: string, danger?: boolean) => (
    <ConfirmBtn
      label={t(labelKey)}
      danger={danger}
      disabled={!desktop || box.busy}
      onRun={() => void box.exec(t(labelKey), () => runShell(script), () => void state.load())}
    />
  );

  return (
    <Card icon="🔍" title={t('doctors.searchTitle')} desc={t('doctors.searchDesc')}>
      <ModuleToolbar>
        <button className="mini primary" disabled={!desktop || state.loading} onClick={() => void state.load()}>
          {t('doctors.searchCheck')}
        </button>
        {op('doctors.searchPause', PS.pauseSearch)}
        {op('doctors.searchResume', PS.resumeSearch)}
        {op('doctors.searchRebuild', PS.rebuildIndex, true)}
        {op('doctors.webDisable', PS.webOff)}
        {op('doctors.webEnable', PS.webOn)}
      </ModuleToolbar>
      {state.error && <pre className="cmd-out error">{state.error}</pre>}
      {st && (
        <div className="mod-toolbar" style={{ marginBottom: 0 }}>
          <StatusDot
            ok={st.Status === 'Running'}
            label={`${t('doctors.searchSvc')}: ${st.Status}${st.StartType ? ` / ${st.StartType}` : ''}`}
          />
          <StatusDot
            ok={!st.WebOff}
            label={`${t('doctors.webResults')}: ${st.WebOff ? t('doctors.disabled') : t('doctors.enabled')}`}
          />
        </div>
      )}
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 6) Explorer perf tuner ----

interface ExpState {
  SeparateOn: boolean;
  Procs: number;
}

function ExplorerDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const state = useLazy(() => runPowershellJson<ExpState>(PS.expState));
  const box = useActionBox();
  const st = state.data && state.data.length > 0 ? state.data[0] : undefined;

  const op = (labelKey: string, script: string, danger?: boolean) => (
    <ConfirmBtn
      label={t(labelKey)}
      danger={danger}
      disabled={!desktop || box.busy}
      onRun={() => void box.exec(t(labelKey), () => runShell(script), () => void state.load())}
    />
  );

  return (
    <Card icon="📁" title={t('doctors.expTitle')} desc={t('doctors.expDesc')}>
      <ModuleToolbar>
        <button className="mini primary" disabled={!desktop || state.loading} onClick={() => void state.load()}>
          {t('doctors.expCheck')}
        </button>
        {op('doctors.expSepOn', PS.sepOn)}
        {op('doctors.expSepOff', PS.sepOff)}
        {op('doctors.expKill', PS.killGhosts, true)}
      </ModuleToolbar>
      {state.error && <pre className="cmd-out error">{state.error}</pre>}
      {st && (
        <div className="mod-toolbar" style={{ marginBottom: 0 }}>
          <StatusDot
            ok={st.SeparateOn}
            label={`${t('doctors.expSeparate')}: ${st.SeparateOn ? t('doctors.on') : t('doctors.off')}`}
          />
          <span className="count-note" style={{ margin: 0 }}>
            {t('doctors.expProcs', { total: st.Procs })}
          </span>
        </div>
      )}
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 7) Icon & thumbnail cache rebuilder ----

function CacheDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const box = useActionBox();
  return (
    <Card icon="🖼️" title={t('doctors.cacheTitle')} desc={t('doctors.cacheDesc')}>
      <ModuleToolbar>
        <ConfirmBtn
          label={t('doctors.cacheIcon')}
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.cacheIcon'), () => runShell(PS.iconCache))}
        />
        <ConfirmBtn
          label={t('doctors.cacheThumb')}
          disabled={!desktop || box.busy}
          onRun={() => void box.exec(t('doctors.cacheThumb'), () => runShell(PS.thumbCache))}
        />
      </ModuleToolbar>
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}

// ---- 8) Take ownership / reset permissions ----

function OwnershipDoctor({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [recurse, setRecurse] = useState(true);
  const box = useActionBox();

  const clean = esc(path.replace(/"/g, '').trim());
  const takeScript =
    `$p = '${clean}'; $u = $env:USERDOMAIN + '\\' + $env:USERNAME; ` +
    `takeown /f $p${recurse ? ' /r /d y' : ''} 2>&1 | Out-String; ` +
    `icacls $p /grant ($u + ':F')${recurse ? ' /t /c' : ''} 2>&1 | Out-String`;
  const resetScript = `$p = '${clean}'; icacls $p /reset${recurse ? ' /t /c' : ''} 2>&1 | Out-String`;

  return (
    <Card icon="🔐" title={t('doctors.ownTitle')} desc={t('doctors.ownDesc')}>
      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: '1 1 260px' }}
          placeholder={t('doctors.ownPath')}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <label className="count-note" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={recurse} onChange={(e) => setRecurse(e.target.checked)} />
          {t('doctors.ownRecurse')}
        </label>
      </ModuleToolbar>
      {!clean && (
        <p className="count-note" style={{ margin: 0 }}>
          {t('doctors.noPath')}
        </p>
      )}
      <ModuleToolbar>
        <ConfirmBtn
          label={t('doctors.ownTake')}
          danger
          disabled={!desktop || !clean || box.busy}
          onRun={() => void box.exec(t('doctors.ownTake'), () => runShell(takeScript))}
        />
        <ConfirmBtn
          label={t('doctors.ownReset')}
          disabled={!desktop || !clean || box.busy}
          onRun={() => void box.exec(t('doctors.ownReset'), () => runShell(resetScript))}
        />
      </ModuleToolbar>
      <Note note={box.note} busy={box.busy} />
      {box.output && <Output text={box.output} />}
    </Card>
  );
}
