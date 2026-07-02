import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleTabs } from './ModuleTabs';

const ALGS = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' } as const;
type Alg = keyof typeof ALGS;

const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToStr(s: string): string {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from([...b].map((c) => c.charCodeAt(0))));
}
async function sign(alg: Alg, signingInput: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret) as unknown as ArrayBuffer, { name: 'HMAC', hash: ALGS[alg] }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput) as unknown as ArrayBuffer);
  return b64url(new Uint8Array(sig));
}

function BuildTab() {
  const { t } = useTranslation();
  const [alg, setAlg] = useState<Alg>('HS256');
  const [header, setHeader] = useState('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
  const [payload, setPayload] = useState('{\n  "sub": "1234567890",\n  "name": "WinForge"\n}');
  const [secret, setSecret] = useState('my-secret');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const quickAdd = (claim: string) => {
    try {
      const p = JSON.parse(payload);
      const nowS = Math.floor(Date.now() / 1000);
      const values: Record<string, unknown> = { iat: nowS, exp: nowS + 3600, nbf: nowS, sub: 'subject', iss: 'winforge', aud: 'audience' };
      p[claim] = values[claim];
      setPayload(JSON.stringify(p, null, 2));
    } catch {
      setStatus({ ok: false, msg: t('jwt.badPayload') });
    }
  };

  const doSign = async () => {
    setStatus(null);
    let h: unknown;
    let p: unknown;
    try {
      h = JSON.parse(header);
    } catch {
      return setStatus({ ok: false, msg: t('jwt.badHeader') });
    }
    try {
      p = JSON.parse(payload);
    } catch {
      return setStatus({ ok: false, msg: t('jwt.badPayload') });
    }
    if (!secret) return setStatus({ ok: false, msg: t('jwt.needSecret') });
    try {
      (h as Record<string, unknown>).alg = alg;
      const si = `${b64url(enc.encode(JSON.stringify(h)))}.${b64url(enc.encode(JSON.stringify(p)))}`;
      setToken(`${si}.${await sign(alg, si, secret)}`);
      setStatus({ ok: true, msg: t('jwt.signed') });
    } catch (e) {
      setStatus({ ok: false, msg: `${t('jwt.signFailed')} ${String(e)}` });
    }
  };

  return (
    <div>
      <div className="mod-form">
        <select className="mod-select" value={alg} onChange={(e) => setAlg(e.target.value as Alg)}>
          {Object.keys(ALGS).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <input className="mod-search" placeholder={t('jwt.secret')} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="mini primary" onClick={doSign}>
          {t('jwt.sign')}
        </button>
      </div>
      <div className="mod-toolbar">
        <span className="count-note">{t('jwt.quickAdd')}:</span>
        {['iat', 'exp', 'nbf', 'sub', 'iss', 'aud'].map((c) => (
          <button key={c} className="mini" onClick={() => quickAdd(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="io-grid">
        <div>
          <label className="rx-label">{t('jwt.header')}</label>
          <textarea className="hosts-edit" spellCheck={false} value={header} onChange={(e) => setHeader(e.target.value)} />
        </div>
        <div>
          <label className="rx-label">{t('jwt.payload')}</label>
          <textarea className="hosts-edit" spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} />
        </div>
      </div>
      {status && <p className={status.ok ? 'mod-msg' : 'mod-msg'} style={status.ok ? {} : { color: 'var(--danger)' }}>{status.msg}</p>}
      {token && (
        <>
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <label className="rx-label" style={{ margin: 0 }}>
              {t('jwt.token')}
            </label>
            <button className="mini" onClick={() => navigator.clipboard?.writeText(token)}>
              {t('jwt.copy')}
            </button>
          </div>
          <textarea className="hosts-edit" spellCheck={false} readOnly value={token} style={{ minHeight: 90 }} />
        </>
      )}
    </div>
  );
}

function VerifyTab() {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [alg, setAlg] = useState<Alg>('HS256');
  const [secret, setSecret] = useState('my-secret');
  const [result, setResult] = useState<{ valid: boolean; header: string; payload: string } | null>(null);
  const [error, setError] = useState('');

  const doVerify = async () => {
    setError('');
    setResult(null);
    const parts = token.trim().split('.');
    if (parts.length !== 3) return setError(t('jwt.malformed'));
    let header: string;
    let payload: string;
    try {
      header = JSON.stringify(JSON.parse(b64urlToStr(parts[0]!)), null, 2);
    } catch {
      return setError(t('jwt.badTokenHeader'));
    }
    try {
      payload = JSON.stringify(JSON.parse(b64urlToStr(parts[1]!)), null, 2);
    } catch {
      return setError(t('jwt.badTokenPayload'));
    }
    if (!secret) return setError(t('jwt.needSecretVerify'));
    const expected = await sign(alg, `${parts[0]}.${parts[1]}`, secret);
    setResult({ valid: expected === parts[2], header, payload });
  };

  return (
    <div>
      <label className="rx-label">{t('jwt.tokenToVerify')}</label>
      <textarea className="hosts-edit" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} style={{ minHeight: 90 }} />
      <div className="mod-form" style={{ marginTop: 8 }}>
        <select className="mod-select" value={alg} onChange={(e) => setAlg(e.target.value as Alg)}>
          {Object.keys(ALGS).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <input className="mod-search" placeholder={t('jwt.secret')} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="mini primary" onClick={doVerify}>
          {t('jwt.verify')}
        </button>
      </div>
      {error && <p className="mod-msg" style={{ color: 'var(--danger)' }}>{error}</p>}
      {result && (
        <>
          <p className="mod-msg" style={{ background: 'transparent', border: 'none', padding: 0 }}>
            <span className={result.valid ? 'status-pill working' : 'status-pill stub'} style={{ fontSize: 13 }}>
              {result.valid ? `✓ ${t('jwt.valid')}` : `✗ ${t('jwt.invalid')}`}
            </span>
          </p>
          <div className="io-grid">
            <div>
              <label className="rx-label">{t('jwt.decodedHeader')}</label>
              <textarea className="hosts-edit" spellCheck={false} readOnly value={result.header} />
            </div>
            <div>
              <label className="rx-label">{t('jwt.decodedPayload')}</label>
              <textarea className="hosts-edit" spellCheck={false} readOnly value={result.payload} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function JwtModule() {
  return (
    <ModuleTabs
      tabs={[
        { id: 'build', en: 'Build & sign', zh: '建立同簽名', render: () => <BuildTab /> },
        { id: 'verify', en: 'Verify', zh: '驗證', render: () => <VerifyTab /> },
      ]}
    />
  );
}
