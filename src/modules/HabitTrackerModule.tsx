import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge HabitTracker (page + HabitTrackerService). A list of named habits,
// each keeping the set of ISO "yyyy-MM-dd" dates it was completed. Shows this week
// (Mon–Sun, today highlighted), current streak (consecutive days done up to today) and
// total days done. Add / rename / delete; toggling a day persists immediately.
// WinForge persisted to %LOCALAPPDATA%\WinForge\habits\habits.json — the web port keeps
// the same data shape in localStorage (client-side only, never throws).

const STORAGE_KEY = 'winforge.habits';

interface StoredHabit {
  name: string;
  done: string[];
}

interface Habit {
  id: number;
  name: string;
  done: Set<string>;
}

// ISO yyyy-MM-dd for a local date (matches C# DateTime.ToString("yyyy-MM-dd")).
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Current Mon–Sun week (Monday = 0 offset), matching RebuildWeek().
function currentWeek(today: Date): Date[] {
  const offset = (today.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0 …
  const monday = addDays(today, -offset);
  const week: Date[] = [];
  for (let i = 0; i < 7; i++) week.push(addDays(monday, i));
  return week;
}

// Load & sanitise from localStorage: drop nulls, coalesce names, de-dupe dates.
function loadHabits(): Habit[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Habit[] = [];
  let id = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<StoredHabit>;
    const name = typeof e.name === 'string' ? e.name : '';
    const done = new Set<string>();
    if (Array.isArray(e.done)) {
      for (const d of e.done) {
        if (typeof d === 'string' && d.trim()) done.add(d);
      }
    }
    out.push({ id: id++, name, done });
  }
  return out;
}

function saveHabits(habits: Habit[]): boolean {
  try {
    const snapshot: StoredHabit[] = habits.map((h) => ({
      name: h.name,
      done: Array.from(h.done).filter((d) => d.trim()),
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Current streak: consecutive days marked done counting back from today.
function computeStreak(done: Set<string>, today: Date): number {
  let streak = 0;
  let day = dateOnly(today);
  while (done.has(isoDate(day))) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

export function HabitTrackerModule() {
  const { t, i18n } = useTranslation();
  const P = (en: string, zh: string) => pick(en, zh, i18n.language);

  const today = useMemo(() => dateOnly(new Date()), []);
  const todayIso = isoDate(today);
  const week = useMemo(() => currentWeek(today), [today]);

  const [habits, setHabits] = useState<Habit[]>(() => loadHabits());
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [nextId, setNextId] = useState<number>(() => loadHabits().length);

  // Persist whenever habits change; report save status (mirrors WinForge Save()).
  useEffect(() => {
    const ok = saveHabits(habits);
    setStatus(ok ? t('habittracker.saved') : t('habittracker.saveFailed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habits]);

  const dayLabels = useMemo(
    () => [
      P('Mon', '一'),
      P('Tue', '二'),
      P('Wed', '三'),
      P('Thu', '四'),
      P('Fri', '五'),
      P('Sat', '六'),
      P('Sun', '日'),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  );

  const weekRange = useMemo(() => {
    const first = week[0];
    const last = week[6];
    if (!first || !last) return '';
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    const loc = (i18n.language || '').toLowerCase().startsWith('zh') ? 'zh-HK' : undefined;
    return `${first.toLocaleDateString(loc, opts)} – ${last.toLocaleDateString(loc, opts)}`;
  }, [week, i18n.language]);

  const addHabit = () => {
    const name = newName.trim() || t('habittracker.defaultName', { n: habits.length + 1 });
    setHabits((prev) => [...prev, { id: nextId, name, done: new Set<string>() }]);
    setNextId((n) => n + 1);
    setNewName('');
  };

  const deleteHabit = (id: number) => {
    setHabits((prev) => prev.filter((h) => h.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const startRename = (h: Habit) => {
    setEditingId(h.id);
    setEditName(h.name);
  };

  const commitRename = (id: number) => {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        const name = editName.trim() || h.name;
        return { ...h, name };
      }),
    );
    setEditingId(null);
  };

  const toggleDay = (id: number, dayIso: string, done: boolean) => {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        const next = new Set(h.done);
        if (done) next.add(dayIso);
        else next.delete(dayIso);
        return { ...h, done: next };
      }),
    );
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('habittracker.blurb')}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('habittracker.newPlaceholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addHabit();
          }}
        />
        <button className="mini primary" onClick={addHabit}>
          {t('habittracker.add')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 6 }}>
        {t('habittracker.thisWeek', { range: weekRange })}
      </p>

      {habits.length === 0 ? (
        <p className="count-note" style={{ marginTop: 12 }}>
          {t('habittracker.empty')}
        </p>
      ) : (
        <div className="dt-wrap" style={{ marginTop: 6 }}>
          <table className="dt">
            <thead>
              <tr>
                <th style={{ textAlign: 'left', minWidth: 140 }}>{t('habittracker.colHabit')}</th>
                {week.map((d, i) => {
                  const iso = isoDate(d);
                  const isToday = iso === todayIso;
                  return (
                    <th
                      key={iso}
                      style={{
                        textAlign: 'center',
                        color: isToday ? 'var(--accent, #4CAF50)' : undefined,
                        fontWeight: isToday ? 700 : undefined,
                      }}
                    >
                      {dayLabels[i]}
                    </th>
                  );
                })}
                <th style={{ textAlign: 'left', minWidth: 90 }}>{t('habittracker.colStreak')}</th>
                <th style={{ textAlign: 'left', minWidth: 90 }}>{t('habittracker.colTotal')}</th>
                <th style={{ textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {habits.map((h) => {
                const streak = computeStreak(h.done, today);
                const total = h.done.size;
                return (
                  <tr key={h.id}>
                    <td>
                      {editingId === h.id ? (
                        <input
                          className="mod-search"
                          style={{ minWidth: 120 }}
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(h.id);
                            else if (e.key === 'Escape') setEditingId(null);
                          }}
                          onBlur={() => commitRename(h.id)}
                        />
                      ) : (
                        <span style={{ fontWeight: 600 }}>{h.name}</span>
                      )}
                    </td>
                    {week.map((d) => {
                      const iso = isoDate(d);
                      const isToday = iso === todayIso;
                      const checked = h.done.has(iso);
                      return (
                        <td
                          key={iso}
                          style={{
                            textAlign: 'center',
                            background: isToday ? 'rgba(76,175,80,0.13)' : undefined,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={`${h.name} ${iso}`}
                            onChange={(e) => toggleDay(h.id, iso, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                    <td>{t('habittracker.streakDays', { count: streak })}</td>
                    <td>{t('habittracker.totalDays', { count: total })}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {editingId === h.id ? (
                        <button className="mini" onClick={() => commitRename(h.id)}>
                          {t('habittracker.done')}
                        </button>
                      ) : (
                        <button className="mini" onClick={() => startRename(h)}>
                          {t('habittracker.rename')}
                        </button>
                      )}
                      <button className="mini" style={{ marginLeft: 6 }} onClick={() => deleteHabit(h.id)}>
                        {t('habittracker.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {status && (
        <p className="count-note" style={{ marginTop: 10 }}>
          {status}
        </p>
      )}
    </div>
  );
}
