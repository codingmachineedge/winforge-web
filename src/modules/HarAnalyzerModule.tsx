import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';

interface HarEntry {
  method: string;
  status: number;
  url: string;
  mime: string;
  size: number; // response body bytes (best effort)
  timeMs: number; // total time for the request
}

interface HarResult {
  entries: HarEntry[];
  totalRequests: number;
  totalBytes: number;
  totalTimeMs: number;
  pageLoadMs: number;
  c2xx: number;
  c3xx: number;
  c4xx: number;
  c5xx: number;
  cOther: number;
  byType: Array<[string, number]>;
  slowest: HarEntry | null;
  largest: HarEntry | null;
}

type Analysis = { ok: true; result: HarResult } | { ok: false; error: string };

// Human-readable byte count. Mirrors HarAnalyzerService.HumanBytes.
function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = i === 0 ? Math.round(v).toString() : v.toFixed(1);
  return num + ' ' + units[i]!;
}

function statusClass(status: number): '2' | '3' | '4' | '5' | '' {
  if (status >= 200 && status < 300) return '2';
  if (status >= 300 && status < 400) return '3';
  if (status >= 400 && status < 500) return '4';
  if (status >= 500 && status < 600) return '5';
  return '';
}

const STATUS_COLORS: Record<string, string> = {
  '2': '#4CC26B', // green
  '3': '#5B9BE8', // blue
  '4': '#E8A53B', // amber
  '5': '#E65353', // red
  '': '#9A9A9A', // grey
};

function statusDisplay(status: number): string {
  return status <= 0 ? '—' : String(status);
}

function timeDisplay(timeMs: number): string {
  return timeMs <= 0 ? '—' : Math.round(timeMs).toString() + ' ms';
}

function mimeDisplay(mime: string): string {
  return mime.trim().length === 0 ? '—' : mime;
}

// Bucket a mime type into a coarse resource type. Mirrors TypeBucket.
function typeBucket(mimeRaw: string): string {
  if (!mimeRaw || mimeRaw.trim().length === 0) return 'other';
  const mime = mimeRaw.toLowerCase();
  if (mime.includes('html')) return 'html';
  if (mime.includes('css')) return 'css';
  if (mime.includes('javascript') || mime.includes('ecmascript') || mime.endsWith('/json') || mime.includes('+json'))
    return 'script/json';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('font/') || mime.includes('font')) return 'font';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'media';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

// Read a string property (only if it is genuinely a string).
function readStr(obj: Record<string, unknown>, name: string): string {
  const v = obj[name];
  return typeof v === 'string' ? v : '';
}

