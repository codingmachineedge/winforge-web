@echo off
setlocal enabledelayedexpansion
title WinForge Web

cd /d "%~dp0"

echo =============================================
echo   WinForge Web
echo =============================================
echo.

:: ── Check Node.js ───────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js  %%v

where npm.cmd >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm not available.
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('npm.cmd -v') do echo [OK] npm      v%%v

:: ── Check Rust ──────────────────────────────────────────────
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust/Cargo not found. Install from https://rustup.rs
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('rustc -V') do echo [OK] %%v
echo.

:: ── Install npm deps if needed ────────────────────────────
if not exist "node_modules\" (
    echo [INFO] Installing npm dependencies...
    call npm.cmd install
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed.
        pause & exit /b 1
    )
) else (
    echo [OK] node_modules present
)
echo.

:: ── Menu ───────────────────────────────────────────────────
echo Choose mode:
echo   [1] Dev run ^(hot reload, opens app window^)
echo   [2] Production build ^(creates installer .exe/.msi^)
echo   [3] Dev run + auto-rebuild on changes
echo.
set /p choice="Enter 1, 2, or 3: "

if "%choice%"=="1" goto dev
if "%choice%"=="2" goto build
if "%choice%"=="3" goto dev
echo Invalid choice. Exiting.
pause & exit /b 1

:: ── Dev run ────────────────────────────────────────────────
:dev
echo.
echo [INFO] Starting dev mode...
call npm.cmd run tauri:dev
if !errorlevel! neq 0 (
    echo [ERROR] Tauri dev failed.
    pause & exit /b 1
)
exit /b 0

:: ── Production build ───────────────────────────────────────
:build
echo.
echo [INFO] Building installers (NSIS + MSI)...
echo        This may take several minutes.
echo.
call npm.cmd run tauri:build
if !errorlevel! neq 0 (
    echo [ERROR] Tauri build failed.
    pause & exit /b 1
)

echo.
echo =============================================
echo   Build complete!
echo   Installers:
echo =============================================
dir /b "src-tauri\target\release\bundle\*.exe" "src-tauri\target\release\bundle\*.msi" 2>nul
echo.
pause
exit /b 0
