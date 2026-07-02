import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

interface Svc {
  Status: string;
  Name: string;
  DisplayName: string;
  StartType: string;
}

export function ServicesModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Svc>(
        "Get-Service | Select-Object @{N='Status';E={$_.Status.ToString()}},Name,DisplayName,@{N='StartType';E={$_.StartType.ToString()}}",
      ),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((s) => `${s.Name} ${s.DisplayName}`.toLowerCase().includes(q))
      : all;
    return [...list].sort((a, b) => a.DisplayName.localeCompare(b.DisplayName));
  }, [data, filter]);

  const act = async (verb: 'Start' | 'Stop' | 'Restart', name: string) => {
    setBusy(name);
    setMsg(null);
    try {
      const res = await runPowershell(`${verb}-Service -Name '${name}' -Force -ErrorAction Stop; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('services.done', { verb, name }));
      reload();
    } catch (e) {
      setMsg(`${t('services.failed', { name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<Svc>[] = [
    {
      key: 'Status',
      header: t('services.status'),
      width: 90,
      render: (s) => <StatusDot ok={s.Status === 'Running'} label={s.Status} />,
    },
    { key: 'DisplayName', header: t('services.display') },
    { key: 'Name', header: t('services.name'), width: 160 },
    { key: 'StartType', header: t('services.startType'), width: 100 },
    {
      key: 'actions',
      header: '',
      width: 200,
      render: (s) => (
        <span className="row-actions">
          {s.Status === 'Running' ? (
            <>
              <button className="mini" disabled={busy === s.Name} onClick={() => act('Stop', s.Name)}>
                {t('services.stop')}
              </button>
              <button className="mini" disabled={busy === s.Name} onClick={() => act('Restart', s.Name)}>
                {t('services.restart')}
              </button>
            </>
          ) : (
            <button className="mini" disabled={busy === s.Name} onClick={() => act('Start', s.Name)}>
              {t('services.start')}
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('services.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('services.count', { count: rows.length })}</span>
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('services.adminNote')}
      </p>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(s) => s.Name} />
      </AsyncState>
    </div>
  );
}
