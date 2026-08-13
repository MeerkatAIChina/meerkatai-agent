use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct Secrets {
    pub capability_secret: String,
    pub connector_secret_key: String,
    pub core_signing_secret: String,
    pub portal_identity_secret: String,
    pub skill_signing_secret: String,
}

fn random_hex() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn generate() -> Secrets {
    Secrets {
        capability_secret: random_hex(),
        connector_secret_key: random_hex(),
        core_signing_secret: random_hex(),
        portal_identity_secret: random_hex(),
        skill_signing_secret: random_hex(),
    }
}

pub fn load_or_create(data_dir: &Path) -> io::Result<Secrets> {
    let path = data_dir.join("secrets.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Secrets>(&text).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "secrets.json exists but is unreadable; refusing to rotate keys silently: {e}"
                ),
            )
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(data_dir)?;
            let secrets = generate();
            let body = serde_json::to_string_pretty(&secrets)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            write_private(&path, body.as_bytes())?;
            Ok(secrets)
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?
        .write_all(body)
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    fs::write(path, body)
}
