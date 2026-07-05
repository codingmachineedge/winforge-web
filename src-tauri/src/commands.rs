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

// ---------------------------------------------------------------------------
// File Browser backend (module.filebrowser): fast native directory listing with
// Windows attributes + timestamps, plus the small set of mutating file ops the
// UI offers. Recycle-bin delete stays in the frontend via run_powershell
// (Microsoft.VisualBasic FileIO → SHFileOperation with FOF_ALLOWUNDO), matching
// the FileLocksmith in-process-.NET pattern — no separate helper process.

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub readonly: bool,
    pub hidden: bool,
    pub ext: String,
}

#[derive(Serialize)]
pub struct FsListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
}

/// Hard cap per listing so a directory with hundreds of thousands of files
/// can't stall the IPC bridge; the UI shows a "truncated" note past this.
const FS_LIST_CAP: usize = 5000;

#[tauri::command]
pub fn fs_list(path: String, show_hidden: bool) -> Result<FsListing, String> {
    let dir = std::path::Path::new(&path);
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        if entries.len() >= FS_LIST_CAP {
            truncated = true;
            break;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // unreadable entry (broken reparse point etc.)
        };
        #[cfg(windows)]
        let attrs = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes()
        };
        #[cfg(not(windows))]
        let attrs = 0u32;
        let hidden = attrs & 0x2 != 0; // FILE_ATTRIBUTE_HIDDEN
        if hidden && !show_hidden {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let ext = if is_dir {
            String::new()
        } else {
            std::path::Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        entries.push(FsEntry {
            path: entry.path().display().to_string(),
            name,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified_ms,
            readonly: attrs & 0x1 != 0 || meta.permissions().readonly(), // FILE_ATTRIBUTE_READONLY
            hidden,
            ext,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let parent = dir
        .parent()
        .map(|p| p.display().to_string())
        .filter(|p| !p.is_empty());
    Ok(FsListing {
        path: dir.display().to_string(),
        parent,
        entries,
        truncated,
    })
}

/// Refuse mutating operations on a bare drive root ("C:\", "D:") — the same
/// spirit as ops::denylist_reason, applied to the typed fs commands.
fn deny_fs_root(p: &str) -> Result<(), String> {
    let t = p.trim().trim_end_matches(['\\', '/']);
    if t.len() <= 2 {
        return Err("refusing to operate on a drive root".into());
    }
    Ok(())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    deny_fs_root(&from)?;
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

fn copy_recursive(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    if from.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    let from_dir = format!("{}\\", from.trim_end_matches(['\\', '/']));
    if to.starts_with(&from_dir) {
        return Err("cannot copy a folder into itself".into());
    }
    copy_recursive(std::path::Path::new(&from), std::path::Path::new(&to))
}

#[tauri::command]
pub fn fs_move(from: String, to: String) -> Result<(), String> {
    deny_fs_root(&from)?;
    let from_dir = format!("{}\\", from.trim_end_matches(['\\', '/']));
    if to.starts_with(&from_dir) {
        return Err("cannot move a folder into itself".into());
    }
    // Same-volume: a rename is atomic and instant. Cross-volume: copy then delete.
    if std::fs::rename(&from, &to).is_ok() {
        return Ok(());
    }
    copy_recursive(std::path::Path::new(&from), std::path::Path::new(&to))?;
    let p = std::path::Path::new(&from);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Permanent delete (bypasses the Recycle Bin) — the UI double-confirms first.
#[tauri::command]
pub fn fs_delete_permanent(path: String) -> Result<(), String> {
    deny_fs_root(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Bounded text read for the preview pane (lossy UTF-8; caller caps the bytes).
#[tauri::command]
pub fn fs_read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let cap = max_bytes.unwrap_or(262_144) as usize;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let end = data.len().min(cap);
    Ok(String::from_utf8_lossy(&data[..end]).to_string())
}
