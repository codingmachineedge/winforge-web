import { moduleRegistry } from './registry';
import { nativeActions } from '../tauri/nativeActions';

// Honest implementation status of a module, independent of its web/native capability.
//   working — a full interactive implementation exists (real module component)
//   partial — a read-only live backend probe exists, but not the full feature yet
//   stub    — catalog card only; feature not yet ported from WinForge
export type ModuleStatus = 'working' | 'partial' | 'stub';

export function moduleStatus(tag: string): ModuleStatus {
  if (tag in moduleRegistry) return 'working';
  if (tag in nativeActions) return 'partial';
  return 'stub';
}

export function statusCounts(tags: string[]): Record<ModuleStatus, number> {
  const c: Record<ModuleStatus, number> = { working: 0, partial: 0, stub: 0 };
  for (const t of tags) c[moduleStatus(t)]++;
  return c;
}
