use crate::audit::AuditLogger;
use crate::config::AppConfig;
use crate::mcp::McpManager;
use crate::policy::{check_approval, ApprovalLevel};
use crate::provider;
use crate::text::{utf8_prefix, utf8_suffix, IncrementalUtf8Decoder};
use crate::tools::{
    execute_tool_with_control, get_enabled_tool_definitions, ExecutionChunk, TOOL_CANCELLED_ERROR,
};
use crate::workspace;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Window};

/// Sanitize arguments for logging - redact sensitive information
fn sanitize_args_for_log(args: &str) -> String {
    let lower = args.to_lowercase();
    if lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("authorization")
        || lower.contains("bearer")
    {
        return "[REDACTED - contains sensitive data]".to_string();
    }
    if args.chars().count() > 200 {
        let truncated: String = args.chars().take(200).collect();
        format!("{}... [truncated]", truncated)
    } else {
        args.to_string()
    }
}

/// Parse search result text into structured sources for frontend display
fn parse_search_sources(tool_output: &str) -> Vec<Value> {
    tool_output
        .split("\n---\n")
        .filter_map(|block| {
            let title = block
                .lines()
                .find(|l| l.starts_with("Title:"))
                .map(|l| l.trim_start_matches("Title:").trim().to_string())
                .unwrap_or_default();
            let link = block
                .lines()
                .find(|l| l.starts_with("Link:"))
                .map(|l| l.trim_start_matches("Link:").trim().to_string())
                .unwrap_or_default();
            let snippet = block
                .lines()
                .find(|l| l.starts_with("Snippet:"))
                .map(|l| l.trim_start_matches("Snippet:").trim().to_string())
                .unwrap_or_default();
            if title.is_empty() && snippet.is_empty() {
                None
            } else {
                Some(json!({ "title": title, "link": link, "snippet": snippet }))
            }
        })
        .take(5)
        .collect()
}

const MAX_LOOPS: u32 = 20;
const ABSOLUTE_MAX_TOOL_CALLS_PER_REQUEST: u32 = 100;

const SEARCH_FOLLOWUP_INSTRUCTION: &str = "You have just received web search results. You MUST base your answer on these search results. Cite the sources by mentioning the title and link when referencing information. If the search results are insufficient to fully answer the question, clearly state what information is missing and what you could find. Do not make up information not present in the search results.";
const GENERAL_ASSISTANT_INSTRUCTION: &str = "Assistant behavior: Be helpful, careful, and honest. Answer in the user's language when practical. If information is uncertain, outdated, or unavailable, say so clearly. Do not invent facts, citations, files, command results, or tool output. Ask for clarification when the user's goal is ambiguous and a wrong assumption would be risky.";
const DEFAULT_CHAT_SYSTEM_PROMPT: &str = "You are a helpful AI assistant. Be careful, honest, and practical. Answer in the user's language when practical. If you are unsure or lack enough information, say so instead of guessing. When using web search, ground the answer in the search results and cite relevant sources.";
const ROLE_PRESET_BEGIN_MARKER: &str = "<<<GXAGENT_ACTIVE_ROLE_PRESET_BEGIN>>>";
const ROLE_PRESET_END_MARKER: &str = "<<<GXAGENT_ACTIVE_ROLE_PRESET_END>>>";
const USER_REQUEST_BEGIN_MARKER: &str = "<<<GXAGENT_USER_REQUEST_BEGIN>>>";
const USER_REQUEST_END_MARKER: &str = "<<<GXAGENT_USER_REQUEST_END>>>";

fn resolve_chat_system_prompt(configured_prompt: &str) -> String {
    if configured_prompt.trim().is_empty() {
        DEFAULT_CHAT_SYSTEM_PROMPT.to_string()
    } else {
        configured_prompt.to_string()
    }
}

/// Some OpenAI-compatible Claude/Kiro gateways silently ignore the canonical
/// system message. Repeat only an explicitly active role preset at user level
/// for the current outbound request. The UI history keeps the original user
/// text, and the leading marker prevents accidental double wrapping.
fn prepend_active_role_prompt(user_prompt: &str, role_prompt: Option<&str>) -> String {
    let Some(role_prompt) = role_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    else {
        return user_prompt.to_string();
    };
    if user_prompt
        .trim_start()
        .starts_with(ROLE_PRESET_BEGIN_MARKER)
    {
        return user_prompt.to_string();
    }

    format!(
        "{ROLE_PRESET_BEGIN_MARKER}\nThe following role preset was explicitly selected by the user. Apply it to this response while keeping the user's actual request separate.\n{role_prompt}\n{ROLE_PRESET_END_MARKER}\n\n{USER_REQUEST_BEGIN_MARKER}\n{user_prompt}\n{USER_REQUEST_END_MARKER}"
    )
}

/// Agentic workflow guidance injected only in Code mode. This shapes the
/// explore -> plan -> act -> verify loop that makes tool-using agents reliable,
/// and steers the model toward the dedicated tools over ad-hoc shell commands.
const CODE_MODE_INSTRUCTION: &str = "Code mode workflow — follow this loop for engineering tasks:\n\
1. Explore before acting. Understand the existing code before changing it. Use grep to find symbols/usages, glob to discover files, and read_file to inspect them. Do not guess at file contents or APIs — verify them.\n\
2. Plan for non-trivial work. For any task beyond a one-line change, briefly outline the steps first. Use the todo_write tool to track multi-step tasks so progress stays visible; mark each step in_progress before starting it and completed when done.\n\
3. Prefer precise edits. Use edit_file for modifying existing files (exact string replacement) instead of rewriting whole files with write_file. Reserve write_file for creating new files. Match existing code style, naming, and libraries.\n\
4. Prefer dedicated tools over shell. Use read_file/grep/glob/edit_file rather than running cat/findstr/Select-String through execute_command — they are faster and safer.\n\
5. Verify your work. After changes, run the project's build/test/lint where possible and fix what you broke before reporting done. State what you verified and what you could not.\n\
6. Be honest about outcomes. If a command fails or a step is skipped, say so with the evidence. Do not claim success you did not confirm. When an action is destructive or hard to undo, confirm with the user first.";

fn append_code_mode_instruction(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(CODE_MODE_INSTRUCTION);
}

fn configured_max_agent_loops(config: &AppConfig) -> u32 {
    config.max_agent_loops.clamp(1, MAX_LOOPS)
}

fn configured_max_tool_calls(config: &AppConfig) -> u32 {
    config
        .max_tool_calls_per_request
        .clamp(1, ABSOLUTE_MAX_TOOL_CALLS_PER_REQUEST)
}

/// OS-specific shell guidance, appended in code mode so the model uses the
/// correct command syntax for the machine the app is actually running on.
fn shell_guidance() -> &'static str {
    if cfg!(target_os = "windows") {
        "Shell environment: the execute_command tool runs in Windows PowerShell. Use PowerShell syntax, not Unix/bash. Chain commands with ; (not && or ||). Use cmdlets: Get-ChildItem (not ls), Get-Content (not cat), Select-String (not grep), Remove-Item (not rm). Redirect errors with 2>$null. Use Windows-style paths with backslashes."
    } else if cfg!(target_os = "macos") {
        "Shell environment: the execute_command tool runs in a POSIX shell (sh/bash/zsh) on macOS. Use standard Unix syntax: chain commands with && or ;, and use ls, cat, grep, rm, find. Use forward-slash paths."
    } else {
        "Shell environment: the execute_command tool runs in a POSIX shell (sh/bash) on Linux. Use standard Unix syntax: chain commands with && or ;, and use ls, cat, grep, rm, find. Use forward-slash paths."
    }
}

fn append_shell_guidance(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(shell_guidance());
}

// Steering messages are keyed by request_id so concurrent sessions/requests
// never cross-contaminate each other's intervention queues.
static STEERING_QUEUE: once_cell::sync::Lazy<
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, Vec<String>>>>,
> = once_cell::sync::Lazy::new(|| {
    Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
});

const AGENT_CANCELLED_ERROR: &str = "__GX_AGENT_CANCELLED__";

type CancellationMap = std::collections::HashMap<String, watch::Sender<bool>>;

static AGENT_CANCELLATIONS: once_cell::sync::Lazy<Arc<tokio::sync::Mutex<CancellationMap>>> =
    once_cell::sync::Lazy::new(|| Arc::new(tokio::sync::Mutex::new(CancellationMap::new())));

static CHECKPOINTED_REQUESTS: once_cell::sync::Lazy<
    Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
> = once_cell::sync::Lazy::new(|| {
    Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()))
});

pub(crate) async fn register_cancellation(request_id: &str) -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    let mut cancellations = AGENT_CANCELLATIONS.lock().await;
    cancellations.insert(request_id.to_string(), tx);
    rx
}

pub(crate) async fn unregister_cancellation(request_id: &str) {
    {
        let mut cancellations = AGENT_CANCELLATIONS.lock().await;
        cancellations.remove(request_id);
    }
    CHECKPOINTED_REQUESTS.lock().await.remove(request_id);
}

pub async fn cancel_agent_request(request_id: &str) -> Result<(), String> {
    let cancellations = AGENT_CANCELLATIONS.lock().await;
    let tx = cancellations
        .get(request_id)
        .ok_or_else(|| format!("No active agent request found: {}", request_id))?;
    tx.send(true)
        .map_err(|_| "Failed to signal agent cancellation".to_string())
}

fn is_cancelled(cancel_rx: &watch::Receiver<bool>) -> bool {
    *cancel_rx.borrow()
}

fn ensure_not_cancelled(cancel_rx: &watch::Receiver<bool>) -> Result<(), String> {
    if is_cancelled(cancel_rx) {
        Err(AGENT_CANCELLED_ERROR.to_string())
    } else {
        Ok(())
    }
}

fn is_agent_cancelled_error(err: &str) -> bool {
    err == AGENT_CANCELLED_ERROR
}

