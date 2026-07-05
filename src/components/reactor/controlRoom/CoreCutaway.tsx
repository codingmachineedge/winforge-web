// 堆芯剖面 · Core cutaway modal — vessel cross-section with 15 fuel-assembly columns coloured by
// local power (centre-peaked radial shape), control rods descending to the live insertion depth,
// coolant up-flow arrows, a flux halo, six readouts and the axial power shape (rod-skewed cosine).

import { useTranslation } from 'react-i18next';
import type { NumberFmt } from '../format';

export interface CoreCutawayProps {
  open: boolean;
  onClose: () => void;
  /** Neutron power fraction 0..1. */
  powerFraction: number;
  /** Mean rod insertion %, 0..100. */
  rodInsertionPct: number;
  fuelTempC: number;
  tavgC: number;
  coolantFlowFraction: number;
  /** Core gradient top colour at the current fuel temperature (shared with the mimic). */
  fluxCore: string;
  fmt: NumberFmt;
}

const N = 15;
const CORE_X0 = 158;
const CORE_X1 = 402;
const CORE_TOP = 150;
const CORE_H = 224;

function localColor(localP: number): string {
  const eff = Math.max(0, localP);
  if (eff < 0.02) return '#245c40';
  if (eff < 0.1) return '#3f9a54';
  if (eff < 0.3) return '#7ad06a';
  if (eff < 0.6) return '#e6d95a';
  if (eff < 0.9) return '#ff9a52';
  return '#ff5a44';
}

