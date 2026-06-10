use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::SaltString;
use argon2::{Argon2, ParamsBuilder, PasswordHasher};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::PathBuf;

const V1_PREFIX: &str = "enc:v1:";
const V2_PREFIX: &str = "enc:v2:";
const V3_PREFIX: &str = "enc:v3:"; // New secure version

/// Get the machine-specific salt file path
fn get_salt_file_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gxAgent")
        .join(".salt")
}

/// Load or generate a persistent salt for this machine
fn get_or_create_machine_salt() -> [u8; 32] {
    let salt_path = get_salt_file_path();

    // Try to load existing salt
    if let Ok(content) = std::fs::read_to_string(&salt_path) {
        if let Ok(bytes) = hex::decode(content.trim()) {
            if bytes.len() == 32 {
                let mut salt = [0u8; 32];
                salt.copy_from_slice(&bytes);
                return salt;
            }
        }
    }

    // Generate new salt
    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).unwrap_or_else(|_| {
        // Fallback to timestamp-based if getrandom fails
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        for (i, chunk) in now.to_le_bytes().iter().enumerate() {
            salt[i % 32] ^= chunk;
        }
    });

    // Save salt
    if let Some(parent) = salt_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&salt_path, hex::encode(salt));

    salt
}

/// Derive a 32-byte encryption key from machine-specific info using Argon2
fn derive_key_v3() -> [u8; 32] {
    let machine_id = whoami::fallible::hostname().unwrap_or_else(|_| "gxagent-default".to_string());
    let username = whoami::fallible::username().unwrap_or_else(|_| "user".to_string());

    let password = format!("gxAgent:v3:{}:{}", machine_id, username);
    let salt = get_or_create_machine_salt();

    // Use Argon2id with secure parameters
    let params = ParamsBuilder::new()
        .m_cost(19456) // 19 MiB memory
        .t_cost(2) // 2 iterations
        .p_cost(1) // 1 thread
        .build()
        .unwrap();

    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let salt_string = SaltString::encode_b64(&salt).unwrap();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt_string)
        .unwrap()
        .hash
        .unwrap();

    let hash_bytes = hash.as_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash_bytes[..32]);
    key
}

/// Legacy v1 key derivation (INSECURE - kept only for migration)
fn derive_key_v1() -> Vec<u8> {
    let machine_id = whoami::fallible::hostname().unwrap_or_else(|_| "gxagent-default".to_string());
    let username = whoami::fallible::username().unwrap_or_else(|_| "user".to_string());
    let seed = format!("gxAgent:{}:{}", machine_id, username);
    let mut key = Vec::with_capacity(32);
    for (i, b) in seed.as_bytes().iter().enumerate() {
        key.push(b ^ ((i as u8).wrapping_mul(37)));
    }
    while key.len() < 32 {
        key.push(key.len() as u8 ^ 0x5A);
    }
    key
}

/// Legacy v2 key derivation (INSECURE - kept only for migration)
fn derive_key_v2() -> [u8; 32] {
    let machine_id = whoami::fallible::hostname().unwrap_or_else(|_| "gxagent-default".to_string());
    let username = whoami::fallible::username().unwrap_or_else(|_| "user".to_string());
    let seed = format!(
        "gxAgent-v2:{}:{}:salt=9a7b3c1d5e8f2a4b",
        machine_id, username
    );

    let mut key = [0u8; 32];
    for i in 0..32 {
        key[i] = ((i as u64).wrapping_mul(0x9E3779B97F4A7C15) >> 24) as u8;
    }

    for (i, &b) in seed.as_bytes().iter().enumerate() {
        key[i % 32] = key[i % 32]
            .wrapping_add(b)
            .wrapping_add((i as u8).wrapping_mul(0x5A))
            ^ key[(i + 7) % 32];
    }

    for round in 0u8..16 {
        for i in 0..32 {
            let j = (i + round as usize + 1) % 32;
            key[i] = key[i]
                .wrapping_add(key[j])
                .wrapping_mul(0x5B)
                .wrapping_add(round);
        }
    }

    key
}

