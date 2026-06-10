mod agent;
mod config;
mod crypto;
mod mcp;
mod policy;
mod tools;

use config::{ApiProfile, AppConfig, ProviderPreset, TrustedPattern};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use crypto::{decrypt, encrypt};
use serde_json::{json, Value};
use std::fs;
use tauri_plugin_dialog::DialogExt;
use tauri::{AppHandle, Emitter, Listener, Manager};

// ==========================================
// Tauri Commands
// ==========================================

/// Start an agent session with the given config and prompt
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
    let result = agent::start_agent_loop(window.clone(), request_id.clone(), prompt, config, session_messages, mode, smode, images).await;
    if let Err(ref e) = result {
        let _ = window.emit("agent-stream-chunk", json!({
            "requestId": request_id,
            "content": format!("\nError: {}\n", e),
        }));
        let _ = window.emit("agent-stream-done", json!({
            "requestId": request_id,
            "content": format!("Error: {}", e),
            "loopCount": 0,
            "ttftMs": 0,
            "responseTimeMs": 0,
        }));
        let _ = window.emit("agent-complete", json!({
            "requestId": request_id,
            "status": "error",
        }));
        return Ok(());
    }
    result
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

/// Fetch available models from an OpenAI-compatible API
#[tauri::command]
async fn fetch_models(base_url: String, api_key: String) -> Result<Vec<Value>, String> {
    agent::fetch_models(&base_url, &api_key).await
}

/// Get provider presets
#[tauri::command]
fn get_provider_presets() -> Vec<ProviderPreset> {
    config::get_presets()
}

/// Get default app config
#[tauri::command]
fn get_default_config() -> AppConfig {
    AppConfig::default()
}

/// Save config to a local file (encrypts API keys)
#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    persist_config(&config)?;
    Ok(())
}

/// Load config from local file, returns default if not found (decrypts API keys)
#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    let config_path = dirs::config_dir()
        .unwrap_or_default()
        .join("gxAgent")
        .join("config.json");

    if !config_path.exists() {
        return Ok(AppConfig::default());
    }

    let json = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut config: AppConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    config.api_key = decrypt(&config.api_key);
    config.search_api_key = decrypt(&config.search_api_key);
    for profile in config.profiles.values_mut() {
        profile.api_key = decrypt(&profile.api_key);
    }
    Ok(config)
}

/// List directory contents (for workspace file browser)
#[tauri::command]
async fn list_directory(path: String) -> Result<String, String> {
    let work_dir = load_config().map(|c| c.default_work_dir).unwrap_or_else(|_| ".".to_string());
    let result = tools::execute_tool("list_dir", &serde_json::json!({"path": path}).to_string(), &work_dir, "duckduckgo", "").await;
    if result.starts_with("Error:") {
        Err(result)
    } else {
        Ok(result)
    }
}

/// Read a file (for workspace file viewer)
#[tauri::command]
async fn read_file_content(path: String) -> Result<String, String> {
    let work_dir = load_config().map(|c| c.default_work_dir).unwrap_or_else(|_| ".".to_string());
    let result = tools::execute_tool("read_file", &serde_json::json!({"path": path}).to_string(), &work_dir, "duckduckgo", "").await;
    if result.starts_with("Error:") {
        Err(result)
    } else {
        Ok(result)
    }
}

/// Save code block content to a local file (with native save dialog)
#[tauri::command]
async fn save_code_file(app: tauri::AppHandle, content: String, language: String) -> Result<String, String> {
    let ext_map: std::collections::HashMap<&str, &str> = [
        ("javascript", "js"), ("typescript", "ts"), ("python", "py"),
        ("rust", "rs"), ("go", "go"), ("java", "java"), ("c", "c"),
        ("cpp", "cpp"), ("csharp", "cs"), ("ruby", "rb"), ("php", "php"),
        ("swift", "swift"), ("kotlin", "kt"), ("scala", "scala"),
        ("html", "html"), ("css", "css"), ("json", "json"), ("yaml", "yaml"),
        ("toml", "toml"), ("xml", "xml"), ("sql", "sql"), ("sh", "sh"),
        ("bash", "sh"), ("powershell", "ps1"), ("dockerfile", "dockerfile"),
        ("markdown", "md"), ("text", "txt"),
    ].iter().cloned().collect();

    let ext = ext_map.get(language.as_str()).unwrap_or(&"txt");

    let dialog = app.dialog();
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.file()
        .add_filter("Code File", &[ext])
        .set_file_name(&format!("untitled.{}", ext))
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

/// Parse a local file and return its text content (supports txt/csv/md/json)
#[tauri::command]
async fn parse_file_content(path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "csv" => {
            // Return CSV as-is, it's already text
            Ok(content)
        }
        "json" => {
            // Pretty-print JSON
            let val: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Invalid JSON: {}", e))?;
            Ok(serde_json::to_string_pretty(&val).unwrap_or(content))
        }
        _ => Ok(content),
    }
}

/// Read a file as Base64 (for image attachments)
#[tauri::command]
async fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(BASE64.encode(&bytes))
}

