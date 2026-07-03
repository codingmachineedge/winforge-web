import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Faithful port of WinForge TextRedactService — regex PII detection + masking.
// Best-effort heuristics; JS regex has no per-match timeout so we rely on
// never-throw guards instead. Detection is NOT a guarantee.

type Category = 'email' | 'phone' | 'card' | 'ip' | 'digits';
type MaskStyle = 'asterisks' | 'redacted' | 'keeplast4';

// Ported patterns (global flag so .replace hits every match).
const EmailRx = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PhoneRx = /(?<!\d)(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{2,4}(?:[\s.\-]\d{2,4}){1,4}(?!\d)/g;
const CreditCardRx = /(?<!\d)(?:\d[ \-]?){13,16}(?<!-)(?<! )(?<=\d)/g;
const Ipv4Rx = /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/g;
const LongDigitsRx = /(?<!\d)\d{7,}(?!\d)/g;

function regexFor(cat: Category): RegExp {
  switch (cat) {
    case 'email':
      return EmailRx;
    case 'phone':
      return PhoneRx;
    case 'card':
      return CreditCardRx;
    case 'ip':
      return Ipv4Rx;
    case 'digits':
      return LongDigitsRx;
    default:
      return LongDigitsRx;
  }
}

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

function mask(value: string, style: MaskStyle): string {
  switch (style) {
    case 'redacted':
      return '[REDACTED]';
    case 'keeplast4': {
      if (value.length <= 4) return value;
      const keepFrom = value.length - 4;
      let out = '';
      for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        if (i >= keepFrom) out += ch;
        else out += isWhitespace(ch) ? ch : '*';
      }
      return out;
    }
    case 'asterisks':
    default: {
      let out = '';
      for (const ch of value) out += isWhitespace(ch) ? ch : '*';
      return out;
    }
  }
}

interface RedactResult {
  output: string;
  counts: Partial<Record<Category, number>>;
  failed: boolean;
  total: number;
}

// Deterministic order: broad patterns (email, IPv4) run before digit-run
// patterns so their digits are already masked and won't be double-counted.
const ORDER: Category[] = ['email', 'ip', 'card', 'phone', 'digits'];

function redact(input: string, enabled: Set<Category>, style: MaskStyle): RedactResult {
  const counts: Partial<Record<Category, number>> = {};
  if (!input || enabled.size === 0) {
    return { output: input ?? '', counts, failed: false, total: 0 };
  }

  let text = input;
  let failed = false;

  for (const cat of ORDER) {
    if (!enabled.has(cat)) continue;
    try {
      let n = 0;
      const rx = new RegExp(regexFor(cat).source, 'g');
      text = text.replace(rx, (m) => {
        n++;
        return mask(m, style);
      });
      if (n > 0) counts[cat] = n;
    } catch {
      // One bad category must not lose the rest.
      failed = true;
    }
  }

  let total = 0;
  for (const c of ORDER) total += counts[c] ?? 0;
  return { output: text, counts, failed, total };
}

function statusText(
  t: TFunction,
  input: string,
  r: RedactResult,
): string {
  if (r.failed) return t('textredact.failed');
  if (!input) return t('textredact.begin');
  if (r.total === 0) return t('textredact.noMatches');
  return t('textredact.masked', {
    total: r.total,
    email: r.counts.email ?? 0,
    phone: r.counts.phone ?? 0,
    card: r.counts.card ?? 0,
    ip: r.counts.ip ?? 0,
    digits: r.counts.digits ?? 0,
  });
}

const SAMPLE =
  'Contact John at john.doe@example.com or call +1 (555) 123-4567.\n' +
  'Server 192.168.1.100 logged card 4111 1111 1111 1111 for ID 1234567890.';

export function TextRedactModule() {
  const { t } = useTranslation();

  const [input, setInput] = useState(SAMPLE);
  const [email, setEmail] = useState(true);
  const [phone, setPhone] = useState(true);
  const [card, setCard] = useState(true);
  const [ip, setIp] = useState(true);
  const [digits, setDigits] = useState(true);
  const [style, setStyle] = useState<MaskStyle>('asterisks');
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => {
    const enabled = new Set<Category>();
    if (email) enabled.add('email');
    if (phone) enabled.add('phone');
    if (card) enabled.add('card');
    if (ip) enabled.add('ip');
    if (digits) enabled.add('digits');
    try {
      return redact(input, enabled, style);
    } catch {
      return { output: input, counts: {}, failed: true, total: 0 } as RedactResult;
    }
  }, [input, email, phone, card, ip, digits, style]);

  const status = statusText(t, input, result);

  const copy = () => {
    if (!result.output) return;
    navigator.clipboard?.writeText(result.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('textredact.blurb')}</p>

      <div className="panel">
        <div className="label" style={{ marginBottom: 6 }}>{t('textredact.detectLabel')}</div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="chk"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> {t('textredact.email')}</label>
          <label className="chk"><input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} /> {t('textredact.phone')}</label>
          <label className="chk"><input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} /> {t('textredact.card')}</label>
          <label className="chk"><input type="checkbox" checked={ip} onChange={(e) => setIp(e.target.checked)} /> {t('textredact.ip')}</label>
          <label className="chk"><input type="checkbox" checked={digits} onChange={(e) => setDigits(e.target.checked)} /> {t('textredact.digits')}</label>
        </div>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 10 }}>
        <label className="count-note">{t('textredact.styleLabel')}</label>
        <select className="mod-select" value={style} onChange={(e) => setStyle(e.target.value as MaskStyle)}>
          <option value="asterisks">{t('textredact.styleAsterisks')}</option>
          <option value="redacted">{t('textredact.styleRedacted')}</option>
          <option value="keeplast4">{t('textredact.styleKeepLast4')}</option>
        </select>
        <button className="mini" disabled={!result.output} onClick={copy}>
          {copied ? t('textredact.copied') : t('textredact.copy')}
        </button>
      </div>

      <div className="io-grid" style={{ marginTop: 10 }}>
        <div>
          <div className="label" style={{ marginBottom: 4 }}>{t('textredact.inputLabel')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('textredact.inputPlaceholder')}
          />
        </div>
        <div>
          <div className="label" style={{ marginBottom: 4 }}>{t('textredact.outputLabel')}</div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            readOnly
            value={result.output}
            placeholder={t('textredact.outputPlaceholder')}
          />
        </div>
      </div>

      <p className="count-note" style={{ marginTop: 8, color: result.failed ? 'var(--danger)' : undefined }}>{status}</p>
      <p className="count-note" style={{ marginTop: 4, opacity: 0.8 }}>{t('textredact.disclaimer')}</p>
    </div>
  );
}
