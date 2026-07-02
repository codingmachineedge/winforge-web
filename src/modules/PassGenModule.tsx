import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';
const AMBIGUOUS = new Set('O0Il1|');

// Compact EFF-style word list for passphrases (~128 words ≈ 7 bits each).
const WORDS =
  'able acid aged also arch army atom aunt aura away back bald band bark barn bath bead beam bean bear beat beer bell belt bend best bike bind bird bite blue boat bold bolt bone book boot born boss both bulk bull bump bunk burn bush cage cake calm camp cane cape card care cart case cash cave cell chat chef chin chip city clan claw clay clip club coal coat code coin cold colt cone cook cool cord core cork corn cost cove crab crew crop cube cult curl dark dart dash date dawn deal deer desk dial dice dime dine dirt dish dock doll dome door dose dove down drag draw drum dual dune dusk dust duty each earn east easy edge'.split(
    ' ',
  );

function secureInt(max: number): number {
  const a = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  let x: number;
  do {
    crypto.getRandomValues(a);
    x = a[0]!;
  } while (x >= limit);
  return x % max;
}
const pick = <T,>(arr: T[] | string): T => (arr as T[])[secureInt(arr.length)] as T;
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function PassGenModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [length, setLength] = useState(20);
  const [sets, setSets] = useState({ lower: true, upper: true, digits: true, symbols: true });
  const [avoidAmbiguous, setAvoidAmbiguous] = useState(true);
  const [noRepeat, setNoRepeat] = useState(false);
  const [wordCount, setWordCount] = useState(5);
  const [separator, setSeparator] = useState('-');
  const [capitalize, setCapitalize] = useState(true);
  const [appendDigit, setAppendDigit] = useState(true);
  const [count, setCount] = useState(5);
  const [output, setOutput] = useState('');
  const [entropy, setEntropy] = useState(0);
  const [error, setError] = useState('');

  const genPassword = (): string => {
    let pool = '';
    if (sets.lower) pool += LOWER;
    if (sets.upper) pool += UPPER;
    if (sets.digits) pool += DIGITS;
    if (sets.symbols) pool += SYMBOLS;
    if (avoidAmbiguous) pool = [...pool].filter((c) => !AMBIGUOUS.has(c)).join('');
    const required = [sets.lower && LOWER, sets.upper && UPPER, sets.digits && DIGITS, sets.symbols && SYMBOLS]
      .filter(Boolean)
      .map((s) => [...(s as string)].filter((c) => !avoidAmbiguous || !AMBIGUOUS.has(c)).join(''));
    if (pool.length === 0) throw new Error(t('passgen.errNoSet'));
    if (length < required.length) throw new Error(t('passgen.errShort'));
    if (noRepeat && pool.length < length) throw new Error(t('passgen.errNoRepeat'));
    const chars: string[] = required.map((s) => pick(s));
    const usable = noRepeat ? [...pool].filter((c) => !chars.includes(c)) : [...pool];
    while (chars.length < length) {
      const idx = secureInt(usable.length);
      const c = usable[idx]!;
      chars.push(c);
      if (noRepeat) usable.splice(idx, 1);
    }
    return shuffle(chars).join('');
  };

  const genPassphrase = (): string => {
    const words: string[] = [];
    for (let i = 0; i < wordCount; i++) {
      let w = pick(WORDS);
      if (capitalize) w = w[0]!.toUpperCase() + w.slice(1);
      words.push(w);
    }
    let out = words.join(separator);
    if (appendDigit) out += separator + secureInt(10);
    return out;
  };

  const generate = () => {
    setError('');
    try {
      const lines: string[] = [];
      for (let i = 0; i < count; i++) lines.push(mode === 'password' ? genPassword() : genPassphrase());
      setOutput(lines.join('\n'));
      // entropy of a single item
      let bits = 0;
      if (mode === 'password') {
        let pool = (sets.lower ? 26 : 0) + (sets.upper ? 26 : 0) + (sets.digits ? 10 : 0) + (sets.symbols ? SYMBOLS.length : 0);
        if (avoidAmbiguous) pool = Math.max(1, pool - 6);
        bits = length * Math.log2(pool || 2);
      } else {
        bits = wordCount * Math.log2(WORDS.length) + (appendDigit ? Math.log2(10) : 0);
      }
      setEntropy(Math.round(bits));
    } catch (e) {
      setOutput('');
      setError(`${t('passgen.cantGen')} ${String(e instanceof Error ? e.message : e)}`);
    }
  };

  const copy = () => void (output && navigator.clipboard?.writeText(output));
  const strength = entropy < 40 ? 'weak' : entropy < 60 ? 'fair' : entropy < 80 ? 'strong' : 'excellent';
  const pct = Math.min(100, (entropy / 100) * 100);

  const chk = (key: keyof typeof sets, label: string) => (
    <label className="chk">
      <input type="checkbox" checked={sets[key]} onChange={(e) => setSets({ ...sets, [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <div className="mod">
      <div className="mod-toolbar">
        {(['password', 'passphrase'] as const).map((m) => (
          <button key={m} className={`mini${mode === m ? ' primary' : ''}`} onClick={() => setMode(m)}>
            {t(`passgen.${m}`)}
          </button>
        ))}
      </div>

      {mode === 'password' ? (
        <div className="panel" style={{ padding: 14 }}>
          <div className="mod-form" style={{ alignItems: 'center' }}>
            <span className="count-note">{t('passgen.length')}</span>
            <input type="range" min={4} max={128} value={length} onChange={(e) => setLength(+e.target.value)} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span className="ct-val">{length}</span>
          </div>
          <div className="mod-toolbar">
            {chk('lower', t('passgen.lower'))}
            {chk('upper', t('passgen.upper'))}
            {chk('digits', t('passgen.digits'))}
            {chk('symbols', t('passgen.symbols'))}
          </div>
          <div className="mod-toolbar">
            <label className="chk">
              <input type="checkbox" checked={avoidAmbiguous} onChange={(e) => setAvoidAmbiguous(e.target.checked)} />
              {t('passgen.avoidAmbiguous')}
            </label>
            <label className="chk">
              <input type="checkbox" checked={noRepeat} onChange={(e) => setNoRepeat(e.target.checked)} />
              {t('passgen.noRepeat')}
            </label>
          </div>
        </div>
      ) : (
        <div className="panel" style={{ padding: 14 }}>
          <div className="mod-form" style={{ alignItems: 'center' }}>
            <span className="count-note">{t('passgen.wordCount')}</span>
            <input type="range" min={3} max={10} value={wordCount} onChange={(e) => setWordCount(+e.target.value)} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span className="ct-val">{wordCount}</span>
          </div>
          <div className="mod-form">
            <span className="count-note">{t('passgen.separator')}</span>
            <input className="mod-search" style={{ maxWidth: 80 }} value={separator} onChange={(e) => setSeparator(e.target.value)} />
            <label className="chk">
              <input type="checkbox" checked={capitalize} onChange={(e) => setCapitalize(e.target.checked)} />
              {t('passgen.capitalize')}
            </label>
            <label className="chk">
              <input type="checkbox" checked={appendDigit} onChange={(e) => setAppendDigit(e.target.checked)} />
              {t('passgen.appendDigit')}
            </label>
          </div>
        </div>
      )}

      <div className="mod-toolbar">
        <span className="count-note">{t('passgen.count')}</span>
        <input className="mod-search" type="number" min={1} max={100} style={{ maxWidth: 80 }} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, +e.target.value || 1)))} />
        <button className="mini primary" onClick={generate}>
          {t('passgen.generate')}
        </button>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('passgen.copy')}
        </button>
      </div>

      {error && <p className="mod-msg" style={{ color: 'var(--danger)' }}>{error}</p>}
      {output && (
        <>
          <div className="usage-bar" style={{ marginBottom: 6 }}>
            <div className={`usage-fill${strength === 'weak' ? ' hot' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('passgen.entropy', { bits: entropy })} · {t(`passgen.${strength}`)}
          </p>
          <textarea className="hosts-edit" spellCheck={false} readOnly value={output} style={{ minHeight: 160 }} />
        </>
      )}
    </div>
  );
}
