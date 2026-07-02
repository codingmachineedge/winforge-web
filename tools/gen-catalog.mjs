// Regenerate src/data/catalog.ts from a WinForge checkout.
//   node tools/gen-catalog.mjs [path-to-WinForge]
// Reads MainWindow.xaml (nav tree → sections/groups) + Services/ModuleRegistry.cs (metadata).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || 'C:/Users/cntow/Documents/GitHub/WinForge';
const OUT = path.join(__dirname, '..', 'src', 'data', 'catalog.ts');

const xaml = fs.readFileSync(path.join(SRC, 'MainWindow.xaml'), 'utf8');
const reg = fs.readFileSync(path.join(SRC, 'Services', 'ModuleRegistry.cs'), 'utf8');

function decodeGlyph(raw) {
  if (!raw) return '';
  const m = raw.match(/\(char\)0x([0-9A-Fa-f]+)/);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  return raw.replace(/^"|"$/g, '');
}
const meta = {};
const regRe =
  /new\(\)\s*\{\s*Tag\s*=\s*"([^"]+)"\s*,\s*En\s*=\s*"([^"]*)"\s*,\s*Zh\s*=\s*"([^"]*)"\s*,\s*Glyph\s*=\s*([^,]+?)\s*,\s*Keywords\s*=\s*"([^"]*)"\s*\}/g;
let m;
while ((m = regRe.exec(reg)) !== null) {
  meta[m[1]] = { tag: m[1], en: m[2], zh: m[3], glyph: decodeGlyph(m[4].trim()), keywords: m[5] };
}

const navStart = xaml.indexOf('<NavigationView.MenuItems>');
const navEnd = xaml.indexOf('</NavigationView.MenuItems>');
const lines = xaml.slice(navStart, navEnd).split(/\r?\n/);

const splitBilingual = (c) => {
  const parts = c.split(' · ');
  return { en: (parts[0] || '').trim(), zh: (parts.slice(1).join(' · ') || '').trim() };
};
const unescapeXml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#8203;/g, '');

const sectionsRaw = [];
let curSection = null;
const groupStack = [];
for (const line of lines) {
  const t = line.trim();
  const hm = t.match(/<NavigationViewItemHeader\s+Content="([^"]*)"/);
  if (hm) {
    curSection = { name: splitBilingual(unescapeXml(hm[1])), groups: [], modules: [] };
    sectionsRaw.push(curSection);
    groupStack.length = 0;
    continue;
  }
  if (t.startsWith('<NavigationViewItem ')) {
    const cm = t.match(/Content="([^"]*)"/);
    const tagm = t.match(/Tag="([^"]*)"/);
    const isGroup = /SelectsOnInvoked="False"/.test(t) || (!tagm && cm);
    const name = cm ? splitBilingual(unescapeXml(cm[1])) : { en: '', zh: '' };
    if (tagm) {
      const leaf = { tag: tagm[1], name, ...(meta[tagm[1]] || {}) };
      const parent = groupStack[groupStack.length - 1];
      if (parent) parent.modules.push(leaf);
      else if (curSection) curSection.modules.push(leaf);
    } else if (isGroup) {
      const group = { name, modules: [] };
      const parent = groupStack[groupStack.length - 1];
      if (parent) (parent.subgroups ||= []).push(group);
      else if (curSection) curSection.groups.push(group);
      if (!/\/>\s*$/.test(t)) groupStack.push(group);
    }
    continue;
  }
  if (t.startsWith('</NavigationViewItem.MenuItems>')) groupStack.pop();
}

const NATIVE_SECTIONS = new Set(['Categories', 'Windows 11']);
const NATIVE_TAGS = new Set(['module.native']);
let idc = 0;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `s${idc++}`;
const mkMod = (x, sn) => ({
  tag: x.tag,
  en: x.en || x.name?.en || x.tag,
  zh: x.zh || x.name?.zh || '',
  glyph: x.glyph || '',
  keywords: x.keywords || '',
  native: NATIVE_TAGS.has(x.tag) || sn,
});

const sections = sectionsRaw.map((s) => {
  const sn = NATIVE_SECTIONS.has(s.name.en);
  return {
    id: slug(s.name.en),
    en: s.name.en,
    zh: s.name.zh,
    native: sn,
    directModules: (s.modules || []).filter((x) => x.tag !== 'shell.allapps').map((x) => mkMod(x, sn)),
    groups: (s.groups || []).map((g) => ({
      id: slug(g.name.en),
      en: g.name.en,
      zh: g.name.zh,
      modules: (g.modules || []).map((x) => mkMod(x, sn)),
      subgroups: (g.subgroups || []).map((sg) => ({
        id: slug(sg.name.en),
        en: sg.name.en,
        zh: sg.name.zh,
        modules: (sg.modules || []).map((x) => mkMod(x, sn)),
      })),
    })),
  };
});

const all = [];
for (const s of sections) {
  all.push(...s.directModules);
  for (const g of s.groups) {
    all.push(...g.modules);
    for (const sg of g.subgroups || []) all.push(...sg.modules);
  }
}
const seen = new Set();
const allModules = all.filter((x) => (seen.has(x.tag) ? false : seen.add(x.tag)));

const header = `// AUTO-GENERATED from WinForge MainWindow.xaml nav tree + Services/ModuleRegistry.cs.
// Regenerate with: node tools/gen-catalog.mjs [path-to-WinForge]
// ${allModules.length} modules across ${sections.length} sections.
/* eslint-disable */

export interface CatalogModule {
  tag: string;
  en: string;
  zh: string;
  glyph: string;
  keywords: string;
  native: boolean;
}
export interface CatalogGroup {
  id: string;
  en: string;
  zh: string;
  modules: CatalogModule[];
  subgroups?: CatalogGroup[];
}
export interface CatalogSection {
  id: string;
  en: string;
  zh: string;
  native: boolean;
  directModules: CatalogModule[];
  groups: CatalogGroup[];
}
`;
const body =
  `\nexport const catalog: CatalogSection[] = ${JSON.stringify(sections, null, 2)};\n` +
  `\nexport const allModules: CatalogModule[] = ${JSON.stringify(allModules, null, 2)};\n` +
  `\nexport const moduleCount = ${allModules.length};\n`;

fs.writeFileSync(OUT, header + body);
console.log(`Wrote ${OUT}: ${allModules.length} modules, ${sections.length} sections`);
