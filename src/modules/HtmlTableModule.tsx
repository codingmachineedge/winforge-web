import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---------- grid model ----------
type Grid = string[][];

function colCount(rows: Grid): number {
  let max = 0;
  for (const r of rows) if (r.length > max) max = r.length;
  return max;
}

// ---------- delimited helpers ----------
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function count(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

// delim: 0 = auto, 1 = comma, 2 = tab, 3 = pipe
function resolveDelimiter(lines: string[], delim: number): string {
  if (delim === 1) return ',';
  if (delim === 2) return '\t';
  if (delim === 3) return '|';
  // Auto — count candidates on the first non-empty line, prefer the most frequent.
  let sample = '';
  for (const l of lines) {
    if (l.length > 0) {
      sample = l;
      break;
    }
  }
  const tabs = count(sample, '\t');
  const pipes = count(sample, '|');
  const commas = count(sample, ',');
  if (tabs >= pipes && tabs >= commas && tabs > 0) return '\t';
  if (pipes >= commas && pipes > 0) return '|';
  if (commas > 0) return ',';
  return tabs > 0 ? '\t' : ',';
}

function splitSimple(line: string, sep: string): string[] {
  return line.split(sep).map((p) => p.trim());
}

// Minimal RFC-4180-ish CSV line splitter (handles quotes and escaped quotes).
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        buf += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        fields.push(buf.trim());
        buf = '';
      } else buf += c;
    }
  }
  fields.push(buf.trim());
  return fields;
}

function parseDelimited(text: string, delim: number): Grid {
  const rows: Grid = [];
  if (!text) return rows;
  try {
    const lines = splitLines(text);
    const sep = resolveDelimiter(lines, delim);
    for (const line of lines) {
      if (line.length === 0) continue;
      rows.push(sep === ',' ? splitCsvLine(line) : splitSimple(line, sep));
    }
  } catch {
    /* tolerant */
  }
  return rows;
}

// ---------- Data → HTML ----------
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function cell(raw: string, escape: boolean): string {
  return escape ? escHtml(raw ?? '') : raw ?? '';
}

function toHtml(rows: Grid, firstRowHeader: boolean, escapeCells: boolean, cssClass: string): string {
  let out = '';
  try {
    const cls = !cssClass || !cssClass.trim() ? '' : ` class="${escAttr(cssClass.trim())}"`;
    out += `<table${cls}>\n`;

    let start = 0;
    if (firstRowHeader && rows.length > 0) {
      out += '  <thead>\n    <tr>\n';
      for (const c of rows[0]!) out += `      <th>${cell(c, escapeCells)}</th>\n`;
      out += '    </tr>\n  </thead>\n';
      start = 1;
    }

    out += '  <tbody>\n';
    for (let i = start; i < rows.length; i++) {
      out += '    <tr>\n';
      for (const c of rows[i]!) out += `      <td>${cell(c, escapeCells)}</td>\n`;
      out += '    </tr>\n';
    }
    out += '  </tbody>\n';
    out += '</table>\n';
  } catch {
    /* tolerant */
  }
  return out;
}

// ---------- HTML → Data ----------
const RX_TABLE = /<table[^>]*>([\s\S]*?)<\/table>/i;
const RX_ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const RX_CELL = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
const RX_ANY_TAG = /<[^>]+>/g;

function mapEntity(ent: string): string | null {
  switch (ent) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    case 'nbsp':
      return ' ';
    case '#39':
      return "'";
  }
  if (ent.length > 1 && ent[0] === '#') {
    try {
      let code: number;
      if (ent[1] === 'x' || ent[1] === 'X') code = parseInt(ent.substring(2), 16);
      else code = parseInt(ent.substring(1), 10);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    } catch {
      /* ignore bad numeric entity */
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      const limit = Math.min(10, s.length - i - 1);
      const semi = s.indexOf(';', i + 1);
      if (semi > i && semi - (i + 1) <= limit) {
        const ent = s.substring(i + 1, semi);
        const rep = mapEntity(ent);
        if (rep != null) {
          out += rep;
          i = semi;
          continue;
        }
      }
    }
    out += s[i];
  }
  return out;
}

function cleanCell(s: string): string {
  // strip tags, collapse whitespace, decode a few common entities
  let noTags = s.replace(RX_ANY_TAG, ' ');
  noTags = decodeEntities(noTags);
  noTags = noTags.replace(/\s+/g, ' ').trim();
  return noTags;
}

function parseHtml(html: string): Grid {
  const rows: Grid = [];
  if (!html) return rows;
  try {
    // Prefer the first <table>…</table>; otherwise fall back to scanning raw <tr> blocks.
    const tm = RX_TABLE.exec(html);
    const scope = tm ? tm[1]! : html;

    RX_ROW.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RX_ROW.exec(scope)) !== null) {
      const cells: string[] = [];
      const rowBody = rm[1]!;
      RX_CELL.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = RX_CELL.exec(rowBody)) !== null) {
        cells.push(cleanCell(cm[2]!));
      }
      if (cells.length > 0) rows.push(cells);
    }
  } catch {
    /* tolerant */
  }
  return rows;
}

function csvField(s: string): string {
  s = s ?? '';
  const need = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0;
  if (!need) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function renderCsv(rows: Grid): string {
  let out = '';
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (i > 0) out += ',';
      out += csvField(row[i]!);
    }
    out += '\n';
  }
  return out;
}

function renderSeparated(rows: Grid, sep: string): string {
  let out = '';
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (i > 0) out += sep;
      out += (row[i] ?? '').replace(/\t/g, ' ').replace(/\r/g, '').replace(/\n/g, ' ');
    }
    out += '\n';
  }
  return out;
}

