import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge NumberFormatService using Intl.NumberFormat.
const CURRENCIES: { culture: string; currency: string; display: string }[] = [
  { culture: 'en-US', currency: 'USD', display: 'en-US · $ USD' },
  { culture: 'de-DE', currency: 'EUR', display: 'de-DE · € EUR' },
  { culture: 'en-GB', currency: 'GBP', display: 'en-GB · £ GBP' },
  { culture: 'ja-JP', currency: 'JPY', display: 'ja-JP · ¥ JPY' },
  { culture: 'zh-HK', currency: 'HKD', display: 'zh-HK · HK$ HKD' },
  { culture: 'zh-CN', currency: 'CNY', display: 'zh-CN · ¥ CNY' },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const safe = (f: () => string) => { try { return f() || '—'; } catch { return '—'; } };

function parseNum(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const cleaned = t.replace(/,/g, '').replace(/^\+/, '');
  if (!/^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

// .NET "E{d}" — uppercase E, sign, 3-digit exponent, e.g. 1.234500E+003.
function scientific(value: number, decimals: number): string {
  const s = value.toExponential(decimals); // "1.2345e+3"
  return s.replace(/e([+-])(\d+)/i, (_m, sign, exp) => `E${sign}${exp.padStart(3, '0')}`);
}
function accounting(value: number, decimals: number): string {
  const body = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return value < 0 ? `(${body})` : body;
}
function zeroPad(value: number, width: number): string {
  const neg = value < 0 || Object.is(value, -0);
  const mag = Math.abs(value);
  const whole = Math.trunc(mag).toString();
  const frac = mag - Math.trunc(mag);
  let tail = '';
  if (frac > 0) {
    const f = mag.toString();
    const dot = f.indexOf('.');
    if (dot >= 0) tail = f.slice(dot);
  }
  const padded = whole.padStart(Math.max(width, whole.length), '0');
  return (neg ? '-' : '') + padded + tail;
}

export function NumberFormatModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('-1234567.891');
  const [decimals, setDecimals] = useState(2);
  const [culture, setCulture] = useState('en-US');
  const [padWidth, setPadWidth] = useState(8);
  const [copied, setCopied] = useState('');

  const parsed = parseNum(input);
  const d = clamp(decimals, 0, 10);
  const pw = clamp(padWidth, 0, 40);
  const cur = CURRENCIES.find((c) => c.culture === culture) ?? CURRENCIES[0]!;

  const items = useMemo(() => {
    if (parsed === null) return [];
    const v = parsed;
    return [
      { label: t('numfmt.grouped'), value: safe(() => v.toLocaleString('en-US', { maximumFractionDigits: 3 })) },
      { label: t('numfmt.fixed'), value: safe(() => v.toFixed(d)) },
      { label: t('numfmt.currency'), value: safe(() => v.toLocaleString(cur.culture, { style: 'currency', currency: cur.currency })) },
      { label: t('numfmt.percent'), value: safe(() => (v).toLocaleString('en-US', { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d })) },
      { label: t('numfmt.scientific'), value: safe(() => scientific(v, d)) },
      { label: t('numfmt.accounting'), value: safe(() => accounting(v, d)) },
      { label: t('numfmt.padded'), value: safe(() => zeroPad(v, pw)) },
    ];
  }, [parsed, d, cur, pw, t]);

  const copy = (v: string) => { navigator.clipboard?.writeText(v); setCopied(v); setTimeout(() => setCopied(''), 1000); };

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('numfmt.value')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 200 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="1234.56" />
        <label className="count-note">{t('numfmt.decimals')}</label>
        <input className="mod-search" type="number" min={0} max={10} style={{ maxWidth: 70 }} value={decimals} onChange={(e) => setDecimals(+e.target.value)} />
        <label className="count-note">{t('numfmt.pad')}</label>
        <input className="mod-search" type="number" min={0} max={40} style={{ maxWidth: 70 }} value={padWidth} onChange={(e) => setPadWidth(+e.target.value)} />
        <label className="count-note">{t('numfmt.currencyCulture')}</label>
        <select className="mod-select" value={culture} onChange={(e) => setCulture(e.target.value)}>
          {CURRENCIES.map((c) => <option key={c.culture} value={c.culture}>{c.display}</option>)}
        </select>
      </div>
      {parsed === null ? (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('numfmt.badNumber')}</p>
      ) : (
        <div className="panel">
          <table className="dt">
            <tbody>
              {items.map((it) => (
                <tr key={it.label}>
                  <td style={{ width: 160 }}>{it.label}</td>
                  <td style={{ fontFamily: 'monospace' }}>{it.value}</td>
                  <td style={{ width: 60, textAlign: 'right' }}>
                    <button className="mini" onClick={() => copy(it.value)}>{copied === it.value ? '✓' : t('numfmt.copy')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