pub(crate) async fn wait_for_cancellation(cancel_rx: &mut watch::Receiver<bool>) {
    if *cancel_rx.borrow() {
        return;
    }
    while cancel_rx.changed().await.is_ok() {
        if *cancel_rx.borrow() {
            return;
        }
    }
}

async fn await_with_cancel<T, F>(cancel_rx: &watch::Receiver<bool>, future: F) -> Result<T, String>
where
    F: Future<Output = T>,
{
    let mut cancel_rx = cancel_rx.clone();
    tokio::select! {
        _ = wait_for_cancellation(&mut cancel_rx) => Err(AGENT_CANCELLED_ERROR.to_string()),
        value = future => Ok(value),
    }
}

/// Check if search followup instruction already exists in recent messages
fn has_search_instruction(messages: &[Value]) -> bool {
    messages.iter().rev().take(3).any(|msg| {
        msg["role"] == "system"
            && msg["content"]
                .as_str()
                .unwrap_or("")
                .contains("MUST base your answer on these search results")
    })
}

/// Add search followup instruction if not already present
fn add_search_instruction(messages: &mut Vec<Value>) {
    if !has_search_instruction(messages) {
        messages.push(json!({
            "role": "system",
            "content": SEARCH_FOLLOWUP_INSTRUCTION
        }));
    }
}

fn append_general_assistant_instruction(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(GENERAL_ASSISTANT_INSTRUCTION);
}

fn emit_stream_chunk(window: &Window, request_id: &str, content: impl Into<String>) {
    let _ = window.emit(
        "agent-stream-chunk",
        json!({
            "requestId": request_id,
            "content": content.into(),
        }),
    );
}

fn emit_reasoning_chunk(window: &Window, request_id: &str, content: impl Into<String>) {
    let _ = window.emit(
        "agent-reasoning-chunk",
        json!({
            "requestId": request_id,
            "content": content.into(),
        }),
    );
}

fn emit_stream_done(window: &Window, request_id: &str, mut payload: Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit("agent-stream-done", payload);
}

fn emit_agent_complete(window: &Window, request_id: &str, status: &str) {
    let _ = window.emit(
        "agent-complete",
        json!({
            "requestId": request_id,
            "status": status,
        }),
    );
}

fn emit_usage(window: &Window, request_id: &str, mut payload: Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit("agent-usage", payload);
}

fn emit_request_event(window: &Window, event: &str, request_id: &str, mut payload: Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit(event, payload);
}

fn normalized_thinking_level(level: &str) -> &'static str {
    if level.eq_ignore_ascii_case("low") {
        "low"
    } else if level.eq_ignore_ascii_case("high") {
        "high"
    } else {
        "medium"
    }
}

fn thinking_instruction(level: &str) -> &'static str {
    match normalized_thinking_level(level) {
        "low" => "Reasoning effort: low. Prefer direct answers and avoid unnecessary exploration unless the task clearly requires it.",
        "high" => "Reasoning effort: high. Spend more internal effort on planning, edge cases, and verification, but do not reveal hidden chain-of-thought.",
        _ => "Reasoning effort: medium. Balance speed with enough internal checking for correctness, and do not reveal hidden chain-of-thought.",
    }
}

fn append_thinking_instruction(system_prompt: &mut String, level: &str) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(thinking_instruction(level));
}

fn supports_reasoning_effort(config: &AppConfig) -> bool {
    let base_url = config.base_url.to_ascii_lowercase();
    let model = config.model.to_ascii_lowercase();
    let is_openai = base_url.contains("api.openai.com") || base_url.contains("openai.azure.com");
    is_openai
        && (model.starts_with("o1")
            || model.starts_with("o3")
            || model.starts_with("o4")
            || model.starts_with("gpt-5"))
}

fn apply_reasoning_effort(request_body: &mut Value, config: &AppConfig, is_ollama: bool) {
    if is_ollama || !supports_reasoning_effort(config) {
        return;
    }
    request_body["reasoning_effort"] = json!(normalized_thinking_level(&config.thinking_level));
}

pub async fn push_steering_message(request_id: String, msg: String) {
    let mut queue = STEERING_QUEUE.lock().await;
    queue.entry(request_id).or_default().push(msg);
}

async fn drain_steering_messages(request_id: &str) -> Vec<String> {
    let mut queue = STEERING_QUEUE.lock().await;
    match queue.get_mut(request_id) {
        Some(msgs) => msgs.drain(..).collect(),
        None => Vec::new(),
    }
}

/// Remove any steering queue for a finished request so the map doesn't grow
/// unbounded across many requests.
async fn clear_steering_messages(request_id: &str) {
    let mut queue = STEERING_QUEUE.lock().await;
    queue.remove(request_id);
}

fn load_workspace_rules(work_dir: &str) -> Option<(String, String)> {
    let start_path = Path::new(work_dir);
    let rule_files = [".gxagent.md", "AGENTS.md", "CLAUDE.md"];

    let mut current = Some(start_path);
    while let Some(dir) = current {
        for filename in &rule_files {
            let rule_path = dir.join(filename);
            if rule_path.exists() && rule_path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&rule_path) {
                    let name = filename.to_string();
                    return Some((content, name));
                }
            }
        }
        current = dir.parent();
    }
    None
}

fn estimate_message_tokens(msg: &Value) -> u64 {
    let content = msg["content"].as_str().unwrap_or("");
    (content.len() as u64) / 4
}

