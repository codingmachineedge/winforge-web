import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, type CommandOutput } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Android (ADB) — module.adb — native web port of WinForge's AndroidAdbModule.
//
// The desktop original wrapped adb.exe (AdbService.cs). Here we drive the same
// Google Platform Tools `adb` binary through the Tauri backend via runCommand,
// so no PowerShell quoting games and clean stdout. Ported features:
//   • device list (`adb devices -l`, parsed to model / serial / state)
//   • wireless connect / disconnect (`adb connect|disconnect ip:port`)
//   • Console: screenshot (screencap → base64 PNG rendered inline), logcat
//     snapshot, package list, arbitrary `adb shell` command, reboot menu
//   • Files: browse the device (`ls -1aF`), pull / push / delete (delete gated)
//   • APK backup: list installed packages (`pm list packages`), resolve + pull APK
//   • Live logcat: bounded snapshot with level + tag filter
// Read-only by default; the only mutating actions (reboot / delete / push) are
// gated behind an explicit confirm and never auto-run.
// ============================================================================

interface AdbDevice {
  serial: string;
  state: string;
  model: string;
}

interface AdbFileEntry {
  name: string;
  isDir: boolean;
}

const TABS = ['console', 'files', 'apk', 'logcat'] as const;
type Tab = (typeof TABS)[number];

const REBOOT_MODES = ['', 'bootloader', 'recovery'] as const;
const LOG_LEVELS = ['V', 'D', 'I', 'W', 'E'] as const;

