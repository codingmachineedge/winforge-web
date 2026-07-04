import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — in-app Packet Capture wrapping Wireshark's CLI tools (dumpcap / tshark).
// The DependencyGate resolves tshark.exe; sibling binaries (dumpcap.exe, Wireshark.exe) live in
// the same install directory, so we derive them from the tshark path. dumpcap does the actual
// capture to a .pcapng file loss-free (bounded by a stop condition so the one-shot backend bridge can
// return), tshark reads/filters saved files, dissects a packet, gathers statistics, follows a TCP
// stream, and Wireshark.exe launches the GUI. Extra readiness probes (Npcap driver, elevation, version)
// and one-shot Operations run through PowerShell / the CLIs. Bilingual.

interface PacketRow {
  no: string;
  time: string;
  src: string;
  dst: string;
  proto: string;
  len: string;
  info: string;
}

interface Iface {
  id: string;
  device: string;
  friendly: string;
}

// The seven summary fields tshark emits, in grid order (tab-separated).
const FIELD_ARGS = [
  '-T', 'fields',
  '-e', 'frame.number',
  '-e', 'frame.time_relative',
  '-e', 'ip.src',
  '-e', 'ip.dst',
  '-e', '_ws.col.Protocol',
  '-e', 'frame.len',
  '-e', '_ws.col.Info',
  '-E', 'separator=/t',
  '-E', 'occurrence=f',
];

// Derive a sibling binary path (dumpcap.exe / Wireshark.exe) from the resolved tshark path.
function sibling(tsharkPath: string, exe: string): string {
  const idx = Math.max(tsharkPath.lastIndexOf('\\'), tsharkPath.lastIndexOf('/'));
  if (idx < 0) return exe;
  return tsharkPath.slice(0, idx + 1) + exe;
}

function formatTime(t: string): string {
  const d = Number.parseFloat(t);
  return Number.isFinite(d) ? d.toFixed(6) : t;
}

// Parse tshark tab-separated fields output into summary rows. Non-packet lines (no leading frame
// number) are skipped. Never throws.
function parseRows(text: string, limit = 50000): PacketRow[] {
  const rows: PacketRow[] = [];
  if (!text) return rows;
  const lines = text.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    if (rows.length >= limit) break;
    const line = raw;
    if (!line) continue;
    const p = line.split('\t');
    const first = (p[0] ?? '').trim();
    if (!/^\d+$/.test(first)) continue;
    const at = (i: number): string => (p[i] ?? '').trim();
    rows.push({
      no: at(0),
      time: formatTime(at(1)),
      src: at(2),
      dst: at(3),
      proto: at(4),
      len: at(5),
      info: at(6),
    });
  }
  return rows;
}

// Parse `tshark -D` output: "1. \Device\NPF_{GUID} (Ethernet)". Never throws.
function parseInterfaces(text: string): Iface[] {
  const list: Iface[] = [];
  if (!text) return list;
  const lines = text.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const dot = line.indexOf('.');
    if (dot <= 0) continue;
    const id = line.slice(0, dot).trim();
    if (!/^\d+$/.test(id)) continue;
    const rest = line.slice(dot + 1).trim();
    let friendly = '';
    let device = rest;
    const op = rest.lastIndexOf('(');
    const cl = rest.lastIndexOf(')');
    if (op >= 0 && cl > op) {
      friendly = rest.slice(op + 1, cl).trim();
      device = rest.slice(0, op).trim();
    }
    list.push({ id, device, friendly });
  }
  return list;
}

function outText(res: CommandOutput): string {
  return res.stdout || res.stderr || `(exit ${res.code})`;
}

