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
import { PingModule } from './PingModule';
import { PortScanModule } from './PortScanModule';
import { RecycleBinModule } from './RecycleBinModule';
import { VscodeModule } from './VscodeModule';
import { VirtualBoxModule } from './VirtualBoxModule';
import { YtdlpModule } from './YtdlpModule';
import { VivetoolModule } from './VivetoolModule';
import { ZoomItModule } from './ZoomItModule';
import { RustDeskModule } from './RustDeskModule';
import { WiresharkModule } from './WiresharkModule';
import { TerminalModule } from './TerminalModule';
import { PixelEditorModule } from './PixelEditorModule';
import { PgAdminModule } from './PgAdminModule';
import { SqliteBrowserModule } from './SqliteBrowserModule';
import { RainmeterModule } from './RainmeterModule';
import { WindhawkModule } from './WindhawkModule';
import { NilesoftShellModule } from './NilesoftShellModule';
import { PeekModule } from './PeekModule';
import { QuicktypeModule } from './QuicktypeModule';
import { SettingsHubModule } from './SettingsHubModule';
import { PdfToolkitModule } from './PdfToolkitModule';
import { TorrentModule } from './TorrentModule';
import { OllamaModule } from './OllamaModule';
import { SshModule } from './SshModule';
import { QbittorrentModule } from './QbittorrentModule';
import { PackerModule } from './PackerModule';
import { TestdiskModule } from './TestdiskModule';
import { NewPlusModule } from './NewPlusModule';
import { OneDriveModule } from './OneDriveModule';
import { ProxmoxModule } from './ProxmoxModule';
import { QuickAccentModule } from './QuickAccentModule';
import { RenameModule } from './RenameModule';
import { RichPreviewModule } from './RichPreviewModule';
import { ScreenRulerModule } from './ScreenRulerModule';
import { ShellMenuModule } from './ShellMenuModule';
import { ShortcutGuideModule } from './ShortcutGuideModule';
import { TaskbarTweakerModule } from './TaskbarTweakerModule';
import { TextOcrModule } from './TextOcrModule';
import { TimeLensModule } from './TimeLensModule';
import { TimeUnitModule } from './TimeUnitModule';
import { VaultVolumesModule } from './VaultVolumesModule';
import { ViaProxyModule } from './ViaProxyModule';
import { VoiceModule } from './VoiceModule';
import { WebClonerModule } from './WebClonerModule';
import { WebLoginModule } from './WebLoginModule';

/**
 * feature/modules-batch-b module registrations (N–Z web-capable tools + native OS/network
 * tools that run against the desktop backend). Kept in a
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
  'module.ping': PingModule,
  'module.portscan': PortScanModule,
  'module.recyclebin': RecycleBinModule,
  'module.vscode': VscodeModule,
  'module.virtualbox': VirtualBoxModule,
  'module.ytdlp': YtdlpModule,
  'module.vivetool': VivetoolModule,
  'module.zoomit': ZoomItModule,
  'module.rustdesk': RustDeskModule,
  'module.wireshark': WiresharkModule,
  'module.terminal': TerminalModule,
  'module.pixeleditor': PixelEditorModule,
  'module.pgadmin': PgAdminModule,
  'module.sqlitebrowser': SqliteBrowserModule,
  'module.rainmeter': RainmeterModule,
  'module.windhawk': WindhawkModule,
  'module.nilesoftshell': NilesoftShellModule,
  'module.peek': PeekModule,
  'module.quicktype': QuicktypeModule,
  'module.settingshub': SettingsHubModule,
  'module.pdftoolkit': PdfToolkitModule,
  'module.torrent': TorrentModule,
  'module.ollama': OllamaModule,
  'module.ssh': SshModule,
  'module.qbittorrent': QbittorrentModule,
  'module.packer': PackerModule,
  'module.testdisk': TestdiskModule,
  'module.newplus': NewPlusModule,
  'module.onedrive': OneDriveModule,
  'module.proxmox': ProxmoxModule,
  'module.quickaccent': QuickAccentModule,
  'module.rename': RenameModule,
  'module.richpreview': RichPreviewModule,
  'module.screenruler': ScreenRulerModule,
  'module.shellmenu': ShellMenuModule,
  'module.shortcutguide': ShortcutGuideModule,
  'module.taskbar-tweaker': TaskbarTweakerModule,
  'module.textocr': TextOcrModule,
  'module.timelens': TimeLensModule,
  'module.timeunit': TimeUnitModule,
  'module.vault-volumes': VaultVolumesModule,
  'module.viaproxy': ViaProxyModule,
  'module.voice': VoiceModule,
  'module.webcloner': WebClonerModule,
  'module.weblogin': WebLoginModule,
};
