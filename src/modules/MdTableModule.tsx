import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- port of WinForge Services/MdTableService.cs ----
type Align = 0 | 1 | 2 | 3; // None, Left, Center, Right
type Grid = string[][];
const colCount = (g: Grid) => (g.length === 0 ? 0 : Math.max(...g.map((r) => r.length)));

function resolveDelimiter(d: string, sample: string): string {
  if (d === 'comma') return ',';
  if (d === 'tab') return '\t';
  if (d === 'pipe') return '|';
  // auto: most frequent of , \t | on the first non-empty line
  const line = sample.replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim().length > 0) ?? '';
  const count = (ch: string) => line.split(ch).length - 1;
  const cands: [string, number][] = [[',', count(',')], ['\t', count('\t')], ['|', count('|')]];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0]![1] > 0 ? cands[0]![0] : ',';
}

function splitCsvLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let sb = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { sb += '"'; i++; }
      else if (c === '"') inQ = false;
      else sb += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { cells.push(sb.trim()); sb = ''; }
    else sb += c;
  }
  cells.push(sb.trim());
  return cells;
}

function parseDelimited(text: string, delim: string): Grid {
  const grid: Grid = [];
  const norm = text.replace(/\r\n?/g, '\n');
  for (const line of norm.split('\n')) {
    if (line.trim().length === 0) continue;
    if (delim === ',') grid.push(splitCsvLine(line, delim));
    else {
      let cells = line.split(delim).map((c) => c.trim());
      if (delim === '|') {
        if (cells.length && cells[0] === '') cells = cells.slice(1);
        if (cells.length && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
      }
      grid.push(cells);
    }
  }
  return grid;
}

const isSeparatorRow = (line: string) => {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = t.split('|');
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c) && c.includes('-'));
};

function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  return lines.length >= 2 && lines.some((l) => isSeparatorRow(l)) && lines[0]!.includes('|');
}

const splitMarkdownRow = (line: string) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};

function parseAlignRow(line: string): Align[] {
  return splitMarkdownRow(line).map((cell) => {
    const c = cell.trim();
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return (l && r ? 2 : r ? 3 : l ? 1 : 0) as Align;
  });
}

