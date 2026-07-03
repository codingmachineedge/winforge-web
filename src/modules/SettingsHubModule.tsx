import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, isTauri, type CommandOutput } from '../tauri/bridge';

// Native module — Settings & Control Panel launcher hub.
// Faithful port of WinForge's SettingsHubModule "Open in Windows" mode: every common
// ms-settings: page and Control Panel applet / *.cpl file, grouped by category and
// searchable across both languages, opened via the real launch command through the
// native backend (Process.Start → here: control.exe / explorer.exe on the desktop).
//
// This is a built-in OS capability (no external CLI tool), so live launching is gated
// on isTauri(); in a plain browser we show a "requires the desktop app" note but still
// render the full, searchable catalog and each entry's exact command.

type Kind = 'settings' | 'applet' | 'cpl';

interface Entry {
  kind: Kind;
  target: string;
  en: string;
  zh: string;
  keywords: string;
}

// The technical command string shown to the user — mirrors SettingsHubEntry.CommandText.
function commandText(e: Entry): string {
  if (e.kind === 'applet') return `control /name ${e.target}`;
  if (e.kind === 'cpl') return e.target === 'control.exe' ? 'control.exe' : `control ${e.target}`;
  return e.target;
}

function haystack(e: Entry): string {
  return `${e.en} ${e.zh} ${e.keywords} ${e.target} ${commandText(e)}`.toLowerCase();
}

