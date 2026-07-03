import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// The full CSS/X11 named-colour list (148 entries) — name + 6-hex, ported from
// WinForge.Services.ColorNameService (CSS Color Module Level 4 / X11 extended set).
const RAW: [string, string][] = [
  ['AliceBlue', 'F0F8FF'], ['AntiqueWhite', 'FAEBD7'], ['Aqua', '00FFFF'], ['Aquamarine', '7FFFD4'],
  ['Azure', 'F0FFFF'], ['Beige', 'F5F5DC'], ['Bisque', 'FFE4C4'], ['Black', '000000'],
  ['BlanchedAlmond', 'FFEBCD'], ['Blue', '0000FF'], ['BlueViolet', '8A2BE2'], ['Brown', 'A52A2A'],
  ['BurlyWood', 'DEB887'], ['CadetBlue', '5F9EA0'], ['Chartreuse', '7FFF00'], ['Chocolate', 'D2691E'],
  ['Coral', 'FF7F50'], ['CornflowerBlue', '6495ED'], ['Cornsilk', 'FFF8DC'], ['Crimson', 'DC143C'],
  ['Cyan', '00FFFF'], ['DarkBlue', '00008B'], ['DarkCyan', '008B8B'], ['DarkGoldenrod', 'B8860B'],
  ['DarkGray', 'A9A9A9'], ['DarkGreen', '006400'], ['DarkKhaki', 'BDB76B'], ['DarkMagenta', '8B008B'],
  ['DarkOliveGreen', '556B2F'], ['DarkOrange', 'FF8C00'], ['DarkOrchid', '9932CC'], ['DarkRed', '8B0000'],
  ['DarkSalmon', 'E9967A'], ['DarkSeaGreen', '8FBC8F'], ['DarkSlateBlue', '483D8B'], ['DarkSlateGray', '2F4F4F'],
  ['DarkTurquoise', '00CED1'], ['DarkViolet', '9400D3'], ['DeepPink', 'FF1493'], ['DeepSkyBlue', '00BFFF'],
  ['DimGray', '696969'], ['DodgerBlue', '1E90FF'], ['Firebrick', 'B22222'], ['FloralWhite', 'FFFAF0'],
  ['ForestGreen', '228B22'], ['Fuchsia', 'FF00FF'], ['Gainsboro', 'DCDCDC'], ['GhostWhite', 'F8F8FF'],
  ['Gold', 'FFD700'], ['Goldenrod', 'DAA520'], ['Gray', '808080'], ['Green', '008000'],
  ['GreenYellow', 'ADFF2F'], ['Honeydew', 'F0FFF0'], ['HotPink', 'FF69B4'], ['IndianRed', 'CD5C5C'],
  ['Indigo', '4B0082'], ['Ivory', 'FFFFF0'], ['Khaki', 'F0E68C'], ['Lavender', 'E6E6FA'],
  ['LavenderBlush', 'FFF0F5'], ['LawnGreen', '7CFC00'], ['LemonChiffon', 'FFFACD'], ['LightBlue', 'ADD8E6'],
  ['LightCoral', 'F08080'], ['LightCyan', 'E0FFFF'], ['LightGoldenrodYellow', 'FAFAD2'], ['LightGray', 'D3D3D3'],
  ['LightGreen', '90EE90'], ['LightPink', 'FFB6C1'], ['LightSalmon', 'FFA07A'], ['LightSeaGreen', '20B2AA'],
  ['LightSkyBlue', '87CEFA'], ['LightSlateGray', '778899'], ['LightSteelBlue', 'B0C4DE'], ['LightYellow', 'FFFFE0'],
  ['Lime', '00FF00'], ['LimeGreen', '32CD32'], ['Linen', 'FAF0E6'], ['Magenta', 'FF00FF'],
  ['Maroon', '800000'], ['MediumAquamarine', '66CDAA'], ['MediumBlue', '0000CD'], ['MediumOrchid', 'BA55D3'],
  ['MediumPurple', '9370DB'], ['MediumSeaGreen', '3CB371'], ['MediumSlateBlue', '7B68EE'], ['MediumSpringGreen', '00FA9A'],
  ['MediumTurquoise', '48D1CC'], ['MediumVioletRed', 'C71585'], ['MidnightBlue', '191970'], ['MintCream', 'F5FFFA'],
  ['MistyRose', 'FFE4E1'], ['Moccasin', 'FFE4B5'], ['NavajoWhite', 'FFDEAD'], ['Navy', '000080'],
  ['OldLace', 'FDF5E6'], ['Olive', '808000'], ['OliveDrab', '6B8E23'], ['Orange', 'FFA500'],
  ['OrangeRed', 'FF4500'], ['Orchid', 'DA70D6'], ['PaleGoldenrod', 'EEE8AA'], ['PaleGreen', '98FB98'],
  ['PaleTurquoise', 'AFEEEE'], ['PaleVioletRed', 'DB7093'], ['PapayaWhip', 'FFEFD5'], ['PeachPuff', 'FFDAB9'],
  ['Peru', 'CD853F'], ['Pink', 'FFC0CB'], ['Plum', 'DDA0DD'], ['PowderBlue', 'B0E0E6'],
  ['Purple', '800080'], ['RebeccaPurple', '663399'], ['Red', 'FF0000'], ['RosyBrown', 'BC8F8F'],
  ['RoyalBlue', '4169E1'], ['SaddleBrown', '8B4513'], ['Salmon', 'FA8072'], ['SandyBrown', 'F4A460'],
  ['SeaGreen', '2E8B57'], ['SeaShell', 'FFF5EE'], ['Sienna', 'A0522D'], ['Silver', 'C0C0C0'],
  ['SkyBlue', '87CEEB'], ['SlateBlue', '6A5ACD'], ['SlateGray', '708090'], ['Snow', 'FFFAFA'],
  ['SpringGreen', '00FF7F'], ['SteelBlue', '4682B4'], ['Tan', 'D2B48C'], ['Teal', '008080'],
  ['Thistle', 'D8BFD8'], ['Tomato', 'FF6347'], ['Turquoise', '40E0D0'], ['Violet', 'EE82EE'],
  ['Wheat', 'F5DEB3'], ['White', 'FFFFFF'], ['WhiteSmoke', 'F5F5F5'], ['Yellow', 'FFFF00'],
  ['YellowGreen', '9ACD32'],
];

