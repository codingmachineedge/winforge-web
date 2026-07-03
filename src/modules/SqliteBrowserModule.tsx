import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a "DB Browser for SQLite"-style tool. The WinForge desktop original runs
// entirely on the in-process Microsoft.Data.Sqlite engine; the web port drives the `sqlite3`
// command-line shell (resolved / installed via DependencyGate) to open a database, inspect its
// structure, browse table data, and run arbitrary SQL — all genuinely functional on the desktop.

interface SqliteObj {
  name: string;
  kind: 'table' | 'view' | 'index' | 'trigger';
  sql: string;
}
interface ColRow {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt: string;
}
interface Grid {
  columns: string[];
  rows: string[][];
}

// Escape a SQL identifier for double-quoted use.
const sqlId = (s: string) => `"${s.replace(/"/g, '""')}"`;

// sqlite3 `.mode ascii` separators: unit-separator between columns, record-separator between rows.
const UNIT = '\x1f';
const RECORD = '\x1e';

/** Parse ASCII-unit-separated sqlite3 output into a grid of rows. */
function parseAscii(out: string): string[][] {
  const rows: string[][] = [];
  const trimmed = out.replace(/\r/g, '');
  const recs = trimmed.split(RECORD);
  for (const rec of recs) {
    if (rec === '') continue;
    rows.push(rec.split(UNIT));
  }
  return rows;
}

