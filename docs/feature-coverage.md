# WinForge → winforge-web feature coverage map

Produced by a parallel feature audit (8 subagents walking `WinForge/Pages`, `Services`,
`Catalog`). This is the **reality check**: the catalog shell is the skeleton; the real
work is the thousands of granular features (buttons, toggles, settings, sub-tabs) inside
the ~312 modules.

## Headline

- **312 module pages** audited across `WinForge/Pages/*Module.xaml{,.cs}` (106k LOC of C#).
- **~5,000+ individual features** (per-module average ≈ 16; range 5–48). Sample maxima:
  Audio Editor 48, Android ADB 45, Nuclear Reactor 45, Package Manager 42, Docker 42,
  Communications 42, SSH 38, Config & Backup 36, AWS CLI 36, Packer 35.
- **Implemented in winforge-web: 226 / 311 modules working (73%)** as of 2026-07-03
  (post-merge of batch-a, batch-b and reactor-fidelity branches). Everything else is Stub/Missing.

Status legend per module: **working** (real interactive port, registered), **partial**
(read-only live probe only), **stub** (catalog card / not started).

## Current winforge-web module status — 226 working / 85 stub (73%)  [updated 2026-07-03, post-merge]

| Bucket | Working | Stub | Total |
|---|---|---|---|
| **All modules** | **226** | **85** | **311** |
| Web-capable (`native:false`) | 165 | 9 | 174 |
| Native (`native:true`, needs Rust backend) | 61 | 76 | 137 |

- The **web-capable surface is complete** except 9 stubs, all reactor-family industrial
  simulators owned by the reactor agent: reactor, reactorsettings, hpc, datacenter, collider,
  reactorbank, desal, pumpedhydro, vertfarm.
- Remaining real work = the **76 native stubs** (disk/hardware/media/window-management tools)
  that run through the Tauri Rust backend. A scripted native batch
  (`tools/port-pipeline/winforge-native-batch.js`) is ready to re-run — see `HANDOFF.md`.
- The 61 native "working" modules = the original 15 read-only/action probes (Services, System
  Monitor, Process Explorer, Environment Variables, Connections, Drives, Hosts, Package Manager,
  Nmap, Git, Startup Apps, Scheduled Tasks, Event Viewer, Devices, System Info) + the Git
  workbench + ~45 batch-b N–Z native launchers/tools (VS Code, VirtualBox, Wireshark, Ollama,
  SSH, OneDrive, OCR, Screen Recorder, …). The ~165 working web modules are pure-client tools
  (JSON/text/color/encoding/crypto/network-lookup/factory-sims/etc.).

### Recount (run anytime to refresh the headline)

```bash
node -e 'const fs=require("fs");const cat=fs.readFileSync("src/data/catalog.ts","utf8");let reg="";for(const f of ["src/modules/registry.tsx","src/modules/registryB.tsx","src/modules/registryA.tsx"])if(fs.existsSync(f))reg+=fs.readFileSync(f,"utf8");const R=new Set([...reg.matchAll(/["\x27\x60](module\.[a-z0-9]+)["\x27\x60]/g)].map(m=>m[1]));const I=[...cat.matchAll(/"tag":\s*"(module\.[a-z0-9]+)",\s*\n\s*"en":\s*"([^"]+)",[\s\S]*?"native":\s*(true|false)/g)];const seen=new Set();let t=0,w=0;for(const m of I){if(seen.has(m[1]))continue;seen.add(m[1]);t++;if(R.has(m[1]))w++;}console.log(`Working ${w}/${t} (${Math.round(w/t*100)}%)  Stub ${t-w}`);'
```

Even the "working" native modules cover only a slice of their WinForge feature set — e.g. WinForge
Services has start/stop/restart **plus** set-startup-type (Automatic/Manual/Disabled) which
the web port lacks; Package Manager has 8 sub-tabs and 9 package managers vs the port's winget-only.

## Per-module feature counts & sub-tabs (from the audit)

Format: `feature_count` · sub-tabs · status. Sub-tabs matter for the navigation shell
(§ nav) — each is an internal view the module needs a slot for.

### Highest-surface modules (build the nav sub-tab framework for these first)
| Module | features | sub-tabs | status |
| --- | ---: | --- | --- |
| Audio Editor | 48 | Source, Waveform, Edit/Effects, Mix, Export | stub |
| Android ADB | 45 | Console, Files, APK backup, Live logcat, Screen mirror | stub |
| Nuclear Reactor | 45 | Reactor room, Status, Alarms, Trends, Controls | (other agent) |
| Package Manager | 42 | Discover, Updates, Installed, Bundles, Sources, Ignored, Setup, Settings | partial |
| Docker | 42 | Containers, Images, Volumes, Networks, Compose | stub |
| Communications | 42 | none (many provider forms) | stub |
| Minecraft Server | 42 | Server, Properties, Console, Plugins | stub |
| SSH | 38 | Profiles, Terminal, Live terminal, Keys, SFTP | stub |
| Config & Backup | 36 | none | stub |
| AWS CLI | 36 | Services browser, Operations, Credentials | stub |
| Minecraft World Tools | 36 | Chunker, BlueMap, Settings, Log | stub |
| Media Player | 36 | Tracks, Playlist, Transcode | stub |
| Packer | 35 | none | stub |
| Minecraft Launcher | 34 | none | stub |
| API Client | 32 | Params, Headers, Body, Auth; Response Body/Headers | stub |
| Mail | 32 | none | stub |
| Komorebi | 32 | none | stub |
| Ollama | 28 | Models, Pull, Running, Chat, Operations | stub |
| AI Chat | 28 | Conversations, Chat | stub |
| Archives | 28 | none (~100 ops) | stub |
| Torrent (native) | 28 | none | stub |
| qBittorrent | 28 | Torrents, Categories, Tags, Preferences | stub |
| Docker over SSH | 26 | none | stub |
| SQLite Browser | 26 | Structure, Browse Data, Execute SQL | stub |
| Pixel Editor | 26 | none | stub |
| Cloudflare | 25 | none | stub |
| Color Tools | 25 | none | stub |
| KeePass | 24 | none | stub |
| cURL Generator | 24 | none | stub |
| pgAdmin | 24 | none | stub |
| Markdown Table | 24 | none | stub |
| AltSnap | 24 | none | stub |
| Timer | 24 | Stopwatch, Countdown, Pomodoro | stub |

### Sub-tabbed modules (need internal navigation)
Docker (5), Android ADB (5), Audio Editor (5), Package Manager (8), SSH (5),
Media Player (3), Ollama (5), AI Chat (2), API Client (2+2), Minecraft Server (4),
Minecraft World Tools (4), qBittorrent (4), SQLite Browser (3), Timer (3),
JWT Builder (2), Short ID (2), Settings Hub (2), Shell Menu (3), Shortcut Guide (2),
Ping (2), Process Explorer (2), Emulator (2), Audio Tagger (2), PowerToys Extras (4),
Randomizer (4), Reactor (5).

## How this drives the Ralph loop

Regenerate the shallow status map with `node tools/gen-parity.mjs` (docs/PARITY.md).
Each loop iteration:
1. Pick the highest-value **stub** (prefer high feature_count + most-used).
2. Read `WinForge/Pages/<Name>Module.xaml{,.cs}` for the exact feature list (this file
   has the summary; the source is ground truth).
3. Build the real UI — with the module's sub-tabs (§ nav shell) — and Rust backend for
   native operations. Wire external tools through the winget→choco→bundled resolver.
4. Verify (screenshot), commit, push.

> Audit note: chunk 3 (modules H*–I*) and the tails of chunks 0 (A*–C*) and 7 (U*–Z*)
> were still enumerating at write time; counts above are representative and will be
> topped up on the next audit pass. The per-module ground truth is always the WinForge source.
