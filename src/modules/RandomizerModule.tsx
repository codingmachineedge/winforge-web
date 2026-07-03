import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- Cryptographically strong, unbiased RNG (mirrors RandomNumberGenerator.GetInt32) ----
// Returns an unbiased integer in [0, maxExclusive). Rejection sampling over crypto bytes.
function cryptoInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const range = Math.floor(maxExclusive);
  // Use 32-bit draws; reject the biased tail so the distribution stays uniform.
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  // Bounded loop guard: crypto is available in all target browsers; fall back safely.
  for (let attempt = 0; attempt < 10000; attempt++) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      buf[0] = Math.floor(Math.random() * 0x100000000) >>> 0;
    }
    const v = buf[0]!;
    if (v < limit) return v % range;
  }
  // Extremely unlikely fallback.
  return (buf[0]! % range) >>> 0;
}

/** Unbiased integer in [minInclusive, maxInclusive]. */
function nextInt(minInclusive: number, maxInclusive: number): number {
  let lo = minInclusive;
  let hi = maxInclusive;
  if (hi < lo) [lo, hi] = [hi, lo];
  const span = hi - lo + 1;
  if (span <= 1) return lo;
  return lo + cryptoInt(Math.min(span, 0x7fffffff));
}

/** Generate count integers in [min,max]; when unique, no value repeats. */
function integers(min: number, max: number, count: number, unique: boolean): number[] {
  let lo = min;
  let hi = max;
  if (hi < lo) [lo, hi] = [hi, lo];
  const result: number[] = [];
  if (count <= 0) return result;
  const span = hi - lo + 1;
  if (unique && span >= count) {
    // Partial Fisher–Yates over virtual [lo..hi] via a swap map.
    const swap = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const j = i + cryptoInt(Math.min(span - i, 0x7fffffff));
      const vi = swap.has(i) ? swap.get(i)! : i;
      const vj = swap.has(j) ? swap.get(j)! : j;
      result.push(lo + vj);
      swap.set(j, vi);
    }
  } else {
    for (let i = 0; i < count; i++) result.push(nextInt(lo, hi));
  }
  return result;
}

/** Fair coin flip. true = heads. */
function coinFlip(): boolean {
  return cryptoInt(2) === 0;
}

interface DiceResult {
  ok: boolean;
  error?: 'empty' | 'bad';
  count: number;
  sides: number;
  modifier: number;
  rolls: number[];
  total: number;
}

/** Parse and roll dice notation like "2d6", "1d20+3", "4d8-2", "d20". */
function rollDice(spec: string): DiceResult {
  const r: DiceResult = { ok: false, count: 0, sides: 0, modifier: 0, rolls: [], total: 0 };
  if (!spec || spec.trim().length === 0) {
    r.error = 'empty';
    return r;
  }
  const s = spec.trim().toLowerCase().replace(/ /g, '');
  const dIdx = s.indexOf('d');
  if (dIdx < 0) {
    r.error = 'bad';
    return r;
  }
  const countPart = s.substring(0, dIdx);
  const rest = s.substring(dIdx + 1);
  if (rest.length === 0) {
    r.error = 'bad';
    return r;
  }
  let count = 1;
  if (countPart.length > 0) {
    if (!/^-?\d+$/.test(countPart)) {
      r.error = 'bad';
      return r;
    }
    count = parseInt(countPart, 10);
  }
  let modifier = 0;
  let sidesPart = rest;
  const signIdx = ((): number => {
    const p = rest.indexOf('+');
    const m = rest.indexOf('-');
    if (p < 0) return m;
    if (m < 0) return p;
    return Math.min(p, m);
  })();
  if (signIdx >= 0) {
    sidesPart = rest.substring(0, signIdx);
    const modPart = rest.substring(signIdx);
    if (!/^[+-]\d+$/.test(modPart)) {
      r.error = 'bad';
      return r;
    }
    modifier = parseInt(modPart, 10);
  }
  if (!/^\d+$/.test(sidesPart)) {
    r.error = 'bad';
    return r;
  }
  const sides = parseInt(sidesPart, 10);
  if (count <= 0 || count > 1000 || sides <= 0 || sides > 1_000_000) {
    r.error = 'bad';
    return r;
  }
  r.ok = true;
  r.count = count;
  r.sides = sides;
  r.modifier = modifier;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const roll = nextInt(1, sides);
    r.rolls.push(roll);
    total += roll;
  }
  r.total = total + modifier;
  return r;
}

