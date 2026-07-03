import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// International Morse (ITU) — letters, digits, common punctuation/prosigns.
const MAP: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.',
  F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---',
  P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--',
  Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.',
  '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.',
  $: '...-..-', '@': '.--.-.',
};

const REVERSE: Record<string, string> = (() => {
  const d: Record<string, string> = {};
  for (const [k, v] of Object.entries(MAP)) d[v] = k;
  return d;
})();

// Separator presets (letter / word). Mirrors WinForge SepPresets.
const SEP_PRESETS: readonly (readonly [string, string])[] = [
  [' ', ' / '], // space / slash
  [' ', '   '], // space / triple-space
  ['  ', ' / '], // double-space / slash
];

function toMorse(text: string, letterSep: string, wordSep: string): { morse: string; unknown: string[] } {
  const unknown: string[] = [];
  if (!text) return { morse: '', unknown };
  const l = letterSep || ' ';
  const w = wordSep || ' / ';
  const words = text.split(/[ \t\r\n]+/).filter((x) => x.length > 0);
  const out: string[] = [];
  for (const word of words) {
    const letters: string[] = [];
    for (const raw of word) {
      const c = raw.toUpperCase();
      const code = MAP[c];
      if (code !== undefined) letters.push(code);
      else {
        if (!unknown.includes(raw)) unknown.push(raw);
        letters.push('#');
      }
    }
    out.push(letters.join(l));
  }
  return { morse: out.join(w), unknown };
}

function fromMorse(morse: string): string {
  if (!morse || !morse.trim()) return '';
  // Normalise unicode dot/dash variants to '.' and '-'.
  let norm = '';
  for (const ch of morse) {
    switch (ch) {
      case '·': // ·
      case '•': // •
      case '.':
        norm += '.';
        break;
      case '–': // –
      case '—': // —
      case '_':
      case '-':
        norm += '-';
        break;
      case '|':
        norm += '/';
        break;
      default:
        norm += ch;
    }
  }
  // Word boundaries: '/' first.
  const words = norm.split('/');
  const parts: string[] = [];
  let firstWord = true;
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed.length === 0) continue;
    if (!firstWord) parts.push(' ');
    firstWord = false;
    const letters = trimmed.split(/[ \t]+/).filter((x) => x.length > 0);
    let seg = '';
    for (const token of letters) {
      if (token === '#') {
        seg += '#';
        continue;
      }
      const c = REVERSE[token];
      seg += c !== undefined ? c : '�'; // replacement char
    }
    parts.push(seg);
  }
  return parts.join('');
}

// A single on/off flash segment. on = lit; units = duration in Morse units.
interface Flash {
  on: boolean;
  units: number;
}

// Expand text into a flash timeline (dot=1, dash=3, intra-char=1, letter=3, word=7).
function buildTimeline(text: string): Flash[] {
  const list: Flash[] = [];
  if (!text) return list;
  const words = text.split(/[ \t\r\n]+/).filter((x) => x.length > 0);
  for (let wi = 0; wi < words.length; wi++) {
    if (wi > 0) list.push({ on: false, units: 7 }); // word gap
    let firstLetter = true;
    const word = words[wi]!;
    for (const raw of word) {
      const c = raw.toUpperCase();
      const code = MAP[c];
      if (code === undefined) continue;
      if (!firstLetter) list.push({ on: false, units: 3 }); // letter gap
      firstLetter = false;
      for (let i = 0; i < code.length; i++) {
        if (i > 0) list.push({ on: false, units: 1 }); // intra-char gap
        list.push({ on: true, units: code[i] === '-' ? 3 : 1 });
      }
    }
  }
  return list;
}

// PARIS standard: 1 unit = 1200 / WPM ms.
function unitMsForWpm(wpm: number): number {
  let w = wpm;
  if (Number.isNaN(w) || w < 1) w = 1;
  if (w > 60) w = 60;
  return 1200 / w;
}

