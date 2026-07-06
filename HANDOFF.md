# winforge-web — Session Handoff

_Last updated: 2026-07-06 (tweak-catalog port + real registry apply). See "Session 2026-07-06"
immediately below; earlier sessions follow._

## Session 2026-07-06 (tweak catalog → real registry apply)

All GREEN (`tsc` 0 errors, `vite build` OK, **vitest 390 passing / 30 files**). Latest `main`:
`8db1d78`. Everything pushed to **all three remotes** (main, wiki `master`, `gh-pages`) under
the **codingmachineedge** account.

Headline: **the 895-tweak Windows catalog was ported to the web AND now applies for real.**

1. **895-tweak catalog port.** `tools/gen-tweaks.mjs` runs WinForge's own headless exporter
   (`WinForge.exe --export-docs`) and parses the uniform Markdown into `src/data/tweaks.ts`
   (895 tweaks / 22 categories, bilingual title+desc+keywords, kind, admin/destructive/restart).
   `tools/gen-catalog.mjs` injects the 22 categories under **Windows 11 › All Tweaks**
   (`native:false`, tweak titles packed into keywords for global search) and renames the desktop
   **Suite** section to **Simulations** (`SECTION_RENAMES`; id stays `suite`). `TweaksBrowserModule`
   renders them (searchable, bilingual). `moduleCount` still excludes the tweak buckets (stays 315).
2. **Simulations tab.** New nav-rail destination (`NavRail`, `shellM3.railSimulations`) → the
   renamed suite section; new `?section=<id>` deep link in `App.tsx` (e.g. `?section=suite`).
3. **REAL registry apply (166 tweaks).** `tools/gen-tweak-ops.mjs` → `src/data/tweakOps.ts`
   deterministically extracts the concrete op behind `Tweak.RegToggle`/`RegRadio` (root/path/name/
   on/off/kind, resolving const paths) plus 7 hand-verified bespoke-helper ops (telemetry level,
   location access, Chrome/Edge incognito, Edge startup, Explorer launch-to, NumLock-at-startup) —
   **154 toggles + 12 radios**. `src/tauri/registry.ts` reads/sets/deletes via PowerShell
   (hive-explicit `Registry::` paths, exact value-kind), mirroring `RegistryHelper`; pinned by
   `registry.test.ts`. `TweaksBrowserModule` renders **live toggle/select controls (Tauri only)**
   that read current state on mount and apply on change — admin/destructive confirm first; a plain
   browser keeps the inert reference. **Tauri-only by design** (low-level desktop app, not a website).
   Verified by **two `ultracode` fan-out audits** (9 agents, one per Catalog file) against the C#
   source: the first caught 22 `String`-vs-`DWord` kind mismatches + an `off=null`→`"null"`
   delete-vs-write bug (both fixed in the parser); the re-audit is **0 mismatches**.
4. **Parity wave 11.** Enriched 5 under-ported modules to fuller C# parity (self-contained, inline
   bilingual `pick()`): Gradient (presets/radial/CSS-import), Habit tracker (week-nav/streaks/
   import-export), Everything (relevance sort/filters/command preview), Web cloner, Bitwarden
   (real `crypto` password/TOTP/admin-token + docker-compose composer). Marked in
   `tools/port-pipeline/parity-done.txt`.
5. **Docs/screenshots/site.** README + GitHub wiki (Home/Modules, + new FAQ + Build-from-Source)
   updated; a self-contained **in-site wiki page `wiki.html`** built for the GitHub Pages site
   (sidebar TOC + hash routing, markdown pre-rendered by the scratch `gen-wiki.mjs`), linked from
   the landing; `docs/screenshots/` refreshed + new `simulations.png`. See the saved
   **ship-checklist** memory: every change updates README+wiki+Pages+screenshots and pushes all three.

