import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';
import { pick } from '../i18n';

// Native module — full UniGetUI-style Package Manager hub over ELEVEN engines
// (winget, Scoop, Chocolatey, pip, npm, .NET tools, PowerShell Gallery, PowerShell 7
// PSResource, Cargo, Bun and vcpkg), ported from WinForge PackageManagerModule.xaml(.cs)
// + PackageManagers/SourceManager/IgnoredUpdates/BundleService/PackageService.
// Eight sub-tabs: Discover / Updates / Installed / Bundles / Sources / Ignored / Setup /
// Settings. Reads (probe, search, list) auto-run; every install/update/uninstall/source
// mutation runs only on explicit click, destructive ones behind an inline confirm.
// All shell lines are Windows PowerShell 5.1-compatible; ignore pins persist in localStorage.

type Op = 'install' | 'uninstall' | 'update';

interface Pkg {
  name: string;
  id: string;
  version: string;
  avail: string; // newer version when this row is an update
  source: string;
  mgr: string;
}

interface Pin {
  manager: string;
  id: string;
  version: string; // '*' = all versions
  pauseUntil: string | null; // yyyy-MM-dd
}

interface SourceRow {
  mgr: string;
  name: string;
  url: string;
  count?: string;
  updated?: string;
  synthetic?: boolean;
}

interface MgrDef {
  key: string;
  en: string;
  zh: string;
  cli: string; // probed executable
  canSearch: boolean;
  canUpdates: boolean;
  bootstrapId?: string; // winget id used to install the engine
  bootstrapScript?: string; // PS 5.1 script when there is no winget id
  bootstrapAdmin?: boolean;
}

// Fixed display order mirrors PackageManagerRegistry.All.
const MANAGERS: MgrDef[] = [
  { key: 'winget', en: 'Windows Package Manager', zh: 'Windows 套件管理員', cli: 'winget', canSearch: true, canUpdates: true },
  {
    key: 'scoop', en: 'Scoop', zh: 'Scoop', cli: 'scoop', canSearch: true, canUpdates: true,
    bootstrapScript:
      "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression",
  },
  {
    key: 'choco', en: 'Chocolatey', zh: 'Chocolatey', cli: 'choco', canSearch: true, canUpdates: true, bootstrapAdmin: true,
    bootstrapScript:
      "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = 3072; Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
  },
  { key: 'pip', en: 'pip (Python)', zh: 'pip（Python）', cli: 'pip', canSearch: false, canUpdates: true, bootstrapId: 'Python.Python.3.12' },
  { key: 'npm', en: 'npm (Node global)', zh: 'npm（Node 全域）', cli: 'npm', canSearch: true, canUpdates: true, bootstrapId: 'OpenJS.NodeJS.LTS' },
  { key: 'dotnet', en: '.NET Tools', zh: '.NET 工具', cli: 'dotnet', canSearch: true, canUpdates: false, bootstrapId: 'Microsoft.DotNet.SDK.9' },
  { key: 'psgallery', en: 'PowerShell Gallery', zh: 'PowerShell 資源庫', cli: 'powershell', canSearch: true, canUpdates: false },
  { key: 'pwsh7', en: 'PowerShell 7 (PSResource)', zh: 'PowerShell 7（PSResource）', cli: 'pwsh', canSearch: true, canUpdates: false, bootstrapId: 'Microsoft.PowerShell' },
  { key: 'cargo', en: 'Cargo (Rust)', zh: 'Cargo（Rust）', cli: 'cargo', canSearch: true, canUpdates: false, bootstrapId: 'Rustlang.Rustup' },
  { key: 'bun', en: 'Bun (global)', zh: 'Bun（全域）', cli: 'bun', canSearch: true, canUpdates: false, bootstrapId: 'Oven-sh.Bun' },
  { key: 'vcpkg', en: 'vcpkg', zh: 'vcpkg', cli: 'vcpkg', canSearch: true, canUpdates: false },
];

// Curated common winget dependencies (PackageService.Deps).
const DEPS: { en: string; zh: string; id: string }[] = [
  { en: 'FFmpeg (media engine)', zh: 'FFmpeg（媒體引擎）', id: 'Gyan.FFmpeg' },
  { en: '7-Zip', zh: '7-Zip', id: '7zip.7zip' },
  { en: 'Git', zh: 'Git', id: 'Git.Git' },
  { en: 'Android Platform Tools (adb / fastboot)', zh: 'Android 平台工具（adb／fastboot）', id: 'Google.PlatformTools' },
  { en: 'scrcpy (screen mirror)', zh: 'scrcpy（螢幕鏡像）', id: 'Genymobile.scrcpy' },
  { en: 'Python 3', zh: 'Python 3', id: 'Python.Python.3.12' },
  { en: 'Node.js LTS', zh: 'Node.js LTS', id: 'OpenJS.NodeJS.LTS' },
  { en: 'PowerShell 7', zh: 'PowerShell 7', id: 'Microsoft.PowerShell' },
  { en: 'Windows Terminal', zh: 'Windows 終端機', id: 'Microsoft.WindowsTerminal' },
  { en: 'VLC media player', zh: 'VLC 播放器', id: 'VideoLAN.VLC' },
  { en: 'Notepad++', zh: 'Notepad++', id: 'Notepad++.Notepad++' },
  { en: 'Docker Desktop', zh: 'Docker Desktop', id: 'Docker.DockerDesktop' },
  { en: 'VeraCrypt (encryption)', zh: 'VeraCrypt（加密）', id: 'IDRIX.VeraCrypt' },
  { en: 'SQL Server Management Studio (SSMS)', zh: 'SQL Server 管理工具（SSMS）', id: 'Microsoft.SQLServerManagementStudio' },
];

// Curated known sources per manager (SourceManager.KnownSources).
const KNOWN_SOURCES: Record<string, { name: string; url: string }[]> = {
  winget: [
    { name: 'winget', url: 'https://cdn.winget.microsoft.com/cache' },
    { name: 'msstore', url: 'https://storeedgefd.dsx.mp.microsoft.com/v9.0' },
  ],
  scoop: [
    { name: 'main', url: 'https://github.com/ScoopInstaller/Main' },
    { name: 'extras', url: 'https://github.com/ScoopInstaller/Extras' },
    { name: 'versions', url: 'https://github.com/ScoopInstaller/Versions' },
    { name: 'nerd-fonts', url: 'https://github.com/matthewjberger/scoop-nerd-fonts' },
    { name: 'java', url: 'https://github.com/ScoopInstaller/Java' },
    { name: 'nonportable', url: 'https://github.com/ScoopInstaller/Nonportable' },
    { name: 'games', url: 'https://github.com/Calinou/scoop-games' },
    { name: 'sysinternals', url: 'https://github.com/niheaven/scoop-sysinternals' },
  ],
  choco: [{ name: 'chocolatey', url: 'https://community.chocolatey.org/api/v2/' }],
  dotnet: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json' }],
  psgallery: [
    { name: 'PSGallery', url: 'https://www.powershellgallery.com/api/v2' },
    { name: 'NuGet', url: 'https://api.nuget.org/v3/index.json' },
  ],
  pwsh7: [
    { name: 'PSGallery', url: 'https://www.powershellgallery.com/api/v2' },
    { name: 'NuGetGallery', url: 'https://api.nuget.org/v3/index.json' },
  ],
};

const SRC_ADD_REMOVE = new Set(['winget', 'scoop', 'choco', 'dotnet', 'psgallery', 'pwsh7']);
const SRC_REFRESH = new Set(['winget', 'scoop']);
const SRC_ADMIN = new Set(['winget', 'choco']);

// ===== localStorage-backed settings & ignore pins =====

const LS = {
  pins: 'winforge.pkg.ignored.v2',
  mode: 'winforge.pkg.search.mode',
  caseS: 'winforge.pkg.search.caseSensitive',
  special: 'winforge.pkg.search.ignoreSpecial',
  ignoreNa: 'winforge.pkg.ignore.notapplicable',
};

function lsGet(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best effort */
  }
}

function pinExpired(p: Pin): boolean {
  if (!p.pauseUntil) return false;
  const until = new Date(`${p.pauseUntil}T23:59:59`);
  return !Number.isNaN(until.getTime()) && until.getTime() < Date.now();
}

function loadPins(): Pin[] {
  try {
    const raw = JSON.parse(lsGet(LS.pins, '[]')) as unknown;
    if (!Array.isArray(raw)) return [];
    const pins = raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        manager: typeof p.manager === 'string' ? p.manager : '',
        id: typeof p.id === 'string' ? p.id : '',
        version: typeof p.version === 'string' && p.version ? p.version : '*',
        pauseUntil: typeof p.pauseUntil === 'string' && p.pauseUntil ? p.pauseUntil : null,
      }))
      .filter((p) => p.id !== '' && !pinExpired(p));
    savePins(pins);
    return pins;
  } catch {
    return [];
  }
}
function savePins(pins: Pin[]): void {
  lsSet(LS.pins, JSON.stringify(pins));
}

/** Upsert one pin — replaces any prior pin for the same manager|id (IgnoredUpdates.Upsert). */
function upsertPin(pins: Pin[], pin: Pin): Pin[] {
  const next = pins.filter(
    (p) => !(p.manager.toLowerCase() === pin.manager.toLowerCase() && p.id.toLowerCase() === pin.id.toLowerCase()),
  );
  next.push(pin);
  savePins(next);
  return next;
}

/** Does any live pin cover this update row (IgnoredUpdates.IsIgnored)? */
function isIgnored(pins: Pin[], p: Pkg): boolean {
  const offered = (p.avail || p.version || '').trim().toLowerCase();
  return pins.some(
    (pin) =>
      !pinExpired(pin) &&
      pin.manager.toLowerCase() === p.mgr.toLowerCase() &&
      pin.id.toLowerCase() === p.id.toLowerCase() &&
      (pin.version === '*' || pin.version.toLowerCase() === offered),
  );
}

// ===== PowerShell 5.1 plumbing =====

const PRE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; ";

/** Read-only capture: stdout text, '' on any failure (never throws). */
async function cap(script: string): Promise<string> {
  if (!isTauri()) return '';
  try {
    const r = await runPowershell(PRE + script);
    return r.stdout || '';
  } catch {
    return '';
  }
}

/** Mutation runner: success flag + combined output (never throws). Keeps the default
 *  ErrorActionPreference (native stderr must not abort) and propagates native exit codes. */
