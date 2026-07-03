import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershellJson } from '../tauri/bridge';

// Native module — in-app batch rename (PowerRename-style), a faithful port of the pure-C#
// RenameEngine + RenameModule. Pick a folder, find/replace (plain or regex) with case
// sensitivity and optional extension inclusion, live preview with conflict detection, then
// apply via a two-phase temp-move rename. Real filesystem work runs only in the WinForge
// desktop app, so the live actions are gated on isTauri() and driven through PowerShell.

interface Row {
  old: string;
  neu: string;
  changed: boolean;
  conflict: boolean;
}

// Escape a JS string for embedding inside a PowerShell single-quoted literal.
const psq = (s: string) => s.replace(/'/g, "''");

// PowerShell that lists the files in a folder and returns their names as JSON.
function listScript(folder: string): string {
  return (
    `Get-ChildItem -LiteralPath '${psq(folder)}' -File -Force | ` +
    `ForEach-Object { [pscustomobject]@{ name = $_.Name } }`
  );
}

// Faithful port of RenameEngine.NewName — plain or regex find/replace, case sensitivity,
// optional extension inclusion. Never throws: an invalid regex leaves the name unchanged.
function newName(
  fileName: string,
  find: string,
  replace: string,
  regex: boolean,
  caseSensitive: boolean,
  includeExt: boolean,
): string {
  if (!find) return fileName;

  let namePart: string;
  let ext: string;
  if (includeExt) {
    namePart = fileName;
    ext = '';
  } else {
    const dot = fileName.lastIndexOf('.');
    if (dot > 0) {
      namePart = fileName.slice(0, dot);
      ext = fileName.slice(dot);
    } else {
      namePart = fileName;
      ext = '';
    }
  }
  const repl = replace ?? '';

  try {
    if (regex) {
      const flags = caseSensitive ? 'g' : 'gi';
      const re = new RegExp(find, flags);
      return namePart.replace(re, repl) + ext;
    }
    return replacePlain(namePart, find, repl, caseSensitive) + ext;
  } catch {
    return fileName; // invalid regex -> leave unchanged
  }
}

// Plain (non-regex) replace-all, honouring case sensitivity — mirrors RenameEngine.ReplacePlain.
function replacePlain(input: string, find: string, replace: string, caseSensitive: boolean): string {
  const hay = caseSensitive ? input : input.toLowerCase();
  const needle = caseSensitive ? find : find.toLowerCase();
  let out = '';
  let i = 0;
  while (true) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, idx);
    out += replace;
    i = idx + find.length;
  }
  return out;
}

// Mirrors RenameEngine.IsValidName: reject blank names and any Windows-invalid filename char.
// Invalid set: < > : " / \ | ? * and control chars (0x00-0x1F). Built from char codes to
// avoid any regex-range ambiguity.
const INVALID_CODES = new Set<number>([0x3c, 0x3e, 0x3a, 0x22, 0x2f, 0x5c, 0x7c, 0x3f, 0x2a]);
function hasInvalidChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || INVALID_CODES.has(code)) return true;
  }
  return false;
}
function isValidName(name: string): boolean {
  return name.trim().length > 0 && !hasInvalidChar(name);
}

