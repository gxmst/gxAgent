use crate::agent;
use crate::config::AppConfig;
use crate::provider;
use serde_json::{json, Value};

fn split_compaction_text(value: &str, max_chars: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let max_chars = max_chars.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut count = 0;
    for (index, _) in value.char_indices() {
        if count == max_chars {
            chunks.push(value[start..index].to_string());
            start = index;
            count = 0;
        }
        count += 1;
    }
    if start < value.len() {
        chunks.push(value[start..].to_string());
    }
    chunks
}

/// Group adjacent partial summaries for the next reduction pass while making
/// one invariant explicit: every pass with more than one item must produce
/// fewer groups than it received. A single trailing item may be carried into
/// the next pass unchanged, but every other group contains at least two
/// summaries. This prevents a 2 -> 2 reduction loop when model output happens
/// to be close to the input chunk budget.
fn group_compaction_summaries(summaries: Vec<String>, max_chars: usize) -> Vec<Vec<String>> {
    let max_chars = max_chars.max(1);
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0usize;

    for summary in summaries {
        let summary_chars = summary.chars().count();
        let separator_chars = if current.is_empty() { 0 } else { 2 };
        let would_exceed = current_chars
            .saturating_add(separator_chars)
            .saturating_add(summary_chars)
            > max_chars;

        // Never flush a singleton: pairing it with the next item is what gives
        // the reduction pass its strict convergence guarantee. Summaries are
        // individually bounded by the model's 1024-token output limit, so a
        // two-item overflow is still preferable to an unbounded retry loop.
        if would_exceed && current.len() >= 2 {
            groups.push(std::mem::take(&mut current));
            current_chars = 0;
        }

        if !current.is_empty() {
            current_chars = current_chars.saturating_add(2);
        }
        current_chars = current_chars.saturating_add(summary_chars);
        current.push(summary);
    }

    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

fn compaction_transcript(messages: Vec<Value>) -> String {
    messages
        .into_iter()
        .filter_map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let content = &message["content"];
            let mut content = content.as_str().map(ToOwned::to_owned).unwrap_or_else(|| {
                if content.is_null() {
                    String::new()
                } else {
                    content.to_string()
                }
            });
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    content.push_str(&format!(
                        "\n[Tool call {}: {}]\n{}",
                        call["id"].as_str().unwrap_or("unknown"),
                        call["function"]["name"].as_str().unwrap_or("unknown"),
                        call["function"]["arguments"].as_str().unwrap_or("{}")
                    ));
                }
            }
            if role == "tool" {
                content = format!(
                    "[Tool result {}: {}]\n{}",
                    message["tool_call_id"].as_str().unwrap_or("unknown"),
                    message["name"].as_str().unwrap_or("unknown"),
                    content
                );
            }
            if content.trim().is_empty() {
                None
            } else {
                Some(format!("[{}]\n{}", role, content))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn request_compaction_summary(
    client: &reqwest::Client,
    wire: provider::Wire,
    config: &AppConfig,
    source: &str,
    combine_partial_summaries: bool,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let instruction = if combine_partial_summaries {
        "Combine the partial summaries below into one concise but complete continuation summary. Remove duplication while preserving every concrete achievement, file path, pending task, code change, decision, user preference, and unresolved problem. Return only the structured summary."
    } else {
        "Compress the conversation segment below into a concise but complete continuation summary. Preserve concrete achievements, file paths, pending tasks, code changes, decisions, user preferences, and unresolved problems. Return only the structured summary."
    };
    let compact_messages = vec![
        json!({
            "role": "system",
            "content": "You are a conversation summarizer. Preserve the details needed to continue the work accurately."
        }),
        json!({
            "role": "user",
            "content": format!("{}\n\n{}", instruction, source)
        }),
    ];
    let url = provider::build_url(wire, &config.base_url, &config.model, false);
    let body = provider::build_body(wire, &config.model, &compact_messages, &[], config, false);
    let builder = provider::apply_auth(wire, client.post(&url), &config.api_key);

    tokio::select! {
        biased;
        _ = agent::wait_for_cancellation(cancel_rx) => {
            Err("History compaction cancelled.".to_string())
        }
        result = async {
            let response = builder
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("API request failed: {}", e))?;
            if !response.status().is_success() {
                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                return Err(format!("LLM API error ({}): {}", status, error_text));
            }
            let response_body: Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;
            let (summary, _reasoning, _calls, _pt, _ct) =
                provider::parse_full_response(wire, &response_body);
            if summary.trim().is_empty() {
                Err("Failed to generate summary.".to_string())
            } else {
                Ok(summary)
            }
        } => result,
    }
}

