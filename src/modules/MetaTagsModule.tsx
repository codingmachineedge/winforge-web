import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// HTML-encode an attribute/text value the same way WinForge's MetaTagsService does
// (System.Net.WebUtility.HtmlEncode on the trimmed value). WebUtility encodes
// & < > " and ' (as &#39;) — matching that exact set keeps output identical.
const ENC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function enc(s: string | undefined): string {
  return (s ?? '').trim().replace(/[&<>"']/g, (c) => ENC[c]!);
}
function has(s: string | undefined): boolean {
  return !!s && s.trim().length > 0;
}

interface MetaInput {
  title: string;
  description: string;
  keywords: string;
  author: string;
  canonical: string;
  viewport: string;
  themeColor: string;
  charset: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogUrl: string;
  ogType: string;
  twitterCard: string;
  twitterSite: string;
  twitterCreator: string;
}

const SEED: MetaInput = {
  title: '',
  description: '',
  keywords: '',
  author: '',
  canonical: '',
  viewport: 'width=device-width, initial-scale=1',
  themeColor: '',
  charset: 'UTF-8',
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  ogUrl: '',
  ogType: 'website',
  twitterCard: 'summary_large_image',
  twitterSite: '',
  twitterCreator: '',
};

// Build the <head> block. Emits only non-empty fields, in WinForge's exact order,
// with every value HTML-encoded. Never throws.
function build(i: MetaInput): string {
  const lines: string[] = [];
  if (has(i.charset)) lines.push(`<meta charset="${enc(i.charset)}">`);
  if (has(i.title)) lines.push(`<title>${enc(i.title)}</title>`);
  if (has(i.viewport)) lines.push(`<meta name="viewport" content="${enc(i.viewport)}">`);
  if (has(i.description)) lines.push(`<meta name="description" content="${enc(i.description)}">`);
  if (has(i.keywords)) lines.push(`<meta name="keywords" content="${enc(i.keywords)}">`);
  if (has(i.author)) lines.push(`<meta name="author" content="${enc(i.author)}">`);
  if (has(i.themeColor)) lines.push(`<meta name="theme-color" content="${enc(i.themeColor)}">`);
  if (has(i.canonical)) lines.push(`<link rel="canonical" href="${enc(i.canonical)}">`);

  // Open Graph
  if (has(i.ogTitle)) lines.push(`<meta property="og:title" content="${enc(i.ogTitle)}">`);
  if (has(i.ogDescription)) lines.push(`<meta property="og:description" content="${enc(i.ogDescription)}">`);
  if (has(i.ogType)) lines.push(`<meta property="og:type" content="${enc(i.ogType)}">`);
  if (has(i.ogUrl)) lines.push(`<meta property="og:url" content="${enc(i.ogUrl)}">`);
  if (has(i.ogImage)) lines.push(`<meta property="og:image" content="${enc(i.ogImage)}">`);

  // Twitter
  if (has(i.twitterCard)) lines.push(`<meta name="twitter:card" content="${enc(i.twitterCard)}">`);
  if (has(i.twitterSite)) lines.push(`<meta name="twitter:site" content="${enc(i.twitterSite)}">`);
  if (has(i.twitterCreator)) lines.push(`<meta name="twitter:creator" content="${enc(i.twitterCreator)}">`);

  return lines.join('\n');
}

function countTags(i: MetaInput): number {
  const s = build(i);
  if (!s) return 0;
  return s.split('\n').length;
}

export function MetaTagsModule() {
  const { t } = useTranslation();
  const [f, setF] = useState<MetaInput>(SEED);
  const [status, setStatus] = useState('');

  const set = (k: keyof MetaInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const output = useMemo(() => build(f), [f]);
  const count = useMemo(() => countTags(f), [f]);

  const statusLine =
    status ||
    (count === 0 ? t('metatags.statusEmpty') : t('metatags.statusCount', { count }));

  const copy = () => {
    if (!output) {
      setStatus(t('metatags.nothingToCopy'));
      return;
    }
    try {
      navigator.clipboard?.writeText(output);
      setStatus(t('metatags.copied'));
    } catch {
      setStatus(t('metatags.copyFailed'));
    }
  };

  const field = (
    k: keyof MetaInput,
    labelKey: string,
    opts?: { multiline?: boolean },
  ) => (
    <label className="kv-row" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
      <span style={{ fontSize: 12.5, opacity: 0.85 }}>{t(labelKey)}</span>
      {opts?.multiline ? (
        <textarea
          className="hosts-edit"
          style={{ minHeight: 60 }}
          spellCheck={false}
          value={f[k]}
          onChange={set(k)}
        />
      ) : (
        <input className="mod-search" style={{ maxWidth: 'none' }} value={f[k]} onChange={set(k)} />
      )}
    </label>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('metatags.blurb')}</p>

      <div className="io-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 className="group-title" style={{ fontSize: 14, margin: 0 }}>{t('metatags.basic')}</h3>
            {field('title', 'metatags.title')}
            {field('description', 'metatags.description', { multiline: true })}
            {field('keywords', 'metatags.keywords')}
            {field('author', 'metatags.author')}
            {field('canonical', 'metatags.canonical')}
            {field('viewport', 'metatags.viewport')}
            {field('themeColor', 'metatags.themeColor')}
            {field('charset', 'metatags.charset')}
          </div>

          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 className="group-title" style={{ fontSize: 14, margin: 0 }}>{t('metatags.ogHeading')}</h3>
            {field('ogTitle', 'metatags.ogTitle')}
            {field('ogDescription', 'metatags.ogDescription', { multiline: true })}
            {field('ogImage', 'metatags.ogImage')}
            {field('ogUrl', 'metatags.ogUrl')}
            {field('ogType', 'metatags.ogType')}
          </div>

          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 className="group-title" style={{ fontSize: 14, margin: 0 }}>{t('metatags.twHeading')}</h3>
            {field('twitterCard', 'metatags.twCard')}
            {field('twitterSite', 'metatags.twSite')}
            {field('twitterCreator', 'metatags.twCreator')}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="mod-toolbar" style={{ marginTop: 0 }}>
            <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>{t('metatags.output')}</h3>
            <button className="mini primary" onClick={copy}>{t('metatags.copy')}</button>
          </div>
          <textarea
            className="hosts-edit"
            style={{ minHeight: 200, fontFamily: 'Consolas, monospace' }}
            spellCheck={false}
            readOnly
            value={output}
          />
          <p className="count-note" style={{ marginTop: 0 }}>{statusLine}</p>
        </div>
      </div>
    </div>
  );
}
