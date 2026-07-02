import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const PRESETS: [number, number][] = [
  [16, 9],
  [4, 3],
  [21, 9],
  [16, 10],
  [3, 2],
  [5, 4],
  [1, 1],
  [9, 16],
];

export function AspectRatioModule() {
  const { t } = useTranslation();
  const [w, setW] = useState('1920');
  const [h, setH] = useState('1080');
  const [targetW, setTargetW] = useState('');
  const [targetH, setTargetH] = useState('');

  const info = useMemo(() => {
    const wv = parseInt(w, 10);
    const hv = parseInt(h, 10);
    if (!Number.isFinite(wv) || !Number.isFinite(hv) || wv <= 0 || hv <= 0) return null;
    const g = gcd(wv, hv);
    return { ratio: `${wv / g}:${hv / g}`, decimal: (wv / hv).toFixed(4), mp: ((wv * hv) / 1e6).toFixed(2), g };
  }, [w, h]);

  const ratioNum = info ? parseInt(w, 10) / parseInt(h, 10) : 0;
  const scaledH = targetW && info ? Math.round(parseInt(targetW, 10) / ratioNum) : null;
  const scaledW = targetH && info ? Math.round(parseInt(targetH, 10) * ratioNum) : null;

  const copy = () => info && void navigator.clipboard?.writeText(info.ratio);

  return (
    <div className="mod" style={{ display: 'grid', gap: 12 }}>
      <div className="panel" style={{ padding: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
          {t('aspect.simplify')}
        </h3>
        <div className="uc-row">
          <label className="lc-field">
            <span>{t('aspect.width')}</span>
            <input className="mod-search" type="number" value={w} onChange={(e) => setW(e.target.value)} />
          </label>
          <span className="uc-eq">×</span>
          <label className="lc-field">
            <span>{t('aspect.height')}</span>
            <input className="mod-search" type="number" value={h} onChange={(e) => setH(e.target.value)} />
          </label>
        </div>
        {info ? (
          <div className="gauges" style={{ marginTop: 12 }}>
            <div className="gauge">
              <div className="label">{t('aspect.ratio')}</div>
              <div className="value">{info.ratio}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('aspect.decimal')}</div>
              <div className="value">{info.decimal}</div>
            </div>
            <div className="gauge">
              <div className="label">{t('aspect.megapixels')}</div>
              <div className="value">{info.mp} MP</div>
            </div>
          </div>
        ) : (
          <p className="count-note">{t('aspect.enter')}</p>
        )}
        <div className="mod-toolbar" style={{ marginTop: 10 }}>
          <button className="mini" disabled={!info} onClick={copy}>
            {t('aspect.copy')}
          </button>
        </div>
      </div>

      <div className="panel" style={{ padding: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
          {t('aspect.presets')}
        </h3>
        <div className="mod-toolbar">
          {PRESETS.map(([pw, ph]) => (
            <button
              key={`${pw}:${ph}`}
              className="mini"
              onClick={() => {
                const base = ph >= pw ? 1080 : 1920;
                setW(String(Math.round((base * pw) / Math.max(pw, ph))));
                setH(String(Math.round((base * ph) / Math.max(pw, ph))));
              }}
            >
              {pw}:{ph}
            </button>
          ))}
        </div>
      </div>

      <div className="panel" style={{ padding: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
          {t('aspect.scale')}
        </h3>
        <div className="uc-row">
          <label className="lc-field">
            <span>{t('aspect.targetWidth')}</span>
            <input className="mod-search" type="number" value={targetW} onChange={(e) => setTargetW(e.target.value)} placeholder="—" />
          </label>
          <span className="uc-eq">→</span>
          <span className="count-note">{scaledH != null ? `${targetW} × ${scaledH}` : '—'}</span>
        </div>
        <div className="uc-row" style={{ marginTop: 8 }}>
          <label className="lc-field">
            <span>{t('aspect.targetHeight')}</span>
            <input className="mod-search" type="number" value={targetH} onChange={(e) => setTargetH(e.target.value)} placeholder="—" />
          </label>
          <span className="uc-eq">→</span>
          <span className="count-note">{scaledW != null ? `${scaledW} × ${targetH}` : '—'}</span>
        </div>
      </div>
    </div>
  );
}
