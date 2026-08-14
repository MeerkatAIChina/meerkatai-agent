use crate::secrets::Secrets;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Component {
    Classifier,
    Core,
    WebUi,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Fatal,
    Degraded,
}

pub fn severity(c: Component) -> Severity {
    match c {
        Component::Core | Component::WebUi => Severity::Fatal,
        Component::Classifier => Severity::Degraded,
    }
}

impl Component {
    fn name(self) -> &'static str {
        match self {
            Component::Classifier => "classifier",
            Component::Core => "core",
            Component::WebUi => "web_ui",
        }
    }
}

#[derive(Clone)]
pub struct StackCtx {
    pub node: PathBuf,
    pub payload_dir: PathBuf,
    pub data_dir: PathBuf,
    pub secrets: Secrets,
}

pub struct Stack {
    pub classifier: Child,
    pub core: Child,
    pub web_ui: Child,
    pub classifier_port: u16,
    pub core_port: u16,
    pub web_ui_port: u16,
}

impl Stack {
    fn child_mut(&mut self, c: Component) -> &mut Child {
        match c {
            Component::Classifier => &mut self.classifier,
            Component::Core => &mut self.core,
            Component::WebUi => &mut self.web_ui,
        }
    }

    fn port(&self, c: Component) -> u16 {
        match c {
            Component::Classifier => self.classifier_port,
            Component::Core => self.core_port,
            Component::WebUi => self.web_ui_port,
        }
    }
}

pub type SharedStack = Arc<Mutex<Option<Stack>>>;

pub fn shared_stack(stack: Option<Stack>) -> SharedStack {
    Arc::new(Mutex::new(stack))
}

pub fn kill_all(shared: &SharedStack) {
    if let Ok(mut slot) = shared.lock() {
        if let Some(stack) = slot.as_mut() {
            let _ = stack.classifier.kill();
            let _ = stack.core.kill();
            let _ = stack.web_ui.kill();
        }
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct Ports {
    pub classifier: u16,
    pub core: u16,
    pub web_ui: u16,
}

pub struct PortsState(pub Mutex<Ports>);

#[derive(Clone)]
pub struct Boot {
    pub payload_dir: PathBuf,
    pub data_dir: PathBuf,
}

pub fn resolve_node(payload_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        payload_dir.join("node").join("node.exe"),
        payload_dir.join("node").join("node"),
        payload_dir.join("node").join("bin").join("node"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.local_addr().map(|addr| addr.port())
}

fn log_stdio(data_dir: &Path, name: &str) -> io::Result<(Stdio, Stdio)> {
    let logs = data_dir.join("logs");
    fs::create_dir_all(&logs)?;
    let file = || {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join(format!("{name}.log")))
    };
    Ok((Stdio::from(file()?), Stdio::from(file()?)))
}

struct LocalModel {
    base_url: String,
    api_key: Option<String>,
    model: String,
}

fn read_local_model(data_dir: &Path) -> Option<LocalModel> {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "baseUrl")]
        base_url: String,
        #[serde(rename = "apiKey")]
        api_key: Option<String>,
        model: String,
    }
    let text = fs::read_to_string(data_dir.join("local-model.json")).ok()?;
    let raw: Raw = serde_json::from_str(&text).ok()?;
    if raw.base_url.is_empty() || raw.model.is_empty() {
        return None;
    }
    Some(LocalModel {
        base_url: raw.base_url,
        api_key: raw.api_key.filter(|k| !k.is_empty()),
        model: raw.model,
    })
}

