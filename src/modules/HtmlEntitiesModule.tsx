import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const NAMED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function encode(s: string, nonAscii: boolean): string {
  let out = s.replace(/[&<>"']/g, (c) => NAMED[c]!);
  if (nonAscii) out = out.replace(/[-￿]/g, (c) => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`);
  return out;
}
function decode(s: string): string {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

const COMMON: [string, string][] = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&nbsp;', ' '],
  ['&copy;', '©'],
  ['&reg;', '®'],
  ['&trade;', '™'],
  ['&hellip;', '…'],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&lsquo;', '‘'],
  ['&rsquo;', '’'],
  ['&ldquo;', '“'],
  ['&rdquo;', '”'],
  ['&euro;', '€'],
  ['&pound;', '£'],
  ['&yen;', '¥'],
  ['&cent;', '¢'],
  ['&deg;', '°'],
  ['&plusmn;', '±'],
  ['&times;', '×'],
  ['&divide;', '÷'],
  ['&frac12;', '½'],
  ['&frac14;', '¼'],
  ['&frac34;', '¾'],
  ['&sup2;', '²'],
  ['&sup3;', '³'],
  ['&micro;', 'µ'],
  ['&para;', '¶'],
  ['&sect;', '§'],
  ['&larr;', '←'],
  ['&rarr;', '→'],
  ['&uarr;', '↑'],
  ['&darr;', '↓'],
  ['&spades;', '♠'],
  ['&clubs;', '♣'],
  ['&hearts;', '♥'],
  ['&diams;', '♦'],
];

export function HtmlEntitiesModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [nonAscii, setNonAscii] = useState(false);
  const [input, setInput] = useState('<p class="x">© 2026 — "WinForge" & Co.</p>');
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState('');

  const output = useMemo(() => (mode === 'encode' ? encode(input, nonAscii) : decode(input)), [input, mode, nonAscii]);
  const ref = COMMON.filter(([name, ch]) => !filter || name.includes(filter.toLowerCase()) || ch.includes(filter));

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as 'encode' | 'decode')}>
          <option value="encode">{t('htmlent.encode')}</option>
          <option value="decode">{t('htmlent.decode')}</option>
        </select>
        {mode === 'encode' && (
          <label className="chk">
            <input type="checkbox" checked={nonAscii} onChange={(e) => setNonAscii(e.target.checked)} />
            {t('htmlent.nonAscii')}
          </label>
        )}
        <button className="mini" onClick={() => output && (navigator.clipboard?.writeText(output), setMsg(t('htmlent.copied')))}>
          {t('htmlent.copy')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>
      <div className="io-grid">
        <textarea className="hosts-edit" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} />
      </div>

      <div className="mod-toolbar" style={{ marginTop: 12 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('htmlent.common')}
        </h3>
        <input className="mod-search" style={{ maxWidth: 200 }} placeholder="&…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('htmlent.clickRow')}
      </p>
      <div className="dt-wrap" style={{ maxHeight: 320 }}>
        <table className="dt">
          <tbody>
            {ref.map(([name, ch]) => (
              <tr key={name} style={{ cursor: 'pointer' }} onClick={() => (navigator.clipboard?.writeText(name), setMsg(t('htmlent.copied')))}>
                <td style={{ width: 60, fontSize: 18, textAlign: 'center' }}>{ch}</td>
                <td>
                  <code>{name}</code>
                </td>
                <td className="env-val">{`&#x${ch.codePointAt(0)!.toString(16).toUpperCase()};`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