/// Generate a short sidebar title after the first assistant response. This is
/// deliberately isolated from the active agent request: title failures never
/// affect the conversation and the frontend keeps its local fallback.
#[tauri::command]
pub async fn generate_session_title(
    current_config: AppConfig,
    user_message: String,
    assistant_message: String,
) -> Result<String, String> {
    let mut config = current_config;
    config.temperature = 0.2;
    config.max_tokens = Some(48);
    config.streaming = false;
    config.thinking_level = "low".to_string();
    config.tools_enabled.clear();

    let user_excerpt: String = user_message.chars().take(1_200).collect();
    let assistant_excerpt: String = assistant_message.chars().take(1_600).collect();
    let messages = vec![
        json!({
            "role": "system",
            "content": "Create a concise conversation title in the user's language. For Chinese, Japanese, or Korean use 5-12 characters; otherwise use 3-7 words. Capture the concrete task, not generic wording. Return only the title with no quotes, label, punctuation suffix, or explanation."
        }),
        json!({
            "role": "user",
            "content": format!("User request:\n{}\n\nAssistant response:\n{}", user_excerpt, assistant_excerpt)
        }),
    ];
    let wire = provider::Wire::from_config(&config);
    let url = provider::build_url(wire, &config.base_url, &config.model, false);
    let body = provider::build_body(wire, &config.model, &messages, &[], &config, false);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = provider::apply_auth(wire, client.post(&url), &config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Title request failed: {}", error))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("Title API error ({}): {}", status, detail));
    }
    let response_body: Value = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse title response: {}", error))?;
    let (title, _reasoning, _calls, _prompt_tokens, _completion_tokens) =
        provider::parse_full_response(wire, &response_body);
    let title = title.trim();
    if title.is_empty() {
        Err("Model returned an empty title.".to_string())
    } else {
        Ok(title.to_string())
    }
}

/// Compress conversation history using the current model
#[tauri::command]
pub async fn compact_history(
    current_config: AppConfig,
    messages: Vec<Value>,
    request_id: String,
    context_token_limit: Option<usize>,
) -> Result<String, String> {
    let mut config = current_config;
    config.temperature = 0.3;
    config.max_tokens = Some(1024);
    let wire = provider::Wire::from_config(&config);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("HTTP client error: {}", error))?;
    let mut cancel_rx = agent::register_cancellation(&request_id).await;
    // Reserve room for the summary and use a one-character-per-token input
    // budget. This is intentionally conservative for CJK text. Very large
    // histories are summarized in chunks and then reduced recursively, so the
    // recovery path still works after a normal request has exceeded context.
    let token_limit = context_token_limit.unwrap_or(32_000).max(8_000);
    let chunk_chars = token_limit.saturating_sub(2_200).clamp(5_000, 60_000);
    let transcript = compaction_transcript(messages);
    let mut chunks = split_compaction_text(&transcript, chunk_chars);
    let result = async {
        if chunks.is_empty() {
            return Err("There is no conversation content to compact.".to_string());
        }

        let mut summaries = Vec::with_capacity(chunks.len());
        for (index, chunk) in chunks.drain(..).enumerate() {
            let labelled = format!("Conversation segment {}:\n{}", index + 1, chunk);
            summaries.push(
                request_compaction_summary(
                    &client,
                    wire,
                    &config,
                    &labelled,
                    false,
                    &mut cancel_rx,
                )
                .await?,
            );
        }

        while summaries.len() > 1 {
            let previous_len = summaries.len();
            let groups = group_compaction_summaries(summaries, chunk_chars);
            if groups.len() >= previous_len {
                return Err("History compaction failed to converge.".to_string());
            }

            let mut reduced = Vec::with_capacity(groups.len());
            for group in groups {
                if group.len() == 1 {
                    reduced.push(group.into_iter().next().unwrap_or_default());
                    continue;
                }
                let combined = group
                    .into_iter()
                    .enumerate()
                    .map(|(index, summary)| format!("[Partial summary {}]\n{}", index + 1, summary))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                reduced.push(
                    request_compaction_summary(
                        &client,
                        wire,
                        &config,
                        &combined,
                        true,
                        &mut cancel_rx,
                    )
                    .await?,
                );
            }
            summaries = reduced;
        }

        summaries
            .pop()
            .ok_or_else(|| "Failed to generate summary.".to_string())
    }
    .await;
    agent::unregister_cancellation(&request_id).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_transcript_preserves_tool_arguments_and_result_associations() {
        let transcript = compaction_transcript(vec![
            json!({"role":"assistant", "content":null, "tool_calls":[{"id":"call_a", "function":{"name":"read_file", "arguments":"{\"path\":\"first.txt\"}"}}]}),
            json!({"role":"tool", "tool_call_id":"call_a", "name":"read_file", "content":"first file contents"}),
        ]);
        assert!(transcript.contains("Tool call call_a: read_file"));
        assert!(transcript.contains("first.txt"));
        assert!(transcript.contains("Tool result call_a: read_file"));
        assert!(transcript.contains("first file contents"));
    }

    #[test]
    fn compaction_split_preserves_utf8_content() {
        let source = "ab中文🙂cd尾";
        let chunks = split_compaction_text(source, 3);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 3));
        assert_eq!(chunks.concat(), source);
    }

    #[test]
    fn compaction_reduction_groups_strictly_converge() {
        for count in 2..=64 {
            let summaries = (0..count)
                .map(|index| format!("summary-{index}-{}", "x".repeat(4_000)))
                .collect::<Vec<_>>();
            let expected = summaries.clone();
            let groups = group_compaction_summaries(summaries, 5_800);

            assert!(groups.len() < count, "count={count}");
            assert_eq!(groups.into_iter().flatten().collect::<Vec<_>>(), expected);
        }
    }
}
