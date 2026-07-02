// The real install work. Emits `install-progress` events per step so the UI can
// animate a live per-dependency progress list. Designed to be one-click and prompt-free
// by defaulting to a per-user install location (no UAC needed); elevation is only
// requested if the chosen location requires it.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
pub struct Progress {
    pub step: String,
    pub status: String, // pending | working | done | skipped | failed
    pub detail: String,
}

#[derive(Serialize)]
pub struct InstallReport {
    pub ok: bool,
    pub install_dir: String,
    pub exe_path: String,
}

#[derive(Deserialize)]
pub struct InstallConfig {
    pub dir: String,
    #[serde(rename = "buildFromSource")]
    pub build_from_source: bool,
}

fn ps(script: &str) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output()
}

fn emit(app: &AppHandle, step: &str, status: &str, detail: &str) {
    let _ = app.emit(
        "install-progress",
        Progress { step: step.into(), status: status.into(), detail: detail.into() },
    );
}

/// Is the current process elevated (running as administrator)?
#[tauri::command]
pub fn is_elevated() -> bool {
    ps("[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)")
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Sensible default per-user install location (no admin required).
#[tauri::command]
pub fn default_install_dir() -> String {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("WinForgeWeb").display().to_string()
}

/// True if writing to `dir` needs elevation (e.g. Program Files).
#[tauri::command]
pub fn needs_elevation(dir: String) -> bool {
    let lower = dir.to_lowercase();
    lower.contains("program files") || lower.starts_with("c:\\windows")
}

/// Relaunch this installer elevated (triggers a single UAC prompt), preserving argv.
#[tauri::command]
pub fn elevate_relaunch(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    ps(&format!("Start-Process -FilePath '{}' -Verb RunAs", exe.display()))
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

fn webview2_present() -> bool {
    let key = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for hive in ["HKLM\\SOFTWARE\\WOW6432Node", "HKCU\\SOFTWARE"] {
        if let Ok(out) = ps(&format!(
            "reg query \"{hive}\\Microsoft\\EdgeUpdate\\Clients\\{key}\" /v pv"
        )) {
            if out.status.success() {
                return true;
            }
        }
    }
    false
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Run the full install, emitting progress for each step.
#[tauri::command]
pub async fn run_install(app: AppHandle, config: InstallConfig) -> Result<InstallReport, String> {
    let dir = PathBuf::from(&config.dir);
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let payload = res_dir.join("payload");

    for step in ["app", "webview2", "vcredist", "tools", "shortcut"] {
        emit(&app, step, "pending", "");
    }

    // 1. App files
    emit(&app, "app", "working", "");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    if payload.exists() {
        copy_dir(&payload, &dir).map_err(|e| format!("copy payload: {e}"))?;
    }
    let exe = dir.join("winforge-web.exe");
    emit(&app, "app", "done", &exe.display().to_string());

    // 2. WebView2 (Microsoft binary — smallest official redistributable, cannot build from source)
    emit(&app, "webview2", "working", "");
    if webview2_present() {
        emit(&app, "webview2", "skipped", "already installed");
    } else {
        let boot = res_dir.join("webview2").join("MicrosoftEdgeWebview2Setup.exe");
        if boot.exists() {
            let mut c = Command::new(&boot);
            c.args(["/silent", "/install"]);
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            let _ = c.status();
            emit(&app, "webview2", "done", "installed (bootstrapper)");
        } else {
            emit(&app, "webview2", "failed", "bootstrapper missing");
        }
    }

    // 3. VC++ redist — not needed: the app statically links the CRT.
    emit(&app, "vcredist", "skipped", "static CRT — no redistributable required");

    // 4. Module tools — resolved lazily by the app (build-from-source → winget → choco).
    emit(&app, "tools", "working", "");
    let has_winget = which("winget");
    let has_choco = which("choco");
    let mode = if config.build_from_source { "build-from-source" } else { "prebuilt" };
    emit(
        &app,
        "tools",
        "done",
        &format!(
            "resolved on demand ({mode}; winget:{}, choco:{})",
            if has_winget { "yes" } else { "no" },
            if has_choco { "yes" } else { "no" }
        ),
    );

    // 5. Start-menu shortcut
    emit(&app, "shortcut", "working", "");
    let lnk = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\WinForge Web.lnk\"); $s.TargetPath='{}'; $s.Save()",
        exe.display()
    );
    match ps(&lnk) {
        Ok(o) if o.status.success() => emit(&app, "shortcut", "done", ""),
        _ => emit(&app, "shortcut", "skipped", "could not create shortcut"),
    }

    Ok(InstallReport { ok: true, install_dir: dir.display().to_string(), exe_path: exe.display().to_string() })
}

fn which(name: &str) -> bool {
    let mut c = Command::new("where");
    c.arg(name);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Launch the freshly installed app and close the installer.
#[tauri::command]
pub fn launch_app(app: AppHandle, exe_path: String) -> Result<(), String> {
    let mut c = Command::new(&exe_path);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
