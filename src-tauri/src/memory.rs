use crate::app_paths;
use crate::storage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_MEMORIES_PER_WORKSPACE: usize = 100;
const MAX_MEMORY_CONTENT_CHARS: usize = 1_000;
const MAX_MEMORY_KEY_CHARS: usize = 120;
const MAX_PROMPT_MEMORIES: usize = 25;
const MAX_PROMPT_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub category: String,
    pub key: String,
    pub content: String,
    pub updated_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn normalize_category(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "user" => "user",
        "feedback" => "feedback",
        "reference" => "reference",
        _ => "project",
    }
}

fn workspace_identity(work_dir: &str) -> String {
    let trimmed = work_dir.trim();
    let resolved = if trimmed.is_empty() {
        "global".to_string()
    } else if let Ok(canon) = std::fs::canonicalize(trimmed) {
        canon.to_string_lossy().into_owned()
    } else {
        trimmed.to_string()
    };
    let stripped = resolved.strip_prefix(r"\\?\").unwrap_or(&resolved);
    let normalized = stripped
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

static MEMORY_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

fn memory_store_path(work_dir: &str) -> Result<PathBuf, String> {
    let dir = app_paths::data_dir()
        .ok_or_else(|| "Data directory is unavailable".to_string())?
        .join("memories");
    let digest = Sha256::digest(workspace_identity(work_dir).as_bytes());
    Ok(dir.join(format!("{}.json", hex::encode(&digest[..12]))))
}

pub(crate) fn load_memories_from_path(path: &Path) -> Result<Vec<MemoryEntry>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<MemoryEntry> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.key.cmp(&b.key)));
    Ok(entries)
}

fn write_memories_to_path(path: &Path, entries: &[MemoryEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    storage::atomic_write(path, json.as_bytes())
}

pub(crate) fn upsert_memory_at_path(
    path: &Path,
    category: &str,
    key: &str,
    content: &str,
) -> Result<MemoryEntry, String> {
    let clean_key: String = key.trim().chars().take(MAX_MEMORY_KEY_CHARS).collect();
    let clean_content: String = content
        .trim()
        .chars()
        .take(MAX_MEMORY_CONTENT_CHARS)
        .collect();
    if clean_key.is_empty() || clean_content.is_empty() {
        return Err("Memory key and content must both be non-empty".into());
    }
    let cat = normalize_category(category).to_string();
    let now = now_secs();

    let _guard = MEMORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_memories_from_path(path)?;
    let saved = if let Some(existing) = entries
        .iter_mut()
        .find(|e| e.key.eq_ignore_ascii_case(&clean_key))
    {
        existing.category = cat;
        existing.key = clean_key;
        existing.content = clean_content;
        existing.updated_at = now;
        existing.clone()
    } else {
        let entry = MemoryEntry {
            id: format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            category: cat,
            key: clean_key,
            content: clean_content,
            updated_at: now,
        };
        entries.push(entry.clone());
        entry
    };

    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.key.cmp(&b.key)));
    entries.truncate(MAX_MEMORIES_PER_WORKSPACE);
    write_memories_to_path(path, &entries)?;
    Ok(saved)
}

pub(crate) fn remove_memory_at_path(path: &Path, id_or_key: &str) -> Result<bool, String> {
    let target = id_or_key.trim();
    if target.is_empty() {
        return Err("Memory id or key is required".into());
    }
    let _guard = MEMORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_memories_from_path(path)?;
    let before = entries.len();
    entries.retain(|e| e.id != target && !e.key.eq_ignore_ascii_case(target));
    if entries.len() == before {
        return Ok(false);
    }
    write_memories_to_path(path, &entries)?;
    Ok(true)
}

pub fn load_memories(work_dir: &str) -> Result<Vec<MemoryEntry>, String> {
    let path = memory_store_path(work_dir)?;
    load_memories_from_path(&path)
}

pub fn upsert_memory(
    work_dir: &str,
    category: &str,
    key: &str,
    content: &str,
) -> Result<MemoryEntry, String> {
    let path = memory_store_path(work_dir)?;
    upsert_memory_at_path(&path, category, key, content)
}

pub fn remove_memory(work_dir: &str, id_or_key: &str) -> Result<bool, String> {
    let path = memory_store_path(work_dir)?;
    remove_memory_at_path(&path, id_or_key)
}

pub fn format_memories_for_prompt(entries: &[MemoryEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.key.cmp(&b.key)));

    let mut out = String::from(
        "\n\n[Persistent Project Memory — treat as prior session notes; verify against current files]\n",
    );
    let mut total_chars = 0usize;
    for entry in sorted.into_iter().take(MAX_PROMPT_MEMORIES) {
        let line = format!("- [{}] {}: {}\n", entry.category, entry.key, entry.content);
        if total_chars + line.chars().count() > MAX_PROMPT_CHARS {
            break;
        }
        total_chars += line.chars().count();
        out.push_str(&line);
    }
    out.push_str("[End project memory]");
    out
}

#[tauri::command]
pub fn list_project_memories(work_dir: String) -> Result<Vec<MemoryEntry>, String> {
    load_memories(&work_dir)
}

#[tauri::command]
pub fn save_project_memory(
    work_dir: String,
    category: String,
    key: String,
    content: String,
) -> Result<MemoryEntry, String> {
    upsert_memory(&work_dir, &category, &key, &content)
}

#[tauri::command]
pub fn delete_project_memory(work_dir: String, id_or_key: String) -> Result<bool, String> {
    remove_memory(&work_dir, &id_or_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_upsert_dedup_remove_and_prompt_formatting() {
        let dir = std::env::temp_dir().join(format!("gx-mem-{}", uuid::Uuid::new_v4()));
        let path = dir.join("store.json");

        let e1 =
            upsert_memory_at_path(&path, "feedback", "pkg-manager", "Always use pnpm").unwrap();
        assert_eq!(e1.category, "feedback");

        let e2 = upsert_memory_at_path(&path, "feedback", "PKG-MANAGER", "Use npm only").unwrap();
        assert_eq!(e2.id, e1.id);

        upsert_memory_at_path(&path, "project", "ci-cmd", "Run cargo test before PR").unwrap();

        let loaded = load_memories_from_path(&path).unwrap();
        assert_eq!(loaded.len(), 2);

        let prompt = format_memories_for_prompt(&loaded);
        assert!(prompt.contains("[feedback] PKG-MANAGER: Use npm only"));
        assert!(prompt.contains("[project] ci-cmd: Run cargo test before PR"));

        assert!(remove_memory_at_path(&path, "ci-cmd").unwrap());
        assert!(!remove_memory_at_path(&path, "missing").unwrap());
        assert_eq!(load_memories_from_path(&path).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }
}
