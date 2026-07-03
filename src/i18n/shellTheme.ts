// Shell theme-toggle strings (namespace `shelltheme`). Kept in a dedicated file
// so the theme agent never collides with concurrent edits to en.ts / zh-Hant.ts.
// The orchestrator merges `enShellTheme` into the EN bundle and `yueShellTheme`
// into the 粵語 (Traditional Chinese) bundle. Parity is enforced by the
// `typeof enShellTheme` annotation below.

export const enShellTheme = {
  shelltheme: {
    themeLabel: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    // Concise label for the current mode shown beside the icon.
    lightShort: 'Light',
    darkShort: 'Dark',
    systemShort: 'System',
    // aria-label / tooltip on the toggle. {{mode}} is the current mode name;
    // {{next}} is the mode a click will switch to.
    toggleAria: 'Theme: {{mode}}. Click to switch to {{next}}.',
    tooltip: 'Switch theme (currently {{mode}})',
    // Shown in verbose contexts when System resolves to a concrete scheme.
    systemFollowing: 'System ({{resolved}})',
  },
};

export const yueShellTheme: typeof enShellTheme = {
  shelltheme: {
    themeLabel: '佈景主題',
    light: '淺色',
    dark: '深色',
    system: '跟隨系統',
    lightShort: '淺色',
    darkShort: '深色',
    systemShort: '系統',
    toggleAria: '佈景主題：{{mode}}。㩒一下轉去{{next}}。',
    tooltip: '切換佈景主題（而家係{{mode}}）',
    systemFollowing: '跟隨系統（{{resolved}}）',
  },
};
