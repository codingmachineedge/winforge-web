// List every t('<ns>.<key>') reference in given modules that has no key line anywhere in the
// module's i18n home file. Usage: node check-i18n-refs.mjs <fileName:ns:home> ...
import fs from 'node:fs';
const ROOT = process.cwd();
const ident = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const report = {};
for (const spec of process.argv.slice(2)) {
  const [fileName, ns, home] = spec.split(':');
  const modSrc = fs.readFileSync(`${ROOT}/src/modules/${fileName}`, 'utf8');
  const i18nSrc =
    home === 'batchB'
      ? fs.readFileSync(`${ROOT}/src/i18n/batchB.ts`, 'utf8')
      : fs.readFileSync(`${ROOT}/src/i18n/en.ts`, 'utf8');
  const refs = new Set();
  const re = new RegExp(`t\\(\\s*['"\`]${ns}\\.([a-zA-Z0-9_]+)['"\`]`, 'g');
  let m;
  while ((m = re.exec(modSrc))) refs.add(m[1]);
  const missing = [...refs].filter((k) => !new RegExp(`^\\s+"?${ident(k)}"?\\s*:`, 'm').test(i18nSrc)).sort();
  if (missing.length) report[`${fileName} (${ns} → ${home})`] = missing;
}
console.log(JSON.stringify(report, null, 1));
