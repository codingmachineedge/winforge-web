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
