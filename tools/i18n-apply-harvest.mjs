// Apply harvested/authored i18n strings into the correct slice files. WORK-IN-PROGRESS tool for
// the i18n-rot repair (docs task: "Repair repo-wide i18n rot"). Not yet run end-to-end at scale —
// two known limitations remain: (1) it skips namespaces whose block was deleted entirely from the
// owning file (they must be recreated first); (2) it has only been exercised on the harvested
// author-stage output. Review the diff before trusting a bulk run on the CRLF slice files.
//
// Input JSON shape: { "<ns>": { en: [{key,text}], yue: [{key,text}], fromQA: bool }, ... }
// Placement: EN keys → enB (batchB.ts) if the ns lives there, else en.ts; 粵 keys → yueB else zh-Hant.ts.
// Keys are normalized to their leaf (a stray "ns.key" from an agent is reduced to "key").
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

// Region within batchB for enB vs yueB exports.
function regionBounds(text, exportName) {
  const start = text.indexOf(`export const ${exportName}`);
  if (start < 0) return null;
  const next = text.indexOf('export const ', start + 10);
  return { start, end: next < 0 ? text.length : next };
}

// Find "  <ns>: {" block within [start,end); return {open, close} indices (close = index of '}').
function nsBlock(text, ns, start, end) {
  const re = new RegExp(`^  ${ns}: \\{`, 'm');
  const sub = text.slice(start, end);
  const m = re.exec(sub);
  if (!m) return null;
  const i = start + m.index;
  let depth = 0;
  let j = i;
  for (; j < end; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return { open: i, close: j };
}

function existingKeys(text, open, close) {
  const body = text.slice(open, close);
  return new Set([...body.matchAll(/^\s{4}([A-Za-z0-9_$]+):/gm)].map((m) => m[1]));
}

// Escape a string for a single-quoted TS literal.
function q(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}

// Decide which file+export owns a namespace for a given language.
function home(ns, lang) {
  const b = read(FILES.batchB);
  const enR = regionBounds(b, 'enB');
  const yueR = regionBounds(b, 'yueB');
  if (lang === 'en') {
    if (nsBlock(b, ns, enR.start, enR.end)) return { file: FILES.batchB, region: enR };
    return { file: FILES.en, region: null }; // whole file is one object
  }
  if (nsBlock(b, ns, yueR.start, yueR.end)) return { file: FILES.batchB, region: yueR };
  return { file: FILES.zh, region: null };
}

// Insert entries into a namespace block (creating the block if absent isn't needed here — every
// target ns already exists in at least one language; but guard anyway).
function insert(file, region, ns, entries) {
  let text = read(file);
  const eol = eolOf(text);
  const r = region ?? { start: 0, end: text.length };
  let blk = nsBlock(text, ns, r.start, r.end);
  if (!blk) return { added: 0, missingBlock: true };
  const have = existingKeys(text, blk.open, blk.close);
  // Normalize each key to its leaf: agents sometimes return "ns.key"; inserting that verbatim
  // produces an invalid dotted object key and corrupts the block. Take the segment after the last dot.
  const norm = entries.map((e) => ({ key: e.key.includes('.') ? e.key.slice(e.key.lastIndexOf('.') + 1) : e.key, text: e.text }));
  const fresh = norm.filter((e) => /^[A-Za-z0-9_$]+$/.test(e.key) && !have.has(e.key));
  if (!fresh.length) return { added: 0 };
  const lines = fresh.map((e) => `    ${e.key}: ${q(e.text)},`).join(eol) + eol + '  ';
  text = text.slice(0, blk.close) + lines + text.slice(blk.close);
  cache[file] = text;
  return { added: fresh.length };
}

const report = { applied: {}, skipped: {} };
for (const [ns, data] of Object.entries(harvest)) {
  for (const lang of ['en', 'yue']) {
    const entries = (lang === 'en' ? data.en : data.yue) || [];
    if (!entries.length) continue;
    const h = home(ns, lang);
    const res = insert(h.file, h.region, ns, entries);
    if (res.missingBlock) (report.skipped[ns] ??= []).push(`${lang}: no block in ${h.file.split('/').pop()}`);
    else (report.applied[ns] ??= []).push(`${lang}:+${res.added}`);
  }
}

for (const [f, text] of Object.entries(cache)) fs.writeFileSync(f, text);
const total = Object.values(report.applied).flat().reduce((a, s) => a + parseInt(s.split('+')[1] || '0'), 0);
console.log('namespaces applied:', Object.keys(report.applied).length, '| total keys inserted:', total);
if (Object.keys(report.skipped).length) console.log('SKIPPED:', JSON.stringify(report.skipped));
