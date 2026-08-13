mod auth;
mod proc;
mod secrets;

use std::path::PathBuf;
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn ports(state: State<'_, proc::Ports>) -> proc::Ports {
    *state
}

#[tauri::command]
fn retry(
    shared: State<'_, proc::SharedStack>,
    ctx: State<'_, proc::StackCtx>,
) -> Result<(), String> {
    proc::retry(&shared, &ctx)
}

#[tauri::command]
fn diagnostics(ctx: State<'_, proc::StackCtx>) -> String {
    proc::diagnostics(&ctx.data_dir)
}

#[tauri::command]
fn portal_token(ctx: State<'_, proc::StackCtx>) -> String {
    auth::mint_portal_identity(&ctx.secrets.portal_identity_secret)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ports,
            retry,
            diagnostics,
            portal_token
        ])
        .setup(|app| {
            let payload_dir = std::env::var("MEERKAT_PAYLOAD_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("../payload"));
            let payload_dir = std::path::absolute(&payload_dir).unwrap_or(payload_dir);
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("./data"));

            let prepared = secrets::load_or_create(&data_dir).and_then(|secrets| {
                let node = proc::resolve_node(&payload_dir).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("node runtime not found under {}", payload_dir.display()),
                    )
                })?;
                let ctx = proc::StackCtx {
                    node,
                    payload_dir: payload_dir.clone(),
                    data_dir: data_dir.clone(),
                    secrets,
                };
                proc::spawn_stack(&ctx).map(|stack| (ctx, stack))
            });

            match prepared {
                Ok((ctx, stack)) => {
                    let ports = proc::Ports {
                        classifier: stack.classifier_port,
                        core: stack.core_port,
                        web_ui: stack.web_ui_port,
                    };
                    let shared = proc::shared_stack(Some(stack));
                    app.manage(shared.clone());
                    app.manage(ctx.clone());
                    app.manage(ports);
                    let handle = app.handle().clone();
                    std::thread::spawn(move || proc::health_poll(handle, shared, ctx, ports));
                }
                Err(err) => {
                    eprintln!("meerkat stack spawn failed: {err}");
                    let reason = err.to_string();
                    let ctx = proc::StackCtx {
                        node: PathBuf::new(),
                        payload_dir: payload_dir.clone(),
                        data_dir: data_dir.clone(),
                        secrets: secrets::Secrets {
                            capability_secret: String::new(),
                            connector_secret_key: String::new(),
                            core_signing_secret: String::new(),
                            portal_identity_secret: String::new(),
                            skill_signing_secret: String::new(),
                        },
                    };
                    app.manage(proc::shared_stack(None));
                    app.manage(ctx);
                    app.manage(proc::Ports {
                        classifier: 0,
                        core: 0,
                        web_ui: 0,
                    });
                    let _ = app.emit(
                        "component-failed",
                        serde_json::json!({
                            "component": "core",
                            "severity": "fatal",
                            "reason": reason,
                        }),
                    );
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
