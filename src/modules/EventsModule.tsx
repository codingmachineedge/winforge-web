import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface Ev {
  TimeCreated: string;
  Id: number;
  Level: string;
  Provider: string;
  Message: string;
}
const LOGS = ['System', 'Application', 'Security'];

export function EventsModule() {
  const { t } = useTranslation();
  const [log, setLog] = useState('System');
  const [filter, setFilter] = useState('');

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Ev>(
        `Get-WinEvent -LogName ${log} -MaxEvents 100 -ErrorAction SilentlyContinue | Select-Object @{N='TimeCreated';E={$_.TimeCreated.ToString('u')}},Id,@{N='Level';E={$_.LevelDisplayName}},@{N='Provider';E={$_.ProviderName}},@{N='Message';E={$_.Message -replace '\\s+',' '}}`,
      ),
    [log],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((e) => `${e.Id} ${e.Provider} ${e.Message} ${e.Level}`.toLowerCase().includes(q)) : all;
  }, [data, filter]);

  const columns: Column<Ev>[] = [
    { key: 'TimeCreated', header: t('events.time'), width: 170 },
    { key: 'Level', header: t('events.level'), width: 90 },
    { key: 'Id', header: 'ID', width: 60, align: 'right' },
    { key: 'Provider', header: t('events.provider'), width: 200 },
    { key: 'Message', header: t('events.message'), render: (e) => <span title={e.Message}>{(e.Message || '').slice(0, 140)}</span> },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <select className="mod-select" value={log} onChange={(e) => setLog(e.target.value)}>
          {LOGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input className="mod-search" placeholder={t('events.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('events.count', { count: rows.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(e, i) => `${e.Id}-${i}`} />
      </AsyncState>
    </div>
  );
}
