// Upgrade-wave integrator: merges NEW flat i18n keys into a module's EXISTING namespace
// block (the port pipeline's integrate.mjs only ADDS whole new namespaces — upgrades extend
// namespaces that already live in en.ts/zh-Hant.ts or batchB.ts).
//
//   node tools/port-pipeline/upgrade-integrate.mjs <task-output.json> [--root <repo-root>]
//
// Expected result shape per module (from the upgrade workflow):
//   { tag, fileName, namespace, i18nFile: 'en' | 'batchB', newEnKeys, newZhKeys, wrote }
// Keys are FLAT (single level under the namespace). Existing keys are left untouched;
// a returned key that already exists in the file is skipped (agents sometimes echo them).

import fs from 'node:fs';

const args = process.argv.slice(2);
const outFile = args[0];
const rootIx = args.indexOf('--root');
const ROOT = rootIx >= 0 ? args[rootIx + 1] : 'C:/Users/cntow/Documents/GitHub/winforge-web-parity1';

const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const results = (out.result && out.result.results) || out.results || [];
if (!results.length) {
  console.log('no results in', outFile);
  process.exit(1);
}

const ident = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

/** Insert flat keys right after the `  <ns>: {` opener inside the given file text. */
function mergeIntoNs(file, ns, keys, indent) {
  let src = fs.readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`^(${indent}${ns}: \\{)`, 'm');
  if (!re.test(src)) throw new Error(`namespace block "${ns}" not found in ${file}`);
  // Drop keys that already exist anywhere in the file's ns block region (cheap textual check
  // over the whole file is fine: keys are namespaced by position, collisions just skip).
  const fresh = Object.entries(keys).filter(([k]) => {
    // Quote-aware: the original port integrator wrote JSON-style quoted keys ("gitOk":).
    const kRe = new RegExp(`^\\s*"?${ident(k).replace(/[$]/g, '\\$')}"?\\s*:`, 'm');
    const nsStart = src.search(re);
    const after = src.slice(nsStart, nsStart + 40000); // ns blocks are < 40k chars
    return !kRe.test(after.slice(0, after.indexOf(eol + indent.slice(0, indent.length - 2) + '}') + 1 || undefined));
  });
  if (!fresh.length) return { src: null, added: 0 };
  const block = fresh.map(([k, v]) => `${indent}  ${ident(k)}: ${JSON.stringify(v)},`).join(eol);
  src = src.replace(re, `$1${eol}${block}`);
  fs.writeFileSync(file, src);
  return { src, added: fresh.length };
}

let totalAdded = 0;
const files = new Set();
for (const r of results) {
  if (!r || r.wrote === false) continue;
  const ns = r.namespace;
  const enKeys = r.newEnKeys || {};
  const zhKeys = r.newZhKeys || {};
  const enSet = new Set(Object.keys(enKeys));
  const zhSet = new Set(Object.keys(zhKeys));
  for (const k of enSet) if (!zhSet.has(k)) throw new Error(`${ns}: EN key "${k}" missing 粵語 twin`);
  for (const k of zhSet) if (!enSet.has(k)) throw new Error(`${ns}: 粵語 key "${k}" missing EN twin`);

  if (r.i18nFile === 'batchB') {
    // batchB.ts has TWO blocks (enB then yueB) with the same "  ns: {" opener — split the file.
    const f = `${ROOT}/src/i18n/batchB.ts`;
    let src = fs.readFileSync(f, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const yueStart = src.indexOf('export const yueB');
    if (yueStart < 0) throw new Error('yueB marker not found');
    const head = src.slice(0, yueStart);
    const tail = src.slice(yueStart);
    const inject = (part, keys) => {
      const re = new RegExp(`^(  ${ns}: \\{)`, 'm');
      if (!re.test(part)) {
        // The ns block is missing on this side (a historic integrator crash dropped some EN
        // blocks — weblogin, sshmod). Create the whole block right after the export opener.
        const opener = /^(export const (enB|yueB)[^\n]*\{)/m;
        if (!opener.test(part)) throw new Error(`ns "${ns}" absent and no enB/yueB opener found`);
        const block = Object.entries(keys).map(([k, v]) => `    ${ident(k)}: ${JSON.stringify(v)},`).join(eol);
        console.log(`  (created missing "${ns}" block on this side)`);
        return { part: part.replace(opener, `$1${eol}  ${ns}: {${eol}${block}${eol}  },`), added: Object.keys(keys).length };
      }
      const fresh = Object.entries(keys).filter(([k]) => !new RegExp(`^\\s{4}"?${ident(k)}"?\\s*:`, 'm').test(part));
      if (!fresh.length) return { part, added: 0 };
      const block = fresh.map(([k, v]) => `    ${ident(k)}: ${JSON.stringify(v)},`).join(eol);
      return { part: part.replace(re, `$1${eol}${block}`), added: fresh.length };
    };
    const h = inject(head, enKeys);
    const t2 = inject(tail, zhKeys);
    fs.writeFileSync(f, h.part + t2.part);
    totalAdded += h.added + t2.added;
    console.log(`${ns}: +${h.added} EN / +${t2.added} 粵語 keys into batchB.ts`);
    files.add(f);
  } else {
    const enFile = `${ROOT}/src/i18n/en.ts`;
    const zhFile = `${ROOT}/src/i18n/zh-Hant.ts`;
    const a = mergeIntoNs(enFile, ns, enKeys, '  ');
    const b = mergeIntoNs(zhFile, ns, zhKeys, '  ');
    totalAdded += a.added + b.added;
    console.log(`${ns}: +${a.added} EN keys into en.ts, +${b.added} 粵語 keys into zh-Hant.ts`);
    files.add(enFile);
    files.add(zhFile);
  }

  // Light coverage check: every t('ns.key') in the updated module must appear in the merged file.
  const modSrc = fs.readFileSync(`${ROOT}/src/modules/${r.fileName}`, 'utf8');
  const refs = new Set();
  const re = new RegExp(`t\\(\\s*['"\`]${ns}\\.([a-zA-Z0-9_]+)['"\`]`, 'g');
  let m;
  while ((m = re.exec(modSrc))) refs.add(m[1]);
  const i18nSrc =
    r.i18nFile === 'batchB'
      ? fs.readFileSync(`${ROOT}/src/i18n/batchB.ts`, 'utf8')
      : fs.readFileSync(`${ROOT}/src/i18n/en.ts`, 'utf8');
  const missing = [...refs].filter((k) => !new RegExp(`^\\s+"?${ident(k)}"?\\s*:`, 'm').test(i18nSrc));
  if (missing.length) console.log(`  ⚠ ${ns}: possibly unresolved keys: ${missing.slice(0, 10).join(', ')}`);
}
console.log(`done — ${totalAdded} keys merged. Files touched: ${[...files].map((f) => f.split('/').pop()).join(', ')}`);
