import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';

// Native module — 時間與單位工具 · Time & Unit Tools.
// Faithful port of WinForge's TimeUnitModule: a live world-clock board (updates each
// second), a timezone converter, and offline unit conversions.
//
// The C# original reads zones from the OS (TimeZoneInfo). In the web/desktop React app
// the equivalent OS-backed source is the browser/runtime's own Intl time-zone database
// (IANA zones), so the clock and converter work everywhere with no network. When running
// inside the WinForge desktop app we additionally read the machine's current zone via
// PowerShell so the "This PC's time zone" line matches `tzutil /g` exactly. Everything is
// guarded and never throws.

// ---------- Time zones (IANA, from the runtime's Intl database) ----------

interface ZoneDef { id: string; label: string }

// A curated, broadly-supported set of IANA zones spanning the globe, ordered west→east.
// These mirror the spirit of WinForge's world-clock defaults plus a wider selection for
// the converter. Any zone the runtime doesn't know is filtered out at build time.
const RAW_ZONES: string[] = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const DEFAULT_BOARD: string[] = [
  'Pacific/Honolulu',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** Current UTC offset for an IANA zone, as a label like "UTC+08:00" (DST-aware). */
function offsetLabel(id: string, at: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      timeZoneName: 'shortOffset',
      hour: 'numeric',
    });
    const part = fmt.formatToParts(at).find((p) => p.type === 'timeZoneName');
    const raw = part?.value ?? 'GMT';
    // Normalise "GMT+8" / "GMT+08:00" / "UTC" → "UTC±HH:MM".
    const m = raw.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 'UTC+00:00';
    const sign = m[1]!;
    const hh = (m[2] ?? '0').padStart(2, '0');
    const mm = (m[3] ?? '00').padStart(2, '0');
    return `UTC${sign}${hh}:${mm}`;
  } catch {
    return 'UTC+00:00';
  }
}

/** Offset in minutes for an IANA zone at a given instant (east of UTC positive). */
function offsetMinutes(id: string, at: Date): number {
  try {
    // Format the same instant as wall-clock parts in the target zone, rebuild a UTC
    // timestamp from those parts, and diff against the real instant.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = fmt.formatToParts(at);
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value;
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : 0;
    };
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

interface WallClock { time: string; date: string }

/** Wall-clock time + date string for a zone at a given instant, in the chosen locale. */
function wallClock(id: string, at: Date, locale: string): WallClock {
  try {
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: id, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(at);
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: id, weekday: 'short', day: '2-digit', month: 'short',
    }).format(at);
    return { time, date };
  } catch {
    return { time: '--:--:--', date: '' };
  }
}

/** True if the zone's offset differs from its January offset (a rough DST indicator). */
function isDst(id: string, at: Date): boolean {
  try {
    const jan = new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
    const jul = new Date(Date.UTC(at.getUTCFullYear(), 6, 1));
    const std = Math.max(offsetMinutes(id, jan), offsetMinutes(id, jul));
    return offsetMinutes(id, at) < std;
  } catch {
    return false;
  }
}

// ---------- Unit conversion (faithful port of UnitConvertService) ----------

interface UnitDef { id: string; en: string; zh: string; factor: number; offset: number }
interface UnitCategory { id: string; en: string; zh: string; units: UnitDef[] }

const u = (id: string, en: string, zh: string, factor: number, offset = 0): UnitDef => ({ id, en, zh, factor, offset });

