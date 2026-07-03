import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

/**
 * Faithful port of WinForge PasswordStrengthService. Pure client-side, in-memory only —
 * the password is never stored, logged or transmitted. Estimates pool size, length×log2(pool)
 * entropy, a strength band, crack-times at several guess rates, a rule checklist and an embedded
 * common-password blocklist. Never throws.
 */

// ~100 of the most common leaked passwords (lower-cased). Kept small & embedded — no network.
const COMMON = new Set<string>([
  '123456', 'password', '123456789', '12345678', '12345', '1234567', 'qwerty', 'abc123', '111111', '123123',
  '1234567890', '1234', '000000', 'password1', 'qwerty123', '1q2w3e4r', 'admin', 'letmein', 'welcome', 'monkey',
  'dragon', 'football', 'iloveyou', 'sunshine', 'princess', 'aa123456', '654321', 'superman', '666666', '987654321',
  'qwertyuiop', '121212', 'zaq12wsx', 'passw0rd', 'trustno1', 'master', 'hello', 'freedom', 'whatever', 'qazwsx',
  'michael', 'batman', 'shadow', 'baseball', 'soccer', 'hockey', 'killer', 'charlie', 'jordan', 'harley',
  'andrew', 'tigger', 'robert', 'daniel', 'hannah', 'jessica', 'thomas', 'summer', 'ashley', 'jennifer',
  'starwars', 'computer', 'secret', 'internet', 'service', 'canada', 'hunter', 'buster', 'soccer1', 'liverpool',
  'test', 'test123', 'guest', 'root', 'admin123', 'login', 'changeme', 'password123', 'p@ssw0rd', 'qwe123',
  '1qaz2wsx', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'q1w2e3r4', 'abcd1234', 'a1b2c3d4', '987654', '112233', '696969',
  '555555', '777777', '888888', '999999', 'google', 'facebook', 'chocolate', 'cheese', 'ninja', 'pokemon',
]);

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  '0123456789', '9876543210',
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'qwerty', 'qazwsx', '1q2w3e4r',
];

interface Result {
  length: number;
  poolSize: number;
  entropyBits: number;
  band: number; // 0..4 (Very weak → Very strong)
  fraction: number; // 0..1 for a progress bar
  hasLower: boolean;
  hasUpper: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
  hasSpace: boolean;
  noRepeats: boolean;
  noSequences: boolean;
  len8: boolean;
  len12: boolean;
  len16: boolean;
  isCommon: boolean;
  onlineSeconds: number; // 1e4 guesses/s
  offlineGpuSeconds: number; // 1e10 guesses/s
  fastSeconds: number; // 1e12 guesses/s
}

function emptyResult(): Result {
  return {
    length: 0, poolSize: 0, entropyBits: 0, band: 0, fraction: 0,
    hasLower: false, hasUpper: false, hasDigit: false, hasSymbol: false, hasSpace: false,
    noRepeats: true, noSequences: true, len8: false, len12: false, len16: false, isCommon: false,
    onlineSeconds: 0, offlineGpuSeconds: 0, fastSeconds: 0,
  };
}

function hasRun(pw: string, n: number): boolean {
  let run = 1;
  for (let i = 1; i < pw.length; i++) {
    run = pw[i] === pw[i - 1] ? run + 1 : 1;
    if (run >= n) return true;
  }
  return false;
}

function hasSequence(pw: string): boolean {
  if (pw.length < 3) return false;
  const low = pw.toLowerCase();
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 3 <= seq.length; i++) {
      if (low.includes(seq.substring(i, i + 3))) return true;
    }
  }
  return false;
}

