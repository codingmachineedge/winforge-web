// In-house fuzzy matching toolkit — zero runtime deps.
//
// Powers typo-tolerant module search + match highlighting in the command palette
// and catalog grid. Designed to be cheap enough to run across ~320 modules ×
// several text fields on every keystroke: everything is case-folded once by the
// caller path (fuzzyScore lower-cases internally but callers pass short terms),
// and each tier early-exits before the next, more expensive tier runs.
//
// Scoring tiers, highest → lowest:
//   1. exact substring         — term appears verbatim in text
//   2. word-prefix             — term begins a whitespace/punctuation-delimited word
//   3. subsequence + locality  — term chars appear in order; contiguous runs score higher
//   4. single-edit typo        — one substitution / transposition / insertion / deletion
//                                (only for terms ≥ 4 chars; bounded, no full DP matrix)
//
// fuzzyScore returns a positive number (higher = better) or null for no match.
// The absolute magnitudes are calibrated so a lower tier can never outrank a
// higher tier for the same term: exact ≫ prefix ≫ subsequence ≫ typo.

export interface Range {
  start: number; // inclusive
  end: number; // exclusive
}

// Tier score bands. Kept far apart so tiers never cross over.
const TIER_EXACT = 1000;
const TIER_PREFIX = 700;
const TIER_SUBSEQ = 400;
const TIER_TYPO = 150;

const isWordBoundary = (ch: string): boolean => {
  // ASCII whitespace / common separators. CJK has no spaces, but our titles are
  // `${en} ${zh}` so a space always precedes the Chinese half; word-prefix on the
  // CJK side is handled by exact-substring anyway (every CJK char is a "word").
  return ch === ' ' || ch === '\t' || ch === '-' || ch === '/' || ch === '·' || ch === '(' || ch === '_' || ch === '.';
};

/**
 * Score how well `term` matches `text`. Both are compared case-insensitively.
 * Returns a positive score (higher is better) or null when there is no match.
 */
export function fuzzyScore(term: string, text: string): number | null {
  if (!term) return 0;
  const t = term.toLowerCase();
  const h = text.toLowerCase();
  if (t.length > h.length) {
    // Can only match via nothing; a longer term cannot be a subsequence of shorter text.
    // (Single-edit deletion could shrink term by 1, but if term is still longer, impossible.)
    if (t.length - 1 > h.length) return null;
  }

  // Tier 1: exact substring.
  const idx = h.indexOf(t);
  if (idx >= 0) {
    // Bonus for matching at the very start, and for word-boundary starts.
    let s = TIER_EXACT;
    if (idx === 0) s += 60;
    else if (isWordBoundary(h[idx - 1]!)) s += 40;
    // Shorter text with the same match is a tighter fit.
    s += Math.max(0, 20 - (h.length - t.length));
    return s;
  }

  // Tier 2: word-prefix (term begins some word but isn't a full contiguous substring
  // of the whole text — e.g. term spanning into the next word). In practice tier 1
  // already covers most prefixes, so this catches multi-word-ish cases cheaply.
  const prefixScore = wordPrefixScore(t, h);
  if (prefixScore !== null) return TIER_PREFIX + prefixScore;

  // Tier 3: subsequence with locality bonus.
  const subseq = subsequenceScore(t, h);
  if (subseq !== null) return TIER_SUBSEQ + subseq;

  // Tier 4: bounded single-edit typo tolerance (terms ≥ 4 chars only).
  if (t.length >= 4 && withinOneEdit(t, h)) {
    return TIER_TYPO;
  }

  return null;
}

/**
 * If `t` is a prefix of any whitespace/punct-delimited word in `h`, return a small
 * locality bonus; otherwise null. (Lower-cased inputs expected.)
 */
function wordPrefixScore(t: string, h: string): number | null {
  let atBoundary = true;
  for (let i = 0; i + t.length <= h.length; i++) {
    if (atBoundary && h.startsWith(t, i)) {
      return i === 0 ? 30 : 15;
    }
    atBoundary = isWordBoundary(h[i]!);
  }
  return null;
}

/**
 * Greedy subsequence match: every char of `t` found in `h` in order. Returns a
 * locality-weighted bonus (contiguous runs score higher) or null. (Lower-cased.)
 */
function subsequenceScore(t: string, h: string): number | null {
  let ti = 0;
  let runs = 0;
  let inRun = false;
  let contiguous = 0;
  let firstIdx = -1;
  for (let hi = 0; hi < h.length && ti < t.length; hi++) {
    if (h[hi] === t[ti]) {
      if (firstIdx < 0) firstIdx = hi;
      if (inRun) contiguous++;
      else {
        runs++;
        inRun = true;
      }
      ti++;
    } else {
      inRun = false;
    }
  }
  if (ti < t.length) return null; // didn't consume all of term
  // Fewer runs (more contiguity) is better; contiguous chars add. Earlier start better.
  let s = contiguous * 4 - runs * 3;
  s += Math.max(0, 10 - firstIdx); // earlier match preferred
  return s;
}

