import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Kind = 'linear' | 'radial';

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

// Build the CSS declaration string. Mirrors GradientService.BuildCss.
function buildCss(kind: Kind, angleDeg: number, stops: RGB2[]): string {
  let out = 'background: ';
  if (kind === 'linear') {
    const a = (((angleDeg % 360) + 360) % 360);
    out += `linear-gradient(${fmt(a)}deg`;
  } else {
    out += 'radial-gradient(circle';
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

export function GradientModule() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('linear');
  const [angle, setAngle] = useState(90);
  const [stops, setStops] = useState<Stop[]>(() => [makeStop('#ff0000', 0), makeStop('#0000ff', 100)]);
  const [copied, setCopied] = useState(false);

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

  const css = collected.ok ? buildCss(kind, Number.isNaN(angle) ? 0 : angle, collected.stops) : '';
  const previewBg = css ? css.replace(/^background:\s*/, '').replace(/;$/, '') : undefined;

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
    }
  };

  const copyCss = () => {
    if (!css.trim()) return;
    navigator.clipboard?.writeText(css);
    setCopied(true);
  };

  const canRemove = stops.length > 1;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('gradient.blurb')}</p>

      <div className="mod-toolbar">
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
      </div>

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
        <button className="mini" style={{ marginTop: 8 }} onClick={addStop}>
          {t('gradient.addStop')}
        </button>
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

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <button className="mini primary" onClick={copyCss} disabled={!css}>
          {t('gradient.copyCss')}
        </button>
        <button className="mini" onClick={randomize}>
          {t('gradient.random')}
        </button>
      </div>

      <p
        className={status.ok ? 'count-note' : ''}
        style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {copied && status.ok ? t('gradient.copied') : status.msg}
      </p>
    </div>
  );
}
