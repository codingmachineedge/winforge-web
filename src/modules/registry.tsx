import type { ComponentType } from 'react';
import { ServicesModule } from './ServicesModule';
import { ProcessesModule } from './ProcessesModule';
import { EnvVarsModule } from './EnvVarsModule';
import { ConnectionsModule } from './ConnectionsModule';
import { DrivesModule } from './DrivesModule';
import { HostsModule } from './HostsModule';
import { PackagesModule } from './PackagesModule';

/**
 * Real, interactive module implementations keyed by WinForge page tag. A module here
 * runs live against the Rust backend (Tauri only). Tags not present fall back to the
 * generic native-probe / labelled stub in ModuleDetail.
 */
export const moduleRegistry: Record<string, ComponentType> = {
  'module.services': ServicesModule,
  'module.monitor': ProcessesModule,
  'module.procexp': ProcessesModule,
  'module.envvars': EnvVarsModule,
  'module.connections': ConnectionsModule,
  'module.drives': DrivesModule,
  'module.hosts': HostsModule,
  'module.packages': PackagesModule,
};

export function realModuleFor(tag: string): ComponentType | undefined {
  return moduleRegistry[tag];
}