const CATEGORIES: UnitCategory[] = [
  {
    id: 'length', en: 'Length', zh: '長度', units: [
      u('mm', 'Millimetre (mm)', '毫米 (mm)', 0.001),
      u('cm', 'Centimetre (cm)', '厘米 (cm)', 0.01),
      u('m', 'Metre (m)', '米 (m)', 1.0),
      u('km', 'Kilometre (km)', '公里 (km)', 1000.0),
      u('in', 'Inch (in)', '英寸 (in)', 0.0254),
      u('ft', 'Foot (ft)', '英尺 (ft)', 0.3048),
      u('yd', 'Yard (yd)', '碼 (yd)', 0.9144),
      u('mi', 'Mile (mi)', '英里 (mi)', 1609.344),
      u('nmi', 'Nautical mile', '海里', 1852.0),
    ],
  },
  {
    id: 'mass', en: 'Mass / Weight', zh: '質量／重量', units: [
      u('mg', 'Milligram (mg)', '毫克 (mg)', 1e-6),
      u('g', 'Gram (g)', '克 (g)', 0.001),
      u('kg', 'Kilogram (kg)', '公斤 (kg)', 1.0),
      u('t', 'Tonne (t)', '公噸 (t)', 1000.0),
      u('oz', 'Ounce (oz)', '盎司 (oz)', 0.028349523125),
      u('lb', 'Pound (lb)', '磅 (lb)', 0.45359237),
      u('st', 'Stone (st)', '英石 (st)', 6.35029318),
      u('catty', 'Catty (斤)', '斤', 0.6048),
    ],
  },
  {
    id: 'temp', en: 'Temperature', zh: '溫度', units: [
      u('c', 'Celsius (°C)', '攝氏 (°C)', 1.0, 0.0),
      u('f', 'Fahrenheit (°F)', '華氏 (°F)', 5.0 / 9.0, -160.0 / 9.0),
      u('k', 'Kelvin (K)', '開爾文 (K)', 1.0, -273.15),
      u('r', 'Rankine (°R)', '蘭氏 (°R)', 5.0 / 9.0, -273.15),
    ],
  },
  {
    id: 'data', en: 'Data size', zh: '資料大小', units: [
      u('bit', 'Bit (bit)', '位元 (bit)', 0.125),
      u('b', 'Byte (B)', '位元組 (B)', 1.0),
      u('kb', 'Kilobyte (KB)', 'KB', 1000.0),
      u('mb', 'Megabyte (MB)', 'MB', 1e6),
      u('gb', 'Gigabyte (GB)', 'GB', 1e9),
      u('tb', 'Terabyte (TB)', 'TB', 1e12),
      u('kib', 'Kibibyte (KiB)', 'KiB', 1024.0),
      u('mib', 'Mebibyte (MiB)', 'MiB', 1048576.0),
      u('gib', 'Gibibyte (GiB)', 'GiB', 1073741824.0),
      u('tib', 'Tebibyte (TiB)', 'TiB', 1099511627776.0),
    ],
  },
  {
    id: 'speed', en: 'Speed', zh: '速度', units: [
      u('mps', 'Metre/sec (m/s)', '米／秒 (m/s)', 1.0),
      u('kmh', 'Km/hour (km/h)', '公里／時 (km/h)', 1000.0 / 3600.0),
      u('mph', 'Mile/hour (mph)', '英里／時 (mph)', 1609.344 / 3600.0),
      u('kn', 'Knot (kn)', '節 (kn)', 1852.0 / 3600.0),
      u('fts', 'Foot/sec (ft/s)', '英尺／秒 (ft/s)', 0.3048),
    ],
  },
  {
    id: 'area', en: 'Area', zh: '面積', units: [
      u('m2', 'Square metre (m²)', '平方米 (m²)', 1.0),
      u('km2', 'Square km (km²)', '平方公里 (km²)', 1e6),
      u('ft2', 'Square foot (ft²)', '平方英尺 (ft²)', 0.09290304),
      u('ac', 'Acre', '英畝', 4046.8564224),
      u('ha', 'Hectare', '公頃', 10000.0),
    ],
  },
  {
    id: 'volume', en: 'Volume', zh: '體積', units: [
      u('ml', 'Millilitre (mL)', '毫升 (mL)', 0.001),
      u('l', 'Litre (L)', '公升 (L)', 1.0),
      u('m3', 'Cubic metre (m³)', '立方米 (m³)', 1000.0),
      u('tsp', 'Teaspoon (US)', '茶匙（美）', 0.00492892159375),
      u('tbsp', 'Tablespoon (US)', '湯匙（美）', 0.01478676478125),
      u('cup', 'Cup (US)', '杯（美）', 0.2365882365),
      u('galus', 'Gallon (US)', '加侖（美）', 3.785411784),
      u('galuk', 'Gallon (UK)', '加侖（英）', 4.54609),
    ],
  },
  {
    id: 'time', en: 'Time', zh: '時間', units: [
      u('ms', 'Millisecond (ms)', '毫秒 (ms)', 0.001),
      u('s', 'Second (s)', '秒 (s)', 1.0),
      u('min', 'Minute (min)', '分鐘 (min)', 60.0),
      u('h', 'Hour (h)', '小時 (h)', 3600.0),
      u('day', 'Day', '日', 86400.0),
      u('week', 'Week', '星期', 604800.0),
      u('year', 'Year (365.25 d)', '年（365.25 日）', 31557600.0),
    ],
  },
  {
    id: 'pressure', en: 'Pressure', zh: '壓力', units: [
      u('pa', 'Pascal (Pa)', '帕斯卡 (Pa)', 1.0),
      u('kpa', 'Kilopascal (kPa)', '千帕 (kPa)', 1000.0),
      u('bar', 'Bar', '巴 (bar)', 100000.0),
      u('atm', 'Atmosphere (atm)', '標準大氣壓 (atm)', 101325.0),
      u('psi', 'PSI', '磅／平方吋 (psi)', 6894.757293168),
      u('mmhg', 'mmHg (Torr)', '毫米汞柱 (mmHg)', 133.322387415),
    ],
  },
];

