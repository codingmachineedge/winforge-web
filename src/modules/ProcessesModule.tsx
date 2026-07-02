import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface Proc {
  Id: number;
  Name: string;
  CPU: number | null;
  WS: number;
  Path: string | null;
}

type SortKey = 'CPU' | 'WS' | 'Name';

export function ProcessesModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('CPU');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Proc>(
        "Get-Process | Select-Object Id,@{N='Name';E={$_.ProcessName}},CPU,@{N='WS';E={$_.WS}},Path",
      ),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((p) => p.Name.toLowerCase().includes(q)) : all;
    const sorted = [...list].sort((a, b) => {
      if (sort === 'Name') return a.Name.localeCompare(b.Name);
      if (sort === 'WS') return b.WS - a.WS;
      return (b.CPU ?? 0) - (a.CPU ?? 0);
    });
    return sorted.slice(0, 200);
  }, [data, filter, sort]);

  const kill = async (pid: number, name: string) => {
    setBusy(pid);
    setMsg(null);
    try {
      const res = await runPowershell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('proc.killed', { name, pid }));
      reload();
    } catch (e) {
      setMsg(`${t('proc.killFailed', { name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

  const columns: Column<Proc>[] = [
    { key: 'Id', header: 'PID', width: 70, align: 'right' },
    { key: 'Name', header: t('proc.name') },
    {
      key: 'CPU',
      header: t('proc.cpu'),
      width: 90,
      align: 'right',
      render: (p) => (p.CPU == null ? '—' : p.CPU.toFixed(1)),
    },
    { key: 'WS', header: t('proc.mem'), width: 100, align: 'right', render: (p) => mb(p.WS) },
    {
      key: 'actions',
      header: '',
      width: 80,
      render: (p) => (
        <button className="mini danger" disabled={busy === p.Id} onClick={() => kill(p.Id, p.Name)}>
          {t('proc.kill')}
        </button>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('proc.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="mod-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="CPU">{t('proc.sortCpu')}</option>
          <option value="WS">{t('proc.sortMem')}</option>
          <option value="Name">{t('proc.sortName')}</option>
        </select>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('proc.count', { count: rows.length })}</span>
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(p) => String(p.Id)} />
      </AsyncState>
    </div>
  );
}
