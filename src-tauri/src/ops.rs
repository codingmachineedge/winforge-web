// Allowlist wrapper (feature #33): a vetted, parameter-validated operation enum.
//
// Unlike the generic `run_command`, every variant here maps to a FIXED program +
// argv. Any caller-supplied parameter is validated against a strict regex-style
// character allowlist and only slotted into a vetted argv position — there is no
// shell string interpolation anywhere, so injection is structurally impossible.
//
// This is additive hardening: `run_command`/`run_powershell` stay registered and
// unchanged. `run_op` is offered as the safe path for the common, well-known
// Windows housekeeping operations.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A vetted operation. Tagged by `op` (snake_case) so the JSON payload looks like
/// `{ "op": "open_settings_page", "page": "windowsupdate" }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum VettedOp {
    /// Restart the Explorer shell (kills explorer.exe; Windows auto-relaunches it).
    RestartExplorer,
    /// Open a specific ms-settings: page. `page` must be a valid settings id.
    OpenSettingsPage { page: String },
    /// Empty the Recycle Bin for all drives (no confirmation prompt).
    EmptyRecycleBin,
    /// Flush the DNS resolver cache.
    FlushDns,
    /// Release and renew all DHCP leases would be disruptive; instead show config.
    IpConfig,
    /// Display the ARP table.
    ArpTable,
    /// Open a well-known Explorer shell folder (Downloads, Documents, etc.).
    OpenKnownFolder { folder: String },
    /// Toggle the clipboard history / show clipboard settings page (safe: settings).
    ClipboardSettings,
    /// Restart the print spooler service (stop then start).
    RestartPrintSpooler,
    /// Re-register / rebuild the icon cache by clearing it and restarting Explorer.
    RebuildIconCache,
    /// Show the current power scheme (read-only diagnostic).
    PowerSchemeInfo,
    /// Open the Windows Update settings page (convenience alias).
    OpenWindowsUpdate,
}

/// Result of a vetted operation: stdout / stderr / exit code, plus the resolved
/// program + argv for transparency/audit on the frontend.
#[derive(Debug, Serialize)]
pub struct OpOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub success: bool,
    /// The fixed program that was executed (audit trail).
    pub program: String,
    /// The exact argv passed (audit trail).
    pub args: Vec<String>,
}

/// A resolved, ready-to-run invocation: a fixed program plus a vetted argv.
struct Invocation {
    program: &'static str,
    args: Vec<String>,
}

// ---------------------------------------------------------------------------
// Parameter validators. All are pure functions returning Result so they can be
// unit-tested without spawning any process.
// ---------------------------------------------------------------------------

/// Validate an ms-settings page id: lowercase letters, digits and dashes only,
/// 1..=64 chars. This matches the shape of real ms-settings ids like
/// `windowsupdate`, `network-status`, `bluetooth`. Rejects anything with a colon,
/// slash, space or other character that could smuggle a second URI/argument.
pub fn validate_settings_page(page: &str) -> Result<(), String> {
    if page.is_empty() || page.len() > 64 {
        return Err("settings page id must be 1..=64 chars".into());
    }
    if page
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        Ok(())
    } else {
        Err("settings page id must match [a-z0-9-]+".into())
    }
}

/// Validate a known-folder token against a fixed allowlist. We deliberately do NOT
/// accept an arbitrary path here — only a small set of shell folder names, each of
/// which we expand ourselves to a `shell:` verb. This keeps the surface tiny.
pub fn validate_known_folder(folder: &str) -> Result<&'static str, String> {
    match folder {
        "downloads" => Ok("Downloads"),
        "documents" => Ok("shell:Personal"),
        "desktop" => Ok("shell:Desktop"),
        "pictures" => Ok("shell:My Pictures"),
        "music" => Ok("shell:My Music"),
        "videos" => Ok("shell:My Video"),
        "startup" => Ok("shell:Startup"),
        "appdata" => Ok("shell:AppData"),
        "localappdata" => Ok("shell:Local AppData"),
        "temp" => Ok("shell:Local AppData\\Temp"),
        _ => Err(format!("unknown folder token: {folder}")),
    }
}

