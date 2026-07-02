import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Sets {
  min: Set<number>;
  hr: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function parseField(f: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    let step = 1;
    let range = part;
    if (part.includes('/')) {
      const [r, s] = part.split('/');
      range = r!;
      step = Number(s);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1 || lo < min || hi > max || lo > hi)
      throw new Error(`bad field "${f}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): Sets {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('need 5 fields: minute hour day month weekday');
  const dow = parseField(parts[4]!, 0, 7);
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }
  return {
    min: parseField(parts[0]!, 0, 59),
    hr: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    mon: parseField(parts[3]!, 1, 12),
    dow,
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  };
}

function matches(d: Date, s: Sets): boolean {
  const domMatch = s.dom.has(d.getDate());
  const dowMatch = s.dow.has(d.getDay());
  // Cron day rule: if both DOM and DOW are restricted, match on EITHER; else use whichever is restricted.
  let dayOk: boolean;
  if (s.domStar && s.dowStar) dayOk = true;
  else if (s.domStar) dayOk = dowMatch;
  else if (s.dowStar) dayOk = domMatch;
  else dayOk = domMatch || dowMatch;
  return s.min.has(d.getMinutes()) && s.hr.has(d.getHours()) && s.mon.has(d.getMonth() + 1) && dayOk;
}

function nextRuns(s: Sets, count: number): Date[] {
  const runs: Date[] = [];
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 && runs.length < count; i++) {
    if (matches(d, s)) runs.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return runs;
}

function relative(d: Date, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = d.getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return t('cron.inMin', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return t('cron.inHr', { n: hrs });
  return t('cron.inDay', { n: Math.round(hrs / 24) });
}

const PRESETS: [string, string][] = [
  ['*/15 * * * *', 'every15'],
  ['0 9 * * 1-5', 'weekdays9'],
  ['0 0 1 * *', 'firstOfMonth'],
];

export function CronModule() {
  const { t } = useTranslation();
  const [expr, setExpr] = useState('*/15 * * * *');
  const [count, setCount] = useState(10);

  const parsed = useMemo(() => {
    try {
      return { sets: parseCron(expr), error: null as string | null };
    } catch (e) {
      return { sets: null, error: String(e instanceof Error ? e.message : e) };
    }
  }, [expr]);

  const runs = useMemo(() => (parsed.sets ? nextRuns(parsed.sets, count) : []), [parsed.sets, count]);
  const copy = () => runs.length && void navigator.clipboard?.writeText(runs.map((d) => d.toLocaleString()).join('\n'));

  return (
    <div className="mod">
      <div className="mod-form">
        <input className="mod-search rx-pattern" placeholder="* * * * *" value={expr} onChange={(e) => setExpr(e.target.value)} />
      </div>
      <div className="mod-toolbar">
        <span className="count-note">{t('cron.presets')}:</span>
        {PRESETS.map(([e, k]) => (
          <button key={e} className="mini" onClick={() => setExpr(e)}>
            {t(`cron.${k}`)}
          </button>
        ))}
        <span
          className={parsed.error ? '' : 'dep-ok'}
          style={parsed.error ? { color: 'var(--danger)', fontSize: 12.5 } : {}}
        >
          {parsed.error ? `${t('cron.invalid')}: ${parsed.error}` : t('cron.valid')}
        </span>
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cron.fieldsHint')}
      </p>

      {parsed.sets && (
        <>
          <div className="mod-toolbar">
            <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
              {t('cron.upcoming')}
            </h3>
            <span className="count-note">{t('cron.show')}</span>
            <input className="mod-search" type="number" min={1} max={100} style={{ maxWidth: 80 }} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, +e.target.value || 10)))} />
            <button className="mini" disabled={!runs.length} onClick={copy}>
              {t('cron.copyList')}
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="count-note">{t('cron.noRuns')}</p>
          ) : (
            <div className="dt-wrap" style={{ maxHeight: 360 }}>
              <table className="dt">
                <tbody>
                  {runs.map((d, i) => (
                    <tr key={i}>
                      <td style={{ width: 40, color: 'var(--text-tertiary)' }}>{i + 1}</td>
                      <td>
                        <code>{d.toLocaleString()}</code>
                      </td>
                      <td style={{ color: 'var(--text-tertiary)' }}>{relative(d, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
