use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_TTL_MS: u128 = 24 * 60 * 60 * 1000;

pub fn mint_portal_identity(secret: &str) -> String {
    let expiry_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() + TOKEN_TTL_MS)
        .unwrap_or(TOKEN_TTL_MS);
    let claims = format!("{{\"p\":\"meerkat-desktop\",\"exp\":{expiry_ms}}}");
    let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    let digest = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{digest}")
}