/** Pick one item (unbiased). Returns null if empty. */
function pickOne(items: string[]): string | null {
  if (items.length === 0) return null;
  return items[cryptoInt(items.length)]!;
}

/** Fisher–Yates shuffle (unbiased) — returns a new shuffled copy. */
function shuffle(items: string[]): string[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoInt(i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Split multiline text into trimmed, non-empty lines. */
function splitLines(text: string): string[] {
  const list: string[] = [];
  if (!text || text.trim().length === 0) return list;
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const t = raw.trim();
    if (t.length > 0) list.push(t);
  }
  return list;
}

const joinInts = (values: number[]) => values.join(', ');

export function RandomizerModule() {
  const { t } = useTranslation();

  // Random integers
  const [intMin, setIntMin] = useState(1);
  const [intMax, setIntMax] = useState(100);
  const [intCount, setIntCount] = useState(5);
  const [intUnique, setIntUnique] = useState(false);
  const [intResult, setIntResult] = useState('');

  // Coin
  const [heads, setHeads] = useState(0);
  const [tails, setTails] = useState(0);
  const [coinResult, setCoinResult] = useState('');

  // Dice
  const [diceSpec, setDiceSpec] = useState('2d6');
  const [diceResult, setDiceResult] = useState('');

  // List
  const [listInput, setListInput] = useState('Alice\nBob\nCarol\nDave');
  const [listResult, setListResult] = useState('');

  const [status, setStatus] = useState(() => t('randomizer.ready'));

  const copy = (text: string) => {
    if (!text) return;
    try {
      navigator.clipboard?.writeText(text);
      setStatus(t('randomizer.copied'));
    } catch {
      /* clipboard may be busy; ignore */
    }
  };

  const genIntegers = () => {
    try {
      let min = Number.isFinite(intMin) ? Math.trunc(intMin) : 0;
      let max = Number.isFinite(intMax) ? Math.trunc(intMax) : 0;
      const count = Number.isFinite(intCount) ? Math.trunc(intCount) : 1;
      if (count <= 0) {
        setStatus(t('randomizer.countMin'));
        return;
      }
      if (min > max) [min, max] = [max, min];
      const span = max - min + 1;
      if (intUnique && count > span) {
        setStatus(t('randomizer.notEnoughUnique'));
        return;
      }
      const values = integers(min, max, count, intUnique);
      setIntResult(joinInts(values));
      setStatus(t('randomizer.generated', { count: values.length }));
    } catch {
      setStatus(t('randomizer.intFailed'));
    }
  };

  const flip = () => {
    try {
      const isHeads = coinFlip();
      if (isHeads) setHeads((h) => h + 1);
      else setTails((tl) => tl + 1);
      setCoinResult(isHeads ? t('randomizer.headsFace') : t('randomizer.tailsFace'));
    } catch {
      setStatus(t('randomizer.coinFailed'));
    }
  };

  const resetTally = () => {
    setHeads(0);
    setTails(0);
    setCoinResult('');
  };

  const roll = () => {
    try {
      const r = rollDice(diceSpec);
      if (!r.ok) {
        setDiceResult('');
        if (r.error === 'empty') setStatus(t('randomizer.diceEmpty'));
        else setStatus(t('randomizer.diceBad'));
        return;
      }
      const rolls = joinInts(r.rolls);
      const mod = r.modifier === 0 ? '' : r.modifier > 0 ? ` + ${r.modifier}` : ` - ${Math.abs(r.modifier)}`;
      setDiceResult(t('randomizer.diceOut', { rolls, mod, total: r.total }));
      setStatus(t('randomizer.rolled', { count: r.count, sides: r.sides }));
    } catch {
      setStatus(t('randomizer.diceFailed'));
    }
  };

  const pick = () => {
    try {
      const items = splitLines(listInput);
      if (items.length === 0) {
        setStatus(t('randomizer.addItem'));
        return;
      }
      const p = pickOne(items);
      setListResult(p ?? '');
      setStatus(t('randomizer.picked', { count: items.length }));
    } catch {
      setStatus(t('randomizer.pickFailed'));
    }
  };

  const shuffleAll = () => {
    try {
      const items = splitLines(listInput);
      if (items.length === 0) {
        setStatus(t('randomizer.addItem'));
        return;
      }
      const shuffled = shuffle(items);
      setListResult(shuffled.join('\n'));
      setStatus(t('randomizer.shuffled', { count: shuffled.length }));
    } catch {
      setStatus(t('randomizer.shuffleFailed'));
    }
  };

  const total = heads + tails;

  return (
    <div className="mod">
      <p className="count-note">{t('randomizer.blurb')}</p>

      {/* Random integers */}
      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('randomizer.intTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note">{t('randomizer.min')}</label>
          <input
            className="mod-search"
            type="number"
            style={{ maxWidth: 90 }}
            value={intMin}
            onChange={(e) => setIntMin(Math.trunc(+e.target.value || 0))}
          />
          <label className="count-note">{t('randomizer.max')}</label>
          <input
            className="mod-search"
            type="number"
            style={{ maxWidth: 90 }}
            value={intMax}
            onChange={(e) => setIntMax(Math.trunc(+e.target.value || 0))}
          />
          <label className="count-note">{t('randomizer.count')}</label>
          <input
            className="mod-search"
            type="number"
            min={1}
            style={{ maxWidth: 80 }}
            value={intCount}
            onChange={(e) => setIntCount(Math.max(1, Math.trunc(+e.target.value || 1)))}
          />
          <label className="chk">
            <input type="checkbox" checked={intUnique} onChange={(e) => setIntUnique(e.target.checked)} />{' '}
            {t('randomizer.noDupes')}
          </label>
          <button className="mini primary" onClick={genIntegers}>
            {t('randomizer.generate')}
          </button>
          <button className="mini" disabled={!intResult} onClick={() => copy(intResult)}>
            {t('randomizer.copy')}
          </button>
        </div>
        {intResult && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={intResult}
            style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 60 }}
          />
        )}
      </div>

      {/* Coin flip */}
      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('randomizer.coinTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" onClick={flip}>
            {t('randomizer.flip')}
          </button>
          <button className="mini" onClick={resetTally}>
            {t('randomizer.resetTally')}
          </button>
          {coinResult && <span className="value" style={{ fontWeight: 600 }}>{coinResult}</span>}
        </div>
        <p className="count-note" style={{ marginTop: 8 }}>
          {t('randomizer.tally', { heads, tails, total })}
        </p>
      </div>

      {/* Dice roller */}
      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('randomizer.diceTitle')}</h4>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="hosts-edit"
            style={{ minHeight: 0, height: 34, maxWidth: 160, fontFamily: 'monospace' }}
            value={diceSpec}
            onChange={(e) => setDiceSpec(e.target.value)}
            placeholder="2d6"
          />
          <button className="mini primary" onClick={roll}>
            {t('randomizer.roll')}
          </button>
        </div>
        {diceResult && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={diceResult}
            style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 60 }}
          />
        )}
      </div>

      {/* List picker */}
      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('randomizer.listTitle')}</h4>
        <p className="count-note">{t('randomizer.listHint')}</p>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={listInput}
          onChange={(e) => setListInput(e.target.value)}
          style={{ minHeight: 100 }}
        />
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <button className="mini primary" onClick={pick}>
            {t('randomizer.pickOne')}
          </button>
          <button className="mini" onClick={shuffleAll}>
            {t('randomizer.shuffleAll')}
          </button>
          <button className="mini" disabled={!listResult} onClick={() => copy(listResult)}>
            {t('randomizer.copy')}
          </button>
        </div>
        {listResult && (
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={listResult}
            style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 80 }}
          />
        )}
      </div>

      <p className="count-note">{status}</p>
    </div>
  );
}
