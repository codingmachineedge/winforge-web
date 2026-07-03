import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge Pages/AdvancedPasteModule + AdvancedPasteService (PowerToys
// Advanced Paste): transform text with a catalog of pure actions, then copy the
// result. Fully self-contained (Clipboard API + string transforms), so it runs
// in the browser and the desktop app identically. AI/OCR actions are omitted
// (they need a model / image input) — every action here is deterministic.

interface Action {
  id: string;
  fn: (s: string) => string;
}

const titleCase = (s: string) =>
  s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

const toCsvTranspose = (s: string) => {
  const rows = s.trimEnd().split(/\r?\n/).map((r) => r.split(','));
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const out: string[] = [];
  for (let c = 0; c < cols; c++) out.push(rows.map((r) => r[c] ?? '').join(','));
  return out.join('\n');
};

const b64encode = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s.trim())));
  } catch {
    return s;
  }
};

const htmlEncode = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const htmlDecode = (s: string) => {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
};

const plainFromHtml = (s: string) => {
  const el = document.createElement('div');
  el.innerHTML = s;
  return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
};

const toJson = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    // Not JSON — quote it as a JSON string.
    return JSON.stringify(s);
  }
};

const ACTIONS: Action[] = [
  { id: 'plaintext', fn: (s) => s },
  { id: 'plainfromhtml', fn: plainFromHtml },
  { id: 'json', fn: toJson },
  { id: 'uppercase', fn: (s) => s.toUpperCase() },
  { id: 'lowercase', fn: (s) => s.toLowerCase() },
  { id: 'titlecase', fn: titleCase },
  { id: 'trim', fn: (s) => s.split(/\r?\n/).map((l) => l.trim()).join('\n').trim() },
  { id: 'removeblank', fn: (s) => s.split(/\r?\n/).filter((l) => l.trim()).join('\n') },
  { id: 'sortlines', fn: (s) => s.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join('\n') },
  { id: 'uniquelines', fn: (s) => [...new Set(s.split(/\r?\n/))].join('\n') },
  { id: 'transposecsv', fn: toCsvTranspose },
  { id: 'urlencode', fn: (s) => encodeURIComponent(s) },
  { id: 'urldecode', fn: (s) => { try { return decodeURIComponent(s); } catch { return s; } } },
  { id: 'base64encode', fn: b64encode },
  { id: 'base64decode', fn: b64decode },
  { id: 'htmlencode', fn: htmlEncode },
  { id: 'htmldecode', fn: htmlDecode },
];

export function AdvancedPasteModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return ACTIONS.filter((a) => !q || t(`advancedpaste.act_${a.id}`).toLowerCase().includes(q) || a.id.includes(q));
  }, [filter, t]);

  const run = (a: Action) => {
    setActiveId(a.id);
    setOutput(a.fn(input));
    setCopied(false);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInput(text);
    } catch {
      /* clipboard read blocked — user can paste manually */
    }
  };

  const copyOut = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" onClick={pasteFromClipboard}>{t('advancedpaste.pasteIn')}</button>
        <input className="mod-search" placeholder={t('advancedpaste.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: '1 1 200px' }} />
      </div>
      <p className="count-note">{t('advancedpaste.blurb')}</p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px' }}>
          <div className="count-note">{t('advancedpaste.inputLabel')}</div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('advancedpaste.inputPh')}
            style={{ width: '100%', height: 160, background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--stroke)', borderRadius: 'var(--radius)', padding: 8, fontFamily: 'var(--font)', resize: 'vertical' }}
          />
        </div>
        <div style={{ flex: '1 1 300px' }}>
          <div className="count-note">
            {t('advancedpaste.outputLabel')}{' '}
            {output && <button className="mini" onClick={copyOut}>{copied ? t('advancedpaste.copied') : t('advancedpaste.copy')}</button>}
          </div>
          <textarea
            value={output}
            readOnly
            placeholder={t('advancedpaste.outputPh')}
            style={{ width: '100%', height: 160, background: 'var(--bg-card)', color: 'var(--text)', border: '1px solid var(--stroke)', borderRadius: 'var(--radius)', padding: 8, fontFamily: 'var(--font)', resize: 'vertical' }}
          />
        </div>
      </div>

      <p className="count-note">{t('advancedpaste.actionsLabel', { total: shown.length })}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map((a) => (
          <button key={a.id} className={`mini${activeId === a.id ? ' primary' : ''}`} onClick={() => run(a)} title={t(`advancedpaste.desc_${a.id}`)}>
            {t(`advancedpaste.act_${a.id}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
