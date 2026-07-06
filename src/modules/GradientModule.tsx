import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

type Kind = 'linear' | 'radial';
type RadialShape = 'circle' | 'ellipse';
type CssFormat = 'background' | 'background-image';

interface Stop {
  id: number;
  hex: string;
  position: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

// Parse "#ff0000", "ff0000", "#f00" or "f00". Returns null on junk. Mirrors GradientService.TryParseHex.
function tryParseHex(hex: string | undefined | null): RGB | null {
  if (!hex) return null;
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  s = s.trim();
  const isHex = (str: string) => /^[0-9a-fA-F]+$/.test(str);
  if (s.length === 3) {
    if (!isHex(s)) return null;
    const nib = (c: string) => parseInt(c, 16);
    return { r: nib(s[0]!) * 17, g: nib(s[1]!) * 17, b: nib(s[2]!) * 17 };
  }
  if (s.length === 6) {
    if (!isHex(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

// Trim trailing zeros to mimic C# "0.##" formatting.
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// Build the CSS declaration string. Mirrors GradientService.BuildCss, extended with
// radial shape + a property-name choice (background vs background-image).
function buildCss(
  kind: Kind,
  angleDeg: number,
  stops: RGB2[],
  radialShape: RadialShape,
  format: CssFormat,
): string {
  let out = `${format}: `;
  if (kind === 'linear') {
    const a = (((angleDeg % 360) + 360) % 360);
    out += `linear-gradient(${fmt(a)}deg`;
  } else {
    out += `radial-gradient(${radialShape}`;
  }
  for (const s of stops) {
    const pos = Math.max(0, Math.min(100, s.position));
    out += `, ${toHex(s.r, s.g, s.b)} ${fmt(pos)}%`;
  }
  out += ');';
  return out;
}

interface RGB2 extends RGB {
  position: number;
}

function randomByte(): number {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}

// Random integer in [min, max] inclusive.
function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  const range = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0]! % range);
}

let nextId = 1;
const makeStop = (hex: string, position: number): Stop => ({ id: nextId++, hex, position });

// Curated ready-made gradients. Each entry drives kind/angle/shape + its stops when applied.
interface Preset {
  key: string;
  en: string;
  zh: string;
  kind: Kind;
  angle: number;
  shape?: RadialShape;
  stops: Array<[string, number]>;
}
const PRESETS: Preset[] = [
  { key: 'sunset', en: 'Sunset', zh: '日落', kind: 'linear', angle: 90, stops: [['#ff512f', 0], ['#f09819', 100]] },
  { key: 'ocean', en: 'Ocean', zh: '海洋', kind: 'linear', angle: 135, stops: [['#2193b0', 0], ['#6dd5ed', 100]] },
  { key: 'purpleHaze', en: 'Purple Haze', zh: '紫霞', kind: 'linear', angle: 45, stops: [['#7f00ff', 0], ['#e100ff', 100]] },
  { key: 'forest', en: 'Forest', zh: '森林', kind: 'linear', angle: 180, stops: [['#134e5e', 0], ['#71b280', 100]] },
  { key: 'peach', en: 'Peach', zh: '蜜桃', kind: 'linear', angle: 90, stops: [['#ffecd2', 0], ['#fcb69f', 100]] },
  { key: 'midnight', en: 'Midnight', zh: '午夜', kind: 'linear', angle: 160, stops: [['#232526', 0], ['#414345', 100]] },
  { key: 'rainbow', en: 'Rainbow', zh: '彩虹', kind: 'linear', angle: 90, stops: [['#ff0000', 0], ['#ff9900', 20], ['#33cc33', 40], ['#00ccff', 60], ['#3333ff', 80], ['#cc00cc', 100]] },
  { key: 'spotlight', en: 'Spotlight', zh: '聚光', kind: 'radial', angle: 0, shape: 'circle', stops: [['#ffffff', 0], ['#3a3a3a', 100]] },
  { key: 'aurora', en: 'Aurora', zh: '極光', kind: 'radial', angle: 0, shape: 'ellipse', stops: [['#00c9a7', 0], ['#845ec2', 60], ['#2c073b', 100]] },
];

// Angle quick-set buttons (CSS gradient angle: 0deg = up, clockwise).
const ANGLE_PRESETS: Array<{ deg: number; label: string }> = [
  { deg: 0, label: '↑ 0°' },
  { deg: 45, label: '↗ 45°' },
  { deg: 90, label: '→ 90°' },
  { deg: 135, label: '↘ 135°' },
  { deg: 180, label: '↓ 180°' },
  { deg: 225, label: '↙ 225°' },
  { deg: 270, label: '← 270°' },
  { deg: 315, label: '↖ 315°' },
];

// Parse a CSS gradient string (e.g. "linear-gradient(90deg, #f00 0%, #00f 100%)" or a full
// "background: …;" declaration) back into editor state. Returns null on anything unparseable.
function parseCssGradient(
  raw: string,
): { kind: Kind; angle: number; shape: RadialShape; stops: Array<[string, number]> } | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip an optional "background:" / "background-image:" prefix and a trailing ";".
  const colon = s.indexOf(':');
  if (colon >= 0 && /^(background|background-image)\s*$/i.test(s.slice(0, colon))) {
    s = s.slice(colon + 1).trim();
  }
  if (s.endsWith(';')) s = s.slice(0, -1).trim();

  const isRadial = /^radial-gradient\s*\(/i.test(s);
  const isLinear = /^linear-gradient\s*\(/i.test(s);
  if (!isRadial && !isLinear) return null;

  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const inner = s.slice(open + 1, close);

  // Split on commas that are NOT inside parentheses (guards rgb()/rgba() if present).
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  if (parts.length === 0) return null;

  let kind: Kind = isRadial ? 'radial' : 'linear';
  let angle = 90;
  let shape: RadialShape = 'circle';

  // Detect a leading direction/shape token (has no colour → not a stop).
  const first = parts[0]!;
  const looksLikeStop = /#[0-9a-fA-F]{3,6}\b/.test(first) || /\b(rgb|rgba|hsl|hsla)\(/i.test(first);
  if (!looksLikeStop) {
    if (kind === 'linear') {
      const m = first.match(/(-?\d+(?:\.\d+)?)\s*deg/i);
      if (m) angle = parseFloat(m[1]!);
    } else {
      if (/ellipse/i.test(first)) shape = 'ellipse';
      else if (/circle/i.test(first)) shape = 'circle';
    }
    parts.shift();
  }

  const stops: Array<[string, number]> = [];
  for (const p of parts) {
    const hexM = p.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?/);
    if (!hexM) return null;
    const rgb = tryParseHex(hexM[0]);
    if (!rgb) return null;
    const posM = p.match(/(-?\d+(?:\.\d+)?)\s*%/);
    const pos = posM ? Math.max(0, Math.min(100, parseFloat(posM[1]!))) : NaN;
    stops.push([toHex(rgb.r, rgb.g, rgb.b), pos]);
  }
  if (stops.length === 0) return null;
  // Fill any missing positions by even spacing (mirrors CSS default distribution).
  for (let i = 0; i < stops.length; i++) {
    if (Number.isNaN(stops[i]![1])) {
      stops[i]![1] = stops.length === 1 ? 0 : Math.round((i * 100) / (stops.length - 1));
    }
  }
  return { kind, angle, shape, stops };
}

export function GradientModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const [kind, setKind] = useState<Kind>('linear');
  const [angle, setAngle] = useState(90);
  const [radialShape, setRadialShape] = useState<RadialShape>('circle');
  const [cssFormat, setCssFormat] = useState<CssFormat>('background');
  const [stops, setStops] = useState<Stop[]>(() => [makeStop('#ff0000', 0), makeStop('#0000ff', 100)]);
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  // Collect valid stops; returns { stops } or { error } reporting the first bad row.
  const collected = useMemo<
    { ok: true; stops: RGB2[] } | { ok: false; error: string }
  >(() => {
    const list: RGB2[] = [];
    for (let i = 0; i < stops.length; i++) {
      const vm = stops[i]!;
      const rgb = tryParseHex(vm.hex);
      if (!rgb) {
        return { ok: false, error: t('gradient.badHex', { n: i + 1, hex: vm.hex }) };
      }
      const pos = vm.position;
      if (Number.isNaN(pos) || pos < 0 || pos > 100) {
        return { ok: false, error: t('gradient.badPos', { n: i + 1 }) };
      }
      list.push({ ...rgb, position: pos });
    }
    if (list.length === 0) {
      return { ok: false, error: t('gradient.addAtLeastOne') };
    }
    return { ok: true, stops: list };
  }, [stops, t]);

  const css = collected.ok
    ? buildCss(kind, Number.isNaN(angle) ? 0 : angle, collected.stops, radialShape, cssFormat)
    : '';
  // Preview always uses a "background" value regardless of the chosen output property name.
  const previewBg = collected.ok
    ? buildCss(kind, Number.isNaN(angle) ? 0 : angle, collected.stops, radialShape, 'background')
        .replace(/^background:\s*/, '')
        .replace(/;$/, '')
    : undefined;

  const status: { ok: boolean; msg: string } = collected.ok
    ? { ok: true, msg: t('gradient.ready', { n: collected.stops.length }) }
    : { ok: false, msg: collected.error };

  const updateStop = (id: number, patch: Partial<Stop>) => {
    setCopied(false);
    setStops((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const addStop = () => {
    setCopied(false);
    setStops((prev) => {
      const last = prev[prev.length - 1];
      const pos = last ? Math.max(0, Math.min(100, last.position)) : 100;
      return [...prev, makeStop('#ffffff', pos)];
    });
  };

  const removeStop = (id: number) => {
    setCopied(false);
    setStops((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.id !== id)));
  };

  const randomize = () => {
    setCopied(false);
    const n = randomInt(2, 4);
    const fresh: Stop[] = [];
    for (let i = 0; i < n; i++) {
      const hex = toHex(randomByte(), randomByte(), randomByte());
      const pos = n === 1 ? 0 : Math.round((i * 100) / (n - 1));
      fresh.push(makeStop(hex, pos));
    }
    setStops(fresh);
    if (randomInt(0, 1) === 0) {
      setKind('linear');
      setAngle(randomInt(0, 360));
    } else {
      setKind('radial');
      setRadialShape(randomInt(0, 1) === 0 ? 'circle' : 'ellipse');
    }
  };

  const copyCss = () => {
    if (!css.trim()) return;
    navigator.clipboard?.writeText(css);
    setCopied(true);
  };

  // --- Stop-arrangement helpers (all pure, client-side) --------------------
  const sortByPosition = () => {
    setCopied(false);
    setStops((prev) =>
      [...prev].sort((a, b) => {
        const pa = Number.isNaN(a.position) ? Number.POSITIVE_INFINITY : a.position;
        const pb = Number.isNaN(b.position) ? Number.POSITIVE_INFINITY : b.position;
        return pa - pb;
      }),
    );
  };

  const distributeEvenly = () => {
    setCopied(false);
    setStops((prev) =>
      prev.map((s, i) => ({
        ...s,
        position: prev.length <= 1 ? 0 : Math.round((i * 100) / (prev.length - 1)),
      })),
    );
  };

  const reverseStops = () => {
    setCopied(false);
    setStops((prev) => {
      const reversed = [...prev].reverse();
      // Mirror positions so the visual gradient flips end-to-end.
      return reversed.map((s) => ({
        ...s,
        position: Number.isNaN(s.position) ? s.position : Math.max(0, Math.min(100, 100 - s.position)),
      }));
    });
  };

  const applyPreset = (p: Preset) => {
    setCopied(false);
    setKind(p.kind);
    setAngle(p.angle);
    if (p.shape) setRadialShape(p.shape);
    setStops(p.stops.map(([hex, pos]) => makeStop(hex, pos)));
  };

  const applyImport = () => {
    const parsed = parseCssGradient(importText);
    if (!parsed) {
      setImportError(pick('Could not parse that as a CSS gradient.', '無法將其解析為 CSS 漸變。', lang));
      return;
    }
    setCopied(false);
    setImportError(null);
    setKind(parsed.kind);
    setAngle(parsed.angle);
    setRadialShape(parsed.shape);
    setStops(parsed.stops.map(([hex, pos]) => makeStop(hex, pos)));
    setImportOpen(false);
    setImportText('');
  };

  const canRemove = stops.length > 1;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('gradient.blurb')}</p>

      {/* Presets */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <span className="count-note" style={{ alignSelf: 'center' }}>{pick('Presets', '預設', lang)}</span>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="mini"
            onClick={() => applyPreset(p)}
            title={pick(p.en, p.zh, lang)}
            style={{
              paddingLeft: 10,
              paddingRight: 10,
              backgroundImage: buildCss(
                p.kind,
                p.angle,
                p.stops.map(([hex, pos]) => {
                  const rgb = tryParseHex(hex)!;
                  return { ...rgb, position: pos };
                }),
                p.shape ?? 'circle',
                'background',
              )
                .replace(/^background:\s*/, '')
                .replace(/;$/, ''),
              color: '#fff',
              textShadow: '0 1px 2px rgba(0,0,0,0.7)',
              border: '1px solid rgba(0,0,0,0.25)',
            }}
          >
            {pick(p.en, p.zh, lang)}
          </button>
        ))}
      </div>

      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <label className="chk" style={{ gap: 6 }}>
          <span className="count-note">{t('gradient.type')}</span>
          <select
            className="mod-select"
            value={kind}
            onChange={(e) => {
              setCopied(false);
              setKind(e.target.value as Kind);
            }}
          >
            <option value="linear">{t('gradient.linear')}</option>
            <option value="radial">{t('gradient.radial')}</option>
          </select>
        </label>
        {kind === 'linear' && (
          <label className="chk" style={{ gap: 6 }}>
            <span className="count-note">{t('gradient.angle')}</span>
            <input
              className="mod-search"
              type="number"
              min={0}
              max={360}
              style={{ maxWidth: 90 }}
              value={Number.isNaN(angle) ? '' : angle}
              onChange={(e) => {
                setCopied(false);
                const v = e.target.value === '' ? NaN : Math.max(0, Math.min(360, +e.target.value));
                setAngle(v);
              }}
            />
          </label>
        )}
        {kind === 'radial' && (
          <label className="chk" style={{ gap: 6 }}>
            <span className="count-note">{pick('Shape', '形狀', lang)}</span>
            <select
              className="mod-select"
              value={radialShape}
              onChange={(e) => {
                setCopied(false);
                setRadialShape(e.target.value as RadialShape);
              }}
            >
              <option value="circle">{pick('Circle', '圓形', lang)}</option>
              <option value="ellipse">{pick('Ellipse', '橢圓', lang)}</option>
            </select>
          </label>
        )}
        <label className="chk" style={{ gap: 6 }}>
          <span className="count-note">{pick('CSS property', 'CSS 屬性', lang)}</span>
          <select
            className="mod-select"
            value={cssFormat}
            onChange={(e) => {
              setCopied(false);
              setCssFormat(e.target.value as CssFormat);
            }}
          >
            <option value="background">background</option>
            <option value="background-image">background-image</option>
          </select>
        </label>
      </div>