/// Resolve a VettedOp into a concrete (program, argv). Any validation failure is
/// surfaced as an Err before anything is executed.
fn resolve(op: &VettedOp) -> Result<Invocation, String> {
    Ok(match op {
        // taskkill /f /im explorer.exe — Windows relaunches the shell automatically.
        VettedOp::RestartExplorer => Invocation {
            program: "taskkill",
            args: vec!["/f".into(), "/im".into(), "explorer.exe".into()],
        },

        // start "" ms-settings:<page>  — but we avoid the shell `start` and instead
        // launch the URI protocol via `explorer.exe ms-settings:<page>`, which is the
        // documented way and takes exactly one argv (no shell parsing).
        VettedOp::OpenSettingsPage { page } => {
            validate_settings_page(page)?;
            Invocation {
                program: "explorer.exe",
                args: vec![format!("ms-settings:{page}")],
            }
        }

        // Clear-RecycleBin via PowerShell; -Force skips the confirmation. Fixed script,
        // no interpolation.
        VettedOp::EmptyRecycleBin => Invocation {
            program: "powershell",
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Clear-RecycleBin -Force -ErrorAction SilentlyContinue".into(),
            ],
        },

        VettedOp::FlushDns => Invocation {
            program: "ipconfig",
            args: vec!["/flushdns".into()],
        },

        VettedOp::IpConfig => Invocation {
            program: "ipconfig",
            args: vec!["/all".into()],
        },

        VettedOp::ArpTable => Invocation {
            program: "arp",
            args: vec!["-a".into()],
        },

        VettedOp::OpenKnownFolder { folder } => {
            let target = validate_known_folder(folder)?;
            Invocation {
                program: "explorer.exe",
                args: vec![target.to_string()],
            }
        }

        VettedOp::ClipboardSettings => Invocation {
            program: "explorer.exe",
            args: vec!["ms-settings:clipboard".into()],
        },

        // net stop/start is two invocations; we run them as a single fixed PowerShell
        // pipeline (Restart-Service) with no interpolation.
        VettedOp::RestartPrintSpooler => Invocation {
            program: "powershell",
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name Spooler -Force".into(),
            ],
        },

        // Rebuild icon cache: delete iconcache db then restart explorer. Fixed script.
        VettedOp::RebuildIconCache => Invocation {
            program: "powershell",
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                // Only touches the per-user icon cache files under LocalAppData; never a
                // drive root. Explorer is restarted to repopulate them.
                "Remove-Item -Path \"$env:LocalAppData\\IconCache.db\" -Force -ErrorAction SilentlyContinue; \
                 Remove-Item -Path \"$env:LocalAppData\\Microsoft\\Windows\\Explorer\\iconcache_*.db\" -Force -ErrorAction SilentlyContinue; \
                 Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue"
                    .into(),
            ],
        },

        VettedOp::PowerSchemeInfo => Invocation {
            program: "powercfg",
            args: vec!["/getactivescheme".into()],
        },

        VettedOp::OpenWindowsUpdate => Invocation {
            program: "explorer.exe",
            args: vec!["ms-settings:windowsupdate".into()],
        },
    })
}

