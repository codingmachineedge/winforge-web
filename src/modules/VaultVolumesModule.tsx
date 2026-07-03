import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershellJson, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — WinForge Vault. A de-branded front-end over an on-the-fly disk-encryption
// CLI (a VeraCrypt/TrueCrypt-derived engine). It builds the create / mount / dismount /
// wipe-cache / change-password / launch-GUI command lines and drives the engine binary through
// the desktop backend. The kernel driver needs elevation and produces no capturable output
// under UAC, so mounted state is confirmed by re-enumerating logical drives.


// (Cli, label) — de-branded, neutral strings kept as-is for both languages.
const ALGORITHMS = [
  'AES',
  'Serpent',
  'Twofish',
  'Camellia',
  'Kuznyechik',
  'AES(Twofish)',
  'AES(Twofish(Serpent))',
  'Serpent(AES)',
  'Twofish(Serpent)',
] as const;

const HASHES: { cli: string; label: string }[] = [
  { cli: 'sha512', label: 'SHA-512' },
  { cli: 'sha256', label: 'SHA-256' },
  { cli: 'whirlpool', label: 'Whirlpool' },
  { cli: 'blake2s', label: 'BLAKE2s-256' },
  { cli: 'streebog', label: 'Streebog' },
];

const UNITS = ['MB', 'GB', 'TB'] as const;

interface MountedRow {
  letter: string;
  label: string;
  fs: string;
  sizeText: string;
  freeText: string;
}

function human(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  const unit = u[i] ?? 'B';
  return `${v.toFixed(2).replace(/\.?0+$/, '')} ${unit}`;
}

// Derive the "Format" binary path (creates containers) that sits next to the mount binary.
// VeraCrypt ships "VeraCrypt Format.exe" beside "VeraCrypt.exe"; a bundled build uses the
// "WinForgeVault Format.exe" convention. We swap the base name in place.
function formatBinaryFor(mountPath: string): string {
  const idx = Math.max(mountPath.lastIndexOf('\\'), mountPath.lastIndexOf('/'));
  const dir = idx >= 0 ? mountPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? mountPath.slice(idx + 1) : mountPath;
  const dot = file.lastIndexOf('.');
  const base = dot >= 0 ? file.slice(0, dot) : file;
  const ext = dot >= 0 ? file.slice(dot) : '.exe';
  return `${dir}${base} Format${ext}`;
}

