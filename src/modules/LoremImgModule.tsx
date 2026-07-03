import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ===== port of WinForge.Services.LoremImgService (pure client) =====

function normalizeHex(hex: string, fallback: string): string {
  try {
    if (!hex || !hex.trim()) return fallback;
    let s = hex.trim();
    if (s.startsWith('#')) s = s.slice(1);
    if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!; // #abc -> #aabbcc
    if (s.length === 8) s = s.slice(2); // strip AA from AARRGGBB
    if (s.length !== 6) return fallback;
    for (const c of s) if (!/[0-9a-fA-F]/.test(c)) return fallback;
    return '#' + s.toUpperCase();
  } catch {
    return fallback;
  }
}

function xmlEscape(s: string): string {
  let out = '';
  for (const c of s) {
    switch (c) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&apos;'; break;
      default: out += c; break;
    }
  }
  return out;
}

// C# "0.##" invariant formatting: up to 2 decimals, trailing zeros stripped.
function fmtFont(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

function buildSvg(w: number, h: number, bg: string, fg: string, label: string, fontSize: number): string {
  const fs = fmtFont(fontSize);
  const safeLabel = xmlEscape(label);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
    `  <rect width="${w}" height="${h}" fill="${bg}"/>\n` +
    `  <text x="50%" y="50%" fill="${fg}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="600" text-anchor="middle" dominant-baseline="central">${safeLabel}</text>\n` +
    `</svg>`
  );
}

function buildDataUri(svg: string): string {
  try {
    // UTF-8 safe base64
    const bytes = new TextEncoder().encode(svg);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'data:image/svg+xml;base64,' + btoa(bin);
  } catch {
    return 'data:image/svg+xml;base64,';
  }
}

// Mirror LoremImgService.Clamp: out-of-range width/height fall back / clamp.
function clampSize(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.round(v);
  if (n < lo || n > hi) return n < lo ? (n <= 0 ? fallback : lo) : hi;
  return n;
}

interface BuildResult {
  svg: string;
  dataUri: string;
  picsumUrl: string;
  bg: string;
  fg: string;
  w: number;
  h: number;
  label: string;
  fontSize: number;
}

function build(width: number, height: number, bgHex: string, fgHex: string, rawLabel: string, rawFont: number): BuildResult {
  const w = clampSize(width, 1, 10000, 640);
  const h = clampSize(height, 1, 10000, 480);
  const bg = normalizeHex(bgHex, '#DDDDDD');
  const fg = normalizeHex(fgHex, '#555555');
  let fontSize = rawFont;
  if (!Number.isFinite(fontSize) || fontSize <= 0) fontSize = Math.max(10, Math.min(w, h) / 6.0);
  fontSize = Math.min(2000, Math.max(1, fontSize));

  let label = rawLabel;
  if (!label || !label.trim()) label = w + '×' + h; // W×H
  label = label.trim();

  const svg = buildSvg(w, h, bg, fg, label, fontSize);
  return {
    svg,
    dataUri: buildDataUri(svg),
    picsumUrl: 'https://picsum.photos/' + w + '/' + h,
    bg,
    fg,
    w,
    h,
    label,
    fontSize,
  };
}

// ===== module =====

