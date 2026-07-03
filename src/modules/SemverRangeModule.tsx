import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge SemverRangeService (hand-written SemVer 2.0.0 + node-semver ranges).

class SemVer {
  constructor(
    public major: number, public minor: number, public patch: number,
    public prerelease: string[], public build: string, public raw: string,
  ) {}
  get isPrerelease() { return this.prerelease.length > 0; }
  compareTo(o: SemVer): number {
    let c = cmpInt(this.major, o.major); if (c) return c;
    c = cmpInt(this.minor, o.minor); if (c) return c;
    c = cmpInt(this.patch, o.patch); if (c) return c;
    return comparePrerelease(this.prerelease, o.prerelease);
  }
  toString(): string {
    let s = `${this.major}.${this.minor}.${this.patch}`;
    if (this.prerelease.length) s += '-' + this.prerelease.join('.');
    if (this.build.length) s += '+' + this.build;
    return s;
  }
}
const cmpInt = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const isNumericId = (s: string) => s.length > 0 && /^[0-9]+$/.test(s);
const parseLongSafe = (s: string) => (/^[0-9]+$/.test(s) ? Number(s) : 0);

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    const xn = isNumericId(x), yn = isNumericId(y);
    let c: number;
    if (xn && yn) c = cmpInt(parseLongSafe(x), parseLongSafe(y));
    else if (xn) c = -1;
    else if (yn) c = 1;
    else c = x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return cmpInt(a.length, b.length);
}

const isValidPreId = (s: string) => [...s].every((ch) => (/[a-zA-Z0-9]/.test(ch)) || ch === '-');
function tryCorePart(s: string): number | null {
  if (s.length === 0) return null;
  if (s.length > 1 && s[0] === '0') return null;
  if (!/^[0-9]+$/.test(s)) return null;
  return Number(s);
}

function tryParse(input: string): { v?: SemVer; error?: string } {
  if (!input || !input.trim()) return { error: 'Empty version' };
  let s = input.trim();
  if (s.startsWith('=')) s = s.slice(1).trim();
  if (s.length > 0 && (s[0] === 'v' || s[0] === 'V')) s = s.slice(1);
  if (s.length === 0) return { error: 'Empty version' };
  let build = '';
  const plus = s.indexOf('+');
  if (plus >= 0) { build = s.slice(plus + 1); s = s.slice(0, plus); }
  let preStr = '';
  const dash = s.indexOf('-');
  if (dash >= 0) { preStr = s.slice(dash + 1); s = s.slice(0, dash); }
  const core = s.split('.');
  if (core.length !== 3) return { error: 'Expected MAJOR.MINOR.PATCH' };
  const major = tryCorePart(core[0]!); if (major === null) return { error: 'Invalid major' };
  const minor = tryCorePart(core[1]!); if (minor === null) return { error: 'Invalid minor' };
  const patch = tryCorePart(core[2]!); if (patch === null) return { error: 'Invalid patch' };
  const pre: string[] = [];
  if (preStr.length > 0) {
    for (const id of preStr.split('.')) {
      if (id.length === 0) return { error: 'Empty prerelease identifier' };
      if (!isValidPreId(id)) return { error: 'Invalid prerelease identifier' };
      if (isNumericId(id) && id.length > 1 && id[0] === '0') return { error: 'Leading zero in numeric prerelease' };
      pre.push(id);
    }
  }
  return { v: new SemVer(major, minor, patch, pre, build, input.trim()) };
}

type Op = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
interface Comparator { op: Op | null; version: SemVer | null } // null = wildcard "*"
const makeVersion = (ma: number, mi: number, pa: number, pre: string[], build: string, raw: string) =>
  new SemVer(Math.max(0, ma), Math.max(0, mi), Math.max(0, pa), pre, build ?? '', raw);

function matches(c: Comparator, v: SemVer): boolean {
  if (c.op === null || c.version === null) return true;
  const cmp = v.compareTo(c.version);
  switch (c.op) {
    case 'eq': return cmp === 0;
    case 'lt': return cmp < 0;
    case 'lte': return cmp <= 0;
    case 'gt': return cmp > 0;
    case 'gte': return cmp >= 0;
  }
}
function comparatorStr(c: Comparator): string {
  if (c.op === null || c.version === null) return '*';
  const s = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[c.op];
  return s + c.version.toString();
}

const isWild = (s: string) => s === 'x' || s === 'X' || s === '*';
const tryNum = (s: string): number | null => (s.length > 0 && /^[0-9]+$/.test(s) ? Number(s) : null);

