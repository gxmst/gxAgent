mod agent;
mod audit;
mod config;
mod crypto;
mod mcp;
mod policy;
mod provider;
mod storage;
mod text;
mod tools;
mod workspace;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use config::{ApiProfile, AppConfig, ProviderPreset, TrustedPattern};
use crypto::{decrypt, encrypt};
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_dialog::DialogExt;

// ==========================================
// Tauri Commands
// ==========================================

/// Start an agent session with the given config and prompt
// Tauri command: the parameter list is the frontend invoke contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_agent_session(
    window: tauri::Window,
    request_id: Option<String>,
    prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    session_mode: Option<String>,
    search_mode: Option<String>,
    image_attachments: Option<Vec<agent::ImageAttachment>>,
) -> Result<(), String> {
    workspace::ensure_workspace_dir(&config.default_work_dir, false)?;
    let mode = session_mode.unwrap_or_else(|| "chat".to_string());
    let smode = search_mode.unwrap_or_else(|| "auto".to_string());
    let images = image_attachments.unwrap_or_default();
    let request_id = request_id.unwrap_or_else(|| {
        format!(
            "req-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    });
    let result = agent::start_agent_loop(
        window.clone(),
        request_id.clone(),
        prompt,
        config,
        session_messages,
        mode,
        smode,
        images,
    )
    .await;
    if let Err(ref e) = result {
        let _ = window.emit(
            "agent-stream-chunk",
            json!({
                "requestId": request_id,
                "content": format!("\nError: {}\n", e),
            }),
        );
        let _ = window.emit(
            "agent-stream-done",
            json!({
                "requestId": request_id,
                "content": format!("Error: {}", e),
                "loopCount": 0,
                "ttftMs": 0,
                "responseTimeMs": 0,
            }),
        );
        let _ = window.emit(
            "agent-complete",
            json!({
                "requestId": request_id,
                "status": "error",
            }),
        );
        return Ok(());
    }
    result
}

fn effective_work_dir(explicit: Option<String>) -> Result<String, String> {
    let selected = match explicit.filter(|value| !value.trim().is_empty()) {
        Some(path) => path,
        None => load_config()?.default_work_dir,
    };
    Ok(workspace::ensure_workspace_dir(&selected, false)?
        .to_string_lossy()
        .to_string())
}

/// Resolve a pending tool approval request from the frontend
#[tauri::command]
async fn resolve_tool_approval(
    request_id: String,
    approved_ids: Vec<String>,
    rejected_ids: Vec<String>,
) -> Result<(), String> {
    let mut results: Vec<(String, bool)> = Vec::new();
    for id in approved_ids {
        results.push((id, true));
    }
    for id in rejected_ids {
        results.push((id, false));
    }
    agent::resolve_approval(&request_id, results).await
}

/// Cancel an active agent session by request id
#[tauri::command]
async fn cancel_agent_session(request_id: String) -> Result<(), String> {
    agent::cancel_agent_request(&request_id).await
}

/// Fetch available models for the given wire format (OpenAI/Anthropic/Gemini).
#[tauri::command]
async fn fetch_models(
    base_url: String,
    api_key: String,
    wire_format: Option<String>,
) -> Result<Vec<Value>, String> {
    let wire = provider::Wire::from_str(&wire_format.unwrap_or_default());
    agent::fetch_models(wire, &base_url, &api_key).await
}

/// Get provider presets
#[tauri::command]
fn get_provider_presets() -> Vec<ProviderPreset> {
    config::get_presets()
}

/// Get default app config
#[tauri::command]
fn get_default_config() -> Result<AppConfig, String> {
    let config = AppConfig::default();
    workspace::ensure_workspace_dir(&config.default_work_dir, true)?;
    Ok(config)
}

/// Save config to a local file (encrypts API keys)
#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    workspace::ensure_workspace_dir(&config.default_work_dir, true)?;
    persist_config(&config)?;
    Ok(())
}

fn is_legacy_encrypted_key(key: &str) -> bool {
    key.starts_with("enc:v1:") || key.starts_with("enc:v2:")
}

fn decrypt_key_for_load(key: &mut String) -> bool {
    if key.is_empty() {
        return false;
    }

    let was_legacy = is_legacy_encrypted_key(key);
    let before = key.clone();
    let decrypted = decrypt(&before);
    let migrated = was_legacy && decrypted != before && !decrypted.starts_with("enc:");
    *key = decrypted;
    migrated
}

fn repair_config_workspace(config: &mut AppConfig) -> Result<bool, String> {
    if !config.default_work_dir.trim().is_empty()
        && workspace::ensure_workspace_dir(&config.default_work_dir, true).is_ok()
    {
        return Ok(false);
    }

    let fallback = workspace::default_workspace_path();
    workspace::ensure_workspace_dir(&fallback.to_string_lossy(), true)?;
    config.default_work_dir = fallback.to_string_lossy().to_string();
    Ok(true)
}

/// Load config from local file, returns default if not found (decrypts API keys)
#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    let config_path = dirs::config_dir()
        .unwrap_or_default()
        .join("gxAgent")
        .join("config.json");

    if !config_path.exists() {
        let config = AppConfig::default();
        workspace::ensure_workspace_dir(&config.default_work_dir, true)?;
        persist_config(&config)?;
        return Ok(config);
    }

    let json = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut config: AppConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    config.role_prompt = None;

    // One-time migration: seed built-in tools added in this release so existing
    // users gain the new capabilities. Gated on a stored version marker so it
    // runs exactly once — after that, a tool the user disables stays disabled
    // instead of being re-enabled on every launch. Read-only tools are safe to
    // append broadly; edit_file follows the user's existing write_file choice.
    let mut config_changed = false;
    if config.tools_migration_version < config::CURRENT_TOOLS_MIGRATION_VERSION {
        // Each step is gated on the version it introduced, so a step never
        // re-runs for users who already passed it (re-running would undo
        // their later manual choices, e.g. re-enabling a disabled tool).
        if config.tools_migration_version < 1 {
            const NEW_READ_ONLY_TOOLS: &[&str] = &["grep", "glob", "todo_write"];
            for tool in NEW_READ_ONLY_TOOLS {
                if !config.tools_enabled.iter().any(|t| t == tool) {
                    config.tools_enabled.push((*tool).to_string());
                }
            }
            if config.tools_enabled.iter().any(|t| t == "write_file")
                && !config.tools_enabled.iter().any(|t| t == "edit_file")
            {
                config.tools_enabled.push("edit_file".to_string());
            }
        }
        if config.tools_migration_version < 2 {
            // v2: the old loop/tool-call defaults (10/30) stopped real coding
            // tasks mid-flight. Raise them to the new defaults, but only when
            // the stored value is exactly the old default — a deliberate
            // custom limit is kept as-is.
            if config.max_agent_loops == config::LEGACY_DEFAULT_MAX_AGENT_LOOPS {
                config.max_agent_loops = AppConfig::default().max_agent_loops;
            }
            if config.max_tool_calls_per_request == config::LEGACY_DEFAULT_MAX_TOOL_CALLS {
                config.max_tool_calls_per_request = AppConfig::default().max_tool_calls_per_request;
            }
        }
        config.tools_migration_version = config::CURRENT_TOOLS_MIGRATION_VERSION;
        config_changed = true;
    }

    let mut needs_rekey = false;
    needs_rekey = decrypt_key_for_load(&mut config.api_key) || needs_rekey;
    needs_rekey = decrypt_key_for_load(&mut config.search_api_key) || needs_rekey;
    for profile in config.profiles.values_mut() {
        needs_rekey = decrypt_key_for_load(&mut profile.api_key) || needs_rekey;
    }
    config_changed = repair_config_workspace(&mut config)? || config_changed;
    if needs_rekey || config_changed {
        persist_config(&config)?;
    }
    Ok(config)
}

/// List directory contents (for workspace file browser)
#[tauri::command]
async fn list_directory(path: String, work_dir: Option<String>) -> Result<String, String> {
    let work_dir = effective_work_dir(work_dir)?;
    let result = tools::execute_tool(
        "list_dir",
        &serde_json::json!({"path": path}).to_string(),
        &work_dir,
        "duckduckgo",
        "",
    )
    .await;
    if result.starts_with("Error:") {
        Err(result)
    } else {
        Ok(result)
    }
}

/// Read a file (for workspace file viewer)
#[tauri::command]
async fn read_file_content(path: String, work_dir: Option<String>) -> Result<String, String> {
    let work_dir = effective_work_dir(work_dir)?;
    let result = tools::execute_tool(
        "read_file",
        &serde_json::json!({"path": path}).to_string(),
        &work_dir,
        "duckduckgo",
        "",
    )
    .await;
    if result.starts_with("Error:") {
        Err(result)
    } else {
        Ok(result)
    }
}

/// Save code block content to a local file (with native save dialog)
#[tauri::command]
async fn save_code_file(
    app: tauri::AppHandle,
    content: String,
    language: String,
) -> Result<String, String> {
    let ext_map: std::collections::HashMap<&str, &str> = [
        ("javascript", "js"),
        ("typescript", "ts"),
        ("python", "py"),
        ("rust", "rs"),
        ("go", "go"),
        ("java", "java"),
        ("c", "c"),
        ("cpp", "cpp"),
        ("csharp", "cs"),
        ("ruby", "rb"),
        ("php", "php"),
        ("swift", "swift"),
        ("kotlin", "kt"),
        ("scala", "scala"),
        ("html", "html"),
        ("css", "css"),
        ("json", "json"),
        ("yaml", "yaml"),
        ("toml", "toml"),
        ("xml", "xml"),
        ("sql", "sql"),
        ("sh", "sh"),
        ("bash", "sh"),
        ("powershell", "ps1"),
        ("dockerfile", "dockerfile"),
        ("markdown", "md"),
        ("text", "txt"),
    ]
    .iter()
    .cloned()
    .collect();

    let ext = ext_map.get(language.as_str()).unwrap_or(&"txt");

    let dialog = app.dialog();
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog
        .file()
        .add_filter("Code File", &[ext])
        .set_file_name(format!("untitled.{}", ext))
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    match rx.await {
        Ok(Some(path)) => {
            let path_str = path.to_string();
            std::fs::write(&path_str, &content).map_err(|e| format!("Failed to save: {}", e))?;
            Ok(path_str)
        }
        Ok(None) => Ok("Cancelled".to_string()),
        Err(_) => Err("Save dialog failed".to_string()),
    }
}

/// Choose a workspace folder with the native directory picker.
#[tauri::command]
async fn pick_workspace_directory(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|selected| selected.to_string()));
    });

    rx.await.map_err(|_| "Workspace dialog failed".to_string())
}

