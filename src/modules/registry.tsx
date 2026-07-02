import type { ComponentType } from 'react';
import { ServicesModule } from './ServicesModule';
import { ProcessesModule } from './ProcessesModule';
import { EnvVarsModule } from './EnvVarsModule';
import { ConnectionsModule } from './ConnectionsModule';
import { DrivesModule } from './DrivesModule';
import { HostsModule } from './HostsModule';
import { PackagesModule } from './PackagesModule';
import { NmapModule } from './NmapModule';
import { GitModule } from './GitModule';
import { ProcExplorerModule } from './ProcExplorerModule';
import { StartupModule } from './StartupModule';
import { ScheduledTasksModule } from './ScheduledTasksModule';
import { EventsModule } from './EventsModule';
import { DevicesModule } from './DevicesModule';
import { SysInfoModule } from './SysInfoModule';
import { JsonToolsModule } from './JsonToolsModule';
import { ColorToolsModule } from './ColorToolsModule';
import { TextToolsModule } from './TextToolsModule';
import { EncoderModule } from './EncoderModule';
import { RegexTesterModule } from './RegexTesterModule';
import { PassGenModule } from './PassGenModule';
import { HasherModule } from './HasherModule';

/**
 * Real, interactive module implementations keyed by WinForge page tag. A module here
 * runs live against the Rust backend (Tauri only). Tags not present fall back to the
 * generic native-probe / labelled stub in ModuleDetail.
 */
export const moduleRegistry: Record<string, ComponentType> = {
  'module.services': ServicesModule,
  'module.monitor': ProcessesModule,
  'module.procexp': ProcExplorerModule,
  'module.envvars': EnvVarsModule,
  'module.connections': ConnectionsModule,
  'module.drives': DrivesModule,
  'module.hosts': HostsModule,
  'module.packages': PackagesModule,
  'module.nmap': NmapModule,
  'module.git': GitModule,
  'module.startup': StartupModule,
  'module.tasks': ScheduledTasksModule,
  'module.events': EventsModule,
  'module.devices': DevicesModule,
  'module.winfetch': SysInfoModule,
  'module.jsontools': JsonToolsModule,
  'module.colortools': ColorToolsModule,
  'module.texttools': TextToolsModule,
  'module.encoder': EncoderModule,
  'module.regextester': RegexTesterModule,
  'module.diceware': PassGenModule,
  'module.passgen': PassGenModule,
  'module.hasher': HasherModule,
};

export function realModuleFor(tag: string): ComponentType | undefined {
  return moduleRegistry[tag];
}
