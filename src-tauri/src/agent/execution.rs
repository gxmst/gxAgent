use super::prompts::{configured_max_tool_calls, plan_mode_allows_tool, sanitize_args_for_log};
use super::state::{
    await_with_cancel, cancel_registered_approval, cancel_registered_question,
    ensure_not_cancelled, is_agent_cancelled_error, register_approval_wait, register_question_wait,
    wait_for_cancellation, wait_for_registered_approval, wait_for_registered_question,
    wait_for_steering_interrupt, AGENT_CANCELLED_ERROR, AGENT_STEERING_INTERRUPTED_OUTPUT,
    CHECKPOINTED_REQUESTS,
};
use super::stream::{emit_request_event, AccumulatedToolCall};
use crate::audit::AuditLogger;
use crate::config::AppConfig;
use crate::mcp::McpManager;
use crate::policy::{check_approval, ApprovalLevel};
use crate::tools::{execute_tool_with_control, ExecutionChunk, TOOL_CANCELLED_ERROR};
use crate::workspace;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Window};
use tokio::sync::{oneshot, watch};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
    approval_level: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ToolApprovalRequest {
    request_id: String,
    tool_calls: Vec<PendingToolCall>,
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

#[allow(clippy::too_many_arguments)]
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
        "get_current_time",
        "read_file",
        "list_dir",
        "web_search",
        "web_fetch",
        "grep",
        "glob",
        "todo_write",
    ];
    if !read_only_tools.contains(&name) {
        git_checkpoint(window, request_id, &config.default_work_dir).await;
    }

    let builtin_tools = [
        "get_current_time",
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "run_python",
        "web_search",
        "web_fetch",
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
            Err(e) => Ok(format!("Error: MCP tool: {}", e)),
        }
    }
}

