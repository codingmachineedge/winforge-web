import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge Services/HtmlToMdService.cs — pure-managed, best-effort
// HTML → Markdown. Own tiny tokenizer (regex over tags), no deps. Robust:
// never throws on malformed input — on any failure it degrades to a decoded,
// tag-stripped plain-text rendering.

const TAG_RX = /<[^>]+>/gs;
const ATTR_RX = /([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
const WS_RX = /[ \t\f\v]+/g;
const BLANK_LINES_RX = /\n{3,}/g;

function htmlDecode(s: string): string {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

interface ListCtx {
  ordered: boolean;
  index: number;
}

// Single-slot href carry between <a> open and close (single-pass, non-nested links).
let pendingHref = '()';

function extractHref(inner: string): string {
  ATTR_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RX.exec(inner)) !== null) {
    const name = m[1]!;
    if (name.toLowerCase() === 'href') {
      let v = m[2]!.trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) v = v.substring(1, v.length - 1);
      return '(' + htmlDecode(v).trim() + ')';
    }
  }
  return '()';
}

function ensureNewLine(sb: string[]): void {
  const last = tail(sb);
  if (last.length > 0 && last[last.length - 1] !== '\n') sb.push('\n');
}

function ensureBlankLine(sb: string[]): void {
  const s = sb.join('');
  if (s.length === 0) return;
  if (s[s.length - 1] !== '\n') sb.push('\n\n');
  else if (s.length >= 2 && s[s.length - 2] !== '\n') sb.push('\n');
}

// Cheap tail helper: the ensure* checks only ever look at the last 1-2 chars.
function tail(sb: string[]): string {
  for (let i = sb.length - 1; i >= 0; i--) {
    const part = sb[i]!;
    if (part.length > 0) return part;
  }
  return '';
}

function appendText(sb: string[], raw: string, inPre: boolean): void {
  if (raw.length === 0) return;
  let text = htmlDecode(raw);
  if (inPre) {
    sb.push(text);
    return;
  }
  text = text.replace(/\r/g, ' ').replace(/\n/g, ' ');
  text = text.replace(WS_RX, ' ');
  if (text.length === 0) return;
  // Avoid a leading space right after a fresh block boundary.
  if (text === ' ') {
    const s = sb.join('');
    if (s.length === 0 || s[s.length - 1] === '\n') return;
  }
  sb.push(text);
}

function handleTag(tag: string, sb: string[], listStack: ListCtx[], state: { inPre: boolean }): void {
  const closing = tag.length > 1 && tag[1] === '/';
  let inner = tag.substring(closing ? 2 : 1, tag.length - 1).trim();
  if (inner.endsWith('/')) inner = inner.substring(0, inner.length - 1).trim();
  const spIdx = inner.search(/[ \t\r\n]/);
  const name = (spIdx < 0 ? inner : inner.substring(0, spIdx)).toLowerCase();

  switch (name) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      if (closing) {
        sb.push('\n\n');
      } else {
        ensureBlankLine(sb);
        const level = name.charCodeAt(1) - '0'.charCodeAt(0);
        sb.push('#'.repeat(level) + ' ');
      }
      break;

    case 'strong':
    case 'b':
      sb.push('**');
      break;

    case 'em':
    case 'i':
      sb.push('*');
      break;

    case 'code':
      if (!state.inPre) sb.push('`');
      break;

    case 'pre':
      if (closing) {
        state.inPre = false;
        ensureNewLine(sb);
        sb.push('```\n\n');
      } else {
        ensureBlankLine(sb);
        sb.push('```\n');
        state.inPre = true;
      }
      break;

    case 'a':
      if (closing) sb.push(']' + pendingHref);
      else {
        sb.push('[');
        pendingHref = extractHref(inner);
      }
      break;

    case 'ul':
    case 'ol':
      if (closing) {
        if (listStack.length > 0) listStack.pop();
        if (listStack.length === 0) sb.push('\n');
      } else {
        ensureNewLine(sb);
        listStack.push({ ordered: name === 'ol', index: 0 });
      }
      break;

    case 'li':
      if (!closing) {
        ensureNewLine(sb);
        const depth = Math.max(0, listStack.length - 1);
        sb.push(' '.repeat(depth * 2));
        if (listStack.length > 0) {
          const ctx = listStack[listStack.length - 1]!;
          if (ctx.ordered) {
            ctx.index++;
            sb.push(ctx.index + '. ');
          } else sb.push('- ');
        } else sb.push('- ');
      } else sb.push('\n');
      break;

    case 'blockquote':
      if (closing) sb.push('\n\n');
      else {
        ensureBlankLine(sb);
        sb.push('> ');
      }
      break;

    case 'hr':
      ensureBlankLine(sb);
      sb.push('---\n\n');
      break;

    case 'br':
      sb.push('  \n');
      break;

    case 'p':
    case 'div':
      if (closing) sb.push('\n\n');
      else ensureBlankLine(sb);
      break;

    default:
      // Unknown tag: strip, keep inner text (handled by the text pass).
      break;
  }
}