export function VaultVolumesModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // create form
  const [createPath, setCreatePath] = useState('');
  const [createSize, setCreateSize] = useState(256);
  const [createUnit, setCreateUnit] = useState(0);
  const [createAlgo, setCreateAlgo] = useState(0);
  const [createHash, setCreateHash] = useState(0);
  const [createFs, setCreateFs] = useState(0);
  const [createPim, setCreatePim] = useState(0);
  const [createKeyfile, setCreateKeyfile] = useState('');
  const [createPwd, setCreatePwd] = useState('');
  const [createDynamic, setCreateDynamic] = useState(false);
  const [createQuick, setCreateQuick] = useState(false);

  // mount form
  const [mountPath, setMountPath] = useState('');
  const [mountLetter, setMountLetter] = useState('X:');
  const [mountPim, setMountPim] = useState(0);
  const [mountKeyfile, setMountKeyfile] = useState('');
  const [mountPwd, setMountPwd] = useState('');
  const [mountReadOnly, setMountReadOnly] = useState(false);
  const [mountRemovable, setMountRemovable] = useState(false);
  const [mountExplore, setMountExplore] = useState(true);

  // mounted list + status
  const [rows, setRows] = useState<MountedRow[] | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const FS_OPTS = [
    { cli: 'FAT', label: t('vaultvol.fsFat') },
    { cli: 'NTFS', label: t('vaultvol.fsNtfs') },
    { cli: 'exFAT', label: t('vaultvol.fsExfat') },
    { cli: 'None', label: t('vaultvol.fsNone') },
  ];

  const warn = (text: string) => setStatus({ kind: 'warn', text });

  // Enumerate mountable logical drives (Fixed/Removable, excluding the system drive).
  const reload = async () => {
    if (!desktop) return;
    try {
      const list = await runPowershellJson<{
        letter: string;
        label: string;
        fs: string;
        size: number;
        free: number;
      }>(
        `$sys=$env:SystemDrive; ` +
          `Get-CimInstance Win32_LogicalDisk | Where-Object { ($_.DriveType -eq 3 -or $_.DriveType -eq 2) -and $_.DeviceID -ne $sys } | ` +
          `ForEach-Object { [pscustomobject]@{ letter=$_.DeviceID; label=[string]$_.VolumeName; fs=[string]$_.FileSystem; size=[double]$_.Size; free=[double]$_.FreeSpace } }`,
      );
      setRows(
        list.map((d) => ({
          letter: d.letter,
          label: d.label,
          fs: d.fs,
          sizeText: human(d.size),
          freeText: human(d.free),
        })),
      );
    } catch (e) {
      setRows([]);
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    }
  };

  // Run an engine command, then confirm state by re-listing drives.
  const runEngine = async (
    exe: string,
    args: string[],
    verb: string,
    okText: string,
    failText: string,
    confirmLetter?: string,
  ): Promise<void> => {
    if (busy) return;
    if (!desktop) {
      warn(t('vaultvol.desktopOnly'));
      return;
    }
    setBusy(true);
    try {
      let res: CommandOutput | null = null;
      try {
        res = await runCommand(exe, args);
      } catch (e) {
        setStatus({ kind: 'err', text: `${verb}: ${String(e instanceof Error ? e.message : e)}` });
        return;
      }
      // Re-list to confirm; the driver gives no output under UAC.
      let mounted = false;
      if (confirmLetter) {
        try {
          const list = await runPowershellJson<{ id: string }>(
            `Get-CimInstance Win32_LogicalDisk | ForEach-Object { [pscustomobject]@{ id=$_.DeviceID } }`,
          );
          mounted = list.some((d) => d.id.toUpperCase().startsWith(confirmLetter.toUpperCase()));
        } catch {
          mounted = false;
        }
      }
      if (confirmLetter && mounted) {
        setStatus({ kind: 'ok', text: okText });
      } else if (res.success) {
        setStatus({ kind: 'ok', text: okText });
      } else {
        setStatus({ kind: 'err', text: (res.stderr || res.stdout).trim() || failText });
      }
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const quote = (s: string) => s.replace(/"/g, '');

  // ---- create ----
  const doCreate = async (mountExe: string) => {
    if (!createPath.trim()) {
      warn(t('vaultvol.needCreatePath'));
      return;
    }
    if (!createPwd) {
      warn(t('vaultvol.needCreatePwd'));
      return;
    }
    const unit = UNITS[createUnit] ?? 'MB';
    const mult = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
    const bytes = Math.round(createSize * mult);
    if (bytes < 292 * 1024) {
      warn(t('vaultvol.tooSmall'));
      return;
    }
    const algo = ALGORITHMS[createAlgo] ?? 'AES';
    const hash = HASHES[createHash]?.cli ?? 'sha512';
    const fs = FS_OPTS[createFs]?.cli ?? 'FAT';

    const exe = formatBinaryFor(mountExe);
    const args = ['/create', quote(createPath.trim()), '/size', String(bytes), '/password', createPwd, '/encryption', algo, '/hash', hash, '/filesystem', fs];
    if (createPim > 0) args.push('/pim', String(createPim));
    if (createKeyfile.trim()) args.push('/keyfile', quote(createKeyfile.trim()));
    if (createDynamic) args.push('/dynamic', '1');
    if (createQuick) args.push('/quick');
    args.push('/silent', '/force', '/noisocheck');

    await runEngine(
      exe,
      args,
      t('vaultvol.createVerb'),
      t('vaultvol.createOk', { size: human(bytes) }),
      t('vaultvol.createFail'),
    );
    if (!mountPath.trim()) setMountPath(createPath.trim());
    setCreatePwd('');
  };

  // ---- mount ----
  const doMount = async (exe: string) => {
    if (!mountPath.trim()) {
      warn(t('vaultvol.needMountPath'));
      return;
    }
    const letterChar = mountLetter.charAt(0).toUpperCase();
    if (!letterChar) {
      warn(t('vaultvol.needLetter'));
      return;
    }
    if (!mountPwd) {
      warn(t('vaultvol.needMountPwd'));
      return;
    }
    const args = ['/v', quote(mountPath.trim()), '/l', letterChar, '/p', mountPwd];
    if (mountPim > 0) args.push('/pim', String(mountPim));
    if (mountKeyfile.trim()) args.push('/k', quote(mountKeyfile.trim()));
    if (mountReadOnly) args.push('/m', 'ro');
    if (mountRemovable) args.push('/m', 'rm');
    if (mountExplore) args.push('/e');
    args.push('/q', '/silent');

    await runEngine(
      exe,
      args,
      t('vaultvol.mountVerb'),
      t('vaultvol.mountOk', { letter: letterChar }),
      t('vaultvol.mountFail'),
      `${letterChar}:`,
    );
    setMountPwd('');
  };

  // ---- dismount ----
  const doDismount = async (exe: string, letter: string, force: boolean) => {
    const c = letter.charAt(0).toUpperCase();
    const args = ['/q', '/d', c];
    if (force) args.push('/f');
    await runEngine(
      exe,
      args,
      force ? t('vaultvol.forceDismountVerb') : t('vaultvol.dismountVerb'),
      force ? t('vaultvol.forceDismountOk', { letter: c }) : t('vaultvol.dismountOk', { letter: c }),
      t('vaultvol.dismountFail', { letter: c }),
    );
  };

  const doDismountAll = async (exe: string) => {
    await runEngine(
      exe,
      ['/q', '/d'],
      t('vaultvol.dismountAllVerb'),
      t('vaultvol.dismountAllOk'),
      t('vaultvol.dismountAllFail'),
    );
  };

  const doWipeCache = async (exe: string) => {
    await runEngine(exe, ['/q', '/w'], t('vaultvol.wipeVerb'), t('vaultvol.wipeOk'), t('vaultvol.wipeFail'));
  };

  const doExplore = async (letter: string) => {
    if (!desktop) return;
    const c = letter.charAt(0).toUpperCase();
    try {
      await runCommand('explorer.exe', [`${c}:\\`]);
    } catch {
      /* ignore — explorer returns non-zero even on success */
    }
  };

  const doChangePwd = async (exe: string) => {
    if (!mountPath.trim()) {
      warn(t('vaultvol.needChangePath'));
      return;
    }
    if (!desktop) {
      warn(t('vaultvol.desktopOnly'));
      return;
    }
    try {
      await runCommand(exe, ['/v', quote(mountPath.trim())]);
      setStatus({ kind: 'ok', text: t('vaultvol.changePwdOk') });
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    }
  };

  const doLaunchGui = async (exe: string) => {
    if (!desktop) {
      warn(t('vaultvol.desktopOnly'));
      return;
    }
    try {
      await runCommand(exe, []);
      setStatus({ kind: 'ok', text: t('vaultvol.launchOk') });
    } catch (e) {
      setStatus({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    }
  };

  const statusClass = (kind: 'ok' | 'err' | 'warn') =>
    kind === 'ok' ? 'dep-ok' : kind === 'err' ? 'error' : 'count-note';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vaultvol.blurb')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('vaultvol.desktopOnly')}
        </p>
      )}

      <DependencyGate tool="veracrypt" preferId="VeraCrypt.VeraCrypt" query="veracrypt">
        {(exe) => (
          <>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <button className="mini" disabled={busy} onClick={() => void reload()}>
                {t('vaultvol.refresh')}
              </button>
              <button className="mini" disabled={busy} onClick={() => void doChangePwd(exe)}>
                {t('vaultvol.changePwd')}
              </button>
              <button className="mini" disabled={busy} onClick={() => void doLaunchGui(exe)}>
                {t('vaultvol.benchmark')}
              </button>
              <button className="mini" disabled={busy} onClick={() => void doWipeCache(exe)}>
                {t('vaultvol.wipeCache')}
              </button>
              <button className="mini" disabled={busy} onClick={() => void doDismountAll(exe)}>
                {t('vaultvol.dismountAll')}
              </button>
            </div>

            {status && (
              <p className={statusClass(status.kind)} style={{ marginTop: 8 }}>
                {status.text}
              </p>
            )}

            {/* ---------- create ---------- */}
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>
                {t('vaultvol.createHeader')}
              </div>
              <div className="io-grid">
                <input
                  className="mod-search"
                  placeholder={t('vaultvol.containerPath')}
                  value={createPath}
                  onChange={(e) => setCreatePath(e.target.value)}
                />
                <input
                  className="mod-search"
                  placeholder={t('vaultvol.keyfile')}
                  value={createKeyfile}
                  onChange={(e) => setCreateKeyfile(e.target.value)}
                />
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <label className="count-note">{t('vaultvol.size')}</label>
                <input
                  className="mod-search"
                  type="number"
                  min={1}
                  style={{ maxWidth: 90 }}
                  value={createSize}
                  onChange={(e) => setCreateSize(Math.max(1, +e.target.value))}
                />
                <select className="mod-select" value={createUnit} onChange={(e) => setCreateUnit(+e.target.value)}>
                  {UNITS.map((u, i) => (
                    <option key={u} value={i}>
                      {u}
                    </option>
                  ))}
                </select>
                <label className="count-note">{t('vaultvol.encryption')}</label>
                <select className="mod-select" value={createAlgo} onChange={(e) => setCreateAlgo(+e.target.value)}>
                  {ALGORITHMS.map((a, i) => (
                    <option key={a} value={i}>
                      {a}
                    </option>
                  ))}
                </select>
                <label className="count-note">{t('vaultvol.hash')}</label>
                <select className="mod-select" value={createHash} onChange={(e) => setCreateHash(+e.target.value)}>
                  {HASHES.map((h, i) => (
                    <option key={h.cli} value={i}>
                      {h.label}
                    </option>
                  ))}
                </select>
                <label className="count-note">{t('vaultvol.fileSystem')}</label>
                <select className="mod-select" value={createFs} onChange={(e) => setCreateFs(+e.target.value)}>
                  {FS_OPTS.map((f, i) => (
                    <option key={f.cli} value={i}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <label className="count-note">{t('vaultvol.pim')}</label>
                <input
                  className="mod-search"
                  type="number"
                  min={0}
                  style={{ maxWidth: 80 }}
                  value={createPim}
                  onChange={(e) => setCreatePim(Math.max(0, +e.target.value))}
                />
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <input
                  className="mod-search"
                  type="password"
                  placeholder={t('vaultvol.volumePassword')}
                  style={{ maxWidth: 220 }}
                  value={createPwd}
                  onChange={(e) => setCreatePwd(e.target.value)}
                />
                <label className="chk">
                  <input type="checkbox" checked={createDynamic} onChange={(e) => setCreateDynamic(e.target.checked)} />
                  {t('vaultvol.dynamic')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={createQuick} onChange={(e) => setCreateQuick(e.target.checked)} />
                  {t('vaultvol.quickFormat')}
                </label>
                <button className="mini primary" disabled={busy} onClick={() => void doCreate(exe)}>
                  {t('vaultvol.create')}
                </button>
              </div>
            </div>

            {/* ---------- mount ---------- */}
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>
                {t('vaultvol.mountHeader')}
              </div>
              <div className="io-grid">
                <input
                  className="mod-search"
                  placeholder={t('vaultvol.mountPath')}
                  value={mountPath}
                  onChange={(e) => setMountPath(e.target.value)}
                />
                <input
                  className="mod-search"
                  placeholder={t('vaultvol.keyfile')}
                  value={mountKeyfile}
                  onChange={(e) => setMountKeyfile(e.target.value)}
                />
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <label className="count-note">{t('vaultvol.driveLetter')}</label>
                <input
                  className="mod-search"
                  style={{ maxWidth: 70 }}
                  value={mountLetter}
                  onChange={(e) => setMountLetter(e.target.value)}
                />
                <label className="count-note">{t('vaultvol.pim')}</label>
                <input
                  className="mod-search"
                  type="number"
                  min={0}
                  style={{ maxWidth: 80 }}
                  value={mountPim}
                  onChange={(e) => setMountPim(Math.max(0, +e.target.value))}
                />
                <input
                  className="mod-search"
                  type="password"
                  placeholder={t('vaultvol.volumePassword')}
                  style={{ maxWidth: 220 }}
                  value={mountPwd}
                  onChange={(e) => setMountPwd(e.target.value)}
                />
              </div>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <label className="chk">
                  <input type="checkbox" checked={mountReadOnly} onChange={(e) => setMountReadOnly(e.target.checked)} />
                  {t('vaultvol.readOnly')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={mountRemovable} onChange={(e) => setMountRemovable(e.target.checked)} />
                  {t('vaultvol.removable')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={mountExplore} onChange={(e) => setMountExplore(e.target.checked)} />
                  {t('vaultvol.openExplorer')}
                </label>
                <button className="mini primary" disabled={busy} onClick={() => void doMount(exe)}>
                  {t('vaultvol.mount')}
                </button>
              </div>
            </div>

            {/* ---------- mounted list ---------- */}
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 8 }}>
                {t('vaultvol.mountedHeader')}
              </div>
              {rows === null ? (
                <p className="count-note">{t('vaultvol.hiddenHint')}</p>
              ) : rows.length === 0 ? (
                <p className="count-note">{t('vaultvol.emptyHint')}</p>
              ) : (
                <div className="dt-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>{t('vaultvol.colDrive')}</th>
                        <th>{t('vaultvol.colFs')}</th>
                        <th>{t('vaultvol.colFree')}</th>
                        <th>{t('vaultvol.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.letter}>
                          <td style={{ fontFamily: 'monospace' }}>
                            {r.label ? `${r.letter}  ${r.label}` : r.letter}
                          </td>
                          <td>{r.fs}</td>
                          <td>{t('vaultvol.freeOf', { free: r.freeText, size: r.sizeText })}</td>
                          <td>
                            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                              <button className="mini" disabled={busy} onClick={() => void doExplore(r.letter)}>
                                {t('vaultvol.browse')}
                              </button>
                              <button className="mini" disabled={busy} onClick={() => void doDismount(exe, r.letter, false)}>
                                {t('vaultvol.dismount')}
                              </button>
                              <button className="mini" disabled={busy} onClick={() => void doDismount(exe, r.letter, true)}>
                                {t('vaultvol.forceDismount')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
