import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// ---- engine: faithful port of WinForge TextReplaceService ---------------

interface Rule {
  id: number;
  find: string;
  replace: string;
  regex: boolean;
  ignoreCase: boolean;
}

interface RuleOutcome {
  hits: number;
  errorEn: string;
  errorZh: string;
}

interface ApplyResult {
  output: string;
  totalReplacements: number;
  anyError: boolean;
  outcomes: RuleOutcome[];
}

/** Count ordinal (optionally case-insensitive) occurrences of needle in haystack. */
function countLiteral(haystack: string, needle: string, ignoreCase: boolean): number {
  if (!needle) return 0;
  const hay = ignoreCase ? haystack.toLowerCase() : haystack;
  const nee = ignoreCase ? needle.toLowerCase() : needle;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = hay.indexOf(nee, idx);
    if (found < 0) break;
    count++;
    idx = found + nee.length;
  }
  return count;
}

/** Ordinal literal replace (case-sensitive or -insensitive), mirroring the C# service. */
function replaceLiteral(haystack: string, needle: string, replacement: string, ignoreCase: boolean): string {
  if (!needle) return haystack;
  if (!ignoreCase) return haystack.split(needle).join(replacement);
  const hayLower = haystack.toLowerCase();
  const neeLower = needle.toLowerCase();
  let out = '';
  let idx = 0;
  while (true) {
    const found = hayLower.indexOf(neeLower, idx);
    if (found < 0) {
      out += haystack.slice(idx);
      break;
    }
    out += haystack.slice(idx, found);
    out += replacement;
    idx = found + needle.length;
  }
  return out;
}

/**
 * Expand a .NET-style replacement string against a regex match. Supports $1..$9 / ${name} /
 * $& (whole match) / $$ (literal $). Approximates System.Text.RegularExpressions Match.Result.
 */
