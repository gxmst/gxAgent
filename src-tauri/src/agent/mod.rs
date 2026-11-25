mod chat;
mod context_budget;
mod dsml;
mod execution;
mod models;
mod prompts;
mod state;
mod stream;

use chat::run_chat_mode;
use context_budget::{
    build_user_message, compact_messages, limit_messages_by_tokens, maybe_auto_compact,
    normalize_session_messages,
};
use dsml::{parse_dsml_tool_calls, strip_dsml_tags};
use execution::process_tool_calls;
use prompts::{
    append_code_mode_instruction, append_general_assistant_instruction,
    append_plan_mode_instruction, append_shell_guidance, append_thinking_instruction,
    apply_reasoning_effort, configured_max_agent_loops, load_workspace_rules,
    prepend_active_role_prompt,
};
use state::{
    await_with_cancel, clear_steering_interrupt, clear_steering_messages, drain_steering_messages,
    ensure_not_cancelled, is_agent_cancelled_error, register_steering_interrupt,
};
use stream::{
    assistant_message_with_tool_calls, consume_stream, emit_agent_complete, emit_reasoning_chunk,
    emit_request_event, emit_stream_chunk, emit_stream_done, emit_usage, normalize_tool_calls,
    send_model_request_with_retry,
};

use crate::config::AppConfig;
use crate::mcp::McpManager;
use crate::provider;
use crate::tools::get_enabled_tool_definitions;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Window;
use tokio::sync::watch;

pub use context_budget::ImageAttachment;
pub use models::fetch_models;
pub use state::{cancel_agent_request, push_steering_message, resolve_approval};
pub(crate) use state::{register_cancellation, unregister_cancellation, wait_for_cancellation};
pub(crate) use stream::new_tool_call_id;
pub use stream::AccumulatedToolCall;

/// Core agent loop with streaming and human-in-the-loop approval
#[allow(clippy::too_many_arguments)]
pub async fn start_agent_loop(
    window: Window,
    request_id: String,
    mut user_prompt: String,
    mut config: AppConfig,
    session_messages: Vec<Value>,
    session_mode: String,
    search_mode: String,
    image_attachments: Vec<ImageAttachment>,
    retrieval_query: String,
) -> Result<(), String> {
    // No total-request timeout: reqwest's `timeout` covers the entire body,
    // which would cut off long streaming (SSE) responses mid-flight. Instead,
    // bound connection setup and per-read stalls; an actively streaming
    // response can run as long as it keeps producing data.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let cancel_rx = register_cancellation(&request_id).await;
    let steering_rx = register_steering_interrupt(&request_id).await;

    let result = async {
        await_with_cancel(
            &cancel_rx,
            crate::context::enrich(
                &window,
                &request_id,
                &retrieval_query,
                &mut user_prompt,
                &mut config,
            ),
        )
        .await??;
        if session_mode == "chat" {
            run_chat_mode(
                window.clone(),
                request_id.clone(),
                client,
                user_prompt,
                retrieval_query,
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
                let report =
                    await_with_cancel(&cancel_rx, mcp_manager.start_all(&config.mcp_servers))
                        .await?;
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
                steering_rx.clone(),
            )
            .await;
            mcp_manager.shutdown().await;
            result
        }
    }
    .await;

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

#[allow(clippy::too_many_arguments)]
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
    steering_rx: watch::Receiver<bool>,
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
    if config.plan_mode {
        append_plan_mode_instruction(&mut system_prompt);
    }
    append_shell_guidance(&mut system_prompt);
    append_thinking_instruction(&mut system_prompt, &config.thinking_level);

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": system_prompt
    })];

    let limited_messages = limit_messages_by_tokens(session_messages, config.context_limit as u64);
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
        clear_steering_interrupt(&request_id).await;
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
        crate::context::emit_snapshot(
            &window,
            &request_id,
            "native",
            loop_count,
            &messages,
            &enabled_tools,
        );

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

        let response = send_model_request_with_retry(
            &window,
            &request_id,
            &cancel_rx,
            request_builder.json(&request_body),
        )
        .await?;

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

            let (content, reasoning_content, mut accumulated, prompt_tokens, completion_tokens) =
                provider::parse_full_response(wire, &body);
            normalize_tool_calls(&mut accumulated);
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
                &steering_rx,
            )
            .await?;
            if result {
                return Ok(());
            }
            continue;
        }

        // Streaming mode — consume through the provider adapter.
        // DSML is a DeepSeek text-format tool-call convention on the OpenAI
        // wire; enable awareness here so code mode handles those models too.
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

        normalize_tool_calls(&mut accumulated_tool_calls);
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
            &steering_rx,
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
