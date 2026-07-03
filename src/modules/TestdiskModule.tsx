import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — drives cgsecurity's photorec_win.exe / testdisk_win.exe CLIs (data recovery).
// Enumerates physical disks via PowerShell (Get-Disk), enforces recover-to-a-DIFFERENT-disk,
// carves lost files non-interactively with PhotoRec's /cmd script grammar, and runs a TestDisk
// read-only partition listing. The interactive ncurses TUI is never launched. Fully bilingual.
//
// The DependencyGate resolves the `photorec` binary; testdisk_win.exe lives beside it, so we
// derive the testdisk path from the photorec path's folder.

interface DiskRow {
  Number: number;
  Model: string;
  Size: number;
  BusType: string;
  Removable: boolean;
  IsBoot: boolean;
  IsSystem: boolean;
  Letters: string[] | string | null;
  HasSysDrive: boolean;
}

interface DiskSource {
  isDisk: boolean;
  diskNumber: number;
  devicePath: string;
  model: string;
  size: number;
  busType: string;
  removable: boolean;
  isSystem: boolean;
  letters: string[];
}

interface FileType {
  token: string;
  desc: string;
  selected: boolean;
}

const DEFAULT_TYPES: Array<[string, string, boolean]> = [
  ['jpg', 'JPG picture', true],
  ['png', 'PNG picture', true],
  ['gif', 'GIF image', true],
  ['tiff', 'TIFF image', true],
  ['bmp', 'BMP bitmap', true],
  ['heic', 'HEIC/HEIF photo', true],
  ['raw', 'Camera RAW (CR2/NEF/ARW)', true],
  ['pdf', 'PDF document', true],
  ['doc', 'MS Office (legacy doc/xls/ppt)', true],
  ['docx', 'Office Open XML / ZIP', true],
  ['txt', 'Plain text', false],
  ['rtf', 'Rich Text', true],
  ['zip', 'ZIP archive', true],
  ['rar', 'RAR archive', true],
  ['7z', '7-Zip archive', true],
  ['gz', 'gzip archive', true],
  ['tar', 'TAR archive', true],
  ['mp4', 'MP4 / MOV video', true],
  ['mov', 'QuickTime video', true],
  ['avi', 'AVI video', true],
  ['mkv', 'Matroska video', true],
  ['mp3', 'MP3 audio', true],
  ['wav', 'WAV audio', true],
  ['flac', 'FLAC audio', true],
  ['ogg', 'OGG audio', true],
  ['sqlite', 'SQLite database', false],
  ['html', 'HTML page', false],
  ['exe', 'Windows executable', false],
];

