// P/T 限值 · 容器完整性面板 · Appendix-G P/T envelope / LTOP / PTS panel.
//
// The visual centerpiece is an SVG P/T diagram: the 10 CFR 50 App G composite heatup limit as a
// polyline (Tcold on x 0–320 °C, pressure on y 0–18 MPa-abs), the brittle-fracture region shaded
// above it, the LTOP low-setpoint segment below the enable temperature, and the CURRENT
// (Tcold, P) operating point with a short trailing history the panel keeps in a ref. Below it:
// margin readout, heatup/cooldown rate readout with limit lamps, the LTOP ARMED lamp and the
// PTS advisory line. A dumb view over the PtLimitsView snapshot — no engine import except types.

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NumberFmt } from './format';
import type { PtLimitsView } from '../../reactor/ptLimits';
import '../../styles/reactor-ptlim.css';

export interface PtLimitsPanelProps {
  v: PtLimitsView;
  fmt: NumberFmt;
  /** Max points of the operating-point trail kept by the panel (default 60 ≈ one per tick). */
  trailLength?: number;
}

const PAIR = ' · ';
/** Pick the display text for an engine-provided En/Zh pair given the active language. */
function pick(en: string, zh: string, lang: string): string {
  if (lang === 'yue') return zh || en;
  if (lang === 'bilingual') return zh && zh !== en ? `${en}${PAIR}${zh}` : en;
  return en;
}

// ---- diagram geometry (SVG user units) ----
const W = 360;
const H = 236;
const X0 = 40; // plot left   (T = 0 °C)
const X1 = 350; // plot right (T = 320 °C)
const Y0 = 202; // plot bottom (P = 0 MPa)
const Y1 = 12; // plot top    (P = 18 MPa)
const TMAX = 320;
const PMAX = 18;
const px = (tC: number) => X0 + (Math.max(0, Math.min(TMAX, tC)) / TMAX) * (X1 - X0);
const py = (pMPa: number) => Y0 - (Math.max(0, Math.min(PMAX, pMPa)) / PMAX) * (Y0 - Y1);

function Lamp({ on, kind, label }: { on: boolean; kind: 'warn' | 'danger' | 'ok'; label: string }) {
  return (
    <div className={`ptlim-lamp ${kind}${on ? ' on' : ''}`}>
      <span className="ptlim-lamp-dot" />
      <span className="ptlim-lamp-label">{label}</span>
    </div>
  );
}