async function runOp(script: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await runPowershell(
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
    );
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    // Benign winget results count as success (PackageService.InterpretWinget).
    const benign = /already installed|No newer package versions|No available upgrade|Successfully installed|已成功安裝/i.test(out);
    return { ok: r.success || benign, out };
  } catch (e) {
    return { ok: false, out: String(e instanceof Error ? e.message : e) };
  }
}

/** Strip characters that could break a shell line (PkgParse.Q + extras). */
const san = (s: string): string => s.replace(/["'`$;|&<>]/g, '').trim();

const lines = (s: string): string[] => (s ? s.replace(/\r/g, '').split('\n') : []);

function sliceJson(raw: string, open: '[' | '{'): string {
  const close = open === '[' ? ']' : '}';
  const a = raw.indexOf(open);
  const b = raw.lastIndexOf(close);
  return a >= 0 && b > a ? raw.slice(a, b + 1) : open === '[' ? '[]' : '{}';
}
function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function str(o: unknown, k: string): string {
  if (o && typeof o === 'object' && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

// ===== parsers (ports of PackageManagers.cs, defensive, never throw) =====

/** winget's fixed-width table, cut by header column offsets. */
function parseWingetTable(text: string): Pkg[] {
  const out: Pkg[] = [];
  const ls = lines(text);
  let hdr = -1;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? '';
    if (l.includes('Id') && l.includes('Version')) {
      hdr = i;
      break;
    }
  }
  if (hdr < 0 || hdr + 2 > ls.length) return out;
  const h = ls[hdr] ?? '';
  const idCol = h.indexOf('Id');
  const verCol = h.indexOf('Version');
  const availCol = h.indexOf('Available');
  const matchCol = h.indexOf('Match');
  const srcCol = h.indexOf('Source');
  const min4 = (a: number, b: number, c: number, d: number): number => {
    let m = d;
    if (a > 0) m = Math.min(m, a);
    if (b > 0) m = Math.min(m, b);
    if (c > 0) m = Math.min(m, c);
    return m;
  };
  const endVer = min4(availCol, matchCol, srcCol, h.length);
  const cut = (ln: string, a: number, b: number): string => {
    if (a < 0 || a >= ln.length) return '';
    const e = Math.min(b, ln.length);
    return e > a ? ln.slice(a, e).trim() : '';
  };
  for (let i = hdr + 2; i < ls.length; i++) {
    const ln = ls[i] ?? '';
    if (!ln.trim() || ln.trimStart().startsWith('---')) continue;
    const id = cut(ln, idCol, verCol);
    if (!id || id.includes(' ')) continue;
    out.push({
      name: cut(ln, 0, idCol),
      id,
      version: cut(ln, verCol, endVer),
      avail: availCol > 0 ? cut(ln, availCol, min4(matchCol, srcCol, -1, ln.length)) : '',
      source: srcCol > 0 && srcCol < ln.length ? ln.slice(srcCol).trim() : '',
      mgr: 'winget',
    });
  }
  return out;
}

const ws = (s: string): string[] => s.split(/[ \t]+/).filter((x) => x.length > 0);

function parseScoopSearch(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith('Name') || ln.startsWith('---') || ln.startsWith('Results')) continue;
    const parts = ws(ln);
    const name = parts[0] ?? '';
    if (!name || name.includes("'") || name.includes(':')) continue;
    let ver = parts[1] ?? '';
    if (ver.startsWith('(')) ver = ver.replace(/[()]/g, '');
    out.push({ name, id: name, version: ver, avail: '', source: parts[2] ?? '', mgr: 'scoop' });
  }
  return out;
}

function parseScoopStatus(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (
      !ln || ln.startsWith('Name') || ln.startsWith('---') || ln.startsWith('Scoop') ||
      ln.startsWith('Everything') || ln.startsWith('WARN') || ln.startsWith('Updates')
    )
      continue;
    const parts = ws(ln);
    if (parts.length < 3) continue;
    out.push({ name: parts[0] ?? '', id: parts[0] ?? '', version: parts[1] ?? '', avail: parts[2] ?? '', source: '', mgr: 'scoop' });
  }
  return out.filter((p) => p.id);
}

function parseScoopInstalled(exportJson: string, listText: string): Pkg[] {
  const out: Pkg[] = [];
  const root = tryJson(sliceJson(exportJson, '{'));
  const apps = root && typeof root === 'object' && Array.isArray((root as { apps?: unknown }).apps)
    ? ((root as { apps: unknown[] }).apps)
    : Array.isArray(tryJson(sliceJson(exportJson, '[')))
      ? (tryJson(sliceJson(exportJson, '[')) as unknown[])
      : [];
  for (const el of apps) {
    const name = str(el, 'Name') || str(el, 'name');
    if (!name) continue;
    out.push({
      name,
      id: name,
      version: str(el, 'Version') || str(el, 'version'),
      avail: '',
      source: str(el, 'Source') || str(el, 'Bucket'),
      mgr: 'scoop',
    });
  }
  if (out.length > 0) return out;
  for (const raw of lines(listText)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith('Name') || ln.startsWith('---') || ln.startsWith('Installed')) continue;
    const parts = ws(ln);
    if (parts.length < 2) continue;
    out.push({ name: parts[0] ?? '', id: parts[0] ?? '', version: parts[1] ?? '', avail: '', source: parts[2] ?? '', mgr: 'scoop' });
  }
  return out.filter((p) => p.id);
}

/** Chocolatey --limit-output "id|ver(|avail)" rows. */
function parsePipes(text: string, mgr: string, hasAvail: boolean): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln || !ln.includes('|')) continue;
    const parts = ln.split('|');
    const id = (parts[0] ?? '').trim();
    if (!id) continue;
    if (hasAvail && parts.length < 3) continue;
    out.push({
      name: id,
      id,
      version: (parts[1] ?? '').trim(),
      avail: hasAvail ? (parts[2] ?? '').trim() : '',
      source: '',
      mgr,
    });
  }
  return out;
}

function parseNameVersionJson(raw: string, mgr: string, nameKeys: string[], verKey: string, availKey?: string): Pkg[] {
  const out: Pkg[] = [];
  const parsed = tryJson(sliceJson(raw, '[')) ?? tryJson(sliceJson(raw, '{'));
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  for (const el of arr) {
    let name = '';
    for (const k of nameKeys) {
      name = str(el, k);
      if (name) break;
    }
    if (!name) continue;
    out.push({ name, id: name, version: str(el, verKey), avail: availKey ? str(el, availKey) : '', source: '', mgr });
  }
  return out;
}

/** npm ls / npm outdated -g --json object maps. */
function parseNpmObject(raw: string, mode: 'ls' | 'outdated'): Pkg[] {
  const out: Pkg[] = [];
  const root = tryJson(sliceJson(raw, '{'));
  if (!root || typeof root !== 'object') return out;
  const map = mode === 'ls' ? (root as { dependencies?: unknown }).dependencies : root;
  if (!map || typeof map !== 'object') return out;
  for (const [name, v] of Object.entries(map as Record<string, unknown>)) {
    if (!name) continue;
    out.push({
      name,
      id: name,
      version: mode === 'ls' ? str(v, 'version') : str(v, 'current'),
      avail: mode === 'ls' ? '' : str(v, 'latest'),
      source: '',
      mgr: 'npm',
    });
  }
  return out;
}

/** dotnet tool tables: skip to the '---' rule, split on 2+ spaces. */
function parseDotnetTable(text: string): Pkg[] {
  const out: Pkg[] = [];
  let past = false;
  for (const raw of lines(text)) {
    const ln = raw.trimEnd();
    if (!ln.trim()) continue;
    if (!past) {
      if (ln.trimStart().startsWith('---')) past = true;
      continue;
    }
    const parts = ln.split(/ {2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
    const name = parts[0] ?? '';
    if (!name) continue;
    out.push({ name, id: name, version: parts[1] ?? '', avail: '', source: '', mgr: 'dotnet' });
  }
  return out;
}

/** cargo search: name = "ver"  # desc. */
function parseCargoSearch(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln) continue;
    const eq = ln.indexOf('=');
    if (eq <= 0) continue;
    const name = ln.slice(0, eq).trim();
    if (!name || name.includes(' ')) continue;
    const rest = ln.slice(eq + 1);
    const m = rest.match(/"([^"]*)"/);
    out.push({ name, id: name, version: m?.[1] ?? '', avail: '', source: '', mgr: 'cargo' });
  }
  return out;
}

/** cargo install --list: unindented "name vX.Y.Z:" lines. */
function parseCargoInstalled(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    if (!raw || /^\s/.test(raw)) continue;
    const ln = raw.trim().replace(/:$/, '');
    if (!ln) continue;
    const parts = ws(ln);
    const name = parts[0] ?? '';
    if (!name) continue;
    out.push({ name, id: name, version: (parts[1] ?? '').replace(/^v/, ''), avail: '', source: '', mgr: 'cargo' });
  }
  return out;
}

/** bun pm ls -g: tree lines "name@version". */
function parseBunList(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim().replace(/^[├└─│\s]+/, '');
    if (!ln || ln.startsWith('/') || ln.includes('node_modules')) continue;
    const at = ln.lastIndexOf('@');
    const name = at > 0 ? ln.slice(0, at).trim() : ln;
    const ver = at > 0 ? ln.slice(at + 1).trim() : '';
    if (!name || name.includes(' ')) continue;
    out.push({ name, id: name, version: ver, avail: '', source: '', mgr: 'bun' });
  }
  return out;
}

function parseVcpkgLines(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith('The result')) continue;
    const parts = ws(ln);
    const name = parts[0] ?? '';
    if (!name) continue;
    out.push({ name, id: name, version: parts[1] ?? '', avail: '', source: '', mgr: 'vcpkg' });
  }
  return out;
}

// ===== per-manager fetchers (reads) =====

const W400 = ' | Out-String -Width 400';

