import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — a lightweight PostgreSQL client driven through the `psql` CLI
// (the winget package PostgreSQL.PostgreSQL bundles both the server and pgAdmin 4).
// It mirrors the WinForge PgAdmin module: connection fields, browse databases /
// schemas / tables, run SQL with a results grid, export CSV, and launch pgAdmin 4.
// All live work happens in the WinForge desktop app via the psql executable.

const ROW_CAP = 500;

interface Conn {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslmode: string;
}

interface Grid {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

const emptyConn = (): Conn => ({
  host: 'localhost',
  port: '5432',
  database: 'postgres',
  username: 'postgres',
  password: '',
  sslmode: 'prefer',
});

// Build a libpq connection URI from the fields. Values are percent-encoded so
// passwords / names with special characters stay intact.
function connUri(c: Conn): string {
  const enc = (s: string) => encodeURIComponent(s);
  const host = c.host.trim() || 'localhost';
  const port = c.port.trim() || '5432';
  const db = c.database.trim() || 'postgres';
  const user = c.username.trim() || 'postgres';
  const auth = c.password ? `${enc(user)}:${enc(c.password)}` : enc(user);
  const ssl = c.sslmode.trim() || 'prefer';
  return `postgresql://${auth}@${enc(host)}:${enc(port)}/${enc(db)}?sslmode=${enc(ssl)}`;
}

// Run a single SQL statement via psql, returning the raw CommandOutput.
// -X ignores ~/.psqlrc, -w never prompts for a password (fails fast instead of hanging).
async function psql(path: string, c: Conn, sql: string, extra: string[] = []): Promise<CommandOutput> {
  const args = [connUri(c), '-X', '-w', ...extra, '-c', sql];
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

export function PgAdminModule() {
  const { t } = useTranslation();
  const [conn, setConn] = useState<Conn>(emptyConn());
  const [connected, setConnected] = useState(false);
  const [serverVer, setServerVer] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [sql, setSql] = useState('SELECT * FROM pg_stat_activity LIMIT 20;');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const set = <K extends keyof Conn>(k: K, v: Conn[K]) => setConn((c) => ({ ...c, [k]: v }));

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
        setStatus(t('pgadmin.connOk'));
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
    setTables([]);
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
      setStatus(t('pgadmin.connected'));
      // list databases
      const dbRes = await psql(
        path,
        conn,
        'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1;',
        ['-t', '-A'],
      );
      const dbs = dbRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      setDatabases(dbs);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setConnected(false);
    } finally {
      setBusy('');
    }
  };

  const disconnect = () => {
    setConnected(false);
    setDatabases([]);
    setTables([]);
    setGrid(null);
    setServerVer('');
    setStatus(t('pgadmin.disconnected'));
    setErr('');
  };

