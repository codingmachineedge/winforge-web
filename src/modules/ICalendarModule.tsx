import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ===== iCalendar build/parse (ported from WinForge Services/ICalendarService.cs) =====

type Recur = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

interface EventSpec {
  summary: string;
  location: string;
  description: string;
  start: Date;
  allDay: boolean;
  durationMinutes: number;
  recurrence: Recur;
  interval: number;
  count: number;
  reminderMinutes: number; // -1 = none
}

interface ParsedEvent {
  summary: string;
  start: string;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// Floating local time (no Z) — DTSTART/DTEND in the wall-clock the user picked.
function localStamp(d: Date): string {
  return (
    d.getFullYear().toString().padStart(4, '0') +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    'T' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function dateStamp(d: Date): string {
  return d.getFullYear().toString().padStart(4, '0') + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

function utcStamp(d: Date): string {
  return (
    d.getUTCFullYear().toString().padStart(4, '0') +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

// Escape ,;\ and newlines per RFC 5545.
function escapeText(s: string): string {
  if (!s) return '';
  let out = '';
  for (const c of s) {
    switch (c) {
      case '\\':
        out += '\\\\';
        break;
      case ';':
        out += '\\;';
        break;
      case ',':
        out += '\\,';
        break;
      case '\r':
        break;
      case '\n':
        out += '\\n';
        break;
      default:
        out += c;
    }
  }
  return out;
}

function utf8Width(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

// Fold a line at 75 octets (UTF-8); continuation lines begin with a single space.
function fold(line: string): string {
  if (!line) return line;
  if (line.length <= 75) {
    let ascii = true;
    for (const c of line) {
      if (c.codePointAt(0)! > 127) {
        ascii = false;
        break;
      }
    }
    if (ascii) return line;
  }
  let out = '';
  let octets = 0;
  let continuation = false;
  const limit = 75;
  for (const c of line) {
    const w = utf8Width(c.codePointAt(0)!);
    const effLimit = continuation ? limit - 1 : limit;
    if (octets + w > effLimit) {
      out += '\r\n ';
      continuation = true;
      octets = 0;
    }
    out += c;
    octets += w;
  }
  return out;
}

function buildRRule(e: EventSpec): string | null {
  if (e.recurrence === 'none') return null;
  const freq =
    e.recurrence === 'daily'
      ? 'DAILY'
      : e.recurrence === 'weekly'
        ? 'WEEKLY'
        : e.recurrence === 'monthly'
          ? 'MONTHLY'
          : 'YEARLY';
  let rule = 'RRULE:FREQ=' + freq;
  const interval = e.interval > 0 ? e.interval : 1;
  if (interval > 1) rule += ';INTERVAL=' + interval;
  if (e.count > 0) rule += ';COUNT=' + e.count;
  return rule;
}

function buildIcs(e: EventSpec): string {
  try {
    const raw: string[] = [];
    raw.push('BEGIN:VCALENDAR');
    raw.push('VERSION:2.0');
    raw.push('PRODID:-//WinForge//iCalendar Builder//EN');
    raw.push('CALSCALE:GREGORIAN');
    raw.push('METHOD:PUBLISH');
    raw.push('BEGIN:VEVENT');
    raw.push('UID:' + genUid() + '@winforge');
    raw.push('DTSTAMP:' + utcStamp(new Date()));

    if (e.allDay) {
      const d = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate());
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      raw.push('DTSTART;VALUE=DATE:' + dateStamp(d));
      raw.push('DTEND;VALUE=DATE:' + dateStamp(next));
    } else {
      const dur = e.durationMinutes > 0 ? e.durationMinutes : 60;
      const end = new Date(e.start.getTime() + dur * 60000);
      raw.push('DTSTART:' + localStamp(e.start));
      raw.push('DTEND:' + localStamp(end));
    }

    const rrule = buildRRule(e);
    if (rrule !== null) raw.push(rrule);

    if (e.summary.trim()) raw.push('SUMMARY:' + escapeText(e.summary));
    if (e.location.trim()) raw.push('LOCATION:' + escapeText(e.location));
    if (e.description.trim()) raw.push('DESCRIPTION:' + escapeText(e.description));

    if (e.reminderMinutes >= 0) {
      raw.push('BEGIN:VALARM');
      raw.push('ACTION:DISPLAY');
      raw.push('DESCRIPTION:' + escapeText(e.summary.trim() ? e.summary : 'Reminder'));
      raw.push('TRIGGER:-PT' + e.reminderMinutes + 'M');
      raw.push('END:VALARM');
    }

    raw.push('END:VEVENT');
    raw.push('END:VCALENDAR');

    return raw.map((l) => fold(l)).join('\r\n') + '\r\n';
  } catch {
    return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
  }
}

function genUid(): string {
  try {
    const u = crypto.randomUUID().replace(/-/g, '');
    return u;
  } catch {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
}

// ===== parse =====

function unfold(ics: string): string[] {
  const rawLines = ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of rawLines) {
    if (l.length > 0 && (l[0] === ' ' || l[0] === '\t') && out.length > 0) {
      out[out.length - 1] = out[out.length - 1]! + l.substring(1);
    } else {
      out.push(l);
    }
  }
  return out;
}

function splitProp(line: string): { name: string; value: string } {
  const colon = line.indexOf(':');
  if (colon < 0) return { name: line, value: '' };
  const left = line.substring(0, colon);
  const value = line.substring(colon + 1);
  const semi = left.indexOf(';');
  const name = semi >= 0 ? left.substring(0, semi) : left;
  return { name, value };
}

function unescapeText(s: string): string {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i]!;
      switch (n) {
        case 'n':
        case 'N':
          out += '\n';
          break;
        case '\\':
          out += '\\';
          break;
        case ';':
          out += ';';
          break;
        case ',':
          out += ',';
          break;
        default:
          out += n;
      }
    } else {
      out += c;
    }
  }
  return out;
}

// Turn 20260701T093000Z / 20260701 into something readable; leave anything odd as-is.
function prettyDate(raw: string): string {
  const v = raw.trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) {
    const base = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    return m[7] === 'Z' ? base + ' UTC' : base;
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return v;
}

function parseIcs(ics: string): ParsedEvent[] {
  const results: ParsedEvent[] = [];
  if (!ics || !ics.trim()) return results;
  try {
    const lines = unfold(ics);
    let inEvent = false;
    let summary = '';
    let start = '';
    for (const line of lines) {
      const tt = line.trim();
      if (tt.toUpperCase() === 'BEGIN:VEVENT') {
        inEvent = true;
        summary = '';
        start = '';
        continue;
      }
      if (tt.toUpperCase() === 'END:VEVENT') {
        if (inEvent) {
          results.push({
            summary: summary.length === 0 ? '(no title)' : summary,
            start: start.length === 0 ? '(no start)' : start,
          });
        }
        inEvent = false;
        continue;
      }
      if (!inEvent) continue;
      const { name, value } = splitProp(tt);
      const upper = name.toUpperCase();
      if (upper === 'SUMMARY') summary = unescapeText(value);
      else if (upper === 'DTSTART') start = prettyDate(value);
    }
  } catch {
    /* return whatever we gathered */
  }
  return results;
}

// ===== helpers for date/time <input> plumbing =====

function toDateInput(d: Date): string {
  return d.getFullYear().toString().padStart(4, '0') + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function toTimeInput(d: Date): string {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function makeFileName(summary: string): string {
  let title = summary.trim();
  if (title.length === 0) title = 'event';
  title = title.replace(/[\\/:*?"<>|]/g, '_');
  if (title.length > 40) title = title.substring(0, 40);
  return title + '.ics';
}

// ===== component =====

type Severity = 'success' | 'warning' | 'error';

export function ICalendarModule() {
  const { t } = useTranslation();

  const now = useMemo(() => new Date(), []);
  const [summary, setSummary] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [dateStr, setDateStr] = useState(toDateInput(now));
  const [timeStr, setTimeStr] = useState(toTimeInput(now));
  const [allDay, setAllDay] = useState(false);
  const [durationValue, setDurationValue] = useState(60);
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'hours'>('minutes');
  const [recur, setRecur] = useState<Recur>('none');
  const [interval, setIntervalVal] = useState(1);
  const [countVal, setCountVal] = useState(0);
  const [reminder, setReminder] = useState<number>(-1);
  const [status, setStatus] = useState<{ msg: string; sev: Severity } | null>(null);

  const [parseInput, setParseInput] = useState('');
  const [parsed, setParsed] = useState<ParsedEvent[] | null>(null);

  const spec = useMemo<EventSpec>(() => {
    // Compose start date + time.
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    const tm = /^(\d{1,2}):(\d{2})/.exec(timeStr);
    const y = dm ? +dm[1]! : now.getFullYear();
    const mo = dm ? +dm[2]! - 1 : now.getMonth();
    const day = dm ? +dm[3]! : now.getDate();
    const hh = tm ? +tm[1]! : 0;
    const mi = tm ? +tm[2]! : 0;
    const start = new Date(y, mo, day, hh, mi, 0);
    const durMin = Math.max(1, Math.floor(durationUnit === 'hours' ? durationValue * 60 : durationValue));
    return {
      summary,
      location,
      description,
      start,
      allDay,
      durationMinutes: durMin,
      recurrence: recur,
      interval: Math.max(1, Math.floor(interval)),
      count: Math.max(0, Math.floor(countVal)),
      reminderMinutes: reminder,
    };
  }, [summary, location, description, dateStr, timeStr, allDay, durationValue, durationUnit, recur, interval, countVal, reminder, now]);

  const output = useMemo(() => {
    try {
      const ics = buildIcs(spec);
      return ics;
    } catch {
      return '';
    }
  }, [spec]);

  // Mirror WinForge's "Event ready" status on every regenerate.
  const outputStatusMsg = output ? t('icalendar.ready') : t('icalendar.genFail');

  const copy = async () => {
    if (!output) {
      setStatus({ msg: t('icalendar.nothingCopy'), sev: 'warning' });
      return;
    }
    try {
      await navigator.clipboard?.writeText(output);
      setStatus({ msg: t('icalendar.copied'), sev: 'success' });
    } catch {
      setStatus({ msg: t('icalendar.copyFail'), sev: 'error' });
    }
  };

  const save = () => {
    if (!output) {
      setStatus({ msg: t('icalendar.nothingSave'), sev: 'warning' });
      return;
    }
    try {
      const blob = new Blob([output], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = makeFileName(summary);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ msg: t('icalendar.saved', { name: a.download }), sev: 'success' });
    } catch {
      setStatus({ msg: t('icalendar.saveFail'), sev: 'error' });
    }
  };

  const runParse = (ics: string) => {
    try {
      const events = parseIcs(ics);
      setParsed(events);
      if (events.length === 0) {
        setStatus({ msg: t('icalendar.noEvents'), sev: 'warning' });
      } else {
        setStatus({ msg: t('icalendar.found', { n: events.length }), sev: 'success' });
      }
    } catch {
      setParsed([]);
      setStatus({ msg: t('icalendar.parseFail'), sev: 'error' });
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard?.readText()) ?? '';
      if (!text) {
        setStatus({ msg: t('icalendar.clipEmpty'), sev: 'warning' });
        return;
      }
      setParseInput(text);
      runParse(text);
    } catch {
      setStatus({ msg: t('icalendar.pasteFail'), sev: 'error' });
    }
  };

  const sevColor = (sev: Severity): string =>
    sev === 'error' ? 'var(--danger)' : sev === 'warning' ? 'var(--warning, #b8860b)' : 'var(--accent, #2d7d46)';

  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border, #d0d0d0)',
    borderRadius: 8,
    padding: '14px 16px',
    marginTop: 12,
    background: 'var(--card-bg, transparent)',
  };
  const titleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 15, margin: '0 0 4px' };
  const rowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 };
  const labelStyle: React.CSSProperties = { fontSize: 13, minWidth: 60 };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('icalendar.blurb')}
      </p>

      {status && (
        <p style={{ marginTop: 8, color: sevColor(status.sev), fontSize: 12.5 }}>{status.msg}</p>
      )}

      {/* Event details */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('icalendar.detailsTitle')}</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <label style={labelStyle}>{t('icalendar.titleLabel')}</label>
          <input className="mod-search" value={summary} placeholder={t('icalendar.titlePlaceholder')} onChange={(e) => setSummary(e.target.value)} />

          <label style={labelStyle}>{t('icalendar.locationLabel')}</label>
          <input className="mod-search" value={location} placeholder={t('icalendar.locationPlaceholder')} onChange={(e) => setLocation(e.target.value)} />

          <label style={labelStyle}>{t('icalendar.descLabel')}</label>
          <textarea className="hosts-edit" style={{ minHeight: 72 }} spellCheck={false} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div style={rowStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <label style={{ fontSize: 12 }}>{t('icalendar.startDate')}</label>
            <input className="mod-search" type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <label style={{ fontSize: 12 }}>{t('icalendar.startTime')}</label>
            <input className="mod-search" type="time" value={timeStr} disabled={allDay} onChange={(e) => setTimeStr(e.target.value)} />
          </div>
        </div>

        <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 600 }}>{t('icalendar.allDayTitle')}</span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{t('icalendar.allDayHint')}</span>
          </div>
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          </label>
        </div>

