import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, StatusDot, useAsync } from './common';

// Native port of WinForge's "Camoufox Profiles" module (Pages/CamoufoxModule.xaml(.cs) +
// Services/CamoufoxService.cs). The desktop module manages anti-detect browser profiles whose
// cookies + fingerprints are stored as plain-JSON files under a local git repo that auto-commits
// every change, exports one/selected/all as .zip, and launches profiles through a Camoufox engine
// it clones + builds on first use.
//
// This native module talks to that SAME live store — %LocalAppData%\WinForge\camoufox — through
// the Tauri backend:
//   • Profiles tab: enumerates profiles/<id>/profile.json manifests, renders each with its
//     fingerprint summary, and does real CRUD (create / edit / delete) writing the manifest to disk
//     and committing via git, exactly like CamoufoxService.SaveProfileAsync / DeleteProfileAsync.
//     A destructive delete is gated behind an explicit confirm.
//   • Git / History tab: shows pending-change count + the full `git log`, and can Sync (commit all
//     pending changes) — mirroring SyncAsync / ListCommitsAsync / PendingChangesAsync.
//   • Engine tab: probes for the Camoufox executable (the exact LocateExecutable() candidate paths)
//     and for git on PATH (the clone+build prerequisite), and shows the store paths.
// Bilingual throughout, reusing the desktop module's P("en","粵語") strings. It never launches the
// browser, clones, builds, or pushes to a remote from the web shell — those spawn external processes
// / network I/O; here we stay data-gathering + safe local store edits, honestly and usefully.

// ── Store layout (mirrors CamoufoxService paths) ──────────────────────────────
// StoreDir   = %LocalAppData%\WinForge\camoufox
// ProfilesDir= StoreDir\profiles ; each profile = profiles\<id>\profile.json (+ userdata\)
// SourceDir  = %LocalAppData%\WinForge\camoufox-src ; BinDir = ...\camoufox-bin
const STORE_PS = String.raw`$env:LOCALAPPDATA + '\WinForge\camoufox'`;

interface Profile {
  Id: string;
  Name: string;
  Notes: string;
  Tags: string;
  CreatedUtc: string;
  UpdatedUtc: string;
  UserAgent: string;
  Locale: string;
  Timezone: string;
  OsName: string;
  ScreenWidth: string;
  ScreenHeight: string;
  Proxy: string;
  ConfigJson: string;
}

interface Commit {
  Hash: string;
  Date: string;
  Subject: string;
}

interface EngineInfo {
  Exe: string; // resolved camoufox.exe path, or ''
  HasGit: boolean;
  GitVersion: string;
  StoreDir: string;
  SourceDir: string;
  BinDir: string;
  RepoExists: boolean;
  Pending: number;
}

const OS_NAMES = ['windows', 'macos', 'linux'] as const;

function emptyProfile(): Profile {
  return {
    Id: '',
    Name: '',
    Notes: '',
    Tags: '',
    CreatedUtc: '',
    UpdatedUtc: '',
    UserAgent: '',
    Locale: 'en-US',
    Timezone: '',
    OsName: 'windows',
    ScreenWidth: '',
    ScreenHeight: '',
    Proxy: '',
    ConfigJson: '',
  };
}

function shortId(id: string): string {
  return id.length >= 8 ? id.slice(0, 8) : id;
}

function shortHash(h: string): string {
  return h.length >= 7 ? h.slice(0, 7) : h;
}

function initial(name: string): string {
  const n = name.trim();
  return n ? n[0]!.toUpperCase() : '?';
}

// Port of CamoufoxProfile.FingerprintSummary.
function fingerprintSummary(p: Profile): string {
  const parts: string[] = [];
  if (p.OsName?.trim()) parts.push(p.OsName.trim());
  if (p.Locale?.trim()) parts.push(p.Locale.trim());
  if (p.Timezone?.trim()) parts.push(p.Timezone.trim());
  if (p.ScreenWidth?.trim() && p.ScreenHeight?.trim())
    parts.push(`${p.ScreenWidth.trim()}×${p.ScreenHeight.trim()}`);
  if (p.Proxy?.trim()) parts.push('proxy');
  return parts.length === 0 ? '—' : parts.join(' · ');
}

