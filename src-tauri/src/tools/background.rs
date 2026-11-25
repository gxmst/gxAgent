use crate::text::IncrementalUtf8Decoder;
use crate::workspace;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const MAX_LIVE_BG_PROCESSES: usize = 8;
const MAX_BG_LOG_BYTES: usize = 256 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub work_dir: String,
    pub pid: Option<u32>,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub output_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessOutput {
    pub id: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub output: String,
}

struct BackgroundEntry {
    id: String,
    label: String,
    command: String,
    work_dir: String,
    pid: Option<u32>,
    started_at: u64,
    running: bool,
    exit_code: Option<i32>,
    child: Option<Child>,
    log: Arc<StdMutex<String>>,
    readers: Vec<JoinHandle<()>>,
}

static GLOBAL_BG_PROCESSES: Lazy<Mutex<HashMap<String, BackgroundEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn append_ring_log(log: &Arc<StdMutex<String>>, text: &str) {
    if text.is_empty() {
        return;
    }
    let mut guard = log.lock().unwrap_or_else(|e| e.into_inner());
    guard.push_str(text);
    if guard.len() > MAX_BG_LOG_BYTES {
        let excess = guard.len() - MAX_BG_LOG_BYTES;
        let mut drain_to = excess;
        while drain_to < guard.len() && !guard.is_char_boundary(drain_to) {
            drain_to += 1;
        }
        guard.drain(..drain_to);
    }
}

fn spawn_bg_reader<R>(reader: R, prefix: &'static str, log: Arc<StdMutex<String>>) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = reader;
        let mut decoder = IncrementalUtf8Decoder::default();
        let mut buffer = [0u8; 4096];
        let mut wrote_prefix = false;
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = decoder.push(&buffer[..n]);
                    if !chunk.is_empty() {
                        if prefix == "[stderr] " && !wrote_prefix {
                            append_ring_log(&log, prefix);
                            wrote_prefix = true;
                        }
                        append_ring_log(&log, &chunk);
                    }
                }
                Err(_) => break,
            }
        }
        let rem = decoder.finish();
        if !rem.is_empty() {
            append_ring_log(&log, &rem);
        }
    })
}

fn refresh_entry_status(entry: &mut BackgroundEntry) {
    if !entry.running {
        return;
    }
    if let Some(child) = entry.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                entry.running = false;
                entry.exit_code = status.code();
            }
            Ok(None) => {}
            Err(_) => {
                entry.running = false;
            }
        }
    } else {
        entry.running = false;
    }
}

fn entry_info(entry: &BackgroundEntry) -> BackgroundProcessInfo {
    let output_bytes = entry.log.lock().unwrap_or_else(|e| e.into_inner()).len();
    BackgroundProcessInfo {
        id: entry.id.clone(),
        label: entry.label.clone(),
        command: entry.command.clone(),
        work_dir: entry.work_dir.clone(),
        pid: entry.pid,
        running: entry.running,
        exit_code: entry.exit_code,
        started_at: entry.started_at,
        output_bytes,
    }
}

async fn kill_background_entry(mut entry: BackgroundEntry) {
    for handle in &entry.readers {
        handle.abort();
    }
    if let Some(mut child) = entry.child.take() {
        super::process::terminate_process_tree(&mut child).await;
    }
}

