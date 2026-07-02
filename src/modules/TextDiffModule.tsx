import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Row = { type: 'ctx' | 'del' | 'add'; line: string };

function diffLines(a: string[], b: string[], norm: (s: string) => string): Row[] {
  const m = a.length;
  const n = b.length;
  const na = a.map(norm);
  const nb = b.map(norm);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--) dp[i]![j] = na[i] === nb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (na[i] === nb[j]) {
      out.push({ type: 'ctx', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', line: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', line: a[i++]! });
  while (j < n) out.push({ type: 'add', line: b[j++]! });
  return out;
}

export function TextDiffModule() {
  const { t } = useTranslation();
  const [a, setA] = useState('the quick brown fox\njumps over\nthe lazy dog');
  const [b, setB] = useState('the quick red fox\njumps over\nthe lazy cat\nnew line');
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);

  const rows = useMemo(() => {
    const la = a.split(/\r?\n/);
    const lb = b.split(/\r?\n/);
    if (la.length > 2000 || lb.length > 2000) return null; // too large
    const norm = (s: string) => {
      let x = s;
      if (ignoreWs) x = x.replace(/\s+/g, ' ').trim();
      if (ignoreCase) x = x.toLowerCase();
      return x;
    };
    return diffLines(la, lb, norm);
  }, [a, b, ignoreWs, ignoreCase]);

  const added = rows?.filter((r) => r.type === 'add').length ?? 0;
  const removed = rows?.filter((r) => r.type === 'del').length ?? 0;
  const identical = rows != null && added === 0 && removed === 0;

  const copyUnified = () => {
    if (!rows) return;
    const u = rows.map((r) => (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + r.line).join('\n');
    void navigator.clipboard?.writeText(u);
  };

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <label className="chk">
          <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
          {t('diff.ignoreWs')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} />
          {t('diff.ignoreCase')}
        </label>
        <button className="mini" disabled={!rows} onClick={copyUnified}>
          {t('diff.copyUnified')}
        </button>
        <span className="count-note">
          <span style={{ color: 'var(--web)' }}>+{added}</span> · <span style={{ color: 'var(--danger)' }}>−{removed}</span>
        </span>
      </div>
      <div className="io-grid">
        <div>
          <label className="rx-label">{t('diff.aLabel')}</label>
          <textarea className="hosts-edit" spellCheck={false} value={a} onChange={(e) => setA(e.target.value)} />
        </div>
        <div>
          <label className="rx-label">{t('diff.bLabel')}</label>
          <textarea className="hosts-edit" spellCheck={false} value={b} onChange={(e) => setB(e.target.value)} />
        </div>
      </div>

      {rows == null ? (
        <p className="count-note" style={{ marginTop: 12 }}>
          {t('diff.tooLarge')}
        </p>
      ) : identical ? (
        <p className="dep-ok" style={{ marginTop: 12 }}>
          ✓ {t('diff.identical')}
        </p>
      ) : (
        <pre className="diff-out" style={{ marginTop: 12 }}>
          {rows.map((r, i) => (
            <div key={i} className={`diff-${r.type}`}>
              {r.type === 'add' ? '+ ' : r.type === 'del' ? '− ' : '  '}
              {r.line || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