// ── ms-settings: pages · 現代「設定」頁 ──────────────────────────────────────────
const SETTINGS_PAGES: Entry[] = [
  { kind: 'settings', target: 'ms-settings:', en: 'Settings (home)', zh: '設定（主頁）', keywords: 'settings home main 設定 主頁' },
  { kind: 'settings', target: 'ms-settings:system', en: 'System', zh: '系統', keywords: 'system 系統' },
  { kind: 'settings', target: 'ms-settings:display', en: 'Display', zh: '顯示', keywords: 'display screen resolution scaling monitor 顯示 螢幕 解析度 縮放' },
  { kind: 'settings', target: 'ms-settings:nightlight', en: 'Night light', zh: '夜燈', keywords: 'night light blue 夜燈 藍光' },
  { kind: 'settings', target: 'ms-settings:display-advanced', en: 'Advanced display (refresh rate)', zh: '進階顯示（更新率）', keywords: 'refresh rate hz advanced display 更新率 進階顯示' },
  { kind: 'settings', target: 'ms-settings:sound', en: 'Sound', zh: '音效', keywords: 'sound audio output input volume 音效 聲音 音量' },
  { kind: 'settings', target: 'ms-settings:apps-volume', en: 'Volume mixer (app sound)', zh: '音量混合器（程式音效）', keywords: 'volume mixer app sound 音量 混合器' },
  { kind: 'settings', target: 'ms-settings:notifications', en: 'Notifications', zh: '通知', keywords: 'notifications focus 通知 專注' },
  { kind: 'settings', target: 'ms-settings:quiethours', en: 'Focus / Do not disturb', zh: '專注／勿擾', keywords: 'focus assist do not disturb quiet hours 專注 勿擾' },
  { kind: 'settings', target: 'ms-settings:powersleep', en: 'Power & sleep', zh: '電源與睡眠', keywords: 'power sleep battery 電源 睡眠 電池' },
  { kind: 'settings', target: 'ms-settings:batterysaver', en: 'Battery saver', zh: '省電模式', keywords: 'battery saver power 省電 電池' },
  { kind: 'settings', target: 'ms-settings:storagesense', en: 'Storage', zh: '儲存體', keywords: 'storage sense disk cleanup space 儲存 磁碟 清理' },
  { kind: 'settings', target: 'ms-settings:multitasking', en: 'Multitasking', zh: '多工', keywords: 'multitasking snap alt-tab 多工 貼齊' },
  { kind: 'settings', target: 'ms-settings:clipboard', en: 'Clipboard', zh: '剪貼簿', keywords: 'clipboard history sync 剪貼簿 歷史' },
  { kind: 'settings', target: 'ms-settings:remotedesktop', en: 'Remote Desktop', zh: '遠端桌面', keywords: 'remote desktop rdp 遠端 桌面' },
  { kind: 'settings', target: 'ms-settings:about', en: 'About this PC', zh: '關於此電腦', keywords: 'about device specs system info 關於 規格 系統資訊' },

  { kind: 'settings', target: 'ms-settings:bluetooth', en: 'Bluetooth & devices', zh: '藍牙與裝置', keywords: 'bluetooth devices pair 藍牙 裝置 配對' },
  { kind: 'settings', target: 'ms-settings:printers', en: 'Printers & scanners', zh: '印表機與掃描器', keywords: 'printers scanners print 印表機 掃描器 列印' },
  { kind: 'settings', target: 'ms-settings:mousetouchpad', en: 'Mouse', zh: '滑鼠', keywords: 'mouse pointer 滑鼠 指標' },
  { kind: 'settings', target: 'ms-settings:devices-touchpad', en: 'Touchpad', zh: '觸控板', keywords: 'touchpad gestures 觸控板 手勢' },
  { kind: 'settings', target: 'ms-settings:typing', en: 'Typing', zh: '輸入', keywords: 'typing autocorrect suggestions 輸入 自動更正' },
  { kind: 'settings', target: 'ms-settings:pen', en: 'Pen & Windows Ink', zh: '手寫筆與 Windows Ink', keywords: 'pen ink stylus 手寫筆' },
  { kind: 'settings', target: 'ms-settings:autoplay', en: 'AutoPlay', zh: '自動播放', keywords: 'autoplay removable media 自動播放' },
  { kind: 'settings', target: 'ms-settings:usb', en: 'USB', zh: 'USB', keywords: 'usb connection 連線' },

  { kind: 'settings', target: 'ms-settings:network', en: 'Network & internet', zh: '網絡與互聯網', keywords: 'network internet 網絡 互聯網' },
  { kind: 'settings', target: 'ms-settings:network-status', en: 'Network status', zh: '網絡狀態', keywords: 'network status 網絡 狀態' },
  { kind: 'settings', target: 'ms-settings:network-wifi', en: 'Wi-Fi', zh: 'Wi-Fi', keywords: 'wifi wireless 無線 網絡' },
  { kind: 'settings', target: 'ms-settings:network-ethernet', en: 'Ethernet', zh: '乙太網路', keywords: 'ethernet lan wired 乙太 有線' },
  { kind: 'settings', target: 'ms-settings:network-vpn', en: 'VPN', zh: 'VPN', keywords: 'vpn 虛擬私人網絡' },
  { kind: 'settings', target: 'ms-settings:network-mobilehotspot', en: 'Mobile hotspot', zh: '行動熱點', keywords: 'hotspot tethering 熱點 分享' },
  { kind: 'settings', target: 'ms-settings:network-airplanemode', en: 'Airplane mode', zh: '飛航模式', keywords: 'airplane flight mode 飛航 飛行' },
  { kind: 'settings', target: 'ms-settings:network-proxy', en: 'Proxy', zh: 'Proxy 代理', keywords: 'proxy 代理 伺服器' },

  { kind: 'settings', target: 'ms-settings:personalization', en: 'Personalization', zh: '個人化', keywords: 'personalization theme 個人化 主題' },
  { kind: 'settings', target: 'ms-settings:personalization-background', en: 'Background (wallpaper)', zh: '背景（桌布）', keywords: 'background wallpaper desktop 背景 桌布' },
  { kind: 'settings', target: 'ms-settings:personalization-colors', en: 'Colors (accent / dark mode)', zh: '色彩（強調色／深色模式）', keywords: 'colors accent dark light mode 色彩 強調色 深色 淺色' },
  { kind: 'settings', target: 'ms-settings:themes', en: 'Themes', zh: '主題', keywords: 'themes 主題' },
  { kind: 'settings', target: 'ms-settings:lockscreen', en: 'Lock screen', zh: '鎖定畫面', keywords: 'lock screen 鎖定 畫面' },
  { kind: 'settings', target: 'ms-settings:personalization-start', en: 'Start', zh: '開始功能表', keywords: 'start menu 開始 功能表' },
  { kind: 'settings', target: 'ms-settings:taskbar', en: 'Taskbar', zh: '工作列', keywords: 'taskbar tray 工作列 系統匣' },
  { kind: 'settings', target: 'ms-settings:fonts', en: 'Fonts', zh: '字型', keywords: 'fonts typeface 字型 字體' },

  { kind: 'settings', target: 'ms-settings:appsfeatures', en: 'Installed apps', zh: '已安裝的應用程式', keywords: 'apps features installed uninstall 應用程式 解除安裝' },
  { kind: 'settings', target: 'ms-settings:optionalfeatures', en: 'Optional features', zh: '選用功能', keywords: 'optional features add 選用 功能' },
  { kind: 'settings', target: 'ms-settings:defaultapps', en: 'Default apps', zh: '預設應用程式', keywords: 'default apps browser 預設 瀏覽器' },
  { kind: 'settings', target: 'ms-settings:startupapps', en: 'Startup apps', zh: '啟動應用程式', keywords: 'startup boot logon 啟動 開機' },

  { kind: 'settings', target: 'ms-settings:yourinfo', en: 'Your info (account)', zh: '您的資訊（帳戶）', keywords: 'account info microsoft 帳戶 資訊' },
  { kind: 'settings', target: 'ms-settings:emailandaccounts', en: 'Email & accounts', zh: '電子郵件與帳戶', keywords: 'email accounts 郵件 帳戶' },
  { kind: 'settings', target: 'ms-settings:signinoptions', en: 'Sign-in options', zh: '登入選項', keywords: 'sign-in pin password hello 登入 密碼' },
  { kind: 'settings', target: 'ms-settings:windowshello', en: 'Windows Hello (face/finger)', zh: 'Windows Hello（臉部／指紋）', keywords: 'hello face fingerprint biometric 臉部 指紋 生物辨識' },
  { kind: 'settings', target: 'ms-settings:otherusers', en: 'Other users', zh: '其他使用者', keywords: 'users family accounts 使用者 家庭' },
  { kind: 'settings', target: 'ms-settings:sync', en: 'Windows backup / sync', zh: 'Windows 備份／同步', keywords: 'sync backup settings 備份 同步' },

  { kind: 'settings', target: 'ms-settings:dateandtime', en: 'Date & time', zh: '日期與時間', keywords: 'date time clock timezone 日期 時間 時區' },
  { kind: 'settings', target: 'ms-settings:regionlanguage', en: 'Language & region', zh: '語言與地區', keywords: 'language region locale 語言 地區' },
  { kind: 'settings', target: 'ms-settings:speech', en: 'Speech', zh: '語音', keywords: 'speech voice recognition 語音 辨識' },

  { kind: 'settings', target: 'ms-settings:gaming-gamebar', en: 'Game Bar', zh: '遊戲列', keywords: 'game bar overlay 遊戲列' },
  { kind: 'settings', target: 'ms-settings:gaming-gamemode', en: 'Game Mode', zh: '遊戲模式', keywords: 'game mode 遊戲模式' },
  { kind: 'settings', target: 'ms-settings:gaming-gamedvr', en: 'Captures (Game DVR)', zh: '擷取（Game DVR）', keywords: 'captures game dvr record 擷取 錄影' },

  { kind: 'settings', target: 'ms-settings:easeofaccess', en: 'Accessibility', zh: '協助工具', keywords: 'accessibility ease of access 協助工具 無障礙' },
  { kind: 'settings', target: 'ms-settings:easeofaccess-magnifier', en: 'Magnifier', zh: '放大鏡', keywords: 'magnifier zoom 放大鏡' },
  { kind: 'settings', target: 'ms-settings:easeofaccess-highcontrast', en: 'Contrast themes', zh: '對比佈景主題', keywords: 'high contrast 高對比' },
  { kind: 'settings', target: 'ms-settings:easeofaccess-narrator', en: 'Narrator', zh: '朗讀程式', keywords: 'narrator screen reader 朗讀 螢幕閱讀' },

  { kind: 'settings', target: 'ms-settings:privacy', en: 'Privacy & security', zh: '隱私權與安全性', keywords: 'privacy security 隱私 安全' },
  { kind: 'settings', target: 'ms-settings:privacy-location', en: 'Location', zh: '位置', keywords: 'location gps privacy 位置 定位' },
  { kind: 'settings', target: 'ms-settings:privacy-webcam', en: 'Camera', zh: '相機', keywords: 'camera webcam privacy 相機 攝影機' },
  { kind: 'settings', target: 'ms-settings:privacy-microphone', en: 'Microphone', zh: '麥克風', keywords: 'microphone privacy 麥克風' },
  { kind: 'settings', target: 'ms-settings:windowsdefender', en: 'Windows Security', zh: 'Windows 安全性', keywords: 'windows security defender antivirus 防毒 安全' },
  { kind: 'settings', target: 'ms-settings:findmydevice', en: 'Find my device', zh: '尋找我的裝置', keywords: 'find my device 尋找 裝置' },

  { kind: 'settings', target: 'ms-settings:windowsupdate', en: 'Windows Update', zh: 'Windows Update', keywords: 'update windows update 更新' },
  { kind: 'settings', target: 'ms-settings:windowsupdate-history', en: 'Update history', zh: '更新記錄', keywords: 'update history 更新 記錄' },
  { kind: 'settings', target: 'ms-settings:recovery', en: 'Recovery (reset this PC)', zh: '復原（重設此電腦）', keywords: 'recovery reset reinstall 復原 重設 還原' },
  { kind: 'settings', target: 'ms-settings:troubleshoot', en: 'Troubleshoot', zh: '疑難排解', keywords: 'troubleshoot fix 疑難排解 修復' },
  { kind: 'settings', target: 'ms-settings:activation', en: 'Activation', zh: '啟用', keywords: 'activation license key 啟用 授權 金鑰' },
  { kind: 'settings', target: 'ms-settings:developers', en: 'For developers', zh: '供開發人員使用', keywords: 'developers developer mode sudo 開發人員 開發者模式' },
];

