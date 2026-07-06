// Material 3 shell chrome strings: navigation rail labels (short forms that fit
// under a 56px rail pill), the modal drawer, and the top-app-bar search field.
// Kept in a dedicated eager slice (single `shellm3` namespace) so it never
// collides with concurrent edits to en.ts / zh-Hant.ts — same pattern as
// shellNav.ts. Registered in i18n/index.ts (enAll/yueAll) and mirrored into the
// moduleKeys guard-test bundles.
//
// 粵語 is natural spoken-style Cantonese written in Traditional Chinese
// (WinForge house style — 嘅/唔/撳), not Mandarin-flavoured 書面語.

export const enShellM3 = {
  shellm3: {
    // Navigation rail
    menu: 'Menu',
    closeMenu: 'Close menu',
    railModules: 'Modules',
    railSimulations: 'Simulations',
    railReactor: 'Reactor',
    railSettings: 'Settings',
    railAbout: 'About',
    reactorShortcut: 'Open the reactor control room',
    // Modal drawer
    drawerNav: 'Sections and pages',
  },
};

export const yueShellM3: typeof enShellM3 = {
  shellm3: {
    menu: '選單',
    closeMenu: '閂埋選單',
    railModules: '模組',
    railSimulations: '模擬',
    railReactor: '反應堆',
    railSettings: '設定',
    railAbout: '關於',
    reactorShortcut: '打開反應堆控制室',
    drawerNav: '分類同頁面',
  },
};
