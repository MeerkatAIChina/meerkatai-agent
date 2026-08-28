use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, Wry};

use crate::{auth, proc};

const FILENAME_CAP: usize = 120;

pub fn handle_new_window(app: &AppHandle, url: Url) -> NewWindowResponse<Wry> {
    if let Some(artifact_id) = file_artifact_id(&url) {
        let app = app.clone();
        let fallback = url.to_string();
        std::thread::spawn(move || {
            if let Err(err) = export_and_reveal(&app, &artifact_id) {
                eprintln!("meerkat file export failed: {err}");
                open_external(&fallback);
            }
        });
        return NewWindowResponse::Deny;
    }
    if matches!(url.scheme(), "http" | "https") {
        let external = url.to_string();
        std::thread::spawn(move || open_external(&external));
    }
    NewWindowResponse::Deny
}

fn file_artifact_id(url: &Url) -> Option<String> {
    if url.scheme() != "http" {
        return None;
    }
    if !matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.collect();
    match segments.as_slice() {
        ["api", "files", id, "content"] | ["api", "files", id] if !id.is_empty() => {
            Some((*id).to_string())
        }
        _ => None,
    }
}

fn export_and_reveal(app: &AppHandle, artifact_id: &str) -> io::Result<()> {
    let core_port = app
        .try_state::<proc::PortsState>()
        .and_then(|state| state.0.lock().ok().map(|ports| ports.core))
        .filter(|port| *port != 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "core port not ready"))?;
    let ctx = app
        .try_state::<proc::StackCtx>()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "stack not ready"))?;
    let core_path = format!("/v1/files/{artifact_id}/content?_sourceAuthNonce={}", auth::source_auth_nonce());
    let headers = auth::signed_request_headers(
        &ctx.secrets.core_signing_secret,
        "GET",
        &core_path,
        "",
    );
    let mut resp = ureq::get(format!("http://127.0.0.1:{core_port}{core_path}"))
        .header("x-portal-identity", auth::mint_portal_identity(&ctx.secrets.portal_identity_secret))
        .header("x-timestamp", &headers[0].1)
        .header("x-signature", &headers[1].1)
        .call()
        .map_err(io::Error::other)?;
    let name = resp
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .and_then(filename_from_content_disposition)
        .map(|raw| sanitize_filename(&raw))
        .unwrap_or_else(|| format!("meerkat-{artifact_id}"));
    let bytes = resp.body_mut().read_to_vec().map_err(io::Error::other)?;
    let dir = export_dir(app);
    fs::create_dir_all(&dir)?;
    let (path, needs_write) = export_path(&dir, &name, &bytes);
    if needs_write {
        fs::write(&path, &bytes)?;
    }
    reveal(&path);
    Ok(())
}

fn export_dir(app: &AppHandle) -> PathBuf {
    if let Some(downloads) = downloads_dir() {
        return downloads.join("Meerkat");
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("exports"))
        .unwrap_or_else(|_| PathBuf::from("./data/exports"))
}

fn filename_from_content_disposition(header: &str) -> Option<String> {
    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part
            .strip_prefix("filename*=")
            .map(|v| v.trim_matches('"'))
        {
            if let Some(encoded) = value
                .strip_prefix("UTF-8''")
                .or_else(|| value.strip_prefix("utf-8''"))
            {
                return Some(percent_decode(encoded));
            }
            return Some(value.to_string());
        }
    }
    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("filename=") {
            return Some(value.trim_matches('"').to_string());
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn sanitize_filename(name: &str) -> String {
    let filtered: String = name
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = filtered.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "file".to_string();
    }
    trimmed.chars().take(FILENAME_CAP).collect()
}

fn export_path(dir: &Path, name: &str, bytes: &[u8]) -> (PathBuf, bool) {
    let (stem, ext) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    let mut candidate = dir.join(name);
    let mut counter = 2;
    loop {
        if !candidate.exists() {
            return (candidate, true);
        }
        if fs::read(&candidate).map(|existing| existing == bytes).unwrap_or(false) {
            return (candidate, false);
        }
        candidate = dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }
}

#[cfg(windows)]
fn downloads_dir() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Downloads, KF_FLAG_DEFAULT};
    let raw = unsafe { SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None) }.ok()?;
    let path = unsafe { raw.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(raw.0 as *const _)) };
    path.map(PathBuf::from)
}

#[cfg(not(windows))]
fn downloads_dir() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn reveal(path: &Path) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn();
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) {
    let _ = Command::new("open").arg("-R").arg(path).spawn();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
}

#[cfg(windows)]
fn open_external(url: &str) {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let target = HSTRING::from(url);
    let result = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    if (result.0 as usize) <= 32 {
        eprintln!("meerkat failed to open external url: {url}");
    }
}

