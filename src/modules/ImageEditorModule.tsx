import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { pick } from '../i18n';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ═══════════════════════════════════════════════════════════════════════════
// WinForge · Image Editor — full in-app raster (photo) editor.
// Ported & upgraded from WinForge/Pages/ImageEditorModule.xaml(.cs). The C#
// page is a Paint.NET / GIMP-style editor built on SixLabors.ImageSharp: open
// PNG/JPG/BMP/GIF/WebP; zoom & pan; live brightness/contrast/saturation/hue/
// gamma; grayscale/invert/sepia/blur/sharpen/edge filters; crop/resize/rotate/
// flip; brush/fill/eraser/eyedropper/text paint tools; a simple multi-layer
// model with opacity + show/hide; undo/redo; Save / Save As (PNG/JPG/GIF/WebP
// with quality). The web platform is the natural home for this: every pixel op
// runs on an HTML5 <canvas> in-process — no Paint.NET, GIMP or external tool.
// Only writing the finished file to disk is gated (SaveFileDialog on the
// desktop app; a browser download otherwise). The original disk "Library"
// scanner is preserved as a second tab.
// ═══════════════════════════════════════════════════════════════════════════

// ── constants ──────────────────────────────────────────────────────────────
type Tool = 'move' | 'brush' | 'eraser' | 'fill' | 'eyedropper' | 'text' | 'crop';
const TOOLS: { id: Tool; glyph: string; en: string; zh: string; key: string }[] = [
  { id: 'move', glyph: '✥', en: 'Move / pan', zh: '移動／平移', key: 'V' },
  { id: 'brush', glyph: '🖌', en: 'Brush', zh: '筆刷', key: 'B' },
  { id: 'eraser', glyph: '🧽', en: 'Eraser', zh: '橡皮', key: 'E' },
  { id: 'fill', glyph: '🪣', en: 'Bucket fill', zh: '油桶填色', key: 'G' },
  { id: 'eyedropper', glyph: '💧', en: 'Eyedropper', zh: '吸色', key: 'I' },
  { id: 'text', glyph: 'T', en: 'Text', zh: '文字', key: 'T' },
  { id: 'crop', glyph: '⛶', en: 'Crop (drag a rectangle)', zh: '裁切（拖矩形）', key: 'C' },
];

type FilterKind = 'grayscale' | 'invert' | 'sepia' | 'blur' | 'sharpen' | 'edge';

const EXPORT_FORMATS: { ext: string; mime: string; quality: boolean; en: string; zh: string }[] = [
  { ext: 'png', mime: 'image/png', quality: false, en: 'PNG (lossless)', zh: 'PNG（無損）' },
  { ext: 'jpg', mime: 'image/jpeg', quality: true, en: 'JPEG', zh: 'JPEG' },
  { ext: 'webp', mime: 'image/webp', quality: true, en: 'WebP', zh: 'WebP' },
  { ext: 'bmp', mime: 'image/bmp', quality: false, en: 'Bitmap (BMP)', zh: '點陣圖（BMP）' },
  { ext: 'gif', mime: 'image/gif', quality: false, en: 'GIF', zh: 'GIF' },
];

const card: CSSProperties = {
  background: 'var(--card, rgba(127,127,127,0.06))',
  border: '1px solid var(--border, rgba(127,127,127,0.22))',
  borderRadius: 8,
  padding: '12px 14px',
  marginTop: 12,
};

// ── helpers ─────────────────────────────────────────────────────────────────
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fmtSize(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── layer model (each layer is its own offscreen canvas) ─────────────────────
interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  canvas: HTMLCanvasElement;
}

interface Doc {
  width: number;
  height: number;
  layers: Layer[];
  active: number;
  fileName: string;
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = newCanvas(src.width, src.height);
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

function blankDoc(w: number, h: number, white: boolean, name: string): Doc {
  const c = newCanvas(w, h);
  if (white) {
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
  }
  return {
    width: w,
    height: h,
    fileName: name,
    active: 0,
    layers: [{ id: `l${Date.now()}`, name: 'Background', visible: true, opacity: 1, canvas: c }],
  };
}

let layerSeq = 1;

// ── pixel-op filters (operate in place on an ImageData) ──────────────────────
function applyKernel(src: ImageData, kernel: number[], divisor: number, bias: number): ImageData {
  const { width: w, height: h, data } = src;
  const out = new ImageData(w, h);
  const od = out.data;
  const side = Math.round(Math.sqrt(kernel.length));
  const half = Math.floor(side / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < side; ky++) {
        for (let kx = 0; kx < side; kx++) {
          const px = Math.min(w - 1, Math.max(0, x + kx - half));
          const py = Math.min(h - 1, Math.max(0, y + ky - half));
          const wt = kernel[ky * side + kx] ?? 0;
          const idx = (py * w + px) * 4;
          r += (data[idx] ?? 0) * wt;
          g += (data[idx + 1] ?? 0) * wt;
          b += (data[idx + 2] ?? 0) * wt;
        }
      }
      const o = (y * w + x) * 4;
      od[o] = Math.min(255, Math.max(0, r / divisor + bias));
      od[o + 1] = Math.min(255, Math.max(0, g / divisor + bias));
      od[o + 2] = Math.min(255, Math.max(0, b / divisor + bias));
      od[o + 3] = data[o + 3] ?? 255;
    }
  }
  return out;
}

function gaussianKernel(radius: number): { kernel: number[]; divisor: number } {
  const r = Math.max(1, Math.round(radius));
  const sigma = r / 2;
  const kernel: number[] = [];
  let sum = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const v = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      kernel.push(v);
      sum += v;
    }
  }
  return { kernel, divisor: sum };
}

function runFilter(g: CanvasRenderingContext2D, w: number, h: number, kind: FilterKind, amount: number): void {
  const src = g.getImageData(0, 0, w, h);
  const d = src.data;
  if (kind === 'grayscale') {
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(src, 0, 0);
    return;
  }
  if (kind === 'invert') {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - (d[i] ?? 0);
      d[i + 1] = 255 - (d[i + 1] ?? 0);
      d[i + 2] = 255 - (d[i + 2] ?? 0);
    }
    g.putImageData(src, 0, 0);
    return;
  }
  if (kind === 'sepia') {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] ?? 0, gg = d[i + 1] ?? 0, b = d[i + 2] ?? 0;
      d[i] = Math.min(255, 0.393 * r + 0.769 * gg + 0.189 * b);
      d[i + 1] = Math.min(255, 0.349 * r + 0.686 * gg + 0.168 * b);
      d[i + 2] = Math.min(255, 0.272 * r + 0.534 * gg + 0.131 * b);
    }
    g.putImageData(src, 0, 0);
    return;
  }
  if (kind === 'blur') {
    const { kernel, divisor } = gaussianKernel(amount);
    g.putImageData(applyKernel(src, kernel, divisor, 0), 0, 0);
    return;
  }
  if (kind === 'sharpen') {
    const a = Math.max(0.2, amount / 4);
    const c = 1 + 4 * a;
    g.putImageData(applyKernel(src, [0, -a, 0, -a, c, -a, 0, -a, 0], 1, 0), 0, 0);
    return;
  }
  if (kind === 'edge') {
    g.putImageData(applyKernel(src, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 1, 0), 0, 0);
    return;
  }
}

