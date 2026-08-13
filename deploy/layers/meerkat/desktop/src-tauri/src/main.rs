mod proc;
mod secrets;

use std::path::PathBuf;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let payload_dir = std::env::var("MEERKAT_PAYLOAD_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("../payload"));
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("./data"));

            let launched = secrets::load_or_create(&data_dir).and_then(|secrets| {
                let node = proc::resolve_node(&payload_dir).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("node runtime not found under {}", payload_dir.display()),
                    )
                })?;
                proc::spawn_stack(&node, &payload_dir, &data_dir, &secrets)
            });

            match launched {
                Ok(stack) => {
                    let ports = proc::Ports {
                        classifier: stack.classifier_port,
                        core: stack.core_port,
                        web_ui: stack.web_ui_port,
                    };
                    app.manage(proc::StackGuard::new(stack));
                    app.manage(ports);
                    let handle = app.handle().clone();
                    std::thread::spawn(move || proc::health_poll(handle, ports));
                }
                Err(err) => {
                    eprintln!("meerkat stack spawn failed: {err}");
                    app.manage(proc::StackGuard::empty());
                    app.manage(proc::Ports {
                        classifier: 0,
                        core: 0,
                        web_ui: 0,
                    });
                    let _ = app.emit(
                        "stack-status",
                        proc::StackStatus {
                            classifier: false,
                            core: false,
                            web_ui: false,
                        },
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
                if let Some(guard) = app.try_state::<proc::StackGuard>() {
                    guard.kill_all();
                }
            }
        });
}
