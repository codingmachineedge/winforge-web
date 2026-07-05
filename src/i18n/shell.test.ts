import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhHant } from './zh-Hant';
import { enShell, yueShell } from './shell';

// shell.ts is generated (tools/gen-i18n-shell.mjs) so the always-loaded shell can
// use these namespaces without importing the full ~570 kB of per-module strings
// eagerly. This guard fails whenever a shell namespace in en.ts / zh-Hant.ts changes
// without regenerating shell.ts (run `npm run gen:i18n-shell`).
const SHELL_NS = ['about', 'app', 'catalog', 'detail', 'nav', 'palette', 'reactor', 'status'];

describe('i18n shell slice', () => {
  it('mirrors the shell namespaces of en.ts exactly', () => {
    for (const ns of SHELL_NS) {
      expect((enShell as Record<string, unknown>)[ns]).toEqual((en as Record<string, unknown>)[ns]);
    }
  });

  it('mirrors the shell namespaces of zh-Hant.ts exactly', () => {
    for (const ns of SHELL_NS) {
      expect((yueShell as Record<string, unknown>)[ns]).toEqual(
        (zhHant as unknown as Record<string, unknown>)[ns],
      );
    }
  });

  it('contains exactly the expected namespaces (no drift)', () => {
    expect(Object.keys(enShell).sort()).toEqual([...SHELL_NS].sort());
    expect(Object.keys(yueShell).sort()).toEqual([...SHELL_NS].sort());
  });
});
