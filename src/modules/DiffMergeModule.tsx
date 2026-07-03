import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, StatusDot } from './common';

// Native port of WinForge DiffMergeModule + DiffService (Pages/DiffMergeModule.xaml.cs,
// Services/DiffService.cs). Two views: a side-by-side text diff of two real files read
// from disk (Myers-style LCS line diff + intra-line word highlighting, ignore-whitespace,
// next/prev nav, gated copy-line merge + save-back), and a recursive folder compare
// (size + SHA-256 content hash) whose differing file pairs open in the text diff.
// All disk access is via the Tauri PowerShell bridge; data-gathering + explicit saves only.

// ── Line-diff types (mirror DiffService.LineKind / DiffRow) ─────────────────────
type LineKind = 'equal' | 'modify' | 'insert' | 'delete';
interface DiffRow {
  kind: LineKind;
  left: string | null;
  right: string | null;
  leftNo: number; // 1-based, 0 if no line this side
  rightNo: number;
}
interface Span {
  text: string;
  changed: boolean;
}

// ── Line splitting + whitespace key (mirror DiffService.SplitLines / CollapseWhitespace) ─
function splitLines(text: string): string[] {
  if (!text) return [];
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return norm.split('\n');
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function lineKey(s: string, ignoreWs: boolean): string {
  return ignoreWs ? collapseWs(s) : s;
}

// ── LCS edit script (DiffService uses Myers; an LCS backtrack yields the same rows) ──
type EditOp = 'equal' | 'delete' | 'insert';

function lcsOps(a: string[], b: string[], key: (s: string) => string): EditOp[] {
  const n = a.length;
  const m = b.length;
  const ka = a.map(key);
  const kb = b.map(key);
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = ka[i] === kb[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      ops.push('equal');
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push('delete');
      i++;
    } else {
      ops.push('insert');
      j++;
    }
  }
  while (i < n) {
    ops.push('delete');
    i++;
  }
  while (j < m) {
    ops.push('insert');
    j++;
  }
  return ops;
}

// Build aligned side-by-side rows, pairing adjacent delete+insert runs as "modify"
// rows for nicer merging — mirrors DiffService.DiffLines.
function diffLines(a: string[], b: string[], ignoreWs: boolean): DiffRow[] {
  const key = (s: string) => lineKey(s, ignoreWs);
  const ops = lcsOps(a, b, key);
  const rows: DiffRow[] = [];
  let ai = 0;
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === 'equal') {
      rows.push({ kind: 'equal', left: a[ai]!, right: b[bi]!, leftNo: ai + 1, rightNo: bi + 1 });
      ai++;
      bi++;
      i++;
      continue;
    }
    const delStart = ai;
    const insStart = bi;
    let dels = 0;
    let inss = 0;
    let j = i;
    while (j < ops.length && ops[j] === 'delete') {
      dels++;
      j++;
    }
    while (j < ops.length && ops[j] === 'insert') {
      inss++;
      j++;
    }
    if (dels === 0 && inss === 0) {
      i++;
      continue;
    }
    const paired = Math.min(dels, inss);
    for (let k = 0; k < paired; k++) {
      rows.push({
        kind: 'modify',
        left: a[delStart + k]!,
        right: b[insStart + k]!,
        leftNo: delStart + k + 1,
        rightNo: insStart + k + 1,
      });
    }
    for (let k = paired; k < dels; k++) {
      rows.push({ kind: 'delete', left: a[delStart + k]!, right: null, leftNo: delStart + k + 1, rightNo: 0 });
    }
    for (let k = paired; k < inss; k++) {
      rows.push({ kind: 'insert', left: null, right: b[insStart + k]!, leftNo: 0, rightNo: insStart + k + 1 });
    }
    ai += dels;
    bi += inss;
    i = j;
  }
  return rows;
}

// ── Intra-line word diff (mirror DiffService.DiffWords / Tokenize) ───────────────
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);
  const isWs = (c: string) => /\s/.test(c);
  while (i < s.length) {
    const start = i;
    const c = s[i]!;
    if (isAlnum(c)) {
      while (i < s.length && isAlnum(s[i]!)) i++;
    } else if (isWs(c)) {
      while (i < s.length && isWs(s[i]!)) i++;
    } else {
      i++;
    }
    tokens.push(s.slice(start, i));
  }
  return tokens;
}

