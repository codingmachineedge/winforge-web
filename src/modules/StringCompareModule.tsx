import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge StringCompareService (edit-distance / similarity metrics).
const MAX_LEN = 2000;

function normalize(s: string, ignoreCase: boolean, ignoreWs: boolean): string {
  let out = s;
  if (ignoreWs) out = out.replace(/\s/g, '');
  if (ignoreCase) out = out.toLowerCase();
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

function damerau(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i]![0] = i;
  for (let j = 0; j <= lb; j++) d[0]![j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let min = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) min = Math.min(min, d[i - 2]![j - 2]! + 1);
      d[i]![j] = min;
    }
  }
  return d[la]![lb]!;
}

function hamming(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

function jaro(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  if (matchDistance < 0) matchDistance = 0;
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = true; bM[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions) / m) / 3;
}
function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  for (let i = 0; i < max; i++) { if (a[i] === b[i]) prefix++; else break; }
  return j + prefix * 0.1 * (1 - j);
}

function lcSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1]! + 1; if (cur[j]! > best) best = cur[j]!; }
      else cur[j] = 0;
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return best;
}
function lcSubsequence(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

interface Metrics {
  lenA: number; lenB: number; truncated: boolean; lev: number; sim: number;
  dam: number; ham: number; jw: number; lcSub: number; lcSeq: number;
}
function compute(a: string, b: string, ignoreCase: boolean, ignoreWs: boolean): Metrics {
  const sa = normalize(a, ignoreCase, ignoreWs);
  const sb = normalize(b, ignoreCase, ignoreWs);
  const truncated = sa.length > MAX_LEN || sb.length > MAX_LEN;
  let lev = -1, dam = -1, lcSub = -1, lcSeq = -1, sim = NaN;
  if (!truncated) {
    lev = levenshtein(sa, sb);
    const maxLen = Math.max(sa.length, sb.length);
    sim = maxLen === 0 ? 100 : (1 - lev / maxLen) * 100;
    dam = damerau(sa, sb);
    lcSub = lcSubstring(sa, sb);
    lcSeq = lcSubsequence(sa, sb);
  }
  const ham = sa.length === sb.length ? hamming(sa, sb) : -1;
  const jw = jaroWinkler(sa, sb);
  return { lenA: sa.length, lenB: sb.length, truncated, lev, sim, dam, ham, jw, lcSub, lcSeq };
}

export function StringCompareModule() {
  const { t } = useTranslation();
  const [a, setA] = useState('kitten');
  const [b, setB] = useState('sitting');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const m = useMemo(() => compute(a, b, ignoreCase, ignoreWs), [a, b, ignoreCase, ignoreWs]);

  const na = (v: number) => (v < 0 ? '—' : String(v));
  return (
    <div className="mod">
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={a} onChange={(e) => setA(e.target.value)} placeholder={t('strcmp.stringA')} style={{ minHeight: 90 }} />
        <textarea className="hosts-edit" spellCheck={false} value={b} onChange={(e) => setB(e.target.value)} placeholder={t('strcmp.stringB')} style={{ minHeight: 90 }} />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <label className="chk"><input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> {t('strcmp.ignoreCase')}</label>
        <label className="chk"><input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} /> {t('strcmp.ignoreWs')}</label>
      </div>
      <div className="panel">
        <table className="dt">
          <tbody>
            <tr><td>{t('strcmp.lengths')}</td><td>{m.lenA} · {m.lenB}</td></tr>
            <tr><td>{t('strcmp.levenshtein')}</td><td>{na(m.lev)}</td></tr>
            <tr><td>{t('strcmp.similarity')}</td><td>{Number.isNaN(m.sim) ? '—' : m.sim.toFixed(1) + '%'}</td></tr>
            <tr><td>{t('strcmp.damerau')}</td><td>{na(m.dam)}</td></tr>
            <tr><td>{t('strcmp.hamming')}</td><td>{m.ham < 0 ? t('strcmp.na') : m.ham}</td></tr>
            <tr><td>{t('strcmp.jaroWinkler')}</td><td>{Number.isNaN(m.jw) ? '—' : m.jw.toFixed(4)}</td></tr>
            <tr><td>{t('strcmp.lcSubstring')}</td><td>{na(m.lcSub)}</td></tr>
            <tr><td>{t('strcmp.lcSubsequence')}</td><td>{na(m.lcSeq)}</td></tr>
          </tbody>
        </table>
        {m.truncated && <p className="count-note" style={{ marginTop: 8 }}>{t('strcmp.truncated', { max: MAX_LEN })}</p>}
      </div>
    </div>
  );
}
