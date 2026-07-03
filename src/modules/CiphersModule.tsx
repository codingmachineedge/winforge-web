import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Mode = 'rot13' | 'caesar' | 'atbash' | 'vigenere' | 'a1z26' | 'morse';

type Result = { ok: true; text: string } | { ok: false; en: string; zh: string };

function shiftLetter(c: string, shift: number): string {
  const m = (((shift % 26) + 26) % 26);
  const code = c.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(97 + (code - 97 + m) % 26);
  if (code >= 65 && code <= 90) return String.fromCharCode(65 + (code - 65 + m) % 26);
  return c;
}

function caesar(s: string, shift: number): string {
  let out = '';
  for (const c of s) out += shiftLetter(c, shift);
  return out;
}

function atbash(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code >= 97 && code <= 122) out += String.fromCharCode(122 - (code - 97));
    else if (code >= 65 && code <= 90) out += String.fromCharCode(90 - (code - 65));
    else out += c;
  }
  return out;
}

function isLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function vigenere(s: string, key: string, encode: boolean): Result {
  // Build a clean alphabetic key; blank/keyless input is a user error, not a crash.
  let kb = '';
  for (const c of key) {
    if (isLetter(c.charCodeAt(0))) kb += c.toLowerCase();
  }
  if (kb.length === 0) {
    return {
      ok: false,
      en: 'Enter a key made of letters (A–Z) for Vigenère.',
      zh: '維吉尼亞密碼需要一個由英文字母（A–Z）組成嘅密鑰。',
    };
  }
  let out = '';
  let ki = 0;
  for (const c of s) {
    if (isLetter(c.charCodeAt(0))) {
      const shift = kb.charCodeAt(ki % kb.length) - 97;
      out += shiftLetter(c, encode ? shift : -shift);
      ki++;
    } else {
      out += c;
    }
  }
  return { ok: true, text: out };
}

function a1z26(s: string, encode: boolean): Result {
  if (encode) {
    let out = '';
    let prevNum = false;
    for (const c of s) {
      const code = c.charCodeAt(0);
      if (isLetter(code)) {
        if (prevNum) out += '-';
        out += String(c.toLowerCase().charCodeAt(0) - 97 + 1);
        prevNum = true;
      } else {
        out += c;
        prevNum = false;
      }
    }
    return { ok: true, text: out };
  }

  // Decode: numbers 1–26 → letters; runs of digits split on any non-digit separator.
  let out = '';
  let num = '';
  const src = s + '\0';
  for (const c of src) {
    const code = c.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      num += c;
      continue;
    }
    if (num.length > 0) {
      const n = Number(num);
      if (Number.isInteger(n) && n >= 1 && n <= 26) {
        out += String.fromCharCode(97 + n - 1);
      } else {
        return {
          ok: false,
          en: `'${num}' is not a number from 1 to 26.`,
          zh: `「${num}」唔係 1 到 26 之間嘅數字。`,
        };
      }
      num = '';
    }
    // '-' between numbers is a separator; keep spaces and other chars, drop the sentinel.
    if (c === '\0') break;
    if (c !== '-') out += c;
  }
  return { ok: true, text: out };
}

// --- Morse ---
const MORSE_TABLE: [string, string][] = [
  ['a', '.-'], ['b', '-...'], ['c', '-.-.'], ['d', '-..'], ['e', '.'], ['f', '..-.'],
  ['g', '--.'], ['h', '....'], ['i', '..'], ['j', '.---'], ['k', '-.-'], ['l', '.-..'],
  ['m', '--'], ['n', '-.'], ['o', '---'], ['p', '.--.'], ['q', '--.-'], ['r', '.-.'],
  ['s', '...'], ['t', '-'], ['u', '..-'], ['v', '...-'], ['w', '.--'], ['x', '-..-'],
  ['y', '-.--'], ['z', '--..'],
  ['0', '-----'], ['1', '.----'], ['2', '..---'], ['3', '...--'], ['4', '....-'],
  ['5', '.....'], ['6', '-....'], ['7', '--...'], ['8', '---..'], ['9', '----.'],
  ['.', '.-.-.-'], [',', '--..--'], ['?', '..--..'], ["'", '.----.'], ['!', '-.-.--'],
  ['/', '-..-.'], ['(', '-.--.'], [')', '-.--.-'], ['&', '.-...'], [':', '---...'],
  [';', '-.-.-.'], ['=', '-...-'], ['+', '.-.-.'], ['-', '-....-'], ['_', '..--.-'],
  ['"', '.-..-.'], ['@', '.--.-.'],
];

function lookupMorse(c: string): string | null {
  for (const [ch, m] of MORSE_TABLE) if (ch === c) return m;
  return null;
}

function lookupChar(morse: string): string | null {
  for (const [ch, m] of MORSE_TABLE) if (m === morse) return ch;
  return null;
}

