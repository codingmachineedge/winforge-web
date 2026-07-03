import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyRanges, mergeRanges, oneEditApart, catalogMatches } from './fuzzy';

describe('fuzzyScore — tiers', () => {
  it('scores exact substring highest', () => {
    const s = fuzzyScore('doc', 'system doctors');
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(1000);
  });

  it('exact start of string beats exact mid-string', () => {
    const start = fuzzyScore('doc', 'doctor tools')!;
    const mid = fuzzyScore('doc', 'the doctor tools')!;
    expect(start).toBeGreaterThan(mid);
  });

  it('exact substring outranks subsequence', () => {
    const exact = fuzzyScore('cat', 'catalog')!; // substring
    const subseq = fuzzyScore('cat', 'c a t x')!; // subsequence with gaps
    expect(exact).toBeGreaterThan(subseq);
  });

  it('subsequence outranks a typo match', () => {
    // 'rboot' is a subsequence of 'reboot'? r-b-o-o-t: reboot has r,e,b,o,o,t → yes.
    const subseq = fuzzyScore('rboot', 'reboot')!;
    // 'reboor' vs 'reboot' is a single substitution typo, not a subsequence.
    const typo = fuzzyScore('reboor', 'reboot')!;
    expect(subseq).toBeGreaterThan(typo);
  });

  it('subsequence with more contiguity scores higher', () => {
    const contiguous = fuzzyScore('abcd', 'abcdef')!; // fully contiguous (also substring, tier1)
    const scattered = fuzzyScore('abcd', 'axbxcxd')!; // scattered subsequence (tier3)
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('tiers are strictly ordered: exact > prefix-ish > subsequence > typo', () => {
    const exact = fuzzyScore('reactor', 'reactor')!;
    const subseq = fuzzyScore('rctr', 'reactor')!; // r-c-t-r subsequence
    const typo = fuzzyScore('reaktor', 'reactor')!; // one substitution
    expect(exact).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(typo);
  });

  it('empty term matches with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});

describe('fuzzyScore — typo tolerance', () => {
  it('tolerates one substitution for terms >= 4 chars', () => {
    expect(fuzzyScore('reaktor', 'reactor')).not.toBeNull(); // c->k
    expect(fuzzyScore('dsik', 'disk')).not.toBeNull(); // transposition (is-> si)
  });

  it('tolerates one insertion and one deletion', () => {
    expect(fuzzyScore('diskk', 'disk')).not.toBeNull(); // insertion
    expect(fuzzyScore('dsk', 'disk')).not.toBeNull(); // deletion (also subsequence)
  });

  it('does NOT typo-tolerate short terms (< 4 chars)', () => {
    // 'ct' vs 'at' would be a substitution but term is only 2 chars → no typo tier.
    // It's also not a subsequence of 'at'. So null.
    expect(fuzzyScore('ct', 'at')).toBeNull();
  });

  it('rejects two-edit-distance garbage', () => {
    expect(fuzzyScore('xyzzy', 'reactor')).toBeNull();
  });

  it('returns null for no match at all', () => {
    expect(fuzzyScore('zzzz', 'reactor')).toBeNull();
  });
});

describe('fuzzyScore — CJK', () => {
  it('substring-matches Chinese text', () => {
    expect(fuzzyScore('核反應', '核反應堆')).not.toBeNull();
    expect(fuzzyScore('反應堆', 'nuclear reactor 核反應堆')).not.toBeNull();
  });

  it('single CJK char matches', () => {
    expect(fuzzyScore('堆', '核反應堆')).not.toBeNull();
  });

  it('non-present CJK returns null', () => {
    expect(fuzzyScore('磁碟', '核反應堆')).toBeNull();
  });
});

describe('oneEditApart', () => {
  it('equal strings are within one edit', () => {
    expect(oneEditApart('disk', 'disk')).toBe(true);
  });
  it('single substitution', () => {
    expect(oneEditApart('disk', 'dosk')).toBe(true);
  });
  it('single adjacent transposition', () => {
    expect(oneEditApart('disk', 'dsik')).toBe(true);
  });
  it('single insertion / deletion', () => {
    expect(oneEditApart('disk', 'disks')).toBe(true);
    expect(oneEditApart('disks', 'disk')).toBe(true);
  });
  it('two substitutions are NOT within one edit', () => {
    expect(oneEditApart('disk', 'dxxk')).toBe(false);
  });
  it('non-adjacent double mismatch is NOT a transposition', () => {
    expect(oneEditApart('abcd', 'dbca')).toBe(false);
  });
  it('length diff > 1 is never within one edit', () => {
    expect(oneEditApart('disk', 'diskxy')).toBe(false);
  });
});

describe('fuzzyRanges', () => {
  it('exact substring → one contiguous range', () => {
    expect(fuzzyRanges('doc', 'system doctors')).toEqual([{ start: 7, end: 10 }]);
  });

  it('range at start of string', () => {
    expect(fuzzyRanges('sys', 'system')).toEqual([{ start: 0, end: 3 }]);
  });

  it('subsequence → per-char ranges (non-adjacent stay separate)', () => {
    // 'ad' is not a substring of 'axbxd' → tier 3 subsequence: a@0, d@4.
    const r = fuzzyRanges('ad', 'axbxd');
    expect(r).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  it('subsequence with adjacent chars merges into one range', () => {
    // 'acd' in 'axcd': a@0, c@2, d@3 → c,d adjacent merge.
    const r = fuzzyRanges('acd', 'axcd');
    expect(r).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
    ]);
  });

  it('CJK substring range', () => {
    expect(fuzzyRanges('反應', '核反應堆')).toEqual([{ start: 1, end: 3 }]);
  });

  it('typo match → aligned window region', () => {
    const r = fuzzyRanges('reaktor', 'reactor');
    expect(r.length).toBe(1);
    expect(r[0]!.start).toBe(0);
    expect(r[0]!.end).toBe(7);
  });

  it('no match → empty array', () => {
    expect(fuzzyRanges('zzzz', 'reactor')).toEqual([]);
  });
});

describe('mergeRanges', () => {
  it('merges overlapping ranges', () => {
    expect(mergeRanges([{ start: 0, end: 3 }, { start: 2, end: 5 }])).toEqual([{ start: 0, end: 5 }]);
  });
  it('merges adjacent ranges (end === start)', () => {
    expect(mergeRanges([{ start: 0, end: 2 }, { start: 2, end: 4 }])).toEqual([{ start: 0, end: 4 }]);
  });
  it('keeps disjoint ranges separate and sorted', () => {
    expect(mergeRanges([{ start: 5, end: 6 }, { start: 0, end: 1 }])).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
  });
  it('handles empty and singleton', () => {
    expect(mergeRanges([])).toEqual([]);
    expect(mergeRanges([{ start: 1, end: 2 }])).toEqual([{ start: 1, end: 2 }]);
  });
});

describe('catalogMatches', () => {
  const mod = { en: 'Nuclear Reactor', zh: '核反應堆', keywords: 'pwr meltdown scram boron', tag: 'module.reactor' };

  it('empty query matches everything', () => {
    expect(catalogMatches(mod, '')).toBe(true);
    expect(catalogMatches(mod, '   ')).toBe(true);
  });

  it('single exact term matches', () => {
    expect(catalogMatches(mod, 'reactor')).toBe(true);
    expect(catalogMatches(mod, 'scram')).toBe(true);
  });

  it('multi-term AND: all terms must match', () => {
    expect(catalogMatches(mod, 'nuclear scram')).toBe(true); // both present
    expect(catalogMatches(mod, 'nuclear banana')).toBe(false); // banana absent
  });

  it('CJK term matches', () => {
    expect(catalogMatches(mod, '核反應')).toBe(true);
  });

  it('typo term matches via fuzzy tier', () => {
    expect(catalogMatches(mod, 'reaktor')).toBe(true); // c->k typo
    expect(catalogMatches(mod, 'meltdwon')).toBe(true); // transposition
  });

  it('matches on tag', () => {
    expect(catalogMatches(mod, 'module.reactor')).toBe(true);
  });

  it('no match returns false', () => {
    expect(catalogMatches(mod, 'xylophone')).toBe(false);
  });
});