async function searchMgr(key: string, query: string): Promise<Pkg[]> {
  const q = san(query);
  switch (key) {
    case 'winget':
      return parseWingetTable(await cap(`winget search --query "${q}" --accept-source-agreements --disable-interactivity${W400}`));
    case 'scoop':
      return parseScoopSearch(await cap(`scoop search ${q}${W400}`));
    case 'choco':
      return parsePipes(await cap(`choco search ${q} --limit-output`), 'choco', false);
    case 'pip':
      return []; // modern pip no longer supports search
    case 'npm':
      return parseNameVersionJson(await cap(`npm search ${q} --json`), 'npm', ['name'], 'version');
    case 'dotnet':
      return parseDotnetTable(await cap(`dotnet tool search ${q}`));
    case 'psgallery':
      return parseNameVersionJson(
        await cap(`Find-Module -Name *${q}* -ErrorAction SilentlyContinue | Select-Object Name,Version | ConvertTo-Json -Compress`),
        'psgallery', ['Name', 'name'], 'Version',
      );
    case 'pwsh7':
      return parseNameVersionJson(
        await cap(`pwsh -NoProfile -NonInteractive -Command "Find-PSResource -Name *${q}* -ErrorAction SilentlyContinue | Select-Object Name,Version | ConvertTo-Json -Compress"`),
        'pwsh7', ['Name', 'name'], 'Version',
      );
    case 'cargo':
      return parseCargoSearch(await cap(`cargo search ${q}`));
    case 'bun':
      return parseNameVersionJson(await cap(`npm search ${q} --json`), 'bun', ['name'], 'version').map((p) => ({
        ...p,
        source: 'npmjs.org',
      }));
    case 'vcpkg':
      return parseVcpkgLines(await cap(`vcpkg search ${q}`));
    default:
      return [];
  }
}

async function installedMgr(key: string): Promise<Pkg[]> {
  switch (key) {
    case 'winget':
      return parseWingetTable(await cap(`winget list --accept-source-agreements --disable-interactivity${W400}`));
    case 'scoop':
      return parseScoopInstalled(await cap('scoop export'), await cap(`scoop list${W400}`));
    case 'choco':
      // choco v1 needs --local-only for a local list; v2 removed the flag (list is local-only).
      return parsePipes(
        await cap('choco list --local-only --limit-output 2>$null; if ($LASTEXITCODE -ne 0) { choco list --limit-output }'),
        'choco',
        false,
      );
    case 'pip':
      return parseNameVersionJson(await cap('pip list --format=json'), 'pip', ['name'], 'version');
    case 'npm':
      return parseNpmObject(await cap('npm ls -g --depth=0 --json'), 'ls');
    case 'dotnet':
      return parseDotnetTable(await cap('dotnet tool list -g'));
    case 'psgallery':
      return parseNameVersionJson(
        await cap('Get-InstalledModule -ErrorAction SilentlyContinue | Select-Object Name,Version | ConvertTo-Json -Compress'),
        'psgallery', ['Name', 'name'], 'Version',
      );
    case 'pwsh7':
      return parseNameVersionJson(
        await cap('pwsh -NoProfile -NonInteractive -Command "Get-InstalledPSResource -ErrorAction SilentlyContinue | Select-Object Name,Version | ConvertTo-Json -Compress"'),
        'pwsh7', ['Name', 'name'], 'Version',
      );
    case 'cargo':
      return parseCargoInstalled(await cap('cargo install --list'));
    case 'bun':
      return parseBunList(await cap('bun pm ls -g'));
    case 'vcpkg':
      return parseVcpkgLines(await cap('vcpkg list'));
    default:
      return [];
  }
}

async function updatesMgr(key: string): Promise<Pkg[]> {
  switch (key) {
    case 'winget':
      return parseWingetTable(await cap(`winget upgrade --accept-source-agreements --disable-interactivity${W400}`)).filter(
        (p) => p.avail,
      );
    case 'scoop':
      return parseScoopStatus(await cap(`scoop status${W400}`));
    case 'choco':
      return parsePipes(await cap('choco outdated --limit-output'), 'choco', true);
    case 'pip':
      return parseNameVersionJson(await cap('pip list --outdated --format=json'), 'pip', ['name'], 'version', 'latest_version');
    case 'npm':
      return parseNpmObject(await cap('npm outdated -g --json'), 'outdated');
    default:
      return []; // dotnet / psgallery / pwsh7 / cargo / bun / vcpkg: no cheap outdated
  }
}

async function fetchAcross(keys: string[], fn: (key: string) => Promise<Pkg[]>): Promise<Pkg[]> {
  const batches = await Promise.all(
    keys.map(async (k) => {
      try {
        return await fn(k);
      } catch {
        return [];
      }
    }),
  );
  return batches.flat();
}

// ===== mutation command builders (ports of the C# managers' verbs) =====

function opCmd(mgr: string, rawId: string, op: Op): string {
  const id = san(rawId);
  switch (mgr) {
    case 'winget':
      return op === 'install'
        ? `winget install --id "${id}" -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity`
        : op === 'uninstall'
          ? `winget uninstall --id "${id}" -e --silent --disable-interactivity`
          : `winget upgrade --id "${id}" -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity`;
    case 'scoop':
      return op === 'install' ? `scoop install ${id}` : op === 'uninstall' ? `scoop uninstall ${id}` : `scoop update ${id}`;
    case 'choco':
      return op === 'install' ? `choco install ${id} -y` : op === 'uninstall' ? `choco uninstall ${id} -y` : `choco upgrade ${id} -y`;
    case 'pip':
      return op === 'install' ? `pip install ${id}` : op === 'uninstall' ? `pip uninstall -y ${id}` : `pip install --upgrade ${id}`;
    case 'npm':
      return op === 'install' ? `npm install -g ${id}` : op === 'uninstall' ? `npm uninstall -g ${id}` : `npm install -g ${id}@latest`;
    case 'dotnet':
      return op === 'install'
        ? `dotnet tool install -g ${id}`
        : op === 'uninstall'
          ? `dotnet tool uninstall -g ${id}`
          : `dotnet tool update -g ${id}`;
    case 'psgallery':
      return op === 'install'
        ? `Install-Module -Name ${id} -Force -Scope CurrentUser`
        : op === 'uninstall'
          ? `Uninstall-Module -Name ${id}`
          : `Update-Module -Name ${id}`;
    case 'pwsh7': {
      const inner =
        op === 'install'
          ? `Install-PSResource -Name ${id} -TrustRepository -Scope CurrentUser`
          : op === 'uninstall'
            ? `Uninstall-PSResource -Name ${id}`
            : `Update-PSResource -Name ${id} -TrustRepository`;
      return `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${inner}"`;
    }
    case 'cargo':
      return op === 'install' ? `cargo install ${id}` : op === 'uninstall' ? `cargo uninstall ${id}` : `cargo install ${id} --force`;
    case 'bun':
      return op === 'install' ? `bun add -g ${id}` : op === 'uninstall' ? `bun remove -g ${id}` : `bun add -g ${id}@latest`;
    case 'vcpkg':
      return op === 'install' ? `vcpkg install ${id}` : op === 'uninstall' ? `vcpkg remove ${id}` : `vcpkg upgrade ${id} --no-dry-run`;
    default:
      return '';
  }
}

/** Full package details command (PackageManagerRegistry.DetailsAsync). */
function detailsCmd(mgr: string, rawId: string): string {
  const id = san(rawId);
  switch (mgr) {
    case 'winget':
      return `winget show --id "${id}" -e --accept-source-agreements --disable-interactivity | Out-String -Width 200`;
    case 'scoop':
      return `scoop info ${id} | Out-String -Width 200`;
    case 'choco':
      return `choco info ${id}`;
    case 'pip':
      return `pip show ${id}`;
    case 'npm':
    case 'bun':
      return `npm view ${id}`;
    case 'dotnet':
      return `dotnet tool search ${id} --detail`;
    case 'cargo':
      return `cargo search ${id}`;
    case 'vcpkg':
      return `vcpkg search ${id}`;
    case 'psgallery':
      return `Find-Module -Name ${id} | Format-List Name,Version,Author,ProjectUri,Description | Out-String -Width 200`;
    case 'pwsh7':
      return `pwsh -NoProfile -NonInteractive -Command "Find-PSResource -Name ${id} | Format-List Name,Version,Author,Repository,Description | Out-String -Width 200"`;
    default:
      return '';
  }
}

// ===== sources (port of SourceManager) =====

function parseWingetSources(text: string): SourceRow[] {
  const res: SourceRow[] = [];
  const ls = lines(text);
  let hdr = -1;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? '';
    if (l.includes('Name') && l.includes('Argument')) {
      hdr = i;
      break;
    }
  }
  if (hdr < 0) return res;
  const h = ls[hdr] ?? '';
  const nameCol = h.indexOf('Name');
  const argCol = h.indexOf('Argument');
  if (nameCol < 0 || argCol < 0) return res;
  for (let i = hdr + 1; i < ls.length; i++) {
    const ln = ls[i] ?? '';
    if (!ln.trim() || ln.trimStart().startsWith('---')) continue;
    const name = ln.slice(nameCol, Math.min(argCol, ln.length)).trim();
    if (!name) continue;
    res.push({ mgr: 'winget', name, url: argCol < ln.length ? ln.slice(argCol).trim() : '' });
  }
  return res;
}

function parseScoopBuckets(text: string): SourceRow[] {
  const res: SourceRow[] = [];
  let past = false;
  for (const raw of lines(text)) {
    if (!past) {
      if (raw.includes('---')) past = true;
      continue;
    }
    if (!raw.trim()) continue;
    let cols = raw.trim().split(/ {2,}|\t+/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (cols.length <= 1) cols = ws(raw.trim());
    const name = cols[0] ?? '';
    if (!name) continue;
    let url = cols[1] ?? '';
    if (/\.git$/i.test(url)) url = url.slice(0, -4);
    let count: string | undefined;
    let updated: string | undefined;
    if (cols.length >= 4) {
      updated = cols.slice(2, cols.length - 1).join(' ');
      const last = (cols[cols.length - 1] ?? '').trim();
      if (last && /^\d+$/.test(last)) count = last;
    } else if (cols.length === 3) {
      const last = (cols[2] ?? '').trim();
      if (last && /^\d+$/.test(last)) count = last;
      else updated = last;
    }
    res.push({ mgr: 'scoop', name, url, count, updated });
  }
  return res;
}

function parseDotnetSources(text: string): SourceRow[] {
  const res: SourceRow[] = [];
  let pending: string | null = null;
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln) continue;
    const dot = ln.indexOf('.');
    if (dot > 0 && dot <= 3 && /^\d+$/.test(ln.slice(0, dot))) {
      const rest = ln.slice(dot + 1).trim();
      const br = rest.indexOf('[');
      pending = (br >= 0 ? rest.slice(0, br) : rest).trim();
    } else if (pending && (ln.startsWith('http') || ln.includes('://') || ln.includes(':\\') || ln.startsWith('\\\\'))) {
      res.push({ mgr: 'dotnet', name: pending, url: ln });
      pending = null;
    }
  }
  return res;
}

