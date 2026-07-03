import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Android Emulator & SDK — module.emulator — native web port of WinForge's
// EmulatorModule (Pages/EmulatorModule.xaml.cs + Services/EmulatorService.cs).
//
// The desktop original drove the real Android SDK command-line tools:
//   • emulator.exe        — launch / stop AVDs
//   • avdmanager.bat      — list / create / delete AVDs
//   • sdkmanager.bat      — list / install / update / uninstall SDK packages,
//                           accept licenses, channel select
// Here we do the same through the Tauri backend via runCommand (no PowerShell
// quoting games), after resolving the SDK root the same way EmulatorService did:
// ANDROID_SDK_ROOT / ANDROID_HOME / %LOCALAPPDATA%\Android\Sdk. A single
// PowerShell probe finds the tool paths + a JDK; everything else is runCommand.
//
// Two tabs, mirroring the original Pivot:
//   • Virtual Devices (AVDs): list / create / launch / stop / wipe / delete
//   • SDK Packages: channel, accept licenses, update-all, quick install,
//     filter + install/update/uninstall, live console
// Read-only by default; wipe / delete / uninstall are gated behind confirm()
// and never auto-run.
// ============================================================================

interface SdkProbe {
  root: string;
  emulator: string;
  avdmanager: string;
  sdkmanager: string;
  hasJava: boolean;
}

interface Avd {
  Name: string;
  Device: string;
  Target: string;
}

interface SdkPackage {
  Path: string;
  Version: string;
  Description: string;
  Installed: boolean;
  Category: string;
}

const TABS = ['avds', 'sdk'] as const;
type Tab = (typeof TABS)[number];

// Release channels passed to sdkmanager via --channel.
const CHANNELS = [0, 1, 2, 3] as const;

// Category display order + labels (from WinForge Catalog/SdkOperations.cs).
const CATEGORY_ORDER = [
  'platform-tools',
  'cmdline-tools',
  'emulator',
  'platforms',
  'build-tools',
  'system-images',
  'ndk',
  'sources',
  'extras',
  'other',
] as const;

// Curated quick-install ids (from SdkOperations.QuickInstall).
const QUICK_INSTALL = [
  'platform-tools',
  'cmdline-tools;latest',
  'emulator',
  'platforms;android-34',
  'build-tools;34.0.0',
  'system-images;android-34;google_apis;x86_64',
] as const;

// PowerShell that locates the SDK root + the three tools + a JDK, exactly as
// EmulatorService did, and emits a single JSON object.
const PROBE_SCRIPT = String.raw`
$ErrorActionPreference='SilentlyContinue'
function FindFirst($base, $exe) {
  if (-not (Test-Path $base)) { return '' }
  $direct = Join-Path $base $exe
  if (Test-Path $direct) { return $direct }
  foreach ($d in Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue) {
    $cand = Join-Path $d.FullName (Join-Path 'bin' $exe)
    if (Test-Path $cand) { return $cand }
  }
  return ''
}
$root = ''
foreach ($v in @('ANDROID_SDK_ROOT','ANDROID_HOME')) {
  $p = [Environment]::GetEnvironmentVariable($v)
  if ($p -and (Test-Path $p)) { $root = $p; break }
}
if (-not $root) {
  $def = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
  if (Test-Path $def) { $root = $def }
}
$emu=''; $avd=''; $sdk=''
if ($root) {
  $e = Join-Path $root 'emulator\emulator.exe'
  if (Test-Path $e) { $emu = $e }
  $avd = FindFirst (Join-Path $root 'cmdline-tools') 'avdmanager.bat'
  $sdk = FindFirst (Join-Path $root 'cmdline-tools') 'sdkmanager.bat'
}
$hasJava = $false
$jh = [Environment]::GetEnvironmentVariable('JAVA_HOME')
if ($jh -and (Test-Path (Join-Path $jh 'bin\java.exe'))) { $hasJava = $true }
if (-not $hasJava -and $root) {
  foreach ($sub in @('jbr','jre')) {
    if (Test-Path (Join-Path $root (Join-Path $sub 'bin\java.exe'))) { $hasJava = $true; break }
  }
}
if (-not $hasJava) { if (Get-Command java.exe -ErrorAction SilentlyContinue) { $hasJava = $true } }
[pscustomobject]@{ root=$root; emulator=$emu; avdmanager=$avd; sdkmanager=$sdk; hasJava=$hasJava } | ConvertTo-Json -Compress
`;

