<#
    WinForge Web — one-line installer
    ---------------------------------
    Usage (from any PowerShell window; it will elevate itself):

        powershell -ExecutionPolicy Bypass -Command "irm https://codingmachineedge.github.io/winforge-web/install.ps1 | iex"

    What it does:
      1. Self-elevates to Administrator via Start-Process -Verb RunAs (UAC prompt).
      2. Queries the GitHub Releases API for the latest winforge-web release.
      3. Downloads the installer asset (NSIS/MSI .exe/.msi, or the portable .zip fallback).
      4. Runs the one-click installer (or unpacks the portable build).

    Repo:  https://github.com/codingmachineedge/winforge-web
    MIT licensed. Review before running — you can read this file at:
      https://codingmachineedge.github.io/winforge-web/install.ps1
#>

[CmdletBinding()]
param(
    # Set by the elevated relaunch so we don't loop forever trying to elevate.
    [switch]$Elevated,
    # Skip running the installer after download (used by the landing-page dry-run / CI test).
    [switch]$WhatIfRun
)

$ErrorActionPreference = 'Stop'
$Owner   = 'codingmachineedge'
$Repo    = 'winforge-web'
$ApiBase = "https://api.github.com/repos/$Owner/$Repo"

function Write-Step($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)    { Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-WarnMsg($m){ Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) {
    Write-Host ""
    Write-Host "  ✗ $m" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Need help? Open an issue: https://github.com/$Owner/$Repo/issues" -ForegroundColor DarkGray
    if (-not $Elevated) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# 1. Self-elevation
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  WinForge Web installer" -ForegroundColor White
Write-Host "  ----------------------" -ForegroundColor DarkGray

if (-not (Test-Admin) -and $Elevated) {
    # We already relaunched with RunAs but still aren't elevated — don't loop.
    Write-WarnMsg "Elevation did not grant Administrator rights; continuing best-effort."
}
elseif (-not (Test-Admin)) {
    Write-Step "Requesting Administrator privileges (UAC)..."

    # Re-materialise this script to a temp file so the elevated process can run it
    # whether we were launched from `irm | iex` (no MyInvocation path) or from a file.
    $selfPath = $PSCommandPath
    if (-not $selfPath -or -not (Test-Path -LiteralPath $selfPath)) {
        $selfPath = Join-Path $env:TEMP ("winforge-web-install-{0}.ps1" -f ([guid]::NewGuid().ToString('N')))
        if ($MyInvocation.MyCommand.ScriptBlock) {
            $MyInvocation.MyCommand.ScriptBlock.ToString() | Set-Content -LiteralPath $selfPath -Encoding UTF8
        } else {
            # Downloaded-and-piped case: fetch a fresh copy for the elevated run.
            try {
                Invoke-RestMethod "https://codingmachineedge.github.io/$Repo/install.ps1" -OutFile $selfPath
            } catch {
                Fail "Could not stage the installer for elevation: $($_.Exception.Message)"
            }
        }
    }

    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$selfPath`"", '-Elevated'
    )
    if ($WhatIfRun) { $argList += '-WhatIfRun' }

    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -PassThru
        Write-Ok "Elevated process started (PID $($proc.Id)). This window can be closed."
        exit 0
    } catch {
        Fail "Elevation was cancelled or failed. Re-run PowerShell as Administrator and try again.`n     ($($_.Exception.Message))"
    }
}

if (Test-Admin) { Write-Ok "Running as Administrator." }

# ---------------------------------------------------------------------------
# 2. Find the latest release + asset
# ---------------------------------------------------------------------------
Write-Step "Querying latest release from GitHub..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'winforge-web-installer'; 'Accept' = 'application/vnd.github+json' }

try {
    $release = Invoke-RestMethod -Uri "$ApiBase/releases/latest" -Headers $headers
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) {
        Fail @"
No published release found yet for $Owner/$Repo.

The app is still in active development. In the meantime you can:
  • Watch the repo for the first release:  https://github.com/$Owner/$Repo/releases
  • Build from source:                     https://github.com/$Owner/$Repo/wiki/Build-from-Source
"@
    }
    Fail "GitHub API request failed: $($_.Exception.Message)"
}

$tag = $release.tag_name
Write-Ok "Latest release: $tag"

# Prefer a proper installer; fall back to portable zip.
$assets = @($release.assets)
if (-not $assets -or $assets.Count -eq 0) { Fail "Release '$tag' has no downloadable assets." }

$asset =
    ($assets | Where-Object { $_.name -match '(?i)setup.*\.exe$' }              | Select-Object -First 1)
if (-not $asset) { $asset = $assets | Where-Object { $_.name -match '(?i)\.msi$' }      | Select-Object -First 1 }
if (-not $asset) { $asset = $assets | Where-Object { $_.name -match '(?i)\.exe$' }      | Select-Object -First 1 }
if (-not $asset) { $asset = $assets | Where-Object { $_.name -match '(?i)portable.*\.zip$' } | Select-Object -First 1 }
if (-not $asset) { $asset = $assets | Where-Object { $_.name -match '(?i)\.zip$' }      | Select-Object -First 1 }
if (-not $asset) { Fail "No installer (.exe/.msi) or portable (.zip) asset in release '$tag'." }

Write-Ok "Selected asset: $($asset.name)  ($([math]::Round($asset.size/1MB,1)) MB)"

# ---------------------------------------------------------------------------
# 3. Download
# ---------------------------------------------------------------------------
$dest = Join-Path $env:TEMP $asset.name
Write-Step "Downloading to $dest ..."
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers @{ 'User-Agent' = 'winforge-web-installer' }
} catch {
    Fail "Download failed: $($_.Exception.Message)"
}
Write-Ok "Downloaded $([math]::Round((Get-Item $dest).Length/1MB,1)) MB."

# ---------------------------------------------------------------------------
# 4. Run / unpack
# ---------------------------------------------------------------------------
if ($WhatIfRun) {
    Write-WarnMsg "WhatIfRun set — skipping execution. Asset is at: $dest"
    exit 0
}

Write-Step "Launching installer..."
try {
    if ($dest -match '(?i)\.zip$') {
        $outDir = Join-Path $env:LOCALAPPDATA 'WinForgeWeb'
        Write-Step "Extracting portable build to $outDir ..."
        Expand-Archive -LiteralPath $dest -DestinationPath $outDir -Force
        $exe = Get-ChildItem -LiteralPath $outDir -Recurse -Filter '*.exe' |
               Where-Object { $_.Name -match '(?i)winforge' } | Select-Object -First 1
        if ($exe) { Write-Ok "Portable build ready. Launching $($exe.Name)..."; Start-Process -FilePath $exe.FullName }
        else      { Write-Ok "Portable build extracted to $outDir." }
    }
    elseif ($dest -match '(?i)\.msi$') {
        Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$dest`"") -Wait
    }
    else {
        Start-Process -FilePath $dest -Wait
    }
} catch {
    Fail "Installer failed to launch: $($_.Exception.Message)"
}

Write-Host ""
Write-Ok "WinForge Web installation started. Follow the setup window to finish."
Write-Host ""
if (-not $Elevated) { Read-Host "Press Enter to close" | Out-Null }