export function RenameModule() {
  const { t } = useTranslation();
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeExt, setIncludeExt] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ done: number; failed: number } | null>(null);
  const desktop = isTauri();

  const loadFiles = async () => {
    const f = folder.trim();
    if (!f) return;
    setBusy('load');
    setErr(null);
    setResult(null);
    try {
      const list = await runPowershellJson<{ name: string }>(listScript(f));
      setFiles(list.map((r) => r.name).filter((n): n is string => typeof n === 'string'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setFiles([]);
    } finally {
      setBusy('');
    }
  };

  // Compute preview rows + conflict detection — mirrors Recompute().
  const computed: Array<{ o: string; n: string }> = files.map((o) => ({
    o,
    n: newName(o, find, replace, regex, caseSensitive, includeExt),
  }));

  const finalCounts = new Map<string, number>();
  for (const c of computed) {
    const key = c.n.toLowerCase();
    finalCounts.set(key, (finalCounts.get(key) ?? 0) + 1);
  }
  const changedOriginals = new Set<string>();
  for (const c of computed) {
    if (c.n !== c.o) changedOriginals.add(c.o.toLowerCase());
  }
  const existingLower = new Set(files.map((f) => f.toLowerCase()));

  const rows: Row[] = [];
  let changes = 0;
  let conflicts = 0;
  for (const { o, n } of computed) {
    const changed = n !== o;
    let conflict = false;
    if (changed) {
      const invalid = !isValidName(n);
      const dup = (finalCounts.get(n.toLowerCase()) ?? 0) > 1;
      const collidesExisting =
        existingLower.has(n.toLowerCase()) && !changedOriginals.has(n.toLowerCase());
      conflict = invalid || dup || collidesExisting;
      if (conflict) conflicts++;
      else changes++;
    }
    rows.push({ old: o, neu: n, changed, conflict });
  }

  // Apply the rename plan via a two-phase temp-move (mirrors Apply_Click). Only non-conflicting,
  // valid, actually-changed names are moved. Runs entirely in PowerShell against the real FS.
  const applyRename = async () => {
    const f = folder.trim();
    if (!f || changes < 1) return;
    setBusy('apply');
    setErr(null);
    setResult(null);

    const plan: Array<{ old: string; neu: string }> = [];
    for (const { o, n } of computed) {
      if (n === o || !isValidName(n)) continue;
      if ((finalCounts.get(n.toLowerCase()) ?? 0) !== 1) continue;
      const collidesExisting =
        existingLower.has(n.toLowerCase()) && !changedOriginals.has(n.toLowerCase());
      if (collidesExisting) continue;
      plan.push({ old: o, neu: n });
    }
    if (plan.length < 1) {
      setBusy('');
      return;
    }

    // Build a two-phase move script: every source -> unique temp, then temp -> final name.
    const stamp = Date.now();
    const lines: string[] = [`$done=0; $failed=0; $base='${psq(f)}'; $moves=@()`];
    plan.forEach(({ old, neu }, i) => {
      const temp = `.wf_${i}_${stamp}.wtmp`;
      lines.push(
        `try { Move-Item -LiteralPath (Join-Path $base '${psq(old)}') -Destination (Join-Path $base '${psq(temp)}') -Force -ErrorAction Stop; ` +
          `$moves += ,@('${psq(temp)}','${psq(neu)}') } catch { $failed++ }`,
      );
    });
    lines.push(
      `foreach ($m in $moves) { try { Move-Item -LiteralPath (Join-Path $base $m[0]) -Destination (Join-Path $base $m[1]) -Force -ErrorAction Stop; $done++ } catch { $failed++ } }`,
    );
    lines.push(`[pscustomobject]@{ done = $done; failed = $failed }`);

    try {
      const out = await runPowershellJson<{ done: number; failed: number }>(lines.join('; '));
      const first = out[0];
      setResult({ done: first?.done ?? 0, failed: first?.failed ?? plan.length });
      await loadFiles();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note error">{t('brename.desktopOnly')}</p>}
      <p className="count-note">{t('brename.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('brename.folder')}</label>
        <input
          className="mod-search"
          style={{ minWidth: 280, flex: 1 }}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && loadFiles()}
          placeholder={t('brename.folderPh')}
        />
        <button className="mini primary" disabled={!desktop || !!busy || !folder.trim()} onClick={loadFiles}>
          {busy === 'load' ? t('brename.loading') : t('brename.load')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder={t('brename.findPh')}
        />
        <input
          className="mod-search"
          style={{ maxWidth: 200 }}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder={t('brename.replacePh')}
        />
        <label className="chk">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> {t('brename.regex')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />{' '}
          {t('brename.caseSensitive')}
        </label>
        <label className="chk">
          <input type="checkbox" checked={includeExt} onChange={(e) => setIncludeExt(e.target.checked)} />{' '}
          {t('brename.includeExt')}
        </label>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!desktop || !!busy || changes < 1} onClick={applyRename}>
          {busy === 'apply' ? t('brename.applying') : t('brename.apply')}
        </button>
        <span className="count-note">
          {files.length < 1 ? t('brename.noFolder') : t('brename.counts', { changes, conflicts })}
        </span>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {result && (
        <p className={result.failed === 0 ? 'count-note dep-ok' : 'count-note error'}>
          {t('brename.renamed', { done: result.done, failed: result.failed })}
        </p>
      )}

      {rows.length > 0 && (
        <div className="dt-wrap panel">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('brename.oldName')}</th>
                <th>{t('brename.newName')}</th>
                <th>{t('brename.statusCol')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.old}-${i}`}>
                  <td style={{ fontFamily: 'monospace' }}>{r.old}</td>
                  <td
                    style={{
                      fontFamily: 'monospace',
                      fontWeight: r.changed ? 600 : 400,
                      color: r.conflict
                        ? 'var(--danger)'
                        : r.changed
                          ? 'var(--text)'
                          : 'var(--text-tertiary)',
                    }}
                  >
                    {r.neu}
                  </td>
                  <td className={r.conflict ? 'error' : r.changed ? 'dep-ok' : ''}>
                    {r.conflict
                      ? t('brename.conflict')
                      : r.changed
                        ? t('brename.willChange')
                        : t('brename.unchanged')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="count-note">{t('brename.note')}</p>
    </div>
  );
}