function expandReplacement(replacement: string, match: RegExpExecArray, groups: Record<string, string> | undefined): string {
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i]!;
    if (ch !== '$' || i === replacement.length - 1) {
      out += ch;
      continue;
    }
    const next = replacement[i + 1]!;
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += match[0] ?? '';
      i++;
    } else if (next === '{') {
      const end = replacement.indexOf('}', i + 2);
      if (end < 0) {
        out += ch;
      } else {
        const name = replacement.slice(i + 2, end);
        if (/^\d+$/.test(name)) {
          out += match[Number(name)] ?? '';
        } else if (groups && name in groups) {
          out += groups[name] ?? '';
        }
        i = end;
      }
    } else if (next >= '0' && next <= '9') {
      // Greedy up to two digits, like .NET.
      let digits = next;
      let consumed = 1;
      const third = replacement[i + 2];
      if (third !== undefined && third >= '0' && third <= '9' && match[Number(digits + third)] !== undefined) {
        digits += third;
        consumed = 2;
      }
      const gi = Number(digits);
      out += match[gi] ?? '';
      i += consumed;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Apply all rules in order. Never throws; reports per-rule hits/errors. */
function applyRules(input: string, rules: Rule[], t: TFunction): ApplyResult {
  const outcomes: RuleOutcome[] = [];
  let text = input ?? '';
  let total = 0;
  let anyError = false;

  for (const rule of rules) {
    const outcome: RuleOutcome = { hits: 0, errorEn: '', errorZh: '' };
    outcomes.push(outcome);

    if (!rule.find) continue;

    try {
      if (rule.regex) {
        let flags = 'g';
        if (rule.ignoreCase) flags += 'i';
        // Named groups / dotAll differences aside, this mirrors the C# transform.
        let re: RegExp;
        try {
          re = new RegExp(rule.find, flags + 'u');
        } catch {
          // Retry without the unicode flag for patterns invalid only under /u.
          re = new RegExp(rule.find, flags);
        }
        let count = 0;
        let result = '';
        let lastIndex = 0;
        let m: RegExpExecArray | null;
        // Guard against pathological loops on the client.
        const maxIterations = 1_000_000;
        let iterations = 0;
        while ((m = re.exec(text)) !== null) {
          if (++iterations > maxIterations) break;
          count++;
          result += text.slice(lastIndex, m.index);
          result += expandReplacement(rule.replace ?? '', m, m.groups);
          lastIndex = m.index + m[0].length;
          // Avoid infinite loop on zero-width matches.
          if (m[0].length === 0) {
            if (re.lastIndex < text.length) {
              result += text[re.lastIndex]!;
            }
            re.lastIndex++;
            lastIndex = re.lastIndex;
          }
        }
        result += text.slice(lastIndex);
        outcome.hits = count;
        total += count;
        text = result;
      } else {
        const count = countLiteral(text, rule.find, rule.ignoreCase);
        if (count > 0) {
          text = replaceLiteral(text, rule.find, rule.replace ?? '', rule.ignoreCase);
          outcome.hits = count;
          total += count;
        }
      }
    } catch (err) {
      anyError = true;
      const msg = err instanceof Error ? err.message : String(err);
      outcome.errorEn = t('textreplace.invalidRegex', { msg });
      outcome.errorZh = t('textreplace.invalidRegex', { msg });
    }
  }

  return { output: text, totalReplacements: total, anyError, outcomes };
}

// ---- component ----------------------------------------------------------

let nextId = 1;
const makeRule = (): Rule => ({ id: nextId++, find: '', replace: '', regex: false, ignoreCase: false });

export function TextReplaceModule() {
  const { t } = useTranslation();
  const [input, setInput] = useState('The quick brown fox jumps over the lazy dog.');
  const [rules, setRules] = useState<Rule[]>(() => [{ id: nextId++, find: 'quick', replace: 'slow', regex: false, ignoreCase: false }]);
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => applyRules(input, rules, t), [input, rules, t]);

  const addRule = () => setRules((rs) => [...rs, makeRule()]);
  const removeRule = (id: number) =>
    setRules((rs) => {
      const next = rs.filter((r) => r.id !== id);
      return next.length === 0 ? [makeRule()] : next;
    });
  const updateRule = (id: number, patch: Partial<Rule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const copy = () => {
    if (!result.output) return;
    navigator.clipboard?.writeText(result.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const totalMsg = result.anyError
    ? t('textreplace.totalError', { count: result.totalReplacements })
    : t('textreplace.total', { count: result.totalReplacements });

  return (
    <div className="mod">
      <p className="count-note">{t('textreplace.blurb')}</p>

      <div className="io-grid" style={{ marginTop: 8 }}>
        <div>
          <label className="label">{t('textreplace.inputLabel')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('textreplace.inputLabel')}
          />
        </div>
        <div>
          <label className="label">{t('textreplace.outputLabel')}</label>
          <textarea className="hosts-edit" spellCheck={false} readOnly value={result.output} placeholder={t('textreplace.outputLabel')} />
        </div>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        <span className="label">{t('textreplace.rulesLabel')}</span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <button className="mini" onClick={addRule}>{t('textreplace.addRule')}</button>
          <button className="mini primary" disabled={!result.output} onClick={copy}>
            {copied ? t('textreplace.copied') : t('textreplace.copyOutput')}
          </button>
        </span>
      </div>

      <div className="kv-list">
        {rules.map((r, i) => {
          const outcome = result.outcomes[i];
          const hits = outcome ? outcome.hits : 0;
          const errorEn = outcome ? outcome.errorEn : '';
          return (
            <div className="panel" key={r.id} style={{ marginTop: 8 }}>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  className="mod-search"
                  style={{ flex: '1 1 180px', fontFamily: 'monospace' }}
                  value={r.find}
                  onChange={(e) => updateRule(r.id, { find: e.target.value })}
                  placeholder={t('textreplace.findHeader')}
                />
                <input
                  className="mod-search"
                  style={{ flex: '1 1 180px', fontFamily: 'monospace' }}
                  value={r.replace}
                  onChange={(e) => updateRule(r.id, { replace: e.target.value })}
                  placeholder={t('textreplace.replaceHeader')}
                />
                <label className="chk">
                  <input type="checkbox" checked={r.regex} onChange={(e) => updateRule(r.id, { regex: e.target.checked })} />{' '}
                  {t('textreplace.regexLabel')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={r.ignoreCase} onChange={(e) => updateRule(r.id, { ignoreCase: e.target.checked })} />{' '}
                  {t('textreplace.ignoreCaseLabel')}
                </label>
                <button className="mini" onClick={() => removeRule(r.id)}>{t('textreplace.remove')}</button>
              </div>
              {(hits > 0 || errorEn) && (
                <p
                  className="count-note"
                  style={{ marginTop: 6, marginBottom: 0, color: errorEn ? 'var(--danger)' : undefined }}
                >
                  {errorEn ? errorEn : t('textreplace.hits', { count: hits })}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="count-note" style={{ marginTop: 10, color: result.anyError ? 'var(--danger)' : undefined }}>
        {totalMsg}
      </p>
    </div>
  );
}
