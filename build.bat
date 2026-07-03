@echo off
setlocal enabledelayedexpansion
title WinForge Web — Production Build

cd /d "%~dp0"

echo ============================================
echo   WinForge Web — Production Build
echo   (Creates NSIS and MSI installers)
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
where npm.cmd >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm is not available.
    pause
    exit /b 1
)

:: ── Check Rust ─────────────────────────────────────────────────
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust / Cargo is not installed or not on PATH.
    echo         Install from https://rustup.rs
    pause
    exit /b 1
)

:: ── Install deps if needed ─────────────────────────────────────
if not exist "node_modules\" (
    echo [INFO] Installing npm dependencies...
    call npm.cmd install
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo [INFO] Building WinForge Web (this may take a while)...
echo.

call npm.cmd run tauri:build
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] Build failed. Check the output above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build complete!
echo   Installers are in:
echo     src-tauri\target\release\bundle\
echo ============================================
echo.
dir /b "src-tauri\target\release\bundle\*.exe" "src-tauri\target\release\bundle\*.msi" 2>nul
echo.
echo Press any key to exit.
pause >nul
