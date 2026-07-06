// Regenerate src/data/tweaks.ts from the LIVE WinForge app's own feature export.
//
//   node tools/gen-tweaks.mjs [exportDir] [--exe <WinForge.exe>]
//
// WinForge ships a headless exporter — `WinForge.exe --export-docs <dir>` writes one
// uniform Markdown file per feature (id, category, kind, admin/destructive/restart,
// bilingual title + description + keywords). That is the CANONICAL, deterministic
// source for the ~895 Windows-tweak catalog (the desktop's TweakCatalog). We parse
// those docs into a typed TS array the web app can render as a browsable, searchable,
// fully-bilingual catalog (registry writes stay desktop-only, gated on isTauri()).
//
// The Git / Archives / Media folders are the operations of already-ported *modules*
// (module.git / module.archives / module.media), not standalone tweaks, so they are
// excluded here to keep tweaks.ts aligned with the 22-category / 895-feature count.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'data', 'tweaks.ts');

// Folders that are module operations, not TweakCatalog tweaks (already ported as modules).
const EXCLUDE_FOLDERS = new Set(['git-github', 'archives', 'media']);

// ---- locate / produce the export directory ---------------------------------
const args = process.argv.slice(2);
const exeIdx = args.indexOf('--exe');
const exeArg = exeIdx >= 0 ? args[exeIdx + 1] : null;
const dirArg = args.find((a, i) => !a.startsWith('--') && !(exeIdx >= 0 && i === exeIdx + 1));

