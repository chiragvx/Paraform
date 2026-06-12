use std::path::PathBuf;
use std::sync::Mutex;

use tauri::async_runtime::spawn_blocking;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

// Where the spawned b123d sidecar's child handle lives. We grab it back at
// shutdown so the Python process doesn't outlive the window.
struct SidecarChild(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarChild(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Best-effort sidecar boot. If the PyInstaller binary isn't
            // present yet (fresh checkout, dev iteration before phase 2 was
            // built), log and continue — the frontend falls back to mock
            // mode in that case.
            if let Err(e) = spawn_b123d_sidecar(app.handle()) {
                log::warn!("[paraform] b123d sidecar unavailable: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app);
            }
        });
}

fn spawn_b123d_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    // Try the bundled sidecar first (tauri-plugin-shell knows where it
    // landed for the current target). If that fails, fall back to a
    // dev-mode binary at src-tauri/binaries/b123d_server-<triple>(.exe).
    let port = "7823";
    let mut last_err = String::new();

    // Path 1: registered externalBin sidecar via the plugin.
    match app.shell().sidecar("b123d_server") {
        Ok(cmd) => {
            match cmd.args([port]).spawn() {
                Ok((_rx, child)) => {
                    store_child(app, child);
                    log::info!("[paraform] b123d sidecar spawned on :{port}");
                    return Ok(());
                }
                Err(e) => last_err = format!("sidecar spawn failed: {e}"),
            }
        }
        Err(e) => last_err = format!("sidecar lookup failed: {e}"),
    }

    // Path 2: dev fallback — direct exec of the file under src-tauri/binaries/.
    if let Some(binary) = dev_sidecar_path(app) {
        if binary.exists() {
            let cmd = app.shell().command(binary.to_string_lossy().to_string());
            match cmd.args([port]).spawn() {
                Ok((_rx, child)) => {
                    store_child(app, child);
                    log::info!("[paraform] b123d dev-sidecar spawned on :{port}");
                    return Ok(());
                }
                Err(e) => last_err = format!("dev-sidecar spawn failed: {e}"),
            }
        }
    }

    Err(last_err)
}

fn dev_sidecar_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let triple = current_target_triple();
    let name = if cfg!(windows) {
        format!("b123d_server-{triple}.exe")
    } else {
        format!("b123d_server-{triple}")
    };
    app.path()
        .resolve(format!("binaries/{name}"), BaseDirectory::Resource)
        .ok()
}

fn current_target_triple() -> &'static str {
    // Resolved at compile time by build.rs; matches Rust's target triple
    // naming Tauri uses for externalBin sidecar discovery.
    env!("PARAFORM_TARGET_TRIPLE")
}

fn store_child(app: &tauri::AppHandle, child: CommandChild) {
    if let Some(state) = app.try_state::<SidecarChild>() {
        let mut slot = state.0.lock().unwrap();
        *slot = Some(child);
    }
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarChild>() {
        let mut slot = state.0.lock().unwrap();
        if let Some(child) = slot.take() {
            // Killing can block briefly; do it on a worker thread.
            spawn_blocking(move || {
                let _ = child.kill();
            });
        }
    }
}