/**
 * Bounded single-edit check: true when `t` and some window of `h` differ by at most
 * one substitution, transposition, insertion, or deletion. We scan candidate windows
 * of `h` (lengths t.length-1 .. t.length+1) and test each with a cheap O(len) diff —
 * no full Levenshtein matrix. (Lower-cased inputs expected.)
 */
function withinOneEdit(t: string, h: string): boolean {
  const n = t.length;
  // Try every substring window of h with length n-1, n, n+1.
  for (let winLen = n - 1; winLen <= n + 1; winLen++) {
    if (winLen < 1) continue;
    for (let start = 0; start + winLen <= h.length; start++) {
      if (oneEditApart(t, h.substr(start, winLen))) return true;
    }
  }
  return false;
}

/** True when strings a and b are equal or differ by exactly one edit (sub/ins/del/transpose). */
export function oneEditApart(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    // Count mismatches; allow a single substitution OR a single adjacent transposition.
    let diff = 0;
    let firstI = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff++;
        if (firstI < 0) firstI = i;
        if (diff > 2) return false;
      }
    }
    if (diff <= 1) return true;
    // Exactly two mismatches → only OK if they're an adjacent transposition.
    if (diff === 2 && firstI >= 0 && firstI + 1 < la) {
      return a[firstI] === b[firstI + 1] && a[firstI + 1] === b[firstI];
    }
    return false;
  }

  // Lengths differ by one → check for a single insertion/deletion.
  const shorter = la < lb ? a : b;
  const longer = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++; // skip one char in the longer string
    }
  }
  return true;
}

/**
 * Matched character index ranges in `text` for the BEST match of `term`, for
 * highlighting. Mirrors the fuzzyScore tier order so the highlighted region
 * reflects why the match scored.
 *   - exact substring / word-prefix → one contiguous range
 *   - subsequence                   → per-char ranges, merged when adjacent
 *   - typo                          → the aligned window region
 * Returns [] when there is no match.
 */
export function fuzzyRanges(term: string, text: string): Range[] {
  if (!term) return [];
  const t = term.toLowerCase();
  const h = text.toLowerCase();

  // Tier 1: exact substring.
  const idx = h.indexOf(t);
  if (idx >= 0) return [{ start: idx, end: idx + t.length }];

  // Tier 2: word-prefix — find the boundary word this term prefixes.
  {
    let atBoundary = true;
    for (let i = 0; i + t.length <= h.length; i++) {
      if (atBoundary && h.startsWith(t, i)) return [{ start: i, end: i + t.length }];
      atBoundary = isWordBoundary(h[i]!);
    }
  }

  // Tier 3: subsequence — collect each matched char, then merge adjacent.
  {
    const ranges: Range[] = [];
    let ti = 0;
    for (let hi = 0; hi < h.length && ti < t.length; hi++) {
      if (h[hi] === t[ti]) {
        ranges.push({ start: hi, end: hi + 1 });
        ti++;
      }
    }
    if (ti === t.length) return mergeRanges(ranges);
  }

  // Tier 4: typo — return the best matching window (whole aligned region).
  if (t.length >= 4) {
    const n = t.length;
    for (let winLen = n - 1; winLen <= n + 1; winLen++) {
      if (winLen < 1) continue;
      for (let start = 0; start + winLen <= h.length; start++) {
        if (oneEditApart(t, h.substr(start, winLen))) {
          return [{ start, end: start + winLen }];
        }
      }
    }
  }

  return [];
}

/** Merge sorted-or-unsorted ranges, collapsing overlapping or adjacent ones. */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    const last = out[out.length - 1]!;
    if (r.start <= last.end) {
      // overlapping or adjacent (adjacent = r.start === last.end)
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Drop-in fuzzy replacement for ModuleCatalog's `matches()`. Every whitespace term
 * in `q` must fuzzy-match somewhere in the module's searchable text (title EN + ZH,
 * keywords, tag) — AND semantics across terms, like the original substring matcher.
 */
export function catalogMatches(
  m: { en: string; zh: string; keywords: string; tag: string },
  q: string,
): boolean {
  const query = q.trim();
  if (!query) return true;
  const hay = `${m.en} ${m.zh} ${m.keywords} ${m.tag}`;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => fuzzyScore(term, hay) !== null);
}
