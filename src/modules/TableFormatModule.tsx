import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Delimiter = 'auto' | 'comma' | 'tab' | 'pipe';
type OutputFormat = 'ascii' | 'markdown';
type Align = 'left' | 'right' | 'center';

// Monospace display width: CJK / full-width code points count as 2 columns.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function displayWidth(s: string): number {
  if (!s) return 0;
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  let sawDash = false;
  for (const c of t) {
    if (c === '-' || c === '=') sawDash = true;
    else if (c !== '|' && c !== '+' && c !== ':' && c !== ' ') return false;
  }
  return sawDash;
}

function autoDetect(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const raw of lines) {
    if (raw.length === 0 || isSeparatorLine(raw)) continue;
    if (raw.includes('\t')) return '\t';
    if (raw.includes('|')) return '|';
    if (raw.includes(',')) return ',';
    return ',';
  }
  return ',';
}

function resolveDelimiter(input: string, delim: Delimiter): string {
  switch (delim) {
    case 'comma':
      return ',';
    case 'tab':
      return '\t';
    case 'pipe':
      return '|';
    default:
      return autoDetect(input);
  }
}

// Split one line on a delimiter, tolerating double-quoted fields ("" escapes a quote).
function splitLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let sb = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          sb += '"';
          i++;
        } else inQuotes = false;
      } else sb += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      cells.push(sb.trim());
      sb = '';
    } else sb += c;
  }
  cells.push(sb.trim());
  return cells;
}

function parse(input: string, delim: Delimiter): string[][] {
  const rows: string[][] = [];
  if (!input) return rows;
  try {
    const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const ch = resolveDelimiter(input, delim);

    for (const raw of lines) {
      let line = raw;
      if (line.length === 0) continue;
      if (isSeparatorLine(line)) continue;

      // Strip a leading/trailing pipe border if the line is pipe-delimited & bordered.
      if (ch === '|') {
        let t = line.trim();
        if (t.startsWith('|')) t = t.substring(1);
        if (t.endsWith('|')) t = t.substring(0, t.length - 1);
        line = t;
      }

      rows.push(splitLine(line, ch));
    }

    // Normalise to a rectangle.
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length;
    for (const r of rows) while (r.length < cols) r.push('');
  } catch {
    return rows;
  }
  return rows;
}

function cell(row: string[], c: number): string {
  return c < row.length ? row[c] ?? '' : '';
}

function pad(s: string, width: number, align: Align): string {
  const len = displayWidth(s);
  const gap = width - len;
  if (gap <= 0) return s;
  switch (align) {
    case 'right':
      return ' '.repeat(gap) + s;
    case 'center': {
      const left = Math.floor(gap / 2);
      const right = gap - left;
      return ' '.repeat(left) + s + ' '.repeat(right);
    }
    default:
      return s + ' '.repeat(gap);
  }
}

function buildBorder(cols: number, widths: number[]): string {
  let sb = '+';
  for (let c = 0; c < cols; c++) sb += '-'.repeat((widths[c] ?? 0) + 2) + '+';
  return sb;
}

function buildRow(row: string[], cols: number, widths: number[], align: Align): string {
  let sb = '|';
  for (let c = 0; c < cols; c++) sb += ' ' + pad(cell(row, c), widths[c] ?? 0, align) + ' |';
  return sb;
}

