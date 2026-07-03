import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 夾錢分帳 · Expense Splitter — add people, log who paid for what, and get a MINIMAL
// greedy settle-up plan ("X pays Y $Z"). Pure client, no I/O beyond the clipboard.

const EPSILON = 0.005; // half a cent — below this we treat as settled

interface ExpenseRow {
  id: number;
  description: string;
  payer: string | null;
  amount: number;
}

interface PersonBalance {
  name: string;
  paid: number;
  share: number;
  net: number; // paid - share; positive = is owed, negative = owes
}

interface Transfer {
  from: string;
  to: string;
  amount: number;
}

interface SplitResult {
  grandTotal: number;
  fairShare: number;
  peopleCount: number;
  balances: PersonBalance[];
  transfers: Transfer[];
}

const EMPTY_RESULT: SplitResult = { grandTotal: 0, fairShare: 0, peopleCount: 0, balances: [], transfers: [] };

function sanitizeAmount(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

function money(symbol: string, value: number): string {
  const sym = symbol || '$';
  return `${sym}${value.toFixed(2)}`;
}

// Greedy minimal settle-up: repeatedly match the biggest creditor with the biggest debtor.
function settleUp(balances: PersonBalance[]): Transfer[] {
  const result: Transfer[] = [];
  const creditors = balances.filter((b) => b.net > EPSILON).map((b) => ({ name: b.name, amt: b.net }));
  const debtors = balances.filter((b) => b.net < -EPSILON).map((b) => ({ name: b.name, amt: -b.net }));

  const maxIndex = (list: { name: string; amt: number }[]): number => {
    let idx = 0;
    let best = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if (item.amt > best) {
        best = item.amt;
        idx = i;
      }
    }
    return idx;
  };

  let guard = 0;
  const maxIterations = (creditors.length + debtors.length) * 4 + 8;
  while (creditors.length > 0 && debtors.length > 0 && guard++ < maxIterations) {
    const ci = maxIndex(creditors);
    const di = maxIndex(debtors);
    const c = creditors[ci]!;
    const d = debtors[di]!;

    const pay = Math.min(c.amt, d.amt);
    if (pay > EPSILON) {
      result.push({ from: d.name, to: c.name, amount: Math.round(pay * 100) / 100 });
    }

    const newC = c.amt - pay;
    const newD = d.amt - pay;
    if (newC > EPSILON) creditors[ci] = { name: c.name, amt: newC };
    else creditors.splice(ci, 1);
    if (newD > EPSILON) debtors[di] = { name: d.name, amt: newD };
    else debtors.splice(di, 1);
  }
  return result;
}

function compute(people: string[], paidByPerson: Map<string, number>): SplitResult {
  const names = people.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return EMPTY_RESULT;

  let grand = 0;
  const paid = new Map<string, number>();
  for (const n of names) paid.set(n, 0);
  for (const [key, value] of paidByPerson) {
    const amt = sanitizeAmount(value);
    if (paid.has(key)) paid.set(key, paid.get(key)! + amt);
    grand += amt;
  }

  const share = grand / names.length;
  const balances: PersonBalance[] = names.map((n) => {
    const p = paid.get(n)!;
    return { name: n, paid: p, share, net: p - share };
  });

  return {
    grandTotal: grand,
    fairShare: share,
    peopleCount: names.length,
    balances,
    transfers: settleUp(balances),
  };
}