export function PtLimitsPanel({ v, fmt, trailLength = 60 }: PtLimitsPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  // Operating-point trail, kept in a ref (survives re-renders, no extra state churn). A new point
  // is appended only when the snapshot actually moved, so a paused sim doesn't pile up duplicates.
  const trailRef = useRef<{ t: number; p: number }[]>([]);
  const trail = trailRef.current;
  const last = trail.length > 0 ? trail[trail.length - 1]! : undefined;
  if (!last || Math.abs(last.t - v.tcoldC) > 1e-9 || Math.abs(last.p - v.primaryPressureMPa) > 1e-9) {
    trail.push({ t: v.tcoldC, p: v.primaryPressureMPa });
    if (trail.length > Math.max(2, trailLength)) trail.splice(0, trail.length - Math.max(2, trailLength));
  }

  // App-G curve as plotted points: clamped-flat from T=0 to the first knot, the knots, then the
  // design-ceiling plateau out to the right edge (matches the engine's clamped interpolation).
  const kT = v.curveTempC;
  const kP = v.curvePressMPa;
  const curvePts: string[] = [`${px(0).toFixed(1)},${py(kP[0] ?? 0).toFixed(1)}`];
  for (let i = 0; i < kT.length; i++) curvePts.push(`${px(kT[i] ?? 0).toFixed(1)},${py(kP[i] ?? 0).toFixed(1)}`);
  curvePts.push(`${px(TMAX).toFixed(1)},${py(kP[kP.length - 1] ?? 0).toFixed(1)}`);
  const curve = curvePts.join(' ');
  // Shade the forbidden (brittle-fracture) region above the curve.
  const forbidden = `${curve} ${px(TMAX).toFixed(1)},${py(PMAX).toFixed(1)} ${px(0).toFixed(1)},${py(PMAX).toFixed(1)}`;

  const trailPts = trail.map((q) => `${px(q.t).toFixed(1)},${py(q.p).toFixed(1)}`).join(' ');

  const tTicks = [0, 50, 100, 150, 200, 250, 300];
  const pTicks = [0, 3, 6, 9, 12, 15, 18];

  const marginCls = v.appGViolated ? 'danger' : v.appGApproach ? 'warn' : '';
  const rateCls = v.heatupRateAlarm || v.cooldownRateAlarm ? 'warn' : '';
  const tierCls = v.ptsRiskTier >= 3 ? 'danger' : v.ptsRiskTier >= 1 ? 'warn' : 'ok';

  return (
    <section className="panel ptlim-panel">
      <h2 className="panel-title">{t('reactorptlim.title')}</h2>

      {/* ---- P/T diagram ---- */}
      <svg
        className="ptlim-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('reactorptlim.diagramLabel')}
      >
        {/* grid + tick labels */}
        {tTicks.map((tc) => (
          <g key={`t${tc}`}>
            <line className="ptlim-grid" x1={px(tc)} y1={Y0} x2={px(tc)} y2={Y1} />
            <text className="ptlim-tick" x={px(tc)} y={Y0 + 11} textAnchor="middle">
              {tc}
            </text>
          </g>
        ))}
        {pTicks.map((p) => (
          <g key={`p${p}`}>
            <line className="ptlim-grid" x1={X0} y1={py(p)} x2={X1} y2={py(p)} />
            <text className="ptlim-tick" x={X0 - 4} y={py(p) + 3} textAnchor="end">
              {p}
            </text>
          </g>
        ))}
        <text className="ptlim-axis" x={(X0 + X1) / 2} y={H - 3} textAnchor="middle">
          {t('reactorptlim.axisTemp')}
        </text>
        <text
          className="ptlim-axis"
          x={10}
          y={(Y0 + Y1) / 2}
          textAnchor="middle"
          transform={`rotate(-90 10 ${(Y0 + Y1) / 2})`}
        >
          {t('reactorptlim.axisPress')}
        </text>

        {/* forbidden region + App-G limit curve */}
        <polygon className="ptlim-forbidden" points={forbidden} />
        <polyline className="ptlim-curve" points={curve} fill="none" />
        <text className="ptlim-forbidden-label" x={px(60)} y={py(14)}>
          {t('reactorptlim.forbidden')}
        </text>

        {/* LTOP low setpoint below the enable temperature */}
        <line
          className="ptlim-ltop"
          x1={px(0)}
          y1={py(v.ltopOpenPressureMPa)}
          x2={px(v.ltopEnableTempC)}
          y2={py(v.ltopOpenPressureMPa)}
        />
        <line
          className="ptlim-ltop faint"
          x1={px(v.ltopEnableTempC)}
          y1={py(v.ltopOpenPressureMPa)}
          x2={px(v.ltopEnableTempC)}
          y2={Y0}
        />

        {/* operating-point trail + current point */}
        {trail.length > 1 && <polyline className="ptlim-trail" points={trailPts} fill="none" />}
        <circle
          className={`ptlim-dot${v.appGViolated ? ' danger' : ''}`}
          cx={px(v.tcoldC)}
          cy={py(v.primaryPressureMPa)}
          r={4}
        />

        {/* legend */}
        <g className="ptlim-legend" transform={`translate(${X0 + 8} ${Y1 + 6})`}>
          <line className="ptlim-curve" x1={0} y1={4} x2={16} y2={4} />
          <text x={20} y={7}>{t('reactorptlim.legendCurve')}</text>
          <line className="ptlim-ltop" x1={0} y1={16} x2={16} y2={16} />
          <text x={20} y={19}>{t('reactorptlim.legendLtop')}</text>
          <circle className="ptlim-dot" cx={8} cy={28} r={3} />
          <text x={20} y={31}>{t('reactorptlim.legendPoint')}</text>
        </g>
      </svg>

      {/* ---- readouts ---- */}
      <div className="ptlim-readouts">
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.allowable')}</span>
          <span className="ptlim-val">
            {fmt.fmt(v.appGAllowableMPa, 2)} MPa · {fmt.fmt(v.appGAllowablePsig, 0)} psig
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.margin')}</span>
          <span className={`ptlim-val ${marginCls}`}>
            {v.appGMarginMPa >= 0 ? '+' : ''}
            {fmt.fmt(v.appGMarginMPa, 2)} MPa
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.rate')}</span>
          <span className={`ptlim-val ${rateCls}`}>
            {v.heatupRateCPerHr >= 0 ? '+' : ''}
            {fmt.fmt(v.heatupRateCPerHr, 1)} °C/hr ({v.heatupRateFPerHr >= 0 ? '+' : ''}
            {fmt.fmt(v.heatupRateFPerHr, 0)} °F/hr)
          </span>
        </div>
        <div className="ptlim-note">
          {t('reactorptlim.rateLimit', { lim: fmt.fmt(v.rateLimitCPerHr, 1) })} ·{' '}
          {t('reactorptlim.boltup', { t: fmt.fmt(v.minBoltupTempC, 0) })} ·{' '}
          {t('reactorptlim.critMargin', { t: fmt.fmt(v.coreCriticalMarginC, 1) })}
        </div>
      </div>

      {/* ---- lamps ---- */}
      <div className="ptlim-lamps">
        <Lamp on={v.heatupRateAlarm} kind="warn" label={t('reactorptlim.lampHeatupHi')} />
        <Lamp on={v.cooldownRateAlarm} kind="warn" label={t('reactorptlim.lampCooldownHi')} />
        <Lamp on={v.appGViolated} kind="danger" label={t('reactorptlim.lampViolation')} />
        <Lamp on={v.ltopArmed} kind="ok" label={t('reactorptlim.lampLtopArmed')} />
        <Lamp on={v.ltopActiveAlarm} kind="warn" label={t('reactorptlim.lampLtopRelief')} />
      </div>

      {/* ---- PTS monitor ---- */}
      <div className="ptlim-pts">
        <h3 className="ptlim-subtitle">{t('reactorptlim.ptsTitle')}</h3>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.efpy')}</span>
          <span className="ptlim-val">{fmt.fmt(v.vesselEfpy, 0)}</span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.rtPts')}</span>
          <span className="ptlim-val">
            {fmt.fmt(v.rtPtsF, 0)} °F ({fmt.fmt(v.rtNdtC, 0)} °C)
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.screenMargin')}</span>
          <span className={`ptlim-val${v.ptsScreeningMarginF < 0 ? ' warn' : ''}`}>
            {v.ptsScreeningMarginF >= 0 ? '+' : ''}
            {fmt.fmt(v.ptsScreeningMarginF, 0)} °F
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.wallTemp')}</span>
          <span className="ptlim-val">
            {fmt.fmt(v.wallTempC, 1)} °C ({fmt.fmt(v.wallTempF, 0)} °F)
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">
            {t('reactorptlim.kiTotal')} / {t('reactorptlim.kicWall')}
          </span>
          <span className="ptlim-val">
            {fmt.fmt(v.ptsKiTotalKsi, 1)} / {fmt.fmt(v.ptsKicAtWallKsi, 1)} ksi√in
          </span>
        </div>
        <div className="ptlim-row">
          <span className="ptlim-key">{t('reactorptlim.ptsMargin')}</span>
          <span className={`ptlim-val ${v.ptsMargin < 1 ? 'danger' : v.ptsMargin < 2 ? 'warn' : ''}`}>
            {fmt.fmt(Math.min(v.ptsMargin, 99), 2)}
          </span>
        </div>
        <div className={`ptlim-advisory ${tierCls}`}>{pick(v.ptsAdvisoryEn, v.ptsAdvisoryZh, lang)}</div>
      </div>
    </section>
  );
}