  const loadTables = async (path: string) => {
    setBusy('tables');
    setErr('');
    try {
      const res = await psql(
        path,
        conn,
        "SELECT table_schema || '.' || table_name FROM information_schema.tables " +
          "WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1;",
        ['-t', '-A'],
      );
      const e = firstError(res);
      if (e && !res.stdout.trim()) {
        setErr(e);
        return;
      }
      const list = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      setTables(list);
      setStatus(t('pgadmin.tablesLoaded', { count: list.length }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const run = async (path: string, sqlText: string) => {
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
      // Wrap in an implicit row cap for SELECT-shaped statements while keeping DDL/DML intact.
      const res = await psql(path, conn, text, ['--csv']);
      const elapsed = Date.now() - t0;
      const e = firstError(res);
      const out = res.stdout;
      if (e && !out.trim()) {
        setErr(e);
        setStatus(t('pgadmin.failedIn', { ms: elapsed }));
        return;
      }
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

  const browse = async (path: string, qualified: string) => {
    // qualified is schema.table — quote each identifier.
    const dot = qualified.indexOf('.');
    let ref = qualified;
    if (dot > 0) {
      const schema = qualified.slice(0, dot);
      const name = qualified.slice(dot + 1);
      ref = `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
    }
    const sqlText = `SELECT * FROM ${ref} LIMIT ${ROW_CAP};`;
    setSql(sqlText);
    await run(path, sqlText);
  };

  const exportCsv = () => {
    if (!grid || grid.rows.length === 0) {
      setErr(t('pgadmin.noExport'));
      return;
    }
    try {
      const csv = toCsv(grid);
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'query_result.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus(t('pgadmin.exported', { count: grid.rows.length }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const launchPgAdmin = async () => {
    setBusy('launch');
    setErr('');
    try {
      // pgAdmin 4 registers a Start-menu shortcut; try to launch it via the shell.
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

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pgadmin.blurb')}
      </p>
      <DependencyGate tool="psql" preferId="PostgreSQL.PostgreSQL" query="postgresql">
        {(path) => (
          <>
            <div className="panel">
              <div className="io-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.host')}
                  <input
                    className="mod-search"
                    value={conn.host}
                    onChange={(e) => set('host', e.target.value)}
                    placeholder="localhost"
                  />
                </label>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.port')}
                  <input
                    className="mod-search"
                    value={conn.port}
                    onChange={(e) => set('port', e.target.value)}
                    placeholder="5432"
                  />
                </label>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.database')}
                  <input
                    className="mod-search"
                    value={conn.database}
                    onChange={(e) => set('database', e.target.value)}
                    placeholder="postgres"
                  />
                </label>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.user')}
                  <input
                    className="mod-search"
                    value={conn.username}
                    onChange={(e) => set('username', e.target.value)}
                    placeholder="postgres"
                  />
                </label>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.password')}
                  <input
                    className="mod-search"
                    type="password"
                    value={conn.password}
                    onChange={(e) => set('password', e.target.value)}
                  />
                </label>
                <label className="label" style={{ display: 'block' }}>
                  {t('pgadmin.sslmode')}
                  <select
                    className="mod-select"
                    value={conn.sslmode}
                    onChange={(e) => set('sslmode', e.target.value)}
                  >
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
                  {connected ? t('pgadmin.dbContext', { db: conn.database.trim() || 'postgres' }) : t('pgadmin.notConnected')}
                </span>
              </div>
              {serverVer && (
                <p className="count-note" style={{ marginTop: 4, fontFamily: 'monospace' }}>
                  {serverVer}
                </p>
              )}
            </div>

            {connected && (
              <div className="panel">
                <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                  <span className="label">{t('pgadmin.objectTree')}</span>
                  <button className="mini" disabled={!!busy} onClick={() => loadTables(path)}>
                    {busy === 'tables' ? t('pgadmin.loading') : t('pgadmin.loadTables')}
                  </button>
                </div>
                {databases.length > 0 && (
                  <p className="count-note" style={{ marginTop: 4 }}>
                    {t('pgadmin.databasesLabel')}: {databases.join(', ')}
                  </p>
                )}
                {tables.length > 0 && (
                  <div className="kv-list" style={{ marginTop: 8 }}>
                    {tables.map((tbl) => (
                      <div className="kv-row" key={tbl}>
                        <span className="value" style={{ fontFamily: 'monospace' }}>
                          {tbl}
                        </span>
                        <button className="mini" disabled={!!busy} onClick={() => browse(path, tbl)}>
                          {t('pgadmin.browse')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="panel">
              <textarea
                className="hosts-edit"
                style={{ minHeight: 90, fontFamily: 'monospace', width: '100%' }}
                value={sql}
                spellCheck={false}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    run(path, sql);
                  }
                }}
                placeholder={t('pgadmin.sqlPlaceholder')}
              />
              <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <button className="mini primary" disabled={!connected || !!busy} onClick={() => run(path, sql)}>
                  {busy === 'run' ? t('pgadmin.running') : t('pgadmin.run')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => { setSql(''); setGrid(null); setStatus(''); }}>
                  {t('pgadmin.clear')}
                </button>
                <button className="mini" disabled={!grid || grid.rows.length === 0} onClick={exportCsv}>
                  {t('pgadmin.exportCsv')}
                </button>
              </div>
            </div>

            {err && <pre className="cmd-out error">{err}</pre>}
            {status && !err && <p className="count-note">{status}</p>}

            {grid && grid.columns.length > 0 && (
              <div className="panel">
                {grid.truncated && (
                  <p className="count-note" style={{ marginTop: 0 }}>
                    {t('pgadmin.cappedNote', { cap: ROW_CAP })}
                  </p>
                )}
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
              </div>
            )}

            {!isTauri() && <p className="count-note">{t('pgadmin.desktopNote')}</p>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
