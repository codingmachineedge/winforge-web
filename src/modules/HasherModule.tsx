import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { md5 } from './md5';

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const SHA = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;

async function digest(algo: string, data: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest(algo, data as unknown as ArrayBuffer));
}
async function hmac(algo: string, key: Uint8Array, data: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as unknown as ArrayBuffer, { name: 'HMAC', hash: algo }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, data as unknown as ArrayBuffer));
}

export function HasherModule() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [hmacOn, setHmacOn] = useState(false);
  const [key, setKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);

  const data = useMemo(() => fileBytes ?? new TextEncoder().encode(text), [text, fileBytes]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setBusy(true);
      const out: Record<string, string> = {};
      const keyBytes = new TextEncoder().encode(key);
      try {
        if (hmacOn) {
          for (const a of SHA) out[`HMAC-${a}`] = key ? await hmac(a, keyBytes, data) : '';
        } else {
          out['MD5'] = md5(data);
          for (const a of SHA) out[a] = await digest(a, data);
        }
      } catch {
        /* ignore */
      }
      if (alive) {
        setResults(out);
        setBusy(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [data, hmacOn, key]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setFileBytes(new Uint8Array(await f.arrayBuffer()));
  };
  const clearFile = () => {
    setFileName('');
    setFileBytes(null);
  };

  const expectedLc = expected.trim().toLowerCase();
  const matchAlgo = expectedLc ? Object.entries(results).find(([, v]) => v && v.toLowerCase() === expectedLc)?.[0] : undefined;

  return (
    <div className="mod">
      <label className="rx-label">{fileBytes ? t('hasher.hashFile') : t('hasher.hashText')}</label>
      {!fileBytes && (
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 100 }}
          placeholder={t('hasher.textPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <label className="mini" style={{ cursor: 'pointer' }}>
          {t('hasher.pickFile')}
          <input type="file" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {fileName && (
          <>
            <span className="count-note">
              {fileName} · {(fileBytes!.length / 1024).toFixed(1)} KB
            </span>
            <button className="mini" onClick={clearFile}>
              ✕
            </button>
          </>
        )}
        <label className="chk">
          <input type="checkbox" checked={hmacOn} onChange={(e) => setHmacOn(e.target.checked)} />
          {t('hasher.hmac')}
        </label>
        {hmacOn && (
          <input className="mod-search" style={{ maxWidth: 220 }} placeholder={t('hasher.hmacKey')} value={key} onChange={(e) => setKey(e.target.value)} />
        )}
        {busy && <span className="count-note">…</span>}
      </div>

      <table className="dt ct-table" style={{ marginTop: 12 }}>
        <tbody>
          {Object.entries(results).map(([algo, val]) => (
            <tr key={algo}>
              <td style={{ width: 130, color: 'var(--text-tertiary)' }}>{algo}</td>
              <td>
                <span className="env-val">{val || '—'}</span>
              </td>
              <td style={{ width: 70, textAlign: 'right' }}>
                <button className="mini" disabled={!val} onClick={() => val && navigator.clipboard?.writeText(val)}>
                  {t('hasher.copy')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <label className="rx-label" style={{ marginTop: 12 }}>
        {t('hasher.verify')}
      </label>
      <input className="mod-search" style={{ width: '100%' }} placeholder={t('hasher.verifyPlaceholder')} value={expected} onChange={(e) => setExpected(e.target.value)} />
      {expectedLc && (
        <p className="count-note" style={{ marginTop: 6 }}>
          {matchAlgo ? (
            <span className="dep-ok">✓ {t('hasher.matches', { algo: matchAlgo })}</span>
          ) : (
            <span style={{ color: 'var(--native)' }}>✗ {t('hasher.noMatch')}</span>
          )}
        </p>
      )}
    </div>
  );
}
