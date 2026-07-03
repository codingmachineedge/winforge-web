// 類比錶盤 · Reusable radial SVG dial gauge.
//
// A 240° analog sweep (from -210° to +30°, i.e. 7 o'clock → 5 o'clock) with an optional warn/danger
// arc band, tick marks, a value needle and a formatted numeric readout. Pure SVG + design tokens;
// the needle animates via a CSS transform transition (killed automatically under
// prefers-reduced-motion by the global reset). Nothing here is engine-specific — callers pass a
// scalar `value` in [min,max] plus an already-formatted `valueText`.

export interface AnalogGaugeProps {
  value: number;
  min: number;
  max: number;
  label: string;
  /** Already locale-formatted value string (caller owns formatting). */
  valueText: string;
  unit?: string;
  /** Optional secondary caption under the readout. */
  sub?: string;
  /** Start of the amber warning band, in value units (arc drawn from warn→danger or warn→max). */
  warn?: number;
  /** Start of the red danger band, in value units (arc drawn from danger→max). */
  danger?: number;
  /** Emphasize as one of the primary control-room instruments. */
  primary?: boolean;
}

const START_ANGLE = -210; // degrees (SVG: 0° = +x axis, CW positive). Sweep start (lower-left).
const SWEEP = 240; // total sweep in degrees
const R = 78; // arc radius
const CX = 100;
const CY = 100;

/** Map a value to its angle on the dial (deg), clamped to the sweep. */
function angleFor(value: number, min: number, max: number): number {
  const span = max - min;
  const frac = span > 0 ? (value - min) / span : 0;
  const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return START_ANGLE + clamped * SWEEP;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG arc path between two values on the dial. */
function arcPath(from: number, to: number, min: number, max: number, r: number): string {
  const a0 = angleFor(from, min, max);
  const a1 = angleFor(to, min, max);
  const [x0, y0] = polar(CX, CY, r, a0);
  const [x1, y1] = polar(CX, CY, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function AnalogGauge({
  value,
  min,
  max,
  label,
  valueText,
  unit,
  sub,
  warn,
  danger,
  primary,
}: AnalogGaugeProps) {
  const needleAngle = angleFor(Number.isFinite(value) ? value : min, min, max);

  // Tick marks every 1/8 of the sweep.
  const ticks = Array.from({ length: 9 }, (_, i) => {
    const a = START_ANGLE + (i / 8) * SWEEP;
    const [xo, yo] = polar(CX, CY, R, a);
    const [xi, yi] = polar(CX, CY, R - 8, a);
    return { xo, yo, xi, yi, key: i };
  });

  const warnStart = warn !== undefined ? Math.max(min, Math.min(warn, max)) : undefined;
  const dangerStart = danger !== undefined ? Math.max(min, Math.min(danger, max)) : undefined;
  // amber band runs from warn to (danger or max); red band from danger to max.
  const warnEnd = dangerStart ?? max;

  return (
    <div className={`agauge${primary ? ' agauge-primary' : ''}`}>
      <div className="agauge-label">{label}</div>
      <svg className="agauge-svg" viewBox="0 0 200 170" role="img" aria-label={`${label}: ${valueText}${unit ? ' ' + unit : ''}`}>
        {/* base track */}
        <path className="agauge-track" d={arcPath(min, max, min, max, R)} fill="none" />
        {/* warn band */}
        {warnStart !== undefined && warnStart < warnEnd && (
          <path className="agauge-band-warn" d={arcPath(warnStart, warnEnd, min, max, R)} fill="none" />
        )}
        {/* danger band */}
        {dangerStart !== undefined && dangerStart < max && (
          <path className="agauge-band-danger" d={arcPath(dangerStart, max, min, max, R)} fill="none" />
        )}
        {/* ticks */}
        {ticks.map((t) => (
          <line key={t.key} className="agauge-tick" x1={t.xo} y1={t.yo} x2={t.xi} y2={t.yi} />
        ))}
        {/* needle — rotated via CSS transform so the sweep transitions smoothly */}
        <g
          className="agauge-needle"
          style={{ transform: `rotate(${needleAngle.toFixed(2)}deg)`, transformOrigin: `${CX}px ${CY}px` }}
        >
          <line x1={CX} y1={CY} x2={CX + R - 14} y2={CY} />
        </g>
        <circle className="agauge-hub" cx={CX} cy={CY} r={6} />
      </svg>
      <div className="agauge-readout">
        <span className="agauge-value">{valueText}</span>
        {unit && <span className="agauge-unit"> {unit}</span>}
      </div>
      {sub && <div className="agauge-sub">{sub}</div>}
    </div>
  );
}
