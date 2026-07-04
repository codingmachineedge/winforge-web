import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge Pages/DiagramEditorModule + DiagramService: a native draw.io-style
// flowchart editor on an SVG canvas. Full feature surface:
//   shape palette (rect / rounded / ellipse / diamond / text), drag-to-move,
//   corner resize handles, double-click rename, connect nodes with box-edge arrows,
//   edge labels, per-shape styling (fill / stroke / stroke-width / font-size / text
//   colour), single + multi-select (ctrl-click + marquee), duplicate, delete,
//   z-order (front/back), snap-to-grid + visible grid, zoom in/out/reset + pan,
//   undo/redo, new/open (JSON), save (.wfdiagram JSON), export PNG + SVG.
// Fully self-contained — no backend, no external tool — so it runs identically in the
// browser. Only file writes (save / export) leave the canvas; those go through the
// standard browser download path.

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
  stroke: string;
  strokeWidth: number;
  fontSize: number;
  textColor: string;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  label: string;
  stroke: string;
  strokeWidth: number;
  fontSize: number;
}

interface Doc {
  version: number;
  app: string;
  canvasWidth: number;
  canvasHeight: number;
  nodes: Node[];
  edges: Edge[];
}

const KEY = 'winforge-web.diagram.v2';
const GRID = 20;
const HANDLE = 10;
const APP_ID = 'WinForge.DiagramEditor';
const FILE_EXT = '.wfdiagram';
const CANVAS_W = 2400;
const CANVAS_H = 1600;
const PALETTE = ['#2b5797', '#107c10', '#a4262c', '#8764b8', '#c19c00', '#4a4a52'];

let counter = 0;
const nid = () => `n${(counter += 1)}_${(Date.now() % 100000).toString(36)}`;

function blankDoc(): Doc {
  return { version: 1, app: APP_ID, canvasWidth: CANVAS_W, canvasHeight: CANVAS_H, nodes: [], edges: [] };
}

// Accept both the web schema (short keys) and the C# schema (PascalCase / enum names)
// so files saved by the desktop app open here and vice-versa.
function coerceKind(k: unknown): ShapeKind {
  const s = String(k ?? '').toLowerCase();
  if (s.includes('round')) return 'rounded';
  if (s.includes('ellip')) return 'ellipse';
  if (s.includes('diamond')) return 'diamond';
  if (s.includes('text')) return 'text';
  if (s === '0' || s === 'rectangle' || s === 'rect') return 'rect';
  if (s === '1') return 'rounded';
  if (s === '2') return 'ellipse';
  if (s === '3') return 'diamond';
  if (s === '4') return 'text';
  return 'rect';
}

function num(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : d;
}

function coerceDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nodesRaw = (r.nodes ?? r.Nodes) as unknown;
  const edgesRaw = (r.edges ?? r.Edges) as unknown;
  if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) return null;
  const nodes: Node[] = nodesRaw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? o.Id ?? nid()),
      kind: coerceKind(o.kind ?? o.Kind),
      x: num(o.x ?? o.X, 0),
      y: num(o.y ?? o.Y, 0),
      w: num(o.w ?? o.Width, 140),
      h: num(o.h ?? o.Height, 80),
      label: String(o.label ?? o.Label ?? ''),
      fill: String(o.fill ?? o.Fill ?? '#2b5797'),
      stroke: String(o.stroke ?? o.Stroke ?? '#ffffff'),
      strokeWidth: num(o.strokeWidth ?? o.StrokeWidth, 2),
      fontSize: num(o.fontSize ?? o.FontSize, 14),
      textColor: String(o.textColor ?? o.TextColor ?? '#ffffff'),
    };
  });
  const edges: Edge[] = edgesRaw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? o.Id ?? nid()),
      from: String(o.from ?? o.FromId ?? ''),
      to: String(o.to ?? o.ToId ?? ''),
      label: String(o.label ?? o.Label ?? ''),
      stroke: String(o.stroke ?? o.Stroke ?? '#b8b8c0'),
      strokeWidth: num(o.strokeWidth ?? o.StrokeWidth, 2),
      fontSize: num(o.fontSize ?? o.FontSize, 12),
    };
  });
  return {
    version: num(r.version ?? r.Version, 1),
    app: String(r.app ?? r.App ?? APP_ID),
    canvasWidth: num(r.canvasWidth ?? r.CanvasWidth, CANVAS_W),
    canvasHeight: num(r.canvasHeight ?? r.CanvasHeight, CANVAS_H),
    nodes,
    edges,
  };
}

