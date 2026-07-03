import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Colours mirror WinForge's HeaderScoreService badge palette.
const GREEN = '#2EA043';
const AMBER = '#D9A400';
const RED = '#D13438';
const GREY = '#8A8A8A';

type NoteKey = string; // t('headerscore.<key>')

interface GradeOut {
  frac: number;
  note: NoteKey;
  advice: NoteKey;
}

interface Spec {
  name: string;
  weight: number;
  grade: (v: string | null) => GradeOut;
}

interface Row {
  header: string;
  status: string; // localized (Present / Missing / Weak / Risky)
  value: string;
  note: NoteKey;
  advice: NoteKey;
  badgeHex: string;
}

interface Result {
  grade: string;
  gradeHex: string;
  score: number;
  summary: string; // localized, already substituted
  rows: Row[];
  parsedAny: boolean;
}

// ---- parsing helpers (ported 1:1 from HeaderScoreService) ----

function parseHeaders(raw: string): Map<string, string> {
  // case-insensitive, last-wins. Key stored lowercased; we keep display name separately at lookup.
  const map = new Map<string, string>();
  if (!raw || !raw.trim()) return map;
  try {
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (line.length === 0) continue;
      // Skip an HTTP status line like "HTTP/2 200" or "HTTP/1.1 200 OK"
      if (line.toUpperCase().startsWith('HTTP/') && !line.includes(': ')) continue;
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const name = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      if (name.length === 0) continue;
      map.set(name.toLowerCase(), value); // last wins
    }
  } catch {
    /* never throw */
  }
  return map;
}

function maxAge(v: string): number {
  try {
    for (const part of v.split(';')) {
      const p = part.trim();
      const eq = p.indexOf('=');
      if (eq > 0 && p.substring(0, eq).trim().toLowerCase() === 'max-age') {
        const num = p
          .substring(eq + 1)
          .trim()
          .replace(/"/g, '');
        const age = Number.parseInt(num, 10);
        if (Number.isFinite(age) && /^\d+$/.test(num)) return age;
      }
    }
  } catch {
    /* ignore */
  }
  return 0;
}

const has = (v: string, token: string): boolean => v.toLowerCase().includes(token);

function trunc(s: string): string {
  const t = (s ?? '').trim();
  if (t.length <= 120) return t;
  return t.substring(0, 117) + '…';
}

// ---- spec table (ported 1:1) ----

function buildSpecs(): Spec[] {
  return [
    {
      name: 'Strict-Transport-Security',
      weight: 20,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'hstsMissNote', advice: 'hstsMissFix' };
        const age = maxAge(v);
        const sub = has(v, 'includesubdomains');
        const pre = has(v, 'preload');
        if (age >= 31536000 && sub && pre) return { frac: 1.0, note: 'hstsStrongNote', advice: 'hstsStrongFix' };
        if (age >= 31536000 && sub) return { frac: 0.85, note: 'hstsGoodNote', advice: 'hstsGoodFix' };
        if (age >= 15768000) return { frac: 0.6, note: 'hstsShortNote', advice: 'hstsShortFix' };
        return { frac: 0.3, note: 'hstsVeryShortNote', advice: 'hstsVeryShortFix' };
      },
    },
    {
      name: 'Content-Security-Policy',
      weight: 22,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'cspMissNote', advice: 'cspMissFix' };
        const low = v.toLowerCase();
        const wildcard = low.includes('default-src *') || low.includes('script-src *');
        const unsafeInline = low.includes("'unsafe-inline'");
        const unsafeEval = low.includes("'unsafe-eval'");
        const hasDefault = low.includes('default-src');
        if (wildcard) return { frac: 0.35, note: 'cspWildNote', advice: 'cspWildFix' };
        if (unsafeInline || unsafeEval) return { frac: 0.6, note: 'cspUnsafeNote', advice: 'cspUnsafeFix' };
        if (hasDefault) return { frac: 1.0, note: 'cspSolidNote', advice: 'cspSolidFix' };
        return { frac: 0.75, note: 'cspNoDefaultNote', advice: 'cspNoDefaultFix' };
      },
    },
    {
      name: 'X-Content-Type-Options',
      weight: 10,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'xctoMissNote', advice: 'xctoMissFix' };
        if (v.trim().toLowerCase() === 'nosniff') return { frac: 1.0, note: 'xctoOkNote', advice: 'xctoOkFix' };
        return { frac: 0.4, note: 'xctoBadNote', advice: 'xctoBadFix' };
      },
    },
    {
      name: 'X-Frame-Options',
      weight: 10,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'xfoMissNote', advice: 'xfoMissFix' };
        const t = v.trim().toUpperCase();
        if (t === 'DENY') return { frac: 1.0, note: 'xfoDenyNote', advice: 'xfoDenyFix' };
        if (t === 'SAMEORIGIN') return { frac: 0.9, note: 'xfoSameNote', advice: 'xfoSameFix' };
        return { frac: 0.4, note: 'xfoOtherNote', advice: 'xfoOtherFix' };
      },
    },
    {
      name: 'Referrer-Policy',
      weight: 8,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'refMissNote', advice: 'refMissFix' };
        const low = v.toLowerCase();
        if (low.includes('no-referrer') || low.includes('strict-origin')) return { frac: 1.0, note: 'refGoodNote', advice: 'refGoodFix' };
        if (low.includes('origin') || low.includes('same-origin')) return { frac: 0.75, note: 'refOkNote', advice: 'refOkFix' };
        if (low.includes('unsafe-url')) return { frac: 0.2, note: 'refUnsafeNote', advice: 'refUnsafeFix' };
        return { frac: 0.6, note: 'refOtherNote', advice: 'refOtherFix' };
      },
    },
    {
      name: 'Permissions-Policy',
      weight: 8,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'permMissNote', advice: 'permMissFix' };
        return { frac: 1.0, note: 'permOkNote', advice: 'permOkFix' };
      },
    },
    {
      name: 'Cross-Origin-Opener-Policy',
      weight: 6,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'coopMissNote', advice: 'coopMissFix' };
        const low = v.toLowerCase();
        if (low.includes('same-origin') && !low.includes('allow-popups')) return { frac: 1.0, note: 'coopStrongNote', advice: 'coopStrongFix' };
        if (low.includes('same-origin-allow-popups')) return { frac: 0.75, note: 'coopPopupNote', advice: 'coopPopupFix' };
        return { frac: 0.5, note: 'coopWeakNote', advice: 'coopWeakFix' };
      },
    },
    {
      name: 'Cross-Origin-Embedder-Policy',
      weight: 6,
      grade: (v) => {
        if (v === null) return { frac: 0, note: 'coepMissNote', advice: 'coepMissFix' };
        const low = v.toLowerCase();
        if (low.includes('require-corp') || low.includes('credentialless')) return { frac: 1.0, note: 'coepOkNote', advice: 'coepOkFix' };
        return { frac: 0.5, note: 'coepBadNote', advice: 'coepBadFix' };
      },
    },
  ];
}

