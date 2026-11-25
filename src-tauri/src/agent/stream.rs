use super::state::{await_with_cancel, ensure_not_cancelled};
use crate::provider;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{Emitter, Window};
use tokio::sync::watch;

const MODEL_REQUEST_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccumulatedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Result of fully consuming one streaming model response.
pub(super) struct StreamOutcome {
    pub content: String,
    #[allow(dead_code)]
    pub reasoning: String,
    pub tool_calls: Vec<AccumulatedToolCall>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub cache_creation_tokens: u64,
    pub ttft_ms: Option<u64>,
    /// True if DSML markers were seen in the content (DeepSeek text-format tool
    /// calls). When set, the raw (un-emitted) DSML text is in `dsml_buffer` and
    /// the caller is responsible for parsing/stripping it.
    pub dsml_buffering: bool,
    pub dsml_buffer: String,
}

pub(super) fn emit_stream_chunk(window: &Window, request_id: &str, content: impl Into<String>) {
    let _ = window.emit(
        "agent-stream-chunk",
        json!({
            "requestId": request_id,
            "content": content.into(),
        }),
    );
}

pub(super) fn emit_reasoning_chunk(window: &Window, request_id: &str, content: impl Into<String>) {
    let _ = window.emit(
        "agent-reasoning-chunk",
        json!({
            "requestId": request_id,
            "content": content.into(),
        }),
    );
}

pub(super) fn emit_stream_done(window: &Window, request_id: &str, mut payload: Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit("agent-stream-done", payload);
}

pub(super) fn emit_agent_complete(window: &Window, request_id: &str, status: &str) {
    let _ = window.emit(
        "agent-complete",
        json!({
            "requestId": request_id,
            "status": status,
        }),
    );
}

pub(super) fn emit_usage(window: &Window, request_id: &str, mut payload: Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit("agent-usage", payload);
}

pub(super) fn emit_request_event(
    window: &Window,
    event: &str,
    request_id: &str,
    mut payload: Value,
) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("requestId".to_string(), json!(request_id));
    }
    let _ = window.emit(event, payload);
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(super) async fn send_model_request_with_retry(
    window: &Window,
    request_id: &str,
    cancel_rx: &watch::Receiver<bool>,
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    for attempt in 1..=MODEL_REQUEST_ATTEMPTS {
        ensure_not_cancelled(cancel_rx)?;
        let builder = request
            .try_clone()
            .ok_or_else(|| "Model request could not be cloned for retry".to_string())?;
        match await_with_cancel(cancel_rx, builder.send()).await? {
            Ok(response)
                if !retryable_status(response.status()) || attempt == MODEL_REQUEST_ATTEMPTS =>
            {
                return Ok(response);
            }
            Ok(response) => {
                let status = response.status();
                let delay_secs = 1u64 << (attempt - 1).min(3);
                emit_request_event(
                    window,
                    "agent-retry",
                    request_id,
                    json!({
                        "attempt": attempt + 1,
                        "maxAttempts": MODEL_REQUEST_ATTEMPTS,
                        "delaySeconds": delay_secs,
                        "reason": format!("HTTP {}", status),
                    }),
                );
                await_with_cancel(
                    cancel_rx,
                    tokio::time::sleep(Duration::from_secs(delay_secs)),
                )
                .await?;
            }
            Err(error) if attempt < MODEL_REQUEST_ATTEMPTS => {
                let delay_secs = 1u64 << (attempt - 1).min(3);
                emit_request_event(
                    window,
                    "agent-retry",
                    request_id,
                    json!({
                        "attempt": attempt + 1,
                        "maxAttempts": MODEL_REQUEST_ATTEMPTS,
                        "delaySeconds": delay_secs,
                        "reason": error.to_string(),
                    }),
                );
                await_with_cancel(
                    cancel_rx,
                    tokio::time::sleep(Duration::from_secs(delay_secs)),
                )
                .await?;
            }
            Err(error) => {
                return Err(format!(
                    "Request failed after {} attempts: {}",
                    MODEL_REQUEST_ATTEMPTS, error
                ))
            }
        }
    }
    Err("Model request retry loop ended unexpectedly".to_string())
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
pub(super) async fn consume_stream(
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
    let mut decoder = provider::StreamDecoder::default();

    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<AccumulatedToolCall> = Vec::new();
    let mut prompt_tokens: u64 = 0;
    let mut completion_tokens: u64 = 0;
    let mut cached_tokens: u64 = 0;
    let mut cache_creation_tokens: u64 = 0;
    let mut ttft_ms: Option<u64> = None;
    let mut first_content = false;
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

    let mut apply_delta = |delta: provider::StreamDelta| {
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
            let idx = tc.index;
            apply_tool_call_delta(&mut tool_calls, tc);
            if emit_drafting {
                let _ = window.emit(
                    "agent-tool-drafting",
                    json!({
                        "requestId": request_id,
                        "index": idx,
                        "id": tool_calls[idx].id,
                        "name": tool_calls[idx].name,
                        "arguments": tool_calls[idx].arguments,
                    }),
                );
            }
        }
        if let Some(pt) = delta.prompt_tokens {
            prompt_tokens = pt;
        }
        if let Some(ct) = delta.completion_tokens {
            completion_tokens = ct;
        }
        if let Some(cached) = delta.cached_tokens {
            cached_tokens = cached;
        }
        if let Some(created) = delta.cache_creation_tokens {
            cache_creation_tokens = created;
        }
    };

    while !decoder.done {
        let chunk = match await_with_cancel(cancel_rx, stream.next()).await? {
            Some(c) => c.map_err(|e| format!("Stream error: {}", e))?,
            None => break,
        };
        for delta in decoder.push(wire, &chunk)? {
            apply_delta(delta);
        }
    }
    for delta in decoder.finish(wire)? {
        apply_delta(delta);
    }

    Ok(StreamOutcome {
        content,
        reasoning,
        tool_calls,
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        cache_creation_tokens,
        ttft_ms,
        dsml_buffering,
        dsml_buffer,
    })
}