export function ExpenseSplitModule() {
  const { t } = useTranslation();
  const [currency, setCurrency] = useState('$');
  const [people, setPeople] = useState<string[]>([]);
  const [newPerson, setNewPerson] = useState('');
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [nextId, setNextId] = useState(1);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState('');

  const symbol = useMemo(() => currency.trim() || '$', [currency]);

  const result = useMemo<SplitResult>(() => {
    if (people.length === 0) return EMPTY_RESULT;
    const paid = new Map<string, number>();
    for (const ex of expenses) {
      const amt = Number.isNaN(ex.amount) || ex.amount < 0 ? 0 : ex.amount;
      if (amt <= 0) continue;
      if (!ex.payer) continue;
      paid.set(ex.payer, (paid.get(ex.payer) ?? 0) + amt);
    }
    return compute(people, paid);
  }, [people, expenses]);

  // Derive the status line the same way WinForge does.
  const computedStatus = useMemo(() => {
    if (people.length === 0) return t('expensesplit.statusAddPerson');
    let anyAmount = false;
    let missingPayer = false;
    for (const ex of expenses) {
      const amt = Number.isNaN(ex.amount) || ex.amount < 0 ? 0 : ex.amount;
      if (amt <= 0) continue;
      if (!ex.payer) {
        missingPayer = true;
        continue;
      }
      anyAmount = true;
    }
    if (!anyAmount) return t('expensesplit.statusAddExpense');
    if (missingPayer) return t('expensesplit.statusMissingPayer');
    if (result.transfers.length === 0) return t('expensesplit.statusSettled');
    return t('expensesplit.statusTransfers', { n: result.transfers.length });
  }, [people, expenses, result, t]);

  const shownStatus = status || computedStatus;

  const addPerson = () => {
    setCopied('');
    const name = newPerson.trim();
    if (!name) {
      setStatus(t('expensesplit.errTypeName'));
      return;
    }
    if (people.some((p) => p.toLowerCase() === name.toLowerCase())) {
      setStatus(t('expensesplit.errNameExists'));
      return;
    }
    setPeople([...people, name]);
    setNewPerson('');
    setStatus('');
  };

  const removePerson = (name: string) => {
    setCopied('');
    setPeople(people.filter((p) => p !== name));
    // Any expense paid by this person loses its payer.
    setExpenses(expenses.map((ex) => (ex.payer === name ? { ...ex, payer: null } : ex)));
    setStatus('');
  };

  const addExpense = () => {
    setCopied('');
    const row: ExpenseRow = {
      id: nextId,
      description: '',
      payer: people[0] ?? null,
      amount: 0,
    };
    setNextId(nextId + 1);
    setExpenses([...expenses, row]);
    setStatus('');
  };

  const removeExpense = (id: number) => {
    setCopied('');
    setExpenses(expenses.filter((ex) => ex.id !== id));
    setStatus('');
  };

  const updateExpense = (id: number, patch: Partial<ExpenseRow>) => {
    setCopied('');
    setExpenses(expenses.map((ex) => (ex.id === id ? { ...ex, ...patch } : ex)));
    setStatus('');
  };

  const summaryLines = useMemo<string[]>(() => {
    if (people.length === 0) return [];
    const lines: string[] = [];
    lines.push(
      t('expensesplit.summaryHead', {
        people: result.peopleCount,
        total: money(symbol, result.grandTotal),
        share: money(symbol, result.fairShare),
      }),
    );
    lines.push('');
    lines.push(t('expensesplit.balancesLabel'));
    for (const b of result.balances) {
      const tag =
        b.net > EPSILON ? t('expensesplit.isOwed') : b.net < -EPSILON ? t('expensesplit.owes') : t('expensesplit.settled');
      lines.push(
        `  ${b.name}: ${t('expensesplit.paid')} ${money(symbol, b.paid)}, ${tag} ${money(symbol, Math.abs(b.net))}`,
      );
    }
    lines.push('');
    lines.push(t('expensesplit.transfersLabel'));
    if (result.transfers.length === 0) {
      lines.push(`  ${t('expensesplit.nothingToTransfer')}`);
    } else {
      for (const tr of result.transfers) {
        lines.push(`  ${t('expensesplit.transferLine', { from: tr.from, to: tr.to, amount: money(symbol, tr.amount) })}`);
      }
    }
    return lines;
  }, [people, result, symbol, t]);

  const buildPlanText = (): string => {
    const lines: string[] = [];
    lines.push(t('expensesplit.planTitle'));
    lines.push(...summaryLines);
    return lines.join('\n');
  };

  const copyPlan = () => {
    if (people.length === 0) {
      setStatus(t('expensesplit.errNothingCopy'));
      return;
    }
    void navigator.clipboard?.writeText(buildPlanText());
    setStatus('');
    setCopied(t('expensesplit.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('expensesplit.blurb')}
      </p>

      {/* Currency */}
      <div className="mod-toolbar">
        <span className="count-note">{t('expensesplit.currencyLabel')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 80 }}
          maxLength={4}
          value={currency}
          onChange={(e) => {
            setCopied('');
            setCurrency(e.target.value);
          }}
        />
      </div>

      {/* People */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '14px 0 6px' }}>
        {t('expensesplit.peopleTitle')}
      </h3>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder={t('expensesplit.namePlaceholder')}
          value={newPerson}
          onChange={(e) => setNewPerson(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addPerson();
          }}
        />
        <button className="mini primary" onClick={addPerson}>
          {t('expensesplit.addPerson')}
        </button>
      </div>
      {people.length > 0 && (
        <div className="kv-list" style={{ marginTop: 8 }}>
          {people.map((name) => (
            <div className="kv-row" key={name}>
              <span style={{ flex: 1 }}>{name}</span>
              <button className="mini danger" onClick={() => removePerson(name)} aria-label={t('expensesplit.remove')}>
                {t('expensesplit.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Expenses */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '14px 0 6px' }}>
        {t('expensesplit.expensesTitle')}
      </h3>
      <div className="mod-toolbar">
        <button className="mini" onClick={addExpense}>
          {t('expensesplit.addExpense')}
        </button>
      </div>
      {expenses.length > 0 && (
        <div className="dt-wrap" style={{ marginTop: 8 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>{t('expensesplit.colDescription')}</th>
                <th style={{ width: 150 }}>{t('expensesplit.colPayer')}</th>
                <th style={{ width: 130 }}>{t('expensesplit.colAmount')}</th>
                <th style={{ width: 44 }}></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((ex) => (
                <tr key={ex.id}>
                  <td>
                    <input
                      className="mod-search"
                      style={{ width: '100%' }}
                      placeholder={t('expensesplit.descPlaceholder')}
                      value={ex.description}
                      onChange={(e) => updateExpense(ex.id, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="mod-select"
                      style={{ width: '100%' }}
                      value={ex.payer ?? ''}
                      onChange={(e) => updateExpense(ex.id, { payer: e.target.value || null })}
                    >
                      <option value="">{t('expensesplit.pickPayer')}</option>
                      {people.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="mod-search"
                      type="number"
                      min={0}
                      step={1}
                      style={{ width: '100%' }}
                      value={Number.isNaN(ex.amount) ? '' : ex.amount}
                      onChange={(e) => updateExpense(ex.id, { amount: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <button
                      className="mini danger"
                      onClick={() => removeExpense(ex.id)}
                      aria-label={t('expensesplit.remove')}
                    >
                      {t('expensesplit.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary + transfers */}
      <div className="mod-toolbar" style={{ marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0, flex: 1 }}>
          {t('expensesplit.summaryTitle')}
        </h3>
        <button className="mini" onClick={copyPlan}>
          {t('expensesplit.copyPlan')}
        </button>
      </div>
      {(shownStatus || copied) && (
        <p className="count-note" style={{ marginTop: 6 }}>
          {copied || shownStatus}
        </p>
      )}
      {summaryLines.length > 0 && (
        <pre
          className="hosts-edit"
          style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontFamily: 'var(--mono, Consolas, monospace)' }}
        >
          {summaryLines.join('\n')}
        </pre>
      )}
    </div>
  );
}