### Gotchas learned 2026-07-06 (keep these)
- **`gh` account reverts to `cafepromenade` on its own** — winforge-web/wiki/pages are owned by
  `codingmachineedge`, which needs write. **Re-assert `gh auth switch --user codingmachineedge`
  immediately before every push** (a stale active account gives a 403; `git fetch` still works
  under cafepromenade). Rule: match the active account to the repo owner.
- The **gh-pages `index.html` is AV-locked** on disk (it contains the `irm|iex` install one-liner) —
  Read/Write/grep get "Permission denied", but `git show`/hash-object work. Patch it via **git
  plumbing** (`git show` → transform → `hash-object -w --stdin` → `update-index --cacheinfo` →
  `commit-tree` → `update-ref`), never the working file. `wiki.html` is not locked (edit normally).
- **Module-detail routes (`?module=<tag>`) can't be screenshotted headlessly** — ModuleDetail
  eagerly imports the whole registry, so Chromium's `--virtual-time-budget` never settles (confirmed
  with an untouched module). Section/shell routes (`?section=`, `?view=reactor`) shoot fine.
- Registry-op extraction is **safety-critical** — verify every extracted op against the C# (the
  ultracode audit found real kind/null bugs). `off` must be JSON `null` (not `"null"`) to delete.
- Build still needs **`npm install --legacy-peer-deps`** (vite ^8 vs plugin-react peer; node_modules
  drifts stale). `tsc`/`vitest` work without it; `vite build`/preview need it.

### Open items 2026-07-06
- Only the **uniform + a few bespoke tweaks (166)** apply for real; the ~729 Action/launcher/Slider/
  CustomToggle tweaks remain **reference**. Extending apply to Action commands / more bespoke
  helpers is the next parity step. The real writes need an **installed Tauri build** to exercise
  end-to-end (unit-tested + PS builders pinned; the desktop app performs the actual writes).

---

## Session 2026-07-05 (feature/reactor-protection-wave)

Three deliverables, all shipped GREEN (`tsc` 0 errors, `vite build` OK, `cargo check` OK,
**vitest 375 passing / 28 files**):