/// Build a canonical (OpenAI-shaped) assistant message carrying tool calls.
/// Used to record the model's turn in history regardless of the wire format the
/// response actually arrived in, so the next request can be re-encoded for any
/// provider.
pub(super) fn assistant_message_with_tool_calls(
    content: &str,
    calls: &[AccumulatedToolCall],
) -> Value {
    let tool_calls_json: Vec<Value> = calls
        .iter()
        .map(|tc| {
            json!({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": serde_json::from_str::<Value>(&tc.arguments).ok().filter(Value::is_object).unwrap_or_else(|| json!({})).to_string(),
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

/// Repair incomplete provider tool-call fragments before both execution and
/// history serialization. A malformed arguments string or duplicate/empty id
/// can otherwise make the follow-up model request invalid even when the local
/// tool executor was able to return an error observation.
pub(super) fn normalize_tool_calls(calls: &mut Vec<AccumulatedToolCall>) {
    let mut ids = std::collections::HashSet::new();
    calls.retain(|call| !call.name.trim().is_empty());

    for (index, call) in calls.iter_mut().enumerate() {
        call.name = call.name.trim().to_string();

        if call.id.trim().is_empty() || ids.contains(call.id.trim()) {
            let mut suffix = 0usize;
            loop {
                let candidate = if suffix == 0 {
                    format!("call_{}", index)
                } else {
                    format!("call_{}_{}", index, suffix)
                };
                if !ids.contains(&candidate) {
                    call.id = candidate;
                    break;
                }
                suffix += 1;
            }
        } else {
            call.id = call.id.trim().to_string();
        }
        ids.insert(call.id.clone());

        if call.arguments.trim().is_empty() {
            call.arguments = "{}".into();
        }
        if let Ok(Value::Object(args)) = serde_json::from_str::<Value>(&call.arguments) {
            call.arguments = Value::Object(args).to_string();
        }
    }
}

/// Fold a normalized tool-call delta into the accumulator. Streaming fragments
/// arrive by `index`; id/name appear once, `arguments` is appended.
fn apply_tool_call_delta(acc: &mut Vec<AccumulatedToolCall>, delta: provider::ToolCallDelta) {
    let idx = delta.index;
    while acc.len() <= idx {
        acc.push(AccumulatedToolCall {
            id: new_tool_call_id(),
            name: String::new(),
            arguments: String::new(),
        });
    }
    // Provider ids may arrive late or restart every turn. The local id stays
    // stable from the first draft through execution and canonical history.
    if let Some(name) = delta.name {
        if !name.is_empty() {
            acc[idx].name = name;
        }
    }
    if let Some(args) = delta.arguments {
        acc[idx].arguments.push_str(&args);
    }
}

pub(crate) fn new_tool_call_id() -> String {
    format!("call_{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn streamed_tool_ids_are_stable_and_unique_across_turns() {
        let delta =
            |id: Option<&str>, index, name: Option<&str>, args: &str| provider::ToolCallDelta {
                index,
                id: id.map(String::from),
                name: name.map(String::from),
                arguments: Some(args.into()),
            };
        let mut first = Vec::new();
        apply_tool_call_delta(&mut first, delta(None, 0, Some("read_file"), "{\"path\":"));
        let first_id = first[0].id.clone();
        apply_tool_call_delta(&mut first, delta(Some("call_0"), 0, None, "\"first.txt\"}"));
        apply_tool_call_delta(&mut first, delta(Some("call_0"), 1, Some("glob"), "{}"));
        normalize_tool_calls(&mut first);
        assert_eq!(first[0].id, first_id);
        assert_ne!(first[0].id, first[1].id);
        assert_eq!(first[0].arguments, r#"{"path":"first.txt"}"#);
        let mut second = Vec::new();
        apply_tool_call_delta(
            &mut second,
            delta(Some("call_0"), 0, Some("write_file"), "{}"),
        );
        assert_ne!(first[0].id, second[0].id);
    }
}
