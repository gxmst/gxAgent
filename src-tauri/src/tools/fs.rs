use crate::workspace;
use chrono::{Local, Utc};
use serde_json::Value;
use std::path::Path;

pub(super) const FILE_SIZE_LIMIT: usize = 1024 * 1024; // 1MB

const BLOCKED_PATH_PREFIXES: &[&str] = &[
    r"\Windows\System32",
    r"\Windows\SysWOW64",
    r"\Windows\System32\config",
    r"\ProgramData",
    r"\Users\All Users",
    r"\.ssh",
    r"\.gnupg",
    r"\.aws",
    r"\.kube",
    r"\.config\gcloud",
    r"\AppData\Roaming\Microsoft\Credentials",
    r"\AppData\Local\Microsoft\Credentials",
];

/// Resolve a path against the working directory.
/// When `work_dir` is set, ALL paths (absolute or relative) must resolve within
/// the work_dir boundary. This prevents both traversal attacks and absolute-path
/// sandbox escapes (e.g. reading `C:\Users\...\.ssh\id_rsa`).
pub(super) fn resolve_path(path: &str, work_dir: &str) -> Result<String, String> {
    let resolved = workspace::resolve_within_workspace(path, work_dir)?;
    let resolved = resolved.to_string_lossy().to_string();
    check_blocked_path(&resolved)?;
    Ok(resolved)
}

fn check_blocked_path(resolved: &str) -> Result<(), String> {
    let lower = resolved.to_lowercase();
    for prefix in BLOCKED_PATH_PREFIXES {
        if lower.contains(&prefix.to_lowercase()) {
            return Err(format!(
                "Access denied: path '{}' is in a protected system directory",
                resolved
            ));
        }
    }
    Ok(())
}

const MAX_LINE_SLICE_LINES: usize = 1000;
const MAX_LINE_SLICE_BYTES: usize = 200 * 1024;

pub(super) async fn run_read_file_with_options(
    path: &str,
    work_dir: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
    line_numbers: bool,
) -> Result<String, String> {
    let full_path = resolve_path(path, work_dir)?;

    let metadata = tokio::fs::metadata(&full_path)
        .await
        .map_err(|e| format!("Cannot access file: {}", e))?;

    if start_line.is_some() || end_line.is_some() || line_numbers {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let start = start_line.unwrap_or(1).max(1);
        let requested_end = end_line.unwrap_or(usize::MAX).max(start);
        let file = tokio::fs::File::open(&full_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;
        let mut reader = BufReader::new(file).lines();
        let mut collected = Vec::new();
        let mut total_lines = 0usize;
        let mut total_bytes = 0usize;
        let mut actual_end = 0usize;
        let mut capped = false;

        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?
        {
            total_lines += 1;
            if total_lines < start || total_lines > requested_end || capped {
                continue;
            }
            if collected.len() >= MAX_LINE_SLICE_LINES
                || total_bytes.saturating_add(line.len()) > MAX_LINE_SLICE_BYTES
            {
                capped = true;
                continue;
            }
            total_bytes += line.len() + 1;
            actual_end = total_lines;
            if line_numbers {
                collected.push(format!("{}: {}", total_lines, line));
            } else {
                collected.push(line);
            }
        }

        if total_lines == 0 {
            return Ok(String::new());
        }
        if start > total_lines {
            return Err(format!(
                "Requested start_line {} exceeds file length ({} lines)",
                start, total_lines
            ));
        }

        let mut output = if start_line.is_some() || end_line.is_some() || capped {
            format!("[Lines {}-{} of {}]\n", start, actual_end, total_lines)
        } else {
            String::new()
        };
        output.push_str(&collected.join("\n"));
        if capped {
            output.push_str(&format!(
                "\n\n[Output capped at {} lines / {} KB. Call read_file with start_line={} to continue.]",
                MAX_LINE_SLICE_LINES,
                MAX_LINE_SLICE_BYTES / 1024,
                actual_end + 1
            ));
        }
        return Ok(output);
    }

    if metadata.len() as usize > FILE_SIZE_LIMIT {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(&full_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;
        let mut reader = tokio::io::BufReader::new(file);
        let mut buffer = vec![0u8; FILE_SIZE_LIMIT];
        let bytes_read = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        buffer.truncate(bytes_read);
        let content = String::from_utf8(buffer)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string());
        Ok(format!(
            "{}\n\n[File truncated at {}KB. Pass start_line and end_line to read a specific slice.]",
            &content,
            FILE_SIZE_LIMIT / 1024
        ))
    } else {
        tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))
    }
}

pub(super) async fn run_write_file(
    path: &str,
    content: &str,
    work_dir: &str,
) -> Result<(), String> {
    let full_path = resolve_path(path, work_dir)?;
    if let Some(parent) = Path::new(&full_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&full_path, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

pub(super) async fn run_list_dir(path: &str, work_dir: &str) -> Result<String, String> {
    let full_path = resolve_path(path, work_dir)?;

    let path_obj = Path::new(&full_path);
    if !path_obj.exists() {
        return Err(format!("Directory not found: {}", full_path));
    }

    let mut entries = tokio::fs::read_dir(&full_path)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            result.push(format!("{}/", name));
        } else {
            result.push(name);
        }
    }

    if result.is_empty() {
        Ok("(empty directory)".to_string())
    } else {
        Ok(result.join("\n"))
    }
}

pub(super) fn run_current_time(args: &Value) -> String {
    let timezone = args["timezone"]
        .as_str()
        .unwrap_or("local")
        .trim()
        .to_ascii_lowercase();
    let local = Local::now();
    let utc = Utc::now();
    match timezone.as_str() {
        "local" | "" => format!(
            "Current local time: {}\nUTC: {}",
            local.format("%Y-%m-%d %H:%M:%S %:z"),
            utc.format("%Y-%m-%d %H:%M:%S %:z")
        ),
        "utc" => format!(
            "Current UTC time: {}\nLocal time: {}",
            utc.format("%Y-%m-%d %H:%M:%S %:z"),
            local.format("%Y-%m-%d %H:%M:%S %:z")
        ),
        other => format!(
            "Error: Unsupported timezone '{}'. Use 'local' or 'utc'.",
            other
        ),
    }
}

/// Render an agent-managed todo list into a compact checklist.
pub(super) fn run_todo_write(args: &Value) -> String {
    let todos = match args["todos"].as_array() {
        Some(t) if !t.is_empty() => t,
        _ => {
            return "Error: todos must be a non-empty array of { content, status } items."
                .to_string()
        }
    };

    let mut out = String::from("Todo list updated:\n");
    let mut pending = 0usize;
    let mut in_progress = 0usize;
    let mut completed = 0usize;
    for item in todos {
        let content = item["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let status = item["status"].as_str().unwrap_or("pending");
        let (marker, label) = match status {
            "completed" => {
                completed += 1;
                ("[x]", "")
            }
            "in_progress" => {
                in_progress += 1;
                ("[~]", " (in progress)")
            }
            _ => {
                pending += 1;
                ("[ ]", "")
            }
        };
        out.push_str(&format!("{} {}{}\n", marker, content, label));
    }
    out.push_str(&format!(
        "\n{} done · {} in progress · {} pending.",
        completed, in_progress, pending
    ));
    out
}
