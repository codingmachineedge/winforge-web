// Reactimeter-panel operator strings (namespace `reactorrmtr`). Dedicated slice per the repo
// pattern: the i18n index merges `enReactorReactimeter` / `yueReactorReactimeter` into the
// bundles; parity enforced by `typeof enReactorReactimeter`. The reactimeter is the inverse-
// point-kinetics reactivity computer (獨立反應性測量儀) — it reconstructs ρ, period and startup
// rate from the flux signal alone, and integrates a rod-worth measurement between a MARK and now.

export const enReactorReactimeter = {
  reactorrmtr: {
    title: 'Reactimeter',
    subtitle: 'Inverse point-kinetics reactivity computer',
    reactivity: 'Measured reactivity',
    dollars: 'Reactivity',
    period: 'Measured period',
    sur: 'Startup rate',
    worth: 'Worth since mark',
    stable: 'stable',
    pcm: 'pcm',
    dollarsUnit: '$',
    sec: 's',
    dpm: 'DPM',
    positiveRate: 'POSITIVE RATE',
    mark: 'Mark',
    clearMark: 'Clear mark',
    marked: 'Reference marked — measuring integral worth.',
    noMark: 'No reference marked. Mark to measure a rod-worth swing.',
    note: 'Independent of the engine state — driven only by the neutron-flux signal.',
  },
};

export const yueReactorReactimeter: typeof enReactorReactimeter = {
  reactorrmtr: {
    title: '反應性測量儀',
    subtitle: '逆點動力學反應性計算儀',
    reactivity: '量測反應性',
    dollars: '反應性',
    period: '量測週期',
    sur: '起動率',
    worth: '自標記起價值',
    stable: '穩定',
    pcm: 'pcm',
    dollarsUnit: '$',
    sec: '秒',
    dpm: 'DPM',
    positiveRate: '正向速率',
    mark: '標記',
    clearMark: '清除標記',
    marked: '已標記參考點 — 量測積分價值中。',
    noMark: '未標記參考點。撳「標記」量度控制棒價值變化。',
    note: '獨立於引擎狀態 — 只由中子通量訊號驅動。',
  },
};
