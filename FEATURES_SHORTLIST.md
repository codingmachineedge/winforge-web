# WinForge Web — Top 50 Prioritized Shortlist

Distilled from [./FEATURES_BRAINSTORM.md](./FEATURES_BRAINSTORM.md) (1,202 ideas across 20 categories). This shortlist ranks features by **impact-to-effort ratio for the project's current state** — catalog browsing works, several native modules are wired to the Rust backend, the reactor simulator is in progress on a branch, and there is no router/state/CSS-framework dependency yet.

Quick wins that build directly on the catalog, Tauri backend, i18n, and the simulator dominate the top. A handful of ambitious high-impact bets sit at the bottom, explicitly marked. Feature names match the brainstorm file exactly for traceability. Effort is S (hours–day), M (a few days), L (a week+).

---

## Tier 1 — Quick wins (do first)

1. **Persisted Layout Preferences** (Catalog UI/UX & Navigation) — Save view mode, density, sidebar state, and zoom to `localStorage`, restored on mount.
   _Effort:_ S. _Impact:_ Makes every other UI toggle sticky; foundational plumbing the whole shell reuses.

2. **Fuzzy Module Search** (Search & Discovery) — Typo-tolerant Fuse.js matching over all 314 module names/descriptions, fully in-memory.
   _Effort:_ S. _Impact:_ Search is the primary way to reach 314 modules; single biggest discoverability lift for the existing catalog.

3. **Command-Palette Launcher / Command Palette (Ctrl+K)** (Search & Discovery) — Spotlight-style modal to fuzzy-jump to any module, section, or action.
   _Effort:_ S. _Impact:_ Fastest navigation for power users; reuses the in-memory index, no router needed.

4. **Bilingual Simultaneous Search** (Search & Discovery) — One query matches both EN and 繁中 fields at once by indexing both title keys.
   _Effort:_ S. _Impact:_ Core to a bilingual app; makes search usable regardless of UI language for near-zero extra cost.

5. **System Theme Auto-Follow** (Theming & Personalization) — App theme tracks OS light/dark via `matchMedia`, flipping a `data-theme` attribute.
   _Effort:_ S. _Impact:_ Expected baseline polish; prerequisite for the whole token/theming system.

6. **CSS Variable Token System** (Theming & Personalization) — Central `--bg`/`--fg`/`--accent`/`--card` token layer so all color routes through variables.
   _Effort:_ M. _Impact:_ Unlocks dark mode, accents, high-contrast, and per-section color with one refactor; pays for itself repeatedly.

7. **Pinned Favorites Rail** (Catalog UI/UX & Navigation) — Pin modules to a persistent top-of-sidebar rail for one-click access.
   _Effort:_ S. _Impact:_ High daily value across 314 modules; a `Set<moduleId>` in `localStorage`.

8. **Recently Viewed Strip** (Catalog UI/UX & Navigation) — Horizontal strip of the last N opened modules on the home view.
   _Effort:_ S. _Impact:_ Cheap re-engagement and navigation shortcut; pairs naturally with favorites.

9. **Locale-Aware Number Formatting** (i18n & Localization) — Render reactor readouts and catalog counts via `Intl.NumberFormat(i18n.language)`.
   _Effort:_ S. _Impact:_ Correctness for a bilingual app; zero deps, and the reactor readouts need it immediately.

10. **Browser-Stub Capability Banner** (Native System Modules) — Auto-detect Tauri vs browser and label native panels as unavailable stubs.
   _Effort:_ S. _Impact:_ Prevents confusing failures in browser/dev mode; a reusable `isNative` context many panels consume.

11. **Restart Explorer Button** (Native System Modules) — One-click kill+restart of `explorer.exe` via the existing `run_command`.
   _Effort:_ S. _Impact:_ Ships a genuinely useful native module immediately on top of already-wired IPC.

12. **In-App Toast Queue** (Notifications & Alerts) — Centralized toast manager with a portal-rendered stack and auto-dismiss.
   _Effort:_ S. _Impact:_ Every action (copy link, run command, errors) needs user feedback; broadly reused infrastructure.

13. **Skip to Main Content Link + Landmark Region Roles** (Accessibility) — `.sr-only` skip link plus semantic `<nav>`/`<main>`/`<aside>` landmarks.
   _Effort:_ S. _Impact:_ Baseline a11y with outsized benefit; trivial while the DOM is still small.

14. **Reduced Motion Support** (Accessibility) — Disable gauge/transition animations under `prefers-reduced-motion`.
   _Effort:_ S. _Impact:_ Matters most for the animated reactor viz that's being built now; cheap to bake in early.

15. **Route-Level Code Splitting** (Performance & Optimization) — Lazily load catalog, detail, and reactor sim as separate chunks via `React.lazy`.
   _Effort:_ S. _Impact:_ Keeps startup lean as the sim grows; the physics bundle should never ship in the initial payload.

---

## Tier 2 — High value, moderate effort

