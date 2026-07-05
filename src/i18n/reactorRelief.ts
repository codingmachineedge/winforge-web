// Pressurizer relief (PORV / block valve / code safeties / PRT) panel chrome strings
// (namespace `reactorrelief`). Dedicated slice per the repo pattern: batch/feature agents never
// append to en.ts / zh-Hant.ts; the i18n index merges `enReactorRelief` / `yueReactorRelief`
// into the bundles. Parity enforced by `typeof enReactorRelief`.
// Dynamic physics strings (annunciators, PORV status) come bilingually from the engine module
// (PressureReliefView.alarmsEn/Zh, porvStatusEn/Zh); this slice only labels the chrome.
// Lamp wording lifted from the C# source where it exists (Pages/ReactorModule.xaml.cs
// L1076–1097: 已致動/未致動/洩放中/爆破片爆/排放中; 釋壓缸壓力/溫度/水位).

export const enReactorRelief = {
  reactorrelief: {
    title: 'Pressurizer relief · PORV / safeties / PRT',

    // ---- valve lamps ----
    porvCmd: 'PORV command',
    cmdOpen: 'OPEN',
    cmdShut: 'SHUT',
    blockValve: 'Block valve',
    blockOpen: 'OPEN',
    blockShut: 'CLOSED',
    safeties: 'Code safeties',
    safetyAbbr: 'SV',
    ltop: 'LTOP / COMS',
    ltopDisarmed: 'Disarmed',
    ltopArmed: 'ARMED',
    ltopRelieving: 'RELIEVING',
    reliefRate: 'Relief rate',

    // ---- PRT quench tank ----
    prtTitle: 'Pressurizer Relief Tank (quench tank)',
    prtPress: 'PRT pressure',
    prtTemp: 'PRT temp',
    prtLevel: 'PRT level',
    ruptureDisc: 'Rupture disc',
    discIntact: 'INTACT',
    discBurst: 'DISC BURST',
    discharging: 'discharging',
    quiet: 'quiet',

    // ---- TMI-2 lesson ----
    tmiNote:
      'TMI-2 lesson: the lamp shows the COMMAND, not the valve position. Believe the PRT — rising pressure, temperature and level mean a relief path is really open.',

    // ---- operator actions ----
    drillStuck: 'Drill: stick PORV open',
    drillArmed: 'Stuck-PORV drill armed — fails on next reseat',
    closeBlock: 'Close block valve',
    openBlock: 'Open block valve',
    alarmsTitle: 'Annunciators',
    noAlarms: 'No relief annunciators',
  },
};

export const yueReactorRelief: typeof enReactorRelief = {
  reactorrelief: {
    title: '穩壓器釋壓 · 釋壓閥／安全閥／釋壓缸',

    // ---- valve lamps ----
    porvCmd: '釋壓閥指令',
    cmdOpen: '開',
    cmdShut: '關',
    blockValve: '隔離閥',
    blockOpen: '開',
    blockShut: '已關',
    safeties: '規範安全閥',
    safetyAbbr: 'SV',
    ltop: '低溫超壓保護',
    ltopDisarmed: '未致動',
    ltopArmed: '已致動',
    ltopRelieving: '洩放中',
    reliefRate: '洩放速率',

    // ---- PRT quench tank ----
    prtTitle: '穩壓器釋壓缸（淬冷缸）',
    prtPress: '釋壓缸壓力',
    prtTemp: '釋壓缸溫度',
    prtLevel: '釋壓缸水位',
    ruptureDisc: '爆破片',
    discIntact: '完好',
    discBurst: '爆破片爆',
    discharging: '排放中',
    quiet: '靜止',

    // ---- TMI-2 lesson ----
    tmiNote: '三哩島教訓：燈只係顯示指令，唔係閥位。要信釋壓缸 — 壓力、溫度、水位齊升，即係真係有釋壓通道開緊。',

    // ---- operator actions ----
    drillStuck: '演習：釋壓閥卡開',
    drillArmed: '卡閥演習已備妥 — 下次回座時卡開',
    closeBlock: '關閉隔離閥',
    openBlock: '打開隔離閥',
    alarmsTitle: '報警窗',
    noAlarms: '冇釋壓報警',
  },
};