function morse(s: string, encode: boolean): Result {
  if (encode) {
    const words = s.split(' ');
    let out = '';
    for (let w = 0; w < words.length; w++) {
      if (w > 0) out += ' / ';
      let letters = '';
      const word = words[w]!;
      for (const c of word) {
        const code = lookupMorse(c.toLowerCase());
        if (code == null) continue; // unknown chars are dropped in Morse
        if (letters.length > 0) letters += ' ';
        letters += code;
      }
      out += letters;
    }
    return { ok: true, text: out.trim() };
  }

  // Decode: '/' separates words, spaces separate letters.
  let out = '';
  const rawWords = s.trim().split('/');
  for (let w = 0; w < rawWords.length; w++) {
    if (w > 0) out += ' ';
    const toks = rawWords[w]!.split(/[ \t\r\n]+/).filter((x) => x.length > 0);
    for (const tok of toks) {
      const ch = lookupChar(tok);
      if (ch == null) {
        return {
          ok: false,
          en: `'${tok}' is not valid Morse code.`,
          zh: `「${tok}」唔係有效嘅摩斯電碼。`,
        };
      }
      out += ch;
    }
  }
  return { ok: true, text: out };
}

function transform(mode: Mode, input: string, encode: boolean, shift: number, key: string): Result {
  try {
    switch (mode) {
      case 'rot13':
        return { ok: true, text: caesar(input, 13) }; // self-inverse
      case 'caesar':
        return { ok: true, text: caesar(input, encode ? shift : -shift) };
      case 'atbash':
        return { ok: true, text: atbash(input) }; // self-inverse
      case 'vigenere':
        return vigenere(input, key, encode);
      case 'a1z26':
        return a1z26(input, encode);
      case 'morse':
        return morse(input, encode);
      default:
        return { ok: true, text: input };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, en: 'Could not process input: ' + msg, zh: '無法處理輸入：' + msg };
  }
}

export function CiphersModule() {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>('rot13');
  const [shift, setShift] = useState(3);
  const [key, setKey] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<string>(t('ciphers.ready'));

  const isZh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const pick = (en: string, zh: string) => (isZh ? zh : en);

  const selfInverse = mode === 'rot13' || mode === 'atbash';

  const run = (encode: boolean) => {
    const r = transform(mode, input, encode, shift, key);
    if (r.ok) {
      setOutput(r.text);
      setStatus(t('ciphers.done'));
    } else {
      setStatus(pick(r.en, r.zh));
    }
  };

  const copy = () => {
    try {
      if (output.length === 0) {
        setStatus(t('ciphers.nothingToCopy'));
        return;
      }
      void navigator.clipboard?.writeText(output);
      setStatus(t('ciphers.copied'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(pick('Copy failed: ' + msg, '複製失敗：' + msg));
    }
  };

  const clear = () => {
    setInput('');
    setOutput('');
    setStatus(t('ciphers.cleared'));
  };

  const onModeChange = (m: Mode) => {
    setMode(m);
    setStatus(t('ciphers.ready'));
  };

  const modes: { id: Mode; key: string }[] = [
    { id: 'rot13', key: 'ciphers.modeRot13' },
    { id: 'caesar', key: 'ciphers.modeCaesar' },
    { id: 'atbash', key: 'ciphers.modeAtbash' },
    { id: 'vigenere', key: 'ciphers.modeVigenere' },
    { id: 'a1z26', key: 'ciphers.modeA1Z26' },
    { id: 'morse', key: 'ciphers.modeMorse' },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('ciphers.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('ciphers.cipher')}</span>
        <select className="mod-select" value={mode} onChange={(e) => onModeChange(e.target.value as Mode)}>
          {modes.map((m) => (
            <option key={m.id} value={m.id}>
              {t(m.key)}
            </option>
          ))}
        </select>

        {mode === 'caesar' && (
          <>
            <span className="count-note">{t('ciphers.shift')}</span>
            <input
              className="mod-search"
              style={{ maxWidth: 90 }}
              type="number"
              min={0}
              max={25}
              value={shift}
              onChange={(e) => {
                const v = Number(e.target.value);
                setShift(Number.isNaN(v) ? 0 : Math.max(0, Math.min(25, v)));
              }}
            />
          </>
        )}
      </div>

      {mode === 'vigenere' && (
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <span className="count-note">{t('ciphers.key')}</span>
          <input className="mod-search" style={{ maxWidth: 260 }} value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
      )}

      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <button className="mini primary" onClick={() => run(true)}>
          {selfInverse ? t('ciphers.transform') : t('ciphers.encode')}
        </button>
        {!selfInverse && (
          <button className="mini" onClick={() => run(false)}>
            {t('ciphers.decode')}
          </button>
        )}
        <button className="mini" onClick={copy}>
          {t('ciphers.copyOutput')}
        </button>
        <button className="mini" onClick={clear}>
          {t('ciphers.clear')}
        </button>
      </div>

      {status && (
        <p className="count-note" style={{ marginTop: 8 }}>
          {status}
        </p>
      )}

      <div className="io-grid" style={{ marginTop: 8 }}>
        <div className="kv-list" style={{ display: 'block' }}>
          <label className="count-note">{t('ciphers.input')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ marginTop: 4, minHeight: 120 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className="kv-list" style={{ display: 'block' }}>
          <label className="count-note">{t('ciphers.output')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ marginTop: 4, minHeight: 120 }}
            readOnly
            value={output}
          />
        </div>
      </div>
    </div>
  );
}
