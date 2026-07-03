import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge SymbolsService — curated Unicode glyph sets grouped by
// category. Pick a category, search by name, click a symbol to copy it. Never throws.

interface SymbolItem {
  symbol: string;
  /** English name for search. */
  en: string;
  /** 粵語 name for search. */
  zh: string;
  category: string;
}

interface CategoryDef {
  en: string;
  zh: string;
  items: SymbolItem[];
}

const s = (symbol: string, en: string, zh: string, category: string): SymbolItem => ({
  symbol,
  en,
  zh,
  category,
});

const C_ARROWS = 'Arrows';
const C_MATH = 'Math';
const C_CURRENCY = 'Currency';
const C_PUNCT = 'Punctuation';
const C_GREEK = 'Greek';
const C_BOX = 'Box Drawing';
const C_STARS = 'Stars & Bullets';
const C_FRAC = 'Fractions';
const C_SUP = 'Super / Subscript';

const arrows: SymbolItem[] = [
  s('←', 'Left arrow', '左箭嘴', C_ARROWS), s('→', 'Right arrow', '右箭嘴', C_ARROWS),
  s('↑', 'Up arrow', '上箭嘴', C_ARROWS), s('↓', 'Down arrow', '下箭嘴', C_ARROWS),
  s('↔', 'Left-right arrow', '左右箭嘴', C_ARROWS), s('↕', 'Up-down arrow', '上下箭嘴', C_ARROWS),
  s('↖', 'Up-left arrow', '左上箭嘴', C_ARROWS), s('↗', 'Up-right arrow', '右上箭嘴', C_ARROWS),
  s('↘', 'Down-right arrow', '右下箭嘴', C_ARROWS), s('↙', 'Down-left arrow', '左下箭嘴', C_ARROWS),
  s('⇐', 'Double left', '雙左箭嘴', C_ARROWS), s('⇒', 'Double right', '雙右箭嘴', C_ARROWS),
  s('⇑', 'Double up', '雙上箭嘴', C_ARROWS), s('⇓', 'Double down', '雙下箭嘴', C_ARROWS),
  s('⇔', 'Double left-right', '雙左右箭嘴', C_ARROWS), s('⟵', 'Long left', '長左箭嘴', C_ARROWS),
  s('⟶', 'Long right', '長右箭嘴', C_ARROWS), s('↩', 'Return left', '回轉左', C_ARROWS),
  s('↪', 'Return right', '回轉右', C_ARROWS), s('⤴', 'Arrow up-right curve', '上翹箭嘴', C_ARROWS),
  s('⤵', 'Arrow down-right curve', '下翹箭嘴', C_ARROWS), s('↻', 'Clockwise', '順時針', C_ARROWS),
  s('↺', 'Anticlockwise', '逆時針', C_ARROWS), s('➜', 'Heavy arrow', '粗箭嘴', C_ARROWS),
];

const math: SymbolItem[] = [
  s('±', 'Plus-minus', '正負', C_MATH), s('×', 'Times', '乘', C_MATH),
  s('÷', 'Divide', '除', C_MATH), s('∑', 'Summation', '總和', C_MATH),
  s('∏', 'Product', '連乘', C_MATH), s('∫', 'Integral', '積分', C_MATH),
  s('∂', 'Partial', '偏微分', C_MATH), s('∇', 'Nabla', '梯度算子', C_MATH),
  s('√', 'Square root', '根號', C_MATH), s('∛', 'Cube root', '立方根', C_MATH),
  s('≠', 'Not equal', '唔等於', C_MATH), s('≈', 'Approx', '約等於', C_MATH),
  s('≡', 'Identical', '恆等', C_MATH), s('≤', 'Less-equal', '細過或等', C_MATH),
  s('≥', 'Greater-equal', '大過或等', C_MATH), s('∞', 'Infinity', '無限', C_MATH),
  s('∈', 'Element of', '屬於', C_MATH), s('∉', 'Not element', '唔屬於', C_MATH),
  s('⊂', 'Subset', '子集', C_MATH), s('⊆', 'Subset-equal', '子集或等', C_MATH),
  s('∪', 'Union', '聯集', C_MATH), s('∩', 'Intersection', '交集', C_MATH),
  s('∀', 'For all', '對於所有', C_MATH), s('∃', 'Exists', '存在', C_MATH),
  s('∅', 'Empty set', '空集', C_MATH), s('∝', 'Proportional', '成比例', C_MATH),
  s('∠', 'Angle', '角', C_MATH), s('°', 'Degree', '度', C_MATH),
  s('µ', 'Micro', '微', C_MATH), s('π', 'Pi', '圓周率', C_MATH),
  s('∴', 'Therefore', '所以', C_MATH), s('∵', 'Because', '因為', C_MATH),
];

