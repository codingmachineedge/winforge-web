import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TextWrapService (wrap / unwrap / reflow / prefix / hanging-indent).
const MIN_W = 1, MAX_W = 2000;
const clampW = (w: number) => (w < MIN_W ? MIN_W : w > MAX_W ? MAX_W : w);
const splitLines = (t: string) => (t ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

function paragraphs(text: string): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of splitLines(text)) {
    if (line.trim().length === 0) { result.push(current); current = []; }
    else current.push(line);
  }
  result.push(current);
  return result;
}

function wrapOne(text: string, width: number, breakLong: boolean): string[] {
  width = clampW(width);
  const lines: string[] = [];
  const words = text.split(/[ \t]+/).filter((w) => w.length > 0);
  let sb = '';
  for (const raw of words) {
    let word = raw;
    if (breakLong && word.length > width) {
      if (sb.length > 0) { lines.push(sb); sb = ''; }
      while (word.length > width) { lines.push(word.slice(0, width)); word = word.slice(width); }
      if (word.length > 0) sb += word;
      continue;
    }
    if (sb.length === 0) sb = word;
    else if (sb.length + 1 + word.length <= width) sb += ' ' + word;
    else { lines.push(sb); sb = word; }
  }
  if (sb.length > 0) lines.push(sb);
  return lines;
}
const trimAll = (lines: string[]) => lines.map((l) => l.trim());

function hardWrap(text: string, width: number, breakLong: boolean): string {
  width = clampW(width);
  return paragraphs(text).map((para) => (para.length === 0 ? '' : wrapOne(trimAll(para).join(' '), width, breakLong).join('\n'))).join('\n\n');
}
function unwrap(text: string): string {
  return paragraphs(text).map((para) => (para.length === 0 ? '' : trimAll(para).join(' '))).join('\n\n');
}
const reflow = (text: string, width: number, breakLong: boolean) => hardWrap(unwrap(text), width, breakLong);
function addPrefix(text: string, prefix: string): string {
  return splitLines(text).map((l) => prefix + l).join('\n');
}
function hangingIndent(text: string, spaces: number): string {
  spaces = Math.max(0, Math.min(MAX_W, spaces));
  const pad = ' '.repeat(spaces);
  return paragraphs(text).map((para) => (para.length === 0 ? '' : para.map((l, i) => (i === 0 ? l : pad + l)).join('\n'))).join('\n\n');
}

export function TextWrapModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('The quick brown fox jumps over the lazy dog and then keeps running across the wide open field until it is quite tired.\n\nSecond paragraph here with several words to wrap.');
  const [output, setOutput] = useState('');
  const [width, setWidth] = useState(40);
  const [breakLong, setBreakLong] = useState(false);
  const [prefix, setPrefix] = useState('> ');
  const [indent, setIndent] = useState(4);

  const run = (fn: () => string) => setOutput(fn());

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textwrap.width')}</label>
        <input className="mod-search" type="number" min={1} max={2000} style={{ maxWidth: 80 }} value={width} onChange={(e) => setWidth(+e.target.value)} />
        <label className="chk"><input type="checkbox" checked={breakLong} onChange={(e) => setBreakLong(e.target.checked)} /> {t('textwrap.breakLong')}</label>
        <button className="mini primary" onClick={() => run(() => hardWrap(input, width, breakLong))}>{t('textwrap.hardWrap')}</button>
        <button className="mini" onClick={() => run(() => unwrap(input))}>{t('textwrap.unwrap')}</button>
        <button className="mini" onClick={() => run(() => reflow(input, width, breakLong))}>{t('textwrap.reflow')}</button>
      </div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('textwrap.prefix')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 30, maxWidth: 90 }} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        <button className="mini" onClick={() => run(() => addPrefix(input, prefix))}>{t('textwrap.addPrefix')}</button>
        <label className="count-note">{t('textwrap.indent')}</label>
        <input className="mod-search" type="number" min={0} max={100} style={{ maxWidth: 70 }} value={indent} onChange={(e) => setIndent(+e.target.value)} />
        <button className="mini" onClick={() => run(() => hangingIndent(input, indent))}>{t('textwrap.hanging')}</button>
        <button className="mini" disabled={!output} onClick={() => navigator.clipboard?.writeText(output)}>{t('textwrap.copy')}</button>
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('textwrap.input')} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('textwrap.output')} />
      </div>
    </div>
  );
}
