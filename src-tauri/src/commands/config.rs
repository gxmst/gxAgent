use crate::config::{self, ApiProfile, AppConfig, ProviderPreset, TrustedPattern};
use crate::crypto::{decrypt, encrypt};
use crate::{app_paths, mcp, storage, workspace};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use tauri::{AppHandle, Emitter};

pub(super) fn effective_work_dir(explicit: Option<String>) -> Result<String, String> {
    let selected = match explicit.filter(|value| !value.trim().is_empty()) {
        Some(path) => path,
        None => load_config()?.default_work_dir,
    };
    Ok(workspace::ensure_workspace_dir(&selected, false)?
        .to_string_lossy()
        .to_string())
}

/// Get provider presets
#[tauri::command]
pub fn get_provider_presets() -> Vec<ProviderPreset> {
    config::get_presets()
}

/// Get default app config
#[tauri::command]
pub fn get_default_config() -> Result<AppConfig, String> {
    let config = AppConfig::default();
    workspace::ensure_workspace_dir(&config.default_work_dir, true)?;
    Ok(config)
}

/// Save config to a local file (encrypts API keys)
#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
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

fn normalize_context_budget(value: u32, migration_version: u32) -> u32 {
    let token_budget = if migration_version < 3 && value <= 500 {
        // The old value was a message count; preserve its approximate
        // effective budget instead of treating (for example) 50 as tokens.
        value.max(1).saturating_mul(400)
    } else {
        value
    };
    token_budget.clamp(1_000, 1_000_000)
}

/// Load config from local file, returns default if not found (decrypts API keys)
#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let config_path = app_paths::config_dir()
        .ok_or("Config directory is unavailable")?
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
    let normalized_context_limit =
        normalize_context_budget(config.context_limit, config.tools_migration_version);
    if normalized_context_limit != config.context_limit {
        config.context_limit = normalized_context_limit;
        config_changed = true;
    }
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
        if config.tools_migration_version < 4
            && !config
                .tools_enabled
                .iter()
                .any(|tool| tool == "spawn_agent")
        {
            config.tools_enabled.push("spawn_agent".to_string());
        }
        if config.tools_migration_version < 5
            && !config
                .tools_enabled
                .iter()
                .any(|tool| tool == "get_current_time")
        {
            // v5: make the read-only clock available in both ordinary chat and
            // code mode without changing any existing tool choices.
            config.tools_enabled.push("get_current_time".to_string());
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

/// Add trusted patterns to the config and persist
#[tauri::command]
pub fn add_trusted_patterns(
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
pub fn remove_trusted_pattern(
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

/// Save or update an API profile
#[tauri::command]
pub fn save_profile(
    current_config: AppConfig,
    profile: ApiProfile,
    profile_id: Option<String>,
    set_default: Option<bool>,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    let id = config::upsert_api_profile(&mut config, profile_id, profile)?;
    if set_default.unwrap_or(false) {
        config::apply_api_profile(&mut config, &id)?;
    }
    persist_config(&config)?;
    Ok(config)
}

/// Delete an API profile by name
#[tauri::command]
pub fn delete_profile(
    current_config: AppConfig,
    name: String,
    replacement_id: Option<String>,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    if let Some(ref replacement) = replacement_id {
        if replacement == &name || !config.profiles.contains_key(replacement) {
            return Err("Choose an existing replacement connection".into());
        }
    }
    config.profiles.remove(&name);
    if config.active_profile.as_deref() == Some(&name) {
        config.active_profile = None;
        if let Some(ref replacement) = replacement_id {
            config::apply_api_profile(&mut config, replacement)?;
        }
    }
    persist_config(&config)?;
    Ok(config)
}

/// Set the active profile and apply its settings to the main config
#[tauri::command]
pub fn set_active_profile(current_config: AppConfig, name: String) -> Result<AppConfig, String> {
    let mut config = current_config;
    config::apply_api_profile(&mut config, &name)?;
    persist_config(&config)?;
    Ok(config)
}

/// Clear the active profile (revert to manual config)
#[tauri::command]
pub fn clear_active_profile(current_config: AppConfig) -> Result<AppConfig, String> {
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
    let config_dir = app_paths::config_dir().ok_or("Config directory is unavailable")?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(&encrypted_config).map_err(|e| e.to_string())?;
    storage::atomic_write(&config_path, json.as_bytes())
}

/// Save or update an MCP server configuration
#[tauri::command]
pub fn save_mcp_server(
    current_config: AppConfig,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<AppConfig, String> {
    let mut config = current_config;
    let server = config::McpServerConfig { command, args, env };
    if name.trim().is_empty() || config.mcp_servers.contains_key(name.trim()) {
        return Err("MCP server name is empty or already exists".into());
    }
    mcp::validate_server_config(&server)?;
    config.mcp_servers.insert(name.trim().to_string(), server);
    persist_config(&config)?;
    Ok(config)
}

/// Delete an MCP server configuration by name
#[tauri::command]
pub fn delete_mcp_server(current_config: AppConfig, name: String) -> Result<AppConfig, String> {
    let mut config = current_config;
    config.mcp_servers.remove(&name);
    persist_config(&config)?;
    Ok(config)
}

/// Start one MCP server, complete the initialize/tools handshake, then stop it.
/// Errors are returned as structured status so the settings UI can show the
/// actual server failure instead of silently treating an empty tool list as OK.
#[tauri::command]
pub async fn test_mcp_server(
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
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

fn encrypt_if_plaintext(key: &mut String) {
    if !key.is_empty() && !key.starts_with("enc:") {
        *key = encrypt(key);
    }
}

/// Export configuration to a JSON string (re-encrypts API keys for safe export)
#[tauri::command]
pub fn export_config(config: AppConfig) -> Result<String, String> {
    let mut export = config;
    // Re-encrypt API keys so they aren't exported as plaintext
    encrypt_if_plaintext(&mut export.api_key);
    encrypt_if_plaintext(&mut export.search_api_key);
    for profile in export.profiles.values_mut() {
        encrypt_if_plaintext(&mut profile.api_key);
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
    let decrypted = decrypt(key);
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
pub fn import_config(app: AppHandle, json: String) -> Result<AppConfig, String> {
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
pub fn clear_all_sessions() -> Result<(), String> {
    storage::clear_sessions()?;

    let data_dir = app_paths::data_dir().ok_or("Data directory is unavailable")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_budget_migration_preserves_legacy_and_clamps_bounds() {
        assert_eq!(normalize_context_budget(50, 2), 20_000);
        assert_eq!(normalize_context_budget(128_000, 2), 128_000);
        assert_eq!(normalize_context_budget(2_000_000, 3), 1_000_000);
    }
}
