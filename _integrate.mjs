// Reusable wave integrator: node _integrate.mjs <task-output-file>
import { readFileSync, existsSync, writeFileSync } from 'fs';
const outFile = process.argv[2];
const out = JSON.parse(readFileSync(outFile, 'utf8'));
const results = (out.result && out.result.results) || out.results || [];
const norm = (m, ns) => { const o = {}; for (const [k, v] of Object.entries(m || {})) o[k.split('.')[0] === ns ? k : `${ns}.${k}`] = v; return o; };
const nest = (flat) => { const o = {}; for (const [k, v] of Object.entries(flat)) { const p = k.split('.'); let c = o; let ok = true; for (let i = 0; i < p.length - 1; i++) { if (typeof c[p[i]] === 'string') { ok = false; break; } c[p[i]] = c[p[i]] || {}; c = c[p[i]]; } if (!ok) { console.log('  ⚠ key collision skipped:', k); continue; } const leaf = p.at(-1); if (c[leaf] && typeof c[leaf] === 'object') { console.log('  ⚠ key collision (obj) skipped:', k); continue; } c[leaf] = v; } return o; };
const enB = {}, yueB = {}, rows = []; const missing = [];
for (const r of results) {
  if (!r.ok) continue;
  const file = `src/modules/${r.pascal}Module.tsx`;
  if (!existsSync(file)) { missing.push(r.pascal); continue; }
  Object.assign(enB, nest(norm(r.enKeys, r.namespace)));
  Object.assign(yueB, nest(norm(r.yueKeys, r.namespace)));
  rows.push({ pascal: r.pascal, tag: r.tag, ns: r.namespace });
  // key coverage warning
  const src = readFileSync(file, 'utf8');
  const used = [...new Set([...src.matchAll(/\bt\(\s*['"`]([^'"`$]+)['"`]/g)].map((m) => m[1]))];
  const flat = norm(r.enKeys, r.namespace);
  const miss = used.filter((k) => !(k in flat));
  if (miss.length) console.log('  ⚠', r.pascal, 'uncovered keys:', miss.slice(0, 8).join(', '));
}
console.log('integrating', rows.length, 'modules:', rows.map((r) => r.pascal).join(', '), '| missing files:', missing.join(',') || 'none');
if (rows.length === 0) { console.log('nothing to integrate'); process.exit(0); }
const ident = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const lit = (obj) => { let s = ''; for (const [ns, keys] of Object.entries(obj)) { s += `  ${ident(ns)}: {\n`; for (const [k, v] of Object.entries(keys)) s += `    ${ident(k)}: ${JSON.stringify(v)},\n`; s += `  },\n`; } return s; };
// batchB.ts
let b = readFileSync('src/i18n/batchB.ts', 'utf8');
b = b.replace('\n};\n\nexport const yueB', '\n' + lit(enB).replace(/\n$/, '') + '\n};\n\nexport const yueB');
const iy = b.lastIndexOf('\n};');
b = b.slice(0, iy) + '\n' + lit(yueB).replace(/\n$/, '') + b.slice(iy);
writeFileSync('src/i18n/batchB.ts', b);
// registryB.tsx
let r = readFileSync('src/modules/registryB.tsx', 'utf8');
const imports = rows.map((x) => `import { ${x.pascal}Module } from './${x.pascal}Module';`).join('\n');
const entries = rows.map((x) => `  '${x.tag}': ${x.pascal}Module,`).join('\n');
const impEnd = r.indexOf('\n', r.lastIndexOf('import { ')) + 1;
r = r.slice(0, impEnd) + imports + '\n' + r.slice(impEnd);
const close = r.indexOf('\n};', r.indexOf('moduleRegistryB'));
r = r.slice(0, close) + '\n' + entries + r.slice(close);
writeFileSync('src/modules/registryB.tsx', r);
console.log('done. files to commit:', rows.map((x) => `src/modules/${x.pascal}Module.tsx`).join(' '));
