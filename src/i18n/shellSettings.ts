// Shell settings-page strings (namespace `shellsettings`). Kept in a dedicated
// file so the settings agent never collides with concurrent edits to en.ts /
// zh-Hant.ts. The orchestrator merges `enShellSettings` into the EN bundle and
// `yueShellSettings` into the 粵語 (Traditional Chinese) bundle. Parity is
// enforced by the `typeof enShellSettings` annotation below.

export const enShellSettings = {
  shellsettings: {
    // Page chrome
    title: 'Settings',
    subtitle: 'Tune how WinForge looks and behaves.',
    searchPlaceholder: 'Search settings…',
    noResults: 'No settings match “{{query}}”.',
    resultCount: '{{count}} setting',
    resultCount_other: '{{count}} settings',

    // Category headings
    catAppearance: 'Appearance',
    catLayout: 'Layout',
    catLanguage: 'Language & Region',

    // Setting: theme
    themeLabel: 'Theme',
    themeDesc: 'Light, dark, or follow your operating system.',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',

    // Setting: language
    langLabel: 'Display language',
    langDesc: 'Choose English, Cantonese (粵語), or a bilingual view.',

    // Setting: view mode
    viewModeLabel: 'Module view',
    viewModeDesc: 'Show modules as a card grid or a compact list.',
    viewModeGrid: 'Grid',
    viewModeList: 'List',

    // Setting: density
    densityLabel: 'Density',
    densityDesc: 'Spacing between cards and controls.',
    densityCompact: 'Compact',
    densityComfortable: 'Comfortable',
    densitySpacious: 'Spacious',

    // Setting: sidebar collapsed
    sidebarLabel: 'Collapse sidebar',
    sidebarDesc: 'Hide the navigation sidebar to free up space.',

    // Setting: UI scale
    uiScaleLabel: 'Interface scale',
    uiScaleDesc: 'Zoom the whole interface in or out.',
  },
};

export const yueShellSettings: typeof enShellSettings = {
  shellsettings: {
    title: '設定',
    subtitle: '調校 WinForge 嘅外觀同行為。',
    searchPlaceholder: '搜尋設定⋯',
    noResults: '搵唔到符合「{{query}}」嘅設定。',
    resultCount: '{{count}} 項設定',
    resultCount_other: '{{count}} 項設定',

    catAppearance: '外觀',
    catLayout: '版面',
    catLanguage: '語言同地區',

    themeLabel: '佈景主題',
    themeDesc: '淺色、深色，或者跟隨你嘅作業系統。',
    themeLight: '淺色',
    themeDark: '深色',
    themeSystem: '跟隨系統',

    langLabel: '顯示語言',
    langDesc: '揀英文、粵語，或者雙語顯示。',

    viewModeLabel: '模組顯示方式',
    viewModeDesc: '以卡片格狀或者精簡清單顯示模組。',
    viewModeGrid: '格狀',
    viewModeList: '清單',

    densityLabel: '密度',
    densityDesc: '卡片同控制項之間嘅間距。',
    densityCompact: '緊湊',
    densityComfortable: '舒適',
    densitySpacious: '寬鬆',

    sidebarLabel: '收起側邊欄',
    sidebarDesc: '收埋導覽側邊欄，騰出多啲空間。',

    uiScaleLabel: '介面縮放',
    uiScaleDesc: '放大或者縮細成個介面。',
  },
};