interface Partial { wildMajor: boolean; wildMinor: boolean; wildPatch: boolean; core: SemVer | null; error: string | null }
function parsePartial(token: string): Partial {
  let s = token.trim();
  if (s.length > 0 && (s[0] === 'v' || s[0] === 'V')) s = s.slice(1);
  if (s.length === 0) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Empty version' };
  let build = '';
  const plus = s.indexOf('+');
  if (plus >= 0) { build = s.slice(plus + 1); s = s.slice(0, plus); }
  let preStr = '';
  const dash = s.indexOf('-');
  if (dash >= 0) { preStr = s.slice(dash + 1); s = s.slice(0, dash); }
  const parts = s.split('.');
  if (parts.length === 0 || parts.length > 3) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Bad version shape' };
  const wildMajor = isWild(parts[0]!);
  if (wildMajor) return { wildMajor: true, wildMinor: true, wildPatch: true, core: makeVersion(0, 0, 0, [], '', token), error: null };
  const major = tryNum(parts[0]!); if (major === null) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Invalid major' };
  let minor = 0, patch = 0, wildMinor: boolean, wildPatch: boolean;
  if (parts.length >= 2 && !isWild(parts[1]!)) {
    const mn = tryNum(parts[1]!); if (mn === null) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Invalid minor' };
    minor = mn; wildMinor = false;
  } else wildMinor = true;
  if (!wildMinor && parts.length >= 3 && !isWild(parts[2]!)) {
    const pn = tryNum(parts[2]!); if (pn === null) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Invalid patch' };
    patch = pn; wildPatch = false;
  } else wildPatch = true;
  const pre: string[] = [];
  if (preStr.length > 0 && !wildMinor && !wildPatch) {
    for (const id of preStr.split('.')) {
      if (id.length === 0) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Empty prerelease id' };
      if (!isValidPreId(id)) return { wildMajor: false, wildMinor: false, wildPatch: false, core: null, error: 'Invalid prerelease id' };
      pre.push(id);
    }
  }
  return { wildMajor: false, wildMinor, wildPatch, core: makeVersion(major, minor, patch, pre, build, token), error: null };
}

function expandCaret(t: string, out: Comparator[]): string | null {
  const p = parsePartial(t);
  if (p.error) return p.error;
  if (p.wildMajor) { out.push({ op: null, version: null }); return null; }
  const c = p.core!;
  out.push({ op: 'gte', version: makeVersion(c.major, p.wildMinor ? 0 : c.minor, (p.wildMinor || p.wildPatch) ? 0 : c.patch, c.prerelease, c.build, t) });
  let upper: SemVer;
  if (c.major > 0 || p.wildMinor) upper = makeVersion(c.major + 1, 0, 0, [], '', t);
  else if (c.minor > 0 || p.wildPatch) upper = makeVersion(0, c.minor + 1, 0, [], '', t);
  else upper = makeVersion(0, 0, c.patch + 1, [], '', t);
  out.push({ op: 'lt', version: upper });
  return null;
}
function expandTilde(t: string, out: Comparator[]): string | null {
  const p = parsePartial(t);
  if (p.error) return p.error;
  if (p.wildMajor) { out.push({ op: null, version: null }); return null; }
  const c = p.core!;
  out.push({ op: 'gte', version: makeVersion(c.major, p.wildMinor ? 0 : c.minor, (p.wildMinor || p.wildPatch) ? 0 : c.patch, c.prerelease, c.build, t) });
  const upper = p.wildMinor ? makeVersion(c.major + 1, 0, 0, [], '', t) : makeVersion(c.major, c.minor + 1, 0, [], '', t);
  out.push({ op: 'lt', version: upper });
  return null;
}

function tryParseComparator(token: string, out: Comparator[]): string | null {
  let t = token.trim();
  if (t.length === 0) return null;
  let explicitOp: Op | null = null;
  if (t.startsWith('>=')) { explicitOp = 'gte'; t = t.slice(2); }
  else if (t.startsWith('<=')) { explicitOp = 'lte'; t = t.slice(2); }
  else if (t.startsWith('>')) { explicitOp = 'gt'; t = t.slice(1); }
  else if (t.startsWith('<')) { explicitOp = 'lt'; t = t.slice(1); }
  else if (t.startsWith('=')) { explicitOp = 'eq'; t = t.slice(1); }
  t = t.trim();
  if (t.length === 0) return 'Missing version after operator';
  if (t.startsWith('^')) return expandCaret(t.slice(1), out);
  if (t.startsWith('~')) return expandTilde(t.slice(1), out);
  const p = parsePartial(t);
  if (p.error) return p.error;
  const c = p.core!;
  if (explicitOp) {
    out.push({ op: explicitOp, version: makeVersion(c.major, p.wildMinor ? 0 : c.minor, (p.wildMinor || p.wildPatch) ? 0 : c.patch, c.prerelease, c.build, t) });
    return null;
  }
  if (p.wildMajor) { out.push({ op: null, version: null }); return null; }
  if (p.wildMinor) {
    out.push({ op: 'gte', version: makeVersion(c.major, 0, 0, [], '', t) });
    out.push({ op: 'lt', version: makeVersion(c.major + 1, 0, 0, [], '', t) });
    return null;
  }
  if (p.wildPatch) {
    out.push({ op: 'gte', version: makeVersion(c.major, c.minor, 0, [], '', t) });
    out.push({ op: 'lt', version: makeVersion(c.major, c.minor + 1, 0, [], '', t) });
    return null;
  }
  out.push({ op: 'eq', version: c });
  return null;
}