pub async fn start_background_process(
    command: &str,
    work_dir: &str,
    label: Option<&str>,
) -> Result<BackgroundProcessInfo, String> {
    let trimmed_cmd = command.trim();
    if trimmed_cmd.is_empty() {
        return Err("Command cannot be empty".into());
    }
    let resolved_dir = workspace::ensure_workspace_dir(work_dir, false)?;

    {
        let mut map = GLOBAL_BG_PROCESSES.lock().await;
        let now = now_secs();
        map.retain(|_, entry| {
            refresh_entry_status(entry);
            entry.running || now.saturating_sub(entry.started_at) < 600
        });
        let live_count = map.values().filter(|e| e.running).count();
        if live_count >= MAX_LIVE_BG_PROCESSES {
            return Err(format!(
                "Maximum live background processes ({}) reached. Stop an existing process first.",
                MAX_LIVE_BG_PROCESSES
            ));
        }
    }

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", trimmed_cmd]);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", trimmed_cmd]);
        #[cfg(not(windows))]
        c.process_group(0);
        c
    };

    super::process::scrub_sensitive_env(&mut cmd);
    cmd.current_dir(&resolved_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start background process: {e}"))?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let log = Arc::new(StdMutex::new(String::new()));
    let h_out = spawn_bg_reader(stdout, "", log.clone());
    let h_err = spawn_bg_reader(stderr, "[stderr] ", log.clone());

    let id = format!("bg-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let display_label = label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| trimmed_cmd.chars().take(48).collect());

    let entry = BackgroundEntry {
        id: id.clone(),
        label: display_label,
        command: trimmed_cmd.to_string(),
        work_dir: resolved_dir.to_string_lossy().into_owned(),
        pid,
        started_at: now_secs(),
        running: true,
        exit_code: None,
        child: Some(child),
        log,
        readers: vec![h_out, h_err],
    };
    let info = entry_info(&entry);
    let mut map = GLOBAL_BG_PROCESSES.lock().await;
    let now = now_secs();
    map.retain(|_, existing| {
        refresh_entry_status(existing);
        existing.running || now.saturating_sub(existing.started_at) < 600
    });
    let live_count = map.values().filter(|e| e.running).count();
    if live_count >= MAX_LIVE_BG_PROCESSES {
        drop(map);
        kill_background_entry(entry).await;
        return Err(format!(
            "Maximum live background processes ({}) reached. Stop an existing process first.",
            MAX_LIVE_BG_PROCESSES
        ));
    }
    map.insert(id, entry);
    Ok(info)
}

pub async fn read_background_output(
    process_id: &str,
    tail_lines: usize,
) -> Result<BackgroundProcessOutput, String> {
    let mut map = GLOBAL_BG_PROCESSES.lock().await;
    let entry = map
        .get_mut(process_id.trim())
        .ok_or_else(|| format!("Background process '{}' not found", process_id))?;
    refresh_entry_status(entry);

    let full = entry.log.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let limit = tail_lines.clamp(1, 500);
    let lines: Vec<&str> = full.lines().collect();
    let sliced = if lines.len() > limit {
        lines[lines.len() - limit..].join("\n")
    } else {
        full
    };

    Ok(BackgroundProcessOutput {
        id: entry.id.clone(),
        running: entry.running,
        exit_code: entry.exit_code,
        output: sliced,
    })
}

pub async fn stop_background_process(process_id: &str) -> Result<String, String> {
    let entry = GLOBAL_BG_PROCESSES
        .lock()
        .await
        .remove(process_id.trim())
        .ok_or_else(|| format!("Background process '{}' not found", process_id))?;
    let id = entry.id.clone();
    kill_background_entry(entry).await;
    Ok(format!("Stopped background process '{}'.", id))
}

pub async fn stop_all_background_processes() {
    let entries: Vec<_> = GLOBAL_BG_PROCESSES
        .lock()
        .await
        .drain()
        .map(|(_, entry)| entry)
        .collect();
    for entry in entries {
        kill_background_entry(entry).await;
    }
}

pub async fn list_background_processes_internal() -> Vec<BackgroundProcessInfo> {
    let mut map = GLOBAL_BG_PROCESSES.lock().await;
    let mut list = Vec::with_capacity(map.len());
    for entry in map.values_mut() {
        refresh_entry_status(entry);
        list.push(entry_info(entry));
    }
    list.sort_by(|a, b| b.started_at.cmp(&a.started_at).then(a.id.cmp(&b.id)));
    list
}

#[tauri::command]
pub async fn list_background_processes() -> Result<Vec<BackgroundProcessInfo>, String> {
    Ok(list_background_processes_internal().await)
}

#[tauri::command]
pub async fn read_background_output_cmd(
    process_id: String,
    tail_lines: Option<usize>,
) -> Result<BackgroundProcessOutput, String> {
    read_background_output(&process_id, tail_lines.unwrap_or(100)).await
}

#[tauri::command]
pub async fn stop_background_process_cmd(process_id: String) -> Result<String, String> {
    stop_background_process(&process_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn background_process_lifecycle_captures_output_lists_and_stops() {
        let dir = std::env::temp_dir().join(format!("gx-bg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cmd = if cfg!(windows) {
            "Write-Output 'bg-hello'; Start-Sleep -Seconds 5"
        } else {
            "echo bg-hello; sleep 5"
        };
        let info = start_background_process(cmd, &dir.to_string_lossy(), Some("echo-test"))
            .await
            .unwrap();
        assert!(info.running);
        assert_eq!(info.label, "echo-test");

        let mut captured = String::new();
        for _ in 0..30 {
            let out = read_background_output(&info.id, 50).await.unwrap();
            if out.output.contains("bg-hello") {
                captured = out.output;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(captured.contains("bg-hello"), "captured: {captured}");

        let list = list_background_processes_internal().await;
        assert!(list.iter().any(|p| p.id == info.id));

        let stopped = stop_background_process(&info.id).await.unwrap();
        assert!(stopped.contains(&info.id));

        let _ = std::fs::remove_dir_all(dir);
    }
}
