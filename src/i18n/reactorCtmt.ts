// Containment-panel operator strings (namespace `reactorctmt`). Dedicated slice per the repo
// pattern: batch/feature agents never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorCtmt` / `yueReactorCtmt` into the bundles. Parity enforced by `typeof enReactorCtmt`.
// Dynamic physics strings (alarms, scram reason) come bilingually from the ContainmentSystem
// engine itself (CtmtAlarm {en, zh}); this slice only labels the chrome. Chinese wording lifted
// from the C# source's own bilingual comments where present (安全殼隔離／安全殼噴淋／集水坑／軸封…).

export const enReactorCtmt = {
  reactorctmt: {
    title: 'Containment',
    pressure: 'Pressure',
    temp: 'Atmosphere temp',
    kpag: 'kPa (g)',
    psig: 'psig',
    degC: '°C',
    designRef: 'Design {{p}} psig',

    // ---- Hi-1/2/3 bistable ladder ----
    ladderTitle: 'Pressure bistables (ESFAS)',
    hi1: 'HI-1 · SI + Phase A',
    hi2: 'HI-2 · Steamline isolation',
    hi3: 'HI-3 · Spray + Phase B',
    setpoint: 'set {{kpa}} kPa',

    // ---- status lamps ----
    isolation: 'ISOLATION',
    spray: 'SPRAY',
    fanCoolers: 'FAN COOLERS',
    si: 'SAFETY INJECTION',
    sprayCountdown: 'Spray start in {{s}} s',

    // ---- sump ----
    sumpTitle: 'Containment sump',
    sumpPump: 'SUMP PUMP',
    gal: 'gal',
    sumpInferred: 'Inferred leak {{g}} gpm',

    // ---- RCP seals ----
    sealTitle: 'RCP seal leakoff',
    rcp: 'RCP {{n}}',
    gpm: 'gpm',
    cavity: '{{t}} °C',
    totalLeak: 'Total RCS leak',
    sealCoolingOk: 'SEAL COOLING OK',
    sealCoolingLost: 'SEAL COOLING LOST',
    sealLoca: 'RCP SEAL LOCA',
    rcpsRunning: 'RCPs running: {{n}}',

    // ---- drill controls ----
    ccwDrill: 'Drill: loss of CCW (seal cooling)',
    restoreCooling: 'Restore seal cooling',
  },
};

export const yueReactorCtmt: typeof enReactorCtmt = {
  reactorctmt: {
    title: '安全殼',
    pressure: '壓力',
    temp: '大氣溫度',
    kpag: 'kPa（表壓）',
    psig: 'psig',
    degC: '°C',
    designRef: '設計壓力 {{p}} psig',

    // ---- Hi-1/2/3 bistable ladder ----
    ladderTitle: '壓力雙穩態（ESFAS）',
    hi1: 'HI-1 · 安全注入 + A 相隔離',
    hi2: 'HI-2 · 主蒸汽管隔離',
    hi3: 'HI-3 · 噴淋 + B 相隔離',
    setpoint: '整定 {{kpa}} kPa',

    // ---- status lamps ----
    isolation: '安全殼隔離',
    spray: '安全殼噴淋',
    fanCoolers: '風機冷卻器',
    si: '安全注入',
    sprayCountdown: '噴淋將於 {{s}} 秒後啟動',

    // ---- sump ----
    sumpTitle: '安全殼集水坑',
    sumpPump: '集水坑泵',
    gal: '加侖',
    sumpInferred: '推算洩漏 {{g}} gpm',

    // ---- RCP seals ----
    sealTitle: '主泵軸封洩漏',
    rcp: '主泵 {{n}}',
    gpm: 'gpm',
    cavity: '{{t}} °C',
    totalLeak: 'RCS 總洩漏',
    sealCoolingOk: '軸封冷卻正常',
    sealCoolingLost: '軸封冷卻喪失',
    sealLoca: '主泵軸封失水',
    rcpsRunning: '運行主泵：{{n}}',

    // ---- drill controls ----
    ccwDrill: '演練：設備冷卻水喪失（軸封冷卻）',
    restoreCooling: '恢復軸封冷卻',
  },
};