// Read a numeric property, accepting numeric strings too. Mirrors TryNum.
function readNum(obj: Record<string, unknown>, name: string): number | null {
  if (!(name in obj)) return null;
  const v = obj[name];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length > 0) {
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Parse a single HAR entry; return null on any trouble so one bad entry
// never aborts the whole file. Mirrors ParseEntry.
function parseEntry(e: unknown): HarEntry | null {
  if (!isObj(e)) return null;
  try {
    let method = '';
    let url = '';
    let status = 0;
    let mime = '';
    let size = 0;

    const req = e['request'];
    if (isObj(req)) {
      method = readStr(req, 'method');
      url = readStr(req, 'url');
    }

    const res = e['response'];
    if (isObj(res)) {
      const st = readNum(res, 'status');
      if (st !== null) status = Math.trunc(st);

      const content = res['content'];
      if (isObj(content)) {
        mime = readStr(content, 'mimeType');
        const sz = readNum(content, 'size');
        if (sz !== null && sz > 0) size = Math.trunc(sz);
      }
      if (size <= 0) {
        const body = readNum(res, 'bodySize');
        if (body !== null && body > 0) size = Math.trunc(body);
      }
      if (size <= 0) {
        const xfer = readNum(res, '_transferSize');
        if (xfer !== null && xfer > 0) size = Math.trunc(xfer);
      }
    }

    if (size <= 0) {
      const xfer2 = readNum(e, '_transferSize');
      if (xfer2 !== null && xfer2 > 0) size = Math.trunc(xfer2);
    }

    let timeMs = 0;
    const t = readNum(e, 'time');
    if (t !== null && t > 0) timeMs = t;

    // Trim a mime like "text/html; charset=utf-8" → "text/html".
    const semi = mime.indexOf(';');
    if (semi > 0) mime = mime.slice(0, semi).trim();

    return { method, status, url, mime, size, timeMs };
  } catch {
    return null;
  }
}

// Analyze a HAR JSON string. Never throws. Mirrors HarAnalyzerService.Analyze.
function analyze(json: string, fail: (en: string, zh: string) => string): Analysis {
  if (!json || json.trim().length === 0) {
    return { ok: false, error: fail('Empty input · 內容係空嘅', '內容係空嘅') };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: fail('Not valid JSON: ', '唔係有效 JSON：') + msg };
  }

  if (!isObj(doc) || !isObj(doc['log'])) {
    return {
      ok: false,
      error: fail('Missing "log" object — is this a HAR file?', '唔見到 "log"，係咪 HAR 檔？'),
    };
  }
  const log = doc['log'];

  let pageLoadMs = 0;
  const pages = log['pages'];
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (isObj(page)) {
        const pt = page['pageTimings'];
        if (isObj(pt)) {
          const onLoad = readNum(pt, 'onLoad');
          if (onLoad !== null && onLoad > 0) {
            pageLoadMs = onLoad;
            break;
          }
        }
      }
    }
  }

  const entriesRaw = log['entries'];
  if (!Array.isArray(entriesRaw)) {
    return { ok: false, error: fail('No "log.entries" array', '冇 "log.entries" 陣列') };
  }

  const entries: HarEntry[] = [];
  let totalBytes = 0;
  let totalTimeMs = 0;
  let c2xx = 0;
  let c3xx = 0;
  let c4xx = 0;
  let c5xx = 0;
  let cOther = 0;
  const byTypeMap = new Map<string, number>();
  let slowest: HarEntry | null = null;
  let largest: HarEntry | null = null;

  for (const raw of entriesRaw) {
    const entry = parseEntry(raw);
    if (entry === null) continue;

    entries.push(entry);
    if (entry.size > 0) totalBytes += entry.size;
    if (entry.timeMs > 0) totalTimeMs += entry.timeMs;

    switch (statusClass(entry.status)) {
      case '2':
        c2xx++;
        break;
      case '3':
        c3xx++;
        break;
      case '4':
        c4xx++;
        break;
      case '5':
        c5xx++;
        break;
      default:
        cOther++;
        break;
    }

    const bucket = typeBucket(entry.mime);
    byTypeMap.set(bucket, (byTypeMap.get(bucket) ?? 0) + 1);

    if (slowest === null || entry.timeMs > slowest.timeMs) slowest = entry;
    if (largest === null || entry.size > largest.size) largest = entry;
  }

  if (entries.length === 0) {
    return { ok: false, error: fail('HAR parsed, but it has 0 entries', 'HAR 讀到喇，但係冇任何請求') };
  }

  const byType = Array.from(byTypeMap.entries()).sort((a, b) => b[1] - a[1]);

  return {
    ok: true,
    result: {
      entries,
      totalRequests: entries.length,
      totalBytes,
      totalTimeMs,
      pageLoadMs,
      c2xx,
      c3xx,
      c4xx,
      c5xx,
      cOther,
      byType,
      slowest,
      largest,
    },
  };
}

function shortUrl(url: string): string {
  if (!url) return '';
  return url.length <= 60 ? url : url.slice(0, 57) + '…';
}

// Build a plain-text report for the clipboard. Mirrors BuildReport.
function buildReport(r: HarResult, p: (en: string, zh: string) => string): string {
  const padStart = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
  const padEnd = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const lines: string[] = [];
  lines.push(p('HAR Analysis Report', 'HAR 分析報告'));
  lines.push('='.repeat(40));
  lines.push(p('Total requests', '請求總數') + ': ' + r.totalRequests);
  lines.push(p('Total transfer', '傳輸總量') + ': ' + humanBytes(r.totalBytes));
  lines.push(p('Total time', '總時間') + ': ' + Math.round(r.totalTimeMs) + ' ms');
  if (r.pageLoadMs > 0) lines.push(p('Page load (onLoad)', '頁面載入 (onLoad)') + ': ' + Math.round(r.pageLoadMs) + ' ms');
  lines.push('');
  lines.push(p('By status class', '按狀態分類') + ':');
  lines.push(
    '  2xx: ' +
      r.c2xx +
      '   3xx: ' +
      r.c3xx +
      '   4xx: ' +
      r.c4xx +
      '   5xx: ' +
      r.c5xx +
      (r.cOther > 0 ? '   ' + p('other', '其他') + ': ' + r.cOther : ''),
  );
  lines.push('');
  lines.push(p('By type', '按類型') + ':');
  for (const [key, count] of r.byType) lines.push('  ' + key + ': ' + count);
  lines.push('');
  if (r.slowest !== null) lines.push(p('Slowest', '最慢') + ': ' + timeDisplay(r.slowest.timeMs) + '  ' + r.slowest.url);
  if (r.largest !== null) lines.push(p('Largest', '最大') + ': ' + humanBytes(r.largest.size) + '  ' + r.largest.url);
  lines.push('');
  lines.push(p('Entries', '請求列表') + ':');
  for (const e of r.entries) {
    lines.push(
      '  ' +
        padEnd(e.method, 6) +
        ' ' +
        padStart(statusDisplay(e.status), 4) +
        '  ' +
        padStart(humanBytes(e.size), 10) +
        '  ' +
        padStart(timeDisplay(e.timeMs), 9) +
        '  ' +
        e.url,
    );
  }
  return lines.join('\n');
}

