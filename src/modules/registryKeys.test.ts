import { describe, expect, it } from 'vitest';
import { moduleRegistry } from './registry';
import { registeredModuleTags } from './registryKeys';

// registryKeys.ts is generated (tools/gen-registry-keys.mjs) so the status layer
// can check registration without importing every module component eagerly. This
// guard fails whenever the registry changes without regenerating the keys file.
describe('registryKeys', () => {
  it('mirrors moduleRegistry exactly (run `npm run gen:registry-keys` if this fails)', () => {
    const real = new Set(Object.keys(moduleRegistry));
    const missing = [...real].filter((t) => !registeredModuleTags.has(t));
    const stale = [...registeredModuleTags].filter((t) => !real.has(t));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });
});
