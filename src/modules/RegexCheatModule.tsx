import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

/** Category key (English) + i18n key suffix used for the label. */
interface Cat {
  key: string;
  labelKey: string;
}

interface Entry {
  cat: string; // English category key (matches Cat.key)
  token: string;
  descKey: string; // i18n key for the description
  example: string;
}

interface Recipe {
  nameKey: string; // i18n key for the recipe name
  pattern: string;
}

// --- Categories (English key + i18n label key) ---
const CATS: Cat[] = [
  { key: 'Character classes', labelKey: 'catChar' },
  { key: 'Anchors', labelKey: 'catAnchor' },
  { key: 'Quantifiers', labelKey: 'catQuant' },
  { key: 'Groups & backreferences', labelKey: 'catGroup' },
  { key: 'Named groups', labelKey: 'catNamed' },
  { key: 'Lookaround', labelKey: 'catLook' },
  { key: 'Alternation', labelKey: 'catAlt' },
  { key: 'Flags & options', labelKey: 'catFlags' },
  { key: 'Common recipes', labelKey: 'catRecipe' },
];

const CAT_LABEL_KEY = new Map<string, string>(CATS.map((c) => [c.key, c.labelKey]));

// Faithful port of RegexCheatService._entries. descKey maps to a t('regexcheat.<descKey>').
const ENTRIES: Entry[] = [
  // --- Character classes ---
  { cat: 'Character classes', token: '.', descKey: 'd_dot', example: 'a.c → "abc", "a-c"' },
  { cat: 'Character classes', token: '[abc]', descKey: 'd_set', example: '[aeiou] matches a vowel' },
  { cat: 'Character classes', token: '[^abc]', descKey: 'd_negset', example: '[^0-9] → non-digit' },
  { cat: 'Character classes', token: '[a-z]', descKey: 'd_range', example: '[A-Za-z0-9] alnum' },
  { cat: 'Character classes', token: '\\d', descKey: 'd_digit', example: '\\d{3} → "123"' },
  { cat: 'Character classes', token: '\\D', descKey: 'd_nondigit', example: '\\D+ → "abc"' },
  { cat: 'Character classes', token: '\\w', descKey: 'd_word', example: '\\w+ → "user_1"' },
  { cat: 'Character classes', token: '\\W', descKey: 'd_nonword', example: '\\W → " ", "!"' },
  { cat: 'Character classes', token: '\\s', descKey: 'd_space', example: 'a\\sb → "a b"' },
  { cat: 'Character classes', token: '\\S', descKey: 'd_nonspace', example: '\\S+ → "word"' },
  { cat: 'Character classes', token: '\\t', descKey: 'd_tab', example: '\\t' },
  { cat: 'Character classes', token: '\\n', descKey: 'd_newline', example: 'line1\\nline2' },
  { cat: 'Character classes', token: '\\uXXXX', descKey: 'd_unicode', example: '\\u00e9 → "é"' },
  { cat: 'Character classes', token: '\\p{L}', descKey: 'd_pl', example: '\\p{Lu} → uppercase' },
  { cat: 'Character classes', token: '\\\\', descKey: 'd_backslash', example: 'C:\\\\ → "C:\\"' },

  // --- Anchors ---
  { cat: 'Anchors', token: '^', descKey: 'd_start', example: '^Hello' },
  { cat: 'Anchors', token: '$', descKey: 'd_end', example: 'world$' },
  { cat: 'Anchors', token: '\\b', descKey: 'd_wb', example: '\\bcat\\b whole word' },
  { cat: 'Anchors', token: '\\B', descKey: 'd_nwb', example: '\\Bcat' },
  { cat: 'Anchors', token: '\\A', descKey: 'd_bigA', example: '\\AHello' },
  { cat: 'Anchors', token: '\\z', descKey: 'd_smallz', example: 'end\\z' },
  { cat: 'Anchors', token: '\\Z', descKey: 'd_bigZ', example: 'end\\Z' },
  { cat: 'Anchors', token: '\\G', descKey: 'd_bigG', example: '\\G\\d+' },

  // --- Quantifiers ---
  { cat: 'Quantifiers', token: '*', descKey: 'd_star', example: 'a* → "", "aaa"' },
  { cat: 'Quantifiers', token: '+', descKey: 'd_plus', example: 'a+ → "a", "aaa"' },
  { cat: 'Quantifiers', token: '?', descKey: 'd_opt', example: 'colou?r → "color"' },
  { cat: 'Quantifiers', token: '{n}', descKey: 'd_exact', example: '\\d{4} → "2026"' },
  { cat: 'Quantifiers', token: '{n,}', descKey: 'd_nmore', example: '\\d{2,} 2+ digits' },
  { cat: 'Quantifiers', token: '{n,m}', descKey: 'd_nm', example: '\\d{2,4}' },
  { cat: 'Quantifiers', token: '*?', descKey: 'd_lazystar', example: '<.*?> shortest tag' },
  { cat: 'Quantifiers', token: '+?', descKey: 'd_lazyplus', example: '".+?" shortest string' },
  { cat: 'Quantifiers', token: '??', descKey: 'd_lazyopt', example: 'a??' },
  { cat: 'Quantifiers', token: '*+', descKey: 'd_poss', example: 'a*+' },
  { cat: 'Quantifiers', token: '{n,m}?', descKey: 'd_lazynm', example: '\\d{2,4}?' },

  // --- Groups & backreferences ---
  { cat: 'Groups & backreferences', token: '(...)', descKey: 'd_cap', example: '(ab)+ → "abab"' },
  { cat: 'Groups & backreferences', token: '(?:...)', descKey: 'd_noncap', example: '(?:ab)+' },
  { cat: 'Groups & backreferences', token: '\\1', descKey: 'd_backref', example: '(\\w)\\1 → "aa"' },
  { cat: 'Groups & backreferences', token: '(?>...)', descKey: 'd_atomic', example: '(?>\\d+)' },
  { cat: 'Groups & backreferences', token: '(?i:...)', descKey: 'd_inlineopt', example: '(?i:abc) → "ABC"' },

  // --- Named groups ---
  { cat: 'Named groups', token: '(?<name>...)', descKey: 'd_named', example: '(?<yr>\\d{4})' },
  { cat: 'Named groups', token: "(?'name'...)", descKey: 'd_namedq', example: "(?'yr'\\d{4})" },
  { cat: 'Named groups', token: '\\k<name>', descKey: 'd_namedref', example: '(?<c>\\w)\\k<c>' },
  { cat: 'Named groups', token: '${name}', descKey: 'd_namedrepl', example: 'Regex.Replace(..., "${yr}")' },
  { cat: 'Named groups', token: '$1', descKey: 'd_numrepl', example: '"$1-$2"' },

  // --- Lookaround ---
  { cat: 'Lookaround', token: '(?=...)', descKey: 'd_plook', example: '\\d+(?= USD)' },
  { cat: 'Lookaround', token: '(?!...)', descKey: 'd_nlook', example: 'foo(?!bar)' },
  { cat: 'Lookaround', token: '(?<=...)', descKey: 'd_plookb', example: '(?<=\\$)\\d+' },
  { cat: 'Lookaround', token: '(?<!...)', descKey: 'd_nlookb', example: '(?<!\\$)\\d+' },

  // --- Alternation ---
  { cat: 'Alternation', token: 'a|b', descKey: 'd_alt', example: 'cat|dog' },
  { cat: 'Alternation', token: '(cat|dog)', descKey: 'd_galt', example: '(cat|dog)s?' },
  { cat: 'Alternation', token: '(?(1)yes|no)', descKey: 'd_cond', example: '(a)?(?(1)b|c)' },

  // --- Flags & options ---
  { cat: 'Flags & options', token: '(?i)', descKey: 'd_fi', example: '(?i)hello → "HELLO"' },
  { cat: 'Flags & options', token: '(?m)', descKey: 'd_fm', example: '(?m)^\\d+' },
  { cat: 'Flags & options', token: '(?s)', descKey: 'd_fs', example: '(?s)<.*>' },
  { cat: 'Flags & options', token: '(?x)', descKey: 'd_fx', example: '(?x) \\d+  # digits' },
  { cat: 'Flags & options', token: '(?n)', descKey: 'd_fn', example: '(?n)(a)(?<x>b)' },
  { cat: 'Flags & options', token: '(?i-s)', descKey: 'd_fis', example: '(?i-s)abc' },
  { cat: 'Flags & options', token: 'RegexOptions.Compiled', descKey: 'd_compiled', example: 'new Regex(p, RegexOptions.Compiled)' },
  { cat: 'Flags & options', token: 'RegexOptions.IgnoreCase', descKey: 'd_ignorecase', example: 'RegexOptions.IgnoreCase' },

  // --- Common recipes (as inline tokens too) ---
  { cat: 'Common recipes', token: 'Email', descKey: 'd_rEmail', example: 'user@example.com' },
  { cat: 'Common recipes', token: 'URL (http/https)', descKey: 'd_rUrl', example: 'https://a.com/x?y=1' },
  { cat: 'Common recipes', token: 'IPv4', descKey: 'd_rIpv4', example: '192.168.0.1' },
  { cat: 'Common recipes', token: 'ISO date', descKey: 'd_rIso', example: '2026-07-01' },
  { cat: 'Common recipes', token: 'Time HH:MM', descKey: 'd_rTime', example: '23:59' },
  { cat: 'Common recipes', token: 'Hex color', descKey: 'd_rHex', example: '#1e90ff' },
  { cat: 'Common recipes', token: 'UUID', descKey: 'd_rUuid', example: '9b2f...-...' },
  { cat: 'Common recipes', token: 'Slug', descKey: 'd_rSlug', example: 'my-post-title' },
];

