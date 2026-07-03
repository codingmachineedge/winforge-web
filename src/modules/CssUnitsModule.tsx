import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Ported from WinForge CssUnitsService.cs — pure managed maths, never throws.
// Absolute units resolve against the CSS 96-DPI reference; relative units
// (em/rem/%/vw/vh) resolve against the supplied context.

const UNITS = ['px', 'em', 'rem', 'pt', 'pc', '%', 'vw', 'vh', 'cm', 'mm', 'in'] as const;
type Unit = (typeof UNITS)[number];

const PX_PER_IN = 96.0;
const PX_PER_PT = PX_PER_IN / 72.0; // 1pt = 1/72 in
const PX_PER_PC = PX_PER_PT * 12.0; // 1pc = 12 pt
const PX_PER_CM = PX_PER_IN / 2.54; // 2.54 cm = 1 in
const PX_PER_MM = PX_PER_CM / 10.0; // 10 mm = 1 cm

interface Context {
  rootFontPx: number; // for rem
  elementFontPx: number; // for em
  viewportWidthPx: number; // for vw
  viewportHeightPx: number; // for vh
  containerPx: number; // for %
}

interface ResultRow {
  unit: Unit;
  value: string; // formatted, or "—"
  combined: string; // e.g. "12.5rem" — copied on click, "" when meaningless
}

const safe = (px: number, denom: number): number =>
  denom > 0 && !Number.isNaN(denom) ? px / denom : NaN;

function fromPx(px: number, toUnit: Unit, ctx: Context): number {
  if (Number.isNaN(px) || !Number.isFinite(px)) return NaN;
  switch (toUnit) {
    case 'px':
      return px;
    case 'in':
      return px / PX_PER_IN;
    case 'pt':
      return px / PX_PER_PT;
    case 'pc':
      return px / PX_PER_PC;
    case 'cm':
      return px / PX_PER_CM;
    case 'mm':
      return px / PX_PER_MM;
    case 'em':
      return safe(px, ctx.elementFontPx);
    case 'rem':
      return safe(px, ctx.rootFontPx);
    case '%':
      return safe(px, ctx.containerPx) * 100.0;
    case 'vw':
      return safe(px, ctx.viewportWidthPx) * 100.0;
    case 'vh':
      return safe(px, ctx.viewportHeightPx) * 100.0;
    default:
      return NaN;
  }
}

function toPx(value: number, fromUnit: Unit, ctx: Context): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return NaN;
  switch (fromUnit) {
    case 'px':
      return value;
    case 'in':
      return value * PX_PER_IN;
    case 'pt':
      return value * PX_PER_PT;
    case 'pc':
      return value * PX_PER_PC;
    case 'cm':
      return value * PX_PER_CM;
    case 'mm':
      return value * PX_PER_MM;
    case 'em':
      return value * ctx.elementFontPx;
    case 'rem':
      return value * ctx.rootFontPx;
    case '%':
      return (value / 100.0) * ctx.containerPx;
    case 'vw':
      return (value / 100.0) * ctx.viewportWidthPx;
    case 'vh':
      return (value / 100.0) * ctx.viewportHeightPx;
    default:
      return NaN;
  }
}

