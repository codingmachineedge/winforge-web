import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/ReactorBankModule + ReactorEconomyService: the ⚡ Watts
// economy. Watts are minted from the reactor's live electrical output and spent
// in a store of one-time perks that unlock boosts across the reactor-powered
// modules. Standalone: an operator slider + generate toggle mints Watts; balance,
// ledger and unlocks persist to localStorage.

const MINT_PER_MW_SECOND = 0.01; // web scale: 1150 MWe ⇒ ~11.5 ⚡/s (visible)
const TICK_MS = 500;
const KEY = 'winforge-web.economy.v1';

interface Perk {
  id: string;
  cost: number;
}

const PERKS: Perk[] = [
  { id: 'goldreactor', cost: 500 },
  { id: 'mineturbo', cost: 1200 },
  { id: 'colliderpriority', cost: 1500 },
  { id: 'smelterpreheat', cost: 1800 },
  { id: 'aiclusteroverclock', cost: 2000 },
];

interface Ledger {
  when: number;
  reason: string;
  amount: number;
  balance: number;
}

interface EconState {
  balance: number;
  unlocks: string[];
  ledger: Ledger[];
}

function load(): EconState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw);
      return { balance: Number(p.balance) || 0, unlocks: Array.isArray(p.unlocks) ? p.unlocks : [], ledger: Array.isArray(p.ledger) ? p.ledger : [] };
    }
  } catch {
    /* ignore */
  }
  return { balance: 0, unlocks: [], ledger: [] };
}

export function ReactorBankModule() {
  const { t } = useTranslation();
  const [econ, setEcon] = useState<EconState>(load);
  const [availableMW, setAvailableMW] = useState(900);
  const [generating, setGenerating] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(econ));
    } catch {
      /* ignore */
    }
  }, [econ]);

  useEffect(() => {
    if (!generating) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      const minted = availableMW * MINT_PER_MW_SECOND * (TICK_MS / 1000);
      if (minted > 0) setEcon((e) => ({ ...e, balance: e.balance + minted }));
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [generating, availableMW]);

  const buy = (perk: Perk) => {
    setEcon((e) => {
      if (e.unlocks.includes(perk.id) || e.balance < perk.cost) return e;
      const balance = e.balance - perk.cost;
      const entry: Ledger = { when: e.ledger.length, reason: t(`reactorbank.perk_${perk.id}`), amount: -perk.cost, balance };
      return { balance, unlocks: [...e.unlocks, perk.id], ledger: [entry, ...e.ledger].slice(0, 30) };
    });
  };

  const mintRate = availableMW * MINT_PER_MW_SECOND;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${generating ? '' : ' primary'}`} onClick={() => setGenerating((g) => !g)}>
          {generating ? t('reactorbank.stopMint') : t('reactorbank.startMint')}
        </button>
        <StatusDot ok={generating} label={generating ? t('reactorbank.minting', { rate: mintRate.toFixed(1) }) : t('reactorbank.idle')} />
      </ModuleToolbar>
      <p className="count-note">{t('reactorbank.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 26, fontWeight: 700 }}>{econ.balance.toFixed(1)} ⚡</div>
        <div className="count-note" style={{ margin: 0 }}>{t('reactorbank.balance')}</div>
        <label style={{ flex: '1 1 240px' }}>
          {t('reactorbank.outputLabel', { mw: Math.round(availableMW) })}
          <input type="range" min={0} max={1150} value={availableMW} onChange={(e) => setAvailableMW(Number(e.target.value))} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('reactorbank.store')}</strong>
        <div className="count-note" style={{ margin: '2px 0 10px' }}>{t('reactorbank.storeHint')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PERKS.map((perk) => {
            const owned = econ.unlocks.includes(perk.id);
            const affordable = econ.balance >= perk.cost;
            return (
              <div key={perk.id} className="panel" style={{ margin: 0, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <strong>{t(`reactorbank.perk_${perk.id}`)}</strong>
                  <div className="count-note" style={{ margin: 0 }}>{t(`reactorbank.perkdesc_${perk.id}`)}</div>
                </div>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{perk.cost} ⚡</div>
                <button className={`mini${owned ? '' : ' primary'}`} disabled={owned || !affordable} onClick={() => buy(perk)}>
                  {owned ? t('reactorbank.owned') : t('reactorbank.buy')}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <strong>{t('reactorbank.ledger')}</strong>
        {econ.ledger.length === 0 ? (
          <p className="count-note" style={{ marginBottom: 0 }}>{t('reactorbank.ledgerEmpty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {econ.ledger.map((l, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{l.reason}</span>
                <span style={{ color: l.amount >= 0 ? 'var(--web)' : 'var(--danger)' }}>
                  {l.amount >= 0 ? '+' : '−'}{Math.abs(l.amount).toFixed(1)} ⚡ · {l.balance.toFixed(1)} ⚡
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