export function CoreCutaway({ open, onClose, powerFraction, rodInsertionPct, fuelTempC, tavgC, coolantFlowFraction, fluxCore, fmt }: CoreCutawayProps) {
  const { t } = useTranslation();
  if (!open) return null;

  const pf = powerFraction;
  const ins = rodInsertionPct;
  const colW = (CORE_X1 - CORE_X0) / N;
  const assemblies = Array.from({ length: N }, (_, i) => {
    const rel = (i - (N - 1) / 2) / ((N - 1) / 2);
    const radial = Math.cos(rel * 1.35) ** 1.4;
    const localP = pf * (0.35 + 0.65 * radial);
    return {
      x: CORE_X0 + i * colW + 1.5,
      w: colW - 3,
      color: localColor(localP),
      glow: 2 + 16 * localP,
    };
  });
  const rodDepth = (ins / 100) * CORE_H;
  const rodCols = [1, 3, 5, 7, 9, 11, 13];
  const rods = rodCols.map((i) => ({
    x: CORE_X0 + i * colW + colW * 0.28,
    w: colW * 0.44,
    h: Math.max(2, rodDepth),
    capX: CORE_X0 + i * colW + colW * 0.12,
    capW: colW * 0.76,
  }));
  const coolantColor = tavgC > 300 ? '#ff8a72' : tavgC > 150 ? '#8fd6cf' : '#35c9f0';
  const coreFlowAnim: 'running' | 'paused' = coolantFlowFraction > 0.03 ? 'running' : 'paused';

  const readouts = [
    { label: t('reactorcr.coreReactorPower'), value: fmt.fmt(pf * 100, pf * 100 < 10 ? 2 : 1), unit: '% RTP', color: '#35e08a' },
    { label: t('reactorcr.corePeakFuel'), value: fmt.fmt(fuelTempC * (0.9 + 0.25 * pf), 0), unit: '°C', color: fuelTempC > 900 ? '#ffb62e' : '#cfe3dd' },
    { label: t('reactorcr.coreAvgCoolant'), value: fmt.fmt(tavgC, 1), unit: '°C', color: '#cfe3dd' },
    { label: t('reactorcr.coreRodInsertion'), value: fmt.fmt(ins, 0), unit: '%', color: '#cfe3dd' },
    { label: t('reactorcr.coreNeutronFlux'), value: fmt.fmt(Math.max(1e-3, pf) * 3.2, 2), unit: '×10¹³ n/cm²s', color: '#35e08a' },
    { label: t('reactorcr.corePeaking'), value: fmt.fmt(1.55 - 0.15 * (ins / 100), 2), unit: 'Fq', color: '#cfe3dd' },
  ];

  const axialPts = Array.from({ length: 21 }, (_, k) => {
    const z = k / 20;
    const skew = 1 - (ins / 100) * 0.9 * z;
    const shape = Math.sin(Math.PI * z) * skew;
    return { x: 6 + z * 90, y: 84 - Math.max(0, shape) * 72 };
  });
  const axialPath = axialPts.map((p, k) => (k === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(3,6,8,0.82)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 1080, maxHeight: '92vh', overflow: 'auto', background: 'linear-gradient(180deg, #0b1418, #070d10)', border: '1px solid var(--edge2)', borderRadius: 16, padding: '20px 24px', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
          <span className="msym" style={{ fontSize: 26, color: 'var(--warn)' }}>grain</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Oxanium', fontWeight: 800, fontSize: 18, letterSpacing: 1, color: '#dcefe9' }}>{t('reactorcr.coreTitle')}</div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase' }}>{t('reactorcr.coreSub')}</div>
          </div>
          <button className="rcr-btn" onClick={onClose} title={t('reactorcr.close')} style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid var(--edge2)', background: '#0c1519', color: '#a7bdb8', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
            <span className="msym" style={{ fontSize: 22 }}>close</span>
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 18, alignItems: 'stretch' }}>
          <div style={{ background: 'radial-gradient(120% 90% at 50% 40%, #0e1a20, #060c0f)', border: '1px solid var(--edge)', borderRadius: 12, padding: 10 }}>
            <svg viewBox="0 0 560 520" style={{ width: '100%', height: 'auto', display: 'block' }}>
              <defs>
                <radialGradient id="rcrFlux" cx="50%" cy="46%" r="55%">
                  <stop offset="0%" stopColor={fluxCore} stopOpacity={0.55} />
                  <stop offset="70%" stopColor={fluxCore} stopOpacity={0.12} />
                  <stop offset="100%" stopColor={fluxCore} stopOpacity={0} />
                </radialGradient>
              </defs>
              <path d="M 90 110 Q 90 60 150 58 H 410 Q 470 60 470 110 V 410 Q 470 462 410 464 H 150 Q 90 462 90 410 Z" fill="#0a1216" stroke="#3a4d52" strokeWidth={8} />
              <path d="M 108 118 Q 108 78 158 76 H 402 Q 452 78 452 118 V 402 Q 452 446 402 448 H 158 Q 108 446 108 402 Z" fill="#08110f" stroke="#1c2a2f" strokeWidth={2} />
              <g stroke={coolantColor} strokeWidth={2.5} opacity={0.5} strokeDasharray="6 12" style={{ animation: 'rcr-flow-rev 1s linear infinite', animationPlayState: coreFlowAnim }}>
                <line x1={126} y1={440} x2={126} y2={96} />
                <line x1={434} y1={440} x2={434} y2={96} />
              </g>
              <rect x={150} y={150} width={260} height={230} rx={8} fill="url(#rcrFlux)" style={{ animation: 'rcr-blink 2.2s ease-in-out infinite', animationPlayState: coreFlowAnim }} />
              {assemblies.map((a, i) => (
                <rect key={i} x={a.x.toFixed(1)} y={CORE_TOP} width={a.w.toFixed(1)} height={CORE_H} rx={2} fill={a.color} style={{ filter: `drop-shadow(0 0 ${a.glow.toFixed(1)}px ${a.color})` }} />
              ))}
              {rods.map((r, i) => (
                <g key={i}>
                  <rect x={r.x.toFixed(1)} y={148} width={r.w.toFixed(1)} height={r.h.toFixed(1)} rx={2} fill="#9fb2b8" opacity={0.92} />
                  <rect x={r.capX.toFixed(1)} y={132} width={r.capW.toFixed(1)} height={16} rx={2} fill="#6d8480" />
                </g>
              ))}
              <rect x={150} y={120} width={260} height={10} rx={3} fill="#1c2a2f" />
              <text x={280} y={500} textAnchor="middle" fill="var(--dim)" style={{ font: "600 12px 'Chakra Petch'", letterSpacing: 2 }}>
                {t('reactorcr.coreFooter')}
              </text>
            </svg>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {readouts.map((cr) => (
              <div key={cr.label} style={{ background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase' }}>{cr.label}</div>
                <div style={{ fontFamily: 'Oxanium', fontWeight: 700, fontSize: 20, color: cr.color, marginTop: 2 }}>
                  {cr.value}
                  <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: "'Roboto Mono'", fontWeight: 400 }}> {cr.unit}</span>
                </div>
              </div>
            ))}
            <div style={{ background: 'var(--panel)', border: '1px solid var(--edge)', borderRadius: 10, padding: '10px 12px', flex: 1 }}>
              <div style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 6 }}>{t('reactorcr.coreAxial')}</div>
              <svg viewBox="0 0 100 90" style={{ width: '100%', height: 'auto' }}>
                <path d="M 6 84 V 6 M 6 84 H 96" stroke="#1c2a2f" strokeWidth={1.5} fill="none" />
                <path d={axialPath} fill="none" stroke="var(--live)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
