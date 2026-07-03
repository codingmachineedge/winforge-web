import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Heading {
  level: number;
  title: string;
  slug: string;
}

function isFence(trimmed: string): { fence: boolean; ch: string; len: number } {
  if (trimmed.length < 3) return { fence: false, ch: '`', len: 0 };
  const c = trimmed[0]!;
  if (c !== '`' && c !== '~') return { fence: false, ch: '`', len: 0 };
  let n = 0;
  while (n < trimmed.length && trimmed[n] === c) n++;
  if (n < 3) return { fence: false, ch: '`', len: 0 };
  return { fence: true, ch: c, len: n };
}

// GitHub-style slug: lowercase, spaces→hyphens, punctuation stripped, de-duplicated.
function makeSlug(title: string, used: Map<string, number>): string {
  let base = '';
  for (const raw of title.toLowerCase()) {
    if (raw === ' ' || raw === '\t') base += '-';
    else if (/[\p{L}\p{N}]/u.test(raw) || raw === '-' || raw === '_') base += raw;
    // else punctuation stripped
  }
  const seen = used.get(base);
  if (seen === undefined) {
    used.set(base, 0);
    return base;
  }
  const next = seen + 1;
  used.set(base, next);
  return `${base}-${next}`;
}

// Strip a small set of inline Markdown emphasis/code/link syntax for the visible title.
function stripInlineMarkdown(s: string): string {
  if (!s) return '';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && close + 1 < s.length && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 1);
        if (paren > close) {
          out += s.substring(i + 1, close);
          i = paren + 1;
          continue;
        }
      }
    }
    if (c === '*' || c === '_' || c === '`') {
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

function escapeLinkText(s: string): string {
  return s.replace(/]/g, '\\]').replace(/\[/g, '\\[');
}

function parseHeadings(markdown: string): Heading[] {
  const result: Heading[] = [];
  if (!markdown) return result;

  const used = new Map<string, number>();
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 0;

  for (const raw of lines) {
    const line = raw ?? '';
    const trimmed = line.replace(/^[ \t]+/, '');

    const f = isFence(trimmed);
    if (f.fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = f.ch;
        fenceLen = f.len;
      } else if (f.ch === fenceChar && f.len >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    // ATX heading: 0-3 leading spaces, 1-6 '#', then a space (or end of line).
    const lead = line.length - trimmed.length;
    if (lead > 3) continue;
    if (trimmed.length === 0 || trimmed[0] !== '#') continue;

    let hashes = 0;
    while (hashes < trimmed.length && trimmed[hashes] === '#') hashes++;
    if (hashes < 1 || hashes > 6) continue;
    const after = trimmed[hashes];
    if (hashes < trimmed.length && after !== ' ' && after !== '\t') continue;

    let title = trimmed.substring(hashes).trim();
    // Strip an optional closing run of '#'.
    title = title.replace(/\s+$/, '');
    let end = title.length;
    while (end > 0 && title[end - 1] === '#') end--;
    if (end < title.length && (end === 0 || title[end - 1] === ' ')) {
      title = title.substring(0, end).replace(/\s+$/, '');
    }

    const plain = stripInlineMarkdown(title);
    result.push({ level: hashes, title: plain, slug: makeSlug(plain, used) });
  }

  return result;
}

interface TocOptions {
  minLevel: number;
  maxLevel: number;
  includeH1: boolean;
  ordered: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function generate(markdown: string, opts: TocOptions): { md: string; count: number } {
  let min = clamp(opts.minLevel, 1, 6);
  let max = clamp(opts.maxLevel, 1, 6);
  if (min > max) [min, max] = [max, min];

  const headings = parseHeadings(markdown);
  let out = '';
  let count = 0;

  for (const h of headings) {
    if (h.level < min || h.level > max) continue;
    if (!opts.includeH1 && h.level === 1) continue;

    const indentLevels = Math.max(0, h.level - min);
    const indent = ' '.repeat(indentLevels * 2);
    const marker = opts.ordered ? '1.' : '-';
    const title = h.title ? h.title : '(untitled)';

    out += `${indent}${marker} [${escapeLinkText(title)}](#${h.slug})\n`;
    count++;
  }

  return { md: out.replace(/\n+$/, ''), count };
}

const SAMPLE =
  '# Getting Started\n\n' +
  'Intro text.\n\n' +
  '## Installation\n\n' +
  '```\n# this is code, not a heading\n```\n\n' +
  '## Usage\n\n' +
  '### Basic Usage\n\n' +
  '### Advanced Usage!\n\n' +
  '## Usage\n\n' +
  '# Reference\n';

export function MarkdownTocModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE);
  const [minLevel, setMinLevel] = useState(1);
  const [maxLevel, setMaxLevel] = useState(6);
  const [includeH1, setIncludeH1] = useState(true);
  const [ordered, setOrdered] = useState(false);
  const [msg, setMsg] = useState('');

  const result = useMemo(
    () => generate(input, { minLevel, maxLevel, includeH1, ordered }),
    [input, minLevel, maxLevel, includeH1, ordered],
  );

  const copy = () => {
    if (!result.md) {
      setMsg(t('markdowntoc.nothing'));
      return;
    }
    void navigator.clipboard?.writeText(result.md);
    setMsg(t('markdowntoc.copied'));
  };

  const clampLevel = (v: string): number => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 1;
    return clamp(n, 1, 6);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('markdowntoc.blurb')}
      </p>

      <div className="mod-toolbar">
        <label className="chk" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span className="count-note">{t('markdowntoc.minLevel')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={6}
            style={{ maxWidth: 90 }}
            value={minLevel}
            onChange={(e) => setMinLevel(clampLevel(e.target.value))}
          />
        </label>
        <label className="chk" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span className="count-note">{t('markdowntoc.maxLevel')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={6}
            style={{ maxWidth: 90 }}
            value={maxLevel}
            onChange={(e) => setMaxLevel(clampLevel(e.target.value))}
          />
        </label>
        <label className="chk" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span className="count-note">{t('markdowntoc.listStyle')}</span>
          <select
            className="mod-select"
            value={ordered ? 'ordered' : 'bullets'}
            onChange={(e) => setOrdered(e.target.value === 'ordered')}
          >
            <option value="bullets">{t('markdowntoc.bullets')}</option>
            <option value="ordered">{t('markdowntoc.numbered')}</option>
          </select>
        </label>
        <label className="chk">
          <input type="checkbox" checked={includeH1} onChange={(e) => setIncludeH1(e.target.checked)} />
          {t('markdowntoc.includeH1')}
        </label>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 4 }}>
        <span className="count-note" style={{ flex: 1 }}>
          {t('markdowntoc.inputLabel')} · {t('markdowntoc.outputLabel')}
        </span>
        <button className="mini primary" disabled={!result.md} onClick={copy}>
          {t('markdowntoc.copy')}
        </button>
      </div>

      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setMsg('');
          }}
          placeholder={t('markdowntoc.inputPlaceholder')}
        />
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={result.md}
          placeholder={t('markdowntoc.outputPlaceholder')}
        />
      </div>

      <p className="count-note" style={{ marginTop: 10 }}>
        {result.count === 0
          ? t('markdowntoc.noHeadings')
          : t('markdowntoc.headingCount', { n: result.count })}
        {msg ? ` · ${msg}` : ''}
      </p>
    </div>
  );
}