export function WiresharkModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  type Tab = 'capture' | 'file' | 'detail' | 'stats' | 'ops';
  const [tab, setTab] = useState<Tab>('capture');

  // Readiness (Npcap driver / elevation). null = not yet probed.
  const [npcap, setNpcap] = useState<boolean | null>(null);
  const [elevated, setElevated] = useState<boolean | null>(null);

  // Capture tab
  const [ifaces, setIfaces] = useState<Iface[] | null>(null);
  const [ifaceId, setIfaceId] = useState('');
  const [outFile, setOutFile] = useState('');
  const [captureFilter, setCaptureFilter] = useState('');
  const [captDisplayFilter, setCaptDisplayFilter] = useState('');
  const [stopSec, setStopSec] = useState(10);
  const [stopPkt, setStopPkt] = useState(500);
  const [promiscuous, setPromiscuous] = useState(true);
  const [ring, setRing] = useState(false);
  const [ringFiles, setRingFiles] = useState(4);
  const [ringSizeKb, setRingSizeKb] = useState(2048);
  const [liveRows, setLiveRows] = useState<PacketRow[] | null>(null);

  // File tab
  const [openedFile, setOpenedFile] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [fileRows, setFileRows] = useState<PacketRow[] | null>(null);
  const [exportDest, setExportDest] = useState('');

  // Detail tab
  const [frameNo, setFrameNo] = useState(1);
  const [streamNo, setStreamNo] = useState(0);
  const [detail, setDetail] = useState('');

  // Stats tab
  const [stats, setStats] = useState('');

  // Operations tab
  const [opsOut, setOpsOut] = useState('');
  const [opIfaces, setOpIfaces] = useState<Iface[] | null>(null);

  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const defaultOut = () => {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `%TEMP%\\WinForge-${stamp}.pcapng`;
  };

  const run = async (program: string, args: string[]): Promise<CommandOutput> => {
    return runCommand(program, args);
  };

  // ── readiness probes (Npcap driver + elevation) ──────────────────────────────────
  // Mirror WiresharkService.IsNpcapInstalled / IsElevated with a cheap PowerShell 5.1 probe.
  const probeReadiness = async () => {
    setBusy('ready');
    setErr(null);
    try {
      const script =
        "$svc = (Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\npcap') -or " +
        "(Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\npf') -or " +
        "(Test-Path (Join-Path $env:SystemRoot 'System32\\Npcap'));" +
        "$adm = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
        ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);" +
        "Write-Output (\"npcap=$svc admin=$adm\")";
      const res = await runPowershell(script);
      const text = (res.stdout || '').toLowerCase();
      setNpcap(/npcap=true/.test(text));
      setElevated(/admin=true/.test(text));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const refreshInterfaces = async (tsharkPath: string) => {
    setBusy('ifaces');
    setErr(null);
    try {
      const res = await run(sibling(tsharkPath, 'dumpcap.exe'), ['-D']);
      let text = res.stdout;
      if (!text.trim()) {
        const alt = await run(tsharkPath, ['-D']);
        text = alt.stdout;
      }
      const list = parseInterfaces(text);
      setIfaces(list);
      const firstId = list[0]?.id ?? '';
      if (firstId && !ifaceId) setIfaceId(firstId);
      if (list.length === 0) setMsg(t('wireshark.noInterfaces'));
      // Probe Npcap / elevation on first interface refresh so the warning bars can surface.
      if (npcap === null || elevated === null) void probeReadiness();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setIfaces([]);
    } finally {
      setBusy('');
    }
  };

  const startCapture = async (tsharkPath: string) => {
    if (!ifaceId.trim()) {
      setMsg(t('wireshark.pickInterface'));
      return;
    }
    const file = (outFile.trim() || defaultOut()).trim();
    setOutFile(file);
    setBusy('capture');
    setErr(null);
    setMsg(t('wireshark.capturing'));
    try {
      // dumpcap does the real, loss-free capture to disk (matches the desktop pipeline). We bound it
      // with a stop condition (duration and/or packet count) so the one-shot bridge returns.
      const dumpcap = sibling(tsharkPath, 'dumpcap.exe');
      const args: string[] = ['-i', ifaceId.trim(), '-n', '-w', file];
      if (!promiscuous) args.push('-p');
      if (captureFilter.trim()) args.push('-f', captureFilter.trim());
      if (ring && ringFiles > 1 && ringSizeKb > 0) {
        args.push('-b', `files:${Math.max(2, Math.floor(ringFiles))}`);
        args.push('-b', `filesize:${Math.max(64, Math.floor(ringSizeKb))}`);
      }
      const sec = Math.max(1, Math.min(3600, stopSec || 1));
      args.push('-a', `duration:${sec}`);
      const pkt = Math.max(0, Math.min(1000000, stopPkt || 0));
      if (pkt > 0) args.push('-c', String(pkt));
      const res = await run(dumpcap, args);
      if (!res.success && !res.stdout.trim()) {
        setErr(outText(res));
        setLiveRows([]);
        return;
      }
      // Read the just-captured file back into the summary grid, applying the display filter.
      setOpenedFile(file);
      await loadFileRows(tsharkPath, file, captDisplayFilter.trim(), setLiveRows);
      setMsg(`${t('wireshark.savedTo')}: ${file}`);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setLiveRows([]);
    } finally {
      setBusy('');
    }
  };

  const loadFileRows = async (
    tsharkPath: string,
    file: string,
    displayFilter: string,
    setter: (rows: PacketRow[]) => void,
  ) => {
    if (!file.trim()) {
      setMsg(t('wireshark.openFirst'));
      return;
    }
    const args: string[] = ['-r', file, '-n'];
    if (displayFilter) args.push('-Y', displayFilter);
    args.push(...FIELD_ARGS);
    try {
      const res = await run(tsharkPath, args);
      if (!res.success && !res.stdout.trim()) {
        setErr(outText(res));
        setter([]);
        return;
      }
      setter(parseRows(res.stdout));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setter([]);
    }
  };

  const openFile = async (tsharkPath: string) => {
    if (!openedFile.trim()) {
      setMsg(t('wireshark.openFirst'));
      return;
    }
    setBusy('read');
    setErr(null);
    try {
      await loadFileRows(tsharkPath, openedFile.trim(), fileFilter.trim(), setFileRows);
    } finally {
      setBusy('');
    }
  };

  const exportFiltered = async (tsharkPath: string) => {
    if (!openedFile.trim()) {
      setMsg(t('wireshark.openFirst'));
      return;
    }
    if (!exportDest.trim()) {
      setMsg(t('wireshark.pickExport'));
      return;
    }
    setBusy('export');
    setErr(null);
    try {
      const args: string[] = ['-r', openedFile.trim()];
      if (fileFilter.trim()) args.push('-Y', fileFilter.trim());
      args.push('-w', exportDest.trim());
      const res = await run(tsharkPath, args);
      setMsg(
        res.success
          ? `${t('wireshark.exported')}: ${exportDest.trim()}`
          : outText(res),
      );
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const showDetail = async (tsharkPath: string) => {
    const file = openedFile.trim();
    if (!file) {
      setMsg(t('wireshark.openOrCapture'));
      return;
    }
    setBusy('detail');
    setErr(null);
    setDetail(t('wireshark.loading'));
    try {
      const n = Math.max(1, Math.floor(frameNo || 1));
      const res = await run(tsharkPath, [
        '-r', file, '-n', '-V', '-x', '-Y', `frame.number==${n}`,
      ]);
      const text = res.stdout.trim();
      setDetail(text || t('wireshark.noDetail'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setDetail(t('wireshark.noDetail'));
    } finally {
      setBusy('');
    }
  };

  const followStream = async (tsharkPath: string) => {
    const file = openedFile.trim();
    if (!file) {
      setMsg(t('wireshark.openOrCapture'));
      return;
    }
    setBusy('stream');
    setErr(null);
    setDetail(t('wireshark.loading'));
    try {
      const idx = Math.max(0, Math.floor(streamNo || 0));
      const res = await run(tsharkPath, [
        '-r', file, '-n', '-q', '-z', `follow,tcp,ascii,${idx}`,
      ]);
      const text = res.stdout.trim();
      setDetail(text || t('wireshark.noStream'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setDetail(t('wireshark.noStream'));
    } finally {
      setBusy('');
    }
  };

  const runStats = async (tsharkPath: string, zArgs: string[], kind: string) => {
    const file = openedFile.trim();
    if (!file) {
      setMsg(t('wireshark.openOrCapture'));
      return;
    }
    setBusy(kind);
    setErr(null);
    setStats(t('wireshark.computing'));
    try {
      const res = await run(tsharkPath, ['-r', file, '-n', '-q', ...zArgs]);
      const text = res.stdout.trim();
      setStats(text || t('wireshark.noStats'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setStats(t('wireshark.noStats'));
    } finally {
      setBusy('');
    }
  };

  const openInWireshark = async (tsharkPath: string) => {
    const file = openedFile.trim() || outFile.trim();
    if (!file) {
      setMsg(t('wireshark.openFirst'));
      return;
    }
    setErr(null);
    try {
      // Detached GUI launch; runCommand returns once spawned.
      await run(sibling(tsharkPath, 'Wireshark.exe'), ['-r', file]);
      setMsg(t('wireshark.openedGui'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  // ── Operations tab ────────────────────────────────────────────────────────────────
  const opVersion = async (tsharkPath: string) => {
    setBusy('opver');
    setErr(null);
    setOpsOut(t('wireshark.computing'));
    try {
      const res = await run(tsharkPath, ['-v']);
      setOpsOut(res.stdout.trim() || outText(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setOpsOut('');
    } finally {
      setBusy('');
    }
  };

  const opListInterfaces = async (tsharkPath: string) => {
    setBusy('opifaces');
    setErr(null);
    try {
      const res = await run(sibling(tsharkPath, 'dumpcap.exe'), ['-D']);
      let text = res.stdout;
      if (!text.trim()) text = (await run(tsharkPath, ['-D'])).stdout;
      const list = parseInterfaces(text);
      setOpIfaces(list);
      if (list.length === 0) setOpsOut(t('wireshark.noInterfaces'));
      else setOpsOut('');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setOpIfaces([]);
    } finally {
      setBusy('');
    }
  };

  const opOpenFolder = async () => {
    // Open %TEMP% (the default capture folder) in Explorer. Mutation-ish (launches a window) → click-gated.
    setBusy('opfolder');
    setErr(null);
    try {
      const res = await runPowershell('Start-Process explorer.exe -ArgumentList $env:TEMP; "ok"');
      setMsg(res.success ? t('wireshark.openedFolder') : outText(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const readinessPill = () => {
    if (npcap === null && elevated === null) return null;
    const items: { ok: boolean; warn?: boolean; label: string }[] = [
      { ok: !!npcap, label: npcap ? t('wireshark.npcapReady') : t('wireshark.npcapMissing') },
      { ok: !!elevated, warn: !elevated, label: elevated ? t('wireshark.elevated') : t('wireshark.standardUser') },
    ];
    return (
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {items.map((it) => (
          <span
            key={it.label}
            className="count-note"
            style={{
              margin: 0,
              padding: '2px 8px',
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 11,
              background: it.ok ? 'var(--ok-bg, rgba(0,160,0,.12))' : it.warn ? 'rgba(200,150,0,.15)' : 'rgba(200,0,0,.12)',
              color: it.ok ? 'var(--ok, #2a8a2a)' : it.warn ? '#b8860b' : 'var(--danger)',
            }}
          >
            {it.label}
          </span>
        ))}
      </div>
    );
  };

  const renderGrid = (rows: PacketRow[] | null, setFrame?: (n: number) => void) => {
    if (!rows) return null;
    if (rows.length === 0) return <p className="count-note">{t('wireshark.noPackets')}</p>;
    return (
      <div className="dt-wrap panel">
        <table className="dt">
          <thead>
            <tr>
              <th>{t('wireshark.colNo')}</th>
              <th>{t('wireshark.colTime')}</th>
              <th>{t('wireshark.colSrc')}</th>
              <th>{t('wireshark.colDst')}</th>
              <th>{t('wireshark.colProto')}</th>
              <th style={{ textAlign: 'right' }}>{t('wireshark.colLen')}</th>
              <th>{t('wireshark.colInfo')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.no}-${i}`}
                onClick={() => {
                  const n = Number.parseInt(r.no, 10);
                  if (setFrame && Number.isFinite(n)) setFrame(n);
                }}
                style={setFrame ? { cursor: 'pointer' } : undefined}
              >
                <td>{r.no}</td>
                <td style={{ fontFamily: 'monospace' }}>{r.time}</td>
                <td style={{ fontFamily: 'monospace' }}>{r.src || '—'}</td>
                <td style={{ fontFamily: 'monospace' }}>{r.dst || '—'}</td>
                <td>{r.proto}</td>
                <td style={{ textAlign: 'right' }}>{r.len}</td>
                <td>{r.info}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="count-note" style={{ marginTop: 8 }}>
          {t('wireshark.packets')}: {rows.length}
        </p>
      </div>
    );
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('wireshark.blurb')}</p>

      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('wireshark.desktopOnly')}</p>
      )}

      <DependencyGate tool="tshark" preferId="WiresharkFoundation.Wireshark" query="wireshark">
        {(tsharkPath) => (
          <>
            {/* Readiness warning bars (Npcap driver + capture privileges). */}
            {npcap === false && (
              <p className="count-note" style={{ color: '#b8860b', marginTop: 8 }}>
                ⚠ {t('wireshark.npcapWarn')}
              </p>
            )}
            {elevated === false && (
              <p className="count-note" style={{ color: '#b8860b', marginTop: 4 }}>
                ⚠ {t('wireshark.adminWarn')}
              </p>
            )}

            <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              <button className={`mini${tab === 'capture' ? ' primary' : ''}`} onClick={() => setTab('capture')}>{t('wireshark.tabCapture')}</button>
              <button className={`mini${tab === 'file' ? ' primary' : ''}`} onClick={() => setTab('file')}>{t('wireshark.tabFile')}</button>
              <button className={`mini${tab === 'detail' ? ' primary' : ''}`} onClick={() => setTab('detail')}>{t('wireshark.tabDetail')}</button>
              <button className={`mini${tab === 'stats' ? ' primary' : ''}`} onClick={() => setTab('stats')}>{t('wireshark.tabStats')}</button>
              <button className={`mini${tab === 'ops' ? ' primary' : ''}`} onClick={() => setTab('ops')}>{t('wireshark.tabOps')}</button>
            </div>

            {tab === 'capture' && (
              <div style={{ marginTop: 10 }}>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <button className="mini" disabled={busy === 'ifaces'} onClick={() => refreshInterfaces(tsharkPath)}>
                    {busy === 'ifaces' ? t('wireshark.listing') : t('wireshark.refreshInterfaces')}
                  </button>
                  <select className="mod-select" value={ifaceId} onChange={(e) => setIfaceId(e.target.value)}>
                    {(!ifaces || ifaces.length === 0) && <option value="">{t('wireshark.noInterfacesOpt')}</option>}
                    {ifaces?.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.id}. {i.friendly || i.device}
                      </option>
                    ))}
                  </select>
                </div>
                {readinessPill()}

                <div className="io-grid" style={{ marginTop: 10 }}>
                  <label className="label">{t('wireshark.outputFile')}</label>
                  <input className="mod-search" value={outFile} placeholder={defaultOut()} onChange={(e) => setOutFile(e.target.value)} />

                  <label className="label">{t('wireshark.captureFilter')}</label>
                  <input className="mod-search" value={captureFilter} placeholder="tcp port 443" onChange={(e) => setCaptureFilter(e.target.value)} />

                  <label className="label">{t('wireshark.displayFilter')}</label>
                  <input className="mod-search" value={captDisplayFilter} placeholder="http || dns" onChange={(e) => setCaptDisplayFilter(e.target.value)} />
                </div>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <label className="label">{t('wireshark.stopSec')}</label>
                  <input className="mod-search" type="number" min={1} max={3600} style={{ maxWidth: 90 }} value={stopSec} onChange={(e) => setStopSec(+e.target.value)} />
                  <label className="label">{t('wireshark.stopPkt')}</label>
                  <input className="mod-search" type="number" min={0} max={1000000} style={{ maxWidth: 100 }} value={stopPkt} onChange={(e) => setStopPkt(+e.target.value)} />
                  <label className="chk">
                    <input type="checkbox" checked={promiscuous} onChange={(e) => setPromiscuous(e.target.checked)} />
                    {t('wireshark.promiscuous')}
                  </label>
                </div>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <label className="chk">
                    <input type="checkbox" checked={ring} onChange={(e) => setRing(e.target.checked)} />
                    {t('wireshark.ringBuffer')}
                  </label>
                  <label className="label">{t('wireshark.ringFiles')}</label>
                  <input className="mod-search" type="number" min={2} disabled={!ring} style={{ maxWidth: 80 }} value={ringFiles} onChange={(e) => setRingFiles(+e.target.value)} />
                  <label className="label">{t('wireshark.ringSize')}</label>
                  <input className="mod-search" type="number" min={64} disabled={!ring} style={{ maxWidth: 100 }} value={ringSizeKb} onChange={(e) => setRingSizeKb(+e.target.value)} />
                </div>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <button className="mini primary" disabled={!!busy} onClick={() => startCapture(tsharkPath)}>
                    {busy === 'capture' ? t('wireshark.capturingBtn') : t('wireshark.start')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => { setLiveRows(null); setDetail(''); setMsg(null); }}>
                    {t('wireshark.clear')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => openInWireshark(tsharkPath)}>
                    {t('wireshark.openInWireshark')}
                  </button>
                </div>
                <p className="count-note" style={{ marginTop: 6 }}>{t('wireshark.captureNote')}</p>
                {renderGrid(liveRows)}
              </div>
            )}

            {tab === 'file' && (
              <div style={{ marginTop: 10 }}>
                <div className="io-grid">
                  <label className="label">{t('wireshark.savedFile')}</label>
                  <input className="mod-search" value={openedFile} placeholder="C:\\path\\to\\capture.pcapng" onChange={(e) => setOpenedFile(e.target.value)} />
                  <label className="label">{t('wireshark.displayFilter')}</label>
                  <input
                    className="mod-search"
                    value={fileFilter}
                    placeholder="ip.addr == 8.8.8.8"
                    onChange={(e) => setFileFilter(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && openFile(tsharkPath)}
                  />
                  <label className="label">{t('wireshark.exportDest')}</label>
                  <input className="mod-search" value={exportDest} placeholder="C:\\path\\to\\filtered.pcapng" onChange={(e) => setExportDest(e.target.value)} />
                </div>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <button className="mini primary" disabled={!!busy} onClick={() => openFile(tsharkPath)}>
                    {busy === 'read' ? t('wireshark.reading') : t('wireshark.readFile')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => exportFiltered(tsharkPath)}>
                    {busy === 'export' ? t('wireshark.exporting') : t('wireshark.exportFiltered')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => openInWireshark(tsharkPath)}>
                    {t('wireshark.openInWireshark')}
                  </button>
                </div>
                <p className="count-note" style={{ marginTop: 6 }}>{t('wireshark.fileNote')}</p>
                {renderGrid(fileRows, setFrameNo)}
              </div>
            )}

            {tab === 'detail' && (
              <div style={{ marginTop: 10 }}>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <label className="label">{t('wireshark.frameNo')}</label>
                  <input className="mod-search" type="number" min={1} style={{ maxWidth: 100 }} value={frameNo} onChange={(e) => setFrameNo(+e.target.value)} />
                  <button className="mini primary" disabled={!!busy} onClick={() => showDetail(tsharkPath)}>
                    {busy === 'detail' ? t('wireshark.loading') : t('wireshark.showDetail')}
                  </button>
                </div>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <label className="label">{t('wireshark.streamNo')}</label>
                  <input className="mod-search" type="number" min={0} style={{ maxWidth: 100 }} value={streamNo} onChange={(e) => setStreamNo(+e.target.value)} />
                  <button className="mini" disabled={!!busy} onClick={() => followStream(tsharkPath)}>
                    {busy === 'stream' ? t('wireshark.loading') : t('wireshark.followStream')}
                  </button>
                </div>
                <p className="count-note" style={{ marginTop: 6 }}>{t('wireshark.detailNote')}</p>
                {detail && <pre className="cmd-out">{detail}</pre>}
              </div>
            )}

            {tab === 'stats' && (
              <div style={{ marginTop: 10 }}>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <button className="mini primary" disabled={!!busy} onClick={() => runStats(tsharkPath, ['-z', 'io,phs'], 'phs')}>
                    {busy === 'phs' ? t('wireshark.computing') : t('wireshark.protoStats')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => runStats(tsharkPath, ['-z', 'conv,tcp'], 'conv')}>
                    {busy === 'conv' ? t('wireshark.computing') : t('wireshark.convStats')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => runStats(tsharkPath, ['-z', 'endpoints,ip'], 'ep')}>
                    {busy === 'ep' ? t('wireshark.computing') : t('wireshark.endpointStats')}
                  </button>
                </div>
                <p className="count-note" style={{ marginTop: 6 }}>{t('wireshark.statsNote')}</p>
                {stats && <pre className="cmd-out">{stats}</pre>}
              </div>
            )}

            {tab === 'ops' && (
              <div style={{ marginTop: 10 }}>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <button className="mini primary" disabled={!!busy} onClick={() => opVersion(tsharkPath)}>
                    {busy === 'opver' ? t('wireshark.computing') : t('wireshark.opVersion')}
                  </button>
                  <button className="mini" disabled={busy === 'ready'} onClick={() => probeReadiness()}>
                    {busy === 'ready' ? t('wireshark.computing') : t('wireshark.opCheckReady')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => opListInterfaces(tsharkPath)}>
                    {busy === 'opifaces' ? t('wireshark.listing') : t('wireshark.opListInterfaces')}
                  </button>
                  <button className="mini" disabled={!!busy} onClick={() => opOpenFolder()}>
                    {busy === 'opfolder' ? t('wireshark.computing') : t('wireshark.opOpenFolder')}
                  </button>
                </div>
                {readinessPill()}
                <p className="count-note" style={{ marginTop: 6 }}>{t('wireshark.opsNote')}</p>
                {opIfaces && (
                  opIfaces.length === 0
                    ? <p className="count-note">{t('wireshark.noInterfaces')}</p>
                    : (
                      <div className="dt-wrap panel">
                        <table className="dt">
                          <thead>
                            <tr>
                              <th>{t('wireshark.colNo')}</th>
                              <th>{t('wireshark.ifaceDevice')}</th>
                              <th>{t('wireshark.ifaceName')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {opIfaces.map((i) => (
                              <tr key={i.id}>
                                <td>{i.id}</td>
                                <td style={{ fontFamily: 'monospace' }}>{i.device || '—'}</td>
                                <td>{i.friendly || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                )}
                {opsOut && <pre className="cmd-out">{opsOut}</pre>}
              </div>
            )}

            {msg && <p className="count-note" style={{ marginTop: 8 }}>{msg}</p>}
            {err && <pre className="cmd-out error">{err}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