fn compact_messages(messages: &mut Vec<Value>, context_limit: usize) {
    if messages.len() <= 6 {
        return;
    }

    let protect_first = 1;
    let protect_last = 4;

    let total_len = messages.len();
    if total_len <= protect_first + protect_last {
        return;
    }

    let mut total_tokens: u64 = 0;
    for msg in messages.iter() {
        total_tokens += estimate_message_tokens(msg);
    }

    let limit_tokens = context_limit as u64 * 4;
    if total_tokens < limit_tokens {
        return;
    }

    for i in protect_first..(total_len - protect_last) {
        let msg = &mut messages[i];
        if msg["role"] == "tool" {
            if let Some(content) = msg["content"].as_str() {
                if content.len() > 800 {
                    let truncated = format!(
                        "⚡[Tool output truncated] Prefix:\n{}\n...\n[{} chars omitted]\n...\nSuffix:\n{}",
                        utf8_prefix(content, 400),
                        content.len().saturating_sub(800),
                        utf8_suffix(content, 400)
                    );
                    msg["content"] = json!(truncated);
                }
            }
        } else if msg["role"] == "user" || msg["role"] == "assistant" {
            if let Some(content) = msg["content"].as_str() {
                if content.len() > 2000 {
                    let truncated = format!(
                        "{}\n...\n[{} chars omitted]",
                        utf8_prefix(content, 1500),
                        content.len().saturating_sub(1500)
                    );
                    msg["content"] = json!(truncated);
                }
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub approval_level: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolApprovalRequest {
    pub request_id: String,
    pub tool_calls: Vec<PendingToolCall>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccumulatedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageAttachment {
    pub name: String,
    pub data: String,
    #[serde(default, rename = "mimeType")]
    pub mime_type: Option<String>,
}

fn attachment_mime_type(att: &ImageAttachment) -> &str {
    att.mime_type
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("image/png")
}

fn attachment_data_url(att: &ImageAttachment) -> String {
    let data = att.data.trim();
    if data.starts_with("data:") {
        data.to_string()
    } else {
        format!("data:{};base64,{}", attachment_mime_type(att), data)
    }
}

fn attachment_base64(att: &ImageAttachment) -> String {
    let data = att.data.trim();
    if let Some((_, base64)) = data.split_once(',') {
        base64.to_string()
    } else {
        data.to_string()
    }
}

fn build_user_message(
    content: String,
    image_attachments: &[ImageAttachment],
    is_ollama: bool,
) -> Value {
    if image_attachments.is_empty() {
        return json!({
            "role": "user",
            "content": content
        });
    }

    if is_ollama {
        return json!({
            "role": "user",
            "content": content,
            "images": image_attachments.iter().map(attachment_base64).collect::<Vec<_>>()
        });
    }

    let mut parts = vec![json!({
        "type": "text",
        "text": content
    })];
    for att in image_attachments {
        parts.push(json!({
            "type": "image_url",
            "image_url": {
                "url": attachment_data_url(att)
            }
        }));
    }

    json!({
        "role": "user",
        "content": parts
    })
}

fn image_attachments_from_message(msg: &Value) -> Vec<ImageAttachment> {
    msg.get("attachments")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<ImageAttachment>(item.clone()).ok())
                .filter(|att| !att.data.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_session_messages(messages: Vec<Value>, is_ollama: bool) -> Vec<Value> {
    messages
        .into_iter()
        .map(|mut msg| {
            let images = image_attachments_from_message(&msg);
            let is_user = msg.get("role").and_then(|v| v.as_str()) == Some("user");
            if is_user && !images.is_empty() {
                let content = msg
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return build_user_message(content, &images, is_ollama);
            }

            if let Some(obj) = msg.as_object_mut() {
                obj.remove("attachments");
            }
            msg
        })
        .collect()
}

/// Core agent loop with streaming and human-in-the-loop approval
pub async fn start_agent_loop(
    window: Window,
    request_id: String,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    session_mode: String,
    search_mode: String,
    image_attachments: Vec<ImageAttachment>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let cancel_rx = register_cancellation(&request_id).await;

    let result = if session_mode == "chat" {
        run_chat_mode(
            window.clone(),
            request_id.clone(),
            client,
            user_prompt,
            config,
            session_messages,
            search_mode,
            image_attachments,
            cancel_rx.clone(),
        )
        .await
    } else {
        let mut mcp_manager = McpManager::new();
        let mcp_tool_defs = if !config.mcp_servers.is_empty() {
            let report = mcp_manager.start_all(&config.mcp_servers).await;
            let started = report
                .servers
                .iter()
                .filter(|server| server.status == "started")
                .count();
            let failed = report.servers.len().saturating_sub(started);
            let status = if failed == 0 {
                "started"
            } else if started == 0 {
                "error"
            } else {
                "partial"
            };
            emit_request_event(
                &window,
                "agent-mcp-status",
                &request_id,
                json!({
                    "status": status,
                    "servers": report.servers.len(),
                    "serverStatuses": report.servers,
                    "started": started,
                    "failed": failed,
                    "tools": report.tool_definitions.len(),
                }),
            );
            report.tool_definitions
        } else {
            Vec::new()
        };

        let result = start_agent_loop_inner(
            window.clone(),
            request_id.clone(),
            client,
            user_prompt,
            config,
            session_messages,
            image_attachments,
            &mut mcp_manager,
            mcp_tool_defs,
            cancel_rx.clone(),
        )
        .await;
        mcp_manager.shutdown().await;
        result
    };

    unregister_cancellation(&request_id).await;
    clear_steering_messages(&request_id).await;

    if let Err(err) = &result {
        if is_agent_cancelled_error(err) {
            emit_stream_done(
                &window,
                &request_id,
                json!({
                    "content": "",
                    "status": "cancelled",
                    "loopCount": 0,
                    "ttftMs": 0,
                    "responseTimeMs": 0,
                }),
            );
            emit_agent_complete(&window, &request_id, "cancelled");
            return Ok(());
        }
    }
    result
}

/// Result of fully consuming one streaming model response.
struct StreamOutcome {
    content: String,
    #[allow(dead_code)]
    reasoning: String,
    tool_calls: Vec<AccumulatedToolCall>,
    prompt_tokens: u64,
    completion_tokens: u64,
    ttft_ms: Option<u64>,
    /// True if DSML markers were seen in the content (DeepSeek text-format tool
    /// calls). When set, the raw (un-emitted) DSML text is in `dsml_buffer` and
    /// the caller is responsible for parsing/stripping it.
    dsml_buffering: bool,
    dsml_buffer: String,
}

/// Consume a streaming HTTP response through the provider adapter, emitting
/// content/reasoning chunks to the frontend and accumulating tool calls.
///
/// This is provider-agnostic: it splits the byte stream into lines (SSE or
/// JSONL depending on `wire`), feeds each line to `provider::parse_stream_line`,
/// and folds the normalized [`provider::StreamDelta`]s into an OpenAI-shaped
/// outcome that the rest of the agent already understands.
///
/// `emit_drafting` controls whether `agent-tool-drafting` events are emitted as
/// tool arguments stream in (used by the agent loop, not the chat-mode search).
#[allow(clippy::too_many_arguments)]
async fn consume_stream(
    window: &Window,
    request_id: &str,
    wire: provider::Wire,
    response: reqwest::Response,
    request_start: Instant,
    cancel_rx: &watch::Receiver<bool>,
    emit_drafting: bool,
    dsml_aware: bool,
) -> Result<StreamOutcome, String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut utf8_decoder = IncrementalUtf8Decoder::default();
    let mut state = provider::StreamState::default();

    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<AccumulatedToolCall> = Vec::new();
    let mut prompt_tokens: u64 = 0;
    let mut completion_tokens: u64 = 0;
    let mut ttft_ms: Option<u64> = None;
    let mut first_content = false;
    let mut done = false;
    let mut dsml_buffering = false;
    let mut dsml_buffer = String::new();

    // Emit visible content, except: when DSML markers appear (DeepSeek text-format
    // tool calls) we buffer the raw text instead of streaming it, so the caller can
    // parse + strip the markers before showing anything.
    let emit_content =
        |text: &str, content: &mut String, dsml_buffering: &mut bool, dsml_buffer: &mut String| {
            content.push_str(text);
            if dsml_aware && (text.contains("DSML") || *dsml_buffering) {
                *dsml_buffering = true;
                dsml_buffer.push_str(text);
            } else {
                emit_stream_chunk(window, request_id, text);
            }
        };

    while !done {
        let chunk = match await_with_cancel(cancel_rx, stream.next()).await? {
            Some(c) => c.map_err(|e| format!("Stream error: {}", e))?,
            None => break,
        };
        buffer.push_str(&utf8_decoder.push(&chunk));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();
            if line.is_empty() {
                continue;
            }

            for delta in provider::parse_stream_line(wire, &line, &mut state) {
                if let Some(text) = delta.content {
                    if !first_content {
                        first_content = true;
                        ttft_ms = Some(request_start.elapsed().as_millis() as u64);
                    }
                    emit_content(&text, &mut content, &mut dsml_buffering, &mut dsml_buffer);
                }
                if let Some(think) = delta.reasoning {
                    reasoning.push_str(&think);
                    emit_reasoning_chunk(window, request_id, &think);
                }
                for tc in delta.tool_calls {
                    apply_tool_call_delta(&mut tool_calls, tc, window, request_id, emit_drafting);
                }
                if let Some(pt) = delta.prompt_tokens {
                    prompt_tokens = pt;
                }
                if let Some(ct) = delta.completion_tokens {
                    completion_tokens = ct;
                }
                if delta.done {
                    done = true;
                }
            }
        }
    }

    buffer.push_str(&utf8_decoder.finish());

    // Flush any trailing buffered line (some servers omit a final newline).
    let tail = buffer.trim();
    if !tail.is_empty() {
        for delta in provider::parse_stream_line(wire, tail, &mut state) {
            if let Some(text) = delta.content {
                emit_content(&text, &mut content, &mut dsml_buffering, &mut dsml_buffer);
            }
            if let Some(think) = delta.reasoning {
                reasoning.push_str(&think);
                emit_reasoning_chunk(window, request_id, &think);
            }
            for tc in delta.tool_calls {
                apply_tool_call_delta(&mut tool_calls, tc, window, request_id, emit_drafting);
            }
            if let Some(pt) = delta.prompt_tokens {
                prompt_tokens = pt;
            }
            if let Some(ct) = delta.completion_tokens {
                completion_tokens = ct;
            }
        }
    }

    Ok(StreamOutcome {
        content,
        reasoning,
        tool_calls,
        prompt_tokens,
        completion_tokens,
        ttft_ms,
        dsml_buffering,
        dsml_buffer,
    })
}

/// Build a canonical (OpenAI-shaped) assistant message carrying tool calls.
/// Used to record the model's turn in history regardless of the wire format the
/// response actually arrived in, so the next request can be re-encoded for any
/// provider.
fn assistant_message_with_tool_calls(content: &str, calls: &[AccumulatedToolCall]) -> Value {
    let tool_calls_json: Vec<Value> = calls
        .iter()
        .map(|tc| {
            json!({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": tc.arguments,
                }
            })
        })
        .collect();
    json!({
        "role": "assistant",
        "content": if content.is_empty() { Value::Null } else { json!(content) },
        "tool_calls": tool_calls_json,
    })
}

/// Fold a normalized tool-call delta into the accumulator. Streaming fragments
/// arrive by `index`; id/name appear once, `arguments` is appended.
fn apply_tool_call_delta(
    acc: &mut Vec<AccumulatedToolCall>,
    delta: provider::ToolCallDelta,
    window: &Window,
    request_id: &str,
    emit_drafting: bool,
) {
    let idx = delta.index;
    while acc.len() <= idx {
        acc.push(AccumulatedToolCall {
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
    }
    if let Some(id) = delta.id {
        if !id.is_empty() {
            acc[idx].id = id;
        }
    }
    if let Some(name) = delta.name {
        if !name.is_empty() {
            acc[idx].name = name;
        }
    }
    if let Some(args) = delta.arguments {
        acc[idx].arguments.push_str(&args);
    }
    if acc[idx].id.is_empty() {
        acc[idx].id = format!("call_{}", idx);
    }
    if emit_drafting {
        let _ = window.emit(
            "agent-tool-drafting",
            json!({
                "requestId": request_id,
                "index": idx,
                "id": acc[idx].id,
                "name": acc[idx].name,
                "arguments": acc[idx].arguments,
            }),
        );
    }
}

/// Run one model turn for chat mode: build the request via the provider adapter,
/// stream the response through `consume_stream`, and (when DSML markers were
/// seen) re-parse the buffered text into tool calls. Returns the stream outcome,
/// with `tool_calls` already populated from either native tool calls or DSML.
#[allow(clippy::too_many_arguments)]
async fn chat_turn(
    window: &Window,
    request_id: &str,
    client: &reqwest::Client,
    wire: provider::Wire,
    config: &AppConfig,
    messages: &[Value],
    tools: &[Value],
    request_start: Instant,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<StreamOutcome, String> {
    let url = provider::build_url(wire, &config.base_url, &config.model, config.streaming);
    let body = provider::build_body(
        wire,
        &config.model,
        messages,
        tools,
        config,
        config.streaming,
    );
    let mut builder = client.post(&url);
    builder = provider::apply_auth(wire, builder, &config.api_key);

    ensure_not_cancelled(cancel_rx)?;
    let response = await_with_cancel(cancel_rx, builder.json(&body).send())
        .await?
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        emit_request_event(
            window,
            "agent-error",
            request_id,
            json!({ "error": error_text }),
        );
        return Err(format!("API error ({}): {}", status, error_text));
    }

    // DSML is a DeepSeek text-format tool-call convention only relevant on the
    // OpenAI wire; other providers express tool calls natively.
    let dsml_aware = matches!(wire, provider::Wire::OpenAI);

    if config.streaming {
        let mut outcome = consume_stream(
            window,
            request_id,
            wire,
            response,
            request_start,
            cancel_rx,
            false,
            dsml_aware,
        )
        .await?;

        // If the model emitted DSML text tool calls instead of native ones,
        // parse them out of the buffered content now.
        if outcome.tool_calls.is_empty() && outcome.dsml_buffering {
            let dsml_calls = parse_dsml_tool_calls(&outcome.content);
            if !dsml_calls.is_empty() {
                let clean = strip_dsml_tags(&outcome.content);
                let buffer_clean = strip_dsml_tags(&outcome.dsml_buffer);
                if !buffer_clean.trim().is_empty() {
                    emit_stream_chunk(window, request_id, &buffer_clean);
                }
                outcome.tool_calls = dsml_calls;
                outcome.content = clean;
            } else {
                let clean = strip_dsml_tags(&outcome.content);
                if !clean.trim().is_empty() {
                    emit_stream_chunk(window, request_id, &clean);
                }
                outcome.content = clean;
            }
        }
        Ok(outcome)
    } else {
        let body: Value = await_with_cancel(cancel_rx, response.json())
            .await?
            .map_err(|e| format!("Parse error: {}", e))?;
        let (mut content, reasoning, mut tool_calls, prompt_tokens, completion_tokens) =
            provider::parse_full_response(wire, &body);

        // DSML in non-streaming OpenAI content.
        if dsml_aware && tool_calls.is_empty() && content.contains("DSML") {
            let dsml_calls = parse_dsml_tool_calls(&content);
            if !dsml_calls.is_empty() {
                content = strip_dsml_tags(&content);
                tool_calls = dsml_calls;
            }
        }

        if !reasoning.is_empty() {
            emit_reasoning_chunk(window, request_id, &reasoning);
        }
        // Only emit content immediately when there are no tool calls to run;
        // otherwise the caller runs the search and emits the follow-up answer.
        if tool_calls.is_empty() && !content.is_empty() {
            emit_stream_chunk(window, request_id, &content);
        }

        Ok(StreamOutcome {
            content,
            reasoning,
            tool_calls,
            prompt_tokens,
            completion_tokens,
            ttft_ms: Some(request_start.elapsed().as_millis() as u64),
            dsml_buffering: false,
            dsml_buffer: String::new(),
        })
    }
}

/// Execute web-search tool calls produced by a chat turn, emitting search-status
/// events, and append the assistant + tool-result messages to `messages` so the
/// next turn can answer from the observations. Returns false only if nothing was
/// appended for the model to inspect.
async fn run_chat_search_tools(
    window: &Window,
    request_id: &str,
    config: &AppConfig,
    messages: &mut Vec<Value>,
    assistant_content: &str,
    tool_calls: &[AccumulatedToolCall],
    tool_call_count: &mut u32,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<bool, String> {
    let mut tool_results: Vec<Value> = Vec::new();
    let mut ran_search = false;
    let max_tool_calls = configured_max_tool_calls(config);

    for tc in tool_calls {
        if *tool_call_count >= max_tool_calls {
            let message = format!(
                "Error: Per-request tool call limit reached ({}). Ask the user before continuing.",
                max_tool_calls
            );
            emit_request_event(
                window,
                "agent-tool-blocked",
                request_id,
                json!({
                    "id": tc.id,
                    "name": tc.name,
                    "arguments": tc.arguments,
                    "reason": message,
                }),
            );
            tool_results.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": message,
            }));
            continue;
        }
        *tool_call_count += 1;

        if tc.name != "web_search" {
            tool_results.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": format!("Error: Tool '{}' is not available. Only web_search is supported. Please answer based on the information you already have.", tc.name)
            }));
            continue;
        }
        ran_search = true;
        let query_display = serde_json::from_str::<Value>(&tc.arguments)
            .ok()
            .and_then(|a| a["query"].as_str().map(String::from))
            .unwrap_or_else(|| tc.name.clone());
        emit_request_event(
            window,
            "agent-search-status",
            request_id,
            json!({ "type": "searching", "query": query_display }),
        );
        let search_start = std::time::Instant::now();
        let tool_output = execute_tool_with_control(
            &tc.name,
            &tc.arguments,
            &config.default_work_dir,
            &config.search_provider,
            &config.search_api_key,
            config.command_timeout,
            Some(cancel_rx.clone()),
            None,
        )
        .await;
        if tool_output == TOOL_CANCELLED_ERROR {
            return Err(AGENT_CANCELLED_ERROR.to_string());
        }
        let elapsed = search_start.elapsed().as_secs_f64();
        if tool_output.starts_with("Error:") {
            emit_request_event(
                window,
                "agent-search-status",
                request_id,
                json!({
                    "type": "error",
                    "query": query_display,
                    "message": tool_output.clone(),
                    "duration": elapsed,
                    "provider": config.search_provider,
                }),
            );
        } else {
            let result_count = tool_output
                .lines()
                .filter(|l| l.starts_with("Title:"))
                .count();
            let preview = utf8_prefix(&tool_output, 500);
            let sources = parse_search_sources(&tool_output);
            emit_request_event(
                window,
                "agent-search-status",
                request_id,
                json!({
                    "type": "results",
                    "query": query_display,
                    "results": preview,
                    "duration": elapsed,
                    "resultCount": result_count,
                    "provider": config.search_provider,
                    "sources": sources,
                }),
            );
        }
        tool_results.push(json!({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": tool_output
        }));
    }

    messages.push(assistant_message_with_tool_calls(
        assistant_content,
        tool_calls,
    ));
    let has_observations = !tool_results.is_empty();
    for tr in tool_results {
        messages.push(tr);
    }
    add_search_instruction(messages);
    Ok(ran_search || has_observations)
}

