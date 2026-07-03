// Translations for feature/modules-batch-b modules (N–Z web-capable tools).
// Kept in a dedicated file so the batch-B agent never collides with concurrent
// edits to en.ts / zh-Hant.ts. Merged into the main bundles by index.ts.
// Each entry is a module namespace; EN and 粵語 (Traditional Chinese) side by side.

export const enB = {
  slugify: {
    separator: 'Separator',
    hyphen: 'Hyphen ( - )',
    underscore: 'Underscore ( _ )',
    dot: 'Dot ( . )',
    case: 'Case',
    lower: 'lowercase',
    upper: 'UPPERCASE',
    keep: 'Keep as-is',
    maxLength: 'Max length (0 = ∞)',
    strip: 'Strip accents (café→cafe)',
    collapse: 'Collapse repeats',
    unicode: 'Keep unicode letters (中文)',
    copy: 'Copy',
    copied: 'Copied ✓',
    preview: 'Before → after',
    typeSomething: '(type something above)',
    empty: '(empty)',
    inputPlaceholder: 'Text — one slug per line…',
    outputPlaceholder: 'Slugs…',
  },
};

export const yueB = {
  slugify: {
    separator: '分隔符',
    hyphen: '連字號（ - ）',
    underscore: '底線（ _ ）',
    dot: '點（ . ）',
    case: '大小寫',
    lower: '細楷',
    upper: '大楷',
    keep: '維持原樣',
    maxLength: '最長長度（0 = ∞）',
    strip: '去除重音（café→cafe）',
    collapse: '合併重複符號',
    unicode: '保留 Unicode 字母（中文）',
    copy: '複製',
    copied: '已複製 ✓',
    preview: '轉換前 → 後',
    typeSomething: '（喺上面輸入啲文字）',
    empty: '（空）',
    inputPlaceholder: '文字 — 每行一個別名…',
    outputPlaceholder: '別名…',
  },
};
