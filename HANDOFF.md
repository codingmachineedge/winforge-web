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
