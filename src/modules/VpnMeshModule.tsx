import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, runPowershellJson, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — in-app VPN & mesh control. Wraps three engines through the desktop backend:
//  • Tailscale  (tailscale.exe: up/down/status/ip/ping + exit-node picker + serve/funnel)
//  • Windows built-in VPN client (Get/Add/Remove-VpnConnection cmdlets + rasdial.exe)
//  • NordVPN    (NordVPN.exe CLI: -c / -d / -g + Meshnet verbs)
// The browser cannot touch these tools, so live actions run only inside the WinForge desktop app.

const TS_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const NORD_PATHS = ['C:\\Program Files\\NordVPN\\NordVPN.exe', 'C:\\Program Files (x86)\\NordVPN\\NordVPN.exe'];

const esc = (s: string) => (s ?? '').replace(/'/g, "''");

// ---- Windows VPN types ----
interface WinVpnRow {
  Name: string;
  ServerAddress: string;
  TunnelType: string;
  ConnectionStatus: string;
}

const TUNNEL_TYPES: { label: string; value: string }[] = [
  { label: 'Automatic', value: 'Automatic' },
  { label: 'IKEv2', value: 'Ikev2' },
  { label: 'L2TP/IPsec', value: 'L2tp' },
  { label: 'SSTP', value: 'Sstp' },
  { label: 'PPTP', value: 'Pptp' },
];

const NORD_COUNTRIES: { en: string; value: string }[] = [
  { en: '(Quick connect)', value: '' },
  { en: 'United States', value: 'United States' },
  { en: 'United Kingdom', value: 'United Kingdom' },
  { en: 'Canada', value: 'Canada' },
  { en: 'Germany', value: 'Germany' },
  { en: 'Japan', value: 'Japan' },
  { en: 'Australia', value: 'Australia' },
  { en: 'Netherlands', value: 'Netherlands' },
  { en: 'France', value: 'France' },
  { en: 'Singapore', value: 'Singapore' },
  { en: 'Switzerland', value: 'Switzerland' },
  { en: 'Hong Kong', value: 'Hong Kong' },
  { en: 'Taiwan', value: 'Taiwan' },
];

const NORD_GROUPS = ['P2P', 'Double_VPN', 'Onion_Over_VPN', 'Dedicated_IP', 'Obfuscated_Servers'];

type Tab = 'tailscale' | 'winvpn' | 'nord';

const outText = (r: CommandOutput): string =>
  (r.stdout && r.stdout.trim()) || (r.stderr && r.stderr.trim()) || `(exit ${r.code})`;

export function VpnMeshModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [tab, setTab] = useState<Tab>('tailscale');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('vpnmesh.blurb')}</p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('vpnmesh.desktopOnly')}</p>
      )}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className={`mini${tab === 'tailscale' ? ' primary' : ''}`} onClick={() => setTab('tailscale')}>
          {t('vpnmesh.tabTailscale')}
        </button>
        <button className={`mini${tab === 'winvpn' ? ' primary' : ''}`} onClick={() => setTab('winvpn')}>
          {t('vpnmesh.tabWinVpn')}
        </button>
        <button className={`mini${tab === 'nord' ? ' primary' : ''}`} onClick={() => setTab('nord')}>
          {t('vpnmesh.tabNord')}
        </button>
      </div>
      {tab === 'tailscale' && <TailscalePane desktop={desktop} />}
      {tab === 'winvpn' && <WinVpnPane desktop={desktop} />}
      {tab === 'nord' && <NordPane desktop={desktop} />}
    </div>
  );
}

// =========================================================================
// Tailscale
// =========================================================================

interface TsPeer {
  name: string;
  ip: string;
  online: boolean;
  self: boolean;
  exit: boolean;
}