// Risky / disclosure headers: absence is good (full marks), presence loses the weight.
const RISKY: { name: string; note: NoteKey; advice: NoteKey }[] = [
  { name: 'Server', note: 'riskServerNote', advice: 'riskServerFix' },
  { name: 'X-Powered-By', note: 'riskPoweredNote', advice: 'riskPoweredFix' },
  { name: 'X-AspNet-Version', note: 'riskAspNetNote', advice: 'riskAspNetFix' },
  { name: 'X-AspNetMvc-Version', note: 'riskMvcNote', advice: 'riskMvcFix' },
];

function letter(pct: number): [string, string] {
  if (pct >= 97) return ['A+', GREEN];
  if (pct >= 90) return ['A', GREEN];
  if (pct >= 80) return ['B', '#57A639'];
  if (pct >= 70) return ['C', AMBER];
  if (pct >= 60) return ['D', '#E07B00'];
  return ['F', RED];
}

// ---- analysis ----

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function analyze(raw: string, t: TFn): Result {
  const result: Result = { grade: 'F', gradeHex: RED, score: 0, summary: '', rows: [], parsedAny: false };
  try {
    const map = parseHeaders(raw);
    result.parsedAny = map.size > 0;

    const specs = buildSpecs();
    let got = 0;
    let max = 0;

    for (const s of specs) {
      max += s.weight;
      const val = map.has(s.name.toLowerCase()) ? map.get(s.name.toLowerCase())! : null;
      const present = val !== null;
      const g = s.grade(val);
      let frac = g.frac;
      if (frac < 0) frac = 0;
      if (frac > 1) frac = 1;
      got += s.weight * frac;

      let status: string;
      let hex: string;
      if (!present) {
        status = t('headerscore.stMissing');
        hex = RED;
      } else if (frac >= 0.999) {
        status = t('headerscore.stPresent');
        hex = GREEN;
      } else {
        status = t('headerscore.stWeak');
        hex = AMBER;
      }

      result.rows.push({
        header: s.name,
        status,
        value: present ? trunc(val) : '—',
        note: g.note,
        advice: g.advice,
        badgeHex: hex,
      });
    }

    // Risky headers
    const riskyWeight = 4.0;
    for (const rk of RISKY) {
      max += riskyWeight;
      const present = map.has(rk.name.toLowerCase());
      if (!present) {
        got += riskyWeight; // good: header absent
        continue;
      }
      result.rows.push({
        header: rk.name,
        status: t('headerscore.stRisky'),
        value: trunc(map.get(rk.name.toLowerCase()) ?? ''),
        note: rk.note,
        advice: rk.advice,
        badgeHex: AMBER,
      });
    }

    if (max <= 0) max = 1;
    let pct = Math.round((got / max) * 100.0);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    result.score = pct;

    const [grade, gradeHex] = letter(pct);
    result.grade = grade;
    result.gradeHex = gradeHex;

    if (!result.parsedAny) result.summary = t('headerscore.sumEmpty');
    else result.summary = t('headerscore.sumOk', { pct, grade });
  } catch {
    result.grade = '?';
    result.gradeHex = GREY;
    result.summary = t('headerscore.analyzeFail');
  }
  return result;
}

