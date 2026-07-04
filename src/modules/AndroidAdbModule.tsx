import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { resolveTool } from '../tauri/deps';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Android (ADB) — module.adb — full native web port of WinForge's
// AndroidAdbModule (Pages/AndroidAdbModule.xaml[.cs] + Services/AdbService.cs
// + Services/ScrcpyService.cs).
//
// The desktop original wrapped adb.exe / scrcpy.exe. Here we resolve the same
// binaries through resolveTool (bundled → PATH) and drive them via runCommand
// (clean argv, no shell quoting) or PowerShell Start-Process for the
// long-running scrcpy window. Ported surface:
//   • toolbar — device list with state, wireless connect / disconnect,
//     Android-11 wireless pairing (adb pair host:port code), restart adb server
//   • adb engine probe via resolveTool + one-click winget install
//     (Google.PlatformTools) when missing — mirrors EngineBars.AutoInstallProgress
//   • per-device property strip: model, Android version + API level, battery
//   • Console: screenshot (inline preview via exec-out base64) + screencap→pull
//     to a local file, logcat snapshot, package dump, install APK (gated),
//     reboot system/bootloader/recovery (confirmed), one-shot `adb shell`
//   • Files: browse (ls -1aF), pull, push (confirmed), delete rm -rf (confirmed)
//   • APK backup: pm list packages with third-party / system / all filter,
//     backup via pm path + pull, uninstall (confirmed)
//   • Logcat: bounded snapshot with priority + tag filters, follow mode
//     (3 s auto-recapture — the web equivalent of the C# streaming logcat),
//     clear output, clear the device log buffer (logcat -c)
//   • Screen mirror: scrcpy via resolveTool + winget install offer
//     (Genymobile.scrcpy), resolution cap, bitrate, stay-awake, screen-off,
//     show-touches, start / record-to-file / stop with a live process probe
// Reads auto-run; every mutation runs only on explicit click and destructive
// ones (reboot, delete, push, install, uninstall) confirm first.
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

interface DeviceInfo {
  model: string;
  ver: string;
  sdk: string;
  battery: string;
}

const TABS = ['console', 'files', 'apk', 'logcat', 'mirror'] as const;
type Tab = (typeof TABS)[number];

const REBOOT_MODES = ['', 'bootloader', 'recovery'] as const;
const LOG_LEVELS = ['V', 'D', 'I', 'W', 'E'] as const;
const PKG_MODES = ['third', 'system', 'all'] as const;
type PkgMode = (typeof PKG_MODES)[number];

// scrcpy option choices — same sets the C# combo boxes offer.
const MAX_SIZES = ['1920', '1280', '1024', '800'] as const;
const BITRATES = ['2', '4', '8', '12', '16'] as const;

const REMOTE_SHOT = '/sdcard/winforge_screen.png';

// ── low-level runners (never throw; browser preview returns a no-op stub) ───