const currency: SymbolItem[] = [
  s('$', 'Dollar', '美元', C_CURRENCY), s('€', 'Euro', '歐元', C_CURRENCY),
  s('£', 'Pound', '英鎊', C_CURRENCY), s('¥', 'Yen / Yuan', '日圓／人民幣', C_CURRENCY),
  s('₿', 'Bitcoin', '比特幣', C_CURRENCY), s('₩', 'Won', '韓圜', C_CURRENCY),
  s('₹', 'Rupee', '印度盧比', C_CURRENCY), s('₽', 'Ruble', '俄羅斯盧布', C_CURRENCY),
  s('₴', 'Hryvnia', '烏克蘭格里夫納', C_CURRENCY), s('₫', 'Dong', '越南盾', C_CURRENCY),
  s('₱', 'Peso', '菲律賓披索', C_CURRENCY), s('₡', 'Colon', '哥斯達黎加科朗', C_CURRENCY),
  s('₪', 'Shekel', '以色列謝克爾', C_CURRENCY), s('₭', 'Kip', '老撾基普', C_CURRENCY),
  s('₮', 'Tugrik', '蒙古圖格里克', C_CURRENCY), s('₦', 'Naira', '奈及利亞奈拉', C_CURRENCY),
  s('¢', 'Cent', '仙', C_CURRENCY), s('₲', 'Guarani', '瓜拉尼', C_CURRENCY),
  s('₺', 'Lira', '土耳其里拉', C_CURRENCY), s('﷼', 'Rial', '里亞爾', C_CURRENCY),
];

const punct: SymbolItem[] = [
  s('…', 'Ellipsis', '省略號', C_PUNCT), s('—', 'Em dash', '破折號', C_PUNCT),
  s('–', 'En dash', '連接號', C_PUNCT), s('«', 'Left guillemet', '左書名號', C_PUNCT),
  s('»', 'Right guillemet', '右書名號', C_PUNCT), s('„', 'Low quote', '低引號', C_PUNCT),
  s('“', 'Left double quote', '左雙引號', C_PUNCT), s('”', 'Right double quote', '右雙引號', C_PUNCT),
  s('‘', 'Left single quote', '左單引號', C_PUNCT), s('’', 'Right single quote', '右單引號', C_PUNCT),
  s('•', 'Bullet', '圓點', C_PUNCT), s('·', 'Middle dot', '間隔號', C_PUNCT),
  s('†', 'Dagger', '劍標', C_PUNCT), s('‡', 'Double dagger', '雙劍標', C_PUNCT),
  s('§', 'Section', '章節符', C_PUNCT), s('¶', 'Pilcrow', '段落符', C_PUNCT),
  s('©', 'Copyright', '版權', C_PUNCT), s('®', 'Registered', '註冊商標', C_PUNCT),
  s('™', 'Trademark', '商標', C_PUNCT), s('‰', 'Per mille', '千分號', C_PUNCT),
  s('¡', 'Inverted !', '倒感嘆號', C_PUNCT), s('¿', 'Inverted ?', '倒問號', C_PUNCT),
  s('〜', 'Wave dash', '波浪號', C_PUNCT), s('　', 'Ideographic space', '全形空格', C_PUNCT),
];

