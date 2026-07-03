import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TextColumnsService.
type Delim = 'tab' | 'comma' | 'pipe' | 'semicolon' | 'whitespace';
const sepChar = (d: Delim) => ({ tab: '\t', comma: ',', pipe: '|', semicolon: ';', whitespace: ' ' }[d]);
const joinSep = (d: Delim) => (d === 'whitespace' ? ' ' : sepChar(d));

type Grid = string[][];

function pad(rows: Grid): Grid {
  let width = 0;
  for (const r of rows) width = Math.max(width, r.length);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}
function parseGrid(input: string, d: Delim): Grid {
  if (!input) return [];
  const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let rows: Grid = lines.map((line) =>
    d === 'whitespace' ? line.split(/\s+/).filter((x) => x.length > 0) : line.split(sepChar(d)),
  );
  if (rows.length > 1 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') rows.pop();
  return pad(rows);
}
const width = (rows: Grid) => (rows.length === 0 ? 0 : rows[0]!.length);
function render(rows: Grid, outDelim: Delim): string {
  const sep = joinSep(outDelim);
  return rows.map((r) => r.join(sep)).join('\n');
}
function parseIndexSpec(spec: string, w: number): { indices: number[]; bad: string | null } {
  const indices: number[] = [];
  if (!spec.trim()) return { indices, bad: '' };
  for (const raw of spec.split(/[, ]+/).filter((x) => x.length > 0)) {
    const token = raw.trim();
    if (token.includes('-')) {
      const parts = token.split('-');
      const a = Number(parts[0]?.trim()), b = Number(parts[1]?.trim());
      if (parts.length !== 2 || !Number.isInteger(a) || !Number.isInteger(b)) return { indices: [], bad: token };
      if (a < 1 || b < 1 || a > w || b > w) return { indices: [], bad: token };
      if (a <= b) for (let i = a; i <= b; i++) indices.push(i - 1);
      else for (let i = a; i >= b; i--) indices.push(i - 1);
    } else {
      const n = Number(token);
      if (!Number.isInteger(n)) return { indices: [], bad: token };
      if (n < 1 || n > w) return { indices: [], bad: token };
      indices.push(n - 1);
    }
  }
  return indices.length > 0 ? { indices, bad: null } : { indices, bad: '' };
}
const extractCols = (rows: Grid, cols: number[]): Grid => rows.map((r) => cols.map((c) => (c >= 0 && c < r.length ? r[c]! : '')));
function deleteCols(rows: Grid, cols: number[]): Grid {
  const drop = new Set(cols);
  const keep: number[] = [];
  for (let c = 0; c < width(rows); c++) if (!drop.has(c)) keep.push(c);
  return extractCols(rows, keep);
}
function align(rows: Grid): Grid {
  const w = width(rows);
  const maxes = new Array<number>(w).fill(0);
  for (const r of rows) for (let c = 0; c < w; c++) maxes[c] = Math.max(maxes[c]!, (r[c] ?? '').length);
  return rows.map((r) => Array.from({ length: w }, (_, c) => (r[c] ?? '').padEnd(maxes[c]!)));
}
function transpose(rows: Grid): Grid {
  const w = width(rows);
  const out: Grid = [];
  for (let c = 0; c < w; c++) out.push(rows.map((r) => r[c] ?? ''));
  return out;
}
const trimCells = (rows: Grid): Grid => rows.map((r) => r.map((c) => (c ?? '').trim()));

export function TextColumnsModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('name,age,city\nAlice,30,London\nBob,25,Paris\nCarol,35,Tokyo');
  const [inDelim, setInDelim] = useState<Delim>('comma');
  const [outDelim, setOutDelim] = useState<Delim>('comma');
  const [spec, setSpec] = useState('1,3');
  const [output, setOutput] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const grid = useMemo(() => parseGrid(input, inDelim), [input, inDelim]);

  const runSpec = (op: (rows: Grid, cols: number[]) => Grid) => {
    const { indices, bad } = parseIndexSpec(spec, width(grid));
    if (bad !== null) { setErr(bad === '' ? t('textcol.needSpec') : t('textcol.badSpec', { token: bad })); return; }
    setErr(null);
    setOutput(render(op(grid, indices), outDelim));
  };
  const runPlain = (op: (rows: Grid) => Grid) => { setErr(null); setOutput(render(op(grid), outDelim)); };

  const DelimSelect = ({ value, onChange }: { value: Delim; onChange: (d: Delim) => void }) => (
    <select className="mod-select" value={value} onChange={(e) => onChange(e.target.value as Delim)}>
      <option value="tab">{t('textcol.tab')}</option>
      <option value="comma">{t('textcol.comma')}</option>
      <option value="pipe">{t('textcol.pipe')}</option>
      <option value="semicolon">{t('textcol.semicolon')}</option>
      <option value="whitespace">{t('textcol.whitespace')}</option>
    </select>
  );

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textcol.inDelim')}</label>
        <DelimSelect value={inDelim} onChange={setInDelim} />
        <label className="count-note">{t('textcol.outDelim')}</label>
        <DelimSelect value={outDelim} onChange={setOutDelim} />
        <span className="count-note">{t('textcol.detected', { n: width(grid) })}</span>
      </div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textcol.spec')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 130 }} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="1,3,5-7" />
        <button className="mini primary" onClick={() => runSpec(extractCols)}>{t('textcol.extract')}</button>
        <button className="mini" onClick={() => runSpec(deleteCols)}>{t('textcol.delete')}</button>
        <button className="mini" onClick={() => runSpec(extractCols)}>{t('textcol.reorder')}</button>
        <button className="mini" onClick={() => runPlain(align)}>{t('textcol.align')}</button>
        <button className="mini" onClick={() => runPlain(transpose)}>{t('textcol.transpose')}</button>
        <button className="mini" onClick={() => runPlain(trimCells)}>{t('textcol.trim')}</button>
        <button className="mini" disabled={!output} onClick={() => navigator.clipboard?.writeText(output)}>{t('textcol.copy')}</button>
      </div>
      {err && <p className="count-note" style={{ color: 'var(--danger)' }}>{err}</p>}
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('textcol.input')} style={{ fontFamily: 'monospace' }} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('textcol.output')} style={{ fontFamily: 'monospace' }} />
      </div>
    </div>
  );
}
