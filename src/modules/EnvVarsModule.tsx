import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface EnvVar {
  Name: string;
  Value: string;
}
type Scope = 'User' | 'Machine';

export function EnvVarsModule() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('User');
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<EnvVar>(
        `[Environment]::GetEnvironmentVariables('${scope}').GetEnumerator() | ForEach-Object { [pscustomobject]@{ Name = $_.Key; Value = $_.Value } }`,
      ),
    [scope],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((v) => `${v.Name} ${v.Value}`.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => a.Name.localeCompare(b.Name));
  }, [data, filter]);

  const esc = (s: string) => s.replace(/'/g, "''");

  const save = async () => {
    if (!name.trim()) return;
    setMsg(null);
    try {
      const res = await runPowershell(
        `[Environment]::SetEnvironmentVariable('${esc(name)}', '${esc(value)}', '${scope}'); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('env.saved', { name }));
      setName('');
      setValue('');
      reload();
    } catch (e) {
      setMsg(`${t('env.failed')}: ${String(e)}`);
    }
  };

  const del = async (n: string) => {
    setMsg(null);
    try {
      const res = await runPowershell(
        `[Environment]::SetEnvironmentVariable('${esc(n)}', $null, '${scope}'); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('env.deleted', { name: n }));
      reload();
    } catch (e) {
      setMsg(`${t('env.failed')}: ${String(e)}`);
    }
  };

  const columns: Column<EnvVar>[] = [
    { key: 'Name', header: t('env.name'), width: 220, render: (v) => <code>{v.Name}</code> },
    {
      key: 'Value',
      header: t('env.value'),
      render: (v) => <span className="env-val">{v.Value}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 130,
      render: (v) => (
        <span className="row-actions">
          <button
            className="mini"
            onClick={() => {
              setName(v.Name);
              setValue(v.Value);
            }}
          >
            {t('env.edit')}
          </button>
          <button className="mini danger" onClick={() => del(v.Name)}>
            {t('env.delete')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <select className="mod-select" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="User">{t('env.user')}</option>
          <option value="Machine">{t('env.system')}</option>
        </select>
        <input
          className="mod-search"
          placeholder={t('env.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {scope === 'Machine' ? t('env.systemNote') : t('env.userNote')}
      </p>
      <div className="mod-form">
        <input
          className="mod-search"
          style={{ maxWidth: 220 }}
          placeholder={t('env.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="mod-search"
          placeholder={t('env.value')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="mini primary" onClick={save}>
          {t('env.save')}
        </button>
      </div>
      {msg && <p className="mod-msg">{msg}</p>}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(v) => v.Name} />
      </AsyncState>
    </div>
  );
}
