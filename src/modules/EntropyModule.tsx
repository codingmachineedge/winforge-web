import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Interpretation = 'utf8' | 'raw' | 'hex';

interface SymbolFreq {
  symbol: string;
  count: number;
  percent: number;
  percentText: string;
  bar: string;
}

interface Report {
  ok: boolean;
  error?: string;
  count: number;
  unique: number;
  alphabetSize: number;
  entropy: number;
  totalInfo: number;
  maxEntropy: number;
  percentOfMax: number;
  chiSquare: number;
  top: SymbolFreq[];
}

const EMPTY_REPORT: Report = {
  ok: false,
  count: 0,
  unique: 0,
  alphabetSize: 0,
  entropy: 0,
  totalInfo: 0,
  maxEntropy: 0,
  percentOfMax: 0,
  chiSquare: 0,
  top: [],
};

function log2(x: number): number {
  return Math.log(x) / Math.LN2;
}

function isHexDigit(c: string): boolean {
  return /[0-9A-Fa-f]/.test(c);
}

function hexVal(c: string): number {
  const code = c.charCodeAt(0);
  return code <= 57 /* '9' */ ? code - 48 : c.toUpperCase().charCodeAt(0) - 65 + 10;
}

// Parse a hex string (spaces/commas/0x prefixes tolerated). Returns bytes or an error sentinel.
function tryParseHex(input: string): { bytes: number[] } | { error: string } {
  let sb = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (/\s/.test(c) || c === ',' || c === ':' || c === '-' || c === '_') continue;
    if (c === '0' && i + 1 < input.length && (input[i + 1] === 'x' || input[i + 1] === 'X')) {
      i++;
      continue;
    }
    if (isHexDigit(c)) {
      sb += c;
      continue;
    }
    return { error: '__BADHEX__' };
  }
  if (sb.length === 0) return { error: '__EMPTY__' };
  if (sb.length % 2 !== 0) return { error: '__ODDHEX__' };
  const bytes: number[] = [];
  for (let i = 0; i < sb.length / 2; i++) {
    bytes.push((hexVal(sb[i * 2]!) << 4) | hexVal(sb[i * 2 + 1]!));
  }
  return { bytes };
}

function toHex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

// Turn a stored symbol key into a human-readable label.
function display(key: string, mode: Interpretation): string {
  if (mode === 'raw') {
    if (key.length === 1) {
      const c = key;
      if (c === ' ') return '␠ (space)';
      if (c === '\t') return '\\t';
      if (c === '\n') return '\\n';
      if (c === '\r') return '\\r';
      const code = c.charCodeAt(0);
      // control chars: C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F)
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
      }
    }
    return key;
  }
  return '0x' + key;
}

function makeBar(count: number, max: number): string {
  if (max <= 0) return '';
  let len = Math.round((count / max) * 20.0);
  if (len < 1) len = 1;
  return '█'.repeat(len);
}

// Split raw text into surrogate-safe symbols (per Unicode code point).
function toCodePoints(s: string): string[] {
  return Array.from(s);
}

function analyze(input: string, mode: Interpretation, topN = 24): Report {
  try {
    let symbols: string[];

    if (mode === 'utf8') {
      const bytes = new TextEncoder().encode(input);
      symbols = Array.from(bytes, (b) => toHex2(b));
    } else if (mode === 'hex') {
      const parsed = tryParseHex(input);
      if ('error' in parsed) return { ...EMPTY_REPORT, error: parsed.error };
      symbols = parsed.bytes.map((b) => toHex2(b));
    } else {
      symbols = toCodePoints(input);
    }

    const n = symbols.length;
    if (n === 0) return { ...EMPTY_REPORT, error: '__EMPTY__' };

    const freq = new Map<string, number>();
    for (const s of symbols) {
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }

    const unique = freq.size;
    let entropy = 0.0;
    for (const c of freq.values()) {
      const p = c / n;
      if (p > 0) entropy -= p * log2(p);
    }

    const alphabet = mode === 'raw' ? unique : 256;
    const maxEntropy = alphabet > 1 ? log2(alphabet) : 0.0;

    // Chi-square against a uniform distribution over the observed alphabet.
    const expected = n / unique;
    let chi = 0.0;
    if (expected > 0) {
      for (const c of freq.values()) {
        const diff = c - expected;
        chi += (diff * diff) / expected;
      }
    }

    let maxCount = 0;
    for (const c of freq.values()) if (c > maxCount) maxCount = c;

    const top: SymbolFreq[] = Array.from(freq.entries())
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, Math.max(1, topN))
      .map(([key, c]) => {
        const percent = (c / n) * 100.0;
        return {
          symbol: display(key, mode),
          count: c,
          percent,
          percentText: percent.toFixed(2) + '%',
          bar: makeBar(c, maxCount),
        };
      });

    return {
      ok: true,
      count: n,
      unique,
      alphabetSize: alphabet,
      entropy,
      totalInfo: entropy * n,
      maxEntropy,
      percentOfMax: maxEntropy > 0 ? Math.min(100.0, (entropy / maxEntropy) * 100.0) : 0.0,
      chiSquare: chi,
      top,
    };
  } catch (e) {
    return { ...EMPTY_REPORT, error: e instanceof Error ? e.message : String(e) };
  }
}

