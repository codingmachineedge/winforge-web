import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, useAsync } from './common';

// ── Live drive enumeration (fixed + removable, ready) ──────────────────────────
interface DriveInfo {
  Root: string;
  FreeBytes: number;
  FreeText: string;
  Type: string;
}

// ── Benchmark test-set entry / result (CrystalDiskMark-style) ──────────────────
interface BenchResult {
  Key: string;
  Random: boolean;
  MBps: number;
  Iops: number;
}

// Size choices mirror the C# module: 256 MB / 1 GB / 4 GB (bytes).
const SIZE_CHOICES: { label: string; bytes: number }[] = [
  { label: '256 MB', bytes: 256 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '4 GB', bytes: 4 * 1024 * 1024 * 1024 },
];

// Test set: SEQ1M (Q8/Q1) + RND4K (Q32/Q1), read & write — same rows the C# service reports.
const TEST_SET: { key: string; block: number; qd: number; random: boolean; write: boolean }[] = [
  { key: 'SEQ1M-Q8T1-R', block: 1 << 20, qd: 8, random: false, write: false },
  { key: 'SEQ1M-Q8T1-W', block: 1 << 20, qd: 8, random: false, write: true },
  { key: 'SEQ1M-Q1T1-R', block: 1 << 20, qd: 1, random: false, write: false },
  { key: 'SEQ1M-Q1T1-W', block: 1 << 20, qd: 1, random: false, write: true },
  { key: 'RND4K-Q32T1-R', block: 4 << 10, qd: 32, random: true, write: false },
  { key: 'RND4K-Q32T1-W', block: 4 << 10, qd: 32, random: true, write: true },
  { key: 'RND4K-Q1T1-R', block: 4 << 10, qd: 1, random: true, write: false },
  { key: 'RND4K-Q1T1-W', block: 4 << 10, qd: 1, random: true, write: true },
];

function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v % 1 === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