// ── PowerShell: read the whole store in one shot ──────────────────────────────
// Ensures the store dir exists, reads every profile manifest, then reports engine + git state.
// Returns a single object; callers wrap in an array via runPowershellJson.
const LOAD_PS = String.raw`
$store = ${STORE_PS}
$profilesDir = Join-Path $store 'profiles'
$src = $env:LOCALAPPDATA + '\WinForge\camoufox-src'
$bin = $env:LOCALAPPDATA + '\WinForge\camoufox-bin'

$profiles = New-Object System.Collections.ArrayList
if (Test-Path -LiteralPath $profilesDir) {
  Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $manifest = Join-Path $_.FullName 'profile.json'
    if (Test-Path -LiteralPath $manifest) {
      try {
        $p = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($p.Id) {
          [void]$profiles.Add([pscustomobject]@{
            Id=[string]$p.Id; Name=[string]$p.Name; Notes=[string]$p.Notes; Tags=[string]$p.Tags
            CreatedUtc=[string]$p.CreatedUtc; UpdatedUtc=[string]$p.UpdatedUtc
            UserAgent=[string]$p.UserAgent; Locale=[string]$p.Locale; Timezone=[string]$p.Timezone
            OsName=[string]$p.OsName; ScreenWidth=[string]$p.ScreenWidth; ScreenHeight=[string]$p.ScreenHeight
            Proxy=[string]$p.Proxy; ConfigJson=[string]$p.ConfigJson
          })
        }
      } catch {}
    }
  }
}

# ── Engine: the exact LocateExecutable() candidate list ──
$cands = @(
  (Join-Path $bin 'camoufox.exe'),
  (Join-Path $bin 'camoufox\camoufox.exe'),
  (Join-Path $src 'dist\camoufox.exe'),
  ($env:LOCALAPPDATA + '\camoufox\camoufox.exe'),
  ($env:ProgramFiles + '\Camoufox\camoufox.exe')
)
$exe = ''
foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break } }
if (-not $exe) {
  $pyCache = $env:LOCALAPPDATA + '\camoufox'
  if (Test-Path -LiteralPath $pyCache) {
    $hit = Get-ChildItem -LiteralPath $pyCache -Filter camoufox.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $exe = $hit.FullName }
  }
}

# ── git prerequisite + repo state ──
$gitVer = ''; $hasGit = $false
try { $gv = & git --version 2>$null; if ($LASTEXITCODE -eq 0 -and $gv) { $hasGit = $true; $gitVer = ($gv | Select-Object -First 1).ToString().Trim() } } catch {}

$repoExists = Test-Path -LiteralPath (Join-Path $store '.git')
$pending = 0
$commits = New-Object System.Collections.ArrayList
if ($hasGit -and $repoExists) {
  try {
    $st = & git -C $store status --porcelain 2>$null
    if ($st) { $pending = @($st | Where-Object { $_.Trim() -ne '' }).Count }
    $log = & git -C $store log --pretty=format:'%H%x09%ad%x09%s' --date=iso -n 500 2>$null
    foreach ($line in @($log)) {
      if (-not $line) { continue }
      $cols = $line -split ([char]9)
      if ($cols.Count -ge 3) {
        [void]$commits.Add([pscustomobject]@{ Hash=$cols[0].Trim(); Date=$cols[1].Trim(); Subject=$cols[2].Trim() })
      }
    }
  } catch {}
}

[pscustomobject]@{
  Profiles = @($profiles)
  Commits  = @($commits)
  Engine   = [pscustomobject]@{
    Exe=$exe; HasGit=$hasGit; GitVersion=$gitVer
    StoreDir=$store; SourceDir=$src; BinDir=$bin
    RepoExists=[bool]$repoExists; Pending=[int]$pending
  }
}
`;

interface LoadResult {
  Profiles: Profile[];
  Commits: Commit[];
  Engine: EngineInfo;
}

// Encode arbitrary text as a base64 PowerShell string literal (safe for JSON payloads / paths).
function psB64(text: string): string {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`;
}

// Commit helper matching CamoufoxService.CommitAsync: stamp + message, tolerant of "nothing to commit".
function gitCommitScript(message: string): string {
  return String.raw`
$store = ${STORE_PS}
$profilesDir = Join-Path $store 'profiles'
New-Item -ItemType Directory -Force -Path $profilesDir | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $store '.git'))) {
  & git -C $store init | Out-Null
  & git -C $store config user.name WinForge | Out-Null
  & git -C $store config user.email winforge@localhost | Out-Null
}
& git -C $store add -A 2>&1 | Out-Null
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$msg = $stamp + ' — ' + (${psB64(message)})
& git -C $store commit -m $msg 2>&1
`;
}

// Write a profile manifest to profiles/<id>/profile.json, then commit — SaveProfileAsync port.
async function saveProfile(p: Profile): Promise<string> {
  const id = p.Id || crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const manifest: Profile = {
    ...p,
    Id: id,
    CreatedUtc: p.CreatedUtc || now,
    UpdatedUtc: now,
  };
  const json = JSON.stringify(manifest, null, 2);
  const isNew = !p.Id;
  const verb = isNew ? 'Create' : 'Edit';
  const script = String.raw`