// ── Control Panel applets · 傳統控制台 applet（control /name CanonicalName）───────
const CONTROL_APPLETS: Entry[] = [
  { kind: 'applet', target: 'Microsoft.AdministrativeTools', en: 'Administrative Tools', zh: '系統管理工具', keywords: 'administrative tools 系統管理 工具' },
  { kind: 'applet', target: 'Microsoft.BitLockerDriveEncryption', en: 'BitLocker Drive Encryption', zh: 'BitLocker 磁碟機加密', keywords: 'bitlocker encryption 加密 磁碟' },
  { kind: 'applet', target: 'Microsoft.ColorManagement', en: 'Color Management', zh: '色彩管理', keywords: 'color management icc profile 色彩 管理' },
  { kind: 'applet', target: 'Microsoft.CredentialManager', en: 'Credential Manager', zh: '認證管理員', keywords: 'credential manager passwords vault 認證 密碼' },
  { kind: 'applet', target: 'Microsoft.DateAndTime', en: 'Date and Time', zh: '日期和時間', keywords: 'date time clock 日期 時間' },
  { kind: 'applet', target: 'Microsoft.DefaultPrograms', en: 'Default Programs', zh: '預設程式', keywords: 'default programs associations 預設 程式' },
  { kind: 'applet', target: 'Microsoft.DeviceManager', en: 'Device Manager', zh: '裝置管理員', keywords: 'device manager drivers hardware 裝置 驅動程式' },
  { kind: 'applet', target: 'Microsoft.DevicesAndPrinters', en: 'Devices and Printers', zh: '裝置和印表機', keywords: 'devices printers 裝置 印表機' },
  { kind: 'applet', target: 'Microsoft.FileExplorerOptions', en: 'File Explorer Options', zh: '檔案總管選項', keywords: 'folder options file explorer 資料夾 選項 檔案總管' },
  { kind: 'applet', target: 'Microsoft.FileHistory', en: 'File History', zh: '檔案歷程記錄', keywords: 'file history backup 檔案 歷程 備份' },
  { kind: 'applet', target: 'Microsoft.Fonts', en: 'Fonts', zh: '字型', keywords: 'fonts 字型' },
  { kind: 'applet', target: 'Microsoft.IndexingOptions', en: 'Indexing Options', zh: '索引選項', keywords: 'indexing search options 索引 搜尋' },
  { kind: 'applet', target: 'Microsoft.InternetOptions', en: 'Internet Options', zh: '網際網路選項', keywords: 'internet options inetcpl proxy 網際網路 選項' },
  { kind: 'applet', target: 'Microsoft.Keyboard', en: 'Keyboard', zh: '鍵盤', keywords: 'keyboard repeat 鍵盤' },
  { kind: 'applet', target: 'Microsoft.Mouse', en: 'Mouse', zh: '滑鼠', keywords: 'mouse buttons pointer 滑鼠 指標' },
  { kind: 'applet', target: 'Microsoft.NetworkAndSharingCenter', en: 'Network and Sharing Center', zh: '網路和共用中心', keywords: 'network sharing center adapters 網路 共用 介面卡' },
  { kind: 'applet', target: 'Microsoft.PowerOptions', en: 'Power Options', zh: '電源選項', keywords: 'power options plans 電源 計劃' },
  { kind: 'applet', target: 'Microsoft.ProgramsAndFeatures', en: 'Programs and Features', zh: '程式和功能', keywords: 'programs features uninstall appwiz 程式 功能 解除安裝' },
  { kind: 'applet', target: 'Microsoft.RegionAndLanguage', en: 'Region', zh: '地區', keywords: 'region locale format 地區 格式' },
  { kind: 'applet', target: 'Microsoft.Sound', en: 'Sound', zh: '聲音', keywords: 'sound audio playback recording 聲音 音效' },
  { kind: 'applet', target: 'Microsoft.System', en: 'System', zh: '系統', keywords: 'system about specs 系統 規格' },
  { kind: 'applet', target: 'Microsoft.Troubleshooting', en: 'Troubleshooting', zh: '疑難排解', keywords: 'troubleshooting 疑難排解' },
  { kind: 'applet', target: 'Microsoft.UserAccounts', en: 'User Accounts', zh: '使用者帳戶', keywords: 'user accounts 使用者 帳戶' },
  { kind: 'applet', target: 'Microsoft.WindowsDefender', en: 'Windows Security', zh: 'Windows 安全性', keywords: 'defender security antivirus 防毒 安全' },
  { kind: 'applet', target: 'Microsoft.WindowsFirewall', en: 'Windows Defender Firewall', zh: 'Windows Defender 防火牆', keywords: 'firewall 防火牆' },
  { kind: 'applet', target: 'Microsoft.WindowsMobilityCenter', en: 'Windows Mobility Center', zh: 'Windows 行動中心', keywords: 'mobility center laptop 行動中心' },
];

