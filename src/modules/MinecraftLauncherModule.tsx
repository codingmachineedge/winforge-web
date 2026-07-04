import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, StatusDot, useAsync } from './common';

// ============================================================================
// Minecraft Launcher — module.mclauncher
//
// Full port of WinForge's C# MinecraftLauncherModule (Pages/MinecraftLauncher-
// Module.xaml[.cs] + Services/MinecraftAuthService.cs + MinecraftLauncherService.cs).
// This is a FULLY CUSTOM launcher (WinForge's own UI + logic — not a wrapper
// around Mojang's official launcher). It:
//   • signs in through the complete MSA → Xbox Live → XSTS → Minecraft chain
//     (auth-code browser flow OR OAuth device-code flow), or an offline account;
//   • manages multiple independent instances/profiles, each with its own version,
//     game directory, Java path, min/max memory and extra JVM args (persisted);
//   • fetches version_manifest_v2 (release / snapshot), downloads+verifies files,
//     and launches java with the assembled command (gated behind an explicit
//     Play click, only when signed in).
//
// The C# root is %APPDATA%\.minecraft_winforge (own layout), separate from the
// official %APPDATA%\.minecraft the read-only Library tabs still inspect.
//
// SECRETS: access/XSTS tokens live only in memory; the long-lived MSA refresh
// token is persisted base64-obfuscated (the browser has no DPAPI) and always
// shown masked. The Azure client ID is persisted in localStorage. Nothing is
// ever logged. Every mutation (save / delete / download / sign-in / play) runs
// only on an explicit click; destructive ones confirm first. Reads auto-run.
//
// In a plain browser (no Tauri backend) the full UI renders; network/launch
// actions no-op with the labelled preview notice instead of hitting the backend.
// ============================================================================

const TABS = ['instances', 'account', 'versions', 'worlds', 'content', 'runtimes', 'log'] as const;
type Tab = (typeof TABS)[number];

const CONTENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks'] as const;
type ContentKind = (typeof CONTENT_KINDS)[number];

// The official install the read-only Library tabs inspect. WinForge's own custom
// root (%APPDATA%\.minecraft_winforge) is referenced inline in the backend helpers.
const MC_ROOT = '$env:APPDATA + "\\.minecraft"';

// localStorage keys — parity with SettingsStore / MinecraftInstanceStore / MinecraftAccountStore.
const LS_CLIENT_ID = 'mclauncher.azureClientId';
const LS_INSTANCES = 'mclauncher.instances';
const LS_REFRESH_PREFIX = 'mclauncher.refresh.'; // + instanceId → obfuscated MSA refresh token

// ---------------------------------------------------------------------------- types

interface Overview {
  root: string;
  exists: boolean;
  sizeBytes: number;
  versionsCount: number;
  worldsCount: number;
  modsCount: number;
}

interface VersionRow {
  Id: string;
  Type: string;
  ReleaseTime: string;
  SizeMB: number;
}

interface WorldRow {
  Name: string;
  Folder: string;
  SizeMB: number;
  LastPlayed: string;
  HasIcon: boolean;
}

interface ContentRow {
  Name: string;
  SizeMB: number;
  Modified: string;
}

interface RuntimeRow {
  Kind: string;
  Path: string;
  Version: string;
}

// One manifest version ref (mirrors MinecraftVersionRef).
interface ManifestVersion {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
}

// One independent instance / profile (mirrors MinecraftInstance).
interface Instance {
  id: string;
  name: string;
  versionId: string;
  gameDirectory: string;
  javaPath: string;
  maxMemoryMb: number;
  minMemoryMb: number;
  extraJvmArgs: string;
  accountInstanceId: string;
}

// In-memory account (mirrors MinecraftAccount). Access token never persisted.
interface Account {
  uuid: string;
  name: string;
  accessToken: string;
  ownsGame: boolean;
  isOffline: boolean;
}

// ---------------------------------------------------------------------------- helpers

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// base64 obfuscation (browser has no DPAPI — never plaintext, always masked, never logged).
function obfuscate(plain: string): string {
  try {
    return btoa(unescape(encodeURIComponent(plain)));
  } catch {
    return '';
  }
}

