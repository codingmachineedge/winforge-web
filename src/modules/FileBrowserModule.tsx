import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fsCopy,
  fsList,
  fsMkdir,
  fsMove,
  fsReadText,
  fsRename,
  getEnv,
  isTauri,
  runCommand,
  runPowershell,
  runPowershellJson,
  type FsEntry,
} from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar } from './common';

type SortKey = 'name' | 'size' | 'modified' | 'ext';
type SortDir = 'asc' | 'desc';
type Msg = { kind: 'ok' | 'warn' | 'err'; text: string } | null;

interface DriveInfo {
  Name: string;
  Root: string;
  UsedGB: number;
  FreeGB: number;
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'csv', 'tsv', 'js', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'py', 'rs', 'go', 'c',
  'cpp', 'h', 'cs', 'java', 'rb', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'env', 'gitignore',
]);

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Delete to the Recycle Bin via in-process .NET (Microsoft.VisualBasic FileIO → SHFileOperation
 *  with FOF_ALLOWUNDO). Same in-process pattern as FileLocksmith — no separate helper process. */
function recycleScript(rawPath: string): string {
  const p = rawPath.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$target = '${p}'
if (Test-Path -LiteralPath $target -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
}
'ok'
`;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}\\${name}`;
}

/** Breadcrumb segments from an absolute Windows path. */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    acc = i === 0 ? (seg.endsWith(':') ? `${seg}\\` : seg) : joinPath(acc, seg);
    out.push({ label: seg, path: acc });
  }
  return out;
}