async fn run_chat_mode(
    window: Window,
    request_id: String,
    client: reqwest::Client,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    search_mode: String,
    image_attachments: Vec<ImageAttachment>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    ensure_not_cancelled(&cancel_rx)?;
    // The configured prompt may intentionally describe PowerShell or tools as
    // part of a user-selected role. Never discard it based on its contents.
    let mut chat_system_prompt = resolve_chat_system_prompt(&config.system_prompt);
    let outbound_user_prompt =
        prepend_active_role_prompt(&user_prompt, config.role_prompt.as_deref());
    append_general_assistant_instruction(&mut chat_system_prompt);
    append_thinking_instruction(&mut chat_system_prompt, &config.thinking_level);
    let has_web_search = config.tools_enabled.contains(&"web_search".to_string());
    let wire = provider::Wire::from_config(&config);
    let is_ollama = wire.is_ollama();

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": chat_system_prompt
    })];

    let limit = config.context_limit as usize;
    let limited_messages: Vec<Value> = if session_messages.len() > limit {
        session_messages
            .into_iter()
            .rev()
            .take(limit)
            .rev()
            .collect()
    } else {
        session_messages
    };
    messages.extend(normalize_session_messages(limited_messages, is_ollama));
    messages.push(build_user_message(
        outbound_user_prompt,
        &image_attachments,
        is_ollama,
    ));

    let max_chat_turns = configured_max_agent_loops(&config).min(3);
    let mut tool_call_count: u32 = 0;

    // Force search mode: execute search before sending to model
    if search_mode == "force" && has_web_search && !is_ollama {
        ensure_not_cancelled(&cancel_rx)?;
        let search_query = user_prompt.clone();
        emit_request_event(
            &window,
            "agent-search-status",
            &request_id,
            json!({
                "type": "searching",
                "query": search_query,
            }),
        );
        let search_start = std::time::Instant::now();
        let search_args = json!({"query": search_query}).to_string();
        let tool_output = execute_tool_with_control(
            "web_search",
            &search_args,
            &config.default_work_dir,
            &config.search_provider,
            &config.search_api_key,
            config.command_timeout,
            Some(cancel_rx.clone()),
            None,
        )
        .await;
        if tool_output == TOOL_CANCELLED_ERROR {
            return Err(AGENT_CANCELLED_ERROR.to_string());
        }
        tool_call_count += 1;
        let search_elapsed = search_start.elapsed().as_secs_f64();

        if tool_output.starts_with("Error:") {
            emit_request_event(
                &window,
                "agent-search-status",
                &request_id,
                json!({
                    "type": "error",
                    "query": search_query,
                    "message": &tool_output,
                    "duration": search_elapsed,
                    "provider": config.search_provider,
                }),
            );
            messages.push(json!({
                "role": "system",
                "content": format!("A forced web search for '{}' failed with this tool observation:\n\n{}\n\nDo not invent search results. Answer using the information already available, and clearly say that the forced search failed if it affects the answer.", search_query, tool_output)
            }));
        } else {
            let result_count = tool_output
                .lines()
                .filter(|l| l.starts_with("Title:"))
                .count();
            let preview = utf8_prefix(&tool_output, 500);
            let sources = parse_search_sources(&tool_output);

            emit_request_event(
                &window,
                "agent-search-status",
                &request_id,
                json!({
                    "type": "results",
                    "query": search_query,
                    "results": preview,
                    "duration": search_elapsed,
                    "resultCount": result_count,
                    "provider": config.search_provider,
                    "sources": sources,
                }),
            );

            // Inject search results as context and instruct model to use them
            messages.push(json!({
                "role": "system",
                "content": format!("Web search results for '{}':\n\n{}\n\nIMPORTANT: You MUST base your answer on the search results above. Cite the sources (title and link) when referencing information. If the search results are insufficient to fully answer the question, clearly state what information is missing.", search_query, tool_output)
            }));
        }
    }

    // Build the tool list once. Only web_search is exposed in chat mode, and not
    // in force mode (the search already ran above) nor for Ollama (no tool calls).
    let chat_tools: Vec<Value> = if has_web_search && !is_ollama && search_mode != "force" {
        vec![json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information. Use this when you need up-to-date information that may not be in your training data.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "The search query" }
                    },
                    "required": ["query"]
                }
            }
        })]
    } else {
        Vec::new()
    };

    let request_start = Instant::now();
    let wire = provider::Wire::from_config(&config);

    // Chat mode runs at most a few turns: an initial answer, then up to two
    // search → answer follow-ups when the model requests web_search. Tool calls
    // (native or DSML) are surfaced uniformly via `chat_turn`.
    let mut turn: u32 = 0;

    loop {
        turn += 1;
        ensure_not_cancelled(&cancel_rx)?;

        // Only offer tools on turns that may still search; the final turn answers.
        let tools_for_turn: &[Value] = if turn < max_chat_turns && has_web_search {
            &chat_tools
        } else {
            &[]
        };

        let outcome = chat_turn(
            &window,
            &request_id,
            &client,
            wire,
            &config,
            &messages,
            tools_for_turn,
            request_start,
            &cancel_rx,
        )
        .await?;

        let last_content = outcome.content.clone();

        let runnable = has_web_search
            && !outcome.tool_calls.is_empty()
            && outcome.tool_calls.iter().any(|tc| tc.name == "web_search");

        if !runnable || turn >= max_chat_turns {
            emit_stream_done(
                &window,
                &request_id,
                json!({
                    "content": last_content,
                    "loopCount": turn,
                    "ttftMs": outcome.ttft_ms.unwrap_or(0),
                    "responseTimeMs": request_start.elapsed().as_millis() as u64,
                }),
            );
            emit_agent_complete(&window, &request_id, "success");
            return Ok(());
        }

        // Run the requested search(es) and append assistant + tool results, then
        // loop to let the model answer from them on the next turn.
        let ran = run_chat_search_tools(
            &window,
            &request_id,
            &config,
            &mut messages,
            &outcome.content,
            &outcome.tool_calls,
            &mut tool_call_count,
            &cancel_rx,
        )
        .await?;

        if !ran {
            emit_stream_done(
                &window,
                &request_id,
                json!({
                    "content": last_content,
                    "loopCount": turn,
                    "ttftMs": outcome.ttft_ms.unwrap_or(0),
                    "responseTimeMs": request_start.elapsed().as_millis() as u64,
                }),
            );
            emit_agent_complete(&window, &request_id, "success");
            return Ok(());
        }
    }
}

