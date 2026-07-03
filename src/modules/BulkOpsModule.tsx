import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, useAsync } from './common';

type Mode = 'Wildcard' | 'Regex' | 'Extension';

interface Match {
  Path: string;
  Name: string;
  Dir: string;
  Size: number;
}

/** Escape a value for embedding inside a PowerShell single-quoted string literal. */
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Build the PowerShell that enumerates + filters files by mode, emitting clean JSON. */
function matchScript(source: string, pattern: string, mode: Mode, recurse: boolean): string {
  const src = psq(source);
  const pat = psq(pattern);
  const rec = recurse ? '-Recurse ' : '';
  let filter: string;
  if (mode === 'Wildcard') {
    const wp = pattern.trim() === '' ? '*' : pat;
    filter = `Get-ChildItem -LiteralPath '${src}' -File ${rec}-Filter '${wp}' -ErrorAction SilentlyContinue`;
  } else if (mode === 'Extension') {
    // normalise ".jpg" / "jpg" -> compare on .Extension
    const ext = pattern.trim() === '' ? '' : (pattern.startsWith('.') ? pat : '.' + pat);
    filter =
      `Get-ChildItem -LiteralPath '${src}' -File ${rec}-ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Extension -ieq '${ext}' }`;
  } else {
    // Regex against file name (IgnoreCase), like the C# port.
    filter =
      `Get-ChildItem -LiteralPath '${src}' -File ${rec}-ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Name -imatch '${pat}' }`;
  }
  return (
    `${filter} | Select-Object ` +
    `@{N='Path';E={$_.FullName}},@{N='Name';E={$_.Name}},` +
    `@{N='Dir';E={$_.DirectoryName}},@{N='Size';E={[int64]$_.Length}}`
  );
}

