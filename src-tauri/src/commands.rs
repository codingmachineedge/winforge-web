// Native backend commands. These are what let "native-only" WinForge modules do real
// work on the desktop instead of being inert stubs: a generic command runner, a
// PowerShell runner (the workhorse for Windows system modules), system info, and a
// directory lister.
use serde::Serialize;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub success: bool,
}

fn run(mut cmd: Command) -> Result<CommandOutput, String> {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        code: out.status.code().unwrap_or(-1),
        success: out.status.success(),
    })
}

/// Run an arbitrary program with args and capture its output.
#[tauri::command]
pub fn run_command(program: String, args: Vec<String>) -> Result<CommandOutput, String> {
    if program.trim().is_empty() {
        return Err("program is empty".into());
    }
    // Defense-in-depth (feature #33): reject a narrow, precise set of catastrophic
    // invocations (format, cipher /w, bcdedit, diskpart, recursive delete of a drive
    // root / %SystemRoot%, reg delete of a hive root). This does NOT change the
    // signature or behaviour for the ~100+ legitimate module commands — see the
    // extensive "allows normal commands" tests in ops.rs.
    if let Some(reason) = crate::ops::denylist_reason(&program, &args) {
        return Err(reason);
    }
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    run(cmd)
}

/// Run a PowerShell script and capture output. The workhorse for Windows modules
/// (services, startup apps, environment variables, network, etc.).
#[tauri::command]
pub fn run_powershell(script: String) -> Result<CommandOutput, String> {
    if script.trim().is_empty() {
        return Err("script is empty".into());
    }
    let shell = if cfg!(windows) { "powershell" } else { "pwsh" };
    let mut cmd = Command::new(shell);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ]);
    run(cmd)
}

#[derive(Serialize)]
pub struct SysInfo {
    pub os: String,
    pub arch: String,
    pub family: String,
    pub hostname: String,
    pub cpus: usize,
    pub exe: String,
}

/// Basic system information (extended by the frontend via run_powershell where needed).
#[tauri::command]
pub fn system_info() -> SysInfo {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    SysInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        hostname,
        cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        exe: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// List a directory. Powers file-oriented modules without a backend server.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().display().to_string(),
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Read an environment variable (or return empty). Used by the Environment Variables module.
#[tauri::command]
pub fn get_env(name: String) -> String {
    std::env::var(&name).unwrap_or_default()
}

use tauri::Manager;

#[derive(Serialize)]
pub struct ToolResolution {
    pub name: String,
    /// Full path if found, else null.
    pub path: Option<String>,
    /// "bundled" (shipped in resources/bin), "path" (found on PATH), or "missing".
    pub source: String,
}

fn on_path(name: &str) -> Option<String> {
    let mut cmd = Command::new("where");
    cmd.arg(name);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Resolve a CLI tool: bundled `resources/bin/<name>.exe` first, then PATH.
/// This is what lets modules use a vendored copy before asking to install anything.
#[tauri::command]
pub fn resolve_tool(app: tauri::AppHandle, name: String) -> ToolResolution {
    if let Ok(res_dir) = app.path().resource_dir() {
        for cand in [
            res_dir.join("bin").join(format!("{name}.exe")),
            res_dir.join("bin").join(&name),
        ] {
            if cand.exists() {
                return ToolResolution {
                    name,
                    path: Some(cand.display().to_string()),
                    source: "bundled".into(),
                };
            }
        }
    }
    if let Some(p) = on_path(&name) {
        return ToolResolution { name, path: Some(p), source: "path".into() };
    }
    ToolResolution { name, path: None, source: "missing".into() }
}

/// Absolute path of the bundled `resources/bin` directory (may not exist in dev).
#[tauri::command]
pub fn resource_bin_dir(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("bin").display().to_string())
}
