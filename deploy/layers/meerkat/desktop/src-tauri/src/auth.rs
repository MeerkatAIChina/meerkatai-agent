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

pub fn signed_request_headers(
    secret: &str,
    method: &str,
    path_with_query: &str,
    body: &str,
) -> Vec<(String, String)> {
    let now_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let canonical = format!("{method}\n{path_with_query}\n{body}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(format!("v0:{now_sec}:{canonical}").as_bytes());
    let bytes = mac.finalize().into_bytes();
    let mut signature = String::with_capacity(bytes.len() * 2 + 3);
    signature.push_str("v0=");
    for b in bytes {
        signature.push_str(&format!("{b:02x}"));
    }
    vec![
        ("x-timestamp".to_string(), now_sec.to_string()),
        ("x-signature".to_string(), signature),
    ]
}

pub fn source_auth_nonce() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix = rand::random::<u64>();
    format!("{now}-{suffix:x}")
}