/** Parse newline-delimited list output (one record per line). */
function parseLines(out: string): string[] {
  return out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function SqliteBrowserModule() {
  const { t } = useTranslation();
  const [dbPath, setDbPath] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [objects, setObjects] = useState<SqliteObj[] | null>(null);
  const [selected, setSelected] = useState<SqliteObj | null>(null);
  const [cols, setCols] = useState<ColRow[] | null>(null);
  const [browseTable, setBrowseTable] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [sql, setSql] = useState('SELECT name FROM sqlite_master;');
  const [sqlGrid, setSqlGrid] = useState<Grid | null>(null);
  const [sqlMsg, setSqlMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // Run one SQL statement against a db. Returns raw CommandOutput or null on guard/throw.
  const runSql = async (
    exe: string,
    db: string,
    statement: string,
    mode: 'ascii' | 'list' | 'plain',
  ): Promise<CommandOutput | null> => {
    if (!db) return null;
    const args: string[] = [];
    if (mode === 'ascii') {
      args.push('-cmd', '.mode ascii', '-cmd', '.headers off');
    } else if (mode === 'list') {
      args.push('-cmd', '.mode list', '-cmd', '.headers off');
    }
    args.push(db, statement);
    try {
      return await runCommand(exe, args);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      return null;
    }
  };

  const openDb = async (exe: string) => {
    const p = dbPath.trim();
    if (!p) return;
    setBusy('open');
    setErr('');
    setObjects(null);
    setSelected(null);
    setCols(null);
    setBrowseTable('');
    setGrid(null);
    setSqlGrid(null);
    setSqlMsg('');
    try {
      const ver = await runSql(exe, p, 'SELECT sqlite_version();', 'plain');
      if (!ver) return;
      if (!ver.success && !ver.stdout.trim()) {
        setErr(ver.stderr.trim() || t('sqlitebr.openFailed'));
        setOpenPath(null);
        return;
      }
      setOpenPath(p);
      await loadStructure(exe, p);
    } finally {
      setBusy('');
    }
  };

  const loadStructure = async (exe: string, db: string) => {
    const res = await runSql(
      exe,
      db,
      "SELECT name || '|' || type || '|' || replace(coalesce(sql,''), char(10), ' ') " +
        "FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;",
      'list',
    );
    if (!res) return;
    if (!res.success && !res.stdout.trim()) {
      setErr(res.stderr.trim() || t('sqlitebr.structureFailed'));
      return;
    }
    const objs: SqliteObj[] = [];
    for (const line of parseLines(res.stdout)) {
      const bar1 = line.indexOf('|');
      if (bar1 < 0) continue;
      const bar2 = line.indexOf('|', bar1 + 1);
      const name = line.slice(0, bar1);
      const type = bar2 < 0 ? line.slice(bar1 + 1) : line.slice(bar1 + 1, bar2);
      const sqlText = bar2 < 0 ? '' : line.slice(bar2 + 1);
      let kind: SqliteObj['kind'] = 'table';
      if (type === 'view') kind = 'view';
      else if (type === 'index') kind = 'index';
      else if (type === 'trigger') kind = 'trigger';
      objs.push({ name, kind, sql: sqlText });
    }
    setObjects(objs);
  };

  const showObject = async (exe: string, obj: SqliteObj) => {
    setSelected(obj);
    setCols(null);
    setErr('');
    if (!openPath) return;
    if (obj.kind !== 'table' && obj.kind !== 'view') return;
    setBusy('cols');
    try {
      const res = await runSql(exe, openPath, `PRAGMA table_info(${sqlId(obj.name)});`, 'ascii');
      if (!res) return;
      // PRAGMA table_info columns: cid,name,type,notnull,dflt_value,pk
      const parsed: ColRow[] = [];
      for (const r of parseAscii(res.stdout)) {
        parsed.push({
          name: r[1] ?? '',
          type: r[2] ?? '',
          notnull: (r[3] ?? '0') === '1',
          dflt: r[4] ?? '',
          pk: (r[5] ?? '0') !== '0',
        });
      }
      setCols(parsed);
    } finally {
      setBusy('');
    }
  };

  const loadPage = async (exe: string, table: string, pageIndex: number, size: number) => {
    if (!openPath || !table) return;
    setBusy('browse');
    setErr('');
    try {
      const cnt = await runSql(exe, openPath, `SELECT count(*) FROM ${sqlId(table)};`, 'plain');
      let totalRows = 0;
      if (cnt) {
        const n = parseInt(cnt.stdout.trim(), 10);
        totalRows = Number.isFinite(n) ? n : 0;
      }
      setTotal(totalRows);

      const colRes = await runSql(exe, openPath, `PRAGMA table_info(${sqlId(table)});`, 'ascii');
      const colNames: string[] = [];
      if (colRes) {
        for (const r of parseAscii(colRes.stdout)) colNames.push(r[1] ?? '');
      }

      const offset = pageIndex * size;
      const dataRes = await runSql(
        exe,
        openPath,
        `SELECT * FROM ${sqlId(table)} LIMIT ${size} OFFSET ${offset};`,
        'ascii',
      );
      if (!dataRes) return;
      if (!dataRes.success && !dataRes.stdout.trim()) {
        setErr(dataRes.stderr.trim() || t('sqlitebr.browseFailed'));
        setGrid(null);
        return;
      }
      setGrid({ columns: colNames, rows: parseAscii(dataRes.stdout) });
      setBrowseTable(table);
      setPage(pageIndex);
    } finally {
      setBusy('');
    }
  };

  const runUserSql = async (exe: string) => {
    const statement = sql.trim();
    if (!statement || !openPath) return;
    setBusy('sql');
    setErr('');
    setSqlGrid(null);
    setSqlMsg('');
    try {
      let out: CommandOutput;
      try {
        out = await runCommand(exe, [
          '-cmd',
          '.mode ascii',
          '-cmd',
          '.headers on',
          openPath,
          statement,
        ]);
      } catch (e) {
        setSqlMsg(String(e instanceof Error ? e.message : e));
        return;
      }
      if (!out.success && !out.stdout.trim()) {
        setSqlMsg(out.stderr.trim() || t('sqlitebr.sqlFailed'));
        return;
      }
      const recs = parseAscii(out.stdout);
      if (recs.length === 0) {
        // Non-SELECT statement — no result set.
        setSqlMsg(t('sqlitebr.commandOk'));
        // DDL/DML may have changed the schema — refresh structure.
        await loadStructure(exe, openPath);
        return;
      }
      // First record is the header row (headers on).
      const header = recs[0] ?? [];
      const rows = recs.slice(1);
      setSqlGrid({ columns: header, rows });
      setSqlMsg(t('sqlitebr.sqlRows', { rows: rows.length, cols: header.length }));
    } finally {
      setBusy('');
    }
  };

  const closeDb = () => {
    setOpenPath(null);
    setObjects(null);
    setSelected(null);
    setCols(null);
    setBrowseTable('');
    setGrid(null);
    setTotal(0);
    setPage(0);
    setSqlGrid(null);
    setSqlMsg('');
    setErr('');
  };

  const tables = objects?.filter((o) => o.kind === 'table') ?? [];
  const kindLabel = (k: SqliteObj['kind']) =>
    k === 'table'
      ? t('sqlitebr.kindTable')
      : k === 'view'
        ? t('sqlitebr.kindView')
        : k === 'index'
          ? t('sqlitebr.kindIndex')
          : t('sqlitebr.kindTrigger');

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(from + (grid?.rows.length ?? 0) - 1, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * pageSize < total;

  return (
    <div className="mod">
      <DependencyGate tool="sqlite3" preferId="SQLite.SQLite" query="sqlite">
        {(exe) => (
          <>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('sqlitebr.blurb')}
            </p>

            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <input
                className="mod-search"
                style={{ minWidth: 280, flex: 1 }}
                placeholder={t('sqlitebr.pathPlaceholder')}
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && openDb(exe)}
              />
              <button
                className="mini primary"
                disabled={!!busy || !dbPath.trim()}
                onClick={() => openDb(exe)}
              >
                {busy === 'open' ? t('sqlitebr.opening') : t('sqlitebr.open')}
              </button>
              {openPath && (
                <button className="mini" disabled={!!busy} onClick={() => loadStructure(exe, openPath)}>
                  {t('sqlitebr.refresh')}
                </button>
              )}
              {openPath && (
                <button className="mini" disabled={!!busy} onClick={closeDb}>
                  {t('sqlitebr.close')}
                </button>
              )}
            </div>

            <p className="count-note" style={{ marginTop: 0 }}>
              {openPath ? t('sqlitebr.openLabel', { path: openPath }) : t('sqlitebr.noDb')}
            </p>

            {err && <pre className="cmd-out error">{err}</pre>}

            {openPath && (
              <>
                {/* ============ Structure ============ */}
                <div className="panel">
                  <p className="label">{t('sqlitebr.structure')}</p>
                  {objects && objects.length === 0 && (
                    <p className="count-note">{t('sqlitebr.emptyDb')}</p>
                  )}
                  {objects && objects.length > 0 && (
                    <div className="io-grid" style={{ gap: 12 }}>
                      <div>
                        <ul className="kv-list">
                          {objects.map((o) => (
                            <li
                              key={o.kind + ':' + o.name}
                              className="kv-row chk"
                              style={{
                                cursor: 'pointer',
                                fontWeight:
                                  selected && selected.name === o.name && selected.kind === o.kind
                                    ? 600
                                    : 400,
                              }}
                              onClick={() => showObject(exe, o)}
                            >
                              <span className="label">{kindLabel(o.kind)}</span>
                              <span className="value" style={{ fontFamily: 'monospace' }}>
                                {o.name}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        {selected && (
                          <>
                            <p className="count-note" style={{ marginTop: 0 }}>
                              {kindLabel(selected.kind)}: <strong>{selected.name}</strong>
                            </p>
                            {selected.sql && (
                              <pre className="cmd-out" style={{ maxHeight: 160 }}>
                                {selected.sql}
                              </pre>
                            )}
                            {cols && cols.length > 0 && (
                              <div className="dt-wrap">
                                <table className="dt">
                                  <thead>
                                    <tr>
                                      <th>{t('sqlitebr.colName')}</th>
                                      <th>{t('sqlitebr.colType')}</th>
                                      <th>{t('sqlitebr.colPk')}</th>
                                      <th>{t('sqlitebr.colNotNull')}</th>
                                      <th>{t('sqlitebr.colDefault')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {cols.map((c, i) => (
                                      <tr key={c.name + i}>
                                        <td style={{ fontFamily: 'monospace' }}>{c.name}</td>
                                        <td>{c.type || '—'}</td>
                                        <td>{c.pk ? '✓' : ''}</td>
                                        <td>{c.notnull ? '✓' : ''}</td>
                                        <td>{c.dflt || ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* ============ Browse Data ============ */}
                <div className="panel">
                  <p className="label">{t('sqlitebr.browse')}</p>
                  <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                    <label className="count-note">{t('sqlitebr.table')}</label>
                    <select
                      className="mod-select"
                      value={browseTable}
                      disabled={!!busy || tables.length === 0}
                      onChange={(e) => loadPage(exe, e.target.value, 0, pageSize)}
                    >
                      <option value="">{t('sqlitebr.selectTable')}</option>
                      {tables.map((tb) => (
                        <option key={tb.name} value={tb.name}>
                          {tb.name}
                        </option>
                      ))}
                    </select>
                    <label className="count-note">{t('sqlitebr.pageSize')}</label>
                    <select
                      className="mod-select"
                      value={pageSize}
                      disabled={!!busy}
                      onChange={(e) => {
                        const size = parseInt(e.target.value, 10) || 50;
                        setPageSize(size);
                        if (browseTable) loadPage(exe, browseTable, 0, size);
                      }}
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={250}>250</option>
                    </select>
                    {browseTable && (
                      <>
                        <button
                          className="mini"
                          disabled={!!busy || !hasPrev}
                          onClick={() => loadPage(exe, browseTable, page - 1, pageSize)}
                        >
                          {t('sqlitebr.prev')}
                        </button>
                        <button
                          className="mini"
                          disabled={!!busy || !hasNext}
                          onClick={() => loadPage(exe, browseTable, page + 1, pageSize)}
                        >
                          {t('sqlitebr.next')}
                        </button>
                        <span className="count-note">
                          {t('sqlitebr.pageInfo', { from, to, total })}
                        </span>
                      </>
                    )}
                  </div>
                  {grid && grid.rows.length > 0 && (
                    <div className="dt-wrap">
                      <table className="dt">
                        <thead>
                          <tr>
                            {grid.columns.map((c, i) => (
                              <th key={c + i}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grid.rows.map((row, ri) => (
                            <tr key={ri}>
                              {grid.columns.map((_, ci) => (
                                <td key={ci} style={{ fontFamily: 'monospace' }}>
                                  {row[ci] ?? ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {grid && grid.rows.length === 0 && browseTable && (
                    <p className="count-note">{t('sqlitebr.noRows')}</p>
                  )}
                </div>

                {/* ============ Execute SQL ============ */}
                <div className="panel">
                  <p className="label">{t('sqlitebr.executeSql')}</p>
                  <textarea
                    className="hosts-edit"
                    style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }}
                    placeholder={t('sqlitebr.sqlPlaceholder')}
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        if (!busy) runUserSql(exe);
                      }
                    }}
                  />
                  <div className="mod-toolbar">
                    <button
                      className="mini primary"
                      disabled={!!busy || !sql.trim()}
                      onClick={() => runUserSql(exe)}
                    >
                      {busy === 'sql' ? t('sqlitebr.running') : t('sqlitebr.run')}
                    </button>
                    <button
                      className="mini"
                      disabled={!!busy}
                      onClick={() => {
                        setSql('');
                        setSqlGrid(null);
                        setSqlMsg('');
                      }}
                    >
                      {t('sqlitebr.clear')}
                    </button>
                  </div>
                  {sqlMsg && <p className="count-note">{sqlMsg}</p>}
                  {sqlGrid && sqlGrid.rows.length > 0 && (
                    <div className="dt-wrap">
                      <table className="dt">
                        <thead>
                          <tr>
                            {sqlGrid.columns.map((c, i) => (
                              <th key={c + i}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sqlGrid.rows.map((row, ri) => (
                            <tr key={ri}>
                              {sqlGrid.columns.map((_, ci) => (
                                <td key={ci} style={{ fontFamily: 'monospace' }}>
                                  {row[ci] ?? ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <p className="count-note">{t('sqlitebr.note')}</p>
              </>
            )}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
