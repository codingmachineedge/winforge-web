import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge SciNotationService.
const SI: [number, string, string][] = [
  [30, 'Q', 'quetta'], [27, 'R', 'ronna'], [24, 'Y', 'yotta'], [21, 'Z', 'zetta'],
  [18, 'E', 'exa'], [15, 'P', 'peta'], [12, 'T', 'tera'], [9, 'G', 'giga'],
  [6, 'M', 'mega'], [3, 'k', 'kilo'], [0, '', ''],
  [-3, 'm', 'milli'], [-6, 'µ', 'micro'], [-9, 'n', 'nano'], [-12, 'p', 'pico'],
  [-15, 'f', 'femto'], [-18, 'a', 'atto'], [-21, 'z', 'zepto'], [-24, 'y', 'yocto'],
  [-27, 'r', 'ronto'], [-30, 'q', 'quecto'],
];

function tryParse(raw: string): number | null {
  if (!raw || !raw.trim()) return null;
  let s = raw.trim().replace(/[−–]/g, '-').replace(/,/g, '').replace(/[  ]/g, '');
  const mulIdx = [...s].findIndex((c) => c === '×' || c === 'x' || c === 'X' || c === '*' || c === '·');
  if (mulIdx >= 0) {
    let left = s.slice(0, mulIdx);
    let right = s.slice(mulIdx + 1);
    if (right.startsWith('10^')) right = right.slice(3);
    else if (right.startsWith('10')) right = right.slice(2);
    else return null;
    if (left.length === 0) left = '1';
    const mant = Number(left), exp = Number(right);
    if (!Number.isFinite(mant) || !Number.isInteger(exp)) return null;
    const v = mant * Math.pow(10, exp);
    return Number.isFinite(v) ? v : null;
  }
  const v = Number(s);
  return Number.isFinite(v) && s !== '' ? v : null;
}

function roundToSignificant(v: number, sig: number): number {
  if (v === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(v)));
  const magnitude = Math.pow(10, sig - d);
  const scaled = v * magnitude;
  // MidpointRounding.AwayFromZero (Math.round rounds .5 toward +∞, so mirror for negatives).
  const away = (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / magnitude;
  return Number.isFinite(away) ? away : v;
}

function decompose(v: number): { m: number; e: number } {
  if (v === 0) return { m: 0, e: 0 };
  let e = Math.floor(Math.log10(Math.abs(v)));
  let m = v / Math.pow(10, e);
  if (Math.abs(m) >= 10) { m /= 10; e++; }
  else if (Math.abs(m) < 1) { m *= 10; e--; }
  return { m, e };
}
function trimMantissa(m: number, sig: number): string {
  const decimals = Math.max(0, sig - 1);
  let s = m.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
function formatStandard(v: number): string {
  if (v === 0) return '0';
  return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 15 });
}
function formatScientific(v: number, sig: number, sep: string): string {
  if (v === 0) return sep === 'E' ? '0E+0' : '0×10^0';
  const { m, e } = decompose(v);
  const mant = trimMantissa(m, sig);
  if (sep === 'E') return mant + 'E' + (e >= 0 ? '+' : '') + e;
  return mant + sep + e;
}
function formatEngineering(v: number, sig: number): { text: string; engExp: number } {
  if (v === 0) return { text: '0×10^0', engExp: 0 };
  const { m, e } = decompose(v);
  const rem = ((e % 3) + 3) % 3;
  const engExp = e - rem;
  const engMant = m * Math.pow(10, rem);
  const mant = trimMantissa(engMant, Math.max(sig, sig + rem));
  return { text: mant + '×10^' + engExp, engExp };
}
function formatSiPrefix(v: number, sig: number): string {
  if (v === 0) return '0';
  const { engExp } = formatEngineering(v, sig);
  const { m, e } = decompose(v);
  const rem = ((e % 3) + 3) % 3;
  const engMant = m * Math.pow(10, rem);
  for (const [exp, sym, name] of SI) {
    if (exp === engExp) {
      const mant = trimMantissa(engMant, Math.max(sig, sig + rem));
      return sym.length === 0 ? mant : `${mant} ${sym} (${name})`;
    }
  }
  return formatEngineering(v, sig).text;
}

export function SciNotationModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('12345.678');
  const [sigFigs, setSigFigs] = useState(4);

  const res = useMemo(() => {
    const sig = Math.max(1, Math.min(15, sigFigs));
    const value = tryParse(input);
    if (value === null || Number.isNaN(value) || !Number.isFinite(value)) return null;
    const rounded = roundToSignificant(value, sig);
    return {
      standard: formatStandard(rounded),
      scientific: formatScientific(rounded, sig, '×10^'),
      engineering: formatEngineering(rounded, sig).text,
      eNotation: formatScientific(rounded, sig, 'E'),
      si: formatSiPrefix(rounded, sig),
    };
  }, [input, sigFigs]);

  const copy = (v: string) => navigator.clipboard?.writeText(v);
  const Row = ({ label, val }: { label: string; val: string }) => (
    <tr><td style={{ width: 150 }}>{label}</td><td style={{ fontFamily: 'monospace' }}>{val}</td>
      <td style={{ width: 50, textAlign: 'right' }}><button className="mini" onClick={() => copy(val)}>{t('sci.copy')}</button></td></tr>
  );

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('sci.value')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 220 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="1.2345e4 · 12345.678 · 1.2×10^4" />
        <label className="count-note">{t('sci.sigFigs')}</label>
        <input className="mod-search" type="number" min={1} max={15} style={{ maxWidth: 70 }} value={sigFigs} onChange={(e) => setSigFigs(+e.target.value)} />
      </div>
      {res ? (
        <div className="panel">
          <table className="dt"><tbody>
            <Row label={t('sci.standard')} val={res.standard} />
            <Row label={t('sci.scientific')} val={res.scientific} />
            <Row label={t('sci.engineering')} val={res.engineering} />
            <Row label={t('sci.eNotation')} val={res.eNotation} />
            <Row label={t('sci.si')} val={res.si} />
          </tbody></table>
        </div>
      ) : (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('sci.badInput')}</p>
      )}
    </div>
  );
}