/// Encrypt plaintext using AES-256-GCM with Argon2-derived key
pub fn encrypt(plaintext: &str) -> String {
    if plaintext.is_empty() || plaintext.starts_with(V3_PREFIX) {
        return plaintext.to_string();
    }

    let key = derive_key_v3();
    let cipher = Aes256Gcm::new_from_slice(&key).expect("valid key length");

    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .expect("AES-GCM encryption failure");

    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    format!("{}{}", V3_PREFIX, BASE64.encode(&combined))
}

/// Decrypt ciphertext, supporting v1, v2, and v3 formats
pub fn decrypt(ciphertext: &str) -> String {
    if ciphertext.is_empty() {
        return ciphertext.to_string();
    }

    // v3 (secure Argon2-based)
    if ciphertext.starts_with(V3_PREFIX) {
        return decrypt_v3(ciphertext);
    }

    // v2 (legacy, auto-migrate)
    if ciphertext.starts_with(V2_PREFIX) {
        let decrypted = decrypt_v2(ciphertext);
        // Auto-upgrade to v3 on next save
        return decrypted;
    }

    // v1 (legacy, auto-migrate)
    if ciphertext.starts_with(V1_PREFIX) {
        let decrypted = decrypt_v1(ciphertext);
        return decrypted;
    }

    // Not encrypted
    ciphertext.to_string()
}

fn decrypt_v3(ciphertext: &str) -> String {
    let encoded = &ciphertext[V3_PREFIX.len()..];
    let combined = match BASE64.decode(encoded) {
        Ok(b) => b,
        Err(_) => return ciphertext.to_string(),
    };

    if combined.len() < 12 + 16 {
        return ciphertext.to_string();
    }

    let (nonce_bytes, ciphertext_bytes) = combined.split_at(12);
    let key = derive_key_v3();
    let cipher = Aes256Gcm::new_from_slice(&key).expect("valid key length");
    let nonce = Nonce::from_slice(nonce_bytes);

    match cipher.decrypt(nonce, ciphertext_bytes) {
        Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_else(|_| ciphertext.to_string()),
        Err(_) => ciphertext.to_string(),
    }
}

fn decrypt_v2(ciphertext: &str) -> String {
    let encoded = &ciphertext[V2_PREFIX.len()..];
    let combined = match BASE64.decode(encoded) {
        Ok(b) => b,
        Err(_) => return ciphertext.to_string(),
    };

    if combined.len() < 12 + 16 {
        return ciphertext.to_string();
    }

    let (nonce_bytes, ciphertext_bytes) = combined.split_at(12);
    let key = derive_key_v2();
    let cipher = Aes256Gcm::new_from_slice(&key).expect("valid key length");
    let nonce = Nonce::from_slice(nonce_bytes);

    match cipher.decrypt(nonce, ciphertext_bytes) {
        Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_else(|_| ciphertext.to_string()),
        Err(_) => ciphertext.to_string(),
    }
}

fn decrypt_v1(ciphertext: &str) -> String {
    let encoded = &ciphertext[V1_PREFIX.len()..];
    let bytes = match BASE64.decode(encoded) {
        Ok(b) => b,
        Err(_) => return ciphertext.to_string(),
    };
    let key = derive_key_v1();
    let decrypted: Vec<u8> = bytes
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect();
    match String::from_utf8(decrypted) {
        Ok(s) => s,
        Err(_) => ciphertext.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_v3_encrypt_decrypt() {
        let original = "sk-1234567890abcdef";
        let encrypted = encrypt(original);
        assert!(encrypted.starts_with(V3_PREFIX));
        assert_ne!(encrypted, original);
        let decrypted = decrypt(&encrypted);
        assert_eq!(decrypted, original);
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(encrypt(""), "");
        assert_eq!(decrypt(""), "");
    }

    #[test]
    fn test_already_encrypted() {
        let encrypted = encrypt("test-key");
        let re_encrypted = encrypt(&encrypted);
        assert_eq!(encrypted, re_encrypted);
    }

    #[test]
    fn test_plaintext_passthrough() {
        let plain = "not-encrypted";
        assert_eq!(decrypt(plain), plain);
    }

    #[test]
    fn test_different_nonce_per_encryption() {
        let original = "same-input";
        let enc1 = encrypt(original);
        let enc2 = encrypt(original);
        // Different nonces mean different ciphertexts
        assert_ne!(enc1, enc2);
        // But both decrypt to the same plaintext
        assert_eq!(decrypt(&enc1), original);
        assert_eq!(decrypt(&enc2), original);
    }
}