async function runCmdSafe(program: string, args: string[]): Promise<CommandOutput> {
  if (!isTauri()) return { stdout: '', stderr: '', code: -1, success: false };
  try {
    return await runCommand(program, args);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

async function pshell(script: string): Promise<CommandOutput> {
  if (!isTauri()) return { stdout: '', stderr: '', code: -1, success: false };
  try {
    return await runPowershell(script);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

// Resolve adb once (bundled copy → PATH) and reuse it for every call.
let adbExeCache: Promise<string> | null = null;
function adbExe(): Promise<string> {
  if (!adbExeCache) {
    adbExeCache = resolveTool('adb')
      .then((r) => r.path ?? 'adb')
      .catch(() => 'adb');
  }
  return adbExeCache;
}

async function adb(args: string[]): Promise<CommandOutput> {
  if (!isTauri()) return { stdout: '', stderr: '', code: -1, success: false };
  return runCmdSafe(await adbExe(), args);
}

function combine(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}

/** PowerShell single-quote escape. */
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

/** Best output text for a result; in the browser preview explain instead of `exit -1`. */
function resultText(r: CommandOutput, previewFallback: string): string {
  const s = (r.stdout || r.stderr).trim();
  if (s) return s;
  return isTauri() ? `exit ${r.code}` : previewFallback;
}

export function AndroidAdbModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('console');
  const [serial, setSerial] = useState('');
  const [ip, setIp] = useState('');
  const [showPair, setShowPair] = useState(false);
  const [pairHost, setPairHost] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const live = isTauri();

  // ── adb engine (resolveTool → version banner) ────────────────────────────
  const engine = useAsync<{ ok: boolean; version: string; source: string }>(async () => {
    if (!live) return { ok: false, version: '', source: '' };
    let source = '';
    try {
      const res = await resolveTool('adb');
      source = res.source;
      adbExeCache = Promise.resolve(res.path ?? 'adb'); // refresh the cached resolution
    } catch {
      adbExeCache = Promise.resolve('adb');
    }
    const r = await adb(['version']);
    const ok = /Android Debug Bridge/i.test(r.stdout);
    const first = r.stdout.split('\n').find((l) => /version/i.test(l)) ?? '';
    return { ok, version: first.trim(), source };
  }, []);

  // ── device list (adb devices -l → serial / state / model) ────────────────
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
  const activeDevice = devices.find((d) => d.serial === activeSerial) ?? null;

  // ── selected-device property strip (model / Android / battery) — read-only
  const infoQ = useAsync<DeviceInfo | null>(async () => {
    if (!live || !activeSerial) return null;
    const r = await adb([
      '-s',
      activeSerial,
      'shell',
      'echo WF_MODEL:$(getprop ro.product.model); echo WF_VER:$(getprop ro.build.version.release); echo WF_SDK:$(getprop ro.build.version.sdk); dumpsys battery | grep level:',
    ]);
    if (!r.stdout.trim()) return null;
    const info: DeviceInfo = { model: '', ver: '', sdk: '', battery: '' };
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('WF_MODEL:')) info.model = line.slice('WF_MODEL:'.length).trim();
      else if (line.startsWith('WF_VER:')) info.ver = line.slice('WF_VER:'.length).trim();
      else if (line.startsWith('WF_SDK:')) info.sdk = line.slice('WF_SDK:'.length).trim();
      else {
        const m = /^level:\s*(\d+)/.exec(line);
        if (m && m[1]) info.battery = m[1];
      }
    }
    return info;
  }, [activeSerial]);

  const refreshAll = useCallback(() => {
    engine.reload();
    devicesQ.reload();
    infoQ.reload();
  }, [engine, devicesQ, infoQ]);

  const requireDevice = (): string | null => {
    if (!activeSerial) {
      setMsg({ ok: false, text: t('adb.pickDevice') });
      return null;
    }
    return activeSerial;
  };

  // ── wireless connect / disconnect / pair, adb server restart ─────────────
  const connect = async (verb: 'connect' | 'disconnect') => {
    const target = ip.trim();
    if (!target) return;
    setBusy(true);
    setMsg(null);
    const r = await adb([verb, target]);
    setBusy(false);
    setMsg({ ok: r.success, text: resultText(r, t('adb.previewNote')) });
    devicesQ.reload();
  };

  const pair = async () => {
    const host = pairHost.trim();
    const code = pairCode.trim();
    if (!host || !code) return;
    setBusy(true);
    setMsg(null);
    const r = await adb(['pair', host, code]);
    setBusy(false);
    setMsg({ ok: r.success, text: resultText(r, t('adb.previewNote')) });
    devicesQ.reload();
  };

  const killServer = async () => {
    setBusy(true);
    setMsg(null);
    await adb(['kill-server']);
    const r = await adb(['start-server']);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('adb.killServerDone') : resultText(r, t('adb.previewNote')) });
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
    setMsg({ ok: r.success, text: r.success ? t('adb.rebootSent') : resultText(r, t('adb.previewNote')) });
  };

  const TAB_LABELS: Record<Tab, string> = {
    console: t('adb.tab.console'),
    files: t('adb.tab.files'),
    apk: t('adb.tab.apk'),
    logcat: t('adb.tab.logcat'),
    mirror: t('adb.tabMirror'),
  };

  const info = infoQ.data;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('adb.blurbFull')}
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
        <button className="mini" onClick={() => setShowPair((v) => !v)}>
          {t('adb.pairToggle')}
        </button>
        <button className="mini" onClick={killServer} disabled={busy}>
          {t('adb.killServer')}
        </button>
        <span className="count-note">{t('adb.deviceCount', { num: devices.length })}</span>
      </ModuleToolbar>

      {showPair && (
        <>
          <ModuleToolbar>
            <input
              className="mod-search"
              style={{ minWidth: 240 }}
              placeholder={t('adb.pairHostPlaceholder')}
              value={pairHost}
              onChange={(e) => setPairHost(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ width: 140 }}
              placeholder={t('adb.pairCodePlaceholder')}
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
            />
            <button
              className="mini primary"
              onClick={pair}
              disabled={busy || !pairHost.trim() || !pairCode.trim()}
            >
              {t('adb.pairBtn')}
            </button>
          </ModuleToolbar>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('adb.pairHint')}
          </p>
        </>
      )}

      {!live && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('adb.previewNote')}
        </p>
      )}
      {live && engine.data && !engine.data.ok && (
        <>
          <p className="mod-msg">{t('adb.noAdb')}</p>
          <WingetInstall id="Google.PlatformTools" label={t('adb.installAdb')} onDone={refreshAll} />
        </>
      )}
      {engine.data?.ok && engine.data.version && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot
            ok
            label={engine.data.version + (engine.data.source ? ` · ${engine.data.source}` : '')}
          />
        </p>
      )}

      {activeDevice && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot
            ok={activeDevice.state === 'device'}
            label={`${activeDevice.serial} · ${activeDevice.state}`}
          />
          {info && (
            <>
              {' · '}
              {t('adb.infoModel')}: {info.model || activeDevice.model || '—'}
              {' · '}
              {t('adb.infoAndroid', { ver: info.ver || '?', sdk: info.sdk || '?' })}
              {' · '}
              {t('adb.infoBattery', { pct: info.battery || '?' })}
            </>
          )}
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
            {TAB_LABELS[id]}
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
        {tab === 'mirror' && (
          <MirrorTab serial={activeSerial} requireDevice={requireDevice} setMsg={setMsg} />
        )}
      </div>
    </div>
  );
}

