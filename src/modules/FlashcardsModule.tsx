import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge Pages/FlashcardsModule + FlashcardService: spaced-repetition
// flashcards with the SM-2 scheduler. Fully self-contained (localStorage), so it
// works identically in the browser and the desktop app.

interface Deck {
  id: string;
  name: string;
  created: number;
}

interface Card {
  id: string;
  deckId: string;
  front: string;
  back: string;
  tags: string;
  ease: number; // SM-2 EF, starts 2.5, floored 1.3
  intervalDays: number;
  reps: number;
  due: number; // epoch ms; 0 = new
  lastReviewed: number;
  created: number;
}

type Grade = 'again' | 'hard' | 'good' | 'easy';
const Q: Record<Grade, number> = { again: 2, hard: 3, good: 4, easy: 5 };

const KEY = 'winforge-web.flashcards.v1';
const now = () => Date.now();
const rid = (seed: number) => `${seed.toString(36)}${(seed * 2654435761 % 0xffffffff).toString(36)}`;

interface Store {
  decks: Deck[];
  cards: Card[];
  seq: number;
}

function load(): Store {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.decks) && Array.isArray(p.cards)) return { seq: 1, ...p };
    }
  } catch {
    /* ignore */
  }
  return { decks: [], cards: [], seq: 1 };
}