function findExe() {
  if (exeArg && fs.existsSync(exeArg)) return exeArg;
  const roots = ['C:/Users/cntow/Documents/GitHub/WinForge'];
  const tfm = 'net11.0-windows10.0.26100.0';
  for (const r of roots) {
    for (const p of [
      `${r}/bin/x64/Debug/${tfm}/win-x64/publish/WinForge.exe`,
      `${r}/bin/Debug/${tfm}/win-x64/publish/WinForge.exe`,
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function produceExport() {
  const exe = findExe();
  if (!exe) {
    throw new Error(
      'No export dir given and no published WinForge.exe found. Pass an export dir, or publish self-contained and re-run.',
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winforge-tweakdocs-'));
  console.log(`Running headless export: ${exe} --export-docs ${tmp}`);
  const r = spawnSync(exe, ['--export-docs', tmp], { timeout: 120000, stdio: 'ignore' });
  if (r.error) throw r.error;
  if (!fs.existsSync(path.join(tmp, '_export_count.txt')))
    throw new Error('Export did not complete (no _export_count.txt).');
  return tmp;
}

const EXPORT_DIR = dirArg && fs.existsSync(dirArg) ? dirArg : produceExport();
console.log(`Parsing export dir: ${EXPORT_DIR}`);

// ---- parse one feature Markdown doc ----------------------------------------
// Split a "English · 粵語" bilingual string on the FIRST ' · '. English (Latin) first,
// 粵語 (CJK) second — matching the desktop LocalizedText(en, zh) convention.
function splitBilingual(s) {
  const i = s.indexOf(' · ');
  return i < 0 ? { en: s.trim(), zh: s.trim() } : { en: s.slice(0, i).trim(), zh: s.slice(i + 3).trim() };
}

function row(md, label) {
  const re = new RegExp(`^\\|\\s*\\*\\*${label}[^|]*\\*\\*\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function section(md, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|^---\\s*$|^_Part of)`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function parseDoc(md, catId) {
  const titleM = md.match(/^#\s+(.+?)\s*$/m);
  if (!titleM) return null;
  const title = splitBilingual(titleM[1]);

  const idRaw = row(md, 'ID');
  const id = idRaw ? idRaw.replace(/^`|`$/g, '') : null;
  if (!id) return null;

  const mod = splitBilingual(row(md, 'Module · 模組') || ' · ');
  const kind = (row(md, 'Type · 種類') || 'Action').trim();
  const admin = /Yes/.test(row(md, 'Administrator · 管理員') || '');
  const destructive = /Yes/.test(row(md, 'Destructive · 具破壞性') || '');
  const restart = (row(md, 'Restart · 重啟') || 'None').trim();
  const actionRaw = row(md, 'Action · 動作');
  const action = actionRaw ? splitBilingual(actionRaw) : null;

  const descEn = section(md, 'English');
  const descZh = section(md, '粵語');

  const kwM = md.match(/_Keywords · 關鍵字:\s*(.+?)_/);
  const keywords = kwM ? kwM[1].split(',').map((k) => k.trim()).filter(Boolean).join(' ') : '';

  return {
    id,
    cat: catId,
    catEn: mod.en,
    catZh: mod.zh,
    en: title.en,
    zh: title.zh,
    descEn,
    descZh,
    kind,
    admin,
    destructive,
    restart,
    ...(action ? { actionEn: action.en, actionZh: action.zh } : {}),
    keywords,
  };
}

// ---- walk the export -------------------------------------------------------
const folders = fs
  .readdirSync(EXPORT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !EXCLUDE_FOLDERS.has(d.name))
  .map((d) => d.name)
  .sort();

const tweaks = [];
const catMeta = new Map(); // slug -> {en, zh, count}
for (const folder of folders) {
  const dir = path.join(EXPORT_DIR, folder);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    const t = parseDoc(md, folder);
    if (!t) {
      console.warn(`  skipped (unparseable): ${folder}/${f}`);
      continue;
    }
    tweaks.push(t);
    const cm = catMeta.get(folder) || { en: t.catEn, zh: t.catZh, count: 0 };
    cm.count++;
    if (!cm.en && t.catEn) cm.en = t.catEn;
    if (!cm.zh && t.catZh) cm.zh = t.catZh;
    catMeta.set(folder, cm);
  }
}

// Stable ordering: category slug, then tweak id.
tweaks.sort((a, b) => (a.cat === b.cat ? a.id.localeCompare(b.id) : a.cat.localeCompare(b.cat)));

const tweakCategories = folders
  .filter((f) => catMeta.has(f))
  .map((f) => ({ id: f, en: catMeta.get(f).en, zh: catMeta.get(f).zh, count: catMeta.get(f).count }));

// ---- emit ------------------------------------------------------------------
const header = `// AUTO-GENERATED from WinForge's own headless export (WinForge.exe --export-docs).
// Regenerate with: node tools/gen-tweaks.mjs [exportDir]
// ${tweaks.length} Windows tweaks across ${tweakCategories.length} categories — the desktop TweakCatalog.
// Registry writes are desktop-only; the web renders these as a browsable, searchable bilingual catalog.
/* eslint-disable */

export type TweakKind = 'Action' | 'Toggle' | 'RadioGroup' | 'Choice' | 'Slider' | 'Info' | 'Wizard' | 'Color';
export type RestartScope = 'None' | 'Explorer' | 'SignOut' | 'Reboot';

export interface TweakData {
  /** Stable catalog id, e.g. "appearance.accent-colour". */
  id: string;
  /** Owning category slug (matches tweakCategories[].id). */
  cat: string;
  catEn: string;
  catZh: string;
  en: string;
  zh: string;
  descEn: string;
  descZh: string;
  kind: TweakKind;
  /** Requires elevation (HKLM / services / powercfg …). */
  admin: boolean;
  /** Destructive / irreversible — the desktop UI confirms first. */
  destructive: boolean;
  restart: RestartScope;
  /** Present for Action tweaks — the button label. */
  actionEn?: string;
  actionZh?: string;
  /** Space-joined bilingual search keywords. */
  keywords: string;
}

export interface TweakCategory {
  id: string;
  en: string;
  zh: string;
  count: number;
}
`;

const body =
  `\nexport const tweaks: TweakData[] = ${JSON.stringify(tweaks, null, 2)};\n` +
  `\nexport const tweakCategories: TweakCategory[] = ${JSON.stringify(tweakCategories, null, 2)};\n` +
  `\nexport const tweakCount = ${tweaks.length};\n` +
  `\n/** All tweaks for one category, in stable id order. */\n` +
  `export function tweaksForCategory(catId: string): TweakData[] {\n` +
  `  return tweaks.filter((t) => t.cat === catId);\n}\n`;

fs.writeFileSync(OUT, header + body);
console.log(
  `Wrote ${OUT}: ${tweaks.length} tweaks across ${tweakCategories.length} categories.`,
);
for (const c of tweakCategories) console.log(`  ${String(c.count).padStart(4)}  ${c.id}  (${c.en})`);