function renderAscii(rows: string[][], cols: number, widths: number[], align: Align, header: boolean): string {
  const border = buildBorder(cols, widths);
  let sb = border + '\n';
  for (let r = 0; r < rows.length; r++) {
    sb += buildRow(rows[r]!, cols, widths, align) + '\n';
    if (header && r === 0) sb += border + '\n';
  }
  sb += border;
  return sb;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function mdRow(row: string[], cols: number, widths: number[], align: Align): string {
  let sb = '|';
  for (let c = 0; c < cols; c++) sb += ' ' + pad(escapeMd(cell(row, c)), widths[c] ?? 0, align) + ' |';
  return sb;
}

function mdSeparator(cols: number, widths: number[], align: Align): string {
  let sb = '|';
  for (let c = 0; c < cols; c++) {
    const w = widths[c] ?? 0;
    let dashes: string;
    switch (align) {
      case 'right':
        dashes = '-'.repeat(Math.max(1, w + 1)) + ':';
        break;
      case 'center':
        dashes = ':' + '-'.repeat(Math.max(1, w)) + ':';
        break;
      default:
        dashes = ':' + '-'.repeat(Math.max(1, w + 1));
        break;
    }
    sb += ' ' + dashes + ' |';
  }
  return sb;
}

function renderMarkdown(rows: string[][], cols: number, widths: number[], align: Align, header: boolean): string {
  let start = 0;
  let headerRow: string[];
  if (header && rows.length > 0) {
    headerRow = rows[0]!;
    start = 1;
  } else {
    headerRow = new Array<string>(cols).fill('');
  }

  let sb = mdRow(headerRow, cols, widths, align) + '\n';
  sb += mdSeparator(cols, widths, align) + '\n';
  for (let r = start; r < rows.length; r++) {
    sb += mdRow(rows[r]!, cols, widths, align);
    if (r < rows.length - 1) sb += '\n';
  }
  return sb;
}

function render(rows: string[][], format: OutputFormat, align: Align, firstRowHeader: boolean): string {
  try {
    if (rows.length === 0) return '';
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length;
    if (cols === 0) return '';

    const widths = new Array<number>(cols).fill(0);
    for (const r of rows)
      for (let c = 0; c < cols; c++) {
        const w = displayWidth(cell(r, c));
        if (w > (widths[c] ?? 0)) widths[c] = w;
      }
    for (let c = 0; c < cols; c++) if ((widths[c] ?? 0) < 3) widths[c] = 3; // readable minimum

    return format === 'markdown'
      ? renderMarkdown(rows, cols, widths, align, firstRowHeader)
      : renderAscii(rows, cols, widths, align, firstRowHeader);
  } catch {
    return '';
  }
}

export function TableFormatModule() {
  const { t } = useTranslation();
  const [delim, setDelim] = useState<Delimiter>('auto');
  const [format, setFormat] = useState<OutputFormat>('ascii');
  const [align, setAlign] = useState<Align>('left');
  const [header, setHeader] = useState(true);
  const [input, setInput] = useState(t('tableformat.sample'));
  const [copied, setCopied] = useState(false);

  const { output, status } = useMemo(() => {
    try {
      const grid = parse(input, delim);
      const out = render(grid, format, align, header);
      if (grid.length === 0) {
        return { output: out, status: t('tableformat.waiting') };
      }
      const cols = grid[0]?.length ?? 0;
      return {
        output: out,
        status: t('tableformat.dims', { rows: grid.length, cols }),
      };
    } catch {
      return { output: '', status: t('tableformat.error') };
    }
  }, [input, delim, format, align, header, t]);

  const copy = () => {
    if (!output.length) {
      setCopied(false);
      return;
    }
    void navigator.clipboard?.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginBottom: 12 }}>
        {t('tableformat.blurb')}
      </p>

      <div className="mod-toolbar">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
          <span className="count-note">{t('tableformat.delimiter')}</span>
          <select className="mod-search" value={delim} onChange={(e) => setDelim(e.target.value as Delimiter)}>
            <option value="auto">{t('tableformat.delim.auto')}</option>
            <option value="comma">{t('tableformat.delim.comma')}</option>
            <option value="tab">{t('tableformat.delim.tab')}</option>
            <option value="pipe">{t('tableformat.delim.pipe')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
          <span className="count-note">{t('tableformat.outputFormat')}</span>
          <select className="mod-search" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            <option value="ascii">{t('tableformat.fmt.ascii')}</option>
            <option value="markdown">{t('tableformat.fmt.markdown')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
          <span className="count-note">{t('tableformat.alignment')}</span>
          <select className="mod-search" value={align} onChange={(e) => setAlign(e.target.value as Align)}>
            <option value="left">{t('tableformat.align.left')}</option>
            <option value="right">{t('tableformat.align.right')}</option>
            <option value="center">{t('tableformat.align.center')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          {t('tableformat.firstRowHeader')}
        </label>
        <button className="mini" disabled={!output} onClick={copy}>
          {copied ? t('tableformat.copied') : t('tableformat.copy')}
        </button>
        <button className="mini" onClick={() => setInput('')}>
          {t('tableformat.clear')}
        </button>
      </div>

      <div className="io-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note">{t('tableformat.inputLabel')}</span>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('tableformat.inputPlaceholder')}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="count-note">{t('tableformat.outputLabel')}</span>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={output}
            style={{ whiteSpace: 'pre', fontFamily: 'Consolas, monospace' }}
            placeholder={t('tableformat.outputPlaceholder')}
          />
        </div>
      </div>

      <p className="count-note" style={{ marginTop: 10 }}>
        {status}
      </p>
    </div>
  );
}
