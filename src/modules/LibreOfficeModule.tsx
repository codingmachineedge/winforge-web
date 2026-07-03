import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ===== ported straight from Services/LibreOfficeService.cs =====

interface TargetFormat {
  ext: string;
  en: string;
  zh: string;
  filter?: string;
}

// LibreOfficeService.Formats — target formats with their preferred filter overrides.
const FORMATS: TargetFormat[] = [
  { ext: 'pdf', en: 'PDF document', zh: 'PDF 文件', filter: 'writer_pdf_Export' },
  { ext: 'docx', en: 'Word (.docx)', zh: 'Word（.docx）', filter: 'MS Word 2007 XML' },
  { ext: 'odt', en: 'OpenDocument Text', zh: 'OpenDocument 文字' },
  { ext: 'xlsx', en: 'Excel (.xlsx)', zh: 'Excel（.xlsx）', filter: 'Calc MS Excel 2007 XML' },
  { ext: 'ods', en: 'OpenDocument Sheet', zh: 'OpenDocument 試算表' },
  { ext: 'pptx', en: 'PowerPoint (.pptx)', zh: 'PowerPoint（.pptx）', filter: 'Impress MS PowerPoint 2007 XML' },
  { ext: 'odp', en: 'OpenDocument Pres.', zh: 'OpenDocument 簡報' },
  { ext: 'csv', en: 'CSV (text)', zh: 'CSV（文字）', filter: 'Text - txt - csv (StarCalc)' },
  { ext: 'txt', en: 'Plain text', zh: '純文字', filter: 'Text' },
  { ext: 'html', en: 'HTML', zh: 'HTML' },
  { ext: 'rtf', en: 'Rich Text (.rtf)', zh: 'RTF 格式' },
  { ext: 'png', en: 'PNG image', zh: 'PNG 圖片' },
  { ext: 'jpg', en: 'JPEG image', zh: 'JPEG 圖片' },
];

// LibreOfficeService.SourceExtensions — extensions accepted into the convertible list.
const SOURCE_EXTS = [
  '.doc', '.docx', '.odt', '.rtf', '.txt', '.html', '.htm',
  '.xls', '.xlsx', '.ods', '.csv',
  '.ppt', '.pptx', '.odp',
  '.pdf', '.fodt', '.fods', '.fodp', '.wps', '.pub',
];

function convertArg(fmt: TargetFormat, override: string): string {
  const f = override.trim() || fmt.filter;
  return f ? `${fmt.ext}:${f}` : fmt.ext;
}