const greek: SymbolItem[] = [
  s('α', 'Alpha', '阿爾法', C_GREEK), s('β', 'Beta', '貝塔', C_GREEK),
  s('γ', 'Gamma', '伽瑪', C_GREEK), s('δ', 'Delta', '德爾塔', C_GREEK),
  s('ε', 'Epsilon', '艾普西龍', C_GREEK), s('ζ', 'Zeta', '澤塔', C_GREEK),
  s('η', 'Eta', '伊塔', C_GREEK), s('θ', 'Theta', '西塔', C_GREEK),
  s('ι', 'Iota', '約塔', C_GREEK), s('κ', 'Kappa', '卡帕', C_GREEK),
  s('λ', 'Lambda', '蘭姆達', C_GREEK), s('μ', 'Mu', '繆', C_GREEK),
  s('ν', 'Nu', '紐', C_GREEK), s('ξ', 'Xi', '克西', C_GREEK),
  s('π', 'Pi', '派', C_GREEK), s('ρ', 'Rho', '柔', C_GREEK),
  s('σ', 'Sigma', '西格瑪', C_GREEK), s('τ', 'Tau', '陶', C_GREEK),
  s('φ', 'Phi', '斐', C_GREEK), s('χ', 'Chi', '希', C_GREEK),
  s('ψ', 'Psi', '普西', C_GREEK), s('ω', 'Omega (small)', '細寫奧米加', C_GREEK),
  s('Γ', 'Gamma cap', '大寫伽瑪', C_GREEK), s('Δ', 'Delta cap', '大寫德爾塔', C_GREEK),
  s('Θ', 'Theta cap', '大寫西塔', C_GREEK), s('Λ', 'Lambda cap', '大寫蘭姆達', C_GREEK),
  s('Π', 'Pi cap', '大寫派', C_GREEK), s('Σ', 'Sigma cap', '大寫西格瑪', C_GREEK),
  s('Φ', 'Phi cap', '大寫斐', C_GREEK), s('Ψ', 'Psi cap', '大寫普西', C_GREEK),
  s('Ω', 'Omega', '奧米加', C_GREEK),
];

const box: SymbolItem[] = [
  s('─', 'Horizontal', '橫線', C_BOX), s('│', 'Vertical', '直線', C_BOX),
  s('┌', 'Down-right', '左上角', C_BOX), s('┐', 'Down-left', '右上角', C_BOX),
  s('└', 'Up-right', '左下角', C_BOX), s('┘', 'Up-left', '右下角', C_BOX),
  s('├', 'Vertical-right', '左T', C_BOX), s('┤', 'Vertical-left', '右T', C_BOX),
  s('┬', 'Down-horizontal', '上T', C_BOX), s('┴', 'Up-horizontal', '下T', C_BOX),
  s('┼', 'Cross', '十字', C_BOX), s('═', 'Double horizontal', '雙橫線', C_BOX),
  s('║', 'Double vertical', '雙直線', C_BOX), s('╔', 'Double down-right', '雙左上角', C_BOX),
  s('╗', 'Double down-left', '雙右上角', C_BOX), s('╚', 'Double up-right', '雙左下角', C_BOX),
  s('╝', 'Double up-left', '雙右下角', C_BOX), s('╬', 'Double cross', '雙十字', C_BOX),
  s('╭', 'Round down-right', '圓左上角', C_BOX), s('╮', 'Round down-left', '圓右上角', C_BOX),
  s('╰', 'Round up-right', '圓左下角', C_BOX), s('╯', 'Round up-left', '圓右下角', C_BOX),
  s('░', 'Light shade', '淺陰影', C_BOX), s('▒', 'Medium shade', '中陰影', C_BOX),
  s('▓', 'Dark shade', '深陰影', C_BOX), s('█', 'Full block', '實心塊', C_BOX),
];

