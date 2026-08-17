use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

pub const DISTRO: &str = "meerkat-sandbox";
pub const MIN_OS_BUILD: u32 = 19044;

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SandboxStatus {
    pub supported: bool,
    pub os_build: u32,
    pub wsl_enabled: bool,
    pub imported: bool,
    pub fingerprint_current: bool,
    pub pending_reboot: bool,
    pub reason: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, Default)]
struct StateFile {
    #[serde(default)]
    imported: bool,
    #[serde(default)]
    fingerprint: String,
    #[serde(default)]
    pending_reboot: bool,
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("sandbox-state.json")
}

fn load_state(data_dir: &Path) -> StateFile {
    fs::read_to_string(state_path(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(data_dir: &Path, s: &StateFile) -> std::io::Result<()> {
    fs::write(state_path(data_dir), serde_json::to_string_pretty(s).unwrap())
}

#[cfg(windows)]
fn os_build() -> u32 {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let mut buf = [0u16; 16];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut len),
        )
    };
    if ok.is_err() {
        return 0;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().parse().unwrap_or(0)
}

#[cfg(not(windows))]
fn os_build() -> u32 {
    0
}

fn wsl(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.output()
}

fn decode_wsl_out(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn to_wsl_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    match s.split_once(':') {
        Some((drive, rest)) if drive.len() == 1 => format!("/mnt/{}{}", drive.to_lowercase(), rest),
        _ => s,
    }
}

fn emit_sandbox(app: &AppHandle, phase: &str) {
    if phase == "ready" {
        let _ = app.emit(
            "component-ready",
            serde_json::json!({ "component": "sandbox", "elapsed_ms": 0 }),
        );
    } else {
        let _ = app.emit(
            "component-failed",
            serde_json::json!({ "component": "sandbox", "severity": "degraded", "reason": phase }),
        );
    }
}

pub fn status(data_dir: &Path, payload_dir: &Path) -> SandboxStatus {
    let build = os_build();
    let st = load_state(data_dir);
    let wsl_enabled = wsl(&["--status"]).map(|o| o.status.success()).unwrap_or(false);
    let imported = wsl(&["-l", "-q"])
        .map(|o| decode_wsl_out(&o.stdout).lines().any(|l| l.trim() == DISTRO))
        .unwrap_or(false);
    let want_fp = fs::read_to_string(payload_dir.join("sandbox").join("fingerprint.txt")).unwrap_or_default();
    let fingerprint_current = imported && !want_fp.is_empty() && st.fingerprint == want_fp.trim();
    SandboxStatus {
        supported: build >= MIN_OS_BUILD,
        os_build: build,
        wsl_enabled,
        imported,
        fingerprint_current,
        pending_reboot: st.pending_reboot,
        reason: if build < MIN_OS_BUILD {
            Some(format!("OS build {build} 低于沙箱要求的 {MIN_OS_BUILD}"))
        } else {
            None
        },
    }
}

#[cfg(windows)]
pub fn enable_wsl2(data_dir: &Path) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe {
        ShellExecuteW(
            None,
            w!("runas"),
            w!("wsl.exe"),
            w!("--install --no-distribution"),
            None,
            SW_SHOWNORMAL,
        )
    };
    if (r.0 as usize) <= 32 {
        return Err("用户取消了授权或启用失败".into());
    }
    let mut st = load_state(data_dir);
    st.pending_reboot = true;
    save_state(data_dir, &st).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn enable_wsl2(_data_dir: &Path) -> Result<(), String> {
    Err("WSL2 仅 Windows 可用".into())
}

pub fn ensure_rootfs(app: &AppHandle, payload_dir: &Path, data_dir: &Path) -> Result<(), String> {
    let st = status(data_dir, payload_dir);
    if !st.supported || !st.wsl_enabled {
        return Ok(());
    }
    let tar = payload_dir.join("sandbox").join("rootfs.tar.gz");
    if !tar.exists() {
        return Ok(());
    }
    let need_import = !st.imported || !st.fingerprint_current;
    if !need_import {
        return Ok(());
    }
    emit_sandbox(app, if st.imported { "沙箱更新中" } else { "沙箱初始化中" });
    if st.imported {
        let backup = data_dir.join("wsl-home-backup.tar");
        let backup_wsl = to_wsl_path(&backup);
        let out = wsl(&[
            "-d",
            DISTRO,
            "-u",
            "root",
            "--",
            "sh",
            "-c",
            &format!("cd / && tar -cf '{}' home 2>/dev/null || true", backup_wsl),
        ])
        .map_err(|e| e.to_string())?;
        if !out.status.success() || !backup.exists() {
            emit_sandbox(app, "workspace 备份失败，已中止更新（旧沙箱保留）");
            return Err("rootfs update aborted: /home backup failed".into());
        }
        let _ = wsl(&["--unregister", DISTRO]);
    }
    let install_dir = data_dir.join("wsl");
    fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let out = wsl(&[
        "--import",
        DISTRO,
        &install_dir.to_string_lossy(),
        &tar.to_string_lossy(),
    ])
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        emit_sandbox(app, &format!("rootfs 导入失败: {}", decode_wsl_out(&out.stderr)));
        return Err(format!("rootfs 导入失败: {}", decode_wsl_out(&out.stderr)));
    }
    if st.imported {
        let backup = data_dir.join("wsl-home-backup.tar");
        if backup.exists() {
            let backup_wsl = to_wsl_path(&backup);
            let restore = wsl(&[
                "-d",
                DISTRO,
                "-u",
                "root",
                "--",
                "sh",
                "-c",
                &format!("cd / && tar -xf '{}' && rm -f '{}'", backup_wsl, backup_wsl),
            ]);
            match restore {
                Ok(o) if o.status.success() => {
                    let _ = fs::remove_file(&backup);
                }
                _ => {
                    emit_sandbox(app, "workspace 恢复失败，备份保留在数据目录");
                }
            }
        }
    }
    let fp = fs::read_to_string(payload_dir.join("sandbox").join("fingerprint.txt")).unwrap_or_default();
    save_state(
        data_dir,
        &StateFile {
            imported: true,
            fingerprint: fp.trim().into(),
            pending_reboot: false,
        },
    )
    .map_err(|e| e.to_string())?;
    emit_sandbox(app, "ready");
    Ok(())
}
