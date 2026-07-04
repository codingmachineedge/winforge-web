import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// Native module — a "DB Browser for SQLite"-style tool. The WinForge desktop original runs
// entirely on the in-process Microsoft.Data.Sqlite engine (SqliteService.cs); the web port drives
// the `sqlite3` command-line shell (resolved / installed via DependencyGate) to open OR CREATE a
// database, inspect its structure (tables/views/indexes/triggers, columns, PK/FK, row counts,
// create/drop/add-column), browse & edit table data (paged, sortable, filterable, inline-edit,
// insert/delete rows), and run arbitrary multi-statement SQL with a result grid, error display and
// query history — all genuinely functional on the desktop. Every mutation is gated behind an
// explicit click; destructive ones get a confirm step. In a plain browser the bridge no-ops and the
// full UI still renders behind the DependencyGate framing.

const ROW_CAP = 5000;

interface SqliteObj {
  name: string;
  kind: 'table' | 'view' | 'index' | 'trigger';
  sql: string;
  rowCount: number | null;
}
interface ColRow {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt: string;
}
interface FkRow {
  from: string;
  table: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}
interface Grid {
  columns: string[];
  rows: string[][];
}
// A browse page carries the raw rows plus row locators (rowid) so cells can be written back.
interface BrowsePage {
  columns: string[];
  rows: (string | null)[][];
  rowids: (string | null)[]; // aligned with rows; null when the table has no rowid
  editable: boolean; // has rowid (or single-col INTEGER PRIMARY KEY) → rows can be edited/deleted
}

// Escape a SQL identifier for double-quoted use.
const sqlId = (s: string) => `"${s.replace(/"/g, '""')}"`;
// Escape a SQL string literal for single-quoted use.
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

// sqlite3 `.mode ascii` separators: unit-separator between columns, record-separator between rows.
const UNIT = '\x1f';
const RECORD = '\x1e';
// A private sentinel we substitute for SQL NULL so we can tell NULL apart from empty string.
const NULL_TOKEN = '\x00WF_NULL\x00';

/** Parse ASCII-unit-separated sqlite3 output into a grid of rows (raw string cells). */
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

/** Serialize a result set to RFC-4180 CSV text. */
function toCsv(columns: string[], rows: (string | null)[][]): string {
  const cell = (v: string) =>
    /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(r.map((v) => cell(v ?? '')).join(','));
  return lines.join('\n');
}

