import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Faithful web port of WinForge UnicodeInspectService — enumerate text by code point
// (correct surrogate handling via String iterator / codePointAt), report per-code-point
// facts + a length summary. Robust: never throws; the UI always renders.

interface CodePointInfo {
  index: number;
  glyph: string;
  codePoint: string; // U+XXXX
  escape: string; // \uXXXX / \UXXXXXXXX
  decimal: string;
  utf8: string; // hex bytes
  utf16: string; // hex code units
  category: string;
  flags: string;
  name: string;
  hidden: boolean;
}

interface Totals {
  codePoints: number;
  utf16Units: number; // string.length
  utf8Bytes: number;
  hiddenCount: number;
}

interface InspectResult {
  rows: CodePointInfo[];
  totals: Totals;
  hiddenNotes: string[];
}

// Names common hidden / confusable code points; null when the char is ordinary.
function hiddenName(v: number, t: TFunction): string | null {
  switch (v) {
    case 0x0000: return t('uniinspect.h_null');
    case 0x00a0: return t('uniinspect.h_nbsp');
    case 0x00ad: return t('uniinspect.h_softhyphen');
    case 0x200b: return t('uniinspect.h_zwsp');
    case 0x200c: return t('uniinspect.h_zwnj');
    case 0x200d: return t('uniinspect.h_zwj');
    case 0x200e: return t('uniinspect.h_lrm');
    case 0x200f: return t('uniinspect.h_rlm');
    case 0x202a: return t('uniinspect.h_lre');
    case 0x202b: return t('uniinspect.h_rle');
    case 0x202c: return t('uniinspect.h_pdf');
    case 0x202d: return t('uniinspect.h_lro');
    case 0x202e: return t('uniinspect.h_rlo');
    case 0x2060: return t('uniinspect.h_wj');
    case 0x2066: return t('uniinspect.h_lri');
    case 0x2067: return t('uniinspect.h_rli');
    case 0x2068: return t('uniinspect.h_fsi');
    case 0x2069: return t('uniinspect.h_pdi');
    case 0xfeff: return t('uniinspect.h_bom');
    case 0xfffc: return t('uniinspect.h_orc');
    case 0xfffd: return t('uniinspect.h_repl');
    case 0x115f: return t('uniinspect.h_hangul');
    case 0x3164: return t('uniinspect.h_hangul');
    case 0x180e: return t('uniinspect.h_mvs');
    default: return null;
  }
}

// Loose "emoji-ish" heuristic covering the common pictographic ranges.
function isEmojiish(v: number): boolean {
  return (
    (v >= 0x1f300 && v <= 0x1faff) ||
    (v >= 0x2600 && v <= 0x27bf) ||
    (v >= 0x1f000 && v <= 0x1f2ff) ||
    v === 0x2764 ||
    v === 0x2b50 ||
    (v >= 0xfe00 && v <= 0xfe0f) ||
    (v >= 0x1f1e6 && v <= 0x1f1ff)
  );
}

// Map a code point's general category to a C#-UnicodeCategory-style name, faithful to
// CharUnicodeInfo.GetUnicodeCategory naming. Uses JS \p{...} property tests.
function categoryName(cp: number): string {
  let s: string;
  try {
    s = String.fromCodePoint(cp);
  } catch {
    return 'OtherNotAssigned';
  }
  const test = (re: RegExp): boolean => {
    try {
      return re.test(s);
    } catch {
      return false;
    }
  };
  // Order: most specific first. Each maps to a UnicodeCategory enum name.
  if (test(/\p{Lu}/u)) return 'UppercaseLetter';
  if (test(/\p{Ll}/u)) return 'LowercaseLetter';
  if (test(/\p{Lt}/u)) return 'TitlecaseLetter';
  if (test(/\p{Lm}/u)) return 'ModifierLetter';
  if (test(/\p{Lo}/u)) return 'OtherLetter';
  if (test(/\p{Mn}/u)) return 'NonSpacingMark';
  if (test(/\p{Mc}/u)) return 'SpacingCombiningMark';
  if (test(/\p{Me}/u)) return 'EnclosingMark';
  if (test(/\p{Nd}/u)) return 'DecimalDigitNumber';
  if (test(/\p{Nl}/u)) return 'LetterNumber';
  if (test(/\p{No}/u)) return 'OtherNumber';
  if (test(/\p{Pc}/u)) return 'ConnectorPunctuation';
  if (test(/\p{Pd}/u)) return 'DashPunctuation';
  if (test(/\p{Ps}/u)) return 'OpenPunctuation';
  if (test(/\p{Pe}/u)) return 'ClosePunctuation';
  if (test(/\p{Pi}/u)) return 'InitialQuotePunctuation';
  if (test(/\p{Pf}/u)) return 'FinalQuotePunctuation';
  if (test(/\p{Po}/u)) return 'OtherPunctuation';
  if (test(/\p{Sm}/u)) return 'MathSymbol';
  if (test(/\p{Sc}/u)) return 'CurrencySymbol';
  if (test(/\p{Sk}/u)) return 'ModifierSymbol';
  if (test(/\p{So}/u)) return 'OtherSymbol';
  if (test(/\p{Zs}/u)) return 'SpaceSeparator';
  if (test(/\p{Zl}/u)) return 'LineSeparator';
  if (test(/\p{Zp}/u)) return 'ParagraphSeparator';
  if (test(/\p{Cc}/u)) return 'Control';
  if (test(/\p{Cf}/u)) return 'Format';
  if (test(/\p{Cs}/u)) return 'Surrogate';
  if (test(/\p{Co}/u)) return 'PrivateUse';
  return 'OtherNotAssigned';
}

