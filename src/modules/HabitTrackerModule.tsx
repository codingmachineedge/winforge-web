import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge HabitTrackerModule (page + HabitTrackerService). A list of named
// habits, each keeping the set of ISO "yyyy-MM-dd" dates it was completed. Each habit
// shows this week (Mon–Sun, today highlighted), the current streak (consecutive days
// done counting back from today) and the total days done. Add / rename / delete habits;
// toggling a day persists immediately. WinForge persisted to
// %LOCALAPPDATA%\WinForge\habits\habits.json — the web port keeps the same {name, done[]}
// data shape in localStorage (client-side only, sanitised, never throws).
//
// Web-port extras (all pure-client, computed from the same {name, done[]} data):
//  • week navigation (view any Mon–Sun week, not just the current one)
//  • best/longest streak + this-week completion count per habit
//  • a "Today" quick-toggle button per row
//  • an overall summary panel (habits, completions, done-today, best streak)
//  • export (download / copy) and import (paste / file) of the habits JSON

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

// Monday of the week containing the given date (Monday = 0 offset), matching RebuildWeek().
function mondayOf(d: Date): Date {
  const offset = (d.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0 …
  return addDays(dateOnly(d), -offset);
}

// The 7 Mon–Sun days of the week starting at the given Monday.
function weekFrom(monday: Date): Date[] {
  const week: Date[] = [];
  for (let i = 0; i < 7; i++) week.push(addDays(monday, i));
  return week;
}

// Load & sanitise from localStorage: drop nulls, coalesce names, de-dupe dates
// (mirrors HabitTrackerService.LoadAsync). Never throws.
function parseHabits(raw: unknown): Habit[] {
  if (!Array.isArray(raw)) return [];
  const out: Habit[] = [];
  let id = 0;
  for (const entry of raw) {
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
  return parseHabits(parsed);
}

// The on-disk snapshot shape (mirrors HabitTrackerService.Habit).
function toSnapshot(habits: Habit[]): StoredHabit[] {
  return habits.map((h) => ({
    name: h.name,
    done: Array.from(h.done)
      .filter((d) => d.trim())
      .sort(),
  }));
}

// Save (mirrors HabitTrackerService.SaveAsync). Returns true on success; never throws.
function saveHabits(habits: Habit[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSnapshot(habits), null, 2));
    return true;
  } catch {
    return false;
  }
}

// Current streak: consecutive days marked done counting back from today (UpdateDerived).
function computeStreak(done: Set<string>, today: Date): number {
  let streak = 0;
  let day = dateOnly(today);
  while (done.has(isoDate(day))) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

// Longest run of consecutive done-days anywhere in the habit's history.
function computeBestStreak(done: Set<string>): number {
  if (done.size === 0) return 0;
  const days = Array.from(done)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const iso of days) {
    const cur = new Date(`${iso}T00:00:00`);
    if (prev && Math.round((cur.getTime() - prev.getTime()) / 86400000) === 1) run++;
    else run = 1;
    if (run > best) best = run;
    prev = cur;
  }
  return best;
}

