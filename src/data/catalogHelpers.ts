import type { CatalogSection, CatalogGroup } from './catalog';

export function groupCount(g: CatalogGroup): number {
  return g.modules.length + (g.subgroups?.reduce((k, sg) => k + groupCount(sg), 0) ?? 0);
}

export function sectionCount(s: CatalogSection): number {
  return s.directModules.length + s.groups.reduce((n, g) => n + groupCount(g), 0);
}

/** Sections that actually contain modules (hides e.g. the not-yet-ported Windows 11 tweaks). */
export function nonEmptySections(sections: CatalogSection[]): CatalogSection[] {
  return sections.filter((s) => sectionCount(s) > 0);
}
