import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Saved-site store, mirroring the C# FtpSiteStore schema ────────────────────
// The desktop WinForge app persists sites to %LOCALAPPDATA%\WinForge\ftp-sites.json
// with every password / passphrase DPAPI-encrypted. We read the metadata only and
// NEVER surface the EncryptedSecret — secrets stay encrypted at rest.
interface Site {
  Id: string;
  Name: string;
  Protocol: string; // Ftp | Ftps | Sftp
  Host: string;
  Port: number;
  User: string;
  Auth: string; // Password | KeyFile
  KeyFilePath: string;
  RemoteDir: string;
  HasSecret: boolean;
  Trusted: boolean;
}

// ── Local directory row (live from Get-ChildItem) ─────────────────────────────
interface LocalRow {
  Name: string;
  FullPath: string;
  IsDir: boolean;
  Size: number;
  Modified: string; // preformatted string from PowerShell
}

function defaultPort(proto: string): number {
  return proto === 'Sftp' ? 22 : 21;
}

function fmtSize(bytes: number, dash: string): string {
  if (bytes < 0) return dash;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// Escape a value destined for a single-quoted PowerShell string literal.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

export function FileZillaModule() {
  const { t } = useTranslation();
  const dash = '—';

  const [msg, setMsg] = useState<string | null>(null);

  // ── Site Manager ────────────────────────────────────────────────────────────
  const sitesState = useAsync(
    () =>
      runPowershellJson<Site>(
        [
          "$p = Join-Path $env:LOCALAPPDATA 'WinForge\\ftp-sites.json';",
          'if (-not (Test-Path $p)) { @() | ConvertTo-Json; return }',
          '$raw = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json',
          '$raw | ForEach-Object {',
          "  $sec = [string]$_.EncryptedSecret;",
          "  $fp  = [string]$_.TrustedFingerprint;",
          '  [pscustomobject]@{',
          '    Id=[string]$_.Id; Name=[string]$_.Name; Protocol=[string]$_.Protocol;',
          '    Host=[string]$_.Host; Port=[int]$_.Port; User=[string]$_.User;',
          '    Auth=[string]$_.Auth; KeyFilePath=[string]$_.KeyFilePath; RemoteDir=[string]$_.RemoteDir;',
          '    HasSecret=($sec.Length -gt 0); Trusted=($fp.Length -gt 0)',
          '  }',
          '}',
        ].join('\n'),
      ),
    [],
  );

  const sites = useMemo(() => sitesState.data ?? [], [sitesState.data]);
  const trustedCount = useMemo(() => sites.filter((s) => s.Trusted).length, [sites]);

  // Live reachability probe per site host:port — Test-NetConnection is read-only.
  const [reach, setReach] = useState<Record<string, boolean | 'checking'>>({});
  const probe = useCallback(async (host: string, port: number, id: string) => {
    if (!host) return;
    setReach((r) => ({ ...r, [id]: 'checking' }));
    try {
      const rows = await runPowershellJson<{ Ok: boolean }>(
        `$r = Test-NetConnection -ComputerName '${psq(host)}' -Port ${port | 0} -WarningAction SilentlyContinue; [pscustomobject]@{ Ok = [bool]$r.TcpTestSucceeded }`,
      );
      const ok = rows[0]?.Ok === true;
      setReach((r) => ({ ...r, [id]: ok }));
    } catch {
      setReach((r) => ({ ...r, [id]: false }));
    }
  }, []);

  // ── Quickconnect bar (reachability check only; transfers require the desktop client) ──
  const [qcProto, setQcProto] = useState<'Sftp' | 'Ftp' | 'Ftps'>('Sftp');
  const [qcHost, setQcHost] = useState('');
  const [qcPort, setQcPort] = useState('22');
  const [qcUser, setQcUser] = useState('');
  const [qcResult, setQcResult] = useState<string | null>(null);
  const [qcBusy, setQcBusy] = useState(false);

  const quickCheck = async () => {
    if (!qcHost.trim()) {
      setQcResult(t('filezilla.qcNoHost'));
      return;
    }
    setQcBusy(true);
    setQcResult(t('filezilla.qcChecking'));
    const port = parseInt(qcPort, 10) || defaultPort(qcProto);
    try {
      const rows = await runPowershellJson<{ Ok: boolean }>(
        `$r = Test-NetConnection -ComputerName '${psq(qcHost.trim())}' -Port ${port} -WarningAction SilentlyContinue; [pscustomobject]@{ Ok = [bool]$r.TcpTestSucceeded }`,
      );
      const ok = rows[0]?.Ok === true;
      setQcResult(
        ok
          ? t('filezilla.qcReachable', { host: qcHost.trim(), port })
          : t('filezilla.qcUnreachable', { host: qcHost.trim(), port }),
      );
    } catch (e) {
      setQcResult(`${t('filezilla.qcFailed')}: ${String(e)}`);
    } finally {
      setQcBusy(false);
    }
  };

  // ── Local pane: a live, native local file browser via Get-ChildItem ───────────
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');

  const localState = useAsync(async () => {
    // On first run, resolve the user profile as the start directory (mirrors the C# UserProfile default).
    let dir = localDir;
    if (dir === null) {
      const home = await runPowershell('$env:USERPROFILE');
      dir = (home.stdout || '').trim() || 'C:\\';
      setLocalDir(dir);
      setPathInput(dir);
    }
    const rows = await runPowershellJson<LocalRow>(
      [
        `$dir = '${psq(dir)}';`,
        'if (-not (Test-Path -LiteralPath $dir)) { throw "No such folder: $dir" }',
        'Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |',
        '  Sort-Object @{E={ -not $_.PSIsContainer }}, Name |',
        '  ForEach-Object {',
        '    [pscustomobject]@{',
        '      Name=$_.Name; FullPath=$_.FullName; IsDir=[bool]$_.PSIsContainer;',
        '      Size=$(if ($_.PSIsContainer) { -1 } else { [long]$_.Length });',
        "      Modified=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')",
        '    }',
        '  }',
      ].join('\n'),
    );
    return { dir, rows };
  }, [localDir]);

  const goLocal = (dir: string) => {
    setMsg(null);
    setLocalDir(dir);
    setPathInput(dir);
  };

  const goUp = async () => {
    const cur = localState.data?.dir;
    if (!cur) return;
    const res = await runPowershell(`(Split-Path -Parent -LiteralPath '${psq(cur)}')`);
    const parent = (res.stdout || '').trim();
    if (parent && parent !== cur) goLocal(parent);
  };

  const submitPath = () => {
    const p = pathInput.trim();
    if (p) goLocal(p);
  };

  const makeFolder = async () => {
    const cur = localState.data?.dir;
    if (!cur) return;
    const name = window.prompt(t('filezilla.newFolderPrompt'));
    if (!name || !name.trim()) return;
    // Explicit user-initiated, confirmed create in the currently-browsed dir. Read/create only, never delete.
    if (!window.confirm(t('filezilla.newFolderConfirm', { name: name.trim(), dir: cur }))) return;
    setMsg(null);
    try {
      const res = await runPowershell(
        `New-Item -ItemType Directory -Path (Join-Path '${psq(cur)}' '${psq(name.trim())}') -ErrorAction Stop | Out-Null; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('filezilla.newFolderOk', { name: name.trim() }));
      localState.reload();
    } catch (e) {
      setMsg(`${t('filezilla.newFolderFail')}: ${String(e)}`);
    }
  };

  const localRows = localState.data?.rows ?? [];

  // ── Table columns ─────────────────────────────────────────────────────────────
  const siteColumns: Column<Site>[] = [
    { key: 'Name', header: t('filezilla.colName') },
    { key: 'Protocol', header: t('filezilla.colProtocol'), width: 80 },
    {
      key: 'Endpoint',
      header: t('filezilla.colEndpoint'),
      render: (s) => `${s.Host || dash}:${s.Port || defaultPort(s.Protocol)}`,
    },
    { key: 'User', header: t('filezilla.colUser'), render: (s) => s.User || dash },
    {
      key: 'Auth',
      header: t('filezilla.colAuth'),
      width: 110,
      render: (s) => (s.Auth === 'KeyFile' ? t('filezilla.authKey') : t('filezilla.authPassword')),
    },
    {
      key: 'Trust',
      header: t('filezilla.colTrust'),
      width: 130,
      render: (s) => <StatusDot ok={s.Trusted} label={s.Trusted ? t('filezilla.trusted') : t('filezilla.untrusted')} />,
    },
    {
      key: 'Reach',
      header: t('filezilla.colReach'),
      width: 150,
      render: (s) => {
        const r = reach[s.Id];
        return (
          <span className="row-actions">
            {r === 'checking' ? (
              <span className="count-note">{t('filezilla.qcChecking')}</span>
            ) : r === undefined ? (
              <button className="mini" disabled={!s.Host} onClick={() => probe(s.Host, s.Port || defaultPort(s.Protocol), s.Id)}>
                {t('filezilla.testReach')}
              </button>
            ) : (
              <StatusDot ok={r} label={r ? t('filezilla.reachable') : t('filezilla.unreachable')} />
            )}
          </span>
        );
      },
    },
  ];

  const localColumns: Column<LocalRow>[] = [
    {
      key: 'Name',
      header: t('filezilla.colName'),
      render: (r) =>
        r.IsDir ? (
          <button className="mini" style={{ textAlign: 'left' }} onClick={() => goLocal(r.FullPath)}>
            📁 {r.Name}
          </button>
        ) : (
          <span>📄 {r.Name}</span>
        ),
    },
    {
      key: 'Size',
      header: t('filezilla.colSize'),
      width: 100,
      align: 'right',
      render: (r) => fmtSize(r.Size, dash),
    },
    { key: 'Modified', header: t('filezilla.colModified'), width: 150 },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('filezilla.subtitle')}
      </p>

      {msg && <p className="mod-msg">{msg}</p>}

      {/* ── Quickconnect bar ─────────────────────────────────────────── */}
      <section>
        <h3>{t('filezilla.quickconnect')}</h3>
        <div className="mod-toolbar hosts-edit">
          <select value={qcProto} onChange={(e) => setQcProto(e.target.value as typeof qcProto)}>
            <option value="Sftp">SFTP</option>
            <option value="Ftp">FTP</option>
            <option value="Ftps">FTPS</option>
          </select>
          <input
            className="mod-search"
            placeholder={t('filezilla.host')}
            value={qcHost}
            onChange={(e) => setQcHost(e.target.value)}
          />
          <input
            style={{ width: 70 }}
            placeholder={t('filezilla.port')}
            value={qcPort}
            onChange={(e) => setQcPort(e.target.value.replace(/[^\d]/g, ''))}
          />
          <input
            className="mod-search"
            placeholder={t('filezilla.user')}
            value={qcUser}
            onChange={(e) => setQcUser(e.target.value)}
          />
          <button className="mini primary" disabled={qcBusy} onClick={quickCheck}>
            {t('filezilla.testConnection')}
          </button>
        </div>
        {qcResult && (
          <p className="count-note" style={{ marginTop: 4 }}>
            {qcResult}
          </p>
        )}
      </section>

      {/* ── Site Manager ─────────────────────────────────────────────── */}
      <section>
        <ModuleToolbar>
          <h3 style={{ margin: 0 }}>{t('filezilla.siteManager')}</h3>
          <button className="mini" onClick={sitesState.reload}>
            ⟳ {t('modules.refresh')}
          </button>
          <span className="count-note">
            {t('filezilla.siteCount', { sites: sites.length })} · {t('filezilla.trustedCount', { trusted: trustedCount })}
          </span>
        </ModuleToolbar>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('filezilla.storeNote')}
        </p>
        <AsyncState loading={sitesState.loading} error={sitesState.error}>
          <DataTable
            columns={siteColumns}
            rows={sites}
            rowKey={(s) => s.Id}
            empty={t('filezilla.noSites')}
          />
        </AsyncState>
      </section>

      {/* ── Local pane ───────────────────────────────────────────────── */}
      <section>
        <ModuleToolbar>
          <h3 style={{ margin: 0 }}>{t('filezilla.localPane')}</h3>
          <button className="mini" onClick={goUp}>
            ↑ {t('filezilla.up')}
          </button>
          <input
            className="mod-search"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPath();
            }}
            placeholder={t('filezilla.pathPlaceholder')}
          />
          <button className="mini" onClick={submitPath}>
            {t('filezilla.go')}
          </button>
          <button className="mini" onClick={makeFolder}>
            {t('filezilla.newFolder')}
          </button>
          <button className="mini" onClick={localState.reload}>
            ⟳ {t('modules.refresh')}
          </button>
        </ModuleToolbar>
        <p className="count-note" style={{ marginTop: 0 }}>
          {localState.data?.dir ?? dash} · {t('filezilla.itemCount', { items: localRows.length })}
        </p>
        <AsyncState loading={localState.loading} error={localState.error}>
          <DataTable
            columns={localColumns}
            rows={localRows}
            rowKey={(r) => r.FullPath}
            empty={t('filezilla.emptyFolder')}
          />
        </AsyncState>
      </section>

      {/* ── Protocols / help ─────────────────────────────────────────── */}
      <section>
        <h3>{t('filezilla.protocolsTitle')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('filezilla.protocolsBody')}
        </p>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('filezilla.securityBody')}
        </p>
      </section>
    </div>
  );
}