// Faithful port of RegexCheatService._recipes.
const RECIPES: Recipe[] = [
  { nameKey: 'rEmail', pattern: '^[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}$' },
  { nameKey: 'rUrl', pattern: '^https?://[^\\s/$.?#].[^\\s]*$' },
  { nameKey: 'rIpv4', pattern: '^((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)$' },
  { nameKey: 'rHexColor', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
  { nameKey: 'rUuid', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  { nameKey: 'rSlug', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
  { nameKey: 'rIsoDate', pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' },
  { nameKey: 'rUsPhone', pattern: '^\\(?\\d{3}\\)?[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{4}$' },
];

function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
}

/**
 * Faithful port of RegexCheatService.Filter — free-text over token/description/example
 * (both the English and the localized description) plus category label, and optional category.
 * Never throws.
 */
function filterEntries(query: string, cat: string | null, t: TFunction): Entry[] {
  try {
    let list = ENTRIES;
    if (cat && cat.trim().length > 0) {
      list = list.filter((e) => e.cat.toLowerCase() === cat.toLowerCase());
    }
    const q = query.trim();
    if (q.length > 0) {
      list = list.filter((e) => {
        const labelKey = CAT_LABEL_KEY.get(e.cat);
        const catLabel = labelKey ? t(`regexcheat.${labelKey}`) : '';
        const desc = t(`regexcheat.${e.descKey}`);
        return (
          has(e.token, q) ||
          has(desc, q) ||
          has(e.example, q) ||
          has(e.cat, q) ||
          has(catLabel, q)
        );
      });
    }
    return list;
  } catch {
    return ENTRIES;
  }
}

export function RegexCheatModule() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('');
  const [copied, setCopied] = useState<string>('');

  const results = useMemo(() => filterEntries(query, cat || null, t), [query, cat, t]);

  const copy = (text: string, tag: string) => {
    try {
      if (!text) return;
      navigator.clipboard?.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1200);
    } catch {
      /* clipboard can transiently fail — swallow */
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('regexcheat.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: '1 1 240px', minWidth: 180 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('regexcheat.searchPlaceholder')}
        />
        <select className="mod-select" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{t('regexcheat.allCategories')}</option>
          {CATS.map((c) => (
            <option key={c.key} value={c.key}>
              {t(`regexcheat.${c.labelKey}`)}
            </option>
          ))}
        </select>
      </div>

      <p className="count-note">{t('regexcheat.hint')}</p>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('regexcheat.refTitle')}</h4>
        {results.length === 0 ? (
          <p className="count-note">{t('regexcheat.empty')}</p>
        ) : (
          <div className="dt-wrap" style={{ overflowX: 'auto' }}>
            <table className="dt">
              <tbody>
                {results.map((e, i) => {
                  const labelKey = CAT_LABEL_KEY.get(e.cat);
                  const catLabel = labelKey ? t(`regexcheat.${labelKey}`) : e.cat;
                  return (
                    <tr
                      key={`${e.cat}-${e.token}-${i}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => copy(e.token, `entry-${i}`)}
                      title={t('regexcheat.clickCopyToken')}
                    >
                      <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {e.token}
                        {copied === `entry-${i}` ? (
                          <span className="count-note" style={{ marginLeft: 8, color: 'var(--accent)' }}>
                            {t('regexcheat.copiedToken')}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <div>{t(`regexcheat.${e.descKey}`)}</div>
                        <div className="count-note" style={{ fontFamily: 'monospace' }}>{e.example}</div>
                      </td>
                      <td className="count-note" style={{ whiteSpace: 'nowrap' }}>{catLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>{t('regexcheat.recipeTitle')}</h4>
        <p className="count-note" style={{ marginTop: 0 }}>{t('regexcheat.recipeHint')}</p>
        <div className="dt-wrap" style={{ overflowX: 'auto' }}>
          <table className="dt">
            <tbody>
              {RECIPES.map((r, i) => (
                <tr
                  key={r.nameKey}
                  style={{ cursor: 'pointer' }}
                  onClick={() => copy(r.pattern, `recipe-${i}`)}
                  title={t('regexcheat.clickCopyPattern')}
                >
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {t(`regexcheat.${r.nameKey}`)}
                    {copied === `recipe-${i}` ? (
                      <span className="count-note" style={{ marginLeft: 8, color: 'var(--accent)' }}>
                        {t('regexcheat.copiedPattern')}
                      </span>
                    ) : null}
                  </td>
                  <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.pattern}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
