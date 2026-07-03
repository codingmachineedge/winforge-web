import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

// Port of WinForge CountdownEventModule + CountdownEventService.
// Named events (name + target datetime) with a live "D days, HH:MM:SS left" tick,
// sorted soonest-first, persisted to localStorage (browser analogue of
// %LOCALAPPDATA%\WinForge\countdowns\events.json). Past events read "passed N ago".

const STORAGE_KEY = 'winforge.countdowns.events';

interface EventEntry {
  name: string;
  // ISO-8601 round-trip string (culture-independent, matches C# DateTimeOffset "o").
  target: string;
}

function loadEvents(): EventEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || !raw.trim()) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: EventEntry[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : '';
        const target = typeof o.target === 'string' ? o.target : '';
        if (target && !isNaN(new Date(target).getTime())) out.push({ name, target });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function saveEvents(events: EventEntry[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    return true;
  } catch {
    return false;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// Faithful port of CountdownItem.DescribeSpan: coarsest non-zero unit, pluralised.
function describeSpan(ms: number, zh: boolean): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  if (days >= 1) return zh ? `${days} 日` : days === 1 ? '1 day' : `${days} days`;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours >= 1) return zh ? `${hours} 個鐘` : hours === 1 ? '1 hour' : `${hours} hours`;
  const mins = Math.floor(totalSeconds / 60);
  if (mins >= 1) return zh ? `${mins} 分鐘` : mins === 1 ? '1 minute' : `${mins} minutes`;
  const secs = totalSeconds;
  return zh ? `${secs} 秒` : secs === 1 ? '1 second' : `${secs} seconds`;
}

// English and 粵語 halves of CountdownItem.Refresh, returned as a pair so the
// caller can render either or both (bilingual mode).
function countdownParts(targetMs: number, nowMs: number): { en: string; zh: string } {
  const diff = targetMs - nowMs;
  if (diff >= 0) {
    const totalSeconds = Math.floor(diff / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    return { en: `${days} days, ${clock} left`, zh: `仲有 ${days} 日，${clock}` };
  }
  return {
    en: `passed ${describeSpan(nowMs - targetMs, false)} ago`,
    zh: `已經過咗 ${describeSpan(nowMs - targetMs, true)}`,
  };
}

// yyyy-MM-dd HH:mm in local time (matches C# Target.LocalDateTime.ToString).
function targetText(targetMs: number): string {
  const d = new Date(targetMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Insert keeping list sorted by target ascending (InsertSorted: <= keeps stable order).
function insertSorted(list: EventEntry[], entry: EventEntry): EventEntry[] {
  const entryMs = new Date(entry.target).getTime();
  let i = 0;
  while (i < list.length && new Date(list[i]!.target).getTime() <= entryMs) i++;
  const out = list.slice();
  out.splice(i, 0, entry);
  return out;
}

const todayDate = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export function CountdownEventModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const [events, setEvents] = useState<EventEntry[]>(() => {
    const loaded = loadEvents();
    return loaded
      .slice()
      .sort((a, b) => new Date(a.target).getTime() - new Date(b.target).getTime());
  });
  const [name, setName] = useState('');
  const [date, setDate] = useState(todayDate());
  const [time, setTime] = useState('00:00');
  const [status, setStatus] = useState('');

  // Live 1-second tick driving the countdown text.
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    timerRef.current = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  const rows = useMemo(
    () =>
      events.map((ev) => {
        const ms = new Date(ev.target).getTime();
        const parts = countdownParts(ms, now);
        return {
          name: ev.name,
          target: ev.target,
          targetLabel: targetText(ms),
          text: pick(parts.en, parts.zh, lang),
        };
      }),
    [events, now, lang]
  );

  const addEvent = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus(t('countdownevent.needName'));
      return;
    }
    if (!date) {
      setStatus(t('countdownevent.needDate'));
      return;
    }
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!dm) {
      setStatus(t('countdownevent.needDate'));
      return;
    }
    const tm = /^(\d{2}):(\d{2})$/.exec(time || '00:00');
    const hh = tm ? +tm[1]! : 0;
    const mm = tm ? +tm[2]! : 0;
    const local = new Date(+dm[1]!, +dm[2]! - 1, +dm[3]!, hh, mm, 0, 0);
    if (isNaN(local.getTime())) {
      setStatus(t('countdownevent.needDate'));
      return;
    }
    const entry: EventEntry = { name: trimmed, target: local.toISOString() };
    const next = insertSorted(events, entry);
    setEvents(next);
    setName('');
    setTime('00:00');
    setStatus(saveEvents(next) ? t('countdownevent.added') : t('countdownevent.addedNoSave'));
  };

  const removeEvent = (target: string, evName: string) => {
    let removed = false;
    const next = events.filter((ev) => {
      if (!removed && ev.target === target && ev.name === evName) {
        removed = true;
        return false;
      }
      return true;
    });
    setEvents(next);
    setStatus(saveEvents(next) ? t('countdownevent.removed') : t('countdownevent.removedNoSave'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('countdownevent.blurb')}
      </p>

      <section style={{ marginTop: 4 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>{t('countdownevent.addTitle')}</h3>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 200 }}
            placeholder={t('countdownevent.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addEvent();
            }}
          />
          <input
            className="mod-search"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <input
            className="mod-search"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <button className="mini primary" onClick={addEvent}>
            {t('countdownevent.add')}
          </button>
        </div>
        {status && (
          <p className="count-note" style={{ marginTop: 8 }}>
            {status}
          </p>
        )}
      </section>

      <section style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>{t('countdownevent.listTitle')}</h3>
        {rows.length === 0 ? (
          <p className="count-note" style={{ marginTop: 8 }}>
            {t('countdownevent.empty')}
          </p>
        ) : (
          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => (
              <div
                key={`${r.target}|${r.name}`}
                className="kv-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{r.name}</span>
                  <span className="count-note" style={{ margin: 0 }}>
                    {r.targetLabel}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 13.5, color: 'var(--text)' }}>
                    {r.text}
                  </span>
                </div>
                <button className="mini" onClick={() => removeEvent(r.target, r.name)}>
                  {t('countdownevent.delete')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
