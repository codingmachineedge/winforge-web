import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Ported from WinForge.Services.AsciiArtService. Fixed 5-row block font (A–Z, 0–9,
// space and a few punctuation marks) composed row-by-row into a banner. Two styles:
// Block (solid '#') and Outline (thin frame). Pure client, never-throw.

const HEIGHT = 5;
const GAP = 1;

const FONT: Record<string, string[]> = {
  ' ': ['   ', '   ', '   ', '   ', '   '],
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  J: ['  ###', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  '0': [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '  ## ', ' #   ', '#####'],
  '3': ['#### ', '    #', ' ### ', '    #', '#### '],
  '4': ['#  # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '#### '],
  '6': [' ### ', '#    ', '#### ', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   '],
  '8': [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  '9': [' ### ', '#   #', ' ####', '    #', ' ### '],
  '.': ['  ', '  ', '  ', '  ', '##'],
  ',': ['  ', '  ', '  ', '##', ' #'],
  '!': ['#', '#', '#', ' ', '#'],
  '?': ['### ', '   #', ' ## ', '    ', ' #  '],
  '-': ['    ', '    ', '####', '    ', '    '],
  '+': ['   ', ' # ', '###', ' # ', '   '],
  '=': ['    ', '####', '    ', '####', '    '],
  '*': ['     ', '# # #', ' ### ', '# # #', '     '],
  '/': ['    #', '   # ', '  #  ', ' #   ', '#    '],
  ':': ['  ', '##', '  ', '##', '  '],
  "'": ['#', '#', ' ', ' ', ' '],
  '(': [' #', '# ', '# ', '# ', ' #'],
  ')': ['# ', ' #', ' #', ' #', '# '],
  '@': [' ### ', '#   #', '# ###', '#    ', ' ####'],
  '#': [' # # ', '#####', ' # # ', '#####', ' # # '],
};

const SPACE = FONT[' ']!;

// Convert a solid '#' banner into a thin outline: a filled cell keeps a glyph only
// when it borders an empty cell (or the banner edge); interior cells become spaces.
function toOutline(block: string): string {
  try {
    const lines = block.split('\n');
    const rows = lines.length;
    let cols = 0;
    for (const l of lines) cols = Math.max(cols, l.length);

    const grid: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const line = lines[r] ?? '';
      const row: string[] = [];
      for (let c = 0; c < cols; c++) row.push(c < line.length ? line[c]! : ' ');
      grid.push(row);
    }

    const filled = (r: number, c: number): boolean =>
      r >= 0 && r < rows && c >= 0 && c < cols && grid[r]![c] === '#';

    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        if (grid[r]![c] !== '#') {
          line += ' ';
          continue;
        }
        const edge = !filled(r - 1, c) || !filled(r + 1, c) || !filled(r, c - 1) || !filled(r, c + 1);
        line += edge ? 'o' : ' ';
      }
      out += line.replace(/\s+$/, '');
      if (r < rows - 1) out += '\n';
    }
    return out;
  } catch {
    return block;
  }
}

// Render input as a 5-row ASCII banner. Uppercases input; unknown chars become blank
// space. Returns '' for null/empty/whitespace-only input. Never throws.
function render(input: string, style: 'block' | 'outline'): string {
  try {
    if (!input || !input.trim()) return '';

    const text = input.toUpperCase();
    const rows: string[] = new Array(HEIGHT).fill('');

    let first = true;
    for (const raw of text) {
      const glyph = FONT[raw] ?? SPACE;
      if (!first) {
        for (let r = 0; r < HEIGHT; r++) rows[r] += ' '.repeat(GAP);
      }
      first = false;
      for (let r = 0; r < HEIGHT; r++) rows[r] += glyph[r]!;
    }

    let out = '';
    for (let r = 0; r < HEIGHT; r++) {
      out += rows[r]!.replace(/\s+$/, '');
      if (r < HEIGHT - 1) out += '\n';
    }

    return style === 'outline' ? toOutline(out) : out;
  } catch {
    return '';
  }
}

export function AsciiArtModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('WINFORGE');
  const [style, setStyle] = useState<'block' | 'outline'>('block');
  const [msg, setMsg] = useState('');

  const banner = useMemo(() => render(input, style), [input, style]);

  const status = useMemo(() => {
    if (!input.trim()) return t('asciiart.typeSome');
    if (!banner) return t('asciiart.nothing');
    return t('asciiart.stat', { n: input.trim().length, rows: HEIGHT });
  }, [input, banner, t]);

  const copy = () => {
    if (!banner) {
      setMsg(t('asciiart.nothingToCopy'));
      return;
    }
    try {
      navigator.clipboard?.writeText(banner);
      setMsg(t('asciiart.copied'));
    } catch {
      setMsg(t('asciiart.copyFailed'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('asciiart.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="WINFORGE"
          maxLength={24}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label={t('asciiart.inputLabel')}
        />
      </div>

      <div className="mod-toolbar">
        <span className="count-note">{t('asciiart.style')}</span>
        <select
          className="mod-select"
          value={style}
          onChange={(e) => setStyle(e.target.value as 'block' | 'outline')}
        >
          <option value="block">{t('asciiart.block')}</option>
          <option value="outline">{t('asciiart.outline')}</option>
        </select>
        <button className="mini primary" disabled={!banner} onClick={copy}>
          {t('asciiart.copyBanner')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      <p className="count-note">{status}</p>

      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={banner}
        wrap="off"
        style={{ fontFamily: 'Consolas, "Cascadia Mono", monospace', minHeight: 150, whiteSpace: 'pre', overflow: 'auto' }}
        aria-label="ASCII banner output"
      />
    </div>
  );
}