function parseTabPairs(text: string, mgr: string): SourceRow[] {
  const res: SourceRow[] = [];
  for (const raw of lines(text)) {
    const ln = raw.trim();
    if (!ln) continue;
    const parts = ln.split('\t');
    const name = (parts[0] ?? '').trim();
    if (!name) continue;
    res.push({ mgr, name, url: (parts[1] ?? '').trim() });
  }
  return res;
}

const synth = (mgr: string, name: string, url: string): SourceRow[] => [{ mgr, name, url, synthetic: true }];

async function listSources(key: string): Promise<SourceRow[]> {
  switch (key) {
    case 'winget':
      return parseWingetSources(await cap(`winget source list --disable-interactivity${W400}`));
    case 'scoop':
      return parseScoopBuckets(await cap(`scoop bucket list${W400}`));
    case 'choco':
      return parsePipes(await cap('choco source list -r'), 'choco', false).map((p) => ({
        mgr: 'choco',
        name: p.id,
        url: p.version,
      }));
    case 'dotnet':
      return parseDotnetSources(await cap('dotnet nuget list source'));
    case 'psgallery':
      return parseTabPairs(await cap('Get-PSRepository | ForEach-Object { "$($_.Name)`t$($_.SourceLocation)" }'), 'psgallery');
    case 'pwsh7':
      // Outer single quotes so Windows PowerShell 5.1 passes the script to pwsh verbatim
      // (double quotes would interpolate $_ in the OUTER shell and break the pipeline).
      return parseTabPairs(
        await cap(
          'pwsh -NoProfile -NonInteractive -Command \'Get-PSResourceRepository | ForEach-Object { "{0}`t{1}" -f $_.Name, $_.Uri }\'',
        ),
        'pwsh7',
      );
    case 'pip':
      return synth('pip', 'PyPI', 'https://pypi.org/simple');
    case 'npm': {
      const got = (await cap('npm config get registry')).trim();
      return synth('npm', 'npm registry', got.includes('://') ? got : 'https://registry.npmjs.org');
    }
    case 'cargo':
      return synth('cargo', 'crates.io', 'https://crates.io');
    case 'bun':
      return synth('bun', 'npmjs.org', 'https://registry.npmjs.org');
    case 'vcpkg':
      return synth('vcpkg', 'vcpkg registry', 'https://github.com/microsoft/vcpkg');
    default:
      return [];
  }
}

function srcAddCmd(mgr: string, rawName: string, rawUrl: string): string {
  const n = san(rawName);
  const u = san(rawUrl);
  switch (mgr) {
    case 'winget':
      return `winget source add --name "${n}" --arg "${u}" --accept-source-agreements --disable-interactivity`;
    case 'scoop':
      return `scoop bucket add ${n}${u ? ` ${u}` : ''}`;
    case 'choco':
      return `choco source add -n="${n}" -s="${u}" -y`;
    case 'dotnet':
      return `dotnet nuget add source "${u}" --name "${n}"`;
    case 'psgallery':
      return `Register-PSRepository -Name ${n} -SourceLocation ${u} -InstallationPolicy Trusted`;
    case 'pwsh7':
      return `pwsh -NoProfile -NonInteractive -Command "Register-PSResourceRepository -Name ${n} -Uri ${u} -Trusted"`;
    default:
      return '';
  }
}

function srcRemoveCmd(mgr: string, rawName: string): string {
  const n = san(rawName);
  switch (mgr) {
    case 'winget':
      return `winget source remove --name "${n}" --disable-interactivity`;
    case 'scoop':
      return `scoop bucket rm ${n}`;
    case 'choco':
      return `choco source remove -n="${n}" -y`;
    case 'dotnet':
      return `dotnet nuget remove source "${n}"`;
    case 'psgallery':
      return `Unregister-PSRepository -Name ${n}`;
    case 'pwsh7':
      return `pwsh -NoProfile -NonInteractive -Command "Unregister-PSResourceRepository -Name ${n}"`;
    default:
      return '';
  }
}

const srcRefreshCmd = (mgr: string): string =>
  mgr === 'winget' ? 'winget source update --disable-interactivity' : mgr === 'scoop' ? 'scoop update' : '';

// ===== bundles (BundleService JSON, export_version 3) =====

interface BundleEntry {
  id: string;
  name: string;
  version: string;
  source: string;
  mgr: string;
}

function downloadBundle(items: Pkg[]): void {
  const bundle = {
    export_version: 3,
    packages: items.map((p) => ({ Id: p.id, Name: p.name, Version: p.version, Source: p.source, ManagerName: p.mgr })),
    incompatible_packages: [],
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'winforge-bundle.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseBundle(text: string): { version: number; pkgs: BundleEntry[]; incompatible: number } | null {
  const root = tryJson(text);
  if (!root) return null;
  const toEntry = (el: unknown): BundleEntry => ({
    id: str(el, 'Id') || str(el, 'id'),
    name: str(el, 'Name') || str(el, 'name'),
    version: str(el, 'Version') || str(el, 'version'),
    source: str(el, 'Source') || str(el, 'source'),
    mgr: str(el, 'ManagerName') || str(el, 'ManagerKey') || str(el, 'manager') || str(el, 'ManagerId'),
  });
  if (Array.isArray(root)) {
    const pkgs = root.map(toEntry).filter((p) => p.id);
    return { version: 3, pkgs, incompatible: 0 };
  }
  if (typeof root === 'object') {
    const o = root as Record<string, unknown>;
    const rawPkgs = Array.isArray(o.packages) ? o.packages : [];
    const inc = Array.isArray(o.incompatible_packages) ? o.incompatible_packages.length : 0;
    const ver = typeof o.export_version === 'number' ? o.export_version : Number(str(o, 'export_version')) || 3;
    return { version: ver, pkgs: rawPkgs.map(toEntry).filter((p) => p.id), incompatible: inc };
  }
  return null;
}

// ===== availability probe (Get-Command across every CLI in one call) =====

async function probeAvailability(): Promise<Record<string, boolean>> {
  if (!isTauri()) return {};
  const script =
    "$m=@{}; foreach($c in @('winget','scoop','choco','pip','npm','dotnet','cargo','bun','vcpkg','pwsh')){ $m[$c] = [bool](Get-Command $c -ErrorAction SilentlyContinue) }; $m | ConvertTo-Json -Compress";
  const parsed = tryJson(sliceJson(await cap(script), '{'));
  const out: Record<string, boolean> = { powershell: true };
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true;
  }
  for (const m of MANAGERS) out[m.key] = m.cli === 'powershell' ? true : out[m.cli] === true;
  return out;
}

const pkgKey = (p: Pkg): string => `${p.mgr}|${p.id}`;
const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim()) ?? '').trim();
const tail = (s: string, n: number): string =>
  s
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');

// ===== shared UI bits =====

function useBatch() {
  const [selMap, setSelMap] = useState<Record<string, Pkg>>({});
  const toggle = (p: Pkg, on: boolean): void =>
    setSelMap((prev) => {
      const next = { ...prev };
      if (on) next[pkgKey(p)] = p;
      else delete next[pkgKey(p)];
      return next;
    });
  const clear = (): void => setSelMap({});
  return { selMap, toggle, clear, items: Object.values(selMap) };
}

function MgrBadge({ k }: { k: string }) {
  return (
    <span
      style={{
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '1px 6px',
        border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: 4,
        opacity: 0.85,
        whiteSpace: 'nowrap',
      }}
    >
      {k}
    </span>
  );
}

/** Per-package details viewer (winget show / choco info / pip show / npm view…). */
function DetailsBox({ pkg, onClose }: { pkg: Pkg; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, loading } = useAsync(
    async () => (isTauri() ? (await cap(detailsCmd(pkg.mgr, pkg.id))).trim() : ''),
    [pkg.mgr, pkg.id],
  );
  return (
    <div style={{ margin: '8px 0' }}>
      <ModuleToolbar>
        <strong style={{ fontSize: 13 }}>
          {t('pkg.details')} — {pkg.name}{' '}
          <span style={{ opacity: 0.6, fontFamily: 'monospace', fontSize: 11 }}>({pkg.mgr})</span>
        </strong>
        <button className="mini" onClick={onClose}>
          {t('pkg.close')}
        </button>
      </ModuleToolbar>
      {loading ? (
        <p className="count-note">{t('pkg.detailsLoading')}</p>
      ) : (
        <pre className="cmd-out">{data || t('modules.noRows')}</pre>
      )}
    </div>
  );
}

/** UniGetUI-style multi-select batch bar; uninstall is confirm-gated. */
function BatchBar({
  items,
  busy,
  ops,
  onRun,
  onExport,
  onClear,
}: {
  items: Pkg[];
  busy: boolean;
  ops: Op[];
  onRun: (op: Op) => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [confirmUn, setConfirmUn] = useState(false);
  if (items.length === 0) return null;
  const label: Record<Op, string> = {
    install: t('pkg.batchInstall'),
    update: t('pkg.batchUpdate'),
    uninstall: t('pkg.batchUninstall'),
  };
  return (
    <ModuleToolbar>
      <span className="count-note" style={{ fontWeight: 600 }}>
        {t('pkg.selectedN', { n: items.length })}
      </span>
      {ops.map((op) =>
        op === 'uninstall' ? (
          confirmUn ? (
            <span key={op} className="row-actions">
              <button
                className="mini primary"
                disabled={busy}
                onClick={() => {
                  setConfirmUn(false);
                  onRun('uninstall');
                }}
              >
                {t('pkg.confirm')}
              </button>
              <button className="mini" onClick={() => setConfirmUn(false)}>
                {t('pkg.cancel')}
              </button>
            </span>
          ) : (
            <button key={op} className="mini" disabled={busy} onClick={() => setConfirmUn(true)}>
              {label[op]}
            </button>
          )
        ) : (
          <button key={op} className="mini" disabled={busy} onClick={() => onRun(op)}>
            {label[op]}
          </button>
        ),
      )}
      <button className="mini" onClick={onExport}>
        {t('pkg.batchExport')}
      </button>
      <button className="mini" onClick={onClear}>
        {t('pkg.clear')}
      </button>
    </ModuleToolbar>
  );
}

async function execBatch(
  list: Pkg[],
  op: Op,
  fmt: { step: (i: number, n: number, name: string, mgr: string) => string; ok: string; fail: string },
  onLine: (s: string) => void,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    onLine(fmt.step(i + 1, list.length, it.name, it.mgr));
    const r = await runOp(opCmd(it.mgr, it.id, op));
    if (r.ok) {
      ok++;
      onLine(`  ${fmt.ok}`);
    } else {
      fail++;
      onLine(`  ${fmt.fail}${r.out ? `\n    ${tail(r.out, 6).replace(/\n/g, '\n    ')}` : ''}`);
    }
  }
  return { ok, fail };
}

