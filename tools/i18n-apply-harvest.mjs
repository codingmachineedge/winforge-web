// Apply harvested/authored i18n strings into the correct slice files (the i18n-rot burn-down;
// see src/i18n/moduleKeys.baseline.json). Battle-hardened against the failure modes hit on
// 2026-07-05:
//   • brace scanning is STRING-AWARE (module strings legitimately contain { } — a naive depth
//     counter mis-finds the block end and corrupts the file);
//   • new keys are inserted right AFTER the block's opening line (inserting before the closing
//     brace inherits its 2-space indent and mis-indents the first key);
//   • keys are ns-prefix-stripped ("ns.key" → "key"); any OTHER dotted key is skipped + reported
//     (could be a genuine nested path — never guess);
//   • a namespace block missing from the owning file is CREATED at the end of the owning export.
//
// Input JSON shape: { "<ns>": { en: [{key,text}], yue: [{key,text}] }, ... }
// Placement: EN → enB (batchB.ts) if the ns lives in enB OR yueB, else en.ts; 粵 → mirrored.
// Always verify afterwards: npx tsc --noEmit && npx vitest run src/i18n/moduleKeys.test.ts
import fs from 'node:fs';

const REPO = 'C:/Users/cntow/Documents/GitHub/winforge-web';
const harvestPath = process.argv[2] || 'C:/Users/cntow/AppData/Local/Temp/i18n-harvested.json';
const harvest = JSON.parse(fs.readFileSync(harvestPath, 'utf8'));

const FILES = {
  en: `${REPO}/src/i18n/en.ts`,
  zh: `${REPO}/src/i18n/zh-Hant.ts`,
  batchB: `${REPO}/src/i18n/batchB.ts`,
};
const cache = {};
const read = (f) => (cache[f] ??= fs.readFileSync(f, 'utf8'));
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

/** Walk forward from an opening '{' to its matching '}', skipping string literals. */
function matchBrace(text, openIdx, limit) {
  let depth = 0;
  let inStr = null;
  for (let j = openIdx; j < limit; j++) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') j++; // skip escaped char
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Bounds of `export const <name> = {...}` within a file. */
function regionBounds(text, exportName) {
  const start = text.indexOf(`export const ${exportName}`);
  if (start < 0) return null;
  const next = text.indexOf('export const ', start + 10);
  return { start, end: next < 0 ? text.length : next };
}

/** Find the "  <ns>: {" block inside [start,end): { open: idx of the 'n' in ns, brace, close }. */
function nsBlock(text, ns, start, end) {
  const re = new RegExp(`^  ${ns}: \\{`, 'm');
  const m = re.exec(text.slice(start, end));
  if (!m) return null;
  const open = start + m.index;
  const brace = text.indexOf('{', open);
  const close = matchBrace(text, brace, end);
  if (close < 0) throw new Error(`unbalanced block for ns '${ns}'`);
  return { open, brace, close };
}

function existingKeys(text, open, close) {
  return new Set([...text.slice(open, close).matchAll(/^\s{4}([A-Za-z0-9_$]+):/gm)].map((m) => m[1]));
}

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;

/** Owning file + export for (ns, lang). batchB wins if the ns exists in EITHER of its regions. */
function home(ns, lang) {
  const b = read(FILES.batchB);
  const enR = regionBounds(b, 'enB');
  const yueR = regionBounds(b, 'yueB');
  const inB = nsBlock(b, ns, enR.start, enR.end) || nsBlock(b, ns, yueR.start, yueR.end);
  if (lang === 'en') {
    if (inB) return { file: FILES.batchB, exportName: 'enB' };
    return { file: FILES.en, exportName: 'en' };
  }
  if (inB) return { file: FILES.batchB, exportName: 'yueB' };
  return { file: FILES.zh, exportName: 'zhHant' };
}

/** Create an empty "  ns: {\n  }," block at the END of the export's object literal. */
function createBlock(file, exportName, ns) {
  let text = read(file);
  const eol = eolOf(text);
  const r = regionBounds(text, exportName);
  const brace = text.indexOf('{', r.start);
  const close = matchBrace(text, brace, r.end);
  if (close < 0) throw new Error(`unbalanced export ${exportName} in ${file}`);
  // Insert just before the export's closing brace, on its own lines.
  const block = `  ${ns}: {${eol}  },${eol}`;
  // Ensure we sit at the start of the closing brace's line.
  const lineStart = text.lastIndexOf(eol, close) + eol.length;
  cache[file] = text.slice(0, lineStart) + block + text.slice(lineStart);
}

/** Insert entries right after the block's opening line. */
function insert(file, exportName, ns, entries, report) {
  let text = read(file);
  const eol = eolOf(text);
  const r = regionBounds(text, exportName);
  let blk = nsBlock(text, ns, r.start, r.end);
  if (!blk) {
    createBlock(file, exportName, ns);
    text = read(file);
    blk = nsBlock(text, ns, regionBounds(text, exportName).start, regionBounds(text, exportName).end);
    (report.created ??= []).push(`${ns} → ${exportName}`);
  }
  const have = existingKeys(text, blk.open, blk.close);
  const fresh = [];
  for (const e of entries) {
    let key = e.key;
    if (key.startsWith(`${ns}.`)) key = key.slice(ns.length + 1); // strip an echoed ns prefix
    if (!/^[A-Za-z0-9_$]+$/.test(key)) {
      (report.dottedSkipped ??= []).push(`${ns}: ${e.key}`);
      continue;
    }
    if (!have.has(key)) fresh.push({ key, text: e.text });
  }
  if (!fresh.length) return 0;
  const lineEnd = text.indexOf(eol, blk.brace) + eol.length;
  const lines = fresh.map((e) => `    ${e.key}: ${q(e.text)},`).join(eol) + eol;
  cache[file] = text.slice(0, lineEnd) + lines + text.slice(lineEnd);
  return fresh.length;
}

const report = { applied: {} };
for (const [ns, data] of Object.entries(harvest)) {
  for (const lang of ['en', 'yue']) {
    const entries = (lang === 'en' ? data.en : data.yue) || [];
    if (!entries.length) continue;
    const h = home(ns, lang);
    const n = insert(h.file, h.exportName, ns, entries, report);
    if (n) (report.applied[ns] ??= []).push(`${lang}:+${n}→${h.exportName}`);
  }
}

for (const [f, text] of Object.entries(cache)) fs.writeFileSync(f, text);
const total = Object.values(report.applied)
  .flat()
  .reduce((a, s) => a + parseInt(s.match(/\+(\d+)/)?.[1] ?? '0'), 0);
console.log('namespaces touched:', Object.keys(report.applied).length, '| keys inserted:', total);
if (report.created) console.log('blocks created:', report.created.join(', '));
if (report.dottedSkipped) console.log('DOTTED KEYS SKIPPED (review):', report.dottedSkipped.join(' | '));
for (const [ns, v] of Object.entries(report.applied)) console.log(' ', ns, v.join(' '));