const stars: SymbolItem[] = [
  s('★', 'Black star', '實心星', C_STARS), s('☆', 'White star', '空心星', C_STARS),
  s('✦', 'Four-point star', '四角星', C_STARS), s('✧', 'White four-point', '空心四角星', C_STARS),
  s('✪', 'Circled star', '圓星', C_STARS), s('✯', 'Pinwheel star', '風車星', C_STARS),
  s('❋', 'Heavy flower', '花星', C_STARS), s('●', 'Black circle', '實心圓', C_STARS),
  s('○', 'White circle', '空心圓', C_STARS), s('◉', 'Fisheye', '牛眼', C_STARS),
  s('◆', 'Black diamond', '實心菱', C_STARS), s('◇', 'White diamond', '空心菱', C_STARS),
  s('■', 'Black square', '實心方', C_STARS), s('□', 'White square', '空心方', C_STARS),
  s('▪', 'Small black square', '細實心方', C_STARS), s('▫', 'Small white square', '細空心方', C_STARS),
  s('▶', 'Play right', '右三角', C_STARS), s('◀', 'Play left', '左三角', C_STARS),
  s('▲', 'Up triangle', '上三角', C_STARS), s('▼', 'Down triangle', '下三角', C_STARS),
  s('✔', 'Check', '剔號', C_STARS), s('✗', 'Cross mark', '叉號', C_STARS),
  s('✚', 'Heavy plus', '粗加號', C_STARS), s('❤', 'Heart', '心', C_STARS),
  s('☑', 'Ballot check', '剔格', C_STARS), s('☒', 'Ballot cross', '叉格', C_STARS),
];

const frac: SymbolItem[] = [
  s('½', 'One half', '二分一', C_FRAC), s('⅓', 'One third', '三分一', C_FRAC),
  s('⅔', 'Two thirds', '三分二', C_FRAC), s('¼', 'One quarter', '四分一', C_FRAC),
  s('¾', 'Three quarters', '四分三', C_FRAC), s('⅕', 'One fifth', '五分一', C_FRAC),
  s('⅖', 'Two fifths', '五分二', C_FRAC), s('⅗', 'Three fifths', '五分三', C_FRAC),
  s('⅘', 'Four fifths', '五分四', C_FRAC), s('⅙', 'One sixth', '六分一', C_FRAC),
  s('⅚', 'Five sixths', '六分五', C_FRAC), s('⅛', 'One eighth', '八分一', C_FRAC),
  s('⅜', 'Three eighths', '八分三', C_FRAC), s('⅝', 'Five eighths', '八分五', C_FRAC),
  s('⅞', 'Seven eighths', '八分七', C_FRAC), s('⅐', 'One seventh', '七分一', C_FRAC),
  s('⅑', 'One ninth', '九分一', C_FRAC), s('⅒', 'One tenth', '十分一', C_FRAC),
];

const sup: SymbolItem[] = [
  s('⁰', 'Superscript 0', '上標0', C_SUP), s('¹', 'Superscript 1', '上標1', C_SUP),
  s('²', 'Superscript 2', '上標2', C_SUP), s('³', 'Superscript 3', '上標3', C_SUP),
  s('⁴', 'Superscript 4', '上標4', C_SUP), s('⁵', 'Superscript 5', '上標5', C_SUP),
  s('⁶', 'Superscript 6', '上標6', C_SUP), s('⁷', 'Superscript 7', '上標7', C_SUP),
  s('⁸', 'Superscript 8', '上標8', C_SUP), s('⁹', 'Superscript 9', '上標9', C_SUP),
  s('ⁿ', 'Superscript n', '上標n', C_SUP), s('⁺', 'Superscript +', '上標加', C_SUP),
  s('⁻', 'Superscript -', '上標減', C_SUP), s('₀', 'Subscript 0', '下標0', C_SUP),
  s('₁', 'Subscript 1', '下標1', C_SUP), s('₂', 'Subscript 2', '下標2', C_SUP),
  s('₃', 'Subscript 3', '下標3', C_SUP), s('₄', 'Subscript 4', '下標4', C_SUP),
  s('₅', 'Subscript 5', '下標5', C_SUP), s('₆', 'Subscript 6', '下標6', C_SUP),
  s('₇', 'Subscript 7', '下標7', C_SUP), s('₈', 'Subscript 8', '下標8', C_SUP),
  s('₉', 'Subscript 9', '下標9', C_SUP), s('₊', 'Subscript +', '下標加', C_SUP),
  s('₋', 'Subscript -', '下標減', C_SUP),
];

