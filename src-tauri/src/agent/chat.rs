use super::context_budget::{
    build_user_message, limit_messages_by_tokens, normalize_session_messages, ImageAttachment,
};
use super::dsml::{parse_dsml_tool_calls, strip_dsml_tags};
use super::execution::tool_executing_payload;
use super::prompts::{
    append_general_assistant_instruction, append_thinking_instruction,
    append_to_latest_user_message, configured_max_agent_loops, configured_max_tool_calls,
    parse_search_sources, prepend_active_role_prompt, resolve_chat_system_prompt,
    search_tool_observation, CHAT_MODE_INSTRUCTION, CHAT_READ_ONLY_TOOLS,
    SEARCH_FOLLOWUP_INSTRUCTION,
};
use super::state::{ensure_not_cancelled, AGENT_CANCELLED_ERROR};
use super::stream::{
    assistant_message_with_tool_calls, consume_stream, emit_agent_complete, emit_reasoning_chunk,
    emit_request_event, emit_stream_chunk, emit_stream_done, emit_usage, normalize_tool_calls,
    send_model_request_with_retry, AccumulatedToolCall, StreamOutcome,
};
use crate::config::AppConfig;
use crate::provider;
use crate::text::utf8_prefix;
use crate::tools::{execute_tool_with_control, get_enabled_tool_definitions, TOOL_CANCELLED_ERROR};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Window;
use tokio::sync::watch;

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
    let response =
        send_model_request_with_retry(window, request_id, cancel_rx, builder.json(&body)).await?;

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
        normalize_tool_calls(&mut outcome.tool_calls);
        Ok(outcome)
    } else {
        let body: Value = super::state::await_with_cancel(cancel_rx, response.json())
            .await?
            .map_err(|e| format!("Parse error: {}", e))?;
        let (mut content, reasoning, mut tool_calls, prompt_tokens, completion_tokens) =
            provider::parse_full_response(wire, &body);
        let (cached_tokens, cache_creation_tokens) = provider::parse_cache_usage(wire, &body);

        // DSML in non-streaming OpenAI content.
        if dsml_aware && tool_calls.is_empty() && content.contains("DSML") {
            let dsml_calls = parse_dsml_tool_calls(&content);
            if !dsml_calls.is_empty() {
                content = strip_dsml_tags(&content);
                tool_calls = dsml_calls;
            }
        }
        normalize_tool_calls(&mut tool_calls);

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
            cached_tokens,
            cache_creation_tokens,
            ttft_ms: Some(request_start.elapsed().as_millis() as u64),
            dsml_buffering: false,
            dsml_buffer: String::new(),
        })
    }
}

