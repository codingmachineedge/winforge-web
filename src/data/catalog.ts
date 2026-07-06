// AUTO-GENERATED from WinForge MainWindow.xaml nav tree + Services/ModuleRegistry.cs.
// Regenerate with: node tools/gen-catalog.mjs [path-to-WinForge]
// 315 modules + 22 tweak categories across 4 sections.
/* eslint-disable */

export interface CatalogModule {
  tag: string;
  en: string;
  zh: string;
  glyph: string;
  keywords: string;
  native: boolean;
}
export interface CatalogGroup {
  id: string;
  en: string;
  zh: string;
  modules: CatalogModule[];
  subgroups?: CatalogGroup[];
}
export interface CatalogSection {
  id: string;
  en: string;
  zh: string;
  native: boolean;
  directModules: CatalogModule[];
  groups: CatalogGroup[];
}

export const catalog: CatalogSection[] = [
  {
    "id": "suite",
    "en": "Simulations",
    "zh": "模擬",
    "native": false,
    "directModules": [
      {
        "tag": "dashboard",
        "en": "Dashboard",
        "zh": "概覽",
        "glyph": "",
        "keywords": "home overview start 主頁 概覽",
        "native": false
      },
      {
        "tag": "module.reactor",
        "en": "Nuclear Reactor",
        "zh": "核反應堆",
        "glyph": "",
        "keywords": "nuclear reactor npp pwr pressurized water reactor simulation simulator meltdown scram control rod boron xenon doppler reactivity pcm point kinetics neutron flux fuel temperature coolant tavg thot tcold primary pressure pressurizer steam generator turbine generator condenser rcp pump feedwater eccs relief valve gauge mimic diagram trend chart annunciator alarm core damage explosion physics 核反應堆 核電廠 壓水堆 模擬 熔毀 緊急停堆 控制棒 硼 氙 反應性 中子 通量 燃料溫度 冷卻劑 壓力 穩壓器 蒸汽發生器 汽輪機 發電機 冷凝器 主泵 給水 應急冷卻 釋壓閥 儀表 流程圖 趨勢 警報 爐心 爆炸 物理",
        "native": false
      },
      {
        "tag": "module.reactorsettings",
        "en": "Reactor Settings",
        "zh": "反應堆設定",
        "glyph": "",
        "keywords": "reactor settings real world external windows linkage power plan accent brightness keep awake meltdown real shutdown arm status api autosave persistence home assistant mirror light switch plug entity scram alarm generating reversible opt-in 反應堆設定 真實 外部 系統連動 電源計劃 強調色 亮度 保持喚醒 熔毀 真實關機 啟用 狀態 API 自動儲存 連動 家居助理 燈 開關 插座 警報 發電",
        "native": false
      }
    ],
    "groups": [
      {
        "id": "reactor-loads",
        "en": "Reactor Loads",
        "zh": "反應堆負載",
        "modules": [
          {
            "tag": "module.cakefactory",
            "en": "Cake Factory & Farm",
            "zh": "蛋糕工廠與農場",
            "glyph": "",
            "keywords": "cake factory bakery farm simulator ingredients wheat flour sugar beet sugarcane eggs milk butter dairy vanilla cocoa leavening baking powder salt mixer depositor tunnel oven cooling icing packaging sanitation haccp food safety reactor nuclear power supply chain 蛋糕 工廠 農場 模擬 原料 小麥 麵粉 糖 雞蛋 牛奶 牛油 雲呢拿 可可 發粉 鹽 攪拌 焗爐 冷卻 裝飾 包裝 衛生 食物安全 反應堆 核能 供電",
            "native": false
          },
          {
            "tag": "module.griddispatch",
            "en": "Grid Dispatch Center",
            "zh": "電網調度中心",
            "glyph": "",
            "keywords": "grid dispatch electricity sell power reactor mwe spot price frequency load-follow nuclear 電網 調度 售電 電力 反應堆 頻率 電價 核能",
            "native": false
          },
          {
            "tag": "module.h2plant",
            "en": "Hydrogen Electrolysis",
            "zh": "氫電解制氫廠",
            "glyph": "",
            "keywords": "hydrogen electrolysis h2 plant reactor mwe power water splitting green fuel nuclear 氫 電解 制氫 反應堆 電力 綠氫 儲氫 核能",
            "native": false
          },
          {
            "tag": "module.aicluster",
            "en": "AI Training Cluster",
            "zh": "AI 訓練叢集",
            "glyph": "",
            "keywords": "ai training cluster gpu pflop compute machine learning model reactor nuclear power load megawatt heavy 人工智能 訓練 叢集 運算 深度學習 模型 核電 反應堆 供電 重負載",
            "native": false
          },
          {
            "tag": "module.hpc",
            "en": "Supercomputer (HPC)",
            "zh": "超級電腦（HPC）",
            "glyph": "",
            "keywords": "hpc supercomputer compute cluster nodes job queue pflops high performance computing reactor nuclear load heavy 超級電腦 高效能運算 運算叢集 節點 作業佇列 核電 反應堆 重負載",
            "native": false
          },
          {
            "tag": "module.computemine",
            "en": "Compute Mine",
            "zh": "運算礦場",
            "glyph": "",
            "keywords": "compute mine mining crypto hashrate rig power draw megawatt reactor nuclear load earnings efficiency 運算 礦場 挖礦 礦機 算力 加密貨幣 核電 核能 反應堆 耗電 重負載 收益",
            "native": false
          },
          {
            "tag": "module.smelter",
            "en": "Aluminium Smelter",
            "zh": "鋁冶煉廠",
            "glyph": "",
            "keywords": "aluminium aluminum smelter hall-heroult pot-line electrolysis reactor nuclear heavy load industrial molten freeze tonnes 鋁 冶煉 電解 電解槽 核電 重負載 熔融 凍結 產量",
            "native": false
          },
          {
            "tag": "module.datacenter",
            "en": "Nuclear Data Center",
            "zh": "核能資料中心",
            "glyph": "",
            "keywords": "data center datacenter hyperscale server rack cooling pue uptime sla requests reactor nuclear load heavy 核能 資料中心 數據中心 伺服器 機櫃 散熱 用電 負載 反應堆 核電 重負載",
            "native": false
          },
          {
            "tag": "module.collider",
            "en": "Particle Collider",
            "zh": "粒子對撞機",
            "glyph": "",
            "keywords": "particle collider accelerator beam energy tev magnet luminosity physics reactor nuclear heavy load megawatt 粒子 對撞機 加速器 束能 磁鐵 亮度 物理 核電 反應堆 重負載",
            "native": false
          },
          {
            "tag": "module.reactorbank",
            "en": "Reactor Bank",
            "zh": "反應堆銀行",
            "glyph": "",
            "keywords": "reactor bank wallet currency watts economy mint earn spend store perk unlock ledger nuclear power 反應堆 銀行 錢包 貨幣 瓦特幣 經濟 鑄幣 賺取 花費 商店 解鎖 賬簿 核電",
            "native": false
          },
          {
            "tag": "module.desal",
            "en": "Seawater Desalination",
            "zh": "海水淡化廠",
            "glyph": "",
            "keywords": "desalination seawater fresh water reverse osmosis reactor nuclear mwe power m3 海水 淡化 食水 反滲透 反應堆 核電 重負載 儲水",
            "native": false
          },
          {
            "tag": "module.evcharge",
            "en": "EV Fast-Charge Depot",
            "zh": "電動車快充站",
            "glyph": "",
            "keywords": "ev electric vehicle fast charge depot charger stall kw fleet soc reactor nuclear mwe power 電動車 充電 快充 車隊 反應堆 核電 重負載",
            "native": false
          },
          {
            "tag": "module.pumpedhydro",
            "en": "Pumped-Storage Hydro",
            "zh": "抽水蓄能",
            "glyph": "",
            "keywords": "pumped storage hydro reservoir energy grid buffer pump generate turbine reactor nuclear mwe surplus 抽水蓄能 水力 水塘 儲能 電網 反應堆 核電",
            "native": false
          },
          {
            "tag": "module.districtheat",
            "en": "District Heating",
            "zh": "區域供熱",
            "glyph": "",
            "keywords": "district heating cogeneration chp hot water city network homes thermal reactor nuclear waste heat 區域供熱 熱電聯產 供暖 熱網 反應堆 核電 廢熱",
            "native": false
          },
          {
            "tag": "module.dac",
            "en": "Carbon Capture (DAC)",
            "zh": "碳捕集",
            "glyph": "",
            "keywords": "direct air capture dac carbon dioxide co2 climate scrubber tonnes reactor nuclear energy credits 直接空氣捕集 碳捕集 二氧化碳 氣候 反應堆 核電 碳信用",
            "native": false
          },
          {
            "tag": "module.vertfarm",
            "en": "Vertical Farm",
            "zh": "垂直農場",
            "glyph": "",
            "keywords": "vertical farm grow lights led hydroponics indoor agriculture crops harvest reactor nuclear power 垂直農場 植物工廠 補光燈 水耕 室內 農業 農作物 收成 反應堆 核電",
            "native": false
          },
          {
            "tag": "module.steelmill",
            "en": "Arc-Furnace Steel Mill",
            "zh": "電弧爐煉鋼廠",
            "glyph": "",
            "keywords": "steel mill electric arc furnace eaf melt scrap heat tap tonnes reactor nuclear megawatt heavy load 鋼廠 電弧爐 煉鋼 廢鋼 熔煉 出鋼 反應堆 核電 重負載",
            "native": false
          },
          {
            "tag": "module.cementkiln",
            "en": "Electric Cement Kiln",
            "zh": "電熱水泥迴轉窯",
            "glyph": "",
            "keywords": "cement kiln rotary clinker limestone calcination electric heat concrete tonnes reactor nuclear co2 decarbonise 水泥 迴轉窯 熟料 石灰石 煅燒 電熱 混凝土 反應堆 核電 減碳",
            "native": false
          }
        ],
        "subgroups": []
      }
    ]
  },
  {
    "id": "categories",
    "en": "Categories",
    "zh": "分類",
    "native": true,
    "directModules": [],
    "groups": [
      {
        "id": "files-disks",
        "en": "Files & Disks",
        "zh": "檔案與磁碟",
        "modules": [
          {
            "tag": "module.peek",
            "en": "Peek",
            "zh": "快速預覽",
            "glyph": "",
            "keywords": "peek preview quick look quicklook file viewer image text code markdown pdf audio video archive metadata previewer prev next folder navigate hotkey 快速預覽 預覽 檔案 圖片 文字 程式碼 影片 音訊 壓縮檔 中繼資料 熱鍵 上一個 下一個",
            "native": true
          },
          {
            "tag": "module.newplus",
            "en": "New+",
            "zh": "範本新增",
            "glyph": "",
            "keywords": "new plus newplus powertoys template templates create file folder new menu shellnew context menu date variable substitution scaffold blank boilerplate 範本 新增 範本新增 建立 檔案 資料夾 新增選單 變數 日期 樣板 鷹架",
            "native": true
          },
          {
            "tag": "module.archives",
            "en": "Archives",
            "zh": "壓縮檔",
            "glyph": "",
            "keywords": "zip 7z rar tar gzip compress extract 解壓 壓縮",
            "native": true
          },
          {
            "tag": "module.bulkops",
            "en": "Bulk File Ops",
            "zh": "批次檔案操作",
            "glyph": "",
            "keywords": "bulk file move copy delete attributes 批次 檔案",
            "native": true
          },
          {
            "tag": "module.rename",
            "en": "Batch Rename",
            "zh": "批次改名",
            "glyph": "",
            "keywords": "rename bulk powerrename regex 改名 批次",
            "native": true
          },
          {
            "tag": "module.duplicates",
            "en": "Duplicate Finder",
            "zh": "重複檔案搜尋",
            "glyph": "",
            "keywords": "duplicate hash find dedupe 重複",
            "native": true
          },
          {
            "tag": "module.everything",
            "en": "Instant File Search",
            "zh": "即時檔案搜尋",
            "glyph": "",
            "keywords": "everything voidtools instant file search find filename ntfs mft master file table usn journal index locate substring wildcard regex fast search box open folder copy path 即時 檔案搜尋 搜尋 搵檔案 檔名 索引 萬用字元 正規表示式 主檔案表 開啟資料夾 複製路徑",
            "native": true
          },
          {
            "tag": "module.filelocksmith",
            "en": "File Locksmith",
            "zh": "檔案鎖偵測",
            "glyph": "",
            "keywords": "file locksmith locked file folder which process is locking handle open handle restart manager rstrtmgr in use cannot delete cannot move being used by another program end task unlock who is using whatslocking lockedfile powertoys 檔案鎖 鎖住 邊個程序 鎖定 控制代碼 佔用 刪唔到 移動唔到 解鎖 結束工作 開啟中",
            "native": true
          },
          {
            "tag": "module.diffmerge",
            "en": "Diff & Merge (WinMerge)",
            "zh": "比對與合併",
            "glyph": "",
            "keywords": "diff merge winmerge compare comparison file folder directory side by side three way two way text line word intra-line myers lcs hash content sha256 only left only right different identical changed added removed unchanged synchronized scroll ignore whitespace next previous difference copy left right save patch beyond compare meld kdiff 比對 合併 比較 差異 檔案 資料夾 並排 逐行 逐字 雜湊 內容 相同 不同 只在左邊 只在右邊 新增 刪除 改動 忽略空白 下一處 上一處 抄左 抄右 儲存",
            "native": true
          },
          {
            "tag": "module.hexeditor",
            "en": "Hex Editor",
            "zh": "十六進位編輯器",
            "glyph": "",
            "keywords": "hex editor hexeditor hxd binary editor byte bytes offset ascii hexadecimal view edit overwrite insert delete find search go to goto md5 sha1 sha-1 sha256 sha-256 hash checksum memory mapped large file dump raw 十六進位 二進位 編輯器 位元組 位移 雜湊 校驗 搜尋 跳到 覆寫 插入 刪除 記憶體對應 大檔",
            "native": true
          },
          {
            "tag": "module.disk",
            "en": "Disk Analyser",
            "zh": "磁碟分析",
            "glyph": "",
            "keywords": "disk space treemap analyse folder size 磁碟 空間",
            "native": true
          },
          {
            "tag": "module.drives",
            "en": "Drives",
            "zh": "磁碟機",
            "glyph": "",
            "keywords": "drive volume format bitlocker 磁碟機",
            "native": true
          },
          {
            "tag": "module.diskhealth",
            "en": "Disk Health (SMART)",
            "zh": "硬碟健康（SMART）",
            "glyph": "",
            "keywords": "disk health smart crystaldiskinfo hdd ssd nvme temperature power on hours wear reallocated sectors pending uncorrectable attribute firmware serial percentage used data units lifespan failure prediction caution good bad 硬碟 健康 溫度 通電時數 耗損 重新分配磁區 待處理 不可修正 屬性 韌體 序號 已使用壽命 故障預測 注意 良好 不良",
            "native": true
          },
          {
            "tag": "module.diskbench",
            "en": "Disk Benchmark",
            "zh": "硬碟速度測試",
            "glyph": "",
            "keywords": "disk benchmark crystaldiskmark cdm speed test read write sequential random seq1m rnd4k iops mbps queue depth ssd nvme hdd throughput latency direct io no buffering 硬碟 磁碟 速度測試 讀寫 循序 隨機 佇列 深度 跑分 效能 固態硬碟",
            "native": true
          },
          {
            "tag": "module.testdisk",
            "en": "TestDisk / PhotoRec Recovery",
            "zh": "TestDisk / PhotoRec 資料救援",
            "glyph": "",
            "keywords": "testdisk photorec recovery carve undelete partition recover data lost deleted 資料救援 救援 復原 還原 分割區 救回 刪除 檔案",
            "native": true
          },
          {
            "tag": "module.onedrive",
            "en": "OneDrive",
            "zh": "OneDrive",
            "glyph": "",
            "keywords": "onedrive files on demand pin dehydrate online only cloud free space storage sense sync 雲端 釘選 脫水 釋放空間 同步 隨選",
            "native": true
          },
          {
            "tag": "module.richpreview",
            "en": "Rich Preview",
            "zh": "豐富預覽",
            "glyph": "",
            "keywords": "rich preview preview pane peek file explorer add-ons handlers svg markdown md pdf source code json xml yaml toml gcode g-code 3d print qoi image thumbnail metadata render viewer webview2 monaco powertoys file preview drop open prev next 預覽 預覽窗格 檔案 渲染 縮圖 圖片 原始碼 開發 拖放",
            "native": true
          },
          {
            "tag": "module.filebrowser",
            "en": "File Browser",
            "zh": "檔案瀏覽器",
            "glyph": "",
            "keywords": "file browser explorer folder directory drive navigate open rename copy move cut paste delete recycle bin new folder hidden read-only attributes size modified date preview text breadcrumbs path this pc my computer 檔案 瀏覽器 資料夾 磁碟 導覽 開啟 改名 複製 移動 刪除 回收筒 隱藏 預覽 路徑",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "system",
        "en": "System",
        "zh": "系統",
        "modules": [
          {
            "tag": "module.doctors",
            "en": "System Doctors",
            "zh": "系統醫生",
            "glyph": "",
            "keywords": "doctor repair fix rescue printer spooler dns network sleep wake taskbar start search index explorer icon thumbnail cache ownership permissions 修復 醫生 救援 列印 網絡 睡眠 喚醒 工作列 搜尋 圖示 縮圖 擁有權 權限",
            "native": true
          },
          {
            "tag": "module.services",
            "en": "Services",
            "zh": "服務",
            "glyph": "",
            "keywords": "services start stop startup type 服務",
            "native": true
          },
          {
            "tag": "module.tasks",
            "en": "Scheduled Tasks",
            "zh": "排程工作",
            "glyph": "",
            "keywords": "scheduled task scheduler run 排程",
            "native": true
          },
          {
            "tag": "module.devices",
            "en": "Devices",
            "zh": "裝置",
            "glyph": "",
            "keywords": "device manager hardware driver 裝置 驅動",
            "native": true
          },
          {
            "tag": "module.vivetool",
            "en": "ViVeTool",
            "zh": "功能旗標",
            "glyph": "",
            "keywords": "vivetool vive feature flag experiment hidden file explorer tabs new start menu modern context menu snap layouts energy saver click to do 功能 旗標 實驗 隱藏 分頁 開始功能表",
            "native": true
          },
          {
            "tag": "module.regedit",
            "en": "Registry Editor",
            "zh": "登錄編輯器",
            "glyph": "",
            "keywords": "registry regedit hive key value 登錄檔",
            "native": true
          },
          {
            "tag": "module.startup",
            "en": "Startup Apps",
            "zh": "開機程式",
            "glyph": "",
            "keywords": "startup autostart logon run 開機 自啟動",
            "native": true
          },
          {
            "tag": "module.events",
            "en": "Event Viewer",
            "zh": "事件檢視器",
            "glyph": "",
            "keywords": "event log viewer system application 事件 記錄",
            "native": true
          },
          {
            "tag": "module.monitor",
            "en": "System Monitor",
            "zh": "系統監察",
            "glyph": "",
            "keywords": "cpu ram memory network task manager priority affinity btop btop4win resource monitor per-core swap sparkline efficiency 監察 工作管理員 資源監控 每核心",
            "native": true
          },
          {
            "tag": "module.procexp",
            "en": "Process Explorer",
            "zh": "程序總管",
            "glyph": "",
            "keywords": "process explorer system informer procexp task manager process tree parent child pid parent process id command line working set private bytes threads owner user description fileversioninfo end process kill end tree set priority open file location copy pid path details modules start time wmi win32_process cpu percent search filter 程序 程序樹 程序總管 工作管理員 父程序 子程序 命令列 工作集 私用位元組 執行緒 擁有者 描述 結束程序 結束程序樹 優先權 開啟檔案位置 複製 詳細 模組 啟動時間",
            "native": true
          },
          {
            "tag": "module.winfetch",
            "en": "System Info (Winfetch)",
            "zh": "系統資訊",
            "glyph": "",
            "keywords": "winfetch neofetch fetch system info os host kernel uptime packages shell resolution gpu cpu memory disk ascii logo specs about machine 系統資訊 規格 開機時間 解像度 記憶體 磁碟 顯示卡 標誌",
            "native": true
          },
          {
            "tag": "module.battery",
            "en": "Battery & Thermal",
            "zh": "電池與散熱",
            "glyph": "",
            "keywords": "battery thermal temperature wear health cpu gpu fan powercfg batteryreport energy 電池 溫度 散熱 風扇 耗損 健康",
            "native": true
          },
          {
            "tag": "module.connections",
            "en": "Connections",
            "zh": "連線",
            "glyph": "",
            "keywords": "tcp udp connections netstat tcpview port 連線",
            "native": true
          },
          {
            "tag": "module.wireshark",
            "en": "Packet Capture",
            "zh": "封包擷取",
            "glyph": "",
            "keywords": "wireshark packet capture tshark dumpcap pcap pcapng sniff npcap interface bpf capture filter display filter protocol tcp udp http dns follow stream conversation endpoint statistics 封包 擷取 抓包 嗅探 過濾 協定 統計",
            "native": true
          },
          {
            "tag": "module.nmap",
            "en": "Nmap Scanner",
            "zh": "網絡掃描",
            "glyph": "",
            "keywords": "nmap port scan network security host service os version cidr subnet npcap zenmap nse script ping sweep 掃描 端口 連接埠 網絡 安全 主機 服務 作業系統 子網",
            "native": true
          },
          {
            "tag": "module.native",
            "en": "Native Utilities",
            "zh": "原生工具",
            "glyph": "",
            "keywords": "wifi password saved nearby scan smb shares sessions brightness ddc certificate users logoff disconnect gpu disk counters process modules bluetooth pinvoke wlan 原生 密碼 共享 亮度 憑證 藍牙 模組",
            "native": true
          },
          {
            "tag": "module.envvars",
            "en": "Environment Variables",
            "zh": "環境變數",
            "glyph": "",
            "keywords": "environment variables path user system env 環境變數",
            "native": true
          },
          {
            "tag": "module.clipboard",
            "en": "Clipboard",
            "zh": "剪貼簿",
            "glyph": "",
            "keywords": "clipboard history text image file convert win+v qr qrcode qr code plain text paste 剪貼簿 歷史 二維碼 純文字",
            "native": true
          },
          {
            "tag": "module.settingshub",
            "en": "Settings & Control Panel",
            "zh": "設定與控制台",
            "glyph": "",
            "keywords": "settings control panel ms-settings applet cpl launcher open page 設定 控制台 啟動器 面板",
            "native": true
          }
        ],
        "subgroups": []
      },
      {
        "id": "media-capture",
        "en": "Media & Capture",
        "zh": "媒體與擷取",
        "modules": [
          {
            "tag": "module.media",
            "en": "Media",
            "zh": "媒體",
            "glyph": "",
            "keywords": "ffmpeg video audio convert trim gif 影片 音訊 轉檔",
            "native": true
          },
          {
            "tag": "module.audioeditor",
            "en": "Audio Editor",
            "zh": "音訊編輯器",
            "glyph": "",
            "keywords": "audio editor audacity waveform record mic microphone play playback trim fade normalize gain volume speed tempo pitch shift noise reduction denoise reverb echo compressor eq equalizer mix concat export wav mp3 flac 音訊 編輯 波形 錄音 播放 剪裁 淡入 淡出 正規化 增益 變速 變調 降噪 混音 匯出",
            "native": true
          },
          {
            "tag": "module.audiotagger",
            "en": "Audio Tagger",
            "zh": "音訊標籤編輯器",
            "glyph": "",
            "keywords": "audio tagger tags tagging mp3tag id3 id3v2 metadata tag editor taglib taglibsharp title artist album album artist track number year genre comment composer disc cover art album art picture batch edit multi select rename from tags tag from filename pattern mp3 flac m4a ogg opus wav aac wma aiff bitrate sample rate duration 音訊 標籤 標籤編輯 中繼資料 標題 演出者 專輯 專輯演出者 曲目 年份 類型 備註 作曲 封面 封面圖 批次 改名 檔名 樣式 位元率 取樣率 時長",
            "native": true
          },
          {
            "tag": "module.mediaplayer",
            "en": "Media Player",
            "zh": "媒體播放器",
            "glyph": "",
            "keywords": "vlc libvlc media player play video audio movie music stream url playlist subtitle audio track snapshot fullscreen seek volume transcode convert mp4 mp3 webm wav 播放器 媒體 影片 音樂 串流 播放清單 字幕 截圖 全螢幕 轉檔",
            "native": true
          },
          {
            "tag": "module.ytdlp",
            "en": "Media Downloader",
            "zh": "媒體下載器",
            "glyph": "",
            "keywords": "yt-dlp ytdlp youtube download downloader video audio mp3 m4a playlist subtitles subs format quality 1080p 720p thumbnail metadata sponsorblock cookies twitch vimeo soundcloud bilibili 下載 影片 音訊 字幕 播放清單 畫質 縮圖",
            "native": true
          },
          {
            "tag": "module.blender",
            "en": "Blender (3D / Render)",
            "zh": "Blender（3D／算圖）",
            "glyph": "",
            "keywords": "blender 3d render rendering cycles eevee headless animation frame gltf fbx obj python script batch queue cpu gpu samples output mcp blender-mcp model context protocol codex claude opencode agents skills multi agent 算圖 渲染 動畫 影格 匯出 批次 佇列 agent skill",
            "native": true
          },
          {
            "tag": "module.libreoffice",
            "en": "Document Converter",
            "zh": "文件轉換器",
            "glyph": "",
            "keywords": "libreoffice soffice document converter convert batch pdf docx xlsx odt ods pptx csv txt office writer calc impress headless 文件 轉換 轉檔 批次 辦公",
            "native": true
          },
          {
            "tag": "module.pdftoolkit",
            "en": "PDF Toolkit",
            "zh": "PDF 工具箱",
            "glyph": "",
            "keywords": "pdf toolkit stirling stirling-pdf merge combine split rotate delete extract reorder pages watermark encrypt decrypt password protect unlock text extraction txt images to pdf png jpg pdfsharp pdfpig managed 工具箱 合併 分割 旋轉 刪頁 抽頁 重排 浮水印 加密 解密 密碼 解鎖 抽取文字 圖片轉 PDF",
            "native": true
          },
          {
            "tag": "module.recorder",
            "en": "Screen Recorder",
            "zh": "螢幕錄影",
            "glyph": "",
            "keywords": "record screen capture gdigrab 錄影",
            "native": true
          },
          {
            "tag": "module.capture",
            "en": "Capture Studio",
            "zh": "擷取工作室",
            "glyph": "",
            "keywords": "capture snip screenshot region gif ocr text recognize clipboard 截圖 擷取 區域 文字辨識 認字",
            "native": true
          },
          {
            "tag": "module.textocr",
            "en": "Text Extractor (OCR)",
            "zh": "原生文字辨識",
            "glyph": "",
            "keywords": "ocr text extractor textextractor normcap recognize recognise screen region image file picture png jpg bmp windows ocr engine windows.media.ocr language chinese traditional zh-hant copy clipboard read text from screen optical character recognition 文字辨識 認字 螢幕 區域 圖片 圖檔 語言 繁體中文 複製 剪貼簿 光學文字辨識 抽字",
            "native": true
          },
          {
            "tag": "module.cropandlock",
            "en": "Crop And Lock",
            "zh": "裁切與鎖定",
            "glyph": "",
            "keywords": "crop and lock croplock cropandlock window crop thumbnail reparent always on top topmost dwm thumbnail live mirror region pin floating powertoys windowcrop 裁切 鎖定 視窗 縮圖 置頂 浮窗 即時 鏡像 範圍 釘選",
            "native": true
          },
          {
            "tag": "module.giflab",
            "en": "GIF Studio",
            "zh": "螢幕轉 GIF",
            "glyph": "",
            "keywords": "gif studio screentogif screen to gif record region window fullscreen frames frame editor delete reorder crop export mp4 apng palette animation 螢幕轉 動畫 畫面格 刪格 調次序 裁切 匯出 錄影 區域 視窗 全螢幕",
            "native": true
          },
          {
            "tag": "module.zoomit",
            "en": "ZoomIt",
            "zh": "螢幕放大與標註",
            "glyph": "",
            "keywords": "zoomit zoom magnify magnifier screen presentation annotate annotation draw pen freehand arrow rectangle highlighter marker break timer countdown sysinternals hotkey ctrl 1 2 3 colour color red green blue orange yellow thickness pan wheel esc 放大 放大鏡 標註 註解 畫筆 手畫 箭咀 矩形 螢光筆 小休 倒數 計時 簡報 演示 熱鍵 顏色 平移 滾輪",
            "native": true
          },
          {
            "tag": "module.mixer",
            "en": "Volume Mixer",
            "zh": "音量混合器",
            "glyph": "",
            "keywords": "volume mixer audio per-app mute 音量 靜音",
            "native": true
          },
          {
            "tag": "module.colorpicker",
            "en": "Color Picker",
            "zh": "螢幕取色",
            "glyph": "",
            "keywords": "color picker hex rgb hsl eyedropper 取色 顏色",
            "native": true
          },
          {
            "tag": "module.screenruler",
            "en": "Screen Ruler",
            "zh": "螢幕間尺",
            "glyph": "",
            "keywords": "screen ruler measure tool measurement powertoys distance horizontal vertical cross crosshair bounds pixel px coordinate angle line color thickness overlay clipboard 間尺 度尺 量度 量尺 螢幕度尺 像素 距離 水平 垂直 十字 邊界 座標 角度 覆蓋層",
            "native": true
          },
          {
            "tag": "module.pixeleditor",
            "en": "Pixel Editor",
            "zh": "像素畫編輯器",
            "glyph": "",
            "keywords": "pixel editor aseprite sprite pixel art draw paint canvas palette layers frames animation gif png pencil eraser fill bucket eyedropper undo redo 像素 像素畫 精靈 繪圖 畫布 調色盤 圖層 影格 動畫 鉛筆 橡皮 填色 吸色",
            "native": true
          },
          {
            "tag": "module.imageeditor",
            "en": "Image Editor",
            "zh": "點陣圖影像編輯器",
            "glyph": "",
            "keywords": "image editor photo editor raster paint.net gimp photoshop alternative imagesharp png jpg jpeg bmp gif webp open save export quality canvas zoom pan brightness contrast saturation hue gamma adjust grayscale invert sepia gaussian blur sharpen edge detect filter crop resize rotate flip aspect brush pencil fill bucket eraser eyedropper text tool layers opacity show hide undo redo 影像 影像編輯 相片 點陣圖 編輯器 開啟 儲存 匯出 品質 畫布 縮放 平移 亮度 對比 飽和度 色相 伽瑪 灰階 反相 棕褐 高斯模糊 銳化 邊緣偵測 濾鏡 裁切 旋轉 翻轉 長寬比 筆刷 鉛筆 填色 橡皮 吸色 文字 圖層 不透明度 顯示 隱藏 復原 重做",
            "native": true
          },
          {
            "tag": "module.timeunit",
            "en": "Time & Unit Tools",
            "zh": "時間與單位工具",
            "glyph": "",
            "keywords": "time zone timezone world clock converter convert unit length mass temperature 時間 時區 世界時鐘 換算 單位",
            "native": true
          },
          {
            "tag": "module.timelens",
            "en": "Activity Timeline",
            "zh": "活動時間軸",
            "glyph": "",
            "keywords": "timelens activity timeline time tracking tracker foreground window app usage productivity insights idle per-app totals stacked bar export csv 活動 時間軸 時間追蹤 前景 視窗 應用程式 使用量 生產力 閒置 匯出",
            "native": true
          }
        ],
        "subgroups": []
      },
      {
        "id": "tweaks-input",
        "en": "Tweaks & Input",
        "zh": "調校與輸入",
        "modules": [
          {
            "tag": "module.hosts",
            "en": "Hosts Editor",
            "zh": "hosts 編輯器",
            "glyph": "",
            "keywords": "hosts block domain dns 封鎖",
            "native": true
          },
          {
            "tag": "module.mouse",
            "en": "Mouse & Pointer",
            "zh": "滑鼠與指標",
            "glyph": "",
            "keywords": "mouse pointer acceleration speed 滑鼠 指標",
            "native": true
          },
          {
            "tag": "module.mouseutils",
            "en": "Mouse Utilities",
            "zh": "滑鼠工具",
            "glyph": "",
            "keywords": "mouse utilities utils powertoys find my mouse findmymouse spotlight sonar double ctrl shake highlighter highlight click circle crosshairs crosshair lines pointer jump teleport screenshot overlay hook cursor locate ring 滑鼠 工具 搵滑鼠 聚光燈 標示 點擊 十字線 指標 跳轉 傳送 截圖 覆蓋層 游標 光圈",
            "native": true
          },
          {
            "tag": "module.mwb",
            "en": "Mouse Without Borders",
            "zh": "無界滑鼠",
            "glyph": "",
            "keywords": "mouse without borders mwb kvm share keyboard mouse multiple pc computers lan network control switch machine clipboard sync pair pairing security key tcp aes encrypt edge transition layout synergy barrier software kvm 無界滑鼠 鍵鼠共享 共享 鍵盤 滑鼠 多部電腦 區域網 配對 安全密鑰 剪貼簿 同步 邊界 控制權 版面",
            "native": true
          },
          {
            "tag": "module.keyboard",
            "en": "Keyboard Remapper",
            "zh": "鍵盤重新對應",
            "glyph": "",
            "keywords": "keyboard remap key sharpkeys 鍵盤",
            "native": true
          },
          {
            "tag": "module.hotkeys",
            "en": "Hotkey & Macro Runner",
            "zh": "熱鍵與巨集",
            "glyph": "",
            "keywords": "hotkey macro shortcut chord registerhotkey send keys autohotkey text expander snippet trigger expand abbreviation 熱鍵 巨集 快捷鍵 文字展開 片語 縮寫",
            "native": true
          },
          {
            "tag": "module.quickaccent",
            "en": "Quick Accent",
            "zh": "快速重音符",
            "glyph": "",
            "keywords": "quick accent accents diacritic diacritics mark marks acute grave circumflex tilde umlaut macron breve caron cedilla ring special symbols currency ipa pinyin powertoys keyboard hook hold letter activation key space arrow popup variants insert sendinput unicode language french german spanish portuguese vietnamese 快速 重音 重音符 變音 標記 發音符號 特殊符號 貨幣 拼音 音標 鍵盤 鈎 候選 語言 法文 德文 西班牙文 葡萄牙文 越南文",
            "native": true
          },
          {
            "tag": "module.shortcutguide",
            "en": "Shortcut Guide",
            "zh": "快捷鍵指南",
            "glyph": "",
            "keywords": "shortcut guide powertoys windows key win hold overlay cheat sheet keyboard shortcuts reference table win+e win+d win+l win+tab snap emoji clipboard snip search hotkey list winkey 快捷鍵 指南 揿住 視窗鍵 覆蓋層 鍵盤 速查表 參考 貼齊 表情符號 剪貼簿",
            "native": true
          },
          {
            "tag": "module.cmdpalette",
            "en": "Command Palette",
            "zh": "指令面板",
            "glyph": "",
            "keywords": "command palette powertoys run launcher quick launch alt space search box global hotkey app launcher calculator run command open url system action lock sleep shutdown restart web search fuzzy spotlight wox flow 指令面板 快速啟動 啟動器 搜尋框 全域熱鍵 計算機 執行 開網址 系統動作 鎖定 睡眠 關機 重啟 網絡搜尋 模糊搜尋",
            "native": true
          },
          {
            "tag": "module.contextmenu",
            "en": "Context Menu",
            "zh": "右鍵選單",
            "glyph": "",
            "keywords": "context menu right click verb 右鍵 選單",
            "native": true
          },
          {
            "tag": "module.shellmenu",
            "en": "Explorer Right-Click",
            "zh": "檔案總管右鍵選單",
            "glyph": "",
            "keywords": "shell context menu explorer right click integration powertoys native verb hkcu hash ocr resize image file locksmith copy as path disk usage open here show more options",
            "native": true
          },
          {
            "tag": "module.taskbar-tweaker",
            "en": "Taskbar Tweaker",
            "zh": "工作列調校",
            "glyph": "",
            "keywords": "taskbar tweaker 7+ taskbar tweaker windhawk align combine buttons small icons tray system tray multi monitor seconds clock search task view widgets copilot end task start menu explorer 工作列 調校 對齊 合併 系統匣 多螢幕 秒 時鐘 搜尋 開始功能表 結束工作",
            "native": true
          },
          {
            "tag": "module.lightswitch",
            "en": "LightSwitch (Auto Dark Mode)",
            "zh": "自動深淺色",
            "glyph": "",
            "keywords": "lightswitch light switch auto dark mode autotheme darkmode automatic theme schedule sunrise sunset day night fixed time apps system personalize appsuselighttheme systemuseslighttheme latitude longitude location ip geolocation background scheduled task switch now powertoys 自動 深淺色 深色模式 淺色模式 主題 切換 排程 日出 日落 日夜 固定時間 緯度 經度 位置 背景 排程工作",
            "native": true
          },
          {
            "tag": "module.nilesoftshell",
            "en": "Nilesoft Shell",
            "zh": "Nilesoft 右鍵選單",
            "glyph": "",
            "keywords": "nilesoft shell context menu nss shell.nss register unregister reload theme modern dark snippet template explorer customize right click 右鍵 選單 主題 註冊 設定 範本 片語 客製化",
            "native": true
          },
          {
            "tag": "module.windows",
            "en": "Window Manager",
            "zh": "視窗管理",
            "glyph": "",
            "keywords": "window tile cascade always on top 視窗",
            "native": true
          },
          {
            "tag": "module.workspaces",
            "en": "Workspaces",
            "zh": "工作區",
            "glyph": "",
            "keywords": "workspaces workspace powertoys app layout desktop layout capture snapshot restore relaunch launch window position size monitor maximized minimized set of apps project save named scene session arrange reopen 工作區 應用程式佈局 桌面佈局 擷取 快照 還原 重新啟動 啟動 視窗位置 大細 螢幕 場景 工作階段 一組應用程式 儲存 重開",
            "native": true
          },
          {
            "tag": "module.altsnap",
            "en": "AltSnap",
            "zh": "Alt 拖曳視窗",
            "glyph": "",
            "keywords": "altsnap alt drag move resize window modifier key altdrag snap aero hook ramonunch alt 拖曳 移動 縮放 修飾鍵 貼齊 視窗",
            "native": true
          },
          {
            "tag": "module.fancyzones",
            "en": "FancyZones",
            "zh": "視窗分區",
            "glyph": "",
            "keywords": "fancyzones fancy zones powertoys window tiling zone editor layout grid columns rows priority snap hotkey shift drag win ctrl arrow tile 分區 排版 貼齊 版面 格網 編輯器 熱鍵",
            "native": true
          },
          {
            "tag": "module.komorebi",
            "en": "Komorebi (Tiling WM)",
            "zh": "Komorebi 平鋪視窗管理",
            "glyph": "",
            "keywords": "komorebi komorebic tiling window manager tile bsp columns rows stack grid monocle float workspace monitor layout daemon wm whkd gaps padding 平鋪 視窗管理 排版 工作區 守護程序 間距",
            "native": true
          },
          {
            "tag": "module.glazewm",
            "en": "GlazeWM Tiling",
            "zh": "GlazeWM 平鋪視窗",
            "glyph": "",
            "keywords": "glazewm glaze tiling window manager tile workspace keybinding gaps config yaml komorebi reload daemon 平鋪 視窗 管理 工作區 鍵盤 綁定 邊距 設定",
            "native": true
          },
          {
            "tag": "module.fonts",
            "en": "Font Manager",
            "zh": "字型管理",
            "glyph": "",
            "keywords": "font fonts install preview uninstall ttf otf typeface typography 字型 字款 安裝 預覽 移除",
            "native": true
          },
          {
            "tag": "module.awake",
            "en": "Awake",
            "zh": "保持喚醒",
            "glyph": "",
            "keywords": "awake keep awake no sleep caffeine 唔瞓 喚醒",
            "native": true
          },
          {
            "tag": "module.advancedpaste",
            "en": "Advanced Paste",
            "zh": "進階貼上",
            "glyph": "",
            "keywords": "advanced paste transform smart paste plain text markdown json uppercase lowercase title case base64 url encode html ocr image to text csv transpose sort unique lines ai win+shift+v 進階 貼上 轉換 純文字 大小寫 編碼 解碼 排序 去重複 圖片轉文字",
            "native": true
          },
          {
            "tag": "module.powertoys",
            "en": "PowerToys Extras",
            "zh": "PowerToys 額外工具",
            "glyph": "",
            "keywords": "powertoys image resizer ocr text extractor always on top topmost paste plain text 圖片縮放 文字擷取 置頂 純文字",
            "native": true
          },
          {
            "tag": "module.windhawk",
            "en": "Windhawk Mods",
            "zh": "Windhawk 模組",
            "glyph": "",
            "keywords": "windhawk mod mods customize taskbar height icon size clock start menu styler explorer rounded corners classic taskbar aero tray injection ramensoftware 模組 自訂 工作列 時鐘 開始功能表 圓角 注入",
            "native": true
          },
          {
            "tag": "module.voice",
            "en": "Voice & Read-Aloud",
            "zh": "語音朗讀",
            "glyph": "",
            "keywords": "voice tts text to speech read aloud speak narrator wav export sapi 語音 朗讀 文字轉語音 讀出",
            "native": true
          },
          {
            "tag": "module.announcements",
            "en": "PA Announcements",
            "zh": "喇叭語音廣播",
            "glyph": "",
            "keywords": "announce announcements pa public address speaker tannoy intercom broadcast loudspeaker chime tone ding dong tts speak voice queue urgent priority alarm alert reactor evacuate countdown attention all personnel sapi 廣播 喇叭 公共廣播 語音廣播 對講 警報 警示 叮咚 排隊 緊急 優先 反應堆 撤離 倒數 注意",
            "native": true
          },
          {
            "tag": "module.rainmeter",
            "en": "Rainmeter Widgets",
            "zh": "Rainmeter 桌面小工具",
            "glyph": "",
            "keywords": "rainmeter skin skins widget widgets desktop gadget bang activate deactivate toggle refresh hide show rmskin skininstaller layout illustro clock cpu monitor personalization 桌面 小工具 皮膚 桌面美化 個人化 時鐘 監察",
            "native": true
          }
        ],
        "subgroups": []
      },
      {
        "id": "apps-git",
        "en": "Apps & Git",
        "zh": "程式與 Git",
        "modules": [
          {
            "tag": "module.packages",
            "en": "Package Manager",
            "zh": "套件管理",
            "glyph": "",
            "keywords": "winget package install uninstall upgrade update scoop choco chocolatey pip python npm node dotnet tool powershell gallery psgallery pwsh pwsh7 psresource cargo rust bun javascript vcpkg dependencies unigetui discover bundle export import batch select selected multi 套件 安裝 更新 解除安裝 相依 清單 批次 多選 匯出 匯入",
            "native": true
          },
          {
            "tag": "module.ossapps",
            "en": "Native OSS Clones",
            "zh": "開源原生分頁",
            "glyph": "",
            "keywords": "open source native clones foss oss apps in-app csharp c# tab remade reimplementation api client diff merge diagram decompiler sqlite feed reader flashcards pdf audio tagger image editor ocr keepass torrent docker process explorer disk health benchmark everything search 開源 原生 分頁 複製 重製 內建 app內 C# 工具",
            "native": true
          },
          {
            "tag": "module.adb",
            "en": "Android (ADB)",
            "zh": "Android（ADB）",
            "glyph": "",
            "keywords": "android adb apk logcat shell screenshot reboot fastboot scrcpy push pull file backup mirror 手機 安卓 鏡像 備份",
            "native": true
          },
          {
            "tag": "module.fastboot",
            "en": "Fastboot / Flasher",
            "zh": "Fastboot／刷機",
            "glyph": "",
            "keywords": "fastboot flash flasher bootloader unlock boot.img factory image sideload ota pixelflasher 刷機 解鎖",
            "native": true
          },
          {
            "tag": "module.emulator",
            "en": "Android Emulator & SDK",
            "zh": "Android 模擬器與 SDK",
            "glyph": "",
            "keywords": "android emulator avd avdmanager sdkmanager virtual device launch wipe cold boot sdk sdkmanager packages platform-tools build-tools ndk license channel system image install uninstall update 套件 平台 授權 模擬器 虛擬裝置 安裝 更新 移除",
            "native": true
          },
          {
            "tag": "module.vpn",
            "en": "VPN & Mesh",
            "zh": "VPN 與網狀網",
            "glyph": "",
            "keywords": "vpn nordvpn tailscale mesh connect exit node ping 連線 網狀網",
            "native": true
          },
          {
            "tag": "module.qbittorrent",
            "en": "qBittorrent",
            "zh": "種子下載",
            "glyph": "",
            "keywords": "qbittorrent torrent torrents magnet bittorrent download seed leech tracker peer category tag webui web api speed limit 種子 磁力 下載 做種 追蹤器 分類 標籤 速度限制",
            "native": true
          },
          {
            "tag": "module.torrent",
            "en": "Native Torrent",
            "zh": "原生種子下載",
            "glyph": "",
            "keywords": "native torrent bittorrent monotorrent magnet link dht pex local peer discovery udp http tracker in-process managed pure c# download seed leech file priority sequential recheck ratio eta peers seeds pieces fast resume session restore downloads 原生 種子 磁力 下載 做種 追蹤器 對等 內建 受控 引擎 檔案優先 順序 重新檢查 比率 片段 還原",
            "native": true
          },
          {
            "tag": "module.dockerssh",
            "en": "Docker over SSH",
            "zh": "透過 SSH 控制 Docker",
            "glyph": "",
            "keywords": "docker ssh remote container containers power start stop restart pause unpause remove rm logs exec ps image daemon host remotedocker dockerssh containers-ssh ssh.net portainer compose 容器 遠端 控制 啟動 停止 重啟 暫停 移除 日誌 執行 鏡像 主機 遙距 碼頭",
            "native": true
          },
          {
            "tag": "module.docker",
            "en": "Docker",
            "zh": "Docker 容器管理",
            "glyph": "",
            "keywords": "docker container containers image images volume volumes network networks compose docker-compose stack engine daemon npipe pipe rest api portainer pull run start stop restart pause unpause remove logs exec stats inspect prune dangling registry nginx bridge 容器 映像 磁碟區 網路 堆疊 引擎 守護程序 拉取 啟動 停止 重啟 暫停 移除 日誌 執行 統計 清理",
            "native": true
          },
          {
            "tag": "module.diagram",
            "en": "Diagram Editor",
            "zh": "圖表編輯器",
            "glyph": "",
            "keywords": "diagram drawio draw.io diagrams.net flowchart flow chart shapes shape rectangle rounded ellipse circle diamond text node connector arrow edge link canvas whiteboard mind map mindmap org chart graph vector editor zoom snap grid duplicate z-order bring front send back png export json save load 圖表 流程圖 圖 形狀 矩形 圓角 橢圓 菱形 文字 節點 連線 箭咀 畫布 白板 心智圖 組織圖 向量 縮放 貼齊 格線 複製 層次 匯出 儲存",
            "native": true
          },
          {
            "tag": "module.flashcards",
            "en": "Flashcards",
            "zh": "間隔重複記憶卡",
            "glyph": "",
            "keywords": "flashcards flash cards anki srs spaced repetition study deck decks card front back review grade again hard good easy sm-2 sm2 ease interval due new mature memorize memorise learn quiz vocabulary csv import export 記憶卡 閃卡 間隔重複 學習 牌組 卡片 正面 背面 複習 評分 到期 成熟 背誦 記憶 默書 詞彙 匯入 匯出",
            "native": true
          },
          {
            "tag": "module.rustdesk",
            "en": "RustDesk",
            "zh": "遠端桌面",
            "glyph": "",
            "keywords": "rustdesk remote desktop remote control id password peer connect relay server self-hosted unattended access teamviewer anydesk alternative 遠端桌面 遙距桌面 遠程桌面 遠端控制 遙距控制",
            "native": true
          },
          {
            "tag": "module.homeassistant",
            "en": "Home Assistant",
            "zh": "家居助理",
            "glyph": "",
            "keywords": "home assistant ha smart home rest api template scene script light climate thermostat camera notify intent calendar 智能家居 家居助理",
            "native": true
          },
          {
            "tag": "module.comms",
            "en": "Communications",
            "zh": "通訊",
            "glyph": "",
            "keywords": "communications mail email outlook mailto draft attach teams meeting call discord telegram slack phone link tel sms deep link 通訊 信件 電郵 草稿 會議 電話",
            "native": true
          },
          {
            "tag": "module.mail",
            "en": "Mail",
            "zh": "電郵",
            "glyph": "",
            "keywords": "mail email imap smtp thunderbird inbox compose reply forward attachment oauth gmail outlook icloud yahoo account folder message read send 電郵 郵件 收件匣 撰寫 回覆 轉寄 附件 帳戶 資料夾 訊息",
            "native": true
          },
          {
            "tag": "module.wslvm",
            "en": "WSL & VM Launcher",
            "zh": "WSL 與 VM 啟動器",
            "glyph": "",
            "keywords": "wsl linux distro ubuntu debian windows sandbox wsb virtual machine vm hyper-v export import 子系統 沙盒 虛擬機",
            "native": true
          },
          {
            "tag": "module.virtualbox",
            "en": "VirtualBox Manager",
            "zh": "VirtualBox 管理",
            "glyph": "",
            "keywords": "virtualbox vbox vboxmanage vm virtual machine snapshot clone ova headless oracle 虛擬機 虛擬機器 快照 複製 匯入 匯出",
            "native": true
          },
          {
            "tag": "module.proxmox",
            "en": "Proxmox VE",
            "zh": "Proxmox VE 虛擬化",
            "glyph": "",
            "keywords": "proxmox pve vmhost hypervisor virtualization rest api token ticket node nodes cluster qemu kvm lxc container vm virtual machine guest start stop shutdown reboot suspend resume power on off status running stopped self-signed certificate trust datacenter homelab 虛擬化 虛擬機 容器 節點 叢集 電源 啟動 關機 停止 重新開機 暫停 繼續 自簽憑證 權杖 同主機",
            "native": true
          },
          {
            "tag": "module.terminal",
            "en": "Windows Terminal",
            "zh": "Windows 終端機",
            "glyph": "",
            "keywords": "windows terminal wt settings.json profiles profile editor conpty pseudo console embedded shell pwsh powershell cmd wsl color scheme font default duplicate launch new tab pane 終端機 設定檔 內嵌 偽終端機 殼層 預設 複製 啟動 分頁 窗格 色彩配置 字型",
            "native": true
          },
          {
            "tag": "module.uninstall",
            "en": "App Uninstaller",
            "zh": "應用程式解除安裝",
            "glyph": "",
            "keywords": "uninstall remove app program winget 解除安裝",
            "native": true
          },
          {
            "tag": "module.imaging",
            "en": "Imaging & Game Tools",
            "zh": "燒錄與遊戲工具",
            "glyph": "",
            "keywords": "raspberry pi imager sd card flash image write boot ssh wifi minecraft world downloader proxy jar rufus usb bootable iso flash drive uefi mbr verify windows linux installer 開機 USB 手指 啟動碟 樹莓派 燒錄 映像 我的世界 下載",
            "native": true
          },
          {
            "tag": "module.amulet",
            "en": "Minecraft World Editor (Amulet)",
            "zh": "Minecraft 世界編輯器（Amulet）",
            "glyph": "",
            "keywords": "amulet minecraft world editor map editor java bedrock level dat nbt python wxpython launch backup saves chunk dimension 世界 編輯器 我的世界 地圖 備份 存檔 維度",
            "native": true
          },
          {
            "tag": "module.minecraftworldtools",
            "en": "Minecraft World Tools",
            "zh": "Minecraft 世界工具",
            "glyph": "",
            "keywords": "minecraft world tools chunker converter convert java bedrock batch 500mb memory leak bluemap render map web server config region mca level dat 世界 工具 轉換 分批 記憶體 漏洞 算圖 地圖 網頁 設定",
            "native": true
          },
          {
            "tag": "module.viaproxy",
            "en": "ViaProxy",
            "zh": "Minecraft 版本代理",
            "glyph": "",
            "keywords": "viaproxy minecraft version proxy viaversion viabackwards viarewind protocol translate bridge server jar java cli bind target auth offline online mc 我的世界 版本 代理 協定 轉換 伺服器",
            "native": true
          },
          {
            "tag": "module.minecraftserver",
            "en": "Minecraft Server",
            "zh": "Minecraft 伺服器",
            "glyph": "",
            "keywords": "minecraft server paper spigot papermc buildtools eula server.properties plugin plugins luckperms essentialsx viaversion worldedit console rcon start.bat aikar gradle maven jar 伺服器 外掛 主控台 我的世界",
            "native": true
          },
          {
            "tag": "module.minecraftlauncher",
            "en": "Minecraft Launcher",
            "zh": "Minecraft 啟動器",
            "glyph": "",
            "keywords": "minecraft launcher java edition microsoft msa xbox live xsts authentication login sign in account uuid profile skin version manifest download assets libraries client jar sha1 natives jre temurin adoptium jvm xmx instance profile multi instance multiplayer mojang azure client id play vanilla release snapshot 啟動器 登入 微軟 帳戶 版本 下載 資產 程式庫 安裝 多開 實例 設定檔 記憶體 我的世界 原版 正版",
            "native": true
          },
          {
            "tag": "module.git",
            "en": "Git & GitHub",
            "zh": "Git 與 GitHub",
            "glyph": "",
            "keywords": "git github commit push pull fetch repo repos list clone branch tag merge rebase stash remote worktree submodule uploader issue pull request pr actions workflow release gist secret label star fork notifications gh cli gitty up checkpoint restore alias undo share workflow 版本控制 儲存庫 分支 標籤 工作流程 別名 撤回 檢查點",
            "native": true
          },
          {
            "tag": "module.vscode",
            "en": "VS Code",
            "zh": "VS Code 編輯器",
            "glyph": "",
            "keywords": "vscode vs code visual studio code editor cli open file folder workspace new window reuse diff merge goto line extension install uninstall list profile insiders tunnel remote settings keybindings code-workspace 編輯器 擴充功能 比對 合併 設定 遠端 隧道",
            "native": true
          },
          {
            "tag": "module.aiagents",
            "en": "AI Agents",
            "zh": "AI 代理",
            "glyph": "",
            "keywords": "ai agent claude code codex opencode pi openclaw hermes coding agent terminal cli install launch api key 代理 編程 安裝 啟動",
            "native": true
          },
          {
            "tag": "module.resume",
            "en": "Resume Writer",
            "zh": "履歷與求職信寫手",
            "glyph": "",
            "keywords": "resume cv cover letter job application tailor ai writer generate export base history docx pdf markdown 履歷 求職信 應徵 工作 職位 自我推薦 度身 生成 匯出",
            "native": true
          },
          {
            "tag": "module.ollama",
            "en": "Ollama",
            "zh": "本地大模型",
            "glyph": "",
            "keywords": "ollama llm local ai model chat gguf llama mistral qwen gemma phi deepseek pull serve tags running ps temperature top_p num_ctx streaming 本地 模型 聊天 人工智能 下載 大模型",
            "native": true
          },
          {
            "tag": "module.aichat",
            "en": "AI Chat",
            "zh": "AI 聊天",
            "glyph": "",
            "keywords": "ai chat llm ollama openai openrouter lm studio llama.cpp gpt local model conversation prompt streaming system prompt temperature openwebui open webui markdown 聊天 對話 本機模型 提示 串流 系統提示 溫度",
            "native": true
          },
          {
            "tag": "module.cloudflare",
            "en": "Cloudflare & Tunnel",
            "zh": "Cloudflare 與 Tunnel",
            "glyph": "",
            "keywords": "cloudflare cloudflared tunnel quick tunnel trycloudflare access warp dns over https doh zero trust route ingress 隧道 加密 連線",
            "native": true
          },
          {
            "tag": "module.weblogin",
            "en": "In-App Login",
            "zh": "內置登入",
            "glyph": "",
            "keywords": "login sign in signin oauth webview2 web view browser embedded auth authentication token cookie session redirect callback github cloudflare openai anthropic bitwarden account credentials 登入 登錄 內置 瀏覽器 認證 帳戶 憑證 權杖 重新導向",
            "native": true
          },
          {
            "tag": "module.ssh",
            "en": "SSH Toolset",
            "zh": "SSH 工具",
            "glyph": "",
            "keywords": "ssh sftp scp terminal shell remote profile key keygen ed25519 rsa passwordless deploy authorized_keys known hosts openssh dpapi 終端機 遠端 金鑰 免密碼 部署 連線 上載 下載",
            "native": true
          },
          {
            "tag": "module.apiclient",
            "en": "API Client",
            "zh": "REST API 用戶端",
            "glyph": "",
            "keywords": "api client rest http postman insomnia request response get post put patch delete head options url query params headers body json raw form url encoded x-www-form-urlencoded bearer token basic auth authorization collections environment variables substitute send httpclient status code response time size pretty print curl endpoint webhook REST 用戶端 客戶端 請求 回應 標頭 內文 查詢參數 驗證 權杖 基本驗證 集合 環境 變數 發送 狀態碼 美化 端點",
            "native": true
          },
          {
            "tag": "module.connectors",
            "en": "Connectors",
            "zh": "連接器",
            "glyph": "",
            "keywords": "connector connectors integration integrations mcp model context protocol server rest api webhook database endpoint external service auth bearer api key basic credential token secret dpapi connect link enable disable test reachability 連接器 整合 外部服務 端點 驗證 權杖 密鑰 連接 啟用 停用 測試 可達性",
            "native": true
          },
          {
            "tag": "module.packer",
            "en": "Packer (Image Builder)",
            "zh": "Packer（映像建置器）",
            "glyph": "",
            "keywords": "packer hashicorp image builder template hcl pkr.hcl json init validate fmt format build inspect plugin plugins var var-file variables provisioner builder source qemu docker aws azure vsphere amazon ami vm machine devops 映像 範本 建置 變數 插件",
            "native": true
          },
          {
            "tag": "module.worldmonitor",
            "en": "World Monitor",
            "zh": "世界監察",
            "glyph": "",
            "keywords": "world monitor worldmonitor news geopolitics finance commodity energy happy instability index intelligence dashboard globe map webview variant 世界 監察 新聞 地緣政治 金融 商品 能源 情報 儀表板 地球 不穩定指數",
            "native": true
          },
          {
            "tag": "module.webcloner",
            "en": "Website Cloner",
            "zh": "網站複製器",
            "glyph": "",
            "keywords": "website cloner clone copy site web page scrape download fetch assets html css js mirror rebuild reverse engineer ai agent webview2 design tokens 網站 複製 抓取 下載 鏡像 重建 設計符記",
            "native": true
          },
          {
            "tag": "module.pgadmin",
            "en": "Postgres Tool",
            "zh": "Postgres 工具 / pgAdmin",
            "glyph": "",
            "keywords": "postgres postgresql pgadmin sql database query npgsql connection schema table view server psql 資料庫 數據庫 查詢 表 檢視 結構描述 連線",
            "native": true
          },
          {
            "tag": "module.sqlitebrowser",
            "en": "SQLite Browser",
            "zh": "SQLite 資料庫瀏覽器",
            "glyph": "",
            "keywords": "sqlite db browser database sql query table view index trigger schema structure browse data edit insert delete row cell paged datagrid execute run csv export microsoft.data.sqlite managed dbbrowser db3 .db .sqlite .sqlite3 資料庫 數據庫 瀏覽器 查詢 表 檢視 索引 觸發器 結構 瀏覽 編輯 插入 刪除 列 單元格 分頁 執行 匯出",
            "native": true
          },
          {
            "tag": "module.filezilla",
            "en": "FTP / SFTP",
            "zh": "FTP／SFTP 檔案傳輸",
            "glyph": "",
            "keywords": "ftp sftp ftps filezilla file transfer client site manager upload download dual pane transfer queue resume tls ssh private key dpapi 檔案傳輸 上載 下載 站台 佇列 續傳 私鑰",
            "native": true
          },
          {
            "tag": "module.fileserver",
            "en": "File Server (FTP/SFTP host)",
            "zh": "檔案伺服器（FTP／SFTP 主機）",
            "glyph": "",
            "keywords": "file server host share folder ftp sftp ftps serve expose docker atmoz sftp alpine ftp server passive port range lan connection string self host multiple shares 檔案伺服器 主機 分享 資料夾 對外 共享 連接埠 被動 區域網 連線字串 多分享 自託管",
            "native": true
          },
          {
            "tag": "module.bitwarden",
            "en": "Bitwarden Vault",
            "zh": "Bitwarden 密碼庫",
            "glyph": "",
            "keywords": "bitwarden bw vault password manager login unlock master password totp 2fa two factor generate generator passphrase secret sync clipboard self-hosted vaultwarden 密碼庫 密碼 管理 解鎖 主密碼 驗證碼 產生 同步 機密",
            "native": true
          },
          {
            "tag": "module.keepass",
            "en": "KeePass Vault",
            "zh": "密碼保險庫",
            "glyph": "",
            "keywords": "keepass kdbx kee pass password vault local offline manager database master password key file open create entry group tree generator generate clipboard auto clear search lock unlock aes chacha20 argon2 salsa20 native encrypt decrypt 密碼保險庫 密碼庫 密碼 管理 本機 離線 主密碼 鎖匙檔 群組 項目 產生器 搜尋 鎖定 解鎖 加密 解密 原生",
            "native": true
          },
          {
            "tag": "module.feedreader",
            "en": "Feed Reader",
            "zh": "RSS 閱讀器",
            "glyph": "",
            "keywords": "feed reader rss atom quiterss fluent reader news subscriptions articles summary xml httpclient local json offline in-app native 閱讀器 RSS Atom Feed 訂閱 新聞 文章 摘要 原生 app內 本機",
            "native": true
          },
          {
            "tag": "module.quicktype",
            "en": "quicktype",
            "zh": "JSON 轉型別",
            "glyph": "",
            "keywords": "quicktype json schema typescript graphql postman code generator type csharp c# python go rust java kotlin swift objective-c c++ dart ruby elm php scala types just-types namespace newtonsoft system.text.json npm node jsontotype codegen 程式碼產生 型別 產生 轉換 結構",
            "native": true
          },
          {
            "tag": "module.decompiler",
            "en": ".NET Decompiler",
            "zh": ".NET 反編譯器",
            "glyph": "",
            "keywords": "decompiler decompile dotnet .net assembly browser ilspy il disassembler disassemble cil msil reverse engineer csharp c# managed dll exe metadata public key token target framework referenced assemblies resources namespace type member method property field event icsharpcode decompiler reflection metadata save cs view source 反編譯器 反編譯 反組譯 組件 瀏覽 程式集 中間語言 逆向工程 受控 後設資料 公開金鑰權杖 目標框架 參考組件 資源 命名空間 型別 成員 另存原始碼",
            "native": true
          },
          {
            "tag": "module.aws",
            "en": "AWS CLI",
            "zh": "AWS 命令列",
            "glyph": "",
            "keywords": "aws amazon web services cli s3 ec2 iam lambda cloudwatch logs sts profile credentials region sso configure bucket instance describe generic command browser skeleton dynamodb sns sqs ssm cloudformation route53 rds 雲端 命令列 設定檔 憑證 區域 儲存桶 執行個體",
            "native": true
          },
          {
            "tag": "module.cmdnotfound",
            "en": "Command Not Found",
            "zh": "搵唔到指令",
            "glyph": "",
            "keywords": "command not found cmdnotfound commandnotfound winget suggest suggestion powershell pwsh powershell 7 profile import-module feedback provider experimental feature pscommandnotfoundsuggestion psfeedbackprovider microsoft.winget.commandnotfound missing command package powertoys clone enable disable hook winget-suggest 搵唔到指令 找不到命令 建議 套件 掛鈎 設定檔 啟用 停用 實驗功能",
            "native": true
          },
          {
            "tag": "module.configbackup",
            "en": "Config & Backup",
            "zh": "設定與備份",
            "glyph": "",
            "keywords": "config backup snapshot restore export import bundle zip git schedule mirror reg winget integrity secrets ssh api key encrypt aes password 設定 備份 快照 還原 匯出 匯入 排程 鏡像 加密 密鑰 機密",
            "native": true
          }
        ],
        "subgroups": []
      },
      {
        "id": "security-privacy",
        "en": "Security & Privacy",
        "zh": "安全與私隱",
        "modules": [
          {
            "tag": "module.vault-volumes",
            "en": "WinForge Vault",
            "zh": "WinForge 保險庫",
            "glyph": "",
            "keywords": "vault volume container encrypt encrypted disk encryption mount dismount unmount drive letter password keyfile pim benchmark aes serpent twofish on the fly cryptography 保險庫 加密 容器 磁碟 掛載 卸載 密碼 鎖匙檔 磁碟區",
            "native": true
          },
          {
            "tag": "module.camoufox",
            "en": "Camoufox Profiles",
            "zh": "Camoufox 指紋設定檔",
            "glyph": "",
            "keywords": "camoufox anti detect antidetect browser firefox fingerprint spoof profile profiles cookies user agent useragent timezone locale proxy multi account multiaccount stealth automation playwright launch export import git commit history version control clone build from source 指紋 瀏覽器 反偵測 防偵測 設定檔 多帳號 代理 時區 匯出 匯入 歷史 版本控制 由原始碼建置",
            "native": true
          }
        ],
        "subgroups": []
      }
    ]
  },
  {
    "id": "toolbox",
    "en": "Toolbox",
    "zh": "工具箱",
    "native": false,
    "directModules": [],
    "groups": [
      {
        "id": "json-data",
        "en": "JSON & Data",
        "zh": "JSON 與資料",
        "modules": [
          {
            "tag": "module.jsontools",
            "en": "JSON & XML Tools",
            "zh": "JSON 同 XML 工具",
            "glyph": "",
            "keywords": "json xml format pretty minify validate escape unescape sort keys 格式化 美化 壓縮 驗證 轉義 還原 排序 鍵",
            "native": false
          },
          {
            "tag": "module.jsonpath",
            "en": "JSON Query",
            "zh": "JSON 查詢",
            "glyph": "",
            "keywords": "json jsonpath query path filter flatten leaf tree parse 查詢 路徑 攤平 葉子 解析",
            "native": false
          },
          {
            "tag": "module.jsondiff",
            "en": "JSON Diff",
            "zh": "JSON 比對",
            "glyph": "",
            "keywords": "json diff compare difference merge path added removed changed multiset 比對 差異 比較 對比 合併 路徑 新增 刪除 改變",
            "native": false
          },
          {
            "tag": "module.jsonflatten",
            "en": "JSON Flatten",
            "zh": "JSON 扁平化",
            "glyph": "",
            "keywords": "json flatten unflatten nested dotted path keys array index expand collapse 扁平化 還原 巢狀 點分隔 路徑 陣列 索引 展開 摺疊",
            "native": false
          },
          {
            "tag": "module.jsonpatch",
            "en": "JSON Patch",
            "zh": "JSON 修補",
            "glyph": "",
            "keywords": "json patch rfc 6902 diff apply pointer merge operations add remove replace test copy move 修補 差異 比較 套用 運算 指標 陣列",
            "native": false
          },
          {
            "tag": "module.jsonltools",
            "en": "JSONL Tools",
            "zh": "JSONL 工具",
            "glyph": "",
            "keywords": "jsonl ndjson json lines array validate minify pretty convert JSONL 換行 分行 陣列 驗證 壓縮 美化 轉換",
            "native": false
          },
          {
            "tag": "module.jsonmergepatch",
            "en": "JSON Merge Patch",
            "zh": "JSON 合併修補",
            "glyph": "",
            "keywords": "json merge patch rfc 7386 diff apply shallow merge null delete document target source 合併 修補 差異 套用 淺層 刪除 文件 目標 來源",
            "native": false
          },
          {
            "tag": "module.jsonschema",
            "en": "JSON Schema Validator",
            "zh": "JSON 結構描述驗證器",
            "glyph": "",
            "keywords": "json schema validate draft-07 validator required properties type enum pattern 結構描述 驗證 綱要 類型",
            "native": false
          },
          {
            "tag": "module.jsonpointer",
            "en": "JSON Pointer",
            "zh": "JSON 指標",
            "glyph": "",
            "keywords": "json pointer rfc 6901 path resolve query escape tilde slash index 指標 路徑 解析 逃逸 索引",
            "native": false
          },
          {
            "tag": "module.jsonstat",
            "en": "JSON Analyzer",
            "zh": "JSON 分析器",
            "glyph": "",
            "keywords": "json analyzer stats structure keys depth nodes parse validate 分析 統計 結構 鍵 深度 節點 解析 驗證",
            "native": false
          },
          {
            "tag": "module.jsonsort",
            "en": "JSON Key Sorter",
            "zh": "JSON 鍵排序",
            "glyph": "",
            "keywords": "json sort keys normalise normalize alphabetical order pretty print minify indent recursive 排序 鍵 正規化 美化 壓縮 縮排 遞迴",
            "native": false
          },
          {
            "tag": "module.jsontots",
            "en": "JSON to Types",
            "zh": "JSON 轉型別",
            "glyph": "",
            "keywords": "json typescript interface csharp class type generate convert schema model dto 型別 型態 類別 介面 轉換 生成 產生",
            "native": false
          },
          {
            "tag": "module.csvjson",
            "en": "CSV / JSON",
            "zh": "CSV/JSON 轉換",
            "glyph": "",
            "keywords": "csv json convert converter parse rfc4180 delimiter table array header 轉換 逗號 表格 解析 標題列",
            "native": false
          },
          {
            "tag": "module.csvlint",
            "en": "CSV Linter",
            "zh": "CSV 檢查修復",
            "glyph": "",
            "keywords": "csv lint linter rfc 4180 repair fix quote delimiter ragged bom validate clean 檢查 修復 逗號 分隔符 引號 欄位 換行 驗證",
            "native": false
          },
          {
            "tag": "module.tomljson",
            "en": "TOML ↔ JSON",
            "zh": "TOML ↔ JSON 轉換",
            "glyph": "",
            "keywords": "toml json convert parse config 轉換 解析 設定檔 配置 互轉",
            "native": false
          },
          {
            "tag": "module.yamljson",
            "en": "YAML ↔ JSON",
            "zh": "YAML ↔ JSON 轉換",
            "glyph": "",
            "keywords": "yaml json convert parse config serialize 轉換 解析 設定檔 序列化 互轉",
            "native": false
          },
          {
            "tag": "module.tableformat",
            "en": "Table Formatter",
            "zh": "表格排版",
            "glyph": "",
            "keywords": "table formatter csv tsv markdown ascii align columns delimiter pipe tab 表格 排版 對齊 分隔符 逗號 直線 標題",
            "native": false
          },
          {
            "tag": "module.htmltable",
            "en": "HTML Table Convert",
            "zh": "HTML 表格轉換",
            "glyph": "",
            "keywords": "html table csv tsv markdown convert thead tbody tr td parse generate 表格 轉換 逗號 標記 解析 產生",
            "native": false
          },
          {
            "tag": "module.iniedit",
            "en": "INI Editor",
            "zh": "INI 編輯器",
            "glyph": "",
            "keywords": "ini config configuration parser editor section key value comment settings 設定 組態 解析 分區 鍵 值 註解 編輯器",
            "native": false
          },
          {
            "tag": "module.envfile",
            "en": "Dotenv Editor",
            "zh": ".env 編輯器",
            "glyph": "",
            "keywords": "env dotenv environment variables editor convert shell json docker export KEY=VALUE 環境變數 編輯器 轉換",
            "native": false
          },
          {
            "tag": "module.envsubst",
            "en": "Variable Substitute",
            "zh": "變數代入",
            "glyph": "",
            "keywords": "envsubst variable substitution template placeholder dollar brace default environment interpolate 變數 代入 範本 佔位符 預設值 環境變數 插值",
            "native": false
          },
          {
            "tag": "module.faker",
            "en": "Data Faker",
            "zh": "假資料產生器",
            "glyph": "",
            "keywords": "lorem ipsum fake data generator placeholder mock seed name email uuid address 假資料 佔位文字 產生器 測試 種子 姓名 電郵 地址",
            "native": false
          },
          {
            "tag": "module.sqlformat",
            "en": "SQL Formatter",
            "zh": "SQL 格式化",
            "glyph": "",
            "keywords": "sql format formatter beautify beautifier prettify minify query indent keywords 格式化 美化 壓縮 查詢 縮排 關鍵字 資料庫",
            "native": false
          },
          {
            "tag": "module.xpathtester",
            "en": "XPath Tester",
            "zh": "XPath 測試器",
            "glyph": "",
            "keywords": "xpath xml query node selectnodes xdocument expression evaluate 測試 查詢 節點 表達式 路徑",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "text-tools",
        "en": "Text Tools",
        "zh": "文字工具",
        "modules": [
          {
            "tag": "module.texttools",
            "en": "Text Tools",
            "zh": "文字工具",
            "glyph": "",
            "keywords": "text case upper lower title slug sort dedupe shuffle reverse trim lines words count stats 文字 大細楷 排序 去重複 打亂 倒轉 修剪 統計 字數 slug",
            "native": false
          },
          {
            "tag": "module.caseconvert",
            "en": "Case Converter",
            "zh": "大小寫轉換",
            "glyph": "",
            "keywords": "case convert camel pascal snake kebab constant title sentence dot path train naming identifier variable rename 大小寫 命名 轉換 駝峰 蛇形 烤串 常數 標題 變數 識別碼",
            "native": false
          },
          {
            "tag": "module.textreplace",
            "en": "Find & Replace",
            "zh": "尋找及取代",
            "glyph": "",
            "keywords": "find replace regex text substitute multi-rule pattern 尋找 取代 替換 正規表達式 批量 文字",
            "native": false
          },
          {
            "tag": "module.textdiff",
            "en": "Text Diff",
            "zh": "文字差異比對",
            "glyph": "",
            "keywords": "diff compare text lines lcs unified merge changes 文字 差異 比較 對比 逐行 合併",
            "native": false
          },
          {
            "tag": "module.textstats",
            "en": "Text Statistics",
            "zh": "文字統計",
            "glyph": "",
            "keywords": "text statistics readability word count characters sentences paragraphs reading time speaking time flesch kincaid grade syllables frequency 文字統計 可讀性 字數 字元 句數 段落 閱讀時間 朗讀時間 易讀度 年級 音節 字頻",
            "native": false
          },
          {
            "tag": "module.stringinspector",
            "en": "String Inspector",
            "zh": "字串檢查器",
            "glyph": "",
            "keywords": "string text unicode utf8 utf16 utf32 codepoint grapheme normalize nfc nfd escape unescape diacritics ascii reverse length bytes 字串 文字 統計 碼位 字素 正規化 轉義 音標 位元組 反轉",
            "native": false
          },
          {
            "tag": "module.stringcompare",
            "en": "String Compare",
            "zh": "字串相似度",
            "glyph": "",
            "keywords": "string compare similarity levenshtein edit distance damerau hamming jaro winkler substring subsequence diff text 字串 相似度 比較 編輯距離 差異 文字",
            "native": false
          },
          {
            "tag": "module.textredact",
            "en": "Text Redactor",
            "zh": "文字遮蔽",
            "glyph": "",
            "keywords": "redact mask pii privacy email phone credit card ip address censor scrub 遮蔽 遮罩 個資 私隱 電郵 電話 信用卡 IP 打格 過濾",
            "native": false
          },
          {
            "tag": "module.textescape",
            "en": "String Escaper",
            "zh": "字串跳脫",
            "glyph": "",
            "keywords": "escape unescape string json csharp javascript java python xml html url regex csv sql shell encode decode 字串 跳脫 還原 轉義 逃逸 編碼 解碼 正則 網址",
            "native": false
          },
          {
            "tag": "module.linetools",
            "en": "Line Tools",
            "zh": "行工具",
            "glyph": "",
            "keywords": "line tools text lines number prefix suffix quotes join split reverse sort dedupe deduplicate trim shuffle 行工具 文字 行 編號 前綴 後綴 引號 合併 拆分 反轉 排序 去重 修剪 打亂",
            "native": false
          },
          {
            "tag": "module.textsort",
            "en": "Line Sort & Dedupe",
            "zh": "行排序同去重",
            "glyph": "",
            "keywords": "sort lines dedupe duplicate unique reverse shuffle natural order alphabetical trim blank 排序 去重 重複 反轉 打亂 自然排序 行",
            "native": false
          },
          {
            "tag": "module.textwrap",
            "en": "Text Wrap",
            "zh": "文字換行",
            "glyph": "",
            "keywords": "text wrap reflow rewrap unwrap column width word boundary hanging indent prefix comment commit message readme 文字 換行 重排 拉直 縮排 前綴 闊度 段落 註解",
            "native": false
          },
          {
            "tag": "module.textcolumns",
            "en": "Column Tools",
            "zh": "欄位文字工具",
            "glyph": "",
            "keywords": "columns column text delimited split tab csv comma extract delete reorder align transpose trim 欄位 欄 分隔符 分割 表格 抽取 刪除 重排 對齊 行列互換 修剪",
            "native": false
          },
          {
            "tag": "module.texttemplate",
            "en": "Template Renderer",
            "zh": "模板渲染器",
            "glyph": "",
            "keywords": "template render placeholder mustache handlebars merge fields json key value substitute 模板 渲染 佔位符 合併 欄位 變數 替換 生成",
            "native": false
          },
          {
            "tag": "module.leet",
            "en": "Fancy Text",
            "zh": "花式文字",
            "glyph": "",
            "keywords": "fancy text unicode font styler bold italic fraktur script circled fullwidth strikethrough underline leetspeak upside down 花式文字 特殊字體 粗體 斜體 花體 圓圈 全形 刪除線 底線 火星文 倒轉字",
            "native": false
          },
          {
            "tag": "module.boxtext",
            "en": "Box & Banner Text",
            "zh": "文字方框 / 橫幅",
            "glyph": "",
            "keywords": "box banner ascii border frame comment block banner text wrap 文字方框 橫幅 邊框 框框 註解 ASCII 標題",
            "native": false
          },
          {
            "tag": "module.loremtext",
            "en": "Lorem Ipsum Generator",
            "zh": "假文產生器",
            "glyph": "",
            "keywords": "lorem ipsum placeholder text dummy filler paragraphs sentences words html generator 假文 佔位文字 填充 段落 句子 產生器",
            "native": false
          },
          {
            "tag": "module.wordfreq",
            "en": "Word Frequency",
            "zh": "詞頻統計",
            "glyph": "",
            "keywords": "word frequency count bigram character stop words rank text analysis csv 詞頻 字頻 統計 排名 文字 分析 計數",
            "native": false
          },
          {
            "tag": "module.phonetic",
            "en": "Phonetic Speller",
            "zh": "拼讀字母表",
            "glyph": "",
            "keywords": "phonetic alphabet nato icao alpha bravo charlie spell radio callsign police speller 拼讀 字母表 無線電 呼號 拼寫 讀音",
            "native": false
          },
          {
            "tag": "module.numberformat",
            "en": "Number Formatter",
            "zh": "數字格式化",
            "glyph": "",
            "keywords": "number format formatter thousands separator decimal currency percent scientific accounting zero-pad culture globalization 數字 格式 格式化 千分位 小數 貨幣 百分比 科學記數 會計 補零 地區",
            "native": false
          },
          {
            "tag": "module.numwords",
            "en": "Number to Words",
            "zh": "數字轉文字",
            "glyph": "",
            "keywords": "number words spell out cardinal ordinal roman numeral currency dollars cents amount cheque spelling 數字 文字 拼寫 序數 羅馬數字 金額 銀碼 支票 大寫 讀數",
            "native": false
          },
          {
            "tag": "module.numwordsx",
            "en": "Number to Words+",
            "zh": "數字轉文字（加強版）",
            "glyph": "",
            "keywords": "number words spell cardinal ordinal currency dollars cents pounds pence chinese uppercase financial daxie 數字 轉 文字 大寫 小寫 中文 貨幣 元角分 序數 基數 一百二十三 壹佰貳拾參",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "markup-docs-symbols",
        "en": "Markup, Docs & Symbols",
        "zh": "標記文件與符號",
        "modules": [
          {
            "tag": "module.markdown",
            "en": "Markdown Preview",
            "zh": "Markdown 預覽",
            "glyph": "",
            "keywords": "markdown md preview render html editor document 文件 標記 預覽 排版 編輯 渲染",
            "native": false
          },
          {
            "tag": "module.markdowntoc",
            "en": "Markdown TOC",
            "zh": "Markdown 目錄",
            "glyph": "",
            "keywords": "markdown toc table of contents heading anchor slug outline github 目錄 標題 錨點 大綱 連結",
            "native": false
          },
          {
            "tag": "module.mdtable",
            "en": "Markdown Table",
            "zh": "Markdown 表格",
            "glyph": "",
            "keywords": "markdown table csv tsv pipe grid align github gfm reformat convert 表格 標記 逗號 定位鍵 直線 對齊 轉換 重排",
            "native": false
          },
          {
            "tag": "module.htmltomd",
            "en": "HTML to Markdown",
            "zh": "HTML 轉 Markdown",
            "glyph": "",
            "keywords": "html markdown md convert converter web strip tags entities decode 轉換 標記 網頁 標籤 實體 剝除",
            "native": false
          },
          {
            "tag": "module.htmlpreview",
            "en": "HTML Preview",
            "zh": "HTML 預覽",
            "glyph": "",
            "keywords": "html preview live render webview editor escape encode 網頁 預覽 即時 渲染 編輯器 轉義 原始碼",
            "native": false
          },
          {
            "tag": "module.htmlformat",
            "en": "HTML Formatter",
            "zh": "HTML 格式化",
            "glyph": "",
            "keywords": "html format formatter beautify prettify minify minifier indent tidy markup tags web HTML 格式化 美化 壓縮 縮排 標籤 網頁 排版",
            "native": false
          },
          {
            "tag": "module.cssformat",
            "en": "CSS Formatter",
            "zh": "CSS 格式化",
            "glyph": "",
            "keywords": "css format beautify minify prettify stylesheet compress whitespace indent 格式化 美化 壓縮 精簡 樣式表 縮排 排版",
            "native": false
          },
          {
            "tag": "module.htmlentities",
            "en": "HTML Entities",
            "zh": "HTML 實體",
            "glyph": "",
            "keywords": "html entities encode decode escape named numeric nbsp copy 實體 編碼 解碼 跳脫 具名 數字",
            "native": false
          },
          {
            "tag": "module.metatags",
            "en": "Meta Tag Generator",
            "zh": "Meta 標籤產生器",
            "glyph": "",
            "keywords": "meta tag html head seo open graph twitter card canonical viewport theme charset og description keywords 標籤 網頁 元資料 搜尋引擎 分享 預覽 標題 描述",
            "native": false
          },
          {
            "tag": "module.asciiart",
            "en": "ASCII Banner",
            "zh": "ASCII 橫幅",
            "glyph": "",
            "keywords": "ascii art banner text figlet monospace 橫幅 文字 藝術 標題 大字",
            "native": false
          },
          {
            "tag": "module.asciitable",
            "en": "ASCII Table",
            "zh": "ASCII 表",
            "glyph": "",
            "keywords": "ascii table character codes control codes hex octal binary latin-1 charset reference 字元 字元碼 控制碼 十六進 八進 二進 參考表",
            "native": false
          },
          {
            "tag": "module.emoji",
            "en": "Emoji Picker",
            "zh": "Emoji 選擇器",
            "glyph": "",
            "keywords": "emoji smiley face symbol copy clipboard picker 表情 符號 貼圖 複製 剪貼簿 選擇器",
            "native": false
          },
          {
            "tag": "module.symbols",
            "en": "Symbols Palette",
            "zh": "特殊符號調色盤",
            "glyph": "",
            "keywords": "symbols special characters unicode glyph arrows math currency greek punctuation box drawing stars fractions superscript subscript copy 符號 特殊字元 統一碼 箭嘴 數學 貨幣 希臘 標點 框線 星 分數 上下標 複製",
            "native": false
          },
          {
            "tag": "module.charmap",
            "en": "Character Map",
            "zh": "字元對照表",
            "glyph": "",
            "keywords": "character map unicode codepoint glyph symbol emoji utf-8 utf-16 html entity charmap block 字元 字符 對照表 統一碼 萬國碼 碼位 符號 表情符號 特殊符號",
            "native": false
          },
          {
            "tag": "module.unicodeinspect",
            "en": "Unicode Inspector",
            "zh": "Unicode 檢查器",
            "glyph": "",
            "keywords": "unicode inspector codepoint character utf-8 utf-16 category combining zero-width confusable rune 統一碼 字元 碼位 類別 組合 零寬 檢查",
            "native": false
          },
          {
            "tag": "module.binarytext",
            "en": "Text to Binary",
            "zh": "文字轉二進位",
            "glyph": "",
            "keywords": "binary text codes utf-8 encode decode ascii hex octal decimal base converter 二進位 文字 編碼 解碼 十六進位 八進位 十進位 位元組 轉換",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "encoding-ids-codes",
        "en": "Encoding, IDs & Codes",
        "zh": "編碼識別碼與條碼",
        "modules": [
          {
            "tag": "module.encoder",
            "en": "Encode / Decode",
            "zh": "編碼 / 解碼",
            "glyph": "",
            "keywords": "encode decode base64 base64url url percent html entity hex bytes jwt token decoder 編碼 解碼 十六進位 位元組 權杖 網址",
            "native": false
          },
          {
            "tag": "module.encodingconv",
            "en": "Encoding Converter",
            "zh": "編碼轉換",
            "glyph": "",
            "keywords": "encoding charset utf-8 utf-16 ascii latin-1 bom line ending crlf lf cr convert text file 編碼 字元集 換行 轉換 位元組順序標記 文字檔",
            "native": false
          },
          {
            "tag": "module.base32",
            "en": "Base32 / 58 / 85",
            "zh": "Base32 / 58 / 85 編解碼",
            "glyph": "",
            "keywords": "base32 base58 base85 ascii85 rfc4648 bitcoin adobe encode decode codec 編碼 解碼 編解碼 位元組",
            "native": false
          },
          {
            "tag": "module.ascii85",
            "en": "Ascii85 / Base85",
            "zh": "Ascii85 / 八十五進位編碼",
            "glyph": "",
            "keywords": "ascii85 base85 z85 zeromq rfc1924 adobe encode decode encoder decoder btoa ipv6 八十五進位 編碼 解碼 十六進位",
            "native": false
          },
          {
            "tag": "module.imgbase64",
            "en": "Image / Base64",
            "zh": "圖片 ↔ Base64",
            "glyph": "",
            "keywords": "image base64 data uri encode decode png jpg gif webp clipboard 圖片 圖像 編碼 解碼 資料 網址 剪貼簿",
            "native": false
          },
          {
            "tag": "module.morse",
            "en": "Morse Code",
            "zh": "摩斯電碼",
            "glyph": "",
            "keywords": "morse code encode decode dots dashes international telegraph flash 摩斯 密碼 電碼 點 劃 電報",
            "native": false
          },
          {
            "tag": "module.romannum",
            "en": "Roman Numerals",
            "zh": "羅馬數字",
            "glyph": "",
            "keywords": "roman numerals number convert MCMXCIV validate 羅馬 數字 轉換 大寫 驗證",
            "native": false
          },
          {
            "tag": "module.guidgen",
            "en": "GUID & ID Generator",
            "zh": "GUID 同 ID 產生器",
            "glyph": "",
            "keywords": "guid uuid ulid nanoid random id generator identifier crockford base32 version variant bytes GUID UUID 唯一識別碼 隨機 產生器 識別碼 位元組 版本",
            "native": false
          },
          {
            "tag": "module.uuidv5",
            "en": "Namespaced UUID",
            "zh": "具名空間 UUID",
            "glyph": "",
            "keywords": "uuid guid v5 v3 sha1 md5 namespace rfc 4122 deterministic hash dns url oid x500 具名空間 命名空間 雜湊 確定性 標識符",
            "native": false
          },
          {
            "tag": "module.uuidv7",
            "en": "UUID v7",
            "zh": "UUID v7 識別碼",
            "glyph": "",
            "keywords": "uuid v7 guid time-ordered sortable rfc 9562 timestamp generate decode 識別碼 時間排序 產生 解碼",
            "native": false
          },
          {
            "tag": "module.ulid",
            "en": "ULID / Snowflake",
            "zh": "ULID／Snowflake 工具",
            "glyph": "",
            "keywords": "ulid snowflake identifier id generate decode timestamp crockford base32 monotonic twitter discord epoch worker sequence guid uuid 識別碼 產生 解碼 時間戳 序號",
            "native": false
          },
          {
            "tag": "module.shortid",
            "en": "Short ID Encoder",
            "zh": "短碼編碼器",
            "glyph": "",
            "keywords": "short id encoder base62 base58 base36 crockford base32 nanoid random id url-safe encode decode bigint 短碼 編碼 解碼 隨機 隨機ID 進制 位元組 URL安全",
            "native": false
          },
          {
            "tag": "module.slugify",
            "en": "Slugify",
            "zh": "網址別名",
            "glyph": "",
            "keywords": "slug slugify url permalink kebab hyphen diacritics transliterate case seo 網址 別名 短網址 連字號 去重音 大小寫",
            "native": false
          },
          {
            "tag": "module.checkdigit",
            "en": "Check Digit Validator",
            "zh": "檢查碼驗證器",
            "glyph": "",
            "keywords": "checksum luhn credit card isbn ean upc iban mod97 check digit validator barcode 檢查碼 校驗碼 信用卡 條碼 銀行帳號",
            "native": false
          },
          {
            "tag": "module.hexdump",
            "en": "Hex Dump",
            "zh": "十六進位傾印",
            "glyph": "",
            "keywords": "hex dump hexdump bytes offset ascii binary view file text utf-8 十六進位 傾印 位元組 偏移 二進位 檢視",
            "native": false
          },
          {
            "tag": "module.mimetypes",
            "en": "MIME Type Lookup",
            "zh": "MIME 類型查詢",
            "glyph": "",
            "keywords": "mime content-type extension media type header upload web server octet-stream MIME 類型 內容類型 副檔名 檔名 偵測 上載 標頭",
            "native": false
          },
          {
            "tag": "module.barcode",
            "en": "Barcode Generator",
            "zh": "條碼產生器",
            "glyph": "",
            "keywords": "barcode code128 code39 ean-13 ean13 1d symbology svg generate scan retail 條碼 條形碼 產生 掃描 零售",
            "native": false
          },
          {
            "tag": "module.loremimg",
            "en": "Placeholder Image",
            "zh": "佔位圖",
            "glyph": "",
            "keywords": "placeholder image svg dummy mockup data uri base64 width height colour generator 佔位圖 預留圖 假圖 圖片 產生器 資料URI",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "crypto-passwords",
        "en": "Crypto & Passwords",
        "zh": "加密與密碼",
        "modules": [
          {
            "tag": "module.hasher",
            "en": "Hash & Checksum",
            "zh": "雜湊與校驗和",
            "glyph": "",
            "keywords": "hash checksum md5 sha1 sha256 sha384 sha512 crc32 hmac verify fingerprint digest file text 雜湊 校驗和 校驗 指紋 核對 摘要 加密 檔案 驗證",
            "native": false
          },
          {
            "tag": "module.jwtinspect",
            "en": "JWT Inspector",
            "zh": "JWT 檢查器",
            "glyph": "",
            "keywords": "jwt json web token decode verify hmac hs256 hs384 hs512 claims exp iat signature 權杖 解碼 驗證 簽名 聲明 到期",
            "native": false
          },
          {
            "tag": "module.jwtbuild",
            "en": "JWT Builder",
            "zh": "JWT 建立同驗證",
            "glyph": "",
            "keywords": "jwt json web token hmac sign verify hs256 hs384 hs512 base64url claims exp nbf iat 權杖 簽名 驗證 宣告 密鑰",
            "native": false
          },
          {
            "tag": "module.totp",
            "en": "TOTP Authenticator",
            "zh": "TOTP 驗證器",
            "glyph": "",
            "keywords": "totp hotp authenticator 2fa mfa otp one-time code rfc6238 rfc4226 authenticator authy base32 otpauth 驗證器 兩步驗證 雙重認證 一次性密碼 驗證碼",
            "native": false
          },
          {
            "tag": "module.ciphers",
            "en": "Classic Ciphers",
            "zh": "經典密碼",
            "glyph": "",
            "keywords": "cipher encode decode rot13 caesar atbash vigenere a1z26 morse code encrypt decrypt 密碼 加密 解密 凱撒 阿特巴希 維吉尼亞 摩斯電碼",
            "native": false
          },
          {
            "tag": "module.passgen",
            "en": "Password Generator",
            "zh": "密碼產生器",
            "glyph": "",
            "keywords": "password passphrase generator random secure entropy strength diceware csprng 密碼 通行短語 隨機 產生器 安全 熵值 強度",
            "native": false
          },
          {
            "tag": "module.diceware",
            "en": "Passphrase Generator",
            "zh": "密語產生器",
            "glyph": "",
            "keywords": "diceware passphrase password words memorable entropy random generator secure 密語 通行短語 密碼 詞語 熵 隨機 產生器",
            "native": false
          },
          {
            "tag": "module.passwordstrength",
            "en": "Password Strength",
            "zh": "密碼強度",
            "glyph": "",
            "keywords": "password strength entropy crack time secure passphrase check 密碼 強度 熵值 破解時間 安全 檢查 通行密碼",
            "native": false
          },
          {
            "tag": "module.entropy",
            "en": "Entropy Analyzer",
            "zh": "熵值分析",
            "glyph": "",
            "keywords": "entropy shannon randomness bits information chi-square histogram frequency hex utf-8 熵 隨機 隨機度 資訊 亂度 卡方 直方圖 頻率 十六進位",
            "native": false
          },
          {
            "tag": "module.unixperm",
            "en": "chmod Calculator",
            "zh": "chmod 計算機",
            "glyph": "",
            "keywords": "chmod unix permission octal symbolic rwx setuid setgid sticky linux file mode 權限 八進位 符號 檔案模式",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "web-http",
        "en": "Web & HTTP",
        "zh": "網頁與 HTTP",
        "modules": [
          {
            "tag": "module.urltools",
            "en": "URL Tools",
            "zh": "網址工具",
            "glyph": "",
            "keywords": "url uri link query string parameter encode decode escape unescape percent 網址 連結 查詢 參數 編碼 解碼 拆解",
            "native": false
          },
          {
            "tag": "module.queryedit",
            "en": "URL Query Editor",
            "zh": "網址查詢編輯器",
            "glyph": "",
            "keywords": "url query string parameters edit encode decode percent key value querystring 網址 查詢 參數 編碼 解碼",
            "native": false
          },
          {
            "tag": "module.curlgen",
            "en": "cURL Generator",
            "zh": "cURL 產生器",
            "glyph": "",
            "keywords": "curl fetch powershell invoke-restmethod http request api snippet code generator header bearer basic auth 產生器 請求 標頭 代碼 片段 網絡 呼叫",
            "native": false
          },
          {
            "tag": "module.httpstatus",
            "en": "HTTP Status Codes",
            "zh": "HTTP 狀態碼",
            "glyph": "",
            "keywords": "http status code reference response 1xx 2xx 3xx 4xx 5xx 404 500 web api 狀態碼 回應碼 網頁 錯誤碼",
            "native": false
          },
          {
            "tag": "module.httpheaders",
            "en": "HTTP Header Inspector",
            "zh": "HTTP 標頭檢測",
            "glyph": "",
            "keywords": "http header inspector headers response status redirect content-type curl request 標頭 檢測 回應 狀態 重新導向 網絡請求 網址",
            "native": false
          },
          {
            "tag": "module.httpheaderref",
            "en": "HTTP Headers Ref",
            "zh": "HTTP 標頭參考",
            "glyph": "",
            "keywords": "http header headers request response cache cors security cookie auth reference mime standard 標頭 標頭參考 請求 回應 快取 安全 曲奇 參考",
            "native": false
          },
          {
            "tag": "module.headerscore",
            "en": "Security Header Score",
            "zh": "安全標頭計分",
            "glyph": "",
            "keywords": "http header security score csp hsts x-frame-options referrer permissions coop coep scorecard grade 安全 標頭 計分 網頁 安全性 標頭評分 版本洩露",
            "native": false
          },
          {
            "tag": "module.haranalyzer",
            "en": "HAR Analyzer",
            "zh": "HAR 分析器",
            "glyph": "",
            "keywords": "har http archive network requests waterfall performance analyze json 網絡 請求 分析 效能 瀑布圖 狀態碼 傳輸",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "network-tools",
        "en": "Network Tools",
        "zh": "網絡工具",
        "modules": [
          {
            "tag": "module.ping",
            "en": "Ping & Traceroute",
            "zh": "網路測試（Ping・路由追蹤）",
            "glyph": "",
            "keywords": "ping traceroute tracert icmp latency rtt ttl packet loss network diagnose reachability dns 網路 測試 延遲 丟包 路由 追蹤 躍點 主機 連線",
            "native": false
          },
          {
            "tag": "module.dnslookup",
            "en": "DNS Lookup",
            "zh": "DNS 查詢",
            "glyph": "",
            "keywords": "dns lookup resolve record a aaaa mx txt ns cname ptr nslookup dig doh DNS 查詢 域名 解析 記錄 反向 郵件伺服器 名稱伺服器",
            "native": false
          },
          {
            "tag": "module.dnsref",
            "en": "DNS Records Reference",
            "zh": "DNS 記錄參考",
            "glyph": "",
            "keywords": "dns records reference a aaaa cname mx txt ns soa srv caa dmarc spf dkim zone file 域名 記錄 參考 區域檔 郵件 解析",
            "native": false
          },
          {
            "tag": "module.portscan",
            "en": "Port Scanner",
            "zh": "連接埠掃描",
            "glyph": "",
            "keywords": "port scanner tcp scan network ports open service reachability diagnostic 連接埠 埠 掃描 網絡 開放 服務 診斷 通訊埠",
            "native": false
          },
          {
            "tag": "module.subnetcalc",
            "en": "Subnet Calculator",
            "zh": "子網計算器",
            "glyph": "",
            "keywords": "subnet cidr ipv4 netmask network broadcast wildcard host class rfc1918 vlsm 子網 遮罩 網絡 廣播 主機 前綴 私有",
            "native": false
          },
          {
            "tag": "module.subnetv6",
            "en": "IPv6 Tools",
            "zh": "IPv6 工具",
            "glyph": "",
            "keywords": "ipv6 subnet prefix cidr eui-64 mac address expand compress link-local unique-local multicast global network mask 位址 子網 前綴 遮罩 展開 壓縮 多播 鏈路本地 唯一本地 全球單播 介面識別碼",
            "native": false
          },
          {
            "tag": "module.ipinfo",
            "en": "IP & Network Info",
            "zh": "IP 同網絡資訊",
            "glyph": "",
            "keywords": "ip network adapter mac ipv4 ipv6 gateway dns public ip lan wifi ethernet 網絡 網卡 位址 閘道 公開ip 網絡資訊",
            "native": false
          },
          {
            "tag": "module.wol",
            "en": "Wake-on-LAN",
            "zh": "網絡喚醒",
            "glyph": "",
            "keywords": "wol wake on lan magic packet remote power boot mac udp broadcast 網絡喚醒 遠端開機 魔術封包 喚醒 開機 網卡",
            "native": false
          },
          {
            "tag": "module.mactools",
            "en": "MAC Address Tools",
            "zh": "MAC 位址工具",
            "glyph": "",
            "keywords": "mac address ethernet hardware physical oui vendor unicast multicast locally administered format normalize colon hyphen cisco dotted generate random MAC 位址 網卡 硬件 實體位址 廠商 單播 多播 本地管理 格式 轉換 冒號 生成 隨機",
            "native": false
          },
          {
            "tag": "module.hostsedit",
            "en": "Hosts File Editor",
            "zh": "主機檔編輯器",
            "glyph": "",
            "keywords": "hosts file editor dns block ad tracker 0.0.0.0 localhost domain blocklist etc drivers hostname 主機檔 編輯器 封鎖 廣告 追蹤 網域 遮蔽",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "dev-helpers",
        "en": "Dev Helpers",
        "zh": "開發小工具",
        "modules": [
          {
            "tag": "module.regextester",
            "en": "Regex Tester",
            "zh": "正則表達式測試",
            "glyph": "",
            "keywords": "regex regular expression tester match groups replace pattern dotnet regexoptions ignorecase multiline timeout 正則 正規表達式 表達式 測試 比對 群組 取代 樣式",
            "native": false
          },
          {
            "tag": "module.regexcheat",
            "en": "Regex Cheatsheet",
            "zh": "正則速查",
            "glyph": "",
            "keywords": "regex regular expression cheatsheet reference tokens character class anchor quantifier lookaround flags .net 正則 正規表達式 速查 參考 字元類 錨點 量詞",
            "native": false
          },
          {
            "tag": "module.globtester",
            "en": "Glob Tester",
            "zh": "Glob 樣式測試器",
            "glyph": "",
            "keywords": "glob pattern wildcard regex match path filter minimatch 樣式 萬用字元 配對 路徑 正則",
            "native": false
          },
          {
            "tag": "module.semverrange",
            "en": "Semver Range Tester",
            "zh": "語意化版本範圍測試器",
            "glyph": "",
            "keywords": "semver semantic version range node-semver caret tilde prerelease 語意化 版本 範圍 測試 相容 依賴",
            "native": false
          },
          {
            "tag": "module.gitignore",
            "en": "Gitignore Generator",
            "zh": ".gitignore 產生器",
            "glyph": "",
            "keywords": "gitignore git ignore template node python visual studio vscode jetbrains rust java maven go cpp macos windows linux 忽略 範本 產生器",
            "native": false
          },
          {
            "tag": "module.pathdoctor",
            "en": "PATH Doctor",
            "zh": "PATH 醫生",
            "glyph": "",
            "keywords": "path environment variable editor cleanup dedupe dead folders system user 環境變數 路徑 編輯 清理 去重複 死項 系統 使用者",
            "native": false
          },
          {
            "tag": "module.envdiff",
            "en": "Env Snapshot & Diff",
            "zh": "環境變數快照同差異",
            "glyph": "",
            "keywords": "environment variables snapshot diff env path compare added removed changed process user machine export clipboard 環境變數 快照 差異 比較 匯出 路徑",
            "native": false
          },
          {
            "tag": "module.clipinspect",
            "en": "Clipboard Inspector",
            "zh": "剪貼簿檢查器",
            "glyph": "",
            "keywords": "clipboard formats inspect paste data package 剪貼簿 剪貼板 格式 檢查 貼上 資料",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "time-dates",
        "en": "Time & Dates",
        "zh": "時間與日期",
        "modules": [
          {
            "tag": "module.timer",
            "en": "Timer & Stopwatch",
            "zh": "計時器・碼錶・番茄鐘",
            "glyph": "",
            "keywords": "timer stopwatch countdown pomodoro focus lap clock 計時器 碼錶 秒錶 倒數 倒數計時 番茄鐘 專注 分段 時鐘",
            "native": false
          },
          {
            "tag": "module.worldclock",
            "en": "World Clock",
            "zh": "世界時鐘",
            "glyph": "",
            "keywords": "world clock time zone converter utc offset city 世界時鐘 時區 轉換 時間 城市 時差 協調世界時",
            "native": false
          },
          {
            "tag": "module.datecalc",
            "en": "Date Calculator",
            "zh": "日期計算器",
            "glyph": "",
            "keywords": "date days weeks age birthday countdown business days iso week leap year difference add subtract 日期 計算 日數 週數 年齡 生日 倒數 工作日 閏年 星期",
            "native": false
          },
          {
            "tag": "module.durationcalc",
            "en": "Duration Calculator",
            "zh": "時長計算器",
            "glyph": "",
            "keywords": "duration time calculator timespan add subtract sum convert hours minutes seconds days 時長 時間 計算器 計算 加 減 加總 換算 小時 分鐘 秒 日 乘 除",
            "native": false
          },
          {
            "tag": "module.epoch",
            "en": "Epoch Converter",
            "zh": "紀元轉換器",
            "glyph": "",
            "keywords": "epoch unix timestamp time converter iso 8601 utc local relative 紀元 時間戳 Unix 時間 轉換 時區 世界協調時間 相對",
            "native": false
          },
          {
            "tag": "module.cronbuilder",
            "en": "Cron Builder",
            "zh": "Cron 建構器",
            "glyph": "",
            "keywords": "cron schedule crontab expression job timer next run 排程 定時 計劃任務 運算式 crontab 下次執行",
            "native": false
          },
          {
            "tag": "module.cronnext",
            "en": "Cron Next Runs",
            "zh": "Cron 下次執行時間",
            "glyph": "",
            "keywords": "cron schedule crontab next run fire time timezone quartz job 排程 定時 下次執行 時區 運算式 觸發時間",
            "native": false
          },
          {
            "tag": "module.tzplanner",
            "en": "Timezone Planner",
            "zh": "時區會議規劃",
            "glyph": "",
            "keywords": "timezone time zone meeting planner world clock utc offset working hours dst 時區 時間 會議 規劃 世界時鐘 辦公時間 跨時區 UTC",
            "native": false
          },
          {
            "tag": "module.icalendar",
            "en": "iCalendar Builder",
            "zh": "日曆檔產生器",
            "glyph": "",
            "keywords": "icalendar ics calendar event vevent vcalendar rrule valarm reminder recurrence appointment meeting invite 日曆 行事曆 活動 提醒 重複 會議 邀請 匯出",
            "native": false
          },
          {
            "tag": "module.calendarmonth",
            "en": "Calendar",
            "zh": "月曆",
            "glyph": "",
            "keywords": "calendar month week iso weekday date day-of-year today 月曆 日曆 月份 星期 週數 日期 今日",
            "native": false
          },
          {
            "tag": "module.countdownevent",
            "en": "Event Countdown",
            "zh": "事件倒數",
            "glyph": "",
            "keywords": "countdown event timer date deadline days remaining 事件 倒數 計時 日期 死線 剩餘",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "calculators-numbers",
        "en": "Calculators & Numbers",
        "zh": "計算與數字",
        "modules": [
          {
            "tag": "module.calculator",
            "en": "Calculator",
            "zh": "計數機",
            "glyph": "",
            "keywords": "calculator math expression evaluator arithmetic trig scientific hex binary octal 計數機 數學 表達式 計算 三角函數 科學 進位 十六進位 二進位",
            "native": false
          },
          {
            "tag": "module.percentcalc",
            "en": "Percentage Calculator",
            "zh": "百分比計算器",
            "glyph": "",
            "keywords": "percent percentage ratio tip change increase decrease calculator split gcd simplify 百分比 比例 貼士 分帳 變化率 加減 化簡 計算器",
            "native": false
          },
          {
            "tag": "module.loancalc",
            "en": "Loan Calculator",
            "zh": "貸款計算",
            "glyph": "",
            "keywords": "loan mortgage amortization interest payment finance emi principal rate 貸款 按揭 供樓 攤還 利息 還款 月供 本金 年利率",
            "native": false
          },
          {
            "tag": "module.bmi",
            "en": "Health Calculators",
            "zh": "健康計算器",
            "glyph": "",
            "keywords": "bmi bmr calorie tdee body fat navy mifflin health weight height 健康 計算器 體重 身高 體脂 熱量 代謝 卡路里",
            "native": false
          },
          {
            "tag": "module.unitconvert",
            "en": "Unit Converter",
            "zh": "單位換算",
            "glyph": "",
            "keywords": "unit convert converter length mass weight temperature celsius fahrenheit kelvin data bytes speed area time pressure metric imperial 單位 換算 轉換 長度 質量 重量 溫度 攝氏 華氏 資料 速度 面積 時間 壓力 公制 英制",
            "native": false
          },
          {
            "tag": "module.baseconvert",
            "en": "Base Converter",
            "zh": "進位轉換",
            "glyph": "",
            "keywords": "base radix binary octal decimal hex hexadecimal bitwise shift programmer bigint convert 進位 二進制 八進制 十進制 十六進制 位元 轉換 程式員",
            "native": false
          },
          {
            "tag": "module.scinotation",
            "en": "Scientific Notation",
            "zh": "科學記數法",
            "glyph": "",
            "keywords": "scientific engineering notation exponent mantissa significant figures SI prefix E-notation kilo mega giga 科學 工程 記數法 指數 有效數字 前綴 換算",
            "native": false
          },
          {
            "tag": "module.aspectratio",
            "en": "Aspect Ratio",
            "zh": "長寬比計算",
            "glyph": "",
            "keywords": "aspect ratio resolution 16:9 scale gcd megapixels dimensions widescreen 長寬比 解析度 比例 縮放 像素 闊高 畫面比",
            "native": false
          },
          {
            "tag": "module.numseq",
            "en": "Number Sequence",
            "zh": "數字序列",
            "glyph": "",
            "keywords": "number sequence generator arithmetic geometric fibonacci prime primes range squares cubes triangular powers series list 數字 序列 產生器 等差 等比 斐波那契 質數 範圍 平方 立方 三角數 次方",
            "native": false
          },
          {
            "tag": "module.tallycounter",
            "en": "Tally Counter",
            "zh": "點數計數器",
            "glyph": "",
            "keywords": "tally counter count clicker increment score reps 點數 計數器 計數 數數 點算 分數 加減",
            "native": false
          },
          {
            "tag": "module.randomizer",
            "en": "Randomizer",
            "zh": "隨機工具箱",
            "glyph": "",
            "keywords": "random rng integer coin flip dice roll d20 shuffle pick list secure unbiased 隨機 亂數 擲骰 擲銀仔 抽籤 打亂 洗牌 骰仔 公字",
            "native": false
          },
          {
            "tag": "module.expensesplit",
            "en": "Expense Splitter",
            "zh": "夾錢分帳",
            "glyph": "",
            "keywords": "expense split settle bill share money owe balance transfer trip dinner 夾錢 分帳 找數 埋單 均分 結餘 欠錢 AA制",
            "native": false
          },
          {
            "tag": "module.unitprice",
            "en": "Unit Price",
            "zh": "單位價格",
            "glyph": "",
            "keywords": "unit price per unit compare value cheapest best deal grocery shopping 單位價格 格價 比較 最抵 每單位 買嘢 慳錢",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "colors-design",
        "en": "Colors & Design",
        "zh": "色彩與設計",
        "modules": [
          {
            "tag": "module.colortools",
            "en": "Color Tools",
            "zh": "色彩工具",
            "glyph": "",
            "keywords": "color colour hex rgb hsl hsv cmyk palette contrast wcag accessibility converter swatch 色彩 顏色 調色 對比度 無障礙 轉換 色板",
            "native": false
          },
          {
            "tag": "module.colorpalette",
            "en": "Color Palette",
            "zh": "色彩調色板",
            "glyph": "",
            "keywords": "color palette scheme hex rgb hsl complementary analogous triadic tetradic monochromatic shades tints swatch css json 色彩 調色板 配色 顏色 色板 十六進位 互補色 類似色 三等分色 單色系 匯出",
            "native": false
          },
          {
            "tag": "module.colormix",
            "en": "Colour Mixer",
            "zh": "混色器",
            "glyph": "",
            "keywords": "color colour mix blend gradient srgb linear hsl ratio swatch hex css steps 顏色 混色 漸變 漸層 色板 比例 調色",
            "native": false
          },
          {
            "tag": "module.colorname",
            "en": "Named Colors",
            "zh": "命名色彩",
            "glyph": "",
            "keywords": "color colour name named css x11 hex rgb nearest swatch palette 色彩 顏色 命名色 具名色 十六進位 網頁色",
            "native": false
          },
          {
            "tag": "module.colorblind",
            "en": "Color Blindness Sim",
            "zh": "色盲模擬",
            "glyph": "",
            "keywords": "color blindness colour blind cvd protanopia deuteranopia tritanopia achromatopsia grayscale accessibility contrast hex rgb 色盲 色覺 色弱 紅綠色盲 灰階 無障礙 對比 顏色 模擬",
            "native": false
          },
          {
            "tag": "module.contrastgrid",
            "en": "Contrast Grid",
            "zh": "對比度網格",
            "glyph": "",
            "keywords": "contrast wcag accessibility ratio color colour hex rgb aa aaa a11y 對比度 無障礙 顏色 色彩 可讀性",
            "native": false
          },
          {
            "tag": "module.gradient",
            "en": "Gradient Generator",
            "zh": "漸變產生器",
            "glyph": "",
            "keywords": "gradient css linear radial colour color stops hex angle 漸變 顏色 色標 線性 放射 CSS 十六進位",
            "native": false
          },
          {
            "tag": "module.cssunits",
            "en": "CSS Unit Converter",
            "zh": "CSS 單位換算",
            "glyph": "",
            "keywords": "css units px em rem pt vw vh percent convert web design root font size 單位 換算 網頁 設計 字級",
            "native": false
          }
        ],
        "subgroups": []
      },
      {
        "id": "everyday-life",
        "en": "Everyday & Life",
        "zh": "日常生活",
        "modules": [
          {
            "tag": "module.notes",
            "en": "Scratchpad",
            "zh": "便箋",
            "glyph": "",
            "keywords": "notes scratchpad memo jot text save persistent 便箋 筆記 記事 備忘 草稿 儲存",
            "native": false
          },
          {
            "tag": "module.habittracker",
            "en": "Habit Tracker",
            "zh": "習慣追蹤器",
            "glyph": "",
            "keywords": "habit tracker streak daily routine checklist weekly goals 習慣 追蹤 打卡 連續 每日 例行 目標 週",
            "native": false
          },
          {
            "tag": "module.namegen",
            "en": "Name Generator",
            "zh": "名稱產生器",
            "glyph": "",
            "keywords": "name generator username project company startup fantasy band slug random codename 名稱 產生器 隨機 用戶名 專案 公司 初創 奇幻 樂隊 代號",
            "native": false
          },
          {
            "tag": "module.recyclebin",
            "en": "Recycle Bin Manager",
            "zh": "回收筒管理",
            "glyph": "",
            "keywords": "recycle bin trash empty delete free space cleanup storage 回收筒 垃圾筒 清空 刪除 釋放空間 清理",
            "native": false
          },
          {
            "tag": "module.filesplit",
            "en": "File Split & Join",
            "zh": "檔案切割／合併",
            "glyph": "",
            "keywords": "split join file parts chunk merge concatenate 001 002 sha256 切割 合併 分割 檔案 部件 分片 併合 重組",
            "native": false
          }
        ],
        "subgroups": []
      }
    ]
  },
  {
    "id": "windows-11",
    "en": "Windows 11",
    "zh": "視窗 11",
    "native": true,
    "directModules": [],
    "groups": [
      {
        "id": "all-tweaks",
        "en": "All Tweaks",
        "zh": "全部調校",
        "modules": [
          {
            "tag": "module.tweaks.appearance-personalisation",
            "en": "Appearance & Personalisation",
            "zh": "外觀與個人化",
            "glyph": "",
            "keywords": "Appearance & Personalisation 外觀與個人化 tweak tweaks 調校 windows Accent colour 主題色 Accent colour on Start & taskbar 開始與工作列顯示主題色 Accent colour on title bars & borders 標題列與邊框顯示主題色 Translucent selection rectangle 半透明選取框 Show seconds in clock 時鐘顯示秒數 Dark mode 深色模式 Show window contents while dragging 拖曳時顯示視窗內容 Drop shadows for icon labels 圖示標籤陰影 Open colour settings 開啟色彩設定 Snap layout flyout on hover 懸停顯示貼齊版面 Start menu layout 開始功能表版面 Taskbar animations 工作列動畫 Combine taskbar buttons 合併工作列按鈕 Transparency effects 透明效果 Disable wallpaper JPEG compression 停用桌布 JPEG 壓縮 Window min/max animations 視窗縮放動畫",
            "native": false
          },
          {
            "tag": "module.tweaks.apps-startup",
            "en": "Apps & Startup",
            "zh": "應用程式與啟動",
            "glyph": "",
            "keywords": "Apps & Startup 應用程式與啟動 tweak tweaks 調校 windows Analyze component store 分析元件存放區 Open Default apps settings 開啟預設應用程式設定 Open Installed apps settings 開啟已安裝應用程式設定 Kill 'Not Responding' apps 結束無回應嘅應用程式 List auto-start programs 列出自動啟動程式 Restart File Explorer 重新啟動檔案總管 Restart Print Spooler 重新啟動列印多工緩衝處理器 Open Startup apps settings 開啟開機應用程式設定 Update Microsoft Store apps 更新 Microsoft Store 應用程式 Top processes by memory 記憶體用量最高嘅程序 List installed apps 列出已安裝應用程式 Update all apps 更新所有應用程式 List available app updates 列出可更新嘅應用程式",
            "native": false
          },
          {
            "tag": "module.tweaks.browser-control",
            "en": "Browser Control",
            "zh": "瀏覽器控制",
            "glyph": "",
            "keywords": "Browser Control 瀏覽器控制 tweak tweaks 調校 windows Open in App mode 用應用程式模式開 Open Clear data dialog 開清除資料對話框 Launch with GPU disabled 停用 GPU 啟動 Open Downloads page 開下載頁 Open Extensions page 開擴充功能頁 Open experimental flags 開實驗性功能 Open DNS cache page 開 DNS 快取頁 Open Guest window 開訪客視窗 Open History page 開瀏覽紀錄頁 Open Incognito window 開無痕視窗 Open in Kiosk mode 用 Kiosk 全螢幕模式 Launch Chrome 啟動 Chrome Open a new window 開新視窗 Launch without extensions 停用擴充功能啟動 Open URL in new window 喺新視窗開網址 Open specific profile 開指定設定檔 Launch with proxy server 用代理伺服器啟動 Launch in safe diagnostic mode 用安全診斷模式啟動 Open Settings page 開設定頁 Open Version info 開版本資料 Launch site in app mode 用應用程式模式開網站 Clear browsing data 清除瀏覽資料 Open downloads 開下載項目 Open extensions page 開擴充功能頁 Open favorites manager 開我的最愛管理 Open Edge experiments 開實驗功能頁 Open GPU diagnostics 開 GPU 診斷 Open IE mode settings 開 IE 模式設定 Open InPrivate window 開無痕視窗 Launch in kiosk mode 用自助服務模式開啟 Launch Microsoft Edge 開啟 Microsoft Edge Open network logger 開網路紀錄工具 Open URL in new window 喺新視窗開網址 Open password settings 開密碼設定 Open privacy settings 開私隱設定 Open profile settings 開設定檔設定 Open default apps settings 開預設應用程式設定 Open Edge settings 開 Edge 設定 Open startup boost setting 開啟動加速設定 Show Edge version 睇 Edge 版本 Chrome: address autofill Chrome：地址自動填入 Chrome: background mode Chrome：背景執行模式 Chrome: bookmark bar Chrome：書籤列 Chrome: default browser prompt Chrome：預設瀏覽器提示 Chrome: set homepage policy Chrome：設定主頁政策 Chrome: incognito availability Chrome：無痕模式可用性 Chrome: usage metrics reporting Chrome：使用統計報告 Chrome: set new tab page Chrome：設定新分頁版面 Chrome: password manager Chrome：密碼管理員 Chrome: Safe Browsing Chrome：安全瀏覽 Edge: background mode Edge：背景執行模式 Edge: default browser prompt Edge：預設瀏覽器提示 Edge: set homepage policy Edge：設定主頁政策 Edge: hubs sidebar Edge：側邊欄 Edge: InPrivate availability Edge：InPrivate 可用性 Edge: password manager Edge：密碼管理員 Edge: web data personalization Edge：個人化內容 Edge: shopping assistant Edge：購物助手 Edge: SmartScreen Edge：SmartScreen Edge: startup boost Edge：啟動加速 Backup Chrome bookmarks 備份 Chrome 書籤 Backup Edge bookmarks 備份 Edge 書籤 Chrome profile disk usage Chrome 設定檔磁碟用量 Clear Chrome cache 清除 Chrome 快取 Clear Chrome cookies 清除 Chrome Cookies Clear Edge cache 清除 Edge 快取 Edge profile disk usage Edge 設定檔磁碟用量 Kill all Chrome processes 結束所有 Chrome 程序 Kill all Edge processes 結束所有 Edge 程序 List Chrome profiles 列出 Chrome 設定檔 List Edge profiles 列出 Edge 設定檔 List installed browsers 列出已安裝瀏覽器 Open Chrome user data folder 開啟 Chrome 用戶資料夾 Open Default apps 開啟預設應用程式 Open downloads folder 開啟下載資料夾 Open Edge download folder 開啟 Edge 下載資料夾 Open Edge user data folder 開啟 Edge 用戶資料夾 Reset Chrome Default profile 重設 Chrome 預設設定檔 Set default browser 設定預設瀏覽器 Show Chrome version 顯示 Chrome 版本 Edge efficiency mode policy Edge 效率模式政策 Edge startup behavior policy Edge 啟動行為政策 Flush DNS cache 清除 DNS 快取 List installed PWAs 列出已安裝 PWA List saved Wi-Fi profiles 列出已儲存 Wi-Fi Browser task manager note 瀏覽器工作管理員提示 DevTools shortcut note 開發人員工具捷徑提示 Capture webpage note 擷取網頁提示 Open a blank page 開空白頁 Open Chrome Web Store 開 Chrome 網上商店 Open Credential Manager 開認證管理員 Open Edge Collections 開 Edge 收藏集 Open Edge favorites 開 Edge 我的最愛 Open Edge settings 開 Edge 設定 Open Edge site permissions 開 Edge 網站權限 Open Edge startup pages 開 Edge 啟動頁設定 Open Internet Options 開網際網路選項 Open proxy settings 開 Proxy 設定 Open URL in default browser 喺預設瀏覽器開網址 Reset IE / WinINET settings 重設 IE / WinINET 設定",
            "native": false
          },
          {
            "tag": "module.tweaks.cleanup-storage",
            "en": "Cleanup & Storage",
            "zh": "清理與儲存",
            "glyph": "",
            "keywords": "Cleanup & Storage 清理與儲存 tweak tweaks 調校 windows Clear delivery optimisation cache 清除傳遞最佳化快取 Run Disk Cleanup 執行磁碟清理 DISM component cleanup DISM 元件清理 Empty clipboard 清空剪貼簿 Clear Windows event logs 清除 Windows 事件記錄 Clear Prefetch 清除 Prefetch Empty Recycle Bin 清空資源回收筒 Open Storage Sense settings 開啟儲存空間感知設定 Reset Microsoft Store cache 重設 Microsoft Store 快取 Clear thumbnail cache 清除縮圖快取 Clear user temp files 清除使用者暫存檔 Clear Windows Temp 清除 Windows 暫存 Clear Windows Update cache 清除 Windows Update 快取",
            "native": false
          },
          {
            "tag": "module.tweaks.debloat-annoyances",
            "en": "Debloat & Annoyances",
            "zh": "去煩擾",
            "glyph": "",
            "keywords": "Debloat & Annoyances 去煩擾 tweak tweaks 調校 windows Turn off Bing in Start search 熄開始搜尋嘅 Bing Turn off Click to Do 熄 Click to Do Disable Windows consumer features 停用 Windows 消費者功能 Turn off general content suggestions 熄一般內容建議 Remap the Copilot key to do nothing 將 Copilot 鍵改成乜都唔做 Turn off Windows Copilot 熄 Windows Copilot Turn off Cortana above lock screen 熄鎖屏上面嘅 Cortana Turn off Cortana consent in search 熄搜尋度嘅 Cortana 同意 Turn off Cortana 熄 Cortana Turn off web results in Search (policy) 用原則熄搜尋嘅網上結果 Turn off Edge Collections 熄 Edge Collections Turn off Edge Copilot page context 熄 Edge Copilot 讀取頁面內容 Turn off Edge Copilot sidebar 熄 Edge Copilot 側欄 Turn off Edge shopping assistant 熄 Edge 購物助手 Hide File Explorer sync-provider ads 收埋檔案總管嘅 sync 推廣 Turn off lock-screen fun facts & tips 熄鎖機畫面趣聞同貼士 Turn off lock-screen Spotlight tips 熄鎖機畫面 Spotlight 提示 Stop silently installing suggested apps 唔好靜雞雞裝建議 App Turn off Recall snapshots 熄 Recall 截圖記錄 Remove the Copilot app 移除 Copilot app Turn off \"Get even more out of Windows\" nag 熄「再進一步善用 Windows」嘅纏擾 Turn off search box web suggestions 熄搜尋框嘅網上建議 Turn off Search Highlights 熄搜尋焦點 (Search Highlights) Turn off web search in Search 熄搜尋度嘅網上搜尋 Hide the Settings homepage 隱藏設定首頁 Hide suggested content in Settings (1) 收埋設定入面嘅建議內容 (1) Hide suggested content in Settings (2) 收埋設定入面嘅建議內容 (2) Hide suggested content in Settings (3) 收埋設定入面嘅建議內容 (3) Turn off tips & suggestions (soft landing) 熄提示同建議（soft landing） Turn off account notifications in Start 熄開始選單嘅帳戶通知 Reduce Start \"recommended\" suggestions 減少開始選單「建議」推介 Turn off Start menu app suggestions 熄開始選單嘅 App 建議 Skip welcome experience after updates 更新後跳過歡迎畫面 Disable the Widgets board 停用小工具面板 Turn off Windows tips notifications 熄 Windows 貼士通知",
            "native": false
          },
          {
            "tag": "module.tweaks.developer-terminal",
            "en": "Developer & Terminal",
            "zh": "開發與終端機",
            "glyph": "",
            "keywords": "Developer & Terminal 開發與終端機 tweak tweaks 調校 windows Base64 encode text Base64 編碼文字 Claude CLI version Claude CLI 版本 Codex CLI version Codex CLI 版本 Curl a URL 用 curl 抓網址 GitHub auth status GitHub 登入狀態 GitHub CLI version GitHub CLI 版本 List Git aliases 列出 Git 別名 List global Git config 列出全域 Git 設定 Git version Git 版本 jq version jq 版本 New GUID 產生新 GUID Open Git Bash 開 Git Bash Open Windows Terminal 開 Windows Terminal Open VS Code here 喺呢度開 VS Code OpenCode CLI version OpenCode CLI 版本 OpenSSL version OpenSSL 版本 SHA256 of clipboard text 剪貼簿文字 SHA256 Generate SSH key (Ed25519) 產生 SSH 金鑰（Ed25519） List WSL distros 列出 WSL 發行版 WSL status WSL 狀態 Prune build cache 清理建置快取 Compose services Compose 服務 Prune containers 清理容器 List contexts 列出 context Image history help 映像檔歷史說明 Prune images 清理映像檔 List images 列出映像檔 Docker info Docker 資訊 Container logs help 容器日誌說明 List networks 列出網路 List running containers 列出執行緊嘅容器 List all containers 列出所有容器 Restart Docker Desktop 重啟 Docker Desktop Container stats 容器統計 Disk usage 磁碟用量 Prune system 清理系統 Container processes help 容器程序說明 Docker version Docker 版本 List volumes 列出卷 Prune volumes 清理卷 List active TCP connections 列出已建立嘅 TCP 連線 Show DNS client cache 顯示 DNS 客戶端快取 Echo a specific env var 顯示指定環境變數 Open Environment Variables editor 開啟環境變數編輯器 Find process by port 用端口搵進程 Show hostname 顯示主機名 Show IP configuration 顯示 IP 設定 Kill process by name 用名稱終止進程 Kill process by PID 用 PID 終止進程 List environment variables 列出環境變數 List listening TCP ports 列出監聽中嘅 TCP 端口 List local administrators 列出本機管理員 Show PATH per-line 逐行顯示 PATH Refresh environment 重新整理環境變數 List scheduled reboot tasks 列出排程重啟工作 Open System Properties (Advanced) 開啟系統內容(進階) Top processes by CPU 按 CPU 排名嘅進程 Show system uptime 顯示系統運行時間 Show current user SID 顯示目前用戶 SID Show whoami /all 顯示 whoami /all Deno version Deno 版本 .NET info .NET 資訊 .NET runtimes .NET 執行階段 .NET SDKs .NET SDK 清單 NuGet cache folders NuGet 快取資料夾 Go version Go 版本 Java version Java 版本 Node.js version Node.js 版本 Clear npm cache 清除 npm 快取 Verify npm cache 驗證 npm 快取 Global npm packages 全域 npm 套件 Outdated global npm 過時嘅全域 npm npm version npm 版本 Installed pip packages 已安裝嘅 pip 套件 Outdated pip packages 過時嘅 pip 套件 pip version pip 版本 List Python installs 列出 Python 安裝 Python version Python 版本 Rust compiler version Rust 編譯器版本 Locate node and python 搵 node 同 python Guided dev environment check 引導式開發環境檢查 Show configuration 顯示組態 Download only 只下載 Export installed list 匯出已安裝清單 Import package list 匯入套件清單 Install by ID 按 ID 安裝 List installed 列出已安裝 List pins 列出釘選 List with versions 列出連版本 Pin a package 釘選套件 Repair a package 修復套件 Search a package 搜尋套件 Search by tag 按標籤搜尋 Check winget version 檢查 winget 版本 Show package info 顯示套件資料 Show package versions 顯示套件版本 List sources 列出來源 Uninstall a package 解除安裝套件 Update sources 更新來源 List upgradable 列出可更新 Upgrade all apps 更新所有應用程式 Validate a manifest 驗證資訊清單",
            "native": false
          },
          {
            "tag": "module.tweaks.encryption-vault",
            "en": "Encryption & Vault",
            "zh": "加密與保險庫",
            "glyph": "",
            "keywords": "Encryption & Vault 加密與保險庫 tweak tweaks 調校 windows Add password protector 加入密碼保護器 Backup recovery key to AD 備份還原金鑰到 AD Backup recovery key to file 備份還原金鑰到檔案 Change volume password 更改磁碟區密碼 Open BitLocker control panel 開 BitLocker 控制台 Enable auto-unlock 啟用自動解鎖 Enable BitLocker on a drive 為磁碟啟用 BitLocker Force recovery on next boot 下次開機逼出還原畫面 Get-Tpm details Get-Tpm 詳情 Get-BitLockerVolume Get-BitLockerVolume List encrypted volumes 列出已加密磁碟區 Lock a drive 鎖定磁碟 Pause encryption/decryption 暫停加密／解密 Repair a damaged drive (repair-bde) 修復爛咗嘅磁碟 (repair-bde) Resume encryption/decryption 繼續加密／解密 Resume protection 恢復保護 Show key protectors 顯示金鑰保護器 BitLocker status (all) BitLocker 狀態（全部） BitLocker status (C:) BitLocker 狀態（C:） Suspend for 1 reboot 暫停 1 次重開機 TPM status (manage-bde) TPM 狀態（manage-bde） Turn off BitLocker (decrypt) 關閉 BitLocker（解密） Unlock with password 用密碼解鎖 List Certificate Stores 列出憑證庫 Check a Certificate Thumbprint 檢查憑證指紋 Show Code-Signing Certificates 顯示程式碼簽署憑證 Export a Certificate (Note) 匯出憑證（提示） Group Policy Cert Settings (Note) 群組原則憑證設定（提示） KeyStore Location (Note) 金鑰庫位置（提示） List Intermediate CA Certificates 列出中繼 CA 憑證 List Expiring Certificates 列出即將到期憑證 List All My-Store Certificate Fields 列出個人憑證庫詳細欄位 List Personal Certificates 列出個人憑證 List Trusted Root CAs 列出受信任根 CA List Windows Credentials 列出 Windows 認證 Open Manage User Certificates 開啟管理使用者憑證 Open Certificate Manager (Machine) 開啟憑證管理員（電腦） Open Certificate Manager (User) 開啟憑證管理員（使用者） Open Credential Manager 開啟認證管理員 Open Windows Hello Settings 開啟 Windows Hello 設定 Count Root Store Certificates 統計根憑證庫數量 List Smart Card Readers (Note) 列出智能卡讀卡機（提示） Show TPM Information 顯示 TPM 資訊 Add scan exclusion (C:\\Temp) 新增掃描排除 (C:\\Temp) ASR: all rules to Audit mode ASR：全部規則設稽核 List ASR rules (with names) 列出 ASR 規則（連名） ASR: block LSASS theft (Audit) ASR：封鎖 LSASS 竊取（稽核） ASR: block LSASS theft (Disabled) ASR：封鎖 LSASS 竊取（停用） ASR: block LSASS theft (Enabled) ASR：封鎖 LSASS 竊取（啟用） ASR: block LSASS theft (Warn) ASR：封鎖 LSASS 竊取（警告） Block an app (note) 封鎖應用程式 (說明) Show blocked connections (note) 顯示被擋連線 (說明) Cloud protection level (policy) 雲端保護等級 (政策) Enable controlled folder access 啟用受控資料夾存取 Enable firewall logging 啟用防火牆記錄 Turn firewall off 熄防火牆 Turn firewall on 開防火牆 List firewall rules 列出防火牆規則 Firewall status 防火牆狀態 Full scan 完整掃描 List exclusions 列出排除清單 Defender preferences Defender 偏好設定 Quick scan 快速掃描 Remove scan exclusion (C:\\Temp) 移除掃描排除 (C:\\Temp) Reset firewall to defaults 重設防火牆做預設 Set cloud protection level (high) 設定雲端保護等級 (高) Defender status Defender 狀態 Threat history 威脅記錄 Update signatures 更新特徵碼 Show Defender version 顯示 Defender 版本 Show EFS recovery agent 顯示 EFS 復原代理 Backup EFS certificate 備份 EFS 憑證 Show cipher help 顯示 cipher 說明 Create new EFS key 建立新 EFS 金鑰 Decrypt Documents folder 解密文件資料夾 Decrypt a folder (EFS) 解密資料夾 (EFS) Display folder encryption state 顯示資料夾加密狀態 Encrypt Documents folder 加密文件資料夾 Encrypt a folder (EFS) 加密資料夾 (EFS) Encrypt folder & subfolders 加密資料夾及子資料夾 List encrypted files 列出已加密檔案 Open EFS cert manager 開啟 EFS 憑證管理員 Manage EFS (rekeywiz) 管理 EFS (rekeywiz) Reset EFS keys (rekey) 重設 EFS 金鑰 Secure-delete a file 安全刪除檔案 Show EFS certificates 顯示 EFS 憑證 Show file encryption state 顯示檔案加密狀態 Show state of subfolders 顯示子資料夾狀態 Wipe free space on C: 抹除 C: 可用空間 Wipe free space on a drive 抹除磁碟可用空間 Auto-mount devices 自動掛載裝置 Start background task 啟動背景工作 Backup volume header 備份磁碟區檔頭 Snapshot raw header (first 131072 bytes) 快照原始檔頭（首 131072 位元組） Open settings / benchmark 打開設定／效能測試 Change container password 更改容器密碼 Create new volume 建立新磁碟區 Dismount all volumes 卸載所有磁碟區 Dismount drive letter 卸載指定磁碟機 Open vault guide 打開保險庫指南 Explore mounted volume 瀏覽已掛載磁碟區 Force dismount all 強制卸載全部 Launch WinForge Vault 啟動 WinForge 保險庫 Hidden volume wizard 隱藏磁碟區精靈 Keyfile generator 金鑰檔產生器 List mounted drives 列出已掛載磁碟 Open mount dialog 打開掛載對話框 Mount favorites 掛載最愛磁碟區 Mount with keyfile + PIM 用鎖匙檔加 PIM 掛載 Mount read-only 唯讀掛載 Mount as removable media 以可移除媒體掛載 Partition / device encryption 分割區／裝置加密 Restore volume header 還原磁碟區檔頭 Restore raw header snapshot 還原原始檔頭快照 Mount with PIM 以 PIM 掛載 System encryption tools 系統加密工具 Traveler disk setup 隨身碟設定 Show engine path 顯示引擎路徑 Volume Creation Wizard 磁碟區建立精靈 Wipe password cache 清除密碼快取",
            "native": false
          },
          {
            "tag": "module.tweaks.file-explorer",
            "en": "File Explorer",
            "zh": "檔案總管",
            "glyph": "",
            "keywords": "File Explorer 檔案總管 tweak tweaks 調校 windows Item check boxes 項目核取方塊 Classic right-click menu 經典右鍵選單 Confirm delete dialog 刪除確認對話框 Open Folder Options 開啟資料夾選項 Full path in title bar 標題列顯示完整路徑 Open File Explorer to 檔案總管開啟到 Expand to current folder 導覽窗格展開至目前資料夾 Restart File Explorer 重新啟動檔案總管 Launch folder windows in a separate process 資料夾視窗用獨立程序開啟 Show file extensions 顯示副檔名 Show frequent folders 顯示常用資料夾 Show hidden files 顯示隱藏檔案 Show recent files in Quick Access 快速存取顯示最近檔案 Show protected OS files 顯示受保護系統檔案",
            "native": false
          },
          {
            "tag": "module.tweaks.launcher-elevation",
            "en": "Launcher & Elevation",
            "zh": "啟動器與提權",
            "glyph": "",
            "keywords": "Launcher & Elevation 啟動器與提權 tweak tweaks 調校 windows Create no-UAC elevated launcher 建立免 UAC 提權啟動器 Open Task Scheduler 開啟工作排程器 Remove the elevated launcher 移除提權啟動器 Run WinForge elevated now 立即以管理員運行 Elevation status 提權狀態",
            "native": false
          },
          {
            "tag": "module.tweaks.maintenance-diagnostics",
            "en": "Maintenance & Diagnostics",
            "zh": "維護與診斷",
            "glyph": "",
            "keywords": "Maintenance & Diagnostics 維護與診斷 tweak tweaks 調校 windows Battery report 電池報告 Clear Application event log 清除應用程式記錄 Clear System event log 清除系統事件記錄 Clear Windows Update cache 清除更新快取 Computer info summary 電腦資訊摘要 Create restore point 建立還原點 Query 8.3 name creation 查詢 8.3 短檔名建立 Analyze component store 分析元件儲存區 Schedule full check & repair 排程完整檢查同修復 Check disk (read-only) 檢查磁碟（唯讀） Clean up component store 清理元件儲存區 Open Optimize Drives 開最佳化磁碟機 Query dirty bit 查詢污染位元 Volume free space 磁碟區可用空間 Filesystem info 檔案系統資訊 List disks 列出磁碟 List partitions 列出分割區 List volumes 列出磁碟區 Largest folders in Users Users 最大嘅資料夾 Open Disk Management 開磁碟管理 Optimize / defrag C: 最佳化／重組 C: Physical disk health 實體磁碟健康 Storage reliability counters 儲存可靠性計數器 Scan volume for errors 掃描磁碟區錯誤 Spot-fix volume errors 即時修復磁碟區錯誤 ReTrim SSD 重新 TRIM SSD List shadow copies 列出陰影複本 Shadow storage usage 陰影儲存用量 DISM check health DISM 快速檢查健康 DISM restore health DISM 修復健康 DISM scan health DISM 深入掃描健康 Show DNS cache 顯示 DNS 快取 List audio devices 列出音效裝置 Open Device Manager 開啟裝置管理員 List disk drives 列出磁碟機 List display adapters 列出顯示卡 Detailed driver query 詳細驅動程式清單 Export driver list to file 匯出驅動清單去檔案 GPU information 顯示卡資料 List third-party drivers 列出第三方驅動程式 Monitor information 顯示器資料 List network adapters 列出網絡卡 List printers 列出打印機 Count devices with problems 數有問題嘅裝置 Devices with errors 有錯誤嘅裝置 Restart active network adapters 重啟使用緊嘅網絡卡 Scan for hardware changes 掃描硬件變更 Signed drivers (top 30) 已簽署驅動（頭 30 個） Open Sound settings 開啟音效設定 List USB devices 列出 USB 裝置 Open DirectX Diagnostics 開 DirectX 診斷工具 Enable System Protection 開啟系統保護 Energy efficiency report 電源效率報告 Export System event log 匯出系統事件記錄 Flush + restart spooler queue 清空並重啟列印佇列 Last wake source 上次喚醒嘅來源 List automatic services 列出自動啟動嘅服務 Auto services that are stopped 自動但已停咗嘅服務 List startup programs 列出開機自動啟動程式 List installed updates 列出已安裝更新 List restore points 列出還原點 List running services 列出運行緊嘅服務 List scheduled tasks 列出排程工作 Open System Information 開系統資訊工具 Event Viewer 事件檢視器 Open System Information 開系統資訊 Open Services 開啟服務管理員 Open Startup apps settings 開啟開機應用程式設定 Open Task Scheduler 開啟工作排程器 Open Windows Update settings 開 Windows Update 設定 Check pending reboot 檢查待重啟 Open Performance Monitor 開效能監視器 Active power requests 目前嘅電源請求 Query a service 查詢服務狀態 Recent critical & error events 近期嚴重同錯誤事件 Open Reliability Monitor 開可靠性監視器 Reset Windows Update services 重置 Windows Update 服務 Open Resource Monitor 開資源監視器 Restart Windows Audio 重啟 Windows 音效服務 Restart BITS 重啟 BITS 背景傳輸服務 Restart DNS Client 重啟 DNS 用戶端服務 Restart Explorer 重啟檔案總管 Restart Windows Search 重啟 Windows 搜尋服務 Restart Print Spooler 重啟列印多工緩衝處理器 Restart Windows Time + resync 重啟 Windows 時間並同步 Run a scheduled task 執行排程工作 Set DiagTrack to Manual 將 DiagTrack 設為手動啟動 Run System File Checker 執行系統檔案檢查 (SFC) Verify system files only 淨係驗證系統檔案 Sleep study report 睡眠研究報告 Start DiagTrack 啟動 DiagTrack 服務 Stop DiagTrack 停止 DiagTrack 服務 System power report 系統電源報告 System information 系統資訊 Test internet connectivity 測試上網連線 Thermal zone temperature 熱區溫度 Top processes by memory 記憶體用得最多嘅程序 Uptime and last boot 開機時間同上次啟動 Devices armed to wake 可以喚醒系統嘅裝置 Download Windows Updates 下載 Windows 更新 Install Windows Updates 安裝 Windows 更新 Scan for Windows Updates 掃描 Windows 更新",
            "native": false
          },
          {
            "tag": "module.tweaks.network-internet",
            "en": "Network & Internet",
            "zh": "網絡與互聯網",
            "glyph": "",
            "keywords": "Network & Internet 網絡與互聯網 tweak tweaks 調校 windows Show active connections 顯示使用中連線 Reset DNS to automatic DNS 還原自動 Set DNS to Cloudflare (1.1.1.1) 設 DNS 為 Cloudflare Set DNS to Google (8.8.8.8) 設 DNS 為 Google Flush ARP cache 清除 ARP 快取 Flush DNS cache 清除 DNS 快取 Show full IP configuration 顯示完整 IP 設定 Ping test (Cloudflare) Ping 測試 Show public IP 顯示公共 IP Release IP address 釋放 IP 位址 Renew IP address 更新 IP 位址 Reset TCP/IP stack 重設 TCP/IP Reset Winsock catalog 重設 Winsock Show saved Wi-Fi profiles 顯示已儲存 Wi-Fi",
            "native": false
          },
          {
            "tag": "module.tweaks.network-pro",
            "en": "Network Pro",
            "zh": "網絡進階",
            "glyph": "",
            "keywords": "Network Pro 網絡進階 tweak tweaks 調校 windows Advanced properties 進階屬性 Adapter bindings 網絡卡綁定 Connection profile 連線設定檔 Disable an adapter 停用網絡卡 Disable IPv6 on adapter 停用網絡卡 IPv6 DNS client settings DNS 客戶端設定 Enable an adapter 啟用網絡卡 Show MAC addresses 顯示 MAC 地址 IP addresses IP 地址 IP configuration IP 設定 Link speed 連線速度 List network adapters 列出網絡卡 Adapter power management 網絡卡電源管理 Rename an adapter 重新命名網絡卡 Restart an adapter 重啟網絡卡 Routing table 路由表 Reset adapter to DHCP 重設為 DHCP Set adapter MTU 設定網絡卡 MTU Adapter statistics 網絡卡統計 Detailed statistics 詳細統計 Wake-on-LAN setting 網絡喚醒設定 Network adapter usage 網絡卡用量 Listening ports with process 監聽埠連程序 Latency to multiple hosts 多主機延遲 Show network category 顯示網絡類別 Active connections (netstat -ano) 活動連線 (netstat -ano) Routing table (netstat -rn) 路由表 (netstat -rn) DNS lookup (nslookup) DNS 查詢 (nslookup) Path ping to 1.1.1.1 Path ping 去 1.1.1.1 Ping 1.1.1.1 Ping 1.1.1.1 Ping default gateway Ping 預設閘道 Reset WinHTTP proxy 重設 WinHTTP 代理 Open proxy settings 開啟代理設定 Show WinHTTP proxy 顯示 WinHTTP 代理 TCP connections by state 按狀態列 TCP 連線 Telnet port test (note) Telnet 埠測試 (備註) Test-Connection (4 pings) Test-Connection (4 次 ping) Test-NetConnection (ping) Test-NetConnection (ping) Test TCP port 443 測試 TCP 埠 443 Test-NetConnection trace route Test-NetConnection 追蹤路由 Trace route to 1.1.1.1 追蹤路由去 1.1.1.1 Allow ping (ICMP echo) 允許 Ping（ICMP） Block an app inbound 封鎖應用程式入站 Count enabled rules 統計已啟用規則數量 Set default inbound to block 設定預設入站為封鎖 Enable firewall logging 啟用防火牆記錄 Enable Remote Desktop rule 啟用遠端桌面規則 Enable a rule group (Remote Assistance) 啟用規則群組（遠端協助） Export firewall policy to file 匯出防火牆政策到檔案 List blocked program rules 列出已封鎖程式規則 List rules grouped by group 依群組列出規則 List enabled inbound rules 列出已啟用嘅入站規則 List enabled outbound rules 列出已啟用嘅出站規則 Reset firewall to defaults 重設防火牆做預設值 Restore default policy file 從預設政策檔還原 Show all profiles state 顯示所有設定檔狀態 Show current active profile 顯示目前作用中設定檔 Show firewall log path 顯示防火牆記錄路徑 Show notification setting 顯示通知設定 Turn firewall off (all profiles) 關閉防火牆（所有設定檔） Turn firewall on (all profiles) 開啟防火牆（所有設定檔） Add persistent route 新增永久路由 Show ARP table 顯示 ARP 表 Clear DNS client cache 清 DNS 用戶端快取 Show DNS cache 顯示 DNS 快取 Flush DNS cache 清除 DNS 快取 Get DNS servers 查 DNS 伺服器 Full IP configuration 完整 IP 設定 Test DNS lookup 測試 DNS 查詢 Show public IP 顯示對外 IP Re-register DNS 重新註冊 DNS Release IP address 釋放 IP 位址 Renew IP address 更新 IP 位址 Reset DNS to DHCP DNS 還原做 DHCP Reset TCP/IP stack 重設 TCP/IP 堆疊 Reset Winsock catalog 重設 Winsock 目錄 Resolve a hostname 解析網域名稱 Print routing table 顯示路由表 Use Cloudflare DNS 用 Cloudflare DNS Use Google DNS 用 Google DNS Use Quad9 DNS 用 Quad9 DNS Block a network 封鎖一個網絡 Connect to a profile 連接到設定檔 Disconnect Wi-Fi 中斷 Wi-Fi 連線 Export profiles to folder 匯出設定檔到資料夾 Forget a network 忘記一個網絡 List SSIDs in range 列出範圍內 SSID Refresh networks 重新整理網絡 Show all profiles (details) 顯示所有設定檔（詳情） Show auto-config setting 顯示自動設定狀態 Show wireless capabilities 顯示無線功能 Show Wi-Fi drivers 顯示 Wi-Fi 驅動程式 Show network filters 顯示網絡篩選 Show hosted network 顯示主機網絡 Show wireless interfaces 顯示無線網絡介面 Scan networks (with BSSID) 掃描網絡（含 BSSID） Show Wi-Fi password 顯示 Wi-Fi 密碼 Show saved Wi-Fi profiles 顯示已儲存嘅 Wi-Fi 設定檔 Show MAC randomization 顯示 MAC 隨機化 Show signal strength 顯示訊號強度 Generate WLAN report 產生 WLAN 報告",
            "native": false
          },
          {
            "tag": "module.tweaks.performance-power",
            "en": "Performance & Power",
            "zh": "效能與電源",
            "glyph": "",
            "keywords": "Performance & Power 效能與電源 tweak tweaks 調校 windows Activate Balanced plan 啟用平衡電源計劃 Clear page file at shutdown 關機時清除分頁檔 Fast startup 快速啟動 Game DVR background recording 遊戲 DVR 背景錄製 Game Mode 遊戲模式 Turn off hibernation 熄咗休眠 Turn on hibernation 開啟休眠 Activate High performance plan 啟用高效能電源計劃 Menu show delay 選單顯示延遲 Disable power throttling 停用電源節流 No startup app delay 取消啟動程式延遲 Add Ultimate Performance plan 新增極致效能電源計劃 Visual effects mode 視覺效果模式",
            "native": false
          },
          {
            "tag": "module.tweaks.power-tools",
            "en": "Power Tools",
            "zh": "進階工具",
            "glyph": "",
            "keywords": "Power Tools 進階工具 tweak tweaks 調校 windows Show Windows activation status 顯示 Windows 啟用狀態 Generate battery report 產生電池報告 Check system drive 檢查系統磁碟 DISM restore health DISM 還原健康 Edit the hosts file 編輯 hosts 檔案 Generate energy report 產生能源報告 Lock the workstation 鎖定電腦 Open System Information 開啟系統資訊 Open Reliability Monitor 開啟可靠性監視器 Restart now 即刻重新啟動 System File Checker (SFC) 系統檔案檢查 (SFC) Shut down now 即刻關機 Sign out 登出 Sleep now 即刻睡眠",
            "native": false
          },
          {
            "tag": "module.tweaks.privacy-telemetry",
            "en": "Privacy & Telemetry",
            "zh": "私隱與遙測",
            "glyph": "",
            "keywords": "Privacy & Telemetry 私隱與遙測 tweak tweaks 調校 windows Activity history 活動記錄 Personalised ads (advertising ID) 個人化廣告（廣告識別碼） App launch tracking App 啟動追蹤 Never ask for feedback 永不索取意見 Inking & typing personalisation 手寫與輸入個人化 Block websites reading my language list 阻止網站讀取語言清單 Location access 位置存取 Online speech recognition 線上語音辨識 Suggested content in Settings 設定內嘅建議內容 Windows welcome tips Windows 歡迎提示 Suggestions in Start 開始功能表建議 Tailored experiences 量身打造嘅體驗 Diagnostic data level 診斷資料層級 Tips when using Windows 使用 Windows 時嘅提示",
            "native": false
          },
          {
            "tag": "module.tweaks.recipes-one-click",
            "en": "Recipes (one-click)",
            "zh": "一鍵流程",
            "glyph": "",
            "keywords": "Recipes (one-click) 一鍵流程 tweak tweaks 調校 windows Calm Windows (de-annoy) 靜化 Windows（去煩擾） Declutter taskbar 簡化工作列 Developer setup 開發人員設定 Disable telemetry tasks 停用遙測排程工作 Classic Explorer 經典檔案總管 Free up space 釋放空間 Gaming mode 遊戲模式 System health check 系統健康檢查 Security lock-down 保安加固 Network reset 網絡重置 Performance boost 效能提升 Privacy hardening 私隱強化 Quick cleanup 快速清理 Re-enable Windows nags 還原 Windows 提示 Create a restore point 建立還原點 Trim startup bloat 清開機臃腫 Update everything 全部更新",
            "native": false
          },
          {
            "tag": "module.tweaks.security",
            "en": "Security",
            "zh": "安全",
            "glyph": "",
            "keywords": "Security 安全 tweak tweaks 調校 windows Show BitLocker status 顯示 BitLocker 狀態 Exclude Downloads from Defender scans 將 Downloads 排除喺 Defender 掃描之外 Run a quick Defender scan 行一次 Defender 快速掃描 Update Defender definitions 更新 Defender 病毒定義 Turn Windows Firewall off (all profiles) 熄咗 Windows 防火牆（所有設定檔） Turn Windows Firewall on (all profiles) 開返 Windows 防火牆（所有設定檔） Hide last signed-in user name 隱藏上次登入嘅使用者名稱 Open Windows Security 開啟 Windows 安全性 Enable Remote Desktop 開啟遠端桌面 Require Ctrl+Alt+Del at sign-in 登入要按 Ctrl+Alt+Del SmartScreen for apps & files 應用程式同檔案 SmartScreen SmartScreen for Store & web content 商店同網頁內容 SmartScreen UAC prompt behaviour UAC 提示行為 Dim the desktop for UAC UAC 時將桌面變暗",
            "native": false
          },
          {
            "tag": "module.tweaks.system-boot",
            "en": "System & Boot",
            "zh": "系統與開機",
            "glyph": "",
            "keywords": "System & Boot 系統與開機 tweak tweaks 調校 windows Auto-restart on crash 當機自動重新開機 Restart to Advanced startup 重新開機入進階啟動 Restart to UEFI firmware 重新開機入 UEFI 韌體 Clipboard history 剪貼簿記錄 Cloud clipboard sync 雲端剪貼簿同步 Developer Mode 開發人員模式 Enable System Protection (C:) 啟用系統保護 (C:) Edit Environment Variables 編輯環境變數 Create God Mode folder 建立 God Mode 資料夾 Hung app close timeout 無回應程式關閉等候 Mapped-drive reconnect fix 網絡磁碟重連修正 Enable long path support 啟用長路徑支援 NumLock at startup 開機 NumLock Create a restore point 建立還原點 Verbose sign-in messages 詳細登入訊息",
            "native": false
          },
          {
            "tag": "module.tweaks.system-information",
            "en": "System Information",
            "zh": "系統資訊",
            "glyph": "",
            "keywords": "System Information 系統資訊 tweak tweaks 調校 windows Last boot 上次開機 Processor 處理器 Logical processors 邏輯處理器 System drive 系統磁碟 Graphics adapter 顯示卡 Device name 裝置名稱 Edition 版本 Installed memory 已安裝記憶體 Memory in use 記憶體用量 App runtime 應用程式執行階段 Time zone 時區 Uptime 運行時間 Signed-in user 登入使用者 Version & build 版本與組建",
            "native": false
          },
          {
            "tag": "module.tweaks.taskbar-start",
            "en": "Taskbar & Start",
            "zh": "工作列與開始功能表",
            "glyph": "",
            "keywords": "Taskbar & Start 工作列與開始功能表 tweak tweaks 調校 windows Taskbar alignment 工作列對齊 Show Chat/Copilot button 顯示聊天/Copilot 按鈕 Combine taskbar buttons 合併工作列按鈕 Show \"End Task\" on right-click 右鍵顯示「結束工作」 Show taskbar on all displays 所有螢幕顯示工作列 Open Taskbar settings 開啟工作列設定 Search on taskbar 工作列搜尋 Show all system tray icons 顯示所有系統匣圖示 Show seconds in system clock 系統時鐘顯示秒數 Show most used apps in Start 開始功能表顯示最常用程式 Show recently added apps in Start 開始功能表顯示最近新增程式 Show tips and recommendations in Start 開始功能表顯示提示同建議 Show Task View button 顯示工作檢視按鈕 Show Widgets button 顯示小工具按鈕",
            "native": false
          },
          {
            "tag": "module.tweaks.winaero-tweaks",
            "en": "Winaero Tweaks",
            "zh": "Winaero 進階調校",
            "glyph": "",
            "keywords": "Winaero Tweaks Winaero 進階調校 tweak tweaks 調校 windows Show accent color on Start, taskbar and action center 喺開始選單、工作列同操作中心顯示強調色 Colored title bars (accent on window title bars and borders) 彩色標題列（視窗標題列同邊框上色） Disable window shake (Aero Shake) to minimize 停用搖晃視窗（Aero Shake）最小化 Desktop icon horizontal spacing 桌面圖示水平間距 Inactive title bar color (accent on background windows) 非作用中標題列顏色（背景視窗用強調色） Use classic balloon tips instead of toast notifications 用傳統氣球提示取代浮動通知（toast） Menu show delay (snappier menus) 選單顯示延遲（選單更快彈出） Scrollbar width (thicker scroll bars) 捲動列闊度（較粗捲動列） Auto-End Tasks on Shutdown 關機時自動結束工作 Disable Win+L Lock 停用 Win+L 鎖定 Hung App Timeout (1s) 程式無回應等候時間（1 秒） Disable Shutdown Event Tracker 停用關機事件追蹤器 Wait To Kill App Timeout (2s) 強制結束程式等候時間（2 秒） Wait To Kill Service Timeout 強制結束服務等候時間 Disable blur on sign-in screen 停用登入畫面模糊效果 Disable automatic restart sign-on (ARSO) 停用自動重啟登入 (ARSO) Disable \"Press Ctrl+Alt+Del\" at logon 停用登入「按 Ctrl+Alt+Del」 Disable sign-in screen background image 停用登入畫面背景圖 Disable Windows startup sound 停用 Windows 開機音效 Show last interactive logon info 顯示上次互動登入資訊 Disable lock screen 停用上鎖畫面 Enable Num Lock at startup 開機時開啟 Num Lock Remove \"Cast to Device\" from context menu context menu 移除「投放到裝置」 Remove \"Edit with Photos\" from context menu context menu 移除「用相片編輯」 Remove \"Give access to\" / Share from context menu context menu 移除「授權存取 / 共用」 Remove \"Restore previous versions\" from context menu context menu 移除「還原舊版本」 Remove \"Scan with Microsoft Defender\" from context menu context menu 移除「用 Microsoft Defender 掃描」 Checkboxes for item selection 用核取方塊選取項目 Use compact view (reduce spacing) 使用精簡檢視（減少間距） Disable thumbnail cache 停用縮圖快取 Show drive letters first 磁碟機代號顯示喺前 Expand to current folder 導覽窗格展開至目前資料夾 Open Explorer to This PC 檔案總管開啟「本機」 Hide recent files in Quick access 唔顯示快速存取最近檔案 Show seconds in taskbar clock 工作列時鐘顯示秒數 Show Explorer status bar 顯示檔案總管狀態列 End task on taskbar right-click 工作列右鍵加入「結束工作」 Delivery Optimization: no download from other PCs 傳遞最佳化：唔由其他 PC 下載 Deny apps access to location (policy) 拒絕 App 存取位置 (政策) Disable app launch tracking 停用程式啟動追蹤 Disable feedback request frequency 停用意見反映要求頻率 Disable feedback notifications 停用意見反映通知 Disable tailored experiences with diagnostic data 停用以診斷資料提供的量身體驗 Disable telemetry autologger (DiagTrack) 停用遙測自動記錄器 (DiagTrack) Disable typing insights 停用輸入分析",
            "native": false
          },
          {
            "tag": "module.tweaks.windows-11-advanced",
            "en": "Windows 11 Advanced",
            "zh": "Windows 11 進階",
            "glyph": "",
            "keywords": "Windows 11 Advanced Windows 11 進階 tweak tweaks 調校 windows Restore classic volume mixer 還原傳統音量混音器 Show seconds in the system clock 系統時鐘顯示秒數 Always confirm before deleting files 刪除檔案前永遠確認 Disable Bing in Windows Search 停用 Windows 搜尋嘅 Bing Disable the lock screen 停用鎖定畫面 Disable Aero Shake to minimise 停用 Aero 搖晃最小化 Disable web search suggestions in Start 停用開始功能表網路搜尋建議 Disable thumbnail caching 停用縮圖快取 Drive letter display order 磁碟機代號顯示次序 Expand the legacy ribbon by default 預設展開舊版功能區 Show details in file operation dialogs 檔案操作對話框顯示詳細資料 Maximise icon cache size 加大圖示快取容量 Taskbar on multiple displays 多顯示器工作列模式 Hide frequent folders in Quick Access 快速存取隱藏常用資料夾 Hide recent files in Quick Access 快速存取隱藏最近檔案 Remove 3D Objects folder 移除 3D 物件資料夾 Restore folder windows at logon 登入時還原資料夾視窗 Launch folder windows in a separate process 用獨立處理序開資料夾視窗 Combine taskbar buttons / show labels 合併工作列按鈕／顯示標籤 Always show all tray icons (legacy) 永遠顯示所有系統匣圖示（舊版） Cursor blink rate 游標閃爍速度 Caret (cursor) width 游標闊度 Double-click speed 連按速度 Filter Keys 篩選鍵 First day of week 一週嘅第一日 Keyboard repeat delay 鍵盤重複延遲 Keyboard repeat rate 鍵盤重複速度 Disable mouse acceleration 停用滑鼠加速 Mouse threshold 1 off 滑鼠閾值 1 關閉 Mouse threshold 2 off 滑鼠閾值 2 關閉 Open Keyboard accessibility 開啟鍵盤協助工具 Open Mouse & touchpad settings 開啟滑鼠同觸控板設定 Open Region format settings 開啟地區格式設定 Open Typing settings 開啟輸入設定 Short date format 短日期格式 Time format (24h / 12h) 時間格式（24 / 12 小時） Sticky Keys 相黏鍵 Swap mouse buttons 對調滑鼠按鍵 Toggle Keys 切換鍵 Wheel scroll lines 滾輪捲動行數 Crash dump type 當機傾印類型 Disable boot animation 停用開機動畫 Disable Fast Startup 停用快速啟動 Disable HPET timer 停用 HPET 計時器 Disable SysMain (Superfetch) 停用 SysMain（Superfetch） Disable reserved storage 停用保留儲存空間 Hardware-accelerated GPU scheduling 硬件加速 GPU 排程 Hypervisor launch auto (bcdedit) 自動虛擬器啟動（bcdedit） Hypervisor launch off (bcdedit) 關閉虛擬器啟動（bcdedit） Disable memory compression 停用記憶體壓縮 Enable memory compression 啟用記憶體壓縮 Set network to Private 設網絡為私人 Disable NTFS last-access 停用 NTFS 最後存取 Activate High Performance plan 啟用高效能電源計劃 Processor scheduling 處理器排程 Rebuild performance counters 重建效能計數器 Rebuild search index 重建搜尋索引 Disable startup app delay 停用啟動程式延遲 GPU TDR delay GPU TDR 延遲 Disable USB selective suspend 停用 USB 選擇性暫停 Open About this PC 開啟關於此電腦 Open Activation settings 開啟啟用設定 Open Backup settings 開啟備份設定 Open Bluetooth & devices 開啟藍牙同裝置 Open Clipboard settings 開啟剪貼簿設定 Open Nearby sharing 開啟附近共用 Open Date & time 開啟日期同時間 Open For developers 開啟開發人員設定 Open Display settings 開啟顯示器設定 Open Multitasking settings 開啟多工處理設定 Open Night light settings 開啟夜燈設定 Open Optional features 開啟選用功能 Open Power & battery 開啟電源同電池 Open Language settings 開啟語言設定 Open Sound settings 開啟音效設定 Open Storage settings 開啟儲存空間設定 Open Taskbar settings 開啟工作列設定 Open Themes settings 開啟佈景主題設定 Open Windows Security 開啟 Windows 安全性 Open Windows Update 開啟 Windows Update Alt-Tab shows browser tabs Alt-Tab 顯示瀏覽器分頁 Joint resize snapped windows 同時調整貼齊視窗 Lock-screen notifications 鎖定畫面通知 Notification sound 通知聲音 All notifications 所有通知 Shut down OneDrive 關閉 OneDrive Open Focus settings 開啟專注設定 Open Multitasking settings 開啟多工處理設定 Open Notifications settings 開啟通知設定 Open Storage settings 開啟儲存空間設定 Recycle Bin retention 回收筒保留期 Show snap layout tips 顯示貼齊版面提示 Snap Assist 貼齊助手 Snap layout bar 貼齊版面工具列 Snap fill 貼齊自動填充 Snap layout flyout 貼齊版面飛出視窗 Show app suggestions in Snap 貼齊顯示應用程式建議 Storage Sense 儲存空間感知功能 Virtual desktops on all monitors 所有螢幕顯示虛擬桌面 Window arrangement (animations) 視窗排列動畫",
            "native": false
          }
        ],
        "subgroups": []
      }
    ]
  }
];

export const allModules: CatalogModule[] = [
  {
    "tag": "dashboard",
    "en": "Dashboard",
    "zh": "概覽",
    "glyph": "",
    "keywords": "home overview start 主頁 概覽",
    "native": false
  },
  {
    "tag": "module.reactor",
    "en": "Nuclear Reactor",
    "zh": "核反應堆",
    "glyph": "",
    "keywords": "nuclear reactor npp pwr pressurized water reactor simulation simulator meltdown scram control rod boron xenon doppler reactivity pcm point kinetics neutron flux fuel temperature coolant tavg thot tcold primary pressure pressurizer steam generator turbine generator condenser rcp pump feedwater eccs relief valve gauge mimic diagram trend chart annunciator alarm core damage explosion physics 核反應堆 核電廠 壓水堆 模擬 熔毀 緊急停堆 控制棒 硼 氙 反應性 中子 通量 燃料溫度 冷卻劑 壓力 穩壓器 蒸汽發生器 汽輪機 發電機 冷凝器 主泵 給水 應急冷卻 釋壓閥 儀表 流程圖 趨勢 警報 爐心 爆炸 物理",
    "native": false
  },
  {
    "tag": "module.reactorsettings",
    "en": "Reactor Settings",
    "zh": "反應堆設定",
    "glyph": "",
    "keywords": "reactor settings real world external windows linkage power plan accent brightness keep awake meltdown real shutdown arm status api autosave persistence home assistant mirror light switch plug entity scram alarm generating reversible opt-in 反應堆設定 真實 外部 系統連動 電源計劃 強調色 亮度 保持喚醒 熔毀 真實關機 啟用 狀態 API 自動儲存 連動 家居助理 燈 開關 插座 警報 發電",
    "native": false
  },
  {
    "tag": "module.cakefactory",
    "en": "Cake Factory & Farm",
    "zh": "蛋糕工廠與農場",
    "glyph": "",
    "keywords": "cake factory bakery farm simulator ingredients wheat flour sugar beet sugarcane eggs milk butter dairy vanilla cocoa leavening baking powder salt mixer depositor tunnel oven cooling icing packaging sanitation haccp food safety reactor nuclear power supply chain 蛋糕 工廠 農場 模擬 原料 小麥 麵粉 糖 雞蛋 牛奶 牛油 雲呢拿 可可 發粉 鹽 攪拌 焗爐 冷卻 裝飾 包裝 衛生 食物安全 反應堆 核能 供電",
    "native": false
  },
  {
    "tag": "module.griddispatch",
    "en": "Grid Dispatch Center",
    "zh": "電網調度中心",
    "glyph": "",
    "keywords": "grid dispatch electricity sell power reactor mwe spot price frequency load-follow nuclear 電網 調度 售電 電力 反應堆 頻率 電價 核能",
    "native": false
  },
  {
    "tag": "module.h2plant",
    "en": "Hydrogen Electrolysis",
    "zh": "氫電解制氫廠",
    "glyph": "",
    "keywords": "hydrogen electrolysis h2 plant reactor mwe power water splitting green fuel nuclear 氫 電解 制氫 反應堆 電力 綠氫 儲氫 核能",
    "native": false
  },
  {
    "tag": "module.aicluster",
    "en": "AI Training Cluster",
    "zh": "AI 訓練叢集",
    "glyph": "",
    "keywords": "ai training cluster gpu pflop compute machine learning model reactor nuclear power load megawatt heavy 人工智能 訓練 叢集 運算 深度學習 模型 核電 反應堆 供電 重負載",
    "native": false
  },
  {
    "tag": "module.hpc",
    "en": "Supercomputer (HPC)",
    "zh": "超級電腦（HPC）",
    "glyph": "",
    "keywords": "hpc supercomputer compute cluster nodes job queue pflops high performance computing reactor nuclear load heavy 超級電腦 高效能運算 運算叢集 節點 作業佇列 核電 反應堆 重負載",
    "native": false
  },
  {
    "tag": "module.computemine",
    "en": "Compute Mine",
    "zh": "運算礦場",
    "glyph": "",
    "keywords": "compute mine mining crypto hashrate rig power draw megawatt reactor nuclear load earnings efficiency 運算 礦場 挖礦 礦機 算力 加密貨幣 核電 核能 反應堆 耗電 重負載 收益",
    "native": false
  },
  {
    "tag": "module.smelter",
    "en": "Aluminium Smelter",
    "zh": "鋁冶煉廠",
    "glyph": "",
    "keywords": "aluminium aluminum smelter hall-heroult pot-line electrolysis reactor nuclear heavy load industrial molten freeze tonnes 鋁 冶煉 電解 電解槽 核電 重負載 熔融 凍結 產量",
    "native": false
  },
  {
    "tag": "module.datacenter",
    "en": "Nuclear Data Center",
    "zh": "核能資料中心",
    "glyph": "",
    "keywords": "data center datacenter hyperscale server rack cooling pue uptime sla requests reactor nuclear load heavy 核能 資料中心 數據中心 伺服器 機櫃 散熱 用電 負載 反應堆 核電 重負載",
    "native": false
  },
  {
    "tag": "module.collider",
    "en": "Particle Collider",
    "zh": "粒子對撞機",
    "glyph": "",
    "keywords": "particle collider accelerator beam energy tev magnet luminosity physics reactor nuclear heavy load megawatt 粒子 對撞機 加速器 束能 磁鐵 亮度 物理 核電 反應堆 重負載",
    "native": false
  },
  {
    "tag": "module.reactorbank",
    "en": "Reactor Bank",
    "zh": "反應堆銀行",
    "glyph": "",
    "keywords": "reactor bank wallet currency watts economy mint earn spend store perk unlock ledger nuclear power 反應堆 銀行 錢包 貨幣 瓦特幣 經濟 鑄幣 賺取 花費 商店 解鎖 賬簿 核電",
    "native": false
  },
  {
    "tag": "module.desal",
    "en": "Seawater Desalination",
    "zh": "海水淡化廠",
    "glyph": "",
    "keywords": "desalination seawater fresh water reverse osmosis reactor nuclear mwe power m3 海水 淡化 食水 反滲透 反應堆 核電 重負載 儲水",
    "native": false
  },
  {
    "tag": "module.evcharge",
    "en": "EV Fast-Charge Depot",
    "zh": "電動車快充站",
    "glyph": "",
    "keywords": "ev electric vehicle fast charge depot charger stall kw fleet soc reactor nuclear mwe power 電動車 充電 快充 車隊 反應堆 核電 重負載",
    "native": false
  },
  {
    "tag": "module.pumpedhydro",
    "en": "Pumped-Storage Hydro",
    "zh": "抽水蓄能",
    "glyph": "",
    "keywords": "pumped storage hydro reservoir energy grid buffer pump generate turbine reactor nuclear mwe surplus 抽水蓄能 水力 水塘 儲能 電網 反應堆 核電",
    "native": false
  },
  {
    "tag": "module.districtheat",
    "en": "District Heating",
    "zh": "區域供熱",
    "glyph": "",
    "keywords": "district heating cogeneration chp hot water city network homes thermal reactor nuclear waste heat 區域供熱 熱電聯產 供暖 熱網 反應堆 核電 廢熱",
    "native": false
  },
  {
    "tag": "module.dac",
    "en": "Carbon Capture (DAC)",
    "zh": "碳捕集",
    "glyph": "",
    "keywords": "direct air capture dac carbon dioxide co2 climate scrubber tonnes reactor nuclear energy credits 直接空氣捕集 碳捕集 二氧化碳 氣候 反應堆 核電 碳信用",
    "native": false
  },
  {
    "tag": "module.vertfarm",
    "en": "Vertical Farm",
    "zh": "垂直農場",
    "glyph": "",
    "keywords": "vertical farm grow lights led hydroponics indoor agriculture crops harvest reactor nuclear power 垂直農場 植物工廠 補光燈 水耕 室內 農業 農作物 收成 反應堆 核電",
    "native": false
  },
  {
    "tag": "module.steelmill",
    "en": "Arc-Furnace Steel Mill",
    "zh": "電弧爐煉鋼廠",
    "glyph": "",
    "keywords": "steel mill electric arc furnace eaf melt scrap heat tap tonnes reactor nuclear megawatt heavy load 鋼廠 電弧爐 煉鋼 廢鋼 熔煉 出鋼 反應堆 核電 重負載",
    "native": false
  },
  {
    "tag": "module.cementkiln",
    "en": "Electric Cement Kiln",
    "zh": "電熱水泥迴轉窯",
    "glyph": "",
    "keywords": "cement kiln rotary clinker limestone calcination electric heat concrete tonnes reactor nuclear co2 decarbonise 水泥 迴轉窯 熟料 石灰石 煅燒 電熱 混凝土 反應堆 核電 減碳",
    "native": false
  },
  {
    "tag": "module.peek",
    "en": "Peek",
    "zh": "快速預覽",
    "glyph": "",
    "keywords": "peek preview quick look quicklook file viewer image text code markdown pdf audio video archive metadata previewer prev next folder navigate hotkey 快速預覽 預覽 檔案 圖片 文字 程式碼 影片 音訊 壓縮檔 中繼資料 熱鍵 上一個 下一個",
    "native": true
  },
  {
    "tag": "module.newplus",
    "en": "New+",
    "zh": "範本新增",
    "glyph": "",
    "keywords": "new plus newplus powertoys template templates create file folder new menu shellnew context menu date variable substitution scaffold blank boilerplate 範本 新增 範本新增 建立 檔案 資料夾 新增選單 變數 日期 樣板 鷹架",
    "native": true
  },
  {
    "tag": "module.archives",
    "en": "Archives",
    "zh": "壓縮檔",
    "glyph": "",
    "keywords": "zip 7z rar tar gzip compress extract 解壓 壓縮",
    "native": true
  },
  {
    "tag": "module.bulkops",
    "en": "Bulk File Ops",
    "zh": "批次檔案操作",
    "glyph": "",
    "keywords": "bulk file move copy delete attributes 批次 檔案",
    "native": true
  },
  {
    "tag": "module.rename",
    "en": "Batch Rename",
    "zh": "批次改名",
    "glyph": "",
    "keywords": "rename bulk powerrename regex 改名 批次",
    "native": true
  },
  {
    "tag": "module.duplicates",
    "en": "Duplicate Finder",
    "zh": "重複檔案搜尋",
    "glyph": "",
    "keywords": "duplicate hash find dedupe 重複",
    "native": true
  },
  {
    "tag": "module.everything",
    "en": "Instant File Search",
    "zh": "即時檔案搜尋",
    "glyph": "",
    "keywords": "everything voidtools instant file search find filename ntfs mft master file table usn journal index locate substring wildcard regex fast search box open folder copy path 即時 檔案搜尋 搜尋 搵檔案 檔名 索引 萬用字元 正規表示式 主檔案表 開啟資料夾 複製路徑",
    "native": true
  },
  {
    "tag": "module.filelocksmith",
    "en": "File Locksmith",
    "zh": "檔案鎖偵測",
    "glyph": "",
    "keywords": "file locksmith locked file folder which process is locking handle open handle restart manager rstrtmgr in use cannot delete cannot move being used by another program end task unlock who is using whatslocking lockedfile powertoys 檔案鎖 鎖住 邊個程序 鎖定 控制代碼 佔用 刪唔到 移動唔到 解鎖 結束工作 開啟中",
    "native": true
  },
  {
    "tag": "module.diffmerge",
    "en": "Diff & Merge (WinMerge)",
    "zh": "比對與合併",
    "glyph": "",
    "keywords": "diff merge winmerge compare comparison file folder directory side by side three way two way text line word intra-line myers lcs hash content sha256 only left only right different identical changed added removed unchanged synchronized scroll ignore whitespace next previous difference copy left right save patch beyond compare meld kdiff 比對 合併 比較 差異 檔案 資料夾 並排 逐行 逐字 雜湊 內容 相同 不同 只在左邊 只在右邊 新增 刪除 改動 忽略空白 下一處 上一處 抄左 抄右 儲存",
    "native": true
  },
  {
    "tag": "module.hexeditor",
    "en": "Hex Editor",
    "zh": "十六進位編輯器",
    "glyph": "",
    "keywords": "hex editor hexeditor hxd binary editor byte bytes offset ascii hexadecimal view edit overwrite insert delete find search go to goto md5 sha1 sha-1 sha256 sha-256 hash checksum memory mapped large file dump raw 十六進位 二進位 編輯器 位元組 位移 雜湊 校驗 搜尋 跳到 覆寫 插入 刪除 記憶體對應 大檔",
    "native": true
  },
  {
    "tag": "module.disk",
    "en": "Disk Analyser",
    "zh": "磁碟分析",
    "glyph": "",
    "keywords": "disk space treemap analyse folder size 磁碟 空間",
    "native": true
  },
  {
    "tag": "module.drives",
    "en": "Drives",
    "zh": "磁碟機",
    "glyph": "",
    "keywords": "drive volume format bitlocker 磁碟機",
    "native": true
  },
  {
    "tag": "module.diskhealth",
    "en": "Disk Health (SMART)",
    "zh": "硬碟健康（SMART）",
    "glyph": "",
    "keywords": "disk health smart crystaldiskinfo hdd ssd nvme temperature power on hours wear reallocated sectors pending uncorrectable attribute firmware serial percentage used data units lifespan failure prediction caution good bad 硬碟 健康 溫度 通電時數 耗損 重新分配磁區 待處理 不可修正 屬性 韌體 序號 已使用壽命 故障預測 注意 良好 不良",
    "native": true
  },
  {
    "tag": "module.diskbench",
    "en": "Disk Benchmark",
    "zh": "硬碟速度測試",
    "glyph": "",
    "keywords": "disk benchmark crystaldiskmark cdm speed test read write sequential random seq1m rnd4k iops mbps queue depth ssd nvme hdd throughput latency direct io no buffering 硬碟 磁碟 速度測試 讀寫 循序 隨機 佇列 深度 跑分 效能 固態硬碟",
    "native": true
  },
  {
    "tag": "module.testdisk",
    "en": "TestDisk / PhotoRec Recovery",
    "zh": "TestDisk / PhotoRec 資料救援",
    "glyph": "",
    "keywords": "testdisk photorec recovery carve undelete partition recover data lost deleted 資料救援 救援 復原 還原 分割區 救回 刪除 檔案",
    "native": true
  },
  {
    "tag": "module.onedrive",
    "en": "OneDrive",
    "zh": "OneDrive",
    "glyph": "",
    "keywords": "onedrive files on demand pin dehydrate online only cloud free space storage sense sync 雲端 釘選 脫水 釋放空間 同步 隨選",
    "native": true
  },
  {
    "tag": "module.richpreview",
    "en": "Rich Preview",
    "zh": "豐富預覽",
    "glyph": "",
    "keywords": "rich preview preview pane peek file explorer add-ons handlers svg markdown md pdf source code json xml yaml toml gcode g-code 3d print qoi image thumbnail metadata render viewer webview2 monaco powertoys file preview drop open prev next 預覽 預覽窗格 檔案 渲染 縮圖 圖片 原始碼 開發 拖放",
    "native": true
  },
  {
    "tag": "module.filebrowser",
    "en": "File Browser",
    "zh": "檔案瀏覽器",
    "glyph": "",
    "keywords": "file browser explorer folder directory drive navigate open rename copy move cut paste delete recycle bin new folder hidden read-only attributes size modified date preview text breadcrumbs path this pc my computer 檔案 瀏覽器 資料夾 磁碟 導覽 開啟 改名 複製 移動 刪除 回收筒 隱藏 預覽 路徑",
    "native": false
  },
  {
    "tag": "module.doctors",
    "en": "System Doctors",
    "zh": "系統醫生",
    "glyph": "",
    "keywords": "doctor repair fix rescue printer spooler dns network sleep wake taskbar start search index explorer icon thumbnail cache ownership permissions 修復 醫生 救援 列印 網絡 睡眠 喚醒 工作列 搜尋 圖示 縮圖 擁有權 權限",
    "native": true
  },
  {
    "tag": "module.services",
    "en": "Services",
    "zh": "服務",
    "glyph": "",
    "keywords": "services start stop startup type 服務",
    "native": true
  },
  {
    "tag": "module.tasks",
    "en": "Scheduled Tasks",
    "zh": "排程工作",
    "glyph": "",
    "keywords": "scheduled task scheduler run 排程",
    "native": true
  },
  {
    "tag": "module.devices",
    "en": "Devices",
    "zh": "裝置",
    "glyph": "",
    "keywords": "device manager hardware driver 裝置 驅動",
    "native": true
  },
  {
    "tag": "module.vivetool",
    "en": "ViVeTool",
    "zh": "功能旗標",
    "glyph": "",
    "keywords": "vivetool vive feature flag experiment hidden file explorer tabs new start menu modern context menu snap layouts energy saver click to do 功能 旗標 實驗 隱藏 分頁 開始功能表",
    "native": true
  },
  {
    "tag": "module.regedit",
    "en": "Registry Editor",
    "zh": "登錄編輯器",
    "glyph": "",
    "keywords": "registry regedit hive key value 登錄檔",
    "native": true
  },
  {
    "tag": "module.startup",
    "en": "Startup Apps",
    "zh": "開機程式",
    "glyph": "",
    "keywords": "startup autostart logon run 開機 自啟動",
    "native": true
  },
  {
    "tag": "module.events",
    "en": "Event Viewer",
    "zh": "事件檢視器",
    "glyph": "",
    "keywords": "event log viewer system application 事件 記錄",
    "native": true
  },
  {
    "tag": "module.monitor",
    "en": "System Monitor",
    "zh": "系統監察",
    "glyph": "",
    "keywords": "cpu ram memory network task manager priority affinity btop btop4win resource monitor per-core swap sparkline efficiency 監察 工作管理員 資源監控 每核心",
    "native": true
  },
  {
    "tag": "module.procexp",
    "en": "Process Explorer",
    "zh": "程序總管",
    "glyph": "",
    "keywords": "process explorer system informer procexp task manager process tree parent child pid parent process id command line working set private bytes threads owner user description fileversioninfo end process kill end tree set priority open file location copy pid path details modules start time wmi win32_process cpu percent search filter 程序 程序樹 程序總管 工作管理員 父程序 子程序 命令列 工作集 私用位元組 執行緒 擁有者 描述 結束程序 結束程序樹 優先權 開啟檔案位置 複製 詳細 模組 啟動時間",
    "native": true
  },
  {
    "tag": "module.winfetch",
    "en": "System Info (Winfetch)",
    "zh": "系統資訊",
    "glyph": "",
    "keywords": "winfetch neofetch fetch system info os host kernel uptime packages shell resolution gpu cpu memory disk ascii logo specs about machine 系統資訊 規格 開機時間 解像度 記憶體 磁碟 顯示卡 標誌",
    "native": true
  },
  {
    "tag": "module.battery",
    "en": "Battery & Thermal",
    "zh": "電池與散熱",
    "glyph": "",
    "keywords": "battery thermal temperature wear health cpu gpu fan powercfg batteryreport energy 電池 溫度 散熱 風扇 耗損 健康",
    "native": true
  },
  {
    "tag": "module.connections",
    "en": "Connections",
    "zh": "連線",
    "glyph": "",
    "keywords": "tcp udp connections netstat tcpview port 連線",
    "native": true
  },
  {
    "tag": "module.wireshark",
    "en": "Packet Capture",
    "zh": "封包擷取",
    "glyph": "",
    "keywords": "wireshark packet capture tshark dumpcap pcap pcapng sniff npcap interface bpf capture filter display filter protocol tcp udp http dns follow stream conversation endpoint statistics 封包 擷取 抓包 嗅探 過濾 協定 統計",
    "native": true
  },
  {
    "tag": "module.nmap",
    "en": "Nmap Scanner",
    "zh": "網絡掃描",
    "glyph": "",
    "keywords": "nmap port scan network security host service os version cidr subnet npcap zenmap nse script ping sweep 掃描 端口 連接埠 網絡 安全 主機 服務 作業系統 子網",
    "native": true
  },
  {
    "tag": "module.native",
    "en": "Native Utilities",
    "zh": "原生工具",
    "glyph": "",
    "keywords": "wifi password saved nearby scan smb shares sessions brightness ddc certificate users logoff disconnect gpu disk counters process modules bluetooth pinvoke wlan 原生 密碼 共享 亮度 憑證 藍牙 模組",
    "native": true
  },
  {
    "tag": "module.envvars",
    "en": "Environment Variables",
    "zh": "環境變數",
    "glyph": "",
    "keywords": "environment variables path user system env 環境變數",
    "native": true
  },
  {
    "tag": "module.clipboard",
    "en": "Clipboard",
    "zh": "剪貼簿",
    "glyph": "",
    "keywords": "clipboard history text image file convert win+v qr qrcode qr code plain text paste 剪貼簿 歷史 二維碼 純文字",
    "native": true
  },
  {
    "tag": "module.settingshub",
    "en": "Settings & Control Panel",
    "zh": "設定與控制台",
    "glyph": "",
    "keywords": "settings control panel ms-settings applet cpl launcher open page 設定 控制台 啟動器 面板",
    "native": true
  },
  {
    "tag": "module.media",
    "en": "Media",
    "zh": "媒體",
    "glyph": "",
    "keywords": "ffmpeg video audio convert trim gif 影片 音訊 轉檔",
    "native": true
  },
  {
    "tag": "module.audioeditor",
    "en": "Audio Editor",
    "zh": "音訊編輯器",
    "glyph": "",
    "keywords": "audio editor audacity waveform record mic microphone play playback trim fade normalize gain volume speed tempo pitch shift noise reduction denoise reverb echo compressor eq equalizer mix concat export wav mp3 flac 音訊 編輯 波形 錄音 播放 剪裁 淡入 淡出 正規化 增益 變速 變調 降噪 混音 匯出",
    "native": true
  },
  {
    "tag": "module.audiotagger",
    "en": "Audio Tagger",
    "zh": "音訊標籤編輯器",
    "glyph": "",
    "keywords": "audio tagger tags tagging mp3tag id3 id3v2 metadata tag editor taglib taglibsharp title artist album album artist track number year genre comment composer disc cover art album art picture batch edit multi select rename from tags tag from filename pattern mp3 flac m4a ogg opus wav aac wma aiff bitrate sample rate duration 音訊 標籤 標籤編輯 中繼資料 標題 演出者 專輯 專輯演出者 曲目 年份 類型 備註 作曲 封面 封面圖 批次 改名 檔名 樣式 位元率 取樣率 時長",
    "native": true
  },
  {
    "tag": "module.mediaplayer",
    "en": "Media Player",
    "zh": "媒體播放器",
    "glyph": "",
    "keywords": "vlc libvlc media player play video audio movie music stream url playlist subtitle audio track snapshot fullscreen seek volume transcode convert mp4 mp3 webm wav 播放器 媒體 影片 音樂 串流 播放清單 字幕 截圖 全螢幕 轉檔",
    "native": true
  },
  {
    "tag": "module.ytdlp",
    "en": "Media Downloader",
    "zh": "媒體下載器",
    "glyph": "",
    "keywords": "yt-dlp ytdlp youtube download downloader video audio mp3 m4a playlist subtitles subs format quality 1080p 720p thumbnail metadata sponsorblock cookies twitch vimeo soundcloud bilibili 下載 影片 音訊 字幕 播放清單 畫質 縮圖",
    "native": true
  },
  {
    "tag": "module.blender",
    "en": "Blender (3D / Render)",
    "zh": "Blender（3D／算圖）",
    "glyph": "",
    "keywords": "blender 3d render rendering cycles eevee headless animation frame gltf fbx obj python script batch queue cpu gpu samples output mcp blender-mcp model context protocol codex claude opencode agents skills multi agent 算圖 渲染 動畫 影格 匯出 批次 佇列 agent skill",
    "native": true
  },
  {
    "tag": "module.libreoffice",
    "en": "Document Converter",
    "zh": "文件轉換器",
    "glyph": "",
    "keywords": "libreoffice soffice document converter convert batch pdf docx xlsx odt ods pptx csv txt office writer calc impress headless 文件 轉換 轉檔 批次 辦公",
    "native": true
  },
  {
    "tag": "module.pdftoolkit",
    "en": "PDF Toolkit",
    "zh": "PDF 工具箱",
    "glyph": "",
    "keywords": "pdf toolkit stirling stirling-pdf merge combine split rotate delete extract reorder pages watermark encrypt decrypt password protect unlock text extraction txt images to pdf png jpg pdfsharp pdfpig managed 工具箱 合併 分割 旋轉 刪頁 抽頁 重排 浮水印 加密 解密 密碼 解鎖 抽取文字 圖片轉 PDF",
    "native": true
  },
  {
    "tag": "module.recorder",
    "en": "Screen Recorder",
    "zh": "螢幕錄影",
    "glyph": "",
    "keywords": "record screen capture gdigrab 錄影",
    "native": true
  },
  {
    "tag": "module.capture",
    "en": "Capture Studio",
    "zh": "擷取工作室",
    "glyph": "",
    "keywords": "capture snip screenshot region gif ocr text recognize clipboard 截圖 擷取 區域 文字辨識 認字",
    "native": true
  },
  {
    "tag": "module.textocr",
    "en": "Text Extractor (OCR)",
    "zh": "原生文字辨識",
    "glyph": "",
    "keywords": "ocr text extractor textextractor normcap recognize recognise screen region image file picture png jpg bmp windows ocr engine windows.media.ocr language chinese traditional zh-hant copy clipboard read text from screen optical character recognition 文字辨識 認字 螢幕 區域 圖片 圖檔 語言 繁體中文 複製 剪貼簿 光學文字辨識 抽字",
    "native": true
  },
  {
    "tag": "module.cropandlock",
    "en": "Crop And Lock",
    "zh": "裁切與鎖定",
    "glyph": "",
    "keywords": "crop and lock croplock cropandlock window crop thumbnail reparent always on top topmost dwm thumbnail live mirror region pin floating powertoys windowcrop 裁切 鎖定 視窗 縮圖 置頂 浮窗 即時 鏡像 範圍 釘選",
    "native": true
  },
  {
    "tag": "module.giflab",
    "en": "GIF Studio",
    "zh": "螢幕轉 GIF",
    "glyph": "",
    "keywords": "gif studio screentogif screen to gif record region window fullscreen frames frame editor delete reorder crop export mp4 apng palette animation 螢幕轉 動畫 畫面格 刪格 調次序 裁切 匯出 錄影 區域 視窗 全螢幕",
    "native": true
  },
  {
    "tag": "module.zoomit",
    "en": "ZoomIt",
    "zh": "螢幕放大與標註",
    "glyph": "",
    "keywords": "zoomit zoom magnify magnifier screen presentation annotate annotation draw pen freehand arrow rectangle highlighter marker break timer countdown sysinternals hotkey ctrl 1 2 3 colour color red green blue orange yellow thickness pan wheel esc 放大 放大鏡 標註 註解 畫筆 手畫 箭咀 矩形 螢光筆 小休 倒數 計時 簡報 演示 熱鍵 顏色 平移 滾輪",
    "native": true
  },
  {
    "tag": "module.mixer",
    "en": "Volume Mixer",
    "zh": "音量混合器",
    "glyph": "",
    "keywords": "volume mixer audio per-app mute 音量 靜音",
    "native": true
  },
  {
    "tag": "module.colorpicker",
    "en": "Color Picker",
    "zh": "螢幕取色",
    "glyph": "",
    "keywords": "color picker hex rgb hsl eyedropper 取色 顏色",
    "native": true
  },
  {
    "tag": "module.screenruler",
    "en": "Screen Ruler",
    "zh": "螢幕間尺",
    "glyph": "",
    "keywords": "screen ruler measure tool measurement powertoys distance horizontal vertical cross crosshair bounds pixel px coordinate angle line color thickness overlay clipboard 間尺 度尺 量度 量尺 螢幕度尺 像素 距離 水平 垂直 十字 邊界 座標 角度 覆蓋層",
    "native": true
  },
  {
    "tag": "module.pixeleditor",
    "en": "Pixel Editor",
    "zh": "像素畫編輯器",
    "glyph": "",
    "keywords": "pixel editor aseprite sprite pixel art draw paint canvas palette layers frames animation gif png pencil eraser fill bucket eyedropper undo redo 像素 像素畫 精靈 繪圖 畫布 調色盤 圖層 影格 動畫 鉛筆 橡皮 填色 吸色",
    "native": true
  },
  {
    "tag": "module.imageeditor",
    "en": "Image Editor",
    "zh": "點陣圖影像編輯器",
    "glyph": "",
    "keywords": "image editor photo editor raster paint.net gimp photoshop alternative imagesharp png jpg jpeg bmp gif webp open save export quality canvas zoom pan brightness contrast saturation hue gamma adjust grayscale invert sepia gaussian blur sharpen edge detect filter crop resize rotate flip aspect brush pencil fill bucket eraser eyedropper text tool layers opacity show hide undo redo 影像 影像編輯 相片 點陣圖 編輯器 開啟 儲存 匯出 品質 畫布 縮放 平移 亮度 對比 飽和度 色相 伽瑪 灰階 反相 棕褐 高斯模糊 銳化 邊緣偵測 濾鏡 裁切 旋轉 翻轉 長寬比 筆刷 鉛筆 填色 橡皮 吸色 文字 圖層 不透明度 顯示 隱藏 復原 重做",
    "native": true
  },
  {
    "tag": "module.timeunit",
    "en": "Time & Unit Tools",
    "zh": "時間與單位工具",
    "glyph": "",
    "keywords": "time zone timezone world clock converter convert unit length mass temperature 時間 時區 世界時鐘 換算 單位",
    "native": true
  },
  {
    "tag": "module.timelens",
    "en": "Activity Timeline",
    "zh": "活動時間軸",
    "glyph": "",
    "keywords": "timelens activity timeline time tracking tracker foreground window app usage productivity insights idle per-app totals stacked bar export csv 活動 時間軸 時間追蹤 前景 視窗 應用程式 使用量 生產力 閒置 匯出",
    "native": true
  },
  {
    "tag": "module.hosts",
    "en": "Hosts Editor",
    "zh": "hosts 編輯器",
    "glyph": "",
    "keywords": "hosts block domain dns 封鎖",
    "native": true
  },
  {
    "tag": "module.mouse",
    "en": "Mouse & Pointer",
    "zh": "滑鼠與指標",
    "glyph": "",
    "keywords": "mouse pointer acceleration speed 滑鼠 指標",
    "native": true
  },
  {
    "tag": "module.mouseutils",
    "en": "Mouse Utilities",
    "zh": "滑鼠工具",
    "glyph": "",
    "keywords": "mouse utilities utils powertoys find my mouse findmymouse spotlight sonar double ctrl shake highlighter highlight click circle crosshairs crosshair lines pointer jump teleport screenshot overlay hook cursor locate ring 滑鼠 工具 搵滑鼠 聚光燈 標示 點擊 十字線 指標 跳轉 傳送 截圖 覆蓋層 游標 光圈",
    "native": true
  },
  {
    "tag": "module.mwb",
    "en": "Mouse Without Borders",
    "zh": "無界滑鼠",
    "glyph": "",
    "keywords": "mouse without borders mwb kvm share keyboard mouse multiple pc computers lan network control switch machine clipboard sync pair pairing security key tcp aes encrypt edge transition layout synergy barrier software kvm 無界滑鼠 鍵鼠共享 共享 鍵盤 滑鼠 多部電腦 區域網 配對 安全密鑰 剪貼簿 同步 邊界 控制權 版面",
    "native": true
  },
  {
    "tag": "module.keyboard",
    "en": "Keyboard Remapper",
    "zh": "鍵盤重新對應",
    "glyph": "",
    "keywords": "keyboard remap key sharpkeys 鍵盤",
    "native": true
  },
  {
    "tag": "module.hotkeys",
    "en": "Hotkey & Macro Runner",
    "zh": "熱鍵與巨集",
    "glyph": "",
    "keywords": "hotkey macro shortcut chord registerhotkey send keys autohotkey text expander snippet trigger expand abbreviation 熱鍵 巨集 快捷鍵 文字展開 片語 縮寫",
    "native": true
  },
  {
    "tag": "module.quickaccent",
    "en": "Quick Accent",
    "zh": "快速重音符",
    "glyph": "",
    "keywords": "quick accent accents diacritic diacritics mark marks acute grave circumflex tilde umlaut macron breve caron cedilla ring special symbols currency ipa pinyin powertoys keyboard hook hold letter activation key space arrow popup variants insert sendinput unicode language french german spanish portuguese vietnamese 快速 重音 重音符 變音 標記 發音符號 特殊符號 貨幣 拼音 音標 鍵盤 鈎 候選 語言 法文 德文 西班牙文 葡萄牙文 越南文",
    "native": true
  },
  {
    "tag": "module.shortcutguide",
    "en": "Shortcut Guide",
    "zh": "快捷鍵指南",
    "glyph": "",
    "keywords": "shortcut guide powertoys windows key win hold overlay cheat sheet keyboard shortcuts reference table win+e win+d win+l win+tab snap emoji clipboard snip search hotkey list winkey 快捷鍵 指南 揿住 視窗鍵 覆蓋層 鍵盤 速查表 參考 貼齊 表情符號 剪貼簿",
    "native": true
  },
  {
    "tag": "module.cmdpalette",
    "en": "Command Palette",
    "zh": "指令面板",
    "glyph": "",
    "keywords": "command palette powertoys run launcher quick launch alt space search box global hotkey app launcher calculator run command open url system action lock sleep shutdown restart web search fuzzy spotlight wox flow 指令面板 快速啟動 啟動器 搜尋框 全域熱鍵 計算機 執行 開網址 系統動作 鎖定 睡眠 關機 重啟 網絡搜尋 模糊搜尋",
    "native": true
  },
  {
    "tag": "module.contextmenu",
    "en": "Context Menu",
    "zh": "右鍵選單",
    "glyph": "",
    "keywords": "context menu right click verb 右鍵 選單",
    "native": true
  },
  {
    "tag": "module.shellmenu",
    "en": "Explorer Right-Click",
    "zh": "檔案總管右鍵選單",
    "glyph": "",
    "keywords": "shell context menu explorer right click integration powertoys native verb hkcu hash ocr resize image file locksmith copy as path disk usage open here show more options",
    "native": true
  },
  {
    "tag": "module.taskbar-tweaker",
    "en": "Taskbar Tweaker",
    "zh": "工作列調校",
    "glyph": "",
    "keywords": "taskbar tweaker 7+ taskbar tweaker windhawk align combine buttons small icons tray system tray multi monitor seconds clock search task view widgets copilot end task start menu explorer 工作列 調校 對齊 合併 系統匣 多螢幕 秒 時鐘 搜尋 開始功能表 結束工作",
    "native": true
  },
  {
    "tag": "module.lightswitch",
    "en": "LightSwitch (Auto Dark Mode)",
    "zh": "自動深淺色",
    "glyph": "",
    "keywords": "lightswitch light switch auto dark mode autotheme darkmode automatic theme schedule sunrise sunset day night fixed time apps system personalize appsuselighttheme systemuseslighttheme latitude longitude location ip geolocation background scheduled task switch now powertoys 自動 深淺色 深色模式 淺色模式 主題 切換 排程 日出 日落 日夜 固定時間 緯度 經度 位置 背景 排程工作",
    "native": true
  },
  {
    "tag": "module.nilesoftshell",
    "en": "Nilesoft Shell",
    "zh": "Nilesoft 右鍵選單",
    "glyph": "",
    "keywords": "nilesoft shell context menu nss shell.nss register unregister reload theme modern dark snippet template explorer customize right click 右鍵 選單 主題 註冊 設定 範本 片語 客製化",
    "native": true
  },
  {
    "tag": "module.windows",
    "en": "Window Manager",
    "zh": "視窗管理",
    "glyph": "",
    "keywords": "window tile cascade always on top 視窗",
    "native": true
  },
  {
    "tag": "module.workspaces",
    "en": "Workspaces",
    "zh": "工作區",
    "glyph": "",
    "keywords": "workspaces workspace powertoys app layout desktop layout capture snapshot restore relaunch launch window position size monitor maximized minimized set of apps project save named scene session arrange reopen 工作區 應用程式佈局 桌面佈局 擷取 快照 還原 重新啟動 啟動 視窗位置 大細 螢幕 場景 工作階段 一組應用程式 儲存 重開",
    "native": true
  },
  {
    "tag": "module.altsnap",
    "en": "AltSnap",
    "zh": "Alt 拖曳視窗",
    "glyph": "",
    "keywords": "altsnap alt drag move resize window modifier key altdrag snap aero hook ramonunch alt 拖曳 移動 縮放 修飾鍵 貼齊 視窗",
    "native": true
  },
  {
    "tag": "module.fancyzones",
    "en": "FancyZones",
    "zh": "視窗分區",
    "glyph": "",
    "keywords": "fancyzones fancy zones powertoys window tiling zone editor layout grid columns rows priority snap hotkey shift drag win ctrl arrow tile 分區 排版 貼齊 版面 格網 編輯器 熱鍵",
    "native": true
  },
  {
    "tag": "module.komorebi",
    "en": "Komorebi (Tiling WM)",
    "zh": "Komorebi 平鋪視窗管理",
    "glyph": "",
    "keywords": "komorebi komorebic tiling window manager tile bsp columns rows stack grid monocle float workspace monitor layout daemon wm whkd gaps padding 平鋪 視窗管理 排版 工作區 守護程序 間距",
    "native": true
  },
  {
    "tag": "module.glazewm",
    "en": "GlazeWM Tiling",
    "zh": "GlazeWM 平鋪視窗",
    "glyph": "",
    "keywords": "glazewm glaze tiling window manager tile workspace keybinding gaps config yaml komorebi reload daemon 平鋪 視窗 管理 工作區 鍵盤 綁定 邊距 設定",
    "native": true
  },
  {
    "tag": "module.fonts",
    "en": "Font Manager",
    "zh": "字型管理",
    "glyph": "",
    "keywords": "font fonts install preview uninstall ttf otf typeface typography 字型 字款 安裝 預覽 移除",
    "native": true
  },
  {
    "tag": "module.awake",
    "en": "Awake",
    "zh": "保持喚醒",
    "glyph": "",
    "keywords": "awake keep awake no sleep caffeine 唔瞓 喚醒",
    "native": true
  },
  {
    "tag": "module.advancedpaste",
    "en": "Advanced Paste",
    "zh": "進階貼上",
    "glyph": "",
    "keywords": "advanced paste transform smart paste plain text markdown json uppercase lowercase title case base64 url encode html ocr image to text csv transpose sort unique lines ai win+shift+v 進階 貼上 轉換 純文字 大小寫 編碼 解碼 排序 去重複 圖片轉文字",
    "native": true
  },
  {
    "tag": "module.powertoys",
    "en": "PowerToys Extras",
    "zh": "PowerToys 額外工具",
    "glyph": "",
    "keywords": "powertoys image resizer ocr text extractor always on top topmost paste plain text 圖片縮放 文字擷取 置頂 純文字",
    "native": true
  },
  {
    "tag": "module.windhawk",
    "en": "Windhawk Mods",
    "zh": "Windhawk 模組",
    "glyph": "",
    "keywords": "windhawk mod mods customize taskbar height icon size clock start menu styler explorer rounded corners classic taskbar aero tray injection ramensoftware 模組 自訂 工作列 時鐘 開始功能表 圓角 注入",
    "native": true
  },
  {
    "tag": "module.voice",
    "en": "Voice & Read-Aloud",
    "zh": "語音朗讀",
    "glyph": "",
    "keywords": "voice tts text to speech read aloud speak narrator wav export sapi 語音 朗讀 文字轉語音 讀出",
    "native": true
  },
  {
    "tag": "module.announcements",
    "en": "PA Announcements",
    "zh": "喇叭語音廣播",
    "glyph": "",
    "keywords": "announce announcements pa public address speaker tannoy intercom broadcast loudspeaker chime tone ding dong tts speak voice queue urgent priority alarm alert reactor evacuate countdown attention all personnel sapi 廣播 喇叭 公共廣播 語音廣播 對講 警報 警示 叮咚 排隊 緊急 優先 反應堆 撤離 倒數 注意",
    "native": true
  },
  {
    "tag": "module.rainmeter",
    "en": "Rainmeter Widgets",
    "zh": "Rainmeter 桌面小工具",
    "glyph": "",
    "keywords": "rainmeter skin skins widget widgets desktop gadget bang activate deactivate toggle refresh hide show rmskin skininstaller layout illustro clock cpu monitor personalization 桌面 小工具 皮膚 桌面美化 個人化 時鐘 監察",
    "native": true
  },
  {
    "tag": "module.packages",
    "en": "Package Manager",
    "zh": "套件管理",
    "glyph": "",
    "keywords": "winget package install uninstall upgrade update scoop choco chocolatey pip python npm node dotnet tool powershell gallery psgallery pwsh pwsh7 psresource cargo rust bun javascript vcpkg dependencies unigetui discover bundle export import batch select selected multi 套件 安裝 更新 解除安裝 相依 清單 批次 多選 匯出 匯入",
    "native": true
  },
  {
    "tag": "module.ossapps",
    "en": "Native OSS Clones",
    "zh": "開源原生分頁",
    "glyph": "",
    "keywords": "open source native clones foss oss apps in-app csharp c# tab remade reimplementation api client diff merge diagram decompiler sqlite feed reader flashcards pdf audio tagger image editor ocr keepass torrent docker process explorer disk health benchmark everything search 開源 原生 分頁 複製 重製 內建 app內 C# 工具",
    "native": true
  },
  {
    "tag": "module.adb",
    "en": "Android (ADB)",
    "zh": "Android（ADB）",
    "glyph": "",
    "keywords": "android adb apk logcat shell screenshot reboot fastboot scrcpy push pull file backup mirror 手機 安卓 鏡像 備份",
    "native": true
  },
  {
    "tag": "module.fastboot",
    "en": "Fastboot / Flasher",
    "zh": "Fastboot／刷機",
    "glyph": "",
    "keywords": "fastboot flash flasher bootloader unlock boot.img factory image sideload ota pixelflasher 刷機 解鎖",
    "native": true
  },
  {
    "tag": "module.emulator",
    "en": "Android Emulator & SDK",
    "zh": "Android 模擬器與 SDK",
    "glyph": "",
    "keywords": "android emulator avd avdmanager sdkmanager virtual device launch wipe cold boot sdk sdkmanager packages platform-tools build-tools ndk license channel system image install uninstall update 套件 平台 授權 模擬器 虛擬裝置 安裝 更新 移除",
    "native": true
  },
  {
    "tag": "module.vpn",
    "en": "VPN & Mesh",
    "zh": "VPN 與網狀網",
    "glyph": "",
    "keywords": "vpn nordvpn tailscale mesh connect exit node ping 連線 網狀網",
    "native": true
  },
  {
    "tag": "module.qbittorrent",
    "en": "qBittorrent",
    "zh": "種子下載",
    "glyph": "",
    "keywords": "qbittorrent torrent torrents magnet bittorrent download seed leech tracker peer category tag webui web api speed limit 種子 磁力 下載 做種 追蹤器 分類 標籤 速度限制",
    "native": true
  },
  {
    "tag": "module.torrent",
    "en": "Native Torrent",
    "zh": "原生種子下載",
    "glyph": "",
    "keywords": "native torrent bittorrent monotorrent magnet link dht pex local peer discovery udp http tracker in-process managed pure c# download seed leech file priority sequential recheck ratio eta peers seeds pieces fast resume session restore downloads 原生 種子 磁力 下載 做種 追蹤器 對等 內建 受控 引擎 檔案優先 順序 重新檢查 比率 片段 還原",
    "native": true
  },
  {
    "tag": "module.dockerssh",
    "en": "Docker over SSH",
    "zh": "透過 SSH 控制 Docker",
    "glyph": "",
    "keywords": "docker ssh remote container containers power start stop restart pause unpause remove rm logs exec ps image daemon host remotedocker dockerssh containers-ssh ssh.net portainer compose 容器 遠端 控制 啟動 停止 重啟 暫停 移除 日誌 執行 鏡像 主機 遙距 碼頭",
    "native": true
  },
  {
    "tag": "module.docker",
    "en": "Docker",
    "zh": "Docker 容器管理",
    "glyph": "",
    "keywords": "docker container containers image images volume volumes network networks compose docker-compose stack engine daemon npipe pipe rest api portainer pull run start stop restart pause unpause remove logs exec stats inspect prune dangling registry nginx bridge 容器 映像 磁碟區 網路 堆疊 引擎 守護程序 拉取 啟動 停止 重啟 暫停 移除 日誌 執行 統計 清理",
    "native": true
  },
  {
    "tag": "module.diagram",
    "en": "Diagram Editor",
    "zh": "圖表編輯器",
    "glyph": "",
    "keywords": "diagram drawio draw.io diagrams.net flowchart flow chart shapes shape rectangle rounded ellipse circle diamond text node connector arrow edge link canvas whiteboard mind map mindmap org chart graph vector editor zoom snap grid duplicate z-order bring front send back png export json save load 圖表 流程圖 圖 形狀 矩形 圓角 橢圓 菱形 文字 節點 連線 箭咀 畫布 白板 心智圖 組織圖 向量 縮放 貼齊 格線 複製 層次 匯出 儲存",
    "native": true
  },
  {
    "tag": "module.flashcards",
    "en": "Flashcards",
    "zh": "間隔重複記憶卡",
    "glyph": "",
    "keywords": "flashcards flash cards anki srs spaced repetition study deck decks card front back review grade again hard good easy sm-2 sm2 ease interval due new mature memorize memorise learn quiz vocabulary csv import export 記憶卡 閃卡 間隔重複 學習 牌組 卡片 正面 背面 複習 評分 到期 成熟 背誦 記憶 默書 詞彙 匯入 匯出",
    "native": true
  },
  {
    "tag": "module.rustdesk",
    "en": "RustDesk",
    "zh": "遠端桌面",
    "glyph": "",
    "keywords": "rustdesk remote desktop remote control id password peer connect relay server self-hosted unattended access teamviewer anydesk alternative 遠端桌面 遙距桌面 遠程桌面 遠端控制 遙距控制",
    "native": true
  },
  {
    "tag": "module.homeassistant",
    "en": "Home Assistant",
    "zh": "家居助理",
    "glyph": "",
    "keywords": "home assistant ha smart home rest api template scene script light climate thermostat camera notify intent calendar 智能家居 家居助理",
    "native": true
  },
  {
    "tag": "module.comms",
    "en": "Communications",
    "zh": "通訊",
    "glyph": "",
    "keywords": "communications mail email outlook mailto draft attach teams meeting call discord telegram slack phone link tel sms deep link 通訊 信件 電郵 草稿 會議 電話",
    "native": true
  },
  {
    "tag": "module.mail",
    "en": "Mail",
    "zh": "電郵",
    "glyph": "",
    "keywords": "mail email imap smtp thunderbird inbox compose reply forward attachment oauth gmail outlook icloud yahoo account folder message read send 電郵 郵件 收件匣 撰寫 回覆 轉寄 附件 帳戶 資料夾 訊息",
    "native": true
  },
  {
    "tag": "module.wslvm",
    "en": "WSL & VM Launcher",
    "zh": "WSL 與 VM 啟動器",
    "glyph": "",
    "keywords": "wsl linux distro ubuntu debian windows sandbox wsb virtual machine vm hyper-v export import 子系統 沙盒 虛擬機",
    "native": true
  },
  {
    "tag": "module.virtualbox",
    "en": "VirtualBox Manager",
    "zh": "VirtualBox 管理",
    "glyph": "",
    "keywords": "virtualbox vbox vboxmanage vm virtual machine snapshot clone ova headless oracle 虛擬機 虛擬機器 快照 複製 匯入 匯出",
    "native": true
  },
  {
    "tag": "module.proxmox",
    "en": "Proxmox VE",
    "zh": "Proxmox VE 虛擬化",
    "glyph": "",
    "keywords": "proxmox pve vmhost hypervisor virtualization rest api token ticket node nodes cluster qemu kvm lxc container vm virtual machine guest start stop shutdown reboot suspend resume power on off status running stopped self-signed certificate trust datacenter homelab 虛擬化 虛擬機 容器 節點 叢集 電源 啟動 關機 停止 重新開機 暫停 繼續 自簽憑證 權杖 同主機",
    "native": true
  },
  {
    "tag": "module.terminal",
    "en": "Windows Terminal",
    "zh": "Windows 終端機",
    "glyph": "",
    "keywords": "windows terminal wt settings.json profiles profile editor conpty pseudo console embedded shell pwsh powershell cmd wsl color scheme font default duplicate launch new tab pane 終端機 設定檔 內嵌 偽終端機 殼層 預設 複製 啟動 分頁 窗格 色彩配置 字型",
    "native": true
  },
  {
    "tag": "module.uninstall",
    "en": "App Uninstaller",
    "zh": "應用程式解除安裝",
    "glyph": "",
    "keywords": "uninstall remove app program winget 解除安裝",
    "native": true
  },
  {
    "tag": "module.imaging",
    "en": "Imaging & Game Tools",
    "zh": "燒錄與遊戲工具",
    "glyph": "",
    "keywords": "raspberry pi imager sd card flash image write boot ssh wifi minecraft world downloader proxy jar rufus usb bootable iso flash drive uefi mbr verify windows linux installer 開機 USB 手指 啟動碟 樹莓派 燒錄 映像 我的世界 下載",
    "native": true
  },
  {
    "tag": "module.amulet",
    "en": "Minecraft World Editor (Amulet)",
    "zh": "Minecraft 世界編輯器（Amulet）",
    "glyph": "",
    "keywords": "amulet minecraft world editor map editor java bedrock level dat nbt python wxpython launch backup saves chunk dimension 世界 編輯器 我的世界 地圖 備份 存檔 維度",
    "native": true
  },
  {
    "tag": "module.minecraftworldtools",
    "en": "Minecraft World Tools",
    "zh": "Minecraft 世界工具",
    "glyph": "",
    "keywords": "minecraft world tools chunker converter convert java bedrock batch 500mb memory leak bluemap render map web server config region mca level dat 世界 工具 轉換 分批 記憶體 漏洞 算圖 地圖 網頁 設定",
    "native": true
  },
  {
    "tag": "module.viaproxy",
    "en": "ViaProxy",
    "zh": "Minecraft 版本代理",
    "glyph": "",
    "keywords": "viaproxy minecraft version proxy viaversion viabackwards viarewind protocol translate bridge server jar java cli bind target auth offline online mc 我的世界 版本 代理 協定 轉換 伺服器",
    "native": true
  },
  {
    "tag": "module.minecraftserver",
    "en": "Minecraft Server",
    "zh": "Minecraft 伺服器",
    "glyph": "",
    "keywords": "minecraft server paper spigot papermc buildtools eula server.properties plugin plugins luckperms essentialsx viaversion worldedit console rcon start.bat aikar gradle maven jar 伺服器 外掛 主控台 我的世界",
    "native": true
  },
  {
    "tag": "module.minecraftlauncher",
    "en": "Minecraft Launcher",
    "zh": "Minecraft 啟動器",
    "glyph": "",
    "keywords": "minecraft launcher java edition microsoft msa xbox live xsts authentication login sign in account uuid profile skin version manifest download assets libraries client jar sha1 natives jre temurin adoptium jvm xmx instance profile multi instance multiplayer mojang azure client id play vanilla release snapshot 啟動器 登入 微軟 帳戶 版本 下載 資產 程式庫 安裝 多開 實例 設定檔 記憶體 我的世界 原版 正版",
    "native": true
  },
  {
    "tag": "module.git",
    "en": "Git & GitHub",
    "zh": "Git 與 GitHub",
    "glyph": "",
    "keywords": "git github commit push pull fetch repo repos list clone branch tag merge rebase stash remote worktree submodule uploader issue pull request pr actions workflow release gist secret label star fork notifications gh cli gitty up checkpoint restore alias undo share workflow 版本控制 儲存庫 分支 標籤 工作流程 別名 撤回 檢查點",
    "native": true
  },
  {
    "tag": "module.vscode",
    "en": "VS Code",
    "zh": "VS Code 編輯器",
    "glyph": "",
    "keywords": "vscode vs code visual studio code editor cli open file folder workspace new window reuse diff merge goto line extension install uninstall list profile insiders tunnel remote settings keybindings code-workspace 編輯器 擴充功能 比對 合併 設定 遠端 隧道",
    "native": true
  },
  {
    "tag": "module.aiagents",
    "en": "AI Agents",
    "zh": "AI 代理",
    "glyph": "",
    "keywords": "ai agent claude code codex opencode pi openclaw hermes coding agent terminal cli install launch api key 代理 編程 安裝 啟動",
    "native": true
  },
  {
    "tag": "module.resume",
    "en": "Resume Writer",
    "zh": "履歷與求職信寫手",
    "glyph": "",
    "keywords": "resume cv cover letter job application tailor ai writer generate export base history docx pdf markdown 履歷 求職信 應徵 工作 職位 自我推薦 度身 生成 匯出",
    "native": true
  },
  {
    "tag": "module.ollama",
    "en": "Ollama",
    "zh": "本地大模型",
    "glyph": "",
    "keywords": "ollama llm local ai model chat gguf llama mistral qwen gemma phi deepseek pull serve tags running ps temperature top_p num_ctx streaming 本地 模型 聊天 人工智能 下載 大模型",
    "native": true
  },
  {
    "tag": "module.aichat",
    "en": "AI Chat",
    "zh": "AI 聊天",
    "glyph": "",
    "keywords": "ai chat llm ollama openai openrouter lm studio llama.cpp gpt local model conversation prompt streaming system prompt temperature openwebui open webui markdown 聊天 對話 本機模型 提示 串流 系統提示 溫度",
    "native": true
  },
  {
    "tag": "module.cloudflare",
    "en": "Cloudflare & Tunnel",
    "zh": "Cloudflare 與 Tunnel",
    "glyph": "",
    "keywords": "cloudflare cloudflared tunnel quick tunnel trycloudflare access warp dns over https doh zero trust route ingress 隧道 加密 連線",
    "native": true
  },
  {
    "tag": "module.weblogin",
    "en": "In-App Login",
    "zh": "內置登入",
    "glyph": "",
    "keywords": "login sign in signin oauth webview2 web view browser embedded auth authentication token cookie session redirect callback github cloudflare openai anthropic bitwarden account credentials 登入 登錄 內置 瀏覽器 認證 帳戶 憑證 權杖 重新導向",
    "native": true
  },
  {
    "tag": "module.ssh",
    "en": "SSH Toolset",
    "zh": "SSH 工具",
    "glyph": "",
    "keywords": "ssh sftp scp terminal shell remote profile key keygen ed25519 rsa passwordless deploy authorized_keys known hosts openssh dpapi 終端機 遠端 金鑰 免密碼 部署 連線 上載 下載",
    "native": true
  },
  {
    "tag": "module.apiclient",
    "en": "API Client",
    "zh": "REST API 用戶端",
    "glyph": "",
    "keywords": "api client rest http postman insomnia request response get post put patch delete head options url query params headers body json raw form url encoded x-www-form-urlencoded bearer token basic auth authorization collections environment variables substitute send httpclient status code response time size pretty print curl endpoint webhook REST 用戶端 客戶端 請求 回應 標頭 內文 查詢參數 驗證 權杖 基本驗證 集合 環境 變數 發送 狀態碼 美化 端點",
    "native": true
  },
  {
    "tag": "module.connectors",
    "en": "Connectors",
    "zh": "連接器",
    "glyph": "",
    "keywords": "connector connectors integration integrations mcp model context protocol server rest api webhook database endpoint external service auth bearer api key basic credential token secret dpapi connect link enable disable test reachability 連接器 整合 外部服務 端點 驗證 權杖 密鑰 連接 啟用 停用 測試 可達性",
    "native": true
  },
  {
    "tag": "module.packer",
    "en": "Packer (Image Builder)",
    "zh": "Packer（映像建置器）",
    "glyph": "",
    "keywords": "packer hashicorp image builder template hcl pkr.hcl json init validate fmt format build inspect plugin plugins var var-file variables provisioner builder source qemu docker aws azure vsphere amazon ami vm machine devops 映像 範本 建置 變數 插件",
    "native": true
  },
  {
    "tag": "module.worldmonitor",
    "en": "World Monitor",
    "zh": "世界監察",
    "glyph": "",
    "keywords": "world monitor worldmonitor news geopolitics finance commodity energy happy instability index intelligence dashboard globe map webview variant 世界 監察 新聞 地緣政治 金融 商品 能源 情報 儀表板 地球 不穩定指數",
    "native": true
  },
  {
    "tag": "module.webcloner",
    "en": "Website Cloner",
    "zh": "網站複製器",
    "glyph": "",
    "keywords": "website cloner clone copy site web page scrape download fetch assets html css js mirror rebuild reverse engineer ai agent webview2 design tokens 網站 複製 抓取 下載 鏡像 重建 設計符記",
    "native": true
  },
  {
    "tag": "module.pgadmin",
    "en": "Postgres Tool",
    "zh": "Postgres 工具 / pgAdmin",
    "glyph": "",
    "keywords": "postgres postgresql pgadmin sql database query npgsql connection schema table view server psql 資料庫 數據庫 查詢 表 檢視 結構描述 連線",
    "native": true
  },
  {
    "tag": "module.sqlitebrowser",
    "en": "SQLite Browser",
    "zh": "SQLite 資料庫瀏覽器",
    "glyph": "",
    "keywords": "sqlite db browser database sql query table view index trigger schema structure browse data edit insert delete row cell paged datagrid execute run csv export microsoft.data.sqlite managed dbbrowser db3 .db .sqlite .sqlite3 資料庫 數據庫 瀏覽器 查詢 表 檢視 索引 觸發器 結構 瀏覽 編輯 插入 刪除 列 單元格 分頁 執行 匯出",
    "native": true
  },
  {
    "tag": "module.filezilla",
    "en": "FTP / SFTP",
    "zh": "FTP／SFTP 檔案傳輸",
    "glyph": "",
    "keywords": "ftp sftp ftps filezilla file transfer client site manager upload download dual pane transfer queue resume tls ssh private key dpapi 檔案傳輸 上載 下載 站台 佇列 續傳 私鑰",
    "native": true
  },
  {
    "tag": "module.fileserver",
    "en": "File Server (FTP/SFTP host)",
    "zh": "檔案伺服器（FTP／SFTP 主機）",
    "glyph": "",
    "keywords": "file server host share folder ftp sftp ftps serve expose docker atmoz sftp alpine ftp server passive port range lan connection string self host multiple shares 檔案伺服器 主機 分享 資料夾 對外 共享 連接埠 被動 區域網 連線字串 多分享 自託管",
    "native": true
  },
  {
    "tag": "module.bitwarden",
    "en": "Bitwarden Vault",
    "zh": "Bitwarden 密碼庫",
    "glyph": "",
    "keywords": "bitwarden bw vault password manager login unlock master password totp 2fa two factor generate generator passphrase secret sync clipboard self-hosted vaultwarden 密碼庫 密碼 管理 解鎖 主密碼 驗證碼 產生 同步 機密",
    "native": true
  },
  {
    "tag": "module.keepass",
    "en": "KeePass Vault",
    "zh": "密碼保險庫",
    "glyph": "",
    "keywords": "keepass kdbx kee pass password vault local offline manager database master password key file open create entry group tree generator generate clipboard auto clear search lock unlock aes chacha20 argon2 salsa20 native encrypt decrypt 密碼保險庫 密碼庫 密碼 管理 本機 離線 主密碼 鎖匙檔 群組 項目 產生器 搜尋 鎖定 解鎖 加密 解密 原生",
    "native": true
  },
  {
    "tag": "module.feedreader",
    "en": "Feed Reader",
    "zh": "RSS 閱讀器",
    "glyph": "",
    "keywords": "feed reader rss atom quiterss fluent reader news subscriptions articles summary xml httpclient local json offline in-app native 閱讀器 RSS Atom Feed 訂閱 新聞 文章 摘要 原生 app內 本機",
    "native": true
  },
  {
    "tag": "module.quicktype",
    "en": "quicktype",
    "zh": "JSON 轉型別",
    "glyph": "",
    "keywords": "quicktype json schema typescript graphql postman code generator type csharp c# python go rust java kotlin swift objective-c c++ dart ruby elm php scala types just-types namespace newtonsoft system.text.json npm node jsontotype codegen 程式碼產生 型別 產生 轉換 結構",
    "native": true
  },
  {
    "tag": "module.decompiler",
    "en": ".NET Decompiler",
    "zh": ".NET 反編譯器",
    "glyph": "",
    "keywords": "decompiler decompile dotnet .net assembly browser ilspy il disassembler disassemble cil msil reverse engineer csharp c# managed dll exe metadata public key token target framework referenced assemblies resources namespace type member method property field event icsharpcode decompiler reflection metadata save cs view source 反編譯器 反編譯 反組譯 組件 瀏覽 程式集 中間語言 逆向工程 受控 後設資料 公開金鑰權杖 目標框架 參考組件 資源 命名空間 型別 成員 另存原始碼",
    "native": true
  },
  {
    "tag": "module.aws",
    "en": "AWS CLI",
    "zh": "AWS 命令列",
    "glyph": "",
    "keywords": "aws amazon web services cli s3 ec2 iam lambda cloudwatch logs sts profile credentials region sso configure bucket instance describe generic command browser skeleton dynamodb sns sqs ssm cloudformation route53 rds 雲端 命令列 設定檔 憑證 區域 儲存桶 執行個體",
    "native": true
  },
  {
    "tag": "module.cmdnotfound",
    "en": "Command Not Found",
    "zh": "搵唔到指令",
    "glyph": "",
    "keywords": "command not found cmdnotfound commandnotfound winget suggest suggestion powershell pwsh powershell 7 profile import-module feedback provider experimental feature pscommandnotfoundsuggestion psfeedbackprovider microsoft.winget.commandnotfound missing command package powertoys clone enable disable hook winget-suggest 搵唔到指令 找不到命令 建議 套件 掛鈎 設定檔 啟用 停用 實驗功能",
    "native": true
  },
  {
    "tag": "module.configbackup",
    "en": "Config & Backup",
    "zh": "設定與備份",
    "glyph": "",
    "keywords": "config backup snapshot restore export import bundle zip git schedule mirror reg winget integrity secrets ssh api key encrypt aes password 設定 備份 快照 還原 匯出 匯入 排程 鏡像 加密 密鑰 機密",
    "native": true
  },
  {
    "tag": "module.vault-volumes",
    "en": "WinForge Vault",
    "zh": "WinForge 保險庫",
    "glyph": "",
    "keywords": "vault volume container encrypt encrypted disk encryption mount dismount unmount drive letter password keyfile pim benchmark aes serpent twofish on the fly cryptography 保險庫 加密 容器 磁碟 掛載 卸載 密碼 鎖匙檔 磁碟區",
    "native": true
  },
  {
    "tag": "module.camoufox",
    "en": "Camoufox Profiles",
    "zh": "Camoufox 指紋設定檔",
    "glyph": "",
    "keywords": "camoufox anti detect antidetect browser firefox fingerprint spoof profile profiles cookies user agent useragent timezone locale proxy multi account multiaccount stealth automation playwright launch export import git commit history version control clone build from source 指紋 瀏覽器 反偵測 防偵測 設定檔 多帳號 代理 時區 匯出 匯入 歷史 版本控制 由原始碼建置",
    "native": true
  },
  {
    "tag": "module.jsontools",
    "en": "JSON & XML Tools",
    "zh": "JSON 同 XML 工具",
    "glyph": "",
    "keywords": "json xml format pretty minify validate escape unescape sort keys 格式化 美化 壓縮 驗證 轉義 還原 排序 鍵",
    "native": false
  },
  {
    "tag": "module.jsonpath",
    "en": "JSON Query",
    "zh": "JSON 查詢",
    "glyph": "",
    "keywords": "json jsonpath query path filter flatten leaf tree parse 查詢 路徑 攤平 葉子 解析",
    "native": false
  },
  {
    "tag": "module.jsondiff",
    "en": "JSON Diff",
    "zh": "JSON 比對",
    "glyph": "",
    "keywords": "json diff compare difference merge path added removed changed multiset 比對 差異 比較 對比 合併 路徑 新增 刪除 改變",
    "native": false
  },
  {
    "tag": "module.jsonflatten",
    "en": "JSON Flatten",
    "zh": "JSON 扁平化",
    "glyph": "",
    "keywords": "json flatten unflatten nested dotted path keys array index expand collapse 扁平化 還原 巢狀 點分隔 路徑 陣列 索引 展開 摺疊",
    "native": false
  },
  {
    "tag": "module.jsonpatch",
    "en": "JSON Patch",
    "zh": "JSON 修補",
    "glyph": "",
    "keywords": "json patch rfc 6902 diff apply pointer merge operations add remove replace test copy move 修補 差異 比較 套用 運算 指標 陣列",
    "native": false
  },
  {
    "tag": "module.jsonltools",
    "en": "JSONL Tools",
    "zh": "JSONL 工具",
    "glyph": "",
    "keywords": "jsonl ndjson json lines array validate minify pretty convert JSONL 換行 分行 陣列 驗證 壓縮 美化 轉換",
    "native": false
  },
  {
    "tag": "module.jsonmergepatch",
    "en": "JSON Merge Patch",
    "zh": "JSON 合併修補",
    "glyph": "",
    "keywords": "json merge patch rfc 7386 diff apply shallow merge null delete document target source 合併 修補 差異 套用 淺層 刪除 文件 目標 來源",
    "native": false
  },
  {
    "tag": "module.jsonschema",
    "en": "JSON Schema Validator",
    "zh": "JSON 結構描述驗證器",
    "glyph": "",
    "keywords": "json schema validate draft-07 validator required properties type enum pattern 結構描述 驗證 綱要 類型",
    "native": false
  },
  {
    "tag": "module.jsonpointer",
    "en": "JSON Pointer",
    "zh": "JSON 指標",
    "glyph": "",
    "keywords": "json pointer rfc 6901 path resolve query escape tilde slash index 指標 路徑 解析 逃逸 索引",
    "native": false
  },
  {
    "tag": "module.jsonstat",
    "en": "JSON Analyzer",
    "zh": "JSON 分析器",
    "glyph": "",
    "keywords": "json analyzer stats structure keys depth nodes parse validate 分析 統計 結構 鍵 深度 節點 解析 驗證",
    "native": false
  },
  {
    "tag": "module.jsonsort",
    "en": "JSON Key Sorter",
    "zh": "JSON 鍵排序",
    "glyph": "",
    "keywords": "json sort keys normalise normalize alphabetical order pretty print minify indent recursive 排序 鍵 正規化 美化 壓縮 縮排 遞迴",
    "native": false
  },
  {
    "tag": "module.jsontots",
    "en": "JSON to Types",
    "zh": "JSON 轉型別",
    "glyph": "",
    "keywords": "json typescript interface csharp class type generate convert schema model dto 型別 型態 類別 介面 轉換 生成 產生",
    "native": false
  },
  {
    "tag": "module.csvjson",
    "en": "CSV / JSON",
    "zh": "CSV/JSON 轉換",
    "glyph": "",
    "keywords": "csv json convert converter parse rfc4180 delimiter table array header 轉換 逗號 表格 解析 標題列",
    "native": false
  },
  {
    "tag": "module.csvlint",
    "en": "CSV Linter",
    "zh": "CSV 檢查修復",
    "glyph": "",
    "keywords": "csv lint linter rfc 4180 repair fix quote delimiter ragged bom validate clean 檢查 修復 逗號 分隔符 引號 欄位 換行 驗證",
    "native": false
  },
  {
    "tag": "module.tomljson",
    "en": "TOML ↔ JSON",
    "zh": "TOML ↔ JSON 轉換",
    "glyph": "",
    "keywords": "toml json convert parse config 轉換 解析 設定檔 配置 互轉",
    "native": false
  },
  {
    "tag": "module.yamljson",
    "en": "YAML ↔ JSON",
    "zh": "YAML ↔ JSON 轉換",
    "glyph": "",
    "keywords": "yaml json convert parse config serialize 轉換 解析 設定檔 序列化 互轉",
    "native": false
  },
  {
    "tag": "module.tableformat",
    "en": "Table Formatter",
    "zh": "表格排版",
    "glyph": "",
    "keywords": "table formatter csv tsv markdown ascii align columns delimiter pipe tab 表格 排版 對齊 分隔符 逗號 直線 標題",
    "native": false
  },
  {
    "tag": "module.htmltable",
    "en": "HTML Table Convert",
    "zh": "HTML 表格轉換",
    "glyph": "",
    "keywords": "html table csv tsv markdown convert thead tbody tr td parse generate 表格 轉換 逗號 標記 解析 產生",
    "native": false
  },
  {
    "tag": "module.iniedit",
    "en": "INI Editor",
    "zh": "INI 編輯器",
    "glyph": "",
    "keywords": "ini config configuration parser editor section key value comment settings 設定 組態 解析 分區 鍵 值 註解 編輯器",
    "native": false
  },
  {
    "tag": "module.envfile",
    "en": "Dotenv Editor",
    "zh": ".env 編輯器",
    "glyph": "",
    "keywords": "env dotenv environment variables editor convert shell json docker export KEY=VALUE 環境變數 編輯器 轉換",
    "native": false
  },
  {
    "tag": "module.envsubst",
    "en": "Variable Substitute",
    "zh": "變數代入",
    "glyph": "",
    "keywords": "envsubst variable substitution template placeholder dollar brace default environment interpolate 變數 代入 範本 佔位符 預設值 環境變數 插值",
    "native": false
  },
  {
    "tag": "module.faker",
    "en": "Data Faker",
    "zh": "假資料產生器",
    "glyph": "",
    "keywords": "lorem ipsum fake data generator placeholder mock seed name email uuid address 假資料 佔位文字 產生器 測試 種子 姓名 電郵 地址",
    "native": false
  },
  {
    "tag": "module.sqlformat",
    "en": "SQL Formatter",
    "zh": "SQL 格式化",
    "glyph": "",
    "keywords": "sql format formatter beautify beautifier prettify minify query indent keywords 格式化 美化 壓縮 查詢 縮排 關鍵字 資料庫",
    "native": false
  },
  {
    "tag": "module.xpathtester",
    "en": "XPath Tester",
    "zh": "XPath 測試器",
    "glyph": "",
    "keywords": "xpath xml query node selectnodes xdocument expression evaluate 測試 查詢 節點 表達式 路徑",
    "native": false
  },
  {
    "tag": "module.texttools",
    "en": "Text Tools",
    "zh": "文字工具",
    "glyph": "",
    "keywords": "text case upper lower title slug sort dedupe shuffle reverse trim lines words count stats 文字 大細楷 排序 去重複 打亂 倒轉 修剪 統計 字數 slug",
    "native": false
  },
  {
    "tag": "module.caseconvert",
    "en": "Case Converter",
    "zh": "大小寫轉換",
    "glyph": "",
    "keywords": "case convert camel pascal snake kebab constant title sentence dot path train naming identifier variable rename 大小寫 命名 轉換 駝峰 蛇形 烤串 常數 標題 變數 識別碼",
    "native": false
  },
  {
    "tag": "module.textreplace",
    "en": "Find & Replace",
    "zh": "尋找及取代",
    "glyph": "",
    "keywords": "find replace regex text substitute multi-rule pattern 尋找 取代 替換 正規表達式 批量 文字",
    "native": false
  },
  {
    "tag": "module.textdiff",
    "en": "Text Diff",
    "zh": "文字差異比對",
    "glyph": "",
    "keywords": "diff compare text lines lcs unified merge changes 文字 差異 比較 對比 逐行 合併",
    "native": false
  },
  {
    "tag": "module.textstats",
    "en": "Text Statistics",
    "zh": "文字統計",
    "glyph": "",
    "keywords": "text statistics readability word count characters sentences paragraphs reading time speaking time flesch kincaid grade syllables frequency 文字統計 可讀性 字數 字元 句數 段落 閱讀時間 朗讀時間 易讀度 年級 音節 字頻",
    "native": false
  },
  {
    "tag": "module.stringinspector",
    "en": "String Inspector",
    "zh": "字串檢查器",
    "glyph": "",
    "keywords": "string text unicode utf8 utf16 utf32 codepoint grapheme normalize nfc nfd escape unescape diacritics ascii reverse length bytes 字串 文字 統計 碼位 字素 正規化 轉義 音標 位元組 反轉",
    "native": false
  },
  {
    "tag": "module.stringcompare",
    "en": "String Compare",
    "zh": "字串相似度",
    "glyph": "",
    "keywords": "string compare similarity levenshtein edit distance damerau hamming jaro winkler substring subsequence diff text 字串 相似度 比較 編輯距離 差異 文字",
    "native": false
  },
  {
    "tag": "module.textredact",
    "en": "Text Redactor",
    "zh": "文字遮蔽",
    "glyph": "",
    "keywords": "redact mask pii privacy email phone credit card ip address censor scrub 遮蔽 遮罩 個資 私隱 電郵 電話 信用卡 IP 打格 過濾",
    "native": false
  },
  {
    "tag": "module.textescape",
    "en": "String Escaper",
    "zh": "字串跳脫",
    "glyph": "",
    "keywords": "escape unescape string json csharp javascript java python xml html url regex csv sql shell encode decode 字串 跳脫 還原 轉義 逃逸 編碼 解碼 正則 網址",
    "native": false
  },
  {
    "tag": "module.linetools",
    "en": "Line Tools",
    "zh": "行工具",
    "glyph": "",
    "keywords": "line tools text lines number prefix suffix quotes join split reverse sort dedupe deduplicate trim shuffle 行工具 文字 行 編號 前綴 後綴 引號 合併 拆分 反轉 排序 去重 修剪 打亂",
    "native": false
  },
  {
    "tag": "module.textsort",
    "en": "Line Sort & Dedupe",
    "zh": "行排序同去重",
    "glyph": "",
    "keywords": "sort lines dedupe duplicate unique reverse shuffle natural order alphabetical trim blank 排序 去重 重複 反轉 打亂 自然排序 行",
    "native": false
  },
  {
    "tag": "module.textwrap",
    "en": "Text Wrap",
    "zh": "文字換行",
    "glyph": "",
    "keywords": "text wrap reflow rewrap unwrap column width word boundary hanging indent prefix comment commit message readme 文字 換行 重排 拉直 縮排 前綴 闊度 段落 註解",
    "native": false
  },
  {
    "tag": "module.textcolumns",
    "en": "Column Tools",
    "zh": "欄位文字工具",
    "glyph": "",
    "keywords": "columns column text delimited split tab csv comma extract delete reorder align transpose trim 欄位 欄 分隔符 分割 表格 抽取 刪除 重排 對齊 行列互換 修剪",
    "native": false
  },
  {
    "tag": "module.texttemplate",
    "en": "Template Renderer",
    "zh": "模板渲染器",
    "glyph": "",
    "keywords": "template render placeholder mustache handlebars merge fields json key value substitute 模板 渲染 佔位符 合併 欄位 變數 替換 生成",
    "native": false
  },
  {
    "tag": "module.leet",
    "en": "Fancy Text",
    "zh": "花式文字",
    "glyph": "",
    "keywords": "fancy text unicode font styler bold italic fraktur script circled fullwidth strikethrough underline leetspeak upside down 花式文字 特殊字體 粗體 斜體 花體 圓圈 全形 刪除線 底線 火星文 倒轉字",
    "native": false
  },
  {
    "tag": "module.boxtext",
    "en": "Box & Banner Text",
    "zh": "文字方框 / 橫幅",
    "glyph": "",
    "keywords": "box banner ascii border frame comment block banner text wrap 文字方框 橫幅 邊框 框框 註解 ASCII 標題",
    "native": false
  },
  {
    "tag": "module.loremtext",
    "en": "Lorem Ipsum Generator",
    "zh": "假文產生器",
    "glyph": "",
    "keywords": "lorem ipsum placeholder text dummy filler paragraphs sentences words html generator 假文 佔位文字 填充 段落 句子 產生器",
    "native": false
  },
  {
    "tag": "module.wordfreq",
    "en": "Word Frequency",
    "zh": "詞頻統計",
    "glyph": "",
    "keywords": "word frequency count bigram character stop words rank text analysis csv 詞頻 字頻 統計 排名 文字 分析 計數",
    "native": false
  },
  {
    "tag": "module.phonetic",
    "en": "Phonetic Speller",
    "zh": "拼讀字母表",
    "glyph": "",
    "keywords": "phonetic alphabet nato icao alpha bravo charlie spell radio callsign police speller 拼讀 字母表 無線電 呼號 拼寫 讀音",
    "native": false
  },
  {
    "tag": "module.numberformat",
    "en": "Number Formatter",
    "zh": "數字格式化",
    "glyph": "",
    "keywords": "number format formatter thousands separator decimal currency percent scientific accounting zero-pad culture globalization 數字 格式 格式化 千分位 小數 貨幣 百分比 科學記數 會計 補零 地區",
    "native": false
  },
  {
    "tag": "module.numwords",
    "en": "Number to Words",
    "zh": "數字轉文字",
    "glyph": "",
    "keywords": "number words spell out cardinal ordinal roman numeral currency dollars cents amount cheque spelling 數字 文字 拼寫 序數 羅馬數字 金額 銀碼 支票 大寫 讀數",
    "native": false
  },
  {
    "tag": "module.numwordsx",
    "en": "Number to Words+",
    "zh": "數字轉文字（加強版）",
    "glyph": "",
    "keywords": "number words spell cardinal ordinal currency dollars cents pounds pence chinese uppercase financial daxie 數字 轉 文字 大寫 小寫 中文 貨幣 元角分 序數 基數 一百二十三 壹佰貳拾參",
    "native": false
  },
  {
    "tag": "module.markdown",
    "en": "Markdown Preview",
    "zh": "Markdown 預覽",
    "glyph": "",
    "keywords": "markdown md preview render html editor document 文件 標記 預覽 排版 編輯 渲染",
    "native": false
  },
  {
    "tag": "module.markdowntoc",
    "en": "Markdown TOC",
    "zh": "Markdown 目錄",
    "glyph": "",
    "keywords": "markdown toc table of contents heading anchor slug outline github 目錄 標題 錨點 大綱 連結",
    "native": false
  },
  {
    "tag": "module.mdtable",
    "en": "Markdown Table",
    "zh": "Markdown 表格",
    "glyph": "",
    "keywords": "markdown table csv tsv pipe grid align github gfm reformat convert 表格 標記 逗號 定位鍵 直線 對齊 轉換 重排",
    "native": false
  },
  {
    "tag": "module.htmltomd",
    "en": "HTML to Markdown",
    "zh": "HTML 轉 Markdown",
    "glyph": "",
    "keywords": "html markdown md convert converter web strip tags entities decode 轉換 標記 網頁 標籤 實體 剝除",
    "native": false
  },
  {
    "tag": "module.htmlpreview",
    "en": "HTML Preview",
    "zh": "HTML 預覽",
    "glyph": "",
    "keywords": "html preview live render webview editor escape encode 網頁 預覽 即時 渲染 編輯器 轉義 原始碼",
    "native": false
  },
  {
    "tag": "module.htmlformat",
    "en": "HTML Formatter",
    "zh": "HTML 格式化",
    "glyph": "",
    "keywords": "html format formatter beautify prettify minify minifier indent tidy markup tags web HTML 格式化 美化 壓縮 縮排 標籤 網頁 排版",
    "native": false
  },
  {
    "tag": "module.cssformat",
    "en": "CSS Formatter",
    "zh": "CSS 格式化",
    "glyph": "",
    "keywords": "css format beautify minify prettify stylesheet compress whitespace indent 格式化 美化 壓縮 精簡 樣式表 縮排 排版",
    "native": false
  },
  {
    "tag": "module.htmlentities",
    "en": "HTML Entities",
    "zh": "HTML 實體",
    "glyph": "",
    "keywords": "html entities encode decode escape named numeric nbsp copy 實體 編碼 解碼 跳脫 具名 數字",
    "native": false
  },
  {
    "tag": "module.metatags",
    "en": "Meta Tag Generator",
    "zh": "Meta 標籤產生器",
    "glyph": "",
    "keywords": "meta tag html head seo open graph twitter card canonical viewport theme charset og description keywords 標籤 網頁 元資料 搜尋引擎 分享 預覽 標題 描述",
    "native": false
  },
  {
    "tag": "module.asciiart",
    "en": "ASCII Banner",
    "zh": "ASCII 橫幅",
    "glyph": "",
    "keywords": "ascii art banner text figlet monospace 橫幅 文字 藝術 標題 大字",
    "native": false
  },
  {
    "tag": "module.asciitable",
    "en": "ASCII Table",
    "zh": "ASCII 表",
    "glyph": "",
    "keywords": "ascii table character codes control codes hex octal binary latin-1 charset reference 字元 字元碼 控制碼 十六進 八進 二進 參考表",
    "native": false
  },
  {
    "tag": "module.emoji",
    "en": "Emoji Picker",
    "zh": "Emoji 選擇器",
    "glyph": "",
    "keywords": "emoji smiley face symbol copy clipboard picker 表情 符號 貼圖 複製 剪貼簿 選擇器",
    "native": false
  },
  {
    "tag": "module.symbols",
    "en": "Symbols Palette",
    "zh": "特殊符號調色盤",
    "glyph": "",
    "keywords": "symbols special characters unicode glyph arrows math currency greek punctuation box drawing stars fractions superscript subscript copy 符號 特殊字元 統一碼 箭嘴 數學 貨幣 希臘 標點 框線 星 分數 上下標 複製",
    "native": false
  },
  {
    "tag": "module.charmap",
    "en": "Character Map",
    "zh": "字元對照表",
    "glyph": "",
    "keywords": "character map unicode codepoint glyph symbol emoji utf-8 utf-16 html entity charmap block 字元 字符 對照表 統一碼 萬國碼 碼位 符號 表情符號 特殊符號",
    "native": false
  },
  {
    "tag": "module.unicodeinspect",
    "en": "Unicode Inspector",
    "zh": "Unicode 檢查器",
    "glyph": "",
    "keywords": "unicode inspector codepoint character utf-8 utf-16 category combining zero-width confusable rune 統一碼 字元 碼位 類別 組合 零寬 檢查",
    "native": false
  },
  {
    "tag": "module.binarytext",
    "en": "Text to Binary",
    "zh": "文字轉二進位",
    "glyph": "",
    "keywords": "binary text codes utf-8 encode decode ascii hex octal decimal base converter 二進位 文字 編碼 解碼 十六進位 八進位 十進位 位元組 轉換",
    "native": false
  },
  {
    "tag": "module.encoder",
    "en": "Encode / Decode",
    "zh": "編碼 / 解碼",
    "glyph": "",
    "keywords": "encode decode base64 base64url url percent html entity hex bytes jwt token decoder 編碼 解碼 十六進位 位元組 權杖 網址",
    "native": false
  },
  {
    "tag": "module.encodingconv",
    "en": "Encoding Converter",
    "zh": "編碼轉換",
    "glyph": "",
    "keywords": "encoding charset utf-8 utf-16 ascii latin-1 bom line ending crlf lf cr convert text file 編碼 字元集 換行 轉換 位元組順序標記 文字檔",
    "native": false
  },
  {
    "tag": "module.base32",
    "en": "Base32 / 58 / 85",
    "zh": "Base32 / 58 / 85 編解碼",
    "glyph": "",
    "keywords": "base32 base58 base85 ascii85 rfc4648 bitcoin adobe encode decode codec 編碼 解碼 編解碼 位元組",
    "native": false
  },
  {
    "tag": "module.ascii85",
    "en": "Ascii85 / Base85",
    "zh": "Ascii85 / 八十五進位編碼",
    "glyph": "",
    "keywords": "ascii85 base85 z85 zeromq rfc1924 adobe encode decode encoder decoder btoa ipv6 八十五進位 編碼 解碼 十六進位",
    "native": false
  },
  {
    "tag": "module.imgbase64",
    "en": "Image / Base64",
    "zh": "圖片 ↔ Base64",
    "glyph": "",
    "keywords": "image base64 data uri encode decode png jpg gif webp clipboard 圖片 圖像 編碼 解碼 資料 網址 剪貼簿",
    "native": false
  },
  {
    "tag": "module.morse",
    "en": "Morse Code",
    "zh": "摩斯電碼",
    "glyph": "",
    "keywords": "morse code encode decode dots dashes international telegraph flash 摩斯 密碼 電碼 點 劃 電報",
    "native": false
  },
  {
    "tag": "module.romannum",
    "en": "Roman Numerals",
    "zh": "羅馬數字",
    "glyph": "",
    "keywords": "roman numerals number convert MCMXCIV validate 羅馬 數字 轉換 大寫 驗證",
    "native": false
  },
  {
    "tag": "module.guidgen",
    "en": "GUID & ID Generator",
    "zh": "GUID 同 ID 產生器",
    "glyph": "",
    "keywords": "guid uuid ulid nanoid random id generator identifier crockford base32 version variant bytes GUID UUID 唯一識別碼 隨機 產生器 識別碼 位元組 版本",
    "native": false
  },
  {
    "tag": "module.uuidv5",
    "en": "Namespaced UUID",
    "zh": "具名空間 UUID",
    "glyph": "",
    "keywords": "uuid guid v5 v3 sha1 md5 namespace rfc 4122 deterministic hash dns url oid x500 具名空間 命名空間 雜湊 確定性 標識符",
    "native": false
  },
  {
    "tag": "module.uuidv7",
    "en": "UUID v7",
    "zh": "UUID v7 識別碼",
    "glyph": "",
    "keywords": "uuid v7 guid time-ordered sortable rfc 9562 timestamp generate decode 識別碼 時間排序 產生 解碼",
    "native": false
  },
  {
    "tag": "module.ulid",
    "en": "ULID / Snowflake",
    "zh": "ULID／Snowflake 工具",
    "glyph": "",
    "keywords": "ulid snowflake identifier id generate decode timestamp crockford base32 monotonic twitter discord epoch worker sequence guid uuid 識別碼 產生 解碼 時間戳 序號",
    "native": false
  },
  {
    "tag": "module.shortid",
    "en": "Short ID Encoder",
    "zh": "短碼編碼器",
    "glyph": "",
    "keywords": "short id encoder base62 base58 base36 crockford base32 nanoid random id url-safe encode decode bigint 短碼 編碼 解碼 隨機 隨機ID 進制 位元組 URL安全",
    "native": false
  },
  {
    "tag": "module.slugify",
    "en": "Slugify",
    "zh": "網址別名",
    "glyph": "",
    "keywords": "slug slugify url permalink kebab hyphen diacritics transliterate case seo 網址 別名 短網址 連字號 去重音 大小寫",
    "native": false
  },
  {
    "tag": "module.checkdigit",
    "en": "Check Digit Validator",
    "zh": "檢查碼驗證器",
    "glyph": "",
    "keywords": "checksum luhn credit card isbn ean upc iban mod97 check digit validator barcode 檢查碼 校驗碼 信用卡 條碼 銀行帳號",
    "native": false
  },
  {
    "tag": "module.hexdump",
    "en": "Hex Dump",
    "zh": "十六進位傾印",
    "glyph": "",
    "keywords": "hex dump hexdump bytes offset ascii binary view file text utf-8 十六進位 傾印 位元組 偏移 二進位 檢視",
    "native": false
  },
  {
    "tag": "module.mimetypes",
    "en": "MIME Type Lookup",
    "zh": "MIME 類型查詢",
    "glyph": "",
    "keywords": "mime content-type extension media type header upload web server octet-stream MIME 類型 內容類型 副檔名 檔名 偵測 上載 標頭",
    "native": false
  },
  {
    "tag": "module.barcode",
    "en": "Barcode Generator",
    "zh": "條碼產生器",
    "glyph": "",
    "keywords": "barcode code128 code39 ean-13 ean13 1d symbology svg generate scan retail 條碼 條形碼 產生 掃描 零售",
    "native": false
  },
  {
    "tag": "module.loremimg",
    "en": "Placeholder Image",
    "zh": "佔位圖",
    "glyph": "",
    "keywords": "placeholder image svg dummy mockup data uri base64 width height colour generator 佔位圖 預留圖 假圖 圖片 產生器 資料URI",
    "native": false
  },
  {
    "tag": "module.hasher",
    "en": "Hash & Checksum",
    "zh": "雜湊與校驗和",
    "glyph": "",
    "keywords": "hash checksum md5 sha1 sha256 sha384 sha512 crc32 hmac verify fingerprint digest file text 雜湊 校驗和 校驗 指紋 核對 摘要 加密 檔案 驗證",
    "native": false
  },
  {
    "tag": "module.jwtinspect",
    "en": "JWT Inspector",
    "zh": "JWT 檢查器",
    "glyph": "",
    "keywords": "jwt json web token decode verify hmac hs256 hs384 hs512 claims exp iat signature 權杖 解碼 驗證 簽名 聲明 到期",
    "native": false
  },
  {
    "tag": "module.jwtbuild",
    "en": "JWT Builder",
    "zh": "JWT 建立同驗證",
    "glyph": "",
    "keywords": "jwt json web token hmac sign verify hs256 hs384 hs512 base64url claims exp nbf iat 權杖 簽名 驗證 宣告 密鑰",
    "native": false
  },
  {
    "tag": "module.totp",
    "en": "TOTP Authenticator",
    "zh": "TOTP 驗證器",
    "glyph": "",
    "keywords": "totp hotp authenticator 2fa mfa otp one-time code rfc6238 rfc4226 authenticator authy base32 otpauth 驗證器 兩步驗證 雙重認證 一次性密碼 驗證碼",
    "native": false
  },
  {
    "tag": "module.ciphers",
    "en": "Classic Ciphers",
    "zh": "經典密碼",
    "glyph": "",
    "keywords": "cipher encode decode rot13 caesar atbash vigenere a1z26 morse code encrypt decrypt 密碼 加密 解密 凱撒 阿特巴希 維吉尼亞 摩斯電碼",
    "native": false
  },
  {
    "tag": "module.passgen",
    "en": "Password Generator",
    "zh": "密碼產生器",
    "glyph": "",
    "keywords": "password passphrase generator random secure entropy strength diceware csprng 密碼 通行短語 隨機 產生器 安全 熵值 強度",
    "native": false
  },
  {
    "tag": "module.diceware",
    "en": "Passphrase Generator",
    "zh": "密語產生器",
    "glyph": "",
    "keywords": "diceware passphrase password words memorable entropy random generator secure 密語 通行短語 密碼 詞語 熵 隨機 產生器",
    "native": false
  },
  {
    "tag": "module.passwordstrength",
    "en": "Password Strength",
    "zh": "密碼強度",
    "glyph": "",
    "keywords": "password strength entropy crack time secure passphrase check 密碼 強度 熵值 破解時間 安全 檢查 通行密碼",
    "native": false
  },
  {
    "tag": "module.entropy",
    "en": "Entropy Analyzer",
    "zh": "熵值分析",
    "glyph": "",
    "keywords": "entropy shannon randomness bits information chi-square histogram frequency hex utf-8 熵 隨機 隨機度 資訊 亂度 卡方 直方圖 頻率 十六進位",
    "native": false
  },
  {
    "tag": "module.unixperm",
    "en": "chmod Calculator",
    "zh": "chmod 計算機",
    "glyph": "",
    "keywords": "chmod unix permission octal symbolic rwx setuid setgid sticky linux file mode 權限 八進位 符號 檔案模式",
    "native": false
  },
  {
    "tag": "module.urltools",
    "en": "URL Tools",
    "zh": "網址工具",
    "glyph": "",
    "keywords": "url uri link query string parameter encode decode escape unescape percent 網址 連結 查詢 參數 編碼 解碼 拆解",
    "native": false
  },
  {
    "tag": "module.queryedit",
    "en": "URL Query Editor",
    "zh": "網址查詢編輯器",
    "glyph": "",
    "keywords": "url query string parameters edit encode decode percent key value querystring 網址 查詢 參數 編碼 解碼",
    "native": false
  },
  {
    "tag": "module.curlgen",
    "en": "cURL Generator",
    "zh": "cURL 產生器",
    "glyph": "",
    "keywords": "curl fetch powershell invoke-restmethod http request api snippet code generator header bearer basic auth 產生器 請求 標頭 代碼 片段 網絡 呼叫",
    "native": false
  },
  {
    "tag": "module.httpstatus",
    "en": "HTTP Status Codes",
    "zh": "HTTP 狀態碼",
    "glyph": "",
    "keywords": "http status code reference response 1xx 2xx 3xx 4xx 5xx 404 500 web api 狀態碼 回應碼 網頁 錯誤碼",
    "native": false
  },
  {
    "tag": "module.httpheaders",
    "en": "HTTP Header Inspector",
    "zh": "HTTP 標頭檢測",
    "glyph": "",
    "keywords": "http header inspector headers response status redirect content-type curl request 標頭 檢測 回應 狀態 重新導向 網絡請求 網址",
    "native": false
  },
  {
    "tag": "module.httpheaderref",
    "en": "HTTP Headers Ref",
    "zh": "HTTP 標頭參考",
    "glyph": "",
    "keywords": "http header headers request response cache cors security cookie auth reference mime standard 標頭 標頭參考 請求 回應 快取 安全 曲奇 參考",
    "native": false
  },
  {
    "tag": "module.headerscore",
    "en": "Security Header Score",
    "zh": "安全標頭計分",
    "glyph": "",
    "keywords": "http header security score csp hsts x-frame-options referrer permissions coop coep scorecard grade 安全 標頭 計分 網頁 安全性 標頭評分 版本洩露",
    "native": false
  },
  {
    "tag": "module.haranalyzer",
    "en": "HAR Analyzer",
    "zh": "HAR 分析器",
    "glyph": "",
    "keywords": "har http archive network requests waterfall performance analyze json 網絡 請求 分析 效能 瀑布圖 狀態碼 傳輸",
    "native": false
  },
  {
    "tag": "module.ping",
    "en": "Ping & Traceroute",
    "zh": "網路測試（Ping・路由追蹤）",
    "glyph": "",
    "keywords": "ping traceroute tracert icmp latency rtt ttl packet loss network diagnose reachability dns 網路 測試 延遲 丟包 路由 追蹤 躍點 主機 連線",
    "native": false
  },
  {
    "tag": "module.dnslookup",
    "en": "DNS Lookup",
    "zh": "DNS 查詢",
    "glyph": "",
    "keywords": "dns lookup resolve record a aaaa mx txt ns cname ptr nslookup dig doh DNS 查詢 域名 解析 記錄 反向 郵件伺服器 名稱伺服器",
    "native": false
  },
  {
    "tag": "module.dnsref",
    "en": "DNS Records Reference",
    "zh": "DNS 記錄參考",
    "glyph": "",
    "keywords": "dns records reference a aaaa cname mx txt ns soa srv caa dmarc spf dkim zone file 域名 記錄 參考 區域檔 郵件 解析",
    "native": false
  },
  {
    "tag": "module.portscan",
    "en": "Port Scanner",
    "zh": "連接埠掃描",
    "glyph": "",
    "keywords": "port scanner tcp scan network ports open service reachability diagnostic 連接埠 埠 掃描 網絡 開放 服務 診斷 通訊埠",
    "native": false
  },
  {
    "tag": "module.subnetcalc",
    "en": "Subnet Calculator",
    "zh": "子網計算器",
    "glyph": "",
    "keywords": "subnet cidr ipv4 netmask network broadcast wildcard host class rfc1918 vlsm 子網 遮罩 網絡 廣播 主機 前綴 私有",
    "native": false
  },
  {
    "tag": "module.subnetv6",
    "en": "IPv6 Tools",
    "zh": "IPv6 工具",
    "glyph": "",
    "keywords": "ipv6 subnet prefix cidr eui-64 mac address expand compress link-local unique-local multicast global network mask 位址 子網 前綴 遮罩 展開 壓縮 多播 鏈路本地 唯一本地 全球單播 介面識別碼",
    "native": false
  },
  {
    "tag": "module.ipinfo",
    "en": "IP & Network Info",
    "zh": "IP 同網絡資訊",
    "glyph": "",
    "keywords": "ip network adapter mac ipv4 ipv6 gateway dns public ip lan wifi ethernet 網絡 網卡 位址 閘道 公開ip 網絡資訊",
    "native": false
  },
  {
    "tag": "module.wol",
    "en": "Wake-on-LAN",
    "zh": "網絡喚醒",
    "glyph": "",
    "keywords": "wol wake on lan magic packet remote power boot mac udp broadcast 網絡喚醒 遠端開機 魔術封包 喚醒 開機 網卡",
    "native": false
  },
  {
    "tag": "module.mactools",
    "en": "MAC Address Tools",
    "zh": "MAC 位址工具",
    "glyph": "",
    "keywords": "mac address ethernet hardware physical oui vendor unicast multicast locally administered format normalize colon hyphen cisco dotted generate random MAC 位址 網卡 硬件 實體位址 廠商 單播 多播 本地管理 格式 轉換 冒號 生成 隨機",
    "native": false
  },
  {
    "tag": "module.hostsedit",
    "en": "Hosts File Editor",
    "zh": "主機檔編輯器",
    "glyph": "",
    "keywords": "hosts file editor dns block ad tracker 0.0.0.0 localhost domain blocklist etc drivers hostname 主機檔 編輯器 封鎖 廣告 追蹤 網域 遮蔽",
    "native": false
  },
  {
    "tag": "module.regextester",
    "en": "Regex Tester",
    "zh": "正則表達式測試",
    "glyph": "",
    "keywords": "regex regular expression tester match groups replace pattern dotnet regexoptions ignorecase multiline timeout 正則 正規表達式 表達式 測試 比對 群組 取代 樣式",
    "native": false
  },
  {
    "tag": "module.regexcheat",
    "en": "Regex Cheatsheet",
    "zh": "正則速查",
    "glyph": "",
    "keywords": "regex regular expression cheatsheet reference tokens character class anchor quantifier lookaround flags .net 正則 正規表達式 速查 參考 字元類 錨點 量詞",
    "native": false
  },
  {
    "tag": "module.globtester",
    "en": "Glob Tester",
    "zh": "Glob 樣式測試器",
    "glyph": "",
    "keywords": "glob pattern wildcard regex match path filter minimatch 樣式 萬用字元 配對 路徑 正則",
    "native": false
  },
  {
    "tag": "module.semverrange",
    "en": "Semver Range Tester",
    "zh": "語意化版本範圍測試器",
    "glyph": "",
    "keywords": "semver semantic version range node-semver caret tilde prerelease 語意化 版本 範圍 測試 相容 依賴",
    "native": false
  },
  {
    "tag": "module.gitignore",
    "en": "Gitignore Generator",
    "zh": ".gitignore 產生器",
    "glyph": "",
    "keywords": "gitignore git ignore template node python visual studio vscode jetbrains rust java maven go cpp macos windows linux 忽略 範本 產生器",
    "native": false
  },
  {
    "tag": "module.pathdoctor",
    "en": "PATH Doctor",
    "zh": "PATH 醫生",
    "glyph": "",
    "keywords": "path environment variable editor cleanup dedupe dead folders system user 環境變數 路徑 編輯 清理 去重複 死項 系統 使用者",
    "native": false
  },
  {
    "tag": "module.envdiff",
    "en": "Env Snapshot & Diff",
    "zh": "環境變數快照同差異",
    "glyph": "",
    "keywords": "environment variables snapshot diff env path compare added removed changed process user machine export clipboard 環境變數 快照 差異 比較 匯出 路徑",
    "native": false
  },
  {
    "tag": "module.clipinspect",
    "en": "Clipboard Inspector",
    "zh": "剪貼簿檢查器",
    "glyph": "",
    "keywords": "clipboard formats inspect paste data package 剪貼簿 剪貼板 格式 檢查 貼上 資料",
    "native": false
  },
  {
    "tag": "module.timer",
    "en": "Timer & Stopwatch",
    "zh": "計時器・碼錶・番茄鐘",
    "glyph": "",
    "keywords": "timer stopwatch countdown pomodoro focus lap clock 計時器 碼錶 秒錶 倒數 倒數計時 番茄鐘 專注 分段 時鐘",
    "native": false
  },
  {
    "tag": "module.worldclock",
    "en": "World Clock",
    "zh": "世界時鐘",
    "glyph": "",
    "keywords": "world clock time zone converter utc offset city 世界時鐘 時區 轉換 時間 城市 時差 協調世界時",
    "native": false
  },
  {
    "tag": "module.datecalc",
    "en": "Date Calculator",
    "zh": "日期計算器",
    "glyph": "",
    "keywords": "date days weeks age birthday countdown business days iso week leap year difference add subtract 日期 計算 日數 週數 年齡 生日 倒數 工作日 閏年 星期",
    "native": false
  },
  {
    "tag": "module.durationcalc",
    "en": "Duration Calculator",
    "zh": "時長計算器",
    "glyph": "",
    "keywords": "duration time calculator timespan add subtract sum convert hours minutes seconds days 時長 時間 計算器 計算 加 減 加總 換算 小時 分鐘 秒 日 乘 除",
    "native": false
  },
  {
    "tag": "module.epoch",
    "en": "Epoch Converter",
    "zh": "紀元轉換器",
    "glyph": "",
    "keywords": "epoch unix timestamp time converter iso 8601 utc local relative 紀元 時間戳 Unix 時間 轉換 時區 世界協調時間 相對",
    "native": false
  },
  {
    "tag": "module.cronbuilder",
    "en": "Cron Builder",
    "zh": "Cron 建構器",
    "glyph": "",
    "keywords": "cron schedule crontab expression job timer next run 排程 定時 計劃任務 運算式 crontab 下次執行",
    "native": false
  },
  {
    "tag": "module.cronnext",
    "en": "Cron Next Runs",
    "zh": "Cron 下次執行時間",
    "glyph": "",
    "keywords": "cron schedule crontab next run fire time timezone quartz job 排程 定時 下次執行 時區 運算式 觸發時間",
    "native": false
  },
  {
    "tag": "module.tzplanner",
    "en": "Timezone Planner",
    "zh": "時區會議規劃",
    "glyph": "",
    "keywords": "timezone time zone meeting planner world clock utc offset working hours dst 時區 時間 會議 規劃 世界時鐘 辦公時間 跨時區 UTC",
    "native": false
  },
  {
    "tag": "module.icalendar",
    "en": "iCalendar Builder",
    "zh": "日曆檔產生器",
    "glyph": "",
    "keywords": "icalendar ics calendar event vevent vcalendar rrule valarm reminder recurrence appointment meeting invite 日曆 行事曆 活動 提醒 重複 會議 邀請 匯出",
    "native": false
  },
  {
    "tag": "module.calendarmonth",
    "en": "Calendar",
    "zh": "月曆",
    "glyph": "",
    "keywords": "calendar month week iso weekday date day-of-year today 月曆 日曆 月份 星期 週數 日期 今日",
    "native": false
  },
  {
    "tag": "module.countdownevent",
    "en": "Event Countdown",
    "zh": "事件倒數",
    "glyph": "",
    "keywords": "countdown event timer date deadline days remaining 事件 倒數 計時 日期 死線 剩餘",
    "native": false
  },
  {
    "tag": "module.calculator",
    "en": "Calculator",
    "zh": "計數機",
    "glyph": "",
    "keywords": "calculator math expression evaluator arithmetic trig scientific hex binary octal 計數機 數學 表達式 計算 三角函數 科學 進位 十六進位 二進位",
    "native": false
  },
  {
    "tag": "module.percentcalc",
    "en": "Percentage Calculator",
    "zh": "百分比計算器",
    "glyph": "",
    "keywords": "percent percentage ratio tip change increase decrease calculator split gcd simplify 百分比 比例 貼士 分帳 變化率 加減 化簡 計算器",
    "native": false
  },
  {
    "tag": "module.loancalc",
    "en": "Loan Calculator",
    "zh": "貸款計算",
    "glyph": "",
    "keywords": "loan mortgage amortization interest payment finance emi principal rate 貸款 按揭 供樓 攤還 利息 還款 月供 本金 年利率",
    "native": false
  },
  {
    "tag": "module.bmi",
    "en": "Health Calculators",
    "zh": "健康計算器",
    "glyph": "",
    "keywords": "bmi bmr calorie tdee body fat navy mifflin health weight height 健康 計算器 體重 身高 體脂 熱量 代謝 卡路里",
    "native": false
  },
  {
    "tag": "module.unitconvert",
    "en": "Unit Converter",
    "zh": "單位換算",
    "glyph": "",
    "keywords": "unit convert converter length mass weight temperature celsius fahrenheit kelvin data bytes speed area time pressure metric imperial 單位 換算 轉換 長度 質量 重量 溫度 攝氏 華氏 資料 速度 面積 時間 壓力 公制 英制",
    "native": false
  },
  {
    "tag": "module.baseconvert",
    "en": "Base Converter",
    "zh": "進位轉換",
    "glyph": "",
    "keywords": "base radix binary octal decimal hex hexadecimal bitwise shift programmer bigint convert 進位 二進制 八進制 十進制 十六進制 位元 轉換 程式員",
    "native": false
  },
  {
    "tag": "module.scinotation",
    "en": "Scientific Notation",
    "zh": "科學記數法",
    "glyph": "",
    "keywords": "scientific engineering notation exponent mantissa significant figures SI prefix E-notation kilo mega giga 科學 工程 記數法 指數 有效數字 前綴 換算",
    "native": false
  },
  {
    "tag": "module.aspectratio",
    "en": "Aspect Ratio",
    "zh": "長寬比計算",
    "glyph": "",
    "keywords": "aspect ratio resolution 16:9 scale gcd megapixels dimensions widescreen 長寬比 解析度 比例 縮放 像素 闊高 畫面比",
    "native": false
  },
  {
    "tag": "module.numseq",
    "en": "Number Sequence",
    "zh": "數字序列",
    "glyph": "",
    "keywords": "number sequence generator arithmetic geometric fibonacci prime primes range squares cubes triangular powers series list 數字 序列 產生器 等差 等比 斐波那契 質數 範圍 平方 立方 三角數 次方",
    "native": false
  },
  {
    "tag": "module.tallycounter",
    "en": "Tally Counter",
    "zh": "點數計數器",
    "glyph": "",
    "keywords": "tally counter count clicker increment score reps 點數 計數器 計數 數數 點算 分數 加減",
    "native": false
  },
  {
    "tag": "module.randomizer",
    "en": "Randomizer",
    "zh": "隨機工具箱",
    "glyph": "",
    "keywords": "random rng integer coin flip dice roll d20 shuffle pick list secure unbiased 隨機 亂數 擲骰 擲銀仔 抽籤 打亂 洗牌 骰仔 公字",
    "native": false
  },
  {
    "tag": "module.expensesplit",
    "en": "Expense Splitter",
    "zh": "夾錢分帳",
    "glyph": "",
    "keywords": "expense split settle bill share money owe balance transfer trip dinner 夾錢 分帳 找數 埋單 均分 結餘 欠錢 AA制",
    "native": false
  },
  {
    "tag": "module.unitprice",
    "en": "Unit Price",
    "zh": "單位價格",
    "glyph": "",
    "keywords": "unit price per unit compare value cheapest best deal grocery shopping 單位價格 格價 比較 最抵 每單位 買嘢 慳錢",
    "native": false
  },
  {
    "tag": "module.colortools",
    "en": "Color Tools",
    "zh": "色彩工具",
    "glyph": "",
    "keywords": "color colour hex rgb hsl hsv cmyk palette contrast wcag accessibility converter swatch 色彩 顏色 調色 對比度 無障礙 轉換 色板",
    "native": false
  },
  {
    "tag": "module.colorpalette",
    "en": "Color Palette",
    "zh": "色彩調色板",
    "glyph": "",
    "keywords": "color palette scheme hex rgb hsl complementary analogous triadic tetradic monochromatic shades tints swatch css json 色彩 調色板 配色 顏色 色板 十六進位 互補色 類似色 三等分色 單色系 匯出",
    "native": false
  },
  {
    "tag": "module.colormix",
    "en": "Colour Mixer",
    "zh": "混色器",
    "glyph": "",
    "keywords": "color colour mix blend gradient srgb linear hsl ratio swatch hex css steps 顏色 混色 漸變 漸層 色板 比例 調色",
    "native": false
  },
  {
    "tag": "module.colorname",
    "en": "Named Colors",
    "zh": "命名色彩",
    "glyph": "",
    "keywords": "color colour name named css x11 hex rgb nearest swatch palette 色彩 顏色 命名色 具名色 十六進位 網頁色",
    "native": false
  },
  {
    "tag": "module.colorblind",
    "en": "Color Blindness Sim",
    "zh": "色盲模擬",
    "glyph": "",
    "keywords": "color blindness colour blind cvd protanopia deuteranopia tritanopia achromatopsia grayscale accessibility contrast hex rgb 色盲 色覺 色弱 紅綠色盲 灰階 無障礙 對比 顏色 模擬",
    "native": false
  },
  {
    "tag": "module.contrastgrid",
    "en": "Contrast Grid",
    "zh": "對比度網格",
    "glyph": "",
    "keywords": "contrast wcag accessibility ratio color colour hex rgb aa aaa a11y 對比度 無障礙 顏色 色彩 可讀性",
    "native": false
  },
  {
    "tag": "module.gradient",
    "en": "Gradient Generator",
    "zh": "漸變產生器",
    "glyph": "",
    "keywords": "gradient css linear radial colour color stops hex angle 漸變 顏色 色標 線性 放射 CSS 十六進位",
    "native": false
  },
  {
    "tag": "module.cssunits",
    "en": "CSS Unit Converter",
    "zh": "CSS 單位換算",
    "glyph": "",
    "keywords": "css units px em rem pt vw vh percent convert web design root font size 單位 換算 網頁 設計 字級",
    "native": false
  },
  {
    "tag": "module.notes",
    "en": "Scratchpad",
    "zh": "便箋",
    "glyph": "",
    "keywords": "notes scratchpad memo jot text save persistent 便箋 筆記 記事 備忘 草稿 儲存",
    "native": false
  },
  {
    "tag": "module.habittracker",
    "en": "Habit Tracker",
    "zh": "習慣追蹤器",
    "glyph": "",
    "keywords": "habit tracker streak daily routine checklist weekly goals 習慣 追蹤 打卡 連續 每日 例行 目標 週",
    "native": false
  },
  {
    "tag": "module.namegen",
    "en": "Name Generator",
    "zh": "名稱產生器",
    "glyph": "",
    "keywords": "name generator username project company startup fantasy band slug random codename 名稱 產生器 隨機 用戶名 專案 公司 初創 奇幻 樂隊 代號",
    "native": false
  },
  {
    "tag": "module.recyclebin",
    "en": "Recycle Bin Manager",
    "zh": "回收筒管理",
    "glyph": "",
    "keywords": "recycle bin trash empty delete free space cleanup storage 回收筒 垃圾筒 清空 刪除 釋放空間 清理",
    "native": false
  },
  {
    "tag": "module.filesplit",
    "en": "File Split & Join",
    "zh": "檔案切割／合併",
    "glyph": "",
    "keywords": "split join file parts chunk merge concatenate 001 002 sha256 切割 合併 分割 檔案 部件 分片 併合 重組",
    "native": false
  },
  {
    "tag": "module.tweaks.appearance-personalisation",
    "en": "Appearance & Personalisation",
    "zh": "外觀與個人化",
    "glyph": "",
    "keywords": "Appearance & Personalisation 外觀與個人化 tweak tweaks 調校 windows Accent colour 主題色 Accent colour on Start & taskbar 開始與工作列顯示主題色 Accent colour on title bars & borders 標題列與邊框顯示主題色 Translucent selection rectangle 半透明選取框 Show seconds in clock 時鐘顯示秒數 Dark mode 深色模式 Show window contents while dragging 拖曳時顯示視窗內容 Drop shadows for icon labels 圖示標籤陰影 Open colour settings 開啟色彩設定 Snap layout flyout on hover 懸停顯示貼齊版面 Start menu layout 開始功能表版面 Taskbar animations 工作列動畫 Combine taskbar buttons 合併工作列按鈕 Transparency effects 透明效果 Disable wallpaper JPEG compression 停用桌布 JPEG 壓縮 Window min/max animations 視窗縮放動畫",
    "native": false
  },
  {
    "tag": "module.tweaks.apps-startup",
    "en": "Apps & Startup",
    "zh": "應用程式與啟動",
    "glyph": "",
    "keywords": "Apps & Startup 應用程式與啟動 tweak tweaks 調校 windows Analyze component store 分析元件存放區 Open Default apps settings 開啟預設應用程式設定 Open Installed apps settings 開啟已安裝應用程式設定 Kill 'Not Responding' apps 結束無回應嘅應用程式 List auto-start programs 列出自動啟動程式 Restart File Explorer 重新啟動檔案總管 Restart Print Spooler 重新啟動列印多工緩衝處理器 Open Startup apps settings 開啟開機應用程式設定 Update Microsoft Store apps 更新 Microsoft Store 應用程式 Top processes by memory 記憶體用量最高嘅程序 List installed apps 列出已安裝應用程式 Update all apps 更新所有應用程式 List available app updates 列出可更新嘅應用程式",
    "native": false
  },
  {
    "tag": "module.tweaks.browser-control",
    "en": "Browser Control",
    "zh": "瀏覽器控制",
    "glyph": "",
    "keywords": "Browser Control 瀏覽器控制 tweak tweaks 調校 windows Open in App mode 用應用程式模式開 Open Clear data dialog 開清除資料對話框 Launch with GPU disabled 停用 GPU 啟動 Open Downloads page 開下載頁 Open Extensions page 開擴充功能頁 Open experimental flags 開實驗性功能 Open DNS cache page 開 DNS 快取頁 Open Guest window 開訪客視窗 Open History page 開瀏覽紀錄頁 Open Incognito window 開無痕視窗 Open in Kiosk mode 用 Kiosk 全螢幕模式 Launch Chrome 啟動 Chrome Open a new window 開新視窗 Launch without extensions 停用擴充功能啟動 Open URL in new window 喺新視窗開網址 Open specific profile 開指定設定檔 Launch with proxy server 用代理伺服器啟動 Launch in safe diagnostic mode 用安全診斷模式啟動 Open Settings page 開設定頁 Open Version info 開版本資料 Launch site in app mode 用應用程式模式開網站 Clear browsing data 清除瀏覽資料 Open downloads 開下載項目 Open extensions page 開擴充功能頁 Open favorites manager 開我的最愛管理 Open Edge experiments 開實驗功能頁 Open GPU diagnostics 開 GPU 診斷 Open IE mode settings 開 IE 模式設定 Open InPrivate window 開無痕視窗 Launch in kiosk mode 用自助服務模式開啟 Launch Microsoft Edge 開啟 Microsoft Edge Open network logger 開網路紀錄工具 Open URL in new window 喺新視窗開網址 Open password settings 開密碼設定 Open privacy settings 開私隱設定 Open profile settings 開設定檔設定 Open default apps settings 開預設應用程式設定 Open Edge settings 開 Edge 設定 Open startup boost setting 開啟動加速設定 Show Edge version 睇 Edge 版本 Chrome: address autofill Chrome：地址自動填入 Chrome: background mode Chrome：背景執行模式 Chrome: bookmark bar Chrome：書籤列 Chrome: default browser prompt Chrome：預設瀏覽器提示 Chrome: set homepage policy Chrome：設定主頁政策 Chrome: incognito availability Chrome：無痕模式可用性 Chrome: usage metrics reporting Chrome：使用統計報告 Chrome: set new tab page Chrome：設定新分頁版面 Chrome: password manager Chrome：密碼管理員 Chrome: Safe Browsing Chrome：安全瀏覽 Edge: background mode Edge：背景執行模式 Edge: default browser prompt Edge：預設瀏覽器提示 Edge: set homepage policy Edge：設定主頁政策 Edge: hubs sidebar Edge：側邊欄 Edge: InPrivate availability Edge：InPrivate 可用性 Edge: password manager Edge：密碼管理員 Edge: web data personalization Edge：個人化內容 Edge: shopping assistant Edge：購物助手 Edge: SmartScreen Edge：SmartScreen Edge: startup boost Edge：啟動加速 Backup Chrome bookmarks 備份 Chrome 書籤 Backup Edge bookmarks 備份 Edge 書籤 Chrome profile disk usage Chrome 設定檔磁碟用量 Clear Chrome cache 清除 Chrome 快取 Clear Chrome cookies 清除 Chrome Cookies Clear Edge cache 清除 Edge 快取 Edge profile disk usage Edge 設定檔磁碟用量 Kill all Chrome processes 結束所有 Chrome 程序 Kill all Edge processes 結束所有 Edge 程序 List Chrome profiles 列出 Chrome 設定檔 List Edge profiles 列出 Edge 設定檔 List installed browsers 列出已安裝瀏覽器 Open Chrome user data folder 開啟 Chrome 用戶資料夾 Open Default apps 開啟預設應用程式 Open downloads folder 開啟下載資料夾 Open Edge download folder 開啟 Edge 下載資料夾 Open Edge user data folder 開啟 Edge 用戶資料夾 Reset Chrome Default profile 重設 Chrome 預設設定檔 Set default browser 設定預設瀏覽器 Show Chrome version 顯示 Chrome 版本 Edge efficiency mode policy Edge 效率模式政策 Edge startup behavior policy Edge 啟動行為政策 Flush DNS cache 清除 DNS 快取 List installed PWAs 列出已安裝 PWA List saved Wi-Fi profiles 列出已儲存 Wi-Fi Browser task manager note 瀏覽器工作管理員提示 DevTools shortcut note 開發人員工具捷徑提示 Capture webpage note 擷取網頁提示 Open a blank page 開空白頁 Open Chrome Web Store 開 Chrome 網上商店 Open Credential Manager 開認證管理員 Open Edge Collections 開 Edge 收藏集 Open Edge favorites 開 Edge 我的最愛 Open Edge settings 開 Edge 設定 Open Edge site permissions 開 Edge 網站權限 Open Edge startup pages 開 Edge 啟動頁設定 Open Internet Options 開網際網路選項 Open proxy settings 開 Proxy 設定 Open URL in default browser 喺預設瀏覽器開網址 Reset IE / WinINET settings 重設 IE / WinINET 設定",
    "native": false
  },
  {
    "tag": "module.tweaks.cleanup-storage",
    "en": "Cleanup & Storage",
    "zh": "清理與儲存",
    "glyph": "",
    "keywords": "Cleanup & Storage 清理與儲存 tweak tweaks 調校 windows Clear delivery optimisation cache 清除傳遞最佳化快取 Run Disk Cleanup 執行磁碟清理 DISM component cleanup DISM 元件清理 Empty clipboard 清空剪貼簿 Clear Windows event logs 清除 Windows 事件記錄 Clear Prefetch 清除 Prefetch Empty Recycle Bin 清空資源回收筒 Open Storage Sense settings 開啟儲存空間感知設定 Reset Microsoft Store cache 重設 Microsoft Store 快取 Clear thumbnail cache 清除縮圖快取 Clear user temp files 清除使用者暫存檔 Clear Windows Temp 清除 Windows 暫存 Clear Windows Update cache 清除 Windows Update 快取",
    "native": false
  },
  {
    "tag": "module.tweaks.debloat-annoyances",
    "en": "Debloat & Annoyances",
    "zh": "去煩擾",
    "glyph": "",
    "keywords": "Debloat & Annoyances 去煩擾 tweak tweaks 調校 windows Turn off Bing in Start search 熄開始搜尋嘅 Bing Turn off Click to Do 熄 Click to Do Disable Windows consumer features 停用 Windows 消費者功能 Turn off general content suggestions 熄一般內容建議 Remap the Copilot key to do nothing 將 Copilot 鍵改成乜都唔做 Turn off Windows Copilot 熄 Windows Copilot Turn off Cortana above lock screen 熄鎖屏上面嘅 Cortana Turn off Cortana consent in search 熄搜尋度嘅 Cortana 同意 Turn off Cortana 熄 Cortana Turn off web results in Search (policy) 用原則熄搜尋嘅網上結果 Turn off Edge Collections 熄 Edge Collections Turn off Edge Copilot page context 熄 Edge Copilot 讀取頁面內容 Turn off Edge Copilot sidebar 熄 Edge Copilot 側欄 Turn off Edge shopping assistant 熄 Edge 購物助手 Hide File Explorer sync-provider ads 收埋檔案總管嘅 sync 推廣 Turn off lock-screen fun facts & tips 熄鎖機畫面趣聞同貼士 Turn off lock-screen Spotlight tips 熄鎖機畫面 Spotlight 提示 Stop silently installing suggested apps 唔好靜雞雞裝建議 App Turn off Recall snapshots 熄 Recall 截圖記錄 Remove the Copilot app 移除 Copilot app Turn off \"Get even more out of Windows\" nag 熄「再進一步善用 Windows」嘅纏擾 Turn off search box web suggestions 熄搜尋框嘅網上建議 Turn off Search Highlights 熄搜尋焦點 (Search Highlights) Turn off web search in Search 熄搜尋度嘅網上搜尋 Hide the Settings homepage 隱藏設定首頁 Hide suggested content in Settings (1) 收埋設定入面嘅建議內容 (1) Hide suggested content in Settings (2) 收埋設定入面嘅建議內容 (2) Hide suggested content in Settings (3) 收埋設定入面嘅建議內容 (3) Turn off tips & suggestions (soft landing) 熄提示同建議（soft landing） Turn off account notifications in Start 熄開始選單嘅帳戶通知 Reduce Start \"recommended\" suggestions 減少開始選單「建議」推介 Turn off Start menu app suggestions 熄開始選單嘅 App 建議 Skip welcome experience after updates 更新後跳過歡迎畫面 Disable the Widgets board 停用小工具面板 Turn off Windows tips notifications 熄 Windows 貼士通知",
    "native": false
  },
  {
    "tag": "module.tweaks.developer-terminal",
    "en": "Developer & Terminal",
    "zh": "開發與終端機",
    "glyph": "",
    "keywords": "Developer & Terminal 開發與終端機 tweak tweaks 調校 windows Base64 encode text Base64 編碼文字 Claude CLI version Claude CLI 版本 Codex CLI version Codex CLI 版本 Curl a URL 用 curl 抓網址 GitHub auth status GitHub 登入狀態 GitHub CLI version GitHub CLI 版本 List Git aliases 列出 Git 別名 List global Git config 列出全域 Git 設定 Git version Git 版本 jq version jq 版本 New GUID 產生新 GUID Open Git Bash 開 Git Bash Open Windows Terminal 開 Windows Terminal Open VS Code here 喺呢度開 VS Code OpenCode CLI version OpenCode CLI 版本 OpenSSL version OpenSSL 版本 SHA256 of clipboard text 剪貼簿文字 SHA256 Generate SSH key (Ed25519) 產生 SSH 金鑰（Ed25519） List WSL distros 列出 WSL 發行版 WSL status WSL 狀態 Prune build cache 清理建置快取 Compose services Compose 服務 Prune containers 清理容器 List contexts 列出 context Image history help 映像檔歷史說明 Prune images 清理映像檔 List images 列出映像檔 Docker info Docker 資訊 Container logs help 容器日誌說明 List networks 列出網路 List running containers 列出執行緊嘅容器 List all containers 列出所有容器 Restart Docker Desktop 重啟 Docker Desktop Container stats 容器統計 Disk usage 磁碟用量 Prune system 清理系統 Container processes help 容器程序說明 Docker version Docker 版本 List volumes 列出卷 Prune volumes 清理卷 List active TCP connections 列出已建立嘅 TCP 連線 Show DNS client cache 顯示 DNS 客戶端快取 Echo a specific env var 顯示指定環境變數 Open Environment Variables editor 開啟環境變數編輯器 Find process by port 用端口搵進程 Show hostname 顯示主機名 Show IP configuration 顯示 IP 設定 Kill process by name 用名稱終止進程 Kill process by PID 用 PID 終止進程 List environment variables 列出環境變數 List listening TCP ports 列出監聽中嘅 TCP 端口 List local administrators 列出本機管理員 Show PATH per-line 逐行顯示 PATH Refresh environment 重新整理環境變數 List scheduled reboot tasks 列出排程重啟工作 Open System Properties (Advanced) 開啟系統內容(進階) Top processes by CPU 按 CPU 排名嘅進程 Show system uptime 顯示系統運行時間 Show current user SID 顯示目前用戶 SID Show whoami /all 顯示 whoami /all Deno version Deno 版本 .NET info .NET 資訊 .NET runtimes .NET 執行階段 .NET SDKs .NET SDK 清單 NuGet cache folders NuGet 快取資料夾 Go version Go 版本 Java version Java 版本 Node.js version Node.js 版本 Clear npm cache 清除 npm 快取 Verify npm cache 驗證 npm 快取 Global npm packages 全域 npm 套件 Outdated global npm 過時嘅全域 npm npm version npm 版本 Installed pip packages 已安裝嘅 pip 套件 Outdated pip packages 過時嘅 pip 套件 pip version pip 版本 List Python installs 列出 Python 安裝 Python version Python 版本 Rust compiler version Rust 編譯器版本 Locate node and python 搵 node 同 python Guided dev environment check 引導式開發環境檢查 Show configuration 顯示組態 Download only 只下載 Export installed list 匯出已安裝清單 Import package list 匯入套件清單 Install by ID 按 ID 安裝 List installed 列出已安裝 List pins 列出釘選 List with versions 列出連版本 Pin a package 釘選套件 Repair a package 修復套件 Search a package 搜尋套件 Search by tag 按標籤搜尋 Check winget version 檢查 winget 版本 Show package info 顯示套件資料 Show package versions 顯示套件版本 List sources 列出來源 Uninstall a package 解除安裝套件 Update sources 更新來源 List upgradable 列出可更新 Upgrade all apps 更新所有應用程式 Validate a manifest 驗證資訊清單",
    "native": false
  },
  {
    "tag": "module.tweaks.encryption-vault",
    "en": "Encryption & Vault",
    "zh": "加密與保險庫",
    "glyph": "",
    "keywords": "Encryption & Vault 加密與保險庫 tweak tweaks 調校 windows Add password protector 加入密碼保護器 Backup recovery key to AD 備份還原金鑰到 AD Backup recovery key to file 備份還原金鑰到檔案 Change volume password 更改磁碟區密碼 Open BitLocker control panel 開 BitLocker 控制台 Enable auto-unlock 啟用自動解鎖 Enable BitLocker on a drive 為磁碟啟用 BitLocker Force recovery on next boot 下次開機逼出還原畫面 Get-Tpm details Get-Tpm 詳情 Get-BitLockerVolume Get-BitLockerVolume List encrypted volumes 列出已加密磁碟區 Lock a drive 鎖定磁碟 Pause encryption/decryption 暫停加密／解密 Repair a damaged drive (repair-bde) 修復爛咗嘅磁碟 (repair-bde) Resume encryption/decryption 繼續加密／解密 Resume protection 恢復保護 Show key protectors 顯示金鑰保護器 BitLocker status (all) BitLocker 狀態（全部） BitLocker status (C:) BitLocker 狀態（C:） Suspend for 1 reboot 暫停 1 次重開機 TPM status (manage-bde) TPM 狀態（manage-bde） Turn off BitLocker (decrypt) 關閉 BitLocker（解密） Unlock with password 用密碼解鎖 List Certificate Stores 列出憑證庫 Check a Certificate Thumbprint 檢查憑證指紋 Show Code-Signing Certificates 顯示程式碼簽署憑證 Export a Certificate (Note) 匯出憑證（提示） Group Policy Cert Settings (Note) 群組原則憑證設定（提示） KeyStore Location (Note) 金鑰庫位置（提示） List Intermediate CA Certificates 列出中繼 CA 憑證 List Expiring Certificates 列出即將到期憑證 List All My-Store Certificate Fields 列出個人憑證庫詳細欄位 List Personal Certificates 列出個人憑證 List Trusted Root CAs 列出受信任根 CA List Windows Credentials 列出 Windows 認證 Open Manage User Certificates 開啟管理使用者憑證 Open Certificate Manager (Machine) 開啟憑證管理員（電腦） Open Certificate Manager (User) 開啟憑證管理員（使用者） Open Credential Manager 開啟認證管理員 Open Windows Hello Settings 開啟 Windows Hello 設定 Count Root Store Certificates 統計根憑證庫數量 List Smart Card Readers (Note) 列出智能卡讀卡機（提示） Show TPM Information 顯示 TPM 資訊 Add scan exclusion (C:\\Temp) 新增掃描排除 (C:\\Temp) ASR: all rules to Audit mode ASR：全部規則設稽核 List ASR rules (with names) 列出 ASR 規則（連名） ASR: block LSASS theft (Audit) ASR：封鎖 LSASS 竊取（稽核） ASR: block LSASS theft (Disabled) ASR：封鎖 LSASS 竊取（停用） ASR: block LSASS theft (Enabled) ASR：封鎖 LSASS 竊取（啟用） ASR: block LSASS theft (Warn) ASR：封鎖 LSASS 竊取（警告） Block an app (note) 封鎖應用程式 (說明) Show blocked connections (note) 顯示被擋連線 (說明) Cloud protection level (policy) 雲端保護等級 (政策) Enable controlled folder access 啟用受控資料夾存取 Enable firewall logging 啟用防火牆記錄 Turn firewall off 熄防火牆 Turn firewall on 開防火牆 List firewall rules 列出防火牆規則 Firewall status 防火牆狀態 Full scan 完整掃描 List exclusions 列出排除清單 Defender preferences Defender 偏好設定 Quick scan 快速掃描 Remove scan exclusion (C:\\Temp) 移除掃描排除 (C:\\Temp) Reset firewall to defaults 重設防火牆做預設 Set cloud protection level (high) 設定雲端保護等級 (高) Defender status Defender 狀態 Threat history 威脅記錄 Update signatures 更新特徵碼 Show Defender version 顯示 Defender 版本 Show EFS recovery agent 顯示 EFS 復原代理 Backup EFS certificate 備份 EFS 憑證 Show cipher help 顯示 cipher 說明 Create new EFS key 建立新 EFS 金鑰 Decrypt Documents folder 解密文件資料夾 Decrypt a folder (EFS) 解密資料夾 (EFS) Display folder encryption state 顯示資料夾加密狀態 Encrypt Documents folder 加密文件資料夾 Encrypt a folder (EFS) 加密資料夾 (EFS) Encrypt folder & subfolders 加密資料夾及子資料夾 List encrypted files 列出已加密檔案 Open EFS cert manager 開啟 EFS 憑證管理員 Manage EFS (rekeywiz) 管理 EFS (rekeywiz) Reset EFS keys (rekey) 重設 EFS 金鑰 Secure-delete a file 安全刪除檔案 Show EFS certificates 顯示 EFS 憑證 Show file encryption state 顯示檔案加密狀態 Show state of subfolders 顯示子資料夾狀態 Wipe free space on C: 抹除 C: 可用空間 Wipe free space on a drive 抹除磁碟可用空間 Auto-mount devices 自動掛載裝置 Start background task 啟動背景工作 Backup volume header 備份磁碟區檔頭 Snapshot raw header (first 131072 bytes) 快照原始檔頭（首 131072 位元組） Open settings / benchmark 打開設定／效能測試 Change container password 更改容器密碼 Create new volume 建立新磁碟區 Dismount all volumes 卸載所有磁碟區 Dismount drive letter 卸載指定磁碟機 Open vault guide 打開保險庫指南 Explore mounted volume 瀏覽已掛載磁碟區 Force dismount all 強制卸載全部 Launch WinForge Vault 啟動 WinForge 保險庫 Hidden volume wizard 隱藏磁碟區精靈 Keyfile generator 金鑰檔產生器 List mounted drives 列出已掛載磁碟 Open mount dialog 打開掛載對話框 Mount favorites 掛載最愛磁碟區 Mount with keyfile + PIM 用鎖匙檔加 PIM 掛載 Mount read-only 唯讀掛載 Mount as removable media 以可移除媒體掛載 Partition / device encryption 分割區／裝置加密 Restore volume header 還原磁碟區檔頭 Restore raw header snapshot 還原原始檔頭快照 Mount with PIM 以 PIM 掛載 System encryption tools 系統加密工具 Traveler disk setup 隨身碟設定 Show engine path 顯示引擎路徑 Volume Creation Wizard 磁碟區建立精靈 Wipe password cache 清除密碼快取",
    "native": false
  },
  {
    "tag": "module.tweaks.file-explorer",
    "en": "File Explorer",
    "zh": "檔案總管",
    "glyph": "",
    "keywords": "File Explorer 檔案總管 tweak tweaks 調校 windows Item check boxes 項目核取方塊 Classic right-click menu 經典右鍵選單 Confirm delete dialog 刪除確認對話框 Open Folder Options 開啟資料夾選項 Full path in title bar 標題列顯示完整路徑 Open File Explorer to 檔案總管開啟到 Expand to current folder 導覽窗格展開至目前資料夾 Restart File Explorer 重新啟動檔案總管 Launch folder windows in a separate process 資料夾視窗用獨立程序開啟 Show file extensions 顯示副檔名 Show frequent folders 顯示常用資料夾 Show hidden files 顯示隱藏檔案 Show recent files in Quick Access 快速存取顯示最近檔案 Show protected OS files 顯示受保護系統檔案",
    "native": false
  },
  {
    "tag": "module.tweaks.launcher-elevation",
    "en": "Launcher & Elevation",
    "zh": "啟動器與提權",
    "glyph": "",
    "keywords": "Launcher & Elevation 啟動器與提權 tweak tweaks 調校 windows Create no-UAC elevated launcher 建立免 UAC 提權啟動器 Open Task Scheduler 開啟工作排程器 Remove the elevated launcher 移除提權啟動器 Run WinForge elevated now 立即以管理員運行 Elevation status 提權狀態",
    "native": false
  },
  {
    "tag": "module.tweaks.maintenance-diagnostics",
    "en": "Maintenance & Diagnostics",
    "zh": "維護與診斷",
    "glyph": "",
    "keywords": "Maintenance & Diagnostics 維護與診斷 tweak tweaks 調校 windows Battery report 電池報告 Clear Application event log 清除應用程式記錄 Clear System event log 清除系統事件記錄 Clear Windows Update cache 清除更新快取 Computer info summary 電腦資訊摘要 Create restore point 建立還原點 Query 8.3 name creation 查詢 8.3 短檔名建立 Analyze component store 分析元件儲存區 Schedule full check & repair 排程完整檢查同修復 Check disk (read-only) 檢查磁碟（唯讀） Clean up component store 清理元件儲存區 Open Optimize Drives 開最佳化磁碟機 Query dirty bit 查詢污染位元 Volume free space 磁碟區可用空間 Filesystem info 檔案系統資訊 List disks 列出磁碟 List partitions 列出分割區 List volumes 列出磁碟區 Largest folders in Users Users 最大嘅資料夾 Open Disk Management 開磁碟管理 Optimize / defrag C: 最佳化／重組 C: Physical disk health 實體磁碟健康 Storage reliability counters 儲存可靠性計數器 Scan volume for errors 掃描磁碟區錯誤 Spot-fix volume errors 即時修復磁碟區錯誤 ReTrim SSD 重新 TRIM SSD List shadow copies 列出陰影複本 Shadow storage usage 陰影儲存用量 DISM check health DISM 快速檢查健康 DISM restore health DISM 修復健康 DISM scan health DISM 深入掃描健康 Show DNS cache 顯示 DNS 快取 List audio devices 列出音效裝置 Open Device Manager 開啟裝置管理員 List disk drives 列出磁碟機 List display adapters 列出顯示卡 Detailed driver query 詳細驅動程式清單 Export driver list to file 匯出驅動清單去檔案 GPU information 顯示卡資料 List third-party drivers 列出第三方驅動程式 Monitor information 顯示器資料 List network adapters 列出網絡卡 List printers 列出打印機 Count devices with problems 數有問題嘅裝置 Devices with errors 有錯誤嘅裝置 Restart active network adapters 重啟使用緊嘅網絡卡 Scan for hardware changes 掃描硬件變更 Signed drivers (top 30) 已簽署驅動（頭 30 個） Open Sound settings 開啟音效設定 List USB devices 列出 USB 裝置 Open DirectX Diagnostics 開 DirectX 診斷工具 Enable System Protection 開啟系統保護 Energy efficiency report 電源效率報告 Export System event log 匯出系統事件記錄 Flush + restart spooler queue 清空並重啟列印佇列 Last wake source 上次喚醒嘅來源 List automatic services 列出自動啟動嘅服務 Auto services that are stopped 自動但已停咗嘅服務 List startup programs 列出開機自動啟動程式 List installed updates 列出已安裝更新 List restore points 列出還原點 List running services 列出運行緊嘅服務 List scheduled tasks 列出排程工作 Open System Information 開系統資訊工具 Event Viewer 事件檢視器 Open System Information 開系統資訊 Open Services 開啟服務管理員 Open Startup apps settings 開啟開機應用程式設定 Open Task Scheduler 開啟工作排程器 Open Windows Update settings 開 Windows Update 設定 Check pending reboot 檢查待重啟 Open Performance Monitor 開效能監視器 Active power requests 目前嘅電源請求 Query a service 查詢服務狀態 Recent critical & error events 近期嚴重同錯誤事件 Open Reliability Monitor 開可靠性監視器 Reset Windows Update services 重置 Windows Update 服務 Open Resource Monitor 開資源監視器 Restart Windows Audio 重啟 Windows 音效服務 Restart BITS 重啟 BITS 背景傳輸服務 Restart DNS Client 重啟 DNS 用戶端服務 Restart Explorer 重啟檔案總管 Restart Windows Search 重啟 Windows 搜尋服務 Restart Print Spooler 重啟列印多工緩衝處理器 Restart Windows Time + resync 重啟 Windows 時間並同步 Run a scheduled task 執行排程工作 Set DiagTrack to Manual 將 DiagTrack 設為手動啟動 Run System File Checker 執行系統檔案檢查 (SFC) Verify system files only 淨係驗證系統檔案 Sleep study report 睡眠研究報告 Start DiagTrack 啟動 DiagTrack 服務 Stop DiagTrack 停止 DiagTrack 服務 System power report 系統電源報告 System information 系統資訊 Test internet connectivity 測試上網連線 Thermal zone temperature 熱區溫度 Top processes by memory 記憶體用得最多嘅程序 Uptime and last boot 開機時間同上次啟動 Devices armed to wake 可以喚醒系統嘅裝置 Download Windows Updates 下載 Windows 更新 Install Windows Updates 安裝 Windows 更新 Scan for Windows Updates 掃描 Windows 更新",
    "native": false
  },
  {
    "tag": "module.tweaks.network-internet",
    "en": "Network & Internet",
    "zh": "網絡與互聯網",
    "glyph": "",
    "keywords": "Network & Internet 網絡與互聯網 tweak tweaks 調校 windows Show active connections 顯示使用中連線 Reset DNS to automatic DNS 還原自動 Set DNS to Cloudflare (1.1.1.1) 設 DNS 為 Cloudflare Set DNS to Google (8.8.8.8) 設 DNS 為 Google Flush ARP cache 清除 ARP 快取 Flush DNS cache 清除 DNS 快取 Show full IP configuration 顯示完整 IP 設定 Ping test (Cloudflare) Ping 測試 Show public IP 顯示公共 IP Release IP address 釋放 IP 位址 Renew IP address 更新 IP 位址 Reset TCP/IP stack 重設 TCP/IP Reset Winsock catalog 重設 Winsock Show saved Wi-Fi profiles 顯示已儲存 Wi-Fi",
    "native": false
  },
  {
    "tag": "module.tweaks.network-pro",
    "en": "Network Pro",
    "zh": "網絡進階",
    "glyph": "",
    "keywords": "Network Pro 網絡進階 tweak tweaks 調校 windows Advanced properties 進階屬性 Adapter bindings 網絡卡綁定 Connection profile 連線設定檔 Disable an adapter 停用網絡卡 Disable IPv6 on adapter 停用網絡卡 IPv6 DNS client settings DNS 客戶端設定 Enable an adapter 啟用網絡卡 Show MAC addresses 顯示 MAC 地址 IP addresses IP 地址 IP configuration IP 設定 Link speed 連線速度 List network adapters 列出網絡卡 Adapter power management 網絡卡電源管理 Rename an adapter 重新命名網絡卡 Restart an adapter 重啟網絡卡 Routing table 路由表 Reset adapter to DHCP 重設為 DHCP Set adapter MTU 設定網絡卡 MTU Adapter statistics 網絡卡統計 Detailed statistics 詳細統計 Wake-on-LAN setting 網絡喚醒設定 Network adapter usage 網絡卡用量 Listening ports with process 監聽埠連程序 Latency to multiple hosts 多主機延遲 Show network category 顯示網絡類別 Active connections (netstat -ano) 活動連線 (netstat -ano) Routing table (netstat -rn) 路由表 (netstat -rn) DNS lookup (nslookup) DNS 查詢 (nslookup) Path ping to 1.1.1.1 Path ping 去 1.1.1.1 Ping 1.1.1.1 Ping 1.1.1.1 Ping default gateway Ping 預設閘道 Reset WinHTTP proxy 重設 WinHTTP 代理 Open proxy settings 開啟代理設定 Show WinHTTP proxy 顯示 WinHTTP 代理 TCP connections by state 按狀態列 TCP 連線 Telnet port test (note) Telnet 埠測試 (備註) Test-Connection (4 pings) Test-Connection (4 次 ping) Test-NetConnection (ping) Test-NetConnection (ping) Test TCP port 443 測試 TCP 埠 443 Test-NetConnection trace route Test-NetConnection 追蹤路由 Trace route to 1.1.1.1 追蹤路由去 1.1.1.1 Allow ping (ICMP echo) 允許 Ping（ICMP） Block an app inbound 封鎖應用程式入站 Count enabled rules 統計已啟用規則數量 Set default inbound to block 設定預設入站為封鎖 Enable firewall logging 啟用防火牆記錄 Enable Remote Desktop rule 啟用遠端桌面規則 Enable a rule group (Remote Assistance) 啟用規則群組（遠端協助） Export firewall policy to file 匯出防火牆政策到檔案 List blocked program rules 列出已封鎖程式規則 List rules grouped by group 依群組列出規則 List enabled inbound rules 列出已啟用嘅入站規則 List enabled outbound rules 列出已啟用嘅出站規則 Reset firewall to defaults 重設防火牆做預設值 Restore default policy file 從預設政策檔還原 Show all profiles state 顯示所有設定檔狀態 Show current active profile 顯示目前作用中設定檔 Show firewall log path 顯示防火牆記錄路徑 Show notification setting 顯示通知設定 Turn firewall off (all profiles) 關閉防火牆（所有設定檔） Turn firewall on (all profiles) 開啟防火牆（所有設定檔） Add persistent route 新增永久路由 Show ARP table 顯示 ARP 表 Clear DNS client cache 清 DNS 用戶端快取 Show DNS cache 顯示 DNS 快取 Flush DNS cache 清除 DNS 快取 Get DNS servers 查 DNS 伺服器 Full IP configuration 完整 IP 設定 Test DNS lookup 測試 DNS 查詢 Show public IP 顯示對外 IP Re-register DNS 重新註冊 DNS Release IP address 釋放 IP 位址 Renew IP address 更新 IP 位址 Reset DNS to DHCP DNS 還原做 DHCP Reset TCP/IP stack 重設 TCP/IP 堆疊 Reset Winsock catalog 重設 Winsock 目錄 Resolve a hostname 解析網域名稱 Print routing table 顯示路由表 Use Cloudflare DNS 用 Cloudflare DNS Use Google DNS 用 Google DNS Use Quad9 DNS 用 Quad9 DNS Block a network 封鎖一個網絡 Connect to a profile 連接到設定檔 Disconnect Wi-Fi 中斷 Wi-Fi 連線 Export profiles to folder 匯出設定檔到資料夾 Forget a network 忘記一個網絡 List SSIDs in range 列出範圍內 SSID Refresh networks 重新整理網絡 Show all profiles (details) 顯示所有設定檔（詳情） Show auto-config setting 顯示自動設定狀態 Show wireless capabilities 顯示無線功能 Show Wi-Fi drivers 顯示 Wi-Fi 驅動程式 Show network filters 顯示網絡篩選 Show hosted network 顯示主機網絡 Show wireless interfaces 顯示無線網絡介面 Scan networks (with BSSID) 掃描網絡（含 BSSID） Show Wi-Fi password 顯示 Wi-Fi 密碼 Show saved Wi-Fi profiles 顯示已儲存嘅 Wi-Fi 設定檔 Show MAC randomization 顯示 MAC 隨機化 Show signal strength 顯示訊號強度 Generate WLAN report 產生 WLAN 報告",
    "native": false
  },
  {
    "tag": "module.tweaks.performance-power",
    "en": "Performance & Power",
    "zh": "效能與電源",
    "glyph": "",
    "keywords": "Performance & Power 效能與電源 tweak tweaks 調校 windows Activate Balanced plan 啟用平衡電源計劃 Clear page file at shutdown 關機時清除分頁檔 Fast startup 快速啟動 Game DVR background recording 遊戲 DVR 背景錄製 Game Mode 遊戲模式 Turn off hibernation 熄咗休眠 Turn on hibernation 開啟休眠 Activate High performance plan 啟用高效能電源計劃 Menu show delay 選單顯示延遲 Disable power throttling 停用電源節流 No startup app delay 取消啟動程式延遲 Add Ultimate Performance plan 新增極致效能電源計劃 Visual effects mode 視覺效果模式",
    "native": false
  },
  {
    "tag": "module.tweaks.power-tools",
    "en": "Power Tools",
    "zh": "進階工具",
    "glyph": "",
    "keywords": "Power Tools 進階工具 tweak tweaks 調校 windows Show Windows activation status 顯示 Windows 啟用狀態 Generate battery report 產生電池報告 Check system drive 檢查系統磁碟 DISM restore health DISM 還原健康 Edit the hosts file 編輯 hosts 檔案 Generate energy report 產生能源報告 Lock the workstation 鎖定電腦 Open System Information 開啟系統資訊 Open Reliability Monitor 開啟可靠性監視器 Restart now 即刻重新啟動 System File Checker (SFC) 系統檔案檢查 (SFC) Shut down now 即刻關機 Sign out 登出 Sleep now 即刻睡眠",
    "native": false
  },
  {
    "tag": "module.tweaks.privacy-telemetry",
    "en": "Privacy & Telemetry",
    "zh": "私隱與遙測",
    "glyph": "",
    "keywords": "Privacy & Telemetry 私隱與遙測 tweak tweaks 調校 windows Activity history 活動記錄 Personalised ads (advertising ID) 個人化廣告（廣告識別碼） App launch tracking App 啟動追蹤 Never ask for feedback 永不索取意見 Inking & typing personalisation 手寫與輸入個人化 Block websites reading my language list 阻止網站讀取語言清單 Location access 位置存取 Online speech recognition 線上語音辨識 Suggested content in Settings 設定內嘅建議內容 Windows welcome tips Windows 歡迎提示 Suggestions in Start 開始功能表建議 Tailored experiences 量身打造嘅體驗 Diagnostic data level 診斷資料層級 Tips when using Windows 使用 Windows 時嘅提示",
    "native": false
  },
  {
    "tag": "module.tweaks.recipes-one-click",
    "en": "Recipes (one-click)",
    "zh": "一鍵流程",
    "glyph": "",
    "keywords": "Recipes (one-click) 一鍵流程 tweak tweaks 調校 windows Calm Windows (de-annoy) 靜化 Windows（去煩擾） Declutter taskbar 簡化工作列 Developer setup 開發人員設定 Disable telemetry tasks 停用遙測排程工作 Classic Explorer 經典檔案總管 Free up space 釋放空間 Gaming mode 遊戲模式 System health check 系統健康檢查 Security lock-down 保安加固 Network reset 網絡重置 Performance boost 效能提升 Privacy hardening 私隱強化 Quick cleanup 快速清理 Re-enable Windows nags 還原 Windows 提示 Create a restore point 建立還原點 Trim startup bloat 清開機臃腫 Update everything 全部更新",
    "native": false
  },
  {
    "tag": "module.tweaks.security",
    "en": "Security",
    "zh": "安全",
    "glyph": "",
    "keywords": "Security 安全 tweak tweaks 調校 windows Show BitLocker status 顯示 BitLocker 狀態 Exclude Downloads from Defender scans 將 Downloads 排除喺 Defender 掃描之外 Run a quick Defender scan 行一次 Defender 快速掃描 Update Defender definitions 更新 Defender 病毒定義 Turn Windows Firewall off (all profiles) 熄咗 Windows 防火牆（所有設定檔） Turn Windows Firewall on (all profiles) 開返 Windows 防火牆（所有設定檔） Hide last signed-in user name 隱藏上次登入嘅使用者名稱 Open Windows Security 開啟 Windows 安全性 Enable Remote Desktop 開啟遠端桌面 Require Ctrl+Alt+Del at sign-in 登入要按 Ctrl+Alt+Del SmartScreen for apps & files 應用程式同檔案 SmartScreen SmartScreen for Store & web content 商店同網頁內容 SmartScreen UAC prompt behaviour UAC 提示行為 Dim the desktop for UAC UAC 時將桌面變暗",
    "native": false
  },
  {
    "tag": "module.tweaks.system-boot",
    "en": "System & Boot",
    "zh": "系統與開機",
    "glyph": "",
    "keywords": "System & Boot 系統與開機 tweak tweaks 調校 windows Auto-restart on crash 當機自動重新開機 Restart to Advanced startup 重新開機入進階啟動 Restart to UEFI firmware 重新開機入 UEFI 韌體 Clipboard history 剪貼簿記錄 Cloud clipboard sync 雲端剪貼簿同步 Developer Mode 開發人員模式 Enable System Protection (C:) 啟用系統保護 (C:) Edit Environment Variables 編輯環境變數 Create God Mode folder 建立 God Mode 資料夾 Hung app close timeout 無回應程式關閉等候 Mapped-drive reconnect fix 網絡磁碟重連修正 Enable long path support 啟用長路徑支援 NumLock at startup 開機 NumLock Create a restore point 建立還原點 Verbose sign-in messages 詳細登入訊息",
    "native": false
  },
  {
    "tag": "module.tweaks.system-information",
    "en": "System Information",
    "zh": "系統資訊",
    "glyph": "",
    "keywords": "System Information 系統資訊 tweak tweaks 調校 windows Last boot 上次開機 Processor 處理器 Logical processors 邏輯處理器 System drive 系統磁碟 Graphics adapter 顯示卡 Device name 裝置名稱 Edition 版本 Installed memory 已安裝記憶體 Memory in use 記憶體用量 App runtime 應用程式執行階段 Time zone 時區 Uptime 運行時間 Signed-in user 登入使用者 Version & build 版本與組建",
    "native": false
  },
  {
    "tag": "module.tweaks.taskbar-start",
    "en": "Taskbar & Start",
    "zh": "工作列與開始功能表",
    "glyph": "",
    "keywords": "Taskbar & Start 工作列與開始功能表 tweak tweaks 調校 windows Taskbar alignment 工作列對齊 Show Chat/Copilot button 顯示聊天/Copilot 按鈕 Combine taskbar buttons 合併工作列按鈕 Show \"End Task\" on right-click 右鍵顯示「結束工作」 Show taskbar on all displays 所有螢幕顯示工作列 Open Taskbar settings 開啟工作列設定 Search on taskbar 工作列搜尋 Show all system tray icons 顯示所有系統匣圖示 Show seconds in system clock 系統時鐘顯示秒數 Show most used apps in Start 開始功能表顯示最常用程式 Show recently added apps in Start 開始功能表顯示最近新增程式 Show tips and recommendations in Start 開始功能表顯示提示同建議 Show Task View button 顯示工作檢視按鈕 Show Widgets button 顯示小工具按鈕",
    "native": false
  },
  {
    "tag": "module.tweaks.winaero-tweaks",
    "en": "Winaero Tweaks",
    "zh": "Winaero 進階調校",
    "glyph": "",
    "keywords": "Winaero Tweaks Winaero 進階調校 tweak tweaks 調校 windows Show accent color on Start, taskbar and action center 喺開始選單、工作列同操作中心顯示強調色 Colored title bars (accent on window title bars and borders) 彩色標題列（視窗標題列同邊框上色） Disable window shake (Aero Shake) to minimize 停用搖晃視窗（Aero Shake）最小化 Desktop icon horizontal spacing 桌面圖示水平間距 Inactive title bar color (accent on background windows) 非作用中標題列顏色（背景視窗用強調色） Use classic balloon tips instead of toast notifications 用傳統氣球提示取代浮動通知（toast） Menu show delay (snappier menus) 選單顯示延遲（選單更快彈出） Scrollbar width (thicker scroll bars) 捲動列闊度（較粗捲動列） Auto-End Tasks on Shutdown 關機時自動結束工作 Disable Win+L Lock 停用 Win+L 鎖定 Hung App Timeout (1s) 程式無回應等候時間（1 秒） Disable Shutdown Event Tracker 停用關機事件追蹤器 Wait To Kill App Timeout (2s) 強制結束程式等候時間（2 秒） Wait To Kill Service Timeout 強制結束服務等候時間 Disable blur on sign-in screen 停用登入畫面模糊效果 Disable automatic restart sign-on (ARSO) 停用自動重啟登入 (ARSO) Disable \"Press Ctrl+Alt+Del\" at logon 停用登入「按 Ctrl+Alt+Del」 Disable sign-in screen background image 停用登入畫面背景圖 Disable Windows startup sound 停用 Windows 開機音效 Show last interactive logon info 顯示上次互動登入資訊 Disable lock screen 停用上鎖畫面 Enable Num Lock at startup 開機時開啟 Num Lock Remove \"Cast to Device\" from context menu context menu 移除「投放到裝置」 Remove \"Edit with Photos\" from context menu context menu 移除「用相片編輯」 Remove \"Give access to\" / Share from context menu context menu 移除「授權存取 / 共用」 Remove \"Restore previous versions\" from context menu context menu 移除「還原舊版本」 Remove \"Scan with Microsoft Defender\" from context menu context menu 移除「用 Microsoft Defender 掃描」 Checkboxes for item selection 用核取方塊選取項目 Use compact view (reduce spacing) 使用精簡檢視（減少間距） Disable thumbnail cache 停用縮圖快取 Show drive letters first 磁碟機代號顯示喺前 Expand to current folder 導覽窗格展開至目前資料夾 Open Explorer to This PC 檔案總管開啟「本機」 Hide recent files in Quick access 唔顯示快速存取最近檔案 Show seconds in taskbar clock 工作列時鐘顯示秒數 Show Explorer status bar 顯示檔案總管狀態列 End task on taskbar right-click 工作列右鍵加入「結束工作」 Delivery Optimization: no download from other PCs 傳遞最佳化：唔由其他 PC 下載 Deny apps access to location (policy) 拒絕 App 存取位置 (政策) Disable app launch tracking 停用程式啟動追蹤 Disable feedback request frequency 停用意見反映要求頻率 Disable feedback notifications 停用意見反映通知 Disable tailored experiences with diagnostic data 停用以診斷資料提供的量身體驗 Disable telemetry autologger (DiagTrack) 停用遙測自動記錄器 (DiagTrack) Disable typing insights 停用輸入分析",
    "native": false
  },
  {
    "tag": "module.tweaks.windows-11-advanced",
    "en": "Windows 11 Advanced",
    "zh": "Windows 11 進階",
    "glyph": "",
    "keywords": "Windows 11 Advanced Windows 11 進階 tweak tweaks 調校 windows Restore classic volume mixer 還原傳統音量混音器 Show seconds in the system clock 系統時鐘顯示秒數 Always confirm before deleting files 刪除檔案前永遠確認 Disable Bing in Windows Search 停用 Windows 搜尋嘅 Bing Disable the lock screen 停用鎖定畫面 Disable Aero Shake to minimise 停用 Aero 搖晃最小化 Disable web search suggestions in Start 停用開始功能表網路搜尋建議 Disable thumbnail caching 停用縮圖快取 Drive letter display order 磁碟機代號顯示次序 Expand the legacy ribbon by default 預設展開舊版功能區 Show details in file operation dialogs 檔案操作對話框顯示詳細資料 Maximise icon cache size 加大圖示快取容量 Taskbar on multiple displays 多顯示器工作列模式 Hide frequent folders in Quick Access 快速存取隱藏常用資料夾 Hide recent files in Quick Access 快速存取隱藏最近檔案 Remove 3D Objects folder 移除 3D 物件資料夾 Restore folder windows at logon 登入時還原資料夾視窗 Launch folder windows in a separate process 用獨立處理序開資料夾視窗 Combine taskbar buttons / show labels 合併工作列按鈕／顯示標籤 Always show all tray icons (legacy) 永遠顯示所有系統匣圖示（舊版） Cursor blink rate 游標閃爍速度 Caret (cursor) width 游標闊度 Double-click speed 連按速度 Filter Keys 篩選鍵 First day of week 一週嘅第一日 Keyboard repeat delay 鍵盤重複延遲 Keyboard repeat rate 鍵盤重複速度 Disable mouse acceleration 停用滑鼠加速 Mouse threshold 1 off 滑鼠閾值 1 關閉 Mouse threshold 2 off 滑鼠閾值 2 關閉 Open Keyboard accessibility 開啟鍵盤協助工具 Open Mouse & touchpad settings 開啟滑鼠同觸控板設定 Open Region format settings 開啟地區格式設定 Open Typing settings 開啟輸入設定 Short date format 短日期格式 Time format (24h / 12h) 時間格式（24 / 12 小時） Sticky Keys 相黏鍵 Swap mouse buttons 對調滑鼠按鍵 Toggle Keys 切換鍵 Wheel scroll lines 滾輪捲動行數 Crash dump type 當機傾印類型 Disable boot animation 停用開機動畫 Disable Fast Startup 停用快速啟動 Disable HPET timer 停用 HPET 計時器 Disable SysMain (Superfetch) 停用 SysMain（Superfetch） Disable reserved storage 停用保留儲存空間 Hardware-accelerated GPU scheduling 硬件加速 GPU 排程 Hypervisor launch auto (bcdedit) 自動虛擬器啟動（bcdedit） Hypervisor launch off (bcdedit) 關閉虛擬器啟動（bcdedit） Disable memory compression 停用記憶體壓縮 Enable memory compression 啟用記憶體壓縮 Set network to Private 設網絡為私人 Disable NTFS last-access 停用 NTFS 最後存取 Activate High Performance plan 啟用高效能電源計劃 Processor scheduling 處理器排程 Rebuild performance counters 重建效能計數器 Rebuild search index 重建搜尋索引 Disable startup app delay 停用啟動程式延遲 GPU TDR delay GPU TDR 延遲 Disable USB selective suspend 停用 USB 選擇性暫停 Open About this PC 開啟關於此電腦 Open Activation settings 開啟啟用設定 Open Backup settings 開啟備份設定 Open Bluetooth & devices 開啟藍牙同裝置 Open Clipboard settings 開啟剪貼簿設定 Open Nearby sharing 開啟附近共用 Open Date & time 開啟日期同時間 Open For developers 開啟開發人員設定 Open Display settings 開啟顯示器設定 Open Multitasking settings 開啟多工處理設定 Open Night light settings 開啟夜燈設定 Open Optional features 開啟選用功能 Open Power & battery 開啟電源同電池 Open Language settings 開啟語言設定 Open Sound settings 開啟音效設定 Open Storage settings 開啟儲存空間設定 Open Taskbar settings 開啟工作列設定 Open Themes settings 開啟佈景主題設定 Open Windows Security 開啟 Windows 安全性 Open Windows Update 開啟 Windows Update Alt-Tab shows browser tabs Alt-Tab 顯示瀏覽器分頁 Joint resize snapped windows 同時調整貼齊視窗 Lock-screen notifications 鎖定畫面通知 Notification sound 通知聲音 All notifications 所有通知 Shut down OneDrive 關閉 OneDrive Open Focus settings 開啟專注設定 Open Multitasking settings 開啟多工處理設定 Open Notifications settings 開啟通知設定 Open Storage settings 開啟儲存空間設定 Recycle Bin retention 回收筒保留期 Show snap layout tips 顯示貼齊版面提示 Snap Assist 貼齊助手 Snap layout bar 貼齊版面工具列 Snap fill 貼齊自動填充 Snap layout flyout 貼齊版面飛出視窗 Show app suggestions in Snap 貼齊顯示應用程式建議 Storage Sense 儲存空間感知功能 Virtual desktops on all monitors 所有螢幕顯示虛擬桌面 Window arrangement (animations) 視窗排列動畫",
    "native": false
  }
];

export const moduleCount = 315;

/** Category buckets for the Windows-tweak catalog (module.tweaks.* nav entries). */
export const tweakCategoryCount = 22;
