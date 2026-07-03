import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// 剪貼簿格式檢查器 · Clipboard format inspector.
// Web port of WinForge's ClipInspectModule: reads the clipboard on demand via the
// async Clipboard API, lists every MIME type it exposes, flags which standard
// formats are present, and previews any text. Read-only: only reads when the user
// presses a button, never writes the clipboard, never throws.

interface InspectResult {
  ok: boolean;
  error?: string;
  formats: string[];
  hasText: boolean;
  hasHtml: boolean;
  hasRtf: boolean;
  hasBitmap: boolean;
  hasStorageItems: boolean;
  hasWebLink: boolean;
  hasApplicationLink: boolean;
  textPreview?: string;
  htmlLength: number;
  storageItemCount: number;
}

const IMAGE_RE = /^image\//i;

async function readClipboard(): Promise<InspectResult> {
  const empty: InspectResult = {
    ok: false,
    formats: [],
    hasText: false,
    hasHtml: false,
    hasRtf: false,
    hasBitmap: false,
    hasStorageItems: false,
    hasWebLink: false,
    hasApplicationLink: false,
    htmlLength: 0,
    storageItemCount: 0,
  };

  const clip = navigator.clipboard;
  if (!clip || typeof clip.read !== 'function') {
    return { ...empty, error: 'unsupported' };
  }

  let items: ClipboardItems;
  try {
    items = await clip.read();
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }

  // Gather every advertised MIME type across all clipboard items.
  const formatSet = new Set<string>();
  for (const item of items) {
    for (const type of item.types) formatSet.add(type);
  }
  const formats = Array.from(formatSet).sort();

  const has = (type: string) => formatSet.has(type);
  const hasText = has('text/plain');
  const hasHtml = has('text/html');
  const hasRtf = has('text/rtf') || has('application/rtf');
  const hasBitmap = formats.some((f) => IMAGE_RE.test(f));
  // The web sandbox exposes no file/link standard formats through the async
  // Clipboard API; keep the rows for feature parity — they show as absent.
  const hasStorageItems = has('Files') || has('text/uri-list');
  const hasWebLink = false;
  const hasApplicationLink = false;

  // Read the first item that carries a given blob type.
  const blobOf = async (type: string): Promise<Blob | null> => {
    for (const item of items) {
      if (item.types.includes(type)) {
        try {
          return await item.getType(type);
        } catch {
          /* getType can throw despite the flag */
        }
      }
    }
    return null;
  };

  let textPreview: string | undefined;
  if (hasText) {
    const blob = await blobOf('text/plain');
    if (blob) {
      try {
        let text = await blob.text();
        text = text.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
        textPreview = text.length > 400 ? text.slice(0, 400) + '…' : text;
      } catch {
        /* ignore */
      }
    }
  }

  let htmlLength = 0;
  if (hasHtml) {
    const blob = await blobOf('text/html');
    if (blob) {
      try {
        htmlLength = (await blob.text()).length;
      } catch {
        /* ignore */
      }
    }
  }

  let storageItemCount = 0;
  if (hasStorageItems) {
    const blob = await blobOf('text/uri-list');
    if (blob) {
      try {
        const list = (await blob.text())
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0 && !l.startsWith('#'));
        storageItemCount = list.length;
      } catch {
        /* ignore */
      }
    }
  }

  return {
    ok: true,
    formats,
    hasText,
    hasHtml,
    hasRtf,
    hasBitmap,
    hasStorageItems,
    hasWebLink,
    hasApplicationLink,
    textPreview,
    htmlLength,
    storageItemCount,
  };
}

export function ClipInspectModule() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [status, setStatus] = useState<string>(t('clipinspect.pressToRead'));

  const doRead = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(t('clipinspect.reading'));
    try {
      const r = await readClipboard();
      if (!r.ok) {
        setResult(null);
        const err = r.error === 'unsupported' ? t('clipinspect.unsupported') : r.error ?? '';
        setStatus(t('clipinspect.readError', { err }));
        return;
      }
      setResult(r);
      if (r.formats.length === 0) {
        setStatus(t('clipinspect.empty'));
      } else {
        setStatus(t('clipinspect.readN', { n: r.formats.length }));
      }
    } catch (e) {
      setResult(null);
      setStatus(t('clipinspect.readError', { err: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const stdRows: { present: boolean; label: string }[] = result
    ? [
        { present: result.hasText, label: t('clipinspect.stdText') },
        {
          present: result.hasHtml,
          label: result.hasHtml
            ? t('clipinspect.stdHtmlLen', { n: result.htmlLength })
            : t('clipinspect.stdHtml'),
        },
        { present: result.hasRtf, label: t('clipinspect.stdRtf') },
        { present: result.hasBitmap, label: t('clipinspect.stdBitmap') },
        {
          present: result.hasStorageItems,
          label: result.hasStorageItems
            ? t('clipinspect.stdFilesN', { n: result.storageItemCount })
            : t('clipinspect.stdFiles'),
        },
        { present: result.hasWebLink, label: t('clipinspect.stdWebLink') },
        { present: result.hasApplicationLink, label: t('clipinspect.stdAppLink') },
      ]
    : [];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, fontSize: 12.5 }}>
        {t('clipinspect.blurb')}
      </p>

      <div className="mod-toolbar">
        <button className="mini primary" disabled={busy} onClick={() => void doRead()}>
          {t('clipinspect.read')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void doRead()}>
          {t('clipinspect.refresh')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 8 }}>
        {status}
      </p>

      {result && (
        <>
          <div
            style={{
              marginTop: 12,
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 10px' }}>
              {t('clipinspect.standardTitle')}
            </h3>
            <div className="kv-list">
              {stdRows.map((row, i) => (
                <div className="kv-row" key={i}>
                  <span
                    style={{
                      width: 18,
                      textAlign: 'center',
                      color: row.present ? 'var(--ok, #3fb950)' : 'var(--text-muted)',
                    }}
                  >
                    {row.present ? '✔' : '—'}
                  </span>
                  <span style={{ color: row.present ? 'inherit' : 'var(--text-muted)' }}>
                    {row.label}
                  </span>
                </div>
              ))}
            </div>

            <h3 className="group-title" style={{ fontSize: 13, margin: '12px 0 6px' }}>
              {t('clipinspect.previewTitle')}
            </h3>
            <p
              className="count-note"
              style={{ marginTop: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {result.textPreview && result.textPreview.length > 0
                ? result.textPreview
                : t('clipinspect.noText')}
            </p>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 8px' }}>
              {t('clipinspect.formatsTitle')}
            </h3>
            {result.formats.length === 0 ? (
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('clipinspect.noFormats')}
              </p>
            ) : (
              <div className="dt-wrap" style={{ maxHeight: 320 }}>
                <table className="dt">
                  <tbody>
                    {result.formats.map((f) => (
                      <tr key={f}>
                        <td>
                          <code>{f}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