function appendMdRow(row: string[], cols: number): string {
  let out = '|';
  for (let c = 0; c < cols; c++) {
    let v = c < row.length ? row[c] ?? '' : '';
    v = v.replace(/\r/g, '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
    out += ' ' + v + ' |';
  }
  out += '\n';
  return out;
}

function renderMarkdown(rows: Grid): string {
  if (rows.length === 0) return '';
  const cols = colCount(rows);
  if (cols === 0) return '';
  let out = '';
  // header = first row, padded
  out += appendMdRow(rows[0]!, cols);
  out += '|';
  for (let c = 0; c < cols; c++) out += ' --- |';
  out += '\n';
  for (let r = 1; r < rows.length; r++) out += appendMdRow(rows[r]!, cols);
  return out;
}

// fmt: 0 = CSV, 1 = TSV, 2 = Markdown
function toData(rows: Grid, fmt: number): string {
  try {
    if (fmt === 2) return renderMarkdown(rows);
    if (fmt === 1) return renderSeparated(rows, '\t');
    return renderCsv(rows);
  } catch {
    return '';
  }
}

export function HtmlTableModule() {
  const { t } = useTranslation();

  const [dir, setDir] = useState(0); // 0 = Data → HTML, 1 = HTML → Data
  const [delim, setDelim] = useState(0); // Auto / Comma / Tab / Pipe
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  const [escapeCells, setEscapeCells] = useState(true);
  const [cssClass, setCssClass] = useState('');
  const [outFmt, setOutFmt] = useState(0); // CSV / TSV / Markdown
  const [input, setInput] = useState('Name, Role, City\nAda, Admin, London\nGrace, Dev, New York');
  const [copied, setCopied] = useState(false);

  const dataToHtml = dir === 0;

  const { output, stats, ok } = useMemo(() => {
    try {
      let rows: Grid;
      let out: string;
      if (dataToHtml) {
        rows = parseDelimited(input, delim);
        out = toHtml(rows, firstRowHeader, escapeCells, cssClass);
      } else {
        rows = parseHtml(input);
        out = toData(rows, outFmt);
      }
      const rc = rows.length;
      const cc = colCount(rows);
      return {
        output: out,
        stats: t('htmltable.stats', { rows: rc, cols: cc }),
        ok: true,
      };
    } catch {
      return { output: '', stats: t('htmltable.parseError'), ok: false };
    }
  }, [input, dataToHtml, delim, firstRowHeader, escapeCells, cssClass, outFmt, t]);

  const copy = () => {
    if (!output) return;
    void navigator.clipboard?.writeText(output);
    setCopied(true);
  };

  const onDir = (v: number) => {
    setDir(v);
    setCopied(false);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('htmltable.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('htmltable.direction')}</span>
        <select
          className="mod-select"
          value={dir}
          onChange={(e) => onDir(Number(e.target.value))}
        >
          <option value={0}>{t('htmltable.dirData2Html')}</option>
          <option value={1}>{t('htmltable.dirHtml2Data')}</option>
        </select>
      </div>

      {/* Options card */}
      <div
        style={{
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          padding: '12px 14px',
          marginTop: 12,
          marginBottom: 12,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 14,
        }}
      >
        {dataToHtml ? (
          <>
            <span className="count-note">{t('htmltable.delimiter')}</span>
            <select
              className="mod-select"
              value={delim}
              onChange={(e) => setDelim(Number(e.target.value))}
            >
              <option value={0}>{t('htmltable.delimAuto')}</option>
              <option value={1}>{t('htmltable.delimComma')}</option>
              <option value={2}>{t('htmltable.delimTab')}</option>
              <option value={3}>{t('htmltable.delimPipe')}</option>
            </select>
            <label className="chk">
              <input
                type="checkbox"
                checked={firstRowHeader}
                onChange={(e) => setFirstRowHeader(e.target.checked)}
              />
              {t('htmltable.firstRowHeader')}
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={escapeCells}
                onChange={(e) => setEscapeCells(e.target.checked)}
              />
              {t('htmltable.escapeCells')}
            </label>
            <span className="count-note">{t('htmltable.cssClass')}</span>
            <input
              className="mod-search"
              style={{ maxWidth: 200 }}
              value={cssClass}
              onChange={(e) => setCssClass(e.target.value)}
            />
          </>
        ) : (
          <>
            <span className="count-note">{t('htmltable.outFormat')}</span>
            <select
              className="mod-select"
              value={outFmt}
              onChange={(e) => setOutFmt(Number(e.target.value))}
            >
              <option value={0}>{t('htmltable.fmtCsv')}</option>
              <option value={1}>{t('htmltable.fmtTsv')}</option>
              <option value={2}>{t('htmltable.fmtMarkdown')}</option>
            </select>
          </>
        )}
      </div>

      <div className="mod-toolbar" style={{ marginBottom: 6 }}>
        <span className="count-note" style={{ flex: 1 }}>
          {dataToHtml ? t('htmltable.inputData') : t('htmltable.inputHtml')}
        </span>
        <span className="count-note">{dataToHtml ? t('htmltable.outputHtml') : t('htmltable.outputData')}</span>
        <button className="mini" disabled={!output} onClick={copy}>
          {copied ? t('htmltable.copied') : t('htmltable.copy')}
        </button>
      </div>

      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setCopied(false);
          }}
          placeholder={dataToHtml ? t('htmltable.inputData') : t('htmltable.inputHtml')}
        />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} />
      </div>

      <p className={ok ? 'count-note' : ''} style={ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
        {stats}
      </p>
    </div>
  );
}
