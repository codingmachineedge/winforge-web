import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function LoanCalcModule() {
  const { t } = useTranslation();
  const [principal, setPrincipal] = useState('250000');
  const [rate, setRate] = useState('5.5');
  const [term, setTerm] = useState('30');
  const [unit, setUnit] = useState<'years' | 'months'>('years');

  const calc = useMemo(() => {
    const P = parseFloat(principal);
    const annual = parseFloat(rate);
    const tv = parseFloat(term);
    if (!Number.isFinite(P) || !Number.isFinite(annual) || !Number.isFinite(tv) || P <= 0 || tv <= 0) return null;
    const n = Math.round(unit === 'years' ? tv * 12 : tv);
    if (n <= 0) return null;
    const r = annual / 12 / 100;
    const payment = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    const totalPaid = payment * n;
    const schedule: { i: number; principal: number; interest: number; balance: number }[] = [];
    let balance = P;
    for (let i = 1; i <= n; i++) {
      const interest = balance * r;
      const principalPart = Math.min(payment - interest, balance);
      balance = Math.max(0, balance - principalPart);
      schedule.push({ i, principal: principalPart, interest, balance });
    }
    return { payment, totalPaid, totalInterest: totalPaid - P, n, schedule };
  }, [principal, rate, term, unit]);

  const copy = () => {
    if (!calc) return;
    void navigator.clipboard?.writeText(
      `${t('loan.monthly')}: ${money(calc.payment)}\n${t('loan.totalPaid')}: ${money(calc.totalPaid)}\n${t('loan.totalInterest')}: ${money(calc.totalInterest)}`,
    );
  };

  return (
    <div className="mod">
      <div className="mod-form" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="lc-field">
          <span>{t('loan.principal')}</span>
          <input className="mod-search" type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
        </label>
        <label className="lc-field">
          <span>{t('loan.rate')}</span>
          <input className="mod-search" type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className="lc-field">
          <span>{t('loan.term')}</span>
          <input className="mod-search" type="number" value={term} onChange={(e) => setTerm(e.target.value)} style={{ maxWidth: 100 }} />
        </label>
        <select className="mod-select" value={unit} onChange={(e) => setUnit(e.target.value as 'years' | 'months')}>
          <option value="years">{t('loan.years')}</option>
          <option value="months">{t('loan.months')}</option>
        </select>
      </div>

      {!calc ? (
        <p className="count-note">{t('loan.enter')}</p>
      ) : (
        <>
          <div className="gauges" style={{ marginTop: 12 }}>
            <div className="gauge">
              <div className="label">{t('loan.monthly')}</div>
              <div className="value">{money(calc.payment)}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('loan.totalPaid')}</div>
              <div className="value">{money(calc.totalPaid)}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('loan.totalInterest')}</div>
              <div className="value">{money(calc.totalInterest)}</div>
            </div>
          </div>
          <div className="mod-toolbar" style={{ marginTop: 12 }}>
            <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
              {t('loan.schedule')} ({calc.n})
            </h3>
            <button className="mini" onClick={copy}>
              {t('loan.copy')}
            </button>
          </div>
          <div className="dt-wrap" style={{ maxHeight: 360 }}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th style={{ textAlign: 'right' }}>{t('loan.principalCol')}</th>
                  <th style={{ textAlign: 'right' }}>{t('loan.interestCol')}</th>
                  <th style={{ textAlign: 'right' }}>{t('loan.balanceCol')}</th>
                </tr>
              </thead>
              <tbody>
                {calc.schedule.map((row) => (
                  <tr key={row.i}>
                    <td>{row.i}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.principal)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.interest)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
