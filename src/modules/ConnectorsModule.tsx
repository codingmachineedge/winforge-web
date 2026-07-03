import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

/**
 * Connectors · 連接器 — a live, read-only discovery of external-service connectors
 * configured on this machine: MCP servers (from Claude / Cursor / Windsurf / VS Code
 * configs), database DSNs (ODBC), and the system HTTP proxy. Mirrors the WinForge
 * desktop Connectors module (Kind / Endpoint / Enabled / Test) but reads real state.
 * Each connector's endpoint can be reachability-tested (Test-NetConnection — safe,
 * read-only). No secrets are read or displayed.
 */
interface Connector {
  Name: string;
  Kind: string;
  Endpoint: string;
  Source: string;
  Enabled: boolean;
}

// PowerShell that discovers connectors from real machine state and emits clean JSON.
const DISCOVER = String.raw`
$items = New-Object System.Collections.Generic.List[object]

function Add-Conn($name,$kind,$endpoint,$source,$enabled){
  $items.Add([pscustomobject]@{
    Name=[string]$name; Kind=[string]$kind; Endpoint=[string]$endpoint;
    Source=[string]$source; Enabled=[bool]$enabled })
}

# --- MCP servers from known client configs -------------------------------
$cfgs = @(
  @{ Path="$env:APPDATA\Claude\claude_desktop_config.json";                          Src='Claude' },
  @{ Path="$env:USERPROFILE\.cursor\mcp.json";                                       Src='Cursor' },
  @{ Path="$env:APPDATA\Cursor\User\globalStorage\cursor.mcp\mcp.json";              Src='Cursor' },
  @{ Path="$env:USERPROFILE\.codeium\windsurf\mcp_config.json";                      Src='Windsurf' },
  @{ Path="$env:APPDATA\Code\User\mcp.json";                                         Src='VS Code' },
  @{ Path="$env:USERPROFILE\.vscode\mcp.json";                                       Src='VS Code' }
)
foreach($c in $cfgs){
  if(-not (Test-Path -LiteralPath $c.Path)){ continue }
  try {
    $json = Get-Content -LiteralPath $c.Path -Raw -ErrorAction Stop | ConvertFrom-Json
    $root = if($json.mcpServers){ $json.mcpServers } elseif($json.servers){ $json.servers } else { $null }
    if($null -eq $root){ continue }
    foreach($p in $root.PSObject.Properties){
      $v = $p.Value
      $ep = if($v.url){ [string]$v.url }
            elseif($v.command){ (@([string]$v.command) + @($v.args)) -join ' ' }
            else { '' }
      $en = -not ($v.disabled -eq $true)
      Add-Conn $p.Name 'MCP Server' ($ep.Trim()) $c.Src $en
    }
  } catch {}
}

# --- Databases: ODBC data sources ----------------------------------------
try {
  foreach($d in (Get-OdbcDsn -ErrorAction SilentlyContinue)){
    $server = $d.Attribute['Server']; if(-not $server){ $server = $d.Attribute['SERVER'] }
    $db = $d.Attribute['Database']; if(-not $db){ $db = $d.Attribute['DATABASE'] }
    $ep = @($server,$db) | Where-Object { $_ } | ForEach-Object { [string]$_ }
    $epStr = if($ep){ ($ep -join ' / ') } else { [string]$d.DriverName }
    Add-Conn $d.Name 'Database' $epStr ("ODBC " + [string]$d.DsnType) $true
  }
} catch {}

# --- System HTTP proxy ----------------------------------------------------
try {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if($ie -and $ie.ProxyServer){
    Add-Conn 'Internet proxy' 'Proxy' ([string]$ie.ProxyServer) 'Internet Settings' ([bool]$ie.ProxyEnable)
  }
  $wh = netsh winhttp show proxy 2>$null | Out-String
  $m = [regex]::Match($wh,'Proxy Server\(s\)\s*:\s*(\S+)')
  if($m.Success){ Add-Conn 'WinHTTP proxy' 'Proxy' $m.Groups[1].Value 'WinHTTP' $true }
} catch {}

$items
`;