/// Toggle window always-on-top
#[tauri::command]
async fn toggle_always_on_top(window: tauri::Window) -> Result<bool, String> {
    let is_top = window.is_always_on_top().map_err(|e| e.to_string())?;
    window.set_always_on_top(!is_top).map_err(|e| e.to_string())?;
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
        let is_dup = config.trusted_patterns.iter().any(|existing| {
            existing.tool_name == p.tool_name && existing.pattern == p.pattern
        });
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
    config.trusted_patterns.retain(|p| !(p.tool_name == tool_name && p.pattern == pattern));
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
fn save_profile(
    current_config: AppConfig,
    profile: ApiProfile,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    let key = profile.name.clone();
    config.profiles.insert(key, profile);
    persist_config(&config)?;
    Ok(config)
}

/// Delete an API profile by name
#[tauri::command]
fn delete_profile(
    current_config: AppConfig,
    name: String,
) -> Result<AppConfig, String> {
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
fn set_active_profile(
    current_config: AppConfig,
    name: String,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    let profile = config.profiles.get(&name).cloned().ok_or_else(|| format!("Profile '{}' not found", name))?;
    config.base_url = profile.base_url;
    config.api_key = profile.api_key;
    config.model = profile.default_model;
    config.active_profile = Some(name);
    persist_config(&config)?;
    Ok(config)
}

/// Clear the active profile (revert to manual config)
#[tauri::command]
fn clear_active_profile(
    current_config: AppConfig,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.active_profile = None;
    persist_config(&config)?;
    Ok(config)
}

fn persist_config(config: &AppConfig) -> Result<(), String> {
    let mut encrypted_config = config.clone();
    encrypted_config.api_key = encrypt(&encrypted_config.api_key);
    encrypted_config.search_api_key = encrypt(&encrypted_config.search_api_key);
    for profile in encrypted_config.profiles.values_mut() {
        profile.api_key = encrypt(&profile.api_key);
    }
    let config_dir = dirs::config_dir()
        .unwrap_or_default()
        .join("gxAgent");
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
    let server = config::McpServerConfig {
        command,
        args,
        env,
    };
    config.mcp_servers.insert(name, server);
    persist_config(&config)?;
    Ok(config)
}

/// Delete an MCP server configuration by name
#[tauri::command]
fn delete_mcp_server(
    current_config: AppConfig,
    name: String,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.mcp_servers.remove(&name);
    persist_config(&config)?;
    Ok(config)
}

/// Fetch available models from a local Ollama instance
#[tauri::command]
async fn fetch_ollama_models(base_url: String) -> Result<Vec<Value>, String> {
    mcp::fetch_ollama_models(&base_url).await
}

/// Push a steering message into the agent's intervention queue
#[tauri::command]
async fn push_steering_message(message: String) -> Result<(), String> {
    agent::push_steering_message(message).await;
    Ok(())
}

/// Compress conversation history using the current model
#[tauri::command]
async fn compact_history(
    current_config: AppConfig,
    messages: Vec<Value>,
) -> Result<String, String> {
    let config = current_config;
    let client = reqwest::Client::new();

    let compact_prompt = "Please read the conversation history above and compress it into a comprehensive summary. Preserve all core achievements, file locations, pending tasks, code changes, and user configurations. Keep the output strictly as a structured summary that can serve as context for continuing the conversation. Do NOT add any commentary — just the summary.";

    let mut compact_messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": "You are a conversation summarizer. Produce a concise but complete summary of the conversation that preserves all important details for continuing work."
    })];

    // Add all messages as context
    compact_messages.extend(messages);

    // Add the compression instruction
    compact_messages.push(json!({
        "role": "user",
        "content": compact_prompt
    }));

    let request_body = json!({
        "model": config.model,
        "messages": compact_messages,
        "temperature": 0.3,
        "max_tokens": 2048,
        "stream": false,
    });

    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, error_text));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let summary = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("Failed to generate summary.")
        .to_string();

    Ok(summary)
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
    if decrypted.starts_with("enc:v1:") || decrypted.starts_with("enc:v2:") || decrypted.starts_with("enc:") || !decrypted.is_ascii() || decrypted.contains('\0') {
        (String::new(), true)
    } else {
        (decrypted, false)
    }
}

#[tauri::command]
fn import_config(app: AppHandle, json: String) -> Result<AppConfig, String> {
    let export_data: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let config_value = if export_data.get("config").is_some() && export_data.get("version").is_some() {
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
    persist_config(&config)?;
    if needs_rekey {
        let _ = app.emit("config-import-rekey", "Detected encrypted keys from another device. Please re-enter your API keys.");
    }
    Ok(config)
}

/// Clear all saved conversation sessions
#[tauri::command]
fn clear_all_sessions() -> Result<(), String> {
    let data_dir = dirs::data_dir()
        .unwrap_or_default()
        .join("gxAgent");
    if data_dir.exists() {
        let entries = fs::read_dir(&data_dir).map_err(|e| e.to_string())?;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    if name.starts_with("session_") {
                        let _ = fs::remove_file(&path);
                    }
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
            // System tray icon
            let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                tauri::image::Image::new_owned(vec![], 0, 0)
            });
            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .tooltip("gxAgent Studio")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
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
            gs.register("CommandOrControl+Shift+G")?;

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
            add_trusted_patterns,
            remove_trusted_pattern,
            check_python_available,
            save_profile,
            delete_profile,
            set_active_profile,
            clear_active_profile,
            compact_history,
            save_mcp_server,
            delete_mcp_server,
            fetch_ollama_models,
            push_steering_message,
            export_config,
            import_config,
            clear_all_sessions,
            show_spotlight,
            save_code_file,
            parse_file_content,
            read_file_as_base64,
            toggle_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
