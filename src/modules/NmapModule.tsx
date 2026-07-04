import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// ============================================================================
// Nmap Scanner — full port of WinForge NmapModule + NmapService + NmapOperations.
// Enter target(s), pick a scan profile, toggle common flags, add raw flags, see a
// read-only command preview, run the real nmap.exe (via runCommand by name) with
// `-oX -`, parse the XML into a hosts / ports / services table, watch the live log,
// save the raw XML or a flattened CSV, keep a scan history + named profiles in
// localStorage, and run one-shot Nmap helper tools (version / help / iflist / …).
// Scans and every helper run ONLY on an explicit click. Bilingual via i18n.
// ============================================================================

// ---- scan profiles (mirror NmapService.Profiles) --------------------------
interface Profile {
  key: string;
  flags: string;
  needsAdmin?: boolean;
}
const PROFILES: Profile[] = [
  { key: 'ping', flags: '-sn' },
  { key: 'quick', flags: '-T4 -F' },
  { key: 'quickv', flags: '-T4 -F -sV' },
  { key: 'intense', flags: '-T4 -A -v', needsAdmin: true },
  { key: 'full', flags: '-p- -T4' },
  { key: 'service', flags: '-sV' },
  { key: 'os', flags: '-O', needsAdmin: true },
  { key: 'scripts', flags: '-sC' },
  { key: 'udp', flags: '-sU -T4', needsAdmin: true },
  { key: 'custom', flags: '' },
];
function profileByKey(key: string): Profile {
  return PROFILES.find((p) => p.key === key) ?? PROFILES[1]!;
}

// ---- common flag toggles (mirror NmapService.CommonFlags) ------------------
interface FlagOption {
  flag: string;
  i18n: string;
  needsAdmin?: boolean;
}
const COMMON_FLAGS: FlagOption[] = [
  { flag: '-sV', i18n: 'flagSV' },
  { flag: '-O', i18n: 'flagO', needsAdmin: true },
  { flag: '-sC', i18n: 'flagSC' },
  { flag: '-Pn', i18n: 'flagPn' },
  { flag: '-A', i18n: 'flagA', needsAdmin: true },
  { flag: '-T4', i18n: 'flagT4' },
  { flag: '-sU', i18n: 'flagSU', needsAdmin: true },
];
const ADMIN_FLAGS = new Set(COMMON_FLAGS.filter((f) => f.needsAdmin).map((f) => f.flag));

// ---- timing templates -0..-5 (extra surface the raw box also allows) -------
const TIMING = ['-T0', '-T1', '-T2', '-T3', '-T4', '-T5'];

// ---- parsed result shapes --------------------------------------------------
interface NmapPort {
  hostAddress: string;
  hostName: string;
  port: number;
  protocol: string;
  state: string;
  service: string;
  version: string;
}
interface NmapHost {
  address: string;
  addrType: string;
  hostname: string;
  status: string;
  vendor: string;
  os: string;
  osAccuracy: number;
  latency: string;
  ports: NmapPort[];
}
interface ScanResult {
  hosts: NmapHost[];
  rawXml: string;
  command: string;
  summary: string;
  error: string;
  ok: boolean;
}

// ---- helper tools (mirror NmapOperations.All) ------------------------------
interface ToolOp {
  id: string;
  args: string[]; // args for runCommand(nmap, args)
}
const TOOLS: ToolOp[] = [
  { id: 'version', args: ['--version'] },
  { id: 'help', args: ['-h'] },
  { id: 'localhost', args: ['-T4', '-F', '127.0.0.1'] },
  { id: 'scripts', args: ['--script-help', 'all'] },
  { id: 'iflist', args: ['--iflist'] },
];

// ---- localStorage keys -----------------------------------------------------
const LS_HISTORY = 'winforge.nmap.history';
const LS_PROFILES = 'winforge.nmap.profiles';

interface SavedProfile {
  name: string;
  profile: string;
  flags: string[];
  extra: string;
  target: string;
}
interface HistoryEntry {
  ts: number;
  command: string;
  target: string;
  summary: string;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — ignore */
  }
}