fn spawn_component(
    ctx: &StackCtx,
    c: Component,
    port: u16,
    classifier_port: u16,
    core_port: u16,
) -> io::Result<Child> {
    match c {
        Component::Classifier => {
            let (out, err) = log_stdio(&ctx.data_dir, c.name())?;
            let mut cmd = Command::new(&ctx.node);
            cmd.current_dir(ctx.payload_dir.join("classifier"))
                .args(["--import", "tsx", "src/server.ts"])
                .env("HOST", "127.0.0.1")
                .env("PORT", port.to_string())
                .env(
                    "ROUTES_PATH",
                    ctx.payload_dir
                        .join("config")
                        .join("seeds")
                        .join("routes.json"),
                );
            if let Some(local) = read_local_model(&ctx.data_dir) {
                cmd.env(
                    "SEMANTIC_ENDPOINT",
                    format!("{}/chat/completions", local.base_url.trim_end_matches('/')),
                )
                .env("SEMANTIC_MODEL", &local.model)
                .env("SEMANTIC_TIMEOUT_MS", "10000");
                if let Some(key) = local.api_key {
                    cmd.env("SEMANTIC_API_KEY", key);
                }
            }
            cmd.stdout(out).stderr(err);
            hide_console(&mut cmd);
            cmd.spawn()
        }
        Component::Core => {
            let (out, err) = log_stdio(&ctx.data_dir, c.name())?;
            let mut cmd = Command::new(&ctx.node);
            cmd.current_dir(ctx.payload_dir.join("core"))
                .arg("dist/index.mjs")
                .env("NODE_ENV", "production")
                .env("HARNESS", "pi")
                .env("ORG_ID", "meerkat")
                .env("HOST", "127.0.0.1")
                .env("PORT", port.to_string())
                .env("DATA_DIR", &ctx.data_dir)
                .env("SANDBOX_BACKEND", "local")
                .env("SESSION_STORE", "sqlite")
                .env(
                    "CLASSIFIER_URL",
                    format!("http://127.0.0.1:{classifier_port}/classify"),
                )
                .env("CLASSIFIER_FALLBACK_MODEL", "Meerkat-TRIZ-v1")
                .env("CLASSIFIER_FALLBACK_HARNESS", "pi")
                .env("ALLOW_LOCAL_SKILL_PACKS", "1")
                .env("ADMIN_GRANTS", "meerkat-desktop:org_admin")
                .env("CAPABILITY_SECRET", &ctx.secrets.capability_secret)
                .env("CONNECTOR_SECRET_KEY", &ctx.secrets.connector_secret_key)
                .env("CORE_SIGNING_SECRET", &ctx.secrets.core_signing_secret)
                .env(
                    "PORTAL_IDENTITY_SECRET",
                    &ctx.secrets.portal_identity_secret,
                )
                .env("SKILL_SIGNING_SECRET", &ctx.secrets.skill_signing_secret)
                .stdout(out)
                .stderr(err);
            hide_console(&mut cmd);
            cmd.spawn()
        }
        Component::WebUi => {
            let (out, err) = log_stdio(&ctx.data_dir, c.name())?;
            let mut cmd = Command::new(&ctx.node);
            cmd.current_dir(ctx.payload_dir.join("web-ui"))
                .arg("dist-server/index.mjs")
                .env("HOST", "127.0.0.1")
                .env("PORT", port.to_string())
                .env("MEERKAT_DESKTOP", "1")
                .env("MEERKAT_DATA_DIR", &ctx.data_dir)
                .env(
                    "MEERKAT_SEEDS_DIR",
                    ctx.payload_dir.join("config").join("seeds"),
                )
                .env("CORE_ORG_ID", "meerkat")
                .env("CORE_API_URL", format!("http://127.0.0.1:{core_port}"))
                .env("CORE_SIGNING_SECRET", &ctx.secrets.core_signing_secret)
                .env(
                    "PORTAL_IDENTITY_SECRET",
                    &ctx.secrets.portal_identity_secret,
                )
                .stdout(out)
                .stderr(err);
            hide_console(&mut cmd);
            cmd.spawn()
        }
    }
}

pub fn spawn_stack(ctx: &StackCtx) -> io::Result<Stack> {
    let classifier_port = free_port()?;
    let core_port = free_port()?;
    let web_ui_port = free_port()?;
    Ok(Stack {
        classifier: spawn_component(
            ctx,
            Component::Classifier,
            classifier_port,
            classifier_port,
            core_port,
        )?,
        core: spawn_component(ctx, Component::Core, core_port, classifier_port, core_port)?,
        web_ui: spawn_component(
            ctx,
            Component::WebUi,
            web_ui_port,
            classifier_port,
            core_port,
        )?,
        classifier_port,
        core_port,
        web_ui_port,
    })
}

#[derive(Clone, Serialize)]
struct ComponentEvent {
    component: Component,
    severity: Severity,
    reason: String,
}

#[derive(Clone, Serialize)]
struct ReadyEvent {
    component: Component,
    elapsed_ms: u128,
}

#[derive(Clone, Serialize)]
struct CrashEvent {
    component: Component,
}

