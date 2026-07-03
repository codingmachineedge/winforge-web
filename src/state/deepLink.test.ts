import { describe, expect, it } from 'vitest';
import { parseDeepLink } from './deepLink';

describe('parseDeepLink', () => {
  it('parses winforge://module/<tag>', () => {
    expect(parseDeepLink('winforge://module/services')).toBe('services');
    expect(parseDeepLink('winforge://module/startup-apps')).toBe('startup-apps');
  });

  it('parses the dotted winforge://module/module.xxx form', () => {
    expect(parseDeepLink('winforge://module/module.registry')).toBe('module.registry');
    expect(parseDeepLink('winforge://module/net.dns')).toBe('net.dns');
  });

  it('parses the bare winforge://<tag> form', () => {
    expect(parseDeepLink('winforge://services')).toBe('services');
    expect(parseDeepLink('winforge://module.foo')).toBe('module.foo');
    expect(parseDeepLink('winforge://a_b-c.1')).toBe('a_b-c.1');
  });

  it('is case-insensitive on the scheme and lowercases the tag', () => {
    expect(parseDeepLink('WinForge://module/Services')).toBe('services');
    expect(parseDeepLink('WINFORGE://Foo')).toBe('foo');
  });

  it('tolerates trailing slashes, query strings and fragments', () => {
    expect(parseDeepLink('winforge://module/services/')).toBe('services');
    expect(parseDeepLink('winforge://module/services?x=1')).toBe('services');
    expect(parseDeepLink('winforge://services#top')).toBe('services');
  });

  it('rejects the wrong scheme', () => {
    expect(parseDeepLink('https://module/services')).toBeNull();
    expect(parseDeepLink('winforgex://services')).toBeNull();
    expect(parseDeepLink('module/services')).toBeNull();
  });

  it('rejects empty / missing tags', () => {
    expect(parseDeepLink('winforge://')).toBeNull();
    expect(parseDeepLink('winforge://module')).toBeNull();
    expect(parseDeepLink('winforge://module/')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });

  it('rejects tags with invalid characters', () => {
    expect(parseDeepLink('winforge://module/foo bar')).toBeNull();
    expect(parseDeepLink('winforge://module/foo%2Fbar')).toBeNull();
    expect(parseDeepLink('winforge://foo@bar')).toBeNull();
    expect(parseDeepLink('winforge://foo!')).toBeNull();
  });

  it('rejects ambiguous multi-segment bare paths', () => {
    expect(parseDeepLink('winforge://foo/bar')).toBeNull();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it('rejects non-string input', () => {
    expect(parseDeepLink(undefined as unknown as string)).toBeNull();
    expect(parseDeepLink(null as unknown as string)).toBeNull();
  });
});
