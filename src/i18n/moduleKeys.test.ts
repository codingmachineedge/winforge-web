// 全域 i18n 孤兒鍵防護 · Global orphan-key guard.
//
// Regression test for the "qbt.*" class of bug (2026-07-05): a feature-parity wave REPLACED a
// namespace block instead of merging it, so the module rendered raw keys ("qbt.notConnected")
// in production while the build stayed green. tsc can't catch it (t() is stringly-typed) and
// the pipeline validator only checks the single wave being integrated.
//
// This test rebuilds the EXACT runtime bundles (eager shell slices from i18n/index.ts +
// lazy per-module slices from moduleStrings.ts), scans every .tsx source for literal
// t('ns.key') usages, and asserts each one resolves in BOTH the EN and 粵語 trees.
// Plural-aware: a bare key also passes if `key_one` / `key_other` variants exist.
//
// If you add a new i18n slice to i18n/index.ts or moduleStrings.ts, mirror it here.

import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhHant } from './zh-Hant';
import { enB, yueB } from './batchB';
import { enReactorFuel, yueReactorFuel } from './reactorFuel';
import { enReactorCredits, yueReactorCredits } from './reactorCredits';
import { enReactorRods, yueReactorRods } from './reactorRods';
import { enReactorRelief, yueReactorRelief } from './reactorRelief';
import { enReactorPtlim, yueReactorPtlim } from './reactorPtlim';
import { enReactorEsf, yueReactorEsf } from './reactorEsf';
import { enReactorCtmt, yueReactorCtmt } from './reactorCtmt';
import { enReactorCsf, yueReactorCsf } from './reactorCsf';
import { enReactorReactimeter, yueReactorReactimeter } from './reactorReactimeter';
import { enFileBrowser, yueFileBrowser } from './fileBrowser';
import { enReactorCr, yueReactorCr } from './reactorCr';
import baselineJson from './moduleKeys.baseline.json';
import { enShell, yueShell } from './shell';
import { enShellNav, yueShellNav } from './shellNav';
import { enShellM3, yueShellM3 } from './shellM3';
import { enShellFeedback, yueShellFeedback } from './shellFeedback';
import { enShellTheme, yueShellTheme } from './shellTheme';
import { enShellA11y, yueShellA11y } from './shellA11y';
import { enShellSettings, yueShellSettings } from './shellSettings';
import { enReactorUi, yueReactorUi } from './reactorUi';

type Tree = { [k: string]: string | Tree };

const enAll: Tree = {
  ...enShell, ...enShellNav, ...enShellM3, ...enShellFeedback, ...enShellTheme, ...enShellA11y,
  ...enShellSettings, ...enReactorUi, ...en, ...enB, ...enReactorFuel, ...enReactorCredits,
  ...enReactorRods, ...enReactorRelief, ...enReactorPtlim, ...enReactorEsf, ...enReactorCtmt, ...enReactorCsf,
  ...enReactorReactimeter, ...enFileBrowser, ...enReactorCr,
} as unknown as Tree;
const yueAll: Tree = {
  ...yueShell, ...yueShellNav, ...yueShellM3, ...yueShellFeedback, ...yueShellTheme, ...yueShellA11y,
  ...yueShellSettings, ...yueReactorUi, ...zhHant, ...yueB, ...yueReactorFuel, ...yueReactorCredits,
  ...yueReactorRods, ...yueReactorRelief, ...yueReactorPtlim, ...yueReactorEsf, ...yueReactorCtmt, ...yueReactorCsf,
  ...yueReactorReactimeter, ...yueFileBrowser, ...yueReactorCr,
} as unknown as Tree;

// Files whose namespaces are not registered yet (work-in-progress integrations).
// Remove an entry the moment its slice is merged into moduleStrings.ts / index.ts.
const EXCLUDE = new Set<string>([]);

/** Resolve a dotted key in a tree; plural-aware at the leaf. */
function resolves(tree: Tree, key: string): boolean {
  const segs = key.split('.');
  let node: string | Tree | undefined = tree;
  for (let i = 0; i < segs.length; i++) {
    if (node === undefined || typeof node === 'string') return false;
    const seg = segs[i]!;
    const next: string | Tree | undefined = node[seg];
    if (next === undefined) {
      // plural / context forms only make sense at the leaf
      if (i === segs.length - 1) {
        return Object.keys(node).some((k) => k === `${seg}_one` || k === `${seg}_other` || k.startsWith(`${seg}_`));
      }
      return false;
    }
    node = next;
  }
  return typeof node === 'string' || (typeof node === 'object' && node !== null);
}

// Vite/vitest-native source scan — no node:fs so plain `tsc --noEmit` stays clean.
const sources: Record<string, string> = {
  ...import.meta.glob('../modules/**/*.tsx', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../components/**/*.tsx', { query: '?raw', import: 'default', eager: true }),
} as Record<string, string>;

/** Literal keys only: t('ns.key') / t("ns.key"). Concatenated/dynamic keys can't be checked. */
function literalKeys(srcText: string): string[] {
  const out: string[] = [];
  for (const m of srcText.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
    const k = m[1]!;
    if (k.includes('.') && !k.endsWith('.')) out.push(k);
  }
  return out;
}

describe('module i18n keys', () => {
  const missing: string[] = [];

  for (const [file, text] of Object.entries(sources)) {
    const base = file.split('/').pop() ?? file;
    if (base.endsWith('.test.tsx') || EXCLUDE.has(base)) continue;
    for (const key of new Set(literalKeys(text))) {
      const inEn = resolves(enAll, key);
      const inYue = resolves(yueAll, key);
      if (!inEn || !inYue) {
        missing.push(`${base}: ${key} (${inEn ? '' : 'EN'}${!inEn && !inYue ? '+' : ''}${inYue ? '' : '粵'})`);
      }
    }
  }

  // Baseline: a large pre-existing set of orphaned module keys (feature-parity waves that replaced
  // namespace blocks instead of merging — the same root cause as the qbt.* regression that motivated
  // this guard). Tracked as a debt to burn down; see docs. The guard's JOB is to stop NEW orphans,
  // so we compare against the baseline rather than requiring zero. When you fix orphans, regenerate:
  //   npx vitest run src/i18n/moduleKeys.test.ts  → copy the reported "still-orphaned" set into the JSON.
  const baseline: string[] = baselineJson as string[];
  const baseSet = new Set(baseline);
  const missingSet = new Set(missing);

  it('introduces no NEW orphan i18n keys beyond the tracked baseline', () => {
    const fresh = missing.filter((m) => !baseSet.has(m)).sort();
    expect(
      fresh,
      `NEW orphan i18n keys (a module uses t('ns.key') with no EN/粵 string).\n` +
        `Add them to the owning i18n slice, or if intentional, append to moduleKeys.baseline.json:\n${fresh.join('\n')}`,
    ).toEqual([]);
  });

  it('baseline is not stale (every baseline entry is still actually orphaned)', () => {
    // If this fails, some baseline keys have been fixed — shrink the baseline to lock in the win.
    const fixed = baseline.filter((b) => !missingSet.has(b)).sort();
    expect(
      fixed,
      `${fixed.length} baseline entries are no longer orphaned — remove them from ` +
        `moduleKeys.baseline.json to prevent regressions:\n${fixed.slice(0, 50).join('\n')}${fixed.length > 50 ? `\n…and ${fixed.length - 50} more` : ''}`,
    ).toEqual([]);
  });
});
