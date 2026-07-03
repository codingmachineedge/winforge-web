import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';

// Native module — Quick Accent (PowerToys poweraccent clone).
// The desktop app runs a global WH_KEYBOARD_LL keyboard hook: hold a base letter, tap the
// activation key, and a popup lists the accent variants which SendInput inserts on release.
// The browser has no global hook, so here we provide the equivalent *picker*: choose the
// character sets, preview a base letter's variants, browse the full grid, and copy a glyph.
// Inside the WinForge desktop app we can also push a glyph into the clipboard via PowerShell.

type Group = 'Language' | 'Special';

interface AccentSet {
  id: string;
  en: string;
  zh: string;
  group: Group;
  map: Record<string, string[]>; // base key (single char, upper) -> variants
}

// Ported from WinForge QuickAccentData.All (itself ported from PowerToys Quick Accent).
// Keys are the base character in canonical form: digits, A–Z, and a few punctuation keys.
const SETS: AccentSet[] = [
  {
    id: 'SPECIAL', en: 'Special / Symbols', zh: '特殊符號', group: 'Special', map: {
      '0': ['₀', '⁰', '°', '↉', '₎', '⁾'],
      '1': ['₁', '¹', '½', '⅓', '¼', '⅕', '⅙', '⅐', '⅛', '⅑', '⅒'],
      '2': ['₂', '²', '⅔', '⅖'],
      '3': ['₃', '³', '¾', '⅗', '⅜'],
      '4': ['₄', '⁴', '⅘'],
      '5': ['₅', '⁵', '⅚', '⅝'],
      '6': ['₆', '⁶'],
      '7': ['₇', '⁷', '⅞'],
      '8': ['₈', '⁸', '∞'],
      '9': ['₉', '⁹', '₍', '⁽'],
      'A': ['ȧ', 'ǽ', '∀', 'ᵃ', 'ₐ'],
      'B': ['ḃ', 'ᵇ'],
      'C': ['ċ', '°C', '©', 'ℂ', '∁', 'ᶜ'],
      'D': ['ḍ', 'ḋ', '∂', 'ᵈ'],
      'E': ['∈', '∃', '∄', '∉', 'ĕ', 'ᵉ', 'ₑ'],
      'F': ['ḟ', '°F', 'ᶠ'],
      'G': ['ģ', 'ǧ', 'ġ', 'ĝ', 'ǥ', 'ᵍ'],
      'H': ['ḣ', 'ĥ', 'ħ', 'ʰ', 'ₕ'],
      'I': ['ⁱ', 'ᵢ'],
      'J': ['ĵ', 'ʲ', 'ⱼ'],
      'K': ['ķ', 'ǩ', 'ᵏ', 'ₖ'],
      'L': ['ļ', '₺', 'ˡ', 'ₗ'],
      'M': ['ṁ', 'ᵐ', 'ₘ'],
      'N': ['ņ', 'ṅ', 'ⁿ', 'ℕ', '№', 'ₙ'],
      'O': ['ȯ', '∅', '⌀', 'ᵒ', 'ₒ'],
      'P': ['ṗ', '℗', '∏', '¶', 'ᵖ', 'ₚ'],
      'Q': ['ℚ', '𐞥'],
      'R': ['ṙ', '®', 'ℝ', 'ʳ', 'ᵣ'],
      'S': ['ṡ', '§', '∑', '∫', 'ˢ', 'ₛ'],
      'T': ['ţ', 'ṫ', 'ŧ', '™', 'ᵗ', 'ₜ'],
      'U': ['ŭ', 'ᵘ', 'ᵤ'],
      'V': ['V̇', 'ᵛ', 'ᵥ'],
      'W': ['ẇ', 'ʷ'],
      'X': ['ẋ', '×', 'ˣ', 'ₓ'],
      'Y': ['ẏ', 'ꝡ', 'ʸ'],
      'Z': ['ʒ', 'ǯ', 'ℤ', 'ᶻ'],
      ',': ['∙', '₋', '⁻', '–', '√', '‟', '《', '》', '‛', '〈', '〉', '″', '‴', '⁗'],
      '.': ['…', '⁝', '̀', '́', '̂', '̃', '̄', '̈', '̋', '̌'],
      '-': ['~', '‐', '‑', '‒', '–', '—', '―', '⁓', '−', '⸺', '⸻', '∓', '₋', '⁻'],
      '/': ['÷', '√'],
      '*': ['×', '⋅', 'ˣ', 'ₓ'],
      '+': ['≤', '≥', '≠', '≈', '≙', '⊕', '⊗', '±', '≅', '≡', '₊', '⁺', '₌', '⁼'],
      '\\': ['`', '~'],
    },
  },
  {
    id: 'CUR', en: 'Currency', zh: '貨幣符號', group: 'Special', map: {
      'B': ['฿', 'в'], 'C': ['¢', '₡', 'č'], 'D': ['₫'], 'E': ['€'], 'F': ['ƒ'],
      'H': ['₴'], 'K': ['₭'], 'L': ['ł'], 'N': ['л'], 'M': ['₼'],
      'P': ['£', '₽', '₱'], 'R': ['₹', '៛', '﷼'], 'S': ['$', '₪'],
      'T': ['₮', '₺', '₸'], 'W': ['₩'], 'Y': ['¥'], 'Z': ['z'],
    },
  },
  {
    id: 'IPA', en: 'IPA (Phonetic)', zh: '國際音標', group: 'Special', map: {
      'A': ['ɐ', 'ɑ', 'ɒ', 'ǎ'], 'B': ['ʙ'], 'E': ['ɘ', 'ɵ', 'ə', 'ɛ', 'ɜ', 'ɞ'],
      'F': ['ɟ', 'ɸ'], 'G': ['ɢ', 'ɣ'], 'H': ['ɦ', 'ʜ'], 'I': ['ɨ', 'ɪ'], 'J': ['ʝ'],
      'L': ['ɬ', 'ɮ', 'ꞎ', 'ɭ', 'ʎ', 'ʟ', 'ɺ'], 'N': ['ɳ', 'ɲ', 'ŋ', 'ɴ'],
      'O': ['ɤ', 'ɔ', 'ɶ', 'ǒ'], 'R': ['ʁ', 'ɹ', 'ɻ', 'ɾ', 'ɽ', 'ʀ'], 'S': ['ʃ', 'ʂ', 'ɕ'],
      'U': ['ʉ', 'ʊ', 'ǔ'], 'V': ['ʋ', 'ⱱ', 'ʌ'], 'W': ['ɰ', 'ɯ'], 'Y': ['ʏ'],
      'Z': ['ʒ', 'ʐ', 'ʑ'], ',': ['ʡ', 'ʔ', 'ʕ', 'ʢ'],
    },
  },
  {
    id: 'CA', en: 'Catalan', zh: '加泰隆尼亞文', group: 'Language', map: {
      '1': ['¡'], 'A': ['à', 'á'], 'C': ['ç'], 'E': ['è', 'é', '€'], 'I': ['ì', 'í', 'ï'],
      'N': ['ñ'], 'O': ['ò', 'ó'], 'U': ['ù', 'ú', 'ü'], 'L': ['·'],
      ',': ['¿', '?', '¡', '!', '«', '»', '“', '”', '‘', '’'], '/': ['¿'],
    },
  },
  {
    id: 'HR', en: 'Croatian', zh: '克羅地亞文', group: 'Language', map: {
      'C': ['ć', 'č'], 'D': ['đ'], 'E': ['€'], 'S': ['š'], 'Z': ['ž'],
      ',': ['„', '“', '»', '«'],
    },
  },
  {
    id: 'CZ', en: 'Czech', zh: '捷克文', group: 'Language', map: {
      'A': ['á'], 'C': ['č'], 'D': ['ď'], 'E': ['ě', 'é'], 'I': ['í'], 'N': ['ň'],
      'O': ['ó'], 'R': ['ř'], 'S': ['š'], 'T': ['ť'], 'U': ['ů', 'ú'], 'Y': ['ý'], 'Z': ['ž'],
      ',': ['„', '“', '‚', '‘', '»', '«', '›', '‹'],
    },
  },
  {
    id: 'DK', en: 'Danish', zh: '丹麥文', group: 'Language', map: {
      'A': ['å', 'æ'], 'E': ['€'], 'O': ['ø'], ',': ['»', '«', '“', '”', '›', '‹', '‘', '’'],
    },
  },
  {
    id: 'NL', en: 'Dutch', zh: '荷蘭文', group: 'Language', map: {
      'A': ['á', 'à', 'ä'], 'C': ['ç'], 'E': ['é', 'è', 'ë', 'ê', '€'], 'I': ['í', 'ï', 'î'],
      'N': ['ñ'], 'O': ['ó', 'ö', 'ô'], 'U': ['ú', 'ü', 'û'], ',': ['“', '„', '”', '‘', ',', '’'],
    },
  },
  {
    id: 'EPO', en: 'Esperanto', zh: '世界語', group: 'Language', map: {
      'C': ['ĉ'], 'G': ['ĝ'], 'H': ['ĥ'], 'J': ['ĵ'], 'S': ['ŝ'], 'U': ['ŭ'],
    },
  },
  {
    id: 'EST', en: 'Estonian', zh: '愛沙尼亞文', group: 'Language', map: {
      'A': ['ä'], 'E': ['€'], 'O': ['ö', 'õ'], 'U': ['ü'], 'Z': ['ž'], 'S': ['š'],
      ',': ['„', '“', '«', '»'],
    },
  },
  {
    id: 'FI', en: 'Finnish', zh: '芬蘭文', group: 'Language', map: {
      'A': ['ä', 'å'], 'E': ['€'], 'O': ['ö'], ',': ['”', '’', '»'],
    },
  },
  {
    id: 'FR', en: 'French', zh: '法文', group: 'Language', map: {
      'A': ['à', 'â', 'á', 'ä', 'ã', 'æ'], 'C': ['ç'], 'E': ['é', 'è', 'ê', 'ë', '€'],
      'I': ['î', 'ï', 'í', 'ì'], 'O': ['ô', 'ö', 'ó', 'ò', 'õ', 'œ'], 'U': ['û', 'ù', 'ü', 'ú'],
      'Y': ['ÿ', 'ý'], ',': ['«', '»', '‹', '›', '“', '”', '‘', '’'],
    },
  },
  {
    id: 'DE', en: 'German', zh: '德文', group: 'Language', map: {
      'A': ['ä'], 'E': ['€'], 'O': ['ö'], 'S': ['ß'], 'U': ['ü'],
      ',': ['„', '“', '‚', '‘', '»', '«', '›', '‹'],
    },
  },
  {
    id: 'EL', en: 'Greek', zh: '希臘文', group: 'Language', map: {
      'A': ['α', 'ά'], 'B': ['β'], 'C': ['χ'], 'D': ['δ'], 'E': ['ε', 'έ', 'η', 'ή'],
      'F': ['φ'], 'G': ['γ'], 'I': ['ι', 'ί'], 'K': ['κ'], 'L': ['λ'], 'M': ['μ'], 'N': ['ν'],
      'O': ['ο', 'ό', 'ω', 'ώ'], 'P': ['π', 'φ', 'ψ'], 'R': ['ρ'], 'S': ['σ', 'ς'],
      'T': ['τ', 'θ', 'ϑ'], 'U': ['υ', 'ύ'], 'X': ['ξ'], 'Y': ['υ'], 'Z': ['ζ'],
      ',': ['“', '”', '«', '»'],
    },
  },
  {
    id: 'HU', en: 'Hungarian', zh: '匈牙利文', group: 'Language', map: {
      'A': ['á'], 'E': ['é'], 'I': ['í'], 'O': ['ó', 'ő', 'ö'], 'U': ['ú', 'ű', 'ü'],
      'Y': ['ÿ', 'ý'], ',': ['„', '”', '»', '«'],
    },
  },
  {
    id: 'IS', en: 'Icelandic', zh: '冰島文', group: 'Language', map: {
      'A': ['á', 'æ'], 'D': ['ð'], 'E': ['é'], 'I': ['í'], 'O': ['ó', 'ö'], 'U': ['ú'],
      'Y': ['ý'], 'T': ['þ'], ',': ['„', '“', '‚', '‘'],
    },
  },
  {
    id: 'IT', en: 'Italian', zh: '意大利文', group: 'Language', map: {
      'A': ['à'], 'E': ['è', 'é', 'ə', '€'], 'I': ['ì', 'í'], 'O': ['ò', 'ó'], 'U': ['ù', 'ú'],
      ',': ['«', '»', '“', '”', '‘', '’'],
    },
  },
  {
    id: 'LT', en: 'Lithuanian', zh: '立陶宛文', group: 'Language', map: {
      'A': ['ą'], 'C': ['č'], 'E': ['ę', 'ė', '€'], 'I': ['į'], 'S': ['š'], 'U': ['ų', 'ū'],
      'Z': ['ž'], ',': ['„', '“', '‚', '‘'],
    },
  },
  {
    id: 'MI', en: 'Maori', zh: '毛利文', group: 'Language', map: {
      'A': ['ā'], 'E': ['ē'], 'I': ['ī'], 'O': ['ō'], 'S': ['$'], 'U': ['ū'],
      ',': ['“', '”', '‘', '’'],
    },
  },
  {
    id: 'NO', en: 'Norwegian', zh: '挪威文', group: 'Language', map: {
      'A': ['å', 'æ'], 'E': ['€', 'é'], 'O': ['ø'], 'S': ['$'],
      ',': ['«', '»', ',', '‘', '’', '„', '“'],
    },
  },
  {
    id: 'PI', en: 'Pinyin', zh: '拼音', group: 'Language', map: {
      '1': ['̄', 'ˉ'], '2': ['́', 'ˊ'], '3': ['̌', 'ˇ'], '4': ['̀', 'ˋ'], '5': ['·'],
      'A': ['ā', 'á', 'ǎ', 'à', 'ɑ'], 'C': ['ĉ'], 'E': ['ē', 'é', 'ě', 'è', 'ê'],
      'I': ['ī', 'í', 'ǐ', 'ì'], 'O': ['ō', 'ó', 'ǒ', 'ò'], 'S': ['ŝ'],
      'U': ['ū', 'ú', 'ǔ', 'ù', 'ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'], 'V': ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
      'Y': ['¥'], 'Z': ['ẑ'], ',': ['“', '”', '‘', '’', '「', '」', '『', '』'],
    },
  },
  {
    id: 'PL', en: 'Polish', zh: '波蘭文', group: 'Language', map: {
      'A': ['ą'], 'C': ['ć'], 'E': ['ę', '€'], 'L': ['ł'], 'N': ['ń'], 'O': ['ó'],
      'S': ['ś'], 'Z': ['ż', 'ź'], ',': ['„', '”', '‘', '’', '»', '«'],
    },
  },
  {
    id: 'PT', en: 'Portuguese', zh: '葡萄牙文', group: 'Language', map: {
      'A': ['á', 'à', 'â', 'ã', 'ª'], 'C': ['ç'], 'E': ['é', 'ê', '€'], 'I': ['í'],
      'O': ['ô', 'ó', 'õ', 'º'], 'S': ['$'], 'U': ['ú'], ',': ['“', '”', '‘', '’', '«', '»'],
    },
  },
  {
    id: 'RO', en: 'Romanian', zh: '羅馬尼亞文', group: 'Language', map: {
      'A': ['ă', 'â'], 'I': ['î'], 'S': ['ș'], 'T': ['ț'], ',': ['„', '”', '«', '»'],
    },
  },
  {
    id: 'SK', en: 'Slovak', zh: '斯洛伐克文', group: 'Language', map: {
      'A': ['á', 'ä'], 'C': ['č'], 'D': ['ď'], 'E': ['é', '€'], 'I': ['í'], 'L': ['ľ', 'ĺ'],
      'N': ['ň'], 'O': ['ó', 'ô'], 'R': ['ŕ'], 'S': ['š'], 'T': ['ť'], 'U': ['ú'], 'Y': ['ý'],
      'Z': ['ž'], ',': ['„', '“', '‚', '‘', '»', '«', '›', '‹'],
    },
  },
  {
    id: 'SL', en: 'Slovenian', zh: '斯洛文尼亞文', group: 'Language', map: {
      'C': ['č', 'ć'], 'E': ['€'], 'S': ['š'], 'Z': ['ž'], ',': ['„', '“', '»', '«'],
    },
  },
  {
    id: 'SP', en: 'Spanish', zh: '西班牙文', group: 'Language', map: {
      '1': ['¡'], 'A': ['á'], 'E': ['é', '€'], 'H': ['ḥ'], 'I': ['í'], 'L': ['ḷ'], 'N': ['ñ'],
      'O': ['ó'], 'U': ['ú', 'ü'], ',': ['¿', '?', '¡', '!', '«', '»', '“', '”', '‘', '’'], '/': ['¿'],
    },
  },
  {
    id: 'SV', en: 'Swedish', zh: '瑞典文', group: 'Language', map: {
      'A': ['å', 'ä'], 'E': ['é'], 'O': ['ö'], ',': ['”', '’', '»', '«'],
    },
  },
  {
    id: 'TK', en: 'Turkish', zh: '土耳其文', group: 'Language', map: {
      'A': ['â'], 'C': ['ç'], 'E': ['ë', '€'], 'G': ['ğ'], 'I': ['ı', 'İ', 'î'],
      'O': ['ö', 'ô'], 'S': ['ş'], 'T': ['₺'], 'U': ['ü', 'û'],
      ',': ['“', '”', '‘', '’', '«', '»', '‹', '›'],
    },
  },
  {
    id: 'VI', en: 'Vietnamese', zh: '越南文', group: 'Language', map: {
      'A': ['à', 'ả', 'ã', 'á', 'ạ', 'ă', 'ằ', 'ẳ', 'ẵ', 'ắ', 'ặ', 'â', 'ầ', 'ẩ', 'ẫ', 'ấ', 'ậ'],
      'D': ['đ'], 'E': ['è', 'ẻ', 'ẽ', 'é', 'ẹ', 'ê', 'ề', 'ể', 'ễ', 'ế', 'ệ'],
      'I': ['ì', 'ỉ', 'ĩ', 'í', 'ị'],
      'O': ['ò', 'ỏ', 'õ', 'ó', 'ọ', 'ô', 'ồ', 'ổ', 'ỗ', 'ố', 'ộ', 'ơ', 'ờ', 'ở', 'ỡ', 'ớ', 'ợ'],
      'U': ['ù', 'ủ', 'ũ', 'ú', 'ụ', 'ư', 'ừ', 'ử', 'ữ', 'ứ', 'ự'], 'Y': ['ỳ', 'ỷ', 'ỹ', 'ý', 'ỵ'],
    },
  },
  {
    id: 'WELSH', en: 'Welsh', zh: '威爾斯文', group: 'Language', map: {
      'A': ['â', 'ä', 'à', 'á'], 'E': ['ê', 'ë', 'è', 'é'], 'I': ['î', 'ï', 'ì', 'í'],
      'O': ['ô', 'ö', 'ò', 'ó'], 'P': ['£'], 'U': ['û', 'ü', 'ù', 'ú'],
      'Y': ['ŷ', 'ÿ', 'ỳ', 'ý'], 'W': ['ŵ', 'ẅ', 'ẁ', 'ẃ'], ',': ['‘', '’', '“', '”'],
    },
  },
];

