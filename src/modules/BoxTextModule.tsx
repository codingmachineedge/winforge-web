import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// 文字方框 / 橫幅 · Box & banner text — wrap input text in a drawn border box (ASCII,
// Single, Double, Rounded, Heavy, Stars, comment blocks), with padding / alignment /
// optional title. Direct port of WinForge's BoxTextService — never throws.

type BorderStyle = 'ascii' | 'single' | 'double' | 'rounded' | 'heavy' | 'stars' | 'commentSlash' | 'commentHash';
type BoxAlign = 'left' | 'center' | 'right';

interface Glyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

function glyphsFor(s: BorderStyle): Glyphs {
  switch (s) {
    case 'single':
      return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
    case 'double':
      return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
    case 'rounded':
      return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
    case 'heavy':
      return { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' };
    case 'stars':
      return { tl: '*', tr: '*', bl: '*', br: '*', h: '*', v: '*' };
    default:
      return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  }
}

// Display width. Treats each char as width 1, skipping zero-width combining marks
// so accents don't over-count. Matches WinForge's DisplayWidth.
function displayWidth(s: string): number {
  if (!s) return 0;
  let w = 0;
  for (const ch of s) {
    // \p{Mn} = NonSpacingMark, \p{Me} = EnclosingMark — zero width.
    if (/[\p{Mn}\p{Me}]/u.test(ch)) continue;
    w += 1;
  }
  return w;
}

function splitLines(text: string): string[] {
  if (!text) return [''];
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const list = norm.split('\n').map((raw) => raw.replace(/\t/g, '    ')); // tabs → 4 spaces
  return list.length === 0 ? [''] : list;
}

function buildTitleBar(h: string, inner: number, title: string): string {
  const label = ' ' + title + ' ';
  const labelW = displayWidth(label);
  if (labelW + 1 >= inner) {
    return h.repeat(Math.max(inner, 1));
  }
  const lead = 1;
  let rest = inner - lead - labelW;
  if (rest < 0) rest = 0;
  return h.repeat(lead) + label + h.repeat(rest);
}

function appendAligned(line: string, inner: number, padding: number, align: BoxAlign): string {
  let contentWidth = inner - padding * 2;
  if (contentWidth < 0) contentWidth = 0;
  const w = displayWidth(line);
  const slack = Math.max(0, contentWidth - w);

  let left: number;
  let right: number;
  switch (align) {
    case 'right':
      left = slack;
      right = 0;
      break;
    case 'center':
      left = Math.floor(slack / 2);
      right = slack - left;
      break;
    default:
      left = 0;
      right = slack;
      break;
  }
  return ' '.repeat(padding) + ' '.repeat(left) + line + ' '.repeat(right) + ' '.repeat(padding);
}

function renderCommentSlash(lines: string[], title: string, padding: number): string {
  let out = '/*\n';
  if (title.length > 0) out += ' * ' + title + '\n *\n';
  const pad = ' '.repeat(padding);
  for (const l of lines) out += ' * ' + pad + l + '\n';
  out += ' */';
  return out;
}

function renderCommentHash(lines: string[], title: string, padding: number): string {
  let longest = displayWidth(title);
  for (const l of lines) longest = Math.max(longest, displayWidth(l));
  const bar = Math.max(3, longest + padding * 2 + 6);

  let out = '#'.repeat(bar) + '\n';
  if (title.length > 0) {
    out += '### ' + title + '\n';
    out += '#'.repeat(bar) + '\n';
  }
  const pad = ' '.repeat(padding);
  for (const l of lines) out += '### ' + pad + l + '\n';
  out += '#'.repeat(bar);
  return out;
}

function renderBox(text: string, style: BorderStyle, paddingRaw: number, align: BoxAlign, titleRaw: string): string {
  try {
    const padding = Math.max(0, Math.min(40, paddingRaw));
    const title = (titleRaw ?? '').replace(/\r/g, '').replace(/\n/g, ' ').trim();

    const lines = splitLines(text);

    if (style === 'commentSlash') return renderCommentSlash(lines, title, padding);
    if (style === 'commentHash') return renderCommentHash(lines, title, padding);

    const g = glyphsFor(style);

    let longest = 0;
    for (const l of lines) longest = Math.max(longest, displayWidth(l));
    const titleW = displayWidth(title);
    let inner = Math.max(longest, titleW) + padding * 2;
    if (inner < 1) inner = 1;

    let sb = '';

    if (title.length > 0) sb += g.tl + buildTitleBar(g.h, inner, title) + g.tr + '\n';
    else sb += g.tl + g.h.repeat(inner) + g.tr + '\n';

    for (const l of lines) {
      sb += g.v + appendAligned(l, inner, padding, align) + g.v + '\n';
    }

    sb += g.bl + g.h.repeat(inner) + g.br;
    return sb;
  } catch {
    return text ?? '';
  }
}

const STYLE_ORDER: BorderStyle[] = ['ascii', 'single', 'double', 'rounded', 'heavy', 'stars', 'commentSlash', 'commentHash'];
const ALIGN_ORDER: BoxAlign[] = ['left', 'center', 'right'];

export function BoxTextModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('WinForge\nBox & Banner Text');
  const [style, setStyle] = useState<BorderStyle>('ascii');
  const [align, setAlign] = useState<BoxAlign>('left');
  const [padding, setPadding] = useState(1);
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState('');

  const output = useMemo(() => renderBox(input, style, padding, align, title), [input, style, padding, align, title]);

  const lineCount = output ? output.split('\n').length : 0;

  const copy = () => {
    if (!output) {
      setMsg(t('boxtext.nothing'));
      return;
    }
    navigator.clipboard?.writeText(output);
    setMsg(t('boxtext.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('boxtext.blurb')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        <label style={{ fontWeight: 600 }}>{t('boxtext.inputLabel')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 120 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label>{t('boxtext.styleLabel')}</label>
          <select className="mod-select" value={style} onChange={(e) => setStyle(e.target.value as BorderStyle)}>
            {STYLE_ORDER.map((s) => (
              <option key={s} value={s}>
                {t(`boxtext.style.${s}`)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label>{t('boxtext.alignLabel')}</label>
          <select className="mod-select" value={align} onChange={(e) => setAlign(e.target.value as BoxAlign)}>
            {ALIGN_ORDER.map((a) => (
              <option key={a} value={a}>
                {t(`boxtext.align.${a}`)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label>{t('boxtext.paddingLabel')}</label>
          <input
            className="mod-search"
            type="number"
            min={0}
            max={40}
            value={padding}
            onChange={(e) => setPadding(Math.max(0, Math.min(40, Math.floor(+e.target.value || 0))))}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label>{t('boxtext.titleLabel')}</label>
          <input className="mod-search" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>

      <div className="mod-toolbar">
        <button className="mini primary" onClick={copy}>
          {t('boxtext.copy')}
        </button>
        <span className="count-note">
          {t('boxtext.status', { chars: output.length.toLocaleString(), lines: lineCount.toLocaleString() })}
        </span>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
        <label style={{ fontWeight: 600 }}>{t('boxtext.outputLabel')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={output}
          style={{ minHeight: 180, fontFamily: 'Consolas, ui-monospace, monospace', whiteSpace: 'pre', overflowX: 'auto' }}
        />
      </div>
    </div>
  );
}
