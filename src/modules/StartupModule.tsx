import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface StartupItem {
  Name: string;
  Command: string;
  Location: string;
  User: string;
}

export function StartupModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<StartupItem>(
        'Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User',
      ),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((s) => `${s.Name} ${s.Command}`.toLowerCase().includes(q)) : all;
  }, [data, filter]);

  const openLocation = (cmd: string) => {
    const path = cmd.replace(/^"/, '').split('"')[0]?.split(/\s+\//)[0] ?? cmd;
    void runCommand('explorer', ['/select,', path]);
  };

  const columns: Column<StartupItem>[] = [
    { key: 'Name', header: t('startup.name'), width: 200 },
    { key: 'Command', header: t('startup.command'), render: (s) => <span className="env-val">{s.Command}</span> },
    { key: 'Location', header: t('startup.location'), width: 220 },
    {
      key: 'actions',
      header: '',
      width: 130,
      render: (s) => (
        <button className="mini" onClick={() => openLocation(s.Command)}>
          {t('startup.openLocation')}
        </button>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input className="mod-search" placeholder={t('startup.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('startup.count', { count: rows.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(s, i) => `${s.Name}-${i}`} />
      </AsyncState>
    </div>
  );
}
