import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful web port of WinForge WorldClockModule + WorldClockService.
// The C# service uses Windows TimeZoneInfo ids; on the web we use IANA ids via Intl.
// Every lookup is guarded so it never throws and the UI always renders.

// Seed zones mirror the C# SeedZoneIds (Local + UTC/New York/London/Tokyo/Hong Kong).
const SEED_ZONE_IDS = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Hong_Kong'];

/** The machine local IANA zone, or 'UTC' if it can't be read. Never throws. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** All supported IANA zones, sorted by current UTC offset then id. Never throws. */
function allZones(): string[] {
  let list: string[] = [];
  try {
    // supportedValuesOf('timeZone') is widely available; fall back to a small set.
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof anyIntl.supportedValuesOf === 'function') {
      list = anyIntl.supportedValuesOf('timeZone').slice();
    }
  } catch {
    list = [];
  }
  if (list.length === 0) {
    list = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Australia/Sydney'];
  }
  const l = localZone();
  if (!list.includes(l)) list.unshift(l);
  const now = new Date();
  try {
    list.sort((a, b) => {
      const c = offsetMinutes(now, a) - offsetMinutes(now, b);
      return c !== 0 ? c : a < b ? -1 : a > b ? 1 : 0;
    });
  } catch {
    /* leave unsorted on error */
  }
  return list;
}