export function DiskBenchmarkModule() {
  const { t } = useTranslation();
  const [target, setTarget] = useState('C:\\');
  const [sizeIdx, setSizeIdx] = useState(0);
  const [passes, setPasses] = useState(3);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [results, setResults] = useState<BenchResult[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  // Enumerate live drives (fixed + removable) via Get-PSDrive / WMI.
  const drives = useAsync(
    () =>
      runPowershellJson<DriveInfo>(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | " +
          "Select-Object @{N='Root';E={$_.DeviceID + '\\'}}," +
          "@{N='FreeBytes';E={[int64]($_.FreeSpace)}}," +
          "@{N='FreeText';E={'{0:N1} GB' -f ($_.FreeSpace/1GB)}}," +
          "@{N='Type';E={if($_.DriveType -eq 2){'Removable'}else{'Fixed'}}}",
      ),
    [],
  );

  const driveList = drives.data ?? [];
  const selectedDrive = useMemo(
    () => driveList.find((d) => d.Root.toUpperCase() === target.toUpperCase()),
    [driveList, target],
  );

  // Build a single PowerShell script that runs the whole CDM-style test set against a
  // real temp file and emits one JSON object per test. Uses .NET FileStream with
  // WriteThrough so the OS write cache is flushed for honest write numbers; drops the
  // standby cache before each read pass so reads hit the device, not RAM.
  function buildScript(dir: string, fileBytes: number, passCount: number): string {
    const specs = TEST_SET.map(
      (s) =>
        `[pscustomobject]@{Key='${s.key}';Block=${s.block};Qd=${s.qd};Random=$${s.random};Write=$${s.write}}`,
    ).join(',');

    // The heavy lifting runs inside PowerShell. Temp file is ALWAYS deleted in finally.
    return `
$ErrorActionPreference='Stop'
$dir='${dir.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$fileBytes=[int64]${fileBytes}
$passes=[int]${passCount}
if($fileBytes -lt 16MB){$fileBytes=16MB}
# stale sweep
Get-ChildItem -LiteralPath $dir -Filter '.winforge-bench-*.tmp' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$path=Join-Path $dir (".winforge-bench-" + [guid]::NewGuid().ToString('N') + ".tmp")
$specs=@(${specs})
$results=New-Object System.Collections.Generic.List[object]
try{
  # Pre-allocate the test file with pseudo-random data (SSDs can't dedup/compress it away).
  $chunk=8MB
  $rng=New-Object System.Random 12345
  $buf=New-Object byte[] $chunk
  $rng.NextBytes($buf)
  $fs=[System.IO.File]::Open($path,[System.IO.FileMode]::Create,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
  try{
    $written=[int64]0
    while($written -lt $fileBytes){
      $n=[Math]::Min([int64]$chunk,$fileBytes-$written)
      $fs.Write($buf,0,[int]$n)
      $written+=$n
    }
    $fs.Flush($true)
  } finally { $fs.Dispose() }

  foreach($spec in $specs){
    $block=[int]$spec.Block
    $isWrite=[bool]$spec.Write
    $isRandom=[bool]$spec.Random
    # Data to move: random tests touch a slice, sequential the whole file (capped for time).
    if($isRandom){ $target=[Math]::Min($fileBytes,[Math]::Max([int64]64MB,[int64]($fileBytes/4))) }
    else { $target=[Math]::Min($fileBytes,[int64]512MB) }
    $totalOps=[int64]([Math]::Max([int64]$spec.Qd,[int64]($target/$block)))
    $maxBlocks=[Math]::Max([int64]1,[int64]($fileBytes/$block))
    $blockBuf=New-Object byte[] $block
    if($isWrite){ (New-Object System.Random).NextBytes($blockBuf) }
    $bestMBps=[double]0; $bestIops=[double]0
    for($pass=1;$pass -le $passes;$pass++){
      $flags=[System.IO.FileOptions]::WriteThrough
      $acc=if($isWrite){[System.IO.FileAccess]::ReadWrite}else{[System.IO.FileAccess]::Read}
      $stream=New-Object System.IO.FileStream($path,[System.IO.FileMode]::Open,$acc,[System.IO.FileShare]::ReadWrite,$block,$flags)
      try{
        $r=New-Object System.Random
        $sw=[System.Diagnostics.Stopwatch]::StartNew()
        $seq=[int64]0
        for($op=0;$op -lt $totalOps;$op++){
          if($isRandom){ $off=[int64]([Math]::Floor($r.NextDouble()*$maxBlocks))*$block }
          else { $off=$seq; $seq+=$block; if($seq+$block -gt $maxBlocks*$block){$seq=0} }
          $null=$stream.Seek($off,[System.IO.SeekOrigin]::Begin)
          if($isWrite){ $stream.Write($blockBuf,0,$block) }
          else { $null=$stream.Read($blockBuf,0,$block) }
        }
        if($isWrite){ $stream.Flush($true) }
        $sw.Stop()
      } finally { $stream.Dispose() }
      $secs=[Math]::Max($sw.Elapsed.TotalSeconds,1e-6)
      $bytes=$totalOps*[int64]$block
      $mbps=$bytes/1000000.0/$secs
      $iops=$totalOps/$secs
      if($mbps -gt $bestMBps){ $bestMBps=$mbps; $bestIops=$iops }
    }
    $results.Add([pscustomobject]@{Key=$spec.Key;Random=$isRandom;MBps=[Math]::Round($bestMBps,2);Iops=[Math]::Round($bestIops,0)})
  }
} finally {
  try{ if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } }catch{}
}
$results`.trim();
  }

  async function run() {
    if (busy) return;
    const dir = target.trim();
    if (!dir) {
      setMsg({ kind: 'err', text: t('diskbench.pickTarget') });
      return;
    }
    const size = SIZE_CHOICES[sizeIdx] ?? SIZE_CHOICES[0]!;
    // Free-space sanity check against the enumerated drive.
    if (selectedDrive && selectedDrive.FreeBytes < size.bytes + 64 * 1024 * 1024) {
      setMsg({
        kind: 'err',
        text: t('diskbench.noSpace', { size: humanSize(size.bytes), drive: selectedDrive.Root }),
      });
      return;
    }
    const ok = window.confirm(
      t('diskbench.confirm', { size: humanSize(size.bytes), dir }),
    );
    if (!ok) return;

    setBusy(true);
    setResults([]);
    setMsg(null);
    setPhase(t('diskbench.preparing'));
    try {
      const rows = await runPowershellJson<BenchResult>(buildScript(dir, size.bytes, passes));
      setResults(rows);
      setMsg({ kind: 'ok', text: t('diskbench.complete') });
    } catch (e) {
      setMsg({ kind: 'err', text: t('diskbench.failed', { error: String(e) }) });
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  const testName = (key: string): string => t(`diskbench.test.${key}`);

  const columns: Column<BenchResult>[] = [
    { key: 'Key', header: t('diskbench.colTest'), render: (r) => testName(r.Key) },
    {
      key: 'MBps',
      header: t('diskbench.colMbps'),
      width: 140,
      align: 'right',
      render: (r) => <span className="mono">{r.MBps.toFixed(2)} MB/s</span>,
    },
    {
      key: 'Iops',
      header: t('diskbench.colIops'),
      width: 140,
      align: 'right',
      render: (r) => (
        <span className="mono" style={{ opacity: 0.7 }}>
          {r.Random ? `${Math.round(r.Iops).toLocaleString()} IOPS` : ''}
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('diskbench.blurb')}
      </p>
      <p className="count-note">
        <strong>{t('diskbench.warnTitle')}</strong> {t('diskbench.warnBody')}
      </p>

      <ModuleToolbar>
        <span className="count-note">{t('diskbench.drive')}</span>
        <select
          className="mod-select"
          value={target}
          disabled={busy}
          onChange={(e) => setTarget(e.target.value)}
        >
          {driveList.length === 0 && <option value={target}>{target}</option>}
          {driveList.map((d) => (
            <option key={d.Root} value={d.Root}>
              {d.Root} ({d.FreeText} {t('diskbench.free')}
              {d.Type === 'Removable' ? ` · ${t('diskbench.removable')}` : ''})
            </option>
          ))}
        </select>

        <span className="count-note">{t('diskbench.testSize')}</span>
        <select
          className="mod-select"
          value={sizeIdx}
          disabled={busy}
          onChange={(e) => setSizeIdx(Number(e.target.value))}
        >
          {SIZE_CHOICES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>

        <span className="count-note">{t('diskbench.passes')}</span>
        <select
          className="mod-select"
          value={passes}
          disabled={busy}
          onChange={(e) => setPasses(Number(e.target.value))}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {t('diskbench.passN', { n })}
            </option>
          ))}
        </select>

        <button className="mini primary" onClick={run} disabled={busy}>
          {busy ? t('diskbench.running') : t('diskbench.run')}
        </button>
        <button className="mini" onClick={drives.reload} disabled={busy}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {busy && (
        <p className="count-note">
          <span className="status-dot on">
            <span className="dot" />
          </span>{' '}
          {phase || t('diskbench.running')}
        </p>
      )}

      {msg && (
        <p className={`mod-msg ${msg.kind === 'err' ? 'error' : ''}`}>{msg.text}</p>
      )}

      {drives.error && <p className="count-note error">{drives.error}</p>}

      {results.length > 0 ? (
        <DataTable columns={columns} rows={results} rowKey={(r) => r.Key} />
      ) : (
        <p className="count-note">{t('diskbench.emptyHint')}</p>
      )}
    </div>
  );
}