function isWhiteSpaceCp(cp: number): boolean {
  try {
    const s = String.fromCodePoint(cp);
    return /\s/u.test(s);
  } catch {
    return false;
  }
}

function hex(n: number, width: number): string {
  let h = n.toString(16).toUpperCase();
  while (h.length < width) h = '0' + h;
  return h;
}

function utf8Bytes(cp: number): number[] {
  // Encode a single code point to UTF-8 bytes.
  if (cp <= 0x7f) return [cp];
  if (cp <= 0x7ff) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp <= 0xffff) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ];
}

function utf16Units(cp: number): number[] {
  if (cp <= 0xffff) return [cp];
  const c = cp - 0x10000;
  const hi = 0xd800 + (c >> 10);
  const lo = 0xdc00 + (c & 0x3ff);
  return [hi, lo];
}

function describe(cp: number, index: number, t: TFunction): CodePointInfo {
  const info: CodePointInfo = {
    index,
    glyph: '',
    codePoint: 'U+' + (cp > 0xffff ? hex(cp, 6) : hex(cp, 4)),
    escape: cp <= 0xffff ? '\\u' + hex(cp, 4) : '\\U' + hex(cp, 8),
    decimal: String(cp),
    utf8: '',
    utf16: '',
    category: '',
    flags: '',
    name: '',
    hidden: false,
  };

  try {
    info.utf8 = utf8Bytes(cp).map((b) => hex(b, 2)).join(' ');
  } catch {
    info.utf8 = '?';
  }
  try {
    info.utf16 = utf16Units(cp).map((u) => hex(u, 4)).join(' ');
  } catch {
    info.utf16 = '?';
  }

  const cat = categoryName(cp);
  info.category = cat;

  const combining = cat === 'NonSpacingMark' || cat === 'SpacingCombiningMark' || cat === 'EnclosingMark';
  const control = cat === 'Control' || cat === 'Format';
  const whitespace = isWhiteSpaceCp(cp);
  const emojiish = isEmojiish(cp);

  const flags: string[] = [];
  if (combining) flags.push(t('uniinspect.f_combining'));
  if (control) flags.push(t('uniinspect.f_control'));
  if (whitespace) flags.push(t('uniinspect.f_whitespace'));
  if (emojiish) flags.push(t('uniinspect.f_emoji'));
  if (cp > 0xffff) flags.push(t('uniinspect.f_astral'));
  info.flags = flags.join(', ');

  const hidden = hiddenName(cp, t);
  if (hidden !== null) {
    info.hidden = true;
    info.name = hidden;
  } else {
    info.name = combining
      ? t('uniinspect.n_combining')
      : control
        ? t('uniinspect.n_control')
        : cat;
  }

  if (info.hidden || control || combining) {
    info.glyph = t('uniinspect.hiddenGlyph');
  } else {
    try {
      info.glyph = String.fromCodePoint(cp);
    } catch {
      info.glyph = '?';
    }
    if (!info.glyph) info.glyph = '?';
  }

  return info;
}

function inspect(text: string, t: TFunction): InspectResult {
  const result: InspectResult = {
    rows: [],
    totals: { codePoints: 0, utf16Units: 0, utf8Bytes: 0, hiddenCount: 0 },
    hiddenNotes: [],
  };
  try {
    const src = text ?? '';
    const seenHidden = new Set<string>();
    let byteCount = 0;
    // Iterate by code point (spread uses the string iterator = correct surrogate handling).
    for (const ch of src) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      let info: CodePointInfo;
      try {
        info = describe(cp, result.rows.length + 1, t);
      } catch {
        continue;
      }
      result.rows.push(info);
      try {
        byteCount += utf8Bytes(cp).length;
      } catch {
        // ignore
      }
      if (info.hidden && !seenHidden.has(info.codePoint)) {
        seenHidden.add(info.codePoint);
        result.hiddenNotes.push(`${info.codePoint} — ${info.name}`);
      }
    }
    result.totals.codePoints = result.rows.length;
    result.totals.utf16Units = src.length;
    result.totals.utf8Bytes = byteCount;
    for (const r of result.rows) if (r.hidden) result.totals.hiddenCount++;
  } catch {
    // never throw
  }
  return result;
}