function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]!}`;
}

function sourceDisplay(s: DiskSource): string {
  if (!s.isDisk) {
    const name = s.devicePath.split(/[\\/]/).pop() || s.devicePath;
    return `📄 ${name}  ·  ${humanSize(s.size)}`;
  }
  const letters = s.letters.length > 0 ? ` [${s.letters.join(' ')}]` : '';
  const flags = s.isSystem ? '  ⚠ SYSTEM' : s.removable ? '' : '  (fixed)';
  return `💽 Disk ${s.diskNumber} · ${s.model} · ${humanSize(s.size)} · ${s.busType}${letters}${flags}`;
}

const DISK_SCRIPT = `
$sys = (Get-CimInstance Win32_OperatingSystem).SystemDrive
Get-Disk | ForEach-Object {
  $d = $_
  $letters = @()
  try { $letters = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue |
        Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter):" } } catch {}
  [pscustomobject]@{
    Number     = $d.Number
    Model      = ($d.FriendlyName -as [string])
    Size       = [int64]$d.Size
    BusType    = ($d.BusType -as [string])
    Removable  = [bool]($d.BusType -eq 'USB' -or $d.BusType -eq 'SD' -or $d.BusType -eq 'MMC')
    IsBoot     = [bool]$d.IsBoot
    IsSystem   = [bool]$d.IsSystem
    Letters    = $letters
    HasSysDrive= [bool]($letters -contains $sys)
  }
}`;

/** Derive testdisk_win.exe path from the resolved photorec_win.exe path (same folder). */
function testdiskPathFrom(photorecPath: string): string {
  const idx = Math.max(photorecPath.lastIndexOf('\\'), photorecPath.lastIndexOf('/'));
  const dir = idx >= 0 ? photorecPath.slice(0, idx) : '';
  const sep = photorecPath.includes('\\') ? '\\' : '/';
  return dir ? `${dir}${sep}testdisk_win.exe` : 'testdisk_win.exe';
}

/** Build the PhotoRec /cmd script string (mirrors BuildPhotoRecCmd in the C# service). */
function buildPhotoRecCmd(picks: FileType[], freeSpaceOnly: boolean): string {
  let cmd = 'partition_none,';
  cmd += freeSpaceOnly ? 'freespace,' : 'wholespace,';
  const on = picks.filter((t) => t.selected);
  if (on.length > 0) {
    cmd += 'fileopt,everything,disable';
    for (const t of on) cmd += `,${t.token},enable`;
    cmd += ',';
  }
  cmd += 'search';
  return cmd;
}

export function TestdiskModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('testdisk.subtitle')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('testdisk.desktopOnly')}
        </p>
      )}
      <DependencyGate tool="photorec" preferId="CGSecurity.TestDisk" query="testdisk photorec">
        {(photorecPath) => <TestdiskInner photorecPath={photorecPath} desktop={desktop} />}
      </DependencyGate>
    </div>
  );
}

function TestdiskInner({ photorecPath, desktop }: { photorecPath: string; desktop: boolean }) {
  const { t } = useTranslation();
  const testdiskPath = testdiskPathFrom(photorecPath);

  const [disks, setDisks] = useState<DiskSource[]>([]);
  const [imageSource, setImageSource] = useState<DiskSource | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [imagePathInput, setImagePathInput] = useState('');
  const [outputFolder, setOutputFolder] = useState('');
  const [freeSpaceOnly, setFreeSpaceOnly] = useState(false);
  const [types, setTypes] = useState<FileType[]>(
    DEFAULT_TYPES.map(([token, desc, on]) => ({ token, desc, selected: on })),
  );
  const [sameDisk, setSameDisk] = useState(false);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const allSources: DiskSource[] = imageSource ? [...disks, imageSource] : disks;
  const selected: DiskSource | null =
    allSources.find((s) => s.devicePath === selectedPath) ?? allSources[0] ?? null;

  const appendLog = useCallback((line: string) => {
    if (!line) return;
    setLog((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      return next.length > 200000 ? next.slice(next.length - 150000) : next;
    });
  }, []);

  const loadDisks = useCallback(async () => {
    if (!desktop) return;
    try {
      const rows = await runPowershellJson<DiskRow>(DISK_SCRIPT);
      const mapped: DiskSource[] = rows.map((r) => {
        let letters: string[] = [];
        if (Array.isArray(r.Letters)) letters = r.Letters.filter((x): x is string => !!x);
        else if (typeof r.Letters === 'string' && r.Letters) letters = [r.Letters];
        const num = typeof r.Number === 'number' ? r.Number : 0;
        return {
          isDisk: true,
          diskNumber: num,
          devicePath: `\\\\.\\PhysicalDrive${num}`,
          model: r.Model || '',
          size: typeof r.Size === 'number' ? r.Size : 0,
          busType: r.BusType || '',
          removable: !!r.Removable,
          isSystem: !!r.IsSystem || !!r.HasSysDrive,
          letters,
        };
      });
      mapped.sort((a, b) => a.diskNumber - b.diskNumber);
      setDisks(mapped);
      if (!selectedPath && mapped.length > 0) setSelectedPath(mapped[0]!.devicePath);
    } catch {
      setDisks([]);
    }
  }, [desktop, selectedPath]);

  useEffect(() => {
    void loadDisks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  // Enforce recover-to-a-different-disk whenever the source or output changes.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      setSameDisk(false);
      if (!desktop || !selected || !selected.isDisk || !outputFolder.trim()) return;
      const m = /^([A-Za-z]):/.exec(outputFolder.trim());
      if (!m) return;
      const driveLetter = m[1]!;
      const script = `