const ALL_ID = 'ALL';
const ORDER: Group[] = ['Language', 'Special'];

// Canonical base key from a typed character (mirrors QuickAccentData letter keys).
function baseKeyOf(ch: string): string | null {
  if (!ch) return null;
  const up = ch.toUpperCase();
  const c0 = up[0];
  if (c0 === undefined) return null;
  if ((c0 >= 'A' && c0 <= 'Z') || (c0 >= '0' && c0 <= '9')) return c0;
  if (',.-/*+\\'.includes(c0)) return c0;
  return null;
}

// PowerShell escape for a single-quoted literal.
const psEsc = (s: string) => s.replace(/'/g, "''");

export function QuickAccentModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [selected, setSelected] = useState<Set<string>>(() => new Set([ALL_ID]));
  const [preview, setPreview] = useState('a');
  const [copied, setCopied] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const allOn = selected.has(ALL_ID);

  // Effective set ids (ALL expands to every set).
  const effective = useMemo<string[]>(
    () => (allOn ? SETS.map((s) => s.id) : SETS.filter((s) => selected.has(s.id)).map((s) => s.id)),
    [allOn, selected],
  );
  const effectiveIds = useMemo(() => new Set(effective), [effective]);

  // Combined, deduplicated variants for a base key across the selected sets (Language before Special).
  const variantsFor = useMemo(() => {
    return (key: string): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const grp of ORDER) {
        for (const set of SETS) {
          if (set.group !== grp || !effectiveIds.has(set.id)) continue;
          const chars = set.map[key];
          if (!chars) continue;
          for (const c of chars) {
            if (!seen.has(c)) {
              seen.add(c);
              out.push(c);
            }
          }
        }
      }
      return out;
    };
  }, [effectiveIds]);

  const previewKey = baseKeyOf(preview);
  const previewVariants = previewKey ? variantsFor(previewKey) : [];

  // Every base key present in any selected set, for the browse grid.
  const gridKeys = useMemo<string[]>(() => {
    const keys = new Set<string>();
    for (const set of SETS) {
      if (!effectiveIds.has(set.id)) continue;
      for (const k of Object.keys(set.map)) keys.add(k);
    }
    return Array.from(keys).sort((a, b) => a.localeCompare(b));
  }, [effectiveIds]);

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ALL_ID)) next.delete(ALL_ID);
      else next.add(ALL_ID);
      return next;
    });
  };

  const toggleSet = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(ALL_ID);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) next.add(ALL_ID); // never empty (mirrors CommitFromControls)
      return next;
    });
  };

  const copy = async (ch: string) => {
    setNote(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(ch);
        setCopied(ch);
        setNote(t('qaccent.copiedNote', { ch }));
        return;
      }
    } catch {
      /* fall through to desktop path */
    }
    // Fallback / desktop: set the clipboard through PowerShell.
    if (desktop) {
      try {
        const res = await runPowershell(`Set-Clipboard -Value '${psEsc(ch)}'`);
        if (res.success) {
          setCopied(ch);
          setNote(t('qaccent.copiedNote', { ch }));
        } else {
          setNote(res.stderr.trim() || t('qaccent.copyFailed'));
        }
      } catch (e) {
        setNote(String(e instanceof Error ? e.message : e));
      }
    } else {
      setNote(t('qaccent.copyFailed'));
    }
  };

  const groupName = (g: Group) => (g === 'Language' ? t('qaccent.groupLanguage') : t('qaccent.groupSpecial'));

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('qaccent.blurb')}</p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('qaccent.desktopOnly')}</p>}

      <p className="count-note">{t('qaccent.howto')}</p>

      {/* Preview: type a base letter, see its variants */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('qaccent.previewLabel')}</label>
            <input
              className="mod-search"
              style={{ maxWidth: 80, textAlign: 'center', fontSize: 18 }}
              value={preview}
              maxLength={1}
              onChange={(e) => { setPreview(e.target.value); setCopied(null); }}
              placeholder="a"
            />
          </div>
          {!previewKey && <p className="count-note">{t('qaccent.noBase')}</p>}
          {previewKey && previewVariants.length === 0 && (
            <p className="count-note">{t('qaccent.noVariants')}</p>
          )}
          {previewVariants.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {previewVariants.map((ch, i) => (
                <button
                  key={`${ch}-${i}`}
                  className={`mini${copied === ch ? ' primary' : ''}`}
                  title={t('qaccent.copyTitle')}
                  style={{ fontSize: 18, minWidth: 40 }}
                  onClick={() => copy(ch)}
                >
                  {ch}
                </button>
              ))}
            </div>
          )}
          <p className="count-note" style={{ marginTop: 8 }}>
            {t('qaccent.variantCount', { count: previewVariants.length })}
          </p>
        </div>
      </div>

      {note && <p className="count-note" style={{ marginTop: 8 }}>{note}</p>}

      {/* Character-set picker */}
      <div className="panel">
        <div className="dt-wrap" style={{ padding: 12 }}>
          <p className="count-note" style={{ marginTop: 0 }}>{t('qaccent.setsHint')}</p>
          <label className="chk" style={{ display: 'block', marginBottom: 6 }}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} /> {t('qaccent.allSets')}
          </label>
          {ORDER.map((grp) => (
            <div key={grp} style={{ marginBottom: 8 }}>
              <p className="label" style={{ margin: '4px 0' }}>{groupName(grp)}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {SETS.filter((s) => s.group === grp).map((s) => (
                  <label key={s.id} className="chk" style={{ minWidth: 160, opacity: allOn ? 0.55 : 1 }}>
                    <input
                      type="checkbox"
                      disabled={allOn}
                      checked={allOn || selected.has(s.id)}
                      onChange={() => toggleSet(s.id)}
                    />{' '}
                    {t(`qaccent.set.${s.id}`)}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <p className="count-note">{t('qaccent.setsSelected', { count: effective.length })}</p>
        </div>
      </div>

      {/* Browse grid: every base key and its combined variants */}
      <div className="panel">
        <div className="dt-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 60 }}>{t('qaccent.baseCol')}</th>
                <th>{t('qaccent.variantsCol')}</th>
              </tr>
            </thead>
            <tbody>
              {gridKeys.length === 0 && (
                <tr><td colSpan={2} className="count-note">{t('qaccent.emptyGrid')}</td></tr>
              )}
              {gridKeys.map((key) => {
                const vs = variantsFor(key);
                if (vs.length === 0) return null;
                return (
                  <tr key={key}>
                    <td style={{ fontFamily: 'monospace', fontSize: 16, textAlign: 'center' }}>{key}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {vs.map((ch, i) => (
                          <button
                            key={`${ch}-${i}`}
                            className={`mini${copied === ch ? ' primary' : ''}`}
                            title={t('qaccent.copyTitle')}
                            style={{ fontSize: 16, minWidth: 34, padding: '2px 6px' }}
                            onClick={() => copy(ch)}
                          >
                            {ch}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="count-note">{t('qaccent.hookNote')}</p>
    </div>
  );
}