/// Execute the small read-only tool set available in ordinary chat, emitting
/// the same action events as code mode so calls remain visible in the message
/// timeline. Search calls additionally emit structured search-status events.
/// Results are appended to `messages` so the next turn can answer from them.
#[allow(clippy::too_many_arguments)]
async fn run_chat_tools(
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

        if !CHAT_READ_ONLY_TOOLS.contains(&tc.name.as_str())
            || !config.tools_enabled.contains(&tc.name)
        {
            let reason = format!(
                "Tool '{}' is not available in ordinary chat. Switch to code mode for commands or file changes.",
                tc.name
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
            tool_results.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": format!("Error: {}", reason)
            }));
            continue;
        }
        let is_search = tc.name == "web_search";
        if is_search {
            ran_search = true;
        }
        let query_display = serde_json::from_str::<Value>(&tc.arguments)
            .ok()
            .and_then(|a| a["query"].as_str().map(String::from))
            .unwrap_or_else(|| tc.name.clone());
        emit_request_event(
            window,
            "agent-tool-executing",
            request_id,
            tool_executing_payload(tc, config).await,
        );
        if is_search {
            emit_request_event(
                window,
                "agent-search-status",
                request_id,
                json!({ "type": "searching", "query": query_display }),
            );
        }
        let search_start = Instant::now();
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
        emit_request_event(
            window,
            "agent-tool-output",
            request_id,
            json!({ "id": tc.id, "name": tc.name, "output": tool_output.clone() }),
        );
        if is_search {
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
        }
        let observation = if is_search {
            search_tool_observation(&tool_output)
        } else {
            tool_output
        };
        tool_results.push(json!({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": observation
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
    Ok(ran_search || has_observations)
}

// External search receives only explicit query text, never enriched model input.
fn forced_search_query<'a>(
    mode: &str,
    enabled: bool,
    is_ollama: bool,
    query: &'a str,
) -> Option<&'a str> {
    let query = query.trim();
    (mode == "force" && enabled && !is_ollama && !query.is_empty()).then_some(query)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_chat_mode(
    window: Window,
    request_id: String,
    client: reqwest::Client,
    user_prompt: String,
    search_query: String,
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
    chat_system_prompt.push_str("\n\n");
    chat_system_prompt.push_str(CHAT_MODE_INSTRUCTION);
    let has_web_search = config.tools_enabled.contains(&"web_search".to_string());
    let wire = provider::Wire::from_config(&config);
    let is_ollama = wire.is_ollama();

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": chat_system_prompt
    })];

    let limited_messages = limit_messages_by_tokens(session_messages, config.context_limit as u64);
    messages.extend(normalize_session_messages(limited_messages, is_ollama));
    messages.push(build_user_message(
        outbound_user_prompt,
        &image_attachments,
        is_ollama,
    ));

    let max_chat_turns = configured_max_agent_loops(&config).min(3);
    let mut tool_call_count: u32 = 0;

    // Force search mode: execute search before sending to model
    if let Some(search_query) =
        forced_search_query(&search_mode, has_web_search, is_ollama, &search_query)
    {
        ensure_not_cancelled(&cancel_rx)?;
        emit_request_event(
            &window,
            "agent-search-status",
            &request_id,
            json!({
                "type": "searching",
                "query": search_query,
            }),
        );
        let search_start = Instant::now();
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
            let context = format!("A forced web search for '{}' failed with this tool observation:\n\n{}\n\nDo not invent search results. Answer using the information already available, and clearly say that the forced search failed if it affects the answer.", search_query, tool_output);
            append_to_latest_user_message(&mut messages, &context);
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

            // Inject generated context into the current user turn. Keeping the
            // original leading system message as the only system-role message
            // is accepted by strict OpenAI-compatible relays.
            let context = format!(
                "Web search results for '{}':\n\n{}\n\n{}",
                search_query, tool_output, SEARCH_FOLLOWUP_INSTRUCTION
            );
            append_to_latest_user_message(&mut messages, &context);
        }
    }

    // Build the ordinary-chat tool list from the global toggles, but keep the
    // write/execute tools out of this mode even when they are enabled for Code.
    // Force-search already performed web_search above, so omit that one tool for
    // follow-up turns while still allowing a clock or read-only workspace call.
    let chat_tools: Vec<Value> = if !is_ollama {
        get_enabled_tool_definitions(&config.tools_enabled)
            .into_iter()
            .filter(|tool| {
                let name = tool["function"]["name"].as_str().unwrap_or("");
                CHAT_READ_ONLY_TOOLS.contains(&name)
                    && (search_mode != "force" || name != "web_search")
            })
            .collect()
    } else {
        Vec::new()
    };

    let request_start = Instant::now();
    let wire = provider::Wire::from_config(&config);

    // Chat mode runs at most a few turns: an initial answer, then up to two
    // search -> answer follow-ups when the model requests web_search. Tool calls
    // (native or DSML) are surfaced uniformly via `chat_turn`.
    let mut turn: u32 = 0;
    let mut total_prompt_tokens: u64 = 0;
    let mut total_completion_tokens: u64 = 0;
    let mut total_cached_tokens: u64 = 0;
    let mut total_cache_creation_tokens: u64 = 0;

    loop {
        turn += 1;
        ensure_not_cancelled(&cancel_rx)?;

        // Only offer tools on turns that may still search; the final turn answers.
        let tools_for_turn: &[Value] = if turn < max_chat_turns && !chat_tools.is_empty() {
            &chat_tools
        } else {
            &[]
        };

        crate::context::emit_snapshot(
            &window,
            &request_id,
            "native",
            turn,
            &messages,
            tools_for_turn,
        );
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

        total_prompt_tokens += outcome.prompt_tokens;
        total_completion_tokens += outcome.completion_tokens;
        total_cached_tokens += outcome.cached_tokens;
        total_cache_creation_tokens += outcome.cache_creation_tokens;
        if outcome.prompt_tokens > 0 || outcome.completion_tokens > 0 {
            let elapsed_ms = request_start.elapsed().as_millis() as u64;
            emit_usage(
                &window,
                &request_id,
                json!({
                    "prompt_tokens": outcome.prompt_tokens,
                    "completion_tokens": outcome.completion_tokens,
                    "total_prompt_tokens": total_prompt_tokens,
                    "total_completion_tokens": total_completion_tokens,
                    "cached_tokens": outcome.cached_tokens,
                    "cache_creation_tokens": outcome.cache_creation_tokens,
                    "total_cached_tokens": total_cached_tokens,
                    "total_cache_creation_tokens": total_cache_creation_tokens,
                    "ttft_ms": outcome.ttft_ms.unwrap_or(elapsed_ms),
                    "response_time_ms": elapsed_ms,
                    "loop_count": turn,
                }),
            );
        }

        let last_content = outcome.content.clone();

        let runnable = !outcome.tool_calls.is_empty();

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
        let ran = run_chat_tools(
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

#[cfg(test)]
mod forced_search_tests {
    use super::forced_search_query;

    #[test]
    fn search_keeps_the_explicit_query_and_skips_attachment_only_turns() {
        assert_eq!(
            forced_search_query("force", true, false, "  compare release dates  "),
            Some("compare release dates")
        );
        for query in ["", " \n\t "] {
            assert_eq!(forced_search_query("force", true, false, query), None);
        }
        assert_eq!(forced_search_query("auto", true, false, "query"), None);
        assert_eq!(forced_search_query("force", false, false, "query"), None);
    }
}
