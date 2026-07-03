import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ── Pure month-calendar maths (ported from WinForge Services/CalendarMonthService.cs) ──

type DayCell = { date: Date | null; inMonth: boolean; day: number };

// index 0 = Sunday .. 6 = Saturday, matching JS Date.getDay() / C# DayOfWeek.
const WEEKDAY_SHORT_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WEEKDAY_LONG_KEYS = ['sunLong', 'monLong', 'tueLong', 'wedLong', 'thuLong', 'friLong', 'satLong'] as const;
const MONTH_KEYS = [
  'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12',
] as const;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addMonths(d: Date, months: number): Date {
  // Mirror C# DateTime.AddMonths: clamp day to the target month's length.
  const year = d.getFullYear();
  const month = d.getMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const daysInTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(d.getDate(), daysInTarget);
  return new Date(targetYear, targetMonth, day);
}

// firstDay: 0 = Sunday, 1 = Monday. Returns weekday indices in header order.
function weekdayOrder(firstDay: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < 7; i++) order.push((firstDay + i) % 7);
  return order;
}

function buildGrid(year: number, month0: number, firstDay: number): DayCell[] {
  // month0 is 0-based month.
  const cells: DayCell[] = [];
  const first = new Date(year, month0, 1);
  const offset = ((first.getDay() - firstDay + 7) % 7);
  const start = new Date(year, month0, 1 - offset);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const inMonth = d.getMonth() === month0 && d.getFullYear() === year;
    cells.push({ date: d, inMonth, day: d.getDate() });
  }
  return cells;
}

// ISO-8601 week number (1..53).
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const diff = d.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (24 * 3600 * 1000));
}

function daysFromToday(date: Date): number {
  const today = startOfDay(new Date());
  const d = startOfDay(date);
  return Math.round((d.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function CalendarMonthModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');

  const [display, setDisplay] = useState<Date>(() => startOfDay(new Date()));
  const [firstDay, setFirstDay] = useState<0 | 1>(1); // 1 = Monday default, 0 = Sunday
  const [selected, setSelected] = useState<Date | null>(null);

  const today = useMemo(() => startOfDay(new Date()), []);
  const year = display.getFullYear();
  const month0 = display.getMonth();

  const cells = useMemo(() => buildGrid(year, month0, firstDay), [year, month0, firstDay]);
  const order = useMemo(() => weekdayOrder(firstDay), [firstDay]);

  const monthName = t(`calendarmonth.${MONTH_KEYS[month0]!}`);
  const monthTitle = zh
    ? t('calendarmonth.monthTitle', { year, month: monthName })
    : `${monthName} ${year}`;

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const detail = useMemo(() => {
    if (!selected) return t('calendarmonth.clickDay');
    const d = selected;
    const weekday = t(`calendarmonth.${WEEKDAY_LONG_KEYS[d.getDay()]!}`);
    const doy = dayOfYear(d);
    const wk = isoWeek(d);
    const delta = daysFromToday(d);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const rel =
      delta === 0
        ? t('calendarmonth.relToday')
        : delta > 0
          ? t('calendarmonth.relFuture', { n: delta })
          : t('calendarmonth.relPast', { n: -delta });
    if (zh) {
      const cnDate = t('calendarmonth.cnDate', { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
      return t('calendarmonth.detailZh', { date: cnDate, weekday, doy, wk, rel });
    }
    return t('calendarmonth.detailEn', { date: iso, weekday, doy, year: d.getFullYear(), wk, rel });
  }, [selected, zh, t]);

  const status = t('calendarmonth.status', {
    month: monthName,
    year,
    start: firstDay === 0 ? t('calendarmonth.sunLong') : t('calendarmonth.monLong'),
  });

  const weeks: number[] = [0, 1, 2, 3, 4, 5];
  const cols: number[] = [0, 1, 2, 3, 4, 5, 6];

  const accent = 'var(--accent, #2d7d46)';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, fontSize: 13 }}>
        {t('calendarmonth.blurb')}
      </p>

      <div
        style={{
          padding: '14px 16px',
          background: 'var(--card, rgba(255,255,255,0.03))',
          border: '1px solid var(--border, rgba(255,255,255,0.1))',
          borderRadius: 8,
        }}
      >
        {/* Navigation row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <button className="mini" style={{ minWidth: 40 }} onClick={() => setDisplay((d) => addMonths(d, -1))} aria-label={t('calendarmonth.prev')}>
            {'‹'}
          </button>
          <div style={{ flex: 1, textAlign: 'center', fontWeight: 600, fontSize: 17 }}>{monthTitle}</div>
          <button
            className="mini"
            onClick={() => {
              const tod = startOfDay(new Date());
              setDisplay(tod);
              setSelected(tod);
            }}
          >
            {t('calendarmonth.today')}
          </button>
          <button className="mini" style={{ minWidth: 40 }} onClick={() => setDisplay((d) => addMonths(d, 1))} aria-label={t('calendarmonth.next')}>
            {'›'}
          </button>
        </div>

        {/* Week-starts-on selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span className="count-note">{t('calendarmonth.weekStartsOn')}</span>
          <select
            className="mod-select"
            style={{ minWidth: 160 }}
            value={firstDay}
            onChange={(e) => setFirstDay(e.target.value === '0' ? 0 : 1)}
          >
            <option value="1">{t('calendarmonth.monLong')}</option>
            <option value="0">{t('calendarmonth.sunLong')}</option>
          </select>
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '38px repeat(7, 1fr)', gap: 0 }}>
          {/* Header row */}
          <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, opacity: 0.7, paddingBottom: 6 }}>
            {t('calendarmonth.wk')}
          </div>
          {cols.map((c) => (
            <div key={`h${c}`} style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, opacity: 0.7, paddingBottom: 6 }}>
              {t(`calendarmonth.${WEEKDAY_SHORT_KEYS[order[c]!]!}`)}
            </div>
          ))}

          {/* Week rows */}
          {weeks.map((week) => {
            const rowStart = week * 7;
            const cell0 = cells[rowStart]!;
            const wkText = cell0.date ? String(isoWeek(cell0.date)) : '';
            return (
              <div key={`w${week}`} style={{ display: 'contents' }}>
                <div style={{ textAlign: 'center', fontSize: 11, opacity: 0.7, alignSelf: 'center' }}>{wkText}</div>
                {cols.map((col) => {
                  const cell = cells[rowStart + col]!;
                  const d = cell.date;
                  const isToday = !!d && isSameDay(d, today);
                  const isSelected = !!d && !!selected && isSameDay(d, selected);
                  const style: React.CSSProperties = {
                    minHeight: 40,
                    margin: 1,
                    padding: 0,
                    border: '1px solid transparent',
                    borderRadius: 4,
                    background: 'transparent',
                    cursor: d ? 'pointer' : 'default',
                    fontSize: 13,
                    color: cell.inMonth ? 'inherit' : 'rgba(136,136,136,0.6)',
                  };
                  if (isToday) {
                    style.background = accent;
                    style.color = '#fff';
                    style.fontWeight = 600;
                  } else if (isSelected) {
                    style.border = `1px solid ${accent}`;
                  }
                  return (
                    <button
                      key={`c${week}-${col}`}
                      style={style}
                      disabled={!d}
                      onClick={() => d && setSelected(startOfDay(d))}
                    >
                      {d ? cell.day : ''}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Detail + status */}
        <p style={{ marginTop: 14, marginBottom: 6, opacity: 0.85, fontSize: 13.5 }}>{detail}</p>
        <p className="count-note" style={{ margin: 0 }}>
          {status}
        </p>
      </div>
    </div>
  );
}
