import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge TotpService (RFC 6238 / RFC 4226). Pure client-side,
// never throws. Uses Web Crypto (crypto.subtle) for HMAC-SHA1/256/512.

type HashAlgo = 'SHA-1' | 'SHA-256' | 'SHA-512';

interface OtpAuth {
  secret: string;
  label?: string;
  issuer?: string;
  digits: number;
  period: number;
  algorithm: HashAlgo;
}

/** Decode RFC 4648 Base32 (case-insensitive; ignores spaces/dashes/tabs/newlines and '=' padding). Null on invalid chars. */
function decodeBase32(input: string | null | undefined): Uint8Array | null {
  if (!input || input.trim().length === 0) return null;
  const out: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const raw of input) {
    const c = raw.toUpperCase();
    if (c === '=' || c === ' ' || c === '-' || c === '\t' || c === '\r' || c === '\n') continue;
    const val = base32Value(c);
    if (val < 0) return null;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function base32Value(c: string): number {
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65; // 0..25
  if (c >= '2' && c <= '7') return c.charCodeAt(0) - 50 + 26; // 26..31
  return -1;
}

/** RFC 4226 HOTP over an 8-byte counter, dynamic truncation → N digits. Async (Web Crypto). */
async function hotp(key: Uint8Array, counter: number, digits: number, algo: HashAlgo): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    // JS numbers are 53-bit safe; TOTP counters stay well under that.
    c = Math.floor(c / 256);
  }
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: algo }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg));
  const offset = sig[sig.length - 1]! & 0x0f;
  const binary =
    ((sig[offset]! & 0x7f) << 24) |
    ((sig[offset + 1]! & 0xff) << 16) |
    ((sig[offset + 2]! & 0xff) << 8) |
    (sig[offset + 3]! & 0xff);
  let mod = 1;
  for (let i = 0; i < digits; i++) mod *= 10;
  const otp = (binary >>> 0) % mod;
  return String(otp).padStart(digits, '0');
}

async function computeCode(
  base32Secret: string,
  digits: number,
  period: number,
  algo: HashAlgo,
  unixSeconds: number,
): Promise<string | null> {
  try {
    if (period <= 0) return null;
    if (digits < 1 || digits > 10) return null;
    const key = decodeBase32(base32Secret);
    if (key === null || key.length === 0) return null;
    const counter = Math.floor(unixSeconds / period);
    return await hotp(key, counter, digits, algo);
  } catch {
    return null;
  }
}

function secondsRemaining(period: number, unixSeconds: number): number {
  if (period <= 0) return 0;
  const used = unixSeconds % period;
  return period - used;
}

const unixNow = (): number => Math.floor(Date.now() / 1000);