const checkCol = (
  selMap: Record<string, Pkg>,
  toggle: (p: Pkg, on: boolean) => void,
): Column<Pkg> => ({
  key: 'sel',
  header: '',
  width: 34,
  render: (p) => (
    <input type="checkbox" checked={!!selMap[pkgKey(p)]} onChange={(e) => toggle(p, e.target.checked)} />
  ),
});

// ===== Discover =====

type SearchMode = 'both' | 'name' | 'id' | 'exact' | 'similar';

function normalizeQ(s: string, ignoreSpecial: boolean, caseSensitive: boolean): string {
  let v = s;
  if (ignoreSpecial) v = v.replace(/[^\p{L}\p{N}]/gu, '');
  return caseSensitive ? v : v.toUpperCase();
}

function filterResults(raw: Pkg[], query: string, mode: SearchMode, caseS: boolean, special: boolean): Pkg[] {
  if (mode === 'similar') return raw;
  const nq = normalizeQ(query, special, caseS);
  if (!nq) return raw;
  const has = (v: string): boolean => normalizeQ(v, special, caseS).includes(nq);
  const eq = (v: string): boolean => normalizeQ(v, special, caseS) === nq;
  return raw.filter((p) =>
    mode === 'name' ? has(p.name) : mode === 'id' ? has(p.id) : mode === 'exact' ? eq(p.name) || eq(p.id) : has(p.name) || has(p.id),
  );
}

function DiscoverTab({ mgrs, live }: { mgrs: MgrDef[]; live: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [raw, setRaw] = useState<Pkg[]>([]);
  const [queried, setQueried] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(t('pkg.searchHint'));
  const [log, setLog] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [details, setDetails] = useState<Pkg | null>(null);
  const { selMap, toggle, clear, items } = useBatch();
  const [mode, setMode] = useState<SearchMode>(() => lsGet(LS.mode, 'both') as SearchMode);
  const [caseS, setCaseS] = useState(() => lsGet(LS.caseS, 'false') === 'true');
  const [special, setSpecial] = useState(() => lsGet(LS.special, 'false') === 'true');

  const appendLog = (line: string): void => setLog((l) => (l ? `${l}\n` : '') + line);

  const modeLabel = (m: SearchMode): string =>
    m === 'name'
      ? t('pkg.modeName')
      : m === 'id'
        ? t('pkg.modeId')
        : m === 'exact'
          ? t('pkg.modeExact')
          : m === 'similar'
            ? t('pkg.modeSimilar')
            : t('pkg.modeBoth');

  const doSearch = async (): Promise<void> => {
    const query = q.trim();
    if (query.length < 2) {
      setMsg(t('pkg.searchMin'));
      return;
    }
    const keys = mgrs.filter((m) => m.canSearch).map((m) => m.key);
    if (keys.length === 0) {
      setMsg(t('pkg.noManagers'));
      return;
    }
    setBusy(true);
    setMsg(t('pkg.searching'));
    setDetails(null);
    clear();
    const res = await fetchAcross(keys, (k) => searchMgr(k, query));
    setRaw(res);
    setQueried(query);
    setBusy(false);
    setMsg(null);
  };

  const shown = useMemo(() => filterResults(raw, queried, mode, caseS, special), [raw, queried, mode, caseS, special]);

  const runOne = async (p: Pkg, op: Op): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey(pkgKey(p));
    setMsg(t('pkg.installingName', { name: p.name }));
    const r = await runOp(opCmd(p.mgr, p.id, op));
    setMsg(r.ok ? t('pkg.opInstalled', { name: p.name }) : t('pkg.opFailed', { name: p.name, err: firstLine(r.out) }));
    if (!r.ok && r.out) appendLog(tail(r.out, 8));
    setBusyKey('');
  };

  const runBatch = async (op: Op): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setLog('');
    const { ok, fail } = await execBatch(
      items,
      op,
      {
        step: (i, n, name, mgr) => t('pkg.runningStep', { i, n, name, mgr }),
        ok: t('pkg.okLbl'),
        fail: t('pkg.failLbl'),
      },
      appendLog,
    );
    setMsg(t('pkg.batchDone', { ok, fail }));
    setBusy(false);
    clear();
  };

  const copyInstall = async (p: Pkg): Promise<void> => {
    try {
      await navigator.clipboard.writeText(opCmd(p.mgr, p.id, 'install'));
      setMsg(t('pkg.copied'));
    } catch {
      setMsg(opCmd(p.mgr, p.id, 'install'));
    }
  };

  const cols: Column<Pkg>[] = [
    checkCol(selMap, toggle),
    { key: 'name', header: t('pkg.colName'), render: (p) => <span style={{ fontWeight: 600 }}>{p.name}</span> },
    {
      key: 'id',
      header: t('pkg.colId'),
      render: (p) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.id}</span>,
    },
    { key: 'version', header: t('pkg.colVersion'), width: 110 },
    { key: 'source', header: t('pkg.colSource'), width: 90 },
    { key: 'mgr', header: t('pkg.colManager'), width: 100, render: (p) => <MgrBadge k={p.mgr} /> },
    {
      key: 'actions',
      header: '',
      width: 240,
      render: (p) => (
        <span className="row-actions">
          <button className="mini primary" disabled={busy || busyKey !== ''} onClick={() => void runOne(p, 'install')}>
            {busyKey === pkgKey(p) ? '…' : t('pkg.install')}
          </button>
          <button className="mini" onClick={() => setDetails(p)}>
            {t('pkg.details')}
          </button>
          <button className="mini" title={t('pkg.copyCmd')} onClick={() => void copyInstall(p)}>
            {t('pkg.copy')}
          </button>
        </span>
      ),
    },
  ];

  const suffix = `${special ? ` · ${t('pkg.ignoreSpecial')}` : ''}${caseS ? ` · ${t('pkg.caseSensitive')}` : ''}`;

  return (
    <div>
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('pkg.searchAllPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void doSearch()}
        />
        <button className="mini primary" disabled={busy} onClick={() => void doSearch()}>
          {t('pkg.search')}
        </button>
        {queried && (
          <span className="count-note">
            {t('pkg.resultsN', { shown: shown.length, total: raw.length, mode: modeLabel(mode) })}
            {suffix}
          </span>
        )}
      </ModuleToolbar>
      <details style={{ margin: '4px 0' }}>
        <summary className="count-note" style={{ cursor: 'pointer' }}>
          {t('pkg.filters')}
        </summary>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            border: '1px solid rgba(128,128,128,0.35)',
            borderRadius: 6,
            maxWidth: 360,
            marginTop: 4,
          }}
        >
          <strong style={{ fontSize: 12 }}>{t('pkg.searchMode')}</strong>
          {(['both', 'name', 'id', 'exact', 'similar'] as const).map((m) => (
            <label key={m} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="radio"
                name="pkg-search-mode"
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  lsSet(LS.mode, m);
                }}
              />
              {modeLabel(m)}
            </label>
          ))}
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={caseS}
              onChange={(e) => {
                setCaseS(e.target.checked);
                lsSet(LS.caseS, e.target.checked ? 'true' : 'false');
              }}
            />
            {t('pkg.caseSensitive')}
          </label>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={special}
              onChange={(e) => {
                setSpecial(e.target.checked);
                lsSet(LS.special, e.target.checked ? 'true' : 'false');
              }}
            />
            {t('pkg.ignoreSpecial')}
          </label>
        </div>
      </details>
      {msg && <p className="mod-msg">{msg}</p>}
      <BatchBar
        items={items}
        busy={busy}
        ops={['install', 'update', 'uninstall']}
        onRun={(op) => void runBatch(op)}
        onExport={() => downloadBundle(items)}
        onClear={clear}
      />
      {details && <DetailsBox pkg={details} onClose={() => setDetails(null)} />}
      {busy && <p className="count-note">{t('pkg.working')}</p>}
      {queried ? (
        <DataTable columns={cols} rows={shown} rowKey={(p, i) => `${pkgKey(p)}|${i}`} empty={t('pkg.noMatch')} />
      ) : null}
      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

// ===== Updates =====

