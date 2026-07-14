use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::SaltString;
use argon2::{Argon2, ParamsBuilder, PasswordHasher};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const V1_PREFIX: &str = "enc:v1:";
const V2_PREFIX: &str = "enc:v2:";
const V3_PREFIX: &str = "enc:v3:"; // New secure version
static MACHINE_SALT: OnceLock<[u8; 32]> = OnceLock::new();

/// Get the machine-specific salt file path
fn get_salt_file_path() -> io::Result<PathBuf> {
    dirs::config_dir()
        .map(|directory| directory.join("gxAgent").join(".salt"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Config directory is unavailable"))
}

fn read_machine_salt(path: &Path) -> io::Result<Option<[u8; 32]>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!("Failed to read encryption salt {}: {error}", path.display()),
            ))
        }
    };

    let bytes = hex::decode(content.trim()).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Encryption salt {} is not valid hexadecimal: {error}",
                path.display()
            ),
        )
    })?;
    let salt: [u8; 32] = bytes.try_into().map_err(|bytes: Vec<u8>| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Encryption salt {} has {} bytes; expected 32",
                path.display(),
                bytes.len()
            ),
        )
    })?;
    Ok(Some(salt))
}

fn generate_machine_salt() -> io::Result<[u8; 32]> {
    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|error| {
        io::Error::other(format!("Failed to generate encryption salt: {error}"))
    })?;
    Ok(salt)
}

/// Publish a fully written salt without ever replacing an existing winner.
/// The temporary file lives beside the target so the hard-link operation is
/// same-volume and atomically exposes complete contents to other processes.
fn publish_machine_salt(path: &Path, candidate: [u8; 32]) -> io::Result<[u8; 32]> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Encryption salt path has no parent: {}", path.display()),
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Failed to create encryption salt directory {}: {error}",
                parent.display()
            ),
        )
    })?;

    let temp_path = parent.join(format!(
        ".salt.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "Failed to create temporary encryption salt {}: {error}",
                    temp_path.display()
                ),
            )
        })?;

    let encoded = hex::encode(candidate);
    let write_result = temp_file
        .write_all(encoded.as_bytes())
        .and_then(|_| temp_file.sync_all());
    drop(temp_file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io::Error::new(
            error.kind(),
            format!(
                "Failed to persist temporary encryption salt {}: {error}",
                temp_path.display()
            ),
        ));
    }

    let publish_result = fs::hard_link(&temp_path, path);
    let _ = fs::remove_file(&temp_path);
    match publish_result {
        Ok(()) => Ok(candidate),
        Err(publish_error) => match read_machine_salt(path) {
            // Another process won the no-clobber publish race.
            Ok(Some(winner)) => Ok(winner),
            Ok(None) => Err(io::Error::new(
                publish_error.kind(),
                format!(
                    "Failed to atomically publish encryption salt {}: {publish_error}; target is still missing",
                    path.display()
                ),
            )),
            Err(read_error) => Err(io::Error::new(
                publish_error.kind(),
                format!(
                    "Failed to atomically publish encryption salt {}: {publish_error}; target could not be read: {read_error}",
                    path.display()
                ),
            )),
        },
    }
}

fn load_or_create_machine_salt_at<F>(path: &Path, generate: F) -> io::Result<[u8; 32]>
where
    F: FnOnce() -> io::Result<[u8; 32]>,
{
    if let Some(existing) = read_machine_salt(path)? {
        return Ok(existing);
    }

    publish_machine_salt(path, generate()?)
}

/// Load or generate a persistent salt once per process. Initialization errors
/// are fatal instead of producing ciphertext that cannot be decrypted later.
fn get_or_create_machine_salt() -> [u8; 32] {
    *MACHINE_SALT.get_or_init(|| {
        let salt_path = get_salt_file_path()
            .unwrap_or_else(|error| panic!("Failed to locate gxAgent encryption salt: {error}"));
        load_or_create_machine_salt_at(&salt_path, generate_machine_salt).unwrap_or_else(|error| {
            panic!(
                "Failed to initialize gxAgent encryption salt {}: {error}",
                salt_path.display()
            )
        })
    })
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
    if plaintext.is_empty() || plaintext.starts_with("enc:") {
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
    use std::sync::{Arc, Barrier};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("gxagent-crypto-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create crypto test directory");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn concurrent_first_run_salt_initialization_uses_one_winner() {
        const WORKERS: usize = 16;
        let directory = TestDir::new();
        let salt_path = Arc::new(directory.path.join(".salt"));
        let generation_barrier = Arc::new(Barrier::new(WORKERS));

        let handles: Vec<_> = (0..WORKERS)
            .map(|index| {
                let salt_path = Arc::clone(&salt_path);
                let generation_barrier = Arc::clone(&generation_barrier);
                std::thread::spawn(move || {
                    load_or_create_machine_salt_at(&salt_path, || {
                        // Every worker has already observed the missing file
                        // before any candidate can be published.
                        generation_barrier.wait();
                        Ok([(index + 1) as u8; 32])
                    })
                    .expect("initialize salt concurrently")
                })
            })
            .collect();

        let salts: Vec<[u8; 32]> = handles
            .into_iter()
            .map(|handle| handle.join().expect("salt worker panicked"))
            .collect();
        assert!(salts.iter().all(|salt| salt == &salts[0]));
        assert_eq!(
            read_machine_salt(&salt_path).expect("read persisted salt"),
            Some(salts[0])
        );

        let reused = load_or_create_machine_salt_at(&salt_path, || {
            panic!("an existing salt must not be regenerated")
        })
        .expect("reuse existing salt");
        assert_eq!(reused, salts[0]);
        assert_eq!(
            fs::read_dir(&directory.path)
                .expect("read crypto test directory")
                .count(),
            1,
            "temporary salt files should be cleaned up"
        );
    }

    #[test]
    fn invalid_existing_salt_is_not_silently_replaced() {
        let directory = TestDir::new();
        let salt_path = directory.path.join(".salt");
        fs::write(&salt_path, "not-a-valid-salt").expect("write invalid salt");

        let error = load_or_create_machine_salt_at(&salt_path, || {
            panic!("invalid existing salt must not be replaced")
        })
        .expect_err("invalid salt should fail");

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read_to_string(&salt_path).expect("read invalid salt"),
            "not-a-valid-salt"
        );
    }

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
