import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

interface Task {
  TaskName: string;
  TaskPath: string;
  State: string;
}

export function ScheduledTasksModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Task>(
        "Get-ScheduledTask | Select-Object TaskName,TaskPath,@{N='State';E={$_.State.ToString()}}",
      ),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((x) => `${x.TaskName} ${x.TaskPath}`.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => a.TaskName.localeCompare(b.TaskName));
  }, [data, filter]);

  const act = async (verb: 'Enable' | 'Disable' | 'Start', tk: Task) => {
    const id = tk.TaskPath + tk.TaskName;
    setBusy(id);
    setMsg(null);
    try {
      const res = await runPowershell(
        `${verb}-ScheduledTask -TaskName '${tk.TaskName}' -TaskPath '${tk.TaskPath}' -ErrorAction Stop | Out-Null; 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('tasks.done', { verb, name: tk.TaskName }));
      reload();
    } catch (e) {
      setMsg(`${t('tasks.failed', { name: tk.TaskName })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<Task>[] = [
    {
      key: 'State',
      header: t('tasks.state'),
      width: 100,
      render: (x) => <StatusDot ok={x.State === 'Ready' || x.State === 'Running'} label={x.State} />,
    },
    { key: 'TaskName', header: t('tasks.name') },
    { key: 'TaskPath', header: t('tasks.path'), width: 260, render: (x) => <span className="env-val">{x.TaskPath}</span> },
    {
      key: 'actions',
      header: '',
      width: 220,
      render: (x) => {
        const id = x.TaskPath + x.TaskName;
        return (
          <span className="row-actions">
            <button className="mini" disabled={busy === id} onClick={() => act('Start', x)}>
              {t('tasks.run')}
            </button>
            {x.State === 'Disabled' ? (
              <button className="mini" disabled={busy === id} onClick={() => act('Enable', x)}>
                {t('tasks.enable')}
              </button>
            ) : (
              <button className="mini" disabled={busy === id} onClick={() => act('Disable', x)}>
                {t('tasks.disable')}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input className="mod-search" placeholder={t('tasks.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('tasks.count', { count: rows.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('tasks.adminNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(x) => x.TaskPath + x.TaskName} />
      </AsyncState>
    </div>
  );
}
