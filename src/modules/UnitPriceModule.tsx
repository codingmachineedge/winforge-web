import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge UnitPriceService (price-per-unit comparison).
const clean = (v: number) => (Number.isNaN(v) || !Number.isFinite(v) ? 0 : v);

interface Item { label: string; price: string; quantity: string; unit: string }
interface Computed { valid: boolean; perUnit: number; isBest: boolean; percentMore: number }

function computeAll(rows: { price: number; quantity: number }[]): Computed[] {
  const results: Computed[] = [];
  let best = Infinity;
  for (const { price, quantity } of rows) {
    const p = clean(price), q = clean(quantity);
    if (q > 0 && p >= 0) {
      const perUnit = p / q;
      if (perUnit < best) best = perUnit;
      results.push({ valid: true, perUnit, isBest: false, percentMore: 0 });
    } else {
      results.push({ valid: false, perUnit: NaN, isBest: false, percentMore: NaN });
    }
  }
  if (Number.isFinite(best) && best > 0) {
    for (const c of results) {
      if (!c.valid) continue;
      c.isBest = c.perUnit <= best * (1 + 1e-9);
      c.percentMore = c.isBest ? 0 : ((c.perUnit - best) / best) * 100;
    }
  } else if (Number.isFinite(best)) {
    for (const c of results) {
      if (!c.valid) continue;
      c.isBest = c.perUnit <= 1e-12;
      c.percentMore = c.isBest ? 0 : Infinity;
    }
  }
  return results;
}

function formatPerUnit(currency: string, perUnit: number, unit: string): string {
  if (Number.isNaN(perUnit) || !Number.isFinite(perUnit)) return '—';
  const u = unit.trim() ? '/' + unit.trim() : '';
  return currency + perUnit.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 4 }) + u;
}
function formatPercentMore(isBest: boolean, pm: number): string {
  if (isBest || Number.isNaN(pm)) return '';
  if (!Number.isFinite(pm)) return '∞';
  return '+' + pm.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
}

export function UnitPriceModule() {
  const { t } = useTranslation();
  const [currency, setCurrency] = useState('$');
  const [items, setItems] = useState<Item[]>([
    { label: 'Big box', price: '5.99', quantity: '500', unit: 'g' },
    { label: 'Small box', price: '2.49', quantity: '180', unit: 'g' },
    { label: 'Bulk', price: '12.00', quantity: '1200', unit: 'g' },
  ]);

  const computed = useMemo(() => computeAll(items.map((i) => ({ price: Number(i.price), quantity: Number(i.quantity) }))), [items]);

  const update = (i: number, key: keyof Item, val: string) => setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, [key]: val } : it)));
  const add = () => setItems((arr) => [...arr, { label: '', price: '', quantity: '', unit: arr[0]?.unit ?? '' }]);
  const remove = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note">{t('unitprice.currency')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 70 }} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <button className="mini primary" onClick={add}>{t('unitprice.add')}</button>
      </div>
      <div className="dt-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>{t('unitprice.label')}</th><th>{t('unitprice.price')}</th><th>{t('unitprice.qty')}</th>
              <th>{t('unitprice.unit')}</th><th>{t('unitprice.perUnit')}</th><th>{t('unitprice.vsBest')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const c = computed[i]!;
              return (
                <tr key={i} style={c.isBest ? { background: 'color-mix(in srgb, var(--ok, #3fb950) 12%, transparent)' } : undefined}>
                  <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 130 }} value={it.label} onChange={(e) => update(i, 'label', e.target.value)} /></td>
                  <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 80 }} value={it.price} onChange={(e) => update(i, 'price', e.target.value)} /></td>
                  <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 80 }} value={it.quantity} onChange={(e) => update(i, 'quantity', e.target.value)} /></td>
                  <td><input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 60 }} value={it.unit} onChange={(e) => update(i, 'unit', e.target.value)} /></td>
                  <td style={{ fontFamily: 'monospace' }}>{formatPerUnit(currency, c.perUnit, it.unit)}{c.isBest ? ' ★' : ''}</td>
                  <td style={{ color: c.isBest ? 'var(--ok, #3fb950)' : 'var(--text-tertiary)' }}>{c.isBest ? t('unitprice.best') : formatPercentMore(c.isBest, c.percentMore)}</td>
                  <td><button className="mini" onClick={() => remove(i)}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
