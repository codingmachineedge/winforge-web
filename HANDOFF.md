# winforge-web — Session Handoff

_Last updated: 2026-07-03 (recovery session). The four 2026-07-02/03 parallel sessions
(bootstrap, batch-A, batch-B, reactor-fidelity) all hit the usage limit mid-shutdown; this
snapshot is the state after their work was recovered, merged and pushed._

## TL;DR

winforge-web is the **React + TypeScript (Vite) + Tauri v2** rewrite of the WinForge WinUI 3
desktop suite. **This app IS the full product** — it must do everything itself (see the
Architecture Rules below); it never tells the user to open the old desktop app.

- 🎉 **FULL PARITY (2026-07-03): 314 / 314 modules working · 0 partial · 0 stub.** Every
  catalog module now has a real working implementation. Regenerate the census with
  `node tools/gen-parity.mjs` (writes `docs/PARITY.md`).
- **Build is GREEN**: `tsc --noEmit` = 0 errors, `vite build` = OK, `vitest` **203 passing**
  (16 files). Latest parity commit: `b699346`.
- Reached via a Ralph-loop campaign (armed by `.ralph-loop-active`, now **disarmed** — it
  auto-stops at 0 stubs): ~19 iterations, each = one hand-verified solo port + one 6-module
  **Opus 4.8** Workflow batch, integrated by the single-writer `tools/port-pipeline/`.
- **Shell features also shipped** earlier this session: prefs/favorites/recents/toasts/theme
  stores, three-state theme toggle, fuzzy search + highlighting, searchable settings page,
  PWA, catalog virtualization + keyboard nav, `run_op` allowlist + `winforge://` deep links,
  reactor analog gauges/annunciator/NIS/permissives/MODE.

### Pipeline hardening learned this campaign (keep these)
- `tools/gen-parity.mjs` + `gen-registry-keys.mjs` scan **registry.tsx + registryA + registryB**
  and accept the unprefixed `dashboard` tag.
- `integrate.mjs` uses **CRLF-tolerant `\r?\n` anchors that throw if not found** (a bare `\n`
  silently no-opped once files went CRLF, shipping unresolved i18n keys), and its validator
  **skips trailing-dot dynamic key prefixes** (`t('ns.strength.' + level)`).
- Recurring gotcha: Opus agents sometimes emit a flat key that collides with a nested one
  (`media.folder` vs `media.folder.*`, `emulator.channel` vs `channel.0..3`). Scan for
  prefix/leaf collisions before integrating and rename the flat key (e.g. `folderCol`).
- Client-side modules must be flagged **`native: false`** in `catalog.ts` or the browser shows
  a stub instead of the live UI.
- Self-contained physics sims (desal/pumpedhydro/vertfarm/hpc/datacenter/collider) use an
  operator power slider in place of the desktop reactor-status feed, and a compressed sim
  clock so state changes are watchable.

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

**Wave 3 (same session):** reactor instrumentation UI (AnalogGauge dials, latching
annunciator, NIS/permissive/MODE panels, Intl.NumberFormat readouts — HANDOFF item 4's
UI exposure is largely done, fuel-factory screens still pending), catalog
`content-visibility` virtualization + roving-tabindex keyboard nav, PWA
(vite-plugin-pwa, guarded SW registration, no-ops in Tauri), Rust `run_op` vetted-op
allowlist + denylist guard on legacy `run_command`, and `winforge://` deep links
(tauri-plugin-deep-link → `deep-link` event → App routes to the module). Tests 203.
Note: npm install bumped typescript to 5.9.3 (^ range) — Intl.Segmenter is now typed.
Deep links + run_op verified via cargo check/test; end-to-end deep-link needs an
installed Tauri build.

⚠️ **New gotcha:** `src/modules/registryKeys.ts` is GENERATED (`npm run
gen:registry-keys`). After adding/removing modules in any registry file,
regenerate it — a vitest guard (`registryKeys.test.ts`) fails otherwise. Never
import `moduleRegistry` from eager code (status checks etc.); use
`registeredModuleTags` — importing the registry drags all module components
into the initial bundle. Note batch item 2 below (the 5 batch-B stubs) was
completed by a concurrent session in d08dd85.

## What remains (priority order)

_The original items 1–3 are DONE: the interrupted native batch of 6 landed in `3a84b2e`, the
5 batch-B stubs in `d08dd85`, and the remaining native stubs via the 314/314 parity campaign._

1. **Reactor fidelity continuation** — CVCS blender + uncontrolled-dilution scenario, RCP
   pump-heat heatup, fuel-factory screens + fuel gate, and the cold-startup integration test
   landed 2026-07-03 (branch `feature/reactor-cvcs`; see **`docs/reactor-parity.md`** for the
   full ✅/🟡/❌ checklist vs `ReactorSimService.cs`). Next per that checklist: rod-bank overlap
   program (228 steps / 128 overlap / 8–72 spm) + Tavg/Tref auto controller, App-G/LTOP/PORV
   envelope, SI model + CSF trees, reactimeter panel, containment/PRT/MSSV/seal-LOCA scenarios.
2. **Custom installer** (`installer/` scaffold exists): one-click flow with auto-UAC,
   per-dependency progress, "Auto-build dependencies from source" checked by default,
   trilingual, animations. Never finished; portable build also unverified on a clean machine.
3. **C background helper** — pattern documented, still **not needed yet**; add a tiny bundled
   sidecar only when a module exceeds the Rust backend, auto-installed and invisible.
4. **Deep feature parity inside ported modules** — the catalog is 314/314 "working", but many
   native modules cover a slice of their WinForge feature set (see `docs/feature-coverage.md`
   per-module counts). `FEATURES_BRAINSTORM.md` (1,202 ideas) is the expansion backlog.

### Known issues

- ~~WebLogin i18n collision~~ — **fixed 2026-07-03** (`1d4fa8d`): the EN weblogin block was
  restored (it had been lost entirely in a wave-6 integrator crash, not just the provider
  sub-keys) and per-provider labels renamed `weblogin.prov_<id>` in both languages.
- `installer/` is scaffold-only; `tauri build` not re-run since the last Rust change window.
- Catalog counts use 311 in older docs; the parity census uses 314 (`node tools/gen-parity.mjs`).

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
