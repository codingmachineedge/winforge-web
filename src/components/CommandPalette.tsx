import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allModules, type CatalogModule } from '../data/catalog';
import { sectionByTag } from '../data/sectionIndex';
import { moduleStatus, type ModuleStatus } from '../modules/status';
import { pick, sub } from '../i18n';
import { fuzzyScore, fuzzyRanges, mergeRanges, type Range } from '../data/fuzzy';
import { Highlight } from './Highlight';

// The feature-text search index flattens every module's i18n strings (~570 kB), so
// it is loaded lazily the first time the palette opens rather than shipped eagerly.
// Until it resolves, ranking falls back to title/keyword matching (a few ms gap).
type FeatureIndex = typeof import('../data/featureIndex');

type Capability = 'all' | 'web' | 'native';
type StatusFilter = 'any' | 'working' | 'stub';

interface Props {
  open: boolean;
  lang: string;
  initialQuery?: string;
  onClose: () => void;
  onOpenModule: (tag: string) => void;
}

interface Hit {
  m: CatalogModule;
  status: ModuleStatus;
  score: number;
  feature: string | null; // feature snippet when matched via features only
  featureRanges: Range[]; // highlight ranges within the feature snippet (plain substring)
}

const terms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

// Exact-substring ranges of every term within `text` (already lower-cased match on
// the lower-cased haystack, but indices apply to the original-cased text too since
// lower-casing here is 1:1 for our Latin/CJK content). Used for feature snippets.
function substringRanges(text: string, ts: string[]): Range[] {
  const lc = text.toLowerCase();
  const out: Range[] = [];
  for (const t of ts) {
    let from = 0;
    let idx: number;
    while ((idx = lc.indexOf(t, from)) >= 0) {
      out.push({ start: idx, end: idx + t.length });
      from = idx + t.length;
    }
  }
  return mergeRanges(out);
}

function rank(
  m: CatalogModule,
  ts: string[],
  fi: FeatureIndex | null,
): { score: number; feature: string | null } | null {
  if (ts.length === 0) return { score: 0, feature: null };
  const title = `${m.en} ${m.zh}`.toLowerCase();
  const keys = m.keywords.toLowerCase();
  const feat = fi ? fi.featureTextFor(m.tag) : '';
  let score = 0;
  let viaFeatureOnly = true;
  for (const t of ts) {
    const inTitle = title.includes(t);
    const inKeys = keys.includes(t);
    const inFeat = feat.includes(t);
    if (inTitle) {
      // Exact fast path (dominant tier, unchanged weights).
      score += 6;
      viaFeatureOnly = false;
      if (m.en.toLowerCase().startsWith(t)) score += 4; // exact title start bonus
      continue;
    }
    if (inKeys) {
      score += 3;
      viaFeatureOnly = false;
      continue;
    }
    if (inFeat) {
      score += 1; // feature substring fallback
      continue;
    }
    // Fuzzy fallback tier — only on title/keys (features are huge → substring only).
    // Ranks strictly below exact matches: fuzzy title ~2, fuzzy keys ~1.
    if (fuzzyScore(t, title) !== null) {
      score += 2;
      viaFeatureOnly = false;
      continue;
    }
    if (fuzzyScore(t, keys) !== null) {
      score += 1;
      viaFeatureOnly = false;
      continue;
    }
    return null; // every term must match somewhere (exact or fuzzy)
  }
  return { score, feature: viaFeatureOnly && fi ? fi.matchedFeature(m.tag, ts) : null };
}

