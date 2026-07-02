import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function relative(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86400000 * 365, 'year'],
    [86400000 * 30, 'month'],
    [86400000, 'day'],
    [3600000, 'hour'],
    [60000, 'minute'],
    [1000, 'second'],
  ];
  for (const [u, name] of units) {
    if (abs >= u) {
      const n = Math.round(abs / u);
      return diff < 0 ? t('epoch.ago', { n, unit: t(`epoch.u_${name}`, { count: n }) }) : t('epoch.in', { n, unit: t(`epoch.u_${name}`, { count: n }) });
    }
  }
  return t('epoch.now');
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td style={{ width: 150, color: 'var(--text-tertiary)' }}>{label}</td>
      <td>
        <code>{value}</code>
      </td>
      <td style={{ width: 70, textAlign: 'right' }}>
        <button className="mini" onClick={onCopy}>
          {t('epoch.copy')}
        </button>
      </td>
    </tr>
  );
}

export function EpochModule() {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const [epochIn, setEpochIn] = useState(String(Math.floor(Date.now() / 1000)));
  const [unit, setUnit] = useState<'s' | 'ms'>('s');
  const [human, setHuman] = useState('');
  const [asUtc, setAsUtc] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const copy = (v: string) => void navigator.clipboard?.writeText(v);

  // Epoch → human
  const epochMs = (() => {
    const n = Number(epochIn.trim());
    if (!Number.isFinite(n)) return null;
    return unit === 's' ? n * 1000 : n;
  })();
  const eh = epochMs != null ? new Date(epochMs) : null;
  const validEh = eh && !Number.isNaN(eh.getTime());

  // Human → epoch (datetime-local string "YYYY-MM-DDTHH:mm")
  const humanMs = (() => {
    if (!human) return null;
    const d = asUtc ? new Date(human + 'Z') : new Date(human);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  })();

  return (
    <div className="mod">
      <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
        {t('epoch.rightNow')}
      </h3>
      <table className="dt ct-table">
        <tbody>
          <CopyRow label={t('epoch.unixSec')} value={String(Math.floor(now / 1000))} onCopy={() => copy(String(Math.floor(now / 1000)))} />
          <CopyRow label={t('epoch.unixMs')} value={String(now)} onCopy={() => copy(String(now))} />
          <tr>
            <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.local')}</td>
            <td colSpan={2}>
              <code>{new Date(now).toLocaleString()}</code>
            </td>
          </tr>
          <tr>
            <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.utc')}</td>
            <td colSpan={2}>
              <code>{new Date(now).toISOString()}</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('epoch.toHuman')}
      </h3>
      <div className="mod-form">
        <input className="mod-search" style={{ maxWidth: 220 }} value={epochIn} onChange={(e) => setEpochIn(e.target.value)} />
        <select className="mod-select" value={unit} onChange={(e) => setUnit(e.target.value as 's' | 'ms')}>
          <option value="s">{t('epoch.seconds')}</option>
          <option value="ms">{t('epoch.milliseconds')}</option>
        </select>
      </div>
      {validEh ? (
        <table className="dt ct-table">
          <tbody>
            <tr>
              <td style={{ width: 150, color: 'var(--text-tertiary)' }}>{t('epoch.local')}</td>
              <td colSpan={2}>
                <code>{eh!.toLocaleString()}</code>
              </td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.utc')}</td>
              <td colSpan={2}>
                <code>{eh!.toUTCString()}</code>
              </td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.iso')}</td>
              <td colSpan={2}>
                <code>{eh!.toISOString()}</code>
              </td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.dow')}</td>
              <td colSpan={2}>{DAYS_EN[eh!.getDay()]}</td>
            </tr>
            <tr>
              <td style={{ color: 'var(--text-tertiary)' }}>{t('epoch.relative')}</td>
              <td colSpan={2}>{relative(eh!.getTime(), t)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="count-note">{t('epoch.pickDate')}</p>
      )}

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('epoch.toEpoch')}
      </h3>
      <div className="mod-form">
        <input className="mod-search" type="datetime-local" step={1} style={{ maxWidth: 240 }} value={human} onChange={(e) => setHuman(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={asUtc} onChange={(e) => setAsUtc(e.target.checked)} />
          {t('epoch.asUtc')}
        </label>
      </div>
      {humanMs != null ? (
        <table className="dt ct-table">
          <tbody>
            <CopyRow label={t('epoch.unixSec')} value={String(Math.floor(humanMs / 1000))} onCopy={() => copy(String(Math.floor(humanMs / 1000)))} />
            <CopyRow label={t('epoch.unixMs')} value={String(humanMs)} onCopy={() => copy(String(humanMs))} />
          </tbody>
        </table>
      ) : (
        <p className="count-note">{t('epoch.pickDate')}</p>
      )}
    </div>
  );
}
