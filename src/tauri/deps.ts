// External-software resolution for modules that shell out to CLI tools.
//
// Resolution order for a tool the app can USE:  bundled (resources/bin) → PATH.
// Resolution order for INSTALLING a missing tool: winget first → Chocolatey fallback.
import { invoke } from '@tauri-apps/api/core';
import { runCommand, type CommandOutput } from './bridge';

export interface ToolResolution {
  name: string;
  path: string | null;
  source: 'bundled' | 'path' | 'missing';
}

/** Where the app finds a tool right now: bundled copy, on PATH, or missing. */
export function resolveTool(name: string): Promise<ToolResolution> {
  return invoke<ToolResolution>('resolve_tool', { name });
}

export interface PackageHit {
  manager: 'winget' | 'choco';
  id: string;
  name: string;
  version?: string;
}

// ---- winget ----
function parseWingetTable(out: string): PackageHit[] {
  const lines = out.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^Name\s+Id\s+Version/.test(l));
  const header = headerIdx >= 0 ? lines[headerIdx] : undefined;
  if (!header) return [];
  const idCol = header.indexOf('Id');
  const verCol = header.indexOf('Version');
  if (idCol < 0) return [];
  const hits: PackageHit[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.trim() || /packages? found/i.test(l)) continue;
    const name = l.slice(0, idCol).trim();
    const id = l.slice(idCol, verCol > idCol ? verCol : undefined).trim();
    if (!id) continue;
    hits.push({ manager: 'winget', id, name, version: verCol > 0 ? l.slice(verCol).trim() : undefined });
  }
  return hits;
}

async function wingetSearch(query: string): Promise<PackageHit[]> {
  try {
    const res = await runCommand('winget', [
      'search',
      query,
      '--accept-source-agreements',
      '--disable-interactivity',
    ]);
    if (/No package found/i.test(res.stdout)) return [];
    return parseWingetTable(res.stdout);
  } catch {
    return [];
  }
}

// ---- chocolatey ----
async function chocoSearch(query: string): Promise<PackageHit[]> {
  try {
    // -r/--limit-output gives clean machine-readable "id|version" lines.
    const res = await runCommand('choco', ['search', query, '-r', '--exact']);
    let lines = res.stdout.split(/\r?\n/).filter((l) => l.includes('|'));
    if (lines.length === 0) {
      const res2 = await runCommand('choco', ['search', query, '-r']);
      lines = res2.stdout.split(/\r?\n/).filter((l) => l.includes('|'));
    }
    return lines
      .map((l): PackageHit | null => {
        const parts = l.split('|');
        const id = parts[0]?.trim();
        if (!id) return null;
        return { manager: 'choco', id, name: id, version: parts[1]?.trim() };
      })
      .filter((h): h is PackageHit => h !== null);
  } catch {
    return [];
  }
}

/**
 * Find an installer for a tool: winget first, Chocolatey fallback. `preferId` (e.g.
 * "Git.Git") is tried as an exact winget id before a fuzzy search.
 */
export async function findInstall(query: string, preferId?: string): Promise<PackageHit | null> {
  if (preferId) {
    const exact = await wingetSearch(preferId);
    const match = exact.find((h) => h.id.toLowerCase() === preferId.toLowerCase());
    if (match) return match;
  }
  const w = await wingetSearch(query);
  if (w.length > 0) {
    const exact = w.find(
      (h) => h.name.toLowerCase() === query.toLowerCase() || h.id.toLowerCase().endsWith(query.toLowerCase()),
    );
    return exact ?? w[0] ?? null;
  }
  const c = await chocoSearch(query);
  if (c.length > 0) {
    const exact = c.find((h) => h.id.toLowerCase() === query.toLowerCase());
    return exact ?? c[0] ?? null;
  }
  return null;
}

export function installPackage(hit: PackageHit): Promise<CommandOutput> {
  if (hit.manager === 'winget') {
    return runCommand('winget', [
      'install',
      '--id',
      hit.id,
      '-e',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--disable-interactivity',
    ]);
  }
  return runCommand('choco', ['install', hit.id, '-y', '--no-progress']);
}
