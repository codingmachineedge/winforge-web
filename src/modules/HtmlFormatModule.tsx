import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Pure-managed HTML formatter/minifier ported from WinForge's HtmlFormatService.
// Own tokenizer — no external deps. Best-effort on malformed HTML; never throws.
// Preserves the raw content of <pre>, <script>, <style>, <textarea> verbatim.

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype',
]);

const RAW = new Set(['pre', 'script', 'style', 'textarea']);

type Kind = 'Open' | 'Close' | 'SelfClose' | 'Text' | 'Comment' | 'Doctype' | 'Raw';

interface Token {
  kind: Kind;
  name: string; // lowercased tag name
  text: string; // full literal markup / text run / comment / raw block
}

// Finds the '>' that closes a start tag, skipping quoted attribute values.
function findTagEnd(html: string, start: number): number {
  const n = html.length;
  let quote = '';
  for (let i = start; i < n; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i + 1;
    }
  }
  return n;
}

function extractName(markup: string): string {
  let i = 1; // skip '<'
  if (i < markup.length && markup[i] === '/') i++;
  const startName = i;
  while (i < markup.length) {
    const c = markup[i]!;
    if (/\s/.test(c) || c === '>' || c === '/') break;
    i++;
  }
  return markup.substring(startName, i).toLowerCase();
}

function indexOfIgnoreCase(s: string, value: string, start: number): number {
  return s.toLowerCase().indexOf(value.toLowerCase(), Math.min(start, s.length));
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const c = html[i]!;
    if (c === '<' && i + 1 < n) {
      const next = html[i + 1]!;

      // Comment <!-- ... -->
      if (next === '!' && i + 3 < n && html[i + 2] === '-' && html[i + 3] === '-') {
        let end = html.indexOf('-->', i + 4);
        end = end < 0 ? n : end + 3;
        tokens.push({ kind: 'Comment', name: '', text: html.substring(i, end) });
        i = end;
        continue;
      }

      // Doctype / declaration <!doctype ...>
      if (next === '!') {
        let end = html.indexOf('>', i);
        end = end < 0 ? n : end + 1;
        tokens.push({ kind: 'Doctype', name: '', text: html.substring(i, end) });
        i = end;
        continue;
      }

      // Closing tag </name>
      if (next === '/') {
        let end = html.indexOf('>', i);
        end = end < 0 ? n : end + 1;
        const markup = html.substring(i, end);
        tokens.push({ kind: 'Close', name: extractName(markup), text: markup });
        i = end;
        continue;
      }

      // Opening / self-closing tag — but only if it looks like a real tag name.
      if (/[a-zA-Z]/.test(next)) {
        const end = findTagEnd(html, i);
        const markup = html.substring(i, end);
        const name = extractName(markup);
        const self = markup.endsWith('/>') || VOID.has(name);

        if (RAW.has(name) && !self) {
          // Consume verbatim until the matching close tag (case-insensitive).
          const closeTag = '</' + name;
          const close = indexOfIgnoreCase(html, closeTag, end);
          let rawEnd: number;
          if (close < 0) {
            rawEnd = n;
          } else {
            const gt = html.indexOf('>', close);
            rawEnd = gt < 0 ? n : gt + 1;
          }
          tokens.push({ kind: 'Raw', name, text: html.substring(i, rawEnd) });
          i = rawEnd;
          continue;
        }

        tokens.push({ kind: self ? 'SelfClose' : 'Open', name, text: markup });
        i = end;
        continue;
      }

      // A lone '<' that isn't a tag — fall through and treat as text.
    }

    // Text run up to the next '<'.
    let textEnd = html.indexOf('<', i + 1);
    if (textEnd < 0) textEnd = n;
    tokens.push({ kind: 'Text', name: '', text: html.substring(i, textEnd) });
    i = textEnd;
  }

  return tokens;
}

// Collapse runs of internal whitespace inside a text run to single spaces.
function collapseInner(s: string): string {
  let out = '';
  let prevWs = false;
  for (const c of s) {
    if (/\s/.test(c)) {
      if (!prevWs) out += ' ';
      prevWs = true;
    } else {
      out += c;
      prevWs = false;
    }
  }
  return out;
}

// Collapse redundant whitespace inside a tag's markup while respecting quotes.
function collapseTagMarkup(markup: string): string {
  let out = '';
  let quote = '';
  let prevWs = false;
  for (const c of markup) {
    if (quote) {
      out += c;
      if (c === quote) quote = '';
      prevWs = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      prevWs = false;
      continue;
    }
    if (/\s/.test(c)) {
      if (!prevWs) out += ' ';
      prevWs = true;
    } else {
      out += c;
      prevWs = false;
    }
  }
  return out;
}

