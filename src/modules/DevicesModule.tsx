import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

interface Dev {
  Status: string;
  Class: string;
  FriendlyName: string;
  InstanceId: string;
}

export function DevicesModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Dev>(
        'Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Select-Object Status,Class,FriendlyName,InstanceId',
      ),
    [],
  );

  const rows = useMemo(() => {
    let all = data ?? [];
    if (problemsOnly) all = all.filter((d) => d.Status !== 'OK');
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((d) => `${d.FriendlyName} ${d.Class}`.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => (a.Class || '').localeCompare(b.Class || ''));
  }, [data, filter, problemsOnly]);

  const columns: Column<Dev>[] = [
    { key: 'Status', header: t('devices.status'), width: 90, render: (d) => <StatusDot ok={d.Status === 'OK'} label={d.Status} /> },
    { key: 'Class', header: t('devices.class'), width: 150 },
    { key: 'FriendlyName', header: t('devices.name') },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input className="mod-search" placeholder={t('devices.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={`mini${problemsOnly ? ' primary' : ''}`} onClick={() => setProblemsOnly((v) => !v)}>
          {t('devices.problemsOnly')}
        </button>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('devices.count', { count: rows.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(d) => d.InstanceId} />
      </AsyncState>
    </div>
  );
}
