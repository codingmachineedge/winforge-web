import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot } from './common';

interface Hit {
  Name: string;
  Path: string;
  Parent: string;
  IsDir: boolean;
  Size: number;
  Modified: string;
}

const LIMIT = 1000;

// Client-side result refinement, mirroring the desktop module's controls.
type KindFilter = 'all' | 'files' | 'folders';
type SortKey = 'relevance' | 'name' | 'size' | 'modified';

// PowerShell-single-quote escape.
function q(s: string): string {
  return s.replace(/'/g, "''");
}

function humanSize(bytes: number, dir: boolean): string {
  if (dir || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// Port of FileIndexService.RelevanceScore — exact > prefix > word-boundary > substring.
function relevanceScore(name: string, qLower: string): number {
  const lower = name.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx < 0) return 1; // matched by regex/wildcard but no literal substring
  if (lower.length === qLower.length) return 1000; // exact name
  if (idx === 0) return 600; // prefix
  const prev = lower[idx - 1];
  if (prev === ' ' || prev === '_' || prev === '-' || prev === '.' || prev === '(' || prev === '[') return 400;
  return 200;
}

// Leaf-name extension, lowercased and without the dot ('' for none / dotfiles / folders).
function extOf(h: Hit): string {
  if (h.IsDir) return '';
  const dot = h.Name.lastIndexOf('.');
  return dot > 0 ? h.Name.slice(dot + 1).toLowerCase() : '';
}

export function EverythingSearchModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';

  // Default scope: the user's profile — fast, always readable, no admin needed.
  const [root, setRoot] = useState('%USERPROFILE%');
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [rows, setRows] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [searched, setSearched] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [regexError, setRegexError] = useState(false);

  // Client-side result refinement (applied to the fetched hits, no OS work).
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [extFilter, setExtFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('relevance');
  const [showCommand, setShowCommand] = useState(false);

  // Build the read-only recursive PowerShell name filter. Extracted so the command
  // preview shows exactly what will run. For wildcard mode we use -Filter (fast,
  // provider-level); for regex we enumerate then -match on the leaf name. Errors
  // (access denied on some subfolders) are silently skipped.
  const buildScript = (pat: string): string => {
    const rootExpr = `[Environment]::ExpandEnvironmentVariables('${q(root)}')`;
    const projection = `@{N='Name';E={$_.Name}},@{N='Path';E={$_.FullName}},@{N='Parent';E={if($_.PSIsContainer){$_.FullName}else{$_.DirectoryName}}},@{N='IsDir';E={[bool]$_.PSIsContainer}},@{N='Size';E={if($_.PSIsContainer){-1}else{[int64]$_.Length}}},@{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}}`;
    if (useRegex) {
      return `$rx='${q(pat)}'; Get-ChildItem -LiteralPath (${rootExpr}) -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $rx } | Select-Object -First ${LIMIT + 1} ${projection}`;
    }
    // Ensure a wildcard search matches substrings even without explicit * ?.
    const wild = /[*?]/.test(pat) ? pat : `*${pat}*`;
    return `Get-ChildItem -LiteralPath (${rootExpr}) -Recurse -Force -Filter '${q(wild)}' -ErrorAction SilentlyContinue | Select-Object -First ${LIMIT + 1} ${projection}`;
  };

  // Command preview: the query the toolbar currently describes (falls back to a
  // placeholder pattern so the preview is meaningful before the first search).
  const commandPreview = useMemo(
    () => buildScript(query.trim() || (useRegex ? '\\.log$' : 'report')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, root, useRegex],
  );

  const runSearch = async () => {
    const pat = query.trim();
    if (!pat) return;

    // Validate regex client-side so we can warn like the desktop module does.
    if (useRegex) {
      try {
        void new RegExp(pat);
        setRegexError(false);
      } catch {
        setRegexError(true);
        setRows([]);
        setSearched(true);
        setCapped(false);
        return;
      }
    } else {
      setRegexError(false);
    }

    setLoading(true);
    setError(null);
    setCopyMsg(null);

    const script = buildScript(pat);

    try {
      const hits = await runPowershellJson<Hit>(script);
      setCapped(hits.length > LIMIT);
      setRows(hits.slice(0, LIMIT));
      setSearched(true);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setRows([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void runSearch();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg(`${t('everything.copied')}: ${text}`);
    } catch {
      setCopyMsg(text);
    }
  };

  // Apply the client-side filters/sort to the fetched rows. Relevance sort ports
  // FileIndexService's ordering (score, then shorter name, then alphabetical).
  const viewRows = useMemo(() => {
    const qLower = query.trim().toLowerCase();
    const wantedExts = extFilter
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^[.*]+/, '').toLowerCase())
      .filter(Boolean);

    let out = rows.filter((h) => {
      if (kindFilter === 'files' && h.IsDir) return false;
      if (kindFilter === 'folders' && !h.IsDir) return false;
      if (wantedExts.length && !wantedExts.includes(extOf(h))) return false;
      return true;
    });

    out = [...out].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
        case 'size':
          return b.Size - a.Size;
        case 'modified':
          return b.Modified.localeCompare(a.Modified);
        case 'relevance':
        default: {
          const c = relevanceScore(b.Name, qLower) - relevanceScore(a.Name, qLower);
          if (c !== 0) return c;
          const d = a.Name.length - b.Name.length;
          if (d !== 0) return d;
          return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
        }
      }
    });
    return out;
  }, [rows, query, kindFilter, extFilter, sortKey]);

  // Export the current (filtered/sorted) view. TSV pastes cleanly into a spreadsheet.
  const exportRows = (fmt: 'tsv' | 'paths') => {
    if (viewRows.length === 0) return;
    const text =
      fmt === 'paths'
        ? viewRows.map((h) => h.Path).join('\r\n')
        : [
            ['Name', 'Path', 'Kind', 'Size', 'Modified'].join('\t'),
            ...viewRows.map((h) =>
              [h.Name, h.Path, h.IsDir ? 'folder' : 'file', h.IsDir ? '' : String(h.Size), h.Modified].join('\t'),
            ),
          ].join('\r\n');
    void copy(text);
  };

  const columns: Column<Hit>[] = useMemo(
    () => [
      {
        key: 'kind',
        header: t('everything.kind'),
        width: 70,
        render: (h) => <StatusDot ok={!h.IsDir} label={h.IsDir ? t('everything.folder') : t('everything.file')} />,
      },
      { key: 'Name', header: t('everything.name'), width: 240 },
      {
        key: 'Path',
        header: t('everything.path'),
        render: (h) => <span className="path-cell">{h.Path}</span>,
      },
      {
        key: 'Size',
        header: t('everything.size'),
        width: 100,
        align: 'right',
        render: (h) => humanSize(h.Size, h.IsDir),
      },
      { key: 'Modified', header: t('everything.modified'), width: 140 },
      {
        key: 'actions',
        header: '',
        width: 210,
        render: (h) => (
          <span className="row-actions">
            <button className="mini" onClick={() => copy(h.Parent)}>
              {t('everything.copyContaining')}
            </button>
            <button className="mini" onClick={() => copy(h.Path)}>
              {t('everything.copyPath')}
            </button>
          </span>
        ),
      },
    ],
    [t],
  );

  const baseStatus = capped
    ? t('everything.showingFirst', { limit: LIMIT.toLocaleString() })
    : t('everything.matches', { num: rows.length.toLocaleString() });
  // When client-side filters hide some rows, note the visible-vs-total count.
  const filteredStatus =
    viewRows.length !== rows.length
      ? pick(
          `Showing ${viewRows.length.toLocaleString()} of ${rows.length.toLocaleString()} (filtered)`,
          `顯示 ${rows.length.toLocaleString()} 個之中嘅 ${viewRows.length.toLocaleString()} 個（已篩選）`,
          lang,
        )
      : null;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('everything.blurb')}
      </p>

      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('everything.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="reg-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
          {t('everything.regex')}
        </label>
        <button className="mini primary" onClick={() => void runSearch()} disabled={loading || !query.trim()}>
          {loading ? t('everything.searching') : t('everything.search')}
        </button>
      </ModuleToolbar>

      <ModuleToolbar>
        <label className="count-note" style={{ marginBottom: 0 }}>
          {t('everything.scope')}
        </label>
        <select className="mod-search" value={root} onChange={(e) => setRoot(e.target.value)}>
          <option value="%USERPROFILE%">{t('everything.scopeProfile')}</option>
          <option value="%USERPROFILE%\\Documents">{t('everything.scopeDocuments')}</option>
          <option value="%USERPROFILE%\\Downloads">{t('everything.scopeDownloads')}</option>
          <option value="%USERPROFILE%\\Desktop">{t('everything.scopeDesktop')}</option>
          <option value="C:\\">{t('everything.scopeSystemDrive')}</option>
        </select>
        <span className="count-note">{t('everything.scopeNote')}</span>
      </ModuleToolbar>

      {/* Client-side refinement of the fetched results (no OS work). */}
      <ModuleToolbar>
        <label className="count-note" style={{ marginBottom: 0 }}>
          {pick('Show', '顯示', lang)}
        </label>
        <select
          className="mod-search"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as KindFilter)}
        >
          <option value="all">{pick('Files and folders', '檔案同資料夾', lang)}</option>
          <option value="files">{pick('Files only', '只顯示檔案', lang)}</option>
          <option value="folders">{pick('Folders only', '只顯示資料夾', lang)}</option>
        </select>
        <label className="count-note" style={{ marginBottom: 0 }}>
          {pick('Sort', '排序', lang)}
        </label>
        <select className="mod-search" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="relevance">{pick('Relevance', '相關度', lang)}</option>
          <option value="name">{pick('Name', '名稱', lang)}</option>
          <option value="size">{pick('Size (largest)', '大細（由大到細）', lang)}</option>
          <option value="modified">{pick('Modified (newest)', '修改時間（最新）', lang)}</option>
        </select>
        <input
          className="mod-search"
          style={{ width: 160 }}
          placeholder={pick('Extensions e.g. pdf, txt', '副檔名，例如 pdf, txt', lang)}
          value={extFilter}
          onChange={(e) => setExtFilter(e.target.value)}
        />
      </ModuleToolbar>

      {/* Command preview + export — render in the browser; no execution here. */}
      <ModuleToolbar>
        <button className="mini" onClick={() => setShowCommand((v) => !v)}>
          {showCommand ? pick('Hide command', '隱藏指令', lang) : pick('Show command', '顯示指令', lang)}
        </button>
        <button className="mini" onClick={() => void copy(commandPreview)}>
          {pick('Copy command', '複製指令', lang)}
        </button>
        <button className="mini" onClick={() => exportRows('paths')} disabled={viewRows.length === 0}>
          {pick('Copy all paths', '複製全部路徑', lang)}
        </button>
        <button className="mini" onClick={() => exportRows('tsv')} disabled={viewRows.length === 0}>
          {pick('Export table (TSV)', '匯出表格（TSV）', lang)}
        </button>
      </ModuleToolbar>

      {showCommand && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="kv-row">
            <span className="count-note">
              {pick(
                'Preview of the read-only PowerShell run natively in the desktop app.',
                '桌面版原生執行嘅唯讀 PowerShell 指令預覽。',
                lang,
              )}
            </span>
          </div>
          <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {commandPreview}
          </pre>
        </div>
      )}

      {regexError && <p className="mod-msg">{t('everything.invalidRegex')}</p>}
      {copyMsg && <p className="mod-msg">{copyMsg}</p>}

      {searched ? (
        <>
          {!loading && !error && (
            <p className="count-note">{filteredStatus ? `${baseStatus} · ${filteredStatus}` : baseStatus}</p>
          )}
          <AsyncState loading={loading} error={error}>
            <DataTable
              columns={columns}
              rows={viewRows}
              rowKey={(h, i) => `${h.Path}::${i}`}
              empty={t('everything.noMatches')}
            />
          </AsyncState>
        </>
      ) : (
        <p className="count-note">{loading ? t('everything.searching') : t('everything.startTyping')}</p>
      )}
    </div>
  );
}
