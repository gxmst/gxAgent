use crate::tools::{scrub_sensitive_env, terminate_process_tree};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    #[serde(skip)]
    work_dir: String,
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
    let root = Path::new(trimmed);
    let path = root.join(".gxagent").join("hooks.json");
    if !path.is_file() {
        return Ok(None);
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Project .gxagent/hooks.json resolves outside the workspace root".into());
    }
    let meta = std::fs::metadata(&canonical_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_HOOKS_FILE_BYTES {
        return Err("Project .gxagent/hooks.json exceeds 128 KB".into());
    }
    let raw = std::fs::read_to_string(&canonical_path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let mut config: HooksConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid .gxagent/hooks.json: {e}"))?;
    config.work_dir = canonical_root.to_string_lossy().into_owned();
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

async fn read_hook_output<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(n) = pipe.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        let remaining = MAX_HOOK_OUTPUT_BYTES.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..n.min(remaining)]);
    }
    String::from_utf8_lossy(&retained).into_owned()
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
        c.creation_flags(0x08000000 | 0x00000200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", cmd_str]);
        #[cfg(not(windows))]
        c.process_group(0);
        c
    };

    scrub_sensitive_env(&mut cmd);
    if !work_dir.trim().is_empty() {
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

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let payload = json!({
        "event": event_name,
        "request_id": request_id,
        "work_dir": work_dir,
        "tool_name": tool_name,
        "tool_input": tool_input.map(|s| s.chars().take(8192).collect::<String>()),
        "tool_output": tool_output.map(|s| s.chars().take(8192).collect::<String>()),
    })
    .to_string();
    let write_input = async move {
        if let Some(mut pipe) = stdin {
            let _ = pipe.write_all(payload.as_bytes()).await;
        }
    };
    let timeout_secs = hook.timeout_secs.clamp(1, MAX_HOOK_TIMEOUT_SECS);
    let run = async {
        let ((), out, err) = tokio::join!(
            write_input,
            read_hook_output(stdout),
            read_hook_output(stderr)
        );
        (child.wait().await, out, err)
    };
    let (status, stdout_text, stderr_text) =
        match tokio::time::timeout(Duration::from_secs(timeout_secs), run).await {
            Ok(result) => result,
            Err(_) => {
                terminate_process_tree(&mut child).await;
                return Err(format!(
                    "Hook '{}' timed out after {}s",
                    cmd_str, timeout_secs
                ));
            }
        };
    let status = status.map_err(|e| format!("Hook '{}' failed: {e}", cmd_str))?;

    let mut combined = stdout_text;
    if !stderr_text.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr_text.trim());
    }
    let truncated: String = combined
        .trim()
        .chars()
        .take(MAX_HOOK_OUTPUT_BYTES)
        .collect();
    Ok(HookRunResult {
        success: status.success(),
        exit_code: status.code(),
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

impl HooksConfig {
    /// Keep only the approved snapshot for each canonical workspace during this process.
    pub async fn for_run<F: std::future::Future<Output = Result<bool, String>>>(
        work_dir: &str,
        plan_mode: bool,
        confirm: impl FnOnce(String) -> F,
    ) -> Result<Self, String> {
        use std::collections::HashMap;
        use std::sync::{LazyLock, Mutex};
        static TRUSTED: LazyLock<Mutex<HashMap<String, HooksConfig>>> =
            LazyLock::new(Default::default);
        if plan_mode {
            return Ok(Self::default());
        }
        let Some(hooks) = load_project_hooks(work_dir)? else {
            return Ok(Self::default());
        };
        if hooks.pre_tool_use.is_empty() && hooks.post_tool_use.is_empty() && hooks.stop.is_empty()
        {
            return Ok(Self::default());
        }
        if TRUSTED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&hooks.work_dir)
            == Some(&hooks)
        {
            return Ok(hooks);
        }
        let details =
            serde_json::to_string_pretty(&json!({"workspace": &hooks.work_dir, "hooks": &hooks}))
                .map_err(|e| e.to_string())?;
        if !confirm(details).await? {
            return Ok(Self::default());
        }
        TRUSTED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hooks.work_dir.clone(), hooks.clone());
        Ok(hooks)
    }

    pub async fn run_pre_tool_hooks(
        &self,
        window: &tauri::Window,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> PreHookDecision {
        let work_dir = &self.work_dir;
        for hook in &self.pre_tool_use {
            if !matcher_matches(&hook.matcher, tool_name) {
                continue;
            }
            match run_single_hook(
                "PreToolUse",
                hook,
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
        &self,
        window: &tauri::Window,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
        tool_output: &str,
    ) -> Option<String> {
        let work_dir = &self.work_dir;
        let mut notes = Vec::new();
        for hook in &self.post_tool_use {
            if !matcher_matches(&hook.matcher, tool_name) {
                continue;
            }
            match run_single_hook(
                "PostToolUse",
                hook,
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

    pub async fn run_stop_hooks(&self, window: &tauri::Window, request_id: &str) {
        let work_dir = &self.work_dir;
        for hook in &self.stop {
            if !matcher_matches(&hook.matcher, "stop") {
                continue;
            }
            match run_single_hook("Stop", hook, work_dir, request_id, None, None, None).await {
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

    #[tokio::test]
    async fn hook_io_is_drained_and_the_deadline_includes_stdin() {
        let hook = HookEntry {
            command: if cfg!(windows) {
                "[Console]::Out.Write(('a' * 90000)); [Console]::Error.Write(('b' * 90000))"
            } else {
                "head -c 90000 /dev/zero | tr '\\0' a; head -c 90000 /dev/zero | tr '\\0' b >&2"
            }
            .into(),
            timeout_secs: 10,
            ..HookEntry::default()
        };
        let output = run_single_hook("Stop", &hook, "", "test", None, None, None)
            .await
            .unwrap();
        assert!(output.success);
        assert_eq!(output.output.len(), MAX_HOOK_OUTPUT_BYTES);
        let slow = HookEntry {
            command: if cfg!(windows) {
                "Start-Sleep 15"
            } else {
                "sleep 15"
            }
            .into(),
            timeout_secs: 1,
            ..HookEntry::default()
        };
        let input = "文".repeat(8192);
        let result = tokio::time::timeout(
            Duration::from_secs(9),
            run_single_hook("PreToolUse", &slow, "", "test", None, Some(&input), None),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(error) if error.contains("timed out")));
    }

    #[tokio::test]
    async fn trust_is_scoped_to_the_approved_workspace_snapshot_and_skipped_in_plans() {
        let root = std::env::temp_dir().join(format!("gx-hook-trust-{}", uuid::Uuid::new_v4()));
        let other = root.join("other");
        let folder = root.join(".gxagent");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(other.join(".gxagent")).unwrap();
        let initial = r#"{"Stop":[{"command":"echo first"}]}"#;
        std::fs::write(folder.join("hooks.json"), initial).unwrap();
        std::fs::write(other.join(".gxagent/hooks.json"), initial).unwrap();
        let no_prompt = |_| async { panic!("unexpected approval request") };
        let dir = root.to_str().unwrap();
        assert!(HooksConfig::for_run(dir, true, no_prompt)
            .await
            .unwrap()
            .stop
            .is_empty());
        let approved = HooksConfig::for_run(dir, false, |details| async move {
            assert!(details.contains("echo first"));
            Ok(true)
        })
        .await
        .unwrap();
        assert_eq!(
            HooksConfig::for_run(dir, false, no_prompt).await.unwrap(),
            approved
        );
        assert!(
            HooksConfig::for_run(other.to_str().unwrap(), false, |_| async { Ok(false) })
                .await
                .unwrap()
                .stop
                .is_empty()
        );
        std::fs::write(
            folder.join("hooks.json"),
            r#"{"Stop":[{"command":"echo second"}]}"#,
        )
        .unwrap();
        assert!(HooksConfig::for_run(dir, false, |_| async { Ok(false) })
            .await
            .unwrap()
            .stop
            .is_empty());
        assert_eq!(approved.stop[0].command, "echo first");
        std::fs::remove_dir_all(root).unwrap();
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
