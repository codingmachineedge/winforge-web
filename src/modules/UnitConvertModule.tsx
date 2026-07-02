import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Factor to the category's base unit (except temperature, handled specially).
const CATS: Record<string, Record<string, number>> = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523, st: 6.35029318 },
  data: { B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824, bit: 0.125 },
  speed: { 'm/s': 1, 'km/h': 0.2777778, mph: 0.44704, knot: 0.5144444, 'ft/s': 0.3048 },
  area: { 'm²': 1, 'km²': 1e6, 'cm²': 1e-4, ha: 10000, acre: 4046.8564, 'ft²': 0.09290304, 'mi²': 2589988.11 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800 },
  volume: { L: 1, mL: 0.001, 'm³': 1000, 'gal(US)': 3.7854118, qt: 0.94635295, cup: 0.23658824, floz: 0.02957353 },
  pressure: { Pa: 1, kPa: 1000, bar: 1e5, atm: 101325, psi: 6894.757, mmHg: 133.32237 },
};
const TEMP = ['°C', '°F', 'K'];

function toC(v: number, u: string): number {
  return u === '°C' ? v : u === '°F' ? ((v - 32) * 5) / 9 : v - 273.15;
}
function fromC(c: number, u: string): number {
  return u === '°C' ? c : u === '°F' ? (c * 9) / 5 + 32 : c + 273.15;
}
const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '—';
  const s = n.toPrecision(10);
  return parseFloat(s).toString();
};

export function UnitConvertModule() {
  const { t } = useTranslation();
  const cats = [...Object.keys(CATS), 'temperature'];
  const [cat, setCat] = useState('length');
  const units = cat === 'temperature' ? TEMP : Object.keys(CATS[cat]!);
  const [from, setFrom] = useState('m');
  const [to, setTo] = useState('ft');
  const [value, setValue] = useState('1');

  const changeCat = (c: string) => {
    setCat(c);
    const u = c === 'temperature' ? TEMP : Object.keys(CATS[c]!);
    setFrom(u[0]!);
    setTo(u[1] ?? u[0]!);
  };

  const result = useMemo(() => {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return null;
    if (cat === 'temperature') return fromC(toC(v, from), to);
    return (v * CATS[cat]![from]!) / CATS[cat]![to]!;
  }, [value, cat, from, to]);

  const one = useMemo(() => {
    if (cat === 'temperature') return null;
    return CATS[cat]![from]! / CATS[cat]![to]!;
  }, [cat, from, to]);

  const copy = () => result != null && void navigator.clipboard?.writeText(fmt(result));

  const unitSel = (val: string, set: (v: string) => void) => (
    <select className="mod-select" value={val} onChange={(e) => set(e.target.value)}>
      {units.map((u) => (
        <option key={u}>{u}</option>
      ))}
    </select>
  );

  return (
    <div className="mod">
      <div className="mod-form">
        <span className="count-note">{t('unit.category')}</span>
        <select className="mod-select" value={cat} onChange={(e) => changeCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c} value={c}>
              {t(`unit.cat_${c}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="uc-row">
        <input className="mod-search" type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 160 }} />
        {unitSel(from, setFrom)}
        <span className="uc-eq">=</span>
        <input className="mod-search rx-pattern" readOnly value={result == null ? '' : fmt(result)} style={{ maxWidth: 200 }} placeholder={t('unit.enter')} />
        {unitSel(to, setTo)}
        <button className="mini" onClick={copy}>
          {t('unit.copy')}
        </button>
      </div>
      {one != null && (
        <p className="count-note" style={{ marginTop: 8 }}>
          1 {from} = {fmt(one)} {to} · 1 {to} = {fmt(1 / one)} {from}
        </p>
      )}

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('unit.reference')}
      </h3>
      <table className="dt ct-table">
        <tbody>
          {units.map((u) => (
            <tr key={u}>
              <td style={{ width: 100, color: 'var(--text-tertiary)' }}>{u}</td>
              <td>
                <code>
                  {value || '1'} {from} = {result == null ? '—' : cat === 'temperature' ? fmt(fromC(toC(parseFloat(value) || 0, from), u)) : fmt(((parseFloat(value) || 0) * CATS[cat]![from]!) / CATS[cat]![u]!)} {u}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
