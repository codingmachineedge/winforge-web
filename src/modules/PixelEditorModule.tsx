import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — a lightweight, original Aseprite-style pixel-art editor (a faithful web port of
// WinForge's PixelEditorModule + PixelEditorService). The editor itself runs entirely in the browser
// on an HTML5 canvas: pencil / eraser / fill / eyedropper / select-move-delete, palette + colour
// picker, a stack of LAYERS (visibility / opacity / reorder) across one or more animation FRAMES
// (add / duplicate / reorder / per-frame delay / play), undo/redo, PNG export and an animated GIF
// export (a compact in-browser GIF89a encoder — no ffmpeg). Import reads an image through the WinForge
// desktop backend (OpenFileDialog + ReadAllBytes) or, in a plain browser, a file input. File WRITES
// (PNG / GIF save) go through the native SaveFileDialog when the desktop backend is present, otherwise
// a browser download. If Aseprite is installed it can be detected and launched natively.

type Tool = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'select';

// Colours are packed 0xRRGGBBAA (matching the original web port). BGRA↔RGBA translation only happens
// at the raw byte boundaries (PNG ImageData is RGBA; the C# model was BGRA — irrelevant on the web).
type Packed = number; // 0xRRGGBBAA

const TRANSPARENT: Packed = 0x00000000;
const BLACK: Packed = 0x000000ff;

// The exact original WinForge palette (NOT Aseprite's default). Index 0 is transparent (eraser colour).
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

const MAX_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
const MAX_UNDO = 100;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

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

function swatchStyle(hex: string): React.CSSProperties {
  if (!hex) return { background: 'rgba(128,128,128,0.28)' };
  return { background: hex };
}

// ── document model (frames → layers → pixels) ───────────────────────────────
interface Layer {
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  pixels: Uint32Array; // packed 0xRRGGBBAA, length w*h
}
interface Frame {
  layers: Layer[];
  delayMs: number;
}
interface Doc {
  width: number;
  height: number;
  frames: Frame[];
}

function newLayer(name: string, w: number, h: number): Layer {
  return { name, visible: true, opacity: 1, pixels: new Uint32Array(w * h) };
}
function cloneLayer(l: Layer): Layer {
  return { name: l.name, visible: l.visible, opacity: l.opacity, pixels: l.pixels.slice() };
}
function cloneFrame(f: Frame): Frame {
  return { layers: f.layers.map(cloneLayer), delayMs: f.delayMs };
}
function newDoc(w: number, h: number): Doc {
  return { width: w, height: h, frames: [{ layers: [newLayer('Layer 1', w, h)], delayMs: 100 }] };
}

// Porter–Duff source-over for non-premultiplied packed RGBA, with a layer opacity multiplier.
function overRgba(src: Packed, dst: Packed, opacity: number): Packed {
  let sa = src & 0xff;
  if (opacity < 1) sa = Math.round(sa * opacity);
  if (sa === 0) return dst;
  if (sa === 255 && (dst & 0xff) === 0) return (src & 0xffffff00) | 0xff;
  const da = dst & 0xff;
  const fa = sa / 255;
  const fda = da / 255;
  const outA = fa + fda * (1 - fa);
  if (outA <= 0) return 0;
  const blend = (shift: number): number => {
    const s = ((src >>> shift) & 0xff) / 255;
    const d = ((dst >>> shift) & 0xff) / 255;
    const o = (s * fa + d * fda * (1 - fa)) / outA;
    return clamp(Math.round(o * 255), 0, 255);
  };
  const r = blend(24);
  const g = blend(16);
  const b = blend(8);
  const a = clamp(Math.round(outA * 255), 0, 255);
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

// Composite one frame → a flat Uint32Array of packed 0xRRGGBBAA.
function compositeFrame(frame: Frame, n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (const l of frame.layers) {
    if (!l.visible) continue;
    const px = l.pixels;
    for (let i = 0; i < n; i++) {
      const c = px[i]!;
      if ((c & 0xff) === 0 && l.opacity >= 1) continue;
      out[i] = overRgba(c, out[i]!, l.opacity);
    }
  }
  return out;
}

// ── PowerShell / byte helpers (native file IO) ──────────────────────────────
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
function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function downloadBlob(blob: Blob, name: string): void {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

// ── minimal animated-GIF89a encoder (no external deps, no ffmpeg) ────────────
// Quantises to a shared ≤256-colour global table (nearest-match against collected colours), then
// LZW-encodes each frame with a per-frame delay + NETSCAPE loop-forever extension. Fully transparent
// pixels map to a dedicated transparent index. Good enough for pixel art with small palettes.
function encodeGif(width: number, height: number, frames: Array<{ rgba: Uint32Array; delayMs: number }>): Uint8Array {
  // Collect unique opaque colours (RGB only; alpha treated as on/off for GIF).
  const colorMap = new Map<number, number>(); // 0xRRGGBB -> index
  const palette: number[] = []; // 0xRRGGBB
  let transparentIndex = -1;
  let hasTransparent = false;

  const indexed: Uint8Array[] = frames.map((f) => {
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < idx.length; i++) {
      const c = f.rgba[i]!;
      if ((c & 0xff) === 0) {
        hasTransparent = true;
        idx[i] = 0; // placeholder; fixed once transparentIndex is known
        continue;
      }
      const rgb = (c >>> 8) & 0xffffff;
      let pi = colorMap.get(rgb);
      if (pi === undefined) {
        if (palette.length < 255) {
          pi = palette.length;
          palette.push(rgb);
          colorMap.set(rgb, pi);
        } else {
          // Palette full: nearest match among existing entries.
          pi = nearestPaletteIndex(palette, rgb);
        }
      }
      idx[i] = pi;
    }
    return idx;
  });

  if (hasTransparent) {
    transparentIndex = palette.length;
    palette.push(0x000000);
    // Re-mark transparent pixels with the transparent index.
    frames.forEach((f, fi) => {
      const idx = indexed[fi]!;
      for (let i = 0; i < idx.length; i++) {
        if ((f.rgba[i]! & 0xff) === 0) idx[i] = transparentIndex;
      }
    });
  }

  // Round palette size up to a power of two (min 2).
  let bits = 1;
  while ((1 << bits) < Math.max(2, palette.length)) bits++;
  const gctSize = 1 << bits;

  const out: number[] = [];
  const w8 = (b: number) => out.push(b & 0xff);
  const w16 = (v: number) => { out.push(v & 0xff); out.push((v >>> 8) & 0xff); };
  const wStr = (s: string) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  wStr('GIF89a');
  w16(width);
  w16(height);
  w8(0xf0 | (bits - 1)); // GCT present, colour resolution, GCT size = bits-1
  w8(0); // background colour index
  w8(0); // pixel aspect ratio
  for (let i = 0; i < gctSize; i++) {
    const rgb = i < palette.length ? palette[i]! : 0;
    w8((rgb >>> 16) & 0xff);
    w8((rgb >>> 8) & 0xff);
    w8(rgb & 0xff);
  }

  // NETSCAPE2.0 loop-forever extension.
  w8(0x21); w8(0xff); w8(0x0b);
  wStr('NETSCAPE2.0');
  w8(0x03); w8(0x01); w16(0); w8(0x00);

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi]!;
    const idx = indexed[fi]!;
    const delayCs = clamp(Math.round(f.delayMs / 10), 1, 65535);

    // Graphic Control Extension (delay + transparency).
    w8(0x21); w8(0xf9); w8(0x04);
    const disposal = 2; // restore to background
    w8((disposal << 2) | (hasTransparent ? 0x01 : 0x00));
    w16(delayCs);
    w8(hasTransparent ? transparentIndex : 0);
    w8(0x00);

    // Image Descriptor.
    w8(0x2c);
    w16(0); w16(0); // left, top
    w16(width); w16(height);
    w8(0x00); // no local colour table

    // LZW-compressed image data.
    const minCode = Math.max(2, bits);
    const lzw = lzwEncode(idx, minCode);
    w8(minCode);
    let p = 0;
    while (p < lzw.length) {
      const block = Math.min(255, lzw.length - p);
      w8(block);
      for (let i = 0; i < block; i++) w8(lzw[p + i]!);
      p += block;
    }
    w8(0x00); // block terminator
  }

  w8(0x3b); // trailer
  return new Uint8Array(out);
}

