import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 字元地圖 · Unicode character explorer — pure client port of WinForge's
// CharMapService + CharMapModule. Pick a block to fill a grid, search by
// codepoint ("U+2764", "2764", "0x2764", "#10084") or by category substring,
// and click a glyph to copy it and see its Code / decimal / UTF-8 / UTF-16 /
// HTML entity encodings. Never throws; skips surrogates U+D800–U+DFFF; caps lists.

const MAX_ITEMS = 512;

interface Block {
  en: string;
  zh: string;
  start: number;
  end: number;
}

// The blocks offered by the module, in display order (mirrors CharMapService.Blocks).
const BLOCKS: readonly Block[] = [
  { en: 'Basic Latin', zh: '基本拉丁字母', start: 0x0020, end: 0x007e },
  { en: 'Latin-1 Supplement', zh: '拉丁字母補充', start: 0x00a0, end: 0x00ff },
  { en: 'General Punctuation', zh: '一般標點', start: 0x2000, end: 0x206f },
  { en: 'Currency Symbols', zh: '貨幣符號', start: 0x20a0, end: 0x20bf },
  { en: 'Arrows', zh: '箭嘴', start: 0x2190, end: 0x21ff },
  { en: 'Math Operators', zh: '數學運算符', start: 0x2200, end: 0x22ff },
  { en: 'Box Drawing', zh: '製表符', start: 0x2500, end: 0x257f },
  { en: 'Geometric Shapes', zh: '幾何圖形', start: 0x25a0, end: 0x25ff },
  { en: 'Emoji (sample)', zh: '表情符號（樣本）', start: 0x1f600, end: 0x1f64f },
  { en: 'CJK (sample)', zh: '中日韓（樣本）', start: 0x4e00, end: 0x4e80 },
];

interface CharInfo {
  codePoint: number;
  glyph: string;
  code: string; // "U+XXXX"
  dec: string; // decimal codepoint
  utf8: string; // space-separated hex bytes
  utf16: string; // space-separated hex code units
  html: string; // "&#xXXXX;"
  name: string; // best-effort category label
}

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');

// Map a JS/browser Unicode general category to WinForge's human label. Since no
// full Unicode Character Database is bundled, we classify via regex property
// escapes (the same fallback intent as CharMapService.BestEffortName).
function categoryLabel(cp: number, glyph: string): string {
  const tests: [RegExp, string][] = [
    [/\p{Lu}/u, 'Uppercase Letter'],
    [/\p{Ll}/u, 'Lowercase Letter'],
    [/\p{Lt}/u, 'Titlecase Letter'],
    [/\p{Lm}/u, 'Modifier Letter'],
    [/\p{Lo}/u, 'Letter'],
    [/\p{Mn}/u, 'Non-spacing Mark'],
    [/\p{Mc}/u, 'Combining Mark'],
    [/\p{Me}/u, 'Enclosing Mark'],
    [/\p{Nd}/u, 'Digit'],
    [/\p{Nl}/u, 'Letter Number'],
    [/\p{No}/u, 'Number'],
    [/\p{Zs}/u, 'Space'],
    [/\p{Zl}/u, 'Line Separator'],
    [/\p{Zp}/u, 'Paragraph Separator'],
    [/\p{Cc}/u, 'Control'],
    [/\p{Cf}/u, 'Format'],
    [/\p{Co}/u, 'Private Use'],
    [/\p{Pc}/u, 'Connector Punctuation'],
    [/\p{Pd}/u, 'Dash Punctuation'],
    [/\p{Ps}/u, 'Open Punctuation'],
    [/\p{Pe}/u, 'Close Punctuation'],
    [/\p{Pi}/u, 'Quote Punctuation'],
    [/\p{Pf}/u, 'Quote Punctuation'],
    [/\p{Po}/u, 'Punctuation'],
    [/\p{Sm}/u, 'Math Symbol'],
    [/\p{Sc}/u, 'Currency Symbol'],
    [/\p{Sk}/u, 'Modifier Symbol'],
    [/\p{So}/u, 'Symbol'],
  ];
  try {
    for (const [re, label] of tests) {
      if (re.test(glyph)) return label;
    }
  } catch {
    /* property escapes unsupported — fall through */
  }
  void cp;
  return 'Other';
}

// Build a CharInfo for one codepoint, or null when it cannot be represented
// (surrogate range, out of Unicode range, or conversion failure).
function describe(cp: number): CharInfo | null {
  try {
    if (cp < 0 || cp > 0x10ffff) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogate — skip

    const glyph = String.fromCodePoint(cp);

    const utf8Bytes = new TextEncoder().encode(glyph);
    const utf8 = Array.from(utf8Bytes, (b) => hex(b, 2)).join(' ');

    const utf16Units: string[] = [];
    for (let i = 0; i < glyph.length; i++) utf16Units.push(hex(glyph.charCodeAt(i), 4));
    const utf16 = utf16Units.join(' ');

    const wide = cp <= 0xffff ? 4 : 6;
    return {
      codePoint: cp,
      glyph,
      code: 'U+' + hex(cp, wide),
      dec: String(cp),
      utf8,
      utf16,
      html: '&#x' + hex(cp, wide) + ';',
      name: categoryLabel(cp, glyph),
    };
  } catch {
    return null;
  }
}

// Build the rows for a codepoint range. Skips surrogates; caps at MAX_ITEMS.
function buildRange(start: number, end: number): CharInfo[] {
  const list: CharInfo[] = [];
  try {
    if (end < start) [start, end] = [end, start];
    for (let cp = start; cp <= end && list.length < MAX_ITEMS; cp++) {
      const info = describe(cp);
      if (info) list.push(info);
    }
  } catch {
    /* never throw */
  }
  return list;
}

