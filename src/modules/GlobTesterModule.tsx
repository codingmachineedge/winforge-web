import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Glob 樣式測試器 · Glob-to-regex compiler and matcher — pure client port of
// WinForge's GlobTesterService. Supports * (not crossing /), ** (crossing /),
// ?, character classes [abc]/[a-z]/[!abc], and brace alternation {a,b,c}.
// Never throws — compile() returns an error message on invalid input.

type CompileResult = {
  ok: boolean;
  regex: string; // full anchored source for display / matching
  errEn?: string;
  errZh?: string;
};

// A leading-wildcard guard so hidden dot-files aren't matched unless opted in.
const NO_LEADING_DOT = '(?![.])';

// Escape a single literal character for regex.
function escapeLiteral(c: string): string {
  return '.$^{[(|)*+?\\'.indexOf(c) >= 0 ? '\\' + c : c;
}

// [abc] [a-z] [!abc] / [^abc]. Returns the translated class and the index just
// past the closing ']', or an error.
function translateClass(
  glob: string,
  i: number,
): { out?: string; next?: number; errEn?: string; errZh?: string } {
  const n = glob.length;
  let j = i + 1;
  let cls = '[';

  if (j < n && (glob[j] === '!' || glob[j] === '^')) {
    cls += '^';
    j++;
  }
  // A ']' immediately after the (optional) negation is a literal ].
  if (j < n && glob[j] === ']') {
    cls += '\\]';
    j++;
  }

  let closed = false;
  for (; j < n; j++) {
    const c = glob[j]!;
    if (c === ']') {
      closed = true;
      break;
    }
    if (c === '\\') {
      cls += '\\\\';
      continue;
    }
    if (c === '[') {
      cls += '\\[';
      continue;
    }
    // '-' is kept as-is to allow ranges; other regex-special chars inside a class are escaped.
    if (c === '^') {
      cls += '\\^';
      continue;
    }
    cls += c;
  }

  if (!closed) {
    return {
      errEn: 'Unclosed character class — missing \']\'.',
      errZh: '字元類別冇閂 — 唔見咗 \']\'。',
    };
  }

  cls += ']';
  return { out: cls, next: j + 1 };
}

// {a,b,c} alternation → (?:a|b|c). Nested braces are supported. Commas at depth 0 split.
function translateBrace(
  glob: string,
  i: number,
  dotFilesMatch: boolean,
): { out?: string; next?: number; errEn?: string; errZh?: string } {
  const n = glob.length;
  let depth = 0;
  let j = i;
  const parts: string[] = [];
  let cur = '';

  for (; j < n; j++) {
    const c = glob[j]!;
    if (c === '{') {
      depth++;
      if (depth > 1) cur += c;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) {
        parts.push(cur);
        break;
      }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }

  if (depth !== 0 || j >= n) {
    return {
      errEn: 'Unbalanced \'{\' — missing \'}\'.',
      errZh: '\'{\' 唔對稱 — 唔見咗 \'}\'。',
    };
  }

  let out = '(?:';
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) out += '|';
    // Recursively translate each alternative (they may contain globs).
    const sub = translate(parts[p]!, dotFilesMatch);
    if (sub.errEn != null) return { errEn: sub.errEn, errZh: sub.errZh };
    out += sub.body ?? '';
  }
  out += ')';
  return { out, next: j + 1 };
}

function translate(
  glob: string,
  dotFilesMatch: boolean,
): { body?: string; errEn?: string; errZh?: string } {
  let sb = '';
  let i = 0;
  const n = glob.length;

  // Tracks whether we're at the start of a path segment (start of string or just after '/').
  let atSegmentStart = true;

  while (i < n) {
    const c = glob[i]!;
    switch (c) {
      case '*': {
        const doubleStar = i + 1 < n && glob[i + 1] === '*';
        if (!dotFilesMatch && atSegmentStart) sb += NO_LEADING_DOT;
        if (doubleStar) {
          sb += '.*'; // ** crosses '/'
          i += 2;
        } else {
          sb += '[^/]*'; // * does not cross '/'
          i++;
        }
        atSegmentStart = false;
        break;
      }
      case '?': {
        if (!dotFilesMatch && atSegmentStart) sb += NO_LEADING_DOT;
        sb += '[^/]';
        atSegmentStart = false;
        i++;
        break;
      }
      case '[': {
        const r = translateClass(glob, i);
        if (r.errEn != null) return { errEn: r.errEn, errZh: r.errZh };
        sb += r.out!;
        i = r.next!;
        atSegmentStart = false;
        break;
      }
      case '{': {
        const r = translateBrace(glob, i, dotFilesMatch);
        if (r.errEn != null) return { errEn: r.errEn, errZh: r.errZh };
        sb += r.out!;
        i = r.next!;
        atSegmentStart = false;
        break;
      }
      case '}':
        return {
          errEn: 'Unbalanced \'}\' — no matching \'{\'.',
          errZh: '\'}\' 唔對稱 — 搵唔到對應嘅 \'{\'。',
        };
      case ']':
        return {
          errEn: 'Unbalanced \']\' — no matching \'[\'.',
          errZh: '\']\' 唔對稱 — 搵唔到對應嘅 \'[\'。',
        };
      case '/':
        sb += '/';
        atSegmentStart = true;
        i++;
        break;
      default:
        sb += escapeLiteral(c);
        atSegmentStart = false;
        i++;
        break;
    }
  }
  return { body: sb };
}