/// True if an assistant message carries tool_calls (its tool results must
/// immediately follow it, so we can never cut the history between them).
fn message_has_tool_calls(msg: &Value) -> bool {
    msg.get("tool_calls")
        .map(|tc| tc.is_array() && !tc.as_array().map(|a| a.is_empty()).unwrap_or(true))
        .unwrap_or(false)
}

/// When the running conversation grows past the configured message budget,
/// replace the older portion with a real LLM-generated summary (reusing the
/// same provider path as the manual `/compact`). This preserves structured
/// context instead of the char-level truncation that `compact_messages` does,
/// and — unlike the manual command — runs automatically inside the loop.
///
/// Returns Ok(true) if a summary replacement happened. Summarizer failures are
/// non-fatal, but cancellation must propagate immediately.
async fn maybe_auto_compact(
    window: &Window,
    request_id: &str,
    client: &reqwest::Client,
    config: &AppConfig,
    wire: provider::Wire,
    cancel_rx: &watch::Receiver<bool>,
    messages: &mut Vec<Value>,
) -> Result<bool, String> {
    // context_limit is a message-count setting in the UI and in the initial
    // history slicing. Trigger only after the live loop has grown beyond that
    // budget plus the recent tail we always keep intact.
    let keep_tail = 6usize;
    let context_limit = (config.context_limit as usize).max(1);
    let high_water = (1 + context_limit + keep_tail).max(12);
    if messages.len() <= high_water {
        return Ok(false);
    }

    // Keep the system prompt (index 0) and a recent tail intact; summarize the
    // middle. Choose the cut so it lands on a clean boundary: never between an
    // assistant tool_calls message and its tool results.
    if messages.len() <= 1 + keep_tail {
        return Ok(false);
    }
    let mut cut = messages.len() - keep_tail;
    // Walk the boundary backward off any tool result, and off an assistant that
    // has pending tool_calls, so the kept tail starts cleanly.
    while cut > 1 {
        let at = &messages[cut];
        let prev = &messages[cut - 1];
        let starts_on_tool_result = at["role"] == "tool";
        let prev_has_tool_calls = prev["role"] == "assistant" && message_has_tool_calls(prev);
        if starts_on_tool_result || prev_has_tool_calls {
            cut -= 1;
        } else {
            break;
        }
    }
    if cut <= 1 {
        return Ok(false);
    }

    let to_summarize: Vec<Value> = messages[1..cut].to_vec();

    // Build a summary request through the provider-agnostic path.
    let mut summary_config = config.clone();
    summary_config.temperature = 0.3;
    summary_config.max_tokens = Some(1024);

    let mut summary_messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": "You are a conversation summarizer for an agentic coding session. Produce a concise but complete summary that preserves file locations, code changes made, decisions, pending tasks, and user configuration. Output only the summary."
    })];
    summary_messages.extend(to_summarize);
    summary_messages.push(json!({
        "role": "user",
        "content": "Summarize the conversation so far into structured context for continuing the work. Preserve concrete details (paths, function names, what was changed, what remains). No commentary."
    }));

    let url = provider::build_url(wire, &summary_config.base_url, &summary_config.model, false);
    let body = provider::build_body(
        wire,
        &summary_config.model,
        &summary_messages,
        &[],
        &summary_config,
        false,
    );
    let builder = provider::apply_auth(wire, client.post(&url), &summary_config.api_key);

    let response = match await_with_cancel(cancel_rx, builder.json(&body).send()).await? {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(false), // summarizer unavailable — leave history as-is
    };
    let resp_body: Value = match await_with_cancel(cancel_rx, response.json()).await? {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    let (summary, _r, _c, _pt, _ct) = provider::parse_full_response(wire, &resp_body);
    if summary.trim().is_empty() {
        return Ok(false);
    }

    // Replace [1..cut] with a single summary message.
    let summary_msg = json!({
        "role": "user",
        "content": format!(
            "[Auto-compacted earlier conversation summary]\n{}",
            summary.trim()
        )
    });
    let removed = cut - 1;
    messages.splice(1..cut, std::iter::once(summary_msg));

    let _ = window.emit(
        "agent-auto-compacted",
        json!({
            "requestId": request_id,
            "messagesSummarized": removed,
        }),
    );
    Ok(true)
}

