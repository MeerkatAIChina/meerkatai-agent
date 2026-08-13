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
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(secrets) = serde_json::from_str::<Secrets>(&text) {
            return Ok(secrets);
        }
    }
    fs::create_dir_all(data_dir)?;
    let secrets = generate();
    let body = serde_json::to_string_pretty(&secrets)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&path, body)?;
    Ok(secrets)
}