type SortMode = '0' | '1' | '2';

export function HarAnalyzerModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const p = (en: string, zh: string) => pick(en, zh, lang);

  const [pasteText, setPasteText] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('0');

  const result = analysis && analysis.ok ? analysis.result : null;

  const runAnalyze = (json: string) => {
    const a = analyze(json, (en, zh) => p(en, zh));
    setAnalysis(a);
    if (a.ok) {
      setStatus({ ok: true, msg: t('haranalyzer.analyzed', { count: a.result.totalRequests }) });
    } else {
      setStatus({ ok: false, msg: t('haranalyzer.couldNot') + a.error });
    }
  };

  const onFile = (file: File | null) => {
    if (!file) return;
    setStatus({ ok: true, msg: t('haranalyzer.reading') });
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setPasteText(text);
      runAnalyze(text);
    };
    reader.onerror = () => setStatus({ ok: false, msg: t('haranalyzer.openFailed') });
    reader.readAsText(file);
  };

  const clearAll = () => {
    setAnalysis(null);
    setPasteText('');
    setStatus(null);
    setFilter('');
    setErrorsOnly(false);
    setSortMode('0');
  };

  const copyReport = () => {
    if (!result) {
      setStatus({ ok: false, msg: t('haranalyzer.nothingToCopy') });
      return;
    }
    const report = buildReport(result, p);
    void navigator.clipboard?.writeText(report);
    setStatus({ ok: true, msg: t('haranalyzer.reportCopied') });
  };

  const view = useMemo(() => {
    if (!result) return [];
    let items = result.entries;
    const needle = filter.trim().toLowerCase();
    if (needle.length > 0) items = items.filter((x) => x.url.toLowerCase().includes(needle));
    if (errorsOnly) items = items.filter((x) => x.status >= 400 && x.status < 600);
    if (sortMode === '1') items = [...items].sort((a, b) => b.size - a.size);
    else if (sortMode === '2') items = [...items].sort((a, b) => b.timeMs - a.timeMs);
    return items;
  }, [result, filter, errorsOnly, sortMode]);

  const summaryLine = result
    ? p(
        `${result.totalRequests} requests · ${humanBytes(result.totalBytes)} transferred · ${Math.round(result.totalTimeMs)} ms total` +
          (result.pageLoadMs > 0 ? ` · page load ${Math.round(result.pageLoadMs)} ms` : ''),
        `${result.totalRequests} 個請求 · 傳咗 ${humanBytes(result.totalBytes)} · 合共 ${Math.round(result.totalTimeMs)} 毫秒` +
          (result.pageLoadMs > 0 ? ` · 頁面載入 ${Math.round(result.pageLoadMs)} 毫秒` : ''),
      )
    : '';

  const statusBreakdown = result
    ? p(
        `2xx: ${result.c2xx}    3xx: ${result.c3xx}    4xx: ${result.c4xx}    5xx: ${result.c5xx}` +
          (result.cOther > 0 ? `    other: ${result.cOther}` : ''),
        `2xx：${result.c2xx}    3xx：${result.c3xx}    4xx：${result.c4xx}    5xx：${result.c5xx}` +
          (result.cOther > 0 ? `    其他：${result.cOther}` : ''),
      )
    : '';

  const typeBreakdown =
    result && result.byType.length > 0
      ? p('By type — ', '按類型 — ') + result.byType.map(([k, v]) => `${k}: ${v}`).join('    ')
      : '';

  let highlightLine = '';
  if (result) {
    if (result.slowest !== null)
      highlightLine += p(
        `Slowest: ${timeDisplay(result.slowest.timeMs)} (${shortUrl(result.slowest.url)})`,
        `最慢：${timeDisplay(result.slowest.timeMs)}（${shortUrl(result.slowest.url)}）`,
      );
    if (result.largest !== null)
      highlightLine +=
        (highlightLine.length > 0 ? '    ' : '') +
        p(
          `Largest: ${humanBytes(result.largest.size)} (${shortUrl(result.largest.url)})`,
          `最大：${humanBytes(result.largest.size)}（${shortUrl(result.largest.url)}）`,
        );
  }

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('haranalyzer.blurb')}
      </p>

      {/* Input card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('haranalyzer.loadTitle')}
        </h3>
        <div className="mod-toolbar" style={{ margin: 0 }}>
          <label className="mini primary" style={{ cursor: 'pointer' }}>
            {t('haranalyzer.openFile')}
            <input
              type="file"
              accept=".har,.json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                onFile(e.target.files && e.target.files.length > 0 ? e.target.files[0]! : null);
                e.target.value = '';
              }}
            />
          </label>
          <button className="mini" onClick={() => runAnalyze(pasteText)}>
            {t('haranalyzer.analyzePasted')}
          </button>
          <button className="mini" onClick={clearAll}>
            {t('haranalyzer.clear')}
          </button>
        </div>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 100, fontFamily: 'Consolas, monospace' }}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={t('haranalyzer.pastePlaceholder')}
        />
      </div>

      {status && (
        <p
          className={status.ok ? 'count-note' : ''}
          style={status.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
        >
          {status.msg}
        </p>
      )}

      {result && (
        <>
          {/* Summary card */}
          <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
              {t('haranalyzer.summary')}
            </h3>
            <span className="count-note" style={{ margin: 0 }}>
              {summaryLine}
            </span>
            <span style={{ fontSize: 13 }}>{statusBreakdown}</span>
            {typeBreakdown && (
              <span className="count-note" style={{ margin: 0 }}>
                {typeBreakdown}
              </span>
            )}
            {highlightLine && <span style={{ fontSize: 13 }}>{highlightLine}</span>}
          </div>

          {/* Filter + sort row */}
          <div className="mod-toolbar" style={{ marginTop: 14 }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 160 }}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('haranalyzer.filterPlaceholder')}
            />
            <label className="chk">
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
              {t('haranalyzer.errorsOnly')}
            </label>
            <select className="mod-select" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
              <option value="0">{t('haranalyzer.sortOriginal')}</option>
              <option value="1">{t('haranalyzer.sortLargest')}</option>
              <option value="2">{t('haranalyzer.sortSlowest')}</option>
            </select>
            <button className="mini" onClick={copyReport}>
              {t('haranalyzer.copyReport')}
            </button>
          </div>

          <span className="count-note" style={{ display: 'block', marginTop: 8 }}>
            {t('haranalyzer.showing', { shown: view.length, total: result.totalRequests })}
          </span>

          {/* Entries table */}
          <div className="dt-wrap" style={{ maxHeight: 460, marginTop: 8 }}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('haranalyzer.colMethod')}</th>
                  <th style={{ textAlign: 'left' }}>{t('haranalyzer.colStatus')}</th>
                  <th style={{ textAlign: 'left' }}>URL</th>
                  <th style={{ textAlign: 'left' }}>{t('haranalyzer.colType')}</th>
                  <th style={{ textAlign: 'right' }}>{t('haranalyzer.colSize')}</th>
                  <th style={{ textAlign: 'right' }}>{t('haranalyzer.colTime')}</th>
                </tr>
              </thead>
              <tbody>
                {view.map((e, idx) => (
                  <tr key={idx}>
                    <td style={{ fontFamily: 'monospace' }}>{e.method}</td>
                    <td
                      style={{
                        fontFamily: 'monospace',
                        fontWeight: 600,
                        color: STATUS_COLORS[statusClass(e.status)],
                      }}
                    >
                      {statusDisplay(e.status)}
                    </td>
                    <td
                      style={{
                        maxWidth: 380,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={e.url}
                    >
                      {e.url}
                    </td>
                    <td style={{ opacity: 0.7 }}>{mimeDisplay(e.mime)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{humanBytes(e.size)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{timeDisplay(e.timeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
