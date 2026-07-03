import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge NumSeqService (BigInteger sequence generator).
const MAX_COUNT = 100000;
const clampCount = (n: number) => (n < 0 ? 0 : n > MAX_COUNT ? MAX_COUNT : Math.floor(n));

const arithmetic = (start: bigint, step: bigint, count: number) => {
  const list: bigint[] = []; let v = start;
  for (let i = 0; i < clampCount(count); i++) { list.push(v); v += step; }
  return list;
};
const geometric = (start: bigint, ratio: bigint, count: number) => {
  const list: bigint[] = []; let v = start;
  for (let i = 0; i < clampCount(count); i++) { list.push(v); v *= ratio; }
  return list;
};
const fibonacci = (count: number) => {
  const list: bigint[] = []; let a = 0n, b = 1n;
  for (let i = 0; i < clampCount(count); i++) { list.push(a); [a, b] = [b, a + b]; }
  return list;
};
function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  const lim = Math.floor(Math.sqrt(n)) + 1;
  for (let i = 3; i <= lim; i += 2) if (n % i === 0) return false;
  return true;
}
const primesFirst = (count: number) => {
  const list: bigint[] = []; const c = clampCount(count);
  let cand = 2;
  while (list.length < c) { if (isPrime(cand)) list.push(BigInt(cand)); cand++; }
  return list;
};
const primesUpTo = (limit: number) => {
  const list: bigint[] = [];
  if (limit < 2) return list;
  for (let n = 2; n <= limit; n++) { if (isPrime(n)) list.push(BigInt(n)); if (list.length >= MAX_COUNT) break; }
  return list;
};
const rangeSeq = (start: bigint, end: bigint, step: bigint) => {
  const list: bigint[] = [];
  if (step === 0n) return list;
  if (start <= end && step < 0n) return list;
  if (start > end && step > 0n) return list;
  let v = start;
  while ((step > 0n && v <= end) || (step < 0n && v >= end)) { list.push(v); v += step; if (list.length >= MAX_COUNT) break; }
  return list;
};
const squares = (count: number) => { const l: bigint[] = []; const c = clampCount(count); for (let i = 1; i <= c; i++) l.push(BigInt(i) * BigInt(i)); return l; };
const cubes = (count: number) => { const l: bigint[] = []; const c = clampCount(count); for (let i = 1; i <= c; i++) l.push(BigInt(i) ** 3n); return l; };
const triangular = (count: number) => { const l: bigint[] = []; const c = clampCount(count); let t = 0n; for (let i = 1; i <= c; i++) { t += BigInt(i); l.push(t); } return l; };
const powers = (base: bigint, count: number) => { const l: bigint[] = []; let v = 1n; for (let i = 0; i < clampCount(count); i++) { l.push(v); v *= base; } return l; };

type Mode = 'arithmetic' | 'geometric' | 'fibonacci' | 'primesFirst' | 'primesUpTo' | 'range' | 'squares' | 'cubes' | 'triangular' | 'powers';
const parseBig = (s: string): bigint => { try { return BigInt(s.trim() || '0'); } catch { return 0n; } };

export function NumSeqModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('fibonacci');
  const [start, setStart] = useState('1');
  const [step, setStep] = useState('2');
  const [count, setCount] = useState(15);
  const [end, setEnd] = useState('50');
  const [base, setBase] = useState('2');
  const [sep, setSep] = useState(', ');

  const seq = useMemo(() => {
    const cnt = Math.min(count, mode === 'geometric' || mode === 'powers' ? 200 : MAX_COUNT); // guard huge BigInt growth
    switch (mode) {
      case 'arithmetic': return arithmetic(parseBig(start), parseBig(step), cnt);
      case 'geometric': return geometric(parseBig(start), parseBig(step), cnt);
      case 'fibonacci': return fibonacci(cnt);
      case 'primesFirst': return primesFirst(cnt);
      case 'primesUpTo': return primesUpTo(Number(parseBig(end)));
      case 'range': return rangeSeq(parseBig(start), parseBig(end), parseBig(step));
      case 'squares': return squares(cnt);
      case 'cubes': return cubes(cnt);
      case 'triangular': return triangular(cnt);
      case 'powers': return powers(parseBig(base), cnt);
    }
  }, [mode, start, step, count, end, base]);

  const sepChar = sep === '\\n' ? '\n' : sep;
  const output = seq.map((n) => n.toString()).join(sepChar);
  const needStart = ['arithmetic', 'geometric', 'range'].includes(mode);
  const needStep = ['arithmetic', 'geometric', 'range'].includes(mode);
  const needCount = !['primesUpTo', 'range'].includes(mode);
  const needEnd = ['range', 'primesUpTo'].includes(mode);
  const needBase = mode === 'powers';

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('numseq.mode')}</label>
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="arithmetic">{t('numseq.arithmetic')}</option>
          <option value="geometric">{t('numseq.geometric')}</option>
          <option value="fibonacci">{t('numseq.fibonacci')}</option>
          <option value="primesFirst">{t('numseq.primesFirst')}</option>
          <option value="primesUpTo">{t('numseq.primesUpTo')}</option>
          <option value="range">{t('numseq.range')}</option>
          <option value="squares">{t('numseq.squares')}</option>
          <option value="cubes">{t('numseq.cubes')}</option>
          <option value="triangular">{t('numseq.triangular')}</option>
          <option value="powers">{t('numseq.powers')}</option>
        </select>
      </div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {needStart && <><label className="count-note">{t('numseq.start')}</label><input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 90 }} value={start} onChange={(e) => setStart(e.target.value)} /></>}
        {needStep && <><label className="count-note">{mode === 'geometric' ? t('numseq.ratio') : t('numseq.step')}</label><input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 90 }} value={step} onChange={(e) => setStep(e.target.value)} /></>}
        {needBase && <><label className="count-note">{t('numseq.base')}</label><input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 90 }} value={base} onChange={(e) => setBase(e.target.value)} /></>}
        {needEnd && <><label className="count-note">{mode === 'primesUpTo' ? t('numseq.limit') : t('numseq.end')}</label><input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 90 }} value={end} onChange={(e) => setEnd(e.target.value)} /></>}
        {needCount && <><label className="count-note">{t('numseq.count')}</label><input className="mod-search" type="number" min={0} style={{ maxWidth: 90 }} value={count} onChange={(e) => setCount(Math.max(0, +e.target.value || 0))} /></>}
        <label className="count-note">{t('numseq.separator')}</label>
        <select className="mod-select" value={sep} onChange={(e) => setSep(e.target.value)}>
          <option value=", ">, </option><option value=" "> (space)</option><option value="\n">newline</option><option value=",">,</option><option value="; ">; </option>
        </select>
        <button className="mini" disabled={!output} onClick={() => navigator.clipboard?.writeText(output)}>{t('numseq.copy')}</button>
      </div>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('numseq.output')} style={{ minHeight: 200, fontFamily: 'monospace' }} />
      <p className="count-note" style={{ marginTop: 8 }}>{t('numseq.terms', { n: seq.length })}</p>
    </div>
  );
}
