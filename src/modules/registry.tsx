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
import { JsonDiffModule } from './JsonDiffModule';
import { LineToolsModule } from './LineToolsModule';
import { HtmlToMdModule } from './HtmlToMdModule';
import { HtmlFormatModule } from './HtmlFormatModule';
import { MetaTagsModule } from './MetaTagsModule';
import { BinaryTextModule } from './BinaryTextModule';
import { JsonSchemaModule } from './JsonSchemaModule';
import { MarkdownTocModule } from './MarkdownTocModule';
import { AsciiTableModule } from './AsciiTableModule';
import { BoxTextModule } from './BoxTextModule';
import { CharMapModule } from './CharMapModule';
import { Base32Module } from './Base32Module';
import { LeetModule } from './LeetModule';
import { EmojiModule } from './EmojiModule';
import { EncodingConvModule } from './EncodingConvModule';
import { AsciiArtModule } from './AsciiArtModule';
import { ColorBlindModule } from './ColorBlindModule';
import { GradientModule } from './GradientModule';
import { Ascii85Module } from './Ascii85Module';
import { MorseModule } from './MorseModule';
import { GuidGenModule } from './GuidGenModule';
import { CheckDigitModule } from './CheckDigitModule';
import { MimeTypesModule } from './MimeTypesModule';
import { BarcodeModule } from './BarcodeModule';
import { HttpStatusModule } from './HttpStatusModule';
import { CiphersModule } from './CiphersModule';
import { BaseConvertModule } from './BaseConvertModule';
import { GitignoreModule } from './GitignoreModule';
import { CssUnitsModule } from './CssUnitsModule';
import { CalculatorModule } from './CalculatorModule';
import { EntropyModule } from './EntropyModule';
import { DateCalcModule } from './DateCalcModule';
import { ColorMixModule } from './ColorMixModule';
import { ContrastGridModule } from './ContrastGridModule';
import { GlobTesterModule } from './GlobTesterModule';
import { DnsRefModule } from './DnsRefModule';
import { BmiModule } from './BmiModule';
import { ColorNameModule } from './ColorNameModule';
import { CalendarMonthModule } from './CalendarMonthModule';
import { ColorPaletteModule } from './ColorPaletteModule';
import { ICalendarModule } from './ICalendarModule';
import { HttpHeaderRefModule } from './HttpHeaderRefModule';
import { LoremImgModule } from './LoremImgModule';
import { HeaderScoreModule } from './HeaderScoreModule';
import { HarAnalyzerModule } from './HarAnalyzerModule';
import { CountdownEventModule } from './CountdownEventModule';
import { ExpenseSplitModule } from './ExpenseSplitModule';
import { HabitTrackerModule } from './HabitTrackerModule';
import { HtmlPreviewModule } from './HtmlPreviewModule';
import { MacToolsModule } from './MacToolsModule';
import { FileSplitModule } from './FileSplitModule';
import { ClipInspectModule } from './ClipInspectModule';
import { DnsLookupModule } from './DnsLookupModule';
import { IpInfoModule } from './IpInfoModule';
import { DiskHealthModule } from './DiskHealthModule';
import { BatteryThermalModule } from './BatteryThermalModule';
import { DiskAnalyzerModule } from './DiskAnalyzerModule';
import { ClipboardModule } from './ClipboardModule';
import { DuplicatesModule } from './DuplicatesModule';
import { SystemDoctorsModule } from './SystemDoctorsModule';
import { DashboardModule } from './DashboardModule';
import { ArchivesModule } from './ArchivesModule';
import { BulkOpsModule } from './BulkOpsModule';
import { EverythingSearchModule } from './EverythingSearchModule';
import { FileLocksmithModule } from './FileLocksmithModule';
import { HexEditorModule } from './HexEditorModule';
import { DiskBenchmarkModule } from './DiskBenchmarkModule';
import { MouseModule } from './MouseModule';
import { AwakeModule } from './AwakeModule';
import { MediaModule } from './MediaModule';
import { CaptureStudioModule } from './CaptureStudioModule';
import { GifLabModule } from './GifLabModule';
import { VolumeMixerModule } from './VolumeMixerModule';
import { ColorPickerModule } from './ColorPickerModule';
import { ImageEditorModule } from './ImageEditorModule';
import { FontManagerModule } from './FontManagerModule';
import { LightSwitchModule } from './LightSwitchModule';
import { FancyZonesModule } from './FancyZonesModule';
import { KomorebiModule } from './KomorebiModule';
import { GlazeWmModule } from './GlazeWmModule';
import { AltSnapModule } from './AltSnapModule';
import { KeyboardModule } from './KeyboardModule';
import { HotkeyMacroModule } from './HotkeyMacroModule';
import { FeedReaderModule } from './FeedReaderModule';
import { FlashcardsModule } from './FlashcardsModule';
import { AndroidAdbModule } from './AndroidAdbModule';
import { FastbootModule } from './FastbootModule';
import { EmulatorModule } from './EmulatorModule';
import { DockerModule } from './DockerModule';
import { DockerSshModule } from './DockerSshModule';
import { AwsCliModule } from './AwsCliModule';
import { moduleRegistryB } from './registryB';
import { moduleRegistryA } from './registryA';

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
  'module.jsondiff': JsonDiffModule,
  'module.linetools': LineToolsModule,
  'module.htmltomd': HtmlToMdModule,
  'module.htmlformat': HtmlFormatModule,
  'module.metatags': MetaTagsModule,
  'module.binarytext': BinaryTextModule,
  'module.jsonschema': JsonSchemaModule,
  'module.markdowntoc': MarkdownTocModule,
  'module.asciitable': AsciiTableModule,
  'module.boxtext': BoxTextModule,
  'module.charmap': CharMapModule,
  'module.base32': Base32Module,
  'module.leet': LeetModule,
  'module.emoji': EmojiModule,
  'module.encodingconv': EncodingConvModule,
  'module.asciiart': AsciiArtModule,
  'module.colorblind': ColorBlindModule,
  'module.gradient': GradientModule,
  'module.ascii85': Ascii85Module,
  'module.morse': MorseModule,
  'module.guidgen': GuidGenModule,
  'module.checkdigit': CheckDigitModule,
  'module.mimetypes': MimeTypesModule,
  'module.barcode': BarcodeModule,
  'module.httpstatus': HttpStatusModule,
  'module.ciphers': CiphersModule,
  'module.baseconvert': BaseConvertModule,
  'module.gitignore': GitignoreModule,
  'module.cssunits': CssUnitsModule,
  'module.calculator': CalculatorModule,
  'module.entropy': EntropyModule,
  'module.datecalc': DateCalcModule,
  'module.colormix': ColorMixModule,
  'module.contrastgrid': ContrastGridModule,
  'module.globtester': GlobTesterModule,
  'module.dnsref': DnsRefModule,
  'module.bmi': BmiModule,
  'module.colorname': ColorNameModule,
  'module.calendarmonth': CalendarMonthModule,
  'module.colorpalette': ColorPaletteModule,
  'module.icalendar': ICalendarModule,
  'module.httpheaderref': HttpHeaderRefModule,
  ...moduleRegistryA,
  'module.loremimg': LoremImgModule,
  'module.headerscore': HeaderScoreModule,
  'module.haranalyzer': HarAnalyzerModule,
  'module.countdownevent': CountdownEventModule,
  'module.expensesplit': ExpenseSplitModule,
  'module.habittracker': HabitTrackerModule,
  'module.htmlpreview': HtmlPreviewModule,
  'module.mactools': MacToolsModule,
  'module.filesplit': FileSplitModule,
  'module.clipinspect': ClipInspectModule,
  'module.dnslookup': DnsLookupModule,
  'module.ipinfo': IpInfoModule,
  'module.diskhealth': DiskHealthModule,
  'module.battery': BatteryThermalModule,
  'module.disk': DiskAnalyzerModule,
  'module.clipboard': ClipboardModule,
  'module.duplicates': DuplicatesModule,
  'module.doctors': SystemDoctorsModule,
  'dashboard': DashboardModule,
  'module.archives': ArchivesModule,
  'module.bulkops': BulkOpsModule,
  'module.everything': EverythingSearchModule,
  'module.filelocksmith': FileLocksmithModule,
  'module.hexeditor': HexEditorModule,
  'module.diskbench': DiskBenchmarkModule,
  'module.mouse': MouseModule,
  'module.awake': AwakeModule,
  'module.media': MediaModule,
  'module.capture': CaptureStudioModule,
  'module.giflab': GifLabModule,
  'module.mixer': VolumeMixerModule,
  'module.colorpicker': ColorPickerModule,
  'module.imageeditor': ImageEditorModule,
  'module.fonts': FontManagerModule,
  'module.lightswitch': LightSwitchModule,
  'module.fancyzones': FancyZonesModule,
  'module.komorebi': KomorebiModule,
  'module.glazewm': GlazeWmModule,
  'module.altsnap': AltSnapModule,
  'module.keyboard': KeyboardModule,
  'module.hotkeys': HotkeyMacroModule,
  'module.feedreader': FeedReaderModule,
  'module.flashcards': FlashcardsModule,
  'module.adb': AndroidAdbModule,
  'module.fastboot': FastbootModule,
  'module.emulator': EmulatorModule,
  'module.docker': DockerModule,
  'module.dockerssh': DockerSshModule,
  'module.aws': AwsCliModule,
  ...moduleRegistryB,
};

export function realModuleFor(tag: string): ComponentType | undefined {
  return moduleRegistry[tag];
}
