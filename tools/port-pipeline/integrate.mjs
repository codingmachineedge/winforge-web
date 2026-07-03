import fs from 'node:fs';

const ROOT = 'C:/Users/cntow/Documents/GitHub/winforge-web';
const OUT = 'C:/Users/cntow/AppData/Local/Temp/claude/C--Users-cntow-Documents-GitHub-winforge-web-docs/e4efcd44-6660-4ec5-ad58-2e6d614b67a3/tasks/wn6aql3em.output';

// Run journal dir — fallback if the aggregated OUT file lags behind the agents.
const RUNDIR = 'C:/Users/cntow/.claude/projects/C--Users-cntow-Documents-GitHub-winforge-web-docs/e4efcd44-6660-4ec5-ad58-2e6d614b67a3/subagents/workflows/wf_a293b337-a4f';

function fromJournals(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f))) {
    const lines = fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean);
    let r = null;
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (!JSON.stringify(o).includes('enKeys')) continue;
        const walk = (x) => { if (x && typeof x === 'object') { if (x.namespace && x.enKeys && x.tag) return x; for (const k in x) { const v = walk(x[k]); if (v) return v; } } return null; };
        const v = walk(o); if (v) r = v;
      } catch { /* skip */ }
    }
    if (r) out.push(r);
  }
  return out;
}

let modules = [];
try { modules = JSON.parse(fs.readFileSync(OUT, 'utf8')).result || []; } catch { /* not ready */ }
if (!modules.length) { console.log('OUT empty — extracting from journals'); modules = fromJournals(RUNDIR); }
// Idempotency: skip any module already wired into the registry (re-run safe).
{
  let regNow = '';
  for (const f of ['src/modules/registry.tsx', 'src/modules/registryB.tsx']) if (fs.existsSync(`${ROOT}/${f}`)) regNow += fs.readFileSync(`${ROOT}/${f}`, 'utf8');
  const before = modules.length;
  modules = modules.filter((m) => !regNow.includes(`'${m.tag}'`));
  if (before !== modules.length) console.log(`Skipping ${before - modules.length} already-registered module(s).`);
}

// Build a nested tree from a flat key map, stripping a leading "<ns>." if the worker added it.
function buildTree(ns, keys) {
  const tree = {};
  for (const [rawK, v] of Object.entries(keys)) {
    let k = rawK;
    if (k.startsWith(ns + '.')) k = k.slice(ns.length + 1);
    const parts = k.split('.');
    let cur = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return tree;
}

// Collect the leaf key-paths of a tree.
function leaves(tree, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object') out.push(...leaves(v, p));
    else out.push(p);
  }
  return out;
}

let problems = [];
const enBlocks = [], zhBlocks = [], regImports = [], regEntries = [];

for (const m of modules) {
  const ns = m.namespace;
  const enTree = buildTree(ns, m.enKeys);
  const zhTree = buildTree(ns, m.zhKeys);

  // 1) EN/ZH structural parity (required by zhHant: Resources = typeof en)
  const enLeaves = new Set(leaves(enTree));
  const zhLeaves = new Set(leaves(zhTree));
  for (const l of enLeaves) if (!zhLeaves.has(l)) problems.push(`${ns}: EN has "${l}" but 粵語 is missing it`);
  for (const l of zhLeaves) if (!enLeaves.has(l)) problems.push(`${ns}: 粵語 has "${l}" but EN is missing it`);

  // 2) Every static t('ns.x') the module references must resolve in enTree
  const src = fs.readFileSync(`${ROOT}/src/modules/${m.fileName}`, 'utf8');
  const staticKeys = new Set();
  const re = /t\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let mm;
  while ((mm = re.exec(src))) if (mm[1].startsWith(ns + '.')) staticKeys.add(mm[1].slice(ns.length + 1));
  // A key is satisfied if it exists directly OR via a react-i18next plural suffix.
  const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other'];
  const resolves = (k) => enLeaves.has(k) || PLURALS.some((s) => enLeaves.has(k + s));
  for (const k of staticKeys) {
    if (!k) continue; // empty subkey = a dynamic/commented reference, not a real key
    if (!resolves(k)) problems.push(`${ns}: module references t('${ns}.${k}') but no such key was provided`);
  }

  // Serialize namespace object, re-indent by 2 (sits inside the outer object).
  const enJson = JSON.stringify(enTree, null, 2).replace(/\n/g, '\n  ');
  const zhJson = JSON.stringify(zhTree, null, 2).replace(/\n/g, '\n  ');
  enBlocks.push(`  ${ns}: ${enJson},`);
  zhBlocks.push(`  ${ns}: ${zhJson},`);
  regImports.push(`import { ${m.importName} } from './${m.fileName.replace(/\.tsx$/, '')}';`);
  regEntries.push(`  '${m.tag}': ${m.importName},`);
}

if (problems.length) {
  console.log('VALIDATION PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('Validation OK for', modules.length, 'modules:', modules.map((m) => m.namespace).join(', '));

// --- patch en.ts ---
let en = fs.readFileSync(`${ROOT}/src/i18n/en.ts`, 'utf8');
en = en.replace('export const en = {\n', 'export const en = {\n' + enBlocks.join('\n') + '\n');
fs.writeFileSync(`${ROOT}/src/i18n/en.ts`, en);

// --- patch zh-Hant.ts ---
let zh = fs.readFileSync(`${ROOT}/src/i18n/zh-Hant.ts`, 'utf8');
zh = zh.replace('export const zhHant: Resources = {\n', 'export const zhHant: Resources = {\n' + zhBlocks.join('\n') + '\n');
fs.writeFileSync(`${ROOT}/src/i18n/zh-Hant.ts`, zh);

// --- patch registry.tsx ---
let reg = fs.readFileSync(`${ROOT}/src/modules/registry.tsx`, 'utf8');
reg = reg.replace("import { moduleRegistryB } from './registryB';", regImports.join('\n') + "\nimport { moduleRegistryB } from './registryB';");
reg = reg.replace('  ...moduleRegistryB,', regEntries.join('\n') + '\n  ...moduleRegistryB,');
fs.writeFileSync(`${ROOT}/src/modules/registry.tsx`, reg);

console.log('Patched en.ts, zh-Hant.ts, registry.tsx.');
console.log('Registered:', modules.map((m) => m.tag).join(', '));
