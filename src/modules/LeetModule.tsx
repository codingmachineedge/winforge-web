import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Fancy-text / Unicode styler — ported from WinForge LeetService.cs.
// Maps ASCII text into many Unicode "font" styles via per-style offset tables and
// String.fromCodePoint so astral-plane codepoints render correctly. Every mapper is
// robust: non-mappable characters pass through unchanged.

type Mapper = (input: string) => string;

// --- Core rune walker -----------------------------------------------------------------
// Walk the input as Unicode scalar values; map returns a target codepoint or -1 to pass
// the original rune through. [...input] iterates by code point, handling surrogate pairs.
function mapRunes(input: string, map: (cp: number) => number): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    let mapped = -1;
    try {
      mapped = map(cp);
    } catch {
      mapped = -1;
    }
    if (mapped >= 0) {
      try {
        out += String.fromCodePoint(mapped);
      } catch {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// A-Z and a-z each map to a contiguous block starting at the given base codepoints.
function offsetAlpha(upperBase: number, lowerBase: number): Mapper {
  return (input) =>
    mapRunes(input, (r) => {
      if (r >= 65 && r <= 90) return upperBase + (r - 65); // A-Z
      if (r >= 97 && r <= 122) return lowerBase + (r - 97); // a-z
      return -1;
    });
}

// Letters + digits contiguous blocks.
function offsetAlnum(upperBase: number, lowerBase: number, digitBase: number): Mapper {
  return (input) =>
    mapRunes(input, (r) => {
      if (r >= 65 && r <= 90) return upperBase + (r - 65);
      if (r >= 97 && r <= 122) return lowerBase + (r - 97);
      if (r >= 48 && r <= 57) return digitBase + (r - 48); // 0-9
      return -1;
    });
}

// Fullwidth forms: ASCII 0x21..0x7E → 0xFF01.. ; space → ideographic space.
function fullwidth(input: string): string {
  return mapRunes(input, (r) => {
    if (r === 0x20) return 0x3000;
    if (r >= 0x21 && r <= 0x7e) return 0xff01 + (r - 0x21);
    return -1;
  });
}

// Table-based style: lowercase-keyed dictionary lookup, unknown chars pass through.
function tableMapper(map: Record<string, string>): Mapper {
  return (input) => {
    let out = '';
    for (const c of input) {
      const s = map[c.toLowerCase()];
      out += s !== undefined ? s : c;
    }
    return out;
  };
}

// Insert a combining mark after each non-whitespace character (strikethrough / underline).
function combining(mark: string): Mapper {
  return (input) => {
    let out = '';
    for (const c of input) {
      out += c;
      if (!/\s/.test(c)) out += mark;
    }
    return out;
  };
}

const FLIP: Record<string, string> = {
  a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ',
  g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l',
  m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ',
  s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x',
  y: 'ʎ', z: 'z',
  '0': '0', '1': 'Ɩ', '2': 'ᄅ', '3': 'Ɛ', '4': 'ㄣ', '5': 'ϛ',
  '6': '9', '7': 'ㄥ', '8': '8', '9': '6',
  '.': '˙', ',': "'", '?': '¿', '!': '¡', "'": ',', '"': ',,',
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
  '<': '>', '>': '<', '&': '⅋', _: '‾',
};

// Reverse so the result reads correctly when flipped.
function upsideDown(input: string): string {
  const chars = [...input];
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!;
    const s = FLIP[c.toLowerCase()];
    out += s !== undefined ? s : c;
  }
  return out;
}

const LEET_MAP: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
function leet(input: string): string {
  let out = '';
  for (const c of input) {
    const rep = LEET_MAP[c.toLowerCase()];
    out += rep !== undefined ? rep : c;
  }
  return out;
}

const SMALL_CAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ',
  g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ',
  m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
  s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x',
  y: 'ʏ', z: 'ᴢ',
};

// Ordered style list — key drives t('leet.style.<key>') for the localized name.
const STYLES: { key: string; fn: Mapper }[] = [
  { key: 'bold', fn: offsetAlnum(0x1d400, 0x1d41a, 0x1d7ce) },
  { key: 'italic', fn: offsetAlpha(0x1d434, 0x1d44e) },
  { key: 'boldItalic', fn: offsetAlpha(0x1d468, 0x1d482) },
  { key: 'monospace', fn: offsetAlnum(0x1d670, 0x1d68a, 0x1d7f6) },
  { key: 'sans', fn: offsetAlnum(0x1d5a0, 0x1d5ba, 0x1d7e2) },
  { key: 'doubleStruck', fn: offsetAlnum(0x1d538, 0x1d552, 0x1d7d8) },
  { key: 'script', fn: offsetAlpha(0x1d49c, 0x1d4b6) },
  { key: 'fraktur', fn: offsetAlpha(0x1d504, 0x1d51e) },
  { key: 'circled', fn: offsetAlpha(0x24b6, 0x24d0) },
  { key: 'fullwidth', fn: fullwidth },
  { key: 'smallCaps', fn: tableMapper(SMALL_CAPS) },
  { key: 'upsideDown', fn: upsideDown },
  { key: 'strikethrough', fn: combining('̶') },
  { key: 'underline', fn: combining('̲') },
  { key: 'leet', fn: leet },
];

export function LeetModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');

  const rows = useMemo(
    () =>
      STYLES.map((s) => {
        let output: string;
        try {
          output = s.fn(input) ?? '';
        } catch {
          output = input;
        }
        return { key: s.key, output };
      }),
    [input],
  );

  const copy = (text: string) => {
    try {
      navigator.clipboard?.writeText(text ?? '');
      setStatus(t('leet.copied'));
    } catch (e) {
      setStatus(t('leet.copyFailed', { msg: String(e instanceof Error ? e.message : e) }));
    }
  };

  const statusLine =
    status ||
    (input.length === 0
      ? t('leet.enterText')
      : t('leet.ready', { n: STYLES.length.toLocaleString() }));

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('leet.blurb')}
      </p>

      <label className="group-title" style={{ fontSize: 15, fontWeight: 600 }}>
        {t('leet.yourText')}
      </label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={input}
        placeholder={t('leet.placeholder')}
        onChange={(e) => {
          setInput(e.target.value);
          setStatus('');
        }}
        style={{ minHeight: 72, marginTop: 6 }}
      />
      <p className="count-note" style={{ marginTop: 6 }}>
        {statusLine}
      </p>

      <div className="dt-wrap" style={{ marginTop: 12 }}>
        <table className="dt">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => copy(r.output)}>
                <td style={{ width: 150, fontWeight: 600, verticalAlign: 'middle', color: 'var(--text-secondary)' }}>
                  {t(`leet.style.${r.key}`)}
                </td>
                <td style={{ verticalAlign: 'middle', wordBreak: 'break-word' }}>{r.output}</td>
                <td style={{ width: 1, verticalAlign: 'middle' }}>
                  <button
                    className="mini"
                    onClick={(e) => {
                      e.stopPropagation();
                      copy(r.output);
                    }}
                  >
                    {t('leet.copy')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
