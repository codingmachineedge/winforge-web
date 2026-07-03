import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Native module — Rich Preview · 豐富預覽.
// Faithful port of WinForge's RichPreviewModule: an in-app clone of the PowerToys
// File Explorer add-ons / Preview Pane handler set. Pick a file (by path) and it
// classifies the file by type — SVG, Markdown, PDF, source code, developer data
// (JSON/XML/YAML/TOML), G-code, QOI and ordinary raster images — reads it through the
// native backend, and renders a type-aware preview. Prev/next walks the folder.
//
// True system-wide Explorer preview-pane integration needs a registered COM shell
// extension, which the web/unpackaged build can't provide — a note explains this and
// surfaces the relevant Windows commands, exactly like the C# Settings panel.
//
// This is a built-in OS capability (reads files, no external CLI tool), so all live
// actions are gated on isTauri(); in a plain browser we render the full type catalog,
// toggles and this note, but the read/preview actions require the desktop app.

// ===================== type registry (mirrors RichPreviewService.Types) =====================

type Kind =
  | 'svg'
  | 'markdown'
  | 'pdf'
  | 'developer'
  | 'code'
  | 'gcode'
  | 'qoi'
  | 'image';

interface PreviewType {
  id: string;
  kind: Kind;
  en: string;
  zh: string;
  exts: string[];
}

const TYPES: PreviewType[] = [
  { id: 'svg', kind: 'svg', en: 'SVG vector images', zh: 'SVG 向量圖', exts: ['.svg', '.svgz'] },
  {
    id: 'markdown',
    kind: 'markdown',
    en: 'Markdown documents',
    zh: 'Markdown 文件',
    exts: ['.md', '.markdown', '.mdown', '.mkd', '.mdwn', '.mdtxt'],
  },
  { id: 'pdf', kind: 'pdf', en: 'PDF documents', zh: 'PDF 文件', exts: ['.pdf'] },
  {
    id: 'developer',
    kind: 'developer',
    en: 'Developer data (JSON / XML / YAML / TOML)',
    zh: '開發者資料（JSON／XML／YAML／TOML）',
    exts: ['.json', '.jsonc', '.json5', '.xml', '.xaml', '.csproj', '.props', '.targets', '.yaml', '.yml', '.toml'],
  },
  {
    id: 'code',
    kind: 'code',
    en: 'Source code & dev files',
    zh: '原始碼與開發檔',
    exts: [
      '.cs', '.c', '.h', '.cpp', '.hpp', '.cc', '.java', '.js', '.jsx', '.ts', '.tsx',
      '.py', '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.kts', '.scala', '.sh',
      '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.lua', '.pl', '.r',
      '.dart', '.vb', '.fs', '.fsx', '.clj', '.ex', '.exs', '.elm', '.hs', '.m', '.mm',
      '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro',
      '.ini', '.cfg', '.conf', '.env', '.gitignore', '.dockerfile', '.makefile',
      '.gradle', '.cmake', '.txt', '.log', '.csv', '.tsv', '.diff', '.patch',
    ],
  },
  { id: 'gcode', kind: 'gcode', en: 'G-code (3D printing)', zh: 'G-code（3D 列印）', exts: ['.gcode', '.gco', '.g', '.nc'] },
  { id: 'qoi', kind: 'qoi', en: 'QOI images', zh: 'QOI 影像', exts: ['.qoi'] },
  {
    id: 'image',
    kind: 'image',
    en: 'Raster images',
    zh: '點陣圖',
    exts: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff'],
  },
];

// extension-less dev files by name (mirrors Classify)
const NAMELESS_CODE = new Set([
  'makefile',
  'dockerfile',
  'cmakelists.txt',
  '.gitignore',
  '.env',
  '.editorconfig',
  'license',
  'readme',
]);

