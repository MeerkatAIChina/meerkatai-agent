use crate::secrets::Secrets;
use serde::Serialize;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.local_addr().map(|addr| addr.port())
}

pub struct Stack {
    pub classifier: Child,
    pub core: Child,
    pub web_ui: Child,
    pub classifier_port: u16,
    pub core_port: u16,
    pub web_ui_port: u16,
}

pub struct StackGuard(pub Mutex<Option<Stack>>);

impl StackGuard {
    pub fn new(stack: Stack) -> Self {
        StackGuard(Mutex::new(Some(stack)))
    }

    pub fn empty() -> Self {
        StackGuard(Mutex::new(None))
    }

    pub fn kill_all(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(stack) = slot.as_mut() {
                let _ = stack.classifier.kill();
                let _ = stack.core.kill();
                let _ = stack.web_ui.kill();
            }
        }
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct Ports {
    pub classifier: u16,
    pub core: u16,
    pub web_ui: u16,
}

pub fn resolve_node(payload_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        payload_dir.join("node").join("node.exe"),
        payload_dir.join("node").join("node"),
        payload_dir.join("node").join("bin").join("node"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

pub fn spawn_stack(
    node_path: &Path,
    payload_dir: &Path,
    data_dir: &Path,
    secrets: &Secrets,
) -> io::Result<Stack> {
    let classifier_port = free_port()?;
    let core_port = free_port()?;
    let web_ui_port = free_port()?;

    let classifier = Command::new(node_path)
        .current_dir(payload_dir.join("classifier"))
        .args(["--import", "tsx", "src/server.ts"])
        .env("HOST", "127.0.0.1")
        .env("PORT", classifier_port.to_string())
        .env(
            "ROUTES_PATH",
            payload_dir.join("config").join("seeds").join("routes.json"),
        )
        .spawn()?;

    let core = Command::new(node_path)
        .current_dir(payload_dir.join("core"))
        .arg("src/index.ts")
        .env("NODE_ENV", "production")
        .env("HOST", "127.0.0.1")
        .env("PORT", core_port.to_string())
        .env("DATA_DIR", data_dir)
        .env("SESSION_STORE", "sqlite")
        .env(
            "CLASSIFIER_URL",
            format!("http://127.0.0.1:{classifier_port}"),
        )
        .env("ALLOW_LOCAL_SKILL_PACKS", "1")
        .env("CAPABILITY_SECRET", &secrets.capability_secret)
        .env("CONNECTOR_SECRET_KEY", &secrets.connector_secret_key)
        .env("CORE_SIGNING_SECRET", &secrets.core_signing_secret)
        .env("PORTAL_IDENTITY_SECRET", &secrets.portal_identity_secret)
        .env("SKILL_SIGNING_SECRET", &secrets.skill_signing_secret)
        .spawn()?;

    let web_ui = Command::new(node_path)
        .current_dir(payload_dir.join("web-ui"))
        .arg("server/index.ts")
        .env("HOST", "127.0.0.1")
        .env("PORT", web_ui_port.to_string())
        .env("CORE_API_URL", format!("http://127.0.0.1:{core_port}"))
        .env("CORE_ORG_ID", "meerkat")
        .env("CORE_SIGNING_SECRET", &secrets.core_signing_secret)
        .env("PORTAL_IDENTITY_SECRET", &secrets.portal_identity_secret)
        .spawn()?;

    Ok(Stack {
        classifier,
        core,
        web_ui,
        classifier_port,
        core_port,
        web_ui_port,
    })
}

#[derive(Clone, Copy, PartialEq, Serialize)]
pub struct StackStatus {
    pub classifier: bool,
    pub core: bool,
    pub web_ui: bool,
}

fn probe(port: u16, path: &str) -> bool {
    ureq::get(format!("http://127.0.0.1:{port}{path}"))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

pub fn health_poll(app: AppHandle, ports: Ports) {
    let mut last: Option<StackStatus> = None;
    loop {
        let status = StackStatus {
            classifier: probe(ports.classifier, "/health"),
            core: probe(ports.core, "/health"),
            web_ui: probe(ports.web_ui, "/healthz"),
        };
        if last != Some(status) {
            let _ = app.emit("stack-status", status);
            last = Some(status);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