function findHyphen(s: string): number {
  for (let i = 1; i < s.length - 1; i++)
    if (s[i] === '-' && /\s/.test(s[i - 1]!) && /\s/.test(s[i + 1]!)) return i;
  return -1;
}
function tryHyphenBound(token: string, isLower: boolean, out: Comparator[]): string | null {
  const p = parsePartial(token);
  if (p.error) return p.error;
  const c = p.core!;
  if (isLower) {
    out.push({ op: 'gte', version: makeVersion(c.major, p.wildMinor ? 0 : c.minor, (p.wildMinor || p.wildPatch) ? 0 : c.patch, c.prerelease, c.build, token) });
  } else {
    if (p.wildMajor) return null;
    if (p.wildMinor) out.push({ op: 'lt', version: makeVersion(c.major + 1, 0, 0, [], '', token) });
    else if (p.wildPatch) out.push({ op: 'lt', version: makeVersion(c.major, c.minor + 1, 0, [], '', token) });
    else out.push({ op: 'lte', version: c });
  }
  return null;
}
function tryParseComparatorSet(part: string, out: Comparator[]): string | null {
  if (part.length === 0) { out.push({ op: null, version: null }); return null; }
  const hy = findHyphen(part);
  if (hy >= 0) {
    const lo = part.slice(0, hy).trim();
    const hi = part.slice(hy + 1).trim();
    let e = tryHyphenBound(lo, true, out); if (e) return e;
    e = tryHyphenBound(hi, false, out); if (e) return e;
    return null;
  }
  const tokens = part.split(/\s+/).filter((x) => x.length > 0);
  for (const tok of tokens) { const e = tryParseComparator(tok, out); if (e) return e; }
  if (out.length === 0) out.push({ op: null, version: null });
  return null;
}

interface Range { orSets: Comparator[][]; normalized: string }
function tryParseRange(input: string): { range?: Range; error?: string } {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) return { range: { orSets: [[{ op: null, version: null }]], normalized: '*' } };
  const orSets: Comparator[][] = [];
  for (const orPart of trimmed.split('||')) {
    const set: Comparator[] = [];
    const e = tryParseComparatorSet(orPart.trim(), set);
    if (e) return { error: e };
    orSets.push(set);
  }
  const normalized = orSets.map((set) => (set.length === 0 ? '*' : set.map(comparatorStr).join(' '))).join(' || ');
  return { range: { orSets, normalized } };
}
function setMatches(set: Comparator[], v: SemVer): boolean {
  if (set.length === 0) return true;
  for (const c of set) if (!matches(c, v)) return false;
  if (v.isPrerelease) {
    for (const c of set) {
      const cv = c.version;
      if (cv && cv.isPrerelease && cv.major === v.major && cv.minor === v.minor && cv.patch === v.patch) return true;
    }
    return false;
  }
  return true;
}
const satisfies = (r: Range, v: SemVer) => r.orSets.some((set) => setMatches(set, v));

export function SemverRangeModule() {
  const { t } = useTranslation();
  const [rangeText, setRangeText] = useState('^1.2.0 || ~2.3.4');
  const [versions, setVersions] = useState('1.2.0\n1.5.9\n2.0.0\n2.3.4\n2.3.9\n2.4.0\n1.2.0-beta.1');

  const parsedRange = useMemo(() => tryParseRange(rangeText), [rangeText]);
  const rows = useMemo(() => {
    return versions.split('\n').map((line) => line.trim()).filter((l) => l.length > 0).map((line) => {
      const r = tryParse(line);
      if (!r.v) return { input: line, valid: false, satisfies: false, reason: r.error ?? '' };
      const sat = parsedRange.range ? satisfies(parsedRange.range, r.v) : false;
      return { input: line, valid: true, satisfies: sat, reason: r.v.toString() };
    });
  }, [versions, parsedRange]);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note">{t('semver.range')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 36, flex: 1, fontFamily: 'monospace' }} value={rangeText} onChange={(e) => setRangeText(e.target.value)} placeholder="^1.2.0 || ~2.3.4" />
      </div>
      {parsedRange.error ? (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('semver.badRange')}: {parsedRange.error}</p>
      ) : (
        <p className="count-note">{t('semver.normalized')}: <code>{parsedRange.range!.normalized}</code></p>
      )}
      <label className="count-note">{t('semver.versions')}</label>
      <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <textarea className="hosts-edit" spellCheck={false} value={versions} onChange={(e) => setVersions(e.target.value)} placeholder={t('semver.versionsPlaceholder')} style={{ fontFamily: 'monospace' }} />
        <div className="panel" style={{ margin: 0, overflow: 'auto' }}>
          <table className="dt">
            <thead><tr><th>{t('semver.version')}</th><th>{t('semver.status')}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: 'monospace' }}>{r.input}</td>
                  <td className={!r.valid ? '' : r.satisfies ? 'pos' : 'neg'} style={{ color: !r.valid ? 'var(--danger)' : r.satisfies ? 'var(--ok, #3fb950)' : 'var(--text-tertiary)' }}>
                    {!r.valid ? `✗ ${r.reason}` : r.satisfies ? `✓ ${t('semver.matches')}` : `– ${t('semver.noMatch')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
