import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful RFC 4180 CSV linter + repairer, ported from WinForge's CsvLintService.
// Pure client, never throws.

type Severity = 'Info' | 'Warning' | 'Error';

interface Issue {
  level: Severity;
  line: number; // 1-based; 0 = whole-document
  message: string;
}

interface LintResult {
  issues: Issue[];
  rows: number;
  cols: number;
  hadBom: boolean;
  error?: string;
}

interface RepairResult {
  output: string;
  rows: number;
  cols: number;
  paddedRows: number;
  truncatedRows: number;
  error?: string;
}

const BOM = '﻿';

/** Guess the most likely delimiter from a sample of the text. */
function detectDelimiter(text: string): string {
  try {
    if (!text) return ',';
    const candidates = [',', ';', '\t', '|'];
    const counts = new Array<number>(candidates.length).fill(0);
    let inQuotes = false;
    for (const c of text) {
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (c === '\n' || c === '\r')) {
        let any = false;
        for (let i = 0; i < counts.length; i++) if (counts[i]! > 0) any = true;
        if (any) break;
      } else if (!inQuotes) {
        for (let i = 0; i < candidates.length; i++) if (c === candidates[i]) counts[i]!++;
      }
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i]! > counts[best]!) best = i;
    return counts[best]! > 0 ? candidates[best]! : ',';
  } catch {
    return ',';
  }
}

/**
 * Parse into rows of fields, honouring RFC 4180 quoting. Fills what it parsed
 * even on a hard structural problem (unterminated quote).
 */
function parseCsv(text: string, delim: string): { rows: string[][]; unterminatedQuote: boolean } {
  let unterminatedQuote = false;
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;

  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') {
        inQuotes = true;
        fieldStarted = true;
      } else if (c === delim) {
        row.push(field);
        field = '';
        fieldStarted = true;
      } else if (c === '\r') {
        if (i + 1 < n && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        fieldStarted = false;
      } else if (c === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        fieldStarted = false;
      } else {
        field += c;
        fieldStarted = true;
      }
    }
  }

  if (inQuotes) unterminatedQuote = true;

  // Flush the last field/row unless the file ended cleanly on a newline.
  if (fieldStarted || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { rows, unterminatedQuote };
}

// Split into physical lines on CRLF / LF / lone CR, preserving no terminators.
function splitPhysicalLines(text: string): string[] {
  const list: string[] = [];
  let sb = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') i++;
      list.push(sb);
      sb = '';
    } else if (c === '\n') {
      list.push(sb);
      sb = '';
    } else sb += c;
  }
  list.push(sb);
  return list;
}

/** Run all checks. Never throws; a caught exception lands in error. */
function lint(input: string, delim: string): LintResult {
  const r: LintResult = { issues: [], rows: 0, cols: 0, hadBom: false };
  try {
    if (!input) return r;

    // BOM.
    let text = input;
    if (text.length > 0 && text[0] === BOM) {
      r.hadBom = true;
      r.issues.push({ level: 'Warning', line: 1, message: 'UTF-8 BOM detected at the start of the file · 檔案開頭有 UTF-8 BOM' });
      text = text.substring(1);
    }

    // Mixed line endings.
    let crlf = 0;
    let lfOnly = 0;
    let crOnly = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\r') {
        if (i + 1 < text.length && text[i + 1] === '\n') {
          crlf++;
          i++;
        } else crOnly++;
      } else if (text[i] === '\n') lfOnly++;
    }
    const styles = (crlf > 0 ? 1 : 0) + (lfOnly > 0 ? 1 : 0) + (crOnly > 0 ? 1 : 0);
    if (styles > 1)
      r.issues.push({ level: 'Warning', line: 0, message: `Mixed line endings (CRLF×${crlf}, LF×${lfOnly}, CR×${crOnly}) · 換行符號唔一致` });

    // Line-level checks over raw physical lines.
    const lines = splitPhysicalLines(text);
    let lastNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i]!.length > 0) lastNonEmpty = i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;

      // Trailing whitespace.
      const last = line[line.length - 1];
      if (line.length > 0 && (last === ' ' || last === '\t'))
        r.issues.push({ level: 'Info', line: lineNo, message: 'Trailing whitespace · 尾部有多餘空白' });

      // Empty trailing lines (blank lines after the last content line).
      if (line.length === 0 && i > lastNonEmpty && lastNonEmpty >= 0)
        r.issues.push({ level: 'Info', line: lineNo, message: 'Empty trailing line · 尾部空白行' });
    }

    // Unbalanced / unescaped quotes across the whole document.
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') {
        if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
          i++;
          continue;
        }
        inQuotes = !inQuotes;
      }
    }
    if (inQuotes)
      r.issues.push({ level: 'Error', line: 0, message: 'Unbalanced quotes — a " is never closed · 引號唔對稱，有 " 冇收尾' });

    // Structural parse for ragged rows + stray CR/LF in unquoted fields.
    const { rows, unterminatedQuote } = parseCsv(text, delim);
    if (unterminatedQuote && !inQuotes)
      r.issues.push({ level: 'Error', line: 0, message: 'Unterminated quoted field · 引號欄位未收尾' });

    if (rows.length > 0) {
      const headerWidth = rows[0]!.length;
      r.cols = headerWidth;
      r.rows = rows.length;

      for (let ri = 0; ri < rows.length; ri++) {
        const fields = rows[ri]!;
        if (fields.length !== headerWidth)
          r.issues.push({
            level: 'Error',
            line: ri + 1,
            message: `Ragged row: ${fields.length} field(s), header has ${headerWidth} · 欄位數目唔啱（${fields.length} vs ${headerWidth}）`,
          });

        for (const f of fields) {
          if (f.indexOf('\r') >= 0 || f.indexOf('\n') >= 0) {
            r.issues.push({ level: 'Warning', line: ri + 1, message: 'Stray CR/LF inside an unquoted field · 未加引號欄位入面有 CR/LF' });
            break;
          }
        }
      }
    }

    return r;
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
    return r;
  }
}

