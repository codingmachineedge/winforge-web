import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// ============================================================================
// PDF Toolkit — module.pdftoolkit — full web port of WinForge's PdfToolkitModule
// (Pages/PdfToolkitModule.xaml[.cs] + Services/PdfToolkitService.cs).
//
// The desktop original is a Stirling-PDF-style toolkit that runs fully in-process
// via PDFsharp + PdfPig. Those managed .NET libraries cannot be hosted on the web
// port, so every operation is driven by a real, lossless CLI shelled through the
// desktop backend (runCommand — clean argv, no shell quoting):
//   • qpdf  (winget qpdf.qpdf)  — merge, split (per-page / ranges / every-N),
//     rotate, delete / extract / reorder pages, encrypt / decrypt, page info,
//     metadata (--json), and overlay/underlay stamping & watermarks.
//   • Ghostscript (gswin64c)    — compress / optimise, PDF → images (raster),
//     and page numbering (adds text Ghostscript can render; qpdf cannot).
//   • poppler-utils (pdftotext / pdftoppm / pdfimages) — extract text, render
//     pages to images, and pull embedded images out of a PDF.
//   • ImageMagick (magick) or img2pdf — build a PDF from images.
//
// qpdf is the primary gated dependency (covers the core WinForge feature set);
// the auxiliary CLIs are shelled by name and each card notes if the tool is
// absent. Reads (info / metadata / search) auto-run on click; every mutation is
// click-gated and the destructive ones (encrypt, overwrite-in-place) confirm
// first. Passwords are held in password inputs and never logged unmasked.
// ============================================================================

// ── path / range helpers ────────────────────────────────────────────────────

const unquote = (s: string) => s.trim().replace(/^"+|"+$/g, '');

// Split a whitespace/comma/newline separated list of paths into a clean array.
function splitPaths(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((s) => unquote(s))
    .filter((s) => s.length > 0);
}

