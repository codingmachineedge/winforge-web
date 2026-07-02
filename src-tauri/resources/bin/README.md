# Vendored tool binaries

Redistributable CLI tools placed here are bundled into the app and resolved by the
Rust backend **before** falling back to `PATH` or offering an install. This lets modules
work out of the box without the user installing prerequisites.

At runtime the backend resolves a tool `foo` in this order:
1. `<resources>/bin/foo.exe` (this folder, bundled with the app)
2. `foo` on the system `PATH`
3. offer to install it (winget → Chocolatey fallback)

Only place tools here whose license permits redistribution. Drop a `<name>.exe`
(or a folder) here and reference it from `src/tauri/deps.ts` and `nativeActions`.

This README is a placeholder so the resources glob always matches at least one file.