const inRange = (cp: number) => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);

const isHex = (s: string) => s.length > 0 && /^[0-9a-fA-F]+$/.test(s);

// Parse a search string as a codepoint. Accepts "U+2764", "2764", "0x2764"
// (hex) or "#10084" (decimal). Returns -1 when the input is plain text.
function parseCodePoint(query: string): number {
  try {
    if (!query || !query.trim()) return -1;
    let s = query.trim();

    if (s.startsWith('#')) {
      const dec = s.slice(1).trim();
      if (/^\d+$/.test(dec)) {
        const d = parseInt(dec, 10);
        return inRange(d) ? d : -1;
      }
      return -1;
    }

    const lower = s.toLowerCase();
    if (lower.startsWith('u+')) s = s.slice(2);
    else if (lower.startsWith('0x')) s = s.slice(2);
    else if (lower.startsWith('&#x')) s = s.slice(3).replace(/;+$/, '');

    s = s.trim();
    if (s.length === 0) return -1;

    if (isHex(s)) {
      const h = parseInt(s, 16);
      if (inRange(h)) return h;
    }
    return -1;
  } catch {
    return -1;
  }
}

export function CharMapModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [blockIndex, setBlockIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CharInfo | null>(null);
  const [copied, setCopied] = useState('');

  const block = BLOCKS[blockIndex]!;
  const all = useMemo(() => buildRange(block.start, block.end), [block.start, block.end]);

  // Apply the search: codepoint jump, else name/category substring filter.
  const results = useMemo(() => {
    try {
      const cp = parseCodePoint(search);
      if (cp >= 0) {
        const info = describe(cp);
        return info ? [info] : [];
      }
      const q = search.trim();
      if (!q) return all;
      const needle = q.toLowerCase();
      const filtered: CharInfo[] = [];
      for (const ci of all) {
        if (ci.name.toLowerCase().includes(needle) && filtered.length < MAX_ITEMS) filtered.push(ci);
      }
      return filtered;
    } catch {
      return all;
    }
  }, [search, all]);

  const blockLabel = (b: Block) => {
    const s = 'U+' + hex(b.start, b.start <= 0xffff ? 4 : 6);
    const e = 'U+' + hex(b.end, b.end <= 0xffff ? 4 : 6);
    return `${zh ? b.zh : b.en}  (${s}–${e})`;
  };

  const pickGlyph = (ci: CharInfo, copy: boolean) => {
    setSelected(ci);
    if (copy) {
      navigator.clipboard?.writeText(ci.glyph);
      setCopied(t('charmap.copiedGlyph', { glyph: ci.glyph }));
    } else {
      setCopied('');
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('charmap.blurb')}
      </p>

      {/* Block picker + search */}
      <div className="mod-toolbar">
        <label className="count-note" htmlFor="charmap-block" style={{ fontWeight: 600 }}>
          {t('charmap.block')}
        </label>
        <select
          id="charmap-block"
          className="mod-select"
          value={blockIndex}
          onChange={(e) => {
            setBlockIndex(Number(e.target.value));
            setSelected(null);
            setCopied('');
          }}
        >
          {BLOCKS.map((b, i) => (
            <option key={b.en} value={i}>
              {blockLabel(b)}
            </option>
          ))}
        </select>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <label className="count-note" htmlFor="charmap-search" style={{ fontWeight: 600 }}>
          {t('charmap.search')}
        </label>
        <input
          id="charmap-search"
          className="mod-search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder={t('charmap.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <p className="count-note" style={{ marginTop: 4 }}>
        {t('charmap.searchHint')}
      </p>

      {/* Details card for the selected glyph */}
      {selected && (
        <div
          className="kv-list"
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
            marginTop: 12,
            padding: 14,
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
          }}
        >
          <div
            style={{
              width: 96,
              height: 96,
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 52,
              lineHeight: 1,
              border: '1px solid var(--border, #333)',
              borderRadius: 8,
            }}
          >
            {selected.glyph}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{selected.name}</div>
            <div className="env-val" style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t('charmap.fieldCode')} {selected.code}
            </div>
            <div className="env-val" style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t('charmap.fieldDec')} {selected.dec}
            </div>
            <div className="env-val" style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t('charmap.fieldUtf8')} {selected.utf8}
            </div>
            <div className="env-val" style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t('charmap.fieldUtf16')} {selected.utf16}
            </div>
            <div className="env-val" style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t('charmap.fieldHtml')} {selected.html}
            </div>
            <div className="mod-toolbar" style={{ marginTop: 8 }}>
              <button className="mini primary" onClick={() => pickGlyph(selected, true)}>
                {t('charmap.copy')}
              </button>
              {copied && <span className="count-note">{copied}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Character grid */}
      <p className="count-note" style={{ marginTop: 12 }}>
        {t('charmap.showing', { n: results.length.toLocaleString() })}
      </p>
      <div className="dt-wrap" style={{ maxHeight: 360 }}>
        <table className="dt">
          <tbody>
            {results.length === 0 ? (
              <tr>
                <td colSpan={3} className="count-note" style={{ padding: 12 }}>
                  {t('charmap.noResults')}
                </td>
              </tr>
            ) : (
              results.map((ci) => (
                <tr
                  key={ci.codePoint}
                  style={{ cursor: 'pointer', background: selected?.codePoint === ci.codePoint ? 'var(--sel, rgba(120,120,120,0.18))' : undefined }}
                  onClick={() => pickGlyph(ci, true)}
                >
                  <td style={{ width: 52, fontSize: 26, textAlign: 'center' }}>{ci.glyph}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13, minWidth: 90 }}>{ci.code}</td>
                  <td className="count-note" style={{ fontSize: 13 }}>{ci.name}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
