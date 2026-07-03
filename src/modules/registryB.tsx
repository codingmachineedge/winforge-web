import type { ComponentType } from 'react';
import { SlugifyModule } from './SlugifyModule';
import { RomanNumModule } from './RomanNumModule';
import { TextSortModule } from './TextSortModule';
import { UnixPermModule } from './UnixPermModule';
import { TextStatsModule } from './TextStatsModule';
import { PhoneticModule } from './PhoneticModule';
import { SubnetCalcModule } from './SubnetCalcModule';
import { NumberFormatModule } from './NumberFormatModule';
import { TextEscapeModule } from './TextEscapeModule';
import { StringInspectorModule } from './StringInspectorModule';
import { StringCompareModule } from './StringCompareModule';
import { SemverRangeModule } from './SemverRangeModule';

/**
 * feature/modules-batch-b module registrations (N–Z web-capable tools). Kept in a
 * dedicated file so this agent never collides with concurrent edits to registry.tsx.
 * Merged into moduleRegistry by registry.tsx.
 */
export const moduleRegistryB: Record<string, ComponentType> = {
  'module.slugify': SlugifyModule,
  'module.romannum': RomanNumModule,
  'module.textsort': TextSortModule,
  'module.unixperm': UnixPermModule,
  'module.textstats': TextStatsModule,
  'module.phonetic': PhoneticModule,
  'module.subnetcalc': SubnetCalcModule,
  'module.numberformat': NumberFormatModule,
  'module.textescape': TextEscapeModule,
  'module.stringinspector': StringInspectorModule,
  'module.stringcompare': StringCompareModule,
  'module.semverrange': SemverRangeModule,
};
