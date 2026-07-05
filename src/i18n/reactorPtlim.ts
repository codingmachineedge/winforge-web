// P/T 限值面板操作字串（namespace `reactorptlim`）· P/T-limits / LTOP / PTS panel chrome strings.
// Dedicated slice per the repo pattern: batch/feature agents never append to en.ts / zh-Hant.ts;
// the i18n index merges `enReactorPtlim` / `yueReactorPtlim` into the bundles. Parity is enforced
// by `typeof enReactorPtlim`. Dynamic physics strings (annunciator texts, PTS advisory ladder)
// come bilingually from the engine module (PtLimitsView alarmsEn/Zh, ptsAdvisoryEn/Zh) — this
// slice only labels the chrome. Chinese wording lifted from the C# source's own bilingual
// comments (ReactorSimService.cs L835–871) wherever it exists.

export const enReactorPtlim = {
  reactorptlim: {
    // ---- panel + P/T diagram ----
    title: 'P/T Limits · Vessel Integrity',
    diagramLabel: 'Appendix G P/T operating envelope',
    axisTemp: 'Tcold (°C)',
    axisPress: 'RCS P (MPa-abs)',
    legendCurve: 'App G limit',
    legendLtop: 'LTOP setpoint',
    legendPoint: 'Operating point',
    forbidden: 'BRITTLE-FRACTURE REGION',

    // ---- readouts ----
    allowable: 'Allowable',
    margin: 'P/T margin',
    rate: 'Heatup / cooldown rate',
    rateLimit: 'Limit ±{{lim}} °C/hr (100 °F/hr)',
    boltup: 'Min boltup {{t}} °C',
    critMargin: 'Criticality +{{t}} °C above limit',

    // ---- lamps ----
    lampHeatupHi: 'HEATUP RATE HI',
    lampCooldownHi: 'COOLDOWN RATE HI',
    lampViolation: 'P/T VIOLATION',
    lampLtopArmed: 'LTOP ARMED',
    lampLtopRelief: 'LTOP RELIEVING',

    // ---- PTS monitor ----
    ptsTitle: 'PTS monitor (10 CFR 50.61)',
    efpy: 'Vessel age (EFPY)',
    rtPts: 'RT_PTS',
    screenMargin: 'Screening margin',
    wallTemp: 'Vessel wall temp',
    kiTotal: 'Applied K_I',
    kicWall: 'Toughness K_IC',
    ptsMargin: 'PTS margin K_IC/K_I',
  },
};

export const yueReactorPtlim: typeof enReactorPtlim = {
  reactorptlim: {
    // ---- panel + P/T diagram ----
    title: 'P/T 限值 · 容器完整性',
    diagramLabel: '附錄 G P/T 運轉包絡線',
    axisTemp: '冷腳溫度 Tcold（°C）',
    axisPress: 'RCS 壓力（MPa-abs）',
    legendCurve: '附錄 G 限值',
    legendLtop: 'LTOP 整定值',
    legendPoint: '運轉點',
    forbidden: '脆性斷裂區',

    // ---- readouts ----
    allowable: '容許壓力',
    margin: 'P/T 裕量',
    rate: 'RCS 升／降溫率',
    rateLimit: '限值 ±{{lim}} °C/hr（100 °F/hr）',
    boltup: '最低螺栓緊固溫度 {{t}} °C',
    critMargin: '臨界須高於限值 +{{t}} °C',

    // ---- lamps ----
    lampHeatupHi: '升溫率過高',
    lampCooldownHi: '降溫率過高',
    lampViolation: 'P/T 越限',
    lampLtopArmed: 'LTOP 已致動',
    lampLtopRelief: 'LTOP 洩放中',

    // ---- PTS monitor ----
    ptsTitle: '承壓熱衝擊監測（10 CFR 50.61）',
    efpy: '容器運轉壽命（EFPY）',
    rtPts: '參考溫度 RT_PTS',
    screenMargin: '篩選準則裕量',
    wallTemp: '容器內壁溫度',
    kiTotal: '施加應力強度 K_I',
    kicWall: '斷裂韌性 K_IC',
    ptsMargin: '承壓熱衝擊裕度 K_IC/K_I',
  },
};
