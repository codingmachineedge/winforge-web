import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// Native module — a lightweight PostgreSQL client driven through the `psql` CLI
// (the winget package PostgreSQL.PostgreSQL bundles both the server and pgAdmin 4).
// It mirrors the WinForge PgAdmin desktop module (PgAdminModule.xaml.cs + PostgresService.cs):
//   • Saved connection profiles (host/port/db/user/password masked, sslmode) persisted locally.
//   • Connect / Test / Disconnect with server-version readout and a DB-context label.
//   • Object browser: databases → schemas → tables / views (lazy expand), table structure
//     (columns + types + PK/nullable), one-click browse (SELECT * … LIMIT).
//   • SQL editor: multi-statement, result grid, error display, timing, row-cap note, Ctrl+Enter,
//     Cancel, Clear, Export CSV, and per-session query history.
//   • Admin: server activity (pg_stat_activity), roles (pg_roles), and gated create/drop database
//     and create/drop table (destructive ones confirm).
//   • Launch the full pgAdmin 4 desktop app as a fallback.
// Every mutation is behind an explicit click; destructive ones get a confirm step. Passwords are
// masked, never logged, and (when "save password" is on) stored only in the browser's localStorage.
// In a plain browser the bridge no-ops and the full UI still renders behind the DependencyGate.

const ROW_CAP = 1000;
const STORE_KEY = 'winforge.pgadmin.connections';

interface Conn {
  id: string;
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslmode: string;
  savePassword: boolean;
}

interface Grid {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

interface ColRow {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  dflt: string;
}

let idSeq = 0;
const newId = (): string =>
  `c${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const emptyConn = (): Conn => ({
  id: newId(),
  name: '',
  host: 'localhost',
  port: '5432',
  database: 'postgres',
  username: 'postgres',
  password: '',
  sslmode: 'prefer',
  savePassword: true,
});

const displayName = (c: Conn): string =>
  c.name.trim()
    ? `${c.name.trim()} (${c.username}@${c.host}:${c.port}/${c.database})`
    : `${c.username}@${c.host}:${c.port}/${c.database}`;

// ---- persistence -------------------------------------------------------

// Load saved profiles from localStorage. Passwords are only present for profiles
// that opted into savePassword; they are never written to logs or the command line
// beyond the libpq URI needed to authenticate.
function loadProfiles(): Conn[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((o: Partial<Conn>): Conn => ({
      id: typeof o.id === 'string' ? o.id : newId(),
      name: typeof o.name === 'string' ? o.name : '',
      host: typeof o.host === 'string' ? o.host : 'localhost',
      port: typeof o.port === 'string' ? o.port : '5432',
      database: typeof o.database === 'string' ? o.database : 'postgres',
      username: typeof o.username === 'string' ? o.username : 'postgres',
      password: typeof o.password === 'string' ? o.password : '',
      sslmode: typeof o.sslmode === 'string' ? o.sslmode : 'prefer',
      savePassword: o.savePassword !== false,
    }));
  } catch {
    return [];
  }
}

function saveProfiles(list: Conn[]) {
  try {
    // Strip the password from any profile that didn't opt into saving it.
    const safe = list.map((c) => (c.savePassword ? c : { ...c, password: '' }));
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(safe));
  } catch {
    /* storage unavailable — profiles just won't persist */
  }
}

// ---- libpq / psql helpers ----------------------------------------------

// Build a libpq connection URI from the fields. Values are percent-encoded so
// passwords / names with special characters stay intact.
function connUri(c: Conn, overrideDb?: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  const host = c.host.trim() || 'localhost';
  const port = c.port.trim() || '5432';
  const db = (overrideDb ?? c.database).trim() || 'postgres';
  const user = c.username.trim() || 'postgres';
  const auth = c.password ? `${enc(user)}:${enc(c.password)}` : enc(user);
  const ssl = c.sslmode.trim() || 'prefer';
  return `postgresql://${auth}@${enc(host)}:${enc(port)}/${enc(db)}?sslmode=${enc(ssl)}`;
}

// Run a single SQL statement via psql, returning the raw CommandOutput.
// -X ignores ~/.psqlrc, -w never prompts for a password (fails fast instead of hanging).
async function psql(
  path: string,
  c: Conn,
  sql: string,
  extra: string[] = [],
  overrideDb?: string,
): Promise<CommandOutput> {
  const args = [connUri(c, overrideDb), '-X', '-w', ...extra, '-c', sql];
  return runCommand(path, args);
}

// Parse psql --csv output into columns + rows. psql emits RFC-4180 CSV.
function parseCsv(text: string): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // flush trailing field/row if the text did not end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = rows.length > 0 ? rows[0]! : [];
  const body = rows.slice(1);
  return { columns, rows: body };
}

