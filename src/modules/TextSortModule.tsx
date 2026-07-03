import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TextSortService (line sort & dedupe engine).
type SortMode = 'none' | 'asc' | 'desc' | 'natural';

function splitLines(text: string): string[] {
  if (!text) return [];
  const list: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n' || c === '\r') {
      list.push(text.slice(start, i));
      if (c === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start <= text.length) list.push(text.slice(start));
  if (list.length > 0 && list[list.length - 1]!.length === 0) list.pop();
  return list;
}

function cmp(a: string, b: string, ci: boolean): number {
  const x = ci ? a.toUpperCase() : a;
  const y = ci ? b.toUpperCase() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function naturalCompare(a: string, b: string, ci: boolean): number {
  let ia = 0, ib = 0;
  while (ia < a.length && ib < b.length) {
    const ca = a[ia]!, cb = b[ib]!;
    const da = ca >= '0' && ca <= '9', db = cb >= '0' && cb <= '9';
    if (da && db) {
      const sa0 = ia, sb0 = ib;
      while (ia < a.length && a[ia] === '0') ia++;
      while (ib < b.length && b[ib] === '0') ib++;
      let na = ia, nb = ib;
      while (na < a.length && a[na]! >= '0' && a[na]! <= '9') na++;
      while (nb < b.length && b[nb]! >= '0' && b[nb]! <= '9') nb++;
      const lenA = na - ia, lenB = nb - ib;
      if (lenA !== lenB) return lenA - lenB;
      for (let k = 0; k < lenA; k++) {
        const d = a.charCodeAt(ia + k) - b.charCodeAt(ib + k);
        if (d !== 0) return d;
      }
      const zerosA = ia - sa0, zerosB = ib - sb0;
      if (zerosA !== zerosB) return zerosA - zerosB;
      ia = na; ib = nb;
    } else {
      const xa = ci ? ca.toUpperCase() : ca;
      const xb = ci ? cb.toUpperCase() : cb;
      if (xa !== xb) return xa.charCodeAt(0) - xb.charCodeAt(0);
      ia++; ib++;
    }
  }
  return (a.length - ia) - (b.length - ib);
}

interface Opts {
  sort: SortMode; ci: boolean; dedupe: boolean; trimCompare: boolean;
  reverse: boolean; shuffle: boolean; removeBlank: boolean; trimEach: boolean;
}

function transform(input: string, o: Opts): { text: string; linesIn: number; linesOut: number; dups: number } {
  let lines = splitLines(input);
  const linesIn = lines.length;
  if (o.trimEach) lines = lines.map((l) => l.trim());
  if (o.removeBlank) lines = lines.filter((l) => l.trim().length > 0);
  let dups = 0;
  if (o.dedupe) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const l of lines) {
      const key = (o.trimCompare ? l.trim() : l);
      const cmpKey = o.ci ? key.toUpperCase() : key;
      if (!seen.has(cmpKey)) { seen.add(cmpKey); kept.push(l); }
      else dups++;
    }
    lines = kept;
  }
  if (o.sort === 'asc') lines.sort((a, b) => cmp(a, b, o.ci));
  else if (o.sort === 'desc') lines.sort((a, b) => cmp(b, a, o.ci));
  else if (o.sort === 'natural') lines.sort((a, b) => naturalCompare(a, b, o.ci));
  if (o.reverse) lines.reverse();
  if (o.shuffle) {
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(cryptoRandom() * (i + 1));
      [lines[i], lines[j]] = [lines[j]!, lines[i]!];
    }
  }
  return { text: lines.join('\n'), linesIn, linesOut: lines.length, dups };
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 0x100000000;
}

export function TextSortModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('file10\nfile2\nBanana\napple\napple\nfile1\n\ncherry');
  const [sort, setSort] = useState<SortMode>('asc');
  const [ci, setCi] = useState(false);
  const [dedupe, setDedupe] = useState(false);
  const [trimCompare, setTrimCompare] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [removeBlank, setRemoveBlank] = useState(false);
  const [trimEach, setTrimEach] = useState(false);
  const [nonce, setNonce] = useState(0);

  const opts: Opts = { sort, ci, dedupe, trimCompare, reverse, shuffle, removeBlank, trimEach };
  const r = useMemo(() => transform(input, opts), [input, sort, ci, dedupe, trimCompare, reverse, shuffle, removeBlank, trimEach, nonce]);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note">{t('textsort.mode')}</label>
        <select className="mod-select" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
          <option value="none">{t('textsort.noSort')}</option>
          <option value="asc">{t('textsort.asc')}</option>
          <option value="desc">{t('textsort.desc')}</option>
          <option value="natural">{t('textsort.natural')}</option>
        </select>
        {shuffle && <button className="mini" onClick={() => setNonce((n) => n + 1)}>{t('textsort.reshuffle')}</button>}
        <button className="mini" onClick={() => navigator.clipboard?.writeText(r.text)}>{t('textsort.copy')}</button>
        <button className="mini" onClick={() => setInput('')}>{t('textsort.clear')}</button>
      </div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="chk"><input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} /> {t('textsort.ci')}</label>
        <label className="chk"><input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} /> {t('textsort.dedupe')}</label>
        <label className="chk"><input type="checkbox" checked={trimCompare} onChange={(e) => setTrimCompare(e.target.checked)} /> {t('textsort.trimCompare')}</label>
        <label className="chk"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> {t('textsort.reverse')}</label>
        <label className="chk"><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /> {t('textsort.shuffle')}</label>
        <label className="chk"><input type="checkbox" checked={removeBlank} onChange={(e) => setRemoveBlank(e.target.checked)} /> {t('textsort.removeBlank')}</label>
        <label className="chk"><input type="checkbox" checked={trimEach} onChange={(e) => setTrimEach(e.target.checked)} /> {t('textsort.trimEach')}</label>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('textsort.input')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={r.text} placeholder={t('textsort.output')} />
      </div>
      <p className="count-note" style={{ marginTop: 10 }}>
        {t('textsort.stats', { in: r.linesIn, out: r.linesOut, dups: r.dups })}
      </p>
    </div>
  );
}
