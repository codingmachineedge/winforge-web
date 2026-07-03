import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a Stirling/qpdf/pdftk-style PDF toolkit.
// The original WinForge module runs fully in-process via PDFsharp + PdfPig. On the web
// port we cannot host those .NET libraries, so we drive the `qpdf` CLI (winget id
// qpdf.qpdf) — a real, lossless PDF tool that merges, splits, rotates, selects pages,
// and encrypts/decrypts. Every action shells out through the desktop backend.

type OpKey =
  | 'merge'
  | 'splitPage'
  | 'splitRange'
  | 'rotate'
  | 'delete'
  | 'extract'
  | 'encrypt'
  | 'decrypt'
  | 'info';

const OPS: OpKey[] = ['merge', 'splitPage', 'splitRange', 'rotate', 'delete', 'extract', 'encrypt', 'decrypt', 'info'];

// Split a whitespace/comma/newline separated list of paths into a clean array.
function splitPaths(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((s) => s.trim().replace(/^"+|"+$/g, ''))
    .filter((s) => s.length > 0);
}

// qpdf range spec: "1-3,5,8-10". Normalise separators to qpdf's comma form.
function normRange(spec: string): string {
  return spec
    .split(/[,，；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(',');
}

export function PdfToolkitModule() {
  const { t } = useTranslation();

  const [op, setOp] = useState<OpKey>('merge');
  const [input, setInput] = useState('');
  const [mergeList, setMergeList] = useState('');
  const [output, setOutput] = useState('');
  const [range, setRange] = useState('');
  const [angle, setAngle] = useState('90');
  const [password, setPassword] = useState('');
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Build the qpdf argument vector for the current operation. Returns null if inputs
  // are incomplete (with a message set), so the run helper can bail cleanly.
  const buildArgs = (): { args: string[]; label: string } | null => {
    const inFile = input.trim().replace(/^"+|"+$/g, '');
    const outFile = output.trim().replace(/^"+|"+$/g, '');
    const pw = password.trim();

    const needIn = () => {
      if (!inFile) {
        setErr(t('pdftk.needInput'));
        return false;
      }
      return true;
    };
    const needOut = () => {
      if (!outFile) {
        setErr(t('pdftk.needOutput'));
        return false;
      }
      return true;
    };
    // Password flag for a protected input, if the user supplied one.
    const pwArgs = pw ? [`--password=${pw}`] : [];

    switch (op) {
      case 'merge': {
        const files = splitPaths(mergeList);
        if (files.length < 2) {
          setErr(t('pdftk.needTwo'));
          return null;
        }
        if (!needOut()) return null;
        // qpdf --empty --pages a.pdf b.pdf ... -- out.pdf
        return {
          args: ['--empty', '--pages', ...files, '--', outFile],
          label: `qpdf --empty --pages <${files.length} files> -- ${outFile}`,
        };
      }
      case 'splitPage': {
        if (!needIn() || !needOut()) return null;
        // outFile is used as a pattern; qpdf needs %d for split-pages naming.
        const pattern = outFile.includes('%d') ? outFile : outFile.replace(/(\.pdf)?$/i, '-%d.pdf');
        return {
          args: [...pwArgs, '--split-pages=1', inFile, pattern],
          label: `qpdf --split-pages=1 ${inFile} ${pattern}`,
        };
      }
      case 'splitRange': {
        if (!needIn() || !needOut()) return null;
        const r = normRange(range);
        if (!r) {
          setErr(t('pdftk.needRange'));
          return null;
        }
        return {
          args: [...pwArgs, '--empty', '--pages', inFile, r, '--', outFile],
          label: `qpdf --pages ${inFile} ${r} -- ${outFile}`,
        };
      }
      case 'rotate': {
        if (!needIn() || !needOut()) return null;
        const a = (parseInt(angle, 10) || 90) % 360;
        const r = normRange(range); // blank = all pages
        // qpdf --rotate=+90:1-3 in.pdf out.pdf   (omit :range for all pages)
        const rotateFlag = r ? `--rotate=+${a}:${r}` : `--rotate=+${a}`;
        return {
          args: [...pwArgs, rotateFlag, inFile, outFile],
          label: `qpdf ${rotateFlag} ${inFile} ${outFile}`,
        };
      }
      case 'delete': {
        if (!needIn() || !needOut()) return null;
        const r = normRange(range);
        if (!r) {
          setErr(t('pdftk.needRange'));
          return null;
        }
        // Keep everything EXCEPT the named pages: qpdf --pages in. z-1 --exclude ... is
        // not portable across versions, so use the "." selection with an exclusion spec.
        return {
          args: [...pwArgs, '--empty', '--pages', inFile, `1-z:exclude=${r}`, '--', outFile],
          label: `qpdf --pages ${inFile} 1-z:exclude=${r} -- ${outFile}`,
        };
      }
      case 'extract': {
        if (!needIn() || !needOut()) return null;
        const r = normRange(range);
        if (!r) {
          setErr(t('pdftk.needRange'));
          return null;
        }
        return {
          args: [...pwArgs, '--empty', '--pages', inFile, r, '--', outFile],
          label: `qpdf --pages ${inFile} ${r} -- ${outFile}`,
        };
      }
      case 'encrypt': {
        if (!needIn() || !needOut()) return null;
        const u = userPw.trim();
        const o = ownerPw.trim();
        if (!u && !o) {
          setErr(t('pdftk.needPassword'));
          return null;
        }
        // qpdf --encrypt <user> <owner> 256 -- in.pdf out.pdf
        return {
          args: [...pwArgs, '--encrypt', u, o || u, '256', '--', inFile, outFile],
          label: `qpdf --encrypt *** *** 256 -- ${inFile} ${outFile}`,
        };
      }
      case 'decrypt': {
        if (!needIn() || !needOut()) return null;
        if (!pw) {
          setErr(t('pdftk.needCurrentPw'));
          return null;
        }
        return {
          args: [`--password=${pw}`, '--decrypt', inFile, outFile],
          label: `qpdf --decrypt ${inFile} ${outFile}`,
        };
      }
      case 'info': {
        if (!needIn()) return null;
        return {
          args: [...pwArgs, '--show-npages', inFile],
          label: `qpdf --show-npages ${inFile}`,
        };
      }
      default:
        return null;
    }
  };

  const run = async (qpdfPath: string) => {
    setErr(null);
    const built = buildArgs();
    if (!built) return;
    setBusy(true);
    setOut(`> ${built.label}\n`);
    try {
      const res: CommandOutput = await runCommand(qpdfPath, built.args);
      // qpdf exit codes: 0 = ok, 3 = ok with warnings, others = error.
      const body = res.stdout || res.stderr || '';
      if (res.success || res.code === 3) {
        setOut(`${built.label}\n\n${body || t('pdftk.done')}`);
      } else {
        setOut(`${built.label}\n\n${body || `(exit ${res.code})`}`);
        setErr(t('pdftk.opFailed'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (path: string) => {
    const p = path.trim().replace(/^"+|"+$/g, '');
    if (!p) return;
    try {
      await runCommand('explorer.exe', [p]);
    } catch {
      /* best effort */
    }
  };

  const showRange = op === 'splitRange' || op === 'rotate' || op === 'delete' || op === 'extract';
  const showInput = op !== 'merge';
  const showMergeList = op === 'merge';
  const showOutput = op !== 'info';
  const showPw = op !== 'merge' && op !== 'encrypt' && op !== 'decrypt';
  const showEncrypt = op === 'encrypt';
  const showDecrypt = op === 'decrypt';

  return (
    <div className="mod">
      <DependencyGate tool="qpdf" preferId="qpdf.qpdf" query="qpdf">
        {(path) => (
          <>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('pdftk.intro')}
            </p>

            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <label className="count-note">{t('pdftk.operation')}</label>
              <select
                className="mod-select"
                value={op}
                onChange={(e) => {
                  setOp(e.target.value as OpKey);
                  setErr(null);
                }}
              >
                {OPS.map((o) => (
                  <option key={o} value={o}>
                    {t(`pdftk.op_${o}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="io-grid" style={{ marginTop: 10 }}>
              {showMergeList && (
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.mergeList')}</span>
                  <textarea
                    className="mod-search"
                    rows={4}
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder={t('pdftk.mergeListPh')}
                    value={mergeList}
                    onChange={(e) => setMergeList(e.target.value)}
                  />
                </label>
              )}

              {showInput && (
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.inputFile')}</span>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    placeholder="C:\\docs\\file.pdf"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                  />
                </label>
              )}

              {showRange && (
                <label className="hosts-edit">
                  <span className="label">
                    {op === 'rotate' ? t('pdftk.rangeOpt') : t('pdftk.range')}
                  </span>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    placeholder={t('pdftk.rangePh')}
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                  />
                </label>
              )}

              {op === 'rotate' && (
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.angle')}</span>
                  <select
                    className="mod-select"
                    value={angle}
                    onChange={(e) => setAngle(e.target.value)}
                  >
                    <option value="90">90°</option>
                    <option value="180">180°</option>
                    <option value="270">270°</option>
                  </select>
                </label>
              )}

              {showPw && (
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.password')}</span>
                  <input
                    className="mod-search"
                    type="password"
                    style={{ width: '100%' }}
                    placeholder={t('pdftk.passwordPh')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}

              {showEncrypt && (
                <>
                  <label className="hosts-edit">
                    <span className="label">{t('pdftk.userPw')}</span>
                    <input
                      className="mod-search"
                      type="password"
                      style={{ width: '100%' }}
                      value={userPw}
                      onChange={(e) => setUserPw(e.target.value)}
                    />
                  </label>
                  <label className="hosts-edit">
                    <span className="label">{t('pdftk.ownerPw')}</span>
                    <input
                      className="mod-search"
                      type="password"
                      style={{ width: '100%' }}
                      value={ownerPw}
                      onChange={(e) => setOwnerPw(e.target.value)}
                    />
                  </label>
                </>
              )}

              {showDecrypt && (
                <label className="hosts-edit">
                  <span className="label">{t('pdftk.currentPw')}</span>
                  <input
                    className="mod-search"
                    type="password"
                    style={{ width: '100%' }}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}

              {showOutput && (
                <label className="hosts-edit">
                  <span className="label">
                    {op === 'splitPage' ? t('pdftk.outputPattern') : t('pdftk.outputFile')}
                  </span>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    placeholder={op === 'splitPage' ? 'C:\\out\\page-%d.pdf' : 'C:\\out\\result.pdf'}
                    value={output}
                    onChange={(e) => setOutput(e.target.value)}
                  />
                </label>
              )}
            </div>

            <p className="count-note">{t(`pdftk.help_${op}`)}</p>

            <div className="mod-toolbar" style={{ marginTop: 4 }}>
              <button className="mini primary" disabled={busy} onClick={() => run(path)}>
                {busy ? t('pdftk.running') : t('pdftk.runOp')}
              </button>
              {output.trim() && op !== 'info' && (
                <button className="mini" disabled={busy} onClick={() => openFolder(output)}>
                  {t('pdftk.openOutput')}
                </button>
              )}
            </div>

            {err && <pre className="cmd-out error">{err}</pre>}
            {out && <pre className="cmd-out">{out}</pre>}

            <p className="count-note">{t('pdftk.note')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