/** Analyse a password. Returns a filled Result; never throws. */
function analyze(password: string): Result {
  const r = emptyResult();
  try {
    const pw = password ?? '';
    r.length = pw.length;
    if (pw.length === 0) return r;

    for (const c of pw) {
      if (c >= 'a' && c <= 'z') r.hasLower = true;
      else if (c >= 'A' && c <= 'Z') r.hasUpper = true;
      else if (c >= '0' && c <= '9') r.hasDigit = true;
      else if (c === ' ') r.hasSpace = true;
      else r.hasSymbol = true;
    }

    let pool = 0;
    if (r.hasLower) pool += 26;
    if (r.hasUpper) pool += 26;
    if (r.hasDigit) pool += 10;
    if (r.hasSymbol) pool += 33; // printable ASCII punctuation
    if (r.hasSpace) pool += 1;
    if (pool <= 0) pool = 1;
    r.poolSize = pool;

    r.entropyBits = pw.length * Math.log2(pool);

    r.len8 = pw.length >= 8;
    r.len12 = pw.length >= 12;
    r.len16 = pw.length >= 16;
    r.noRepeats = !hasRun(pw, 3);
    r.noSequences = !hasSequence(pw);
    r.isCommon = COMMON.has(pw.trim().toLowerCase());

    // Effective entropy for crack-time: penalise known-bad passwords heavily.
    let effective = r.entropyBits;
    if (r.isCommon) {
      effective = Math.min(effective, 8);
    } else {
      if (!r.noSequences) effective -= 8;
      if (!r.noRepeats) effective -= 6;
      if (effective < 0) effective = 0;
    }

    // Average guesses ≈ half the keyspace (2^bits / 2 = 2^(bits-1)).
    const guesses = Math.pow(2, Math.max(0, effective - 1));
    r.onlineSeconds = guesses / 1e4;
    r.offlineGpuSeconds = guesses / 1e10;
    r.fastSeconds = guesses / 1e12;

    // Band from effective entropy (with a hard cap for common passwords).
    const e = r.isCommon ? 0 : effective;
    r.band = e < 28 ? 0 : e < 40 ? 1 : e < 60 ? 2 : e < 80 ? 3 : 4;
    r.fraction = Math.min(1.0, Math.max(0.02, e / 100.0));
  } catch {
    // Never throw — return whatever we managed to fill.
  }
  return r;
}

/** Human-readable localised duration for a number of seconds. Never throws. */
function humanTime(seconds: number, t: TFunction): string {
  try {
    let s = seconds;
    if (Number.isNaN(s) || !Number.isFinite(s) || s < 0) s = 0;

    if (s < 1) return t('pwstrength.instantly');

    const fmt = (value: number, oneKey: string, manyKey: string): string => {
      let n = Math.round(value);
      if (n < 1) n = 1;
      const num = n.toLocaleString();
      // English pluralises; Chinese uses the same word for both (handled in the translations).
      const unit = n === 1 ? t(oneKey) : t(manyKey);
      return `${num} ${unit}`;
    };

    if (s < 60) return fmt(s, 'pwstrength.second', 'pwstrength.seconds');
    if (s < 3600) return fmt(s / 60, 'pwstrength.minute', 'pwstrength.minutes');
    if (s < 86400) return fmt(s / 3600, 'pwstrength.hour', 'pwstrength.hours');
    if (s < 2592000) return fmt(s / 86400, 'pwstrength.day', 'pwstrength.days');
    if (s < 31536000) return fmt(s / 2592000, 'pwstrength.month', 'pwstrength.months');
    if (s < 3153600000) return fmt(s / 31536000, 'pwstrength.year', 'pwstrength.years');
    if (s < 3.1536e11) return fmt(s / 3153600000, 'pwstrength.century', 'pwstrength.centuries');

    const eons = s / 3.15576e16;
    if (eons < 1000) return fmt(s / 31536000, 'pwstrength.year', 'pwstrength.years');
    return t('pwstrength.forever');
  } catch {
    return t('pwstrength.dash');
  }
}

function bandLabel(band: number, t: TFunction): string {
  switch (band) {
    case 0: return t('pwstrength.bandVeryWeak');
    case 1: return t('pwstrength.bandWeak');
    case 2: return t('pwstrength.bandFair');
    case 3: return t('pwstrength.bandStrong');
    default: return t('pwstrength.bandVeryStrong');
  }
}

function bandBlurb(band: number, t: TFunction): string {
  switch (band) {
    case 0: return t('pwstrength.blurbVeryWeak');
    case 1: return t('pwstrength.blurbWeak');
    case 2: return t('pwstrength.blurbFair');
    case 3: return t('pwstrength.blurbStrong');
    default: return t('pwstrength.blurbVeryStrong');
  }
}

function bandColor(band: number): string {
  switch (band) {
    case -1: return '#808080';
    case 0: return '#E81A1A';
    case 1: return '#E87A1A';
    case 2: return '#E8C81A';
    case 3: return '#5AC83A';
    default: return '#2EA844';
  }
}

