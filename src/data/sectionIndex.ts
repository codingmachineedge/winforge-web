// tag -> owning section label, for grouping command-palette results.
// Built purely from the catalog (no translations), so it stays cheap and eager —
// unlike the feature-text index (featureIndex.ts), which flattens every module's
// i18n strings and is therefore loaded lazily by the command palette.
import { catalog, type CatalogModule } from './catalog';

export const sectionByTag = new Map<string, { en: string; zh: string }>();
for (const s of catalog) {
  const add = (m: CatalogModule) => {
    if (!sectionByTag.has(m.tag)) sectionByTag.set(m.tag, { en: s.en, zh: s.zh });
  };
  s.directModules.forEach(add);
  for (const g of s.groups) {
    g.modules.forEach(add);
    (g.subgroups ?? []).forEach((sg) => sg.modules.forEach(add));
  }
}