      {/* Linear angle quick-set */}
      {kind === 'linear' && (
        <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="count-note" style={{ alignSelf: 'center' }}>{pick('Direction', '方向', lang)}</span>
          {ANGLE_PRESETS.map((a) => (
            <button
              key={a.deg}
              className={!Number.isNaN(angle) && ((angle % 360) + 360) % 360 === a.deg ? 'mini primary' : 'mini'}
              onClick={() => {
                setCopied(false);
                setAngle(a.deg);
              }}
              title={pick('Set angle to', '設定角度為', lang) + ' ' + a.deg + '°'}
              style={{ paddingLeft: 8, paddingRight: 8 }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: '0 0 6px' }}>{t('gradient.stops')}</h3>
        <div className="kv-list">
          {stops.map((s) => {
            const rgb = tryParseHex(s.hex);
            const swatch = rgb ? toHex(rgb.r, rgb.g, rgb.b) : 'transparent';
            return (
              <div className="kv-row" key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 4,
                    flex: '0 0 auto',
                    background: swatch,
                    border: '1px solid var(--border, #444)',
                  }}
                />
                <input
                  type="color"
                  value={rgb ? swatch : '#000000'}
                  onChange={(e) => updateStop(s.id, { hex: e.target.value })}
                  style={{ width: 34, height: 28, padding: 0, border: 'none', background: 'none', flex: '0 0 auto', cursor: 'pointer' }}
                  aria-label={t('gradient.pickColour')}
                />
                <input
                  className="mod-search"
                  style={{ flex: 1, minWidth: 90 }}
                  placeholder={t('gradient.hexPlaceholder')}
                  value={s.hex}
                  spellCheck={false}
                  onChange={(e) => updateStop(s.id, { hex: e.target.value })}
                />
                <input
                  className="mod-search"
                  type="number"
                  min={0}
                  max={100}
                  style={{ maxWidth: 90 }}
                  value={Number.isNaN(s.position) ? '' : s.position}
                  onChange={(e) => {
                    const v = e.target.value === '' ? NaN : Math.max(0, Math.min(100, +e.target.value));
                    updateStop(s.id, { position: v });
                  }}
                  aria-label={t('gradient.position')}
                />
                <button
                  className="mini"
                  onClick={() => removeStop(s.id)}
                  disabled={!canRemove}
                  title={canRemove ? t('gradient.remove') : t('gradient.keepOne')}
                  aria-label={t('gradient.remove')}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className="mini" onClick={addStop}>
            {t('gradient.addStop')}
          </button>
          <button className="mini" onClick={sortByPosition} disabled={stops.length < 2} title={pick('Sort stops by position', '按位置排序色標', lang)}>
            {pick('Sort', '排序', lang)}
          </button>
          <button className="mini" onClick={distributeEvenly} disabled={stops.length < 2} title={pick('Space stops evenly from 0% to 100%', '將色標由 0% 至 100% 平均分佈', lang)}>
            {pick('Distribute', '平均分佈', lang)}
          </button>
          <button className="mini" onClick={reverseStops} disabled={stops.length < 2} title={pick('Reverse the gradient direction', '反轉漸變方向', lang)}>
            {pick('Reverse', '反轉', lang)}
          </button>
        </div>
      </div>

      <div
        style={{
          height: 160,
          marginTop: 14,
          borderRadius: 8,
          border: '1px solid var(--border, #444)',
          background: previewBg,
        }}
      />

      <textarea
        className="hosts-edit"
        style={{ marginTop: 12, minHeight: 60, fontFamily: 'Consolas, monospace' }}
        readOnly
        spellCheck={false}
        value={css}
        placeholder={t('gradient.cssPlaceholder')}
      />

      <div className="mod-toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button className="mini primary" onClick={copyCss} disabled={!css}>
          {t('gradient.copyCss')}
        </button>
        <button className="mini" onClick={randomize}>
          {t('gradient.random')}
        </button>
        <button
          className="mini"
          onClick={() => {
            setImportOpen((v) => !v);
            setImportError(null);
          }}
          title={pick('Paste a CSS gradient string to load it', '貼上 CSS 漸變字串以載入', lang)}
        >
          {pick('Import CSS…', '匯入 CSS…', lang)}
        </button>
      </div>

      {importOpen && (
        <div className="panel" style={{ marginTop: 10, padding: 12 }}>
          <p className="count-note" style={{ marginTop: 0 }}>
            {pick(
              'Paste a linear-gradient(…) or radial-gradient(…) value (a full "background:" line is fine).',
              '貼上 linear-gradient(…) 或 radial-gradient(…) 值（完整的「background:」行亦可）。',
              lang,
            )}
          </p>
          <textarea
            className="hosts-edit"
            style={{ minHeight: 54, fontFamily: 'Consolas, monospace' }}
            spellCheck={false}
            value={importText}
            placeholder="linear-gradient(90deg, #ff0000 0%, #0000ff 100%)"
            onChange={(e) => {
              setImportText(e.target.value);
              setImportError(null);
            }}
          />
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <button className="mini primary" onClick={applyImport} disabled={!importText.trim()}>
              {pick('Load', '載入', lang)}
            </button>
            <button
              className="mini"
              onClick={() => {
                setImportOpen(false);
                setImportText('');
                setImportError(null);
              }}
            >
              {pick('Cancel', '取消', lang)}
            </button>
          </div>
          {importError && (
            <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--danger)', fontSize: 12.5 }}>{importError}</p>
          )}
        </div>
      )}

      <p
        className={status.ok ? 'count-note' : ''}
        style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {copied && status.ok ? t('gradient.copied') : status.msg}
      </p>
    </div>
  );
}
