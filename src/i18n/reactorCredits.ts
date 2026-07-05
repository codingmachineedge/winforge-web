// Power-generation credit strings (namespace `reactorcredits`). Dedicated slice per the repo
// pattern: feature slices never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorCredits` / `yueReactorCredits` into the bundles. Parity enforced by the
// `typeof enReactorCredits` annotation. Credits themselves are awarded by external systems —
// this slice only labels the in-app ledger, mode selector and redemption chrome.

export const enReactorCredits = {
  reactorcredits: {
    // ---- panel ----
    title: 'Power Credits',
    balance: 'Balance',
    balanceValue: '{{n}} credits',
    unitNote: '1 credit = 1 simulated hour: rated grid supply (≈ {{mwh}} MWh) or one auto-run hour.',
    sourceNote: 'Credits are awarded by external systems — the plant only redeems them.',

    // ---- redemption mode selector ----
    modeTitle: 'Redemption mode',
    modeGrid: 'Credit-powered grid',
    modeGridNote: 'With the reactor off, the grid runs from the credit balance at 1 credit per hour.',
    modeAuto: 'Auto-start reactor',
    modeAutoNote: '1 credit starts the reactor for exactly 1 hour; it then shuts down on its own.',

    // ---- grid mode readouts ----
    gridOutput: 'Grid output',
    gridSupplying: 'GRID ON CREDIT',
    gridStandby: 'STANDBY',
    gridExhausted: 'CREDITS EXHAUSTED',
    hoursLeft: '≈ {{h}} h of credit supply remaining',
    creditSupply: 'credit supply {{mw}} MWe',

    // ---- auto-start mode ----
    autoBtn: 'Start reactor · 1 credit / 1 h',
    autoActive: 'AUTO-RUN · {{t}} left',
    autoNote: 'Assisted run: automatic SCRAMs suppressed, 2.5× fuel burn for the paid hour.',
    autoNeedsFuel: 'Load fuel before an auto-start.',
    noCredits: 'No credits available.',
  },
};

export const yueReactorCredits: typeof enReactorCredits = {
  reactorcredits: {
    // ---- panel ----
    title: '發電額度',
    balance: '結餘',
    balanceValue: '{{n}} 個額度',
    unitNote: '1 個額度 = 1 個模擬小時：額定電網供電（約 {{mwh}} MWh）或 1 小時自動運轉。',
    sourceNote: '額度由外部系統發放 — 電廠只負責兌換。',

    // ---- redemption mode selector ----
    modeTitle: '兌換模式',
    modeGrid: '額度供電電網',
    modeGridNote: '反應堆熄咗機，電網照用額度結餘推住行，每小時用 1 個額度。',
    modeAuto: '自動啟動反應堆',
    modeAutoNote: '用 1 個額度自動開堆行足 1 小時，之後佢自己熄機。',

    // ---- grid mode readouts ----
    gridOutput: '電網輸出',
    gridSupplying: '電網用緊額度',
    gridStandby: '待機',
    gridExhausted: '額度用晒',
    hoursLeft: '額度仲夠供電約 {{h}} 小時',
    creditSupply: '額度供電 {{mw}} MWe',

    // ---- auto-start mode ----
    autoBtn: '啟動反應堆 · 1 額度 / 1 小時',
    autoActive: '自動運轉 · 剩 {{t}}',
    autoNote: '輔助運轉：唔會自動緊急停堆，付費嗰個鐘燃料消耗 2.5×。',
    autoNeedsFuel: '自動啟動前要先裝燃料。',
    noCredits: '冇額度可用。',
  },
};