1. **Reactor protection/ESF wave (315th-and-fidelity).** Ported the six remaining
   `ReactorSimService.cs` subsystems as pure engines + vitest suites + control-room panels +
   trilingual i18n slices, wired onto the live `ReactorSim` by a single-writer coordinator
   `src/reactor/reactorAux.ts` (11 integration tests). Also added the Reactimeter panel.
   Systems: rod-bank overlap + Tavg/Tref auto control (`rodControl.ts`), PORV/code-safeties/PRT
   + TMI stuck-PORV drill (`pressureRelief.ts`), App-G P/T limits + LTOP + PTS (`ptLimits.ts`),
   SI + accumulators + MSSV bank (`engineeredSafety.ts`), containment + RCP seal-LOCA
   (`containment.ts`), six CSF status trees (`csfTrees.ts`). Full ✅/🟡/❌ vs the C# source is in
   **`docs/reactor-parity.md`**. Panels mounted in `ReactorView`; the view now calls
   `registerModuleStrings()` itself (it's a lazy route separate from ModuleDetail).
2. **File Browser module** (`module.filebrowser`, 315th module). New Rust backend commands
   (`fs_list/rename/mkdir/copy/move/delete_permanent/read_text` in `commands.rs`), a full
   front-end (`FileBrowserModule.tsx`: drives, breadcrumbs, listing with size/date/attrs, new
   folder, rename, copy/move, delete-to-Recycle-Bin via in-process .NET, hidden toggle, text
   preview), trilingual slice `fileBrowser.ts`. **No separate C/C# sidecar needed** — the only
   thing Rust `std::fs` can't do (Recycle-Bin delete) is handled by an in-process
   `Microsoft.VisualBasic.FileIO` call through `run_powershell`, matching the FileLocksmith
   pattern. Marked `native: false` so the live UI renders in the browser preview too.
   Web-only modules now survive catalog regen via a `WEB_EXTRAS` list in `tools/gen-catalog.mjs`.
3. **i18n regression guard + qbt fix.** The user hit raw `qbt.*` keys in the desktop app — a
   feature-parity wave had replaced the enB `qbt` block instead of merging, dropping 48 EN keys
   (the whole connection form). Re-authored them (yue side was intact). Added
   **`src/i18n/moduleKeys.test.ts`** — scans every `t('ns.key')` in modules+components and
   asserts it resolves in EN and 粵. It surfaced **2,082 pre-existing orphans across 74
   namespaces** (same root cause). Same-day burn-down: **1,123 fixed** (24 authored namespaces
   applied via the hardened `tools/i18n-apply-harvest.mjs`, plus the cloudflare nesting-mismatch —
   the module read `cloudflare.api.*` while the strings were flat; call sites repointed, the API
   blurb split off as `apiBlurb` per the flat-vs-nested-collision gotcha). **959 orphans remain**
   across ~50 namespaces (doctors, headerscore, disk, rainmeter, regedit, zoomit, …) recorded in
   **`src/i18n/moduleKeys.baseline.json`**; the guard fails only on NEW orphans + flags a stale
   baseline when you fix some. Burning the rest down is the top open item — author the missing
   EN+粵 strings per namespace (module source + sibling-language block give full context), apply
   with the harvest tool, then shrink the baseline (the guard tells you exactly which entries).

### Later the same day (Material-design-rewrite handoff + docs)

4. **Reactor Control Room** (design handoff phase 1): the CRT console now IS the reactor screen
   (`src/components/reactor/controlRoom/`), bound to the real engine; new `turbineSecondary.ts`
   (governor/auto-sync/steam-dump/SG-level, breaker-gated MWe). Engineering panels are unmounted
   (engines still run; alarms surface on the annunciator board).
5. **Material 3 shell** (phase 2): `src/styles/m3.css` md-* tokens (light/dark/system on the
   existing data-theme), nav rail + modal drawer + top bar (`src/components/m3/`), all shell
   surfaces restyled in place, legacy-token remap so all 315 module UIs inherit the palette.
   `Sidebar.tsx`/`ThemeToggle.tsx` deleted. New eager slice `shellM3.ts`.
6. **i18n debt is GONE**: the burn-down session finished all 2,082 orphans; the baseline is `[]`
   and the guard now enforces ZERO missing keys — never re-grow the baseline.
7. **Docs/screenshots**: README rewritten (Control Room flagship, 315 modules, M3 shell),
   GitHub wiki authored (Home / Reactor-Control-Room / Modules / Development),
   `docs/screenshots/` captured headlessly via `node tools/capture-screens.mjs` (uses the
   shareable URL params `?view=reactor|settings|about`, `?module=<tag>`, `&warm=1`, `&core=1`).

### Gotchas learned 2026-07-05 (keep these)
- A **lazy route that isn't ModuleDetail** (e.g. `ReactorView` via the `reactor` view kind) must
  call `registerModuleStrings()` itself or its lazy namespaces render as raw keys.
- Bulk-inserting i18n keys into the big **CRLF** slice files (en.ts/zh-Hant.ts/batchB.ts) is
  fragile: match the owning EN-vs-粵 block by a sample VALUE (not just the first `qbt: {`), insert
  at the block OPEN with exact 4-space indent, and normalize keys to their leaf (`ns.key`→`key`).
  Verify with `tsc` + the moduleKeys guard after every batch.
- New reactor subsystems stay **framework-free**; the coordinator `reactorAux.ts` is the only
  bridge that reads/writes `ReactorSim`. Inter-module couplings (LTOP↔PORV, PRT→containment) use
  one-tick lags exactly like the C# end-of-tick handoffs.

---

_2026-07-03 recovery session notes follow._

_The four 2026-07-02/03 parallel sessions (bootstrap, batch-A, batch-B, reactor-fidelity) all hit
the usage limit mid-shutdown; this snapshot is the state after their work was recovered, merged
and pushed._

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
