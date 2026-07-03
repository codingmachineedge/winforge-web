import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';

// Native module — Recycle Bin manager via the desktop backend (Windows PowerShell + Shell.Application).
// Lists items (name, original location, size, date deleted), shows totals, and can empty the bin.

interface Item { name: string; size: number; location: string; deleted: string }
interface BinData { count: number; totalSize: number; items: Item[] }

const QUERY = `$shell=New-Object -ComObject Shell.Application; $rb=$shell.Namespace(0xA); ` +
  `$cols=@{}; for($i=0;$i -le 12;$i++){ $h=$rb.GetDetailsOf($rb.Items,$i); if($h){$cols[$h]=$i} }; ` +
  `$items=@($rb.Items()); ` +
  `$list=$items | ForEach-Object { [pscustomobject]@{ name=$_.Name; size=[long]$_.Size; location=$rb.GetDetailsOf($_,$cols['Original Location']); deleted=$rb.GetDetailsOf($_,$cols['Date Deleted']) } }; ` +
  `[pscustomobject]@{ count=$items.Count; totalSize=[long](($items|Measure-Object -Property Size -Sum).Sum); items=@($list) } | ConvertTo-Json -Depth 4 -Compress`;

const EMPTY = `Clear-RecycleBin -Force -ErrorAction Stop; 'ok'`;

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) bytes = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return u === 0 ? `${Math.round(v)} ${units[u]}` : `${v.toFixed(2)} ${units[u]}`;
}

export function RecycleBinModule() {
  const { t } = useTranslation();
  const [data, setData] = useState<BinData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const desktop = isTauri();

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setLoading(true); setErr(null);
    try {
      const res = await runPowershell(QUERY);
      if (!res.success && !res.stdout.trim()) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const parsed = JSON.parse(res.stdout.trim() || '{}');
      setData({ count: parsed.count ?? 0, totalSize: parsed.totalSize ?? 0, items: Array.isArray(parsed.items) ? parsed.items : parsed.items ? [parsed.items] : [] });
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setLoading(false); }
  }, [desktop]);

  useEffect(() => { void refresh(); }, [refresh]);

  const empty = async () => {
    setConfirming(false); setStatus(null); setErr(null);
    try {
      const res = await runPowershell(EMPTY);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setStatus(t('recyclebin.emptied'));
      await refresh();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="mod">
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('recyclebin.desktopOnly')}</p>}
      <div className="mod-toolbar">
        <button className="mini" disabled={!desktop || loading} onClick={refresh}>⟳ {t('recyclebin.refresh')}</button>
        {!confirming ? (
          <button className="mini" disabled={!desktop || !data || data.count === 0} onClick={() => setConfirming(true)}>{t('recyclebin.empty')}</button>
        ) : (
          <>
            <span className="count-note">{t('recyclebin.confirm')}</span>
            <button className="mini primary" onClick={empty}>{t('recyclebin.confirmYes')}</button>
            <button className="mini" onClick={() => setConfirming(false)}>{t('recyclebin.cancel')}</button>
          </>
        )}
      </div>
      {err && <pre className="cmd-out error">{err}</pre>}
      {status && <p className="count-note">{status}</p>}
      {data && (
        <>
          <p className="count-note">{t('recyclebin.totals', { count: data.count, size: formatBytes(data.totalSize) })}</p>
          {data.count === 0 ? (
            <p className="count-note">{t('recyclebin.empty0')}</p>
          ) : (
            <div className="dt-wrap">
              <table className="dt">
                <thead><tr><th>{t('recyclebin.name')}</th><th>{t('recyclebin.location')}</th><th style={{ textAlign: 'right' }}>{t('recyclebin.size')}</th><th>{t('recyclebin.deleted')}</th></tr></thead>
                <tbody>
                  {data.items.map((it, i) => (
                    <tr key={i}><td>{it.name}</td><td style={{ fontFamily: 'monospace', fontSize: 12 }}>{it.location}</td><td style={{ textAlign: 'right' }}>{formatBytes(it.size)}</td><td>{it.deleted}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
