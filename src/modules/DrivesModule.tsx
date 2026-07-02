import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, ModuleToolbar, useAsync } from './common';

interface Vol {
  DriveLetter: string | null;
  Label: string | null;
  FileSystem: string | null;
  Size: number;
  Free: number;
}

export function DrivesModule() {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<Vol>(
        "Get-Volume | Where-Object { $_.Size -gt 0 } | Select-Object DriveLetter,@{N='Label';E={$_.FileSystemLabel}},@{N='FileSystem';E={$_.FileSystem}},Size,@{N='Free';E={$_.SizeRemaining}}",
      ),
    [],
  );

  const gb = (b: number) => `${(b / 1073741824).toFixed(1)} GB`;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <div className="drive-grid">
          {(data ?? []).map((v, i) => {
            const used = v.Size - v.Free;
            const pct = v.Size > 0 ? Math.round((used / v.Size) * 100) : 0;
            return (
              <div className="drive-card" key={v.DriveLetter ?? i}>
                <div className="drive-head">
                  <span className="drive-letter">{v.DriveLetter ? `${v.DriveLetter}:` : '—'}</span>
                  <span className="drive-label">{v.Label || t('drives.local')}</span>
                  <span className="drive-fs">{v.FileSystem}</span>
                </div>
                <div className="usage-bar">
                  <div className={`usage-fill${pct > 90 ? ' hot' : ''}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="drive-stats count-note">
                  {t('drives.freeOf', { free: gb(v.Free), total: gb(v.Size), pct })}
                </div>
              </div>
            );
          })}
        </div>
      </AsyncState>
    </div>
  );
}