function categoryOf(path: string): string {
  const head = (path.split(';')[0] ?? '').trim();
  if (head === 'ndk-bundle') return 'ndk';
  if ((CATEGORY_ORDER as readonly string[]).includes(head)) return head;
  return head.length > 0 ? head : 'other';
}

// Parse a sdkmanager --list / --list_installed pipe-delimited table.
function parseList(output: string, installed: boolean): SdkPackage[] {
  const res: SdkPackage[] = [];
  if (!output) return res;
  for (const raw of output.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.includes('|')) continue;
    const cols = line.split('|');
    const path = (cols[0] ?? '').trim();
    if (path.length === 0) continue;
    if (/^path$/i.test(path) || /^id$/i.test(path)) continue;
    // A valid package id has no spaces in its first token.
    if (path.includes(' ')) continue;
    res.push({
      Path: path,
      Version: (cols[1] ?? '').trim(),
      Description: (cols[2] ?? '').trim(),
      Installed: installed,
      Category: categoryOf(path),
    });
  }
  return res;
}

// Parse `avdmanager list avd` free-text output into rows.
function parseAvds(output: string): Avd[] {
  const res: Avd[] = [];
  let cur: Avd | null = null;
  for (const raw of output.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^name:/i.test(line)) {
      if (cur) res.push(cur);
      cur = { Name: line.slice('name:'.length).trim(), Device: '', Target: '' };
    } else if (cur && /^device:/i.test(line)) {
      cur.Device = line.slice('device:'.length).trim();
    } else if (cur && /^target:/i.test(line)) {
      cur.Target = line.slice('target:'.length).trim();
    }
  }
  if (cur) res.push(cur);
  return res;
}

async function run(exe: string, args: string[]): Promise<CommandOutput> {
  if (!isTauri() || !exe) return { stdout: '', stderr: '', code: -1, success: false };
  try {
    return await runCommand(exe, args);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

export function EmulatorModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('avds');

  const probeQ = useAsync<SdkProbe>(async () => {
    if (!isTauri()) {
      return { root: '', emulator: '', avdmanager: '', sdkmanager: '', hasJava: false };
    }
    const r = await runPowershell(PROBE_SCRIPT);
    const text = r.stdout.trim();
    if (!text) return { root: '', emulator: '', avdmanager: '', sdkmanager: '', hasJava: false };
    return JSON.parse(text) as SdkProbe;
  }, []);

  const probe = probeQ.data;
  const ready = !!probe && probe.emulator.length > 0 && probe.avdmanager.length > 0;

  // Health message mirrors EmulatorService.Health().
  const health = useMemo(() => {
    if (!probe) return null;
    if (probe.root.length === 0) return { ok: false, msg: t('emulator.healthNoSdk') };
    if (probe.emulator.length === 0)
      return { ok: false, msg: t('emulator.healthNoEmulator', { root: probe.root }) };
    if (probe.avdmanager.length === 0)
      return { ok: false, msg: t('emulator.healthNoTools', { root: probe.root }) };
    return { ok: true, msg: t('emulator.healthOk', { root: probe.root }) };
  }, [probe, t]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('emulator.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={probeQ.reload} disabled={probeQ.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {probe && probe.root.length > 0
            ? t('emulator.sdkRoot', { root: probe.root })
            : t('emulator.sdkRootMissing')}
        </span>
      </ModuleToolbar>

      <AsyncState loading={probeQ.loading} error={probeQ.error}>
        {health && (
          <p className="mod-msg">
            <StatusDot ok={health.ok} label={health.msg} />
          </p>
        )}
        {probe && ready && !probe.hasJava && (
          <p className="count-note">{t('emulator.needJava')}</p>
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
              {t(`emulator.tab.${id}`)}
            </button>
          ))}
        </div>

        <div className="mod-tabpanel" role="tabpanel">
          {tab === 'avds' && <AvdTab probe={probe} ready={ready} />}
          {tab === 'sdk' && <SdkTab probe={probe} />}
        </div>
      </AsyncState>
    </div>
  );
}

