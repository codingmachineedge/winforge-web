import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

export function EverythingSearchModule() {
  const { t } = useTranslation();

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

    // Build a read-only recursive name filter. For wildcard mode we use -Filter
    // (fast, provider-level). For regex we enumerate then -match on the leaf name.
    // Errors (access denied on some subfolders) are silently skipped.
    const rootExpr = `[Environment]::ExpandEnvironmentVariables('${q(root)}')`;
    let script: string;
    if (useRegex) {
      script = `$rx='${q(pat)}'; Get-ChildItem -LiteralPath (${rootExpr}) -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $rx } | Select-Object -First ${LIMIT + 1} @{N='Name';E={$_.Name}},@{N='Path';E={$_.FullName}},@{N='Parent';E={if($_.PSIsContainer){$_.FullName}else{$_.DirectoryName}}},@{N='IsDir';E={[bool]$_.PSIsContainer}},@{N='Size';E={if($_.PSIsContainer){-1}else{[int64]$_.Length}}},@{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}}`;
    } else {
      // Ensure a wildcard search matches substrings even without explicit * ?.
      const wild = /[*?]/.test(pat) ? pat : `*${pat}*`;
      script = `Get-ChildItem -LiteralPath (${rootExpr}) -Recurse -Force -Filter '${q(wild)}' -ErrorAction SilentlyContinue | Select-Object -First ${LIMIT + 1} @{N='Name';E={$_.Name}},@{N='Path';E={$_.FullName}},@{N='Parent';E={if($_.PSIsContainer){$_.FullName}else{$_.DirectoryName}}},@{N='IsDir';E={[bool]$_.PSIsContainer}},@{N='Size';E={if($_.PSIsContainer){-1}else{[int64]$_.Length}}},@{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}}`;
    }

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

  const statusLabel = capped
    ? t('everything.showingFirst', { limit: LIMIT.toLocaleString() })
    : t('everything.matches', { num: rows.length.toLocaleString() });

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

      {regexError && <p className="mod-msg">{t('everything.invalidRegex')}</p>}
      {copyMsg && <p className="mod-msg">{copyMsg}</p>}

      {searched ? (
        <>
          {!loading && !error && <p className="count-note">{statusLabel}</p>}
          <AsyncState loading={loading} error={error}>
            <DataTable
              columns={columns}
              rows={rows}
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
