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
