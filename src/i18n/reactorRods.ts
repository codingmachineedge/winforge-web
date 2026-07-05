// Rod-control panel chrome strings (namespace `reactorrods`). Dedicated slice per the repo
// pattern: feature agents never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorRods` / `yueReactorRods` into the bundles. Parity enforced by `typeof enReactorRods`.
// Dynamic physics strings (status line, withdraw-block reasons) come bilingually from the
// RodController view itself (statusEn/statusZh, withdrawBlockedReasonEn/Zh); this slice only
// labels the chrome.

export const enReactorRods = {
  reactorrods: {
    title: 'Rod Control',
    modeLabel: 'Rod control mode',
    modeManual: 'MANUAL',
    modeAuto: 'AUTO',
    driveIn: 'IN',
    driveHold: 'HOLD',
    driveOut: 'OUT',
    speed: 'Drive speed',
    spm: 'steps/min',
    banksTitle: 'Bank position (steps withdrawn of 228)',
    bankA: 'Bank A',
    bankB: 'Bank B',
    bankC: 'Bank C',
    bankD: 'Bank D',
    stepsWithdrawn: '{{n}} steps withdrawn',
    demandCounter: 'Group demand counter',
    demandOf: '{{n}} / 528 steps',
    demandTarget: 'Demand target',
    demandGo: 'Slew',
    tref: 'Tref (program)',
    tavgTrefError: 'Tavg − Tref',
    deadbandLamp: 'IN DEADBAND',
    steppingIn: 'RODS STEPPING IN',
    steppingOut: 'RODS STEPPING OUT',
    withdrawBlockedLamp: 'WITHDRAWAL BLOCKED',
    engagedLamp: 'PROGRAM ENGAGED',
  },
};

export const yueReactorRods: typeof enReactorRods = {
  reactorrods: {
    title: '控制棒操作',
    modeLabel: '控制棒模式',
    modeManual: '手動',
    modeAuto: '自動',
    driveIn: '插入',
    driveHold: '保持',
    driveOut: '提出',
    speed: '驅動速度',
    spm: '步/分',
    banksTitle: '棒組位置（已提出步數，滿行程 228）',
    bankA: 'A 組',
    bankB: 'B 組',
    bankC: 'C 組',
    bankD: 'D 組',
    stepsWithdrawn: '已提出 {{n}} 步',
    demandCounter: '組需求計數器',
    demandOf: '{{n}} / 528 步',
    demandTarget: '需求目標',
    demandGo: '緩移',
    tref: 'Tref（程序）',
    tavgTrefError: 'Tavg − Tref',
    deadbandLamp: '死區之內',
    steppingIn: '插棒中',
    steppingOut: '提棒中',
    withdrawBlockedLamp: '提棒被封鎖',
    engagedLamp: '程序已接管',
  },
};
