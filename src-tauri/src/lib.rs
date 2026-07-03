mod commands;
mod ops;
mod awake;

use tauri::Emitter;
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // winforge:// deep links (feature #34). We keep the JS side dependency-free:
            // rather than have the frontend call the deep-link plugin's JS API, the Rust
            // side listens for opened URLs and re-emits them to the webview as a plain
            // "deep-link" event. src/state/deepLink.ts listens via @tauri-apps/api/event
            // (already a dependency), so no new npm package is required.
            #[cfg(desktop)]
            {
                // Register the winforge scheme at runtime (needed for dev / portable runs;
                // the installer also registers it from tauri.conf.json). Non-fatal if the
                // OS refuses (e.g. already registered by another install).
                let _ = app.deep_link().register("winforge");

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        // Emit each URL individually so the frontend parser handles one at
                        // a time. Event name "deep-link" is the contract with deepLink.ts.
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::run_command,
            commands::run_powershell,
            commands::system_info,
            commands::list_dir,
            commands::get_env,
            commands::resolve_tool,
            commands::resource_bin_dir,
            ops::run_op,
            awake::awake_set,
            awake::awake_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WinForge Web");
}