function loadDoc(): Doc {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = coerceDoc(JSON.parse(raw));
      if (p) return p;
    }
  } catch {
    /* ignore */
  }
  return blankDoc();
}

const center = (n: Node) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

/** Intersection of a node's bounding box with the line from its centre toward `toward`. */
function edgePoint(n: Node, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = n.w / 2;
  const hh = n.h / 2;
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Shortest distance from point `p` to the segment a→b (used for hit-testing edges). */
function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const tt = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + tt * dx), p.y - (a.y + tt * dy));
}

type DragState =
  | { kind: 'move'; origin: Record<string, { x: number; y: number }>; start: { x: number; y: number } }
  | { kind: 'resize'; id: string; handle: number; start: { x: number; y: number } }
  | { kind: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number } };

export function DiagramEditorModule() {
  const { t } = useTranslation();
  const [doc, setDocState] = useState<Doc>(loadDoc);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Undo/redo history — snapshots of the document (past / present is `doc` / future).
  const past = useRef<Doc[]>([]);
  const future = useRef<Doc[]>([]);
  const [histTick, setHistTick] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
    } catch {
      /* ignore */
    }
  }, [doc]);

  // Commit a change through history (records the previous doc so it can be undone).
  const commit = useCallback((updater: (d: Doc) => Doc) => {
    setDocState((prev) => {
      const next = updater(prev);
      if (next === prev) return prev;
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      return next;
    });
    setHistTick((n) => n + 1);
  }, []);

  // Mutate without a history entry (used by live drag; a single commit is pushed on down).
  const setDoc = setDocState;

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    setDocState((cur) => {
      const prev = past.current.pop()!;
      future.current.push(cur);
      return prev;
    });
    setSelected(new Set());
    setSelectedEdge(null);
    setHistTick((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    setDocState((cur) => {
      const next = future.current.pop()!;
      past.current.push(cur);
      return next;
    });
    setSelected(new Set());
    setSelectedEdge(null);
    setHistTick((n) => n + 1);
  }, []);

  const snapV = useCallback((v: number) => (snap ? Math.round(v / GRID) * GRID : v), [snap]);

  const say = (msg: string) => setStatus(msg);

  // ── Add / duplicate / delete / z-order ────────────────────────────────────────

  const addNode = (kind: ShapeKind) => {
    const id = nid();
    commit((d) => {
      const i = d.nodes.length;
      const isText = kind === 'text';
      const n: Node = {
        id,
        kind,
        x: snapV(80 + (i % 8) * 24),
        y: snapV(80 + (i % 8) * 24),
        w: isText ? 120 : 140,
        h: isText ? 40 : 80,
        label: isText ? t('diagram.textLabel') : t('diagram.shapeLabel'),
        fill: isText ? '#00000000' : PALETTE[i % PALETTE.length]!,
        stroke: isText ? '#00000000' : '#ffffff',
        strokeWidth: isText ? 0 : 2,
        fontSize: 14,
        textColor: '#ffffff',
      };
      return { ...d, nodes: [...d.nodes, n] };
    });
    setSelected(new Set([id]));
    setSelectedEdge(null);
    say(t('diagram.stAdded'));
  };

  const duplicate = () => {
    if (selected.size === 0) return;
    const clones: string[] = [];
    commit((d) => {
      const add: Node[] = [];
      for (const n of d.nodes) {
        if (!selected.has(n.id)) continue;
        const c: Node = { ...n, id: nid(), x: n.x + 24, y: n.y + 24 };
        add.push(c);
        clones.push(c.id);
      }
      return { ...d, nodes: [...d.nodes, ...add] };
    });
    setSelected(new Set(clones));
    setSelectedEdge(null);
    say(t('diagram.stDuplicated'));
  };

  const del = () => {
    if (selected.size === 0 && !selectedEdge) return;
    commit((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !selected.has(n.id)),
      edges: d.edges.filter(
        (e) => e.id !== selectedEdge && !selected.has(e.from) && !selected.has(e.to),
      ),
    }));
    setSelected(new Set());
    setSelectedEdge(null);
    say(t('diagram.stDeleted'));
  };

  const bringFront = () => {
    if (selected.size === 0) return;
    commit((d) => {
      const sel = d.nodes.filter((n) => selected.has(n.id));
      const rest = d.nodes.filter((n) => !selected.has(n.id));
      return { ...d, nodes: [...rest, ...sel] };
    });
  };

  const sendBack = () => {
    if (selected.size === 0) return;
    commit((d) => {
      const sel = d.nodes.filter((n) => selected.has(n.id));
      const rest = d.nodes.filter((n) => !selected.has(n.id));
      return { ...d, nodes: [...sel, ...rest] };
    });
  };

  const newDoc = () => {
    if (doc.nodes.length > 0 && !window.confirm(t('diagram.confirmNew'))) return;
    past.current.push(doc);
    future.current = [];
    setDocState(blankDoc());
    setSelected(new Set());
    setSelectedEdge(null);
    setHistTick((n) => n + 1);
    say(t('diagram.stNew'));
  };

  // ── Rename (double-click) ─────────────────────────────────────────────────────

  const renameNode = (id: string) => {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) return;
    const label = window.prompt(t('diagram.renamePrompt'), n.label);
    if (label != null) commit((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === id ? { ...x, label } : x)) }));
  };

  const renameEdge = (id: string) => {
    const e = doc.edges.find((x) => x.id === id);
    if (!e) return;
    const label = window.prompt(t('diagram.edgeLabelPrompt'), e.label);
    if (label != null) commit((d) => ({ ...d, edges: d.edges.map((x) => (x.id === id ? { ...x, label } : x)) }));
  };

  // ── Property editors (single-node) ────────────────────────────────────────────

  const onlyNode = useMemo(() => {
    if (selected.size !== 1) return null;
    const id = [...selected][0]!;
    return doc.nodes.find((n) => n.id === id) ?? null;
  }, [selected, doc.nodes]);

  const patchNode = (patch: Partial<Node>) => {
    if (!onlyNode) return;
    const id = onlyNode.id;
    commit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  };

  const patchEdge = (patch: Partial<Edge>) => {
    if (!selectedEdge) return;
    const id = selectedEdge;
    commit((d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  };

  // ── Pointer geometry ──────────────────────────────────────────────────────────

  // Convert a client point into canvas coordinates (undoing the zoom scale).
  const svgPoint = (e: React.PointerEvent | React.MouseEvent) => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  const hitEdge = (p: { x: number; y: number }): string | null => {
    const tol = 8;
    for (const e of doc.edges) {
      const a = doc.nodes.find((n) => n.id === e.from);
      const b = doc.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const pa = edgePoint(a, center(b));
      const pb = edgePoint(b, center(a));
      if (distToSegment(p, pa, pb) <= tol) return e.id;
    }
    return null;
  };

  // ── Node pointer interaction ──────────────────────────────────────────────────

  const onNodePointerDown = (e: React.PointerEvent, n: Node) => {
    e.stopPropagation();
    if (connectMode) {
      if (connectFrom == null) {
        setConnectFrom(n.id);
        setSelected(new Set([n.id]));
        say(t('diagram.stPickTarget'));
      } else if (connectFrom !== n.id) {
        const from = connectFrom;
        commit((d) => {
          if (d.edges.some((x) => x.from === from && x.to === n.id)) return d;
          return {
            ...d,
            edges: [...d.edges, { id: nid(), from, to: n.id, label: '', stroke: '#b8b8c0', strokeWidth: 2, fontSize: 12 }],
          };
        });
        setConnectFrom(null);
        say(t('diagram.stConnected'));
      }
      return;
    }
    setSelectedEdge(null);
    const ctrl = e.ctrlKey || e.metaKey;
    let next: Set<string>;
    if (ctrl) {
      next = new Set(selected);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
    } else {
      next = selected.has(n.id) ? selected : new Set([n.id]);
    }
    setSelected(next);

    const origin: Record<string, { x: number; y: number }> = {};
    for (const nn of doc.nodes) if (next.has(nn.id)) origin[nn.id] = { x: nn.x, y: nn.y };
    past.current.push(doc);
    future.current = [];
    drag.current = { kind: 'move', origin, start: svgPoint(e) };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onHandlePointerDown = (e: React.PointerEvent, id: string, handle: number) => {
    e.stopPropagation();
    past.current.push(doc);
    future.current = [];
    drag.current = { kind: 'resize', id, handle, start: svgPoint(e) };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (connectMode) return;
    setSelected(new Set());
    setSelectedEdge(null);
    setConnectFrom(null);
    const p = svgPoint(e);
    const edge = hitEdge(p);
    if (edge) {
      setSelectedEdge(edge);
      return;
    }
    drag.current = { kind: 'marquee', start: p, cur: p };
    setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const st = drag.current;
      if (!st) return;
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const p = { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };

      if (st.kind === 'move') {
        const dx = p.x - st.start.x;
        const dy = p.y - st.start.y;
        setDoc((d) => ({
          ...d,
          nodes: d.nodes.map((n) => {
            const o = st.origin[n.id];
            if (!o) return n;
            return { ...n, x: Math.max(0, snapV(o.x + dx)), y: Math.max(0, snapV(o.y + dy)) };
          }),
        }));
      } else if (st.kind === 'resize') {
        setDoc((d) => ({
          ...d,
          nodes: d.nodes.map((n) => {
            if (n.id !== st.id) return n;
            let nx = n.x;
            let ny = n.y;
            let nr = n.x + n.w;
            let nb = n.y + n.h;
            const sx = snapV(p.x);
            const sy = snapV(p.y);
            if (st.handle === 0) {
              nx = sx;
              ny = sy;
            } else if (st.handle === 1) {
              nr = sx;
              ny = sy;
            } else if (st.handle === 2) {
              nx = sx;
              nb = sy;
            } else {
              nr = sx;
              nb = sy;
            }
            const x = Math.min(nx, nr);
            const y = Math.min(ny, nb);
            const w = Math.max(24, Math.abs(nr - nx));
            const h = Math.max(24, Math.abs(nb - ny));
            return { ...n, x, y, w, h };
          }),
        }));
      } else if (st.kind === 'marquee') {
        st.cur = p;
        setMarquee({
          x: Math.min(st.start.x, p.x),
          y: Math.min(st.start.y, p.y),
          w: Math.abs(p.x - st.start.x),
          h: Math.abs(p.y - st.start.y),
        });
      }
    },
    [zoom, snapV, setDoc],
  );

  const onPointerUp = () => {
    const st = drag.current;
    if (st?.kind === 'marquee') {
      const box = {
        x: Math.min(st.start.x, st.cur.x),
        y: Math.min(st.start.y, st.cur.y),
        w: Math.abs(st.cur.x - st.start.x),
        h: Math.abs(st.cur.y - st.start.y),
      };
      if (box.w > 3 || box.h > 3) {
        const hit = new Set<string>();
        for (const n of doc.nodes) if (rectsIntersect(box, { x: n.x, y: n.y, w: n.w, h: n.h })) hit.add(n.id);
        setSelected(hit);
      }
      setMarquee(null);
    } else if (st?.kind === 'move') {
      // If nothing actually moved, drop the speculative history entry we pushed on down.
      const moved = doc.nodes.some((n) => {
        const o = st.origin[n.id];
        return o && (o.x !== n.x || o.y !== n.y);
      });
      if (!moved) past.current.pop();
    } else if (st?.kind === 'resize') {
      const n = doc.nodes.find((x) => x.id === st.id);
      // A no-op resize also discards its history entry (best-effort).
      if (!n) past.current.pop();
    }
    drag.current = null;
    setHistTick((x) => x + 1);
  };

  const toggleConnect = () => {
    setConnectMode((m) => {
      const next = !m;
      setConnectFrom(null);
      say(next ? t('diagram.stConnectOn') : t('diagram.stConnectOff'));
      return next;
    });
  };

  // ── Zoom ──────────────────────────────────────────────────────────────────────

  const setZoomClamped = (z: number) => setZoom(Math.min(4, Math.max(0.25, Math.round(z * 100) / 100)));
  const zoomIn = () => setZoomClamped(zoom + 0.1);
  const zoomOut = () => setZoomClamped(zoom - 0.1);
  const zoomReset = () => setZoom(1);

  // ── File: save / open / export ────────────────────────────────────────────────

  const serialize = () =>
    JSON.stringify(
      {
        version: doc.version,
        app: doc.app,
        canvasWidth: doc.canvasWidth,
        canvasHeight: doc.canvasHeight,
        nodes: doc.nodes,
        edges: doc.edges,
      },
      null,
      2,
    );

  const save = () => {
    const blob = new Blob([serialize()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diagram${FILE_EXT}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    say(t('diagram.stSaved'));
  };

  const openFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const p = coerceDoc(JSON.parse(txt));
        if (p) {
          past.current.push(doc);
          future.current = [];
          setDocState(p);
          setSelected(new Set());
          setSelectedEdge(null);
          setHistTick((n) => n + 1);
          say(t('diagram.stOpened'));
        } else {
          say(t('diagram.stBadFile'));
        }
      } catch {
        say(t('diagram.stBadFile'));
      }
    });
    e.target.value = '';
  };

  // Serialize the current diagram (de-selected, at 1:1) to a standalone SVG string.
  const buildSvgString = (): string => {
    const w = Math.max(...doc.nodes.map((n) => n.x + n.w), 100) + 40;
    const h = Math.max(...doc.nodes.map((n) => n.y + n.h), 100) + 40;
    const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    );
    parts.push('<rect width="100%" height="100%" fill="#1b1b1f"/>');
    parts.push(
      '<defs><marker id="wf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L9,3 L0,6 Z" fill="#b8b8c0"/></marker></defs>',
    );
    for (const e of doc.edges) {
      const a = doc.nodes.find((n) => n.id === e.from);
      const b = doc.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const pa = edgePoint(a, center(b));
      const pb = edgePoint(b, center(a));
      parts.push(
        `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" marker-end="url(#wf-arrow)"/>`,
      );
      if (e.label) {
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        parts.push(
          `<text x="${mx}" y="${my}" text-anchor="middle" fill="${e.stroke}" font-size="${e.fontSize}">${esc(e.label)}</text>`,
        );
      }
    }
    for (const n of doc.nodes) {
      const st = `fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"`;
      if (n.kind === 'ellipse') {
        parts.push(`<ellipse cx="${n.x + n.w / 2}" cy="${n.y + n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}" ${st}/>`);
      } else if (n.kind === 'diamond') {
        parts.push(
          `<polygon points="${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}" ${st}/>`,
        );
      } else if (n.kind !== 'text') {
        const rx = n.kind === 'rounded' ? 14 : 0;
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" ${st}/>`);
      }
      if (n.label) {
        parts.push(
          `<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2}" text-anchor="middle" dominant-baseline="middle" fill="${n.textColor}" font-size="${n.fontSize}">${esc(n.label)}</text>`,
        );
      }
    }
    parts.push('</svg>');
    return parts.join('');
  };

  const exportSvg = () => {
    const blob = new Blob([buildSvgString()], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(a.href);
    say(t('diagram.stExportedSvg'));
  };

  const exportPng = () => {
    const svgStr = buildSvgString();
    const wm = /width="(\d+)"/.exec(svgStr);
    const hm = /height="(\d+)"/.exec(svgStr);
    const w = wm ? parseInt(wm[1]!, 10) : 900;
    const h = hm ? parseInt(hm[1]!, 10) : 520;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'diagram.png';
      a.click();
      say(t('diagram.stExportedPng'));
    };
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgStr)))}`;
  };

  // ── Keyboard: delete / undo / redo ────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      del();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicate();
    }
  };

  // ── Rendering helpers ─────────────────────────────────────────────────────────

  const shapeEl = (n: Node) => {
    const isSel = selected.has(n.id);
    const st = { fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth };
    switch (n.kind) {
      case 'ellipse':
        return <ellipse cx={n.x + n.w / 2} cy={n.y + n.h / 2} rx={n.w / 2} ry={n.h / 2} {...st} />;
      case 'diamond':
        return (
          <polygon
            points={`${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}`}
            {...st}
          />
        );
      case 'text':
        return (
          <rect
            x={n.x}
            y={n.y}
            width={n.w}
            height={n.h}
            fill="transparent"
            stroke={isSel ? '#4cc2ff' : 'transparent'}
            strokeWidth={1.5}
            rx={4}
          />
        );
      case 'rounded':
        return <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={14} {...st} />;
      default:
        return <rect x={n.x} y={n.y} width={n.w} height={n.h} {...st} />;
    }
  };

  const nodeById = (id: string) => doc.nodes.find((n) => n.id === id);
  const zoomPct = `${Math.round(zoom * 100)}%`;
  const gridId = 'wf-diagram-grid';
  // histTick is bumped on every history change so these recompute each render.
  void histTick;
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  const swatch = (value: string, onChange: (hex: string) => void, label: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ minWidth: 76, color: 'var(--text-secondary)' }}>{label}</span>
      <input
        type="color"
        value={value.length === 9 ? `#${value.slice(3)}` : value.slice(0, 7)}
        onChange={(ev) => onChange(ev.target.value)}
        style={{ width: 40, height: 26, padding: 0, border: '1px solid var(--stroke)', borderRadius: 4, background: 'none' }}
      />
      <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{value}</span>
    </label>
  );

  return (
    <div className="mod" onKeyDown={onKeyDown} tabIndex={0} style={{ outline: 'none' }}>
      {/* File + edit toolbar */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={newDoc}>{t('diagram.new')}</button>
        <label className="mini" style={{ cursor: 'pointer' }}>
          {t('diagram.open')}
          <input ref={fileInput} type="file" accept=".json,.wfdiagram" onChange={openFile} style={{ display: 'none' }} />
        </label>
        <button className="mini" onClick={save}>{t('diagram.save')}</button>
        <button className="mini" onClick={exportPng}>{t('diagram.exportPng')}</button>
        <button className="mini" onClick={exportSvg}>{t('diagram.exportSvg')}</button>
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--stroke)', margin: '0 4px' }} />
        <button className="mini" onClick={duplicate} disabled={selected.size === 0}>{t('diagram.duplicate')}</button>
        <button className="mini" onClick={del} disabled={selected.size === 0 && !selectedEdge}>{t('diagram.delete')}</button>
        <button className="mini" onClick={bringFront} disabled={selected.size === 0}>{t('diagram.front')}</button>
        <button className="mini" onClick={sendBack} disabled={selected.size === 0}>{t('diagram.back')}</button>
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--stroke)', margin: '0 4px' }} />
        <button className="mini" onClick={undo} disabled={!canUndo}>{t('diagram.undo')}</button>
        <button className="mini" onClick={redo} disabled={!canRedo}>{t('diagram.redo')}</button>
      </div>

      {/* Palette + view toolbar */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => addNode('rect')}>▭ {t('diagram.rect')}</button>
        <button className="mini" onClick={() => addNode('rounded')}>▢ {t('diagram.rounded')}</button>
        <button className="mini" onClick={() => addNode('ellipse')}>◯ {t('diagram.ellipse')}</button>
        <button className="mini" onClick={() => addNode('diamond')}>◇ {t('diagram.diamond')}</button>
        <button className="mini" onClick={() => addNode('text')}>T {t('diagram.text')}</button>
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--stroke)', margin: '0 4px' }} />
        <button className={`mini${connectMode ? ' primary' : ''}`} onClick={toggleConnect}>
          → {connectMode ? t('diagram.connecting') : t('diagram.connect')}
        </button>
        <button className={`mini${snap ? ' primary' : ''}`} onClick={() => setSnap((s) => !s)}>{t('diagram.snap')}</button>
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--stroke)', margin: '0 4px' }} />
        <button className="mini" onClick={zoomOut} title={t('diagram.zoomOut')}>−</button>
        <span className="count-note" style={{ margin: 0, minWidth: 44, textAlign: 'center' }}>{zoomPct}</span>
        <button className="mini" onClick={zoomIn} title={t('diagram.zoomIn')}>+</button>
        <button className="mini" onClick={zoomReset}>{t('diagram.zoomReset')}</button>
      </div>

      <p className="count-note">{t('diagram.hint')}</p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* Canvas surface (scroll/pan container) */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 560,
            overflow: 'auto',
            border: '1px solid var(--stroke)',
            borderRadius: 'var(--radius)',
            background: 'var(--bg-elevated)',
          }}
        >
          <svg
            ref={svgRef}
            width={CANVAS_W * zoom}
            height={CANVAS_H * zoom}
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
            style={{ display: 'block', touchAction: 'none', cursor: connectMode ? 'crosshair' : 'default' }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <defs>
              <marker id="wf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L9,3 L0,6 Z" fill="#b8b8c0" />
              </marker>
              <pattern id={gridId} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              </pattern>
            </defs>
            {snap && <rect x={0} y={0} width={CANVAS_W} height={CANVAS_H} fill={`url(#${gridId})`} />}

            {/* Edges (drawn under nodes) */}
            {doc.edges.map((e) => {
              const a = nodeById(e.from);
              const b = nodeById(e.to);
              if (!a || !b) return null;
              const pa = edgePoint(a, center(b));
              const pb = edgePoint(b, center(a));
              const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
              const isSel = selectedEdge === e.id;
              return (
                <g key={e.id}>
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke={isSel ? '#4cc2ff' : e.stroke}
                    strokeWidth={e.strokeWidth + (isSel ? 1 : 0)}
                    markerEnd="url(#wf-arrow)"
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      setSelected(new Set());
                      setSelectedEdge(e.id);
                    }}
                    onDoubleClick={(ev) => {
                      ev.stopPropagation();
                      renameEdge(e.id);
                    }}
                  />
                  {e.label && (
                    <text
                      x={mid.x}
                      y={mid.y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={e.stroke}
                      fontSize={e.fontSize}
                      pointerEvents="none"
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {doc.nodes.map((n) => (
              <g
                key={n.id}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  renameNode(n.id);
                }}
                style={{ cursor: connectMode ? 'crosshair' : 'move' }}
              >
                {shapeEl(n)}
                <text
                  x={n.x + n.w / 2}
                  y={n.y + n.h / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={n.textColor.length === 9 ? `#${n.textColor.slice(3)}` : n.textColor}
                  fontSize={n.fontSize}
                  pointerEvents="none"
                >
                  {n.label}
                </text>
              </g>
            ))}

            {/* Selection outlines + resize handles */}
            {doc.nodes
              .filter((n) => selected.has(n.id))
              .map((n) => (
                <g key={`sel-${n.id}`} pointerEvents="none">
                  <rect
                    x={n.x - 3}
                    y={n.y - 3}
                    width={n.w + 6}
                    height={n.h + 6}
                    fill="none"
                    stroke="#0078d7"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                  />
                  {selected.size === 1 &&
                    ([
                      [n.x, n.y, 0],
                      [n.x + n.w, n.y, 1],
                      [n.x, n.y + n.h, 2],
                      [n.x + n.w, n.y + n.h, 3],
                    ] as [number, number, number][]).map(([hx, hy, idx]) => (
                      <rect
                        key={idx}
                        x={hx - HANDLE / 2}
                        y={hy - HANDLE / 2}
                        width={HANDLE}
                        height={HANDLE}
                        fill="#ffffff"
                        stroke="#0078d7"
                        strokeWidth={1.5}
                        pointerEvents="all"
                        style={{ cursor: 'nwse-resize' }}
                        onPointerDown={(e) => onHandlePointerDown(e, n.id, idx)}
                      />
                    ))}
                </g>
              ))}

            {/* Marquee */}
            {marquee && (
              <rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                fill="rgba(0,120,215,0.16)"
                stroke="#0078d7"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
          </svg>
        </div>

        {/* Properties panel */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            border: '1px solid var(--stroke)',
            borderRadius: 'var(--radius)',
            background: 'var(--bg-elevated)',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('diagram.propsHeader')}</div>

          {onlyNode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('diagram.propLabel')}</span>
                <input
                  className="mod-search"
                  value={onlyNode.label}
                  onChange={(e) => patchNode({ label: e.target.value })}
                />
              </label>
              {onlyNode.kind !== 'text' && swatch(onlyNode.fill, (fill) => patchNode({ fill }), t('diagram.propFill'))}
              {onlyNode.kind !== 'text' && swatch(onlyNode.stroke, (stroke) => patchNode({ stroke }), t('diagram.propStroke'))}
              {onlyNode.kind !== 'text' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ minWidth: 76, color: 'var(--text-secondary)' }}>{t('diagram.propStrokeWidth')}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={onlyNode.strokeWidth}
                    onChange={(e) => patchNode({ strokeWidth: num(e.target.value, onlyNode.strokeWidth) })}
                    style={{ width: 64 }}
                  />
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ minWidth: 76, color: 'var(--text-secondary)' }}>{t('diagram.propFontSize')}</span>
                <input
                  type="number"
                  min={6}
                  max={96}
                  value={onlyNode.fontSize}
                  onChange={(e) => patchNode({ fontSize: Math.max(6, num(e.target.value, onlyNode.fontSize)) })}
                  style={{ width: 64 }}
                />
              </label>
              {swatch(onlyNode.textColor, (textColor) => patchNode({ textColor }), t('diagram.propTextColor'))}
              <div className="count-note" style={{ margin: 0 }}>{t(`diagram.kind_${onlyNode.kind}`)}</div>
            </div>
          ) : selectedEdge ? (
            (() => {
              const e = doc.edges.find((x) => x.id === selectedEdge);
              if (!e) return null;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="count-note" style={{ margin: 0 }}>{t('diagram.edgeSelected')}</div>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('diagram.propLabel')}</span>
                    <input className="mod-search" value={e.label} onChange={(ev) => patchEdge({ label: ev.target.value })} />
                  </label>
                  {swatch(e.stroke, (stroke) => patchEdge({ stroke }), t('diagram.propStroke'))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ minWidth: 76, color: 'var(--text-secondary)' }}>{t('diagram.propStrokeWidth')}</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={e.strokeWidth}
                      onChange={(ev) => patchEdge({ strokeWidth: num(ev.target.value, e.strokeWidth) })}
                      style={{ width: 64 }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ minWidth: 76, color: 'var(--text-secondary)' }}>{t('diagram.propFontSize')}</span>
                    <input
                      type="number"
                      min={6}
                      max={48}
                      value={e.fontSize}
                      onChange={(ev) => patchEdge({ fontSize: Math.max(6, num(ev.target.value, e.fontSize)) })}
                      style={{ width: 64 }}
                    />
                  </label>
                </div>
              );
            })()
          ) : (
            <p className="count-note" style={{ margin: 0 }}>
              {selected.size > 1 ? t('diagram.multiSelected', { count: selected.size }) : t('diagram.propsEmpty')}
            </p>
          )}
        </div>
      </div>

      {status && <p className="count-note" style={{ color: 'var(--text)' }}>{status}</p>}
      <p className="count-note">{t('diagram.counts', { nodes: doc.nodes.length, edges: doc.edges.length })}</p>
    </div>
  );
}
