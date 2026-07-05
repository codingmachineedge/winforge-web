# WinForge Web · 網頁版

A **Tauri v2 desktop app** (Windows `.exe` / installer) with a **React + TypeScript (Vite)**
frontend — a rewrite of [WinForge](https://github.com/), a WinUI 3 / .NET desktop suite of
**314 modules** headlined by a physics-based **PWR nuclear reactor simulator**.
Fully **bilingual: English + 繁體中文**.

> This ships as a **real Windows desktop application**, not just a browser page. The React/TS
> frontend is wrapped in a **Tauri v2** shell whose **Rust backend** performs the native
> operations WinForge does (a command runner, a PowerShell runner, system info, filesystem).
> Native modules (services, startup, connections, environment variables, drives, events, …)
> invoke those backend commands to run the **real** operation. Modules that genuinely can't run
> yet stay labelled stubs. The same frontend still runs in a plain browser (`npm run dev`), where
> `isTauri()` is false and native panels degrade to labelled stubs.

## Install (one line)

Open **PowerShell** — no need to run it as administrator; the script self-elevates — and paste:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://codingmachineedge.github.io/winforge-web/install.ps1 | iex"
```

It self-elevates via `Start-Process -Verb RunAs`, downloads the latest release installer from
GitHub Releases, and runs it. Landing page & docs:
**<https://codingmachineedge.github.io/winforge-web/>** ·
[Wiki](https://github.com/codingmachineedge/winforge-web/wiki) ·
[Releases](https://github.com/codingmachineedge/winforge-web/releases).
Prefer to do it by hand? Grab the installer or portable zip from
[Releases](https://github.com/codingmachineedge/winforge-web/releases), or build from source (below).

## What's here

| Area | Status |
| --- | --- |
| **Tauri v2 desktop shell** (`src-tauri`, Rust) — builds a Windows `.exe`/installer via `tauri build` | ✅ |
| Rust backend commands: `run_command`, `run_powershell`, `system_info`, `list_dir`, `get_env` | ✅ |
| Native modules wired to live backend probes (System Monitor, Services, Startup, Connections, Env Vars, Drives, Events, Devices, Battery, Hosts, System Info, …) | ✅ |
| App shell (Fluent-inspired sidebar + content) mirroring WinForge's `MainWindow` navigation | ✅ |
| Data-driven **module catalog** — 314 modules, 4 sections, derived from WinForge's `MainWindow.xaml` + `ModuleRegistry.cs` | ✅ |
| Browsable catalog: section/group grid, card + detail views, bilingual search, web/native filter | ✅ |
| i18n scaffolding (react-i18next, EN + 繁體中文, persisted language) | ✅ |
| **PWR reactor simulator** (point-kinetics physics from WinForge's reactor engine) | 🚧 stub → in progress on a branch |
| Deeper ports of individual native modules | 🚧 incremental |

## Desktop app (Tauri v2)

```bash
npm install
npm run tauri:dev     # run the desktop app in dev (hot-reload frontend + Rust backend)
npm run tauri:build   # produce the Windows .exe + NSIS/MSI installer under src-tauri/target/release/bundle
```

Requires the **Rust toolchain** (`rustup`, MSVC host), **VS Build Tools / MSVC**, and the
**WebView2** runtime (bundled on Windows 11). The Rust backend lives in
[`src-tauri/src/commands.rs`](src-tauri/src/commands.rs); frontend↔backend wiring is in
[`src/tauri/bridge.ts`](src/tauri/bridge.ts) and [`src/tauri/nativeActions.ts`](src/tauri/nativeActions.ts).

## Catalog structure (mirrors WinForge)

- **Suite · 套件** — Dashboard, Nuclear Reactor, Reactor Settings, and 18 reactor-powered industrial loads.
- **Categories · 分類** — Files & Disks, System, Media & Capture, Tweaks & Input, Apps & Git, Security & Privacy (native-only).
- **Toolbox · 工具箱** — 12 groups of pure client-side utilities (JSON/Data, Text, Encoding, Crypto, Web/HTTP, Network, Dev, Time, Calculators, Colors, Everyday). Web-portable.
- **Windows 11 · 視窗 11** — system tweaks (native-only).

## Develop (frontend only, in a browser)

```bash
npm install
npm run dev        # start Vite dev server (http://localhost:5199)
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build
```

For the full desktop app see **Desktop app (Tauri v2)** above.

### Regenerating the catalog

The module catalog in `src/data/catalog.ts` is generated from a local WinForge checkout:

```bash
node tools/gen-catalog.mjs "C:/path/to/WinForge"
```

It parses `MainWindow.xaml` (the navigation tree → sections/groups) and
`Services/ModuleRegistry.cs` (per-module English/中文 titles, Segoe Fluent glyphs, keywords),
classifies each module web-portable vs native-only, and emits the typed catalog.

## Scope & roadmap

1. ✅ Scaffold — Tauri v2 desktop shell + React shell + i18n + data-driven catalog browser.
2. ✅ Native wiring — Rust backend commands + live probes for system modules.
3. 🚧 Reactor simulator — port the point-kinetics core physics (reactivity, precursors, fuel/coolant
   thermal feedback, control rods, SCRAM) from WinForge's `ReactorSimService`.
4. 🚧 Deeper native module ports (mutating operations, richer UIs) and the Toolbox utilities.

## Power-generation credits

The reactor simulator has a persisted **power-credit** system: credits are awarded by
**external systems** (the app has no knowledge of how they are earned) and redeemed in-app for
power. **1 credit = 1 simulated hour**, in one of two selectable redemption modes (persisted;
default `grid`, set by `DEFAULT_CREDIT_MODE` in `src/reactor/powerCredits.ts`):

- **`grid` — credit-powered grid.** With the reactor off (Shutdown / Tripped / Meltdown) the grid
  is fed at full rated output (≈ 1,150 MWe, i.e. ≈ 1,150 MWh per credit), draining 1 credit per
  simulated hour. At zero balance the grid goes dark unless the reactor is started normally.
- **`autostart` — auto-start reactor.** Spend exactly 1 whole credit to auto-start the reactor for
  exactly 1 simulated hour, after which it shuts itself down (rods in, mode Shutdown). The paid
  hour runs with the assisted-start behaviour of the original engine: automatic SCRAMs suppressed
  and a 2.5× fuel-consumption penalty.

**Balance store** (persists across sessions): localStorage key `winforge.powerCredits.v1` —
`{"version":1,"balance":<number>,"mode":"grid"|"autostart","autoRunRemainingS":<number>,"appliedGrantIds":[...]}`.

**Granting credits from outside the app** — three equivalent generic entrypoints; every grant
carries an optional unique `id` applied at most once, so double delivery is always safe:

1. **Window hook:** `window.winforgeGrantPowerCredits(n, id?)` (any script context with access to
   the app window), or import `grantPowerCredits(n, id?)` from `src/reactor/powerCredits.ts`.
2. **Browser inbox key** (same origin): write localStorage key `winforge.powerCredits.inbox.v1`
   with `{"grants":[{"id":"<unique-string>","credits":<positive number>}]}` — ingested on load,
   on cross-tab storage events, and each sim tick, then consumed.
3. **Desktop inbox file** (installed Tauri app): write the same JSON shape to
   `%LOCALAPPDATA%\WinForge\power-credits\inbox.json`. The app polls every few seconds,
   atomically claims the file (rename), applies unseen grant ids, and deletes it. Writers just
   create/overwrite the file — no other coordination needed.
4. **Web-root grants file**: drop `power-credits.json` next to the served app — in this repo
   `public/power-credits.json` (git-ignored, machine-local; vite serves `public/` at `/`). The
   app polls `GET /power-credits.json` read-only every few seconds and never modifies it, so the
   writer may treat it as an **append-only ledger**: keep every grant ever issued in `grants` and
   atomically rewrite the whole file — ids keep re-reads exactly-once. In each grant the amount
   may be spelled `"credits"` or `"amount"` (both in credits); an optional `"unit"` must name a
   credit unit or the entry is skipped; all other fields (reason strings, timestamps, source
   labels, counters, …) are ignored. A file **without** a `grants` array may instead carry a
   cumulative `"totalCredits": <number>` (monotonic counter — only the delta above the highest
   total already consumed is granted); when a `grants` array is present, `totalCredits` is
   treated as a redundant summary and ignored, never double-counted.

## Tech

React 18 · TypeScript (strict) · Vite · react-i18next · **Tauri v2** (Rust backend). Ships as a
native Windows desktop app; the frontend also runs standalone in a browser for quick iteration.

## License

MIT