interface NamedColor {
  name: string;
  lower: string;
  hex: string; // #RRGGBB uppercase
  r: number;
  g: number;
  b: number;
}

function byteFrom(sixHex: string, at: number): number {
  const v = parseInt(sixHex.slice(at, at + 2), 16);
  return Number.isNaN(v) ? 0 : v;
}

const ALL: NamedColor[] = RAW.map(([name, hex]) => {
  const r = byteFrom(hex, 0);
  const g = byteFrom(hex, 2);
  const b = byteFrom(hex, 4);
  return { name, lower: name.toLowerCase(), hex: `#${hex}`, r, g, b };
});

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const clampByte = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s);
const normalize = (s: string) => s.replace(/[\s\-_]/g, '').toLowerCase();

interface Rgb {
  r: number;
  g: number;
  b: number;
}

// Parse "#RRGGBB", "RRGGBB", "#RGB", "RGB", "rgb(r,g,b)", "r,g,b", "#RRGGBBAA", or a
// named colour (case/space/dash insensitive). Never throws; null on unrecognizable.
function tryParse(input: string): Rgb | null {
  if (!input || !input.trim()) return null;
  const s = input.trim();

  // rgb(...) / functional or bare comma/space separated triple
  if (s.indexOf(',') >= 0 || s.toLowerCase().startsWith('rgb')) {
    let body = s;
    const lp = body.indexOf('(');
    const rp = body.lastIndexOf(')');
    if (lp >= 0 && rp > lp) body = body.slice(lp + 1, rp);
    const parts = body.split(/[,\s;\t]+/).filter((p) => p.length > 0);
    if (parts.length >= 3) {
      const ch = (p: string): number | null => {
        const v = parseInt(p.trim(), 10);
        if (Number.isNaN(v)) return null;
        return clampByte(v);
      };
      const rr = ch(parts[0]!);
      const gg = ch(parts[1]!);
      const bb = ch(parts[2]!);
      if (rr !== null && gg !== null && bb !== null) return { r: rr, g: gg, b: bb };
    }
    // fall through to hex attempts if the triple failed
  }

  // hex forms
  let hex = s.startsWith('#') ? s.slice(1) : s;
  hex = hex.trim();
  if (hex.length === 3 && isHex(hex)) {
    const r = parseInt(hex[0]!, 16);
    const g = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return { r: r * 17, g: g * 17, b: b * 17 };
  }
  if (hex.length === 6 && isHex(hex)) {
    return { r: byteFrom(hex, 0), g: byteFrom(hex, 2), b: byteFrom(hex, 4) };
  }
  if (hex.length === 8 && isHex(hex)) {
    // assume RRGGBBAA (drop alpha)
    return { r: byteFrom(hex, 0), g: byteFrom(hex, 2), b: byteFrom(hex, 4) };
  }

  // named colour by exact name (case/space/dash-insensitive)
  const norm = normalize(s);
  for (const c of ALL) {
    if (normalize(c.name) === norm) return { r: c.r, g: c.g, b: c.b };
  }
  return null;
}

