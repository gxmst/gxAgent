use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const INDEX_FILE: &str = "_index.json";
const TEMP_FILE_PREFIX: &str = ".gxagent-tmp-";
const TEMP_FILE_SUFFIX: &str = ".tmp";

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

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

fn with_sessions_dir<T>(operation: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Session storage lock is poisoned".to_string())?;
    let dir = get_sessions_dir()?;
    cleanup_temp_files(&dir)?;
    operation(&dir)
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
    let json = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
    atomic_write(&index_path(dir), &json)
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

fn ordered_session_ids(dir: &Path) -> Result<Vec<String>, String> {
    let disk_ids = list_session_ids_from_dir(dir)?;
    let mut remaining: HashSet<String> = disk_ids.iter().cloned().collect();
    let mut ordered = Vec::with_capacity(disk_ids.len());

    for id in read_index(dir) {
        if remaining.remove(&id) {
            ordered.push(id);
        }
    }

    for id in disk_ids {
        if remaining.remove(&id) {
            ordered.push(id);
        }
    }

    Ok(ordered)
}

fn is_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(TEMP_FILE_PREFIX) && name.ends_with(TEMP_FILE_SUFFIX))
        .unwrap_or(false)
}

fn cleanup_temp_files(dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_type().map_err(|e| e.to_string())?.is_file() && is_temp_file(&path) {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove temporary file {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(
        "{TEMP_FILE_PREFIX}{}{TEMP_FILE_SUFFIX}",
        uuid::Uuid::new_v4()
    ));

    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);

        replace_file(&temp_path, path)?;
        sync_parent_dir(parent)?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let cleanup_result = fs::remove_file(&temp_path);
        if let Err(cleanup_error) = cleanup_result {
            if cleanup_error.kind() != io::ErrorKind::NotFound {
                return Err(format!(
                    "Failed to atomically write {}: {error}; failed to clean up {}: {cleanup_error}",
                    path.display(),
                    temp_path.display()
                ));
            }
        }
        return Err(format!(
            "Failed to atomically write {}: {error}",
            path.display()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();

    // SAFETY: Both paths are encoded as valid, null-terminated UTF-16 buffers and remain alive
    // for the duration of the Win32 call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

fn save_session_in_dir(dir: &Path, session: &Value) -> Result<(), String> {
    let id = session_id_from_value(session)?;
    let path = session_path(dir, &id)?;
    let json = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)?;

    let ids = ordered_session_ids(dir)?;
    write_index(dir, &ids)
}

fn save_sessions_in_dir(dir: &Path, sessions: &[Value]) -> Result<(), String> {
    let mut ids = Vec::with_capacity(sessions.len());
    let mut seen = HashSet::new();

    for session in sessions {
        let id = session_id_from_value(session)?;
        if !seen.insert(id.clone()) {
            return Err(format!("Duplicate session id: {}", id));
        }
        ids.push(id);
    }

    for (session, id) in sessions.iter().zip(&ids) {
        let path = session_path(dir, id)?;
        let json = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
        atomic_write(&path, &json)?;
    }

    for existing_id in list_session_ids_from_dir(dir)? {
        if !seen.contains(&existing_id) {
            remove_file_if_exists(&session_path(dir, &existing_id)?)?;
        }
    }

    write_index(dir, &ids)
}

fn load_session_from_dir(dir: &Path, id: &str) -> Result<Value, String> {
    let path = session_path(dir, id)?;
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

fn load_sessions_from_dir(dir: &Path) -> Result<Vec<Value>, String> {
    let mut sessions = Vec::new();
    for id in ordered_session_ids(dir)? {
        if let Ok(session) = load_session_from_dir(dir, &id) {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

fn delete_session_from_dir(dir: &Path, id: &str) -> Result<(), String> {
    remove_file_if_exists(&session_path(dir, id)?)?;
    let ids = ordered_session_ids(dir)?;
    write_index(dir, &ids)
}

fn clear_sessions_from_dir(dir: &Path) -> Result<(), String> {
    for id in list_session_ids_from_dir(dir)? {
        remove_file_if_exists(&session_path(dir, &id)?)?;
    }
    remove_file_if_exists(&index_path(dir))
}

#[tauri::command]
pub fn save_session(session: Value) -> Result<(), String> {
    with_sessions_dir(|dir| save_session_in_dir(dir, &session))
}

#[tauri::command]
pub fn save_sessions(sessions: Vec<Value>) -> Result<(), String> {
    with_sessions_dir(|dir| save_sessions_in_dir(dir, &sessions))
}

#[tauri::command]
pub fn load_session(id: String) -> Result<Value, String> {
    with_sessions_dir(|dir| load_session_from_dir(dir, &id))
}

#[tauri::command]
pub fn load_sessions() -> Result<Vec<Value>, String> {
    with_sessions_dir(load_sessions_from_dir)
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<String>, String> {
    with_sessions_dir(ordered_session_ids)
}

#[tauri::command]
pub fn delete_session(id: String) -> Result<(), String> {
    with_sessions_dir(|dir| delete_session_from_dir(dir, &id))
}

pub fn clear_sessions() -> Result<(), String> {
    with_sessions_dir(clear_sessions_from_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("gxagent-storage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn assert_no_temp_files(dir: &Path) {
        let has_temp_file = fs::read_dir(dir)
            .expect("read test directory")
            .filter_map(Result::ok)
            .any(|entry| is_temp_file(&entry.path()));
        assert!(!has_temp_file, "atomic write left a temporary file behind");
    }

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

    #[test]
    fn atomic_write_creates_and_replaces_files() {
        let dir = TestDir::new();
        let path = dir.path().join("session.json");

        atomic_write(&path, b"first").expect("initial atomic write");
        assert_eq!(fs::read(&path).expect("read initial file"), b"first");

        atomic_write(&path, b"second").expect("replacement atomic write");
        assert_eq!(fs::read(&path).expect("read replaced file"), b"second");
        assert_no_temp_files(dir.path());
    }

    #[test]
    fn cleanup_removes_only_storage_temp_files() {
        let dir = TestDir::new();
        let stale_temp = dir
            .path()
            .join(format!("{TEMP_FILE_PREFIX}stale{TEMP_FILE_SUFFIX}"));
        let unrelated = dir.path().join("keep.tmp");
        fs::write(&stale_temp, b"partial").expect("write stale temp");
        fs::write(&unrelated, b"keep").expect("write unrelated temp");

        cleanup_temp_files(dir.path()).expect("clean storage temp files");

        assert!(!stale_temp.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn incremental_save_replaces_session_and_keeps_index_consistent() {
        let dir = TestDir::new();
        save_session_in_dir(dir.path(), &json!({ "id": "alpha", "title": "old" }))
            .expect("save alpha");
        save_session_in_dir(dir.path(), &json!({ "id": "beta", "title": "beta" }))
            .expect("save beta");
        save_session_in_dir(dir.path(), &json!({ "id": "alpha", "title": "new" }))
            .expect("replace alpha");

        assert_eq!(read_index(dir.path()), vec!["alpha", "beta"]);
        assert_eq!(
            ordered_session_ids(dir.path()).unwrap(),
            vec!["alpha", "beta"]
        );
        assert_eq!(
            load_session_from_dir(dir.path(), "alpha").unwrap()["title"],
            "new"
        );
        assert_no_temp_files(dir.path());
    }

    #[test]
    fn incremental_save_repairs_an_incomplete_index() {
        let dir = TestDir::new();
        atomic_write(
            &session_path(dir.path(), "orphan").unwrap(),
            &serde_json::to_vec(&json!({ "id": "orphan" })).unwrap(),
        )
        .expect("write orphan session");
        write_index(dir.path(), &[]).expect("write incomplete index");

        save_session_in_dir(dir.path(), &json!({ "id": "current" })).expect("save current session");

        assert_eq!(read_index(dir.path()), vec!["current", "orphan"]);
        assert_eq!(
            ordered_session_ids(dir.path()).unwrap(),
            vec!["current", "orphan"]
        );
    }

    #[test]
    fn bulk_save_removes_stale_sessions_and_writes_matching_index() {
        let dir = TestDir::new();
        save_sessions_in_dir(
            dir.path(),
            &[
                json!({ "id": "alpha", "title": "alpha" }),
                json!({ "id": "beta", "title": "old" }),
            ],
        )
        .expect("initial bulk save");

        save_sessions_in_dir(
            dir.path(),
            &[
                json!({ "id": "beta", "title": "new" }),
                json!({ "id": "gamma", "title": "gamma" }),
            ],
        )
        .expect("replacement bulk save");

        assert!(!session_path(dir.path(), "alpha").unwrap().exists());
        assert_eq!(read_index(dir.path()), vec!["beta", "gamma"]);
        assert_eq!(
            ordered_session_ids(dir.path()).unwrap(),
            vec!["beta", "gamma"]
        );
        assert_eq!(
            load_session_from_dir(dir.path(), "beta").unwrap()["title"],
            "new"
        );
        assert_no_temp_files(dir.path());
    }
}