/** Convert a value from one unit to another in the same category (affine, base-unit factors). */
function convertUnit(value: number, from: UnitDef, to: UnitDef): number {
  const baseValue = value * from.factor + from.offset;
  return (baseValue - to.offset) / to.factor;
}

function fmtNum(n: number, maxFrac: number): string {
  if (!Number.isFinite(n)) return '—';
  const s = n.toLocaleString('en-US', { maximumFractionDigits: maxFrac, useGrouping: false });
  return s;
}

// ---------- Component ----------

export function TimeUnitModule() {
  const { t, i18n } = useTranslation();
  const zh = (i18n.language || '').toLowerCase().startsWith('zh');
  const locale = zh ? 'zh-HK' : 'en-US';

  // Build the list of valid zones once (filter out any the runtime doesn't support).
  const zones: ZoneDef[] = useMemo(() => {
    const now = new Date();
    const out: ZoneDef[] = [];
    for (const id of RAW_ZONES) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: id }).format(now); // throws on unknown zone
        out.push({ id, label: `${offsetLabel(id, now)}  ${id.replace(/_/g, ' ')}` });
      } catch {
        // unsupported zone — skip
      }
    }
    return out;
  }, []);

  const localZoneId = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }, []);

  // Live "now", ticking every second for the clock board.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(h);
  }, []);

  // Desktop-only: the machine's Windows time-zone id (tzutil /g), shown as extra context.
  const [winZone, setWinZone] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    runPowershell('(Get-TimeZone).Id')
      .then((r) => { if (alive && r.success) setWinZone(r.stdout.trim() || null); })
      .catch(() => { /* ignore — non-fatal */ });
    return () => { alive = false; };
  }, []);

  // ---- World-clock board ----
  const [board, setBoard] = useState<string[]>(() => {
    const valid = new Set(RAW_ZONES);
    return DEFAULT_BOARD.filter((id) => valid.has(id));
  });
  const [addZone, setAddZone] = useState<string>(() => zones[0]?.id ?? 'UTC');

  const addCity = () => {
    if (!addZone || board.includes(addZone)) return;
    setBoard((b) => [...b, addZone]);
  };
  const removeCity = (id: string) => setBoard((b) => b.filter((x) => x !== id));

  // ---- Timezone converter ----
  const firstOther = zones.find((z) => z.id !== localZoneId)?.id ?? localZoneId;
  const [convFrom, setConvFrom] = useState<string>(localZoneId);
  const [convTo, setConvTo] = useState<string>(firstOther);
  const pad = (n: number) => String(n).padStart(2, '0');
  const initNow = new Date();
  const [convDate, setConvDate] = useState<string>(
    `${initNow.getFullYear()}-${pad(initNow.getMonth() + 1)}-${pad(initNow.getDate())}`,
  );
  const [convTime, setConvTime] = useState<string>(`${pad(initNow.getHours())}:${pad(initNow.getMinutes())}`);

  const setNowConv = () => {
    const d = new Date();
    setConvDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    setConvTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  };

  // Interpret the entered wall-clock time as being in `convFrom`, and express it in `convTo`.
  const convResult = useMemo((): string => {
    try {
      const dm = convDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const tm = convTime.match(/^(\d{1,2}):(\d{2})$/);
      if (!dm || !tm) return t('timeunit.convBadInput');
      const y = Number(dm[1]!), mo = Number(dm[2]!), da = Number(dm[3]!);
      const hh = Number(tm[1]!), mi = Number(tm[2]!);
      // Guess the UTC instant, then correct by the source zone's offset at that instant.
      let guess = Date.UTC(y, mo - 1, da, hh, mi, 0);
      const off1 = offsetMinutes(convFrom, new Date(guess));
      let instant = guess - off1 * 60000;
      const off2 = offsetMinutes(convFrom, new Date(instant));
      if (off2 !== off1) instant = guess - off2 * 60000; // one refinement for DST edges
      const at = new Date(instant);

      const fromWall = new Intl.DateTimeFormat(locale, {
        timeZone: convFrom, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(at);
      const toWall = new Intl.DateTimeFormat(locale, {
        timeZone: convTo, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(at);
      return `${fromWall}  (${offsetLabel(convFrom, at)})\n= ${toWall}  (${offsetLabel(convTo, at)})`;
    } catch (e) {
      return t('timeunit.convError', { msg: String(e instanceof Error ? e.message : e) });
    }
  }, [convDate, convTime, convFrom, convTo, locale, t]);

  // ---- Unit converter ----
  const [catId, setCatId] = useState<string>(CATEGORIES[0]!.id);
  const category = CATEGORIES.find((c) => c.id === catId) ?? CATEGORIES[0]!;
  const [fromUnit, setFromUnit] = useState<string>(category.units[0]!.id);
  const [toUnit, setToUnit] = useState<string>(category.units[1]?.id ?? category.units[0]!.id);
  const [rawValue, setRawValue] = useState<string>('1');

  // When the category changes, reset the two unit pickers to the first/second unit.
  const onCatChange = (id: string) => {
    const cat = CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0]!;
    setCatId(id);
    setFromUnit(cat.units[0]!.id);
    setToUnit(cat.units[1]?.id ?? cat.units[0]!.id);
  };

  const unitLabel = (unit: UnitDef): string => (zh ? unit.zh : unit.en);
  const catLabel = (cat: UnitCategory): string => (zh ? cat.zh : cat.en);

  const unitResult = useMemo((): string => {
    const from = category.units.find((x) => x.id === fromUnit) ?? category.units[0]!;
    const to = category.units.find((x) => x.id === toUnit) ?? category.units[0]!;
    const parsed = Number(rawValue);
    const value = Number.isFinite(parsed) ? parsed : 0;
    const result = convertUnit(value, from, to);
    return `${fmtNum(value, 6)} ${unitLabel(from)}\n= ${fmtNum(result, 10)} ${unitLabel(to)}`;
  }, [category, fromUnit, toUnit, rawValue, zh]);

  // Local clock line.
  const localWall = wallClock(localZoneId, now, locale);
  const localDateLong = (() => {
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone: localZoneId, weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
      }).format(now);
    } catch { return ''; }
  })();

  const zoneName = (id: string) => id.replace(/_/g, ' ');

  return (
    <div className="mod">
      <p className="count-note">{t('timeunit.blurb')}</p>

      {/* Local clock */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('timeunit.localCaption')}</span>
            <span className="value">
              {offsetLabel(localZoneId, now)}  {zoneName(localZoneId)}
              {isDst(localZoneId, now) ? t('timeunit.dstSuffix') : ''}
              {winZone && winZone !== localZoneId ? `  ·  ${winZone}` : ''}
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('timeunit.localTime')}</span>
            <span className="value" style={{ fontFamily: 'monospace', fontSize: 20 }}>{localWall.time}</span>
          </div>
          <div className="kv-row">
            <span className="label">{t('timeunit.localDate')}</span>
            <span className="value">{localDateLong}</span>
          </div>
        </div>
      </div>

      {/* World clock board */}
      <h3 style={{ margin: '4px 0 8px' }}>{t('timeunit.boardTitle')}</h3>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <select className="mod-select" value={addZone} onChange={(e) => setAddZone(e.target.value)}>
          {zones.map((z) => (<option key={z.id} value={z.id}>{z.label}</option>))}
        </select>
        <button className="mini primary" onClick={addCity}>{t('timeunit.addCity')}</button>
      </div>
      <div className="io-grid" style={{ marginTop: 8 }}>
        {board.length === 0 && <p className="count-note">{t('timeunit.boardEmpty')}</p>}
        {board.map((id) => {
          const w = wallClock(id, now, locale);
          return (
            <div key={id} className="panel" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{zoneName(id)}</div>
                <div className="count-note">
                  {offsetLabel(id, now)}{isDst(id, now) ? t('timeunit.dstDot') : ''}
                </div>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 18, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {w.time}<br /><span className="count-note">{w.date}</span>
              </div>
              <button className="mini" onClick={() => removeCity(id)} title={t('timeunit.remove')}>✕</button>
            </div>
          );
        })}
      </div>

      {/* Timezone converter */}
      <h3 style={{ margin: '16px 0 8px' }}>{t('timeunit.convTitle')}</h3>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.convWhen')}
          <span style={{ display: 'flex', gap: 4 }}>
            <input className="mod-search" type="date" value={convDate} onChange={(e) => setConvDate(e.target.value)} style={{ maxWidth: 150 }} />
            <input className="mod-search" type="time" value={convTime} onChange={(e) => setConvTime(e.target.value)} style={{ maxWidth: 110 }} />
          </span>
        </label>
        <button className="mini" onClick={setNowConv}>{t('timeunit.now')}</button>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.from')}
          <select className="mod-select" value={convFrom} onChange={(e) => setConvFrom(e.target.value)}>
            {zones.map((z) => (<option key={z.id} value={z.id}>{z.label}</option>))}
          </select>
        </label>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.to')}
          <select className="mod-select" value={convTo} onChange={(e) => setConvTo(e.target.value)}>
            {zones.map((z) => (<option key={z.id} value={z.id}>{z.label}</option>))}
          </select>
        </label>
      </div>
      <pre className="cmd-out" style={{ marginTop: 8 }}>{convResult}</pre>

      {/* Unit converter */}
      <h3 style={{ margin: '16px 0 8px' }}>{t('timeunit.unitTitle')}</h3>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.category')}
          <select className="mod-select" value={catId} onChange={(e) => onCatChange(e.target.value)}>
            {CATEGORIES.map((c) => (<option key={c.id} value={c.id}>{catLabel(c)}</option>))}
          </select>
        </label>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.value')}
          <input className="mod-search" type="number" value={rawValue} onChange={(e) => setRawValue(e.target.value)} style={{ maxWidth: 120 }} />
        </label>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.from')}
          <select className="mod-select" value={fromUnit} onChange={(e) => setFromUnit(e.target.value)}>
            {category.units.map((unit) => (<option key={unit.id} value={unit.id}>{unitLabel(unit)}</option>))}
          </select>
        </label>
        <label className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {t('timeunit.to')}
          <select className="mod-select" value={toUnit} onChange={(e) => setToUnit(e.target.value)}>
            {category.units.map((unit) => (<option key={unit.id} value={unit.id}>{unitLabel(unit)}</option>))}
          </select>
        </label>
      </div>
      <pre className="cmd-out" style={{ marginTop: 8 }}>{unitResult}</pre>

      <p className="count-note" style={{ marginTop: 12 }}>{t('timeunit.note')}</p>
    </div>
  );
}