export function HabitTrackerModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  const today = useMemo(() => dateOnly(new Date()), []);
  const todayIso = isoDate(today);

  // Week the user is currently viewing (offset in weeks from the current week).
  const [weekOffset, setWeekOffset] = useState(0);
  const week = useMemo(
    () => weekFrom(addDays(mondayOf(today), weekOffset * 7)),
    [today, weekOffset],
  );

  const [habits, setHabits] = useState<Habit[]>(() => loadHabits());
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [nextId, setNextId] = useState<number>(() => loadHabits().length);

  // Import/export UI state.
  const [ioOpen, setIoOpen] = useState(false);
  const [ioText, setIoText] = useState('');
  const [ioMsg, setIoMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Persist whenever habits change; report save status (mirrors WinForge Save()).
  useEffect(() => {
    const ok = saveHabits(habits);
    setStatus(ok ? t('habittracker.saved') : t('habittracker.saveFailed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habits]);

  const dayLabels = useMemo(
    () => [
      t('habittracker.dayMon'),
      t('habittracker.dayTue'),
      t('habittracker.dayWed'),
      t('habittracker.dayThu'),
      t('habittracker.dayFri'),
      t('habittracker.daySat'),
      t('habittracker.daySun'),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  );

  const dateLoc = (i18n.language || '').toLowerCase().startsWith('zh') ? 'zh-HK' : undefined;

  const weekRange = useMemo(() => {
    const first = week[0];
    const last = week[6];
    if (!first || !last) return '';
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    return `${first.toLocaleDateString(dateLoc, opts)} – ${last.toLocaleDateString(dateLoc, opts)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, i18n.language]);

  // How many of this viewed week's 7 days a habit has completed.
  const weekCount = (done: Set<string>) => week.reduce((n, d) => n + (done.has(isoDate(d)) ? 1 : 0), 0);

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

  const toggleToday = (id: number) => {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        const next = new Set(h.done);
        if (next.has(todayIso)) next.delete(todayIso);
        else next.add(todayIso);
        return { ...h, done: next };
      }),
    );
  };

  // ---- overall summary (all pure-client) ----
  const summary = useMemo(() => {
    let completions = 0;
    let doneToday = 0;
    let bestStreak = 0;
    for (const h of habits) {
      completions += h.done.size;
      if (h.done.has(todayIso)) doneToday++;
      const b = computeBestStreak(h.done);
      if (b > bestStreak) bestStreak = b;
    }
    return { habits: habits.length, completions, doneToday, bestStreak };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habits, todayIso]);

  // ---- export / import (client-side JSON round-trip of the habits.json shape) ----
  const exportJson = () => JSON.stringify(toSnapshot(habits), null, 2);

  const copyExport = async () => {
    const text = exportJson();
    try {
      await navigator.clipboard.writeText(text);
      setIoMsg(pick('Copied to clipboard.', '已複製到剪貼簿。', lang));
    } catch {
      setIoText(text);
      setIoMsg(pick('Clipboard blocked — copy the text below.', '剪貼簿被封鎖 — 請複製下面嘅文字。', lang));
    }
  };

  const downloadExport = () => {
    try {
      const blob = new Blob([exportJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'habits.json';
      a.click();
      URL.revokeObjectURL(url);
      setIoMsg(pick('Downloaded habits.json.', '已下載 habits.json。', lang));
    } catch {
      setIoMsg(pick('Download failed.', '下載失敗。', lang));
    }
  };

  // Merge imported habits: same-name habits union their done-dates, new names are appended.
  const applyImport = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setIoMsg(pick('Not valid JSON.', '唔係有效嘅 JSON。', lang));
      return;
    }
    const incoming = parseHabits(parsed);
    if (incoming.length === 0) {
      setIoMsg(pick('No habits found in that JSON.', '嗰段 JSON 搵唔到習慣。', lang));
      return;
    }
    setHabits((prev) => {
      const byName = new Map<string, Habit>();
      for (const h of prev) byName.set(h.name, h);
      let id = nextId;
      const merged = prev.map((h) => ({ ...h, done: new Set(h.done) }));
      for (const inc of incoming) {
        const existing = byName.get(inc.name);
        if (existing) {
          const target = merged.find((m) => m.id === existing.id);
          if (target) for (const d of inc.done) target.done.add(d);
        } else {
          const created: Habit = { id: id++, name: inc.name, done: new Set(inc.done) };
          merged.push(created);
          byName.set(inc.name, created);
        }
      }
      setNextId(id);
      return merged;
    });
    setIoMsg(
      pick(
        `Imported ${incoming.length} habit${incoming.length === 1 ? '' : 's'}.`,
        `已匯入 ${incoming.length} 個習慣。`,
        lang,
      ),
    );
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyImport(String(reader.result ?? ''));
    reader.onerror = () => setIoMsg(pick('Could not read the file.', '無法讀取檔案。', lang));
    reader.readAsText(file);
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
        <button
          className="mini"
          onClick={() => {
            setIoOpen((o) => !o);
            setIoMsg('');
            setIoText('');
          }}
        >
          {pick('Export / Import', '匯出 / 匯入', lang)}
        </button>
      </div>

      {/* Overall summary — derived entirely from the habit data, client-side. */}
      {habits.length > 0 && (
        <div className="panel" style={{ marginTop: 12, marginBottom: 12 }}>
          <h3>{pick('Summary', '總覽', lang)}</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.habits}</div>
              <div className="count-note" style={{ margin: 0 }}>
                {pick('Habits', '習慣', lang)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.doneToday}</div>
              <div className="count-note" style={{ margin: 0 }}>
                {pick('Done today', '今日完成', lang)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.completions}</div>
              <div className="count-note" style={{ margin: 0 }}>
                {pick('Total completions', '總完成次數', lang)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.bestStreak}</div>
              <div className="count-note" style={{ margin: 0 }}>
                {pick('Best streak (days)', '最佳連續（日）', lang)}
              </div>
            </div>
          </div>
        </div>
      )}

      {ioOpen && (
        <div className="panel" style={{ marginTop: 12, marginBottom: 12 }}>
          <h3>{pick('Export / Import', '匯出 / 匯入', lang)}</h3>
          <p className="count-note" style={{ marginTop: 0 }}>
            {pick(
              'Back up your habits as JSON, or restore them on another device. Import merges by habit name (same-name habits combine their completed days).',
              '將習慣匯出做 JSON 備份，或喺另一部機還原。匯入會按習慣名合併（同名嘅習慣會合併已完成嘅日子）。',
              lang,
            )}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini" onClick={copyExport}>
              {pick('Copy JSON', '複製 JSON', lang)}
            </button>
            <button className="mini" onClick={downloadExport}>
              {pick('Download .json', '下載 .json', lang)}
            </button>
            <button className="mini" onClick={() => fileRef.current?.click()}>
              {pick('Import file…', '匯入檔案…', lang)}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={onPickFile}
            />
          </div>
          <textarea
            className="mod-search"
            style={{ width: '100%', minHeight: 96, marginTop: 8, fontFamily: 'var(--mono, Consolas, monospace)' }}
            placeholder={pick('…or paste habits JSON here, then press Import', '…或喺度貼上習慣 JSON，再撳匯入', lang)}
            value={ioText}
            onChange={(e) => setIoText(e.target.value)}
          />
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" onClick={() => applyImport(ioText)} disabled={!ioText.trim()}>
              {pick('Import from text', '由文字匯入', lang)}
            </button>
          </div>
          {ioMsg && (
            <p className="count-note" style={{ marginTop: 8 }}>
              {ioMsg}
            </p>
          )}
        </div>
      )}

      {/* Week navigation — view any Mon–Sun week, not just the current one. */}
      <div className="mod-toolbar" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => setWeekOffset((w) => w - 1)}>
          {pick('‹ Prev week', '‹ 上星期', lang)}
        </button>
        <button className="mini" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>
          {pick('This week', '今個星期', lang)}
        </button>
        <button className="mini" onClick={() => setWeekOffset((w) => w + 1)}>
          {pick('Next week ›', '下星期 ›', lang)}
        </button>
        <span className="count-note" style={{ margin: 0 }}>
          {weekOffset === 0
            ? t('habittracker.thisWeek', { range: weekRange })
            : pick(`Week of ${weekRange}`, `${weekRange} 嗰個星期`, lang)}
        </span>
      </div>

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
                      title={d.toLocaleDateString(dateLoc, { day: 'numeric', month: 'short' })}
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
                <th style={{ textAlign: 'center', minWidth: 60 }}>{pick('Week', '本週', lang)}</th>
                <th style={{ textAlign: 'left', minWidth: 90 }}>{t('habittracker.colStreak')}</th>
                <th style={{ textAlign: 'left', minWidth: 90 }}>{pick('Best', '最佳', lang)}</th>
                <th style={{ textAlign: 'left', minWidth: 90 }}>{t('habittracker.colTotal')}</th>
                <th style={{ textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {habits.map((h) => {
                const streak = computeStreak(h.done, today);
                const best = computeBestStreak(h.done);
                const total = h.done.size;
                const wk = weekCount(h.done);
                const doneToday = h.done.has(todayIso);
                return (
                  <tr key={h.id}>
                    <td>
                      {editingId === h.id ? (
                        <input
                          className="mod-search"
                          style={{ minWidth: 120 }}
                          autoFocus
                          value={editName}
                          placeholder={t('habittracker.namePlaceholder')}
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
                    <td style={{ textAlign: 'center' }}>{`${wk}/7`}</td>
                    <td>{t('habittracker.streakDays', { count: streak })}</td>
                    <td>{pick(`${best} day${best === 1 ? '' : 's'}`, `${best} 日`, lang)}</td>
                    <td>{t('habittracker.totalDays', { count: total })}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className={doneToday ? 'mini primary' : 'mini'}
                        onClick={() => toggleToday(h.id)}
                        title={pick('Toggle today', '切換今日', lang)}
                      >
                        {doneToday ? pick('✓ Today', '✓ 今日', lang) : pick('Today', '今日', lang)}
                      </button>
                      {editingId === h.id ? (
                        <button className="mini" style={{ marginLeft: 6 }} onClick={() => commitRename(h.id)}>
                          {t('habittracker.done')}
                        </button>
                      ) : (
                        <button className="mini" style={{ marginLeft: 6 }} onClick={() => startRename(h)}>
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