// ---- target validation (mirror NmapService.IsValidTarget) ------------------
function isValidTarget(target: string): boolean {
  const t = target.trim();
  if (!t) return false;
  if (t.length > 4000) return false;
  if (/["'`|&;<>^%\r\n]/.test(t)) return false;
  for (const tok of t.split(/[\s,\t]+/).filter(Boolean)) {
    if (!/^[A-Za-z0-9_.:/*-]+$/.test(tok)) return false;
  }
  return true;
}

// ---- build the ordered nmap arg list (mirror NmapService.BuildArgs) --------
function buildArgs(profileKey: string, flags: string[], extraText: string, target: string): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const f = raw.trim();
    if (!f) return;
    const lower = f.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      args.push(f);
    }
  };
  for (const f of profileByKey(profileKey).flags.split(/\s+/).filter(Boolean)) add(f);
  for (const f of flags) add(f);
  for (const tok of extraText.split(/\s+/).filter(Boolean)) add(tok);
  // machine-readable XML on stdout — always
  args.push('-oX', '-');
  for (const tok of target.split(/[\s,\t]+/).filter(Boolean)) args.push(tok);
  return args;
}

function previewCommand(args: string[]): string {
  let s = 'nmap';
  for (const a of args) s += ' ' + (a.includes(' ') ? `"${a}"` : a);
  return s;
}

function needsAdmin(profileKey: string, flags: string[]): boolean {
  if (profileByKey(profileKey).needsAdmin) return true;
  return flags.some((f) => ADMIN_FLAGS.has(f));
}

// ---- parse the -oX XML (mirror NmapService.Parse) --------------------------
function parseXml(xml: string): ScanResult {
  const result: ScanResult = {
    hosts: [],
    rawXml: xml,
    command: '',
    summary: '',
    error: '',
    ok: false,
  };
  if (!xml.trim()) return result;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return result;
  }
  const run = doc.querySelector('nmaprun');
  if (!run) return result;

  for (const hostEl of Array.from(run.querySelectorAll(':scope > host'))) {
    const host: NmapHost = {
      address: '',
      addrType: '',
      hostname: '',
      status: '',
      vendor: '',
      os: '',
      osAccuracy: 0,
      latency: '',
      ports: [],
    };
    host.status = hostEl.querySelector(':scope > status')?.getAttribute('state') ?? '';

    for (const addr of Array.from(hostEl.querySelectorAll(':scope > address'))) {
      const type = addr.getAttribute('addrtype') ?? '';
      const val = addr.getAttribute('addr') ?? '';
      if (type === 'ipv4' || type === 'ipv6') {
        if (!host.address) {
          host.address = val;
          host.addrType = type;
        }
      } else if (type === 'mac') {
        if (!host.address) {
          host.address = val;
          host.addrType = type;
        }
        host.vendor = addr.getAttribute('vendor') ?? '';
      }
    }

    host.hostname =
      hostEl.querySelector(':scope > hostnames > hostname')?.getAttribute('name') ?? '';

    const srtt = hostEl.querySelector(':scope > times')?.getAttribute('srtt');
    if (srtt) {
      const us = Number(srtt);
      if (!Number.isNaN(us)) host.latency = `${(us / 1000).toFixed(1)} ms`;
    }

    const osMatch = hostEl.querySelector(':scope > os > osmatch');
    if (osMatch) {
      host.os = osMatch.getAttribute('name') ?? '';
      const acc = parseInt(osMatch.getAttribute('accuracy') ?? '', 10);
      if (!Number.isNaN(acc)) host.osAccuracy = acc;
    }

    for (const portEl of Array.from(hostEl.querySelectorAll(':scope > ports > port'))) {
      const stateEl = portEl.querySelector(':scope > state');
      const svcEl = portEl.querySelector(':scope > service');
      const port: NmapPort = {
        hostAddress: host.address,
        hostName: host.hostname,
        port: parseInt(portEl.getAttribute('portid') ?? '0', 10) || 0,
        protocol: portEl.getAttribute('protocol') ?? '',
        state: stateEl?.getAttribute('state') ?? '',
        service: svcEl?.getAttribute('name') ?? '',
        version: '',
      };
      const parts: string[] = [];
      const prod = svcEl?.getAttribute('product');
      const ver = svcEl?.getAttribute('version');
      const extra = svcEl?.getAttribute('extrainfo');
      if (prod) parts.push(prod);
      if (ver) parts.push(ver);
      if (extra) parts.push(`(${extra})`);
      port.version = parts.join(' ');
      host.ports.push(port);
    }

    result.hosts.push(host);
  }

  const stats = run.querySelector(':scope > runstats');
  const hostsEl = stats?.querySelector(':scope > hosts');
  const up = hostsEl?.getAttribute('up') ?? '?';
  const total = hostsEl?.getAttribute('total') ?? '?';
  const elapsed = stats?.querySelector(':scope > finished')?.getAttribute('elapsed');
  result.summary = elapsed
    ? `${up}/${total} hosts up · ${elapsed}s`
    : `${up}/${total} hosts up`;
  result.ok = result.hosts.length > 0 || xml.includes('<nmaprun');
  return result;
}

// flatten hosts → grid rows (mirror FillResults: real ports + synthetic host-only rows)
function flattenRows(result: ScanResult): NmapPort[] {
  const rows: NmapPort[] = [];
  for (const h of result.hosts) for (const p of h.ports) rows.push(p);
  for (const h of result.hosts) {
    if (h.ports.length === 0 && h.status === 'up') {
      rows.push({
        hostAddress: h.address,
        hostName: h.hostname,
        port: 0,
        protocol: '',
        state: 'up',
        service: h.os ? '' : h.vendor || '',
        version: h.os ? `${h.os} (${h.osAccuracy}%)` : h.latency,
      });
    }
  }
  rows.sort((a, b) =>
    a.hostAddress < b.hostAddress ? -1 : a.hostAddress > b.hostAddress ? 1 : a.port - b.port,
  );
  return rows;
}

// ---- CSV export (mirror NmapService.ToCsv) ---------------------------------
function csvCell(s: string): string {
  const v = s ?? '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(result: ScanResult): string {
  const lines = ['Host,Address,Port,Protocol,State,Service,Version,OS'];
  for (const h of result.hosts) {
    if (h.ports.length === 0) {
      lines.push(
        [csvCell(h.hostname), csvCell(h.address), '', '', csvCell(h.status), '', '', csvCell(h.os)].join(
          ',',
        ),
      );
      continue;
    }
    for (const p of h.ports) {
      lines.push(
        [
          csvCell(h.hostname),
          csvCell(h.address),
          String(p.port),
          csvCell(p.protocol),
          csvCell(p.state),
          csvCell(p.service),
          csvCell(p.version),
          csvCell(h.os),
        ].join(','),
      );
    }
  }
  return lines.join('\n');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ===========================================================================
export function NmapModule() {
  const { t } = useTranslation();
  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('nmap.blurb')}
      </p>
      <DependencyGate tool="nmap" preferId="Insecure.Nmap" query="nmap">
        {(path) => <NmapInner nmapPath={path} />}
      </DependencyGate>
    </div>
  );
}

function NmapInner({ nmapPath }: { nmapPath: string }) {
  const { t } = useTranslation();

  // scan state
  const [target, setTarget] = useState('scanme.nmap.org');
  const [profile, setProfile] = useState('quick');
  const [flags, setFlags] = useState<string[]>([]);
  const [timing, setTiming] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [cancelReq, setCancelReq] = useState(false);

  // persisted state
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadJson<HistoryEntry[]>(LS_HISTORY, []));
  const [saved, setSaved] = useState<SavedProfile[]>(() => loadJson<SavedProfile[]>(LS_PROFILES, []));

  useEffect(() => saveJson(LS_HISTORY, history), [history]);
  useEffect(() => saveJson(LS_PROFILES, saved), [saved]);

  const toggleFlag = (f: string) =>
    setFlags((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  // effective flag set = toggles + chosen timing template (deduped in buildArgs)
  const effectiveFlags = useMemo(() => (timing ? [...flags, timing] : flags), [flags, timing]);

  const args = useMemo(
    () => buildArgs(profile, effectiveFlags, extra, target.trim() || '<target>'),
    [profile, effectiveFlags, extra, target],
  );
  const preview = useMemo(() => previewCommand(args), [args]);
  const admin = useMemo(() => needsAdmin(profile, effectiveFlags), [profile, effectiveFlags]);

  const rows = useMemo(() => (result ? flattenRows(result) : []), [result]);
  const openPorts = useMemo(
    () => (result ? result.hosts.reduce((n, h) => n + h.ports.filter((p) => p.state === 'open').length, 0) : 0),
    [result],
  );
  const hostsUp = useMemo(
    () => (result ? result.hosts.filter((h) => h.status === 'up').length : 0),
    [result],
  );

  const appendLog = useCallback((line: string) => {
    setLog((cur) => {
      let next = cur + line + '\n';
      if (next.length > 60000) next = next.slice(next.length - 40000);
      return next;
    });
  }, []);

  const runScan = async () => {
    if (busy) return;
    if (!isValidTarget(target)) {
      setMsg({ kind: 'err', text: t('nmap.badTarget') });
      return;
    }
    const runArgs = buildArgs(profile, effectiveFlags, extra, target.trim());
    setBusy(true);
    setCancelReq(false);
    setResult(null);
    setMsg(null);
    setStatus(t('nmap.scanningStatus'));
    setLog(previewCommand(runArgs) + '\n');

    if (!isTauri()) {
      // Browser preview: no native backend to spawn nmap. Render the full UI and
      // explain, without punting — the desktop shell runs the real binary.
      appendLog(t('nmap.previewLog'));
      setMsg({ kind: 'info', text: t('nmap.previewNote') });
      setStatus('');
      setBusy(false);
      return;
    }

    let res: ScanResult;
    try {
      const out = await runCommand(nmapPath, runArgs);
      if (out.stderr.trim()) appendLog(out.stderr.trim());
      res = parseXml(out.stdout || '');
      res.command = previewCommand(runArgs);
      if (!res.ok && out.stderr.trim()) res.error = out.stderr.trim();
      if (!res.ok && !out.stderr.trim() && out.stdout.trim()) appendLog(out.stdout.trim());
    } catch (e) {
      res = {
        hosts: [],
        rawXml: '',
        command: previewCommand(runArgs),
        summary: '',
        error: String(e instanceof Error ? e.message : e),
        ok: false,
      };
    }

    setResult(res);
    setBusy(false);
    setStatus(res.summary || '');

    if (cancelReq) {
      setMsg({ kind: 'info', text: t('nmap.cancelled') });
      setStatus(t('nmap.cancelled'));
      return;
    }

    if (res.ok || res.hosts.length > 0) {
      const up = res.hosts.filter((h) => h.status === 'up').length;
      const ports = res.hosts.reduce((n, h) => n + h.ports.filter((p) => p.state === 'open').length, 0);
      setMsg({ kind: 'ok', text: t('nmap.complete', { hosts: up, ports, summary: res.summary }) });
      setHistory((cur) =>
        [
          { ts: Date.now(), command: res.command, target: target.trim(), summary: res.summary },
          ...cur,
        ].slice(0, 25),
      );
    } else {
      setMsg({ kind: 'err', text: res.error || t('nmap.failed') });
    }
  };

  const cancelScan = () => {
    // runCommand resolves as one shot; flag intent so the completion path reports it.
    setCancelReq(true);
    setStatus(t('nmap.cancelling'));
  };

  const saveXml = () => {
    if (!result) return;
    const content = result.rawXml || toCsv(result);
    downloadBlob(new Blob([content], { type: 'application/xml' }), `nmap-scan-${stamp()}.xml`);
    setMsg({ kind: 'ok', text: t('nmap.saved') });
  };
  const saveCsv = () => {
    if (!result) return;
    downloadBlob(new Blob([toCsv(result)], { type: 'text/csv' }), `nmap-scan-${stamp()}.csv`);
    setMsg({ kind: 'ok', text: t('nmap.saved') });
  };

  // saved profiles
  const saveProfile = () => {
    const name = window.prompt(t('nmap.profileNamePrompt'), target.trim());
    if (!name) return;
    const entry: SavedProfile = { name: name.trim(), profile, flags, extra, target: target.trim() };
    setSaved((cur) => [entry, ...cur.filter((p) => p.name !== entry.name)].slice(0, 30));
    setMsg({ kind: 'ok', text: t('nmap.profileSaved', { name: entry.name }) });
  };
  const applyProfile = (p: SavedProfile) => {
    setProfile(p.profile);
    setFlags(p.flags);
    setExtra(p.extra);
    setTarget(p.target);
  };
  const deleteProfile = (name: string) => setSaved((cur) => cur.filter((p) => p.name !== name));

  // ---- Scan tab ----
  const scanTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
            {t('nmap.targetLabel')}
          </span>
          <input
            className="mod-search"
            style={{ fontFamily: 'Consolas, monospace' }}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={t('nmap.targetPlaceholder')}
          />
        </label>
        <label style={{ minWidth: 200, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
            {t('nmap.profileLabel')}
          </span>
          <select className="mod-select" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {PROFILES.map((p) => (
              <option key={p.key} value={p.key}>
                {t(`nmap.prof_${p.key}`)}
                {p.needsAdmin ? ' ★' : ''}
              </option>
            ))}
          </select>
        </label>
        <label style={{ minWidth: 120, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
            {t('nmap.timingLabel')}
          </span>
          <select className="mod-select" value={timing} onChange={(e) => setTiming(e.target.value)}>
            <option value="">{t('nmap.timingDefault')}</option>
            {TIMING.map((tt) => (
              <option key={tt} value={tt}>
                {tt}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
          {t('nmap.flagsLabel')}
        </span>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {COMMON_FLAGS.map((f) => (
            <label key={f.flag} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
              <input type="checkbox" checked={flags.includes(f.flag)} onChange={() => toggleFlag(f.flag)} />
              {t(`nmap.${f.i18n}`)}
              {f.needsAdmin ? ' ★' : ''}
            </label>
          ))}
        </div>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
          {t('nmap.extraLabel')}
        </span>
        <input
          className="mod-search"
          style={{ fontFamily: 'Consolas, monospace' }}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder={t('nmap.extraPlaceholder')}
        />
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="count-note" style={{ margin: 0, fontWeight: 600 }}>
          {t('nmap.previewLabel')}
        </span>
        <pre className="cmd-out" style={{ margin: 0 }}>
          {preview}
        </pre>
      </div>

      {admin && (
        <p className="count-note" style={{ margin: 0, color: 'var(--danger)' }}>
          ★ {t('nmap.adminNote')}
        </p>
      )}

      <div className="mod-toolbar" style={{ marginTop: 0 }}>
        <button className="mini primary" disabled={busy} onClick={() => void runScan()}>
          {busy ? t('nmap.scanningStatus') : t('nmap.runScan')}
        </button>
        <button className="mini" disabled={!busy || cancelReq} onClick={cancelScan}>
          {t('nmap.cancel')}
        </button>
        <button className="mini" disabled={!result} onClick={saveXml}>
          {t('nmap.saveXml')}
        </button>
        <button className="mini" disabled={!result} onClick={saveCsv}>
          {t('nmap.saveCsv')}
        </button>
        <button className="mini" onClick={saveProfile}>
          {t('nmap.saveProfile')}
        </button>
        {status && <span className="count-note">{status}</span>}
      </div>

      {msg && (
        <p
          className="mod-msg"
          style={{ color: msg.kind === 'err' ? 'var(--danger)' : msg.kind === 'ok' ? undefined : 'var(--text-secondary)' }}
        >
          {msg.text}
        </p>
      )}

      {/* Results table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 className="group-title" style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>
            {t('nmap.resultsTitle')}
          </h3>
          {result && (
            <span className="count-note" style={{ margin: 0 }}>
              {t('nmap.resultCount', { hosts: hostsUp, ports: openPorts })}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>
            {t('nmap.noResults')}
          </p>
        ) : (
          <div className="dt-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('nmap.colHost')}</th>
                  <th style={{ width: 80, textAlign: 'right' }}>{t('nmap.colPort')}</th>
                  <th style={{ width: 70 }}>{t('nmap.colProto')}</th>
                  <th style={{ width: 80 }}>{t('nmap.colState')}</th>
                  <th style={{ width: 150 }}>{t('nmap.colService')}</th>
                  <th>{t('nmap.colVersion')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'Consolas, monospace' }}>
                      {r.hostName ? `${r.hostName} (${r.hostAddress})` : r.hostAddress}
                    </td>
                    <td style={{ fontFamily: 'Consolas, monospace', textAlign: 'right' }}>
                      {r.port > 0 ? r.port : ''}
                    </td>
                    <td>{r.protocol}</td>
                    <td style={{ color: r.state === 'open' ? undefined : 'var(--text-secondary)' }}>{r.state}</td>
                    <td>{r.service}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{r.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  // ---- Tools tab ----
  const toolsTab = () => <ToolsPanel nmapPath={nmapPath} />;

  // ---- Live log tab ----
  const logTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {t('nmap.logNote')}
      </span>
      <pre className="cmd-out" style={{ margin: 0, maxHeight: 340, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {log || t('nmap.logEmpty')}
      </pre>
    </div>
  );

  // ---- History + saved profiles tab ----
  const savedTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 className="group-title" style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>
            {t('nmap.savedTitle')}
          </h3>
          {saved.length > 0 && (
            <button className="mini" onClick={() => setSaved([])}>
              {t('nmap.clearSaved')}
            </button>
          )}
        </div>
        {saved.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>
            {t('nmap.noSaved')}
          </p>
        ) : (
          <div className="dt-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('nmap.spName')}</th>
                  <th>{t('nmap.spTarget')}</th>
                  <th>{t('nmap.spProfile')}</th>
                  <th style={{ width: 160 }}></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((p) => (
                  <tr key={p.name}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td style={{ fontFamily: 'Consolas, monospace' }}>{p.target}</td>
                    <td>
                      {t(`nmap.prof_${p.profile}`)}
                      {p.flags.length ? ` · ${p.flags.join(' ')}` : ''}
                    </td>
                    <td>
                      <span className="row-actions">
                        <button className="mini" onClick={() => applyProfile(p)}>
                          {t('nmap.load')}
                        </button>
                        <button className="mini" onClick={() => deleteProfile(p.name)}>
                          {t('nmap.delete')}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 className="group-title" style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>
            {t('nmap.historyTitle')}
          </h3>
          {history.length > 0 && (
            <button className="mini" onClick={() => setHistory([])}>
              {t('nmap.clearHistory')}
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>
            {t('nmap.noHistory')}
          </p>
        ) : (
          <div className="dt-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>{t('nmap.hTime')}</th>
                  <th>{t('nmap.hCommand')}</th>
                  <th style={{ width: 120 }}>{t('nmap.hSummary')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="count-note" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(h.ts).toLocaleString()}
                    </td>
                    <td style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{h.command}</td>
                    <td className="count-note">{h.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <ModuleTabs
      tabs={[
        { id: 'scan', en: 'Scan', zh: '掃描', render: scanTab },
        { id: 'tools', en: 'Tools', zh: '工具', render: toolsTab },
        { id: 'log', en: 'Live log', zh: '即時記錄', render: logTab },
        { id: 'saved', en: 'History', zh: '記錄', render: savedTab },
      ]}
    />
  );
}

// ---- Tools panel: one-shot Nmap helper commands ----------------------------
function ToolsPanel({ nmapPath }: { nmapPath: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ id: string; text: string } | null>(null);

  const run = async (op: ToolOp) => {
    if (busy) return;
    setBusy(op.id);
    setOut(null);
    if (!isTauri()) {
      setOut({ id: op.id, text: t('nmap.previewNote') });
      setBusy(null);
      return;
    }
    try {
      const res = await runCommand(nmapPath, op.args);
      setOut({ id: op.id, text: res.stdout || res.stderr || `(exit ${res.code})` });
    } catch (e) {
      setOut({ id: op.id, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {t('nmap.toolsNote')}
      </span>
      {TOOLS.map((op) => (
        <div
          key={op.id}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            borderBottom: '1px solid var(--stroke)',
            paddingBottom: 10,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{t(`nmap.tool_${op.id}_title`)}</span>
            <span className="count-note" style={{ margin: 0 }}>
              {t(`nmap.tool_${op.id}_desc`)}
            </span>
          </div>
          <button className="mini" disabled={busy === op.id} onClick={() => void run(op)}>
            {busy === op.id ? t('nmap.scanningStatus') : t(`nmap.tool_${op.id}_btn`)}
          </button>
        </div>
      ))}
      {out && (
        <pre className="cmd-out" style={{ margin: 0, maxHeight: 320, overflow: 'auto' }}>
          {out.text}
        </pre>
      )}
    </div>
  );
}
