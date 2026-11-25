use super::state::await_with_cancel;
use crate::config::AppConfig;
use crate::provider;
use crate::text::{utf8_prefix, utf8_suffix};
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::sync::watch;

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

pub(super) fn build_user_message(
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

pub(super) fn normalize_session_messages(messages: Vec<Value>, is_ollama: bool) -> Vec<Value> {
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

fn estimate_message_tokens(msg: &Value) -> u64 {
    let text_tokens = |text: &str| (text.len() as u64).div_ceil(4);
    let content_tokens = match &msg["content"] {
        Value::String(content) => text_tokens(content),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                if part["type"] == "image_url" {
                    1100
                } else {
                    text_tokens(part["text"].as_str().unwrap_or(""))
                }
            })
            .sum(),
        _ => 0,
    };
    let tool_tokens = msg
        .get("tool_calls")
        .map(|calls| text_tokens(&calls.to_string()))
        .unwrap_or(0);
    let image_tokens = msg["attachments"]
        .as_array()
        .map(|images| {
            images
                .iter()
                .filter(|image| {
                    image["type"] == "image"
                        && image["data"].as_str().is_some_and(|data| !data.is_empty())
                })
                .count() as u64
                * 1100
        })
        .unwrap_or(0);
    (content_tokens + tool_tokens + image_tokens).max(1) + 6
}

pub(super) fn limit_messages_by_tokens(messages: Vec<Value>, budget: u64) -> Vec<Value> {
    if messages.is_empty() || budget == 0 {
        return messages;
    }
    let mut start = messages.len();
    let mut used = 0u64;
    while start > 0 {
        let mut group_start = start - 1;
        while group_start > 0 && messages[group_start]["role"] == "tool" {
            group_start -= 1;
        }
        let cost: u64 = messages[group_start..start]
            .iter()
            .map(estimate_message_tokens)
            .sum();
        if start < messages.len() && used.saturating_add(cost) > budget {
            break;
        }
        used = used.saturating_add(cost);
        start = group_start;
    }
    messages.into_iter().skip(start).collect()
}

pub(super) fn compact_messages(messages: &mut [Value], context_limit: usize) {
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

    // context_limit is an estimated token budget. Only when the conversation
    // blows past it do we char-truncate oversized middle messages.
    let limit_tokens = (context_limit as u64).max(1);
    if total_tokens < limit_tokens {
        return;
    }

    for msg in messages
        .iter_mut()
        .take(total_len - protect_last)
        .skip(protect_first)
    {
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
pub(super) async fn maybe_auto_compact(
    window: &Window,
    request_id: &str,
    client: &reqwest::Client,
    config: &AppConfig,
    wire: provider::Wire,
    cancel_rx: &watch::Receiver<bool>,
    messages: &mut Vec<Value>,
) -> Result<bool, String> {
    let budget = (config.context_limit as u64).max(1);
    let total_tokens: u64 = messages.iter().map(estimate_message_tokens).sum();
    if total_tokens <= budget / 2 {
        return Ok(false);
    }

    // Keep the system prompt (index 0) and a recent tail intact; summarize the
    // middle. Choose the cut so it lands on a clean boundary: never between an
    // assistant tool_calls message and its tool results.
    let keep_tail = 6usize;
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

#[cfg(test)]
mod compact_tests {
    use super::*;

    fn tool_msg(len: usize) -> Value {
        json!({ "role": "tool", "tool_call_id": "t", "content": "x".repeat(len) })
    }

    #[test]
    fn normal_conversations_are_left_untouched() {
        // ~10 messages of 1000 chars each ≈ 2.5k estimated tokens — far below
        // this 20k token budget.
        let mut messages: Vec<Value> = (0..10).map(|_| tool_msg(1000)).collect();
        let original = messages.clone();
        compact_messages(&mut messages, 20_000);
        assert_eq!(messages, original);
    }

    #[test]
    fn oversized_middle_tool_outputs_are_truncated_and_edges_protected() {
        // 12 messages of 8000 chars ≈ 24k estimated tokens — above the budget.
        let mut messages: Vec<Value> = (0..12).map(|_| tool_msg(8000)).collect();
        compact_messages(&mut messages, 20_000);

        // First message and the last 4 stay intact.
        assert_eq!(messages[0]["content"].as_str().unwrap().len(), 8000);
        for msg in messages.iter().rev().take(4) {
            assert_eq!(msg["content"].as_str().unwrap().len(), 8000);
        }
        // Middle tool outputs are truncated.
        let middle = messages[3]["content"].as_str().unwrap();
        assert!(middle.len() < 8000);
        assert!(middle.contains("Tool output truncated"));
    }

    #[test]
    fn history_limit_keeps_the_newest_messages_by_token_budget() {
        let messages = vec![
            json!({ "role": "user", "content": "a".repeat(4000) }),
            json!({ "role": "assistant", "content": "b".repeat(4000) }),
            json!({ "role": "user", "content": "new" }),
        ];
        let limited = limit_messages_by_tokens(messages, 1_100);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited.last().unwrap()["content"], "new");
    }

    #[test]
    fn token_limits_never_separate_tool_results_from_their_calls() {
        let call = json!({"role":"assistant", "content":"", "tool_calls":[
            {"id":"a", "type":"function", "function":{"name":"read_file","arguments":"{}"}},
            {"id":"b", "type":"function", "function":{"name":"glob","arguments":"{}"}},
        ]});
        let group = vec![
            call,
            json!({"role":"tool","tool_call_id":"a","content":"a"}),
            json!({"role":"tool","tool_call_id":"b","content":"b"}),
        ];
        let mut messages = vec![json!({"role":"user","content":"old"})];
        messages.extend(group.clone());
        assert_eq!(limit_messages_by_tokens(messages.clone(), 1), group);
        messages.push(json!({"role":"assistant","content":"done"}));
        let limited = limit_messages_by_tokens(messages, 20);
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0]["content"], "done");
        let large_args =
            json!({"role":"assistant","tool_calls":[{"function":{"arguments":"x".repeat(8000)}}]});
        assert!(estimate_message_tokens(&large_args) > 2000);
    }
}
