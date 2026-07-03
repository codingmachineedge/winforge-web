export const meta = {
  name: 'winforge-native-batch',
  description: 'Port 6 native (Rust-backend) WinForge modules to React/TS in parallel',
  phases: [{ title: 'Port', detail: 'one agent per native module, writes its own file' }],
}

const MODULES = [
  { tag: 'module.diskhealth', name: 'DiskHealth',    ns: 'diskhealth', title: 'Disk Health (SMART)' },
  { tag: 'module.battery',    name: 'BatteryThermal', ns: 'battery',    title: 'Battery & Thermal' },
  { tag: 'module.disk',       name: 'DiskAnalyzer',  ns: 'disk',       title: 'Disk Analyser' },
  { tag: 'module.clipboard',  name: 'Clipboard',     ns: 'clipboard',  title: 'Clipboard' },
  { tag: 'module.duplicates', name: 'Duplicates',    ns: 'duplicates', title: 'Duplicate Finder' },
  { tag: 'module.doctors',    name: 'SystemDoctors', ns: 'doctors',    title: 'System Doctors' },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tag', 'fileName', 'importName', 'namespace', 'enKeys', 'zhKeys', 'wrote', 'features'],
  properties: {
    tag: { type: 'string' },
    fileName: { type: 'string' },
    importName: { type: 'string' },
    namespace: { type: 'string' },
    enKeys: { type: 'object', additionalProperties: { type: 'string' } },
    zhKeys: { type: 'object', additionalProperties: { type: 'string' } },
    wrote: { type: 'boolean' },
    features: { type: 'string' },
    notes: { type: 'string' },
  },
}

const conventions = `
CONVENTIONS — this is a NATIVE module that talks to the Tauri Rust backend.
- Repo root: C:/Users/cntow/Documents/GitHub/winforge-web (you are here). WinForge C# is READ-ONLY at ../WinForge/Pages and ../WinForge/Services.
- Read the WinForge source AND read these two existing files IN FULL before writing, they are your template + API:
    src/modules/ServicesModule.tsx   (the canonical native module: useAsync + runPowershellJson + DataTable + row actions)
    src/modules/common.tsx           (useAsync, DataTable, Column<T>, AsyncState, ModuleToolbar, StatusDot)
- Rust bridge API (import from '../tauri/bridge'):
    runPowershell(script: string): Promise<{ success: boolean; stdout: string; stderr: string; code: number }>
    runPowershellJson<T>(script: string): Promise<T[]>   // pipe your data to ConvertTo-Json; returns parsed array (single object is wrapped)
    runCommand(program: string, args: string[]): Promise<{ success, stdout, stderr, code }>
    resolveTool(name): for external tools (winget→choco→bundled) — only if the module needs a non-builtin exe
    isTauri(): boolean
- common.tsx helpers (import from './common'): useAsync(fn, deps) => { data, loading, error, reload }; <AsyncState loading error>…</AsyncState>; DataTable<T> with Column<T>[]; ModuleToolbar; StatusDot({ok,label}).
- STAY READ-ONLY and SAFE. Prefer built-in PowerShell cmdlets (Get-PhysicalDisk, Get-CimInstance, Get-Volume, Get-Clipboard, Get-ChildItem, Get-FileHash). Data-gathering only. If WinForge exposes a destructive/action button, gate it behind an explicit confirm and never auto-run it.
- Build the PowerShell script to emit clean data: 'Select-Object …' then rely on runPowershellJson<T>, OR for free text use runPowershell(...).stdout. Convert enum/date fields to strings inside PowerShell (e.g. @{N='X';E={$_.X.ToString()}}) so JSON is clean.
- The module is a NAMED export: export function <ImportName>() {...}. Strict TS (noUncheckedIndexedAccess, noUnusedLocals) — guard indexes, no unused vars.
- i18n: t('<namespace>.<key>'); for a numeric count use a NON-'count' variable name (react-i18next reserves 'count' for plurals) unless you also supply _one/_other keys.
- Reuse existing CSS classes: mod, mod-toolbar, mini / mini primary, mod-search, count-note, dt (tables), hosts-edit; StatusDot/DataTable already styled.
- These run on the desktop (Tauri). In a plain browser the bridge no-ops; that is fine — still render the full UI (toolbar, table headers, a Refresh button). Do not crash if data is empty.

CRITICAL — DO NOT TOUCH SHARED FILES: create ONLY your single module file src/modules/<FileName>. Do NOT edit registry.tsx, registryB.tsx, en.ts, zh-Hant.ts, index.ts, catalog.ts — the orchestrator wires those from your returned keys.
`

phase('Port')
const results = await parallel(MODULES.map((m) => () =>
  agent(
    `Port the WinForge "${m.title}" module (${m.tag}) to a REAL native React + TypeScript module that queries the live system through the Tauri Rust backend.

Ground truth: read ../WinForge/Pages/${m.name}Module.xaml and ../WinForge/Pages/${m.name}Module.xaml.cs (READ ONLY), plus ../WinForge/Services/${m.name}Service.cs if it exists — port the real data/features it shows, and reuse its bilingual P("en","粵語") strings.

Write src/modules/${m.name}Module.tsx as: export function ${m.name}Module() {...}, using t('${m.ns}.<key>').

${conventions}

Return: tag='${m.tag}', fileName='${m.name}Module.tsx', importName='${m.name}Module', namespace='${m.ns}', complete enKeys/zhKeys, wrote=true, and a one-line features summary. Make it a genuinely useful live-system view, not a stub.`,
    { label: `native:${m.ns}`, phase: 'Port', schema: SCHEMA }
  )
))

return results.filter(Boolean)