// Flood-fill (4-connected) on an ImageData at (sx,sy) with an rgba fill.
function floodFill(g: CanvasRenderingContext2D, w: number, h: number, sx: number, sy: number, fill: [number, number, number, number]): void {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const s = at(sx, sy);
  const target = [d[s] ?? 0, d[s + 1] ?? 0, d[s + 2] ?? 0, d[s + 3] ?? 0];
  const [fr, fg, fb, fa] = fill;
  if (target[0] === fr && target[1] === fg && target[2] === fb && target[3] === fa) return;
  const tol = 20;
  const match = (i: number) =>
    Math.abs((d[i] ?? 0) - (target[0] ?? 0)) <= tol &&
    Math.abs((d[i + 1] ?? 0) - (target[1] ?? 0)) <= tol &&
    Math.abs((d[i + 2] ?? 0) - (target[2] ?? 0)) <= tol &&
    Math.abs((d[i + 3] ?? 0) - (target[3] ?? 0)) <= tol;
  const stack = [[sx, sy]];
  while (stack.length) {
    const popped = stack.pop()!;
    const x = popped[0]!, y = popped[1]!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = at(x, y);
    if (!match(i)) continue;
    d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = fa;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  g.putImageData(img, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
export function ImageEditorModule() {
  const { t, i18n } = useTranslation();
  const P = useCallback((en: string, zh: string) => pick(en, zh, i18n.language), [i18n.language]);
  const live = isTauri();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('imageeditor.blurb2')}</p>
      {!live && <p className="count-note" style={{ marginTop: 0 }}>{t('imageeditor.previewNote')}</p>}
      <ModuleTabs
        tabs={[
          { id: 'editor', en: 'Editor', zh: '編輯器', render: () => <Editor P={P} live={live} /> },
          { id: 'library', en: 'Library', zh: '圖庫', render: () => <Library /> },
        ]}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The full in-canvas editor.
function Editor({ P, live }: { P: (en: string, zh: string) => string; live: boolean }) {
  const { t } = useTranslation();

  const [doc, setDoc] = useState<Doc>(() => blankDoc(800, 600, true, 'image'));
  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState('#1e1e1e');
  const [brush, setBrush] = useState(6);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [, forceTick] = useState(0);
  const rerender = useCallback(() => forceTick((n) => n + 1), []);

  // live adjustments (0-neutral)
  const [adj, setAdj] = useState({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 });
  const adjNeutral = adj.brightness === 0 && adj.contrast === 0 && adj.saturation === 0 && adj.hue === 0 && adj.gamma === 100;

  // transform inputs
  const [rotDeg, setRotDeg] = useState(0);
  const [resizeW, setResizeW] = useState(800);
  const [resizeH, setResizeH] = useState(600);
  const [lockAspect, setLockAspect] = useState(true);
  const [blurAmt, setBlurAmt] = useState(4);
  const [exportFmt, setExportFmt] = useState('png');
  const [quality, setQuality] = useState(90);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // undo / redo — snapshots of the whole layer stack
  const undoRef = useRef<Doc[]>([]);
  const redoRef = useRef<Doc[]>([]);
  const [histLen, setHistLen] = useState(0);

  // crop rect (image px)
  const cropRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [hasCrop, setHasCrop] = useState(false);
  const drawState = useRef<{ drawing: boolean; lastX: number; lastY: number }>({ drawing: false, lastX: -1, lastY: -1 });

  const activeLayer = doc.layers[doc.active] ?? doc.layers[0]!;

  const snapshotDoc = useCallback((d: Doc): Doc => ({
    ...d,
    layers: d.layers.map((l) => ({ ...l, canvas: cloneCanvas(l.canvas) })),
  }), []);

  const pushUndo = useCallback(() => {
    undoRef.current.push(snapshotDoc(doc));
    if (undoRef.current.length > 30) undoRef.current.shift();
    redoRef.current = [];
    setHistLen(undoRef.current.length);
  }, [doc, snapshotDoc]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(snapshotDoc(doc));
    setDoc(prev);
    setHistLen(undoRef.current.length);
    setHasCrop(false);
    cropRef.current = null;
    setStatus({ ok: true, text: P('Undone.', '已復原。') });
  }, [P, doc, snapshotDoc]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(snapshotDoc(doc));
    setDoc(next);
    setHistLen(undoRef.current.length);
    setStatus({ ok: true, text: P('Redone.', '已重做。') });
  }, [P, doc, snapshotDoc]);

  // ── build the checkerboard once per size ────────────────────────────────
  const checker = useMemo(() => {
    const c = newCanvas(doc.width, doc.height);
    const g = c.getContext('2d')!;
    const cell = 16;
    for (let y = 0; y < doc.height; y += cell) {
      for (let x = 0; x < doc.width; x += cell) {
        const dark = ((x / cell) + (y / cell)) % 2 === 0;
        g.fillStyle = dark ? '#c8c8c8' : '#e6e6e6';
        g.fillRect(x, y, cell, cell);
      }
    }
    return c;
  }, [doc.width, doc.height]);

  // CSS filter string for the live adjustment preview (non-destructive).
  const adjFilter = useMemo(() => {
    if (adjNeutral) return 'none';
    const parts: string[] = [];
    parts.push(`brightness(${1 + adj.brightness / 100})`);
    parts.push(`contrast(${1 + adj.contrast / 100})`);
    parts.push(`saturate(${1 + adj.saturation / 100})`);
    if (adj.hue !== 0) parts.push(`hue-rotate(${adj.hue}deg)`);
    return parts.join(' ');
  }, [adj, adjNeutral]);

  // ── composite render to the visible canvas ───────────────────────────────
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== doc.width || cv.height !== doc.height) {
      cv.width = doc.width;
      cv.height = doc.height;
    }
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, doc.width, doc.height);
    g.drawImage(checker, 0, 0);
    for (const l of doc.layers) {
      if (!l.visible) continue;
      g.globalAlpha = l.opacity;
      g.drawImage(l.canvas, 0, 0);
    }
    g.globalAlpha = 1;
    // gamma is baked at apply time; for preview we approximate with brightness only.
  }, [checker, doc]);

  useEffect(() => { redraw(); }, [redraw]);

  // Keep the visible canvas' CSS filter in sync for the live preview.
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv) cv.style.filter = adjFilter;
  }, [adjFilter]);

  // ── coordinate mapping ───────────────────────────────────────────────────
  const toPixel = useCallback((clientX: number, clientY: number, clamp: boolean): { x: number; y: number; inside: boolean } => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0, inside: false };
    const rect = cv.getBoundingClientRect();
    let x = Math.floor(((clientX - rect.left) / rect.width) * doc.width);
    let y = Math.floor(((clientY - rect.top) / rect.height) * doc.height);
    const inside = x >= 0 && y >= 0 && x < doc.width && y < doc.height;
    if (clamp) {
      x = Math.min(doc.width - 1, Math.max(0, x));
      y = Math.min(doc.height - 1, Math.max(0, y));
    }
    return { x, y, inside };
  }, [doc.width, doc.height]);

  const strokeSegment = useCallback((x0: number, y0: number, x1: number, y1: number, erase: boolean) => {
    const g = activeLayer.canvas.getContext('2d')!;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = brush;
    if (erase) {
      g.globalCompositeOperation = 'destination-out';
      g.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = color;
    }
    g.beginPath();
    g.moveTo(x0 + 0.5, y0 + 0.5);
    g.lineTo(x1 + 0.5, y1 + 0.5);
    g.stroke();
    g.restore();
    redraw();
  }, [activeLayer, brush, color, redraw]);

  // ── pointer handlers ─────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const { x, y, inside } = toPixel(e.clientX, e.clientY, false);
    if (!inside && tool !== 'crop') return;
    (e.target as Element).setPointerCapture(e.pointerId);

    if (tool === 'eyedropper') {
      const g = canvasRef.current!.getContext('2d')!;
      const px = g.getImageData(x, y, 1, 1).data;
      const hex = `#${[px[0], px[1], px[2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
      setColor(hex);
      return;
    }
    if (tool === 'fill') {
      pushUndo();
      const g = activeLayer.canvas.getContext('2d')!;
      const [r, gg, b] = hexToRgb(color);
      floodFill(g, doc.width, doc.height, x, y, [r, gg, b, 255]);
      redraw();
      return;
    }
    if (tool === 'text') {
      const txt = window.prompt(P('Enter text', '輸入文字'), '');
      if (!txt) return;
      const sizeStr = window.prompt(P('Font size (px)', '字型大小（px）'), '36') ?? '36';
      const size = Math.max(4, parseInt(sizeStr, 10) || 36);
      pushUndo();
      const g = activeLayer.canvas.getContext('2d')!;
      g.save();
      g.fillStyle = color;
      g.font = `${size}px "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = 'top';
      txt.split('\n').forEach((line, i) => g.fillText(line, x, y + i * size * 1.2));
      g.restore();
      redraw();
      return;
    }
    if (tool === 'crop') {
      const cp = toPixel(e.clientX, e.clientY, true);
      cropRef.current = { x0: cp.x, y0: cp.y, x1: cp.x, y1: cp.y };
      setHasCrop(true);
      drawState.current.drawing = true;
      rerender();
      return;
    }
    if (tool === 'brush' || tool === 'eraser') {
      pushUndo();
      drawState.current = { drawing: true, lastX: x, lastY: y };
      strokeSegment(x, y, x, y, tool === 'eraser');
    }
  }, [tool, toPixel, color, activeLayer, doc.width, doc.height, pushUndo, redraw, strokeSegment, P, rerender]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawState.current.drawing) return;
    const { x, y } = toPixel(e.clientX, e.clientY, true);
    if (tool === 'crop' && cropRef.current) {
      cropRef.current = { ...cropRef.current, x1: x, y1: y };
      rerender();
      return;
    }
    if (tool === 'brush' || tool === 'eraser') {
      if (x === drawState.current.lastX && y === drawState.current.lastY) return;
      strokeSegment(drawState.current.lastX, drawState.current.lastY, x, y, tool === 'eraser');
      drawState.current.lastX = x;
      drawState.current.lastY = y;
    }
  }, [tool, toPixel, strokeSegment, rerender]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drawState.current.drawing = false;
  }, []);

  // ── mutate the active layer with an undo push ────────────────────────────
  const mutateActive = useCallback((fn: (g: CanvasRenderingContext2D) => void, msg: [string, string]) => {
    pushUndo();
    const g = activeLayer.canvas.getContext('2d')!;
    fn(g);
    redraw();
    setStatus({ ok: true, text: P(msg[0], msg[1]) });
  }, [activeLayer, pushUndo, redraw, P]);

  // ── filters ──────────────────────────────────────────────────────────────
  const applyFilterKind = useCallback((kind: FilterKind) => {
    mutateActive((g) => runFilter(g, doc.width, doc.height, kind, blurAmt),
      [`Applied ${kind}.`, '已套用濾鏡。']);
  }, [mutateActive, doc.width, doc.height, blurAmt]);

  // ── commit live adjustments destructively into the active layer ──────────
  const applyAdjustments = useCallback(() => {
    if (adjNeutral) return;
    pushUndo();
    const g = activeLayer.canvas.getContext('2d')!;
    const img = g.getImageData(0, 0, doc.width, doc.height);
    const d = img.data;
    const b = adj.brightness * 2.55; // -255..255
    const cFactor = (259 * (adj.contrast + 255)) / (255 * (259 - adj.contrast));
    const gammaInv = 1 / (adj.gamma / 100);
    const sat = 1 + adj.saturation / 100;
    const hueRad = (adj.hue * Math.PI) / 180;
    const cosH = Math.cos(hueRad), sinH = Math.sin(hueRad);
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] ?? 0, gg = d[i + 1] ?? 0, bl = d[i + 2] ?? 0;
      // brightness
      r += b; gg += b; bl += b;
      // contrast
      r = cFactor * (r - 128) + 128;
      gg = cFactor * (gg - 128) + 128;
      bl = cFactor * (bl - 128) + 128;
      // saturation (luma-preserving)
      const luma = 0.299 * r + 0.587 * gg + 0.114 * bl;
      r = luma + (r - luma) * sat;
      gg = luma + (gg - luma) * sat;
      bl = luma + (bl - luma) * sat;
      // hue rotation (YIQ approximation)
      if (adj.hue !== 0) {
        const y = 0.299 * r + 0.587 * gg + 0.114 * bl;
        const iq_i = 0.596 * r - 0.274 * gg - 0.322 * bl;
        const iq_q = 0.211 * r - 0.523 * gg + 0.312 * bl;
        const ni = iq_i * cosH - iq_q * sinH;
        const nq = iq_i * sinH + iq_q * cosH;
        r = y + 0.956 * ni + 0.621 * nq;
        gg = y - 0.272 * ni - 0.647 * nq;
        bl = y - 1.106 * ni + 1.703 * nq;
      }
      // gamma
      r = 255 * Math.pow(Math.min(1, Math.max(0, r / 255)), gammaInv);
      gg = 255 * Math.pow(Math.min(1, Math.max(0, gg / 255)), gammaInv);
      bl = 255 * Math.pow(Math.min(1, Math.max(0, bl / 255)), gammaInv);
      d[i] = Math.min(255, Math.max(0, r));
      d[i + 1] = Math.min(255, Math.max(0, gg));
      d[i + 2] = Math.min(255, Math.max(0, bl));
    }
    g.putImageData(img, 0, 0);
    setAdj({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 });
    redraw();
    setStatus({ ok: true, text: P('Adjustments applied', '已套用調整') });
  }, [adj, adjNeutral, activeLayer, doc.width, doc.height, pushUndo, redraw, P]);

  const resetAdjustments = useCallback(() => {
    setAdj({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 });
  }, []);

  // ── transforms (rebuild every layer canvas) ──────────────────────────────
  const transformAll = useCallback((fn: (src: HTMLCanvasElement) => HTMLCanvasElement, newW: number, newH: number, msg: [string, string]) => {
    pushUndo();
    setDoc((d) => {
      const layers = d.layers.map((l) => ({ ...l, canvas: fn(l.canvas) }));
      return { ...d, width: newW, height: newH, layers };
    });
    setResizeW(newW);
    setResizeH(newH);
    setHasCrop(false);
    cropRef.current = null;
    setStatus({ ok: true, text: P(msg[0], msg[1]) });
  }, [pushUndo, P]);

  const rotate90 = useCallback((cw: boolean) => {
    transformAll((src) => {
      const c = newCanvas(src.height, src.width);
      const g = c.getContext('2d')!;
      g.translate(c.width / 2, c.height / 2);
      g.rotate((cw ? 90 : -90) * Math.PI / 180);
      g.drawImage(src, -src.width / 2, -src.height / 2);
      return c;
    }, doc.height, doc.width, cw ? ['Rotated 90° CW', '已順時針旋轉 90°'] : ['Rotated 90° CCW', '已逆時針旋轉 90°']);
  }, [transformAll, doc.width, doc.height]);

  const rotateArbitrary = useCallback(() => {
    const deg = rotDeg % 360;
    if (Math.abs(deg) < 0.01) return;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const nw = Math.ceil(doc.width * cos + doc.height * sin);
    const nh = Math.ceil(doc.width * sin + doc.height * cos);
    transformAll((src) => {
      const c = newCanvas(nw, nh);
      const g = c.getContext('2d')!;
      g.translate(nw / 2, nh / 2);
      g.rotate(rad);
      g.drawImage(src, -src.width / 2, -src.height / 2);
      return c;
    }, nw, nh, ['Rotated', '已旋轉']);
  }, [rotDeg, doc.width, doc.height, transformAll]);

  const flip = useCallback((horizontal: boolean) => {
    // flip in place per layer, no size change
    pushUndo();
    for (const l of doc.layers) {
      const src = cloneCanvas(l.canvas);
      const g = l.canvas.getContext('2d')!;
      g.clearRect(0, 0, doc.width, doc.height);
      g.save();
      if (horizontal) { g.translate(doc.width, 0); g.scale(-1, 1); }
      else { g.translate(0, doc.height); g.scale(1, -1); }
      g.drawImage(src, 0, 0);
      g.restore();
    }
    redraw();
    setStatus({ ok: true, text: P(horizontal ? 'Flipped horizontally' : 'Flipped vertically', horizontal ? '已水平翻轉' : '已垂直翻轉') });
  }, [doc.layers, doc.width, doc.height, pushUndo, redraw, P]);

  const applyResize = useCallback(() => {
    const w = Math.max(1, Math.round(resizeW));
    const h = Math.max(1, Math.round(resizeH));
    if (w === doc.width && h === doc.height) return;
    transformAll((src) => {
      const c = newCanvas(w, h);
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h);
      return c;
    }, w, h, [`Resized to ${w}×${h}`, `已縮放至 ${w}×${h}`]);
  }, [resizeW, resizeH, doc.width, doc.height, transformAll]);

  const cropRect = useCallback(() => {
    const c = cropRef.current;
    if (!c) return;
    const xa = Math.min(c.x0, c.x1), xb = Math.max(c.x0, c.x1);
    const ya = Math.min(c.y0, c.y1), yb = Math.max(c.y0, c.y1);
    const w = xb - xa, h = yb - ya;
    if (w < 2 || h < 2) return;
    transformAll((src) => {
      const nc = newCanvas(w, h);
      nc.getContext('2d')!.drawImage(src, xa, ya, w, h, 0, 0, w, h);
      return nc;
    }, w, h, ['Cropped', '已裁切']);
  }, [transformAll]);

  const cropReady = hasCrop && cropRef.current != null &&
    Math.abs(cropRef.current.x1 - cropRef.current.x0) > 1 &&
    Math.abs(cropRef.current.y1 - cropRef.current.y0) > 1;

  // ── resize aspect-lock coupling ──────────────────────────────────────────
  const onResizeW = useCallback((v: number) => {
    setResizeW(v);
    if (lockAspect && doc.width > 0) setResizeH(Math.max(1, Math.round(v * (doc.height / doc.width))));
  }, [lockAspect, doc.width, doc.height]);
  const onResizeH = useCallback((v: number) => {
    setResizeH(v);
    if (lockAspect && doc.height > 0) setResizeW(Math.max(1, Math.round(v * (doc.width / doc.height))));
  }, [lockAspect, doc.width, doc.height]);

  // ── layers ───────────────────────────────────────────────────────────────
  const addLayer = useCallback(() => {
    pushUndo();
    setDoc((d) => {
      const layer: Layer = {
        id: `l${Date.now()}`,
        name: `Layer ${++layerSeq}`,
        visible: true,
        opacity: 1,
        canvas: newCanvas(d.width, d.height),
      };
      const layers = [...d.layers, layer];
      return { ...d, layers, active: layers.length - 1 };
    });
  }, [pushUndo]);

  const deleteLayer = useCallback(() => {
    if (doc.layers.length <= 1) return;
    pushUndo();
    setDoc((d) => {
      const layers = d.layers.filter((_, i) => i !== d.active);
      return { ...d, layers, active: Math.max(0, Math.min(d.active, layers.length - 1)) };
    });
  }, [doc.layers.length, pushUndo]);

  const moveLayer = useCallback((dir: number) => {
    setDoc((d) => {
      const j = d.active + dir;
      if (j < 0 || j >= d.layers.length) return d;
      const layers = [...d.layers];
      const a = layers[d.active]!, b = layers[j]!;
      layers[d.active] = b; layers[j] = a;
      return { ...d, layers, active: j };
    });
  }, []);

  const flattenAll = useCallback(() => {
    if (doc.layers.length <= 1) return;
    pushUndo();
    setDoc((d) => {
      const flat = newCanvas(d.width, d.height);
      const g = flat.getContext('2d')!;
      for (const l of d.layers) {
        if (!l.visible) continue;
        g.globalAlpha = l.opacity;
        g.drawImage(l.canvas, 0, 0);
      }
      g.globalAlpha = 1;
      return { ...d, active: 0, layers: [{ id: `l${Date.now()}`, name: 'Flattened', visible: true, opacity: 1, canvas: flat }] };
    });
    setStatus({ ok: true, text: P('Flattened all layers', '已合併所有圖層') });
  }, [doc.layers.length, doc.width, doc.height, pushUndo, P]);

  const setLayerVisible = useCallback((idx: number, vis: boolean) => {
    setDoc((d) => ({ ...d, layers: d.layers.map((l, i) => (i === idx ? { ...l, visible: vis } : l)) }));
  }, []);
  const setLayerOpacity = useCallback((idx: number, op: number) => {
    setDoc((d) => ({ ...d, layers: d.layers.map((l, i) => (i === idx ? { ...l, opacity: op } : l)) }));
  }, []);
  const setActiveLayer = useCallback((idx: number) => setDoc((d) => ({ ...d, active: idx })), []);

  // ── zoom / fit ───────────────────────────────────────────────────────────
  const fitToView = useCallback(() => {
    const host = canvasRef.current?.parentElement?.parentElement;
    const availW = (host?.clientWidth ?? 700) - 48;
    const availH = 520;
    const z = Math.max(0.05, Math.min(8, Math.min(availW / doc.width, availH / doc.height)));
    setZoom(z);
  }, [doc.width, doc.height]);

  // ── new / open ───────────────────────────────────────────────────────────
  const loadImageFromUrl = useCallback((url: string, name: string) => new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = newCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d')!.drawImage(img, 0, 0);
      undoRef.current = [];
      redoRef.current = [];
      setHistLen(0);
      setDoc({
        width: img.naturalWidth,
        height: img.naturalHeight,
        fileName: name.replace(/\.[^.]+$/, ''),
        active: 0,
        layers: [{ id: `l${Date.now()}`, name: 'Background', visible: true, opacity: 1, canvas: c }],
      });
      setResizeW(img.naturalWidth);
      setResizeH(img.naturalHeight);
      resetAdjustments();
      setHasCrop(false);
      cropRef.current = null;
      setStatus({ ok: true, text: P('Opened {n}', '已開啟 {n}').replace('{n}', name) });
      resolve();
    };
    img.onerror = () => reject(new Error(P('Could not decode the image.', '解碼唔到影像。')));
    img.src = url;
  }), [P, resetAdjustments]);

  const newDoc = useCallback(() => {
    const wStr = window.prompt(P('New width (px)', '新闊度（px）'), '800');
    if (wStr == null) return;
    const hStr = window.prompt(P('New height (px)', '新高度（px）'), '600');
    if (hStr == null) return;
    const w = Math.max(1, Math.min(16384, parseInt(wStr, 10) || 800));
    const h = Math.max(1, Math.min(16384, parseInt(hStr, 10) || 600));
    undoRef.current = [];
    redoRef.current = [];
    setHistLen(0);
    setDoc(blankDoc(w, h, true, 'image'));
    setResizeW(w);
    setResizeH(h);
    resetAdjustments();
    setHasCrop(false);
    cropRef.current = null;
  }, [P, resetAdjustments]);

  const openFile = useCallback(async () => {
    setStatus(null);
    if (!live) {
      fileInputRef.current?.click();
      return;
    }
    setBusy('open');
    try {
      const res = await runPowershell(
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(P('Open image', '開啟影像'))}'; ` +
          `$d.Filter='${psq('Images|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp;*.tif;*.tiff|All files|*.*')}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const path = res.stdout.trim();
      if (!path) { setBusy(''); return; }
      const r = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psq(path)}'))`);
      const b64 = r.stdout.trim();
      if (!b64) throw new Error(P('Could not read file.', '讀唔到檔案。'));
      const ext = (path.split('.').pop() ?? 'png').toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      const name = path.split(/[\\/]/).pop() ?? path;
      await loadImageFromUrl(`data:image/${mime};base64,${b64}`, name);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [live, P, loadImageFromUrl]);

  const onBrowserFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('open');
    try {
      const url = URL.createObjectURL(file);
      await loadImageFromUrl(url, file.name);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setStatus({ ok: false, text: String(err instanceof Error ? err.message : err) });
    } finally {
      setBusy('');
    }
  }, [loadImageFromUrl]);

  // ── flatten for export (respects visibility + opacity + baked look) ──────
  const compositeCanvas = useCallback((): HTMLCanvasElement => {
    const flat = newCanvas(doc.width, doc.height);
    const g = flat.getContext('2d')!;
    for (const l of doc.layers) {
      if (!l.visible) continue;
      g.globalAlpha = l.opacity;
      g.drawImage(l.canvas, 0, 0);
    }
    g.globalAlpha = 1;
    return flat;
  }, [doc]);

  // ── save / export ────────────────────────────────────────────────────────
  const exportImage = useCallback(async () => {
    const fmt = EXPORT_FORMATS.find((f) => f.ext === exportFmt) ?? EXPORT_FORMATS[0]!;
    const flat = compositeCanvas();
    const q = fmt.quality ? quality / 100 : undefined;
    const baseName = doc.fileName || 'image';
    setBusy('export');
    setStatus(null);
    try {
      const blob = await new Promise<Blob | null>((res) => flat.toBlob((b) => res(b), fmt.mime, q));
      if (!blob) {
        // canvas may not support bmp/gif encoding — fall back to PNG.
        const png = await new Promise<Blob | null>((res) => flat.toBlob((b) => res(b), 'image/png'));
        if (!png) throw new Error(P('Export failed.', '匯出失敗。'));
        downloadBlob(png, `${baseName}.png`);
        setStatus({ ok: false, text: P('This format is not supported by the canvas encoder; exported PNG instead.', '畫布編碼器唔支援呢個格式，已改匯出 PNG。') });
        return;
      }
      if (live) {
        // Gated write to a real path via SaveFileDialog (mutation).
        const savePath = await pickSavePath(baseName, fmt.ext, P);
        if (!savePath) { setBusy(''); return; }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await writeBytesToPath(savePath, bytes);
        setStatus({ ok: true, text: P('Saved to {p}', '已儲存到 {p}').replace('{p}', savePath) });
      } else {
        downloadBlob(blob, `${baseName}.${fmt.ext}`);
        setStatus({ ok: true, text: P('Downloaded {n}', '已下載 {n}').replace('{n}', `${baseName}.${fmt.ext}`) });
      }
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [exportFmt, quality, compositeCanvas, doc.fileName, live, P]);

  // ── keyboard shortcuts ───────────────────────────────────────────────────
  const editorRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    const found = TOOLS.find((tt) => tt.key.toLowerCase() === e.key.toLowerCase());
    if (found) { setTool(found.id); e.preventDefault(); }
  }, [undo, redo]);

  const dispW = Math.round(doc.width * zoom);
  const dispH = Math.round(doc.height * zoom);

  // crop overlay geometry (in display px)
  const cropOverlay = (() => {
    const c = cropRef.current;
    if (!hasCrop || !c) return null;
    const xa = Math.min(c.x0, c.x1), xb = Math.max(c.x0, c.x1);
    const ya = Math.min(c.y0, c.y1), yb = Math.max(c.y0, c.y1);
    return { left: xa * zoom, top: ya * zoom, width: Math.max(1, xb - xa) * zoom, height: Math.max(1, yb - ya) * zoom };
  })();

  const cursorFor = tool === 'move' ? 'grab' : tool === 'text' ? 'text' : 'crosshair';

  return (
    <div ref={editorRef} tabIndex={0} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.bmp,.gif,.webp"
        style={{ display: 'none' }}
        onChange={onBrowserFile}
      />

      {status && (
        <p className={status.ok ? 'count-note' : 'cmd-out error'} style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>
          {status.ok ? '✓ ' : '✗ '}{status.text}
        </p>
      )}

      {/* command bar */}
      <ModuleToolbar>
        <button className="mini" onClick={newDoc}>{t('imageeditor.newBtn')}</button>
        <button className="mini primary" onClick={openFile} disabled={busy === 'open'}>
          {busy === 'open' ? t('modules.loading') : t('imageeditor.openBtn')}
        </button>
        <button className="mini" onClick={undo} disabled={histLen === 0}>↶ {t('imageeditor.undo')}</button>
        <button className="mini" onClick={redo} disabled={redoRef.current.length === 0}>↷ {t('imageeditor.redo')}</button>
        <span className="count-note">{t('imageeditor.zoomLabel')} {(zoom * 100).toFixed(0)}%</span>
        <input
          type="range" min={5} max={800} value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Math.max(0.05, Number(e.target.value) / 100))}
          style={{ width: 120 }}
        />
        <button className="mini" onClick={fitToView}>{t('imageeditor.fit')}</button>
        <button className="mini" onClick={() => setZoom(1)}>1:1</button>
        <span className="count-note">{doc.width} × {doc.height} px</span>
      </ModuleToolbar>

      <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* tool column */}
        <div style={{ ...card, marginTop: 0, display: 'flex', flexDirection: 'column', gap: 6, width: 64, flex: '0 0 auto' }}>
          {TOOLS.map((tt) => (
            <button
              key={tt.id}
              className={`mini${tool === tt.id ? ' primary' : ''}`}
              title={`${P(tt.en, tt.zh)} (${tt.key})`}
              onClick={() => { setTool(tt.id); if (tt.id !== 'crop') { setHasCrop(false); cropRef.current = null; } }}
              style={{ fontSize: 16, height: 34, padding: 0 }}
            >
              {tt.glyph}
            </button>
          ))}
          <div style={{ height: 1, background: 'var(--border, rgba(127,127,127,0.22))', margin: '4px 0' }} />
          <label
            title={P('Brush / text colour', '筆刷／文字顏色')}
            style={{ width: '100%', height: 30, borderRadius: 6, background: color, border: '1px solid var(--border, rgba(127,127,127,0.3))', cursor: 'pointer', position: 'relative' }}
          >
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
          </label>
          <span className="count-note" style={{ textAlign: 'center', fontSize: 10 }}>{t('imageeditor.size')} {brush}</span>
          <input type="range" min={1} max={80} value={brush} onChange={(e) => setBrush(Number(e.target.value))} style={{ width: '100%' }} />
        </div>

        {/* canvas host */}
        <div
          style={{
            flex: '1 1 420px',
            minWidth: 320,
            maxHeight: 560,
            overflow: 'auto',
            borderRadius: 8,
            border: '1px solid var(--border, rgba(127,127,127,0.22))',
            background: 'var(--card, rgba(127,127,127,0.06))',
            padding: 24,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <div style={{ position: 'relative', width: dispW, height: dispH, flex: '0 0 auto' }}>
            <canvas
              ref={canvasRef}
              width={doc.width}
              height={doc.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              style={{ width: dispW, height: dispH, display: 'block', imageRendering: zoom >= 3 ? 'pixelated' : 'auto', cursor: cursorFor, touchAction: 'none' }}
            />
            {cropOverlay && (
              <div
                style={{
                  position: 'absolute',
                  left: cropOverlay.left,
                  top: cropOverlay.top,
                  width: cropOverlay.width,
                  height: cropOverlay.height,
                  border: '2px dashed #1e90ff',
                  background: 'rgba(30,144,255,0.16)',
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        </div>

        {/* side panel */}
        <div style={{ flex: '0 0 300px', width: 300, maxWidth: '100%' }}>
          {/* adjustments */}
          <div style={{ ...card, marginTop: 0 }}>
            <strong>{t('imageeditor.adjustHeader')}</strong>
            <Slider label={`${t('imageeditor.adj_brightness')} ${sign(adj.brightness)}`} min={-100} max={100} value={adj.brightness} onChange={(v) => setAdj((a) => ({ ...a, brightness: v }))} />
            <Slider label={`${t('imageeditor.adj_contrast')} ${sign(adj.contrast)}`} min={-100} max={100} value={adj.contrast} onChange={(v) => setAdj((a) => ({ ...a, contrast: v }))} />
            <Slider label={`${t('imageeditor.adj_saturation')} ${sign(adj.saturation)}`} min={-100} max={100} value={adj.saturation} onChange={(v) => setAdj((a) => ({ ...a, saturation: v }))} />
            <Slider label={`${t('imageeditor.adj_hue')} ${sign(adj.hue)}°`} min={-180} max={180} value={adj.hue} onChange={(v) => setAdj((a) => ({ ...a, hue: v }))} />
            <Slider label={`${t('imageeditor.adj_gamma')} ${(adj.gamma / 100).toFixed(2)}`} min={10} max={300} value={adj.gamma} onChange={(v) => setAdj((a) => ({ ...a, gamma: v }))} />
            <div className="mod-toolbar" style={{ marginTop: 8 }}>
              <button className="mini primary" onClick={applyAdjustments} disabled={adjNeutral}>{t('imageeditor.apply')}</button>
              <button className="mini" onClick={resetAdjustments} disabled={adjNeutral}>{t('imageeditor.reset')}</button>
            </div>
            <p className="count-note" style={{ marginTop: 6, fontSize: 11 }}>{t('imageeditor.adjustHint')}</p>
          </div>

          {/* filters */}
          <div style={card}>
            <strong>{t('imageeditor.filterHeader')}</strong>
            <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button className="mini" onClick={() => applyFilterKind('grayscale')}>{t('imageeditor.flt_grayscale')}</button>
              <button className="mini" onClick={() => applyFilterKind('invert')}>{t('imageeditor.flt_invert')}</button>
              <button className="mini" onClick={() => applyFilterKind('sepia')}>{t('imageeditor.flt_sepia')}</button>
              <button className="mini" onClick={() => applyFilterKind('blur')}>{t('imageeditor.flt_blur')}</button>
              <button className="mini" onClick={() => applyFilterKind('sharpen')}>{t('imageeditor.flt_sharpen')}</button>
              <button className="mini" onClick={() => applyFilterKind('edge')}>{t('imageeditor.flt_edge')}</button>
            </div>
            <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
              <span className="count-note">{t('imageeditor.blurAmount')} {blurAmt}</span>
              <input type="range" min={1} max={12} value={blurAmt} onChange={(e) => setBlurAmt(Number(e.target.value))} style={{ flex: 1, minWidth: 100 }} />
            </div>
          </div>

          {/* transform */}
          <div style={card}>
            <strong>{t('imageeditor.transformHeader')}</strong>
            <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button className="mini" onClick={() => rotate90(true)} title={t('imageeditor.tf_rotateCw')}>↻ 90°</button>
              <button className="mini" onClick={() => rotate90(false)} title={t('imageeditor.tf_rotateCcw')}>↺ 90°</button>
              <button className="mini" onClick={() => flip(true)}>{t('imageeditor.tf_flipH')}</button>
              <button className="mini" onClick={() => flip(false)}>{t('imageeditor.tf_flipV')}</button>
            </div>
            <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
              <input type="number" min={-360} max={360} value={rotDeg} onChange={(e) => setRotDeg(Number(e.target.value) || 0)} style={{ width: 80 }} />
              <button className="mini" onClick={rotateArbitrary}>{t('imageeditor.rotateArb')}</button>
            </div>
            <div style={{ height: 1, background: 'var(--border, rgba(127,127,127,0.22))', margin: '10px 0' }} />
            <strong style={{ fontSize: 12 }}>{t('imageeditor.tf_resize')}</strong>
            <div className="mod-toolbar" style={{ marginTop: 6, alignItems: 'center' }}>
              <label className="count-note">W <input type="number" min={1} max={16384} value={resizeW} onChange={(e) => onResizeW(Number(e.target.value) || 1)} style={{ width: 70 }} /></label>
              <label className="count-note">H <input type="number" min={1} max={16384} value={resizeH} onChange={(e) => onResizeH(Number(e.target.value) || 1)} style={{ width: 70 }} /></label>
            </div>
            <label className="count-note" style={{ display: 'block', marginTop: 6 }}>
              <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} /> {t('imageeditor.lockAspect')}
            </label>
            <button className="mini" onClick={applyResize} style={{ marginTop: 6 }}>{t('imageeditor.applyResize')}</button>
            <p className="count-note" style={{ marginTop: 8, fontSize: 11 }}>{t('imageeditor.cropHint')}</p>
            <button className="mini" onClick={cropRect} disabled={!cropReady}>{t('imageeditor.applyCrop')}</button>
          </div>

          {/* layers */}
          <div style={card}>
            <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
              <strong>{t('imageeditor.layersHeader')}</strong>
              <span>
                <button className="mini" onClick={addLayer} title={t('imageeditor.layerAdd')}>＋</button>{' '}
                <button className="mini" onClick={() => moveLayer(1)} title={t('imageeditor.layerUp')}>▲</button>{' '}
                <button className="mini" onClick={() => moveLayer(-1)} title={t('imageeditor.layerDown')}>▼</button>{' '}
                <button className="mini" onClick={deleteLayer} disabled={doc.layers.length <= 1} title={t('imageeditor.layerDel')}>✕</button>{' '}
                <button className="mini" onClick={flattenAll} disabled={doc.layers.length <= 1} title={t('imageeditor.layerFlatten')}>⧉</button>
              </span>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {doc.layers.map((_, k) => doc.layers.length - 1 - k).map((i) => {
                const l = doc.layers[i]!;
                return (
                  <div
                    key={l.id}
                    onClick={() => setActiveLayer(i)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                      background: i === doc.active ? 'var(--accent-soft, rgba(96,165,250,0.18))' : 'transparent',
                    }}
                  >
                    <input type="checkbox" checked={l.visible} onClick={(e) => e.stopPropagation()} onChange={(e) => setLayerVisible(i, e.target.checked)} />
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  </div>
                );
              })}
            </div>
            <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
              <span className="count-note">{t('imageeditor.opacity')}</span>
              <input
                type="range" min={0} max={100} value={Math.round(activeLayer.opacity * 100)}
                onChange={(e) => setLayerOpacity(doc.active, Number(e.target.value) / 100)}
                style={{ flex: 1, minWidth: 100 }}
              />
            </div>
          </div>

          {/* export */}
          <div style={card}>
            <strong>{t('imageeditor.exportHeader')}</strong>
            <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
              <select className="mini" value={exportFmt} onChange={(e) => setExportFmt(e.target.value)}>
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.ext} value={f.ext}>{f.ext.toUpperCase()}</option>
                ))}
              </select>
              <button className="mini primary" onClick={exportImage} disabled={busy === 'export'}>
                {busy === 'export' ? t('modules.loading') : live ? t('imageeditor.saveBtn') : t('imageeditor.downloadBtn')}
              </button>
            </div>
            {(EXPORT_FORMATS.find((f) => f.ext === exportFmt)?.quality) && (
              <div className="mod-toolbar" style={{ marginTop: 8, alignItems: 'center' }}>
                <span className="count-note">{t('imageeditor.quality')} {quality}</span>
                <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ flex: 1, minWidth: 100 }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// tiny labelled slider
function Slider({ label, min, max, value, onChange }: { label: ReactNode; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginTop: 6 }}>
      <span className="count-note" style={{ fontSize: 11, margin: 0 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%', display: 'block' }} />
    </div>
  );
}

function sign(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Library — the original disk scanner (preserved, no regression).
interface Img {
  Name: string;
  Path: string;
  Folder: string;
  Ext: string;
  Bytes: number;
  Width: number;
  Height: number;
  Modified: string;
}

const SCAN = `
Add-Type -AssemblyName System.Drawing
$roots = @(
  [Environment]::GetFolderPath('MyPictures'),
  (Join-Path $env:USERPROFILE 'Pictures'),
  (Join-Path $env:USERPROFILE 'Downloads'),
  (Join-Path $env:USERPROFILE 'Desktop')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$exts = '.png','.jpg','.jpeg','.bmp','.gif','.webp','.tif','.tiff'
$files = foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $exts -contains $_.Extension.ToLower() }
}
$files | Sort-Object LastWriteTime -Descending | Select-Object -First 400 | ForEach-Object {
  $w = 0; $h = 0
  try {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    $w = $img.Width; $h = $img.Height
    $img.Dispose()
  } catch { }
  [PSCustomObject]@{
    Name     = $_.Name
    Path     = $_.FullName
    Folder   = $_.DirectoryName
    Ext      = $_.Extension.TrimStart('.').ToLower()
    Bytes    = [int64]$_.Length
    Width    = [int]$w
    Height   = [int]$h
    Modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
  }
}`;

function Library() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [extSel, setExtSel] = useState('all');
  const live = isTauri();

  const { data, loading, error, reload } = useAsync(
    () => (live ? runPowershellJson<Img>(SCAN) : Promise.resolve([] as Img[])),
    [live],
  );

  const all = useMemo(() => data ?? [], [data]);

  const extList = useMemo(() => {
    const s = new Set<string>();
    for (const i of all) if (i.Ext) s.add(i.Ext);
    return [...s].sort();
  }, [all]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return all.filter((i) => {
      if (extSel !== 'all' && i.Ext !== extSel) return false;
      if (!q) return true;
      return `${i.Name} ${i.Folder}`.toLowerCase().includes(q);
    });
  }, [all, filter, extSel]);

  const totalBytes = useMemo(() => rows.reduce((a, i) => a + (i.Bytes || 0), 0), [rows]);

  const mp = (w: number, h: number) => (w <= 0 || h <= 0 ? '—' : `${((w * h) / 1_000_000).toFixed(1)} MP`);

  const columns: Column<Img>[] = [
    { key: 'Name', header: t('imageeditor.colName') },
    { key: 'Ext', header: t('imageeditor.colFormat'), width: 80, render: (i) => <span className="mono">{i.Ext.toUpperCase()}</span> },
    { key: 'dim', header: t('imageeditor.colDim'), width: 120, render: (i) => (i.Width > 0 ? `${i.Width} × ${i.Height}` : '—') },
    { key: 'mp', header: t('imageeditor.colMp'), width: 90, align: 'right', render: (i) => mp(i.Width, i.Height) },
    { key: 'Bytes', header: t('imageeditor.colSize'), width: 100, align: 'right', render: (i) => fmtSize(i.Bytes) },
    { key: 'Modified', header: t('imageeditor.colModified'), width: 140 },
    { key: 'Folder', header: t('imageeditor.colFolder') },
  ];

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('imageeditor.blurb')}</p>
      {!live && <p className="count-note" style={{ marginTop: 0 }}>{t('imageeditor.libraryPreview')}</p>}
      <ModuleToolbar>
        <input className="mod-search" placeholder={t('imageeditor.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className="mini" value={extSel} onChange={(e) => setExtSel(e.target.value)}>
          <option value="all">{t('imageeditor.allFormats')}</option>
          {extList.map((x) => (<option key={x} value={x}>{x.toUpperCase()}</option>))}
        </select>
        <button className="mini" onClick={reload}>⟳ {t('modules.refresh')}</button>
        <span className="count-note">{t('imageeditor.count', { num: rows.length })} · {fmtSize(totalBytes)}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(i) => i.Path} empty={t('imageeditor.empty')} />
      </AsyncState>
    </div>
  );
}

// ── desktop save helpers ─────────────────────────────────────────────────────
async function pickSavePath(baseName: string, ext: string, P: (en: string, zh: string) => string): Promise<string | null> {
  const res = await runPowershell(
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d=New-Object System.Windows.Forms.SaveFileDialog; $d.Title='${psq(P('Save image', '儲存影像'))}'; ` +
      `$d.FileName='${psq(baseName)}.${ext}'; $d.Filter='${psq(ext.toUpperCase())} (*.${ext})|*.${ext}|All files|*.*'; ` +
      `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
  );
  const p = res.stdout.trim();
  return p || null;
}

async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  const b64 = bytesToB64(bytes);
  const r = await runPowershell(`[IO.File]::WriteAllBytes('${psq(path)}', [Convert]::FromBase64String('${b64}')); 'OK'`);
  if (!r.success && !r.stdout.includes('OK')) throw new Error(r.stderr.trim() || 'write failed');
}

function downloadBlob(blob: Blob, name: string): void {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
