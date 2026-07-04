// Rank registered modules by their WinForge C# page size vs the current TS port size, to
// prioritise the feature-parity campaign objectively. Prints the biggest gaps first.
//
//   node tools/port-pipeline/gap-scan.mjs [--skip tag1,tag2,...]
import fs from 'node:fs';

const ROOT = 'C:/Users/cntow/Documents/GitHub/winforge-web';
const CS = 'C:/Users/cntow/Documents/GitHub/WinForge';
const skipArg = process.argv.indexOf('--skip');
const SKIP = new Set(skipArg >= 0 ? process.argv[skipArg + 1].split(',') : []);
// Also read the persisted done-list so we don't have to pass the full skip every wave.
const donePath = `${import.meta.dirname}/parity-done.txt`;
if (fs.existsSync(donePath))
  for (const line of fs.readFileSync(donePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) SKIP.add(t);
  }

// tag -> C# page class, from MainWindow.xaml.cs "module.x" => typeof(YModule)
const mw = fs.readFileSync(`${CS}/MainWindow.xaml.cs`, 'utf8');
const tagToPage = {};
for (const m of mw.matchAll(/"(module\.[a-z0-9]+)"\s*=>\s*typeof\((\w+)\)/g)) tagToPage[m[1]] = m[2];

// tag -> TS component, from the three registries
let reg = '';
for (const f of ['registry.tsx', 'registryA.tsx', 'registryB.tsx']) {
  const p = `${ROOT}/src/modules/${f}`;
  if (fs.existsSync(p)) reg += fs.readFileSync(p, 'utf8');
}
const tagToComp = {};
for (const m of reg.matchAll(/['"`](module\.[a-z0-9]+)['"`]\s*:\s*(\w+)/g)) tagToComp[m[1]] = m[2];

const loc = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').length : 0);

const rows = [];
for (const [tag, comp] of Object.entries(tagToComp)) {
  if (SKIP.has(tag.replace('module.', ''))) continue;
  const page = tagToPage[tag];
  const csLoc = page ? loc(`${CS}/Pages/${page}.xaml.cs`) : 0;
  const tsLoc = loc(`${ROOT}/src/modules/${comp}.tsx`);
  if (csLoc === 0) continue; // pure-web module with no native C# page — lower parity priority
  rows.push({ tag: tag.replace('module.', ''), comp, page, csLoc, tsLoc, gap: csLoc - tsLoc / 3 });
}
rows.sort((a, b) => b.csLoc - a.csLoc);
console.log('tag                comp                        C#LOC  TSLoc  page');
for (const r of rows.slice(0, 40)) {
  console.log(
    `${r.tag.padEnd(18)} ${r.comp.padEnd(26)} ${String(r.csLoc).padStart(5)} ${String(r.tsLoc).padStart(6)}  ${r.page}`,
  );
}
console.log(`\n${rows.length} native modules with a C# page remain unscanned/undone.`);