function nearestPaletteIndex(palette: number[], rgb: number): number {
  const r = (rgb >>> 16) & 0xff, g = (rgb >>> 8) & 0xff, b = rgb & 0xff;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    const dr = r - ((p >>> 16) & 0xff);
    const dg = g - ((p >>> 8) & 0xff);
    const db = b - (p & 0xff);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// GIF LZW compressor (variable-width codes, standard clear/EOI handling).
function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map<string, number>();
  const resetDict = () => {
    dict = new Map<string, number>();
    for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  resetDict();
  emit(clearCode);

  let prefix = String.fromCharCode(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i++) {
    const ch = String.fromCharCode(indices[i]!);
    const combined = prefix + ch;
    if (dict.has(combined)) {
      prefix = combined;
    } else {
      emit(dict.get(prefix)!);
      dict.set(combined, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
      if (nextCode > 4095) {
        emit(clearCode);
        resetDict();
      }
      prefix = ch;
    }
  }
  emit(dict.get(prefix)!);
  emit(eoiCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

// ── native save / open dialogs (desktop backend) ────────────────────────────
async function pickSavePath(baseName: string, ext: string, title: string): Promise<string | null> {
  const res = await runPowershell(
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d=New-Object System.Windows.Forms.SaveFileDialog; $d.Title='${psq(title)}'; ` +
      `$d.FileName='${psq(baseName)}.${ext}'; $d.Filter='${ext.toUpperCase()} (*.${ext})|*.${ext}|All files|*.*'; ` +
      `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
  );
  const p = res.stdout.trim();
  return p || null;
}
async function pickOpenPath(title: string): Promise<string | null> {
  const res = await runPowershell(
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(title)}'; ` +
      `$d.Filter='Images (*.png;*.gif;*.bmp;*.jpg;*.jpeg)|*.png;*.gif;*.bmp;*.jpg;*.jpeg|All files|*.*'; ` +
      `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
  );
  const p = res.stdout.trim();
  return p || null;
}
async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  const b64 = bytesToB64(bytes);
  const r = await runPowershell(
    `[IO.File]::WriteAllBytes('${psq(path)}', [Convert]::FromBase64String('${b64}')); 'OK'`,
  );
  if (!r.success && !r.stdout.includes('OK')) throw new Error(r.stderr.trim() || 'write failed');
}
async function readBytesFromPath(path: string): Promise<Uint8Array> {
  const r = await runPowershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psq(path)}'))`);
  const b64 = r.stdout.trim();
  if (!b64) throw new Error(r.stderr.trim() || 'read failed');
  return b64ToBytes(b64);
}

export function PixelEditorModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // ── document state ──
  const docRef = useRef<Doc>(newDoc(32, 32));
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const [afi, setAfi] = useState(0); // active frame index
  const [ali, setAli] = useState(0); // active layer index
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // ── undo / redo (snapshots of the whole doc; canvases are ≤256²) ──
  const undoRef = useRef<Doc[]>([]);
  const redoRef = useRef<Doc[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const syncUndo = useCallback(() => {
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);
  const cloneDoc = useCallback((d: Doc): Doc => ({ width: d.width, height: d.height, frames: d.frames.map(cloneFrame) }), []);
  const snapshot = useCallback(() => {
    undoRef.current.push(cloneDoc(docRef.current));
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
    syncUndo();
  }, [cloneDoc, syncUndo]);

  // ── tool / colour state ──
  const [tool, setTool] = useState<Tool>('pencil');
  const [primary, setPrimary] = useState<Packed>(BLACK);
  const [hexInput, setHexInput] = useState('#000000');
  const [palette, setPalette] = useState<string[]>(DEFAULT_PALETTE_HEX);
  const [recent, setRecent] = useState<Packed[]>([]);

  // ── view state ──
  const [zoom, setZoom] = useState(12);
  const [showGrid, setShowGrid] = useState(true);

  // ── new-canvas form ──
  const [newW, setNewW] = useState(32);
  const [newH, setNewH] = useState(32);

  // ── selection state (pixel coords) ──
  const selRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [selVer, setSelVer] = useState(0);
  const bumpSel = useCallback(() => setSelVer((v) => v + 1), []);
  const movingRef = useRef<{ startX: number; startY: number; dx: number; dy: number; grab: Uint32Array | null } | null>(null);

  // ── animation playback ──
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<{ timer: number; frame: number; resume: number } | null>(null);

  // ── native / status ──
  const [asepritePath, setAsepritePath] = useState<string | null>(null);
  const [asepriteChecked, setAsepriteChecked] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const drawingRef = useRef<boolean>(false);
  const strokeChangedRef = useRef<boolean>(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  const n = width * height;
  const activeFrame = docRef.current.frames[afi] ?? docRef.current.frames[0]!;
  const activeLayer = activeFrame.layers[ali] ?? activeFrame.layers[0]!;

  // ── colour helpers ──
  const setPrimaryColour = useCallback((p: Packed) => {
    setPrimary(p);
    setHexInput(packedToHex(p));
  }, []);
  const addRecent = useCallback((p: Packed) => {
    if ((p & 0xff) === 0) return;
    setRecent((prev) => [p, ...prev.filter((c) => c !== p)].slice(0, 12));
  }, []);

  // ── pixel ops on the active layer ──
  const idx = useCallback((x: number, y: number) => y * width + x, [width]);
  const inBounds = useCallback((x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height, [width, height]);

  const setPixel = useCallback((x: number, y: number, c: Packed) => {
    if (!inBounds(x, y)) return;
    const px = activeLayer.pixels;
    const i = idx(x, y);
    if (px[i] === c) return;
    px[i] = c >>> 0;
    strokeChangedRef.current = true;
  }, [inBounds, idx, activeLayer]);

  // Composited pixel (eyedropper reads the visible result).
  const getCompositePixel = useCallback((x: number, y: number): Packed => {
    if (!inBounds(x, y)) return TRANSPARENT;
    const i = idx(x, y);
    let out = 0;
    for (const l of activeFrame.layers) {
      if (!l.visible) continue;
      out = overRgba(l.pixels[i]!, out, l.opacity);
    }
    return out;
  }, [inBounds, idx, activeFrame]);

  const drawLine = useCallback((x0: number, y0: number, x1: number, y1: number, c: Packed) => {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    let guard = (dx + dy) * 4 + 8;
    while (guard-- > 0) {
      setPixel(cx, cy, c);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }, [setPixel]);

  const floodFill = useCallback((x: number, y: number, c: Packed): boolean => {
    if (!inBounds(x, y)) return false;
    const px = activeLayer.pixels;
    const target = px[idx(x, y)]!;
    if (target === (c >>> 0)) return false;
    const stack: Array<[number, number]> = [[x, y]];
    let guard = n + 16;
    while (stack.length > 0 && guard-- > 0) {
      const top = stack.pop();
      if (!top) break;
      const [cx, cy] = top;
      if (!inBounds(cx, cy)) continue;
      if (px[idx(cx, cy)] !== target) continue;
      px[idx(cx, cy)] = c >>> 0;
      strokeChangedRef.current = true;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    return true;
  }, [inBounds, idx, activeLayer, n]);

  // ── rendering ──
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const z = zoom;
    canvas.width = width * z;
    canvas.height = height * z;
    ctx.imageSmoothingEnabled = false;

    // Checkerboard behind transparency.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dark = (((x >> 1) + (y >> 1)) % 2) === 0;
        ctx.fillStyle = dark ? 'rgb(200,200,200)' : 'rgb(230,230,230)';
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
    // Composited pixels.
    const comp = compositeFrame(activeFrame, n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = comp[idx(x, y)]!;
        const a = p & 0xff;
        if (a === 0) continue;
        const r = (p >>> 24) & 0xff, g = (p >>> 16) & 0xff, b = (p >>> 8) & 0xff;
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
    // Grid.
    if (showGrid && z >= 6) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < width; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, height * z); }
      for (let y = 1; y < height; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(width * z, y * z + 0.5); }
      ctx.stroke();
    }
    // Selection overlay.
    const sel = selRef.current;
    if (sel) {
      const mv = movingRef.current;
      const dx = mv ? mv.dx : 0, dy = mv ? mv.dy : 0;
      const xa = Math.min(sel.x0, sel.x1) + dx, ya = Math.min(sel.y0, sel.y1) + dy;
      const xb = Math.max(sel.x0, sel.x1) + dx, yb = Math.max(sel.y0, sel.y1) + dy;
      ctx.save();
      ctx.strokeStyle = mv ? 'rgba(255,165,0,0.95)' : 'rgba(30,144,255,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(xa * z + 1, ya * z + 1, (xb - xa + 1) * z - 2, (yb - ya + 1) * z - 2);
      if (!mv) {
        ctx.fillStyle = 'rgba(30,144,255,0.15)';
        ctx.fillRect(xa * z, ya * z, (xb - xa + 1) * z, (yb - ya + 1) * z);
      }
      ctx.restore();
    }
  }, [zoom, width, height, showGrid, idx, activeFrame, n, selVer]);

  useEffect(() => { redraw(); }, [redraw, version]);

  // ── pointer handling ──
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

  const inSelection = useCallback((x: number, y: number): boolean => {
    const s = selRef.current;
    if (!s) return false;
    const xa = Math.min(s.x0, s.x1), xb = Math.max(s.x0, s.x1);
    const ya = Math.min(s.y0, s.y1), yb = Math.max(s.y0, s.y1);
    return x >= xa && x <= xb && y >= ya && y <= yb;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toPixel(e);
    if (!p) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    if (tool === 'eyedropper') {
      const c = getCompositePixel(p.x, p.y);
      if ((c & 0xff) !== 0) setPrimaryColour(c);
      return;
    }
    if (tool === 'select') {
      if (selRef.current && inSelection(p.x, p.y)) {
        // grab the selection block and start moving it
        const s = selRef.current;
        const xa = Math.min(s.x0, s.x1), ya = Math.min(s.y0, s.y1);
        const xb = Math.max(s.x0, s.x1), yb = Math.max(s.y0, s.y1);
        const w = xb - xa + 1, h = yb - ya + 1;
        const grab = new Uint32Array(w * h);
        const px = activeLayer.pixels;
        for (let yy = 0; yy < h; yy++)
          for (let xx = 0; xx < w; xx++)
            grab[yy * w + xx] = px[idx(xa + xx, ya + yy)]!;
        snapshot();
        movingRef.current = { startX: p.x, startY: p.y, dx: 0, dy: 0, grab };
        drawingRef.current = true;
      } else {
        selRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        movingRef.current = null;
        drawingRef.current = true;
        bumpSel();
      }
      return;
    }
    if (tool === 'fill') {
      snapshot();
      strokeChangedRef.current = false;
      const changed = floodFill(p.x, p.y, primary);
      if (changed && strokeChangedRef.current) { addRecent(primary); bump(); }
      else { undoRef.current.pop(); syncUndo(); }
      return;
    }
    // pencil / eraser
    snapshot();
    strokeChangedRef.current = false;
    drawingRef.current = true;
    lastRef.current = null;
    const c = tool === 'eraser' ? TRANSPARENT : primary;
    setPixel(p.x, p.y, c);
    lastRef.current = { x: p.x, y: p.y };
    if (tool === 'pencil') addRecent(primary);
    bump();
  }, [toPixel, tool, getCompositePixel, setPrimaryColour, inSelection, activeLayer, idx, snapshot, bumpSel, floodFill, primary, addRecent, bump, syncUndo, setPixel]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const p = toPixel(e);
    if (!p) return;

    if (tool === 'select') {
      const mv = movingRef.current;
      if (mv) {
        mv.dx = p.x - mv.startX;
        mv.dy = p.y - mv.startY;
        bumpSel();
      } else if (selRef.current) {
        selRef.current.x1 = p.x;
        selRef.current.y1 = p.y;
        bumpSel();
      }
      return;
    }
    if (tool === 'fill' || tool === 'eyedropper') return;

    const c = tool === 'eraser' ? TRANSPARENT : primary;
    const last = lastRef.current;
    if (last && (last.x !== p.x || last.y !== p.y)) drawLine(last.x, last.y, p.x, p.y, c);
    else setPixel(p.x, p.y, c);
    lastRef.current = { x: p.x, y: p.y };
    bump();
  }, [drawingRef, toPixel, tool, primary, drawLine, setPixel, bump, bumpSel]);

  const commitMove = useCallback(() => {
    const s = selRef.current;
    const mv = movingRef.current;
    if (!s || !mv || !mv.grab) { movingRef.current = null; return; }
    if (mv.dx !== 0 || mv.dy !== 0) {
      const xa = Math.min(s.x0, s.x1), ya = Math.min(s.y0, s.y1);
      const xb = Math.max(s.x0, s.x1), yb = Math.max(s.y0, s.y1);
      const w = xb - xa + 1, h = yb - ya + 1;
      // clear source
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          setPixel(xa + xx, ya + yy, TRANSPARENT);
      // paste at offset
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) {
          const c = mv.grab[yy * w + xx]!;
          setPixel(xa + xx + mv.dx, ya + yy + mv.dy, c);
        }
      selRef.current = { x0: s.x0 + mv.dx, y0: s.y0 + mv.dy, x1: s.x1 + mv.dx, y1: s.y1 + mv.dy };
      bump();
    } else {
      // no movement — drop the redundant snapshot
      undoRef.current.pop();
      syncUndo();
    }
    movingRef.current = null;
    bumpSel();
  }, [activeLayer, setPixel, bump, bumpSel, syncUndo]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current) {
      if (tool === 'select' && movingRef.current) commitMove();
      else if ((tool === 'pencil' || tool === 'eraser') && !strokeChangedRef.current) {
        // no-op stroke: drop the snapshot we pushed on down
        undoRef.current.pop();
        syncUndo();
      }
    }
    drawingRef.current = false;
    lastRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [tool, commitMove, syncUndo]);

  // ── undo / redo ──
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(cloneDoc(docRef.current));
    docRef.current = prev;
    setAfi((f) => clamp(f, 0, prev.frames.length - 1));
    setAli((l) => clamp(l, 0, (prev.frames[clamp(afi, 0, prev.frames.length - 1)]?.layers.length ?? 1) - 1));
    setWidth(prev.width); setHeight(prev.height);
    syncUndo();
    bump();
  }, [cloneDoc, syncUndo, bump, afi]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(cloneDoc(docRef.current));
    docRef.current = next;
    setAfi((f) => clamp(f, 0, next.frames.length - 1));
    setWidth(next.width); setHeight(next.height);
    syncUndo();
    bump();
  }, [cloneDoc, syncUndo, bump]);

  const deleteSelection = useCallback(() => {
    const s = selRef.current;
    if (!s) return;
    snapshot();
    strokeChangedRef.current = false;
    const xa = Math.min(s.x0, s.x1), ya = Math.min(s.y0, s.y1);
    const xb = Math.max(s.x0, s.x1), yb = Math.max(s.y0, s.y1);
    for (let yy = ya; yy <= yb; yy++)
      for (let xx = xa; xx <= xb; xx++)
        setPixel(xx, yy, TRANSPARENT);
    if (!strokeChangedRef.current) { undoRef.current.pop(); syncUndo(); }
    bump();
  }, [snapshot, setPixel, bump, syncUndo]);

  // ── toolbar actions ──
  const doNew = useCallback(() => {
    const w = clamp(Math.round(newW) || 32, 1, MAX_SIZE);
    const h = clamp(Math.round(newH) || 32, 1, MAX_SIZE);
    docRef.current = newDoc(w, h);
    undoRef.current = []; redoRef.current = [];
    setUndoCount(0); setRedoCount(0);
    selRef.current = null; movingRef.current = null;
    setWidth(w); setHeight(h); setAfi(0); setAli(0);
    setStatus(null); setLastSavedPath(null);
    bump();
  }, [newW, newH, bump]);

  const doClear = useCallback(() => {
    snapshot();
    activeLayer.pixels.fill(0);
    bump();
  }, [snapshot, activeLayer, bump]);

  const applyHex = useCallback(() => {
    const s = hexInput.replace('#', '').trim();
    if (/^[0-9a-fA-F]{6}$/.test(s)) setPrimaryColour(hexToPacked('#' + s));
  }, [hexInput, setPrimaryColour]);

  const addToPalette = useCallback(() => {
    const hex = packedToHex(primary);
    setPalette((prev) => (prev.includes(hex) ? prev : [...prev, hex]));
  }, [primary]);

  // ── layers ──
  const doAddLayer = useCallback(() => {
    snapshot();
    const d = docRef.current;
    const name = `Layer ${activeFrame.layers.length + 1}`;
    for (const f of d.frames) f.layers.push(newLayer(name, width, height));
    setAli(activeFrame.layers.length - 1);
    bump();
  }, [snapshot, activeFrame, width, height, bump]);

  const doDelLayer = useCallback(() => {
    if (activeFrame.layers.length <= 1) return;
    snapshot();
    const d = docRef.current;
    const i = ali;
    for (const f of d.frames) if (i < f.layers.length) f.layers.splice(i, 1);
    setAli((cur) => clamp(cur, 0, activeFrame.layers.length - 2));
    bump();
  }, [snapshot, activeFrame, ali, bump]);

  const moveLayer = useCallback((delta: number) => {
    const to = ali + delta;
    if (to < 0 || to >= activeFrame.layers.length) return;
    snapshot();
    const d = docRef.current;
    for (const f of d.frames) {
      if (ali < f.layers.length && to < f.layers.length) {
        const l = f.layers[ali]!;
        f.layers.splice(ali, 1);
        f.layers.splice(to, 0, l);
      }
    }
    setAli(to);
    bump();
  }, [ali, activeFrame, snapshot, bump]);

  const toggleLayerVisible = useCallback((li: number) => {
    const l = activeFrame.layers[li];
    if (!l) return;
    l.visible = !l.visible;
    bump();
  }, [activeFrame, bump]);

  const setLayerOpacity = useCallback((v: number) => {
    activeLayer.opacity = clamp(v, 0, 100) / 100;
    bump();
  }, [activeLayer, bump]);

  const renameLayer = useCallback((li: number, name: string) => {
    const l = activeFrame.layers[li];
    if (l) { l.name = name; bump(); }
  }, [activeFrame, bump]);

  // ── frames ──
  const doAddFrame = useCallback(() => {
    snapshot();
    const d = docRef.current;
    const src = activeFrame;
    const f: Frame = {
      delayMs: src.delayMs,
      layers: src.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, pixels: new Uint32Array(width * height) })),
    };
    d.frames.splice(afi + 1, 0, f);
    setAfi(afi + 1);
    bump();
  }, [snapshot, activeFrame, afi, width, height, bump]);

  const doDupFrame = useCallback(() => {
    snapshot();
    const d = docRef.current;
    d.frames.splice(afi + 1, 0, cloneFrame(activeFrame));
    setAfi(afi + 1);
    bump();
  }, [snapshot, activeFrame, afi, bump]);

  const doDelFrame = useCallback(() => {
    if (docRef.current.frames.length <= 1) return;
    snapshot();
    const d = docRef.current;
    d.frames.splice(afi, 1);
    setAfi((cur) => clamp(cur, 0, d.frames.length - 1));
    setAli((cur) => clamp(cur, 0, (d.frames[clamp(afi, 0, d.frames.length - 1)]?.layers.length ?? 1) - 1));
    bump();
  }, [snapshot, afi, bump]);

  const moveFrame = useCallback((delta: number) => {
    const to = afi + delta;
    if (to < 0 || to >= docRef.current.frames.length) return;
    snapshot();
    const d = docRef.current;
    const f = d.frames[afi]!;
    d.frames.splice(afi, 1);
    d.frames.splice(to, 0, f);
    setAfi(to);
    bump();
  }, [afi, snapshot, bump]);

  const setFrameDelay = useCallback((ms: number) => {
    activeFrame.delayMs = clamp(Math.round(ms) || 100, 10, 10000);
    bump();
  }, [activeFrame, bump]);

  const selectFrame = useCallback((i: number) => {
    setAfi(i);
    setAli((cur) => clamp(cur, 0, (docRef.current.frames[i]?.layers.length ?? 1) - 1));
    bump();
  }, [bump]);

  // ── animation playback ──
  const stopPlay = useCallback(() => {
    const p = playRef.current;
    if (p) {
      window.clearTimeout(p.timer);
      setAfi(p.resume);
      playRef.current = null;
    }
    setPlaying(false);
    bump();
  }, [bump]);

  const startPlay = useCallback(() => {
    const frames = docRef.current.frames;
    if (frames.length < 2) return;
    const step = (frame: number) => {
      setAfi(frame % frames.length);
      const delay = Math.max(10, frames[frame % frames.length]!.delayMs);
      const timer = window.setTimeout(() => step((frame + 1) % frames.length), delay);
      if (playRef.current) playRef.current.timer = timer;
    };
    playRef.current = { timer: 0, frame: afi, resume: afi };
    setPlaying(true);
    step(afi);
  }, [afi]);

  useEffect(() => () => { if (playRef.current) window.clearTimeout(playRef.current.timer); }, []);

  // ── PNG export (native save gated on click; browser download fallback) ──
  const buildPngBytes = useCallback((): Uint8Array | null => {
    if (typeof document === 'undefined') return null;
    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(width, height);
    const comp = compositeFrame(activeFrame, n);
    for (let i = 0; i < n; i++) {
      const p = comp[i]!;
      const o = i * 4;
      img.data[o] = (p >>> 24) & 0xff;
      img.data[o + 1] = (p >>> 16) & 0xff;
      img.data[o + 2] = (p >>> 8) & 0xff;
      img.data[o + 3] = p & 0xff;
    }
    ctx.putImageData(img, 0, 0);
    // toDataURL → bytes (synchronous, avoids async Blob plumbing).
    try {
      const url = off.toDataURL('image/png');
      return b64ToBytes(url.split(',')[1] ?? '');
    } catch {
      return null;
    }
  }, [width, height, activeFrame, n]);

  const exportPng = useCallback(async () => {
    const bytes = buildPngBytes();
    if (!bytes) { setStatus({ ok: false, text: t('pixeled.exportFailed') }); return; }
    const base = `sprite-frame${afi + 1}-${width}x${height}`;
    setBusy('png');
    setStatus(null);
    try {
      if (desktop) {
        const path = await pickSavePath(base, 'png', t('pixeled.exportPng'));
        if (!path) { setBusy(''); return; }
        await writeBytesToPath(path, bytes);
        setLastSavedPath(path);
        setStatus({ ok: true, text: t('pixeled.savedTo', { path }) });
      } else {
        downloadBlob(new Blob([bytes as BlobPart], { type: 'image/png' }), `${base}.png`);
        setStatus({ ok: true, text: t('pixeled.exportOk') });
      }
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [buildPngBytes, afi, width, height, desktop, t]);

  // ── GIF export (in-browser encoder, native save or browser download) ──
  const exportGif = useCallback(async () => {
    const d = docRef.current;
    setBusy('gif');
    setStatus(null);
    try {
      const gframes = d.frames.map((f) => ({ rgba: compositeFrame(f, n), delayMs: f.delayMs }));
      const bytes = encodeGif(width, height, gframes);
      const base = `sprite-${width}x${height}`;
      if (desktop) {
        const path = await pickSavePath(base, 'gif', t('pixeled.exportGif'));
        if (!path) { setBusy(''); return; }
        await writeBytesToPath(path, bytes);
        setLastSavedPath(path);
        setStatus({ ok: true, text: t('pixeled.gifSaved', { n: d.frames.length, path }) });
      } else {
        downloadBlob(new Blob([bytes as BlobPart], { type: 'image/gif' }), `${base}.gif`);
        setStatus({ ok: true, text: t('pixeled.gifOk', { n: d.frames.length }) });
      }
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [n, width, height, desktop, t]);

  // ── import image (native OpenFileDialog + read, or browser file input) ──
  const loadImageBytes = useCallback((bytes: Uint8Array, mime: string, name: string) => {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ow = img.naturalWidth, oh = img.naturalHeight;
      const scale = Math.min(1, MAX_SIZE / ow, MAX_SIZE / oh);
      const nw = Math.max(1, Math.round(ow * scale));
      const nh = Math.max(1, Math.round(oh * scale));
      const off = document.createElement('canvas');
      off.width = nw; off.height = nh;
      const ctx = off.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, nw, nh);
      const data = ctx.getImageData(0, 0, nw, nh).data;
      const doc = newDoc(nw, nh);
      const px = doc.frames[0]!.layers[0]!.pixels;
      for (let i = 0; i < nw * nh; i++) {
        const o = i * 4;
        px[i] = (((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0);
      }
      docRef.current = doc;
      undoRef.current = []; redoRef.current = [];
      setUndoCount(0); setRedoCount(0);
      selRef.current = null; movingRef.current = null;
      setWidth(nw); setHeight(nh); setAfi(0); setAli(0);
      setStatus({ ok: true, text: t('pixeled.imported', { w: nw, h: nh, name }) });
      bump();
    };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus({ ok: false, text: t('pixeled.importFailed') }); };
    img.src = url;
  }, [t, bump]);

  const mimeFor = (name: string): string => {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return 'image/png';
  };

  const doImport = useCallback(async () => {
    if (!desktop) { fileInputRef.current?.click(); return; }
    setBusy('import');
    setStatus(null);
    try {
      const path = await pickOpenPath(t('pixeled.importBtn'));
      if (!path) { setBusy(''); return; }
      const bytes = await readBytesFromPath(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      loadImageBytes(bytes, mimeFor(name), name);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [desktop, t, loadImageBytes]);

  const onBrowserFile = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      loadImageBytes(bytes, file.type || mimeFor(file.name), file.name);
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    }
  }, [loadImageBytes]);

  // ── Aseprite detect / launch (native, desktop only) ──
  const detectScript = useMemo(() => [
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
  ].join(' '), []);

  const detectAseprite = useCallback(async () => {
    if (!desktop) { setAsepriteChecked(true); return; }
    setBusy('detect');
    try {
      const res: CommandOutput = await runPowershell(detectScript);
      const out = (res.stdout || '').trim();
      setAsepritePath(out.length > 0 ? out.split(/\r?\n/)[0]!.trim() : null);
    } catch (e) {
      setAsepritePath(null);
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setAsepriteChecked(true);
      setBusy('');
    }
  }, [desktop, detectScript]);

  useEffect(() => { void detectAseprite(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const launchAseprite = useCallback(async () => {
    if (!desktop || !asepritePath) return;
    setBusy('launch');
    setStatus(null);
    try {
      const args = lastSavedPath ? [lastSavedPath] : [];
      const res = await runCommand(asepritePath, args);
      setStatus({ ok: res.success, text: res.success ? t('pixeled.launched') : (res.stderr.trim() || t('pixeled.launchFailed')) });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  }, [desktop, asepritePath, lastSavedPath, t]);

  // ── keyboard shortcuts (scoped to the editor root; ignore while typing) ──
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const tgt = e.target as HTMLElement;
    const typing = tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable;
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'b' || e.key === 'B') setTool('pencil');
    else if (e.key === 'e' || e.key === 'E') setTool('eraser');
    else if (e.key === 'g' || e.key === 'G') setTool('fill');
    else if (e.key === 'i' || e.key === 'I') setTool('eyedropper');
    else if (e.key === 'm' || e.key === 'M') setTool('select');
  }, [undo, redo, deleteSelection]);

  // ── derived UI data ──
  const tools: Array<{ id: Tool; label: string; hint: string }> = [
    { id: 'pencil', label: t('pixeled.pencil'), hint: `${t('pixeled.pencilHint')} · B` },
    { id: 'eraser', label: t('pixeled.eraser'), hint: `${t('pixeled.eraserHint')} · E` },
    { id: 'fill', label: t('pixeled.fill'), hint: `${t('pixeled.fillHint')} · G` },
    { id: 'eyedropper', label: t('pixeled.eyedropper'), hint: `${t('pixeled.eyedropperHint')} · I` },
    { id: 'select', label: t('pixeled.select'), hint: `${t('pixeled.selectHint')} · M` },
  ];

  const primaryHex = packedToHex(primary);
  const isTransparentPrimary = (primary & 0xff) === 0;
  const frameCount = docRef.current.frames.length;
  const layersTopFirst = activeFrame.layers.map((l, i) => ({ l, i })).reverse();

  return (
    <div className="mod" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
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
        <button className="mini" disabled={busy === 'import'} onClick={doImport}>{t('pixeled.importBtn')}</button>
        <button className="mini" onClick={doClear}>{t('pixeled.clear')}</button>
        <span style={{ width: 8 }} />
        <button className="mini" disabled={undoCount === 0} onClick={undo}>{t('pixeled.undo')}</button>
        <button className="mini" disabled={redoCount === 0} onClick={redo}>{t('pixeled.redo')}</button>
        <span style={{ width: 8 }} />
        <button className="mini primary" disabled={busy === 'png'} onClick={() => void exportPng()}>{t('pixeled.exportPng')}</button>
        <button className="mini" disabled={busy === 'gif'} onClick={() => void exportGif()}>{busy === 'gif' ? t('pixeled.exporting') : t('pixeled.exportGif')}</button>
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
        <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={zoom}
          onChange={(e) => setZoom(clamp(+e.target.value, MIN_ZOOM, MAX_ZOOM))}
          style={{ verticalAlign: 'middle' }} />
        <span className="value">{zoom}×</span>
        <label className="chk" style={{ marginLeft: 8 }}>
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          {t('pixeled.grid')}
        </label>
        <span className="count-note" style={{ marginLeft: 8 }}>{t('pixeled.size', { w: width, h: height })}</span>
      </div>

      <input ref={fileInputRef} type="file" accept="image/png,image/gif,image/bmp,image/jpeg"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onBrowserFile(f); e.target.value = ''; }} />

      <div className="io-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 240px', alignItems: 'start' }}>
        {/* Canvas */}
        <div className="panel" style={{ overflow: 'auto', maxHeight: 560 }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ cursor: tool === 'select' ? 'move' : 'crosshair', imageRendering: 'pixelated', touchAction: 'none', display: 'block' }}
          />
        </div>

        {/* Side panels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Colour + palette */}
          <div className="panel">
            <div className="kv-list">
              <div className="kv-row">
                <span className="label">{t('pixeled.colour')}</span>
                <span className="value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span aria-hidden style={{
                    display: 'inline-block', width: 20, height: 20, borderRadius: 4,
                    border: '1px solid var(--border, #999)',
                    ...swatchStyle(isTransparentPrimary ? '' : primaryHex),
                  }} />
                  <code>{isTransparentPrimary ? t('pixeled.transparent') : primaryHex}</code>
                </span>
              </div>
            </div>

            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <input className="mod-search" style={{ maxWidth: 100 }} value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyHex()} placeholder="#RRGGBB" />
              <input type="color" value={isTransparentPrimary ? '#000000' : primaryHex}
                onChange={(e) => setPrimaryColour(hexToPacked(e.target.value))}
                title={t('pixeled.pickColour')}
                style={{ width: 34, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
              <button className="mini" onClick={applyHex}>{t('pixeled.setHex')}</button>
            </div>
            <button className="mini" style={{ marginBottom: 8 }} onClick={addToPalette}>{t('pixeled.addToPalette')}</button>

            <div className="label" style={{ marginBottom: 4 }}>{t('pixeled.palette')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
              {palette.map((hex, i) => (
                <button key={`${hex}-${i}`} title={hex ? hex : t('pixeled.transparent')}
                  onClick={() => setPrimaryColour(hex ? hexToPacked(hex) : TRANSPARENT)}
                  style={{ width: 22, height: 22, borderRadius: 3, padding: 0, cursor: 'pointer', border: '1px solid var(--border, #999)', ...swatchStyle(hex) }} />
              ))}
            </div>

            {recent.length > 0 && (
              <>
                <div className="label" style={{ marginBottom: 4 }}>{t('pixeled.recent')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                  {recent.map((p, i) => (
                    <button key={`${p}-${i}`} title={packedToHex(p)} onClick={() => setPrimaryColour(p)}
                      style={{ width: 18, height: 18, borderRadius: 3, padding: 0, cursor: 'pointer', border: '1px solid var(--border, #999)', ...swatchStyle(packedToHex(p)) }} />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Layers */}
          <div className="panel">
            <div className="dt-wrap" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="label">{t('pixeled.layers')}</span>
              <span className="row-actions">
                <button className="mini" title={t('pixeled.addLayer')} onClick={doAddLayer}>+</button>
                <button className="mini" title={t('pixeled.layerUp')} disabled={ali >= activeFrame.layers.length - 1} onClick={() => moveLayer(1)}>↑</button>
                <button className="mini" title={t('pixeled.layerDown')} disabled={ali <= 0} onClick={() => moveLayer(-1)}>↓</button>
                <button className="mini" title={t('pixeled.delLayer')} disabled={activeFrame.layers.length <= 1} onClick={doDelLayer}>✕</button>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflow: 'auto' }}>
              {layersTopFirst.map(({ l, i }) => (
                <div key={i} onClick={() => setAli(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
                    background: i === ali ? 'var(--accent-soft, rgba(30,144,255,0.16))' : 'transparent',
                  }}>
                  <input type="checkbox" checked={l.visible} onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleLayerVisible(i)} title={t('pixeled.toggleVisible')} />
                  <input className="mod-search" value={l.name} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => renameLayer(i, e.target.value)}
                    style={{ flex: 1, minWidth: 0, height: 22, fontSize: 12 }} />
                </div>
              ))}
            </div>
            <div className="mod-toolbar" style={{ marginTop: 6 }}>
              <label className="label">{t('pixeled.opacity')}</label>
              <input type="range" min={0} max={100} value={Math.round(activeLayer.opacity * 100)}
                onChange={(e) => setLayerOpacity(+e.target.value)} />
              <span className="value">{Math.round(activeLayer.opacity * 100)}%</span>
            </div>
          </div>

          {/* Frames */}
          <div className="panel">
            <div className="dt-wrap" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="label">{t('pixeled.frames')}</span>
              <span className="row-actions">
                <button className="mini" title={t('pixeled.addFrame')} onClick={doAddFrame}>+</button>
                <button className="mini" title={t('pixeled.dupFrame')} onClick={doDupFrame}>⧉</button>
                <button className="mini" title={t('pixeled.frameLeft')} disabled={afi <= 0} onClick={() => moveFrame(-1)}>◀</button>
                <button className="mini" title={t('pixeled.frameRight')} disabled={afi >= frameCount - 1} onClick={() => moveFrame(1)}>▶</button>
                <button className="mini" title={t('pixeled.delFrame')} disabled={frameCount <= 1} onClick={doDelFrame}>✕</button>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflow: 'auto' }}>
              {docRef.current.frames.map((f, i) => (
                <div key={i} onClick={() => selectFrame(i)}
                  style={{
                    padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                    background: i === afi ? 'var(--accent-soft, rgba(30,144,255,0.16))' : 'transparent',
                  }}>
                  {t('pixeled.frameLabel', { n: i + 1 })} · {f.delayMs} ms
                </div>
              ))}
            </div>
            <div className="mod-toolbar" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <label className="label">{t('pixeled.delay')}</label>
              <input className="mod-search" type="number" min={10} max={10000} step={10} style={{ maxWidth: 90 }}
                value={activeFrame.delayMs} onChange={(e) => setFrameDelay(+e.target.value)} />
              <button className="mini" disabled={frameCount < 2} onClick={() => (playing ? stopPlay() : startPlay())}>
                {playing ? t('pixeled.stop') : t('pixeled.play')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Native: Aseprite detect / launch */}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="dt-wrap"><span className="label">{t('pixeled.asepriteTitle')}</span></div>
        {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('pixeled.desktopOnly')}</p>}
        {desktop && (
          <>
            {!asepriteChecked && <p className="count-note">{t('pixeled.detecting')}</p>}
            {asepriteChecked && asepritePath && <p className="dep-ok">✓ {t('pixeled.asepriteFound')} · <code>{asepritePath}</code></p>}
            {asepriteChecked && !asepritePath && <p className="dep-missing">⚠ {t('pixeled.asepriteMissing')}</p>}
            <div className="mod-toolbar">
              <button className="mini primary" disabled={!asepritePath || busy === 'launch'} onClick={() => void launchAseprite()}>
                {busy === 'launch' ? t('pixeled.launching') : t('pixeled.launchAseprite')}
              </button>
              <button className="mini" disabled={busy === 'detect'} onClick={() => void detectAseprite()}>
                ⟳ {busy === 'detect' ? t('pixeled.detecting') : t('pixeled.rescan')}
              </button>
            </div>
          </>
        )}
      </div>

      {status && <pre className={`cmd-out${status.ok ? '' : ' error'}`}>{status.text}</pre>}
      <p className="count-note">{t('pixeled.footNote')}</p>
    </div>
  );
}
