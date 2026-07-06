import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';
import {
  tweaks as ALL_TWEAKS,
  tweakCategories,
  type TweakData,
  type TweakKind,
  type RestartScope,
} from '../data/tweaks';

// Browsable, fully-bilingual view over WinForge's desktop TweakCatalog (the ~895 Windows
// tweaks that make up most of the app's 1209 features). Applying a tweak edits the Windows
// registry / services / powercfg and only runs in the WinForge desktop app, so — exactly
// like the native-module stubs and SettingsHubModule — the web renders every tweak as a
// searchable reference card with its real metadata (kind, elevation, destructiveness,
// restart scope) and a kind-appropriate, inert control preview.

const KIND_LABEL: Record<TweakKind, [string, string]> = {
  Action: ['Action', '動作'],
  Toggle: ['Toggle', '開關'],
  RadioGroup: ['Options', '選項'],
  Choice: ['Choice', '選擇'],
  Slider: ['Slider', '滑桿'],
  Info: ['Info', '資訊'],
  Wizard: ['Wizard', '精靈'],
  Color: ['Colour', '顏色'],
};

const RESTART_LABEL: Record<RestartScope, [string, string]> = {
  None: ['', ''],
  Explorer: ['Restart Explorer', '重啟檔案總管'],
  SignOut: ['Sign out', '登出'],
  Reboot: ['Reboot', '重新開機'],
};

function haystack(t: TweakData): string {
  return `${t.en} ${t.zh} ${t.descEn} ${t.descZh} ${t.keywords} ${t.id}`.toLowerCase();
}

/** An inert, kind-appropriate control preview (writes are desktop-only). */
function ControlPreview({ t, px }: { t: TweakData; px: (en: string, zh: string) => string }) {
  switch (t.kind) {
    case 'Toggle':
      return <input type="checkbox" disabled aria-label={px('Toggle', '開關')} />;
    case 'Slider':
      return <input type="range" disabled style={{ width: 90 }} aria-label={px('Slider', '滑桿')} />;
    case 'Choice':
    case 'RadioGroup':
      return (
        <select className="mod-select" disabled style={{ maxWidth: 130 }} aria-label={px('Options', '選項')}>
          <option>{px('Options', '選項')}</option>
        </select>
      );
    case 'Color':
      return (
        <span
          aria-label={px('Colour', '顏色')}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: 'inline-block',
            border: '1px solid var(--border, rgba(128,128,128,0.4))',
            background: 'linear-gradient(135deg,#4c8bf5,#8e5cf5)',
          }}
        />
      );
    case 'Info':
      return <span className="mini" aria-hidden>ⓘ</span>;
    case 'Wizard':
      return (
        <button className="mini" disabled>
          {px('Wizard…', '精靈…')}
        </button>
      );
    case 'Action':
    default:
      return (
        <button className="mini" disabled>
          {t.actionEn ? px(t.actionEn, t.actionZh ?? t.actionEn) : px('Run', '執行')}
        </button>
      );
  }
}

function Badge({ text, tone }: { text: string; tone?: 'admin' | 'danger' | 'restart' | 'kind' }) {
  const color =
    tone === 'danger'
      ? 'var(--danger, #d9534f)'
      : tone === 'admin'
        ? 'var(--warning, #c9821b)'
        : tone === 'restart'
          ? 'var(--text-secondary)'
          : 'var(--text-tertiary)';
  return (
    <span
      className="mini"
      style={{
        fontSize: 10.5,
        padding: '1px 6px',
        borderColor: color,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

interface Props {
  /** Category slug (matches tweakCategories[].id). Omit to browse every category. */
  categoryId?: string;
}

export function TweaksBrowser({ categoryId }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const px = (en: string, zh: string) => pick(en, zh, lang);
  const [filter, setFilter] = useState('');

  const base = useMemo(
    () => (categoryId ? ALL_TWEAKS.filter((t) => t.cat === categoryId) : ALL_TWEAKS),
    [categoryId],
  );

  const hits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return base;
    const terms = q.split(/\s+/).filter(Boolean);
    return base.filter((t) => {
      const h = haystack(t);
      return terms.every((term) => h.includes(term));
    });
  }, [base, filter]);

  // Group hits by category, preserving the canonical category order.
  const groups = useMemo(() => {
    const byCat = new Map<string, TweakData[]>();
    for (const t of hits) {
      const bucket = byCat.get(t.cat);
      if (bucket) bucket.push(t);
      else byCat.set(t.cat, [t]);
    }
    return tweakCategories
      .filter((c) => byCat.has(c.id))
      .map((c) => ({ cat: c, items: byCat.get(c.id)! }));
  }, [hits]);

  return (
    <div className="mod">
      <p className="count-note">
        {px(
          'Every Windows tweak WinForge ships — searchable in English and 粵語.',
          'WinForge 提供嘅每項 Windows 調校 — 可用英文同粵語搜尋。',
        )}
      </p>
      <p className="count-note" style={{ color: 'var(--text-secondary)' }}>
        {px(
          'Applying a tweak edits the Windows registry / services and runs in the WinForge desktop app; this web catalog is a reference.',
          '套用調校會修改 Windows 登錄／服務，需喺 WinForge 桌面版執行；此網頁目錄係參考用途。',
        )}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 340 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={px('Search tweaks…', '搜尋調校…')}
        />
        {filter && (
          <button className="mini" onClick={() => setFilter('')}>
            {px('Clear', '清除')}
          </button>
        )}
        <span className="count-note">
          {px(`${hits.length} tweaks`, `${hits.length} 項調校`)}
        </span>
      </div>

      {hits.length === 0 && (
        <p className="count-note">{px('No tweaks match your search.', '冇符合搜尋嘅調校。')}</p>
      )}

      {groups.map(({ cat, items }) => (
        <div className="panel" key={cat.id} style={{ marginTop: 10 }}>
          <div className="label" style={{ marginBottom: 6, fontWeight: 600 }}>
            {px(cat.en, cat.zh)} <span className="count-note">({items.length})</span>
          </div>
          <div className="kv-list">
            {items.map((t) => {
              const restart = RESTART_LABEL[t.restart];
              return (
                <div className="kv-row" key={t.id} style={{ alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="label" style={{ fontWeight: 600 }}>
                      {px(t.en, t.zh)}
                    </div>
                    {t.descEn && (
                      <div
                        className="value"
                        style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 1 }}
                      >
                        {px(t.descEn, t.descZh || t.descEn)}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                      <Badge text={px(...KIND_LABEL[t.kind])} tone="kind" />
                      {t.admin && <Badge text={px('Admin', '管理員')} tone="admin" />}
                      {t.destructive && <Badge text={px('Destructive', '具破壞性')} tone="danger" />}
                      {t.restart !== 'None' && <Badge text={px(restart[0], restart[1])} tone="restart" />}
                      <span
                        style={{ fontFamily: 'monospace', fontSize: 10.5, color: 'var(--text-tertiary)' }}
                      >
                        {t.id}
                      </span>
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    <ControlPreview t={t} px={px} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Default export mirrors other modules; renders the full (all-category) browser.
export function TweaksBrowserModule() {
  return <TweaksBrowser />;
}
