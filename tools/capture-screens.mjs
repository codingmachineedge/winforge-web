// Capture the README/wiki screenshots headlessly with Edge (no Playwright dependency).
//   node tools/capture-screens.mjs [baseUrl]
// Prereqs: the dev server running (npm run dev, port 5199) and the app supporting the
// ?view= / &warm=1 / &core=1 demo params (App.tsx / ReactorView).
// Writes docs/screenshots/{catalog,control-room,core-cutaway}.png.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:5199';
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('msedge.exe not found');
  process.exit(1);
}

const SHOTS = [
  // The catalog needs only a paint; the reactor shots fast-forward timers with a virtual-time
  // budget so the sim warms up, the turbine rolls and the generator syncs before the capture.
  { name: 'catalog', url: `${BASE}/`, budget: 6000 },
  { name: 'control-room', url: `${BASE}/?view=reactor&warm=1`, budget: 30000 },
  { name: 'core-cutaway', url: `${BASE}/?view=reactor&warm=1&core=1`, budget: 30000 },
  // The Simulations tab (a catalog-section route). NOTE: module-DETAIL routes (?module=<tag>)
  // are intentionally not captured here — ModuleDetail eagerly imports the whole module registry,
  // so headless Chromium's --virtual-time-budget never settles and no frame is produced. Section
  // and shell routes render fine.
  { name: 'simulations', url: `${BASE}/?section=suite`, budget: 6000 },
];

for (const s of SHOTS) {
  const out = path.join(OUT, `${s.name}.png`);
  console.log(`capturing ${s.name} ← ${s.url}`);
  execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=1680,1050`,
      `--virtual-time-budget=${s.budget}`,
      `--screenshot=${out}`,
      s.url,
    ],
    { stdio: 'pipe', timeout: 120000 },
  );
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`  → ${out} (${kb} KB)`);
}
console.log('done');
