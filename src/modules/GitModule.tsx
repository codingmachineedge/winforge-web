import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// GitHub-Desktop-style Git workbench — a faithful web port of WinForge's GitDeskService.
// Tabs (Changes / History / Branches) over a local repo, driven through the native backend
// with `git -C <repo>`; coloured diffs, staging, commit, log graph, branch ops. Editing here
// means editing the repo state (stage / unstage / discard / commit) as GitHub Desktop does.

const REPO_KEY = 'winforge-web.git.repo';

async function git(gitPath: string, repo: string, args: string[]): Promise<CommandOutput> {
  return runCommand(gitPath, ['-c', 'core.quotepath=false', '-C', repo, ...args]);
}

// ---- porcelain v2 parsing (ported from GitDeskService.Changes) ----
interface Change { path: string; oldPath?: string; index: string; work: string; untracked: boolean; conflicted: boolean }
const unquote = (p: string) => {
  p = p.trim();
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return p;
};
const isStaged = (c: Change) => !c.untracked && !'.?!'.includes(c.index);
const isUnstaged = (c: Change) => c.untracked || !'.!'.includes(c.work);
function badge(c: Change): string {
  if (c.conflicted) return 'U';
  if (c.untracked) return '?';
  if (!'.?'.includes(c.index)) return c.index;
  return c.work !== '.' ? c.work : 'M';
}
function parseStatus(out: string): Change[] {
  const list: Change[] = [];
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    if (raw.length < 2) continue;
    const kind = raw[0];
    try {
      if (kind === '1') {
        const parts = raw.split(' ');
        if (parts.length < 9) continue;
        const xy = parts[1]!;
        list.push({ index: xy[0]!, work: xy[1]!, path: unquote(parts.slice(8).join(' ')), untracked: false, conflicted: false });
      } else if (kind === '2') {
        const parts = raw.split(' ');
        if (parts.length < 10) continue;
        const xy = parts[1]!;
        const rest = parts.slice(9).join(' ');
        const tab = rest.indexOf('\t');
        const cur = tab >= 0 ? rest.slice(0, tab) : rest;
        const old = tab >= 0 ? rest.slice(tab + 1) : '';
        list.push({ index: xy[0]!, work: xy[1]!, path: unquote(cur), oldPath: unquote(old), untracked: false, conflicted: false });
      } else if (kind === 'u') {
        const parts = raw.split(' ');
        if (parts.length < 11) continue;
        const xy = parts[1]!;
        list.push({ index: xy[0]!, work: xy[1]!, path: unquote(parts.slice(10).join(' ')), untracked: false, conflicted: true });
      } else if (kind === '?') {
        list.push({ index: '?', work: '?', path: unquote(raw.slice(2)), untracked: true, conflicted: false });
      }
    } catch { /* tolerate one bad line */ }
  }
  return list.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
}

// ---- diff parsing ----
type DiffKind = 'ctx' | 'add' | 'del' | 'header' | 'hunk' | 'meta';
interface DiffLine { kind: DiffKind; text: string }
function parseDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  if (!text) return lines;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (/^(diff |index |new file|deleted file|similarity |rename |old mode|new mode)/.test(raw)) lines.push({ kind: 'meta', text: raw });
    else if (raw.startsWith('@@')) lines.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+++') || raw.startsWith('---')) lines.push({ kind: 'header', text: raw });
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw });
    else lines.push({ kind: 'ctx', text: raw });
  }
  return lines;
}
const DIFF_CLASS: Record<DiffKind, string> = { ctx: 'diff-ctx', add: 'diff-add', del: 'diff-del', header: 'diff-ctx', hunk: 'diff-ctx', meta: 'diff-ctx' };

