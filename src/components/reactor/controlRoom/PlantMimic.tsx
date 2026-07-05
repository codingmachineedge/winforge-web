// 廠房模擬圖 · Plant mimic — the animated primary+secondary loop schematic from the Control Room
// design: RPV with glowing core and descending rods, pressurizer, steam generator, turbine with
// spinning rotor, generator, grid pylon, condenser, RCP/FW pumps, and dash-animated flow pipes.
// Pan (drag) + zoom (wheel / buttons) are imperative on the SVG transform so the 10 Hz re-render
// never fights the gesture.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface MimicModel {
  coreTop: string;
  coreBot: string;
  coreGlow: number;
  rodY: number;
  fuelTempText: string;
  fuelTextColor: string;
  pressureText: string;
  pzrWaterY: number;
  pzrWaterH: number;
  sgWaterY: number;
  sgWaterH: number;
  sgLevelText: string;
  sgPressureText: string;
  thotText: string;
  tcoldText: string;
  primaryFlowAnim: 'running' | 'paused';
  coldFlowColor: string;
  steamFlowAnim: 'running' | 'paused';
  steamOpacity: number;
  feedFlowAnim: 'running' | 'paused';
  gridFlowAnim: 'running' | 'paused';
  gridLineColor: string;
  turbineSpinAnim: 'running' | 'paused';
  turbineColor: string;
  turbineRpmText: string;
  genEdgeSvg: string;
  genGlowSvg: number;
  genColorSvg: string;
  genSyncText: string;
  rcpSpinAnim: 'running' | 'paused';
  rcpColor: string;
  rcpCount: number;
}

