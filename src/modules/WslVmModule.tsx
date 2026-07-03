import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// WSL & VM Launcher — native port of WinForge's WslVmModule (Pages/WslVmModule.xaml[.cs] +
// Services/WslVmService.cs). Manages WSL distributions (list / install / export / import /
// set-default / terminate / unregister / shutdown), shows `wsl --status`, lists & controls
// Hyper-V VMs when the Hyper-V PowerShell module is present, and builds a .wsb config to
// launch Windows Sandbox — all through the Tauri PowerShell (5.1) bridge.
//
// Encoding note: wsl.exe historically emits UTF-16LE to pipes. We set $env:WSL_UTF8=1 (modern
// WSL then emits UTF-8) AND strip stray NUL characters defensively (`-replace '\0',''`), so
// old engines that ignore WSL_UTF8 still parse cleanly (UTF-16LE ASCII decoded byte-wise is
// the same text with interleaved NULs). All reads are on-demand; every mutation is behind an
// explicit click, destructive ones (terminate / unregister / shutdown / install / stop VM /
// enable feature) behind an inline confirm bar.

interface Probe {
  WslFound: boolean;
  WslOk: boolean;
  StatusRaw: string;
  VersionLine: string;
  Sandbox: boolean;
  HyperV: boolean;
  Profile: string;
}
interface Distro {
  Name: string;
  State: string;
  Version: number;
  IsDefault: boolean;
}
interface OnlineDistro {
  Name: string;
  FriendlyName: string;
}
interface HvVm {
  Name: string;
  State: string;
  CPUUsage: number;
  MemoryMB: number;
  UptimeMin: number;
}
interface HvInfo {
  Available: boolean;
  Error: string;
  Vms: HvVm[] | HvVm | null;
}
type PendKind =
  | 'terminate'
  | 'unregister'
  | 'shutdown'
  | 'install'
  | 'installWsl'
  | 'stopVm'
  | 'enableSandbox';
interface Pending {
  kind: PendKind;
  name: string;
}

// ── PowerShell 5.1 scripts (read-only probes) ────────────────────────────────

const PROBE_PS =
  `$ErrorActionPreference='Continue'; $env:WSL_UTF8='1'; ` +
  `$wslCmd=Get-Command wsl.exe -ErrorAction SilentlyContinue; $status=''; $ver=''; $ok=$false; ` +
  `if($wslCmd){ $status=((wsl.exe --status 2>&1 | ForEach-Object {"$_"} | Out-String) -replace '\\0','').Trim(); ` +
  `$ver=((wsl.exe --version 2>&1 | ForEach-Object {"$_"} | Out-String) -replace '\\0','').Trim(); ` +
  `$bad='not recognized|not found|not installed'; ` +
  `$ok=(($status.Length -gt 0) -and ($status -notmatch $bad)) -or (($ver.Length -gt 0) -and ($ver -notmatch $bad)) }; ` +
  `$vline=''; if($ver){ $m=@(($ver -split '\\r?\\n') | Where-Object { $_ -match 'WSL' } | Select-Object -First 1); ` +
  `if($m.Count -gt 0 -and $m[0]){ $vline="$($m[0])".Trim() } }; ` +
  `[pscustomobject]@{ WslFound=[bool]$wslCmd; WslOk=[bool]$ok; StatusRaw=$status; VersionLine=$vline; ` +
  `Sandbox=[bool](Test-Path (Join-Path $env:windir 'System32\\WindowsSandbox.exe')); ` +
  `HyperV=[bool](Get-Command Get-VM -ErrorAction SilentlyContinue); Profile="$env:USERPROFILE" }`;