// Run adb with an argument list; never throws (returns a failed CommandOutput).
async function adb(args: string[]): Promise<CommandOutput> {
  if (!isTauri()) return { stdout: '', stderr: '', code: -1, success: false };
  try {
    return await runCommand('adb', args);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

function combine(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}

export function AndroidAdbModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('console');
  const [serial, setSerial] = useState('');
  const [ip, setIp] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ── adb engine + device list ─────────────────────────────────────────────
  const engine = useAsync<{ ok: boolean; version: string }>(async () => {
    const r = await adb(['version']);
    const ok = /Android Debug Bridge/i.test(r.stdout);
    const first = r.stdout.split('\n').find((l) => /version/i.test(l)) ?? '';
    return { ok, version: first.trim() };
  }, []);

  const devicesQ = useAsync<AdbDevice[]>(async () => {
    const r = await adb(['devices', '-l']);
    const out: AdbDevice[] = [];
    let started = false;
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (/^List of devices/i.test(line)) {
        started = true;
        continue;
      }
      if (!started || line.length === 0 || line.startsWith('*')) continue;
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) continue;
      const dev: AdbDevice = { serial: parts[0] ?? '', state: parts[1] ?? '', model: '' };
      for (const p of parts) {
        if (/^model:/i.test(p)) dev.model = p.slice('model:'.length).replace(/_/g, ' ');
      }
      out.push(dev);
    }
    return out;
  }, []);

  const devices = devicesQ.data ?? [];
  // Keep the selected serial valid; default to the first device.
  const activeSerial = useMemo(() => {
    if (serial && devices.some((d) => d.serial === serial)) return serial;
    return devices[0]?.serial ?? '';
  }, [serial, devices]);

  const refreshAll = useCallback(() => {
    engine.reload();
    devicesQ.reload();
  }, [engine, devicesQ]);

  const requireDevice = (): string | null => {
    if (!activeSerial) {
      setMsg({ ok: false, text: t('adb.pickDevice') });
      return null;
    }
    return activeSerial;
  };

  const connect = async (verb: 'connect' | 'disconnect') => {
    const target = ip.trim();
    if (!target) return;
    setBusy(true);
    setMsg(null);
    const r = await adb([verb, target]);
    setBusy(false);
    setMsg({ ok: r.success, text: (r.stdout || r.stderr).trim() || `exit ${r.code}` });
    devicesQ.reload();
  };

  const reboot = async (mode: string) => {
    const s = requireDevice();
    if (!s) return;
    const label = mode || t('adb.rebootSystem');
    if (!confirm(t('adb.confirmReboot', { mode: label }))) return;
    setBusy(true);
    setMsg(null);
    const args = ['-s', s, 'reboot'];
    if (mode) args.push(mode);
    const r = await adb(args);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('adb.rebootSent') : (r.stderr || r.stdout).trim() });
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('adb.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={refreshAll} disabled={busy}>
          ⟳ {t('modules.refresh')}
        </button>
        <select
          className="mod-search"
          value={activeSerial}
          onChange={(e) => setSerial(e.target.value)}
          style={{ minWidth: 220 }}
        >
          {devices.length === 0 && <option value="">{t('adb.noDevices')}</option>}
          {devices.map((d) => (
            <option key={d.serial} value={d.serial}>
              {(d.model ? `${d.model} · ` : '') + `${d.serial} (${d.state})`}
            </option>
          ))}
        </select>
        <input
          className="mod-search"
          placeholder="192.168.x.x:5555"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          style={{ minWidth: 160 }}
        />
        <button className="mini" onClick={() => connect('connect')} disabled={busy || !ip.trim()}>
          {t('adb.connect')}
        </button>
        <button
          className="mini"
          onClick={() => connect('disconnect')}
          disabled={busy || !ip.trim()}
        >
          {t('adb.disconnect')}
        </button>
        <span className="count-note">{t('adb.deviceCount', { num: devices.length })}</span>
      </ModuleToolbar>

      {engine.data && !engine.data.ok && (
        <p className="mod-msg">{t('adb.noAdb')}</p>
      )}
      {engine.data?.ok && engine.data.version && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot ok label={engine.data.version} />
        </p>
      )}
      {msg && (
        <pre className={`cmd-out${msg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </pre>
      )}

      <div className="mod-tabbar" role="tablist" style={{ marginTop: 8 }}>
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={`mod-tab${id === tab ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(`adb.tab.${id}`)}
          </button>
        ))}
      </div>

      <div className="mod-tabpanel" role="tabpanel">
        {tab === 'console' && (
          <ConsoleTab
            serial={activeSerial}
            requireDevice={requireDevice}
            reboot={reboot}
            busy={busy}
            setBusy={setBusy}
            setMsg={setMsg}
          />
        )}
        {tab === 'files' && (
          <FilesTab
            serial={activeSerial}
            requireDevice={requireDevice}
            busy={busy}
            setBusy={setBusy}
            setMsg={setMsg}
          />
        )}
        {tab === 'apk' && (
          <ApkTab serial={activeSerial} requireDevice={requireDevice} setMsg={setMsg} />
        )}
        {tab === 'logcat' && (
          <LogcatTab serial={activeSerial} requireDevice={requireDevice} />
        )}
      </div>
    </div>
  );
}

// ── shared prop shapes ──────────────────────────────────────────────────────
type SetMsg = (m: { ok: boolean; text: string } | null) => void;

// `serial` drives re-renders/keying at the call site; each tab resolves the live
// device through requireDevice(), so the sub-components don't read it directly.
interface TabBase {
  serial: string;
  requireDevice: () => string | null;
  setMsg: SetMsg;
}

