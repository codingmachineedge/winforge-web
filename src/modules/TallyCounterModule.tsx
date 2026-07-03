import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge TallyCounterModule. Persists to localStorage (WinForge uses a JSON file).
interface Counter { name: string; value: number }
const STORAGE_KEY = 'winforge-web.tally';

function load(): Counter[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((c) => ({ name: String(c.name ?? ''), value: Number(c.value) || 0 }));
  } catch { /* ignore */ }
  return [];
}
function save(items: Counter[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* ignore */ }
}

export function TallyCounterModule() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Counter[]>(load);
  const [newName, setNewName] = useState('');
  const [step, setStep] = useState(1);

  useEffect(() => { save(items); }, [items]);

  const stepVal = Number.isNaN(step) || step < 1 ? 1 : Math.floor(step);
  const total = items.reduce((s, i) => s + i.value, 0);

  const adjust = (i: number, delta: number) => setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, value: it.value + delta } : it)));
  const resetOne = (i: number) => setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, value: 0 } : it)));
  const del = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));
  const rename = (i: number, name: string) => setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, name } : it)));
  const add = () => {
    const name = newName.trim() || t('tally.defaultName', { n: items.length + 1 });
    setItems((arr) => [...arr, { name, value: 0 }]);
    setNewName('');
  };
  const resetAll = () => setItems((arr) => arr.map((it) => ({ ...it, value: 0 })));

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 200 }} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('tally.newName')} />
        <button className="mini primary" onClick={add}>{t('tally.add')}</button>
        <label className="count-note">{t('tally.step')}</label>
        <input className="mod-search" type="number" min={1} style={{ maxWidth: 80 }} value={step} onChange={(e) => setStep(+e.target.value)} />
        <button className="mini" onClick={resetAll}>{t('tally.resetAll')}</button>
      </div>
      {items.length === 0 ? (
        <p className="count-note">{t('tally.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((it, i) => (
            <div key={i} className="panel" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
              <input className="hosts-edit" style={{ minHeight: 0, height: 32, maxWidth: 200, border: 'none', background: 'transparent', fontWeight: 600 }} value={it.name} onChange={(e) => rename(i, e.target.value)} />
              <div style={{ flex: 1, textAlign: 'center', fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{it.value}</div>
              <button className="mini" onClick={() => adjust(i, -stepVal)}>−{stepVal}</button>
              <button className="mini primary" onClick={() => adjust(i, stepVal)}>+{stepVal}</button>
              <button className="mini" onClick={() => resetOne(i)}>{t('tally.reset')}</button>
              <button className="mini" onClick={() => del(i)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="panel" style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="count-note">{t('tally.total')}</span>
        <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{total}</span>
      </div>
    </div>
  );
}
