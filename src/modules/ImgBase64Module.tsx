import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function ImgBase64Module() {
  const { t } = useTranslation();
  const [dataUri, setDataUri] = useState('');
  const [meta, setMeta] = useState<{ name: string; type: string; bytes: number } | null>(null);
  const [decodeIn, setDecodeIn] = useState('');
  const [preview, setPreview] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setErr('');
    const reader = new FileReader();
    reader.onload = () => {
      const uri = String(reader.result);
      setDataUri(uri);
      setMeta({ name: f.name, type: f.type || 'application/octet-stream', bytes: f.size });
    };
    reader.onerror = () => setErr(t('img.readErr') + reader.error);
    reader.readAsDataURL(f);
  };

  const decode = () => {
    setErr('');
    const raw = decodeIn.trim();
    if (!raw) return;
    let uri = raw;
    if (!/^data:/.test(raw)) {
      // raw base64 → validate + wrap as png
      if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
        setErr(t('img.badB64'));
        setPreview('');
        return;
      }
      uri = `data:image/png;base64,${raw.replace(/\s+/g, '')}`;
    }
    setPreview(uri);
  };

  return (
    <div className="mod" style={{ display: 'grid', gap: 12 }}>
      <div className="panel" style={{ padding: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
          {t('img.toB64')}
        </h3>
        <div className="mod-toolbar">
          <label className="mini primary" style={{ cursor: 'pointer' }}>
            {t('img.pick')}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <button className="mini" disabled={!dataUri} onClick={() => dataUri && (navigator.clipboard?.writeText(dataUri), setMsg(t('img.copied')))}>
            {t('img.copyUri')}
          </button>
          {meta && (
            <span className="count-note">
              {meta.name} · {meta.type} · {(meta.bytes / 1024).toFixed(1)} KB → {(dataUri.length / 1024).toFixed(1)} KB base64
            </span>
          )}
          {msg && <span className="dep-ok">{msg}</span>}
        </div>
        {dataUri && (
          <div className="io-grid" style={{ marginTop: 10 }}>
            <img src={dataUri} alt="preview" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, border: '1px solid var(--stroke)', objectFit: 'contain' }} />
            <textarea className="hosts-edit" spellCheck={false} readOnly value={dataUri} style={{ minHeight: 220 }} />
          </div>
        )}
      </div>

      <div className="panel" style={{ padding: 14 }}>
        <h3 className="group-title" style={{ fontSize: 14, marginTop: 0 }}>
          {t('img.toImg')}
        </h3>
        <textarea className="hosts-edit" spellCheck={false} placeholder={t('img.pastePlaceholder')} value={decodeIn} onChange={(e) => setDecodeIn(e.target.value)} style={{ minHeight: 100 }} />
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" onClick={decode}>
            {t('img.decode')}
          </button>
          {preview && (
            <a className="mini" href={preview} download="image">
              {t('img.save')}
            </a>
          )}
        </div>
        {err && <p className="mod-msg" style={{ color: 'var(--danger)' }}>{err}</p>}
        {preview && (
          <div style={{ marginTop: 10 }}>
            <label className="rx-label">{t('img.preview')}</label>
            <img src={preview} alt="decoded" style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 8, border: '1px solid var(--stroke)', objectFit: 'contain' }} onError={() => setErr(t('img.badB64'))} />
          </div>
        )}
      </div>
    </div>
  );
}
