import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, isTauri } from '../tauri/bridge';

// Port of WinForge Pages/FeedReaderModule + FeedReaderService: subscribe to
// RSS/Atom feeds, refresh, and read articles. Feed XML is fetched through the
// Tauri backend (Invoke-WebRequest) to dodge browser CORS; the browser build
// tries a direct fetch as a best effort. Subscriptions persist to localStorage.

interface Feed {
  id: string;
  title: string;
  url: string;
}

interface Article {
  feedTitle: string;
  title: string;
  link: string;
  author: string;
  summary: string;
  published: number | null; // epoch ms
}

const KEY = 'winforge-web.feeds.v1';
const DEFAULT_FEEDS: Feed[] = [
  { id: 'hn', title: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { id: 'verge', title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

function loadFeeds(): Feed[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return DEFAULT_FEEDS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_FEEDS;
  } catch {
    return DEFAULT_FEEDS;
  }
}

const uid = (url: string) => `${url}#${Math.abs([...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;

const text = (el: Element | null | undefined, sel: string): string => {
  const n = el?.querySelector(sel);
  return (n?.textContent ?? '').trim();
};

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function parseFeed(xml: string, feed: Feed): Article[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const feedTitle = feed.title || text(doc.documentElement, 'channel > title') || text(doc.documentElement, 'title');
  const out: Article[] = [];

  // RSS 2.0
  doc.querySelectorAll('item').forEach((item) => {
    const dateStr = text(item, 'pubDate') || text(item, 'date');
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    out.push({
      feedTitle,
      title: text(item, 'title'),
      link: text(item, 'link') || item.querySelector('link')?.getAttribute('href') || '',
      author: text(item, 'creator') || text(item, 'author'),
      summary: stripHtml(text(item, 'description') || text(item, 'encoded')).slice(0, 400),
      published: Number.isNaN(parsed) ? null : parsed,
    });
  });

  // Atom
  if (out.length === 0) {
    doc.querySelectorAll('entry').forEach((entry) => {
      const dateStr = text(entry, 'updated') || text(entry, 'published');
      const parsed = dateStr ? Date.parse(dateStr) : NaN;
      const link =
        entry.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
        entry.querySelector('link')?.getAttribute('href') ||
        '';
      out.push({
        feedTitle,
        title: text(entry, 'title'),
        link,
        author: text(entry, 'author > name'),
        summary: stripHtml(text(entry, 'summary') || text(entry, 'content')).slice(0, 400),
        published: Number.isNaN(parsed) ? null : parsed,
      });
    });
  }
  return out;
}

async function fetchXml(url: string, live: boolean): Promise<string> {
  if (live) {
    // Invoke-WebRequest via the backend — no CORS. Base64 the URL to avoid quoting issues.
    const b64 = btoa(url);
    const script = `
$u = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
(Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20 -Headers @{ 'User-Agent' = 'WinForge/1.0' }).Content
`;
    const res = await runPowershell(script);
    if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    return res.stdout;
  }
  // Browser best-effort (works for CORS-enabled feeds only).
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function FeedReaderModule() {
  const { t, i18n } = useTranslation();
  const live = isTauri();
  const [feeds, setFeeds] = useState<Feed[]>(loadFeeds);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [activeFeed, setActiveFeed] = useState<string>('all');

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(feeds));
    } catch {
      /* ignore */
    }
  }, [feeds]);

  const refresh = async (which: Feed[]) => {
    setLoading(true);
    setError(null);
    const all: Article[] = [];
    const errors: string[] = [];
    await Promise.all(
      which.map(async (f) => {
        try {
          const xml = await fetchXml(f.url, live);
          all.push(...parseFeed(xml, f));
        } catch (e) {
          errors.push(`${f.title || f.url}: ${String((e as Error).message ?? e)}`);
        }
      }),
    );
    all.sort((a, b) => (b.published ?? 0) - (a.published ?? 0));
    setArticles(all);
    if (errors.length) setError(errors.join(' · '));
    setLoading(false);
  };

  const addFeed = () => {
    const url = newUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      setError(t('feedreader.badUrl'));
      return;
    }
    if (feeds.some((f) => f.url === url)) return;
    const f: Feed = { id: uid(url), title: '', url };
    setFeeds((prev) => [...prev, f]);
    setNewUrl('');
    void refresh([f]);
  };

  const removeFeed = (id: string) => setFeeds((prev) => prev.filter((f) => f.id !== id));

  const shown = useMemo(() => {
    if (activeFeed === 'all') return articles;
    const f = feeds.find((x) => x.id === activeFeed);
    return f ? articles.filter((a) => a.feedTitle === (f.title || a.feedTitle)) : articles;
  }, [articles, activeFeed, feeds]);

  const fmtDate = (ms: number | null) =>
    ms == null ? '' : new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-US' : 'zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <input
          className="mod-search"
          placeholder={t('feedreader.addPh')}
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addFeed()}
          style={{ flex: '1 1 320px' }}
        />
        <button className="mini primary" onClick={addFeed}>{t('feedreader.add')}</button>
        <button className="mini" onClick={() => refresh(feeds)} disabled={loading}>
          {loading ? t('feedreader.refreshing') : t('feedreader.refreshAll')}
        </button>
      </div>
      <p className="count-note">{t('feedreader.blurb')}</p>
      {!live && <p className="count-note">{t('feedreader.corsNote')}</p>}
      {error && <pre className="cmd-out error">{error}</pre>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className={`mini${activeFeed === 'all' ? ' primary' : ''}`} onClick={() => setActiveFeed('all')}>
          {t('feedreader.allFeeds')}
        </button>
        {feeds.map((f) => (
          <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button className={`mini${activeFeed === f.id ? ' primary' : ''}`} onClick={() => setActiveFeed(f.id)}>
              {f.title || f.url.replace(/^https?:\/\//, '').slice(0, 28)}
            </button>
            <button className="mini" title={t('feedreader.remove')} onClick={() => removeFeed(f.id)}>✕</button>
          </span>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="count-note">{loading ? t('feedreader.refreshing') : t('feedreader.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="count-note">{t('feedreader.count', { articles: shown.length })}</p>
          {shown.slice(0, 100).map((a, i) => (
            <div key={`${a.link}-${i}`} className="panel">
              <a href={a.link} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                {a.title || '(untitled)'}
              </a>
              <div className="count-note" style={{ margin: '2px 0' }}>
                {a.feedTitle}{a.author ? ` · ${a.author}` : ''}{a.published ? ` · ${fmtDate(a.published)}` : ''}
              </div>
              {a.summary && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{a.summary}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
