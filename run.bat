@echo off
setlocal enabledelayedexpansion
title WinForge Web — One-Click Build & Run

cd /d "%~dp0"

echo ============================================
echo   WinForge Web — One-Click Build ^& Run
echo ============================================
echo.

:: ── Check Node.js ──────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo         Download from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js  %%v

where npm.cmd >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm is not available.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm.cmd -v') do echo [OK] npm      v%%v
echo.

:: ── Check Rust ─────────────────────────────────────────────────
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust / Cargo is not installed or not on PATH.
    echo         Install from https://rustup.rs
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('rustc -V') do echo [OK] %%v
echo.

:: ── Install npm dependencies (if needed) ───────────────────────
if not exist "node_modules\" (
    echo [INFO] Installing npm dependencies...
    call npm.cmd install
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
) else (
    echo [OK] node_modules already present
)
echo.

:: ── Run ────────────────────────────────────────────────────────
echo [INFO] Starting WinForge Web...
echo        The app window will open shortly.
echo.

call npm.cmd run tauri:dev
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] Tauri dev failed. Check the output above.
    pause
    exit /b 1
)