export function CommandPalette({ open, lang, initialQuery = '', onClose, onOpenModule }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [capability, setCapability] = useState<Capability>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('any');
  const [active, setActive] = useState(0);
  const [featureIndex, setFeatureIndex] = useState<FeatureIndex | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setActive(0);
      const id = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open, initialQuery]);

  // Pull in the feature-text index the first time the palette opens; results
  // re-rank automatically once it lands (see the `featureIndex` dep on `hits`).
  useEffect(() => {
    if (open && !featureIndex) {
      let alive = true;
      void import('../data/featureIndex').then((m) => {
        if (alive) setFeatureIndex(m);
      });
      return () => {
        alive = false;
      };
    }
    return undefined;
  }, [open, featureIndex]);

  const ts = useMemo(() => terms(query), [query]);

  const hits: Hit[] = useMemo(() => {
    const out: Hit[] = [];
    for (const m of allModules) {
      if (capability !== 'all' && (capability === 'native') !== m.native) continue;
      const status = moduleStatus(m.tag);
      if (statusFilter === 'working' && status === 'stub') continue;
      if (statusFilter === 'stub' && status !== 'stub') continue;
      const r = rank(m, ts, featureIndex);
      if (!r) continue;
      const featureRanges = r.feature ? substringRanges(r.feature, ts) : [];
      out.push({ m, status, score: r.score, feature: r.feature, featureRanges });
    }
    out.sort((a, b) => b.score - a.score || a.m.en.localeCompare(b.m.en));
    return out.slice(0, 60);
  }, [ts, capability, statusFilter, featureIndex]);

  // clamp active index whenever the list changes
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, hits.length - 1)));
  }, [hits.length]);

  // keep the active row scrolled into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (tag: string) => {
    onOpenModule(tag);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const h = hits[active]; if (h) choose(h.m.tag); }
  };

  const capOpts: { k: Capability; label: string }[] = [
    { k: 'all', label: t('palette.capAll') },
    { k: 'web', label: t('palette.capWeb') },
    { k: 'native', label: t('palette.capNative') },
  ];
  const statusOpts: { k: StatusFilter; label: string }[] = [
    { k: 'any', label: t('palette.statusAny') },
    { k: 'working', label: t('palette.statusWorking') },
    { k: 'stub', label: t('palette.statusStub') },
  ];

  return (
    <div className="cp-backdrop" onMouseDown={onClose}>
      <div className="cp-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey} role="dialog" aria-modal="true">
        <div className="cp-searchrow">
          <span className="cp-search-icon glyph">⌕</span>
          <input
            ref={inputRef}
            className="cp-input"
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            aria-label={t('palette.placeholder')}
          />
          <kbd className="cp-esc">Esc</kbd>
        </div>

        <div className="cp-controls">
          <div className="cp-toggle-group" role="group" aria-label={t('palette.capability')}>
            <span className="cp-toggle-label">{t('palette.capability')}</span>
            {capOpts.map((o) => (
              <button key={o.k} className={`cp-chip${capability === o.k ? ' on' : ''}`} onClick={() => setCapability(o.k)}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="cp-toggle-group" role="group" aria-label={t('palette.status')}>
            <span className="cp-toggle-label">{t('palette.status')}</span>
            {statusOpts.map((o) => (
              <button key={o.k} className={`cp-chip${statusFilter === o.k ? ' on' : ''}`} onClick={() => setStatusFilter(o.k)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="cp-results" ref={listRef}>
          {hits.length === 0 ? (
            <div className="cp-empty">{t('palette.noResults')}</div>
          ) : (
            hits.map((h, i) => {
              const title = pick(h.m.en, h.m.zh, lang);
              const subtitle = sub(h.m.en, h.m.zh, lang);
              const section = sectionByTag.get(h.m.tag);
              // Highlight matched characters in the displayed title (best match per term,
              // merged). Uses fuzzyRanges so exact + typo + subsequence all highlight.
              const titleRanges = mergeRanges(ts.flatMap((term) => fuzzyRanges(term, title)));
              return (
                <button
                  key={h.m.tag}
                  data-idx={i}
                  className={`cp-row${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h.m.tag)}
                >
                  <span className="cp-glyph glyph">{h.m.glyph || '▢'}</span>
                  <span className="cp-main">
                    <span className="cp-title">
                      <Highlight text={title} ranges={titleRanges} />
                      {subtitle && subtitle !== title && <span className="cp-sub">{subtitle}</span>}
                    </span>
                    {h.feature ? (
                      <span className="cp-feature">
                        <span className="cp-feature-tag">{t('palette.inFeatures')}</span>{' '}
                        <Highlight text={h.feature} ranges={h.featureRanges} />
                      </span>
                    ) : (
                      section && <span className="cp-section">{pick(section.en, section.zh, lang)}</span>
                    )}
                  </span>
                  <span className="cp-badges">
                    <span className={`status-pill ${h.status}`}>{t(`status.${h.status}`)}</span>
                    <span className={`tag-pill ${h.m.native ? 'native' : 'web'}`}>
                      {h.m.native ? t('catalog.native') : t('catalog.web')}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="cp-foot">
          <span>{t('palette.count', { n: hits.length })}</span>
          <span className="cp-hints">
            <kbd>↑</kbd><kbd>↓</kbd> {t('palette.hintNav')} · <kbd>↵</kbd> {t('palette.hintOpen')} · <kbd>Esc</kbd> {t('palette.hintClose')}
          </span>
        </div>
      </div>
    </div>
  );
}