function convertCore(html: string): string {
  // Drop content of script/style/comments entirely — noise, not prose.
  html = html.replace(/<script\b[^>]*>.*?<\/script>/gis, ' ');
  html = html.replace(/<style\b[^>]*>.*?<\/style>/gis, ' ');
  html = html.replace(/<!--.*?-->/gs, ' ');

  const sb: string[] = [];
  const listStack: ListCtx[] = [];
  const state = { inPre: false };
  let i = 0;
  const n = html.length;

  while (i < n) {
    const c = html[i];
    if (c === '<') {
      const end = html.indexOf('>', i);
      if (end < 0) {
        // Malformed trailing '<' — treat rest as text.
        appendText(sb, html.substring(i), state.inPre);
        break;
      }
      const tag = html.substring(i, end + 1);
      handleTag(tag, sb, listStack, state);
      i = end + 1;
    } else {
      let next = html.indexOf('<', i);
      if (next < 0) next = n;
      appendText(sb, html.substring(i, next), state.inPre);
      i = next;
    }
  }

  let md = sb.join('');
  md = md.replace(BLANK_LINES_RX, '\n\n');
  return md.trim();
}

function convert(html: string): string {
  if (!html || html.trim().length === 0) return '';
  try {
    return convertCore(html);
  } catch {
    // Absolute fallback: strip tags + decode entities so the user still gets usable text.
    try {
      const bare = html.replace(TAG_RX, ' ');
      return htmlDecode(bare).trim();
    } catch {
      return html ?? '';
    }
  }
}

const SAMPLE =
  '<h1>WinForge</h1>\n<p>Paste <strong>HTML</strong> and get <em>Markdown</em>. Visit <a href="https://example.com">the site</a>.</p>\n<ul>\n  <li>Fast</li>\n  <li>Bilingual</li>\n</ul>';

export function HtmlToMdModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE);
  const [msg, setMsg] = useState('');

  const output = useMemo(() => convert(input), [input]);
  const hasOutput = output.length > 0;

  const status = (() => {
    if (msg) return msg;
    if (!input || input.trim().length === 0) return t('htmltomd.paste');
    if (hasOutput) return t('htmltomd.converted', { count: output.length });
    return t('htmltomd.noContent');
  })();

  const copy = () => {
    if (!hasOutput) {
      setMsg(t('htmltomd.nothing'));
      return;
    }
    void navigator.clipboard?.writeText(output);
    setMsg(t('htmltomd.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('htmltomd.blurb')}
      </p>
      <div className="io-grid">
        <div>
          <div className="kv-row" style={{ fontWeight: 600, marginBottom: 4 }}>{t('htmltomd.inputLabel')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setMsg('');
            }}
            style={{ minHeight: 320, fontFamily: 'Consolas, monospace' }}
          />
        </div>
        <div>
          <div className="kv-row" style={{ fontWeight: 600, marginBottom: 4 }}>{t('htmltomd.outputLabel')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={output}
            style={{ minHeight: 320, fontFamily: 'Consolas, monospace' }}
          />
        </div>
      </div>
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini primary" onClick={copy}>
          {t('htmltomd.copy')}
        </button>
        <span className="count-note">{status}</span>
      </div>
    </div>
  );
}