export function formatHtml(html: string, indentSize: number): string {
  if (!html) return '';
  try {
    let size = indentSize;
    if (size < 0) size = 0;
    if (size > 16) size = 16;

    const tokens = tokenize(html);
    const unit = ' '.repeat(size);
    let out = '';
    let depth = 0;

    const appendLine = (content: string) => {
      out += unit.repeat(depth) + content + '\n';
    };

    for (const tk of tokens) {
      switch (tk.kind) {
        case 'Text': {
          const trimmed = tk.text.trim();
          if (trimmed.length === 0) break; // drop whitespace-only text between tags
          appendLine(collapseInner(trimmed));
          break;
        }
        case 'Comment':
        case 'Doctype':
          appendLine(tk.text.trim());
          break;
        case 'Raw':
          // One tag per line but keep the raw body verbatim.
          appendLine(tk.text);
          break;
        case 'SelfClose':
          appendLine(tk.text.trim());
          break;
        case 'Open':
          appendLine(tk.text.trim());
          depth++;
          break;
        case 'Close':
          if (depth > 0) depth--;
          appendLine(tk.text.trim());
          break;
      }
    }

    return out.replace(/[\r\n]+$/, '');
  } catch {
    return html; // never throw — hand back the original on any unexpected fault
  }
}

export function minifyHtml(html: string): string {
  if (!html) return '';
  try {
    const tokens = tokenize(html);
    let out = '';

    for (const tk of tokens) {
      switch (tk.kind) {
        case 'Text': {
          const collapsed = collapseInner(tk.text);
          if (collapsed.length === 0) break;
          if (collapsed === ' ' && out.length > 0 && out[out.length - 1] === '>') break;
          out += collapsed;
          break;
        }
        case 'Comment':
          break; // strip comments
        case 'Raw':
          out += tk.text; // verbatim — do not touch pre/script/style/textarea
          break;
        default:
          out += collapseTagMarkup(tk.text);
          break;
      }
    }

    return out.trim();
  } catch {
    return html;
  }
}

export function HtmlFormatModule() {
  const { t } = useTranslation();
  const [indent, setIndent] = useState(2);
  const [input, setInput] = useState('<div><p>Hello</p></div>');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const doFormat = () => {
    if (!input.trim()) {
      setStatus({ ok: false, msg: t('htmlformat.emptyFormat') });
      return;
    }
    try {
      const result = formatHtml(input, indent);
      setOutput(result);
      setStatus({ ok: true, msg: t('htmlformat.formatted', { chars: result.length.toLocaleString() }) });
    } catch (e) {
      setStatus({ ok: false, msg: t('htmlformat.formatFail') + String(e instanceof Error ? e.message : e) });
    }
  };

  const doMinify = () => {
    if (!input.trim()) {
      setStatus({ ok: false, msg: t('htmlformat.emptyMinify') });
      return;
    }
    try {
      const before = input.length;
      const result = minifyHtml(input);
      setOutput(result);
      const saved = Math.max(0, before - result.length);
      setStatus({
        ok: true,
        msg: t('htmlformat.minified', {
          chars: result.length.toLocaleString(),
          saved: saved.toLocaleString(),
        }),
      });
    } catch (e) {
      setStatus({ ok: false, msg: t('htmlformat.minifyFail') + String(e instanceof Error ? e.message : e) });
    }
  };

  const doCopy = () => {
    if (!output) {
      setStatus({ ok: false, msg: t('htmlformat.nothingCopy') });
      return;
    }
    navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('htmlformat.copied') });
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('htmlformat.blurb')}
      </p>
      <div className="mod-toolbar">
        <button className="mini primary" onClick={doFormat}>
          {t('htmlformat.format')}
        </button>
        <button className="mini" onClick={doMinify}>
          {t('htmlformat.minify')}
        </button>
        <span className="count-note">{t('htmlformat.indent')}</span>
        <input
          className="mod-search"
          type="number"
          min={0}
          max={16}
          style={{ maxWidth: 80 }}
          value={indent}
          onChange={(e) => setIndent(Math.max(0, Math.min(16, Math.floor(+e.target.value) || 0)))}
        />
        <button className="mini" disabled={!output} onClick={doCopy}>
          {t('htmlformat.copy')}
        </button>
        <button
          className="mini"
          onClick={() => {
            setInput('');
            setOutput('');
            setStatus(null);
          }}
        >
          {t('htmlformat.clear')}
        </button>
      </div>
      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('htmlformat.inputPlaceholder')}
        />
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={output}
          placeholder={t('htmlformat.outputPlaceholder')}
        />
      </div>
      <p
        className={status && status.ok ? 'count-note' : ''}
        style={
          status && !status.ok
            ? { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }
            : { marginTop: 10 }
        }
      >
        {status ? status.msg : t('htmlformat.hint')}
      </p>
    </div>
  );
}
