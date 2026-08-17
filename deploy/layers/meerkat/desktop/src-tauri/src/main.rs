#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod proc;
mod sandbox;
mod secrets;

use std::path::PathBuf;
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn ports(state: State<'_, proc::PortsState>) -> Result<proc::Ports, String> {
    state.0.lock().map(|p| *p).map_err(|e| e.to_string())
}

#[tauri::command]
fn retry(app: tauri::AppHandle) -> Result<(), String> {
    proc::retry(&app)
}

#[tauri::command]
fn diagnostics(boot: State<'_, proc::Boot>) -> String {
    proc::diagnostics(&boot.data_dir)
}

#[tauri::command]
fn portal_token(ctx: State<'_, proc::StackCtx>) -> String {
    auth::mint_portal_identity(&ctx.secrets.portal_identity_secret)
}

#[tauri::command]
fn restart_core(app: tauri::AppHandle) -> Result<(), String> {
    proc::restart_core(&app)
}

#[tauri::command]
fn wsl2_status(boot: State<'_, proc::Boot>) -> sandbox::SandboxStatus {
    sandbox::status(&boot.data_dir, &boot.payload_dir)
}

#[tauri::command]
fn enable_wsl2(boot: State<'_, proc::Boot>) -> Result<(), String> {
    sandbox::enable_wsl2(&boot.data_dir)
}

#[tauri::command]
fn status(state: State<'_, proc::PortsState>) -> Result<Vec<String>, String> {
    let ports = state.0.lock().map_err(|e| e.to_string())?;
    Ok(proc::live_status(*ports))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ports,
            status,
            retry,
            diagnostics,
            portal_token,
            restart_core,
            wsl2_status,
            enable_wsl2
        ])
        .setup(|app| {
            let payload_dir = std::env::var("MEERKAT_PAYLOAD_DIR")
                .map(PathBuf::from)
                .or_else(|_| {
                    let exe = std::env::current_exe()?;
                    let beside_exe = exe.parent().unwrap_or(&exe).join("payload");
                    if beside_exe.is_dir() {
                        Ok(beside_exe)
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "no payload beside exe",
                        ))
                    }
                })
                .unwrap_or_else(|_| PathBuf::from("../payload"));
            let payload_dir = std::path::absolute(&payload_dir).unwrap_or(payload_dir);
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("./data"));

            app.manage(proc::Boot {
                payload_dir: payload_dir.clone(),
                data_dir: data_dir.clone(),
            });

            let ctx_result = secrets::load_or_create(&data_dir).and_then(|secrets| {
                let node = proc::resolve_node(&payload_dir).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("node runtime not found under {}", payload_dir.display()),
                    )
                })?;
                Ok(proc::StackCtx {
                    node,
                    payload_dir: payload_dir.clone(),
                    data_dir: data_dir.clone(),
                    secrets,
                })
            });

            let fatal = |app: &tauri::App, reason: String| {
                app.manage(proc::shared_stack(None));
                app.manage(proc::PortsState(std::sync::Mutex::new(proc::Ports {
                    classifier: 0,
                    core: 0,
                    web_ui: 0,
                })));
                let _ = app.emit(
                    "component-failed",
                    serde_json::json!({
                        "component": "core",
                        "severity": "fatal",
                        "reason": reason,
                    }),
                );
            };

            match ctx_result {
                Ok(ctx) => {
                    app.manage(ctx.clone());
                    match proc::spawn_stack(&ctx) {
                        Ok(stack) => {
                            let ports = proc::Ports {
                                classifier: stack.classifier_port,
                                core: stack.core_port,
                                web_ui: stack.web_ui_port,
                            };
                            let shared = proc::shared_stack(Some(stack));
                            app.manage(shared.clone());
                            app.manage(proc::PortsState(std::sync::Mutex::new(ports)));
                            let handle = app.handle().clone();
                            std::thread::spawn(move || {
                                proc::health_poll(handle, shared, ctx, ports)
                            });
                        }
                        Err(err) => {
                            eprintln!("meerkat stack spawn failed: {err}");
                            fatal(app, err.to_string());
                        }
                    }
                }
                Err(err) => {
                    eprintln!("meerkat stack prepare failed: {err}");
                    fatal(app, err.to_string());
                }
            }

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Meerkat")
                .inner_size(1200.0, 800.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(shared) = app.try_state::<proc::SharedStack>() {
                    proc::kill_all(&shared);
                }
            }
        });
}
