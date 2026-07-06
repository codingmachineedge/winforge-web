import type { ComponentType } from 'react';
import { TweaksBrowser } from './TweaksBrowserModule';
import { tweakCategories } from '../data/tweaks';

// One registry entry per WinForge tweak category. Each tag `module.tweaks.<catId>` renders
// the shared TweaksBrowser bound to that category. Tags match the catalog entries injected
// into the "Windows 11 › All Tweaks" group by tools/gen-catalog.mjs.
export const moduleRegistryTweaks: Record<string, ComponentType> = Object.fromEntries(
  tweakCategories.map((c) => {
    const Bound = () => <TweaksBrowser categoryId={c.id} />;
    Bound.displayName = `TweaksBrowser(${c.id})`;
    return [`module.tweaks.${c.id}`, Bound as ComponentType];
  }),
);
