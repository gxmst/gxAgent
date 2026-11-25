use crate::tools::scrub_sensitive_env;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const MAX_HOOKS_FILE_BYTES: u64 = 128 * 1024;
const MAX_HOOK_OUTPUT_BYTES: usize = 8 * 1024;
const DEFAULT_HOOK_TIMEOUT_SECS: u64 = 15;
const MAX_HOOK_TIMEOUT_SECS: u64 = 60;

fn default_hook_timeout_secs() -> u64 {
    DEFAULT_HOOK_TIMEOUT_SECS
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookEntry {
    #[serde(default)]
    pub matcher: String,
    pub command: String,
    #[serde(default = "default_hook_timeout_secs")]
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct HooksConfig {
    #[serde(default, alias = "preToolUse", alias = "pre_tool_use")]
    pub pre_tool_use: Vec<HookEntry>,
    #[serde(default, alias = "postToolUse", alias = "post_tool_use")]
    pub post_tool_use: Vec<HookEntry>,
    #[serde(default, alias = "stop")]
    pub stop: Vec<HookEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreHookDecision {
    Allow,
    Block(String),
}

pub fn load_project_hooks(work_dir: &str) -> Result<Option<HooksConfig>, String> {
    let trimmed = work_dir.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let path = Path::new(trimmed).join(".gxagent").join("hooks.json");
    if !path.is_file() {
        return Ok(None);
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_HOOKS_FILE_BYTES {
        return Err("Project .gxagent/hooks.json exceeds 128 KB".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let config: HooksConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid .gxagent/hooks.json: {e}"))?;
    Ok(Some(config))
}

#[tauri::command]
pub fn list_project_hooks(work_dir: String) -> Result<HooksConfig, String> {
    Ok(load_project_hooks(&work_dir)?.unwrap_or_default())
}

pub fn matcher_matches(matcher: &str, target: &str) -> bool {
    let trimmed = matcher.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return true;
    }
    if let Ok(re) = regex::Regex::new(&format!("^(?:{})$", trimmed)) {
        return re.is_match(target);
    }
    trimmed.split('|').any(|part| part.trim() == target)
}

struct HookRunResult {
    success: bool,
    exit_code: Option<i32>,
    output: String,
}

async fn run_single_hook(
    event_name: &str,
    hook: &HookEntry,
    work_dir: &str,
    request_id: &str,
    tool_name: Option<&str>,
    tool_input: Option<&str>,
    tool_output: Option<&str>,
) -> Result<HookRunResult, String> {
    let cmd_str = hook.command.trim();
    if cmd_str.is_empty() {
        return Ok(HookRunResult {
            success: true,
            exit_code: Some(0),
            output: String::new(),
        });
    }

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", cmd_str]);
        #[cfg(windows)]
        c.creation_flags(0x08000000);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", cmd_str]);
        c
    };

    scrub_sensitive_env(&mut cmd);
    if !work_dir.trim().is_empty() && Path::new(work_dir).is_dir() {
        cmd.current_dir(work_dir);
    }
    cmd.env("GX_HOOK_EVENT", event_name);
    cmd.env("GX_REQUEST_ID", request_id);
    cmd.env("GX_WORK_DIR", work_dir);
    if let Some(name) = tool_name {
        cmd.env("GX_TOOL_NAME", name);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn hook '{}': {e}", cmd_str))?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload = json!({
            "event": event_name,
            "request_id": request_id,
            "work_dir": work_dir,
            "tool_name": tool_name,
            "tool_input": tool_input.map(|s| s.chars().take(8192).collect::<String>()),
            "tool_output": tool_output.map(|s| s.chars().take(8192).collect::<String>()),
        });
        let _ = stdin.write_all(payload.to_string().as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let timeout_secs = hook.timeout_secs.clamp(1, MAX_HOOK_TIMEOUT_SECS);
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| format!("Hook '{}' timed out after {}s", cmd_str, timeout_secs))?
        .map_err(|e| format!("Hook '{}' failed: {e}", cmd_str))?;

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr.trim());
    }
    let truncated: String = combined
        .trim()
        .chars()
        .take(MAX_HOOK_OUTPUT_BYTES)
        .collect();
    Ok(HookRunResult {
        success: output.status.success(),
        exit_code: output.status.code(),
        output: truncated,
    })
}

fn emit_hook_event(
    window: &tauri::Window,
    request_id: &str,
    event_name: &str,
    command: &str,
    success: bool,
    output: &str,
) {
    let _ = window.emit(
        "agent-hook-event",
        json!({
            "requestId": request_id,
            "event": event_name,
            "command": command,
            "success": success,
            "output": output,
        }),
    );
}

pub async fn run_pre_tool_hooks(
    window: &tauri::Window,
    request_id: &str,
    work_dir: &str,
    tool_name: &str,
    tool_input: &str,
) -> PreHookDecision {
    let hooks = match load_project_hooks(work_dir) {
        Ok(Some(cfg)) => cfg.pre_tool_use,
        Ok(None) => return PreHookDecision::Allow,
        Err(err) => {
            emit_hook_event(window, request_id, "PreToolUse", "hooks.json", false, &err);
            return PreHookDecision::Allow;
        }
    };

    for hook in hooks {
        if !matcher_matches(&hook.matcher, tool_name) {
            continue;
        }
        match run_single_hook(
            "PreToolUse",
            &hook,
            work_dir,
            request_id,
            Some(tool_name),
            Some(tool_input),
            None,
        )
        .await
        {
            Ok(res) if res.success => {
                emit_hook_event(
                    window,
                    request_id,
                    "PreToolUse",
                    &hook.command,
                    true,
                    &res.output,
                );
            }
            Ok(res) => {
                let reason = if res.output.is_empty() {
                    format!(
                        "Blocked by PreToolUse hook '{}' (exit code {:?})",
                        hook.command, res.exit_code
                    )
                } else {
                    format!("Blocked by PreToolUse hook: {}", res.output)
                };
                emit_hook_event(
                    window,
                    request_id,
                    "PreToolUse",
                    &hook.command,
                    false,
                    &reason,
                );
                return PreHookDecision::Block(reason);
            }
            Err(err) => {
                emit_hook_event(window, request_id, "PreToolUse", &hook.command, false, &err);
                return PreHookDecision::Block(err);
            }
        }
    }
    PreHookDecision::Allow
}

pub async fn run_post_tool_hooks(
    window: &tauri::Window,
    request_id: &str,
    work_dir: &str,
    tool_name: &str,
    tool_input: &str,
    tool_output: &str,
) -> Option<String> {
    let Ok(Some(cfg)) = load_project_hooks(work_dir) else {
        return None;
    };
    let mut notes = Vec::new();
    for hook in cfg.post_tool_use {
        if !matcher_matches(&hook.matcher, tool_name) {
            continue;
        }
        match run_single_hook(
            "PostToolUse",
            &hook,
            work_dir,
            request_id,
            Some(tool_name),
            Some(tool_input),
            Some(tool_output),
        )
        .await
        {
            Ok(res) => {
                emit_hook_event(
                    window,
                    request_id,
                    "PostToolUse",
                    &hook.command,
                    res.success,
                    &res.output,
                );
                if !res.output.is_empty() {
                    let prefix = if res.success {
                        "Hook output"
                    } else {
                        "Hook failed"
                    };
                    notes.push(format!("[PostToolUse {}]: {}", prefix, res.output));
                } else if !res.success {
                    notes.push(format!(
                        "[PostToolUse hook '{}' exited with {:?}]",
                        hook.command, res.exit_code
                    ));
                }
            }
            Err(err) => {
                emit_hook_event(
                    window,
                    request_id,
                    "PostToolUse",
                    &hook.command,
                    false,
                    &err,
                );
                notes.push(format!("[PostToolUse error]: {err}"));
            }
        }
    }
    (!notes.is_empty()).then(|| notes.join("\n"))
}

pub async fn run_stop_hooks(window: &tauri::Window, request_id: &str, work_dir: &str) {
    let Ok(Some(cfg)) = load_project_hooks(work_dir) else {
        return;
    };
    for hook in cfg.stop {
        if !matcher_matches(&hook.matcher, "stop") {
            continue;
        }
        match run_single_hook("Stop", &hook, work_dir, request_id, None, None, None).await {
            Ok(res) => {
                emit_hook_event(
                    window,
                    request_id,
                    "Stop",
                    &hook.command,
                    res.success,
                    &res.output,
                );
            }
            Err(err) => {
                emit_hook_event(window, request_id, "Stop", &hook.command, false, &err);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_supports_wildcards_alternatives_and_regex() {
        assert!(matcher_matches("", "write_file"));
        assert!(matcher_matches("*", "execute_command"));
        assert!(matcher_matches("write_file|edit_file", "edit_file"));
        assert!(!matcher_matches("write_file|edit_file", "read_file"));
        assert!(matcher_matches("mcp_.*", "mcp_abc_query"));
    }

    #[test]
    fn loads_project_hooks_config_from_workspace() {
        let dir = std::env::temp_dir().join(format!("gx-hooks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".gxagent")).unwrap();
        std::fs::write(
            dir.join(".gxagent/hooks.json"),
            r#"{"PreToolUse":[{"matcher":"write_file","command":"echo ok","timeout_secs":5}],"PostToolUse":[],"Stop":[{"command":"echo done"}]}"#,
        )
        .unwrap();

        let cfg = load_project_hooks(&dir.to_string_lossy()).unwrap().unwrap();
        assert_eq!(cfg.pre_tool_use.len(), 1);
        assert_eq!(cfg.pre_tool_use[0].matcher, "write_file");
        assert_eq!(cfg.pre_tool_use[0].timeout_secs, 5);
        assert_eq!(cfg.stop.len(), 1);

        std::fs::remove_dir_all(dir).unwrap();
    }
}
