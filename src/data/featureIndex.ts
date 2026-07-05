// Feature-level search index. Each real module keeps its user-facing strings
// (buttons, labels, options, status messages) in an i18n namespace — those strings
// ARE the module's features. We flatten them per namespace so the command palette
// can find an app by what it *does* ("shannon entropy", "vigenère", "luhn"), not
// just by its title. Everything is static/pure — computed once at import.
//
// This pulls in the full ~570 kB of per-module strings, so it is LAZY-loaded by the
// command palette on first open (see CommandPalette.tsx) rather than shipped eagerly.
// The cheap catalog-only section map lives separately in ./sectionIndex.
import { en } from '../i18n/en';
import { zhHant } from '../i18n/zh-Hant';
import { enB, yueB } from '../i18n/batchB';

type Tree = Record<string, unknown>;

function flatten(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) flatten(v, out);
}

const enBundle: Tree = { ...(en as unknown as Tree), ...(enB as unknown as Tree) };
const zhBundle: Tree = { ...(zhHant as unknown as Tree), ...(yueB as unknown as Tree) };

// namespace -> list of feature fragments (EN + 粵語)
const fragmentsByNs = new Map<string, string[]>();
for (const ns of new Set([...Object.keys(enBundle), ...Object.keys(zhBundle)])) {
  const parts: string[] = [];
  flatten(enBundle[ns], parts);
  flatten(zhBundle[ns], parts);
  // de-dupe and drop trivially short fragments
  const seen = new Set<string>();
  const kept = parts.filter((p) => {
    const t = p.trim();
    if (t.length < 2 || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  fragmentsByNs.set(ns, kept);
}

const nsFor = (tag: string) => tag.replace(/^module\./, '');

/** Lower-cased blob of every feature string for a module — for matching. */
export function featureTextFor(tag: string): string {
  return (fragmentsByNs.get(nsFor(tag)) ?? []).join(' · ').toLowerCase();
}

/** The first feature fragment that contains one of the query terms (for a snippet). */
export function matchedFeature(tag: string, terms: string[]): string | null {
  const frags = fragmentsByNs.get(nsFor(tag));
  if (!frags || terms.length === 0) return null;
  for (const f of frags) {
    const lc = f.toLowerCase();
    if (terms.some((t) => lc.includes(t))) return f.trim();
  }
  return null;
}

/** How many distinct features a module exposes (rough richness signal). */
export function featureCount(tag: string): number {
  return fragmentsByNs.get(nsFor(tag))?.length ?? 0;
}