function buildReport(r: Result, t: TFn): string {
  const lines: string[] = [];
  try {
    lines.push(t('headerscore.repTitle'));
    lines.push('========================================');
    lines.push(t('headerscore.repGradeScore', { grade: r.grade, score: r.score }));
    lines.push(r.summary);
    lines.push('');
    for (const row of r.rows) {
      lines.push(`[${row.status}] ${row.header}`);
      lines.push(`    ${t('headerscore.repValue')}: ${row.value}`);
      const note = row.note ? t('headerscore.' + row.note) : '';
      const advice = row.advice ? t('headerscore.' + row.advice) : '';
      if (note) lines.push(`    ${t('headerscore.repNote')}: ${note}`);
      if (advice) lines.push(`    ${t('headerscore.repFix')}: ${advice}`);
      lines.push('');
    }
    lines.push(t('headerscore.repFooter'));
  } catch {
    /* never throw */
  }
  return lines.join('\n');
}

const SAMPLE =
  'HTTP/2 200\n' +
  'server: nginx/1.24.0\n' +
  'content-type: text/html; charset=UTF-8\n' +
  'strict-transport-security: max-age=63072000; includeSubDomains; preload\n' +
  "content-security-policy: default-src 'self'; script-src 'self'\n" +
  'x-content-type-options: nosniff\n' +
  'x-frame-options: SAMEORIGIN\n' +
  'referrer-policy: strict-origin-when-cross-origin\n' +
  'x-powered-by: PHP/8.1.2\n';

export function HeaderScoreModule() {
  const { t } = useTranslation();
  const tf = t as unknown as TFn;
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [copyMsg, setCopyMsg] = useState('');

  const doAnalyze = () => {
    try {
      const r = analyze(input, tf);
      setResult(r);
      setCopyMsg('');
    } catch {
      setResult({ grade: '?', gradeHex: GREY, score: 0, summary: t('headerscore.analyzeFail'), rows: [], parsedAny: false });
    }
  };

  const doCopy = () => {
    if (!result) return;
    try {
      void navigator.clipboard?.writeText(buildReport(result, tf));
      setCopyMsg(t('headerscore.copied'));
    } catch {
      setCopyMsg(t('headerscore.copyFailed'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('headerscore.blurb')}
      </p>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
        {t('headerscore.inputLabel')}
      </label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ minHeight: 150, width: '100%', fontFamily: 'Consolas, monospace' }}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('headerscore.placeholder')}
      />

      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini primary" onClick={doAnalyze}>
          {t('headerscore.analyze')}
        </button>
        <button className="mini" onClick={() => setInput(SAMPLE)}>
          {t('headerscore.loadSample')}
        </button>
        <button className="mini" disabled={!result || !result.parsedAny} onClick={doCopy}>
          {t('headerscore.copyReport')}
        </button>
        {copyMsg && <span className="count-note">{copyMsg}</span>}
      </div>

      {result && (
        <div style={{ marginTop: 16, border: '1px solid var(--border, #333)', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 14 }}>
            <div
              style={{
                width: 76,
                height: 76,
                borderRadius: 10,
                background: result.gradeHex,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto',
              }}
            >
              <span style={{ fontSize: 34, fontWeight: 700, color: '#fff' }}>{result.grade}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{t('headerscore.scoreLine', { score: result.score })}</div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--track, #2a2a2a)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${result.score}%`, background: result.gradeHex }} />
              </div>
              <div className="count-note" style={{ marginTop: 6 }}>
                {result.summary}
              </div>
            </div>
          </div>

          <div className="kv-list" style={{ maxHeight: 520, overflowY: 'auto' }}>
            {result.rows.map((row) => (
              <div key={row.header} className="kv-row" style={{ alignItems: 'flex-start', gap: 12, padding: '8px 6px' }}>
                <span
                  style={{
                    background: row.badgeHex,
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: 4,
                    padding: '3px 8px',
                    minWidth: 64,
                    textAlign: 'center',
                    flex: '0 0 auto',
                  }}
                >
                  {row.status}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{row.header}</div>
                  <div style={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: 'var(--text-secondary, #999)', wordBreak: 'break-word' }}>{row.value}</div>
                  {row.note && <div style={{ fontSize: 12 }}>{t('headerscore.' + row.note)}</div>}
                  {row.advice && <div style={{ fontSize: 12, color: 'var(--text-secondary, #999)' }}>{t('headerscore.' + row.advice)}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
