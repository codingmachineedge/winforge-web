// Extract the concrete registry operations behind WinForge's uniform tweak builders
// (Tweak.RegToggle / RegRadio) into src/data/tweakOps.ts, so the desktop (Tauri) app can
// APPLY those tweaks for real — reading/writing the same registry value/path/kind the C#
// engine does. Only the deterministic, uniform builders are extracted (safe for real
// registry writes); bespoke/Action tweaks are intentionally left as reference.
//
//   node tools/gen-tweak-ops.mjs ["C:/path/to/WinForge"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || 'C:/Users/cntow/Documents/GitHub/WinForge';
const CAT = path.join(SRC, 'Catalog');
const OUT = path.join(__dirname, '..', 'src', 'data', 'tweakOps.ts');

// ---- C# argument splitter (string- and nesting-aware) ----------------------
// Splits the top-level comma-separated arguments of a call, respecting normal ("...")
// and verbatim (@"...") strings and (), [], {} nesting.
function splitArgs(s) {
  const args = [];
  let depth = 0;
  let i = 0;
  let start = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '@' && s[i + 1] === '"') {
      // verbatim string: "" is an escaped quote
      i += 2;
      while (i < n) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') i += 2;
          else { i += 1; break; }
        } else i += 1;
      }
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (s[i] === '\\') i += 2;
        else if (s[i] === '"') { i += 1; break; }
        else i += 1;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(s.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  if (start < n) args.push(s.slice(start).trim());
  return args.filter((a) => a.length > 0);
}

