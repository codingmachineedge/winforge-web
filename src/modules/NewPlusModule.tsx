import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson, type CommandOutput } from '../tauri/bridge';

// Native module — a clone of PowerToys "New+": create files and folders from user-defined
// templates. All pure filesystem work (list / add / rename / delete templates, and
// "create from template" with date/variable substitution) runs through the WinForge desktop
// backend via PowerShell. The browser has no filesystem access, so live actions are gated
// on isTauri(); the variable preview is computed locally and works everywhere.

interface TemplateItem {
  path: string;
  name: string;
  isFolder: boolean;
  ext: string;
  size: number;
  modified: string;
}

// PowerShell single-quoted string escape.
const esc = (s: string) => s.replace(/'/g, "''");

// Default templates root: %LOCALAPPDATA%\WinForge\NewPlusTemplates (matches the C# service).
const ROOT_PS = "$env:LOCALAPPDATA + '\\WinForge\\NewPlusTemplates'";

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} ${units[u]!}` : `${v.toFixed(1)} ${units[u]!}`;
}

// Replace invalid filename characters with a space (mirrors NewPlusService.SanitizeName).
function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, ' ').trim();
}

// Strip leading sort digits and one separator, mirroring NewPlusService.RemoveStartingDigits.
function removeStartingDigits(fileName: string, isFolder: boolean): string {
  if (!fileName) return fileName;
  const dot = isFolder ? -1 : fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  let i = 0;
  while (i < stem.length && stem[i]! >= '0' && stem[i]! <= '9') i++;
  if (i === 0) return fileName; // no leading digits
  if (i === stem.length) return fileName; // all digits — keep
  let j = i;
  const cj = stem[j];
  if (j < stem.length && (cj === '.' || cj === ' ')) {
    j++;
    const cj2 = stem[j];
    if (j < stem.length && ((cj === '.' && cj2 === ' ') || (cj === ' ' && cj2 === '.'))) j++;
  }
  const newStem = stem.slice(j);
  if (!newStem) return fileName;
  return newStem + ext;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => (n < 10 ? '0' + n : String(n));

// Resolve date/variable tokens locally for the live preview (mirrors ResolveVariables).
function resolveVariables(input: string, parentFolderName: string): string {
  if (!input) return input;
  const now = new Date();
  let hour12 = now.getHours() % 12;
  if (hour12 === 0) hour12 = 12;
  const DOLLAR = 'DOLLAR';
  let s = input.split('$$').join(DOLLAR);
  const map: [string, string][] = [
    ['$YYYY', String(now.getFullYear())],
    ['$YY', pad(now.getFullYear() % 100)],
    ['$Y', String(now.getFullYear() % 10)],
    ['$MMMM', MONTHS[now.getMonth()]!],
    ['$MMM', MONTHS[now.getMonth()]!.slice(0, 3)],
    ['$MM', pad(now.getMonth() + 1)],
    ['$M', String(now.getMonth() + 1)],
    ['$DDDD', DAYS[now.getDay()]!],
    ['$DDD', DAYS[now.getDay()]!.slice(0, 3)],
    ['$DD', pad(now.getDate())],
    ['$D', String(now.getDate())],
    ['$hh', pad(now.getHours())],
    ['$h', String(now.getHours())],
    ['$HH', pad(hour12)],
    ['$H', String(hour12)],
    ['$mm', pad(now.getMinutes())],
    ['$m', String(now.getMinutes())],
    ['$ss', pad(now.getSeconds())],
    ['$s', String(now.getSeconds())],
    ['$TT', now.getHours() < 12 ? 'AM' : 'PM'],
    ['$tt', now.getHours() < 12 ? 'am' : 'pm'],
  ];
  for (const [token, value] of map) s = s.split(token).join(value);
  if (parentFolderName) s = s.split('$PARENT_FOLDER_NAME').join(parentFolderName);
  s = s.split(DOLLAR).join('$');
  return s;
}

// PowerShell that lists templates as JSON (folders first, then files, ordinal-sorted).
function listScript(): string {
  return (
    `$root = ${ROOT_PS}; ` +
    `New-Item -ItemType Directory -Force -Path $root | Out-Null; ` +
    `$dirs = Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue | ` +
    `  Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::Hidden) -and -not ($_.Attributes -band [IO.FileAttributes]::System) } | Sort-Object Name; ` +
    `$files = Get-ChildItem -LiteralPath $root -File -Force -ErrorAction SilentlyContinue | ` +
    `  Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::Hidden) -and -not ($_.Attributes -band [IO.FileAttributes]::System) } | Sort-Object Name; ` +
    `$out = @(); ` +
    `foreach ($d in $dirs) { $sz = (Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum; ` +
    `  $out += [pscustomobject]@{ path=$d.FullName; name=$d.Name; isFolder=$true; ext=''; size=[long]($sz); modified=$d.LastWriteTime.ToString('yyyy-MM-dd HH:mm') } } ` +
    `foreach ($f in $files) { $out += [pscustomobject]@{ path=$f.FullName; name=$f.Name; isFolder=$false; ext=$f.Extension.ToLower(); size=[long]$f.Length; modified=$f.LastWriteTime.ToString('yyyy-MM-dd HH:mm') } } ` +
    `$out`
  );
}

// Append " (n)" before the extension until the path is free.
function uniqueScriptFn(): string {
  return (
    `function Get-UniquePath([string]$p, [bool]$isDir) { ` +
    `  if (-not (Test-Path -LiteralPath $p)) { return $p } ` +
    `  $dir = Split-Path -Parent $p; ` +
    `  if ($isDir) { $stem = Split-Path -Leaf $p; $ext = '' } else { $stem = [IO.Path]::GetFileNameWithoutExtension($p); $ext = [IO.Path]::GetExtension($p) } ` +
    `  for ($n=1; $n -lt 10000; $n++) { $c = Join-Path $dir ($stem + ' (' + $n + ')' + $ext); if (-not (Test-Path -LiteralPath $c)) { return $c } } ` +
    `  return $p } `
  );
}

export function NewPlusModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [rows, setRows] = useState<TemplateItem[] | null>(null);
  const [selected, setSelected] = useState<string>(''); // selected template path
  const [dest, setDest] = useState<string>('');
  const [newName, setNewName] = useState<string>('');
  const [replaceVars, setReplaceVars] = useState<boolean>(true);
  const [blankName, setBlankName] = useState<string>('');
  const [blankKind, setBlankKind] = useState<'file' | 'folder'>('file');
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const sel = rows?.find((r) => r.path === selected) ?? null;

  const reload = useCallback(async () => {
    if (!desktop) return;
    setBusy('list');
    setErr(null);
    try {
      const items = await runPowershellJson<TemplateItem>(listScript());
      setRows(items);
      if (selected && !items.some((i) => i.path === selected)) setSelected('');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setRows([]);
    } finally {
      setBusy('');
    }
  }, [desktop, selected]);

  useEffect(() => {
    if (!desktop) return;
    // Default the destination to the Desktop, then load templates.
    (async () => {
      try {
        const res = await runPowershell(`[Environment]::GetFolderPath('DesktopDirectory')`);
        const d = (res.stdout || '').trim();
        if (d) setDest(d);
      } catch {
        /* best effort */
      }
      void reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const report = (res: CommandOutput, okMsg: string) => {
    if (res.success) {
      setInfo(okMsg);
      setErr(null);
    } else {
      setErr(res.stderr.trim() || `exit ${res.code}`);
      setInfo(null);
    }
  };

  const openFolder = async () => {
    if (!desktop) return;
    setBusy('open');
    setErr(null);
    setInfo(null);
    try {
      const res = await runPowershell(`$root = ${ROOT_PS}; New-Item -ItemType Directory -Force -Path $root | Out-Null; Start-Process explorer.exe $root`);
      report(res, t('newplus.opened'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const createBlank = async () => {
    if (!desktop) return;
    const name = sanitizeName(blankName);
    if (!name) {
      setErr(t('newplus.errEmptyName'));
      return;
    }
    setBusy('blank');
    setErr(null);
    setInfo(null);
    try {
      const mkItem =
        blankKind === 'folder'
          ? `New-Item -ItemType Directory -Path $dest | Out-Null`
          : `New-Item -ItemType File -Path $dest | Out-Null`;
      const script =
        `$root = ${ROOT_PS}; New-Item -ItemType Directory -Force -Path $root | Out-Null; ` +
        uniqueScriptFn() +
        `$dest = Get-UniquePath (Join-Path $root '${esc(name)}') $${blankKind === 'folder' ? 'true' : 'false'}; ` +
        mkItem;
      const res = await runPowershell(script);
      report(res, t('newplus.blankCreated'));
      setBlankName('');
      await reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const renameSel = async () => {
    if (!desktop || !sel) return;
    const raw = window.prompt(t('newplus.renamePrompt'), sel.name);
    if (raw == null) return;
    const name = sanitizeName(raw);
    if (!name) {
      setErr(t('newplus.errEmptyName'));
      return;
    }
    setBusy('rename');
    setErr(null);
    setInfo(null);
    try {
      const script =
        uniqueScriptFn() +
        `$src = '${esc(sel.path)}'; $parent = Split-Path -Parent $src; ` +
        `$dest = Get-UniquePath (Join-Path $parent '${esc(name)}') ([bool]$${sel.isFolder ? 'true' : 'false'}); ` +
        `Move-Item -LiteralPath $src -Destination $dest`;
      const res = await runPowershell(script);
      report(res, t('newplus.renamed'));
      await reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const deleteSel = async () => {
    if (!desktop || !sel) return;
    if (!window.confirm(t('newplus.deleteConfirm', { name: sel.name }))) return;
    setBusy('delete');
    setErr(null);
    setInfo(null);
    try {
      const res = await runPowershell(`Remove-Item -LiteralPath '${esc(sel.path)}' -Recurse -Force`);
      report(res, t('newplus.deleted'));
      setSelected('');
      await reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const createFromTemplate = async () => {
    if (!desktop || !sel) {
      setErr(t('newplus.errPickTemplate'));
      return;
    }
    if (!dest.trim()) {
      setErr(t('newplus.errPickDest'));
      return;
    }
    setBusy('create');
    setErr(null);
    setInfo(null);
    try {
      // Resolve the target name locally (variables + sanitize), matching the C# flow.
      const parentName = dest.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      let target = newName.trim() ? newName.trim() : removeStartingDigits(sel.name, sel.isFolder);
      if (replaceVars) target = resolveVariables(target, parentName);
      target = sanitizeName(target);
      if (!target) {
        setErr(t('newplus.errResolvedEmpty'));
        setBusy('');
        return;
      }
      const copy = sel.isFolder
        ? `Copy-Item -LiteralPath $src -Destination $dest -Recurse`
        : `Copy-Item -LiteralPath $src -Destination $dest`;
      const script =
        uniqueScriptFn() +
        `$src = '${esc(sel.path)}'; $folder = '${esc(dest.trim())}'; ` +
        `if (-not (Test-Path -LiteralPath $folder)) { throw 'Destination folder does not exist' } ` +
        `$dest = Get-UniquePath (Join-Path $folder '${esc(target)}') ([bool]$${sel.isFolder ? 'true' : 'false'}); ` +
        copy +
        `; Write-Output (Split-Path -Leaf $dest)`;
      const res = await runPowershell(script);
      if (res.success) {
        const made = (res.stdout || '').trim() || target;
        setInfo(t('newplus.created', { name: made }));
        setErr(null);
      } else {
        setErr(res.stderr.trim() || `exit ${res.code}`);
        setInfo(null);
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Live preview of the resulting name.
  const previewName = (() => {
    if (!sel) return '';
    const parentName = dest.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    let raw = newName.trim() ? newName.trim() : removeStartingDigits(sel.name, sel.isFolder);
    if (replaceVars) raw = resolveVariables(raw, parentName);
    return sanitizeName(raw);
  })();

  const variables: [string, string][] = [
    ['$YYYY', t('newplus.varYYYY')],
    ['$YY', t('newplus.varYY')],
    ['$MMMM', t('newplus.varMMMM')],
    ['$MMM', t('newplus.varMMM')],
    ['$MM', t('newplus.varMM')],
    ['$DDDD', t('newplus.varDDDD')],
    ['$DD', t('newplus.varDD')],
    ['$hh', t('newplus.varHH')],
    ['$mm', t('newplus.varMM2')],
    ['$ss', t('newplus.varSS')],
    ['$TT', t('newplus.varTT')],
    ['$PARENT_FOLDER_NAME', t('newplus.varParent')],
    ['%VAR%', t('newplus.varEnv')],
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('newplus.blurb')}
      </p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('newplus.desktopOnly')}
        </p>
      )}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 220 }}
          placeholder={t('newplus.blankPlaceholder')}
          value={blankName}
          onChange={(e) => setBlankName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && desktop && createBlank()}
        />
        <select className="mod-select" value={blankKind} onChange={(e) => setBlankKind(e.target.value === 'folder' ? 'folder' : 'file')}>
          <option value="file">{t('newplus.kindFile')}</option>
          <option value="folder">{t('newplus.kindFolder')}</option>
        </select>
        <button className="mini primary" disabled={!desktop || !!busy} onClick={createBlank}>
          {busy === 'blank' ? t('newplus.working') : t('newplus.newBlank')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={openFolder}>
          {t('newplus.openFolder')}
        </button>
        <button className="mini" disabled={!desktop || !!busy} onClick={() => void reload()}>
          {busy === 'list' ? t('newplus.working') : t('newplus.refresh')}
        </button>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {info && !err && <p className="count-note" style={{ color: 'var(--accent, inherit)' }}>{info}</p>}

      <div className="panel">
        {rows && rows.length > 0 ? (
          <table className="dt">
            <thead>
              <tr>
                <th>{t('newplus.colName')}</th>
                <th>{t('newplus.colKind')}</th>
                <th style={{ textAlign: 'right' }}>{t('newplus.colSize')}</th>
                <th>{t('newplus.colModified')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.path}
                  onClick={() => setSelected(r.path)}
                  style={{ cursor: 'pointer', background: r.path === selected ? 'var(--sel, rgba(127,127,127,0.15))' : undefined }}
                >
                  <td>{r.name}</td>
                  <td>{r.isFolder ? t('newplus.kindFolder') : r.ext || t('newplus.kindFile')}</td>
                  <td style={{ textAlign: 'right' }}>{humanSize(r.size)}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.modified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="count-note" style={{ margin: 8 }}>
            {desktop ? (busy === 'list' ? t('newplus.working') : t('newplus.empty')) : t('newplus.emptyWeb')}
          </p>
        )}
        {rows && rows.length > 0 && (
          <p className="count-note" style={{ marginTop: 8 }}>
            {t('newplus.countNote', { count: rows.length })}
          </p>
        )}
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!desktop || !sel || !!busy} onClick={renameSel}>
          {t('newplus.rename')}
        </button>
        <button className="mini" disabled={!desktop || !sel || !!busy} onClick={deleteSel}>
          {t('newplus.delete')}
        </button>
      </div>

      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('newplus.createTitle')}</p>
        <div className="kv-list">
          <div className="kv-row">
            <span className="label">{t('newplus.selected')}</span>
            <span className="value">{sel ? `${sel.name} (${sel.isFolder ? t('newplus.kindFolder') : sel.ext || t('newplus.kindFile')})` : t('newplus.none')}</span>
          </div>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <label className="count-note">{t('newplus.dest')}</label>
          <input
            className="mod-search"
            style={{ minWidth: 260, flex: 1 }}
            placeholder={t('newplus.destPlaceholder')}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          />
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <label className="count-note">{t('newplus.newNameLabel')}</label>
          <input
            className="mod-search"
            style={{ minWidth: 220, flex: 1 }}
            placeholder={t('newplus.newNamePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <label className="chk" style={{ marginTop: 8, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={replaceVars} onChange={(e) => setReplaceVars(e.target.checked)} />
          {t('newplus.substVars')}
        </label>
        {sel && previewName && (
          <p className="count-note" style={{ marginTop: 8 }}>
            {t('newplus.willCreate', { name: previewName })}
          </p>
        )}
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini primary" disabled={!desktop || !sel || !!busy} onClick={createFromTemplate}>
            {busy === 'create' ? t('newplus.working') : t('newplus.create')}
          </button>
        </div>
      </div>

      <div className="panel">
        <p className="label" style={{ marginTop: 0 }}>{t('newplus.varsTitle')}</p>
        <p className="count-note" style={{ marginTop: 0 }}>{t('newplus.varsHelp')}</p>
        <div className="kv-list">
          {variables.map(([token, meaning]) => (
            <div className="kv-row" key={token}>
              <span className="label" style={{ fontFamily: 'monospace' }}>{token}</span>
              <span className="value">{meaning}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="count-note">{t('newplus.note')}</p>
    </div>
  );
}