const PARSED_FILE_CONTENT_LIMIT: usize = 250_000;
const IMAGE_ATTACHMENT_LIMIT: u64 = 20 * 1024 * 1024;
const IMAGE_ATTACHMENT_COUNT_LIMIT: usize = 8;
const IMAGE_ATTACHMENT_TOTAL_LIMIT: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedFile {
    name: String,
    path: String,
    kind: String,
    content: String,
    mime_type: String,
    truncated: bool,
    warning: Option<String>,
}

fn file_kind_and_mime(extension: &str) -> (&'static str, &'static str) {
    match extension {
        "pdf" => ("pdf", "application/pdf"),
        "docx" => (
            "document",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        "xlsx" => (
            "spreadsheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pptx" => (
            "presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        "csv" | "tsv" => ("spreadsheet", "text/csv"),
        "json" => ("json", "application/json"),
        "md" | "markdown" => ("text", "text/markdown"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        _ => ("text", "text/plain"),
    }
}

fn limited_content(content: String) -> (String, bool) {
    if content.len() <= PARSED_FILE_CONTENT_LIMIT {
        return (content, false);
    }
    (
        text::utf8_prefix(&content, PARSED_FILE_CONTENT_LIMIT).to_string(),
        true,
    )
}

async fn extract_pdf_text(path: &std::path::Path) -> Result<String, String> {
    let mut command = tokio::process::Command::new("pdftotext");
    command.args(["-layout", &path.to_string_lossy(), "-"]);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "PDF extraction timed out after 30s".to_string())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "PDF text extraction requires 'pdftotext' (Poppler) in PATH".to_string()
            } else {
                format!("Failed to start pdftotext: {}", e)
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "pdftotext failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
async fn extract_office_text(path: &std::path::Path, extension: &str) -> Result<String, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Entry($entry) {
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Decode-XmlText([string]$value) {
  return [System.Net.WebUtility]::HtmlDecode([regex]::Replace($value, '<[^>]+>', ''))
}
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:GXAGENT_FILE_PATH)
try {
  switch ($env:GXAGENT_OFFICE_KIND) {
    'docx' {
      $entry = $archive.GetEntry('word/document.xml')
      if ($null -eq $entry) { throw 'word/document.xml is missing' }
      $xml = Read-Entry $entry
      $xml = $xml -replace '</w:p>', "`n" -replace '<w:tab[^>]*/>', "`t" -replace '<w:br[^>]*/>', "`n"
      Decode-XmlText $xml
    }
    'pptx' {
      $slides = $archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide[0-9]+\.xml$' } | Sort-Object { if ($_.Name -match 'slide([0-9]+)') { [int]$Matches[1] } else { 0 } }
      foreach ($slide in $slides) {
        "`n--- $($slide.Name) ---"
        $xml = (Read-Entry $slide) -replace '</a:p>', "`n"
        Decode-XmlText $xml
      }
    }
    'xlsx' {
      $shared = @()
      $sharedEntry = $archive.GetEntry('xl/sharedStrings.xml')
      if ($null -ne $sharedEntry) {
        $sharedXml = Read-Entry $sharedEntry
        foreach ($item in [regex]::Matches($sharedXml, '(?s)<si(?:\s[^>]*)?>(.*?)</si>')) {
          $parts = [regex]::Matches($item.Groups[1].Value, '(?s)<t(?:\s[^>]*)?>(.*?)</t>') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) }
          $shared += ($parts -join '')
        }
      }
      $sheets = $archive.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet[0-9]+\.xml$' } | Sort-Object { if ($_.Name -match 'sheet([0-9]+)') { [int]$Matches[1] } else { 0 } }
      foreach ($sheet in $sheets) {
        "`n--- $($sheet.Name) ---"
        $xml = Read-Entry $sheet
        foreach ($cell in [regex]::Matches($xml, '(?s)<c\b([^>]*)>(.*?)</c>')) {
          $attrs = $cell.Groups[1].Value
          $body = $cell.Groups[2].Value
          $refMatch = [regex]::Match($attrs, '\br="([^"]+)"')
          $typeMatch = [regex]::Match($attrs, '\bt="([^"]+)"')
          $valueMatch = [regex]::Match($body, '(?s)<v>(.*?)</v>')
          $value = ''
          if ($typeMatch.Success -and $typeMatch.Groups[1].Value -eq 'inlineStr') {
            $value = Decode-XmlText $body
          } elseif ($valueMatch.Success) {
            $value = [System.Net.WebUtility]::HtmlDecode($valueMatch.Groups[1].Value)
            if ($typeMatch.Success -and $typeMatch.Groups[1].Value -eq 's') {
              $index = 0
              if ([int]::TryParse($value, [ref]$index) -and $index -lt $shared.Count) { $value = $shared[$index] }
            }
          }
          if ($value -ne '') { "$($refMatch.Groups[1].Value)`t$value" }
        }
      }
    }
  }
} finally {
  $archive.Dispose()
}
"#;

    let mut command = tokio::process::Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("GXAGENT_FILE_PATH", path)
        .env("GXAGENT_OFFICE_KIND", extension)
        .kill_on_drop(true)
        .creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Office extraction timed out after 30s".to_string())?
        .map_err(|e| format!("Failed to start Office extractor: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Office extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(windows))]
async fn extract_office_text(_path: &std::path::Path, _extension: &str) -> Result<String, String> {
    Err("Office extraction is currently available on Windows only".to_string())
}

async fn parse_file_detailed(path: &std::path::Path) -> Result<ParsedFile, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Cannot access '{}': {}", path.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (kind, mime_type) = file_kind_and_mime(&extension);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if kind == "image" {
        if metadata.len() > IMAGE_ATTACHMENT_LIMIT {
            return Err(format!(
                "Image exceeds the {} MB attachment limit",
                IMAGE_ATTACHMENT_LIMIT / 1024 / 1024
            ));
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| format!("Failed to read image: {}", e))?;
        return Ok(ParsedFile {
            name,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            content: BASE64.encode(bytes),
            mime_type: mime_type.to_string(),
            truncated: false,
            warning: None,
        });
    }

    let extracted = match extension.as_str() {
        "pdf" => extract_pdf_text(path).await,
        "docx" | "xlsx" | "pptx" => extract_office_text(path, &extension).await,
        _ => tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("File is not readable text: {}", e)),
    };
    let (content, mut warning) = match extracted {
        Ok(content) => (content, None),
        Err(error) if matches!(extension.as_str(), "pdf" | "docx" | "xlsx" | "pptx") => {
            (String::new(), Some(error))
        }
        Err(error) => return Err(error),
    };
    let content = if extension == "json" && !content.trim().is_empty() {
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(content),
            Err(error) => {
                warning = Some(format!(
                    "JSON format is invalid ({}); attached as the original text.",
                    error
                ));
                content
            }
        }
    } else {
        content
    };
    let (content, truncated) = limited_content(content);
    Ok(ParsedFile {
        name,
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        content,
        mime_type: mime_type.to_string(),
        truncated,
        warning,
    })
}

