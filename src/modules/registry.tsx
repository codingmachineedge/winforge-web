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
import { EpochModule } from './EpochModule';
import { JwtModule } from './JwtModule';
import { IdGenModule } from './IdGenModule';
import { CsvJsonModule } from './CsvJsonModule';
import { UnitConvertModule } from './UnitConvertModule';
import { CronModule } from './CronModule';
import { TextDiffModule } from './TextDiffModule';
import { MarkdownModule } from './MarkdownModule';
import { DurationCalcModule } from './DurationCalcModule';
import { LoanCalcModule } from './LoanCalcModule';
import { HtmlEntitiesModule } from './HtmlEntitiesModule';
import { AspectRatioModule } from './AspectRatioModule';
import { ImgBase64Module } from './ImgBase64Module';
import { LoremTextModule } from './LoremTextModule';
import { PercentCalcModule } from './PercentCalcModule';
import { JsonFlattenModule } from './JsonFlattenModule';
import { CssFormatModule } from './CssFormatModule';
import { ApiClientModule } from './ApiClientModule';
import { CurlGenModule } from './CurlGenModule';
import { MdTableModule } from './MdTableModule';
import { TimerModule } from './TimerModule';
import { SqlFormatModule } from './SqlFormatModule';
import { CaseConvertModule } from './CaseConvertModule';
import { JsonPointerModule } from './JsonPointerModule';
import { JsonSortModule } from './JsonSortModule';
import { IniEditModule } from './IniEditModule';
import { EnvSubstModule } from './EnvSubstModule';
import { HtmlTableModule } from './HtmlTableModule';
import { JsonPathModule } from './JsonPathModule';
import { JsonPatchModule } from './JsonPatchModule';
import { JsonMergePatchModule } from './JsonMergePatchModule';
import { JsonToTsModule } from './JsonToTsModule';
import { CsvLintModule } from './CsvLintModule';
import { FakerModule } from './FakerModule';
import { JsonStatModule } from './JsonStatModule';
import { JsonlToolsModule } from './JsonlToolsModule';
import { TableFormatModule } from './TableFormatModule';
import { EnvFileModule } from './EnvFileModule';
import { XPathTesterModule } from './XPathTesterModule';
import { HexDumpModule } from './HexDumpModule';
import { moduleRegistryB } from './registryB';

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
  'module.epoch': EpochModule,
  'module.jwtbuild': JwtModule,
  'module.jwtinspect': JwtModule,
  'module.uuidv7': IdGenModule,
  'module.ulid': IdGenModule,
  'module.shortid': IdGenModule,
  'module.csvjson': CsvJsonModule,
  'module.unitconvert': UnitConvertModule,
  'module.cronnext': CronModule,
  'module.cronbuilder': CronModule,
  'module.textdiff': TextDiffModule,
  'module.markdown': MarkdownModule,
  'module.durationcalc': DurationCalcModule,
  'module.loancalc': LoanCalcModule,
  'module.htmlentities': HtmlEntitiesModule,
  'module.aspectratio': AspectRatioModule,
  'module.imgbase64': ImgBase64Module,
  'module.loremtext': LoremTextModule,
  'module.percentcalc': PercentCalcModule,
  'module.jsonflatten': JsonFlattenModule,
  'module.cssformat': CssFormatModule,
  'module.apiclient': ApiClientModule,
  'module.curlgen': CurlGenModule,
  'module.mdtable': MdTableModule,
  'module.timer': TimerModule,
  'module.sqlformat': SqlFormatModule,
  'module.caseconvert': CaseConvertModule,
  'module.jsonpointer': JsonPointerModule,
  'module.jsonsort': JsonSortModule,
  'module.iniedit': IniEditModule,
  'module.envsubst': EnvSubstModule,
  'module.htmltable': HtmlTableModule,
  'module.jsonpath': JsonPathModule,
  'module.jsonpatch': JsonPatchModule,
  'module.jsonmergepatch': JsonMergePatchModule,
  'module.jsontots': JsonToTsModule,
  'module.csvlint': CsvLintModule,
  'module.faker': FakerModule,
  'module.jsonstat': JsonStatModule,
  'module.jsonltools': JsonlToolsModule,
  'module.tableformat': TableFormatModule,
  'module.envfile': EnvFileModule,
  'module.xpathtester': XPathTesterModule,
  'module.hexdump': HexDumpModule,
  ...moduleRegistryB,
};

export function realModuleFor(tag: string): ComponentType | undefined {
  return moduleRegistry[tag];
}
