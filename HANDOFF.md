# winforge-web — Session Handoff

_Last updated: 2026-07-03. Snapshot committed for a clean shutdown; a future session can resume from here._

## TL;DR

winforge-web is the **React + TypeScript (Vite) + Tauri v2** rewrite of the WinForge WinUI 3
desktop suite. **This app IS the full product** — it must do everything itself (see the
Architecture Rule below); it never tells the user to open the old desktop app.

- **Build is GREEN** at the handoff commit: `tsc --noEmit` = 0 errors, `vite build` = OK.
- **Coverage: 166 / 311 modules working (53%)** — see numbers below.
- Work is driven by a **parallel "port pipeline"** (subagent workflow → deterministic
  integrator). The pipeline scripts are now committed under `tools/port-pipeline/`.

## Feature coverage (as of this handoff)

| Bucket | Working | Stub | Total |
|---|---|---|---|
| **All modules** | **166** | **145** | **311** |
| Web-capable (`native:false`) | 151 | 23 | 174 |
| Native (`native:true`, needs Rust backend) | 15 | 122 | 137 |

- **53% working.** The web-capable surface is essentially DONE (the 23 remaining "web
  stubs" are almost all **reactor industrial simulators** owned by a separate agent — skip them).
- The real remaining work is the **122 native modules** (disk/hardware/system tools) that
  run through the Tauri Rust backend.
- Regenerate exact counts anytime with the snippet in `docs/feature-coverage.md` ("Recount").

## What's complete

- **App shell & navigation** (`src/App.tsx`, `src/components/`):
  - `Sidebar.tsx` — sections with live counts, a search launcher, tri-state language
    toggle **English / 粵語 / Bilingual**.
  - `CommandPalette.tsx` — Spotlight/`Ctrl+K` (also `/`) palette. Rich grouped results,
    **toggleable filter controls** (Type: All/Web/Native · State: Any/Working/Stub), and
    **feature-level search** (find an app by what it does, e.g. "nibble" → Base Converter)
    powered by `src/data/featureIndex.ts` (indexes every module's i18n strings).
  - `ModuleCatalog.tsx` — section grid with web/native/all filter chips.
  - `ModuleDetail.tsx` — renders the live module in Tauri; in a **browser preview** shows a
    note that the installed app runs it (never punts to the old WinForge).
  - `ModuleTabs.tsx` — reusable sub-tab strip; used by 6 multi-tab modules.
- **166 real interactive modules** wired in `src/modules/registry.tsx` (+ `registryA.tsx`,
  `registryB.tsx` for parallel-agent batches). Includes ~150 pure-client tools (JSON/text/
  color/encoding/crypto/network-lookup/etc.) and 15 native probes (Services, Processes,
  Git, Nmap, Hosts, Devices, Event Viewer, …).
- **i18n**: `src/i18n/en.ts` + `zh-Hant.ts` (+ `batchB.ts`). `zhHant: Resources = typeof en`
  enforces EN/粵語 **structural key parity** at compile time. Three modes merged at runtime.
- **Architecture rule enforced** (commit `2614d4a`): audited the whole codebase and reframed
  all "use the WinForge desktop app" messaging — see below.
- **Port pipeline committed** at `tools/port-pipeline/` (was previously only in session temp).

## In progress / immediate next step

**A native-module batch of 6 was interrupted** (transient server-side rate limiting, then
shutdown). It writes 6 modules that wire `runPowershellJson`/`runPowershell` through the Rust
bridge, mirroring `ServicesModule`:

`diskhealth` (Disk Health/SMART), `battery` (Battery & Thermal), `disk` (Disk Analyser),
`clipboard` (Clipboard), `duplicates` (Duplicate Finder), `doctors` (System Doctors).

Partial `.tsx` files from the interrupted run were **removed** (their generated i18n keys were
lost when the agents were killed, so they were incomplete). The batch is **idempotent** — just
re-run it (it regenerates files + keys). This is the #1 thing to do on resume.

## What remains (roughly in priority order)

1. **Re-run the native batch** (`tools/port-pipeline/winforge-native-batch.js`) → integrate → +6.
2. **Continue native modules** — 122 native stubs. Good next candidates (built-in PowerShell,
   read-only, safe): archives, bulkops, hexeditor, diskbench, mediaplayer(info), etc. Author
   more entries in the native batch script (edit its `MODULES` array) and loop.
3. **Bigger native modules** with sub-tabs (mirror `ModuleTabs`): Docker, Package Manager
   (8 sub-tabs), SSH, ADB — these are high-feature-count.
4. **C background helper** (see rule 2) for anything the Rust backend can't do directly.
   **Status: not yet needed** — no module has required one so far. When one does, add a tiny
   bundled sidecar and document it here.
5. Reactor simulator & industrial sims are owned by a **separate agent** (branch
   `feature/reactor-sim`) — **do not touch**.

## Architecture Rule (MUST follow — applies to every module & subagent)

1. **Never punt to the old desktop app.** No "open the full app", "use the desktop version",
   "not available here", "planned" placeholders. winforge-web IS the product. The browser is
   only a *preview*; the installed Tauri app does everything via its built-in backend. All such
   strings were reframed this session (17 strings + 4 comments across `en.ts`, `zh-Hant.ts`,
   `batchB.ts`, and Ping/PortScan/WoL/PathDoctor modules).
2. **When Rust can't reach something**, ship a **tiny background helper** (small native/C
   sidecar or lightweight service) that the app talks to — **bundled and auto-installed by the
   one-click installer, invisible to the user.** Never ask the user to run/install anything
   separately. Prefer doing it in the Rust backend; only drop to a helper when necessary.
   _Current status: no helper needed yet._

## How the port pipeline works (`tools/port-pipeline/`)

- `winforge-web-batch.js` / `winforge-native-batch.js` — **Workflow** scripts. Each spawns
  ~6 subagents in parallel; each subagent ports ONE WinForge module and returns structured
  `{tag, fileName, importName, namespace, enKeys, zhKeys}`. Subagents write ONLY their own
  `src/modules/<X>Module.tsx` — they must **not** touch shared files.
- `integrate.mjs` — the **single-writer integrator**. Reads the workflow output (or falls back
  to agent journals), validates EN/粵語 key parity + that every `t('ns.x')` resolves
  (plural-aware, skips comments), then patches the shared files: `en.ts`, `zh-Hant.ts`,
  `registry.tsx`. Idempotent (skips already-registered tags).
- Before running: update `OUT` and `RUNDIR` at the top of `integrate.mjs` to the new run's
  task-output path and workflow journal dir.

## Resume — step by step

1. `cd C:/Users/cntow/Documents/GitHub/winforge-web` and `git pull` (we push to **origin/main**;
   the local branch is `feature/git-workbench`, and we always push via `git push origin HEAD:main`).
2. Read this file + `docs/feature-coverage.md`. Sanity-check the build:
   `npx tsc --noEmit && npx vite build`.
3. **Re-run the interrupted native batch**: launch `tools/port-pipeline/winforge-native-batch.js`
   as a Workflow. When it completes, point `integrate.mjs`'s `OUT`/`RUNDIR` at the new run and
   `node tools/port-pipeline/integrate.mjs`.
4. Verify in an **isolated worktree** (immune to other agents' in-flight files): create a detached
   worktree at the new commit, junction `node_modules`, run `tsc --noEmit` + `vite build`.
5. Commit only the files you touched and `git push origin HEAD:main` (the **OneDrive post-commit
   hook** auto-backs up to `%OneDrive%/Backups/winforge-web/<date>/` + regenerates
   `commit-history.pdf`).
6. Loop: pick the next native modules, edit the batch script's `MODULES`, repeat.

## Known issues / gotchas

- **Shared working tree.** Other agents (batch-A, batch-B, reactor) commit to the same tree.
  **Never `git add -A` mid-session** — stage only the specific files you touched. Push with
  `git push origin HEAD:main`; if rejected, `git fetch` + `git rebase origin/main` + push.
- **CRLF line endings.** The `Edit` tool often fails to match multi-line strings (LF vs CRLF).
  Use `node`/PowerShell `.replace()` on the raw file for reliable edits (as the pipeline does).
- **Transient server-side rate limits** hit subagent spawns intermittently this session. On a
  recoverable API error, **back off and retry** rather than stopping.
- **`preview_screenshot` MCP times out** intermittently; verify UI via `preview_eval` DOM
  checks and the lowlevel-computer-use MCP screenshots instead.
- **Native modules can't be runtime-tested in a browser** — verify they compile (`tsc`/`vite`)
  and follow the `ServicesModule` bridge pattern; real behavior is validated in the Tauri build.
- `tauri build` was **not** re-run this session (no Rust changes). Re-verify it after any Rust edit.

---

# HANDOFF — feature/modules-batch-b (N–Z modules)

**Date:** 2026-07-03 · **Branch:** `feature/modules-batch-b` · **State:** SAFE, build green, pushed.
**Do NOT merge yet** — 5 native stubs remain (see below).

## Current state
- `tsc --noEmit` = clean, `npm run build` (vite) = green on the last commit.
- This branch is developed in an **isolated git worktree** at
  `C:/Users/cntow/Documents/GitHub/winforge-web-batch-b` (node_modules is a junction to the
  main checkout's). The shared main worktree is used by other agents — do not fight it.
- Isolation pattern (avoids collisions with the A–M / reactor agents): every module of this
  batch is registered in **`src/modules/registryB.tsx`** and its i18n lives in
  **`src/i18n/batchB.ts`** (`enB`/`yueB`, merged once in `src/i18n/index.ts`). Never append
  to the shared `registry.tsx` / `en.ts` / `zh-Hant.ts`.

## Done (N–Z), all merged to main earlier OR on this branch
**Web-capable (41):** slugify, romannum, textsort, unixperm, textstats, phonetic, subnetcalc,
numberformat, textescape, stringinspector, stringcompare, semverrange, scinotation, unitprice,
textwrap, numseq, urltools, textcolumns, tallycounter, numwordsx (+numwords alias), namegen,
notes, passwordstrength, pathdoctor, queryedit, randomizer, regexcheat, subnetv6, symbols,
textredact, textreplace, texttemplate, tomljson, totp, tzplanner, unicodeinspect, uuidv5, wol,
wordfreq, worldclock, yamljson.

**Git workbench:** `module.git` rebuilt as a GitHub-Desktop-style tabbed workbench
(Changes/History/Branches over `git -C <repo>`).

**Native (48)** — desktop backend via `DependencyGate`+`runCommand` or `runPowershell`:
ping, portscan, recyclebin, wol(send); vscode, virtualbox, ytdlp, vivetool, zoomit, rustdesk,
wireshark, terminal; pixeleditor, pgadmin, sqlitebrowser, rainmeter, windhawk, nilesoftshell,
peek, quicktype; settingshub, pdftoolkit, torrent; ollama, ssh, qbittorrent, packer, testdisk;
newplus, onedrive, proxmox, quickaccent, rename, richpreview; screenruler, shellmenu,
shortcutguide, taskbar-tweaker, textocr, timelens; timeunit, vault-volumes, viaproxy, voice,
webcloner, weblogin; native(NativeUtilities), powertoys(PowerToysExtras), recorder(ScreenRecorder),
resume(ResumeWriter), uninstall(AppUninstaller), vpn(VpnMesh).

## REMAINING — 5 native stubs (not started)
| tag | WinForge source (Pages/) | notes |
|-----|--------------------------|-------|
| `module.regedit` | `RegistryEditor.xaml.cs` (NB: no `Module` suffix) | reg query/add/delete via runPowershell |
| `module.windows` | `WindowManagerModule.xaml.cs` | tile/cascade/always-on-top; EnumWindows + SetWindowPos |
| `module.workspaces` | `WorkspacesModule.xaml.cs` | PowerToys Workspaces app-layout launcher |
| `module.wslvm` | `WslVmModule.xaml.cs` | `wsl --list/--install/-d`, launch distros/VMs |
| `module.ossapps` | none found (no standalone page) | "Native OSS Clones" aggregator — inspect MainWindow/registry for its real source before porting |

Reactor-themed factory sims (smelter, steelmill, vertfarm, pumpedhydro, aicluster, hpc,
computemine, datacenter, collider, reactorbank, desal, evcharge, districtheat, dac, cementkiln,
worldmonitor, …) are intentionally **excluded** — owned by the reactor-sim agent.

## How to resume
1. `cd C:/Users/cntow/Documents/GitHub/winforge-web-batch-b` (or recreate the worktree:
   `git worktree add <dir> feature/modules-batch-b` then junction node_modules).
2. Port the 5 remaining via the ultracode workflow at
   `…/scratchpad/port-native-b.mjs` (Workflow tool). **Use waves of ≤6** — larger bursts hit a
   transient server rate limit. On any rate-limit/timeout, just re-fire the failed tags (results
   are per-module).
3. Integrate each wave's output with the reusable script: `node _integrate.mjs <task-output.json>`
   (it normalizes bare→namespaced keys, is collision-tolerant, injects into registryB+batchB,
   and prints the files to `git add`). Then `npx tsc --noEmit`, `npm run build`, commit, push.
4. When all 5 are done + green: merge `feature/modules-batch-b` → `main`, push, delete branch
   (local+remote), remove this worktree.

## Known issues / follow-ups
- **WebLogin i18n collision (cosmetic):** the agent emitted both `weblogin.provider` (string) and
  `weblogin.provider.<id>` sub-keys; the integrator kept the string and skipped the sub-keys, so
  provider names in `WebLoginModule.tsx` render as raw keys. Fix: rename the per-provider keys
  (e.g. `weblogin.prov_github`) in the module + batchB, or drop the `provider` label key.
- **Cross-cutting rule (per latest instruction):** modules must never punt to "the old desktop
  app." Ours implement real functionality via the Tauri backend and never reference the legacy
  app; the `isTauri()` fallback text ("requires the WinForge desktop app") only shows in the dev
  browser preview. For truly privileged ops beyond the Rust backend, the intended path is a small
  background native (C) helper — not yet built; none of the shipped modules depend on it.
- `_integrate.mjs` and `_*.mjs` in the worktree root are scratch helpers (committed for resume).

## Verification note
Native (`native:true`) modules render as the native panel in a plain browser, so they can't be
screenshot-verified in the web preview — they run in the packaged Tauri app. Backends for the
built-in ones (ping/portscan/recyclebin/wol/etc.) were validated by running the exact PowerShell
on this Windows host. Web-capable modules were DOM-verified in the Vite preview.
