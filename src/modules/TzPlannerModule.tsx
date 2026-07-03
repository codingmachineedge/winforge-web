import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Faithful web port of WinForge TzPlannerService.
// C# uses managed TimeZoneInfo; the browser equivalent is the IANA tz database
// exposed via Intl. Every lookup is guarded so a bad zone id never throws.

type HoursState = 'InHours' | 'EdgeHours' | 'Night';

interface ZoneRow {
  zoneId: string;
  zoneName: string;
  localTime: string;
  offsetAndState: string;
  state: HoursState;
}

/** All IANA time zones, ordered by current UTC offset then id. Never throws. */
function allZones(): string[] {
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const ids = typeof anyIntl.supportedValuesOf === 'function' ? anyIntl.supportedValuesOf('timeZone') : null;
    const list = ids && ids.length > 0 ? ids.slice() : fallbackZones();
    const now = new Date();
    return list.sort((a, b) => {
      const oa = offsetMinutes(now, a);
      const ob = offsetMinutes(now, b);
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
  } catch {
    return fallbackZones();
  }
}

function fallbackZones(): string[] {
  const list = ['UTC'];
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local && local !== 'UTC') list.push(local);
  } catch {
    /* ignore */
  }
  return list;
}

/** Local browser IANA zone, or 'UTC' if unavailable. */
function localZoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** UTC offset in minutes for a zone at a given instant (honours DST). Never throws. */
function offsetMinutes(instant: Date, zone: string): number {
  try {
    // Format the instant in the target zone, reconstruct a UTC timestamp from those
    // wall-clock fields, and diff against the true UTC time -> offset.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
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
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUTC - instant.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * The real instant for a reference wall-clock time expressed in a reference zone.
 * Mirrors C# ConvertTimeToUtc: find the UTC instant whose local time in refZone
 * equals the entered wall clock. Uses the zone offset to invert.
 */
function instantForWallClock(wall: { y: number; mo: number; d: number; h: number; mi: number }, refZone: string): Date {
  try {
    // Guess: treat the wall fields as if UTC, then correct by the zone's offset at
    // that approximate instant. One correction pass is enough for all real zones.
    const guess = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, 0);
    const off1 = offsetMinutes(new Date(guess), refZone);
    const corrected = guess - off1 * 60000;
    const off2 = offsetMinutes(new Date(corrected), refZone);
    if (off2 !== off1) return new Date(guess - off2 * 60000);
    return new Date(corrected);
  } catch {
    return new Date();
  }
}

/** Wall-clock fields of an instant as seen in a zone. Never throws. */
function wallClockIn(instant: Date, zone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = dtf.formatToParts(instant);
    const get = (type: string): number => {
      const p = parts.find((x) => x.type === type);
      return p ? Number(p.value) : 0;
    };
    return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
  } catch {
    return { y: 1970, mo: 1, d: 1, h: 0, mi: 0 };
  }
}

/** "ddd dd MMM  HH:mm" rendering of an instant in a zone. Never throws. */
function formatLocal(instant: Date, zone: string): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = dtf.formatToParts(instant);
    const pick = (type: string): string => {
      const p = parts.find((x) => x.type === type);
      return p ? p.value : '';
    };
    return `${pick('weekday')} ${pick('day')} ${pick('month')}  ${pick('hour')}:${pick('minute')}`;
  } catch {
    return '';
  }
}

/** Format a UTC offset (in minutes) like "UTC+08:00" / "UTC-05:30". */
function formatOffset(mins: number): string {
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `UTC${sign}${pad(hh)}:${pad(mm)}`;
}

/**
 * Classify a local hour against working hours. In-hours = [start,end); one hour
 * either side = edge; otherwise night. start>=end is treated as full-day in-hours.
 */
function classify(h: number, m: number, startHour: number, endHour: number): HoursState {
  const s = Math.max(0, Math.min(23, startHour));
  const e = Math.max(1, Math.min(24, endHour));
  if (s >= e) return 'InHours';
  const hh = h + m / 60;
  if (hh >= s && hh < e) return 'InHours';
  if (hh >= s - 1 && hh < e + 1) return 'EdgeHours';
  return 'Night';
}

function stateLabel(s: HoursState, t: TFunction): string {
  if (s === 'InHours') return t('tzplanner.stateInHours');
  if (s === 'EdgeHours') return t('tzplanner.stateEdge');
  return t('tzplanner.stateNight');
}

function accentColor(s: HoursState): string {
  if (s === 'InHours') return '#2EA043';
  if (s === 'EdgeHours') return '#D98A00';
  return '#C42B1C';
}