async fn start_agent_loop_inner(
    window: Window,
    request_id: String,
    client: reqwest::Client,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    image_attachments: Vec<ImageAttachment>,
    mcp_manager: &mut McpManager,
    mcp_tool_defs: Vec<Value>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    ensure_not_cancelled(&cancel_rx)?;
    let mut system_prompt = config.system_prompt.clone();
    let outbound_user_prompt =
        prepend_active_role_prompt(&user_prompt, config.role_prompt.as_deref());
    let wire = provider::Wire::from_config(&config);
    let is_ollama = wire.is_ollama();

    if let Some((rules, filename)) = load_workspace_rules(&config.default_work_dir) {
        system_prompt.push_str(&format!(
            "\n\n===========================================\n📌 [Workspace Rules (from {})]:\n{}\n===========================================\n",
            filename, rules
        ));
        emit_request_event(
            &window,
            "agent-workspace-rules",
            &request_id,
            json!({
                "file": filename,
                "length": rules.len(),
            }),
        );
    }

    append_general_assistant_instruction(&mut system_prompt);
    append_code_mode_instruction(&mut system_prompt);
    append_shell_guidance(&mut system_prompt);
    append_thinking_instruction(&mut system_prompt, &config.thinking_level);

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": system_prompt
    })];

    let limit = config.context_limit as usize;
    let limited_messages: Vec<Value> = if session_messages.len() > limit {
        session_messages
            .into_iter()
            .rev()
            .take(limit)
            .rev()
            .collect()
    } else {
        session_messages
    };
    messages.extend(normalize_session_messages(limited_messages, is_ollama));
    messages.push(build_user_message(
        outbound_user_prompt,
        &image_attachments,
        is_ollama,
    ));

    let mut loop_count = 0;
    let mut total_prompt_tokens: u64 = 0;
    let mut total_completion_tokens: u64 = 0;
    let max_loops = configured_max_agent_loops(&config);
    let mut tool_call_count: u32 = 0;

    while loop_count < max_loops {
        ensure_not_cancelled(&cancel_rx)?;
        loop_count += 1;

        let steering_msgs = drain_steering_messages(&request_id).await;
        if !steering_msgs.is_empty() {
            let combined = steering_msgs.join("\n");
            let steering_prompt = format!(
                "⚠️ [User Steering (High Priority)]:\n{}\nPlease adjust your next action according to this intervention immediately!",
                combined
            );
            messages.push(json!({
                "role": "user",
                "content": steering_prompt
            }));
            emit_request_event(
                &window,
                "agent-steering-processed",
                &request_id,
                json!({ "content": combined }),
            );
        }

        // When history approaches the context window, summarize the older turns
        // with the model (real LLM summary) so we lose far less than the cheap
        // char-truncation fallback below. Best-effort: on any failure we keep the
        // messages untouched and fall through to compact_messages.
        maybe_auto_compact(
            &window,
            &request_id,
            &client,
            &config,
            wire,
            &cancel_rx,
            &mut messages,
        )
        .await?;

        compact_messages(&mut messages, config.context_limit as usize);

        let request_start = Instant::now();

        // Build the enabled tool set (OpenAI-shaped; provider layer converts).
        let mut enabled_tools = get_enabled_tool_definitions(&config.tools_enabled);
        enabled_tools.extend(mcp_tool_defs.clone());

        // Build request body + URL + auth through the provider adapter so the
        // wire format (OpenAI/Ollama/Anthropic/Gemini) is handled in one place.
        let mut request_body = provider::build_body(
            wire,
            &config.model,
            &messages,
            &enabled_tools,
            &config,
            config.streaming,
        );
        apply_reasoning_effort(&mut request_body, &config, is_ollama);

        let url = provider::build_url(wire, &config.base_url, &config.model, config.streaming);
        let request_builder = provider::apply_auth(wire, client.post(&url), &config.api_key);

        let response = await_with_cancel(&cancel_rx, request_builder.json(&request_body).send())
            .await?
            .map_err(|e| format!("API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, error_text));
        }

        if !config.streaming {
            // Non-streaming mode
            let body: Value = await_with_cancel(&cancel_rx, response.json())
                .await?
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            let response_time_ms = request_start.elapsed().as_millis() as u64;

            let (content, reasoning_content, accumulated, prompt_tokens, completion_tokens) =
                provider::parse_full_response(wire, &body);
            total_prompt_tokens += prompt_tokens;
            total_completion_tokens += completion_tokens;

            emit_usage(
                &window,
                &request_id,
                json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_prompt_tokens": total_prompt_tokens,
                    "total_completion_tokens": total_completion_tokens,
                    "ttft_ms": response_time_ms,
                    "response_time_ms": response_time_ms,
                    "loop_count": loop_count,
                }),
            );

            if !reasoning_content.is_empty() {
                emit_reasoning_chunk(&window, &request_id, &reasoning_content);
            }

            if !content.is_empty() {
                emit_stream_chunk(&window, &request_id, &content);
            }

            if accumulated.is_empty() {
                mcp_manager.shutdown().await;
                emit_agent_complete(&window, &request_id, "success");
                return Ok(());
            }

            // Rebuild the assistant message in our canonical OpenAI shape so the
            // rest of the loop (and the next request) stays provider-agnostic.
            messages.push(assistant_message_with_tool_calls(&content, &accumulated));

            let result = process_tool_calls(
                &window,
                &request_id,
                &accumulated,
                &config,
                &mut messages,
                mcp_manager,
                &mut tool_call_count,
                &cancel_rx,
            )
            .await?;
            if result {
                return Ok(());
            }
            continue;
        }

        // Streaming mode — consume through the provider adapter.
        // DSML is a DeepSeek text-format tool-call convention on the OpenAI
        // wire; enable awareness here so code mode handles those models too
        // (previously only chat mode did, so DSML models silently failed here).
        let dsml_aware = matches!(wire, provider::Wire::OpenAI);
        let outcome = consume_stream(
            &window,
            &request_id,
            wire,
            response,
            request_start,
            &cancel_rx,
            true, // emit agent-tool-drafting events
            dsml_aware,
        )
        .await?;

        let mut accumulated_tool_calls = outcome.tool_calls;
        let mut assistant_content = outcome.content;
        let dsml_buffering = outcome.dsml_buffering;
        let dsml_buffer = outcome.dsml_buffer;

        // If the model emitted DSML text tool calls instead of native ones,
        // parse them out of the buffered content now.
        if accumulated_tool_calls.is_empty() && dsml_buffering {
            let dsml_calls = parse_dsml_tool_calls(&assistant_content);
            assistant_content = strip_dsml_tags(&assistant_content);
            let buffer_clean = strip_dsml_tags(&dsml_buffer);
            if !buffer_clean.trim().is_empty() {
                emit_stream_chunk(&window, &request_id, &buffer_clean);
            }
            if !dsml_calls.is_empty() {
                accumulated_tool_calls = dsml_calls;
            }
        }

        let has_tool_calls = !accumulated_tool_calls.is_empty();

        // Emit usage stats for this streaming turn
        let response_time_ms = request_start.elapsed().as_millis() as u64;
        total_prompt_tokens += outcome.prompt_tokens;
        total_completion_tokens += outcome.completion_tokens;

        emit_usage(
            &window,
            &request_id,
            json!({
                "prompt_tokens": outcome.prompt_tokens,
                "completion_tokens": outcome.completion_tokens,
                "total_prompt_tokens": total_prompt_tokens,
                "total_completion_tokens": total_completion_tokens,
                "ttft_ms": outcome.ttft_ms.unwrap_or(response_time_ms),
                "response_time_ms": response_time_ms,
                "loop_count": loop_count,
            }),
        );

        // No tool calls - conversation complete
        if !has_tool_calls {
            mcp_manager.shutdown().await;
            emit_agent_complete(&window, &request_id, "success");
            return Ok(());
        }

        // Drop any malformed tool calls that never received a name.
        accumulated_tool_calls.retain(|tc| !tc.name.is_empty());
        if accumulated_tool_calls.is_empty() {
            mcp_manager.shutdown().await;
            emit_agent_complete(&window, &request_id, "success");
            return Ok(());
        }

        // Build assistant message for conversation history (canonical OpenAI shape).
        messages.push(assistant_message_with_tool_calls(
            &assistant_content,
            &accumulated_tool_calls,
        ));

        // Process tool calls with approval
        let result = process_tool_calls(
            &window,
            &request_id,
            &accumulated_tool_calls,
            &config,
            &mut messages,
            mcp_manager,
            &mut tool_call_count,
            &cancel_rx,
        )
        .await?;
        if result {
            return Ok(());
        }
    }

    mcp_manager.shutdown().await;
    let budget_message = format!(
        "\n\nAgent loop limit reached ({}). I paused here to avoid runaway tool use. Send a follow-up to continue, or increase the limit in settings.",
        max_loops
    );
    emit_stream_chunk(&window, &request_id, &budget_message);
    emit_stream_done(
        &window,
        &request_id,
        json!({
            "content": budget_message,
            "loopCount": loop_count,
            "ttftMs": 0,
            "responseTimeMs": 0,
        }),
    );
    emit_agent_complete(&window, &request_id, "success");
    Ok(())
}

async fn git_checkpoint(window: &Window, request_id: &str, work_dir: &str) {
    // Parallel mutating tools in one agent turn must all wait for the same
    // pre-run snapshot. Holding this short-lived lock prevents a second tool
    // from starting before the first checkpoint has finished being written.
    let mut checkpointed = CHECKPOINTED_REQUESTS.lock().await;
    if checkpointed.contains(request_id) {
        return;
    }
    match workspace::create_checkpoint_internal(work_dir, Some("before tool execution".into()))
        .await
    {
        Ok(checkpoint) => {
            checkpointed.insert(request_id.to_string());
            emit_request_event(
                window,
                "agent-checkpoint",
                request_id,
                json!({
                    "status": "created",
                    "reference": checkpoint.reference,
                    "commit": checkpoint.commit,
                    "createdAt": checkpoint.created_at,
                    "label": checkpoint.label,
                }),
            );
        }
        Err(error) => emit_request_event(
            window,
            "agent-checkpoint",
            request_id,
            json!({
                "status": "unavailable",
                "error": error,
            }),
        ),
    }
}

async fn execute_tool_with_mcp(
    window: &Window,
    request_id: &str,
    tool_call_id: &str,
    name: &str,
    args_str: &str,
    config: &AppConfig,
    mcp_manager: &mut McpManager,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let read_only_tools = [
        "read_file",
        "list_dir",
        "web_search",
        "grep",
        "glob",
        "todo_write",
    ];
    if !read_only_tools.contains(&name) {
        git_checkpoint(window, request_id, &config.default_work_dir).await;
    }

    let builtin_tools = [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "run_python",
        "web_search",
        "grep",
        "glob",
        "todo_write",
    ];
    if builtin_tools.contains(&name) {
        let (output_tx, mut output_rx) = tokio::sync::mpsc::unbounded_channel::<ExecutionChunk>();
        let execution = execute_tool_with_control(
            name,
            args_str,
            &config.default_work_dir,
            &config.search_provider,
            &config.search_api_key,
            config.command_timeout,
            Some(cancel_rx.clone()),
            Some(output_tx),
        );
        tokio::pin!(execution);

        let output = loop {
            tokio::select! {
                output = &mut execution => break output,
                chunk = output_rx.recv() => {
                    if let Some(chunk) = chunk {
                        emit_request_event(
                            window,
                            "agent-tool-output-chunk",
                            request_id,
                            json!({
                                "id": tool_call_id,
                                "name": name,
                                "stream": chunk.stream,
                                "content": chunk.content,
                            }),
                        );
                    }
                }
            }
        };
        while let Ok(chunk) = output_rx.try_recv() {
            emit_request_event(
                window,
                "agent-tool-output-chunk",
                request_id,
                json!({
                    "id": tool_call_id,
                    "name": name,
                    "stream": chunk.stream,
                    "content": chunk.content,
                }),
            );
        }

        if output == TOOL_CANCELLED_ERROR {
            Err(AGENT_CANCELLED_ERROR.to_string())
        } else {
            Ok(output)
        }
    } else {
        let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        match await_with_cancel(cancel_rx, mcp_manager.route_tool_call(name, args)).await? {
            Ok(output) => Ok(output),
            Err(e) => Ok(format!("MCP tool error: {}", e)),
        }
    }
}

async fn read_mutation_target(
    tool_call: &AccumulatedToolCall,
    config: &AppConfig,
) -> Option<(String, bool, Option<String>)> {
    if !matches!(tool_call.name.as_str(), "write_file" | "edit_file") {
        return None;
    }
    let arguments: Value = serde_json::from_str(&tool_call.arguments).ok()?;
    let path = arguments.get("path")?.as_str()?;
    let resolved = workspace::resolve_within_workspace(path, &config.default_work_dir).ok()?;
    let resolved_path = resolved.to_string_lossy().to_string();
    let exists = resolved.is_file();
    let content = if exists {
        tokio::fs::read_to_string(resolved).await.ok()
    } else {
        None
    };
    Some((resolved_path, exists, content))
}

