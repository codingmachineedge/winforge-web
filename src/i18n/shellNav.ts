// Shell navigation chrome strings: the pinned-favorites rail and recently-viewed
// strip. Kept in a dedicated file (single `shellnav` namespace) so this slice
// never collides with concurrent edits to en.ts / zh-Hant.ts. The orchestrator
// merges enShellNav / yueShellNav into the main i18n bundles.
//
// 粵語 is natural spoken-style Cantonese written in Traditional Chinese
// (WinForge house style), not Mandarin-flavoured 書面語.

export const enShellNav = {
  shellnav: {
    // Pinned favorites rail
    pinnedTitle: 'Pinned',
    unpin: 'Unpin',
    pinAria: 'Pin {{name}}',
    unpinAria: 'Unpin {{name}}',
    openAria: 'Open {{name}}',
    reorderHint: 'Drag to reorder',
    // Recently viewed strip
    recentTitle: 'Recently viewed',
    clear: 'Clear',
    clearAria: 'Clear recently viewed',
  },
};

export const yueShellNav: typeof enShellNav = {
  shellnav: {
    pinnedTitle: '釘住',
    unpin: '除釘',
    pinAria: '釘住 {{name}}',
    unpinAria: '除低 {{name}} 個釘',
    openAria: '打開 {{name}}',
    reorderHint: '拖曳可以調位',
    recentTitle: '啱啱睇過',
    clear: '清走',
    clearAria: '清走啱啱睇過嘅紀錄',
  },
};