$store = ${STORE_PS}
$dir = Join-Path (Join-Path $store 'profiles') '${id}'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'userdata') | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'profile.json') -Value (${psB64(json)}) -Encoding UTF8 -NoNewline
${gitCommitScript(`${verb} profile "${manifest.Name}" (${shortId(id)})`)}
`;
  const res = await runPowershell(`$ErrorActionPreference='Stop'; ${script}`);
  if (!res.success && !/nothing to commit/i.test(res.stdout + res.stderr)) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
  }
  return id;
}

// Delete profiles/<id>/ then commit — DeleteProfileAsync port.
async function deleteProfile(p: Profile): Promise<void> {
  const script = String.raw`
$store = ${STORE_PS}
$dir = Join-Path (Join-Path $store 'profiles') '${p.Id}'
if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
${gitCommitScript(`Delete profile "${p.Name}" (${shortId(p.Id)})`)}
`;
  const res = await runPowershell(`$ErrorActionPreference='Stop'; ${script}`);
  if (!res.success && !/nothing to commit/i.test(res.stdout + res.stderr)) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
  }
}

// Sync — commit any pending change in one go (SyncAsync, without the remote push).
async function syncStore(note: string): Promise<string> {
  const trimmed = note.trim();
  const msg = trimmed ? `Sync — ${trimmed}` : 'Sync (pending changes)';
  const res = await runPowershell(`$ErrorActionPreference='Stop'; ${gitCommitScript(msg)}`);
  const out = (res.stdout + '\n' + res.stderr).trim();
  if (!res.success && !/nothing to commit/i.test(out)) {
    throw new Error(res.stderr.trim() || out || `exit ${res.code}`);
  }
  return out || 'ok';
}

type Tab = 'profiles' | 'git' | 'engine';

export function CamoufoxModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('profiles');
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [syncNote, setSyncNote] = useState('');

  const { data, loading, error, reload } = useAsync<LoadResult | null>(async () => {
    if (!isTauri()) return null;
    const arr = await runPowershellJson<LoadResult>(LOAD_PS);
    return arr[0] ?? null;
  }, []);

  const profiles = data?.Profiles ?? [];
  const commits = data?.Commits ?? [];
  const engine = data?.Engine;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? profiles.filter((p) =>
          `${p.Name} ${fingerprintSummary(p)} ${p.Id}`.toLowerCase().includes(q),
        )
      : profiles;
    return [...list].sort((a, b) => a.Name.localeCompare(b.Name));
  }, [profiles, filter]);

  const openNew = () => {
    setEditing(emptyProfile());
    setIsNew(true);
    setMsg(null);
  };

  const openEdit = (p: Profile) => {
    setEditing({ ...p });
    setIsNew(false);
    setMsg(null);
  };

  const onSave = async () => {
    if (!editing) return;
    setBusy(true);
    setMsg(null);
    try {
      const toSave: Profile = {
        ...editing,
        Name: editing.Name.trim() || t('camoufox.unnamed'),
      };
      await saveProfile(toSave);
      setMsg(isNew ? t('camoufox.created', { name: toSave.Name }) : t('camoufox.edited', { name: toSave.Name }));
      setEditing(null);
      reload();
    } catch (e) {
      setMsg(`${t('camoufox.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (p: Profile) => {
    if (!window.confirm(t('camoufox.deleteConfirm', { name: p.Name }))) return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteProfile(p);
      setMsg(t('camoufox.deleted', { name: p.Name }));
      reload();
    } catch (e) {
      setMsg(`${t('camoufox.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onSync = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await syncStore(syncNote);
      setSyncNote('');
      setMsg(t('camoufox.synced'));
      reload();
    } catch (e) {
      setMsg(`${t('camoufox.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profiles', label: t('camoufox.tabProfiles') },
    { id: 'git', label: t('camoufox.tabGit') },
    { id: 'engine', label: t('camoufox.tabEngine') },
  ];

  return (
    <div className="mod">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ flex: '1 1 320px' }}>
          <h3 className="group-title" style={{ fontSize: 16, margin: 0 }}>
            {t('camoufox.title')}
          </h3>
          <p className="count-note" style={{ margin: '2px 0 0' }}>
            {t('camoufox.blurb')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="badge">{t('camoufox.profileCount', { num: profiles.length })}</span>
          <StatusDot
            ok={!!engine?.Exe}
            label={engine?.Exe ? t('camoufox.engineReady') : t('camoufox.engineMissing')}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="mod-toolbar" style={{ gap: 6 }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={tab === tb.id ? 'mini primary' : 'mini'}
            onClick={() => {
              setTab(tb.id);
              setMsg(null);
            }}
          >
            {tb.label}
          </button>
        ))}
        <button className="mini" onClick={reload} disabled={loading || busy}>
          ⟳ {t('modules.refresh')}
        </button>
      </div>

      {msg && <p className="mod-msg">{msg}</p>}

      <AsyncState loading={loading} error={error}>
        {tab === 'profiles' && (
          <ProfilesTab
            rows={rows}
            filter={filter}
            setFilter={setFilter}
            busy={busy}
            onNew={openNew}
            onEdit={openEdit}
            onDelete={onDelete}
          />
        )}
        {tab === 'git' && engine && (
          <GitTab
            engine={engine}
            commits={commits}
            syncNote={syncNote}
            setSyncNote={setSyncNote}
            busy={busy}
            onSync={onSync}
          />
        )}
        {tab === 'engine' && engine && <EngineTab engine={engine} />}
      </AsyncState>

      {/* Editor dialog */}
      {editing && (
        <ProfileEditor
          profile={editing}
          isNew={isNew}
          busy={busy}
          onChange={setEditing}
          onSave={onSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ── Profiles tab ──────────────────────────────────────────────────────────────
function ProfilesTab({
  rows,
  filter,
  setFilter,
  busy,
  onNew,
  onEdit,
  onDelete,
}: {
  rows: Profile[];
  filter: string;
  setFilter: (v: string) => void;
  busy: boolean;
  onNew: () => void;
  onEdit: (p: Profile) => void;
  onDelete: (p: Profile) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mod-toolbar">
        <button className="mini primary" onClick={onNew} disabled={busy}>
          + {t('camoufox.newProfile')}
        </button>
        <input
          className="mod-search"
          placeholder={t('camoufox.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="count-note">{t('camoufox.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((p) => (
            <div
              key={p.Id}
              className="hosts-edit"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}
            >
              <div
                aria-hidden
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: 16,
                  color: '#06210f',
                  background: 'var(--brand, #7ee787)',
                }}
              >
                {initial(p.Name)}
              </div>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.Name}
                </div>
                <div className="count-note" style={{ margin: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>{fingerprintSummary(p)}</span>
                  <code style={{ opacity: 0.7 }}>{shortId(p.Id)}</code>
                </div>
              </div>
              <span className="row-actions">
                <button className="mini" onClick={() => onEdit(p)} disabled={busy}>
                  {t('camoufox.edit')}
                </button>
                <button className="mini" onClick={() => onDelete(p)} disabled={busy}>
                  {t('camoufox.delete')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Git / history tab ─────────────────────────────────────────────────────────
function GitTab({
  engine,
  commits,
  syncNote,
  setSyncNote,
  busy,
  onSync,
}: {
  engine: EngineInfo;
  commits: Commit[];
  syncNote: string;
  setSyncNote: (v: string) => void;
  busy: boolean;
  onSync: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="hosts-edit" style={{ marginBottom: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 6px' }}>
          {t('camoufox.gitTitle')}
        </h3>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('camoufox.gitDesc')}
        </p>
        <code style={{ display: 'block', wordBreak: 'break-all', opacity: 0.7, margin: '4px 0 8px' }}>
          {engine.StoreDir}
        </code>
        {!engine.HasGit ? (
          <p className="mod-msg">{t('camoufox.gitMissing')}</p>
        ) : (
          <p className="count-note" style={{ marginTop: 0 }}>
            {engine.Pending === 0
              ? t('camoufox.inSync')
              : t('camoufox.pending', { num: engine.Pending })}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="mod-search"
            placeholder={t('camoufox.syncNote')}
            value={syncNote}
            onChange={(e) => setSyncNote(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <button className="mini primary" onClick={onSync} disabled={busy || !engine.HasGit}>
            {t('camoufox.syncNow')}
          </button>
        </div>
      </div>

      <h3 className="group-title" style={{ fontSize: 15, margin: '4px 0 8px' }}>
        {t('camoufox.history')}
      </h3>
      {commits.length === 0 ? (
        <p className="count-note">{t('camoufox.noCommits')}</p>
      ) : (
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 80 }}>{t('camoufox.colHash')}</th>
                <th>{t('camoufox.colSubject')}</th>
                <th style={{ width: 160 }}>{t('camoufox.colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {commits.map((c) => (
                <tr key={c.Hash}>
                  <td>
                    <code>{shortHash(c.Hash)}</code>
                  </td>
                  <td>{c.Subject}</td>
                  <td className="count-note">{c.Date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Engine tab ────────────────────────────────────────────────────────────────
function EngineTab({ engine }: { engine: EngineInfo }) {
  const { t } = useTranslation();
  return (
    <div className="hosts-edit">
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 6px' }}>
        {t('camoufox.engineTitle')}
      </h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('camoufox.engineDesc')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        <div>
          <StatusDot
            ok={!!engine.Exe}
            label={engine.Exe ? t('camoufox.engineReady') : t('camoufox.engineMissing')}
          />
          <code style={{ display: 'block', wordBreak: 'break-all', opacity: 0.7, marginTop: 4 }}>
            {engine.Exe || t('camoufox.notFound')}
          </code>
        </div>
        <div>
          <StatusDot
            ok={engine.HasGit}
            label={engine.HasGit ? engine.GitVersion || t('camoufox.gitFound') : t('camoufox.gitNotFound')}
          />
          {!engine.HasGit && (
            <p className="count-note" style={{ margin: '4px 0 0' }}>
              {t('camoufox.gitPrereq')}
            </p>
          )}
        </div>
        <div className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span>
            {t('camoufox.pathStore')} <code>{engine.StoreDir}</code>
          </span>
          <span>
            {t('camoufox.pathSource')} <code>{engine.SourceDir}</code>
          </span>
          <span>
            {t('camoufox.pathBin')} <code>{engine.BinDir}</code>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Editor dialog (port of EditProfileDialog) ─────────────────────────────────
function ProfileEditor({
  profile,
  isNew,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  profile: Profile;
  isNew: boolean;
  busy: boolean;
  onChange: (p: Profile) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    onChange({ ...profile, [key]: value });

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      {node}
    </label>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onCancel}
    >
      <div
        className="hosts-edit"
        style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="group-title" style={{ fontSize: 15, marginTop: 0 }}>
          {isNew ? t('camoufox.newTitle') : t('camoufox.editTitle')}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {field(
            t('camoufox.fName'),
            <input value={profile.Name} placeholder={t('camoufox.phName')} onChange={(e) => set('Name', e.target.value)} />,
          )}
          {field(
            t('camoufox.fNotes'),
            <input value={profile.Notes} onChange={(e) => set('Notes', e.target.value)} />,
          )}
          {field(
            t('camoufox.fOs'),
            <select value={profile.OsName || 'windows'} onChange={(e) => set('OsName', e.target.value)}>
              {OS_NAMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>,
          )}
          {field(
            t('camoufox.fUa'),
            <input value={profile.UserAgent} placeholder={t('camoufox.phUa')} onChange={(e) => set('UserAgent', e.target.value)} />,
          )}
          {field(
            t('camoufox.fLocale'),
            <input value={profile.Locale} placeholder="en-US" onChange={(e) => set('Locale', e.target.value)} />,
          )}
          {field(
            t('camoufox.fTimezone'),
            <input value={profile.Timezone} placeholder="America/New_York" onChange={(e) => set('Timezone', e.target.value)} />,
          )}
          {field(
            t('camoufox.fScreen'),
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                value={profile.ScreenWidth}
                placeholder="1920"
                onChange={(e) => set('ScreenWidth', e.target.value)}
                style={{ width: 90 }}
              />
              <span>×</span>
              <input
                value={profile.ScreenHeight}
                placeholder="1080"
                onChange={(e) => set('ScreenHeight', e.target.value)}
                style={{ width: 90 }}
              />
            </span>,
          )}
          {field(
            t('camoufox.fProxy'),
            <input value={profile.Proxy} placeholder={t('camoufox.phProxy')} onChange={(e) => set('Proxy', e.target.value)} />,
          )}
          {field(
            t('camoufox.fConfig'),
            <textarea
              value={profile.ConfigJson}
              placeholder={t('camoufox.phConfig')}
              rows={4}
              onChange={(e) => set('ConfigJson', e.target.value)}
              style={{ fontFamily: 'monospace', resize: 'vertical' }}
            />,
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="mini" onClick={onCancel} disabled={busy}>
            {t('camoufox.cancel')}
          </button>
          <button className="mini primary" onClick={onSave} disabled={busy}>
            {t('camoufox.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
