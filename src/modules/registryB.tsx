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
import { SciNotationModule } from './SciNotationModule';
import { UnitPriceModule } from './UnitPriceModule';
import { TextWrapModule } from './TextWrapModule';
import { NumSeqModule } from './NumSeqModule';
import { UrlToolsModule } from './UrlToolsModule';
import { TextColumnsModule } from './TextColumnsModule';
import { TallyCounterModule } from './TallyCounterModule';
import { NumWordsXModule } from './NumWordsXModule';
import { NameGenModule } from './NameGenModule';
import { NotesModule } from './NotesModule';
import { PasswordStrengthModule } from './PasswordStrengthModule';
import { PathDoctorModule } from './PathDoctorModule';
import { QueryEditModule } from './QueryEditModule';
import { RandomizerModule } from './RandomizerModule';
import { RegexCheatModule } from './RegexCheatModule';
import { SubnetV6Module } from './SubnetV6Module';
import { SymbolsModule } from './SymbolsModule';
import { TextRedactModule } from './TextRedactModule';
import { TextReplaceModule } from './TextReplaceModule';
import { TextTemplateModule } from './TextTemplateModule';
import { TomlJsonModule } from './TomlJsonModule';
import { TotpModule } from './TotpModule';
import { TzPlannerModule } from './TzPlannerModule';
import { UnicodeInspectModule } from './UnicodeInspectModule';
import { UuidV5Module } from './UuidV5Module';
import { WolModule } from './WolModule';
import { WordFreqModule } from './WordFreqModule';
import { WorldClockModule } from './WorldClockModule';
import { YamlJsonModule } from './YamlJsonModule';

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
  'module.scinotation': SciNotationModule,
  'module.unitprice': UnitPriceModule,
  'module.textwrap': TextWrapModule,
  'module.numseq': NumSeqModule,
  'module.urltools': UrlToolsModule,
  'module.textcolumns': TextColumnsModule,
  'module.tallycounter': TallyCounterModule,
  'module.numwordsx': NumWordsXModule,
'module.namegen': NameGenModule,
  'module.notes': NotesModule,
  'module.passwordstrength': PasswordStrengthModule,
  'module.pathdoctor': PathDoctorModule,
  'module.queryedit': QueryEditModule,
  'module.randomizer': RandomizerModule,
  'module.regexcheat': RegexCheatModule,
  'module.subnetv6': SubnetV6Module,
  'module.symbols': SymbolsModule,
  'module.textredact': TextRedactModule,
  'module.textreplace': TextReplaceModule,
  'module.texttemplate': TextTemplateModule,
  'module.tomljson': TomlJsonModule,
  'module.totp': TotpModule,
  'module.tzplanner': TzPlannerModule,
  'module.unicodeinspect': UnicodeInspectModule,
  'module.uuidv5': UuidV5Module,
  'module.wol': WolModule,
  'module.wordfreq': WordFreqModule,
  'module.worldclock': WorldClockModule,
  'module.yamljson': YamlJsonModule,
  'module.numwords': NumWordsXModule,
};