function parseMarkdown(text: string): { grid: Grid; aligns: Align[] } {
  const grid: Grid = [];
  let aligns: Align[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((l, i) => {
    if (i === 1 && isSeparatorRow(l)) aligns = parseAlignRow(l);
    else grid.push(splitMarkdownRow(l));
  });
  return { grid, aligns };
}

// ---- rendering ----
const escapeCell = (s: string) => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

function sepToken(a: Align, width: number): string {
  const w = Math.max(3, width);
  if (a === 1) return ':' + '-'.repeat(Math.max(2, w - 1));
  if (a === 3) return '-'.repeat(Math.max(2, w - 1)) + ':';
  if (a === 2) return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
  return '-'.repeat(w);
}
function padCell(cell: string, width: number, a: Align): string {
  const gap = width - cell.length;
  if (gap <= 0) return cell;
  if (a === 3) return ' '.repeat(gap) + cell;
  if (a === 2) { const left = Math.floor(gap / 2); return ' '.repeat(left) + cell + ' '.repeat(gap - left); }
  return cell + ' '.repeat(gap);
}

function renderMarkdown(grid: Grid, aligns: Align[], firstRowHeader: boolean, pad: boolean): string {
  if (grid.length === 0) return '';
  const cols = colCount(grid);
  if (cols === 0) return '';
  const rows = grid.map((r) => {
    const cells = r.map(escapeCell);
    while (cells.length < cols) cells.push('');
    return cells;
  });
  let header: string[];
  let body: string[][];
  if (firstRowHeader) { header = rows[0]!; body = rows.slice(1); }
  else { header = Array.from({ length: cols }, (_, i) => 'Column ' + (i + 1)); body = rows; }
  const alignAt = (i: number): Align => (i < aligns.length ? aligns[i]! : 0);
  const plainRow = (row: string[]) => '|' + Array.from({ length: cols }, (_, i) => ' ' + (row[i] ?? '') + ' |').join('') + '\n';
  if (!pad) {
    let out = plainRow(header);
    out += '|' + Array.from({ length: cols }, (_, i) => ' ' + sepToken(alignAt(i), 3) + ' |').join('') + '\n';
    for (const row of body) out += plainRow(row);
    return out.replace(/\n$/, '');
  }
  const w = Array.from({ length: cols }, (_, i) => Math.max(3, header[i]?.length ?? 0));
  for (const row of body) for (let i = 0; i < cols && i < row.length; i++) w[i] = Math.max(w[i]!, row[i]!.length);
  const paddedRow = (row: string[]) => '|' + Array.from({ length: cols }, (_, i) => ' ' + padCell(row[i] ?? '', w[i]!, alignAt(i)) + ' |').join('') + '\n';
  let out = paddedRow(header);
  out += '|' + Array.from({ length: cols }, (_, i) => ' ' + sepToken(alignAt(i), w[i]!) + ' |').join('') + '\n';
  for (const row of body) out += paddedRow(row);
  return out.replace(/\n$/, '');
}

const quoteIfNeeded = (s: string, delim: string) =>
  delim === ',' && (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;

function renderDelimited(grid: Grid, delim: string): string {
  if (grid.length === 0) return '';
  return grid.map((row) => row.map((c) => quoteIfNeeded(c ?? '', delim)).join(delim)).join('\n');
}

// ---- component ----
export function MdTableModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('name, role, city\nAda, engineer, London\nGrace, admiral, Arlington');
  const [delim, setDelim] = useState('auto');
  const [header, setHeader] = useState(true);
  const [pad, setPad] = useState(true);
  const [outFmt, setOutFmt] = useState('markdown');
  const [aligns, setAligns] = useState<Align[]>([]);
  const [note, setNote] = useState('');

  const reverse = useMemo(() => looksLikeMarkdownTable(input), [input]);
  const { grid, detected, firstRowHeader } = useMemo(() => {
    if (reverse) {
      const p = parseMarkdown(input);
      return { grid: p.grid, detected: p.aligns, firstRowHeader: true };
    }
    return { grid: parseDelimited(input, resolveDelimiter(delim, input)), detected: [] as Align[], firstRowHeader: header };
  }, [input, delim, header, reverse]);

  const cols = colCount(grid);
  // keep the per-column alignment list sized to the grid; seed from detected aligns.
  useEffect(() => {
    setAligns((prev) => Array.from({ length: cols }, (_, i) => detected[i] ?? prev[i] ?? 0));
  }, [cols, detected]);

  const output = useMemo(() => {
    try {
      return outFmt === 'markdown' ? renderMarkdown(grid, aligns, firstRowHeader, pad) : renderDelimited(grid, outFmt === 'csv' ? ',' : '\t');
    } catch (e) {
      return String(e instanceof Error ? e.message : e);
    }
  }, [grid, aligns, firstRowHeader, pad, outFmt]);

  const headerNames = firstRowHeader && grid[0] ? grid[0] : Array.from({ length: cols }, (_, i) => 'Column ' + (i + 1));
  const setAlign = (i: number, v: Align) => setAligns(aligns.map((a, j) => (j === i ? v : a)));
  const copy = () => {
    if (!output.trim()) return setNote(t('mdtable.nothing'));
    void navigator.clipboard?.writeText(output);
    setNote(t('mdtable.copied'));
  };
  const rowsN = firstRowHeader ? Math.max(0, grid.length - 1) : grid.length;

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <select className="mod-search" style={{ maxWidth: 170 }} value={delim} onChange={(e) => setDelim(e.target.value)} disabled={reverse}>
          <option value="auto">{t('mdtable.autoDetect')}</option>
          <option value="comma">{t('mdtable.comma')}</option>
          <option value="tab">{t('mdtable.tab')}</option>
          <option value="pipe">{t('mdtable.pipe')}</option>
        </select>
        <label className="count-note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={header} disabled={reverse} onChange={(e) => setHeader(e.target.checked)} /> {t('mdtable.firstHeader')}
        </label>
        <label className="count-note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={pad} onChange={(e) => setPad(e.target.checked)} /> {t('mdtable.pad')}
        </label>
      </div>
      {reverse && <p className="count-note">↩ {t('mdtable.reverseHint')}</p>}

      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('mdtable.inputPlaceholder')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('mdtable.outputPlaceholder')} style={{ fontFamily: 'var(--mono, monospace)' }} />
      </div>

      {cols > 0 && (
        <div style={{ marginTop: 10 }}>
          <p className="count-note">{t('mdtable.alignment')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            {headerNames.slice(0, cols).map((name, i) => (
              <label key={i} className="count-note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {name || `#${i + 1}`}:
                <select className="mod-search" style={{ maxWidth: 110 }} value={aligns[i] ?? 0} onChange={(e) => setAlign(i, Number(e.target.value) as Align)}>
                  <option value={0}>{t('mdtable.alignDefault')}</option>
                  <option value={1}>{t('mdtable.alignLeft')}</option>
                  <option value={2}>{t('mdtable.alignCenter')}</option>
                  <option value={3}>{t('mdtable.alignRight')}</option>
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <select className="mod-search" style={{ maxWidth: 140 }} value={outFmt} onChange={(e) => setOutFmt(e.target.value)}>
          <option value="markdown">{t('mdtable.fmtMarkdown')}</option>
          <option value="csv">{t('mdtable.fmtCsv')}</option>
          <option value="tsv">{t('mdtable.fmtTsv')}</option>
        </select>
        <button className="mini" onClick={copy}>
          {t('mdtable.copy')}
        </button>
        <span className="count-note">{t('mdtable.counts', { rows: rowsN, cols })}</span>
      </div>
      {note && <p className="count-note" style={{ marginTop: 6 }}>{note}</p>}
    </div>
  );
}