async fn tool_executing_payload(tool_call: &AccumulatedToolCall, config: &AppConfig) -> Value {
    let mut payload = json!({
        "id": tool_call.id,
        "name": tool_call.name,
        "arguments": tool_call.arguments,
        "displayArguments": sanitize_args_for_log(&tool_call.arguments)
    });
    if let Some((path, exists, content)) = read_mutation_target(tool_call, config).await {
        if let Some(object) = payload.as_object_mut() {
            object.insert("path".to_string(), json!(path));
            object.insert("beforeExists".to_string(), json!(exists));
            object.insert("beforeContent".to_string(), json!(content));
        }
    }
    payload
}

async fn tool_output_payload(
    tool_call: &AccumulatedToolCall,
    config: &AppConfig,
    output: &str,
) -> Value {
    let mut payload = json!({
        "id": tool_call.id,
        "name": tool_call.name,
        "output": output
    });
    if let Some((path, exists, content)) = read_mutation_target(tool_call, config).await {
        if let Some(object) = payload.as_object_mut() {
            object.insert("path".to_string(), json!(path));
            object.insert("afterExists".to_string(), json!(exists));
            object.insert("afterContent".to_string(), json!(content));
        }
    }
    payload
}

/// Process accumulated tool calls with human-in-the-loop approval.
/// Returns Ok(true) if the agent should stop (no more tool calls needed),
/// Ok(false) if the loop should continue.
async fn process_tool_calls(
    window: &Window,
    request_id: &str,
    tool_calls: &[AccumulatedToolCall],
    config: &AppConfig,
    messages: &mut Vec<Value>,
    mcp_manager: &mut McpManager,
    tool_call_count: &mut u32,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<bool, String> {
    ensure_not_cancelled(cancel_rx)?;

    let audit = Arc::new(AuditLogger::new());
    let username = whoami::username();

    let mut needs_confirmation = Vec::new();
    let mut auto_approved = Vec::new();

    let max_tool_calls = configured_max_tool_calls(config);

    // Classify each tool call by approval level, while enforcing a per-request
    // budget. Budget rejections are returned to the model as tool results so it
    // can stop, summarize progress, or ask the user whether to continue.
    for tc in tool_calls {
        if *tool_call_count >= max_tool_calls {
            let reason = format!(
                "Per-request tool call limit reached ({}). Ask the user before continuing.",
                max_tool_calls
            );
            emit_request_event(
                window,
                "agent-tool-blocked",
                request_id,
                json!({
                    "id": tc.id,
                    "name": tc.name,
                    "arguments": tc.arguments,
                    "reason": reason,
                }),
            );
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": format!("Error: {}", reason)
            }));
            continue;
        }
        *tool_call_count += 1;

        let level = check_approval(
            &tc.name,
            &tc.arguments,
            &config.approval_policy,
            &config.trusted_patterns,
        );

        match level {
            ApprovalLevel::AutoApprove => {
                audit
                    .log_command(&tc.name, &tc.arguments, true, &username)
                    .await;
                auto_approved.push(tc.clone());
            }
            ApprovalLevel::NeedsConfirmation => {
                needs_confirmation.push(PendingToolCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: tc.arguments.clone(),
                    approval_level: "needs_confirmation".to_string(),
                });
            }
            ApprovalLevel::Blocked => {
                // Emit blocked event and add error as tool response
                emit_request_event(
                    window,
                    "agent-tool-blocked",
                    request_id,
                    json!({
                        "id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments,
                        "reason": "This command is blocked by security policy."
                    }),
                );
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": "Error: This command was blocked by the security policy. Please try a different approach."
                }));
            }
        }
    }

    // Execute auto-approved tools. Pure read-only builtins (no filesystem
    // mutation, no MCP manager needed) run concurrently — this is the common
    // case when the model fans out reads/greps to explore the codebase. Any
    // other auto-approved tool (trusted writes, MCP calls) runs sequentially
    // through the shared path so MCP routing and pre-write checkpoints stay
    // consistent.
    let is_parallel_read = |name: &str| {
        matches!(
            name,
            "read_file" | "list_dir" | "web_search" | "grep" | "glob"
        )
    };

    // Partition while preserving original order within each group.
    let parallel_reads: Vec<&AccumulatedToolCall> = auto_approved
        .iter()
        .filter(|tc| is_parallel_read(&tc.name))
        .collect();
    let sequential: Vec<&AccumulatedToolCall> = auto_approved
        .iter()
        .filter(|tc| !is_parallel_read(&tc.name))
        .collect();

    // Collect outputs into a map keyed by tool-call id. We run reads
    // concurrently but append the tool results to `messages` in the model's
    // ORIGINAL tool_call order (below), so history ordering is deterministic
    // and stays compatible with Anthropic/Gemini tool-result conversion.
    let mut outputs_by_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    if !parallel_reads.is_empty() {
        for tc in &parallel_reads {
            emit_request_event(
                window,
                "agent-tool-executing",
                request_id,
                json!({
                    "id": tc.id,
                    "name": tc.name,
                    "arguments": tc.arguments,
                    "displayArguments": sanitize_args_for_log(&tc.arguments)
                }),
            );
        }

        // Run all read-only calls concurrently on the blocking-friendly async
        // path. The controlled executor only needs cloned config fields.
        let futures = parallel_reads.iter().map(|tc| {
            let name = tc.name.clone();
            let args = tc.arguments.clone();
            let work_dir = config.default_work_dir.clone();
            let provider = config.search_provider.clone();
            let key = config.search_api_key.clone();
            let timeout = config.command_timeout;
            let cancel_rx = cancel_rx.clone();
            async move {
                execute_tool_with_control(
                    &name,
                    &args,
                    &work_dir,
                    &provider,
                    &key,
                    timeout,
                    Some(cancel_rx),
                    None,
                )
                .await
            }
        });
        let outputs = futures_util::future::join_all(futures).await;

        for (tc, output) in parallel_reads.iter().zip(outputs.into_iter()) {
            if output == TOOL_CANCELLED_ERROR {
                return Err(AGENT_CANCELLED_ERROR.to_string());
            }
            emit_request_event(
                window,
                "agent-tool-output",
                request_id,
                json!({
                    "id": tc.id,
                    "name": tc.name,
                    "output": output
                }),
            );
            outputs_by_id.insert(tc.id.clone(), output);
        }
    }

    for tc in &sequential {
        emit_request_event(
            window,
            "agent-tool-executing",
            request_id,
            tool_executing_payload(tc, config).await,
        );

        let output = execute_tool_with_mcp(
            window,
            request_id,
            &tc.id,
            &tc.name,
            &tc.arguments,
            config,
            &mut *mcp_manager,
            cancel_rx,
        )
        .await?;

        emit_request_event(
            window,
            "agent-tool-output",
            request_id,
            tool_output_payload(tc, config, &output).await,
        );

        outputs_by_id.insert(tc.id.clone(), output);
    }

    // Append all tool results in the model's ORIGINAL tool_call order (not the
    // parallel/sequential execution order), so conversation history is
    // deterministic and compatible across provider wire formats.
    for tc in &auto_approved {
        if let Some(output) = outputs_by_id.remove(&tc.id) {
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": output
            }));
        }
    }

    // If there are tools needing confirmation, emit approval request and wait
    if !needs_confirmation.is_empty() {
        let approval_request_id = uuid::Uuid::new_v4().to_string();
        let request = ToolApprovalRequest {
            request_id: approval_request_id.clone(),
            tool_calls: needs_confirmation,
        };

        let mut approval_payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        if let Some(object) = approval_payload.as_object_mut() {
            object.insert("requestId".to_string(), json!(request_id));
        }
        let _ = window.emit("agent-tool-approval-request", approval_payload);

        // Wait for user response via Tauri state
        // The frontend will invoke "resolve_tool_approval" command
        let approval_result = wait_for_approval(window, &approval_request_id, cancel_rx).await?;

        for (tc_id, approved) in approval_result {
            ensure_not_cancelled(cancel_rx)?;
            if approved {
                // Find the tool call
                if let Some(tc) = tool_calls.iter().find(|t| t.id == tc_id) {
                    audit
                        .log_command(&tc.name, &tc.arguments, true, &username)
                        .await;

                    emit_request_event(
                        window,
                        "agent-tool-executing",
                        request_id,
                        tool_executing_payload(tc, config).await,
                    );

                    let output = execute_tool_with_mcp(
                        window,
                        request_id,
                        &tc.id,
                        &tc.name,
                        &tc.arguments,
                        config,
                        &mut *mcp_manager,
                        cancel_rx,
                    )
                    .await?;

                    emit_request_event(
                        window,
                        "agent-tool-output",
                        request_id,
                        tool_output_payload(tc, config, &output).await,
                    );

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": output
                    }));
                }
            } else {
                // User rejected
                if let Some(tc) = tool_calls.iter().find(|t| t.id == tc_id) {
                    audit
                        .log_command(&tc.name, &tc.arguments, false, &username)
                        .await;
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": "User rejected this tool call. Please try a different approach or ask the user for clarification."
                    }));
                }
            }
        }
    }

    audit.shutdown().await;
    Ok(false)
}

use tokio::sync::watch;

/// Global pending approvals store: request_id -> watch::Sender channel
type ApprovalMap = std::collections::HashMap<String, watch::Sender<Option<Vec<(String, bool)>>>>;

static PENDING_APPROVALS: once_cell::sync::Lazy<Arc<tokio::sync::Mutex<ApprovalMap>>> =
    once_cell::sync::Lazy::new(|| Arc::new(tokio::sync::Mutex::new(ApprovalMap::new())));