/// Compatibility command used by existing attachment flows.
#[tauri::command]
async fn parse_file_content(path: String) -> Result<String, String> {
    let parsed = parse_file_detailed(std::path::Path::new(&path)).await?;
    if parsed.content.is_empty() {
        if let Some(warning) = parsed.warning {
            return Err(warning);
        }
    }
    Ok(parsed.content)
}

#[tauri::command]
async fn parse_file_content_detailed(path: String) -> Result<ParsedFile, String> {
    parse_file_detailed(std::path::Path::new(&path)).await
}

#[tauri::command]
async fn pick_and_parse_files(app: tauri::AppHandle) -> Result<Vec<ParsedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx
        .await
        .map_err(|_| "File picker closed unexpectedly".to_string())?
        .unwrap_or_default();
    let mut parsed = Vec::with_capacity(paths.len());
    let mut image_count = 0usize;
    let mut image_bytes = 0u64;
    for path in paths {
        let path = std::path::PathBuf::from(path.to_string());
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let (kind, mime_type) = file_kind_and_mime(&extension);
        if kind == "image" {
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                if metadata.len() <= IMAGE_ATTACHMENT_LIMIT
                    && (image_count >= IMAGE_ATTACHMENT_COUNT_LIMIT
                        || image_bytes + metadata.len() > IMAGE_ATTACHMENT_TOTAL_LIMIT)
                {
                    parsed.push(ParsedFile {
                        name: path
                            .file_name()
                            .map(|value| value.to_string_lossy().to_string())
                            .unwrap_or_else(|| path.to_string_lossy().to_string()),
                        path: path.to_string_lossy().to_string(),
                        kind: kind.to_string(),
                        content: String::new(),
                        mime_type: mime_type.to_string(),
                        truncated: false,
                        warning: Some(format!(
                            "Image selection exceeds the {} file / {} MB total limit",
                            IMAGE_ATTACHMENT_COUNT_LIMIT,
                            IMAGE_ATTACHMENT_TOTAL_LIMIT / 1024 / 1024
                        )),
                    });
                    continue;
                }
                if metadata.len() <= IMAGE_ATTACHMENT_LIMIT {
                    image_count += 1;
                    image_bytes += metadata.len();
                }
            }
        }
        match parse_file_detailed(&path).await {
            Ok(file) => parsed.push(file),
            Err(error) => {
                parsed.push(ParsedFile {
                    name: path
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.to_string_lossy().to_string()),
                    path: path.to_string_lossy().to_string(),
                    kind: kind.to_string(),
                    content: String::new(),
                    mime_type: mime_type.to_string(),
                    truncated: false,
                    warning: Some(error),
                });
            }
        }
    }
    Ok(parsed)
}

