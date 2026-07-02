import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const num = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n: number) => (Math.round(n * 10000) / 10000).toLocaleString();

function Card({ title, children, result }: { title: string; children: ReactNode; result: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="panel" style={{ padding: 14 }}>
      <h3 className="group-title" style={{ fontSize: 13.5, marginTop: 0 }}>
        {title}
      </h3>
      <div className="uc-row">{children}</div>
      <p className="count-note" style={{ marginTop: 8 }}>
        {result != null && result !== '' ? (
          <>
            <span className="dur-result">{result}</span>
            {typeof result === 'string' && (
              <button className="mini" style={{ marginLeft: 8 }} onClick={() => navigator.clipboard?.writeText(result)}>
                {t('percent.copy')}
              </button>
            )}
          </>
        ) : (
          '—'
        )}
      </p>
    </div>
  );
}

const inp = (v: string, set: (s: string) => void, ph: string) => (
  <input className="mod-search" type="number" style={{ maxWidth: 110 }} value={v} onChange={(e) => set(e.target.value)} placeholder={ph} />
);

export function PercentCalcModule() {
  const { t } = useTranslation();
  const [x1, setX1] = useState('15');
  const [y1, setY1] = useState('200');
  const [x2, setX2] = useState('30');
  const [y2, setY2] = useState('150');
  const [a3, setA3] = useState('80');
  const [b3, setB3] = useState('100');
  const [y4, setY4] = useState('250');
  const [x4, setX4] = useState('10');
  const [dir4, setDir4] = useState<'inc' | 'dec'>('inc');
  const [bill, setBill] = useState('100');
  const [tip, setTip] = useState('15');
  const [people, setPeople] = useState('4');
  const [ra, setRa] = useState('1920');
  const [rb, setRb] = useState('1080');

  const r1 = num(x1) != null && num(y1) != null ? `${fmt((num(x1)! / 100) * num(y1)!)}` : '';
  const r2 = num(x2) != null && num(y2) != null && num(y2) !== 0 ? `${fmt((num(x2)! / num(y2)!) * 100)}%` : '';
  const r3 = num(a3) != null && num(b3) != null && num(a3) !== 0 ? `${fmt(((num(b3)! - num(a3)!) / num(a3)!) * 100)}%` : '';
  const r4 = num(y4) != null && num(x4) != null ? `${fmt(num(y4)! * (1 + (dir4 === 'inc' ? 1 : -1) * (num(x4)! / 100)))}` : '';
  const tipResult = (() => {
    const bl = num(bill);
    const tp = num(tip);
    const pp = num(people);
    if (bl == null || tp == null || pp == null || pp < 1) return '';
    const tipAmt = (bl * tp) / 100;
    const total = bl + tipAmt;
    return `${t('percent.total')} ${fmt(total)} · ${t('percent.tip')} ${fmt(tipAmt)} · ${t('percent.each')} ${fmt(total / pp)}`;
  })();
  const ratioResult = (() => {
    const av = num(ra);
    const bv = num(rb);
    if (av == null || bv == null || av === 0 || bv === 0) return '';
    const g = gcd(Math.round(av), Math.round(bv));
    return `${Math.round(av) / g} : ${Math.round(bv) / g}`;
  })();

  return (
    <div className="mod pc-grid">
      <Card title={t('percent.ofY')} result={r1}>
        {inp(x1, setX1, 'X')}
        <span className="uc-eq">% of</span>
        {inp(y1, setY1, 'Y')}
      </Card>
      <Card title={t('percent.whatPct')} result={r2}>
        {inp(x2, setX2, 'X')}
        <span className="uc-eq">of</span>
        {inp(y2, setY2, 'Y')}
      </Card>
      <Card title={t('percent.change')} result={r3}>
        {inp(a3, setA3, 'A')}
        <span className="uc-eq">→</span>
        {inp(b3, setB3, 'B')}
      </Card>
      <Card title={t('percent.incDec')} result={r4}>
        {inp(y4, setY4, 'Y')}
        <select className="mod-select" value={dir4} onChange={(e) => setDir4(e.target.value as 'inc' | 'dec')}>
          <option value="inc">{t('percent.increase')}</option>
          <option value="dec">{t('percent.decrease')}</option>
        </select>
        {inp(x4, setX4, 'X')}
        <span className="uc-eq">%</span>
      </Card>
      <Card title={t('percent.tipSplit')} result={tipResult}>
        {inp(bill, setBill, t('percent.bill'))}
        {inp(tip, setTip, t('percent.tipPct'))}
        {inp(people, setPeople, t('percent.people'))}
      </Card>
      <Card title={t('percent.ratio')} result={ratioResult}>
        {inp(ra, setRa, 'a')}
        <span className="uc-eq">:</span>
        {inp(rb, setRb, 'b')}
      </Card>
    </div>
  );
}