/** Escape a value for a single-quoted PowerShell string. */
function ps(v: string): string {
  return v.replace(/'/g, "''");
}

interface Engine {
  installed: boolean;
  com: string; // soffice.com path or ''
  exe: string; // soffice.exe path or ''
  version: string;
}

interface SrcFile {
  Name: string;
  FullName: string;
  Size: number;
  Ext: string;
}

type RowState = 'queued' | 'converting' | 'done' | 'failed';
interface RowStatus {
  state: RowState;
  detail?: string;
  outputPath?: string;
}

function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// PowerShell that mirrors LibreOfficeService's registry + known-dir resolution of soffice.
const DETECT_SCRIPT = `
$com=$null;$exe=$null
$dirs=@()
try{$ap=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\soffice.exe' -EA SilentlyContinue).'(default)';if($ap -and (Test-Path $ap)){$dirs+=(Split-Path $ap)}}catch{}
$dirs+='C:\\Program Files\\LibreOffice\\program','C:\\Program Files (x86)\\LibreOffice\\program'
foreach($d in ($dirs|Select-Object -Unique)){
  if(-not $com -and (Test-Path (Join-Path $d 'soffice.com'))){$com=Join-Path $d 'soffice.com'}
  if(-not $exe -and (Test-Path (Join-Path $d 'soffice.exe'))){$exe=Join-Path $d 'soffice.exe'}
}
$ver=''
$vpath=if($exe){$exe}elseif($com){$com}else{$null}
if($vpath){try{$vi=(Get-Item $vpath).VersionInfo;$ver=($vi.ProductName+' '+$vi.ProductVersion).Trim()}catch{}}
[pscustomobject]@{installed=[bool]($com -or $exe);com=[string]$com;exe=[string]$exe;version=$ver}
`.trim();

export function LibreOfficeModule() {
  const { t } = useTranslation();

  const engineState = useAsync(async () => {
    const r = await runPowershellJson<Engine>(DETECT_SCRIPT);
    return r[0] ?? { installed: false, com: '', exe: '', version: '' };
  }, []);
  const engine: Engine = engineState.data ?? { installed: false, com: '', exe: '', version: '' };

  const [srcDir, setSrcDir] = useState('');
  const [recurse, setRecurse] = useState(false);
  const [fmtIdx, setFmtIdx] = useState(0);
  const [filterOverride, setFilterOverride] = useState('');
  const [outDir, setOutDir] = useState('');
  const [scanTick, setScanTick] = useState(0);

  const fmt = FORMATS[fmtIdx] ?? FORMATS[0]!;

  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const appendLog = (line: string) => setLog((prev) => [...prev, line]);

  // Scan the chosen source folder for convertible files (read-only enumeration).
  const scan = useAsync(async () => {
    const dir = srcDir.trim();
    if (!dir) return [] as SrcFile[];
    const extList = SOURCE_EXTS.map((e) => `'${e}'`).join(',');
    const script = `
$dir='${ps(dir)}'
if(-not (Test-Path -LiteralPath $dir -PathType Container)){throw 'Folder not found'}
$exts=@(${extList})
Get-ChildItem -LiteralPath $dir -File ${recurse ? '-Recurse' : ''} -EA SilentlyContinue |
  Where-Object { $exts -contains $_.Extension.ToLower() } |
  Select-Object @{N='Name';E={$_.Name}},@{N='FullName';E={$_.FullName}},@{N='Size';E={[long]$_.Length}},@{N='Ext';E={$_.Extension.ToLower()}}
`.trim();
    return runPowershellJson<SrcFile>(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanTick]);

  const files = useMemo(() => {
    const all = scan.data ?? [];
    return [...all].sort((a, b) => a.Name.localeCompare(b.Name));
  }, [scan.data]);

  const doScan = () => {
    setStatuses({});
    setScanTick((n) => n + 1);
  };

  const outDirFor = (f: SrcFile): string => {
    const o = outDir.trim();
    if (o) return o;
    const i = Math.max(f.FullName.lastIndexOf('\\'), f.FullName.lastIndexOf('/'));
    return i > 0 ? f.FullName.slice(0, i) : srcDir.trim();
  };

  // Convert one file via headless soffice.com — verifies the output really exists on disk.
  const convertOne = async (f: SrcFile): Promise<RowStatus> => {
    if (!engine.com && !engine.exe) return { state: 'failed', detail: t('libreoffice.notFound') };
    const exe = engine.com || engine.exe;
    const dest = outDirFor(f);
    const arg = convertArg(fmt, filterOverride);
    const base = f.Name.replace(/\.[^.]+$/, '');
    const script = `
$dest='${ps(dest)}'
New-Item -ItemType Directory -Force -Path $dest -EA SilentlyContinue | Out-Null
$prof='file:///' + ($env:TEMP -replace '\\\\','/') + '/winforge_lo_' + [guid]::NewGuid().ToString('N')
$expected=Join-Path $dest '${ps(base)}.${fmt.ext}'
if(Test-Path -LiteralPath $expected){Remove-Item -LiteralPath $expected -Force -EA SilentlyContinue}
& '${ps(exe)}' --headless --norestore --nolockcheck --nodefault --nologo --nofirststartwizard "-env:UserInstallation=$prof" --convert-to '${ps(arg)}' --outdir "$dest" '${ps(f.FullName)}' 2>&1 | Out-String
if(Test-Path -LiteralPath $expected){"OK::$expected"}else{
  $alt=Get-ChildItem -LiteralPath $dest -Filter '*.${fmt.ext}' -File -EA SilentlyContinue | Where-Object { $_.BaseName -like '${ps(base)}*' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if($alt){"OK::"+$alt.FullName}else{"FAIL::output file was not produced"}
}
`.trim();
    const res = await runPowershell(script);
    const tail = res.stdout.trim().split(/\r?\n/).pop() ?? '';
    if (tail.startsWith('OK::')) {
      const out = tail.slice(4);
      appendLog(`OK  ${f.Name}  ->  ${out}`);
      return { state: 'done', outputPath: out, detail: out };
    }
    const why = tail.startsWith('FAIL::') ? tail.slice(6) : res.stderr.trim() || tail || `exit ${res.code}`;
    appendLog(`FAIL  ${f.Name}  ·  ${why}`);
    return { state: 'failed', detail: why };
  };

  const convertAll = async () => {
    if (busy) return;
    if (!engine.installed) {
      setMsg(t('libreoffice.notFound'));
      return;
    }
    if (files.length === 0) {
      setMsg(t('libreoffice.addFirst'));
      return;
    }
    setBusy(true);
    setMsg(null);
    setStatuses(Object.fromEntries(files.map((f) => [f.FullName, { state: 'queued' } as RowStatus])));
    appendLog(t('libreoffice.startBatch', { total: files.length, ext: fmt.ext }));
    let ok = 0;
    let fail = 0;
    for (const f of files) {
      setStatuses((prev) => ({ ...prev, [f.FullName]: { state: 'converting' } }));
      // eslint-disable-next-line no-await-in-loop
      const st = await convertOne(f);
      setStatuses((prev) => ({ ...prev, [f.FullName]: st }));
      if (st.state === 'done') ok++;
      else fail++;
    }
    appendLog(t('libreoffice.finished', { ok, fail }));
    setMsg(t('libreoffice.finished', { ok, fail }));
    setBusy(false);
  };

  const openInLibre = async (target: string) => {
    if (!engine.exe && !engine.com) {
      setMsg(t('libreoffice.notFound'));
      return;
    }
    const exe = engine.exe || engine.com;
    const res = await runCommand(exe, ['--norestore', target]);
    setMsg(res.success ? t('libreoffice.opened') : `${t('libreoffice.opFailed')}: ${res.stderr.trim()}`);
  };

  const openFolder = async (dir: string) => {
    if (!dir) {
      setMsg(t('libreoffice.noOutDir'));
      return;
    }
    await runCommand('explorer', [dir]);
  };

  const launchApp = async (sw: string) => {
    if (!engine.exe && !engine.com) {
      setMsg(t('libreoffice.notFound'));
      return;
    }
    const exe = engine.exe || engine.com;
    const res = await runCommand(exe, ['--norestore', sw]);
    setMsg(res.success ? t('libreoffice.launched') : `${t('libreoffice.opFailed')}: ${res.stderr.trim()}`);
  };

  const killStray = async () => {
    const res = await runPowershell(
      "$n=@(Get-Process soffice,soffice.bin -EA SilentlyContinue); $n | Stop-Process -Force -EA SilentlyContinue; $n.Count",
    );
    const n = res.stdout.trim() || '0';
    setMsg(t('libreoffice.killed', { n }));
  };

  const stateLabel = (s: RowState): string =>
    s === 'queued' ? t('libreoffice.stQueued')
      : s === 'converting' ? t('libreoffice.stConverting')
        : s === 'done' ? t('libreoffice.stDone')
          : t('libreoffice.stFailed');

  const doneCount = Object.values(statuses).filter((s) => s.state === 'done' || s.state === 'failed').length;

  const columns: Column<SrcFile>[] = [
    {
      key: 'state',
      header: t('libreoffice.colState'),
      width: 120,
      render: (f) => {
        const st = statuses[f.FullName];
        if (!st) return <span className="count-note">—</span>;
        return <StatusDot ok={st.state === 'done'} label={stateLabel(st.state)} />;
      },
    },
    { key: 'Name', header: t('libreoffice.colFile'), render: (f) => <span title={f.FullName}>{f.Name}</span> },
    { key: 'Ext', header: t('libreoffice.colType'), width: 80, render: (f) => f.Ext },
    {
      key: 'Size',
      header: t('libreoffice.colSize'),
      width: 100,
      align: 'right',
      render: (f) => humanSize(f.Size),
    },
    {
      key: 'out',
      header: t('libreoffice.colOutput'),
      render: (f) => {
        const st = statuses[f.FullName];
        if (st?.state === 'done' && st.outputPath) return <span className="env-val" title={st.outputPath}>{st.outputPath}</span>;
        if (st?.state === 'failed' && st.detail) return <span className="count-note">{st.detail}</span>;
        return <span className="count-note">—</span>;
      },
    },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (f) => {
        const st = statuses[f.FullName];
        const target = st?.state === 'done' && st.outputPath ? st.outputPath : f.FullName;
        return (
          <button className="mini" disabled={!engine.installed} onClick={() => openInLibre(target)}>
            {t('libreoffice.open')}
          </button>
        );
      },
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('libreoffice.blurb')}</p>

      {/* Engine status — mirrors the WinForge EngineBar */}
      <AsyncState loading={engineState.loading} error={engineState.error}>
        <div className="mod-toolbar" style={{ alignItems: 'center' }}>
          <StatusDot
            ok={engine.installed}
            label={engine.installed ? t('libreoffice.installed') : t('libreoffice.notFound')}
          />
          {engine.version && <span className="count-note">{engine.version}</span>}
          {engine.com && <span className="count-note" title={engine.com}>soffice.com</span>}
          <button className="mini" onClick={engineState.reload}>⟳ {t('modules.refresh')}</button>
        </div>
        {!engine.installed && <p className="count-note">{t('libreoffice.installHint')}</p>}
      </AsyncState>

      {/* Source folder + scan */}
      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 260 }}
          placeholder={t('libreoffice.srcPlaceholder')}
          value={srcDir}
          onChange={(e) => setSrcDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doScan()}
        />
        <label className="count-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={recurse} onChange={(e) => setRecurse(e.target.checked)} />
          {t('libreoffice.recurse')}
        </label>
        <button className="mini primary" onClick={doScan}>{t('libreoffice.scan')}</button>
        <span className="count-note">{t('libreoffice.fileCount', { files: files.length })}</span>
      </ModuleToolbar>

      {/* Conversion options */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">
          {t('libreoffice.targetFormat')}{' '}
          <select
            className="mod-search"
            value={fmtIdx}
            onChange={(e) => {
              const i = Number(e.target.value);
              setFmtIdx(i);
              setFilterOverride('');
            }}
          >
            {FORMATS.map((f, i) => (
              <option key={f.ext} value={i}>
                {t(`libreoffice.fmt_${f.ext}`)} · .{f.ext}
              </option>
            ))}
          </select>
        </label>
        <input
          className="mod-search"
          style={{ minWidth: 220 }}
          placeholder={t('libreoffice.filterPlaceholder')}
          value={filterOverride}
          onChange={(e) => setFilterOverride(e.target.value)}
        />
        <input
          className="mod-search"
          style={{ minWidth: 220 }}
          placeholder={t('libreoffice.outPlaceholder')}
          value={outDir}
          onChange={(e) => setOutDir(e.target.value)}
        />
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={busy || !engine.installed || files.length === 0} onClick={convertAll}>
          {busy ? t('libreoffice.converting') : t('libreoffice.convert')}
        </button>
        <span className="count-note">{doneCount} / {files.length}</span>
        <button className="mini" disabled={!engine.installed} onClick={() => launchApp('--writer')}>{t('libreoffice.writer')}</button>
        <button className="mini" disabled={!engine.installed} onClick={() => launchApp('--calc')}>{t('libreoffice.calc')}</button>
        <button className="mini" disabled={!engine.installed} onClick={() => launchApp('--impress')}>{t('libreoffice.impress')}</button>
        <button className="mini" disabled={!engine.installed} onClick={() => openFolder(outDir.trim() || srcDir.trim())}>{t('libreoffice.openOut')}</button>
        <button className="mini" onClick={killStray}>{t('libreoffice.killStray')}</button>
      </div>

      {msg && <p className="mod-msg">{msg}</p>}

      {/* File list */}
      <AsyncState loading={scan.loading} error={scan.error}>
        <DataTable columns={columns} rows={files} rowKey={(f) => f.FullName} empty={t('libreoffice.empty')} />
      </AsyncState>

      {/* Log */}
      {log.length > 0 && (
        <>
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <span className="count-note" style={{ flex: 1 }}>{t('libreoffice.log')}</span>
            <button className="mini" onClick={() => setLog([])}>{t('libreoffice.clearLog')}</button>
          </div>
          <pre className="cmd-out" style={{ maxHeight: 220, overflow: 'auto' }}>{log.join('\n')}</pre>
        </>
      )}
    </div>
  );
}