export function SqliteBrowserModule() {
  const { t } = useTranslation();
  const [dbPath, setDbPath] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [objects, setObjects] = useState<SqliteObj[] | null>(null);
  const [selected, setSelected] = useState<SqliteObj | null>(null);
  const [cols, setCols] = useState<ColRow[] | null>(null);
  const [fks, setFks] = useState<FkRow[] | null>(null);

  // Browse state
  const [browseTable, setBrowseTable] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [grid, setGrid] = useState<BrowsePage | null>(null);
  const [filter, setFilter] = useState(''); // WHERE clause fragment
  const [sortCol, setSortCol] = useState('');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [edits, setEdits] = useState<Record<string, string>>({}); // "row:col" → new text
  const [browseMsg, setBrowseMsg] = useState('');
  const [browseErr, setBrowseErr] = useState('');
  const [confirmDelRow, setConfirmDelRow] = useState<number | null>(null);
  const [showInsert, setShowInsert] = useState(false);
  const [insertVals, setInsertVals] = useState<Record<string, { v: string; isNull: boolean }>>({});

  // Structure write state
  const [showCreate, setShowCreate] = useState(false);
  const [createSql, setCreateSql] = useState('');
  const [showAddCol, setShowAddCol] = useState(false);
  const [addColName, setAddColName] = useState('');
  const [addColType, setAddColType] = useState('TEXT');
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [structMsg, setStructMsg] = useState('');

  // Execute SQL state
  const [sql, setSql] = useState('SELECT name, type FROM sqlite_master ORDER BY type, name;');
  const [sqlGrid, setSqlGrid] = useState<Grid | null>(null);
  const [sqlMsg, setSqlMsg] = useState('');
  const [sqlErr, setSqlErr] = useState('');
  const [sqlTrunc, setSqlTrunc] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // ---- low-level exec ----------------------------------------------------

  // Run one SQL statement against a db. `mode` selects the sqlite3 output framing.
  const runSql = async (
    exe: string,
    db: string,
    statement: string,
    mode: 'ascii' | 'list' | 'plain',
    headers = false,
  ): Promise<CommandOutput | null> => {
    if (!db) return null;
    const args: string[] = [];
    if (mode === 'ascii') args.push('-cmd', '.mode ascii', '-cmd', headers ? '.headers on' : '.headers off');
    else if (mode === 'list') args.push('-cmd', '.mode list', '-cmd', '.headers off');
    // A distinct printable token for NULL so parseAscii can distinguish NULL from ''.
    args.push('-cmd', `.nullvalue ${NULL_TOKEN}`);
    args.push(db, statement);
    try {
      return await runCommand(exe, args);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      return null;
    }
  };

  // Execute a write statement (INSERT/UPDATE/DELETE/DDL). Returns error text or '' on success.
  const execWrite = async (exe: string, db: string, statement: string): Promise<string> => {
    try {
      const out = await runCommand(exe, [db, statement]);
      if (!out.success && !out.stdout.trim()) return out.stderr.trim() || t('sqlitebr.writeFailed');
      const e = out.stderr.trim();
      return e && /error/i.test(e) ? e : '';
    } catch (e) {
      return String(e instanceof Error ? e.message : e);
    }
  };

  // ---- open / new / close ------------------------------------------------

  const resetAll = () => {
    setObjects(null);
    setSelected(null);
    setCols(null);
    setFks(null);
    setBrowseTable('');
    setGrid(null);
    setEdits({});
    setSqlGrid(null);
    setSqlMsg('');
    setSqlErr('');
    setBrowseMsg('');
    setBrowseErr('');
    setStructMsg('');
    setConfirmDelRow(null);
    setShowInsert(false);
    setShowCreate(false);
    setShowAddCol(false);
    setConfirmDrop(null);
  };

  const openDb = async (exe: string) => {
    const p = dbPath.trim();
    if (!p) return;
    setBusy('open');
    setErr('');
    resetAll();
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

  // Create a brand-new empty database file (a write — explicit click only).
  const newDb = async (exe: string) => {
    const p = dbPath.trim();
    if (!p) {
      setErr(t('sqlitebr.newNeedPath'));
      return;
    }
    setBusy('new');
    setErr('');
    resetAll();
    try {
      // Writing user_version touches the file and lands a valid SQLite header on disk.
      const e = await execWrite(exe, p, 'PRAGMA user_version = 0;');
      if (e) {
        setErr(e);
        setOpenPath(null);
        return;
      }
      setOpenPath(p);
      setStructMsg(t('sqlitebr.newCreated'));
      await loadStructure(exe, p);
    } finally {
      setBusy('');
    }
  };

  const closeDb = () => {
    setOpenPath(null);
    setTotal(0);
    setPage(0);
    setHistory([]);
    resetAll();
    setErr('');
  };

  // ---- structure ---------------------------------------------------------

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
      objs.push({ name, kind, sql: sqlText, rowCount: null });
    }

    // Fetch a row count per table in one round-trip (UNION ALL of COUNT queries).
    const tbl = objs.filter((o) => o.kind === 'table');
    if (tbl.length > 0) {
      const counts = tbl
        .map((o) => `SELECT ${sqlStr(o.name)} AS n, count(*) AS c FROM ${sqlId(o.name)}`)
        .join(' UNION ALL ');
      const cres = await runSql(exe, db, counts, 'ascii');
      if (cres) {
        const map = new Map<string, number>();
        for (const r of parseAscii(cres.stdout)) {
          const n = parseInt(r[1] ?? '', 10);
          if (r[0] != null) map.set(r[0], Number.isFinite(n) ? n : 0);
        }
        for (const o of objs) if (o.kind === 'table' && map.has(o.name)) o.rowCount = map.get(o.name) ?? null;
      }
    }

    setObjects(objs);
    // Re-select the previously selected object if it still exists.
    if (selected) {
      const still = objs.find((o) => o.name === selected.name && o.kind === selected.kind);
      if (still) void showObject(exe, still);
      else {
        setSelected(null);
        setCols(null);
        setFks(null);
      }
    }
  };

  const showObject = async (exe: string, obj: SqliteObj) => {
    setSelected(obj);
    setCols(null);
    setFks(null);
    setStructMsg('');
    setShowAddCol(false);
    if (!openPath) return;
    if (obj.kind !== 'table' && obj.kind !== 'view') return;
    setBusy('cols');
    try {
      const res = await runSql(exe, openPath, `PRAGMA table_info(${sqlId(obj.name)});`, 'ascii');
      if (res) {
        // PRAGMA table_info columns: cid,name,type,notnull,dflt_value,pk
        const parsed: ColRow[] = [];
        for (const r of parseAscii(res.stdout)) {
          parsed.push({
            name: r[1] ?? '',
            type: r[2] ?? '',
            notnull: (r[3] ?? '0') === '1',
            dflt: (r[4] ?? '') === NULL_TOKEN ? '' : r[4] ?? '',
            pk: (r[5] ?? '0') !== '0',
          });
        }
        setCols(parsed);
      }
      if (obj.kind === 'table') {
        const fres = await runSql(exe, openPath, `PRAGMA foreign_key_list(${sqlId(obj.name)});`, 'ascii');
        if (fres) {
          // foreign_key_list columns: id,seq,table,from,to,on_update,on_delete,match
          const parsedFk: FkRow[] = [];
          for (const r of parseAscii(fres.stdout)) {
            parsedFk.push({
              table: r[2] ?? '',
              from: r[3] ?? '',
              to: r[4] ?? '',
              onUpdate: r[5] ?? '',
              onDelete: r[6] ?? '',
            });
          }
          setFks(parsedFk);
        }
      }
    } finally {
      setBusy('');
    }
  };

  const doCreateTable = async (exe: string) => {
    const stmt = createSql.trim();
    if (!stmt || !openPath) return;
    setBusy('create');
    setStructMsg('');
    try {
      const e = await execWrite(exe, openPath, stmt);
      if (e) {
        setStructMsg(e);
        return;
      }
      setShowCreate(false);
      setCreateSql('');
      setStructMsg(t('sqlitebr.createOk'));
      await loadStructure(exe, openPath);
    } finally {
      setBusy('');
    }
  };

  const doAddColumn = async (exe: string) => {
    if (!selected || selected.kind !== 'table' || !openPath) return;
    const name = addColName.trim();
    if (!name) return;
    setBusy('addcol');
    setStructMsg('');
    try {
      const stmt = `ALTER TABLE ${sqlId(selected.name)} ADD COLUMN ${sqlId(name)} ${addColType || 'TEXT'};`;
      const e = await execWrite(exe, openPath, stmt);
      if (e) {
        setStructMsg(e);
        return;
      }
      setShowAddCol(false);
      setAddColName('');
      setStructMsg(t('sqlitebr.addColOk', { name }));
      await showObject(exe, selected);
      await loadStructure(exe, openPath);
    } finally {
      setBusy('');
    }
  };

  const doDropTable = async (exe: string, name: string, kind: SqliteObj['kind']) => {
    if (!openPath) return;
    setBusy('drop');
    setStructMsg('');
    try {
      const keyword = kind === 'view' ? 'VIEW' : kind === 'index' ? 'INDEX' : kind === 'trigger' ? 'TRIGGER' : 'TABLE';
      const e = await execWrite(exe, openPath, `DROP ${keyword} IF EXISTS ${sqlId(name)};`);
      if (e) {
        setStructMsg(e);
        return;
      }
      setConfirmDrop(null);
      if (selected && selected.name === name) {
        setSelected(null);
        setCols(null);
        setFks(null);
      }
      if (browseTable === name) {
        setBrowseTable('');
        setGrid(null);
      }
      setStructMsg(t('sqlitebr.dropOk', { name }));
      await loadStructure(exe, openPath);
    } finally {
      setBusy('');
    }
  };

  // ---- browse ------------------------------------------------------------

  const loadPage = async (
    exe: string,
    table: string,
    pageIndex: number,
    size: number,
    sortColArg = sortCol,
    sortDirArg = sortDir,
    filterArg = filter,
  ) => {
    if (!openPath || !table) return;
    setBusy('browse');
    setBrowseErr('');
    setBrowseMsg('');
    setEdits({});
    setConfirmDelRow(null);
    try {
      const where = filterArg.trim() ? ` WHERE ${filterArg.trim()}` : '';

      // total rows (respecting the filter)
      const cnt = await runSql(exe, openPath, `SELECT count(*) FROM ${sqlId(table)}${where};`, 'plain');
      let totalRows = 0;
      if (cnt) {
        if (!cnt.success && !cnt.stdout.trim()) {
          setBrowseErr(cnt.stderr.trim() || t('sqlitebr.browseFailed'));
          setGrid(null);
          return;
        }
        const n = parseInt(cnt.stdout.trim(), 10);
        totalRows = Number.isFinite(n) ? n : 0;
      }
      setTotal(totalRows);

      // column names
      const colRes = await runSql(exe, openPath, `PRAGMA table_info(${sqlId(table)});`, 'ascii');
      const colNames: string[] = [];
      if (colRes) for (const r of parseAscii(colRes.stdout)) colNames.push(r[1] ?? '');

      // editability: does the table expose a usable rowid?
      const probe = await runSql(exe, openPath, `SELECT rowid FROM ${sqlId(table)} LIMIT 0;`, 'plain');
      const editable = !!probe && !(!probe.success && probe.stderr.trim().length > 0);

      const orderBy = sortColArg ? ` ORDER BY ${sqlId(sortColArg)} ${sortDirArg}` : '';
      const offset = pageIndex * size;
      const selectCols = editable ? `rowid AS _wf_rowid, *` : '*';
      const dataRes = await runSql(
        exe,
        openPath,
        `SELECT ${selectCols} FROM ${sqlId(table)}${where}${orderBy} LIMIT ${size} OFFSET ${offset};`,
        'ascii',
      );
      if (!dataRes) return;
      if (!dataRes.success && !dataRes.stdout.trim()) {
        setBrowseErr(dataRes.stderr.trim() || t('sqlitebr.browseFailed'));
        setGrid(null);
        return;
      }
      const raw = parseAscii(dataRes.stdout);
      const rows: (string | null)[][] = [];
      const rowids: (string | null)[] = [];
      for (const rec of raw) {
        const start = editable ? 1 : 0;
        if (editable) rowids.push(rec[0] ?? null);
        const cells: (string | null)[] = [];
        for (let i = 0; i < colNames.length; i++) {
          const v = rec[start + i];
          cells.push(v === undefined || v === NULL_TOKEN ? null : v);
        }
        rows.push(cells);
      }
      setGrid({ columns: colNames, rows, rowids, editable });
      setBrowseTable(table);
      setPage(pageIndex);
      setSortCol(sortColArg);
      setSortDir(sortDirArg);
      if (!editable && rows.length > 0) setBrowseMsg(t('sqlitebr.readonlyRows'));
    } finally {
      setBusy('');
    }
  };

  const toggleSort = (exe: string, col: string) => {
    if (!browseTable) return;
    const dir: 'ASC' | 'DESC' = sortCol === col && sortDir === 'ASC' ? 'DESC' : 'ASC';
    void loadPage(exe, browseTable, 0, pageSize, col, dir, filter);
  };

  const saveEdits = async (exe: string) => {
    if (!openPath || !browseTable || !grid || !grid.editable) return;
    const keys = Object.keys(edits);
    if (keys.length === 0) {
      setBrowseMsg(t('sqlitebr.noEdits'));
      return;
    }
    setBusy('save');
    setBrowseErr('');
    try {
      let saved = 0;
      for (const key of keys) {
        const [rowS, colS] = key.split(':');
        const ri = parseInt(rowS ?? '', 10);
        const ci = parseInt(colS ?? '', 10);
        const rid = grid.rowids[ri];
        const colName = grid.columns[ci];
        if (rid == null || colName === undefined) continue;
        const newVal = edits[key] ?? '';
        const stmt = `UPDATE ${sqlId(browseTable)} SET ${sqlId(colName)} = ${sqlStr(newVal)} WHERE rowid = ${sqlStr(rid)};`;
        const e = await execWrite(exe, openPath, stmt);
        if (e) {
          setBrowseErr(e);
          setBusy('');
          return;
        }
        saved++;
      }
      setBrowseMsg(t('sqlitebr.savedEdits', { n: saved }));
      await loadPage(exe, browseTable, page, pageSize);
    } finally {
      setBusy('');
    }
  };

  const deleteRow = async (exe: string, ri: number) => {
    if (!openPath || !browseTable || !grid || !grid.editable) return;
    const rid = grid.rowids[ri];
    if (rid == null) return;
    setBusy('delrow');
    setBrowseErr('');
    try {
      const e = await execWrite(exe, openPath, `DELETE FROM ${sqlId(browseTable)} WHERE rowid = ${sqlStr(rid)};`);
      if (e) {
        setBrowseErr(e);
        return;
      }
      setConfirmDelRow(null);
      setBrowseMsg(t('sqlitebr.rowDeleted'));
      await loadPage(exe, browseTable, page, pageSize);
    } finally {
      setBusy('');
    }
  };

  const openInsert = async (exe: string) => {
    if (!openPath || !browseTable) return;
    // Load column list to build the insert form.
    const res = await runSql(exe, openPath, `PRAGMA table_info(${sqlId(browseTable)});`, 'ascii');
    const init: Record<string, { v: string; isNull: boolean }> = {};
    if (res) {
      for (const r of parseAscii(res.stdout)) {
        const nm = r[1] ?? '';
        const notnull = (r[3] ?? '0') === '1';
        const dflt = (r[4] ?? '') === NULL_TOKEN ? '' : r[4] ?? '';
        if (nm) init[nm] = { v: '', isNull: !notnull && dflt === '' };
      }
    }
    setInsertVals(init);
    setShowInsert(true);
    setBrowseMsg('');
    setBrowseErr('');
  };

  const doInsert = async (exe: string) => {
    if (!openPath || !browseTable) return;
    const names = Object.keys(insertVals);
    if (names.length === 0) return;
    setBusy('insert');
    setBrowseErr('');
    try {
      const colSql = names.map(sqlId).join(', ');
      const valSql = names
        .map((n) => {
          const cell = insertVals[n];
          return cell && cell.isNull ? 'NULL' : sqlStr(cell ? cell.v : '');
        })
        .join(', ');
      const e = await execWrite(exe, openPath, `INSERT INTO ${sqlId(browseTable)} (${colSql}) VALUES (${valSql});`);
      if (e) {
        setBrowseErr(e);
        return;
      }
      setShowInsert(false);
      setBrowseMsg(t('sqlitebr.rowInserted'));
      await loadPage(exe, browseTable, page, pageSize);
    } finally {
      setBusy('');
    }
  };

  const exportTableCsv = async (exe: string) => {
    if (!openPath || !browseTable) return;
    setBusy('exporttable');
    setBrowseErr('');
    try {
      const res = await runSql(exe, openPath, `SELECT * FROM ${sqlId(browseTable)};`, 'ascii', true);
      if (!res || (!res.success && !res.stdout.trim())) {
        setBrowseErr((res && res.stderr.trim()) || t('sqlitebr.browseFailed'));
        return;
      }
      const recs = parseAscii(res.stdout);
      const header = recs[0] ?? [];
      const body = recs.slice(1).map((r) => r.map((c) => (c === NULL_TOKEN ? null : c)));
      downloadCsv(`${browseTable}.csv`, toCsv(header, body));
      setBrowseMsg(t('sqlitebr.exportedRows', { n: body.length }));
    } finally {
      setBusy('');
    }
  };

  // ---- execute SQL -------------------------------------------------------

  const runUserSql = async (exe: string) => {
    const statement = sql.trim();
    if (!statement || !openPath) return;
    setBusy('sql');
    setSqlErr('');
    setSqlGrid(null);
    setSqlMsg('');
    setSqlTrunc(false);
    const t0 = performance.now();
    try {
      let out: CommandOutput;
      try {
        out = await runCommand(exe, ['-cmd', '.mode ascii', '-cmd', '.headers on', '-cmd', `.nullvalue ${NULL_TOKEN}`, openPath, statement]);
      } catch (e) {
        setSqlErr(String(e instanceof Error ? e.message : e));
        return;
      }
      const elapsed = Math.round(performance.now() - t0);
      const stderr = out.stderr.trim();
      if (!out.success && !out.stdout.trim()) {
        setSqlErr(stderr || t('sqlitebr.sqlFailed'));
        return;
      }
      if (stderr && /error/i.test(stderr) && !out.stdout.trim()) {
        setSqlErr(stderr);
        return;
      }
      setHistory((h) => [statement, ...h.filter((s) => s !== statement)].slice(0, 25));

      const recs = parseAscii(out.stdout);
      if (recs.length === 0) {
        setSqlMsg(t('sqlitebr.commandOkMs', { ms: elapsed }));
        // DDL/DML may have changed the schema — refresh structure & browse.
        await loadStructure(exe, openPath);
        if (browseTable) await loadPage(exe, browseTable, page, pageSize);
        return;
      }
      const header = recs[0] ?? [];
      let rows = recs.slice(1);
      let truncated = false;
      if (rows.length > ROW_CAP) {
        rows = rows.slice(0, ROW_CAP);
        truncated = true;
      }
      const clean = rows.map((r) => r.map((c) => (c === NULL_TOKEN ? '' : c)));
      setSqlGrid({ columns: header, rows: clean });
      setSqlTrunc(truncated);
      setSqlMsg(t('sqlitebr.sqlRowsMs', { rows: rows.length, cols: header.length, ms: elapsed }));
    } finally {
      setBusy('');
    }
  };

  const exportResultCsv = () => {
    if (!sqlGrid || sqlGrid.rows.length === 0) return;
    downloadCsv('query_result.csv', toCsv(sqlGrid.columns, sqlGrid.rows));
    setSqlMsg(t('sqlitebr.exportedRows', { n: sqlGrid.rows.length }));
  };

  // ---- derived -----------------------------------------------------------

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
  const editCount = Object.keys(edits).length;

  // Grouped structure: one section per kind (with counts), like the desktop tree.
  const groups: { kind: SqliteObj['kind']; items: SqliteObj[] }[] = (['table', 'view', 'index', 'trigger'] as const).map(
    (kind) => ({ kind, items: objects?.filter((o) => o.kind === kind) ?? [] }),
  );

  // ---- structure tab -----------------------------------------------------

  const structureTab = (exe: string) => (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button
          className="mini"
          disabled={!!busy}
          onClick={() => {
            setShowCreate((s) => !s);
            setCreateSql('CREATE TABLE new_table (\n  id INTEGER PRIMARY KEY,\n  name TEXT\n);');
          }}
        >
          {t('sqlitebr.createTable')}
        </button>
        <button className="mini" disabled={!!busy} onClick={() => loadStructure(exe, openPath ?? '')}>
          ⟳ {t('sqlitebr.refresh')}
        </button>
        <span className="count-note">{t('sqlitebr.objectsCount', { n: objects?.length ?? 0 })}</span>
      </div>

      {showCreate && (
        <div className="panel" style={{ marginTop: 8 }}>
          <p className="label">{t('sqlitebr.createTable')}</p>
          <textarea
            className="hosts-edit"
            style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }}
            value={createSql}
            onChange={(e) => setCreateSql(e.target.value)}
          />
          <div className="mod-toolbar">
            <button className="mini primary" disabled={!!busy || !createSql.trim()} onClick={() => doCreateTable(exe)}>
              {busy === 'create' ? t('sqlitebr.running') : t('sqlitebr.createRun')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => setShowCreate(false)}>
              {t('sqlitebr.cancel')}
            </button>
          </div>
        </div>
      )}

      {structMsg && <p className="mod-msg">{structMsg}</p>}

      {objects && objects.length === 0 && <p className="count-note">{t('sqlitebr.emptyDb')}</p>}

      {objects && objects.length > 0 && (
        <div className="io-grid" style={{ gap: 12 }}>
          <div>
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.kind} style={{ marginBottom: 10 }}>
                    <p className="group-title" style={{ fontSize: 13, margin: '0 0 4px' }}>
                      {kindLabel(g.kind)} ({g.items.length})
                    </p>
                    <ul className="kv-list">
                      {g.items.map((o) => (
                        <li
                          key={o.kind + ':' + o.name}
                          className="kv-row chk"
                          style={{
                            cursor: 'pointer',
                            fontWeight: selected && selected.name === o.name && selected.kind === o.kind ? 600 : 400,
                          }}
                          onClick={() => showObject(exe, o)}
                        >
                          <span className="value" style={{ fontFamily: 'monospace' }}>
                            {o.name}
                          </span>
                          {o.rowCount != null && (
                            <span className="count-note" style={{ margin: 0 }}>
                              {t('sqlitebr.rowsN', { n: o.rowCount })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
          </div>

          <div>
            {selected && (
              <>
                <p className="count-note" style={{ marginTop: 0 }}>
                  {kindLabel(selected.kind)}: <strong>{selected.name}</strong>
                </p>
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  {selected.kind === 'table' && (
                    <button
                      className="mini"
                      disabled={!!busy}
                      onClick={() => {
                        setShowAddCol((s) => !s);
                        setAddColName('');
                        setAddColType('TEXT');
                      }}
                    >
                      {t('sqlitebr.addColumn')}
                    </button>
                  )}
                  {confirmDrop === selected.name ? (
                    <>
                      <button className="mini danger" disabled={!!busy} onClick={() => doDropTable(exe, selected.name, selected.kind)}>
                        {t('sqlitebr.confirmDrop')}
                      </button>
                      <button className="mini" disabled={!!busy} onClick={() => setConfirmDrop(null)}>
                        {t('sqlitebr.cancel')}
                      </button>
                    </>
                  ) : (
                    <button className="mini" disabled={!!busy} onClick={() => setConfirmDrop(selected.name)}>
                      {t('sqlitebr.drop')}
                    </button>
                  )}
                </div>

                {showAddCol && selected.kind === 'table' && (
                  <div className="panel" style={{ marginTop: 4 }}>
                    <p className="label">{t('sqlitebr.addColumn')}</p>
                    <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                      <input
                        className="mod-search"
                        style={{ minWidth: 160 }}
                        placeholder={t('sqlitebr.colNamePh')}
                        value={addColName}
                        onChange={(e) => setAddColName(e.target.value)}
                      />
                      <select className="mod-select" value={addColType} onChange={(e) => setAddColType(e.target.value)}>
                        <option value="TEXT">TEXT</option>
                        <option value="INTEGER">INTEGER</option>
                        <option value="REAL">REAL</option>
                        <option value="BLOB">BLOB</option>
                        <option value="NUMERIC">NUMERIC</option>
                      </select>
                      <button className="mini primary" disabled={!!busy || !addColName.trim()} onClick={() => doAddColumn(exe)}>
                        {t('sqlitebr.addColRun')}
                      </button>
                    </div>
                  </div>
                )}

                {selected.sql && (
                  <>
                    <p className="count-note" style={{ marginBottom: 2 }}>
                      {t('sqlitebr.ddl')}
                    </p>
                    <pre className="cmd-out" style={{ maxHeight: 160 }}>
                      {selected.sql}
                    </pre>
                  </>
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

                {fks && fks.length > 0 && (
                  <>
                    <p className="count-note" style={{ marginBottom: 2 }}>
                      {t('sqlitebr.foreignKeys')}
                    </p>
                    <div className="dt-wrap">
                      <table className="dt">
                        <thead>
                          <tr>
                            <th>{t('sqlitebr.fkColumn')}</th>
                            <th>{t('sqlitebr.fkRefTable')}</th>
                            <th>{t('sqlitebr.fkRefColumn')}</th>
                            <th>{t('sqlitebr.fkOnUpdate')}</th>
                            <th>{t('sqlitebr.fkOnDelete')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fks.map((f, i) => (
                            <tr key={f.from + i}>
                              <td style={{ fontFamily: 'monospace' }}>{f.from}</td>
                              <td style={{ fontFamily: 'monospace' }}>{f.table}</td>
                              <td style={{ fontFamily: 'monospace' }}>{f.to}</td>
                              <td>{f.onUpdate || '—'}</td>
                              <td>{f.onDelete || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
            {!selected && <p className="count-note">{t('sqlitebr.selectObject')}</p>}
          </div>
        </div>
      )}
    </div>
  );

  // ---- browse tab --------------------------------------------------------

  const browseTab = (exe: string) => (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('sqlitebr.table')}</label>
        <select
          className="mod-select"
          value={browseTable}
          disabled={!!busy || tables.length === 0}
          onChange={(e) => {
            setSortCol('');
            setSortDir('ASC');
            setFilter('');
            loadPage(exe, e.target.value, 0, pageSize, '', 'ASC', '');
          }}
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
          <option value={200}>200</option>
          <option value={500}>500</option>
        </select>
      </div>

      {browseTable && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ minWidth: 200, flex: 1 }}
            placeholder={t('sqlitebr.filterPh')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && loadPage(exe, browseTable, 0, pageSize, sortCol, sortDir, filter)}
          />
          <button className="mini" disabled={!!busy} onClick={() => loadPage(exe, browseTable, 0, pageSize, sortCol, sortDir, filter)}>
            {t('sqlitebr.applyFilter')}
          </button>
          <button className="mini" disabled={!!busy} onClick={() => openInsert(exe)}>
            {t('sqlitebr.insertRow')}
          </button>
          <button
            className="mini primary"
            disabled={!!busy || !grid?.editable || editCount === 0}
            onClick={() => saveEdits(exe)}
          >
            {busy === 'save' ? t('sqlitebr.saving') : t('sqlitebr.saveEdits', { n: editCount })}
          </button>
          <button className="mini" disabled={!!busy || !grid || grid.rows.length === 0} onClick={() => exportTableCsv(exe)}>
            {t('sqlitebr.exportCsv')}
          </button>
        </div>
      )}

      {showInsert && (
        <div className="panel" style={{ marginTop: 4 }}>
          <p className="label">{t('sqlitebr.insertInto', { table: browseTable })}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.keys(insertVals).map((name) => {
              const cell = insertVals[name] ?? { v: '', isNull: false };
              return (
                <div key={name} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="count-note" style={{ minWidth: 120, margin: 0, fontFamily: 'monospace' }}>
                    {name}
                  </span>
                  <input
                    className="mod-search"
                    style={{ flex: 1, minWidth: 160 }}
                    disabled={cell.isNull}
                    value={cell.v}
                    onChange={(e) => setInsertVals((s) => ({ ...s, [name]: { v: e.target.value, isNull: false } }))}
                  />
                  <label className="count-note" style={{ margin: 0, display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={cell.isNull}
                      onChange={(e) => setInsertVals((s) => ({ ...s, [name]: { v: cell.v, isNull: e.target.checked } }))}
                    />
                    NULL
                  </label>
                </div>
              );
            })}
          </div>
          <div className="mod-toolbar">
            <button className="mini primary" disabled={!!busy} onClick={() => doInsert(exe)}>
              {busy === 'insert' ? t('sqlitebr.running') : t('sqlitebr.insertRow')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => setShowInsert(false)}>
              {t('sqlitebr.cancel')}
            </button>
          </div>
        </div>
      )}

      {browseTable && (
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!!busy || !hasPrev} onClick={() => loadPage(exe, browseTable, page - 1, pageSize)}>
            {t('sqlitebr.prev')}
          </button>
          <button className="mini" disabled={!!busy || !hasNext} onClick={() => loadPage(exe, browseTable, page + 1, pageSize)}>
            {t('sqlitebr.next')}
          </button>
          <span className="count-note">{t('sqlitebr.pageInfo', { from, to, total })}</span>
        </div>
      )}

      {browseMsg && <p className="mod-msg">{browseMsg}</p>}
      {browseErr && <pre className="cmd-out error">{browseErr}</pre>}

      {grid && grid.rows.length > 0 && (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                {grid.editable && <th style={{ width: 40 }}></th>}
                {grid.columns.map((c, i) => (
                  <th key={c + i} style={{ cursor: 'pointer' }} onClick={() => toggleSort(exe, c)}>
                    {c}
                    {sortCol === c ? (sortDir === 'ASC' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, ri) => (
                <tr key={ri}>
                  {grid.editable && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {confirmDelRow === ri ? (
                        <span className="row-actions">
                          <button className="mini danger" disabled={!!busy} onClick={() => deleteRow(exe, ri)}>
                            {t('sqlitebr.confirmDel')}
                          </button>
                          <button className="mini" disabled={!!busy} onClick={() => setConfirmDelRow(null)}>
                            {t('sqlitebr.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button className="mini" disabled={!!busy} title={t('sqlitebr.deleteRow')} onClick={() => setConfirmDelRow(ri)}>
                          ✕
                        </button>
                      )}
                    </td>
                  )}
                  {grid.columns.map((_, ci) => {
                    const key = `${ri}:${ci}`;
                    const original = row[ci];
                    const editedVal = edits[key];
                    const shown = editedVal !== undefined ? editedVal : original ?? '';
                    if (grid.editable) {
                      return (
                        <td key={ci} style={{ padding: 0 }}>
                          <input
                            className="mod-search"
                            style={{
                              width: '100%',
                              minWidth: 80,
                              border: 'none',
                              background: editedVal !== undefined ? 'var(--accent-soft, rgba(80,140,255,0.12))' : 'transparent',
                              fontFamily: 'monospace',
                            }}
                            value={shown}
                            placeholder={original === null ? 'NULL' : ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((s) => {
                                const next = { ...s };
                                if (v === (original ?? '')) delete next[key];
                                else next[key] = v;
                                return next;
                              });
                            }}
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={ci} style={{ fontFamily: 'monospace', color: original === null ? 'var(--text-secondary)' : undefined }}>
                        {original === null ? 'NULL' : original}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {grid && grid.rows.length === 0 && browseTable && <p className="count-note">{t('sqlitebr.noRows')}</p>}
      {!browseTable && tables.length === 0 && <p className="count-note">{t('sqlitebr.noTables')}</p>}
    </div>
  );

  // ---- execute tab -------------------------------------------------------

  const executeTab = (exe: string) => (
    <div>
      <textarea
        className="hosts-edit"
        style={{ width: '100%', minHeight: 100, fontFamily: 'monospace' }}
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
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={!!busy || !sql.trim()} onClick={() => runUserSql(exe)}>
          {busy === 'sql' ? t('sqlitebr.running') : t('sqlitebr.run')}
        </button>
        <button
          className="mini"
          disabled={!!busy}
          onClick={() => {
            setSql('');
            setSqlGrid(null);
            setSqlMsg('');
            setSqlErr('');
            setSqlTrunc(false);
          }}
        >
          {t('sqlitebr.clear')}
        </button>
        <button className="mini" disabled={!!busy || !sqlGrid || sqlGrid.rows.length === 0} onClick={exportResultCsv}>
          {t('sqlitebr.exportCsv')}
        </button>
      </div>

      {sqlMsg && <p className="mod-msg">{sqlMsg}</p>}
      {sqlTrunc && <p className="count-note">{t('sqlitebr.truncated', { cap: ROW_CAP })}</p>}
      {sqlErr && <pre className="cmd-out error">{sqlErr}</pre>}

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

      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="group-title" style={{ fontSize: 13, margin: '0 0 4px' }}>
            {t('sqlitebr.history')}
          </p>
          <ul className="kv-list">
            {history.map((h, i) => (
              <li
                key={i}
                className="kv-row chk"
                style={{ cursor: 'pointer' }}
                title={t('sqlitebr.reuseQuery')}
                onClick={() => setSql(h)}
              >
                <span className="value" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {h.length > 120 ? h.slice(0, 120) + '…' : h}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  // ---- shell -------------------------------------------------------------

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
              <button className="mini primary" disabled={!!busy || !dbPath.trim()} onClick={() => openDb(exe)}>
                {busy === 'open' ? t('sqlitebr.opening') : t('sqlitebr.open')}
              </button>
              <button className="mini" disabled={!!busy || !dbPath.trim()} onClick={() => newDb(exe)}>
                {busy === 'new' ? t('sqlitebr.creating') : t('sqlitebr.newDb')}
              </button>
              {openPath && (
                <button
                  className="mini"
                  disabled={!!busy}
                  onClick={() => {
                    loadStructure(exe, openPath);
                    if (browseTable) loadPage(exe, browseTable, page, pageSize);
                  }}
                >
                  ⟳ {t('sqlitebr.refresh')}
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
              <ModuleTabs
                tabs={[
                  { id: 'structure', en: 'Database Structure', zh: '資料庫結構', render: () => structureTab(exe) },
                  { id: 'browse', en: 'Browse Data', zh: '瀏覽資料', render: () => browseTab(exe) },
                  { id: 'sql', en: 'Execute SQL', zh: '執行 SQL', render: () => executeTab(exe) },
                ]}
              />
            )}

            <p className="count-note">{t('sqlitebr.note')}</p>
          </>
        )}
      </DependencyGate>
    </div>
  );
}

// Trigger a client-side CSV download (works in both the Tauri webview and a plain browser).
function downloadCsv(filename: string, text: string) {
  try {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* no-op in non-DOM environments */
  }
}
