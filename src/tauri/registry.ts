// Real Windows-registry apply for the uniform tweaks, mirroring WinForge's RegistryHelper
// (ValueEquals / SetValue / DeleteValue) via the Tauri PowerShell backend. This is a
// LOW-LEVEL DESKTOP capability: it only runs inside the Tauri shell (isTauri()); in a plain
// browser the calls throw, and the UI shows the inert reference instead — WinForge Web is a
// desktop app, not a website.
import { isTauri, runPowershell, type CommandOutput } from './bridge';
import type { RegToggleOp, RegRadioOp, RegRoot, RegKind } from '../data/tweakOps';

const HIVE: Record<RegRoot, string> = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKU: 'HKEY_USERS',
};

/** PowerShell single-quote escape. */
const q = (s: string) => s.replace(/'/g, "''");

/** The `Registry::HKEY_…\path` provider path — hive-explicit, so no PSDrive is required. */
export function regProviderPath(root: RegRoot, path: string): string {
  return `Registry::${HIVE[root]}\\${path}`;
}

/** Format a value for `-Value`: numeric kinds bare, string kinds quoted. */
function psValue(v: number | string, kind: RegKind): string {
  if (kind === 'DWord' || kind === 'QWord') {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
    return String(Number.isFinite(n) ? n : 0);
  }
  return `'${q(String(v))}'`;
}

// ---- pure, unit-testable PowerShell builders (one op each) ------------------

/** Read a value and echo it (empty output ⇒ unset). Mirrors reading for ValueEquals. */
export function readScript(root: RegRoot, path: string, name: string): string {
  const p = q(regProviderPath(root, path));
  const n = q(name);
  return `$ErrorActionPreference='SilentlyContinue'; $v = (Get-ItemProperty -LiteralPath '${p}' -Name '${n}' -ErrorAction SilentlyContinue).'${n}'; if ($null -ne $v) { "$v" }`;
}

/** Create the key if needed and write the value with its exact kind. Mirrors SetValue. */
export function setScript(root: RegRoot, path: string, name: string, value: number | string, kind: RegKind): string {
  const p = q(regProviderPath(root, path));
  const n = q(name);
  return `$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath '${p}')) { New-Item -Path '${p}' -Force | Out-Null }; New-ItemProperty -LiteralPath '${p}' -Name '${n}' -Value ${psValue(value, kind)} -PropertyType ${kind} -Force | Out-Null`;
}

/** Delete the value. Mirrors DeleteValue (used when a toggle's offValue is null). */
export function deleteScript(root: RegRoot, path: string, name: string): string {
  const p = q(regProviderPath(root, path));
  const n = q(name);
  return `Remove-ItemProperty -LiteralPath '${p}' -Name '${n}' -Force -ErrorAction SilentlyContinue`;
}

// ---- high-level operations (desktop/Tauri only) ----------------------------

async function ps(script: string): Promise<CommandOutput> {
  if (!isTauri()) throw new Error('Registry operations require the WinForge desktop app.');
  return runPowershell(script);
}

/** The raw current value (as a string) or null when unset. */
export async function readValue(root: RegRoot, path: string, name: string): Promise<string | null> {
  const out = await ps(readScript(root, path, name));
  const s = out.stdout.trim();
  return s === '' ? null : s;
}

/** Whether a toggle is currently ON — its value equals the tweak's onValue (mirrors ValueEquals). */
export async function isToggleOn(op: RegToggleOp): Promise<boolean> {
  const v = await readValue(op.root, op.path, op.name);
  return v !== null && v === String(op.on);
}

/** Apply a toggle: write onValue, or write offValue (or delete when offValue is null). */
export async function applyToggle(op: RegToggleOp, on: boolean): Promise<CommandOutput> {
  if (on) return ps(setScript(op.root, op.path, op.name, op.on, op.kind));
  if (op.off === null) return ps(deleteScript(op.root, op.path, op.name));
  return ps(setScript(op.root, op.path, op.name, op.off, op.kind));
}

/** The currently-selected radio value (as a string) or null when none matches. */
export async function currentChoice(op: RegRadioOp): Promise<string | null> {
  const v = await readValue(op.root, op.path, op.name);
  if (v === null) return null;
  const hit = op.options.find((o) => String(o.value) === v);
  return hit ? String(hit.value) : null;
}

/** Apply a radio choice: write the chosen value (numeric or string, per the tweak's kind). */
export async function applyChoice(op: RegRadioOp, value: number | string): Promise<CommandOutput> {
  return ps(setScript(op.root, op.path, op.name, value, op.kind));
}