// ── Virtual Devices (AVDs) tab ──────────────────────────────────────────────
function AvdTab({ probe, ready }: { probe: SdkProbe | null; ready: boolean }) {
  const { t } = useTranslation();
  const [coldBoot, setColdBoot] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Create-AVD form state.
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newImage, setNewImage] = useState('');
  const [newDevice, setNewDevice] = useState('');
  const [images, setImages] = useState<string[]>([]);

  const avdmanager = probe?.avdmanager ?? '';
  const emulator = probe?.emulator ?? '';

  const avdsQ = useAsync<Avd[]>(async () => {
    if (!avdmanager) return [];
    const r = await run(avdmanager, ['list', 'avd']);
    return parseAvds(r.stdout);
  }, [avdmanager]);

  const avds = avdsQ.data ?? [];
  const activeName = useMemo(() => {
    if (selected && avds.some((a) => a.Name === selected)) return selected;
    return avds[0]?.Name ?? null;
  }, [selected, avds]);

  const requirePick = (): string | null => {
    if (!activeName) {
      setMsg({ ok: false, text: t('emulator.pickAvd') });
      return null;
    }
    return activeName;
  };

  const openCreate = useCallback(async () => {
    if (!probe?.sdkmanager) {
      setMsg({ ok: false, text: t('emulator.noSdkmanager') });
      return;
    }
    setBusy(true);
    setMsg(null);
    // Installed system images an AVD can be created against.
    const r = await run(probe.sdkmanager, ['--list_installed']);
    setBusy(false);
    const imgs: string[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (/^system-images;/i.test(line)) {
        const pkg = line.split(/[\s|]+/).filter(Boolean)[0];
        if (pkg) imgs.push(pkg);
      }
    }
    if (imgs.length === 0) {
      setMsg({ ok: false, text: t('emulator.noImages') });
      return;
    }
    setImages(imgs);
    setNewImage(imgs[0] ?? '');
    setShowCreate(true);
  }, [probe, t]);

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setMsg({ ok: false, text: t('emulator.nameRequired') });
      return;
    }
    if (!newImage) return;
    setBusy(true);
    setMsg(null);
    // avdmanager prompts "create a custom hardware profile?"; answer no via stdin
    // isn't available through runCommand, so pass --force and rely on defaults.
    const args = ['create', 'avd', '--name', name, '--package', newImage, '--force'];
    const dev = newDevice.trim();
    if (dev) args.push('--device', dev);
    const r = await run(avdmanager, args);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('emulator.created', { name }) : (r.stderr || r.stdout).trim() });
    if (r.success) {
      setShowCreate(false);
      setNewName('');
      setNewDevice('');
      avdsQ.reload();
    }
  };

  const launch = async () => {
    const name = requirePick();
    if (!name) return;
    if (!emulator) {
      setMsg({ ok: false, text: t('emulator.noEmulator') });
      return;
    }
    setBusy(true);
    setMsg(null);
    const args = ['-avd', name];
    if (coldBoot) args.push('-no-snapshot-load');
    // The emulator runs long; fire it and report launch without awaiting exit.
    run(emulator, args);
    setBusy(false);
    setMsg({ ok: true, text: t('emulator.launching', { name }) });
  };

  const stop = async () => {
    setBusy(true);
    setMsg(null);
    // adb emu kill stops the most recently started emulator console.
    const r = await run('adb', ['emu', 'kill']);
    setBusy(false);
    setMsg({ ok: true, text: r.success ? t('emulator.stopped') : t('emulator.stopAttempted') });
  };

  const wipe = async () => {
    const name = requirePick();
    if (!name) return;
    if (!confirm(t('emulator.confirmWipe', { name }))) return;
    if (!emulator) {
      setMsg({ ok: false, text: t('emulator.noEmulator') });
      return;
    }
    setBusy(true);
    setMsg(null);
    // Documented wipe: launch with -wipe-data + cold boot.
    run(emulator, ['-avd', name, '-wipe-data', '-no-snapshot-load']);
    setBusy(false);
    setMsg({ ok: true, text: t('emulator.wiping', { name }) });
  };

  const del = async () => {
    const name = requirePick();
    if (!name) return;
    if (!confirm(t('emulator.confirmDelete', { name }))) return;
    setBusy(true);
    setMsg(null);
    const r = await run(avdmanager, ['delete', 'avd', '--name', name]);
    setBusy(false);
    setMsg({ ok: r.success, text: r.success ? t('emulator.deleted', { name }) : (r.stderr || r.stdout).trim() });
    if (r.success) avdsQ.reload();
  };

  const columns: Column<Avd>[] = [
    {
      key: 'sel',
      header: '',
      width: 40,
      render: (a) => (
        <input
          type="radio"
          name="avd-pick"
          checked={activeName === a.Name}
          onChange={() => setSelected(a.Name)}
        />
      ),
    },
    {
      key: 'Name',
      header: t('emulator.avdName'),
      render: (a) => (
        <span
          style={{ cursor: 'pointer', fontWeight: 600 }}
          onClick={() => setSelected(a.Name)}
        >
          {a.Name}
          {a.Device ? ` · ${a.Device}` : ''}
        </span>
      ),
    },
    { key: 'Target', header: t('emulator.avdTarget'), render: (a) => a.Target || '—' },
  ];

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" onClick={avdsQ.reload} disabled={busy || avdsQ.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini primary" onClick={openCreate} disabled={busy || !ready}>
          {t('emulator.createAvd')}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={coldBoot} onChange={(e) => setColdBoot(e.target.checked)} />
          {t('emulator.coldBoot')}
        </label>
        <span className="count-note">{t('emulator.avdCount', { num: avds.length })}</span>
      </div>

      {showCreate && (
        <div className="hosts-edit" style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
          <input
            className="mod-search"
            placeholder={t('emulator.avdNamePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select className="mod-search" value={newImage} onChange={(e) => setNewImage(e.target.value)}>
            {images.map((im) => (
              <option key={im} value={im}>
                {im}
              </option>
            ))}
          </select>
          <input
            className="mod-search"
            placeholder={t('emulator.devicePlaceholder')}
            value={newDevice}
            onChange={(e) => setNewDevice(e.target.value)}
          />
          <div className="mod-toolbar" style={{ marginTop: 0 }}>
            <button className="mini primary" onClick={doCreate} disabled={busy || !newName.trim()}>
              {t('emulator.create')}
            </button>
            <button className="mini" onClick={() => setShowCreate(false)} disabled={busy}>
              {t('emulator.cancel')}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <pre className={`cmd-out${msg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </pre>
      )}

      <AsyncState loading={avdsQ.loading} error={avdsQ.error}>
        <DataTable columns={columns} rows={avds} rowKey={(a) => a.Name} empty={t('emulator.noAvds')} />
      </AsyncState>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={launch} disabled={busy || !activeName}>
          {t('emulator.launch')}
        </button>
        <button className="mini" onClick={stop} disabled={busy}>
          {t('emulator.stop')}
        </button>
        <button className="mini" onClick={wipe} disabled={busy || !activeName}>
          {t('emulator.wipe')}
        </button>
        <button className="mini" onClick={del} disabled={busy || !activeName}>
          {t('emulator.delete')}
        </button>
      </div>
    </div>
  );
}

// ── SDK Packages tab ────────────────────────────────────────────────────────
function SdkTab({ probe }: { probe: SdkProbe | null }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState(0);
  const [filter, setFilter] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [quick, setQuick] = useState<string>(QUICK_INSTALL[0]);
  const [console, setConsole] = useState('');
  const [busy, setBusy] = useState(false);

  const sdkmanager = probe?.sdkmanager ?? '';
  const channelArg = channel >= 0 && channel <= 3 ? [`--channel=${channel}`] : [];

  const append = useCallback((text: string) => {
    setConsole((c) => (c.length > 0 ? c + '\n' : '') + text);
  }, []);

  const pkgsQ = useAsync<SdkPackage[]>(async () => {
    if (!sdkmanager) return [];
    const inst = await run(sdkmanager, ['--list_installed']);
    const installed = parseList(inst.stdout, true);
    const installedIds = new Set(installed.map((p) => p.Path.toLowerCase()));
    const avail = await run(sdkmanager, ['--list', ...channelArg]);
    const byPath = new Map<string, SdkPackage>();
    for (const p of parseList(avail.stdout, false)) {
      p.Installed = installedIds.has(p.Path.toLowerCase());
      byPath.set(p.Path.toLowerCase(), p);
    }
    for (const p of installed) {
      if (!byPath.has(p.Path.toLowerCase())) byPath.set(p.Path.toLowerCase(), p);
    }
    return [...byPath.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkmanager, channel]);

  const all = pkgsQ.data ?? [];
  const installedCount = all.filter((p) => p.Installed).length;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let items = all;
    if (installedOnly) items = items.filter((p) => p.Installed);
    if (q.length > 0) {
      items = items.filter(
        (p) =>
          p.Path.toLowerCase().includes(q) ||
          p.Description.toLowerCase().includes(q) ||
          p.Category.includes(q),
      );
    }
    const order = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
    return [...items].sort((a, b) => {
      const oa = order.get(a.Category as (typeof CATEGORY_ORDER)[number]) ?? 999;
      const ob = order.get(b.Category as (typeof CATEGORY_ORDER)[number]) ?? 999;
      if (oa !== ob) return oa - ob;
      if (a.Installed !== b.Installed) return a.Installed ? -1 : 1;
      return a.Path.localeCompare(b.Path);
    });
  }, [all, filter, installedOnly]);

  const activePath = useMemo(() => {
    if (selected && rows.some((p) => p.Path === selected)) return selected;
    return null;
  }, [selected, rows]);

  const guardSdk = (): boolean => {
    if (!sdkmanager) {
      append(t('emulator.noSdkmanager'));
      return false;
    }
    return true;
  };

  const finish = (label: string, r: CommandOutput) => {
    const body = (r.stdout || r.stderr).trim();
    if (body) append(body);
    append((r.success ? '✓ ' : '✗ ') + label);
  };

  const acceptLicenses = async () => {
    if (!guardSdk()) return;
    setBusy(true);
    append('$ sdkmanager --licenses');
    const r = await run(sdkmanager, ['--licenses']);
    setBusy(false);
    finish(t('emulator.licensesDone'), r);
  };

  const updateAll = async () => {
    if (!guardSdk()) return;
    setBusy(true);
    append('$ sdkmanager --update');
    const r = await run(sdkmanager, ['--update', ...channelArg]);
    setBusy(false);
    finish(t('emulator.updateDone'), r);
    pkgsQ.reload();
  };

  const install = async (id: string) => {
    if (!id) {
      append(t('emulator.pickPackage'));
      return;
    }
    if (!guardSdk()) return;
    setBusy(true);
    append(`$ sdkmanager "${id}"`);
    const r = await run(sdkmanager, [...channelArg, id]);
    setBusy(false);
    finish(t('emulator.installDone', { id }), r);
    pkgsQ.reload();
  };

  const uninstall = async () => {
    if (!activePath) {
      append(t('emulator.pickPackage'));
      return;
    }
    const pkg = rows.find((p) => p.Path === activePath);
    if (!pkg?.Installed) {
      append(t('emulator.notInstalled'));
      return;
    }
    if (!confirm(t('emulator.confirmUninstall', { id: activePath }))) return;
    if (!guardSdk()) return;
    setBusy(true);
    append(`$ sdkmanager --uninstall "${activePath}"`);
    const r = await run(sdkmanager, ['--uninstall', activePath]);
    setBusy(false);
    finish(t('emulator.uninstallDone', { id: activePath }), r);
    pkgsQ.reload();
  };

  const columns: Column<SdkPackage>[] = [
    {
      key: 'sel',
      header: '',
      width: 40,
      render: (p) => (
        <input
          type="radio"
          name="pkg-pick"
          checked={activePath === p.Path}
          onChange={() => setSelected(p.Path)}
        />
      ),
    },
    {
      key: 'Installed',
      header: '',
      width: 34,
      align: 'center',
      render: (p) => (p.Installed ? <span style={{ color: 'var(--ok, #3fb950)' }}>✓</span> : null),
    },
    {
      key: 'Path',
      header: t('emulator.pkgPath'),
      render: (p) => (
        <span
          style={{ cursor: 'pointer', fontFamily: 'monospace', fontWeight: 600 }}
          onClick={() => setSelected(p.Path)}
        >
          {p.Path}
          {p.Description ? (
            <span style={{ display: 'block', fontWeight: 400, opacity: 0.7, fontFamily: 'inherit' }}>
              {p.Description}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'Version', header: t('emulator.pkgVersion'), width: 110 },
  ];

  return (
    <div>
      <div className="mod-toolbar">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {t('emulator.channelLabel')}
          <select className="mod-search" value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(`emulator.channel.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <button className="mini" onClick={pkgsQ.reload} disabled={busy || pkgsQ.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini primary" onClick={acceptLicenses} disabled={busy}>
          {t('emulator.acceptLicenses')}
        </button>
        <button className="mini" onClick={updateAll} disabled={busy}>
          {t('emulator.updateAll')}
        </button>
      </div>

      <div className="mod-toolbar">
        <select className="mod-search" value={quick} onChange={(e) => setQuick(e.target.value)} style={{ minWidth: 260 }}>
          {QUICK_INSTALL.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button className="mini" onClick={() => install(quick)} disabled={busy}>
          {t('emulator.quickInstall')}
        </button>
      </div>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('emulator.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} />
          {t('emulator.installedOnly')}
        </label>
        <button
          className="mini primary"
          onClick={() => activePath && install(activePath)}
          disabled={busy || !activePath}
        >
          {t('emulator.installUpdate')}
        </button>
        <button className="mini" onClick={uninstall} disabled={busy || !activePath}>
          {t('emulator.uninstall')}
        </button>
      </div>

      <p className="count-note">
        {t('emulator.pkgCount', { num: all.length, installed: installedCount })}
      </p>

      <AsyncState loading={pkgsQ.loading} error={pkgsQ.error}>
        <DataTable columns={columns} rows={rows} rowKey={(p) => p.Path} empty={t('emulator.noPackages')} />
      </AsyncState>

      {console && (
        <div style={{ marginTop: 8 }}>
          <div className="mod-toolbar" style={{ marginTop: 0 }}>
            <button className="mini" onClick={() => setConsole('')}>
              {t('emulator.clearConsole')}
            </button>
          </div>
          <pre className="cmd-out" style={{ maxHeight: 200, overflow: 'auto' }}>
            {console}
          </pre>
        </div>
      )}
    </div>
  );
}