function DiffView({ lines }: { lines: DiffLine[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) return <p className="count-note">{t('git.noDiff')}</p>;
  return (
    <pre className="diff-out" style={{ margin: 0, maxHeight: 360, overflow: 'auto' }}>
      {lines.map((l, i) => (
        <div key={i} className={DIFF_CLASS[l.kind]} style={l.kind === 'hunk' ? { color: 'var(--accent, #58a6ff)', fontWeight: 600 } : undefined}>{l.text || ' '}</div>
      ))}
    </pre>
  );
}

// ==================== Changes tab ====================
function ChangesTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<Change | null>(null);
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [summary, setSummary] = useState('');
  const [desc, setDesc] = useState('');
  const [ab, setAb] = useState<{ ahead: number; behind: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy('load');
    try {
      const st = await git(gitPath, repo, ['status', '--porcelain=v2', '--untracked-files=all']);
      const list = parseStatus(st.stdout);
      setChanges(list);
      const abr = await git(gitPath, repo, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const parts = abr.stdout.trim().split(/\s+/);
      if (abr.success && parts.length === 2) setAb({ behind: +parts[0]!, ahead: +parts[1]! });
      else setAb(null);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(''); }
  }, [gitPath, repo]);

  useEffect(() => { void refresh(); }, [refresh]);

  const showDiff = async (c: Change) => {
    setSelected(c);
    const staged = isStaged(c) && !isUnstaged(c);
    let args: string[];
    if (c.untracked) args = ['diff', '--no-color', '--no-index', '--', '/dev/null', c.path];
    else if (staged) args = ['diff', '--no-color', '--cached', '--', c.path];
    else args = ['diff', '--no-color', '--', c.path];
    const r = await git(gitPath, repo, args);
    setDiff(parseDiff(r.stdout));
  };

  const run = async (label: string, args: string[]) => {
    setBusy(label); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      if (!r.success) setMsg(r.stderr.trim() || `exit ${r.code}`);
      await refresh();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(''); }
  };

  const commit = async () => {
    if (!summary.trim()) { setMsg(t('git.needSummary')); return; }
    const args = ['commit', '-m', summary.trim()];
    if (desc.trim()) args.push('-m', desc.trim());
    await run('commit', args);
    setSummary(''); setDesc(''); setSelected(null); setDiff([]);
  };

  const staged = changes.filter(isStaged);
  const stagedCount = staged.length;

  return (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!!busy} onClick={refresh}>⟳ {t('git.refresh')}</button>
        <button className="mini" disabled={!!busy || changes.length === 0} onClick={() => run('stageAll', ['add', '-A'])}>{t('git.stageAll')}</button>
        <button className="mini" disabled={!!busy || stagedCount === 0} onClick={() => run('unstageAll', ['reset'])}>{t('git.unstageAll')}</button>
        <span style={{ flex: 1 }} />
        <button className="mini" disabled={!!busy} onClick={() => run('fetch', ['fetch', '--all', '--prune'])}>{t('git.fetch')}</button>
        <button className="mini" disabled={!!busy} onClick={() => run('pull', ['pull', '--ff-only'])}>{t('git.pull')}{ab && ab.behind > 0 ? ` ↓${ab.behind}` : ''}</button>
        <button className="mini primary" disabled={!!busy} onClick={() => run('push', ['push'])}>{t('git.push')}{ab && ab.ahead > 0 ? ` ↑${ab.ahead}` : ''}</button>
      </div>
      {msg && <pre className="cmd-out error">{msg}</pre>}
      <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <div className="panel" style={{ margin: 0, maxHeight: 420, overflow: 'auto' }}>
          <p className="count-note" style={{ marginTop: 0 }}>{t('git.changesCount', { n: changes.length, staged: stagedCount })}</p>
          {changes.length === 0 ? (
            <p className="count-note">{t('git.clean')}</p>
          ) : changes.map((c) => (
            <div key={c.path} className="kv-row" style={{ cursor: 'pointer', alignItems: 'center', background: selected?.path === c.path ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => showDiff(c)}>
              <span className={`badge ${badge(c) === 'D' ? 'neg' : isStaged(c) ? 'pos' : ''}`} style={{ fontFamily: 'monospace', width: 18, textAlign: 'center' }}>{badge(c)}</span>
              <span className="value" style={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1 }}>{c.path}</span>
              {isStaged(c)
                ? <button className="mini" onClick={(e) => { e.stopPropagation(); run('unstage', ['restore', '--staged', '--', c.path]); }}>−</button>
                : <button className="mini" onClick={(e) => { e.stopPropagation(); run('stage', ['add', '--', c.path]); }}>+</button>}
              <button className="mini" title={t('git.discard')} onClick={(e) => { e.stopPropagation(); if (confirm(t('git.discardConfirm', { path: c.path }))) run('discard', c.untracked ? ['clean', '-f', '--', c.path] : ['restore', '--', c.path]); }}>✕</button>
            </div>
          ))}
        </div>
        <div className="panel" style={{ margin: 0 }}>
          {selected ? <DiffView lines={diff} /> : <p className="count-note">{t('git.selectFile')}</p>}
        </div>
      </div>
      <div className="panel">
        <input className="hosts-edit" style={{ minHeight: 0, height: 36 }} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t('git.summary')} />
        <textarea className="hosts-edit" style={{ marginTop: 6, minHeight: 60 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('git.description')} />
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <button className="mini primary" disabled={!!busy || stagedCount === 0 || !summary.trim()} onClick={commit}>{busy === 'commit' ? t('git.committing') : t('git.commit', { n: stagedCount })}</button>
        </div>
      </div>
    </div>
  );
}