/** Pull a host:port (or bare host) out of a connector endpoint string. */
function hostPortOf(endpoint: string): { host: string; port: number | null } | null {
  const e = (endpoint || '').trim();
  if (!e) return null;
  // http(s)://host:port/... or ws(s)://host:port
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/\s:]+)(?::(\d+))?/i.exec(e);
  if (url && url[1]) {
    const scheme = e.slice(0, e.indexOf('://')).toLowerCase();
    const defPort = scheme === 'https' || scheme === 'wss' ? 443 : scheme === 'http' || scheme === 'ws' ? 80 : null;
    return { host: url[1], port: url[2] ? Number(url[2]) : defPort };
  }
  // host:port  (proxy style, or Server=host,port)
  const hp = /(?:^|[\s,=/])([A-Za-z0-9.-]+):(\d{1,5})(?:\b|$)/.exec(e);
  if (hp && hp[1] && hp[2]) return { host: hp[1], port: Number(hp[2]) };
  return null;
}

type TestState = 'ok' | 'fail' | 'unknown';

export function ConnectorsModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const { data, loading, error, reload } = useAsync(() => runPowershellJson<Connector>(DISCOVER), []);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const c of data ?? []) set.add(c.Kind);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return all
      .filter((c) => (kind ? c.Kind === kind : true))
      .filter((c) => (q ? `${c.Name} ${c.Endpoint} ${c.Source}`.toLowerCase().includes(q) : true))
      .sort((a, b) => a.Kind.localeCompare(b.Kind) || a.Name.localeCompare(b.Name));
  }, [data, filter, kind]);

  const keyOf = (c: Connector) => `${c.Source}::${c.Kind}::${c.Name}`;

  const test = async (c: Connector) => {
    const hp = hostPortOf(c.Endpoint);
    const id = keyOf(c);
    if (!hp) {
      setTests((m) => ({ ...m, [id]: 'unknown' }));
      setMsg(t('connectors.noEndpoint', { name: c.Name }));
      return;
    }
    setBusy(id);
    setMsg(null);
    try {
      const script = hp.port
        ? `(Test-NetConnection -ComputerName '${hp.host}' -Port ${hp.port} -WarningAction SilentlyContinue -InformationLevel Quiet)`
        : `(Test-Connection -ComputerName '${hp.host}' -Count 1 -Quiet -ErrorAction SilentlyContinue)`;
      const res = await runPowershellJson<boolean>(`[bool](${script})`);
      const ok = res[0] === true;
      setTests((m) => ({ ...m, [id]: ok ? 'ok' : 'fail' }));
      const where = hp.port ? `${hp.host}:${hp.port}` : hp.host;
      setMsg(ok ? t('connectors.reachable', { where }) : t('connectors.unreachable', { where }));
    } catch (e) {
      setTests((m) => ({ ...m, [id]: 'fail' }));
      setMsg(`${t('connectors.testFailed', { name: c.Name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<Connector>[] = [
    {
      key: 'Enabled',
      header: t('connectors.enabled'),
      width: 100,
      render: (c) => <StatusDot ok={c.Enabled} label={c.Enabled ? t('connectors.on') : t('connectors.off')} />,
    },
    { key: 'Name', header: t('connectors.name'), width: 180 },
    { key: 'Kind', header: t('connectors.kind'), width: 120 },
    {
      key: 'Endpoint',
      header: t('connectors.endpoint'),
      render: (c) => (
        <code style={{ fontFamily: 'var(--mono, Consolas, monospace)', fontSize: 12 }}>{c.Endpoint || '—'}</code>
      ),
    },
    { key: 'Source', header: t('connectors.source'), width: 130 },
    {
      key: 'actions',
      header: '',
      width: 150,
      render: (c) => {
        const id = keyOf(c);
        const st = tests[id];
        return (
          <span className="row-actions">
            <button className="mini" disabled={busy === id} onClick={() => test(c)}>
              {busy === id ? t('connectors.testing') : t('connectors.test')}
            </button>
            {st === 'ok' && <StatusDot ok label={t('connectors.up')} />}
            {st === 'fail' && <StatusDot ok={false} label={t('connectors.down')} />}
          </span>
        );
      },
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('connectors.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="mini" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('connectors.allKinds')}</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('connectors.count', { total: rows.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('connectors.blurb')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={keyOf} empty={t('connectors.empty')} />
      </AsyncState>
    </div>
  );
}
