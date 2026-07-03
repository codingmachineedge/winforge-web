import type { ComponentType } from 'react';
import { SlugifyModule } from './SlugifyModule';
import { RomanNumModule } from './RomanNumModule';
import { TextSortModule } from './TextSortModule';
import { UnixPermModule } from './UnixPermModule';

/**
 * feature/modules-batch-b module registrations (N–Z web-capable tools). Kept in a
 * dedicated file so this agent never collides with concurrent edits to registry.tsx.
 * Merged into moduleRegistry by registry.tsx.
 */
export const moduleRegistryB: Record<string, ComponentType> = {
  'module.slugify': SlugifyModule,
  'module.romannum': RomanNumModule,
  'module.textsort': TextSortModule,
  'module.unixperm': UnixPermModule,
};
