// CSF status-tree board chrome strings (namespace `reactorcsf`). Dedicated slice per the repo
// pattern: batch/feature agents never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorCsf` / `yueReactorCsf` into the bundles. Parity enforced by `typeof enReactorCsf`.
// Tree names, FR ids and condition TEXT come bilingually from the CsfEvaluator view itself
// (nameEn/nameZh, conditionEn/conditionZh); this slice only labels the chrome.

export const enReactorCsf = {
  reactorcsf: {
    title: 'Critical Safety Functions',
    subtitle: 'F-0 status trees',
    frLabel: 'Entry FRG',
    worstLabel: 'Worst',
    challengeAlarm: 'CSF CHALLENGE — ENTER FRG',
    statusInvalid: 'NO DATA',
    statusGreen: 'SATISFIED',
    statusYellow: 'OFF-NORMAL',
    statusOrange: 'SEVERE CHALLENGE',
    statusRed: 'EXTREME CHALLENGE',
  },
};

export const yueReactorCsf: typeof enReactorCsf = {
  reactorcsf: {
    title: '關鍵安全功能',
    subtitle: 'F-0 狀態樹',
    frLabel: '進入FRG程序',
    worstLabel: '最差狀態',
    challengeAlarm: '安全功能受挑戰 — 執行FRG程序',
    statusInvalid: '無數據',
    statusGreen: '滿足',
    statusYellow: '偏離正常',
    statusOrange: '嚴重挑戰',
    statusRed: '極度挑戰',
  },
};