/// Read a file as Base64 (for image attachments)
#[tauri::command]
async fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(BASE64.encode(&bytes))
}

/// Toggle window always-on-top
#[tauri::command]
async fn toggle_always_on_top(window: tauri::Window) -> Result<bool, String> {
    let is_top = window.is_always_on_top().map_err(|e| e.to_string())?;
    window
        .set_always_on_top(!is_top)
        .map_err(|e| e.to_string())?;
    Ok(!is_top)
}

/// Add trusted patterns to the config and persist
#[tauri::command]
fn add_trusted_patterns(
    current_config: AppConfig,
    patterns: Vec<TrustedPattern>,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    for p in patterns {
        let is_dup = config
            .trusted_patterns
            .iter()
            .any(|existing| existing.tool_name == p.tool_name && existing.pattern == p.pattern);
        if !is_dup {
            config.trusted_patterns.push(p);
        }
    }
    persist_config(&config)?;
    Ok(config)
}

/// Remove a trusted pattern from the config and persist
#[tauri::command]
fn remove_trusted_pattern(
    current_config: AppConfig,
    tool_name: String,
    pattern: String,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    config
        .trusted_patterns
        .retain(|p| !(p.tool_name == tool_name && p.pattern == pattern));
    persist_config(&config)?;
    Ok(config)
}