/** Effective UTC offset (minutes) for a zone at a given instant. Guarded → 0 on error. */
function offsetMinutes(instant: Date, zone: string): number {
  try {
    // Compute offset by formatting the same instant as UTC vs as the zone.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(instant);
    const get = (type: string): number => {
      const p = parts.find((x) => x.type === type);
      return p ? Number(p.value) : 0;
    };
    let hour = get('hour');
    if (hour === 24) hour = 0;
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return Math.round((asUTC - instant.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Format an offset like "UTC+08:00" / "UTC-05:00" (mirrors C# FormatOffset). */
function formatOffset(mins: number): string {
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `UTC${sign}${pad(hh)}:${pad(mm)}`;
}

/** Wall-clock parts for an instant in a zone. Guarded → falls back to UTC parts. */
interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  monthShort: string;
}
function wallParts(instant: Date, zone: string): WallParts {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    });
    const parts = dtf.formatToParts(instant);
    const num = (type: string): number => {
      const p = parts.find((x) => x.type === type);
      return p ? Number(p.value) : 0;
    };
    const str = (type: string): string => {
      const p = parts.find((x) => x.type === type);
      return p ? p.value : '';
    };
    let hour = num('hour');
    if (hour === 24) hour = 0;
    const month = num('month');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      year: num('year'),
      month,
      day: num('day'),
      hour,
      minute: num('minute'),
      second: num('second'),
      weekday: str('weekday'),
      monthShort: MONTHS[month - 1] ?? '',
    };
  } catch {
    return { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0, weekday: '', monthShort: '' };
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const timeHMS = (w: WallParts) => `${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
const timeHM = (w: WallParts) => `${pad2(w.hour)}:${pad2(w.minute)}`;
const dayLong = (w: WallParts) => `${w.weekday}, ${pad2(w.day)} ${w.monthShort}`;
const dayShort = (w: WallParts) => `${w.weekday.slice(0, 3)}, ${pad2(w.day)} ${w.monthShort}`;

/**
 * Parse a wall-clock "YYYY-MM-DD HH:mm[:ss]" (or with 'T') as being in the given zone,
 * returning the corresponding UTC instant. Guarded → null on failure.
 */
function parseInZone(text: string, zone: string): Date | null {
  const t = text.trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]!);
  const mo = Number(m[2]!);
  const d = Number(m[3]!);
  const hh = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const ss = m[6] ? Number(m[6]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  try {
    // Treat the wall time as UTC first, then subtract the zone offset at that instant.
    const naiveUtc = Date.UTC(y, mo - 1, d, hh, mi, ss);
    const off = offsetMinutes(new Date(naiveUtc), zone);
    return new Date(naiveUtc - off * 60000);
  } catch {
    return null;
  }
}

interface ConvertRow {
  name: string;
  time: string;
  day: string;
}

export function WorldClockModule() {
  const { t } = useTranslation();

  const zones = useMemo(() => allZones(), []);
  const [rows, setRows] = useState<string[]>(() => {
    const seed: string[] = [];
    const add = (id: string) => {
      if (id && !seed.some((x) => x.toLowerCase() === id.toLowerCase())) seed.push(id);
    };
    add(localZone());
    for (const id of SEED_ZONE_IDS) add(id);
    return seed;
  });

  const [addZone, setAddZone] = useState<string>(() => zones[0] ?? 'UTC');
  const [selected, setSelected] = useState<string>('');

  const [convZone, setConvZone] = useState<string>(() => localZone());
  const [convTime, setConvTime] = useState<string>('');
  const [convRows, setConvRows] = useState<ConvertRow[]>([]);
  const [convMsg, setConvMsg] = useState<string>('');

  // Live 1-second tick, mirroring the DispatcherTimer in the C# page.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const liveRows = useMemo(() => {
    return rows.map((id) => {
      const w = wallParts(now, id);
      const off = offsetMinutes(now, id);
      return { id, name: id, time: timeHMS(w), offset: formatOffset(off), day: dayLong(w) };
    });
  }, [rows, now]);

  const addRow = () => {
    const id = addZone;
    if (!id) return;
    if (rows.some((x) => x.toLowerCase() === id.toLowerCase())) return;
    setRows([...rows, id]);
  };

  const removeSelected = () => {
    if (!selected) return;
    setRows(rows.filter((x) => x !== selected));
    setSelected('');
  };

  const doConvert = () => {
    const src = convZone || localZone();
    const text = convTime.trim();
    let utc: Date;
    if (text === '') {
      utc = new Date();
    } else {
      const parsed = parseInZone(text, src);
      if (!parsed) {
        setConvMsg(t('worldclock.badTime'));
        setConvRows([]);
        return;
      }
      utc = parsed;
    }
    const out: ConvertRow[] = rows.map((id) => {
      const w = wallParts(utc, id);
      const off = offsetMinutes(utc, id);
      return {
        name: `${id}  ·  ${formatOffset(off)}`,
        time: timeHM(w),
        day: dayShort(w),
      };
    });
    setConvRows(out);
    const shown = text === '' ? formatOffset(offsetMinutes(utc, src)) : text;
    setConvMsg(t('worldclock.convShowing', { time: shown, count: out.length }));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('worldclock.blurb')}</p>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('worldclock.addTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <select className="mod-select" style={{ maxWidth: 320 }} value={addZone} onChange={(e) => setAddZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          <button className="mini primary" onClick={addRow}>{t('worldclock.add')}</button>
          <button className="mini" disabled={!selected} onClick={removeSelected}>{t('worldclock.remove')}</button>
        </div>
        <div className="panel" style={{ marginTop: 8 }}>
          <table className="dt">
            <tbody>
              {liveRows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  style={{ cursor: 'pointer', background: selected === r.id ? 'var(--sel, rgba(127,127,127,0.18))' : undefined }}
                >
                  <td>
                    <label className="chk" style={{ pointerEvents: 'none' }}>
                      <input type="radio" readOnly checked={selected === r.id} /> {r.name}
                    </label>
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{r.time}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.offset}</td>
                  <td>{r.day}</td>
                </tr>
              ))}
              {liveRows.length === 0 ? (
                <tr><td colSpan={4} className="count-note">{t('worldclock.noZones')}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="count-note">{t('worldclock.status', { count: rows.length })}</p>
      </div>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('worldclock.convTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="hosts-edit"
            style={{ minHeight: 0, height: 34, maxWidth: 200, fontFamily: 'monospace' }}
            placeholder="2026-07-01 14:30"
            value={convTime}
            onChange={(e) => setConvTime(e.target.value)}
          />
          <select className="mod-select" style={{ maxWidth: 320 }} value={convZone} onChange={(e) => setConvZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          <button className="mini primary" onClick={doConvert}>{t('worldclock.convert')}</button>
        </div>
        <p className="count-note">{convMsg || t('worldclock.convHint')}</p>
        {convRows.length > 0 ? (
          <div className="panel">
            <table className="dt">
              <tbody>
                {convRows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td style={{ fontFamily: 'monospace' }}>{r.time}</td>
                    <td>{r.day}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
