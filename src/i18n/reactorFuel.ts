// Fuel-factory + CVCS blender operator strings (namespace `reactorfuel`). Dedicated slice per the
// repo pattern: batch/feature agents never append to en.ts / zh-Hant.ts; the i18n index merges
// `enReactorFuel` / `yueReactorFuel` into the bundles. Parity enforced by `typeof enReactorFuel`.
// Validation/rejection TEXT comes bilingually from the fuel factory itself (reasonEn/reasonZh);
// this slice only labels the chrome.

export const enReactorFuel = {
  reactorfuel: {
    // ---- fuel factory panel ----
    title: 'Fuel Factory',
    coreStatus: 'Core: {{n}} assemblies · mean burnup {{bu}} MWd/t',
    canRun: 'FUEL AVAILABLE',
    noFuel: 'NO FUEL IN CORE',
    fresh: 'Fresh ({{n}})',
    loaded: 'In core ({{n}})',
    spent: 'Spent pool ({{n}})',
    colId: 'Assembly',
    colEnrich: 'U-235',
    colMass: 'Mass',
    colBurnup: 'Burnup',
    load: 'Load',
    unload: 'Discharge',
    dischargeAll: 'Discharge all',
    confirmDischarge: 'Really discharge every loaded assembly? The core will have no fuel.',
    fabTitle: 'Fabricate assembly',
    enrichment: 'Enrichment (3.00–4.95 %)',
    mass: 'Mass (400–540 kg HM)',
    fabricate: 'Fabricate',
    loadStandard: 'Load standard core (4.20 %)',
    emptyFresh: 'No fresh assemblies — fabricate one.',
    emptyLoaded: 'Core is empty.',
    emptySpent: 'Spent pool is empty.',
    loadRejected: 'Load rejected: {{reason}}',
    loadedOk: 'Assembly {{id}} loaded.',
    dischargedNote: '{{id}} reached discharge burnup and was auto-moved to the spent pool.',

    // ---- CVCS blender ----
    blenderTitle: 'CVCS makeup blender',
    blendAuto: 'Auto',
    blendBorate: 'Borate',
    blendDilute: 'Dilute',
    blendAltDilute: 'Alt-dilute',
    makeupBlend: 'Blend {{ppm}} ppm',
    timeToCrit: 'Est. time to criticality: {{t}}',
    timeToCritStable: 'Est. time to criticality: —',
    actionMargin: 'Dilution action margin: {{t}} s',
    dilutionDrill: 'Drill: uncontrolled dilution',
    terminateDilution: 'Terminate dilution',
    dilutionActive: 'UNCONTROLLED DILUTION IN PROGRESS',
  },
};

export const yueReactorFuel: typeof enReactorFuel = {
  reactorfuel: {
    // ---- fuel factory panel ----
    title: '燃料工廠',
    coreStatus: '堆芯：{{n}} 個組件 · 平均燃耗 {{bu}} MWd/t',
    canRun: '燃料可用',
    noFuel: '堆芯無燃料',
    fresh: '新燃料（{{n}}）',
    loaded: '堆芯內（{{n}}）',
    spent: '乏燃料池（{{n}}）',
    colId: '組件',
    colEnrich: 'U-235',
    colMass: '質量',
    colBurnup: '燃耗',
    load: '裝入',
    unload: '卸出',
    dischargeAll: '全部卸出',
    confirmDischarge: '真係要卸出所有堆芯組件？堆芯將會冇燃料。',
    fabTitle: '製造組件',
    enrichment: '濃縮度（3.00–4.95 %）',
    mass: '質量（400–540 kg HM）',
    fabricate: '製造',
    loadStandard: '裝入標準堆芯（4.20 %）',
    emptyFresh: '冇新燃料組件 — 請先製造。',
    emptyLoaded: '堆芯係空嘅。',
    emptySpent: '乏燃料池係空嘅。',
    loadRejected: '裝入被拒：{{reason}}',
    loadedOk: '已裝入組件 {{id}}。',
    dischargedNote: '{{id}} 達到卸料燃耗，已自動移去乏燃料池。',

    // ---- CVCS blender ----
    blenderTitle: 'CVCS 補水混合器',
    blendAuto: '自動',
    blendBorate: '加硼',
    blendDilute: '稀釋',
    blendAltDilute: '替代稀釋',
    makeupBlend: '混合 {{ppm}} ppm',
    timeToCrit: '預計距臨界時間：{{t}}',
    timeToCritStable: '預計距臨界時間：—',
    actionMargin: '稀釋操作裕度：{{t}} 秒',
    dilutionDrill: '演習：未受控稀釋',
    terminateDilution: '終止稀釋',
    dilutionActive: '未受控稀釋進行中',
  },
};