/// Check if Python is available on the system
#[tauri::command]
async fn check_python_available() -> bool {
    tools::check_python_available().await
}

/// Save or update an API profile
#[tauri::command]
fn save_profile(current_config: AppConfig, profile: ApiProfile) -> Result<AppConfig, String> {
    let mut config = current_config;
    let key = profile.name.clone();
    config.profiles.insert(key, profile);
    persist_config(&config)?;
    Ok(config)
}

/// Delete an API profile by name
#[tauri::command]
fn delete_profile(current_config: AppConfig, name: String) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.profiles.remove(&name);
    if config.active_profile.as_deref() == Some(&name) {
        config.active_profile = None;
    }
    persist_config(&config)?;
    Ok(config)
}

/// Set the active profile and apply its settings to the main config
#[tauri::command]
fn set_active_profile(current_config: AppConfig, name: String) -> Result<AppConfig, String> {
    let mut config = current_config;
    let profile = config
        .profiles
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("Profile '{}' not found", name))?;
    config.base_url = profile.base_url;
    config.api_key = profile.api_key;
    config.model = profile.default_model;
    config.wire_format = profile.wire_format;
    config.provider = profile.provider;
    config.active_profile = Some(name);
    persist_config(&config)?;
    Ok(config)
}

/// Clear the active profile (revert to manual config)
#[tauri::command]
fn clear_active_profile(current_config: AppConfig) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.active_profile = None;
    persist_config(&config)?;
    Ok(config)
}

fn persist_config(config: &AppConfig) -> Result<(), String> {
    workspace::ensure_workspace_dir(&config.default_work_dir, true)?;
    let mut encrypted_config = config.clone();
    encrypted_config.role_prompt = None;
    encrypted_config.api_key = encrypt(&encrypted_config.api_key);
    encrypted_config.search_api_key = encrypt(&encrypted_config.search_api_key);
    for profile in encrypted_config.profiles.values_mut() {
        profile.api_key = encrypt(&profile.api_key);
    }
    let config_dir = dirs::config_dir().unwrap_or_default().join("gxAgent");
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(&encrypted_config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())
}

/// Save or update an MCP server configuration
#[tauri::command]
fn save_mcp_server(
    current_config: AppConfig,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    let server = config::McpServerConfig { command, args, env };
    config.mcp_servers.insert(name, server);
    persist_config(&config)?;
    Ok(config)
}

