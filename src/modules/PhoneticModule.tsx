import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge PhoneticService.
type Alphabet = 'nato' | 'police' | 'simple';

const DIGITS: Record<string, string> = {
  '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
  '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Niner',
};
const NATO: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel',
  I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa',
  Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray',
  Y: 'Yankee', Z: 'Zulu',
};
const POLICE: Record<string, string> = {
  A: 'Adam', B: 'Boy', C: 'Charlie', D: 'David', E: 'Edward', F: 'Frank', G: 'George', H: 'Henry',
  I: 'Ida', J: 'John', K: 'King', L: 'Lincoln', M: 'Mary', N: 'Nora', O: 'Ocean', P: 'Paul',
  Q: 'Queen', R: 'Robert', S: 'Sam', T: 'Tom', U: 'Union', V: 'Victor', W: 'William', X: 'X-ray',
  Y: 'Young', Z: 'Zebra',
};
const SIMPLE: Record<string, string> = {
  A: 'Apple', B: 'Banana', C: 'Cat', D: 'Dog', E: 'Egg', F: 'Fish', G: 'Goat', H: 'House',
  I: 'Ice', J: 'Juice', K: 'Kite', L: 'Lion', M: 'Moon', N: 'Nose', O: 'Orange', P: 'Pig',
  Q: 'Queen', R: 'Rabbit', S: 'Sun', T: 'Tree', U: 'Umbrella', V: 'Violin', W: 'Water', X: 'Xylophone',
  Y: 'Yellow', Z: 'Zebra',
};
const tableFor = (a: Alphabet) => (a === 'police' ? POLICE : a === 'simple' ? SIMPLE : NATO);

interface Spelled { character: string; code: string }

function spell(input: string, alphabet: Alphabet, upper: boolean, keepPunct: boolean): { spoken: string; chars: Spelled[] } {
  const chars: Spelled[] = [];
  if (!input) return { spoken: '', chars };
  const table = tableFor(alphabet);
  const spoken: string[] = [];
  for (const raw of input) {
    const shown = upper ? raw.toUpperCase() : raw;
    const key = raw.toUpperCase();
    let code: string | null = null;
    if (key >= 'A' && key <= 'Z' && table[key]) code = table[key]!;
    else if (key >= '0' && key <= '9' && DIGITS[key]) code = DIGITS[key]!;
    else if (raw === ' ') code = '(space)';
    else if (keepPunct) code = raw;
    else continue;
    chars.push({ character: shown, code });
    spoken.push(code);
  }
  return { spoken: spoken.join(' '), chars };
}

export function PhoneticModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('ABC-123');
  const [alphabet, setAlphabet] = useState<Alphabet>('nato');
  const [upper, setUpper] = useState(false);
  const [keepPunct, setKeepPunct] = useState(true);
  const res = useMemo(() => spell(input, alphabet, upper, keepPunct), [input, alphabet, upper, keepPunct]);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="count-note">{t('phonetic.alphabet')}</label>
        <select className="mod-select" value={alphabet} onChange={(e) => setAlphabet(e.target.value as Alphabet)}>
          <option value="nato">NATO / ICAO</option>
          <option value="police">LAPD / Police</option>
          <option value="simple">{t('phonetic.simple')}</option>
        </select>
        <label className="chk"><input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} /> {t('phonetic.upper')}</label>
        <label className="chk"><input type="checkbox" checked={keepPunct} onChange={(e) => setKeepPunct(e.target.checked)} /> {t('phonetic.keepPunct')}</label>
        <button className="mini" disabled={!res.spoken} onClick={() => navigator.clipboard?.writeText(res.spoken)}>{t('phonetic.copy')}</button>
      </div>
      <input className="hosts-edit" style={{ minHeight: 0, height: 38 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('phonetic.placeholder')} />
      <div className="panel" style={{ marginTop: 10 }}>
        <label className="count-note">{t('phonetic.spoken')}</label>
        <p style={{ fontSize: 17, margin: '6px 0 0' }}>{res.spoken || t('phonetic.nothing')}</p>
      </div>
      {res.chars.length > 0 && (
        <div className="dt-wrap" style={{ marginTop: 10 }}>
          <table className="dt">
            <tbody>
              {res.chars.map((c, i) => (
                <tr key={i}><td style={{ width: 60, fontWeight: 600 }}>{c.character === ' ' ? '␣' : c.character}</td><td>{c.code}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