export function MorseModule() {
  const { t } = useTranslation();
  const [toText, setToText] = useState(false); // false = Text→Morse, true = Morse→Text
  const [sepIdx, setSepIdx] = useState(0);
  const [input, setInput] = useState('HELLO WORLD');
  const [wpm, setWpm] = useState(15);
  const [msg, setMsg] = useState('');
  const [lampOn, setLampOn] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [flashStatus, setFlashStatus] = useState(() => '');

  const timerRef = useRef<number | null>(null);

  // Compute output + unknowns + timeline in one pass.
  const { output, unknownNote, timeline } = useMemo(() => {
    if (toText) {
      const text = fromMorse(input);
      const hasUnknown = text.includes('�') || text.includes('#');
      return {
        output: text,
        unknownNote: hasUnknown ? t('morse.unknownDecode') : '',
        timeline: buildTimeline(text),
      };
    }
    const sep = SEP_PRESETS[sepIdx] ?? SEP_PRESETS[0]!;
    const { morse, unknown } = toMorse(input, sep[0], sep[1]);
    let note = '';
    if (unknown.length > 0) {
      const list = unknown.map((c) => (c === ' ' ? '␠' : c)).join(' ');
      note = t('morse.unknownEncode', { list });
    }
    return { output: morse, unknownNote: note, timeline: buildTimeline(input) };
  }, [toText, sepIdx, input, t]);

  const stopFlash = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLampOn(false);
    setFlashing(false);
  };

  // Cleanup on unmount.
  useEffect(() => () => stopFlash(), []);

  const play = () => {
    stopFlash();
    if (timeline.length === 0) {
      setFlashStatus(t('morse.nothingFlash'));
      setLampOn(false);
      return;
    }
    const unitMs = unitMsForWpm(wpm);
    setFlashing(true);
    setFlashStatus(t('morse.flashing'));
    let idx = -1;
    const tick = () => {
      idx++;
      if (idx >= timeline.length) {
        stopFlash();
        setFlashStatus(t('morse.done'));
        return;
      }
      const f = timeline[idx]!;
      setLampOn(f.on);
      timerRef.current = window.setTimeout(tick, Math.max(1, f.units * unitMs));
    };
    timerRef.current = window.setTimeout(tick, 1); // kick immediately
  };

  const stop = () => {
    stopFlash();
    setFlashStatus(t('morse.stopped'));
  };

  const copy = () => {
    if (!output) {
      setMsg(t('morse.nothingCopy'));
      return;
    }
    void navigator.clipboard?.writeText(output);
    setMsg(t('morse.copied'));
  };

  const idleStatus = flashStatus || t('morse.idle');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('morse.blurb')}
      </p>

      {/* Direction toggle */}
      <div className="mod-toolbar">
        <span className="count-note">{t('morse.direction')}</span>
        <button
          className={toText ? 'mini' : 'mini primary'}
          onClick={() => {
            stopFlash();
            setFlashStatus('');
            setToText(false);
          }}
        >
          {t('morse.text2morse')}
        </button>
        <button
          className={toText ? 'mini primary' : 'mini'}
          onClick={() => {
            stopFlash();
            setFlashStatus('');
            setToText(true);
          }}
        >
          {t('morse.morse2text')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {toText ? t('morse.subDecode') : t('morse.subEncode')}
      </p>

      {/* Separators — only meaningful when encoding */}
      <div className="mod-toolbar" style={{ opacity: toText ? 0.4 : 1 }}>
        <span className="count-note">{t('morse.separators')}</span>
        <select
          className="mod-select"
          disabled={toText}
          value={sepIdx}
          onChange={(e) => setSepIdx(Number(e.target.value))}
        >
          <option value={0}>{t('morse.sep0')}</option>
          <option value={1}>{t('morse.sep1')}</option>
          <option value={2}>{t('morse.sep2')}</option>
        </select>
        <button className="mini" disabled={!output} onClick={copy}>
          {t('morse.copy')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setMsg('');
          }}
          placeholder={toText ? t('morse.phDecode') : t('morse.phEncode')}
        />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('morse.outputPlaceholder')} />
      </div>

      {unknownNote && (
        <p style={{ marginTop: 10, color: 'var(--warn, #c98a00)', fontSize: 12.5 }}>{unknownNote}</p>
      )}

      {/* Flash preview */}
      <h3 className="group-title" style={{ fontSize: 14, margin: '18px 0 8px' }}>
        {t('morse.flashPreview')}
      </h3>
      <div
        style={{
          height: 72,
          borderRadius: 8,
          border: '1px solid var(--border, #333)',
          background: lampOn ? 'rgb(80,255,140)' : 'rgb(24,32,28)',
          transition: 'background 40ms linear',
          marginBottom: 12,
        }}
      />
      <div className="mod-toolbar">
        <button className="mini primary" onClick={play} disabled={flashing}>
          {t('morse.play')}
        </button>
        <button className="mini" onClick={stop} disabled={!flashing}>
          {t('morse.stop')}
        </button>
        <span className="count-note">{t('morse.speed')}</span>
        <input
          className="mod-search"
          type="number"
          min={1}
          max={60}
          style={{ maxWidth: 90 }}
          value={wpm}
          onChange={(e) => setWpm(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
        />
      </div>
      <p className="count-note" style={{ marginTop: 8 }}>
        {idleStatus}
      </p>
    </div>
  );
}
