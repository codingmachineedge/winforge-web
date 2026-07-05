// Lazy registration of the heavy per-module i18n strings.
//
// en.ts / zh-Hant.ts / batchB.ts (~570 kB) hold each module's user-facing strings.
// They are only needed once a module renders (inside the lazy ModuleDetail chunk),
// so they are NOT part of the eager bundle (i18n/index.ts loads only shell strings).
// ModuleDetail imports this module at chunk-eval time and calls registerModuleStrings()
// synchronously, before any module component renders — so t('<module>.…') resolves
// on first paint with no flash of raw keys.
import i18n, { mergeBilingual, type Tree } from './index';
import { en } from './en';
import { zhHant } from './zh-Hant';
import { enB, yueB } from './batchB';
import { enReactorFuel, yueReactorFuel } from './reactorFuel';
import { enReactorCredits, yueReactorCredits } from './reactorCredits';

let registered = false;

/** Add every per-module namespace to the en / yue / bilingual bundles. Idempotent. */
export function registerModuleStrings(): void {
  if (registered) return;
  registered = true;

  const enMods = { ...en, ...enB, ...enReactorFuel, ...enReactorCredits };
  const yueMods = { ...zhHant, ...yueB, ...yueReactorFuel, ...yueReactorCredits };
  const biMods = mergeBilingual(enMods as unknown as Tree, yueMods as unknown as Tree);

  // deep=true (merge into the existing shell namespaces), overwrite=true.
  i18n.addResourceBundle('en', 'translation', enMods, true, true);
  i18n.addResourceBundle('yue', 'translation', yueMods, true, true);
  i18n.addResourceBundle('bilingual', 'translation', biMods, true, true);
}
