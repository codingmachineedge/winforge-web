import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ── Pure date arithmetic, ported 1:1 from WinForge Services/DateCalcService.cs ──

interface Difference {
  totalDays: number;
  weeks: number;
  remDays: number;
  businessDays: number;
  years: number;
  months: number;
  days: number;
  negative: boolean;
}

interface AgeInfo {
  years: number;
  months: number;
  days: number;
  totalDays: number;
  daysToNextBirthday: number;
  nextBirthday: Date;
  notYetBorn: boolean;
}

interface DateFacts {
  isoWeek: number;
  isoYear: number;
  dayOfYear: number;
  leapYear: boolean;
}

const MS_PER_DAY = 86_400_000;

/** Strip time; work in a stable UTC-midnight instant so DST never shifts day counts. */
function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
function daysBetween(lo: Date, hi: Date): number {
  return Math.round((hi.getTime() - lo.getTime()) / MS_PER_DAY);
}
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Whole days/weeks (+remainder), business days, and a Y/M/D breakdown. */
function diff(a: Date, b: Date): Difference {
  const da = dateOnly(a);
  const db = dateOnly(b);
  const negative = db.getTime() < da.getTime();
  const lo = negative ? db : da;
  const hi = negative ? da : db;

  const totalDays = daysBetween(lo, hi);
  const weeks = Math.floor(totalDays / 7);
  const remDays = totalDays % 7;

  // Business days: lo inclusive, hi exclusive, Mon..Fri only.
  let business = 0;
  for (let d = lo.getTime(); d < hi.getTime(); d += MS_PER_DAY) {
    const dow = new Date(d).getUTCDay(); // 0=Sun … 6=Sat
    if (dow !== 0 && dow !== 6) business++;
  }

  // Calendar Y/M/D breakdown, borrowing from the higher date's month.
  let years = hi.getUTCFullYear() - lo.getUTCFullYear();
  let months = hi.getUTCMonth() - lo.getUTCMonth();
  let days = hi.getUTCDate() - lo.getUTCDate();
  if (days < 0) {
    months--;
    const prevMonthYear = hi.getUTCMonth() === 0 ? hi.getUTCFullYear() - 1 : hi.getUTCFullYear();
    const prevMonth = hi.getUTCMonth() === 0 ? 12 : hi.getUTCMonth(); // 1-based month index
    days += daysInMonth(prevMonthYear, prevMonth);
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  return { totalDays, weeks, remDays, businessDays: business, years, months, days, negative };
}

/** Add (or subtract) a signed offset of years/months/weeks/days to a base date. */
function offset(base: Date, years: number, months: number, weeks: number, days: number, subtract: boolean): Date {
  const sign = subtract ? -1 : 1;
  const b = dateOnly(base);
  // AddYears / AddMonths clamp the day (C# DateTime.AddMonths semantics), then AddDays.
  let y = b.getUTCFullYear() + sign * years;
  let m = b.getUTCMonth() + sign * months; // 0-based, can overflow
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const day = Math.min(b.getUTCDate(), daysInMonth(y, m + 1));
  const shifted = new Date(Date.UTC(y, m, day));
  shifted.setUTCDate(shifted.getUTCDate() + sign * (weeks * 7 + days));
  return shifted;
}

/** The birthday in `year`, clamping Feb-29 to Feb-28 in common years. */
function safeAnniversary(birth: Date, year: number): Date {
  let day = birth.getUTCDate();
  if (birth.getUTCMonth() === 1 && birth.getUTCDate() === 29 && !isLeapYear(year)) day = 28;
  return new Date(Date.UTC(year, birth.getUTCMonth(), day));
}

/** Age (Y/M/D) as of `asOf`, days lived, and next-birthday countdown. */
function age(birthIn: Date, asOfIn: Date): AgeInfo {
  const birth = dateOnly(birthIn);
  const asOf = dateOnly(asOfIn);
  if (birth.getTime() > asOf.getTime()) {
    const toBorn = daysBetween(asOf, birth);
    return { years: 0, months: 0, days: 0, totalDays: 0, daysToNextBirthday: toBorn, nextBirthday: birth, notYetBorn: true };
  }
  const d = diff(birth, asOf);
  const lived = daysBetween(birth, asOf);
  let next = safeAnniversary(birth, asOf.getUTCFullYear());
  if (next.getTime() <= asOf.getTime()) next = safeAnniversary(birth, asOf.getUTCFullYear() + 1);
  const toNext = daysBetween(asOf, next);
  return { years: d.years, months: d.months, days: d.days, totalDays: lived, daysToNextBirthday: toNext, nextBirthday: next, notYetBorn: false };
}

/** ISO-8601 week number and its owning year (Mon-based, week 1 contains the first Thursday). */
function isoWeekYear(dateIn: Date): { isoWeek: number; isoYear: number } {
  const d = new Date(Date.UTC(dateIn.getUTCFullYear(), dateIn.getUTCMonth(), dateIn.getUTCDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the Thursday of this week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.floor((d.getTime() - yearStart.getTime()) / MS_PER_DAY / 7) + 1;
  return { isoWeek, isoYear };
}

/** Facts about a single date: ISO week/year, day-of-year, leap year. */
function facts(dateIn: Date): DateFacts {
  const d = dateOnly(dateIn);
  const { isoWeek, isoYear } = isoWeekYear(d);
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const dayOfYear = daysBetween(startOfYear, d) + 1;
  return { isoWeek, isoYear, dayOfYear, leapYear: isLeapYear(d.getUTCFullYear()) };
}

// ── Formatting helpers ──

function num(n: number): string {
  return n.toLocaleString('en-US'); // N0 → grouped, matches WinForge's :N0
}
/** Parse a yyyy-MM-dd <input type=date> value into a local Date, or null. */
function parseInput(v: string): Date | null {
  if (!v) return null;
  const parts = v.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const mo = Number(parts[1]);
  const da = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return null;
  return new Date(y, mo - 1, da);
}

export function DateCalcModule() {
  const { t, i18n } = useTranslation();

  const locale = i18n.language === 'en' ? 'en-US' : 'zh-HK';
  const weekdayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long' }), [locale]);
  const longDateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }),
    [locale],
  );
  const fmtWeekday = (d: Date) => weekdayFmt.format(d);
  const fmtLongDate = (d: Date) => longDateFmt.format(d);

  // Difference
  const [diffFrom, setDiffFrom] = useState('');
  const [diffTo, setDiffTo] = useState('');
  // Add / subtract
  const [addBase, setAddBase] = useState('');
  const [subtract, setSubtract] = useState(false);
  const [addYears, setAddYears] = useState(0);
  const [addMonths, setAddMonths] = useState(0);
  const [addWeeks, setAddWeeks] = useState(0);
  const [addDays, setAddDays] = useState(0);
  // Age
  const [ageBirth, setAgeBirth] = useState('');
  // Info
  const [infoDate, setInfoDate] = useState('');

  const [status, setStatus] = useState('');

  // ── Difference result ──
  const diffText = useMemo(() => {
    const from = parseInput(diffFrom);
    const to = parseInput(diffTo);
    if (!from || !to) return '';
    const d = diff(from, to);
    const sign = d.negative ? t('datecalc.diffEarlier') : '';
    return t('datecalc.diffResult', {
      total: num(d.totalDays),
      sign,
      weeks: num(d.weeks),
      remDays: d.remDays,
      y: d.years,
      m: d.months,
      d: d.days,
      business: num(d.businessDays),
    });
  }, [diffFrom, diffTo, t]);

  // ── Add / subtract result ──
  const addText = useMemo(() => {
    const b = parseInput(addBase);
    if (!b) return '';
    const result = offset(b, addYears, addMonths, addWeeks, addDays, subtract);
    return t('datecalc.addResult', {
      verb: subtract ? '−' : '+',
      y: addYears,
      m: addMonths,
      w: addWeeks,
      d: addDays,
      date: fmtLongDate(result),
    });
    // fmtLongDate is stable per-locale; deps below cover the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBase, addYears, addMonths, addWeeks, addDays, subtract, t, locale]);

  // ── Age result ──
  const ageText = useMemo(() => {
    const birth = parseInput(ageBirth);
    if (!birth) return '';
    const a = age(birth, new Date());
    if (a.notYetBorn) {
      return t('datecalc.ageFuture', { days: num(a.daysToNextBirthday) });
    }
    return t('datecalc.ageResult', {
      y: a.years,
      m: a.months,
      d: a.days,
      lived: num(a.totalDays),
      next: fmtLongDate(a.nextBirthday),
      toNext: num(a.daysToNextBirthday),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageBirth, t, locale]);

  // ── Info result ──
  const infoText = useMemo(() => {
    const dt = parseInput(infoDate);
    if (!dt) return '';
    const f = facts(dt);
    return t('datecalc.infoResult', {
      weekday: fmtWeekday(dt),
      isoWeek: f.isoWeek,
      isoYear: f.isoYear,
      dayOfYear: f.dayOfYear,
      leap: f.leapYear ? t('datecalc.yes') : t('datecalc.no'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoDate, t, locale]);

  const copy = (text: string) => {
    if (!text) {
      setStatus(t('datecalc.nothingToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(text);
    setStatus(t('datecalc.copied'));
  };

  const cardStyle: React.CSSProperties = {
    padding: '14px 16px',
    background: 'var(--card, rgba(127,127,127,0.06))',
    border: '1px solid var(--border, rgba(127,127,127,0.25))',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  };
  const titleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 15 };
  const resultStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', fontSize: 13.5, opacity: 0.85, margin: 0 };
  const numInput: React.CSSProperties = { maxWidth: 90 };

  const numBox = (label: string, val: number, set: (n: number) => void) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span className="count-note">{label}</span>
      <input
        className="mod-search"
        type="number"
        style={numInput}
        value={val}
        onChange={(e) => set(Math.trunc(Number(e.target.value) || 0))}
      />
    </label>
  );

  return (
    <div className="mod" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <p className="count-note" style={{ margin: 0 }}>
        {t('datecalc.blurb')}
      </p>

      {/* Difference */}
      <div style={cardStyle}>
        <div style={titleStyle}>{t('datecalc.diffTitle')}</div>
        <div className="mod-toolbar" style={{ gap: 10 }}>
          <input className="mod-search" type="date" value={diffFrom} onChange={(e) => setDiffFrom(e.target.value)} />
          <input className="mod-search" type="date" value={diffTo} onChange={(e) => setDiffTo(e.target.value)} />
        </div>
        <p style={resultStyle}>{diffText || t('datecalc.pickBoth')}</p>
        <div>
          <button className="mini" onClick={() => copy(diffText)}>
            {t('datecalc.copyResult')}
          </button>
        </div>
      </div>

      {/* Add / subtract */}
      <div style={cardStyle}>
        <div style={titleStyle}>{t('datecalc.addTitle')}</div>
        <div className="mod-toolbar" style={{ gap: 10 }}>
          <input className="mod-search" type="date" value={addBase} onChange={(e) => setAddBase(e.target.value)} />
          <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={subtract} onChange={(e) => setSubtract(e.target.checked)} />
            {subtract ? t('datecalc.subtract') : t('datecalc.add')}
          </label>
        </div>
        <div className="mod-toolbar" style={{ gap: 10 }}>
          {numBox(t('datecalc.years'), addYears, setAddYears)}
          {numBox(t('datecalc.months'), addMonths, setAddMonths)}
          {numBox(t('datecalc.weeks'), addWeeks, setAddWeeks)}
          {numBox(t('datecalc.days'), addDays, setAddDays)}
        </div>
        <p style={resultStyle}>{addText || t('datecalc.pickBase')}</p>
        <div>
          <button className="mini" onClick={() => copy(addText)}>
            {t('datecalc.copyResult')}
          </button>
        </div>
      </div>

      {/* Age */}
      <div style={cardStyle}>
        <div style={titleStyle}>{t('datecalc.ageTitle')}</div>
        <input className="mod-search" type="date" value={ageBirth} onChange={(e) => setAgeBirth(e.target.value)} />
        <p style={resultStyle}>{ageText || t('datecalc.pickBirth')}</p>
        <div>
          <button className="mini" onClick={() => copy(ageText)}>
            {t('datecalc.copyResult')}
          </button>
        </div>
      </div>

      {/* Info */}
      <div style={cardStyle}>
        <div style={titleStyle}>{t('datecalc.infoTitle')}</div>
        <input className="mod-search" type="date" value={infoDate} onChange={(e) => setInfoDate(e.target.value)} />
        <p style={resultStyle}>{infoText || t('datecalc.pickDate')}</p>
        <div>
          <button className="mini" onClick={() => copy(infoText)}>
            {t('datecalc.copyResult')}
          </button>
        </div>
      </div>

      {status && <p className="count-note" style={{ margin: 0 }}>{status}</p>}
    </div>
  );
}