// Trim to at most 4 decimals, no trailing zeros (matches C# "0.####" + round away-from-zero).
function format(v: number): string {
  if (Number.isNaN(v) || !Number.isFinite(v)) return '—';
  const factor = 10000;
  const rounded = Math.round(Math.abs(v) * factor) / factor * Math.sign(v || 1);
  // Strip trailing zeros; use a plain fixed representation to avoid exponent notation.
  let s = rounded.toFixed(4);
  s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

// Parse a user string into a number; NaN when blank/invalid (invariant culture float).
function parseValue(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return NaN;
  const v = Number(trimmed);
  return Number.isNaN(v) ? NaN : v;
}

function convertAll(value: number, fromUnit: Unit, ctx: Context): ResultRow[] {
  const list: ResultRow[] = [];
  if (!fromUnit) return list;
  const px = toPx(value, fromUnit, ctx);
  for (const u of UNITS) {
    if (u === fromUnit) continue;
    const converted = fromPx(px, u, ctx);
    const nan = Number.isNaN(converted);
    const shown = format(converted);
    list.push({
      unit: u,
      value: nan ? '—' : shown,
      combined: nan ? '' : shown + u,
    });
  }
  return list;
}

function ctxVal(raw: string, fallback: number): number {
  const v = Number(raw);
  return Number.isNaN(v) || !Number.isFinite(v) ? fallback : v;
}

export function CssUnitsModule() {
  const { t } = useTranslation();
  const [valueText, setValueText] = useState('16');
  const [unit, setUnit] = useState<Unit>('px');
  const [root, setRoot] = useState('16');
  const [elem, setElem] = useState('16');
  const [vw, setVw] = useState('1920');
  const [vh, setVh] = useState('1080');
  const [container, setContainer] = useState('1000');
  const [hint, setHint] = useState<string>(t('cssunits.copyHint'));

  const results = useMemo(() => {
    const ctx: Context = {
      rootFontPx: ctxVal(root, 16),
      elementFontPx: ctxVal(elem, 16),
      viewportWidthPx: ctxVal(vw, 1920),
      viewportHeightPx: ctxVal(vh, 1080),
      containerPx: ctxVal(container, 1000),
    };
    return convertAll(parseValue(valueText), unit, ctx);
  }, [valueText, unit, root, elem, vw, vh, container]);

  const copyRow = (r: ResultRow) => {
    if (!r.combined) return;
    void navigator.clipboard?.writeText(r.combined);
    setHint(t('cssunits.copied', { value: r.combined }));
  };

  const ctxFields: { label: string; value: string; set: (v: string) => void; step: number }[] = [
    { label: t('cssunits.rootLabel'), value: root, set: setRoot, step: 1 },
    { label: t('cssunits.elemLabel'), value: elem, set: setElem, step: 1 },
    { label: t('cssunits.vwLabel'), value: vw, set: setVw, step: 10 },
    { label: t('cssunits.vhLabel'), value: vh, set: setVh, step: 10 },
    { label: t('cssunits.containerLabel'), value: container, set: setContainer, step: 10 },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('cssunits.blurb')}
      </p>

      {/* Value to convert */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 8px' }}>
        {t('cssunits.inputTitle')}
      </h3>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={valueText}
          onChange={(e) => setValueText(e.target.value)}
          placeholder="16"
        />
        <select className="mod-select" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>

      {/* Context */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '18px 0 4px' }}>
        {t('cssunits.contextTitle')}
      </h3>
      <p className="count-note" style={{ marginTop: 0, marginBottom: 8 }}>
        {t('cssunits.contextBlurb')}
      </p>
      <div className="kv-list">
        {ctxFields.map((f) => (
          <label key={f.label} className="kv-row">
            <span style={{ flex: 1, fontSize: 12.5 }}>{f.label}</span>
            <input
              className="mod-search"
              type="number"
              min={0}
              step={f.step}
              style={{ maxWidth: 160, flex: 'none' }}
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
            />
          </label>
        ))}
      </div>

      {/* Results */}
      <div className="mod-toolbar" style={{ marginTop: 18 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0, flex: 1 }}>
          {t('cssunits.resultsTitle')}
        </h3>
        <span className="count-note">{hint}</span>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cssunits.clickRow')}
      </p>
      <div className="dt-wrap" style={{ maxHeight: 420 }}>
        <table className="dt">
          <tbody>
            {results.map((r) => (
              <tr
                key={r.unit}
                style={{ cursor: r.combined ? 'pointer' : 'default' }}
                onClick={() => copyRow(r)}
              >
                <td style={{ width: 80, fontWeight: 600 }}>{r.unit}</td>
                <td style={{ textAlign: 'right', fontFamily: 'Consolas, ui-monospace, monospace' }}>
                  {r.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