export function BulkOpsModule() {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [pattern, setPattern] = useState('');
  const [mode, setMode] = useState<Mode>('Wildcard');
  const [recurse, setRecurse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const src = source.trim();

  const { data, loading, error, reload } = useAsync<Match[]>(async () => {
    if (src === '') return [];
    return runPowershellJson<Match>(matchScript(src, pattern, mode, recurse));
  }, [src, pattern, mode, recurse]);

  const matches = useMemo(() => data ?? [], [data]);
  const paths = useMemo(() => matches.map((m) => m.Path), [matches]);

  /** Run an op over the matched paths as a batch, then report ok/fail and refresh. */
  const runOp = async (
    verb: string,
    build: (list: string) => string,
    confirmMsg?: string,
  ) => {
    if (busy || matches.length === 0) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setMsg(null);
    try {
      // Emit one path per line, base64-encoded, so quoting/newlines never break.
      const list = paths.map((p) => btoa(unescape(encodeURIComponent(p)))).join(',');
      const res = await runPowershell(build(list));
      if (!res.success && !res.stdout.trim()) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      const out = res.stdout.trim();
      const m = /(\d+)\s+ok\s+(\d+)\s+fail/i.exec(out);
      const ok = m?.[1] ?? '?';
      const fail = m?.[2] ?? '?';
      setMsg(t('bulkops.result', { verb, ok, fail }));
      reload();
    } catch (e) {
      setMsg(`${verb}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Shared PS preamble: decode the base64 CSV into a $files array + a Uniq helper.
  const preamble =
    `$ok=0;$fail=0;` +
    `$files=@();foreach($b in ('__LIST__' -split ',')){ if($b){ $files += ` +
    `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b)) } };` +
    `function Uniq($p){ if(-not (Test-Path -LiteralPath $p)){return $p}; ` +
    `$d=Split-Path $p; $n=[System.IO.Path]::GetFileNameWithoutExtension($p); ` +
    `$e=[System.IO.Path]::GetExtension($p); $i=1; ` +
    `while($true){ $c=Join-Path $d ("{0} ({1}){2}" -f $n,$i,$e); ` +
    `if(-not (Test-Path -LiteralPath $c)){return $c}; $i++ } };`;

  const withList = (body: string) => (list: string) =>
    `${preamble.replace('__LIST__', list)}${body}"$ok ok $fail fail"`;

  const copyOp = () => {
    if (target.trim() === '') { setMsg(t('bulkops.pickTarget')); return; }
    const tgt = psq(target.trim());
    void runOp(
      t('bulkops.copied'),
      withList(
        `New-Item -ItemType Directory -Force -Path '${tgt}' | Out-Null;` +
          `foreach($f in $files){ try{ $dest=Uniq (Join-Path '${tgt}' (Split-Path $f -Leaf));` +
          `Copy-Item -LiteralPath $f -Destination $dest -ErrorAction Stop; $ok++ }catch{ $fail++ } };`,
      ),
    );
  };

  const moveOp = () => {
    if (target.trim() === '') { setMsg(t('bulkops.pickTarget')); return; }
    const tgt = psq(target.trim());
    void runOp(
      t('bulkops.moved'),
      withList(
        `New-Item -ItemType Directory -Force -Path '${tgt}' | Out-Null;` +
          `foreach($f in $files){ try{ $dest=Uniq (Join-Path '${tgt}' (Split-Path $f -Leaf));` +
          `Move-Item -LiteralPath $f -Destination $dest -ErrorAction Stop; $ok++ }catch{ $fail++ } };`,
      ),
      t('bulkops.confirm', { verb: t('bulkops.move'), matchCount: matches.length }),
    );
  };

  const recycleOp = () =>
    void runOp(
      t('bulkops.recycled'),
      withList(
        `Add-Type -AssemblyName Microsoft.VisualBasic;` +
          `foreach($f in $files){ try{ ` +
          `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f,'OnlyErrorDialogs','SendToRecycleBin'); ` +
          `$ok++ }catch{ $fail++ } };`,
      ),
      t('bulkops.confirm', { verb: t('bulkops.recycle'), matchCount: matches.length }),
    );

  const flattenOp = () => {
    const root = psq(src);
    void runOp(
      t('bulkops.flattened'),
      withList(
        `foreach($f in $files){ try{ ` +
          `if((Split-Path $f) -ieq '${root}'){ $ok++; continue };` +
          `$dest=Uniq (Join-Path '${root}' (Split-Path $f -Leaf));` +
          `Move-Item -LiteralPath $f -Destination $dest -ErrorAction Stop; $ok++ }catch{ $fail++ } };`,
      ),
      t('bulkops.confirm', { verb: t('bulkops.flatten'), matchCount: matches.length }),
    );
  };

  const organizeOp = () => {
    const root = psq(src);
    void runOp(
      t('bulkops.organised'),
      withList(
        `foreach($f in $files){ try{ ` +
          `$e=[System.IO.Path]::GetExtension($f).TrimStart('.').ToUpperInvariant();` +
          `if(-not $e){ $e='_noext' };` +
          `$sub=Join-Path '${root}' $e; New-Item -ItemType Directory -Force -Path $sub | Out-Null;` +
          `$dest=Uniq (Join-Path $sub (Split-Path $f -Leaf));` +
          `Move-Item -LiteralPath $f -Destination $dest -ErrorAction Stop; $ok++ }catch{ $fail++ } };`,
      ),
      t('bulkops.confirm', { verb: t('bulkops.organise'), matchCount: matches.length }),
    );
  };

  const columns: Column<Match>[] = [
    { key: 'Name', header: t('bulkops.colName') },
    { key: 'Dir', header: t('bulkops.colDir') },
    {
      key: 'Size',
      header: t('bulkops.colSize'),
      width: 110,
      align: 'right',
      render: (m) => fmtSize(m.Size),
    },
  ];

  const totalBytes = useMemo(() => matches.reduce((a, m) => a + (m.Size || 0), 0), [matches]);
  const hasMatches = matches.length > 0;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('bulkops.blurb')}
      </p>

      <div className="mod-toolbar">
        <label className="count-note" style={{ minWidth: 60 }}>
          {t('bulkops.source')}
        </label>
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('bulkops.sourcePh')}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </div>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('bulkops.patternPh')}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <select
          className="mini"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="Wildcard">{t('bulkops.modeWildcard')}</option>
          <option value="Regex">{t('bulkops.modeRegex')}</option>
          <option value="Extension">{t('bulkops.modeExtension')}</option>
        </select>
        <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={recurse}
            onChange={(e) => setRecurse(e.target.checked)}
          />
          {t('bulkops.subfolders')}
        </label>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {src === ''
          ? t('bulkops.noSource')
          : t('bulkops.matched', { matchCount: matches.length, size: fmtSize(totalBytes) })}
      </p>

      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={columns}
          rows={matches}
          rowKey={(m) => m.Path}
          empty={src === '' ? t('bulkops.noSource') : t('bulkops.noMatch')}
        />
      </AsyncState>

      <div className="mod-toolbar">
        <label className="count-note" style={{ minWidth: 60 }}>
          {t('bulkops.target')}
        </label>
        <input
          className="mod-search"
          style={{ flex: 1 }}
          placeholder={t('bulkops.targetPh')}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>

      <div className="mod-toolbar">
        <button className="mini primary" disabled={busy || !hasMatches} onClick={copyOp}>
          {t('bulkops.copyTo')}
        </button>
        <button className="mini" disabled={busy || !hasMatches} onClick={moveOp}>
          {t('bulkops.moveTo')}
        </button>
        <button className="mini" disabled={busy || !hasMatches} onClick={recycleOp}>
          {t('bulkops.recycle')}
        </button>
        <button className="mini" disabled={busy || !hasMatches} onClick={flattenOp}>
          {t('bulkops.flatten')}
        </button>
        <button className="mini" disabled={busy || !hasMatches} onClick={organizeOp}>
          {t('bulkops.organise')}
        </button>
        {busy && <span className="count-note">{t('bulkops.working')}</span>}
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('bulkops.safetyNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
    </div>
  );
}
