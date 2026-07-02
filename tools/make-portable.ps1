<#
Assembles a PORTABLE, self-contained WinForge Web bundle that runs on a clean machine
with no prerequisites installed (no separate WebView2, no VC++ redist).

Prereqs baked in:
  - The app exe is built with a statically-linked CRT (see src-tauri/.cargo/config.toml),
    so no VC++ redistributable is needed.
  - The Evergreen WebView2 *offline* installer is bundled; a launcher installs it
    silently per-user (no admin, no internet) only if WebView2 is not already present.
  - Vendored CLI tools in src-tauri/resources/bin are carried in ./bin next to the exe,
    where the Rust backend resolves them before touching PATH.

Run AFTER `tauri build`:
    pwsh -File tools/make-portable.ps1
Produces: dist-portable/WinForgeWeb-<version>-portable-x64.zip  (+ the unzipped folder)
#>
param(
  [string]$Configuration = 'release'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$rel  = Join-Path $repo "src-tauri/target/$Configuration"
$exe  = Join-Path $rel 'winforge-web.exe'
if (-not (Test-Path $exe)) { throw "App exe not found at $exe — run 'npx tauri build' first." }

# Version from tauri.conf.json
$conf = Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$ver  = $conf.version
Write-Host "WinForge Web portable builder — v$ver"

$outRoot = Join-Path $repo 'dist-portable'
$stage   = Join-Path $outRoot "WinForgeWeb-$ver-portable-x64"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 1. App exe
Copy-Item $exe (Join-Path $stage 'winforge-web.exe')

# 2. Vendored tool binaries (resources/bin -> ./bin next to the exe)
$binSrc = Join-Path $repo 'src-tauri/resources/bin'
if (Test-Path $binSrc) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null
  Copy-Item (Join-Path $binSrc '*') (Join-Path $stage 'bin') -Recurse -Force
}

# 3. Bundle the WebView2 offline installer (cached under tools/.cache to avoid re-download)
$cache = Join-Path $PSScriptRoot '.cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$wv2 = Join-Path $cache 'MicrosoftEdgeWebView2RuntimeInstaller-x64.exe'
if (-not (Test-Path $wv2) -or (Get-Item $wv2).Length -lt 1MB) {
  # Evergreen Standalone (offline) installer, x64. Stable fwlink.
  $url = 'https://go.microsoft.com/fwlink/?linkid=2124701'
  Write-Host "Downloading WebView2 offline installer..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $wv2 -UseBasicParsing
  } catch {
    Write-Warning "Offline installer download failed ($_). Falling back to the online bootstrapper."
    $url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
    Invoke-WebRequest -Uri $url -OutFile $wv2 -UseBasicParsing
  }
}
$wv2Size = [math]::Round((Get-Item $wv2).Length / 1MB, 1)
Write-Host "  WebView2 installer: $wv2Size MB"
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'webview2') | Out-Null
Copy-Item $wv2 (Join-Path $stage 'webview2/MicrosoftEdgeWebView2Setup.exe')

# 4. Launcher: install WebView2 only if missing, then run the app.
$launcher = @'
@echo off
setlocal EnableExtensions
set "HERE=%~dp0"
set "WVKEY={F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
set "FOUND="
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\%WVKEY%" /v pv >nul 2>&1 && set FOUND=1
if not defined FOUND reg query "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\%WVKEY%" /v pv >nul 2>&1 && set FOUND=1
if not defined FOUND (
  echo Installing bundled WebView2 runtime ^(one-time, no admin needed^)...
  "%HERE%webview2\MicrosoftEdgeWebView2Setup.exe" /silent /install
)
start "" "%HERE%winforge-web.exe"
'@
Set-Content -Path (Join-Path $stage 'WinForgeWeb-Portable.cmd') -Value $launcher -Encoding ASCII

# 5. README
$readme = @"
WinForge Web — Portable (v$ver, x64)

Double-click WinForgeWeb-Portable.cmd to run.

This bundle is fully self-contained:
  * The app is built with a statically-linked C runtime, so NO Visual C++
    redistributable is required.
  * A WebView2 offline installer is bundled under .\webview2\. The launcher installs
    it silently, per-user (no admin, works offline) ONLY if WebView2 is not already
    present on the machine, then starts the app. On machines that already have WebView2
    (most Windows 11) nothing is installed.
  * Vendored CLI tools live in .\bin\ and are used before anything on PATH.

No installation required — copy this folder anywhere (USB stick, etc.) and run.
"@
Set-Content -Path (Join-Path $stage 'README.txt') -Value $readme -Encoding UTF8

# 6. Zip
$zip = Join-Path $outRoot "WinForgeWeb-$ver-portable-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)

Write-Host ""
Write-Host "Portable folder: $stage"
Write-Host "Portable zip:    $zip ($zipSize MB)"