function rowColor(s: HoursState): string {
  // 0x22 alpha -> ~0.133
  if (s === 'InHours') return 'rgba(46,160,67,0.133)';
  if (s === 'EdgeHours') return 'rgba(217,138,0,0.133)';
  return 'rgba(196,43,28,0.133)';
}

function nowFields(): { date: string; time: string } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function TzPlannerModule() {
  const { t } = useTranslation();
  const zones = useMemo(() => allZones(), []);
  const init = useMemo(() => nowFields(), []);

  const [refZone, setRefZone] = useState<string>(() => {
    const local = localZoneId();
    return zones.includes(local) ? local : (zones[0] ?? 'UTC');
  });
  const [dateText, setDateText] = useState<string>(init.date);
  const [timeText, setTimeText] = useState<string>(init.time);
  const [startHour, setStartHour] = useState<number>(9);
  const [endHour, setEndHour] = useState<number>(17);
  const [addZone, setAddZone] = useState<string>(() => zones[0] ?? 'UTC');
  const [zoneIds, setZoneIds] = useState<string[]>([]);

  const refInstant = useMemo(() => {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
    const tm = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
    const y = dm ? Number(dm[1]) : new Date().getFullYear();
    const mo = dm ? Number(dm[2]) : 1;
    const d = dm ? Number(dm[3]) : 1;
    const h = tm ? Number(tm[1]) : 0;
    const mi = tm ? Number(tm[2]) : 0;
    return instantForWallClock({ y, mo, d, h, mi }, refZone);
  }, [dateText, timeText, refZone]);

  const rows: ZoneRow[] = useMemo(() => {
    const out: ZoneRow[] = [];
    for (const id of zoneIds) {
      try {
        const local = formatLocal(refInstant, id);
        const off = offsetMinutes(refInstant, id);
        const wc = wallClockIn(refInstant, id);
        const state = classify(wc.h, wc.mi, startHour, endHour);
        out.push({
          zoneId: id,
          zoneName: id,
          localTime: local,
          offsetAndState: `${formatOffset(off)}  ·  ${stateLabel(state, t)}`,
          state,
        });
      } catch {
        /* skip a bad zone; never throw */
      }
    }
    return out;
  }, [zoneIds, refInstant, startHour, endHour, t]);

  const addParticipant = () => {
    const id = addZone;
    if (!id || zoneIds.includes(id)) return;
    setZoneIds((prev) => [...prev, id]);
  };

  const removeParticipant = (id: string) => {
    setZoneIds((prev) => prev.filter((x) => x !== id));
  };

  const monoSmall: React.CSSProperties = { fontFamily: 'monospace', minHeight: 0, height: 34 };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('tzplanner.blurb')}</p>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('tzplanner.refTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('tzplanner.refZone')}</label>
          <select className="mod-select" style={{ maxWidth: 320 }} value={refZone} onChange={(e) => setRefZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('tzplanner.date')}</label>
          <input className="hosts-edit" type="date" style={{ ...monoSmall, maxWidth: 170 }} value={dateText} onChange={(e) => setDateText(e.target.value)} />
          <label className="count-note">{t('tzplanner.time')}</label>
          <input className="hosts-edit" type="time" style={{ ...monoSmall, maxWidth: 120 }} value={timeText} onChange={(e) => setTimeText(e.target.value)} />
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('tzplanner.workStart')}</label>
          <input className="mod-search" type="number" min={0} max={23} style={{ maxWidth: 80 }} value={startHour} onChange={(e) => setStartHour(Math.max(0, Math.min(23, Math.floor(+e.target.value || 0))))} />
          <label className="count-note">{t('tzplanner.workEnd')}</label>
          <input className="mod-search" type="number" min={1} max={24} style={{ maxWidth: 80 }} value={endHour} onChange={(e) => setEndHour(Math.max(1, Math.min(24, Math.floor(+e.target.value || 0))))} />
        </div>
      </div>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('tzplanner.addTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <select className="mod-select" style={{ maxWidth: 320 }} value={addZone} onChange={(e) => setAddZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          <button className="mini primary" onClick={addParticipant}>{t('tzplanner.add')}</button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="count-note">{t('tzplanner.empty')}</p>
      ) : (
        <div className="kv-list">
          {rows.map((r) => (
            <div
              key={r.zoneId}
              className="kv-row"
              style={{
                background: rowColor(r.state),
                borderLeft: `3px solid ${accentColor(r.state)}`,
                padding: '8px 10px',
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div className="label" style={{ fontWeight: 600 }}>{r.zoneName}</div>
                <div className="value" style={{ fontFamily: 'monospace' }}>{r.localTime}</div>
                <div className="count-note" style={{ color: accentColor(r.state) }}>{r.offsetAndState}</div>
              </div>
              <button className="mini" onClick={() => removeParticipant(r.zoneId)}>{t('tzplanner.remove')}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
