import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface MatchRow {
  text: string;
  index: number;
  groups: string[];
  named: Record<string, string>;
}

// .NET uses ${name}; JS uses $<name>. Translate for the replacement preview.
const toJsReplacement = (r: string) => r.replace(/\$\{(\w+)\}/g, '$<$1>');

export function RegexTesterModule() {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('(?<word>\\w+)');
  const [flags, setFlags] = useState({ i: false, m: false, s: false });
  const [test, setTest] = useState('The quick brown fox');
  const [replacement, setReplacement] = useState('[$1]');

  const result = useMemo(() => {
    if (!pattern) return { status: 'empty' as const };
    let re: RegExp;
    try {
      re = new RegExp(pattern, `g${flags.i ? 'i' : ''}${flags.m ? 'm' : ''}${flags.s ? 's' : ''}`);
    } catch (e) {
      return { status: 'error' as const, msg: String(e instanceof Error ? e.message : e) };
    }
    const rows: MatchRow[] = [];
    for (const m of test.matchAll(re)) {
      rows.push({
        text: m[0],
        index: m.index ?? 0,
        groups: m.slice(1).map((g) => g ?? ''),
        named: (m.groups as Record<string, string>) ?? {},
      });
      if (m[0] === '' && re.lastIndex < test.length) re.lastIndex++; // avoid zero-width infinite loop
      if (rows.length > 500) break;
    }
    let preview = '';
    try {
      preview = test.replace(new RegExp(pattern, re.flags), toJsReplacement(replacement));
    } catch {
      preview = '';
    }
    return { status: 'ok' as const, rows, preview };
  }, [pattern, flags, test, replacement]);

  const cheat = [
    '.   any character (except newline)',
    '\\d  digit   \\D  non-digit',
    '\\w  word char (a-z 0-9 _)   \\W  non-word',
    '\\s  whitespace   \\S  non-whitespace',
    '^   start   $   end   \\b  word boundary',
    '*   0+   +   1+   ?   0 or 1   {n,m} n..m',
    '[abc] any of   [^abc] none of   (...) group',
    '(?<name>...) named   (?:...) non-capturing',
  ];

  return (
    <div className="mod">
      <div className="mod-form">
        <input
          className="mod-search rx-pattern"
          spellCheck={false}
          placeholder={t('regex.patternPlaceholder')}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
      </div>
      <div className="mod-toolbar">
        {(['i', 'm', 's'] as const).map((f) => (
          <label key={f} className="chk">
            <input type="checkbox" checked={flags[f]} onChange={(e) => setFlags({ ...flags, [f]: e.target.checked })} />
            {t(`regex.flag_${f}`)}
          </label>
        ))}
        <span
          className={result.status === 'error' ? '' : 'dep-ok'}
          style={result.status === 'error' ? { color: 'var(--danger)', fontSize: 12.5 } : {}}
        >
          {result.status === 'empty'
            ? t('regex.enterPattern')
            : result.status === 'error'
              ? `${t('regex.invalid')} ${result.msg}`
              : t('regex.matchCount', { count: result.rows.length })}
        </span>
      </div>

      <div className="io-grid">
        <div>
          <label className="rx-label">{t('regex.testInput')}</label>
          <textarea className="hosts-edit" spellCheck={false} value={test} onChange={(e) => setTest(e.target.value)} />
        </div>
        <div>
          <label className="rx-label">{t('regex.replacement')}</label>
          <input className="mod-search" style={{ width: '100%', marginBottom: 8 }} value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          <textarea className="hosts-edit" style={{ minHeight: 250 }} spellCheck={false} readOnly value={result.status === 'ok' ? result.preview : ''} placeholder={t('regex.result')} />
        </div>
      </div>

      {result.status === 'ok' && result.rows.length > 0 && (
        <div className="dt-wrap" style={{ marginTop: 12, maxHeight: 260 }}>
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th style={{ width: 70 }}>{t('regex.pos')}</th>
                <th>{t('regex.match')}</th>
                <th>{t('regex.groups')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.index}</td>
                  <td>
                    <code>{r.text}</code>
                  </td>
                  <td className="env-val">
                    {[...r.groups.map((g, gi) => `$${gi + 1}=${g}`), ...Object.entries(r.named).map(([k, v]) => `${k}=${v}`)].join('  ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="group-title" style={{ fontSize: 14 }}>
        {t('regex.cheatsheet')}
      </h3>
      <pre className="cmd-out" style={{ maxHeight: 'none' }}>{cheat.join('\n')}</pre>
    </div>
  );
}
