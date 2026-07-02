import { useTranslation } from 'react-i18next';
import { runPowershellJson, systemInfo } from '../tauri/bridge';
import { AsyncState, ModuleToolbar, useAsync } from './common';

interface OsInfo {
  Caption: string;
  Version: string;
  Arch: string;
  RamGB: number;
  Cpu: string;
  Gpu: string;
  UptimeH: number;
}

export function SysInfoModule() {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync(async () => {
    const si = await systemInfo();
    const [os] = await runPowershellJson<OsInfo>(
      "$o=Get-CimInstance Win32_OperatingSystem; $c=(Get-CimInstance Win32_Processor | Select-Object -First 1).Name; $g=(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name; [pscustomobject]@{ Caption=$o.Caption; Version=$o.Version; Arch=$o.OSArchitecture; RamGB=[math]::Round($o.TotalVisibleMemorySize/1MB,1); Cpu=$c; Gpu=$g; UptimeH=[math]::Round(((Get-Date)-$o.LastBootUpTime).TotalHours,1) }",
    );
    return { si, os };
  }, []);

  const rows: [string, string][] = data
    ? [
        [t('sysinfo.host'), data.si.hostname],
        [t('sysinfo.os'), `${data.os?.Caption ?? data.si.os} (${data.os?.Version ?? ''})`],
        [t('sysinfo.arch'), data.os?.Arch ?? data.si.arch],
        [t('sysinfo.cpu'), `${data.os?.Cpu ?? '—'} · ${data.si.cpus} ${t('sysinfo.threads')}`],
        [t('sysinfo.gpu'), data.os?.Gpu ?? '—'],
        [t('sysinfo.ram'), data.os ? `${data.os.RamGB} GB` : '—'],
        [t('sysinfo.uptime'), data.os ? t('sysinfo.hours', { h: data.os.UptimeH }) : '—'],
      ]
    : [];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <div className="panel" style={{ marginBottom: 0 }}>
          <dl className="kv">
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </AsyncState>
    </div>
  );
}