$p = Get-Partition -DriveLetter '${driveLetter}' -ErrorAction SilentlyContinue
if ($p) { [pscustomobject]@{ DiskNumber = [int]$p.DiskNumber } } else { [pscustomobject]@{ DiskNumber = -1 } }`;
      try {
        const rows = await runPowershellJson<{ DiskNumber: number }>(script);
        if (cancelled) return;
        const dn = rows[0]?.DiskNumber ?? -1;
        setSameDisk(dn === selected.diskNumber);
      } catch {
        // Fail closed: treat as same disk (unsafe to guess otherwise).
        if (!cancelled) setSameDisk(true);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [desktop, selected, outputFolder]);

  const setAllTypes = (on: boolean) =>
    setTypes((prev) => prev.map((x) => ({ ...x, selected: on })));
  const toggleType = (token: string) =>
    setTypes((prev) => prev.map((x) => (x.token === token ? { ...x, selected: !x.selected } : x)));

  const addImage = () => {
    const path = imagePathInput.trim();
    if (!path) return;
    const name = path.split(/[\\/]/).pop() || path;
    const src: DiskSource = {
      isDisk: false,
      diskNumber: -1,
      devicePath: path,
      model: name,
      size: 0,
      busType: '',
      removable: false,
      isSystem: false,
      letters: [],
    };
    setImageSource(src);
    setSelectedPath(path);
  };

  const carve = async () => {
    setResult(null);
    if (!selected) {
      setResult({ ok: false, msg: t('testdisk.errNoSource') });
      return;
    }
    if (!outputFolder.trim()) {
      setResult({ ok: false, msg: t('testdisk.errNoOutput') });
      return;
    }
    if (sameDisk) {
      setResult({ ok: false, msg: t('testdisk.errSameDisk') });
      return;
    }
    if (!desktop) {
      setResult({ ok: false, msg: t('testdisk.desktopOnly') });
      return;
    }
    setBusy('carve');
    const cmd = buildPhotoRecCmd(types, freeSpaceOnly);
    const recupDir = `${outputFolder.replace(/[\\/]+$/, '')}\\recup_dir`;
    const args = ['/log', '/d', recupDir, '/cmd', selected.devicePath, cmd];
    appendLog(`> photorec_win.exe ${args.join(' ')}`);
    try {
      const res: CommandOutput = await runCommand(photorecPath, args);
      const text = res.stdout || res.stderr || `(exit ${res.code})`;
      appendLog(text);
      setResult(
        res.success
          ? { ok: true, msg: t('testdisk.carveDone', { folder: outputFolder }) }
          : { ok: false, msg: t('testdisk.carveFail', { code: res.code }) },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(msg);
      setResult({ ok: false, msg });
    } finally {
      setBusy('');
    }
  };

  const scan = async () => {
    setResult(null);
    if (!desktop) {
      setResult({ ok: false, msg: t('testdisk.desktopOnly') });
      return;
    }
    setBusy('scan');
    try {
      // Whole-system read-only listing first.
      appendLog(`> testdisk_win.exe /log /list`);
      const listRes = await runCommand(testdiskPath, ['/log', '/list']);
      appendLog(listRes.stdout || listRes.stderr || `(exit ${listRes.code})`);

      // Then a per-source read-only structure list if a source is selected.
      if (selected) {
        const args = ['/log', '/cmd', selected.devicePath, 'list'];
        appendLog(`> testdisk_win.exe ${args.join(' ')}`);
        const scanRes = await runCommand(testdiskPath, args);
        appendLog(scanRes.stdout || scanRes.stderr || `(exit ${scanRes.code})`);
        setResult(
          scanRes.success
            ? { ok: true, msg: t('testdisk.scanDone') }
            : { ok: false, msg: t('testdisk.scanFail', { code: scanRes.code }) },
        );
      } else {
        setResult(
          listRes.success
            ? { ok: true, msg: t('testdisk.scanDone') }
            : { ok: false, msg: t('testdisk.scanFail', { code: listRes.code }) },
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(msg);
      setResult({ ok: false, msg });
    } finally {
      setBusy('');
    }
  };

  const openOutput = async () => {
    if (!outputFolder.trim() || !desktop) return;
    try {
      await runCommand('explorer.exe', [outputFolder.trim()]);
    } catch {
      /* ignore */
    }
  };

  const selectedCount = types.filter((x) => x.selected).length;
  const running = !!busy;

  return (
    <>
      <div className="io-grid">
        <div className="panel">
          <label className="label">{t('testdisk.sourceLabel')}</label>
          <select
            className="mod-select"
            value={selected?.devicePath ?? ''}
            disabled={running}
            onChange={(e) => setSelectedPath(e.target.value)}
          >
            {allSources.length === 0 && <option value="">{t('testdisk.noDisks')}</option>}
            {allSources.map((s) => (
              <option key={s.devicePath} value={s.devicePath}>
                {sourceDisplay(s)}
              </option>
            ))}
          </select>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini" disabled={running || !desktop} onClick={() => void loadDisks()}>
              {t('testdisk.rescan')}
            </button>
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <input
              className="mod-search"
              style={{ flex: 1 }}
              placeholder={t('testdisk.imagePlaceholder')}
              value={imagePathInput}
              disabled={running}
              onChange={(e) => setImagePathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addImage()}
            />
            <button className="mini" disabled={running} onClick={addImage}>
              {t('testdisk.addImage')}
            </button>
          </div>
        </div>

        <div className="panel">
          <label className="label">{t('testdisk.outputLabel')}</label>
          <input
            className="mod-search"
            placeholder={t('testdisk.outputPlaceholder')}
            value={outputFolder}
            disabled={running}
            onChange={(e) => setOutputFolder(e.target.value)}
          />
          <label className="chk" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={freeSpaceOnly}
              disabled={running}
              onChange={(e) => setFreeSpaceOnly(e.target.checked)}
            />
            {t('testdisk.freeSpace')}
          </label>
        </div>
      </div>

      {sameDisk && (
        <p className="cmd-out error" style={{ marginTop: 8 }}>
          {t('testdisk.sameDiskWarn')}
        </p>
      )}

      <div className="panel" style={{ marginTop: 8 }}>
        <div className="mod-toolbar">
          <label className="label" style={{ flex: 1 }}>
            {t('testdisk.typesLabel')}
          </label>
          <button className="mini" disabled={running} onClick={() => setAllTypes(true)}>
            {t('testdisk.selectAll')}
          </button>
          <button className="mini" disabled={running} onClick={() => setAllTypes(false)}>
            {t('testdisk.selectNone')}
          </button>
        </div>
        <div
          className="kv-list"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 6 }}
        >
          {types.map((ty) => (
            <label key={ty.token} className="chk" style={{ minWidth: 140 }} title={ty.desc}>
              <input
                type="checkbox"
                checked={ty.selected}
                disabled={running}
                onChange={() => toggleType(ty.token)}
              />
              <span className="value">{ty.token}</span>
            </label>
          ))}
        </div>
        <p className="count-note" style={{ marginTop: 6 }}>
          {selectedCount === 0
            ? t('testdisk.typesAll')
            : t('testdisk.typesSelected', { n: selectedCount })}
        </p>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <button className="mini primary" disabled={running || !desktop} onClick={carve}>
          {busy === 'carve' ? t('testdisk.carving') : t('testdisk.carve')}
        </button>
        <button className="mini" disabled={running || !desktop} onClick={scan}>
          {busy === 'scan' ? t('testdisk.scanning') : t('testdisk.scan')}
        </button>
        <button
          className="mini"
          disabled={running || !desktop || !outputFolder.trim()}
          onClick={openOutput}
        >
          {t('testdisk.openOutput')}
        </button>
      </div>

      {result && (
        <p className={result.ok ? 'dep-ok' : 'cmd-out error'} style={{ marginTop: 8 }}>
          {result.ok ? '✓ ' : '⚠ '}
          {result.msg}
        </p>
      )}

      {log && (
        <div className="panel" style={{ marginTop: 8 }}>
          <div className="mod-toolbar">
            <label className="label" style={{ flex: 1 }}>
              {t('testdisk.logTitle')}
            </label>
            <button className="mini" onClick={() => setLog('')}>
              {t('testdisk.clearLog')}
            </button>
          </div>
          <pre className="cmd-out">{log}</pre>
        </div>
      )}

      <p className="count-note" style={{ marginTop: 8 }}>
        {t('testdisk.safetyNote')}
      </p>
    </>
  );
}
