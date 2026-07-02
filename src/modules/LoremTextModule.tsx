import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const LATIN =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  );
const HIPSTER =
  'artisanal blockchain kubernetes microservice serverless container pipeline latency throughput idempotent async cache token payload schema webhook endpoint cluster sharding replica quorum consensus gossip vector clock eventual consistency backpressure circuit breaker retry idempotency observability telemetry span trace metric dashboard rollout canary blue green feature flag ephemeral immutable declarative reconcile drift'.split(
    ' ',
  );

const rint = (n: number) => Math.floor(Math.random() * n);
const pick = (a: string[]) => a[rint(a.length)]!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function LoremTextModule() {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<'paragraphs' | 'sentences' | 'words' | 'list'>('paragraphs');
  const [count, setCount] = useState(3);
  const [pool, setPool] = useState<'latin' | 'hipster'>('latin');
  const [minS, setMinS] = useState(3);
  const [maxS, setMaxS] = useState(6);
  const [classic, setClassic] = useState(true);
  const [html, setHtml] = useState(false);
  const [out, setOut] = useState('');

  const words = pool === 'latin' ? LATIN : HIPSTER;
  const sentence = () => {
    const len = 6 + rint(9);
    const w = Array.from({ length: len }, () => pick(words));
    return cap(w.join(' ')) + '.';
  };
  const paragraph = () => {
    const n = minS + rint(Math.max(1, maxS - minS + 1));
    return Array.from({ length: n }, sentence).join(' ');
  };

  const generate = () => {
    let result = '';
    const first = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit';
    if (unit === 'words') {
      result = Array.from({ length: count }, () => pick(words)).join(' ');
      if (classic) result = first.toLowerCase().split(' ').slice(0, count).join(' ');
    } else if (unit === 'sentences') {
      const arr = Array.from({ length: count }, sentence);
      if (classic && arr.length) arr[0] = first + '.';
      result = arr.join(' ');
    } else if (unit === 'list') {
      const items = Array.from({ length: count }, () => {
        const w = Array.from({ length: 3 + rint(4) }, () => pick(words));
        return cap(w.join(' '));
      });
      result = html ? items.map((x) => `<li>${x}</li>`).join('\n') : items.map((x) => `• ${x}`).join('\n');
    } else {
      const paras = Array.from({ length: count }, paragraph);
      if (classic && paras.length) paras[0] = first + '. ' + paras[0];
      result = html ? paras.map((p) => `<p>${p}</p>`).join('\n\n') : paras.join('\n\n');
    }
    setOut(result);
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <select className="mod-select" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
          <option value="paragraphs">{t('lorem.paragraphs')}</option>
          <option value="sentences">{t('lorem.sentences')}</option>
          <option value="words">{t('lorem.words')}</option>
          <option value="list">{t('lorem.list')}</option>
        </select>
        <input className="mod-search" type="number" min={1} max={100} style={{ maxWidth: 90 }} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, +e.target.value || 1)))} />
        <select className="mod-select" value={pool} onChange={(e) => setPool(e.target.value as 'latin' | 'hipster')}>
          <option value="latin">{t('lorem.latin')}</option>
          <option value="hipster">{t('lorem.hipster')}</option>
        </select>
        <button className="mini primary" onClick={generate}>
          {t('lorem.generate')}
        </button>
        <button className="mini" disabled={!out} onClick={() => out && navigator.clipboard?.writeText(out)}>
          {t('lorem.copy')}
        </button>
      </div>
      {unit === 'paragraphs' && (
        <div className="mod-toolbar">
          <span className="count-note">{t('lorem.perPara')}</span>
          <input className="mod-search" type="number" min={1} max={12} style={{ maxWidth: 70 }} value={minS} onChange={(e) => setMinS(Math.max(1, +e.target.value || 1))} />
          <span className="count-note">–</span>
          <input className="mod-search" type="number" min={1} max={12} style={{ maxWidth: 70 }} value={maxS} onChange={(e) => setMaxS(Math.max(1, +e.target.value || 1))} />
        </div>
      )}
      <div className="mod-toolbar">
        <label className="chk">
          <input type="checkbox" checked={classic} onChange={(e) => setClassic(e.target.checked)} />
          {t('lorem.classic')}
        </label>
        {(unit === 'paragraphs' || unit === 'list') && (
          <label className="chk">
            <input type="checkbox" checked={html} onChange={(e) => setHtml(e.target.checked)} />
            {t('lorem.html')}
          </label>
        )}
      </div>
      <textarea className="hosts-edit" spellCheck={false} readOnly value={out} placeholder={t('lorem.placeholder')} style={{ minHeight: 300 }} />
    </div>
  );
}