/// Wait for frontend to resolve a tool approval request.
/// Includes a 5-minute timeout to prevent orphaned approvals from leaking memory.
async fn wait_for_approval(
    _window: &Window,
    request_id: &str,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<Vec<(String, bool)>, String> {
    const APPROVAL_TIMEOUT_SECS: u64 = 300; // 5 minutes

    let rx = {
        let mut pending = PENDING_APPROVALS.lock().await;
        // Create a watch channel; the sender will be stored, receiver returned
        let (tx, rx) = watch::channel(None::<Vec<(String, bool)>>);
        pending.insert(request_id.to_string(), tx);
        rx
    };

    // Wait for the value to change from None to Some, with timeout
    let mut rx = rx;
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS));
    tokio::pin!(timeout);
    let mut cancel_rx = cancel_rx.clone();

    loop {
        tokio::select! {
            result = rx.changed() => {
                result.map_err(|_| "Approval channel closed unexpectedly".to_string())?;
                let result = rx.borrow().clone();
                if let Some(results) = result {
                    return Ok(results);
                }
            }
            _ = &mut timeout => {
                // Clean up the orphaned entry
                let mut pending = PENDING_APPROVALS.lock().await;
                pending.remove(request_id);
                return Err(format!(
                    "Approval request timed out after {} seconds",
                    APPROVAL_TIMEOUT_SECS
                ));
            }
            _ = wait_for_cancellation(&mut cancel_rx) => {
                let mut pending = PENDING_APPROVALS.lock().await;
                pending.remove(request_id);
                return Err(AGENT_CANCELLED_ERROR.to_string());
            }
        }
    }
}

/// Called by the frontend to resolve a pending approval
pub async fn resolve_approval(
    request_id: &str,
    results: Vec<(String, bool)>,
) -> Result<(), String> {
    let mut pending = PENDING_APPROVALS.lock().await;
    if let Some(tx) = pending.remove(request_id) {
        tx.send(Some(results))
            .map_err(|_| "Failed to send approval result".to_string())?;
        Ok(())
    } else {
        Err(format!(
            "No pending approval found for request: {}",
            request_id
        ))
    }
}

/// Fetch the available model list for the given wire format. Each provider
/// exposes a different models endpoint, auth scheme, and response shape; this
/// normalizes them all into `[{ "id": "<model>" }, ...]`.
pub async fn fetch_models(
    wire: provider::Wire,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let base = base_url.trim_end_matches('/');

    match wire {
        provider::Wire::Gemini => {
            // Gemini: GET /v1beta/models?key=API_KEY -> { models: [{ name: "models/x" }] }
            if api_key.is_empty() {
                return Err("Gemini requires an API key to list models.".to_string());
            }
            let prefix = if base.contains("/v1beta") || base.ends_with("/v1") {
                base.to_string()
            } else {
                format!("{}/v1beta", base)
            };
            let url = format!("{}/models?key={}", prefix, api_key);
            let body = fetch_models_json(client.get(&url)).await?;
            let models = body["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|m| {
                    // Strip the "models/" prefix so the id matches what the user types.
                    let name = m["name"].as_str()?;
                    let id = name.strip_prefix("models/").unwrap_or(name);
                    Some(json!({ "id": id }))
                })
                .collect();
            Ok(models)
        }
        provider::Wire::Anthropic => {
            // Anthropic: GET /v1/models with x-api-key + version -> { data: [{ id }] }
            if api_key.is_empty() {
                return Err("Anthropic requires an API key to list models.".to_string());
            }
            // Don't double up /v1 when the user already typed the versioned URL.
            let url = if base.ends_with("/v1") {
                format!("{}/models", base)
            } else {
                format!("{}/v1/models", base)
            };
            let request = client
                .get(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
            let body = fetch_models_json(request).await?;
            Ok(extract_openai_shaped_models(&body))
        }
        provider::Wire::Ollama => {
            // Ollama has its own command (fetch_ollama_models); shouldn't reach here.
            Err("Use the Ollama model fetch for local models.".to_string())
        }
        provider::Wire::OpenAI => {
            // OpenAI-compatible: GET /models with Bearer -> { data: [{ id }] }
            let url = format!("{}/models", base);
            let mut request = client.get(&url).header("Content-Type", "application/json");
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
            let body = fetch_models_json(request).await?;
            Ok(extract_openai_shaped_models(&body))
        }
    }
}

async fn fetch_models_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Models API error ({}): {}", status, error_text));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))
}

fn extract_openai_shaped_models(body: &Value) -> Vec<Value> {
    body["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["id"].as_str().is_some())
        .collect()
}

fn parse_dsml_tool_calls(content: &str) -> Vec<AccumulatedToolCall> {
    let mut calls = Vec::new();
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let invoke_open = format!("<{}invoke name=\"", dsml_close);
    let invoke_close = format!("</{}invoke>", dsml_close);
    let param_open = format!("<{}parameter name=\"", dsml_close);
    let param_close = format!("</{}parameter>", dsml_close);

    let mut pos = 0;
    while let Some(start) = content[pos..].find(&invoke_open) {
        let abs_start = pos + start;
        let name_start = abs_start + invoke_open.len();
        if let Some(name_end) = content[name_start..].find('"') {
            let name = content[name_start..name_start + name_end].to_string();
            let mut args = serde_json::Map::new();

            let invoke_body_start = name_start + name_end + 1;
            if let Some(invoke_end_offset) = content[invoke_body_start..].find(&invoke_close) {
                let body = &content[invoke_body_start..invoke_body_start + invoke_end_offset];

                let mut param_pos = 0;
                while let Some(p_start) = body[param_pos..].find(&param_open) {
                    let abs_p = param_pos + p_start;
                    let pname_start = abs_p + param_open.len();
                    if let Some(pname_end) = body[pname_start..].find('"') {
                        let pname = body[pname_start..pname_start + pname_end].to_string();
                        let after_name = pname_start + pname_end;
                        if let Some(gt_pos) = body[after_name..].find('>') {
                            let val_start = after_name + gt_pos + 1;
                            if let Some(pc_offset) = body[val_start..].find(&param_close) {
                                let val_end = val_start + pc_offset;
                                if val_end > val_start {
                                    let pval = body[val_start..val_end].to_string();
                                    args.insert(pname, json!(pval));
                                }
                            }
                        }
                        param_pos = pname_start + pname_end + 1;
                    } else {
                        break;
                    }
                }
            }

            calls.push(AccumulatedToolCall {
                id: format!("dsml_{}", calls.len()),
                name,
                arguments: serde_json::Value::Object(args).to_string(),
            });

            pos = name_start + name_end + 1;
        } else {
            break;
        }
    }

    calls
}

fn strip_dsml_tags(content: &str) -> String {
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let mut result = content.to_string();

    // Remove complete DSML tag blocks: <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>
    let tc_open = format!("<{}tool_calls>", dsml_close);
    let tc_close = format!("</{}tool_calls>", dsml_close);
    loop {
        if let Some(start) = result.find(&tc_open) {
            if let Some(end) = result[start..].find(&tc_close) {
                result.replace_range(start..start + end + tc_close.len(), "");
            } else {
                result.replace_range(start.., "");
                break;
            }
        } else {
            break;
        }
    }

    // Remove any remaining DSML fragments
    let fragments = [
        format!("<{}tool_calls>", dsml_close),
        format!("</{}tool_calls>", dsml_close),
        format!("<{}invoke", dsml_close),
        format!("</{}invoke>", dsml_close),
        format!("<{}parameter", dsml_close),
        format!("</{}parameter>", dsml_close),
    ];
    for frag in &fragments {
        result = result.replace(frag, "");
    }

    // Remove lines that are only DSML residue (contain DSML markers but no useful content)
    let cleaned: Vec<&str> = result
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.contains("DSML")
        })
        .collect();
    cleaned.join("\n").trim().to_string()
}

#[cfg(test)]
mod role_prompt_tests {
    use super::*;

    #[test]
    fn chat_system_prompt_preserves_tool_related_role_text() {
        for prompt in [
            "You are a PowerShell specialist.",
            "Explain when to use execute_command.",
            "You can coordinate with local tools when useful.",
        ] {
            assert_eq!(resolve_chat_system_prompt(prompt), prompt);
        }
    }

    #[test]
    fn chat_system_prompt_falls_back_only_when_empty() {
        assert_eq!(resolve_chat_system_prompt(""), DEFAULT_CHAT_SYSTEM_PROMPT);
        assert_eq!(
            resolve_chat_system_prompt("  \n\t"),
            DEFAULT_CHAT_SYSTEM_PROMPT
        );
    }

    #[test]
    fn active_role_is_wrapped_before_the_current_user_request() {
        let wrapped = prepend_active_role_prompt("Who are you?", Some("You are Little Orange."));

        assert!(wrapped.starts_with(ROLE_PRESET_BEGIN_MARKER));
        assert!(wrapped.contains("You are Little Orange."));
        assert!(wrapped.contains(&format!(
            "{USER_REQUEST_BEGIN_MARKER}\nWho are you?\n{USER_REQUEST_END_MARKER}"
        )));
        assert!(wrapped.find(ROLE_PRESET_END_MARKER) < wrapped.find(USER_REQUEST_BEGIN_MARKER));
    }

    #[test]
    fn inactive_or_empty_role_does_not_modify_the_user_request() {
        assert_eq!(prepend_active_role_prompt("hello", None), "hello");
        assert_eq!(prepend_active_role_prompt("hello", Some(" \n ")), "hello");
    }

    #[test]
    fn already_wrapped_request_is_not_wrapped_again() {
        let once = prepend_active_role_prompt("hello", Some("role"));
        let twice = prepend_active_role_prompt(&once, Some("role"));

        assert_eq!(twice, once);
        assert_eq!(twice.matches(ROLE_PRESET_BEGIN_MARKER).count(), 1);
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn registered_request_can_be_cancelled_and_unregistered() {
        let request_id = format!("cancellation-test-{}", uuid::Uuid::new_v4());
        let mut cancel_rx = register_cancellation(&request_id).await;

        cancel_agent_request(&request_id).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            wait_for_cancellation(&mut cancel_rx),
        )
        .await
        .expect("cancellation signal should be observed");

        unregister_cancellation(&request_id).await;
        let error = cancel_agent_request(&request_id).await.unwrap_err();
        assert!(error.contains("No active agent request found"));
    }
}