// Mirrors WslVmService.ListDistros(): parse `wsl --list --verbose` (header, default '*', 3 columns).
const DISTROS_PS =
  `$ErrorActionPreference='Continue'; $env:WSL_UTF8='1'; ` +
  `$raw=((wsl.exe --list --verbose 2>&1 | ForEach-Object {"$_"} | Out-String) -replace '\\0',''); $rows=@(); ` +
  `foreach($line in ($raw -split '\\r?\\n')){ $t=$line.Trim(); if($t.Length -eq 0){continue}; ` +
  `if(($t -match 'NAME') -and ($t -match 'STATE')){continue}; if($t -match 'Windows Subsystem for Linux'){continue}; ` +
  `if($t -like 'wsl.exe*'){continue}; if($t -match 'not recognized|not found'){continue}; ` +
  `$isDef=$t.StartsWith('*'); $parts=@((($t -replace '\\*',' ').Trim()) -split '\\s+'); if($parts.Count -lt 3){continue}; ` +
  `$v=0; [void][int]::TryParse($parts[2],[ref]$v); ` +
  `$rows+=[pscustomobject]@{ Name=$parts[0]; State=$parts[1]; Version=$v; IsDefault=[bool]$isDef } }; $rows`;

// Mirrors WslVmService.ListOnline(): parse `wsl --list --online` (rows after the NAME/FRIENDLY header).
const ONLINE_PS =
  `$ErrorActionPreference='Continue'; $env:WSL_UTF8='1'; ` +
  `$raw=((wsl.exe --list --online 2>&1 | ForEach-Object {"$_"} | Out-String) -replace '\\0',''); $rows=@(); $started=$false; ` +
  `foreach($line in ($raw -split '\\r?\\n')){ $t=$line.Trim(); if($t.Length -eq 0){continue}; ` +
  `if(($t -match 'NAME') -and ($t -match 'FRIENDLY')){$started=$true; continue}; if(-not $started){continue}; ` +
  `if($t.StartsWith('*')){continue}; $parts=@($t -split '\\s+',2); if($parts.Count -lt 1){continue}; ` +
  `$n="$($parts[0])"; if($n.Length -eq 0){continue}; $fn=$n; if($parts.Count -gt 1 -and $parts[1]){ $fn="$($parts[1])".Trim() }; ` +
  `$rows+=[pscustomobject]@{ Name=$n; FriendlyName=$fn } }; $rows`;

const HYPERV_PS =
  `$vms=@(); $avail=$false; $err=''; $cmd=Get-Command Get-VM -ErrorAction SilentlyContinue; ` +
  `if($cmd){ $avail=$true; try{ $vms=@(Get-VM -ErrorAction Stop | Select-Object Name,` +
  `@{N='State';E={$_.State.ToString()}},@{N='CPUUsage';E={[int]$_.CPUUsage}},` +
  `@{N='MemoryMB';E={[int]($_.MemoryAssigned/1MB)}},@{N='UptimeMin';E={[int]$_.Uptime.TotalMinutes}}) }` +
  `catch{ $err=$_.Exception.Message } }; ` +
  `[pscustomobject]@{ Available=[bool]$avail; Error="$err"; Vms=$vms }`;

// ── helpers (module-scope, no state) ─────────────────────────────────────────

