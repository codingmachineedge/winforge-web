// Reactor instrumentation-UI strings (namespace `reactorui`). Kept in a dedicated slice so the
// reactor-UI agent never collides with concurrent edits to en.ts / zh-Hant.ts. The orchestrator
// merges `enReactorUi` into the EN bundle and `yueReactorUi` into the 粵語 (Traditional Chinese)
// bundle. Parity is enforced by the `typeof enReactorUi` annotation.
//
// These cover the NEW analog-gauge / annunciator / NIS / permissive-lamp / mode-annunciator panels.
// Existing `reactor.*` keys (in the shared bundles) are untouched. Alarm/trip TEXT itself is supplied
// bilingually by the physics engine (alarms/alarmsZh), so this slice only labels the chrome.

export const enReactorUi = {
  reactorui: {
    // ---- panel titles ----
    annunciatorTitle: 'Annunciator',
    nisTitle: 'Nuclear Instrumentation',
    permissivesTitle: 'Permissives',
    modeTitle: 'Operational Mode',

    // ---- annunciator ----
    ack: 'ACK',
    ackAll: 'Acknowledge All',
    allClear: 'All Clear',
    alarmsActive: '{{count}} active',

    // ---- NIS range labels ----
    sourceRange: 'Source Range',
    sourceRangeAbbr: 'SR',
    intermediateRange: 'Intermediate Range',
    intermediateRangeAbbr: 'IR',
    powerRange: 'Power Range',
    powerRangeAbbr: 'PR',
    startupRate: 'Startup Rate',
    oneOverM: '1 / M',
    srDeenergized: 'SR HV removed',
    srEnergized: 'SR energized',

    // ---- units ----
    cps: 'cps',
    amps: 'A',
    decades: 'dec',
    dpm: 'DPM',
    pct: '%',

    // ---- permissive lamp descriptions (P-6 … P-10) ----
    p6: 'IR on-scale',
    p7: 'At-power trips',
    p8: '48% RTP',
    p9: '50% RTP',
    p10: 'Power range on-scale',
    lit: 'LIT',
    unlit: 'OFF',

    // ---- Tech-Spec MODE 1–6 names ----
    mode1: 'Power Operation',
    mode2: 'Startup',
    mode3: 'Hot Standby',
    mode4: 'Hot Shutdown',
    mode5: 'Cold Shutdown',
    mode6: 'Refueling',
    modeNumber: 'MODE {{n}}',
  },
};

export const yueReactorUi: typeof enReactorUi = {
  reactorui: {
    // ---- panel titles ----
    annunciatorTitle: '報警窗盤',
    nisTitle: '核測量系統',
    permissivesTitle: '許可訊號',
    modeTitle: '運轉模式',

    // ---- annunciator ----
    ack: '確認',
    ackAll: '全部確認',
    allClear: '全部正常',
    alarmsActive: '{{count}} 個生效',

    // ---- NIS range labels ----
    sourceRange: '源量程',
    sourceRangeAbbr: '源',
    intermediateRange: '中間量程',
    intermediateRangeAbbr: '中',
    powerRange: '功率量程',
    powerRangeAbbr: '功',
    startupRate: '起動率',
    oneOverM: '1 / M',
    srDeenergized: '源量程高壓已除',
    srEnergized: '源量程通電',

    // ---- units ----
    cps: '計數/秒',
    amps: '安',
    decades: '量級',
    dpm: 'DPM',
    pct: '%',

    // ---- permissive lamp descriptions ----
    p6: '中間量程在刻度',
    p7: '滿功率跳脫',
    p8: '48% 額定',
    p9: '50% 額定',
    p10: '功率量程在刻度',
    lit: '着',
    unlit: '熄',

    // ---- Tech-Spec MODE 1–6 names ----
    mode1: '功率運轉',
    mode2: '啟動',
    mode3: '熱待機',
    mode4: '熱停機',
    mode5: '冷停機',
    mode6: '換料',
    modeNumber: '模式 {{n}}',
  },
};