/** Parse an otpauth://totp/Label?secret=..&issuer=..&digits=..&period=..&algorithm=.. URI. Null when invalid. */
function parseUri(uri: string | null | undefined): OtpAuth | null {
  try {
    if (!uri || uri.trim().length === 0) return null;
    const u = new URL(uri.trim());
    // URL keeps the scheme with a trailing colon.
    if (u.protocol.toLowerCase() !== 'otpauth:') return null;
    if (u.host.toLowerCase() !== 'totp') return null;

    const result: OtpAuth = { secret: '', digits: 6, period: 30, algorithm: 'SHA-1' };

    let label = '';
    try {
      label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch {
      label = u.pathname.replace(/^\/+/, '');
    }
    if (label) result.label = label;

    u.searchParams.forEach((value, rawKey) => {
      switch (rawKey.toLowerCase()) {
        case 'secret':
          result.secret = value;
          break;
        case 'issuer':
          result.issuer = value;
          break;
        case 'digits': {
          const d = parseInt(value, 10);
          if (Number.isFinite(d) && d >= 1 && d <= 10) result.digits = d;
          break;
        }
        case 'period': {
          const p = parseInt(value, 10);
          if (Number.isFinite(p) && p > 0) result.period = p;
          break;
        }
        case 'algorithm':
          result.algorithm =
            value.toUpperCase() === 'SHA256' ? 'SHA-256' : value.toUpperCase() === 'SHA512' ? 'SHA-512' : 'SHA-1';
          break;
      }
    });

    if (!result.secret || result.secret.trim().length === 0) return null;
    return result;
  } catch {
    return null;
  }
}

function algoLabel(algo: HashAlgo): string {
  return algo === 'SHA-256' ? 'SHA256' : algo === 'SHA-512' ? 'SHA512' : 'SHA1';
}

function spaced(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}

const ALGOS: HashAlgo[] = ['SHA-1', 'SHA-256', 'SHA-512'];

export function TotpModule() {
  const { t } = useTranslation();
  const [secret, setSecret] = useState('JBSWY3DPEHPK3PXP');
  const [uri, setUri] = useState('');
  const [digits, setDigits] = useState(6);
  const [period, setPeriod] = useState(30);
  const [algo, setAlgo] = useState<HashAlgo>('SHA-1');
  const [now, setNow] = useState(() => unixNow());
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);

  // 1-second tick, mirroring the DispatcherTimer in the WinForge page.
  useEffect(() => {
    const id = setInterval(() => setNow(unixNow()), 1000);
    return () => clearInterval(id);
  }, []);

  // Synchronous validity check drives status/countdown; the code itself is async.
  const validity = useMemo<'empty' | 'badSecret' | 'ok'>(() => {
    if (!secret || secret.trim().length === 0) return 'empty';
    if (decodeBase32(secret) === null) return 'badSecret';
    return 'ok';
  }, [secret]);

  const remaining = validity === 'ok' ? secondsRemaining(period, now) : 0;
  const ringPct = validity === 'ok' && period > 0 ? Math.max(0, Math.min(100, (remaining * 100) / period)) : 0;

  // Recompute the code whenever inputs or the current step change. Guarded so it never throws.
  const reqRef = useRef(0);
  useEffect(() => {
    if (validity !== 'ok') {
      setCode('');
      if (validity === 'empty') setStatus(t('totp.enterSecret'));
      else setStatus(t('totp.badSecret'));
      return;
    }
    const token = ++reqRef.current;
    computeCode(secret, digits, period, algo, now)
      .then((c) => {
        if (token !== reqRef.current) return; // stale
        if (c === null) {
          setCode('');
          setStatus(t('totp.cannotGenerate'));
          return;
        }
        setCode(c);
        setStatus(
          t('totp.statusOk', {
            remaining,
            digits,
            period,
            algo: algoLabel(algo),
          }),
        );
      })
      .catch(() => {
        if (token !== reqRef.current) return;
        setStatus(t('totp.error'));
      });
    // Recompute per step (counter), and on any parameter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, digits, period, algo, validity, period > 0 ? Math.floor(now / period) : 0, remaining, t]);

  const copy = () => {
    if (!code) {
      setStatus(t('totp.noCode'));
      return;
    }
    try {
      navigator.clipboard?.writeText(code);
      setCopied(true);
      setStatus(t('totp.copied'));
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setStatus(t('totp.cannotCopy'));
    }
  };

  const doImport = () => {
    const parsed = parseUri(uri);
    if (parsed === null) {
      setStatus(t('totp.badUri'));
      return;
    }
    setSecret(parsed.secret);
    setDigits(parsed.digits);
    setPeriod(parsed.period);
    setAlgo(parsed.algorithm);
    const who = parsed.issuer ?? parsed.label ?? '';
    setStatus(who ? t('totp.importedWho', { who }) : t('totp.imported'));
  };

  const display = code ? spaced(code) : '— — —';
  const isOk = validity === 'ok';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('totp.blurb')}
      </p>

      <div className="panel" style={{ textAlign: 'center' }}>
        <div className="label">{t('totp.currentCode')}</div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 40,
            fontWeight: 700,
            letterSpacing: 4,
            margin: '8px 0',
          }}
        >
          {display}
        </div>
        <div className="mod-toolbar" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'monospace',
              fontWeight: 700,
              background: `conic-gradient(var(--accent, #4a9) ${ringPct * 3.6}deg, var(--border, #ccc) 0deg)`,
            }}
            aria-label={t('totp.secondsRemaining')}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: 'var(--panel, #1e1e1e)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {isOk ? remaining : '—'}
            </span>
          </div>
          <button className="mini primary" disabled={!code} onClick={copy}>
            {copied ? t('totp.copied') : t('totp.copy')}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="kv-list">
          <div className="kv-row">
            <label className="label">{t('totp.base32Secret')}</label>
            <input
              className="hosts-edit"
              style={{ minHeight: 0, height: 34, fontFamily: 'monospace', flex: 1 }}
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="kv-row">
            <label className="label">{t('totp.uriLabel')}</label>
            <input
              className="hosts-edit"
              style={{ minHeight: 0, height: 34, fontFamily: 'monospace', flex: 1 }}
              spellCheck={false}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="otpauth://totp/..."
            />
            <button className="mini" onClick={doImport}>
              {t('totp.import')}
            </button>
          </div>
        </div>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('totp.digits')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          max={10}
          style={{ maxWidth: 70 }}
          value={digits}
          onChange={(e) => setDigits(Math.max(1, Math.min(10, Math.floor(+e.target.value) || 6)))}
        />
        <label className="count-note">{t('totp.period')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          style={{ maxWidth: 80 }}
          value={period}
          onChange={(e) => setPeriod(Math.max(1, Math.floor(+e.target.value) || 30))}
        />
        <label className="count-note">{t('totp.algorithm')}</label>
        <select className="mod-select" value={algo} onChange={(e) => setAlgo(e.target.value as HashAlgo)}>
          {ALGOS.map((a) => (
            <option key={a} value={a}>
              {algoLabel(a)}
            </option>
          ))}
        </select>
      </div>

      <p className="count-note" style={{ color: isOk ? undefined : 'var(--danger)' }}>
        {status}
      </p>
    </div>
  );
}
