export type View =
  | { kind: 'catalog'; sectionId: string | null }
  | { kind: 'module'; tag: string }
  | { kind: 'reactor' }
  | { kind: 'about' };