// ── Console tab: screenshot / logcat / packages / shell / reboot ────────────
function ConsoleTab({
  requireDevice,
  reboot,
  busy,
  setBusy,
  setMsg,
}: TabBase & {
  reboot: (mode: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { t } = useTranslation();
  const [out, setOut] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');

  const run = async (label: string, work: () => Promise<CommandOutput>) => {
    if (!requireDevice()) return;
    setBusy(true);
    setMsg(null);
    setShot(null);
    const r = await work();
    setBusy(false);
    setOut(`$ ${label}\n\n${(r.stdout || r.stderr).trim()}`);
  };

  const screenshot = async () => {
    const s = requireDevice();
    if (!s) return;
    setBusy(true);
    setMsg(null);
    setOut('');
    // screencap -p writes raw PNG to stdout; base64 it on-device so the byte
    // stream survives the text pipe, then render inline.
    const r = await adb(['-s', s, 'exec-out', 'sh', '-c', 'screencap -p | base64']);
    setBusy(false);
    const b64 = r.stdout.replace(/\s+/g, '');
    if (r.success && b64.length > 0) {
      setShot(`data:image/png;base64,${b64}`);
    } else {
      setMsg({ ok: false, text: (r.stderr || r.stdout).trim() || t('adb.shotFailed') });
    }
  };

  const shell = async () => {
    const s = requireDevice();
    if (!s) return;
    const c = cmd.trim();
    if (!c) return;
    await run(`adb shell ${c}`, () => adb(['-s', s, 'shell', ...c.split(/\s+/)]));
  };

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" onClick={screenshot} disabled={busy}>
          {t('adb.screenshot')}
        </button>
        <button
          className="mini"
          onClick={() => {
            const s = requireDevice();
            if (s) run('adb logcat -d -t 400', () => adb(['-s', s, 'logcat', '-d', '-t', '400']));
          }}
          disabled={busy}
        >
          {t('adb.logcat')}
        </button>
        <button
          className="mini"
          onClick={() => {
            const s = requireDevice();
            if (s) run('adb shell pm list packages', () => adb(['-s', s, 'shell', 'pm', 'list', 'packages']));
          }}
          disabled={busy}
        >
          {t('adb.packages')}
        </button>
        {REBOOT_MODES.map((m) => (
          <button key={m || 'system'} className="mini" onClick={() => reboot(m)} disabled={busy}>
            {t(`adb.reboot.${m || 'system'}`)}
          </button>
        ))}
      </div>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, fontFamily: 'monospace' }}
          placeholder={t('adb.shellPlaceholder')}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') shell();
          }}
        />
        <button className="mini primary" onClick={shell} disabled={busy || !cmd.trim()}>
          {t('adb.run')}
        </button>
      </div>

      {shot && (
        <img
          src={shot}
          alt="device screenshot"
          style={{ maxHeight: 360, maxWidth: '100%', borderRadius: 8, display: 'block', marginTop: 8 }}
        />
      )}
      {out && (
        <pre className="cmd-out" style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
          {out}
        </pre>
      )}
    </div>
  );
}

