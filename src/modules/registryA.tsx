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
};