        {!allDay && (
          <div style={rowStyle}>
            <span style={{ fontSize: 13 }}>{t('icalendar.lastsFor')}</span>
            <input
              className="mod-search"
              type="number"
              min={1}
              max={100000}
              style={{ maxWidth: 120 }}
              value={durationValue}
              onChange={(e) => setDurationValue(Math.max(1, Math.min(100000, +e.target.value || 1)))}
            />
            <select className="mod-select" value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as 'minutes' | 'hours')}>
              <option value="minutes">{t('icalendar.minutes')}</option>
              <option value="hours">{t('icalendar.hours')}</option>
            </select>
          </div>
        )}
      </div>

      {/* Recurrence + reminder */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('icalendar.repeatTitle')}</h3>

        <div style={rowStyle}>
          <span style={{ fontSize: 13 }}>{t('icalendar.repeat')}</span>
          <select className="mod-select" value={recur} onChange={(e) => setRecur(e.target.value as Recur)}>
            <option value="none">{t('icalendar.recurNone')}</option>
            <option value="daily">{t('icalendar.recurDaily')}</option>
            <option value="weekly">{t('icalendar.recurWeekly')}</option>
            <option value="monthly">{t('icalendar.recurMonthly')}</option>
            <option value="yearly">{t('icalendar.recurYearly')}</option>
          </select>
        </div>

        {recur !== 'none' && (
          <div style={rowStyle}>
            <span style={{ fontSize: 13 }}>{t('icalendar.every')}</span>
            <input
              className="mod-search"
              type="number"
              min={1}
              max={1000}
              style={{ maxWidth: 100 }}
              value={interval}
              onChange={(e) => setIntervalVal(Math.max(1, Math.min(1000, +e.target.value || 1)))}
            />
            <input
              className="mod-search"
              type="number"
              min={0}
              max={100000}
              style={{ maxWidth: 100 }}
              value={countVal}
              onChange={(e) => setCountVal(Math.max(0, Math.min(100000, +e.target.value || 0)))}
            />
            <span style={{ fontSize: 13 }}>{t('icalendar.countLabel')}</span>
          </div>
        )}

        <div style={rowStyle}>
          <span style={{ fontSize: 13 }}>{t('icalendar.reminder')}</span>
          <select className="mod-select" value={reminder} onChange={(e) => setReminder(+e.target.value)}>
            <option value={-1}>{t('icalendar.remNone')}</option>
            <option value={5}>{t('icalendar.rem5')}</option>
            <option value={15}>{t('icalendar.rem15')}</option>
            <option value={30}>{t('icalendar.rem30')}</option>
            <option value={60}>{t('icalendar.rem60')}</option>
          </select>
        </div>
      </div>

      {/* Output */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('icalendar.outputTitle')}</h3>
        <textarea
          className="hosts-edit"
          style={{ minHeight: 180, fontFamily: 'Consolas, monospace', whiteSpace: 'pre', overflowX: 'auto' }}
          spellCheck={false}
          readOnly
          value={output}
        />
        <div className="mod-toolbar" style={{ marginTop: 10 }}>
          <button className="mini" onClick={copy}>
            {t('icalendar.copy')}
          </button>
          <button className="mini primary" onClick={save}>
            {t('icalendar.save')}
          </button>
          <span className="count-note">{outputStatusMsg}</span>
        </div>
      </div>

      {/* Parser */}
      <div style={cardStyle}>
        <h3 style={titleStyle}>{t('icalendar.parseTitle')}</h3>
        <textarea
          className="hosts-edit"
          style={{ minHeight: 120, fontFamily: 'Consolas, monospace', whiteSpace: 'pre', overflowX: 'auto' }}
          spellCheck={false}
          placeholder={t('icalendar.parsePlaceholder')}
          value={parseInput}
          onChange={(e) => setParseInput(e.target.value)}
        />
        <div className="mod-toolbar" style={{ marginTop: 10 }}>
          <button className="mini primary" onClick={() => runParse(parseInput)}>
            {t('icalendar.listEvents')}
          </button>
          <button className="mini" onClick={pasteFromClipboard}>
            {t('icalendar.paste')}
          </button>
        </div>
        {parsed && parsed.length > 0 && (
          <div className="kv-list" style={{ marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
            {parsed.map((ev, i) => (
              <div className="kv-row" key={i} style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 0' }}>
                <span style={{ fontWeight: 600 }}>{ev.summary}</span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{ev.start}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