/// Delete an MCP server configuration by name
#[tauri::command]
fn delete_mcp_server(current_config: AppConfig, name: String) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.mcp_servers.remove(&name);
    persist_config(&config)?;
    Ok(config)
}

/// Start one MCP server, complete the initialize/tools handshake, then stop it.
/// Errors are returned as structured status so the settings UI can show the
/// actual server failure instead of silently treating an empty tool list as OK.
#[tauri::command]
async fn test_mcp_server(
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> mcp::McpServerStatus {
    mcp::test_server(
        name,
        config::McpServerConfig {
            command,
            args: args.unwrap_or_default(),
            env: env.unwrap_or_default(),
        },
    )
    .await
}

/// Fetch available models from a local Ollama instance
#[tauri::command]
async fn fetch_ollama_models(base_url: String) -> Result<Vec<Value>, String> {
    mcp::fetch_ollama_models(&base_url).await
}

/// Push a steering message into the agent's intervention queue
#[tauri::command]
async fn push_steering_message(message: String, request_id: String) -> Result<(), String> {
    agent::push_steering_message(request_id, message).await;
    Ok(())
}

fn split_compaction_text(value: &str, max_chars: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let max_chars = max_chars.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut count = 0;
    for (index, _) in value.char_indices() {
        if count == max_chars {
            chunks.push(value[start..index].to_string());
            start = index;
            count = 0;
        }
        count += 1;
    }
    if start < value.len() {
        chunks.push(value[start..].to_string());
    }
    chunks
}

/// Group adjacent partial summaries for the next reduction pass while making
/// one invariant explicit: every pass with more than one item must produce
/// fewer groups than it received. A single trailing item may be carried into
/// the next pass unchanged, but every other group contains at least two
/// summaries. This prevents a 2 -> 2 reduction loop when model output happens
/// to be close to the input chunk budget.
fn group_compaction_summaries(summaries: Vec<String>, max_chars: usize) -> Vec<Vec<String>> {
    let max_chars = max_chars.max(1);
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0usize;

    for summary in summaries {
        let summary_chars = summary.chars().count();
        let separator_chars = if current.is_empty() { 0 } else { 2 };
        let would_exceed = current_chars
            .saturating_add(separator_chars)
            .saturating_add(summary_chars)
            > max_chars;

        // Never flush a singleton: pairing it with the next item is what gives
        // the reduction pass its strict convergence guarantee. Summaries are
        // individually bounded by the model's 1024-token output limit, so a
        // two-item overflow is still preferable to an unbounded retry loop.
        if would_exceed && current.len() >= 2 {
            groups.push(std::mem::take(&mut current));
            current_chars = 0;
        }

        if !current.is_empty() {
            current_chars = current_chars.saturating_add(2);
        }
        current_chars = current_chars.saturating_add(summary_chars);
        current.push(summary);
    }

    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

fn compaction_transcript(messages: Vec<Value>) -> String {
    messages
        .into_iter()
        .filter_map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let content = message.get("content")?;
            let content = content
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| content.to_string());
            if content.trim().is_empty() {
                None
            } else {
                Some(format!("[{}]\n{}", role, content))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn request_compaction_summary(
    client: &reqwest::Client,
    wire: provider::Wire,
    config: &AppConfig,
    source: &str,
    combine_partial_summaries: bool,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let instruction = if combine_partial_summaries {
        "Combine the partial summaries below into one concise but complete continuation summary. Remove duplication while preserving every concrete achievement, file path, pending task, code change, decision, user preference, and unresolved problem. Return only the structured summary."
    } else {
        "Compress the conversation segment below into a concise but complete continuation summary. Preserve concrete achievements, file paths, pending tasks, code changes, decisions, user preferences, and unresolved problems. Return only the structured summary."
    };
    let compact_messages = vec![
        json!({
            "role": "system",
            "content": "You are a conversation summarizer. Preserve the details needed to continue the work accurately."
        }),
        json!({
            "role": "user",
            "content": format!("{}\n\n{}", instruction, source)
        }),
    ];
    let url = provider::build_url(wire, &config.base_url, &config.model, false);
    let body = provider::build_body(wire, &config.model, &compact_messages, &[], config, false);
    let builder = provider::apply_auth(wire, client.post(&url), &config.api_key);

    tokio::select! {
        biased;
        _ = agent::wait_for_cancellation(cancel_rx) => {
            Err("History compaction cancelled.".to_string())
        }
        result = async {
            let response = builder
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("API request failed: {}", e))?;
            if !response.status().is_success() {
                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                return Err(format!("LLM API error ({}): {}", status, error_text));
            }
            let response_body: Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;
            let (summary, _reasoning, _calls, _pt, _ct) =
                provider::parse_full_response(wire, &response_body);
            if summary.trim().is_empty() {
                Err("Failed to generate summary.".to_string())
            } else {
                Ok(summary)
            }
        } => result,
    }
}

/// Compress conversation history using the current model
#[tauri::command]
async fn compact_history(
    current_config: AppConfig,
    messages: Vec<Value>,
    request_id: String,
    context_token_limit: Option<usize>,
) -> Result<String, String> {
    let mut config = current_config;
    config.temperature = 0.3;
    config.max_tokens = Some(1024);
    let wire = provider::Wire::from_config(&config);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("HTTP client error: {}", error))?;
    let mut cancel_rx = agent::register_cancellation(&request_id).await;
    // Reserve room for the summary and use a one-character-per-token input
    // budget. This is intentionally conservative for CJK text. Very large
    // histories are summarized in chunks and then reduced recursively, so the
    // recovery path still works after a normal request has exceeded context.
    let token_limit = context_token_limit.unwrap_or(32_000).max(8_000);
    let chunk_chars = token_limit.saturating_sub(2_200).clamp(5_000, 60_000);
    let transcript = compaction_transcript(messages);
    let mut chunks = split_compaction_text(&transcript, chunk_chars);
    let result = async {
        if chunks.is_empty() {
            return Err("There is no conversation content to compact.".to_string());
        }

        let mut summaries = Vec::with_capacity(chunks.len());
        for (index, chunk) in chunks.drain(..).enumerate() {
            let labelled = format!("Conversation segment {}:\n{}", index + 1, chunk);
            summaries.push(
                request_compaction_summary(
                    &client,
                    wire,
                    &config,
                    &labelled,
                    false,
                    &mut cancel_rx,
                )
                .await?,
            );
        }

        while summaries.len() > 1 {
            let previous_len = summaries.len();
            let groups = group_compaction_summaries(summaries, chunk_chars);
            if groups.len() >= previous_len {
                return Err("History compaction failed to converge.".to_string());
            }

            let mut reduced = Vec::with_capacity(groups.len());
            for group in groups {
                if group.len() == 1 {
                    reduced.push(group.into_iter().next().unwrap_or_default());
                    continue;
                }
                let combined = group
                    .into_iter()
                    .enumerate()
                    .map(|(index, summary)| format!("[Partial summary {}]\n{}", index + 1, summary))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                reduced.push(
                    request_compaction_summary(
                        &client,
                        wire,
                        &config,
                        &combined,
                        true,
                        &mut cancel_rx,
                    )
                    .await?,
                );
            }
            summaries = reduced;
        }

        summaries
            .pop()
            .ok_or_else(|| "Failed to generate summary.".to_string())
    }
    .await;
    agent::unregister_cancellation(&request_id).await;
    result
}

/// Export configuration to a JSON string (re-encrypts API keys for safe export)
#[tauri::command]
fn export_config(config: AppConfig) -> Result<String, String> {
    let mut export = config;
    // Re-encrypt API keys so they aren't exported as plaintext
    if !export.api_key.is_empty() && !export.api_key.starts_with("enc:") {
        export.api_key = crypto::encrypt(&export.api_key);
    }
    if !export.search_api_key.is_empty() && !export.search_api_key.starts_with("enc:") {
        export.search_api_key = crypto::encrypt(&export.search_api_key);
    }
    for profile in export.profiles.values_mut() {
        if !profile.api_key.is_empty() && !profile.api_key.starts_with("enc:") {
            profile.api_key = crypto::encrypt(&profile.api_key);
        }
    }
    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

/// Import configuration from a JSON string
fn try_decrypt_key(key: &str) -> (String, bool) {
    if key.is_empty() {
        return (String::new(), false);
    }
    if !key.starts_with("enc:v1:") && !key.starts_with("enc:v2:") && !key.starts_with("enc:") {
        return (key.to_string(), false);
    }
    let decrypted = crypto::decrypt(key);
    if decrypted.starts_with("enc:v1:")
        || decrypted.starts_with("enc:v2:")
        || decrypted.starts_with("enc:")
        || !decrypted.is_ascii()
        || decrypted.contains('\0')
    {
        (String::new(), true)
    } else {
        (decrypted, false)
    }
}

#[tauri::command]
fn import_config(app: AppHandle, json: String) -> Result<AppConfig, String> {
    let export_data: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let config_value =
        if export_data.get("config").is_some() && export_data.get("version").is_some() {
            let _ = app.emit(
                "config-import-warning",
                "Detected wrapped config export. Importing the config payload in personal mode.",
            );
            export_data
                .get("config")
                .cloned()
                .ok_or_else(|| "Missing config payload".to_string())?
        } else {
            export_data
        };

    let mut config: AppConfig = serde_json::from_value(config_value).map_err(|e| e.to_string())?;
    config.role_prompt = None;
    let mut needs_rekey = false;
    let (decrypted, rekey) = try_decrypt_key(&config.api_key);
    config.api_key = decrypted;
    needs_rekey = needs_rekey || rekey;

    let (decrypted, rekey) = try_decrypt_key(&config.search_api_key);
    config.search_api_key = decrypted;
    needs_rekey = needs_rekey || rekey;
    for profile in config.profiles.values_mut() {
        let (decrypted, rekey) = try_decrypt_key(&profile.api_key);
        profile.api_key = decrypted;
        needs_rekey = needs_rekey || rekey;
    }
    repair_config_workspace(&mut config)?;
    persist_config(&config)?;
    if needs_rekey {
        let _ = app.emit(
            "config-import-rekey",
            "Detected encrypted keys from another device. Please re-enter your API keys.",
        );
    }
    Ok(config)
}

/// Clear all saved conversation sessions
#[tauri::command]
fn clear_all_sessions() -> Result<(), String> {
    storage::clear_sessions()?;

    let data_dir = dirs::data_dir().unwrap_or_default().join("gxAgent");
    if data_dir.exists() {
        let entries = fs::read_dir(&data_dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if name.starts_with("session_") {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

/// Show the Spotlight quick-input window
#[tauri::command]
async fn show_spotlight(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("spotlight") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        let _window = tauri::WebviewWindowBuilder::new(
            &app,
            "spotlight",
            tauri::WebviewUrl::App("index.html#spotlight".into()),
        )
        .title("gxAgent Spotlight")
        .inner_size(600.0, 160.0)
        .center()
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // System tray icon with menu
            let icon = app
                .default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new_owned(vec![], 0, 0));

            let show = tauri::menu::MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let settings = tauri::menu::MenuItemBuilder::with_id("settings", "设置").build(app)?;
            let quit = tauri::menu::MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = tauri::menu::MenuBuilder::new(app)
                .item(&show)
                .item(&settings)
                .separator()
                .item(&quit)
                .build()?;

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .tooltip("gxAgent Studio")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("open-settings", ());
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            let _ = tray;

            // Register global shortcut: Ctrl+Shift+G to toggle window
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let gs = app.global_shortcut();
            if let Err(error) = gs.register("CommandOrControl+Shift+G") {
                eprintln!(
                    "Global shortcut CommandOrControl+Shift+G is unavailable; continuing without it: {error}"
                );
            }

            let app_handle = app.handle().clone();
            app.listen("plugin:global-shortcut:shortcut-pressed", move |event| {
                let payload = event.payload();
                if payload.contains("CommandOrControl+Shift+G") {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_agent_session,
            resolve_tool_approval,
            cancel_agent_session,
            fetch_models,
            get_provider_presets,
            get_default_config,
            save_config,
            load_config,
            list_directory,
            read_file_content,
            workspace::validate_workspace,
            workspace::list_directory_tree,
            workspace::get_git_status,
            workspace::get_git_diff,
            workspace::restore_git_path,
            workspace::create_git_checkpoint,
            workspace::list_git_checkpoints,
            workspace::delete_git_checkpoint,
            workspace::restore_git_checkpoint,
            add_trusted_patterns,
            remove_trusted_pattern,
            check_python_available,
            save_profile,
            delete_profile,
            storage::save_session,
            storage::save_sessions,
            storage::load_session,
            storage::load_sessions,
            storage::list_sessions,
            storage::delete_session,
            set_active_profile,
            clear_active_profile,
            compact_history,
            save_mcp_server,
            delete_mcp_server,
            test_mcp_server,
            fetch_ollama_models,
            push_steering_message,
            export_config,
            import_config,
            clear_all_sessions,
            show_spotlight,
            save_code_file,
            pick_workspace_directory,
            parse_file_content,
            parse_file_content_detailed,
            pick_and_parse_files,
            read_file_as_base64,
            toggle_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_split_preserves_utf8_content() {
        let source = "ab中文🙂cd尾";
        let chunks = split_compaction_text(source, 3);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 3));
        assert_eq!(chunks.concat(), source);
    }

    #[test]
    fn compaction_reduction_groups_strictly_converge() {
        for count in 2..=64 {
            let summaries = (0..count)
                .map(|index| format!("summary-{index}-{}", "x".repeat(4_000)))
                .collect::<Vec<_>>();
            let expected = summaries.clone();
            let groups = group_compaction_summaries(summaries, 5_800);

            assert!(groups.len() < count, "count={count}");
            assert_eq!(groups.into_iter().flatten().collect::<Vec<_>>(), expected);
        }
    }

    #[tokio::test]
    async fn invalid_json_is_kept_as_plain_text_with_warning() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gxagent-invalid-json-{}.json", unique));
        let source = "{ invalid json: true";
        tokio::fs::write(&path, source).await.unwrap();

        let parsed = parse_file_detailed(&path).await.unwrap();
        let _ = tokio::fs::remove_file(&path).await;

        assert_eq!(parsed.content, source);
        assert!(parsed
            .warning
            .as_deref()
            .unwrap_or_default()
            .contains("attached as the original text"));
    }
}
