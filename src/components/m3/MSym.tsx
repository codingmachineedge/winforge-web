import type { CSSProperties } from 'react';
import { catalog, type CatalogModule } from '../../data/catalog';

// Material Symbols helper for the M3 shell (design handoff: "WinForge Material
// 3.dc.html"). The @font-face comes from the eager `material-symbols/outlined.css`
// import in main.tsx; the `.msym` base class lives in styles/m3.css.

interface MSymProps {
  /** Material Symbols ligature name, e.g. "grid_view". */
  name: string;
  /** Font size in px (defaults to the .msym inherited size). */
  size?: number;
  /** Filled variant (font-variation FILL 1). */
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function MSym({ name, size, fill, className, style }: MSymProps) {
  const cls = `msym${fill ? ' fill' : ''}${className ? ` ${className}` : ''}`;
  const s = size !== undefined ? { fontSize: size, ...style } : style;
  return (
    <span className={cls} style={s} aria-hidden="true">
      {name}
    </span>
  );
}

// ---- icon mapping (ported 1:1 from the design's sectionIcon/moduleIcon) -----

const SECTION_ICONS: Record<string, string> = {
  suite: 'deployed_code',
  categories: 'tune',
  toolbox: 'construction',
  windows11: 'window',
};

export function sectionSymbol(sectionId: string): string {
  return SECTION_ICONS[sectionId] ?? 'category';
}

// tag → owning section id, so keyword-less modules fall back to their section's
// icon exactly like the design prototype does.
const sectionIdByTag = new Map<string, string>();
for (const s of catalog) {
  const add = (m: CatalogModule) => {
    if (!sectionIdByTag.has(m.tag)) sectionIdByTag.set(m.tag, s.id);
  };
  s.directModules.forEach(add);
  for (const g of s.groups) {
    g.modules.forEach(add);
    (g.subgroups ?? []).forEach((sg) => sg.modules.forEach(add));
  }
}

export function moduleSymbol(m: Pick<CatalogModule, 'tag' | 'keywords'>): string {
  const tag = m.tag;
  if (tag === 'dashboard') return 'dashboard';
  if (tag === 'module.reactor') return 'bolt';
  if (tag === 'module.reactorsettings') return 'tune';
  const kw = `${tag} ${m.keywords}`.toLowerCase();
  if (/\bcolor|colour|palette/.test(kw)) return 'palette';
  if (/\bjson|yaml|xml|data\b/.test(kw)) return 'data_object';
  if (/\bhash|crypto|encrypt|cipher|base64|entropy/.test(kw)) return 'lock';
  if (/\bnetwork|http|dns|ping|port|ip\b/.test(kw)) return 'lan';
  if (/\btext|string|case|regex|diff|markdown/.test(kw)) return 'text_fields';
  if (/\bfile|disk|drive|archive|folder/.test(kw)) return 'folder';
  if (/\bservice|process|startup|task|registry|system/.test(kw)) return 'settings_applications';
  if (/\bcalc|convert|unit|time|date/.test(kw)) return 'calculate';
  if (/\bmedia|audio|video|capture|image|camera/.test(kw)) return 'perm_media';
  if (/\bgit|api|dev|code|terminal/.test(kw)) return 'terminal';
  if (/\bfactory|farm|cake|grid|hydrogen|cluster|kiln|cement|collider|mine/.test(kw)) return 'factory';
  return sectionSymbol(sectionIdByTag.get(tag) ?? '');
}

/** Status → chip icon, per the design's statusChip(). */
export const STATUS_SYMBOLS: Record<string, string> = {
  working: 'check_circle',
  partial: 'radio_button_partial',
  stub: 'schedule',
};
