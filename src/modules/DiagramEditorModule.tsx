import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge Pages/DiagramEditorModule + DiagramService: a native
// flowchart editor on an SVG canvas — add shapes, drag to move, connect with
// arrows, rename, restyle, save/load JSON, export PNG. Fully self-contained
// (no backend, no external tool), so it runs identically in the browser.

type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'text';

interface Node {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  fill: string;
}

interface Edge {
  id: string;
  from: string;
  to: string;
}

interface Doc {
  nodes: Node[];
  edges: Edge[];
}

const KEY = 'winforge-web.diagram.v1';
const GRID = 10;
const PALETTE = ['#2b5797', '#107c10', '#a4262c', '#8764b8', '#c19c00', '#4a4a52'];

let counter = 0;
const nid = () => `n${(counter += 1)}_${(Date.now() % 100000).toString(36)}`;

function loadDoc(): Doc {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.nodes) && Array.isArray(p.edges)) return p;
    }
  } catch {
    /* ignore */
  }
  return { nodes: [], edges: [] };
}

const center = (n: Node) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

export function DiagramEditorModule() {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<Doc>(loadDoc);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
    } catch {
      /* ignore */
    }
  }, [doc]);

  const addNode = (kind: ShapeKind) => {
    const id = nid();
    // Compute offset/colour from the live count inside the updater so rapid
    // successive adds stagger correctly instead of stacking on a stale length.
    setDoc((d) => {
      const i = d.nodes.length;
      const n: Node = {
        id,
        kind,
        x: 60 + (i % 8) * 24,
        y: 60 + (i % 8) * 24,
        w: kind === 'text' ? 120 : 140,
        h: kind === 'text' ? 40 : 80,
        label: kind === 'text' ? t('diagram.textLabel') : t('diagram.shapeLabel'),
        fill: PALETTE[i % PALETTE.length]!,
      };
      return { ...d, nodes: [...d.nodes, n] };
    });
    setSelected(id);
  };

  const del = () => {
    if (!selected) return;
    setDoc((d) => ({
      nodes: d.nodes.filter((n) => n.id !== selected),
      edges: d.edges.filter((e) => e.from !== selected && e.to !== selected),
    }));
    setSelected(null);
  };

  const rename = (id: string) => {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) return;
    const label = window.prompt(t('diagram.renamePrompt'), n.label);
    if (label != null) setDoc((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === id ? { ...x, label } : x)) }));
  };

  const setFill = (fill: string) => {
    if (!selected) return;
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === selected ? { ...n, fill } : n)) }));
  };

  const onNodePointerDown = (e: React.PointerEvent, n: Node) => {
    e.stopPropagation();
    if (connectFrom) {
      if (connectFrom !== n.id) {
        setDoc((d) => ({ ...d, edges: [...d.edges, { id: nid(), from: connectFrom, to: n.id }] }));
      }
      setConnectFrom(null);
      return;
    }
    setSelected(n.id);
    const pt = svgPoint(e);
    drag.current = { id: n.id, dx: pt.x - n.x, dy: pt.y - n.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const svgPoint = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const pt = svgPoint(e);
      let x = pt.x - drag.current.dx;
      let y = pt.y - drag.current.dy;
      if (snap) {
        x = Math.round(x / GRID) * GRID;
        y = Math.round(y / GRID) * GRID;
      }
      const id = drag.current.id;
      setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, x: Math.max(0, x), y: Math.max(0, y) } : n)) }));
    },
    [snap],
  );

  const onPointerUp = () => {
    drag.current = null;
  };

  const save = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diagram.wfdiagram.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const p = JSON.parse(txt);
        if (Array.isArray(p.nodes) && Array.isArray(p.edges)) setDoc(p);
      } catch {
        /* ignore malformed */
      }
    });
    e.target.value = '';
  };

  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svg.clientWidth || 900;
      canvas.height = svg.clientHeight || 520;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'diagram.png';
      a.click();
    };
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
  };

  const shapeEl = (n: Node) => {
    const common = {
      fill: n.fill,
      stroke: selected === n.id ? '#4cc2ff' : '#ffffff',
      strokeWidth: selected === n.id ? 3 : 1.5,
    };
    switch (n.kind) {
      case 'ellipse':
        return <ellipse cx={n.x + n.w / 2} cy={n.y + n.h / 2} rx={n.w / 2} ry={n.h / 2} {...common} />;
      case 'diamond':
        return (
          <polygon
            points={`${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}`}
            {...common}
          />
        );
      case 'text':
        return <rect x={n.x} y={n.y} width={n.w} height={n.h} fill="transparent" stroke={selected === n.id ? '#4cc2ff' : 'transparent'} strokeWidth={1.5} rx={4} />;
      case 'rounded':
        return <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={14} {...common} />;
      default:
        return <rect x={n.x} y={n.y} width={n.w} height={n.h} {...common} />;
    }
  };

  const nodeById = (id: string) => doc.nodes.find((n) => n.id === id);

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => addNode('rect')}>▭ {t('diagram.rect')}</button>
        <button className="mini" onClick={() => addNode('rounded')}>▢ {t('diagram.rounded')}</button>
        <button className="mini" onClick={() => addNode('ellipse')}>◯ {t('diagram.ellipse')}</button>
        <button className="mini" onClick={() => addNode('diamond')}>◇ {t('diagram.diamond')}</button>
        <button className="mini" onClick={() => addNode('text')}>T {t('diagram.text')}</button>
        <button className={`mini${connectFrom ? ' primary' : ''}`} onClick={() => setConnectFrom(selected)} disabled={!selected && !connectFrom}>
          → {connectFrom ? t('diagram.connecting') : t('diagram.connect')}
        </button>
        <button className="mini" onClick={del} disabled={!selected}>{t('diagram.delete')}</button>
        <button className={`mini${snap ? ' primary' : ''}`} onClick={() => setSnap((s) => !s)}>{t('diagram.snap')}</button>
        <button className="mini" onClick={save}>{t('diagram.save')}</button>
        <label className="mini" style={{ cursor: 'pointer' }}>
          {t('diagram.load')}
          <input type="file" accept=".json,.wfdiagram" onChange={loadFile} style={{ display: 'none' }} />
        </label>
        <button className="mini" onClick={exportPng}>{t('diagram.exportPng')}</button>
      </div>
      <p className="count-note">{t('diagram.hint')}</p>

      {selected && (
        <div className="mod-toolbar">
          <span className="count-note" style={{ margin: 0 }}>{t('diagram.fill')}</span>
          {PALETTE.map((c) => (
            <button key={c} onClick={() => setFill(c)} title={c} style={{ width: 22, height: 22, background: c, border: '1px solid var(--stroke)', borderRadius: 4, cursor: 'pointer' }} />
          ))}
          <button className="mini" onClick={() => rename(selected)}>{t('diagram.rename')}</button>
        </div>
      )}

      <svg
        ref={svgRef}
        width="100%"
        height={520}
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--stroke)', borderRadius: 'var(--radius)', touchAction: 'none' }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerDown={() => {
          setSelected(null);
          setConnectFrom(null);
        }}
      >
        <defs>
          <marker id="wf-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L9,3 L0,6 Z" fill="#b8b8c0" />
          </marker>
        </defs>
        {doc.edges.map((e) => {
          const a = nodeById(e.from);
          const b = nodeById(e.to);
          if (!a || !b) return null;
          const ca = center(a);
          const cb = center(b);
          return <line key={e.id} x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke="#b8b8c0" strokeWidth={2} markerEnd="url(#wf-arrow)" />;
        })}
        {doc.nodes.map((n) => (
          <g
            key={n.id}
            onPointerDown={(e) => onNodePointerDown(e, n)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              rename(n.id);
            }}
            style={{ cursor: connectFrom ? 'crosshair' : 'move' }}
          >
            {shapeEl(n)}
            <text x={n.x + n.w / 2} y={n.y + n.h / 2} textAnchor="middle" dominantBaseline="middle" fill="#ffffff" fontSize={14} pointerEvents="none">
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      <p className="count-note">{t('diagram.counts', { nodes: doc.nodes.length, edges: doc.edges.length })}</p>
    </div>
  );
}
