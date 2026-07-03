import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — a lightweight, original Aseprite-style pixel-art editor (a faithful web port of
// WinForge's PixelEditorModule). The editor itself (pencil / eraser / fill / eyedropper / select,
// palette, grid, zoom, undo/redo, PNG export) runs entirely in the browser on an HTML5 canvas — no
// external tool required. The NATIVE part is optional: if Aseprite is installed it can be detected
// and launched through the WinForge desktop backend (PowerShell probe + detached process launch).

type Tool = 'pencil' | 'eraser' | 'fill' | 'eyedropper';

// RGBA packed as 0xAABBGGRR is awkward in JS; we keep colours as {r,g,b,a} and an int pixel buffer
// (Uint32) is unnecessary — a flat number[] of packed 0xRRGGBBAA is simplest and copy-cheap for undo.
type Packed = number; // 0xRRGGBBAA

const TRANSPARENT: Packed = 0x00000000;

// The exact original WinForge palette (NOT Aseprite's default). C# stored packed BGRA (low byte =
// Blue); we translate each to #RRGGBB here. Index 0 is transparent (the eraser colour).
const DEFAULT_PALETTE_HEX: string[] = [
  '', // transparent
  '#000000', '#3F3F3F', '#7F7F7F', '#BFBFBF', '#FFFFFF',
  '#202020', '#6B6B6B', '#A8A8A8', '#D8D8D8',
  '#C82222', '#E06B2A', '#F0B036', '#F0D749', '#F0E88C',
  '#E07F22', '#4FB01F', '#6AC844', '#8CE08C',
  '#C8C81F', '#E0E038',
  '#C81F1F', '#E03737', '#F06B6B',
  '#8C2AC8', '#B04FE0', '#D78CF0',
  '#E08C1F', '#F0B02A', '#F0D76B',
  '#BF7F22', '#D7A849',
];

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

const BLACK: Packed = 0x000000ff;

function hexToPacked(hex: string): Packed {
  const s = hex.replace('#', '').trim();
  if (s.length !== 6) return BLACK;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return BLACK;
  return (((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
}

function packedToHex(p: Packed): string {
  const r = (p >>> 24) & 0xff;
  const g = (p >>> 16) & 0xff;
  const b = (p >>> 8) & 0xff;
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function packedRgba(p: Packed): { r: number; g: number; b: number; a: number } {
  return { r: (p >>> 24) & 0xff, g: (p >>> 16) & 0xff, b: (p >>> 8) & 0xff, a: p & 0xff };
}

// A CSS colour for a swatch, honouring transparency.
function swatchStyle(hex: string): React.CSSProperties {
  if (!hex) {
    return { background: 'rgba(128,128,128,0.28)' };
  }
  return { background: hex };
}

const MAX_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 32;

export function PixelEditorModule() {
  const { t } = useTranslation();

  // ---- document state ----
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  // pixel buffer: packed 0xRRGGBBAA, length width*height. Kept in a ref for fast mutation while
  // drawing; a version counter forces re-composite/redraw.
  const pixelsRef = useRef<Packed[]>([]);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // undo/redo stacks hold full snapshots (small canvases, ≤256²).
  const undoRef = useRef<Packed[][]>([]);
  const redoRef = useRef<Packed[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const syncUndo = useCallback(() => {
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  // ---- tool / colour state ----
  const [tool, setTool] = useState<Tool>('pencil');
  const [primary, setPrimary] = useState<Packed>(hexToPacked('#000000'));
  const [hexInput, setHexInput] = useState('#000000');
  const [palette, setPalette] = useState<string[]>(DEFAULT_PALETTE_HEX);
  const [recent, setRecent] = useState<Packed[]>([]);

  // ---- view state ----
  const [zoom, setZoom] = useState(12);
  const [showGrid, setShowGrid] = useState(true);

  // ---- new-canvas form ----
  const [newW, setNewW] = useState(32);
  const [newH, setNewH] = useState(32);

  // ---- Aseprite (native) ----
  const desktop = isTauri();
  const [asepritePath, setAsepritePath] = useState<string | null>(null);
  const [asepriteChecked, setAsepriteChecked] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<boolean>(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  // Initialise / reset the pixel buffer whenever the canvas dimensions change.
  const resetPixels = useCallback((w: number, h: number) => {
    pixelsRef.current = new Array<Packed>(w * h).fill(TRANSPARENT);
    undoRef.current = [];
    redoRef.current = [];
    setUndoCount(0);
    setRedoCount(0);
    bump();
  }, [bump]);

  useEffect(() => {
    if (pixelsRef.current.length !== width * height) {
      resetPixels(width, height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- undo helpers ----
  const snapshot = useCallback(() => {
    undoRef.current.push(pixelsRef.current.slice());
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
    syncUndo();
  }, [syncUndo]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(pixelsRef.current.slice());
    pixelsRef.current = prev;
    syncUndo();
    bump();
  }, [syncUndo, bump]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(pixelsRef.current.slice());
    pixelsRef.current = next;
    syncUndo();
    bump();
  }, [syncUndo, bump]);

  // ---- colour helpers ----
  const setPrimaryColour = useCallback((p: Packed) => {
    setPrimary(p);
    setHexInput(packedToHex(p));
  }, []);

  const addRecent = useCallback((p: Packed) => {
    if ((p & 0xff) === 0) return; // skip transparent
    setRecent((prev) => {
      const next = [p, ...prev.filter((c) => c !== p)];
      return next.slice(0, 12);
    });
  }, []);

  // ---- pixel ops ----
  const idx = useCallback((x: number, y: number) => y * width + x, [width]);
  const inBounds = useCallback((x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height, [width, height]);

  const setPixel = useCallback((x: number, y: number, c: Packed) => {
    if (!inBounds(x, y)) return;
    pixelsRef.current[idx(x, y)] = c;
  }, [inBounds, idx]);

  const getPixel = useCallback((x: number, y: number): Packed => {
    if (!inBounds(x, y)) return TRANSPARENT;
    return pixelsRef.current[idx(x, y)]!;
  }, [inBounds, idx]);

  // Bresenham line to fill gaps between pointer samples.
  const drawLine = useCallback((x0: number, y0: number, x1: number, y1: number, c: Packed) => {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0;
    let cy = y0;
    // guard against pathological loops
    let guard = (dx + dy) * 4 + 8;
    while (guard-- > 0) {
      setPixel(cx, cy, c);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }, [setPixel]);

  // 4-connected flood fill on the pixel buffer.
  const floodFill = useCallback((x: number, y: number, c: Packed) => {
    if (!inBounds(x, y)) return false;
    const target = getPixel(x, y);
    if (target === c) return false;
    const stack: Array<[number, number]> = [[x, y]];
    let guard = width * height + 16;
    while (stack.length > 0 && guard-- > 0) {
      const top = stack.pop();
      if (!top) break;
      const [cx, cy] = top;
      if (!inBounds(cx, cy)) continue;
      if (getPixel(cx, cy) !== target) continue;
      setPixel(cx, cy, c);
      stack.push([cx + 1, cy]);
      stack.push([cx - 1, cy]);
      stack.push([cx, cy + 1]);
      stack.push([cx, cy - 1]);
    }
    return true;
  }, [inBounds, getPixel, setPixel, width, height]);

  // ---- rendering ----
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const px = pixelsRef.current;
    const z = zoom;
    canvas.width = width * z;
    canvas.height = height * z;
    ctx.imageSmoothingEnabled = false;

    // checkerboard behind transparency (8px logical cells → 2 pixel-cells like the C#)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dark = (((x >> 1) + (y >> 1)) % 2) === 0;
        ctx.fillStyle = dark ? 'rgb(200,200,200)' : 'rgb(230,230,230)';
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
    // pixels (source-over onto the checker)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = px[idx(x, y)];
        if (p === undefined) continue;
        const a = p & 0xff;
        if (a === 0) continue;
        const { r, g, b } = packedRgba(p);
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
    // grid
    if (showGrid && z >= 6) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < width; x++) {
        ctx.moveTo(x * z + 0.5, 0);
        ctx.lineTo(x * z + 0.5, height * z);
      }
      for (let y = 1; y < height; y++) {
        ctx.moveTo(0, y * z + 0.5);
        ctx.lineTo(width * z, y * z + 0.5);
      }
      ctx.stroke();
    }
  }, [zoom, width, height, showGrid, idx]);

  useEffect(() => {
    redraw();
  }, [redraw, version]);

  // ---- pointer handling ----
  const toPixel = useCallback((e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    const x = Math.floor(cx / zoom);
    const y = Math.floor(cy / zoom);
    return { x: clamp(x, 0, width - 1), y: clamp(y, 0, height - 1) };
  }, [zoom, width, height]);

  const applyToolAt = useCallback((x: number, y: number, isStart: boolean) => {
    if (tool === 'eyedropper') {
      const p = getPixel(x, y);
      if ((p & 0xff) !== 0) setPrimaryColour(p);
      return;
    }
    if (tool === 'fill') {
      if (isStart) {
        snapshot();
        const changed = floodFill(x, y, primary);
        if (changed) { addRecent(primary); bump(); }
        else { undoRef.current.pop(); syncUndo(); }
      }
      return;
    }
    // pencil / eraser
    const c = tool === 'eraser' ? TRANSPARENT : primary;
    const last = lastRef.current;
    if (last && (last.x !== x || last.y !== y)) {
      drawLine(last.x, last.y, x, y, c);
    } else {
      setPixel(x, y, c);
    }
    lastRef.current = { x, y };
    bump();
  }, [tool, getPixel, setPrimaryColour, snapshot, floodFill, primary, addRecent, bump, syncUndo, drawLine, setPixel]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toPixel(e);
    if (!p) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (tool === 'pencil' || tool === 'eraser') {
      snapshot();
    }
    drawingRef.current = true;
    lastRef.current = null;
    applyToolAt(p.x, p.y, true);
    if (tool === 'pencil') addRecent(primary);
  }, [toPixel, tool, snapshot, applyToolAt, addRecent, primary]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    if (tool === 'fill' || tool === 'eyedropper') return;
    const p = toPixel(e);
    if (!p) return;
    applyToolAt(p.x, p.y, false);
  }, [tool, toPixel, applyToolAt]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    lastRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // ---- toolbar actions ----
  const doNew = useCallback(() => {
    const w = clamp(Math.round(newW) || 32, 1, MAX_SIZE);
    const h = clamp(Math.round(newH) || 32, 1, MAX_SIZE);
    setWidth(w);
    setHeight(h);
    resetPixels(w, h);
    setStatus(null);
  }, [newW, newH, resetPixels]);

  const doClear = useCallback(() => {
    snapshot();
    pixelsRef.current = new Array<Packed>(width * height).fill(TRANSPARENT);
    bump();
  }, [snapshot, width, height, bump]);

  const applyHex = useCallback(() => {
    const s = hexInput.replace('#', '').trim();
    if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) {
      setPrimaryColour(hexToPacked('#' + s));
    }
  }, [hexInput, setPrimaryColour]);

  const addToPalette = useCallback(() => {
    const hex = packedToHex(primary);
    setPalette((prev) => (prev.includes(hex) ? prev : [...prev, hex]));
  }, [primary]);

  // Build a PNG data URL from the current pixel buffer at 1× (true pixel size).
  const buildPngDataUrl = useCallback((): string | null => {
    if (typeof document === 'undefined') return null;
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(width, height);
    const px = pixelsRef.current;
    for (let i = 0; i < width * height; i++) {
      const p = px[i] ?? TRANSPARENT;
      const o = i * 4;
      img.data[o] = (p >>> 24) & 0xff;
      img.data[o + 1] = (p >>> 16) & 0xff;
      img.data[o + 2] = (p >>> 8) & 0xff;
      img.data[o + 3] = p & 0xff;
    }
    ctx.putImageData(img, 0, 0);
    try {
      return off.toDataURL('image/png');
    } catch {
      return null;
    }
  }, [width, height]);

  const exportPng = useCallback(() => {
    const url = buildPngDataUrl();
    if (!url) { setStatus(t('pixeled.exportFailed')); return; }
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `sprite-${width}x${height}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setStatus(t('pixeled.exportOk'));
    } catch {
      setStatus(t('pixeled.exportFailed'));
    }
  }, [buildPngDataUrl, width, height, t]);

  // ---- Aseprite detection / launch (native, desktop only) ----
  const detectScript = useMemo(() => {
    // Probe the same candidate locations the C# service checks, then PATH, then App Paths registry.
    return [
      "$c=@();",
      "$pf=[Environment]::GetFolderPath('ProgramFiles');",
      "$pf86=[Environment]::GetFolderPath('ProgramFilesX86');",
      "$loc=[Environment]::GetFolderPath('LocalApplicationData');",
      "$c+=Join-Path $pf86 'Steam\\steamapps\\common\\Aseprite\\Aseprite.exe';",
      "$c+=Join-Path $pf 'Steam\\steamapps\\common\\Aseprite\\Aseprite.exe';",
      "$c+=Join-Path $pf 'Aseprite\\Aseprite.exe';",
      "$c+=Join-Path $pf86 'Aseprite\\Aseprite.exe';",
      "$c+=Join-Path $loc 'Programs\\Aseprite\\Aseprite.exe';",
      "$found=$null;",
      "foreach($p in $c){ if(Test-Path -LiteralPath $p){ $found=$p; break } }",
      "if(-not $found){ $cmd=Get-Command Aseprite.exe -ErrorAction SilentlyContinue; if($cmd){ $found=$cmd.Source } }",
      "if(-not $found){ try{ $rp=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Aseprite.exe' -ErrorAction Stop).'(default)'; if($rp -and (Test-Path -LiteralPath $rp)){ $found=$rp } }catch{} }",
      "if($found){ Write-Output $found }",
    ].join(' ');
  }, []);

  const detectAseprite = useCallback(async () => {
    if (!desktop) { setAsepriteChecked(true); return; }
    setBusy('detect');
    setStatus(null);
    try {
      const res: CommandOutput = await runPowershell(detectScript);
      const out = (res.stdout || '').trim();
      setAsepritePath(out.length > 0 ? out.split(/\r?\n/)[0]!.trim() : null);
    } catch (e) {
      setAsepritePath(null);
      setStatus(String(e instanceof Error ? e.message : e));
    } finally {
      setAsepriteChecked(true);
      setBusy('');
    }
  }, [desktop, detectScript]);

  useEffect(() => {
    void detectAseprite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const launchAseprite = useCallback(async () => {
    if (!desktop || !asepritePath) return;
    setBusy('launch');
    setStatus(null);
    try {
      const res = await runCommand(asepritePath, []);
      setStatus(res.success ? t('pixeled.launched') : (res.stderr.trim() || t('pixeled.launchFailed')));
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  }, [desktop, asepritePath, t]);

  // ---- derived ----
  const tools: Array<{ id: Tool; label: string; hint: string }> = [
    { id: 'pencil', label: t('pixeled.pencil'), hint: t('pixeled.pencilHint') },
    { id: 'eraser', label: t('pixeled.eraser'), hint: t('pixeled.eraserHint') },
    { id: 'fill', label: t('pixeled.fill'), hint: t('pixeled.fillHint') },
    { id: 'eyedropper', label: t('pixeled.eyedropper'), hint: t('pixeled.eyedropperHint') },
  ];

  const primaryHex = packedToHex(primary);
  const isTransparentPrimary = (primary & 0xff) === 0;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('pixeled.blurb')}</p>
      <p className="count-note" style={{ marginTop: 0 }}>{t('pixeled.subsetNote')}</p>

      {/* Command bar */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="label">{t('pixeled.newWidth')}</label>
        <input className="mod-search" type="number" min={1} max={MAX_SIZE} style={{ maxWidth: 80 }}
          value={newW} onChange={(e) => setNewW(clamp(+e.target.value || 1, 1, MAX_SIZE))} />
        <label className="label">{t('pixeled.newHeight')}</label>
        <input className="mod-search" type="number" min={1} max={MAX_SIZE} style={{ maxWidth: 80 }}
          value={newH} onChange={(e) => setNewH(clamp(+e.target.value || 1, 1, MAX_SIZE))} />
        <button className="mini primary" onClick={doNew}>{t('pixeled.newBtn')}</button>
        <button className="mini" onClick={doClear}>{t('pixeled.clear')}</button>
        <button className="mini" disabled={undoCount === 0} onClick={undo}>{t('pixeled.undo')}</button>
        <button className="mini" disabled={redoCount === 0} onClick={redo}>{t('pixeled.redo')}</button>
        <button className="mini" onClick={exportPng}>{t('pixeled.exportPng')}</button>
      </div>

      {/* Tools + view controls */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {tools.map((tl) => (
          <button
            key={tl.id}
            className={tool === tl.id ? 'mini primary' : 'mini'}
            title={tl.hint}
            onClick={() => setTool(tl.id)}
          >
            {tl.label}
          </button>
        ))}
        <span style={{ width: 12 }} />
        <label className="label">{t('pixeled.zoom')}</label>
        <input
          type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={zoom}
          onChange={(e) => setZoom(clamp(+e.target.value, MIN_ZOOM, MAX_ZOOM))}
          style={{ verticalAlign: 'middle' }}
        />
        <span className="value">{zoom}×</span>
        <label className="chk" style={{ marginLeft: 8 }}>
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          {t('pixeled.grid')}
        </label>
        <span className="count-note" style={{ marginLeft: 8 }}>
          {t('pixeled.size', { w: width, h: height })}
        </span>
      </div>

      <div className="io-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 220px', alignItems: 'start' }}>
        {/* Canvas */}
        <div className="panel" style={{ overflow: 'auto', maxHeight: 520 }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{
              cursor: 'crosshair',
              imageRendering: 'pixelated',
              touchAction: 'none',
              display: 'block',
            }}
          />
        </div>

        {/* Colour + palette panel */}
        <div className="panel">
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('pixeled.colour')}</span>
              <span className="value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block', width: 20, height: 20, borderRadius: 4,
                    border: '1px solid var(--border, #999)',
                    ...swatchStyle(isTransparentPrimary ? '' : primaryHex),
                  }}
                />
                <code>{isTransparentPrimary ? t('pixeled.transparent') : primaryHex}</code>
              </span>
            </div>
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ maxWidth: 110 }}
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyHex()}
              placeholder="#RRGGBB"
            />
            <button className="mini" onClick={applyHex}>{t('pixeled.setHex')}</button>
          </div>
          <button className="mini" style={{ marginBottom: 8 }} onClick={addToPalette}>
            {t('pixeled.addToPalette')}
          </button>

          <div className="label" style={{ marginBottom: 4 }}>{t('pixeled.palette')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
            {palette.map((hex, i) => (
              <button
                key={`${hex}-${i}`}
                title={hex ? hex : t('pixeled.transparent')}
                onClick={() => setPrimaryColour(hex ? hexToPacked(hex) : TRANSPARENT)}
                style={{
                  width: 22, height: 22, borderRadius: 3, padding: 0, cursor: 'pointer',
                  border: '1px solid var(--border, #999)', ...swatchStyle(hex),
                }}
              />
            ))}
          </div>

          {recent.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 4 }}>{t('pixeled.recent')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                {recent.map((p, i) => (
                  <button
                    key={`${p}-${i}`}
                    title={packedToHex(p)}
                    onClick={() => setPrimaryColour(p)}
                    style={{
                      width: 18, height: 18, borderRadius: 3, padding: 0, cursor: 'pointer',
                      border: '1px solid var(--border, #999)', ...swatchStyle(packedToHex(p)),
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Native: Aseprite detect / launch */}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="dt-wrap">
          <span className="label">{t('pixeled.asepriteTitle')}</span>
        </div>
        {!desktop && (
          <p className="count-note" style={{ color: 'var(--danger)' }}>{t('pixeled.desktopOnly')}</p>
        )}
        {desktop && (
          <>
            {!asepriteChecked && <p className="count-note">{t('pixeled.detecting')}</p>}
            {asepriteChecked && asepritePath && (
              <p className="dep-ok">✓ {t('pixeled.asepriteFound')} · <code>{asepritePath}</code></p>
            )}
            {asepriteChecked && !asepritePath && (
              <p className="dep-missing">⚠ {t('pixeled.asepriteMissing')}</p>
            )}
            <div className="mod-toolbar">
              <button className="mini primary" disabled={!asepritePath || busy === 'launch'} onClick={launchAseprite}>
                {busy === 'launch' ? t('pixeled.launching') : t('pixeled.launchAseprite')}
              </button>
              <button className="mini" disabled={busy === 'detect'} onClick={detectAseprite}>
                ⟳ {busy === 'detect' ? t('pixeled.detecting') : t('pixeled.rescan')}
              </button>
            </div>
          </>
        )}
      </div>

      {status && <pre className="cmd-out">{status}</pre>}
      <p className="count-note">{t('pixeled.footNote')}</p>
    </div>
  );
}
