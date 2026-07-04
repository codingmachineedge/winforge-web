import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

// Git & GitHub — the full workbench. A faithful web port of WinForge's GitHubModule
// (2015-line C# page) + GitDeskService / GitWorkflows / GitAliasStore. It drives git
// locally through `git -C <repo>` via runCommand, and the GitHub REST API through the
// backend PowerShell (Invoke-RestMethod, no CORS) so tokens never leave the machine.
//
// Tabs: Overview (health · remotes · stashes · tags · submodules · .gitignore),
// Changes (colour diff · stage · commit · push), History (commit graph · per-commit
// files + diff), Branches (switch/create/rename/delete/merge/rebase · cherry-pick ·
// revert · PR via gh), Tools (command runner · chunked upload · operation library),
// Workflows (Up · Undo · Push&share · checkpoints · saved aliases), and GitHub
// (masked token · your repos / PRs / issues · create PR / issue).
//
// Every mutating git op is click-gated; destructive ones (reset/rebase/delete/discard/
// force-push/stash-drop/tag-delete) confirm first. Tokens are stored masked in state
// and never logged.

const REPO_KEY = 'winforge-web.git.repo';
const REPOS_KEY = 'winforge-web.git.repos';
const ALIAS_KEY = 'winforge-web.git.aliases';
const GH_TOKEN_KEY = 'winforge-web.git.ghtoken';

// -------------------------------------------------------------------------------------
// low-level git runner
// -------------------------------------------------------------------------------------
async function git(gitPath: string, repo: string, args: string[]): Promise<CommandOutput> {
  return runCommand(gitPath, ['-c', 'core.quotepath=false', '-C', repo, ...args]);
}
// git NOT bound to a repo (clone, ls-remote, --version …)
async function gitRaw(gitPath: string, args: string[]): Promise<CommandOutput> {
  return runCommand(gitPath, ['-c', 'core.quotepath=false', ...args]);
}
const errText = (r: CommandOutput) => r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;
const psq = (s: string) => s.replace(/'/g, "''");

// -------------------------------------------------------------------------------------
// porcelain v2 status parsing (ported from GitDeskService.Changes)
// -------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------
// diff parsing / rendering (colour-coded)
// -------------------------------------------------------------------------------------
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

function DiffView({ lines, maxHeight = 360 }: { lines: DiffLine[]; maxHeight?: number }) {
  const { t } = useTranslation();
  if (lines.length === 0) return <p className="count-note">{t('git.noDiff')}</p>;
  return (
    <pre className="diff-out" style={{ margin: 0, maxHeight, overflow: 'auto' }}>
      {lines.map((l, i) => (
        <div key={i} className={DIFF_CLASS[l.kind]} style={l.kind === 'hunk' ? { color: 'var(--accent, #58a6ff)', fontWeight: 600 } : l.kind === 'meta' || l.kind === 'header' ? { opacity: 0.6 } : undefined}>{l.text || ' '}</div>
      ))}
    </pre>
  );
}

// A one-line inline status / error line reused across panels.
function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <pre className={`cmd-out${msg.ok ? '' : ' error'}`} style={{ margin: '6px 0 0' }}>{msg.text}</pre>;
}

// -------------------------------------------------------------------------------------
// shared run helper hook — click-gated mutation with busy + inline result
// -------------------------------------------------------------------------------------
function useRunner(gitPath: string, repo: string, after?: () => void | Promise<void>) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(async (label: string, args: string[], opts?: { confirm?: string; okText?: string }) => {
    if (opts?.confirm && !confirm(opts.confirm)) return false;
    setBusy(label); setMsg(null);
    let ok = false;
    try {
      const r = await git(gitPath, repo, args);
      ok = r.success;
      setMsg({ ok, text: ok ? (opts?.okText ?? (r.stdout.trim() || 'OK')) : errText(r) });
      if (after) await after();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
    return ok;
  }, [gitPath, repo, after]);
  return { busy, setBusy, msg, setMsg, run };
}

// =====================================================================================
// OVERVIEW tab — health · remotes · stashes · tags · submodules · .gitignore
// =====================================================================================
interface Overview {
  root: string; branch: string; detached: boolean; shortHead: string; upstream: string;
  ahead: number | null; behind: number | null; userName: string; userEmail: string;
  lastSubject: string; lastAuthor: string; lastDate: string;
  total: number; staged: number; unstaged: number; untracked: number; conflicted: number;
}
interface Remote { name: string; url: string }
interface Stash { selector: string; message: string }
interface Tag { name: string; subject: string; date: string }
interface Submodule { path: string; status: string; sha: string }

function OverviewTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [ov, setOv] = useState<Overview | null>(null);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [subs, setSubs] = useState<Submodule[]>([]);
  const [gitignore, setGitignore] = useState('');
  const [gitignoreDirty, setGitignoreDirty] = useState(false);

  const [rName, setRName] = useState('');
  const [rUrl, setRUrl] = useState('');
  const [stashMsg, setStashMsg] = useState('');
  const [stashUntracked, setStashUntracked] = useState(false);
  const [tagName, setTagName] = useState('');
  const [tagMsg, setTagMsg] = useState('');

  const load = useCallback(async () => {
    // health
    const one = async (args: string[]) => (await git(gitPath, repo, args)).stdout.trim();
    const root = await one(['rev-parse', '--show-toplevel']);
    const headRef = await git(gitPath, repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const detached = !headRef.success;
    const branch = headRef.stdout.trim();
    const shortHead = await one(['rev-parse', '--short', 'HEAD']);
    const upstream = (await git(gitPath, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).stdout.trim();
    let ahead: number | null = null, behind: number | null = null;
    if (upstream) {
      const ab = await git(gitPath, repo, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const parts = ab.stdout.trim().split(/\s+/);
      if (ab.success && parts.length === 2) { behind = +parts[0]!; ahead = +parts[1]!; }
    }
    const userName = await one(['config', 'user.name']);
    const userEmail = await one(['config', 'user.email']);
    const last = await git(gitPath, repo, ['log', '-1', '--pretty=format:%s%x1f%an%x1f%ad', '--date=short']);
    const lf = last.stdout.split('\x1f');
    const st = parseStatus((await git(gitPath, repo, ['status', '--porcelain=v2', '--untracked-files=all'])).stdout);
    setOv({
      root: root || repo, branch, detached, shortHead, upstream,
      ahead, behind, userName, userEmail,
      lastSubject: last.success ? (lf[0] ?? '') : '', lastAuthor: lf[1] ?? '', lastDate: lf[2] ?? '',
      total: st.length,
      staged: st.filter(isStaged).length,
      unstaged: st.filter((c) => isUnstaged(c) && !c.untracked).length,
      untracked: st.filter((c) => c.untracked).length,
      conflicted: st.filter((c) => c.conflicted).length,
    });
    // remotes
    const rr = await git(gitPath, repo, ['remote', '-v']);
    const rmap = new Map<string, string>();
    for (const raw of rr.stdout.replace(/\r/g, '').split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(raw.trim());
      if (m && m[3] === 'fetch') rmap.set(m[1]!, m[2]!);
      else if (m && !rmap.has(m[1]!)) rmap.set(m[1]!, m[2]!);
    }
    setRemotes([...rmap].map(([name, url]) => ({ name, url })));
    // stashes
    const sr = await git(gitPath, repo, ['stash', 'list', '--pretty=format:%gd%x1f%s']);
    setStashes(sr.stdout.replace(/\r/g, '').split('\n').filter((l) => l.includes('\x1f')).map((l) => {
      const [selector, message] = l.split('\x1f'); return { selector: selector ?? '', message: message ?? '' };
    }));
    // tags
    const tr = await git(gitPath, repo, ['for-each-ref', '--sort=-creatordate', '--count=40', '--format=%(refname:short)%1f%(contents:subject)%1f%(creatordate:short)', 'refs/tags']);
    setTags(tr.stdout.replace(/\r/g, '').split('\n').filter((l) => l.trim()).map((l) => {
      const [name, subject, date] = l.split('\x1f'); return { name: name ?? '', subject: subject ?? '', date: date ?? '' };
    }));
    // submodules
    const smr = await git(gitPath, repo, ['submodule', 'status']);
    setSubs(smr.stdout.replace(/\r/g, '').split('\n').filter((l) => l.trim()).map((l) => {
      const status = l[0] ?? ' ';
      const rest = l.slice(1).trim();
      const parts = rest.split(/\s+/);
      return { sha: parts[0] ?? '', path: parts[1] ?? '', status: status === '-' ? 'uninit' : status === '+' ? 'ahead' : status === 'U' ? 'conflict' : 'ok' };
    }));
    // .gitignore
    const gi = await git(gitPath, repo, ['show', 'HEAD:.gitignore']);
    setGitignore(gi.success ? gi.stdout.replace(/\r/g, '') : '');
    setGitignoreDirty(false);
  }, [gitPath, repo]);
  useEffect(() => { void load(); }, [load]);

  const { busy, msg, setMsg, run } = useRunner(gitPath, repo, load);

  const addRemote = () => {
    if (!rName.trim() || !rUrl.trim()) { setMsg({ ok: false, text: t('git.remoteNeed') }); return; }
    void run('addRemote', ['remote', 'add', rName.trim(), rUrl.trim()], { okText: t('git.remoteAdded') }).then((ok) => { if (ok) { setRName(''); setRUrl(''); } });
  };
  const saveStash = () => {
    const args = ['stash', 'push'];
    if (stashUntracked) args.push('-u');
    if (stashMsg.trim()) args.push('-m', stashMsg.trim());
    void run('stashPush', args, { okText: t('git.stashSaved') }).then((ok) => { if (ok) setStashMsg(''); });
  };
  const createTag = () => {
    if (!tagName.trim()) { setMsg({ ok: false, text: t('git.tagNeed') }); return; }
    const args = tagMsg.trim() ? ['tag', '-a', tagName.trim(), '-m', tagMsg.trim()] : ['tag', tagName.trim()];
    void run('createTag', args, { okText: t('git.tagCreated') }).then((ok) => { if (ok) { setTagName(''); setTagMsg(''); } });
  };
  const saveGitignore = async () => {
    // Write .gitignore into the working tree through the backend (native only).
    if (!isTauri()) { setMsg({ ok: false, text: t('git.previewWrite') }); return; }
    const path = `${repo.replace(/[\\/]+$/, '')}\\.gitignore`;
    const script = `Set-Content -LiteralPath '${psq(path)}' -Value @'\n${gitignore.replace(/'/g, "''")}\n'@ -Encoding utf8`;
    try {
      const r = await runPowershell(script);
      setMsg({ ok: r.success, text: r.success ? t('git.gitignoreSaved') : errText(r) });
      setGitignoreDirty(false);
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
  };

  const kv = (label: string, value: string) => (
    <div className="kv-row" style={{ alignItems: 'flex-start' }}>
      <span className="count-note" style={{ minWidth: 120, margin: 0 }}>{label}</span>
      <span className="value" style={{ flex: 1, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini" disabled={!!busy} onClick={() => void load()}>⟳ {t('git.refresh')}</button>
        {ov && !ov.detached && !ov.upstream && (
          <button className="mini primary" disabled={!!busy} onClick={() => void run('publish', ['push', '-u', 'origin', ov.branch], { okText: t('git.published') })}>{t('git.publishBranch')}</button>
        )}
      </div>
      <Msg msg={msg} />

      <div className="io-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', marginTop: 10 }}>
        {/* health */}
        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.health')}</h3>
          {ov ? (
            <>
              {kv(t('git.root'), ov.root)}
              {kv(t('git.branch'), ov.detached ? t('git.detachedAt', { sha: ov.shortHead }) : ov.branch)}
              {kv(t('git.upstream'), ov.upstream || t('git.notPublished'))}
              {kv(t('git.sync'), ov.ahead === null ? t('git.noTracking') : t('git.aheadBehind', { ahead: ov.ahead, behind: ov.behind }))}
              {kv(t('git.changesLabel'), t('git.changesBreakdown', { total: ov.total, staged: ov.staged, unstaged: ov.unstaged, untracked: ov.untracked, conflicted: ov.conflicted }))}
              {kv(t('git.identity'), ov.userName || ov.userEmail ? `${ov.userName} <${ov.userEmail}>` : t('git.noIdentity'))}
              {kv(t('git.lastCommit'), ov.lastSubject ? `${ov.shortHead} · ${ov.lastSubject} · ${ov.lastAuthor} · ${ov.lastDate}` : t('git.noCommits'))}
            </>
          ) : <p className="count-note">{t('git.loading')}</p>}
        </div>

        {/* remotes */}
        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.remotes')}</h3>
          {remotes.length === 0 ? <p className="count-note">{t('git.noRemotes')}</p> : remotes.map((r) => (
            <div key={r.name} className="kv-row" style={{ alignItems: 'center' }}>
              <span style={{ fontWeight: 600, minWidth: 70 }}>{r.name}</span>
              <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{r.url}</span>
              <button className="mini" disabled={!!busy} onClick={() => void run('fetchR', ['fetch', '--prune', r.name], { okText: t('git.fetched') })}>{t('git.fetch')}</button>
              <button className="mini" disabled={!!busy} onClick={() => {
                const nu = prompt(t('git.newUrlFor', { name: r.name }), r.url);
                if (nu && nu.trim()) void run('setUrl', ['remote', 'set-url', r.name, nu.trim()], { okText: t('git.remoteUpdated') });
              }}>{t('git.setUrl')}</button>
              <button className="mini" disabled={!!busy} onClick={() => void run('rmR', ['remote', 'remove', r.name], { confirm: t('git.remoteRemoveConfirm', { name: r.name }), okText: t('git.remoteRemoved') })}>✕</button>
            </div>
          ))}
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <input className="mod-search" style={{ maxWidth: 110 }} value={rName} onChange={(e) => setRName(e.target.value)} placeholder={t('git.remoteName')} />
            <input className="mod-search" style={{ flex: 1, minWidth: 140 }} value={rUrl} onChange={(e) => setRUrl(e.target.value)} placeholder={t('git.remoteUrl')} />
            <button className="mini" disabled={!!busy} onClick={addRemote}>{t('git.addRemote')}</button>
          </div>
        </div>

        {/* stashes */}
        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.stashes')}</h3>
          {stashes.length === 0 ? <p className="count-note">{t('git.noStashes')}</p> : stashes.map((s) => (
            <div key={s.selector} className="kv-row" style={{ alignItems: 'center' }}>
              <code style={{ minWidth: 70 }}>{s.selector}</code>
              <span className="value" style={{ flex: 1, fontSize: 12.5 }}>{s.message}</span>
              <button className="mini" disabled={!!busy} onClick={() => void run('stashApply', ['stash', 'apply', s.selector], { okText: t('git.stashApplied') })}>{t('git.apply')}</button>
              <button className="mini" disabled={!!busy} onClick={() => void run('stashPop', ['stash', 'pop', s.selector], { okText: t('git.stashPopped') })}>{t('git.pop')}</button>
              <button className="mini" disabled={!!busy} onClick={() => void run('stashDrop', ['stash', 'drop', s.selector], { confirm: t('git.stashDropConfirm', { selector: s.selector }), okText: t('git.stashDropped') })}>{t('git.drop')}</button>
            </div>
          ))}
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <input className="mod-search" style={{ flex: 1, minWidth: 140 }} value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} placeholder={t('git.stashMessage')} />
            <label className="count-note" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={stashUntracked} onChange={(e) => setStashUntracked(e.target.checked)} />{t('git.includeUntracked')}
            </label>
            <button className="mini" disabled={!!busy} onClick={saveStash}>{t('git.stashSave')}</button>
          </div>
        </div>

        {/* tags */}
        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.tags')}</h3>
          {tags.length === 0 ? <p className="count-note">{t('git.noTags')}</p> : tags.map((tg) => (
            <div key={tg.name} className="kv-row" style={{ alignItems: 'center' }}>
              <span style={{ fontWeight: 600, minWidth: 90, fontFamily: 'monospace' }}>{tg.name}</span>
              <span className="value" style={{ flex: 1, fontSize: 12 }}>{[tg.date, tg.subject].filter(Boolean).join(' · ')}</span>
              <button className="mini" disabled={!!busy} onClick={() => void run('pushTag', ['push', 'origin', `refs/tags/${tg.name}`], { okText: t('git.tagPushed') })}>{t('git.push')}</button>
              <button className="mini" disabled={!!busy} onClick={() => void run('delTag', ['tag', '-d', tg.name], { confirm: t('git.tagDeleteConfirm', { name: tg.name }), okText: t('git.tagDeleted') })}>✕</button>
            </div>
          ))}
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <input className="mod-search" style={{ maxWidth: 130 }} value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder={t('git.tagName')} />
            <input className="mod-search" style={{ flex: 1, minWidth: 120 }} value={tagMsg} onChange={(e) => setTagMsg(e.target.value)} placeholder={t('git.tagAnnotation')} />
            <button className="mini" disabled={!!busy} onClick={createTag}>{t('git.createTag')}</button>
            <button className="mini" disabled={!!busy} onClick={() => void run('pushTags', ['push', '--tags'], { okText: t('git.tagsPushed') })}>{t('git.pushTags')}</button>
          </div>
        </div>

        {/* submodules — only shown when the repo has them */}
        {subs.length > 0 && (
          <div className="panel" style={{ margin: 0 }}>
            <h3 className="group-title">{t('git.submodules')}</h3>
            {subs.map((s) => (
              <div key={s.path} className="kv-row" style={{ alignItems: 'center' }}>
                <span className={`badge ${s.status === 'conflict' ? 'neg' : s.status === 'ok' ? 'pos' : ''}`} style={{ minWidth: 54, textAlign: 'center' }}>{t(`git.sub_${s.status}`)}</span>
                <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>{s.path}</span>
                <code style={{ fontSize: 11 }}>{s.sha.slice(0, 8)}</code>
                <button className="mini" disabled={!!busy} onClick={() => void run('subUpd', ['submodule', 'update', '--init', '--recursive', '--', s.path], { okText: t('git.subUpdated') })}>{t('git.update')}</button>
              </div>
            ))}
            <div className="mod-toolbar" style={{ marginTop: 8 }}>
              <button className="mini" disabled={!!busy} onClick={() => void run('subUpdAll', ['submodule', 'update', '--init', '--recursive'], { okText: t('git.subUpdated') })}>{t('git.subUpdateAll')}</button>
            </div>
          </div>
        )}

        {/* .gitignore editor */}
        <div className="panel" style={{ margin: 0, gridColumn: '1 / -1' }}>
          <h3 className="group-title">{t('git.gitignore')}</h3>
          <p className="count-note" style={{ marginTop: 0 }}>{t('git.gitignoreHint')}</p>
          <textarea className="hosts-edit" spellCheck={false} style={{ minHeight: 140, fontFamily: 'Consolas, monospace', fontSize: 12.5 }} value={gitignore} onChange={(e) => { setGitignore(e.target.value); setGitignoreDirty(true); }} placeholder="node_modules/&#10;*.log&#10;.env" />
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" disabled={!!busy || !gitignoreDirty} onClick={() => void saveGitignore()}>{t('git.saveGitignore')}</button>
            <span className="count-note" style={{ margin: 0 }}>{isTauri() ? '' : t('git.previewWriteNote')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// CHANGES tab (kept + hardened) — stage/unstage/discard, colour diff, commit, sync
// =====================================================================================
function ChangesTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<Change | null>(null);
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [summary, setSummary] = useState('');
  const [desc, setDesc] = useState('');
  const [amend, setAmend] = useState(false);
  const [ab, setAb] = useState<{ ahead: number; behind: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setBusy('load');
    try {
      const st = await git(gitPath, repo, ['status', '--porcelain=v2', '--untracked-files=all']);
      setChanges(parseStatus(st.stdout));
      const abr = await git(gitPath, repo, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const parts = abr.stdout.trim().split(/\s+/);
      if (abr.success && parts.length === 2) setAb({ behind: +parts[0]!, ahead: +parts[1]! });
      else setAb(null);
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
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

  const run = async (label: string, args: string[], confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(label); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      if (!r.success) setMsg({ ok: false, text: errText(r) });
      await refresh();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  const commit = async (push: boolean) => {
    if (!summary.trim() && !amend) { setMsg({ ok: false, text: t('git.needSummary') }); return; }
    const args = ['commit'];
    if (amend) args.push('--amend');
    if (summary.trim()) { args.push('-m', summary.trim()); if (desc.trim()) args.push('-m', desc.trim()); }
    else if (amend) args.push('--no-edit');
    setBusy('commit'); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      if (!r.success) { setMsg({ ok: false, text: errText(r) }); return; }
      setSummary(''); setDesc(''); setAmend(false); setSelected(null); setDiff([]);
      if (push) {
        let pr = await git(gitPath, repo, ['push']);
        if (!pr.success) pr = await git(gitPath, repo, ['push', '-u', 'origin', 'HEAD']);
        setMsg({ ok: pr.success, text: pr.success ? t('git.pushedOk') : errText(pr) });
      } else setMsg({ ok: true, text: t('git.committedOk') });
      await refresh();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  const staged = changes.filter(isStaged);
  const stagedCount = staged.length;

  return (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!!busy} onClick={() => void refresh()}>⟳ {t('git.refresh')}</button>
        <button className="mini" disabled={!!busy || changes.length === 0} onClick={() => void run('stageAll', ['add', '-A'])}>{t('git.stageAll')}</button>
        <button className="mini" disabled={!!busy || stagedCount === 0} onClick={() => void run('unstageAll', ['reset'])}>{t('git.unstageAll')}</button>
        <span style={{ flex: 1 }} />
        <button className="mini" disabled={!!busy} onClick={() => void run('fetch', ['fetch', '--all', '--prune'])}>{t('git.fetch')}</button>
        <button className="mini" disabled={!!busy} onClick={() => void run('pull', ['pull', '--ff-only'])}>{t('git.pull')}{ab && ab.behind > 0 ? ` ↓${ab.behind}` : ''}</button>
        <button className="mini primary" disabled={!!busy} onClick={() => void run('push', ['push'])}>{t('git.push')}{ab && ab.ahead > 0 ? ` ↑${ab.ahead}` : ''}</button>
      </div>
      <Msg msg={msg} />
      <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.4fr', marginTop: 10 }}>
        <div className="panel" style={{ margin: 0, maxHeight: 420, overflow: 'auto' }}>
          <p className="count-note" style={{ marginTop: 0 }}>{t('git.changesCount', { n: changes.length, staged: stagedCount })}</p>
          {changes.length === 0 ? (
            <p className="count-note">{t('git.clean')}</p>
          ) : changes.map((c) => (
            <div key={c.path} className="kv-row" style={{ cursor: 'pointer', alignItems: 'center', background: selected?.path === c.path ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => void showDiff(c)}>
              <span className={`badge ${badge(c) === 'D' ? 'neg' : isStaged(c) ? 'pos' : ''}`} style={{ fontFamily: 'monospace', width: 18, textAlign: 'center' }}>{badge(c)}</span>
              <span className="value" style={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1, wordBreak: 'break-all' }} title={c.path}>{c.path}</span>
              {isStaged(c)
                ? <button className="mini" title={t('git.unstage')} onClick={(e) => { e.stopPropagation(); void run('unstage', ['restore', '--staged', '--', c.path]); }}>−</button>
                : <button className="mini" title={t('git.stage')} onClick={(e) => { e.stopPropagation(); void run('stage', ['add', '--', c.path]); }}>+</button>}
              <button className="mini" title={t('git.discard')} onClick={(e) => { e.stopPropagation(); void run('discard', c.untracked ? ['clean', '-f', '--', c.path] : ['restore', '--', c.path], t('git.discardConfirm', { path: c.path })); }}>✕</button>
            </div>
          ))}
        </div>
        <div className="panel" style={{ margin: 0 }}>
          {selected ? <><p className="count-note" style={{ marginTop: 0, fontFamily: 'monospace' }}>{selected.path}</p><DiffView lines={diff} /></> : <p className="count-note">{t('git.selectFile')}</p>}
        </div>
      </div>
      <div className="panel">
        <input className="hosts-edit" style={{ minHeight: 0, height: 36 }} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t('git.summary')} />
        <textarea className="hosts-edit" style={{ marginTop: 6, minHeight: 60 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('git.description')} />
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <label className="count-note" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />{t('git.amend')}
          </label>
          <span style={{ flex: 1 }} />
          <button className="mini primary" disabled={!!busy || (stagedCount === 0 && !amend) || (!summary.trim() && !amend)} onClick={() => void commit(false)}>{busy === 'commit' ? t('git.committing') : t('git.commit', { n: stagedCount })}</button>
          <button className="mini" disabled={!!busy || (stagedCount === 0 && !amend) || (!summary.trim() && !amend)} onClick={() => void commit(true)}>{t('git.commitPush')}</button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// HISTORY tab (kept + revert/cherry-pick/checkout on a commit)
// =====================================================================================
interface Commit { graph: string; hash: string; short: string; author: string; date: string; subject: string }
function HistoryTab({ gitPath, repo }: { gitPath: string; repo: string }) {
  const { t } = useTranslation();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [sel, setSel] = useState<Commit | null>(null);
  const [files, setFiles] = useState<{ status: string; path: string }[]>([]);
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const r = await git(gitPath, repo, ['log', '--graph', '--date=short', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--max-count=300']);
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

  const showFile = async (c: Commit, path: string) => {
    const dr = await git(gitPath, repo, ['show', '--no-color', `${c.hash}`, '--', path]);
    setDiff(parseDiff(dr.stdout));
  };

  const op = async (label: string, args: string[], confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(label); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      setMsg({ ok: r.success, text: r.success ? (r.stdout.trim() || 'OK') : errText(r) });
      await load();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  return (
    <div>
      <Msg msg={msg} />
      {sel && (
        <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="count-note" style={{ margin: 0 }}>{t('git.commitActions', { short: sel.short })}</span>
          <button className="mini" disabled={!!busy} onClick={() => void op('checkout', ['checkout', sel.hash], t('git.checkoutCommitConfirm', { short: sel.short }))}>{t('git.checkout')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void op('cherry', ['cherry-pick', sel.hash], t('git.cherryPickConfirm', { short: sel.short }))}>{t('git.cherryPick')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void op('revert', ['revert', '--no-edit', sel.hash], t('git.revertConfirm', { short: sel.short }))}>{t('git.revert')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void op('softReset', ['reset', '--soft', sel.hash], t('git.resetSoftConfirm', { short: sel.short }))}>{t('git.resetSoft')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void op('hardReset', ['reset', '--hard', sel.hash], t('git.resetHardConfirm', { short: sel.short }))}>{t('git.resetHard')}</button>
          <button className="mini" disabled={!!busy} onClick={() => { const n = prompt(t('git.branchFromPrompt')); if (n && n.trim()) void op('branchFrom', ['switch', '-c', n.trim(), sel.hash]); }}>{t('git.branchHere')}</button>
        </div>
      )}
      <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.4fr', marginTop: 10 }}>
        <div className="panel" style={{ margin: 0, maxHeight: 480, overflow: 'auto' }}>
          {commits.length === 0 ? <p className="count-note">{t('git.noHistory')}</p> : commits.map((c) => (
            <div key={c.hash} className="kv-row" style={{ cursor: 'pointer', background: sel?.hash === c.hash ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => void select(c)}>
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
              <p className="count-note" style={{ marginTop: 0 }}><code>{sel.short}</code> · {sel.author} · {sel.date}<br />{sel.subject}</p>
              {files.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {files.map((f, i) => (
                    <button key={i} className="mini" style={{ margin: '2px 2px 0 0', fontFamily: 'monospace', fontSize: 11 }} onClick={() => void showFile(sel, f.path)}>{f.status} {f.path}</button>
                  ))}
                </div>
              )}
              <DiffView lines={diff} maxHeight={420} />
            </>
          ) : <p className="count-note">{t('git.selectCommit')}</p>}
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// BRANCHES tab — switch/create/rename/delete/merge/rebase + remote checkout + PR (gh)
// =====================================================================================
interface Branch { name: string; current: boolean; upstream: string; remote: boolean }
function BranchesTab({ gitPath, repo, ghPath }: { gitPath: string; repo: string; ghPath: string | null }) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [newName, setNewName] = useState('');
  const [graph, setGraph] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  // PR form
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prFill, setPrFill] = useState(true);

  const load = useCallback(async () => {
    const r = await git(gitPath, repo, ['for-each-ref', '--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)', 'refs/heads', 'refs/remotes']);
    const list: Branch[] = [];
    for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
      if (!raw.trim()) continue;
      const [head, name, upstream] = raw.split('\x1f');
      if (!name || name.endsWith('/HEAD')) continue;
      list.push({ name, current: head === '*', upstream: upstream ?? '', remote: false });
    }
    // Derive the remote flag from `branch -r` so remote-tracking refs are classified reliably.
    const rr = await git(gitPath, repo, ['branch', '-r', '--format=%(refname:short)']);
    const remoteSet = new Set(rr.stdout.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD')));
    for (const b of list) b.remote = remoteSet.has(b.name);
    setBranches(list);
    const g = await git(gitPath, repo, ['log', '--graph', '--oneline', '--decorate', '--all', '--max-count=200']);
    setGraph(g.stdout.replace(/\r/g, '') || t('git.noHistory'));
  }, [gitPath, repo, t]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, args: string[], confirmMsg?: string, okText?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(label); setMsg(null);
    try {
      const r = await git(gitPath, repo, args);
      setMsg({ ok: r.success, text: r.success ? (okText ?? r.stdout.trim() ?? 'OK') : errText(r) });
      await load();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  const createPr = async () => {
    if (!ghPath) { setMsg({ ok: false, text: t('git.ghMissing') }); return; }
    setBusy('pr'); setMsg(null);
    const args = ['pr', 'create'];
    if (prFill) args.push('--fill');
    else { args.push('--title', prTitle.trim() || 'PR'); args.push('--body', prBody); }
    if (prDraft) args.push('--draft');
    try {
      // gh resolves the repo from its working directory, and runCommand has no cwd control,
      // so run gh inside the repo folder via PowerShell Push-Location.
      const escArgs = args.map((a) => `'${psq(a)}'`).join(', ');
      const script = `Push-Location -LiteralPath '${psq(repo)}'; try { & '${psq(ghPath)}' @(${escArgs}) 2>&1 | Out-String } finally { Pop-Location }`;
      const r = await runPowershell(script);
      setMsg({ ok: r.success, text: r.success ? (r.stdout.trim() || t('git.prCreated')) : errText(r) });
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  const ghInRepo = async (label: string, args: string[]) => {
    if (!ghPath) { setMsg({ ok: false, text: t('git.ghMissing') }); return; }
    setBusy(label); setMsg(null);
    try {
      const escArgs = args.map((a) => `'${psq(a)}'`).join(', ');
      const script = `Push-Location -LiteralPath '${psq(repo)}'; try { & '${psq(ghPath)}' @(${escArgs}) 2>&1 | Out-String } finally { Pop-Location }`;
      const r = await runPowershell(script);
      setMsg({ ok: r.success, text: r.success ? (r.stdout.trim() || 'OK') : errText(r) });
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(''); }
  };

  const local = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);

  return (
    <div>
      <div className="mod-toolbar">
        <input className="mod-search" style={{ maxWidth: 240 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('git.newBranch')} />
        <button className="mini primary" disabled={!!busy || !newName.trim()} onClick={() => { void run('create', ['switch', '-c', newName.trim()], undefined, t('git.branchCreated')); setNewName(''); }}>{t('git.createSwitch')}</button>
      </div>
      <Msg msg={msg} />

      <div className="io-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', marginTop: 10 }}>
        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.localBranches')}</h3>
          {local.map((b) => (
            <div key={b.name} className="kv-row" style={{ alignItems: 'center' }}>
              <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontWeight: b.current ? 700 : 400 }}>{b.current ? '● ' : ''}{b.name}{b.upstream ? <span className="count-note" style={{ marginLeft: 6 }}>→ {b.upstream}</span> : null}</span>
              {!b.current && <>
                <button className="mini" disabled={!!busy} onClick={() => void run('switch', ['switch', b.name])}>{t('git.switch')}</button>
                <button className="mini" disabled={!!busy} onClick={() => void run('merge', ['merge', b.name], t('git.mergeConfirm', { name: b.name }))}>{t('git.merge')}</button>
                <button className="mini" disabled={!!busy} onClick={() => void run('rebase', ['rebase', b.name], t('git.rebaseConfirm', { name: b.name }))}>{t('git.rebase')}</button>
                <button className="mini" disabled={!!busy} onClick={() => { const n = prompt(t('git.renamePrompt', { name: b.name }), b.name); if (n && n.trim()) void run('rename', ['branch', '-m', b.name, n.trim()]); }}>{t('git.rename')}</button>
                <button className="mini" disabled={!!busy} onClick={() => void run('delete', ['branch', '-D', b.name], t('git.deleteConfirm', { name: b.name }))}>{t('git.delete')}</button>
              </>}
            </div>
          ))}
        </div>

        <div className="panel" style={{ margin: 0 }}>
          <h3 className="group-title">{t('git.remoteBranches')}</h3>
          {remotes.length === 0 ? <p className="count-note">{t('git.noRemoteBranches')}</p> : remotes.map((b) => (
            <div key={b.name} className="kv-row" style={{ alignItems: 'center' }}>
              <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontSize: 12.5 }}>{b.name}</span>
              <button className="mini" disabled={!!busy} onClick={() => { const localName = b.name.split('/').slice(1).join('/'); void run('coRemote', ['switch', '-c', localName, '--track', b.name]); }}>{t('git.checkoutTrack')}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Pull request via gh */}
      <div className="panel">
        <h3 className="group-title">{t('git.pullRequest')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{ghPath ? t('git.prBlurb') : t('git.ghMissing')}</p>
        <input className="hosts-edit" style={{ minHeight: 0, height: 34 }} value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder={t('git.prTitle')} disabled={prFill} />
        <textarea className="hosts-edit" style={{ marginTop: 6, minHeight: 54 }} value={prBody} onChange={(e) => setPrBody(e.target.value)} placeholder={t('git.prBody')} disabled={prFill} />
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <label className="count-note" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={prFill} onChange={(e) => setPrFill(e.target.checked)} />{t('git.prAutofill')}</label>
          <label className="count-note" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />{t('git.prDraft')}</label>
          <span style={{ flex: 1 }} />
          <button className="mini primary" disabled={!!busy || !ghPath} onClick={() => void createPr()}>{busy === 'pr' ? t('git.creating') : t('git.createPr')}</button>
          <button className="mini" disabled={!!busy || !ghPath} onClick={() => void ghInRepo('viewPr', ['pr', 'view', '--web'])}>{t('git.viewPr')}</button>
          <button className="mini" disabled={!!busy || !ghPath} onClick={() => void ghInRepo('viewRepo', ['repo', 'view', '--web'])}>{t('git.openGithub')}</button>
        </div>
      </div>

      {/* full commit graph */}
      <div className="panel">
        <h3 className="group-title">{t('git.branchGraph')}</h3>
        <pre className="diff-out" style={{ margin: 0, maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{graph}</pre>
      </div>
    </div>
  );
}

// =====================================================================================
// TOOLS tab — command runner · chunked upload · curated operation library
// =====================================================================================
interface Op { id: string; en: string; zh: string; scope: 'git' | 'gh'; args: string[]; destructive?: boolean }
const OPS: Op[] = [
  { id: 'status', en: 'Status (short)', zh: '狀態（簡短）', scope: 'git', args: ['status', '--short', '--branch'] },
  { id: 'log', en: 'Log (oneline, 30)', zh: '日誌（單行 30）', scope: 'git', args: ['log', '--oneline', '-n', '30'] },
  { id: 'remotesv', en: 'List remotes', zh: '列出 remotes', scope: 'git', args: ['remote', '-v'] },
  { id: 'branchesall', en: 'All branches', zh: '所有分支', scope: 'git', args: ['branch', '-a'] },
  { id: 'tagsl', en: 'List tags', zh: '列出 tags', scope: 'git', args: ['tag', '--list'] },
  { id: 'stashl', en: 'List stashes', zh: '列出 stashes', scope: 'git', args: ['stash', 'list'] },
  { id: 'config', en: 'List config', zh: '列出設定', scope: 'git', args: ['config', '--list'] },
  { id: 'gc', en: 'Garbage collect', zh: '垃圾回收', scope: 'git', args: ['gc', '--auto'] },
  { id: 'prune', en: 'Prune remote-tracking', zh: '清理遠端追蹤', scope: 'git', args: ['remote', 'prune', 'origin'] },
  { id: 'fsck', en: 'Verify object DB (fsck)', zh: '驗證物件庫（fsck）', scope: 'git', args: ['fsck'] },
  { id: 'countobj', en: 'Count objects', zh: '統計物件', scope: 'git', args: ['count-objects', '-vH'] },
  { id: 'cleandry', en: 'Clean (dry run)', zh: '清理（試運行）', scope: 'git', args: ['clean', '-nd'] },
  { id: 'unpushed', en: 'Unpushed commits', zh: '未推送提交', scope: 'git', args: ['log', '--branches', '--not', '--remotes', '--oneline'] },
  { id: 'whoami', en: 'Identity', zh: '身份', scope: 'git', args: ['config', '--get-regexp', 'user'] },
  { id: 'ghauth', en: 'gh auth status', zh: 'gh 認證狀態', scope: 'gh', args: ['auth', 'status'] },
  { id: 'ghprlist', en: 'gh pr list', zh: 'gh PR 清單', scope: 'gh', args: ['pr', 'list'] },
  { id: 'ghislist', en: 'gh issue list', zh: 'gh Issue 清單', scope: 'gh', args: ['issue', 'list'] },
  { id: 'ghrepo', en: 'gh repo view', zh: 'gh repo 檢視', scope: 'gh', args: ['repo', 'view'] },
];

function ToolsTab({ gitPath, repo, ghPath }: { gitPath: string; repo: string; ghPath: string | null }) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<'git' | 'gh'>('git');
  const [args, setArgs] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'all' | 'git' | 'gh'>('all');
  const consoleRef = useRef<HTMLPreElement>(null);

  // chunked upload
  const [chunkMb, setChunkMb] = useState(25);
  const [chunkMsg, setChunkMsg] = useState('');
  const [chunkBusy, setChunkBusy] = useState(false);

  const append = (s: string) => setOut((o) => (o + s).slice(-20000));
  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [out]);

  const runInRepo = async (program: string, argv: string[]): Promise<CommandOutput> => {
    // git: bind to repo with -C. gh: run in the repo dir via PowerShell Push-Location.
    if (program === 'git') return git(gitPath, repo, argv);
    if (!ghPath) return { stdout: '', stderr: 'gh not found', code: 1, success: false };
    const escArgs = argv.map((a) => `'${psq(a)}'`).join(', ');
    const script = `Push-Location -LiteralPath '${psq(repo)}'; try { & '${psq(ghPath)}' @(${escArgs}) 2>&1 | Out-String } finally { Pop-Location }`;
    return runPowershell(script);
  };

  const runFree = async () => {
    const a = args.trim();
    if (!a) return;
    if (tool === 'gh' && !ghPath) { append('gh not found\n'); return; }
    setBusy(true);
    append(`$ ${tool} ${a}\n`);
    try {
      const argv = a.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [];
      const r = await runInRepo(tool, argv);
      append((r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`) + '\n');
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(false); }
  };

  const runOp = async (op: Op) => {
    if (op.destructive && !confirm(t('git.opConfirm'))) return;
    if (op.scope === 'gh' && !ghPath) { append('gh not found\n'); return; }
    append(`$ ${op.scope} ${op.args.join(' ')}\n`);
    try {
      const r = await runInRepo(op.scope, op.args);
      append((r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`) + '\n');
    } catch (e) { append(String(e) + '\n'); }
  };

  // Chunked upload: split unpushed/uncommitted work into commits ≤ N MB, then push one at a time.
  const chunkUpload = async () => {
    setChunkBusy(true);
    append(`$ chunked upload (${chunkMb} MB per commit)\n`);
    const maxBytes = Math.max(1, chunkMb) * 1024 * 1024;
    const prefix = chunkMsg.trim() || 'WinForge chunked upload';
    try {
      let batch = 1;
      // Loop: gather untracked+modified paths, add up to maxBytes, commit, repeat until none left.
      for (let guard = 0; guard < 500; guard++) {
        const st = parseStatus((await git(gitPath, repo, ['status', '--porcelain=v2', '--untracked-files=all'])).stdout);
        const pending = st.filter((c) => isUnstaged(c) || (!isStaged(c) && c.untracked));
        if (pending.length === 0) break;
        let acc = 0;
        const take: string[] = [];
        for (const c of pending) {
          // best-effort size lookup
          let size = 0;
          if (isTauri()) {
            try {
              const p = `${repo.replace(/[\\/]+$/, '')}\\${c.path.replace(/\//g, '\\')}`;
              const r = await runPowershell(`(Get-Item -LiteralPath '${psq(p)}' -ErrorAction SilentlyContinue).Length`);
              size = parseInt(r.stdout.trim(), 10) || 0;
            } catch { size = 0; }
          }
          if (take.length > 0 && acc + size > maxBytes) break;
          take.push(c.path); acc += size;
        }
        if (take.length === 0) { take.push(pending[0]!.path); }
        for (const p of take) await git(gitPath, repo, ['add', '--', p]);
        const cm = await git(gitPath, repo, ['commit', '-m', `${prefix} (${batch})`]);
        append(`  commit ${batch}: ${take.length} file(s), ~${(acc / 1048576).toFixed(1)} MB — ${cm.success ? 'ok' : errText(cm)}\n`);
        const pr = await git(gitPath, repo, ['push']);
        const pr2 = pr.success ? pr : await git(gitPath, repo, ['push', '-u', 'origin', 'HEAD']);
        append(`  push ${batch}: ${pr2.success ? 'ok' : errText(pr2)}\n`);
        if (!pr2.success) break;
        batch++;
      }
      append('chunked upload done\n');
    } catch (e) { append(String(e) + '\n'); }
    finally { setChunkBusy(false); }
  };

  const shown = OPS.filter((o) => (scope === 'all' || o.scope === scope) && (!filter.trim() || (o.en + o.zh + o.args.join(' ')).toLowerCase().includes(filter.trim().toLowerCase())));

  return (
    <div>
      {/* command runner */}
      <div className="panel">
        <h3 className="group-title">{t('git.commandRunner')}</h3>
        <div className="mod-toolbar">
          <select className="mod-select" value={tool} onChange={(e) => setTool(e.target.value as 'git' | 'gh')}>
            <option value="git">git</option>
            <option value="gh">gh</option>
          </select>
          <input className="mod-search" style={{ flex: 1, minWidth: 200, fontFamily: 'monospace' }} value={args} onChange={(e) => setArgs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void runFree()} placeholder={t('git.runnerPlaceholder')} />
          <button className="mini primary" disabled={busy} onClick={() => void runFree()}>{busy ? t('git.running') : t('git.run')}</button>
        </div>
      </div>

      {/* chunked upload */}
      <div className="panel">
        <h3 className="group-title">{t('git.chunkTitle')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{t('git.chunkBlurb')}</p>
        <div className="mod-toolbar">
          <label className="count-note" style={{ margin: 0 }}>{t('git.chunkSize')}</label>
          <input type="number" className="mod-search" style={{ maxWidth: 90 }} min={1} max={9000} value={chunkMb} onChange={(e) => setChunkMb(Math.max(1, +e.target.value || 1))} />
          <input className="mod-search" style={{ flex: 1, minWidth: 160 }} value={chunkMsg} onChange={(e) => setChunkMsg(e.target.value)} placeholder={t('git.chunkMsgPlaceholder')} />
          <button className="mini primary" disabled={chunkBusy} onClick={() => void chunkUpload()}>{chunkBusy ? t('git.uploading') : t('git.chunkPush')}</button>
        </div>
      </div>

      {/* operation library */}
      <div className="panel">
        <div className="mod-toolbar">
          <h3 className="group-title" style={{ margin: 0, flex: 1 }}>{t('git.opLibrary', { n: OPS.length })}</h3>
          <select className="mod-select" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'git' | 'gh')}>
            <option value="all">{t('git.scopeAll')}</option>
            <option value="git">git</option>
            <option value="gh">gh</option>
          </select>
          <input className="mod-search" style={{ maxWidth: 200 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('git.filterOps')} />
        </div>
        <div className="io-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 6, marginTop: 8 }}>
          {shown.map((op) => (
            <button key={op.id} className="mini" style={{ justifyContent: 'flex-start', textAlign: 'left' }} disabled={op.scope === 'gh' && !ghPath} onClick={() => void runOp(op)} title={`${op.scope} ${op.args.join(' ')}`}>
              <span style={{ fontWeight: 600 }}>{t(`git.op_${op.id}`)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* console */}
      {out && (
        <div className="panel">
          <div className="mod-toolbar" style={{ marginBottom: 6 }}>
            <h3 className="group-title" style={{ margin: 0, flex: 1 }}>{t('git.output')}</h3>
            <button className="mini" onClick={() => setOut('')}>{t('git.clear')}</button>
          </div>
          <pre ref={consoleRef} className="cmd-out" style={{ margin: 0, maxHeight: 260, overflow: 'auto' }}>{out}</pre>
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// WORKFLOWS tab — Up · Undo · Push&share · checkpoints · saved aliases (Gitty)
// =====================================================================================
interface Alias { name: string; steps: string[] }
function loadAliases(repo: string): Alias[] {
  try {
    const all = JSON.parse(localStorage.getItem(ALIAS_KEY) ?? '{}') as Record<string, Alias[]>;
    return all[repo] ?? [];
  } catch { return []; }
}
function saveAliases(repo: string, list: Alias[]) {
  let all: Record<string, Alias[]> = {};
  try { all = JSON.parse(localStorage.getItem(ALIAS_KEY) ?? '{}'); } catch { /* reset */ }
  all[repo] = list;
  localStorage.setItem(ALIAS_KEY, JSON.stringify(all));
}
function parseSteps(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
}
// One alias step → argv. A bare line is treated as git; "gh …" runs gh.
function stepToArgv(step: string): { tool: 'git' | 'gh'; argv: string[] } {
  let s = step.trim();
  let tool: 'git' | 'gh' = 'git';
  if (/^gh\s+/i.test(s)) { tool = 'gh'; s = s.replace(/^gh\s+/i, ''); }
  else if (/^git\s+/i.test(s)) { s = s.replace(/^git\s+/i, ''); }
  const argv = s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? [];
  return { tool, argv };
}

function WorkflowsTab({ gitPath, repo, ghPath }: { gitPath: string; repo: string; ghPath: string | null }) {
  const { t } = useTranslation();
  const [upMsg, setUpMsg] = useState('');
  const [checkpoint, setCheckpoint] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState('');
  const [aliases, setAliases] = useState<Alias[]>(() => loadAliases(repo));
  const [aliasName, setAliasName] = useState('');
  const [aliasSteps, setAliasSteps] = useState('');
  const consoleRef = useRef<HTMLPreElement>(null);

  useEffect(() => { setAliases(loadAliases(repo)); }, [repo]);
  const append = (s: string) => setOut((o) => (o + s).slice(-20000));
  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [out]);

  const ghRun = async (argv: string[]): Promise<CommandOutput> => {
    if (!ghPath) return { stdout: '', stderr: 'gh not found', code: 1, success: false };
    const escArgs = argv.map((a) => `'${psq(a)}'`).join(', ');
    const script = `Push-Location -LiteralPath '${psq(repo)}'; try { & '${psq(ghPath)}' @(${escArgs}) 2>&1 | Out-String } finally { Pop-Location }`;
    return runPowershell(script);
  };

  const up = async () => {
    setBusy('up'); append(`$ up\n`);
    try {
      const add = await git(gitPath, repo, ['add', '-A']); append(`  add -A: ${add.success ? 'ok' : errText(add)}\n`);
      const cm = await git(gitPath, repo, ['commit', '-m', upMsg.trim() || 'WIP']);
      append(`  commit: ${cm.success ? 'ok' : errText(cm)}\n`);
      let pr = await git(gitPath, repo, ['push']);
      if (!pr.success) pr = await git(gitPath, repo, ['push', '-u', 'origin', 'HEAD']);
      append(`  push: ${pr.success ? 'ok' : errText(pr)}\n`);
      setUpMsg('');
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const undo = async () => {
    if (!confirm(t('git.undoConfirm'))) return;
    setBusy('undo'); append(`$ undo (reset --soft HEAD~1)\n`);
    try { const r = await git(gitPath, repo, ['reset', '--soft', 'HEAD~1']); append(`  ${r.success ? 'ok' : errText(r)}\n`); }
    catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const share = async () => {
    setBusy('share'); append(`$ push & share\n`);
    try {
      let pr = await git(gitPath, repo, ['push']);
      if (!pr.success) pr = await git(gitPath, repo, ['push', '-u', 'origin', 'HEAD']);
      append(`  push: ${pr.success ? 'ok' : errText(pr)}\n`);
      // derive a browsable URL from origin
      const rem = (await git(gitPath, repo, ['remote', 'get-url', 'origin'])).stdout.trim();
      const url = rem.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
      if (url.startsWith('http')) { try { await navigator.clipboard.writeText(url); } catch { /* ignore */ } append(`  link copied: ${url}\n`); }
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const prLink = async () => {
    setBusy('prlink');
    try {
      const r = await ghRun(['pr', 'view', '--json', 'url', '-q', '.url']);
      const url = r.stdout.trim();
      if (r.success && url) { try { await navigator.clipboard.writeText(url); } catch { /* ignore */ } append(`  PR link copied: ${url}\n`); }
      else append(`  ${errText(r)}\n`);
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const doCheckpoint = async () => {
    if (!checkpoint.trim()) { append(t('git.checkpointNeed') + '\n'); return; }
    setBusy('cp'); append(`$ checkpoint ${checkpoint}\n`);
    try {
      const tg = await git(gitPath, repo, ['tag', checkpoint.trim()]);
      append(`  tag: ${tg.success ? 'ok' : errText(tg)}\n`);
      const pu = await git(gitPath, repo, ['push', 'origin', `refs/tags/${checkpoint.trim()}`]);
      append(`  push tag: ${pu.success ? 'ok' : errText(pu)}\n`);
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };
  const restore = async () => {
    if (!checkpoint.trim()) { append(t('git.checkpointNeed') + '\n'); return; }
    if (!confirm(t('git.restoreConfirm', { name: checkpoint.trim() }))) return;
    setBusy('restore'); append(`$ restore ${checkpoint}\n`);
    try { const r = await git(gitPath, repo, ['checkout', checkpoint.trim()]); append(`  ${r.success ? 'ok' : errText(r)}\n`); }
    catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const runAlias = async (a: Alias) => {
    setBusy('alias:' + a.name); append(`$ alias ${a.name}\n`);
    try {
      for (const step of a.steps) {
        const { tool, argv } = stepToArgv(step);
        append(`  ${tool} ${argv.join(' ')}\n`);
        const r = tool === 'git' ? await git(gitPath, repo, argv) : await ghRun(argv);
        append(`    ${r.success ? (r.stdout.trim() || 'ok') : errText(r)}\n`);
        if (!r.success) { append('  stopped on failure\n'); break; }
      }
    } catch (e) { append(String(e) + '\n'); }
    finally { setBusy(''); }
  };

  const saveAlias = () => {
    const name = aliasName.trim();
    const steps = parseSteps(aliasSteps);
    if (!name || steps.length === 0) { append(t('git.aliasNeed') + '\n'); return; }
    const next = [...aliases.filter((a) => a.name !== name), { name, steps }].sort((a, b) => a.name.localeCompare(b.name));
    saveAliases(repo, next); setAliases(next); setAliasName(''); setAliasSteps('');
  };
  const deleteAlias = (name: string) => {
    if (!confirm(t('git.aliasDeleteConfirm', { name }))) return;
    const next = aliases.filter((a) => a.name !== name);
    saveAliases(repo, next); setAliases(next);
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>{t('git.workflowsBlurb')}</p>

      <div className="panel">
        <h3 className="group-title">{t('git.oneClick')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{t('git.upHint')}</p>
        <div className="mod-toolbar">
          <input className="mod-search" style={{ flex: 1, minWidth: 200 }} value={upMsg} onChange={(e) => setUpMsg(e.target.value)} placeholder={t('git.upMessage')} />
          <button className="mini primary" disabled={!!busy} onClick={() => void up()}>{t('git.up')}</button>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <button className="mini" disabled={!!busy} onClick={() => void undo()}>{t('git.undoLast')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void share()}>{t('git.pushShare')}</button>
          <button className="mini" disabled={!!busy || !ghPath} onClick={() => void prLink()}>{t('git.copyPrLink')}</button>
        </div>
      </div>

      <div className="panel">
        <h3 className="group-title">{t('git.checkpoints')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{t('git.checkpointHint')}</p>
        <div className="mod-toolbar">
          <input className="mod-search" style={{ flex: 1, minWidth: 160 }} value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)} placeholder={t('git.checkpointName')} />
          <button className="mini" disabled={!!busy} onClick={() => void doCheckpoint()}>{t('git.checkpoint')}</button>
          <button className="mini" disabled={!!busy} onClick={() => void restore()}>{t('git.restore')}</button>
        </div>
      </div>

      <div className="panel">
        <h3 className="group-title">{t('git.aliases')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{t('git.aliasHint')}</p>
        {aliases.length === 0 ? <p className="count-note">{t('git.noAliases')}</p> : aliases.map((a) => (
          <div key={a.name} className="kv-row" style={{ alignItems: 'center' }}>
            <span style={{ fontWeight: 600, minWidth: 90 }}>{a.name}</span>
            <span className="value" style={{ flex: 1, fontFamily: 'monospace', fontSize: 11.5 }}>{a.steps.join('  ·  ')}</span>
            <button className="mini" disabled={!!busy} onClick={() => void runAlias(a)}>{t('git.run')}</button>
            <button className="mini" disabled={!!busy} onClick={() => { setAliasName(a.name); setAliasSteps(a.steps.join('\n')); }}>{t('git.edit')}</button>
            <button className="mini" disabled={!!busy} onClick={() => deleteAlias(a.name)}>✕</button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <input className="hosts-edit" style={{ minHeight: 0, height: 34 }} value={aliasName} onChange={(e) => setAliasName(e.target.value)} placeholder={t('git.aliasName')} />
          <textarea className="hosts-edit" style={{ marginTop: 6, minHeight: 80, fontFamily: 'Consolas, monospace' }} value={aliasSteps} onChange={(e) => setAliasSteps(e.target.value)} placeholder={'add -A\ncommit -m "wip"\npush'} />
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" onClick={saveAlias}>{t('git.saveAlias')}</button>
          </div>
        </div>
      </div>

      {out && (
        <div className="panel">
          <div className="mod-toolbar" style={{ marginBottom: 6 }}>
            <h3 className="group-title" style={{ margin: 0, flex: 1 }}>{t('git.output')}</h3>
            <button className="mini" onClick={() => setOut('')}>{t('git.clear')}</button>
          </div>
          <pre ref={consoleRef} className="cmd-out" style={{ margin: 0, maxHeight: 240, overflow: 'auto' }}>{out}</pre>
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// GITHUB tab — masked token · your repos / PRs / issues · create PR / issue (REST API)
// =====================================================================================
const GH_API = 'https://api.github.com';
async function ghApi<T>(token: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; error: string }> {
  if (!isTauri()) return { ok: false, status: 0, data: null, error: 'preview' };
  const uri = `${GH_API}${path}`;
  const parts = [
    "$ErrorActionPreference='Stop'",
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
    `$h=@{ Authorization = 'Bearer ${psq(token)}'; 'User-Agent' = 'WinForge-Web'; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }`,
  ];
  let bodyArg = '';
  if (body !== undefined) { parts.push(`$b='${psq(JSON.stringify(body))}'`); bodyArg = ' -Body $b'; }
  parts.push(
    'try {' +
      `$r = Invoke-WebRequest -Uri '${psq(uri)}' -Method ${method} -Headers $h${bodyArg} -TimeoutSec 30;` +
      "[pscustomobject]@{ status=[int]$r.StatusCode; body=[string]$r.Content } | ConvertTo-Json -Depth 3 -Compress" +
      '} catch {' +
      '$resp=$_.Exception.Response; if ($resp) { $sr=New-Object IO.StreamReader($resp.GetResponseStream()); $txt=$sr.ReadToEnd(); [pscustomobject]@{ status=[int]$resp.StatusCode; body=[string]$txt } | ConvertTo-Json -Depth 3 -Compress } else { [pscustomobject]@{ status=0; body=$_.Exception.Message } | ConvertTo-Json -Compress }' +
      '}',
  );
  const res = await runPowershell(parts.join('\n'));
  const text = res.stdout.trim();
  if (!text) return { ok: false, status: 0, data: null, error: res.stderr.trim() || `exit ${res.code}` };
  try {
    const env = JSON.parse(text) as { status: number; body: string };
    const status = env.status;
    let data: T | null = null;
    try { data = env.body ? (JSON.parse(env.body) as T) : null; } catch { /* non-json body */ }
    const ok = status >= 200 && status < 300;
    const error = ok ? '' : ((data as { message?: string } | null)?.message ?? env.body ?? `HTTP ${status}`);
    return { ok, status, data, error };
  } catch { return { ok: false, status: 0, data: null, error: text.slice(0, 300) }; }
}

interface GhRepo { full_name: string; private: boolean; description: string | null; html_url: string; default_branch: string }
interface GhPr { number: number; title: string; state: string; html_url: string; user: { login: string } }
interface GhIssue { number: number; title: string; state: string; html_url: string; pull_request?: unknown }

function GitHubTab() {
  const { t } = useTranslation();
  const [token, setToken] = useState<string>(() => localStorage.getItem(GH_TOKEN_KEY) ?? '');
  const [remember, setRemember] = useState<boolean>(() => !!localStorage.getItem(GH_TOKEN_KEY));
  const [show, setShow] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [activeRepo, setActiveRepo] = useState<string>('');
  const [prs, setPrs] = useState<GhPr[]>([]);
  const [issues, setIssues] = useState<GhIssue[]>([]);

  // create forms
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [prHead, setPrHead] = useState('');
  const [prBase, setPrBase] = useState('main');

  const connect = async () => {
    if (!token.trim()) { setMsg({ ok: false, text: t('git.ghTokenNeed') }); return; }
    setBusy('connect'); setMsg(null);
    const r = await ghApi<{ login: string }>(token.trim(), 'GET', '/user');
    if (r.status === 0 && r.error === 'preview') { setMsg({ ok: false, text: t('git.ghPreview') }); setBusy(''); return; }
    if (!r.ok || !r.data) { setMsg({ ok: false, text: r.error || t('git.ghAuthFailed') }); setBusy(''); return; }
    setLogin(r.data.login);
    if (remember) localStorage.setItem(GH_TOKEN_KEY, token.trim()); else localStorage.removeItem(GH_TOKEN_KEY);
    // load repos
    const rr = await ghApi<GhRepo[]>(token.trim(), 'GET', '/user/repos?per_page=100&sort=updated');
    setRepos(rr.ok && Array.isArray(rr.data) ? rr.data : []);
    setMsg({ ok: true, text: t('git.ghConnected', { login: r.data.login }) });
    setBusy('');
  };

  const openRepo = async (full: string) => {
    setActiveRepo(full); setBusy('repo'); setPrs([]); setIssues([]);
    const [owner, name] = full.split('/');
    setPrBase(repos.find((r) => r.full_name === full)?.default_branch ?? 'main');
    const pr = await ghApi<GhPr[]>(token.trim(), 'GET', `/repos/${owner}/${name}/pulls?state=open&per_page=50`);
    setPrs(pr.ok && Array.isArray(pr.data) ? pr.data : []);
    const is = await ghApi<GhIssue[]>(token.trim(), 'GET', `/repos/${owner}/${name}/issues?state=open&per_page=50`);
    setIssues(is.ok && Array.isArray(is.data) ? is.data.filter((i) => !i.pull_request) : []);
    setBusy('');
  };

  const createIssue = async () => {
    if (!activeRepo || !newTitle.trim()) { setMsg({ ok: false, text: t('git.titleNeed') }); return; }
    if (!confirm(t('git.createIssueConfirm', { repo: activeRepo }))) return;
    setBusy('mkissue'); setMsg(null);
    const [owner, name] = activeRepo.split('/');
    const r = await ghApi<GhIssue>(token.trim(), 'POST', `/repos/${owner}/${name}/issues`, { title: newTitle.trim(), body: newBody });
    setMsg({ ok: r.ok, text: r.ok && r.data ? t('git.issueCreated', { n: r.data.number }) : r.error });
    if (r.ok) { setNewTitle(''); setNewBody(''); await openRepo(activeRepo); }
    setBusy('');
  };
  const createPr = async () => {
    if (!activeRepo || !newTitle.trim() || !prHead.trim()) { setMsg({ ok: false, text: t('git.prFieldsNeed') }); return; }
    if (!confirm(t('git.createPrConfirm', { repo: activeRepo }))) return;
    setBusy('mkpr'); setMsg(null);
    const [owner, name] = activeRepo.split('/');
    const r = await ghApi<GhPr>(token.trim(), 'POST', `/repos/${owner}/${name}/pulls`, { title: newTitle.trim(), body: newBody, head: prHead.trim(), base: prBase.trim() });
    setMsg({ ok: r.ok, text: r.ok && r.data ? t('git.prCreatedN', { n: r.data.number }) : r.error });
    if (r.ok) { setNewTitle(''); setNewBody(''); setPrHead(''); await openRepo(activeRepo); }
    setBusy('');
  };

  const masked = show ? token : token.replace(/./g, '•');

  return (
    <div>
      {!isTauri() && <p className="count-note" style={{ marginTop: 0, color: 'var(--danger)' }}>{t('git.ghPreviewNote')}</p>}
      <div className="panel">
        <h3 className="group-title">{t('git.ghAuth')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>{t('git.ghTokenHint')}</p>
        <div className="mod-toolbar">
          <input className="mod-search" type={show ? 'text' : 'password'} style={{ flex: 1, minWidth: 220, fontFamily: 'monospace' }} value={show ? token : masked}
            onChange={(e) => setToken(e.target.value)} placeholder="ghp_… / github_pat_…" autoComplete="off" spellCheck={false} />
          <button className="mini" onClick={() => setShow((s) => !s)}>{show ? t('git.hide') : t('git.showToken')}</button>
          <label className="count-note" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('git.remember')}</label>
          <button className="mini primary" disabled={busy === 'connect'} onClick={() => void connect()}>{busy === 'connect' ? t('git.connecting') : t('git.connect')}</button>
        </div>
        {login && <p className="count-note" style={{ marginTop: 6 }}>{t('git.ghSignedIn', { login })}</p>}
        <Msg msg={msg} />
      </div>

      {login && (
        <div className="io-grid" style={{ gridTemplateColumns: '1fr 1.6fr', marginTop: 10 }}>
          <div className="panel" style={{ margin: 0, maxHeight: 460, overflow: 'auto' }}>
            <h3 className="group-title">{t('git.yourRepos', { n: repos.length })}</h3>
            {repos.map((r) => (
              <div key={r.full_name} className="kv-row" style={{ cursor: 'pointer', alignItems: 'center', background: activeRepo === r.full_name ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => void openRepo(r.full_name)}>
                <span className="value" style={{ flex: 1, fontSize: 12.5 }}>{r.full_name}{r.private ? <span className="badge" style={{ marginLeft: 6 }}>{t('git.private')}</span> : null}</span>
              </div>
            ))}
          </div>
          <div className="panel" style={{ margin: 0 }}>
            {!activeRepo ? <p className="count-note">{t('git.pickRepo')}</p> : (
              <>
                <h3 className="group-title">{activeRepo}</h3>
                <h4 className="group-title" style={{ fontSize: 13 }}>{t('git.openPrs', { n: prs.length })}</h4>
                {prs.length === 0 ? <p className="count-note">{t('git.noOpenPrs')}</p> : prs.map((p) => (
                  <div key={p.number} className="kv-row" style={{ alignItems: 'center' }}>
                    <code style={{ minWidth: 44 }}>#{p.number}</code>
                    <span className="value" style={{ flex: 1, fontSize: 12.5 }}>{p.title}</span>
                    <span className="count-note" style={{ margin: 0 }}>{p.user.login}</span>
                    <a className="mini" href={p.html_url} target="_blank" rel="noreferrer">{t('git.viewWeb')}</a>
                  </div>
                ))}
                <h4 className="group-title" style={{ fontSize: 13, marginTop: 10 }}>{t('git.openIssues', { n: issues.length })}</h4>
                {issues.length === 0 ? <p className="count-note">{t('git.noOpenIssues')}</p> : issues.map((i) => (
                  <div key={i.number} className="kv-row" style={{ alignItems: 'center' }}>
                    <code style={{ minWidth: 44 }}>#{i.number}</code>
                    <span className="value" style={{ flex: 1, fontSize: 12.5 }}>{i.title}</span>
                    <a className="mini" href={i.html_url} target="_blank" rel="noreferrer">{t('git.viewWeb')}</a>
                  </div>
                ))}

                <h4 className="group-title" style={{ fontSize: 13, marginTop: 12 }}>{t('git.createNew')}</h4>
                <input className="hosts-edit" style={{ minHeight: 0, height: 34 }} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('git.newTitle')} />
                <textarea className="hosts-edit" style={{ marginTop: 6, minHeight: 54 }} value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder={t('git.newBodyPh')} />
                <div className="mod-toolbar" style={{ marginTop: 6 }}>
                  <input className="mod-search" style={{ maxWidth: 150 }} value={prHead} onChange={(e) => setPrHead(e.target.value)} placeholder={t('git.prHead')} />
                  <span className="count-note" style={{ margin: 0 }}>→</span>
                  <input className="mod-search" style={{ maxWidth: 120 }} value={prBase} onChange={(e) => setPrBase(e.target.value)} placeholder={t('git.prBase')} />
                  <button className="mini primary" disabled={!!busy} onClick={() => void createPr()}>{busy === 'mkpr' ? t('git.creating') : t('git.createPr')}</button>
                  <button className="mini" disabled={!!busy} onClick={() => void createIssue()}>{busy === 'mkissue' ? t('git.creating') : t('git.createIssue')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// Repo picker (left) + workbench shell
// =====================================================================================
interface RepoEntry { path: string; name: string }
function loadRepos(): RepoEntry[] {
  try { return JSON.parse(localStorage.getItem(REPOS_KEY) ?? '[]') as RepoEntry[]; } catch { return []; }
}
function saveRepos(list: RepoEntry[]) { localStorage.setItem(REPOS_KEY, JSON.stringify(list)); }
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function Workbench({ gitPath, ghPath }: { gitPath: string; ghPath: string | null }) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoEntry[]>(() => loadRepos());
  const [repo, setRepo] = useState<string>(() => localStorage.getItem(REPO_KEY) ?? '');
  const [repoInput, setRepoInput] = useState('');
  const [valid, setValid] = useState<boolean | null>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDir, setCloneDir] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const check = useCallback(async (p: string): Promise<boolean> => {
    const r = await git(gitPath, p, ['rev-parse', '--is-inside-work-tree']);
    return r.success && r.stdout.trim() === 'true';
  }, [gitPath]);

  const selectRepo = useCallback(async (p: string) => {
    const path = p.trim();
    if (!path) return;
    const ok = await check(path);
    setValid(ok);
    if (ok) { setRepo(path); localStorage.setItem(REPO_KEY, path); }
  }, [check]);

  useEffect(() => { if (repo) void selectRepo(repo); /* eslint-disable-next-line */ }, []);

  const addRepo = async () => {
    const p = repoInput.trim();
    if (!p) return;
    const ok = await check(p);
    if (!ok) { setValid(false); setMsg({ ok: false, text: t('git.notRepo') }); return; }
    const entry: RepoEntry = { path: p, name: baseName(p) };
    const next = [entry, ...repos.filter((r) => r.path.toLowerCase() !== p.toLowerCase())];
    setRepos(next); saveRepos(next); setRepoInput(''); setMsg(null);
    await selectRepo(p);
  };
  const removeRepo = (p: string) => {
    const next = repos.filter((r) => r.path !== p);
    setRepos(next); saveRepos(next);
    if (repo === p) { setRepo(''); localStorage.removeItem(REPO_KEY); setValid(null); }
  };

  const clone = async () => {
    const url = cloneUrl.trim();
    const dir = cloneDir.trim();
    if (!url) { setMsg({ ok: false, text: t('git.cloneUrlNeed') }); return; }
    if (!dir) { setMsg({ ok: false, text: t('git.cloneDirNeed') }); return; }
    // normalise owner/repo shorthand → https URL
    const full = /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}.git` : url;
    setCloneBusy(true); setMsg(null);
    try {
      const r = await gitRaw(gitPath, ['clone', full, dir]);
      if (!r.success) { setMsg({ ok: false, text: errText(r) }); setCloneBusy(false); return; }
      const entry: RepoEntry = { path: dir, name: baseName(dir) };
      const next = [entry, ...repos.filter((x) => x.path.toLowerCase() !== dir.toLowerCase())];
      setRepos(next); saveRepos(next); setCloneUrl(''); setCloneDir('');
      setMsg({ ok: true, text: t('git.cloned', { dir }) });
      await selectRepo(dir);
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setCloneBusy(false); }
  };

  const tabs = useMemo(() => repo && valid ? [
    { id: 'overview', en: 'Overview', zh: '概覽', render: () => <OverviewTab gitPath={gitPath} repo={repo} /> },
    { id: 'changes', en: 'Changes', zh: '改動', render: () => <ChangesTab gitPath={gitPath} repo={repo} /> },
    { id: 'history', en: 'History', zh: '歷史', render: () => <HistoryTab gitPath={gitPath} repo={repo} /> },
    { id: 'branches', en: 'Branches', zh: '分支', render: () => <BranchesTab gitPath={gitPath} repo={repo} ghPath={ghPath} /> },
    { id: 'tools', en: 'Tools', zh: '工具', render: () => <ToolsTab gitPath={gitPath} repo={repo} ghPath={ghPath} /> },
    { id: 'workflows', en: 'Workflows', zh: '工作流程', render: () => <WorkflowsTab gitPath={gitPath} repo={repo} ghPath={ghPath} /> },
    { id: 'github', en: 'GitHub', zh: 'GitHub', render: () => <GitHubTab /> },
  ] : [], [repo, valid, gitPath, ghPath]);

  return (
    <div className="io-grid" style={{ gridTemplateColumns: '280px 1fr', alignItems: 'start', gap: 14 }}>
      {/* LEFT: repo list + add + clone */}
      <div className="panel" style={{ margin: 0 }}>
        <h3 className="group-title">{t('git.repositories')}</h3>
        <div className="mod-toolbar">
          <input className="mod-search" style={{ flex: 1, minWidth: 120, fontFamily: 'monospace', fontSize: 12 }} value={repoInput} onChange={(e) => setRepoInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addRepo()} placeholder="C:\\path\\to\\repo" />
          <button className="mini" onClick={() => void addRepo()}>{t('git.addFolder')}</button>
        </div>
        {repos.length === 0 ? <p className="count-note">{t('git.noRepos')}</p> : repos.map((r) => (
          <div key={r.path} className="kv-row" style={{ cursor: 'pointer', alignItems: 'center', background: repo === r.path ? 'var(--sel, rgba(127,127,127,0.15))' : undefined, borderRadius: 4 }} onClick={() => void selectRepo(r.path)}>
            <span style={{ flex: 1, overflow: 'hidden' }}>
              <span style={{ display: 'block', fontWeight: repo === r.path ? 700 : 500, fontSize: 12.5 }}>{r.name}</span>
              <span className="count-note" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{r.path}</span>
            </span>
            <button className="mini" title={t('git.removeFromList')} onClick={(e) => { e.stopPropagation(); removeRepo(r.path); }}>✕</button>
          </div>
        ))}

        <h3 className="group-title" style={{ marginTop: 14 }}>{t('git.cloneTitle')}</h3>
        <input className="hosts-edit" style={{ minHeight: 0, height: 32, fontSize: 12 }} value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder={t('git.cloneUrlPh')} />
        <input className="hosts-edit" style={{ minHeight: 0, height: 32, marginTop: 6, fontFamily: 'monospace', fontSize: 12 }} value={cloneDir} onChange={(e) => setCloneDir(e.target.value)} placeholder={t('git.cloneDirPh')} />
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <button className="mini primary" disabled={cloneBusy} onClick={() => void clone()}>{cloneBusy ? t('git.cloning') : t('git.clone')}</button>
        </div>
        <Msg msg={msg} />
      </div>

      {/* RIGHT: active repo header + tabbed workbench */}
      <div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="count-note" style={{ margin: 0 }}>{t('git.repo')}</label>
          <input className="hosts-edit" style={{ minHeight: 0, height: 34, flex: 1, minWidth: 200, fontFamily: 'monospace' }} value={repo} readOnly placeholder={t('git.pickRepoLeft')} />
        </div>
        {valid === false && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('git.notRepo')}</p>}
        {repo && valid ? <ModuleTabs tabs={tabs} /> : <p className="count-note" style={{ marginTop: 10 }}>{t('git.pickRepoLeft')}</p>}
      </div>
    </div>
  );
}

export function GitModule() {
  const [ghPath, setGhPath] = useState<string | null>(null);
  useEffect(() => {
    // Best-effort gh discovery (optional; PR/GitHub-CLI features light up when present).
    let alive = true;
    (async () => {
      try {
        const r = await runCommand('gh', ['--version']);
        if (alive && r.success) setGhPath('gh');
      } catch { /* gh not on PATH */ }
    })();
    return () => { alive = false; };
  }, []);
  return (
    <div className="mod">
      <DependencyGate tool="git" preferId="Git.Git" query="git">
        {(path) => <Workbench gitPath={path} ghPath={ghPath} />}
      </DependencyGate>
    </div>
  );
}
