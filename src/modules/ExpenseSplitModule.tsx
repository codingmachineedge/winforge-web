import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge ExpenseSplitService — given people and per-person paid totals,
// compute paid / fair-share / net balance, then a MINIMAL greedy settle-up transfer
// list (biggest creditor pays biggest debtor). Pure; never throws.
const EPSILON = 0.005; // half a cent — below this we treat as settled

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

interface ExpenseRow {
  id: number;
  description: string;
  payer: string; // '' = none picked
  amount: number;
}

function sanitizeAmount(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

function maxIndex(list: { name: string; amt: number }[]): number {
  let idx = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]!;
    if (cur.amt > best) {
      best = cur.amt;
      idx = i;
    }
  }
  return idx;
}

function roundAway(v: number): number {
  // Math.round is half-up for positives, which matches AwayFromZero for the
  // non-negative transfer amounts we produce here.
  return Math.round(v * 100) / 100;
}

function settleUp(balances: PersonBalance[]): Transfer[] {
  const result: Transfer[] = [];
  const creditors = balances
    .filter((b) => b.net > EPSILON)
    .map((b) => ({ name: b.name, amt: b.net }));
  const debtors = balances
    .filter((b) => b.net < -EPSILON)
    .map((b) => ({ name: b.name, amt: -b.net }));

  let guard = 0;
  const maxIterations = (creditors.length + debtors.length) * 4 + 8;
  while (creditors.length > 0 && debtors.length > 0 && guard++ < maxIterations) {
    const ci = maxIndex(creditors);
    const di = maxIndex(debtors);
    const c = creditors[ci]!;
    const d = debtors[di]!;

    const pay = Math.min(c.amt, d.amt);
    if (pay > EPSILON) {
      result.push({ from: d.name, to: c.name, amount: roundAway(pay) });
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
  const empty: SplitResult = {
    grandTotal: 0,
    fairShare: 0,
    peopleCount: 0,
    balances: [],
    transfers: [],
  };

  const names = people
    .filter((n) => n.trim().length > 0)
    .map((n) => n.trim());
  if (names.length === 0) return empty;

  let grand = 0;
  const paid = new Map<string, number>();
  for (const n of names) paid.set(n, 0);
  paidByPerson.forEach((value, key) => {
    const k = key.trim();
    const amt = sanitizeAmount(value);
    if (paid.has(k)) paid.set(k, (paid.get(k) ?? 0) + amt);
    grand += amt;
  });

  const share = grand / names.length;

  const balances: PersonBalance[] = names.map((n) => {
    const p = paid.get(n) ?? 0;
    return { name: n, paid: p, share, net: p - share };
  });

  const transfers = settleUp(balances);

  return {
    grandTotal: grand,
    fairShare: share,
    peopleCount: names.length,
    balances,
    transfers,
  };
}

function money(symbol: string, value: number): string {
  const sym = symbol || '$';
  return `${sym}${value.toFixed(2)}`;
}

export function ExpenseSplitModule() {
  const { t, i18n } = useTranslation();
  const P = (en: string, zh: string) => pick(en, zh, i18n.language);

  const [symbol, setSymbol] = useState('$');
  const [people, setPeople] = useState<string[]>([]);
  const [newPerson, setNewPerson] = useState('');
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [nextId, setNextId] = useState(1);
  const [copied, setCopied] = useState(false);

  const sym = symbol.trim() || '$';

  const addPerson = () => {
    const name = newPerson.trim();
    if (!name) return;
    if (people.some((p) => p.toLowerCase() === name.toLowerCase())) return;
    setPeople([...people, name]);
    setNewPerson('');
  };

  const removePerson = (name: string) => {
    setPeople(people.filter((p) => p !== name));
    // Any expense that was paid by this person loses its payer.
    setExpenses(expenses.map((ex) => (ex.payer === name ? { ...ex, payer: '' } : ex)));
  };

  const addExpense = () => {
    const first = people[0] ?? '';
    setExpenses([...expenses, { id: nextId, description: '', payer: first, amount: 0 }]);
    setNextId(nextId + 1);
  };

  const removeExpense = (id: number) => {
    setExpenses(expenses.filter((ex) => ex.id !== id));
  };

  const updateExpense = (id: number, patch: Partial<ExpenseRow>) => {
    setExpenses(expenses.map((ex) => (ex.id === id ? { ...ex, ...patch } : ex)));
  };

  // Aggregate what each person paid, and note validation states, mirroring Recompute().
  const { result, anyAmount, missingPayer } = useMemo(() => {
    const paid = new Map<string, number>();
    let any = false;
    let missing = false;
    for (const ex of expenses) {
      const amt = Number.isNaN(ex.amount) || ex.amount < 0 ? 0 : ex.amount;
      if (amt <= 0) continue;
      if (!ex.payer) {
        missing = true;
        continue;
      }
      any = true;
      paid.set(ex.payer, (paid.get(ex.payer) ?? 0) + amt);
    }
    const res = compute(people, paid);
    return { result: res, anyAmount: any, missingPayer: missing };
  }, [people, expenses]);

  const statusMsg = (): string => {
    if (people.length === 0) return P('Add at least one person to begin.', '先加最少一個人開始。');
    if (!anyAmount)
      return P('Add an expense with a payer and amount to see the split.', '加一項有付款人同金額嘅支出就會計數。');
    if (missingPayer) return P('Some expenses have no payer — pick one for each.', '有啲支出未揀付款人 — 逐項揀返。');
    if (result.transfers.length === 0) return P('All settled — no transfers needed.', '全部找清，唔使轉帳。');
    return t('expensesplit.transferCount', { count: result.transfers.length });
  };

  const netTag = (net: number): string =>
    net > EPSILON ? P('is owed', '應收') : net < -EPSILON ? P('owes', '應付') : P('settled', '已平');

  const buildPlanText = (): string => {
    const lines: string[] = [];
    lines.push(P('Expense Splitter — settle-up plan', '夾錢分帳 — 找數方案'));
    lines.push(
      P(
        `People: ${result.peopleCount}   Total: ${money(sym, result.grandTotal)}   Fair share: ${money(sym, result.fairShare)}`,
        `人數：${result.peopleCount}   總數：${money(sym, result.grandTotal)}   人均：${money(sym, result.fairShare)}`,
      ),
    );
    lines.push('');
    lines.push(P('Balances:', '結餘：'));
    for (const b of result.balances) {
      lines.push(
        `  ${b.name}: ${P('paid', '已付')} ${money(sym, b.paid)}, ${netTag(b.net)} ${money(sym, Math.abs(b.net))}`,
      );
    }
    lines.push('');
    lines.push(P('Transfers:', '轉帳：'));
    if (result.transfers.length === 0) {
      lines.push(P('  Everyone is settled — nothing to transfer.', '  大家已經找清，唔使轉帳。'));
    } else {
      for (const tr of result.transfers) {
        lines.push(
          '  ' + P(`${tr.from} pays ${tr.to} ${money(sym, tr.amount)}`, `${tr.from} 俾 ${tr.to} ${money(sym, tr.amount)}`),
        );
      }
    }
    return lines.join('\n');
  };

  const copyPlan = () => {
    if (people.length === 0) return;
    navigator.clipboard?.writeText(buildPlanText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const section = { marginTop: 18 } as const;
  const h3 = { margin: '0 0 10px', fontSize: 14 } as const;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginBottom: 8 }}>{t('expensesplit.blurb')}</p>

      <div className="mod-toolbar" style={{ alignItems: 'center' }}>
        <span className="count-note">{t('expensesplit.currency')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 80 }}
          maxLength={4}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        />
      </div>

      <section style={section}>
        <h3 style={h3}>{t('expensesplit.people')}</h3>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ minWidth: 200 }}
            placeholder={t('expensesplit.namePlaceholder')}
            value={newPerson}
            onChange={(e) => setNewPerson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPerson();
            }}
          />
          <button className="mini primary" onClick={addPerson}>{t('expensesplit.addPerson')}</button>
        </div>
        {people.length > 0 && (
          <ul className="kv-list" style={{ marginTop: 10, listStyle: 'none', padding: 0 }}>
            {people.map((name) => (
              <li key={name} className="kv-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{name}</span>
                <button className="mini" onClick={() => removePerson(name)}>{t('expensesplit.remove')}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={section}>
        <h3 style={h3}>{t('expensesplit.expenses')}</h3>
        <button className="mini" onClick={addExpense} disabled={people.length === 0}>
          {t('expensesplit.addExpense')}
        </button>
        {expenses.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {expenses.map((ex) => (
              <div key={ex.id} className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="mod-search"
                  style={{ minWidth: 140, flex: 1 }}
                  placeholder={t('expensesplit.descPlaceholder')}
                  value={ex.description}
                  onChange={(e) => updateExpense(ex.id, { description: e.target.value })}
                />
                <select
                  className="mod-select"
                  value={ex.payer}
                  onChange={(e) => updateExpense(ex.id, { payer: e.target.value })}
                >
                  <option value="">{t('expensesplit.pickPayer')}</option>
                  {people.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <input
                  className="mod-search"
                  type="number"
                  min={0}
                  step="0.01"
                  style={{ maxWidth: 120 }}
                  value={ex.amount}
                  onChange={(e) => updateExpense(ex.id, { amount: Math.max(0, +e.target.value || 0) })}
                />
                <button className="mini" onClick={() => removeExpense(ex.id)}>{t('expensesplit.remove')}</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 style={{ ...h3, margin: 0, flex: 1 }}>{t('expensesplit.summary')}</h3>
          <button className="mini" onClick={copyPlan} disabled={people.length === 0}>
            {copied ? t('expensesplit.copied') : t('expensesplit.copyPlan')}
          </button>
        </div>
        <p className="count-note" style={{ marginTop: 8 }}>{statusMsg()}</p>

        {people.length > 0 && anyAmount && (
          <>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>{t('expensesplit.peopleCount')}</dt><dd>{result.peopleCount}</dd>
              <dt>{t('expensesplit.total')}</dt><dd>{money(sym, result.grandTotal)}</dd>
              <dt>{t('expensesplit.fairShare')}</dt><dd>{money(sym, result.fairShare)}</dd>
            </dl>

            <h3 style={{ ...h3, marginTop: 16 }}>{t('expensesplit.balances')}</h3>
            <dl className="kv">
              {result.balances.map((b) => (
                <span key={b.name} style={{ display: 'contents' }}>
                  <dt>{b.name}</dt>
                  <dd>
                    {P('paid', '已付')} {money(sym, b.paid)}, {netTag(b.net)} {money(sym, Math.abs(b.net))}
                  </dd>
                </span>
              ))}
            </dl>

            <h3 style={{ ...h3, marginTop: 16 }}>{t('expensesplit.transfers')}</h3>
            {result.transfers.length === 0 ? (
              <p className="count-note">{t('expensesplit.nothingToTransfer')}</p>
            ) : (
              <ul className="kv-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {result.transfers.map((tr, idx) => (
                  <li key={idx} className="kv-row" style={{ fontFamily: 'monospace' }}>
                    {P(
                      `${tr.from} pays ${tr.to} ${money(sym, tr.amount)}`,
                      `${tr.from} 俾 ${tr.to} ${money(sym, tr.amount)}`,
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