// Compile a glob into an anchored regex source. Never throws.
function compileGlob(glob: string, dotFilesMatch: boolean): CompileResult {
  try {
    const r = translate(glob ?? '', dotFilesMatch);
    if (r.errEn != null) return { ok: false, regex: '', errEn: r.errEn, errZh: r.errZh };
    return { ok: true, regex: '^' + (r.body ?? '') + '$' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, regex: '', errEn: 'Could not compile pattern: ' + msg, errZh: '無法編譯樣式：' + msg };
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const list: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.length > 0) list.push(line);
  }
  return list;
}

export function GlobTesterModule() {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('src/**/*.{cs,xaml}');
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [dotFiles, setDotFiles] = useState(false);
  const [paths, setPaths] = useState('src/App.cs\nsrc/ui/Main.xaml\nREADME.md');
  const [copied, setCopied] = useState(false);

  // Compile the glob and build a real RegExp matcher (flags: case-insensitivity).
  const compiled = useMemo(() => compileGlob(pattern, dotFiles), [pattern, dotFiles]);
  const matcher = useMemo(() => {
    if (!compiled.ok) return null;
    try {
      return new RegExp(compiled.regex, caseInsensitive ? 'i' : '');
    } catch {
      return null;
    }
  }, [compiled, caseInsensitive]);

  const pathList = useMemo(() => splitLines(paths), [paths]);
  const rows = useMemo(() => {
    if (!matcher) return [];
    return pathList.map((p) => {
      let ok = false;
      try {
        ok = matcher.test(p);
      } catch {
        ok = false;
      }
      return { path: p, ok };
    });
  }, [matcher, pathList]);

  const matched = rows.filter((r) => r.ok).length;

  // Status message mirrors WinForge's Evaluate() severity + text.
  const status: { sev: 'info' | 'ok' | 'err'; msg: string } = (() => {
    if (pattern.length === 0) return { sev: 'info', msg: t('globtester.enterPattern') };
    if (!compiled.ok) return { sev: 'err', msg: t('globtester.invalidPattern') };
    if (pathList.length === 0) return { sev: 'ok', msg: t('globtester.compiledAddPaths') };
    return {
      sev: 'ok',
      msg: t('globtester.compiledOk', { matched: String(matched), total: String(pathList.length) }),
    };
  })();

  const regexText = compiled.ok ? compiled.regex : '';

  const copyRegex = () => {
    if (!regexText) {
      setCopied(false);
      return;
    }
    void navigator.clipboard?.writeText(regexText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const statusColor =
    status.sev === 'err' ? 'var(--danger)' : status.sev === 'ok' ? 'var(--ok, #2e7d32)' : undefined;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('globtester.blurb')}
      </p>

      {/* Pattern + toggles */}
      <div style={{ marginBottom: 12 }}>
        <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          {t('globtester.patternLabel')}
        </label>
        <input
          className="mod-search"
          style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
          spellCheck={false}
          value={pattern}
          placeholder="src/**/*.{cs,xaml}"
          onChange={(e) => setPattern(e.target.value)}
        />
      </div>

      <div className="mod-toolbar" style={{ marginBottom: 12 }}>
        <label className="chk">
          <input type="checkbox" checked={caseInsensitive} onChange={(e) => setCaseInsensitive(e.target.checked)} />
          {t('globtester.caseLabel')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={dotFiles} onChange={(e) => setDotFiles(e.target.checked)} />
          {t('globtester.dotLabel')}
        </label>
      </div>

      {/* Generated regex */}
      <div style={{ marginBottom: 6 }}>
        <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          {t('globtester.regexLabel')}
        </label>
        <div className="mod-toolbar" style={{ gap: 8 }}>
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
            readOnly
            value={regexText}
          />
          <button className="mini" disabled={!regexText} onClick={copyRegex}>
            {copied ? t('globtester.copied') : t('globtester.copy')}
          </button>
        </div>
      </div>

      {status && (
        <p style={{ marginTop: 8, marginBottom: 14, fontSize: 12.5, color: statusColor }}>{status.msg}</p>
      )}

      {/* Paths + results */}
      <div style={{ marginBottom: 12 }}>
        <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          {t('globtester.pathsLabel')}
        </label>
        <textarea
          className="hosts-edit"
          style={{ minHeight: 120, fontFamily: 'Consolas, monospace', whiteSpace: 'pre' }}
          spellCheck={false}
          value={paths}
          placeholder={'src/App.cs\nsrc/ui/Main.xaml\nREADME.md'}
          onChange={(e) => setPaths(e.target.value)}
        />
      </div>

      <label className="count-note" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
        {t('globtester.resultsLabel')}
      </label>
      <div className="kv-list" style={{ maxHeight: 360, overflowY: 'auto' }}>
        {rows.map((r, idx) => (
          <div className="kv-row" key={idx} style={{ alignItems: 'center' }}>
            <span style={{ flex: 1, fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{r.path}</span>
            <span
              style={{
                borderRadius: 10,
                padding: '2px 10px',
                fontSize: 12,
                fontWeight: 600,
                color: 'white',
                background: r.ok ? '#2e7d32' : '#9e9e9e',
              }}
            >
              {r.ok ? t('globtester.match') : t('globtester.noMatch')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