/** WSL distro names are [A-Za-z0-9._-]; strip anything else so names can never break quoting. */
const safe = (s: string): string => s.replace(/[^\w.\-]/g, '');
/** Windows paths: strip quotes, backticks, `$` and control chars so they embed safely in "…". */
const sanPath = (s: string): string => s.replace(/["`$\u0000-\u001f]/g, '').trim();
/** Single-quote escape for PowerShell 'strings' (Hyper-V VM names may contain anything). */
const psq = (s: string): string => s.replace(/['\u0000-\u001f]/g, (c) => (c === "'" ? "''" : ''));

const toB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Run a wsl.exe verb, decode defensively (WSL_UTF8 + NUL strip), throw its output on failure. */
async function wslRaw(args: string): Promise<string> {
  const script =
    `$ErrorActionPreference='Continue'; $env:WSL_UTF8='1'; ` +
    `$out=((wsl.exe ${args} 2>&1 | ForEach-Object {"$_"} | Out-String) -replace '\\0','').Trim(); ` +
    `Write-Output $out; if($LASTEXITCODE -ne 0){exit 1}`;
  const res = await runPowershell(script);
  const out = (res.stdout ?? '').replace(/\u0000/g, '').trim();
  if (!res.success) throw new Error(out || (res.stderr ?? '').trim() || `exit ${res.code}`);
  return out;
}

/** Run a PowerShell body inside try/catch; throw the exception message on failure. */
async function psRun(body: string): Promise<string> {
  const res = await runPowershell(
    `try{ ${body}; Write-Output 'ok' }catch{ Write-Output $_.Exception.Message; exit 1 }`,
  );
  const out = (res.stdout ?? '').trim();
  if (!res.success) throw new Error(out || (res.stderr ?? '').trim() || `exit ${res.code}`);
  return out;
}

/** Start a program detached in its own window (terminal / installer / DISM). Args must be pre-sanitized. */
function startProc(file: string, args: string[]): Promise<string> {
  const list = args.map((a) => `'${a}'`).join(',');
  return psRun(`Start-Process -FilePath '${file}' -ArgumentList ${list} -ErrorAction Stop`);
}

const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Port of WslVmService.BuildWsbXml — Windows Sandbox .wsb configuration. */
function buildWsb(
  folder: string,
  readOnly: boolean,
  networking: boolean,
  vgpu: boolean,
  clipboard: boolean,
  logon: string,
): string {
  const lines: string[] = ['<Configuration>'];
  lines.push(`  <Networking>${networking ? 'Default' : 'Disable'}</Networking>`);
  lines.push(`  <vGPU>${vgpu ? 'Enable' : 'Disable'}</vGPU>`);
  lines.push(`  <ClipboardRedirection>${clipboard ? 'Default' : 'Disable'}</ClipboardRedirection>`);
  const host = folder.trim();
  if (host) {
    lines.push('  <MappedFolders>');
    lines.push('    <MappedFolder>');
    lines.push(`      <HostFolder>${xmlEsc(host)}</HostFolder>`);
    lines.push(`      <ReadOnly>${readOnly ? 'true' : 'false'}</ReadOnly>`);
    lines.push('    </MappedFolder>');
    lines.push('  </MappedFolders>');
  }
  const lg = logon.trim();
  if (lg) {
    lines.push('  <LogonCommand>');
    lines.push(`    <Command>${xmlEsc(lg)}</Command>`);
    lines.push('  </LogonCommand>');
  }
  lines.push('</Configuration>');
  return lines.join('\n') + '\n';
}

const fmtMem = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

function fmtUptime(min: number): string {
  const mm = Math.max(0, Math.floor(min));
  const d = Math.floor(mm / 1440);
  const h = Math.floor((mm % 1440) / 60);
  const m = mm % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── component ────────────────────────────────────────────────────────────────

export function WslVmModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [exporting, setExporting] = useState<{ name: string; path: string } | null>(null);
  const [selOnline, setSelOnline] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [impName, setImpName] = useState('');
  const [impDir, setImpDir] = useState('');
  const [impTar, setImpTar] = useState('');
  const [sbFolder, setSbFolder] = useState('');
  const [sbReadOnly, setSbReadOnly] = useState(false);
  const [sbNet, setSbNet] = useState(true);
  const [sbVgpu, setSbVgpu] = useState(false);
  const [sbClip, setSbClip] = useState(true);
  const [sbLogon, setSbLogon] = useState('');
  const [wsbPreview, setWsbPreview] = useState<string | null>(null);

  const probe = useAsync<Probe | null>(async () => {
    if (!desktop) return null;
    const r = await runPowershellJson<Probe>(PROBE_PS);
    return r[0] ?? null;
  }, [desktop]);
  const p = probe.data;
  const wslOk = p?.WslOk === true;
  const hvOn = p?.HyperV === true;

  const distros = useAsync<Distro[]>(
    async () => (!desktop || !wslOk ? [] : runPowershellJson<Distro>(DISTROS_PS)),
    [desktop, wslOk],
  );
  const online = useAsync<OnlineDistro[]>(
    async () => (!desktop || !wslOk ? [] : runPowershellJson<OnlineDistro>(ONLINE_PS)),
    [desktop, wslOk],
  );
  const hv = useAsync<HvInfo | null>(async () => {
    if (!desktop || !hvOn) return null;
    const r = await runPowershellJson<HvInfo>(HYPERV_PS);
    return r[0] ?? null;
  }, [desktop, hvOn]);

  const distroRows = distros.data ?? [];
  const onlineRows = online.data ?? [];
  const hvInfo = hv.data;
  const vms: HvVm[] = !hvInfo?.Vms ? [] : Array.isArray(hvInfo.Vms) ? hvInfo.Vms : [hvInfo.Vms];
  const chosen = selOnline || onlineRows[0]?.Name || '';

  const reloadAll = () => {
    probe.reload();
    distros.reload();
    online.reload();
    hv.reload();
  };

  const act = async (fn: () => Promise<string>) => {
    if (!desktop) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  // ── direct (non-destructive) actions ──────────────────────────────────────

  const doLaunch = (name: string) =>
    void act(async () => {
      await startProc('wsl.exe', ['-d', safe(name)]);
      return t('wslvm.doneLaunch');
    });

  const doSetDefault = (name: string) =>
    void act(async () => {
      await wslRaw(`--set-default "${safe(name)}"`);
      distros.reload();
      return t('wslvm.doneSetDefault', { name });
    });

  const doExport = () => {
    const ex = exporting;
    if (!ex) return;
    void act(async () => {
      const path = sanPath(ex.path);
      await wslRaw(`--export "${safe(ex.name)}" "${path}"`);
      setExporting(null);
      return t('wslvm.doneExport', { path });
    });
  };

  const doImport = () => {
    const nm = safe(impName.trim());
    const dir = sanPath(impDir);
    const tar = sanPath(impTar);
    if (!nm || !dir || !tar) return;
    void act(async () => {
      await wslRaw(`--import "${nm}" "${dir}" "${tar}"`);
      setShowImport(false);
      setImpName('');
      setImpDir('');
      setImpTar('');
      distros.reload();
      return t('wslvm.doneImport', { name: nm });
    });
  };

  const doStartVm = (name: string) =>
    void act(async () => {
      await psRun(`Start-VM -Name '${psq(name)}' -ErrorAction Stop`);
      hv.reload();
      return t('wslvm.doneStartVm', { name });
    });

  const doLaunchSandbox = () =>
    void act(async () => {
      const b64 = toB64(buildWsb(sbFolder, sbReadOnly, sbNet, sbVgpu, sbClip, sbLogon));
      const out = await psRun(
        `$b64='${b64}'; $xml=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)); ` +
          `$p=Join-Path $env:TEMP ('winforge-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.wsb'); ` +
          `[IO.File]::WriteAllText($p,$xml); ` +
          `Start-Process -FilePath 'WindowsSandbox.exe' -ArgumentList ('"'+$p+'"') -ErrorAction Stop; Write-Output $p`,
      );
      const path = out.split(/\r?\n/)[0]?.trim() ?? '';
      return t('wslvm.sandboxStarted', { path });
    });

  // ── confirm-gated actions ──────────────────────────────────────────────────

  const pendingText = (pd: Pending): string => {
    switch (pd.kind) {
      case 'terminate':
        return t('wslvm.confirmTerminate', { name: pd.name });
      case 'unregister':
        return t('wslvm.confirmUnregister', { name: pd.name });
      case 'shutdown':
        return t('wslvm.confirmShutdown');
      case 'install':
        return t('wslvm.confirmInstall', { name: pd.name });
      case 'installWsl':
        return t('wslvm.confirmInstallWsl');
      case 'stopVm':
        return t('wslvm.confirmStopVm', { name: pd.name });
      case 'enableSandbox':
        return t('wslvm.confirmEnableSandbox');
    }
  };

  const runPending = () => {
    const pd = pending;
    if (!pd) return;
    setPending(null);
    switch (pd.kind) {
      case 'terminate':
        void act(async () => {
          await wslRaw(`--terminate "${safe(pd.name)}"`);
          distros.reload();
          return t('wslvm.doneTerminate', { name: pd.name });
        });
        break;
      case 'unregister':
        void act(async () => {
          await wslRaw(`--unregister "${safe(pd.name)}"`);
          distros.reload();
          return t('wslvm.doneUnregister', { name: pd.name });
        });
        break;
      case 'shutdown':
        void act(async () => {
          await wslRaw('--shutdown');
          distros.reload();
          return t('wslvm.doneShutdown');
        });
        break;
      case 'install':
        void act(async () => {
          await startProc('wsl.exe', ['--install', '-d', safe(pd.name)]);
          return t('wslvm.installStarted', { name: pd.name });
        });
        break;
      case 'installWsl':
        void act(async () => {
          await startProc('wsl.exe', ['--install', '--no-distribution']);
          return t('wslvm.wslInstallStarted');
        });
        break;
      case 'stopVm':
        void act(async () => {
          await psRun(`Stop-VM -Name '${psq(pd.name)}' -Confirm:$false -ErrorAction Stop`);
          hv.reload();
          return t('wslvm.doneStopVm', { name: pd.name });
        });
        break;
      case 'enableSandbox':
        void act(async () => {
          await psRun(
            `Start-Process -FilePath 'dism.exe' -ArgumentList '/Online','/Enable-Feature','/FeatureName:Containers-DisposableClientVM','/All','/NoRestart' -Verb RunAs -ErrorAction Stop`,
          );
          return t('wslvm.sandboxEnableStarted');
        });
        break;
    }
  };

  // ── tables ─────────────────────────────────────────────────────────────────

  const distroCols: Column<Distro>[] = [
    {
      key: 'def',
      header: '',
      width: 28,
      align: 'center',
      render: (d) => (d.IsDefault ? <span title={t('wslvm.default')}>★</span> : null),
    },
    {
      key: 'Name',
      header: t('wslvm.name'),
      render: (d) => <span style={{ fontFamily: 'monospace' }}>{d.Name}</span>,
    },
    {
      key: 'State',
      header: t('wslvm.state'),
      width: 120,
      render: (d) => <StatusDot ok={d.State === 'Running'} label={d.State} />,
    },
    {
      key: 'Version',
      header: t('wslvm.version'),
      width: 80,
      align: 'center',
      render: (d) => `WSL${d.Version}`,
    },
    {
      key: 'actions',
      header: '',
      width: 340,
      render: (d) => (
        <span className="row-actions">
          <button className="mini" disabled={busy} onClick={() => doLaunch(d.Name)}>
            {t('wslvm.launch')}
          </button>
          {!d.IsDefault && (
            <button className="mini" disabled={busy} onClick={() => doSetDefault(d.Name)}>
              {t('wslvm.setDefault')}
            </button>
          )}
          {d.State === 'Running' && (
            <button
              className="mini"
              disabled={busy}
              onClick={() => setPending({ kind: 'terminate', name: d.Name })}
            >
              {t('wslvm.terminate')}
            </button>
          )}
          <button
            className="mini"
            disabled={busy}
            onClick={() =>
              setExporting({ name: d.Name, path: `${p?.Profile || 'C:'}\\${d.Name}-backup.tar` })
            }
          >
            {t('wslvm.export')}
          </button>
          <button
            className="mini"
            disabled={busy}
            onClick={() => setPending({ kind: 'unregister', name: d.Name })}
          >
            {t('wslvm.unregister')}
          </button>
        </span>
      ),
    },
  ];

  const vmCols: Column<HvVm>[] = [
    {
      key: 'Name',
      header: t('wslvm.name'),
      render: (v) => <span style={{ fontFamily: 'monospace' }}>{v.Name}</span>,
    },
    {
      key: 'State',
      header: t('wslvm.state'),
      width: 120,
      render: (v) => <StatusDot ok={v.State === 'Running'} label={v.State} />,
    },
    {
      key: 'cpu',
      header: t('wslvm.cpu'),
      width: 80,
      align: 'right',
      render: (v) => (v.State === 'Running' ? `${v.CPUUsage}%` : '—'),
    },
    {
      key: 'mem',
      header: t('wslvm.memory'),
      width: 100,
      align: 'right',
      render: (v) => (v.MemoryMB > 0 ? fmtMem(v.MemoryMB) : '—'),
    },
    {
      key: 'up',
      header: t('wslvm.uptime'),
      width: 110,
      align: 'right',
      render: (v) => (v.State === 'Running' ? fmtUptime(v.UptimeMin) : '—'),
    },
    {
      key: 'actions',
      header: '',
      width: 130,
      render: (v) => (
        <span className="row-actions">
          {v.State === 'Running' ? (
            <button
              className="mini"
              disabled={busy}
              onClick={() => setPending({ kind: 'stopVm', name: v.Name })}
            >
              {t('wslvm.stopVm')}
            </button>
          ) : (
            <button className="mini" disabled={busy} onClick={() => doStartVm(v.Name)}>
              {t('wslvm.startVm')}
            </button>
          )}
        </span>
      ),
    },
  ];

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('wslvm.desktopOnly')}
        </p>
      )}
      <ModuleToolbar>
        <button className="mini" disabled={!desktop || busy} onClick={reloadAll}>
          ⟳ {t('wslvm.refresh')}
        </button>
        {p && (
          <>
            <StatusDot ok={p.WslOk} label={p.WslOk ? t('wslvm.wslOk') : t('wslvm.wslMissing')} />
            <StatusDot
              ok={p.Sandbox}
              label={p.Sandbox ? t('wslvm.sandboxOk') : t('wslvm.sandboxOff')}
            />
            <StatusDot ok={p.HyperV} label={p.HyperV ? t('wslvm.hvOk') : t('wslvm.hvOff')} />
          </>
        )}
        <button
          className="mini"
          disabled={!desktop || busy || !wslOk}
          onClick={() => setPending({ kind: 'shutdown', name: '' })}
        >
          {t('wslvm.shutdownWsl')}
        </button>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('wslvm.blurb')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}

      {pending && (
        <div className="panel">
          <p className="count-note" style={{ margin: 0 }}>
            {pendingText(pending)}
          </p>
          <div className="mod-toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
            <button className="mini primary" disabled={busy} onClick={runPending}>
              {t('wslvm.confirmYes')}
            </button>
            <button className="mini" onClick={() => setPending(null)}>
              {t('wslvm.cancel')}
            </button>
          </div>
        </div>
      )}

      {p && !p.WslOk && (
        <div className="panel">
          <h3>{t('wslvm.wslMissing')}</h3>
          <p className="count-note">{t('wslvm.wslMissingBody')}</p>
          <button
            className="mini primary"
            disabled={busy || !p.WslFound}
            onClick={() => setPending({ kind: 'installWsl', name: '' })}
          >
            {t('wslvm.installWslBtn')}
          </button>
        </div>
      )}

      <div className="panel">
        <h3>{t('wslvm.wslSection')}</h3>
        {p?.VersionLine ? <p className="count-note">{p.VersionLine}</p> : null}
        <AsyncState loading={probe.loading || distros.loading} error={distros.error}>
          <DataTable
            columns={distroCols}
            rows={distroRows}
            rowKey={(d) => d.Name}
            empty={t('wslvm.noDistros')}
          />
          {distroRows.length > 0 && (
            <p className="count-note">{t('wslvm.distroCount', { n: distroRows.length })}</p>
          )}
        </AsyncState>

        {exporting && (
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('wslvm.exportTitle', { name: exporting.name })}</label>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 260 }}
              value={exporting.path}
              onChange={(e) => setExporting({ name: exporting.name, path: e.target.value })}
            />
            <button
              className="mini primary"
              disabled={busy || !exporting.path.trim()}
              onClick={doExport}
            >
              {t('wslvm.export')}
            </button>
            <button className="mini" onClick={() => setExporting(null)}>
              {t('wslvm.cancel')}
            </button>
          </div>
        )}

        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('wslvm.installTitle')}</label>
          {online.loading ? (
            <span className="count-note">{t('wslvm.onlineLoading')}</span>
          ) : onlineRows.length === 0 ? (
            <span className="count-note">{t('wslvm.onlineEmpty')}</span>
          ) : (
            <>
              <select
                className="mod-search"
                style={{ maxWidth: 320 }}
                value={chosen}
                onChange={(e) => setSelOnline(e.target.value)}
              >
                {onlineRows.map((o) => (
                  <option key={o.Name} value={o.Name}>
                    {o.FriendlyName && o.FriendlyName !== o.Name
                      ? `${o.FriendlyName} (${o.Name})`
                      : o.Name}
                  </option>
                ))}
              </select>
              <button
                className="mini primary"
                disabled={!desktop || busy || !chosen}
                onClick={() => setPending({ kind: 'install', name: chosen })}
              >
                {t('wslvm.install')}
              </button>
            </>
          )}
          <button className="mini" onClick={() => setShowImport((v) => !v)}>
            {t('wslvm.importTitle')}
          </button>
        </div>

        {showImport && (
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('wslvm.importName')}</label>
            <input
              className="mod-search"
              style={{ maxWidth: 170 }}
              placeholder="Ubuntu-restored"
              value={impName}
              onChange={(e) => setImpName(e.target.value)}
            />
            <label className="count-note">{t('wslvm.importDir')}</label>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="C:\WSL\Ubuntu-restored"
              value={impDir}
              onChange={(e) => setImpDir(e.target.value)}
            />
            <label className="count-note">{t('wslvm.importTar')}</label>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="C:\backups\ubuntu.tar"
              value={impTar}
              onChange={(e) => setImpTar(e.target.value)}
            />
            <button
              className="mini primary"
              disabled={!desktop || busy || !impName.trim() || !impDir.trim() || !impTar.trim()}
              onClick={doImport}
            >
              {t('wslvm.importGo')}
            </button>
            <span className="count-note">{t('wslvm.importHint')}</span>
          </div>
        )}
      </div>

      {p?.StatusRaw ? (
        <div className="panel">
          <h3>{t('wslvm.statusTitle')}</h3>
          <pre className="cmd-out">{p.StatusRaw}</pre>
        </div>
      ) : null}

      <div className="panel">
        <h3>{t('wslvm.hvSection')}</h3>
        {p && !p.HyperV ? (
          <p className="count-note">{t('wslvm.hvNotAvailable')}</p>
        ) : hvInfo && hvInfo.Error ? (
          <p className="count-note">{t('wslvm.hvError', { msg: hvInfo.Error })}</p>
        ) : (
          <AsyncState loading={hv.loading} error={hv.error}>
            <DataTable
              columns={vmCols}
              rows={vms}
              rowKey={(v) => v.Name}
              empty={t('wslvm.hvEmpty')}
            />
            {vms.length > 0 && (
              <p className="count-note">{t('wslvm.vmCount', { n: vms.length })}</p>
            )}
          </AsyncState>
        )}
      </div>

      <div className="panel">
        <h3>{t('wslvm.sbSection')}</h3>
        {p && !p.Sandbox && (
          <>
            <p className="count-note">{t('wslvm.sbNotEnabledBody')}</p>
            <div className="mod-toolbar">
              <button
                className="mini"
                disabled={busy}
                onClick={() => setPending({ kind: 'enableSandbox', name: '' })}
              >
                {t('wslvm.enableSandbox')}
              </button>
            </div>
          </>
        )}
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('wslvm.mapTitle')}</label>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="C:\path\to\share"
            value={sbFolder}
            onChange={(e) => setSbFolder(e.target.value)}
          />
          <label className="count-note">
            <input
              type="checkbox"
              checked={sbReadOnly}
              onChange={(e) => setSbReadOnly(e.target.checked)}
            />{' '}
            {t('wslvm.readOnly')}
          </label>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">
            <input type="checkbox" checked={sbNet} onChange={(e) => setSbNet(e.target.checked)} />{' '}
            {t('wslvm.networking')}
          </label>
          <label className="count-note">
            <input
              type="checkbox"
              checked={sbVgpu}
              onChange={(e) => setSbVgpu(e.target.checked)}
            />{' '}
            {t('wslvm.vgpu')}
          </label>
          <label className="count-note">
            <input
              type="checkbox"
              checked={sbClip}
              onChange={(e) => setSbClip(e.target.checked)}
            />{' '}
            {t('wslvm.clipboard')}
          </label>
          <label className="count-note">{t('wslvm.logonTitle')}</label>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="explorer.exe"
            value={sbLogon}
            onChange={(e) => setSbLogon(e.target.value)}
          />
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button
            className="mini primary"
            disabled={!desktop || busy || p?.Sandbox !== true}
            onClick={doLaunchSandbox}
          >
            {t('wslvm.launchSandbox')}
          </button>
          <button
            className="mini"
            onClick={() =>
              setWsbPreview(buildWsb(sbFolder, sbReadOnly, sbNet, sbVgpu, sbClip, sbLogon))
            }
          >
            {t('wslvm.previewWsb')}
          </button>
        </div>
        {wsbPreview !== null && (
          <textarea
            className="hosts-edit"
            readOnly
            rows={Math.min(16, wsbPreview.split('\n').length + 1)}
            style={{ width: '100%' }}
            value={wsbPreview}
          />
        )}
        <p className="count-note">{t('wslvm.wsbHint')}</p>
      </div>
    </div>
  );
}