export function FileBrowserModule() {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [addr, setAddr] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [clip, setClip] = useState<{ path: string; name: string; op: 'copy' | 'cut' } | null>(null);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

  const navigate = useCallback(
    async (target: string) => {
      const p = target.trim().replace(/^"|"$/g, '');
      if (!p) return;
      if (!isTauri()) {
        setError(t('filebrowser.desktopOnly'));
        return;
      }
      setLoading(true);
      setError(null);
      setMsg(null);
      try {
        const listing = await fsList(p, showHiddenRef.current);
        setEntries(listing.entries);
        setParent(listing.parent);
        setPath(listing.path);
        setAddr(listing.path);
        setTruncated(listing.truncated);
        setSelected(null);
        setPreview(null);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // Initial load: user profile + drive list.
  useEffect(() => {
    if (!isTauri()) {
      setError(t('filebrowser.desktopOnly'));
      return;
    }
    (async () => {
      try {
        const [home, drv] = await Promise.all([
          getEnv('USERPROFILE'),
          runPowershellJson<DriveInfo>(
            `Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ Name=$_.Name; Root=$_.Root; UsedGB=[math]::Round($_.Used/1GB,1); FreeGB=[math]::Round($_.Free/1GB,1) } }`,
          ).catch(() => [] as DriveInfo[]),
        ]);
        setDrives(drv);
        await navigate(home || (drv[0]?.Root ?? 'C:\\'));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    if (path) navigate(path);
  }, [path, navigate]);

  const sorted = useMemo(() => {
    const rows = [...entries];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1; // folders first, always
      let c = 0;
      if (sortKey === 'name') c = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      else if (sortKey === 'size') c = a.size - b.size;
      else if (sortKey === 'modified') c = a.modified_ms - b.modified_ms;
      else c = a.ext.localeCompare(b.ext) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return c * dir;
    });
    return rows;
  }, [entries, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const openEntry = useCallback(
    async (row: FsEntry) => {
      if (row.is_dir) {
        navigate(row.path);
        return;
      }
      setSelected(row.path);
      if (TEXT_EXT.has(row.ext)) {
        try {
          const text = await fsReadText(row.path, 262144);
          setPreview({ name: row.name, text });
        } catch (e) {
          setPreview({ name: row.name, text: String(e) });
        }
      } else {
        // Open with the default application.
        try {
          await runCommand('cmd', ['/c', 'start', '', row.path]);
        } catch {
          setMsg({ kind: 'warn', text: t('filebrowser.openFailed') });
        }
      }
    },
    [navigate, t],
  );

  const reveal = async (row: FsEntry) => {
    try {
      await runCommand('explorer.exe', ['/select,', row.path]);
    } catch {
      setMsg({ kind: 'warn', text: t('filebrowser.openFailed') });
    }
  };

  const doNewFolder = async () => {
    const name = window.prompt(t('filebrowser.newFolderPrompt'));
    if (!name) return;
    try {
      await fsMkdir(joinPath(path, name));
      setMsg({ kind: 'ok', text: t('filebrowser.created', { name }) });
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('filebrowser.opFailed')}: ${String(e)}` });
    }
  };

  const doRename = async (row: FsEntry) => {
    const next = window.prompt(t('filebrowser.renamePrompt', { name: row.name }), row.name);
    if (!next || next === row.name) return;
    try {
      await fsRename(row.path, joinPath(path, next));
      setMsg({ kind: 'ok', text: t('filebrowser.renamed', { name: row.name, next }) });
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('filebrowser.opFailed')}: ${String(e)}` });
    }
  };

  const doDelete = async (row: FsEntry) => {
    if (!window.confirm(t('filebrowser.confirmDelete', { name: row.name }))) return;
    try {
      const res = await runPowershell(recycleScript(row.path));
      if (res.stdout.trim() !== 'ok' && !res.success) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      setMsg({ kind: 'ok', text: t('filebrowser.deleted', { name: row.name }) });
      if (selected === row.path) setPreview(null);
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('filebrowser.opFailed')}: ${String(e)}` });
    }
  };

  const doPaste = async () => {
    if (!clip) return;
    const dest = joinPath(path, clip.name);
    try {
      if (clip.op === 'copy') await fsCopy(clip.path, dest);
      else await fsMove(clip.path, dest);
      setMsg({ kind: 'ok', text: t(clip.op === 'copy' ? 'filebrowser.copied' : 'filebrowser.moved', { name: clip.name }) });
      setClip(null);
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('filebrowser.opFailed')}: ${String(e)}` });
    }
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const columns: Column<FsEntry>[] = useMemo(
    () => [
      {
        key: 'name',
        header: <button className="fb-sort" onClick={() => toggleSort('name')}>{t('filebrowser.colName')}{sortArrow('name')}</button>,
        render: (r) => (
          <button className={`fb-name${selected === r.path ? ' sel' : ''}`} onClick={() => openEntry(r)} title={r.path}>
            <span className="fb-icon">{r.is_dir ? '📁' : TEXT_EXT.has(r.ext) ? '📄' : '▪'}</span>
            <span className="fb-label">{r.name}</span>
            {r.hidden && <span className="fb-tag">{t('filebrowser.hidden')}</span>}
            {r.readonly && <span className="fb-tag">{t('filebrowser.readonly')}</span>}
          </button>
        ),
      },
      {
        key: 'size',
        header: <button className="fb-sort" onClick={() => toggleSort('size')}>{t('filebrowser.colSize')}{sortArrow('size')}</button>,
        width: 90,
        align: 'right',
        render: (r) => (r.is_dir ? '' : fmtSize(r.size)),
      },
      {
        key: 'modified',
        header: <button className="fb-sort" onClick={() => toggleSort('modified')}>{t('filebrowser.colModified')}{sortArrow('modified')}</button>,
        width: 150,
        render: (r) => fmtDate(r.modified_ms),
      },
      {
        key: 'actions',
        header: t('filebrowser.colActions'),
        width: 280,
        render: (r) => (
          <span className="row-actions">
            <button className="mini" onClick={() => reveal(r)}>{t('filebrowser.reveal')}</button>
            <button className="mini" onClick={() => doRename(r)}>{t('filebrowser.rename')}</button>
            <button className="mini" onClick={() => setClip({ path: r.path, name: r.name, op: 'copy' })}>{t('filebrowser.copy')}</button>
            <button className="mini" onClick={() => setClip({ path: r.path, name: r.name, op: 'cut' })}>{t('filebrowser.cut')}</button>
            <button className="mini danger" onClick={() => doDelete(r)}>{t('filebrowser.delete')}</button>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, selected, sortKey, sortDir],
  );

  const dirCount = entries.filter((e) => e.is_dir).length;
  const fileCount = entries.length - dirCount;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('filebrowser.blurb')}</p>

      <ModuleToolbar>
        <button className="mini" disabled={!parent} onClick={() => parent && navigate(parent)} title={t('filebrowser.up')}>↑ {t('filebrowser.up')}</button>
        <input
          className="mod-search"
          style={{ flex: 1, fontFamily: 'Consolas, monospace' }}
          placeholder={t('filebrowser.addrPlaceholder')}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(addr); }}
        />
        <button className="mini primary" onClick={() => navigate(addr)}>{t('filebrowser.go')}</button>
        <button className="mini" disabled={loading || !path} onClick={refresh}>⟳ {t('modules.refresh')}</button>
        <button className="mini" onClick={doNewFolder} disabled={!path}>+ {t('filebrowser.newFolder')}</button>
        {clip && <button className="mini primary" onClick={doPaste}>{t('filebrowser.paste')} · {clip.name}</button>}
        <label className="fb-toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => { setShowHidden(e.target.checked); if (path) setTimeout(refresh, 0); }} />
          {t('filebrowser.showHidden')}
        </label>
      </ModuleToolbar>

      {drives.length > 0 && (
        <div className="fb-drives">
          {drives.map((d) => (
            <button key={d.Name} className={`fb-drive${path.toUpperCase().startsWith(d.Root.toUpperCase()) ? ' active' : ''}`} onClick={() => navigate(d.Root)}>
              💾 {d.Name}
              <span className="fb-drive-free">{d.FreeGB} GB {t('filebrowser.free')}</span>
            </button>
          ))}
        </div>
      )}

      {path && (
        <div className="fb-crumbs">
          {crumbs(path).map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="fb-sep">›</span>}
              <button className="fb-crumb" onClick={() => navigate(c.path)}>{c.label}</button>
            </span>
          ))}
        </div>
      )}

      {msg && <p className={`mod-msg${msg.kind === 'err' ? ' error' : ''}`}>{msg.text}</p>}

      {loading && <p className="count-note">{t('modules.loading')}</p>}
      {!loading && error && <pre className="cmd-out error">{error}</pre>}

      {!loading && !error && path && (
        <>
          <p className="count-note">
            {t('filebrowser.summary', { dirs: dirCount, files: fileCount })}
            {truncated && ` · ${t('filebrowser.truncated')}`}
          </p>
          <div className={`fb-body${preview ? ' with-preview' : ''}`}>
            <div className="fb-list">
              <DataTable columns={columns} rows={sorted} rowKey={(r) => r.path} empty={t('filebrowser.empty')} />
            </div>
            {preview && (
              <div className="fb-preview">
                <div className="fb-preview-head">
                  <strong>{preview.name}</strong>
                  <button className="mini" onClick={() => setPreview(null)}>{t('filebrowser.closePreview')}</button>
                </div>
                <pre className="cmd-out">{preview.text || t('filebrowser.emptyFile')}</pre>
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        .fb-drives { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
        .fb-drive { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
          border: 1px solid var(--border, #333); border-radius: 6px; background: transparent;
          color: inherit; cursor: pointer; font-size: 12px; }
        .fb-drive.active { border-color: var(--accent, #3b82f6); }
        .fb-drive-free { opacity: 0.6; font-size: 11px; }
        .fb-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-bottom: 8px; }
        .fb-crumb { background: transparent; border: none; color: var(--accent, #3b82f6); cursor: pointer;
          padding: 2px 4px; border-radius: 4px; font-size: 13px; }
        .fb-crumb:hover { background: var(--hover, rgba(255,255,255,0.06)); }
        .fb-sep { opacity: 0.4; margin: 0 2px; }
        .fb-sort { background: transparent; border: none; color: inherit; cursor: pointer; font: inherit; font-weight: 600; padding: 0; }
        .fb-name { display: inline-flex; align-items: center; gap: 8px; background: transparent; border: none;
          color: inherit; cursor: pointer; font: inherit; text-align: left; min-width: 0; width: 100%; padding: 2px 0; }
        .fb-name.sel .fb-label { color: var(--accent, #3b82f6); font-weight: 600; }
        .fb-name:hover .fb-label { text-decoration: underline; }
        .fb-icon { flex: none; }
        .fb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fb-tag { flex: none; font-size: 10px; opacity: 0.6; border: 1px solid var(--border, #333);
          border-radius: 3px; padding: 0 4px; }
        .fb-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
        .fb-body.with-preview { display: grid; grid-template-columns: 1fr minmax(280px, 40%); gap: 12px; align-items: start; }
        .fb-list { min-width: 0; }
        .fb-preview { min-width: 0; }
        .fb-preview-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
        .fb-preview pre { max-height: 480px; overflow: auto; }
      `}</style>
    </div>
  );
}