// Nearest named colour by Euclidean RGB distance (0 = exact). Never throws.
function nearest(r: number, g: number, b: number): { color: NamedColor; dist: number } {
  let best = ALL[0]!;
  let bestSq = Number.MAX_SAFE_INTEGER;
  for (const c of ALL) {
    const dr = c.r - r;
    const dg = c.g - g;
    const db = c.b - b;
    const sq = dr * dr + dg * dg + db * db;
    if (sq < bestSq) {
      bestSq = sq;
      best = c;
      if (sq === 0) break;
    }
  }
  return { color: best, dist: Math.sqrt(bestSq < 0 ? 0 : bestSq) };
}

export function ColorNameModule() {
  const { t } = useTranslation();

  // Live RGB state is the source of truth. Input text mirrors it (but the user
  // can type freely; a valid parse pushes into rgb).
  const [rgb, setRgb] = useState<Rgb>({ r: 0x34, g: 0x98, b: 0xdb });
  const [input, setInput] = useState('#3498DB');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');

  const near = useMemo(() => nearest(rgb.r, rgb.g, rgb.b), [rgb.r, rgb.g, rgb.b]);
  const baseHex = toHex(rgb.r, rgb.g, rgb.b);
  const exact = near.dist <= 0.5;

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f.length === 0 ? ALL : ALL.filter((c) => c.lower.includes(f));
  }, [filter]);

  const onInput = (text: string) => {
    setInput(text);
    const parsed = tryParse(text);
    if (parsed) {
      setRgb(parsed);
      setStatus(t('colorname.parsedOk'));
    } else {
      setStatus(t('colorname.parseFail'));
    }
  };

  const onSlider = (channel: 'r' | 'g' | 'b', value: number) => {
    const next = { ...rgb, [channel]: clampByte(value) };
    setRgb(next);
    setInput(toHex(next.r, next.g, next.b));
    setStatus('');
  };

  const onRowClick = (c: NamedColor) => {
    setRgb({ r: c.r, g: c.g, b: c.b });
    setInput(c.hex);
    void navigator.clipboard?.writeText(c.hex);
    setStatus(t('colorname.copiedRow', { name: c.name, hex: c.hex }));
  };

  const swatchStyle = (bg: string, w: number, h: number): React.CSSProperties => ({
    width: w,
    height: h,
    borderRadius: 6,
    border: '1px solid var(--border, #ccc)',
    background: bg,
    flex: '0 0 auto',
  });

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('colorname.blurb')}
      </p>

      {/* Input + sliders + nearest card */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{t('colorname.inputLabel')}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              className="mod-search"
              style={{ minWidth: 220 }}
              value={input}
              placeholder="#3498DB"
              spellCheck={false}
              onChange={(e) => onInput(e.target.value)}
            />
            <div style={swatchStyle(baseHex, 46, 34)} title={baseHex} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['r', 'g', 'b'] as const).map((ch) => (
            <div key={ch} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ width: 26, textAlign: 'center' }}>{ch.toUpperCase()}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={rgb[ch]}
                style={{ width: 300, maxWidth: '60vw' }}
                onChange={(e) => onSlider(ch, +e.target.value)}
              />
              <span className="count-note" style={{ width: 34, textAlign: 'right' }}>
                {rgb[ch]}
              </span>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'var(--card-bg, rgba(127,127,127,0.08))',
          }}
        >
          <div style={swatchStyle(near.color.hex, 46, 46)} title={near.color.hex} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div className="count-note" style={{ margin: 0 }}>
              {t('colorname.nearestLabel')}
            </div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{near.color.name}</div>
            <div className="count-note" style={{ margin: 0 }}>
              {exact
                ? t('colorname.exactMatch', { hex: near.color.hex })
                : t('colorname.delta', { hex: near.color.hex, d: near.dist.toFixed(1) })}
            </div>
          </div>
        </div>

        {status && (
          <p className="count-note" style={{ margin: 0 }}>
            {status}
          </p>
        )}
      </div>

      {/* Searchable list of all 148 named colours */}
      <div className="mod-toolbar">
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('colorname.listTitle')}
        </h3>
        <input
          className="mod-search"
          style={{ maxWidth: 220 }}
          placeholder={t('colorname.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="count-note">{t('colorname.noMatch')}</p>
      ) : (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('colorname.clickRow')}
        </p>
      )}
      <div className="dt-wrap" style={{ maxHeight: 360 }}>
        <table className="dt">
          <tbody>
            {shown.map((c) => (
              <tr key={c.name} style={{ cursor: 'pointer' }} onClick={() => onRowClick(c)}>
                <td style={{ width: 44 }}>
                  <div style={swatchStyle(c.hex, 30, 30)} />
                </td>
                <td>{c.name}</td>
                <td className="env-val">
                  <code>{c.hex}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
