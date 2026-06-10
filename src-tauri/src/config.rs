use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiProfile {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: Option<u32>,
    pub system_prompt: String,
    pub streaming: bool,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    pub context_limit: u32,
    pub tools_enabled: Vec<String>,
    pub approval_policy: String,
    pub trusted_patterns: Vec<TrustedPattern>,
    pub default_work_dir: String,
    pub persist_trust: bool,
    pub theme: String,
    pub language: String,
    #[serde(default)]
    pub profiles: HashMap<String, ApiProfile>,
    #[serde(default)]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    #[serde(default = "default_search_provider")]
    pub search_provider: String,
    #[serde(default)]
    pub search_api_key: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default)]
    pub show_advanced_reply_info: bool,
    #[serde(default = "default_command_timeout")]
    pub command_timeout: u64,
    #[serde(default = "default_preview_sandbox")]
    pub preview_sandbox: bool,
}

fn default_search_provider() -> String {
    "duckduckgo".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_font_family() -> String {
    "system".to_string()
}

fn default_thinking_level() -> String {
    "medium".to_string()
}

fn default_command_timeout() -> u64 {
    30
}

fn default_preview_sandbox() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedPattern {
    pub tool_name: String,
    pub pattern: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPreset {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub default_model: String,
    pub needs_api_key: bool,
}

pub fn get_presets() -> Vec<ProviderPreset> {
    vec![
        ProviderPreset {
            name: "DeepSeek".into(),
            provider: "openai".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            default_model: "deepseek-chat".into(),
            needs_api_key: true,
        },
        ProviderPreset {
            name: "OpenAI".into(),
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            default_model: "gpt-4o".into(),
            needs_api_key: true,
        },
        ProviderPreset {
            name: "Ollama Local".into(),
            provider: "ollama".into(),
            base_url: "http://localhost:11434".into(),
            default_model: String::new(),
            needs_api_key: false,
        },
    ]
}

/// Default low-risk command patterns that are auto-approved.
/// These are read-only / informational commands that cannot modify the system.
pub fn default_trusted_patterns() -> Vec<TrustedPattern> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // (tool_name, pattern) — pattern is matched as command prefix
    let patterns: &[(&str, &str)] = &[
        // --- File listing (read-only) ---
        ("execute_command", "Get-ChildItem"),
        ("execute_command", "dir"),
        ("execute_command", "ls"),
        ("execute_command", "tree"),
        // --- File reading ---
        ("execute_command", "Get-Content"),
        ("execute_command", "type "),
        ("execute_command", "cat "),
        // --- System information ---
        ("execute_command", "Get-Process"),
        ("execute_command", "systeminfo"),
        ("execute_command", "hostname"),
        ("execute_command", "whoami"),
        // --- Path / location ---
        ("execute_command", "pwd"),
        ("execute_command", "Get-Location"),
        ("execute_command", "Test-Path"),
        ("execute_command", "cd "),
        // --- Output ---
        ("execute_command", "echo "),
        ("execute_command", "Write-Output"),
        ("execute_command", "Write-Host"),
        // --- Search ---
        ("execute_command", "Select-String"),
        ("execute_command", "findstr"),
        // --- Network info ---
        ("execute_command", "ipconfig"),
        ("execute_command", "ping "),
        ("execute_command", "nslookup"),
        // --- Date ---
        ("execute_command", "Get-Date"),
        // --- Version checks ---
        ("execute_command", "python --version"),
        ("execute_command", "node --version"),
        ("execute_command", "git --version"),
        ("execute_command", "rustc --version"),
        ("execute_command", "cargo --version"),
        ("execute_command", "npm --version"),
        ("execute_command", "pip --version"),
        // --- npm (read-only) ---
        ("execute_command", "npm list"),
        ("execute_command", "npm view"),
        ("execute_command", "npm info"),
        ("execute_command", "npm outdated"),
        // --- pip (read-only) ---
        ("execute_command", "pip list"),
        ("execute_command", "pip show"),
        // --- git (read-only) ---
        ("execute_command", "git status"),
        ("execute_command", "git log"),
        ("execute_command", "git diff"),
        ("execute_command", "git branch"),
        ("execute_command", "git remote"),
        ("execute_command", "git show"),
        ("execute_command", "git tag"),
        ("execute_command", "git stash list"),
        // --- cargo (read-only) ---
        ("execute_command", "cargo check"),
        ("execute_command", "cargo test"),
        ("execute_command", "cargo tree"),
        // --- Environment ---
        ("execute_command", "$env:"),
        ("execute_command", "Get-ChildItem Env:"),
        ("execute_command", "[Environment]::"),
    ];

    patterns
        .iter()
        .map(|(tool, pattern)| TrustedPattern {
            tool_name: tool.to_string(),
            pattern: pattern.to_string(),
            created_at: now,
        })
        .collect()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: String::new(),
            model: "deepseek-chat".into(),
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: None,
            system_prompt: "You are a helpful AI assistant with access to local tools running on Windows. Help the user accomplish tasks by using the available tools when needed. Be careful, honest, and direct. If you are unsure or lack enough information, say so instead of guessing. Do not invent facts, files, command results, or tool output.\n\nIMPORTANT: The shell is Windows PowerShell. Do NOT use Unix/bash syntax (no ||, no &&, no /dev/null, no cat/grep/ls). Use PowerShell equivalents: use ; to chain commands, use Select-String instead of grep, use Get-ChildItem instead of ls, use Get-Content instead of cat. Redirect errors with 2>$null. Always use PowerShell-compatible commands.".into(),
            streaming: true,
            thinking_level: "medium".into(),
            context_limit: 50,
            tools_enabled: vec![
                "execute_command".into(),
                "read_file".into(),
                "write_file".into(),
                "list_dir".into(),
                "run_python".into(),
                "web_search".into(),
            ],
            approval_policy: "standard".into(),
            trusted_patterns: default_trusted_patterns(),
            default_work_dir: dirs::home_dir()
                .map(|h| h.join("gxAgent-workspace").to_string_lossy().to_string())
                .unwrap_or_else(|| ".".to_string()),
            persist_trust: false,
            theme: "light".into(),
            language: "zh".into(),
            profiles: HashMap::new(),
            active_profile: None,
            mcp_servers: HashMap::new(),
            search_provider: "duckduckgo".into(),
            search_api_key: String::new(),
            font_size: 14,
            font_family: "system".into(),
            show_advanced_reply_info: false,
            command_timeout: 30,
            preview_sandbox: true,
        }
    }
}
