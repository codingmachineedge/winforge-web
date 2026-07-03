import { describe, expect, it } from 'vitest';
import { isValidSettingsPage, isKnownFolder, KNOWN_FOLDERS } from './ops';

describe('isValidSettingsPage', () => {
  it('accepts valid ms-settings ids', () => {
    expect(isValidSettingsPage('windowsupdate')).toBe(true);
    expect(isValidSettingsPage('network-status')).toBe(true);
    expect(isValidSettingsPage('bluetooth')).toBe(true);
    expect(isValidSettingsPage('about')).toBe(true);
  });

  it('rejects injection / malformed ids', () => {
    expect(isValidSettingsPage('')).toBe(false);
    expect(isValidSettingsPage('Windows Update')).toBe(false); // space + caps
    expect(isValidSettingsPage('a:b')).toBe(false); // colon (second URI)
    expect(isValidSettingsPage('../etc')).toBe(false); // path traversal
    expect(isValidSettingsPage('page&calc')).toBe(false); // shell metachar
    expect(isValidSettingsPage('x'.repeat(65))).toBe(false); // too long
  });
});

describe('isKnownFolder', () => {
  it('accepts every allowlisted token', () => {
    for (const f of KNOWN_FOLDERS) {
      expect(isKnownFolder(f)).toBe(true);
    }
  });

  it('rejects arbitrary paths and unknown tokens', () => {
    expect(isKnownFolder('c:\\windows')).toBe(false);
    expect(isKnownFolder('../secret')).toBe(false);
    expect(isKnownFolder('system32')).toBe(false);
  });
});
