import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeUrl = (u: string) => (/^\s*javascript:/i.test(u) ? '#' : u.trim());

function inline(s: string): string {
  // s is already HTML-escaped; apply inline markdown → safe tags.
  return s
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, a: string, u: string) => `<img alt="${a}" src="${safeUrl(u)}" style="max-width:100%">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => `<a href="${safeUrl(u)}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const lvl = h[1]!.length;
      out.push(`<h${lvl}>${inline(esc(h[2]!))}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(esc(line.replace(/^>\s?/, '')))}</blockquote>`);
      i++;
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) {
        closeList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${inline(esc((ul ?? ol)![1]!))}</li>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeList();
      i++;
      continue;
    }
    closeList();
    para.push(line);
    i++;
  }
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return out.join('\n');
}

const SAMPLE = `# WinForge Web

A **Markdown** preview with *live* rendering.

## Features
- Headings, lists, \`inline code\`
- [Links](https://example.com) and **bold** / *italic*
- Code blocks:

\`\`\`
const x = 42;
\`\`\`

> Blockquotes work too.
`;

export function MarkdownModule() {
  const { t } = useTranslation();
  const [md, setMd] = useState(SAMPLE);
  const html = useMemo(() => mdToHtml(md), [md]);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" onClick={() => navigator.clipboard?.writeText(html)}>
          {t('markdown.copyHtml')}
        </button>
        <span className="count-note">{t('markdown.ready')}</span>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={md} onChange={(e) => setMd(e.target.value)} style={{ minHeight: 360 }} />
        <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