fn run_invocation(inv: Invocation) -> Result<OpOutput, String> {
    let mut cmd = Command::new(inv.program);
    cmd.args(&inv.args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(OpOutput {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        code: out.status.code().unwrap_or(-1),
        success: out.status.success(),
        program: inv.program.to_string(),
        args: inv.args,
    })
}

/// Run a vetted operation. Every variant maps to a fixed program + validated argv.
#[tauri::command]
pub fn run_op(op: VettedOp) -> Result<OpOutput, String> {
    let inv = resolve(&op)?;
    run_invocation(inv)
}

// ---------------------------------------------------------------------------
// Denylist guard for the LEGACY run_command. Defense-in-depth: reject a narrow,
// precise set of catastrophic invocations. Kept intentionally tight so real
// module commands are never false-positived.
// ---------------------------------------------------------------------------

/// Returns Some(reason) if the given program+args match a catastrophic pattern that
/// should be blocked outright, else None. Case-insensitive matching throughout.
pub fn denylist_reason(program: &str, args: &[String]) -> Option<String> {
    let prog = program.trim().trim_end_matches(".exe").to_ascii_lowercase();
    // Lowercased, joined args for substring / token checks.
    let args_lc: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let joined = args_lc.join(" ");

    // 1. `format` of a drive — the classic destroyer. Block the format.com program
    //    outright (it only exists to wipe volumes).
    if prog == "format" {
        return Some("blocked: 'format' wipes a volume".into());
    }

    // 2. `cipher /w` — securely overwrites free space (irreversible data destruction).
    if prog == "cipher" && args_lc.iter().any(|a| a == "/w" || a.starts_with("/w:")) {
        return Some("blocked: 'cipher /w' overwrites free disk space".into());
    }

    // 3. `bcdedit` — editing the boot configuration can render Windows unbootable.
    if prog == "bcdedit" {
        return Some("blocked: 'bcdedit' modifies boot configuration".into());
    }

    // 4. `diskpart` — scriptable partition/volume destruction.
    if prog == "diskpart" {
        return Some("blocked: 'diskpart' can destroy partitions".into());
    }

    // 5. Recursive/forced delete of a drive root or %SystemRoot% via rd/rmdir/del.
    if matches!(prog.as_str(), "rd" | "rmdir" | "del" | "erase") {
        let recursive = args_lc.iter().any(|a| a == "/s");
        if recursive && targets_protected_path(&args_lc) {
            return Some("blocked: recursive delete of a drive root or Windows dir".into());
        }
        // Even without /s, a bare `del C:\` style at a root is suspicious.
        if targets_bare_drive_root(&args_lc) {
            return Some("blocked: delete targeting a bare drive root".into());
        }
    }

    // 6. PowerShell Remove-Item -Recurse on a drive root or %SystemRoot%.
    if prog == "powershell" || prog == "pwsh" {
        let has_remove = joined.contains("remove-item") || joined.contains(" ri ") || joined.contains("rmdir");
        let recursive = joined.contains("-recurse") || joined.contains("-r ");
        if has_remove && recursive && ps_targets_protected(&joined) {
            return Some("blocked: Remove-Item -Recurse on a drive root or Windows dir".into());
        }
    }

    // 7. `reg delete HK...\ /f` at a hive root (deleting an entire hive).
    if prog == "reg" && args_lc.first().map(|a| a == "delete").unwrap_or(false) {
        let force = args_lc.iter().any(|a| a == "/f");
        if force {
            if let Some(key) = args_lc.get(1) {
                if is_hive_root(key) {
                    return Some("blocked: 'reg delete' of an entire hive root".into());
                }
            }
        }
    }

    None
}

/// True if any arg is a bare drive root like `c:\`, `d:/`, or `\`.
fn targets_bare_drive_root(args_lc: &[String]) -> bool {
    args_lc.iter().any(|a| is_drive_root(a))
}

/// True if any arg looks like a drive root or the Windows/system directory.
fn targets_protected_path(args_lc: &[String]) -> bool {
    args_lc.iter().any(|a| is_drive_root(a) || is_windows_dir(a))
}

fn is_drive_root(p: &str) -> bool {
    let p = p.trim_matches('"').trim();
    // `\` or `/` alone, or `X:\` / `X:/` / `X:` with nothing meaningful after.
    if p == "\\" || p == "/" {
        return true;
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = &p[2..];
        let rest = rest.trim_start_matches(['\\', '/']);
        return rest.is_empty();
    }
    false
}

fn is_windows_dir(p: &str) -> bool {
    let p = p.trim_matches('"').trim().to_ascii_lowercase().replace('/', "\\");
    // Match C:\Windows or C:\Windows\ exactly (not a subfolder — deleting the whole
    // Windows dir is catastrophic; a subfolder may be a legitimate cache clean).
    let trimmed = p.trim_end_matches('\\');
    trimmed.ends_with(":\\windows") || trimmed == "%systemroot%" || trimmed == "$env:systemroot"
}

fn ps_targets_protected(joined_lc: &str) -> bool {
    // Look for a drive-root or windows-dir token anywhere in the (already lowercased)
    // command. We scan whitespace/quote-separated tokens.
    joined_lc
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .any(|tok| is_drive_root(tok) || is_windows_dir(tok))
}

fn is_hive_root(key: &str) -> bool {
    let k = key.trim_matches('"').trim().to_ascii_uppercase().replace('/', "\\");
    let k = k.trim_end_matches('\\');
    matches!(
        k,
        "HKLM" | "HKEY_LOCAL_MACHINE"
            | "HKCU" | "HKEY_CURRENT_USER"
            | "HKCR" | "HKEY_CLASSES_ROOT"
            | "HKU" | "HKEY_USERS"
            | "HKCC" | "HKEY_CURRENT_CONFIG"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- validate_settings_page ----
    #[test]
    fn settings_page_accepts_valid_ids() {
        assert!(validate_settings_page("windowsupdate").is_ok());
        assert!(validate_settings_page("network-status").is_ok());
        assert!(validate_settings_page("bluetooth").is_ok());
        assert!(validate_settings_page("about").is_ok());
    }

    #[test]
    fn settings_page_rejects_injection() {
        assert!(validate_settings_page("").is_err());
        assert!(validate_settings_page("Windows Update").is_err()); // space + caps
        assert!(validate_settings_page("a:b").is_err()); // colon (second URI)
        assert!(validate_settings_page("../etc").is_err()); // path traversal chars
        assert!(validate_settings_page("page&calc").is_err()); // shell metachar
        assert!(validate_settings_page(&"x".repeat(65)).is_err()); // too long
    }

    // ---- validate_known_folder ----
    #[test]
    fn known_folder_allowlist() {
        assert_eq!(validate_known_folder("downloads").unwrap(), "Downloads");
        assert!(validate_known_folder("documents").is_ok());
        assert!(validate_known_folder("c:\\windows").is_err());
        assert!(validate_known_folder("../secret").is_err());
    }

    // ---- resolve wiring ----
    #[test]
    fn resolve_fixed_programs() {
        let inv = resolve(&VettedOp::FlushDns).unwrap();
        assert_eq!(inv.program, "ipconfig");
        assert_eq!(inv.args, vec!["/flushdns".to_string()]);

        let inv = resolve(&VettedOp::OpenSettingsPage { page: "bluetooth".into() }).unwrap();
        assert_eq!(inv.program, "explorer.exe");
        assert_eq!(inv.args, vec!["ms-settings:bluetooth".to_string()]);

        // Invalid page id must fail before any execution.
        assert!(resolve(&VettedOp::OpenSettingsPage { page: "a b".into() }).is_err());
    }

    // ---- denylist: catastrophic invocations blocked ----
    #[test]
    fn denylist_blocks_format() {
        assert!(denylist_reason("format", &["c:".into()]).is_some());
        assert!(denylist_reason("format.exe", &["/fs:ntfs".into(), "d:".into()]).is_some());
    }

    #[test]
    fn denylist_blocks_cipher_wipe() {
        assert!(denylist_reason("cipher", &["/w:c:\\".into()]).is_some());
        assert!(denylist_reason("cipher", &["/w".into()]).is_some());
        // cipher without /w (encryption status query) is fine.
        assert!(denylist_reason("cipher", &["/c".into(), "file.txt".into()]).is_none());
    }

    #[test]
    fn denylist_blocks_bcdedit_and_diskpart() {
        assert!(denylist_reason("bcdedit", &["/set".into()]).is_some());
        assert!(denylist_reason("diskpart", &[]).is_some());
    }

    #[test]
    fn denylist_blocks_recursive_root_delete() {
        assert!(denylist_reason("rd", &["/s".into(), "/q".into(), "c:\\".into()]).is_some());
        assert!(denylist_reason("rmdir", &["/s".into(), "\\".into()]).is_some());
        assert!(denylist_reason("del", &["c:\\".into()]).is_some());
        // deleting a real subfolder is allowed.
        assert!(denylist_reason("rd", &["/s".into(), "/q".into(), "c:\\temp\\build".into()]).is_none());
    }

    #[test]
    fn denylist_blocks_windows_dir_delete() {
        assert!(denylist_reason("rd", &["/s".into(), "c:\\windows".into()]).is_some());
        assert!(denylist_reason("rd", &["/s".into(), "c:\\windows\\".into()]).is_some());
        // a cache subfolder under Windows is NOT blocked (legitimate cleanup).
        assert!(denylist_reason("rd", &["/s".into(), "c:\\windows\\temp".into()]).is_none());
    }

    #[test]
    fn denylist_blocks_powershell_recurse_root() {
        assert!(denylist_reason(
            "powershell",
            &["-Command".into(), "Remove-Item -Recurse -Force C:\\".into()]
        )
        .is_some());
        assert!(denylist_reason(
            "powershell",
            &["-Command".into(), "Remove-Item -Recurse 'C:\\Windows'".into()]
        )
        .is_some());
        // scoped remove is fine.
        assert!(denylist_reason(
            "powershell",
            &["-Command".into(), "Remove-Item -Recurse C:\\Temp\\old".into()]
        )
        .is_none());
    }

    #[test]
    fn denylist_blocks_reg_hive_delete() {
        assert!(denylist_reason("reg", &["delete".into(), "HKLM".into(), "/f".into()]).is_some());
        assert!(denylist_reason(
            "reg",
            &["delete".into(), "HKEY_LOCAL_MACHINE\\".into(), "/f".into()]
        )
        .is_some());
        // deleting a specific subkey is allowed.
        assert!(denylist_reason(
            "reg",
            &["delete".into(), "HKLM\\Software\\Foo".into(), "/f".into()]
        )
        .is_none());
    }

    #[test]
    fn denylist_allows_normal_commands() {
        assert!(denylist_reason("ipconfig", &["/all".into()]).is_none());
        assert!(denylist_reason("powershell", &["-Command".into(), "Get-Process".into()]).is_none());
        assert!(denylist_reason("where", &["git".into()]).is_none());
        assert!(denylist_reason("reg", &["query".into(), "HKLM\\Software".into()]).is_none());
    }
}