function escapeField(field: string, delim: string): string {
  const f = field ?? '';
  const needsQuote = f.indexOf('"') >= 0 || f.indexOf(delim) >= 0 || f.indexOf('\n') >= 0 || f.indexOf('\r') >= 0;
  if (!needsQuote) return f;
  return '"' + f.replace(/"/g, '""') + '"';
}

/**
 * Rewrite the document to be RFC 4180-compliant: strip BOM, quote fields that
 * need it, double embedded quotes, normalise to CRLF, pad/truncate ragged rows
 * to the header width. Never throws.
 */
function repair(input: string, delim: string): RepairResult {
  const res: RepairResult = { output: '', rows: 0, cols: 0, paddedRows: 0, truncatedRows: 0 };
  try {
    if (!input) {
      res.output = '';
      return res;
    }

    let text = input;
    if (text.length > 0 && text[0] === BOM) text = text.substring(1);

    const { rows } = parseCsv(text, delim);

    // Drop empty trailing rows (a single empty field row is treated as blank).
    while (rows.length > 0) {
      const lastRow = rows[rows.length - 1]!;
      if (lastRow.length === 1 && lastRow[0]!.length === 0) rows.pop();
      else break;
    }

    if (rows.length === 0) {
      res.output = '';
      return res;
    }

    const width = rows[0]!.length;
    res.cols = width;
    let sb = '';

    for (let ri = 0; ri < rows.length; ri++) {
      let fields = rows[ri]!;
      if (fields.length < width) {
        while (fields.length < width) fields.push('');
        res.paddedRows++;
      } else if (fields.length > width) {
        fields = fields.slice(0, width);
        res.truncatedRows++;
      }

      for (let fi = 0; fi < fields.length; fi++) {
        if (fi > 0) sb += delim;
        sb += escapeField(fields[fi]!, delim);
      }
      sb += '\r\n';
    }

    res.output = sb;
    res.rows = rows.length;
    return res;
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    return res;
  }
}

// Delimiter selector index → actual char, mirroring CurrentDelimiter().
function currentDelimiter(index: number, input: string): string {
  switch (index) {
    case 0:
      return ',';
    case 1:
      return ';';
    case 2:
      return '\t';
    case 3:
      return '|';
    case 4:
      return detectDelimiter(input);
    default:
      return ',';
  }
}

const SAMPLE =
  'name,role,city\n' +
  'Ada,"Engineer, Lead",London\n' +
  'Grace,Admiral,Arlington ,extra\n' +
  'Linus,Maintainer\n';

export function CsvLintModule() {
  const { t } = useTranslation();
  const [delimIndex, setDelimIndex] = useState(0);
  const [input, setInput] = useState(SAMPLE);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  const delimiterLabels = useMemo(
    () => [t('csvlint.delimComma'), t('csvlint.delimSemicolon'), t('csvlint.delimTab'), t('csvlint.delimPipe'), t('csvlint.delimAuto')],
    [t],
  );

  const levelText = (lvl: Severity) =>
    lvl === 'Error' ? t('csvlint.levelError') : lvl === 'Warning' ? t('csvlint.levelWarning') : t('csvlint.levelInfo');

  const runLint = (idx: number = delimIndex, text: string = input) => {
    setIssues(null);
    if (!text.trim()) {
      setStatus({ ok: true, msg: t('csvlint.begin') });
      setIssues([]);
      return;
    }
    const delim = currentDelimiter(idx, text);
    const r = lint(text, delim);
    if (r.error) {
      setStatus({ ok: false, msg: t('csvlint.error', { msg: r.error }) });
      return;
    }
    setIssues(r.issues);
    if (r.issues.length === 0)
      setStatus({ ok: true, msg: t('csvlint.clean', { rows: r.rows, cols: r.cols }) });
    else setStatus({ ok: true, msg: t('csvlint.found', { rows: r.rows, cols: r.cols, count: r.issues.length }) });
  };

  const runRepair = () => {
    if (!input.trim()) {
      setOutput('');
      setStatus({ ok: false, msg: t('csvlint.nothingRepair') });
      return;
    }
    const delim = currentDelimiter(delimIndex, input);
    const r = repair(input, delim);
    if (r.error) {
      setOutput('');
      setStatus({ ok: false, msg: t('csvlint.error', { msg: r.error }) });
      return;
    }
    setOutput(r.output);

    let note = '';
    if (r.paddedRows > 0) note += t('csvlint.notePadded', { count: r.paddedRows });
    if (r.truncatedRows > 0) note += t('csvlint.noteTruncated', { count: r.truncatedRows });
    setStatus({ ok: true, msg: t('csvlint.repaired', { rows: r.rows, cols: r.cols, note }) });
  };

  const copy = () => {
    if (!output) {
      setStatus({ ok: false, msg: t('csvlint.nothingCopy') });
      return;
    }
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('csvlint.copied') });
  };

  const levelColor = (lvl: Severity) =>
    lvl === 'Error' ? 'var(--danger)' : lvl === 'Warning' ? 'var(--warn, #d29922)' : 'var(--text-tertiary)';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('csvlint.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('csvlint.delimiter')}</span>
        <select
          className="mod-search"
          style={{ maxWidth: 180 }}
          value={delimIndex}
          onChange={(e) => {
            const idx = +e.target.value;
            setDelimIndex(idx);
            runLint(idx, input);
          }}
        >
          {delimiterLabels.map((lbl, i) => (
            <option key={i} value={i}>
              {lbl}
            </option>
          ))}
        </select>
        <button className="mini primary" onClick={() => runLint()}>
          {t('csvlint.lint')}
        </button>
        <button className="mini" onClick={runRepair}>
          {t('csvlint.repair')}
        </button>
      </div>

      {status && (
        <p className={status.ok ? 'count-note' : ''} style={status.ok ? { marginTop: 4, marginBottom: 12 } : { marginTop: 4, marginBottom: 12, color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
        <label style={{ fontWeight: 600, fontSize: 13 }}>{t('csvlint.inputLabel')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 160, whiteSpace: 'pre', fontFamily: 'monospace' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('csvlint.inputPlaceholder')}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
        <label style={{ fontWeight: 600, fontSize: 13 }}>{t('csvlint.issuesLabel')}</label>
        <div style={{ border: '1px solid var(--border, #30363d)', borderRadius: 6, maxHeight: 280, overflow: 'auto' }}>
          {issues && issues.length > 0 ? (
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>{t('csvlint.colLevel')}</th>
                  <th style={{ width: 56 }}>{t('csvlint.colLine')}</th>
                  <th>{t('csvlint.colMessage')}</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((iss, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600, color: levelColor(iss.level) }}>{levelText(iss.level)}</td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--text-tertiary)' }}>{iss.line <= 0 ? '—' : iss.line}</td>
                    <td>{iss.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="count-note" style={{ margin: 0, padding: '10px 12px' }}>
              {issues && issues.length === 0 ? t('csvlint.noIssues') : t('csvlint.begin')}
            </p>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ fontWeight: 600, fontSize: 13 }}>{t('csvlint.outputLabel')}</label>
          <button className="mini" disabled={!output} onClick={copy}>
            {t('csvlint.copy')}
          </button>
        </div>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          style={{ minHeight: 150, whiteSpace: 'pre', fontFamily: 'monospace' }}
          value={output}
          placeholder={t('csvlint.outputPlaceholder')}
        />
      </div>
    </div>
  );
}