fn probe(port: u16, path: &str) -> bool {
    ureq::get(format!("http://127.0.0.1:{port}{path}"))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

fn probe_of(c: Component, ports: Ports) -> bool {
    match c {
        Component::Classifier => probe(ports.classifier, "/health"),
        Component::Core => probe(ports.core, "/health"),
        Component::WebUi => probe(ports.web_ui, "/healthz"),
    }
}

pub fn live_status(ports: Ports) -> Vec<String> {
    [Component::Classifier, Component::Core, Component::WebUi]
        .into_iter()
        .filter(|c| probe_of(*c, ports))
        .map(|c| c.name().to_string())
        .collect()
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

pub fn health_poll(app: AppHandle, shared: SharedStack, ctx: StackCtx, ports: Ports) {
    let start = Instant::now();
    let mut ready = [false; 3];
    let order = [Component::Classifier, Component::Core, Component::WebUi];

    loop {
        for (i, c) in order.iter().enumerate() {
            if ready[i] {
                continue;
            }
            if probe_of(*c, ports) {
                ready[i] = true;
                let _ = app.emit(
                    "component-ready",
                    ReadyEvent {
                        component: *c,
                        elapsed_ms: start.elapsed().as_millis(),
                    },
                );
            }
        }
        if ready[1] && ready[2] {
            break;
        }
        if start.elapsed() > STARTUP_TIMEOUT {
            for (i, c) in order.iter().enumerate() {
                if !ready[i] {
                    let _ = app.emit(
                        "component-failed",
                        ComponentEvent {
                            component: *c,
                            severity: severity(*c),
                            reason: format!("启动超时（{} 秒未就绪）", STARTUP_TIMEOUT.as_secs()),
                        },
                    );
                }
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    let mut respawned = [false; 3];
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let mut guard = match shared.lock() {
            Ok(g) => g,
            Err(_) => continue,
        };
        let Some(stack) = guard.as_mut() else {
            continue;
        };
        for (i, c) in order.iter().enumerate() {
            let exited = matches!(stack.child_mut(*c).try_wait(), Ok(Some(_)));
            if !exited {
                continue;
            }
            if severity(*c) == Severity::Degraded {
                if !respawned[i] {
                    respawned[i] = true;
                    let _ = app.emit(
                        "component-failed",
                        ComponentEvent {
                            component: *c,
                            severity: Severity::Degraded,
                            reason: "进程退出，进入降级模式".to_string(),
                        },
                    );
                }
                continue;
            }
            let _ = app.emit("service-crashed", CrashEvent { component: *c });
            if respawned[i] {
                let _ = app.emit(
                    "component-failed",
                    ComponentEvent {
                        component: *c,
                        severity: Severity::Fatal,
                        reason: "自动重启后再次退出".to_string(),
                    },
                );
                continue;
            }
            respawned[i] = true;
            match spawn_component(
                &ctx,
                *c,
                stack.port(*c),
                stack.port(Component::Classifier),
                stack.port(Component::Core),
            ) {
                Ok(child) => {
                    *stack.child_mut(*c) = child;
                    let _ = app.emit("service-restored", CrashEvent { component: *c });
                }
                Err(err) => {
                    let _ = app.emit(
                        "component-failed",
                        ComponentEvent {
                            component: *c,
                            severity: Severity::Fatal,
                            reason: format!("自动重启失败：{err}"),
                        },
                    );
                }
            }
        }
    }
}

pub fn retry(app: &AppHandle) -> Result<(), String> {
    let shared = app.state::<SharedStack>();
    let mut guard = shared.lock().map_err(|e| e.to_string())?;
    if let Some(stack) = guard.as_mut() {
        let ctx = app.state::<StackCtx>();
        for c in [Component::Classifier, Component::Core, Component::WebUi] {
            let dead = match stack.child_mut(c).try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(_) => true,
            };
            if dead {
                let child = spawn_component(
                    &ctx,
                    c,
                    stack.port(c),
                    stack.port(Component::Classifier),
                    stack.port(Component::Core),
                )
                .map_err(|e| e.to_string())?;
                *stack.child_mut(c) = child;
            }
        }
        return Ok(());
    }

    let ctx = match app.try_state::<StackCtx>() {
        Some(existing) => existing.inner().clone(),
        None => {
            let boot = app.state::<Boot>();
            let secrets =
                crate::secrets::load_or_create(&boot.data_dir).map_err(|e| e.to_string())?;
            let node = resolve_node(&boot.payload_dir).ok_or_else(|| {
                format!(
                    "node runtime not found under {}",
                    boot.payload_dir.display()
                )
            })?;
            let fresh = StackCtx {
                node,
                payload_dir: boot.payload_dir.clone(),
                data_dir: boot.data_dir.clone(),
                secrets,
            };
            app.manage(fresh.clone());
            fresh
        }
    };
    let stack = spawn_stack(&ctx).map_err(|e| e.to_string())?;
    let ports = Ports {
        classifier: stack.classifier_port,
        core: stack.core_port,
        web_ui: stack.web_ui_port,
    };
    *guard = Some(stack);
    drop(guard);
    if let Some(ports_state) = app.try_state::<PortsState>() {
        *ports_state.0.lock().map_err(|e| e.to_string())? = ports;
    }
    let handle = app.clone();
    let shared_clone = shared.inner().clone();
    std::thread::spawn(move || health_poll(handle, shared_clone, ctx, ports));
    Ok(())
}

pub fn diagnostics(data_dir: &Path) -> String {
    let mut out = String::new();
    for name in ["classifier", "core", "web_ui"] {
        let path = data_dir.join("logs").join(format!("{name}.log"));
        let text = fs::read_to_string(&path).unwrap_or_default();
        let tail: Vec<&str> = text.lines().rev().take(40).collect();
        out.push_str(&format!("== {name} ==\n"));
        for line in tail.into_iter().rev() {
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}