// Capture the balanced-paren body of every `<fn>(...)` call.
function findCalls(src, fn) {
  const calls = [];
  const re = new RegExp(`(?:Tweak\\.)?\\b${fn}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    const bodyStart = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '@' && src[i + 1] === '"') {
        i += 2;
        while (i < src.length) {
          if (src[i] === '"') { if (src[i + 1] === '"') i += 2; else { i += 1; break; } } else i += 1;
        }
        continue;
      }
      if (c === '"') {
        i += 1;
        while (i < src.length) {
          if (src[i] === '\\') i += 2;
          else if (src[i] === '"') { i += 1; break; }
          else i += 1;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i += 1;
    }
    calls.push(src.slice(bodyStart, i - 1));
  }
  return calls;
}

const unquote = (t) => {
  t = t.trim();
  if (t.startsWith('@"')) return t.slice(2, -1).replace(/""/g, '"');
  if (t.startsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return t;
};
const isString = (t) => t.trim().startsWith('"') || t.trim().startsWith('@"');

// name: value → {name, value}; else positional
function classify(arg) {
  const m = arg.match(/^([A-Za-z_]\w*)\s*:(?!:)\s*([\s\S]*)$/);
  return m ? { name: m[1], value: m[2].trim() } : { value: arg };
}

// A tweak value literal → a JSON-serialisable value. Numbers stay numbers; quoted stay strings.
function litValue(t) {
  t = t.trim();
  if (isString(t)) return unquote(t);
  if (/^-?\d+$/.test(t)) return Number(t);
  return t; // fallback (rare)
}

// ---- parse a file --------------------------------------------------------------
function collectConsts(src) {
  const map = {};
  // `... NAME = @"...";`  (const string, private const string, or field)
  const re = /\b([A-Za-z_]\w*)\s*=\s*@"((?:[^"]|"")*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = m[2].replace(/""/g, '"');
  return map;
}

function resolvePath(tok, consts) {
  tok = tok.trim();
  if (isString(tok)) return unquote(tok);
  if (consts[tok] !== undefined) return consts[tok];
  return null; // unresolved
}

const toggles = [];
const radios = [];
const unresolved = [];

for (const file of fs.readdirSync(CAT).filter((f) => f.endsWith('.cs'))) {
  const src = fs.readFileSync(path.join(CAT, file), 'utf8');
  const consts = collectConsts(src);

  // ---- RegToggle(id, enT, zhT, enD, zhD, root, path, name, onValue:, offValue:, kind:, ...) ----
  for (const body of findCalls(src, 'RegToggle')) {
    const args = splitArgs(body);
    const pos = [];
    const named = {};
    for (const a of args) {
      const c = classify(a);
      if (c.name) named[c.name] = c.value;
      else pos.push(c.value);
    }
    if (pos.length < 8 || !isString(pos[0])) continue; // skip the helper definitions themselves
    const id = unquote(pos[0]);
    const root = (pos[5].match(/RegRoot\.(\w+)/) || [])[1] || 'HKCU';
    const rawPath = pos[6];
    const p = resolvePath(rawPath, consts);
    const name = unquote(pos[7]);
    // onValue/offValue/kind/requiresAdmin may be passed either named or positionally (indices 8-11).
    const onTok = named.onValue ?? pos[8];
    const offTok = named.offValue ?? pos[9];
    const kindTok = named.kind ?? pos[10];
    const kind = (kindTok && (String(kindTok).match(/RegistryValueKind\.(\w+)/) || [])[1]) || 'DWord';
    const adminTok = named.requiresAdmin ?? pos[11];
    const admin = /true/i.test(String(adminTok ?? '')) || root === 'HKLM';
    const isNull = (t) => t === undefined || String(t).trim() === 'null';
    if (!id || p === null || onTok === undefined) {
      unresolved.push(`${file}: RegToggle ${id || '?'} (path="${rawPath}")`);
      continue;
    }
    toggles.push({
      id,
      op: 'toggle',
      root,
      path: p,
      name,
      on: litValue(onTok),
      off: isNull(offTok) ? null : litValue(offTok),
      kind,
      admin,
    });
  }

  // ---- RegRadio(id, enT, zhT, enD, zhD, path, name, options[], ...) — always HKCU / DWord ----
  for (const body of findCalls(src, 'RegRadio')) {
    const args = splitArgs(body);
    const pos = [];
    for (const a of args) {
      const c = classify(a);
      if (!c.name) pos.push(c.value);
    }
    if (pos.length < 8 || !isString(pos[0])) continue; // skip the helper definitions themselves
    const id = unquote(pos[0]);
    // Two RegRadio signatures exist: one omits the root (always HKCU) with path at index 5;
    // the other passes RegRoot at 5, shifting path/name/options by one.
    const rootM = pos[5].match(/RegRoot\.(\w+)/);
    const root = rootM ? rootM[1] : 'HKCU';
    const pathIdx = rootM ? 6 : 5;
    const p = resolvePath(pos[pathIdx], consts);
    const name = unquote(pos[pathIdx + 1]);
    const optsRaw = pos[pathIdx + 2];
    const options = [];
    const optRe = /\(\s*"((?:[^"]|\\")*)"\s*,\s*"((?:[^"]|\\")*)"\s*,\s*(-?\d+)\s*\)/g;
    let om;
    while ((om = optRe.exec(optsRaw)) !== null) {
      options.push({ en: om[1], zh: om[2], value: Number(om[3]) });
    }
    if (!id || p === null || options.length === 0) {
      unresolved.push(`${file}: RegRadio ${id || '?'}`);
      continue;
    }
    radios.push({ id, op: 'radio', root, path: p, name, kind: 'DWord', options, admin: root === 'HKLM' });
  }
}

// ---- manually-verified ops for high-value tweaks built via bespoke helpers ----------------
// These use non-uniform builders (Tweak.RadioGroup with string options, IncognitoPolicy,
// EdgeStartupBehavior) that the generic parser can't read, so their exact registry path /
// name / kind / options are transcribed here directly from the C# and re-checked by the
// ultracode verify workflow. Registry semantics identical to RegistryHelper.SetValue/ValueEquals.
const MANUAL_OPS = [
  {
    id: 'privacy.telemetry-level', op: 'radio', root: 'HKLM',
    path: 'SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', name: 'AllowTelemetry', kind: 'DWord',
    options: [
      { en: 'Security (Enterprise)', zh: '安全（企業版）', value: 0 },
      { en: 'Required', zh: '必要', value: 1 },
      { en: 'Optional', zh: '選用', value: 3 },
    ],
    admin: true,
  },
  {
    id: 'privacy.location-access', op: 'radio', root: 'HKCU',
    path: 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location',
    name: 'Value', kind: 'String',
    options: [
      { en: 'Allow', zh: '允許', value: 'Allow' },
      { en: 'Deny', zh: '拒絕', value: 'Deny' },
    ],
    admin: false,
  },
  {
    id: 'br.policies.chrome-incognito', op: 'radio', root: 'HKLM',
    path: 'SOFTWARE\\Policies\\Google\\Chrome', name: 'IncognitoModeAvailability', kind: 'DWord',
    options: [
      { en: 'Enabled', zh: '啟用', value: 0 },
      { en: 'Disabled', zh: '停用', value: 1 },
      { en: 'Forced', zh: '強制', value: 2 },
    ],
    admin: true,
  },
  {
    id: 'br.policies.edge-inprivate', op: 'radio', root: 'HKLM',
    path: 'SOFTWARE\\Policies\\Microsoft\\Edge', name: 'InPrivateModeAvailability', kind: 'DWord',
    options: [
      { en: 'Enabled', zh: '啟用', value: 0 },
      { en: 'Disabled', zh: '停用', value: 1 },
      { en: 'Forced', zh: '強制', value: 2 },
    ],
    admin: true,
  },
  {
    id: 'br.webtools.edge-startup-behavior', op: 'radio', root: 'HKCU',
    path: 'Software\\Policies\\Microsoft\\Edge', name: 'RestoreOnStartup', kind: 'DWord',
    options: [
      { en: 'Open new tab page', zh: '開新分頁頁面', value: 5 },
      { en: 'Restore last session', zh: '還原上次工作階段', value: 1 },
      { en: 'Open a set of pages', zh: '開一組指定頁面', value: 4 },
    ],
    admin: false,
  },
  {
    id: 'explorer.launch-to', op: 'radio', root: 'HKCU',
    path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'LaunchTo', kind: 'DWord',
    options: [
      { en: 'This PC', zh: '本機', value: 1 },
      { en: 'Home', zh: '首頁', value: 2 },
    ],
    admin: false,
  },
  {
    id: 'system.numlock-startup', op: 'radio', root: 'HKU',
    path: '.DEFAULT\\Control Panel\\Keyboard', name: 'InitialKeyboardIndicators', kind: 'String',
    options: [
      { en: 'On', zh: '開', value: '2' },
      { en: 'Off', zh: '熄', value: '0' },
    ],
    admin: true,
  },
];

const all = [...toggles, ...radios, ...MANUAL_OPS];
// de-dupe by id (last wins), keep stable order
const byId = new Map();
for (const o of all) byId.set(o.id, o);
const ops = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

const radioTotal = radios.length + MANUAL_OPS.filter((o) => o.op === 'radio').length;
const header = `// AUTO-GENERATED by tools/gen-tweak-ops.mjs from WinForge Catalog/*.cs (Tweak.RegToggle / RegRadio)
// plus a small set of hand-verified bespoke-helper ops (see MANUAL_OPS in the generator).
// Do not hand-edit. The concrete registry operation behind each tweak, so the desktop (Tauri)
// app can APPLY the tweak for real via the backend — mirroring RegistryHelper exactly.
// ${toggles.length} toggles + ${radioTotal} radios = ${ops.length} tweaks with a real op.
/* eslint-disable */

export type RegRoot = 'HKCU' | 'HKLM' | 'HKCR' | 'HKU';
export type RegKind = 'DWord' | 'QWord' | 'String' | 'ExpandString' | 'MultiString' | 'Binary';

export interface RegToggleOp {
  id: string;
  op: 'toggle';
  root: RegRoot;
  path: string;
  name: string;
  /** Value written / compared for the ON state. */
  on: number | string;
  /** Value for OFF; null ⇒ the value is deleted when turned off. */
  off: number | string | null;
  kind: RegKind;
  /** Needs elevation (HKLM or explicitly flagged). */
  admin: boolean;
}
export interface RegRadioOp {
  id: string;
  op: 'radio';
  root: RegRoot;
  path: string;
  name: string;
  kind: RegKind;
  options: { en: string; zh: string; value: number | string }[];
  admin: boolean;
}
export type TweakOp = RegToggleOp | RegRadioOp;
`;

const body =
  `\nexport const tweakOps: Record<string, TweakOp> = ${JSON.stringify(
    Object.fromEntries(ops.map((o) => [o.id, o])),
    null,
    2,
  )};\n` +
  `\nexport const tweakOpCount = ${ops.length};\n` +
  `\n/** The registry op for a tweak id, or undefined if it isn't one of the applyable uniform tweaks. */\n` +
  `export function opFor(id: string): TweakOp | undefined {\n  return tweakOps[id];\n}\n`;

fs.writeFileSync(OUT, header + body);
console.log(`Wrote ${OUT}: ${toggles.length} toggles + ${radioTotal} radios = ${ops.length} ops.`);
if (unresolved.length) {
  console.log(`\n${unresolved.length} unresolved (left as reference, not applied):`);
  for (const u of unresolved.slice(0, 20)) console.log('  ' + u);
}