// ── *.cpl files · 控制台 *.cpl 檔（control name.cpl）─────────────────────────────
const CPL_FILES: Entry[] = [
  { kind: 'cpl', target: 'appwiz.cpl', en: 'Programs and Features', zh: '程式和功能', keywords: 'appwiz uninstall programs 解除安裝 程式' },
  { kind: 'cpl', target: 'desk.cpl', en: 'Display Settings', zh: '顯示設定', keywords: 'desk display screen 顯示 螢幕' },
  { kind: 'cpl', target: 'firewall.cpl', en: 'Windows Firewall', zh: 'Windows 防火牆', keywords: 'firewall 防火牆' },
  { kind: 'cpl', target: 'hdwwiz.cpl', en: 'Device Manager', zh: '裝置管理員', keywords: 'hdwwiz device manager 裝置 管理員' },
  { kind: 'cpl', target: 'inetcpl.cpl', en: 'Internet Options', zh: '網際網路選項', keywords: 'inetcpl internet options proxy 網際網路' },
  { kind: 'cpl', target: 'intl.cpl', en: 'Region', zh: '地區', keywords: 'intl region locale 地區' },
  { kind: 'cpl', target: 'joy.cpl', en: 'Game Controllers', zh: '遊戲控制器', keywords: 'joy game controllers joystick 遊戲 控制器 搖桿' },
  { kind: 'cpl', target: 'main.cpl', en: 'Mouse Properties', zh: '滑鼠內容', keywords: 'main mouse 滑鼠' },
  { kind: 'cpl', target: 'mmsys.cpl', en: 'Sound', zh: '聲音', keywords: 'mmsys sound audio 聲音 音效' },
  { kind: 'cpl', target: 'ncpa.cpl', en: 'Network Connections', zh: '網路連線', keywords: 'ncpa network connections adapters 網路 連線 介面卡' },
  { kind: 'cpl', target: 'powercfg.cpl', en: 'Power Options', zh: '電源選項', keywords: 'powercfg power options 電源' },
  { kind: 'cpl', target: 'sysdm.cpl', en: 'System Properties', zh: '系統內容', keywords: 'sysdm system properties advanced environment 系統 內容 進階 環境變數' },
  { kind: 'cpl', target: 'timedate.cpl', en: 'Date and Time', zh: '日期和時間', keywords: 'timedate date time 日期 時間' },
  { kind: 'cpl', target: 'wscui.cpl', en: 'Security and Maintenance', zh: '安全性與維護', keywords: 'wscui security maintenance action center 安全性 維護' },
  { kind: 'cpl', target: 'control.exe', en: 'Control Panel (all items)', zh: '控制台（所有項目）', keywords: 'control panel all items 控制台 所有項目' },
];