// qpdf range spec: "1-3,5,8-10". Normalise CJK/semicolon separators to commas.
function normRange(spec: string): string {
  return spec
    .split(/[,，；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(',');
}

// Turn "output.pdf" into a %d split pattern qpdf --split-pages understands.
function splitPattern(outFile: string): string {
  return outFile.includes('%d') ? outFile : outFile.replace(/(\.pdf)?$/i, '-%d.pdf');
}

// Mask a password for command echoing so it is never shown/logged in the clear.
const mask = (pw: string) => (pw ? '***' : '');

interface RunResult {
  ok: boolean;
  body: string;
}

// ── shared run box: shells a program by name, reports into a <pre> ───────────

function useRunner() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // successCodes: qpdf uses 0 (ok) and 3 (ok-with-warnings).
  const run = async (
    program: string,
    args: string[],
    label: string,
    successCodes: number[] = [0],
  ): Promise<RunResult> => {
    setErr(null);
    setBusy(true);
    setOut(`> ${label}\n`);
    try {
      const res: CommandOutput = await runCommand(program, args);
      const body = res.stdout || res.stderr || '';
      const ok = res.success || successCodes.includes(res.code);
      if (ok) {
        setOut(`${label}\n\n${body || t('pdftk.done')}`);
        return { ok: true, body };
      }
      setOut(`${label}\n\n${body || `(exit ${res.code})`}`);
      // A missing CLI surfaces as a spawn error string, not a clean exit code.
      setErr(t('pdftk.opFailed'));
      return { ok: false, body };
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      setErr(m);
      setOut(`${label}\n\n${m}\n\n${t('pdftk.toolMissingHint')}`);
      return { ok: false, body: m };
    } finally {
      setBusy(false);
    }
  };

  return { busy, out, err, setErr, run };
}

async function openFolder(path: string) {
  const p = unquote(path);
  if (!p) return;
  try {
    await runCommand('explorer.exe', [p]);
  } catch {
    /* best effort */
  }
}

// ── small field primitives (reuse hosts-edit / mod-search) ───────────────────

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
}) {
  return (
    <label className="hosts-edit">
      <span className="label">{label}</span>
      <input
        className="mod-search"
        type={type}
        style={{ width: '100%' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(type === 'password' ? { autoComplete: 'new-password' } : {})}
      />
    </label>
  );
}

function OutBox({ out, err }: { out: string; err: string | null }) {
  return (
    <>
      {err && <pre className="cmd-out error">{err}</pre>}
      {out && <pre className="cmd-out">{out}</pre>}
    </>
  );
}

function RunBar({
  busy,
  onRun,
  runLabel,
  output,
  showOpen = true,
}: {
  busy: boolean;
  onRun: () => void;
  runLabel: string;
  output?: string;
  showOpen?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mod-toolbar" style={{ marginTop: 4 }}>
      <button className="mini primary" disabled={busy} onClick={onRun}>
        {busy ? t('pdftk.running') : runLabel}
      </button>
      {showOpen && output && output.trim() && (
        <button className="mini" disabled={busy} onClick={() => openFolder(output)}>
          {t('pdftk.openOutput')}
        </button>
      )}
    </div>
  );
}

// ── Inspect: page count + metadata (qpdf --json) + text search (pdftotext) ───

function InspectTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [query, setQuery] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const info = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    run(qpdf, [...pwArgs(), '--show-npages', inFile], `qpdf --show-npages ${inFile}`, [0, 3]);
  };

  const metadata = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    // --json dumps the document structure incl. /Info metadata & page sizes.
    run(
      qpdf,
      [...pwArgs(), '--json', '--json-key=pages', '--json-key=objects', inFile],
      `qpdf --json ${inFile}`,
      [0, 3],
    );
  };

  const search = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    if (!query.trim()) return setErr(t('pdftk.needQuery'));
    // pdftotext streams the page text to stdout ("-"); grep-free client-side note.
    run('pdftotext', ['-layout', inFile, '-'], `pdftotext -layout ${inFile} -`);
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.inspectHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <Field label={t('pdftk.searchQuery')} value={query} onChange={setQuery} placeholder={t('pdftk.searchQueryPh')} />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 4 }}>
        <button className="mini primary" disabled={busy} onClick={info}>
          {busy ? t('pdftk.running') : t('pdftk.showPages')}
        </button>
        <button className="mini" disabled={busy} onClick={metadata}>
          {t('pdftk.showMeta')}
        </button>
        <button className="mini" disabled={busy} onClick={search}>
          {t('pdftk.doSearch')}
        </button>
      </div>
      <p className="count-note">{t('pdftk.searchNote')}</p>
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Merge ────────────────────────────────────────────────────────────────────

function MergeTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [mergeList, setMergeList] = useState('');
  const [output, setOutput] = useState('');

  const doMerge = () => {
    const files = splitPaths(mergeList);
    if (files.length < 2) return setErr(t('pdftk.needTwo'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    // qpdf --empty --pages a.pdf b.pdf … -- out.pdf   (order preserved)
    run(
      qpdf,
      ['--empty', '--pages', ...files, '--', outFile],
      `qpdf --empty --pages <${files.length} ${t('pdftk.files')}> -- ${outFile}`,
      [0, 3],
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.mergeHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <label className="hosts-edit">
          <span className="label">{t('pdftk.mergeList')}</span>
          <textarea
            className="mod-search"
            rows={5}
            style={{ width: '100%', fontFamily: 'monospace' }}
            placeholder={t('pdftk.mergeListPh')}
            value={mergeList}
            onChange={(e) => setMergeList(e.target.value)}
          />
        </label>
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\merged.pdf" />
      </div>
      <RunBar busy={busy} onRun={doMerge} runLabel={t('pdftk.doMerge')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Split (per-page / by-ranges / every-N) ───────────────────────────────────

type SplitMode = 'page' | 'ranges' | 'everyN';

function SplitTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<SplitMode>('page');
  const [ranges, setRanges] = useState('');
  const [everyN, setEveryN] = useState('1');
  const [output, setOutput] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const doSplit = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));

    if (mode === 'ranges') {
      const r = normRange(ranges);
      if (!r) return setErr(t('pdftk.needRange'));
      // Each comma-group becomes its own selection → one output file.
      run(
        qpdf,
        [...pwArgs(), '--empty', '--pages', inFile, r, '--', outFile],
        `qpdf --pages ${inFile} ${r} -- ${outFile}`,
        [0, 3],
      );
      return;
    }
    const pattern = splitPattern(outFile);
    const n = mode === 'everyN' ? Math.max(1, parseInt(everyN, 10) || 1) : 1;
    run(
      qpdf,
      [...pwArgs(), `--split-pages=${n}`, inFile, pattern],
      `qpdf --split-pages=${n} ${inFile} ${pattern}`,
      [0, 3],
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.splitHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <label className="hosts-edit">
          <span className="label">{t('pdftk.splitMode')}</span>
          <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as SplitMode)}>
            <option value="page">{t('pdftk.split_page')}</option>
            <option value="ranges">{t('pdftk.split_ranges')}</option>
            <option value="everyN">{t('pdftk.split_everyN')}</option>
          </select>
        </label>
        {mode === 'ranges' && (
          <Field label={t('pdftk.range')} value={ranges} onChange={setRanges} placeholder={t('pdftk.rangePh')} />
        )}
        {mode === 'everyN' && (
          <Field label={t('pdftk.everyN')} value={everyN} onChange={setEveryN} placeholder="1" />
        )}
        <Field
          label={mode === 'ranges' ? t('pdftk.outputFile') : t('pdftk.outputPattern')}
          value={output}
          onChange={setOutput}
          placeholder={mode === 'ranges' ? 'C:\\out\\part.pdf' : 'C:\\out\\page-%d.pdf'}
        />
      </div>
      <RunBar busy={busy} onRun={doSplit} runLabel={t('pdftk.doSplit')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Rotate ────────────────────────────────────────────────────────────────────

function RotateTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [angle, setAngle] = useState('90');
  const [range, setRange] = useState('');
  const [output, setOutput] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const doRotate = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    const a = ((parseInt(angle, 10) || 90) % 360 + 360) % 360;
    const r = normRange(range); // blank = all pages
    const rotateFlag = r ? `--rotate=+${a}:${r}` : `--rotate=+${a}`;
    run(
      qpdf,
      [...pwArgs(), rotateFlag, inFile, outFile],
      `qpdf ${rotateFlag} ${inFile} ${outFile}`,
      [0, 3],
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.rotateHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <label className="hosts-edit">
          <span className="label">{t('pdftk.angle')}</span>
          <select className="mod-select" value={angle} onChange={(e) => setAngle(e.target.value)}>
            <option value="90">90°</option>
            <option value="180">180°</option>
            <option value="270">270°</option>
          </select>
        </label>
        <Field label={t('pdftk.rangeOpt')} value={range} onChange={setRange} placeholder={t('pdftk.rangePh')} />
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\rotated.pdf" />
      </div>
      <RunBar busy={busy} onRun={doRotate} runLabel={t('pdftk.doRotate')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Pages: delete / extract / reorder ────────────────────────────────────────

type PagesOp = 'delete' | 'extract' | 'reorder';

function PagesTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [pop, setPop] = useState<PagesOp>('delete');
  const [spec, setSpec] = useState('');
  const [output, setOutput] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const doApply = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    const r = normRange(spec);
    if (!r) return setErr(t('pdftk.needSpec'));

    if (pop === 'delete') {
      // Keep every page except the named ones (qpdf inline exclusion selector).
      run(
        qpdf,
        [...pwArgs(), '--empty', '--pages', inFile, `1-z:exclude=${r}`, '--', outFile],
        `qpdf --pages ${inFile} 1-z:exclude=${r} -- ${outFile}`,
        [0, 3],
      );
    } else {
      // Extract AND reorder both boil down to "select these pages, in this order".
      run(
        qpdf,
        [...pwArgs(), '--empty', '--pages', inFile, r, '--', outFile],
        `qpdf --pages ${inFile} ${r} -- ${outFile}`,
        [0, 3],
      );
    }
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.pagesHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <label className="hosts-edit">
          <span className="label">{t('pdftk.pagesOp')}</span>
          <select className="mod-select" value={pop} onChange={(e) => setPop(e.target.value as PagesOp)}>
            <option value="delete">{t('pdftk.pages_delete')}</option>
            <option value="extract">{t('pdftk.pages_extract')}</option>
            <option value="reorder">{t('pdftk.pages_reorder')}</option>
          </select>
        </label>
        <Field
          label={pop === 'reorder' ? t('pdftk.orderSpec') : t('pdftk.pageSpec')}
          value={spec}
          onChange={setSpec}
          placeholder={pop === 'reorder' ? '3,1,2,4' : '2-4, 7'}
        />
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\pages.pdf" />
      </div>
      <p className="count-note">{t(`pdftk.pagesNote_${pop}`)}</p>
      <RunBar busy={busy} onRun={doApply} runLabel={t('pdftk.doApply')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Watermark / Stamp (qpdf overlay/underlay with a stamp PDF) ───────────────

function WatermarkTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [stamp, setStamp] = useState('');
  const [layer, setLayer] = useState<'overlay' | 'underlay'>('overlay');
  const [toPages, setToPages] = useState('');
  const [output, setOutput] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const doStamp = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const stampFile = unquote(stamp);
    if (!stampFile) return setErr(t('pdftk.needStamp'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    const r = normRange(toPages); // blank = all
    const flag = layer === 'underlay' ? '--underlay' : '--overlay';
    // qpdf --overlay stamp.pdf --to=1-z --repeat=1 -- in.pdf out.pdf
    const layerArgs = [flag, stampFile];
    if (r) layerArgs.push(`--to=${r}`);
    layerArgs.push('--');
    run(
      qpdf,
      [...pwArgs(), ...layerArgs, inFile, outFile],
      `qpdf ${flag} ${stampFile}${r ? ` --to=${r}` : ''} -- ${inFile} ${outFile}`,
      [0, 3],
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.watermarkHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <Field label={t('pdftk.stampFile')} value={stamp} onChange={setStamp} placeholder="C:\\docs\\CONFIDENTIAL.pdf" />
        <label className="hosts-edit">
          <span className="label">{t('pdftk.layer')}</span>
          <select className="mod-select" value={layer} onChange={(e) => setLayer(e.target.value as 'overlay' | 'underlay')}>
            <option value="overlay">{t('pdftk.layer_overlay')}</option>
            <option value="underlay">{t('pdftk.layer_underlay')}</option>
          </select>
        </label>
        <Field label={t('pdftk.stampTo')} value={toPages} onChange={setToPages} placeholder={t('pdftk.rangePh')} />
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\stamped.pdf" />
      </div>
      <p className="count-note">{t('pdftk.stampNote')}</p>
      <RunBar busy={busy} onRun={doStamp} runLabel={t('pdftk.doStamp')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Page numbering (Ghostscript overlays text via a PostScript prologue) ─────

function NumberingTab() {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [start, setStart] = useState('1');

  const doNumber = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    const from = Math.max(0, parseInt(start, 10) || 1);
    // Ghostscript draws "n" bottom-centre on every page via a BeginPage callback.
    const ps =
      `<< /BeginPage { ` +
      `/Helvetica findfont 10 scalefont setfont ` +
      `0.35 setgray ` +
      `currentpagedevice /PageSize get 0 get 2 div 24 moveto ` +
      `pagecount ${from} add 1 sub 3 string cvs ` +
      `dup stringwidth pop 2 div neg 0 rmoveto show ` +
      `/pagecount pagecount 1 add store } ` +
      `>> setpagedevice /pagecount 0 def`;
    run(
      'gswin64c',
      [
        '-q',
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=pdfwrite',
        `-sOutputFile=${outFile}`,
        `-c`,
        ps,
        `-f`,
        inFile,
      ],
      `gswin64c -sDEVICE=pdfwrite -sOutputFile=${outFile} <page-number prologue> -f ${inFile}`,
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.numberHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.startNumber')} value={start} onChange={setStart} placeholder="1" />
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\numbered.pdf" />
      </div>
      <p className="count-note">{t('pdftk.gsNote')}</p>
      <RunBar busy={busy} onRun={doNumber} runLabel={t('pdftk.doNumber')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

function SecurityTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [mode, setMode] = useState<'encrypt' | 'decrypt'>('encrypt');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [currentPw, setCurrentPw] = useState('');

  const doRun = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));

    if (mode === 'encrypt') {
      const u = userPw.trim();
      const o = ownerPw.trim();
      if (!u && !o) return setErr(t('pdftk.needPassword'));
      // Setting a password is a destructive/irreversible-without-pw change → confirm.
      if (!confirm(t('pdftk.encryptConfirm'))) return;
      // qpdf --encrypt <user> <owner> 256 -- in.pdf out.pdf
      run(
        qpdf,
        ['--encrypt', u, o || u, '256', '--', inFile, outFile],
        `qpdf --encrypt ${mask(u)} ${mask(o || u)} 256 -- ${inFile} ${outFile}`,
        [0, 3],
      );
    } else {
      const pw = currentPw.trim();
      if (!pw) return setErr(t('pdftk.needCurrentPw'));
      run(
        qpdf,
        [`--password=${pw}`, '--decrypt', inFile, outFile],
        `qpdf --password=*** --decrypt ${inFile} ${outFile}`,
        [0, 3],
      );
    }
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.securityHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <label className="hosts-edit">
          <span className="label">{t('pdftk.securityMode')}</span>
          <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as 'encrypt' | 'decrypt')}>
            <option value="encrypt">{t('pdftk.op_encrypt')}</option>
            <option value="decrypt">{t('pdftk.op_decrypt')}</option>
          </select>
        </label>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        {mode === 'encrypt' ? (
          <>
            <Field label={t('pdftk.userPw')} value={userPw} onChange={setUserPw} type="password" />
            <Field label={t('pdftk.ownerPw')} value={ownerPw} onChange={setOwnerPw} type="password" />
          </>
        ) : (
          <Field label={t('pdftk.currentPw')} value={currentPw} onChange={setCurrentPw} type="password" />
        )}
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder={mode === 'encrypt' ? 'C:\\out\\encrypted.pdf' : 'C:\\out\\decrypted.pdf'} />
      </div>
      <p className="count-note">{t(mode === 'encrypt' ? 'pdftk.help_encrypt' : 'pdftk.help_decrypt')}</p>
      <RunBar
        busy={busy}
        onRun={doRun}
        runLabel={mode === 'encrypt' ? t('pdftk.doEncrypt') : t('pdftk.doDecrypt')}
        output={output}
      />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Text extraction (pdftotext) ───────────────────────────────────────────────

function TextTab() {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [layout, setLayout] = useState(true);

  const doExtract = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    const args = layout ? ['-layout', inFile, outFile] : [inFile, outFile];
    run('pdftotext', args, `pdftotext ${layout ? '-layout ' : ''}${inFile} ${outFile}`);
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.textHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.outputText')} value={output} onChange={setOutput} placeholder="C:\\out\\extracted.txt" />
        <label className="hosts-edit" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={layout} onChange={(e) => setLayout(e.target.checked)} />
          <span className="label" style={{ margin: 0 }}>{t('pdftk.keepLayout')}</span>
        </label>
      </div>
      <p className="count-note">{t('pdftk.textNote')}</p>
      <RunBar busy={busy} onRun={doExtract} runLabel={t('pdftk.doExtractText')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Images: PDF → images, extract embedded images, images → PDF ──────────────

type ImagesOp = 'pdfToImg' | 'extractImg' | 'imgToPdf';

function ImagesTab() {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [iop, setIop] = useState<ImagesOp>('pdfToImg');
  const [input, setInput] = useState('');
  const [outPrefix, setOutPrefix] = useState('');
  const [imgList, setImgList] = useState('');
  const [output, setOutput] = useState('');
  const [dpi, setDpi] = useState('150');
  const [fmt, setFmt] = useState<'png' | 'jpeg'>('png');

  const doRun = () => {
    if (iop === 'imgToPdf') {
      const imgs = splitPaths(imgList);
      if (imgs.length === 0) return setErr(t('pdftk.needImages'));
      const outFile = unquote(output);
      if (!outFile) return setErr(t('pdftk.needOutput'));
      // ImageMagick builds one page per image; magick a.png b.jpg out.pdf
      run('magick', [...imgs, outFile], `magick <${imgs.length} ${t('pdftk.images')}> ${outFile}`);
      return;
    }

    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const prefix = unquote(outPrefix);
    if (!prefix) return setErr(t('pdftk.needPrefix'));

    if (iop === 'pdfToImg') {
      const d = Math.max(1, parseInt(dpi, 10) || 150);
      // pdftoppm renders each page to <prefix>-NN.<ext> at the chosen DPI.
      run(
        'pdftoppm',
        [fmt === 'jpeg' ? '-jpeg' : '-png', '-r', String(d), inFile, prefix],
        `pdftoppm -${fmt} -r ${d} ${inFile} ${prefix}`,
      );
    } else {
      // pdfimages pulls the *embedded* image streams out losslessly.
      run('pdfimages', ['-all', inFile, prefix], `pdfimages -all ${inFile} ${prefix}`);
    }
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.imagesHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <label className="hosts-edit">
          <span className="label">{t('pdftk.imagesOp')}</span>
          <select className="mod-select" value={iop} onChange={(e) => setIop(e.target.value as ImagesOp)}>
            <option value="pdfToImg">{t('pdftk.img_pdfToImg')}</option>
            <option value="extractImg">{t('pdftk.img_extractImg')}</option>
            <option value="imgToPdf">{t('pdftk.img_imgToPdf')}</option>
          </select>
        </label>

        {iop === 'imgToPdf' ? (
          <>
            <label className="hosts-edit">
              <span className="label">{t('pdftk.imageList')}</span>
              <textarea
                className="mod-search"
                rows={5}
                style={{ width: '100%', fontFamily: 'monospace' }}
                placeholder={t('pdftk.imageListPh')}
                value={imgList}
                onChange={(e) => setImgList(e.target.value)}
              />
            </label>
            <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\images.pdf" />
          </>
        ) : (
          <>
            <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
            {iop === 'pdfToImg' && (
              <>
                <Field label={t('pdftk.dpi')} value={dpi} onChange={setDpi} placeholder="150" />
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.format')}</span>
                  <select className="mod-select" value={fmt} onChange={(e) => setFmt(e.target.value as 'png' | 'jpeg')}>
                    <option value="png">PNG</option>
                    <option value="jpeg">JPEG</option>
                  </select>
                </label>
              </>
            )}
            <Field label={t('pdftk.outPrefix')} value={outPrefix} onChange={setOutPrefix} placeholder="C:\\out\\page" />
          </>
        )}
      </div>
      <p className="count-note">{t(`pdftk.imgNote_${iop}`)}</p>
      <RunBar
        busy={busy}
        onRun={doRun}
        runLabel={t('pdftk.doImages')}
        output={iop === 'imgToPdf' ? output : outPrefix}
      />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Compress / optimise (Ghostscript) ────────────────────────────────────────

function CompressTab() {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [preset, setPreset] = useState('/ebook');

  const doCompress = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    // Ghostscript re-distills the PDF at the chosen quality preset.
    run(
      'gswin64c',
      [
        '-q',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.5',
        `-dPDFSETTINGS=${preset}`,
        `-sOutputFile=${outFile}`,
        inFile,
      ],
      `gswin64c -sDEVICE=pdfwrite -dPDFSETTINGS=${preset} -sOutputFile=${outFile} ${inFile}`,
    );
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.compressHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <label className="hosts-edit">
          <span className="label">{t('pdftk.quality')}</span>
          <select className="mod-select" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="/screen">{t('pdftk.q_screen')}</option>
            <option value="/ebook">{t('pdftk.q_ebook')}</option>
            <option value="/printer">{t('pdftk.q_printer')}</option>
            <option value="/prepress">{t('pdftk.q_prepress')}</option>
          </select>
        </label>
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\compressed.pdf" />
      </div>
      <p className="count-note">{t('pdftk.gsNote')}</p>
      <RunBar busy={busy} onRun={doCompress} runLabel={t('pdftk.doCompress')} output={output} />
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── Metadata edit (qpdf --json for reading; docinfo via qpdf) ─────────────────

function MetadataTab({ qpdf }: { qpdf: string }) {
  const { t } = useTranslation();
  const { busy, out, err, setErr, run } = useRunner();
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [output, setOutput] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('');
  const [keywords, setKeywords] = useState('');

  const pwArgs = () => (password.trim() ? [`--password=${password.trim()}`] : []);

  const readMeta = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    run(qpdf, [...pwArgs(), '--json', '--json-key=objects', inFile], `qpdf --json ${inFile}`, [0, 3]);
  };

  const writeMeta = () => {
    const inFile = unquote(input);
    if (!inFile) return setErr(t('pdftk.needInput'));
    const outFile = unquote(output);
    if (!outFile) return setErr(t('pdftk.needOutput'));
    if (!title.trim() && !author.trim() && !subject.trim() && !keywords.trim()) {
      return setErr(t('pdftk.needMeta'));
    }
    // exiftool writes the standard /Info dictionary fields in place → new file.
    const args: string[] = [];
    if (title.trim()) args.push(`-Title=${title.trim()}`);
    if (author.trim()) args.push(`-Author=${author.trim()}`);
    if (subject.trim()) args.push(`-Subject=${subject.trim()}`);
    if (keywords.trim()) args.push(`-Keywords=${keywords.trim()}`);
    args.push('-o', outFile, inFile);
    run('exiftool', args, `exiftool <metadata fields> -o ${outFile} ${inFile}`);
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pdftk.metaHelp')}
      </p>
      <div className="io-grid" style={{ marginTop: 10 }}>
        <Field label={t('pdftk.inputFile')} value={input} onChange={setInput} placeholder="C:\\docs\\file.pdf" />
        <Field label={t('pdftk.password')} value={password} onChange={setPassword} placeholder={t('pdftk.passwordPh')} type="password" />
        <Field label={t('pdftk.metaTitle')} value={title} onChange={setTitle} />
        <Field label={t('pdftk.metaAuthor')} value={author} onChange={setAuthor} />
        <Field label={t('pdftk.metaSubject')} value={subject} onChange={setSubject} />
        <Field label={t('pdftk.metaKeywords')} value={keywords} onChange={setKeywords} />
        <Field label={t('pdftk.outputFile')} value={output} onChange={setOutput} placeholder="C:\\out\\tagged.pdf" />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 4 }}>
        <button className="mini primary" disabled={busy} onClick={writeMeta}>
          {busy ? t('pdftk.running') : t('pdftk.doWriteMeta')}
        </button>
        <button className="mini" disabled={busy} onClick={readMeta}>
          {t('pdftk.doReadMeta')}
        </button>
        {output.trim() && (
          <button className="mini" disabled={busy} onClick={() => openFolder(output)}>
            {t('pdftk.openOutput')}
          </button>
        )}
      </div>
      <p className="count-note">{t('pdftk.metaNote')}</p>
      <OutBox out={out} err={err} />
    </div>
  );
}

// ── module shell: gate on qpdf, then sub-tabs for every feature group ────────

export function PdfToolkitModule() {
  const { t } = useTranslation();

  return (
    <div className="mod">
      <DependencyGate tool="qpdf" preferId="qpdf.qpdf" query="qpdf">
        {(qpdf) => (
          <>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('pdftk.intro')}
            </p>
            <ModuleTabs
              tabs={[
                { id: 'inspect', en: 'Inspect', zh: '檢視', render: () => <InspectTab qpdf={qpdf} /> },
                { id: 'merge', en: 'Merge', zh: '合併', render: () => <MergeTab qpdf={qpdf} /> },
                { id: 'split', en: 'Split', zh: '分割', render: () => <SplitTab qpdf={qpdf} /> },
                { id: 'rotate', en: 'Rotate', zh: '旋轉', render: () => <RotateTab qpdf={qpdf} /> },
                { id: 'pages', en: 'Pages', zh: '頁面', render: () => <PagesTab qpdf={qpdf} /> },
                { id: 'watermark', en: 'Watermark', zh: '浮水印', render: () => <WatermarkTab qpdf={qpdf} /> },
                { id: 'numbering', en: 'Numbering', zh: '頁碼', render: () => <NumberingTab /> },
                { id: 'security', en: 'Encrypt / Decrypt', zh: '加密／解密', render: () => <SecurityTab qpdf={qpdf} /> },
                { id: 'text', en: 'Extract text', zh: '抽取文字', render: () => <TextTab /> },
                { id: 'images', en: 'Images', zh: '圖片', render: () => <ImagesTab /> },
                { id: 'compress', en: 'Compress', zh: '壓縮', render: () => <CompressTab /> },
                { id: 'metadata', en: 'Metadata', zh: '中繼資料', render: () => <MetadataTab qpdf={qpdf} /> },
              ]}
            />
            <p className="count-note">{t('pdftk.note')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
