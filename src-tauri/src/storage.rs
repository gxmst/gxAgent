use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const INDEX_FILE: &str = "_index.json";

#[derive(Debug, Serialize, Deserialize)]
struct SessionIndex {
    ids: Vec<String>,
}

fn get_sessions_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or("Failed to get data directory")?
        .join("gxAgent")
        .join("sessions");

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid session id length".to_string());
    }

    if id == "_index" {
        return Err("Reserved session id".to_string());
    }

    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session id characters".to_string());
    }

    Ok(())
}

fn session_id_from_value(session: &Value) -> Result<String, String> {
    let id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Session is missing id".to_string())?;
    validate_session_id(id)?;
    Ok(id.to_string())
}

fn session_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    validate_session_id(id)?;
    Ok(dir.join(format!("{}.json", id)))
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

fn read_index(dir: &Path) -> Vec<String> {
    fs::read_to_string(index_path(dir))
        .ok()
        .and_then(|json| serde_json::from_str::<SessionIndex>(&json).ok())
        .map(|idx| {
            idx.ids
                .into_iter()
                .filter(|id| validate_session_id(id).is_ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_index(dir: &Path, ids: &[String]) -> Result<(), String> {
    let index = SessionIndex { ids: ids.to_vec() };
    let json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    fs::write(index_path(dir), json).map_err(|e| e.to_string())
}

fn list_session_ids_from_dir(dir: &Path) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some(INDEX_FILE) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
            if validate_session_id(id).is_ok() {
                ids.push(id.to_string());
            }
        }
    }

    ids.sort();
    Ok(ids)
}

#[tauri::command]
pub fn save_session(session: Value) -> Result<(), String> {
    let id = session_id_from_value(&session)?;
    let dir = get_sessions_dir()?;
    let path = session_path(&dir, &id)?;
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;

    let mut ids = read_index(&dir);
    if !ids.iter().any(|existing| existing == &id) {
        ids.push(id);
        write_index(&dir, &ids)?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_sessions(sessions: Vec<Value>) -> Result<(), String> {
    let dir = get_sessions_dir()?;
    let mut ids = Vec::with_capacity(sessions.len());
    let mut seen = HashSet::new();

    for session in &sessions {
        let id = session_id_from_value(session)?;
        if !seen.insert(id.clone()) {
            return Err(format!("Duplicate session id: {}", id));
        }
        ids.push(id);
    }

    for session in &sessions {
        let id = session_id_from_value(session)?;
        let path = session_path(&dir, &id)?;
        let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())?;
    }

    let current = seen;
    for existing_id in list_session_ids_from_dir(&dir)? {
        if !current.contains(&existing_id) {
            let _ = fs::remove_file(session_path(&dir, &existing_id)?);
        }
    }

    write_index(&dir, &ids)
}

#[tauri::command]
pub fn load_session(id: String) -> Result<Value, String> {
    let dir = get_sessions_dir()?;
    let path = session_path(&dir, &id)?;
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_sessions() -> Result<Vec<Value>, String> {
    let dir = get_sessions_dir()?;
    let mut sessions = Vec::new();
    let mut loaded = HashSet::new();

    for id in read_index(&dir) {
        if let Ok(session) = load_session(id.clone()) {
            sessions.push(session);
            loaded.insert(id);
        }
    }

    for id in list_session_ids_from_dir(&dir)? {
        if loaded.contains(&id) {
            continue;
        }
        if let Ok(session) = load_session(id.clone()) {
            sessions.push(session);
            loaded.insert(id);
        }
    }

    Ok(sessions)
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<String>, String> {
    let dir = get_sessions_dir()?;
    let indexed = read_index(&dir);
    if !indexed.is_empty() {
        return Ok(indexed);
    }
    list_session_ids_from_dir(&dir)
}

#[tauri::command]
pub fn delete_session(id: String) -> Result<(), String> {
    let dir = get_sessions_dir()?;
    let path = session_path(&dir, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }

    let mut ids = read_index(&dir);
    ids.retain(|existing| existing != &id);
    write_index(&dir, &ids)?;

    Ok(())
}

pub fn clear_sessions() -> Result<(), String> {
    let dir = get_sessions_dir()?;
    for id in list_session_ids_from_dir(&dir)? {
        let _ = fs::remove_file(session_path(&dir, &id)?);
    }
    let index = index_path(&dir);
    if index.exists() {
        let _ = fs::remove_file(index);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_ids() {
        assert!(validate_session_id("../config").is_err());
        assert!(validate_session_id("..\\config").is_err());
        assert!(validate_session_id("session/123").is_err());
    }

    #[test]
    fn accepts_generated_session_ids() {
        assert!(validate_session_id("default").is_ok());
        assert!(validate_session_id("session-1712345678901").is_ok());
        assert!(validate_session_id("abc_DEF-123").is_ok());
    }
}
