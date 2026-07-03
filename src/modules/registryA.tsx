import type { ComponentType } from 'react';
import { HtmlPreviewModule } from './HtmlPreviewModule';
import { HttpHeadersModule } from './HttpHeadersModule';
import { HarAnalyzerModule } from './HarAnalyzerModule';
import { DnsLookupModule } from './DnsLookupModule';
import { IpInfoModule } from './IpInfoModule';
import { MacToolsModule } from './MacToolsModule';
import { HostsEditModule } from './HostsEditModule';
import { EnvDiffModule } from './EnvDiffModule';
import { ClipInspectModule } from './ClipInspectModule';
import { CountdownEventModule } from './CountdownEventModule';
import { ExpenseSplitModule } from './ExpenseSplitModule';
import { HabitTrackerModule } from './HabitTrackerModule';
import { FileSplitModule } from './FileSplitModule';
import { GridDispatchModule } from './GridDispatchModule';
import { H2PlantModule } from './H2PlantModule';
import { AiClusterModule } from './AiClusterModule';
import { ComputeMineModule } from './ComputeMineModule';
import { SmelterModule } from './SmelterModule';
import { EvChargeModule } from './EvChargeModule';
import { DistrictHeatModule } from './DistrictHeatModule';
import { DacModule } from './DacModule';
import { SteelMillModule } from './SteelMillModule';
import { CementKilnModule } from './CementKilnModule';
import { CakeFactoryModule } from './CakeFactoryModule';

/**
 * Batch-A (A–M) module registrations in their own file so this agent adds modules
 * without touching shared registry.tsx. Spread into moduleRegistry via ...moduleRegistryA.
 */
export const moduleRegistryA: Record<string, ComponentType> = {
  'module.htmlpreview': HtmlPreviewModule,
  'module.httpheaders': HttpHeadersModule,
  'module.haranalyzer': HarAnalyzerModule,
  'module.dnslookup': DnsLookupModule,
  'module.ipinfo': IpInfoModule,
  'module.mactools': MacToolsModule,
  'module.hostsedit': HostsEditModule,
  'module.envdiff': EnvDiffModule,
  'module.clipinspect': ClipInspectModule,
  'module.countdownevent': CountdownEventModule,
  'module.expensesplit': ExpenseSplitModule,
  'module.habittracker': HabitTrackerModule,
  'module.filesplit': FileSplitModule,
  'module.griddispatch': GridDispatchModule,
  'module.h2plant': H2PlantModule,
  'module.aicluster': AiClusterModule,
  'module.computemine': ComputeMineModule,
  'module.smelter': SmelterModule,
  'module.evcharge': EvChargeModule,
  'module.districtheat': DistrictHeatModule,
  'module.dac': DacModule,
  'module.steelmill': SteelMillModule,
  'module.cementkiln': CementKilnModule,
  'module.cakefactory': CakeFactoryModule,
};