export function EntropyModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Interpretation>('utf8');
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState('');

  const report = useMemo(() => analyze(input, mode), [input, mode]);

  const errorText = (err: string | undefined): string => {
    switch (err) {
      case '__EMPTY__':
        return t('entropy.errEmpty');
      case '__BADHEX__':
        return t('entropy.errBadHex');
      case '__ODDHEX__':
        return t('entropy.errOddHex');
      default:
        return t('entropy.errGeneric');
    }
  };

  const metricsText = useMemo(() => {
    if (!report.ok) return '—';
    const lines = [
      t('entropy.mEntropy') + report.entropy.toFixed(4) + t('entropy.uBitsSymbol'),
      t('entropy.mTotal') + report.totalInfo.toFixed(1) + t('entropy.uBits'),
      t('entropy.mMax') + report.maxEntropy.toFixed(4) + t('entropy.uBitsAlphabet', { size: report.alphabetSize }),
      t('entropy.mPercent') + report.percentOfMax.toFixed(2) + '%',
      t('entropy.mSymbols') + `${report.count.toLocaleString()} / ${report.unique.toLocaleString()}`,
      t('entropy.mChi') + report.chiSquare.toFixed(2),
    ];
    return lines.join('\n');
  }, [report, t]);

  const statusText = useMemo(() => {
    if (!report.ok) return errorText(report.error);
    return t('entropy.summary', {
      n: report.count.toLocaleString(),
      unique: report.unique.toLocaleString(),
      pct: report.percentOfMax.toFixed(1),
    });
  }, [report, t]);

  const copyReport = () => {
    if (!report.ok) {
      setMsg(t('entropy.nothingToCopy'));
      return;
    }
    const parts: string[] = [];
    parts.push(t('entropy.reportTitle'));
    parts.push(metricsText);
    parts.push('');
    parts.push(t('entropy.tableHeader'));
    for (const row of report.top) {
      parts.push(`${row.symbol}\t${row.count}\t${row.percentText}`);
    }
    void navigator.clipboard?.writeText(parts.join('\n'));
    setMsg(t('entropy.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('entropy.blurb')}
      </p>

      <div className="mod-toolbar">
        <span className="count-note">{t('entropy.modeLabel')}</span>
        <select
          className="mod-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as Interpretation)}
        >
          <option value="utf8">{t('entropy.modeUtf8')}</option>
          <option value="raw">{t('entropy.modeRaw')}</option>
          <option value="hex">{t('entropy.modeHex')}</option>
        </select>
      </div>

      <textarea
        className="hosts-edit"
        spellCheck={false}
        style={{ minHeight: 110, width: '100%', marginTop: 10 }}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('entropy.inputPlaceholder')}
      />
      <p className="count-note" style={{ marginTop: 8 }}>
        {statusText}
      </p>

      <h3 className="group-title" style={{ fontSize: 15, margin: '18px 0 6px' }}>
        {t('entropy.metricsTitle')}
      </h3>
      <pre
        style={{
          fontFamily: 'ui-monospace, Consolas, monospace',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {metricsText}
      </pre>

      <div className="mod-toolbar" style={{ marginTop: 18 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0, flex: 1 }}>
          {t('entropy.histoTitle')}
        </h3>
        <button className="mini" onClick={copyReport}>
          {t('entropy.copyReport')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      {report.ok && report.top.length > 0 && (
        <div className="dt-wrap" style={{ maxHeight: 420, marginTop: 8 }}>
          <table className="dt">
            <tbody>
              {report.top.map((row, i) => (
                <tr key={`${row.symbol}-${i}`}>
                  <td style={{ fontFamily: 'ui-monospace, Consolas, monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.symbol}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, Consolas, monospace', textAlign: 'right' }}>
                    {row.count}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, Consolas, monospace', textAlign: 'right' }}>
                    {row.percentText}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--accent)' }}>
                    {row.bar}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
