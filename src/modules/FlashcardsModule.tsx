import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

// Full port of WinForge Pages/FlashcardsModule + Services/FlashcardService:
// native Anki-style spaced-repetition flashcards. Deck CRUD with per-deck
// new/due/total/mature counts, card CRUD + search + tags, an SM-2-scheduled
// study session (front -> reveal -> grade Again/Hard/Good/Easy), a session
// "Again" requeue, cram mode, stats (studied-today from a per-day review log,
// due-tomorrow, mature, total, per-deck maturity), day streak, and CSV/JSON
// import/export. Pure client: persisted to localStorage, no backend, so it
// behaves identically in the browser and the desktop shell.

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
  ease: number; // SM-2 EF, starts 2.5, floored at 1.3
  intervalDays: number;
  reps: number; // consecutive successful repetitions
  due: number; // epoch ms; 0 = brand-new (never scheduled)
  lastReviewed: number; // epoch ms; 0 = never
  created: number;
}

type Grade = 'again' | 'hard' | 'good' | 'easy';
// Map the four buttons onto SM-2 quality exactly as the C# service does.
const Q: Record<Grade, number> = { again: 1, hard: 3, good: 4, easy: 5 };

const KEY = 'winforge-web.flashcards.v1';
const DAY = 86400000;
const now = () => Date.now();
const rid = (seed: number) => `${seed.toString(36)}${((seed * 2654435761) % 0xffffffff).toString(36)}`;
const todayKey = (ms = now()) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

interface Store {
  decks: Deck[];
  cards: Card[];
  reviewLog: Record<string, number>; // local yyyy-MM-dd -> reviews that day
  seq: number;
}

function load(): Store {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(p.decks) && Array.isArray(p.cards)) {
        return { seq: 1, reviewLog: {}, ...p } as Store;
      }
    }
  } catch {
    /* ignore */
  }
  return { decks: [], cards: [], reviewLog: {}, seq: 1 };
}

function persist(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const isNew = (c: Card) => c.reps === 0 && c.lastReviewed === 0;
const isDue = (c: Card, t: number) => isNew(c) || c.due <= t;
const isMature = (c: Card) => c.intervalDays >= 21;

// Faithful SM-2 transition — mirrors FlashcardService.Grade exactly.
function schedule(card: Card, g: Grade): Card {
  const q = Q[g];
  let { ease, intervalDays, reps } = card;
  let due: number;
  if (q < 3) {
    // Failed recall: reset repetitions, relearn in ~10 min.
    reps = 0;
    intervalDays = 0;
    due = now() + 10 * 60 * 1000;
  } else {
    reps += 1;
    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 6;
    else intervalDays = Math.round(intervalDays * ease);
    if (g === 'easy') intervalDays = Math.max(intervalDays + 1, Math.round(intervalDays * 1.3));
    if (intervalDays < 1) intervalDays = 1;
    due = now() + intervalDays * DAY;
  }
  ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < 1.3) ease = 1.3;
  return { ...card, ease, intervalDays, reps, due, lastReviewed: now() };
}

// Consecutive-day streak ending today (or yesterday), from the review log.
function computeStreak(log: Record<string, number>): number {
  let streak = 0;
  const start = new Date();
  // Allow the streak to count from yesterday if today has no reviews yet.
  if (!log[todayKey()]) start.setDate(start.getDate() - 1);
  for (;;) {
    const k = todayKey(start.getTime());
    if (log[k] && log[k]! > 0) {
      streak += 1;
      start.setDate(start.getDate() - 1);
    } else break;
  }
  return streak;
}

