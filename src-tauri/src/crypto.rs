use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

const V1_PREFIX: &str = "enc:v1:";
const V2_PREFIX: &str = "enc:v2:";

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

fn derive_key_v2() -> [u8; 32] {
    let machine_id = whoami::fallible::hostname().unwrap_or_else(|_| "gxagent-default".to_string());
    let username = whoami::fallible::username().unwrap_or_else(|_| "user".to_string());
    let seed = format!("gxAgent-v2:{}:{}:salt=9a7b3c1d5e8f2a4b", machine_id, username);

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

pub fn encrypt(plaintext: &str) -> String {
    if plaintext.is_empty() || plaintext.starts_with(V2_PREFIX) {
        return plaintext.to_string();
    }

    let key = derive_key_v2();
    let cipher = Aes256Gcm::new_from_slice(&key).expect("valid key length");

    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .expect("AES-GCM encryption failure");

    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    format!("{}{}", V2_PREFIX, BASE64.encode(&combined))
}

pub fn decrypt(ciphertext: &str) -> String {
    if ciphertext.is_empty() {
        return ciphertext.to_string();
    }

    if ciphertext.starts_with(V1_PREFIX) {
        return decrypt_v1(ciphertext);
    }

    if !ciphertext.starts_with(V2_PREFIX) {
        return ciphertext.to_string();
    }

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
    fn test_v2_encrypt_decrypt() {
        let original = "sk-1234567890abcdef";
        let encrypted = encrypt(original);
        assert!(encrypted.starts_with(V2_PREFIX));
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
    fn test_v1_migration() {
        let original = "sk-migration-test";
        let v1_encrypted = {
            let key = derive_key_v1();
            let bytes: Vec<u8> = original
                .as_bytes()
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ key[i % key.len()])
                .collect();
            format!("{}{}", V1_PREFIX, BASE64.encode(&bytes))
        };
        let decrypted = decrypt(&v1_encrypted);
        assert_eq!(decrypted, original);
    }

    #[test]
    fn test_different_nonce_per_encryption() {
        let original = "same-input";
        let enc1 = encrypt(original);
        let enc2 = encrypt(original);
        assert_ne!(enc1, enc2);
        assert_eq!(decrypt(&enc1), original);
        assert_eq!(decrypt(&enc2), original);
    }
}
