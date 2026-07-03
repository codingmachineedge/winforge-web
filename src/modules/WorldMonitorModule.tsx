import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar } from './common';
import { pick } from '../i18n';

// Port of WinForge Pages/WorldMonitorModule + WorldMonitorService: embeds the
// hosted, open-source World Monitor dashboard (AGPL-3.0 by koala73) — a live
// global-intelligence view (world / tech / finance / commodity / energy). The
// desktop app hosts it in WebView2; here it renders in an iframe, with a variant
// switcher, reload, copy-URL and open-in-browser. WinForge embeds the hosted app
// and never forks or recompiles the source.

interface Variant {
  key: string;
  en: string;
  zh: string;
  url: string;
}

const VARIANTS: Variant[] = [
  { key: 'world', en: 'World', zh: '世界', url: 'https://worldmonitor.app' },
  { key: 'tech', en: 'Tech', zh: '科技', url: 'https://tech.worldmonitor.app' },
  { key: 'finance', en: 'Finance', zh: '金融', url: 'https://finance.worldmonitor.app' },
  { key: 'commodity', en: 'Commodity', zh: '商品', url: 'https://commodity.worldmonitor.app' },
  { key: 'energy', en: 'Energy', zh: '能源', url: 'https://energy.worldmonitor.app' },
  { key: 'happy', en: 'Happy', zh: '快樂', url: 'https://happy.worldmonitor.app' },
];

const KEY = 'winforge-web.worldmonitor.variant';

export function WorldMonitorModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const initial = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || 'world';
  const [activeKey, setActiveKey] = useState(VARIANTS.some((v) => v.key === initial) ? initial : 'world');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [copied, setCopied] = useState(false);

  const active = VARIANTS.find((v) => v.key === activeKey) ?? VARIANTS[0]!;

  const pickVariant = (key: string) => {
    setActiveKey(key);
    setCopied(false);
    try {
      localStorage.setItem(KEY, key);
    } catch {
      /* ignore */
    }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(active.url);
      setCopied(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mod">
      <ModuleToolbar>
        {VARIANTS.map((v) => (
          <button key={v.key} className={`mini${activeKey === v.key ? ' primary' : ''}`} onClick={() => pickVariant(v.key)}>
            {pick(v.en, v.zh, lang)}
          </button>
        ))}
      </ModuleToolbar>
      <div className="mod-toolbar">
        <button className="mini" onClick={() => setReloadNonce((n) => n + 1)}>{t('worldmonitor.reload')}</button>
        <button className="mini" onClick={copyUrl}>{copied ? t('worldmonitor.copied') : t('worldmonitor.copyUrl')}</button>
        <a className="mini" href={active.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          {t('worldmonitor.openBrowser')}
        </a>
        <span className="count-note" style={{ margin: 0 }}>{active.url}</span>
      </div>
      <p className="count-note">{t('worldmonitor.blurb')}</p>

      <iframe
        key={`${activeKey}-${reloadNonce}`}
        title={`World Monitor — ${active.en}`}
        src={active.url}
        style={{ width: '100%', height: 620, border: '1px solid var(--stroke)', borderRadius: 'var(--radius)', background: 'var(--bg-elevated)' }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
      <p className="count-note">{t('worldmonitor.license')}</p>
    </div>
  );
}