// ── CSV (RFC-4180, matches FlashcardService) ────────────────────────────────
function csvEscape(s: string): string {
  s = s ?? '';
  if (/["\n\r,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      /* skip */
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function download(name: string, data: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function FlashcardsModule() {
  const { t } = useTranslation();
  const [store, setStore] = useState<Store>(load);
  const [activeDeck, setActiveDeck] = useState<string | null>(store.decks[0]?.id ?? null);

  const update = (mut: (s: Store) => void) =>
    setStore((s) => {
      const next: Store = { ...s, decks: [...s.decks], cards: [...s.cards], reviewLog: { ...s.reviewLog } };
      mut(next);
      persist(next);
      return next;
    });

  // ── Deck operations ───────────────────────────────────────────────────────
  const createDeck = (name: string): string | null => {
    const n = name.trim();
    if (!n) return null;
    let id = '';
    update((s) => {
      id = rid(s.seq);
      s.decks.push({ id, name: n, created: now() });
      s.seq += 1;
    });
    return id;
  };
  const renameDeck = (id: string, name: string) => {
    const n = name.trim();
    if (!n) return;
    update((s) => {
      const d = s.decks.find((x) => x.id === id);
      if (d) d.name = n;
    });
  };
  const deleteDeck = (id: string) =>
    update((s) => {
      s.decks = s.decks.filter((d) => d.id !== id);
      s.cards = s.cards.filter((c) => c.deckId !== id);
      if (activeDeck === id) setActiveDeck(s.decks[0]?.id ?? null);
    });

  // ── Card operations ───────────────────────────────────────────────────────
  const addCard = (deckId: string, front: string, back: string, tags: string) => {
    if (!front.trim() && !back.trim()) return;
    update((s) => {
      const id = rid(s.seq);
      s.cards.push({
        id,
        deckId,
        front: front.trim(),
        back: back.trim(),
        tags: tags.trim(),
        ease: 2.5,
        intervalDays: 0,
        reps: 0,
        due: 0,
        lastReviewed: 0,
        created: now(),
      });
      s.seq += 1;
    });
  };
  const updateCard = (id: string, front: string, back: string, tags: string) =>
    update((s) => {
      const c = s.cards.find((x) => x.id === id);
      if (c) {
        c.front = front.trim();
        c.back = back.trim();
        c.tags = tags.trim();
      }
    });
  const deleteCard = (id: string) => update((s) => (s.cards = s.cards.filter((c) => c.id !== id)));

  const gradeCard = (id: string, g: Grade) =>
    update((s) => {
      const idx = s.cards.findIndex((c) => c.id === id);
      if (idx < 0) return;
      s.cards[idx] = schedule(s.cards[idx]!, g);
      const k = todayKey();
      s.reviewLog[k] = (s.reviewLog[k] ?? 0) + 1;
    });

  // ── Derived stats ─────────────────────────────────────────────────────────
  const deckStatsFor = (id: string) => {
    const t0 = now();
    const cards = store.cards.filter((c) => c.deckId === id);
    return {
      total: cards.length,
      fresh: cards.filter(isNew).length,
      due: cards.filter((c) => isDue(c, t0)).length,
      mature: cards.filter(isMature).length,
    };
  };
  const overall = useMemo(() => {
    const t0 = now();
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 2); // end of tomorrow (local)
    const tomorrowEnd = end.getTime();
    return {
      studiedToday: store.reviewLog[todayKey()] ?? 0,
      dueTomorrow: store.cards.filter((c) => !isNew(c) && c.due > t0 && c.due < tomorrowEnd).length,
      mature: store.cards.filter(isMature).length,
      total: store.cards.length,
      streak: computeStreak(store.reviewLog),
    };
  }, [store.cards, store.reviewLog]);

  const decksSorted = useMemo(
    () => [...store.decks].sort((a, b) => a.name.localeCompare(b.name)),
    [store.decks],
  );

  // ═════════════════════════════════ Decks tab ═════════════════════════════════
  const DecksTab = () => {
    const [newDeck, setNewDeck] = useState('');
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameVal, setRenameVal] = useState('');
    const [confirmDel, setConfirmDel] = useState<string | null>(null);
    const importRef = useRef<HTMLInputElement>(null);
    const [importName, setImportName] = useState('');
    const [pendingCsv, setPendingCsv] = useState<string | null>(null);

    const doAdd = () => {
      const id = createDeck(newDeck);
      if (id) {
        setActiveDeck(id);
        setNewDeck('');
      }
    };
    const doImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      f.text().then((txt) => {
        setPendingCsv(txt);
        setImportName(f.name.replace(/\.(csv|json)$/i, ''));
      });
    };
    const commitImport = () => {
      if (pendingCsv == null) return;
      const name = importName.trim() || t('flashcards.importedDeck');
      const id = createDeck(name);
      if (!id) return;
      let rows: string[][];
      try {
        const trimmed = pendingCsv.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          // JSON array of {front,back,tags}
          const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
          rows = (Array.isArray(arr) ? arr : []).map((o) => [
            String(o.front ?? o.Front ?? ''),
            String(o.back ?? o.Back ?? ''),
            String(o.tags ?? o.Tags ?? ''),
          ]);
        } else {
          rows = parseCsv(pendingCsv);
        }
      } catch {
        rows = parseCsv(pendingCsv);
      }
      let added = 0;
      update((s) => {
        rows.forEach((r, i) => {
          if (
            i === 0 &&
            r.length >= 2 &&
            (r[0] ?? '').trim().toLowerCase() === 'front' &&
            (r[1] ?? '').trim().toLowerCase() === 'back'
          )
            return;
          const front = (r[0] ?? '').trim();
          const back = (r[1] ?? '').trim();
          const tags = (r[2] ?? '').trim();
          if (!front && !back) return;
          s.cards.push({
            id: rid(s.seq),
            deckId: id,
            front,
            back,
            tags,
            ease: 2.5,
            intervalDays: 0,
            reps: 0,
            due: 0,
            lastReviewed: 0,
            created: now(),
          });
          s.seq += 1;
          added++;
        });
      });
      setActiveDeck(id);
      setPendingCsv(null);
      setImportName('');
      window.setTimeout(
        () => alert(t('flashcards.importDone', { count: added, name })),
        0,
      );
    };
    const exportDeck = (id: string, fmt: 'csv' | 'json') => {
      const deck = store.decks.find((d) => d.id === id);
      const cards = store.cards.filter((c) => c.deckId === id);
      const base = (deck?.name || 'deck').replace(/[^\w.-]+/g, '_');
      if (fmt === 'csv') {
        const lines = ['Front,Back,Tags'];
        for (const c of cards) lines.push(`${csvEscape(c.front)},${csvEscape(c.back)},${csvEscape(c.tags)}`);
        download(`${base}.csv`, '﻿' + lines.join('\r\n') + '\r\n', 'text/csv');
      } else {
        const json = JSON.stringify(
          cards.map((c) => ({ front: c.front, back: c.back, tags: c.tags })),
          null,
          2,
        );
        download(`${base}.json`, json, 'application/json');
      }
    };

    return (
      <div>
        <p className="count-note">{t('flashcards.decksBlurb')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            placeholder={t('flashcards.newDeckPh')}
            value={newDeck}
            onChange={(e) => setNewDeck(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doAdd()}
            style={{ width: 200 }}
          />
          <button className="mini primary" onClick={doAdd} disabled={!newDeck.trim()}>
            {t('flashcards.addDeck')}
          </button>
          <button className="mini" onClick={() => importRef.current?.click()}>
            {t('flashcards.import')}
          </button>
          <input ref={importRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={doImportFile} />
        </div>

        {pendingCsv != null && (
          <div className="hosts-edit" style={{ marginBottom: 12 }}>
            <label className="count-note" style={{ display: 'block', marginBottom: 6 }}>
              {t('flashcards.importAsName')}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="mod-search"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                style={{ flex: '1 1 200px' }}
              />
              <button className="mini primary" onClick={commitImport}>
                {t('flashcards.import')}
              </button>
              <button className="mini" onClick={() => setPendingCsv(null)}>
                {t('flashcards.cancel')}
              </button>
            </div>
          </div>
        )}

        {decksSorted.length === 0 ? (
          <p className="count-note">{t('flashcards.decksEmpty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {decksSorted.map((d) => {
              const s = deckStatsFor(d.id);
              return (
                <div key={d.id} className="panel" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  {renaming === d.id ? (
                    <>
                      <input
                        className="mod-search"
                        value={renameVal}
                        autoFocus
                        onChange={(e) => setRenameVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameDeck(d.id, renameVal);
                            setRenaming(null);
                          } else if (e.key === 'Escape') setRenaming(null);
                        }}
                        style={{ flex: '1 1 180px' }}
                      />
                      <button
                        className="mini primary"
                        onClick={() => {
                          renameDeck(d.id, renameVal);
                          setRenaming(null);
                        }}
                      >
                        {t('flashcards.save')}
                      </button>
                      <button className="mini" onClick={() => setRenaming(null)}>
                        {t('flashcards.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <strong>{d.name}</strong>
                        <div className="count-note" style={{ margin: 0 }}>
                          {t('flashcards.deckCounts', { fresh: s.fresh, due: s.due, total: s.total })}
                        </div>
                      </div>
                      <span className="status-dot on" title={t('flashcards.duePill', { due: s.due })}>
                        <span className="dot" />
                        {t('flashcards.duePill', { due: s.due })}
                      </span>
                      <button
                        className="mini"
                        onClick={() => {
                          setRenameVal(d.name);
                          setRenaming(d.id);
                        }}
                      >
                        {t('flashcards.rename')}
                      </button>
                      <button className="mini" onClick={() => exportDeck(d.id, 'csv')}>
                        {t('flashcards.exportCsv')}
                      </button>
                      <button className="mini" onClick={() => exportDeck(d.id, 'json')}>
                        {t('flashcards.exportJson')}
                      </button>
                      {confirmDel === d.id ? (
                        <>
                          <button
                            className="mini primary"
                            onClick={() => {
                              deleteDeck(d.id);
                              setConfirmDel(null);
                            }}
                          >
                            {t('flashcards.confirmDelete')}
                          </button>
                          <button className="mini" onClick={() => setConfirmDel(null)}>
                            {t('flashcards.cancel')}
                          </button>
                        </>
                      ) : (
                        <button className="mini" onClick={() => setConfirmDel(d.id)}>
                          {t('flashcards.removeDeck')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ═════════════════════════════════ Cards tab ═════════════════════════════════
  const CardsTab = () => {
    const [front, setFront] = useState('');
    const [back, setBack] = useState('');
    const [tags, setTags] = useState('');
    const [search, setSearch] = useState('');
    const [editId, setEditId] = useState<string | null>(null);
    const [editFront, setEditFront] = useState('');
    const [editBack, setEditBack] = useState('');
    const [editTags, setEditTags] = useState('');
    const [confirmDel, setConfirmDel] = useState<string | null>(null);

    const cards = useMemo(() => {
      if (!activeDeck) return [];
      const s = search.trim().toLowerCase();
      return store.cards
        .filter((c) => c.deckId === activeDeck)
        .filter(
          (c) =>
            !s ||
            c.front.toLowerCase().includes(s) ||
            c.back.toLowerCase().includes(s) ||
            c.tags.toLowerCase().includes(s),
        )
        .sort((a, b) => b.created - a.created);
    }, [activeDeck, search]);

    const doAdd = () => {
      if (!activeDeck) return;
      addCard(activeDeck, front, back, tags);
      setFront('');
      setBack('');
      setTags('');
    };
    const startEdit = (c: Card) => {
      setEditId(c.id);
      setEditFront(c.front);
      setEditBack(c.back);
      setEditTags(c.tags);
    };
    const saveEdit = () => {
      if (editId) updateCard(editId, editFront, editBack, editTags);
      setEditId(null);
    };
    const schedLine = (c: Card) =>
      isNew(c) ? t('flashcards.badgeNew') : t('flashcards.dueOn', { date: todayKey(c.due) });

    return (
      <div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('flashcards.deck')}
          </label>
          <select
            className="mod-search"
            value={activeDeck ?? ''}
            onChange={(e) => setActiveDeck(e.target.value || null)}
            style={{ minWidth: 180 }}
          >
            {decksSorted.length === 0 && <option value="">{t('flashcards.noDeckOpt')}</option>}
            {decksSorted.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <input
            className="mod-search"
            placeholder={t('flashcards.searchPh')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: '1 1 200px' }}
          />
        </div>

        {!activeDeck ? (
          <p className="count-note">{t('flashcards.noDeck')}</p>
        ) : (
          <>
            <div className="hosts-edit" style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="mod-search"
                placeholder={t('flashcards.frontPh')}
                value={front}
                onChange={(e) => setFront(e.target.value)}
                style={{ flex: '1 1 180px' }}
              />
              <input
                className="mod-search"
                placeholder={t('flashcards.backPh')}
                value={back}
                onChange={(e) => setBack(e.target.value)}
                style={{ flex: '1 1 180px' }}
              />
              <input
                className="mod-search"
                placeholder={t('flashcards.tagsPh')}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                style={{ flex: '1 1 120px' }}
              />
              <button className="mini primary" onClick={doAdd} disabled={!front.trim() && !back.trim()}>
                {t('flashcards.addCard')}
              </button>
            </div>

            <p className="count-note">
              {t('flashcards.cardCount', { count: cards.length })} · {t('flashcards.editHint')}
            </p>

            {cards.length === 0 ? (
              <p className="count-note">{t('flashcards.cardsEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.map((c) =>
                  editId === c.id ? (
                    <div key={c.id} className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input className="mod-search" value={editFront} onChange={(e) => setEditFront(e.target.value)} style={{ flex: '1 1 160px' }} />
                      <input className="mod-search" value={editBack} onChange={(e) => setEditBack(e.target.value)} style={{ flex: '1 1 160px' }} />
                      <input className="mod-search" value={editTags} onChange={(e) => setEditTags(e.target.value)} style={{ flex: '1 1 100px' }} placeholder={t('flashcards.tagsPh')} />
                      <button className="mini primary" onClick={saveEdit}>
                        {t('flashcards.save')}
                      </button>
                      <button className="mini" onClick={() => setEditId(null)}>
                        {t('flashcards.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div
                      key={c.id}
                      className="panel"
                      style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
                      onDoubleClick={() => startEdit(c)}
                    >
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <strong>{c.front}</strong>
                        <div className="count-note" style={{ margin: 0 }}>
                          {c.back}
                          {c.tags ? ` · ${c.tags}` : ''}
                        </div>
                      </div>
                      <span className="count-note" style={{ margin: 0 }}>
                        {schedLine(c)}
                      </span>
                      <button className="mini" onClick={() => startEdit(c)}>
                        {t('flashcards.edit')}
                      </button>
                      {confirmDel === c.id ? (
                        <>
                          <button
                            className="mini primary"
                            onClick={() => {
                              deleteCard(c.id);
                              setConfirmDel(null);
                            }}
                          >
                            {t('flashcards.confirmDelete')}
                          </button>
                          <button className="mini" onClick={() => setConfirmDel(null)}>
                            {t('flashcards.cancel')}
                          </button>
                        </>
                      ) : (
                        <button className="mini" onClick={() => setConfirmDel(c.id)}>
                          {t('flashcards.removeCard')}
                        </button>
                      )}
                    </div>
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ═════════════════════════════════ Study tab ═════════════════════════════════
  const StudyTab = () => {
    const [studyDeck, setStudyDeck] = useState<string | null>(activeDeck ?? decksSorted[0]?.id ?? null);
    const [queue, setQueue] = useState<string[]>([]); // card ids
    const [idx, setIdx] = useState(0);
    const [reviewed, setReviewed] = useState(0);
    const [shown, setShown] = useState(false);
    const [running, setRunning] = useState(false);
    const [cram, setCram] = useState(false);
    const [doneMsg, setDoneMsg] = useState<string | null>(null);

    const buildQueue = (deckId: string, cramMode: boolean): string[] => {
      const t0 = now();
      const pool = store.cards.filter((c) => c.deckId === deckId && (cramMode || isDue(c, t0)));
      const ordered = [...pool].sort((a, b) => {
        // review cards (not new) before new; then by due date
        const an = isNew(a) ? 1 : 0;
        const bn = isNew(b) ? 1 : 0;
        if (an !== bn) return an - bn;
        return a.due - b.due;
      });
      if (cramMode) {
        // shuffle for cram
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
        }
      }
      return ordered.map((c) => c.id);
    };

    const begin = (cramMode: boolean) => {
      if (!studyDeck) return;
      const q = buildQueue(studyDeck, cramMode);
      setCram(cramMode);
      setQueue(q);
      setIdx(0);
      setReviewed(0);
      setShown(false);
      setDoneMsg(null);
      if (q.length === 0) {
        setRunning(false);
        setDoneMsg(cramMode ? t('flashcards.cramEmpty') : t('flashcards.nothingDue'));
      } else {
        setRunning(true);
      }
    };

    const shuffleQueue = () =>
      setQueue((q) => {
        const rest = q.slice(idx);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j]!, rest[i]!];
        }
        setShown(false);
        return [...q.slice(0, idx), ...rest];
      });

    const grade = (g: Grade) => {
      const id = queue[idx];
      if (!id || !shown) return;
      gradeCard(id, g);
      setReviewed((r) => r + 1);
      let nextQueue = queue;
      // "Again" requeues the card later in this session so it gets re-seen.
      if (g === 'again') {
        nextQueue = [...queue, id];
        setQueue(nextQueue);
      }
      const nextIdx = idx + 1;
      setShown(false);
      if (nextIdx >= nextQueue.length) {
        setRunning(false);
        setDoneMsg(t('flashcards.sessionDone', { count: reviewed + 1 }));
      } else {
        setIdx(nextIdx);
      }
    };

    const card = running && queue[idx] ? store.cards.find((c) => c.id === queue[idx]) : undefined;
    const s = studyDeck ? deckStatsFor(studyDeck) : null;

    return (
      <div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note" style={{ margin: 0 }}>
            {t('flashcards.deck')}
          </label>
          <select
            className="mod-search"
            value={studyDeck ?? ''}
            onChange={(e) => {
              setStudyDeck(e.target.value || null);
              setRunning(false);
              setDoneMsg(null);
            }}
            style={{ minWidth: 180 }}
          >
            {decksSorted.length === 0 && <option value="">{t('flashcards.noDeckOpt')}</option>}
            {decksSorted.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button className="mini primary" onClick={() => begin(false)} disabled={!studyDeck}>
            {t('flashcards.startStudy')}
            {s && s.due > 0 ? ` (${s.due})` : ''}
          </button>
          <button className="mini" onClick={() => begin(true)} disabled={!studyDeck || (s?.total ?? 0) === 0}>
            {t('flashcards.cram')}
          </button>
          {running && (
            <button className="mini" onClick={shuffleQueue}>
              {t('flashcards.shuffle')}
            </button>
          )}
          {running && (
            <span className="count-note" style={{ margin: 0 }}>
              {t('flashcards.progress', { i: Math.min(idx + 1, queue.length), n: queue.length, reviewed })}
              {cram ? ` · ${t('flashcards.cramLabel')}` : ''}
            </span>
          )}
        </div>

        {!studyDeck ? (
          <p className="count-note">{t('flashcards.noDeck')}</p>
        ) : running && card ? (
          <div className="panel" style={{ textAlign: 'center', padding: 24 }}>
            <div className="count-note" style={{ marginTop: 0 }}>
              {t('flashcards.front')}
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, margin: '10px 0' }}>{card.front}</div>
            {shown ? (
              <>
                <div
                  style={{
                    fontSize: 19,
                    color: 'var(--accent)',
                    margin: '16px 0',
                    borderTop: '1px solid var(--stroke)',
                    paddingTop: 16,
                  }}
                >
                  <div className="count-note" style={{ marginTop: 0 }}>
                    {t('flashcards.back')}
                  </div>
                  {card.back}
                </div>
                {card.tags && (
                  <div className="count-note">{t('flashcards.tagsLabel', { tags: card.tags })}</div>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button className="mini" onClick={() => grade('again')}>
                    {t('flashcards.again')}
                  </button>
                  <button className="mini" onClick={() => grade('hard')}>
                    {t('flashcards.hard')}
                  </button>
                  <button className="mini primary" onClick={() => grade('good')}>
                    {t('flashcards.good')}
                  </button>
                  <button className="mini" onClick={() => grade('easy')}>
                    {t('flashcards.easy')}
                  </button>
                </div>
              </>
            ) : (
              <button className="mini primary" onClick={() => setShown(true)}>
                {t('flashcards.showAnswer')}
              </button>
            )}
          </div>
        ) : (
          <div className="panel" style={{ textAlign: 'center', padding: 24 }}>
            <p className="count-note" style={{ margin: 0 }}>
              {doneMsg ?? t('flashcards.studyIdle')}
            </p>
          </div>
        )}
      </div>
    );
  };

  // ═════════════════════════════════ Stats tab ═════════════════════════════════
  const StatsTab = () => {
    const cards = [
      { num: overall.studiedToday, label: t('flashcards.statStudied') },
      { num: overall.dueTomorrow, label: t('flashcards.statTomorrow') },
      { num: overall.mature, label: t('flashcards.statMature') },
      { num: overall.total, label: t('flashcards.statTotal') },
    ];
    return (
      <div>
        <p className="count-note">
          {t('flashcards.streak', { count: overall.streak })}
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          {cards.map((c) => (
            <div key={c.label} className="panel" style={{ flex: '1 1 120px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 600 }}>{c.num}</div>
              <div className="count-note" style={{ margin: 0 }}>
                {c.label}
              </div>
            </div>
          ))}
        </div>
        <p className="count-note" style={{ fontWeight: 600 }}>
          {t('flashcards.deckMaturity')}
        </p>
        {decksSorted.length === 0 ? (
          <p className="count-note">{t('flashcards.decksEmpty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {decksSorted.map((d) => {
              const s = deckStatsFor(d.id);
              const pct = s.total === 0 ? 0 : Math.round((100 * s.mature) / s.total);
              return (
                <div key={d.id} className="panel" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ flex: 1, minWidth: 120 }}>{d.name}</strong>
                  <span className="count-note" style={{ margin: 0 }}>
                    {t('flashcards.statCounts', { fresh: s.fresh, due: s.due, mature: s.mature, total: s.total })}
                  </span>
                  <span className="status-dot on">
                    <span className="dot" />
                    {t('flashcards.maturityPill', { pct })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mod">
      <p className="count-note">{t('flashcards.blurb')}</p>
      <ModuleTabs
        tabs={[
          { id: 'decks', en: 'Decks', zh: '牌組', render: () => <DecksTab /> },
          { id: 'cards', en: 'Cards', zh: '卡片', render: () => <CardsTab /> },
          { id: 'study', en: 'Study', zh: '學習', render: () => <StudyTab /> },
          { id: 'stats', en: 'Stats', zh: '統計', render: () => <StatsTab /> },
        ]}
      />
    </div>
  );
}