const ALL: Entry[] = [...SETTINGS_PAGES, ...CONTROL_APPLETS, ...CPL_FILES];

// Category buckets (bilingual) — index order mirrors the WinForge Cats table.
const CATS: { en: string; zh: string }[] = [
  { en: 'System', zh: '系統' },
  { en: 'Devices', zh: '裝置' },
  { en: 'Network', zh: '網絡' },
  { en: 'Personalization', zh: '個人化' },
  { en: 'Apps', zh: '應用程式' },
  { en: 'Accounts', zh: '帳戶' },
  { en: 'Time & Language', zh: '時間與語言' },
  { en: 'Gaming', zh: '遊戲' },
  { en: 'Accessibility', zh: '協助工具' },
  { en: 'Privacy & Security', zh: '私隱與安全' },
  { en: 'Update & Recovery', zh: '更新與復原' },
  { en: 'Control Panel', zh: '控制台' },
  { en: 'Other', zh: '其他' },
];

// Heuristically bucket a launcher entry into a category — mirrors WinForge CatIndex.
function catIndex(e: Entry): number {
  const h = `${e.target} ${e.keywords} ${e.en}`.toLowerCase();
  const has = (...ks: string[]) => ks.some((k) => h.includes(k));

  if (has('windowsupdate', 'windows update', 'recovery', 'activation', 'backup', 'troubleshoot')) return 10;
  if (has('privacy', 'permission', 'location', 'microphone', 'camera-privacy', 'diagnostic', 'defender', 'windowssecurity', 'windows security', 'firewall', 'webcam')) return 9;
  if (has('accessib', 'ease of access', 'easeofaccess', 'narrator', 'magnifier', 'contrast', 'eyecontrol')) return 8;
  if (has('gaming', 'game bar', 'gamebar', 'gamemode', 'game mode', 'xbox')) return 7;
  if (has('language', 'region', 'timedate', 'date and time', 'speech', 'keyboard layout', 'datetime')) return 6;
  if (has('account', 'sign-in', 'signin', 'yourinfo', 'family', 'work or school', 'sync', 'windows hello', 'otherusers', 'email')) return 5;
  if (has('appsfeatures', 'default apps', 'defaultapps', 'optionalfeatures', 'optional features', 'startupapps', 'uninstall', 'appvolume')) return 4;
  if (has('personaliz', 'background', 'colors', 'colours', 'themes', 'lockscreen', 'lock screen', 'startmenu', 'taskbar', 'fonts')) return 3;
  if (has('network', 'wifi', 'wi-fi', 'ethernet', 'vpn', 'proxy', 'airplane', 'hotspot', 'dns', 'ncpa', 'dial', 'mobilehotspot')) return 2;
  if (has('bluetooth', 'devices', 'printers', 'mouse', 'pen', 'touchpad', 'autoplay', 'usb', 'scanner', 'camera', 'typing')) return 1;
  if (has('system', 'display', 'sound', 'notifications', 'power', 'battery', 'storage', 'multitask', 'clipboard', 'remotedesktop', 'remote desktop', 'about', 'nightlight', 'night light', 'projection', 'sysdm', 'wscui')) return 0;
  if (e.kind !== 'settings') return 11; // Control Panel
  return 12; // Other
}

