export const meta = {
  name: 'winforge-port-batch',
  description: 'Port 6 A–M pure-client WinForge modules to React/TS in parallel',
  phases: [{ title: 'Port', detail: 'one agent per module, writes its own file' }],
}

const MODULES = [
  { tag: 'module.htmlpreview', name: 'HtmlPreview', ns: 'htmlpreview', title: 'HTML Preview (sandboxed iframe)' },
  { tag: 'module.mactools',    name: 'MacTools',    ns: 'mactools',    title: 'MAC Address Tools' },
  { tag: 'module.filesplit',   name: 'FileSplit',   ns: 'filesplit',   title: 'File Split & Join (File API)' },
  { tag: 'module.clipinspect', name: 'ClipInspect', ns: 'clipinspect', title: 'Clipboard Inspector' },
  { tag: 'module.dnslookup',   name: 'DnsLookup',   ns: 'dnslookup',   title: 'DNS Lookup (DoH fetch)' },
  { tag: 'module.ipinfo',      name: 'IpInfo',      ns: 'ipinfo',      title: 'IP & Network Info' },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tag', 'fileName', 'importName', 'namespace', 'enKeys', 'zhKeys', 'wrote', 'features'],
  properties: {
    tag: { type: 'string' },
    fileName: { type: 'string', description: 'basename written under src/modules, e.g. CaseConvertModule.tsx' },
    importName: { type: 'string', description: 'exported component name, e.g. CaseConvertModule' },
    namespace: { type: 'string', description: 'i18n namespace key, e.g. caseconvert' },
    enKeys: { type: 'object', additionalProperties: { type: 'string' }, description: 'flat map of key->English string for this namespace' },
    zhKeys: { type: 'object', additionalProperties: { type: 'string' }, description: 'flat map of SAME keys->Cantonese (粵語, Traditional Chinese) string' },
    wrote: { type: 'boolean', description: 'true if the .tsx file was successfully written' },
    features: { type: 'string', description: 'one-line summary of ported features' },
    notes: { type: 'string' },
  },
}

const conventions = `
CONVENTIONS (match the existing codebase exactly):
- Repo root: C:/Users/cntow/Documents/GitHub/winforge-web (you are here). WinForge C# source is READ-ONLY at ../WinForge/Pages and ../WinForge/Services.
- Read an existing small module first for style: src/modules/HtmlEntitiesModule.tsx and src/modules/JsonFlattenModule.tsx and src/modules/CssFormatModule.tsx.
- The module is a NAMED export: export function <ImportName>() { ... }, in src/modules/<FileName>.
- Strict TS: tsconfig has noUncheckedIndexedAccess + noUnusedLocals + strict. So: guard array indexes (use ! only when provably safe), no unused imports/vars, type everything. Prefer 'const x = arr[i]!' after a bounds check, or optional chaining.
- i18n: import { useTranslation } from 'react-i18next'; const { t } = useTranslation(); label via t('<namespace>.<key>'). IMPORTANT: react-i18next RESERVES the interpolation key name 'count' for numeric pluralization — if you pass t('ns.key', { count: someString }) TypeScript will error. NEVER use 'count' as an interpolation variable unless the value is a real number passed as-is. For a formatted/string count (e.g. n.toLocaleString()) use a DIFFERENT variable name like 'chars', 'n', 'num', 'total' in both the t() call AND the {{...}} placeholder in enKeys/zhKeys. For sub-tabs via ModuleTabs, tabs take {id, en, zh, render} inline (no t needed for tab labels).
- Use ModuleTabs from './ModuleTabs' ONLY if the WinForge module uses a Pivot/TabView with multiple sub-views.
- CSS classes to reuse (already defined in global.css): outer wrapper 'mod'; toolbars 'mod-toolbar'; buttons 'mini' and 'mini primary'; inputs 'mod-search'; textareas 'hosts-edit'; two-pane grid 'io-grid'; small muted text 'count-note'; key/value rows 'kv-list' + 'kv-row'; tables className 'dt'. Do NOT invent new CSS class names that need styling; reuse these or use inline style.
- Client-side only, no Tauri backend calls, no external npm deps. Use Web APIs (JSON, crypto.subtle, DOMParser, the File API / Blob for file split-join, navigator.clipboard, etc.). NETWORK IS ALLOWED when it IS the module's purpose: use fetch() to public endpoints — e.g. DNS lookups via DNS-over-HTTPS (https://dns.google/resolve?name=…&type=… or https://cloudflare-dns.com/dns-query with Accept: application/dns-json), IP info via a public JSON API. Handle fetch errors and CORS gracefully with a clear bilingual error message. For HTML Preview, render user HTML inside a SANDBOXED iframe (sandbox attribute, srcDoc) — never inject into the app DOM.
- Cantonese must be 粵語 in Traditional Chinese matching WinForge's tone. Extract WinForge's own P("English","粵語") pairs from the .xaml.cs and reuse that exact wording where present.

CRITICAL — DO NOT TOUCH SHARED FILES: You must ONLY create your single module file src/modules/<FileName>. You must NOT edit src/modules/registry.tsx, src/modules/registryB.tsx, src/i18n/en.ts, src/i18n/zh-Hant.ts, src/i18n/index.ts, or src/data/catalog.ts — the orchestrator wires those up from your returned enKeys/zhKeys to avoid concurrent-edit collisions. Return the exact keys your module references via t().
`

phase('Port')
const results = await parallel(MODULES.map((m) => () =>
  agent(
    `Port the WinForge "${m.title}" module (${m.tag}) to a REAL, fully-interactive React + TypeScript module.

Ground truth: read ../WinForge/Pages/${m.name}Module.xaml and ../WinForge/Pages/${m.name}Module.xaml.cs (READ ONLY), plus ../WinForge/Services/${m.name}Service.cs if it exists — port the EXACT feature set and behavior, and reuse WinForge's own bilingual P("en","粵語") strings.

Write the module to src/modules/${m.name}Module.tsx as: export function ${m.name}Module() {...}. It must use t('${m.ns}.<key>') for all user-facing strings.

${conventions}

Return the structured result: tag='${m.tag}', fileName='${m.name}Module.tsx', importName='${m.name}Module', namespace='${m.ns}', enKeys/zhKeys (the complete set of keys your module references, English and 粵語), wrote=true if you wrote the file, and a one-line features summary. Make the port thorough and correct — every button, toggle, and option WinForge has.`,
    { label: `port:${m.ns}`, phase: 'Port', schema: SCHEMA }
  )
))

return results.filter(Boolean)