16. **Reactivity Balance Ledger** (Reactor Simulator Physics & Controls) — Live `{source: pcm}` breakdown table of every reactivity contribution.
   _Effort:_ S. _Impact:_ Directly leverages the in-progress engine; the single most instructive readout for a teaching simulator.

17. **Manual SCRAM Button** (Reactor Simulator Physics & Controls) — Operator emergency shutdown with hold-to-confirm, driving all rods in.
   _Effort:_ S. _Impact:_ Signature control-room interaction; high demo value on the simulator branch.

18. **Pause / Resume Control** (Reactor Simulator Physics & Controls) — Boolean gate freezing physics while rendering continues.
   _Effort:_ S. _Impact:_ Essential usability for a live sim; near-trivial given the tick loop.

19. **Analog Neutron Flux Gauge** (Reactor Visualization & Dashboards) — Radial SVG dial with a sweeping needle bound to reactor power.
   _Effort:_ M. _Impact:_ The iconic reactor visual; reusable gauge component for temp/pressure/period readouts too.

20. **Real-Time Strip Chart** (Reactor Visualization & Dashboards) — Scrolling multi-trace canvas recorder for power/temp/reactivity.
   _Effort:_ M. _Impact:_ The core teaching artifact of the sim; a canvas ring-buffer that many panels reuse.

21. **Annunciator Alarm Panel** (Reactor Visualization & Dashboards) — Grid of latching/flashing alarm tiles driven by trip conditions.
   _Effort:_ M. _Impact:_ Completes the control-room feel and surfaces the trip logic being built.

22. **Three-State Theme Toggle** (Theming & Personalization) — Cycle Light/Dark/System in the titlebar with persisted choice.
   _Effort:_ S. _Impact:_ The user-facing payoff of the token system; expected control.

23. **Custom Accent Picker + Windows Accent Extraction** (Theming & Personalization) — Override the accent, or pull the Windows accent color via a Rust `winreg` read.
   _Effort:_ M. _Impact:_ Native-feeling personalization that showcases the Tauri backend; sets `--accent` once, derives shades.

24. **Result Highlighting** (Search & Discovery) — Bold the matched characters in each result using Fuse `includeMatches`.
   _Effort:_ S. _Impact:_ Large perceived-quality boost on search for minimal work.

25. **Pinyin Module Matching** (Search & Discovery) — Type Latin pinyin to find Traditional Chinese module names via build-time aliases.
   _Effort:_ M. _Impact:_ Major usability win for the Taiwanese audience; builds on the bilingual index.

26. **Live Process Explorer** (Native System Modules) — Real-time process table (CPU/mem/PID) with a kill action via the `sysinfo` crate.
   _Effort:_ M. _Impact:_ Flagship native module; proves the Tauri layer and is broadly useful.

27. **Services Manager Panel** (Native System Modules) — List/start/stop services and set startup type via PowerShell + a React table.
   _Effort:_ M. _Impact:_ Another high-demand utility that reuses the run_powershell + JSON-parse pattern established by process explorer.

28. **System Info Deep Panel** (Native System Modules) — Rich hardware/OS report extending the existing `system_info` command.
   _Effort:_ S. _Impact:_ Builds straight on shipped IPC; feeds diagnostics, About, and bug reports.

29. **Persisted Preferences Store** (Data & State Management) — Central typed settings object synced to disk via a Tauri-fs-backed adapter (localStorage fallback).
   _Effort:_ M. _Impact:_ The durable backbone favorites, recents, theme, and settings all sit on; replaces ad-hoc `localStorage` calls.

30. **Favorites Store** (Data & State Management) — Star/unstar modules with an ordered list, persisted via the shared adapter.
   _Effort:_ S. _Impact:_ Formalizes the favorites rail into typed, testable state.

31. **Searchable Settings Page + Settings Registry Schema** (Settings & Administration) — A typed `SettingDef[]` registry driving a live-filterable settings screen.
   _Effort:_ M. _Impact:_ One source of truth powering rendering, validation, import/export, and defaults; reuses the catalog search pattern.

32. **Vite PWA Plugin Setup + App Web Manifest** (Offline & PWA) — `vite-plugin-pwa` with Workbox precaching and an installable manifest for the browser build.
   _Effort:_ M. _Impact:_ Makes the browser-degraded build installable and offline-capable with near-zero boilerplate; no-ops harmlessly inside Tauri.

33. **run_command Allowlist Wrapper + Argument-Only Parameterization** (Security & Privacy) — Replace free-form execution with a vetted operation enum mapped to fixed argv.
   _Effort:_ M. _Impact:_ Closes the biggest attack surface as native modules multiply; do it before adding many more commands.

34. **winforge:// deep link scheme** (Integrations & Interop) — Register a custom URL protocol so `winforge://module/<id>` opens the app at a module.
   _Effort:_ M. _Impact:_ Enables sharing, CLI hand-off, and notification deep-links; a small Tauri plugin plus the state-driven navigation already in place.

