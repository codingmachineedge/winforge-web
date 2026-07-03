import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge ClipInspectService / ClipInspectModule — reads the clipboard on
// demand and reports the formats it exposes, which standard types are present, and a
// preview of any text. Read-only: never writes the clipboard. In the browser the
// StandardDataFormats map onto MIME types exposed by ClipboardItem.types.

type Pick = (en: string, zh: string) => string;

interface FormatRow {
  name: string;
}

interface InspectResult {
  ok: boolean;
  error?: string;
  formats: FormatRow[];
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

// Match a StandardDataFormat against the MIME types the browser exposes.
function typesContain(types: readonly string[], needles: string[]): boolean {
  return types.some((tp) => {
    const low = tp.toLowerCase();
    return needles.some((n) => low === n || low.startsWith(n));
  });
}

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

  // Gather every MIME type across all items — this is the browser equivalent of
  // DataPackageView.AvailableFormats.
  const types: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const tp of item.types) {
      if (!seen.has(tp)) {
        seen.add(tp);
        types.push(tp);
      }
    }
  }

  const hasText = typesContain(types, ['text/plain']);
  const hasHtml = typesContain(types, ['text/html']);
  const hasRtf = typesContain(types, ['text/rtf', 'application/rtf']);
  const hasBitmap = typesContain(types, ['image/']);
  const hasWebLink = typesContain(types, ['text/uri-list']);
  // The browser Clipboard API cannot expose file/folder handles or application
  // links the way WinForge's StandardDataFormats do, so these are always absent.
  const hasStorage = false;
  const hasAppLink = false;

  let textPreview: string | undefined;
  if (hasText) {
    try {
      let text = await clip.readText();
      if (text != null) {
        text = text.replace(/\r\n/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ');
        textPreview = text.length > 400 ? text.substring(0, 400) + '…' : text;
      }
    } catch {
      /* text read can throw despite the flag */
    }
  }

  let htmlLen = 0;
  if (hasHtml) {
    try {
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const blob = await item.getType('text/html');
          const html = await blob.text();
          htmlLen = html.length;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    formats: types.map((n) => ({ name: n })),
    hasText,
    hasHtml,
    hasRtf,
    hasBitmap,
    hasStorageItems: hasStorage,
    hasWebLink,
    hasApplicationLink: hasAppLink,
    textPreview,
    htmlLength: htmlLen,
    storageItemCount: 0,
  };
}

interface StdLine {
  present: boolean;
  label: string;
}

function buildStandard(r: InspectResult, pick: Pick): StdLine[] {
  const lines: StdLine[] = [];
  lines.push({ present: r.hasText, label: pick('Text', '文字') });
  lines.push({
    present: r.hasHtml,
    label: r.hasHtml
      ? pick(`HTML (${r.htmlLength} chars)`, `HTML（${r.htmlLength} 字元）`)
      : 'HTML',
  });
  lines.push({ present: r.hasRtf, label: pick('Rich text (RTF)', '格式化文字（RTF）') });
  lines.push({ present: r.hasBitmap, label: pick('Bitmap image', '點陣圖影像') });
  lines.push({
    present: r.hasStorageItems,
    label: r.hasStorageItems
      ? pick(`Files / folders (${r.storageItemCount})`, `檔案／資料夾（${r.storageItemCount}）`)
      : pick('Files / folders', '檔案／資料夾'),
  });
  lines.push({ present: r.hasWebLink, label: pick('Web link', '網頁連結') });
  lines.push({ present: r.hasApplicationLink, label: pick('Application link', '應用程式連結') });
  return lines;
}

export function ClipInspectModule() {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  const pick: Pick = (en, zh) => (isZh ? zh : en);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [status, setStatus] = useState('');

  const read = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(t('clipinspect.reading'));
    try {
      const r = await readClipboard();
      setResult(r);
      if (!r.ok) {
        setStatus(
          r.error === 'unsupported'
            ? t('clipinspect.unsupported')
            : t('clipinspect.readError', { error: r.error ?? '' }),
        );
      } else if (r.formats.length === 0) {
        setStatus(t('clipinspect.empty'));
      } else {
        setStatus(t('clipinspect.readCount', { count: r.formats.length }));
      }
    } catch (e) {
      setResult(null);
      setStatus(t('clipinspect.readError', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const showResult = result && result.ok;
  const std = showResult ? buildStandard(result, pick) : [];
  const previewText =
    showResult
      ? result.textPreview && result.textPreview.length > 0
        ? result.textPreview
        : pick('(no text on the clipboard)', '（剪貼簿冇文字）')
      : '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('clipinspect.blurb')}
      </p>

      <div className="mod-toolbar">
        <button className="mini primary" disabled={busy} onClick={read}>
          {t('clipinspect.read')}
        </button>
        <button className="mini" disabled={busy || !result} onClick={read}>
          {t('clipinspect.refresh')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 6 }}>
        {status || t('clipinspect.pressToRead')}
      </p>

      {showResult && (
        <>
          <section style={{ marginTop: 16 }}>
            <h3 className="group-title" style={{ margin: '0 0 8px', fontSize: 14 }}>
              {t('clipinspect.standardFormats')}
            </h3>
            <dl className="kv">
              {std.map((line, i) => (
                <div className="kv-row" key={i}>
                  <dt style={{ fontFamily: 'monospace' }}>{line.present ? '✔' : '—'}</dt>
                  <dd style={{ opacity: line.present ? 1 : 0.55 }}>{line.label}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 className="group-title" style={{ margin: '0 0 8px', fontSize: 14 }}>
              {t('clipinspect.allFormats')}
            </h3>
            {result.formats.length === 0 ? (
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('clipinspect.noFormats')}
              </p>
            ) : (
              <div className="dt-wrap" style={{ maxHeight: 260 }}>
                <table className="dt">
                  <tbody>
                    {result.formats.map((f, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'monospace' }}>{f.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 className="group-title" style={{ margin: '0 0 8px', fontSize: 14 }}>
              {t('clipinspect.textPreview')}
            </h3>
            <textarea
              className="hosts-edit"
              spellCheck={false}
              readOnly
              value={previewText}
              style={{ minHeight: 100 }}
            />
          </section>
        </>
      )}
    </div>
  );
}