export function PasswordStrengthModule() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  const r = useMemo(() => analyze(password), [password]);

  const isEmpty = r.length === 0;
  const barBand = isEmpty ? -1 : r.band;
  const barColor = bandColor(barBand);
  const barFraction = isEmpty ? 0 : r.fraction;

  const checklist: Array<{ ok: boolean; label: string }> = [
    { ok: r.len8, label: t('pwstrength.chkLen8') },
    { ok: r.len12, label: t('pwstrength.chkLen12') },
    { ok: r.len16, label: t('pwstrength.chkLen16') },
    { ok: r.hasLower, label: t('pwstrength.chkLower') },
    { ok: r.hasUpper, label: t('pwstrength.chkUpper') },
    { ok: r.hasDigit, label: t('pwstrength.chkDigit') },
    { ok: r.hasSymbol, label: t('pwstrength.chkSymbol') },
    { ok: r.noRepeats, label: t('pwstrength.chkNoRepeats') },
    { ok: r.noSequences, label: t('pwstrength.chkNoSequences') },
    { ok: !r.isCommon, label: t('pwstrength.chkNotCommon') },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('pwstrength.blurb')}</p>
      <p className="count-note" style={{ color: 'var(--accent, #2EA844)' }}>{t('pwstrength.privacy')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('pwstrength.entryLabel')}</label>
        <input
          className="hosts-edit"
          style={{ minHeight: 0, height: 34, maxWidth: 320, fontFamily: 'monospace' }}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('pwstrength.entryPlaceholder')}
        />
        <label className="chk">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> {t('pwstrength.revealLabel')}
        </label>
      </div>

      <div className="panel">
        <div className="dt-wrap">
          <div className="label" style={{ marginBottom: 6 }}>{t('pwstrength.strengthTitle')}</div>
          <div
            style={{
              height: 12,
              borderRadius: 6,
              background: 'var(--border, #333)',
              overflow: 'hidden',
              maxWidth: 480,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.round(barFraction * 100)}%`,
                background: barColor,
                transition: 'width 120ms ease, background 120ms ease',
              }}
            />
          </div>
          <div style={{ marginTop: 8, fontWeight: 600, color: barColor }}>
            {isEmpty ? t('pwstrength.dash') : bandLabel(r.band, t)}
          </div>
          <div className="count-note" style={{ marginTop: 4 }}>
            {isEmpty ? t('pwstrength.startTyping') : bandBlurb(r.band, t)}
          </div>
          {!isEmpty && r.isCommon ? (
            <div className="count-note" style={{ marginTop: 8, color: 'var(--danger, #E81A1A)' }}>
              <strong>{t('pwstrength.commonTitle')}</strong> — {t('pwstrength.commonMessage')}
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <div className="label" style={{ marginBottom: 8 }}>{t('pwstrength.metricsHeader')}</div>
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('pwstrength.lengthLabel')}</span>
            <span className="value">{t('pwstrength.charCount', { count: r.length })}</span>
          </div>
          <div className="kv-row">
            <span className="label">{t('pwstrength.poolLabel')}</span>
            <span className="value">{t('pwstrength.symbolCount', { count: r.poolSize })}</span>
          </div>
          <div className="kv-row">
            <span className="label">{t('pwstrength.entropyLabel')}</span>
            <span className="value">{t('pwstrength.bitsValue', { bits: r.entropyBits.toFixed(1) })}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="label" style={{ marginBottom: 8 }}>{t('pwstrength.crackHeader')}</div>
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('pwstrength.crackOnline')}</span>
            <span className="value">{isEmpty ? t('pwstrength.dash') : humanTime(r.onlineSeconds, t)}</span>
          </div>
          <div className="kv-row">
            <span className="label">{t('pwstrength.crackGpu')}</span>
            <span className="value">{isEmpty ? t('pwstrength.dash') : humanTime(r.offlineGpuSeconds, t)}</span>
          </div>
          <div className="kv-row">
            <span className="label">{t('pwstrength.crackFast')}</span>
            <span className="value">{isEmpty ? t('pwstrength.dash') : humanTime(r.fastSeconds, t)}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="label" style={{ marginBottom: 8 }}>{t('pwstrength.checklistHeader')}</div>
        <div className="kv-list">
          {checklist.map((item, i) => (
            <div className="kv-row" key={i}>
              <span className="value" style={{ color: item.ok ? '#2EA844' : '#E81A1A', fontWeight: 700, minWidth: 18 }}>
                {item.ok ? '✓' : '✗'}
              </span>
              <span className="label">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
