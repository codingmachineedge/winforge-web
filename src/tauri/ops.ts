// Typed frontend wrapper for the vetted-operation allowlist (feature #33).
//
// Mirrors the Rust `VettedOp` enum (src-tauri/src/ops.rs) as a TS discriminated
// union tagged by `op`. Unlike runCommand/runPowershell in bridge.ts, every op here
// maps to a fixed program + validated argv on the backend — this is the safe path
// for well-known Windows housekeeping.
import { invoke } from '@tauri-apps/api/core';

/** Result of a vetted operation. Mirrors Rust `OpOutput`. */
export interface OpOutput {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
  /** The fixed program the backend actually executed (audit trail). */
  program: string;
  /** The exact argv passed (audit trail). */
  args: string[];
}

/**
 * Discriminated union mirroring Rust `VettedOp` (serde tag = "op", snake_case).
 * Parameters are validated backend-side; the shapes here document the contract.
 */
export type VettedOp =
  | { op: 'restart_explorer' }
  | { op: 'open_settings_page'; page: string } // page must match [a-z0-9-]+
  | { op: 'empty_recycle_bin' }
  | { op: 'flush_dns' }
  | { op: 'ip_config' }
  | { op: 'arp_table' }
  | { op: 'open_known_folder'; folder: KnownFolder }
  | { op: 'clipboard_settings' }
  | { op: 'restart_print_spooler' }
  | { op: 'rebuild_icon_cache' }
  | { op: 'power_scheme_info' }
  | { op: 'open_windows_update' };

/** The known-folder tokens accepted by the `open_known_folder` op (backend allowlist). */
export type KnownFolder =
  | 'downloads'
  | 'documents'
  | 'desktop'
  | 'pictures'
  | 'music'
  | 'videos'
  | 'startup'
  | 'appdata'
  | 'localappdata'
  | 'temp';

/** True when running inside the Tauri desktop shell (same guard as bridge.ts). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Pure client-side pre-validation for the `open_settings_page` op, matching the
 * backend `validate_settings_page`: 1..=64 chars of [a-z0-9-]. Exposed (and tested)
 * so callers can validate before invoking; the backend re-validates regardless.
 */
export function isValidSettingsPage(page: string): boolean {
  return page.length >= 1 && page.length <= 64 && /^[a-z0-9-]+$/.test(page);
}

/** The set of known-folder tokens the backend accepts (kept in sync with Rust). */
export const KNOWN_FOLDERS: readonly KnownFolder[] = [
  'downloads',
  'documents',
  'desktop',
  'pictures',
  'music',
  'videos',
  'startup',
  'appdata',
  'localappdata',
  'temp',
];

/** Type guard: is `s` one of the accepted known-folder tokens? */
export function isKnownFolder(s: string): s is KnownFolder {
  return (KNOWN_FOLDERS as readonly string[]).includes(s);
}

/**
 * Run a vetted operation. The backend maps each variant to a fixed program +
 * validated argv, so this cannot be used to run arbitrary commands.
 */
export function runOp(op: VettedOp): Promise<OpOutput> {
  return invoke<OpOutput>('run_op', { op });
}