function baseName(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function dirName(path: string): string {
  const norm = path.replace(/\//g, '\\');
  const idx = norm.lastIndexOf('\\');
  return idx > 0 ? norm.slice(0, idx) : '';
}

function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

// Resolve a preview type for a path, optionally honouring the enable toggles.
function classify(path: string, enabled: Record<string, boolean>, honourToggles: boolean): PreviewType | null {
  const ext = extOf(path);
  if (!ext) {
    const name = baseName(path).toLowerCase();
    if (NAMELESS_CODE.has(name)) {
      const code = TYPES.find((t) => t.kind === 'code');
      if (code && (!honourToggles || enabled[code.id])) return code;
      return null;
    }
  }
  const match = TYPES.find((t) => t.exts.includes(ext));
  if (!match) return null;
  if (honourToggles && !enabled[match.id]) return null;
  return match;
}

function enabledExtensions(enabled: Record<string, boolean>): string[] {
  const out = new Set<string>();
  for (const t of TYPES) {
    if (enabled[t.id]) for (const e of t.exts) out.add(e);
  }
  return [...out];
}

function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let s = bytes;
  let i = 0;
  while (s >= 1024 && i < u.length - 1) {
    s /= 1024;
    i++;
  }
  const unit = u[i] ?? 'B';
  return i === 0 ? `${bytes} ${unit}` : `${s.toFixed(2)} ${unit}`;
}

// Escape a path for single-quoted PowerShell.
const psq = (s: string) => s.replace(/'/g, "''");

interface FileMeta {
  name: string;
  size: number;
  modified: string;
  folder: string;
  exists: boolean;
}

interface PreviewResult {
  meta: FileMeta;
  type: PreviewType | null;
  kind: Kind | 'unsupported';
  text: string; // decoded text (code/markdown/svg/developer/gcode) — empty for image/pdf/qoi
  truncated: boolean;
  dims?: string; // for images
  gcode?: { lines: number; layers: number; maxZ: string; slicer: string };
}

const TEXT_CAP = 400 * 1024; // cap the text we pull back over the bridge

export function RichPreviewModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [path, setPath] = useState('');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const ty of TYPES) init[ty.id] = true;
    return init;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const toggle = (id: string) => setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));

  // Load sibling previewable files in the same folder (sorted), honouring toggles.
  const loadSiblings = async (target: string): Promise<{ list: string[]; idx: number }> => {
    const dir = dirName(target);
    if (!dir) return { list: [target], idx: 0 };
    const exts = enabledExtensions(enabled);
    if (exts.length === 0) return { list: [target], idx: 0 };
    try {
      const script =
        `Get-ChildItem -LiteralPath '${psq(dir)}' -File -Force | ` +
        `Select-Object -ExpandProperty FullName`;
      const rows = await runPowershellJson<string>(script);
      const all = rows.filter((f): f is string => typeof f === 'string');
      const matched = all
        .filter((f) => exts.includes(extOf(f)))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      if (matched.length === 0) return { list: [target], idx: 0 };
      const has = matched.some((f) => f.toLowerCase() === target.toLowerCase());
      const list = has ? matched : [target, ...matched];
      let idx = list.findIndex((f) => f.toLowerCase() === target.toLowerCase());
      if (idx < 0) idx = 0;
      return { list, idx };
    } catch {
      return { list: [target], idx: 0 };
    }
  };

  // Render (read + classify) a single file through the native backend.
  const renderFile = async (target: string): Promise<PreviewResult> => {
    const type = classify(target, enabled, false);
    const kind: Kind | 'unsupported' = type ? type.kind : 'unsupported';

    // metadata via PowerShell
    let meta: FileMeta = {
      name: baseName(target),
      size: 0,
      modified: '',
      folder: dirName(target),
      exists: false,
    };
    try {
      const metaScript =
        `$i = Get-Item -LiteralPath '${psq(target)}' -Force -ErrorAction Stop; ` +
        `[pscustomobject]@{ name=$i.Name; size=[long]$i.Length; ` +
        `modified=$i.LastWriteTime.ToString('yyyy-MM-dd HH:mm'); folder=$i.DirectoryName; exists=$true }`;
      const rows = await runPowershellJson<FileMeta>(metaScript);
      const first = rows[0];
      if (first) meta = { ...meta, ...first, name: first.name || meta.name };
    } catch {
      // leave defaults; exists stays false
    }

    const res: PreviewResult = { meta, type, kind, text: '', truncated: false };

    // text-backed kinds → read capped UTF-8 text
    if (kind === 'svg' || kind === 'markdown' || kind === 'developer' || kind === 'code' || kind === 'gcode') {
      try {
        const readScript =
          `$b = [System.IO.File]::ReadAllBytes('${psq(target)}'); ` +
          `$cap = ${TEXT_CAP}; $trunc = $b.Length -gt $cap; ` +
          `$take = [Math]::Min($b.Length, $cap); ` +
          `$start = 0; if ($take -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) { $start = 3 }; ` +
          `$txt = [System.Text.Encoding]::UTF8.GetString($b, $start, $take - $start); ` +
          `[pscustomobject]@{ text=$txt; truncated=$trunc }`;
        const rows = await runPowershellJson<{ text: string; truncated: boolean }>(readScript);
        const first = rows[0];
        if (first) {
          res.text = typeof first.text === 'string' ? first.text : '';
          res.truncated = !!first.truncated;
        }
      } catch (e) {
        throw new Error(String(e instanceof Error ? e.message : e));
      }
      if (kind === 'gcode') res.gcode = analyzeGcode(res.text);
    } else if (kind === 'image') {
      // pull pixel dimensions via System.Drawing
      try {
        const dimScript =
          `Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue; ` +
          `try { $img = [System.Drawing.Image]::FromFile('${psq(target)}'); ` +
          `$d = '{0} x {1}' -f $img.Width, $img.Height; $img.Dispose(); ` +
          `[pscustomobject]@{ dims=$d } } catch { [pscustomobject]@{ dims='' } }`;
        const rows = await runPowershellJson<{ dims: string }>(dimScript);
        const first = rows[0];
        if (first && first.dims) res.dims = first.dims;
      } catch {
        // dimensions are best-effort
      }
    }
    // pdf / qoi: metadata only (no inline decode in the web port)

    return res;
  };

  const load = async (target: string, keepSiblings = false) => {
    const trimmed = target.trim();
    if (!trimmed || !desktop || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (!keepSiblings) {
        const sib = await loadSiblings(trimmed);
        setSiblings(sib.list);
        setIndex(sib.idx);
      }
      const r = await renderFile(trimmed);
      setResult(r);
      setPath(trimmed);
      if (r.truncated) setNote(t('richprev.truncated'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const step = async (delta: number) => {
    if (siblings.length < 2 || busy) return;
    const next = (index + delta + siblings.length) % siblings.length;
    const target = siblings[next];
    if (!target) return;
    setIndex(next);
    await load(target, true);
  };

  const copyToClipboard = async (text: string, msgKey: string) => {
    if (!desktop) return;
    try {
      await runPowershell(`Set-Clipboard -Value '${psq(text)}'`);
      setNote(t(msgKey));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const showInFolder = async () => {
    if (!desktop || !result) return;
    try {
      await runPowershell(`explorer.exe /select,'${psq(path)}'`);
      setNote(t('richprev.revealed'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const openFolderOptions = async () => {
    if (!desktop) {
      setNote(t('richprev.sysHintCopy'));
      return;
    }
    try {
      await runPowershell('control.exe folders');
      setNote(t('richprev.sysOpened'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const hasSiblings = siblings.length > 1;
  const position = result ? (hasSiblings ? `${index + 1} / ${siblings.length}` : '1 / 1') : '';

  const typeLabel = (ty: PreviewType | null) =>
    ty ? t(`richprev.type_${ty.id}`) : t('richprev.unsupported');

  return (
    <div className="mod">
      <p className="count-note">{t('richprev.blurb')}</p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('richprev.desktopOnly')}
        </p>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ minWidth: 280, flex: 1 }}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(path)}
          placeholder={t('richprev.pathPlaceholder')}
        />
        <button className="mini primary" disabled={!desktop || busy || !path.trim()} onClick={() => load(path)}>
          {busy ? t('richprev.loading') : t('richprev.preview')}
        </button>
        <button className="mini" disabled={!hasSiblings || busy} onClick={() => step(-1)}>
          ‹ {t('richprev.prev')}
        </button>
        <button className="mini" disabled={!hasSiblings || busy} onClick={() => step(1)}>
          {t('richprev.next')} ›
        </button>
        {position && <span className="count-note">{position}</span>}
        <button className="mini" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? t('richprev.closeSettings') : t('richprev.settings')}
        </button>
      </div>

      {result && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 0 }}>
          <button className="mini" disabled={!desktop} onClick={() => copyToClipboard(path, 'richprev.pathCopied')}>
            {t('richprev.copyPath')}
          </button>
          <button
            className="mini"
            disabled={!desktop}
            onClick={() => copyToClipboard(result.meta.folder || dirName(path), 'richprev.folderCopied')}
          >
            {t('richprev.copyFolder')}
          </button>
          <button className="mini" disabled={!desktop} onClick={showInFolder}>
            {t('richprev.showInFolder')}
          </button>
        </div>
      )}

      {err && <pre className="cmd-out error">{err}</pre>}
      {note && (
        <p className="dep-ok" style={{ marginTop: 4 }}>
          {note}
        </p>
      )}

      {showSettings ? (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="label" style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('richprev.settingsTitle')}
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('richprev.settingsIntro')}
          </p>
          <div className="kv-list">
            {TYPES.map((ty) => (
              <label className="kv-row chk" key={ty.id} style={{ alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!enabled[ty.id]} onChange={() => toggle(ty.id)} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="label" style={{ fontWeight: 600 }}>
                    {typeLabel(ty)}
                  </div>
                  <div className="value" style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.8 }}>
                    {ty.exts.slice(0, 10).join('  ')}
                    {ty.exts.length > 10 ? '  …' : ''}
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div className="label" style={{ fontWeight: 600, margin: '12px 0 4px' }}>
            {t('richprev.sysTitle')}
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('richprev.sysBlurb')}
          </p>
          <div className="mod-toolbar">
            <button className="mini" onClick={openFolderOptions}>
              {t('richprev.openFolderOptions')}
            </button>
          </div>
          <p className="count-note">{t('richprev.sysHint')}</p>
        </div>
      ) : (
        <>
          {!result && !err && !busy && (
            <div className="panel" style={{ marginTop: 10 }}>
              <div className="dt-wrap" style={{ textAlign: 'center', padding: 20 }}>
                <div className="label" style={{ fontWeight: 600 }}>
                  {t('richprev.emptyTitle')}
                </div>
                <p className="count-note">{t('richprev.emptyBlurb')}</p>
              </div>
            </div>
          )}

          {result && (
            <>
              <div className="panel" style={{ marginTop: 10 }}>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="label">{t('richprev.metaName')}</span>
                    <span className="value" style={{ fontFamily: 'monospace' }}>
                      {result.meta.name}
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="label">{t('richprev.metaType')}</span>
                    <span className="value">{typeLabel(result.type)}</span>
                  </div>
                  <div className="kv-row">
                    <span className="label">{t('richprev.metaSize')}</span>
                    <span className="value">{humanSize(result.meta.size)}</span>
                  </div>
                  {result.meta.modified && (
                    <div className="kv-row">
                      <span className="label">{t('richprev.metaModified')}</span>
                      <span className="value">{result.meta.modified}</span>
                    </div>
                  )}
                  <div className="kv-row">
                    <span className="label">{t('richprev.metaExt')}</span>
                    <span className="value">{extOf(path).replace('.', '').toUpperCase() || '—'}</span>
                  </div>
                  <div className="kv-row">
                    <span className="label">{t('richprev.metaFolder')}</span>
                    <span className="value" style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {result.meta.folder || dirName(path)}
                    </span>
                  </div>
                  {result.dims && (
                    <div className="kv-row">
                      <span className="label">{t('richprev.metaDims')}</span>
                      <span className="value">{result.dims}</span>
                    </div>
                  )}
                  {result.gcode && (
                    <>
                      <div className="kv-row">
                        <span className="label">{t('richprev.gcodeLines')}</span>
                        <span className="value">{result.gcode.lines.toLocaleString()}</span>
                      </div>
                      {result.gcode.layers > 0 && (
                        <div className="kv-row">
                          <span className="label">{t('richprev.gcodeLayers')}</span>
                          <span className="value">{result.gcode.layers.toLocaleString()}</span>
                        </div>
                      )}
                      {result.gcode.maxZ && (
                        <div className="kv-row">
                          <span className="label">{t('richprev.gcodeHeight')}</span>
                          <span className="value">{result.gcode.maxZ} mm</span>
                        </div>
                      )}
                      {result.gcode.slicer && (
                        <div className="kv-row">
                          <span className="label">{t('richprev.gcodeSlicer')}</span>
                          <span className="value">{result.gcode.slicer}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="panel" style={{ marginTop: 10 }}>
                <div className="label" style={{ fontWeight: 600, marginBottom: 6 }}>
                  {t('richprev.previewLabel')}
                </div>
                {renderPreview(result, t)}
              </div>
            </>
          )}
        </>
      )}

      <p className="count-note" style={{ marginTop: 10 }}>
        {t('richprev.note')}
      </p>
    </div>
  );
}

// ===================== preview body =====================

function renderPreview(res: PreviewResult, t: (k: string) => string) {
  switch (res.kind) {
    case 'svg':
      return <SvgPreview svg={res.text} />;
    case 'markdown':
    case 'developer':
    case 'code':
    case 'gcode':
      return <pre className="cmd-out">{res.text || t('richprev.emptyFile')}</pre>;
    case 'image':
      return <p className="count-note">{t('richprev.imageNote')}</p>;
    case 'pdf':
      return <p className="count-note">{t('richprev.pdfNote')}</p>;
    case 'qoi':
      return <p className="count-note">{t('richprev.qoiNote')}</p>;
    default:
      return <p className="count-note">{t('richprev.unsupportedNote')}</p>;
  }
}

// Sanitize + inline an SVG (strip <script> and on* handlers), mirroring SvgHostHtml.
function SvgPreview({ svg }: { svg: string }) {
  const clean = useMemo(() => {
    let s = svg;
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    return s;
  }, [svg]);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 160,
        maxHeight: 400,
        overflow: 'auto',
        background:
          'repeating-conic-gradient(#0000000d 0% 25%, transparent 0% 50%) 50% / 20px 20px',
      }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

// ===================== G-code stats (subset of AnalyzeGcode) =====================

function analyzeGcode(text: string): { lines: number; layers: number; maxZ: string; slicer: string } {
  const rows = text.split('\n');
  let layers = 0;
  let maxZ: number | null = null;
  let slicer = '';
  for (const raw of rows) {
    const line = raw.trim();
    if (
      /^;LAYER:/i.test(line) ||
      /^; layer /i.test(line) ||
      /^;LAYER_CHANGE$/i.test(line) ||
      /^;BEFORE_LAYER_CHANGE/i.test(line)
    ) {
      layers++;
    }
    const lc = /;\s*(LAYER_COUNT|total layers? count)\s*[:=]\s*(\d+)/i.exec(line);
    if (lc && lc[2]) {
      const v = parseInt(lc[2], 10);
      if (!Number.isNaN(v)) layers = Math.max(layers, v);
    }
    if (!slicer) {
      if (/PrusaSlicer/i.test(line)) slicer = 'PrusaSlicer';
      else if (/OrcaSlicer/i.test(line)) slicer = 'OrcaSlicer';
      else if (/SuperSlicer/i.test(line)) slicer = 'SuperSlicer';
      else if (/Cura/i.test(line)) slicer = 'Cura';
    }
    if (/^G[01]/i.test(line)) {
      const zm = /\bZ([\d.]+)/i.exec(line);
      if (zm && zm[1]) {
        const z = parseFloat(zm[1]);
        if (!Number.isNaN(z)) maxZ = maxZ === null ? z : Math.max(maxZ, z);
      }
    }
  }
  return {
    lines: rows.length,
    layers,
    maxZ: maxZ === null ? '' : maxZ.toFixed(2),
    slicer,
  };
}