#[cfg(target_os = "macos")]
fn open_external(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external(url: &str) {
    let _ = Command::new("xdg-open").arg(url).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_artifact_id_matches_content_route() {
        let url = Url::parse("http://127.0.0.1:8123/api/files/3f8a2b/content").unwrap();
        assert_eq!(file_artifact_id(&url).as_deref(), Some("3f8a2b"));
    }

    #[test]
    fn file_artifact_id_accepts_localhost() {
        let url = Url::parse("http://localhost:8123/api/files/abc/content").unwrap();
        assert_eq!(file_artifact_id(&url).as_deref(), Some("abc"));
    }

    #[test]
    fn file_artifact_id_accepts_bare_file_route() {
        let url = Url::parse("http://127.0.0.1:8123/api/files/3f8a2b").unwrap();
        assert_eq!(file_artifact_id(&url).as_deref(), Some("3f8a2b"));
    }

    #[test]
    fn file_artifact_id_rejects_other_paths() {
        for raw in [
            "http://127.0.0.1:8123/api/files",
            "http://127.0.0.1:8123/api/files/abc/content/extra",
            "http://127.0.0.1:8123/other/files/abc/content",
            "https://127.0.0.1:8123/api/files/abc/content",
            "http://example.com/api/files/abc/content",
            "tauri://localhost/api/files/abc/content",
        ] {
            let url = Url::parse(raw).unwrap();
            assert_eq!(file_artifact_id(&url), None, "should reject {raw}");
        }
    }

    #[test]
    fn content_disposition_prefers_rfc5987() {
        let header = "inline; filename*=UTF-8''Hello_World.pptx";
        assert_eq!(
            filename_from_content_disposition(header).as_deref(),
            Some("Hello_World.pptx")
        );
    }

    #[test]
    fn content_disposition_decodes_percent_encoding() {
        let header = "inline; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20Q3.pptx";
        assert_eq!(
            filename_from_content_disposition(header).as_deref(),
            Some("报告 Q3.pptx")
        );
    }

    #[test]
    fn content_disposition_falls_back_to_plain_filename() {
        let header = "attachment; filename=\"quarterly report.docx\"";
        assert_eq!(
            filename_from_content_disposition(header).as_deref(),
            Some("quarterly report.docx")
        );
    }

    #[test]
    fn content_disposition_missing_returns_none() {
        assert_eq!(filename_from_content_disposition("inline"), None);
    }

    #[test]
    fn percent_decode_handles_mixed_input() {
        assert_eq!(percent_decode("a%20b%zzc%2"), "a b%zzc%2");
        assert_eq!(percent_decode("%41%42"), "AB");
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        assert_eq!(sanitize_filename("a<b>:c/d\\e|f?g*h.pptx"), "a_b__c_d_e_f_g_h.pptx");
    }

    #[test]
    fn sanitize_trims_trailing_dots_and_spaces() {
        assert_eq!(sanitize_filename("  name.pptx . "), "name.pptx");
    }

    #[test]
    fn sanitize_empty_falls_back() {
        assert_eq!(sanitize_filename("..."), "file");
        assert_eq!(sanitize_filename("   "), "file");
    }

    #[test]
    fn sanitize_caps_length() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_filename(&long).chars().count(), FILENAME_CAP);
    }

    #[test]
    fn export_path_takes_plain_name_when_free() {
        let dir = fresh_test_dir("free");
        assert_eq!(export_path(&dir, "a.pptx", b"x"), (dir.join("a.pptx"), true));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_path_reuses_identical_content() {
        let dir = fresh_test_dir("identical");
        fs::write(dir.join("a.pptx"), b"same").unwrap();
        assert_eq!(export_path(&dir, "a.pptx", b"same"), (dir.join("a.pptx"), false));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_path_bumps_counter_on_different_content() {
        let dir = fresh_test_dir("different");
        fs::write(dir.join("a.pptx"), b"old").unwrap();
        assert_eq!(
            export_path(&dir, "a.pptx", b"new"),
            (dir.join("a (2).pptx"), true)
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_path_reuses_numbered_copy_with_identical_content() {
        let dir = fresh_test_dir("numbered-identical");
        fs::write(dir.join("a.pptx"), b"other").unwrap();
        fs::write(dir.join("a (2).pptx"), b"same").unwrap();
        assert_eq!(
            export_path(&dir, "a.pptx", b"same"),
            (dir.join("a (2).pptx"), false)
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_path_treats_leading_dot_as_no_extension() {
        let dir = fresh_test_dir("leading-dot");
        fs::write(dir.join(".index"), b"old").unwrap();
        assert_eq!(
            export_path(&dir, ".index", b"new"),
            (dir.join(".index (2)"), true)
        );
        fs::remove_dir_all(&dir).ok();
    }

    fn fresh_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meerkat-reveal-test-{}-{tag}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