function diffWords(left: string, right: string): { left: Span[]; right: Span[] } {
  const la = tokenize(left);
  const ra = tokenize(right);
  const ops = lcsOps(la, ra, (s) => s);
  const leftSpans: Span[] = [];
  const rightSpans: Span[] = [];
  let ai = 0;
  let bi = 0;
  const append = (list: Span[], text: string, changed: boolean) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const op of ops) {
    if (op === 'equal') {
      append(leftSpans, la[ai]!, false);
      append(rightSpans, ra[bi]!, false);
      ai++;
      bi++;
    } else if (op === 'delete') {
      append(leftSpans, la[ai]!, true);
      ai++;
    } else {
      append(rightSpans, ra[bi]!, true);
      bi++;
    }
  }
  return { left: leftSpans, right: rightSpans };
}

// ── PowerShell escaping + disk helpers ──────────────────────────────────────────
function psQuote(p: string): string {
  return "'" + p.replace(/'/g, "''") + "'";
}

// Read a file's raw text from disk. Returns text (possibly empty) or throws.
async function readFileText(path: string): Promise<string> {
  const script = `[System.IO.File]::ReadAllText(${psQuote(path)})`;
  const res = await runPowershell(script);
  if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
  return res.stdout.replace(/\r?\n$/, ''); // PS adds a trailing newline to stdout
}

interface FolderItem {
  RelativePath: string;
  IsDirectory: boolean;
  Status: 'Identical' | 'Different' | 'OnlyLeft' | 'OnlyRight';
  LeftPath: string | null;
  RightPath: string | null;
  LeftSize: number;
  RightSize: number;
}

function humanSize(bytes: number): string {
  if (bytes < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} ${u[i]}` : `${v.toFixed(1)} ${u[i]}`;
}

// Recursive folder compare via PowerShell: size first, then SHA-256 when sizes match
// (mirrors DiffService.CompareFoldersAsync / FilesEqual). Emits clean JSON rows.
function folderCompareScript(left: string, right: string): string {
  return `
$ErrorActionPreference='Stop'
$L = (Resolve-Path -LiteralPath ${psQuote(left)}).Path
$R = (Resolve-Path -LiteralPath ${psQuote(right)}).Path
function Rel($base,$full){ $b=$base.TrimEnd('\\')+'\\'; if($full.StartsWith($b,[StringComparison]::OrdinalIgnoreCase)){ return $full.Substring($b.Length) } return $full }
function Enum($root){
  $h=@{}
  Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = Rel $root $_.FullName
    $h[$rel.ToLowerInvariant()] = [PSCustomObject]@{ Rel=$rel; Full=$_.FullName; IsDir=$_.PSIsContainer; Size=($(if($_.PSIsContainer){0}else{$_.Length})) }
  }
  $h
}
$lh = Enum $L
$rh = Enum $R
$keys = New-Object 'System.Collections.Generic.HashSet[string]'
foreach($k in $lh.Keys){ [void]$keys.Add($k) }
foreach($k in $rh.Keys){ [void]$keys.Add($k) }
$rows = New-Object System.Collections.ArrayList
foreach($k in $keys){
  $l = $lh[$k]; $r = $rh[$k]
  if($l -and $r){
    $isDir = $l.IsDir
    if($isDir){ $status='Identical' }
    elseif($l.Size -ne $r.Size){ $status='Different' }
    else {
      if($l.Size -eq 0){ $status='Identical' }
      else {
        $ha=(Get-FileHash -LiteralPath $l.Full -Algorithm SHA256).Hash
        $hb=(Get-FileHash -LiteralPath $r.Full -Algorithm SHA256).Hash
        $status = $(if($ha -eq $hb){'Identical'}else{'Different'})
      }
    }
    [void]$rows.Add([PSCustomObject]@{ RelativePath=$l.Rel; IsDirectory=$isDir; Status=$status; LeftPath=$l.Full; RightPath=$r.Full; LeftSize=[long]$l.Size; RightSize=[long]$r.Size })
  } elseif($l){
    [void]$rows.Add([PSCustomObject]@{ RelativePath=$l.Rel; IsDirectory=$l.IsDir; Status='OnlyLeft'; LeftPath=$l.Full; RightPath=$null; LeftSize=[long]$l.Size; RightSize=[long]0 })
  } else {
    [void]$rows.Add([PSCustomObject]@{ RelativePath=$r.Rel; IsDirectory=$r.IsDir; Status='OnlyRight'; LeftPath=$null; RightPath=$r.Full; LeftSize=[long]0; RightSize=[long]$r.Size })
  }
}
$rows | Sort-Object RelativePath`.trim();
}

// ── Text-diff sub-view ──────────────────────────────────────────────────────────
function DiffRowView({ row, ignoreWs }: { row: DiffRow; ignoreWs: boolean }) {
  const words = row.kind === 'modify' && row.left !== null && row.right !== null ? diffWords(row.left, row.right) : null;
  void ignoreWs;
  const cellBg = (side: 'l' | 'r'): string | undefined => {
    if (row.kind === 'delete') return side === 'l' ? 'color-mix(in srgb, var(--danger) 16%, transparent)' : 'rgba(128,128,128,0.08)';
    if (row.kind === 'insert') return side === 'r' ? 'color-mix(in srgb, var(--web) 16%, transparent)' : 'rgba(128,128,128,0.08)';
    if (row.kind === 'modify') return 'color-mix(in srgb, var(--warn, #e3a21a) 16%, transparent)';
    return undefined;
  };
  const renderBody = (text: string | null, spans: Span[] | undefined) => {
    if (spans) {
      return spans.map((s, i) =>
        s.changed ? (
          <b key={i} className="dm-word">
            {s.text}
          </b>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      );
    }
    return text ?? '';
  };
  const cell = (no: number, text: string | null, spans: Span[] | undefined, side: 'l' | 'r') => (
    <div className="dm-cell" style={{ background: cellBg(side) }}>
      <span className="dm-no">{no > 0 ? no : ''}</span>
      <span className="dm-body">{renderBody(text, spans)}</span>
    </div>
  );
  return (
    <div className="dm-row">
      {cell(row.leftNo, row.left, words?.left, 'l')}
      <div className="dm-gutter">{row.kind !== 'equal' ? '≠' : ''}</div>
      {cell(row.rightNo, row.right, words?.right, 'r')}
    </div>
  );
}

export function DiffMergeModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'text' | 'folder'>('text');

  // Text-diff state
  const [leftPath, setLeftPath] = useState('');
  const [rightPath, setRightPath] = useState('');
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [leftLines, setLeftLines] = useState<string[] | null>(null);
  const [rightLines, setRightLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [textMsg, setTextMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const navPos = useRef(-1);

  const rows = useMemo<DiffRow[] | null>(() => {
    if (leftLines === null || rightLines === null) return null;
    return diffLines(leftLines, rightLines, ignoreWs);
  }, [leftLines, rightLines, ignoreWs]);

  const diffIndices = useMemo(() => {
    if (!rows) return [];
    const out: number[] = [];
    rows.forEach((r, i) => {
      if (r.kind !== 'equal') out.push(i);
    });
    return out;
  }, [rows]);

  const summary = useMemo(() => {
    if (!rows) return null;
    const mod = rows.filter((r) => r.kind === 'modify').length;
    const add = rows.filter((r) => r.kind === 'insert').length;
    const del = rows.filter((r) => r.kind === 'delete').length;
    return { mod, add, del };
  }, [rows]);

  const compare = useCallback(
    async (lp: string, rp: string) => {
      const l = lp.trim();
      const r = rp.trim();
      if (!l || !r) {
        setTextMsg({ ok: false, text: t('diffmerge.pickBothFiles') });
        return;
      }
      setLoading(true);
      setTextMsg(null);
      navPos.current = -1;
      try {
        const [lt, rt] = await Promise.all([readFileText(l), readFileText(r)]);
        setLeftLines(splitLines(lt));
        setRightLines(splitLines(rt));
      } catch (e) {
        setTextMsg({ ok: false, text: `${t('diffmerge.loadFailed')}: ${String(e)}` });
        setLeftLines(null);
        setRightLines(null);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const swap = () => {
    setLeftPath(rightPath);
    setRightPath(leftPath);
    setLeftLines(rightLines);
    setRightLines(leftLines);
  };

  const navDiff = (dir: number) => {
    if (diffIndices.length === 0) return;
    navPos.current += dir;
    if (navPos.current < 0) navPos.current = diffIndices.length - 1;
    if (navPos.current >= diffIndices.length) navPos.current = 0;
    const target = diffIndices[navPos.current]!;
    const container = listRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-row="${target}"]`);
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - container.offsetTop - 40, behavior: 'smooth' });
      el.classList.add('dm-flash');
      window.setTimeout(() => el.classList.remove('dm-flash'), 900);
    }
  };

  // Gated save-back: write the current (possibly merged) side to its file.
  const saveSide = async (side: 'left' | 'right') => {
    const path = side === 'left' ? leftPath.trim() : rightPath.trim();
    const lines = side === 'left' ? leftLines : rightLines;
    if (!path || lines === null) {
      setTextMsg({ ok: false, text: t('diffmerge.noSideToSave') });
      return;
    }
    if (!window.confirm(t('diffmerge.confirmSave', { path }))) return;
    setLoading(true);
    try {
      const text = lines.join('\r\n');
      const b64 = btoa(unescape(encodeURIComponent(text)));
      const script = `$b=[System.Convert]::FromBase64String('${b64}'); $t=[System.Text.Encoding]::UTF8.GetString($b); [System.IO.File]::WriteAllText(${psQuote(
        path,
      )}, $t, (New-Object System.Text.UTF8Encoding($false))); 'ok'`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setTextMsg({ ok: true, text: t('diffmerge.saved', { path }) });
    } catch (e) {
      setTextMsg({ ok: false, text: `${t('diffmerge.saveFailed')}: ${String(e)}` });
    } finally {
      setLoading(false);
    }
  };

  // Copy one changed line across, then re-diff (mirror ApplyMerge).
  const applyMerge = (rowIndex: number, toLeft: boolean) => {
    if (!rows) return;
    const row = rows[rowIndex];
    if (!row || leftLines === null || rightLines === null) return;
    const nextLeft = [...leftLines];
    const nextRight = [...rightLines];
    if (toLeft) {
      if (row.kind === 'insert') {
        // insert on left at the nearest anchor
        let insertAt = 0;
        for (let i = rowIndex - 1; i >= 0; i--) {
          if (rows[i]!.leftNo > 0) {
            insertAt = rows[i]!.leftNo;
            break;
          }
        }
        nextLeft.splice(insertAt, 0, row.right ?? '');
      } else if (row.kind === 'delete') {
        const li = row.leftNo - 1;
        if (li >= 0 && li < nextLeft.length) nextLeft.splice(li, 1);
      } else if (row.kind === 'modify') {
        const li = row.leftNo - 1;
        if (li >= 0 && li < nextLeft.length) nextLeft[li] = row.right ?? '';
      }
      setLeftLines(nextLeft);
    } else {
      if (row.kind === 'delete') {
        let insertAt = 0;
        for (let i = rowIndex - 1; i >= 0; i--) {
          if (rows[i]!.rightNo > 0) {
            insertAt = rows[i]!.rightNo;
            break;
          }
        }
        nextRight.splice(insertAt, 0, row.left ?? '');
      } else if (row.kind === 'insert') {
        const ri = row.rightNo - 1;
        if (ri >= 0 && ri < nextRight.length) nextRight.splice(ri, 1);
      } else if (row.kind === 'modify') {
        const ri = row.rightNo - 1;
        if (ri >= 0 && ri < nextRight.length) nextRight[ri] = row.left ?? '';
      }
      setRightLines(nextRight);
    }
    setTextMsg({ ok: true, text: t('diffmerge.lineMerged') });
  };

  // ── Folder-compare state ──
  const [leftDir, setLeftDir] = useState('');
  const [rightDir, setRightDir] = useState('');
  const [items, setItems] = useState<FolderItem[] | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirFilter, setDirFilter] = useState('all');

  const runFolderCompare = async (ld: string, rd: string) => {
    const l = ld.trim();
    const r = rd.trim();
    if (!l || !r) {
      setDirError(t('diffmerge.pickBothFolders'));
      return;
    }
    setDirLoading(true);
    setDirError(null);
    try {
      const res = await runPowershellJson<FolderItem>(folderCompareScript(l, r));
      setItems(res);
    } catch (e) {
      setDirError(String(e));
      setItems(null);
    } finally {
      setDirLoading(false);
    }
  };

  const filteredItems = useMemo(() => {
    if (!items) return [];
    return items.filter((it) => {
      switch (dirFilter) {
        case 'all':
          return true;
        case 'diff':
          return it.Status !== 'Identical';
        case 'different':
          return it.Status === 'Different';
        case 'left':
          return it.Status === 'OnlyLeft';
        case 'right':
          return it.Status === 'OnlyRight';
        case 'identical':
          return it.Status === 'Identical';
        default:
          return true;
      }
    });
  }, [items, dirFilter]);

  const dirDiffCount = useMemo(() => (items ? items.filter((i) => i.Status !== 'Identical').length : 0), [items]);

  const openPair = (it: FolderItem) => {
    if (it.IsDirectory) return;
    if (it.Status === 'OnlyLeft' || it.Status === 'OnlyRight' || !it.LeftPath || !it.RightPath) {
      setDirError(t('diffmerge.oneSideOnly'));
      return;
    }
    setLeftPath(it.LeftPath);
    setRightPath(it.RightPath);
    setTab('text');
    void compare(it.LeftPath, it.RightPath);
  };

  const statusLabel = (s: FolderItem['Status']) =>
    t(
      s === 'Identical'
        ? 'diffmerge.stIdentical'
        : s === 'Different'
          ? 'diffmerge.stDifferent'
          : s === 'OnlyLeft'
            ? 'diffmerge.stOnlyLeft'
            : 'diffmerge.stOnlyRight',
    );

  const folderColumns: Column<FolderItem>[] = [
    {
      key: 'RelativePath',
      header: t('diffmerge.colItem'),
      render: (it) => (
        <span className="dm-item">
          <span className="dm-glyph">{it.IsDirectory ? '📁' : '📄'}</span>
          {it.RelativePath}
        </span>
      ),
    },
    {
      key: 'Status',
      header: t('diffmerge.colStatus'),
      width: 150,
      render: (it) => <StatusDot ok={it.Status === 'Identical'} label={statusLabel(it.Status)} />,
    },
    {
      key: 'LeftSize',
      header: t('diffmerge.colLeft'),
      width: 100,
      align: 'right',
      render: (it) => (it.IsDirectory || !it.LeftPath ? '' : humanSize(it.LeftSize)),
    },
    {
      key: 'RightSize',
      header: t('diffmerge.colRight'),
      width: 100,
      align: 'right',
      render: (it) => (it.IsDirectory || !it.RightPath ? '' : humanSize(it.RightSize)),
    },
    {
      key: 'actions',
      header: '',
      width: 90,
      render: (it) =>
        !it.IsDirectory && it.Status === 'Different' ? (
          <button className="mini" onClick={() => openPair(it)}>
            {t('diffmerge.openDiff')}
          </button>
        ) : (
          ''
        ),
    },
  ];

  const filters: { code: string; key: string }[] = [
    { code: 'all', key: 'diffmerge.fAll' },
    { code: 'diff', key: 'diffmerge.fDiff' },
    { code: 'different', key: 'diffmerge.fDifferent' },
    { code: 'left', key: 'diffmerge.fLeft' },
    { code: 'right', key: 'diffmerge.fRight' },
    { code: 'identical', key: 'diffmerge.fIdentical' },
  ];

  return (
    <div className="mod">
      <style>{DM_CSS}</style>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('diffmerge.blurb')}
      </p>

      <div className="mod-tabbar" role="tablist" style={{ marginBottom: 12 }}>
        <button
          role="tab"
          aria-selected={tab === 'text'}
          className={`mod-tab${tab === 'text' ? ' active' : ''}`}
          onClick={() => setTab('text')}
        >
          {t('diffmerge.tabText')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'folder'}
          className={`mod-tab${tab === 'folder' ? ' active' : ''}`}
          onClick={() => setTab('folder')}
        >
          {t('diffmerge.tabFolder')}
        </button>
      </div>

      {tab === 'text' ? (
        <>
          <div className="io-grid">
            <div>
              <label className="rx-label">{t('diffmerge.leftFile')}</label>
              <input
                className="mod-search"
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                value={leftPath}
                onChange={(e) => setLeftPath(e.target.value)}
                placeholder="C:\\path\\to\\left.txt"
              />
            </div>
            <div>
              <label className="rx-label">{t('diffmerge.rightFile')}</label>
              <input
                className="mod-search"
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                value={rightPath}
                onChange={(e) => setRightPath(e.target.value)}
                placeholder="C:\\path\\to\\right.txt"
              />
            </div>
          </div>

          <div className="mod-toolbar" style={{ marginTop: 10, alignItems: 'center' }}>
            <button className="mini primary" disabled={loading} onClick={() => compare(leftPath, rightPath)}>
              ⟳ {t('diffmerge.compare')}
            </button>
            <button className="mini" onClick={swap} title={t('diffmerge.swap')}>
              ⇄ {t('diffmerge.swap')}
            </button>
            <button className="mini" disabled={!rows} onClick={() => navDiff(-1)} title={t('diffmerge.prevDiff')}>
              ↑
            </button>
            <button className="mini" disabled={!rows} onClick={() => navDiff(1)} title={t('diffmerge.nextDiff')}>
              ↓
            </button>
            <label className="chk" style={{ margin: 0 }}>
              <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
              {t('diffmerge.ignoreWs')}
            </label>
            <span style={{ flex: 1 }} />
            <button className="mini" disabled={leftLines === null || loading} onClick={() => saveSide('left')}>
              💾 {t('diffmerge.saveLeft')}
            </button>
            <button className="mini" disabled={rightLines === null || loading} onClick={() => saveSide('right')}>
              💾 {t('diffmerge.saveRight')}
            </button>
          </div>

          {summary && (
            <p className="count-note" style={{ marginTop: 8 }}>
              <span style={{ color: 'var(--warn, #e3a21a)' }}>{t('diffmerge.nChanged', { n: summary.mod })}</span> ·{' '}
              <span style={{ color: 'var(--web)' }}>{t('diffmerge.nAdded', { n: summary.add })}</span> ·{' '}
              <span style={{ color: 'var(--danger)' }}>{t('diffmerge.nRemoved', { n: summary.del })}</span>
            </p>
          )}

          {textMsg && (
            <p
              className={textMsg.ok ? 'count-note' : ''}
              style={textMsg.ok ? { marginTop: 8 } : { marginTop: 8, color: 'var(--danger)', fontSize: 12.5 }}
            >
              {textMsg.text}
            </p>
          )}

          {loading ? (
            <p className="count-note" style={{ marginTop: 12 }}>
              {t('diffmerge.loading')}
            </p>
          ) : rows === null ? (
            <p className="count-note" style={{ marginTop: 12 }}>
              {t('diffmerge.textEmpty')}
            </p>
          ) : (
            <div className="dm-diff" ref={listRef}>
              <div className="dm-header">
                <span>{leftPath ? leftPath.split(/[\\/]/).pop() : t('diffmerge.left')}</span>
                <span>{rightPath ? rightPath.split(/[\\/]/).pop() : t('diffmerge.right')}</span>
              </div>
              {rows.map((row, i) => (
                <div key={i} data-row={i} className="dm-rowwrap">
                  {row.kind !== 'equal' && (
                    <div className="dm-merge">
                      <button className="dm-mbtn" title={t('diffmerge.copyLeft')} onClick={() => applyMerge(i, true)}>
                        ←
                      </button>
                      <button className="dm-mbtn" title={t('diffmerge.copyRight')} onClick={() => applyMerge(i, false)}>
                        →
                      </button>
                    </div>
                  )}
                  <DiffRowView row={row} ignoreWs={ignoreWs} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="io-grid">
            <div>
              <label className="rx-label">{t('diffmerge.leftFolder')}</label>
              <input
                className="mod-search"
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                value={leftDir}
                onChange={(e) => setLeftDir(e.target.value)}
                placeholder="C:\\path\\to\\left"
              />
            </div>
            <div>
              <label className="rx-label">{t('diffmerge.rightFolder')}</label>
              <input
                className="mod-search"
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                value={rightDir}
                onChange={(e) => setRightDir(e.target.value)}
                placeholder="C:\\path\\to\\right"
              />
            </div>
          </div>

          <div className="mod-toolbar" style={{ marginTop: 10, alignItems: 'center' }}>
            <button className="mini primary" disabled={dirLoading} onClick={() => runFolderCompare(leftDir, rightDir)}>
              ⟳ {t('diffmerge.compare')}
            </button>
            <button
              className="mini"
              onClick={() => {
                setLeftDir(rightDir);
                setRightDir(leftDir);
              }}
              title={t('diffmerge.swap')}
            >
              ⇄ {t('diffmerge.swap')}
            </button>
            <select className="mod-select" value={dirFilter} onChange={(e) => setDirFilter(e.target.value)}>
              {filters.map((f) => (
                <option key={f.code} value={f.code}>
                  {t(f.key)}
                </option>
              ))}
            </select>
            {items && (
              <span className="count-note">
                {t('diffmerge.dirSummary', { total: items.length, diff: dirDiffCount })}
              </span>
            )}
          </div>

          <p className="count-note" style={{ marginTop: 0 }}>
            {t('diffmerge.folderHint')}
          </p>

          {items === null && !dirLoading && !dirError ? (
            <p className="count-note" style={{ marginTop: 12 }}>
              {t('diffmerge.folderEmpty')}
            </p>
          ) : (
            <AsyncState loading={dirLoading} error={dirError}>
              <DataTable
                columns={folderColumns}
                rows={filteredItems}
                rowKey={(it) => (it.IsDirectory ? 'd:' : 'f:') + it.RelativePath}
              />
            </AsyncState>
          )}
        </>
      )}
    </div>
  );
}

const DM_CSS = `
.dm-diff { margin-top: 12px; border: 1px solid var(--stroke); border-radius: var(--radius); max-height: 460px; overflow: auto; background: #0e0e11; }
.dm-header { position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: 1fr 44px 1fr; background: var(--bg-secondary, #17171b); font-size: 12px; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--stroke); }
.dm-header > span:last-child { grid-column: 3; }
.dm-rowwrap { position: relative; }
.dm-row { display: grid; grid-template-columns: 1fr 44px 1fr; font-family: 'Cascadia Code','Consolas',ui-monospace,monospace; font-size: 12.5px; line-height: 1.55; }
.dm-cell { display: flex; align-items: baseline; padding: 0 6px; white-space: pre; overflow: hidden; }
.dm-no { flex: 0 0 44px; text-align: right; padding-right: 8px; color: var(--text-tertiary, #888); user-select: none; }
.dm-body { flex: 1; white-space: pre; }
.dm-word { color: var(--accent, #6ea8fe); font-weight: 700; }
.dm-gutter { display: flex; align-items: center; justify-content: center; color: var(--text-tertiary, #888); font-size: 11px; }
.dm-merge { position: absolute; left: 50%; top: 0; transform: translateX(-50%); display: flex; gap: 2px; z-index: 2; }
.dm-mbtn { border: 1px solid var(--stroke); background: var(--bg-secondary, #17171b); color: var(--text); border-radius: 4px; font-size: 10px; line-height: 1; padding: 1px 4px; cursor: pointer; }
.dm-mbtn:hover { background: var(--accent, #6ea8fe); color: #000; }
.dm-flash { outline: 2px solid var(--accent, #6ea8fe); outline-offset: -2px; }
.dm-item { display: inline-flex; align-items: center; gap: 8px; }
.dm-glyph { opacity: 0.8; }
`;