// ==================== History tab ====================
interface Commit { graph: string; hash: string; short: string; author: string; date: string; subject: string }
function HistoryTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [sel, setSel] = useState<Commit | null>(null);
  const [files, setFiles] = useState<{ status: string; path: string }[]>([]);
  const [diff, setDiff] = useState<DiffLine[]>([]);

  const load = useCallback(async () => {
    const r = await git(gitPath, repo, ['log', '--graph', '--date=short', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--max-count=200']);
    const out: Commit[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      const sepIdx = raw.indexOf('\x1f');
      if (sepIdx < 0) continue;
      const hashStart = sepIdx - 40;
      if (hashStart < 0 || !/^[0-9a-f]{40}$/.test(raw.slice(hashStart, sepIdx))) continue;
      const graph = raw.slice(0, hashStart).trimEnd();
      const f = raw.slice(hashStart).split('\x1f');
      if (f.length < 5) continue;
      out.push({ graph, hash: f[0]!, short: f[1]!, author: f[2]!, date: f[3]!, subject: f[4]! });
    }
    setCommits(out);
  }, [gitPath, repo]);
  useEffect(() => { void load(); }, [load]);

  const select = async (c: Commit) => {
    setSel(c);
    const fr = await git(gitPath, repo, ['show', '--name-status', '--format=', c.hash]);
    const fl: { status: string; path: string }[] = [];
    for (const raw of fr.stdout.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.length < 2) continue;
      const tab = line.indexOf('\t');
      let path = tab >= 0 ? line.slice(tab + 1).trim() : line.slice(1).trim();
      const lastTab = path.lastIndexOf('\t');
      if (lastTab >= 0) path = path.slice(lastTab + 1);
      fl.push({ status: line[0]!, path: unquote(path) });
    }
    setFiles(fl);
    const dr = await git(gitPath, repo, ['show', '--no-color', c.hash]);
    setDiff(parseDiff(dr.stdout));
  };

  return (
    <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
      <div className="panel" style={{ margin: 0, maxHeight: 480, overflow: 'auto' }}>
        {commits.length === 0 ? <p className="count-note">{t('git.noHistory')}</p> : commits.map((c) => (
          <div key={c.hash} className="kv-row" style={{ cursor: 'pointer', background: sel?.hash === c.hash ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => select(c)}>
            <span style={{ fontFamily: 'monospace', color: 'var(--accent, #58a6ff)' }}>{c.graph || '*'}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 12.5 }}>{c.subject}</span>
              <span className="count-note" style={{ fontSize: 11 }}><code>{c.short}</code> · {c.author} · {c.date}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="panel" style={{ margin: 0 }}>
        {sel ? (
          <>
            <p className="count-note" style={{ marginTop: 0 }}>{files.map((f) => `${f.status} ${f.path}`).join('\n') || sel.subject}</p>
            <DiffView lines={diff} />
          </>
        ) : <p className="count-note">{t('git.selectCommit')}</p>}
      </div>
    </div>
  );
}

// ==================== Branches tab ====================
interface Branch { name: string; current: boolean }
function BranchesTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await git(gitPath, repo, ['branch', '--no-color']);
    const list: Branch[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      if (!raw.trim()) continue;
      const current = raw.startsWith('*');
      const name = raw.replace(/^[*+]?\s*/, '').trim();
      if (name && !name.startsWith('(')) list.push({ name, current });
    }
    setBranches(list);
  }, [gitPath, repo]);
  useEffect(() => { void load(); }, [load]);

  const run = async (args: string[], confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      if (!r.success) setMsg(r.stderr.trim() || `exit ${r.code}`);
      await load();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mod-toolbar">
        <input className="mod-search" style={{ maxWidth: 220 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('git.newBranch')} />
        <button className="mini primary" disabled={busy || !newName.trim()} onClick={() => { run(['switch', '-c', newName.trim()]); setNewName(''); }}>{t('git.create')}</button>
      </div>
      {msg && <pre className="cmd-out error">{msg}</pre>}
      <div className="panel">
        {branches.map((b) => (
          <div key={b.name} className="kv-row" style={{ alignItems: 'center' }}>
            <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontWeight: b.current ? 700 : 400 }}>{b.current ? '● ' : ''}{b.name}</span>
            {!b.current && <>
              <button className="mini" disabled={busy} onClick={() => run(['switch', b.name])}>{t('git.switch')}</button>
              <button className="mini" disabled={busy} onClick={() => run(['merge', b.name], t('git.mergeConfirm', { name: b.name }))}>{t('git.merge')}</button>
              <button className="mini" disabled={busy} onClick={() => run(['branch', '-D', b.name], t('git.deleteConfirm', { name: b.name }))}>{t('git.delete')}</button>
            </>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== Workbench shell ====================
function Workbench({ gitPath }: { gitPath: string }) {
  const { t } = useTranslation();
  const [repo, setRepo] = useState<string>(() => localStorage.getItem(REPO_KEY) ?? '');
  const [repoInput, setRepoInput] = useState(repo);
  const [valid, setValid] = useState<boolean | null>(null);

  const openRepo = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    const r = await git(gitPath, p, ['rev-parse', '--is-inside-work-tree']);
    if (r.success && r.stdout.trim() === 'true') {
      setRepo(p); localStorage.setItem(REPO_KEY, p); setValid(true);
    } else setValid(false);
  };
  useEffect(() => { if (repo) void openRepo(repo); /* eslint-disable-next-line */ }, []);

  const tabs = useMemo(() => repo && valid ? [
    { id: 'changes', en: 'Changes', zh: '變更', render: () => <ChangesTab gitPath={gitPath} repo={repo} /> },
    { id: 'history', en: 'History', zh: '歷史', render: () => <HistoryTab gitPath={gitPath} repo={repo} /> },
    { id: 'branches', en: 'Branches', zh: '分支', render: () => <BranchesTab gitPath={gitPath} repo={repo} /> },
  ] : [], [repo, valid, gitPath]);

  return (
    <>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('git.repo')}</label>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34, flex: 1, minWidth: 240, fontFamily: 'monospace' }} value={repoInput} onChange={(e) => setRepoInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openRepo(repoInput)} placeholder="C:\\path\\to\\repo" />
        <button className="mini primary" onClick={() => openRepo(repoInput)}>{t('git.open')}</button>
      </div>
      {valid === false && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('git.notRepo')}</p>}
      {repo && valid && <ModuleTabs tabs={tabs} />}
    </>
  );
}

export function GitModule() {
  return (
    <div className="mod">
      <DependencyGate tool="git" preferId="Git.Git" query="git">
        {(path) => <Workbench gitPath={path} />}
      </DependencyGate>
    </div>
  );
}
