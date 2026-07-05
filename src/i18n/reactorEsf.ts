// Engineered-Safety-Features (ESF) panel chrome strings (namespace `reactoresf`). Dedicated slice
// per the repo pattern: feature agents never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorEsf` / `yueReactorEsf` into the bundles. Parity enforced by `typeof enReactorEsf`.
// Dynamic physics strings (SI status, annunciator texts) come bilingually from the engine's View
// (siStatusEn/Zh, activeAlarmsEn/Zh) — this slice only labels the chrome.

export const enReactorEsf = {
  reactoresf: {
    title: 'Engineered Safety Features',

    // ---- Safety Injection block ----
    siTitle: 'Safety Injection (HHSI)',
    siActuated: 'SI ACTUATED',
    siStandby: 'STANDBY',
    siFlow: 'HHSI flow',
    siBoronRate: 'Boration',
    siBoronTarget: 'SI boron target {{ppm}} ppm',
    siLowPressArmed: 'LO-PRESS SI ARMED',
    siLowPressBlocked: 'LO-PRESS SI BLOCKED',
    actuateSi: 'Actuate SI',
    resetSi: 'Reset SI',

    // ---- Accumulator bank ----
    accumTitle: 'N₂ Accumulators',
    accumRemaining: 'Remaining',
    accumDumping: 'DUMPING',
    accumEmpty: 'EMPTY',
    accumStandby: 'READY',
    accumUnarmed: 'ISOLATED',
    accumPrecharge: 'Precharge {{mpa}} MPa',

    // ---- MSSV bank ----
    mssvTitle: 'Main Steam Safety Valves',
    mssvValve: 'V{{n}}',
    mssvOpen: 'OPEN',
    mssvShut: 'SHUT',
    mssvTotalRelief: 'Total relief',
    mssvOpenCount: '{{n}} / 5 open',
    mssvSetpointUnit: 'psig',
  },
};

export const yueReactorEsf: typeof enReactorEsf = {
  reactoresf: {
    title: '工程安全設施',

    // ---- Safety Injection block ----
    siTitle: '安全注入（高壓頭 HHSI）',
    siActuated: '安全注入已致動',
    siStandby: '待命',
    siFlow: 'HHSI 注入流量',
    siBoronRate: '加硼速率',
    siBoronTarget: 'SI 硼目標 {{ppm}} ppm',
    siLowPressArmed: '低壓 SI 已備妥',
    siLowPressBlocked: '低壓 SI 已閉鎖',
    actuateSi: '手動安全注入',
    resetSi: '復位安全注入',

    // ---- Accumulator bank ----
    accumTitle: '氮氣蓄壓器',
    accumRemaining: '剩餘',
    accumDumping: '排放中',
    accumEmpty: '已排空',
    accumStandby: '就緒',
    accumUnarmed: '已隔離',
    accumPrecharge: '預充壓力 {{mpa}} MPa',

    // ---- MSSV bank ----
    mssvTitle: '主蒸汽安全閥',
    mssvValve: 'V{{n}}',
    mssvOpen: '開',
    mssvShut: '關',
    mssvTotalRelief: '總釋放流量',
    mssvOpenCount: '{{n}} / 5 開啟',
    mssvSetpointUnit: 'psig',
  },
};
