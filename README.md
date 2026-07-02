# WinForge Web · 網頁版

A **React + TypeScript (Vite)** rewrite of [WinForge](https://github.com/) — a WinUI 3 / .NET
desktop suite of **314 modules** headlined by a physics-based **PWR nuclear reactor simulator**.
Fully **bilingual: English + 繁體中文**.

> This is a web port. Native-only modules (registry tweaks, services, Docker, ConPTY terminal,
> hardware, native tools, etc.) are rendered as clearly-labelled **UI stubs** — the browser
> cannot touch the Windows system. Pure client-side modules (the Toolbox utilities and the
> reactor simulator) are portable and are being ported to run for real.

## What's here

| Area | Status |
| --- | --- |
| App shell (Fluent-inspired sidebar + content) mirroring WinForge's `MainWindow` navigation | ✅ |
| Data-driven **module catalog** — 314 modules, 4 sections, derived from WinForge's `MainWindow.xaml` + `ModuleRegistry.cs` | ✅ |
| Browsable catalog: section/group grid, card + detail views, bilingual search, web/native filter | ✅ |
| i18n scaffolding (react-i18next, EN + 繁體中文, persisted language) | ✅ |
| **PWR reactor simulator** (point-kinetics physics from WinForge's reactor engine) | 🚧 stub → in progress on a branch |
| Full ports of individual native modules | ⛔ stubs by design |

## Catalog structure (mirrors WinForge)

- **Suite · 套件** — Dashboard, Nuclear Reactor, Reactor Settings, and 18 reactor-powered industrial loads.
- **Categories · 分類** — Files & Disks, System, Media & Capture, Tweaks & Input, Apps & Git, Security & Privacy (native-only).
- **Toolbox · 工具箱** — 12 groups of pure client-side utilities (JSON/Data, Text, Encoding, Crypto, Web/HTTP, Network, Dev, Time, Calculators, Colors, Everyday). Web-portable.
- **Windows 11 · 視窗 11** — system tweaks (native-only).

## Develop

```bash
npm install
npm run dev        # start Vite dev server
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build
```

### Regenerating the catalog

The module catalog in `src/data/catalog.ts` is generated from a local WinForge checkout:

```bash
node tools/gen-catalog.mjs "C:/path/to/WinForge"
```

It parses `MainWindow.xaml` (the navigation tree → sections/groups) and
`Services/ModuleRegistry.cs` (per-module English/中文 titles, Segoe Fluent glyphs, keywords),
classifies each module web-portable vs native-only, and emits the typed catalog.

## Scope & roadmap

1. ✅ Scaffold — shell + i18n + data-driven catalog browser.
2. 🚧 Reactor simulator — port the point-kinetics core physics (reactivity, precursors, fuel/coolant
   thermal feedback, control rods, SCRAM) from WinForge's `ReactorSimService`.
3. 🚧 Real web ports of the Toolbox utilities (converters, encoders, generators — all client-side).

## Tech

React 18 · TypeScript (strict) · Vite · react-i18next. No backend; everything runs in the browser.

## License

MIT