const CATEGORIES: CategoryDef[] = [
  { en: C_ARROWS, zh: '箭嘴', items: arrows },
  { en: C_MATH, zh: '數學', items: math },
  { en: C_CURRENCY, zh: '貨幣', items: currency },
  { en: C_PUNCT, zh: '標點', items: punct },
  { en: C_GREEK, zh: '希臘字母', items: greek },
  { en: C_BOX, zh: '框線', items: box },
  { en: C_STARS, zh: '星與點', items: stars },
  { en: C_FRAC, zh: '分數', items: frac },
  { en: C_SUP, zh: '上下標', items: sup },
];

const ALL: SymbolItem[] = CATEGORIES.flatMap((c) => c.items);

function filterSymbols(categoryEn: string, search: string): SymbolItem[] {
  try {
    let q: SymbolItem[];
    if (!categoryEn) {
      q = ALL;
    } else {
      const cat = CATEGORIES.find((c) => c.en === categoryEn);
      q = cat ? cat.items : ALL;
    }
    const raw = (search ?? '').trim();
    if (raw) {
      const needle = raw.toLowerCase();
      q = q.filter(
        (i) =>
          i.symbol.toLowerCase().includes(needle) ||
          i.en.toLowerCase().includes(needle) ||
          i.zh.toLowerCase().includes(needle),
      );
    }
    return q;
  } catch {
    return [];
  }
}

export function SymbolsModule() {
  const { t, i18n } = useTranslation();
  const [categoryEn, setCategoryEn] = useState('');
  const [search, setSearch] = useState('');
  const [copyCount, setCopyCount] = useState(0);
  const [lastCopied, setLastCopied] = useState('');

  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  const catName = (c: CategoryDef) => (isZh ? c.zh : c.en);
  const itemName = (item: SymbolItem) => `${item.en} · ${item.zh}`;

  const items = useMemo(() => filterSymbols(categoryEn, search), [categoryEn, search]);

  const copy = (item: SymbolItem) => {
    if (!item.symbol) return;
    try {
      navigator.clipboard?.writeText(item.symbol);
      setCopyCount((n) => n + 1);
      setLastCopied(item.symbol);
    } catch {
      setLastCopied('');
    }
  };

  const status =
    copyCount > 0
      ? lastCopied
        ? t('symbols.copiedGlyph', { glyph: lastCopied, n: copyCount })
        : t('symbols.copyFailed')
      : t('symbols.countShown', { count: items.length });

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('symbols.blurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('symbols.category')}</label>
        <select
          className="mod-select"
          value={categoryEn}
          onChange={(e) => setCategoryEn(e.target.value)}
        >
          <option value="">{t('symbols.allCategories')}</option>
          {CATEGORIES.map((c) => (
            <option key={c.en} value={c.en}>
              {catName(c)}
            </option>
          ))}
        </select>
        <input
          className="mod-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('symbols.searchPlaceholder')}
          style={{ flex: '1 1 180px', minWidth: 140 }}
        />
      </div>

      <div className="panel">
        {items.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>{t('symbols.noMatches')}</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))',
              gap: 8,
            }}
          >
            {items.map((item, idx) => (
              <button
                key={`${item.category}-${idx}-${item.symbol}`}
                className="mini"
                title={itemName(item)}
                onClick={() => copy(item)}
                style={{
                  fontSize: 22,
                  lineHeight: 1,
                  height: 48,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily:
                    'ui-monospace, "Segoe UI Symbol", "Segoe UI", monospace',
                }}
              >
                {item.symbol}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="count-note">{status}</p>
    </div>
  );
}