function UpdatesTab({ mgrs, live }: { mgrs: MgrDef[]; live: boolean }) {
  const { t } = useTranslation();
  const keys = mgrs.filter((m) => m.canUpdates).map((m) => m.key);
  const keyDep = keys.join(',');
  const { data, loading, error, reload } = useAsync(() => fetchAcross(keys, updatesMgr), [keyDep]);
  const [pins, setPins] = useState<Pin[]>(() => loadPins());
  const [msg, setMsg] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [details, setDetails] = useState<Pkg | null>(null);
  const { selMap, toggle, clear, items } = useBatch();
  const ignoreNa = lsGet(LS.ignoreNa, 'false') === 'true';

  const appendLog = (line: string): void => setLog((l) => (l ? `${l}\n` : '') + line);

  const shown = useMemo(
    () => (data ?? []).filter((p) => !isIgnored(pins, p) && !(ignoreNa && !p.avail.trim())),
    [data, pins, ignoreNa],
  );
  const hidden = (data?.length ?? 0) - shown.length;

  const applyIgnore = (p: Pkg, choice: string): void => {
    const mk = (version: string, pauseDays: number | null): Pin => ({
      manager: p.mgr,
      id: p.id,
      version,
      pauseUntil: pauseDays === null ? null : new Date(Date.now() + pauseDays * 86400000).toISOString().slice(0, 10),
    });
    const pin =
      choice === 'skip'
        ? mk((p.avail || p.version || '*').trim() || '*', null)
        : choice === 'all'
          ? mk('*', null)
          : choice === 'p1'
            ? mk('*', 1)
            : choice === 'p7'
              ? mk('*', 7)
              : choice === 'p30'
                ? mk('*', 30)
                : mk('*', 90);
    setPins((prev) => upsertPin(prev, pin));
  };

  const updateOne = async (p: Pkg): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey(pkgKey(p));
    setMsg(t('pkg.updatingName', { name: p.name }));
    const r = await runOp(opCmd(p.mgr, p.id, 'update'));
    setMsg(r.ok ? t('pkg.opUpdated', { name: p.name }) : t('pkg.opFailed', { name: p.name, err: firstLine(r.out) }));
    if (!r.ok && r.out) appendLog(tail(r.out, 8));
    setBusyKey('');
    if (r.ok) reload();
  };

  const updateMany = async (list: Pkg[], mgrLabel?: string): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setLog('');
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it) continue;
      setMsg(t('pkg.updateAllProgress', { name: it.name, i: i + 1, n: list.length }));
      const r = await runOp(opCmd(it.mgr, it.id, 'update'));
      if (r.ok) done++;
      else appendLog(`${it.name}: ${firstLine(r.out)}`);
    }
    setMsg(
      mgrLabel
        ? t('pkg.mgrUpdatedNofM', { mgr: mgrLabel, done, total: list.length })
        : t('pkg.updatedNofM', { done, total: list.length }),
    );
    setBusy(false);
    clear();
    reload();
  };

  const runBatch = async (op: Op): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setLog('');
    const { ok, fail } = await execBatch(
      items,
      op,
      { step: (i, n, name, mgr) => t('pkg.runningStep', { i, n, name, mgr }), ok: t('pkg.okLbl'), fail: t('pkg.failLbl') },
      appendLog,
    );
    setMsg(t('pkg.batchDone', { ok, fail }));
    setBusy(false);
    clear();
    reload();
  };

  const byMgr = useMemo(() => {
    const map = new Map<string, Pkg[]>();
    for (const p of shown) {
      const arr = map.get(p.mgr) ?? [];
      arr.push(p);
      map.set(p.mgr, arr);
    }
    return [...map.entries()].filter(([, v]) => v.length > 1);
  }, [shown]);

  const cols: Column<Pkg>[] = [
    checkCol(selMap, toggle),
    { key: 'name', header: t('pkg.colName'), render: (p) => <span style={{ fontWeight: 600 }}>{p.name}</span> },
    {
      key: 'id',
      header: t('pkg.colId'),
      render: (p) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.id}</span>,
    },
    {
      key: 'version',
      header: t('pkg.colVersion'),
      width: 180,
      render: (p) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {p.version}
          {p.avail ? ` → ${p.avail}` : ''}
        </span>
      ),
    },
    { key: 'mgr', header: t('pkg.colManager'), width: 100, render: (p) => <MgrBadge k={p.mgr} /> },
    {
      key: 'actions',
      header: '',
      width: 280,
      render: (p) => (
        <span className="row-actions">
          <button className="mini primary" disabled={busy || busyKey !== ''} onClick={() => void updateOne(p)}>
            {busyKey === pkgKey(p) ? '…' : p.avail ? `${t('pkg.update')} → ${p.avail}` : t('pkg.update')}
          </button>
          <select value="" disabled={busy} onChange={(e) => e.target.value && applyIgnore(p, e.target.value)} style={{ fontSize: 12 }}>
            <option value="">{t('pkg.ignore')}</option>
            <option value="skip">{t('pkg.ignoreSkip')}</option>
            <option value="all">{t('pkg.ignoreAll')}</option>
            <option value="p1">{t('pkg.pause1d')}</option>
            <option value="p7">{t('pkg.pause1w')}</option>
            <option value="p30">{t('pkg.pause1m')}</option>
            <option value="p90">{t('pkg.pause3m')}</option>
          </select>
          <button className="mini" onClick={() => setDetails(p)}>
            {t('pkg.details')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <ModuleToolbar>
        <button className="mini" disabled={busy || loading} onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini primary" disabled={busy || loading || shown.length === 0} onClick={() => void updateMany(shown)}>
          {t('pkg.updateAll')}
        </button>
        {byMgr.map(([mgr, list]) => (
          <button key={mgr} className="mini" disabled={busy || loading} onClick={() => void updateMany(list, mgr)}>
            {mgr} ({list.length})
          </button>
        ))}
        <span className="count-note">
          {hidden > 0 ? t('pkg.updatesIgnoredN', { n: shown.length, ignored: hidden }) : t('pkg.updatesN', { n: shown.length })}
        </span>
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      <BatchBar
        items={items}
        busy={busy}
        ops={['install', 'update', 'uninstall']}
        onRun={(op) => void runBatch(op)}
        onExport={() => downloadBundle(items)}
        onClear={clear}
      />
      {details && <DetailsBox pkg={details} onClose={() => setDetails(null)} />}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={cols} rows={shown} rowKey={(p, i) => `${pkgKey(p)}|${i}`} />
      </AsyncState>
      {loading && <p className="count-note">{t('pkg.checkingUpdates')}</p>}
      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

// ===== Installed =====

function InstalledTab({ mgrs, live }: { mgrs: MgrDef[]; live: boolean }) {
  const { t } = useTranslation();
  const keys = mgrs.map((m) => m.key);
  const keyDep = keys.join(',');
  const { data, loading, error, reload } = useAsync(() => fetchAcross(keys, installedMgr), [keyDep]);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [details, setDetails] = useState<Pkg | null>(null);
  const [conf, setConf] = useState<{ key: string; kind: 'un' | 're' } | null>(null);
  const { selMap, toggle, clear, items } = useBatch();

  const appendLog = (line: string): void => setLog((l) => (l ? `${l}\n` : '') + line);

  const rows = useMemo(() => {
    const all = data ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(f)) : all;
  }, [data, filter]);

  const doUninstall = async (p: Pkg): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey(pkgKey(p));
    setMsg(t('pkg.removingName', { name: p.name }));
    const r = await runOp(opCmd(p.mgr, p.id, 'uninstall'));
    setMsg(r.ok ? t('pkg.opRemoved', { name: p.name }) : t('pkg.opFailed', { name: p.name, err: firstLine(r.out) }));
    if (!r.ok && r.out) appendLog(tail(r.out, 8));
    setBusyKey('');
    if (r.ok) reload();
  };

  const doReinstall = async (p: Pkg): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey(pkgKey(p));
    setMsg(t('pkg.removingName', { name: p.name }));
    const r1 = await runOp(opCmd(p.mgr, p.id, 'uninstall'));
    if (!r1.ok) {
      setMsg(t('pkg.opFailed', { name: p.name, err: firstLine(r1.out) }));
      setBusyKey('');
      return;
    }
    setMsg(t('pkg.installingName', { name: p.name }));
    const r2 = await runOp(opCmd(p.mgr, p.id, 'install'));
    setMsg(r2.ok ? t('pkg.opInstalled', { name: p.name }) : t('pkg.opFailed', { name: p.name, err: firstLine(r2.out) }));
    setBusyKey('');
    reload();
  };

  const runBatch = async (op: Op): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setLog('');
    const { ok, fail } = await execBatch(
      items,
      op,
      { step: (i, n, name, mgr) => t('pkg.runningStep', { i, n, name, mgr }), ok: t('pkg.okLbl'), fail: t('pkg.failLbl') },
      appendLog,
    );
    setMsg(t('pkg.batchDone', { ok, fail }));
    setBusy(false);
    clear();
    reload();
  };

  const cols: Column<Pkg>[] = [
    checkCol(selMap, toggle),
    { key: 'name', header: t('pkg.colName'), render: (p) => <span style={{ fontWeight: 600 }}>{p.name}</span> },
    {
      key: 'id',
      header: t('pkg.colId'),
      render: (p) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.id}</span>,
    },
    { key: 'version', header: t('pkg.colVersion'), width: 120 },
    { key: 'source', header: t('pkg.colSource'), width: 90 },
    { key: 'mgr', header: t('pkg.colManager'), width: 100, render: (p) => <MgrBadge k={p.mgr} /> },
    {
      key: 'actions',
      header: '',
      width: 280,
      render: (p) => {
        const k = pkgKey(p);
        if (conf && conf.key === k) {
          const kind = conf.kind;
          return (
            <span className="row-actions">
              <span className="count-note">{kind === 'un' ? t('pkg.uninstall') : t('pkg.reinstall')}?</span>
              <button
                className="mini primary"
                disabled={busy || busyKey !== ''}
                onClick={() => {
                  setConf(null);
                  void (kind === 'un' ? doUninstall(p) : doReinstall(p));
                }}
              >
                {t('pkg.confirm')}
              </button>
              <button className="mini" onClick={() => setConf(null)}>
                {t('pkg.cancel')}
              </button>
            </span>
          );
        }
        return (
          <span className="row-actions">
            <button className="mini" disabled={busy || busyKey !== ''} onClick={() => setConf({ key: k, kind: 'un' })}>
              {busyKey === k ? '…' : t('pkg.uninstall')}
            </button>
            <button className="mini" disabled={busy || busyKey !== ''} onClick={() => setConf({ key: k, kind: 're' })}>
              {t('pkg.reinstall')}
            </button>
            <button className="mini" onClick={() => setDetails(p)}>
              {t('pkg.details')}
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <ModuleToolbar>
        <input className="mod-search" placeholder={t('pkg.filterPlaceholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="mini" disabled={busy || loading} onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('pkg.installedN', { n: rows.length })}</span>
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      <BatchBar
        items={items}
        busy={busy}
        ops={['install', 'update', 'uninstall']}
        onRun={(op) => void runBatch(op)}
        onExport={() => downloadBundle(items)}
        onClear={clear}
      />
      {details && <DetailsBox pkg={details} onClose={() => setDetails(null)} />}
      <AsyncState loading={loading} error={error}>
        <DataTable columns={cols} rows={rows} rowKey={(p, i) => `${pkgKey(p)}|${i}`} />
      </AsyncState>
      {loading && <p className="count-note">{t('pkg.listingInstalled')}</p>}
      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

// ===== Bundles =====

function BundlesTab({ mgrs, live }: { mgrs: MgrDef[]; live: boolean }) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [pending, setPending] = useState<{ version: number; pkgs: BundleEntry[]; incompatible: number } | null>(null);

  const appendLog = (line: string): void => setLog((l) => (l ? `${l}\n` : '') + line);
  const usable = new Set(mgrs.map((m) => m.key));

  const doExport = async (): Promise<void> => {
    setBusy(true);
    setMsg(t('pkg.listingInstalled'));
    const items = await fetchAcross(mgrs.map((m) => m.key), installedMgr);
    downloadBundle(items);
    setMsg(t('pkg.exportedN', { n: items.length }));
    setBusy(false);
  };

  const onFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    const text = await f.text();
    const parsed = parseBundle(text);
    if (!parsed) {
      setMsg(t('pkg.bundleParseErr', { err: f.name }));
      setPending(null);
      return;
    }
    if (parsed.pkgs.length === 0 && parsed.incompatible === 0) {
      setMsg(t('pkg.bundleEmpty'));
      setPending(null);
      return;
    }
    setMsg(null);
    setPending(parsed);
  };

  const installBundle = async (): Promise<void> => {
    if (!pending) return;
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setLog('');
    const compat = pending.pkgs.filter((p) => usable.has(p.mgr));
    const skipped = pending.pkgs.length - compat.length + pending.incompatible;
    let done = 0;
    for (let i = 0; i < compat.length; i++) {
      const en = compat[i];
      if (!en) continue;
      const label = en.name || en.id;
      setMsg(t('pkg.bundleInstalling', { name: label, i: i + 1, n: compat.length }));
      const r = await runOp(opCmd(en.mgr, en.id, 'install'));
      if (r.ok) done++;
      else appendLog(`${label}: ${firstLine(r.out)}`);
    }
    setMsg(
      t('pkg.bundleInstalledN', { done, total: compat.length }) +
        (skipped > 0 ? ` ${t('pkg.bundleSkippedN', { n: skipped })}` : ''),
    );
    setBusy(false);
    setPending(null);
  };

  const compatCount = pending ? pending.pkgs.filter((p) => usable.has(p.mgr)).length : 0;
  const skippedCount = pending ? pending.pkgs.length - compatCount + pending.incompatible : 0;

  return (
    <div>
      <p className="count-note">{t('pkg.bundlesBlurb')}</p>
      <ModuleToolbar>
        <button className="mini primary" disabled={busy} onClick={() => void doExport()}>
          {t('pkg.exportBundle')}
        </button>
        <button className="mini" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t('pkg.importBundle')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.ubundle,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      {pending && (
        <div style={{ border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '10px 12px', margin: '8px 0' }}>
          {pending.version !== 3 && <p className="mod-msg">{t('pkg.bundleVersionWarn', { v: pending.version })}</p>}
          <p style={{ fontSize: 13, margin: '4px 0' }}>
            {t('pkg.bundleInstallN', { n: compatCount })}
            {skippedCount > 0 ? ` ${t('pkg.bundleSkippedN', { n: skippedCount })}` : ''}
          </p>
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12, fontFamily: 'monospace' }}>
            {pending.pkgs.slice(0, 12).map((p, i) => (
              <li key={`${p.mgr}|${p.id}|${i}`}>
                {p.mgr || '?'} · {p.id}
                {usable.has(p.mgr) ? '' : ` — ${t('pkg.notFound')}`}
              </li>
            ))}
            {pending.pkgs.length > 12 && <li>… +{pending.pkgs.length - 12}</li>}
          </ul>
          <span className="row-actions">
            <button className="mini primary" disabled={busy || compatCount === 0} onClick={() => void installBundle()}>
              {t('pkg.install')}
            </button>
            <button className="mini" onClick={() => setPending(null)}>
              {t('pkg.cancel')}
            </button>
          </span>
        </div>
      )}
      {busy && <p className="count-note">{t('pkg.working')}</p>}
      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

// ===== Sources =====

function SourcesTab({ mgrs, live }: { mgrs: MgrDef[]; live: boolean }) {
  const { t, i18n } = useTranslation();
  const keys = mgrs.map((m) => m.key);
  const keyDep = keys.join(',');
  const { data, loading, error, reload } = useAsync(async () => {
    const out: Record<string, SourceRow[]> = {};
    await Promise.all(
      keys.map(async (k) => {
        try {
          out[k] = await listSources(k);
        } catch {
          out[k] = [];
        }
      }),
    );
    return out;
  }, [keyDep]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyMgr, setBusyMgr] = useState('');
  const [addForm, setAddForm] = useState<{ mgr: string; name: string; url: string } | null>(null);
  const [removeConf, setRemoveConf] = useState<{ mgr: string; name: string } | null>(null);

  const doAdd = async (): Promise<void> => {
    if (!addForm) return;
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    const { mgr, name, url } = addForm;
    setBusyMgr(mgr);
    setMsg(t('pkg.addingSrc', { name }));
    const r = await runOp(srcAddCmd(mgr, name, url));
    setMsg(r.ok ? t('pkg.added', { name }) : `${t('pkg.addFailed', { name })}${r.out ? ` — ${firstLine(r.out)}` : ''}`);
    setBusyMgr('');
    setAddForm(null);
    reload();
  };

  const doRemove = async (mgr: string, name: string): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyMgr(mgr);
    setMsg(t('pkg.removingSrc', { name }));
    const r = await runOp(srcRemoveCmd(mgr, name));
    setMsg(r.ok ? t('pkg.removed', { name }) : `${t('pkg.removeFailed', { name })}${r.out ? ` — ${firstLine(r.out)}` : ''}`);
    setBusyMgr('');
    reload();
  };

  const doRefresh = async (mgr: string): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyMgr(mgr);
    setMsg(t('pkg.refreshingSrc'));
    const r = await runOp(srcRefreshCmd(mgr));
    setMsg(r.ok ? t('pkg.refreshed') : t('pkg.refreshFailed'));
    setBusyMgr('');
    reload();
  };

  const makeCols = (canRemove: boolean): Column<SourceRow>[] => [
    { key: 'name', header: t('pkg.srcName'), width: 160, render: (s) => <span style={{ fontWeight: 600 }}>{s.name}</span> },
    {
      key: 'url',
      header: t('pkg.srcUrl'),
      render: (s) => <span style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{s.url}</span>,
    },
    {
      key: 'meta',
      header: '',
      width: 190,
      render: (s) => (
        <span className="count-note">
          {[s.count ? t('pkg.srcPackagesN', { n: s.count }) : '', s.updated ? t('pkg.srcUpdatedAt', { d: s.updated }) : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 150,
      render: (s) => {
        if (s.synthetic || !canRemove) return null;
        const on = removeConf && removeConf.mgr === s.mgr && removeConf.name === s.name;
        return on ? (
          <span className="row-actions">
            <button
              className="mini primary"
              disabled={busyMgr !== ''}
              onClick={() => {
                setRemoveConf(null);
                void doRemove(s.mgr, s.name);
              }}
            >
              {t('pkg.confirm')}
            </button>
            <button className="mini" onClick={() => setRemoveConf(null)}>
              {t('pkg.cancel')}
            </button>
          </span>
        ) : (
          <button className="mini" disabled={busyMgr !== ''} onClick={() => setRemoveConf({ mgr: s.mgr, name: s.name })}>
            {t('pkg.remove')}
          </button>
        );
      },
    },
  ];

  return (
    <div>
      <ModuleToolbar>
        <button className="mini" disabled={loading || busyMgr !== ''} onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('pkg.sourcesBlurb')}</span>
      </ModuleToolbar>
      {msg && <p className="mod-msg">{msg}</p>}
      <AsyncState loading={loading} error={error}>
        {mgrs.map((m) => {
          const rows = data?.[m.key] ?? [];
          const canAdd = SRC_ADD_REMOVE.has(m.key);
          const canRefresh = SRC_REFRESH.has(m.key);
          const knowns = KNOWN_SOURCES[m.key] ?? [];
          return (
            <div key={m.key} style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '10px 0 4px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                {pick(m.en, m.zh, i18n.language)} <MgrBadge k={m.key} />
                {SRC_ADMIN.has(m.key) && <span className="count-note">{t('pkg.needsAdmin')}</span>}
              </h4>
              {(canAdd || canRefresh) && (
                <span className="row-actions" style={{ marginBottom: 4, display: 'inline-flex' }}>
                  {canAdd && (
                    <button
                      className="mini"
                      disabled={busyMgr !== ''}
                      onClick={() => setAddForm({ mgr: m.key, name: '', url: '' })}
                    >
                      {t('pkg.addSource')}
                    </button>
                  )}
                  {canRefresh && (
                    <button className="mini" disabled={busyMgr !== ''} onClick={() => void doRefresh(m.key)}>
                      ⟳ {t('modules.refresh')}
                    </button>
                  )}
                </span>
              )}
              {addForm && addForm.mgr === m.key && (
                <div className="mod-form" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {knowns.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const ks = knowns.find((s) => s.name === e.target.value);
                        if (ks) setAddForm({ mgr: m.key, name: ks.name, url: ks.url });
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">{t('pkg.known')}</option>
                      {knowns.map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    className="mod-search"
                    style={{ maxWidth: 160 }}
                    placeholder={t('pkg.srcName')}
                    value={addForm.name}
                    onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                  />
                  <input
                    className="mod-search"
                    style={{ maxWidth: 320 }}
                    placeholder={t('pkg.srcUrl')}
                    value={addForm.url}
                    onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
                  />
                  <button className="mini primary" disabled={busyMgr !== '' || !addForm.name.trim()} onClick={() => void doAdd()}>
                    {t('pkg.add')}
                  </button>
                  <button className="mini" onClick={() => setAddForm(null)}>
                    {t('pkg.cancel')}
                  </button>
                </div>
              )}
              {rows.length === 0 ? (
                <p className="count-note">{t('pkg.noSources')}</p>
              ) : (
                <DataTable columns={makeCols(canAdd)} rows={rows} rowKey={(s, i) => `${s.mgr}|${s.name}|${i}`} />
              )}
            </div>
          );
        })}
      </AsyncState>
    </div>
  );
}

// ===== Ignored =====

function IgnoredTab() {
  const { t } = useTranslation();
  const [pins, setPins] = useState<Pin[]>(() => loadPins());
  const [ignoreNa, setIgnoreNa] = useState(() => lsGet(LS.ignoreNa, 'false') === 'true');

  const kindLabel = (p: Pin): string =>
    p.pauseUntil
      ? t('pkg.pinPausedLbl', { d: p.pauseUntil })
      : p.version === '*'
        ? t('pkg.pinAllLbl')
        : t('pkg.pinVerLbl', { v: p.version });

  const cols: Column<Pin>[] = [
    { key: 'mgr', header: t('pkg.colManager'), width: 110, render: (p) => <MgrBadge k={p.manager || '?'} /> },
    {
      key: 'id',
      header: t('pkg.colId'),
      render: (p) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.id}</span>,
    },
    { key: 'kind', header: t('pkg.colVersion'), render: (p) => kindLabel(p) },
    {
      key: 'actions',
      header: '',
      width: 130,
      render: (p) => (
        <button
          className="mini"
          onClick={() => {
            const next = pins.filter((x) => x !== p);
            savePins(next);
            setPins(next);
          }}
        >
          {t('pkg.unignore')}
        </button>
      ),
    },
  ];

  return (
    <div>
      <ModuleToolbar>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('pkg.ignoredN', { n: pins.length })}
        </span>
        <button
          className="mini"
          disabled={pins.length === 0}
          onClick={() => {
            savePins([]);
            setPins([]);
          }}
        >
          {t('pkg.resetAll')}
        </button>
      </ModuleToolbar>
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 10px' }}>
        <input
          type="checkbox"
          checked={ignoreNa}
          onChange={(e) => {
            setIgnoreNa(e.target.checked);
            lsSet(LS.ignoreNa, e.target.checked ? 'true' : 'false');
          }}
        />
        {t('pkg.ignoreNa')}
      </label>
      <DataTable columns={cols} rows={pins} rowKey={(p, i) => `${p.manager}|${p.id}|${i}`} empty={t('pkg.ignoredEmpty')} />
    </div>
  );
}

// ===== Setup =====

function SetupTab({ avail, live, onInstalled }: { avail: Record<string, boolean>; live: boolean; onInstalled: () => void }) {
  const { t, i18n } = useTranslation();
  const [msg, setMsg] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [log, setLog] = useState('');
  const wingetOk = live && avail.winget === true;
  const { data: depIds, loading: depsLoading, reload: reloadDeps } = useAsync(async () => {
    if (!wingetOk) return new Set<string>();
    const items = parseWingetTable(await cap(`winget list --accept-source-agreements --disable-interactivity${W400}`));
    return new Set(items.map((p) => p.id.toLowerCase()));
  }, [wingetOk]);

  const bootstrapCmd = (m: MgrDef): string =>
    m.bootstrapScript ?? (m.bootstrapId ? opCmd('winget', m.bootstrapId, 'install') : '');

  const installEngine = async (m: MgrDef): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    const cmd = bootstrapCmd(m);
    if (!cmd) return;
    setBusyKey(m.key);
    setMsg(t('pkg.installingName', { name: m.en }));
    const r = await runOp(cmd);
    setMsg(r.ok ? t('pkg.opInstalled', { name: m.en }) : t('pkg.opFailed', { name: m.en, err: firstLine(r.out) }));
    if (r.out) setLog(tail(r.out, 12));
    setBusyKey('');
    if (r.ok) onInstalled();
  };

  const installDep = async (id: string, name: string): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey(id);
    setMsg(t('pkg.installingName', { name }));
    const r = await runOp(opCmd('winget', id, 'install'));
    setMsg(r.ok ? t('pkg.opInstalled', { name }) : t('pkg.opFailed', { name, err: firstLine(r.out) }));
    setBusyKey('');
    if (r.ok) reloadDeps();
  };

  const installAllDeps = async (): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey('__all');
    let done = 0;
    for (const dep of DEPS) {
      if (depIds?.has(dep.id.toLowerCase())) continue;
      setMsg(t('pkg.installingName', { name: dep.en }));
      const r = await runOp(opCmd('winget', dep.id, 'install'));
      if (r.ok) done++;
    }
    setMsg(t('pkg.updatedNofM', { done, total: DEPS.length }));
    setBusyKey('');
    reloadDeps();
  };

  const launchUniGetUI = async (): Promise<void> => {
    if (!live) {
      setMsg(t('pkg.previewNote'));
      return;
    }
    setBusyKey('unigetui');
    setMsg(t('pkg.working'));
    const r = await runOp(
      "try { Start-Process 'UniGetUI' -ErrorAction Stop; 'launched' } catch { winget install --id MartiCliment.UniGetUI -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity }",
    );
    setMsg(r.ok ? t('pkg.done') : t('pkg.failed'));
    setBusyKey('');
  };

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '5px 0',
    borderBottom: '1px solid rgba(128,128,128,0.15)',
  } as const;

  return (
    <div>
      <p className="count-note">{t('pkg.setupBlurb')}</p>
      {msg && <p className="mod-msg">{msg}</p>}
      <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>{t('pkg.managers')}</h4>
      {MANAGERS.map((m) => {
        const ok = avail[m.key] === true;
        const can = !ok && !!(m.bootstrapId ?? m.bootstrapScript);
        return (
          <div key={m.key} style={rowStyle}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {pick(m.en, m.zh, i18n.language)}{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.6 }}>{m.key}</span>
            </span>
            <StatusDot ok={ok} label={ok ? t('pkg.available') : live ? t('pkg.notInstalled') : '—'} />
            {can && (
              <button className="mini" disabled={busyKey !== ''} onClick={() => void installEngine(m)}>
                {busyKey === m.key ? '…' : t('pkg.install')}
                {m.bootstrapAdmin ? ` ${t('pkg.needsAdmin')}` : ''}
              </button>
            )}
          </div>
        );
      })}
      <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('pkg.commonDeps')}</h4>
      <ModuleToolbar>
        <button className="mini primary" disabled={busyKey !== '' || depsLoading} onClick={() => void installAllDeps()}>
          {busyKey === '__all' ? '…' : t('pkg.installAllDeps')}
        </button>
        {depsLoading && <span className="count-note">{t('modules.loading')}</span>}
      </ModuleToolbar>
      {DEPS.map((dep) => {
        const inst = depIds?.has(dep.id.toLowerCase()) === true;
        return (
          <div key={dep.id + dep.en} style={rowStyle}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {pick(dep.en, dep.zh, i18n.language)}{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.6 }}>{dep.id}</span>
            </span>
            <StatusDot ok={inst} label={inst ? t('pkg.listInstalled') : live ? t('pkg.missing') : '—'} />
            {!inst && (
              <button className="mini" disabled={busyKey !== ''} onClick={() => void installDep(dep.id, dep.en)}>
                {busyKey === dep.id ? '…' : t('pkg.install')}
              </button>
            )}
          </div>
        );
      })}
      <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('pkg.unigetui')}</h4>
      <div style={rowStyle}>
        <span style={{ flex: 1, fontSize: 13 }}>
          {t('pkg.unigetuiRow')}{' '}
          <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.6 }}>MartiCliment.UniGetUI</span>
        </span>
        <button className="mini" disabled={busyKey !== ''} onClick={() => void launchUniGetUI()}>
          {busyKey === 'unigetui' ? '…' : t('pkg.launchInstall')}
        </button>
      </div>
      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

