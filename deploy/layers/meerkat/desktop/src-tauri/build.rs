fn main() {
    let payload = std::path::Path::new("..").join("payload");
    if !payload.exists() {
        let profile = std::env::var("PROFILE").unwrap_or_default();
        if profile == "release" {
            panic!("payload/ not found — run scripts/stage-payload.* first");
        }
        println!("cargo:warning=payload/ not found — run scripts/stage-payload.* before packaging");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "ports",
                "status",
                "retry",
                "diagnostics",
                "portal_token",
                "restart_core",
                "wsl2_status",
                "enable_wsl2",
                "skillpacks_status",
            ]),
        ),
    )
    .expect("tauri build");
}