export function PlantMimic({ m }: { m: MimicModel }) {
  const { t } = useTranslation();
  const vpRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pz = useRef({ x: 0, y: 0, s: 1 });

  const apply = () => {
    const svg = svgRef.current;
    if (svg) svg.style.transform = `translate(${pz.current.x.toFixed(1)}px,${pz.current.y.toFixed(1)}px) scale(${pz.current.s.toFixed(3)})`;
  };
  const clampPan = () => {
    const vp = vpRef.current;
    if (!vp) return;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    const mgn = 120;
    pz.current.x = Math.min(mgn, Math.max(w - w * pz.current.s - mgn, pz.current.x));
    pz.current.y = Math.min(mgn, Math.max(h - h * pz.current.s - mgn, pz.current.y));
  };
  const zoomBy = (f: number) => {
    const vp = vpRef.current;
    if (!vp) return;
    const mx = vp.clientWidth / 2;
    const my = vp.clientHeight / 2;
    const ns = Math.min(6, Math.max(1, pz.current.s * f));
    const k = ns / pz.current.s;
    pz.current.x = mx - (mx - pz.current.x) * k;
    pz.current.y = my - (my - pz.current.y) * k;
    pz.current.s = ns;
    clampPan();
    apply();
  };

  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const ns = Math.min(6, Math.max(1, pz.current.s * Math.exp(-e.deltaY * 0.0016)));
      const k = ns / pz.current.s;
      pz.current.x = mx - (mx - pz.current.x) * k;
      pz.current.y = my - (my - pz.current.y) * k;
      pz.current.s = ns;
      clampPan();
      apply();
    };
    let drag = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    const onDown = (e: PointerEvent) => {
      drag = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = pz.current.x;
      oy = pz.current.y;
      vp.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      pz.current.x = ox + (e.clientX - sx);
      pz.current.y = oy + (e.clientY - sy);
      clampPan();
      apply();
    };
    const onUp = () => {
      if (!drag) return;
      drag = false;
      vp.style.cursor = 'grab';
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <div
      style={{
        background: 'linear-gradient(180deg, #0a1216, #070d10)',
        border: '1px solid var(--edge)',
        borderRadius: 12,
        padding: '30px 10px 10px',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        backgroundImage:
          'linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
      }}
    >
      <div style={{ position: 'absolute', top: 12, left: 16, fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 600, zIndex: 2, pointerEvents: 'none' }}>
        {t('reactorcr.mimicTitle')}
      </div>
      <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, letterSpacing: 1, color: 'var(--dim)', textTransform: 'uppercase', marginRight: 4, pointerEvents: 'none' }}>
          {t('reactorcr.dragZoom')}
        </span>
        <button className="rcr-btn" onClick={() => zoomBy(1 / 1.35)} title={t('reactorcr.zoomOut')} style={zoomBtn('#a7bdb8')}>
          <span className="msym" style={{ fontSize: 20 }}>remove</span>
        </button>
        <button className="rcr-btn" onClick={() => zoomBy(1.35)} title={t('reactorcr.zoomIn')} style={zoomBtn('#a7bdb8')}>
          <span className="msym" style={{ fontSize: 20 }}>add</span>
        </button>
        <button
          className="rcr-btn"
          onClick={() => {
            pz.current = { x: 0, y: 0, s: 1 };
            apply();
          }}
          title={t('reactorcr.resetView')}
          style={zoomBtn('var(--live)')}
        >
          <span className="msym" style={{ fontSize: 18 }}>recenter</span>
        </button>
      </div>
      <div
        ref={vpRef}
        style={{ position: 'relative', flex: 1, width: '100%', minHeight: 360, overflow: 'hidden', borderRadius: 8, cursor: 'grab', userSelect: 'none', touchAction: 'none' }}
      >
        <svg ref={svgRef} viewBox="0 0 1000 470" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block', transformOrigin: '0 0', willChange: 'transform' }}>
          <defs>
            <linearGradient id="rcrCore" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={m.coreTop} />
              <stop offset="100%" stopColor={m.coreBot} />
            </linearGradient>
          </defs>

          {/* pipes: base + animated flow overlay */}
          <path d="M 232 168 H 300 Q 320 168 320 148 V 120 H 372" fill="none" stroke="#3a1c1c" strokeWidth={11} strokeLinecap="round" />
          <path d="M 232 168 H 300 Q 320 168 320 148 V 120 H 372" fill="none" stroke="#ff6a52" strokeWidth={4} strokeLinecap="round" strokeDasharray="10 14" style={{ animation: 'rcr-flow 0.9s linear infinite', animationPlayState: m.primaryFlowAnim }} />
          <path d="M 372 320 H 300 Q 285 320 285 336 V 360 H 232" fill="none" stroke="#12303a" strokeWidth={11} strokeLinecap="round" />
          <path d="M 372 320 H 300 Q 285 320 285 336 V 360 H 232" fill="none" stroke={m.coldFlowColor} strokeWidth={4} strokeLinecap="round" strokeDasharray="10 14" style={{ animation: 'rcr-flow-rev 0.9s linear infinite', animationPlayState: m.primaryFlowAnim }} />
          <path d="M 452 96 H 560 Q 580 96 580 120 V 150 H 612" fill="none" stroke="#2a3236" strokeWidth={10} strokeLinecap="round" />
          <path d="M 452 96 H 560 Q 580 96 580 120 V 150 H 612" fill="none" stroke="var(--steam)" strokeWidth={3.5} strokeLinecap="round" strokeDasharray="8 16" style={{ animation: 'rcr-flow 0.7s linear infinite', animationPlayState: m.steamFlowAnim, opacity: m.steamOpacity }} />
          <path d="M 700 176 V 250" fill="none" stroke="#2a3236" strokeWidth={9} strokeLinecap="round" />
          <path d="M 700 176 V 250" fill="none" stroke="var(--steam)" strokeWidth={3} strokeLinecap="round" strokeDasharray="7 13" style={{ animation: 'rcr-flow 0.8s linear infinite', animationPlayState: m.steamFlowAnim, opacity: m.steamOpacity }} />
          <path d="M 636 300 H 520 Q 500 300 500 316 V 344 H 452 V 320" fill="none" stroke="#12303a" strokeWidth={9} strokeLinecap="round" />
          <path d="M 636 300 H 520 Q 500 300 500 316 V 344 H 452 V 320" fill="none" stroke="var(--water)" strokeWidth={3} strokeLinecap="round" strokeDasharray="8 14" style={{ animation: 'rcr-flow-rev 0.9s linear infinite', animationPlayState: m.feedFlowAnim }} />
          <path d="M 812 150 H 900" fill="none" stroke="#2a3236" strokeWidth={6} />
          <path d="M 812 150 H 900" fill="none" stroke={m.gridLineColor} strokeWidth={3} strokeDasharray="6 10" style={{ animation: 'rcr-flow 0.6s linear infinite', animationPlayState: m.gridFlowAnim }} />

          {/* reactor pressure vessel */}
          <rect x={150} y={150} width={82} height={220} rx={26} fill="#0c161b" stroke="var(--edge2)" strokeWidth={2.5} />
          <rect x={166} y={205} width={50} height={120} rx={5} fill="url(#rcrCore)" style={{ filter: `drop-shadow(0 0 ${m.coreGlow}px ${m.coreBot})` }} />
          <g stroke="#8aa0a8" strokeWidth={4} strokeLinecap="round">
            <line x1={176} y1={205} x2={176} y2={m.rodY} />
            <line x1={186} y1={205} x2={186} y2={m.rodY} />
            <line x1={196} y1={205} x2={196} y2={m.rodY} />
            <line x1={206} y1={205} x2={206} y2={m.rodY} />
          </g>
          <text x={191} y={392} textAnchor="middle" fill="var(--dim)" style={{ font: "600 12px 'Chakra Petch'", letterSpacing: 1 }}>RPV</text>
          <text x={191} y={192} textAnchor="middle" fill={m.fuelTextColor} style={{ font: "700 12px 'Roboto Mono'" }}>{m.fuelTempText}°C</text>

          {/* pressurizer */}
          <rect x={270} y={70} width={34} height={70} rx={14} fill="#0c161b" stroke="var(--edge2)" strokeWidth={2} />
          <rect x={273} y={m.pzrWaterY} width={28} height={m.pzrWaterH} rx={8} fill="#1c4a5a" />
          <line x1={287} y1={140} x2={287} y2={158} stroke="var(--edge2)" strokeWidth={3} />
          <text x={287} y={60} textAnchor="middle" fill="var(--dim)" style={{ font: "600 10px 'Chakra Petch'", letterSpacing: 1 }}>PZR</text>
          <text x={320} y={96} fill="#a7bdb8" style={{ font: "500 11px 'Roboto Mono'" }}>{m.pressureText} MPa</text>

          {/* steam generator */}
          <path d="M 372 118 Q 372 96 396 96 H 428 Q 452 96 452 118 V 300 Q 452 322 428 322 H 396 Q 372 322 372 300 Z" fill="#0c161b" stroke="var(--edge2)" strokeWidth={2.5} />
          <rect x={380} y={m.sgWaterY} width={64} height={m.sgWaterH} rx={6} fill="#123842" opacity={0.85} />
          <text x={412} y={88} textAnchor="middle" fill="var(--dim)" style={{ font: "600 11px 'Chakra Petch'", letterSpacing: 1 }}>SG</text>
          <text x={412} y={215} textAnchor="middle" fill="#a7bdb8" style={{ font: "500 10px 'Roboto Mono'" }}>LVL {m.sgLevelText}%</text>

          {/* turbine */}
          <g transform="translate(612,110)">
            <path d="M 0 20 L 88 4 L 88 76 L 0 60 Z" fill="#0e1a20" stroke="var(--edge2)" strokeWidth={2} />
            <g style={{ transformOrigin: '44px 40px', transformBox: 'fill-box', animation: 'rcr-spin 0.5s linear infinite', animationPlayState: m.turbineSpinAnim }}>
              <circle cx={44} cy={40} r={15} fill="none" stroke={m.turbineColor} strokeWidth={2.5} />
              <line x1={44} y1={25} x2={44} y2={55} stroke={m.turbineColor} strokeWidth={2.5} />
              <line x1={29} y1={40} x2={59} y2={40} stroke={m.turbineColor} strokeWidth={2.5} />
              <line x1={33} y1={29} x2={55} y2={51} stroke={m.turbineColor} strokeWidth={2} />
              <line x1={55} y1={29} x2={33} y2={51} stroke={m.turbineColor} strokeWidth={2} />
            </g>
          </g>
          <text x={656} y={102} textAnchor="middle" fill="var(--dim)" style={{ font: "600 11px 'Chakra Petch'", letterSpacing: 1 }}>TURBINE</text>
          <text x={656} y={204} textAnchor="middle" fill={m.turbineColor} style={{ font: "700 11px 'Roboto Mono'" }}>{m.turbineRpmText} RPM</text>

          {/* generator */}
          <circle cx={770} cy={150} r={38} fill="#0c161b" stroke={m.genEdgeSvg} strokeWidth={2.5} style={{ filter: `drop-shadow(0 0 ${m.genGlowSvg}px ${m.genColorSvg})` }} />
          <text x={770} y={146} textAnchor="middle" fill={m.genColorSvg} style={{ font: "800 15px 'Oxanium'" }}>G</text>
          <text x={770} y={162} textAnchor="middle" fill="#a7bdb8" style={{ font: "500 9px 'Roboto Mono'" }}>{m.genSyncText}</text>
          <text x={770} y={205} textAnchor="middle" fill="var(--dim)" style={{ font: "600 11px 'Chakra Petch'", letterSpacing: 1 }}>GEN</text>

          {/* grid pylon */}
          <path d="M 906 150 l 14 -22 l 14 22 M 906 150 h 28 M 913 140 h 14" fill="none" stroke={m.gridLineColor} strokeWidth={2} />
          <text x={920} y={176} textAnchor="middle" fill="var(--dim)" style={{ font: "600 10px 'Chakra Petch'", letterSpacing: 1 }}>GRID</text>

          {/* condenser */}
          <rect x={612} y={250} width={90} height={56} rx={8} fill="#0c161b" stroke="var(--edge2)" strokeWidth={2} />
          <g stroke="var(--water)" strokeWidth={1.5} opacity={0.5}>
            <line x1={622} y1={262} x2={692} y2={262} />
            <line x1={622} y1={272} x2={692} y2={272} />
            <line x1={622} y1={282} x2={692} y2={282} />
            <line x1={622} y1={292} x2={692} y2={292} />
          </g>
          <text x={657} y={326} textAnchor="middle" fill="var(--dim)" style={{ font: "600 10px 'Chakra Petch'", letterSpacing: 1 }}>CONDENSER</text>

          {/* pumps */}
          <circle cx={258} cy={360} r={17} fill="#0e1a20" stroke="var(--edge2)" strokeWidth={2} />
          <g style={{ transformOrigin: '258px 360px', animation: 'rcr-spin 0.4s linear infinite', animationPlayState: m.rcpSpinAnim }}>
            <path d="M 258 360 L 258 346 M 258 360 L 270 367 M 258 360 L 246 367" stroke={m.rcpColor} strokeWidth={2.5} fill="none" strokeLinecap="round" />
          </g>
          <text x={258} y={392} textAnchor="middle" fill="var(--dim)" style={{ font: "600 10px 'Chakra Petch'", letterSpacing: 1 }}>RCP ×{m.rcpCount}</text>
          <circle cx={500} cy={344} r={13} fill="#0e1a20" stroke="var(--edge2)" strokeWidth={2} />
          <g style={{ transformOrigin: '500px 344px', animation: 'rcr-spin 0.4s linear infinite', animationPlayState: m.feedFlowAnim }}>
            <path d="M 500 344 L 500 333 M 500 344 L 510 350 M 500 344 L 490 350" stroke="var(--water)" strokeWidth={2} fill="none" strokeLinecap="round" />
          </g>
          <text x={500} y={372} textAnchor="middle" fill="var(--dim)" style={{ font: "600 9px 'Chakra Petch'", letterSpacing: 1 }}>FW PUMP</text>

          {/* leg temperature labels */}
          <text x={300} y={150} fill="#ff8a72" style={{ font: "600 11px 'Roboto Mono'" }}>Thot {m.thotText}</text>
          <text x={300} y={352} fill="var(--water)" style={{ font: "600 11px 'Roboto Mono'" }}>Tcold {m.tcoldText}</text>
          <text x={470} y={80} fill="#a7bdb8" style={{ font: "500 10px 'Roboto Mono'" }}>{m.sgPressureText} MPa</text>
        </svg>
      </div>
    </div>
  );
}

function zoomBtn(color: string): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: '1px solid var(--edge2)',
    background: 'rgba(12,21,25,0.85)',
    color,
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
  };
}