/// Spawn a watcher that merges cancellation and steering-interrupt signals into
/// a single stop watch channel while reporting whether steering triggered it.
fn spawn_steering_watcher(
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> (
    watch::Receiver<bool>,
    oneshot::Receiver<bool>,
    tokio::task::JoinHandle<()>,
) {
    let (stop_tx, stop_rx) = watch::channel(false);
    let (reason_tx, reason_rx) = oneshot::channel::<bool>();
    let mut cancel_watch = cancel_rx.clone();
    let mut steering_watch = steering_rx.clone();
    let watcher = tokio::spawn(async move {
        tokio::select! {
            _ = wait_for_cancellation(&mut cancel_watch) => {
                let _ = reason_tx.send(false);
            }
            _ = wait_for_steering_interrupt(&mut steering_watch) => {
                let _ = reason_tx.send(true);
            }
        }
        let _ = stop_tx.send(true);
    });
    (stop_rx, reason_rx, watcher)
}

async fn resolve_steering_output(
    output: Result<String, String>,
    reason_rx: oneshot::Receiver<bool>,
    watcher: tokio::task::JoinHandle<()>,
) -> Result<String, String> {
    match output {
        Err(error) if error == AGENT_CANCELLED_ERROR => {
            let steered = reason_rx.await.unwrap_or(false);
            watcher.abort();
            if steered {
                Ok(AGENT_STEERING_INTERRUPTED_OUTPUT.to_string())
            } else {
                Err(error)
            }
        }
        other => {
            watcher.abort();
            other
        }
    }
}

/// Run a tool with a second, request-scoped stop signal for user steering.
/// The executor still receives a watch receiver, so process-backed commands
/// terminate their child tree instead of being dropped mid-future.
#[allow(clippy::too_many_arguments)]
async fn execute_tool_with_steering(
    window: &Window,
    request_id: &str,
    tool_call_id: &str,
    name: &str,
    args_str: &str,
    config: &AppConfig,
    mcp_manager: &mut McpManager,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let (stop_rx, reason_rx, watcher) = spawn_steering_watcher(cancel_rx, steering_rx);
    let output = execute_tool_with_mcp(
        window,
        request_id,
        tool_call_id,
        name,
        args_str,
        config,
        mcp_manager,
        &stop_rx,
    )
    .await;
    resolve_steering_output(output, reason_rx, watcher).await
}

/// Execute a read-only tool while allowing either the stop button or a
/// steering message to drop the in-flight future immediately. The parallel
/// read set contains no process-backed tools, so dropping the future is enough
/// to release the operation without a separate child-process watcher.
#[allow(clippy::too_many_arguments)]
async fn execute_parallel_read_with_steering(
    name: &str,
    args_str: &str,
    work_dir: &str,
    search_provider: &str,
    search_api_key: &str,
    timeout_secs: u64,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let mut cancel_watch = cancel_rx.clone();
    let mut steering_watch = steering_rx.clone();
    tokio::select! {
        _ = wait_for_cancellation(&mut cancel_watch) => {
            Err(AGENT_CANCELLED_ERROR.to_string())
        }
        _ = wait_for_steering_interrupt(&mut steering_watch) => {
            Ok(AGENT_STEERING_INTERRUPTED_OUTPUT.to_string())
        }
        output = execute_tool_with_control(
            name,
            args_str,
            work_dir,
            search_provider,
            search_api_key,
            timeout_secs,
            None,
            None,
        ) => {
            if output == TOOL_CANCELLED_ERROR {
                Err(AGENT_CANCELLED_ERROR.to_string())
            } else {
                Ok(output)
            }
        }
    }
}

/// Apply the same request-scoped steering interrupt to the multi-turn read-only subagent.
async fn run_spawn_agent_with_steering(
    window: &Window,
    request_id: &str,
    args_str: &str,
    config: &AppConfig,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let (stop_rx, reason_rx, watcher) = spawn_steering_watcher(cancel_rx, steering_rx);
    let output =
        super::subagent::run_spawn_agent(window, request_id, args_str, config, &stop_rx).await;
    resolve_steering_output(output, reason_rx, watcher).await
}

async fn run_ask_user_question_with_steering(
    window: &Window,
    request_id: &str,
    args_str: &str,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let args: Value = serde_json::from_str(args_str)
        .map_err(|_| "ask_user_question requires a JSON object argument.".to_string())?;
    let raw_questions = args["questions"]
        .as_array()
        .filter(|arr| !arr.is_empty())
        .ok_or_else(|| "ask_user_question requires a non-empty questions array.".to_string())?;

    let mut normalized_questions = Vec::new();
    for (idx, item) in raw_questions.iter().take(4).enumerate() {
        let prompt = item["question"].as_str().unwrap_or("").trim();
        if prompt.is_empty() {
            return Err("Each question in ask_user_question must be non-empty.".to_string());
        }
        let id = item["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("q{}", idx + 1));
        let header = item["header"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_string();
        let is_secret = item["is_secret"].as_bool().unwrap_or(false);
        let options = item["options"].as_array().map(|opts| {
            opts.iter()
                .filter_map(|opt| {
                    let label = opt["label"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let description = opt["description"].as_str().unwrap_or("").trim();
                    Some(json!({ "label": label, "description": description }))
                })
                .collect::<Vec<_>>()
        });
        normalized_questions.push(json!({
            "id": id,
            "header": header,
            "question": prompt,
            "isSecret": is_secret,
            "options": options,
        }));
    }

    let interaction_id = format!("ask-{}", uuid::Uuid::new_v4());
    let rx = register_question_wait(&interaction_id).await;
    emit_request_event(
        window,
        "agent-question",
        request_id,
        json!({
            "question": {
                "source": "native",
                "interactionId": interaction_id,
                "questions": normalized_questions,
            }
        }),
    );

    let mut wait_future = Box::pin(wait_for_registered_question(&interaction_id, rx, cancel_rx));
    let mut steering_watch = steering_rx.clone();
    let result = tokio::select! {
        res = &mut wait_future => res,
        _ = wait_for_steering_interrupt(&mut steering_watch) => {
            cancel_registered_question(&interaction_id).await;
            Ok(HashMap::from([("__interrupted".to_string(), vec![AGENT_STEERING_INTERRUPTED_OUTPUT.to_string()])]))
        }
    };

    emit_request_event(
        window,
        "agent-question",
        request_id,
        json!({ "question": Value::Null }),
    );

    match result {
        Ok(map) if map.contains_key("__interrupted") => {
            Ok(AGENT_STEERING_INTERRUPTED_OUTPUT.to_string())
        }
        Ok(answers) => {
            Ok(serde_json::to_string_pretty(&json!({ "answers": answers })).unwrap_or_default())
        }
        Err(error) => {
            cancel_registered_question(&interaction_id).await;
            Err(error)
        }
    }
}

fn run_read_skill(config: &AppConfig, args_str: &str) -> String {
    let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    let skill = args["skill"].as_str().unwrap_or("");
    let resource = args["resource"].as_str();
    match crate::skills::read_skill_entry(config, skill, resource) {
        Ok(text) => text,
        Err(error) => format!("Error: {}", error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_sequential_tool(
    window: &Window,
    request_id: &str,
    tc: &AccumulatedToolCall,
    config: &AppConfig,
    mcp_manager: &mut McpManager,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    if let crate::hooks::PreHookDecision::Block(reason) = crate::hooks::run_pre_tool_hooks(
        window,
        request_id,
        &config.default_work_dir,
        &tc.name,
        &tc.arguments,
    )
    .await
    {
        return Ok(format!("Error: {}", reason));
    }

    let mut result = if tc.name == "spawn_agent" {
        match run_spawn_agent_with_steering(
            window,
            request_id,
            &tc.arguments,
            config,
            cancel_rx,
            steering_rx,
        )
        .await
        {
            Ok(output) => Ok(output),
            Err(error) if is_agent_cancelled_error(&error) => Err(error),
            Err(error) => Ok(format!("Error: {}", error)),
        }
    } else if tc.name == "ask_user_question" {
        match run_ask_user_question_with_steering(
            window,
            request_id,
            &tc.arguments,
            cancel_rx,
            steering_rx,
        )
        .await
        {
            Ok(output) => Ok(output),
            Err(error) if is_agent_cancelled_error(&error) => Err(error),
            Err(error) => Ok(format!("Error: {}", error)),
        }
    } else if tc.name == "read_skill" {
        Ok(run_read_skill(config, &tc.arguments))
    } else {
        execute_tool_with_steering(
            window,
            request_id,
            &tc.id,
            &tc.name,
            &tc.arguments,
            config,
            mcp_manager,
            cancel_rx,
            steering_rx,
        )
        .await
    };

    if let Ok(ref mut output) = result {
        if output != AGENT_STEERING_INTERRUPTED_OUTPUT {
            if let Some(note) = crate::hooks::run_post_tool_hooks(
                window,
                request_id,
                &config.default_work_dir,
                &tc.name,
                &tc.arguments,
                output,
            )
            .await
            {
                output.push('\n');
                output.push_str(&note);
            }
        }
    }

    result
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

pub(super) async fn tool_executing_payload(
    tool_call: &AccumulatedToolCall,
    config: &AppConfig,
) -> Value {
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

async fn cancel_approval_request(window: &Window, request_id: &str, approval_request_id: &str) {
    cancel_registered_approval(approval_request_id).await;
    emit_request_event(
        window,
        "agent-tool-approval-cancelled",
        request_id,
        json!({ "approvalRequestId": approval_request_id }),
    );
}

fn tool_call_problem(
    call: &AccumulatedToolCall,
    config: &AppConfig,
    mcp: &McpManager,
) -> Option<&'static str> {
    if !serde_json::from_str::<Value>(&call.arguments).is_ok_and(|args| args.is_object()) {
        return Some("Invalid tool arguments: expected a JSON object");
    }
    if !config.tools_enabled.contains(&call.name) && !mcp.has_tool(&call.name) {
        return Some("Tool is disabled or unavailable");
    }
    None
}

/// Process accumulated tool calls with human-in-the-loop approval.
/// Returns Ok(true) if the agent should stop (no more tool calls needed),
/// Ok(false) if the loop should continue.
#[allow(clippy::too_many_arguments)]
pub(super) async fn process_tool_calls(
    window: &Window,
    request_id: &str,
    tool_calls: &[AccumulatedToolCall],
    config: &AppConfig,
    messages: &mut Vec<Value>,
    mcp_manager: &mut McpManager,
    tool_call_count: &mut u32,
    cancel_rx: &watch::Receiver<bool>,
    steering_rx: &watch::Receiver<bool>,
) -> Result<bool, String> {
    ensure_not_cancelled(cancel_rx)?;

    let audit = Arc::new(AuditLogger::new());
    let username = whoami::username();

    let mut needs_confirmation = Vec::new();
    let mut pending_tool_ids = Vec::new();
    let mut auto_approved = Vec::new();

    let max_tool_calls = configured_max_tool_calls(config);

    // Classify each tool call by approval level, while enforcing a per-request
    // budget. Budget rejections are returned to the model as tool results so it
    // can stop, summarize progress, or ask the user whether to continue.
    for tc in tool_calls {
        if let Some(reason) = tool_call_problem(tc, config, mcp_manager) {
            emit_request_event(
                window,
                "agent-tool-blocked",
                request_id,
                json!({"id":tc.id,"name":tc.name,"arguments":tc.arguments,"reason":reason}),
            );
            messages.push(
                json!({"role":"tool","tool_call_id":tc.id,"content":format!("Error: {reason}")}),
            );
            continue;
        }
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

        let level = if config.plan_mode && !plan_mode_allows_tool(&tc.name) {
            ApprovalLevel::Blocked
        } else {
            check_approval(
                &tc.name,
                &tc.arguments,
                &config.approval_policy,
                &config.trusted_patterns,
                &config.default_work_dir,
            )
        };

        match level {
            ApprovalLevel::AutoApprove => {
                audit
                    .log_command(&tc.name, &tc.arguments, true, &username)
                    .await;
                auto_approved.push(tc.clone());
            }
            ApprovalLevel::NeedsConfirmation => {
                pending_tool_ids.push(tc.id.clone());
                needs_confirmation.push(PendingToolCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: tc.arguments.clone(),
                    approval_level: "needs_confirmation".to_string(),
                });
            }
            ApprovalLevel::Blocked => {
                // Emit blocked event and add error as tool response.
                let reason = if config.plan_mode && !plan_mode_allows_tool(&tc.name) {
                    "Plan mode is read-only. Turn it off before using this tool."
                } else {
                    "This command is blocked by security policy."
                };
                emit_request_event(
                    window,
                    "agent-tool-blocked",
                    request_id,
                    json!({
                        "id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments,
                        "reason": reason
                    }),
                );
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": format!("Error: {} Please continue with a read-only plan.", reason)
                }));
            }
        }
    }

    // Register and show approval before running automatic tools. This lets
    // read-only calls continue while the user decides about a command/write.
    let pending_approval = if !needs_confirmation.is_empty() {
        let approval_request_id = uuid::Uuid::new_v4().to_string();
        let request = ToolApprovalRequest {
            request_id: approval_request_id.clone(),
            tool_calls: needs_confirmation,
        };
        let mut approval_payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        if let Some(object) = approval_payload.as_object_mut() {
            object.insert("requestId".to_string(), json!(request_id));
        }
        let approval_rx = register_approval_wait(&approval_request_id).await;
        if let Err(error) = window.emit("agent-tool-approval-request", approval_payload) {
            cancel_registered_approval(&approval_request_id).await;
            return Err(format!("Failed to show approval request: {}", error));
        }
        Some((approval_request_id, approval_rx))
    } else {
        None
    };

    // Execute auto-approved tools. Pure read-only builtins (no filesystem
    // mutation, no MCP manager needed) run concurrently — this is the common
    // case when the model fans out reads/greps to explore the codebase. Any
    // other auto-approved tool (trusted writes, MCP calls) runs sequentially
    // through the shared path so MCP routing and pre-write checkpoints stay
    // consistent.
    let is_parallel_read = |name: &str| {
        matches!(
            name,
            "get_current_time"
                | "read_file"
                | "list_dir"
                | "web_search"
                | "web_fetch"
                | "grep"
                | "glob"
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
    let mut outputs_by_id: HashMap<String, String> = HashMap::new();
    let mut steering_interrupted = *steering_rx.borrow();

    if !parallel_reads.is_empty() && !steering_interrupted {
        let has_hooks = crate::hooks::load_project_hooks(&config.default_work_dir)
            .ok()
            .flatten()
            .is_some();
        let mut allowed_reads = Vec::new();
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
            if has_hooks {
                if let crate::hooks::PreHookDecision::Block(reason) =
                    crate::hooks::run_pre_tool_hooks(
                        window,
                        request_id,
                        &config.default_work_dir,
                        &tc.name,
                        &tc.arguments,
                    )
                    .await
                {
                    let err_output = format!("Error: {}", reason);
                    emit_request_event(
                        window,
                        "agent-tool-output",
                        request_id,
                        json!({ "id": tc.id, "name": tc.name, "output": err_output }),
                    );
                    outputs_by_id.insert(tc.id.clone(), err_output);
                    continue;
                }
            }
            allowed_reads.push(*tc);
        }

        // Run all read-only calls concurrently on the blocking-friendly async
        // path. The controlled executor only needs cloned config fields.
        let futures = allowed_reads.iter().map(|tc| {
            let name = tc.name.clone();
            let args = tc.arguments.clone();
            let work_dir = config.default_work_dir.clone();
            let provider = config.search_provider.clone();
            let key = config.search_api_key.clone();
            let timeout = config.command_timeout;
            let cancel_rx = cancel_rx.clone();
            let steering_rx = steering_rx.clone();
            async move {
                execute_parallel_read_with_steering(
                    &name,
                    &args,
                    &work_dir,
                    &provider,
                    &key,
                    timeout,
                    &cancel_rx,
                    &steering_rx,
                )
                .await
            }
        });
        let outputs = futures_util::future::join_all(futures).await;

        for (tc, output) in allowed_reads.iter().zip(outputs) {
            let mut output = match output {
                Ok(output) => output,
                Err(error) => {
                    if let Some((approval_request_id, _)) = pending_approval.as_ref() {
                        cancel_approval_request(window, request_id, approval_request_id).await;
                    }
                    return Err(error);
                }
            };
            if has_hooks && output != AGENT_STEERING_INTERRUPTED_OUTPUT {
                if let Some(note) = crate::hooks::run_post_tool_hooks(
                    window,
                    request_id,
                    &config.default_work_dir,
                    &tc.name,
                    &tc.arguments,
                    &output,
                )
                .await
                {
                    output.push('\n');
                    output.push_str(&note);
                }
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
        steering_interrupted = *steering_rx.borrow();
    }

    if !steering_interrupted {
        for tc in &sequential {
            emit_request_event(
                window,
                "agent-tool-executing",
                request_id,
                tool_executing_payload(tc, config).await,
            );

            let output = run_sequential_tool(
                window,
                request_id,
                tc,
                config,
                &mut *mcp_manager,
                cancel_rx,
                steering_rx,
            )
            .await;
            let output = match output {
                Ok(output) => output,
                Err(error) => {
                    if let Some((approval_request_id, _)) = pending_approval.as_ref() {
                        cancel_approval_request(window, request_id, approval_request_id).await;
                    }
                    return Err(error);
                }
            };

            emit_request_event(
                window,
                "agent-tool-output",
                request_id,
                tool_output_payload(tc, config, &output).await,
            );

            outputs_by_id.insert(tc.id.clone(), output);
            if outputs_by_id.get(&tc.id).map(String::as_str)
                == Some(AGENT_STEERING_INTERRUPTED_OUTPUT)
            {
                steering_interrupted = true;
                break;
            }
        }
    }

    if steering_interrupted {
        for tc in &auto_approved {
            if outputs_by_id.contains_key(&tc.id) {
                continue;
            }
            let output = AGENT_STEERING_INTERRUPTED_OUTPUT.to_string();
            emit_request_event(
                window,
                "agent-tool-output",
                request_id,
                json!({ "id": tc.id, "name": tc.name, "output": output }),
            );
            outputs_by_id.insert(tc.id.clone(), output);
        }
        for tc_id in &pending_tool_ids {
            let output = AGENT_STEERING_INTERRUPTED_OUTPUT.to_string();
            let name = tool_calls
                .iter()
                .find(|tool_call| &tool_call.id == tc_id)
                .map(|tool_call| tool_call.name.as_str())
                .unwrap_or("tool");
            emit_request_event(
                window,
                "agent-tool-output",
                request_id,
                json!({ "id": tc_id, "name": name, "output": output }),
            );
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": output
            }));
        }
        if let Some((approval_request_id, _)) = pending_approval.as_ref() {
            cancel_approval_request(window, request_id, approval_request_id).await;
        }
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

    if steering_interrupted {
        audit.shutdown().await;
        return Ok(false);
    }

    // Wait for the approval response after automatic tools have finished.
    if let Some((approval_request_id, approval_rx)) = pending_approval {
        let mut approval_wait = Box::pin(wait_for_registered_approval(
            &approval_request_id,
            approval_rx,
            cancel_rx,
        ));
        let mut steering_watch = steering_rx.clone();
        let approval_result = tokio::select! {
            result = &mut approval_wait => result,
            _ = wait_for_steering_interrupt(&mut steering_watch) => {
                cancel_approval_request(window, request_id, &approval_request_id).await;
                for tc_id in &pending_tool_ids {
                    let output = AGENT_STEERING_INTERRUPTED_OUTPUT.to_string();
                    let name = tool_calls
                        .iter()
                        .find(|tool_call| &tool_call.id == tc_id)
                        .map(|tool_call| tool_call.name.as_str())
                        .unwrap_or("tool");
                    emit_request_event(
                        window,
                        "agent-tool-output",
                        request_id,
                        json!({ "id": tc_id, "name": name, "output": output }),
                    );
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": output
                    }));
                }
                audit.shutdown().await;
                return Ok(false);
            }
        };
        let approval_result = match approval_result {
            Ok(result) => result,
            Err(error) => {
                cancel_approval_request(window, request_id, &approval_request_id).await;
                return Err(error);
            }
        };

        let mut approval_steering_interrupted = false;
        for (tc_id, approved) in approval_result {
            ensure_not_cancelled(cancel_rx)?;
            if approval_steering_interrupted {
                if approved {
                    let output = AGENT_STEERING_INTERRUPTED_OUTPUT.to_string();
                    let name = tool_calls
                        .iter()
                        .find(|tool_call| tool_call.id == tc_id)
                        .map(|tool_call| tool_call.name.as_str())
                        .unwrap_or("tool");
                    emit_request_event(
                        window,
                        "agent-tool-output",
                        request_id,
                        json!({ "id": tc_id, "name": name, "output": output }),
                    );
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": output
                    }));
                } else {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": "User rejected this tool call. Please try a different approach or ask the user for clarification."
                    }));
                }
                continue;
            }
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

                    let output = run_sequential_tool(
                        window,
                        request_id,
                        tc,
                        config,
                        &mut *mcp_manager,
                        cancel_rx,
                        steering_rx,
                    )
                    .await?;

                    let was_steering_interrupted = output == AGENT_STEERING_INTERRUPTED_OUTPUT;
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
                    if was_steering_interrupted {
                        approval_steering_interrupted = true;
                    }
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
        if approval_steering_interrupted {
            audit.shutdown().await;
            return Ok(false);
        }
    }

    audit.shutdown().await;
    Ok(false)
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use crate::agent::stream::{assistant_message_with_tool_calls, normalize_tool_calls};

    #[test]
    fn malformed_tool_calls_are_safe_for_execution_and_followup_serialization() {
        let mut calls = vec![
            AccumulatedToolCall {
                id: "duplicate".into(),
                name: " web_search ".into(),
                arguments: "{\"query\":".into(),
            },
            AccumulatedToolCall {
                id: "duplicate".into(),
                name: "get_current_time".into(),
                arguments: "null".into(),
            },
            AccumulatedToolCall {
                id: "ignored".into(),
                name: "  ".into(),
                arguments: "{}".into(),
            },
        ];

        normalize_tool_calls(&mut calls);

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "web_search");
        assert_eq!(calls[0].arguments, "{\"query\":");
        assert_eq!(calls[0].id, "duplicate");
        assert_ne!(calls[1].id, "duplicate");
        assert_eq!(calls[1].arguments, "null");
        let mut config = AppConfig::default();
        let mcp = McpManager::new();
        assert_eq!(
            tool_call_problem(&calls[0], &config, &mcp),
            Some("Invalid tool arguments: expected a JSON object")
        );
        let valid = AccumulatedToolCall {
            id: "valid".into(),
            name: "write_file".into(),
            arguments: "{}".into(),
        };
        config.tools_enabled.retain(|name| name != "write_file");
        assert_eq!(
            tool_call_problem(&valid, &config, &mcp),
            Some("Tool is disabled or unavailable")
        );
        assert_eq!(
            tool_call_problem(
                &AccumulatedToolCall {
                    name: "unknown".into(),
                    ..valid
                },
                &config,
                &mcp
            ),
            Some("Tool is disabled or unavailable")
        );

        let history = assistant_message_with_tool_calls("", &calls);
        for call in history["tool_calls"].as_array().unwrap() {
            let arguments = call["function"]["arguments"].as_str().unwrap();
            assert!(serde_json::from_str::<Value>(arguments)
                .unwrap()
                .is_object());
        }
    }
}