// Mix: ASCII, accented, no-break space, zero-width space, RTL mark, BOM,
// astral emoji (surrogate pair), a flag (regional indicators), CJK.
const SAMPLE = 'Á b​c‏d﻿\u{1F600}\u{1F1ED}\u{1F1F0}測試';

export function UnicodeInspectModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok'; text: string } | null>(null);

  const result = useMemo(() => inspect(input, t), [input, t]);

  const copyEscape = (info: CodePointInfo) => {
    try {
      navigator.clipboard?.writeText(info.escape);
      setNotice({ kind: 'ok', text: t('uniinspect.copiedMsg', { cp: info.codePoint, esc: info.escape }) });
      setTimeout(() => setNotice(null), 1800);
    } catch {
      // ignore
    }
  };

  const totals = result.totals;
  const summary = t('uniinspect.summary', {
    cp: totals.codePoints,
    u16: totals.utf16Units,
    bytes: totals.utf8Bytes,
  });

  return (
    <div className="mod">
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => setInput(SAMPLE)}>{t('uniinspect.sample')}</button>
        <button className="mini" onClick={() => { setInput(''); setNotice(null); }}>{t('uniinspect.clear')}</button>
      </div>

      <label className="count-note">{t('uniinspect.inputLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('uniinspect.inputLabel')}
        style={{ minHeight: 90 }}
      />

      <p className="count-note" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{t('uniinspect.blurb')}</p>

      <div className="panel" style={{ marginTop: 10 }}>
        <h4 style={{ marginTop: 0 }}>{t('uniinspect.summaryTitle')}</h4>
        <p className="value" style={{ fontFamily: 'monospace', margin: 0 }}>{summary}</p>
      </div>

      {result.totals.hiddenCount > 0 ? (
        <div className="panel" style={{ marginTop: 10, borderColor: 'var(--warn, #b58900)' }}>
          <strong style={{ color: 'var(--warn, #b58900)' }}>
            {t('uniinspect.hiddenTitle', { n: result.totals.hiddenCount })}
          </strong>
          <ul className="kv-list" style={{ marginTop: 6 }}>
            {result.hiddenNotes.map((note, i) => (
              <li className="kv-row" key={i}><span className="value">{note}</span></li>
            ))}
          </ul>
        </div>
      ) : result.totals.codePoints === 0 ? (
        <div className="panel" style={{ marginTop: 10 }}>
          <strong>{t('uniinspect.emptyTitle')}</strong>
          <p className="count-note" style={{ margin: '4px 0 0' }}>{t('uniinspect.emptyMsg')}</p>
        </div>
      ) : null}

      {notice ? (
        <p className="count-note" style={{ color: 'var(--ok, #859900)', marginTop: 8 }}>{notice.text}</p>
      ) : null}

      {result.rows.length > 0 ? (
        <div className="dt-wrap panel" style={{ marginTop: 10, overflowX: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('uniinspect.colGlyph')}</th>
                <th>{t('uniinspect.colCodePoint')}</th>
                <th>{t('uniinspect.colDecimal')}</th>
                <th>{t('uniinspect.colUtf8')}</th>
                <th>{t('uniinspect.colUtf16')}</th>
                <th>{t('uniinspect.colCategory')}</th>
                <th>{t('uniinspect.colFlags')}</th>
                <th>{t('uniinspect.colName')}</th>
                <th>{t('uniinspect.colEscape')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr
                  key={r.index}
                  onClick={() => copyEscape(r)}
                  style={{ cursor: 'pointer', background: r.hidden ? 'var(--warn-bg, rgba(181,137,0,0.12))' : undefined }}
                  title={t('uniinspect.rowHint')}
                >
                  <td style={{ opacity: 0.6 }}>{r.index}</td>
                  <td style={{ fontSize: '1.2em', textAlign: 'center' }}>{r.glyph}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.codePoint}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.decimal}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.utf8}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.utf16}</td>
                  <td>{r.category}</td>
                  <td>{r.flags}</td>
                  <td>{r.name}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.escape}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="count-note" style={{ marginTop: 8 }}>{t('uniinspect.tip')}</p>
    </div>
  );
}