// ── shared prop shapes ──────────────────────────────────────────────────────
type SetMsg = (m: { ok: boolean; text: string } | null) => void;

interface TabBase {
  serial: string;
  requireDevice: () => string | null;
  setMsg: SetMsg;
}

// ── Console tab: screenshot / logcat / packages / install APK / shell / reboot
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
  const [apkPath, setApkPath] = useState('');
  const [savePath, setSavePath] = useState('');

  const run = async (label: string, work: () => Promise<CommandOutput>) => {
    if (!requireDevice()) return;
    setBusy(true);
    setMsg(null);
    setShot(null);
    const r = await work();
    setBusy(false);
    setOut(`$ ${label}\n\n${resultText(r, t('adb.previewNote'))}`);
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

  // C#-parity screenshot: screencap to a device temp file, pull it locally, clean up.
  const saveShot = async () => {
    const s = requireDevice();
    if (!s) return;
    const local = savePath.trim();
    if (!local) return;
    setBusy(true);
    setMsg(null);
    const cap = await adb(['-s', s, 'shell', 'screencap', '-p', REMOTE_SHOT]);
    if (!cap.success) {
      setBusy(false);
      setMsg({ ok: false, text: resultText(cap, t('adb.previewNote')) });
      return;
    }
    const pulled = await adb(['-s', s, 'pull', REMOTE_SHOT, local]);
    void adb(['-s', s, 'shell', 'rm', '-f', REMOTE_SHOT]);
    setBusy(false);
    setMsg({
      ok: pulled.success,
      text: pulled.success ? t('adb.shotSaved', { path: local }) : resultText(pulled, t('adb.previewNote')),
    });
  };

  const installApk = async () => {
    const s = requireDevice();
    if (!s) return;
    const p = apkPath.trim();
    if (!p) return;
    if (!confirm(t('adb.confirmInstall', { path: p }))) return;
    await run(`adb install -r "${p}"`, () => adb(['-s', s, 'install', '-r', p]));
  };

  const shell = async () => {
    const s = requireDevice();
    if (!s) return;
    const c = cmd.trim();
    if (!c) return;
    // Pass the whole command as one argv entry so pipes/quotes reach the device
    // shell intact — same as the C# `adb -s {serial} shell {command}`.
    await run(`adb shell ${c}`, () => adb(['-s', s, 'shell', c]));
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

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('adb.apkPathPlaceholder')}
          value={apkPath}
          onChange={(e) => setApkPath(e.target.value)}
        />
        <button className="mini" onClick={installApk} disabled={busy || !apkPath.trim()}>
          {t('adb.installApk')}
        </button>
      </div>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('adb.shotSavePlaceholder')}
          value={savePath}
          onChange={(e) => setSavePath(e.target.value)}
        />
        <button className="mini" onClick={saveShot} disabled={busy || !savePath.trim()}>
          {t('adb.saveShot')}
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
    setMsg({ ok: r.success, text: resultText(r, t('adb.previewNote')) });
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
    setMsg({ ok: r.success, text: resultText(r, t('adb.previewNote')) });
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
    setMsg({ ok: r.success, text: r.success ? t('adb.deleted', { path: remote }) : resultText(r, t('adb.previewNote')) });
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