// Build the real launch command for the native backend (mirrors WinForge Launch()).
function launchArgs(e: Entry): { program: string; args: string[] } {
  if (e.kind === 'settings') {
    // ms-settings: is a shell URI — open it through the shell (explorer.exe).
    return { program: 'explorer.exe', args: [e.target] };
  }
  if (e.kind === 'applet') {
    return { program: 'control.exe', args: ['/name', e.target] };
  }
  // cpl
  if (e.target.toLowerCase() === 'control.exe') {
    return { program: 'control.exe', args: [] };
  }
  return { program: 'control.exe', args: [e.target] };
}

export function SettingsHubModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const zh = lang.toLowerCase().startsWith('zh') || lang.toLowerCase().startsWith('yue');
  const pick = (en: string, zhText: string) => (zh ? zhText : en);

  const [filter, setFilter] = useState('');
  const [result, setResult] = useState<{ entry: Entry; ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState('');
  const desktop = isTauri();

  const hits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((e) => haystack(e).includes(q));
  }, [filter]);

  // Group visible hits by category, preserving category order.
  const groups = useMemo(() => {
    const byCat = new Map<number, Entry[]>();
    for (const e of hits) {
      const idx = catIndex(e);
      const bucket = byCat.get(idx);
      if (bucket) bucket.push(e);
      else byCat.set(idx, [e]);
    }
    return [...byCat.entries()].sort((a, b) => a[0] - b[0]);
  }, [hits]);

  const open = async (entry: Entry) => {
    if (!desktop || busy) return;
    setBusy(entry.target);
    setResult(null);
    try {
      const { program, args } = launchArgs(entry);
      const out: CommandOutput = await runCommand(program, args);
      // explorer.exe / control.exe return quickly; a non-zero code from explorer is
      // not necessarily a failure (it forks), so treat "launched without throwing" as success.
      const ok = out.success || program === 'explorer.exe';
      setResult({
        entry,
        ok,
        msg: ok
          ? `${entry.en} · ${entry.zh} — ${commandText(entry)}`
          : (out.stderr.trim() || pick(`Couldn't open ${entry.en}.`, `開唔到 ${entry.en}。`)),
      });
    } catch (e) {
      setResult({ entry, ok: false, msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  const kindLabel = (k: Kind) =>
    k === 'settings' ? t('sethub.kindSettings') : k === 'applet' ? t('sethub.kindApplet') : t('sethub.kindCpl');

  return (
    <div className="mod">
      <p className="count-note">{t('sethub.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('sethub.desktopOnly')}</p>}

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('sethub.searchPlaceholder')}
        />
        {filter && (
          <button className="mini" onClick={() => setFilter('')}>{t('sethub.clear')}</button>
        )}
        <span className="count-note">{t('sethub.count', { n: hits.length })}</span>
      </div>

      {result && (
        <p className={result.ok ? 'dep-ok' : 'dep-missing'} style={{ marginTop: 4 }}>
          {result.ok ? t('sethub.opened') : t('sethub.failed')}: {result.msg}
        </p>
      )}

      {hits.length === 0 && <p className="count-note">{t('sethub.empty')}</p>}

      {groups.map(([idx, entries]) => {
        const cat = CATS[idx] ?? { en: 'Other', zh: '其他' };
        return (
          <div className="panel" key={idx} style={{ marginTop: 10 }}>
            <div className="label" style={{ marginBottom: 6, fontWeight: 600 }}>
              {cat.en} · {cat.zh} <span className="count-note">({entries.length})</span>
            </div>
            <div className="kv-list">
              {entries.map((entry) => (
                <div className="kv-row" key={`${entry.kind}:${entry.target}`} style={{ alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="label" style={{ fontWeight: 600 }}>
                      {entry.en} · {entry.zh}
                    </div>
                    <div className="value" style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.8 }}>
                      <span className="mini" style={{ marginRight: 6 }}>{kindLabel(entry.kind)}</span>
                      {commandText(entry)}
                    </div>
                  </div>
                  <button
                    className="mini primary"
                    disabled={!desktop || !!busy}
                    onClick={() => open(entry)}
                  >
                    {busy === entry.target ? t('sethub.opening') : t('sethub.open')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <p className="count-note" style={{ marginTop: 10 }}>{t('sethub.note')}</p>
    </div>
  );
}