export function LoremImgModule() {
  const { t } = useTranslation();
  const [width, setWidth] = useState('640');
  const [height, setHeight] = useState('480');
  const [font, setFont] = useState('0');
  const [bg, setBg] = useState('#DDDDDD');
  const [fg, setFg] = useState('#555555');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const result = useMemo(() => {
    const w = width.trim() === '' ? 640 : Number(width);
    const h = height.trim() === '' ? 480 : Number(height);
    const fs = font.trim() === '' ? 0 : Number(font);
    return build(Number.isNaN(w) ? 640 : w, Number.isNaN(h) ? 480 : h, bg, fg, label, Number.isNaN(fs) ? 0 : fs);
  }, [width, height, font, bg, fg, label]);

  // Live preview scaling — fit within 360×260, never upscale (matches WinForge).
  const preview = useMemo(() => {
    const maxW = 360;
    const maxH = 260;
    let scale = Math.min(maxW / result.w, maxH / result.h);
    if (scale > 1) scale = 1;
    const pw = Math.max(24, Math.round(result.w * scale));
    const ph = Math.max(24, Math.round(result.h * scale));
    let fs = result.fontSize;
    const previewFs = Math.min(200, Math.max(6, fs * scale));
    return { pw, ph, fs: previewFs };
  }, [result]);

  const copy = (text: string, okText: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setMsg({ ok: true, text: okText });
    } catch {
      setMsg({ ok: false, text: t('loremimg.clipUnavailable') });
    }
  };

  const save = () => {
    try {
      const name = `placeholder-${result.w}x${result.h}.svg`;
      const blob = new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg({ ok: true, text: t('loremimg.saved', { name }) });
    } catch {
      setMsg({ ok: false, text: t('loremimg.saveFailed') });
    }
  };

  const numField = (labelText: string, value: string, set: (v: string) => void, min: number, max: number) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="count-note" style={{ margin: 0 }}>{labelText}</span>
      <input
        className="mod-search"
        type="number"
        min={min}
        max={max}
        style={{ maxWidth: 150 }}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('loremimg.blurb')}</p>

      {/* Settings */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
        {numField(t('loremimg.width'), width, setWidth, 1, 10000)}
        {numField(t('loremimg.height'), height, setHeight, 1, 10000)}
        {numField(t('loremimg.font'), font, setFont, 0, 2000)}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('loremimg.bg')}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="color" value={result.bg} onChange={(e) => setBg(e.target.value)} style={{ width: 34, height: 30, padding: 0, border: 'none', background: 'none' }} />
            <input className="mod-search" style={{ maxWidth: 110 }} value={bg} onChange={(e) => setBg(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('loremimg.fg')}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="color" value={result.fg} onChange={(e) => setFg(e.target.value)} style={{ width: 34, height: 30, padding: 0, border: 'none', background: 'none' }} />
            <input className="mod-search" style={{ maxWidth: 110 }} value={fg} onChange={(e) => setFg(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 200 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('loremimg.label')}</span>
          <input className="mod-search" placeholder={t('loremimg.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>

      {/* Live preview */}
      <h3 className="group-title" style={{ fontSize: 14, margin: '0 0 8px' }}>{t('loremimg.preview')}</h3>
      <div
        style={{
          width: preview.pw,
          height: preview.ph,
          background: result.bg,
          color: result.fg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontWeight: 600,
          fontSize: preview.fs,
          fontFamily: 'Segoe UI, Arial, sans-serif',
          borderRadius: 4,
          border: '1px solid var(--border, #ccc)',
          overflow: 'hidden',
          padding: 4,
          boxSizing: 'border-box',
        }}
      >
        {result.label}
      </div>
      <p className="count-note">{t('loremimg.previewNote')}</p>

      {/* Actions */}
      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <button className="mini" onClick={() => copy(result.svg, t('loremimg.svgCopied'))}>{t('loremimg.copySvg')}</button>
        <button className="mini" onClick={() => copy(result.dataUri, t('loremimg.uriCopied'))}>{t('loremimg.copyUri')}</button>
        <button className="mini primary" onClick={save}>{t('loremimg.save')}</button>
      </div>
      {msg && (
        <p className={msg.ok ? 'count-note' : ''} style={msg.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}>
          {msg.text}
        </p>
      )}

      {/* Outputs */}
      <div style={{ marginTop: 12 }}>
        <span className="count-note" style={{ margin: 0 }}>{t('loremimg.svgSource')}</span>
        <textarea className="hosts-edit" spellCheck={false} readOnly value={result.svg} style={{ height: 150, fontFamily: 'Consolas, monospace' }} />
      </div>
      <div style={{ marginTop: 10 }}>
        <span className="count-note" style={{ margin: 0 }}>{t('loremimg.dataUri')}</span>
        <textarea className="hosts-edit" spellCheck={false} readOnly value={result.dataUri} style={{ height: 90, fontFamily: 'Consolas, monospace' }} />
      </div>
      <div style={{ marginTop: 10 }}>
        <span className="count-note" style={{ margin: 0 }}>{t('loremimg.picsum')}</span>
        <input className="mod-search" readOnly value={result.picsumUrl} style={{ fontFamily: 'Consolas, monospace', width: '100%', maxWidth: 'none' }} />
      </div>
    </div>
  );
}
