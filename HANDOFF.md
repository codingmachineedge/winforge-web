# winforge-web — Session Handoff

_Last updated: 2026-07-03 (recovery session). The four 2026-07-02/03 parallel sessions
(bootstrap, batch-A, batch-B, reactor-fidelity) all hit the usage limit mid-shutdown; this
snapshot is the state after their work was recovered, merged and pushed._

## TL;DR

winforge-web is the **React + TypeScript (Vite) + Tauri v2** rewrite of the WinForge WinUI 3
desktop suite. **This app IS the full product** — it must do everything itself (see the
Architecture Rules below); it never tells the user to open the old desktop app.

- **Build is GREEN** at this commit: `tsc --noEmit` = 0 errors, `vite build` = OK,
  `vitest` 24/24 (reactor physics + fuel factory + reactimeter).
- **Coverage: 226 / 311 modules working (73%)** — web-capable 165/174, native 61/137.
  Regenerate anytime with the "Recount" snippet in `docs/feature-coverage.md`.
- All feature branches are **merged to main and deleted**. Work is driven by the
  **port pipeline** committed under `tools/port-pipeline/`.

## What the recovery merged (2026-07-03)

- **feature/modules-batch-b** — 48 native N–Z modules in 7 waves (VS Code, VirtualBox,
  Wireshark, Ollama, SSH, qBittorrent, OneDrive, OCR, Screen Recorder, App Uninstaller, …)
  plus the earlier 41 web N–Z modules and the Git workbench.
- **feature/modules-batch-a** — the strict **no-punt language pass** (shared `detail.*`
  fallback strings now use the "built-in background service" framing) and
  **HttpHeadersModule live requests routed through the backend** (no CORS limits).
- **feature/reactor-fidelity** — reactor fidelity wave 1, recovered from an uncommitted
  worktree: `fuelFactory.ts` (full fuel cycle, 9 tests), `reactimeter.ts` (inverse
  point-kinetics, 4 tests), and `physics.ts` extended with SR/IR/PR nuclear instrumentation,
  1/M, startup-rate DPM, P-6..P-10 permissives, Tech-Spec MODE 1–6, time-to-criticality,
  subcooling margin, EN/ZH alarms, fuel-availability gate.

## Shell-features batch (2026-07-03, later session)

Two waves of shortlist features from `FEATURES_SHORTLIST.md` landed on main
(commits 89cfd4c…fd0eefc): persisted prefs/favorites/recents/toasts/theme stores,
favorites rail + recents strip + pin star, toast queue, error boundaries,
Light/Dark/System theme toggle (`data-theme` on :root), reduced-motion, skip link +
landmarks, route-level code splitting, typo-tolerant fuzzy search + `<mark>`
highlighting (in-house, `src/data/fuzzy.ts`), and a searchable settings page
(typed registry `src/data/settingsRegistry.ts`) with working density/uiScale/
view-mode effects. Tests 24 → 138. Build: eager chunk 2,332 kB → ~692 kB.

⚠️ **New gotcha:** `src/modules/registryKeys.ts` is GENERATED (`npm run
gen:registry-keys`). After adding/removing modules in any registry file,
regenerate it — a vitest guard (`registryKeys.test.ts`) fails otherwise. Never
import `moduleRegistry` from eager code (status checks etc.); use
`registeredModuleTags` — importing the registry drags all module components
into the initial bundle. Note batch item 2 below (the 5 batch-B stubs) was
completed by a concurrent session in d08dd85.

## What remains (priority order)

1. **Re-run the interrupted native batch of 6** — `diskhealth`, `battery`, `disk`,
   `clipboard`, `duplicates`, `doctors`. It is idempotent:
   launch `tools/port-pipeline/winforge-native-batch.js` as a Workflow, then point
   `integrate.mjs`'s `OUT`/`RUNDIR` at the new run and `node tools/port-pipeline/integrate.mjs`.
2. **5 batch-B native N–Z stubs** — `regedit` (source `Pages/RegistryEditor.xaml.cs` — no
   `Module` suffix), `windows` (WindowManager), `workspaces`, `wslvm`, `ossapps` (no standalone
   page — find its real source in MainWindow/registry first). Use the batch-B wave pipeline
   (waves ≤ 6 dodge the transient rate limiter).
3. **Remaining ~65 other native stubs** — archives, bulkops, hexeditor, media/audio suite,
   window-management suite (fancyzones, komorebi, glazewm, altsnap), ADB/fastboot, Docker,
   AWS, mail/comms, Minecraft suite, … (full list: run the Recount snippet).