function newId(): string {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// Offline names: 3–16 chars of [A-Za-z0-9_] (mirrors MinecraftAccount.IsValidOfflineName).
function isValidOfflineName(name: string): boolean {
  const n = name.trim();
  return n.length >= 3 && n.length <= 16 && /^[A-Za-z0-9_]+$/.test(n);
}

function newInstance(name: string): Instance {
  const id = newId();
  return {
    id,
    name,
    versionId: '',
    gameDirectory: '',
    javaPath: '',
    maxMemoryMb: 2048,
    minMemoryMb: 512,
    extraJvmArgs: '',
    accountInstanceId: '',
  };
}

function loadInstances(): Instance[] {
  try {
    const raw = localStorage.getItem(LS_INSTANCES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Instance[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInstances(list: Instance[]): void {
  try {
    localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable */
  }
}

function ps1(v: string): string {
  return v.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------- module

export function MinecraftLauncherModule() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('instances');

  // ── Account / auth state ────────────────────────────────────────────────────
  const [clientId, setClientId] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_CLIENT_ID) ?? '';
    } catch {
      return '';
    }
  });
  const [clientIdDraft, setClientIdDraft] = useState<string>(clientId);
  const [account, setAccount] = useState<Account | null>(null);
  const [offlineName, setOfflineName] = useState('');
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deviceCode, setDeviceCode] = useState<{ code: string; uri: string } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const cancelAuth = useRef(false);

  const hasClientId = clientId.trim().length > 0;

  const saveClientId = () => {
    const id = clientIdDraft.trim();
    setClientId(id);
    try {
      localStorage.setItem(LS_CLIENT_ID, id);
    } catch {
      /* ignore */
    }
    setAuthMsg({ ok: true, text: t('mclauncher.clientIdSaved') });
  };

  const setOffline = () => {
    const name = offlineName.trim();
    if (!isValidOfflineName(name)) {
      setAuthMsg({ ok: false, text: t('mclauncher.offlineInvalid') });
      return;
    }
    setAccount({ uuid: '', name, accessToken: '0', ownsGame: true, isOffline: true });
    setAuthMsg({ ok: true, text: t('mclauncher.offlineReady', { name }) });
  };

  const signOut = () => {
    // Clear the persisted refresh token for the active instance + memory account.
    try {
      const inst = instances.find((i) => i.id === editingId);
      const acctId = inst?.accountInstanceId || inst?.id || 'shared';
      localStorage.removeItem(LS_REFRESH_PREFIX + acctId);
    } catch {
      /* ignore */
    }
    setAccount(null);
    setAuthMsg(null);
  };

  // Device-code sign-in: real MSA → XBL → XSTS → Minecraft chain through the
  // backend HttpClient (no CORS), exactly as MinecraftAuthService does it.
  const signInDeviceCode = async () => {
    if (authBusy) return;
    if (!hasClientId) {
      setAuthMsg({ ok: false, text: t('mclauncher.needClientId') });
      return;
    }
    if (!isTauri()) {
      setAuthMsg({ ok: false, text: t('mclauncher.authPreview') });
      return;
    }
    setAuthBusy(true);
    cancelAuth.current = false;
    setDeviceCode(null);
    setAuthMsg({ ok: true, text: t('mclauncher.requestingCode') });
    try {
      const acct = await runDeviceCodeChain(clientId.trim(), (p) => setDeviceCode(p), () => cancelAuth.current);
      if (!acct) {
        setAuthMsg({ ok: false, text: t('mclauncher.signInFailed') });
        return;
      }
      if (typeof acct === 'string') {
        setAuthMsg({ ok: false, text: describeAuthError(acct, t) });
        return;
      }
      setAccount(acct);
      persistRefreshToken(acct.refreshToken);
      setAuthMsg({ ok: true, text: t('mclauncher.welcome', { name: acct.name }) });
    } catch (e) {
      setAuthMsg({ ok: false, text: `${t('mclauncher.signInFailed')}: ${String(e)}` });
    } finally {
      setDeviceCode(null);
      setAuthBusy(false);
    }
  };

  // The browser auth-code flow needs an embedded WebView2 (native only). We
  // surface the same button; in the web it explains the device-code alternative.
  const signInBrowser = () => {
    if (!hasClientId) {
      setAuthMsg({ ok: false, text: t('mclauncher.needClientId') });
      return;
    }
    setAuthMsg({ ok: false, text: t('mclauncher.browserFlowNote') });
  };

  const persistRefreshToken = (refresh: string) => {
    if (!refresh) return;
    try {
      const inst = instances.find((i) => i.id === editingId);
      const acctId = inst?.accountInstanceId || inst?.id || 'shared';
      localStorage.setItem(LS_REFRESH_PREFIX + acctId, obfuscate(refresh));
    } catch {
      /* ignore */
    }
  };

  const cancelDeviceCode = () => {
    cancelAuth.current = true;
    setDeviceCode(null);
  };

  const accountLabel = account
    ? account.isOffline
      ? t('mclauncher.offlineAs', { name: account.name })
      : account.ownsGame
        ? t('mclauncher.signedInAs', { name: account.name })
        : t('mclauncher.notSignedIn')
    : t('mclauncher.notSignedIn');
  const signedIn = !!(account && account.ownsGame);

  // ── Instances / profiles ────────────────────────────────────────────────────
  const [instances, setInstances] = useState<Instance[]>(() => loadInstances());
  const [editingId, setEditingId] = useState<string | null>(() => loadInstances()[0]?.id ?? null);
  const [instMsg, setInstMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const editing = instances.find((i) => i.id === editingId) ?? null;
  const [draft, setDraft] = useState<Instance | null>(editing);

  useEffect(() => {
    setDraft(editing ? { ...editing } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const persist = (list: Instance[]) => {
    setInstances(list);
    saveInstances(list);
  };

  const addInstance = () => {
    const inst = newInstance(t('mclauncher.newInstance'));
    const list = [...instances, inst];
    persist(list);
    setEditingId(inst.id);
  };

  const saveInstance = () => {
    if (!draft) return;
    const name = draft.name.trim() || draft.id;
    const fixed: Instance = {
      ...draft,
      name,
      maxMemoryMb: Math.max(512, Number(draft.maxMemoryMb) || 2048),
      minMemoryMb: Math.max(256, Number(draft.minMemoryMb) || 512),
    };
    const list = instances.map((i) => (i.id === fixed.id ? fixed : i));
    if (!list.some((i) => i.id === fixed.id)) list.push(fixed);
    persist(list);
    setDraft({ ...fixed });
    setInstMsg({ ok: true, text: t('mclauncher.saved') });
  };

  const deleteInstance = () => {
    if (!draft) return;
    if (!confirm(t('mclauncher.confirmDelete', { name: draft.name }))) return;
    const list = instances.filter((i) => i.id !== draft.id);
    try {
      localStorage.removeItem(LS_REFRESH_PREFIX + (draft.accountInstanceId || draft.id));
    } catch {
      /* ignore */
    }
    persist(list);
    setEditingId(list[0]?.id ?? null);
    setInstMsg({ ok: true, text: t('mclauncher.deleted') });
  };

  const patchDraft = (patch: Partial<Instance>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  // ── Version manifest (release / snapshot) ───────────────────────────────────
  const [showSnapshots, setShowSnapshots] = useState(false);
  const manifest = useAsync<ManifestVersion[]>(async () => {
    if (!isTauri()) return [];
    return fetchManifest();
  }, []);
  const manifestVersions = useMemo(() => {
    const all = manifest.data ?? [];
    return showSnapshots ? all : all.filter((v) => v.type === 'release');
  }, [manifest.data, showSnapshots]);

  // ── Download / verify + Play (gated) ────────────────────────────────────────
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);

  const previewGuard = (): boolean => {
    if (!isTauri()) {
      setInstMsg({ ok: false, text: t('mclauncher.actionPreview') });
      return false;
    }
    return true;
  };

  const downloadVerify = async () => {
    if (!draft) return;
    saveInstance();
    if (!draft.versionId) {
      setInstMsg({ ok: false, text: t('mclauncher.pickVersionFirst') });
      return;
    }
    if (!previewGuard()) return;
    setDownloadBusy(true);
    setInstMsg({ ok: true, text: t('mclauncher.downloading') });
    try {
      const ok = await installVersion(draft.versionId, manifest.data ?? []);
      setInstMsg(
        ok
          ? { ok: true, text: t('mclauncher.downloadComplete') }
          : { ok: false, text: t('mclauncher.downloadFailed') },
      );
    } catch (e) {
      setInstMsg({ ok: false, text: `${t('mclauncher.downloadFailed')}: ${String(e)}` });
    } finally {
      setDownloadBusy(false);
    }
  };

  const play = async () => {
    if (!draft) return;
    if (!signedIn) {
      setInstMsg({ ok: false, text: t('mclauncher.signInFirst') });
      return;
    }
    saveInstance();
    if (!draft.versionId) {
      setInstMsg({ ok: false, text: t('mclauncher.pickVersionFirst') });
      return;
    }
    if (!previewGuard()) return;
    if (!confirm(t('mclauncher.confirmPlay', { version: draft.versionId }))) return;
    setPlayBusy(true);
    setInstMsg({ ok: true, text: t('mclauncher.launching') });
    try {
      const err = await launchGame(draft, account!);
      if (err) {
        setInstMsg({ ok: false, text: describeLaunchError(err, t) });
        return;
      }
      setInstMsg({ ok: true, text: t('mclauncher.launched') });
    } catch (e) {
      setInstMsg({ ok: false, text: `${t('mclauncher.launchFailed')}: ${String(e)}` });
    } finally {
      setPlayBusy(false);
    }
  };

  // ── Read-only Library tabs (official %APPDATA%\.minecraft) ───────────────────
  const ov = useAsync<Overview>(async () => {
    const rows = await runPowershellJson<Overview>(`
      $root = ${MC_ROOT}
      $exists = Test-Path -LiteralPath $root
      $size = 0; $vC = 0; $wC = 0; $mC = 0
      if ($exists) {
        try { $s = (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if ($s) { $size = $s } } catch {}
        $vDir = Join-Path $root 'versions'; if (Test-Path $vDir) { $vC = @(Get-ChildItem -LiteralPath $vDir -Directory -ErrorAction SilentlyContinue).Count }
        $wDir = Join-Path $root 'saves';    if (Test-Path $wDir) { $wC = @(Get-ChildItem -LiteralPath $wDir -Directory -ErrorAction SilentlyContinue).Count }
        $mDir = Join-Path $root 'mods';     if (Test-Path $mDir) { $mC = @(Get-ChildItem -LiteralPath $mDir -File -Filter *.jar -ErrorAction SilentlyContinue).Count }
      }
      [pscustomobject]@{
        root = $root; exists = [bool]$exists;
        sizeBytes = [long]$size;
        versionsCount = [int]$vC; worldsCount = [int]$wC; modsCount = [int]$mC
      }`);
    const r = rows[0];
    if (!r) throw new Error('no data');
    return { ...r, sizeBytes: Number(r.sizeBytes) || 0 };
  }, []);
  const overview = ov.data;

  const versions = useAsync<VersionRow[]>(
    () =>
      runPowershellJson<VersionRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root 'versions'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $id = $_.Name
          $json = Join-Path $_.FullName ($id + '.json')
          $type = 'unknown'; $rel = ''
          if (Test-Path $json) {
            try {
              $j = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
              if ($j.type) { $type = [string]$j.type }
              if ($j.releaseTime) { $rel = ([datetime]$j.releaseTime).ToString('yyyy-MM-dd') }
            } catch {}
          }
          $sz = 0
          try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          [pscustomobject]@{
            Id = $id; Type = $type; ReleaseTime = $rel;
            SizeMB = [math]::Round(($sz / 1MB), 1)
          }
        }`),
    [],
  );

  const worlds = useAsync<WorldRow[]>(
    () =>
      runPowershellJson<WorldRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root 'saves'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $sz = 0
          try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          $lvl = Join-Path $_.FullName 'level.dat'
          $when = $_.LastWriteTime
          if (Test-Path $lvl) { $when = (Get-Item -LiteralPath $lvl).LastWriteTime }
          [pscustomobject]@{
            Name = $_.Name; Folder = $_.Name;
            SizeMB = [math]::Round(($sz / 1MB), 1);
            LastPlayed = $when.ToString('yyyy-MM-dd HH:mm');
            HasIcon = [bool](Test-Path (Join-Path $_.FullName 'icon.png'))
          }
        }`),
    [],
  );

  const [kind, setKind] = useState<ContentKind>('mods');
  const content = useAsync<ContentRow[]>(
    () =>
      runPowershellJson<ContentRow>(`
        $root = ${MC_ROOT}; $dir = Join-Path $root '${kind}'
        if (-not (Test-Path $dir)) { return }
        Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | ForEach-Object {
          $sz = 0
          if ($_.PSIsContainer) {
            try { $sz = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
          } else { $sz = $_.Length }
          [pscustomobject]@{
            Name = $_.Name;
            SizeMB = [math]::Round(($sz / 1MB), 2);
            Modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
          }
        }`),
    [kind],
  );

  const runtimes = useAsync<RuntimeRow[]>(async () => {
    return runPowershellJson<RuntimeRow>(`
      $out = @()
      $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime'),
        (Join-Path $env:APPDATA '.minecraft\\runtime'),
        (Join-Path $env:APPDATA '.minecraft_winforge\\runtimes'),
        (Join-Path ${'${env:ProgramFiles(x86)}'} 'Minecraft Launcher\\runtime')
      )
      foreach ($rt in $roots) {
        if (Test-Path $rt) {
          Get-ChildItem -LiteralPath $rt -Recurse -Filter 'javaw.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 12 | ForEach-Object {
            $ver = ''
            try {
              $fv = $_.VersionInfo.ProductVersion; if ($fv) { $ver = [string]$fv }
            } catch {}
            $out += [pscustomobject]@{ Kind = 'bundled'; Path = $_.FullName; Version = $ver }
          }
        }
      }
      $onPath = Get-Command java -ErrorAction SilentlyContinue
      if ($onPath) {
        $v = ''
        try { $v = (& java -version 2>&1 | Select-Object -First 1) -join ' ' } catch {}
        $out += [pscustomobject]@{ Kind = 'path'; Path = [string]$onPath.Source; Version = [string]$v }
      }
      $out`);
  }, []);

  const [logText, setLogText] = useState<string>('');
  const [logLoaded, setLogLoaded] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const loadLog = useCallback(async () => {
    if (!isTauri()) {
      setLogText(t('mclauncher.desktopOnly'));
      setLogLoaded(true);
      return;
    }
    setLogBusy(true);
    const res = await runPowershell(`
      $roots = @(($env:APPDATA + "\\.minecraft_winforge\\logs\\latest.log"), (${MC_ROOT} + "\\logs\\latest.log"))
      $log = $roots | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
      if ($log) { Get-Content -LiteralPath $log -Tail 300 } else { '' }`);
    setLogBusy(false);
    setLogText(res.stdout.trim() || t('mclauncher.noLog'));
    setLogLoaded(true);
  }, [t]);

  // ── columns ─────────────────────────────────────────────────────────────────
  const versionCols: Column<VersionRow>[] = [
    { key: 'Id', header: t('mclauncher.versionId') },
    {
      key: 'Type',
      header: t('mclauncher.versionType'),
      width: 130,
      render: (v) => <StatusDot ok={v.Type === 'release'} label={v.Type} />,
    },
    { key: 'ReleaseTime', header: t('mclauncher.released'), width: 130 },
    { key: 'SizeMB', header: t('mclauncher.size'), width: 100, align: 'right', render: (v) => `${v.SizeMB} MB` },
  ];
  const worldCols: Column<WorldRow>[] = [
    {
      key: 'Name',
      header: t('mclauncher.worldName'),
      render: (w) => (
        <span>
          {w.HasIcon ? '🗺️ ' : '📁 '}
          {w.Name}
        </span>
      ),
    },
    { key: 'LastPlayed', header: t('mclauncher.lastPlayed'), width: 160 },
    { key: 'SizeMB', header: t('mclauncher.size'), width: 100, align: 'right', render: (w) => `${w.SizeMB} MB` },
  ];
  const contentCols: Column<ContentRow>[] = [
    { key: 'Name', header: t('mclauncher.fileName'), render: (c) => <span style={{ fontFamily: 'monospace' }}>{c.Name}</span> },
    { key: 'Modified', header: t('mclauncher.modified'), width: 160 },
    { key: 'SizeMB', header: t('mclauncher.size'), width: 100, align: 'right', render: (c) => `${c.SizeMB} MB` },
  ];
  const runtimeCols: Column<RuntimeRow>[] = [
    {
      key: 'Kind',
      header: t('mclauncher.runtimeKind'),
      width: 110,
      render: (r) => (r.Kind === 'bundled' ? t('mclauncher.bundled') : t('mclauncher.onPath')),
    },
    { key: 'Version', header: t('mclauncher.version'), width: 220 },
    { key: 'Path', header: t('mclauncher.path'), render: (r) => <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.Path}</span> },
  ];

  const sortedVersions = useMemo(
    () => [...(versions.data ?? [])].sort((a, b) => b.ReleaseTime.localeCompare(a.ReleaseTime) || a.Id.localeCompare(b.Id)),
    [versions.data],
  );
  const sortedWorlds = useMemo(() => [...(worlds.data ?? [])].sort((a, b) => b.LastPlayed.localeCompare(a.LastPlayed)), [worlds.data]);
  const sortedContent = useMemo(() => [...(content.data ?? [])].sort((a, b) => a.Name.localeCompare(b.Name)), [content.data]);

  const busyAny = downloadBusy || playBusy;

  // Instances/account are new tabs (flat keys); the rest reuse the existing tab.* keys.
  const tabLabel = (id: Tab): string =>
    id === 'instances' ? t('mclauncher.tabInstances') : id === 'account' ? t('mclauncher.tabAccount') : t(`mclauncher.tab.${id}`);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mclauncher.blurbFull')}
      </p>

      {!isTauri() && (
        <p className="count-note" style={{ marginTop: 0, color: 'var(--danger)' }}>
          {t('mclauncher.previewNote')}
        </p>
      )}

      <div className="mod-tabbar" role="tablist" style={{ marginTop: 8 }}>
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={`mod-tab${id === tab ? ' active' : ''}`}
            onClick={() => {
              setTab(id);
              if (id === 'log' && !logLoaded) void loadLog();
            }}
          >
            {tabLabel(id)}
          </button>
        ))}
      </div>

      <div className="mod-tabpanel" role="tabpanel">
        {/* ─────────────────────────────── INSTANCES ─────────────────────────── */}
        {tab === 'instances' && (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 240px', minWidth: 200 }}>
              <div className="mod-toolbar">
                <strong style={{ fontSize: 14 }}>{t('mclauncher.instancesHeader')}</strong>
                <button className="mini primary" onClick={addInstance} title={t('mclauncher.newInstance')}>
                  + {t('mclauncher.newInstance')}
                </button>
              </div>
              {instances.length === 0 ? (
                <p className="count-note">{t('mclauncher.noInstances')}</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {instances.map((inst) => (
                    <li key={inst.id}>
                      <button
                        className={`mini${inst.id === editingId ? ' primary' : ''}`}
                        style={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start' }}
                        onClick={() => setEditingId(inst.id)}
                      >
                        {inst.name || inst.id}
                        {inst.versionId ? <span className="count-note" style={{ marginLeft: 6 }}>({inst.versionId})</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div style={{ flex: '1 1 360px', minWidth: 300 }}>
              {!draft ? (
                <p className="count-note">{t('mclauncher.selectInstance')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.instanceName')}</span>
                    <input className="mod-search" value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.gameVersion')}</span>
                    <select
                      className="mod-search"
                      value={draft.versionId}
                      onChange={(e) => patchDraft({ versionId: e.target.value })}
                    >
                      <option value="">{t('mclauncher.pickVersion')}</option>
                      {draft.versionId && !manifestVersions.some((v) => v.id === draft.versionId) && (
                        <option value={draft.versionId}>{draft.versionId}</option>
                      )}
                      {manifestVersions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id} ({v.type})
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="mod-toolbar" style={{ marginTop: 0 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={showSnapshots} onChange={(e) => setShowSnapshots(e.target.checked)} />
                      <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.showSnapshots')}</span>
                    </label>
                    <button className="mini" onClick={manifest.reload} disabled={manifest.loading}>
                      ⟳ {t('mclauncher.refreshList')}
                    </button>
                    <span className="count-note">
                      {manifest.loading ? t('modules.loading') : t('mclauncher.manifestCount', { num: manifestVersions.length })}
                    </span>
                  </div>
                  {manifest.error && <pre className="cmd-out error">{manifest.error}</pre>}

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.gameDir')}</span>
                    <input
                      className="mod-search"
                      style={{ fontFamily: 'monospace' }}
                      value={draft.gameDirectory}
                      placeholder={t('mclauncher.gameDirPlaceholder')}
                      onChange={(e) => patchDraft({ gameDirectory: e.target.value })}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.javaPath')}</span>
                    <input
                      className="mod-search"
                      style={{ fontFamily: 'monospace' }}
                      value={draft.javaPath}
                      placeholder={t('mclauncher.javaPlaceholder')}
                      onChange={(e) => patchDraft({ javaPath: e.target.value })}
                    />
                  </label>

                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.maxMem')}</span>
                      <input
                        className="mod-search"
                        type="number"
                        min={512}
                        max={65536}
                        style={{ width: 130 }}
                        value={draft.maxMemoryMb}
                        onChange={(e) => patchDraft({ maxMemoryMb: Number(e.target.value) })}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.minMem')}</span>
                      <input
                        className="mod-search"
                        type="number"
                        min={256}
                        max={65536}
                        style={{ width: 130 }}
                        value={draft.minMemoryMb}
                        onChange={(e) => patchDraft({ minMemoryMb: Number(e.target.value) })}
                      />
                    </label>
                  </div>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.extraArgs')}</span>
                    <input
                      className="mod-search"
                      style={{ fontFamily: 'monospace' }}
                      value={draft.extraJvmArgs}
                      placeholder="-XX:+UseG1GC"
                      onChange={(e) => patchDraft({ extraJvmArgs: e.target.value })}
                    />
                  </label>

                  <div className="mod-toolbar" style={{ marginTop: 4 }}>
                    <button className="mini" onClick={saveInstance}>
                      {t('mclauncher.saveInstance')}
                    </button>
                    <button className="mini" onClick={downloadVerify} disabled={busyAny}>
                      {downloadBusy ? t('mclauncher.downloading') : t('mclauncher.downloadVerify')}
                    </button>
                    <button className="mini primary" onClick={play} disabled={busyAny || !signedIn}>
                      ▶ {playBusy ? t('mclauncher.launching') : t('mclauncher.play')}
                    </button>
                    <button className="mini" onClick={deleteInstance}>
                      {t('mclauncher.delete')}
                    </button>
                    <StatusDot ok={signedIn} label={accountLabel} />
                  </div>

                  {!signedIn && (
                    <p className="count-note" style={{ marginTop: 0 }}>
                      {t('mclauncher.playGate')}
                    </p>
                  )}

                  {instMsg && (
                    <pre className={`cmd-out${instMsg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>
                      {instMsg.text}
                    </pre>
                  )}

                  <p className="count-note" style={{ marginTop: 4 }}>
                    {t('mclauncher.eulaNote')}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──────────────────────────────── ACCOUNT ──────────────────────────── */}
        {tab === 'account' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
            {!hasClientId && (
              <p className="cmd-out error" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>
                {t('mclauncher.prereqWarning')}
              </p>
            )}

            <details open={!hasClientId}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('mclauncher.clientIdHeader')}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <p className="count-note" style={{ margin: 0 }}>
                  {t('mclauncher.clientIdNote')}
                </p>
                <div className="mod-toolbar" style={{ marginTop: 0 }}>
                  <input
                    className="mod-search"
                    style={{ minWidth: 340, fontFamily: 'monospace' }}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    value={clientIdDraft}
                    onChange={(e) => setClientIdDraft(e.target.value)}
                  />
                  <button className="mini" onClick={saveClientId}>
                    {t('mclauncher.save')}
                  </button>
                </div>
              </div>
            </details>

            <div className="mod-toolbar" style={{ marginTop: 0 }}>
              <button className="mini primary" onClick={signInBrowser} disabled={authBusy}>
                🔐 {t('mclauncher.signInBrowser')}
              </button>
              <button className="mini" onClick={signInDeviceCode} disabled={authBusy}>
                {authBusy ? t('mclauncher.signingIn') : t('mclauncher.signInDeviceCode')}
              </button>
              <button className="mini" onClick={signOut} disabled={!signedIn}>
                {t('mclauncher.signOut')}
              </button>
              <StatusDot ok={signedIn} label={accountLabel} />
            </div>

            {deviceCode && (
              <div className="cmd-out" style={{ whiteSpace: 'pre-wrap' }}>
                <div>
                  {t('mclauncher.deviceCodeInstr', { uri: deviceCode.uri })}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 3, marginTop: 6 }}>{deviceCode.code}</div>
                <button className="mini" style={{ marginTop: 8 }} onClick={cancelDeviceCode}>
                  {t('mclauncher.cancel')}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="count-note" style={{ margin: 0 }}>{t('mclauncher.offlineLabel')}</span>
              <div className="mod-toolbar" style={{ marginTop: 0 }}>
                <input
                  className="mod-search"
                  style={{ minWidth: 180 }}
                  maxLength={16}
                  placeholder="Player"
                  value={offlineName}
                  onChange={(e) => setOfflineName(e.target.value)}
                />
                <button className="mini" onClick={setOffline}>
                  {t('mclauncher.useOffline')}
                </button>
              </div>
              <p className="count-note" style={{ margin: 0 }}>
                {t('mclauncher.offlineHint')}
              </p>
            </div>

            {authMsg && (
              <pre className={`cmd-out${authMsg.ok ? '' : ' error'}`} style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>
                {authMsg.text}
              </pre>
            )}

            <p className="count-note" style={{ margin: 0 }}>
              {t('mclauncher.tokenNote')}
            </p>
          </div>
        )}

        {/* ─────────────────────────────── LIBRARY: VERSIONS ─────────────────── */}
        {tab === 'versions' && (
          <div>
            <p className="count-note" style={{ marginTop: 0 }}>{t('mclauncher.libraryHint')}</p>
            <div className="mod-toolbar">
              <button className="mini" onClick={versions.reload} disabled={versions.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              {overview?.exists && <span className="count-note">{t('mclauncher.diskUsage', { size: fmtBytes(overview.sizeBytes) })}</span>}
              <span className="count-note">{t('mclauncher.versionCount', { num: sortedVersions.length })}</span>
            </div>
            <AsyncState loading={versions.loading} error={versions.error}>
              <DataTable columns={versionCols} rows={sortedVersions} rowKey={(v) => v.Id} empty={t('mclauncher.noVersions')} />
            </AsyncState>
          </div>
        )}

        {tab === 'worlds' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={worlds.reload} disabled={worlds.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.worldCount', { num: sortedWorlds.length })}</span>
            </div>
            <AsyncState loading={worlds.loading} error={worlds.error}>
              <DataTable columns={worldCols} rows={sortedWorlds} rowKey={(w) => w.Folder} empty={t('mclauncher.noWorlds')} />
            </AsyncState>
          </div>
        )}

        {tab === 'content' && (
          <div>
            <div className="mod-toolbar">
              <select className="mod-search" value={kind} onChange={(e) => setKind(e.target.value as ContentKind)}>
                {CONTENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`mclauncher.content.${k}`)}
                  </option>
                ))}
              </select>
              <button className="mini" onClick={content.reload} disabled={content.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.itemCount', { num: sortedContent.length })}</span>
            </div>
            <AsyncState loading={content.loading} error={content.error}>
              <DataTable columns={contentCols} rows={sortedContent} rowKey={(c) => c.Name} empty={t('mclauncher.noContent')} />
            </AsyncState>
          </div>
        )}

        {tab === 'runtimes' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={runtimes.reload} disabled={runtimes.loading}>
                ⟳ {t('modules.refresh')}
              </button>
              <span className="count-note">{t('mclauncher.runtimeCount', { num: (runtimes.data ?? []).length })}</span>
            </div>
            <p className="count-note" style={{ marginTop: 0 }}>{t('mclauncher.runtimeHint')}</p>
            <AsyncState loading={runtimes.loading} error={runtimes.error}>
              <DataTable columns={runtimeCols} rows={runtimes.data ?? []} rowKey={(r, i) => r.Path + i} empty={t('mclauncher.noRuntimes')} />
            </AsyncState>
          </div>
        )}

        {tab === 'log' && (
          <div>
            <div className="mod-toolbar">
              <button className="mini" onClick={loadLog} disabled={logBusy}>
                ⟳ {t('mclauncher.reloadLog')}
              </button>
              <span className="count-note">{t('mclauncher.logHint')}</span>
            </div>
            {logLoaded ? (
              <pre className="cmd-out" style={{ maxHeight: 460, overflow: 'auto' }}>
                {logText}
              </pre>
            ) : (
              <p className="count-note">{t('modules.loading')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Backend helpers — mirror MinecraftLauncherService / MinecraftAuthService.
// All network goes through the Tauri PowerShell backend (native HttpClient →
// no CORS). PowerShell 5.1-compatible only.
// ============================================================================

// Fetch + parse version_manifest_v2 (mirrors MinecraftLauncherService.GetVersionsAsync).
async function fetchManifest(): Promise<ManifestVersion[]> {
  const script = [
    'Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue',
    '$c = New-Object System.Net.Http.HttpClient',
    '$c.Timeout = [TimeSpan]::FromSeconds(30)',
    "$json = $c.GetStringAsync('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json').GetAwaiter().GetResult()",
    '$m = $json | ConvertFrom-Json',
    '$m.versions | ForEach-Object { [pscustomobject]@{ id = [string]$_.id; type = [string]$_.type; url = [string]$_.url; releaseTime = [string]$_.releaseTime } }',
  ].join('\n');
  const rows = await runPowershellJson<ManifestVersion>(script);
  return rows.filter((r) => r && r.id);
}

// Download + verify a version's files by shelling the launch-side PowerShell.
// Mirrors InstallVersionAsync: version JSON, client jar, libraries (rules-filtered),
// asset index + objects, SHA1-verified, natives extracted. Returns true on success.
async function installVersion(versionId: string, manifest: ManifestVersion[]): Promise<boolean> {
  const ref = manifest.find((v) => v.id === versionId);
  if (!ref) return false;
  const safeUrl = ps1(ref.url);
  const safeId = ps1(versionId);
  // The heavy download runs in the backend; this script is 5.1-compatible.
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = $env:APPDATA + "\\.minecraft_winforge"
$verDir = Join-Path (Join-Path $root 'versions') '${safeId}'
New-Item -ItemType Directory -Force -Path $verDir | Out-Null
$verJsonPath = Join-Path $verDir '${safeId}.json'
$wc = New-Object System.Net.WebClient
$verJson = $wc.DownloadString('${safeUrl}')
Set-Content -LiteralPath $verJsonPath -Value $verJson -Encoding UTF8
$v = $verJson | ConvertFrom-Json

function Test-Sha1([string]$path, [string]$sha1) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  if ([string]::IsNullOrEmpty($sha1)) { return $true }
  $h = (Get-FileHash -LiteralPath $path -Algorithm SHA1).Hash.ToLower()
  return ($h -eq $sha1.ToLower())
}
function Get-File([string]$url, [string]$path, [string]$sha1) {
  if (Test-Sha1 $path $sha1) { return }
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  (New-Object System.Net.WebClient).DownloadFile($url, $path)
}

# client jar
if ($v.downloads -and $v.downloads.client) {
  Get-File $v.downloads.client.url (Join-Path $verDir '${safeId}.jar') $v.downloads.client.sha1
}
# libraries (allow Windows / no-rules only)
$libRoot = Join-Path $root 'libraries'
foreach ($lib in $v.libraries) {
  $allow = $true
  if ($lib.rules) {
    $allow = $false
    foreach ($r in $lib.rules) {
      $matches = $true
      if ($r.os -and $r.os.name) { $matches = ($r.os.name -eq 'windows') }
      if ($matches) { $allow = ($r.action -eq 'allow') }
    }
  }
  if (-not $allow) { continue }
  if ($lib.downloads -and $lib.downloads.artifact -and $lib.downloads.artifact.path) {
    $p = Join-Path $libRoot ($lib.downloads.artifact.path -replace '/', '\\')
    Get-File $lib.downloads.artifact.url $p $lib.downloads.artifact.sha1
  }
}
# asset index + objects
if ($v.assetIndex) {
  $assetsDir = Join-Path $root 'assets'
  $idxPath = Join-Path (Join-Path $assetsDir 'indexes') ($v.assetIndex.id + '.json')
  Get-File $v.assetIndex.url $idxPath $v.assetIndex.sha1
  $idx = (Get-Content -LiteralPath $idxPath -Raw) | ConvertFrom-Json
  foreach ($name in $idx.objects.PSObject.Properties.Name) {
    $hash = $idx.objects.$name.hash
    if (-not $hash -or $hash.Length -lt 2) { continue }
    $sub = $hash.Substring(0,2)
    $p = Join-Path (Join-Path (Join-Path $assetsDir 'objects') $sub) $hash
    Get-File "https://resources.download.minecraft.net/$sub/$hash" $p $hash
  }
}
'ok'`;
  const res = await runPowershell(script);
  return res.success && res.stdout.trim().endsWith('ok');
}

// Assemble the launch command (classpath + JVM + game args with \${...} substitution)
// and start java — mirrors MinecraftLauncherService.Launch. Returns "" on success or
// an error token ("version-not-installed" / "no-java" / message). Access token is
// passed to the backend inline and never logged.
async function launchGame(inst: Instance, account: Account): Promise<string> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = $env:APPDATA + "\\.minecraft_winforge"
$verId = '${ps1(inst.versionId)}'
$verDir = Join-Path (Join-Path $root 'versions') $verId
$verJsonPath = Join-Path $verDir ($verId + '.json')
if (-not (Test-Path -LiteralPath $verJsonPath)) { 'version-not-installed'; return }

# resolve java: explicit path wins, else a downloaded JRE matching javaVersion.majorVersion
$java = ''
$explicit = '${ps1(inst.javaPath)}'
if ($explicit -and (Test-Path -LiteralPath $explicit)) { $java = $explicit }
$v = (Get-Content -LiteralPath $verJsonPath -Raw) | ConvertFrom-Json
$major = 17
if ($v.javaVersion -and $v.javaVersion.majorVersion) { $major = [int]$v.javaVersion.majorVersion }
if (-not $java) {
  $rt = Join-Path $root 'runtimes'
  foreach ($cand in @((Join-Path (Join-Path (Join-Path $rt "$major") 'bin') 'javaw.exe'), (Join-Path (Join-Path (Join-Path $rt "$major") 'bin') 'java.exe'))) {
    if (Test-Path -LiteralPath $cand) { $java = $cand; break }
  }
  if (-not $java -and (Test-Path -LiteralPath $rt)) {
    $found = Get-ChildItem -LiteralPath $rt -Recurse -Filter 'javaw.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $java = $found.FullName }
  }
}
if (-not $java) { 'no-java'; return }

$gameDir = '${ps1(inst.gameDirectory)}'
if (-not $gameDir) { $gameDir = Join-Path (Join-Path $root 'instances') '${ps1(inst.id)}' }
New-Item -ItemType Directory -Force -Path $gameDir | Out-Null
$nativesDir = Join-Path $verDir 'natives'
$assetsDir = Join-Path $root 'assets'
$assetIndexId = 'legacy'
if ($v.assetIndex) { $assetIndexId = $v.assetIndex.id }
$mainClass = $v.mainClass

$libRoot = Join-Path $root 'libraries'
$cp = @()
foreach ($lib in $v.libraries) {
  $allow = $true
  if ($lib.rules) {
    $allow = $false
    foreach ($r in $lib.rules) {
      $matches = $true
      if ($r.os -and $r.os.name) { $matches = ($r.os.name -eq 'windows') }
      if ($matches) { $allow = ($r.action -eq 'allow') }
    }
  }
  if (-not $allow) { continue }
  if ($lib.downloads -and $lib.downloads.artifact -and $lib.downloads.artifact.path) {
    $p = Join-Path $libRoot ($lib.downloads.artifact.path -replace '/', '\\')
    if (Test-Path -LiteralPath $p) { $cp += $p }
  }
}
$cp += (Join-Path $verDir ($verId + '.jar'))
$classpath = ($cp -join ';')

$subst = @{
  'auth_player_name' = '${ps1(account.name)}'
  'auth_uuid' = '${ps1(account.uuid)}'
  'auth_access_token' = '${ps1(account.accessToken)}'
  'auth_xuid' = ''
  'clientid' = ''
  'user_type' = '${account.isOffline ? 'legacy' : 'msa'}'
  'user_properties' = '{}'
  'version_name' = $verId
  'version_type' = [string]$v.type
  'game_directory' = $gameDir
  'assets_root' = $assetsDir
  'game_assets' = $assetsDir
  'assets_index_name' = $assetIndexId
  'natives_directory' = $nativesDir
  'classpath' = $classpath
  'launcher_name' = 'WinForge'
  'launcher_version' = '1.0'
}
function Sub([string]$s) {
  foreach ($k in $subst.Keys) { $s = $s.Replace('\${' + $k + '}', [string]$subst[$k]) }
  return $s
}
$jargs = New-Object System.Collections.Generic.List[string]
if ($v.arguments -and $v.arguments.jvm) {
  foreach ($el in $v.arguments.jvm) {
    if ($el -is [string]) { $jargs.Add((Sub $el)) }
    elseif ($el.value) {
      if ($el.value -is [string]) { $jargs.Add((Sub $el.value)) }
      else { foreach ($vv in $el.value) { if ($vv -is [string]) { $jargs.Add((Sub $vv)) } } }
    }
  }
} else {
  $jargs.Add("-Djava.library.path=$nativesDir")
  $jargs.Add('-cp'); $jargs.Add($classpath)
}
$jargs.Add('-Xmx${Math.max(512, inst.maxMemoryMb)}M')
$jargs.Add('-Xms${Math.max(256, inst.minMemoryMb)}M')
$extra = '${ps1(inst.extraJvmArgs)}'
if ($extra) { foreach ($a in ($extra -split '\\s+')) { if ($a) { $jargs.Add($a) } } }
$jargs.Add([string]$mainClass)
if ($v.arguments -and $v.arguments.game) {
  foreach ($el in $v.arguments.game) {
    if ($el -is [string]) { $jargs.Add((Sub $el)) }
    elseif ($el.value) {
      if ($el.value -is [string]) { $jargs.Add((Sub $el.value)) }
      else { foreach ($vv in $el.value) { if ($vv -is [string]) { $jargs.Add((Sub $vv)) } } }
    }
  }
} elseif ($v.minecraftArguments) {
  foreach ($tok in ($v.minecraftArguments -split ' ')) { if ($tok) { $jargs.Add((Sub $tok)) } }
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $java
$psi.WorkingDirectory = $gameDir
$psi.UseShellExecute = $false
foreach ($a in $jargs) { [void]$psi.ArgumentList.Add($a) }
[void][System.Diagnostics.Process]::Start($psi)
'ok'`;
  const res = await runPowershell(script);
  const out = res.stdout.trim();
  if (out.endsWith('ok')) return '';
  if (out.includes('version-not-installed')) return 'version-not-installed';
  if (out.includes('no-java')) return 'no-java';
  return res.stderr.trim() || out || 'launch-failed';
}

// The full device-code auth chain (MSA → XBL → XSTS → Minecraft) through the backend.
// Returns an Account (+ refreshToken) on success, an error token string on chain
// failure, or null when cancelled. Tokens are never logged; only the refresh token is
// returned for masked persistence — access token lives in the returned account only.
interface AuthAccount extends Account {
  refreshToken: string;
}

async function runDeviceCodeChain(
  clientId: string,
  onPrompt: (p: { code: string; uri: string }) => void,
  cancelled: () => boolean,
): Promise<AuthAccount | string | null> {
  const cid = ps1(clientId);
  // 1) Request the device + user code.
  const startScript = [
    'Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue',
    '$c = New-Object System.Net.Http.HttpClient',
    '$d = [System.Collections.Generic.Dictionary[string,string]]::new()',
    `$d.Add('client_id','${cid}')`,
    "$d.Add('scope','XboxLive.signin offline_access')",
    '$body = New-Object System.Net.Http.FormUrlEncodedContent($d)',
    "$resp = $c.PostAsync('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', $body).GetAwaiter().GetResult()",
    '$txt = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()',
    '$j = $txt | ConvertFrom-Json',
    '[pscustomobject]@{ device_code = [string]$j.device_code; user_code = [string]$j.user_code; verification_uri = [string]$j.verification_uri; interval = [int]$j.interval; expires_in = [int]$j.expires_in; error = [string]$j.error }',
  ].join('\n');
  const startRows = await runPowershellJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
    error: string;
  }>(startScript);
  const start = startRows[0];
  if (!start || !start.device_code) return start?.error || 'devicecode';
  onPrompt({ code: start.user_code, uri: start.verification_uri });

  // 2) Poll for the MSA token.
  const interval = Math.max(1, start.interval || 5);
  const deadline = Date.now() + (start.expires_in || 900) * 1000;
  let msRefresh = '';
  let msAccess = '';
  while (Date.now() < deadline) {
    if (cancelled()) return null;
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (cancelled()) return null;
    const pollScript = [
      'Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue',
      '$c = New-Object System.Net.Http.HttpClient',
      '$d = [System.Collections.Generic.Dictionary[string,string]]::new()',
      `$d.Add('client_id','${cid}')`,
      "$d.Add('grant_type','urn:ietf:params:oauth:grant-type:device_code')",
      `$d.Add('device_code','${ps1(start.device_code)}')`,
      '$body = New-Object System.Net.Http.FormUrlEncodedContent($d)',
      "$resp = $c.PostAsync('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', $body).GetAwaiter().GetResult()",
      '$txt = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()',
      '$j = $txt | ConvertFrom-Json',
      '[pscustomobject]@{ ok = [bool]$resp.IsSuccessStatusCode; access_token = [string]$j.access_token; refresh_token = [string]$j.refresh_token; error = [string]$j.error }',
    ].join('\n');
    const pollRows = await runPowershellJson<{ ok: boolean; access_token: string; refresh_token: string; error: string }>(pollScript);
    const p = pollRows[0];
    if (!p) return 'devicecode';
    if (p.ok && p.access_token) {
      msAccess = p.access_token;
      msRefresh = p.refresh_token;
      break;
    }
    if (p.error === 'authorization_pending' || p.error === 'slow_down') continue;
    if (p.error) return p.error;
  }
  if (!msAccess) return 'expired_token';

  // 3) Complete the chain: XBL → XSTS → Minecraft → entitlements + profile.
  return completeChain(msAccess, msRefresh);
}

// Runs the MSA-access → XBL → XSTS → Minecraft → profile chain in a single backend
// call (mirrors MinecraftAuthService.CompleteChainAsync). Access/XSTS tokens stay
// inside the backend process; only uuid/name/access_token/refresh come back.
async function completeChain(msAccess: string, msRefresh: string): Promise<AuthAccount | string> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
$c = New-Object System.Net.Http.HttpClient
function Post-Json([string]$url, $obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
  $r = $c.PostAsync($url, $content).GetAwaiter().GetResult()
  $t = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return @{ ok = $r.IsSuccessStatusCode; code = [int]$r.StatusCode; body = $t }
}
# XBL
$xblReq = @{ Properties = @{ AuthMethod = 'RPS'; SiteName = 'user.auth.xboxlive.com'; RpsTicket = ('d=' + '${ps1(msAccess)}') }; RelyingParty = 'http://auth.xboxlive.com'; TokenType = 'JWT' }
$xbl = Post-Json 'https://user.auth.xboxlive.com/user/authenticate' $xblReq
if (-not $xbl.ok) { [pscustomobject]@{ error = ('xbl ' + $xbl.code) } | ConvertTo-Json -Compress; return }
$xblJson = $xbl.body | ConvertFrom-Json
$xblToken = $xblJson.Token
# XSTS
$xstsReq = @{ Properties = @{ SandboxId = 'RETAIL'; UserTokens = @($xblToken) }; RelyingParty = 'rp://api.minecraftservices.com/'; TokenType = 'JWT' }
$xsts = Post-Json 'https://xsts.auth.xboxlive.com/xsts/authorize' $xstsReq
if (-not $xsts.ok) {
  $xerr = ''
  try { $xerr = ($xsts.body | ConvertFrom-Json).XErr } catch {}
  [pscustomobject]@{ error = ([string]$xerr) } | ConvertTo-Json -Compress; return
}
$xstsJson = $xsts.body | ConvertFrom-Json
$xstsToken = $xstsJson.Token
$uhs = $xstsJson.DisplayClaims.xui[0].uhs
# Minecraft login
$mcReq = @{ identityToken = ('XBL3.0 x=' + $uhs + ';' + $xstsToken) }
$mc = Post-Json 'https://api.minecraftservices.com/authentication/login_with_xbox' $mcReq
if (-not $mc.ok) { [pscustomobject]@{ error = ('mc-login ' + $mc.code) } | ConvertTo-Json -Compress; return }
$mcToken = ($mc.body | ConvertFrom-Json).access_token
# Profile
$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, 'https://api.minecraftservices.com/minecraft/profile')
$req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $mcToken)
$pr = $c.SendAsync($req).GetAwaiter().GetResult()
if ([int]$pr.StatusCode -eq 404) { [pscustomobject]@{ error = 'no-game' } | ConvertTo-Json -Compress; return }
$pbody = $pr.Content.ReadAsStringAsync().GetAwaiter().GetResult()
$pj = $pbody | ConvertFrom-Json
if (-not $pj.id) { [pscustomobject]@{ error = 'no-game' } | ConvertTo-Json -Compress; return }
[pscustomobject]@{ error = ''; uuid = [string]$pj.id; name = [string]$pj.name; access = [string]$mcToken } | ConvertTo-Json -Compress`;
  const res = await runPowershell(script);
  const text = res.stdout.trim();
  if (!text) return res.stderr.trim() || 'mc-login';
  let obj: { error?: string; uuid?: string; name?: string; access?: string };
  try {
    obj = JSON.parse(text);
  } catch {
    return 'mc-login';
  }
  if (obj.error) return obj.error;
  if (!obj.uuid || !obj.name) return 'no-game';
  return {
    uuid: obj.uuid,
    name: obj.name,
    accessToken: obj.access ?? '',
    ownsGame: true,
    isOffline: false,
    refreshToken: msRefresh,
  };
}

// Bilingual chain-error → message (mirrors MinecraftAuthService.DescribeError).
function describeAuthError(error: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (error) {
    case 'no-client-id':
      return t('mclauncher.errNoClientId');
    case '2148916233':
      return t('mclauncher.errNoXbox');
    case '2148916235':
      return t('mclauncher.errRegion');
    case '2148916236':
    case '2148916237':
      return t('mclauncher.errAdult');
    case '2148916238':
      return t('mclauncher.errChild');
    case 'no-game':
      return t('mclauncher.errNoGame');
    case 'Cancelled':
      return t('mclauncher.errCancelled');
    default:
      return t('mclauncher.errGeneric', { error });
  }
}

function describeLaunchError(error: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (error === 'no-java') return t('mclauncher.errNoJava');
  if (error === 'version-not-installed') return t('mclauncher.errNotInstalled');
  return `${t('mclauncher.launchFailed')}: ${error}`;
}
