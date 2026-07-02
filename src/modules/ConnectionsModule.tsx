import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface Conn {
  LocalAddress: string;
  LocalPort: number;
  RemoteAddress: string;
  RemotePort: number;
  State: string;
  Process: string;
  OwningProcess: number;
}

export function ConnectionsModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Conn>(
        "Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,@{N='State';E={$_.State.ToString()}},OwningProcess,@{N='Process';E={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}}",
      ),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((c) =>
          `${c.RemoteAddress} ${c.LocalPort} ${c.RemotePort} ${c.Process} ${c.State}`.toLowerCase().includes(q),
        )
      : all;
    return [...list].sort((a, b) => (a.State || '').localeCompare(b.State || ''));
  }, [data, filter]);

  const columns: Column<Conn>[] = [
    { key: 'State', header: t('conn.state'), width: 120 },
    { key: 'Local', header: t('conn.local'), render: (c) => `${c.LocalAddress}:${c.LocalPort}` },
    { key: 'Remote', header: t('conn.remote'), render: (c) => `${c.RemoteAddress}:${c.RemotePort}` },
    { key: 'Process', header: t('conn.process'), render: (c) => c.Process || '—' },
    { key: 'OwningProcess', header: 'PID', width: 70, align: 'right' },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('conn.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('conn.count', { count: rows.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(c, i) => `${c.LocalPort}-${c.RemotePort}-${i}`} />
      </AsyncState>
    </div>
  );
}
