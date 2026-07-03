import { describe, it, expect } from 'vitest';
import { fmtNum, localeForLang } from './format';

describe('localeForLang', () => {
  it('maps en → en-US', () => {
    expect(localeForLang('en')).toBe('en-US');
    expect(localeForLang('en-GB')).toBe('en-US');
    expect(localeForLang('EN')).toBe('en-US');
  });
  it('maps yue / bilingual / zh → zh-Hant', () => {
    expect(localeForLang('yue')).toBe('zh-Hant');
    expect(localeForLang('bilingual')).toBe('zh-Hant');
    expect(localeForLang('zh-Hant')).toBe('zh-Hant');
    expect(localeForLang('zh')).toBe('zh-Hant');
  });
  it('defaults to en-US when undefined', () => {
    expect(localeForLang(undefined)).toBe('en-US');
    expect(localeForLang('')).toBe('en-US');
  });
});

describe('fmtNum digit counts + separators', () => {
  it('respects the requested fractional digit count', () => {
    expect(fmtNum(3.14159, 0, 'en')).toBe('3');
    expect(fmtNum(3.14159, 1, 'en')).toBe('3.1');
    expect(fmtNum(3.14159, 2, 'en')).toBe('3.14');
    expect(fmtNum(3.1, 3, 'en')).toBe('3.100'); // pads trailing zeros
  });

  it('defaults to 1 fractional digit', () => {
    expect(fmtNum(2)).toBe('2.0');
  });

  it('groups thousands with a comma in en-US', () => {
    expect(fmtNum(3411, 1, 'en')).toBe('3,411.0');
    expect(fmtNum(1234567, 0, 'en')).toBe('1,234,567');
  });

  it('renders non-finite input as an em-dash, never NaN', () => {
    expect(fmtNum(Number.NaN, 1, 'en')).toBe('—');
    expect(fmtNum(Number.POSITIVE_INFINITY, 2, 'en')).toBe('—');
  });

  it('formats zh-Hant with the same Western digits and grouping', () => {
    // zh-Hant uses ASCII digits, comma grouping and a dot decimal (latn numbering).
    const s = fmtNum(3411.5, 1, 'yue');
    expect(s).toContain('3');
    expect(s).toContain('411');
    expect(s).toContain('.5');
    // digit count preserved: exactly one fractional digit
    expect(s.split('.')[1]).toHaveLength(1);
  });

  it('bilingual language formats identically to yue (both zh-Hant)', () => {
    expect(fmtNum(1000, 0, 'bilingual')).toBe(fmtNum(1000, 0, 'yue'));
  });

  it('handles negatives', () => {
    expect(fmtNum(-9000, 0, 'en')).toBe('-9,000');
  });
});