// ===== Settings =====

function SettingsTab({ live }: { live: boolean }) {
  const { t } = useTranslation();
  const [ignoreNa, setIgnoreNa] = useState(() => lsGet(LS.ignoreNa, 'false') === 'true');
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const runShell = async (): Promise<void> => {
    const line = cmd.trim();
    if (!line) return;
    if (!live) {
      setOut(t('pkg.previewNote'));
      return;
    }
    setBusy(true);
    setOut(`> ${line}\n`);
    const r = await runOp(line);
    setOut(`> ${line}\n\n${r.out || (r.ok ? t('pkg.done') : t('pkg.failed'))}`);
    setBusy(false);
  };

  return (
    <div>
      <h4 style={{ margin: '4px 0', fontSize: 13 }}>{t('pkg.settingsTitle')}</h4>
      <p className="count-note">{t('pkg.settingsBlurb')}</p>
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0' }}>
        <input
          type="checkbox"
          checked={ignoreNa}
          onChange={(e) => {
            setIgnoreNa(e.target.checked);
            lsSet(LS.ignoreNa, e.target.checked ? 'true' : 'false');
          }}
        />
        {t('pkg.ignoreNa')}
      </label>
      <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('pkg.shellTitle')}</h4>
      <p className="count-note">{t('pkg.shellNote')}</p>
      <div className="mod-form">
        <input
          className="mod-search"
          placeholder="winget list · scoop status · choco outdated · npm outdated -g"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void runShell()}
        />
        <button className="mini primary" disabled={busy || !cmd.trim()} onClick={() => void runShell()}>
          {t('pkg.run')}
        </button>
      </div>
      {busy && <p className="count-note">{t('pkg.working')}</p>}
      {out && <pre className="cmd-out">{out}</pre>}
    </div>
  );
}