4. **Reactor fidelity continuation** (branch merged & deleted; start a fresh branch):
   - Wire the CVCS blender borate/dilute rates (`BorateRatePpmPerS` / `DiluteRatePpmPerS`
     are exported but unused) into boron/makeup dynamics.
   - RCP pump-heat heatup path (reach hot standby on pump heat alone, enabling the
     realistic heatup-before-criticality sequence).
   - **Expose the new systems in the reactor UI** (NIS ranges, permissive lamps, MODE
     annunciator, reactimeter panel, alarms, fuel factory screens), trilingual.
   - Startup-sequence integration tests (cold shutdown → criticality is NOT instant and
     follows the source's procedure) + an in-repo reactor feature-coverage checklist
     vs `WinForge/Services/ReactorSimService.cs` (6.5k lines — MODEs, CSF trees, App-G/LTOP/
     PTS, PORV/MSSV, RCP seal-LOCA, containment, AVR still unported).
   - The 9 web-capable reactor-family sim stubs: reactor, reactorsettings, hpc, datacenter,
     collider, reactorbank, desal, pumpedhydro, vertfarm.
5. **Custom installer** (`installer/` scaffold exists): one-click flow with auto-UAC,
   per-dependency progress, "Auto-build dependencies from source" checked by default,
   trilingual, animations. Never finished; portable build also unverified on a clean machine.
6. **C background helper** — pattern documented, still **not needed yet**; add a tiny bundled
   sidecar only when a module exceeds the Rust backend, auto-installed and invisible.

### Known issues

- **WebLogin i18n collision (cosmetic):** `weblogin.provider` (string) vs
  `weblogin.provider.<id>` sub-keys — provider names render as raw keys. Fix by renaming the
  per-provider keys (e.g. `weblogin.prov_github`) in the module + `batchB.ts`.
- `installer/` is scaffold-only; `tauri build` not re-run since the last Rust change window.
- Catalog counts use 311 (early docs said 312/314).

## Architecture Rules (MUST follow — every module & subagent)

1. **Never punt to the old desktop app.** No "open the full app", "use the desktop version",
   "not available here", "planned" placeholders. winforge-web IS the product. The browser is
   only a *preview*; the installed app does everything via its built-in backend. The shared
   `detail.*` strings now use the approved framing — reuse them; don't invent new punt text.
2. **When Rust can't reach something**, ship a **tiny background helper** (small native/C
   sidecar or lightweight service) — **bundled and auto-installed by the one-click installer,
   invisible to the user.** Never ask the user to run/install anything separately. Prefer the
   Rust backend; only drop to a helper when necessary. _Status: none needed yet._
3. **Trilingual everything**: English / Cantonese (粵語, Traditional Chinese — WinForge's
   wording, not generic Mandarin) / Bilingual. `zhHant: Resources = typeof en` enforces key
   parity at compile time.
4. **Auto-retry with backoff** on any transient API/tool error, rate limit, or timeout —
   never end a session on a recoverable error. Subagent waves of **≤ 6** dodge the limiter.

## How the port pipeline works (`tools/port-pipeline/`)

- `winforge-web-batch.js` / `winforge-native-batch.js` — **Workflow** scripts. Each spawns
  ~6 subagents in parallel; each subagent ports ONE WinForge module and returns structured
  `{tag, fileName, importName, namespace, enKeys, zhKeys}`. Subagents write ONLY their own
  `src/modules/<X>Module.tsx` — they must **not** touch shared files.
- `integrate.mjs` — the **single-writer integrator**. Validates EN/粵語 key parity + that every
  `t('ns.x')` resolves (plural-aware), then patches the shared files. Idempotent.
  Before running: update `OUT` and `RUNDIR` at the top to the new run's paths.
- Batch-B N–Z work used the same pattern with its own registries: modules register in
  `src/modules/registryB.tsx`, i18n in `src/i18n/batchB.ts` (`enB`/`yueB`); batch-A used
  `registryA.tsx`. **Never append to shared `registry.tsx`/`en.ts`/`zh-Hant.ts` from a batch.**

## Conventions & gotchas

- **Repo layout:** primary checkout `C:/Users/cntow/Documents/GitHub/winforge-web` sits on
  branch `feature/git-workbench` by convention; **push with `git push origin HEAD:main`**.
  Do feature work in **isolated git worktrees** (junction `node_modules` from the primary),
  short-lived branches, merge to main, delete branch + worktree when done.
- **WinForge C# source (READ ONLY):** `C:/Users/cntow/Documents/GitHub/WinForge`.
- **OneDrive post-commit hook** auto-backs up every commit to
  `%OneDrive%/Backups/winforge-web/<date>/` and regenerates `commit-history.pdf`.
- **CRLF line endings**: the Edit tool often fails multi-line matches — use node/PowerShell
  `.replace()` on the raw file (as the pipeline does).
- **Never `git add -A` mid-session** — stage only the files you touched; other agents may
  share the tree. If push is rejected: `git fetch` + rebase + retry.
- Native modules can't be runtime-tested in a browser — verify tsc/vite + the
  `ServicesModule` bridge pattern; real behavior is validated in the Tauri build.
  Backends can be validated by running the exact PowerShell on the host — note the Tauri
  backend shells out to **Windows PowerShell 5.1**, not pwsh 7.
- `preview_screenshot` MCP times out intermittently; verify UI via `preview_eval` DOM checks
  or the lowlevel-computer-use MCP screenshots.
- A Ralph-loop Stop hook lives in `C:/Users/cntow/Documents/GitHub/.claude/settings.json`,
  armed by a gitignored `.ralph-loop-active` marker in the repo — check/remove the marker if
  you don't want the loop.
