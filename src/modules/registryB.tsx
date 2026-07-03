import type { ComponentType } from 'react';
import { SlugifyModule } from './SlugifyModule';

/**
 * feature/modules-batch-b module registrations (N–Z web-capable tools). Kept in a
 * dedicated file so this agent never collides with concurrent edits to registry.tsx.
 * Merged into moduleRegistry by registry.tsx.
 */
export const moduleRegistryB: Record<string, ComponentType> = {
  'module.slugify': SlugifyModule,
};