35. **Guided Product Tour + Contextual Tooltips** (Collaboration, Sharing, Onboarding & Help) — First-run spotlight walkthrough plus bilingual i18n-driven tooltips on controls.
   _Effort:_ M. _Impact:_ Turns a dense 314-module catalog and a complex sim into something a newcomer can navigate.

---

## Tier 3 — Ambitious bets

36. **Point-Kinetics Core Loop** (Reactor Simulator Physics & Controls) — [Ambitious] RK4 integration of the 6-group point-kinetics equations on a fixed timestep.
   _Effort:_ L. _Impact:_ The heart of the simulator; everything reactor-related depends on it. Likely already underway on the branch — landing it correctly unblocks Tier 1–2 sim work.

37. **Xenon-135 Poisoning Model** (Reactor Simulator Physics & Controls) — [Ambitious] I-135→Xe-135 buildup/decay and its large negative reactivity, incl. the post-SCRAM peak.
   _Effort:_ M. _Impact:_ The transient that makes the sim genuinely educational; coupled ODEs on the existing integrator.

38. **Web Worker Physics Thread** (Performance & Optimization) — [Ambitious] Move the integrator off the main thread with `postMessage` state snapshots.
   _Effort:_ M. _Impact:_ Keeps the UI at 60fps under heavy viz; architecturally cheaper to adopt while the engine is still forming.

39. **Scenario Definition Format + Scripted Event Timeline** (Reactor Simulator Physics & Controls) — [Ambitious] Declarative JSON scenarios with time/condition-triggered events.
   _Effort:_ M. _Impact:_ Unlocks tutorials, malfunctions, sample gallery, and share links; mirrors the catalog's data-driven ethos.

40. **Reactor Tutorial Missions + Checkpoint Validation Engine** (Collaboration, Sharing, Onboarding & Help) — [Ambitious] Sequenced hands-on missions with predicate-based checkpoints.
   _Effort:_ M. _Impact:_ Transforms the sim from a toy into a teaching tool; depends on the scenario format above.

41. **Shareable Sim Link** (Collaboration, Sharing, Onboarding & Help) — [Ambitious] Encode full scenario state into a compressed URL param for one-click sharing.
   _Effort:_ M. _Impact:_ Frictionless classroom/social distribution; reuses the scenario serializer and deep-link infra.

42. **Native Rust Sim via Tauri IPC / Rust WASM Physics Core** (Performance & Optimization) — [Ambitious] Run the hot integrator in Rust/WASM and stream results.
   _Effort:_ L. _Impact:_ Near-native physics speed for large models; a later optimization once the TS engine is validated.

43. **3D Core View (Three.js)** (Reactor Visualization & Dashboards) — [Ambitious] Rotatable instanced-mesh lattice of fuel rods colored by power.
   _Effort:_ L. _Impact:_ Standout showcase visual; heavy dependency, so gate it behind lazy loading and a feature flag.

44. **Physics Validation Test Suite** (Testing & QA) — [Ambitious] Vitest assertions of analytic results (steady state, reactivity→period, SCRAM decay).
   _Effort:_ M. _Impact:_ The credibility backbone for a physics sim; pure functions make it tractable and it guards every future change.

45. **Local Named Profiles** (Accounts, Profiles & Sync) — [Ambitious] Multiple named local profiles, each with own settings/favorites, no server.
   _Effort:_ M. _Impact:_ Enables classroom/shared-machine use; layers cleanly on the preferences store.

46. **First-Run Consent Modal + Consent-Aware Emit Wrapper** (Analytics & Telemetry) — [Ambitious] Default-declined analytics gate with a single `track()` that short-circuits when off.
   _Effort:_ M. _Impact:_ Privacy-first foundation that must exist before any telemetry; keeps the whole app honest by construction.

47. **Typed Tauri command bindings** (Developer Experience & Tooling) — [Ambitious] Codegen a typed `commands.ts` from Rust signatures via `tauri-specta`.
   _Effort:_ M. _Impact:_ Type-safe IPC across a growing native surface; prevents a whole class of frontend/backend drift bugs.

48. **Strict tsconfig preset + CI lint + typecheck workflow** (Developer Experience & Tooling) — [Ambitious] Roll in strict TS flags incrementally and gate PRs on tsc/eslint/prettier.
   _Effort:_ M. _Impact:_ Compounding quality dividend; cheapest to adopt now before the codebase grows.

49. **MCP server exposing modules** (Integrations & Interop) — [Ambitious] A stdio MCP server letting AI agents list and run WinForge modules as tools.
   _Effort:_ L. _Impact:_ A differentiating, forward-looking integration that reuses the existing command layer and catalog.

50. **Pluggable Sync Provider Interface** (Accounts, Profiles & Sync) — [Ambitious] Abstract `SyncProvider` (Gist/WebDAV/S3) with client-side E2EE for profiles.
   _Effort:_ L. _Impact:_ Cross-device continuity for power users and classrooms; highest effort, so it anchors the bottom of the list.
