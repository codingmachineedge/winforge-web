// Thin typed wrapper over Tauri's `invoke`. When the app runs in a plain browser
// (vite dev / web deploy) there is no Tauri runtime, so `isTauri()` is false and the
// UI shows the labelled stub instead of calling the backend.
import { invoke } from '@tauri-apps/api/core';

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
}

export interface SysInfo {
  os: string;
  arch: string;
  family: string;
  hostname: string;
  cpus: number;
  exe: string;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** True when running inside the Tauri desktop shell (native backend available). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function runCommand(program: string, args: string[] = []): Promise<CommandOutput> {
  return invoke<CommandOutput>('run_command', { program, args });
}

export function runPowershell(script: string): Promise<CommandOutput> {
  return invoke<CommandOutput>('run_powershell', { script });
}

export function systemInfo(): Promise<SysInfo> {
  return invoke<SysInfo>('system_info');
}

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>('list_dir', { path });
}

export function getEnv(name: string): Promise<string> {
  return invoke<string>('get_env', { name });
}