function persist(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// Faithful SM-2 transition. Returns the updated scheduling fields.
function grade(card: Card, g: Grade): Card {
  const q = Q[g];
  let { ease, intervalDays, reps } = card;
  if (g === 'again') {
    reps = 0;
    intervalDays = 0;
  } else {
    reps += 1;
    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 6;
    else intervalDays = Math.round(intervalDays * ease);
    if (g === 'hard') intervalDays = Math.max(1, Math.round(intervalDays * 0.8));
    if (g === 'easy') intervalDays = Math.round(intervalDays * 1.3);
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const due = g === 'again' ? now() + 10 * 60 * 1000 : now() + intervalDays * 86400000;
  return { ...card, ease, intervalDays, reps, due, lastReviewed: now() };
}

const isDue = (c: Card, t: number) => (c.reps === 0 && c.lastReviewed === 0) || c.due <= t;
const isNew = (c: Card) => c.reps === 0 && c.lastReviewed === 0;

export function FlashcardsModule() {
  const { t } = useTranslation();
  const [store, setStore] = useState<Store>(load);
  const [activeDeck, setActiveDeck] = useState<string | null>(store.decks[0]?.id ?? null);
  const [mode, setMode] = useState<'manage' | 'study'>('manage');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [newDeck, setNewDeck] = useState('');
  const [studyIdx, setStudyIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const update = (mut: (s: Store) => Store) =>
    setStore((s) => {
      const next = mut({ ...s });
      persist(next);
      return next;
    });

  const deckCards = useMemo(
    () => store.cards.filter((c) => c.deckId === activeDeck),
    [store.cards, activeDeck],
  );
  const dueCards = useMemo(() => {
    const t = now();
    return deckCards.filter((c) => isDue(c, t));
  }, [deckCards]);

  const addDeck = () => {
    const name = newDeck.trim();
    if (!name) return;
    update((s) => {
      const id = rid(s.seq);
      s.decks = [...s.decks, { id, name, created: now() }];
      s.seq += 1;
      setActiveDeck(id);
      return s;
    });
    setNewDeck('');
  };

  const removeDeck = (id: string) =>
    update((s) => {
      s.decks = s.decks.filter((d) => d.id !== id);
      s.cards = s.cards.filter((c) => c.deckId !== id);
      if (activeDeck === id) setActiveDeck(s.decks[0]?.id ?? null);
      return s;
    });

  const addCard = () => {
    if (!activeDeck || !front.trim() || !back.trim()) return;
    update((s) => {
      const id = rid(s.seq);
      s.cards = [
        ...s.cards,
        { id, deckId: activeDeck, front: front.trim(), back: back.trim(), tags: '', ease: 2.5, intervalDays: 0, reps: 0, due: 0, lastReviewed: 0, created: now() },
      ];
      s.seq += 1;
      return s;
    });
    setFront('');
    setBack('');
  };

  const removeCard = (id: string) => update((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== id) }));

  const gradeCurrent = (g: Grade) => {
    const card = dueCards[studyIdx];
    if (!card) return;
    update((s) => ({ ...s, cards: s.cards.map((c) => (c.id === card.id ? grade(c, g) : c)) }));
    setFlipped(false);
    // Recompute due set on next render; keep index in range.
    setStudyIdx((i) => (i >= dueCards.length - 1 ? 0 : i));
  };

  const stats = useMemo(() => {
    const t = now();
    return {
      total: deckCards.length,
      due: deckCards.filter((c) => isDue(c, t)).length,
      fresh: deckCards.filter(isNew).length,
      mature: deckCards.filter((c) => c.intervalDays >= 21).length,
    };
  }, [deckCards]);

  const current = dueCards[Math.min(studyIdx, Math.max(0, dueCards.length - 1))];

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className={`mini${mode === 'manage' ? ' primary' : ''}`} onClick={() => setMode('manage')}>{t('flashcards.manage')}</button>
        <button
          className={`mini${mode === 'study' ? ' primary' : ''}`}
          onClick={() => {
            setMode('study');
            setStudyIdx(0);
            setFlipped(false);
          }}
          disabled={!activeDeck}
        >
          {t('flashcards.study')} {stats.due > 0 ? `(${stats.due})` : ''}
        </button>
      </div>
      <p className="count-note">{t('flashcards.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {store.decks.map((d) => (
          <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button className={`mini${activeDeck === d.id ? ' primary' : ''}`} onClick={() => setActiveDeck(d.id)}>{d.name}</button>
            <button className="mini" title={t('flashcards.removeDeck')} onClick={() => removeDeck(d.id)}>✕</button>
          </span>
        ))}
        <input className="mod-search" placeholder={t('flashcards.newDeckPh')} value={newDeck} onChange={(e) => setNewDeck(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDeck()} style={{ width: 160 }} />
        <button className="mini" onClick={addDeck}>{t('flashcards.addDeck')}</button>
      </div>

      {!activeDeck ? (
        <p className="count-note">{t('flashcards.noDeck')}</p>
      ) : mode === 'manage' ? (
        <>
          <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="mod-search" placeholder={t('flashcards.frontPh')} value={front} onChange={(e) => setFront(e.target.value)} style={{ flex: '1 1 200px' }} />
            <input className="mod-search" placeholder={t('flashcards.backPh')} value={back} onChange={(e) => setBack(e.target.value)} style={{ flex: '1 1 200px' }} />
            <button className="mini primary" onClick={addCard} disabled={!front.trim() || !back.trim()}>{t('flashcards.addCard')}</button>
          </div>
          <p className="count-note">{t('flashcards.stats', { total: stats.total, due: stats.due, fresh: stats.fresh, mature: stats.mature })}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {deckCards.map((c) => (
              <div key={c.id} className="panel" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <strong>{c.front}</strong>
                  <div className="count-note" style={{ margin: 0 }}>{c.back}</div>
                </div>
                <span className="count-note" style={{ margin: 0 }}>
                  {isNew(c) ? t('flashcards.badgeNew') : t('flashcards.badgeIn', { days: c.intervalDays })}
                </span>
                <button className="mini" onClick={() => removeCard(c.id)}>{t('flashcards.removeCard')}</button>
              </div>
            ))}
          </div>
        </>
      ) : dueCards.length === 0 ? (
        <div className="panel"><p className="count-note" style={{ margin: 0 }}>{t('flashcards.allDone')}</p></div>
      ) : (
        <div className="panel" style={{ textAlign: 'center', padding: 24 }}>
          <p className="count-note">{t('flashcards.remaining', { remaining: dueCards.length })}</p>
          <div style={{ fontSize: 22, fontWeight: 600, margin: '16px 0' }}>{current?.front}</div>
          {flipped ? (
            <>
              <div style={{ fontSize: 19, color: 'var(--accent)', margin: '16px 0', borderTop: '1px solid var(--stroke)', paddingTop: 16 }}>{current?.back}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="mini" onClick={() => gradeCurrent('again')}>{t('flashcards.again')}</button>
                <button className="mini" onClick={() => gradeCurrent('hard')}>{t('flashcards.hard')}</button>
                <button className="mini primary" onClick={() => gradeCurrent('good')}>{t('flashcards.good')}</button>
                <button className="mini" onClick={() => gradeCurrent('easy')}>{t('flashcards.easy')}</button>
              </div>
            </>
          ) : (
            <button className="mini primary" onClick={() => setFlipped(true)}>{t('flashcards.showAnswer')}</button>
          )}
        </div>
      )}
    </div>
  );
}