// ===== module root =====

export function PackagesModule() {
  const { t, i18n } = useTranslation();
  const live = isTauri();
  const [sel, setSel] = useState<Set<string>>(() => new Set(MANAGERS.map((m) => m.key)));
  const { data: avail, loading: probing, reload: reprobe } = useAsync(probeAvailability, []);

  const active = useMemo(
    () => MANAGERS.filter((m) => sel.has(m.key) && (live ? avail?.[m.key] === true : true)),
    [sel, avail, live],
  );

  const tabs = [
    { id: 'discover', en: 'Discover', zh: '搜尋安裝', render: () => <DiscoverTab mgrs={active} live={live} /> },
    { id: 'updates', en: 'Updates', zh: '可更新', render: () => <UpdatesTab mgrs={active} live={live} /> },
    { id: 'installed', en: 'Installed', zh: '已安裝', render: () => <InstalledTab mgrs={active} live={live} /> },
    { id: 'bundles', en: 'Bundles', zh: '套件清單', render: () => <BundlesTab mgrs={active} live={live} /> },
    { id: 'sources', en: 'Sources', zh: '來源', render: () => <SourcesTab mgrs={active} live={live} /> },
    { id: 'ignored', en: 'Ignored', zh: '已忽略', render: () => <IgnoredTab /> },
    { id: 'setup', en: 'Setup', zh: '設定引擎', render: () => <SetupTab avail={avail ?? {}} live={live} onInstalled={reprobe} /> },
    { id: 'settings', en: 'Settings', zh: '設定', render: () => <SettingsTab live={live} /> },
  ];

  return (
    <div className="mod">
      {!live && <p className="count-note">{t('pkg.previewNote')}</p>}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pkg.blurb')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap', rowGap: 4 }}>
        <span className="count-note" style={{ fontWeight: 600 }}>
          {t('pkg.managers')}
        </span>
        {MANAGERS.map((m) => {
          const known = !!avail && m.key in avail;
          const ok = avail?.[m.key] === true;
          const dis = live && known && !ok;
          return (
            <label
              key={m.key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: dis ? 0.55 : 1 }}
            >
              <input
                type="checkbox"
                checked={sel.has(m.key)}
                disabled={dis}
                onChange={(e) =>
                  setSel((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(m.key);
                    else next.delete(m.key);
                    return next;
                  })
                }
              />
              {pick(m.en, m.zh, i18n.language)}
              {dis ? ` ${t('pkg.notFound')}` : ''}
            </label>
          );
        })}
        <button className="mini" onClick={() => setSel(new Set(MANAGERS.map((m) => m.key)))}>
          {t('pkg.all')}
        </button>
        <button className="mini" onClick={() => setSel(new Set<string>())}>
          {t('pkg.none')}
        </button>
        {live && probing && <span className="count-note">{t('pkg.checking')}</span>}
      </div>
      <ModuleTabs tabs={tabs} />
    </div>
  );
}