// ── Files tab: browse / push / pull / delete ────────────────────────────────
function FilesTab({
  requireDevice,
  busy,
  setBusy,
  setMsg,
}: TabBase & { busy: boolean; setBusy: (b: boolean) => void }) {
  const { t } = useTranslation();
  const [cwd, setCwd] = useState('/sdcard');
  const [path, setPath] = useState('/sdcard');
  const [entries, setEntries] = useState<AdbFileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState('');

  const loadDir = async (target: string) => {
    const s = requireDevice();
    if (!s) return;
    const dir = target || '/';
    setBusy(true);
    setMsg(null);
    setSelected(null);
    const r = await adb(['-s', s, 'shell', 'ls', '-1aF', dir]);
    setBusy(false);
    const list: AdbFileEntry[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (/Permission denied|No such file|Not a directory/.test(line)) continue;
      const isDir = line.endsWith('/');
      const name = line.replace(/[/*@|=]+$/, '');
      if (name === '.' || name === '..') continue;
      list.push({ name, isDir });
    }
    list.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
    setCwd(dir);
    setPath(dir);
    setEntries(list);
  };

  const up = () => {
    const p = cwd.replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    loadDir(i <= 0 ? '/' : p.slice(0, i));
  };

  const pull = async () => {
    const s = requireDevice();
    if (!s || !selected) {
      setMsg({ ok: false, text: t('adb.pickFile') });
      return;
    }
    const local = localPath.trim();
    if (!local) {
      setMsg({ ok: false, text: t('adb.needLocalDir') });
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await adb(['-s', s, 'pull', combine(cwd, selected), local]);
    setBusy(false);
    setMsg({ ok: r.success, text: (r.stdout || r.stderr).trim() });
  };

  const push = async () => {
    const s = requireDevice();
    if (!s) return;
    const local = localPath.trim();
    if (!local) {
      setMsg({ ok: false, text: t('adb.needLocalFile') });
      return;
    }
    if (!confirm(t('adb.confirmPush', { file: local, dir: cwd }))) return;
    setBusy(true);
    setMsg(null);
    const base = local.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'file';
    const r = await adb(['-s', s, 'push', local, combine(cwd, base)]);
    setBusy(false);
    setMsg({ ok: r.success, text: (r.stdout || r.stderr).trim() });
    if (r.success) loadDir(cwd);
  };

  const del = async () => {
    const s = requireDevice();
    if (!s || !selected) {
      setMsg({ ok: false, text: t('adb.pickFile') });
      return;
    }
    const remote = combine(cwd, selected);
    if (!confirm(t('adb.confirmDelete', { path: remote }))) return;
    setBusy(true);
    setMsg(null);
    const r = await adb(['-s', s, 'shell', 'rm', '-rf', remote]);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('adb.deleted', { path: remote }) : (r.stderr || r.stdout).trim() });
    if (r.success) loadDir(cwd);
  };

  const columns: Column<AdbFileEntry>[] = [
    {
      key: 'name',
      header: t('adb.fileName'),
      render: (f) => (
        <span
          style={{ cursor: 'pointer', fontFamily: 'monospace' }}
          onClick={() => setSelected(f.name)}
          onDoubleClick={() => f.isDir && loadDir(combine(cwd, f.name))}
        >
          {f.isDir ? '📁 ' : '📄 '}
          {f.name}
          {f.isDir ? '/' : ''}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('adb.fileType'),
      width: 100,
      render: (f) => (f.isDir ? t('adb.folder') : t('adb.file')),
    },
    {
      key: 'sel',
      header: '',
      width: 90,
      render: (f) =>
        selected === f.name ? <StatusDot ok label={t('adb.selected')} /> : null,
    },
  ];

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" onClick={up} disabled={busy}>
          ↑ {t('adb.up')}
        </button>
        <input
          className="mod-search"
          style={{ flex: 1, fontFamily: 'monospace' }}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') loadDir(path.trim());
          }}
        />
        <button className="mini" onClick={() => loadDir(path.trim())} disabled={busy}>
          {t('adb.go')}
        </button>
      </div>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('adb.localPathPlaceholder')}
          value={localPath}
          onChange={(e) => setLocalPath(e.target.value)}
        />
        <button className="mini" onClick={push} disabled={busy}>
          {t('adb.push')}
        </button>
        <button className="mini" onClick={pull} disabled={busy || !selected}>
          {t('adb.pull')}
        </button>
        <button className="mini" onClick={del} disabled={busy || !selected}>
          {t('adb.delete')}
        </button>
      </div>
      <p className="count-note">{t('adb.filesHint')}</p>
      <DataTable
        columns={columns}
        rows={entries}
        rowKey={(f) => f.name}
        empty={t('adb.filesEmpty')}
      />
    </div>
  );
}

// ── APK backup tab: list packages, resolve APK path + pull ──────────────────
function ApkTab({ requireDevice, setMsg }: TabBase) {
  const { t } = useTranslation();
  const [includeSystem, setIncludeSystem] = useState(false);
  const [packages, setPackages] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [localDir, setLocalDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const s = requireDevice();
    if (!s) return;
    setLoading(true);
    setMsg(null);
    const args = ['-s', s, 'shell', 'pm', 'list', 'packages'];
    if (!includeSystem) args.push('-3');
    const r = await adb(args);
    setLoading(false);
    const list: string[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('package:')) continue;
      const pkg = line.slice('package:'.length).trim();
      if (pkg) list.push(pkg);
    }
    list.sort((a, b) => a.localeCompare(b));
    setPackages(list);
  };

  const backup = async (pkg: string) => {
    const s = requireDevice();
    if (!s) return;
    const dir = localDir.trim();
    if (!dir) {
      setMsg({ ok: false, text: t('adb.needLocalDir') });
      return;
    }
    setBusy(true);
    setMsg(null);
    const pathRes = await adb(['-s', s, 'shell', 'pm', 'path', pkg]);
    let remote = '';
    for (const raw of pathRes.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('package:')) {
        remote = line.slice('package:'.length).trim();
        break;
      }
    }
    if (!remote) {
      setBusy(false);
      setMsg({ ok: false, text: t('adb.noApkPath', { pkg }) });
      return;
    }
    const local = combine(dir.replace(/[/\\]+$/, ''), `${pkg}.apk`);
    const r = await adb(['-s', s, 'pull', remote, local]);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? local : (r.stderr || r.stdout).trim() });
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? packages.filter((p) => p.toLowerCase().includes(q)) : packages;
  }, [packages, filter]);

  const columns: Column<string>[] = [
    { key: 'pkg', header: t('adb.package'), render: (p) => <span style={{ fontFamily: 'monospace' }}>{p}</span> },
    {
      key: 'act',
      header: '',
      width: 120,
      render: (p) => (
        <button className="mini" disabled={busy} onClick={() => backup(p)}>
          {t('adb.backup')}
        </button>
      ),
    },
  ];

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" onClick={load} disabled={loading}>
          {t('adb.listApps')}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeSystem}
            onChange={(e) => setIncludeSystem(e.target.checked)}
          />
          {t('adb.includeSystem')}
        </label>
        <input
          className="mod-search"
          placeholder={t('adb.filterApps')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count-note">{t('adb.appCount', { num: rows.length })}</span>
      </div>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('adb.backupDirPlaceholder')}
          value={localDir}
          onChange={(e) => setLocalDir(e.target.value)}
        />
      </div>
      <AsyncState loading={loading} error={null}>
        <DataTable columns={columns} rows={rows} rowKey={(p) => p} empty={t('adb.noApps')} />
      </AsyncState>
    </div>
  );
}

// ── Live logcat tab: bounded snapshot with level + tag filter ────────────────
function LogcatTab({ requireDevice }: Omit<TabBase, 'setMsg'>) {
  const { t } = useTranslation();
  const [level, setLevel] = useState<(typeof LOG_LEVELS)[number]>('I');
  const [tag, setTag] = useState('');
  const [lines, setLines] = useState('400');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const snapshot = async () => {
    const s = requireDevice();
    if (!s) return;
    setBusy(true);
    const count = String(Math.max(1, Math.min(5000, parseInt(lines, 10) || 400)));
    const args = ['-s', s, 'logcat', '-d', '-t', count];
    const tagTrim = tag.trim();
    if (tagTrim) {
      args.push('-s', `${tagTrim}:${level}`);
    } else {
      args.push(`*:${level}`);
    }
    const r = await adb(args);
    setBusy(false);
    setOut((r.stdout || r.stderr).trim() || t('adb.logcatEmpty'));
  };

  return (
    <div>
      <div className="mod-toolbar">
        <select
          className="mod-search"
          value={level}
          onChange={(e) => setLevel(e.target.value as (typeof LOG_LEVELS)[number])}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(`adb.level.${l}`)}
            </option>
          ))}
        </select>
        <input
          className="mod-search"
          style={{ flex: 1, fontFamily: 'monospace' }}
          placeholder={t('adb.tagPlaceholder')}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
        <input
          className="mod-search"
          style={{ width: 90 }}
          value={lines}
          onChange={(e) => setLines(e.target.value)}
          placeholder={t('adb.linesPlaceholder')}
        />
        <button className="mini primary" onClick={snapshot} disabled={busy}>
          {t('adb.capture')}
        </button>
        <button className="mini" onClick={() => setOut('')} disabled={busy}>
          {t('adb.clear')}
        </button>
      </div>
      <p className="count-note">{t('adb.logcatHint')}</p>
      {out && (
        <pre className="cmd-out" style={{ maxHeight: 460, overflow: 'auto' }}>
          {out}
        </pre>
      )}
    </div>
  );
}