// ── APK tab: list (third-party / system / all), backup via pm path + pull,
//    uninstall (confirmed) ───────────────────────────────────────────────────
function ApkTab({ requireDevice, setMsg }: TabBase) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PkgMode>('third');
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
    if (mode === 'third') args.push('-3');
    else if (mode === 'system') args.push('-s');
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
    setMsg({ ok: r.success, text: r.success ? local : resultText(r, t('adb.previewNote')) });
  };

  const uninstall = async (pkg: string) => {
    const s = requireDevice();
    if (!s) return;
    if (!confirm(t('adb.confirmUninstall', { pkg }))) return;
    setBusy(true);
    setMsg(null);
    const r = await adb(['-s', s, 'uninstall', pkg]);
    setBusy(false);
    const ok = r.success && /Success/i.test(r.stdout);
    setMsg({ ok, text: ok ? t('adb.uninstalled', { pkg }) : resultText(r, t('adb.previewNote')) });
    if (ok) void load();
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
      width: 220,
      render: (p) => (
        <span className="row-actions">
          <button className="mini" disabled={busy} onClick={() => backup(p)}>
            {t('adb.backup')}
          </button>
          <button className="mini" disabled={busy} onClick={() => uninstall(p)}>
            {t('adb.uninstall')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" onClick={load} disabled={loading}>
          {t('adb.listApps')}
        </button>
        <select
          className="mod-search"
          value={mode}
          onChange={(e) => setMode(e.target.value as PkgMode)}
        >
          <option value="third">{t('adb.pkgThird')}</option>
          <option value="system">{t('adb.pkgSystem')}</option>
          <option value="all">{t('adb.pkgAll')}</option>
        </select>
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

// ── Logcat tab: snapshot with level + tag filter, follow mode, buffer clear ─
function LogcatTab({ serial, requireDevice }: Omit<TabBase, 'setMsg'>) {
  const { t } = useTranslation();
  const [level, setLevel] = useState<(typeof LOG_LEVELS)[number]>('I');
  const [tag, setTag] = useState('');
  const [lines, setLines] = useState('400');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(false);
  const runningRef = useRef(false);

  const snapshot = async (silent = false) => {
    const s = silent ? serial || null : requireDevice();
    if (!s) {
      if (silent) setFollow(false);
      return;
    }
    if (runningRef.current) return;
    runningRef.current = true;
    if (!silent) setBusy(true);
    const count = String(Math.max(1, Math.min(5000, parseInt(lines, 10) || 400)));
    const args = ['-s', s, 'logcat', '-d', '-t', count];
    const tagTrim = tag.trim();
    if (tagTrim) {
      args.push('-s', `${tagTrim}:${level}`);
    } else {
      args.push(`*:${level}`);
    }
    const r = await adb(args);
    runningRef.current = false;
    if (!silent) setBusy(false);
    setOut((r.stdout || r.stderr).trim() || t('adb.logcatEmpty'));
  };

  // Follow mode — the web equivalent of the C# streaming logcat: re-capture a
  // bounded snapshot every 3 s while enabled. Started only by explicit click.
  useEffect(() => {
    if (!follow) return;
    void snapshot(true);
    const id = window.setInterval(() => void snapshot(true), 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, level, tag, lines, serial]);

  const clearBuffer = async () => {
    const s = requireDevice();
    if (!s) return;
    setBusy(true);
    const r = await adb(['-s', s, 'logcat', '-c']);
    setBusy(false);
    setOut(r.success ? t('adb.bufferCleared') : (r.stderr || r.stdout).trim() || t('adb.logcatEmpty'));
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
        <button className="mini primary" onClick={() => snapshot()} disabled={busy}>
          {t('adb.capture')}
        </button>
        <button className="mini" onClick={() => setFollow((f) => !f)} disabled={busy && !follow}>
          {follow ? t('adb.stopFollow') : t('adb.followBtn')}
        </button>
        <button className="mini" onClick={() => setOut('')} disabled={busy}>
          {t('adb.clear')}
        </button>
        <button className="mini" onClick={clearBuffer} disabled={busy}>
          {t('adb.clearBuffer')}
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

// ── Screen mirror tab: scrcpy via resolveTool, options, start/record/stop ───
function MirrorTab({ requireDevice, setMsg }: TabBase) {
  const { t } = useTranslation();
  const live = isTauri();
  const [maxSize, setMaxSize] = useState('0');
  const [bitrate, setBitrate] = useState('8');
  const [stayAwake, setStayAwake] = useState(true);
  const [screenOff, setScreenOff] = useState(false);
  const [showTouches, setShowTouches] = useState(false);
  const [recordPath, setRecordPath] = useState('');
  const [busy, setBusy] = useState(false);

  const scrcpyQ = useAsync<{ path: string | null; source: string }>(async () => {
    if (!live) return { path: null, source: 'missing' };
    try {
      const r = await resolveTool('scrcpy');
      return { path: r.path, source: r.source };
    } catch {
      return { path: null, source: 'missing' };
    }
  }, []);

  const statusQ = useAsync<boolean>(async () => {
    if (!live) return false;
    const r = await pshell('(Get-Process -Name scrcpy -ErrorAction SilentlyContinue | Measure-Object).Count');
    return parseInt(r.stdout.trim() || '0', 10) > 0;
  }, []);
  const running = statusQ.data === true;

  // Mirrors ScrcpyOptions.BuildArgs() from the C# service.
  const buildArgs = (record: boolean): string[] | null => {
    const s = requireDevice();
    if (!s) return null;
    const args = ['-s', s];
    if (maxSize !== '0') args.push('--max-size', maxSize);
    args.push('--video-bit-rate', `${bitrate}M`);
    if (stayAwake) args.push('--stay-awake');
    if (screenOff) args.push('--turn-screen-off');
    if (showTouches) args.push('--show-touches');
    if (record) args.push('--record', recordPath.trim());
    return args;
  };

  const start = async (record: boolean) => {
    if (record && !recordPath.trim()) {
      setMsg({ ok: false, text: t('adb.needRecordPath') });
      return;
    }
    const args = buildArgs(record);
    if (!args) return;
    const exe = scrcpyQ.data?.path ?? 'scrcpy';
    setBusy(true);
    setMsg(null);
    // Launch detached via Start-Process — scrcpy is long-running and owns its
    // own window, so we must not block on it. Pre-quote args carrying spaces
    // (PS 5.1 -ArgumentList joins with spaces without re-quoting).
    const list = args
      .map((a) => (a.includes(' ') ? `"${a}"` : a))
      .map((a) => `'${psq(a)}'`)
      .join(',');
    const r = await pshell(`Start-Process -FilePath '${psq(exe)}' -ArgumentList @(${list}); 'ok'`);
    setBusy(false);
    setMsg({
      ok: r.success,
      text: r.success ? t('adb.mirrorStarted') : resultText(r, t('adb.previewNote')),
    });
    window.setTimeout(() => statusQ.reload(), 1200);
  };

  const stop = async () => {
    setBusy(true);
    setMsg(null);
    const r = await pshell("Stop-Process -Name scrcpy -Force -ErrorAction SilentlyContinue; 'ok'");
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('adb.mirrorStopped') : resultText(r, t('adb.previewNote')) });
    window.setTimeout(() => statusQ.reload(), 600);
  };

  const checkStyle = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const;

  return (
    <div>
      {live && scrcpyQ.data && !scrcpyQ.data.path && (
        <>
          <p className="mod-msg">{t('adb.scrcpyMissing')}</p>
          <WingetInstall id="Genymobile.scrcpy" label={t('adb.installScrcpy')} onDone={scrcpyQ.reload} />
        </>
      )}
      {scrcpyQ.data?.path && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot ok label={t('adb.scrcpyReady', { path: scrcpyQ.data.path })} />
        </p>
      )}

      <div className="mod-toolbar">
        <span className="count-note">{t('adb.resCap')}</span>
        <select className="mod-search" value={maxSize} onChange={(e) => setMaxSize(e.target.value)}>
          <option value="0">{t('adb.native')}</option>
          {MAX_SIZES.map((s) => (
            <option key={s} value={s}>
              {s} px
            </option>
          ))}
        </select>
        <span className="count-note">{t('adb.bitrate')}</span>
        <select className="mod-search" value={bitrate} onChange={(e) => setBitrate(e.target.value)}>
          {BITRATES.map((b) => (
            <option key={b} value={b}>
              {b} Mbps
            </option>
          ))}
        </select>
      </div>

      <div className="mod-toolbar">
        <label style={checkStyle}>
          <input type="checkbox" checked={stayAwake} onChange={(e) => setStayAwake(e.target.checked)} />
          {t('adb.stayAwake')}
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={screenOff} onChange={(e) => setScreenOff(e.target.checked)} />
          {t('adb.screenOff')}
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={showTouches} onChange={(e) => setShowTouches(e.target.checked)} />
          {t('adb.showTouches')}
        </label>
      </div>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={() => start(false)} disabled={busy || running}>
          {t('adb.startMirror')}
        </button>
        <button className="mini" onClick={stop} disabled={busy || !running}>
          {t('adb.stopMirror')}
        </button>
        <StatusDot ok={running} label={running ? t('adb.mirrorRunning') : t('adb.mirrorNotRunning')} />
        <button className="mini" onClick={statusQ.reload} disabled={busy}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('adb.recordPathPlaceholder')}
          value={recordPath}
          onChange={(e) => setRecordPath(e.target.value)}
        />
        <button
          className="mini"
          onClick={() => start(true)}
          disabled={busy || running || !recordPath.trim()}
        >
          {t('adb.recordTo')}
        </button>
      </div>

      <p className="count-note">{t('adb.mirrorHint')}</p>
    </div>
  );
}

// ── one-click winget install for a missing engine (adb / scrcpy) ────────────
function WingetInstall({ id, label, onDone }: { id: string; label: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [busyI, setBusyI] = useState(false);
  const [out, setOut] = useState('');

  const install = async () => {
    setBusyI(true);
    setOut(t('adb.installing', { id }));
    const r = await runCmdSafe('winget', [
      'install',
      '--id',
      id,
      '-e',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--disable-interactivity',
    ]);
    const tail = (r.stdout || r.stderr).trim().split('\n').slice(-6).join('\n');
    setOut(tail || `exit ${r.code}`);
    setBusyI(false);
    onDone();
  };

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini primary" onClick={install} disabled={busyI || !isTauri()}>
          {label}
        </button>
      </div>
      {out && (
        <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap' }}>
          {out}
        </pre>
      )}
    </div>
  );
}