function TailscalePane({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [peers, setPeers] = useState<TsPeer[] | null>(null);
  const [exitNode, setExitNode] = useState('');
  const [pingHost, setPingHost] = useState('');
  const [port, setPort] = useState(8080);
  const [console_, setConsole] = useState('');
  const [busy, setBusy] = useState('');

  // Run tailscale with args captured through PowerShell so we always get stdout+stderr.
  const cap = async (args: string): Promise<CommandOutput> => {
    const script = `& '${esc(TS_EXE)}' ${args} 2>&1 | Out-String -Width 400`;
    try {
      return await runPowershell(script);
    } catch (e) {
      return { stdout: '', stderr: String(e instanceof Error ? e.message : e), code: -1, success: false };
    }
  };

  const runVerb = async (label: string, args: string) => {
    if (!desktop) return;
    setBusy(label);
    try {
      const r = await cap(args);
      setConsole(outText(r));
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    if (!desktop) return;
    setBusy('status');
    try {
      const statusR = await cap('status');
      setConsole(outText(statusR));
      // Parse the JSON device list.
      const jsonR = await cap('status --json');
      const raw = jsonR.stdout || '';
      const brace = raw.indexOf('{');
      const list: TsPeer[] = [];
      if (brace >= 0) {
        try {
          const doc = JSON.parse(raw.slice(brace)) as {
            Self?: unknown;
            Peer?: Record<string, unknown>;
          };
          const addPeer = (e: unknown, self: boolean) => {
            if (!e || typeof e !== 'object') return;
            const o = e as Record<string, unknown>;
            let name = typeof o.HostName === 'string' ? o.HostName : '';
            if (!name && typeof o.DNSName === 'string') name = o.DNSName.replace(/\.$/, '');
            let ip = '';
            const ips = o.TailscaleIPs;
            if (Array.isArray(ips) && ips.length > 0 && typeof ips[0] === 'string') ip = ips[0];
            const online = self || o.Online === true;
            const exit = o.ExitNodeOption === true;
            if (name.length > 0 || ip.length > 0) list.push({ name, ip, online, self, exit });
          };
          if (doc.Self) addPeer(doc.Self, true);
          if (doc.Peer && typeof doc.Peer === 'object') {
            for (const key of Object.keys(doc.Peer)) addPeer(doc.Peer[key], false);
          }
        } catch {
          /* leave list empty on parse failure */
        }
      }
      setPeers(list);
    } finally {
      setBusy('');
    }
  };

  const setExit = async () => {
    if (!desktop) return;
    const target = exitNode.includes('·') ? exitNode.slice(exitNode.lastIndexOf('·') + 1).trim() : exitNode.trim();
    if (!target) return;
    setBusy('exit');
    try {
      const r = await cap(`set --exit-node=${target} --exit-node-allow-lan-access`);
      setConsole(r.success ? t('vpnmesh.tsExitSet', { node: target }) : outText(r));
    } finally {
      setBusy('');
    }
  };

  const clearExit = async () => {
    if (!desktop) return;
    setBusy('exit');
    try {
      const r = await cap('set --exit-node=');
      setConsole(r.success ? t('vpnmesh.tsExitCleared') : outText(r));
    } finally {
      setBusy('');
    }
  };

  const clampPort = () => Math.max(1, Math.min(65535, Math.floor(port) || 0));

  const serve = async () => {
    if (!desktop) return;
    setBusy('serve');
    try {
      const p = clampPort();
      const r = await cap(`serve --bg ${p}`);
      setConsole(r.success ? t('vpnmesh.tsServing', { port: p }) : outText(r));
    } finally {
      setBusy('');
    }
  };

  const funnel = async () => {
    if (!desktop) return;
    setBusy('funnel');
    try {
      const p = clampPort();
      const r = await cap(`funnel --bg ${p}`);
      setConsole(r.success ? t('vpnmesh.tsFunnelling', { port: p }) : outText(r));
    } finally {
      setBusy('');
    }
  };

  const exitOptions = peers?.filter((p) => p.exit && !p.self) ?? [];

  return (
    <div className="panel">
      <p className="count-note" style={{ marginTop: 0 }}>{t('vpnmesh.tsBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!desktop || !!busy} onClick={() => runVerb('up', 'up')}>
          {busy === 'up' ? t('vpnmesh.working') : t('vpnmesh.tsUp')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runVerb('down', 'down')}>
          {busy === 'down' ? t('vpnmesh.working') : t('vpnmesh.tsDown')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={refresh}>
          {busy === 'status' ? t('vpnmesh.working') : t('vpnmesh.tsStatus')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runVerb('ip', 'ip -4')}>
          {t('vpnmesh.tsMyIp')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 220 }}
          placeholder={t('vpnmesh.tsPingPlaceholder')}
          value={pingHost}
          onChange={(e) => setPingHost(e.target.value)}
        />
        <button
          className="mini"
          disabled={!desktop || !!busy || !pingHost.trim()}
          onClick={() => runVerb('ping', `ping ${pingHost.trim()}`)}
        >
          {busy === 'ping' ? t('vpnmesh.working') : t('vpnmesh.tsPing')}
        </button>
      </div>

      {peers && peers.length > 0 && (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th />
                <th>{t('vpnmesh.colName')}</th>
                <th>{t('vpnmesh.colIp')}</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p, i) => (
                <tr key={`${p.name}-${p.ip}-${i}`}>
                  <td>
                    <span style={{ color: p.online ? 'var(--ok, #2e7d32)' : 'var(--muted, gray)' }}>●</span>
                  </td>
                  <td>{p.self ? t('vpnmesh.thisPc', { name: p.name }) : p.name}</td>
                  <td style={{ fontFamily: 'monospace' }}>{p.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {peers && peers.length === 0 && <p className="count-note">{t('vpnmesh.tsNoPeers')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="label">{t('vpnmesh.tsExitNode')}</label>
        <select className="mod-select" value={exitNode} onChange={(e) => setExitNode(e.target.value)}>
          <option value="">{t('vpnmesh.tsExitNodePick')}</option>
          {exitOptions.map((p, i) => {
            const val = p.ip ? `${p.name} · ${p.ip}` : p.name;
            return (
              <option key={`${val}-${i}`} value={val}>
                {val}
              </option>
            );
          })}
        </select>
        <button className="mini" disabled={!desktop || !!busy || !exitNode} onClick={setExit}>
          {t('vpnmesh.tsUseExit')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={clearExit}>
          {t('vpnmesh.tsClearExit')}
        </button>
      </div>

      <p className="count-note" style={{ marginBottom: 4 }}>{t('vpnmesh.tsShareBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="label">{t('vpnmesh.tsPort')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          max={65535}
          style={{ maxWidth: 100 }}
          value={port}
          onChange={(e) => setPort(+e.target.value)}
        />
        <button className="mini" disabled={!desktop || !!busy} onClick={serve}>
          {busy === 'serve' ? t('vpnmesh.working') : t('vpnmesh.tsServe')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={funnel}>
          {busy === 'funnel' ? t('vpnmesh.working') : t('vpnmesh.tsFunnel')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runVerb('serveStatus', 'serve status')}>
          {t('vpnmesh.tsShareStatus')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runVerb('serveReset', 'serve reset')}>
          {t('vpnmesh.tsStopServe')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runVerb('funnelReset', 'funnel reset')}>
          {t('vpnmesh.tsStopFunnel')}
        </button>
      </div>

      {console_ && <pre className="cmd-out">{console_}</pre>}
      <p className="count-note">{t('vpnmesh.tsNote')}</p>
    </div>
  );
}

// =========================================================================
// Windows built-in VPN client
// =========================================================================

function WinVpnPane({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<WinVpnRow[] | null>(null);
  const [name, setName] = useState('');
  const [server, setServer] = useState('');
  const [tunnel, setTunnel] = useState('Automatic');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const notify = (text: string, isErr: boolean) => {
    setMsg(text);
    setErr(isErr);
  };

  const refresh = async () => {
    if (!desktop) return;
    setBusy(true);
    try {
      const script =
        "Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue | " +
        "Select-Object Name,ServerAddress,TunnelType,ConnectionStatus; " +
        "Get-VpnConnection -ErrorAction SilentlyContinue | " +
        "Select-Object Name,ServerAddress,TunnelType,ConnectionStatus";
      const list = await runPowershellJson<WinVpnRow>(script);
      // De-dupe by name (all-user + per-user lists overlap).
      const seen = new Set<string>();
      const deduped: WinVpnRow[] = [];
      for (const r of list) {
        const n = r && typeof r.Name === 'string' ? r.Name : '';
        if (!n || seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        deduped.push({
          Name: n,
          ServerAddress: typeof r.ServerAddress === 'string' ? r.ServerAddress : '',
          TunnelType: typeof r.TunnelType === 'string' ? r.TunnelType : '',
          ConnectionStatus: typeof r.ConnectionStatus === 'string' ? r.ConnectionStatus : '',
        });
      }
      setRows(deduped);
    } catch (e) {
      setRows([]);
      notify(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!desktop) return;
    const n = name.trim();
    const s = server.trim();
    if (!n || !s) {
      notify(t('vpnmesh.winMissing'), true);
      return;
    }
    setBusy(true);
    try {
      const script =
        `Add-VpnConnection -Name '${esc(n)}' -ServerAddress '${esc(s)}' -TunnelType '${esc(tunnel)}' ` +
        `-AuthenticationMethod MSChapv2 -EncryptionLevel Optional -RememberCredential ` +
        `-Force -PassThru -ErrorAction Stop | Out-Null`;
      const r = await runPowershell(script);
      if (r.success) {
        notify(t('vpnmesh.winAdded'), false);
        setName('');
        setServer('');
        await refresh();
      } else {
        notify(outText(r), true);
      }
    } catch (e) {
      notify(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  const connect = async (profile: string) => {
    if (!desktop) return;
    setBusy(true);
    try {
      const r = await runCommand('rasdial.exe', [profile]);
      notify(r.success ? t('vpnmesh.winConnected', { name: profile }) : outText(r), !r.success);
      await refresh();
    } catch (e) {
      notify(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (profile: string) => {
    if (!desktop) return;
    setBusy(true);
    try {
      const r = await runCommand('rasdial.exe', [profile, '/disconnect']);
      notify(r.success ? t('vpnmesh.winDisconnected', { name: profile }) : outText(r), !r.success);
      await refresh();
    } catch (e) {
      notify(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: string) => {
    if (!desktop) return;
    setBusy(true);
    try {
      const r = await runPowershell(`Remove-VpnConnection -Name '${esc(profile)}' -Force -ErrorAction Stop`);
      notify(r.success ? t('vpnmesh.winRemoved', { name: profile }) : outText(r), !r.success);
      await refresh();
    } catch (e) {
      notify(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <p className="count-note" style={{ marginTop: 0 }}>{t('vpnmesh.winBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 180 }}
          placeholder={t('vpnmesh.winName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="mod-search"
          style={{ maxWidth: 220 }}
          placeholder={t('vpnmesh.winServer')}
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
        <select className="mod-select" value={tunnel} onChange={(e) => setTunnel(e.target.value)}>
          {TUNNEL_TYPES.map((tt) => (
            <option key={tt.value} value={tt.value}>
              {tt.label}
            </option>
          ))}
        </select>
        <button className="mini primary" disabled={!desktop || busy} onClick={add}>
          {t('vpnmesh.winAdd')}
        </button>
        <button className="mini" disabled={!desktop || busy} onClick={refresh}>
          {busy ? t('vpnmesh.working') : t('vpnmesh.refresh')}
        </button>
      </div>

      {msg && <pre className={`cmd-out${err ? ' error' : ''}`}>{msg}</pre>}

      {rows && rows.length > 0 && (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th />
                <th>{t('vpnmesh.colName')}</th>
                <th>{t('vpnmesh.colDetail')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const connected = r.ConnectionStatus.toLowerCase() === 'connected';
                return (
                  <tr key={`${r.Name}-${i}`}>
                    <td>
                      <span style={{ color: connected ? 'var(--ok, #2e7d32)' : 'var(--muted, gray)' }}>●</span>
                    </td>
                    <td>{r.Name}</td>
                    <td className="count-note">
                      {[r.TunnelType, r.ServerAddress, r.ConnectionStatus].filter(Boolean).join('  ·  ')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="mini" disabled={!desktop || busy} onClick={() => connect(r.Name)}>
                        {t('vpnmesh.connect')}
                      </button>{' '}
                      <button className="mini" disabled={!desktop || busy} onClick={() => disconnect(r.Name)}>
                        {t('vpnmesh.disconnect')}
                      </button>{' '}
                      <button className="mini" disabled={!desktop || busy} onClick={() => remove(r.Name)}>
                        {t('vpnmesh.remove')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && <p className="count-note">{t('vpnmesh.winEmpty')}</p>}
      <p className="count-note">{t('vpnmesh.winNote')}</p>
    </div>
  );
}

// =========================================================================
// NordVPN
// =========================================================================

function NordPane({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const [country, setCountry] = useState('');
  const [group, setGroup] = useState(NORD_GROUPS[0] ?? 'P2P');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState('');

  // Resolve the NordVPN exe path inside PowerShell and run it, capturing all output.
  const runNord = async (label: string, args: string) => {
    if (!desktop) return;
    setBusy(label);
    try {
      const candidates = NORD_PATHS.map((p) => `'${esc(p)}'`).join(',');
      const script =
        `$exe=@(${candidates}) | Where-Object { Test-Path $_ } | Select-Object -First 1; ` +
        `if(-not $exe){ 'NordVPN not found.' } else { & $exe ${args} 2>&1 | Out-String -Width 400 }`;
      const r = await runPowershell(script);
      setOut(outText(r));
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const connect = () => {
    const c = NORD_COUNTRIES.find((x) => x.value === country);
    const name = c && c.value ? c.value : '';
    runNord('connect', name ? `-c -n "${name}"` : '-c');
  };

  return (
    <div className="panel">
      <p className="count-note" style={{ marginTop: 0 }}>{t('vpnmesh.nordBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="label">{t('vpnmesh.nordCountry')}</label>
        <select className="mod-select" value={country} onChange={(e) => setCountry(e.target.value)}>
          {NORD_COUNTRIES.map((c) => (
            <option key={c.en} value={c.value}>
              {c.en}
            </option>
          ))}
        </select>
        <button className="mini primary" disabled={!desktop || !!busy} onClick={connect}>
          {busy === 'connect' ? t('vpnmesh.working') : t('vpnmesh.connect')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runNord('disconnect', '-d')}>
          {t('vpnmesh.disconnect')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="label">{t('vpnmesh.nordGroup')}</label>
        <select className="mod-select" value={group} onChange={(e) => setGroup(e.target.value)}>
          {NORD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runNord('group', `-c -g ${group}`)}>
          {t('vpnmesh.nordConnectGroup')}
        </button>
      </div>

      <p className="count-note" style={{ marginBottom: 4 }}>{t('vpnmesh.nordMeshBlurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runNord('meshOn', 'set meshnet on')}>
          {t('vpnmesh.nordMeshOn')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runNord('meshOff', 'set meshnet off')}>
          {t('vpnmesh.nordMeshOff')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => runNord('peers', 'meshnet peer list')}>
          {t('vpnmesh.nordMeshPeers')}
        </button>
      </div>

      {out && <pre className="cmd-out">{out}</pre>}
      <p className="count-note">{t('vpnmesh.nordNote')}</p>
    </div>
  );
}
