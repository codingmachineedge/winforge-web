import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

// A friendly bilingual sample document shown when the module opens (from HtmlPreviewService.SampleHtml).
const SAMPLE_HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 24px; line-height: 1.55; }
      h1 { color: #2f9e44; }
      code { background: #f1f3f5; padding: 2px 6px; border-radius: 4px; }
      .card { border: 1px solid #ced4da; border-radius: 8px; padding: 12px 16px; margin-top: 12px; }
    </style>
  </head>
  <body>
    <h1>HTML Preview · HTML 預覽</h1>
    <p>Edit the HTML on the <strong>left</strong> — see it render live on the <strong>right</strong>.</p>
    <p>喺左邊改 <code>HTML</code>，右邊即時見到效果。</p>
    <div class="card">
      <p>Try a list:</p>
      <ul>
        <li>Headings, <em>emphasis</em> and <code>&lt;code&gt;</code></li>
        <li>Tables, links and images</li>
        <li>Inline <span style="color:#2f9e44;">styles</span></li>
      </ul>
    </div>
    <p>Happy hacking! 玩得開心！</p>
  </body>
</html>
`;

// Escape an HTML source string so it can be shown as literal text (entities preserved).
// Mirrors WebUtility.HtmlEncode: &, <, >, ", ' are encoded.
function escapeHtml(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// If the source looks like a bare fragment (no <html>/<!doctype>), wrap it in a
// minimal HTML5 document. Already-complete documents are returned unchanged.
function wrapFragment(source: string): string {
  const probe = source.replace(/^\s+/, '');
  const lower = probe.toLowerCase();
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) return source;
  return '<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>' + source + '</body></html>';
}

type Mode = 'render' | 'escape';

export function HtmlPreviewModule() {
  const { t } = useTranslation();
  const [source, setSource] = useState(SAMPLE_HTML);
  const [mode, setMode] = useState<Mode>('render');
  const [status, setStatus] = useState('');
  // Debounced source: the previewer only re-navigates on the trailing edge (~300ms).
  const [debounced, setDebounced] = useState(SAMPLE_HTML);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDebounced(source), 300);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [source]);

  useEffect(() => {
    setStatus(t('htmlpreview.ready'));
  }, [t]);

  const doc = useMemo(() => {
    if (mode === 'escape') {
      const escaped = escapeHtml(debounced);
      return (
        '<!DOCTYPE html><html><head><meta charset="utf-8" /></head>' +
        "<body><pre style=\"white-space:pre-wrap;font-family:'Cascadia Code',Consolas,monospace;padding:12px;\">" +
        escaped +
        '</pre></body></html>'
      );
    }
    return wrapFragment(debounced);
  }, [debounced, mode]);

  const onEscape = () => {
    setMode('escape');
    setStatus(t('htmlpreview.escaped'));
  };

  const onRender = () => {
    setMode('render');
    setStatus(t('htmlpreview.ready'));
  };

  const onCopy = () => {
    void navigator.clipboard?.writeText(source);
    setStatus(t('htmlpreview.copied'));
  };

  const onClear = () => {
    setSource('');
    setMode('render');
    setStatus(t('htmlpreview.cleared'));
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className={mode === 'render' ? 'mini primary' : 'mini'} onClick={onRender}>
          {t('htmlpreview.render')}
        </button>
        <button className={mode === 'escape' ? 'mini primary' : 'mini'} onClick={onEscape}>
          {t('htmlpreview.escape')}
        </button>
        <button className="mini" disabled={!source} onClick={onCopy}>
          {t('htmlpreview.copy')}
        </button>
        <button className="mini" onClick={onClear}>
          {t('htmlpreview.clear')}
        </button>
        <span className="count-note">{status}</span>
      </div>
      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ fontFamily: 'Consolas, monospace', minHeight: 420 }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={t('htmlpreview.inputPlaceholder')}
        />
        <iframe
          title={t('htmlpreview.previewTitle')}
          sandbox="allow-scripts"
          srcDoc={doc}
          style={{
            width: '100%',
            minHeight: 420,
            border: '1px solid var(--border, #ced4da)',
            borderRadius: 8,
            background: '#fff',
          }}
        />
      </div>
      <p className="count-note" style={{ marginTop: 10 }}>
        {t('htmlpreview.charCount', { count: source.length })}
      </p>
    </div>
  );
}