// Serialize a Grid back to CSV for download.
function toCsv(g: Grid): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [g.columns.map(esc).join(',')];
  for (const r of g.rows) lines.push(r.map(esc).join(','));
  return lines.join('\r\n');
}

function firstError(res: CommandOutput): string {
  const err = (res.stderr || '').trim();
  if (err) return err;
  if (!res.success) return `exit ${res.code}`;
  return '';
}

// Split -t -A (unaligned, tuples-only) output into a trimmed non-empty line list.
function lines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Quote a SQL identifier for double-quoted use.
const sqlId = (s: string) => `"${s.replace(/"/g, '""')}"`;
// Quote a SQL string literal for single-quoted use.
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function PgAdminModule() {
  const { t } = useTranslation();

  // connection form + saved profiles
  const [conn, setConn] = useState<Conn>(emptyConn());
  const [profiles, setProfiles] = useState<Conn[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState('');

  // live session
  const [connected, setConnected] = useState(false);
  const [serverVer, setServerVer] = useState('');
  const [ctxDb, setCtxDb] = useState('postgres'); // active DB context for the SQL/browse tabs

  // browser (object tree)
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<Record<string, string[]>>({}); // db → schemas
  const [expandedDb, setExpandedDb] = useState<string>('');
  const [expandedSchema, setExpandedSchema] = useState<string>('');
  const [tables, setTables] = useState<string[]>([]);
  const [views, setViews] = useState<string[]>([]);
  const [structOf, setStructOf] = useState<{ schema: string; name: string } | null>(null);
  const [cols, setCols] = useState<ColRow[] | null>(null);

  // SQL editor
  const [sql, setSql] = useState('SELECT * FROM pg_stat_activity LIMIT 20;');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  // admin
  const [roles, setRoles] = useState<Grid | null>(null);
  const [activity, setActivity] = useState<Grid | null>(null);
  const [newDbName, setNewDbName] = useState('');
  const [confirmDropDb, setConfirmDropDb] = useState('');
  const [createTableSql, setCreateTableSql] = useState('');
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [adminMsg, setAdminMsg] = useState('');
  const [adminErr, setAdminErr] = useState('');

  // shared status
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const set = <K extends keyof Conn>(k: K, v: Conn[K]) => setConn((c) => ({ ...c, [k]: v }));

  // Keep localStorage in sync whenever the profile list changes.
  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  // ---- saved profiles --------------------------------------------------

  const selectProfile = (id: string) => {
    setSelectedId(id);
    if (!id) {
      setConn(emptyConn());
      return;
    }
    const p = profiles.find((x) => x.id === id);
    if (p) setConn({ ...p });
  };

  const newProfile = () => {
    setSelectedId('');
    setConn(emptyConn());
    setStatus('');
    setErr('');
  };

  const saveProfile = () => {
    const c: Conn = {
      ...conn,
      host: conn.host.trim() || 'localhost',
      port: conn.port.trim() || '5432',
      database: conn.database.trim() || 'postgres',
      username: conn.username.trim() || 'postgres',
    };
    setProfiles((list) => {
      const idx = list.findIndex((x) => x.id === c.id);
      if (idx >= 0) {
        const next = list.slice();
        next[idx] = c;
        return next;
      }
      return [...list, c];
    });
    setSelectedId(c.id);
    setConn(c);
    setStatus(t('pgadmin.connSaved'));
    setErr('');
  };

  const deleteProfile = () => {
    if (!selectedId) return;
    setProfiles((list) => list.filter((x) => x.id !== selectedId));
    setSelectedId('');
    setConn(emptyConn());
    setStatus(t('pgadmin.connDeleted'));
    setErr('');
  };

  // ---- connect / test / disconnect -------------------------------------

  const test = async (path: string) => {
    setBusy('test');
    setErr('');
    setStatus('');
    try {
      const res = await psql(path, conn, 'SELECT version();', ['-t', '-A']);
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setErr(e);
        setStatus(t('pgadmin.connFailed'));
      } else {
        setServerVer(res.stdout.trim());
        setStatus(t('pgadmin.connOkVer', { ver: res.stdout.trim() }));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const connect = async (path: string) => {
    setBusy('connect');
    setErr('');
    setStatus('');
    setGrid(null);
    resetBrowser();
    try {
      const ver = await psql(path, conn, 'SELECT version();', ['-t', '-A']);
      const e = firstError(ver);
      if (e && !ver.stdout.trim()) {
        setErr(e);
        setStatus(t('pgadmin.connFailed'));
        setConnected(false);
        return;
      }
      setServerVer(ver.stdout.trim());
      setConnected(true);
      setCtxDb(conn.database.trim() || 'postgres');
      setStatus(t('pgadmin.connected'));
      await loadDatabases(path);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setConnected(false);
    } finally {
      setBusy('');
    }
  };

  const disconnect = () => {
    setConnected(false);
    setServerVer('');
    resetBrowser();
    setGrid(null);
    setRoles(null);
    setActivity(null);
    setStatus(t('pgadmin.disconnected'));
    setErr('');
  };

  const resetBrowser = () => {
    setDatabases([]);
    setSchemas({});
    setExpandedDb('');
    setExpandedSchema('');
    setTables([]);
    setViews([]);
    setStructOf(null);
    setCols(null);
  };

  // ---- object browser --------------------------------------------------

  const loadDatabases = async (path: string) => {
    setBusy('databases');
    setErr('');
    try {
      const res = await psql(
        path,
        conn,
        'SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;',
        ['-t', '-A'],
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setErr(e);
        return;
      }
      setDatabases(lines(res.stdout));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Expanding a database → list its user schemas (and make it the DB context).
  const toggleDb = async (path: string, db: string) => {
    if (expandedDb === db) {
      setExpandedDb('');
      return;
    }
    setExpandedDb(db);
    setExpandedSchema('');
    setTables([]);
    setViews([]);
    setCtxDb(db);
    if (schemas[db]) return; // cached
    setBusy('schemas');
    setErr('');
    try {
      const res = await psql(
        path,
        conn,
        "SELECT schema_name FROM information_schema.schemata " +
          "WHERE schema_name NOT IN ('pg_catalog','information_schema') " +
          "AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%' ORDER BY schema_name;",
        ['-t', '-A'],
        db,
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setErr(e);
        return;
      }
      setSchemas((m) => ({ ...m, [db]: lines(res.stdout) }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Expanding a schema → list its base tables and views.
  const toggleSchema = async (path: string, db: string, schema: string) => {
    const key = `${db}.${schema}`;
    if (expandedSchema === key) {
      setExpandedSchema('');
      return;
    }
    setExpandedSchema(key);
    setBusy('tables');
    setErr('');
    setCtxDb(db);
    try {
      const tRes = await psql(
        path,
        conn,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ${sqlStr(schema)} AND table_type = 'BASE TABLE' ORDER BY table_name;`,
        ['-t', '-A'],
        db,
      );
      const vRes = await psql(
        path,
        conn,
        `SELECT table_name FROM information_schema.views WHERE table_schema = ${sqlStr(schema)} ORDER BY table_name;`,
        ['-t', '-A'],
        db,
      );
      setTables(lines(tRes.stdout));
      setViews(lines(vRes.stdout));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Load a table's columns / types / PK / nullability (the "structure" view).
  const loadStructure = async (path: string, db: string, schema: string, name: string) => {
    setBusy('struct');
    setErr('');
    setStructOf({ schema, name });
    setCols(null);
    setCtxDb(db);
    try {
      const res = await psql(
        path,
        conn,
        'SELECT c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, \'\'), ' +
          'CASE WHEN pk.column_name IS NULL THEN \'\' ELSE \'yes\' END ' +
          'FROM information_schema.columns c ' +
          'LEFT JOIN ( ' +
          '  SELECT kcu.column_name FROM information_schema.table_constraints tc ' +
          '  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name ' +
          `  AND kcu.table_schema = tc.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' ` +
          `  AND tc.table_schema = ${sqlStr(schema)} AND tc.table_name = ${sqlStr(name)} ` +
          ') pk ON pk.column_name = c.column_name ' +
          `WHERE c.table_schema = ${sqlStr(schema)} AND c.table_name = ${sqlStr(name)} ORDER BY c.ordinal_position;`,
        ['--csv'],
        db,
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setErr(e);
        return;
      }
      const parsed = parseCsv(res.stdout);
      const list: ColRow[] = parsed.rows.map((r) => ({
        name: r[0] ?? '',
        type: r[1] ?? '',
        nullable: (r[2] ?? '') === 'YES',
        dflt: r[3] ?? '',
        pk: (r[4] ?? '') === 'yes',
      }));
      setCols(list);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // Click a table/view → browse it (SELECT * … LIMIT) via the SQL runner.
  const browse = async (path: string, db: string, schema: string, name: string) => {
    setCtxDb(db);
    const ref = `${sqlId(schema)}.${sqlId(name)}`;
    const sqlText = `SELECT * FROM ${ref} LIMIT ${ROW_CAP};`;
    setSql(sqlText);
    await run(path, sqlText, db);
  };

  // ---- run SQL ---------------------------------------------------------

  const run = async (path: string, sqlText: string, db = ctxDb) => {
    const text = sqlText.trim();
    if (!text) {
      setErr(t('pgadmin.nothingToRun'));
      return;
    }
    if (!connected) {
      setErr(t('pgadmin.connectFirst'));
      return;
    }
    setBusy('run');
    setErr('');
    setStatus(t('pgadmin.running'));
    setGrid(null);
    const t0 = Date.now();
    try {
      const res = await psql(path, conn, text, ['--csv'], db);
      const elapsed = Date.now() - t0;
      const e = firstError(res);
      const out = res.stdout;
      if (e && !out.trim()) {
        setErr(e);
        setStatus(t('pgadmin.failedIn', { ms: elapsed }));
        return;
      }
      setHistory((h) => [text, ...h.filter((s) => s !== text)].slice(0, 25));
      if (!out.trim()) {
        // command with no result set (INSERT/UPDATE/DDL) — psql --csv prints nothing on success
        setGrid(null);
        setStatus(t('pgadmin.commandOk', { ms: elapsed }));
        return;
      }
      const parsed = parseCsv(out);
      const truncated = parsed.rows.length > ROW_CAP;
      const capped = truncated ? parsed.rows.slice(0, ROW_CAP) : parsed.rows;
      setGrid({ columns: parsed.columns, rows: capped, truncated });
      setStatus(
        t('pgadmin.resultSummary', {
          rows: capped.length,
          cols: parsed.columns.length,
          ms: elapsed,
        }),
      );
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const exportCsv = () => {
    if (!grid || grid.rows.length === 0) {
      setErr(t('pgadmin.noExport'));
      return;
    }
    downloadCsv('query_result.csv', toCsv(grid));
    setStatus(t('pgadmin.exported', { count: grid.rows.length }));
  };

  // ---- admin -----------------------------------------------------------

  const loadRoles = async (path: string) => {
    setBusy('roles');
    setAdminErr('');
    setAdminMsg('');
    try {
      const res = await psql(
        path,
        conn,
        'SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolconnlimit ' +
          'FROM pg_roles ORDER BY rolname;',
        ['--csv'],
        ctxDb,
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setAdminErr(e);
        return;
      }
      const parsed = parseCsv(res.stdout);
      setRoles({ columns: parsed.columns, rows: parsed.rows, truncated: false });
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const loadActivity = async (path: string) => {
    setBusy('activity');
    setAdminErr('');
    setAdminMsg('');
    try {
      const res = await psql(
        path,
        conn,
        'SELECT pid, usename AS user, datname AS database, client_addr, state, ' +
          "substring(coalesce(query,'') for 80) AS query, backend_start " +
          'FROM pg_stat_activity ORDER BY backend_start;',
        ['--csv'],
        ctxDb,
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setAdminErr(e);
        return;
      }
      const parsed = parseCsv(res.stdout);
      const truncated = parsed.rows.length > ROW_CAP;
      setActivity({
        columns: parsed.columns,
        rows: truncated ? parsed.rows.slice(0, ROW_CAP) : parsed.rows,
        truncated,
      });
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const createDatabase = async (path: string) => {
    const name = newDbName.trim();
    if (!name) return;
    setBusy('createdb');
    setAdminErr('');
    setAdminMsg('');
    try {
      // CREATE DATABASE cannot run inside a transaction block; run it against the maintenance DB.
      const res = await psql(path, conn, `CREATE DATABASE ${sqlId(name)};`, [], 'postgres');
      const e = firstError(res);
      if (e && /error/i.test(e)) {
        setAdminErr(e);
        return;
      }
      setNewDbName('');
      setAdminMsg(t('pgadmin.dbCreated', { name }));
      await loadDatabases(path);
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const dropDatabase = async (path: string, name: string) => {
    setBusy('dropdb');
    setAdminErr('');
    setAdminMsg('');
    try {
      const res = await psql(path, conn, `DROP DATABASE IF EXISTS ${sqlId(name)};`, [], 'postgres');
      const e = firstError(res);
      if (e && /error/i.test(e)) {
        setAdminErr(e);
        return;
      }
      setConfirmDropDb('');
      if (ctxDb === name) setCtxDb('postgres');
      setAdminMsg(t('pgadmin.dbDropped', { name }));
      await loadDatabases(path);
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const createTable = async (path: string) => {
    const stmt = createTableSql.trim();
    if (!stmt) return;
    setBusy('createtbl');
    setAdminErr('');
    setAdminMsg('');
    try {
      const res = await psql(path, conn, stmt, [], ctxDb);
      const e = firstError(res);
      if (e && /error/i.test(e)) {
        setAdminErr(e);
        return;
      }
      setShowCreateTable(false);
      setCreateTableSql('');
      setAdminMsg(t('pgadmin.tableCreated'));
      // refresh the currently-expanded schema listing if any
      if (expandedSchema) {
        const dot = expandedSchema.indexOf('.');
        const db = expandedSchema.slice(0, dot);
        const sc = expandedSchema.slice(dot + 1);
        setExpandedSchema('');
        await toggleSchema(path, db, sc);
      }
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const dropTable = async (path: string, qualified: string) => {
    // qualified is schema.table
    setBusy('droptbl');
    setAdminErr('');
    setAdminMsg('');
    try {
      const dot = qualified.indexOf('.');
      const schema = dot > 0 ? qualified.slice(0, dot) : 'public';
      const name = dot > 0 ? qualified.slice(dot + 1) : qualified;
      const res = await psql(path, conn, `DROP TABLE IF EXISTS ${sqlId(schema)}.${sqlId(name)};`, [], ctxDb);
      const e = firstError(res);
      if (e && /error/i.test(e)) {
        setAdminErr(e);
        return;
      }
      setAdminMsg(t('pgadmin.tableDropped', { name }));
      if (structOf && structOf.schema === schema && structOf.name === name) {
        setStructOf(null);
        setCols(null);
      }
      if (expandedSchema) {
        const d = expandedSchema.indexOf('.');
        const db = expandedSchema.slice(0, d);
        const sc = expandedSchema.slice(d + 1);
        setExpandedSchema('');
        await toggleSchema(path, db, sc);
      }
    } catch (e) {
      setAdminErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---- launch pgAdmin 4 fallback --------------------------------------

  const launchPgAdmin = async () => {
    setBusy('launch');
    setErr('');
    try {
      const res = await runCommand('cmd', ['/c', 'start', '', 'pgadmin4']);
      const e = firstError(res);
      if (e && !res.success) setErr(t('pgadmin.launchFailed'));
      else setStatus(t('pgadmin.launched'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---- connection tab --------------------------------------------------

  const connectionTab = (path: string) => (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note" style={{ margin: 0 }}>
          {t('pgadmin.savedProfiles')}
        </label>
        <select
          className="mod-select"
          style={{ minWidth: 260 }}
          value={selectedId}
          onChange={(e) => selectProfile(e.target.value)}
        >
          <option value="">{t('pgadmin.newConnection')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {displayName(p)}
            </option>
          ))}
        </select>
        <button className="mini" disabled={!!busy} onClick={newProfile}>
          {t('pgadmin.newBtn')}
        </button>
        <button className="mini" disabled={!!busy} onClick={saveProfile}>
          {t('pgadmin.saveBtn')}
        </button>
        <button className="mini danger" disabled={!!busy || !selectedId} onClick={deleteProfile}>
          {t('pgadmin.deleteBtn')}
        </button>
      </div>

      <div
        className="io-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', marginTop: 8 }}
      >
        <label className="label" style={{ display: 'block', gridColumn: '1 / -1' }}>
          {t('pgadmin.name')}
          <input
            className="mod-search"
            value={conn.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('pgadmin.namePh')}
          />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.host')}
          <input className="mod-search" value={conn.host} onChange={(e) => set('host', e.target.value)} placeholder="localhost" />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.port')}
          <input className="mod-search" value={conn.port} onChange={(e) => set('port', e.target.value)} placeholder="5432" />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.database')}
          <input className="mod-search" value={conn.database} onChange={(e) => set('database', e.target.value)} placeholder="postgres" />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.user')}
          <input className="mod-search" value={conn.username} onChange={(e) => set('username', e.target.value)} placeholder="postgres" />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.password')}
          <input
            className="mod-search"
            type="password"
            autoComplete="off"
            value={conn.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </label>
        <label className="label" style={{ display: 'block' }}>
          {t('pgadmin.sslmode')}
          <select className="mod-select" value={conn.sslmode} onChange={(e) => set('sslmode', e.target.value)}>
            <option value="disable">disable</option>
            <option value="allow">allow</option>
            <option value="prefer">prefer</option>
            <option value="require">require</option>
            <option value="verify-ca">verify-ca</option>
            <option value="verify-full">verify-full</option>
          </select>
        </label>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <label className="count-note" style={{ margin: 0, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={conn.savePassword} onChange={(e) => set('savePassword', e.target.checked)} />
          {t('pgadmin.savePassword')}
        </label>
        <button className="mini" disabled={!!busy} onClick={() => test(path)}>
          {busy === 'test' ? t('pgadmin.testing') : t('pgadmin.test')}
        </button>
        {!connected ? (
          <button className="mini primary" disabled={!!busy} onClick={() => connect(path)}>
            {busy === 'connect' ? t('pgadmin.connecting') : t('pgadmin.connect')}
          </button>
        ) : (
          <button className="mini" disabled={!!busy} onClick={disconnect}>
            {t('pgadmin.disconnect')}
          </button>
        )}
        <button className="mini" disabled={!!busy} onClick={launchPgAdmin}>
          {busy === 'launch' ? t('pgadmin.launching') : t('pgadmin.launchPgAdmin')}
        </button>
        <span className="count-note">
          {connected ? t('pgadmin.dbContext', { db: ctxDb }) : t('pgadmin.notConnected')}
        </span>
      </div>

      {serverVer && (
        <p className="count-note" style={{ marginTop: 4, fontFamily: 'monospace' }}>
          {serverVer}
        </p>
      )}
    </div>
  );

  // ---- browser tab -----------------------------------------------------

  const browserTab = (path: string) => (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <span className="label">{t('pgadmin.objectTree')}</span>
        <button className="mini" disabled={!!busy} onClick={() => loadDatabases(path)}>
          ⟳ {t('pgadmin.refresh')}
        </button>
        <span className="count-note">{t('pgadmin.databasesCount', { n: databases.length })}</span>
      </div>

      <div className="io-grid" style={{ gap: 12 }}>
        <div>
          <ul className="kv-list">
            {databases.map((db) => (
              <li key={db} style={{ listStyle: 'none' }}>
                <div
                  className="kv-row chk"
                  style={{ cursor: 'pointer', fontWeight: expandedDb === db ? 600 : 400 }}
                  onClick={() => toggleDb(path, db)}
                >
                  <span className="value" style={{ fontFamily: 'monospace' }}>
                    {expandedDb === db ? '▾' : '▸'} {db}
                  </span>
                </div>
                {expandedDb === db &&
                  (schemas[db] ?? []).map((sc) => {
                    const skey = `${db}.${sc}`;
                    return (
                      <div key={skey} style={{ marginLeft: 14 }}>
                        <div
                          className="kv-row chk"
                          style={{ cursor: 'pointer', fontWeight: expandedSchema === skey ? 600 : 400 }}
                          onClick={() => toggleSchema(path, db, sc)}
                        >
                          <span className="value" style={{ fontFamily: 'monospace' }}>
                            {expandedSchema === skey ? '▾' : '▸'} {sc}
                          </span>
                        </div>
                        {expandedSchema === skey && (
                          <div style={{ marginLeft: 14 }}>
                            {tables.length > 0 && (
                              <p className="count-note" style={{ margin: '4px 0 2px' }}>
                                {t('pgadmin.tablesGroup')} ({tables.length})
                              </p>
                            )}
                            {tables.map((tb) => (
                              <div key={`t-${tb}`} className="kv-row" style={{ marginLeft: 8 }}>
                                <span
                                  className="value"
                                  style={{ fontFamily: 'monospace', cursor: 'pointer' }}
                                  onClick={() => loadStructure(path, db, sc, tb)}
                                >
                                  {tb}
                                </span>
                                <button className="mini" disabled={!!busy} onClick={() => browse(path, db, sc, tb)}>
                                  {t('pgadmin.browse')}
                                </button>
                              </div>
                            ))}
                            {views.length > 0 && (
                              <p className="count-note" style={{ margin: '4px 0 2px' }}>
                                {t('pgadmin.viewsGroup')} ({views.length})
                              </p>
                            )}
                            {views.map((vw) => (
                              <div key={`v-${vw}`} className="kv-row" style={{ marginLeft: 8 }}>
                                <span
                                  className="value"
                                  style={{ fontFamily: 'monospace', cursor: 'pointer' }}
                                  onClick={() => loadStructure(path, db, sc, vw)}
                                >
                                  {vw}
                                </span>
                                <button className="mini" disabled={!!busy} onClick={() => browse(path, db, sc, vw)}>
                                  {t('pgadmin.browse')}
                                </button>
                              </div>
                            ))}
                            {tables.length === 0 && views.length === 0 && (
                              <p className="count-note" style={{ marginLeft: 8 }}>
                                {t('pgadmin.emptySchema')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </li>
            ))}
          </ul>
          {databases.length === 0 && <p className="count-note">{t('pgadmin.noDatabases')}</p>}
        </div>

        <div>
          {structOf && (
            <>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('pgadmin.structureOf')}: <strong style={{ fontFamily: 'monospace' }}>{structOf.schema}.{structOf.name}</strong>
              </p>
              {cols && cols.length > 0 ? (
                <div className="dt-wrap">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th>{t('pgadmin.colName')}</th>
                        <th>{t('pgadmin.colType')}</th>
                        <th>{t('pgadmin.colPk')}</th>
                        <th>{t('pgadmin.colNullable')}</th>
                        <th>{t('pgadmin.colDefault')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cols.map((c, i) => (
                        <tr key={c.name + i}>
                          <td style={{ fontFamily: 'monospace' }}>{c.name}</td>
                          <td>{c.type || '—'}</td>
                          <td>{c.pk ? '✓' : ''}</td>
                          <td>{c.nullable ? '✓' : ''}</td>
                          <td style={{ fontFamily: 'monospace' }}>{c.dflt || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                cols && <p className="count-note">{t('pgadmin.noColumns')}</p>
              )}
            </>
          )}
          {!structOf && <p className="count-note" style={{ marginTop: 0 }}>{t('pgadmin.selectTable')}</p>}
        </div>
      </div>
    </div>
  );

  // ---- SQL tab ---------------------------------------------------------

  const sqlTab = (path: string) => (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pgadmin.dbContext', { db: ctxDb })}
      </p>
      <textarea
        className="hosts-edit"
        style={{ width: '100%', minHeight: 100, fontFamily: 'monospace' }}
        value={sql}
        spellCheck={false}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!busy) run(path, sql);
          }
        }}
        placeholder={t('pgadmin.sqlPlaceholder')}
      />
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <button className="mini primary" disabled={!connected || !!busy || !sql.trim()} onClick={() => run(path, sql)}>
          {busy === 'run' ? t('pgadmin.running') : t('pgadmin.run')}
        </button>
        <button
          className="mini"
          disabled={!!busy}
          onClick={() => {
            setSql('');
            setGrid(null);
            setStatus('');
            setErr('');
          }}
        >
          {t('pgadmin.clear')}
        </button>
        <button className="mini" disabled={!grid || grid.rows.length === 0} onClick={exportCsv}>
          {t('pgadmin.exportCsv')}
        </button>
      </div>

      {status && !err && <p className="mod-msg">{status}</p>}
      {grid?.truncated && <p className="count-note">{t('pgadmin.cappedNote', { cap: ROW_CAP })}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}

      {grid && grid.columns.length > 0 && (
        <div className="dt-wrap" style={{ overflowX: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                {grid.columns.map((col, ci) => (
                  <th key={`${col}-${ci}`}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r, ri) => (
                <tr key={ri}>
                  {grid.columns.map((_col, ci) => {
                    const cell = ci < r.length ? r[ci]! : '';
                    return (
                      <td key={ci} style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="group-title" style={{ fontSize: 13, margin: '0 0 4px' }}>
            {t('pgadmin.history')}
          </p>
          <ul className="kv-list">
            {history.map((h, i) => (
              <li
                key={i}
                className="kv-row chk"
                style={{ cursor: 'pointer' }}
                title={t('pgadmin.reuseQuery')}
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

  // ---- admin tab -------------------------------------------------------

  const adminTab = (path: string) => (
    <div>
      <div className="io-grid" style={{ gap: 12 }}>
        {/* Databases: create / drop (gated) */}
        <div>
          <p className="group-title" style={{ fontSize: 13, margin: '0 0 4px' }}>
            {t('pgadmin.manageDatabases')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ minWidth: 160 }}
              placeholder={t('pgadmin.newDbPh')}
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
            />
            <button className="mini primary" disabled={!!busy || !newDbName.trim()} onClick={() => createDatabase(path)}>
              {busy === 'createdb' ? t('pgadmin.creating') : t('pgadmin.createDb')}
            </button>
          </div>
          <ul className="kv-list" style={{ marginTop: 4 }}>
            {databases.map((db) => (
              <li key={db} className="kv-row">
                <span className="value" style={{ fontFamily: 'monospace' }}>
                  {db}
                </span>
                {confirmDropDb === db ? (
                  <span className="row-actions">
                    <button className="mini danger" disabled={!!busy} onClick={() => dropDatabase(path, db)}>
                      {t('pgadmin.confirmDrop')}
                    </button>
                    <button className="mini" disabled={!!busy} onClick={() => setConfirmDropDb('')}>
                      {t('pgadmin.cancel')}
                    </button>
                  </span>
                ) : (
                  <button className="mini" disabled={!!busy} onClick={() => setConfirmDropDb(db)}>
                    {t('pgadmin.dropDb')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Tables: create / drop (gated) against the active DB context */}
        <div>
          <p className="group-title" style={{ fontSize: 13, margin: '0 0 4px' }}>
            {t('pgadmin.manageTables', { db: ctxDb })}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button
              className="mini"
              disabled={!!busy}
              onClick={() => {
                setShowCreateTable((s) => !s);
                setCreateTableSql('CREATE TABLE public.new_table (\n  id serial PRIMARY KEY,\n  name text\n);');
              }}
            >
              {t('pgadmin.createTable')}
            </button>
          </div>
          {showCreateTable && (
            <div className="panel" style={{ marginTop: 4 }}>
              <textarea
                className="hosts-edit"
                style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }}
                value={createTableSql}
                onChange={(e) => setCreateTableSql(e.target.value)}
              />
              <div className="mod-toolbar">
                <button className="mini primary" disabled={!!busy || !createTableSql.trim()} onClick={() => createTable(path)}>
                  {busy === 'createtbl' ? t('pgadmin.creating') : t('pgadmin.createRun')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => setShowCreateTable(false)}>
                  {t('pgadmin.cancel')}
                </button>
              </div>
            </div>
          )}
          <DropTableForm t={t} busy={!!busy} onDrop={(q) => dropTable(path, q)} />
        </div>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 12 }}>
        <button className="mini" disabled={!!busy} onClick={() => loadRoles(path)}>
          {busy === 'roles' ? t('pgadmin.loading') : t('pgadmin.loadRoles')}
        </button>
        <button className="mini" disabled={!!busy} onClick={() => loadActivity(path)}>
          {busy === 'activity' ? t('pgadmin.loading') : t('pgadmin.loadActivity')}
        </button>
      </div>

      {adminMsg && <p className="mod-msg">{adminMsg}</p>}
      {adminErr && <pre className="cmd-out error">{adminErr}</pre>}

      {roles && (
        <>
          <p className="group-title" style={{ fontSize: 13, margin: '10px 0 4px' }}>
            {t('pgadmin.roles')} ({roles.rows.length})
          </p>
          <GridTable grid={roles} />
        </>
      )}
      {activity && (
        <>
          <p className="group-title" style={{ fontSize: 13, margin: '10px 0 4px' }}>
            {t('pgadmin.activity')} ({activity.rows.length})
          </p>
          {activity.truncated && <p className="count-note">{t('pgadmin.cappedNote', { cap: ROW_CAP })}</p>}
          <GridTable grid={activity} />
        </>
      )}
    </div>
  );

  // ---- shell -----------------------------------------------------------

  return (
    <div className="mod">
      <DependencyGate tool="psql" preferId="PostgreSQL.PostgreSQL" query="postgresql">
        {(path) => (
          <>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('pgadmin.blurb')}
            </p>

            <ModuleTabs
              tabs={[
                { id: 'conn', en: 'Connection', zh: '連線', render: () => connectionTab(path) },
                ...(connected
                  ? [
                      { id: 'browse', en: 'Browser', zh: '物件瀏覽', render: () => browserTab(path) },
                      { id: 'sql', en: 'SQL', zh: 'SQL', render: () => sqlTab(path) },
                      { id: 'admin', en: 'Admin', zh: '管理', render: () => adminTab(path) },
                    ]
                  : []),
              ]}
            />

            {!isTauri() && <p className="count-note">{t('pgadmin.desktopNote')}</p>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}

// A small drop-table form (schema.table text → gated confirm).
function DropTableForm({
  t,
  busy,
  onDrop,
}: {
  t: (k: string, o?: Record<string, unknown>) => string;
  busy: boolean;
  onDrop: (qualified: string) => void;
}) {
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
      <input
        className="mod-search"
        style={{ minWidth: 180 }}
        placeholder={t('pgadmin.dropTablePh')}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setConfirm(false);
        }}
      />
      {confirm ? (
        <>
          <button
            className="mini danger"
            disabled={busy || !name.trim()}
            onClick={() => {
              onDrop(name.trim());
              setName('');
              setConfirm(false);
            }}
          >
            {t('pgadmin.confirmDrop')}
          </button>
          <button className="mini" disabled={busy} onClick={() => setConfirm(false)}>
            {t('pgadmin.cancel')}
          </button>
        </>
      ) : (
        <button className="mini" disabled={busy || !name.trim()} onClick={() => setConfirm(true)}>
          {t('pgadmin.dropTable')}
        </button>
      )}
    </div>
  );
}

// Render a read-only result grid.
function GridTable({ grid }: { grid: Grid }) {
  if (grid.columns.length === 0) return null;
  return (
    <div className="dt-wrap" style={{ overflowX: 'auto' }}>
      <table className="dt">
        <thead>
          <tr>
            {grid.columns.map((col, ci) => (
              <th key={`${col}-${ci}`}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((r, ri) => (
            <tr key={ri}>
              {grid.columns.map((_col, ci) => {
                const cell = ci < r.length ? r[ci]! : '';
                return (
                  <td key={ci} style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
