import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

function parseDuration(s: string): number | null {
  s = s.trim();
  if (!s) return null;
  const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (colon) {
    const a = +colon[1]!;
    const b = +colon[2]!;
    if (colon[3] !== undefined) return a * 3600 + b * 60 + +colon[3]!; // H:M:S
    return a * 60 + b; // M:S
  }
  const unitRe = /(\d+\.?\d*)\s*(d|h|m|s)/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(s))) {
    matched = true;
    const v = parseFloat(m[1]!);
    const u = m[2]!.toLowerCase();
    total += u === 'd' ? v * 86400 : u === 'h' ? v * 3600 : u === 'm' ? v * 60 : v;
  }
  if (matched && s.replace(/(\d+\.?\d*)\s*(d|h|m|s)/gi, '').trim() === '') return total;
  if (/^\d+\.?\d*$/.test(s)) return parseFloat(s);
  return null;
}

function fmtClock(sec: number): string {
  const neg = sec < 0;
  let x = Math.abs(sec);
  const d = Math.floor(x / 86400);
  x -= d * 86400;
  const h = Math.floor(x / 3600);
  x -= h * 3600;
  const mn = Math.floor(x / 60);
  const s = Math.round(x - mn * 60);
  const hms = `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return (neg ? '-' : '') + (d ? `${d}d ` : '') + hms;
}
const round = (n: number) => Math.round(n * 1000) / 1000;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel" style={{ padding: 14 }}>
      <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}
function ResultLine({ sec }: { sec: number | null }) {
  const { t } = useTranslation();
  if (sec == null) return <p className="count-note">{t('duration.enter')}</p>;
  return (
    <p className="count-note" style={{ marginTop: 6 }}>
      <code className="dur-result">{fmtClock(sec)}</code> · {round(sec / 3600)} h · {round(sec / 60)} m · {round(sec)} s
      <button className="mini" style={{ marginLeft: 8 }} onClick={() => navigator.clipboard?.writeText(fmtClock(sec))}>
        {t('duration.copy')}
      </button>
    </p>
  );
}

export function DurationCalcModule() {
  const { t } = useTranslation();
  const [a, setA] = useState('1:30:00');
  const [op, setOp] = useState<'+' | '-'>('+');
  const [b, setB] = useState('45m');
  const [list, setList] = useState('1:30:00\n90m\n2.5h');
  const [conv, setConv] = useState('2.5h');
  const [scaleIn, setScaleIn] = useState('1h30m');
  const [scaleOp, setScaleOp] = useState<'×' | '÷'>('×');
  const [factor, setFactor] = useState('3');

  const pa = parseDuration(a);
  const pb = parseDuration(b);
  const addSub = pa != null && pb != null ? (op === '+' ? pa + pb : pa - pb) : null;

  const sumSec = (() => {
    const vals = list.split(/\r?\n/).map(parseDuration).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
  })();

  const convSec = parseDuration(conv);

  const scaleSec = (() => {
    const base = parseDuration(scaleIn);
    const f = parseFloat(factor);
    if (base == null || !Number.isFinite(f)) return null;
    if (scaleOp === '÷' && f === 0) return NaN;
    return scaleOp === '×' ? base * f : base / f;
  })();

  const durInput = (val: string, set: (v: string) => void) => (
    <input className="mod-search" style={{ maxWidth: 160 }} value={val} onChange={(e) => set(e.target.value)} placeholder="1:30:00 / 90m / 2.5h" />
  );

  return (
    <div className="mod" style={{ display: 'grid', gap: 12 }}>
      <Card title={t('duration.addSub')}>
        <div className="uc-row">
          {durInput(a, setA)}
          <select className="mod-select" value={op} onChange={(e) => setOp(e.target.value as '+' | '-')}>
            <option value="+">+</option>
            <option value="-">−</option>
          </select>
          {durInput(b, setB)}
        </div>
        <ResultLine sec={addSub} />
      </Card>

      <Card title={t('duration.sum')}>
        <textarea className="hosts-edit" spellCheck={false} style={{ minHeight: 90 }} value={list} onChange={(e) => setList(e.target.value)} />
        <ResultLine sec={sumSec} />
      </Card>

      <Card title={t('duration.convert')}>
        <div className="uc-row">{durInput(conv, setConv)}</div>
        <ResultLine sec={convSec} />
      </Card>

      <Card title={t('duration.scale')}>
        <div className="uc-row">
          {durInput(scaleIn, setScaleIn)}
          <select className="mod-select" value={scaleOp} onChange={(e) => setScaleOp(e.target.value as '×' | '÷')}>
            <option value="×">×</option>
            <option value="÷">÷</option>
          </select>
          <input className="mod-search" type="number" style={{ maxWidth: 90 }} value={factor} onChange={(e) => setFactor(e.target.value)} />
        </div>
        {Number.isNaN(scaleSec) ? <p className="count-note" style={{ color: 'var(--danger)' }}>{t('duration.divZero')}</p> : <ResultLine sec={scaleSec} />}
      </Card>
    </div>
  );
}
